// CRUD de listings — colección.
//   GET  /api/listings   -> lista todos (orden: más recientes primero)
//   POST /api/listings   -> crea uno nuevo (body JSON)

import { isKvConfigured } from "../_kv.js";
import {
  loadAllListings,
  createListing,
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

  try {
    if (req.method === "GET") {
      const items = await loadAllListings();
      res.status(200).json({ total: items.length, items });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const listing = await createListing(body || {});
      res.status(201).json(listing);
      return;
    }

    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "method_not_allowed", message: `Método ${req.method} no soportado en /api/listings` });
  } catch (err) {
    sendError(res, err);
  }
}
