// GET /api/data
// Devuelve el Excel guardado en el Gist de GitHub (decodifica el base64 a xlsx).
// Se sirve desde el mismo origen (sin CORS). Cache corto en el edge para no
// golpear la API de GitHub en cada visita.

const GIST_FILENAME = 'camaras_data_b64.txt';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GIST_ID) {
    return res.status(500).json({ error: 'GITHUB_TOKEN o GIST_ID no están configurados en el servidor' });
  }

  try {
    const r = await fetch(`https://api.github.com/gists/${process.env.GIST_ID}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'camaras-dashboard',
      },
      cache: 'no-store',
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: `GitHub HTTP ${r.status}`, detail: t.slice(0, 200) });
    }
    const gist = await r.json();
    const files = gist.files || {};
    // Preferir el archivo esperado; si no está, tomar el primero del gist.
    const file = files[GIST_FILENAME] || Object.values(files)[0];
    if (!file) {
      return res.status(404).json({ error: 'Todavía no hay datos cargados' });
    }

    let b64 = file.content || '';
    // Si el gist truncó el contenido (archivo grande), leerlo desde raw_url.
    if (file.truncated && file.raw_url) {
      const rr = await fetch(file.raw_url, { headers: { 'User-Agent': 'camaras-dashboard' }, cache: 'no-store' });
      b64 = await rr.text();
    }
    b64 = (b64 || '').trim();
    if (!b64) {
      return res.status(404).json({ error: 'Todavía no hay datos cargados' });
    }

    const buffer = Buffer.from(b64, 'base64');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    return res.status(200).send(buffer);
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo leer los datos', detail: String(e) });
  }
}
