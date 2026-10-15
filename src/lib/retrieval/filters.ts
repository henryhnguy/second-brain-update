import type { SearchFilters, SourceKind } from "../types/domain";

/**
 * Builds a `WHERE` fragment over the `documents` table (aliased) for the shared
 * filter shape used by search, chat and play scoping.
 */
export function documentFilterSql(
  filters: SearchFilters | undefined,
  alias = "d",
): { where: string; params: unknown[] } {
  const clauses: string[] = [`${alias}.deleted_at IS NULL`, `${alias}.status <> 'deleted'`];
  const params: unknown[] = [];
  if (!filters) return { where: `WHERE ${clauses.join(" AND ")}`, params };

  if (filters.sources && filters.sources.length > 0) {
    clauses.push(`${alias}.source_kind IN (${filters.sources.map(() => "?").join(", ")})`);
    params.push(...filters.sources);
  }
  if (filters.sourceIds && filters.sourceIds.length > 0) {
    clauses.push(`${alias}.source_id IN (${filters.sourceIds.map(() => "?").join(", ")})`);
    params.push(...filters.sourceIds);
  }
  if (filters.connectorId) {
    clauses.push(`${alias}.connector_id = ?`);
    params.push(filters.connectorId);
  }
  if (filters.documentIds && filters.documentIds.length > 0) {
    clauses.push(`${alias}.id IN (${filters.documentIds.map(() => "?").join(", ")})`);
    params.push(...filters.documentIds);
  }
  if (filters.since) {
    clauses.push(`COALESCE(${alias}.created_at, ${alias}.ingested_at) >= ?`);
    params.push(filters.since);
  }
  if (filters.until) {
    clauses.push(`COALESCE(${alias}.created_at, ${alias}.ingested_at) <= ?`);
    params.push(filters.until);
  }
  if (filters.pinnedOnly) {
    clauses.push(`${alias}.pinned = 1`);
  }
  if (filters.tags && filters.tags.length > 0) {
    clauses.push(
      `EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
               WHERE dt.document_id = ${alias}.id AND t.slug IN (${filters.tags.map(() => "?").join(", ")}))`,
    );
    params.push(...filters.tags);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function sourceKindList(values: string[] | undefined): SourceKind[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values as SourceKind[];
}
