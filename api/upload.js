// POST /api/upload
// Recibe el Excel desde Power Automate y lo guarda en Vercel Blob.
// Autenticación: header  x-upload-secret: <UPLOAD_SECRET>
// El secreto vive SOLO como variable de entorno en Vercel (nunca en el cliente).

import { put } from '@vercel/blob';

const BLOB_PATH = 'camaras/data.xlsx';

async function readStream(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Power Automate envía el contenido de archivo envuelto como
//   {"$content-type": "...", "$content": "<base64>"}
// Si detectamos ese envoltorio, devolvemos los bytes reales decodificados.
function decodeEnvelope(buf) {
  if (buf.length && buf[0] === 0x7b /* '{' */) {
    try {
      const obj = JSON.parse(buf.toString('utf8'));
      const bytes = bytesFromObject(obj);
      if (bytes) return bytes;
    } catch { /* no era JSON: lo usamos tal cual */ }
  }
  return buf;
}

// Obtiene los bytes del cuerpo sin importar cómo lo entregue el runtime:
// Vercel puede pre-parsearlo (Buffer, objeto JSON o string) o dejarlo como stream.
// Extrae los bytes reales desde un objeto JSON ya parseado, aceptando varias
// formas: el envoltorio de Power Automate ($content) o campos b64/content.
function bytesFromObject(o) {
  if (o && typeof o === 'object') {
    if (typeof o.$content === 'string') return Buffer.from(o.$content, 'base64');
    if (typeof o.b64 === 'string')       return Buffer.from(o.b64, 'base64');
    if (typeof o.content === 'string')   return Buffer.from(o.content, 'base64');
  }
  return null;
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

  let bytes;
  try {
    bytes = await getBytes(req);
  } catch (e) {
    return res.status(400).json({ error: 'No se pudo leer el cuerpo', detail: String(e) });
  }
  if (!bytes || bytes.length === 0) {
    return res.status(400).json({ error: 'El cuerpo está vacío' });
  }

  try {
    const blob = await put(BLOB_PATH, bytes, {
      access: 'public',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
    return res.status(200).json({ ok: true, size: bytes.length, url: blob.url });
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo guardar en Blob', detail: String(e) });
  }
}
