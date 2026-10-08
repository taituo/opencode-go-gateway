export interface GatewayPrincipal {
  tenantId: string;
  subject: string;
  allowedModels?: readonly string[];
  requestsPerMinute?: number;
}

export interface GatewayAuthenticator {
  authenticate(request: Request): Promise<GatewayPrincipal | undefined> | GatewayPrincipal | undefined;
}

export interface GatewayTenantPolicy {
  authorize(principal: GatewayPrincipal, model: string): Promise<void> | void;
}

export class StaticBearerAuthenticator implements GatewayAuthenticator {
  readonly #tokens: ReadonlyMap<string, GatewayPrincipal>;
  constructor(tokens: ReadonlyMap<string, GatewayPrincipal> | Record<string, GatewayPrincipal>) {
    this.#tokens = tokens instanceof Map ? tokens : new Map(Object.entries(tokens));
  }
  authenticate(request: Request): GatewayPrincipal | undefined {
    const header = request.headers.get("authorization");
    if (!header?.toLowerCase().startsWith("bearer ")) return undefined;
    const principal = this.#tokens.get(header.slice(7));
    return principal ? structuredClone(principal) : undefined;
  }
}

export class ModelAclPolicy implements GatewayTenantPolicy {
  authorize(principal: GatewayPrincipal, model: string): void {
    if (principal.allowedModels && !principal.allowedModels.includes(model)) throw new Error(`MODEL_FORBIDDEN:${model}`);
  }
}

export class InMemoryTenantRateLimitPolicy implements GatewayTenantPolicy {
  readonly #windows = new Map<string, { minute: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  authorize(principal: GatewayPrincipal, _model: string): void {
    const limit = principal.requestsPerMinute;
    if (!limit || limit <= 0) return;
    const minute = Math.floor(this.now() / 60_000);
    const current = this.#windows.get(principal.tenantId);
    const window = current?.minute === minute ? current : { minute, count: 0 };
    window.count++;
    this.#windows.set(principal.tenantId, window);
    if (window.count > limit) throw new Error(`RATE_LIMITED:${principal.tenantId}`);
  }
}

export class CompositeTenantPolicy implements GatewayTenantPolicy {
  constructor(private readonly policies: readonly GatewayTenantPolicy[]) {}
  async authorize(principal: GatewayPrincipal, model: string): Promise<void> {
    for (const policy of this.policies) await policy.authorize(principal, model);
  }
}
