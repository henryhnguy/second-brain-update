import { getAiConfig } from "../ai/config";
import { chatComplete, chatConfigured } from "../ai/chat-provider";
import { badRequest } from "../core/errors";
import { createLogger } from "../core/logger";
import { normalizeWhitespace, truncate } from "../core/text";
import { nowIso } from "../core/time";
import { getDb } from "../db/connection";
import { documentChunks, getDocument } from "../db/repo/documents";
import { createNote, updateNote } from "../db/repo/notes";
import { all, num, str, strOrNull } from "../db/sql";
import type { Doc } from "../types/domain";

/**
 * The curator is the part of the app that turns a pile of captured documents
 * into a second brain: a map of what is stored (index), a short one-pager per
 * document (distill), and a periodic health check (review). Everything here is
 * deterministic unless a model is configured; the deterministic path is what
 * keeps the feature usable offline and in tests.
 */

const logger = createLogger("curator");

/* ------------------------------------------------------------------ types */

export type DistillTemplateId = "generic" | "guideline" | "project" | "meeting" | "decision";
export type DistillLang = "en" | "vi";

export type DistillSection = { key: string; en: string; vi: string };

export type DistillTemplate = {
  id: DistillTemplateId;
  name: string;
  description: string;
  sections: DistillSection[];
};

export type IndexedDocument = {
  id: string;
  title: string;
  sourceId: string;
  sourceKind: string;
  path: string | null;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  charCount: number;
  tokenCount: number;
  chunkCount: number;
  pinned: boolean;
  tags: string[];
  hasSummary: boolean;
};

export type Shelf = {
  id: string;
  label: string;
  sourceKind: string;
  count: number;
  tokens: number;
  tagged: number;
  summarized: number;
  pinned: number;
  lastTouchedAt: string | null;
  documents: IndexedDocument[];
};

export type Coverage = {
  tagged: number;
  summarized: number;
  linked: number;
};

export type MasterIndex = {
  generatedAt: string;
  totals: {
    documents: number;
    notes: number;
    tags: number;
    links: number;
    summaries: number;
    shelves: number;
  };
  coverage: Coverage;
  shelves: Shelf[];
  recent: IndexedDocument[];
  pinned: IndexedDocument[];
};

export type HealthFindingKind =
  | "duplicate"
  | "empty"
  | "untagged"
  | "unsummarized"
  | "stale"
  | "orphan_note"
  | "broken_link"
  | "large";

export type HealthFinding = {
  kind: HealthFindingKind;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  documentId?: string;
  relatedIds?: string[];
};

export type HealthReport = {
  generatedAt: string;
  thresholds: { staleDays: number };
  totals: {
    documents: number;
    notes: number;
    issues: number;
    bySeverity: Record<"high" | "medium" | "low", number>;
  };
  coverage: Coverage;
  counts: Record<HealthFindingKind, number>;
  findings: HealthFinding[];
};

export type DistillInput = {
  documentId: string;
  template?: DistillTemplateId;
  lang?: DistillLang;
  /** Persist the one-pager as a note (default true). */
  save?: boolean;
  /** Use a configured model when one exists (default true). */
  useLlm?: boolean;
};

export type DistillResult = {
  documentId: string;
  template: DistillTemplateId;
  lang: DistillLang;
  markdown: string;
  usedLlm: boolean;
  noteId: string | null;
  noteTitle: string | null;
  updated: boolean;
};

/* -------------------------------------------------------------- templates */

export const DISTILL_TEMPLATES: DistillTemplate[] = [
  {
    id: "generic",
    name: "Generic one-pager",
    description: "Summary, key points, terms and provenance for any document.",
    sections: [
      { key: "summary", en: "Summary", vi: "Tóm tắt" },
      { key: "points", en: "Key points", vi: "Điểm chính" },
      { key: "terms", en: "Key terms", vi: "Thuật ngữ" },
      { key: "source", en: "Source", vi: "Nguồn" },
    ],
  },
  {
    id: "guideline",
    name: "Guideline / SOP",
    description: "Purpose, when to use it, the rules that matter and the usual mistakes.",
    sections: [
      { key: "purpose", en: "Purpose", vi: "Mục đích" },
      { key: "when", en: "When to use", vi: "Khi nào dùng" },
      { key: "who", en: "Who it is for", vi: "Ai sử dụng" },
      { key: "points", en: "Key rules", vi: "Quy tắc chính" },
      { key: "watchouts", en: "Watch-outs", vi: "Lưu ý / sai sót thường gặp" },
      { key: "source", en: "Source", vi: "Nguồn" },
    ],
  },
  {
    id: "project",
    name: "Project card",
    description: "What the project is, where it stands, its milestones and risks.",
    sections: [
      { key: "summary", en: "What it is", vi: "Nội dung" },
      { key: "status", en: "Status", vi: "Trạng thái" },
      { key: "timeline", en: "Timeline", vi: "Mốc thời gian" },
      { key: "points", en: "Key points", vi: "Điểm chính" },
      { key: "risks", en: "Risks", vi: "Rủi ro" },
      { key: "source", en: "Source", vi: "Nguồn" },
    ],
  },
  {
    id: "meeting",
    name: "Meeting note",
    description: "What was discussed, what was decided and what happens next.",
    sections: [
      { key: "summary", en: "What was discussed", vi: "Nội dung trao đổi" },
      { key: "attendees", en: "Attendees", vi: "Thành phần" },
      { key: "decisions", en: "Decisions", vi: "Quyết định" },
      { key: "actions", en: "Next actions", vi: "Việc tiếp theo" },
      { key: "source", en: "Source", vi: "Nguồn" },
    ],
  },
  {
    id: "decision",
    name: "Decision log",
    description: "The decision, the context, the options weighed and the consequences.",
    sections: [
      { key: "decision", en: "Decision", vi: "Quyết định" },
      { key: "context", en: "Context", vi: "Bối cảnh" },
      { key: "options", en: "Options considered", vi: "Phương án đã cân nhắc" },
      { key: "consequences", en: "Consequences", vi: "Hệ quả" },
      { key: "source", en: "Source", vi: "Nguồn" },
    ],
  },
];

export function listDistillTemplates(): DistillTemplate[] {
  return DISTILL_TEMPLATES;
}

export function getDistillTemplate(id: string | null | undefined): DistillTemplate {
  return DISTILL_TEMPLATES.find((template) => template.id === id) ?? DISTILL_TEMPLATES[0]!;
}

function sectionLabel(template: DistillTemplate, key: string, lang: DistillLang): string {
  const section = template.sections.find((entry) => entry.key === key);
  if (!section) return key;
  return lang === "vi" ? section.vi : section.en;
}

/* ------------------------------------------------------------------ utils */

type DocLite = {
  doc: Doc;
  tags: string[];
};

function loadDocs(): DocLite[] {
  const rows = all<Record<string, unknown>>(
    getDb(),
    `SELECT * FROM documents WHERE deleted_at IS NULL
     ORDER BY pinned DESC, COALESCE(updated_at, ingested_at) DESC`,
  );
  const tagRows = all<{ document_id: string; name: string }>(
    getDb(),
    `SELECT dt.document_id, t.name FROM document_tags dt JOIN tags t ON t.id = dt.tag_id ORDER BY t.name`,
  );
  const tagMap = new Map<string, string[]>();
  for (const row of tagRows) {
    const list = tagMap.get(str(row.document_id)) ?? [];
    list.push(str(row.name));
    tagMap.set(str(row.document_id), list);
  }

  return rows.map((row) => ({
    doc: {
      id: str(row.id),
      sourceKind: str(row.source_kind, "upload") as Doc["sourceKind"],
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
      status: str(row.status, "indexed") as Doc["status"],
      pinned: num(row.pinned) === 1,
      meta: parseMeta(row.meta),
      deletedAt: strOrNull(row.deleted_at),
    },
    tags: tagMap.get(str(row.id)) ?? [],
  }));
}

function parseMeta(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isSummaryNote(entry: DocLite): boolean {
  return entry.doc.sourceKind === "note" && entry.doc.meta.kind === "summary";
}

function summarySourceId(entry: DocLite): string | null {
  const value = entry.doc.meta.sourceDocumentId;
  return typeof value === "string" ? value : null;
}

function indexEntry(entry: DocLite, summarized: Set<string>): IndexedDocument {
  return {
    id: entry.doc.id,
    title: entry.doc.title,
    sourceId: entry.doc.sourceId,
    sourceKind: entry.doc.sourceKind,
    path: entry.doc.path,
    url: entry.doc.url,
    createdAt: entry.doc.createdAt,
    updatedAt: entry.doc.updatedAt,
    charCount: entry.doc.charCount,
    tokenCount: entry.doc.tokenCount,
    chunkCount: entry.doc.chunkCount,
    pinned: entry.doc.pinned,
    tags: entry.tags,
    hasSummary: summarized.has(entry.doc.id),
  };
}

function shelfLabel(sourceId: string): string {
  const cleaned = sourceId.replace(/[:/_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "Unfiled";
  return cleaned.replace(/\b\w/g, (character) => character.toUpperCase());
}

type LinkCounts = { outgoing: Map<string, number>; incoming: Map<string, number> };

function loadLinkCounts(): LinkCounts {
  const db = getDb();
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const row of all<{ id: string; c: number }>(
    db,
    "SELECT from_document_id AS id, COUNT(*) AS c FROM doc_links GROUP BY from_document_id",
  )) {
    outgoing.set(str(row.id), num(row.c));
  }
  for (const row of all<{ id: string; c: number }>(
    db,
    "SELECT to_document_id AS id, COUNT(*) AS c FROM doc_links WHERE to_document_id IS NOT NULL GROUP BY to_document_id",
  )) {
    incoming.set(str(row.id), num(row.c));
  }
  return { outgoing, incoming };
}

function linkTotals(): number {
  const row = all<{ c: number }>(getDb(), "SELECT COUNT(*) AS c FROM doc_links")[0];
  return num(row?.c);
}

function tagTotals(): number {
  const row = all<{ c: number }>(getDb(), "SELECT COUNT(*) AS c FROM tags")[0];
  return num(row?.c);
}

function dayOf(value: string | null): string {
  return value ? value.slice(0, 10) : "date unknown";
}

/* ------------------------------------------------------------------ index */

export function buildMasterIndex(options: { docsPerShelf?: number } = {}): MasterIndex {
  const docsPerShelf = Math.min(Math.max(options.docsPerShelf ?? 6, 1), 50);
  const entries = loadDocs();
  const links = loadLinkCounts();
  const summaries = new Set<string>();
  for (const entry of entries) {
    if (!isSummaryNote(entry)) continue;
    const sourceId = summarySourceId(entry);
    if (sourceId) summaries.add(sourceId);
  }

  const summarized = new Set<string>();
  for (const entry of entries) {
    if (summaries.has(entry.doc.id)) summarized.add(entry.doc.id);
  }

  const shelves = new Map<string, Shelf>();
  for (const entry of entries) {
    const key = entry.doc.sourceId;
    const shelf =
      shelves.get(key) ??
      ({
        id: key,
        label: shelfLabel(key),
        sourceKind: entry.doc.sourceKind,
        count: 0,
        tokens: 0,
        tagged: 0,
        summarized: 0,
        pinned: 0,
        lastTouchedAt: null,
        documents: [],
      } satisfies Shelf);
    shelf.count += 1;
    shelf.tokens += entry.doc.tokenCount;
    if (entry.tags.length > 0) shelf.tagged += 1;
    if (summarized.has(entry.doc.id)) shelf.summarized += 1;
    if (entry.doc.pinned) shelf.pinned += 1;
    const touched = entry.doc.updatedAt ?? entry.doc.createdAt ?? entry.doc.ingestedAt;
    if (!shelf.lastTouchedAt || touched > shelf.lastTouchedAt) shelf.lastTouchedAt = touched;
    if (shelf.documents.length < docsPerShelf) shelf.documents.push(indexEntry(entry, summarized));
    shelves.set(key, shelf);
  }

  const ordered = Array.from(shelves.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const total = entries.length;
  const nonNotes = entries.filter((entry) => entry.doc.sourceKind !== "note").length;
  const linked = entries.filter(
    (entry) => (links.outgoing.get(entry.doc.id) ?? 0) > 0 || (links.incoming.get(entry.doc.id) ?? 0) > 0,
  ).length;
  const tagged = entries.filter((entry) => entry.tags.length > 0).length;

  return {
    generatedAt: nowIso(),
    totals: {
      documents: total,
      notes: entries.filter((entry) => entry.doc.sourceKind === "note").length,
      tags: tagTotals(),
      links: linkTotals(),
      summaries: summarized.size,
      shelves: ordered.length,
    },
    coverage: {
      tagged: total === 0 ? 0 : tagged / total,
      summarized: nonNotes === 0 ? 0 : summarized.size / nonNotes,
      linked: total === 0 ? 0 : linked / total,
    },
    shelves: ordered,
    recent: entries.slice(0, 10).map((entry) => indexEntry(entry, summarized)),
    pinned: entries.filter((entry) => entry.doc.pinned).slice(0, 10).map((entry) => indexEntry(entry, summarized)),
  };
}

/* ----------------------------------------------------------------- health */

const FINDING_LIMITS: Record<HealthFindingKind, number> = {
  duplicate: 10,
  empty: 10,
  untagged: 25,
  unsummarized: 25,
  stale: 15,
  orphan_note: 10,
  broken_link: 10,
  large: 10,
};

const SEVERITY: Record<HealthFindingKind, HealthFinding["severity"]> = {
  duplicate: "high",
  empty: "high",
  broken_link: "high",
  unsummarized: "medium",
  orphan_note: "medium",
  untagged: "low",
  stale: "low",
  large: "low",
};

const KIND_LABEL: Record<HealthFindingKind, { en: string; vi: string }> = {
  duplicate: { en: "Duplicate content", vi: "Nội dung trùng" },
  empty: { en: "Empty or failed document", vi: "Tài liệu rỗng hoặc lỗi" },
  broken_link: { en: "Unresolved wiki link", vi: "Liên kết wiki chưa phân giải" },
  unsummarized: { en: "No one-pager yet", vi: "Chưa có bản tóm tắt" },
  orphan_note: { en: "Orphan note", vi: "Ghi chú mồ côi" },
  untagged: { en: "No tags", vi: "Chưa gắn thẻ" },
  stale: { en: "Stale document", vi: "Tài liệu cũ" },
  large: { en: "Very large document", vi: "Tài liệu quá lớn" },
};

export function buildHealthReport(options: { days?: number } = {}): HealthReport {
  const staleDays = Math.min(Math.max(options.days ?? 180, 30), 3_650);
  const entries = loadDocs();
  const links = loadLinkCounts();
  const summarized = new Set<string>();
  for (const entry of entries) {
    if (!isSummaryNote(entry)) continue;
    const sourceId = summarySourceId(entry);
    if (sourceId) summarized.add(sourceId);
  }

  const counts: Record<HealthFindingKind, number> = {
    duplicate: 0,
    empty: 0,
    untagged: 0,
    unsummarized: 0,
    stale: 0,
    orphan_note: 0,
    broken_link: 0,
    large: 0,
  };
  const buckets: Record<HealthFindingKind, HealthFinding[]> = {
    duplicate: [],
    empty: [],
    untagged: [],
    unsummarized: [],
    stale: [],
    orphan_note: [],
    broken_link: [],
    large: [],
  };
  const push = (finding: HealthFinding) => {
    counts[finding.kind] += 1;
    if (buckets[finding.kind].length < FINDING_LIMITS[finding.kind]) buckets[finding.kind].push(finding);
  };

  // Duplicates: same content hash captured twice.
  const byHash = new Map<string, DocLite[]>();
  for (const entry of entries) {
    if (!entry.doc.contentHash || isSummaryNote(entry)) continue;
    const group = byHash.get(entry.doc.contentHash) ?? [];
    group.push(entry);
    byHash.set(entry.doc.contentHash, group);
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const [first] = group;
    if (!first) continue;
    push({
      kind: "duplicate",
      severity: "high",
      title: truncate(first.doc.title, 110),
      detail: `${group.length} documents share one content hash · e.g. ${group.map((entry) => `\`${entry.doc.sourceId}\``).join(", ")}`,
      documentId: first.doc.id,
      relatedIds: group.map((entry) => entry.doc.id),
    });
  }

  const staleBefore = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();

  for (const entry of entries) {
    const doc = entry.doc;
    if (isSummaryNote(entry)) continue;

    if (doc.status === "failed" || doc.charCount === 0) {
      push({
        kind: "empty",
        severity: "high",
        title: truncate(doc.title, 110),
        detail: doc.status === "failed" ? "Extraction failed; the text was never indexed." : "Indexed with zero characters of text.",
        documentId: doc.id,
      });
    }
    if (entry.tags.length === 0) {
      push({
        kind: "untagged",
        severity: "low",
        title: truncate(doc.title, 110),
        detail: `Source \`${doc.sourceId}\` · no tags`,
        documentId: doc.id,
      });
    }
    if (doc.sourceKind !== "note" && doc.charCount > 0 && !summarized.has(doc.id)) {
      push({
        kind: "unsummarized",
        severity: "medium",
        title: truncate(doc.title, 110),
        detail: `Source \`${doc.sourceId}\` · no one-pager yet`,
        documentId: doc.id,
      });
    }
    const touched = doc.updatedAt ?? doc.createdAt ?? doc.ingestedAt;
    if (touched < staleBefore) {
      push({
        kind: "stale",
        severity: "low",
        title: truncate(doc.title, 110),
        detail: `Last touched ${dayOf(touched)} · older than ${staleDays} days`,
        documentId: doc.id,
      });
    }
    if (doc.tokenCount > 20_000) {
      push({
        kind: "large",
        severity: "low",
        title: truncate(doc.title, 110),
        detail: `${doc.tokenCount.toLocaleString("en-US")} tokens · consider splitting or distilling it`,
        documentId: doc.id,
      });
    }
    if (doc.sourceKind === "note") {
      const outgoing = links.outgoing.get(doc.id) ?? 0;
      const incoming = links.incoming.get(doc.id) ?? 0;
      if (entry.tags.length === 0 && outgoing === 0 && incoming === 0) {
        push({
          kind: "orphan_note",
          severity: "medium",
          title: truncate(doc.title, 110),
          detail: "No tags, no outgoing links and no backlinks: nothing points at this note.",
          documentId: doc.id,
        });
      }
    }
  }

  // Wiki links whose target no longer exists.
  const broken = all<Record<string, unknown>>(
    getDb(),
    `SELECT l.from_document_id, l.to_slug, d.title FROM doc_links l
     JOIN documents d ON d.id = l.from_document_id AND d.deleted_at IS NULL
     LEFT JOIN documents t ON t.id = l.to_document_id AND t.deleted_at IS NULL
     WHERE l.to_document_id IS NULL OR t.id IS NULL
     LIMIT 200`,
  );
  for (const row of broken) {
    push({
      kind: "broken_link",
      severity: "high",
      title: `[[${str(row.to_slug)}]]`,
      detail: `Linked from “${truncate(str(row.title), 80)}” but no document has that title.`,
      documentId: str(row.from_document_id),
    });
  }

  const findings = (Object.keys(buckets) as HealthFindingKind[])
    .flatMap((kind) => buckets[kind])
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const kind of Object.keys(counts) as HealthFindingKind[]) {
    bySeverity[SEVERITY[kind]] += counts[kind];
  }

  const total = entries.length;
  const nonNotes = entries.filter((entry) => entry.doc.sourceKind !== "note").length;
  const taggedCount = entries.filter((entry) => entry.tags.length > 0).length;
  const linkedCount = entries.filter(
    (entry) => (links.outgoing.get(entry.doc.id) ?? 0) > 0 || (links.incoming.get(entry.doc.id) ?? 0) > 0,
  ).length;

  return {
    generatedAt: nowIso(),
    thresholds: { staleDays },
    totals: {
      documents: total,
      notes: entries.filter((entry) => entry.doc.sourceKind === "note").length,
      issues: Object.values(counts).reduce((sum, value) => sum + value, 0),
      bySeverity,
    },
    coverage: {
      tagged: total === 0 ? 0 : taggedCount / total,
      summarized: nonNotes === 0 ? 0 : summarized.size / nonNotes,
      linked: total === 0 ? 0 : linkedCount / total,
    },
    counts,
    findings,
  };
}

function severityRank(severity: HealthFinding["severity"]): number {
  return severity === "high" ? 0 : severity === "medium" ? 1 : 2;
}

/* -------------------------------------------------------------- rendering */

const L = {
  onePager: { en: "One-pager", vi: "Bản tóm tắt" },
  generated: { en: "Generated from", vi: "Tạo từ" },
  on: { en: "on", vi: "ngày" },
  template: { en: "template", vi: "mẫu" },
  source: { en: "Source", vi: "Nguồn" },
  document: { en: "Document", vi: "Tài liệu" },
  origin: { en: "Origin", vi: "Nguồn gốc" },
  captured: { en: "Captured", vi: "Ngày nhập" },
  updated: { en: "Updated", vi: "Cập nhật" },
  size: { en: "Size", vi: "Kích thước" },
  notStated: { en: "_Not stated in the source._", vi: "_Không có trong nguồn._" },
  noModel: { en: "generated without a model", vi: "tạo không dùng mô hình" },
  withModel: { en: "generated with a model", vi: "tạo bằng mô hình" },
} as const;

function text(value: { en: string; vi: string }, lang: DistillLang): string {
  return lang === "vi" ? value.vi : value.en;
}

function sentences(textValue: string): string[] {
  return normalizeWhitespace(textValue)
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((sentence) => sentence.replace(/^[\s▪•·\-–—]+/, "").trim())
    .filter((sentence) => sentence.length >= 40 && sentence.length <= 480)
    // PDF tables of contents and page furniture dominate the first chunks of a
    // manual; they are not rules and make a one-pager look broken.
    .filter((sentence) => !/(\.{4,}|…{2,})/.test(sentence))
    .filter((sentence) => !/^\s*(page|trang)\s*\d+/i.test(sentence))
    .filter((sentence) => !/^\s*(table of contents|mục lục)\b/i.test(sentence));
}

const STOP_WORDS = new Set(
  `a an and are as at be been but by can could do does for from had has have he her his how i if in into is it its
   may me might more most must my no not of on one only or other our out over should so some such than that the their
   them then there these they this those to too up us was we were what when where which who why will with would you your
   và là của cho với trong một những các được có không khi này đó thì mà nên đã đang sẽ từ đến theo về như để hoặc nếu
   nhưng cũng rất nhiều ít hay phải cần làm người việc`.split(/\s+/),
);

function keyTerms(textValue: string, limit = 12): string[] {
  const counts = new Map<string, number>();
  const words = normalizeWhitespace(textValue).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? [];
  for (const word of words) {
    if (STOP_WORDS.has(word) || /^\d+$/.test(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

function matching(sentencesList: string[], pattern: RegExp, limit = 5): string[] {
  return sentencesList.filter((sentence) => pattern.test(sentence)).slice(0, limit);
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

type DistillContext = {
  doc: Doc;
  lang: DistillLang;
  lead: string;
  points: string[];
  terms: string[];
  watchouts: string[];
  decisions: string[];
  actions: string[];
  risks: string[];
  template: DistillTemplate;
};

function sectionBody(ctx: DistillContext, key: string): string {
  const notStated = text(L.notStated, ctx.lang);
  switch (key) {
    case "summary":
    case "purpose":
      return ctx.lead.length > 0 ? ctx.lead : notStated;
    case "when":
      return ctx.points.length > 0
        ? `Use this when the work touches: ${ctx.terms.slice(0, 6).join(", ")}.`
        : notStated;
    case "who":
      return ctx.doc.author
        ? `${ctx.doc.author}${ctx.doc.sourceId ? ` · \`${ctx.doc.sourceId}\`` : ""}`
        : `Anyone working with \`${ctx.doc.sourceId}\`.`;
    case "points":
      return ctx.points.length > 0 ? bullets(ctx.points) : notStated;
    case "watchouts":
      return ctx.watchouts.length > 0 ? bullets(ctx.watchouts) : notStated;
    case "status":
      return describeStatus(ctx);
    case "timeline":
      return bullets([
        `Captured: ${dayOf(ctx.doc.createdAt ?? ctx.doc.ingestedAt)}`,
        `Last updated: ${dayOf(ctx.doc.updatedAt ?? ctx.doc.ingestedAt)}`,
      ]);
    case "attendees":
      return ctx.doc.author ? bullets([ctx.doc.author]) : notStated;
    case "decisions":
      return ctx.decisions.length > 0 ? bullets(ctx.decisions) : notStated;
    case "actions":
      return ctx.actions.length > 0 ? bullets(ctx.actions) : notStated;
    case "risks":
      return ctx.risks.length > 0 ? bullets(ctx.risks) : notStated;
    case "decision":
      return ctx.points[0] ?? ctx.lead ?? notStated;
    case "context":
      return ctx.lead.length > 0 ? ctx.lead : notStated;
    case "options":
      return ctx.points.length > 1 ? bullets(ctx.points.slice(0, 4)) : notStated;
    case "consequences":
      return ctx.risks.length > 0 ? bullets(ctx.risks) : notStated;
    case "terms":
      return ctx.terms.length > 0 ? bullets(ctx.terms) : notStated;
    case "source":
      return sourceBlock(ctx);
    default:
      return notStated;
  }
}

function describeStatus(ctx: DistillContext): string {
  const meta = ctx.doc.meta;
  const parts: string[] = [];
  for (const key of ["status", "state", "phase"]) {
    const value = meta[key];
    if (typeof value === "string" && value.length > 0) parts.push(`${key}: **${value}**`);
  }
  if (parts.length > 0) return parts.join(" · ");
  return `Indexed ${dayOf(ctx.doc.ingestedAt)} · ${ctx.doc.chunkCount} chunks · ${ctx.doc.tokenCount.toLocaleString("en-US")} tokens.`;
}

function sourceBlock(ctx: DistillContext): string {
  const doc = ctx.doc;
  const lang = ctx.lang;
  const lines = [
    `- ${text(L.document, lang)}: [[${doc.title}]]`,
    `- ${text(L.origin, lang)}: \`${doc.sourceId}\`${doc.path ? ` · \`${doc.path}\`` : ""}${doc.url ? ` · ${doc.url}` : ""}`,
    `- ${text(L.captured, lang)}: ${dayOf(doc.createdAt ?? doc.ingestedAt)} · ${text(L.updated, lang)}: ${dayOf(doc.updatedAt ?? doc.ingestedAt)}`,
    `- ${text(L.size, lang)}: ${doc.charCount.toLocaleString("en-US")} characters · ${doc.tokenCount.toLocaleString("en-US")} tokens · ${doc.chunkCount} chunks`,
  ];
  return lines.join("\n");
}

function buildContext(doc: Doc, chunks: { text: string; headingPath: string | null }[], template: DistillTemplate, lang: DistillLang): DistillContext {
  const body = chunks.map((chunk) => chunk.text).join("\n\n");
  const list = sentences(body);
  const terms = keyTerms(body, 14);
  const top = new Set(terms.slice(0, 8));

  const scored = list
    .map((sentence, position) => {
      const lower = sentence.toLowerCase();
      const hits = Array.from(top).filter((term) => lower.includes(term)).length;
      const words = sentence.split(/\s+/).length;
      return { sentence, score: hits * 10 + Math.min(words, 40) / 10 - position / 100 };
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.sentence);

  const seen = new Set<string>();
  const points: string[] = [];
  for (const sentence of scored) {
    const fingerprint = sentence.slice(0, 80).toLowerCase();
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    points.push(truncate(sentence, 260));
    if (points.length >= 6) break;
  }
  if (points.length === 0 && list.length > 0) points.push(...list.slice(0, 4).map((sentence) => truncate(sentence, 260)));

  const lead = list.slice(0, 3).join(" ").slice(0, 700);

  return {
    doc,
    lang,
    lead,
    points,
    terms,
    watchouts: matching(list, /\b(do not|don't|never|avoid|must not|caution|warning)\b|không được|tránh|lưu ý|cảnh báo/i),
    decisions: matching(list, /\b(decided|agreed|approved|conclusion|resolved)\b|quyết định|thống nhất|kết luận/i),
    actions: matching(list, /\b(action|follow[- ]?up|next step|will|todo|owner)\b|hành động|tiếp theo|sẽ|cần làm/i),
    risks: matching(list, /\b(risk|issue|concern|problem|blocker)\b|rủi ro|vấn đề|lo ngại/i),
    template,
  };
}

function renderDeterministic(ctx: DistillContext): string {
  const doc = ctx.doc;
  const lang = ctx.lang;
  const template = ctx.template;
  const meta = doc.meta;
  const header = [
    `# ${text(L.onePager, lang)} — ${doc.title}`,
    "",
    `> ${text(L.generated, lang)} [[${doc.title}]] ${text(L.on, lang)} ${dayOf(nowIso())} · \`${doc.sourceId}\` · ${text(L.template, lang)}: ${template.name}`,
  ];

  const metaLines: string[] = [];
  for (const [key, label] of [
    ["code", "Code"],
    ["version", "Version"],
    ["status", "Status"],
    ["owner", "Owner"],
    ["effectiveDate", "Effective"],
  ] as const) {
    const value = meta[key];
    if (typeof value === "string" && value.trim().length > 0) metaLines.push(`- **${label}:** ${value}`);
  }
  if (metaLines.length > 0) header.push("", ...metaLines);

  const parts = [header.join("\n")];
  for (const section of template.sections) {
    parts.push(`## ${text({ en: section.en, vi: section.vi }, lang)}\n${sectionBody(ctx, section.key)}`);
  }
  parts.push(`> ${text(L.noModel, lang)}. ${lang === "vi" ? "Cấu hình mô hình trong **Settings** để có bản viết mạch lạc hơn." : "Configure a model in **Settings** for a more polished version."}`);
  return parts.join("\n\n");
}

async function renderWithModel(ctx: DistillContext, sourceText: string): Promise<string | null> {
  if (!chatConfigured()) return null;
  const lang = ctx.lang;
  const outline = ctx.template.sections.map((section) => `## ${text({ en: section.en, vi: section.vi }, lang)}`).join("\n");
  try {
    const result = await chatComplete(
      [
        {
          role: "system",
          content:
            "You write one-page knowledge notes from a single source document. Use only the source. If a section is not covered, write that it is not stated. Return Markdown, keep it under 400 words, and start with a level-1 heading.",
        },
        {
          role: "user",
          content: [
            `LANGUAGE: ${lang === "vi" ? "Vietnamese" : "English"}`,
            `TITLE: ${ctx.doc.title}`,
            `TEMPLATE: ${ctx.template.name}`,
            `SECTIONS TO FILL:\n${outline}`,
            `SOURCE EXCERPTS:\n${sourceText.slice(0, 8_000)}`,
          ].join("\n\n"),
        },
      ],
      { config: getAiConfig() },
    );
    const content = result.content.trim();
    return content.length > 0 ? content : null;
  } catch (error) {
    logger.warn("distill model synthesis failed; keeping deterministic output", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function summaryNoteFor(sourceDocumentId: string, template: string): string | null {
  const rows = all<Record<string, unknown>>(
    getDb(),
    "SELECT id, meta FROM documents WHERE source_kind = 'note' AND deleted_at IS NULL",
  );
  for (const row of rows) {
    const meta = parseMeta(row.meta);
    if (meta.kind === "summary" && meta.sourceDocumentId === sourceDocumentId && meta.template === template) {
      return str(row.id);
    }
  }
  return null;
}

/** Builds (and by default saves) a one-page note for one document. */
export async function distillDocument(input: DistillInput): Promise<DistillResult> {
  const doc = getDocument(input.documentId);
  if (!doc) throw new Error(`Document ${input.documentId} not found`);
  if (doc.meta.kind === "summary") {
    throw badRequest("This document is already a one-pager. Distill its source document instead.");
  }
  const template = getDistillTemplate(input.template);
  const lang: DistillLang = input.lang === "vi" ? "vi" : "en";
  const chunks = documentChunks(doc.id);
  if (chunks.length === 0) throw new Error("This document has no indexed text to distil.");

  const ctx = buildContext(doc, chunks, template, lang);
  let markdown = renderDeterministic(ctx);
  let usedLlm = false;

  if (input.useLlm !== false) {
    const synthesized = await renderWithModel(ctx, chunks.map((chunk) => chunk.text).join("\n\n"));
    if (synthesized) {
      markdown = synthesized;
      usedLlm = true;
    }
  }

  const noteTitle = `${text(L.onePager, lang)} — ${truncate(doc.title, 80)}`;
  let noteId: string | null = null;
  let updated = false;

  if (input.save !== false) {
    const existing = summaryNoteFor(doc.id, template.id);
    if (existing) {
      updateNote(existing, { title: noteTitle, markdown });
      noteId = existing;
      updated = true;
    } else {
      const note = createNote({
        title: noteTitle,
        markdown,
        meta: {
          kind: "summary",
          sourceDocumentId: doc.id,
          sourceTitle: doc.title,
          template: template.id,
          generatedAt: nowIso(),
          usedLlm,
        },
      });
      noteId = note.document.id;
    }
  }

  return {
    documentId: doc.id,
    template: template.id,
    lang,
    markdown,
    usedLlm,
    noteId,
    noteTitle: input.save === false ? null : noteTitle,
    updated,
  };
}

/* ----------------------------------------------------------------- review */

export function renderReviewMarkdown(report: HealthReport, lang: DistillLang = "en"): string {
  const vi = lang === "vi";
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const title = vi ? "Đánh giá bộ não" : "Brain review";
  const lines: string[] = [
    `# ${title} — ${report.generatedAt.slice(0, 10)}`,
    "",
    vi
      ? `**${report.totals.documents}** tài liệu · **${report.totals.notes}** ghi chú · **${report.totals.issues}** vấn đề (cao ${report.totals.bySeverity.high} · vừa ${report.totals.bySeverity.medium} · thấp ${report.totals.bySeverity.low})`
      : `**${report.totals.documents}** documents · **${report.totals.notes}** notes · **${report.totals.issues}** issues (${report.totals.bySeverity.high} high · ${report.totals.bySeverity.medium} medium · ${report.totals.bySeverity.low} low)`,
    "",
    vi ? "## Độ phủ" : "## Coverage",
    `- ${vi ? "Có thẻ" : "Tagged"}: **${pct(report.coverage.tagged)}**`,
    `- ${vi ? "Có bản tóm tắt" : "Distilled"}: **${pct(report.coverage.summarized)}**`,
    `- ${vi ? "Có liên kết" : "Linked"}: **${pct(report.coverage.linked)}**`,
    "",
    vi ? "## Vấn đề theo loại" : "## Issues by kind",
  ];

  const kinds = Object.keys(report.counts) as HealthFindingKind[];
  for (const kind of kinds) {
    if (report.counts[kind] === 0) continue;
    const label = vi ? KIND_LABEL[kind].vi : KIND_LABEL[kind].en;
    lines.push(`- ${label}: **${report.counts[kind]}**`);
  }
  if (report.totals.issues === 0) lines.push(vi ? "- Không có vấn đề nào. 🎉" : "- No issues found.");

  const groups: HealthFinding["severity"][] = ["high", "medium", "low"];
  for (const severity of groups) {
    const findings = report.findings.filter((finding) => finding.severity === severity).slice(0, 8);
    if (findings.length === 0) continue;
    lines.push("", `## ${vi ? "Mức" : "Severity"}: ${severity}`);
    for (const finding of findings) {
      lines.push(`- **${finding.title}** — ${finding.detail}`);
    }
  }

  const actions: string[] = [];
  if (report.counts.duplicate > 0) actions.push(vi ? "Gộp hoặc lưu trữ các bản trùng trong `99_Archive`." : "Merge or archive the duplicate copies.");
  if (report.counts.unsummarized > 0) actions.push(vi ? "Tạo one-pager cho các tài liệu quan trọng nhất." : "Distil the most important documents into one-pagers.");
  if (report.counts.untagged > 0) actions.push(vi ? "Gắn thẻ theo 3 trục: lĩnh vực · đối tượng · loại." : "Tag by domain · object · type.");
  if (report.counts.broken_link > 0) actions.push(vi ? "Sửa các liên kết wiki trỏ tới tài liệu không còn tồn tại." : "Fix wiki links that point at missing documents.");
  if (report.counts.stale > 0) actions.push(vi ? "Rà lại tài liệu cũ: còn hiệu lực, thay thế hay lưu trữ?" : "Review stale documents: still valid, superseded or archive?");
  if (actions.length > 0) {
    lines.push("", vi ? "## Việc nên làm tiếp" : "## Suggested next actions");
    actions.forEach((action, index) => lines.push(`${index + 1}. ${action}`));
  }

  return lines.join("\n");
}

export function renderIndexMarkdown(index: MasterIndex): string {
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const lines = [
    `# Memory map — ${index.generatedAt.slice(0, 10)}`,
    "",
    `**${index.totals.documents}** documents · **${index.totals.shelves}** shelves · **${index.totals.tags}** tags · **${index.totals.links}** links · **${index.totals.summaries}** one-pagers`,
    "",
    `Coverage: tagged **${pct(index.coverage.tagged)}** · distilled **${pct(index.coverage.summarized)}** · linked **${pct(index.coverage.linked)}**`,
    "",
    "## Shelves",
  ];
  for (const shelf of index.shelves) {
    lines.push(
      `- **${shelf.label}** (\`${shelf.id}\`) — ${shelf.count} docs · ${shelf.summarized} distilled · ${shelf.tagged} tagged · last ${dayOf(shelf.lastTouchedAt)}`,
    );
    for (const doc of shelf.documents.slice(0, 3)) {
      lines.push(`  - ${truncate(doc.title, 90)}${doc.hasSummary ? " ✓" : ""}`);
    }
  }
  return lines.join("\n");
}
