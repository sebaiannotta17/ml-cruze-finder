/* ============================================================
 *  Cruze LTZ Tracker — Frontend
 *  Gestor manual de publicaciones de autos (Mercado Libre +
 *  Facebook Marketplace) guardadas en Vercel KV.
 * ============================================================ */

const API = {
  listings: "/api/listings",
  one: (id) => `/api/listings/${encodeURIComponent(id)}`,
  import: "/api/listings/import",
  authStatus: "/api/auth/status",
};

// ------------------------------------------------------------
// Constantes
// ------------------------------------------------------------
const VARIANTS = [
  { id: "ltz_plus", label: "LTZ Plus", badgeClass: "gold" },
  { id: "premier", label: "Premier", badgeClass: "green" },
  { id: "ltz_turbo", label: "1.4 Turbo LTZ", badgeClass: "" },
  { id: "ltz", label: "LTZ", badgeClass: "" },
  { id: "otro", label: "Otro", badgeClass: "" },
];

const STATUSES = [
  { id: "interesado", label: "Interesado" },
  { id: "contactado", label: "Contactado" },
  { id: "visitado", label: "Visitado" },
  { id: "descartado", label: "Descartado" },
];

const SOURCES = [
  { id: "mercadolibre", label: "Mercado Libre", icon: "ml" },
  { id: "facebook_marketplace", label: "Marketplace", icon: "fb" },
  { id: "otro", label: "Otro", icon: null },
];

// ------------------------------------------------------------
// Estado global
// ------------------------------------------------------------
const state = {
  items: [], // todas las listings cargadas del backend
  loading: false,
  formPhotos: [], // array de strings (URL https:// o data:image/...) del form en uso
  filters: {
    text: "",
    variants: new Set(VARIANTS.map((v) => v.id)),
    statuses: new Set(STATUSES.map((s) => s.id)),
    sources: new Set(SOURCES.map((s) => s.id)),
    yearMin: null,
    yearMax: null,
    priceMin: null,
    priceMax: null,
    kmMax: null,
    sort: "created_desc",
  },
  editingId: null, // id de la listing que se está editando, o null para nueva
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

const variantById = (id) => VARIANTS.find((v) => v.id === id) || VARIANTS[VARIANTS.length - 1];
const statusById = (id) => STATUSES.find((s) => s.id === id);
const sourceById = (id) => SOURCES.find((s) => s.id === id) || SOURCES[SOURCES.length - 1];

const numOrNull = (v) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};

// ------------------------------------------------------------
// API client
// ------------------------------------------------------------
async function apiJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function loadListings() {
  state.loading = true;
  showLoading(true);
  try {
    const data = await apiJson(API.listings);
    state.items = Array.isArray(data?.items) ? data.items : [];
  } catch (err) {
    console.error(err);
    showError(err.message || "No se pudieron cargar las publicaciones.");
    state.items = [];
  } finally {
    state.loading = false;
    showLoading(false);
    updateLastUpdate();
    applyFiltersAndRender();
  }
}

async function createListing(payload) {
  return apiJson(API.listings, { method: "POST", body: JSON.stringify(payload) });
}

async function updateListing(id, payload) {
  return apiJson(API.one(id), { method: "PUT", body: JSON.stringify(payload) });
}

async function deleteListing(id) {
  return apiJson(API.one(id), { method: "DELETE" });
}

async function importFromUrl(url) {
  return apiJson(`${API.import}?url=${encodeURIComponent(url)}`);
}

// ------------------------------------------------------------
// Filtros + orden
// ------------------------------------------------------------
function applyFiltersAndRender() {
  const f = state.filters;
  let items = state.items.slice();

  if (f.variants.size < VARIANTS.length) {
    items = items.filter((it) => f.variants.has(it.variant || "otro"));
  }
  if (f.statuses.size < STATUSES.length) {
    items = items.filter((it) => f.statuses.has(it.status || "interesado"));
  }
  if (f.sources.size < SOURCES.length) {
    items = items.filter((it) => f.sources.has(it.source || "otro"));
  }

  if (f.text.trim()) {
    const t = f.text.toLowerCase();
    items = items.filter((it) =>
      [it.title, it.description, it.notes, it.location, it.url]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(t))
    );
  }

  items = items.filter((it) => {
    if (f.yearMin && it.year && it.year < f.yearMin) return false;
    if (f.yearMax && it.year && it.year > f.yearMax) return false;
    if (f.priceMin != null && it.price != null && it.price < f.priceMin) return false;
    if (f.priceMax != null && it.price != null && it.price > f.priceMax) return false;
    if (f.kmMax != null && it.km != null && it.km > f.kmMax) return false;
    return true;
  });

  switch (f.sort) {
    case "created_asc":
      items.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
      break;
    case "rating_desc":
      items.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
      break;
    case "price_asc":
      items.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
      break;
    case "price_desc":
      items.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
      break;
    case "year_desc":
      items.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      break;
    case "year_asc":
      items.sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity));
      break;
    case "km_asc":
      items.sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));
      break;
    case "created_desc":
    default:
      items.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
      break;
  }

  state.filteredItems = items;
  renderResults(items);
  renderStats(items);
}

// ------------------------------------------------------------
// Render
// ------------------------------------------------------------
function renderStats(items) {
  $("#statCount").textContent = String(items.length);
  if (!items.length) {
    $("#statAvg").textContent = "—";
    $("#statMin").textContent = "—";
    $("#statMax").textContent = "—";
    return;
  }
  const usd = items.filter((i) => i.currency === "USD" && i.price != null);
  const ars = items.filter((i) => i.currency === "ARS" && i.price != null);
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

function renderResults(items) {
  const grid = $("#cards");
  grid.innerHTML = "";
  $("#emptyBox").hidden = items.length !== 0 || state.items.length === 0 && false;
  // El empty box muestra: si no hay items en absoluto (state.items vacío),
  // ofrecemos agregar el primero; si hay pero los filtros los esconden, decimos otra cosa.
  const emptyBox = $("#emptyBox");
  if (!items.length) {
    emptyBox.hidden = false;
    if (state.items.length === 0) {
      emptyBox.innerHTML = `
        <h3>Todavía no guardaste ninguna publicación</h3>
        <p>Hacé click en <strong>"+ Agregar publicación"</strong> arriba a la derecha y pegá la URL del primer auto que quieras seguir.</p>
      `;
    } else {
      emptyBox.innerHTML = `
        <h3>Ninguna publicación coincide con los filtros</h3>
        <p>Probá ampliar los rangos o limpiar los filtros.</p>
      `;
    }
  } else {
    emptyBox.hidden = true;
  }

  const frag = document.createDocumentFragment();
  for (const item of items) frag.appendChild(buildCard(item));
  grid.appendChild(frag);
}

function sourceIconSvg(iconId) {
  if (iconId === "ml") {
    return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>`;
  }
  if (iconId === "fb") {
    return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c5.05-.5 9-4.76 9-9.95z"/></svg>`;
  }
  return "";
}

function ratingHtml(rating) {
  if (!rating) return "";
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    stars.push(`<span class="star ${i <= rating ? "" : "empty"}">★</span>`);
  }
  return `<span class="rating-display" title="Rating: ${rating}/5">${stars.join("")}</span>`;
}

function buildCard(item) {
  const card = document.createElement("article");
  card.className = "card";
  if (item.status === "descartado") card.classList.add("is-descartado");
  card.dataset.id = item.id;

  const v = variantById(item.variant);
  const src = sourceById(item.source);
  const status = statusById(item.status) || STATUSES[0];
  const photo = (item.photos && item.photos[0]) || "";

  const badgeHtml = v && v.id !== "otro"
    ? `<span class="badge ${v.badgeClass || ""}">${escapeHtml(v.label)}</span>`
    : "";

  const statusBadge = `<span class="status-badge ${status.id}">${escapeHtml(status.label)}</span>`;

  const sourceChip = src.icon
    ? `<span class="source-chip ${src.icon}">${sourceIconSvg(src.icon)}${escapeHtml(src.label)}</span>`
    : `<span class="source-chip">${escapeHtml(src.label)}</span>`;

  card.innerHTML = `
    <div class="card-image">
      ${badgeHtml}
      ${statusBadge}
      ${photo
        ? `<img loading="lazy" alt="${escapeHtml(item.title)}" src="${escapeHtml(photo)}" onerror="this.style.background='#e2e8f0';this.removeAttribute('src');" />`
        : `<div style="width:100%;height:100%;display:grid;place-items:center;color:#94a3b8;font-size:12px;">Sin foto</div>`}
    </div>
    <div class="card-body">
      <div class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title || "(sin título)")}</div>
      <div class="card-price">
        ${fmtMoney(item.price, item.currency || "USD")}
      </div>
      <div class="card-attrs">
        ${item.year ? `<span class="attr year">${item.year}</span>` : ""}
        ${item.km != null ? `<span class="attr km">${fmtKm(item.km)}</span>` : ""}
        ${item.transmission ? `<span class="attr trans">${escapeHtml(item.transmission)}</span>` : ""}
      </div>
      <div class="card-location" title="Ubicación">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/>
          <circle cx="12" cy="10" r="3"/>
        </svg>
        ${escapeHtml(item.location || "—")}
      </div>
      <div class="card-meta-row">
        ${sourceChip}
        ${ratingHtml(item.rating)}
      </div>
      <div class="card-desc ${item.notes ? "" : (item.description ? "" : "placeholder")}">
        ${
          item.notes
            ? escapeHtml(String(item.notes).slice(0, 200)) + (item.notes.length > 200 ? "…" : "")
            : item.description
              ? escapeHtml(String(item.description).slice(0, 200)) + (item.description.length > 200 ? "…" : "")
              : "Sin notas ni descripción."
        }
      </div>
      <div class="card-footer">
        <a class="ml-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation();">Abrir publicación →</a>
        <div class="actions">
          <button class="icon-btn" type="button" data-action="edit" title="Editar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9"></path>
              <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
            </svg>
          </button>
          <button class="icon-btn danger" type="button" data-action="delete" title="Borrar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
              <path d="M10 11v6"></path>
              <path d="M14 11v6"></path>
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>
    </div>
  `;

  card.addEventListener("click", (e) => {
    const actionBtn = e.target.closest("[data-action]");
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;
      if (action === "edit") openFormModal(item);
      else if (action === "delete") confirmDelete(item);
      return;
    }
    if (e.target.closest("a")) return;
    openDetailModal(item);
  });

  return card;
}

// ------------------------------------------------------------
// Modal de detalle (read-only-ish)
// ------------------------------------------------------------
function openDetailModal(item) {
  const modal = $("#detailModal");
  const body = $("#detailModalBody");
  const v = variantById(item.variant);
  const src = sourceById(item.source);
  const status = statusById(item.status) || STATUSES[0];
  const photos = item.photos || [];
  const heroPhoto = photos[0];

  const photosHtml = photos.length > 1
    ? `<div class="photos-preview">${photos.slice(1).map((p) => `<a class="thumb" style="background-image:url('${escapeHtml(p)}')" href="${escapeHtml(p)}" target="_blank" rel="noopener"></a>`).join("")}</div>`
    : "";

  body.innerHTML = `
    <div class="modal-hero" style="${heroPhoto ? "" : "padding:48px 24px;text-align:center;color:#94a3b8;"}">
      ${heroPhoto
        ? `<img alt="${escapeHtml(item.title)}" src="${escapeHtml(heroPhoto)}" />`
        : "Sin foto"}
    </div>
    <div class="modal-content">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div>
          <h3 id="detailModalTitle">${escapeHtml(item.title || "(sin título)")}</h3>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
            ${src.icon ? `<span class="source-chip ${src.icon}">${sourceIconSvg(src.icon)}${escapeHtml(src.label)}</span>` : `<span class="source-chip">${escapeHtml(src.label)}</span>`}
            <span class="status-badge ${status.id}" style="position:static;">${escapeHtml(status.label)}</span>
            ${v && v.id !== "otro" ? `<span class="badge ${v.badgeClass || ""}" style="position:static;">${escapeHtml(v.label)}</span>` : ""}
            ${ratingHtml(item.rating)}
          </div>
        </div>
        <div class="modal-price">${fmtMoney(item.price, item.currency || "USD")}</div>
      </div>

      <div class="modal-attrs">
        ${attrRow("Año", item.year ?? "—")}
        ${attrRow("Kilometraje", item.km != null ? fmtKm(item.km) : "—")}
        ${attrRow("Transmisión", item.transmission ?? "—")}
        ${attrRow("Combustible", item.fuel ?? "—")}
        ${attrRow("Ubicación", item.location ?? "—")}
        ${attrRow("Agregado", formatDate(item.created_at))}
      </div>

      ${item.description
        ? `<div><strong>Descripción</strong><div class="modal-desc">${escapeHtml(item.description)}</div></div>`
        : ""}

      ${item.notes
        ? `<div><strong>Notas privadas</strong><div class="modal-desc" style="background:#fffbeb;border-color:#fde68a;">${escapeHtml(item.notes)}</div></div>`
        : ""}

      ${photosHtml}

      <div class="modal-actions">
        <a class="btn btn-primary" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Abrir publicación original →</a>
        <button class="btn btn-secondary" type="button" data-action="edit-from-detail">Editar</button>
        <button class="btn btn-danger" type="button" data-action="delete-from-detail">Borrar</button>
        <button class="btn btn-ghost" type="button" data-close style="margin-left:auto;color:var(--text-soft);border-color:var(--surface-border);background:var(--surface);">Cerrar</button>
      </div>
    </div>
  `;

  body.querySelector('[data-action="edit-from-detail"]').addEventListener("click", () => {
    closeModal(modal);
    openFormModal(item);
  });
  body.querySelector('[data-action="delete-from-detail"]').addEventListener("click", () => {
    closeModal(modal);
    confirmDelete(item);
  });

  openModal(modal);
}

function attrRow(k, v) {
  return `<div class="modal-attr-row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></div>`;
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" }) + " · " +
           d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

// ------------------------------------------------------------
// Modal de formulario (crear / editar)
// ------------------------------------------------------------
function openFormModal(item = null) {
  const modal = $("#formModal");
  const form = $("#listingForm");
  form.reset();
  $("#formError").hidden = true;
  $("#detectMsg").hidden = true;

  state.editingId = item?.id || null;

  $("#formModalTitle").textContent = item ? "Editar publicación" : "Nueva publicación";
  $("#formModalSub").innerHTML = item
    ? "Modificá los campos que necesites y dale a <strong>Guardar</strong>."
    : "Pegá la URL y completá los datos. Si es de Mercado Libre, podés usar <strong>Detectar</strong> para autocompletar.";

  setFormValues({
    id: item?.id || "",
    url: item?.url || "",
    title: item?.title || "",
    source: item?.source || "mercadolibre",
    variant: item?.variant || "otro",
    status: item?.status || "interesado",
    price: item?.price ?? "",
    currency: item?.currency || "USD",
    year: item?.year ?? "",
    km: item?.km ?? "",
    transmission: item?.transmission || "",
    fuel: item?.fuel || "",
    location: item?.location || "",
    description: item?.description || "",
    notes: item?.notes || "",
    rating: item?.rating ?? "",
  });

  renderRatingStars(item?.rating ?? null);
  setFormPhotos(item?.photos || []);

  $("#formDeleteBtn").hidden = !item;
  openModal(modal);
  setTimeout(() => $("#f_url")?.focus(), 50);
}

function setFormValues(values) {
  for (const [key, value] of Object.entries(values)) {
    const el = document.querySelector(`#listingForm [name="${key}"]`);
    if (!el) continue;
    el.value = value == null ? "" : value;
  }
}

function readFormValues() {
  const f = $("#listingForm");
  const fd = new FormData(f);
  const obj = Object.fromEntries(fd.entries());

  const photos = state.formPhotos.slice();

  return {
    url: (obj.url || "").trim(),
    title: (obj.title || "").trim(),
    source: obj.source || null,
    variant: obj.variant || null,
    status: obj.status || null,
    price: obj.price ? Number(obj.price) : null,
    currency: obj.currency || null,
    year: obj.year ? Number(obj.year) : null,
    km: obj.km ? Number(obj.km) : null,
    transmission: obj.transmission || null,
    fuel: obj.fuel || null,
    location: (obj.location || "").trim() || null,
    description: (obj.description || "").trim() || null,
    notes: (obj.notes || "").trim() || null,
    photos,
    rating: obj.rating ? Number(obj.rating) : null,
  };
}

function renderRatingStars(rating) {
  const wrap = $("#ratingStars");
  wrap.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = rating && i <= rating ? "active" : "";
    btn.dataset.value = String(i);
    btn.textContent = "★";
    btn.title = `${i} estrella${i > 1 ? "s" : ""}`;
    btn.addEventListener("click", () => {
      $("#f_rating").value = String(i);
      renderRatingStars(i);
    });
    wrap.appendChild(btn);
  }
  if (rating) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "clear-rating";
    clear.textContent = "Limpiar";
    clear.addEventListener("click", () => {
      $("#f_rating").value = "";
      renderRatingStars(null);
    });
    wrap.appendChild(clear);
  }
}

// ------------------------------------------------------------
// Manejo del array de fotos del formulario
// ------------------------------------------------------------
const PHOTO_MAX_BYTES = 900 * 1024;      // ~900 KB por foto (post-compresión)
const PHOTOS_BUDGET_BYTES = 850 * 1024;  // KV warning umbral total
const PHOTOS_HARD_LIMIT_BYTES = 1024 * 1024; // 1 MB - error duro

function setFormPhotos(photos) {
  state.formPhotos = Array.isArray(photos) ? photos.slice() : [];
  renderPhotosList();
}

function addFormPhoto(value) {
  if (!value || typeof value !== "string") return;
  state.formPhotos.push(value);
  renderPhotosList();
}

function removeFormPhoto(index) {
  state.formPhotos.splice(index, 1);
  renderPhotosList();
}

function approxBytes(str) {
  // Para data URLs base64 esto es muy preciso; para URLs es despreciable.
  if (!str) return 0;
  if (str.startsWith("data:")) {
    const b64 = str.split(",", 2)[1] || "";
    return Math.floor((b64.length * 3) / 4);
  }
  return str.length;
}

function totalPhotosBytes() {
  return state.formPhotos.reduce((a, p) => a + approxBytes(p), 0);
}

function fmtKB(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function renderPhotosList() {
  const wrap = $("#photosList");
  wrap.innerHTML = "";

  for (let i = 0; i < state.formPhotos.length; i++) {
    const p = state.formPhotos[i];
    const isData = p.startsWith("data:");
    const div = document.createElement("div");
    div.className = "photo-item";
    div.style.backgroundImage = `url("${p.replace(/"/g, "%22")}")`;
    div.innerHTML = `
      <button type="button" class="remove-photo" title="Quitar foto" data-idx="${i}">&times;</button>
      <span class="photo-badge">${isData ? "subida" : "URL"}</span>
    `;
    div.querySelector(".remove-photo").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeFormPhoto(Number(e.currentTarget.dataset.idx));
    });
    wrap.appendChild(div);
  }

  // Indicador de peso total
  const sizeEl = $("#photosSize");
  if (state.formPhotos.length === 0) {
    sizeEl.textContent = "";
    sizeEl.className = "photos-size";
  } else {
    const total = totalPhotosBytes();
    sizeEl.textContent = `${state.formPhotos.length} foto${state.formPhotos.length !== 1 ? "s" : ""} · ${fmtKB(total)}`;
    sizeEl.className = "photos-size" +
      (total >= PHOTOS_HARD_LIMIT_BYTES ? " err" :
       total >= PHOTOS_BUDGET_BYTES ? " warn" : "");
  }
}

// Comprimir una imagen a JPEG via canvas. Devuelve data URL.
async function compressImage(file, { maxWidth = 1200, maxHeight = 900, quality = 0.72 } = {}) {
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("No se pudo leer el archivo."));
    fr.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Archivo no es una imagen válida."));
    i.src = dataUrl;
  });
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxWidth / w, maxHeight / h);
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // PNG con alpha -> blanco en JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  let out = canvas.toDataURL("image/jpeg", quality);
  // Si quedó muy grande, hacemos un segundo pase con menos calidad
  if (approxBytes(out) > PHOTO_MAX_BYTES && quality > 0.5) {
    out = canvas.toDataURL("image/jpeg", 0.6);
  }
  if (approxBytes(out) > PHOTO_MAX_BYTES) {
    // Última instancia: bajamos resolución
    const canvas2 = document.createElement("canvas");
    canvas2.width = Math.round(w * 0.75);
    canvas2.height = Math.round(h * 0.75);
    const ctx2 = canvas2.getContext("2d");
    ctx2.fillStyle = "#ffffff";
    ctx2.fillRect(0, 0, canvas2.width, canvas2.height);
    ctx2.drawImage(canvas, 0, 0, canvas2.width, canvas2.height);
    out = canvas2.toDataURL("image/jpeg", 0.6);
  }
  return out;
}

async function handlePhotoFiles(files) {
  const arr = Array.from(files || []).filter((f) => f && f.type && f.type.startsWith("image/"));
  if (!arr.length) return;

  const dz = $("#photoDropzone");
  dz.classList.add("is-busy");
  try {
    for (const file of arr) {
      try {
        const dataUrl = await compressImage(file);
        addFormPhoto(dataUrl);
      } catch (e) {
        console.error("compressImage failed", e);
      }
      if (state.formPhotos.length >= 20) break;
    }
  } finally {
    dz.classList.remove("is-busy");
  }
}

// ------------------------------------------------------------
// Auto-fill (botón Detectar)
// ------------------------------------------------------------
async function handleDetect() {
  const url = $("#f_url").value.trim();
  const msg = $("#detectMsg");

  if (!url) {
    msg.hidden = false;
    msg.className = "detect-msg warn";
    msg.textContent = "Pegá primero la URL.";
    return;
  }

  msg.hidden = false;
  msg.className = "detect-msg loading";
  msg.innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div> Detectando datos…`;

  const detectBtn = $("#detectBtn");
  detectBtn.disabled = true;

  try {
    const data = await importFromUrl(url);

    if (data.autofilled === false) {
      msg.className = "detect-msg warn";
      msg.textContent =
        data.message ||
        "No se pudo autocompletar desde esta URL. Cargá los datos a mano.";
      // Pero igual seteamos la source si la detectó
      if (data.source) $("#f_source").value = data.source;
      return;
    }

    // Source autodetectada
    if (data.source) $("#f_source").value = data.source;

    // Llenar campos sólo si están vacíos (para no pisar lo que el usuario ya cargó)
    const fields = ["title", "variant", "price", "currency", "year", "km", "transmission", "fuel", "location", "description"];
    let touched = 0;
    for (const k of fields) {
      const el = document.querySelector(`#listingForm [name="${k}"]`);
      if (!el) continue;
      const cur = (el.value || "").trim();
      if (cur === "" && data[k] != null && data[k] !== "") {
        el.value = data[k];
        touched++;
      }
    }

    // Photos: sólo pisamos si todavía no hay fotos cargadas
    if (Array.isArray(data.photos) && data.photos.length) {
      if (state.formPhotos.length === 0) {
        setFormPhotos(data.photos);
        touched++;
      }
    }

    msg.className = "detect-msg ok";
    msg.textContent = `Autocompletado desde Mercado Libre · ${touched} campo${touched !== 1 ? "s" : ""} actualizado${touched !== 1 ? "s" : ""}.`;
  } catch (err) {
    msg.className = "detect-msg err";
    msg.textContent = err.message || "No se pudo autocompletar.";
  } finally {
    detectBtn.disabled = false;
  }
}

// ------------------------------------------------------------
// Submit (crear o actualizar)
// ------------------------------------------------------------
async function handleFormSubmit(ev) {
  ev.preventDefault();
  const values = readFormValues();
  const errBox = $("#formError");
  errBox.hidden = true;

  if (!values.url) {
    errBox.hidden = false;
    errBox.textContent = "La URL es obligatoria.";
    return;
  }
  if (!values.title) {
    errBox.hidden = false;
    errBox.textContent = "El título es obligatorio.";
    return;
  }

  const saveBtn = $("#formSaveBtn");
  saveBtn.disabled = true;
  const originalText = saveBtn.textContent;
  saveBtn.textContent = "Guardando…";

  try {
    let saved;
    if (state.editingId) {
      saved = await updateListing(state.editingId, values);
      const idx = state.items.findIndex((x) => x.id === saved.id);
      if (idx !== -1) state.items[idx] = saved;
    } else {
      saved = await createListing(values);
      state.items = [saved, ...state.items];
    }
    closeModal($("#formModal"));
    applyFiltersAndRender();
  } catch (err) {
    errBox.hidden = false;
    errBox.textContent = err.message || "No se pudo guardar.";
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = originalText;
  }
}

// ------------------------------------------------------------
// Borrar
// ------------------------------------------------------------
async function confirmDelete(item) {
  const ok = window.confirm(
    `¿Borrar la publicación "${item.title || item.id}"?\n\nEsto NO borra nada en Mercado Libre/Facebook, solo en tu lista guardada.`
  );
  if (!ok) return;
  try {
    await deleteListing(item.id);
    state.items = state.items.filter((x) => x.id !== item.id);
    applyFiltersAndRender();
  } catch (err) {
    showError(err.message || "No se pudo borrar.");
  }
}

// ------------------------------------------------------------
// UI helpers
// ------------------------------------------------------------
function openModal(modal) {
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeModal(modal) {
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  // Si no hay ningún otro modal abierto, libero el body
  const anyOpen = $$(".modal").some((m) => !m.hidden);
  if (!anyOpen) document.body.style.overflow = "";
}

function closeAllModals() {
  $$(".modal").forEach((m) => closeModal(m));
}

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
  $("#lastUpdate").textContent = `Cargado: ${t}`;
}

// ------------------------------------------------------------
// Auth status
// ------------------------------------------------------------
async function checkAuthStatus() {
  try {
    const r = await fetch(API.authStatus, { headers: { Accept: "application/json" } });
    const s = await r.json();
    renderAuthStatus(s);
    return s;
  } catch (e) {
    renderAuthStatus({ connected: false, error: e?.message });
    return { connected: false };
  }
}

function renderAuthStatus(s) {
  const pill = $("#connStatus");
  const text = $("#connStatusText");
  const btn = $("#connectBtn");
  pill.classList.remove("pill-ok", "pill-warn", "pill-err", "pill-muted");

  if (!s.has_credentials) {
    pill.classList.add("pill-err");
    text.textContent = "Faltan credenciales ML";
    btn.hidden = true;
    return;
  }
  if (!s.kv_configured) {
    pill.classList.add("pill-err");
    text.textContent = "KV no configurado";
    btn.hidden = true;
    return;
  }
  if (!s.connected) {
    pill.classList.add("pill-warn");
    text.textContent = "Sin autorizar ML";
    btn.hidden = false;
    return;
  }
  pill.classList.add("pill-ok");
  text.textContent = s.user_id ? `ML · ${s.user_id}` : "Conectado a ML";
  btn.hidden = true;
}

// ------------------------------------------------------------
// Filter chips render
// ------------------------------------------------------------
function renderToggleChips(wrapId, items, getActive, setActive) {
  const wrap = $(`#${wrapId}`);
  wrap.innerHTML = "";
  for (const it of items) {
    const label = document.createElement("label");
    label.className = "chip" + (getActive(it.id) ? " active" : "");
    label.innerHTML = `
      <input type="checkbox" ${getActive(it.id) ? "checked" : ""} />
      ${escapeHtml(it.label)}
    `;
    label.querySelector("input").addEventListener("change", (e) => {
      setActive(it.id, e.target.checked);
      label.classList.toggle("active", e.target.checked);
      applyFiltersAndRender();
    });
    wrap.appendChild(label);
  }
}

function renderAllChips() {
  renderToggleChips(
    "variantChips", VARIANTS,
    (id) => state.filters.variants.has(id),
    (id, on) => { on ? state.filters.variants.add(id) : state.filters.variants.delete(id); }
  );
  renderToggleChips(
    "statusChips", STATUSES,
    (id) => state.filters.statuses.has(id),
    (id, on) => { on ? state.filters.statuses.add(id) : state.filters.statuses.delete(id); }
  );
  renderToggleChips(
    "sourceChips", SOURCES,
    (id) => state.filters.sources.has(id),
    (id, on) => { on ? state.filters.sources.add(id) : state.filters.sources.delete(id); }
  );
}

function readNumericFiltersFromUI() {
  const f = state.filters;
  f.yearMin = numOrNull($("#yearMin").value);
  f.yearMax = numOrNull($("#yearMax").value);
  f.priceMin = numOrNull($("#priceMin").value);
  f.priceMax = numOrNull($("#priceMax").value);
  f.kmMax = numOrNull($("#kmMax").value);
}

function resetFilters() {
  $("#searchInput").value = "";
  $("#yearMin").value = "";
  $("#yearMax").value = "";
  $("#priceMin").value = "";
  $("#priceMax").value = "";
  $("#kmMax").value = "";
  $("#sortSelect").value = "created_desc";
  state.filters = {
    text: "",
    variants: new Set(VARIANTS.map((v) => v.id)),
    statuses: new Set(STATUSES.map((s) => s.id)),
    sources: new Set(SOURCES.map((s) => s.id)),
    yearMin: null,
    yearMax: null,
    priceMin: null,
    priceMax: null,
    kmMax: null,
    sort: "created_desc",
  };
  renderAllChips();
  applyFiltersAndRender();
}

// ------------------------------------------------------------
// Wire-up
// ------------------------------------------------------------
function init() {
  renderAllChips();

  $("#addBtn").addEventListener("click", () => openFormModal(null));
  $("#resetFilters").addEventListener("click", resetFilters);

  $("#searchInput").addEventListener("input", () => {
    state.filters.text = $("#searchInput").value.trim();
    applyFiltersAndRender();
  });
  $("#sortSelect").addEventListener("change", () => {
    state.filters.sort = $("#sortSelect").value;
    applyFiltersAndRender();
  });
  for (const id of ["yearMin", "yearMax", "priceMin", "priceMax", "kmMax"]) {
    $(`#${id}`).addEventListener("change", () => {
      readNumericFiltersFromUI();
      applyFiltersAndRender();
    });
  }

  // Modales: click en backdrop o data-close
  for (const m of $$(".modal")) {
    m.addEventListener("click", (e) => {
      if (e.target.matches("[data-close]")) closeModal(m);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllModals();
  });

  // Form
  $("#listingForm").addEventListener("submit", handleFormSubmit);
  $("#detectBtn").addEventListener("click", handleDetect);
  $("#formDeleteBtn").addEventListener("click", async () => {
    if (!state.editingId) return;
    const item = state.items.find((x) => x.id === state.editingId);
    if (!item) return;
    closeModal($("#formModal"));
    confirmDelete(item);
  });

  // Dropzone de fotos: click, drop, paste, file picker
  wirePhotoDropzone();

  // Carga inicial
  checkAuthStatus();
  loadListings();
}

function wirePhotoDropzone() {
  const dz = $("#photoDropzone");
  const fileInput = $("#photoFileInput");

  dz.addEventListener("click", () => fileInput.click());
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener("change", (e) => {
    handlePhotoFiles(e.target.files);
    fileInput.value = ""; // permite re-elegir el mismo archivo
  });

  // Drag & drop
  ["dragenter", "dragover"].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.add("is-dragover");
    });
  });
  ["dragleave", "dragend", "drop"].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.remove("is-dragover");
    });
  });
  dz.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) {
      handlePhotoFiles(e.dataTransfer.files);
    }
  });

  // Paste (Ctrl+V) — sólo cuando el form modal está abierto
  document.addEventListener("paste", (e) => {
    const formModal = $("#formModal");
    if (!formModal || formModal.hidden) return;
    // Si el foco está en un input de texto que no es el de URL, no interceptamos
    // (para no robarle pastes de texto a description/notes/etc).
    const active = document.activeElement;
    const isTextField = active && (
      active.tagName === "TEXTAREA" ||
      (active.tagName === "INPUT" && !["file", "checkbox", "radio"].includes(active.type))
    );
    const items = e.clipboardData?.items || [];
    const files = [];
    for (const it of items) {
      if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      // Hay imagen real en el clipboard: la procesamos sí o sí.
      e.preventDefault();
      handlePhotoFiles(files);
      return;
    }
    // Si no hay imagen, dejamos que el paste de texto siga su curso normal.
    if (isTextField) return;
  });

  // Botón "+ Agregar foto por URL"
  $("#addPhotoUrlBtn").addEventListener("click", () => {
    const url = window.prompt("Pegá la URL de la foto (https://…):", "");
    if (!url) return;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      alert("La URL tiene que arrancar con http:// o https://");
      return;
    }
    addFormPhoto(trimmed);
  });
}

document.addEventListener("DOMContentLoaded", init);
