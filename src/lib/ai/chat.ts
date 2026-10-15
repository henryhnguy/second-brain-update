import { AppError } from "../core/errors";
import { createLogger } from "../core/logger";
import {
  appendMessage,
  getOrCreateConversation,
  maybeAutoTitle,
  recentMessages,
} from "../db/repo/chat";
import { collectionDocumentIds } from "../db/repo/collections";
import { retrievePassages, type RetrievalDeps } from "../retrieval/hybrid";
import type { ChatAnswer, ChatRequest, ChatScope, Citation, SearchFilters } from "../types/domain";
import { getAiConfig, type AiConfig } from "./config";
import { chatStream, type ChatMessage } from "./provider";
import { RAG_SYSTEM_PROMPT, buildExtractiveAnswer, buildRagUserMessage } from "./prompts";

const logger = createLogger("ai:chat");

export type AnswerEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "citations"; citations: Citation[] }
  | { type: "delta"; text: string }
  | { type: "notice"; text: string }
  | {
      type: "done";
      conversationId: string;
      messageId: string;
      content: string;
      citations: Citation[];
      model: string | null;
      usage: Record<string, unknown>;
      usedLlm: boolean;
    }
  | { type: "error"; code: string; message: string };

export type ChatDeps = {
  retrieval?: RetrievalDeps;
  fetchImpl?: typeof fetch;
  config?: AiConfig;
};

/** Turns a chat scope into search filters. */
export function scopeFilters(scope: ChatScope | undefined): SearchFilters | undefined {
  if (!scope) return undefined;
  const filters: SearchFilters = {};
  if (scope.mode === "notes") filters.sources = ["note"];
  if (scope.mode === "documents" && scope.documentIds && scope.documentIds.length > 0) {
    filters.documentIds = scope.documentIds;
  }
  if (scope.mode === "collection" && scope.collectionId) {
    const ids = collectionDocumentIds(scope.collectionId, 800);
    filters.documentIds = ids.length > 0 ? ids : ["__none__"];
  }
  if (scope.since) filters.since = scope.since;
  return Object.keys(filters).length > 0 ? filters : undefined;
}

function historyFor(messages: { role: string; content: string }[], limit = 8): ChatMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-limit)
    .map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content }));
}

/**
 * Streams an answer grounded in the local memory. Without a configured model it
 * still answers — with a deterministic digest of the best matching passages.
 */
export async function* streamAnswer(request: ChatRequest, deps: ChatDeps = {}): AsyncGenerator<AnswerEvent, void, unknown> {
  const config = deps.config ?? getAiConfig();
  const message = request.message.trim();
  if (message.length === 0) {
    yield { type: "error", code: "bad_request", message: "Câu hỏi đang trống." };
    return;
  }

  const conversation = getOrCreateConversation({
    conversationId: request.conversationId ?? null,
    scope: request.scope,
    model: config.chatModel,
  });
  yield { type: "conversation", conversationId: conversation.id };
  maybeAutoTitle(conversation.id, message);
  appendMessage({ conversationId: conversation.id, role: "user", content: message });

  const scope = request.scope ?? conversation.scope;
  const filters = scopeFilters(scope);
  const history = historyFor(recentMessages(conversation.id, 10).slice(0, -1));

  let citations: Citation[] = [];
  let context = "";
  try {
    const retrieved = await retrievePassages(message, {
      ...(filters ? { filters } : {}),
      limit: config.contextChunks,
      ...(deps.retrieval ? { deps: deps.retrieval } : {}),
    });
    citations = retrieved.citations;
    context = retrieved.context;
  } catch (error) {
    logger.warn("retrieval failed for chat turn", { error: error instanceof Error ? error.message : String(error) });
  }

  yield { type: "citations", citations };

  if (!config.configured) {
    const text = buildExtractiveAnswer(message, citations);
    yield { type: "notice", text: "Chưa cấu hình model — hiển thị trích dẫn trực tiếp từ bộ nhớ." };
    yield { type: "delta", text };
    const stored = appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: text,
      citations,
      model: null,
      usage: { mode: "extractive" },
    });
    yield {
      type: "done",
      conversationId: conversation.id,
      messageId: stored.id,
      content: text,
      citations,
      model: null,
      usage: { mode: "extractive" },
      usedLlm: false,
    };
    return;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: RAG_SYSTEM_PROMPT },
    ...history,
    { role: "user", content: buildRagUserMessage(message, context, config.systemExtra) },
  ];

  let buffer = "";
  let model: string | null = config.chatModel;
  let usage: Record<string, unknown> = {};
  let failure: AppError | null = null;

  try {
    for await (const event of chatStream(messages, {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      config,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    })) {
      if (event.type === "delta") {
        buffer += event.text;
        yield { type: "delta", text: event.text };
      } else {
        model = event.model;
        usage = { ...event.usage, finishReason: event.finishReason };
      }
    }
  } catch (error) {
    failure = error instanceof AppError ? error : new AppError("upstream_error", error instanceof Error ? error.message : String(error));
  }

  if (failure && buffer.trim().length === 0) {
    logger.warn("model call failed; falling back to extractive answer", { error: failure.message });
    const fallback = `${buildExtractiveAnswer(message, citations)}\n\n> Lưu ý: gọi model thất bại (${failure.code}). Nội dung trên lấy trực tiếp từ bộ nhớ.`;
    yield { type: "notice", text: `Model lỗi: ${failure.message}` };
    yield { type: "delta", text: fallback };
    const stored = appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: fallback,
      citations,
      model: null,
      usage: { mode: "extractive-fallback", error: failure.code },
    });
    yield {
      type: "done",
      conversationId: conversation.id,
      messageId: stored.id,
      content: fallback,
      citations,
      model: null,
      usage: { mode: "extractive-fallback" },
      usedLlm: false,
    };
    return;
  }

  if (failure) {
    yield { type: "notice", text: `Kết nối model bị ngắt: ${failure.message}` };
  }

  const content = buffer.trim().length > 0 ? buffer : buildExtractiveAnswer(message, citations);
  const stored = appendMessage({
    conversationId: conversation.id,
    role: "assistant",
    content,
    citations,
    model,
    usage,
  });

  yield {
    type: "done",
    conversationId: conversation.id,
    messageId: stored.id,
    content,
    citations,
    model,
    usage,
    usedLlm: true,
  };
}

export async function answer(request: ChatRequest, deps: ChatDeps = {}): Promise<ChatAnswer> {
  let conversationId = request.conversationId ?? "";
  let content = "";
  let citations: Citation[] = [];
  let model: string | null = null;
  let usage: Record<string, unknown> = {};
  let usedLlm = false;
  let messageId = "";

  for await (const event of streamAnswer(request, deps)) {
    if (event.type === "conversation") conversationId = event.conversationId;
    else if (event.type === "citations") citations = event.citations;
    else if (event.type === "delta") content += event.text;
    else if (event.type === "error") throw new AppError("upstream_error", event.message);
    else if (event.type === "done") {
      conversationId = event.conversationId;
      messageId = event.messageId;
      content = event.content;
      citations = event.citations;
      model = event.model;
      usage = event.usage;
      usedLlm = event.usedLlm;
    }
  }

  return { conversationId, messageId, content, citations, model, usage, usedLlm };
}
