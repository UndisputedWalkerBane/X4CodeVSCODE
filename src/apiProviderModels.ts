import { createHash } from "node:crypto";
import { isValidApiModelId } from "./apiModelParameters";
import { normalizeApiProviderBaseUrl, type ResolvedApiProviderProfile } from "./apiProviderProfiles";

export { apiEffortLevels, ABLITERATION_MODELS, isValidApiModelId } from "./apiModelParameters";

const limit = 1024 * 1024;
const lookups = new Map<string, Promise<string[]>>();

/** Called by the host after verifying that this session still owns the configured endpoint. */
export async function fetchApiModelIds(profile: Pick<ResolvedApiProviderProfile, "baseUrl" | "apiKey"> & { id?: string }): Promise<string[]> {
  const url = normalizeApiProviderBaseUrl(profile.baseUrl) + "/models";
  // Catalogs may differ between accounts on the same server, including after a key rotation.
  const key = createHash("sha256").update(JSON.stringify([profile.id, url, profile.apiKey])).digest("hex");
  const existing = lookups.get(key);
  if (existing) return existing;
  if (lookups.size >= 8) throw new Error("Дождитесь загрузки каталога моделей.");
  const pending = requestModelIds(url, profile.apiKey);
  lookups.set(key, pending);
  try { return await pending; }
  finally { lookups.delete(key); }
}

async function requestModelIds(url: string, apiKey?: string): Promise<string[]> {
  const response = await fetch(url, {
    headers: apiKey ? { Authorization: "Bearer " + apiKey } : {},
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Каталог моделей недоступен.");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error("Каталог моделей слишком большой.");
    chunks.push(chunk);
  }
  let catalog: unknown;
  try {
    catalog = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new Error("Провайдер вернул некорректный каталог моделей.");
  }
  if (!catalog || typeof catalog !== "object" || !("data" in catalog) || !Array.isArray(catalog.data)) {
    throw new Error("Не удалось прочитать каталог моделей.");
  }
  const ids = new Set<string>();
  for (const entry of catalog.data) {
    const id: unknown = entry?.id;
    if (isValidApiModelId(id) && !(apiKey && id.includes(apiKey))) ids.add(id);
    if (ids.size >= 1024) break;
  }
  return [...ids];
}
