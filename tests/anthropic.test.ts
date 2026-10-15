import { describe, expect, it } from "vitest";

import { anthropicComplete, anthropicEndpoint, anthropicStream, toAnthropicMessages, type AnthropicConfig } from "@/lib/ai/anthropic";
import type { ChatStreamEvent } from "@/lib/ai/provider";

// The client only needs a non-empty string; nothing here talks to the network.
const CONFIG: AnthropicConfig = {
  apiKey: process.env.SB_ANTHROPIC_API_KEY ?? "verify-only",
  model: "claude-test-model",
  maxTokens: 512,
  temperature: 0,
};

type Seen = { url: string; init: RequestInit } | null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(events: unknown[]): Response {
  const text = events
    .map((event) => `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function recorder(payload: Response, seen: { current: Seen }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.current = { url: String(url), init: init ?? {} };
    return payload;
  }) as typeof fetch;
}

describe("anthropic client", () => {
  it("hoists the system prompt and flattens the text blocks", async () => {
    const seen: { current: Seen } = { current: null };
    const fetchImpl = recorder(
      jsonResponse({
        model: "claude-test-model",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "there" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
      seen,
    );

    const result = await anthropicComplete(
      [
        { role: "system", content: "You are terse." },
        { role: "user", content: "Hi" },
      ],
      { config: CONFIG, fetchImpl },
    );

    expect(seen.current?.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = seen.current?.init.headers as Record<string, string>;
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(String(seen.current?.init.body)) as Record<string, unknown>;
    expect(body.system).toBe("You are terse.");
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(body.max_tokens).toBe(512);
    expect(body.stream).toBe(false);

    expect(result.content).toBe("Hello there");
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 3, totalTokens: 15 });
    expect(result.finishReason).toBe("end_turn");
  });

  it("honours a gateway base URL and an explicit model", async () => {
    const seen: { current: Seen } = { current: null };
    const fetchImpl = recorder(jsonResponse({ content: [{ type: "text", text: "ok" }] }), seen);

    await anthropicComplete([{ role: "user", content: "Hi" }], {
      config: { ...CONFIG, baseUrl: "https://gateway.example.com/" },
      model: "claude-other",
      maxTokens: 64,
      fetchImpl,
    });

    expect(seen.current?.url).toBe("https://gateway.example.com/v1/messages");
    const body = JSON.parse(String(seen.current?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("claude-other");
    expect(body.max_tokens).toBe(64);
  });

  it("translates the typed SSE events into the shared stream shape", async () => {
    const seen: { current: Seen } = { current: null };
    const fetchImpl = recorder(
      sseResponse([
        { type: "message_start", message: { model: "claude-test-model", usage: { input_tokens: 7 } } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
        { type: "ping" },
        { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ]),
      seen,
    );

    const events: ChatStreamEvent[] = [];
    for await (const event of anthropicStream([{ role: "user", content: "Hi" }], { config: CONFIG, fetchImpl })) {
      events.push(event);
    }

    const text = events.filter((event) => event.type === "delta").map((event) => (event.type === "delta" ? event.text : "")).join("");
    expect(text).toBe("Hello");

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.model).toBe("claude-test-model");
      expect(done.finishReason).toBe("end_turn");
      expect(done.usage).toEqual({ promptTokens: 7, completionTokens: 2, totalTokens: 9 });
    }

    const body = JSON.parse(String(seen.current?.init.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
  });

  it("maps provider failures onto the app's error kinds", async () => {
    const unauthorized = recorder(jsonResponse({ error: { type: "authentication_error", message: "invalid x-api-key" } }, 401), {
      current: null,
    });
    await expect(anthropicComplete([{ role: "user", content: "Hi" }], { config: CONFIG, fetchImpl: unauthorized })).rejects.toThrow(
      /rejected the credentials/,
    );

    const limited = recorder(jsonResponse({ error: { type: "rate_limit_error", message: "slow down" } }, 429), { current: null });
    await expect(anthropicComplete([{ role: "user", content: "Hi" }], { config: CONFIG, fetchImpl: limited })).rejects.toMatchObject({
      code: "rate_limited",
    });

    const broken = recorder(jsonResponse({ error: { type: "api_error", message: "boom" } }, 503), { current: null });
    await expect(anthropicComplete([{ role: "user", content: "Hi" }], { config: CONFIG, fetchImpl: broken })).rejects.toMatchObject({
      code: "upstream_error",
      retryable: true,
    });
  });

  it("joins several system messages and reports the endpoint", () => {
    expect(toAnthropicMessages([{ role: "system", content: "one" }, { role: "assistant", content: "two" }, { role: "system", content: "three" }])).toEqual({
      system: "one\n\nthree",
      messages: [{ role: "assistant", content: "two" }],
    });
    expect(anthropicEndpoint({ apiKey: "x", model: "m", maxTokens: 1 })).toBe("https://api.anthropic.com/v1/messages");
  });
});
