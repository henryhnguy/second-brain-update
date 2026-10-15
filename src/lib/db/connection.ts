import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { backupsDir, dataDir, dbFile, stateDir, uploadsDir } from "../core/env";
import { AppError } from "../core/errors";
import { createLogger } from "../core/logger";
import { MIGRATIONS } from "./migrations";
import { applyMigrations, type MigrationReport } from "./migrate";
import { exec, get } from "./sql";

const logger = createLogger("db");

export type Capabilities = {
  fts5: boolean;
  trigram: boolean;
  sqliteVersion: string;
  journalMode: string;
};

type Cache = {
  db: DatabaseSync | null;
  file: string | null;
  capabilities: Capabilities | null;
  migrationReport: MigrationReport | null;
};

const CACHE_KEY = "__second_brain_sqlite_cache__";

function cache(): Cache {
  const holder = globalThis as unknown as Record<string, Cache | undefined>;
  let existing = holder[CACHE_KEY];
  if (!existing) {
    existing = { db: null, file: null, capabilities: null, migrationReport: null };
    holder[CACHE_KEY] = existing;
  }
  return existing;
}

export function ensureDataDirs(): void {
  for (const dir of [dataDir(), uploadsDir(), backupsDir(), stateDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function assertSqliteAvailable(): void {
  if (typeof DatabaseSync !== "function") {
    throw new AppError(
      "storage_error",
      "node:sqlite is unavailable in this Node.js runtime. Use Node 24+ (or Node 22.5+ with --experimental-sqlite).",
    );
  }
}

function probeCapabilities(database: DatabaseSync): Capabilities {
  let fts5 = false;
  let trigram = false;
  let sqliteVersion = "unknown";
  let journalMode = "unknown";

  try {
    const row = get<{ v: string }>(database, "SELECT sqlite_version() AS v");
    if (row?.v) sqliteVersion = String(row.v);
  } catch {
    /* keep default */
  }

  try {
    exec(database, "CREATE VIRTUAL TABLE temp.__fts_probe USING fts5(x)");
    fts5 = true;
    exec(database, "DROP TABLE temp.__fts_probe");
  } catch {
    fts5 = false;
  }

  try {
    exec(database, "CREATE VIRTUAL TABLE temp.__trigram_probe USING fts5(x, tokenize = 'trigram')");
    trigram = true;
    exec(database, "DROP TABLE temp.__trigram_probe");
  } catch {
    trigram = false;
  }

  try {
    const row = get<{ mode: string }>(database, "PRAGMA journal_mode");
    if (row?.mode) journalMode = String(row.mode);
  } catch {
    /* keep default */
  }

  return { fts5, trigram, sqliteVersion, journalMode };
}

function open(file: string): DatabaseSync {
  assertSqliteAvailable();
  const database = new DatabaseSync(file);
  exec(database, "PRAGMA journal_mode = WAL");
  exec(database, "PRAGMA foreign_keys = ON");
  exec(database, "PRAGMA synchronous = NORMAL");
  exec(database, "PRAGMA busy_timeout = 8000");
  exec(database, "PRAGMA temp_store = MEMORY");
  return database;
}

/** Returns the process-wide connection, opening and migrating on first use. */
export function getDb(): DatabaseSync {
  const state = cache();
  const file = dbFile();
  if (state.db && state.file === file) return state.db;

  if (state.db) {
    try {
      state.db.close();
    } catch {
      /* ignore */
    }
  }

  ensureDataDirs();
  const database = open(file);
  const capabilities = probeCapabilities(database);
  let migrationReport: MigrationReport | null = null;
  if (capabilities.fts5) {
    migrationReport = applyMigrations(database, MIGRATIONS, { trigram: capabilities.trigram });
  } else {
    logger.error("SQLite build lacks FTS5; full-text search will not work");
  }

  state.db = database;
  state.file = file;
  state.capabilities = capabilities;
  state.migrationReport = migrationReport;
  logger.debug(`sqlite ${capabilities.sqliteVersion} ready (fts5=${capabilities.fts5}, trigram=${capabilities.trigram})`);
  return database;
}

export function dbCapabilities(): Capabilities {
  getDb();
  const state = cache();
  return state.capabilities ?? { fts5: false, trigram: false, sqliteVersion: "unknown", journalMode: "unknown" };
}

export function lastMigrationReport(): MigrationReport | null {
  getDb();
  return cache().migrationReport;
}

export function databaseSizeBytes(): number {
  try {
    const file = dbFile();
    const wal = `${file}-wal`;
    const shm = `${file}-shm`;
    const size = (candidate: string) => (fs.existsSync(candidate) ? fs.statSync(candidate).size : 0);
    return size(file) + size(wal) + size(shm);
  } catch {
    return 0;
  }
}

export function databaseFilePath(): string {
  return dbFile();
}

/** Closes the cached connection (used by tests and by the shutdown hook). */
export function closeDb(): void {
  const state = cache();
  if (state.db) {
    try {
      state.db.close();
    } catch {
      /* ignore */
    }
  }
  state.db = null;
  state.file = null;
  state.capabilities = null;
  state.migrationReport = null;
}

/** Closes and reopens against the current `SB_DATA_DIR` — used by tests. */
export function resetDb(): void {
  closeDb();
  getDb();
}

export function dataPaths(): { data: string; database: string; uploads: string; backups: string; state: string } {
  return {
    data: dataDir(),
    database: dbFile(),
    uploads: uploadsDir(),
    backups: backupsDir(),
    state: stateDir(),
  };
}
