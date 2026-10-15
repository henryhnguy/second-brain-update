# Connectors

Connectors pull mail, calendar and chat into your memory on a cursor, page by page. Nothing is
written to a remote service: every provider here is read-only.

## How authorization works

- **OAuth 2.0 providers** (Gmail, Google Calendar, Outlook / Microsoft 365, Slack) need an app
  registration of your own. You paste the client id and secret in **Settings → Connectors**, or
  supply them through the environment. Tokens are sealed with the local key before they are
  stored, and refresh automatically before they expire.
- **Token providers** (Notion) take a pasted integration token instead of an OAuth dance.

The redirect URL to register with each provider is:

```
<SB_PUBLIC_URL or SB_APP_URL>/api/v1/connectors/<providerId>/callback
```

For example `http://localhost:4173/api/v1/connectors/gmail/callback`. Localhost redirects are
accepted by Google, Microsoft and Slack for development, but you must add the exact URL to the
app's allowed redirect list.

Environment variables follow `SB_<PROVIDER>_CLIENT_ID` and `SB_<PROVIDER>_CLIENT_SECRET`, where
`<PROVIDER>` is the provider id uppercased:

| Provider id | Env prefix | Auth |
| --- | --- | --- |
| `gmail` | `SB_GMAIL_` | OAuth 2.0 + PKCE |
| `google_calendar` | `SB_GOOGLE_CALENDAR_` | OAuth 2.0 + PKCE |
| `outlook_mail` | `SB_OUTLOOK_MAIL_` | OAuth 2.0 |
| `slack` | `SB_SLACK_` | OAuth 2.0 (confidential client; secret travels in the token request body) |
| `notion` | — | Pasted integration token, optional workspace label |

## Setting up each service

**Google (Gmail, Google Calendar)** — Google Cloud Console → *APIs & Services* → create a project,
enable the Gmail API and the Google Calendar API, then create an *OAuth client ID* of type *Web
application* with the callback URL above. Use read-only scopes: `gmail.readonly` and
`calendar.readonly`. Paste the client id and secret in the app.

**Microsoft (Outlook / Microsoft 365)** — Entra ID → *App registrations* → new registration, add
the callback URL as a *Web* redirect URI, create a client secret, and grant the delegated
`Mail.Read` permission. Paste the client id and secret in the app.

**Slack** — api.slack.com/apps → *Create New App* → *OAuth & Permissions*, add the callback URL
under *Redirect URLs*, then add the bot/user scopes the connector asks for (channel, group, IM and
MPIM read plus history, and `users:read`) and install the app to your workspace. Paste the client
id and secret; no PKCE is used because Slack's v2 flow is a confidential-client flow.

**Notion** — notion.so/my-integrations → new internal integration, copy the token, and **share the
pages you want indexed with the integration** (an integration only sees what it has been given).
Paste the token in the app. An optional workspace label is used only for display.

## How a sync runs

- A **cursor** is persisted after every page, so an interrupted sync resumes where it stopped
  rather than re-fetching everything.
- Slack history is paged backwards (`latest` walks down toward `oldest`) with a 60-second overlap
  at the boundary; ingest de-duplicates by `externalId`, so the overlap is listed again rather than
  lost.
- Thread replies arrive inside the document of their thread root; each page is bounded by a
  maximum number of `conversations.replies` calls.
- A channel that cannot be read (never joined, archived, deleted) is logged and skipped instead of
  failing the whole run.
- Runs are bounded by safety valves (`maxPages`, `maxItems`) so a first sync of a huge mailbox
  cannot run forever.
- Every run is recorded: status, added/updated/skipped/failed counts, and an error string. The
  **Connectors** page shows the per-connector log.

Run a sync from the UI (**Sync now**), the API, or the CLI:

```bash
npm run cli -- sync                 # every connected source that has auto-sync on
npm run cli -- health               # what is connected, what is missing
npm run cli -- doctor               # diagnose configuration problems
```

## Notes

- Disconnecting removes the stored credential; already-ingested documents stay in your memory
  until you delete them.
- Connector credentials live in the database, sealed. Without `data/.secret` they cannot be
  decrypted — keep it with your backups, and never commit it.
