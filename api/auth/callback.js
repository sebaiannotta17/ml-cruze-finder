// Callback del flujo OAuth Authorization Code:
// Mercado Libre redirige acá con ?code=XXX. Lo cambiamos por access_token
// + refresh_token y guardamos todo en Vercel KV.

import { exchangeCodeForTokens, saveTokens, getRedirectUri } from "../_ml.js";
import { isKvConfigured } from "../_kv.js";

const htmlPage = ({ title, color, message, sub, action }) => `<!DOCTYPE html>
<html lang="es-AR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0; padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(180deg,#f6f7fb 0%,#e2e8f0 100%);
      color: #0f172a; min-height: 100vh;
      display: grid; place-items: center; padding: 24px;
    }
    .card {
      max-width: 480px; width: 100%;
      background: #fff; border-radius: 18px; padding: 32px;
      box-shadow: 0 20px 50px rgba(15,23,42,0.12);
      text-align: center;
    }
    h1 { color: ${color}; margin: 0 0 8px; font-size: 24px; }
    p { color: #475569; line-height: 1.5; margin: 6px 0; }
    .sub { color: #94a3b8; font-size: 13px; margin-top: 18px; }
    a.btn {
      display: inline-block; margin-top: 18px;
      background: #2563eb; color: #fff;
      padding: 12px 22px; border-radius: 10px;
      text-decoration: none; font-weight: 600;
      box-shadow: 0 6px 14px rgba(37,99,235,0.30);
    }
    a.btn.secondary { background: #fff; color: #2563eb; border: 1px solid #cbd5e1; box-shadow: none; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 6px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    ${action || ""}
    ${sub ? `<p class="sub">${sub}</p>` : ""}
  </div>
</body>
</html>`;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    const code = req.query?.code;
    const error = req.query?.error;
    const errorDesc = req.query?.error_description;

    if (error) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(400).send(htmlPage({
        title: "❌ Autorización cancelada",
        color: "#dc2626",
        message: `Mercado Libre devolvió un error: <code>${error}</code>`,
        sub: errorDesc ? String(errorDesc) : null,
        action: `<a class="btn" href="/api/auth/login">Reintentar</a> <a class="btn secondary" href="/">Volver</a>`,
      }));
      return;
    }

    if (!code) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(400).send(htmlPage({
        title: "Falta el code",
        color: "#dc2626",
        message: "Mercado Libre no devolvió el parámetro <code>code</code>. Iniciá el flujo desde <code>/api/auth/login</code>.",
        action: `<a class="btn" href="/api/auth/login">Iniciar autorización</a>`,
      }));
      return;
    }

    if (!isKvConfigured()) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(500).send(htmlPage({
        title: "⚠️ Falta Vercel KV",
        color: "#d97706",
        message: "Recibimos el código de autorización de Mercado Libre, pero no podemos guardarlo porque <strong>Vercel KV</strong> no está activado en este proyecto.",
        sub: "Andá a Vercel → Storage → Create Database → KV (Upstash Redis), linkealo al proyecto, redeployá y volvé a probar.",
        action: `<a class="btn" href="/">Volver</a>`,
      }));
      return;
    }

    const redirectUri = getRedirectUri(req);
    const data = await exchangeCodeForTokens(String(code), redirectUri);
    await saveTokens(data);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(htmlPage({
      title: "✅ ¡Conectado!",
      color: "#16a34a",
      message: `Tu app <strong>ml-cruze-finder</strong> ya tiene autorización para consultar la API de Mercado Libre.`,
      sub: `Usuario autorizado: <code>${data.user_id ?? "—"}</code> · Token válido por ${(data.expires_in / 3600).toFixed(0)} hs · Refresh válido por ~6 meses.`,
      action: `<a class="btn" href="/">Ir al buscador →</a>`,
    }));
  } catch (e) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(500).send(htmlPage({
      title: "Error procesando el callback",
      color: "#dc2626",
      message: `<code>${(e?.message || String(e)).slice(0, 400)}</code>`,
      action: `<a class="btn" href="/api/auth/login">Reintentar</a> <a class="btn secondary" href="/">Volver</a>`,
    }));
  }
}
