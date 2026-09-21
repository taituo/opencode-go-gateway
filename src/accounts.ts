import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AccountLoad {
  mode: "single" | "multi";
  /** Value for PI_OPENCODE_GO_STACK. Names environment variables, not the keys. */
  stack: string;
  names: string[];
  /** Env assignments the caller must apply before building the router. */
  env: Record<string, string>;
}

interface NamedKey {
  name: string;
  envName: string;
  key: string;
}

/**
 * Every current OpenCode Go key is in the pool together.
 * The auth file contributes its `opencode-go` key. `accounts.json` or
 * `synth-accounts.json` beside it, or OPENCODE_ACCOUNTS_FILE, adds the rest.
 * PI_OPENCODE_GO_STACK replaces discovery when the keys are already in the environment.
 */
export function loadAccounts(env: NodeJS.ProcessEnv = process.env): AccountLoad {
  if (env.PI_OPENCODE_GO_STACK?.trim()) {
    const names = env.PI_OPENCODE_GO_STACK.split(",").map((entry) => entry.split(":")[0]?.trim()).filter(Boolean);
    return { mode: names.length > 1 ? "multi" : "single", stack: env.PI_OPENCODE_GO_STACK.trim(), names, env: {} };
  }
  const found: NamedKey[] = [];
  const accountsFile = resolveAccountsFile(env);
  if (accountsFile) found.push(...readAccountsFile(accountsFile));
  const authKey = readAuthKey(env);
  if (authKey && !found.some((account) => account.key === authKey)) {
    found.unshift({ name: "current", envName: "OPENCODE_GO_KEY_CURRENT", key: authKey });
  }
  if (found.length === 0) throw new Error("OpenCode auth file not found. Set OPENCODE_AUTH_FILE, or place auth.json in the OpenCode data directory.");
  const assigned: Record<string, string> = {};
  for (const account of found) assigned[account.envName] = account.key;
  return {
    mode: found.length > 1 ? "multi" : "single",
    stack: found.map((account) => `${account.name}:${account.envName}`).join(","),
    names: found.map((account) => account.name),
    env: assigned,
  };
}

function readAccountsFile(file: string): NamedKey[] {
  const { accounts } = JSON.parse(fs.readFileSync(file, "utf8")) as {
    accounts: Array<{ name: string; env: string; key: string }>;
  };
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error(`${file} has no accounts`);
  return accounts.map((account) => {
    if (!account.name || !account.env || !account.key) throw new Error("each account needs name, env, and key");
    return { name: account.name, envName: account.env, key: account.key };
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
  const dirs = new Set<string>();
  const authFile = resolveAuthFile(env);
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
  throw new Error("GATEWAY_BEARER is required");
}

/** Unset means every model the accounts expose. Set either variable to narrow the list. */
export function resolveModels(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env.OPENCODE_GO_MODELS ?? env.OPENCODE_GO_MODEL;
  if (!raw?.trim()) return undefined;
  const models = raw.split(",").map((id) => id.trim()).filter(Boolean);
  if (models.length === 0) throw new Error("OPENCODE_GO_MODEL is empty");
  return models;
}

export function resolveRateLimit(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.REQUESTS_PER_MINUTE ?? "30");
  if (!Number.isInteger(value) || value < 1) throw new Error("REQUESTS_PER_MINUTE must be a positive integer");
  return value;
}
