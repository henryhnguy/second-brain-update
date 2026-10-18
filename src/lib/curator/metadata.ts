import { getDb } from "../db/connection";
import { all, str } from "../db/sql";
import { truncate } from "../core/text";
import { getDocument, setDocumentMeta } from "../db/repo/documents";
import type { Doc } from "../types/domain";

/**
 * Metadata inference for the reference corpus.
 *
 * Engineering documents already carry their identity in the file name —
 * `MO - FTW.06 … _V3_03.18.2026.pdf`, `QMS-FTW-02 …_31.08.2023_V03.pdf` — but
 * that identity is not stored anywhere. This module recovers code, version and
 * effective date from the title so the index, the one-pagers and the review can
 * use them without a manual pass over hundreds of files.
 */

export type InferredMetadata = {
  code?: string;
  version?: string;
  effectiveDate?: string;
};

const CODE_PATTERN = /\b(MO|QMS|PE|PCS)\s*(?:[-–—]\s*)?(FTW)?\s*[.\-–—]\s*(\d{1,2})\b/i;
const VERSION_PATTERN = /(?:^|[^A-Za-z0-9])V(?:er(?:sion)?)?\.?\s*(\d{1,2})(?!\d)/i;
const DATE_DMY = /(?:^|[^\d])(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(?!\d)/;
const DATE_YMD = /(?:^|[^\d])(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?!\d)/;

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** DD.MM.YYYY and MM.DD.YYYY both appear; a value above 12 disambiguates. */
function inferDate(title: string): string | null {
  const yearFirst = DATE_YMD.exec(title);
  if (yearFirst) {
    const iso = isoDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
    if (iso) return iso;
  }
  const match = DATE_DMY.exec(title);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);
  if (first > 12) return isoDate(year, second, first);
  if (second > 12) return isoDate(year, first, second);
  // Ambiguous: the corpus is mostly US-style, so keep MM.DD.
  return isoDate(year, first, second) ?? isoDate(year, second, first);
}

export function inferMetadata(title: string): InferredMetadata {
  const result: InferredMetadata = {};

  const code = CODE_PATTERN.exec(title);
  if (code) {
    const series = (code[1] ?? "").toUpperCase();
    const family = code[2] ? "-FTW" : "";
    const number = String(Number.parseInt(code[3] ?? "0", 10)).padStart(2, "0");
    result.code = `${series}${family}.${number}`;
  }

  const version = VERSION_PATTERN.exec(title);
  if (version) {
    const digits = version[1] ?? "";
    result.version = `V${digits.length === 1 ? `0${digits}` : digits}`;
  }

  const date = inferDate(title);
  if (date) result.effectiveDate = date;

  return result;
}

export type MetadataInferenceReport = {
  scanned: number;
  updated: number;
  skipped: number;
  samples: { documentId: string; title: string; inferred: InferredMetadata }[];
};

export type MetadataInferenceOptions = {
  dryRun?: boolean;
  /** Overwrite values that already exist (default false: only fill gaps). */
  overwrite?: boolean;
  limit?: number;
};

/**
 * Walks every live document, infers what it can from the title and merges the
 * result into `documents.meta`. Existing values win unless `overwrite` is set.
 */
export function applyInferredMetadata(options: MetadataInferenceOptions = {}): MetadataInferenceReport {
  const rows = all<Record<string, unknown>>(
    getDb(),
    "SELECT id, title FROM documents WHERE deleted_at IS NULL ORDER BY title",
  );
  const limit = Math.min(Math.max(options.limit ?? rows.length, 1), rows.length);
  const report: MetadataInferenceReport = { scanned: 0, updated: 0, skipped: 0, samples: [] };

  for (const row of rows.slice(0, limit)) {
    report.scanned += 1;
    const documentId = str(row.id);
    const title = str(row.title);
    const inferred = inferMetadata(title);
    if (Object.keys(inferred).length === 0) {
      report.skipped += 1;
      continue;
    }

    const doc = getDocument(documentId);
    if (!doc) {
      report.skipped += 1;
      continue;
    }
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inferred)) {
      const existing = doc.meta[key];
      if (options.overwrite || existing === undefined || existing === null || existing === "") {
        patch[key] = value;
      }
    }
    if (Object.keys(patch).length === 0) {
      report.skipped += 1;
      continue;
    }

    if (!options.dryRun) setDocumentMeta(documentId, patch);
    report.updated += 1;
    if (report.samples.length < 12) {
      report.samples.push({ documentId, title: truncate(title, 100), inferred });
    }
  }

  return report;
}

/** Reads back the metadata a document has, for CLI and UI display. */
export function documentMetadata(documentId: string): { document: Doc | null; meta: Record<string, unknown> } {
  const document = getDocument(documentId);
  return { document, meta: document?.meta ?? {} };
}
