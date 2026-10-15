import { contentHash } from "../../core/ids";
import { newId } from "../../core/ids";
import { estimateTokens, foldForIndex, normalizeWhitespace, truncate } from "../../core/text";
import { nowIso } from "../../core/time";
import type { Doc, DocumentStatus, SourceKind, StatsSnapshot } from "../../types/domain";
import { databaseSizeBytes, getDb } from "../connection";
import { all, bool, decodeVector, encodeVector, get, jsonParse, num, run, str, strOrNull, transaction } from "../sql";

export type PreparedChunk = {
  text: string;
  headingPath: string | null;
  charStart: number;
  charEnd: number;
  tokenEstimate?: number;
};

export type UpsertDocumentInput = {
  /** Target an existing document explicitly (notes, re-index, connector re-sync). */
  documentId?: string | null;
  sourceKind: SourceKind;
  sourceId: string;
  connectorId?: string | null;
  externalId?: string | null;
  title?: string;
  text: string;
  url?: string | null;
  path?: string | null;
  mime?: string | null;
  author?: string | null;
  lang?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  meta?: Record<string, unknown>;
  chunks?: PreparedChunk[];
  /** Re-index even when the content hash is unchanged. */
  force?: boolean;
};

export type UpsertOutcome = {
  documentId: string;
  status: "created" | "updated" | "skipped";
  chunks: number;
};

function mapDoc(row: Record<string, unknown>): Doc {
  return {
    id: str(row.id),
    sourceKind: str(row.source_kind, "upload") as SourceKind,
    sourceId: str(row.source_id, "unknown"),
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
    status: str(row.status, "indexed") as DocumentStatus,
    pinned: bool(row.pinned),
    meta: jsonParse<Record<string, unknown>>(row.meta, {}),
    deletedAt: strOrNull(row.deleted_at),
  };
}

export function hasTrigramIndex(): boolean {
  const row = get<{ name: string }>(
    getDb(),
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_trigram'",
  );
  return Boolean(row?.name);
}

export function deleteChunksFor(documentId: string): void {
  const db = getDb();
  run(db, "DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE document_id = ?)", [
    documentId,
  ]);
  if (hasTrigramIndex()) {
    run(db, "DELETE FROM chunks_trigram WHERE rowid IN (SELECT rowid FROM chunks WHERE document_id = ?)", [
      documentId,
    ]);
  }
  run(db, "DELETE FROM chunks WHERE document_id = ?", [documentId]);
}

export function writeChunks(documentId: string, chunks: PreparedChunk[]): number {
  const db = getDb();
  const trigram = hasTrigramIndex();
  let written = 0;

  for (const [index, chunk] of chunks.entries()) {
    const text = normalizeWhitespace(chunk.text);
    if (text.length === 0) continue;
    const folded = foldForIndex(text);
    const headingFold = chunk.headingPath ? foldForIndex(chunk.headingPath) : null;
    const result = run(
      db,
      `INSERT INTO chunks (id, document_id, ord, text, text_fold, heading_path, heading_fold, char_start, char_end, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId("chk"),
        documentId,
        index,
        text,
        folded,
        chunk.headingPath,
        headingFold,
        chunk.charStart,
        chunk.charEnd,
        chunk.tokenEstimate ?? estimateTokens(text),
      ],
    );
    const rowid = result.lastInsertRowid;
    run(db, "INSERT INTO chunks_fts (rowid, text_fold, heading_fold) VALUES (?, ?, ?)", [
      rowid,
      folded,
      headingFold ?? "",
    ]);
    if (trigram) {
      run(db, "INSERT INTO chunks_trigram (rowid, text_fold) VALUES (?, ?)", [rowid, folded]);
    }
    written += 1;
  }

  run(db, "UPDATE documents SET chunk_count = ? WHERE id = ?", [written, documentId]);
  return written;
}

export function findDocumentByOrigin(sourceId: string, externalId: string): Doc | null {
  const row = get(getDb(), "SELECT * FROM documents WHERE source_id = ? AND external_id = ?", [
    sourceId,
    externalId,
  ]);
  return row ? mapDoc(row) : null;
}

export function getDocument(id: string): Doc | null {
  const row = get(getDb(), "SELECT * FROM documents WHERE id = ?", [id]);
  return row ? mapDoc(row) : null;
}

export function documentChunks(documentId: string): {
  id: string;
  documentId: string;
  ord: number;
  text: string;
  headingPath: string | null;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
}[] {
  return all<Record<string, unknown>>(
    getDb(),
    "SELECT id, document_id, ord, text, heading_path, char_start, char_end, token_estimate FROM chunks WHERE document_id = ? ORDER BY ord",
    [documentId],
  ).map((row) => ({
    id: str(row.id),
    documentId: str(row.document_id),
    ord: num(row.ord),
    text: str(row.text),
    headingPath: strOrNull(row.heading_path),
    charStart: num(row.char_start),
    charEnd: num(row.char_end),
    tokenEstimate: num(row.token_estimate),
  }));
}

/**
 * Single write path for every ingest source: de-duplicates by content hash and
 * keeps `documents`, `chunks`, `chunks_fts` and (when available) `chunks_trigram`
 * consistent.
 */
export function upsertDocument(input: UpsertDocumentInput): UpsertOutcome {
  const db = getDb();
  const text = input.text ?? "";
  const hash = contentHash(text);
  const existing = input.documentId
    ? getDocument(input.documentId)
    : input.externalId
      ? findDocumentByOrigin(input.sourceId, input.externalId)
      : null;
  const timestamp = nowIso();

  if (existing && !input.force && existing.contentHash === hash && existing.status === "indexed") {
    run(
      db,
      "UPDATE documents SET ingested_at = ?, updated_at = COALESCE(?, updated_at) WHERE id = ?",
      [timestamp, input.updatedAt ?? null, existing.id],
    );
    return { documentId: existing.id, status: "skipped", chunks: existing.chunkCount };
  }

  const chunks = input.chunks ?? [];
  const docId = existing?.id ?? newId("doc");
  const title = (input.title ?? "").trim() || deriveTitle(input.text, input.path ?? input.url ?? null);

  transaction(db, () => {
    if (existing) {
      run(
        db,
        `UPDATE documents SET source_kind = ?, connector_id = ?, title = ?, url = ?, path = ?, mime = ?,
           author = ?, lang = ?, created_at = COALESCE(?, created_at), updated_at = ?,
           ingested_at = ?, content_hash = ?, char_count = ?, token_count = ?, status = 'indexed',
           meta = ?, deleted_at = NULL
         WHERE id = ?`,
        [
          input.sourceKind,
          input.connectorId ?? null,
          title,
          input.url ?? null,
          input.path ?? null,
          input.mime ?? null,
          input.author ?? null,
          input.lang ?? null,
          input.createdAt ?? null,
          input.updatedAt ?? input.createdAt ?? timestamp,
          timestamp,
          hash,
          text.length,
          estimateTokens(text),
          JSON.stringify(input.meta ?? {}),
          docId,
        ],
      );
      deleteChunksFor(docId);
    } else {
      run(
        db,
        `INSERT INTO documents (id, source_kind, source_id, connector_id, external_id, title, url, path, mime,
           author, lang, created_at, updated_at, ingested_at, content_hash, char_count, token_count, chunk_count,
           status, pinned, meta, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'indexed', 0, ?, NULL)`,
        [
          docId,
          input.sourceKind,
          input.sourceId,
          input.connectorId ?? null,
          input.externalId ?? null,
          title,
          input.url ?? null,
          input.path ?? null,
          input.mime ?? null,
          input.author ?? null,
          input.lang ?? null,
          input.createdAt ?? null,
          input.updatedAt ?? input.createdAt ?? timestamp,
          timestamp,
          hash,
          text.length,
          estimateTokens(text),
          JSON.stringify(input.meta ?? {}),
        ],
      );
    }

    if (chunks.length > 0) writeChunks(docId, chunks);
  });

  return {
    documentId: docId,
    status: existing ? "updated" : "created",
    chunks: chunks.length,
  };
}

export function deriveTitle(text: string, fallback: string | null): string {
  const firstLine = normalizeWhitespace(text).split("\n").find((line) => line.trim().length > 0);
  if (firstLine) {
    const heading = firstLine.replace(/^#{1,6}\s*/, "").trim();
    if (heading.length > 0) return truncate(heading, 120);
  }
  if (fallback) return truncate(fallback.split(/[\\/]/).pop() ?? fallback, 120);
  return "Untitled";
}

export function setDocumentStatus(id: string, status: DocumentStatus, meta?: Record<string, unknown>): void {
  const db = getDb();
  if (meta) {
    const current = getDocument(id);
    run(db, "UPDATE documents SET status = ?, meta = ? WHERE id = ?", [
      status,
      JSON.stringify({ ...(current?.meta ?? {}), ...meta }),
      id,
    ]);
    return;
  }
  run(db, "UPDATE documents SET status = ? WHERE id = ?", [status, id]);
}

export function setDocumentPinned(id: string, pinned: boolean): void {
  run(getDb(), "UPDATE documents SET pinned = ? WHERE id = ?", [pinned ? 1 : 0, id]);
}

export function deleteDocument(id: string, options: { hard?: boolean } = {}): boolean {
  const db = getDb();
  if (options.hard) {
    deleteChunksFor(id);
    run(db, "DELETE FROM documents WHERE id = ?", [id]);
    return true;
  }
  const result = run(db, "UPDATE documents SET status = 'deleted', deleted_at = ? WHERE id = ?", [
    nowIso(),
    id,
  ]);
  return result.changes > 0;
}

export function restoreDocument(id: string): boolean {
  const result = run(getDb(), "UPDATE documents SET status = 'indexed', deleted_at = NULL WHERE id = ?", [id]);
  return result.changes > 0;
}

export type ListDocumentsOptions = {
  limit?: number;
  offset?: number;
  sourceKind?: SourceKind | null;
  sourceIds?: string[];
  connectorId?: string | null;
  since?: string | null;
  until?: string | null;
  documentIds?: string[];
  pinnedOnly?: boolean;
  includeDeleted?: boolean;
  /** Ordering column; unknown values fall back to ingest time. */
  orderBy?: string;
  direction?: "asc" | "desc";
};

function buildDocumentFilters(options: ListDocumentsOptions): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!options.includeDeleted) clauses.push("deleted_at IS NULL AND status <> 'deleted'");
  if (options.sourceKind) {
    clauses.push("source_kind = ?");
    params.push(options.sourceKind);
  }
  if (options.sourceIds && options.sourceIds.length > 0) {
    clauses.push(`source_id IN (${options.sourceIds.map(() => "?").join(", ")})`);
    params.push(...options.sourceIds);
  }
  if (options.connectorId) {
    clauses.push("connector_id = ?");
    params.push(options.connectorId);
  }
  if (options.since) {
    clauses.push("COALESCE(created_at, ingested_at) >= ?");
    params.push(options.since);
  }
  if (options.until) {
    clauses.push("COALESCE(created_at, ingested_at) <= ?");
    params.push(options.until);
  }
  if (options.documentIds && options.documentIds.length > 0) {
    clauses.push(`id IN (${options.documentIds.map(() => "?").join(", ")})`);
    params.push(...options.documentIds);
  }
  if (options.pinnedOnly) clauses.push("pinned = 1");
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listDocuments(options: ListDocumentsOptions = {}): { items: Doc[]; total: number } {
  const db = getDb();
  const { where, params } = buildDocumentFilters(options);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const orderColumn =
    options.orderBy === "created" ? "created_at" : options.orderBy === "title" ? "title" : "ingested_at";
  const direction = options.direction === "asc" ? "ASC" : "DESC";

  const totalRow = get<{ c: number }>(db, `SELECT COUNT(*) AS c FROM documents ${where}`, params);
  const rows = all<Record<string, unknown>>(
    db,
    `SELECT * FROM documents ${where} ORDER BY pinned DESC, ${orderColumn} ${direction} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { items: rows.map(mapDoc), total: num(totalRow?.c) };
}

export function countDocuments(): number {
  const row = get<{ c: number }>(getDb(), "SELECT COUNT(*) AS c FROM documents WHERE deleted_at IS NULL");
  return num(row?.c);
}

export function countChunks(): number {
  const row = get<{ c: number }>(getDb(), "SELECT COUNT(*) AS c FROM chunks");
  return num(row?.c);
}

export function countEmbeddings(): number {
  const row = get<{ c: number }>(getDb(), "SELECT COUNT(*) AS c FROM embeddings");
  return num(row?.c);
}

export function statsBySource(limit = 12): { sourceId: string; sourceKind: SourceKind; count: number }[] {
  return all<Record<string, unknown>>(
    getDb(),
    `SELECT source_id, source_kind, COUNT(*) AS c FROM documents
     WHERE deleted_at IS NULL GROUP BY source_id, source_kind ORDER BY c DESC LIMIT ?`,
    [limit],
  ).map((row) => ({
    sourceId: str(row.source_id),
    sourceKind: str(row.source_kind, "upload") as SourceKind,
    count: num(row.c),
  }));
}

export function lastIngestAt(): string | null {
  const row = get<{ at: string }>(getDb(), "SELECT MAX(ingested_at) AS at FROM documents WHERE deleted_at IS NULL");
  return row?.at ? String(row.at) : null;
}

export function buildStats(aiConfigured: boolean): StatsSnapshot {
  const chunks = countChunks();
  const embeddings = countEmbeddings();
  const notesRow = get<{ c: number }>(
    getDb(),
    "SELECT COUNT(*) AS c FROM documents WHERE source_kind = 'note' AND deleted_at IS NULL",
  );
  const connectorsRow = get<{ c: number }>(getDb(), "SELECT COUNT(*) AS c FROM connectors");
  const conversationsRow = get<{ c: number }>(getDb(), "SELECT COUNT(*) AS c FROM conversations");
  return {
    documents: countDocuments(),
    chunks,
    notes: num(notesRow?.c),
    embeddings,
    connectors: num(connectorsRow?.c),
    conversations: num(conversationsRow?.c),
    bySource: statsBySource(),
    lastIngestAt: lastIngestAt(),
    databaseBytes: databaseSizeBytes(),
    aiConfigured,
    embeddingCoverage: chunks === 0 ? 0 : Math.min(1, embeddings / chunks),
  };
}

export type VectorRow = { chunkId: string; documentId: string; model: string; dim: number; vec: Float32Array };

export function listEmbeddingsFor(chunkIds: string[], model?: string | null): VectorRow[] {
  if (chunkIds.length === 0) return [];
  const db = getDb();
  const placeholders = chunkIds.map(() => "?").join(", ");
  const params: unknown[] = [...chunkIds];
  let sql = `SELECT e.chunk_id, c.document_id, e.model, e.dim, e.vec
             FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
             WHERE e.chunk_id IN (${placeholders})`;
  if (model) {
    sql += " AND e.model = ?";
    params.push(model);
  }
  return all<Record<string, unknown>>(db, sql, params).map((row) => ({
    chunkId: str(row.chunk_id),
    documentId: str(row.document_id),
    model: str(row.model),
    dim: num(row.dim),
    vec: decodeVector(row.vec),
  }));
}

export function upsertEmbedding(chunkId: string, model: string, vector: Float32Array): void {
  run(
    getDb(),
    `INSERT INTO embeddings (chunk_id, model, dim, vec, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chunk_id, model) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, created_at = excluded.created_at`,
    [chunkId, model, vector.length, encodeVector(vector), nowIso()],
  );
}

export function embeddingsByModel(): { model: string; count: number; dim: number }[] {
  return all<Record<string, unknown>>(
    getDb(),
    "SELECT model, COUNT(*) AS c, MAX(dim) AS dim FROM embeddings GROUP BY model ORDER BY c DESC",
  ).map((row) => ({ model: str(row.model), count: num(row.c), dim: num(row.dim) }));
}

export function chunksMissingEmbeddings(model: string, limit = 200): { id: string; documentId: string; text: string }[] {
  return all<Record<string, unknown>>(
    getDb(),
    `SELECT c.id, c.document_id, c.text FROM chunks c
     LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = ?
     WHERE e.chunk_id IS NULL
     ORDER BY c.rowid DESC LIMIT ?`,
    [model, limit],
  ).map((row) => ({ id: str(row.id), documentId: str(row.document_id), text: str(row.text) }));
}

export function clearEmbeddings(model?: string | null): number {
  const db = getDb();
  const result = model
    ? run(db, "DELETE FROM embeddings WHERE model = ?", [model])
    : run(db, "DELETE FROM embeddings", []);
  return result.changes;
}
