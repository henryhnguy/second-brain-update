# HTTP API

Everything the UI does goes through the same API the CLI uses.

- **Base path:** `/api/v1`
- **Content type:** JSON, except the upload endpoints which take `multipart/form-data`.
- **Implementation:** `src/lib/api/router.ts` holds the route table;
  `src/app/api/v1/[...path]/route.ts` is a thin adapter that adds auth and error handling.

## Authentication

| Mode | When it applies |
| --- | --- |
| **Loopback** | Requests from the local machine are accepted by default. |
| **Bearer token** | Required when `SB_API_REQUIRE_TOKEN=1`. Create a token in **Settings → API token** and send `Authorization: Bearer <token>`. |

`SB_API_DISABLE_AUTH=1` turns the check off entirely — only do that behind your own boundary.

The browser-facing OAuth callback (`GET /api/v1/connectors/:provider/callback`) is exempt, because
the provider's domain opens it.

## Errors

Every failure returns the same envelope, with the HTTP status set from the error kind:

```json
{
  "error": {
    "code": "bad_request",
    "message": "No file in the form (field `file`).",
    "details": { "…": "optional context" }
  }
}
```

Codes include `bad_request`, `unauthorized`, `not_found`, `conflict`, `upstream_error` and
`ai_not_configured`.

## Endpoints

### Health and stats

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Runtime, capabilities, data directories, applied migrations |
| `GET` | `/stats` | Documents, chunks, notes, embeddings, coverage, AI configured |
| `GET` | `/capabilities` | Registered extractors, importers and connector providers |

### Documents, notes and tags

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/documents` | Paginated list; `since`, `until`, `source`, `orderBy`, `limit`, `offset` |
| `GET` | `/documents/:id` | One document with its chunks |
| `PATCH` | `/documents/:id` | Rename, pin, or change metadata |
| `DELETE` | `/documents/:id` | Soft delete |
| `GET` `POST` | `/notes` | List or create notes (`markdown`, `title?`, `tags?`) |
| `GET` `PATCH` `DELETE` | `/notes/:id` | Read, update (re-chunks on change), delete |
| `GET` | `/tags` | Tags with counts |
| `GET` `POST` | `/collections` | Saved filters |
| `GET` `PATCH` `DELETE` | `/collections/:id` | Manage one collection |

### Capture

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/ingest/text` | `{ text, title?, tags?, sourceKind?, sourceId? }` |
| `POST` | `/ingest/url` | `{ url, title?, tags? }` — fetches and extracts page text |
| `POST` | `/ingest/file` | multipart, field `file` (repeatable, max 50) |
| `POST` | `/ingest/importer` | multipart with an export (mbox, ICS, Notion zip, Slack zip, `.eml`) |
| `POST` | `/ingest/folder` | `{ path, glob? }` — sync a local folder |
| `GET` | `/ingest/folders` | Known folders and their last sync |

### Retrieval and chat

| Method | Path | Notes |
| --- | --- | --- |
| `GET` `POST` | `/search` | `{ query, mode?: "hybrid"\|"keyword"\|"semantic", limit?, filters? }` |
| `POST` | `/chat` | `{ message, conversationId?, scope? }` → answer with citations |
| `POST` | `/chat/stream` | Same, streamed as server-sent events |
| `GET` `POST` | `/conversations` | List or create |
| `GET` `PATCH` `DELETE` | `/conversations/:id` | Read with messages, rename, delete |
| `POST` | `/conversations/clear` | Delete every conversation |
| `GET` | `/messages` | Recent messages across conversations |

### Curator

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/curator/index` | Memory map: shelves by source, totals and coverage ratios |
| `GET` | `/curator/health` | Hygiene report; `days` sets the stale threshold (30–3650, default 180) |
| `GET` | `/curator/templates` | The five distillation templates |
| `POST` | `/curator/distill` | `{ documentId, template?, lang?, save?, useLlm? }` → one-pager plus the saved note id |

### Studio

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/studio/generate` | `{ kind: "lesson"\|"slides"\|"mindmap", documentIds?, collectionId?, query?, limit?, maxSlides?, lang?, useLlm?, title? }` |
| `GET` | `/studio/artifacts` | Recent artifacts; `kind`, `limit` |
| `GET` | `/studio/artifacts/:id` | One artifact, slides and citations included |
| `DELETE` | `/studio/artifacts/:id` | Delete the artifact; sources stay in the library |

### Connectors, plays, jobs and settings

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/connectors` | Configured connectors plus the provider catalogue |
| `POST` | `/connectors/:provider/connect` | Start OAuth, returns the consent URL |
| `GET` | `/connectors/:provider/callback` | OAuth redirect target |
| `POST` | `/connectors/:provider/token` | Store a pasted token (Notion) |
| `POST` | `/connectors/:id/sync` | Run a sync now |
| `GET` | `/connectors/:id/runs` | Sync history |
| `GET` `POST` | `/plays` | List or create plays |
| `POST` | `/plays/:id/run` | Run a play, returns the Markdown output |
| `GET` | `/plays/runs` | Play run history |
| `GET` | `/jobs` | Background queue state |
| `GET` `PATCH` | `/settings` | Read and write settings (model config, OAuth apps) |
| `GET` `POST` `DELETE` | `/tokens` | API tokens |

## Examples

```bash
# Capture a note, then find it again
curl -s localhost:4173/api/v1/ingest/text \
  -H 'content-type: application/json' \
  -d '{"text":"Enterprise tier stays at 40 USD per seat.","title":"Pricing decision"}'

curl -s "localhost:4173/api/v1/search?query=pricing&mode=hybrid&limit=5"

# Ask with citations
curl -s localhost:4173/api/v1/chat \
  -H 'content-type: application/json' \
  -d '{"message":"What did we decide about pricing?"}'

# A play, with no model configured
curl -s -X POST localhost:4173/api/v1/plays/play_weekly_digest/run \
  -H 'content-type: application/json' -d '{"params":{"days":7}}'

# Curate: map, distil one document, then review
curl -s localhost:4173/api/v1/curator/index
curl -s -X POST localhost:4173/api/v1/curator/distill \
  -H 'content-type: application/json' \
  -d '{"documentId":"doc_…","template":"guideline","lang":"vi"}'
curl -s "localhost:4173/api/v1/curator/health?days=180"
```

With `SB_API_REQUIRE_TOKEN=1`, add `-H "Authorization: Bearer <token>"` to every call.
