import { newId } from "../../core/ids";
import { nowIso } from "../../core/time";
import type { Citation, Play, PlayKind, PlayRun } from "../../types/domain";
import { getDb } from "../connection";
import { all, get, jsonParse, num, run, str, strOrNull } from "../sql";

export type BuiltinPlay = {
  id: string;
  name: string;
  kind: PlayKind;
  description: string;
  schedule: string | null;
  params: Record<string, unknown>;
  usesLlm: boolean;
};

/** The recommended starting set, mirroring the "Popular Plays" idea. */
export const BUILTIN_PLAYS: BuiltinPlay[] = [
  {
    id: "play_weekly_digest",
    name: "Weekly digest",
    kind: "weekly_digest",
    description: "Pulls everything saved in the last 7 days into a round-up grouped by topic and source.",
    schedule: "0 18 * * 5",
    params: { days: 7 },
    usesLlm: true,
  },
  {
    id: "play_daily_brief",
    name: "Today's brief",
    kind: "daily_brief",
    description: "The 3-6 most important points of the day, each with its source.",
    schedule: "0 8 * * 1-5",
    params: { days: 1 },
    usesLlm: true,
  },
  {
    id: "play_meeting_brief",
    name: "Meeting brief",
    kind: "meeting_brief",
    description: "Context, earlier exchanges and relevant documents for one meeting.",
    schedule: null,
    params: { topic: "" },
    usesLlm: true,
  },
  {
    id: "play_open_loops",
    name: "Open loops",
    kind: "open_loops",
    description: "Lists the deadlines, requests and questions still open from the last 30 days.",
    schedule: "0 9 * * 1",
    params: { days: 30 },
    usesLlm: false,
  },
  {
    id: "play_find_file",
    name: "Find a document",
    kind: "find_file",
    description: "Answers “where did I put that?” with hybrid search.",
    schedule: null,
    params: { query: "" },
    usesLlm: false,
  },
  {
    id: "play_topic_dossier",
    name: "Topic dossier",
    kind: "topic_dossier",
    description: "Builds a timeline of everything known about one topic.",
    schedule: null,
    params: { topic: "" },
    usesLlm: true,
  },
];

function mapPlay(row: Record<string, unknown>): Play {
  return {
    id: str(row.id),
    name: str(row.name),
    kind: str(row.kind, "custom") as PlayKind,
    description: str(row.description),
    enabled: num(row.enabled, 1) === 1,
    schedule: strOrNull(row.schedule),
    params: jsonParse<Record<string, unknown>>(row.params, {}),
    usesLlm: num(row.uses_llm) === 1,
    lastRunAt: strOrNull(row.last_run_at),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function seedBuiltinPlays(): number {
  const db = getDb();
  let created = 0;
  for (const play of BUILTIN_PLAYS) {
    const existing = get<{ id: string }>(db, "SELECT id FROM plays WHERE id = ?", [play.id]);
    if (existing) continue;
    const at = nowIso();
    run(
      db,
      `INSERT INTO plays (id, name, kind, description, enabled, schedule, params, uses_llm, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [
        play.id,
        play.name,
        play.kind,
        play.description,
        play.schedule,
        JSON.stringify(play.params),
        play.usesLlm ? 1 : 0,
        at,
        at,
      ],
    );
    created += 1;
  }
  return created;
}

export function listPlays(): Play[] {
  seedBuiltinPlays();
  return all<Record<string, unknown>>(getDb(), "SELECT * FROM plays ORDER BY name").map(mapPlay);
}

export function getPlay(id: string): Play | null {
  // Built-in plays are seeded lazily. Every read path has to rely on them
  // existing, because the CLI can run a play before anything lists them.
  seedBuiltinPlays();
  const row = get<Record<string, unknown>>(getDb(), "SELECT * FROM plays WHERE id = ?", [id]);
  return row ? mapPlay(row) : null;
}

export function createPlay(input: {
  name: string;
  kind?: PlayKind;
  description?: string;
  params?: Record<string, unknown>;
  schedule?: string | null;
  usesLlm?: boolean;
}): Play {
  const id = newId("play");
  const at = nowIso();
  run(
    getDb(),
    `INSERT INTO plays (id, name, kind, description, enabled, schedule, params, uses_llm, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.kind ?? "custom",
      input.description ?? "",
      input.schedule ?? null,
      JSON.stringify(input.params ?? {}),
      input.usesLlm === false ? 0 : 1,
      at,
      at,
    ],
  );
  const play = getPlay(id);
  if (!play) throw new Error("could not create play");
  return play;
}

export function updatePlay(
  id: string,
  patch: { name?: string; description?: string; enabled?: boolean; schedule?: string | null; params?: Record<string, unknown>; usesLlm?: boolean },
): Play | null {
  const existing = getPlay(id);
  if (!existing) return null;
  run(
    getDb(),
    "UPDATE plays SET name = ?, description = ?, enabled = ?, schedule = ?, params = ?, uses_llm = ?, updated_at = ? WHERE id = ?",
    [
      patch.name ?? existing.name,
      patch.description ?? existing.description,
      (patch.enabled ?? existing.enabled) ? 1 : 0,
      patch.schedule === undefined ? existing.schedule : patch.schedule,
      JSON.stringify(patch.params ?? existing.params),
      (patch.usesLlm ?? existing.usesLlm) ? 1 : 0,
      nowIso(),
      id,
    ],
  );
  return getPlay(id);
}

export function deletePlay(id: string): boolean {
  return run(getDb(), "DELETE FROM plays WHERE id = ?", [id]).changes > 0;
}

export function startPlayRun(play: Play, params: Record<string, unknown>): string {
  const id = newId("run");
  run(
    getDb(),
    `INSERT INTO play_runs (id, play_id, play_name, started_at, status, params) VALUES (?, ?, ?, ?, 'running', ?)`,
    [id, play.id, play.name, nowIso(), JSON.stringify(params)],
  );
  run(getDb(), "UPDATE plays SET last_run_at = ? WHERE id = ?", [nowIso(), play.id]);
  return id;
}

export function finishPlayRun(
  id: string,
  input: { status: "ok" | "error"; output: string; citations: Citation[]; usedLlm: boolean; error?: string | null; usage?: Record<string, unknown> },
): void {
  run(
    getDb(),
    `UPDATE play_runs SET finished_at = ?, status = ?, output = ?, citations = ?, used_llm = ?, error = ?, usage = ? WHERE id = ?`,
    [
      nowIso(),
      input.status,
      input.output,
      JSON.stringify(input.citations),
      input.usedLlm ? 1 : 0,
      input.error ?? null,
      JSON.stringify(input.usage ?? {}),
      id,
    ],
  );
}

function mapPlayRun(row: Record<string, unknown>): PlayRun {
  return {
    id: str(row.id),
    playId: str(row.play_id),
    playName: str(row.play_name),
    startedAt: str(row.started_at),
    finishedAt: strOrNull(row.finished_at),
    status: str(row.status, "running") as PlayRun["status"],
    params: jsonParse<Record<string, unknown>>(row.params, {}),
    output: str(row.output),
    citations: jsonParse<Citation[]>(row.citations, []),
    usedLlm: num(row.used_llm) === 1,
    error: strOrNull(row.error),
    usage: jsonParse<Record<string, unknown>>(row.usage, {}),
  };
}

export function listPlayRuns(options: { playId?: string; limit?: number } = {}): PlayRun[] {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
  if (options.playId) {
    return all<Record<string, unknown>>(
      getDb(),
      "SELECT * FROM play_runs WHERE play_id = ? ORDER BY started_at DESC LIMIT ?",
      [options.playId, limit],
    ).map(mapPlayRun);
  }
  return all<Record<string, unknown>>(
    getDb(),
    "SELECT * FROM play_runs ORDER BY started_at DESC LIMIT ?",
    [limit],
  ).map(mapPlayRun);
}

export function getPlayRun(id: string): PlayRun | null {
  const row = get<Record<string, unknown>>(getDb(), "SELECT * FROM play_runs WHERE id = ?", [id]);
  return row ? mapPlayRun(row) : null;
}
