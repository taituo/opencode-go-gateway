import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type AuthCheck,
  type AuthInteraction,
  type AuthOperationOptions,
  type AuthResult,
  type AuthType,
  type Context,
  type Credential,
  type DeferredHandle,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsDeferredCancelOptions,
  type ModelsDeferredFetchOptions,
  type ModelsRefreshOptions,
  type ModelsRefreshResult,
  type ModelsSimpleStreamOptions,
  type Provider,
  type ProviderResponse,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  AccountHealth,
  FallbackHealth,
  ManualFallbackRoute,
  OpenCodeGoAccountConfig,
  RouteFailureClass,
  StackRouterEvent,
  TransparentModelsInspection,
  TransparentRouterConfig,
} from "./types.js";

const OPENCODE_GO_PROVIDER = "opencode-go";
const DEFAULT_FALLBACKS = new Set<RouteFailureClass>([
  "quota",
  "rate_limit",
  "timeout",
  "provider_5xx",
  "unknown",
]);

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type AccountRuntime = {
  id: string;
  runtime: ModelRuntime;
  health: AccountHealth;
  order: number;
};

type AttemptHeaders = {
  response?: ProviderResponse;
};

function syntheticError(requested: Model<Api>, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: requested.api,
    provider: requested.provider,
    model: requested.id,
    usage: ZERO_USAGE,
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

function classifyFailure(message: string | undefined, aborted = false): RouteFailureClass {
  if (aborted) return "aborted";
  const text = (message ?? "").toLowerCase();
  if (/unauthor|forbidden|invalid api key|authentication|credential|oauth/.test(text)) return "auth";
  if (
    /gousagelimiterror|freeusagelimiterror|usage limit|monthly usage|weekly usage|5.?hour.*limit|insufficient_quota|out of budget|available balance|quota exceeded/.test(
      text,
    )
  ) {
    return "quota";
  }
  if (/\b429\b|rate.?limit|too many requests|throttl/.test(text)) return "rate_limit";
  if (/timeout|timed out|deadline|idle timeout/.test(text)) return "timeout";
  if (/context.*(length|window)|too many tokens|maximum context|token limit/.test(text)) return "context";
  if (/\b5\d\d\b|bad gateway|service unavailable|gateway timeout|upstream/.test(text)) return "provider_5xx";
  if (/\b400\b|bad request|invalid request|schema|tool.*invalid/.test(text)) return "bad_request";
  return "unknown";
}

function parseRetryAfterMs(headers: Record<string, string> | undefined, now: number): number | undefined {
  if (!headers) return undefined;
  const retryAfter = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }

  for (const name of ["x-ratelimit-reset", "x-rate-limit-reset", "ratelimit-reset"]) {
    const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    // Common forms are epoch seconds or seconds-from-now.
    if (value > 10_000_000_000) return Math.max(0, value - now);
    if (value > 1_000_000_000) return Math.max(0, value * 1000 - now);
    return Math.max(0, value * 1000);
  }
  return undefined;
}

function isCommitEvent(event: AssistantMessageEvent): boolean {
  return event.type !== "start" && event.type !== "error";
}

function requestedModelId(route: ManualFallbackRoute, requested: Model<Api>): string {
  return !route.model || route.model === "$requested" ? requested.id : route.model;
}

function stableAccountSession(sessionId: string | undefined, accountId: string): string | undefined {
  return sessionId ? `${sessionId}::ocgo::${accountId}` : undefined;
}

export class OpenCodeStackModels implements Models {
  private readonly accounts: AccountRuntime[];
  private readonly fallbackHealth = new Map<string, FallbackHealth>();
  private readonly stickySessions = new Map<string, string>();
  private readonly stickySeen = new Map<string, number>();
  /** Called when an idle-expired conversation is free to move to another account (telemetry hook). */
  onStickyExpired?: () => void;
  private roundRobinCursor = 0;

  private constructor(
    private readonly manual: ModelRuntime,
    accounts: AccountRuntime[],
    private readonly config: TransparentRouterConfig,
    private readonly options: {
      sessionId?: string;
      onEvent?: (event: StackRouterEvent) => void;
      now?: () => number;
    },
  ) {
    this.accounts = accounts;
  }

  static async create(options: {
    config: TransparentRouterConfig;
    sessionId?: string;
    onEvent?: (event: StackRouterEvent) => void;
    /** Standard Pi runtime. Omit to use normal auth.json/environment configuration. */
    manualRuntime?: ModelRuntime;
    now?: () => number;
  }): Promise<OpenCodeStackModels> {
    const manual = options.manualRuntime ?? (await ModelRuntime.create());
    const accounts: AccountRuntime[] = [];

    for (const [order, account] of options.config.openCodeGo.accounts.entries()) {
      if (account.enabled === false) continue;
      const apiKey = resolveAccountKey(account);
      if (!apiKey) {
        throw new Error(
          `OpenCode Go account '${account.id}' has no API key. Set apiKey or apiKeyEnv (${account.apiKeyEnv ?? "not configured"}).`,
        );
      }
      // Each subscription gets its own credential store/runtime so one provider id can
      // safely exist multiple times with isolated credentials and health state.
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      await runtime.setRuntimeApiKey(OPENCODE_GO_PROVIDER, apiKey);
      accounts.push({
        id: account.id,
        runtime,
        order,
        health: { accountId: account.id, inFlight: 0, successes: 0, failures: 0 },
      });
    }

    if (accounts.length === 0) throw new Error("OpenCode Go stack requires at least one enabled account");

    return new OpenCodeStackModels(manual, accounts, options.config, {
      sessionId: options.sessionId,
      onEvent: options.onEvent,
      now: options.now,
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private emit(event: StackRouterEvent): void {
    this.options.onEvent?.(event);
  }

  private cooldownMs(failure: RouteFailureClass, response?: ProviderResponse): number {
    const fromHeaders = parseRetryAfterMs(response?.headers, this.now());
    if (fromHeaders !== undefined && fromHeaders > 0) return fromHeaders;
    const cfg = this.config.openCodeGo;
    switch (failure) {
      case "quota":
        return cfg.quotaCooldownMs ?? 5 * 60 * 60_000;
      case "rate_limit":
        return cfg.rateLimitCooldownMs ?? 60_000;
      case "auth":
        return cfg.authCooldownMs ?? 15 * 60_000;
      case "timeout":
      case "provider_5xx":
        return cfg.transientCooldownMs ?? 30_000;
      case "context":
      case "bad_request":
      case "aborted":
        return 0;
      default:
        return 10_000;
    }
  }

  private shouldFallback(failure: RouteFailureClass, route?: ManualFallbackRoute): boolean {
    if (failure === "aborted") return false;
    const allowed = route?.fallbackOn ? new Set(route.fallbackOn) : DEFAULT_FALLBACKS;
    return allowed.has(failure);
  }

  private candidateAccounts(logicalSessionId: string | undefined): AccountRuntime[] {
    const now = this.now();
    const healthy = this.accounts.filter((account) => (account.health.cooldownUntil ?? 0) <= now);
    if (healthy.length === 0) return [];

    const idleMs = this.config.openCodeGo.stickyIdleMs ?? 10 * 60 * 1000;
    let stickyId = logicalSessionId ? this.stickySessions.get(logicalSessionId) : undefined;
    if (logicalSessionId && stickyId) {
      const seen = this.stickySeen.get(logicalSessionId) ?? 0;
      if (now - seen > idleMs) { stickyId = undefined; this.stickySessions.delete(logicalSessionId); this.stickySeen.delete(logicalSessionId); this.onStickyExpired?.(); }
    }
    const sticky = stickyId ? healthy.find((account) => account.id === stickyId) : undefined;
    const remaining = sticky ? healthy.filter((account) => account !== sticky) : healthy;
    const strategy = this.config.openCodeGo.strategy ?? "sticky-least-loaded";

    if (strategy === "ordered") {
      remaining.sort((a, b) => a.order - b.order);
    } else if (strategy === "round-robin") {
      const start = this.roundRobinCursor++ % Math.max(1, remaining.length);
      const rotated = [...remaining.slice(start), ...remaining.slice(0, start)];
      return sticky ? [sticky, ...rotated] : rotated;
    } else {
      remaining.sort((a, b) => {
        if (a.health.inFlight !== b.health.inFlight) return a.health.inFlight - b.health.inFlight;
        return (a.health.lastUsedAt ?? 0) - (b.health.lastUsedAt ?? 0) || a.order - b.order;
      });
    }

    return sticky ? [sticky, ...remaining] : remaining;
  }

  private markAccountFailure(
    account: AccountRuntime,
    model: string,
    failure: RouteFailureClass,
    message: string | undefined,
    response?: ProviderResponse,
  ): void {
    const now = this.now();
    const health = account.health;
    health.failures++;
    health.lastFailureAt = now;
    health.lastFailureClass = failure;
    const cooldown = this.cooldownMs(failure, response);
    health.cooldownUntil = cooldown > 0 ? now + cooldown : undefined;
    this.emit({
      type: "opencode_account_failed",
      accountId: account.id,
      model,
      failure,
      cooldownUntil: health.cooldownUntil,
      message,
    });
  }

  private markAccountSuccess(account: AccountRuntime, model: string, latencyMs: number, logicalSessionId?: string): void {
    const health = account.health;
    health.successes++;
    health.cooldownUntil = undefined;
    health.latencyEmaMs = health.latencyEmaMs === undefined ? latencyMs : health.latencyEmaMs * 0.8 + latencyMs * 0.2;
    if (logicalSessionId) {
      this.stickySessions.set(logicalSessionId, account.id);
      this.stickySeen.set(logicalSessionId, this.now());
      if (this.stickySessions.size > 5000) {
        const idleMs = this.config.openCodeGo.stickyIdleMs ?? 10 * 60 * 1000;
        for (const [id, seen] of this.stickySeen) if (this.now() - seen > idleMs) { this.stickySeen.delete(id); this.stickySessions.delete(id); }
      }
    }
    this.emit({ type: "opencode_account_succeeded", accountId: account.id, model, latencyMs });
  }

  private fallbackState(route: ManualFallbackRoute): FallbackHealth {
    const found = this.fallbackHealth.get(route.id);
    if (found) return found;
    const created: FallbackHealth = { routeId: route.id, successes: 0, failures: 0 };
    this.fallbackHealth.set(route.id, created);
    return created;
  }

  private markFallbackFailure(route: ManualFallbackRoute, failure: RouteFailureClass): void {
    const state = this.fallbackState(route);
    const now = this.now();
    state.failures++;
    state.lastFailureAt = now;
    state.lastFailureClass = failure;
    state.cooldownUntil = now + (route.cooldownMs ?? this.cooldownMs(failure));
  }

  private markFallbackSuccess(route: ManualFallbackRoute, latencyMs: number): void {
    const state = this.fallbackState(route);
    state.successes++;
    state.cooldownUntil = undefined;
    state.latencyEmaMs = state.latencyEmaMs === undefined ? latencyMs : state.latencyEmaMs * 0.8 + latencyMs * 0.2;
  }

  private async pipeAttempt(
    outer: AssistantMessageEventStream,
    stream: AssistantMessageEventStream,
  ): Promise<
    | { kind: "done"; message: AssistantMessage }
    | { kind: "retry"; error: AssistantMessage; failure: RouteFailureClass; committed: false }
    | { kind: "terminal_error"; error: AssistantMessage; failure: RouteFailureClass; committed: boolean }
  > {
    let startEvent: AssistantMessageEvent | undefined;
    let committed = false;

    for await (const event of stream) {
      if (event.type === "start") {
        startEvent = event;
        continue;
      }

      if (event.type === "error") {
        const failure = classifyFailure(event.error.errorMessage, event.reason === "aborted");
        if (!committed) return { kind: "retry", error: event.error, failure, committed: false };
        if (startEvent) outer.push(startEvent);
        outer.push(event);
        return { kind: "terminal_error", error: event.error, failure, committed: true };
      }

      if (!committed && isCommitEvent(event)) {
        committed = true;
        if (startEvent) outer.push(startEvent);
      }
      outer.push(event);
      if (event.type === "done") return { kind: "done", message: event.message };
    }

    const error = syntheticError(
      // This is only used as a shape; caller replaces model when needed.
      ({ api: "unknown", provider: "unknown", id: "unknown" } as unknown) as Model<Api>,
      "Provider stream ended without a terminal event",
    );
    return { kind: "retry", error, failure: "unknown", committed: false };
  }

  private streamOpenCodeStack(
    requested: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream {
    const outer = createAssistantMessageEventStream();
    const logicalSessionId = options?.sessionId ?? this.options.sessionId;

    void (async () => {
      let lastError: AssistantMessage | undefined;
      const accounts = this.candidateAccounts(logicalSessionId);

      for (const account of accounts) {
        const accountModel = account.runtime.getModel(OPENCODE_GO_PROVIDER, requested.id);
        if (!accountModel) {
          this.emit({ type: "opencode_account_skipped", accountId: account.id, reason: "model_not_found" });
          continue;
        }

        const attemptHeaders: AttemptHeaders = {};
        const startedAt = this.now();
        account.health.inFlight++;
        account.health.lastUsedAt = startedAt;
        this.emit({
          type: "opencode_account_selected",
          accountId: account.id,
          model: requested.id,
          sessionId: logicalSessionId,
        });

        try {
          const accountSessionId = stableAccountSession(logicalSessionId, account.id);
          const userOnResponse = options?.onResponse;
          const stream = account.runtime.streamSimple(accountModel, context, {
            ...options,
            ...(accountSessionId ? { sessionId: accountSessionId } : {}),
            onResponse: async (response, model) => {
              attemptHeaders.response = response;
              await userOnResponse?.(response, model);
            },
          });
          const result = await this.pipeAttempt(outer, stream);

          if (result.kind === "done") {
            this.markAccountSuccess(account, requested.id, this.now() - startedAt, logicalSessionId);
            return;
          }

          lastError = result.error;
          this.markAccountFailure(
            account,
            requested.id,
            result.failure,
            result.error.errorMessage,
            attemptHeaders.response,
          );
          if (result.kind === "terminal_error") return;
          if (!this.shouldFallback(result.failure)) {
            outer.push({ type: "error", reason: result.failure === "aborted" ? "aborted" : "error", error: result.error });
            return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failure = classifyFailure(message);
          lastError = syntheticError(accountModel, message);
          this.markAccountFailure(account, requested.id, failure, message, attemptHeaders.response);
          if (!this.shouldFallback(failure)) {
            outer.push({ type: "error", reason: "error", error: lastError });
            return;
          }
        } finally {
          account.health.inFlight = Math.max(0, account.health.inFlight - 1);
        }
      }

      for (const route of this.config.fallbacks ?? []) {
        const state = this.fallbackState(route);
        if ((state.cooldownUntil ?? 0) > this.now()) continue;
        const modelId = requestedModelId(route, requested);
        const fallbackModel = this.manual.getModel(route.provider, modelId);
        if (!fallbackModel) continue;

        const startedAt = this.now();
        this.emit({ type: "manual_fallback_selected", routeId: route.id, provider: route.provider, model: modelId });
        try {
          const result = await this.pipeAttempt(
            outer,
            this.manual.streamSimple(fallbackModel, context, {
              ...options,
              ...(logicalSessionId ? { sessionId: logicalSessionId } : {}),
            }),
          );
          if (result.kind === "done") {
            this.markFallbackSuccess(route, this.now() - startedAt);
            this.emit({
              type: "manual_fallback_succeeded",
              routeId: route.id,
              provider: route.provider,
              model: modelId,
              latencyMs: this.now() - startedAt,
            });
            return;
          }
          lastError = result.error;
          this.markFallbackFailure(route, result.failure);
          this.emit({
            type: "manual_fallback_failed",
            routeId: route.id,
            provider: route.provider,
            model: modelId,
            failure: result.failure,
            message: result.error.errorMessage,
          });
          if (result.kind === "terminal_error") return;
          if (!this.shouldFallback(result.failure, route)) {
            outer.push({ type: "error", reason: result.failure === "aborted" ? "aborted" : "error", error: result.error });
            return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failure = classifyFailure(message);
          lastError = syntheticError(fallbackModel, message);
          this.markFallbackFailure(route, failure);
          this.emit({
            type: "manual_fallback_failed",
            routeId: route.id,
            provider: route.provider,
            model: modelId,
            failure,
            message,
          });
          if (!this.shouldFallback(failure, route)) {
            outer.push({ type: "error", reason: "error", error: lastError });
            return;
          }
        }
      }

      outer.push({
        type: "error",
        reason: "error",
        error: lastError ?? syntheticError(requested, "No healthy OpenCode Go account or configured fallback route"),
      });
    })();

    return outer;
  }

  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
    if (model.provider !== OPENCODE_GO_PROVIDER) return this.manual.streamSimple(model, context, options);
    return this.streamOpenCodeStack(model, context, options);
  }

  completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
    return this.streamSimple(model, context, options).result();
  }

  /**
   * API-specific streaming can safely pool OpenCode Go accounts only when it stays on
   * the exact same provider/model/API. Cross-provider fallbacks are intentionally a
   * streamSimple-only feature because their API types can differ.
   */
  stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>) {
    if (model.provider !== OPENCODE_GO_PROVIDER) return this.manual.stream(model, context, options);
    // AgentHarness uses streamSimple. Keep low-level stream deterministic rather than
    // pretending a cross-API fallback is type-safe.
    const account = this.candidateAccounts(options?.sessionId ?? this.options.sessionId)[0];
    if (!account) return this.manual.stream(model, context, options);
    const accountModel = account.runtime.getModel(OPENCODE_GO_PROVIDER, model.id) as Model<TApi> | undefined;
    if (!accountModel) return this.manual.stream(model, context, options);
    return account.runtime.stream(accountModel, context, {
      ...options,
      sessionId: stableAccountSession(options?.sessionId ?? this.options.sessionId, account.id),
    });
  }

  complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>) {
    return this.stream(model, context, options).result();
  }

  // Catalog/provider identity stays transparent: callers still see ordinary Pi providers/models.
  getProviders(): readonly Provider[] { return this.manual.getProviders(); }
  getProvider(id: string): Provider | undefined { return this.manual.getProvider(id); }
  getModels(provider?: string): readonly Model<Api>[] { return this.manual.getModels(provider); }
  getModel(provider: string, id: string): Model<Api> | undefined { return this.manual.getModel(provider, id); }
  refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> { return this.manual.refresh(options); }

  async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
    if (providerId !== OPENCODE_GO_PROVIDER) return this.manual.checkAuth(providerId, options);
    const first = this.accounts[0];
    return first ? first.runtime.checkAuth(providerId, options) : undefined;
  }

  async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
    if (providerId && providerId !== OPENCODE_GO_PROVIDER) return this.manual.getAvailable(providerId, options);
    const normal = await this.manual.getAvailable(providerId, options);
    const first = this.accounts[0];
    if (!first || (providerId && providerId !== OPENCODE_GO_PROVIDER)) return normal;
    const stackModels = first.runtime.getModels(OPENCODE_GO_PROVIDER);
    const byKey = new Map(normal.map((model) => [`${model.provider}/${model.id}`, model]));
    for (const model of stackModels) byKey.set(`${model.provider}/${model.id}`, model);
    return [...byKey.values()];
  }

  getAuth(providerId: string, overrides?: Parameters<Models["getAuth"]>[1]): Promise<AuthResult | undefined>;
  getAuth(model: Model<Api>, overrides?: Parameters<Models["getAuth"]>[1]): Promise<AuthResult | undefined>;
  getAuth(subject: string | Model<Api>, overrides?: Parameters<Models["getAuth"]>[1]): Promise<AuthResult | undefined> {
    const providerId = typeof subject === "string" ? subject : subject.provider;
    if (providerId === OPENCODE_GO_PROVIDER && this.accounts[0]) {
      return typeof subject === "string"
        ? this.accounts[0].runtime.getAuth(subject, overrides)
        : this.accounts[0].runtime.getAuth(subject, overrides);
    }
    return typeof subject === "string" ? this.manual.getAuth(subject, overrides) : this.manual.getAuth(subject, overrides);
  }

  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
    return this.manual.login(providerId, type, interaction);
  }
  logout(providerId: string, options?: AuthOperationOptions): Promise<void> {
    // Configured stack credentials remain owned by this router config, not Pi's auth.json.
    return this.manual.logout(providerId, options);
  }

  // Deferred handles are provider-owned. OpenCode Go does not currently need special pooling here;
  // if a pooled provider gains deferred responses, persist account identity with the handle first.
  streamDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredFetchOptions) {
    return this.manual.streamDeferred(model, handle, options);
  }
  fetchDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredFetchOptions) {
    return this.manual.fetchDeferred(model, handle, options);
  }
  cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredCancelOptions) {
    return this.manual.cancelDeferred(model, handle, options);
  }

  inspect(): TransparentModelsInspection {
    return {
      accounts: this.accounts.map((account) => ({ ...account.health })),
      fallbacks: [...this.fallbackHealth.values()].map((state) => ({ ...state })),
      stickySessions: new Map(this.stickySessions),
    };
  }
}

function resolveAccountKey(account: OpenCodeGoAccountConfig): string | undefined {
  if (account.apiKey) return account.apiKey;
  if (account.apiKeyEnv) return process.env[account.apiKeyEnv];
  return undefined;
}
