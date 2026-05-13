// /api/search — Scraping del listado público de Mercado Libre.
//
// ML cerró el endpoint oficial /sites/MLA/search para apps externas,
// devolviendo 403 incluso con OAuth (user token). Como workaround,
// hacemos fetch al HTML público de listado.mercadolibre.com.ar (la
// misma página que ve un visitante) y extraemos los items del JSON
// embebido (__PRELOADED_STATE__) o caemos a parsing por regex.
//
// Devuelve el JSON en el MISMO formato que esperaba app.js cuando
// usábamos la API oficial: { results: [...], paging: {...} }.

const STATE_NAME = {
  TUxBUENBUGw3M2E1: "Capital Federal",
  TUxBUEdSQWU4ZDkz: "Bs.As. G.B.A. Norte",
  TUxBUEdSQWVmNTVm: "Bs.As. G.B.A. Oeste",
  TUxBUEdSQXJlMDNm: "Bs.As. G.B.A. Sur",
};

// state_id -> slug que usa la URL de listado de ML
const STATE_SLUG = {
  TUxBUENBUGw3M2E1: "capital-federal",
  TUxBUEdSQWU4ZDkz: "buenos-aires-gba-norte",
  TUxBUEdSQWVmNTVm: "buenos-aires-gba-oeste",
  TUxBUEdSQXJlMDNm: "buenos-aires-gba-sur",
};

function slugify(q) {
  return String(q || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildListUrl({ q, state, offset = 0 }) {
  const slug = slugify(q) || "chevrolet-cruze";
  const stateSlug = STATE_SLUG[state] || null;

  // Path: https://autos.mercadolibre.com.ar/chevrolet/cruze/usados/<state>/<q>_DisplayType_LF
  // Como las URLs de autos.mercadolibre.com.ar pueden cambiar, usamos
  // la ruta más estable: listado.mercadolibre.com.ar/<slug> con filtros.
  let url = `https://autos.mercadolibre.com.ar/${slug}/usados/`;
  if (stateSlug) url += `${stateSlug}/`;
  url += "_DisplayType_LF";
  if (offset && Number(offset) > 0) {
    url += `_Desde_${Number(offset) + 1}`;
  }
  return url;
}

function buildListUrlFallback({ q, state, offset = 0 }) {
  // Fallback: dominio "listado" genérico
  const slug = slugify(q) || "chevrolet-cruze";
  let url = `https://listado.mercadolibre.com.ar/${slug}#D[A:${encodeURIComponent(q)}]`;
  if (state) {
    url = `https://listado.mercadolibre.com.ar/${slug}_NoIndex_True_state_${state}`;
  }
  if (offset && Number(offset) > 0) {
    url += `_Desde_${Number(offset) + 1}`;
  }
  return url;
}

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
    },
    redirect: "follow",
  });
  return { status: r.status, url: r.url, html: await r.text() };
}

// Extrae el JSON de window.__PRELOADED_STATE__ embebido en el HTML.
function extractPreloadedState(html) {
  const patterns = [
    /window\.__PRELOADED_STATE__\s*=\s*JSON\.parse\((['"])(.+?)\1\s*\)\s*;/s,
    /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]+?\})\s*;/s,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    try {
      // Cuando viene como JSON.parse("..."), hay que decodificar el string
      if (m[2] !== undefined) {
        // m[2] es una cadena con escapes JS. Hacemos doble parse:
        const unescaped = JSON.parse(`"${m[2].replace(/"/g, '\\"')}"`);
        return JSON.parse(unescaped);
      }
      return JSON.parse(m[1] ?? m[2]);
    } catch {}
  }
  return null;
}

// Algunos listados también tienen __NEXT_DATA__
function extractNextData(html) {
  const m = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]+?)<\/script>/
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Camina recursivamente un objeto buscando un array de "results" que parezca lista de items.
function findResultsArray(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) return null;
  if (typeof node !== "object") return null;
  if (Array.isArray(node.results) && node.results.length && (node.results[0]?.id || node.results[0]?.title)) {
    return node.results;
  }
  for (const k of Object.keys(node)) {
    const found = findResultsArray(node[k], depth + 1);
    if (found) return found;
  }
  return null;
}

// Normaliza un item al formato que esperaba el frontend (compatible con la API oficial).
function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = raw.id || raw.item_id || raw.itemId;
  if (!id) return null;

  // Precio
  const price =
    raw.price?.amount ?? raw.price ?? raw.value?.amount ?? null;
  const currency =
    raw.price?.currency_id ??
    raw.price?.currency ??
    raw.currency_id ??
    raw.value?.currency_id ??
    "ARS";

  // Imagen
  const pictures = raw.pictures || [];
  const thumbnail =
    raw.thumbnail ||
    pictures[0]?.url ||
    pictures[0]?.src ||
    raw.image ||
    raw.picture ||
    null;

  // Atributos
  const attrs = [];
  function pushAttr(idVal, valVal) {
    if (valVal == null || valVal === "") return;
    attrs.push({ id: idVal, value_name: String(valVal) });
  }
  pushAttr("VEHICLE_YEAR", raw.year || raw.vehicle_year || raw.attributes_label?.year);
  pushAttr("KILOMETERS", raw.km || raw.kilometers || raw.attributes_label?.km || raw.attributes_label?.kms);
  pushAttr("TRANSMISSION", raw.transmission || raw.attributes_label?.transmission);
  pushAttr("FUEL_TYPE", raw.fuel || raw.fuel_type);

  // Si hay attributes/_label estructurado, también lo barremos
  if (Array.isArray(raw.attributes)) {
    for (const a of raw.attributes) {
      if (a?.id && (a?.value_name || a?.value)) attrs.push(a);
    }
  }

  // Ubicación
  const location = raw.location || raw.address || {};
  const stateName = location.state?.name || location.state_name || raw.state_name;
  const cityName = location.city?.name || location.city_name || raw.city_name;

  return {
    id: String(id),
    title: raw.title || raw.name || "",
    price: typeof price === "number" ? price : Number(price) || null,
    currency_id: currency,
    thumbnail: thumbnail || "",
    permalink: raw.permalink || raw.url || raw.link || `https://articulo.mercadolibre.com.ar/${id}`,
    condition: raw.condition || "used",
    attributes: attrs,
    address: {
      state_name: stateName || null,
      city_name: cityName || null,
    },
  };
}

export default async function handler(req, res) {
  try {
    const { q = "Chevrolet Cruze", state = "", offset = "0", limit = "50" } = req.query || {};

    // Intentamos hasta 2 URLs (principal + fallback)
    const candidates = [
      buildListUrl({ q, state, offset }),
      buildListUrlFallback({ q, state, offset }),
    ];

    let last = null;
    let items = [];
    let usedUrl = null;

    for (const url of candidates) {
      const f = await fetchHtml(url);
      last = f;
      if (f.status >= 400 || !f.html || f.html.length < 1000) continue;

      const preloaded = extractPreloadedState(f.html) || extractNextData(f.html);
      const arr = preloaded ? findResultsArray(preloaded) : null;
      if (arr && arr.length) {
        items = arr.map(normalizeItem).filter(Boolean);
        usedUrl = f.url;
        break;
      }
    }

    if (!items.length && last) {
      return res.status(502).json({
        error: "scrape_no_results",
        message: "No se pudo extraer items del HTML del listado público.",
        upstream_status: last.status,
        upstream_url: last.url,
        html_length: last.html?.length,
      });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({
      site_id: "MLA",
      query: String(q),
      source: "scrape",
      upstream_url: usedUrl,
      paging: { total: items.length, offset: Number(offset), limit: Number(limit) },
      results: items.slice(0, Number(limit)),
    });
  } catch (err) {
    res.status(502).json({
      error: "scrape_failed",
      message: err?.message || "Error al hacer scraping del listado.",
    });
  }
}
