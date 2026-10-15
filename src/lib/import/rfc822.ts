/**
 * RFC 822 / MIME parser, pure Node (no dependencies).
 *
 * The whole message is handled as a latin1 view of the bytes so raw 8-bit
 * content survives structural parsing untouched: `Buffer.from(text, "latin1")`
 * round-trips the original bytes exactly. Decoding to real text happens only
 * once a leaf part (with a known charset) has been isolated, via `TextDecoder`
 * with the charsets this app supports: utf-8, iso-8859-1, us-ascii and
 * windows-1252 (anything else falls back to utf-8).
 *
 * Supported: header folding, encoded-words (`=?utf-8?B|Q?...?=`), quoted-
 * printable and base64 bodies, nested multiparts, and attachments (metadata
 * plus bytes capped at 5 MB each).
 */

import { htmlToText } from "../extract/html";
import type { ParsedMessage } from "./types";

/** Hard cap per attachment so a large mail cannot blow up memory. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_DEPTH = 10;

const CHARSET_LABELS: Record<string, string> = {
  "utf-8": "utf-8",
  utf8: "utf-8",
  "us-ascii": "us-ascii",
  ascii: "us-ascii",
  "iso-8859-1": "latin1",
  "iso8859-1": "latin1",
  latin1: "latin1",
  "windows-1252": "windows-1252",
  cp1252: "windows-1252",
};

type Header = [name: string, value: string];
type Entity = { headers: Header[]; body: string };
type ContentType = { mime: string; params: Map<string, string> };
type Attachment = { filename: string; mime: string; bytes: Uint8Array };

type Collected = {
  textParts: string[];
  htmlParts: string[];
  attachments: Attachment[];
};

// ---------------------------------------------------------------- public API

export function parseRfc822(bytes: Uint8Array): ParsedMessage {
  const root = splitEntity(Buffer.from(bytes).toString("latin1"));
  const headers: Record<string, string> = {};
  for (const [name, value] of root.headers) {
    if (headers[name] === undefined) headers[name] = value;
  }

  const collected: Collected = { textParts: [], htmlParts: [], attachments: [] };
  walkEntity(root, collected, 0);

  const html = collected.htmlParts[0] ?? null;
  const plain = collected.textParts[0];
  const fallback = plain !== undefined && plain.trim().length > 0 ? plain : "";
  const text = normalizeBody(fallback.length > 0 ? fallback : html ? htmlToText(html).text : "");

  return {
    headers,
    subject: headers.subject ?? null,
    from: headers.from ?? null,
    to: headers.to ?? null,
    cc: headers.cc ?? null,
    date: headers.date ?? null,
    messageId: stripAngles(headers["message-id"] ?? null),
    text,
    html,
    attachments: collected.attachments,
  };
}

// ------------------------------------------------------------------ entities

/** Splits one entity into unfolded headers and raw (latin1) body. */
function splitEntity(raw: string): Entity {
  const separator = findHeaderSeparator(raw);
  if (separator === -1) return { headers: parseHeaders(raw), body: "" };
  return { headers: parseHeaders(raw.slice(0, separator)), body: raw.slice(separator) };
}

/** Index right after the blank line that ends the header block, or -1. */
function findHeaderSeparator(raw: string): number {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  if (crlf === -1 && lf === -1) return -1;
  if (crlf === -1) return lf + 2;
  if (lf === -1) return crlf + 4;
  return Math.min(crlf + 4, lf + 2);
}

function parseHeaders(block: string): Header[] {
  const unfolded: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const isContinuation = (line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0;
    if (isContinuation) {
      // RFC 5322 unfolding: drop the CRLF, keep the white space itself.
      const last = unfolded.length - 1;
      unfolded[last] = `${unfolded[last] ?? ""}${line}`;
      continue;
    }
    unfolded.push(line);
  }

  const headers: Header[] = [];
  for (const line of unfolded) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name.length === 0) continue;
    headers.push([name, decodeEncodedWords(line.slice(colon + 1).trim())]);
  }
  return headers;
}

function headerValue(headers: Header[], name: string): string | null {
  for (const [headerName, value] of headers) {
    if (headerName === name) return value;
  }
  return null;
}

// ------------------------------------------------------------------- bodies

function walkEntity(entity: Entity, collected: Collected, depth: number): void {
  const contentType = parseContentType(headerValue(entity.headers, "content-type") ?? "text/plain");
  const transferEncoding = (headerValue(entity.headers, "content-transfer-encoding") ?? "7bit")
    .split(";")[0]
    ?.trim()
    .toLowerCase() ?? "7bit";
  const disposition = parseContentType(headerValue(entity.headers, "content-disposition") ?? "");

  if (contentType.mime.startsWith("multipart/")) {
    const boundary = contentType.params.get("boundary");
    const nested = boundary !== undefined && depth < MAX_MULTIPART_DEPTH;
    if (nested) {
      for (const part of splitMultipart(entity.body, boundary)) {
        walkEntity(splitEntity(part), collected, depth + 1);
      }
      return;
    }
    // Unusable multipart (no boundary, or nested too deeply): keep the text.
    collected.textParts.push(decodeCharset(decodeBody(entity.body, transferEncoding), "utf-8"));
    return;
  }

  const bytes = decodeBody(entity.body, transferEncoding);
  const charset = contentType.params.get("charset") ?? "";

  if (isAttachment(disposition.mime, contentType.mime)) {
    collected.attachments.push({
      filename: attachmentFilename(disposition.params, contentType.params, collected.attachments.length),
      mime: contentType.mime.length > 0 ? contentType.mime : "application/octet-stream",
      bytes: bytes.subarray(0, MAX_ATTACHMENT_BYTES),
    });
    return;
  }

  const decoded = decodeCharset(bytes, charset);
  if (contentType.mime === "text/html") collected.htmlParts.push(decoded);
  else collected.textParts.push(decoded);
}

function isAttachment(disposition: string, mime: string): boolean {
  if (disposition === "attachment") return true;
  return !mime.startsWith("text/") && !mime.startsWith("message/");
}

function decodeBody(body: string, encoding: string): Uint8Array {
  if (encoding === "base64") {
    return new Uint8Array(Buffer.from(body.replace(/\s+/g, ""), "base64"));
  }
  if (encoding === "quoted-printable") {
    return new Uint8Array(Buffer.from(decodeQuotedPrintable(body), "latin1"));
  }
  return new Uint8Array(Buffer.from(body, "latin1"));
}

/** Quoted-printable over a latin1 string; returns a latin1 string. */
function decodeQuotedPrintable(input: string, underscoreAsSpace = false): string {
  const withoutSoftBreaks = input.replace(/=\r?\n/g, "");
  const decoded = withoutSoftBreaks.replace(/=([0-9A-Fa-f]{2})/g, (_match: string, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return underscoreAsSpace ? decoded.replace(/_/g, " ") : decoded;
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  const cleaned = charset.trim().toLowerCase().replace(/^["']|["']$/g, "");
  const label = CHARSET_LABELS[cleaned] ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// -------------------------------------------------------------- encoded words

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g;

/** Decodes `=?charset?B|Q?text?=` sequences in a header value. */
function decodeEncodedWords(value: string): string {
  ENCODED_WORD.lastIndex = 0;
  let result = "";
  let cursor = 0;
  let previousWasEncoded = false;
  let match: RegExpExecArray | null;
  while ((match = ENCODED_WORD.exec(value)) !== null) {
    const between = value.slice(cursor, match.index);
    const whitespaceOnly = between.trim().length === 0;
    // White space separating two encoded-words is not part of the value.
    if (!(previousWasEncoded && whitespaceOnly)) result += between;
    result += decodeWord(match[1] ?? "", match[2] ?? "B", match[3] ?? "");
    cursor = match.index + match[0].length;
    previousWasEncoded = true;
  }
  if (cursor === 0) return value;
  return result + value.slice(cursor);
}

function decodeWord(charset: string, encoding: string, text: string): string {
  if (encoding.toUpperCase() === "B") {
    return decodeCharset(new Uint8Array(Buffer.from(text, "base64")), charset);
  }
  return decodeCharset(new Uint8Array(Buffer.from(decodeQuotedPrintable(text, true), "latin1")), charset);
}

// ---------------------------------------------------------- content metadata

function parseContentType(value: string): ContentType {
  const tokens = splitOutsideQuotes(value);
  const mime = (tokens[0] ?? "").trim().toLowerCase();
  const params = new Map<string, string>();
  for (const token of tokens.slice(1)) {
    const equals = token.indexOf("=");
    if (equals <= 0) continue;
    const key = token.slice(0, equals).trim().toLowerCase();
    const raw = token.slice(equals + 1).trim();
    if (key.length > 0) params.set(key, unquote(raw));
  }
  return { mime, params };
}

function splitOutsideQuotes(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (char === ";" && !quoted) {
      tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  tokens.push(current);
  return tokens;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return value;
}

function attachmentFilename(
  disposition: Map<string, string>,
  contentType: Map<string, string>,
  index: number,
): string {
  const extended = disposition.get("filename*") ?? contentType.get("name*");
  if (extended) {
    const decoded = decodeExtendedParameter(extended);
    if (decoded.length > 0) return decoded;
  }
  const plain = disposition.get("filename") ?? contentType.get("name");
  if (plain) {
    const decoded = decodeEncodedWords(unquote(plain)).trim();
    if (decoded.length > 0) return decoded;
  }
  return `attachment-${index + 1}`;
}

/** RFC 2231 `charset'language'percent-encoded` parameter value. */
function decodeExtendedParameter(value: string): string {
  const match = /^([^']*)'([^']*)'(.*)$/.exec(value);
  const charset = match?.[1] ?? "utf-8";
  const encoded = match ? (match[3] ?? "") : value;
  if (encoded.length === 0) return "";
  const bytes = new Uint8Array(Buffer.from(percentDecode(encoded), "latin1"));
  return decodeCharset(bytes, charset.length > 0 ? charset : "utf-8");
}

function percentDecode(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_match: string, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

// ---------------------------------------------------------------- multipart

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Splits a multipart body into the raw text of its parts. */
function splitMultipart(body: string, boundary: string): string[] {
  if (boundary.length === 0) return [];
  const delimiter = new RegExp(
    `(?:^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*(?:\\r?\\n|$)`,
    "g",
  );
  const parts: string[] = [];
  let start: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = delimiter.exec(body)) !== null) {
    if (start !== null) parts.push(body.slice(start, match.index));
    if (match[1] === "--") return parts;
    start = match.index + match[0].length;
  }
  if (start !== null && start < body.length) parts.push(body.slice(start));
  return parts;
}

// -------------------------------------------------------------------- misc

function stripAngles(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().replace(/^<|>$/g, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBody(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
