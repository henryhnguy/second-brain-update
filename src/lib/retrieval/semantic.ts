import { getDb } from "../db/connection";
import { all, cosineSimilarity, decodeVector, num, str, strOrNull } from "../db/sql";
import type { SearchFilters, SourceKind } from "../types/domain";
import { documentFilterSql } from "./filters";

export type SemanticCandidate = {
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
  cosine: number;
};

/** Hard ceiling for a brute-force scan; documented in docs/architecture.md. */
export const MAX_SCAN_VECTORS = 80_000;

/**
 * Brute-force cosine similarity over stored chunk vectors. Exact (no ANN
 * index), which is the right trade-off for a personal knowledge base and keeps
 * the storage dependency-free. Falls back to a candidate window when provided.
 */
export function semanticSearch(
  queryVector: Float32Array,
  options: {
    limit?: number;
    filters?: SearchFilters;
    candidateChunkIds?: string[];
    model?: string | null;
  } = {},
): SemanticCandidate[] {
  const db = getDb();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 400);
  const { where, params } = documentFilterSql(options.filters, "d");
  const clauses: string[] = [where.replace(/^WHERE\s*/, "")];
  const queryParams: unknown[] = [...params];

  if (options.model) {
    clauses.push("e.model = ?");
    queryParams.push(options.model);
  }

  if (options.candidateChunkIds && options.candidateChunkIds.length > 0) {
    clauses.push(`e.chunk_id IN (${options.candidateChunkIds.map(() => "?").join(", ")})`);
    queryParams.push(...options.candidateChunkIds);
  }

  const rows = all<Record<string, unknown>>(
    db,
    `SELECT e.chunk_id AS chunk_id, e.vec AS vec, c.document_id AS document_id, c.text AS text,
            c.heading_path AS heading_path, d.title AS title, d.source_kind AS source_kind,
            d.source_id AS source_id, d.url AS url, d.path AS path, d.author AS author,
            d.created_at AS created_at, d.updated_at AS updated_at, d.ingested_at AS ingested_at,
            d.pinned AS pinned
     FROM embeddings e
     JOIN chunks c ON c.id = e.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE ${clauses.join(" AND ")}
     LIMIT ?`,
    [...queryParams, MAX_SCAN_VECTORS],
  );

  const scored: SemanticCandidate[] = rows.map((row) => ({
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
    cosine: cosineSimilarity(queryVector, decodeVector(row.vec)),
  }));

  scored.sort((a, b) => b.cosine - a.cosine);
  return scored.slice(0, limit);
}

export function embeddingModelCoverage(model: string): { embedded: number; total: number } {
  const db = getDb();
  const totalRow = db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c?: number } | undefined;
  const embeddedRow = db
    .prepare("SELECT COUNT(*) AS c FROM embeddings WHERE model = ?")
    .get(model) as { c?: number } | undefined;
  return { embedded: num(embeddedRow?.c), total: num(totalRow?.c) };
}
