import { describe, expect, it } from "vitest";

import { isSubmitComboKey, isSubmitKey } from "@/lib/core/keys";

describe("isSubmitKey", () => {
  it("submits on a bare Enter", () => {
    expect(isSubmitKey({ key: "Enter" })).toBe(true);
  });

  it("does not submit when Shift is held, so a newline can be typed", () => {
    expect(isSubmitKey({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("does not submit while an IME is composing a candidate", () => {
    expect(isSubmitKey({ key: "Enter", isComposing: true })).toBe(false);
    expect(isSubmitKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });

  it("ignores every other key", () => {
    for (const key of ["a", "Escape", "Tab", " ", "NumpadEnter".slice(0, 5)]) {
      expect(isSubmitKey({ key })).toBe(false);
    }
  });
});

describe("isSubmitComboKey", () => {
  it("submits on Ctrl+Enter or ⌘+Enter", () => {
    expect(isSubmitComboKey({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(isSubmitComboKey({ key: "Enter", metaKey: true })).toBe(true);
  });

  it("leaves a bare Enter alone, so a multi-line box can hold newlines", () => {
    expect(isSubmitComboKey({ key: "Enter" })).toBe(false);
    expect(isSubmitComboKey({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("still refuses to submit mid-composition", () => {
    expect(isSubmitComboKey({ key: "Enter", ctrlKey: true, isComposing: true })).toBe(false);
  });

  it("ignores other keys even with a modifier held", () => {
    expect(isSubmitComboKey({ key: "k", ctrlKey: true })).toBe(false);
  });
});
