import { createLogger } from "../core/logger";
import { daysAgoIso } from "../core/time";
import { truncate } from "../core/text";
import { getAiConfig } from "../ai/config";
import { chatComplete } from "../ai/provider";
import { buildPlayUserMessage, playInstruction } from "../ai/prompts";
import { listEvents } from "../db/repo/system";
import { getPlay, finishPlayRun, listPlays, startPlayRun } from "../db/repo/plays";
import { listDocuments, documentChunks, countDocuments } from "../db/repo/documents";
import { listNotes, listTags } from "../db/repo/notes";
import { topEntities, graphSnapshot } from "../ingest/enrich";
import { retrievePassages } from "../retrieval/hybrid";
import type { Citation, Play, PlayRun } from "../types/domain";

const logger = createLogger("plays");

export type PlayDeps = {
  fetchImpl?: typeof fetch;
  now?: Date;
};

export type PlayRunOutcome = {
  run: PlayRun;
  citations: Citation[];
  usedLlm: boolean;
  output: string;
};

// Cues that something is still open. The Vietnamese words are functional, not
// copy: they are how the play spots an unfinished task in Vietnamese notes.
const OPEN_LOOP_PATTERNS = [
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\bACTION\b/i,
  /\bdeadline\b/i,
  /\bdue\b/i,
  /\bcần\b/i,
  /\bphải\b/i,
  /\bchờ\b/i,
  /\bchưa\b/i,
  /\bfollow[- ]?up\b/i,
];

function section(title: string, body: string[]): string {
  if (body.length === 0) return `### ${title}\n_No data in this time range._`;
  return `### ${title}\n${body.join("\n")}`;
}

function documentLine(index: number, title: string, sourceId: string, at: string | null, extra = ""): string {
  const when = at ? at.slice(0, 10) : "date unknown";
  return `${index}. **${truncate(title, 110)}** — \`${sourceId}\` · ${when}${extra ? ` · ${extra}` : ""}`;
}

/** Deterministic digest used when no model is configured (and as an LLM fallback). */
function buildDigestMarkdown(play: Play, data: DigestData): string {
  const header = `## ${play.name}\n_Range: ${data.since.slice(0, 10)} → ${data.until.slice(0, 10)} · ${data.documents.length} documents · ${data.notes.length} notes_`;
  const parts = [header];

  if (play.kind === "open_loops") {
    parts.push(section("Open loops", data.openLoops));
  } else if (play.kind === "find_file") {
    parts.push(section("Best matching documents", data.topHits));
  } else if (play.kind === "topic_dossier") {
    parts.push(section("Timeline", data.timeline));
  } else if (play.kind === "meeting_brief") {
    parts.push(section("Related documents", data.topHits));
    parts.push(section("Recent activity", data.recentDialogue));
  } else {
    parts.push(section("New documents", data.documentLines));
    parts.push(section("Updated notes", data.noteLines));
  }

  if (data.entityLines.length > 0) parts.push(section("Notable people / topics", data.entityLines));
  if (data.sourceLines.length > 0) parts.push(section("Breakdown by source", data.sourceLines));
  parts.push(`\n> This round-up is generated without a model (keyword mode). Configure a model in **Settings** for analysis.`);
  return parts.join("\n\n");
}

type DigestData = {
  since: string;
  until: string;
  documents: { id: string; title: string; sourceId: string; at: string | null }[];
  notes: { id: string; title: string; updatedAt: string | null }[];
  documentLines: string[];
  noteLines: string[];
  entityLines: string[];
  sourceLines: string[];
  openLoops: string[];
  topHits: string[];
  timeline: string[];
  recentDialogue: string[];
};

async function gatherData(
  play: Play,
  params: Record<string, unknown>,
  deps: PlayDeps,
): Promise<DigestData> {
  const now = deps.now ?? new Date();
  const days = Number(params.days ?? play.params.days ?? 7);
  const since = Number.isFinite(days) && days > 0 ? daysAgoIso(days, now) : daysAgoIso(7, now);
  const until = now.toISOString();

  const { items: documents } = listDocuments({ since, until, limit: 200, orderBy: "created", includeDeleted: false });
  const notesResult = listNotes({ limit: 50 });
  const notes = notesResult.items
    .filter((item) => (item.document.updatedAt ?? item.document.ingestedAt) >= since)
    .map((item) => ({ id: item.document.id, title: item.document.title, updatedAt: item.document.updatedAt }));

  const entityLines = topEntities(12)
    .filter((entity) => entity.type === "person" || entity.type === "topic")
    .slice(0, 8)
    .map((entity) => `- **${entity.name}** (${entity.type}) · ${entity.mentions} mentions`);

  const sourceCounts = new Map<string, number>();
  for (const doc of documents) sourceCounts.set(doc.sourceId, (sourceCounts.get(doc.sourceId) ?? 0) + 1);
  const sourceLines = Array.from(sourceCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([sourceId, count]) => `- \`${sourceId}\`: ${count}`);

  const documentLines = documents
    .slice(0, 40)
    .map((doc, index) => documentLine(index + 1, doc.title, doc.sourceId, doc.createdAt ?? doc.ingestedAt));
  const noteLines = notes
    .slice(0, 25)
    .map((note, index) => documentLine(index + 1, note.title, "note", note.updatedAt));

  const query =
    typeof params.query === "string" && params.query.trim().length > 0
      ? params.query
      : typeof params.topic === "string" && params.topic.trim().length > 0
        ? params.topic
        : play.kind === "topic_dossier"
          ? ""
          : "";

  const topHits: string[] = [];
  const timeline: string[] = [];
  if (query.length > 0) {
    const retrieved = await retrievePassages(query, { limit: 12 });
    retrieved.citations.forEach((citation) => {
      topHits.push(
        `${citation.index}. **${truncate(citation.title, 120)}** — \`${citation.sourceId}\` · ${citation.createdAt?.slice(0, 10) ?? "?"}\n   > ${truncate(citation.snippet.replace(/\s+/g, " "), 200)}`,
      );
    });
    const { items: matching } = listDocuments({ limit: 200, orderBy: "created" });
    void matching;
    timeline.push(...topHits);
  }

  const openLoops: string[] = [];
  if (play.kind === "open_loops") {
    const scanned = listDocuments({ since, until, limit: 120, orderBy: "created" });
    for (const doc of scanned.items) {
      const chunks = documentChunks(doc.id).slice(0, 20);
      for (const chunk of chunks) {
        for (const line of chunk.text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length < 8 || trimmed.length > 400) continue;
          if (OPEN_LOOP_PATTERNS.some((pattern) => pattern.test(trimmed))) {
            openLoops.push(`- ${truncate(trimmed, 220)} — _${truncate(doc.title, 60)}_ (${doc.sourceId})`);
            break;
          }
        }
        if (openLoops.length >= 40) break;
      }
      if (openLoops.length >= 40) break;
    }
  }

  const events = listEvents({ since, limit: 30 });
  const recentDialogue = events
    .slice(0, 20)
    .map((event) => `- ${event.at.slice(0, 16).replace("T", " ")} · ${event.title}`);

  return {
    since,
    until,
    documents: documents.map((doc) => ({
      id: doc.id,
      title: doc.title,
      sourceId: doc.sourceId,
      at: doc.createdAt ?? doc.ingestedAt,
    })),
    notes,
    documentLines,
    noteLines,
    entityLines,
    sourceLines,
    openLoops,
    topHits,
    timeline,
    recentDialogue,
  };
}

/** Runs one play end to end: gather → (optional) model synthesis → persist. */
export async function runPlay(
  playId: string,
  params: Record<string, unknown> = {},
  deps: PlayDeps = {},
): Promise<PlayRunOutcome> {
  const play = getPlay(playId);
  if (!play) throw new Error(`Play ${playId} not found`);
  const mergedParams = { ...play.params, ...params };
  const runId = startPlayRun(play, mergedParams);
  const config = getAiConfig();

  try {
    const data = await gatherData(play, mergedParams, deps);
    const deterministic = buildDigestMarkdown(play, data);
    let output = deterministic;
    let usedLlm = false;
    let usage: Record<string, unknown> = { mode: "deterministic" };
    let citations: Citation[] = [];

    if (data.topHits.length > 0) {
      const retrieved = await retrievePassages(
        typeof mergedParams.query === "string" && mergedParams.query.trim().length > 0
          ? mergedParams.query
          : typeof mergedParams.topic === "string"
            ? mergedParams.topic
            : play.name,
        { limit: config.contextChunks },
      );
      citations = retrieved.citations;
    }

    if (config.configured && play.usesLlm) {
      try {
        const result = await chatComplete(
          [
            { role: "system", content: "You turn a personal memory into a Markdown report in the language of the request, with [n] citations." },
            {
              role: "user",
              content: buildPlayUserMessage({
                instruction: playInstruction(play.kind, mergedParams),
                context: data.topHits.length > 0 ? data.topHits.join("\n") : deterministic,
                params: mergedParams,
              }),
            },
          ],
          deps.fetchImpl ? { fetchImpl: deps.fetchImpl, config } : { config },
        );
        if (result.content.trim().length > 0) {
          output = result.content.trim();
          usedLlm = true;
          usage = { mode: "llm", model: result.model, ...result.usage };
        }
      } catch (error) {
        logger.warn("play model synthesis failed; keeping deterministic output", {
          playId,
          error: error instanceof Error ? error.message : String(error),
        });
        output = `${deterministic}\n\n> Model error: ${error instanceof Error ? error.message : String(error)}`;
        usage = { mode: "deterministic-fallback" };
      }
    }

    finishPlayRun(runId, { status: "ok", output, citations, usedLlm, usage });
    const run = {
      id: runId,
      playId: play.id,
      playName: play.name,
      startedAt: nowIsoFallback(),
      finishedAt: nowIsoFallback(),
      status: "ok" as const,
      params: mergedParams,
      output,
      citations,
      usedLlm,
      error: null,
      usage,
    };
    return { run, citations, usedLlm, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishPlayRun(runId, { status: "error", output: "", citations: [], usedLlm: false, error: message });
    throw error;
  }
}

function nowIsoFallback(): string {
  return new Date().toISOString();
}

export function playSchedules(): { play: Play; nextHint: string }[] {
  return listPlays().map((play) => ({
    play,
    nextHint: play.schedule ? `cron: ${play.schedule}` : "manual run",
  }));
}

export function memoryDigest(days = 7): string {
  const since = daysAgoIso(days);
  const stats = {
    documents: countDocuments(),
    tags: listTags().length,
    events: listEvents({ kinds: ["document.ingested", "document.updated"], since, limit: 200 }).length,
    entities: topEntities(10).length,
    graph: graphSnapshot(20).nodes.length,
  };
  const lines = [
    `# Memory ${since.slice(0, 10)} → ${new Date().toISOString().slice(0, 10)}`,
    `- Documents: **${stats.documents}**`,
    `- New events: **${stats.events}**`,
    `- Tags: **${stats.tags}**`,
    `- Entities: **${stats.entities}** (graph: ${stats.graph} nodes)`,
  ];
  return lines.join("\n");
}
