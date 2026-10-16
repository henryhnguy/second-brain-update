/**
 * The one place that decides whether a keypress in a composer submits.
 *
 * Enter sends, Shift+Enter inserts a newline — a chat prompt is often more than
 * one line, and the placeholder promises exactly that.
 *
 * A keypress that belongs to an IME composition must never send. Vietnamese,
 * Japanese, Chinese and Korean keyboards use Enter to commit candidates, so
 * without this check the first Enter of a diacritic sequence would fire a
 * half-written message.
 */

export type KeyLike = {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** Set by the browser while an IME is composing. */
  isComposing?: boolean;
};

export function isSubmitKey(event: KeyLike): boolean {
  if (event.key !== "Enter") return false;
  if (event.shiftKey) return false;
  if (event.isComposing) return false;
  return true;
}

/**
 * Enter held with Ctrl (Windows, Linux) or ⌘ (macOS). The form-style shortcut
 * for a multi-line box, where a bare Enter has to stay available for newlines.
 */
export function isSubmitComboKey(event: KeyLike): boolean {
  if (event.key !== "Enter") return false;
  if (event.isComposing) return false;
  return Boolean(event.ctrlKey || event.metaKey);
}
