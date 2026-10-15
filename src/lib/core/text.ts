/**
 * Text normalisation helpers shared by ingest, retrieval and the UI.
 *
 * Vietnamese notes: `đ/Đ` has no Unicode decomposition, so it is folded
 * explicitly; everything else goes through NFD stripping. Both sides of the
 * search (index and query) are folded so users can type without accents.
 */

const DIACRITIC_MARKS = /[\u0300-\u036f]/g;

export function foldDiacritics(input: string): string {
  return input.normalize("NFD").replace(DIACRITIC_MARKS, "").replace(/[đĐ]/g, (m) => (m === "đ" ? "d" : "D"));
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\r\n?/g, "\n").replace(/[\t\f\v ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Lower-cased, accent-free, punctuation-free form stored in the FTS index. */
export function foldForIndex(input: string): string {
  return foldDiacritics(input).toLowerCase();
}

const TOKEN_SPLIT = /[^\p{L}\p{N}_]+/u;

export function tokenize(input: string): string[] {
  return foldForIndex(input)
    .split(TOKEN_SPLIT)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "boi",
  "cac",
  "cai",
  "cho",
  "co",
  "cua",
  "do",
  "duoc",
  "for",
  "from",
  "gi",
  "has",
  "have",
  "in",
  "is",
  "it",
  "khi",
  "la",
  "lam",
  "mot",
  "nao",
  "nhu",
  "nhung",
  "of",
  "on",
  "or",
  "that",
  "the",
  "thi",
  "this",
  "to",
  "trong",
  "va",
  "voi",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "will",
  "with",
]);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/** Escapes a term for safe inclusion inside an FTS5 string literal. */
function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

export type FtsQueryOptions = {
  /** Append `*` to the final token so search-as-you-type works. */
  prefixLast?: boolean;
  maxTerms?: number;
};

/** Builds an FTS5 MATCH expression from free text; never throws on odd input. */
export function buildFtsQuery(query: string, options: FtsQueryOptions = {}): string {
  const maxTerms = options.maxTerms ?? 24;
  const terms = tokenize(query).slice(0, maxTerms);
  if (terms.length === 0) return "";
  const parts = terms.map((term, index) => {
    const isLast = index === terms.length - 1;
    if (options.prefixLast && isLast && term.length >= 3) return `${quoteFtsTerm(term)}*`;
    return quoteFtsTerm(term);
  });
  return parts.join(" AND ");
}

/** Looser OR query, used as a recall fallback when AND finds nothing. */
export function buildFtsQueryOr(query: string, maxTerms = 12): string {
  const terms = tokenize(query).slice(0, maxTerms);
  if (terms.length === 0) return "";
  return terms.map(quoteFtsTerm).join(" OR ");
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3.6));
}

export function slugify(input: string, maxLength = 60): string {
  const slug = foldForIndex(input)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return slug || "item";
}

export function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export type HighlightSegment = { text: string; hit: boolean };

/**
 * Splits `text` into segments marking term hits (accent-insensitive).
 * Used for search snippets in the API and the UI.
 */
export function highlightSegments(text: string, terms: string[]): HighlightSegment[] {
  const needles = Array.from(
    new Set(
      terms
        .map((term) => foldForIndex(term).trim())
        .filter((term) => term.length > 1),
    ),
  );
  if (needles.length === 0 || !text) return [{ text, hit: false }];

  const folded = foldForIndex(text);
  const ranges: Array<[number, number]> = [];
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(needle, from);
      if (at === -1) break;
      ranges.push([at, at + needle.length]);
      from = at + needle.length;
      if (ranges.length > 400) break;
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false });
    segments.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}

/** Builds a window of text around the first hit, for compact search results. */
export function snippetAround(text: string, terms: string[], radius = 220): string {
  const compact = normalizeWhitespace(text);
  const folded = foldForIndex(compact);
  let firstHit = -1;
  for (const term of terms) {
    const needle = foldForIndex(term).trim();
    if (needle.length < 2) continue;
    const at = folded.indexOf(needle);
    if (at !== -1 && (firstHit === -1 || at < firstHit)) firstHit = at;
  }
  if (firstHit === -1) return truncate(compact, radius * 2);
  const start = Math.max(0, firstHit - Math.floor(radius / 2));
  const end = Math.min(compact.length, start + radius * 2);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < compact.length ? "…" : "";
  return `${prefix}${compact.slice(start, end).trim()}${suffix}`;
}

/** Extracts `[[wiki links]]`, `#tags` and URLs from note bodies. */
export function extractWikiLinks(markdown: string): string[] {
  const links = new Set<string>();
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const target = match[1]?.trim();
    if (target) links.add(target);
  }
  return Array.from(links);
}

export function extractInlineTags(markdown: string): string[] {
  const tags = new Set<string>();
  const pattern = /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_/-]{0,48})/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const tag = match[2]?.trim();
    if (tag) tags.add(tag);
  }
  return Array.from(tags);
}

export function extractUrls(text: string): string[] {
  const urls = new Set<string>();
  const pattern = /https?:\/\/[^\s<>"')\]]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0]) urls.add(match[0]);
  }
  return Array.from(urls);
}
