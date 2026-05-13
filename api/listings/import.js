// /api/listings/import — Auto-fill desde una URL de Mercado Libre.
//
// Recibe ?url=... (GET) o { url } (POST JSON), extrae el ID MLA,
// llama a la API oficial /items/{id} con nuestro user token OAuth
// (que para /items/{id} SÍ funciona — lo verificamos manualmente),
// y devuelve un objeto pre-rellenado con los campos del listing.
//
// Para URLs que no son de ML (ej: Facebook Marketplace), devuelve
// un esqueleto con source detectado y los demás campos en null,
// para que el usuario los complete a mano.

import { mlFetch, sendUpstreamError } from "../_ml.js";
import {
  detectSourceFromUrl,
  extractMlItemId,
  detectVariantFromTitle,
} from "../_listings.js";

// Mapea atributos típicos de ML a nuestros campos.
function getAttrValue(item, ...ids) {
  if (!item?.attributes) return null;
  for (const id of ids) {
    const a = item.attributes.find((x) => x.id === id);
    if (a) {
      return a.value_name ?? (a.values && a.values[0]?.name) ?? null;
    }
  }
  return null;
}

function getAttrNumber(item, ...ids) {
  const v = getAttrValue(item, ...ids);
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function mapTransmission(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s.includes("autom")) return "Automática";
  if (s.includes("manual")) return "Manual";
  return null;
}

function mapFuel(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s.includes("naf") || s.includes("gasol")) return "Nafta";
  if (s.includes("dies") || s.includes("dies")) return "Diésel";
  if (s.includes("gnc")) return "GNC";
  return null;
}

// Mejorar la calidad de las fotos de ML (-I -> -O da la versión original).
function upgradeImg(url) {
  if (!url) return null;
  return String(url).replace(/-I\.(jpg|jpeg|webp|png)/i, "-O.$1").replace(/^http:/, "https:");
}

function buildSkeleton(url, extra = {}) {
  return {
    url: url || null,
    source: detectSourceFromUrl(url || ""),
    title: null,
    variant: null,
    price: null,
    currency: null,
    year: null,
    km: null,
    transmission: null,
    fuel: null,
    location: null,
    description: null,
    photos: [],
    ml_item_id: null,
    ...extra,
  };
}

async function fetchMlItem(itemId) {
  const upstream = await mlFetch(`/items/${itemId}`);
  const body = await upstream.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    const err = new Error(`ML respondió con un body no-JSON (${upstream.status}).`);
    err.status = 502;
    throw err;
  }
  if (!upstream.ok) {
    const err = new Error(data?.message || `ML respondió ${upstream.status}.`);
    err.status = upstream.status;
    err.upstream = data;
    throw err;
  }
  return data;
}

// Mapea el item de ML a nuestro schema parcial.
function mapMlItemToListing(url, item) {
  const title = item.title || null;
  const price = typeof item.price === "number" ? item.price : null;
  const currency = item.currency_id === "ARS" ? "ARS" : item.currency_id === "USD" ? "USD" : null;
  const year =
    getAttrNumber(item, "VEHICLE_YEAR", "MANUFACTURING_YEAR") || null;
  const km = getAttrNumber(item, "KILOMETERS");
  const transmission = mapTransmission(getAttrValue(item, "TRANSMISSION"));
  const fuel = mapFuel(getAttrValue(item, "FUEL_TYPE"));

  const addr = item.seller_address || item.location || {};
  const city = addr.city?.name || addr.city_name || "";
  const state = addr.state?.name || addr.state_name || "";
  const location = [city, state].filter(Boolean).join(", ") || null;

  let photos = [];
  if (Array.isArray(item.pictures) && item.pictures.length) {
    photos = item.pictures
      .map((p) => upgradeImg(p.secure_url || p.url))
      .filter(Boolean)
      .slice(0, 20);
  } else if (item.thumbnail) {
    const u = upgradeImg(item.thumbnail);
    if (u) photos = [u];
  }

  const permalink = item.permalink || url;
  const variant = detectVariantFromTitle(title || "") || "otro";

  return {
    url: permalink,
    source: "mercadolibre",
    title,
    variant,
    price,
    currency,
    year,
    km,
    transmission,
    fuel,
    location,
    description: null, // la descripción la trae /items/{id}/description; la pedimos abajo si hace falta
    photos,
    ml_item_id: item.id || null,
  };
}

async function fetchMlDescription(itemId) {
  try {
    const upstream = await mlFetch(`/items/${itemId}/description`);
    if (!upstream.ok) return null;
    const data = await upstream.json().catch(() => null);
    if (!data) return null;
    return (data.plain_text || data.text || "").trim() || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    let url = "";
    let withDescription = true;

    if (req.method === "GET") {
      url = String(req.query?.url || "").trim();
      if (req.query?.with_description === "false") withDescription = false;
    } else if (req.method === "POST") {
      const body =
        req.body && typeof req.body === "object"
          ? req.body
          : typeof req.body === "string" && req.body
          ? (() => {
              try {
                return JSON.parse(req.body);
              } catch {
                return {};
              }
            })()
          : {};
      url = String(body.url || "").trim();
      if (body.with_description === false) withDescription = false;
    } else {
      res.setHeader("Allow", "GET, POST");
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    if (!url) {
      res.status(400).json({
        error: "invalid_url",
        message: "Falta el parámetro url.",
      });
      return;
    }

    const source = detectSourceFromUrl(url);

    if (source !== "mercadolibre") {
      // Sin auto-fill posible: devolvemos un esqueleto y que el usuario complete.
      res.status(200).json({
        source,
        autofilled: false,
        message:
          source === "facebook_marketplace"
            ? "Facebook Marketplace no tiene API pública. Completá los datos a mano."
            : "URL no reconocida. Completá los datos a mano.",
        ...buildSkeleton(url),
      });
      return;
    }

    const itemId = extractMlItemId(url);
    if (!itemId) {
      res.status(400).json({
        error: "invalid_ml_url",
        message: "No pude extraer el ID MLA-XXXXXXXX de la URL.",
        ...buildSkeleton(url),
      });
      return;
    }

    const item = await fetchMlItem(itemId);
    const mapped = mapMlItemToListing(url, item);

    if (withDescription && mapped.ml_item_id) {
      const desc = await fetchMlDescription(mapped.ml_item_id);
      if (desc) mapped.description = desc;
    }

    res.status(200).json({
      source: "mercadolibre",
      autofilled: true,
      ...mapped,
    });
  } catch (err) {
    sendUpstreamError(res, err);
  }
}
