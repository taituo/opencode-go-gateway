import type { Model } from "@earendil-works/pi-ai";

export type RouteFailureClass =
  | "aborted"
  | "auth"
  | "quota"
  | "rate_limit"
  | "timeout"
  | "provider_5xx"
  | "context"
  | "bad_request"
  | "unknown";

export interface OpenCodeGoAccountConfig {
  /** Stable local label. Never sent as a credential. */
  id: string;
  /** Prefer apiKeyEnv so config files contain no secret. */
  apiKey?: string;
  apiKeyEnv?: string;
  enabled?: boolean;
}

export interface ManualFallbackRoute {
  id: string;
  provider: string;
  /** Omit or use "$requested" to preserve the requested model id. */
  model?: string;
  fallbackOn?: RouteFailureClass[];
  cooldownMs?: number;
}

export interface OpenCodeGoStackConfig {
  accounts: OpenCodeGoAccountConfig[];
  /** Default: sticky-least-loaded. */
  strategy?: "ordered" | "round-robin" | "sticky-least-loaded";
  /** A conversation's account stickiness expires after this idle time (its provider prompt cache is cold by then); default 10 min. */
  stickyIdleMs?: number;
  /** Default cooldown when a Go usage-limit error has no reset header: 5 hours. */
  quotaCooldownMs?: number;
  rateLimitCooldownMs?: number;
  transientCooldownMs?: number;
  authCooldownMs?: number;
}

export interface TransparentRouterConfig {
  openCodeGo: OpenCodeGoStackConfig;
  /** Standard Pi providers from the normal ModelRuntime/auth.json/environment. */
  fallbacks?: ManualFallbackRoute[];
}

export interface AccountHealth {
  accountId: string;
  inFlight: number;
  successes: number;
  failures: number;
  lastUsedAt?: number;
  lastFailureAt?: number;
  lastFailureClass?: RouteFailureClass;
  cooldownUntil?: number;
  latencyEmaMs?: number;
}

export interface FallbackHealth {
  routeId: string;
  successes: number;
  failures: number;
  lastFailureAt?: number;
  lastFailureClass?: RouteFailureClass;
  cooldownUntil?: number;
  latencyEmaMs?: number;
}

export type StackRouterEvent =
  | { type: "opencode_account_selected"; accountId: string; model: string; sessionId?: string }
  | {
      type: "opencode_account_failed";
      accountId: string;
      model: string;
      failure: RouteFailureClass;
      cooldownUntil?: number;
      message?: string;
    }
  | { type: "opencode_account_succeeded"; accountId: string; model: string; latencyMs: number }
  | { type: "opencode_account_skipped"; accountId: string; reason: "cooldown" | "model_not_found" | "disabled" }
  | { type: "manual_fallback_selected"; routeId: string; provider: string; model: string }
  | {
      type: "manual_fallback_failed";
      routeId: string;
      provider: string;
      model: string;
      failure: RouteFailureClass;
      message?: string;
    }
  | { type: "manual_fallback_succeeded"; routeId: string; provider: string; model: string; latencyMs: number };

export interface TransparentModelsInspection {
  accounts: AccountHealth[];
  fallbacks: FallbackHealth[];
  stickySessions: ReadonlyMap<string, string>;
}

export interface ResolvedManualFallback {
  route: ManualFallbackRoute;
  model: Model<any>;
}
