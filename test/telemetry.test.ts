import assert from "node:assert/strict";
import test from "node:test";
import { recordRouterEvent, recordSessionMoved, recordUsage, snapshot } from "../src/telemetry.js";

function usageMessage(overrides = {}) {
  return { stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 40, cacheWrite: 2 }, ...overrides };
}

test("usage is counted per model with a cache-hit ratio", () => {
  recordUsage("tele-model-a", usageMessage());
  recordUsage("tele-model-a", { stopReason: "error", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const snap = snapshot(undefined);
  const stats = snap.models["tele-model-a"] as { requests: number; errors: number; cacheHitRatio: number };
  assert.equal(stats.requests, 2);
  assert.equal(stats.errors, 1);
  assert.ok(stats.cacheHitRatio > 0.7 && stats.cacheHitRatio <= 1);
});

test("routing events feed the per-account counters in /stats", () => {
  recordRouterEvent({ type: "opencode_account_selected", accountId: "tele-acc" });
  recordRouterEvent({ type: "opencode_account_succeeded", accountId: "tele-acc" });
  recordRouterEvent({ type: "opencode_account_failed", accountId: "tele-acc", failure: "quota" });
  const snap = snapshot({ accounts: [], stickySessions: new Map([["s1", "tele-acc"]]) });
  const routing = snap.routing["tele-acc"] as { selected: number; succeeded: number; failed: number; failures: Record<string, number> };
  assert.equal(routing.selected, 1);
  assert.equal(routing.succeeded, 1);
  assert.equal(routing.failed, 1);
  assert.equal(routing.failures.quota, 1);
  assert.equal(snap.stickySessions, 1);
});

test("idle moves are counted", () => {
  const before = snapshot(undefined).sessionsMovedAfterIdle as number;
  recordSessionMoved();
  assert.equal(snapshot(undefined).sessionsMovedAfterIdle, before + 1);
});
