// /api/listings/import — Auto-fill desde una URL de Mercado Libre.
//
// Estrategia en cascada:
//   1) API oficial GET /items/{id} con nuestro OAuth user token.
//      Funciona para items propios o cuando ML lo permite.
//   2) Si la API devuelve 403 / 401 / 404, scrapeamos la página HTML
//      individual del item (auto.mercadolibre.com.ar/MLA-...). Esa
//      página es pública y ML la sirve permisiva a crawlers SEO
//      (facebookexternalhit, Twitterbot, Googlebot, etc.) porque
//      necesita los previews en redes sociales.
//   3) Si las dos fallan, devolvemos un esqueleto vacío con
//      autofilled:false y un mensaje accionable.
//
// Para URLs que no son de ML, devolvemos un esqueleto con la source
// detectada (Facebook Marketplace u otro) para que el usuario complete.

import { mlFetch, sendUpstreamError } from "../_ml.js";
import {
  detectSourceFromUrl,
  extractMlItemId,
  detectVariantFromTitle,
} from "../_listings.js";

// ------------------------------------------------------------
// Helpers de mapping desde la API oficial
// ------------------------------------------------------------
function getAttrValue(item, ...ids) {
  if (!item?.attributes) return null;
  for (const id of ids) {
    const a = item.attributes.find((x) => x.id === id);
    if (a) return a.value_name ?? (a.values && a.values[0]?.name) ?? null;
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
  if (s.includes("dies")) return "Diésel";
  if (s.includes("gnc")) return "GNC";
  return null;
}

function upgradeImg(url) {
  if (!url) return null;
  return String(url)
    .replace(/-I\.(jpg|jpeg|webp|png)/i, "-O.$1")
    .replace(/^http:/, "https:");
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

// ------------------------------------------------------------
// Path 1: API oficial /items/{id}
// ------------------------------------------------------------
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

function mapMlItemToListing(url, item) {
  const title = item.title || null;
  const price = typeof item.price === "number" ? item.price : null;
  const currency = item.currency_id === "ARS" ? "ARS" : item.currency_id === "USD" ? "USD" : null;
  const year = getAttrNumber(item, "VEHICLE_YEAR", "MANUFACTURING_YEAR") || null;
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
    description: null,
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

// ------------------------------------------------------------
// Path 2: scraping de la página individual del item
// ------------------------------------------------------------
const SEO_USER_AGENTS = [
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Twitterbot/1.0",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "WhatsApp/2.23.20.0",
];

const ANTIBOT_SIGNALS = /suspicious-traffic|access-?denied|captcha|cloudflare|just\s*a\s*moment|attention required|datadome|perimeterx|account-verification|recaptcha/i;

function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ""; }
    });
}

function parseOgAndTwitterTags(html) {
  const tags = {};
  // Captura <meta property="og:foo" content="bar"> y <meta name="twitter:foo" content="bar">
  // En cualquier orden de atributos.
  const re = /<meta\b[^>]*?(?:property|name)\s*=\s*["'](og:[^"']+|twitter:[^"']+)["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    tags[m[1].toLowerCase()] = decodeHtmlEntities(m[2]);
  }
  const re2 = /<meta\b[^>]*?content\s*=\s*["']([^"']*)["'][^>]*?(?:property|name)\s*=\s*["'](og:[^"']+|twitter:[^"']+)["'][^>]*>/gi;
  while ((m = re2.exec(html))) {
    tags[m[2].toLowerCase()] = decodeHtmlEntities(m[1]);
  }
  return tags;
}

function parseJsonLd(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]+?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const json = JSON.parse(m[1].trim());
      out.push(json);
    } catch {
      // ignore
    }
  }
  return out;
}

function findProductLd(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const it of node) {
      const r = findProductLd(it);
      if (r) return r;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const t = node["@type"];
  const types = Array.isArray(t) ? t : [t];
  if (types.some((x) => /^(Product|Vehicle|Car|Motorcycle)$/i.test(x || ""))) {
    return node;
  }
  if (node["@graph"]) {
    const r = findProductLd(node["@graph"]);
    if (r) return r;
  }
  for (const k of Object.keys(node)) {
    if (k.startsWith("@")) continue;
    const r = findProductLd(node[k]);
    if (r) return r;
  }
  return null;
}

function pickImages(product, ogTags) {
  const fromLd = product?.image
    ? (Array.isArray(product.image) ? product.image : [product.image])
        .map((it) => (typeof it === "string" ? it : it?.url || it?.contentUrl))
        .filter(Boolean)
    : [];
  const fromOg = [];
  if (ogTags["og:image"]) fromOg.push(ogTags["og:image"]);
  if (ogTags["og:image:secure_url"]) fromOg.push(ogTags["og:image:secure_url"]);
  if (ogTags["twitter:image"]) fromOg.push(ogTags["twitter:image"]);

  const merged = [...fromLd, ...fromOg]
    .map(upgradeImg)
    .filter(Boolean);

  // Deduplicate manteniendo orden
  const seen = new Set();
  return merged.filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return u;
  }).slice(0, 20);
}

function parseLocationFromHtml(html) {
  // Buscar señales típicas de ubicación en la página del item. Muy heurístico.
  // Ej: "Ubicación de la publicación" seguida de ciudad, estado.
  const blocks = [
    /Ubicaci[oó]n[^<]*<[^>]*>([^<]{3,80}?,[^<]{3,60})</i,
    /"location"\s*:\s*"([^"]{3,140})"/i,
    /"city_name"\s*:\s*"([^"]{2,80})"[^}]*?"state_name"\s*:\s*"([^"]{2,80})"/i,
  ];
  for (const re of blocks) {
    const m = html.match(re);
    if (!m) continue;
    if (m[2]) return `${decodeHtmlEntities(m[1])}, ${decodeHtmlEntities(m[2])}`.trim();
    return decodeHtmlEntities(m[1]).trim();
  }
  return null;
}

function parseKmFromHtml(html) {
  // Buscar patrones tipo "70.000 km", "120000 km".
  const m = html.match(/\b(\d{1,3}(?:[.,]\d{3})+|\d{4,7})\s*(?:km|kilómetros|kms)\b/i);
  if (!m) return null;
  const num = parseInt(m[1].replace(/[.,]/g, ""), 10);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function parseYearFromTitle(title) {
  if (!title) return null;
  const m = title.match(/\b(19[8-9]\d|20[0-3]\d)\b/);
  return m ? Number(m[1]) : null;
}

async function tryFetchHtml(url, userAgent) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
    },
    redirect: "follow",
  });
  const html = await res.text();
  const looksBlocked = html.length < 3000 || ANTIBOT_SIGNALS.test(html.slice(0, 8000));
  return { status: res.status, finalUrl: res.url, html, blocked: looksBlocked };
}

async function scrapeMlItemPage(url) {
  let lastErr = null;
  for (const ua of SEO_USER_AGENTS) {
    try {
      const r = await tryFetchHtml(url, ua);
      if (r.status >= 400 || r.blocked) {
        lastErr = new Error(`HTTP ${r.status}${r.blocked ? " (antibot)" : ""} con UA=${ua.split("/")[0]}`);
        lastErr.status = r.status;
        continue;
      }
      return parseHtmlToListing(url, r.finalUrl, r.html);
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error("Scraping falló");
}

function parseHtmlToListing(originalUrl, finalUrl, html) {
  const og = parseOgAndTwitterTags(html);
  const lds = parseJsonLd(html);
  const product = findProductLd(lds);

  const title = decodeHtmlEntities(
    product?.name ||
    og["og:title"] ||
    og["twitter:title"] ||
    ((html.match(/<title>([^<]+)<\/title>/i) || [])[1] || "")
  ).trim() || null;

  const description = decodeHtmlEntities(
    product?.description ||
    og["og:description"] ||
    og["twitter:description"] ||
    ""
  ).replace(/\s+/g, " ").trim() || null;

  // Precio + moneda
  let price = null;
  let currency = null;
  const offer = Array.isArray(product?.offers) ? product.offers[0] : product?.offers;
  if (offer?.price != null) {
    const n = Number(String(offer.price).replace(/[^\d.]/g, ""));
    if (Number.isFinite(n) && n > 0) price = Math.round(n);
  }
  if (offer?.priceCurrency) currency = String(offer.priceCurrency).toUpperCase();
  if (price == null && og["og:price:amount"]) {
    const n = Number(String(og["og:price:amount"]).replace(/[^\d.]/g, ""));
    if (Number.isFinite(n) && n > 0) price = Math.round(n);
  }
  if (!currency && og["og:price:currency"]) {
    currency = String(og["og:price:currency"]).toUpperCase();
  }
  if (currency && !["USD", "ARS"].includes(currency)) currency = null;

  const photos = pickImages(product, og);

  // Año (del título) + km (del HTML)
  const year = parseYearFromTitle(title);
  const km = parseKmFromHtml(html);

  // Ubicación
  const location = parseLocationFromHtml(html);

  return {
    url: finalUrl || originalUrl,
    source: "mercadolibre",
    title,
    variant: detectVariantFromTitle(title || ""),
    price,
    currency,
    year,
    km,
    transmission: null, // muy difícil de extraer confiablemente del HTML
    fuel: null,
    location,
    description,
    photos,
    ml_item_id: extractMlItemId(finalUrl || originalUrl) || null,
  };
}

// ------------------------------------------------------------
// Handler
// ------------------------------------------------------------
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
              try { return JSON.parse(req.body); } catch { return {}; }
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
      res.status(200).json({
        source,
        autofilled: false,
        autofill_source: null,
        message:
          source === "facebook_marketplace"
            ? "Facebook Marketplace no tiene API pública. Completá los datos a mano."
            : "URL no reconocida. Completá los datos a mano.",
        ...buildSkeleton(url),
      });
      return;
    }

    const itemId = extractMlItemId(url);

    // === Path 1: API oficial ===
    let mappedFromApi = null;
    let apiError = null;
    if (itemId) {
      try {
        const item = await fetchMlItem(itemId);
        mappedFromApi = mapMlItemToListing(url, item);
        if (withDescription && mappedFromApi.ml_item_id) {
          const desc = await fetchMlDescription(mappedFromApi.ml_item_id);
          if (desc) mappedFromApi.description = desc;
        }
      } catch (e) {
        apiError = e;
        // No-op, seguimos al fallback
      }
    }

    if (mappedFromApi) {
      res.status(200).json({
        source: "mercadolibre",
        autofilled: true,
        autofill_source: "api",
        ...mappedFromApi,
      });
      return;
    }

    // === Path 2: scraping de la página individual ===
    let mappedFromHtml = null;
    let scrapeError = null;
    try {
      mappedFromHtml = await scrapeMlItemPage(url);
    } catch (e) {
      scrapeError = e;
    }

    if (mappedFromHtml && (mappedFromHtml.title || mappedFromHtml.price)) {
      res.status(200).json({
        source: "mercadolibre",
        autofilled: true,
        autofill_source: "html_scrape",
        autofill_note:
          "Datos tomados de la página pública del item (la API oficial está restringida para items de terceros).",
        ...mappedFromHtml,
      });
      return;
    }

    // === Sin datos: devolvemos esqueleto + mensaje accionable ===
    const apiMsg = apiError?.message ? apiError.message.slice(0, 150) : "desconocido";
    const scrapeMsg = scrapeError?.message ? scrapeError.message.slice(0, 150) : "desconocido";
    res.status(200).json({
      source: "mercadolibre",
      autofilled: false,
      autofill_source: null,
      message:
        `ML no nos dejó traer los datos automáticamente. ` +
        `Cargalos a mano o probá con otra publicación. ` +
        `(API: ${apiMsg} · scrape: ${scrapeMsg})`,
      ...buildSkeleton(url),
    });
  } catch (err) {
    sendUpstreamError(res, err);
  }
}
