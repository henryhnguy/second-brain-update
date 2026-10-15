# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-10-15

### Added

- **Anthropic chat support** — chat can be routed to the Anthropic Messages API with
  `SB_AI_CHAT_PROVIDER=anthropic`. The new `lib/ai/anthropic.ts` client handles the wire-format
  differences (system prompt as a top-level field, required `max_tokens`, content blocks, typed SSE
  events), and `lib/ai/chat-provider.ts` dispatches between it and the existing OpenAI-compatible
  client, so no caller has to know which provider is configured. Embeddings stay on the
  OpenAI-compatible path, because Anthropic publishes no embeddings endpoint.
- **Searchable document titles** — `chunks_fts` and `chunks_trigram` gained a folded-title column,
  so a document can be found by a word that appears only in its title. Migrations 3 and 4 rebuild
  both indexes and fold every stored title; the change is covered by a test that upgrades a
  database written with the old schema.

### Fixed

- **The development server answered every request with a 500.** Next compiles
  `instrumentation.ts` for a target without the Node presets, so the bootstrap's dependency graph
  — `node:crypto` through `core/ids.ts`, `node:fs` and `node:sqlite` through the database, and the
  CommonJS `adm-zip` parser through the importer registry — could not be resolved there. An
  unresolved instrumentation bundle takes the whole server down while the process still looks
  healthy, which is why only running the server surfaced it. `adm-zip` is now loaded on demand the
  way `mammoth` and `pdfjs-dist` already were, and the server compilations leave Node built-ins and
  those three parsers as runtime requires.
- **The production build failed on `/chat`.** The page reads its `?q=` parameter with
  `useSearchParams()`, which opts the route into client-side rendering; Next requires that to sit
  behind a `Suspense` boundary. It never shows up in `next dev` or in the test suite, and it stayed
  hidden behind the type errors below, which stopped the build before prerendering ran.
- **Connector OAuth call sites now match the helpers they call.** Both call sites passed a single
  object to `exchangeCode` / `refreshAccessToken`, which take `(fetchImpl, oauth, params)`; they now
  spread the `OAuthApp` the values came from instead of repeating its fields.
- **The Slack provider names the narrowed channel type** its own filter produces, which the widened
  return type of `resolveChannels` had been cancelling at three call sites. With this,
  `npm run typecheck` is clean for the first time in this work: 11 errors at the start, 0 now.

### Changed

- Migrations may now carry an `up(database)` step, which runs inside the same transaction, for
  values that need the runtime's own normalisation rather than hand-rolled SQL.
- The AI-configured badge and `/api/v1/stats` follow the selected chat provider instead of the
  OpenAI-compatible configuration alone.

### Removed

- `src/lib/i18n/index.ts` — an unused translation dictionary no module imported.
- `probe.ts` — a scratch debugging file.

## [0.1.0] — 2026-10-15

First packaged release: a local-first personal memory system with multi-source capture, hybrid
retrieval, cited RAG chat and automated plays.

### Added

- **Capture** — markdown notes with `[[wiki links]]`, `#tags` and backlinks; file uploads
  (`.pdf`, `.docx`, `.md`, `.txt`, `.html`, `.eml`, `.csv`); URL capture with server-side text
  extraction; folder sync for Obsidian vaults or document folders.
- **Importers** — `mbox`, ICS, RFC 822, Notion export zip and Slack export zip.
- **Connectors** — Gmail, Google Calendar, Outlook / Microsoft 365, Slack (OAuth 2.0 with sealed
  credential storage and page-level cursors) and Notion (pasted integration token).
- **Retrieval** — FTS5 BM25 over diacritic-folded text, a trigram index for substrings and typos,
  optional embedding cosine similarity, fused into one ranked list with per-signal scores, facets
  and filters.
- **Chat** — streamed RAG answers grounded in retrieved passages with `[n]` citations, stored
  conversations, and an extractive fallback that works with no model configured.
- **Plays** — weekly digest, daily brief, meeting brief, open loops, find a document and topic
  dossier, each with a deterministic Markdown output and optional model synthesis.
- **Graph** — people, topics and tags extracted from your content, with co-occurrence weights.
- **Interfaces** — web UI, REST API under `/api/v1`, and a CLI (`health`, `doctor`, `stats`,
  `search`, `ask`, `add`, `ingest`, `sync`, `index`, `play`, `export`, `jobs`).
- **Operations** — background job worker, embedding backfill, JSON export, loopback-by-default
  auth with optional bearer tokens, and a smoke test that runs the whole pipeline in a temp
  directory.

### Fixed

- Chunking no longer emits a bare heading as its own chunk, and a trailing scrap is no longer
  merged across a heading boundary (which used to relabel content with the wrong heading path).
- Connector sync call sites now match the shared OAuth helper signatures, and the Slack channel
  type is narrowed where an id is guaranteed.
- Built-in plays are seeded on every read path, so running a play on a fresh database works.
- Citations carry their heading path, so the UI and prompts can show which section a passage came
  from.

### Changed

- All user-facing copy — UI, CLI output, notices and error messages — is English. Prompts are
  English too, and instruct the model to answer in the language the user wrote in. Vietnamese
  language handling (diacritic folding, slugging, stopwords) is intentionally retained.
- Repository packaging: README, architecture/API/connector/deployment docs, contributing and
  security policies, `.env.example`, `.gitattributes` and a GitHub Actions CI workflow.

### Known limitations

- Document titles are not part of the full-text index, so a word that appears only in a title is
  not matched by search.
- The model layer is OpenAI-compatible only; there is no dedicated Anthropic adapter yet.
- Single-writer: one instance per data directory.
