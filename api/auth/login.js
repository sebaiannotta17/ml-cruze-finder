// Inicio del flujo OAuth Authorization Code:
// Redirige al usuario a la página de autorización de Mercado Libre.
// Cuando el usuario autoriza, ML lo manda de vuelta a /api/auth/callback.

import { buildAuthorizationUrl, getRedirectUri } from "../_ml.js";

export default async function handler(req, res) {
  if (!process.env.ML_CLIENT_ID) {
    res.status(500).send("Falta ML_CLIENT_ID en las Environment Variables.");
    return;
  }

  const redirectUri = getRedirectUri(req);
  const url = buildAuthorizationUrl(redirectUri);

  // 302 redirect a la página de login/autorización de ML
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, url);
}
