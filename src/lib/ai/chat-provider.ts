/**
 * Picks the dialect the chat path speaks.
 *
 * `provider.ts` owns the OpenAI-compatible client and `anthropic.ts` the
 * Anthropic Messages API. Callers ask here, so nothing else in the app has to
 * know which provider is configured. Embeddings are deliberately not routed
 * here: Anthropic publishes no embeddings endpoint, so they always go through
 * the OpenAI-compatible client.
 *
 * Selection order is the app's usual one — a value saved in Settings wins over
 * the environment:
 *
 *   ai.chatProvider   /  SB_AI_CHAT_PROVIDER   = openai_compatible | anthropic
 *   ai.anthropicApiKey / SB_ANTHROPIC_API_KEY  = the Anthropic key
 *   ai.anthropicBaseUrl / SB_ANTHROPIC_BASE_URL = optional gateway
 *
 * The model name is shared with the OpenAI-compatible path (`ai.chatModel` /
 * `SB_AI_CHAT_MODEL`), so switching providers does not mean maintaining a second
 * model setting.
 */

import { aiNotConfigured } from "../core/errors";
import { envStr } from "../core/env";
import { loadOrCreateKey, openSealed } from "../crypto/secretbox";
import { getSetting } from "../db/repo/system";
import { anthropicComplete, anthropicStream, type AnthropicCallOptions, type AnthropicConfig } from "./anthropic";
import { getAiConfig, type AiConfig } from "./config";
import {
  chatComplete as openAiCompatibleComplete,
  chatStream as openAiCompatibleStream,
  type AiCallDeps,
  type ChatMessage,
  type ChatResult,
  type ChatStreamEvent,
} from "./provider";

const CHAT_PROVIDER_SETTING = "ai.chatProvider";
const ANTHROPIC_KEY_SETTING = "ai.anthropicApiKey";
const ANTHROPIC_BASE_URL_SETTING = "ai.anthropicBaseUrl";

export type ChatProviderId = "openai_compatible" | "anthropic";

export type ChatCallOptions = { model?: string; temperature?: number; maxTokens?: number } & AiCallDeps;

/** Which dialect to use. Anything unrecognised falls back to the default. */
export function chatProviderId(): ChatProviderId {
  const stored = getSetting(CHAT_PROVIDER_SETTING);
  const value = (stored ?? envStr("SB_AI_CHAT_PROVIDER", "openai_compatible")).trim().toLowerCase();
  return value === "anthropic" ? "anthropic" : "openai_compatible";
}

/**
 * The Anthropic key: sealed in Settings when present, otherwise the environment.
 * Returns an empty string when neither is set, which reads as "not configured".
 */
function anthropicKey(): string {
  const stored = getSetting(ANTHROPIC_KEY_SETTING);
  if (stored) {
    try {
      const opened = openSealed(stored, loadOrCreateKey());
      if (opened) return opened;
    } catch {
      /* an unreadable sealed value falls back to the environment */
    }
  }
  return envStr("SB_ANTHROPIC_API_KEY", "");
}

/** Anthropic settings, or null when there is no key to use. */
function anthropicConfig(config: AiConfig): AnthropicConfig | null {
  const chatKey = anthropicKey();
  if (chatKey.length === 0) return null;
  return {
    apiKey: chatKey,
    baseUrl: getSetting(ANTHROPIC_BASE_URL_SETTING) ?? envStr("SB_ANTHROPIC_BASE_URL", ""),
    model: config.chatModel,
    maxTokens: config.maxOutputTokens,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
  };
}

function anthropicCallOptions(anthropic: AnthropicConfig, options: ChatCallOptions): AnthropicCallOptions {
  const temperature = options.temperature ?? anthropic.temperature;
  return {
    config: anthropic,
    ...(options.model ? { model: options.model } : {}),
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
}

/** Resolves the Anthropic client for one call, or reports that it is unusable. */
function requireAnthropic(options: AiCallDeps): AnthropicConfig {
  const config = options.config ?? getAiConfig();
  if (config.mode === "off") throw aiNotConfigured();
  const anthropic = anthropicConfig(config);
  if (!anthropic) throw aiNotConfigured();
  return anthropic;
}

/** True when the selected chat provider has everything it needs to answer. */
export function chatConfigured(): boolean {
  const config = getAiConfig();
  if (config.mode === "off") return false;
  if (chatProviderId() === "anthropic") return anthropicConfig(config) !== null;
  return config.configured;
}

export async function chatComplete(messages: ChatMessage[], options: ChatCallOptions = {}): Promise<ChatResult> {
  if (chatProviderId() === "anthropic") {
    return anthropicComplete(messages, anthropicCallOptions(requireAnthropic(options), options));
  }
  return openAiCompatibleComplete(messages, options);
}

export async function* chatStream(
  messages: ChatMessage[],
  options: ChatCallOptions = {},
): AsyncGenerator<ChatStreamEvent, void, unknown> {
  if (chatProviderId() === "anthropic") {
    yield* anthropicStream(messages, anthropicCallOptions(requireAnthropic(options), options));
    return;
  }
  yield* openAiCompatibleStream(messages, options);
}

/** Lightweight connectivity check used by the Settings page. */
export async function checkConnection(deps?: AiCallDeps): Promise<{ ok: boolean; model?: string; error?: string; latencyMs: number }> {
  const started = Date.now();
  try {
    const result = await chatComplete([{ role: "user", content: "ping" }], {
      ...(deps ?? {}),
      maxTokens: 8,
      temperature: 0,
    });
    return { ok: true, model: result.model, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started };
  }
}
