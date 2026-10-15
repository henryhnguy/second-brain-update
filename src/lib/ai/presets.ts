/**
 * Provider presets for the model configuration.
 *
 * Every entry is reached through the same OpenAI-compatible client
 * (`lib/ai/provider.ts`), so a preset only has to supply the endpoint — and a
 * model id where the provider documents one. Catalogues change often: where a
 * preset has no id for a field, the field keeps whatever the user typed and the
 * UI points at the provider's model list instead of guessing.
 *
 * Verified endpoints:
 * - OpenRouter   https://openrouter.ai/api/v1
 * - Gemini       https://generativelanguage.googleapis.com/v1beta/openai/
 */

export type AiPresetId = "openai" | "openrouter" | "gemini" | "ollama" | "lmstudio" | "custom";

export type AiPreset = {
  id: AiPresetId;
  label: string;
  baseUrl: string;
  chatModel?: string;
  embedModel?: string;
  /** Where to pick a model when the preset does not fill one in. */
  modelsUrl?: string;
  note: string;
};

export const AI_PRESETS: AiPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    chatModel: "gpt-4o-mini",
    embedModel: "text-embedding-3-small",
    modelsUrl: "https://platform.openai.com/docs/models",
    note: "Chat and embeddings.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    modelsUrl: "https://openrouter.ai/models",
    note: "Many models behind one key, embeddings included. Model ids look like vendor/model — pick them from the list.",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    chatModel: "gemini-3.8-flash",
    modelsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    note: "Google's OpenAI-compatible endpoint: chat, embeddings and images. Set the embedding model from the docs before backfilling vectors.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    chatModel: "llama3.1",
    embedModel: "nomic-embed-text",
    note: "Runs on this machine. No key needed.",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    note: "Runs on this machine. No key needed; the model id is whatever LM Studio has loaded.",
  },
  {
    id: "custom",
    label: "Custom endpoint",
    baseUrl: "",
    note: "Any gateway that speaks the OpenAI protocol.",
  },
];

export function aiPreset(id: AiPresetId): AiPreset | null {
  return AI_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * The preset a base URL belongs to, so the selector can show where you are.
 * Falling back to `custom` keeps the control honest for an edited endpoint.
 */
export function presetForBaseUrl(baseUrl: string): AiPresetId {
  const normalised = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  const match = AI_PRESETS.find(
    (preset) => preset.baseUrl.length > 0 && preset.baseUrl.replace(/\/+$/, "").toLowerCase() === normalised,
  );
  return match?.id ?? "custom";
}
