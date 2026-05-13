// Helper minimalista para Vercel KV (Upstash Redis bajo el capó), via REST.
// Evitamos instalar @vercel/kv como dependencia: hablamos directo con la API
// REST de Upstash usando las env vars que Vercel inyecta cuando linkeás
// una KV / Upstash Redis al proyecto.
//
// Vars que setea Vercel automáticamente al linkear:
//   KV_REST_API_URL
//   KV_REST_API_TOKEN
// Si linkeás Upstash directamente, los nombres pueden ser:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

const KV_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
const KV_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;

export function isKvConfigured() {
  return !!(KV_URL && KV_TOKEN);
}

async function kvCmd(args) {
  if (!isKvConfigured()) {
    const err = new Error(
      "Vercel KV no está configurado. Activá Storage > KV en el dashboard de Vercel y linkeá la base al proyecto."
    );
    err.code = "kv_not_configured";
    throw err;
  }
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`KV ${args[0]} failed (${r.status}): ${t}`);
  }
  const data = await r.json();
  return data.result;
}

export async function kvGet(key) {
  return kvCmd(["GET", key]);
}

export async function kvSet(key, value) {
  return kvCmd(["SET", key, String(value)]);
}

export async function kvDel(key) {
  return kvCmd(["DEL", key]);
}
