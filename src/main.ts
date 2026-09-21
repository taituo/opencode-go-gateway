import {
  CompositeTenantPolicy,
  InMemoryTenantRateLimitPolicy,
  ModelAclPolicy,
  OpenCodeStackGatewayBackend,
  StaticBearerAuthenticator,
  createInferenceGateway,
  createTransparentModels,
  openCodeGoAccountsFromEnv,
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
const backend = new OpenCodeStackGatewayBackend(runtime, { provider: "opencode-go", modelIds: models });
const principal = {
  tenantId: process.env.GATEWAY_TENANT ?? "opencode-go",
  subject: process.env.GATEWAY_SUBJECT ?? "local",
  allowedModels: models,
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
console.log(`opencode-go gateway listening at ${gateway.url}; mode=${loaded.mode}; accounts=${loaded.names.join(",")}; models=${models.join(",")}; rpm=${requestsPerMinute}`);
