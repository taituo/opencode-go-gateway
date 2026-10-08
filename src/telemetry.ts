/** In-process gateway telemetry: per-model usage (incl. prompt-cache reads) and routing events. Reset on restart. */
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type ModelStats = { requests: number; errors: number } & Usage;
const startedAt = Date.now();
const perModel = new Map<string, ModelStats>();
const perAccount = new Map<string, { selected: number; succeeded: number; failed: number; failures: Record<string, number> }>();
let sessionsMoved = 0;

const modelStats = (id: string): ModelStats => {
  let s = perModel.get(id);
  if (!s) perModel.set(id, (s = { requests: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
  return s;
};

export function recordUsage(modelId: string, message: { stopReason?: string; usage?: Partial<Usage> }): void {
  const s = modelStats(modelId);
  s.requests++;
  if (message.stopReason === "error") s.errors++;
  const u = message.usage ?? {};
  s.input += u.input ?? 0; s.output += u.output ?? 0; s.cacheRead += u.cacheRead ?? 0; s.cacheWrite += u.cacheWrite ?? 0;
}

export function recordRouterEvent(event: { type: string; accountId?: string; failure?: string }): void {
  if (!event.accountId) return;
  let a = perAccount.get(event.accountId);
  if (!a) perAccount.set(event.accountId, (a = { selected: 0, succeeded: 0, failed: 0, failures: {} }));
  if (event.type === "opencode_account_selected") a.selected++;
  else if (event.type === "opencode_account_succeeded") a.succeeded++;
  else if (event.type === "opencode_account_failed") { a.failed++; const f = event.failure ?? "unknown"; a.failures[f] = (a.failures[f] ?? 0) + 1; }
}
export const recordSessionMoved = () => { sessionsMoved++; };

export function snapshot(inspection: { accounts: unknown[]; stickySessions: ReadonlyMap<string, string> } | undefined) {
  const models = Object.fromEntries([...perModel].map(([id, s]) => [id, { ...s, cacheHitRatio: s.input + s.cacheRead ? +(s.cacheRead / (s.input + s.cacheRead)).toFixed(3) : null }]));
  return {
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    sessionsMovedAfterIdle: sessionsMoved,
    stickySessions: inspection?.stickySessions.size ?? 0,
    accounts: inspection?.accounts ?? [],
    routing: Object.fromEntries(perAccount),
    models,
  };
}
