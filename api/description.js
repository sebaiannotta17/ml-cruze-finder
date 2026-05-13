// Vercel Serverless Function — proxy para /items/{id}/description de Mercado Libre.
// Mismo motivo que /api/search: ML responde 403 a requests desde el navegador.

const ML_BASE = "https://api.mercadolibre.com";

export default async function handler(req, res) {
  try {
    const id = String(req.query?.id || "").trim();
    if (!id || !/^MLA\d+$/i.test(id)) {
      res.status(400).json({ error: "invalid_id", message: "Falta o es inválido el query param ?id=MLA..." });
      return;
    }

    const upstream = await fetch(`${ML_BASE}/items/${id}/description`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 ml-cruze-finder/1.0",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
      },
    });

    const body = await upstream.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // Las descripciones cambian poco: cacheamos 1 día con SWR de 1 semana.
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.status(upstream.status).send(body);
  } catch (err) {
    res.status(502).json({
      error: "upstream_failed",
      message: err?.message || "Error desconocido al consultar Mercado Libre.",
    });
  }
}
