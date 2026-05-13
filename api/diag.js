// Diag: probar acceso a DeMotores.com.ar desde Vercel + inspección de HTML
// para identificar la estructura de datos (JSON embebido, patrones de items, etc.)

const TARGETS = [
  // Estructuras posibles de URL en DeMotores
  "https://www.demotores.com.ar/usados/chevrolet/cruze",
  "https://www.demotores.com.ar/usados/chevrolet/cruze/capital-federal",
  "https://www.demotores.com.ar/usados/chevrolet/cruze/buenos-aires",
  "https://www.demotores.com.ar/autos/usados/chevrolet/cruze",
  "https://www.demotores.com.ar/buscar?marca=chevrolet&modelo=cruze",
  // Sitemap o robots para descubrir estructura
  "https://www.demotores.com.ar/robots.txt",
  "https://www.demotores.com.ar/sitemap.xml",
];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
};

async function probe(url) {
  try {
    const r = await fetch(url, { headers: HEADERS, redirect: "follow" });
    const text = await r.text();
    const finalUrl = r.url;

    // Detectar señales de antibot
    const lowerHtml = text.slice(0, 3000).toLowerCase();
    const isBlocked =
      /captcha|cloudflare|access denied|forbidden|just a moment|attention required/i.test(
        text.slice(0, 5000)
      );

    return {
      target: url,
      status: r.status,
      final_url: finalUrl,
      redirected: finalUrl !== url,
      length: text.length,
      content_type: r.headers.get("content-type"),
      blocked_signs: isBlocked,
      has_next_data: /id=["']__NEXT_DATA__["']/.test(text),
      has_preloaded: /__PRELOADED_STATE__|__INITIAL_STATE__|__APP_INITIAL_STATE__/.test(text),
      has_json_ld: /<script[^>]+type=["']application\/ld\+json["']/.test(text),
      has_anuncio: /\bclassi?fied|anuncio|listing|publicacion|aviso/i.test(lowerHtml),
      has_price_tag: /\$\s*\d|precio|USD\s*\d|ARS\s*\d/.test(lowerHtml),
      first_2000: text.slice(0, 2000),
    };
  } catch (e) {
    return { target: url, error: e?.message };
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const probes = [];
  for (const u of TARGETS) probes.push(await probe(u));
  res.status(200).json({
    region: process.env.VERCEL_REGION,
    note: "Buscamos: URL que devuelva HTML/JSON con listings (no captcha/redirect a página de bot)",
    probes,
  });
}
