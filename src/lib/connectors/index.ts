/**
 * Connector catalogue for the app.
 *
 * Importing this module has no side effect: `ensureProvidersRegistered()` is
 * called by the entry points that need the catalogue (API routes, the sync
 * runner), which keeps tests free to register their own fixtures. Registration
 * goes through the plain map in `./registry`, so calling this twice — or from
 * several entry points at once — leaves the same catalogue behind.
 */

import { gmailProvider } from "./providers/gmail";
import { googleCalendarProvider } from "./providers/google_calendar";
import { notionProvider } from "./providers/notion";
import { outlookMailProvider } from "./providers/outlook_mail";
import { slackProvider } from "./providers/slack";
import { getProvider, listProviders, registerProvider, requireProvider } from "./registry";
import type { ConnectorAuth, ConnectorDoc, HttpFetch, Provider, SyncContext, SyncCursor, SyncPage } from "./types";

export { getProvider, listProviders, registerProvider, requireProvider };
export type { ConnectorAuth, ConnectorDoc, HttpFetch, Provider, SyncContext, SyncCursor, SyncPage };

/** Every provider this app ships, in the order shown in the UI. */
export const BUILT_IN_PROVIDERS: readonly Provider[] = [
  gmailProvider,
  googleCalendarProvider,
  outlookMailProvider,
  slackProvider,
  notionProvider,
];

let registered = false;

/** Registers the built-in providers; repeated calls are no-ops. */
export function ensureProvidersRegistered(): void {
  if (registered) return;
  for (const provider of BUILT_IN_PROVIDERS) {
    // A host may register its own provider under a built-in id; that one wins.
    if (getProvider(provider.id) === undefined) registerProvider(provider);
  }
  registered = true;
}
