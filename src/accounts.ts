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

/**
 * Default is the single `opencode-go` key from OpenCode's current auth file.
 * A second key is used only when PI_OPENCODE_GO_STACK or OPENCODE_ACCOUNTS_FILE is set.
 */
export function loadAccounts(env: NodeJS.ProcessEnv = process.env): AccountLoad {
  if (env.PI_OPENCODE_GO_STACK?.trim()) {
    const names = env.PI_OPENCODE_GO_STACK.split(",").map((entry) => entry.split(":")[0]?.trim()).filter(Boolean);
    return { mode: "multi", stack: env.PI_OPENCODE_GO_STACK.trim(), names, env: {} };
  }
  const accountsFile = env.OPENCODE_ACCOUNTS_FILE;
  if (accountsFile) {
    const { accounts } = JSON.parse(fs.readFileSync(accountsFile, "utf8")) as {
      accounts: Array<{ name: string; env: string; key: string }>;
    };
    if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("OPENCODE_ACCOUNTS_FILE has no accounts");
    const assigned: Record<string, string> = {};
    for (const account of accounts) {
      if (!account.name || !account.env || !account.key) throw new Error("each account needs name, env, and key");
      assigned[account.env] = account.key;
    }
    return {
      mode: "multi",
      stack: accounts.map((account) => `${account.name}:${account.env}`).join(","),
      names: accounts.map((account) => account.name),
      env: assigned,
    };
  }
  const authFile = resolveAuthFile(env);
  if (!authFile) throw new Error("OpenCode auth file not found. Set OPENCODE_AUTH_FILE, or place auth.json in the OpenCode data directory.");
  const key = JSON.parse(fs.readFileSync(authFile, "utf8"))?.["opencode-go"]?.key;
  if (typeof key !== "string" || !key) throw new Error("opencode-go credential missing");
  return { mode: "single", stack: "go-a:OPENCODE_GO_KEY_A", names: ["go-a"], env: { OPENCODE_GO_KEY_A: key } };
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

export function resolveModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.OPENCODE_GO_MODELS ?? env.OPENCODE_GO_MODEL ?? "gpt-5.6-luna";
  const models = raw.split(",").map((id) => id.trim()).filter(Boolean);
  if (models.length === 0) throw new Error("OPENCODE_GO_MODEL is empty");
  return models;
}

export function resolveRateLimit(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.REQUESTS_PER_MINUTE ?? "30");
  if (!Number.isInteger(value) || value < 1) throw new Error("REQUESTS_PER_MINUTE must be a positive integer");
  return value;
}
