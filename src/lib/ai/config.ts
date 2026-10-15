import { loadOrCreateKey, maskSecret, openSealed, seal } from "../crypto/secretbox";
import { aiEnvConfig, type AiMode } from "../core/env";
import { getSetting, setSetting } from "../db/repo/system";

/**
 * Effective AI configuration. Values saved in Settings win over environment
 * variables, so the app can be configured entirely from the UI — and still work
 * with no provider at all (keyword-only mode).
 */

export type AiConfig = {
  mode: AiMode;
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  embedModel: string;
  embedDim: number;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
  /** How many retrieved passages are handed to the model. */
  contextChunks: number;
  systemExtra: string;
  configured: boolean;
  source: "settings" | "env" | "none";
  /** True when the endpoint is on this machine and therefore needs no key. */
  isLocalEndpoint: boolean;
};

const K = {
  mode: "ai.mode",
  baseUrl: "ai.baseUrl",
  apiKey: "ai.apiKey",
  chatModel: "ai.chatModel",
  embedModel: "ai.embedModel",
  embedDim: "ai.embedDim",
  timeoutMs: "ai.timeoutMs",
  maxOutputTokens: "ai.maxOutputTokens",
  temperature: "ai.temperature",
  contextChunks: "ai.contextChunks",
  systemExtra: "ai.systemExtra",
} as const;

function parseNumber(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ["localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function getAiConfig(): AiConfig {
  const env = aiEnvConfig();
  const storedBase = getSetting(K.baseUrl);
  const storedKey = getSetting(K.apiKey);
  const storedMode = getSetting(K.mode);

  const baseUrl = storedBase ?? env.baseUrl;
  let apiKey = env.apiKey;
  let keyFromSettings = false;
  if (storedKey) {
    try {
      apiKey = openSealed(storedKey, loadOrCreateKey()) ?? "";
      keyFromSettings = true;
    } catch {
      apiKey = "";
    }
  }

  const mode = (storedMode as AiMode | null) ?? env.mode;
  const isLocalEndpoint = isLocalBaseUrl(baseUrl);
  const configured = mode !== "off" && baseUrl.length > 0 && (apiKey.length > 0 || isLocalEndpoint);
  const source: AiConfig["source"] = storedBase || storedKey || storedMode ? "settings" : apiKey ? "env" : "none";

  return {
    mode,
    baseUrl,
    apiKey,
    chatModel: getSetting(K.chatModel) ?? env.chatModel,
    embedModel: getSetting(K.embedModel) ?? env.embedModel,
    embedDim: parseNumber(getSetting(K.embedDim), env.embedDim),
    timeoutMs: parseNumber(getSetting(K.timeoutMs), env.requestTimeoutMs),
    maxOutputTokens: parseNumber(getSetting(K.maxOutputTokens), env.maxOutputTokens),
    temperature: parseNumber(getSetting(K.temperature), 0.2),
    contextChunks: Math.min(Math.max(parseNumber(getSetting(K.contextChunks), 8), 1), 40),
    systemExtra: getSetting(K.systemExtra) ?? "",
    configured,
    source,
    isLocalEndpoint,
    ...(keyFromSettings ? {} : {}),
  };
}

export type AiConfigPatch = {
  mode?: AiMode;
  baseUrl?: string;
  /** Plain key; sealed before storage. Pass empty string to clear. */
  apiKey?: string;
  chatModel?: string;
  embedModel?: string;
  embedDim?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
  contextChunks?: number;
  systemExtra?: string;
};

export function saveAiConfig(patch: AiConfigPatch): AiConfig {
  if (patch.mode !== undefined) setSetting(K.mode, patch.mode);
  if (patch.baseUrl !== undefined) setSetting(K.baseUrl, patch.baseUrl.trim());
  if (patch.chatModel !== undefined) setSetting(K.chatModel, patch.chatModel.trim());
  if (patch.embedModel !== undefined) setSetting(K.embedModel, patch.embedModel.trim());
  if (patch.embedDim !== undefined) setSetting(K.embedDim, String(patch.embedDim));
  if (patch.timeoutMs !== undefined) setSetting(K.timeoutMs, String(patch.timeoutMs));
  if (patch.maxOutputTokens !== undefined) setSetting(K.maxOutputTokens, String(patch.maxOutputTokens));
  if (patch.temperature !== undefined) setSetting(K.temperature, String(patch.temperature));
  if (patch.contextChunks !== undefined) setSetting(K.contextChunks, String(patch.contextChunks));
  if (patch.systemExtra !== undefined) setSetting(K.systemExtra, patch.systemExtra);
  if (patch.apiKey !== undefined) {
    if (patch.apiKey.trim().length === 0) setSetting(K.apiKey, "");
    else setSetting(K.apiKey, seal(patch.apiKey.trim(), loadOrCreateKey()));
  }
  return getAiConfig();
}

export function publicAiConfig(): Omit<AiConfig, "apiKey"> & { apiKeyMasked: string | null; hasApiKey: boolean } {
  const config = getAiConfig();
  const { apiKey, ...rest } = config;
  return { ...rest, apiKeyMasked: maskSecret(apiKey), hasApiKey: apiKey.length > 0 };
}

export function isAiConfigured(): boolean {
  return getAiConfig().configured;
}
