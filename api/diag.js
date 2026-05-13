// Endpoint de diagnóstico TEMPORAL ampliado.
// Prueba múltiples endpoints y combinaciones de headers para encontrar
// cuál funciona y cuál bloquea ML. Borrar cuando todo funcione.

import { ML_BASE, getMlAccessToken } from "./_ml.js";

function mask(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}...${s.slice(-3)} (len=${s.length})`;
}

async function probe(label, url, headers) {
  try {
    const r = await fetch(url, { headers });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    return {
      label,
      status: r.status,
      ok: r.ok,
      reqId: r.headers.get("x-request-id"),
      body: typeof body === "object"
        ? { keys: Object.keys(body).slice(0, 8), preview: JSON.stringify(body).slice(0, 200) }
        : body,
    };
  } catch (e) {
    return { label, error: e?.message };
  }
}

export default async function handler(req, res) {
  const out = {
    env: {
      ML_CLIENT_ID: mask(process.env.ML_CLIENT_ID),
      ML_CLIENT_SECRET: mask(process.env.ML_CLIENT_SECRET),
      VERCEL_REGION: process.env.VERCEL_REGION,
      NODE_VERSION: process.version,
    },
    oauth: null,
    probes: [],
  };

  let token = null;
  try {
    token = await getMlAccessToken();
    out.oauth = { ok: true, token: mask(token) };
  } catch (e) {
    out.oauth = { ok: false, error: e?.message, upstream: e?.upstream };
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(out);
    return;
  }

  const baseHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const browserish = {
    ...baseHeaders,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
    Origin: "https://www.mercadolibre.com.ar",
    Referer: "https://www.mercadolibre.com.ar/",
  };

  // 1) /users/me — confirma que el token sirve para algo autenticado
  out.probes.push(await probe("users/me", `${ML_BASE}/users/me`, baseHeaders));

  // 2) /sites/MLA — info del sitio (público)
  out.probes.push(await probe("sites/MLA", `${ML_BASE}/sites/MLA`, baseHeaders));

  // 3) /categories/MLA1744 — info de categoría (público)
  out.probes.push(await probe("categories/MLA1744", `${ML_BASE}/categories/MLA1744`, baseHeaders));

  // 4) Search simple sin filtros, con UA mínimo
  out.probes.push(await probe(
    "search:basic",
    `${ML_BASE}/sites/MLA/search?q=cruze&limit=1`,
    baseHeaders,
  ));

  // 5) Search con headers de browser-like (Origin, Referer, UA real)
  out.probes.push(await probe(
    "search:browserish",
    `${ML_BASE}/sites/MLA/search?q=cruze&limit=1`,
    browserish,
  ));

  // 6) Search por categoría (sin q)
  out.probes.push(await probe(
    "search:category-only",
    `${ML_BASE}/sites/MLA/search?category=MLA1744&limit=1`,
    browserish,
  ));

  // 7) Highlights / public listing
  out.probes.push(await probe(
    "highlights",
    `${ML_BASE}/highlights/MLA/category/MLA1744`,
    browserish,
  ));

  // 8) Item público específico (id genérico de prueba)
  out.probes.push(await probe(
    "item:fixed",
    `${ML_BASE}/items/MLA1234567890`,
    baseHeaders,
  ));

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(out);
}
