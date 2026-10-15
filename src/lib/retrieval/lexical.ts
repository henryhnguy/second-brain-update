import { all, get, num, str, strOrNull } from "../db/sql";
import { getDb } from "../db/connection";
import { hasTrigramIndex } from "../db/repo/documents";
import { buildFtsQuery, buildFtsQueryOr, snippetAround, tokenize } from "../core/text";
import type { SearchFilters, SourceKind } from "../types/domain";
import { documentFilterSql } from "./filters";

export type LexicalCandidate = {
  chunkId: string;
  documentId: string;
  title: string;
  sourceKind: SourceKind;
  sourceId: string;
  url: string | null;
  path: string | null;
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  ingestedAt: string;
  pinned: boolean;
  text: string;
  headingPath: string | null;
  /** Higher is better (already sign-flipped from SQLite's bm25). */
  score: number;
};

function mapCandidate(row: Record<string, unknown>, score: number): LexicalCandidate {
  return {
    chunkId: str(row.chunk_id),
    documentId: str(row.document_id),
    title: str(row.title),
    sourceKind: str(row.source_kind, "upload") as SourceKind,
    sourceId: str(row.source_id, "unknown"),
    url: strOrNull(row.url),
    path: strOrNull(row.path),
    author: strOrNull(row.author),
    createdAt: strOrNull(row.created_at),
    updatedAt: strOrNull(row.updated_at),
    ingestedAt: str(row.ingested_at),
    pinned: num(row.pinned) === 1,
    text: str(row.text),
    headingPath: strOrNull(row.heading_path),
    score,
  };
}

const SELECT_COLUMNS = `f.rowid AS rowid, c.id AS chunk_id, c.document_id AS document_id, c.text AS text,
  c.heading_path AS heading_path, d.title AS title, d.source_kind AS source_kind, d.source_id AS source_id,
  d.url AS url, d.path AS path, d.author AS author, d.created_at AS created_at, d.updated_at AS updated_at,
  d.ingested_at AS ingested_at, d.pinned AS pinned`;

/** BM25 full-text search over the accent-folded index. */
export function keywordSearch(
  query: string,
  options: { limit?: number; filters?: SearchFilters; prefixLast?: boolean } = {},
): LexicalCandidate[] {
  const db = getDb();
  const limit = Math.min(Math.max(options.limit ?? 60, 1), 500);
  const match = buildFtsQuery(query, { prefixLast: options.prefixLast ?? true });
  if (!match) return [];

  const { where, params } = documentFilterSql(options.filters, "d");
  let rows = all<Record<string, unknown>>(
    db,
    `SELECT ${SELECT_COLUMNS}, bm25(chunks_fts, 1.0, 0.6) AS bm
     FROM chunks_fts f
     JOIN chunks c ON c.rowid = f.rowid
     JOIN documents d ON d.id = c.document_id
     WHERE chunks_fts MATCH ? AND ${where.replace(/^WHERE\s*/, "")}
     ORDER BY bm LIMIT ?`,
    [match, ...params, limit],
  );

  if (rows.length === 0 && tokenize(query).length > 1) {
    const loose = buildFtsQueryOr(query);
    if (loose) {
      rows = all<Record<string, unknown>>(
        db,
        `SELECT ${SELECT_COLUMNS}, bm25(chunks_fts, 1.0, 0.6) AS bm
         FROM chunks_fts f
         JOIN chunks c ON c.rowid = f.rowid
         JOIN documents d ON d.id = c.document_id
         WHERE chunks_fts MATCH ? AND ${where.replace(/^WHERE\s*/, "")}
         ORDER BY bm LIMIT ?`,
        [loose, ...params, limit],
      );
    }
  }

  return rows.map((row) => mapCandidate(row, -num(row.bm)));
}

/** Substring scan over the trigram index: catches plurals, compounds and typos. */
export function trigramSearch(
  query: string,
  options: { limit?: number; filters?: SearchFilters } = {},
): LexicalCandidate[] {
  if (!hasTrigramIndex()) return [];
  const terms = tokenize(query)
    .filter((term) => term.length >= 3)
    .slice(0, 12);
  if (terms.length === 0) return [];

  const db = getDb();
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 200);
  const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
  const { where, params } = documentFilterSql(options.filters, "d");

  const rows = all<Record<string, unknown>>(
    db,
    `SELECT ${SELECT_COLUMNS}, bm25(chunks_trigram) AS bm
     FROM chunks_trigram f
     JOIN chunks c ON c.rowid = f.rowid
     JOIN documents d ON d.id = c.document_id
     WHERE chunks_trigram MATCH ? AND ${where.replace(/^WHERE\s*/, "")}
     ORDER BY bm LIMIT ?`,
    [match, ...params, limit],
  );
  return rows.map((row) => mapCandidate(row, -num(row.bm)));
}

export function candidateSnippet(candidate: LexicalCandidate, query: string): string {
  return snippetAround(candidate.text, tokenize(query), 220);
}

export function countSearchableChunks(filters?: SearchFilters): number {
  const { where, params } = documentFilterSql(filters, "d");
  const row = get<{ c: number }>(
    getDb(),
    `SELECT COUNT(*) AS c FROM chunks c JOIN documents d ON d.id = c.document_id ${where}`,
    params,
  );
  return num(row?.c);
}

export function facetCounts(filters?: SearchFilters): {
  sourceKind: Record<string, number>;
  sourceId: Record<string, number>;
} {
  const db = getDb();
  const { where, params } = documentFilterSql(filters, "d");
  const kinds = all<Record<string, unknown>>(
    db,
    `SELECT d.source_kind AS k, COUNT(*) AS c FROM documents d ${where} GROUP BY d.source_kind ORDER BY c DESC`,
    params,
  );
  const sources = all<Record<string, unknown>>(
    db,
    `SELECT d.source_id AS k, COUNT(*) AS c FROM documents d ${where} GROUP BY d.source_id ORDER BY c DESC LIMIT 30`,
    params,
  );
  return {
    sourceKind: Object.fromEntries(kinds.map((row) => [str(row.k), num(row.c)])),
    sourceId: Object.fromEntries(sources.map((row) => [str(row.k), num(row.c)])),
  };
}

export function tagFacetCounts(filters?: SearchFilters): Record<string, number> {
  const { where, params } = documentFilterSql(filters, "d");
  const rows = all<Record<string, unknown>>(
    getDb(),
    `SELECT t.slug AS k, COUNT(*) AS c
     FROM documents d JOIN document_tags dt ON dt.document_id = d.id JOIN tags t ON t.id = dt.tag_id
     ${where} GROUP BY t.slug ORDER BY c DESC LIMIT 40`,
    params,
  );
  return Object.fromEntries(rows.map((row) => [str(row.k), num(row.c)]));
}
