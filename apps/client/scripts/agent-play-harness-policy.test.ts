import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agentFailureCode,
  capacityFlagsMatchProfile,
  harnessTargetsMatch,
  isRetryableAuthoritativeStaleActionRejection,
  tacticalUnsupportedFlag,
  tacticalMovementDemanded,
  tacticalMotionGapsWithinLimits,
  type HarnessAgentActionResult
} from "./agent-play-harness-policy.js";

it("requires harness WebSocket and HTTP targets to resolve to the same endpoint", () => {
  expect(harnessTargetsMatch("ws://localhost:2567", "http://127.0.0.1:2567")).toBe(true);
  expect(harnessTargetsMatch("wss://capacity.example", "https://capacity.example")).toBe(true);
  expect(harnessTargetsMatch("ws://localhost:2567", "http://localhost:9999")).toBe(false);
  expect(harnessTargetsMatch("wss://one.example", "https://two.example")).toBe(false);
});

describe("agent-play harness capacity flag policy", () => {
  const profile = (
    mode: "wingman" | "open_ffa" | "agent_cup",
    ownerCount: number,
    expectedCombatants: number,
    expandedCombatantsEnabled: boolean,
    cupMaxControlsEnabled: boolean
  ) => ({ mode, ownerCount, expectedCombatants, expandedCombatantsEnabled, cupMaxControlsEnabled });

  it.each([
    ["capped Wingman", profile("wingman", 4, 8, false, false)],
    ["capped Open FFA", profile("open_ffa", 4, 8, false, false)],
    ["expanded Wingman", profile("wingman", 8, 16, true, false)],
    ["expanded Open FFA", profile("open_ffa", 8, 16, true, false)],
    ["capped Agent Cup", profile("agent_cup", 2, 2, false, false)],
    ["maximum Agent Cup", profile("agent_cup", 8, 8, false, true)]
  ])("accepts %s flags", (_label, capacityProfile) => {
    expect(capacityFlagsMatchProfile(capacityProfile)).toBe(true);
  });

  it.each([
    ["expanded flag on capped Wingman", profile("wingman", 4, 8, true, false)],
    ["missing expanded flag", profile("open_ffa", 8, 16, false, false)],
    ["Cup flag on Wingman", profile("wingman", 8, 16, true, true)],
    ["missing maximum Cup flag", profile("agent_cup", 8, 8, false, false)],
    ["maximum Cup flag on capped Cup", profile("agent_cup", 2, 2, false, true)],
    ["expanded flag on Cup", profile("agent_cup", 8, 8, true, true)],
    ["contradictory Wingman count", profile("wingman", 8, 8, false, false)],
    ["contradictory Cup count", profile("agent_cup", 8, 16, true, true)],
    ["owner count below profile minimum", profile("open_ffa", 1, 2, false, false)],
    ["owner count above profile maximum", profile("agent_cup", 9, 9, false, true)]
  ])("rejects %s", (_label, capacityProfile) => {
    expect(capacityFlagsMatchProfile(capacityProfile)).toBe(false);
  });
});

const authoritativeRejection = (
  code: "target_not_visible" | "lease_invalid",
  actionSeq: number | null = 7
): HarnessAgentActionResult => ({
  version: 1,
  type: "agent_action_result",
  actionSeq,
  accepted: false,
  code,
  leaseExpiresAtMs: null
});

describe("agent-play harness action retry policy", () => {
  const cases: Array<[string, boolean, HarnessAgentActionResult, boolean]> = [
    ["visible target changed", true, authoritativeRejection("target_not_visible"), true],
    ["route changed", true, authoritativeRejection("lease_invalid"), true],
    ["transport rejected", false, authoritativeRejection("lease_invalid"), false],
    ["transport error envelope", true, { error: { code: "lease_invalid" } }, false],
    ["schema parse failed", true, authoritativeRejection("lease_invalid", null), false],
    ["sequence mismatched", true, authoritativeRejection("target_not_visible", 8), false],
    ["cadence rejected", true, { ...authoritativeRejection("lease_invalid"), code: "rate_limited" }, false]
  ];

  it.each(cases)("classifies %s", (_label, responseOk, result, expected) => {
    expect(isRetryableAuthoritativeStaleActionRejection(responseOk, result, 7)).toBe(expected);
  });
});

it("enforces tactical p50 and p95 motion-gap limits", () => {
  expect(tacticalMotionGapsWithinLimits({ p50: 50, p95: 100 })).toBe(true);
  expect(tacticalMotionGapsWithinLimits({ p50: 50.01, p95: 80 })).toBe(false);
  expect(tacticalMotionGapsWithinLimits({ p50: 40, p95: 100.01 })).toBe(false);
});

it("demands Tactical motion only outside the combat band when the escape is clear", () => {
  expect(tacticalMovementDemanded(361, false)).toBe(true);
  expect(tacticalMovementDemanded(360, true)).toBe(false);
  expect(tacticalMovementDemanded(280, true)).toBe(false);
  expect(tacticalMovementDemanded(279, true)).toBe(true);
  expect(tacticalMovementDemanded(279, false)).toBe(false);
  expect(tacticalMovementDemanded(320, false, true)).toBe(true);
});

it("rejects legacy harness flags that Tactical mode cannot honor", () => {
  for (const flag of [
    "--duration-ms",
    "--idle-expiry",
    "--lifecycle",
    "--owners",
    "--rematch",
    "--revoke",
    "--smoke",
    "--verify-capacity"
  ]) expect(tacticalUnsupportedFlag(["--tactical-reflex", flag])).toBe(flag);
  expect(tacticalUnsupportedFlag(["--tactical-reflex", "--verify-cleanup"])).toBeUndefined();
});

it("preserves only documented agent failure codes", () => {
  expect(agentFailureCode({ error: { code: "agent_paused" } })).toBe("agent_paused");
  expect(agentFailureCode({ error: { code: "internal detail" } })).toBeUndefined();
  expect(agentFailureCode({ code: "agent_paused" })).toBeUndefined();
});

it("checks remote environment identity before every mutating harness mode", () => {
  const source = readFileSync(new URL("./agent-play-harness.ts", import.meta.url), "utf8");
  const dispatch = source.slice(source.indexOf("const runHarness"));
  expect(dispatch.indexOf("await assertSafeHarnessTarget()"))
    .toBeLessThan(dispatch.indexOf("tacticalReflex ?"));
});

it("makes lifecycle waits abort-aware and verifies tactical cleanup after teardown", () => {
  const source = readFileSync(new URL("./agent-play-harness.ts", import.meta.url), "utf8");
  expect(source).toContain("if (signal?.aborted) throw new Error(`${label} interrupted`)");
  expect(source).toContain("if (verifyCleanup && evidence) evidence.cleanup = await verifyCleanupHold(cleanupHoldMs)");
});
