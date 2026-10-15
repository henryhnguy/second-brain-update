import type { DatabaseSync } from "node:sqlite";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Params = unknown[];
export type Row = Record<string, unknown>;

export function toSqlValueMap(params: Params): SqlValue[] {
  return params.map((value) => toSqlValue(value));
}

export function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === "string") return value as string;
  if (type === "number") {
    const num = value as number;
    return Number.isFinite(num) ? num : null;
  }
  if (type === "bigint") return value as bigint;
  if (type === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) || type === "object") return JSON.stringify(value);
  return String(value);
}

export function all<T = Row>(database: DatabaseSync, sql: string, params: Params = []): T[] {
  const statement = database.prepare(sql);
  return statement.all(...toSqlValueMap(params)) as T[];
}

export function get<T = Row>(database: DatabaseSync, sql: string, params: Params = []): T | null {
  const statement = database.prepare(sql);
  const row = statement.get(...toSqlValueMap(params)) as T | undefined;
  return row ?? null;
}

export function run(
  database: DatabaseSync,
  sql: string,
  params: Params = [],
): { changes: number; lastInsertRowid: number } {
  const statement = database.prepare(sql);
  const result = statement.run(...toSqlValueMap(params));
  return {
    changes: Number(result.changes ?? 0),
    lastInsertRowid: Number(result.lastInsertRowid ?? 0),
  };
}

export function exec(database: DatabaseSync, sql: string): void {
  database.exec(sql);
}

/** Runs `fn` inside BEGIN/COMMIT, rolling back on any throw. */
export function transaction<T>(database: DatabaseSync, fn: () => T): T {
  database.exec("BEGIN");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* connection already rolled back or closed */
    }
    throw error;
  }
}

export function jsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  return fallback;
}

export function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Packs a float vector into a compact BLOB (little-endian float32). */
export function encodeVector(vector: Float32Array | number[]): Uint8Array {
  const source = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
}

export function decodeVector(blob: unknown): Float32Array {
  if (blob instanceof Uint8Array) {
    return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  }
  if (blob instanceof ArrayBuffer) return new Float32Array(blob);
  if (Array.isArray(blob)) return Float32Array.from(blob as number[]);
  return new Float32Array(0);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] as number;
    const bv = b[i] as number;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
