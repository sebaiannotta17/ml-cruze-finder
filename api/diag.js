// Endpoint de diagnóstico — verifica todo el flujo con el token de USUARIO
// obtenido vía Authorization Code (no client_credentials).
// Borrar cuando todo funcione.

import { ML_BASE, getValidAccessToken } from "./_ml.js";
import { isKvConfigured, kvGet } from "./_kv.js";

function mask(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 6) return "***";
  return `${s.slice(0, 4)}...${s.slice(-4)} (len=${s.length})`;
}

async function probe(label, url, headers) {
  try {
    const r = await fetch(url, { headers });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 250); }
    return {
      label,
      status: r.status,
      ok: r.ok,
      reqId: r.headers.get("x-request-id"),
      content_type: r.headers.get("content-type"),
      results: Array.isArray(body?.results) ? body.results.length : null,
      paging: body?.paging,
      preview: typeof body === "object" ? JSON.stringify(body).slice(0, 240) : body,
    };
  } catch (e) {
    return { label, error: e?.message };
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const out = {
    env: {
      ML_CLIENT_ID: mask(process.env.ML_CLIENT_ID),
      ML_CLIENT_SECRET: mask(process.env.ML_CLIENT_SECRET),
      KV_REST_API_URL: !!process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
      UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
      VERCEL_REGION: process.env.VERCEL_REGION,
      NODE_VERSION: process.version,
    },
    kv_configured: isKvConfigured(),
    auth: null,
    probes: [],
  };

  if (!isKvConfigured()) {
    res.status(200).json(out);
    return;
  }

  try {
    const refresh = await kvGet("ml:refresh_token").catch(() => null);
    const userId = await kvGet("ml:user_id").catch(() => null);
    out.auth = {
      has_refresh_token: !!refresh,
      refresh_preview: mask(refresh),
      user_id: userId,
    };
  } catch (e) {
    out.auth = { error: e?.message };
  }

  let token = null;
  try {
    token = await getValidAccessToken();
    out.auth.access_token_preview = mask(token);
    out.auth.access_token_ok = true;
  } catch (e) {
    out.auth.access_token_ok = false;
    out.auth.access_token_error = e?.message;
    out.auth.upstream = e?.upstream;
    res.status(200).json(out);
    return;
  }

  const authHeader = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const browserish = {
    ...authHeader,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "es-AR,es;q=0.9",
    Origin: "https://www.mercadolibre.com.ar",
    Referer: "https://www.mercadolibre.com.ar/",
  };

  // Confirmar que el token funciona en endpoints simples
  out.probes.push(await probe("users/me", `${ML_BASE}/users/me`, authHeader));

  // Search variantes
  out.probes.push(await probe(
    "search:basic",
    `${ML_BASE}/sites/MLA/search?q=cruze&limit=1`,
    authHeader,
  ));

  out.probes.push(await probe(
    "search:no-q-no-category",
    `${ML_BASE}/sites/MLA/search?seller_id=${out.auth.user_id || "1088064370"}&limit=1`,
    authHeader,
  ));

  out.probes.push(await probe(
    "search:browserish",
    `${ML_BASE}/sites/MLA/search?q=cruze&category=MLA1744&limit=1`,
    browserish,
  ));

  // Search "por mí" (debería poder ver MIS items)
  if (out.auth.user_id) {
    out.probes.push(await probe(
      "users/{id}/items/search",
      `${ML_BASE}/users/${out.auth.user_id}/items/search?limit=1`,
      authHeader,
    ));
  }

  res.status(200).json(out);
}
