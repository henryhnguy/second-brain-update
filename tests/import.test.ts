import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import {
  getImporterFor,
  listImporters,
  mboxImporter,
  notionZipImporter,
  slackZipImporter,
} from "@/lib/import";
import { icsImporter } from "@/lib/import/ics";
import { parseRfc822 } from "@/lib/import/rfc822";
import type { ImportedItem, Importer } from "@/lib/import/types";

async function collect(importer: Importer, bytes: Uint8Array, filename: string, limit?: number): Promise<ImportedItem[]> {
  const items: ImportedItem[] = [];
  for await (const item of importer.parse({ bytes, filename, limit })) items.push(item);
  return items;
}

function bytesOf(text: string, encoding: BufferEncoding = "utf8"): Uint8Array {
  return new Uint8Array(Buffer.from(text, encoding));
}

describe("import: rfc822", () => {
  const MULTIPART = [
    'From: "An Nguyen" <an@example.com>',
    "To: team@example.com",
    "Subject: =?utf-8?B?SGVsbG8=?= =?utf-8?Q?_b=E1=BA=A1n?=",
    "Date: Mon, 5 Feb 2024 10:00:00 +0000",
    "Message-ID: <abc@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="BOUND"',
    "",
    "--BOUND",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "D=C3=B2ng =C4=91=E1=BA=A7u ti=C3=AAn",
    "--BOUND",
    'Content-Type: application/pdf; name="doc.pdf"',
    'Content-Disposition: attachment; filename="doc.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "SGVsbG8=",
    "--BOUND--",
    "",
  ].join("\r\n");

  it("decodes headers, quoted-printable bodies and attachments", () => {
    const message = parseRfc822(bytesOf(MULTIPART));
    expect(message.subject).toBe("Hello b\u1ea1n");
    expect(message.from).toBe('"An Nguyen" <an@example.com>');
    expect(message.messageId).toBe("abc@example.com");
    expect(message.text).toBe("D\u00f2ng \u0111\u1ea7u ti\u00ean");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]?.filename).toBe("doc.pdf");
    expect(message.attachments[0]?.mime).toBe("application/pdf");
    expect(message.attachments[0]?.bytes.byteLength).toBe(5);
    expect(Buffer.from(message.attachments[0]?.bytes ?? new Uint8Array()).toString("utf8")).toBe("Hello");
  });

  it("converts an html-only body to text", () => {
    const message = parseRfc822(
      bytesOf(
        [
          "Subject: HTML only",
          'Content-Type: text/html; charset="utf-8"',
          "",
          "<p>Xin chao <b>ca nha</b></p>",
        ].join("\r\n"),
      ),
    );
    expect(message.html).toContain("<b>ca nha</b>");
    expect(message.text).toBe("Xin chao ca nha");
  });
});

describe("import: mbox", () => {
  const MBOX = [
    "From an@example.com Mon Feb  5 10:00:00 2024",
    "Subject: First message",
    "From: an@example.com",
    "To: team@example.com",
    "Date: Mon, 5 Feb 2024 10:00:00 +0000",
    "",
    "Body one",
    ">From the archives",
    "",
    "From binh@example.com Mon Feb  5 11:00:00 2024",
    "Subject: Second message",
    "Message-ID: <two@example.com>",
    "Date: Mon, 5 Feb 2024 11:00:00 +0000",
    "",
    "Body two",
    "",
  ].join("\n");

  it("splits messages, unescapes >From and keeps subject, body and date", async () => {
    const items = await collect(mboxImporter, bytesOf(MBOX), "mail.mbox");
    expect(items).toHaveLength(2);

    const first = items[0];
    expect(first?.title).toBe("First message");
    expect(first?.externalId.startsWith("mbox:")).toBe(true);
    expect(first?.createdAt).toBe("2024-02-05T10:00:00.000Z");
    expect(first?.text).toContain("Body one\nFrom the archives");
    expect(first?.text).toContain("From: an@example.com");
    expect(first?.author).toBe("an@example.com");

    const second = items[1];
    expect(second?.title).toBe("Second message");
    expect(second?.externalId).toBe("two@example.com");
    expect(second?.text).toContain("Body two");
  });

  it("stops at the requested limit", async () => {
    const items = await collect(mboxImporter, bytesOf(MBOX), "mail.mbox", 1);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("First message");
  });
});

describe("import: slack_zip", () => {
  function buildSlackZip(): Uint8Array {
    const zip = new AdmZip();
    zip.addFile(
      "users.json",
      Buffer.from(
        JSON.stringify([
          { id: "U1", name: "an", real_name: "An Nguyen", profile: { display_name: "An" } },
          { id: "U2", name: "binh", profile: { display_name: "Binh" } },
        ]),
        "utf8",
      ),
    );
    zip.addFile("channels.json", Buffer.from(JSON.stringify([{ id: "C1", name: "general" }]), "utf8"));
    zip.addFile(
      "general/2024-01-02.json",
      Buffer.from(
        JSON.stringify([
          { type: "message", subtype: "channel_join", user: "U3", text: "joined the channel", ts: "1704180000.000001" },
          {
            type: "message",
            user: "U1",
            text: "Hello team",
            ts: "1704182400.000100",
            thread_ts: "1704182400.000100",
            replies: [{ user: "U2", text: "Reply here", ts: "1704182500.000200" }],
          },
        ]),
        "utf8",
      ),
    );
    return new Uint8Array(zip.toBuffer());
  }

  it("emits one item per message and per thread reply", async () => {
    const items = await collect(slackZipImporter, buildSlackZip(), "slack-export.zip");
    expect(items).toHaveLength(2);

    const parent = items[0];
    expect(parent?.externalId).toBe("general:1704182400.000100");
    expect(parent?.title).toBe("#general 2024-01-02");
    expect(parent?.text).toBe("An: Hello team\nBinh: Reply here");
    expect(parent?.author).toBe("An");
    expect(parent?.createdAt).toBe("2024-01-02T08:00:00.000Z");
    expect(parent?.meta?.channel).toBe("general");

    const reply = items[1];
    expect(reply?.externalId).toBe("general:1704182500.000200");
    expect(reply?.title).toBe("#general 2024-01-02 (thread)");
    expect(reply?.text).toBe("Binh: Reply here");
    expect(reply?.meta?.isReply).toBe(true);
    expect(reply?.createdAt).toBe("2024-01-02T08:01:40.000Z");
  });

  it("stops at the requested limit", async () => {
    const items = await collect(slackZipImporter, buildSlackZip(), "slack-export.zip", 1);
    expect(items).toHaveLength(1);
    expect(items[0]?.externalId).toBe("general:1704182400.000100");
  });
});

describe("import: notion_zip", () => {
  function buildNotionZip(): Uint8Array {
    const zip = new AdmZip();
    zip.addFile("Project plan.md", Buffer.from("# Project plan\n\n- item one\n", "utf8"));
    zip.addFile("Databases/Tasks.csv", Buffer.from("name,status\nwrite tests,done\n", "utf8"));
    zip.addFile("__MACOSX/._Project plan.md", Buffer.from("junk", "latin1"));
    zip.addFile("README.txt", Buffer.from("not a page", "utf8"));
    return new Uint8Array(zip.toBuffer());
  }

  it("emits one item per markdown page and per csv file", async () => {
    const items = await collect(notionZipImporter, buildNotionZip(), "notion-export.zip");
    expect(items).toHaveLength(2);

    // Entry order inside the ZIP is not guaranteed, so match by external id.
    const page = items.find((item) => item.externalId === "Project plan.md");
    expect(page?.title).toBe("Project plan");
    expect(page?.mime).toBe("text/markdown");
    expect(page?.text).toContain("- item one");

    const table = items.find((item) => item.externalId === "Databases/Tasks.csv");
    expect(table?.title).toBe("Tasks");
    expect(table?.mime).toBe("text/csv");
    expect(table?.text).toBe("name,status\nwrite tests,done");
    expect(table?.meta?.folder).toBe("Databases");
  });
});

describe("import: ics", () => {
  const ICS = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Second Brain//EN",
    "BEGIN:VEVENT",
    "UID:event-1@example.com",
    "DTSTAMP:20240205T090000Z",
    "DTSTART:20240205T100000Z",
    "DTEND:20240205T110000Z",
    "SUMMARY:Team sy",
    " nc",
    "LOCATION:Room 3",
    "DESCRIPTION:Line one\\nLine two",
    "ATTENDEE;CN=An Nguyen;ROLE=REQ-PARTICIPANT:mailto:an@example.com",
    "ATTENDEE;CN=Binh Tran:mailto:binh@example.com",
    "ORGANIZER;CN=Chi Le:mailto:chi@example.com",
    "RRULE:FREQ=WEEKLY",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reminder",
    "TRIGGER:-PT15M",
    "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:event-2@example.com",
    "DTSTAMP:20240206T080000Z",
    "DTSTART;VALUE=DATE:20240206",
    "SUMMARY:Holiday",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

  it("unfolds lines and reads UID, times, attendees and description", async () => {
    const items = await collect(icsImporter, bytesOf(ICS), "calendar.ics");
    expect(items).toHaveLength(2);

    const event = items[0];
    expect(event?.externalId).toBe("event-1@example.com");
    expect(event?.title).toBe("Team sync");
    expect(event?.createdAt).toBe("2024-02-05T10:00:00.000Z");
    expect(event?.updatedAt).toBe("2024-02-05T09:00:00.000Z");
    expect(event?.author).toBe("Chi Le");
    expect(event?.text).toContain("Summary: Team sync");
    expect(event?.text).toContain("When: 2024-02-05T10:00:00.000Z");
    expect(event?.text).toContain("Location: Room 3");
    expect(event?.text).toContain("Attendees: An Nguyen, Binh Tran");
    expect(event?.text).toContain("Line one\nLine two");
    expect(event?.text).not.toContain("Reminder");
    expect(event?.meta?.attendees).toEqual(["An Nguyen", "Binh Tran"]);
    expect(event?.meta?.recurrence).toBe("FREQ=WEEKLY");
    expect(event?.meta?.allDay).toBe(false);
  });

  it("marks date-only events as all day", async () => {
    const items = await collect(icsImporter, bytesOf(ICS), "calendar.ics");
    const holiday = items[1];
    expect(holiday?.title).toBe("Holiday");
    expect(holiday?.createdAt).toBe("2024-02-06T00:00:00.000Z");
    expect(holiday?.meta?.allDay).toBe(true);
    expect(holiday?.text).toContain("(all day)");
  });
});

describe("import: registry", () => {
  it("registers the five importers", () => {
    const ids = listImporters().map((importer) => importer.id);
    expect(ids).toEqual(["eml", "mbox", "slack_zip", "notion_zip", "ics"]);
  });

  it("picks an importer from the file extension", () => {
    expect(getImporterFor("mail.mbox")?.id).toBe("mbox");
    expect(getImporterFor("note.eml")?.id).toBe("eml");
    expect(getImporterFor("calendar.ics")?.id).toBe("ics");
    // `.zip` is claimed by Slack first; Notion exports use notionZipImporter directly.
    expect(getImporterFor("export.zip")?.id).toBe("slack_zip");
    expect(getImporterFor("notes.txt")).toBeNull();
  });

  it("imports a single .eml file through the registry", async () => {
    const importer = getImporterFor("kickoff.eml");
    expect(importer).not.toBeNull();
    const items = await collect(
      importer as Importer,
      bytesOf(
        [
          "From: An Nguyen <an@example.com>",
          "To: team@example.com",
          "Subject: Project kickoff",
          "Date: Mon, 5 Feb 2024 10:00:00 +0000",
          "Message-ID: <kickoff@example.com>",
          "",
          "Chao ca nha",
        ].join("\r\n"),
      ),
      "kickoff.eml",
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.externalId).toBe("kickoff@example.com");
    expect(items[0]?.title).toBe("Project kickoff");
    expect(items[0]?.text).toBe("Chao ca nha");
    expect(items[0]?.createdAt).toBe("2024-02-05T10:00:00.000Z");
  });
});
