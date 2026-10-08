import assert from "node:assert/strict";
import test from "node:test";
import { ModelAclPolicy, StaticBearerAuthenticator } from "../src/gateway/tenant-policy.js";

function authed(token: string): Request {
  return new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${token}` } });
}

test("the static bearer accepts the configured token and rejects everything else", () => {
  const auth = new StaticBearerAuthenticator({ "good-token": { tenantId: "t", subject: "s" } });
  assert.deepEqual(auth.authenticate(authed("good-token")), { tenantId: "t", subject: "s" });
  assert.equal(auth.authenticate(authed("bad-token")), undefined);
  assert.equal(auth.authenticate(new Request("http://localhost/v1/models")), undefined);
  assert.equal(
    auth.authenticate(new Request("http://localhost/v1/models", { headers: { authorization: "Basic abc" } })),
    undefined,
  );
});

test("the bearer scheme check is case-insensitive", () => {
  const auth = new StaticBearerAuthenticator({ "good-token": { tenantId: "t", subject: "s" } });
  const mixed = new Request("http://localhost/v1/models", { headers: { authorization: "bEaReR good-token" } });
  assert.deepEqual(auth.authenticate(mixed), { tenantId: "t", subject: "s" });
});

test("the model ACL allows served models and forbids the rest", () => {
  const policy = new ModelAclPolicy();
  policy.authorize({ tenantId: "t", subject: "s", allowedModels: ["a", "b"] }, "a");
  assert.throws(
    () => policy.authorize({ tenantId: "t", subject: "s", allowedModels: ["a", "b"] }, "c"),
    /MODEL_FORBIDDEN:c/,
  );
});
