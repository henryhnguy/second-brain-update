/**
 * Plain-text extractor: markdown, notes, logs, CSV / JSON / YAML and the other
 * line-oriented formats listed in `TEXT_EXTENSIONS`.
 *
 * Decoding is best effort and never throws: utf-8 first (BOM aware), and when
 * the utf-8 pass produces replacement characters for more than 2% of the text
 * the bytes are re-decoded as latin1 instead.
 */

import type { ExtractedDoc, ExtractInput, Extractor } from "./types";

const BOM = "\uFEFF";
const REPLACEMENT = "\uFFFD";
/** Above this share of U+FFFD we assume the file is not utf-8 at all. */
const REPLACEMENT_RATIO = 0.02;

export type DecodedText = {
  text: string;
  /** `latin1` when the utf-8 pass was rejected as garbled. */
  encoding: "utf-8" | "latin1";
  replacements: number;
};

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);

/** Lower-case extension of a file name, including the dot (`""` when none). */
export function extensionOf(filename: string): string {
  const base = filename.trim().split(/[?#]/)[0] ?? "";
  const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  const name = slash === -1 ? base : base.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot).toLowerCase();
}

export function isMarkdown(filename: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(filename));
}

function countReplacements(input: string): number {
  let count = 0;
  for (const char of input) {
    if (char === REPLACEMENT) count += 1;
  }
  return count;
}

function stripBom(input: string): string {
  return input.startsWith(BOM) ? input.slice(1) : input;
}

/** Decodes bytes as utf-8, falling back to latin1 when utf-8 looks garbled. */
export function decodeTextBytes(bytes: Uint8Array): DecodedText {
  const utf8 = stripBom(new TextDecoder("utf-8").decode(bytes));
  const replacements = countReplacements(utf8);
  if (utf8.length === 0 || replacements / utf8.length <= REPLACEMENT_RATIO) {
    return { text: utf8, encoding: "utf-8", replacements };
  }
  const latin1 = stripBom(new TextDecoder("latin1").decode(bytes));
  const latin1Replacements = countReplacements(latin1);
  if (latin1Replacements < replacements) {
    return { text: latin1, encoding: "latin1", replacements: latin1Replacements };
  }
  return { text: utf8, encoding: "utf-8", replacements };
}

const ATX_H1 = /^ {0,3}#\s+(.+?)\s*#*\s*$/;

/** First markdown `# heading` in the text. */
export function firstHeading(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = ATX_H1.exec(line);
    const value = match?.[1]?.trim() ?? "";
    if (value.length > 0) return value;
  }
  return null;
}

/** First line that is not blank. */
export function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const value = line.trim();
    if (value.length > 0) return value;
  }
  return null;
}

/**
 * Title for a text note: the first markdown H1 when the file is markdown,
 * otherwise the first non-empty line.
 */
export function plainTextTitle(text: string, markdown = false): string | null {
  if (markdown) {
    const heading = firstHeading(text);
    if (heading) return heading;
  }
  return firstNonEmptyLine(text);
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

/**
 * Text extraction shared by the `text` extractor and by the registry fallback
 * used for unknown formats.
 */
export function extractPlainText(bytes: Uint8Array, markdown = false): ExtractedDoc {
  const decoded = decodeTextBytes(bytes);
  const warnings: string[] = [];
  if (decoded.encoding === "latin1") {
    warnings.push("input is not valid utf-8: decoded as latin1");
  }
  return {
    text: decoded.text,
    title: plainTextTitle(decoded.text, markdown),
    meta: { lines: countLines(decoded.text), bytes: bytes.byteLength },
    warnings,
  };
}

export const textExtractor: Extractor = {
  id: "text",
  label: "Plain text notes",
  extensions: [
    ".md",
    ".markdown",
    ".mdx",
    ".txt",
    ".text",
    ".log",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".srt",
    ".rst",
    ".org",
  ],
  mimes: [
    "text/plain",
    "text/markdown",
    "text/x-markdown",
    "text/csv",
    "text/tab-separated-values",
    "application/json",
    "application/x-ndjson",
    "application/yaml",
    "text/yaml",
    "application/x-yaml",
    "application/x-subrip",
    "text/x-rst",
  ],
  async extract(input: ExtractInput): Promise<ExtractedDoc> {
    return extractPlainText(input.bytes, isMarkdown(input.filename));
  },
};
