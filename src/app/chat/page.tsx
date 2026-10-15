"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CitationList, Markdown } from "@/components/markdown";
import { Badge, Button, Card, CardTitle, EmptyState, Notice, Textarea, api } from "@/components/ui";
import type { Citation } from "@/lib/types/domain";

type Conversation = { id: string; title: string; updatedAt: string; messageCount?: number };
type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  citations: Citation[];
  createdAt: string;
  model: string | null;
};

type ScopeMode = "all" | "notes";

const EXISTING_KEY = "sb-chat-conversation";

export default function ChatPage() {
  const searchParams = useSearchParams();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamCitations, setStreamCitations] = useState<Citation[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<ScopeMode>("all");
  const [aiConfigured, setAiConfigured] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const initial = useMemo(() => searchParams.get("q") ?? "", [searchParams]);

  const loadConversations = useCallback(async () => {
    const result = await api<{ conversations: Conversation[] }>("/api/v1/conversations?limit=40");
    setConversations(result.conversations);
  }, []);

  const openConversation = useCallback(async (id: string) => {
    const result = await api<{ conversation: Conversation; messages: Message[] }>(`/api/v1/conversations/${id}`);
    setConversationId(result.conversation.id);
    setMessages(result.messages);
    setStreamText("");
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const stats = await api<{ aiConfigured: boolean }>("/api/v1/stats");
        setAiConfigured(stats.aiConfigured);
      } catch {
        setAiConfigured(false);
      }
      await loadConversations();
      const stored = window.localStorage.getItem(EXISTING_KEY);
      if (stored) {
        try {
          await openConversation(stored);
        } catch {
          window.localStorage.removeItem(EXISTING_KEY);
        }
      }
      if (initial) setInput(initial);
    })();
  }, [initial, loadConversations, openConversation]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamText]);

  async function send() {
    const question = input.trim();
    if (question.length === 0 || pending) return;
    setPending(true);
    setError(null);
    setNotice(null);
    setInput("");
    setStreamText("");
    setStreamCitations([]);

    const localUserMessage: Message = {
      id: `local-${Date.now()}`,
      role: "user",
      content: question,
      citations: [],
      createdAt: new Date().toISOString(),
      model: null,
    };
    setMessages((current) => [...current, localUserMessage]);

    try {
      const response = await fetch("/api/v1/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: question,
          conversationId,
          scope: { mode: scope },
        }),
      });
      if (!response.ok || !response.body) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assembled = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          const event = JSON.parse(payload) as Record<string, unknown>;
          if (event.type === "conversation" && typeof event.conversationId === "string") {
            setConversationId(event.conversationId);
            window.localStorage.setItem(EXISTING_KEY, event.conversationId);
          } else if (event.type === "citations" && Array.isArray(event.citations)) {
            setStreamCitations(event.citations as Citation[]);
          } else if (event.type === "delta" && typeof event.text === "string") {
            assembled += event.text;
            setStreamText(assembled);
          } else if (event.type === "notice" && typeof event.text === "string") {
            setNotice(event.text);
          } else if (event.type === "done" && typeof event.content === "string") {
            setMessages((current) => [
              ...current,
              {
                id: String(event.messageId ?? `assistant-${Date.now()}`),
                role: "assistant",
                content: event.content as string,
                citations: (event.citations ?? []) as Citation[],
                createdAt: new Date().toISOString(),
                model: (event.model as string | null) ?? null,
              },
            ]);
            setStreamText("");
            setStreamCitations([]);
          } else if (event.type === "error" && typeof event.message === "string") {
            throw new Error(event.message);
          }
        }
      }
      await loadConversations();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  async function newConversation() {
    window.localStorage.removeItem(EXISTING_KEY);
    setConversationId(null);
    setMessages([]);
    setStreamText("");
    setNotice(null);
  }

  async function deleteConversation(id: string) {
    await api(`/api/v1/conversations/${id}`, { method: "DELETE" });
    if (id === conversationId) await newConversation();
    await loadConversations();
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Hỏi đáp với bộ nhớ</h1>
          <p className="text-sm text-muted">
            Câu trả lời chỉ dựa trên dữ liệu của bạn và kèm trích dẫn. Chưa cấu hình model thì app trả về trích dẫn trực tiếp.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value as ScopeMode)}
            className="rounded-xl border border-line bg-raised px-3 py-1.5 text-sm"
          >
            <option value="all">Toàn bộ bộ nhớ</option>
            <option value="notes">Chỉ ghi chú</option>
          </select>
          <Button onClick={() => void newConversation()}>Cuộc trò chuyện mới</Button>
        </div>
      </header>

      {!aiConfigured ? (
        <Notice tone="warn">
          Chưa cấu hình model: mỗi câu hỏi sẽ trả về danh sách trích dẫn liên quan nhất.{" "}
          <Link href="/settings" className="underline">
            Thêm base URL/API key hoặc trỏ tới Ollama
          </Link>{" "}
          để có câu trả lời tổng hợp.
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card className="flex h-[70vh] min-w-0 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {messages.length === 0 && !streamText ? (
              <EmptyState
                title="Hỏi bất cứ điều gì về dữ liệu của bạn"
                hint="Ví dụ: “Tuần này tôi đã trao đổi gì với khách hàng A?”, “Tìm slide về kiến trúc thanh toán”, “Việc nào còn dang dở?”"
              />
            ) : null}

            {messages.map((message) => (
              <div key={message.id} className={message.role === "user" ? "text-right" : ""}>
                <div
                  className={`inline-block max-w-full rounded-2xl px-4 py-3 text-left ${
                    message.role === "user" ? "bg-accent/15" : "border border-line bg-raised"
                  }`}
                >
                  {message.role === "assistant" ? (
                    <Markdown citations={message.citations}>{message.content}</Markdown>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                  )}
                </div>
                {message.role === "assistant" && message.citations.length > 0 ? (
                  <details className="mt-2 text-left">
                    <summary className="cursor-pointer text-xs text-muted">Nguồn tham chiếu ({message.citations.length})</summary>
                    <div className="mt-2 rounded-xl border border-line bg-surface p-3">
                      <CitationList citations={message.citations} />
                    </div>
                  </details>
                ) : null}
              </div>
            ))}

            {streamText ? (
              <div>
                <div className="inline-block max-w-full rounded-2xl border border-line bg-raised px-4 py-3">
                  <Markdown citations={streamCitations}>{streamText}</Markdown>
                </div>
              </div>
            ) : null}

            {pending && !streamText ? <p className="text-xs text-muted">Đang tìm trong bộ nhớ…</p> : null}
          </div>

          <div className="mt-3 border-t border-line pt-3">
            {notice ? <div className="mb-2"><Notice>{notice}</Notice></div> : null}
            {error ? <div className="mb-2"><Notice tone="warn">{error}</Notice></div> : null}
            <div className="flex items-end gap-2">
              <Textarea
                value={input}
                onChange={setInput}
                rows={2}
                placeholder="Hỏi về email, ghi chú, lịch, tài liệu… (Enter để gửi, Shift+Enter xuống dòng)"
              />
              <Button variant="primary" onClick={() => void send()} disabled={pending}>
                Gửi
              </Button>
            </div>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardTitle hint={`${conversations.length}`}>Lịch sử</CardTitle>
            {conversations.length === 0 ? (
              <p className="text-xs text-muted">Chưa có cuộc trò chuyện nào.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {conversations.map((conversation) => (
                  <li key={conversation.id} className="group flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void openConversation(conversation.id)}
                      className={`flex-1 truncate text-left ${conversation.id === conversationId ? "text-accent" : "hover:text-ink"}`}
                    >
                      {conversation.title}
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteConversation(conversation.id)}
                      className="text-[11px] text-muted opacity-0 transition group-hover:opacity-100"
                    >
                      xoá
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardTitle>Cách trả lời hoạt động</CardTitle>
            <ol className="list-decimal space-y-1 pl-4 text-xs text-muted">
              <li>Truy xuất lai lấy 8 đoạn liên quan nhất.</li>
              <li>Ghép thành ngữ cảnh có số thứ tự [1], [2]…</li>
              <li>Model trả lời và bắt buộc trích dẫn theo số.</li>
              <li>Nếu model lỗi, app tự lùi về chế độ trích dẫn trực tiếp.</li>
            </ol>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge>trích dẫn bắt buộc</Badge>
              <Badge>không gửi dữ liệu ngoài ý muốn</Badge>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
