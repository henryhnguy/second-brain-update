/**
 * FROZEN CONTRACT — connector framework.
 *
 * A provider knows one remote service (Gmail, Slack, …). It is handed an access
 * token plus a cursor and returns one page of documents. Everything about
 * persistence, encryption, scheduling and ingest lives outside this file, so a
 * provider can be tested with a mocked `fetch`.
 */

export type ConnectorDoc = {
  /** Stable id at the remote service (message id, event id, page id…). */
  externalId: string;
  title: string;
  text: string;
  url?: string | null;
  author?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  mime?: string | null;
  meta?: Record<string, unknown>;
};

export type SyncCursor = Record<string, string | number | boolean | null>;

export type HttpFetch = typeof fetch;

export type SyncContext = {
  /** Injectable for tests; providers must use this instead of global fetch. */
  fetchImpl: HttpFetch;
  accessToken: string;
  /** Extra credentials for `token` auth style providers (e.g. base URL, team). */
  credentials: Record<string, string>;
  /** Provider config chosen by the user (labels to include, channel list…). */
  config: Record<string, unknown>;
  /** Where the previous run stopped. Providers must treat it as opaque. */
  cursor: SyncCursor;
  /** Maximum items to return in this page (providers should respect it). */
  limit: number;
  /** ISO timestamp of the previous successful sync, if any. */
  since: string | null;
  logger: (message: string, extra?: Record<string, unknown>) => void;
};

export type SyncPage = {
  docs: ConnectorDoc[];
  /** Cursor to persist after this page is ingested. */
  cursor: SyncCursor;
  hasMore: boolean;
  /** Provider-specific counters surfaced in the sync log. */
  stats?: Record<string, number>;
};

export type OAuthTokenEndpointAuth = "body_client_secret" | "basic" | "none";

export type OAuthConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  /** Space-separated scope string sent to the provider. */
  scopes: string[];
  /** Use PKCE (S256). Required by Google, recommended everywhere. */
  pkce: boolean;
  tokenEndpointAuth: OAuthTokenEndpointAuth;
  /** Env var names holding the client credentials, for docs and validation. */
  clientIdEnv: string;
  clientSecretEnv: string;
  extraAuthParams?: Record<string, string>;
  /** Extra headers required by the token endpoint. */
  tokenHeaders?: Record<string, string>;
};

export type ConnectorAuth =
  | { kind: "oauth2"; oauth: OAuthConfig; helpUrl?: string }
  | {
      kind: "token";
      /** Field label for the pasted secret, e.g. `Notion integration token`. */
      tokenLabel: string;
      /** Extra non-secret fields the user must supply (e.g. workspace URL). */
      configFields?: { key: string; label: string; required: boolean; placeholder?: string }[];
      helpUrl?: string;
    };

export type Provider = {
  /** Stable id, e.g. `gmail`, `google_calendar`, `outlook_mail`, `slack`, `notion`. */
  id: string;
  label: string;
  description: string;
  /** Used for grouping and icons in the UI. */
  category: "email" | "calendar" | "chat" | "docs" | "crm" | "other";
  auth: ConnectorAuth;
  docsUrl?: string;
  defaultConfig?: Record<string, unknown>;
  /** One page of documents. Must be idempotent: the same cursor may be replayed. */
  syncPage(ctx: SyncContext): Promise<SyncPage>;
  /** Optional: identify the account behind a token (shown in the UI). */
  identify?(ctx: Omit<SyncContext, "cursor">): Promise<{ accountLabel: string; extra?: Record<string, unknown> }>;
  /** Optional: how deep a full sync may go, in days (used for first sync). */
  initialLookbackDays?: number;
};

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  tokenType?: string | null;
  scope?: string | null;
  extra?: Record<string, unknown>;
};

export type OAuthExchangeResult = OAuthTokens & { raw: Record<string, unknown> };
