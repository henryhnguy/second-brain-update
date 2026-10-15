import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../core/time";
import { createLogger } from "../core/logger";
import { sha256Hex } from "../core/ids";
import { all, exec, run } from "./sql";

const logger = createLogger("db:migrate");

export type Capability = "trigram";

export type Migration = {
  id: number;
  name: string;
  statements: string[];
  /** Migration is skipped (and marked) when the capability is missing. */
  requires?: Capability;
};

export type MigrationReport = {
  applied: string[];
  skipped: string[];
};

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied',
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

export function applyMigrations(
  database: DatabaseSync,
  migrations: Migration[],
  capabilities: Record<Capability, boolean>,
): MigrationReport {
  exec(database, TABLE_SQL);

  const applied = new Map<number, { name: string; checksum: string; status: string }>();
  for (const row of all<{ id: number; name: string; checksum: string; status: string }>(
    database,
    "SELECT id, name, checksum, status FROM schema_migrations",
  )) {
    applied.set(Number(row.id), {
      name: String(row.name),
      checksum: String(row.checksum),
      status: String(row.status),
    });
  }

  const report: MigrationReport = { applied: [], skipped: [] };

  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    const previous = applied.get(migration.id);
    if (previous && previous.status === "applied") continue;

    if (migration.requires && !capabilities[migration.requires]) {
      if (!previous) {
        run(
          database,
          `INSERT INTO schema_migrations (id, name, status, checksum, applied_at) VALUES (?, ?, 'skipped', ?, ?)`,
          [migration.id, migration.name, "", nowIso()],
        );
      }
      report.skipped.push(migration.name);
      logger.warn(`skipped migration ${migration.id}:${migration.name} (missing ${migration.requires})`);
      continue;
    }

    const checksum = sha256Hex(migration.statements.join("\n"));
    exec(database, "BEGIN");
    try {
      for (const statement of migration.statements) exec(database, statement);
      run(
        database,
        `INSERT INTO schema_migrations (id, name, status, checksum, applied_at) VALUES (?, ?, 'applied', ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = 'applied', checksum = excluded.checksum, applied_at = excluded.applied_at`,
        [migration.id, migration.name, checksum, nowIso()],
      );
      exec(database, "COMMIT");
      report.applied.push(migration.name);
    } catch (error) {
      try {
        exec(database, "ROLLBACK");
      } catch {
        /* ignore */
      }
      throw new Error(
        `Migration ${migration.id} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (report.applied.length > 0) logger.info(`applied migrations: ${report.applied.join(", ")}`);
  return report;
}

export function migrationStatus(database: DatabaseSync): { id: number; name: string; status: string; appliedAt: string }[] {
  exec(database, TABLE_SQL);
  return all<{ id: number; name: string; status: string; applied_at: string }>(
    database,
    "SELECT id, name, status, applied_at FROM schema_migrations ORDER BY id",
  ).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    status: String(row.status),
    appliedAt: String(row.applied_at),
  }));
}
