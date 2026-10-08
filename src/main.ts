import http from "node:http";
import { OpenCodeStackGatewayBackend } from "./backend/adapter.js";
import { createInferenceGateway, StaticBearerAuthenticator, ModelAclPolicy } from "./gateway/index.js";
import { createTransparentModels } from "./router/index.js";
import { recordRouterEvent, recordSessionMoved, snapshot } from "./telemetry.js";
import {
  loadAccounts,
  resolveBearer,
  resolveDefaultModel,
  resolveHost,
  resolveModelFilter,
  resolvePort,
  resolveStickyIdleMs,
} from "./accounts.js";

const loaded = loadAccounts();
const gatewayToken = resolveBearer();
const host = resolveHost();
const port = resolvePort(process.env, "GATEWAY_PORT", 8788);
const statsPort = resolvePort(process.env, "GATEWAY_STATS_PORT", 8789);
const stickyIdleMs = resolveStickyIdleMs();
const defaultModel = resolveDefaultModel();

/** One JSON line per routing event (no prompts, no keys) for journald. */
function logRouterEvent(event: { type: string; [k: string]: unknown }): void {
  recordRouterEvent(event as { type: string; accountId?: string; failure?: string });
  const { message, ...rest } = event as { message?: string };
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...rest, ...(message ? { message: String(message).slice(0, 200) } : {}) }));
}

const { models } = await createTransparentModels({
  onEvent: logRouterEvent,
  sessionId: process.env.OGW_SESSION_ID ?? "agent-runtime-lab",
  config: {
    openCodeGo: {
      strategy: "sticky-least-loaded",
      accounts: loaded.accounts.map((a) => ({ id: a.id, apiKey: a.apiKey })),
      stickyIdleMs,
    },
  },
});
// OpenCode Go requires an OpenCode session header. The public OpenAI-shaped
// facade does not expose that provider-specific header, so keep a stable
// gateway session on the upstream model object. Conversation state remains
// with the caller; this is upstream routing affinity only.
// Every OpenCode Go model is served (OPENCODE_GO_MODELS="a,b,c" narrows the list).
const allGoModels = models.getModels("opencode-go") as Array<{ id: string; headers?: Record<string, string> }>;
const requested = resolveModelFilter() ?? [];
const servedModels = allGoModels.filter((m) => requested.length === 0 || requested.includes(m.id));
if (!servedModels.some((m) => m.id === defaultModel)) throw new Error(`OpenCode Go model unavailable: ${defaultModel}`);
for (const m of servedModels) m.headers = { ...(m.headers ?? {}), "x-opencode-session": "agent-runtime-lab-gateway" };
const servedIds = servedModels.map((m) => m.id);
const backend = new OpenCodeStackGatewayBackend(models, { provider: "opencode-go", modelIds: servedIds });
const principal = {
  tenantId: process.env.GATEWAY_TENANT ?? "agent-runtime-lab",
  subject: process.env.GATEWAY_SUBJECT ?? "hura-koura",
  allowedModels: servedIds,
  // Declared, not enforced: the tenant policy below is ACL-only, so no
  // request cap applies. Kept so the principal shape matches the router UI.
  requestsPerMinute: 30,
};
const gateway = createInferenceGateway({
  backend,
  host,
  port,
  maxRequestBytes: 16 * 1024 * 1024,
  authenticator: new StaticBearerAuthenticator({ [gatewayToken]: principal }),
  tenantPolicy: new ModelAclPolicy(),
});
(models as unknown as { onStickyExpired?: () => void }).onStickyExpired = recordSessionMoved;

// Stats endpoint (same bearer): GET /stats, unauthenticated GET /healthz.
const statsServer = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok\n"); return; }
  if (req.url !== "/stats" || req.headers.authorization !== `Bearer ${gatewayToken}`) { res.writeHead(req.url === "/stats" ? 401 : 404); res.end(); return; }
  const inspection = (models as unknown as { inspect?: () => { accounts: unknown[]; stickySessions: ReadonlyMap<string, string> } }).inspect?.();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(snapshot(inspection), null, 2));
});
statsServer.listen(statsPort, host);
await gateway.listen();
console.log(`opencode-go gateway listening at ${gateway.url}; default model=${defaultModel}; serving ${servedIds.length} models; ${loaded.accounts.length} account(s) [${loaded.names.join(",")}] from ${loaded.source}`);
