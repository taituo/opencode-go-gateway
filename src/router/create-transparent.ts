import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { OpenCodeStackModels } from "./open-code-stack-models.js";
import type { OpenCodeGoAccountConfig, StackRouterEvent, TransparentRouterConfig } from "./types.js";

function accountKey(account: OpenCodeGoAccountConfig): string | undefined {
  if (account.apiKey) return account.apiKey;
  if (account.apiKeyEnv) return process.env[account.apiKeyEnv];
  return undefined;
}

export async function createTransparentModels(options: {
  config: TransparentRouterConfig;
  sessionId?: string;
  onEvent?: (event: StackRouterEvent) => void;
  /** Optional preconfigured normal Pi runtime for non-stacked providers. */
  manualRuntime?: ModelRuntime;
  /**
   * Mirror the first stack key into the normal runtime so Pi's existing model/account UI
   * sees `opencode-go` as configured. Requests still go through the stack wrapper.
   * Default: true.
   */
  mirrorPrimaryToManual?: boolean;
}) {
  const manual = options.manualRuntime ?? (await ModelRuntime.create());
  if (options.mirrorPrimaryToManual !== false) {
    const first = options.config.openCodeGo.accounts.find((account) => account.enabled !== false);
    const key = first ? accountKey(first) : undefined;
    if (key) await manual.setRuntimeApiKey("opencode-go", key);
  }

  const models = await OpenCodeStackModels.create({
    config: options.config,
    sessionId: options.sessionId,
    onEvent: options.onEvent,
    manualRuntime: manual,
  });
  return { manual, models };
}
