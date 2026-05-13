// Vercel Serverless Function — proxy autenticado para /items/{id}/description.

import { mlFetch, sendUpstreamError } from "./_ml.js";

export default async function handler(req, res) {
  try {
    const id = String(req.query?.id || "").trim();
    if (!id || !/^MLA\d+$/i.test(id)) {
      res.status(400).json({
        error: "invalid_id",
        message: "Falta o es inválido el query param ?id=MLA...",
      });
      return;
    }

    const upstream = await mlFetch(`/items/${id}/description`);
    const body = await upstream.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.status(upstream.status).send(body);
  } catch (err) {
    sendUpstreamError(res, err);
  }
}
