/**
 * Mind maps are a third artifact shape: a tree of labelled nodes rather than
 * Markdown or slides. It gets its own column so the existing two stay simple.
 */
export const ARTIFACT_MINDMAP_SQL: string[] = [
  `ALTER TABLE artifacts ADD COLUMN mindmap TEXT NOT NULL DEFAULT ''`,
];
