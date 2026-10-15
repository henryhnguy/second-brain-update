import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { chatConfigured, chatProviderId } from "@/lib/ai/chat-provider";
import { removeTempDataDir, useTempDataDir } from "./helpers/env";

let dir = "";

beforeEach(() => {
  dir = useTempDataDir("sb-provider-");
  delete process.env.SB_AI_CHAT_PROVIDER;
  delete process.env.SB_ANTHROPIC_API_KEY;
  process.env.SB_AI_MODE = "auto";
});

afterAll(() => {
  if (dir) removeTempDataDir(dir);
});

describe("chat provider selection", () => {
  it("defaults to the OpenAI-compatible dialect", () => {
    expect(chatProviderId()).toBe("openai_compatible");
  });

  it("selects Anthropic case-insensitively and ignores anything unrecognised", () => {
    process.env.SB_AI_CHAT_PROVIDER = "Anthropic";
    expect(chatProviderId()).toBe("anthropic");

    process.env.SB_AI_CHAT_PROVIDER = "  anthropic  ";
    expect(chatProviderId()).toBe("anthropic");

    process.env.SB_AI_CHAT_PROVIDER = "gemini";
    expect(chatProviderId()).toBe("openai_compatible");
  });

  it("reports chat as unconfigured while the Anthropic key is missing", () => {
    process.env.SB_AI_CHAT_PROVIDER = "anthropic";
    // No key in the environment and none sealed in Settings: the dispatcher must
    // say so rather than fall through to the OpenAI-compatible endpoint.
    expect(chatConfigured()).toBe(false);
  });

  it("treats the model layer as off regardless of the selected provider", () => {
    process.env.SB_AI_CHAT_PROVIDER = "anthropic";
    process.env.SB_AI_MODE = "off";
    expect(chatConfigured()).toBe(false);
  });
});
