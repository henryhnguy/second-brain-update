import path from "node:path";

/**
 * Environment access. All getters are lazy on purpose so tests and the CLI can
 * mutate `process.env` before the first read.
 */

export function envStr(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

export function envBool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function repoRoot(): string {
  return path.resolve(envStr("SB_REPO_ROOT", process.cwd()));
}

export function dataDir(): string {
  return path.resolve(envStr("SB_DATA_DIR", path.join(repoRoot(), "data")));
}

export function dbFile(): string {
  return path.resolve(envStr("SB_DB_FILE", path.join(dataDir(), "brain.db")));
}

export function uploadsDir(): string {
  return path.join(dataDir(), "files");
}

export function backupsDir(): string {
  return path.join(dataDir(), "backups");
}

export function secretFile(): string {
  return path.resolve(envStr("SB_SECRET_FILE", path.join(dataDir(), ".secret")));
}

export function stateDir(): string {
  return path.join(dataDir(), "state");
}

export type AiMode = "auto" | "openai_compatible" | "off";

export type AiEnvConfig = {
  mode: AiMode;
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  embedModel: string;
  /** Declared embedding dimension; 0 means "ask the provider". */
  embedDim: number;
  requestTimeoutMs: number;
  maxOutputTokens: number;
};

/**
 * One OpenAI-compatible wire format covers OpenAI, OpenRouter, Groq, Azure-style
 * gateways, LM Studio and Ollama (`http://localhost:11434/v1`).
 */
export function aiEnvConfig(): AiEnvConfig {
  const modeRaw = envStr("SB_AI_MODE", "auto").toLowerCase();
  const mode: AiMode =
    modeRaw === "off" || modeRaw === "openai_compatible" || modeRaw === "auto"
      ? (modeRaw as AiMode)
      : "auto";
  return {
    mode,
    baseUrl: envStr("SB_AI_BASE_URL", "https://api.openai.com/v1"),
    apiKey: envStr("SB_AI_API_KEY", ""),
    chatModel: envStr("SB_AI_CHAT_MODEL", "gpt-4o-mini"),
    embedModel: envStr("SB_AI_EMBED_MODEL", "text-embedding-3-small"),
    embedDim: envInt("SB_AI_EMBED_DIM", 0),
    requestTimeoutMs: envInt("SB_AI_TIMEOUT_MS", 60_000),
    maxOutputTokens: envInt("SB_AI_MAX_OUTPUT_TOKENS", 2_048),
  };
}

/** Host/port are informational for the CLI and docs; Next.js owns the listener. */
export function appUrl(): string {
  return envStr("SB_APP_URL", `http://localhost:${envInt("PORT", 4173)}`);
}
