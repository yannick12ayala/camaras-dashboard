// POST /api/upload
// Recibe el Excel desde Power Automate y lo guarda en Vercel Blob.
// Autenticación: header  x-upload-secret: <UPLOAD_SECRET>
// El secreto vive SOLO como variable de entorno en Vercel (nunca en el cliente).

import { put } from '@vercel/blob';

const BLOB_PATH = 'camaras/data.xlsx';

async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body instanceof ArrayBuffer) return Buffer.from(req.body);
  if (typeof req.body === 'string') return Buffer.from(req.body, 'binary');
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = req.headers['x-upload-secret'];
  if (!process.env.UPLOAD_SECRET) {
    return res.status(500).json({ error: 'UPLOAD_SECRET no está configurado en el servidor' });
  }
  if (secret !== process.env.UPLOAD_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let buffer;
  try {
    buffer = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'No se pudo leer el cuerpo', detail: String(e) });
  }
  if (!buffer || buffer.length === 0) {
    return res.status(400).json({ error: 'El cuerpo está vacío' });
  }

  try {
    const blob = await put(BLOB_PATH, buffer, {
      access: 'public',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
    return res.status(200).json({ ok: true, size: buffer.length, url: blob.url });
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo guardar en Blob', detail: String(e) });
  }
}
