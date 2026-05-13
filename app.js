/* ============================================================
 *  Cruze LTZ Finder
 *  Buscador en vivo de Chevrolet Cruze LTZ Plus y variantes en
 *  Buenos Aires, consumiendo la API pública de Mercado Libre.
 * ============================================================ */

// En vez de pegarle directo a https://api.mercadolibre.com (que actualmente
// responde 403 a requests cross-origin desde el navegador), usamos los
// proxies serverless en /api/* que viven en este mismo deploy de Vercel.
// Ver: api/search.js y api/description.js
const PROXY_SEARCH = "/api/search";
const PROXY_DESCRIPTION = "/api/description";
const SITE = "MLA"; // Mercado Libre Argentina
const CATEGORY_AUTOS = "MLA1744"; // Autos, Camionetas y Utilitarios

// IDs reales de estados de ML Argentina, verificados desde
// https://api.mercadolibre.com/classified_locations/countries/AR
// Mercado Libre clasifica los items con IDs granulares (no usa una
// sola "Provincia de Buenos Aires"), por eso para GBA hay 3 IDs.
const STATE_IDS = {
  capital_federal: "TUxBUENBUGw3M2E1", // CABA
  gba_norte:       "TUxBUEdSQWU4ZDkz",
  gba_oeste:       "TUxBUEdSQWVmNTVm",
  gba_sur:         "TUxBUEdSQXJlMDNm",
  bsas_costa:      "TUxBUENPU2ExMmFkMw",
  bsas_interior:   "TUxBUFpPTmFpbnRl",
};

// Variantes objetivo. Cada una con un patrón regex para matching por título
// y un patrón opcional de exclusión para evitar falsos positivos.
const VARIANTS = [
  {
    id: "ltz_plus",
    label: "LTZ Plus",
    badge: "gold",
    match: /\bLTZ\s*(\+|PLUS)\b/i,
  },
  {
    id: "premier",
    label: "Premier",
    badge: "green",
    match: /\bPREMIER\b/i,
  },
  {
    id: "ltz_turbo",
    label: "1.4 Turbo LTZ",
    badge: null,
    match: /1[\.,]?4\s*TURBO\s*LTZ/i,
  },
  {
    id: "ltz",
    label: "LTZ",
    badge: null,
    match: /\bLTZ\b/i,
    exclude: /(\bLTZ\s*(\+|PLUS)\b|\bPREMIER\b|1[\.,]?4\s*TURBO\s*LTZ)/i,
  },
];

// Queries de búsqueda. Hacemos 2 búsquedas separadas y las
// fusionamos para asegurarnos de capturar tanto LTZ como Premier.
const SEARCH_QUERIES = [
  "Chevrolet Cruze LTZ",
  "Chevrolet Cruze Premier",
];

// ------------------------------------------------------------
// Estado global
// ------------------------------------------------------------
const state = {
  rawItems: new Map(), // id -> item
  filteredItems: [],
  totalApi: 0,
  offset: 0,
  loading: false,
  filters: {
    text: "",
    variants: new Set(VARIANTS.map((v) => v.id)),
    region: "caba", // 'caba' | 'bsas' | 'ambas'
    yearMin: null,
    yearMax: null,
    priceMin: null,
    priceMax: null,
    kmMax: null,
    sort: "relevance",
  },
};

// ------------------------------------------------------------
// Utils
// ------------------------------------------------------------
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

const fmtMoney = (value, currency = "USD") => {
  if (value == null || isNaN(value)) return "—";
  try {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${Math.round(value).toLocaleString("es-AR")}`;
  }
};

const fmtKm = (km) => {
  if (km == null || isNaN(km)) return "—";
  return `${Number(km).toLocaleString("es-AR")} km`;
};

const escapeHtml = (str = "") =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

// Mejorar la calidad de la imagen del thumbnail (-I -> -O da el original)
const upgradeImg = (url) => {
  if (!url) return "";
  return url.replace(/-I\.(jpg|jpeg|webp|png)/i, "-O.$1").replace(/^http:/, "https:");
};

// ------------------------------------------------------------
// Acceso a atributos de items de ML
// ------------------------------------------------------------
const getAttr = (item, ...ids) => {
  if (!item?.attributes) return null;
  for (const id of ids) {
    const a = item.attributes.find((x) => x.id === id);
    if (a) return a.value_name ?? (a.values && a.values[0]?.name) ?? null;
  }
  return null;
};

const getAttrNumber = (item, ...ids) => {
  const v = getAttr(item, ...ids);
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
  return isNaN(n) ? null : n;
};

const getYear = (item) => getAttrNumber(item, "VEHICLE_YEAR", "MANUFACTURING_YEAR");
const getKm = (item) => getAttrNumber(item, "KILOMETERS");
const getTransmission = (item) => getAttr(item, "TRANSMISSION");
const getFuel = (item) => getAttr(item, "FUEL_TYPE");
const getVersion = (item) => getAttr(item, "VERSION", "TRIM");

const getLocationText = (item) => {
  const a = item.address || item.location || {};
  const city = a.city_name || a.city?.name || "";
  const state = a.state_name || a.state?.name || "";
  return [city, state].filter(Boolean).join(", ") || "—";
};

const getStateName = (item) => {
  const a = item.address || item.location || {};
  return a.state_name || a.state?.name || "";
};

// ------------------------------------------------------------
// Identificar variante por título
// ------------------------------------------------------------
const identifyVariant = (title) => {
  if (!title) return null;
  for (const v of VARIANTS) {
    if (v.exclude && v.exclude.test(title)) continue;
    if (v.match.test(title)) return v;
  }
  return null;
};

// ------------------------------------------------------------
// API: Fetch search
// ------------------------------------------------------------
async function searchOnce(query, { stateId, offset = 0, limit = 50 } = {}) {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    offset: String(offset),
    condition: "used",
  });
  if (stateId) params.set("state", stateId);

  const url = `${PROXY_SEARCH}?${params}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Mercado Libre respondió ${res.status} para "${query}"`);
  }
  return res.json();
}

async function fetchDescription(itemId) {
  try {
    const res = await fetch(`${PROXY_DESCRIPTION}?id=${encodeURIComponent(itemId)}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.plain_text || data.text || "").trim() || null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Carga: ejecuta múltiples búsquedas y fusiona los resultados
// ------------------------------------------------------------
async function runSearch({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  showLoading(true);
  showError(null);

  if (!append) {
    state.rawItems.clear();
    state.offset = 0;
  }

  try {
    const stateIds = regionToStateIds(state.filters.region);

    // Para cada combinación (query x state) hacemos una búsqueda en paralelo.
    const tasks = [];
    for (const q of SEARCH_QUERIES) {
      if (stateIds.length === 0) {
        tasks.push(searchOnce(q, { offset: state.offset }));
      } else {
        for (const sid of stateIds) {
          tasks.push(searchOnce(q, { stateId: sid, offset: state.offset }));
        }
      }
    }

    const results = await Promise.allSettled(tasks);

    let totalApi = 0;
    let okResults = 0;
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      okResults++;
      totalApi += r.value?.paging?.total ?? 0;
      for (const it of r.value.results || []) {
        if (!state.rawItems.has(it.id)) state.rawItems.set(it.id, it);
      }
    }

    if (okResults === 0) {
      throw new Error("No se pudo conectar con la API de Mercado Libre.");
    }

    state.totalApi = totalApi;
    state.offset += 50;

    applyFiltersAndRender();
    // Cargar descripciones breves para los items visibles, en background.
    enrichVisibleDescriptions();
  } catch (err) {
    console.error(err);
    showError(err.message || "Error inesperado al consultar Mercado Libre.");
  } finally {
    state.loading = false;
    showLoading(false);
    updateLastUpdate();
  }
}

function regionToStateIds(region) {
  const GBA = [STATE_IDS.gba_norte, STATE_IDS.gba_oeste, STATE_IDS.gba_sur];
  switch (region) {
    case "caba":
      return [STATE_IDS.capital_federal];
    case "bsas":
      // Provincia: GBA Norte/Oeste/Sur (cubre la gran mayoría de
      // publicaciones de "Buenos Aires" sin saturar de pedidos).
      return GBA;
    case "ambas":
      return [STATE_IDS.capital_federal, ...GBA];
    default:
      return [];
  }
}

// ------------------------------------------------------------
// Filtros + orden
// ------------------------------------------------------------
function applyFiltersAndRender() {
  const f = state.filters;
  let items = Array.from(state.rawItems.values());

  // Filtro: variantes (por matching del título)
  items = items.filter((it) => {
    const variant = identifyVariant(it.title || "");
    if (!variant) return false; // descartar si no matchea ninguna variante objetivo
    return f.variants.has(variant.id);
  });

  // Filtro: región (verificación client-side por si la API trae algo extra).
  // Los state_name reales que usa ML son del estilo:
  //   "Capital Federal", "Bs.As. G.B.A. Norte", "Bs.As. G.B.A. Oeste",
  //   "Bs.As. G.B.A. Sur", "Bs.As. Costa Atlántica", "Buenos Aires Interior".
  const isCaba = (sn) => sn === "Capital Federal";
  const isBsAs = (sn) => sn && (sn.startsWith("Bs.As.") || sn.startsWith("Buenos Aires"));
  items = items.filter((it) => {
    const sn = getStateName(it);
    if (!sn) return true; // si no viene info, lo dejamos pasar
    if (f.region === "caba") return isCaba(sn);
    if (f.region === "bsas") return isBsAs(sn);
    return isCaba(sn) || isBsAs(sn); // "ambas"
  });

  // Filtro: texto libre
  if (f.text.trim()) {
    const t = f.text.toLowerCase();
    items = items.filter((it) =>
      (it.title || "").toLowerCase().includes(t) ||
      (it._description || "").toLowerCase().includes(t)
    );
  }

  // Filtros: año, precio, km
  items = items.filter((it) => {
    const year = getYear(it);
    const km = getKm(it);
    const price = it.price;

    if (f.yearMin && year && year < f.yearMin) return false;
    if (f.yearMax && year && year > f.yearMax) return false;
    if (f.priceMin && price < f.priceMin) return false;
    if (f.priceMax && price > f.priceMax) return false;
    if (f.kmMax && km && km > f.kmMax) return false;
    return true;
  });

  // Orden
  switch (f.sort) {
    case "price_asc":
      items.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
      break;
    case "price_desc":
      items.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
      break;
    case "year_desc":
      items.sort((a, b) => (getYear(b) ?? 0) - (getYear(a) ?? 0));
      break;
    case "year_asc":
      items.sort((a, b) => (getYear(a) ?? Infinity) - (getYear(b) ?? Infinity));
      break;
    case "km_asc":
      items.sort((a, b) => (getKm(a) ?? Infinity) - (getKm(b) ?? Infinity));
      break;
    default:
      // relevance: dejar el orden devuelto por ML
      break;
  }

  state.filteredItems = items;
  renderResults();
  renderStats();
}

// ------------------------------------------------------------
// Render
// ------------------------------------------------------------
function renderStats() {
  const items = state.filteredItems;
  $("#statCount").textContent = items.length.toString();
  if (!items.length) {
    $("#statAvg").textContent = "—";
    $("#statMin").textContent = "—";
    $("#statMax").textContent = "—";
    return;
  }
  // Trabajar con USD (mayoría de autos en USD); convertimos ARS a USD nominal NO,
  // mejor mostrar mezcla: separar por currency. Para simpleza tomamos USD.
  const usd = items.filter((i) => i.currency_id === "USD" && i.price);
  const ars = items.filter((i) => i.currency_id === "ARS" && i.price);
  const sample = usd.length >= ars.length ? usd : ars;
  const cur = usd.length >= ars.length ? "USD" : "ARS";
  if (!sample.length) {
    $("#statAvg").textContent = "—";
    $("#statMin").textContent = "—";
    $("#statMax").textContent = "—";
    return;
  }
  const prices = sample.map((i) => i.price);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  $("#statAvg").textContent = fmtMoney(avg, cur);
  $("#statMin").textContent = fmtMoney(Math.min(...prices), cur);
  $("#statMax").textContent = fmtMoney(Math.max(...prices), cur);
}

function renderResults() {
  const grid = $("#cards");
  grid.innerHTML = "";

  $("#emptyBox").hidden = state.filteredItems.length !== 0;
  $("#loadMoreBtn").hidden = state.filteredItems.length < 8;

  const frag = document.createDocumentFragment();
  for (const item of state.filteredItems) {
    frag.appendChild(buildCard(item));
  }
  grid.appendChild(frag);
}

function buildCard(item) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.id = item.id;

  const variant = identifyVariant(item.title || "");
  const year = getYear(item);
  const km = getKm(item);
  const trans = getTransmission(item);
  const img = upgradeImg(item.thumbnail || item.secure_thumbnail || "");
  const desc = item._description || null;

  const badgeHtml = variant
    ? `<span class="badge ${variant.badge || ""}">${escapeHtml(variant.label)}</span>`
    : "";

  card.innerHTML = `
    <div class="card-image">
      ${badgeHtml}
      <img loading="lazy" alt="${escapeHtml(item.title)}" src="${escapeHtml(img)}"
           onerror="this.style.background='#e2e8f0';this.removeAttribute('src');" />
    </div>
    <div class="card-body">
      <div class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
      <div class="card-price">
        ${fmtMoney(item.price, item.currency_id || "USD")}
        ${item.original_price && item.original_price > item.price
          ? `<small style="text-decoration:line-through; color:#94a3b8; margin-left:6px;">${fmtMoney(item.original_price, item.currency_id || "USD")}</small>`
          : ""}
      </div>
      <div class="card-attrs">
        ${year ? `<span class="attr year">${year}</span>` : ""}
        ${km != null ? `<span class="attr km">${fmtKm(km)}</span>` : ""}
        ${trans ? `<span class="attr trans">${escapeHtml(trans)}</span>` : ""}
      </div>
      <div class="card-location" title="Ubicación">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/>
          <circle cx="12" cy="10" r="3"/>
        </svg>
        ${escapeHtml(getLocationText(item))}
      </div>
      <div class="card-desc ${desc ? "" : "placeholder"}" data-desc>
        ${desc ? escapeHtml(desc.slice(0, 200)) + (desc.length > 200 ? "…" : "") : "Cargando descripción…"}
      </div>
      <div class="card-footer">
        <span class="small">ID: ${escapeHtml(item.id)}</span>
        <span class="ml-link">Ver detalles →</span>
      </div>
    </div>
  `;

  card.addEventListener("click", () => openModal(item));
  return card;
}

// ------------------------------------------------------------
// Descripciones (lazy / batched)
// ------------------------------------------------------------
async function enrichVisibleDescriptions() {
  const items = state.filteredItems.slice(0, 30); // primeras 30 visibles
  const concurrency = 5;
  let idx = 0;
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const it = items[i];
      if (it._description !== undefined) continue;
      const text = await fetchDescription(it.id);
      it._description = text || "";
      updateCardDescription(it);
    }
  }
}

function updateCardDescription(item) {
  const card = document.querySelector(`.card[data-id="${CSS.escape(item.id)}"]`);
  if (!card) return;
  const el = card.querySelector("[data-desc]");
  if (!el) return;
  if (!item._description) {
    el.textContent = "Sin descripción cargada por el vendedor.";
    el.classList.add("placeholder");
  } else {
    const t = item._description.replace(/\s+/g, " ").trim();
    el.textContent = t.slice(0, 200) + (t.length > 200 ? "…" : "");
    el.classList.remove("placeholder");
  }
}

// ------------------------------------------------------------
// Modal de detalle
// ------------------------------------------------------------
function openModal(item) {
  const modal = $("#modal");
  const body = $("#modalBody");
  const year = getYear(item);
  const km = getKm(item);
  const trans = getTransmission(item);
  const fuel = getFuel(item);
  const version = getVersion(item);
  const img = upgradeImg(item.thumbnail || item.secure_thumbnail || "");

  body.innerHTML = `
    <div class="modal-hero">
      <img alt="${escapeHtml(item.title)}" src="${escapeHtml(img)}" />
    </div>
    <div class="modal-content">
      <h3 id="modalTitle">${escapeHtml(item.title)}</h3>
      <div class="modal-price">${fmtMoney(item.price, item.currency_id || "USD")}</div>
      <div class="modal-attrs">
        ${attrRow("Año", year ?? "—")}
        ${attrRow("Kilometraje", km != null ? fmtKm(km) : "—")}
        ${attrRow("Versión", version ?? "—")}
        ${attrRow("Transmisión", trans ?? "—")}
        ${attrRow("Combustible", fuel ?? "—")}
        ${attrRow("Ubicación", getLocationText(item))}
      </div>
      <div>
        <strong>Descripción del vendedor</strong>
        <div class="modal-desc" id="modalDesc">${
          item._description !== undefined
            ? (item._description ? escapeHtml(item._description) : "Sin descripción cargada por el vendedor.")
            : "Cargando descripción…"
        }</div>
      </div>
      <div class="modal-actions">
        <a class="btn btn-primary" href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener">
          Abrir publicación en Mercado Libre
        </a>
        <button class="btn btn-secondary" data-close type="button">Cerrar</button>
      </div>
    </div>
  `;

  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  // Si aún no tenemos la descripción cargada, traerla ahora
  if (item._description === undefined) {
    fetchDescription(item.id).then((text) => {
      item._description = text || "";
      const el = $("#modalDesc");
      if (el) el.textContent = item._description || "Sin descripción cargada por el vendedor.";
    });
  }
}

function attrRow(k, v) {
  return `<div class="modal-attr-row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></div>`;
}

function closeModal() {
  const modal = $("#modal");
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

// ------------------------------------------------------------
// UI helpers
// ------------------------------------------------------------
function showLoading(on) {
  $("#loading").hidden = !on;
}
function showError(msg) {
  const box = $("#errorBox");
  if (!msg) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.textContent = msg;
}
function updateLastUpdate() {
  const now = new Date();
  const t = now.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  $("#lastUpdate").textContent = `Actualizado: ${t}`;
}

// ------------------------------------------------------------
// Render variant chips
// ------------------------------------------------------------
function renderVariantChips() {
  const wrap = $("#variantChips");
  wrap.innerHTML = "";
  for (const v of VARIANTS) {
    const id = `chip-${v.id}`;
    const label = document.createElement("label");
    label.className = "chip" + (state.filters.variants.has(v.id) ? " active" : "");
    label.innerHTML = `
      <input id="${id}" type="checkbox" ${state.filters.variants.has(v.id) ? "checked" : ""} />
      ${escapeHtml(v.label)}
    `;
    label.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) state.filters.variants.add(v.id);
      else state.filters.variants.delete(v.id);
      label.classList.toggle("active", e.target.checked);
      applyFiltersAndRender();
    });
    wrap.appendChild(label);
  }
}

// ------------------------------------------------------------
// Lectura de filtros desde el formulario
// ------------------------------------------------------------
function readFiltersFromUI() {
  const f = state.filters;
  f.text = $("#searchInput").value.trim();
  f.region = (document.querySelector('input[name="state"]:checked')?.value) || "caba";
  f.yearMin = numOrNull($("#yearMin").value);
  f.yearMax = numOrNull($("#yearMax").value);
  f.priceMin = numOrNull($("#priceMin").value);
  f.priceMax = numOrNull($("#priceMax").value);
  f.kmMax = numOrNull($("#kmMax").value);
  f.sort = $("#sortSelect").value || "relevance";
}
function numOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function resetFilters() {
  $("#searchInput").value = "";
  $("#yearMin").value = "";
  $("#yearMax").value = "";
  $("#priceMin").value = "";
  $("#priceMax").value = "";
  $("#kmMax").value = "";
  $("#sortSelect").value = "relevance";
  document.querySelector('input[name="state"][value="caba"]').checked = true;
  state.filters.variants = new Set(VARIANTS.map((v) => v.id));
  renderVariantChips();
  readFiltersFromUI();
  applyFiltersAndRender();
}

// ------------------------------------------------------------
// Wire-up
// ------------------------------------------------------------
function init() {
  renderVariantChips();

  $("#applyFilters").addEventListener("click", () => {
    readFiltersFromUI();
    // Si cambió la región, hay que recargar contra la API (el state filter cambia).
    runSearch({ append: false });
  });
  $("#resetFilters").addEventListener("click", () => {
    resetFilters();
    runSearch({ append: false });
  });
  $("#refreshBtn").addEventListener("click", () => runSearch({ append: false }));
  $("#loadMoreBtn").addEventListener("click", () => runSearch({ append: true }));
  $("#searchInput").addEventListener("input", () => {
    state.filters.text = $("#searchInput").value.trim();
    applyFiltersAndRender();
  });
  $("#sortSelect").addEventListener("change", () => {
    state.filters.sort = $("#sortSelect").value;
    applyFiltersAndRender();
  });

  // Modal
  $("#modal").addEventListener("click", (e) => {
    if (e.target.matches("[data-close]")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  // Cargar al inicio
  readFiltersFromUI();
  runSearch({ append: false });
}

document.addEventListener("DOMContentLoaded", init);
