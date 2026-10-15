"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge, Button, Card, CardTitle, EmptyState, Notice, Spinner, api } from "@/components/ui";

type GraphNode = { id: string; label: string; type: string; weight: number };
type GraphEdge = { source: string; target: string; weight: number; kind: string };
type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean };

const TYPE_COLOR: Record<string, string> = {
  person: "#8b8bff",
  topic: "#4ed6a0",
  org: "#e0a24a",
  email: "#5ab0ff",
  url: "#c07af7",
  tag: "#f77a9b",
  project: "#7dd3fc",
  place: "#f7d47a",
  date: "#9aa4bf",
};

/**
 * Deterministic radial layout: nodes are grouped by type on rings ordered by
 * mention weight, so the same memory always draws the same picture.
 */
function layout(nodes: GraphNode[], width: number, height: number): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;
  const cx = width / 2;
  const cy = height / 2;
  const rings = 3;
  const perRing = Math.max(1, Math.ceil(nodes.length / rings));
  const maxWeight = Math.max(...nodes.map((node) => node.weight), 1);

  nodes.forEach((node, index) => {
    const ring = Math.min(rings - 1, Math.floor(index / perRing));
    const indexInRing = index % perRing;
    const countInRing = Math.min(perRing, nodes.length - ring * perRing);
    const angle = (indexInRing / Math.max(countInRing, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = 60 + ring * Math.min(width, height) * 0.16;
    const pull = 0.85 + (node.weight / maxWeight) * 0.15;
    positions.set(node.id, { x: cx + Math.cos(angle) * radius * pull, y: cy + Math.sin(angle) * radius * pull });
  });
  return positions;
}

export default function GraphPage() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [entities, setEntities] = useState<{ id: string; name: string; type: string; mentions: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(60);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [graphResult, entityResult] = await Promise.all([
        api<Graph>(`/api/v1/graph?limit=${limit}`),
        api<{ entities: { id: string; name: string; type: string; mentions: number }[] }>("/api/v1/entities?limit=40"),
      ]);
      setGraph(graphResult);
      setEntities(entityResult.entities);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void load();
  }, [load]);

  const positions = useMemo(() => (graph ? layout(graph.nodes, 900, 620) : new Map()), [graph]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Knowledge graph</h1>
          <p className="text-sm text-muted">
            People, topics, tags and addresses that appear together in your memory. The darker the edge, the more often they show up
            together.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            className="rounded-xl border border-line bg-raised px-3 py-1.5 text-sm"
          >
            <option value={30}>30 nodes</option>
            <option value={60}>60 nodes</option>
            <option value={120}>120 nodes</option>
            <option value={200}>200 nodes</option>
          </select>
          <Button onClick={() => void load()}>Refresh</Button>
        </div>
      </header>

      {error ? <Notice tone="warn">{error}</Notice> : null}

      {loading && !graph ? (
        <Spinner />
      ) : !graph || graph.nodes.length === 0 ? (
        <EmptyState
          title="Not enough data to draw the graph"
          hint="The graph is built from entities extracted during import: names in emails, [[links]] in notes, #tags, domains."
          action={
            <Link href="/import" className="rounded-xl border border-line bg-raised px-3 py-1.5 text-sm hover:border-accent/60">
              Import
            </Link>
          }
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          <Card className="overflow-hidden">
            <CardTitle hint={`${graph.nodes.length} nodes · ${graph.edges.length} edges${graph.truncated ? " (truncated)" : ""}`}>
              Entity network
            </CardTitle>
            <svg viewBox="0 0 900 620" className="h-[32rem] w-full">
              {graph.edges.map((edge, index) => {
                const from = positions.get(edge.source);
                const to = positions.get(edge.target);
                if (!from || !to) return null;
                return (
                  <line
                    key={`${edge.source}-${edge.target}-${index}`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke="currentColor"
                    className="text-line"
                    strokeWidth={Math.min(3, 0.5 + edge.weight * 0.25)}
                    opacity={0.5}
                  />
                );
              })}
              {graph.nodes.map((node) => {
                const position = positions.get(node.id);
                if (!position) return null;
                const radius = 4 + Math.min(14, node.weight * 1.2);
                return (
                  <g key={node.id}>
                    <circle cx={position.x} cy={position.y} r={radius} fill={TYPE_COLOR[node.type] ?? "#9aa4bf"} opacity={0.85} />
                    <text
                      x={position.x}
                      y={position.y - radius - 4}
                      textAnchor="middle"
                      className="fill-current text-[10px] text-muted"
                    >
                      {node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}
                    </text>
                  </g>
                );
              })}
            </svg>
            <div className="mt-2 flex flex-wrap gap-2">
              {Object.entries(TYPE_COLOR).map(([type, color]) => (
                <span key={type} className="inline-flex items-center gap-1 text-[11px] text-muted">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
                  {type}
                </span>
              ))}
            </div>
          </Card>

          <Card>
            <CardTitle hint="by number of mentions">Top entities</CardTitle>
            <ul className="space-y-1.5 text-sm">
              {entities.map((entity) => (
                <li key={entity.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{entity.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge>{entity.type}</Badge>
                    <span className="tabular-nums text-xs text-muted">{entity.mentions}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-muted">
              Entity extraction is heuristic (emails, domains, #tags, [[links]], repeated capitalized phrases) — it does not call a model,
              so it works even with no AI configured.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}
