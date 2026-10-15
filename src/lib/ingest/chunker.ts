import { estimateTokens, normalizeWhitespace } from "../core/text";
import type { PreparedChunk } from "../db/repo/documents";

export type ChunkOptions = {
  /** Soft target size for a chunk. */
  targetChars?: number;
  /** Hard ceiling; a single oversized block is split further. */
  maxChars?: number;
  /** Characters repeated from the previous chunk to keep sentences coherent. */
  overlapChars?: number;
};

const DEFAULTS: Required<ChunkOptions> = {
  targetChars: 1_200,
  maxChars: 2_600,
  overlapChars: 160,
};

type Block = {
  text: string;
  start: number;
  end: number;
  heading: string | null;
  headingPath: string | null;
  /** Code fences and tables must not be glued to surrounding prose. */
  atomic: boolean;
};

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/** True when a block holds nothing but markdown heading lines. */
function isHeadingOnly(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.length > 0 && lines.every((line) => HEADING.test(line));
}

/**
 * Structure-aware chunking. Markdown headings become the chunk's heading path,
 * code fences stay intact, and every chunk records its offsets in the source so
 * the UI can jump to the exact place a citation came from.
 */
export function chunkText(input: string, options: ChunkOptions = {}): PreparedChunk[] {
  const config = { ...DEFAULTS, ...options };
  const text = normalizeWhitespace(input);
  if (text.length === 0) return [];

  const blocks = splitBlocks(text);
  const chunks: PreparedChunk[] = [];
  let current: { text: string; start: number; end: number; heading: string | null; headingPath: string | null } | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.text.trim();
    if (body.length > 0) {
      chunks.push({
        text: body,
        headingPath: current.headingPath,
        charStart: current.start,
        charEnd: current.end,
        tokenEstimate: estimateTokens(body),
      });
    }
    current = null;
  };

  for (const block of blocks) {
    if (block.atomic && block.text.length > config.maxChars) {
      flush();
      for (const piece of splitLong(block.text, config.maxChars, config.overlapChars)) {
        chunks.push({
          text: piece.text,
          headingPath: block.headingPath,
          charStart: block.start + piece.offset,
          charEnd: block.start + piece.offset + piece.text.length,
          tokenEstimate: estimateTokens(piece.text),
        });
      }
      continue;
    }

    const projected = current ? current.text.length + block.text.length + 2 : block.text.length;
    const headingChanged = current ? current.headingPath !== block.headingPath : false;
    // A heading that has not met its body yet must not be flushed on its own —
    // a bare `## Section` chunk carries nothing a reader can use. Overflowing
    // the soft target once is fine while the pair still fits under `maxChars`.
    const glueHeading =
      current !== null && isHeadingOnly(current.text) && !headingChanged && projected <= config.maxChars;

    if (!current || headingChanged || (projected > config.targetChars && !glueHeading)) {
      flush();
      current = {
        text: block.text,
        start: block.start,
        end: block.end,
        heading: block.heading,
        headingPath: block.headingPath,
      };
      continue;
    }

    // Continue the current chunk; overlap is handled by keeping whole blocks.
    current.text = `${current.text}\n\n${block.text}`;
    current.end = block.end;
  }
  flush();

  // Merge a trailing scrap into the previous chunk when it is far too small.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1] as PreparedChunk;
    const previous = chunks[chunks.length - 2] as PreparedChunk;
    // Only merge inside one section: gluing a tail onto the previous chunk of a
    // different section would relabel content with the wrong heading path.
    if (
      last.text.length < 160 &&
      previous.text.length + last.text.length <= config.maxChars &&
      previous.headingPath === last.headingPath
    ) {
      previous.text = `${previous.text}\n\n${last.text}`;
      previous.charEnd = last.charEnd;
      previous.tokenEstimate = estimateTokens(previous.text);
      chunks.pop();
    }
  }

  return chunks;
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  const headingStack: { level: number; title: string }[] = [];
  let cursor = 0;
  let buffer: string[] = [];
  let bufferStart = 0;
  let inFence = false;
  let fenceMarker = "";
  let currentHeading: string | null = null;
  let currentHeadingPath: string | null = null;

  const headingPath = () => (headingStack.length > 0 ? headingStack.map((entry) => entry.title).join(" › ") : null);

  const flushBuffer = (end: number, atomic: boolean) => {
    if (buffer.length === 0) return;
    const raw = buffer.join("\n");
    if (raw.trim().length === 0) {
      buffer = [];
      return;
    }
    blocks.push({
      text: raw.trim(),
      start: bufferStart,
      end,
      heading: currentHeading,
      headingPath: currentHeadingPath,
      atomic,
    });
    buffer = [];
  };

  lines.forEach((line, index) => {
    const lineStart = cursor;
    cursor += line.length + 1;

    const fence = FENCE.exec(line);
    if (fence) {
      if (!inFence) {
        flushBuffer(lineStart, false);
        inFence = true;
        fenceMarker = fence[1] as string;
        bufferStart = lineStart;
      } else if (line.trimStart().startsWith(fenceMarker)) {
        buffer.push(line);
        inFence = false;
        flushBuffer(cursor - 1, true);
        return;
      }
      buffer.push(line);
      return;
    }

    if (inFence) {
      buffer.push(line);
      return;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushBuffer(lineStart, false);
      const level = (heading[1] ?? "#").length;
      const title = (heading[2] ?? "").trim();
      while (headingStack.length > 0 && (headingStack[headingStack.length - 1]?.level ?? 0) >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, title });
      currentHeading = title;
      currentHeadingPath = headingPath();
      bufferStart = lineStart;
      buffer.push(line);
      if (index === lines.length - 1) flushBuffer(cursor - 1, false);
      return;
    }

    if (line.trim().length === 0) {
      flushBuffer(lineStart, false);
      bufferStart = cursor;
      return;
    }

    if (buffer.length === 0) bufferStart = lineStart;
    buffer.push(line);
  });

  flushBuffer(cursor, false);
  return blocks;
}

function splitLong(text: string, maxChars: number, overlapChars: number): { text: string; offset: number }[] {
  const pieces: { text: string; offset: number }[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + maxChars, text.length);
    if (end < text.length) {
      const slice = text.slice(offset, end);
      const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "), slice.lastIndexOf(" "));
      if (breakAt > maxChars * 0.5) end = offset + breakAt + 1;
    }
    const piece = text.slice(offset, end).trim();
    if (piece.length > 0) pieces.push({ text: piece, offset });
    if (end >= text.length) break;
    offset = Math.max(end - overlapChars, offset + 1);
  }
  return pieces;
}

/**
 * Conversation-shaped sources (Slack threads, email digests) read better when a
 * chunk holds a handful of whole messages instead of arbitrary paragraphs.
 */
export function chunkMessages(
  messages: { author: string | null; at: string | null; text: string }[],
  options: ChunkOptions = {},
): PreparedChunk[] {
  const config = { ...DEFAULTS, ...options };
  const chunks: PreparedChunk[] = [];
  let buffer: string[] = [];
  let size = 0;
  let startOffset = 0;
  let cursor = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.join("\n");
    chunks.push({
      text,
      headingPath: null,
      charStart: startOffset,
      charEnd: cursor,
      tokenEstimate: estimateTokens(text),
    });
    buffer = [];
    size = 0;
  };

  for (const message of messages) {
    const line = `${message.author ?? "unknown"}${message.at ? ` (${message.at.slice(0, 16).replace("T", " ")})` : ""}: ${message.text}`;
    if (buffer.length === 0) startOffset = cursor;
    if (size + line.length > config.targetChars) flush();
    if (buffer.length === 0) startOffset = cursor;
    buffer.push(line);
    size += line.length + 1;
    cursor += line.length + 1;
  }
  flush();
  return chunks;
}
