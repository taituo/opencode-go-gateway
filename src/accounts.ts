import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCodeGoAccountsFromEnv } from "./router/from-env.js";

export interface LoadedAccount {
  id: string;
  apiKey: string;
}

export interface AccountLoad {
  mode: "single" | "multi";
  accounts: LoadedAccount[];
  names: string[];
  /** Where the accounts came from (credential name, file path, or env stack). No secrets. */
  source: string;
}

interface FileEntry {
  name?: string;
  env?: string;
  key?: string;
}

/**
 * Every OpenCode Go subscription is in the pool together.
 *
 * Sources, in order:
 * 1. PI_OPENCODE_GO_STACK="go-a:OPENCODE_GO_KEY_A,..." (values name env vars, never keys).
 * 2. A JSON accounts file {"accounts":[{name,key}]} (the systemd `synth_accounts`
 *    credential shape) or the older [{name,env,key}] shape. Location:
 *    OPENCODE_ACCOUNTS_FILE, $CREDENTIALS_DIRECTORY/synth_accounts, or
 *    accounts.json / synth-accounts.json beside the auth file.
 * 3. The `opencode-go` key in the auth file alone (OPENCODE_AUTH_FILE,
 *    $CREDENTIALS_DIRECTORY/opencode_auth, or the OpenCode data directory).
 *
 * Keys already in the pool are not added twice.
 */
export function loadAccounts(env: NodeJS.ProcessEnv = process.env): AccountLoad {
  if (env.PI_OPENCODE_GO_STACK?.trim()) {
    const parsed = openCodeGoAccountsFromEnv(env.PI_OPENCODE_GO_STACK);
    const accounts = parsed.map((entry) => {
      const apiKey = entry.apiKeyEnv ? env[entry.apiKeyEnv] : undefined;
      if (!apiKey) throw new Error(`Account '${entry.id}' has no key in $${entry.apiKeyEnv ?? "?"}.`);
      return { id: entry.id, apiKey };
    });
    return { mode: accounts.length > 1 ? "multi" : "single", accounts, names: accounts.map((a) => a.id), source: "PI_OPENCODE_GO_STACK" };
  }
  const found: LoadedAccount[] = [];
  const accountsFile = resolveAccountsFile(env);
  if (accountsFile) {
    for (const account of readAccountsFile(accountsFile, env)) {
      if (!found.some((a) => a.apiKey === account.apiKey)) found.push(account);
    }
  }
  const authKey = readAuthKey(env);
  if (authKey && !found.some((a) => a.apiKey === authKey)) {
    found.unshift({ id: "go-a", apiKey: authKey });
  }
  if (found.length === 0) {
    throw new Error("No OpenCode Go accounts. Provide the synth_accounts credential, OPENCODE_ACCOUNTS_FILE, PI_OPENCODE_GO_STACK, or an auth file with an opencode-go key.");
  }
  return {
    mode: found.length > 1 ? "multi" : "single",
    accounts: found,
    names: found.map((a) => a.id),
    source: accountsFile ?? resolveAuthFile(env) ?? "auth file",
  };
}

function readAccountsFile(file: string, env: NodeJS.ProcessEnv): LoadedAccount[] {
  const { accounts } = JSON.parse(fs.readFileSync(file, "utf8")) as { accounts: FileEntry[] };
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error(`${file} has no accounts`);
  return accounts.map((entry, index) => {
    const name = String(entry.name ?? `go-${index + 1}`);
    const inline = entry.key?.trim() ? entry.key : undefined;
    const key = inline ?? (entry.env ? env[entry.env] : undefined);
    if (typeof key !== "string" || !key) {
      throw new Error(`${file} entry '${name}' needs a key (or an env name whose variable is set)`);
    }
    return { id: name, apiKey: key };
  });
}

function readAuthKey(env: NodeJS.ProcessEnv): string | undefined {
  const authFile = resolveAuthFile(env);
  if (!authFile || !fs.existsSync(authFile)) return undefined;
  const key = JSON.parse(fs.readFileSync(authFile, "utf8"))?.["opencode-go"]?.key;
  return typeof key === "string" && key ? key : undefined;
}

export function resolveAccountsFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.OPENCODE_ACCOUNTS_FILE) return env.OPENCODE_ACCOUNTS_FILE;
  const credentials = env.CREDENTIALS_DIRECTORY;
  if (credentials) {
    const fromUnit = path.join(credentials, "synth_accounts");
    if (fs.existsSync(fromUnit)) return fromUnit;
  }
  const authFile = resolveAuthFile(env);
  const dirs = new Set<string>();
  if (authFile) dirs.add(path.dirname(authFile));
  dirs.add(path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "opencode"));
  for (const dir of dirs) {
    for (const name of ["accounts.json", "synth-accounts.json"]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveAuthFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.OPENCODE_AUTH_FILE) return env.OPENCODE_AUTH_FILE;
  const credentials = env.CREDENTIALS_DIRECTORY;
  if (credentials) {
    const fromUnit = path.join(credentials, "opencode_auth");
    if (fs.existsSync(fromUnit)) return fromUnit;
  }
  const xdg = env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  const current = path.join(xdg, "opencode", "auth.json");
  if (fs.existsSync(current)) return current;
  return undefined;
}

export function resolveBearer(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GATEWAY_BEARER?.trim()) return env.GATEWAY_BEARER.trim();
  const credentials = env.CREDENTIALS_DIRECTORY;
  if (credentials) {
    const file = path.join(credentials, "gateway_bearer");
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  }
  throw new Error("GATEWAY_BEARER is required (or the gateway_bearer credential)");
}

/** OPENCODE_GO_MODELS="a,b" narrows the served list. Unset means every model the accounts expose. */
export function resolveModelFilter(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env.OPENCODE_GO_MODELS;
  if (!raw?.trim()) return undefined;
  return raw.split(",").map((id) => id.trim()).filter(Boolean);
}

/** Sanity-checked at startup: the gateway refuses to start if its default model is not served. */
export function resolveDefaultModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCODE_GO_MODEL?.trim() || "gpt-5.6-luna";
}

/** A conversation's account stickiness expires after this idle time. Default 10 min. */
export function resolveStickyIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.OPENCODE_STICKY_IDLE_MS ?? 10 * 60 * 1000);
  if (!Number.isFinite(value) || value < 0) throw new Error("OPENCODE_STICKY_IDLE_MS must be a non-negative number of milliseconds");
  return value;
}

export function resolveHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.GATEWAY_HOST?.trim() || "10.91.1.1";
}

export function resolvePort(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  const port = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return port;
}
