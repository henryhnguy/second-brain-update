"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";

import type { Citation } from "@/lib/types/domain";

/**
 * Markdown renderer used for notes, play output and chat answers.
 * When citations are supplied, `[n]` markers become anchors to the source list.
 */
export function Markdown({ children, citations }: { children: string; citations?: Citation[] }) {
  const source = citations && citations.length > 0 ? linkCitations(children, citations) : children;
  return (
    <div className="sb-prose text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: label }) => {
            const target = typeof href === "string" ? href : "";
            if (target.startsWith("#citation-")) {
              return (
                <a
                  href={target}
                  className="mx-0.5 rounded-md border border-accent/40 px-1 text-[11px] no-underline hover:bg-accent/10"
                >
                  {label}
                </a>
              );
            }
            return (
              <a href={target} target="_blank" rel="noreferrer">
                {label}
              </a>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

function linkCitations(markdown: string, citations: Citation[]): string {
  const known = new Set(citations.map((citation) => String(citation.index)));
  return markdown.replace(/\[(\d{1,2})\]/g, (match, index: string) => (known.has(index) ? `[${index}](#citation-${index})` : match));
}

export function CitationList({ citations, compact = false }: { citations: Citation[]; compact?: boolean }) {
  if (citations.length === 0) {
    return <p className="text-xs text-muted">No sources used yet.</p>;
  }
  return (
    <ol className="space-y-1.5">
      {citations.map((citation) => (
        <li key={`${citation.index}-${citation.documentId}`} id={`citation-${citation.index}`} className="text-xs">
          <span className="mr-1 rounded-md border border-accent/40 px-1 text-[11px] text-accent">{citation.index}</span>
          <SourceLink citation={citation} />
          {citation.headingPath ? <span className="text-muted"> › {citation.headingPath}</span> : null}
          {!compact ? <p className="mt-0.5 line-clamp-3 text-muted">{citation.snippet}</p> : null}
        </li>
      ))}
    </ol>
  );
}

export function SourceLink({ citation }: { citation: Citation }) {
  const label = citation.title || "(untitled)";
  const suffix = citation.createdAt ? ` · ${citation.createdAt.slice(0, 10)}` : "";
  const inner: ReactNode = (
    <span className="font-medium">
      {label}
      <span className="font-normal text-muted"> — {citation.sourceId}{suffix}</span>
    </span>
  );
  if (citation.url) {
    return (
      <a href={citation.url} target="_blank" rel="noreferrer" className="hover:underline">
        {inner}
      </a>
    );
  }
  return (
    <a href={`/library/${citation.documentId}`} className="hover:underline">
      {inner}
    </a>
  );
}
