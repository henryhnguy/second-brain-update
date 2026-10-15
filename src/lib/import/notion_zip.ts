/**
 * Notion export importer.
 *
 * Notion exports a ZIP of markdown pages plus CSV databases. Each `.md` file
 * becomes one item (its in-zip path is the stable identity, the first H1 gives
 * the title) and each `.csv` file becomes one item holding the raw table text.
 */

import { decodeTextBytes, firstHeading, extensionOf } from "../extract/text";
import { loadAdmZip } from "./adm-zip";
import type { ImportedItem, Importer, ImporterInput } from "./types";

const SUPPORTED = new Set([".md", ".markdown", ".csv"]);

/** Resource forks and Finder metadata are not pages. */
function isNoise(entryName: string): boolean {
  if (entryName.startsWith("__MACOSX/") || entryName.includes("/__MACOSX/")) return true;
  const base = entryName.split("/").pop() ?? entryName;
  return base.startsWith("._") || base.startsWith(".");
}

function baseName(entryName: string): string {
  return entryName.split("/").pop() ?? entryName;
}

function titleFor(entryName: string, text: string, markdown: boolean): string {
  if (markdown) {
    const heading = firstHeading(text);
    if (heading !== null) return heading;
  }
  const base = baseName(entryName);
  const extension = extensionOf(base);
  return extension.length > 0 ? base.slice(0, base.length - extension.length) : base;
}

export const notionZipImporter: Importer = {
  id: "notion_zip",
  label: "Notion export (ZIP)",
  extensions: [".zip"],
  description: "Notion workspace export: markdown pages and CSV database files.",

  async *parse(input: ImporterInput): AsyncGenerator<ImportedItem, void, unknown> {
    const Zip = await loadAdmZip();
    const zip = new Zip(Buffer.from(input.bytes));
    const limit = input.limit ?? Number.POSITIVE_INFINITY;
    let produced = 0;

    for (const entry of zip.getEntries()) {
      if (produced >= limit) return;
      if (entry.isDirectory || isNoise(entry.entryName)) continue;

      const extension = extensionOf(entry.entryName);
      if (!SUPPORTED.has(extension)) continue;

      const bytes = new Uint8Array(entry.getData());
      const markdown = extension !== ".csv";
      const decoded = decodeTextBytes(bytes);
      const text = markdown ? decoded.text : decoded.text.replace(/\r\n?/g, "\n").trim();

      produced += 1;
      input.onProgress?.(entry.entryName, { items: produced });
      yield {
        externalId: entry.entryName,
        title: titleFor(entry.entryName, text, markdown),
        text,
        author: null,
        createdAt: null,
        updatedAt: null,
        mime: markdown ? "text/markdown" : "text/csv",
        path: entry.entryName,
        meta: {
          bytes: bytes.byteLength,
          format: markdown ? "markdown" : "csv",
          folder: entry.entryName.includes("/") ? (entry.entryName.split("/").slice(0, -1).join("/") || null) : null,
          encoding: decoded.encoding,
        },
      };
    }
  },
};
