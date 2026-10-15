/**
 * HTML extractor: reads a page or a mail body with `node-html-parser` and turns
 * it into readable plain text.
 *
 * Rules: `script` / `style` / `noscript` / `svg` / `template` / `head` are
 * dropped, `h1`…`h6` become their own line, list items get a `- ` prefix, and
 * runs of whitespace (including non-breaking spaces) collapse to single
 * spaces. Entities are decoded by the parser.
 */

import { NodeType, parse } from "node-html-parser";
import type { HTMLElement as HtmlElement, Node as HtmlNode } from "node-html-parser";
import { normalizeWhitespace } from "../core/text";
import { decodeTextBytes } from "./text";
import type { ExtractedDoc, Extractor, ExtractInput } from "./types";

/** Elements whose text is not readable prose and must stay out of the output. */
const SKIP_TAGS = new Set(["script", "style", "noscript", "svg", "template", "head"]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** Elements that end the current line of text. */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

function renderNode(node: HtmlNode): string {
  if (node.nodeType === NodeType.TEXT_NODE) return node.text;
  if (node.nodeType !== NodeType.ELEMENT_NODE) return "";
  const element = node as HtmlElement;
  const tag = (element.rawTagName || "").toLowerCase();
  if (SKIP_TAGS.has(tag)) return "";
  if (tag === "br") return "\n";
  const inner = element.childNodes.map(renderNode).join("");
  if (HEADING_TAGS.has(tag)) return `\n${inner}\n`;
  if (tag === "li") return `\n- ${inner}\n`;
  if (BLOCK_TAGS.has(tag)) return `\n${inner}\n`;
  return inner;
}

function normalizeExtractedText(input: string): string {
  const spaced = input
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
  return normalizeWhitespace(spaced);
}

function firstHeadingText(root: HtmlElement): string {
  for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
    const heading = root.querySelector(tag);
    if (!heading) continue;
    const value = normalizeExtractedText(heading.text);
    if (value.length > 0) return value;
  }
  return "";
}

/**
 * Converts an HTML string to text. The title is the document `<title>` when
 * present, otherwise the first heading. Shared with the `.eml` importer, which
 * has to turn `text/html` mail parts into text.
 */
export function htmlToText(html: string): { text: string; title: string | null } {
  const root = parse(html);
  const documentTitle = normalizeExtractedText(root.querySelector("title")?.text ?? "");
  const title = documentTitle.length > 0 ? documentTitle : firstHeadingText(root);
  const body = root.querySelector("body") ?? root;
  const text = normalizeExtractedText(renderNode(body));
  return { text, title: title.length > 0 ? title : null };
}

export const htmlExtractor: Extractor = {
  id: "html",
  label: "HTML page",
  extensions: [".html", ".htm", ".xhtml"],
  mimes: ["text/html", "application/xhtml+xml"],
  async extract(input: ExtractInput): Promise<ExtractedDoc> {
    const decoded = decodeTextBytes(input.bytes);
    const { text, title } = htmlToText(decoded.text);
    const warnings: string[] = [];
    if (decoded.encoding === "latin1") {
      warnings.push("input is not valid utf-8: decoded as latin1");
    }
    return { text, title, meta: { bytes: input.bytes.byteLength }, warnings };
  },
};
