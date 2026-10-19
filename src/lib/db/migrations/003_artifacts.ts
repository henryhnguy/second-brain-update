/**
 * Studio artifacts — lessons and slide decks generated from a set of sources.
 *
 * The row keeps both representations: `markdown` for lessons (and for a
 * copy/paste deck), `slides` as JSON for the presenter. Sources are stored by
 * id so an artifact can be regenerated after a document changes.
 */
export const ARTIFACTS_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS artifacts (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     document_ids TEXT NOT NULL DEFAULT '[]',
     params TEXT NOT NULL DEFAULT '{}',
     markdown TEXT NOT NULL DEFAULT '',
     slides TEXT NOT NULL DEFAULT '[]',
     citations TEXT NOT NULL DEFAULT '[]',
     used_llm INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS artifacts_created ON artifacts(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS artifacts_kind ON artifacts(kind, created_at DESC)`,
];
