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

const PORT          = process.env.PORT || 8080;
const DATA_FILE     = process.env.DATA_FILE || '/data/camaras.xlsx';
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

// Para /api/upload: acepta bytes crudos o JSON {b64|$content|content}
function normalizeUpload(body) {
  if (body.length && body[0] === 0x7b) {
    try { const o = JSON.parse(body.toString('utf8')); const s = o.b64 || o.$content || o.content; if (typeof s === 'string') return Buffer.from(s, 'base64'); } catch {}
  }
  return body;
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

  if (m === 'GET' && url === '/api/data') {
    if (!fs.existsSync(DATA_FILE)) return json(res, 404, { error: 'Todavía no hay datos cargados' });
    res.writeHead(200, { 'Content-Type': XLSX_TYPE, 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(DATA_FILE));
  }

  if (m === 'GET' && (url === '/' || url === '/index.html')) return serveFile(res, 'index.html', 'text/html; charset=utf-8');

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('No encontrado');
});

server.listen(PORT, () => console.log(`Dashboard Camaras (login) escuchando en :${PORT}`));
