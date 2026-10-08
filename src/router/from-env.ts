import type { ManualFallbackRoute, OpenCodeGoAccountConfig } from "./types.js";

/**
 * Parse PI_OPENCODE_GO_STACK="go-a:OPENCODE_GO_KEY_A,go-b:OPENCODE_GO_KEY_B".
 * The values after ':' are environment variable NAMES, never the keys themselves.
 */
export function openCodeGoAccountsFromEnv(spec = process.env.PI_OPENCODE_GO_STACK): OpenCodeGoAccountConfig[] {
  if (!spec?.trim()) return [];
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error(`Invalid PI_OPENCODE_GO_STACK entry '${entry}'. Expected account-id:ENV_VAR_NAME.`);
      }
      return {
        id: entry.slice(0, separator).trim(),
        apiKeyEnv: entry.slice(separator + 1).trim(),
      };
    });
}

/**
 * Optional manual provider fallback list. Example:
 * PI_INFERENCE_FALLBACKS_JSON='[{"id":"zen","provider":"opencode","model":"$requested"}]'
 */
export function manualFallbacksFromEnv(spec = process.env.PI_INFERENCE_FALLBACKS_JSON): ManualFallbackRoute[] {
  if (!spec?.trim()) return [];
  const parsed: unknown = JSON.parse(spec);
  if (!Array.isArray(parsed)) throw new Error("PI_INFERENCE_FALLBACKS_JSON must be a JSON array");
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Fallback ${index} must be an object`);
    }
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.provider !== "string") {
      throw new Error(`Fallback ${index} requires string id and provider`);
    }
    if (value.model !== undefined && typeof value.model !== "string") {
      throw new Error(`Fallback ${index} model must be a string`);
    }
    return {
      id: value.id,
      provider: value.provider,
      ...(value.model === undefined ? {} : { model: value.model }),
    };
  });
}
