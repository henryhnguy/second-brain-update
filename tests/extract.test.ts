import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { ensureExtractorsRegistered, extractFile, getExtractorFor, listExtractors } from "@/lib/extract";
import { htmlToText } from "@/lib/extract/html";

/** Minimal single-page PDF with one text line: "Second Brain hello world". */
const TEXT_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTYgPj4Kc3RyZWFtCkJUIC9GMSAyNCBUZiA3MiA3MDAgVGQgKFNlY29uZCBCcmFpbiBoZWxsbyB3b3JsZCkgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMzOCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQ0MwolJUVPRgo=";

/** Same shape, but the content stream is empty: a scanned-PDF stand-in. */
const EMPTY_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMCA+PgpzdHJlYW0KZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjM1OQolJUVPRgo=";

function bytesOf(text: string, encoding: BufferEncoding = "utf8"): Uint8Array {
  return new Uint8Array(Buffer.from(text, encoding));
}

/** Minimal WordprocessingML package mammoth can read. */
function buildDocxBytes(): Uint8Array {
  const zip = new AdmZip();
  zip.addFile(
    "[Content_Types].xml",
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      "utf8",
    ),
  );
  zip.addFile(
    "_rels/.rels",
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      "utf8",
    ),
  );
  zip.addFile(
    "word/document.xml",
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Second Brain DOCX hello</w:t></w:r></w:p><w:p><w:r><w:t>Line two</w:t></w:r></w:p></w:body></w:document>',
      "utf8",
    ),
  );
  return new Uint8Array(zip.toBuffer());
}

const EML = [
  "From: An Nguyen <an@example.com>",
  "To: team@example.com",
  "Subject: Project kickoff",
  "Date: Mon, 5 Feb 2024 10:00:00 +0000",
  "Message-ID: <kickoff@example.com>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Chao ca nha, hop luc 10h nhe.",
].join("\r\n");

describe("extract: plain text formats", () => {
  it("reads a .txt file and takes the first line as title", async () => {
    const doc = await extractFile({
      bytes: bytesOf("\uFEFFSecond brain notes\nline two\n"),
      filename: "notes.txt",
    });
    expect(doc.via).toBe("text");
    expect(doc.text).toContain("Second brain notes\nline two");
    expect(doc.text.startsWith("\uFEFF")).toBe(false);
    expect(doc.title).toBe("Second brain notes");
    expect(doc.meta.lines).toBe(3);
    expect(doc.warnings).toEqual([]);
  });

  it("takes the first H1 as title for markdown", async () => {
    const doc = await extractFile({
      bytes: bytesOf("preamble text\n\n# My Note\n\nBody text\n"),
      filename: "note.md",
    });
    expect(doc.via).toBe("text");
    expect(doc.title).toBe("My Note");
    expect(doc.text).toContain("Body text");
  });

  it("falls back to latin1 when utf-8 decoding is garbled", async () => {
    const doc = await extractFile({
      bytes: new Uint8Array(Buffer.from("Caf\u00e9 latin1 notes", "latin1")),
      filename: "cafe.txt",
    });
    expect(doc.via).toBe("text");
    expect(doc.text).toBe("Caf\u00e9 latin1 notes");
    expect(doc.warnings.some((warning) => warning.includes("latin1"))).toBe(true);
  });

  it("keeps json and csv content without throwing", async () => {
    const json = await extractFile({ bytes: bytesOf('{"title":"inbox","count":3}'), filename: "data.json" });
    expect(json.via).toBe("text");
    expect(json.text).toContain('"count":3');
    expect(json.mime).toBe("application/json");

    const csv = await extractFile({ bytes: bytesOf("name,city\nAn,Ha Noi\n"), filename: "people.csv" });
    expect(csv.via).toBe("text");
    expect(csv.text).toContain("An,Ha Noi");
    expect(csv.title).toBe("name,city");
  });
});

describe("extract: html", () => {
  const HTML = [
    "<html><head><title>Trang chu</title><script>alert('x')</script>",
    "<style>body{color:red}</style></head>",
    "<body><h1>Xin chao</h1><p>Body &amp; more</p>",
    "<ul><li>mot</li><li>hai</li></ul><br>tail</body></html>",
  ].join("");

  it("drops scripts and styles, decodes entities, keeps list items", async () => {
    const doc = await extractFile({ bytes: bytesOf(HTML), filename: "page.html" });
    expect(doc.via).toBe("html");
    expect(doc.title).toBe("Trang chu");
    expect(doc.text).toContain("Xin chao");
    expect(doc.text).toContain("Body & more");
    expect(doc.text).toContain("- mot");
    expect(doc.text).toContain("- hai");
    expect(doc.text).not.toContain("alert");
    expect(doc.text).not.toContain("color:red");
    expect(doc.text).not.toContain("<h1>");
  });

  it("htmlToText falls back to the first heading when there is no title", () => {
    const result = htmlToText("<div><h2>Fallback heading</h2><p>text</p></div>");
    expect(result.title).toBe("Fallback heading");
    expect(result.text).toContain("text");
  });
});

describe("extract: email", () => {
  it("extracts an .eml message with subject as title", async () => {
    const doc = await extractFile({ bytes: bytesOf(EML), filename: "kickoff.eml" });
    expect(doc.via).toBe("eml");
    expect(doc.title).toBe("Project kickoff");
    expect(doc.text).toContain("hop luc 10h nhe");
    expect(doc.meta.from).toBe("An Nguyen <an@example.com>");
    expect(doc.meta.messageId).toBe("kickoff@example.com");
  });
});

describe("extract: binary formats", () => {
  it("extracts text from a minimal PDF", async () => {
    const doc = await extractFile({
      bytes: new Uint8Array(Buffer.from(TEXT_PDF_BASE64, "base64")),
      filename: "hello.pdf",
    });
    expect(doc.via).toBe("pdf");
    expect(doc.text).toContain("Second Brain hello world");
    expect(doc.meta.pages).toBe(1);
    expect(doc.warnings).toEqual([]);
  });

  it("warns about a PDF without a text layer", async () => {
    const doc = await extractFile({
      bytes: new Uint8Array(Buffer.from(EMPTY_PDF_BASE64, "base64")),
      filename: "scan.pdf",
    });
    expect(doc.via).toBe("pdf");
    expect(doc.text.length).toBeLessThan(20);
    expect(doc.warnings).toContain("pdf has no text layer (scanned?)");
  });

  it("extracts text from a minimal DOCX", async () => {
    const doc = await extractFile({ bytes: buildDocxBytes(), filename: "report.docx" });
    expect(doc.via).toBe("docx");
    expect(doc.text).toContain("Second Brain DOCX hello");
    expect(doc.text).toContain("Line two");
    expect(typeof doc.meta.messages).toBe("number");
  });
});

describe("extract: registry", () => {
  it("registers the built-in extractors once", () => {
    ensureExtractorsRegistered();
    ensureExtractorsRegistered();
    const ids = listExtractors().map((extractor) => extractor.id);
    for (const id of ["text", "html", "pdf", "docx", "xlsx", "pptx", "eml"]) {
      expect(ids).toContain(id);
    }
    expect(ids.filter((id) => id === "pdf")).toHaveLength(1);
  });

  it("matches by extension first and by mime second", () => {
    expect(getExtractorFor("note.MD")?.id).toBe("text");
    expect(getExtractorFor("data.bin", "application/pdf")?.id).toBe("pdf");
    expect(getExtractorFor("noextension", "text/html")?.id).toBe("html");
    expect(getExtractorFor("noextension", "application/x-nonsense")).toBeNull();
  });

  it("falls back to plain text for unknown formats instead of throwing", async () => {
    const doc = await extractFile({ bytes: bytesOf("mystery payload 123"), filename: "blob.bin" });
    expect(doc.via).toBe("fallback");
    expect(doc.text).toBe("mystery payload 123");
    expect(doc.warnings.some((warning) => warning.includes("no extractor for"))).toBe(true);
  });
});
