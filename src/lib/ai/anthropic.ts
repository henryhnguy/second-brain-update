/**
 * Anthropic Messages API client.
 *
 * A second chat dialect next to the OpenAI-compatible client in `provider.ts`.
 * Anthropic publishes no embeddings endpoint, so embeddings always go through
 * the OpenAI-compatible configuration — only chat can be routed here.
 *
 * Wire-format differences that matter, and are handled below:
 * - the system prompt is a top-level `system` field, not a message;
 * - `max_tokens` is required rather than optional;
 * - the reply is a `content` array of blocks, not `choices[0].message`;
 * - streaming uses typed SSE events (`content_block_delta`, `message_delta`)
 *   instead of uniform `choices[].delta` chunks.
 */

import { AppError } from "../core/errors";
import { createLogger } from "../core/logger";
import type { ChatMessage, ChatStreamEvent, ChatUsage } from "./provider";

const logger = createLogger("ai:anthropic");

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 60_000;
const VERSION_HEADER = "anthropic-version";
const API_KEY_HEADER = "x-api-key";

export type AnthropicConfig = {
  /** Defaults to the public API; point it at a gateway to proxy requests. */
  baseUrl?: string;
  apiKey: string;
  model: string;
  /** Required by the API. Callers pass the configured output budget. */
  maxTokens: number;
  temperature?: number;
  version?: string;
  timeoutMs?: number;
};

export type AnthropicResult = {
  content: string;
  model: string;
  usage: ChatUsage;
  finishReason: string | null;
};

export type AnthropicCallOptions = {
  config: AnthropicConfig;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

function baseUrl(config: AnthropicConfig): string {
  const raw = config.baseUrl && config.baseUrl.trim().length > 0 ? config.baseUrl : DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

export function anthropicEndpoint(config: AnthropicConfig): string {
  return `${baseUrl(config)}/v1/messages`;
}

function headers(config: AnthropicConfig, extra: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    [VERSION_HEADER]: config.version && config.version.length > 0 ? config.version : DEFAULT_VERSION,
    ...extra,
  };
  if (config.apiKey) result[API_KEY_HEADER] = config.apiKey;
  return result;
}

function timeoutSignal(config: AnthropicConfig, external?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Anthropic request timed out")),
    config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
  );
  controller.signal.addEventListener("abort", () => clearTimeout(timer));
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", () => controller.abort(external.reason));
  }
  return controller.signal;
}

/** Anthropic reports failures as `{ error: { type, message } }`. */
async function readErrorText(response: Response): Promise<string> {
  try {
    const raw = await response.text();
    try {
      const parsed = JSON.parse(raw) as { error?: { type?: string; message?: string } };
      const message = parsed.error?.message;
      if (message) return parsed.error?.type ? `${parsed.error.type}: ${message}` : message;
    } catch {
      /* fall through to the raw body */
    }
    return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
  } catch {
    return "";
  }
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await readErrorText(response);
  if (response.status === 401 || response.status === 403) {
    throw new AppError("unauthorized", `Anthropic rejected the credentials (${response.status}). ${body}`.trim());
  }
  if (response.status === 429) {
    throw new AppError("rate_limited", `Anthropic rate limited this request. ${body}`.trim(), { retryable: true });
  }
  if (response.status === 400 && /credit|billing|balance/i.test(body)) {
    throw new AppError("upstream_error", `Anthropic refused the request: ${body}`.trim());
  }
  throw new AppError("upstream_error", `Anthropic error ${response.status}. ${body}`.trim(), {
    retryable: response.status >= 500,
  });
}

/** Splits the shared message list into Anthropic's `system` + `messages` pair. */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
} {
  const system: string[] = [];
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const message of messages) {
    if (message.role === "system") system.push(message.content);
    else turns.push({ role: message.role, content: message.content });
  }
  return { system: system.join("\n\n"), messages: turns };
}

function requestBody(
  messages: ChatMessage[],
  options: AnthropicCallOptions,
  stream: boolean,
): { body: string; model: string } {
  const { config } = options;
  const model = options.model && options.model.length > 0 ? options.model : config.model;
  const split = toAnthropicMessages(messages);
  const payload: Record<string, unknown> = {
    model,
    max_tokens: options.maxTokens ?? config.maxTokens,
    messages: split.messages,
    stream,
  };
  if (split.system.length > 0) payload.system = split.system;
  const temperature = options.temperature ?? config.temperature;
  if (temperature !== undefined) payload.temperature = temperature;
  return { body: JSON.stringify(payload), model };
}

function textFromBlocks(blocks: { type?: string; text?: string }[] | undefined): string {
  return (blocks ?? [])
    .filter((block) => block.type === "text" || typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

export async function anthropicComplete(messages: ChatMessage[], options: AnthropicCallOptions): Promise<AnthropicResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { body, model } = requestBody(messages, options, false);
  const response = await fetchImpl(anthropicEndpoint(options.config), {
    method: "POST",
    headers: headers(options.config),
    body,
    signal: timeoutSignal(options.config, options.signal),
  });
  await assertOk(response);

  const payload = (await response.json()) as {
    model?: string;
    content?: { type?: string; text?: string }[];
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  return {
    content: textFromBlocks(payload.content),
    model: payload.model ?? model,
    usage: {
      promptTokens: payload.usage?.input_tokens,
      completionTokens: payload.usage?.output_tokens,
      totalTokens: (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0) || undefined,
    },
    finishReason: payload.stop_reason ?? null,
  };
}

type AnthropicStreamPayload = {
  type?: string;
  message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
};

/** Streams a completion, translating Anthropic's typed events into the shared shape. */
export async function* anthropicStream(
  messages: ChatMessage[],
  options: AnthropicCallOptions,
): AsyncGenerator<ChatStreamEvent, void, unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { body, model } = requestBody(messages, options, true);
  const response = await fetchImpl(anthropicEndpoint(options.config), {
    method: "POST",
    headers: headers(options.config, { accept: "text/event-stream" }),
    body,
    signal: timeoutSignal(options.config, options.signal),
  });
  await assertOk(response);
  if (!response.body) throw new AppError("upstream_error", "Anthropic returned an empty stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const usage: ChatUsage = {};
  let finishReason: string | null = null;
  let seenModel = model;
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data.length === 0) continue;

      let parsed: AnthropicStreamPayload;
      try {
        parsed = JSON.parse(data) as AnthropicStreamPayload;
      } catch {
        logger.debug("ignored malformed stream chunk", { data: data.slice(0, 120) });
        continue;
      }

      if (parsed.type === "error") {
        throw new AppError("upstream_error", `Anthropic stream error: ${parsed.error?.message ?? "unknown"}`);
      }
      if (parsed.message?.model) seenModel = parsed.message.model;
      if (parsed.message?.usage?.input_tokens !== undefined) usage.promptTokens = parsed.message.usage.input_tokens;
      if (parsed.usage?.output_tokens !== undefined) usage.completionTokens = parsed.usage.output_tokens;
      if (parsed.delta?.stop_reason) finishReason = parsed.delta.stop_reason;
      if (parsed.delta?.text) yield { type: "delta", text: parsed.delta.text };
    }
  }

  usage.totalTokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0) || undefined;
  yield { type: "done", model: seenModel, usage, finishReason };
}
