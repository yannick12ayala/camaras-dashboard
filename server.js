// Dashboard Cámaras V — servidor self-hosted (Node puro, sin dependencias).
// - Sirve el dashboard estático (index.html, icon.png, manifest.json)
// - GET  /api/data    -> devuelve el Excel guardado en disco (detrás de login)
// - POST /api/upload  -> guarda el Excel (auth por x-upload-secret; sin login)
// - Login: HTTP Basic Auth (VIEW_USER / VIEW_PASS) para todo salvo /api/upload

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT          = process.env.PORT || 8080;
const DATA_FILE     = process.env.DATA_FILE || '/data/camaras.xlsx';
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';

// Cuentas para ver el dashboard. Dos formas (se pueden combinar):
//  - VIEW_USER / VIEW_PASS           -> una sola cuenta
//  - VIEW_USERS = "u1:pass1,u2:pass2" -> varias cuentas (una por persona)
function loadUsers() {
  const map = new Map();
  if (process.env.VIEW_USER && process.env.VIEW_PASS) {
    map.set(process.env.VIEW_USER, process.env.VIEW_PASS);
  }
  for (const pair of (process.env.VIEW_USERS || '').split(',')) {
    const p = pair.trim();
    if (!p) continue;
    const i = p.indexOf(':');
    if (i > 0) map.set(p.slice(0, i).trim(), p.slice(i + 1));
  }
  return map;
}
const USERS = loadUsers();

const PUBLIC_DIR = __dirname;
const XLSX_TYPE  = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const STATIC = {
  '/':              { file: 'index.html',   type: 'text/html; charset=utf-8' },
  '/index.html':    { file: 'index.html',   type: 'text/html; charset=utf-8' },
  '/manifest.json': { file: 'manifest.json', type: 'application/json; charset=utf-8' },
  '/icon.png':      { file: 'icon.png',     type: 'image/png' },
};

function unauthorized(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Dashboard Camaras", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('Autenticacion requerida');
}

function checkAuth(req) {
  if (USERS.size === 0) return true; // si no hay cuentas configuradas, no exige login
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const user = decoded.slice(0, i), pass = decoded.slice(i + 1);
  return USERS.has(user) && USERS.get(user) === pass;
}

function readBody(req, limitBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('cuerpo demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Acepta bytes crudos del xlsx, o JSON { b64 | $content | content } en base64.
function normalizeUpload(body) {
  if (body.length && body[0] === 0x7b /* '{' */) {
    try {
      const o = JSON.parse(body.toString('utf8'));
      const s = o.b64 || o.$content || o.content;
      if (typeof s === 'string') return Buffer.from(s, 'base64');
    } catch { /* no era JSON: usar tal cual */ }
  }
  return body;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // 1) Subida de datos (protegida por secreto, SIN login)
  if (req.method === 'POST' && url === '/api/upload') {
    if (!UPLOAD_SECRET || req.headers['x-upload-secret'] !== UPLOAD_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    try {
      let body = normalizeUpload(await readBody(req));
      if (!body.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'El cuerpo esta vacio' }));
      }
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, DATA_FILE); // escritura atomica
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, size: body.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  // 2) Todo lo demas requiere login
  if (!checkAuth(req)) return unauthorized(res);

  // 3) Datos para el dashboard
  if (req.method === 'GET' && url === '/api/data') {
    if (!fs.existsSync(DATA_FILE)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Todavia no hay datos cargados' }));
    }
    res.writeHead(200, { 'Content-Type': XLSX_TYPE, 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(DATA_FILE));
  }

  // 4) Archivos estaticos
  const st = STATIC[url];
  if (req.method === 'GET' && st) {
    const fp = path.join(PUBLIC_DIR, st.file);
    if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': st.type });
    return res.end(fs.readFileSync(fp));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('No encontrado');
});

server.listen(PORT, () => console.log(`Dashboard Camaras escuchando en :${PORT}`));
