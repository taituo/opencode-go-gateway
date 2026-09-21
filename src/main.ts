import {
  CompositeTenantPolicy,
  InMemoryTenantRateLimitPolicy,
  ModelAclPolicy,
  OpenCodeStackGatewayBackend,
  StaticBearerAuthenticator,
  createInferenceGateway,
  createTransparentModels,
  openCodeGoAccountsFromEnv,
  startRouteDump,
} from "ogw";
import { loadAccounts, resolveBearer, resolveModels, resolveRateLimit } from "./accounts.js";

const loaded = loadAccounts();
Object.assign(process.env, loaded.env);
process.env.PI_OPENCODE_GO_STACK = loaded.stack;

const models = resolveModels();
const requestsPerMinute = resolveRateLimit();
const bearer = resolveBearer();
const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
const port = Number(process.env.GATEWAY_PORT ?? process.env.PORT ?? "8788");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("GATEWAY_PORT must be an integer from 1 to 65535");

const { models: runtime } = await createTransparentModels({
  sessionId: process.env.OGW_SESSION_ID ?? "opencode-go-gateway",
  config: {
    openCodeGo: { strategy: "sticky-least-loaded", accounts: openCodeGoAccountsFromEnv() },
  },
});
const stateFile = process.env.OGW_STATE_FILE;
if (stateFile) {
  const intervalMs = Number(process.env.OGW_STATE_INTERVAL_MS ?? "60000");
  if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new Error("OGW_STATE_INTERVAL_MS must be a non-negative integer");
  startRouteDump(runtime, stateFile, intervalMs);
  console.log(`route state ${stateFile} every ${intervalMs}ms`);
}

const backend = new OpenCodeStackGatewayBackend(runtime, {
  provider: "opencode-go",
  ...(models ? { modelIds: models } : {}),
});
const principal = {
  tenantId: process.env.GATEWAY_TENANT ?? "opencode-go",
  subject: process.env.GATEWAY_SUBJECT ?? "local",
  ...(models ? { allowedModels: models } : {}),
  requestsPerMinute,
};
const gateway = createInferenceGateway({
  backend,
  host,
  port,
  maxRequestBytes: 2 * 1024 * 1024,
  authenticator: new StaticBearerAuthenticator({ [bearer]: principal }),
  tenantPolicy: new CompositeTenantPolicy([new ModelAclPolicy(), new InMemoryTenantRateLimitPolicy()]),
});
await gateway.listen();
console.log(`opencode-go gateway listening at ${gateway.url}; mode=${loaded.mode}; accounts=${loaded.names.join(",")}; models=${models?.join(",") ?? "all"}; rpm=${requestsPerMinute}`);
