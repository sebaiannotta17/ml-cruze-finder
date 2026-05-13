// Helper compartido para el CRUD de listings (publicaciones que el usuario
// guarda manualmente). Centraliza schema, normalización y acceso a KV.
//
// Schema en KV:
//   listings:index   -> JSON array de uuids ordenados por created_at desc
//   listings:<uuid>  -> JSON con el listing completo

import { kvGet, kvSet, kvDel } from "./_kv.js";
import { randomUUID } from "node:crypto";

const INDEX_KEY = "listings:index";
const itemKey = (id) => `listings:${id}`;

// ------------------------------------------------------------
// Enums permitidos
// ------------------------------------------------------------
export const SOURCES = ["mercadolibre", "facebook_marketplace", "otro"];
export const VARIANTS = ["ltz_plus", "ltz", "premier", "ltz_turbo", "otro"];
export const STATUSES = ["interesado", "contactado", "visitado", "descartado"];
export const CURRENCIES = ["USD", "ARS"];
export const TRANSMISSIONS = ["Manual", "Automática"];
export const FUELS = ["Nafta", "Diésel", "GNC"];

// ------------------------------------------------------------
// Detección de variante a partir del título de la publicación.
// Replica la lógica que tenía el viejo app.js para el matching de variantes.
// ------------------------------------------------------------
const VARIANT_PATTERNS = [
  { id: "ltz_plus", match: /\bLTZ\s*(\+|PLUS)\b/i },
  { id: "premier", match: /\bPREMIER\b/i },
  { id: "ltz_turbo", match: /1[\.,]?4\s*TURBO\s*LTZ/i },
  {
    id: "ltz",
    match: /\bLTZ\b/i,
    exclude: /(\bLTZ\s*(\+|PLUS)\b|\bPREMIER\b|1[\.,]?4\s*TURBO\s*LTZ)/i,
  },
];

export function detectVariantFromTitle(title) {
  if (!title) return "otro";
  for (const v of VARIANT_PATTERNS) {
    if (v.exclude && v.exclude.test(title)) continue;
    if (v.match.test(title)) return v.id;
  }
  return "otro";
}

// ------------------------------------------------------------
// URL parsing: detecta si la URL es de Mercado Libre y extrae el item id.
// Formatos típicos:
//   https://articulo.mercadolibre.com.ar/MLA-1234567890-...
//   https://auto.mercadolibre.com.ar/MLA-1234567890-...
//   https://articulo.mercadolibre.com.ar/MLA1234567890-...
//   https://www.mercadolibre.com.ar/.../p/MLA1234567890
// ------------------------------------------------------------
export function detectSourceFromUrl(url) {
  if (!url || typeof url !== "string") return "otro";
  if (/mercadolibre\.com/i.test(url)) return "mercadolibre";
  if (/facebook\.com\/marketplace/i.test(url)) return "facebook_marketplace";
  return "otro";
}

export function extractMlItemId(url) {
  if (!url || typeof url !== "string") return null;
  // Acepta MLA-1234567890 o MLA1234567890 con o sin guión
  const re = /\bMLA-?(\d{6,})\b/i;
  const m = url.match(re);
  if (!m) return null;
  return `MLA${m[1]}`;
}

// ------------------------------------------------------------
// Sanitización + validación. Devuelve { ok, errors, value }.
// Si ok=false, value es null y errors es un array de strings.
// `mode` es "create" (exige campos requeridos) o "update" (parcial).
// ------------------------------------------------------------
function asString(v, max = 5000) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

function asNumber(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asEnum(v, allowed) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  return allowed.includes(s) ? s : null;
}

function asPhotoArray(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .map((u) => {
      const s = asString(u, 2_500_000); // hasta ~1.8 MB en base64 (data URL)
      if (!s) return null;
      // Aceptamos http(s):// (URL externa) o data:image/... (foto comprimida embebida)
      if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) return s;
      return null;
    })
    .filter(Boolean)
    .slice(0, 20);
}

function asUrl(v) {
  const s = asString(v, 2000);
  if (!s) return null;
  // Validación blanda: tiene que arrancar con http(s)://
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

export function normalizeListing(input, { mode = "create", existing = null } = {}) {
  const errors = [];
  const out = existing ? { ...existing } : {};

  // url (requerido en create)
  if (input.url !== undefined) {
    const u = asUrl(input.url);
    if (!u && mode === "create") errors.push("url inválida (tiene que arrancar con http:// o https://)");
    else if (u) out.url = u;
  } else if (mode === "create") {
    errors.push("url es requerida");
  }

  // title (requerido en create)
  if (input.title !== undefined) {
    const t = asString(input.title, 300);
    if (!t && mode === "create") errors.push("title es requerido");
    else if (t) out.title = t;
  } else if (mode === "create") {
    errors.push("title es requerido");
  }

  // source (default según URL)
  if (input.source !== undefined) {
    out.source = asEnum(input.source, SOURCES) || detectSourceFromUrl(out.url || "");
  } else if (mode === "create") {
    out.source = detectSourceFromUrl(out.url || "");
  }

  // variant (default: detect from title)
  if (input.variant !== undefined) {
    out.variant = asEnum(input.variant, VARIANTS) || detectVariantFromTitle(out.title || "");
  } else if (mode === "create") {
    out.variant = detectVariantFromTitle(out.title || "");
  }

  // price + currency
  if (input.price !== undefined) out.price = asNumber(input.price);
  if (input.currency !== undefined) {
    out.currency = asEnum(input.currency, CURRENCIES) || (mode === "create" ? "USD" : out.currency);
  } else if (mode === "create") {
    out.currency = "USD";
  }

  // year, km
  if (input.year !== undefined) {
    const n = asNumber(input.year);
    out.year = n && n > 1900 && n < 2100 ? Math.round(n) : null;
  }
  if (input.km !== undefined) {
    const n = asNumber(input.km);
    out.km = n != null && n >= 0 ? Math.round(n) : null;
  }

  // transmission, fuel
  if (input.transmission !== undefined) {
    out.transmission = asEnum(input.transmission, TRANSMISSIONS);
  }
  if (input.fuel !== undefined) {
    out.fuel = asEnum(input.fuel, FUELS);
  }

  // location, description, notes (free text)
  if (input.location !== undefined) out.location = asString(input.location, 200);
  if (input.description !== undefined) out.description = asString(input.description, 8000);
  if (input.notes !== undefined) out.notes = asString(input.notes, 8000);

  // photos (acepta URLs https:// o data URLs base64)
  if (input.photos !== undefined) out.photos = asPhotoArray(input.photos);
  else if (mode === "create") out.photos = [];

  // status (default: interesado)
  if (input.status !== undefined) {
    out.status = asEnum(input.status, STATUSES) || (mode === "create" ? "interesado" : out.status);
  } else if (mode === "create") {
    out.status = "interesado";
  }

  // rating (1-5 o null)
  if (input.rating !== undefined) {
    const n = asNumber(input.rating);
    out.rating = n != null && n >= 1 && n <= 5 ? Math.round(n) : null;
  }

  // ml_item_id: si la URL es de ML, lo cacheamos para acelerar auto-fill posteriores
  if (mode === "create" || input.url !== undefined) {
    out.ml_item_id = extractMlItemId(out.url || "") || null;
  }

  if (errors.length) return { ok: false, errors, value: null };
  return { ok: true, errors: [], value: out };
}

// ------------------------------------------------------------
// KV ops
// ------------------------------------------------------------
async function readJson(key) {
  const raw = await kvGet(key);
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function writeJson(key, value) {
  return kvSet(key, JSON.stringify(value));
}

export async function loadIndex() {
  const arr = await readJson(INDEX_KEY);
  return Array.isArray(arr) ? arr : [];
}

export async function saveIndex(arr) {
  return writeJson(INDEX_KEY, arr);
}

export async function loadListing(id) {
  if (!id) return null;
  return readJson(itemKey(id));
}

export async function saveListing(listing) {
  return writeJson(itemKey(listing.id), listing);
}

export async function deleteListing(id) {
  return kvDel(itemKey(id));
}

export async function loadAllListings() {
  const ids = await loadIndex();
  if (!ids.length) return [];
  // Cargamos en paralelo. Si alguno falta (drift entre index y items),
  // lo ignoramos.
  const all = await Promise.all(ids.map((id) => loadListing(id).catch(() => null)));
  return all.filter(Boolean);
}

// ------------------------------------------------------------
// High-level CRUD
// ------------------------------------------------------------
export async function createListing(input) {
  const { ok, errors, value } = normalizeListing(input, { mode: "create" });
  if (!ok) {
    const err = new Error(errors.join("; "));
    err.code = "validation_error";
    err.status = 400;
    err.details = errors;
    throw err;
  }
  const now = new Date().toISOString();
  const listing = {
    id: randomUUID(),
    ...value,
    created_at: now,
    updated_at: now,
  };

  await saveListing(listing);

  // Insertar al inicio del índice (más reciente primero).
  const idx = await loadIndex();
  const next = [listing.id, ...idx.filter((x) => x !== listing.id)];
  await saveIndex(next);

  return listing;
}

export async function updateListing(id, patch) {
  const existing = await loadListing(id);
  if (!existing) {
    const err = new Error("listing no encontrado");
    err.code = "not_found";
    err.status = 404;
    throw err;
  }
  const { ok, errors, value } = normalizeListing(patch, {
    mode: "update",
    existing,
  });
  if (!ok) {
    const err = new Error(errors.join("; "));
    err.code = "validation_error";
    err.status = 400;
    err.details = errors;
    throw err;
  }
  const merged = {
    ...value,
    id: existing.id,
    created_at: existing.created_at,
    updated_at: new Date().toISOString(),
  };
  await saveListing(merged);
  return merged;
}

export async function removeListing(id) {
  const existing = await loadListing(id);
  if (!existing) {
    const err = new Error("listing no encontrado");
    err.code = "not_found";
    err.status = 404;
    throw err;
  }
  await deleteListing(id);
  const idx = await loadIndex();
  await saveIndex(idx.filter((x) => x !== id));
  return existing;
}

// ------------------------------------------------------------
// Helpers de respuesta uniformes (los usan los endpoints)
// ------------------------------------------------------------
export function sendError(res, err) {
  const status = err?.status || 500;
  res.status(status).json({
    error: err?.code || "internal_error",
    message: err?.message || "Error interno",
    details: err?.details,
  });
}

export async function readJsonBody(req) {
  // En Vercel functions el body ya viene parseado si Content-Type es JSON;
  // por las dudas, soportamos ambos.
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  // Stream fallback (raro en Vercel pero por las dudas)
  if (typeof req.on === "function") {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      });
      req.on("error", () => resolve({}));
    });
  }
  return {};
}
