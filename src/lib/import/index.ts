/**
 * Bulk-import layer entry point.
 *
 * Importing this module registers the built-in importers, so callers can go
 * straight to `getImporterFor(filename)` and stream items from `parse()`.
 */

import { sha256Hex } from "../core/ids";
import { toIso } from "../core/time";
import { extensionOf } from "../extract/text";
import { icsImporter } from "./ics";
import { mboxImporter } from "./mbox";
import { notionZipImporter } from "./notion_zip";
import { parseRfc822 } from "./rfc822";
import { slackZipImporter } from "./slack_zip";
import type { ImportedItem, Importer, ImporterInput } from "./types";

const importers: Importer[] = [];

/** Registers (or replaces, by id) one importer. */
export function registerImporter(importer: Importer): void {
  const index = importers.findIndex((existing) => existing.id === importer.id);
  if (index === -1) importers.push(importer);
  else importers[index] = importer;
}

/** Registered importers, in match order. */
export function listImporters(): Importer[] {
  return [...importers];
}

/**
 * First importer whose extensions include the file's extension.
 *
 * `.zip` is claimed by two importers (Slack, Notion) and resolves to the one
 * registered first — call `slackZipImporter.parse` / `notionZipImporter.parse`
 * directly when the caller knows which export it holds.
 */
export function getImporterFor(filename: string): Importer | null {
  const extension = extensionOf(filename);
  if (extension.length === 0) return null;
  for (const importer of importers) {
    if (importer.extensions.includes(extension)) return importer;
  }
  return null;
}

const emlImporter: Importer = {
  id: "eml",
  label: "Email message (.eml)",
  extensions: [".eml"],
  description: "A single RFC 822 message saved as .eml.",

  async *parse(input: ImporterInput): AsyncGenerator<ImportedItem, void, unknown> {
    if (input.limit !== undefined && input.limit <= 0) return;
    const message = parseRfc822(input.bytes);
    const subject = message.subject ?? input.filename;
    input.onProgress?.(subject, { items: 1 });
    yield {
      externalId: message.messageId ?? `eml:${sha256Hex(input.bytes)}`,
      title: subject,
      text: message.text,
      author: message.from,
      createdAt: toIso(message.date),
      updatedAt: null,
      mime: "message/rfc822",
      path: input.filename,
      meta: {
        to: message.to,
        cc: message.cc,
        headers: Object.keys(message.headers).length,
        attachments: message.attachments.map((attachment) => ({
          filename: attachment.filename,
          mime: attachment.mime,
          bytes: attachment.bytes.byteLength,
        })),
      },
    };
  },
};

registerImporter(emlImporter);
registerImporter(mboxImporter);
registerImporter(slackZipImporter);
registerImporter(notionZipImporter);
registerImporter(icsImporter);

export { emlImporter, icsImporter, mboxImporter, notionZipImporter, slackZipImporter, parseRfc822 };
export type { ImportedItem, Importer, ImporterInput, ParsedMessage } from "./types";
