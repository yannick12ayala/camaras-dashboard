// POST /api/upload
// Recibe el Excel desde Power Automate y lo guarda como base64 en un Gist de GitHub.
// Auth: header  x-upload-secret: <UPLOAD_SECRET>
// El token de GitHub vive SOLO como variable de entorno en Vercel (nunca en el cliente).

const GIST_FILENAME = 'camaras_data_b64.txt';

async function readStream(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Extrae bytes reales desde un objeto JSON ya parseado: acepta el envoltorio de
// Power Automate ($content) o campos b64/content.
function bytesFromObject(o) {
  if (o && typeof o === 'object') {
    if (typeof o.$content === 'string') return Buffer.from(o.$content, 'base64');
    if (typeof o.b64 === 'string')       return Buffer.from(o.b64, 'base64');
    if (typeof o.content === 'string')   return Buffer.from(o.content, 'base64');
  }
  return null;
}

function decodeEnvelope(buf) {
  if (buf.length && buf[0] === 0x7b /* '{' */) {
    try {
      const bytes = bytesFromObject(JSON.parse(buf.toString('utf8')));
      if (bytes) return bytes;
    } catch { /* no era JSON: usar tal cual */ }
  }
  return buf;
}

async function getBytes(req) {
  const b = req.body;
  if (Buffer.isBuffer(b)) return decodeEnvelope(b);
  if (b instanceof ArrayBuffer) return decodeEnvelope(Buffer.from(b));
  const fromObj = bytesFromObject(b);
  if (fromObj) return fromObj;
  if (typeof b === 'string' && b.length) return decodeEnvelope(Buffer.from(b, 'utf8'));
  return decodeEnvelope(await readStream(req));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.UPLOAD_SECRET) {
    return res.status(500).json({ error: 'UPLOAD_SECRET no está configurado en el servidor' });
  }
  if (req.headers['x-upload-secret'] !== process.env.UPLOAD_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GIST_ID) {
    return res.status(500).json({ error: 'GITHUB_TOKEN o GIST_ID no están configurados en el servidor' });
  }

  let bytes;
  try {
    bytes = await getBytes(req);
  } catch (e) {
    return res.status(400).json({ error: 'No se pudo leer el cuerpo', detail: String(e) });
  }
  if (!bytes || bytes.length === 0) {
    return res.status(400).json({ error: 'El cuerpo está vacío' });
  }

  const b64 = bytes.toString('base64');
  try {
    const r = await fetch(`https://api.github.com/gists/${process.env.GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'camaras-dashboard',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: { [GIST_FILENAME]: { content: b64 } } }),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: `GitHub HTTP ${r.status}`, detail: t.slice(0, 300) });
    }
    return res.status(200).json({ ok: true, size: bytes.length });
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo guardar en el Gist', detail: String(e) });
  }
}
