// Helper compartido por las Vercel Functions: maneja la autenticación
// con Mercado Libre usando OAuth 2.0 client_credentials, cachea el token
// en memoria del proceso (warm starts) y expone una función mlFetch()
// que mete el Authorization: Bearer en cada request.

export const ML_BASE = "https://api.mercadolibre.com";

// Cache simple en memoria de la function (sirve mientras el container está warm)
let cachedToken = null;
let cachedExpiresAt = 0; // epoch ms

export async function getMlAccessToken() {
  const clientId = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const err = new Error(
      "Faltan ML_CLIENT_ID y/o ML_CLIENT_SECRET en las Environment Variables de Vercel."
    );
    err.code = "missing_credentials";
    throw err;
  }

  const now = Date.now();
  if (cachedToken && now < cachedExpiresAt - 60_000) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(`${ML_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    const err = new Error(
      `OAuth con Mercado Libre falló (${res.status}): ${JSON.stringify(data)}`
    );
    err.status = res.status;
    err.upstream = data;
    throw err;
  }

  cachedToken = data.access_token;
  // expires_in viene en segundos; default 6 horas si no viene
  const ttlMs = ((data.expires_in ?? 21600) | 0) * 1000;
  cachedExpiresAt = now + ttlMs;

  return cachedToken;
}

export async function mlFetch(path, init = {}) {
  const token = await getMlAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "ml-cruze-finder/1.0 (+https://ml-cruze-finder.vercel.app)",
    ...(init.headers || {}),
  };
  return fetch(`${ML_BASE}${path}`, { ...init, headers });
}

export function sendUpstreamError(res, err) {
  const status =
    err?.code === "missing_credentials" ? 500 :
    err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
  res.status(status).json({
    error: err?.code || "upstream_error",
    message: err?.message || "Error desconocido al consultar Mercado Libre.",
    upstream: err?.upstream,
  });
}
