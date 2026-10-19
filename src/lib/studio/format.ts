import type { ArtifactSlide } from "../types/domain";

/**
 * Pure formatters for a slide deck. Kept free of storage and model imports so
 * the browser can use them for downloads without pulling server code in.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Marp-flavoured Markdown: paste into Marp, Obsidian Slides or Reveal. */
export function slidesToMarp(slides: ArtifactSlide[], title: string): string {
  const parts: string[] = ["---", "marp: true", "paginate: true", `title: ${title.replace(/"/g, "'")}`, "---", ""];
  for (const [index, slide] of slides.entries()) {
    if (index > 0) parts.push("", "---", "");
    parts.push(`# ${slide.title}`);
    if (slide.subtitle) parts.push("", `_${slide.subtitle}_`);
    if (slide.bullets.length > 0) {
      parts.push("");
      for (const bullet of slide.bullets) parts.push(`- ${bullet}`);
    }
    if (slide.notes) parts.push("", `<!-- ${slide.notes.replace(/-->/g, "→")} -->`);
  }
  return `${parts.join("\n")}\n`;
}

/**
 * Self-contained HTML deck: no build step, no external assets. Arrow keys move
 * between slides; the speaker notes stay in the DOM but are hidden on screen.
 */
export function slidesToStandaloneHtml(slides: ArtifactSlide[], title: string): string {
  const sections = slides
    .map((slide) => {
      const bullets = slide.bullets.length
        ? `<ul>${slide.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`
        : "";
      const subtitle = slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : "";
      const notes = slide.notes ? `<aside>${escapeHtml(slide.notes)}</aside>` : "";
      return `<section><h1>${escapeHtml(slide.title)}</h1>${subtitle}${bullets}${notes}</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0f14; color: #e8eef6; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  section { min-height: 100vh; display: flex; flex-direction: column; justify-content: center; gap: 1rem;
            padding: 8vh 10vw; border-bottom: 1px solid #1e2a36; }
  h1 { font-size: clamp(2rem, 5vw, 4rem); line-height: 1.1; margin: 0; letter-spacing: -0.02em; }
  .subtitle { color: #8aa0b8; font-size: clamp(1rem, 2vw, 1.5rem); margin: 0; }
  ul { margin: 0; padding-left: 1.4rem; display: grid; gap: 0.8rem; font-size: clamp(1.1rem, 2.2vw, 1.7rem); }
  li { line-height: 1.35; }
  aside { margin-top: 2rem; padding: 1rem 1.2rem; border-left: 3px solid #2f6feb; color: #8aa0b8;
          font-size: 0.95rem; max-width: 60ch; }
  section:last-child { border-bottom: 0; }
  @media print { section { page-break-after: always; min-height: auto; } aside { display: none; } }
</style>
</head>
<body>
${sections}
<script>
  const sections = Array.from(document.querySelectorAll("section"));
  let index = 0;
  function show(next) {
    index = Math.max(0, Math.min(sections.length - 1, next));
    sections[index].scrollIntoView({ behavior: "smooth" });
  }
  document.addEventListener("keydown", (event) => {
    if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) { event.preventDefault(); show(index + 1); }
    if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) { event.preventDefault(); show(index - 1); }
    if (event.key === "Home") show(0);
    if (event.key === "End") show(sections.length - 1);
  });
</script>
</body>
</html>`;
}
