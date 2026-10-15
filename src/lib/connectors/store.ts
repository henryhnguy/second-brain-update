import { newId, oauthState } from "../core/ids";
import { nowIso } from "../core/time";
import { openSealedJson, sealJson } from "../crypto/secretbox";
import { getDb } from "../db/connection";
import { all, get, jsonParse, num, run, str, strOrNull } from "../db/sql";
import type { Connector, ConnectorStatus, SyncRun } from "../types/domain";
import type { OAuthTokens, SyncCursor } from "./types";

/**
 * Persistence for connectors. Credentials are sealed with AES-256-GCM before
 * they touch SQLite and are never returned to the UI or the API.
 */

function mapConnector(row: Record<string, unknown>): Connector {
  return {
    id: str(row.id),
    provider: str(row.provider),
    name: str(row.name),
    status: str(row.status, "disconnected") as ConnectorStatus,
    authKind: str(row.auth_kind, "oauth2") as "oauth2" | "token",
    accountLabel: strOrNull(row.account_label),
    config: jsonParse<Record<string, unknown>>(row.config, {}),
    cursor: jsonParse<Record<string, unknown>>(row.cursor, {}),
    scopes: jsonParse<string[]>(row.scopes, []),
    hasCredentials: strOrNull(row.secrets) !== null,
    autoSync: num(row.auto_sync, 1) === 1,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    lastSyncAt: strOrNull(row.last_sync_at),
    lastError: strOrNull(row.last_error),
    lastStatus: strOrNull(row.last_status),
    itemsSynced: num(row.items_synced),
  };
}

export function listConnectors(): Connector[] {
  return all<Record<string, unknown>>(getDb(), "SELECT * FROM connectors ORDER BY provider").map(mapConnector);
}

export function getConnector(id: string): Connector | null {
  const row = get<Record<string, unknown>>(getDb(), "SELECT * FROM connectors WHERE id = ?", [id]);
  return row ? mapConnector(row) : null;
}

export function getConnectorByProvider(provider: string): Connector | null {
  const row = get<Record<string, unknown>>(getDb(), "SELECT * FROM connectors WHERE provider = ?", [provider]);
  return row ? mapConnector(row) : null;
}

/** Creates or refreshes the (single) connector row for a provider. */
export function upsertConnector(input: {
  provider: string;
  name: string;
  authKind: "oauth2" | "token";
  config?: Record<string, unknown>;
  scopes?: string[];
  autoSync?: boolean;
  status?: ConnectorStatus;
}): Connector {
  const db = getDb();
  const existing = getConnectorByProvider(input.provider);
  if (existing) {
    run(
      db,
      "UPDATE connectors SET name = ?, auth_kind = ?, config = ?, scopes = ?, auto_sync = ?, status = ?, updated_at = ? WHERE id = ?",
      [
        input.name,
        input.authKind,
        JSON.stringify(input.config ?? existing.config),
        JSON.stringify(input.scopes ?? existing.scopes),
        (input.autoSync ?? existing.autoSync) ? 1 : 0,
        input.status ?? existing.status,
        nowIso(),
        existing.id,
      ],
    );
    return getConnector(existing.id) as Connector;
  }
  const id = newId("con");
  const at = nowIso();
  run(
    db,
    `INSERT INTO connectors (id, provider, name, status, auth_kind, config, cursor, secrets, scopes, auto_sync, items_synced, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', NULL, ?, ?, 0, ?, ?)`,
    [
      id,
      input.provider,
      input.name,
      input.status ?? "disconnected",
      input.authKind,
      JSON.stringify(input.config ?? {}),
      JSON.stringify(input.scopes ?? []),
      input.autoSync === false ? 0 : 1,
      at,
      at,
    ],
  );
  return getConnector(id) as Connector;
}

export function saveTokens(id: string, tokens: OAuthTokens): void {
  run(getDb(), "UPDATE connectors SET secrets = ?, updated_at = ? WHERE id = ?", [
    sealJson(tokens),
    nowIso(),
    id,
  ]);
}

export function loadTokens(id: string): OAuthTokens | null {
  const row = get<{ secrets: string | null }>(getDb(), "SELECT secrets FROM connectors WHERE id = ?", [id]);
  if (!row?.secrets) return null;
  return openSealedJson<OAuthTokens>(row.secrets);
}

export function clearTokens(id: string): void {
  run(getDb(), "UPDATE connectors SET secrets = NULL, status = 'disconnected', updated_at = ? WHERE id = ?", [
    nowIso(),
    id,
  ]);
}

export function updateConnectorState(
  id: string,
  patch: {
    status?: ConnectorStatus;
    accountLabel?: string | null;
    lastError?: string | null;
    lastStatus?: string | null;
    config?: Record<string, unknown>;
    autoSync?: boolean;
    itemsSynced?: number;
    lastSyncAt?: string | null;
  },
): void {
  const existing = getConnector(id);
  if (!existing) return;
  run(
    getDb(),
    `UPDATE connectors SET status = ?, account_label = ?, last_error = ?, last_status = ?, config = ?,
       auto_sync = ?, items_synced = ?, last_sync_at = ?, updated_at = ? WHERE id = ?`,
    [
      patch.status ?? existing.status,
      patch.accountLabel === undefined ? existing.accountLabel : patch.accountLabel,
      patch.lastError === undefined ? existing.lastError : patch.lastError,
      patch.lastStatus === undefined ? existing.lastStatus : patch.lastStatus,
      JSON.stringify(patch.config ?? existing.config),
      (patch.autoSync ?? existing.autoSync) ? 1 : 0,
      patch.itemsSynced ?? existing.itemsSynced,
      patch.lastSyncAt === undefined ? existing.lastSyncAt : patch.lastSyncAt,
      nowIso(),
      id,
    ],
  );
}

export function updateCursor(id: string, cursor: SyncCursor): void {
  run(getDb(), "UPDATE connectors SET cursor = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(cursor),
    nowIso(),
    id,
  ]);
}

export function deleteConnector(id: string): boolean {
  const result = run(getDb(), "DELETE FROM connectors WHERE id = ?", [id]);
  run(getDb(), "DELETE FROM sync_runs WHERE connector_id = ?", [id]);
  return result.changes > 0;
}

export function startSyncRun(connectorId: string): string {
  const id = newId("run");
  run(
    getDb(),
    "INSERT INTO sync_runs (id, connector_id, started_at, status) VALUES (?, ?, ?, 'running')",
    [id, connectorId, nowIso()],
  );
  return id;
}

export function finishSyncRun(
  id: string,
  patch: {
    status: "ok" | "error" | "partial";
    added: number;
    updated: number;
    skipped: number;
    failed: number;
    error?: string | null;
    detail?: Record<string, unknown>;
  },
): void {
  run(
    getDb(),
    "UPDATE sync_runs SET finished_at = ?, status = ?, added = ?, updated = ?, skipped = ?, failed = ?, error = ?, detail = ? WHERE id = ?",
    [
      nowIso(),
      patch.status,
      patch.added,
      patch.updated,
      patch.skipped,
      patch.failed,
      patch.error ?? null,
      JSON.stringify(patch.detail ?? {}),
      id,
    ],
  );
}

export function listSyncRuns(connectorId: string, limit = 20): SyncRun[] {
  return all<Record<string, unknown>>(
    getDb(),
    "SELECT * FROM sync_runs WHERE connector_id = ? ORDER BY started_at DESC LIMIT ?",
    [connectorId, Math.min(Math.max(limit, 1), 100)],
  ).map((row) => ({
    id: str(row.id),
    connectorId: str(row.connector_id),
    startedAt: str(row.started_at),
    finishedAt: strOrNull(row.finished_at),
    status: str(row.status, "running") as SyncRun["status"],
    added: num(row.added),
    updated: num(row.updated),
    skipped: num(row.skipped),
    failed: num(row.failed),
    error: strOrNull(row.error),
    detail: jsonParse<Record<string, unknown>>(row.detail, {}),
  }));
}

/* ------------------------------------------------------------- oauth states */

export function saveOAuthState(input: {
  provider: string;
  connectorId: string | null;
  verifier: string;
  redirectUri: string;
  payload?: Record<string, unknown>;
}): string {
  const state = oauthState();
  run(
    getDb(),
    "INSERT INTO oauth_states (state, provider, connector_id, verifier, redirect_uri, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      state,
      input.provider,
      input.connectorId,
      input.verifier,
      input.redirectUri,
      JSON.stringify(input.payload ?? {}),
      nowIso(),
    ],
  );
  return state;
}

export function consumeOAuthState(state: string): {
  provider: string;
  connectorId: string | null;
  verifier: string;
  redirectUri: string;
  payload: Record<string, unknown>;
} | null {
  const row = get<Record<string, unknown>>(getDb(), "SELECT * FROM oauth_states WHERE state = ?", [state]);
  if (!row) return null;
  run(getDb(), "DELETE FROM oauth_states WHERE state = ?", [state]);
  const createdAt = str(row.created_at);
  const age = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(age) || age > 15 * 60_000) return null;
  return {
    provider: str(row.provider),
    connectorId: strOrNull(row.connector_id),
    verifier: str(row.verifier),
    redirectUri: str(row.redirect_uri),
    payload: jsonParse<Record<string, unknown>>(row.payload, {}),
  };
}

export function purgeExpiredOAuthStates(): number {
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  return run(getDb(), "DELETE FROM oauth_states WHERE created_at < ?", [cutoff]).changes;
}
