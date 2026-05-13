// Devuelve el estado de la conexión con Mercado Libre.
// Lo consume el frontend para mostrar "Conectado ✓" o "Conectar" en la topbar.
// No expone tokens en claro.

import { kvGet, isKvConfigured } from "../_kv.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const out = {
    kv_configured: isKvConfigured(),
    connected: false,
    user_id: null,
    access_expires_at: null,
    has_credentials: !!(process.env.ML_CLIENT_ID && process.env.ML_CLIENT_SECRET),
  };

  if (!out.kv_configured || !out.has_credentials) {
    res.status(200).json(out);
    return;
  }

  try {
    const refresh = await kvGet("ml:refresh_token").catch(() => null);
    const access = await kvGet("ml:access_token").catch(() => null);
    const expAt = await kvGet("ml:access_token_expires_at").catch(() => null);
    const userId = await kvGet("ml:user_id").catch(() => null);

    out.connected = !!refresh;
    out.user_id = userId;
    out.has_access_token = !!access;
    out.access_expires_at = expAt ? new Date(Number(expAt)).toISOString() : null;

    res.status(200).json(out);
  } catch (e) {
    res.status(200).json({ ...out, error: e?.message });
  }
}
