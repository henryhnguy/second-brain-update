import { newId } from "../../core/ids";
import { createLogger } from "../../core/logger";
import { normalizeWhitespace, slugify, truncate } from "../../core/text";
import { nowIso } from "../../core/time";
import type { Doc, Note, NoteTag } from "../../types/domain";
import { getDb } from "../connection";
import { all, get, num, run, str, strOrNull, transaction } from "../sql";
import { getDocument, listDocuments, setDocumentPinned, upsertDocument } from "./documents";
import { recordEvent } from "./system";
import { applyEnrichment, backfillWikiLinks, linkTags, syncWikiLinks, upsertTag } from "../../ingest/enrich";
import { chunkText } from "../../ingest/chunker";

const logger = createLogger("notes");

const NOTE_SOURCE_ID = "note";

export type CreateNoteInput = {
  title?: string;
  markdown?: string;
  tags?: string[];
  pinned?: boolean;
};

export type UpdateNotePatch = {
  title?: string;
  markdown?: string;
  tags?: string[];
  pinned?: boolean;
};

function noteBody(documentId: string): string {
  const row = get<{ markdown: string }>(getDb(), "SELECT markdown FROM note_bodies WHERE document_id = ?", [
    documentId,
  ]);
  return row?.markdown ?? "";
}

export function tagsForDocument(documentId: string): NoteTag[] {
  return all<Record<string, unknown>>(
    getDb(),
    `SELECT t.id, t.name, t.slug, t.color FROM tags t
     JOIN document_tags dt ON dt.tag_id = t.id WHERE dt.document_id = ? ORDER BY t.name`,
    [documentId],
  ).map((row) => ({
    id: str(row.id),
    name: str(row.name),
    slug: str(row.slug),
    color: strOrNull(row.color),
  }));
}

export function listTags(): NoteTag[] {
  return all<Record<string, unknown>>(
    getDb(),
    `SELECT t.id, t.name, t.slug, t.color, COUNT(dt.document_id) AS c
     FROM tags t LEFT JOIN document_tags dt ON dt.tag_id = t.id
     GROUP BY t.id ORDER BY c DESC, t.name ASC`,
  ).map((row) => ({
    id: str(row.id),
    name: str(row.name),
    slug: str(row.slug),
    color: strOrNull(row.color),
    count: num(row.c),
  }));
}

export function backlinksFor(documentId: string): { documentId: string; title: string }[] {
  return all<Record<string, unknown>>(
    getDb(),
    `SELECT d.id AS document_id, d.title AS title
     FROM doc_links l JOIN documents d ON d.id = l.from_document_id
     WHERE l.to_document_id = ? AND d.deleted_at IS NULL ORDER BY d.title LIMIT 50`,
    [documentId],
  ).map((row) => ({ documentId: str(row.document_id), title: str(row.title) }));
}

function outgoingLinks(documentId: string): string[] {
  return all<{ to_slug: string }>(
    getDb(),
    "SELECT to_slug FROM doc_links WHERE from_document_id = ?",
    [documentId],
  ).map((row) => String(row.to_slug));
}

export function getNote(documentId: string): Note | null {
  const document = getDocument(documentId);
  if (!document) return null;
  return {
    document,
    markdown: noteBody(documentId),
    tags: tagsForDocument(documentId),
    links: outgoingLinks(documentId),
    backlinks: backlinksFor(documentId),
  };
}

function writeNoteBody(documentId: string, markdown: string): void {
  run(
    getDb(),
    `INSERT INTO note_bodies (document_id, markdown, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`,
    [documentId, markdown, nowIso()],
  );
}

/** Replaces a document's tags with the given set (manual tags only). */
export function setDocumentTags(documentId: string, tags: string[]): void {
  const db = getDb();
  transaction(db, () => {
    run(db, "DELETE FROM document_tags WHERE document_id = ? AND source = 'manual'", [documentId]);
    for (const tag of tags) {
      const tagId = upsertTag(tag);
      if (!tagId) continue;
      run(db, "INSERT OR IGNORE INTO document_tags (document_id, tag_id, source) VALUES (?, ?, 'manual')", [
        documentId,
        tagId,
      ]);
    }
  });
}

export function createNote(input: CreateNoteInput = {}): Note {
  const markdown = input.markdown ?? "";
  const title = (input.title ?? "").trim() || firstLineTitle(markdown) || "Ghi chú mới";
  const outcome = upsertDocument({
    sourceKind: "note",
    sourceId: NOTE_SOURCE_ID,
    externalId: null,
    title,
    text: markdown,
    chunks: chunkText(markdown),
    meta: { createdVia: "notes" },
  });
  writeNoteBody(outcome.documentId, markdown);
  if (input.tags && input.tags.length > 0) setDocumentTags(outcome.documentId, input.tags);
  if (input.pinned) setDocumentPinned(outcome.documentId, true);
  applyEnrichment(outcome.documentId, { text: markdown, tags: input.tags ?? [] });
  recordEvent({ kind: "note.created", title, documentId: outcome.documentId });
  const note = getNote(outcome.documentId);
  if (!note) throw new Error("note creation failed");
  return note;
}

export function updateNote(documentId: string, patch: UpdateNotePatch): Note | null {
  const existing = getDocument(documentId);
  if (!existing) return null;

  const markdown = patch.markdown ?? noteBody(documentId);
  const title = (patch.title ?? existing.title).trim() || firstLineTitle(markdown) || existing.title;

  upsertDocument({
    documentId,
    sourceKind: "note",
    sourceId: NOTE_SOURCE_ID,
    externalId: existing.externalId,
    title,
    text: markdown,
    chunks: chunkText(markdown),
    meta: existing.meta,
    createdAt: existing.createdAt,
  });
  writeNoteBody(documentId, markdown);
  if (patch.tags) setDocumentTags(documentId, patch.tags);
  if (patch.pinned !== undefined) setDocumentPinned(documentId, patch.pinned);
  if (patch.markdown !== undefined) {
    applyEnrichment(documentId, { text: markdown, tags: patch.tags ?? tagsForDocument(documentId).map((tag) => tag.name) });
    backfillWikiLinks();
  }
  recordEvent({ kind: "note.updated", title, documentId });
  return getNote(documentId);
}

export function deleteNote(documentId: string): boolean {
  const result = run(getDb(), "UPDATE documents SET deleted_at = ?, status = 'deleted' WHERE id = ? AND source_kind = 'note'", [
    nowIso(),
    documentId,
  ]);
  if (result.changes > 0) recordEvent({ kind: "note.deleted", title: documentId, documentId });
  return result.changes > 0;
}

export type NoteListItem = {
  document: Doc;
  excerpt: string;
  tags: NoteTag[];
};

export function listNotes(
  options: { limit?: number; offset?: number; tag?: string | null; query?: string | null; pinnedOnly?: boolean } = {},
): { items: NoteListItem[]; total: number } {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const clauses: string[] = ["source_kind = 'note'", "deleted_at IS NULL"];
  const params: unknown[] = [];
  if (options.tag) {
    clauses.push(
      "EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = documents.id AND t.slug = ?)",
    );
    params.push(slugify(options.tag, 48));
  }
  if (options.query) {
    clauses.push("(title LIKE ? OR EXISTS (SELECT 1 FROM note_bodies nb WHERE nb.document_id = documents.id AND nb.markdown LIKE ?))");
    params.push(`%${options.query}%`, `%${options.query}%`);
  }
  if (options.pinnedOnly) clauses.push("pinned = 1");
  const where = `WHERE ${clauses.join(" AND ")}`;

  const totalRow = get<{ c: number }>(getDb(), `SELECT COUNT(*) AS c FROM documents ${where}`, params);
  const rows = all<Record<string, unknown>>(
    getDb(),
    `SELECT documents.*, COALESCE((SELECT nb.markdown FROM note_bodies nb WHERE nb.document_id = documents.id), '') AS body
     FROM documents ${where} ORDER BY pinned DESC, COALESCE(updated_at, ingested_at) DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const items: NoteListItem[] = rows.map((row) => {
    const body = str(row.body);
    return {
      document: {
        id: str(row.id),
        sourceKind: "note",
        sourceId: str(row.source_id),
        connectorId: strOrNull(row.connector_id),
        externalId: strOrNull(row.external_id),
        title: str(row.title),
        url: strOrNull(row.url),
        path: strOrNull(row.path),
        mime: strOrNull(row.mime),
        author: strOrNull(row.author),
        lang: strOrNull(row.lang),
        createdAt: strOrNull(row.created_at),
        updatedAt: strOrNull(row.updated_at),
        ingestedAt: str(row.ingested_at),
        contentHash: str(row.content_hash),
        charCount: num(row.char_count),
        tokenCount: num(row.token_count),
        chunkCount: num(row.chunk_count),
        status: "indexed",
        pinned: num(row.pinned) === 1,
        meta: {},
        deletedAt: null,
      },
      excerpt: truncate(normalizeWhitespace(body.replace(/^#.*$/gm, "")), 220),
      tags: tagsForDocument(str(row.id)),
    };
  });

  return { items, total: num(totalRow?.c) };
}

function firstLineTitle(markdown: string): string | null {
  const line = normalizeWhitespace(markdown)
    .split("\n")
    .find((candidate) => candidate.trim().length > 0);
  if (!line) return null;
  return truncate(line.replace(/^#{1,6}\s*/, "").trim(), 120);
}

/** Creates a note from plain text and returns its id (used by quick capture). */
export function quickCapture(text: string, tags: string[] = []): string {
  const note = createNote({ markdown: text, tags });
  return note.document.id;
}

export function ensureNoteTags(documentId: string, tags: string[]): void {
  linkTags(documentId, tags, "manual");
  logger.debug("note tags linked", { documentId, count: tags.length });
}

export function noteStats(): { notes: number; tags: number; links: number } {
  const notesRow = get<{ c: number }>(getDb(), "SELECT COUNT(*) AS c FROM documents WHERE source_kind = 'note' AND deleted_at IS NULL");
  const tagsRow = get<{ c: number }>(getDb(), "SELECT COUNT(*) AS c FROM tags");
  const linksRow = get<{ c: number }>(getDb(), "SELECT COUNT(*) AS c FROM doc_links");
  return { notes: num(notesRow?.c), tags: num(tagsRow?.c), links: num(linksRow?.c) };
}

export function newNoteId(): string {
  return newId("note");
}

export { syncWikiLinks, listDocuments };
