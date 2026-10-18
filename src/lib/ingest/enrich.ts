import { entityId, newId } from "../core/ids";
import { extractInlineTags, extractUrls, extractWikiLinks, foldForIndex, normalizeWhitespace, slugify } from "../core/text";
import { nowIso } from "../core/time";
import { getDb } from "../db/connection";
import { all, get, num, run, transaction } from "../db/sql";
import type { Entity, EntityType } from "../types/domain";

/**
 * Deterministic enrichment: tags, wiki links and a small entity graph.
 * No model calls, no surprises — a note about a person still shows up in the
 * graph on a machine with no AI provider configured.
 */

const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

export type EnrichInput = {
  text: string;
  /** Source-provided tags/labels (Gmail label, Slack channel…). */
  tags?: string[];
  /** Source-provided people (email participants, meeting attendees…). */
  participants?: string[];
  /** Optional project/workspace name to attach as a topic. */
  topic?: string | null;
};

export function upsertTag(name: string, color: string | null = null): string {
  const trimmed = name.trim().replace(/^#/, "");
  const slug = slugify(trimmed, 48);
  if (!slug) return "";
  const existing = get<{ id: string }>(getDb(), "SELECT id FROM tags WHERE slug = ?", [slug]);
  if (existing?.id) return String(existing.id);
  const id = newId("tag");
  run(getDb(), "INSERT INTO tags (id, name, slug, color, created_at) VALUES (?, ?, ?, ?, ?)", [
    id,
    trimmed,
    slug,
    color,
    nowIso(),
  ]);
  return id;
}

export function linkTags(documentId: string, tagNames: string[], source = "auto"): number {
  const db = getDb();
  let linked = 0;
  for (const name of tagNames) {
    const tagId = upsertTag(name);
    if (!tagId) continue;
    const result = run(
      db,
      "INSERT OR IGNORE INTO document_tags (document_id, tag_id, source) VALUES (?, ?, ?)",
      [documentId, tagId, source],
    );
    linked += result.changes;
  }
  return linked;
}

/** Resolves `[[wiki links]]` to real documents by title, creating stubs if needed. */
export function syncWikiLinks(documentId: string, text: string): string[] {
  const db = getDb();
  const targets = extractWikiLinks(text);
  for (const target of targets) {
    const slug = slugify(target, 80);
    const match = get<{ id: string }>(
      db,
      "SELECT id FROM documents WHERE (title = ? OR lower(title) = lower(?)) AND deleted_at IS NULL AND id <> ? LIMIT 1",
      [target, target, documentId],
    );
    run(
      db,
      `INSERT INTO doc_links (from_document_id, to_slug, to_document_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(from_document_id, to_slug) DO UPDATE SET to_document_id = excluded.to_document_id`,
      [documentId, slug, match?.id ?? null, nowIso()],
    );
  }
  return targets;
}

export function backfillWikiLinks(): number {
  const db = getDb();
  const pending = all<{ from_document_id: string; to_slug: string }>(
    db,
    "SELECT from_document_id, to_slug FROM doc_links WHERE to_document_id IS NULL",
  );
  let fixed = 0;
  for (const link of pending) {
    const title = link.to_slug.replace(/-/g, " ");
    const match = get<{ id: string }>(
      db,
      "SELECT id FROM documents WHERE lower(title) = lower(?) AND deleted_at IS NULL LIMIT 1",
      [title],
    );
    if (match?.id) {
      run(db, "UPDATE doc_links SET to_document_id = ? WHERE from_document_id = ? AND to_slug = ?", [
        match.id,
        link.from_document_id,
        link.to_slug,
      ]);
      fixed += 1;
    }
  }
  return fixed;
}

export function upsertEntity(type: EntityType, name: string, alias?: string): string {
  const db = getDb();
  const clean = normalizeWhitespace(name).slice(0, 200).trim();
  if (clean.length === 0) return "";
  const id = entityId(type, clean);
  const fold = foldForIndex(clean);
  // Identity is the folded name, not the id: "RS-X" and "RSX" (or two
  // capitalisations) fold together and must update one row instead of tripping
  // the (type, name_fold) unique index.
  const existing = get<{ id: string; aliases: string }>(
    db,
    "SELECT id, aliases FROM entities WHERE type = ? AND name_fold = ?",
    [type, fold],
  );
  if (existing) {
    if (alias) {
      const aliases = new Set<string>(JSON.parse(existing.aliases || "[]") as string[]);
      aliases.add(alias);
      run(db, "UPDATE entities SET aliases = ? WHERE id = ?", [JSON.stringify(Array.from(aliases)), existing.id]);
    }
    return existing.id;
  }
  run(
    db,
    "INSERT INTO entities (id, type, name, name_fold, aliases, mentions, last_seen_at, meta) VALUES (?, ?, ?, ?, ?, 0, NULL, '{}')",
    [id, type, clean, fold, JSON.stringify(alias ? [alias] : [])],
  );
  return id;
}

function extractCandidates(input: EnrichInput): { type: EntityType; name: string }[] {
  // Keyed by folded name so "Kế hoạch" and "ke hoach" merge, but the original
  // spelling is what gets stored and shown in the knowledge graph.
  const found = new Map<string, { type: EntityType; name: string }>();
  const push = (type: EntityType, name: string) => {
    const clean = normalizeWhitespace(name).trim();
    if (clean.length < 2 || clean.length > 160) return;
    const key = `${type}:${foldForIndex(clean)}`;
    if (!found.has(key)) found.set(key, { type, name: clean });
  };

  for (const match of input.text.matchAll(EMAIL_PATTERN)) {
    if (match[0]) push("email", match[0].toLowerCase());
  }
  for (const url of extractUrls(input.text).slice(0, 40)) {
    try {
      push("url", new URL(url).hostname.replace(/^www\./, ""));
    } catch {
      /* ignore malformed url */
    }
  }
  for (const tag of extractInlineTags(input.text).slice(0, 60)) push("tag", tag);
  for (const link of extractWikiLinks(input.text).slice(0, 60)) push("topic", link);
  for (const tag of input.tags ?? []) push("tag", tag);
  for (const person of input.participants ?? []) push("person", person);
  if (input.topic) push("topic", input.topic);

  // Repeated capitalised phrases become topics; two mentions minimum keeps it honest.
  const counts = new Map<string, number>();
  for (const match of input.text.matchAll(/\b(?:[A-ZĐ][\p{L}\p{N}]+)(?:\s+(?:[A-ZĐ][\p{L}\p{N}]+)){0,3}\b/gu)) {
    const phrase = match[0]?.trim();
    if (!phrase || phrase.length < 4) continue;
    if (phrase.split(/\s+/).length === 1 && phrase.length < 6) continue;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  for (const [phrase, count] of counts) {
    if (count >= 2 && phrase.split(/\s+/).length >= 2) push("topic", phrase);
  }

  return Array.from(found.values()).map((entry) => ({ type: entry.type, name: entry.name }));
}

/** Writes tags, wiki links and entity mentions for one document. */
export function applyEnrichment(documentId: string, input: EnrichInput): { tags: number; entities: number } {
  const db = getDb();
  const candidates = extractCandidates(input);
  const tagNames = [
    ...extractInlineTags(input.text).slice(0, 60),
    ...(input.tags ?? []),
  ];
  let entityCount = 0;

  transaction(db, () => {
    linkTags(documentId, tagNames, "auto");
    syncWikiLinks(documentId, input.text);

    const ids: string[] = [];
    for (const candidate of candidates) {
      const id = upsertEntity(candidate.type, candidate.name);
      if (!id) continue;
      ids.push(id);
      run(
        db,
        `INSERT INTO entity_mentions (entity_id, document_id, weight) VALUES (?, ?, 1)
         ON CONFLICT(entity_id, document_id) DO UPDATE SET weight = weight + 1`,
        [id, documentId],
      );
      entityCount += 1;
    }

    const unique = Array.from(new Set(ids)).slice(0, 40);
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const [a, b] = [unique[i] as string, unique[j] as string];
        run(
          db,
          `INSERT INTO entity_edges (from_entity_id, to_entity_id, kind, weight) VALUES (?, ?, 'cooccurrence', 1)
           ON CONFLICT(from_entity_id, to_entity_id, kind) DO UPDATE SET weight = weight + 1`,
          [a, b],
        );
      }
    }

    for (const id of unique) {
      run(db, "UPDATE entities SET mentions = (SELECT COUNT(*) FROM entity_mentions WHERE entity_id = ?), last_seen_at = ? WHERE id = ?", [
        id,
        nowIso(),
        id,
      ]);
    }
  });

  return { tags: tagNames.length, entities: entityCount };
}

export function topEntities(limit = 40, type?: EntityType): Entity[] {
  const db = getDb();
  const rows = type
    ? all<Record<string, unknown>>(
        db,
        "SELECT * FROM entities WHERE type = ? ORDER BY mentions DESC, name ASC LIMIT ?",
        [type, limit],
      )
    : all<Record<string, unknown>>(
        db,
        "SELECT * FROM entities ORDER BY mentions DESC, name ASC LIMIT ?",
        [limit],
      );
  return rows.map((row) => ({
    id: String(row.id),
    type: String(row.type) as EntityType,
    name: String(row.name),
    aliases: JSON.parse(String(row.aliases ?? "[]")) as string[],
    mentions: num(row.mentions),
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
    meta: {},
  }));
}

export function entityDocuments(entityIdValue: string, limit = 20): { documentId: string; title: string; at: string | null }[] {
  return all<Record<string, unknown>>(
    getDb(),
    `SELECT d.id AS document_id, d.title AS title, COALESCE(d.created_at, d.ingested_at) AS at
     FROM entity_mentions m JOIN documents d ON d.id = m.document_id
     WHERE m.entity_id = ? AND d.deleted_at IS NULL
     ORDER BY at DESC LIMIT ?`,
    [entityIdValue, limit],
  ).map((row) => ({
    documentId: String(row.document_id),
    title: String(row.title),
    at: row.at ? String(row.at) : null,
  }));
}

export function searchEntities(query: string, limit = 20): Entity[] {
  const needle = `%${foldForIndex(query)}%`;
  const rows = all<Record<string, unknown>>(
    getDb(),
    "SELECT * FROM entities WHERE name_fold LIKE ? ORDER BY mentions DESC LIMIT ?",
    [needle, limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    type: String(row.type) as EntityType,
    name: String(row.name),
    aliases: JSON.parse(String(row.aliases ?? "[]")) as string[],
    mentions: num(row.mentions),
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
    meta: {},
  }));
}

export type GraphSnapshot = {
  nodes: { id: string; label: string; type: EntityType; weight: number }[];
  edges: { source: string; target: string; weight: number; kind: string }[];
  truncated: boolean;
};

export function graphSnapshot(limit = 80): GraphSnapshot {
  const db = getDb();
  const nodes = topEntities(limit).filter((entity) => entity.mentions > 0);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = all<Record<string, unknown>>(
    db,
    "SELECT from_entity_id, to_entity_id, kind, weight FROM entity_edges ORDER BY weight DESC LIMIT ?",
    [limit * 8],
  )
    .map((row) => ({
      source: String(row.from_entity_id),
      target: String(row.to_entity_id),
      weight: num(row.weight),
      kind: String(row.kind),
    }))
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    .slice(0, limit * 4);

  return {
    nodes: nodes.map((node) => ({ id: node.id, label: node.name, type: node.type, weight: node.mentions })),
    edges,
    truncated: nodes.length >= limit,
  };
}

export function rebuildEntityAggregates(): { entities: number; edges: number } {
  const db = getDb();
  const entities = run(
    db,
    "UPDATE entities SET mentions = (SELECT COUNT(*) FROM entity_mentions WHERE entity_id = entities.id)",
  ).changes;
  return { entities, edges: 0 };
}

export { WIKI_LINK };
