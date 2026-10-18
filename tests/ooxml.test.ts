import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";

import { extractFile } from "@/lib/extract";

/**
 * The OOXML extractors read the ZIP directly, so a fixture only needs the four
 * parts a real workbook or deck would have. These tests pin the row and slide
 * layout the chunker and search rely on.
 */

function zipBytes(files: Record<string, string>): Uint8Array {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content, "utf8"));
  return new Uint8Array(zip.toBuffer());
}

describe("xlsx extractor", () => {
  it("reads shared strings, inline strings and numbers per sheet", async () => {
    const bytes = zipBytes({
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml": "<sst><si><t>Revenue</t></si><si><t>Q1</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>100</v></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>Q1</t></is></c><c r="B2"/></row></sheetData></worksheet>',
    });

    const result = await extractFile({ bytes, filename: "report.xlsx" });
    expect(result.via).toBe("xlsx");
    expect(result.text).toContain("## Sheet: Summary");
    expect(result.text).toContain("Revenue | 100");
    expect(result.text).toContain("Q1");
    expect(result.meta.sheets).toEqual(["Summary"]);
  });
});

describe("pptx extractor", () => {
  it("reads slide text in order and includes speaker notes", async () => {
    const bytes = zipBytes({
      "ppt/slides/slide2.xml": '<p:sld><a:t>Second slide</a:t><a:t>Numbers look good</a:t></p:sld>',
      "ppt/slides/slide1.xml": '<p:sld><a:t>Quarterly review</a:t><a:t>Revenue up 18%</a:t></p:sld>',
      "ppt/notesSlides/notesSlide1.xml": '<p:notes><a:t>Remember the hiring plan</a:t></p:notes>',
    });

    const result = await extractFile({ bytes, filename: "deck.pptx" });
    expect(result.via).toBe("pptx");
    expect(result.title).toBe("Quarterly review");
    expect(result.text).toContain("## Slide 1");
    expect(result.text).toContain("Quarterly review");
    expect(result.text).toContain("## Slide 2");
    expect(result.text).toContain("Numbers look good");
    expect(result.text).toContain("Remember the hiring plan");
    const first = result.text.indexOf("Quarterly review");
    const second = result.text.indexOf("Second slide");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });
});
