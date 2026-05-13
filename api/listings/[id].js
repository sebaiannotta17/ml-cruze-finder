// CRUD de listings — recurso individual.
//   GET    /api/listings/:id   -> detalle
//   PUT    /api/listings/:id   -> update parcial (body JSON)
//   DELETE /api/listings/:id   -> borra

import { isKvConfigured } from "../_kv.js";
import {
  loadListing,
  updateListing,
  removeListing,
  readJsonBody,
  sendError,
} from "../_listings.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!isKvConfigured()) {
    return sendError(res, {
      code: "kv_not_configured",
      status: 500,
      message: "Vercel KV no está configurado. Activá Storage → KV en el dashboard.",
    });
  }

  const id = String(req.query?.id || "").trim();
  if (!id) {
    return sendError(res, { code: "invalid_id", status: 400, message: "Falta el id en la URL." });
  }

  try {
    if (req.method === "GET") {
      const listing = await loadListing(id);
      if (!listing) {
        return sendError(res, { code: "not_found", status: 404, message: "Listing no encontrado." });
      }
      res.status(200).json(listing);
      return;
    }

    if (req.method === "PUT" || req.method === "PATCH") {
      const body = await readJsonBody(req);
      const updated = await updateListing(id, body || {});
      res.status(200).json(updated);
      return;
    }

    if (req.method === "DELETE") {
      await removeListing(id);
      res.status(200).json({ ok: true, id });
      return;
    }

    res.setHeader("Allow", "GET, PUT, PATCH, DELETE");
    res.status(405).json({ error: "method_not_allowed", message: `Método ${req.method} no soportado en /api/listings/:id` });
  } catch (err) {
    sendError(res, err);
  }
}
