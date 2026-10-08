import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { GatewayBackend } from "./types.js";
import type { GatewayAuthenticator, GatewayPrincipal, GatewayTenantPolicy } from "./tenant-policy.js";

class RequestTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = "RequestTooLargeError";
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new RequestTooLargeError(maxBytes);
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

async function writeChunk(res: ServerResponse, value: Uint8Array): Promise<boolean> {
  if (res.destroyed) return false;
  if (res.write(Buffer.from(value))) return true;
  await Promise.race([
    once(res, "drain").then(() => true),
    once(res, "close").then(() => false),
  ]);
  return !res.destroyed;
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) { res.end(); return; }
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel("client disconnected").catch(() => {});
  res.once("close", cancel);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(await writeChunk(res, value))) break;
    }
  } finally {
    res.off("close", cancel);
    if (res.destroyed) await reader.cancel("client disconnected").catch(() => {});
    else res.end();
  }
}

function incomingHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(",") : value);
  }
  return headers;
}

/**
 * Tiny OpenAI-compatible front door. The backend owns actual protocol conversion
 * and routing; this server standardizes discovery, transport, cancellation,
 * body-size bounds, and response backpressure.
 */
export function createInferenceGateway(options: {
  backend: GatewayBackend;
  host?: string;
  port?: number;
  maxRequestBytes?: number;
  authenticator?: GatewayAuthenticator;
  tenantPolicy?: GatewayTenantPolicy;
}) {
  const host = options.host ?? "127.0.0.1";
  const configuredPort = options.port ?? 8787;
  const maxRequestBytes = Math.max(1, options.maxRequestBytes ?? 16 * 1024 * 1024);
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    const onAbort = () => abort.abort(new Error("gateway client disconnected"));
    req.once("aborted", onAbort);
    res.once("close", () => { if (!res.writableEnded) onAbort(); });
    try {
      const url = requestUrl(req);
      if (req.method === "GET" && url.pathname === "/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        let principal: GatewayPrincipal | undefined;
        if (options.authenticator) {
          const headers = incomingHeaders(req);
          principal = await options.authenticator.authenticate(new Request(url, { method: req.method, headers, signal: abort.signal }));
          if (!principal) {
            res.statusCode = 401;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
            return;
          }
        }
        let data = await options.backend.listModels();
        if (principal?.allowedModels) {
          const allowed = new Set(principal.allowedModels);
          data = data.filter((model) => allowed.has(model.id));
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "list", data: data.map((m) => ({ object: "model", owned_by: "synth-router", ...m })) }));
        return;
      }
      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses")) {
        const body = await readBody(req, maxRequestBytes);
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.from(body).toString("utf8")); } catch { throw new Error("Request body must be JSON"); }
        const model = typeof parsed === "object" && parsed !== null && "model" in parsed ? String((parsed as { model?: unknown }).model ?? "") : "";
        if (!model) throw new Error("Request requires model");
        const forwardedHeaders = incomingHeaders(req);
        let principal: GatewayPrincipal | undefined;
        if (options.authenticator) {
          principal = await options.authenticator.authenticate(new Request(url, { method: req.method, headers: forwardedHeaders, signal: abort.signal }));
          if (!principal) {
            res.statusCode = 401;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
            return;
          }
          await options.tenantPolicy?.authorize(principal, model);
          forwardedHeaders.set("x-synth-tenant", principal.tenantId);
          forwardedHeaders.set("x-synth-subject", principal.subject);
        }
        const forwarded = new Request(url, {
          method: req.method,
          headers: forwardedHeaders,
          body,
          signal: abort.signal,
        });
        await sendResponse(res, await options.backend.handle(forwarded, model));
        return;
      }
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "Not found" } }));
    } catch (error) {
      if (error instanceof RequestTooLargeError && !res.headersSent) {
        res.statusCode = 413;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { message: error.message } }));
        return;
      }
      if (abort.signal.aborted && !res.headersSent) {
        res.statusCode = 499;
        res.end();
        return;
      }
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : String(error);
        res.statusCode = message.startsWith("MODEL_FORBIDDEN:") ? 403 : message.startsWith("RATE_LIMITED:") ? 429 : 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { message } }));
      } else if (!res.destroyed) {
        res.end();
      }
    } finally {
      req.off("aborted", onAbort);
    }
  });
  return {
    server,
    listen: () => new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(configuredPort, host, () => resolvePromise());
    }),
    close: () => new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
    get url(): string {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : configuredPort;
      return `http://${host}:${port}`;
    },
  };
}
