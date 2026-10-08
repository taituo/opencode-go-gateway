import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadAccounts,
  resolveBearer,
  resolveDefaultModel,
  resolveHost,
  resolveModelFilter,
  resolvePort,
  resolveStickyIdleMs,
} from "../src/accounts.js";

function dirWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ogw-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

test("a lone auth file is one account, named go-a", () => {
  const dir = dirWith({ "auth.json": { "opencode-go": { type: "api", key: "single-key" } } });
  const loaded = loadAccounts({ OPENCODE_AUTH_FILE: path.join(dir, "auth.json"), XDG_DATA_HOME: dir });
  assert.equal(loaded.mode, "single");
  assert.deepEqual(loaded.names, ["go-a"]);
  assert.deepEqual(loaded.accounts, [{ id: "go-a", apiKey: "single-key" }]);
});

test("synth_accounts {name,key} entries join the pool, duplicates by key are dropped", () => {
  const dir = dirWith({
    "auth.json": { "opencode-go": { type: "api", key: "aaa" } },
    "synth-accounts.json": { accounts: [{ name: "go-a", key: "aaa" }, { name: "go-b", key: "bbb" }] },
  });
  const loaded = loadAccounts({ OPENCODE_AUTH_FILE: path.join(dir, "auth.json"), XDG_DATA_HOME: dir });
  assert.equal(loaded.mode, "multi");
  assert.deepEqual(loaded.names, ["go-a", "go-b"]);
  assert.deepEqual(loaded.accounts.map((a) => a.apiKey), ["aaa", "bbb"]);
});

test("the systemd synth_accounts credential is found via CREDENTIALS_DIRECTORY", () => {
  const creds = dirWith({ synth_accounts: JSON.stringify({ accounts: [{ name: "go-a", key: "k1" }] }) });
  const data = dirWith({});
  const loaded = loadAccounts({ CREDENTIALS_DIRECTORY: creds, XDG_DATA_HOME: data });
  assert.deepEqual(loaded.names, ["go-a"]);
  assert.ok(loaded.source.includes("synth_accounts"));
});

test("older {name,env,key} entries resolve keys from the environment", () => {
  const dir = dirWith({
    "accounts.json": { accounts: [{ name: "go-a", env: "OPENCODE_GO_KEY_A", key: "" }] },
  });
  const loaded = loadAccounts({
    OPENCODE_ACCOUNTS_FILE: path.join(dir, "accounts.json"),
    OPENCODE_GO_KEY_A: "env-key",
    XDG_DATA_HOME: dir,
  });
  assert.deepEqual(loaded.accounts, [{ id: "go-a", apiKey: "env-key" }]);
});

test("PI_OPENCODE_GO_STACK passes through as env-var indirection", () => {
  const loaded = loadAccounts({
    PI_OPENCODE_GO_STACK: "go-a:OPENCODE_GO_KEY_A,go-b:OPENCODE_GO_KEY_B",
    OPENCODE_GO_KEY_A: "a",
    OPENCODE_GO_KEY_B: "b",
  });
  assert.equal(loaded.mode, "multi");
  assert.deepEqual(loaded.accounts, [{ id: "go-a", apiKey: "a" }, { id: "go-b", apiKey: "b" }]);
});

test("no accounts anywhere is an error without secret details", () => {
  const dir = dirWith({});
  assert.throws(() => loadAccounts({ XDG_DATA_HOME: dir }), /No OpenCode Go accounts/);
});

test("bearer comes from env or the gateway_bearer credential", () => {
  assert.equal(resolveBearer({ GATEWAY_BEARER: " token " }), "token");
  const creds = dirWith({ gateway_bearer: "cred-token\n" });
  assert.equal(resolveBearer({ CREDENTIALS_DIRECTORY: creds }), "cred-token");
  assert.throws(() => resolveBearer({ XDG_DATA_HOME: dirWith({}) }), /GATEWAY_BEARER is required/);
});

test("model filter, default model, and sticky idle defaults", () => {
  assert.equal(resolveModelFilter({}), undefined);
  assert.deepEqual(resolveModelFilter({ OPENCODE_GO_MODELS: "a, b" }), ["a", "b"]);
  assert.equal(resolveDefaultModel({}), "gpt-5.6-luna");
  assert.equal(resolveDefaultModel({ OPENCODE_GO_MODEL: "x" }), "x");
  assert.equal(resolveStickyIdleMs({}), 10 * 60 * 1000);
  assert.equal(resolveStickyIdleMs({ OPENCODE_STICKY_IDLE_MS: "1000" }), 1000);
  assert.throws(() => resolveStickyIdleMs({ OPENCODE_STICKY_IDLE_MS: "-1" }), /OPENCODE_STICKY_IDLE_MS/);
});

test("host and ports default to the deployed listeners", () => {
  assert.equal(resolveHost({}), "10.91.1.1");
  assert.equal(resolvePort({}, "GATEWAY_PORT", 8788), 8788);
  assert.equal(resolvePort({}, "GATEWAY_STATS_PORT", 8789), 8789);
  assert.equal(resolvePort({ GATEWAY_PORT: "9999" }, "GATEWAY_PORT", 8788), 9999);
  assert.throws(() => resolvePort({ GATEWAY_PORT: "0" }, "GATEWAY_PORT", 8788), /GATEWAY_PORT/);
});
