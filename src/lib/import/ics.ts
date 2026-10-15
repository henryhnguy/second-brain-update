/**
 * iCalendar (ICS) importer: one item per VEVENT.
 *
 * Line folding is undone in byte space (a folded line may split a multi-byte
 * character) before the text is decoded, and properties nested inside a VEVENT
 * (VALARM, …) are skipped so only event-level data is read.
 */

import { sha256Hex } from "../core/ids";
import { decodeTextBytes } from "../extract/text";
import type { ImportedItem, Importer, ImporterInput } from "./types";

type Property = { name: string; params: Record<string, string>; value: string };

/** Removes CRLF + one whitespace byte, keeping the byte sequence intact. */
export function unfoldIcs(raw: string): string {
  return raw.replace(/\r?\n[ \t]/g, "");
}

function unescapeText(value: string): string {
  return value.replace(/\\(.)/g, (_match: string, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/** Splits `NAME;PARAM=VALUE:content` at the first colon outside quotes. */
function parseProperty(line: string): Property | null {
  let split = -1;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) {
      split = index;
      break;
    }
  }
  if (split <= 0) return null;

  const left = line.slice(0, split);
  const value = unescapeText(line.slice(split + 1));
  const segments = left.split(";");
  const name = (segments[0] ?? "").trim().toUpperCase();
  if (name.length === 0) return null;

  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const equals = segment.indexOf("=");
    if (equals <= 0) continue;
    params[segment.slice(0, equals).trim().toUpperCase()] = unquote(segment.slice(equals + 1).trim());
  }
  return { name, params, value };
}

function first(properties: Property[], name: string): Property | null {
  for (const property of properties) {
    if (property.name === name) return property;
  }
  return null;
}

function all(properties: Property[], name: string): Property[] {
  return properties.filter((property) => property.name === name);
}

type ParsedDate = { iso: string | null; allDay: boolean };

/** `YYYYMMDD`, `YYYYMMDDTHHMMSS` or `YYYYMMDDTHHMMSSZ` (floating read as UTC). */
export function parseIcsDate(value: string | null, isDateParam = false): ParsedDate {
  if (value === null) return { iso: null, allDay: false };
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (match === null) return { iso: null, allDay: false };

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const allDay = hourText === undefined || isDateParam;
  const hour = hourText === undefined ? 0 : Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);

  const stamp = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(stamp)) return { iso: null, allDay };
  return { iso: new Date(stamp).toISOString(), allDay };
}

function displayName(property: Property): string {
  const common = property.params.CN;
  if (common !== undefined && common.length > 0) return unescapeText(common);
  return property.value.replace(/^mailto:/i, "").trim();
}

function propertiesOf(block: string[]): Property[] {
  const properties: Property[] = [];
  let depth = 0;
  for (const line of block) {
    if (line.startsWith("BEGIN:")) {
      depth += 1;
      continue;
    }
    if (line.startsWith("END:")) {
      depth -= 1;
      continue;
    }
    if (depth > 0) continue; // inside VALARM and friends
    const property = parseProperty(line);
    if (property !== null) properties.push(property);
  }
  return properties;
}

function eventBlocks(text: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT") {
      current = [];
      continue;
    }
    if (line === "END:VEVENT") {
      if (current !== null) blocks.push(current);
      current = null;
      continue;
    }
    if (current !== null) current.push(line);
  }
  return blocks;
}

export const icsImporter: Importer = {
  id: "ics",
  label: "iCalendar (ICS)",
  extensions: [".ics"],
  description: "Calendar file: one item per event, with attendees and start/end times.",

  async *parse(input: ImporterInput): AsyncGenerator<ImportedItem, void, unknown> {
    const unfolded = unfoldIcs(Buffer.from(input.bytes).toString("latin1"));
    const text = decodeTextBytes(new Uint8Array(Buffer.from(unfolded, "latin1"))).text;
    const limit = input.limit ?? Number.POSITIVE_INFINITY;
    const blocks = eventBlocks(text);

    for (let index = 0; index < blocks.length && index < limit; index += 1) {
      const block = blocks[index];
      if (block === undefined) continue;
      const properties = propertiesOf(block);

      const startProperty = first(properties, "DTSTART");
      const endProperty = first(properties, "DTEND");
      const start = parseIcsDate(startProperty?.value ?? null, startProperty?.params.VALUE === "DATE");
      const end = parseIcsDate(endProperty?.value ?? null, endProperty?.params.VALUE === "DATE");

      const summary = first(properties, "SUMMARY")?.value.trim() ?? null;
      const description = first(properties, "DESCRIPTION")?.value.trim() ?? null;
      const location = first(properties, "LOCATION")?.value.trim() ?? null;
      const organizer = first(properties, "ORGANIZER");
      const attendees = all(properties, "ATTENDEE").map(displayName).filter((name) => name.length > 0);
      const uid = first(properties, "UID")?.value.trim() ?? null;
      const status = first(properties, "STATUS")?.value.trim() ?? null;
      const recurrence = first(properties, "RRULE")?.value.trim() ?? null;
      const url = first(properties, "URL")?.value.trim() ?? null;
      const modified =
        first(properties, "LAST-MODIFIED")?.value ?? first(properties, "DTSTAMP")?.value ?? null;
      const updatedAt = parseIcsDate(modified).iso;

      const when =
        start.iso === null
          ? null
          : end.iso === null
            ? `${start.iso}${start.allDay ? " (all day)" : ""}`
            : `${start.iso} → ${end.iso}`;

      const lines: string[] = [];
      if (summary !== null) lines.push(`Summary: ${summary}`);
      if (when !== null) lines.push(`When: ${when}`);
      if (location !== null && location.length > 0) lines.push(`Location: ${location}`);
      if (organizer !== null) lines.push(`Organizer: ${displayName(organizer)}`);
      if (attendees.length > 0) lines.push(`Attendees: ${attendees.join(", ")}`);
      const head = lines.join("\n");
      const body = description !== null && description.length > 0 ? description : "";
      const itemText = body.length > 0 ? `${head}\n\n${body}`.trim() : head.trim();

      input.onProgress?.(summary ?? `event ${index + 1}`, { items: index + 1 });
      yield {
        externalId: uid !== null && uid.length > 0 ? uid : `ics:${sha256Hex(block.join("\n"))}`,
        title: summary !== null && summary.length > 0 ? summary : "(untitled event)",
        text: itemText,
        author: organizer === null ? null : displayName(organizer),
        createdAt: start.iso,
        updatedAt,
        mime: "text/calendar",
        path: input.filename,
        url: url !== null && url.length > 0 ? url : null,
        meta: {
          uid,
          start: start.iso,
          end: end.iso,
          allDay: start.allDay,
          status,
          location,
          attendees,
          organizer: organizer === null ? null : displayName(organizer),
          recurrence,
        },
      };
    }
  },
};
