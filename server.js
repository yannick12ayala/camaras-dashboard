// Dashboard Cámaras V — servidor self-hosted con login por perfiles.
// Node puro (sin dependencias). Sesiones por cookie firmada, contraseñas con hash (scrypt).
//
// Flujo de cuentas:
//  - El admin crea un usuario (queda "pendiente") y obtiene un CÓDIGO de activación.
//  - La persona entra por primera vez con usuario + código y define SU contraseña.
//  - Cada usuario puede cambiar su contraseña. El admin puede resetear/borrar perfiles.
//
// Variables de entorno:
//  - UPLOAD_SECRET : secreto para POST /api/upload (la tarea de Windows)
//  - ADMIN_USER    : nombre del admin (default "admin")
//  - ADMIN_PASS    : contraseña inicial del admin (se siembra la 1a vez)
//  - SESSION_SECRET: (opcional) clave para firmar cookies; si falta se genera y persiste

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT          = process.env.PORT || 8080;
const DATA_FILE     = process.env.DATA_FILE || '/data/camaras.xlsx';
const LINKS_FILE    = process.env.LINKS_FILE || '/data/hyperlinks.json';
const STATUS_FILE   = process.env.STATUS_FILE || '/data/statuses.json';
const STATUS_LOG    = process.env.STATUS_LOG  || '/data/status_log.jsonl';
const PHOTOS_DIR    = process.env.PHOTOS_DIR  || '/data/photos';
const MAX_PHOTO_MB  = parseInt(process.env.MAX_PHOTO_MB || '10', 10);

// SMTP para notificaciones (opcional; si SMTP_HOST no está, no envía)
const SMTP_HOST     = process.env.SMTP_HOST || '';
const SMTP_PORT     = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER     = process.env.SMTP_USER || '';
const SMTP_PASS     = process.env.SMTP_PASS || '';
const SMTP_FROM     = process.env.SMTP_FROM || SMTP_USER;
const NOTIFY_TO     = (process.env.NOTIFY_TO || '').split(',').map(s => s.trim()).filter(Boolean);
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://camaraseg.pilar.gov.ar';
const USERS_FILE    = process.env.USERS_FILE || '/data/users.json';
const SECRET_FILE   = '/data/.session_secret';
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';
const ADMIN_USER    = (process.env.ADMIN_USER || 'admin').trim().toLowerCase();
const ADMIN_PASS    = process.env.ADMIN_PASS || '';

// Normaliza nombres de usuario (sin distinguir mayúsculas ni espacios)
const norm = u => String(u || '').trim().toLowerCase();

const PUBLIC_DIR  = __dirname;
const XLSX_TYPE   = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const COOKIE      = 'camsess';
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 horas

// ─── Secreto de sesión (persistente) ────────────────────────
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try { return fs.readFileSync(SECRET_FILE, 'utf8'); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true }); fs.writeFileSync(SECRET_FILE, s); } catch {}
  return s;
}
const SESSION_SECRET = getSessionSecret();

// ─── Almacén de usuarios ─────────────────────────────────────
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return { users: {} }; }
}
function saveUsers() {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}
const DB = loadUsers();
if (!DB.users) DB.users = {};

function hashWith(secret, salt) { return crypto.scryptSync(String(secret), salt, 64).toString('hex'); }
function setSecretField(obj, prefix, value) {
  const salt = crypto.randomBytes(16).toString('hex');
  obj[prefix + 'Salt'] = salt;
  obj[prefix + 'Hash'] = hashWith(value, salt);
}
function checkSecretField(obj, prefix, value) {
  const h = obj[prefix + 'Hash'], s = obj[prefix + 'Salt'];
  if (!h || !s) return false;
  const a = Buffer.from(hashWith(value, s), 'hex'), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Sembrar admin la primera vez (o si aún no tiene contraseña)
(function ensureAdmin() {
  const existing = DB.users[ADMIN_USER];
  if (ADMIN_PASS && (!existing || !existing.passHash)) {
    const u = existing || {};
    u.isAdmin = true; u.pending = false;
    setSecretField(u, 'pass', ADMIN_PASS);
    DB.users[ADMIN_USER] = u;
    saveUsers();
  } else if (existing) {
    existing.isAdmin = true; // el admin siempre es admin
  }
})();

// ─── Sesiones (cookie firmada, sin estado en servidor) ───────
function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, e: Date.now() + SESSION_TTL })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function readSession(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!raw) return null;
  const val = raw.slice(COOKIE.length + 1);
  const dot = val.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = val.slice(0, dot), sig = val.slice(dot + 1);
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data; try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || data.e < Date.now()) return null;
  const u = DB.users[data.u];
  if (!u) return null;
  return { username: data.u, isAdmin: !!u.isAdmin };
}
function setSessionCookie(res, user) {
  res.setHeader('Set-Cookie', `${COOKIE}=${makeSession(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// ─── Utilidades HTTP ─────────────────────────────────────────
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function redirect(res, loc) { res.writeHead(302, { Location: loc }); res.end(); }
function serveFile(res, file, type) {
  const fp = path.join(PUBLIC_DIR, file);
  if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': type });
  res.end(fs.readFileSync(fp));
}
function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) { try { return JSON.parse((await readBody(req)).toString('utf8')); } catch { return {}; } }

// ── Extraer hyperlinks de la columna "PDF URL" del xlsx ──
// Devuelve {[id]: url}. Silenciosa: si algo falla, devuelve {}.
function extractHyperlinks(xlsxBuf) {
  try {
    // 1. Enumerar entradas del ZIP central
    let eocd = -1;
    for (let i = xlsxBuf.length - 22; i >= Math.max(0, xlsxBuf.length - 65558); i--) {
      if (xlsxBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return {};
    const cdOff = xlsxBuf.readUInt32LE(eocd + 16);
    const nEnt  = xlsxBuf.readUInt16LE(eocd + 10);
    const entries = {};
    let off = cdOff;
    for (let i = 0; i < nEnt; i++) {
      if (xlsxBuf.readUInt32LE(off) !== 0x02014b50) break;
      const method = xlsxBuf.readUInt16LE(off + 10);
      const compSz = xlsxBuf.readUInt32LE(off + 20);
      const nameLen = xlsxBuf.readUInt16LE(off + 28);
      const extraLen = xlsxBuf.readUInt16LE(off + 30);
      const commentLen = xlsxBuf.readUInt16LE(off + 32);
      const localOff = xlsxBuf.readUInt32LE(off + 42);
      const name = xlsxBuf.slice(off + 46, off + 46 + nameLen).toString('utf8');
      const lfhNameLen = xlsxBuf.readUInt16LE(localOff + 26);
      const lfhExtra = xlsxBuf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lfhNameLen + lfhExtra;
      const raw = xlsxBuf.slice(dataStart, dataStart + compSz);
      entries[name] = () => method === 0 ? raw : zlib.inflateRawSync(raw);
      off += 46 + nameLen + extraLen + commentLen;
    }
    if (!entries['xl/worksheets/sheet1.xml'] || !entries['xl/worksheets/_rels/sheet1.xml.rels']) return {};

    const sheetXml = entries['xl/worksheets/sheet1.xml']().toString('utf8');
    const relsXml  = entries['xl/worksheets/_rels/sheet1.xml.rels']().toString('utf8');
    const sharedXml = entries['xl/sharedStrings.xml'] ? entries['xl/sharedStrings.xml']().toString('utf8') : '';

    // 2. rId -> URL
    const rels = {};
    for (const m of relsXml.matchAll(/<Relationship\s+[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*TargetMode="External"[^>]*>/g)) {
      rels[m[1]] = m[2].replace(/&amp;/g,'&');
    }
    // 3. Shared strings (para leer IDs que sean string en col A)
    const sst = [];
    for (const m of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const txt = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('');
      sst.push(txt.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'));
    }
    // Helper: dado el XML de una celda, devuelve { ref, val } con val resuelto vía sst si es tipo 's'.
    function readCell(xml) {
      const ref = (xml.match(/\br="([^"]+)"/) || [])[1];
      const t   = (xml.match(/\bt="([^"]+)"/) || [])[1];
      const vm  = xml.match(/<v>([\s\S]*?)<\/v>/);
      if (!ref || !vm) return null;
      const raw = vm[1];
      const val = t === 's' ? (sst[parseInt(raw)] || '') : raw;
      return { ref, val };
    }
    // 4. Descubrir letra de la columna "PDF URL" leyendo la fila 1
    const firstRow = sheetXml.match(/<row[^>]*r="1"[^>]*>([\s\S]*?)<\/row>/);
    let pdfCol = null;
    if (firstRow) {
      for (const cm of firstRow[1].matchAll(/<c\s[^>]*>[\s\S]*?<\/c>/g)) {
        const c = readCell(cm[0]);
        if (!c) continue;
        if (/pdf/i.test(c.val)) { pdfCol = c.ref.match(/^[A-Z]+/)[0]; break; }
      }
    }
    if (!pdfCol) return {};
    // 5. Recorrer <hyperlink ref="..." r:id="..."/> y quedarme con los de la columna PDF
    const hyperlinks = {};
    for (const hm of sheetXml.matchAll(/<hyperlink\s+[^>]*ref="([A-Z]+\d+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g)) {
      const ref = hm[1], rid = hm[2];
      const colLetter = ref.match(/^[A-Z]+/)[0];
      if (colLetter !== pdfCol) continue;
      const rowNum = parseInt(ref.match(/\d+$/)[0]);
      const url = rels[rid]; if (!url) continue;
      // Buscar el ID (columna A) de esa fila
      const rowMatch = sheetXml.match(new RegExp('<row[^>]*r="' + rowNum + '"[^>]*>([\\s\\S]*?)</row>'));
      if (!rowMatch) continue;
      const aXml = rowMatch[1].match(/<c\s[^>]*r="A\d+"[^>]*>[\s\S]*?<\/c>/);
      if (!aXml) continue;
      const a = readCell(aXml[0]);
      if (!a) continue;
      const idKey = String(a.val).replace('.0','').trim();
      if (idKey) hyperlinks[idKey] = url;
    }
    return hyperlinks;
  } catch (e) {
    console.log('[extractHyperlinks] error:', e.message);
    return {};
  }
}

// Para /api/upload: acepta bytes crudos o JSON {b64|$content|content}
function normalizeUpload(body) {
  if (body.length && body[0] === 0x7b) {
    try { const o = JSON.parse(body.toString('utf8')); const s = o.b64 || o.$content || o.content; if (typeof s === 'string') return Buffer.from(s, 'base64'); } catch {}
  }
  return body;
}

// ── Estados de puntos (persistentes, con auditoría) ──
// Estructura /data/statuses.json:
//   { "<id>": { "<field>": { value, by, at } } }
// field es hoy solo "estadoConect" (con|sin), pero está pensado para agregar más.
function loadStatuses() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { return {}; }
}
function saveStatuses(obj) {
  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, STATUS_FILE);
}
function appendLog(entry) {
  try {
    fs.mkdirSync(path.dirname(STATUS_LOG), { recursive: true });
    fs.appendFileSync(STATUS_LOG, JSON.stringify(entry) + '\n');
  } catch (e) { console.log('[log] error:', e.message); }
}

// ── Notificación por email (lazy: solo si SMTP está configurado) ──
let _mailer = null;
function getMailer() {
  if (_mailer) return _mailer;
  if (!SMTP_HOST) return null;
  try {
    const nodemailer = require('nodemailer');
    _mailer = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    return _mailer;
  } catch (e) {
    console.log('[mail] nodemailer no disponible:', e.message);
    return null;
  }
}
const MOTIVO_LABEL = {
  onu_alarmada:       'ONU alarmada',
  fibra_cortada:      'Fibra cortada',
  sin_energia:        'Sin energía',
  vandalizado:        'Vandalizado',
  falla_enrutamiento: 'Falla de enrutamiento',
};
async function notifyEstadoChange({ id, prev, next, by, cam, motivo }) {
  const label = { con: 'Con servicio', sin: 'Sin servicio' };
  const prevL = label[prev] || 'sin dato';
  let nextL = label[next] || 'sin dato';
  if (next === 'sin' && motivo && MOTIVO_LABEL[motivo]) {
    nextL += ' · ' + MOTIVO_LABEL[motivo];
  }
  const line = `[notify] ID ${id}: ${prevL} → ${nextL}  (por ${by})`;
  console.log(line);
  const mailer = getMailer();
  if (!mailer || NOTIFY_TO.length === 0) return;
  const subject = `Cámaras · ID ${id}: ${prevL} → ${nextL}`;
  const dir = (cam && cam.dir) ? ` — ${cam.dir}` : '';
  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px">
      <h2 style="margin:0 0 6px">Cambio de estado de conectividad</h2>
      <p style="color:#555;margin:0 0 18px">Portal ISP · Proyecto Cámaras V</p>
      <table style="border-collapse:collapse;font-size:14px">
        <tr><td style="color:#666;padding:4px 12px 4px 0">Punto</td><td><b>ID ${id}</b>${dir}</td></tr>
        <tr><td style="color:#666;padding:4px 12px 4px 0">Estado anterior</td><td>${prevL}</td></tr>
        <tr><td style="color:#666;padding:4px 12px 4px 0">Estado nuevo</td><td><b>${nextL}</b></td></tr>
        <tr><td style="color:#666;padding:4px 12px 4px 0">Cambiado por</td><td>${by}</td></tr>
        <tr><td style="color:#666;padding:4px 12px 4px 0">Cuando</td><td>${new Date().toLocaleString('es-AR')}</td></tr>
      </table>
      <p style="margin-top:22px"><a href="${DASHBOARD_URL}/isp" style="background:#4d8ef0;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:13px">Abrir Portal ISP</a></p>
      <p style="color:#999;font-size:11px;margin-top:24px">Aviso automático — no responder a este correo.</p>
    </div>`;
  try {
    await mailer.sendMail({ from: SMTP_FROM, to: NOTIFY_TO.join(','), subject, html });
    console.log('[mail] enviado a', NOTIFY_TO.length, 'destinatarios');
  } catch (e) {
    console.log('[mail] error al enviar:', e.message);
  }
}

// Notificación cuando el gabinete pasa a "sin energía" (por marcado directo
// o por regla automática: conectividad instalada sin energía).
async function notifyGabinete({ id, field, prev, next, by, cam, autoGab }) {
  const isAuto = !!autoGab;
  const autoNext = isAuto ? autoGab.next : next;
  const reason = isAuto ? (autoGab.reason || '') : '';
  let title;
  if (isAuto) {
    if (autoNext === 'si')            title = 'Gabinete REPARADO — energía restaurada';
    else if (reason === 'vandalizado') title = 'Gabinete VANDALIZADO — sin energía';
    else                              title = 'Gabinete SIN ENERGÍA';
  } else {
    title = autoNext === 'no' ? 'Gabinete SIN ENERGÍA (manual)' : 'Gabinete con energía (manual)';
  }
  const line = `[notify-gab] ID ${id}: ${title} (por ${by}${isAuto ? ' + auto' : ''})`;
  console.log(line);
  const mailer = getMailer();
  if (!mailer || NOTIFY_TO.length === 0) return;
  const dir = (cam && cam.dir) ? ` — ${cam.dir}` : '';
  const subject = `Cámaras · ID ${id}: ${title}`;
  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px">
      <h2 style="margin:0 0 6px">${title}</h2>
      <p style="color:#555;margin:0 0 18px">Portal ISP · Proyecto Cámaras V</p>
      <table style="border-collapse:collapse;font-size:14px">
        <tr><td style="color:#666;padding:4px 12px 4px 0">Punto</td><td><b>ID ${id}</b>${dir}</td></tr>
        ${isAuto ? `<tr><td style="color:#666;padding:4px 12px 4px 0">Motivo</td><td>Automático por <b>${reason}</b></td></tr>` : ''}
        <tr><td style="color:#666;padding:4px 12px 4px 0">Estado anterior</td><td>${autoGab ? (autoGab.prev || '—') : (prev || '—')}</td></tr>
        <tr><td style="color:#666;padding:4px 12px 4px 0">Estado nuevo</td><td><b>${autoNext}</b></td></tr>
        <tr><td style="color:#666;padding:4px 12px 4px 0">Cambiado por</td><td>${by}</td></tr>
        <tr><td style="color:#666;padding:4px 12px 4px 0">Cuando</td><td>${new Date().toLocaleString('es-AR')}</td></tr>
      </table>
      <p style="margin-top:22px"><a href="${DASHBOARD_URL}/isp" style="background:#4d8ef0;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:13px">Abrir Portal ISP</a></p>
      <p style="color:#999;font-size:11px;margin-top:24px">Aviso automático — no responder a este correo.</p>
    </div>`;
  try {
    await mailer.sendMail({ from: SMTP_FROM, to: NOTIFY_TO.join(','), subject, html });
    console.log('[mail-gab] enviado a', NOTIFY_TO.length, 'destinatarios');
  } catch (e) {
    console.log('[mail-gab] error al enviar:', e.message);
  }
}

// Notificación con foto adjunta subida por el técnico.
async function notifyFotoUpload({ id, by, cam, filename, filePath, size, caption }) {
  console.log('[notify-foto] ID', id, 'archivo', filename, '(', size, 'bytes) por', by);
  const mailer = getMailer();
  if (!mailer || NOTIFY_TO.length === 0) return;
  const dir = (cam && cam.dir) ? ` — ${cam.dir}` : '';
  const subject = `Cámaras · ID ${id}: nueva foto del técnico`;
  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px">
      <h2 style="margin:0 0 6px">Nueva foto subida</h2>
      <p style="color:#555;margin:0 0 18px">Portal ISP · Proyecto Cámaras V</p>
      <table style="border-collapse:collapse;font-size:14px">
        <tr><td style="color:#666;padding:4px 12px 4px 0">Punto</td><td><b>ID ${id}</b>${dir}</td></tr>
        <tr><td style="color:#666;padding:4px 12px 4px 0">Subida por</td><td>${by}</td></tr>
        <tr><td style="color:#666;padding:4px 12px 4px 0">Cuando</td><td>${new Date().toLocaleString('es-AR')}</td></tr>
        ${caption ? `<tr><td style="color:#666;padding:4px 12px 4px 0">Nota</td><td>${caption.replace(/</g,'&lt;')}</td></tr>` : ''}
      </table>
      <p style="margin-top:22px"><a href="${DASHBOARD_URL}/isp" style="background:#4d8ef0;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:13px">Abrir Portal ISP</a></p>
      <p style="color:#999;font-size:11px;margin-top:24px">La foto se adjunta en este correo como evidencia.</p>
    </div>`;
  try {
    await mailer.sendMail({
      from: SMTP_FROM, to: NOTIFY_TO.join(','), subject, html,
      attachments: [{ filename, path: filePath }],
    });
    console.log('[mail-foto] enviado a', NOTIFY_TO.length, 'destinatarios');
  } catch (e) {
    console.log('[mail-foto] error al enviar:', e.message);
  }
}

const STATIC_PUBLIC = {
  '/login':         { file: 'login.html',    type: 'text/html; charset=utf-8' },
  '/manifest.json': { file: 'manifest.json', type: 'application/json; charset=utf-8' },
  '/icon.png':      { file: 'icon.png',      type: 'image/png' },
};

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const m = req.method;

  // ── Subida de datos (secreto, sin sesión) ──
  if (m === 'POST' && url === '/api/upload') {
    if (!UPLOAD_SECRET || req.headers['x-upload-secret'] !== UPLOAD_SECRET) return json(res, 401, { error: 'Unauthorized' });
    try {
      const body = normalizeUpload(await readBody(req));
      if (!body.length) return json(res, 400, { error: 'El cuerpo esta vacio' });
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp'; fs.writeFileSync(tmp, body); fs.renameSync(tmp, DATA_FILE);
      // Extraer hyperlinks (para el botón "Ver ficha PDF"); fallo silencioso.
      try {
        const links = extractHyperlinks(body);
        fs.writeFileSync(LINKS_FILE + '.tmp', JSON.stringify(links));
        fs.renameSync(LINKS_FILE + '.tmp', LINKS_FILE);
      } catch (_) {}
      return json(res, 200, { ok: true, size: body.length });
    } catch (e) { return json(res, 500, { error: String(e) }); }
  }

  // ── Recursos y login (públicos) ──
  if (m === 'GET' && STATIC_PUBLIC[url]) { const s = STATIC_PUBLIC[url]; return serveFile(res, s.file, s.type); }

  if (m === 'POST' && url === '/api/login') {
    const body = await readJson(req);
    const user = norm(body.user);
    const u = DB.users[user];
    if (!u) return json(res, 401, { error: 'Usuario o contraseña incorrectos' });
    if (u.pending) return json(res, 200, { pending: true });
    if (!checkSecretField(u, 'pass', body.pass || '')) return json(res, 401, { error: 'Usuario o contraseña incorrectos' });
    setSessionCookie(res, user);
    return json(res, 200, { ok: true, isAdmin: !!u.isAdmin });
  }

  if (m === 'POST' && url === '/api/activate') {
    const body = await readJson(req);
    const user = norm(body.user), code = body.code, newPass = body.newPass;
    const u = DB.users[user];
    if (!u || !u.pending) return json(res, 400, { error: 'Esta cuenta no está pendiente de activación' });
    if (!checkSecretField(u, 'code', (code || '').trim())) return json(res, 401, { error: 'Código de activación incorrecto' });
    if (!newPass || String(newPass).length < 6) return json(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres' });
    setSecretField(u, 'pass', newPass);
    u.pending = false; delete u.codeHash; delete u.codeSalt;
    saveUsers();
    setSessionCookie(res, user);
    return json(res, 200, { ok: true });
  }

  if (m === 'POST' && url === '/api/logout') { clearSessionCookie(res); return json(res, 200, { ok: true }); }

  // ── A partir de acá se requiere sesión ──
  const sess = readSession(req);

  if (m === 'POST' && url === '/api/change-password') {
    if (!sess) return json(res, 401, { error: 'No autenticado' });
    const { currentPass, newPass } = await readJson(req);
    const u = DB.users[sess.username];
    if (!u || !checkSecretField(u, 'pass', currentPass || '')) return json(res, 401, { error: 'Contraseña actual incorrecta' });
    if (!newPass || String(newPass).length < 6) return json(res, 400, { error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    setSecretField(u, 'pass', newPass); saveUsers();
    return json(res, 200, { ok: true });
  }

  if (url.startsWith('/api/admin/')) {
    if (!sess || !sess.isAdmin) return json(res, 403, { error: 'Solo el administrador' });
    if (m === 'GET' && url === '/api/admin/users') {
      const users = Object.keys(DB.users).sort().map(name => ({ user: name, isAdmin: !!DB.users[name].isAdmin, pending: !!DB.users[name].pending }));
      return json(res, 200, { users });
    }
    if (m === 'POST' && url === '/api/admin/create') {
      const name = norm((await readJson(req)).user);
      if (!/^[a-z0-9._-]{2,32}$/.test(name)) return json(res, 400, { error: 'Nombre inválido (2-32, letras/números/. _ -)' });
      if (DB.users[name]) return json(res, 409, { error: 'Ese usuario ya existe' });
      const code = crypto.randomBytes(4).toString('hex');
      const u = { isAdmin: false, pending: true }; setSecretField(u, 'code', code);
      DB.users[name] = u; saveUsers();
      return json(res, 200, { ok: true, user: name, code });
    }
    if (m === 'POST' && url === '/api/admin/reset') {
      const name = norm((await readJson(req)).user);
      const u = DB.users[name];
      if (!u) return json(res, 404, { error: 'No existe' });
      const code = crypto.randomBytes(4).toString('hex');
      u.pending = true; delete u.passHash; delete u.passSalt; setSecretField(u, 'code', code);
      saveUsers();
      return json(res, 200, { ok: true, user: name, code });
    }
    if (m === 'POST' && url === '/api/admin/delete') {
      const name = norm((await readJson(req)).user);
      if (name === ADMIN_USER) return json(res, 400, { error: 'No se puede borrar el admin' });
      if (!DB.users[name]) return json(res, 404, { error: 'No existe' });
      delete DB.users[name]; saveUsers();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'No encontrado' });
  }

  // Sin sesión: navegación → login; API → 401
  if (!sess) {
    if (url.startsWith('/api/')) return json(res, 401, { error: 'No autenticado' });
    return redirect(res, '/login');
  }

  if (m === 'GET' && url === '/api/me') return json(res, 200, { user: sess.username, isAdmin: sess.isAdmin });
  if (m === 'GET' && url === '/cuenta') return serveFile(res, 'cuenta.html', 'text/html; charset=utf-8');
  if (m === 'GET' && url === '/admin') { if (!sess.isAdmin) return redirect(res, '/'); return serveFile(res, 'admin.html', 'text/html; charset=utf-8'); }
  if (m === 'GET' && (url === '/isp' || url === '/isp.html')) return serveFile(res, 'isp.html', 'text/html; charset=utf-8');

  // Estados persistentes (compartidos): quién marcó, cuándo
  if (m === 'GET' && url === '/api/status') {
    return json(res, 200, loadStatuses());
  }
  if (m === 'POST' && url === '/api/status') {
    const body = await readJson(req);
    const id = String(body.id || '').trim();
    const field = String(body.field || '').trim();
    const value = body.value == null ? '' : String(body.value).trim();
    if (!id || !field) return json(res, 400, { error: 'faltan id o field' });
    // Campos permitidos: cerrados (lista de valores) o libres (texto acotado)
    const closed = {
      estadoConect: ['con', 'sin'],
      // Motivo cuando estadoConect = 'sin'. '' = limpiar (cuando vuelve a 'con').
      motivoSinServicio: ['onu_alarmada', 'fibra_cortada', 'sin_energia', 'vandalizado', 'falla_enrutamiento', ''],
      // Conectividad instalada (antes era localStorage; ahora compartido en server)
      conect: ['si', 'no', ''],
      // Motivo asociado a la Conectividad ISP. Algunos valores solo aparecen
      // por regla auto (onu_alarmada, fibra_cortada — vienen de "Instalación
      // de cámara"): no se ofrecen como opción del técnico en Conectividad ISP.
      motivoConect: ['en_servicio', 'sin_energia', 'vandalizado', 'onu_alarmada', 'fibra_cortada', 'falla_enrutamiento', ''],
      // Gabinete energizado (independiente del gabinete instalado)
      gabineteEnergizado: ['si', 'no', ''],
      // Estado del gabinete físico (compartido/persistente). 'vandalizado' se
      // usa cuando el motivo de "Sin servicio" es vandalismo.
      gabineteEstado: ['si', 'no', 'vandalizado', ''],
      // QA: validación independiente del ISP. Mismas opciones que "Instalación
      // de cámara"; dispara los mismos efectos automáticos sobre gabinete/energizado/motivoConect.
      qaEstado: ['con', 'sin'],
      qaMotivo: ['en_servicio', 'onu_alarmada', 'vandalizado', 'fibra_cortada', 'falla_enrutamiento', ''],
    };
    const freeText = { numServicio: 60, cantidadMB: 20, idDispositivo: 60 }; // { campo: maxLen }
    if (closed[field]) {
      if (!closed[field].includes(value)) return json(res, 400, { error: 'valor no permitido para ' + field });
    } else if (field in freeText) {
      if (typeof value !== 'string') return json(res, 400, { error: 'value debe ser string' });
      if (value.length > freeText[field]) return json(res, 400, { error: 'value demasiado largo' });
    } else {
      return json(res, 400, { error: 'field no permitido' });
    }
    const all = loadStatuses();
    const prev = (all[id] && all[id][field] && all[id][field].value) || null;
    all[id] = all[id] || {};
    all[id][field] = { value, by: sess.username, at: new Date().toISOString() };
    // Reglas automáticas del gabinete energizado:
    //
    //  A) Si al INSTALAR la conectividad (motivoConect) elige 'sin_energia'  → gabinete = 'no'.
    //  B) Si al reportar "Sin servicio" (motivoSinServicio) elige 'sin_energia' o
    //     'vandalizado'  → gabinete = 'no'.
    //  C) Si el ESTADO INSTALACIÓN ISP vuelve a 'con' (reparado), y el gabinete
    //     había quedado en 'no' PONIENDO POR AUTOMÁTICO (by empieza con 'auto'),
    //     el gabinete vuelve a 'si'.
    let autoGab = null;         // sobre gabineteEnergizado
    let autoEstado = null;      // sobre gabineteEstado
    let autoMotivoConect = null; // sobre motivoConect (Conectividad ISP)
    const setAutoGab = (nextVal, reason) => {
      const prevGab = (all[id].gabineteEnergizado && all[id].gabineteEnergizado.value) || null;
      if (prevGab !== nextVal) {
        all[id].gabineteEnergizado = { value: nextVal, by: 'auto (' + reason + ')', at: new Date().toISOString() };
        autoGab = { prev: prevGab, next: nextVal, reason };
      }
    };
    const setAutoEstado = (nextVal, reason) => {
      const prev = (all[id].gabineteEstado && all[id].gabineteEstado.value) || null;
      if (prev !== nextVal) {
        all[id].gabineteEstado = { value: nextVal, by: 'auto (' + reason + ')', at: new Date().toISOString() };
        autoEstado = { prev, next: nextVal, reason };
      }
    };
    const setAutoMotivoConect = (nextVal, reason) => {
      const prev = (all[id].motivoConect && all[id].motivoConect.value) || null;
      if (prev !== nextVal) {
        all[id].motivoConect = { value: nextVal, by: 'auto (' + reason + ')', at: new Date().toISOString() };
        autoMotivoConect = { prev, next: nextVal, reason };
      }
    };
    // A) Al INSTALAR conectividad con motivo sin_energia → apaga energizado (ámbar)
    if (field === 'motivoConect' && value === 'sin_energia') setAutoGab('no', 'sin energía');
    // A') Al INSTALAR conectividad con motivo vandalizado → gabinete = vandalizado + energizado = SIN SERVICIO
    if (field === 'motivoConect' && value === 'vandalizado') {
      setAutoEstado('vandalizado', 'vandalizado');
      setAutoGab('no', 'vandalizado');
    }
    // B) Estado ISP sin servicio con motivo sin_energia → apaga energizado (ámbar)
    if (field === 'motivoSinServicio' && value === 'sin_energia') setAutoGab('no', 'sin energía');
    // B') Estado ISP sin servicio con motivo VANDALIZADO → gabinete estado='vandalizado' + energizado='no' con reason 'vandalizado'
    if (field === 'motivoSinServicio' && value === 'vandalizado') {
      setAutoEstado('vandalizado', 'vandalizado');
      setAutoGab('no', 'vandalizado');
    }
    // B'') "Instalación de cámara" con motivo ONU alarmada / Fibra cortada / Falla de enrutamiento:
    // se refleja en la Conectividad ISP (motivoConect) sin cambiar gabinete/energizado.
    if (field === 'motivoSinServicio' && (value === 'onu_alarmada' || value === 'fibra_cortada' || value === 'falla_enrutamiento')) {
      setAutoMotivoConect(value, MOTIVO_LABEL[value] || value);
    }
    // D) QA: mismas reglas de cascada que motivoSinServicio (aplican en paralelo)
    if (field === 'qaMotivo' && value === 'vandalizado') {
      setAutoEstado('vandalizado', 'QA vandalizado');
      setAutoGab('no', 'QA vandalizado');
    }
    if (field === 'qaMotivo' && (value === 'onu_alarmada' || value === 'fibra_cortada' || value === 'falla_enrutamiento')) {
      setAutoMotivoConect(value, 'QA ' + (MOTIVO_LABEL[value] || value));
    }
    // C) Reparado: estadoConect vuelve a 'con'
    if (field === 'estadoConect' && value === 'con' && prev === 'sin') {
      const gab = all[id].gabineteEnergizado;
      if (gab && gab.value === 'no' && typeof gab.by === 'string' && gab.by.startsWith('auto')) {
        setAutoGab('si', 'reparado');
      }
      const est = all[id].gabineteEstado;
      if (est && est.value === 'vandalizado' && typeof est.by === 'string' && est.by.startsWith('auto')) {
        setAutoEstado('si', 'reparado');
      }
      const mc = all[id].motivoConect;
      if (mc && (mc.value === 'onu_alarmada' || mc.value === 'fibra_cortada' || mc.value === 'falla_enrutamiento') &&
          typeof mc.by === 'string' && mc.by.startsWith('auto')) {
        setAutoMotivoConect('en_servicio', 'reparado');
      }
    }
    // C') Reparado por QA: qaEstado vuelve a 'con' → mismas restauraciones que C
    if (field === 'qaEstado' && value === 'con' && prev === 'sin') {
      const gab = all[id].gabineteEnergizado;
      if (gab && gab.value === 'no' && typeof gab.by === 'string' && gab.by.startsWith('auto')) {
        setAutoGab('si', 'QA reparado');
      }
      const est = all[id].gabineteEstado;
      if (est && est.value === 'vandalizado' && typeof est.by === 'string' && est.by.startsWith('auto')) {
        setAutoEstado('si', 'QA reparado');
      }
      const mc = all[id].motivoConect;
      if (mc && (mc.value === 'onu_alarmada' || mc.value === 'fibra_cortada' || mc.value === 'falla_enrutamiento') &&
          typeof mc.by === 'string' && mc.by.startsWith('auto')) {
        setAutoMotivoConect('en_servicio', 'QA reparado');
      }
    }
    saveStatuses(all);
    appendLog({ ts: new Date().toISOString(), by: sess.username, id, field, prev, next: value });
    if (autoGab) {
      appendLog({ ts: new Date().toISOString(), by: 'sistema (auto)', id, field: 'gabineteEnergizado', prev: autoGab.prev, next: autoGab.next });
    }
    if (autoEstado) {
      appendLog({ ts: new Date().toISOString(), by: 'sistema (auto)', id, field: 'gabineteEstado', prev: autoEstado.prev, next: autoEstado.next });
    }
    if (autoMotivoConect) {
      appendLog({ ts: new Date().toISOString(), by: 'sistema (auto)', id, field: 'motivoConect', prev: autoMotivoConect.prev, next: autoMotivoConect.next });
    }
    // Disparar notificación por email para estadoConect (async, no bloquea la respuesta)
    if (field === 'estadoConect' && prev !== value) {
      const motivo = all[id].motivoSinServicio && all[id].motivoSinServicio.value;
      notifyEstadoChange({ id, prev, next: value, by: sess.username, cam: body.cam || null, motivo })
        .catch(e => console.log('[notify] error:', e.message));
    }
    // Notificar por email cualquier cambio del gabinete energizado
    // (manual o automático por sin_energia/vandalizado/reparado).
    if ((field === 'gabineteEnergizado' && prev !== value) || autoGab) {
      notifyGabinete({ id, field, prev, next: value, by: sess.username, cam: body.cam || null, autoGab })
        .catch(e => console.log('[notify gab] error:', e.message));
    }
    return json(res, 200, { ok: true, prev, next: value, autoGab, autoEstado, autoMotivoConect });
  }
  // Historial (últimas N entradas del log)
  if (m === 'GET' && url === '/api/status/log') {
    try {
      if (!fs.existsSync(STATUS_LOG)) return json(res, 200, []);
      // Filtro opcional por id y por field (query string)
      const q = new URLSearchParams((req.url.split('?')[1]) || '');
      const filterId    = q.get('id');
      const filterField = q.get('field');
      const raw = fs.readFileSync(STATUS_LOG, 'utf8').split('\n').filter(Boolean);
      let entries = raw.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (filterId)    entries = entries.filter(e => String(e.id) === filterId);
      if (filterField) entries = entries.filter(e => e.field === filterField);
      // Últimos 500 (más antiguos primero → los invertimos para mostrar los más nuevos arriba)
      return json(res, 200, entries.slice(-500).reverse());
    } catch (e) { return json(res, 500, { error: String(e) }); }
  }

  // Fotos por punto: subida, listado y descarga individual
  if (m === 'POST' && url === '/api/photo') {
    try {
      let Busboy;
      try { Busboy = require('busboy'); } catch (e) { return json(res, 500, { error: 'busboy no disponible en el servidor', detail: e.message }); }
      const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_PHOTO_MB * 1024 * 1024, files: 1 } });
      const parts = {};
      const fileP = new Promise((resolve, reject) => {
        bb.on('field', (name, val) => { parts[name] = val; });
        bb.on('file', (name, file, info) => {
          const originalName = info.filename || 'foto';
          const cleanName = originalName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const chunks = []; let size = 0; let truncated = false;
          file.on('data', c => { chunks.push(c); size += c.length; });
          file.on('limit', () => { truncated = true; });
          file.on('end', () => resolve({ originalName: cleanName, ts, buf: Buffer.concat(chunks), size, mime: info.mimeType, truncated }));
          file.on('error', reject);
        });
        bb.on('error', reject);
        bb.on('close', () => setTimeout(() => resolve(null), 50));
      });
      req.pipe(bb);
      const info = await fileP;
      if (!info) return json(res, 400, { error: 'no se recibió ningún archivo' });
      if (info.truncated) return json(res, 413, { error: 'foto demasiado grande (máx ' + MAX_PHOTO_MB + ' MB)' });
      if (info.size === 0) return json(res, 400, { error: 'archivo vacío' });
      const idClean = String(parts.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
      if (!idClean) return json(res, 400, { error: 'falta id' });
      if (!info.mime || !info.mime.startsWith('image/')) return json(res, 400, { error: 'solo se aceptan imágenes' });

      const dir = path.join(PHOTOS_DIR, idClean);
      fs.mkdirSync(dir, { recursive: true });
      const ext = (info.originalName.match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0].toLowerCase();
      const finalName = info.ts + '__' + info.originalName;
      const filePath = path.join(dir, finalName);
      fs.writeFileSync(filePath, info.buf);
      // Metadata sidecar
      const meta = {
        id: idClean, file: finalName, size: info.size, mime: info.mime,
        by: sess.username, at: new Date().toISOString(),
        caption: (parts.caption || '').toString().slice(0, 300),
      };
      fs.writeFileSync(filePath + '.json', JSON.stringify(meta, null, 2));
      appendLog({ ts: meta.at, by: sess.username, id: idClean, field: 'foto', prev: null, next: finalName });
      // Notificar por email en background
      let cam = null; try { cam = parts.cam ? JSON.parse(parts.cam) : null; } catch {}
      notifyFotoUpload({ id: idClean, by: sess.username, cam, filename: finalName, filePath, size: info.size, caption: meta.caption })
        .catch(e => console.log('[notify-foto] error:', e.message));
      return json(res, 200, { ok: true, file: finalName, size: info.size });
    } catch (e) {
      return json(res, 500, { error: 'no se pudo procesar la foto', detail: String(e) });
    }
  }
  if (m === 'GET' && url === '/api/photos') {
    try {
      const q = new URLSearchParams((req.url.split('?')[1]) || '');
      const idClean = String(q.get('id') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
      if (!idClean) return json(res, 400, { error: 'falta id' });
      const dir = path.join(PHOTOS_DIR, idClean);
      if (!fs.existsSync(dir)) return json(res, 200, []);
      const files = fs.readdirSync(dir).filter(f => !f.endsWith('.json'));
      const list = files.map(f => {
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, f + '.json'), 'utf8')); } catch {}
        return { file: f, url: '/photos/' + idClean + '/' + encodeURIComponent(f),
                 by: meta.by || '—', at: meta.at || '', caption: meta.caption || '', size: meta.size || 0 };
      }).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
      return json(res, 200, list);
    } catch (e) { return json(res, 500, { error: String(e) }); }
  }
  if (m === 'GET' && url.startsWith('/photos/')) {
    const parts = url.split('/').filter(Boolean); // ['photos', id, filename]
    if (parts.length !== 3) return json(res, 400, { error: 'ruta inválida' });
    const idClean = parts[1].replace(/[^A-Za-z0-9_-]/g, '');
    const fileName = decodeURIComponent(parts[2]).replace(/[\\/]/g, '');
    const filePath = path.join(PHOTOS_DIR, idClean, fileName);
    if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('foto no encontrada'); }
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(filePath + '.json', 'utf8')); } catch {}
    res.writeHead(200, {
      'Content-Type': meta.mime || 'application/octet-stream',
      'Cache-Control': 'private, max-age=300',
    });
    return res.end(fs.readFileSync(filePath));
  }

  if (m === 'GET' && url === '/api/hyperlinks') {
    try {
      if (!fs.existsSync(LINKS_FILE)) return json(res, 200, {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(LINKS_FILE));
    } catch (e) { return json(res, 500, { error: String(e) }); }
  }

  if (m === 'GET' && url === '/api/data') {
    if (!fs.existsSync(DATA_FILE)) return json(res, 404, { error: 'Todavía no hay datos cargados' });
    res.writeHead(200, { 'Content-Type': XLSX_TYPE, 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(DATA_FILE));
  }

  if (m === 'GET' && (url === '/' || url === '/index.html')) return serveFile(res, 'index.html', 'text/html; charset=utf-8');

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('No encontrado');
});

server.listen(PORT, () => console.log(`Dashboard Camaras (login) escuchando en :${PORT}`));
