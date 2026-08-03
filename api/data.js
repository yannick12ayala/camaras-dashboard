// GET /api/data
// Devuelve el Excel más reciente guardado en Vercel Blob.
// Lo sirve desde el mismo origen (sin CORS) y sin caché, para que el
// dashboard siempre vea los últimos datos que subió Power Automate.

import { list } from '@vercel/blob';

const BLOB_PATH = 'camaras/data.xlsx';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { blobs } = await list({ prefix: BLOB_PATH, limit: 1 });
    if (!blobs.length) {
      return res.status(404).json({ error: 'Todavía no hay datos cargados' });
    }

    // Cache-buster: evita que el CDN sirva una versión vieja del blob
    const freshUrl = `${blobs[0].url}?ts=${Date.now()}`;
    const upstream = await fetch(freshUrl, { cache: 'no-store' });
    if (!upstream.ok) {
      return res.status(502).json({ error: `Blob HTTP ${upstream.status}` });
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).send(buffer);
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo leer los datos', detail: String(e) });
  }
}
