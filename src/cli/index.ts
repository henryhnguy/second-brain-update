/**
 * `npm run cli -- <command>` — the same core the API uses, without HTTP.
 *
 * Commands:
 *   health | stats
 *   search <query> [--mode hybrid|keyword|semantic] [--limit N] [--source id] [--tag slug]
 *   add [--title T] [--tags a,b] [--file path] [text]
 *   ingest file <paths...> | url <url> | folder <root> [--force] | list <manifest.json> | importer <paths...>
 *   sync [--provider id] [--connector id] [--max-items N]
 *   index [--limit N]            backfill embeddings for chunks that lack them
 *   play list | play run <playId> [--param key=value]
 *   map [--docs N]                print the memory map
 *   review [--days N] [--json]    knowledge hygiene report
 *   distill <id>|--filter <path>  one-pagers, single or batch
 *   meta infer [--dry-run]        infer code/version/date from titles
 *   studio lesson|slides|mindmap  build teaching material from sources
 *   export [--out file.json] [--limit N]
 *   jobs [--process N]
 *   doctor                        capabilities, data paths, embedding coverage
 */

import fs from "node:fs";
import path from "node:path";

import { publicAiConfig } from "../lib/ai/config";
import { chatConfigured } from "../lib/ai/chat-provider";
import { backfillEmbeddings, embeddingStatus } from "../lib/ai/embeddings";
import { answer } from "../lib/ai/chat";
import { dbCapabilities, dataPaths, lastMigrationReport } from "../lib/db/connection";
import { buildStats, documentChunks, listDocuments } from "../lib/db/repo/documents";
import { listConnectors } from "../lib/connectors/store";
import { listPlayRuns, listPlays } from "../lib/db/repo/plays";
import { syncConnector, syncEnabledConnectors } from "../lib/connectors/runner";
import { processJobsOnce } from "../lib/jobs/worker";
import { ingestFile, ingestText, ingestUrl } from "../lib/ingest/pipeline";
import { syncFolder } from "../lib/ingest/folder";
import { runPlay } from "../lib/plays/engine";
import {
  buildHealthReport,
  buildMasterIndex,
  distillDocument,
  renderIndexMarkdown,
  renderReviewMarkdown,
} from "../lib/curator";
import { applyInferredMetadata } from "../lib/curator/metadata";
import { getArtifact, listArtifacts } from "../lib/db/repo/artifacts";
import { generateArtifact } from "../lib/studio";
import { slidesToMarp } from "../lib/studio/format";
import { mindmapToSvg } from "../lib/studio/mindmap";
import type { DistillTemplateId } from "../lib/curator";
import { search } from "../lib/retrieval/hybrid";
import { getImporterFor } from "../lib/import";

type Args = { _: string[]; flags: Record<string, string | boolean> };

function parseArgs(argv: string[]): Args {
  const result: Args = { _: [], flags: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        result.flags[key] = true;
      } else {
        result.flags[key] = next;
        index += 1;
      }
      continue;
    }
    result._.push(arg);
  }
  return result;
}

function out(value: unknown): void {
  if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function num(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tags(value: string | boolean | undefined): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const [command, sub] = args._;

  switch (command) {
    case undefined:
    case "help": {
      console.log(
        [
          "second-brain CLI",
          "",
          "  health | stats",
          "  search <query> [--mode hybrid|keyword|semantic] [--limit N] [--source id] [--tag slug]",
          "  add [--title T] [--tags a,b] [--file path] [text]",
          "  ingest file <paths...> | url <url> | folder <root> [--force] | list <manifest.json> | importer <paths...>",
          "  sync [--provider id] [--connector id] [--max-items N]",
          "  index [--limit N]",
          "  play list | play run <playId> [--param key=value]",
          "  map [--docs N]                print the memory map (shelves + coverage)",
          "  review [--days N] [--json]    knowledge hygiene report",
          "  distill <documentId>|--filter <path> [--template generic|guideline|project|meeting|decision] [--lang en|vi] [--preview]",
          "  meta infer [--dry-run] [--overwrite]   infer code/version/date from titles",
          "  studio lesson|slides|mindmap [--docs id,id | --filter path | --query q] [--limit N] [--max-slides N] [--lang en|vi] [--no-llm]",
          "  studio list | studio show <id> | studio export <id> [--out file]",
          "  export [--out file.json] [--limit N]",
          "  jobs [--process N]",
          "  doctor",
        ].join("\n"),
      );
      return 0;
    }

    case "health": {
      const capabilities = dbCapabilities();
      out({
        ok: true,
        node: process.version,
        sqlite: capabilities.sqliteVersion,
        fts5: capabilities.fts5,
        trigram: capabilities.trigram,
        ai: publicAiConfig(),
        data: dataPaths(),
        migrations: lastMigrationReport(),
      });
      return 0;
    }

    case "doctor": {
      const capabilities = dbCapabilities();
      const stats = buildStats(chatConfigured());
      out({
        capabilities,
        data: dataPaths(),
        stats,
        embeddings: embeddingStatus(),
        ai: publicAiConfig(),
        hint: capabilities.trigram ? undefined : "trigram index unavailable; fuzzy matching limited",
      });
      return 0;
    }

    case "stats": {
      out(buildStats(chatConfigured()));
      return 0;
    }

    case "search": {
      const query = args._[1] ?? "";
      if (query.length === 0) {
        console.error("usage: search <query>");
        return 2;
      }
      const response = await search({
        query,
        mode: (args.flags.mode as "hybrid" | "keyword" | "semantic") ?? "hybrid",
        limit: num(args.flags.limit, 10),
        filters: {
          ...(typeof args.flags.source === "string" ? { sourceIds: [args.flags.source] } : {}),
          ...(typeof args.flags.tag === "string" ? { tags: [args.flags.tag] } : {}),
        },
      });
      console.log(`${response.total} results in ${response.tookMs}ms (mode ${response.mode}, semantic=${response.semanticAvailable})`);
      for (const hit of response.hits) {
        console.log(`\n${hit.score.toFixed(3)}  ${hit.title}`);
        console.log(`       ${hit.sourceId}${hit.createdAt ? ` · ${hit.createdAt.slice(0, 10)}` : ""} · ${hit.documentId}`);
        console.log(`       ${hit.snippet.slice(0, 200)}`);
      }
      return 0;
    }

    case "ask": {
      const question = args._.slice(1).join(" ");
      if (question.length === 0) {
        console.error("usage: ask <question>");
        return 2;
      }
      const result = await answer({ message: question, scope: { mode: "all" } });
      console.log(result.content);
      if (result.citations.length > 0) {
        console.log("\nSources:");
        for (const citation of result.citations) {
          console.log(`  [${citation.index}] ${citation.title} — ${citation.sourceId}`);
        }
      }
      return 0;
    }

    case "add": {
      let text = args._.slice(1).join(" ");
      if (typeof args.flags.file === "string") text = fs.readFileSync(args.flags.file, "utf8");
      if (text.trim().length === 0) {
        console.error("usage: add [--title T] [--tags a,b] [--file path] <text>");
        return 2;
      }
      const result = ingestText({
        text,
        title: typeof args.flags.title === "string" ? args.flags.title : "",
        sourceKind: "note",
        sourceId: "note",
        tags: tags(args.flags.tags),
      });
      out(result);
      return result.status === "failed" ? 1 : 0;
    }

    case "ingest": {
      const paths = args._.slice(2);
      if (sub === "file" || sub === "files") {
        if (paths.length === 0) {
          console.error("usage: ingest file <paths...>");
          return 2;
        }
        const results = [];
        for (const file of paths) {
          const bytes = new Uint8Array(fs.readFileSync(file));
          results.push(await ingestFile({ bytes, filename: path.basename(file), sourceId: "cli", sourceKind: "upload" }));
        }
        out(results);
        return results.some((result) => result.status === "failed") ? 1 : 0;
      }
      if (sub === "url") {
        const url = paths[0];
        if (!url) {
          console.error("usage: ingest url <url>");
          return 2;
        }
        out(await ingestUrl({ url }));
        return 0;
      }
      if (sub === "folder") {
        const root = paths[0];
        if (!root) {
          console.error("usage: ingest folder <root> [--force]");
          return 2;
        }
        const report = await syncFolder({ root, force: args.flags.force === true });
        out({
          root: report.root,
          scanned: report.scanned,
          ingested: report.ingested,
          updated: report.updated,
          skipped: report.skipped,
          failed: report.failed,
          removed: report.removed,
          tookMs: report.tookMs,
        });
        return report.failed > 0 ? 1 : 0;
      }
      if (sub === "list") {
        const manifestPath = paths[0];
        if (!manifestPath) {
          console.error("usage: ingest list <manifest.json> [--force] [--keep]");
          return 2;
        }
        const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
        const entries = (Array.isArray(raw) ? raw : ((raw as { files?: unknown[] }).files ?? [])) as {
          path?: string;
          sourceId?: string;
          externalId?: string;
          title?: string;
          meta?: Record<string, unknown>;
        }[];
        let created = 0;
        let updated = 0;
        let failed = 0;
        const failures: { file: string; error: string }[] = [];
        for (const entry of entries) {
          if (!entry.path) continue;
          try {
            const bytes = new Uint8Array(fs.readFileSync(entry.path));
            const result = await ingestFile({
              bytes,
              filename: path.basename(entry.path),
              sourceId: entry.sourceId ?? `manifest:${path.basename(path.dirname(manifestPath))}`,
              sourceKind: "folder",
              externalId: entry.externalId ?? entry.path,
              path: entry.path,
              title: entry.title,
              meta: entry.meta,
              keepOriginal: args.flags.keep === true,
              force: args.flags.force === true,
            });
            if (result.status === "created") created += 1;
            else if (result.status === "updated") updated += 1;
            else if (result.status === "failed") {
              failed += 1;
              failures.push({ file: entry.path, error: result.error ?? "failed" });
            }
            console.log(`${result.status.toUpperCase()}  ${entry.title ?? path.basename(entry.path)}`);
          } catch (error) {
            failed += 1;
            failures.push({ file: entry.path, error: error instanceof Error ? error.message : String(error) });
          }
        }
        out({ total: entries.length, created, updated, failed, failures: failures.slice(0, 20) });
        return failed > 0 ? 1 : 0;
      }
      if (sub === "importer") {
        if (paths.length === 0) {
          console.error("usage: ingest importer <paths...>");
          return 2;
        }
        const summaries = [];
        for (const file of paths) {
          const importer = getImporterFor(file);
          if (!importer) {
            summaries.push({ file, error: "unsupported format" });
            continue;
          }
          const bytes = new Uint8Array(fs.readFileSync(file));
          let added = 0;
          let updated = 0;
          for await (const item of importer.parse({ bytes, filename: path.basename(file) })) {
            const result = ingestText({
              text: item.text,
              title: item.title,
              sourceKind: "importer",
              sourceId: importer.id,
              externalId: item.externalId,
              createdAt: item.createdAt ?? null,
              updatedAt: item.updatedAt ?? null,
              url: item.url ?? null,
              author: item.author ?? null,
            });
            if (result.status === "created") added += 1;
            else if (result.status === "updated") updated += 1;
          }
          summaries.push({ file, importer: importer.id, added, updated });
        }
        out(summaries);
        return 0;
      }
      console.error(`unknown ingest source: ${sub ?? "(none)"}`);
      return 2;
    }

    case "sync": {
      if (typeof args.flags.connector === "string") {
        out(await syncConnector(args.flags.connector, { maxItems: num(args.flags["max-items"], 200) }));
        return 0;
      }
      const connectors = listConnectors().filter(
        (connector) =>
          (typeof args.flags.provider !== "string" || connector.provider === args.flags.provider) &&
          connector.hasCredentials,
      );
      if (connectors.length === 0) {
        console.log("No connector is connected yet. Run `health`, or open the Connectors page in the app.");
        return 0;
      }
      out(await syncEnabledConnectors({ maxItems: num(args.flags["max-items"], 120) }));
      return 0;
    }

    case "index": {
      const report = await backfillEmbeddings({ limit: num(args.flags.limit, 400) });
      out(report);
      return 0;
    }

    case "play": {
      if (sub === "list" || sub === undefined) {
        out(listPlays().map((play) => ({ id: play.id, name: play.name, kind: play.kind, enabled: play.enabled, schedule: play.schedule })));
        return 0;
      }
      if (sub === "run") {
        const playId = args._[2];
        if (!playId) {
          console.error("usage: play run <playId> [--param key=value]");
          return 2;
        }
        const params: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(args.flags)) {
          if (key === "param" && typeof value === "string") {
            const [paramKey, paramValue] = value.split("=");
            if (paramKey) params[paramKey] = paramValue ?? "";
          }
        }
        const outcome = await runPlay(playId, params);
        console.log(outcome.output);
        console.log(`\n(${outcome.usedLlm ? "with model" : "without model"} · ${outcome.citations.length} citations)`);
        return 0;
      }
      if (sub === "runs") {
        out(listPlayRuns({ limit: num(args.flags.limit, 10) }));
        return 0;
      }
      console.error(`unknown play subcommand: ${sub}`);
      return 2;
    }

    case "map": {
      console.log(renderIndexMarkdown(buildMasterIndex({ docsPerShelf: num(args.flags.docs, 3) })));
      return 0;
    }

    case "review": {
      const report = buildHealthReport({ days: num(args.flags.days, 180) });
      if (args.flags.json === true) out(report);
      else console.log(renderReviewMarkdown(report, args.flags.lang === "vi" ? "vi" : "en"));
      return report.totals.bySeverity.high > 0 ? 1 : 0;
    }

    case "distill": {
      const documentId = args._[1];
      const filter = typeof args.flags.filter === "string" ? args.flags.filter : null;
      const template = typeof args.flags.template === "string" ? (args.flags.template as DistillTemplateId) : undefined;
      const lang = args.flags.lang === "vi" ? "vi" : "en";
      const save = args.flags.preview !== true;

      if (!documentId && !filter) {
        console.error(
          "usage: distill <documentId>|--filter <path substring> [--template generic|guideline|project|meeting|decision] [--lang en|vi] [--preview] [--limit N]",
        );
        return 2;
      }

      if (filter) {
        const { items } = listDocuments({ limit: 500, orderBy: "title" });
        const matches = items.filter(
          (doc) =>
            (doc.path ?? "").includes(filter) || doc.title.includes(filter) || doc.sourceId.includes(filter),
        );
        const limit = num(args.flags.limit, matches.length);
        let saved = 0;
        let failed = 0;
        for (const doc of matches.slice(0, limit)) {
          try {
            const result = await distillDocument({ documentId: doc.id, template, lang, save });
            saved += result.noteId ? 1 : 0;
            console.log(`OK   ${doc.title}${result.updated ? " (updated)" : ""}`);
          } catch (error) {
            failed += 1;
            console.log(`FAIL ${doc.title} — ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        console.log(`\n${matches.slice(0, limit).length} matched · ${saved} saved · ${failed} failed`);
        return failed > 0 ? 1 : 0;
      }

      const result = await distillDocument({ documentId: documentId as string, template, lang, save });
      console.log(result.markdown);
      if (result.noteId) {
        console.log(`\n(saved as note ${result.noteId}${result.updated ? " · updated" : ""})`);
      }
      return 0;
    }

    case "meta": {
      if (sub === "infer" || sub === undefined) {
        const report = applyInferredMetadata({
          dryRun: args.flags["dry-run"] === true,
          overwrite: args.flags.overwrite === true,
          limit: num(args.flags.limit, 10_000),
        });
        out(report);
        return 0;
      }
      console.error("usage: meta infer [--dry-run] [--overwrite] [--limit N]");
      return 2;
    }

    case "studio": {
      if (sub === "list") {
        out(
          listArtifacts({ limit: num(args.flags.limit, 20) }).map((artifact) => ({
            id: artifact.id,
            kind: artifact.kind,
            title: artifact.title,
            sources: artifact.documentIds.length,
            usedLlm: artifact.usedLlm,
            createdAt: artifact.createdAt,
          })),
        );
        return 0;
      }

      if (sub === "show" || sub === "export") {
        const artifactId = args._[2];
        if (!artifactId) {
          console.error(`usage: studio ${sub} <artifactId>${sub === "export" ? " [--out file]" : ""}`);
          return 2;
        }
        const artifact = getArtifact(artifactId);
        if (!artifact) {
          console.error(`artifact not found: ${artifactId}`);
          return 1;
        }
        if (sub === "export") {
          if (typeof args.flags.out !== "string") {
            console.error("usage: studio export <artifactId> --out <file>");
            return 2;
          }
          const content =
            artifact.kind === "slides"
              ? slidesToMarp(artifact.slides, artifact.title)
              : artifact.kind === "mindmap" && artifact.mindmap
                ? mindmapToSvg(artifact.mindmap, artifact.title)
                : artifact.markdown;
          fs.writeFileSync(args.flags.out, content, "utf8");
          console.log(`Wrote ${artifact.kind} to ${args.flags.out}`);
          return 0;
        }
        console.log(artifact.markdown);
        console.log(`\n(id ${artifact.id} · ${artifact.kind} · ${artifact.citations.length} sources · ${artifact.usedLlm ? "model" : "no model"})`);
        return 0;
      }

      if (sub === "lesson" || sub === "slides" || sub === "mindmap") {
        const docs = typeof args.flags.docs === "string" ? args.flags.docs.split(",").map((id) => id.trim()).filter(Boolean) : [];
        let documentIds = docs;
        if (documentIds.length === 0 && typeof args.flags.filter === "string") {
          const filter = args.flags.filter;
          documentIds = listDocuments({ limit: 500, orderBy: "title" })
            .items.filter(
              (doc) => (doc.path ?? "").includes(filter) || doc.title.includes(filter) || doc.sourceId.includes(filter),
            )
            .map((doc) => doc.id);
        }
        if (documentIds.length === 0 && typeof args.flags.query !== "string") {
          console.error(
            "usage: studio lesson|slides|mindmap --docs id1,id2 | --filter <path substring> | --query <search> [--limit N]",
          );
          return 2;
        }
        const artifact = await generateArtifact({
          kind: sub,
          ...(documentIds.length > 0 ? { documentIds } : {}),
          ...(typeof args.flags.query === "string" ? { query: args.flags.query } : {}),
          limit: num(args.flags.limit, 8),
          maxSlides: num(args.flags["max-slides"], 10),
          lang: args.flags.lang === "vi" ? "vi" : "en",
          useLlm: args.flags["no-llm"] !== true,
          ...(typeof args.flags.title === "string" ? { title: args.flags.title } : {}),
        });
        console.log(artifact.markdown);
        console.log(
          `\n(${artifact.kind} ${artifact.id} · ${artifact.citations.length} sources · ${artifact.usedLlm ? "with model" : "without model"})`,
        );
        return 0;
      }

      console.error("usage: studio lesson|slides|mindmap | studio list | studio show <id> | studio export <id> --out <file>");
      return 2;
    }

    case "export": {
      const limit = num(args.flags.limit, 500);
      const { items } = listDocuments({ limit, orderBy: "created" });
      const payload = {
        exportedAt: new Date().toISOString(),
        count: items.length,
        documents: items.map((doc) => ({
          id: doc.id,
          title: doc.title,
          sourceKind: doc.sourceKind,
          sourceId: doc.sourceId,
          url: doc.url,
          path: doc.path,
          createdAt: doc.createdAt,
          body: documentChunks(doc.id)
            .map((chunk) => chunk.text)
            .join("\n\n"),
        })),
      };
      if (typeof args.flags.out === "string") {
        fs.writeFileSync(args.flags.out, JSON.stringify(payload, null, 2), "utf8");
        console.log(`Wrote ${payload.count} documents to ${args.flags.out}`);
      } else {
        console.log(JSON.stringify(payload, null, 2));
      }
      return 0;
    }

    case "jobs": {
      const summary = await processJobsOnce(num(args.flags.process, 5));
      out(summary);
      return summary.failed > 0 ? 1 : 0;
    }

    default:
      console.error(`unknown command: ${command}`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
