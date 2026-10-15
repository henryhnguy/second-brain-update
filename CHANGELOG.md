# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
