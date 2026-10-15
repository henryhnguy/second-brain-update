/**
 * Extractor registry — the public entry point of the extraction layer.
 *
 * Lookup is extension first, then MIME. `extractFile` never throws: an unknown
 * format (or a failing extractor) falls back to plain-text decoding so the
 * ingest pipeline always gets a `NormalizedText` to store.
 */

import { extractPlainText, extensionOf, isMarkdown } from "./text";
import type { ExtractInput, Extractor, NormalizedText } from "./types";

const extractors: Extractor[] = [];

/** MIME type guessed from the file extension when the caller does not know it. */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".mdx": "text/markdown",
  ".txt": "text/plain",
  ".text": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html",
  ".htm": "text/html",
  ".xhtml": "application/xhtml+xml",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".eml": "message/rfc822",
  ".ics": "text/calendar",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
  ".rst": "text/x-rst",
  ".org": "text/plain",
};

function normalizeMime(mime: string | null | undefined): string | null {
  if (typeof mime !== "string") return null;
  const value = (mime.split(";")[0] ?? "").trim().toLowerCase();
  return value.length > 0 ? value : null;
}

function mimeForFilename(filename: string): string | null {
  return MIME_BY_EXTENSION[extensionOf(filename)] ?? null;
}

/** Registers an extractor; re-registering the same id replaces it. */
export function registerExtractor(extractor: Extractor): void {
  const index = extractors.findIndex((candidate) => candidate.id === extractor.id);
  if (index >= 0) extractors[index] = extractor;
  else extractors.push(extractor);
}

/** Snapshot of the registered extractors, in registration order. */
export function listExtractors(): Extractor[] {
  return [...extractors];
}

/** Extractor for a file name, matching extension first and MIME type second. */
export function getExtractorFor(filename: string, mime?: string | null): Extractor | null {
  const extension = extensionOf(filename);
  if (extension.length > 0) {
    const byExtension = extractors.find((candidate) => candidate.extensions.includes(extension));
    if (byExtension) return byExtension;
  }
  const normalizedMime = normalizeMime(mime);
  if (normalizedMime) {
    const byMime = extractors.find((candidate) =>
      candidate.mimes.some((candidateMime) => normalizeMime(candidateMime) === normalizedMime),
    );
    if (byMime) return byMime;
  }
  return null;
}

function describeFormat(filename: string, mime: string | null): string {
  const extension = extensionOf(filename);
  const label = extension.length > 0 ? extension : filename;
  return mime ? `${label} (${mime})` : label;
}

/**
 * Runs the best extractor for `input` and normalises the result. Unsupported
 * formats and extractor failures produce a plain-text fallback plus a warning
 * instead of an exception.
 */
export async function extractFile(input: ExtractInput): Promise<NormalizedText> {
  const mime = normalizeMime(input.mime) ?? mimeForFilename(input.filename);
  const extractor = getExtractorFor(input.filename, input.mime);
  if (!extractor) {
    const fallback = extractPlainText(input.bytes, isMarkdown(input.filename));
    return {
      text: fallback.text,
      title: fallback.title,
      mime,
      warnings: [
        ...fallback.warnings,
        `no extractor for ${describeFormat(input.filename, mime)}: fell back to plain text`,
      ],
      meta: fallback.meta,
      via: "fallback",
    };
  }
  try {
    const doc = await extractor.extract({ bytes: input.bytes, filename: input.filename, mime });
    return {
      text: doc.text,
      title: doc.title,
      mime,
      warnings: [...doc.warnings],
      meta: doc.meta,
      via: extractor.id,
    };
  } catch (error) {
    const fallback = extractPlainText(input.bytes, isMarkdown(input.filename));
    const reason = error instanceof Error ? error.message : String(error);
    return {
      text: fallback.text,
      title: fallback.title,
      mime,
      warnings: [
        ...fallback.warnings,
        `${extractor.id} extractor failed (${reason}): fell back to plain text`,
      ],
      meta: fallback.meta,
      via: "fallback",
    };
  }
}
