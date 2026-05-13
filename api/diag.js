// Endpoint de diagnóstico — verifica scraping del listado público de ML.
// Borrar cuando todo funcione.

const TEST_URLS = [
  "https://autos.mercadolibre.com.ar/chevrolet-cruze/usados/capital-federal/_DisplayType_LF",
  "https://autos.mercadolibre.com.ar/chevrolet/cruze/usados/_DisplayType_LF",
  "https://listado.mercadolibre.com.ar/chevrolet-cruze-ltz_NoIndex_True",
  "https://autos.mercadolibre.com.ar/_DisplayType_LF",
];

async function probe(url) {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "es-AR,es;q=0.9",
      },
      redirect: "follow",
    });
    const html = await r.text();
    return {
      url,
      final_url: r.url,
      status: r.status,
      html_length: html.length,
      has_preloaded_state: /window\.__PRELOADED_STATE__/.test(html),
      has_next_data: /id=["']__NEXT_DATA__["']/.test(html),
      has_andes_card: /class=["'][^"']*andes-card/.test(html),
      has_results_html: /ui-search-results__|ui-search-result__/.test(html),
      first_1000: html.slice(0, 1000),
    };
  } catch (e) {
    return { url, error: e?.message };
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const probes = [];
  for (const u of TEST_URLS) {
    probes.push(await probe(u));
  }

  res.status(200).json({
    region: process.env.VERCEL_REGION,
    probes,
  });
}
