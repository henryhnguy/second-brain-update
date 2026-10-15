import type { Migration } from "../migrate";
import { INIT_SQL } from "./001_init";
import {
  CHUNK_TITLE_INDEX_SQL,
  TRIGRAM_TITLE_INDEX_SQL,
  backfillChunkTitleIndex,
  backfillTrigramTitleIndex,
} from "./002_chunk_title_index";

/**
 * Trigram index: enables substring/fuzzy matching for short queries and typos.
 * Skip-able because the tokenizer needs SQLite >= 3.34.
 */
const TRIGRAM_SQL: string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
     text_fold,
     tokenize = 'trigram'
   )`,
];

export const MIGRATIONS: Migration[] = [
  { id: 1, name: "init", statements: INIT_SQL },
  { id: 2, name: "trigram_index", statements: TRIGRAM_SQL, requires: "trigram" },
  // Titles become searchable: both indexes gain a folded-title column, and the
  // backfill folds every existing title with the writer's own normalisation.
  { id: 3, name: "chunk_title_index", statements: CHUNK_TITLE_INDEX_SQL, up: backfillChunkTitleIndex },
  {
    id: 4,
    name: "trigram_title_index",
    statements: TRIGRAM_TITLE_INDEX_SQL,
    requires: "trigram",
    up: backfillTrigramTitleIndex,
  },
];
