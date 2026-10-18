/**
 * OOXML extractors — `.xlsx` and `.pptx` are ZIP archives of XML, so the text
 * can be recovered without a spreadsheet or presentation library: shared
 * strings and cell values for workbooks, `<a:t>` runs for slides.
 *
 * The output is deliberately plain: one line per row (`A | B | C`) and one
 * section per sheet or slide, which is what the chunker and the search index
 * need. Formulas are reported by their cached value; styling is ignored.
 */

import type { AdmZipApi } from "../import/adm-zip";
import type { ExtractedDoc, Extractor, ExtractInput } from "./types";

let zipLoader: Promise<AdmZipApi> | null = null;

function loadZip(): Promise<AdmZipApi> {
  if (!zipLoader) {
    zipLoader = import("../import/adm-zip").then((module) => module.loadAdmZip());
  }
  return zipLoader;
}

const MAX_CHARS = 400_000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function stripTags(value: string): string {
  return decodeXml(value.replace(/<[^>]+>/g, ""));
}

function tidy(lines: string[]): string[] {
  return lines.map((line) => line.replace(/[ \t]+/g, " ").trim()).filter((line) => line.length > 0);
}

function limit(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_CHARS), truncated: true };
}

/* ------------------------------------------------------------------ xlsx */

type SheetRef = { name: string; target: string };

function sheetRefs(entries: Map<string, string>): SheetRef[] {
  const workbook = entries.get("xl/workbook.xml") ?? "";
  const rels = entries.get("xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    const id = match[1] ?? "";
    const target = (match[2] ?? "").replace(/^\/?xl\//, "");
    if (id && target) targets.set(id, target);
  }
  const refs: SheetRef[] = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attributes = match[1] ?? "";
    const name = /name="([^"]*)"/.exec(attributes)?.[1];
    const relationship = /r:id="([^"]+)"/.exec(attributes)?.[1];
    const target = relationship ? targets.get(relationship) : undefined;
    if (name && target) refs.push({ name: decodeXml(name), target: `xl/${target}` });
  }
  if (refs.length > 0) return refs;
  // No workbook part (some exporters omit it): fall back to file order.
  return Array.from(entries.keys())
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort()
    .map((name, index) => ({ name: `Sheet ${index + 1}`, target: name }));
}

function sharedStrings(xml: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const body = match[1] ?? "";
    const text = Array.from(body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
      .map((part) => decodeXml(part[1] ?? ""))
      .join("");
    values.push(text);
  }
  return values;
}

function cellValue(attributes: string, body: string, shared: string[]): string {
  const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? "";
  if (type === "inlineStr") {
    return Array.from(body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
      .map((part) => decodeXml(part[1] ?? ""))
      .join("");
  }
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
  if (raw.length === 0) return "";
  if (type === "s") {
    const index = Number.parseInt(raw, 10);
    return Number.isFinite(index) ? (shared[index] ?? "") : "";
  }
  if (type === "b") return raw === "1" ? "true" : "false";
  return decodeXml(raw);
}

async function extractXlsx(bytes: Uint8Array): Promise<ExtractedDoc> {
  const AdmZip = await loadZip();
  const zip = new AdmZip(Buffer.from(bytes));
  const entries = new Map<string, string>();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (!/\.(xml|rels)$/.test(entry.entryName)) continue;
    entries.set(entry.entryName.replace(/\\/g, "/"), entry.getData().toString("utf8"));
  }

  const shared = sharedStrings(entries.get("xl/sharedStrings.xml") ?? "");
  const sections: string[] = [];
  const sheetNames: string[] = [];

  for (const sheet of sheetRefs(entries)) {
    const xml = entries.get(sheet.target);
    if (!xml) continue;
    sheetNames.push(sheet.name);
    const lines: string[] = [`## Sheet: ${sheet.name}`];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attributes = cellMatch[1] ?? cellMatch[2] ?? "";
        const body = cellMatch[3] ?? "";
        cells.push(cellValue(attributes, body, shared));
      }
      const line = cells.join(" | ").replace(/\s+\|\s*$/, "").trim();
      if (line.length > 0 && line !== "|") lines.push(line);
    }
    if (lines.length > 1) sections.push(lines.join("\n"));
  }

  const text = limit(tidy(sections.join("\n\n").split("\n")).join("\n"));
  return {
    text: text.text,
    title: sheetNames[0] ?? null,
    meta: { sheets: sheetNames, truncated: text.truncated },
    warnings: text.truncated ? [`xlsx text truncated at ${MAX_CHARS} characters`] : [],
  };
}

/* ------------------------------------------------------------------ pptx */

async function extractPptx(bytes: Uint8Array): Promise<ExtractedDoc> {
  const AdmZip = await loadZip();
  const zip = new AdmZip(Buffer.from(bytes));
  const slides: { order: number; name: string; xml: string }[] = [];
  const notes = new Map<number, string>();

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, "/");
    const slide = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (slide) {
      slides.push({ order: Number(slide[1]), name, xml: entry.getData().toString("utf8") });
      continue;
    }
    const note = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(name);
    if (note) notes.set(Number(note[1]), entry.getData().toString("utf8"));
  }
  slides.sort((a, b) => a.order - b.order);

  const sections: string[] = [];
  let title: string | null = null;
  for (const slide of slides) {
    const runs = Array.from(slide.xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)).map((match) =>
      decodeXml(match[1] ?? "").trim(),
    );
    const lines = tidy(runs);
    if (lines.length === 0) continue;
    if (!title) title = lines[0] ?? null;
    const section = [`## Slide ${slide.order}`, ...lines].join("\n");
    sections.push(section);

    const noteXml = notes.get(slide.order);
    if (noteXml) {
      const noteText = tidy(
        Array.from(noteXml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)).map((match) => decodeXml(match[1] ?? "")),
      ).join(" ");
      if (noteText.length > 0) sections.push(`Notes: ${noteText}`);
    }
  }

  const text = limit(sections.join("\n\n"));
  return {
    text: text.text,
    title,
    meta: { slides: slides.length, truncated: text.truncated },
    warnings: slides.length === 0 ? ["pptx contains no slides"] : [],
  };
}

export const xlsxExtractor: Extractor = {
  id: "xlsx",
  label: "Excel workbook",
  extensions: [".xlsx", ".xlsm"],
  mimes: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
  ],
  heavy: true,
  async extract(input: ExtractInput): Promise<ExtractedDoc> {
    try {
      return await extractXlsx(input.bytes);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { text: "", title: null, meta: {}, warnings: [`xlsx extraction failed: ${reason}`] };
    }
  },
};

export const pptxExtractor: Extractor = {
  id: "pptx",
  label: "PowerPoint presentation",
  extensions: [".pptx"],
  mimes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  heavy: true,
  async extract(input: ExtractInput): Promise<ExtractedDoc> {
    try {
      return await extractPptx(input.bytes);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { text: "", title: null, meta: {}, warnings: [`pptx extraction failed: ${reason}`] };
    }
  },
};
