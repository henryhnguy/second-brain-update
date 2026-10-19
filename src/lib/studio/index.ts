import { getAiConfig } from "../ai/config";
import { chatComplete, chatConfigured } from "../ai/chat-provider";
import { badRequest } from "../core/errors";
import { createLogger } from "../core/logger";
import { normalizeWhitespace, truncate } from "../core/text";
import { nowIso } from "../core/time";
import { createArtifact } from "../db/repo/artifacts";
import { collectionDocumentIds } from "../db/repo/collections";
import { documentChunks, getDocument, listDocuments } from "../db/repo/documents";
import { search } from "../retrieval/hybrid";
import type { Artifact, ArtifactKind, ArtifactSlide, Citation, Doc, MindMapNode } from "../types/domain";

/**
 * Studio turns a chosen set of sources into a lesson or a slide deck — the
 * NotebookLM "studio" idea, but local-first and deterministic by default.
 *
 * Every artifact is grounded: passages are taken from the selected documents,
 * numbered `[n]`, and the numbering is persisted with the artifact so a
 * citation still resolves after a reload.
 */

const logger = createLogger("studio");

export type StudioLang = "en" | "vi";

export type GenerateInput = {
  kind: ArtifactKind;
  /** Explicit source selection (the Studio picker sends this). */
  documentIds?: string[];
  collectionId?: string | null;
  /** Search for sources instead of naming them. */
  query?: string;
  limit?: number;
  /** Upper bound on generated slides (4–20; default 10). */
  maxSlides?: number;
  lang?: StudioLang;
  useLlm?: boolean;
  title?: string;
};

type Source = {
  index: number;
  doc: Doc;
  text: string;
  citation: Citation;
};

const MAX_DOCS = 25;
const MAX_CHARS_PER_DOC = 6_000;

const STOP_WORDS = new Set(
  `a an and are as at be been but by can could do does for from had has have he her his how i if in into is it its
   may me might more most must my no not of on one only or other our out over should so some such than that the their
   them then there these they this those to too up us was we were what when where which who why will with would you your
   và là của cho với trong một những các được có không khi này đó thì mà nên đã đang sẽ từ đến theo về như để hoặc nếu
   nhưng cũng rất nhiều ít hay phải cần làm người việc`.split(/\s+/),
);

function tidy(text: string): string {
  return normalizeWhitespace(text).replace(/\s+/g, " ").trim();
}

function sentences(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((sentence) => sentence.replace(/^[\s▪•·\-–—]+/, "").trim())
    .filter((sentence) => sentence.length >= 40 && sentence.length <= 420)
    .filter((sentence) => !/(\.{4,}|…{2,})/.test(sentence))
    .filter((sentence) => !/^\s*(page|trang)\s*\d+/i.test(sentence))
    .filter((sentence) => !/^\s*(table of contents|mục lục)\b/i.test(sentence));
}

function terms(text: string, limit = 12): string[] {
  const counts = new Map<string, number>();
  for (const word of normalizeWhitespace(text).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? []) {
    if (STOP_WORDS.has(word) || /^\d+$/.test(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

function rankSentences(text: string, limit = 5): string[] {
  const list = sentences(text);
  const top = new Set(terms(text, 10).slice(0, 6));
  const scored = list.map((sentence, position) => {
    const lower = sentence.toLowerCase();
    const hits = Array.from(top).filter((term) => lower.includes(term)).length;
    const ruleLike = /\b(must|should|always|never|required|ensure|check|use|apply)\b|phải|cần|không được|kiểm tra/i.test(
      sentence,
    )
      ? 2
      : 0;
    return { sentence, score: hits * 6 + ruleLike + Math.min(sentence.length, 240) / 240 - position / 50 };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.sentence)
    .slice(0, limit);
}

function docText(doc: Doc): string {
  return documentChunks(doc.id)
    .map((chunk) => chunk.text)
    .join("\n\n")
    .slice(0, MAX_CHARS_PER_DOC);
}

function toCitation(index: number, doc: Doc, snippet: string): Citation {
  return {
    index,
    documentId: doc.id,
    chunkId: null,
    headingPath: null,
    title: doc.title,
    sourceKind: doc.sourceKind,
    sourceId: doc.sourceId,
    url: doc.url,
    path: doc.path,
    createdAt: doc.createdAt,
    snippet: truncate(tidy(snippet), 240),
    score: 0,
  };
}

async function resolveDocuments(input: GenerateInput): Promise<Doc[]> {
  const limit = Math.min(Math.max(input.limit ?? 8, 1), MAX_DOCS);
  const seen = new Set<string>();
  const docs: Doc[] = [];
  const add = (doc: Doc | null) => {
    if (!doc || doc.deletedAt || seen.has(doc.id)) return;
    seen.add(doc.id);
    docs.push(doc);
  };

  if (input.documentIds && input.documentIds.length > 0) {
    for (const id of input.documentIds) add(getDocument(id));
  } else if (input.collectionId) {
    for (const id of collectionDocumentIds(input.collectionId, limit)) add(getDocument(id));
  } else if (input.query && input.query.trim().length > 0) {
    const found = await search({ query: input.query, limit: Math.max(limit * 2, 10) });
    const ids = Array.from(new Set(found.hits.map((hit) => hit.documentId)));
    for (const id of ids) add(getDocument(id));
  } else {
    for (const doc of listDocuments({ limit, orderBy: "created" }).items) add(doc);
  }

  return docs.slice(0, limit);
}

function collectSources(docs: Doc[]): Source[] {
  return docs.map((doc, position) => {
    const text = docText(doc);
    return {
      index: position + 1,
      doc,
      text,
      citation: toCitation(position + 1, doc, text.slice(0, 400)),
    };
  });
}

function commonTitle(sources: Source[], kind: ArtifactKind, explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const first = sources[0]?.doc.title ?? "your memory";
  const label = kind === "lesson" ? "Lesson" : kind === "mindmap" ? "Mind map" : "Deck";
  if (sources.length <= 1) return `${label} — ${truncate(first, 80)}`;
  return `${label} — ${truncate(first, 60).replace(/…$/, "")} (+${sources.length - 1})`;
}

/* ---------------------------------------------------------------- lesson */

const L = {
  built: { en: "Built from", vi: "Xây dựng từ" },
  source: { en: "source", vi: "nguồn" },
  sources: { en: "sources", vi: "nguồn" },
  objectives: { en: "Learning objectives", vi: "Mục tiêu bài học" },
  objectivesLead: {
    en: "By the end of this lesson you should be able to:",
    vi: "Sau bài học này bạn có thể:",
  },
  concepts: { en: "Core concepts", vi: "Khái niệm cốt lõi" },
  terms: { en: "Key terms", vi: "Thuật ngữ chính" },
  example: { en: "Worked example", vi: "Ví dụ áp dụng" },
  quiz: { en: "Check your understanding", vi: "Kiểm tra hiểu bài" },
  cards: { en: "Flashcards", vi: "Thẻ ghi nhớ" },
  sourceList: { en: "Sources", vi: "Nguồn" },
  notes: { en: "Speaker notes", vi: "Ghi chú thuyết trình" },
  noModel: {
    en: "Generated without a model: passages are selected and ordered, not rewritten. Configure a model in Settings for a written lesson.",
    vi: "Tạo không dùng mô hình: các đoạn được chọn và sắp xếp, chưa viết lại. Cấu hình mô hình trong Settings để có bài giảng mạch lạc hơn.",
  },
} as const;

function text(value: { en: string; vi: string }, lang: StudioLang): string {
  return lang === "vi" ? value.vi : value.en;
}

function buildLesson(sources: Source[], title: string, lang: StudioLang): { markdown: string; usedLlm: false } {
  const lead = `# ${title}\n\n> ${text(L.built, lang)} **${sources.length}** ${text(
    sources.length === 1 ? L.source : L.sources,
    lang,
  )} · ${nowIso().slice(0, 10)} · ${sources.map((source) => `[${source.index}]`).join(" ")}`;

  const objectives = sources.slice(0, 3).map((source) => `- ${text(
    { en: "Explain the key rules in", vi: "Trình bày các quy tắc chính trong" },
    lang,
  )} *${truncate(source.doc.title, 90)}* [${source.index}]`);

  const concepts: string[] = [];
  for (const source of sources) {
    const points = rankSentences(source.text, 4);
    concepts.push(`### ${truncate(source.doc.title, 100)} [${source.index}]`);
    if (points.length === 0) {
      concepts.push(`- ${truncate(tidy(source.text), 240)} [${source.index}]`);
    } else {
      for (const point of points) concepts.push(`- ${truncate(tidy(point), 260)} [${source.index}]`);
    }
    concepts.push("");
  }

  const allTerms = terms(sources.map((source) => source.text).join("\n"), 8);
  const termLines = allTerms.slice(0, 6).map((term) => {
    const source = sources.find((candidate) => candidate.text.toLowerCase().includes(term));
    const definition = source ? sentences(source.text).find((sentence) => sentence.toLowerCase().includes(term)) : null;
    return `- **${term}** — ${definition ? truncate(tidy(definition), 200) : "—"}${
      source ? ` [${source.index}]` : ""
    }`;
  });

  const example =
    sources
      .flatMap((source) => sentences(source.text).map((sentence) => ({ sentence, index: source.index })))
      .find((entry) => /\b(for example|for instance|e\.g\.|how to|step)\b|ví dụ|thực hiện/i.test(entry.sentence)) ??
    null;

  const quiz = sources.slice(0, 4).map((source, position) => {
    const points = rankSentences(source.text, 2);
    if (position % 2 === 0) {
      return `**Q${position + 1}.** ${text(
        { en: "What are the main rules in", vi: "Các quy tắc chính trong" },
        lang,
      )} *${truncate(source.doc.title, 80)}*?\n\n> ${truncate(tidy(points[0] ?? source.text), 220)} [${source.index}]`;
    }
    return `**Q${position + 1}.** ${text(
      { en: "What should you check before applying", vi: "Cần kiểm tra gì trước khi áp dụng" },
      lang,
    )} *${truncate(source.doc.title, 80)}*?\n\n> ${truncate(tidy(points[1] ?? points[0] ?? source.text), 220)} [${
      source.index
    }]`;
  });

  const flashcards = allTerms.slice(0, 6).map((term) => {
    const source = sources.find((candidate) => candidate.text.toLowerCase().includes(term));
    const definition = source ? sentences(source.text).find((sentence) => sentence.toLowerCase().includes(term)) : null;
    return `- **${term}** → ${definition ? truncate(tidy(definition), 160) : "—"}`;
  });

  const markdown = [
    lead,
    "",
    `## ${text(L.objectives, lang)}`,
    text(L.objectivesLead, lang),
    ...objectives,
    "",
    `## ${text(L.concepts, lang)}`,
    ...concepts,
    `## ${text(L.terms, lang)}`,
    ...termLines,
    "",
    `## ${text(L.example, lang)}`,
    example
      ? `${truncate(tidy(example.sentence), 320)} [${example.index}]`
      : "_No worked example was found in the selected sources. Pick a source that contains a procedure or a case study._",
    "",
    `## ${text(L.quiz, lang)}`,
    ...quiz.flatMap((entry) => [entry, ""]),
    `## ${text(L.cards, lang)}`,
    ...flashcards,
    "",
    `## ${text(L.sourceList, lang)}`,
    ...sources.map((source) => `- [${source.index}] **${source.doc.title}** — \`${source.doc.sourceId}\``),
    "",
    `> ${text(L.noModel, lang)}`,
  ].join("\n");

  return { markdown, usedLlm: false };
}

/* ----------------------------------------------------------------- slides */

function buildSlides(sources: Source[], title: string, lang: StudioLang, maxSlides: number): ArtifactSlide[] {
  const slides: ArtifactSlide[] = [
    {
      title,
      subtitle: `${sources.length} ${text(sources.length === 1 ? L.source : L.sources, lang)} · ${nowIso().slice(0, 10)}`,
      bullets: [],
      notes: text(
        {
          en: "Open with the question this deck answers, then name the sources on the last slide.",
          vi: "Mở đầu bằng câu hỏi mà bộ slide trả lời, rồi nêu nguồn ở slide cuối.",
        },
        lang,
      ),
    },
    {
      title: text({ en: "Agenda", vi: "Nội dung" }, lang),
      bullets: sources.slice(0, maxSlides - 2).map((source) => truncate(source.doc.title, 90)),
    },
  ];

  const perSource = Math.max(1, maxSlides - 3);
  for (const source of sources.slice(0, perSource)) {
    const points = rankSentences(source.text, 4);
    slides.push({
      title: truncate(source.doc.title, 80),
      subtitle: `[${source.index}] ${source.doc.sourceId}`,
      bullets: (points.length > 0 ? points : [tidy(source.text)]).slice(0, 4).map((point) => truncate(tidy(point), 160)),
      notes: `${text(L.source, lang)} [${source.index}] — ${source.doc.title}${
        source.doc.path ? ` · ${source.doc.path}` : ""
      }`,
    });
  }

  const takeaways = sources
    .flatMap((source) => rankSentences(source.text, 2).map((point) => ({ point, index: source.index })))
    .slice(0, 5)
    .map((entry) => `${truncate(tidy(entry.point), 150)} [${entry.index}]`);
  if (takeaways.length > 0) {
    slides.push({ title: text({ en: "Key takeaways", vi: "Điểm cần nhớ" }, lang), bullets: takeaways });
  }

  slides.push({
    title: text(L.sourceList, lang),
    bullets: sources.map((source) => `[${source.index}] ${truncate(source.doc.title, 100)}`),
    notes: text(
      { en: "Full paths are in the artifact record.", vi: "Đường dẫn đầy đủ nằm trong bản ghi artifact." },
      lang,
    ),
  });

  return slides.slice(0, maxSlides);
}

function slidesMarkdown(slides: ArtifactSlide[], title: string): string {
  const parts = [`# ${title}`, ""];
  for (const slide of slides) {
    parts.push(`## ${slide.title}`);
    if (slide.subtitle) parts.push(`_${slide.subtitle}_`);
    for (const bullet of slide.bullets) parts.push(`- ${bullet}`);
    if (slide.notes) parts.push(`<!-- ${slide.notes} -->`);
    parts.push("");
  }
  return parts.join("\n");
}

/* ------------------------------------------------------------------- model */

function sourceContext(sources: Source[]): string {
  return sources
    .map((source) => `[${source.index}] ${source.doc.title} (source: ${source.doc.sourceId})\n${source.text}`)
    .join("\n\n---\n\n")
    .slice(0, 24_000);
}

async function modelLesson(sources: Source[], title: string, lang: StudioLang): Promise<string | null> {
  if (!chatConfigured()) return null;
  try {
    const result = await chatComplete(
      [
        {
          role: "system",
          content:
            "You are a curriculum designer. Build a practical lesson strictly from the SOURCES. Cite every claim with [n]. Return Markdown only.",
        },
        {
          role: "user",
          content: [
            `LANGUAGE: ${lang === "vi" ? "Vietnamese" : "English"}`,
            `TITLE: ${title}`,
            "SECTIONS: Learning objectives (3), Core concepts (one subsection per source), Key terms, Worked example, Check your understanding (4 Q&A), Flashcards (6), Sources.",
            "RULES: never invent facts; if a section has no material, say so; keep it under 1,200 words.",
            `SOURCES:\n${sourceContext(sources)}`,
          ].join("\n\n"),
        },
      ],
      { config: getAiConfig() },
    );
    return result.content.trim().length > 0 ? result.content.trim() : null;
  } catch (error) {
    logger.warn("lesson model synthesis failed", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function parseSlides(content: string): ArtifactSlide[] | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as { slides?: unknown };
    if (!Array.isArray(parsed.slides)) return null;
    const slides: ArtifactSlide[] = [];
    for (const entry of parsed.slides) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const slideTitle = typeof record.title === "string" ? record.title.trim() : "";
      if (slideTitle.length === 0) continue;
      const bullets = Array.isArray(record.bullets)
        ? record.bullets.filter((bullet): bullet is string => typeof bullet === "string").slice(0, 6)
        : [];
      slides.push({
        title: truncate(slideTitle, 90),
        ...(typeof record.subtitle === "string" ? { subtitle: truncate(record.subtitle, 120) } : {}),
        bullets: bullets.map((bullet) => truncate(tidy(bullet), 180)),
        ...(typeof record.notes === "string" ? { notes: truncate(tidy(record.notes), 300) } : {}),
      });
    }
    return slides.length > 0 ? slides : null;
  } catch {
    return null;
  }
}

async function modelSlides(sources: Source[], title: string, lang: StudioLang): Promise<ArtifactSlide[] | null> {
  if (!chatConfigured()) return null;
  try {
    const result = await chatComplete(
      [
        {
          role: "system",
          content:
            "You design presentation decks from source material. Reply with JSON only, no prose and no code fence.",
        },
        {
          role: "user",
          content: [
            `LANGUAGE: ${lang === "vi" ? "Vietnamese" : "English"}`,
            `TITLE: ${title}`,
            'SCHEMA: {"title": string, "slides": [{"title": string, "subtitle": string, "bullets": string[], "notes": string}]}',
            "RULES: 7-10 slides; 3-5 short bullets per slide; notes mention the source number [n]; no invented facts.",
            `SOURCES:\n${sourceContext(sources)}`,
          ].join("\n\n"),
        },
      ],
      { config: getAiConfig() },
    );
    return parseSlides(result.content);
  } catch (error) {
    logger.warn("slides model synthesis failed", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/* ---------------------------------------------------------------- mind map */

function leafNodes(points: string[], sourceIndex: number, prefix: string): MindMapNode[] {
  return points.map((point, position) => ({
    id: `${prefix}-${position + 1}`,
    label: truncate(tidy(point), 72),
    detail: tidy(point),
    citation: sourceIndex,
    children: [],
  }));
}

/**
 * One source is mapped by its own headings; several sources become one branch
 * each. Both keep the map at two levels under the root, which is what reads
 * well on a slide and in the exported SVG.
 */
function buildMindMap(sources: Source[], title: string, lang: StudioLang): MindMapNode {
  const root: MindMapNode = { id: "root", label: truncate(title, 70), children: [] };

  if (sources.length === 1) {
    const source = sources[0] as Source;
    const byHeading = new Map<string, string[]>();
    for (const chunk of documentChunks(source.doc.id)) {
      const heading =
        (chunk.headingPath ?? "").split("›").pop()?.trim() ||
        (lang === "vi" ? "Tổng quan" : "Overview");
      const list = byHeading.get(heading) ?? [];
      list.push(chunk.text);
      byHeading.set(heading, list);
    }
    let branch = 0;
    for (const [heading, texts] of byHeading) {
      if (branch >= 7) break;
      const points = rankSentences(texts.join("\n"), 4);
      if (points.length === 0) continue;
      branch += 1;
      root.children.push({
        id: `m${branch}`,
        label: truncate(heading, 64),
        citation: source.index,
        children: leafNodes(points, source.index, `m${branch}`),
      });
    }
  }

  if (root.children.length === 0) {
    sources.slice(0, 7).forEach((source, position) => {
      const points = rankSentences(source.text, 4);
      if (points.length === 0) return;
      root.children.push({
        id: `m${position + 1}`,
        label: truncate(source.doc.title, 64),
        citation: source.index,
        children: leafNodes(points, source.index, `m${position + 1}`),
      });
    });
  }

  return root;
}

function mindmapMarkdown(root: MindMapNode): string {
  const lines = [`# ${root.label}`, ""];
  const walk = (node: MindMapNode, depth: number) => {
    lines.push(`${"  ".repeat(depth)}- ${node.label}${node.citation ? ` [${node.citation}]` : ""}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const child of root.children) walk(child, 0);
  return lines.join("\n");
}

function sanitizeMindMap(value: unknown, sources: Source[], depth = 0, counter = { value: 0 }): MindMapNode | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const label = typeof record.label === "string" ? tidy(record.label) : "";
  if (label.length === 0) return null;
  counter.value += 1;
  const citationRaw = Number(record.citation);
  const citation =
    Number.isInteger(citationRaw) && citationRaw >= 1 && citationRaw <= sources.length ? citationRaw : undefined;
  const node: MindMapNode = {
    id: `m${counter.value}`,
    label: truncate(label, 72),
    ...(citation ? { citation } : {}),
    children: [],
  };
  if (depth < 2 && Array.isArray(record.children)) {
    for (const child of record.children.slice(0, 6)) {
      const parsed = sanitizeMindMap(child, sources, depth + 1, counter);
      if (parsed) node.children.push(parsed);
    }
  }
  return node;
}

async function modelMindMap(sources: Source[], title: string, lang: StudioLang): Promise<MindMapNode | null> {
  if (!chatConfigured()) return null;
  try {
    const result = await chatComplete(
      [
        {
          role: "system",
          content: "You build mind maps from source material. Reply with JSON only, no prose and no code fence.",
        },
        {
          role: "user",
          content: [
            `LANGUAGE: ${lang === "vi" ? "Vietnamese" : "English"}`,
            `TITLE: ${title}`,
            'SCHEMA: {"label": string, "children": [{"label": string, "citation": number, "children": [{"label": string, "citation": number}]}]}',
            "RULES: exactly one branch per SOURCE, in the order given, labelled with that document's title; 3-5 leaves per branch; every branch and leaf cites its [n]; no merging sources, no invented facts.",
            `SOURCES:\n${sourceContext(sources)}`,
          ].join("\n\n"),
        },
      ],
      { config: getAiConfig() },
    );
    const start = result.content.indexOf("{");
    const end = result.content.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(result.content.slice(start, end + 1)) as unknown;
    return sanitizeMindMap(parsed, sources);
  } catch (error) {
    logger.warn("mind map model synthesis failed", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Guard for model-produced maps: a multi-source map must cite at least three
 * different sources (or all of them, when there are fewer). Exported so the
 * rule is testable without a model call.
 */
export function mindMapCoversSources(root: MindMapNode, sourceCount: number): boolean {
  if (sourceCount <= 1) return root.children.length >= 2;
  const cited = new Set(
    root.children
      .map((child) => child.citation)
      .filter((citation): citation is number => typeof citation === "number"),
  );
  return cited.size >= Math.min(3, sourceCount);
}

/* ------------------------------------------------------------------ public */

export async function generateArtifact(input: GenerateInput): Promise<Artifact> {
  if (input.kind !== "lesson" && input.kind !== "slides" && input.kind !== "mindmap") {
    throw badRequest(`Unknown artifact kind: ${input.kind}`);
  }
  const docs = await resolveDocuments(input);
  if (docs.length === 0) {
    throw badRequest("No sources matched. Select at least one document, collection or query.");
  }

  const sources = collectSources(docs);
  const lang: StudioLang = input.lang === "vi" ? "vi" : "en";
  const maxSlides = Math.min(Math.max(Number(input.maxSlides ?? 10), 4), 20);
  const title = commonTitle(sources, input.kind, input.title);
  const citations = sources.map((source) => source.citation);

  let markdown = "";
  let slides: ArtifactSlide[] = [];
  let mindmap: MindMapNode | null = null;
  let usedLlm = false;

  if (input.kind === "lesson") {
    const deterministic = buildLesson(sources, title, lang).markdown;
    markdown = deterministic;
    if (input.useLlm !== false) {
      const synthesized = await modelLesson(sources, title, lang);
      if (synthesized) {
        markdown = synthesized.startsWith("#") ? synthesized : `# ${title}\n\n${synthesized}`;
        usedLlm = true;
      }
    }
  } else if (input.kind === "slides") {
    slides = buildSlides(sources, title, lang, maxSlides);
    if (input.useLlm !== false) {
      const synthesized = await modelSlides(sources, title, lang);
      if (synthesized) {
        slides = synthesized;
        usedLlm = true;
      }
    }
    markdown = slidesMarkdown(slides, title);
  } else {
    mindmap = buildMindMap(sources, title, lang);
    if (input.useLlm !== false) {
      const synthesized = await modelMindMap(sources, title, lang);
      if (synthesized && synthesized.children.length > 0 && mindMapCoversSources(synthesized, sources.length)) {
        mindmap = synthesized;
        usedLlm = true;
      }
    }
    markdown = mindmapMarkdown(mindmap);
  }

  return createArtifact({
    kind: input.kind,
    title,
    documentIds: sources.map((source) => source.doc.id),
    params: {
      lang,
      maxSlides,
      query: input.query ?? null,
      collectionId: input.collectionId ?? null,
      sources: sources.length,
    },
    markdown,
    slides,
    mindmap,
    citations,
    usedLlm,
  });
}
