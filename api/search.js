// Vercel Serverless Function — proxy para /sites/MLA/search de Mercado Libre.
// La API pública de ML actualmente bloquea (403) requests directas desde el
// navegador cuando vienen sin Origin/User-Agent confiable. Hacemos el fetch
// desde el backend de Vercel y reenviamos la respuesta al cliente.

const ML_BASE = "https://api.mercadolibre.com";
const CATEGORY_AUTOS = "MLA1744";

export default async function handler(req, res) {
  try {
    const { q = "", state = "", offset = "0", limit = "50", condition = "used" } = req.query || {};

    const params = new URLSearchParams({
      q: String(q),
      category: CATEGORY_AUTOS,
      limit: String(limit),
      offset: String(offset),
      condition: String(condition),
    });
    if (state) params.set("state", String(state));

    const url = `${ML_BASE}/sites/MLA/search?${params}`;

    const upstream = await fetch(url, {
      headers: {
        // Identificamos el cliente como un User-Agent navegador estándar
        // para evitar bloqueos antibot del side de ML.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 ml-cruze-finder/1.0",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
      },
    });

    const body = await upstream.text();

    // CORS para llamadas desde el mismo dominio (no estrictamente necesario,
    // pero útil si alguien embebe el endpoint).
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // Cache CDN: 5 min frescos, 10 min stale-while-revalidate.
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.status(upstream.status).send(body);
  } catch (err) {
    res.status(502).json({
      error: "upstream_failed",
      message: err?.message || "Error desconocido al consultar Mercado Libre.",
    });
  }
}
