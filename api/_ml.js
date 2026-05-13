// Helper compartido: maneja la autenticación con Mercado Libre usando el
// flujo OAuth Authorization Code (con un usuario real autorizando la app).
//
// Persiste el refresh_token en Vercel KV (ver api/_kv.js). Cachea el
// access_token en memoria del proceso (warm starts) y en KV (cold starts)
// para minimizar refresh requests.

import { kvGet, kvSet, isKvConfigured } from "./_kv.js";

export const ML_BASE = "https://api.mercadolibre.com";
export const ML_AUTH_BASE = "https://auth.mercadolibre.com.ar";

const KEY_REFRESH = "ml:refresh_token";
const KEY_ACCESS = "ml:access_token";
const KEY_ACCESS_EXP = "ml:access_token_expires_at";
const KEY_USER_ID = "ml:user_id";

// Cache en memoria del proceso (sirve para warm starts del container).
let memToken = null;
let memExpiresAt = 0;

// Reconstruye la redirect_uri exacta desde el request. Tiene que coincidir
// 1:1 con la que registramos en developers.mercadolibre.com.ar.
export function getRedirectUri(req) {
  if (process.env.ML_REDIRECT_URI) return process.env.ML_REDIRECT_URI;
  const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host || "ml-cruze-finder.vercel.app";
  const proto = (req?.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim();
  return `${proto}://${host}/api/auth/callback`;
}

// === Authorization Code flow ===

export function buildAuthorizationUrl(redirectUri, state = "") {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.ML_CLIENT_ID || "",
    redirect_uri: redirectUri,
  });
  if (state) params.set("state", state);
  return `${ML_AUTH_BASE}/authorization?${params.toString()}`;
}

export async function exchangeCodeForTokens(code, redirectUri) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: process.env.ML_CLIENT_ID || "",
    client_secret: process.env.ML_CLIENT_SECRET || "",
    code,
    redirect_uri: redirectUri,
  });
  const r = await fetch(`${ML_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    const err = new Error(
      `Exchange code failed (${r.status}): ${JSON.stringify(data)}`
    );
    err.upstream = data;
    err.status = r.status;
    throw err;
  }
  return data;
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.ML_CLIENT_ID || "",
    client_secret: process.env.ML_CLIENT_SECRET || "",
    refresh_token: refreshToken,
  });
  const r = await fetch(`${ML_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    const err = new Error(
      `Refresh token failed (${r.status}): ${JSON.stringify(data)}`
    );
    err.upstream = data;
    err.status = r.status;
    throw err;
  }
  return data;
}

export async function saveTokens(data) {
  const now = Date.now();
  const ttlSec = data.expires_in ?? 21600;
  const expiresAt = now + ttlSec * 1000;

  await kvSet(KEY_ACCESS, data.access_token);
  await kvSet(KEY_ACCESS_EXP, String(expiresAt));
  if (data.refresh_token) await kvSet(KEY_REFRESH, data.refresh_token);
  if (data.user_id != null) await kvSet(KEY_USER_ID, String(data.user_id));

  memToken = data.access_token;
  memExpiresAt = expiresAt;
}

// Devuelve un access_token válido. Refresca contra ML si hace falta.
export async function getValidAccessToken() {
  const now = Date.now();

  // 1) memory cache
  if (memToken && now < memExpiresAt - 60_000) return memToken;

  // 2) KV cache
  if (isKvConfigured()) {
    const cached = await kvGet(KEY_ACCESS).catch(() => null);
    const cachedExp = await kvGet(KEY_ACCESS_EXP).catch(() => null);
    if (cached && cachedExp && now < Number(cachedExp) - 60_000) {
      memToken = cached;
      memExpiresAt = Number(cachedExp);
      return cached;
    }
  }

  // 3) refresh
  const refresh = isKvConfigured() ? await kvGet(KEY_REFRESH).catch(() => null) : null;
  if (!refresh) {
    const err = new Error(
      "La app aún no está autorizada con Mercado Libre. Visitá /api/auth/login para autorizar."
    );
    err.code = "no_token";
    throw err;
  }

  const data = await refreshAccessToken(refresh);
  await saveTokens(data);
  return data.access_token;
}

export async function mlFetch(path, init = {}) {
  const token = await getValidAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "ml-cruze-finder/1.0 (+https://ml-cruze-finder.vercel.app)",
    ...(init.headers || {}),
  };
  return fetch(`${ML_BASE}${path}`, { ...init, headers });
}

export function sendUpstreamError(res, err) {
  if (err?.code === "no_token") {
    res.status(401).json({
      error: "no_token",
      message: err.message,
      action_url: "/api/auth/login",
    });
    return;
  }
  if (err?.code === "kv_not_configured") {
    res.status(500).json({
      error: "kv_not_configured",
      message: err.message,
    });
    return;
  }
  const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
  res.status(status).json({
    error: err?.code || "upstream_error",
    message: err?.message || "Error desconocido al consultar Mercado Libre.",
    upstream: err?.upstream,
  });
}
