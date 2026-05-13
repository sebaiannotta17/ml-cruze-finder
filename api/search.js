// Vercel Serverless Function — proxy autenticado para /sites/MLA/search.
// Mercado Libre dejó de servir esta API anónimamente: ahora requiere
// OAuth (client_credentials). El helper api/_ml.js maneja el token.

import { mlFetch, sendUpstreamError } from "./_ml.js";

const CATEGORY_AUTOS = "MLA1744";

export default async function handler(req, res) {
  try {
    const {
      q = "",
      state = "",
      offset = "0",
      limit = "50",
      condition = "used",
    } = req.query || {};

    const params = new URLSearchParams({
      q: String(q),
      category: CATEGORY_AUTOS,
      limit: String(limit),
      offset: String(offset),
      condition: String(condition),
    });
    if (state) params.set("state", String(state));

    const upstream = await mlFetch(`/sites/MLA/search?${params}`);
    const body = await upstream.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // Cacheamos 5 min en el CDN, con SWR de 10 min, para reducir hits a ML.
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.status(upstream.status).send(body);
  } catch (err) {
    sendUpstreamError(res, err);
  }
}
