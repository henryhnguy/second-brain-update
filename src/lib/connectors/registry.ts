/**
 * In-process provider registry.
 *
 * The UI lists providers, the sync runner looks one up by id. Registration is
 * deliberately a plain map write, so re-running the registration (hot reload,
 * several entry points) simply replaces the entry instead of throwing.
 */

import { AppError } from "../core/errors";
import type { Provider } from "./types";

const providers = new Map<string, Provider>();

/** Registers (or replaces) a provider under its own id. */
export function registerProvider(provider: Provider): void {
  providers.set(provider.id, provider);
}

export function getProvider(id: string): Provider | undefined {
  return providers.get(id);
}

/** Providers in registration order. */
export function listProviders(): Provider[] {
  return Array.from(providers.values());
}

/** Like `getProvider`, but throws `not_found` for an unknown id. */
export function requireProvider(id: string): Provider {
  const provider = providers.get(id);
  if (!provider) {
    throw new AppError("not_found", `Unknown connector provider: ${id}`, {
      details: { providerId: id, known: Array.from(providers.keys()) },
    });
  }
  return provider;
}
