import {
  ABILITY_CONFIG,
  MATCH_STATES,
  type AbilityType,
  type MatchState,
  type PickupType,
  type TankArchetypeId,
  type WeaponType
} from "./constants.js";

export const ROOM_MODES = ["classic", "wingman", "open_ffa", "agent_cup"] as const;
export type RoomMode = (typeof ROOM_MODES)[number];

export const AGENT_TRACKS = ["none", "custom"] as const;
export type AgentTrack = (typeof AGENT_TRACKS)[number];

export const CONTROL_KINDS = ["human", "agent"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

export const OWNER_PRINCIPAL_KINDS = ["combatant", "controller", "spectator"] as const;
export type OwnerPrincipalKind = (typeof OWNER_PRINCIPAL_KINDS)[number];

export const AGENT_SEAT_STATES = [
  "none",
  "pending",
  "connected",
  "paused",
  "reconnecting",
  "revoked",
  "disconnected"
] as const;
export type AgentSeatState = (typeof AGENT_SEAT_STATES)[number];

export const AGENT_CONTROL_ACTIONS = ["pause", "resume", "disconnect"] as const;
export type AgentControlAction = (typeof AGENT_CONTROL_ACTIONS)[number];

export const AGENT_CONTROL_MODES = ["macro_v1", "tactical_reflex_v1"] as const;
export type AgentControlMode = (typeof AGENT_CONTROL_MODES)[number];

export const AGENT_CONTROL_SCOPES = [
  "agent:observe",
  "agent:act",
  "agent:tactic",
  "agent:heartbeat",
  "agent:release"
] as const;
export type AgentControlScope = (typeof AGENT_CONTROL_SCOPES)[number];

export const AGENT_PROTOCOL_VERSION = 1 as const;
export const AGENT_TACTICAL_PROTOCOL_VERSION = 2 as const;
export const AGENT_OBSERVATION_VERSION = 1 as const;
export const AGENT_ACTION_VERSION = 1 as const;
export const AGENT_EXECUTOR_VERSION = 1 as const;
export const AGENT_TACTICAL_INTENT_VERSION = 1 as const;
export const AGENT_TACTICAL_REFLEX_VERSION = 1 as const;
export const AGENT_MAX_OWNERS = 8;
export const AGENT_MAX_HUMAN_WEBSOCKETS = 8;
export const AGENT_MAX_CONTROLS = 8;
export const AGENT_PRODUCTION_COMBATANT_CAP = 8;
export const AGENT_ABSOLUTE_COMBATANT_CAP = 16;
export const AGENT_OBSERVATION_INTERVAL_MS = 500;
export const AGENT_ACTION_INTERVAL_MS = 500;
export const AGENT_MAX_DECISIONS_PER_SECOND = 2;
export const AGENT_ACTION_MIN_LEASE_MS = 50;
export const AGENT_ACTION_MAX_LEASE_MS = 3_000;
export const AGENT_MAX_WAYPOINTS = 4;
export const AGENT_ID_MAX_LENGTH = 64;
export const AGENT_LABEL_MAX_LENGTH = 32;
export const AGENT_GRANT_TTL_MS = 60_000;
export const AGENT_HEARTBEAT_INTERVAL_MS = 5_000;
export const AGENT_CONTROL_IDLE_TIMEOUT_MS = 15_000;
export const AGENT_MOVING_SPEED_THRESHOLD = 5;
export const AGENT_TACTICAL_INTENT_MIN_DURATION_MS = 500;
export const AGENT_TACTICAL_INTENT_MAX_DURATION_MS = 210_000;
export const AGENT_TACTICAL_REFLEX_INTERVAL_MS = 500;
export const AGENT_TACTICAL_REFLEX_LEASE_MS = 1_000;
export const AGENT_TACTICAL_REFLEX_STEP_DISTANCE = 280;
export const AGENT_TACTICAL_COMBAT_DISTANCE = 320;
export const AGENT_TACTICAL_COMBAT_DISTANCE_TOLERANCE = 40;
export const AGENT_TACTICAL_ZONE_SAFETY_MARGIN = 64;

export const chooseAgentTacticalRetreat = (
  self: { x: number; z: number },
  target: { x: number; z: number },
  hullRotation: number,
  zoneCenter: { x: number; z: number },
  isAllowed: (point: { x: number; z: number }) => boolean
): { x: number; z: number } | undefined => {
  const targetDistance = Math.hypot(self.x - target.x, self.z - target.z);
  const zoneDistance = Math.hypot(zoneCenter.x - self.x, zoneCenter.z - self.z);
  const awayX = targetDistance > 0
    ? (self.x - target.x) / targetDistance
    : zoneDistance > 0
      ? (zoneCenter.x - self.x) / zoneDistance
      : -Math.cos(hullRotation);
  const awayZ = targetDistance > 0
    ? (self.z - target.z) / targetDistance
    : zoneDistance > 0
      ? (zoneCenter.z - self.z) / zoneDistance
      : -Math.sin(hullRotation);
  for (const distanceScale of [0.25, 0.5, 1]) {
    for (const angle of [
      0,
      Math.PI / 4,
      -Math.PI / 4,
      Math.PI * 3 / 8,
      -Math.PI * 3 / 8,
      Math.PI / 2,
      -Math.PI / 2
    ]) {
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const fullDistance = Math.min(
        AGENT_TACTICAL_REFLEX_STEP_DISTANCE,
        -targetDistance * cosine + Math.sqrt(Math.max(
          0,
          AGENT_TACTICAL_COMBAT_DISTANCE ** 2 - targetDistance ** 2 * sine ** 2
        ))
      );
      const distance = fullDistance * distanceScale;
      const point = {
        x: self.x + (awayX * cosine - awayZ * sine) * distance,
        z: self.z + (awayX * sine + awayZ * cosine) * distance
      };
      const separation = Math.hypot(point.x - target.x, point.z - target.z);
      if (separation > targetDistance + 0.001 && isAllowed(point)) return point;
    }
  }
  return undefined;
};

export interface RoomPolicy {
  mode: RoomMode;
  track: AgentTrack;
  ownerCap: number;
  humanWsCap: number;
  agentControlCap: number;
  combatantCap: number;
  observationVersion: typeof AGENT_OBSERVATION_VERSION;
  actionVersion: typeof AGENT_ACTION_VERSION;
  executorVersion: typeof AGENT_EXECUTOR_VERSION;
}

export interface RoomPolicyLimits {
  ownerCap?: number;
  humanWsCap?: number;
  agentControlCap?: number;
  combatantCap?: number;
  expandedCombatantsQualified?: boolean;
}

const ROOM_START_MINIMUMS = {
  classic: { owners: 2, combatants: 2 },
  wingman: { owners: 2, combatants: 4 },
  open_ffa: { owners: 1, combatants: 2 },
  agent_cup: { owners: 2, combatants: 2 }
} as const satisfies Record<RoomMode, { owners: number; combatants: number }>;

export const roomStartMinimums = (mode: RoomMode) => ROOM_START_MINIMUMS[mode];

const integerLimit = (
  name: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
};

export const buildRoomPolicy = (
  mode: RoomMode,
  limits: RoomPolicyLimits = {}
): RoomPolicy => {
  if (!ROOM_MODES.includes(mode)) throw new RangeError("unsupported room mode");

  const requestedOwners = integerLimit(
    "ownerCap",
    limits.ownerCap,
    AGENT_MAX_OWNERS,
    1,
    AGENT_MAX_OWNERS
  );
  const requestedHumanWs = integerLimit(
    "humanWsCap",
    limits.humanWsCap,
    AGENT_MAX_HUMAN_WEBSOCKETS,
    1,
    AGENT_MAX_HUMAN_WEBSOCKETS
  );
  const requestedAgentControls = integerLimit(
    "agentControlCap",
    limits.agentControlCap,
    AGENT_MAX_CONTROLS,
    0,
    AGENT_MAX_CONTROLS
  );
  const requestedCombatants = integerLimit(
    "combatantCap",
    limits.combatantCap,
    AGENT_PRODUCTION_COMBATANT_CAP,
    1,
    AGENT_ABSOLUTE_COMBATANT_CAP
  );
  if (
    requestedCombatants > AGENT_PRODUCTION_COMBATANT_CAP &&
    limits.expandedCombatantsQualified !== true
  ) {
    throw new RangeError("combatantCap above 8 requires explicit capacity qualification");
  }

  const ownerAndSocketCap = Math.min(requestedOwners, requestedHumanWs);
  const versions = {
    observationVersion: AGENT_OBSERVATION_VERSION,
    actionVersion: AGENT_ACTION_VERSION,
    executorVersion: AGENT_EXECUTOR_VERSION
  } as const;

  switch (mode) {
    case "classic": {
      const ownerCap = Math.min(ownerAndSocketCap, requestedCombatants);
      return {
        mode,
        track: "none",
        ownerCap,
        humanWsCap: ownerCap,
        agentControlCap: 0,
        combatantCap: ownerCap,
        ...versions
      };
    }
    case "wingman": {
      const ownerCap = Math.min(
        ownerAndSocketCap,
        requestedAgentControls,
        Math.floor(requestedCombatants / 2)
      );
      if (ownerCap < 1) throw new RangeError("wingman requires capacity for a complete pair");
      return {
        mode,
        track: "custom",
        ownerCap,
        humanWsCap: ownerCap,
        agentControlCap: ownerCap,
        combatantCap: ownerCap * 2,
        ...versions
      };
    }
    case "open_ffa": {
      const ownerCap = Math.min(ownerAndSocketCap, requestedCombatants);
      return {
        mode,
        track: "custom",
        ownerCap,
        humanWsCap: ownerCap,
        agentControlCap: Math.min(requestedAgentControls, ownerCap, requestedCombatants),
        combatantCap: requestedCombatants,
        ...versions
      };
    }
    case "agent_cup": {
      const ownerCap = Math.min(ownerAndSocketCap, requestedAgentControls, requestedCombatants);
      if (ownerCap < 1) throw new RangeError("agent_cup requires at least one agent control");
      return {
        mode,
        track: "custom",
        ownerCap,
        humanWsCap: ownerCap,
        agentControlCap: ownerCap,
        combatantCap: ownerCap,
        ...versions
      };
    }
  }
};

export interface AgentPositionV1 {
  x: number;
  z: number;
}

export interface AgentArenaBoundsV1 {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface AgentArenaWallV1 extends AgentPositionV1 {
  id: string;
  width: number;
  depth: number;
}

export interface AgentArenaDescriptorV1 {
  bounds: AgentArenaBoundsV1;
  walls: AgentArenaWallV1[];
}

export interface AgentConnectionDescriptorV1 {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  roomId: string;
  seatId: string;
  apiBaseUrl: string;
  brokerCredential: string;
  idleDeadlineMs: number;
  observationVersion: typeof AGENT_OBSERVATION_VERSION;
  actionVersion: typeof AGENT_ACTION_VERSION;
  arena: AgentArenaDescriptorV1;
}

export interface AgentTacticalConnectionDescriptorV2 {
  protocolVersion: typeof AGENT_TACTICAL_PROTOCOL_VERSION;
  controlMode: "tactical_reflex_v1";
  roomId: string;
  seatId: string;
  apiBaseUrl: string;
  brokerCredential: string;
  idleDeadlineMs: number;
  observationVersion: typeof AGENT_OBSERVATION_VERSION;
  tacticalIntentVersion: typeof AGENT_TACTICAL_INTENT_VERSION;
  reflexVersion: typeof AGENT_TACTICAL_REFLEX_VERSION;
  executorVersion: typeof AGENT_EXECUTOR_VERSION;
  arena: AgentArenaDescriptorV1;
}

export type AgentConnectionDescriptor =
  | AgentConnectionDescriptorV1
  | AgentTacticalConnectionDescriptorV2;

export interface AgentObservationV1 {
  version: typeof AGENT_OBSERVATION_VERSION;
  observationSeq: number;
  roomId: string;
  roundId: string;
  seatId: string;
  mode: RoomMode;
  track: "custom";
  matchState: Exclude<MatchState, "waiting">;
  serverTimeMs: number;
  arenaVersion: string;
  arenaUpdate?: AgentArenaDescriptorV1;
  self: {
    id: string;
    archetype: TankArchetypeId;
    position: AgentPositionV1;
    hullRotation: number;
    turretRotation: number;
    velocity: AgentPositionV1;
    health: number;
    maxHealth: number;
    armor: number;
    ammo: number;
    weapon: WeaponType;
    weaponCooldownMs: number;
    ability: AbilityType;
    abilityCharge: number;
    abilityCooldownMs: number;
    alive: boolean;
  };
  zone: {
    phase: string;
    centerX: number;
    centerZ: number;
    radius: number;
    nextChangeMs: number;
  };
  pickups: Array<{
    id: string;
    type: PickupType;
    x: number;
    z: number;
    active: boolean;
  }>;
  allies: Array<{
    id: string;
    archetype: TankArchetypeId;
    alive: boolean;
    position: AgentPositionV1 | null;
    motion: "stationary" | "moving" | "unknown";
  }>;
  opponents: Array<{
    id: string;
    ownerLabel: string;
    agentLabel: string | null;
    archetype: TankArchetypeId;
    alive: boolean;
    kills: number;
    placement: number | null;
    visible: boolean;
    position: AgentPositionV1 | null;
    motion: "stationary" | "moving" | "unknown";
  }>;
}

export interface AgentMacroActionV1 {
  version: typeof AGENT_ACTION_VERSION;
  actionSeq: number;
  basedOnObservationSeq: number;
  leaseMs: number;
  waypoints: AgentPositionV1[];
  pickupId?: string;
  targetId?: string;
  fire: "none" | "single" | "hold";
  useAbility: false | "once";
}

export type AgentTacticalObjectiveV1 =
  | { type: "hold" }
  | { type: "move_to"; position: AgentPositionV1 }
  | { type: "zone_center" }
  | { type: "engage_nearest" }
  | { type: "engage_target"; targetId: string }
  | { type: "collect_pickup"; pickupId: string };

export interface AgentTacticalIntentV1 {
  version: typeof AGENT_TACTICAL_INTENT_VERSION;
  intentSeq: number;
  basedOnObservationSeq: number | null;
  validForMs: number;
  objective: AgentTacticalObjectiveV1;
  fire: "none" | "single" | "hold";
  useAbility: false | "once";
  fallback: "hold";
}

export const AGENT_TACTICAL_STOP_REASONS = [
  "none",
  "no_intent",
  "waiting",
  "hold",
  "moving",
  "target_unavailable",
  "pickup_unavailable",
  "route_blocked",
  "objective_complete",
  "intent_expired",
  "cleared",
  "paused",
  "owner_unavailable",
  "match_inactive",
  "released"
] as const;
export type AgentTacticalStopReason = (typeof AGENT_TACTICAL_STOP_REASONS)[number];

export const AGENT_ERROR_CODES = [
  "agent_feature_disabled",
  "mode_disallows_agent",
  "owner_limit",
  "human_ws_limit",
  "agent_control_limit",
  "combatant_limit",
  "pending_exists",
  "grant_expired",
  "grant_consumed",
  "principal_mismatch",
  "agent_revoked",
  "agent_paused",
  "owner_unavailable",
  "stale_action",
  "stale_observation",
  "rate_limited",
  "target_not_visible",
  "lease_invalid",
  "control_mode_mismatch",
  "tactical_intent_invalid",
  "tactical_intent_expired",
  "room_not_waiting",
  "match_not_active"
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export interface AgentControlStatusV1 {
  version: typeof AGENT_PROTOCOL_VERSION;
  roomId: string;
  seatId: string;
  mode: RoomMode;
  track: "custom";
  state: AgentSeatState;
  matchState: MatchState;
  observationSeq: number;
  lastActionSeq: number;
  leaseExpiresAtMs: number | null;
  idleDeadlineMs: number;
}

export interface AgentActionResultV1 {
  version: typeof AGENT_ACTION_VERSION;
  type: "agent_action_result";
  actionSeq: number | null;
  accepted: boolean;
  code: "accepted" | AgentErrorCode;
  leaseExpiresAtMs: number | null;
}

export interface AgentTacticalIntentResultV1 {
  version: typeof AGENT_TACTICAL_INTENT_VERSION;
  type: "agent_tactical_intent_result";
  intentSeq: number | null;
  accepted: boolean;
  code: "accepted" | AgentErrorCode;
  intentExpiresAtMs: number | null;
}

export interface AgentTacticalStatusV1 {
  version: typeof AGENT_TACTICAL_INTENT_VERSION;
  type: "agent_tactical_status";
  roomId: string;
  seatId: string;
  mode: Exclude<RoomMode, "classic">;
  track: "custom";
  controlMode: "tactical_reflex_v1";
  state: AgentSeatState;
  matchState: MatchState;
  observationSeq: number;
  lastIntentSeq: number;
  intentExpiresAtMs: number | null;
  lastReflexAtMs: number | null;
  active: boolean;
  stopReason: AgentTacticalStopReason;
  idleDeadlineMs: number;
}

const TACTICAL_INTENT_RESULT_KEYS = [
  "version",
  "type",
  "intentSeq",
  "accepted",
  "code",
  "intentExpiresAtMs"
] as const;
const TACTICAL_STATUS_KEYS = [
  "version",
  "type",
  "roomId",
  "seatId",
  "mode",
  "track",
  "controlMode",
  "state",
  "matchState",
  "observationSeq",
  "lastIntentSeq",
  "intentExpiresAtMs",
  "lastReflexAtMs",
  "active",
  "stopReason",
  "idleDeadlineMs"
] as const;

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const nullablePositiveInteger = (value: unknown): value is number | null =>
  value === null || positiveInteger(value);

export const isAgentTacticalIntentResultV1 = (
  payload: unknown,
  expectedIntentSeq: number
): payload is AgentTacticalIntentResultV1 => {
  if (!isRecord(payload) || !exactKeys(payload, TACTICAL_INTENT_RESULT_KEYS)) return false;
  if (
    payload.version !== AGENT_TACTICAL_INTENT_VERSION ||
    payload.type !== "agent_tactical_intent_result" ||
    (payload.intentSeq !== null && payload.intentSeq !== expectedIntentSeq) ||
    typeof payload.accepted !== "boolean" ||
    (payload.code !== "accepted" && !AGENT_ERROR_CODES.includes(payload.code as AgentErrorCode))
  ) return false;
  return payload.accepted
    ? payload.intentSeq === expectedIntentSeq &&
        payload.code === "accepted" &&
        positiveInteger(payload.intentExpiresAtMs)
    : payload.code !== "accepted" && payload.intentExpiresAtMs === null;
};

export const isAgentTacticalStatusV1 = (
  payload: unknown,
  connection: Pick<AgentTacticalConnectionDescriptorV2, "roomId" | "seatId">
): payload is AgentTacticalStatusV1 =>
  isRecord(payload) &&
  exactKeys(payload, TACTICAL_STATUS_KEYS) &&
  payload.version === AGENT_TACTICAL_INTENT_VERSION &&
  payload.type === "agent_tactical_status" &&
  payload.roomId === connection.roomId &&
  payload.seatId === connection.seatId &&
  payload.mode !== "classic" &&
  ROOM_MODES.includes(payload.mode as RoomMode) &&
  payload.track === "custom" &&
  payload.controlMode === "tactical_reflex_v1" &&
  AGENT_SEAT_STATES.includes(payload.state as AgentSeatState) &&
  MATCH_STATES.includes(payload.matchState as MatchState) &&
  nonNegativeInteger(payload.observationSeq) &&
  nonNegativeInteger(payload.lastIntentSeq) &&
  nullablePositiveInteger(payload.intentExpiresAtMs) &&
  nullablePositiveInteger(payload.lastReflexAtMs) &&
  (payload.lastIntentSeq !== 0 || (
    payload.intentExpiresAtMs === null &&
    payload.lastReflexAtMs === null &&
    payload.active === false
  )) &&
  typeof payload.active === "boolean" &&
  AGENT_TACTICAL_STOP_REASONS.includes(payload.stopReason as AgentTacticalStopReason) &&
  (payload.active
    ? payload.state === "connected" &&
      (payload.matchState === "running" ||
        payload.matchState === "danger" ||
        payload.matchState === "final_zone") &&
      payload.intentExpiresAtMs !== null &&
      payload.lastReflexAtMs !== null &&
      (payload.stopReason === "moving" || payload.stopReason === "hold")
    : payload.stopReason !== "moving" && payload.stopReason !== "hold") &&
  positiveInteger(payload.idleDeadlineMs);

export interface AgentErrorV1 {
  version: typeof AGENT_PROTOCOL_VERSION;
  ok: false;
  error: { code: AgentErrorCode };
}

export const AGENT_ACTION_PARSE_ERROR_CODES = [
  "not_object",
  "unknown_key",
  "missing_key",
  "invalid_type",
  "invalid_value",
  "out_of_range"
] as const;
export type AgentActionParseErrorCode = (typeof AGENT_ACTION_PARSE_ERROR_CODES)[number];

export type AgentActionParseResult =
  | { ok: true; value: AgentMacroActionV1 }
  | {
      ok: false;
      error: {
        code: AgentActionParseErrorCode;
        field: string;
      };
    };

export type AgentTacticalIntentParseResult =
  | { ok: true; value: AgentTacticalIntentV1 }
  | {
      ok: false;
      error: {
        code: AgentActionParseErrorCode;
        field: string;
      };
    };

const ACTION_KEYS = new Set([
  "version",
  "actionSeq",
  "basedOnObservationSeq",
  "leaseMs",
  "waypoints",
  "pickupId",
  "targetId",
  "fire",
  "useAbility"
]);
const REQUIRED_ACTION_KEYS = [
  "version",
  "actionSeq",
  "basedOnObservationSeq",
  "leaseMs",
  "waypoints",
  "fire",
  "useAbility"
] as const;
const WAYPOINT_KEYS = new Set(["x", "z"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseFailure = (code: AgentActionParseErrorCode, field: string): AgentActionParseResult => ({
  ok: false,
  error: { code, field }
});

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= AGENT_ID_MAX_LENGTH &&
  value.trim() === value;

export const parseAgentMacroActionV1 = (payload: unknown): AgentActionParseResult => {
  if (!isRecord(payload)) return parseFailure("not_object", "$");

  for (const key of Object.keys(payload)) {
    if (!ACTION_KEYS.has(key)) return parseFailure("unknown_key", key);
  }
  for (const key of REQUIRED_ACTION_KEYS) {
    if (!Object.hasOwn(payload, key)) return parseFailure("missing_key", key);
  }

  if (payload.version !== AGENT_ACTION_VERSION) return parseFailure("invalid_value", "version");
  if (!Number.isSafeInteger(payload.actionSeq) || (payload.actionSeq as number) <= 0) {
    return parseFailure("out_of_range", "actionSeq");
  }
  if (
    !Number.isSafeInteger(payload.basedOnObservationSeq) ||
    (payload.basedOnObservationSeq as number) <= 0
  ) {
    return parseFailure("out_of_range", "basedOnObservationSeq");
  }
  if (!Number.isSafeInteger(payload.leaseMs)) return parseFailure("invalid_type", "leaseMs");
  if (
    (payload.leaseMs as number) < AGENT_ACTION_MIN_LEASE_MS ||
    (payload.leaseMs as number) > AGENT_ACTION_MAX_LEASE_MS
  ) {
    return parseFailure("out_of_range", "leaseMs");
  }
  if (!Array.isArray(payload.waypoints)) return parseFailure("invalid_type", "waypoints");
  if (payload.waypoints.length > AGENT_MAX_WAYPOINTS) {
    return parseFailure("out_of_range", "waypoints");
  }

  const waypoints: AgentPositionV1[] = [];
  for (let index = 0; index < payload.waypoints.length; index += 1) {
    const waypoint = payload.waypoints[index];
    const field = `waypoints[${index}]`;
    if (!isRecord(waypoint)) return parseFailure("invalid_type", field);
    for (const key of Object.keys(waypoint)) {
      if (!WAYPOINT_KEYS.has(key)) return parseFailure("unknown_key", `${field}.${key}`);
    }
    if (!Object.hasOwn(waypoint, "x")) return parseFailure("missing_key", `${field}.x`);
    if (!Object.hasOwn(waypoint, "z")) return parseFailure("missing_key", `${field}.z`);
    if (!Number.isFinite(waypoint.x)) return parseFailure("invalid_type", `${field}.x`);
    if (!Number.isFinite(waypoint.z)) return parseFailure("invalid_type", `${field}.z`);
    waypoints.push({ x: waypoint.x as number, z: waypoint.z as number });
  }

  if (payload.pickupId !== undefined && !validId(payload.pickupId)) {
    return parseFailure("invalid_value", "pickupId");
  }
  if (payload.targetId !== undefined && !validId(payload.targetId)) {
    return parseFailure("invalid_value", "targetId");
  }
  if (payload.fire !== "none" && payload.fire !== "single" && payload.fire !== "hold") {
    return parseFailure("invalid_value", "fire");
  }
  if (payload.useAbility !== false && payload.useAbility !== "once") {
    return parseFailure("invalid_value", "useAbility");
  }
  if (payload.fire !== "none" && payload.targetId === undefined) {
    return parseFailure("missing_key", "targetId");
  }

  return {
    ok: true,
    value: {
      version: AGENT_ACTION_VERSION,
      actionSeq: payload.actionSeq as number,
      basedOnObservationSeq: payload.basedOnObservationSeq as number,
      leaseMs: payload.leaseMs as number,
      waypoints,
      ...(payload.pickupId === undefined ? {} : { pickupId: payload.pickupId as string }),
      ...(payload.targetId === undefined ? {} : { targetId: payload.targetId as string }),
      fire: payload.fire,
      useAbility: payload.useAbility
    }
  };
};

const TACTICAL_INTENT_KEYS = new Set([
  "version",
  "intentSeq",
  "basedOnObservationSeq",
  "validForMs",
  "objective",
  "fire",
  "useAbility",
  "fallback"
]);
const REQUIRED_TACTICAL_INTENT_KEYS = [...TACTICAL_INTENT_KEYS];

export const parseAgentTacticalIntentV1 = (
  payload: unknown
): AgentTacticalIntentParseResult => {
  const fail = (code: AgentActionParseErrorCode, field: string): AgentTacticalIntentParseResult => ({
    ok: false,
    error: { code, field }
  });
  if (!isRecord(payload)) return fail("not_object", "$");
  for (const key of Object.keys(payload)) {
    if (!TACTICAL_INTENT_KEYS.has(key)) return fail("unknown_key", key);
  }
  for (const key of REQUIRED_TACTICAL_INTENT_KEYS) {
    if (!Object.hasOwn(payload, key)) return fail("missing_key", key);
  }
  if (payload.version !== AGENT_TACTICAL_INTENT_VERSION) return fail("invalid_value", "version");
  if (!Number.isSafeInteger(payload.intentSeq) || (payload.intentSeq as number) <= 0) {
    return fail("out_of_range", "intentSeq");
  }
  if (
    payload.basedOnObservationSeq !== null &&
    (!Number.isSafeInteger(payload.basedOnObservationSeq) ||
      (payload.basedOnObservationSeq as number) <= 0)
  ) return fail("out_of_range", "basedOnObservationSeq");
  if (!Number.isSafeInteger(payload.validForMs)) return fail("invalid_type", "validForMs");
  if (
    (payload.validForMs as number) < AGENT_TACTICAL_INTENT_MIN_DURATION_MS ||
    (payload.validForMs as number) > AGENT_TACTICAL_INTENT_MAX_DURATION_MS
  ) return fail("out_of_range", "validForMs");
  if (!isRecord(payload.objective)) return fail("invalid_type", "objective");

  let objective: AgentTacticalObjectiveV1;
  switch (payload.objective.type) {
    case "hold":
    case "zone_center":
    case "engage_nearest":
      if (Object.keys(payload.objective).length !== 1) return fail("unknown_key", "objective.*");
      objective = { type: payload.objective.type };
      break;
    case "move_to": {
      if (
        Object.keys(payload.objective).length !== 2 ||
        !Object.hasOwn(payload.objective, "position") ||
        !isRecord(payload.objective.position) ||
        Object.keys(payload.objective.position).some((key) => key !== "x" && key !== "z") ||
        !Object.hasOwn(payload.objective.position, "x") ||
        !Object.hasOwn(payload.objective.position, "z") ||
        !Number.isFinite(payload.objective.position.x) ||
        !Number.isFinite(payload.objective.position.z)
      ) return fail("invalid_value", "objective.position");
      objective = {
        type: "move_to",
        position: {
          x: payload.objective.position.x as number,
          z: payload.objective.position.z as number
        }
      };
      break;
    }
    case "engage_target":
      if (
        Object.keys(payload.objective).length !== 2 ||
        !validId(payload.objective.targetId)
      ) return fail("invalid_value", "objective.targetId");
      objective = { type: "engage_target", targetId: payload.objective.targetId };
      break;
    case "collect_pickup":
      if (
        Object.keys(payload.objective).length !== 2 ||
        !validId(payload.objective.pickupId)
      ) return fail("invalid_value", "objective.pickupId");
      objective = { type: "collect_pickup", pickupId: payload.objective.pickupId };
      break;
    default:
      return fail("invalid_value", "objective.type");
  }

  if (payload.fire !== "none" && payload.fire !== "single" && payload.fire !== "hold") {
    return fail("invalid_value", "fire");
  }
  if (
    payload.fire !== "none" &&
    objective.type !== "engage_target" &&
    objective.type !== "engage_nearest"
  ) {
    return fail("invalid_value", "fire");
  }
  if (payload.useAbility !== false && payload.useAbility !== "once") {
    return fail("invalid_value", "useAbility");
  }
  if (payload.fallback !== "hold") return fail("invalid_value", "fallback");

  return {
    ok: true,
    value: {
      version: AGENT_TACTICAL_INTENT_VERSION,
      intentSeq: payload.intentSeq as number,
      basedOnObservationSeq: payload.basedOnObservationSeq as number | null,
      validForMs: payload.validForMs as number,
      objective,
      fire: payload.fire,
      useAbility: payload.useAbility,
      fallback: "hold"
    }
  };
};

export interface SmokeConcealState {
  x: number;
  y: number;
  smokeEndsAt: number;
  smokeX: number;
  smokeY: number;
}

export const isPlayerConcealedBySmoke = (
  player: SmokeConcealState,
  now: number
): boolean =>
  player.smokeEndsAt > now &&
  Math.hypot(player.x - player.smokeX, player.y - player.smokeY) <= ABILITY_CONFIG.smoke.radius;
