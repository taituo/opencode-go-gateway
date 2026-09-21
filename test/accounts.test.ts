import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAccounts, resolveModels, resolveRateLimit } from "../src/accounts.js";

test("the default is the single current OpenCode key", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ogw-auth-"));
  const auth = path.join(dir, "auth.json");
  writeFileSync(auth, JSON.stringify({ "opencode-go": { type: "api", key: "single-key" } }));
  const loaded = loadAccounts({ OPENCODE_AUTH_FILE: auth });
  assert.equal(loaded.mode, "single");
  assert.deepEqual(loaded.names, ["go-a"]);
  assert.equal(loaded.env.OPENCODE_GO_KEY_A, "single-key");
  assert.equal(loaded.stack, "go-a:OPENCODE_GO_KEY_A");
});

test("multikey is used only when the accounts file is requested", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ogw-accounts-"));
  const file = path.join(dir, "accounts.json");
  writeFileSync(file, JSON.stringify({
    accounts: [
      { name: "go-a", env: "OPENCODE_GO_KEY_A", key: "aaa" },
      { name: "go-b", env: "OPENCODE_GO_KEY_B", key: "bbb" },
    ],
  }));
  const loaded = loadAccounts({ OPENCODE_ACCOUNTS_FILE: file });
  assert.equal(loaded.mode, "multi");
  assert.deepEqual(loaded.names, ["go-a", "go-b"]);
  assert.equal(loaded.stack, "go-a:OPENCODE_GO_KEY_A,go-b:OPENCODE_GO_KEY_B");
});

test("the published model list and rate limit stay narrow unless configured", () => {
  assert.deepEqual(resolveModels({}), ["gpt-5.6-luna"]);
  assert.equal(resolveRateLimit({}), 30);
  assert.deepEqual(resolveModels({ OPENCODE_GO_MODELS: "gpt-5.6-luna, deepseek-v4-flash" }), ["gpt-5.6-luna", "deepseek-v4-flash"]);
});
