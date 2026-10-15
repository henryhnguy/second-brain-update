import type { Migration } from "../migrate";
import { INIT_SQL } from "./001_init";

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
];
