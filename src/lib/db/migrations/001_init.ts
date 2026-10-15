/**
 * Core schema. `chunks_fts` mirrors `chunks` by rowid and stores the
 * accent-folded text, which is what makes Vietnamese search work with or
 * without diacritics typed.
 */
export const INIT_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS documents (
     id TEXT PRIMARY KEY,
     source_kind TEXT NOT NULL,
     source_id TEXT NOT NULL,
     connector_id TEXT,
     external_id TEXT,
     title TEXT NOT NULL DEFAULT '',
     url TEXT,
     path TEXT,
     mime TEXT,
     author TEXT,
     lang TEXT,
     created_at TEXT,
     updated_at TEXT,
     ingested_at TEXT NOT NULL,
     content_hash TEXT NOT NULL,
     char_count INTEGER NOT NULL DEFAULT 0,
     token_count INTEGER NOT NULL DEFAULT 0,
     chunk_count INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'indexed',
     pinned INTEGER NOT NULL DEFAULT 0,
     meta TEXT NOT NULL DEFAULT '{}',
     deleted_at TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS documents_origin
     ON documents(source_id, external_id) WHERE external_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS documents_ingested ON documents(ingested_at DESC)`,
  `CREATE INDEX IF NOT EXISTS documents_created ON documents(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS documents_source ON documents(source_id, source_kind)`,
  `CREATE INDEX IF NOT EXISTS documents_hash ON documents(content_hash)`,
  `CREATE INDEX IF NOT EXISTS documents_connector ON documents(connector_id)`,

  `CREATE TABLE IF NOT EXISTS chunks (
     id TEXT PRIMARY KEY,
     document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     ord INTEGER NOT NULL,
     text TEXT NOT NULL,
     text_fold TEXT NOT NULL,
     heading_path TEXT,
     heading_fold TEXT,
     char_start INTEGER NOT NULL DEFAULT 0,
     char_end INTEGER NOT NULL DEFAULT 0,
     token_estimate INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id, ord)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
     text_fold,
     heading_fold,
     tokenize = 'unicode61 remove_diacritics 2'
   )`,

  `CREATE TABLE IF NOT EXISTS embeddings (
     chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
     model TEXT NOT NULL,
     dim INTEGER NOT NULL,
     vec BLOB NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (chunk_id, model)
   )`,
  `CREATE INDEX IF NOT EXISTS embeddings_model ON embeddings(model)`,

  `CREATE TABLE IF NOT EXISTS note_bodies (
     document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
     markdown TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS tags (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     slug TEXT NOT NULL UNIQUE,
     color TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS document_tags (
     document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
     source TEXT NOT NULL DEFAULT 'manual',
     PRIMARY KEY (document_id, tag_id)
   )`,
  `CREATE INDEX IF NOT EXISTS document_tags_tag ON document_tags(tag_id)`,

  `CREATE TABLE IF NOT EXISTS doc_links (
     from_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     to_slug TEXT NOT NULL,
     to_document_id TEXT,
     created_at TEXT NOT NULL,
     PRIMARY KEY (from_document_id, to_slug)
   )`,
  `CREATE INDEX IF NOT EXISTS doc_links_target ON doc_links(to_document_id)`,
  `CREATE INDEX IF NOT EXISTS doc_links_slug ON doc_links(to_slug)`,

  `CREATE TABLE IF NOT EXISTS collections (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     rules TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS entities (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     name TEXT NOT NULL,
     name_fold TEXT NOT NULL,
     aliases TEXT NOT NULL DEFAULT '[]',
     mentions INTEGER NOT NULL DEFAULT 0,
     last_seen_at TEXT,
     meta TEXT NOT NULL DEFAULT '{}'
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS entities_identity ON entities(type, name_fold)`,
  `CREATE TABLE IF NOT EXISTS entity_mentions (
     entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
     document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     weight REAL NOT NULL DEFAULT 1,
     PRIMARY KEY (entity_id, document_id)
   )`,
  `CREATE INDEX IF NOT EXISTS entity_mentions_document ON entity_mentions(document_id)`,
  `CREATE TABLE IF NOT EXISTS entity_edges (
     from_entity_id TEXT NOT NULL,
     to_entity_id TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'cooccurrence',
     weight REAL NOT NULL DEFAULT 1,
     PRIMARY KEY (from_entity_id, to_entity_id, kind)
   )`,

  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL DEFAULT 'New conversation',
     scope TEXT NOT NULL DEFAULT '{}',
     model TEXT,
     pinned INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     content TEXT NOT NULL,
     citations TEXT NOT NULL DEFAULT '[]',
     model TEXT,
     usage TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS connectors (
     id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     name TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'disconnected',
     auth_kind TEXT NOT NULL DEFAULT 'oauth2',
     account_label TEXT,
     config TEXT NOT NULL DEFAULT '{}',
     cursor TEXT NOT NULL DEFAULT '{}',
     secrets TEXT,
     scopes TEXT NOT NULL DEFAULT '[]',
     auto_sync INTEGER NOT NULL DEFAULT 1,
     items_synced INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     last_sync_at TEXT,
     last_status TEXT,
     last_error TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS connectors_provider ON connectors(provider)`,

  `CREATE TABLE IF NOT EXISTS sync_runs (
     id TEXT PRIMARY KEY,
     connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     status TEXT NOT NULL DEFAULT 'running',
     added INTEGER NOT NULL DEFAULT 0,
     updated INTEGER NOT NULL DEFAULT 0,
     skipped INTEGER NOT NULL DEFAULT 0,
     failed INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     detail TEXT NOT NULL DEFAULT '{}'
   )`,
  `CREATE INDEX IF NOT EXISTS sync_runs_connector ON sync_runs(connector_id, started_at DESC)`,

  `CREATE TABLE IF NOT EXISTS oauth_states (
     state TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     connector_id TEXT,
     verifier TEXT NOT NULL,
     redirect_uri TEXT NOT NULL,
     payload TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS jobs (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL DEFAULT '{}',
     status TEXT NOT NULL DEFAULT 'queued',
     priority INTEGER NOT NULL DEFAULT 0,
     attempts INTEGER NOT NULL DEFAULT 0,
     max_attempts INTEGER NOT NULL DEFAULT 3,
     scheduled_at TEXT NOT NULL,
     started_at TEXT,
     finished_at TEXT,
     error TEXT,
     result TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, scheduled_at)`,

  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY,
     at TEXT NOT NULL,
     kind TEXT NOT NULL,
     document_id TEXT,
     connector_id TEXT,
     title TEXT NOT NULL DEFAULT '',
     detail TEXT NOT NULL DEFAULT '{}'
   )`,
  `CREATE INDEX IF NOT EXISTS events_at ON events(at DESC)`,
  `CREATE INDEX IF NOT EXISTS events_kind ON events(kind, at DESC)`,

  `CREATE TABLE IF NOT EXISTS plays (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     enabled INTEGER NOT NULL DEFAULT 1,
     schedule TEXT,
     params TEXT NOT NULL DEFAULT '{}',
     uses_llm INTEGER NOT NULL DEFAULT 0,
     last_run_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS play_runs (
     id TEXT PRIMARY KEY,
     play_id TEXT NOT NULL,
     play_name TEXT NOT NULL,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     status TEXT NOT NULL DEFAULT 'running',
     params TEXT NOT NULL DEFAULT '{}',
     output TEXT NOT NULL DEFAULT '',
     citations TEXT NOT NULL DEFAULT '[]',
     used_llm INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     usage TEXT NOT NULL DEFAULT '{}'
   )`,
  `CREATE INDEX IF NOT EXISTS play_runs_play ON play_runs(play_id, started_at DESC)`,

  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS api_tokens (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     prefix TEXT NOT NULL,
     scopes TEXT NOT NULL DEFAULT '["read","write"]',
     created_at TEXT NOT NULL,
     last_used_at TEXT,
     revoked_at TEXT
   )`,
];
