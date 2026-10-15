/**
 * The chunk index now carries the document title.
 *
 * Titles lived only on `documents`, so a word that appeared only in a title —
 * "Pricing decision", say — could not be found by search. Rebuilding the index
 * with a `title_fold` column fixes that.
 *
 * The fold has to run in JavaScript (`foldForIndex`, the same normalisation the
 * writers use, which also maps `đ` → `d`), so the backfill is an `up()` step of
 * the migration rather than plain SQL.
 */

import type { DatabaseSync } from "node:sqlite";

import { foldForIndex } from "../../core/text";
import { all, run } from "../sql";

export const CHUNK_TITLE_INDEX_SQL: string[] = [
  `DROP TABLE IF EXISTS chunks_fts`,
  `CREATE VIRTUAL TABLE chunks_fts USING fts5(
     text_fold,
     heading_fold,
     title_fold,
     tokenize = 'unicode61 remove_diacritics 2'
   )`,
];

export const TRIGRAM_TITLE_INDEX_SQL: string[] = [
  `DROP TABLE IF EXISTS chunks_trigram`,
  `CREATE VIRTUAL TABLE chunks_trigram USING fts5(
     text_fold,
     title_fold,
     tokenize = 'trigram'
   )`,
];

/** Folded title of every document, so the backfill folds each title once. */
function foldedTitles(database: DatabaseSync): { id: string; titleFold: string }[] {
  return all<{ id: string; title: string | null }>(database, "SELECT id, title FROM documents").map((row) => ({
    id: String(row.id),
    titleFold: foldForIndex(row.title ?? ""),
  }));
}

/** Repopulates the rebuilt text index; runs inside the migration transaction. */
export function backfillChunkTitleIndex(database: DatabaseSync): void {
  run(
    database,
    `INSERT INTO chunks_fts (rowid, text_fold, heading_fold, title_fold)
     SELECT rowid, text_fold, COALESCE(heading_fold, ''), '' FROM chunks`,
  );
  for (const { id, titleFold } of foldedTitles(database)) {
    run(
      database,
      `UPDATE chunks_fts SET title_fold = ? WHERE rowid IN (SELECT rowid FROM chunks WHERE document_id = ?)`,
      [titleFold, id],
    );
  }
}

/** Same treatment for the optional trigram index (SQLite >= 3.34). */
export function backfillTrigramTitleIndex(database: DatabaseSync): void {
  run(
    database,
    `INSERT INTO chunks_trigram (rowid, text_fold, title_fold)
     SELECT rowid, text_fold, '' FROM chunks`,
  );
  for (const { id, titleFold } of foldedTitles(database)) {
    run(
      database,
      `UPDATE chunks_trigram SET title_fold = ? WHERE rowid IN (SELECT rowid FROM chunks WHERE document_id = ?)`,
      [titleFold, id],
    );
  }
}
