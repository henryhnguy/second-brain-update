import { describe, expect, it } from "vitest";

import { AI_PRESETS, aiPreset, presetForBaseUrl } from "@/lib/ai/presets";

describe("AI provider presets", () => {
  it("resolves a base URL back to its preset, ignoring case and a trailing slash", () => {
    expect(presetForBaseUrl("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(presetForBaseUrl("https://openrouter.ai/api/v1/")).toBe("openrouter");
    expect(presetForBaseUrl("  https://OpenRouter.ai/API/v1  ")).toBe("openrouter");
    expect(presetForBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai/")).toBe("gemini");
    expect(presetForBaseUrl("http://localhost:11434/v1")).toBe("ollama");
  });

  it("falls back to the custom preset for an endpoint it does not know", () => {
    expect(presetForBaseUrl("https://gateway.example.com/v1")).toBe("custom");
    expect(presetForBaseUrl("")).toBe("custom");
  });

  it("keeps every preset usable: a label, a note and a real endpoint", () => {
    for (const preset of AI_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.note.length).toBeGreaterThan(0);
      if (preset.id !== "custom") expect(preset.baseUrl).toMatch(/^https?:\/\//);
    }
  });

  it("points the two cloud presets at their documented OpenAI-compatible endpoints", () => {
    expect(aiPreset("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(aiPreset("gemini")?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai/");
    expect(aiPreset("gemini")?.chatModel).toBe("gemini-3.8-flash");
  });
});
