/**
 * Email message extractor: `.eml` files become their subject plus body text,
 * with attachment metadata (name, mime, size) in `meta`.
 */

import { parseRfc822 } from "../import/rfc822";
import type { ExtractInput, ExtractedDoc, Extractor } from "./types";

export const emlExtractor: Extractor = {
  id: "eml",
  label: "Email message",
  extensions: [".eml"],
  mimes: ["message/rfc822", "message/eml", "application/eml"],

  async extract(input: ExtractInput): Promise<ExtractedDoc> {
    const message = parseRfc822(input.bytes);
    const warnings: string[] = [];
    if (message.text.length === 0 && message.html === null) {
      warnings.push("message has no text or html body");
    }

    return {
      text: message.text,
      title: message.subject,
      meta: {
        from: message.from,
        to: message.to,
        cc: message.cc,
        date: message.date,
        messageId: message.messageId,
        attachments: message.attachments.map((attachment) => ({
          filename: attachment.filename,
          mime: attachment.mime,
          bytes: attachment.bytes.byteLength,
        })),
      },
      warnings,
    };
  },
};
