import assert from "node:assert/strict";
import test from "node:test";
import { cacheKey, headerSessionId, OpenCodeStackGatewayBackend } from "../src/backend/adapter.js";

test("header session ids win in x-synth, x-session-id, x-opencode-session order", () => {
  assert.equal(headerSessionId(new Headers({ "x-session-id": "a", "x-opencode-session": "b" })), "a");
  assert.equal(headerSessionId(new Headers({ "x-opencode-session": "b" })), "b");
  assert.equal(headerSessionId(new Headers({ "x-synth-session": "s", "x-session-id": "a" })), "s");
  assert.equal(headerSessionId(new Headers()), undefined);
});

test("prompt_cache_key is trimmed and capped, blanks are ignored", () => {
  assert.equal(cacheKey("  convo-1 "), "convo-1");
  assert.equal(cacheKey(""), undefined);
  assert.equal(cacheKey("   "), undefined);
  assert.equal(cacheKey(undefined), undefined);
  assert.equal(cacheKey("x".repeat(300))?.length, 256);
});

interface Seen { sessionId?: string }
function stubModels(seen: Seen[]) {
  const model = { id: "test-model", api: "openai", provider: "opencode-go" };
  return {
    getModels: () => [model],
    getModel: (_provider: string, id: string) => (id === "test-model" ? model : undefined),
    completeSimple: async (_m: unknown, _ctx: unknown, options: { sessionId?: string }) => {
      seen.push({ sessionId: options.sessionId });
      return {
        role: "assistant",
        responseId: "resp-test-1",
        content: [{ type: "text", text: "hi" }],
        api: "openai",
        provider: "opencode-go",
        model: "test-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
        stopReason: "stop",
        timestamp: Date.now(),
      };
    },
  };
}

function chatRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("chat: x-session-id reaches the router as the conversation id", async () => {
  const seen: Seen[] = [];
  const backend = new OpenCodeStackGatewayBackend(stubModels(seen) as never);
  const res = await backend.handle(
    chatRequest({ model: "test-model", messages: [{ role: "user", content: "hi" }] }, { "x-session-id": "convo-9" }),
    "test-model",
  );
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [{ sessionId: "convo-9" }]);
  const payload = await res.json() as { model: string };
  assert.equal(payload.model, "test-model");
});

test("chat: prompt_cache_key is the fallback conversation id; without either it is undefined", async () => {
  for (const [body, expected] of [
    [{ model: "test-model", messages: [], prompt_cache_key: "cache-1" }, "cache-1"],
    [{ model: "test-model", messages: [] }, undefined],
  ] as const) {
    const seen: Seen[] = [];
    const backend = new OpenCodeStackGatewayBackend(stubModels(seen) as never);
    await backend.handle(chatRequest(body), "test-model");
    assert.deepEqual(seen, [{ sessionId: expected }]);
  }
});

test("responses: metadata.session_id is the last-resort conversation id", async () => {
  const seen: Seen[] = [];
  const backend = new OpenCodeStackGatewayBackend(stubModels(seen) as never);
  const res = await backend.handle(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", input: "hi", metadata: { session_id: "meta-7" } }),
    }),
    "test-model",
  );
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [{ sessionId: "meta-7" }]);
});

test("two conversations get different routing keys (sticky per conversation)", async () => {
  const seen: Seen[] = [];
  const backend = new OpenCodeStackGatewayBackend(stubModels(seen) as never);
  for (const session of ["convo-a", "convo-b"]) {
    await backend.handle(
      chatRequest({ model: "test-model", messages: [] }, { "x-session-id": session }),
      "test-model",
    );
  }
  assert.deepEqual(seen, [{ sessionId: "convo-a" }, { sessionId: "convo-b" }]);
  assert.notEqual(seen[0]?.sessionId, seen[1]?.sessionId);
});

test("unknown models are rejected without touching the router", async () => {
  const seen: Seen[] = [];
  const backend = new OpenCodeStackGatewayBackend(stubModels(seen) as never, { modelIds: ["test-model"] });
  const res = await backend.handle(chatRequest({ model: "nope", messages: [] }), "nope");
  assert.equal(res.status, 404);
  assert.deepEqual(seen, []);
});
