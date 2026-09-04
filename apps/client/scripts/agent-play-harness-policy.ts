import {
  AGENT_ACTION_VERSION,
  AGENT_ERROR_CODES,
  AGENT_MAX_OWNERS,
  AGENT_PRODUCTION_COMBATANT_CAP,
  AGENT_TACTICAL_COMBAT_DISTANCE,
  AGENT_TACTICAL_COMBAT_DISTANCE_TOLERANCE,
  type AgentErrorCode,
  type RoomMode
} from "@alpha7/shared";

const TACTICAL_UNSUPPORTED_FLAGS = [
  "--duration-ms",
  "--idle-expiry",
  "--lifecycle",
  "--owners",
  "--rematch",
  "--revoke",
  "--smoke",
  "--verify-capacity"
] as const;

export const tacticalUnsupportedFlag = (args: readonly string[]): string | undefined =>
  TACTICAL_UNSUPPORTED_FLAGS.find((flag) => args.includes(flag));

export const isLoopbackTarget = (url: string): boolean =>
  ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname);

export const harnessTargetsMatch = (wsUrl: string, httpUrl: string): boolean => {
  const wsTarget = new URL(wsUrl);
  const httpTarget = new URL(httpUrl);
  const port = (url: URL): string =>
    url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  return port(wsTarget) === port(httpTarget) && (
    wsTarget.hostname === httpTarget.hostname ||
    (isLoopbackTarget(wsUrl) && isLoopbackTarget(httpUrl))
  );
};

export const agentFailureCode = (payload: unknown): AgentErrorCode | undefined => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && AGENT_ERROR_CODES.includes(code as AgentErrorCode)
    ? code as AgentErrorCode
    : undefined;
};

interface HarnessCapacityProfile {
  mode: Exclude<RoomMode, "classic">;
  ownerCount: number;
  expectedCombatants: number;
  expandedCombatantsEnabled: boolean;
  cupMaxControlsEnabled: boolean;
}

export const capacityFlagsMatchProfile = ({
  mode,
  ownerCount,
  expectedCombatants,
  expandedCombatantsEnabled,
  cupMaxControlsEnabled
}: HarnessCapacityProfile): boolean => {
  const expectedForMode = mode === "agent_cup" ? ownerCount : ownerCount * 2;
  return (
    Number.isInteger(ownerCount) &&
    ownerCount >= 2 &&
    ownerCount <= AGENT_MAX_OWNERS &&
    expectedCombatants === expectedForMode &&
    expandedCombatantsEnabled === (
      mode !== "agent_cup" && expectedCombatants > AGENT_PRODUCTION_COMBATANT_CAP
    ) &&
    cupMaxControlsEnabled === (mode === "agent_cup" && ownerCount > 2)
  );
};

export interface HarnessAgentActionResult {
  version?: unknown;
  type?: unknown;
  actionSeq?: unknown;
  accepted?: unknown;
  code?: unknown;
  error?: { code?: unknown };
  leaseExpiresAtMs?: unknown;
}

export const agentActionResultCode = (result: HarnessAgentActionResult): string | undefined =>
  typeof result.code === "string"
    ? result.code
    : typeof result.error?.code === "string"
      ? result.error.code
      : undefined;

export const isRetryableAuthoritativeStaleActionRejection = (
  responseOk: boolean,
  result: HarnessAgentActionResult,
  expectedActionSeq: number
): boolean =>
  responseOk &&
  result.version === AGENT_ACTION_VERSION &&
  result.type === "agent_action_result" &&
  result.actionSeq === expectedActionSeq &&
  result.accepted === false &&
  result.leaseExpiresAtMs === null &&
  (result.code === "target_not_visible" || result.code === "lease_invalid");

export const tacticalMotionGapsWithinLimits = (
  gaps: { p50: number; p95: number }
): boolean => gaps.p50 <= 50 && gaps.p95 <= 100;

export const tacticalMovementDemanded = (
  targetDistance: number,
  retreatAvailable: boolean,
  outsideSafeZone = false
): boolean =>
  outsideSafeZone ||
  targetDistance > AGENT_TACTICAL_COMBAT_DISTANCE + AGENT_TACTICAL_COMBAT_DISTANCE_TOLERANCE ||
  (targetDistance < AGENT_TACTICAL_COMBAT_DISTANCE - AGENT_TACTICAL_COMBAT_DISTANCE_TOLERANCE && retreatAvailable);
