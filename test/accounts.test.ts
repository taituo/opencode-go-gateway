import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAccounts, resolveModels, resolveRateLimit } from "../src/accounts.js";

test("a lone auth file is one key, and every model stays available", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ogw-auth-"));
  const auth = path.join(dir, "auth.json");
  writeFileSync(auth, JSON.stringify({ "opencode-go": { type: "api", key: "single-key" } }));
  const loaded = loadAccounts({ OPENCODE_AUTH_FILE: auth, XDG_DATA_HOME: dir });
  assert.equal(loaded.mode, "single");
  assert.deepEqual(loaded.names, ["current"]);
  assert.equal(loaded.env.OPENCODE_GO_KEY_CURRENT, "single-key");
  assert.equal(resolveModels({}), undefined);
  assert.equal(resolveRateLimit({}), 30);
});

test("keys beside the auth file join the current key, without duplicating it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ogw-accounts-"));
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "aaa" } }));
  writeFileSync(path.join(dir, "synth-accounts.json"), JSON.stringify({
    accounts: [
      { name: "go-a", env: "OPENCODE_GO_KEY_A", key: "aaa" },
      { name: "go-b", env: "OPENCODE_GO_KEY_B", key: "bbb" },
    ],
  }));
  const loaded = loadAccounts({ OPENCODE_AUTH_FILE: path.join(dir, "auth.json"), XDG_DATA_HOME: dir });
  assert.equal(loaded.mode, "multi");
  assert.deepEqual(loaded.names, ["go-a", "go-b"]);
  assert.equal(loaded.env.OPENCODE_GO_KEY_A, "aaa");
  assert.equal(loaded.env.OPENCODE_GO_KEY_B, "bbb");
  assert.equal(loaded.env.OPENCODE_GO_KEY_CURRENT, undefined);
});

test("an explicit model list narrows what is published", () => {
  assert.deepEqual(resolveModels({ OPENCODE_GO_MODELS: "gpt-5.6-luna, deepseek-v4-flash" }), ["gpt-5.6-luna", "deepseek-v4-flash"]);
});
