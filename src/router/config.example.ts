import type { TransparentRouterConfig } from "./types.js";

export const routerConfig: TransparentRouterConfig = {
  openCodeGo: {
    strategy: "sticky-least-loaded",
    accounts: [
      { id: "go-a", apiKeyEnv: "OPENCODE_GO_KEY_A" },
      { id: "go-b", apiKeyEnv: "OPENCODE_GO_KEY_B" },
      { id: "go-c", apiKeyEnv: "OPENCODE_GO_KEY_C", enabled: false },
    ],
  },
  // These use the normal Pi ModelRuntime, so configure them exactly as you
  // normally would through auth.json, environment variables, models.json, OAuth, etc.
  fallbacks: [
    // Preserve the requested model id if that provider exposes the same id:
    // { id: "zen", provider: "opencode", model: "$requested" },
    // Or explicitly map to another model:
    // { id: "openrouter", provider: "openrouter", model: "qwen/qwen3-coder" },
    // { id: "anthropic", provider: "anthropic", model: "claude-sonnet-4-6" },
  ],
};
