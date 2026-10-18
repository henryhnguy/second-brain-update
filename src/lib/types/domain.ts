/**
 * Domain types shared by the storage layer, the API, the CLI and the UI.
 * These are plain data shapes — no classes, no ORM.
 */

export type SourceKind =
  | "note"
  | "upload"
  | "paste"
  | "url"
  | "folder"
  | "importer"
  | "connector";

export const SOURCE_KINDS: SourceKind[] = [
  "note",
  "upload",
  "paste",
  "url",
  "folder",
  "importer",
  "connector",
];

export type DocumentStatus = "pending" | "indexed" | "failed" | "deleted";

export type Doc = {
  id: string;
  sourceKind: SourceKind;
  /** Fine-grained origin, e.g. `gmail`, `slack`, `obsidian`, `pdf`, `manual`. */
  sourceId: string;
  connectorId: string | null;
  externalId: string | null;
  title: string;
  url: string | null;
  path: string | null;
  mime: string | null;
  author: string | null;
  lang: string | null;
  /** When the content was authored at the source (ISO), if known. */
  createdAt: string | null;
  updatedAt: string | null;
  ingestedAt: string;
  contentHash: string;
  charCount: number;
  tokenCount: number;
  chunkCount: number;
  status: DocumentStatus;
  pinned: boolean;
  meta: Record<string, unknown>;
  deletedAt: string | null;
};

export type Chunk = {
  id: string;
  documentId: string;
  ord: number;
  text: string;
  headingPath: string | null;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
};

export type NoteTag = {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  count?: number;
};

export type Note = {
  document: Doc;
  markdown: string;
  tags: NoteTag[];
  links: string[];
  backlinks: { documentId: string; title: string }[];
};

export type Collection = {
  id: string;
  name: string;
  description: string;
  rules: CollectionRules;
  createdAt: string;
  updatedAt: string;
  count?: number;
};

export type CollectionRules = {
  sourceKind?: SourceKind[];
  sourceId?: string[];
  tags?: string[];
  since?: string | null;
  until?: string | null;
  query?: string | null;
  /** Explicitly pinned documents, always included. */
  documentIds?: string[];
};

export type EmbeddingRecord = {
  chunkId: string;
  model: string;
  dim: number;
  vec: Float32Array;
};

export type ScoreSignals = {
  bm25?: number;
  cosine?: number;
  trigram?: number;
  recency?: number;
  pin?: number;
  sourceWeight?: number;
};

export type SearchHit = {
  documentId: string;
  chunkId: string | null;
  title: string;
  sourceKind: SourceKind;
  sourceId: string;
  url: string | null;
  path: string | null;
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  ingestedAt: string;
  score: number;
  signals: ScoreSignals;
  snippet: string;
  headingPath: string | null;
};

export type SearchMode = "hybrid" | "keyword" | "semantic";

export type SearchFilters = {
  sources?: SourceKind[];
  sourceIds?: string[];
  tags?: string[];
  connectorId?: string | null;
  since?: string | null;
  until?: string | null;
  documentIds?: string[];
  pinnedOnly?: boolean;
};

export type SearchRequest = {
  query: string;
  mode?: SearchMode;
  limit?: number;
  offset?: number;
  filters?: SearchFilters;
  /** Include per-chunk passages (default true). */
  passages?: boolean;
};

export type SearchResponse = {
  query: string;
  mode: SearchMode;
  semanticAvailable: boolean;
  tookMs: number;
  /** Distinct documents matched inside the retrieval window (not a global count). */
  total: number;
  hits: SearchHit[];
  facets: {
    sourceKind: Record<string, number>;
    sourceId: Record<string, number>;
    tags: Record<string, number>;
  };
};

export type Citation = {
  index: number;
  documentId: string;
  chunkId: string | null;
  /** Section the passage came from, e.g. `Setup › Install`. */
  headingPath: string | null;
  title: string;
  sourceKind: SourceKind;
  sourceId: string;
  url: string | null;
  path: string | null;
  createdAt: string | null;
  snippet: string;
  score: number;
};

export type ChatRole = "system" | "user" | "assistant";

export type Message = {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  citations: Citation[];
  model: string | null;
  usage: Record<string, unknown>;
  createdAt: string;
};

export type Conversation = {
  id: string;
  title: string;
  scope: ChatScope;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  messageCount?: number;
};

export type ChatScope = {
  mode: "all" | "notes" | "documents" | "collection";
  documentIds?: string[];
  collectionId?: string | null;
  since?: string | null;
};

export type ChatRequest = {
  message: string;
  conversationId?: string | null;
  scope?: ChatScope;
  useMemory?: boolean;
  temperature?: number;
};

export type ChatAnswer = {
  conversationId: string;
  messageId: string;
  content: string;
  citations: Citation[];
  model: string | null;
  usage: Record<string, unknown>;
  usedLlm: boolean;
};

export type ConnectorStatus = "disconnected" | "pending" | "connected" | "error";

export type Connector = {
  id: string;
  provider: string;
  name: string;
  status: ConnectorStatus;
  authKind: "oauth2" | "token";
  accountLabel: string | null;
  config: Record<string, unknown>;
  cursor: Record<string, unknown>;
  scopes: string[];
  /** Whether a credential is stored for this connector (the value itself is never exposed). */
  hasCredentials: boolean;
  autoSync: boolean;
  createdAt: string;
  updatedAt: string;
  lastSyncAt: string | null;
  lastError: string | null;
  lastStatus: string | null;
  itemsSynced: number;
};

export type SyncRun = {
  id: string;
  connectorId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "error" | "partial";
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  error: string | null;
  detail: Record<string, unknown>;
};

export type JobKind =
  | "ingest.file"
  | "ingest.url"
  | "ingest.folder"
  | "ingest.importer"
  | "embed.backfill"
  | "connector.sync"
  | "play.run"
  | "maintenance.reindex";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type Job = {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result: Record<string, unknown>;
  createdAt: string;
};

export type ActivityEvent = {
  id: string;
  at: string;
  kind: string;
  documentId: string | null;
  connectorId: string | null;
  title: string;
  detail: Record<string, unknown>;
};

export type EntityType =
  | "person"
  | "org"
  | "project"
  | "topic"
  | "place"
  | "email"
  | "url"
  | "tag"
  | "date";

export type Entity = {
  id: string;
  type: EntityType;
  name: string;
  aliases: string[];
  mentions: number;
  lastSeenAt: string | null;
  meta: Record<string, unknown>;
  coOccurring?: { entityId: string; name: string; type: EntityType; weight: number }[];
};

export type PlayKind =
  | "weekly_digest"
  | "daily_brief"
  | "meeting_brief"
  | "open_loops"
  | "find_file"
  | "topic_dossier"
  | "brain_review"
  | "custom";

export type Play = {
  id: string;
  name: string;
  kind: PlayKind;
  description: string;
  enabled: boolean;
  schedule: string | null;
  params: Record<string, unknown>;
  usesLlm: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlayRun = {
  id: string;
  playId: string;
  playName: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "error";
  params: Record<string, unknown>;
  output: string;
  citations: Citation[];
  usedLlm: boolean;
  error: string | null;
  usage: Record<string, unknown>;
};

export type IngestResult = {
  documentId: string;
  status: "created" | "updated" | "skipped" | "failed";
  chunks: number;
  title: string;
  error?: string;
};

export type StatsSnapshot = {
  documents: number;
  chunks: number;
  notes: number;
  embeddings: number;
  connectors: number;
  conversations: number;
  bySource: { sourceId: string; sourceKind: SourceKind; count: number }[];
  lastIngestAt: string | null;
  databaseBytes: number;
  aiConfigured: boolean;
  embeddingCoverage: number;
};
