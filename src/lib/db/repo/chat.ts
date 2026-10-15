import { newId } from "../../core/ids";
import { truncate } from "../../core/text";
import { nowIso } from "../../core/time";
import type { ChatRole, ChatScope, Citation, Conversation, Message } from "../../types/domain";
import { getDb } from "../connection";
import { all, get, jsonParse, num, run, str, strOrNull } from "../sql";

function mapConversation(row: Record<string, unknown>): Conversation {
  return {
    id: str(row.id),
    title: str(row.title, "Conversation"),
    scope: jsonParse<ChatScope>(row.scope, { mode: "all" }),
    model: strOrNull(row.model),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    pinned: num(row.pinned) === 1,
    messageCount: row.message_count === undefined ? undefined : num(row.message_count),
  };
}

function mapMessage(row: Record<string, unknown>): Message {
  return {
    id: str(row.id),
    conversationId: str(row.conversation_id),
    role: str(row.role, "user") as ChatRole,
    content: str(row.content),
    citations: jsonParse<Citation[]>(row.citations, []),
    model: strOrNull(row.model),
    usage: jsonParse<Record<string, unknown>>(row.usage, {}),
    createdAt: str(row.created_at),
  };
}

export function createConversation(input: { title?: string; scope?: ChatScope; model?: string | null } = {}): Conversation {
  const id = newId("cnv");
  const at = nowIso();
  run(
    getDb(),
    "INSERT INTO conversations (id, title, scope, model, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
    [id, input.title ?? "New conversation", JSON.stringify(input.scope ?? { mode: "all" }), input.model ?? null, at, at],
  );
  const conversation = getConversation(id);
  if (!conversation) throw new Error("could not create conversation");
  return conversation;
}

export function getConversation(id: string): Conversation | null {
  const row = get<Record<string, unknown>>(getDb(), "SELECT * FROM conversations WHERE id = ?", [id]);
  return row ? mapConversation(row) : null;
}

export function getOrCreateConversation(input: { conversationId?: string | null; scope?: ChatScope; model?: string | null }): Conversation {
  if (input.conversationId) {
    const existing = getConversation(input.conversationId);
    if (existing) return existing;
  }
  return createConversation({ scope: input.scope, model: input.model ?? null });
}

export function listConversations(options: { limit?: number; withCounts?: boolean } = {}): Conversation[] {
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 200);
  if (options.withCounts) {
    return all<Record<string, unknown>>(
      getDb(),
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c ORDER BY c.updated_at DESC LIMIT ?`,
      [limit],
    ).map(mapConversation);
  }
  return all<Record<string, unknown>>(
    getDb(),
    "SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?",
    [limit],
  ).map(mapConversation);
}

export function renameConversation(id: string, title: string): void {
  run(getDb(), "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", [truncate(title, 120), nowIso(), id]);
}

export function touchConversation(id: string, scope?: ChatScope): void {
  if (scope) {
    run(getDb(), "UPDATE conversations SET updated_at = ?, scope = ? WHERE id = ?", [nowIso(), JSON.stringify(scope), id]);
    return;
  }
  run(getDb(), "UPDATE conversations SET updated_at = ? WHERE id = ?", [nowIso(), id]);
}

export function deleteConversation(id: string): boolean {
  const result = run(getDb(), "DELETE FROM conversations WHERE id = ?", [id]);
  run(getDb(), "DELETE FROM messages WHERE conversation_id = ?", [id]);
  return result.changes > 0;
}

export function clearConversations(): number {
  const db = getDb();
  const count = num((get<{ c: number }>(db, "SELECT COUNT(*) AS c FROM conversations") ?? { c: 0 }).c);
  run(db, "DELETE FROM messages");
  run(db, "DELETE FROM conversations");
  return count;
}

export function appendMessage(input: {
  conversationId: string;
  role: ChatRole;
  content: string;
  citations?: Citation[];
  model?: string | null;
  usage?: Record<string, unknown>;
}): Message {
  const id = newId("msg");
  const at = nowIso();
  run(
    getDb(),
    `INSERT INTO messages (id, conversation_id, role, content, citations, model, usage, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.conversationId,
      input.role,
      input.content,
      JSON.stringify(input.citations ?? []),
      input.model ?? null,
      JSON.stringify(input.usage ?? {}),
      at,
    ],
  );
  touchConversation(input.conversationId);
  const row = get<Record<string, unknown>>(getDb(), "SELECT * FROM messages WHERE id = ?", [id]);
  if (!row) throw new Error("could not append message");
  return mapMessage(row);
}

export function listMessages(conversationId: string, limit = 200): Message[] {
  return all<Record<string, unknown>>(
    getDb(),
    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?",
    [conversationId, Math.min(Math.max(limit, 1), 500)],
  ).map(mapMessage);
}

export function recentMessages(conversationId: string, limit = 8): Message[] {
  const rows = all<Record<string, unknown>>(
    getDb(),
    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?",
    [conversationId, Math.min(Math.max(limit, 1), 40)],
  ).map(mapMessage);
  return rows.reverse();
}

export function countConversations(): number {
  return num((get<{ c: number }>(getDb(), "SELECT COUNT(*) AS c FROM conversations") ?? { c: 0 }).c);
}

/** Fills in a conversation title from its first user message. */
export function maybeAutoTitle(conversationId: string, firstMessage: string): void {
  const conversation = getConversation(conversationId);
  if (!conversation) return;
  if (conversation.title && conversation.title !== "New conversation") return;
  const title = truncate(firstMessage.replace(/\s+/g, " ").trim(), 80);
  if (title.length > 0) renameConversation(conversationId, title);
}
