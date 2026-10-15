import { AppError, aiNotConfigured } from "../core/errors";
import { createLogger } from "../core/logger";
import { getAiConfig, type AiConfig } from "./config";

/**
 * One OpenAI-compatible client. OpenAI, OpenRouter, Groq, Azure-style gateways,
 * LM Studio and Ollama (`http://localhost:11434/v1`) all speak this dialect, so
 * there is exactly one code path to test and document.
 */

const logger = createLogger("ai");

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ChatResult = {
  content: string;
  model: string;
  usage: ChatUsage;
  finishReason: string | null;
};

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; model: string; usage: ChatUsage; finishReason: string | null };

export type AiCallDeps = {
  fetchImpl?: typeof fetch;
  config?: AiConfig;
  signal?: AbortSignal;
};

function resolveDeps(deps: AiCallDeps | undefined, requireKey: boolean): { config: AiConfig; fetchImpl: typeof fetch } {
  const config = deps?.config ?? getAiConfig();
  if (config.mode === "off") throw aiNotConfigured();
  if (!config.baseUrl) throw aiNotConfigured();
  if (requireKey && !config.apiKey && !config.isLocalEndpoint) throw aiNotConfigured();
  return { config, fetchImpl: deps?.fetchImpl ?? fetch };
}

function endpoint(config: AiConfig, path: string): string {
  return `${config.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function headers(config: AiConfig, extra: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...extra,
  };
  if (config.apiKey) result.authorization = `Bearer ${config.apiKey}`;
  return result;
}

async function readErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return "";
  }
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await readErrorText(response);
  if (response.status === 401 || response.status === 403) {
    throw new AppError("unauthorized", `AI provider rejected the credentials (${response.status}). ${body}`.trim());
  }
  if (response.status === 429) {
    throw new AppError("rate_limited", `AI provider rate limited this request. ${body}`.trim(), { retryable: true });
  }
  throw new AppError("upstream_error", `AI provider error ${response.status}. ${body}`.trim(), { retryable: response.status >= 500 });
}

function timeoutSignal(config: AiConfig, external?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("AI request timed out")), config.timeoutMs);
  const cleanup = () => clearTimeout(timer);
  controller.signal.addEventListener("abort", cleanup);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", () => controller.abort(external.reason));
  }
  return controller.signal;
}

export function isAiAvailable(deps?: { config?: AiConfig }): boolean {
  return (deps?.config ?? getAiConfig()).configured;
}

export async function chatComplete(
  messages: ChatMessage[],
  options: { model?: string; temperature?: number; maxTokens?: number } & AiCallDeps = {},
): Promise<ChatResult> {
  const { config, fetchImpl } = resolveDeps(options, true);
  const model = options.model ?? config.chatModel;
  const response = await fetchImpl(endpoint(config, "chat/completions"), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? config.temperature,
      max_tokens: options.maxTokens ?? config.maxOutputTokens,
      stream: false,
    }),
    signal: timeoutSignal(config, options.signal),
  });
  await assertOk(response);
  const payload = (await response.json()) as {
    model?: string;
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const choice = payload.choices?.[0];
  return {
    content: choice?.message?.content ?? "",
    model: payload.model ?? model,
    usage: {
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
      totalTokens: payload.usage?.total_tokens,
    },
    finishReason: choice?.finish_reason ?? null,
  };
}

/** Streaming chat completion over server-sent events. */
export async function* chatStream(
  messages: ChatMessage[],
  options: { model?: string; temperature?: number; maxTokens?: number } & AiCallDeps = {},
): AsyncGenerator<ChatStreamEvent, void, unknown> {
  const { config, fetchImpl } = resolveDeps(options, true);
  const model = options.model ?? config.chatModel;
  const response = await fetchImpl(endpoint(config, "chat/completions"), {
    method: "POST",
    headers: headers(config, { accept: "text/event-stream" }),
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? config.temperature,
      max_tokens: options.maxTokens ?? config.maxOutputTokens,
      stream: true,
    }),
    signal: timeoutSignal(config, options.signal),
  });
  await assertOk(response);
  if (!response.body) throw new AppError("upstream_error", "AI provider returned an empty stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const usage: ChatUsage = {};
  let finishReason: string | null = null;
  let seenModel = model;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const rawLine of parts) {
      const line = rawLine.trim();
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        yield { type: "done", model: seenModel, usage, finishReason };
        return;
      }
      try {
        const parsed = JSON.parse(data) as {
          model?: string;
          choices?: { delta?: { content?: string }; finish_reason?: string }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        if (parsed.model) seenModel = parsed.model;
        const choice = parsed.choices?.[0];
        const text = choice?.delta?.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (parsed.usage) {
          usage.promptTokens = parsed.usage.prompt_tokens;
          usage.completionTokens = parsed.usage.completion_tokens;
          usage.totalTokens = parsed.usage.total_tokens;
        }
        if (text) yield { type: "delta", text };
      } catch {
        logger.debug("ignored malformed stream chunk", { data: data.slice(0, 120) });
      }
    }
  }
  yield { type: "done", model: seenModel, usage, finishReason };
}

export type EmbedResult = {
  vectors: Float32Array[];
  model: string;
  dim: number;
};

/** Embeds texts in batches; returns float32 vectors in input order. */
export async function embedTexts(
  texts: string[],
  options: { model?: string; batchSize?: number; dim?: number } & AiCallDeps = {},
): Promise<EmbedResult> {
  const { config, fetchImpl } = resolveDeps(options, false);
  const model = options.model ?? config.embedModel;
  const batchSize = Math.min(Math.max(options.batchSize ?? 32, 1), 128);
  const vectors: Float32Array[] = [];

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize).map((text) => (text.length === 0 ? " " : text));
    const body: Record<string, unknown> = { model, input: batch };
    if (options.dim && options.dim > 0) body.dimensions = options.dim;
    const response = await fetchImpl(endpoint(config, "embeddings"), {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify(body),
      signal: timeoutSignal(config, options.signal),
    });
    await assertOk(response);
    const payload = (await response.json()) as {
      data?: { embedding?: number[]; index?: number }[];
      model?: string;
    };
    const items = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const item of items) {
      if (Array.isArray(item.embedding)) vectors.push(Float32Array.from(item.embedding));
    }
  }

  const dim = vectors[0]?.length ?? 0;
  return { vectors, model, dim };
}

export async function embedOne(text: string, options: { model?: string } & AiCallDeps = {}): Promise<Float32Array | null> {
  const { vectors } = await embedTexts([text], options);
  return vectors[0] ?? null;
}

/** Lightweight connectivity check used by the Settings page. */
export async function checkConnection(deps?: AiCallDeps): Promise<{ ok: boolean; model?: string; error?: string; latencyMs: number }> {
  const started = Date.now();
  try {
    const result = await chatComplete([{ role: "user", content: "ping" }], {
      ...deps,
      maxTokens: 8,
      temperature: 0,
    });
    return { ok: true, model: result.model, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started };
  }
}
