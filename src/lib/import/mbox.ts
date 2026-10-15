/**
 * mbox importer: one `ImportedItem` per message.
 *
 * Messages are separated by lines starting with `From ` (the mbox author
 * line); `>From ` escaping (mboxrd) is undone before parsing. Each message is
 * handed to the RFC 822 parser, so MIME bodies, encoded headers and
 * attachments are handled the same way as a single `.eml` file.
 */

import { sha256Hex } from "../core/ids";
import { toIso } from "../core/time";
import { parseRfc822 } from "./rfc822";
import type { ImportedItem, Importer, ImporterInput } from "./types";

const ENVELOPE_LINE = /^From /;

/** Splits raw mbox text into single-message strings, unescaping `>From `. */
export function splitMbox(raw: string): string[] {
  const messages: string[][] = [];
  let current: string[] | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (line === "From" || ENVELOPE_LINE.test(line)) {
      if (current !== null) messages.push(current);
      current = [];
      continue;
    }
    if (current === null) continue; // text before the first envelope line
    current.push(/^>+From /.test(line) ? line.slice(1) : line);
  }
  if (current !== null) messages.push(current);

  const split = messages
    .map((lines) => lines.join("\n"))
    .filter((message) => message.trim().length > 0);
  // No envelope line at all: treat the input as a single message.
  return split.length > 0 ? split : raw.trim().length > 0 ? [raw] : [];
}

function envelopeIndexedId(filename: string, index: number): string {
  return `mbox:${sha256Hex(`${filename}:${index}`)}`;
}

export const mboxImporter: Importer = {
  id: "mbox",
  label: "mbox mailbox",
  extensions: [".mbox", ".mbx"],
  description: "Mailbox files with one or more RFC 822 messages (Thunderbird, Gmail takeout).",

  async *parse(input: ImporterInput): AsyncGenerator<ImportedItem, void, unknown> {
    const raw = Buffer.from(input.bytes).toString("latin1");
    const messages = splitMbox(raw);
    const limit = input.limit ?? Number.POSITIVE_INFINITY;

    for (let index = 0; index < messages.length && index < limit; index += 1) {
      const message = messages[index];
      if (message === undefined) continue;
      const parsed = parseRfc822(new Uint8Array(Buffer.from(message, "latin1")));
      const subject = parsed.subject ?? "(no subject)";
      const envelope: string[] = [];
      if (parsed.from !== null) envelope.push(`From: ${parsed.from}`);
      if (parsed.to !== null) envelope.push(`To: ${parsed.to}`);
      if (parsed.date !== null) envelope.push(`Date: ${parsed.date}`);
      const text = envelope.length > 0 ? `${parsed.text}\n\n${envelope.join("\n")}`.trim() : parsed.text;

      input.onProgress?.(`message ${index + 1}/${messages.length}`, { subject });

      yield {
        externalId: parsed.messageId ?? envelopeIndexedId(input.filename, index),
        title: subject,
        text,
        author: parsed.from,
        createdAt: toIso(parsed.date),
        updatedAt: null,
        mime: "message/rfc822",
        path: input.filename,
        meta: {
          index,
          headerCount: Object.keys(parsed.headers).length,
          attachments: parsed.attachments.map((attachment) => attachment.filename),
        },
      };
    }
  },
};
