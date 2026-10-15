# Security

## Reporting a vulnerability

Open a private security advisory on the repository (GitHub → **Security** → **Report a
vulnerability**) rather than a public issue. Include the version or commit, what you did, what you
observed, and what you expected. You will get a response as soon as the maintainer sees it; this
is a personal project, so please allow a few days.

## How this software handles your data

Second Brain is local-first. It has no telemetry, no analytics and no remote service of its own.

**What stays on your machine**

- `data/brain.db` — your documents, chunks, notes, conversations, jobs and events. Plain SQLite,
  not encrypted.
- `data/files/` — original uploads, kept so a document can be re-indexed.
- `data/.secret` — the key that seals stored credentials.

**What is encrypted**

Connector credentials (OAuth client secrets, access and refresh tokens, pasted API tokens) are
sealed with the key in `data/.secret` before they are stored. The API returns them masked or not at
all. Losing `data/.secret` means the credentials must be entered again; your documents are
unaffected.

**What leaves the machine**

Only what you configure. If you set an OpenAI-compatible endpoint, your questions, the retrieved
passages sent as context, and the text of documents being embedded are sent there. Leave the model
unconfigured (`SB_AI_MODE=off`) and nothing leaves at all — search, capture, notes and the graph
all keep working. Connectors read from Gmail, Google Calendar, Outlook, Slack and Notion, but only
ever read.

## Hardening checklist

- [ ] Keep `data/` out of version control. `.gitignore` already excludes it.
- [ ] If the app is reachable beyond localhost, set `SB_API_REQUIRE_TOKEN=1` and create a token.
      The default is loopback-only, and the API refuses other callers.
- [ ] Never set `SB_API_DISABLE_AUTH=1` on a host with a public address.
- [ ] Terminate TLS at your reverse proxy; do not expose the Node port directly.
- [ ] Back up `data/` including `.secret`, and treat the backup as sensitive.
- [ ] Treat connector client secrets as secrets: they belong in the settings UI (sealed) or in
      `.env`, never in a commit.

## Scope notes

- The OAuth callback route is intentionally exempt from API auth, because the provider's domain
  opens it. It validates the short-lived `state` value it issued, and the authorization code is
  exchanged server-side.
- Uploaded files are extracted in-process. Parsers are pure-JS libraries, and the HTTP-facing
  surface limits upload size and file count; treat documents from untrusted sources as you would
  any other untrusted input.
- There is no multi-user model. Every request that is authorized has full access to the whole
  memory by design.
