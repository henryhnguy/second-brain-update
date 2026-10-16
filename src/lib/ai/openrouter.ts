/**
 * OpenRouter's catalogue, narrowed to the models that cost nothing.
 *
 * `GET https://openrouter.ai/api/v1/models` is public — no key — and returns
 * every model with its prices as strings. Two filters are needed, not one:
 * price alone also matches models that do not answer with text (music and image
 * generators sit at zero too), so the output modality has to say `->text`.
 *
 * The answer is cached in-process: the catalogue changes, but not by the
 * minute, and a settings page should not hammer a third party.
 */

export type FreeModel = {
  id: string;
  name: string;
  contextLength: number | null;
};

export type CatalogueEntry = {
  id?: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
  architecture?: { modality?: string; output_modalities?: string[] };
};

const CATALOGUE_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

type Cache = { at: number; models: FreeModel[] };

let cache: Cache | null = null;

function isZero(price: string | number | undefined): boolean {
  if (price === undefined) return false;
  return String(price).trim() === "0";
}

/** Answers with text, and costs nothing on either side of the exchange. */
export function isFreeTextModel(entry: CatalogueEntry): boolean {
  if (!entry.id || !isZero(entry.pricing?.prompt) || !isZero(entry.pricing?.completion)) return false;
  const modality = entry.architecture?.modality;
  if (typeof modality === "string") return modality.endsWith("->text");
  const outputs = entry.architecture?.output_modalities;
  return Array.isArray(outputs) ? outputs.includes("text") : false;
}

/** Pulls the free text models out of a catalogue payload, alphabetically. */
export function parseFreeModels(payload: unknown): FreeModel[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((entry): entry is CatalogueEntry => typeof entry === "object" && entry !== null)
    .filter(isFreeTextModel)
    .map((entry) => ({
      id: String(entry.id),
      name: entry.name?.trim() || String(entry.id),
      contextLength: typeof entry.context_length === "number" ? entry.context_length : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Free models from the live catalogue, or an empty list when OpenRouter cannot
 * be reached — the caller keeps its manual input either way.
 */
export async function listFreeModels(
  deps: { fetchImpl?: typeof fetch; now?: number; force?: boolean } = {},
): Promise<{ models: FreeModel[]; fetchedAt: string | null; cached: boolean }> {
  const now = deps.now ?? Date.now();
  if (!deps.force && cache && now - cache.at < CACHE_TTL_MS) {
    return { models: cache.models, fetchedAt: new Date(cache.at).toISOString(), cached: true };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("OpenRouter catalogue timed out")), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(CATALOGUE_URL, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) return { models: cache?.models ?? [], fetchedAt: cache ? new Date(cache.at).toISOString() : null, cached: true };
    const models = parseFreeModels(await response.json());
    cache = { at: now, models };
    return { models, fetchedAt: new Date(now).toISOString(), cached: false };
  } catch {
    return { models: cache?.models ?? [], fetchedAt: cache ? new Date(cache.at).toISOString() : null, cached: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: forgets the cached catalogue. */
export function resetFreeModelCache(): void {
  cache = null;
}
