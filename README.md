# Cruze LTZ Finder · Buenos Aires

Página web para visualizar publicaciones reales de **Chevrolet Cruze LTZ Plus** y variantes relacionadas en **Buenos Aires (Argentina)**, con datos en vivo de la **API pública de Mercado Libre Argentina** (sitio `MLA`).

> No requiere instalar ni Node, ni Python, ni nada. Es 100% HTML + CSS + JS estático. Se ejecuta abriendo un archivo en el navegador.

---

## Características

- Lista publicaciones reales tomadas en vivo desde Mercado Libre.
- Filtra por las variantes objetivo:
  - Chevrolet Cruze **LTZ Plus**
  - Chevrolet Cruze **LTZ**
  - Chevrolet Cruze **Premier**
  - Chevrolet Cruze **1.4 Turbo LTZ**
- Cada publicación muestra:
  - Foto principal del auto.
  - Título de la publicación.
  - Precio (con la moneda original — usualmente USD).
  - Año del vehículo.
  - Kilometraje (cuando está disponible).
  - Ubicación (ciudad y provincia).
  - Descripción breve (extraída de la descripción real del vendedor).
- Filtros adicionales:
  - Texto libre.
  - Año mínimo / máximo.
  - Precio mínimo / máximo.
  - Kilometraje máximo.
  - Ubicación: **Capital Federal**, **Buenos Aires (Provincia / GBA)** o ambas.
- Ordenamiento por relevancia, precio, año o kilometraje.
- Estadísticas rápidas: cantidad, promedio, mínimo y máximo de precio.
- Modal de detalle con la descripción completa del vendedor y enlace directo a la publicación original en Mercado Libre.

---

## Cómo usarlo

### Opción 1 — Doble clic (más simple)

1. Abrí la carpeta del proyecto.
2. Hacé doble clic sobre `index.html`.
3. La página se abre en tu navegador y empieza a buscar automáticamente.

> ⚠️ Si tu navegador bloquea las llamadas `fetch` desde `file://` (algunos Chrome con políticas estrictas), usá la **Opción 2**.

### Opción 2 — Servidor local (recomendado)

Si tenés Python instalado:

```bash
python -m http.server 5500
```

Si tenés Node.js:

```bash
npx serve .
```

Luego abrí <http://localhost:5500> en el navegador.

---

## Estructura del proyecto

```
.
├── index.html      # Layout y controles
├── styles.css      # UI moderna y responsive
├── app.js          # Lógica de búsqueda, filtros y render
└── README.md
```

---

## ¿De dónde salen los datos?

Todo viene de la API pública de Mercado Libre:

- **Listado**: `GET https://api.mercadolibre.com/sites/MLA/search?q=Chevrolet+Cruze+LTZ&category=MLA1744&state=<state_id>&condition=used`
- **Descripción de cada item**: `GET https://api.mercadolibre.com/items/{id}/description`
- **IDs de provincia**: `GET https://api.mercadolibre.com/classified_locations/countries/AR`

La aplicación hace **dos búsquedas en paralelo** (una para `LTZ` y otra para `Premier`) por cada provincia seleccionada, fusiona y deduplica resultados por `id`, y luego filtra por variante usando regex sobre el título.

---

## Detalles técnicos

- **CORS**: La API `api.mercadolibre.com` devuelve `Access-Control-Allow-Origin: *` en sus endpoints públicos, por eso podemos consumirla directamente desde el navegador sin proxy.
- **Calidad de imágenes**: el `thumbnail` que devuelve ML es chico; el código sustituye el sufijo `-I` por `-O` para obtener la imagen original de mayor resolución.
- **Descripciones**: para no saturar la API ni demorar el primer render, las descripciones se cargan en background con concurrencia limitada (5 a la vez) para los primeros 30 resultados visibles. Al abrir el modal de un auto en particular, si todavía no está cargada, se trae en ese momento.
- **Estados**: ML tagea las publicaciones con IDs granulares (no existe un único "Provincia de Buenos Aires"), por eso para la opción "Buenos Aires (Provincia)" se consultan en paralelo `Bs.As. G.B.A. Norte`, `Oeste` y `Sur`.

---

## Deploy en Vercel

Este proyecto es 100% estático, así que Vercel lo detecta automáticamente sin necesidad de build step.

### Opción A — Subir a GitHub y conectar Vercel (recomendado)

```powershell
# 1. Inicializar git (sólo la primera vez)
git init
git add .
git commit -m "Initial commit: Cruze LTZ Finder"

# 2. Crear repo público en GitHub y pushear (requiere `gh auth login` la primera vez)
gh repo create cruze-ltz-finder --public --source=. --remote=origin --push
```

Después, ir a <https://vercel.com/new>, importar el repo `cruze-ltz-finder`, dejar todo por defecto y hacer click en **Deploy**. En menos de 30 segundos tenés URL pública.

### Opción B — Deploy directo con Vercel CLI

```powershell
# Instalar la CLI de Vercel (una vez)
npm i -g vercel

# Deploy preview
vercel

# Deploy a producción
vercel --prod
```

La primera vez te pide hacer login con `vercel login`.

## Notas legales

Los datos, precios e imágenes mostrados pertenecen a sus respectivos vendedores en Mercado Libre. Esta página es solo una herramienta de visualización que consume información públicamente disponible vía la API oficial.
