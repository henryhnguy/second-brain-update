import { newId, randomToken, sha256Hex } from "../../core/ids";
import { nowIso } from "../../core/time";
import type { ActivityEvent, Job, JobKind, JobStatus } from "../../types/domain";
import { getDb } from "../connection";
import { all, get, jsonParse, num, run, str, strOrNull } from "../sql";

/* ------------------------------------------------------------------ settings */

export function getSetting(key: string): string | null {
  const row = get<{ value: string }>(getDb(), "SELECT value FROM settings WHERE key = ?", [key]);
  return row?.value ?? null;
}

export function getSettingJson<T>(key: string, fallback: T): T {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: string | number | boolean | null): void {
  run(
    getDb(),
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value === null ? "" : String(value), nowIso()],
  );
}

export function setSettingJson(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value));
}

export function deleteSetting(key: string): void {
  run(getDb(), "DELETE FROM settings WHERE key = ?", [key]);
}

export function listSettings(): Record<string, string> {
  const rows = all<{ key: string; value: string }>(getDb(), "SELECT key, value FROM settings ORDER BY key");
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/* -------------------------------------------------------------------- events */

export function recordEvent(input: {
  kind: string;
  title: string;
  documentId?: string | null;
  connectorId?: string | null;
  detail?: Record<string, unknown>;
  at?: string;
}): string {
  const id = newId("evt");
  run(getDb(), "INSERT INTO events (id, at, kind, document_id, connector_id, title, detail) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    id,
    input.at ?? nowIso(),
    input.kind,
    input.documentId ?? null,
    input.connectorId ?? null,
    input.title,
    JSON.stringify(input.detail ?? {}),
  ]);
  return id;
}

export function listEvents(options: { limit?: number; offset?: number; kinds?: string[]; since?: string | null } = {}): ActivityEvent[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.kinds && options.kinds.length > 0) {
    clauses.push(`kind IN (${options.kinds.map(() => "?").join(", ")})`);
    params.push(...options.kinds);
  }
  if (options.since) {
    clauses.push("at >= ?");
    params.push(options.since);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  return all<Record<string, unknown>>(
    db,
    `SELECT * FROM events ${where} ORDER BY at DESC LIMIT ? OFFSET ?`,
    [...params, limit, Math.max(options.offset ?? 0, 0)],
  ).map((row) => ({
    id: str(row.id),
    at: str(row.at),
    kind: str(row.kind),
    documentId: strOrNull(row.document_id),
    connectorId: strOrNull(row.connector_id),
    title: str(row.title),
    detail: jsonParse<Record<string, unknown>>(row.detail, {}),
  }));
}

export function eventTimeline(days: number): { day: string; count: number; kinds: Record<string, number> }[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = all<Record<string, unknown>>(
    getDb(),
    "SELECT substr(at, 1, 10) AS day, kind, COUNT(*) AS c FROM events WHERE at >= ? GROUP BY day, kind ORDER BY day DESC",
    [since],
  );
  const byDay = new Map<string, { day: string; count: number; kinds: Record<string, number> }>();
  for (const row of rows) {
    const day = str(row.day);
    const entry = byDay.get(day) ?? { day, count: 0, kinds: {} };
    const count = num(row.c);
    entry.count += count;
    entry.kinds[str(row.kind)] = (entry.kinds[str(row.kind)] ?? 0) + count;
    byDay.set(day, entry);
  }
  return Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? 1 : -1));
}

export function purgeEventsOlderThan(days: number): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return run(getDb(), "DELETE FROM events WHERE at < ?", [cutoff]).changes;
}

/* ---------------------------------------------------------------------- jobs */

function mapJob(row: Record<string, unknown>): Job {
  return {
    id: str(row.id),
    kind: str(row.kind) as JobKind,
    payload: jsonParse<Record<string, unknown>>(row.payload, {}),
    status: str(row.status, "queued") as JobStatus,
    priority: num(row.priority),
    attempts: num(row.attempts),
    maxAttempts: num(row.max_attempts, 3),
    scheduledAt: str(row.scheduled_at),
    startedAt: strOrNull(row.started_at),
    finishedAt: strOrNull(row.finished_at),
    error: strOrNull(row.error),
    result: jsonParse<Record<string, unknown>>(row.result, {}),
    createdAt: str(row.created_at),
  };
}

export function enqueueJob(input: {
  kind: JobKind;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  scheduledAt?: string;
}): string {
  const id = newId("job");
  run(
    getDb(),
    `INSERT INTO jobs (id, kind, payload, status, priority, attempts, max_attempts, scheduled_at, created_at)
     VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, ?)`,
    [
      id,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 0,
      input.maxAttempts ?? 3,
      input.scheduledAt ?? nowIso(),
      nowIso(),
    ],
  );
  return id;
}

export function claimNextJob(): Job | null {
  const db = getDb();
  const row = get<Record<string, unknown>>(
    db,
    `SELECT * FROM jobs WHERE status = 'queued' AND scheduled_at <= ? ORDER BY priority DESC, scheduled_at ASC LIMIT 1`,
    [nowIso()],
  );
  if (!row) return null;
  const id = str(row.id);
  const claimed = run(
    db,
    "UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'",
    [nowIso(), id],
  );
  if (claimed.changes === 0) return null;
  return getJob(id);
}

export function getJob(id: string): Job | null {
  const row = get<Record<string, unknown>>(getDb(), "SELECT * FROM jobs WHERE id = ?", [id]);
  return row ? mapJob(row) : null;
}

export function listJobs(options: { status?: JobStatus[]; limit?: number; kind?: JobKind } = {}): Job[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.status && options.status.length > 0) {
    clauses.push(`status IN (${options.status.map(() => "?").join(", ")})`);
    params.push(...options.status);
  }
  if (options.kind) {
    clauses.push("kind = ?");
    params.push(options.kind);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return all<Record<string, unknown>>(
    db,
    `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`,
    [...params, Math.min(Math.max(options.limit ?? 50, 1), 300)],
  ).map(mapJob);
}

export function completeJob(id: string, result: Record<string, unknown> = {}): void {
  run(getDb(), "UPDATE jobs SET status = 'done', finished_at = ?, error = NULL, result = ? WHERE id = ?", [
    nowIso(),
    JSON.stringify(result),
    id,
  ]);
}

export function failJob(id: string, error: string, options: { retry?: boolean; delayMs?: number } = {}): void {
  const job = getJob(id);
  const retry = options.retry ?? (job ? job.attempts < job.maxAttempts : false);
  if (retry && job) {
    const nextAt = new Date(Date.now() + (options.delayMs ?? 15_000)).toISOString();
    run(getDb(), "UPDATE jobs SET status = 'queued', scheduled_at = ?, error = ? WHERE id = ?", [nextAt, error, id]);
    return;
  }
  run(getDb(), "UPDATE jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?", [nowIso(), error, id]);
}

export function cancelJob(id: string): void {
  run(getDb(), "UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued','running')", [
    nowIso(),
    id,
  ]);
}

export function jobCounts(): Record<string, number> {
  const rows = all<{ status: string; c: number }>(getDb(), "SELECT status, COUNT(*) AS c FROM jobs GROUP BY status");
  return Object.fromEntries(rows.map((row) => [row.status, num(row.c)]));
}

export function requeueStaleJobs(olderThanMs = 30 * 60_000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return run(
    getDb(),
    "UPDATE jobs SET status = 'queued', scheduled_at = ? WHERE status = 'running' AND started_at < ?",
    [nowIso(), cutoff],
  ).changes;
}

/* ---------------------------------------------------------------- api tokens */

export type ApiTokenRecord = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export function createApiToken(name: string, scopes: string[] = ["read", "write"]): { record: ApiTokenRecord; token: string } {
  const token = `sb_${randomToken(24)}`;
  const id = newId("tok");
  run(
    getDb(),
    `INSERT INTO api_tokens (id, name, token_hash, prefix, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, name, sha256Hex(token), token.slice(0, 10), JSON.stringify(scopes), nowIso()],
  );
  return {
    record: {
      id,
      name,
      prefix: token.slice(0, 10),
      scopes,
      createdAt: nowIso(),
      lastUsedAt: null,
      revokedAt: null,
    },
    token,
  };
}

export function listApiTokens(): ApiTokenRecord[] {
  return all<Record<string, unknown>>(
    getDb(),
    "SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY created_at DESC",
  ).map((row) => ({
    id: str(row.id),
    name: str(row.name),
    prefix: str(row.prefix),
    scopes: jsonParse<string[]>(row.scopes, []),
    createdAt: str(row.created_at),
    lastUsedAt: strOrNull(row.last_used_at),
    revokedAt: strOrNull(row.revoked_at),
  }));
}

export function verifyApiToken(token: string): ApiTokenRecord | null {
  const hash = sha256Hex(token);
  const row = get<Record<string, unknown>>(
    getDb(),
    "SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_tokens WHERE token_hash = ?",
    [hash],
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  const id = str(row.id);
  run(getDb(), "UPDATE api_tokens SET last_used_at = ? WHERE id = ?", [nowIso(), id]);
  return {
    id,
    name: str(row.name),
    prefix: str(row.prefix),
    scopes: jsonParse<string[]>(row.scopes, []),
    createdAt: str(row.created_at),
    lastUsedAt: strOrNull(row.last_used_at),
    revokedAt: strOrNull(row.revoked_at),
  };
}

export function revokeApiToken(id: string): boolean {
  return run(getDb(), "UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [nowIso(), id]).changes > 0;
}

export function countApiTokens(): number {
  const row = get<{ c: number }>(getDb(), "SELECT COUNT(*) AS c FROM api_tokens WHERE revoked_at IS NULL");
  return num(row?.c);
}
