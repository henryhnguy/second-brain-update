"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { CitationList, Markdown } from "@/components/markdown";
import { Badge, Button, Card, CardTitle, Notice, Spinner, api } from "@/components/ui";
import { slidesToMarp, slidesToStandaloneHtml } from "@/lib/studio/format";
import type { ArtifactSlide, Citation } from "@/lib/types/domain";

type Artifact = {
  id: string;
  kind: "lesson" | "slides";
  title: string;
  documentIds: string[];
  markdown: string;
  slides: ArtifactSlide[];
  citations: Citation[];
  usedLlm: boolean;
  createdAt: string;
};

function download(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "studio";
}

export default function ArtifactPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [showNotes, setShowNotes] = useState(true);
  const [presenting, setPresenting] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ artifact: Artifact }>(`/api/v1/studio/artifacts/${id}`);
      setArtifact(result.artifact);
      setIndex(0);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = artifact?.slides.length ?? 0;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!artifact || artifact.kind !== "slides") return;
      if (event.key === "ArrowRight" || event.key === " " || event.key === "PageDown") {
        event.preventDefault();
        setIndex((current) => Math.min(total - 1, current + 1));
      }
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        setIndex((current) => Math.max(0, current - 1));
      }
      if (event.key === "Escape") setPresenting(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [artifact, total]);

  async function remove() {
    if (!artifact) return;
    if (!confirm("Delete this artifact? The sources stay in the library.")) return;
    await api(`/api/v1/studio/artifacts/${artifact.id}`, { method: "DELETE" });
    router.push("/studio");
  }

  if (error) return <Notice tone="warn">{error}</Notice>;
  if (!artifact) return <Spinner label="Opening artifact…" />;

  const slide = artifact.slides[index];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/studio" className="text-xs text-muted hover:text-ink">
          ← Studio
        </Link>
        <div className="flex flex-wrap gap-2">
          {artifact.kind === "lesson" ? (
            <Button onClick={() => download(`${slug(artifact.title)}.md`, artifact.markdown, "text/markdown")}>
              Download .md
            </Button>
          ) : (
            <>
              <Button onClick={() => download(`${slug(artifact.title)}-marp.md`, slidesToMarp(artifact.slides, artifact.title), "text/markdown")}>
                Marp .md
              </Button>
              <Button
                onClick={() =>
                  download(
                    `${slug(artifact.title)}.html`,
                    slidesToStandaloneHtml(artifact.slides, artifact.title),
                    "text/html",
                  )
                }
              >
                Standalone .html
              </Button>
            </>
          )}
          <Button variant="danger" onClick={() => void remove()}>
            Delete
          </Button>
        </div>
      </header>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">{artifact.title}</h1>
            <p className="mt-1 text-[11px] text-muted">
              {artifact.kind} · {artifact.citations.length} sources · {artifact.createdAt.slice(0, 16).replace("T", " ")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={artifact.usedLlm ? "good" : "neutral"}>{artifact.usedLlm ? "with model" : "no model"}</Badge>
            <Badge>{artifact.kind}</Badge>
          </div>
        </div>
      </Card>

      {artifact.kind === "lesson" ? (
        <>
          <Card>
            <Markdown citations={artifact.citations}>{artifact.markdown}</Markdown>
          </Card>
          {artifact.citations.length > 0 ? (
            <Card>
              <CardTitle>Sources</CardTitle>
              <CitationList citations={artifact.citations} />
            </Card>
          ) : null}
        </>
      ) : (
        <>
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle hint={`${index + 1} / ${total}`}>Deck</CardTitle>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setIndex((current) => Math.max(0, current - 1))} disabled={index === 0}>
                  ← Prev
                </Button>
                <Button onClick={() => setIndex((current) => Math.min(total - 1, current + 1))} disabled={index >= total - 1}>
                  Next →
                </Button>
                <Button onClick={() => setShowNotes((current) => !current)}>{showNotes ? "Hide notes" : "Show notes"}</Button>
                <Button variant="primary" onClick={() => setPresenting(true)}>
                  Present
                </Button>
              </div>
            </div>

            <div className="mt-3 rounded-2xl border border-line bg-[#0b0f14] p-6 text-[#e8eef6] sm:p-10">
              <p className="text-[11px] uppercase tracking-widest text-[#8aa0b8]">
                {slide?.subtitle ?? `Slide ${index + 1}`}
              </p>
              <h2 className="mt-2 text-2xl font-semibold leading-tight sm:text-3xl">{slide?.title}</h2>
              {slide && slide.bullets.length > 0 ? (
                <ul className="mt-5 space-y-2 text-sm sm:text-base">
                  {slide.bullets.map((bullet, position) => (
                    <li key={position} className="flex gap-2">
                      <span className="text-[#5b8def]">•</span>
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            {showNotes && slide?.notes ? (
              <div className="mt-3 rounded-xl border border-line bg-raised/60 p-3 text-xs text-muted">
                <span className="font-medium text-ink">Speaker notes · </span>
                {slide.notes}
              </div>
            ) : null}

            <div className="mt-3 flex gap-1 overflow-auto">
              {artifact.slides.map((entry, position) => (
                <button
                  key={position}
                  type="button"
                  onClick={() => setIndex(position)}
                  className={`h-12 w-20 shrink-0 rounded-lg border p-1 text-left text-[9px] leading-tight ${
                    position === index ? "border-accent text-ink" : "border-line text-muted hover:border-accent/50"
                  }`}
                >
                  <span className="line-clamp-2">{entry.title}</span>
                </button>
              ))}
            </div>
          </Card>

          {artifact.citations.length > 0 ? (
            <Card>
              <CardTitle>Sources</CardTitle>
              <CitationList citations={artifact.citations} />
            </Card>
          ) : null}
        </>
      )}

      {presenting && slide ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#05080c] text-[#e8eef6]">
          <div className="flex items-center justify-between px-4 py-3 text-xs text-[#8aa0b8]">
            <span>
              {index + 1} / {total}
            </span>
            <div className="flex gap-2">
              <button type="button" className="rounded-lg border border-[#23303d] px-2 py-1" onClick={() => setIndex(Math.max(0, index - 1))}>
                ←
              </button>
              <button
                type="button"
                className="rounded-lg border border-[#23303d] px-2 py-1"
                onClick={() => setIndex(Math.min(total - 1, index + 1))}
              >
                →
              </button>
              <button type="button" className="rounded-lg border border-[#23303d] px-2 py-1" onClick={() => setPresenting(false)}>
                Esc
              </button>
            </div>
          </div>
          <div className="flex flex-1 flex-col justify-center px-[8vw]">
            <p className="text-sm uppercase tracking-widest text-[#8aa0b8]">{slide.subtitle ?? ""}</p>
            <h1 className="mt-3 text-[clamp(2rem,5vw,4.5rem)] font-semibold leading-tight">{slide.title}</h1>
            {slide.bullets.length > 0 ? (
              <ul className="mt-8 space-y-3 text-[clamp(1rem,2vw,1.8rem)]">
                {slide.bullets.map((bullet, position) => (
                  <li key={position} className="flex gap-3">
                    <span className="text-[#5b8def]">•</span>
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {slide.notes ? <p className="px-[8vw] pb-6 text-sm text-[#8aa0b8]">{slide.notes}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
