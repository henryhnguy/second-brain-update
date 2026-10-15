/**
 * Runs once per server process: opens the database (applying migrations),
 * seeds the built-in plays and starts the background job worker.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { getDb } = await import("./lib/db/connection");
    getDb();

    const { seedBuiltinPlays } = await import("./lib/db/repo/plays");
    seedBuiltinPlays();

    const { startWorker } = await import("./lib/jobs/worker");
    startWorker();
  } catch (error) {
    // Never block the server from starting: surface the reason instead.
    console.error("[second-brain] bootstrap failed:", error instanceof Error ? error.message : error);
  }
}
