// Diag: prueba múltiples estrategias para bypassear el bloqueo de ML
// y traer datos públicos del listado.

const TARGETS = [
  // 1. URL de autos.mercadolibre.com.ar
  "https://autos.mercadolibre.com.ar/chevrolet-cruze/usados/capital-federal/_DisplayType_LF",
  // 2. URL de listado
  "https://listado.mercadolibre.com.ar/chevrolet-cruze-ltz",
  // 3. Mobile site
  "https://m.mercadolibre.com.ar/chevrolet-cruze-ltz",
  // 4. Frontend API (no documentada)
  "https://frontend.mercadolibre.com/sites/MLA/search?q=chevrolet+cruze&category=MLA1744&limit=1",
  // 5. API de search con header de site
  "https://api.mercadolibre.com/sites/MLA/search?q=chevrolet+cruze&limit=1",
];

const HEADER_SETS = {
  chrome_desktop: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "sec-ch-ua":
      '"Chromium";v="130", "Not?A_Brand";v="99", "Google Chrome";v="130"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    Referer: "https://www.google.com/",
  },
  iphone_safari: {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-AR,es;q=0.9",
  },
  googlebot: {
    "User-Agent":
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    Accept: "text/html,*/*;q=0.8",
  },
  curl: {
    "User-Agent": "curl/8.4.0",
    Accept: "*/*",
  },
  minimal: {},
};

async function probe(url, headerKey) {
  try {
    const r = await fetch(url, {
      headers: HEADER_SETS[headerKey],
      redirect: "follow",
    });
    const text = await r.text();
    const finalUrl = r.url;
    return {
      target: url.slice(0, 80),
      headers: headerKey,
      status: r.status,
      final_url: finalUrl.slice(0, 120),
      redirected_to_verification: /account-verification|captcha/i.test(finalUrl),
      length: text.length,
      has_preloaded: /window\.__PRELOADED_STATE__/.test(text),
      has_andes: /andes-card/.test(text),
      has_results: /ui-search-result|ui-search-results/.test(text),
      is_json: text.trim().startsWith("{") || text.trim().startsWith("["),
      preview: text.slice(0, 300),
    };
  } catch (e) {
    return { target: url, headers: headerKey, error: e?.message };
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const probes = [];
  for (const url of TARGETS) {
    for (const hk of Object.keys(HEADER_SETS)) {
      // Limitamos: para api.mercadolibre.com solo probamos un par
      if (url.includes("api.mercadolibre.com") && hk !== "chrome_desktop" && hk !== "minimal") continue;
      probes.push(await probe(url, hk));
    }
  }

  res.status(200).json({
    region: process.env.VERCEL_REGION,
    note: "Buscando combinaciones (url, headers) que NO redirigan a account-verification y devuelvan HTML con datos.",
    probes,
  });
}
