import { newId } from "../../core/ids";
import { nowIso } from "../../core/time";
import type { Collection, CollectionRules } from "../../types/domain";
import { getDb } from "../connection";
import { all, get, jsonParse, num, run, str } from "../sql";
import { getDocument } from "./documents";

function mapCollection(row: Record<string, unknown>): Collection {
  return {
    id: str(row.id),
    name: str(row.name),
    description: str(row.description),
    rules: jsonParse<CollectionRules>(row.rules, {}),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    ...(row.count === undefined ? {} : { count: num(row.count) }),
  };
}

export function createCollection(input: {
  name: string;
  description?: string;
  rules?: CollectionRules;
}): Collection {
  const id = newId("col");
  const at = nowIso();
  run(
    getDb(),
    "INSERT INTO collections (id, name, description, rules, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, input.name, input.description ?? "", JSON.stringify(input.rules ?? {}), at, at],
  );
  const collection = getCollection(id);
  if (!collection) throw new Error("could not create collection");
  return collection;
}

export function getCollection(id: string): Collection | null {
  const row = get<Record<string, unknown>>(getDb(), "SELECT * FROM collections WHERE id = ?", [id]);
  return row ? mapCollection(row) : null;
}

/** Collections are rule-based; the count is resolved from the rules, not stored. */
export function listCollections(): Collection[] {
  const collections = all<Record<string, unknown>>(getDb(), "SELECT * FROM collections ORDER BY name").map(
    mapCollection,
  );
  return collections.map((collection) => ({
    ...collection,
    count: collectionDocumentIds(collection.id, 1000).length,
  }));
}

export function updateCollection(
  id: string,
  patch: { name?: string; description?: string; rules?: CollectionRules },
): Collection | null {
  const existing = getCollection(id);
  if (!existing) return null;
  run(getDb(), "UPDATE collections SET name = ?, description = ?, rules = ?, updated_at = ? WHERE id = ?", [
    patch.name ?? existing.name,
    patch.description ?? existing.description,
    JSON.stringify(patch.rules ?? existing.rules),
    nowIso(),
    id,
  ]);
  return getCollection(id);
}

export function deleteCollection(id: string): boolean {
  return run(getDb(), "DELETE FROM collections WHERE id = ?", [id]).changes > 0;
}

/** Resolves a collection into a document id list (used to scope search and chat). */
export function collectionDocumentIds(id: string, limit = 500): string[] {
  const collection = getCollection(id);
  if (!collection) return [];
  const rules = collection.rules;
  const clauses: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];

  if (rules.sourceKind && rules.sourceKind.length > 0) {
    clauses.push(`source_kind IN (${rules.sourceKind.map(() => "?").join(", ")})`);
    params.push(...rules.sourceKind);
  }
  if (rules.sourceId && rules.sourceId.length > 0) {
    clauses.push(`source_id IN (${rules.sourceId.map(() => "?").join(", ")})`);
    params.push(...rules.sourceId);
  }
  if (rules.since) {
    clauses.push("COALESCE(created_at, ingested_at) >= ?");
    params.push(rules.since);
  }
  if (rules.until) {
    clauses.push("COALESCE(created_at, ingested_at) <= ?");
    params.push(rules.until);
  }
  if (rules.tags && rules.tags.length > 0) {
    clauses.push(
      `EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
               WHERE dt.document_id = documents.id AND t.slug IN (${rules.tags.map(() => "?").join(", ")}))`,
    );
    params.push(...rules.tags);
  }

  const rows = all<{ id: string }>(
    getDb(),
    `SELECT id FROM documents WHERE ${clauses.join(" AND ")} ORDER BY COALESCE(created_at, ingested_at) DESC LIMIT ?`,
    [...params, limit],
  );
  const ids = new Set(rows.map((row) => str(row.id)));
  for (const pinned of rules.documentIds ?? []) ids.add(pinned);
  return Array.from(ids);
}

export function addDocumentToCollection(collectionId: string, documentId: string): boolean {
  if (!getDocument(documentId)) return false;
  const collection = getCollection(collectionId);
  if (!collection) return false;
  const ids = new Set(collection.rules.documentIds ?? []);
  ids.add(documentId);
  return updateCollection(collectionId, { rules: { ...collection.rules, documentIds: Array.from(ids) } }) !== null;
}

export function removeDocumentFromCollection(collectionId: string, documentId: string): boolean {
  const collection = getCollection(collectionId);
  if (!collection) return false;
  const ids = (collection.rules.documentIds ?? []).filter((id) => id !== documentId);
  return updateCollection(collectionId, { rules: { ...collection.rules, documentIds: ids } }) !== null;
}
