import type { MindMapNode } from "../types/domain";

/**
 * Horizontal tree layout for a mind map. Pure functions only: the page draws
 * the result, and the SVG export renders the same layout to a string, so the
 * download and the screen can never drift apart.
 */

export type MindMapLayoutNode = {
  node: MindMapNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
};

export type MindMapLayout = {
  nodes: MindMapLayoutNode[];
  links: { from: MindMapLayoutNode; to: MindMapLayoutNode }[];
  width: number;
  height: number;
};

const NODE_HEIGHT = 38;
const GAP_Y = 16;
const COLUMN = 260;
const PADDING = 28;
const MAX_NODE_WIDTH = 228;

function nodeWidth(label: string): number {
  const estimated = 26 + label.length * 7.1;
  return Math.max(120, Math.min(MAX_NODE_WIDTH, estimated));
}

export function layoutMindMap(root: MindMapNode): MindMapLayout {
  let cursor = PADDING;
  let maxDepth = 0;
  let maxWidth = 0;
  const nodes: MindMapLayoutNode[] = [];
  const links: { from: MindMapLayoutNode; to: MindMapLayoutNode }[] = [];

  function walk(node: MindMapNode, depth: number): MindMapLayoutNode {
    maxDepth = Math.max(maxDepth, depth);
    const children = node.children.map((child) => walk(child, depth + 1));
    const y =
      children.length > 0
        ? ((children[0] as MindMapLayoutNode).y + (children[children.length - 1] as MindMapLayoutNode).y) / 2
        : cursor;
    if (children.length === 0) cursor += NODE_HEIGHT + GAP_Y;

    const width = nodeWidth(node.label);
    maxWidth = Math.max(maxWidth, width);
    const positioned: MindMapLayoutNode = {
      node,
      x: PADDING + depth * COLUMN,
      y,
      width,
      height: NODE_HEIGHT,
      depth,
    };
    nodes.push(positioned);
    for (const child of children) links.push({ from: positioned, to: child });
    return positioned;
  }

  walk(root, 0);

  return {
    nodes,
    links,
    width: PADDING * 2 + maxDepth * COLUMN + maxWidth,
    height: Math.max(cursor + PADDING, PADDING * 2 + NODE_HEIGHT),
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clip(label: string, max = 34): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

/** Self-contained SVG: no fonts, scripts or external assets. */
export function mindmapToSvg(root: MindMapNode, title: string): string {
  const layout = layoutMindMap(root);
  const linkPaths = layout.links
    .map(({ from, to }) => {
      const x1 = from.x + from.width;
      const y1 = from.y + from.height / 2;
      const x2 = to.x;
      const y2 = to.y + to.height / 2;
      const bend = Math.max(30, (x2 - x1) / 2);
      return `<path d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" fill="none" stroke="#3b4b63" stroke-width="1.6"/>`;
    })
    .join("\n");

  const nodeShapes = layout.nodes
    .map(({ node, x, y, width, height, depth }) => {
      const root = depth === 0;
      const fill = root ? "#1f4e78" : "#121a26";
      const stroke = root ? "#5b8def" : depth === 1 ? "#3f5878" : "#263445";
      const color = root ? "#ffffff" : "#dbe6f3";
      const weight = root || depth === 1 ? 600 : 400;
      const label = clip(node.label, root ? 40 : depth === 1 ? 36 : 30);
      const citation = node.citation ? ` <tspan fill="#7f9cc0" font-size="10">[${node.citation}]</tspan>` : "";
      return [
        `<g>`,
        `<title>${escapeXml(node.detail ?? node.label)}</title>`,
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>`,
        `<text x="${x + 12}" y="${y + height / 2 + 4}" font-family="ui-sans-serif, system-ui, Segoe UI, sans-serif" font-size="${root ? 13 : 12}" font-weight="${weight}" fill="${color}">${escapeXml(label)}${citation}</text>`,
        `</g>`,
      ].join("");
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="${escapeXml(title)}">
<title>${escapeXml(title)}</title>
<rect width="${layout.width}" height="${layout.height}" fill="#080c12"/>
${linkPaths}
${nodeShapes}
</svg>`;
}
