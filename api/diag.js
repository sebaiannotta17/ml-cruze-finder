// Endpoint de diagnóstico TEMPORAL.
// Devuelve info útil para debuggear el flujo de OAuth + Search contra ML.
// IMPORTANTE: no expone secretos en claro (los recorta).
// Borrar este archivo cuando todo funcione.

import { ML_BASE, getMlAccessToken } from "./_ml.js";

function mask(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}...${s.slice(-3)} (len=${s.length})`;
}

export default async function handler(req, res) {
  const out = {
    step1_env: {
      ML_CLIENT_ID_present: !!process.env.ML_CLIENT_ID,
      ML_CLIENT_ID_preview: mask(process.env.ML_CLIENT_ID),
      ML_CLIENT_SECRET_present: !!process.env.ML_CLIENT_SECRET,
      ML_CLIENT_SECRET_preview: mask(process.env.ML_CLIENT_SECRET),
      VERCEL_REGION: process.env.VERCEL_REGION,
      NODE_VERSION: process.version,
    },
    step2_oauth: null,
    step3_search: null,
  };

  let token = null;
  try {
    token = await getMlAccessToken();
    out.step2_oauth = {
      ok: true,
      token_preview: mask(token),
    };
  } catch (e) {
    out.step2_oauth = {
      ok: false,
      error: e?.message,
      status: e?.status,
      upstream: e?.upstream,
    };
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(out);
    return;
  }

  try {
    const params = new URLSearchParams({
      q: "Chevrolet Cruze LTZ",
      category: "MLA1744",
      limit: "1",
      offset: "0",
      condition: "used",
      state: "TUxBUENBUGw3M2E1",
    });
    const r = await fetch(`${ML_BASE}/sites/MLA/search?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "ml-cruze-finder/1.0 (+diag)",
      },
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}

    out.step3_search = {
      status: r.status,
      ok: r.ok,
      headers: {
        "x-request-id": r.headers.get("x-request-id"),
        "content-type": r.headers.get("content-type"),
      },
      body: parsed ?? text.slice(0, 500),
      paging: parsed?.paging,
      results_count: Array.isArray(parsed?.results) ? parsed.results.length : null,
    };
  } catch (e) {
    out.step3_search = { ok: false, error: e?.message };
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(out);
}
