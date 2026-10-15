/**
 * FROZEN CONTRACT — extraction layer.
 *
 * A "extractor" turns raw bytes of one file into plain text plus metadata.
 * Implementations must never throw for unsupported content: return an
 * `ExtractedDoc` with a warning instead, and let the caller decide.
 */

export type ExtractInput = {
  bytes: Uint8Array;
  /** Original file name, including extension. */
  filename: string;
  mime?: string | null;
};

export type ExtractedDoc = {
  /** Plain text; may be empty when extraction genuinely yields nothing. */
  text: string;
  /** Best-effort title (document title, first heading, subject…). */
  title: string | null;
  /** Format-specific extras: page count, author, html, sheet names… */
  meta: Record<string, unknown>;
  /** Non-fatal problems (e.g. "scanned pdf: no text layer"). */
  warnings: string[];
};

export type Extractor = {
  /** Stable id, e.g. `markdown`, `pdf`, `docx`, `html`, `csv`, `text`. */
  id: string;
  label: string;
  /** Lower-case extensions including the dot, e.g. `[".md", ".markdown"]`. */
  extensions: string[];
  /** Lower-case MIME types this extractor accepts. */
  mimes: string[];
  /** `true` when the extractor needs an external library (lazy-loaded). */
  heavy?: boolean;
  extract(input: ExtractInput): Promise<ExtractedDoc>;
};

/** Normalised text result the ingest pipeline consumes. */
export type NormalizedText = {
  text: string;
  title: string | null;
  mime: string | null;
  warnings: string[];
  meta: Record<string, unknown>;
  /** Extractor id that produced the text, or `fallback`. */
  via: string;
};

export const TEXT_EXTENSIONS: string[] = [
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
  ".html",
  ".htm",
  ".xml",
  ".eml",
  ".ics",
  ".srt",
  ".vtt",
  ".rst",
  ".org",
];
