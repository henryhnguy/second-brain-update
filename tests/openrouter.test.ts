import { afterEach, describe, expect, it, vi } from "vitest";

import { isFreeTextModel, listFreeModels, parseFreeModels, resetFreeModelCache } from "@/lib/ai/openrouter";

/** Shapes copied from a real `GET https://openrouter.ai/api/v1/models` payload. */
const CATALOGUE = {
  data: [
    {
      id: "nvidia/nemotron-3.5-super-vl:free",
      name: "NVIDIA: Nemotron 3.5 Super VL (free)",
      context_length: 1_000_000,
      pricing: { prompt: "0", completion: "0" },
      architecture: { modality: "text+image->text" },
    },
    {
      id: "google/gemma-4-31b-it:free",
      name: "Google: Gemma 4 31B (free)",
      context_length: 262_144,
      pricing: { prompt: "0", completion: "0" },
      architecture: { modality: "text->text" },
    },
    {
      id: "openrouter/free",
      name: "Free Models Router",
      context_length: 200_000,
      pricing: { prompt: 0, completion: 0 },
      architecture: { modality: "text->text" },
    },
    {
      id: "google/lyria-3-pro-preview",
      name: "Google: Lyria 3 Pro Preview",
      context_length: 1_048_576,
      pricing: { prompt: "0", completion: "0" },
      architecture: { modality: "text->audio" },
    },
    {
      id: "openai/gpt-4o-mini",
      name: "OpenAI: GPT-4o mini",
      context_length: 128_000,
      pricing: { prompt: "0.00000015", completion: "0.0000006" },
      architecture: { modality: "text+image->text" },
    },
    { id: "broken/entry-without-pricing", name: "Broken" },
  ],
};

afterEach(() => {
  resetFreeModelCache();
  vi.restoreAllMocks();
});

describe("OpenRouter free models", () => {
  it("keeps models that cost nothing and answer with text, and drops the rest", () => {
    const models = parseFreeModels(CATALOGUE);

    expect(models.map((model) => model.id)).toEqual([
      "openrouter/free",
      "google/gemma-4-31b-it:free",
      "nvidia/nemotron-3.5-super-vl:free",
    ]);
    expect(models.find((model) => model.id === "openrouter/free")?.contextLength).toBe(200_000);
  });

  it("accepts a zero written as a number or a string, and rejects anything else", () => {
    expect(isFreeTextModel({ id: "a/b:free", pricing: { prompt: "0", completion: 0 }, architecture: { modality: "text->text" } })).toBe(true);
    expect(isFreeTextModel({ id: "a/b", pricing: { prompt: "0.0", completion: "0" }, architecture: { modality: "text->text" } })).toBe(false);
    expect(isFreeTextModel({ id: "a/b", pricing: { prompt: "0" }, architecture: { modality: "text->text" } })).toBe(false);
    expect(isFreeTextModel({ pricing: { prompt: "0", completion: "0" }, architecture: { modality: "text->text" } })).toBe(false);
  });

  it("falls back on output_modalities when modality is absent", () => {
    expect(isFreeTextModel({ id: "a/b", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] } })).toBe(true);
    expect(isFreeTextModel({ id: "a/b", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["image"] } })).toBe(false);
    expect(isFreeTextModel({ id: "a/b", pricing: { prompt: "0", completion: "0" }, architecture: {} })).toBe(false);
  });

  it("survives a payload that is not a catalogue", () => {
    expect(parseFreeModels(null)).toEqual([]);
    expect(parseFreeModels({ data: "nope" })).toEqual([]);
    expect(parseFreeModels({ error: { message: "rate limited" } })).toEqual([]);
  });

  it("returns an empty list when OpenRouter cannot be reached, without throwing", async () => {
    const offline = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await listFreeModels({ fetchImpl: offline });

    expect(result.models).toEqual([]);
    expect(result.fetchedAt).toBeNull();
  });

  it("caches a successful fetch and serves it without another request", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(CATALOGUE), { status: 200 })) as unknown as typeof fetch;

    const first = await listFreeModels({ fetchImpl: ok });
    const second = await listFreeModels({ fetchImpl: ok });

    expect(first.models.length).toBe(3);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
