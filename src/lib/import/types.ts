/**
 * FROZEN CONTRACT — bulk importers.
 *
 * An importer reads a single archive/export file (mbox, Slack export ZIP,
 * Notion export ZIP, ICS calendar, .eml) and yields many items that the ingest
 * pipeline turns into documents. Importers stream: the caller must handle
 * thousands of items without loading everything at once.
 */

export type ImportedItem = {
  /** Stable identity inside the archive (message id, page path, event uid). */
  externalId: string;
  title: string;
  text: string;
  url?: string | null;
  author?: string | null;
  /** ISO timestamps when the source knows them. */
  createdAt?: string | null;
  updatedAt?: string | null;
  mime?: string | null;
  /** Logical path inside the archive, used for grouping in the UI. */
  path?: string | null;
  /** Source-specific extras (labels, channel, attendees, threadId…). */
  meta?: Record<string, unknown>;
};

export type ImporterInput = {
  bytes: Uint8Array;
  filename: string;
  /** Optional progress callback for long archives. */
  onProgress?: (message: string, extra?: Record<string, unknown>) => void;
  /** Hard cap on yielded items; importers must stop cleanly at the cap. */
  limit?: number;
};

export type Importer = {
  /** Stable id, e.g. `mbox`, `slack_zip`, `notion_zip`, `ics`, `eml`. */
  id: string;
  label: string;
  /** Lower-case extensions including the dot. */
  extensions: string[];
  /** Human-readable description shown in the Import screen. */
  description: string;
  /** Yield items lazily; must be safe for archives with thousands of entries. */
  parse(input: ImporterInput): AsyncGenerator<ImportedItem, void, unknown>;
};

/** Minimal RFC 5322 / MIME message shape produced by `parseRfc822`. */
export type ParsedMessage = {
  headers: Record<string, string>;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  date: string | null;
  messageId: string | null;
  /** Best-effort: text/plain part, or HTML converted to text. */
  text: string;
  html: string | null;
  attachments: { filename: string; mime: string; bytes: Uint8Array }[];
};
