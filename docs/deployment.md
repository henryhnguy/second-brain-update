# Deployment

Second Brain is designed to run on the machine whose memory it holds. It also runs fine on a home
server or a small VPS — keep in mind that the whole point is that your notes, mail and files stay
in one place you control.

## Requirements

- **Node.js 24+** (or 22.5+ with `--experimental-sqlite`). The database uses the built-in
  `node:sqlite` module, so there is no compiler toolchain and no database server to install.
- Write access to the data directory (default `./data`).

## Production run

```bash
npm ci
npm run build
npm start                 # serves the standalone build on $PORT (default 4173)
```

Set at least these in the environment or in `.env`:

```bash
PORT=4173
SB_PUBLIC_URL=https://brain.example.com   # used to build connector callback URLs
SB_DATA_DIR=/var/lib/second-brain         # keep the memory outside the checkout
```

Notes:

- `next.config.mjs` sets `output: "standalone"`, so `.next/standalone` can be copied and run
  without the full dependency tree.
- The first request after a restart applies any pending migrations automatically; the log line
  `db:migrate applied migrations: …` tells you what ran.

## Reverse proxy

Terminate TLS at your proxy and forward to the Node process. Two things to configure:

1. **Forward the client address.** The API treats loopback as trusted, so if you expose it, set
   `SB_API_REQUIRE_TOKEN=1` and create a token first — otherwise anyone reaching the proxy can
   read your memory.
2. **`SB_PUBLIC_URL`** must match the public URL exactly, including scheme and port, or connector
   callbacks will be rejected by the provider.

Large uploads pass through the proxy too: the app accepts up to 25 MB per request, so set the
proxy's body limit accordingly.

## Exposing it safely

| Setting | Effect |
| --- | --- |
| `SB_API_REQUIRE_TOKEN=1` | Every API call needs `Authorization: Bearer <token>` |
| `SB_API_DISABLE_AUTH=1` | No auth at all — only behind your own boundary |
| (default) | Loopback callers only; requests from other hosts are refused |

The OAuth callback route is always exempt from auth, because the provider's domain opens it. It
only accepts a short-lived `state` value that this instance generated.

## Backups

Everything that matters is under the data directory:

```
data/
  brain.db        the memory (documents, chunks, notes, conversations, jobs, events)
  brain.db-wal    write-ahead log — copy it with the database, or checkpoint first
  files/          original uploads, kept so a document can be re-indexed
  backups/        exports written by the app
  state/          worker state
  .secret         key that seals stored connector credentials
```

Back up `data/` atomically — either stop the app, or use SQLite's own backup command — and keep
`.secret` with it. Without that file, sealed credentials cannot be decrypted and connectors must
be re-authorized (your documents are not encrypted, so they survive).

Restore is the reverse: put the directory back and start the app.

## Maintenance

```bash
npm run cli -- health       # runtime and capabilities
npm run cli -- doctor       # configuration problems
npm run cli -- index        # backfill missing embeddings after adding a model
npm run cli -- export --out backup.json   # portable JSON export
npm run cli -- stats        # what is in the memory
```

Upgrades are `git pull && npm ci && npm run build`, then restart. Database migrations run on the
next request.

## Verifying a deployment

```bash
npm run typecheck
npm test
npm run smoke      # end-to-end check in a throwaway temp directory
```

The smoke test never touches your real data directory: it points `SB_DATA_DIR` at a temp folder.
