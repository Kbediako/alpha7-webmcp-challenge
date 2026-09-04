import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  CloseCode,
  ErrorCode,
  Room,
  ServerError,
  type AuthContext,
  type Client,
  type Delayed
} from "colyseus";
import {
  ABILITY_CONFIG,
  AGENT_ACTION_INTERVAL_MS,
  AGENT_ACTION_VERSION,
  AGENT_CONTROL_IDLE_TIMEOUT_MS,
  AGENT_EXECUTOR_VERSION,
  AGENT_MAX_WAYPOINTS,
  AGENT_MOVING_SPEED_THRESHOLD,
  AGENT_OBSERVATION_INTERVAL_MS,
  AGENT_OBSERVATION_VERSION,
  AGENT_PROTOCOL_VERSION,
  AGENT_PRODUCTION_COMBATANT_CAP,
  AGENT_TACTICAL_INTENT_VERSION,
  AGENT_TACTICAL_COMBAT_DISTANCE,
  AGENT_TACTICAL_COMBAT_DISTANCE_TOLERANCE,
  AGENT_TACTICAL_PROTOCOL_VERSION,
  AGENT_TACTICAL_REFLEX_INTERVAL_MS,
  AGENT_TACTICAL_REFLEX_LEASE_MS,
  AGENT_TACTICAL_REFLEX_STEP_DISTANCE,
  AGENT_TACTICAL_REFLEX_VERSION,
  AGENT_TACTICAL_ZONE_SAFETY_MARGIN,
  BATTLE_ROYALE_ROOM,
  CLIENT_MESSAGE_TYPES,
  PICKUP_CONFIG,
  RAPID_FIRE_COOLDOWN_MULTIPLIER,
  SERVER_MESSAGE_TYPES,
  TANK_COLLISION_RADIUS,
  TANK_ARCHETYPE_CONFIG,
  TANK_ARCHETYPES,
  WEAPON_CONFIG,
  ROOM_MODES,
  buildRoomPolicy,
  clampToArena,
  chooseAgentTacticalRetreat,
  generateArenaConfig,
  integrateTankMovement,
  isWallCollision,
  isPlayerConcealedBySmoke,
  parseAgentMacroActionV1,
  parseAgentTacticalIntentV1,
  resolveTankCollisionMovement,
  roomStartMinimums,
  type AbilityMessagePayload,
  type AgentControlPayload,
  type AgentActionResultV1,
  type AgentArenaDescriptorV1,
  type AgentControlStatusV1,
  type AgentMacroActionV1,
  type AgentObservationV1,
  type AgentPairingCancelPayload,
  type AgentPairingCreatePayload,
  type AgentTacticalIntentResultV1,
  type AgentTacticalIntentV1,
  type AgentTacticalStatusV1,
  type AgentTacticalStopReason,
  type ArenaConfig,
  type ArenaPoint,
  type ArenaRect,
  type ErrorMessageCode,
  type FireMessagePayload,
  type InputMessagePayload,
  type JoinMessagePayload,
  type MatchState,
  type ProjectileImpactMessagePayload,
  type ReadyMessagePayload,
  type RematchMessagePayload,
  type RoomMode,
  type RoomPolicy,
  type StartMessagePayload,
  type SystemMessageCode,
  type SystemMessagePayload,
  type TankArchetypeId
} from "@alpha7/shared";
import {
  Alpha7StateSchema,
  OwnerSchema,
  PickupSchema,
  PlayerSchema,
  ProjectileSchema
} from "@alpha7/shared/schema";
import {
  AgentBrokerError,
  agentBroker,
  type AgentBrokerSession,
  type AgentControlPrincipal
} from "../agentBroker.js";
import type { ServerConfig } from "../config.js";
import {
  createHumanAdmission,
  isHumanPrincipal,
  sanitizeDisplayName,
  trustedRequestSourceKey,
  type HumanPrincipal
} from "../humanAdmission.js";

const COUNTDOWN_MS = 5_000;
const DANGER_AFTER_RUNNING_MS = 90_000;
const FINAL_ZONE_AFTER_RUNNING_MS = 150_000;
const FINISHED_AFTER_RUNNING_MS = 210_000;
const DEFAULT_ARENA_SIZE = 2_200;
const MAX_SIMULATION_DELTA_MS = 100;
const INPUT_INTENT_TTL_MS = 300;
const MAX_ABILITY_CHARGE = 100;
const ABILITY_CHARGE_PER_SECOND = 4;
const DAMAGE_TO_CHARGE_RATIO = 0.18;
const DAMAGE_TAKEN_CHARGE_RATIO = 0.1;
const REPAIR_HEALTH_AMOUNT = 28;
const REPAIR_ARMOR_AMOUNT = 12;
const SHIELD_PULSE_AMOUNT = 40;
const SPEED_BURST_MULTIPLIER = 1.55;
const SMOKE_DAMAGE_REDUCTION = 0.4;
const PROJECTILE_MUZZLE_FRONT_DISTANCE = 71;
const PROJECTILE_VISUAL_LEAD_PADDING = 2;
const PROJECTILE_MIN_SPAWN_PADDING = 8;
const AGENT_AUDIT_CAPACITY = 65_536;
const AGENT_TURNING_INPUT_MAGNITUDE = 0.08;
const AGENT_WAYPOINT_REACHED_DISTANCE = 8;
const AGENT_TARGET_POSITION_MAX_ERROR = Math.SQRT2 * 12.5;
const AGENT_TACTICAL_ROUTE_REPAIR_INTERVAL_MS = 100;
const AGENT_TACTICAL_ZONE_STAGING_RADIUS = 32;

const makeRoomCode = (): string => Math.random().toString(36).slice(2, 8).toUpperCase();

const auditMacroAction = (action: AgentMacroActionV1, includeValidatedIds = false) => ({
  actionSeq: action.actionSeq,
  basedOnObservationSeq: action.basedOnObservationSeq,
  leaseMs: action.leaseMs,
  waypoints: action.waypoints.map((waypoint) => ({ x: waypoint.x, z: waypoint.z })),
  pickupId: includeValidatedIds ? action.pickupId ?? null : null,
  targetId: includeValidatedIds ? action.targetId ?? null : null,
  fire: action.fire,
  useAbility: action.useAbility
});

const resolveRoomMode = (value: unknown, enabled: boolean): RoomMode => {
  const mode = value === undefined ? "classic" : value;
  if (typeof mode !== "string" || !ROOM_MODES.includes(mode as RoomMode)) {
    throw new ServerError(ErrorCode.APPLICATION_ERROR, "unsupported room mode");
  }
  if (mode !== "classic" && !enabled) {
    throw new ServerError(ErrorCode.APPLICATION_ERROR, "agent play is disabled");
  }
  return mode as RoomMode;
};

interface BattleRoyaleCreateOptions {
  config: ServerConfig;
  recordSimulationTick?: (startTimeMs: number, durationMs: number) => void;
  privateRoom?: unknown;
  private?: unknown;
  seed?: unknown;
  roomMode?: unknown;
}

interface BattleRoyaleRoomMetadata {
  roomName: typeof BATTLE_ROYALE_ROOM;
  roomCode: string;
  private: boolean;
  matchState: MatchState;
  playerCount: number;
  maxClients: number;
  mode: RoomMode;
  roomMode: RoomMode;
  track: RoomPolicy["track"];
  combatantCap: number;
  seed: string;
}

interface StoredInputIntent extends InputMessagePayload {
  receivedAt: number;
}

interface MovementIntent {
  moveX: number;
  moveY: number;
  aimX?: number;
  aimY?: number;
}

interface StoredFireIntent extends Omit<FireMessagePayload, "weaponType"> {
  receivedAt: number;
}

interface StoredAbilityIntent extends Required<Pick<AbilityMessagePayload, "sequence" | "abilityType">> {
  targetX?: number;
  targetY?: number;
  receivedAt: number;
}

interface AgentLease {
  action: AgentMacroActionV1;
  expiresAtMs: number;
  waypointIndex: number;
  singleFireUsed: boolean;
  abilityUsed: boolean;
  tacticalTerminal?: boolean;
  tacticalRetreat?: boolean;
  tacticalApproach?: boolean;
  tacticalZoneRecovery?: boolean;
  tacticalZoneTarget?: { x: number; z: number; radius: number };
  tacticalContinuation?: { moveX: number; moveY: number };
  targetPosition?: { x: number; z: number };
}

interface AgentRuntime {
  principal: AgentControlPrincipal;
  paused: boolean;
  brokerRevision: number;
  idleDeadlineMs: number;
  observationSeq: number;
  observationRoundId: string;
  lastObservationAtMs: number;
  lastActionAtMs: number;
  lastActionSeq: number;
  lowLevelSequence: number;
  arenaVersion: string;
  visibleTargets: Map<string, { x: number; z: number }>;
  lastIntentAtMs: number;
  lastIntentSeq: number;
  lastReflexAtMs: number;
  internalMacroSequence: number;
  tacticalStopReason: AgentTacticalStopReason;
  tacticalTurnStartedAtMs?: number;
  tacticalTurningToClear?: boolean;
  tacticalRouteRepairAtMs?: number;
  tacticalRouteRepairKey?: string;
  openingTacticalIntent?: AgentTacticalIntentV1;
  tactical?: {
    intent: AgentTacticalIntentV1;
    roundId: string;
    expiresAtMs: number;
    singleFireUsed: boolean;
    abilityUsed: boolean;
    selectedTargetId?: string;
  };
  lease?: AgentLease;
}

interface AgentWorldProjection {
  self: AgentObservationV1["self"];
  zone: AgentObservationV1["zone"];
  pickups: AgentObservationV1["pickups"];
  allies: AgentObservationV1["allies"];
  opponents: AgentObservationV1["opponents"];
  visibleTargets: Map<string, { x: number; z: number }>;
}

interface ArenaBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width?: number;
  height?: number;
}

interface TimedShieldEffect {
  expiresAt: number;
  remaining: number;
}

interface TimedMultiplierEffect {
  expiresAt: number;
  multiplier: number;
}

interface TimedReductionEffect {
  expiresAt: number;
  reduction: number;
  x: number;
  y: number;
  radius: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const positiveNumberOr = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;

const angleTo = (fromX: number, fromY: number, toX: number, toY: number): number =>
  Math.atan2(toY - fromY, toX - fromX);

const lerp = (from: number, to: number, progress: number): number => from + (to - from) * progress;

const projectileRadius = (weaponType: PlayerSchema["weaponType"]): number => {
  switch (weaponType) {
    case "machine_gun":
      return 4;
    case "light_cannon":
      return 6;
    case "explosive":
      return 10;
    default:
      return 8;
  }
};

const projectileVisualLeadDistance = (radius: number): number => Math.max(radius + 4, radius * 1.75);

const projectileSpawnDistance = (radius: number): number =>
  PROJECTILE_MUZZLE_FRONT_DISTANCE + projectileVisualLeadDistance(radius) + PROJECTILE_VISUAL_LEAD_PADDING;

const agentMinimumFireDistance = (): number => TANK_COLLISION_RADIUS * 2 + 12;

const totalDurability = (player: PlayerSchema): number => player.health + player.armor + player.shield;

const segmentCircleFirstEntry = (
  centerX: number,
  centerY: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number
): { t: number; x: number; y: number } | undefined => {
  const dx = bx - ax;
  const dy = by - ay;
  const fromCenterX = ax - centerX;
  const fromCenterY = ay - centerY;
  const radiusSquared = radius * radius;
  const startDistanceSquared = fromCenterX * fromCenterX + fromCenterY * fromCenterY;
  if (startDistanceSquared <= radiusSquared) {
    return { t: 0, x: ax, y: ay };
  }

  if (dx === 0 && dy === 0) {
    return undefined;
  }

  const a = dx * dx + dy * dy;
  const b = 2 * (fromCenterX * dx + fromCenterY * dy);
  const c = startDistanceSquared - radiusSquared;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return undefined;

  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  if (t < 0 || t > 1) return undefined;
  return { t, x: lerp(ax, bx, t), y: lerp(ay, by, t) };
};

const routeClearsCircle = (
  startX: number,
  startZ: number,
  waypoints: Array<{ x: number; z: number }>,
  circle: { x: number; z: number; radius: number }
): boolean => {
  const collisionRadius = Math.max(0, circle.radius - 0.001);
  let fromX = startX;
  let fromZ = startZ;
  for (const waypoint of waypoints) {
    if (segmentCircleFirstEntry(
      circle.x,
      circle.z,
      fromX,
      fromZ,
      waypoint.x,
      waypoint.z,
      collisionRadius
    )) return false;
    fromX = waypoint.x;
    fromZ = waypoint.z;
  }
  return true;
};

const segmentExpandedRectHitT = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rect: Pick<ArenaRect, "x" | "y" | "width" | "height">,
  radius: number
): number | undefined => {
  const minX = rect.x - radius;
  const minY = rect.y - radius;
  const maxX = rect.x + rect.width + radius;
  const maxY = rect.y + rect.height + radius;
  const dx = bx - ax;
  const dy = by - ay;
  let tMin = 0;
  let tMax = 1;

  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > tMax) return false;
      if (t > tMin) tMin = t;
    } else {
      if (t < tMin) return false;
      if (t < tMax) tMax = t;
    }
    return true;
  };

  if (
    !clip(-dx, ax - minX) ||
    !clip(dx, maxX - ax) ||
    !clip(-dy, ay - minY) ||
    !clip(dy, maxY - ay)
  ) {
    return undefined;
  }

  return clamp(tMin, 0, 1);
};

const tankRouteSegmentBlocked = (
  arena: ArenaConfig,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number
): boolean => {
  if (isWallCollision(arena, ax, ay, radius) || isWallCollision(arena, bx, by, radius)) {
    return true;
  }
  return arena.collisionRects.some((rect) =>
    segmentExpandedRectHitT(ax, ay, bx, by, {
      x: rect.x - radius,
      y: rect.y,
      width: rect.width + radius * 2,
      height: rect.height
    }, 0) !== undefined ||
    segmentExpandedRectHitT(ax, ay, bx, by, {
      x: rect.x,
      y: rect.y - radius,
      width: rect.width,
      height: rect.height + radius * 2
    }, 0) !== undefined ||
    [
      [rect.x, rect.y],
      [rect.x + rect.width, rect.y],
      [rect.x, rect.y + rect.height],
      [rect.x + rect.width, rect.y + rect.height]
    ].some(([cornerX, cornerY]) =>
      segmentCircleFirstEntry(cornerX!, cornerY!, ax, ay, bx, by, radius) !== undefined
    )
  );
};

const projectileWallHit = (
  arena: ArenaConfig,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number
): { hit: boolean; x: number; y: number; t: number } => {
  let nearestT: number | undefined;

  for (const rect of arena.collisionRects) {
    const t = segmentExpandedRectHitT(ax, ay, bx, by, rect, radius);
    if (t === undefined) continue;
    if (nearestT === undefined || t < nearestT) nearestT = t;
  }

  if (nearestT !== undefined) {
    return {
      hit: true,
      x: lerp(ax, bx, nearestT),
      y: lerp(ay, by, nearestT),
      t: nearestT
    };
  }

  const clamped = clampArenaBounds(arena, bx, by, radius);
  return {
    hit: clamped.x !== bx || clamped.y !== by,
    x: clamped.x,
    y: clamped.y,
    t: 1
  };
};

const deterministicSpread = (sequence: number, spreadRadians: number): number => {
  if (spreadRadians <= 0) return 0;
  const normalized = Math.sin(sequence * 12.9898) * 43758.5453;
  const fraction = normalized - Math.floor(normalized);
  return (fraction * 2 - 1) * spreadRadians;
};

const tacticalSteeringMagnitude = (
  rotation: number,
  directionX: number,
  directionY: number
): number => {
  const desiredHeading = Math.atan2(directionY, directionX);
  const headingDelta = Math.abs(Math.atan2(
    Math.sin(desiredHeading - rotation),
    Math.cos(desiredHeading - rotation)
  ));
  const drivetrainDelta = Math.min(headingDelta, Math.PI - headingDelta);
  return Math.max(AGENT_TURNING_INPUT_MAGNITUDE, Math.cos(drivetrainDelta) ** 4);
};

const getArenaBounds = (arena: ArenaConfig): ArenaBounds => {
  const compatibilityBounds = (arena as ArenaConfig & { bounds?: ArenaBounds }).bounds;
  if (compatibilityBounds) return compatibilityBounds;
  const width = positiveNumberOr(arena.width, DEFAULT_ARENA_SIZE);
  const height = positiveNumberOr(arena.height, DEFAULT_ARENA_SIZE);
  return {
    minX: 0,
    minY: 0,
    maxX: width,
    maxY: height,
    width,
    height
  };
};

const clampArenaBounds = (
  arena: ArenaConfig,
  x: number,
  y: number,
  radius: number
): ArenaPoint => {
  const bounds = getArenaBounds(arena);
  return {
    x: clamp(x, bounds.minX + radius, bounds.maxX - radius),
    y: clamp(y, bounds.minY + radius, bounds.maxY - radius)
  };
};

const intervalFromRate = (rate: number, fallback: number): number => {
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : fallback;
  return Math.max(1, Math.round(1_000 / safeRate));
};

const booleanOption = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
};

const safeSeed = (value: unknown): string =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, 64)
    : `alpha7-${randomUUID()}`;

const isTankArchetypeId = (value: unknown): value is TankArchetypeId =>
  typeof value === "string" && TANK_ARCHETYPES.includes(value as TankArchetypeId);

const parseJoinPayload = (payload: unknown): JoinMessagePayload | undefined => {
  if (!isRecord(payload) || !isTankArchetypeId(payload.archetypeId)) return undefined;

  return {
    playerName: sanitizeDisplayName(payload.playerName, "Player"),
    archetypeId: payload.archetypeId,
    clientVersion: typeof payload.clientVersion === "string" ? payload.clientVersion.slice(0, 32) : undefined
  };
};

const parseReadyPayload = (payload: unknown): ReadyMessagePayload | undefined =>
  isRecord(payload) && isBoolean(payload.ready) ? { ready: payload.ready } : undefined;

const parseStartPayload = (payload: unknown): StartMessagePayload | undefined => {
  if (payload === undefined) return {};
  if (!isRecord(payload)) return undefined;
  if (payload.start === undefined || payload.start === true) return { start: true };
  return undefined;
};

const parseInputPayload = (payload: unknown): StoredInputIntent | undefined => {
  if (!isRecord(payload)) return undefined;
  const { sequence, tick, moveX, moveY, aimX, aimY, fire, ability } = payload;
  if (
    !Number.isSafeInteger(sequence) ||
    !Number.isSafeInteger(tick) ||
    !isFiniteNumber(moveX) ||
    !isFiniteNumber(moveY) ||
    !isFiniteNumber(aimX) ||
    !isFiniteNumber(aimY) ||
    !isBoolean(fire) ||
    !isBoolean(ability)
  ) {
    return undefined;
  }

  return {
    sequence: sequence as number,
    tick: tick as number,
    moveX: clamp(moveX, -1, 1),
    moveY: clamp(moveY, -1, 1),
    aimX,
    aimY,
    fire,
    ability,
    receivedAt: Date.now()
  };
};

const parseFirePayload = (payload: unknown): StoredFireIntent | undefined => {
  if (!isRecord(payload)) return undefined;
  const { sequence, aimX, aimY, chargeMs } = payload;
  if (!Number.isSafeInteger(sequence) || !isFiniteNumber(aimX) || !isFiniteNumber(aimY)) {
    return undefined;
  }
  if (chargeMs !== undefined && (!isFiniteNumber(chargeMs) || chargeMs < 0)) {
    return undefined;
  }

  return {
    sequence: sequence as number,
    aimX,
    aimY,
    chargeMs: chargeMs === undefined ? undefined : clamp(chargeMs, 0, 5_000),
    receivedAt: Date.now()
  };
};

const parseAbilityPayload = (
  payload: unknown,
  fallbackAbilityType: PlayerSchema["abilityType"]
): StoredAbilityIntent | undefined => {
  if (!isRecord(payload)) return undefined;
  const { sequence, abilityType, targetX, targetY } = payload;
  if (!Number.isSafeInteger(sequence) || abilityType !== fallbackAbilityType) {
    return undefined;
  }
  if (targetX !== undefined && !isFiniteNumber(targetX)) return undefined;
  if (targetY !== undefined && !isFiniteNumber(targetY)) return undefined;

  return {
    sequence: sequence as number,
    abilityType: fallbackAbilityType,
    targetX: targetX as number | undefined,
    targetY: targetY as number | undefined,
    receivedAt: Date.now()
  };
};

const parseRematchPayload = (payload: unknown): RematchMessagePayload | undefined => {
  if (!isRecord(payload) || !isBoolean(payload.ready)) return undefined;
  if (payload.previousMatchId !== undefined && typeof payload.previousMatchId !== "string") {
    return undefined;
  }

  return {
    ready: payload.ready,
    previousMatchId:
      typeof payload.previousMatchId === "string" ? payload.previousMatchId.slice(0, 80) : undefined
  };
};

const applyTankConfig = (player: PlayerSchema, archetypeId: TankArchetypeId): void => {
  const tankConfig = TANK_ARCHETYPE_CONFIG[archetypeId];

  player.archetypeId = archetypeId;
  player.weaponType = tankConfig.primaryWeapon;
  player.abilityType = tankConfig.ability;
  player.maxHealth = tankConfig.maxHealth;
  player.health = tankConfig.maxHealth;
  player.maxArmor = tankConfig.maxArmor;
  player.armor = tankConfig.maxArmor;
  player.speedMultiplier = 1;
  player.lastAbilityType = tankConfig.ability;
  player.lastAbilityAt = 0;
  player.lastAbilityEndsAt = 0;
  player.lastAbilityX = player.x;
  player.lastAbilityY = player.y;
  player.smokeActivatedAt = 0;
  player.smokeEndsAt = 0;
  player.smokeX = player.x;
  player.smokeY = player.y;
};

const playerCount = (state: Alpha7StateSchema): number => {
  return state.owners.size;
};

const connectedPlayerCount = (state: Alpha7StateSchema): number => {
  let count = 0;
  for (const owner of state.owners.values()) {
    if (owner.isConnected) count += 1;
  }
  return count;
};

const alivePlayerCount = (state: Alpha7StateSchema): number => {
  let count = 0;
  for (const player of state.players.values()) {
    if (!player.isSpectator && player.isAlive) count += 1;
  }
  return count;
};

type HumanClient = Client<{ auth: HumanPrincipal }>;

export class BattleRoyaleRoom extends Room<{
  state: Alpha7StateSchema;
  metadata: BattleRoyaleRoomMetadata;
  client: HumanClient;
}> {
  private config?: ServerConfig;
  private policy!: RoomPolicy;
  private arena?: ArenaConfig;
  private initialArenaSeed = "";
  private isPrivateRoom = false;
  private autoStartTimer?: Delayed;
  private runningStartedAt = 0;
  private dangerStartsAt = 0;
  private finalZoneStartsAt = 0;
  private finishedAt = 0;
  private readonly inputIntents = new Map<string, StoredInputIntent>();
  private readonly fireIntents = new Map<string, StoredFireIntent>();
  private readonly abilityIntents = new Map<string, StoredAbilityIntent>();
  private readonly rematchVotes = new Map<string, RematchMessagePayload>();
  private readonly lastProcessedFireSequences = new Map<string, number>();
  private readonly lastProcessedAbilitySequences = new Map<string, number>();
  private readonly speedEffects = new Map<string, TimedMultiplierEffect>();
  private readonly rapidFireEffects = new Map<string, TimedMultiplierEffect>();
  private readonly shieldEffects = new Map<string, TimedShieldEffect>();
  private readonly smokeEffects = new Map<string, TimedReductionEffect>();
  private readonly zoneDamageRemainders = new Map<string, number>();
  private readonly agentRuntimes = new Map<string, AgentRuntime>();
  private readonly agentPairingRequests = new Map<string, string>();
  private readonly agentPairingExpiresAt = new Map<string, number>();
  private readonly ownerSourceKeys = new Map<string, string>();
  private readonly permanentlyLeftOwners = new Set<string>();
  private readonly agentAudit: Array<Record<string, unknown>> = [];
  private agentAuditCursor = 0;
  private agentExecutorTimer?: Delayed;
  private eliminationBatchPlacement: number | undefined;
  private projectileCounter = 0;

  async onCreate(options: BattleRoyaleCreateOptions) {
    const { config } = options;
    this.config = config;
    const roomMode = resolveRoomMode(options.roomMode, config.agentPlayEnabled);
    const expandedCombatants =
      config.agentExpandedCombatantsEnabled && (roomMode === "wingman" || roomMode === "open_ffa");
    const agentControlCap = roomMode === "agent_cup" && !config.agentCupMaxControlsEnabled
      ? 2
      : config.demoMaxPlayers;
    this.policy = buildRoomPolicy(roomMode, {
      ownerCap: config.demoMaxPlayers,
      humanWsCap: config.demoMaxPlayers,
      agentControlCap,
      combatantCap: expandedCombatants ? 16 : AGENT_PRODUCTION_COMBATANT_CAP,
      expandedCombatantsQualified: expandedCombatants
    });
    this.isPrivateRoom =
      booleanOption(options.privateRoom) ?? booleanOption(options.private) ?? false;
    this.maxClients = this.policy.humanWsCap;
    this.patchRate = intervalFromRate(config.roomPatchRate, 20);

    const state = new Alpha7StateSchema();
    const now = Date.now();
    state.roomCode = this.isPrivateRoom ? makeRoomCode() : this.roomId || makeRoomCode();
    state.seed = safeSeed(
      config.nodeEnv === "production" && !config.enableCapacityMetrics ? undefined : options.seed
    );
    this.initialArenaSeed = state.seed;
    state.serverTime = now;
    state.match.matchId = `${state.roomCode}-${now.toString(36)}`;
    state.match.stateStartedAt = now;
    Object.assign(state.policy, this.policy);
    state.policy.tacticalReflexEnabled = config.agentTacticalReflexEnabled;
    this.setState(state);
    this.arena = generateArenaConfig({
      seed: state.seed,
      playerCount: this.policy.combatantCap
    });
    this.syncArenaConfig();
    this.initializePickups(state.match.stateStartedAt);
    this.applyZonePhase("waiting", state.match.stateStartedAt);

    await this.setPrivate(this.isPrivateRoom);
    await this.updateMetadata();
    this.registerMessageHandlers();
    const recordSimulationTick = options.recordSimulationTick;
    const simulationTick = recordSimulationTick
      ? (deltaTime: number) => {
          const startedAt = performance.now();
          this.onSimulationTick(deltaTime);
          recordSimulationTick(startedAt, performance.now() - startedAt);
        }
      : (deltaTime: number) => this.onSimulationTick(deltaTime);
    this.setTimestep(simulationTick, intervalFromRate(config.roomTickRate, 30));
    if (this.policy.mode !== "classic") {
      this.agentExecutorTimer = this.clock.setInterval(
        () => this.runAgentExecutors(Date.now()),
        50
      );
    }
  }

  static async onAuth(_token: string, options: unknown, context: AuthContext) {
    try {
      return createHumanAdmission(
        options,
        trustedRequestSourceKey({
          isRailway: Boolean(process.env.RAILWAY_REPLICA_ID),
          headers: context.headers
        })
      ).principal;
    } catch {
      throw new ServerError(ErrorCode.AUTH_FAILED, "invalid join options");
    }
  }

  onJoin(client: HumanClient) {
    if (!this.canAcceptActiveJoin()) {
      throw new ServerError(ErrorCode.AUTH_FAILED, "room is locked");
    }
    if (!isHumanPrincipal(client.auth)) {
      throw new ServerError(ErrorCode.AUTH_FAILED, "invalid human principal");
    }

    if (this.state.owners.size >= this.policy.ownerCap) {
      throw new ServerError(ErrorCode.AUTH_FAILED, "owner limit reached");
    }

    const owner = this.createOwner(client, client.auth);
    const player = this.createPlayer(client, client.auth.preferences, owner);
    this.state.owners.set(owner.ownerId, owner);
    this.state.players.set(client.sessionId, player);
    this.ownerSourceKeys.set(owner.ownerId, client.auth.sourceKey);
    this.state.match.alivePlayers = alivePlayerCount(this.state);

    this.sendSystem(client, "player_joined", "joined");
    this.broadcastSystem("player_joined", `${player.name} joined`);
    void this.updateMetadata();
    this.syncWaitingAdmissionLock();
    this.ensureAutoStartTimer();
  }

  onDrop(client: HumanClient, _code: number) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const owner = this.state.owners.get(player.ownerId);
    if (owner) {
      owner.isConnected = false;
      if (this.agentRuntimes.has(owner.agentSeatId)) {
        owner.agentSeatState = "reconnecting";
        this.invalidateAgentObservation(owner.agentSeatId);
        this.neutralizeAgent(owner.agentSeatId, "owner_disconnected");
      }
    }
    this.handleDroppedClient(client, player);
    void this.allowReconnection(client, 45);
  }

  onReconnect(client: HumanClient) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    player.isConnected = true;
    const owner = this.state.owners.get(player.ownerId);
    if (owner) {
      owner.isConnected = true;
      const runtime = this.agentRuntimes.get(owner.agentSeatId);
      if (runtime) owner.agentSeatState = runtime.paused ? "paused" : "connected";
    }
    this.permanentlyLeftOwners.delete(player.ownerId);
    this.ensureHost();
    this.state.match.alivePlayers = alivePlayerCount(this.state);
    this.sendSystem(client, "player_joined", "reconnected");
    this.broadcastSystem("player_joined", `${player.name} reconnected`);
    if (this.state.matchState === "waiting" && this.hasEnoughReadyPlayers()) {
      this.beginCountdown();
    } else {
      this.ensureAutoStartTimer();
    }
    void this.updateMetadata();
    if (this.config?.logLevel !== "silent") {
      console.info(
        `[alpha7] room connection event=reconnected room=${this.roomId} state=${this.state.matchState}`
      );
    }
  }

  onLeave(client: HumanClient, _code = CloseCode.CONSENTED) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    this.handlePermanentLeave(client.sessionId, player, Date.now());
  }

  private handleDroppedClient(client: HumanClient, player: PlayerSchema): void {
    const wasCountingDown = this.state.matchState === "countdown";

    this.rematchVotes.delete(player.ownerId);
    this.clearPlayerTransientInput(client.sessionId, player);
    player.isConnected = false;

    this.state.match.alivePlayers = alivePlayerCount(this.state);
    if (wasCountingDown && !this.canBeginCountdown()) {
      this.cancelCountdown();
    }
    this.ensureAutoStartTimer();
    void this.updateMetadata();
    if (this.config?.logLevel !== "silent") {
      console.info(
        `[alpha7] room connection event=disconnected room=${this.roomId} state=${this.state.matchState}`
      );
    }
  }

  private handlePermanentLeave(sessionId: string, player: PlayerSchema, now: number): void {
    const wasCountingDown = this.state.matchState === "countdown";

    this.clearPlayerRuntimeState(sessionId, player);
    this.rematchVotes.delete(player.ownerId);

    if (this.state.matchState === "waiting" || this.state.matchState === "countdown") {
      const owner = this.state.owners.get(player.ownerId);
      if (owner) this.cancelOwnerAgentBeforeMatch(owner, now);
      this.state.players.delete(sessionId);
      this.state.owners.delete(player.ownerId);
      this.ownerSourceKeys.delete(player.ownerId);
      this.permanentlyLeftOwners.delete(player.ownerId);
    } else {
      if (player.isAlive && !player.isSpectator && this.isActiveMatchState()) {
        this.eliminatePlayer(player, undefined, now);
      }
      player.isConnected = false;
      const owner = this.state.owners.get(player.ownerId);
      if (owner) {
        owner.isConnected = false;
        const runtime = this.agentRuntimes.get(owner.agentSeatId);
        if (runtime) {
          this.invalidateAgentObservation(owner.agentSeatId);
          this.neutralizeAgent(owner.agentSeatId, "owner_disconnected");
          try {
            agentBroker.revokeControl(runtime.principal);
          } catch {
            try {
              agentBroker.cancelGrant(runtime.principal.requestId, {
                roomId: this.roomId,
                ownerId: runtime.principal.ownerId
              });
            } catch {
              // Already expired, released, consumed, or cancelled.
            }
          }
          this.releaseAgentSeat(runtime.principal, now, "disconnected");
        }
      }
      this.permanentlyLeftOwners.add(player.ownerId);
    }

    this.ensureHost();
    this.state.match.alivePlayers = alivePlayerCount(this.state);
    if (wasCountingDown && !this.canBeginCountdown()) {
      this.cancelCountdown();
    }
    this.checkForMatchConclusion(now);
    this.ensureAutoStartTimer();
    this.syncWaitingAdmissionLock();
    void this.updateMetadata();
  }

  onDispose() {
    this.autoStartTimer?.clear();
    this.autoStartTimer = undefined;
    this.agentExecutorTimer?.clear();
    this.agentExecutorTimer = undefined;
    for (const runtime of this.agentRuntimes.values()) {
      try {
        agentBroker.revokeControl(runtime.principal);
      } catch {
        try {
          agentBroker.cancelGrant(runtime.principal.requestId, {
            roomId: this.roomId,
            ownerId: runtime.principal.ownerId
          });
        } catch {
          // Already expired, released, consumed, or cancelled.
        }
      }
    }
    for (const [ownerId, requestId] of this.agentPairingRequests) {
      try {
        agentBroker.cancelGrant(requestId, { roomId: this.roomId, ownerId });
      } catch {
        // Already consumed, expired, or cancelled.
      }
    }
    this.agentRuntimes.clear();
    this.agentPairingRequests.clear();
    this.agentPairingExpiresAt.clear();
    this.ownerSourceKeys.clear();
    this.permanentlyLeftOwners.clear();
    this.agentAudit.length = 0;
    this.agentAuditCursor = 0;
  }

  agentMaterialize(principal: AgentControlPrincipal): AgentArenaDescriptorV1 {
    const openingTactic = principal.controlMode === "tactical_reflex_v1"
      ? this.parseAgentOpeningTactic(principal.openingTactic)
      : undefined;
    if (
      this.policy.mode === "classic" ||
      principal.roomId !== this.roomId ||
      principal.roomMode !== this.policy.mode ||
      principal.track !== this.policy.track ||
      principal.role !== "combatant" ||
      (principal.controlMode !== "macro_v1" && principal.controlMode !== "tactical_reflex_v1") ||
      (principal.controlMode === "tactical_reflex_v1" && !openingTactic) ||
      (principal.controlMode === "macro_v1" && principal.openingTactic !== undefined) ||
      (principal.controlMode === "tactical_reflex_v1" && !this.config?.agentTacticalReflexEnabled) ||
      this.state.matchState !== "waiting"
    ) {
      throw new ServerError(ErrorCode.AUTH_FAILED, "agent principal rejected");
    }
    const owner = this.state.owners.get(principal.ownerId);
    if (
      !owner ||
      !owner.isConnected ||
      owner.agentSeatState !== "pending" ||
      owner.agentSeatId !== principal.seatId ||
      this.agentPairingRequests.get(owner.ownerId) !== principal.requestId ||
      this.combatantCount() >= this.policy.combatantCap ||
      this.agentRuntimes.size >= this.policy.agentControlCap
    ) {
      throw new ServerError(ErrorCode.AUTH_FAILED, "agent seat rejected");
    }
    if (!TANK_ARCHETYPES.includes(principal.archetype as TankArchetypeId)) {
      throw new ServerError(ErrorCode.AUTH_FAILED, "agent archetype rejected");
    }

    const player = new PlayerSchema();
    player.id = principal.seatId;
    player.sessionId = principal.seatId;
    player.ownerId = owner.ownerId;
    player.pairId = owner.ownerId;
    player.controlKind = "agent";
    player.name = sanitizeDisplayName(principal.agentName, "Agent");
    applyTankConfig(player, principal.archetype as TankArchetypeId);
    player.joinedAt = Date.now();
    player.isHost = false;
    player.isReady = false;
    player.isAlive = true;
    player.isConnected = true;
    player.isSpectator = false;
    this.assignSpawnPosition(player, this.combatantCount());
    this.state.players.set(player.sessionId, player);

    owner.agentSeatState = "connected";
    owner.agentPairingExpiresAtMs = 0;
    this.agentPairingRequests.delete(owner.ownerId);
    this.agentPairingExpiresAt.delete(owner.ownerId);
    this.agentRuntimes.set(player.sessionId, {
      principal,
      paused: false,
      brokerRevision: 0,
      idleDeadlineMs: principal.issuedAtMs + AGENT_CONTROL_IDLE_TIMEOUT_MS,
      observationSeq: 0,
      observationRoundId: "",
      lastObservationAtMs: 0,
      lastActionAtMs: 0,
      lastActionSeq: 0,
      lowLevelSequence: 0,
      arenaVersion: "",
      visibleTargets: new Map(),
      lastIntentAtMs: openingTactic ? principal.issuedAtMs : 0,
      lastIntentSeq: openingTactic?.intentSeq ?? 0,
      lastReflexAtMs: 0,
      internalMacroSequence: 0,
      tacticalStopReason: openingTactic ? "waiting" : "no_intent",
      ...(openingTactic ? {
        openingTacticalIntent: openingTactic,
        tactical: {
          intent: openingTactic,
          roundId: this.state.match.matchId,
          expiresAtMs: principal.issuedAtMs + openingTactic.validForMs,
          singleFireUsed: false,
          abilityUsed: false
        }
      } : {})
    });
    this.recordAgentAudit("materialized", principal.seatId);
    this.state.match.alivePlayers = alivePlayerCount(this.state);
    this.syncWaitingAdmissionLock();
    void this.updateMetadata();
    return this.agentArenaDescriptor();
  }

  agentObserve(session: AgentBrokerSession, now = Date.now()): AgentObservationV1 {
    const runtime = this.requireAgentRuntime(session, "agent:observe", true);
    if (now - runtime.lastObservationAtMs < AGENT_OBSERVATION_INTERVAL_MS) {
      throw new AgentBrokerError("rate_limited");
    }
    if (this.state.matchState === "waiting") {
      throw new AgentBrokerError("match_not_active");
    }
    const player = this.state.players.get(runtime.principal.seatId);
    if (!player) throw new AgentBrokerError("control_not_found");
    const owner = this.state.owners.get(runtime.principal.ownerId);
    if (!owner?.isConnected) throw new AgentBrokerError("owner_unavailable");
    if (runtime.paused) throw new AgentBrokerError("agent_paused");

    runtime.lastObservationAtMs = now;
    runtime.observationSeq += 1;
    runtime.observationRoundId = this.state.match.matchId;
    const projection = this.projectAgentWorld(player, now);
    runtime.visibleTargets = projection.visibleTargets;
    const arenaChanged = runtime.arenaVersion !== this.state.match.matchId;
    runtime.arenaVersion = this.state.match.matchId;
    const observation: AgentObservationV1 = {
      version: AGENT_OBSERVATION_VERSION,
      observationSeq: runtime.observationSeq,
      roomId: this.roomId,
      roundId: this.state.match.matchId,
      seatId: player.sessionId,
      mode: this.policy.mode,
      track: "custom",
      matchState: this.state.matchState,
      serverTimeMs: now,
      arenaVersion: this.state.match.matchId,
      ...(arenaChanged ? { arenaUpdate: this.agentArenaDescriptor() } : {}),
      self: projection.self,
      zone: projection.zone,
      pickups: projection.pickups,
      allies: projection.allies,
      opponents: projection.opponents
    };
    this.recordAgentAudit("observed", player.sessionId, {
      observationSeq: observation.observationSeq,
      observationHash: createHash("sha256")
        .update(JSON.stringify(observation))
        .digest("base64url")
        .slice(0, 16),
      visibleTargets: runtime.visibleTargets.size
    });
    return observation;
  }

  private projectAgentWorld(player: PlayerSchema, now: number): AgentWorldProjection {
    const visibleTargets = new Map<string, { x: number; z: number }>();
    const allies: AgentObservationV1["allies"] = [];
    const opponents: AgentObservationV1["opponents"] = [];
    for (const target of this.state.players.values()) {
      if (target.sessionId === player.sessionId) continue;
      const targetOwner = this.state.owners.get(target.ownerId);
      if (target.controlKind === "human" && targetOwner?.principalKind !== "combatant") continue;
      if (this.areFriendly(player, target)) {
        allies.push({
          id: target.sessionId,
          archetype: target.archetypeId,
          alive: target.isAlive,
          position: target.isAlive
            ? { x: Math.round(target.x / 25) * 25, z: Math.round(target.y / 25) * 25 }
            : null,
          motion: target.isAlive
            ? Math.hypot(target.velocityX, target.velocityY) >= AGENT_MOVING_SPEED_THRESHOLD
              ? "moving"
              : "stationary"
            : "unknown"
        });
        continue;
      }
      const visible = target.isAlive && !isPlayerConcealedBySmoke(target, now);
      const position = visible
        ? { x: Math.round(target.x / 25) * 25, z: Math.round(target.y / 25) * 25 }
        : null;
      if (position) visibleTargets.set(target.sessionId, position);
      opponents.push({
        id: target.sessionId,
        ownerLabel: targetOwner?.displayName ?? "Player",
        agentLabel: target.controlKind === "agent" ? target.name : null,
        archetype: target.archetypeId,
        alive: target.isAlive,
        kills: target.kills,
        placement: target.placement > 0 ? target.placement : null,
        visible,
        position,
        motion: visible
          ? Math.hypot(target.velocityX, target.velocityY) >= AGENT_MOVING_SPEED_THRESHOLD
            ? "moving"
            : "stationary"
          : "unknown"
      });
    }
    return {
      self: {
        id: player.sessionId,
        archetype: player.archetypeId,
        position: { x: player.x, z: player.y },
        hullRotation: player.rotation,
        turretRotation: player.turretRotation,
        velocity: { x: player.velocityX, z: player.velocityY },
        health: player.health,
        maxHealth: player.maxHealth,
        armor: player.armor,
        ammo: player.ammo,
        weapon: player.weaponType,
        weaponCooldownMs: player.fireCooldownMs,
        ability: player.abilityType,
        abilityCharge: player.abilityCharge,
        abilityCooldownMs: player.abilityCooldownMs,
        alive: player.isAlive
      },
      zone: {
        phase: this.state.matchState,
        centerX: this.state.zone.x,
        centerZ: this.state.zone.y,
        radius: this.state.zone.radius,
        nextChangeMs: Math.max(0, this.nextMatchChangeAt() - now)
      },
      pickups: Array.from(this.state.pickups)
        .filter((pickup) => pickup.isActive)
        .map((pickup) => ({
          id: pickup.id,
          type: pickup.pickupType,
          x: pickup.x,
          z: pickup.y,
          active: true as const
        })),
      allies,
      opponents,
      visibleTargets
    };
  }

  agentAct(
    session: AgentBrokerSession,
    payload: unknown,
    now = Date.now(),
    brokerReceivedAtMs = now,
    transportRejectionCode?: "rate_limited"
  ): AgentActionResultV1 {
    const startedAt = performance.now();
    const runtime = this.requireAgentRuntime(session, "agent:act", true);
    let parsedAction: AgentMacroActionV1 | undefined;
    const auditTiming = () => ({
      requestTimeMs: brokerReceivedAtMs,
      brokerLatencyMs: Math.max(0, Date.now() - brokerReceivedAtMs),
      roomHandlerLatencyMs: Math.round((performance.now() - startedAt) * 100) / 100
    });
    const parsed = parseAgentMacroActionV1(payload);
    const reject = (code: AgentActionResultV1["code"], actionSeq: number | null = null) => {
      this.neutralizeAgent(runtime.principal.seatId, "action_rejected");
      this.recordAgentAudit("action_rejected", runtime.principal.seatId, {
        actionSeq,
        code,
        macro: parsedAction ? auditMacroAction(parsedAction) : null,
        parseError: parsed.ok || transportRejectionCode ? null : {
          code: parsed.error.code,
          field: parsed.error.code === "unknown_key" ? "$.*" : parsed.error.field
        },
        ...auditTiming()
      });
      return {
        version: AGENT_ACTION_VERSION,
        type: "agent_action_result" as const,
        actionSeq,
        accepted: false,
        code,
        leaseExpiresAtMs: null
      };
    };
    if (transportRejectionCode) return reject(transportRejectionCode);
    if (!parsed.ok) return reject("lease_invalid");
    const action = parsedAction = parsed.value;
    const player = this.state.players.get(runtime.principal.seatId);
    const owner = this.state.owners.get(runtime.principal.ownerId);
    if (!this.isActiveMatchState() || !player || !this.canParticipateInCombat(player)) {
      return reject("match_not_active", action.actionSeq);
    }
    if (!owner?.isConnected) return reject("owner_unavailable", action.actionSeq);
    if (runtime.paused) return reject("agent_paused", action.actionSeq);
    if (runtime.observationRoundId !== this.state.match.matchId) {
      return reject("stale_observation", action.actionSeq);
    }
    if (now - runtime.lastActionAtMs < AGENT_ACTION_INTERVAL_MS) {
      return reject("rate_limited", action.actionSeq);
    }
    if (action.actionSeq <= runtime.lastActionSeq) return reject("stale_action", action.actionSeq);
    if (action.basedOnObservationSeq !== runtime.observationSeq) {
      return reject("stale_observation", action.actionSeq);
    }
    if (!this.validAgentRoute(player, action.waypoints)) {
      return reject("lease_invalid", action.actionSeq);
    }
    if (action.pickupId && !this.state.pickups.some((pickup) => pickup.id === action.pickupId && pickup.isActive)) {
      return reject("target_not_visible", action.actionSeq);
    }
    const actionTarget = action.targetId ? this.state.players.get(action.targetId) : undefined;
    const targetPosition = action.targetId ? runtime.visibleTargets.get(action.targetId) : undefined;
    if (action.targetId && (
      !targetPosition ||
      !actionTarget?.isAlive ||
      this.areFriendly(player, actionTarget) ||
      isPlayerConcealedBySmoke(actionTarget, now)
    )) return reject("target_not_visible", action.actionSeq);

    runtime.lastActionAtMs = now;
    runtime.lastActionSeq = action.actionSeq;
    if (runtime.lease) this.neutralizeAgent(runtime.principal.seatId, "action_replaced");
    runtime.lease = {
      action,
      expiresAtMs: now + action.leaseMs,
      waypointIndex: 0,
      singleFireUsed: false,
      abilityUsed: false,
      ...(targetPosition ? { targetPosition } : {})
    };
    this.recordAgentAudit("action_accepted", player.sessionId, {
      actionSeq: action.actionSeq,
      observationSeq: action.basedOnObservationSeq,
      macro: auditMacroAction(action, true),
      ...auditTiming()
    });
    return {
      version: AGENT_ACTION_VERSION,
      type: "agent_action_result",
      actionSeq: action.actionSeq,
      accepted: true,
      code: "accepted",
      leaseExpiresAtMs: runtime.lease.expiresAtMs
    };
  }

  agentSetTacticalIntent(
    session: AgentBrokerSession,
    payload: unknown,
    now = Date.now(),
    brokerReceivedAtMs = now
  ): AgentTacticalIntentResultV1 {
    const runtime = this.requireAgentRuntime(session, "agent:tactic", true);
    const parsed = parseAgentTacticalIntentV1(payload);
    const reject = (
      code: AgentTacticalIntentResultV1["code"],
      intentSeq: number | null = null
    ): AgentTacticalIntentResultV1 => {
      this.neutralizeAgent(runtime.principal.seatId, "tactical_rejected", false, now);
      this.clearTacticalIntent(runtime, "cleared");
      this.recordAgentAudit("tactical_rejected", runtime.principal.seatId, {
        intentSeq,
        code,
        parseError: parsed.ok ? null : {
          code: parsed.error.code,
          field: parsed.error.code === "unknown_key" ? "$.*" : parsed.error.field
        },
        brokerLatencyMs: Math.max(0, Date.now() - brokerReceivedAtMs)
      });
      return {
        version: AGENT_TACTICAL_INTENT_VERSION,
        type: "agent_tactical_intent_result",
        intentSeq,
        accepted: false,
        code,
        intentExpiresAtMs: null
      };
    };
    if (runtime.principal.controlMode !== "tactical_reflex_v1") {
      return reject("control_mode_mismatch");
    }
    if (!this.config?.agentTacticalReflexEnabled) return reject("agent_feature_disabled");
    if (!parsed.ok) return reject("tactical_intent_invalid");
    const intent = parsed.value;
    const player = this.state.players.get(runtime.principal.seatId);
    const owner = this.state.owners.get(runtime.principal.ownerId);
    const acceptsOpening = this.state.matchState === "waiting" || this.state.matchState === "countdown";
    if (!player || (!acceptsOpening && (
      !this.isActiveMatchState() || !this.canParticipateInCombat(player)
    ))) {
      return reject("match_not_active", intent.intentSeq);
    }
    if (!owner?.isConnected) return reject("owner_unavailable", intent.intentSeq);
    if (runtime.paused) return reject("agent_paused", intent.intentSeq);
    if (now - runtime.lastIntentAtMs < AGENT_TACTICAL_REFLEX_INTERVAL_MS) {
      return reject("rate_limited", intent.intentSeq);
    }
    if (intent.intentSeq <= runtime.lastIntentSeq) return reject("stale_action", intent.intentSeq);
    if (intent.basedOnObservationSeq === null) {
      return reject("stale_observation", intent.intentSeq);
    }
    if (
      runtime.observationRoundId !== this.state.match.matchId ||
      intent.basedOnObservationSeq !== runtime.observationSeq
    ) {
      return reject("stale_observation", intent.intentSeq);
    }
    if (
      intent.objective.type === "move_to" &&
      !this.agentPointNavigable(intent.objective.position)
    ) return reject("tactical_intent_invalid", intent.intentSeq);
    if (intent.objective.type === "engage_target") {
      const target = this.state.players.get(intent.objective.targetId);
      if (
        !runtime.visibleTargets.has(intent.objective.targetId) ||
        !target?.isAlive ||
        this.areFriendly(player, target) ||
        isPlayerConcealedBySmoke(target, now)
      ) return reject("target_not_visible", intent.intentSeq);
    }
    if (intent.objective.type === "collect_pickup") {
      const pickupId = intent.objective.pickupId;
      if (!this.state.pickups.some((pickup) => pickup.id === pickupId && pickup.isActive)) {
        return reject("target_not_visible", intent.intentSeq);
      }
    }

    runtime.lastIntentAtMs = now;
    runtime.lastIntentSeq = intent.intentSeq;
    const intentExpiresAtMs = now + intent.validForMs;
    runtime.tactical = {
      intent,
      roundId: this.state.match.matchId,
      expiresAtMs: intentExpiresAtMs,
      singleFireUsed: false,
      abilityUsed: false
    };
    runtime.tacticalStopReason = this.isActiveMatchState() ? "none" : "waiting";
    if (this.isActiveMatchState()) this.evaluateTacticalReflex(runtime, now, true);
    this.recordAgentAudit("tactical_accepted", runtime.principal.seatId, {
      intentSeq: intent.intentSeq,
      observationSeq: intent.basedOnObservationSeq,
      objective: intent.objective.type,
      targetId: intent.objective.type === "engage_target" ? intent.objective.targetId : null,
      pickupId: intent.objective.type === "collect_pickup" ? intent.objective.pickupId : null,
      expiresAtMs: intentExpiresAtMs,
      brokerLatencyMs: Math.max(0, Date.now() - brokerReceivedAtMs)
    });
    return {
      version: AGENT_TACTICAL_INTENT_VERSION,
      type: "agent_tactical_intent_result",
      intentSeq: intent.intentSeq,
      accepted: true,
      code: "accepted",
      intentExpiresAtMs
    };
  }

  agentTacticalStatus(session: AgentBrokerSession): AgentTacticalStatusV1 {
    const runtime = this.requireAgentRuntime(session, "agent:tactic", true);
    const owner = this.state.owners.get(runtime.principal.ownerId);
    return {
      version: AGENT_TACTICAL_INTENT_VERSION,
      type: "agent_tactical_status",
      roomId: this.roomId,
      seatId: runtime.principal.seatId,
      mode: this.policy.mode as Exclude<RoomMode, "classic">,
      track: "custom",
      controlMode: "tactical_reflex_v1",
      state: owner?.agentSeatState ?? "disconnected",
      matchState: this.state.matchState,
      observationSeq: runtime.observationSeq,
      lastIntentSeq: runtime.lastIntentSeq,
      intentExpiresAtMs: runtime.tactical?.expiresAtMs ?? null,
      lastReflexAtMs: runtime.lastReflexAtMs || null,
      active: runtime.tactical !== undefined && runtime.lease !== undefined,
      stopReason: runtime.tacticalStopReason,
      idleDeadlineMs: runtime.idleDeadlineMs
    };
  }

  agentClearTacticalIntent(session: AgentBrokerSession, now = Date.now()): AgentTacticalStatusV1 {
    const runtime = this.requireAgentRuntime(session, "agent:tactic", true);
    if (runtime.tactical || runtime.lease) {
      this.neutralizeAgent(runtime.principal.seatId, "tactical_cleared", false, now);
    }
    this.clearTacticalIntent(runtime, "cleared");
    runtime.openingTacticalIntent = undefined;
    return this.agentTacticalStatus(session);
  }

  agentHeartbeat(session: AgentBrokerSession): AgentControlStatusV1 {
    return this.agentStatus(session);
  }

  agentStatus(session: AgentBrokerSession): AgentControlStatusV1 {
    const runtime = this.requireAgentRuntime(session, "agent:observe", true);
    const owner = this.state.owners.get(runtime.principal.ownerId);
    return {
      version: AGENT_PROTOCOL_VERSION,
      roomId: this.roomId,
      seatId: runtime.principal.seatId,
      mode: this.policy.mode,
      track: "custom",
      state: owner?.agentSeatState ?? "disconnected",
      matchState: this.state.matchState,
      observationSeq: runtime.observationSeq,
      lastActionSeq: runtime.lastActionSeq,
      leaseExpiresAtMs: runtime.lease?.expiresAtMs ?? null,
      idleDeadlineMs: runtime.idleDeadlineMs
    };
  }

  agentRelease(principal: AgentControlPrincipal, now = Date.now()): void {
    this.releaseAgentSeat(principal, now);
  }

  private registerMessageHandlers(): void {
    this.onMessage(CLIENT_MESSAGE_TYPES.JOIN, (client, payload) =>
      this.handleJoinMessage(client, payload)
    );
    this.onMessage(CLIENT_MESSAGE_TYPES.READY, (client, payload) =>
      this.handleReadyMessage(client, payload)
    );
    this.onMessage(CLIENT_MESSAGE_TYPES.START, (client, payload) =>
      this.handleStartMessage(client, payload)
    );
    this.onMessage(CLIENT_MESSAGE_TYPES.INPUT, (client, payload) =>
      this.handleInputMessage(client, payload)
    );
    this.onMessage(CLIENT_MESSAGE_TYPES.FIRE, (client, payload) =>
      this.handleFireMessage(client, payload)
    );
    this.onMessage(CLIENT_MESSAGE_TYPES.ABILITY, (client, payload) =>
      this.handleAbilityMessage(client, payload)
    );
    this.onMessage(CLIENT_MESSAGE_TYPES.REMATCH, (client, payload) =>
      this.handleRematchMessage(client, payload)
    );
    this.onMessage(CLIENT_MESSAGE_TYPES.AGENT_PAIRING_CREATE, (client, payload) =>
      this.handleAgentPairingCreate(client, payload)
    );
    this.onMessage(CLIENT_MESSAGE_TYPES.AGENT_PAIRING_CANCEL, (client, payload) =>
      this.handleAgentPairingCancel(client, payload)
    );
    this.onMessage(CLIENT_MESSAGE_TYPES.AGENT_CONTROL, (client, payload) =>
      this.handleAgentControl(client, payload)
    );
  }

  private handleAgentPairingCreate(client: Client, payload: unknown): void {
    const player = this.getPlayerOrError(client);
    if (!player) return;
    const owner = this.state.owners.get(player.ownerId);
    const parsed = this.parseAgentPairingCreate(payload);
    if (!owner || !parsed) {
      this.sendError(client, "invalid_payload", "Invalid agent pairing request", false);
      return;
    }
    if (this.policy.mode === "classic" || this.state.matchState !== "waiting") {
      client.send(SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT, {
        requestId: "",
        action: "create",
        accepted: false,
        seatState: owner.agentSeatState,
        errorCode: this.policy.mode === "classic" ? "mode_disallows_agent" : "room_not_waiting"
      });
      return;
    }
    if (
      owner.agentSeatState !== "none" ||
      this.combatantCount() + this.agentPairingRequests.size >= this.policy.combatantCap
    ) {
      client.send(SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT, {
        requestId: this.agentPairingRequests.get(owner.ownerId) ?? "",
        action: "create",
        accepted: false,
        seatState: owner.agentSeatState,
        errorCode: owner.agentSeatState === "none" ? "combatant_limit" : "pending_exists"
      });
      return;
    }
    if (parsed.controlMode === "tactical_reflex_v1" && !this.config?.agentTacticalReflexEnabled) {
      client.send(SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT, {
        requestId: "",
        action: "create",
        accepted: false,
        seatState: owner.agentSeatState,
        errorCode: "agent_feature_disabled"
      });
      return;
    }

    try {
      const seatId = randomUUID();
      const agentLabel = sanitizeDisplayName(
        parsed.agentLabel,
        `${owner.displayName || "Player"} Agent`
      );
      const archetype = player.archetypeId;
      const controlMode = parsed.controlMode ?? "macro_v1";
      const grant = agentBroker.createGrant({
        roomId: this.roomId,
        ownerId: owner.ownerId,
        seatId,
        roomMode: this.policy.mode as Exclude<RoomMode, "classic">,
        agentName: agentLabel,
        archetype,
        controlMode,
        ...(parsed.openingTactic ? { openingTactic: parsed.openingTactic } : {}),
        sourceKey: this.ownerSourceKeys.get(owner.ownerId) ?? "unknown"
      });
      owner.agentSeatId = seatId;
      owner.agentLabel = agentLabel;
      owner.agentSeatState = "pending";
      owner.agentPairingExpiresAtMs = grant.expiresAtMs;
      owner.isReady = false;
      player.isReady = false;
      this.agentPairingRequests.set(owner.ownerId, grant.requestId);
      this.agentPairingExpiresAt.set(owner.ownerId, grant.expiresAtMs);
      this.syncWaitingAdmissionLock();
      client.send(SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT, {
        requestId: grant.requestId,
        action: "create",
        accepted: true,
        seatState: "pending",
        pairingCode: JSON.stringify({
          version: controlMode === "macro_v1"
            ? AGENT_PROTOCOL_VERSION
            : AGENT_TACTICAL_PROTOCOL_VERSION,
          roomId: this.roomId,
          grant: grant.grantCredential
        }),
        expiresAtMs: grant.expiresAtMs
      });
    } catch (error) {
      client.send(SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT, {
        requestId: "",
        action: "create",
        accepted: false,
        seatState: owner.agentSeatState,
        errorCode: this.agentErrorCode(error)
      });
    }
  }

  private handleAgentPairingCancel(client: Client, payload: unknown): void {
    const player = this.getPlayerOrError(client);
    if (!player) return;
    const owner = this.state.owners.get(player.ownerId);
    const parsed = this.parseAgentPairingCancel(payload);
    if (!owner || !parsed) {
      this.sendError(client, "invalid_payload", "Invalid pairing cancellation", false);
      return;
    }

    try {
      let requestId = this.agentPairingRequests.get(owner.ownerId);
      if (requestId) {
        agentBroker.cancelGrant(requestId, {
          roomId: this.roomId,
          ownerId: owner.ownerId
        });
        this.agentPairingRequests.delete(owner.ownerId);
        this.agentPairingExpiresAt.delete(owner.ownerId);
        this.clearOwnerAgentState(owner);
      } else {
        const error = new AgentBrokerError("principal_mismatch");
        const runtime = this.agentRuntimes.get(owner.agentSeatId);
        if (!runtime || runtime.principal.ownerId !== owner.ownerId) throw error;
        requestId = runtime.principal.requestId;
        try {
          agentBroker.cancelGrant(requestId, {
            roomId: this.roomId,
            ownerId: owner.ownerId
          });
        } catch {
          throw error;
        }
        this.releaseAgentSeat(runtime.principal, Date.now());
      }
      this.syncWaitingAdmissionLock();
      client.send(SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT, {
        requestId,
        action: "cancel",
        accepted: true,
        seatState: "none"
      });
    } catch (error) {
      client.send(SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT, {
        requestId: this.agentPairingRequests.get(owner.ownerId) ?? parsed.requestId ?? "",
        action: "cancel",
        accepted: false,
        seatState: owner.agentSeatState,
        errorCode: this.agentErrorCode(error)
      });
    }
  }

  private handleAgentControl(client: Client, payload: unknown): void {
    const player = this.getPlayerOrError(client);
    if (!player) return;
    const owner = this.state.owners.get(player.ownerId);
    const parsed = this.parseAgentControl(payload);
    if (!owner || !parsed || !owner.agentSeatId) {
      this.sendError(client, "invalid_payload", "Invalid agent control request", false);
      return;
    }

    try {
      const binding = {
        roomId: this.roomId,
        ownerId: owner.ownerId,
        seatId: owner.agentSeatId
      };
      if (parsed.action === "disconnect") {
        let principal: AgentControlPrincipal;
        try {
          principal = agentBroker.revokeControl(binding);
        } catch (error) {
          const runtime = this.agentRuntimes.get(owner.agentSeatId);
          if (!runtime) throw error;
          try {
            agentBroker.cancelGrant(runtime.principal.requestId, binding);
          } catch {
            throw error;
          }
          principal = runtime.principal;
        }
        this.releaseAgentSeat(principal, Date.now());
      } else {
        const session = agentBroker.setPaused(binding, parsed.action === "pause");
        this.syncAgentSession(session);
        if (parsed.action === "pause") {
          this.invalidateAgentObservation(owner.agentSeatId);
          this.neutralizeAgent(owner.agentSeatId, "paused");
        }
      }
      if (this.state.matchState === "countdown" && !this.canBeginCountdown()) {
        this.cancelCountdown();
      }
      if (this.state.matchState === "waiting" && this.hasEnoughReadyPlayers()) {
        this.beginCountdown();
      } else {
        this.ensureAutoStartTimer();
      }
      client.send(SERVER_MESSAGE_TYPES.AGENT_CONTROL_RESULT, {
        action: parsed.action,
        accepted: true,
        seatState: owner.agentSeatState
      });
    } catch (error) {
      client.send(SERVER_MESSAGE_TYPES.AGENT_CONTROL_RESULT, {
        action: parsed.action,
        accepted: false,
        seatState: owner.agentSeatState,
        errorCode: this.agentErrorCode(error)
      });
    }
  }

  private createOwner(client: HumanClient, principal: HumanPrincipal): OwnerSchema {
    const owner = new OwnerSchema();
    owner.ownerId = principal.ownerId;
    owner.humanSessionId = client.sessionId;
    owner.displayName = sanitizeDisplayName(principal.preferences.playerName);
    owner.principalKind = this.policy.mode === "agent_cup" ? "controller" : "combatant";
    owner.isConnected = true;
    owner.isReady = false;
    owner.isHost = this.state.owners.size === 0;
    return owner;
  }

  private createPlayer(
    client: HumanClient,
    joinOptions: JoinMessagePayload,
    owner: OwnerSchema
  ): PlayerSchema {
    const player = new PlayerSchema();
    const fallbackName = `Player ${client.sessionId.slice(0, 4).toUpperCase()}`;

    player.id = client.sessionId;
    player.sessionId = client.sessionId;
    player.ownerId = owner.ownerId;
    player.pairId = owner.ownerId;
    player.controlKind = "human";
    player.name = sanitizeDisplayName(joinOptions.playerName, fallbackName);
    applyTankConfig(player, joinOptions.archetypeId);
    player.fireCooldownMs = 0;
    player.abilityCooldownMs = 0;
    player.joinedAt = Date.now();
    player.isHost = owner.isHost;
    player.isReady = false;
    player.isAlive = this.policy.mode !== "agent_cup";
    player.isConnected = true;
    player.isSpectator = this.policy.mode === "agent_cup";
    if (!player.isSpectator) this.assignSpawnPosition(player, this.combatantCount());
    return player;
  }

  private handleJoinMessage(client: Client, payload: unknown): void {
    const parsed = parseJoinPayload(payload);
    const player = this.getPlayerOrError(client);
    if (!player) return;
    if (!parsed) {
      this.sendError(client, "invalid_payload", "Invalid join payload", false);
      return;
    }
    if (this.state.matchState !== "waiting") {
      this.sendError(client, "invalid_state", "Join updates are only accepted while waiting", false);
      return;
    }

    player.name = parsed.playerName;
    const owner = this.state.owners.get(player.ownerId);
    if (owner) owner.displayName = parsed.playerName;
    applyTankConfig(player, parsed.archetypeId);
    this.broadcastSystem("player_joined", `${player.name} joined`);
  }

  private handleReadyMessage(client: Client, payload: unknown): void {
    const parsed = parseReadyPayload(payload);
    const player = this.getPlayerOrError(client);
    if (!player) return;
    if (!parsed) {
      this.sendError(client, "invalid_payload", "Invalid ready payload", false, "ready");
      return;
    }
    if (this.state.matchState !== "waiting") {
      this.sendError(client, "invalid_state", "Ready changes are only accepted while waiting", false);
      return;
    }

    const owner = this.state.owners.get(player.ownerId);
    if (!owner) {
      this.sendError(client, "not_joined", "Owner is not joined", false);
      return;
    }
    if (parsed.ready && !this.ownerPairingComplete(owner)) {
      this.sendError(client, "invalid_state", "Connect or cancel the pending agent first", false);
      return;
    }

    owner.isReady = parsed.ready;
    player.isReady = parsed.ready;
    this.broadcastSystem("player_ready", `${player.name} is ${parsed.ready ? "ready" : "not ready"}`);
    this.ensureAutoStartTimer();

    if (this.hasEnoughReadyPlayers()) {
      this.beginCountdown();
    }
  }

  private handleStartMessage(client: Client, payload: unknown): void {
    const parsed = parseStartPayload(payload);
    const player = this.getPlayerOrError(client);
    if (!player) return;
    if (!parsed) {
      this.sendError(client, "invalid_payload", "Invalid start payload", false);
      return;
    }
    const owner = this.state.owners.get(player.ownerId);
    if (!owner?.isHost) {
      this.sendError(client, "invalid_state", "Only the host can start the match", false);
      return;
    }
    if (this.state.matchState !== "waiting") {
      this.sendError(client, "invalid_state", "Match is not waiting", false);
      return;
    }
    if (!this.canBeginCountdown()) {
      this.sendError(client, "invalid_state", "Every owner must be ready with required agent seats", true);
      return;
    }

    this.beginCountdown();
  }

  private handleInputMessage(client: Client, payload: unknown): void {
    const player = this.getPlayerOrError(client);
    if (!player) return;
    if (!this.isActiveMatchState()) {
      this.sendError(client, "invalid_state", "Input is only accepted during active match states", false);
      return;
    }
    if (!this.canAcceptPlayerIntent(player)) {
      this.sendError(client, "invalid_state", "Only active players can send input", false);
      return;
    }

    const parsed = parseInputPayload(payload);
    if (!parsed) {
      this.sendError(client, "invalid_payload", "Invalid input payload", false);
      return;
    }

    const current = this.inputIntents.get(client.sessionId);
    if (current && parsed.sequence <= current.sequence) return;
    this.inputIntents.set(client.sessionId, parsed);
  }

  private handleFireMessage(client: Client, payload: unknown): void {
    const player = this.getPlayerOrError(client);
    if (!player) return;
    if (!this.isActiveMatchState()) {
      this.sendError(client, "invalid_state", "Fire is only accepted during active match states", false);
      return;
    }
    if (!this.canAcceptPlayerIntent(player)) {
      this.sendError(client, "invalid_state", "Only active players can fire", false);
      return;
    }

    const parsed = parseFirePayload(payload);
    if (!parsed) {
      this.sendError(client, "invalid_payload", "Invalid fire payload", false);
      return;
    }
    const lastProcessed = this.lastProcessedFireSequences.get(client.sessionId);
    if (lastProcessed !== undefined && parsed.sequence <= lastProcessed) return;
    const current = this.fireIntents.get(client.sessionId);
    if (current && parsed.sequence < current.sequence) return;
    if (player.fireCooldownMs > 0) {
      this.sendError(client, "rate_limited", "Weapon is cooling down", true, "fire");
      return;
    }

    this.fireIntents.set(client.sessionId, parsed);
  }

  private handleAbilityMessage(client: Client, payload: unknown): void {
    const player = this.getPlayerOrError(client);
    if (!player) return;
    if (!this.isActiveMatchState()) {
      this.sendError(client, "invalid_state", "Ability is only accepted during active match states", false);
      return;
    }
    if (!this.canAcceptPlayerIntent(player)) {
      this.sendError(client, "invalid_state", "Only active players can use abilities", false);
      return;
    }

    const parsed = parseAbilityPayload(payload, player.abilityType);
    if (!parsed) {
      this.sendError(client, "invalid_payload", "Invalid ability payload", false);
      return;
    }
    const lastProcessed = this.lastProcessedAbilitySequences.get(client.sessionId);
    if (lastProcessed !== undefined && parsed.sequence <= lastProcessed) return;
    const current = this.abilityIntents.get(client.sessionId);
    if (current && parsed.sequence < current.sequence) return;
    if (player.abilityCooldownMs > 0) {
      this.sendError(client, "rate_limited", "Ability is cooling down", true, "ability");
      return;
    }
    const abilityConfig = ABILITY_CONFIG[player.abilityType];
    if (player.abilityCharge < abilityConfig.chargeCost) {
      this.sendError(client, "rate_limited", "Ability is not charged", true, "ability");
      return;
    }

    this.abilityIntents.set(client.sessionId, parsed);
  }

  private handleRematchMessage(client: Client, payload: unknown): void {
    const player = this.getPlayerOrError(client);
    if (!player) return;
    const parsed = parseRematchPayload(payload);
    if (!parsed) {
      this.sendError(client, "invalid_payload", "Invalid rematch payload", false);
      return;
    }
    if (this.state.matchState !== "finished") {
      this.sendError(client, "invalid_state", "Rematch voting opens after the match finishes", false);
      return;
    }
    if (parsed.previousMatchId !== this.state.match.matchId) {
      this.sendError(client, "invalid_payload", "Rematch vote does not match these results", false);
      return;
    }

    const owner = this.state.owners.get(player.ownerId);
    if (!owner) {
      this.sendError(client, "not_joined", "Owner is not joined", false);
      return;
    }
    if (parsed.ready) {
      this.rematchVotes.set(owner.ownerId, parsed);
    } else {
      this.rematchVotes.delete(owner.ownerId);
    }
    owner.isReady = parsed.ready;
    player.isReady = parsed.ready;

    this.broadcastSystem("rematch", `${player.name} updated rematch vote`);
    this.resolveRematchVotes(Date.now());
  }

  private onSimulationTick(deltaTime: number): void {
    const now = Date.now();
    this.state.serverTime = now;
    this.state.match.tick += 1;
    this.advanceTimedLifecycle(now);
    if (this.isActiveMatchState()) {
      this.runAuthoritativeSimulation(deltaTime, now);
    }
  }

  private advanceTimedLifecycle(now: number): void {
    if (this.state.matchState === "countdown" && now >= this.state.match.countdownEndsAt) {
      this.startRunning(now);
      return;
    }

    if (this.state.matchState === "running" && now >= this.dangerStartsAt) {
      this.transitionTo("danger", now);
      this.runAgentExecutors(now, true);
      return;
    }

    if (this.state.matchState === "danger" && now >= this.finalZoneStartsAt) {
      this.transitionTo("final_zone", now);
      this.runAgentExecutors(now, true);
      return;
    }

    if (this.state.matchState === "final_zone" && now >= this.finishedAt) {
      this.finishMatch(now);
    }
  }

  private beginCountdown(): void {
    if (this.state.matchState !== "waiting" || !this.canBeginCountdown()) return;

    this.autoStartTimer?.clear();
    this.autoStartTimer = undefined;
    void this.lock();

    const now = Date.now();
    this.state.match.countdownEndsAt = now + COUNTDOWN_MS;
    this.transitionTo("countdown", now);
  }

  private cancelCountdown(): void {
    if (this.state.matchState !== "countdown") return;

    this.state.match.countdownEndsAt = 0;
    this.transitionTo("waiting", Date.now());
    this.syncWaitingAdmissionLock();
  }

  private startRunning(now: number): void {
    if (!this.canBeginCountdown()) {
      this.cancelCountdown();
      return;
    }
    this.runningStartedAt = now;
    this.dangerStartsAt = this.zonePhaseStartAt("danger", now, DANGER_AFTER_RUNNING_MS);
    this.finalZoneStartsAt = this.zonePhaseStartAt("final_zone", now, FINAL_ZONE_AFTER_RUNNING_MS);
    this.finishedAt = this.zoneFinishAt(now, FINISHED_AFTER_RUNNING_MS);
    this.state.match.countdownEndsAt = 0;
    this.state.match.matchEndsAt = this.finishedAt;
    this.rematchVotes.clear();
    this.resetPlayersForMatchStart();
    this.initializePickups(now);
    this.state.match.alivePlayers = alivePlayerCount(this.state);
    this.transitionTo("running", now);
    for (const runtime of this.agentRuntimes.values()) {
      if (!runtime.tactical || runtime.tactical.intent.basedOnObservationSeq === null) {
        this.armTacticalOpening(runtime, now);
      }
    }
    this.runAgentExecutors(now, true);
  }

  private transitionTo(matchState: MatchState, at: number): void {
    this.state.setMatchState(matchState);
    this.state.match.stateStartedAt = at;
    this.applyZonePhase(matchState, at);
    this.broadcastSystem("match_state", `Match state changed to ${matchState}`);
    void this.updateMetadata();
  }

  private syncArenaConfig(): void {
    if (!this.arena) return;
    this.state.arenaConfigJson = JSON.stringify(this.arena);
  }

  private assignSpawnPosition(player: PlayerSchema, index: number): void {
    const spawnPoints = this.arena?.spawnPoints;
    const spawn = spawnPoints?.[index];
    if (!spawn) throw new Error(`missing distinct spawn ${index}`);

    player.x = spawn.x;
    player.y = spawn.y;
    player.rotation = spawn.rotation ?? player.rotation;
    player.turretRotation = player.rotation;
    player.velocityX = 0;
    player.velocityY = 0;
  }

  private resetPlayersForMatchStart(): void {
    let spawnIndex = 0;
    this.inputIntents.clear();
    this.fireIntents.clear();
    this.abilityIntents.clear();
    this.state.projectiles.splice(0, this.state.projectiles.length);
    this.lastProcessedFireSequences.clear();
    this.lastProcessedAbilitySequences.clear();
    this.speedEffects.clear();
    this.rapidFireEffects.clear();
    this.shieldEffects.clear();
    this.smokeEffects.clear();
    this.zoneDamageRemainders.clear();

    for (const player of this.state.players.values()) {
      player.teamPlacement = 0;
      player.teamKills = 0;
      if (!player.isConnected) continue;

      if (this.policy.mode === "agent_cup" && player.controlKind === "human") {
        player.isAlive = false;
        player.isReady = false;
        player.isSpectator = true;
        continue;
      }

      applyTankConfig(player, player.archetypeId);
      this.assignSpawnPosition(player, spawnIndex);
      player.shield = 0;
      player.ammo = 0;
      player.abilityCharge = MAX_ABILITY_CHARGE;
      player.fireCooldownMs = 0;
      player.abilityCooldownMs = 0;
      player.score = 0;
      player.kills = 0;
      player.deaths = 0;
      player.damageDealt = 0;
      player.damageTaken = 0;
      player.placement = 0;
      player.respawnAt = 0;
      player.survivalTimeMs = 0;
      player.isAlive = true;
      player.isReady = false;
      player.isSpectator = false;
      spawnIndex += 1;
    }
  }

  private initializePickups(now: number): void {
    this.state.pickups.splice(0, this.state.pickups.length);

    for (const placement of this.arena?.pickupPlacements ?? []) {
      const pickup = new PickupSchema();
      pickup.id = placement.id;
      pickup.pickupType = placement.pickupType;
      pickup.x = placement.x;
      pickup.y = placement.y;
      pickup.radius = placement.radius;
      pickup.value = placement.value;
      pickup.durationMs = placement.durationMs;
      pickup.spawnedAt = now;
      pickup.respawnsAt = 0;
      pickup.isActive = true;
      this.state.pickups.push(pickup);
    }
  }

  private runAuthoritativeSimulation(deltaTime: number, now: number): void {
    const deltaMs = clamp(deltaTime, 0, MAX_SIMULATION_DELTA_MS);

    this.updateZoneState(now);
    this.updateCombatState(deltaMs, now);
    this.applyAuthoritativeMovement(deltaMs, now);
    this.neutralizeInvalidAgentTargets(now);
    this.processAbilityIntents(now);
    this.collectPickups(now);
    this.processFireIntents(now);
    this.simulateProjectiles(deltaMs, now);
    this.applyZoneDamage(deltaMs, now);
    this.respawnPickups(now);
    this.state.match.alivePlayers = alivePlayerCount(this.state);
    this.checkForMatchConclusion(now);
  }

  private updateCombatState(deltaMs: number, now: number): void {
    const deltaCharge = (deltaMs / 1_000) * ABILITY_CHARGE_PER_SECOND;

    for (const player of this.state.players.values()) {
      player.fireCooldownMs = Math.max(0, player.fireCooldownMs - deltaMs);
      player.abilityCooldownMs = Math.max(0, player.abilityCooldownMs - deltaMs);

      if (this.canAcceptPlayerIntent(player)) {
        player.abilityCharge = clamp(player.abilityCharge + deltaCharge, 0, MAX_ABILITY_CHARGE);
        player.survivalTimeMs = Math.max(0, now - this.runningStartedAt);
      }
    }

    for (const [sessionId, effect] of this.shieldEffects.entries()) {
      if (effect.expiresAt > now) continue;
      const player = this.state.players.get(sessionId);
      if (player) {
        player.shield = Math.max(0, player.shield - effect.remaining);
      }
      this.shieldEffects.delete(sessionId);
    }

    for (const [sessionId, effect] of this.speedEffects.entries()) {
      if (effect.expiresAt <= now) this.speedEffects.delete(sessionId);
    }
    for (const [sessionId, effect] of this.rapidFireEffects.entries()) {
      if (effect.expiresAt > now) continue;
      const player = this.state.players.get(sessionId);
      if (player && player.weaponType !== "explosive") {
        player.ammo = 0;
      }
      this.rapidFireEffects.delete(sessionId);
    }
    for (const [sessionId, effect] of this.smokeEffects.entries()) {
      if (effect.expiresAt <= now) this.smokeEffects.delete(sessionId);
    }

    for (const player of this.state.players.values()) {
      this.restoreBaseWeaponIfNeeded(player);
    }
  }

  private applyAuthoritativeMovement(deltaTime: number, now: number): void {
    const arena = this.arena;
    if (!arena) return;
    const deltaSeconds = clamp(deltaTime, 0, MAX_SIMULATION_DELTA_MS) / 1_000;
    if (deltaSeconds <= 0) return;

    for (const [sessionId, player] of this.state.players.entries()) {
      if (!this.canAcceptPlayerIntent(player)) {
        player.velocityX = 0;
        player.velocityY = 0;
        continue;
      }

      const intent = this.inputIntents.get(sessionId);
      if (!intent) {
        this.applyPlayerMovement(arena, player, { moveX: 0, moveY: 0 }, deltaSeconds, now);
        continue;
      }
      if (now - intent.receivedAt > INPUT_INTENT_TTL_MS) {
        this.inputIntents.delete(sessionId);
        this.applyPlayerMovement(arena, player, { moveX: 0, moveY: 0 }, deltaSeconds, now);
        continue;
      }

      this.applyPlayerMovement(arena, player, intent, deltaSeconds, now);
    }
  }

  private applyPlayerMovement(
    arena: ArenaConfig,
    player: PlayerSchema,
    intent: MovementIntent,
    deltaSeconds: number,
    now: number
  ): void {
    const tankConfig = TANK_ARCHETYPE_CONFIG[player.archetypeId];
    const previousRotation = player.rotation;
    player.speedMultiplier = this.speedMultiplierFor(player);
    const movement = integrateTankMovement({
      state: player,
      input: { moveX: intent.moveX, moveY: intent.moveY },
      deltaSeconds,
      maxSpeed: tankConfig.speed,
      handling: tankConfig.handling,
      speedMultiplier: player.speedMultiplier
    });
    const next = this.resolveArenaMovement(
      arena,
      player.x,
      player.y,
      movement.x,
      movement.y,
      this.playerCollisionRadius()
    );
    const runtime = this.agentRuntimes.get(player.sessionId);
    const turned = Math.abs(Math.atan2(
      Math.sin(movement.rotation - previousRotation),
      Math.cos(movement.rotation - previousRotation)
    )) > 0.0001;
    const madeTacticalProgress = runtime?.principal.controlMode === "tactical_reflex_v1" &&
      (Math.hypot(next.x - player.x, next.y - player.y) > 0.001 ||
        (runtime.tacticalTurningToClear && turned));
    const routeBlocked =
      player.controlKind === "agent" &&
      Math.hypot(intent.moveX, intent.moveY) > 0 &&
      Math.hypot(next.x - movement.x, next.y - movement.y) > 0.001 &&
      !madeTacticalProgress;

    player.velocityX = (next.x - player.x) / deltaSeconds;
    player.velocityY = (next.y - player.y) / deltaSeconds;
    player.x = next.x;
    player.y = next.y;
    player.rotation = movement.rotation;
    const aimX = intent.aimX;
    const aimY = intent.aimY;
    if (
      typeof aimX === "number" &&
      typeof aimY === "number" &&
      Number.isFinite(aimX) &&
      Number.isFinite(aimY)
    ) {
      player.turretRotation = angleTo(player.x, player.y, aimX, aimY);
    }
    if (routeBlocked) {
      const targetId = runtime?.lease?.action.targetId;
      const target = targetId ? this.state.players.get(targetId) : undefined;
      const preserveTactical = runtime?.principal.controlMode === "tactical_reflex_v1" &&
        runtime.tactical !== undefined;
      const survivalZone = this.agentTacticalSurvivalZone(player, now);
      const preserveTacticalLease = preserveTactical && (
        (target?.isAlive && Math.hypot(target.x - player.x, target.y - player.y) <
          AGENT_TACTICAL_COMBAT_DISTANCE - AGENT_TACTICAL_COMBAT_DISTANCE_TOLERANCE) ||
        Math.hypot(player.x - survivalZone.x, player.y - survivalZone.z) > survivalZone.safeRadius
      );
      this.neutralizeAgent(player.sessionId, "route_blocked", preserveTactical, now, preserveTacticalLease);
      if (preserveTactical && runtime) runtime.tacticalStopReason = "route_blocked";
    }
  }

  private updateZoneState(now: number): void {
    const phase = this.getZonePhase(this.state.matchState);
    if (!phase) return;

    const duration = this.state.zonePhase.closesAt - this.state.zonePhase.startsAt;
    const progress =
      duration > 0
        ? clamp((now - this.state.zonePhase.startsAt) / duration, 0, 1)
        : 0;

    this.state.zone.x = lerp(phase.x, phase.targetX, progress);
    this.state.zone.y = lerp(phase.y, phase.targetY, progress);
    this.state.zone.radius = lerp(phase.radius, phase.targetRadius, progress);
    this.state.zone.damagePerSecond = phase.damagePerSecond;
  }

  private speedMultiplierFor(player: PlayerSchema): number {
    const effect = this.speedEffects.get(player.sessionId);
    return effect?.multiplier ?? 1;
  }

  private processAbilityIntents(now: number): void {
    for (const [sessionId, intent] of this.abilityIntents.entries()) {
      this.abilityIntents.delete(sessionId);
      const player = this.state.players.get(sessionId);
      if (!player || !this.canAcceptPlayerIntent(player)) continue;
      if (now - intent.receivedAt > INPUT_INTENT_TTL_MS) continue;
      if ((this.lastProcessedAbilitySequences.get(sessionId) ?? -1) >= intent.sequence) continue;

      const abilityConfig = ABILITY_CONFIG[player.abilityType];
      if (player.abilityCooldownMs > 0 || player.abilityCharge < abilityConfig.chargeCost) continue;
      if (!this.activateAbility(player, abilityConfig.id, now)) continue;

      this.recordAbilityActivation(player, abilityConfig.id, now, abilityConfig.durationMs);
      player.abilityCharge = clamp(
        player.abilityCharge - abilityConfig.chargeCost,
        0,
        MAX_ABILITY_CHARGE
      );
      player.abilityCooldownMs = abilityConfig.cooldownMs;
      this.lastProcessedAbilitySequences.set(sessionId, intent.sequence);
    }
  }

  private activateAbility(
    player: PlayerSchema,
    abilityType: PlayerSchema["abilityType"],
    now: number
  ): boolean {
    switch (abilityType) {
      case "repair": {
        if (player.health >= player.maxHealth && player.armor >= player.maxArmor) return false;
        player.health = clamp(player.health + REPAIR_HEALTH_AMOUNT, 0, player.maxHealth);
        player.armor = clamp(player.armor + REPAIR_ARMOR_AMOUNT, 0, player.maxArmor);
        return true;
      }
      case "shield_pulse":
        this.grantShield(player, SHIELD_PULSE_AMOUNT, ABILITY_CONFIG.shield_pulse.durationMs, now);
        return true;
      case "speed_burst":
        this.applyMultiplierEffect(
          this.speedEffects,
          player.sessionId,
          SPEED_BURST_MULTIPLIER,
          now + ABILITY_CONFIG.speed_burst.durationMs
        );
        return true;
      case "smoke":
        this.applyReductionEffect(
          player,
          SMOKE_DAMAGE_REDUCTION,
          now + ABILITY_CONFIG.smoke.durationMs,
          ABILITY_CONFIG.smoke.radius,
          now
        );
        return true;
      case "barrage":
        this.enableExplosiveWeapon(player, WEAPON_CONFIG.explosive.ammoCost * 3);
        return true;
      default:
        return false;
    }
  }

  private processFireIntents(now: number): void {
    for (const [sessionId, intent] of this.fireIntents.entries()) {
      this.fireIntents.delete(sessionId);
      const player = this.state.players.get(sessionId);
      if (!player || !this.canAcceptPlayerIntent(player)) continue;
      if (now - intent.receivedAt > INPUT_INTENT_TTL_MS) continue;
      if ((this.lastProcessedFireSequences.get(sessionId) ?? -1) >= intent.sequence) continue;

      const weaponConfig = WEAPON_CONFIG[player.weaponType];
      if (player.fireCooldownMs > 0) continue;
      if (player.weaponType === "explosive" && player.ammo < weaponConfig.ammoCost) {
        this.restoreBaseWeaponIfNeeded(player);
        continue;
      }

      if (!this.spawnProjectile(player, intent, weaponConfig, now)) continue;

      const rapidFireActive =
        player.weaponType !== "explosive" && this.isRapidFireActive(player, now);
      if (player.weaponType === "explosive") {
        player.ammo = Math.max(0, player.ammo - weaponConfig.ammoCost);
      } else if (rapidFireActive && player.ammo > 0) {
        player.ammo = Math.max(0, player.ammo - weaponConfig.ammoCost);
        if (player.ammo === 0) {
          this.rapidFireEffects.delete(sessionId);
        }
      }

      player.fireCooldownMs =
        rapidFireActive && weaponConfig.category !== "explosive"
          ? Math.max(1, Math.round(weaponConfig.fireCooldownMs * RAPID_FIRE_COOLDOWN_MULTIPLIER))
          : weaponConfig.fireCooldownMs;
      this.lastProcessedFireSequences.set(sessionId, intent.sequence);
      this.restoreBaseWeaponIfNeeded(player);
    }
  }

  private isRapidFireActive(player: PlayerSchema, now: number): boolean {
    const effect = this.rapidFireEffects.get(player.sessionId);
    return Boolean(effect && effect.expiresAt > now && player.ammo > 0);
  }

  private spawnProjectile(
    player: PlayerSchema,
    intent: StoredFireIntent,
    weaponConfig: (typeof WEAPON_CONFIG)[PlayerSchema["weaponType"]],
    now: number
  ): boolean {
    const baseAngle =
      Number.isFinite(intent.aimX) && Number.isFinite(intent.aimY)
        ? angleTo(player.x, player.y, intent.aimX, intent.aimY)
        : player.turretRotation;
    const angle = baseAngle + deterministicSpread(intent.sequence, weaponConfig.spreadRadians);
    const radius = projectileRadius(player.weaponType);
    const minimumSpawnDistance = this.playerCollisionRadius() + radius + PROJECTILE_MIN_SPAWN_PADDING;
    let spawnDistance = projectileSpawnDistance(radius);
    while (this.arena && spawnDistance > minimumSpawnDistance) {
      const candidateX = player.x + Math.cos(angle) * spawnDistance;
      const candidateY = player.y + Math.sin(angle) * spawnDistance;
      if (!isWallCollision(this.arena, candidateX, candidateY, radius)) break;
      spawnDistance = Math.max(minimumSpawnDistance, spawnDistance - 6);
    }
    const spawnX = player.x + Math.cos(angle) * spawnDistance;
    const spawnY = player.y + Math.sin(angle) * spawnDistance;

    if (this.arena && isWallCollision(this.arena, spawnX, spawnY, radius)) {
      return false;
    }

    const projectile = new ProjectileSchema();
    projectile.id = `${this.state.match.matchId}-p${++this.projectileCounter}`;
    projectile.ownerId = player.sessionId;
    projectile.weaponType = player.weaponType;
    projectile.fireSequence = intent.sequence;
    projectile.x = spawnX;
    projectile.y = spawnY;
    projectile.velocityX = Math.cos(angle) * weaponConfig.projectileSpeed;
    projectile.velocityY = Math.sin(angle) * weaponConfig.projectileSpeed;
    projectile.rotation = angle;
    projectile.damage = weaponConfig.damage;
    projectile.radius = radius;
    projectile.splashRadius = weaponConfig.splashRadius;
    projectile.spawnedAt = now;
    projectile.expiresAt = now + weaponConfig.projectileLifetimeMs;
    player.turretRotation = angle;

    const muzzleWallHit = this.arena
      ? projectileWallHit(this.arena, player.x, player.y, spawnX, spawnY, radius)
      : { hit: false as const, t: 1, x: spawnX, y: spawnY };
    let muzzleTankHit:
      | { target: PlayerSchema; t: number; x: number; y: number }
      | undefined;
    for (const target of this.state.players.values()) {
      if (!this.canParticipateInCombat(target) || target.sessionId === player.sessionId) continue;
      if (this.areFriendly(player, target)) continue;
      const hit = segmentCircleFirstEntry(
        target.x,
        target.y,
        player.x,
        player.y,
        spawnX,
        spawnY,
        this.playerCollisionRadius() + radius
      );
      if (hit && (!muzzleTankHit || hit.t < muzzleTankHit.t)) {
        muzzleTankHit = { target, ...hit };
      }
    }
    if (muzzleWallHit.hit && (!muzzleTankHit || muzzleWallHit.t <= muzzleTankHit.t)) {
      this.broadcastProjectileImpact(projectile, "wall", muzzleWallHit.x, muzzleWallHit.y, now);
      if (projectile.splashRadius > 0) {
        this.applyExplosionDamage(projectile, muzzleWallHit.x, muzzleWallHit.y, undefined, now);
      }
      return true;
    }
    if (muzzleTankHit) {
      const shieldHit = muzzleTankHit.target.shield > 0;
      const damage = this.applyDamage(muzzleTankHit.target, player, projectile.damage, now);
      if (projectile.splashRadius > 0) {
        this.applyExplosionDamage(
          projectile,
          muzzleTankHit.x,
          muzzleTankHit.y,
          muzzleTankHit.target.sessionId,
          now
        );
      }
      this.broadcastProjectileImpact(projectile, "tank", muzzleTankHit.x, muzzleTankHit.y, now, {
        targetSessionId: muzzleTankHit.target.sessionId,
        damage,
        destroyed: !muzzleTankHit.target.isAlive || muzzleTankHit.target.health <= 0,
        shieldHit
      });
      return true;
    }
    this.state.projectiles.push(projectile);
    return true;
  }

  private broadcastProjectileImpact(
    projectile: ProjectileSchema,
    reason: ProjectileImpactMessagePayload["reason"],
    x: number,
    y: number,
    now: number,
    extra?: Pick<
      ProjectileImpactMessagePayload,
      "targetSessionId" | "damage" | "destroyed" | "shieldHit"
    >
  ): void {
    this.broadcast(SERVER_MESSAGE_TYPES.PROJECTILE_IMPACT, {
      projectileId: projectile.id,
      ownerId: projectile.ownerId,
      fireSequence: projectile.fireSequence,
      weaponType: projectile.weaponType,
      reason,
      x,
      y,
      rotation: projectile.rotation,
      radius: projectile.radius,
      splashRadius: projectile.splashRadius,
      ...(extra ?? {}),
      at: now
    });
  }

  private simulateProjectiles(deltaMs: number, now: number): void {
    const arena = this.arena;
    if (!arena || deltaMs <= 0) return;

    const deltaSeconds = deltaMs / 1_000;
    const collisionRadius = this.playerCollisionRadius();

    for (let index = this.state.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.state.projectiles[index];
      if (!projectile) continue;

      if (now >= projectile.expiresAt) {
        this.broadcastProjectileImpact(projectile, "range", projectile.x, projectile.y, now);
        if (projectile.splashRadius > 0) {
          this.applyExplosionDamage(projectile, projectile.x, projectile.y, undefined, now);
        }
        this.state.projectiles.splice(index, 1);
        continue;
      }

      const nextX = projectile.x + projectile.velocityX * deltaSeconds;
      const nextY = projectile.y + projectile.velocityY * deltaSeconds;

      const wallHit = projectileWallHit(arena, projectile.x, projectile.y, nextX, nextY, projectile.radius);
      let tankHit:
        | {
            target: PlayerSchema;
            t: number;
            x: number;
            y: number;
          }
        | undefined;
      for (const target of this.state.players.values()) {
        if (!this.canParticipateInCombat(target) || target.sessionId === projectile.ownerId) continue;
        const owner = this.state.players.get(projectile.ownerId);
        if (owner && this.areFriendly(owner, target)) continue;

        const hitRadius = collisionRadius + projectile.radius;
        const hit = segmentCircleFirstEntry(
          target.x,
          target.y,
          projectile.x,
          projectile.y,
          nextX,
          nextY,
          hitRadius
        );
        if (!hit) continue;

        if (!tankHit || hit.t < tankHit.t) {
          tankHit = {
            target,
            t: hit.t,
            x: hit.x,
            y: hit.y
          };
        }
      }

      if (wallHit.hit && (!tankHit || wallHit.t <= tankHit.t)) {
        this.broadcastProjectileImpact(projectile, "wall", wallHit.x, wallHit.y, now);
        if (projectile.splashRadius > 0) {
          this.applyExplosionDamage(projectile, wallHit.x, wallHit.y, undefined, now);
        }
        this.state.projectiles.splice(index, 1);
        continue;
      }

      if (tankHit) {
        const owner = this.state.players.get(projectile.ownerId);
        const shieldHit = tankHit.target.shield > 0;
        const damage = this.applyDamage(tankHit.target, owner, projectile.damage, now);
        if (projectile.splashRadius > 0) {
          this.applyExplosionDamage(projectile, tankHit.x, tankHit.y, tankHit.target.sessionId, now);
        }
        this.broadcastProjectileImpact(projectile, "tank", tankHit.x, tankHit.y, now, {
          targetSessionId: tankHit.target.sessionId,
          damage,
          destroyed: !tankHit.target.isAlive || tankHit.target.health <= 0,
          shieldHit
        });
        this.state.projectiles.splice(index, 1);
        continue;
      }

      projectile.x = nextX;
      projectile.y = nextY;
    }
  }

  private applyExplosionDamage(
    projectile: ProjectileSchema,
    centerX: number,
    centerY: number,
    excludedSessionId: string | undefined,
    now: number
  ): void {
    if (projectile.splashRadius <= 0) return;

    const owner = this.state.players.get(projectile.ownerId);
    const collisionRadius = this.playerCollisionRadius();
    for (const target of this.state.players.values()) {
      if (!this.canParticipateInCombat(target)) continue;
      if (target.sessionId === projectile.ownerId || target.sessionId === excludedSessionId) continue;
      if (owner && this.areFriendly(owner, target)) continue;

      const distance = Math.hypot(target.x - centerX, target.y - centerY);
      const reach = projectile.splashRadius + collisionRadius;
      if (distance > reach) continue;

      const falloff = 1 - distance / reach;
      const splashDamage = Math.max(1, Math.round(projectile.damage * 0.65 * falloff));
      this.applyDamage(target, owner, splashDamage, now);
    }
  }

  private collectPickups(now: number): void {
    const collectionRadius = this.playerCollisionRadius();

    for (const pickup of this.state.pickups) {
      if (!pickup?.isActive) continue;

      for (const player of this.state.players.values()) {
        if (!this.canAcceptPlayerIntent(player)) continue;
        const distance = Math.hypot(player.x - pickup.x, player.y - pickup.y);
        if (distance > collectionRadius + pickup.radius) continue;
        if (pickup.pickupType === "health_repair" && player.health >= player.maxHealth) continue;
        if (pickup.pickupType === "ability_charge" && player.abilityCharge >= MAX_ABILITY_CHARGE) continue;

        const appliedValue = this.applyPickupEffect(player, pickup, now);
        pickup.isActive = false;
        pickup.respawnsAt = now + PICKUP_CONFIG[pickup.pickupType].respawnMs;
        const pickupConfig = PICKUP_CONFIG[pickup.pickupType];
        this.broadcastSystem("pickup_collected", `${player.name} collected ${pickupConfig.name}`, {
          playerSessionId: player.sessionId,
          playerName: player.name,
          pickupType: pickup.pickupType,
          pickupName: pickupConfig.name,
          pickupValue: appliedValue,
          pickupDurationMs: pickup.durationMs
        });
        this.recordAgentOutcome(player, "pickup", {
          pickupId: pickup.id,
          pickupType: pickup.pickupType,
          appliedValue
        });
        break;
      }
    }
  }

  private applyPickupEffect(player: PlayerSchema, pickup: PickupSchema, now: number): number {
    switch (pickup.pickupType) {
      case "health_repair": {
        const before = player.health;
        player.health = clamp(player.health + pickup.value, 0, player.maxHealth);
        return player.health - before;
      }
      case "shield_armor": {
        const before = player.armor;
        player.armor = clamp(player.armor + pickup.value, 0, player.maxArmor);
        this.grantShield(player, Math.round(pickup.value / 2), pickup.durationMs, now);
        return player.armor - before;
      }
      case "ammo_rapid_fire":
        player.ammo += pickup.value;
        this.applyMultiplierEffect(
          this.rapidFireEffects,
          player.sessionId,
          RAPID_FIRE_COOLDOWN_MULTIPLIER,
          now + pickup.durationMs
        );
        return pickup.value;
      case "speed_boost":
        this.applyMultiplierEffect(
          this.speedEffects,
          player.sessionId,
          pickup.value,
          now + pickup.durationMs
        );
        return pickup.value;
      case "ability_charge": {
        const before = player.abilityCharge;
        player.abilityCharge = clamp(player.abilityCharge + pickup.value, 0, MAX_ABILITY_CHARGE);
        return player.abilityCharge - before;
      }
      case "smoke":
        this.applyReductionEffect(
          player,
          SMOKE_DAMAGE_REDUCTION,
          now + pickup.durationMs,
          ABILITY_CONFIG.smoke.radius,
          now
        );
        return pickup.value;
      case "barrage_explosive":
        this.enableExplosiveWeapon(player, WEAPON_CONFIG.explosive.ammoCost * 3);
        return pickup.value;
    }
  }

  private respawnPickups(now: number): void {
    const collectionRadius = this.playerCollisionRadius();
    for (const pickup of this.state.pickups) {
      if (!pickup || pickup.isActive || pickup.respawnsAt <= 0 || pickup.respawnsAt > now) continue;
      const occupied = Array.from(this.state.players.values()).some(
        (player) =>
          this.canAcceptPlayerIntent(player) &&
          Math.hypot(player.x - pickup.x, player.y - pickup.y) <= collectionRadius + pickup.radius
      );
      if (occupied) continue;
      pickup.isActive = true;
      pickup.spawnedAt = now;
      pickup.respawnsAt = 0;
    }
  }

  private applyZoneDamage(deltaMs: number, now: number): void {
    if (deltaMs <= 0 || this.state.zone.damagePerSecond <= 0) return;

    const rawDamage = (this.state.zone.damagePerSecond * deltaMs) / 1_000;
    const exposedPlayers = Array.from(this.state.players.values()).filter((player) => {
      if (!this.canParticipateInCombat(player)) {
        this.zoneDamageRemainders.delete(player.sessionId);
        return false;
      }

      const distance = Math.hypot(player.x - this.state.zone.x, player.y - this.state.zone.y);
      if (distance <= this.state.zone.radius) {
        this.zoneDamageRemainders.delete(player.sessionId);
        return false;
      }

      return true;
    });
    const previousBatchPlacement = this.eliminationBatchPlacement;
    this.eliminationBatchPlacement =
      exposedPlayers.length > 1 ? Math.max(2, alivePlayerCount(this.state)) : undefined;

    try {
      for (const player of exposedPlayers) {
        const pendingDamage = (this.zoneDamageRemainders.get(player.sessionId) ?? 0) + rawDamage;
        const wholeDamage = Math.floor(pendingDamage);
        this.zoneDamageRemainders.set(player.sessionId, pendingDamage - wholeDamage);
        if (wholeDamage > 0) {
          this.applyDamage(player, undefined, wholeDamage, now, false);
        }
      }
    } finally {
      this.eliminationBatchPlacement = previousBatchPlacement;
    }
  }

  private applyDamage(
    target: PlayerSchema,
    source: PlayerSchema | undefined,
    rawDamage: number,
    now: number,
    smokeCanReduce = true
  ): number {
    if (!this.canParticipateInCombat(target) || rawDamage <= 0) return 0;
    if (source && this.areFriendly(source, target)) return 0;

    const smokeEffect = this.smokeEffects.get(target.sessionId);
    const insideSmoke = Boolean(
      smokeCanReduce &&
        smokeEffect &&
        smokeEffect.expiresAt > now &&
        Math.hypot(target.x - smokeEffect.x, target.y - smokeEffect.y) <= smokeEffect.radius
    );
    const reducedDamage =
      insideSmoke && smokeEffect
        ? rawDamage * (1 - smokeEffect.reduction)
        : rawDamage;
    let remaining = Math.max(1, Math.round(reducedDamage));
    let applied = 0;

    if (target.shield > 0 && remaining > 0) {
      const absorbed = Math.min(target.shield, remaining);
      target.shield -= absorbed;
      remaining -= absorbed;
      applied += absorbed;
      this.consumeShieldEffect(target.sessionId, absorbed);
    }
    if (target.armor > 0 && remaining > 0) {
      const absorbed = Math.min(target.armor, remaining);
      target.armor -= absorbed;
      remaining -= absorbed;
      applied += absorbed;
    }
    if (target.health > 0 && remaining > 0) {
      const absorbed = Math.min(target.health, remaining);
      target.health -= absorbed;
      remaining -= absorbed;
      applied += absorbed;
    }
    if (applied <= 0) return 0;

    target.damageTaken += applied;
    target.abilityCharge = clamp(
      target.abilityCharge + applied * DAMAGE_TAKEN_CHARGE_RATIO,
      0,
      MAX_ABILITY_CHARGE
    );

    if (source && source.sessionId !== target.sessionId) {
      source.damageDealt += applied;
      source.abilityCharge = clamp(
        source.abilityCharge + applied * DAMAGE_TO_CHARGE_RATIO,
        0,
        MAX_ABILITY_CHARGE
      );
      this.recordAgentOutcome(source, "damage_dealt", {
        targetId: target.sessionId,
        damage: applied
      });
    }
    this.recordAgentOutcome(target, "damage_taken", {
      sourceId: source?.sessionId ?? null,
      damage: applied
    });

    if (target.health <= 0) {
      this.eliminatePlayer(
        target,
        source && source.sessionId !== target.sessionId ? source : undefined,
        now
      );
    }

    return applied;
  }

  private eliminatePlayer(
    player: PlayerSchema,
    killer: PlayerSchema | undefined,
    now: number
  ): void {
    if (!player.isAlive) return;
    const placement =
      player.placement || this.eliminationBatchPlacement || Math.max(2, alivePlayerCount(this.state));

    player.health = 0;
    player.shield = 0;
    player.velocityX = 0;
    player.velocityY = 0;
    player.fireCooldownMs = 0;
    player.abilityCooldownMs = 0;
    player.isAlive = false;
    player.isSpectator = true;
    player.deaths += 1;
    player.survivalTimeMs = Math.max(0, now - this.runningStartedAt);
    player.placement = placement;
    this.clearPlayerRuntimeState(player.sessionId, player);
    this.neutralizeInvalidAgentTargets(now);

    if (killer) {
      killer.kills += 1;
      this.syncWingmanPairKills(killer.pairId);
      killer.score += 100;
      this.recordAgentOutcome(killer, "elimination_scored", { targetId: player.sessionId });
    }
    this.recordAgentOutcome(player, "eliminated", {
      killerId: killer?.sessionId ?? null,
      placement
    });
  }

  private checkForMatchConclusion(now: number): void {
    if (!this.isActiveMatchState()) return;

    const alivePlayers = Array.from(this.state.players.values()).filter((player) =>
      this.canParticipateInCombat(player)
    );
    if (this.policy.mode === "wingman") {
      const alivePairs = new Set(alivePlayers.map((player) => player.pairId));
      if (alivePairs.size > 1) return;
      this.finishMatch(now, alivePlayers[0], alivePlayers[0]?.pairId);
      return;
    }
    if (alivePlayers.length > 1) return;

    const winner = alivePlayers[0];
    if (winner) {
      winner.placement = 1;
      winner.score += 250;
      winner.survivalTimeMs = Math.max(0, now - this.runningStartedAt);
    }

    this.finishMatch(now, winner);
  }

  private finishMatch(now: number, winner?: PlayerSchema, winningPairId?: string): void {
    if (this.state.matchState === "finished") return;

    const rankedSurvivors = Array.from(this.state.players.values())
      .filter((player) => this.canParticipateInCombat(player));
    for (const survivor of rankedSurvivors) {
      survivor.survivalTimeMs = Math.max(survivor.survivalTimeMs, now - this.runningStartedAt);
    }
    rankedSurvivors.sort((left, right) => this.compareWinnerCandidates(left, right));
    const resolvedWinningPairId = this.policy.mode === "wingman"
      ? this.finalizeWingmanResults(winningPairId)
      : undefined;
    const resolvedWinner = winner ?? rankedSurvivors.find(
      (player) => resolvedWinningPairId === undefined || player.pairId === resolvedWinningPairId
    ) ?? this.resolveWinnerCandidate(resolvedWinningPairId);
    let placement = resolvedWinner ? 2 : 1;

    if (resolvedWinner) {
      resolvedWinner.placement = 1;
      resolvedWinner.score += winner ? 0 : 250;
      resolvedWinner.survivalTimeMs = Math.max(
        resolvedWinner.survivalTimeMs,
        now - this.runningStartedAt
      );
      if (!resolvedWinner.isAlive) {
        resolvedWinner.health = Math.max(1, resolvedWinner.health);
        resolvedWinner.isAlive = true;
        resolvedWinner.isSpectator = false;
        resolvedWinner.deaths = Math.max(0, resolvedWinner.deaths - 1);
      }
    }

    if (resolvedWinningPairId) {
      for (const teammate of this.state.players.values()) {
        if (teammate.pairId === resolvedWinningPairId) teammate.placement = 1;
      }
    }

    for (const survivor of rankedSurvivors) {
      if (
        survivor.sessionId === resolvedWinner?.sessionId ||
        (resolvedWinningPairId !== undefined && survivor.pairId === resolvedWinningPairId)
      ) continue;
      survivor.placement = survivor.placement || placement++;
      survivor.isAlive = false;
      survivor.isSpectator = true;
      survivor.deaths += 1;
      this.clearPlayerRuntimeState(survivor.sessionId, survivor);
    }

    this.inputIntents.clear();
    this.fireIntents.clear();
    this.abilityIntents.clear();
    for (const runtime of this.agentRuntimes.values()) {
      this.neutralizeAgent(runtime.principal.seatId, "inactive", false, now);
    }
    this.state.projectiles.splice(0, this.state.projectiles.length);
    for (const owner of this.state.owners.values()) owner.isReady = false;
    for (const player of this.state.players.values()) {
      if (player.isConnected) player.isReady = false;
      this.recordAgentOutcome(player, "placement", {
        placement: player.placement,
        teamPlacement: player.teamPlacement,
        kills: player.kills,
        teamKills: player.teamKills
      });
    }
    this.state.match.alivePlayers = alivePlayerCount(this.state);
    this.state.match.matchEndsAt = now;
    this.transitionTo("finished", now);
  }

  private resolveWinnerCandidate(pairId?: string): PlayerSchema | undefined {
    return Array.from(this.state.players.values())
      .filter((player) => (
        (pairId === undefined || player.pairId === pairId) &&
        (this.policy.mode !== "agent_cup" || player.controlKind === "agent")
      ))
      .sort((left, right) => this.compareWinnerCandidates(left, right))[0];
  }

  private syncWingmanPairKills(pairId: string): void {
    if (this.policy.mode !== "wingman" || !pairId) return;
    let teamKills = 0;
    for (const player of this.state.players.values()) {
      if (player.pairId === pairId) teamKills += player.kills;
    }
    for (const player of this.state.players.values()) {
      if (player.pairId === pairId) player.teamKills = teamKills;
    }
  }

  private finalizeWingmanResults(winningPairId?: string): string | undefined {
    const pairs = new Map<
      string,
      { members: PlayerSchema[]; survivalTimeMs: number; kills: number; damageDealt: number }
    >();
    for (const player of this.state.players.values()) {
      if (!player.pairId) continue;
      const pair = pairs.get(player.pairId) ?? {
        members: [],
        survivalTimeMs: 0,
        kills: 0,
        damageDealt: 0
      };
      pair.members.push(player);
      pair.survivalTimeMs = Math.max(pair.survivalTimeMs, player.survivalTimeMs);
      pair.kills += player.kills;
      pair.damageDealt += player.damageDealt;
      pairs.set(player.pairId, pair);
    }
    const rankedPairs = Array.from(pairs.entries()).sort(([leftId, left], [rightId, right]) => {
      if (leftId === winningPairId) return -1;
      if (rightId === winningPairId) return 1;
      if (left.survivalTimeMs !== right.survivalTimeMs) {
        return right.survivalTimeMs - left.survivalTimeMs;
      }
      if (left.kills !== right.kills) return right.kills - left.kills;
      if (left.damageDealt !== right.damageDealt) return right.damageDealt - left.damageDealt;
      return leftId.localeCompare(rightId);
    });
    rankedPairs.forEach(([, pair], index) => {
      for (const member of pair.members) {
        member.teamPlacement = index + 1;
        member.teamKills = pair.kills;
      }
    });
    return winningPairId ?? rankedPairs[0]?.[0];
  }

  private compareWinnerCandidates(left: PlayerSchema, right: PlayerSchema): number {
    const leftPlacement = left.placement > 0 ? left.placement : Number.MAX_SAFE_INTEGER;
    const rightPlacement = right.placement > 0 ? right.placement : Number.MAX_SAFE_INTEGER;
    if (left.isAlive !== right.isAlive) return Number(right.isAlive) - Number(left.isAlive);
    if (leftPlacement !== rightPlacement) return leftPlacement - rightPlacement;
    if (left.survivalTimeMs !== right.survivalTimeMs) {
      return right.survivalTimeMs - left.survivalTimeMs;
    }
    if (left.kills !== right.kills) return right.kills - left.kills;
    if (left.damageDealt !== right.damageDealt) return right.damageDealt - left.damageDealt;
    if (left.score !== right.score) return right.score - left.score;
    return left.sessionId.localeCompare(right.sessionId);
  }

  private resolveRematchVotes(now: number): void {
    if (this.state.matchState !== "finished") return;

    const connectedOwners = Array.from(this.state.owners.values()).filter((owner) => owner.isConnected);
    if (connectedOwners.length === 0) return;
    if (connectedOwners.some((owner) => !this.rematchVotes.get(owner.ownerId)?.ready)) return;

    this.resetForRematch(now);
  }

  private resetForRematch(now: number): void {
    this.runningStartedAt = 0;
    this.dangerStartsAt = 0;
    this.finalZoneStartsAt = 0;
    this.finishedAt = 0;
    this.rematchVotes.clear();
    this.inputIntents.clear();
    this.fireIntents.clear();
    this.abilityIntents.clear();
    this.lastProcessedFireSequences.clear();
    this.lastProcessedAbilitySequences.clear();
    this.speedEffects.clear();
    this.rapidFireEffects.clear();
    this.shieldEffects.clear();
    this.smokeEffects.clear();
    this.zoneDamageRemainders.clear();
    this.state.projectiles.splice(0, this.state.projectiles.length);
    this.state.match.round += 1;
    this.state.seed = `${this.initialArenaSeed}:round:${this.state.match.round}`;
    this.arena = generateArenaConfig({
      seed: this.state.seed,
      playerCount: this.policy.combatantCap
    });
    this.syncArenaConfig();
    this.state.match.matchId = `${this.state.roomCode}-r${this.state.match.round}-${now.toString(36)}`;
    this.state.match.stateStartedAt = now;
    this.state.match.countdownEndsAt = 0;
    this.state.match.matchEndsAt = 0;

    for (const ownerId of this.permanentlyLeftOwners) {
      const owner = this.state.owners.get(ownerId);
      if (!owner) continue;
      this.cancelOwnerAgentBeforeMatch(owner, now);
      this.state.players.delete(owner.humanSessionId);
      this.state.owners.delete(ownerId);
      this.ownerSourceKeys.delete(ownerId);
    }
    this.permanentlyLeftOwners.clear();

    for (const [sessionId, player] of this.state.players) {
      if (player.controlKind !== "agent" || this.agentRuntimes.has(sessionId)) continue;
      this.state.players.delete(sessionId);
      const owner = this.state.owners.get(player.ownerId);
      if (owner && (!owner.agentSeatId || owner.agentSeatId === sessionId)) {
        this.clearOwnerAgentState(owner);
      }
    }
    for (const runtime of this.agentRuntimes.values()) {
      runtime.lastObservationAtMs = 0;
      runtime.lastActionAtMs = 0;
      runtime.observationRoundId = "";
      runtime.visibleTargets.clear();
      runtime.lastReflexAtMs = 0;
      this.clearTacticalIntent(runtime, "match_inactive");
      runtime.lease = undefined;
      this.armTacticalOpening(runtime, now);
    }

    let spawnIndex = 0;
    for (const owner of this.state.owners.values()) {
      owner.isReady = owner.isConnected && this.ownerPairingComplete(owner);
    }
    for (const player of this.state.players.values()) {
      this.clearPlayerRuntimeState(player.sessionId, player);
      player.teamPlacement = 0;
      player.teamKills = 0;
      if (!player.isConnected) continue;

      if (this.policy.mode === "agent_cup" && player.controlKind === "human") {
        player.isAlive = false;
        player.isReady = false;
        player.isSpectator = true;
        continue;
      }

      applyTankConfig(player, player.archetypeId);
      this.assignSpawnPosition(player, spawnIndex);
      player.shield = 0;
      player.ammo = 0;
      player.abilityCharge = MAX_ABILITY_CHARGE;
      player.fireCooldownMs = 0;
      player.abilityCooldownMs = 0;
      player.score = 0;
      player.kills = 0;
      player.deaths = 0;
      player.damageDealt = 0;
      player.damageTaken = 0;
      player.placement = 0;
      player.survivalTimeMs = 0;
      player.respawnAt = 0;
      player.isAlive = true;
      player.isReady = true;
      player.isSpectator = false;
      spawnIndex += 1;
    }

    this.initializePickups(now);
    this.ensureHost();
    this.state.match.alivePlayers = alivePlayerCount(this.state);
    this.transitionTo("waiting", now);
    this.syncWaitingAdmissionLock();
    if (this.hasEnoughReadyPlayers()) {
      this.beginCountdown();
      return;
    }
    this.ensureAutoStartTimer();
  }

  private clearPlayerRuntimeState(
    sessionId: string,
    player?: PlayerSchema
  ): void {
    this.clearPlayerTransientInput(sessionId, player);
    this.lastProcessedFireSequences.delete(sessionId);
    this.lastProcessedAbilitySequences.delete(sessionId);
    this.speedEffects.delete(sessionId);
    this.rapidFireEffects.delete(sessionId);
    this.shieldEffects.delete(sessionId);
    this.smokeEffects.delete(sessionId);
    this.zoneDamageRemainders.delete(sessionId);

    if (player) {
      player.fireCooldownMs = 0;
      player.abilityCooldownMs = 0;
      player.speedMultiplier = 1;
      this.restoreBaseWeaponIfNeeded(player, true);
    }
  }

  private clearPlayerTransientInput(
    sessionId: string,
    player?: PlayerSchema
  ): void {
    this.inputIntents.delete(sessionId);
    this.fireIntents.delete(sessionId);
    this.abilityIntents.delete(sessionId);

    if (player) {
      player.velocityX = 0;
      player.velocityY = 0;
    }
  }

  private restoreBaseWeaponIfNeeded(player: PlayerSchema, force = false): void {
    if (!force && player.weaponType !== "explosive") return;
    if (!force && player.ammo >= WEAPON_CONFIG.explosive.ammoCost) return;

    player.weaponType = TANK_ARCHETYPE_CONFIG[player.archetypeId].primaryWeapon;
    if (!this.isRapidFireActive(player, Date.now())) {
      player.ammo = 0;
    }
  }

  private enableExplosiveWeapon(player: PlayerSchema, ammo: number): void {
    this.rapidFireEffects.delete(player.sessionId);
    player.weaponType = "explosive";
    player.ammo = ammo;
  }

  private applyMultiplierEffect(
    store: Map<string, TimedMultiplierEffect>,
    sessionId: string,
    multiplier: number,
    expiresAt: number
  ): void {
    const current = store.get(sessionId);
    store.set(sessionId, {
      expiresAt: Math.max(current?.expiresAt ?? 0, expiresAt),
      multiplier:
        current === undefined
          ? multiplier
          : store === this.rapidFireEffects
            ? Math.min(current.multiplier, multiplier)
            : Math.max(current.multiplier, multiplier)
    });
  }

  private applyReductionEffect(
    player: PlayerSchema,
    reduction: number,
    expiresAt: number,
    radius: number,
    activatedAt: number
  ): void {
    const current = this.smokeEffects.get(player.sessionId);
    this.smokeEffects.set(player.sessionId, {
      expiresAt: Math.max(current?.expiresAt ?? 0, expiresAt),
      reduction: Math.max(current?.reduction ?? 0, reduction),
      x: player.x,
      y: player.y,
      radius
    });
    player.smokeActivatedAt = activatedAt;
    player.smokeEndsAt = Math.max(player.smokeEndsAt, expiresAt);
    player.smokeX = player.x;
    player.smokeY = player.y;
    this.neutralizeInvalidAgentTargets(activatedAt);
  }

  private recordAbilityActivation(
    player: PlayerSchema,
    abilityType: PlayerSchema["abilityType"],
    now: number,
    durationMs: number
  ): void {
    player.lastAbilityType = abilityType;
    player.lastAbilityAt = now;
    player.lastAbilityEndsAt = now + durationMs;
    player.lastAbilityX = player.x;
    player.lastAbilityY = player.y;
    this.recordAgentOutcome(player, "ability", { abilityType, durationMs });
  }

  private grantShield(player: PlayerSchema, amount: number, durationMs: number, now: number): void {
    player.shield += amount;
    if (durationMs <= 0) return;

    const current = this.shieldEffects.get(player.sessionId);
    this.shieldEffects.set(player.sessionId, {
      expiresAt: Math.max(current?.expiresAt ?? 0, now + durationMs),
      remaining: (current?.remaining ?? 0) + amount
    });
  }

  private consumeShieldEffect(sessionId: string, amount: number): void {
    const effect = this.shieldEffects.get(sessionId);
    if (!effect) return;
    effect.remaining = Math.max(0, effect.remaining - amount);
  }

  private resolveArenaMovement(
    arena: ArenaConfig,
    currentX: number,
    currentY: number,
    desiredX: number,
    desiredY: number,
    radius: number
  ): ArenaPoint {
    const resolved = resolveTankCollisionMovement({
      current: { x: currentX, y: currentY },
      desired: { x: desiredX, y: desiredY },
      radius,
      bounds: getArenaBounds(arena),
      obstacles: arena.collisionRects
    });
    return isWallCollision(arena, resolved.x, resolved.y, radius)
      ? clampToArena(arena, currentX, currentY, radius)
      : resolved;
  }

  private playerCollisionRadius(): number {
    return TANK_COLLISION_RADIUS;
  }

  private validAgentMovementHorizon(
    player: PlayerSchema,
    point: { x: number; z: number },
    isAllowed: (state: { x: number; y: number }) => boolean = () => true
  ): boolean {
    const arena = this.arena;
    if (!arena) return false;
    const distance = Math.hypot(point.x - player.x, point.z - player.y);
    if (distance <= 0) return true;
    const directionX = (point.x - player.x) / distance;
    const directionY = (point.z - player.y) / distance;
    const magnitude = tacticalSteeringMagnitude(player.rotation, directionX, directionY);
    const input = { moveX: directionX * magnitude, moveY: directionY * magnitude };
    const tankConfig = TANK_ARCHETYPE_CONFIG[player.archetypeId];
    const deltaSeconds = 1 / Math.max(1, this.config?.roomTickRate ?? 30);
    let state = {
      x: player.x,
      y: player.y,
      rotation: player.rotation,
      velocityX: player.velocityX,
      velocityY: player.velocityY
    };
    const tickCount = Math.ceil(MAX_SIMULATION_DELTA_MS / 1_000 / deltaSeconds);
    for (let tick = 0; tick < tickCount; tick += 1) {
      const movement = integrateTankMovement({
        state,
        input,
        deltaSeconds,
        maxSpeed: tankConfig.speed,
        handling: tankConfig.handling,
        speedMultiplier: this.speedMultiplierFor(player)
      });
      const resolved = this.resolveArenaMovement(
        arena,
        state.x,
        state.y,
        movement.x,
        movement.y,
        this.playerCollisionRadius()
      );
      if (
        Math.hypot(resolved.x - movement.x, resolved.y - movement.y) > 0.001 ||
        !isAllowed(movement)
      ) return false;
      state = movement;
    }
    return true;
  }

  private firstTacticalMovementBlocker(
    player: PlayerSchema,
    input: { moveX: number; moveY: number },
    now: number
  ): PlayerSchema | undefined {
    if (!this.arena || Math.hypot(input.moveX, input.moveY) <= 0.04) return undefined;
    const combatants = [...this.state.players.values()]
      .filter((candidate) =>
        candidate.sessionId !== player.sessionId &&
        candidate.isAlive &&
        !candidate.isSpectator &&
        (this.areFriendly(player, candidate) || !isPlayerConcealedBySmoke(candidate, now))
      )
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    if (combatants.length === 0) return undefined;

    const clearance = TANK_COLLISION_RADIUS * 2 + 12;
    const previousDistances = new Map(
      combatants.map((candidate) => [
        candidate.sessionId,
        Math.hypot(player.x - candidate.x, player.y - candidate.y)
      ])
    );
    const tankConfig = TANK_ARCHETYPE_CONFIG[player.archetypeId];
    const deltaSeconds = 1 / Math.max(1, this.config?.roomTickRate ?? 30);
    const tickCount = Math.ceil(MAX_SIMULATION_DELTA_MS / 1_000 / deltaSeconds);
    let state = {
      x: player.x,
      y: player.y,
      rotation: player.rotation,
      velocityX: player.velocityX,
      velocityY: player.velocityY
    };
    for (let tick = 0; tick < tickCount; tick += 1) {
      const movement = integrateTankMovement({
        state,
        input,
        deltaSeconds,
        maxSpeed: tankConfig.speed,
        handling: tankConfig.handling,
        speedMultiplier: this.speedMultiplierFor(player)
      });
      const resolved = this.resolveArenaMovement(
        this.arena,
        state.x,
        state.y,
        movement.x,
        movement.y,
        this.playerCollisionRadius()
      );
      let blocker: PlayerSchema | undefined;
      let blockerDistance = Infinity;
      for (const candidate of combatants) {
        const previousDistance = previousDistances.get(candidate.sessionId) ?? Infinity;
        const nextDistance = Math.hypot(
          resolved.x - candidate.x,
          resolved.y - candidate.y
        );
        const blocks = previousDistance < clearance - 0.001
          ? nextDistance < previousDistance - 0.001
          : nextDistance < clearance - 0.001;
        previousDistances.set(candidate.sessionId, nextDistance);
        if (
          blocks &&
          (nextDistance < blockerDistance - 0.001 ||
            (Math.abs(nextDistance - blockerDistance) <= 0.001 &&
              candidate.sessionId.localeCompare(blocker?.sessionId ?? "") < 0))
        ) {
          blocker = candidate;
          blockerDistance = nextDistance;
        }
      }
      if (blocker) return blocker;
      state = { ...movement, x: resolved.x, y: resolved.y };
    }
    return undefined;
  }

  private zonePhaseStartAt(
    matchState: MatchState,
    runningStartedAt: number,
    fallbackOffsetMs: number
  ): number {
    const phase = this.getZonePhase(matchState);
    const offset = phase?.startsAt;
    return runningStartedAt + (isFiniteNumber(offset) && offset >= 0 ? offset : fallbackOffsetMs);
  }

  private zoneFinishAt(runningStartedAt: number, fallbackOffsetMs: number): number {
    const finalPhase = this.getZonePhase("final_zone");
    const offset = finalPhase?.closesAt;
    return runningStartedAt + (isFiniteNumber(offset) && offset > 0 ? offset : fallbackOffsetMs);
  }

  private applyZonePhase(matchState: MatchState, at: number): void {
    const phase = this.getZonePhase(matchState) ?? this.getZonePhase("running");
    const bounds = this.arena ? getArenaBounds(this.arena) : undefined;
    const centerX = bounds ? (bounds.minX + bounds.maxX) / 2 : 0;
    const centerY = bounds ? (bounds.minY + bounds.maxY) / 2 : 0;
    const arenaRadius = bounds
      ? Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2
      : DEFAULT_ARENA_SIZE / 2;
    const runningStartedAt = this.runningStartedAt || at;
    const absoluteFromRunning = (value: number | undefined, fallback: number): number =>
      isFiniteNumber(value) && value >= 0 ? runningStartedAt + value : fallback;

    this.state.zone.x = phase?.x ?? centerX;
    this.state.zone.y = phase?.y ?? centerY;
    this.state.zone.radius = positiveNumberOr(phase?.radius, arenaRadius);
    this.state.zone.targetX = phase?.targetX ?? this.state.zone.x;
    this.state.zone.targetY = phase?.targetY ?? this.state.zone.y;
    this.state.zone.targetRadius = positiveNumberOr(phase?.targetRadius, this.state.zone.radius);
    this.state.zone.damagePerSecond = phase?.damagePerSecond ?? 0;
    this.state.zonePhase.index = phase?.index ?? 0;
    this.state.zonePhase.startsAt =
      matchState === "waiting" || matchState === "countdown"
        ? at
        : absoluteFromRunning(phase?.startsAt, at);
    this.state.zonePhase.warningAt =
      matchState === "waiting" || matchState === "countdown"
        ? 0
        : absoluteFromRunning(phase?.warningAt, this.state.zonePhase.startsAt);
    this.state.zonePhase.closesAt =
      matchState === "waiting" || matchState === "countdown"
        ? 0
        : absoluteFromRunning(phase?.closesAt, this.state.zonePhase.startsAt);
  }

  private getZonePhase(matchState: MatchState): ArenaConfig["zonePhases"][number] | undefined {
    const phases = this.arena?.zonePhases;
    if (!phases?.length) return undefined;
    const matched = phases.find((phase) => phase.matchState === matchState);
    if (matched) return matched;

    const indexByState: Partial<Record<MatchState, number>> = {
      waiting: 0,
      countdown: 0,
      running: 0,
      danger: 1,
      final_zone: 2,
      finished: phases.length - 1
    };
    const index = indexByState[matchState] ?? 0;
    return phases[Math.min(index, phases.length - 1)];
  }

  private ensureAutoStartTimer(): void {
    if (!this.config || this.state.matchState !== "waiting" || !this.hasMinimumPlayers()) {
      this.autoStartTimer?.clear();
      this.autoStartTimer = undefined;
      return;
    }
    if (this.autoStartTimer?.active) return;

    const delay = Math.max(0, this.config.roomAutoStartSeconds) * 1_000;
    this.autoStartTimer = this.clock.setTimeout(() => {
      if (this.state.matchState === "waiting" && this.hasMinimumPlayers()) {
        this.beginCountdown();
      }
    }, delay);
  }

  private parseAgentPairingCreate(payload: unknown): AgentPairingCreatePayload | undefined {
    if (payload === undefined) return {};
    if (
      !isRecord(payload) ||
      Object.keys(payload).some((key) =>
        key !== "agentLabel" && key !== "controlMode" && key !== "openingTactic"
      )
    ) return undefined;
    if (payload.agentLabel !== undefined && (
      typeof payload.agentLabel !== "string" || payload.agentLabel.length > 32
    )) return undefined;
    if (
      payload.controlMode !== undefined &&
      payload.controlMode !== "macro_v1" &&
      payload.controlMode !== "tactical_reflex_v1"
    ) return undefined;
    const controlMode = payload.controlMode ?? "macro_v1";
    const openingTactic = controlMode === "tactical_reflex_v1"
      ? this.parseAgentOpeningTactic(payload.openingTactic)
      : undefined;
    if (
      (controlMode === "tactical_reflex_v1" && !openingTactic) ||
      (controlMode === "macro_v1" && payload.openingTactic !== undefined)
    ) return undefined;
    return {
      ...(payload.agentLabel === undefined ? {} : { agentLabel: payload.agentLabel }),
      ...(payload.controlMode === undefined ? {} : { controlMode: payload.controlMode }),
      ...(openingTactic ? { openingTactic } : {})
    };
  }

  private parseAgentOpeningTactic(payload: unknown): AgentTacticalIntentV1 | undefined {
    const parsed = parseAgentTacticalIntentV1(payload);
    if (
      !parsed.ok ||
      parsed.value.intentSeq !== 1 ||
      parsed.value.basedOnObservationSeq !== null ||
      parsed.value.objective.type === "engage_target" ||
      parsed.value.objective.type === "collect_pickup" ||
      (parsed.value.objective.type === "move_to" &&
        !this.agentPointNavigable(parsed.value.objective.position))
    ) return undefined;
    return parsed.value;
  }

  private parseAgentPairingCancel(payload: unknown): AgentPairingCancelPayload | undefined {
    if (
      !isRecord(payload) ||
      Object.keys(payload).some((key) => key !== "requestId") ||
      (payload.requestId !== undefined && (
        typeof payload.requestId !== "string" ||
        payload.requestId.length < 1 ||
        payload.requestId.length > 64
      ))
    ) return undefined;
    return payload.requestId === undefined ? {} : { requestId: payload.requestId };
  }

  private parseAgentControl(payload: unknown): AgentControlPayload | undefined {
    if (
      !isRecord(payload) ||
      Object.keys(payload).some((key) => key !== "action") ||
      (payload.action !== "pause" && payload.action !== "resume" && payload.action !== "disconnect")
    ) return undefined;
    return { action: payload.action };
  }

  private agentErrorCode(error: unknown): AgentActionResultV1["code"] {
    if (!(error instanceof AgentBrokerError)) return "agent_revoked";
    switch (error.code) {
      case "rate_limited":
        return "rate_limited";
      case "match_not_active":
        return "match_not_active";
      case "agent_paused":
      case "broker_paused":
        return "agent_paused";
      case "owner_unavailable":
        return "owner_unavailable";
      case "pending_exists":
      case "seat_reserved":
      case "control_exists":
        return "pending_exists";
      case "grant_expired":
        return "grant_expired";
      case "grant_consumed":
        return "grant_consumed";
      case "principal_mismatch":
        return "principal_mismatch";
      default:
        return "agent_revoked";
    }
  }

  private agentArenaDescriptor(): AgentArenaDescriptorV1 {
    const arena = this.arena;
    if (!arena) throw new Error("arena is unavailable");
    const bounds = getArenaBounds(arena);
    return {
      bounds: {
        minX: bounds.minX,
        minZ: bounds.minY,
        maxX: bounds.maxX,
        maxZ: bounds.maxY
      },
      walls: arena.collisionRects.map((wall) => ({
        id: wall.id,
        x: wall.x,
        z: wall.y,
        width: wall.width,
        depth: wall.height
      }))
    };
  }

  private requireAgentRuntime(
    session: AgentBrokerSession,
    scope: AgentControlPrincipal["scopes"][number],
    allowPaused = false
  ): AgentRuntime {
    const principal = session.principal;
    const runtime = this.agentRuntimes.get(principal.seatId);
    if (
      !runtime ||
      principal.roomId !== this.roomId ||
      runtime.principal.controlId !== principal.controlId ||
      runtime.principal.ownerId !== principal.ownerId ||
      runtime.principal.roomMode !== this.policy.mode ||
      runtime.principal.controlMode !== principal.controlMode ||
      !principal.scopes.includes(scope)
    ) {
      throw new AgentBrokerError("principal_mismatch");
    }
    this.syncAgentSession(session);
    if (!allowPaused && runtime.paused) throw new AgentBrokerError("broker_paused");
    return runtime;
  }

  private syncAgentSession(session: AgentBrokerSession): void {
    const runtime = this.agentRuntimes.get(session.principal.seatId);
    if (!runtime || runtime.principal.controlId !== session.principal.controlId) {
      throw new AgentBrokerError("principal_mismatch");
    }
    if (session.revision >= runtime.brokerRevision) {
      runtime.paused = session.paused;
      runtime.brokerRevision = session.revision;
    }
    runtime.idleDeadlineMs = Math.max(runtime.idleDeadlineMs, session.idleDeadlineMs);
    const owner = this.state.owners.get(runtime.principal.ownerId);
    if (owner) {
      owner.agentSeatState = !owner.isConnected
        ? "reconnecting"
        : runtime.paused
          ? "paused"
          : "connected";
    }
  }

  private nextMatchChangeAt(): number {
    switch (this.state.matchState) {
      case "countdown":
        return this.state.match.countdownEndsAt;
      case "running":
        return this.dangerStartsAt;
      case "danger":
        return this.finalZoneStartsAt;
      case "final_zone":
        return this.finishedAt;
      default:
        return this.state.serverTime;
    }
  }

  private agentTacticalSurvivalZone(player: PlayerSchema, now: number): {
    x: number;
    z: number;
    radius: number;
    safeRadius: number;
  } {
    const targetRadius = Math.max(0, this.state.zone.targetRadius);
    const targetSafeRadius = Math.max(0, targetRadius - AGENT_TACTICAL_ZONE_SAFETY_MARGIN);
    const warningActive = now >= this.state.zonePhase.warningAt;
    const damagingPhase = this.state.zone.damagePerSecond > 0;
    if (warningActive || damagingPhase) {
      return {
        x: this.state.zone.targetX,
        z: this.state.zone.targetY,
        radius: targetRadius,
        safeRadius: warningActive && damagingPhase
          ? Math.min(targetSafeRadius, AGENT_TACTICAL_ZONE_STAGING_RADIUS)
          : targetSafeRadius
      };
    }
    const radius = Math.max(0, this.state.zone.radius);
    return {
      x: this.state.zone.x,
      z: this.state.zone.y,
      radius,
      safeRadius: Math.max(0, radius - AGENT_TACTICAL_ZONE_SAFETY_MARGIN)
    };
  }

  private validAgentLocalRoute(player: PlayerSchema, point: { x: number; z: number }): boolean {
    const arena = this.arena;
    return Boolean(
      arena &&
      this.agentPointNavigable(point) &&
      !tankRouteSegmentBlocked(arena, player.x, player.y, point.x, point.z, this.playerCollisionRadius())
    );
  }

  private agentZoneRecoveryStep(
    player: PlayerSchema,
    zoneCenter: { x: number; z: number }
  ): { x: number; z: number } | undefined {
    const zoneDistance = Math.hypot(player.x - zoneCenter.x, player.y - zoneCenter.z);
    if (zoneDistance <= 0) return undefined;
    const zoneInwardAngle = Math.atan2(zoneCenter.z - player.y, zoneCenter.x - player.x);
    for (const distance of [70, 40, 20, 10, 5, 2]) {
      for (const offset of [
        0,
        Math.PI / 8,
        -Math.PI / 8,
        Math.PI / 4,
        -Math.PI / 4,
        Math.PI * 3 / 8,
        -Math.PI * 3 / 8,
        Math.PI / 2,
        -Math.PI / 2
      ]) {
        const step = Math.min(distance, zoneDistance);
        const point = {
          x: player.x + Math.cos(zoneInwardAngle + offset) * step,
          z: player.y + Math.sin(zoneInwardAngle + offset) * step
        };
        if (
          Math.hypot(point.x - zoneCenter.x, point.z - zoneCenter.z) >= zoneDistance - 0.001 ||
          !this.validAgentLocalRoute(player, point)
        ) continue;
        let finalZoneDistance = zoneDistance;
        const horizonValid = this.validAgentMovementHorizon(player, point, (state) => {
          finalZoneDistance = Math.hypot(state.x - zoneCenter.x, state.y - zoneCenter.z);
          return finalZoneDistance <= zoneDistance + 0.001;
        });
        if (horizonValid && finalZoneDistance < zoneDistance - 0.001) return point;
      }
    }
    return undefined;
  }

  private validAgentRoute(player: PlayerSchema, waypoints: AgentMacroActionV1["waypoints"]): boolean {
    return this.validAgentRouteFrom(player.x, player.y, waypoints);
  }

  private validAgentRouteFrom(
    startX: number,
    startY: number,
    waypoints: AgentMacroActionV1["waypoints"]
  ): boolean {
    const arena = this.arena;
    if (!arena || waypoints.length > AGENT_MAX_WAYPOINTS) return false;
    const bounds = getArenaBounds(arena);
    const radius = this.playerCollisionRadius();
    let fromX = startX;
    let fromY = startY;
    for (const waypoint of waypoints) {
      if (
        waypoint.x < bounds.minX + radius ||
        waypoint.x > bounds.maxX - radius ||
        waypoint.z < bounds.minY + radius ||
        waypoint.z > bounds.maxY - radius ||
        isWallCollision(arena, waypoint.x, waypoint.z, radius) ||
        projectileWallHit(arena, fromX, fromY, waypoint.x, waypoint.z, radius).hit
      ) return false;
      fromX = waypoint.x;
      fromY = waypoint.z;
    }
    return true;
  }

  private tacticalRouteStep(
    player: PlayerSchema,
    destination: { x: number; z: number },
    allowDetour = true,
    routeZone?: { x: number; z: number; radius: number },
    avoidanceCircle?: { x: number; z: number; radius: number }
  ): { complete: boolean; terminal: boolean; waypoints: Array<{ x: number; z: number }> } | undefined {
    const arena = this.arena;
    if (!arena) return undefined;
    const radius = this.playerCollisionRadius();
    const insideRouteZone = (point: { x: number; z: number }): boolean =>
      !routeZone || Math.hypot(point.x - routeZone.x, point.z - routeZone.z) <= routeZone.radius + 0.001;
    const clearsAvoidancePoint = (point: { x: number; z: number }): boolean =>
      !avoidanceCircle || Math.hypot(
        point.x - avoidanceCircle.x,
        point.z - avoidanceCircle.z
      ) >= avoidanceCircle.radius - 0.001;
    const clearsAvoidanceSegment = (
      fromX: number,
      fromZ: number,
      toX: number,
      toZ: number
    ): boolean => {
      if (!avoidanceCircle) return true;
      const avoidanceRadius = Math.max(0, avoidanceCircle.radius - 0.001);
      const fromOffsetX = fromX - avoidanceCircle.x;
      const fromOffsetZ = fromZ - avoidanceCircle.z;
      const fromDistance = Math.hypot(fromOffsetX, fromOffsetZ);
      if (fromDistance < avoidanceRadius) {
        const segmentX = toX - fromX;
        const segmentZ = toZ - fromZ;
        const toDistance = Math.hypot(
          toX - avoidanceCircle.x,
          toZ - avoidanceCircle.z
        );
        return toDistance > fromDistance + 0.001 &&
          fromOffsetX * segmentX + fromOffsetZ * segmentZ >= -0.001;
      }
      return !segmentCircleFirstEntry(
        avoidanceCircle.x,
        avoidanceCircle.z,
        fromX,
        fromZ,
        toX,
        toZ,
        avoidanceRadius
      );
    };
    const clearsAvoidanceRoute = (
      fromX: number,
      fromZ: number,
      waypoints: Array<{ x: number; z: number }>
    ): boolean => {
      let segmentX = fromX;
      let segmentZ = fromZ;
      for (const waypoint of waypoints) {
        if (
          !clearsAvoidancePoint(waypoint) ||
          !clearsAvoidanceSegment(segmentX, segmentZ, waypoint.x, waypoint.z)
        ) return false;
        segmentX = waypoint.x;
        segmentZ = waypoint.z;
      }
      return true;
    };
    const firstWaypointHorizonAllowed = (point: { x: number; z: number }): boolean => {
      if (!avoidanceCircle) return true;
      const avoidanceRadius = Math.max(0, avoidanceCircle.radius - 0.001);
      let previousDistance = Math.hypot(
        player.x - avoidanceCircle.x,
        player.y - avoidanceCircle.z
      );
      const startsInsideAvoidance = previousDistance < avoidanceRadius;
      return this.validAgentMovementHorizon(player, point, (state) => {
        const nextDistance = Math.hypot(
          state.x - avoidanceCircle.x,
          state.y - avoidanceCircle.z
        );
        const allowed = startsInsideAvoidance
          ? nextDistance >= previousDistance - 0.001
          : nextDistance >= avoidanceRadius;
        previousDistance = nextDistance;
        return allowed;
      });
    };
    const nearestClearCell = (point: { x: number; z: number }, constrainToRouteZone: boolean) => {
      let nearest: ArenaConfig["floorCells"][number] | undefined;
      let nearestDistance = Infinity;
      for (const cell of arena.floorCells) {
        if (
          isWallCollision(arena, cell.x, cell.y, radius) ||
          !clearsAvoidancePoint({ x: cell.x, z: cell.y }) ||
          (constrainToRouteZone && !insideRouteZone({ x: cell.x, z: cell.y }))
        ) continue;
        const distance = (cell.x - point.x) ** 2 + (cell.y - point.z) ** 2;
        if (distance < nearestDistance) {
          nearest = cell;
          nearestDistance = distance;
        }
      }
      return nearest;
    };
    const start = nearestClearCell({ x: player.x, z: player.y }, false);
    const goal = nearestClearCell(destination, true);
    if (!start || !goal) return undefined;
    const resolvedDestination = (
      isWallCollision(arena, destination.x, destination.z, radius) ||
      !clearsAvoidancePoint(destination)
    )
      ? { x: goal.x, z: goal.y }
      : destination;
    if (!insideRouteZone(resolvedDestination)) return undefined;
    const distance = Math.hypot(
      resolvedDestination.x - player.x,
      resolvedDestination.z - player.y
    );
    if (distance <= AGENT_WAYPOINT_REACHED_DISTANCE) {
      return { complete: true, terminal: true, waypoints: [] };
    }
    const directDistance = Math.min(distance, AGENT_TACTICAL_REFLEX_STEP_DISTANCE);
    const direct = {
      x: player.x + (resolvedDestination.x - player.x) / distance * directDistance,
      z: player.y + (resolvedDestination.z - player.y) / distance * directDistance
    };
    if (
      insideRouteZone(direct) &&
      this.validAgentRoute(player, [direct]) &&
      clearsAvoidanceRoute(player.x, player.y, [direct]) &&
      firstWaypointHorizonAllowed(direct)
    ) {
      return { complete: false, terminal: directDistance === distance, waypoints: [direct] };
    }
    if (!allowDetour) return undefined;

    const { columns, rows, layout, cellWidth, cellHeight } = arena.grid;
    const startKey = start.row * columns + start.column;
    const goalKey = goal.row * columns + goal.column;
    if (startKey === goalKey) return undefined;
    const parents = new Int32Array(columns * rows);
    parents.fill(-2);
    parents[startKey] = -1;
    const queue = [startKey];
    for (let head = 0; head < queue.length && parents[goalKey] === -2; head += 1) {
      const key = queue[head]!;
      const column = key % columns;
      const row = Math.floor(key / columns);
      for (const [nextColumn, nextRow] of [
        [column + 1, row],
        [column, row + 1],
        [column - 1, row],
        [column, row - 1]
      ] as const) {
        const currentPoint = {
          x: (column + 0.5) * cellWidth,
          z: (row + 0.5) * cellHeight
        };
        const nextPoint = {
          x: (nextColumn + 0.5) * cellWidth,
          z: (nextRow + 0.5) * cellHeight
        };
        if (
          nextColumn < 0 || nextColumn >= columns ||
          nextRow < 0 || nextRow >= rows ||
          layout[nextRow]?.charAt(nextColumn) !== "." ||
          !insideRouteZone(nextPoint) ||
          !clearsAvoidancePoint(nextPoint) ||
          !clearsAvoidanceSegment(currentPoint.x, currentPoint.z, nextPoint.x, nextPoint.z) ||
          (key === startKey && !firstWaypointHorizonAllowed(nextPoint))
        ) continue;
        const nextKey = nextRow * columns + nextColumn;
        if (parents[nextKey] !== -2) continue;
        parents[nextKey] = key;
        queue.push(nextKey);
      }
    }
    if (parents[goalKey] === -2) return undefined;
    const path = [goalKey];
    while (path.at(-1) !== startKey) {
      const parent = parents[path.at(-1)!]!;
      if (parent < 0 && parent !== startKey) return undefined;
      path.push(parent);
    }
    path.reverse();
    const buildWaypoints = (recenter: boolean) => {
      const routeKeys = path.slice(1, AGENT_MAX_WAYPOINTS + (recenter ? 0 : 1));
      const waypoints = [
        ...(recenter ? [{ x: start.x, z: start.y }] : []),
        ...routeKeys.map((key) => ({
          x: Math.round(((key % columns) + 0.5) * cellWidth * 1_000) / 1_000,
          z: Math.round((Math.floor(key / columns) + 0.5) * cellHeight * 1_000) / 1_000
        }))
      ];
      if (
        routeKeys.at(-1) === goalKey &&
        waypoints.length < AGENT_MAX_WAYPOINTS &&
        Math.hypot(
          waypoints.at(-1)!.x - resolvedDestination.x,
          waypoints.at(-1)!.z - resolvedDestination.z
        ) >= 0.001
      ) waypoints.push(resolvedDestination);
      return waypoints;
    };
    let waypoints = buildWaypoints(false);
    if (
      !this.validAgentRoute(player, waypoints) ||
      !clearsAvoidanceRoute(player.x, player.y, waypoints) ||
      (waypoints[0] && !firstWaypointHorizonAllowed(waypoints[0]))
    ) {
      waypoints = buildWaypoints(true);
      const recenter = waypoints[0];
      if (
        !recenter ||
        !insideRouteZone(recenter) ||
        tankRouteSegmentBlocked(
          arena,
          player.x,
          player.y,
          recenter.x,
          recenter.z,
          radius
        ) ||
        !this.validAgentRouteFrom(recenter.x, recenter.z, waypoints.slice(1)) ||
        !clearsAvoidanceRoute(player.x, player.y, waypoints) ||
        !firstWaypointHorizonAllowed(recenter)
      ) return undefined;
    }
    const last = waypoints.at(-1)!;
    return {
      complete: false,
      terminal: Math.hypot(last.x - resolvedDestination.x, last.z - resolvedDestination.z) < 0.001,
      waypoints
    };
  }

  private tacticalZoneRecoveryRoute(
    player: PlayerSchema,
    zoneCenter: { x: number; z: number },
    target?: { x: number; z: number; radius?: number },
    allowTargetBlockerClearance = false
  ): { complete: boolean; terminal: boolean; waypoints: Array<{ x: number; z: number }> } | undefined {
    const zoneDistance = Math.hypot(player.x - zoneCenter.x, player.y - zoneCenter.z);
    const avoidanceCircle = target ? {
      x: target.x,
      z: target.z,
      radius: target.radius ?? TANK_COLLISION_RADIUS * 2 + 12
    } : undefined;
    for (const allowance of [AGENT_WAYPOINT_REACHED_DISTANCE, 32, 64]) {
      const route = this.tacticalRouteStep(player, zoneCenter, true, {
        ...zoneCenter,
        radius: zoneDistance + allowance
      }, avoidanceCircle);
      if (route) return route;
    }
    const detour = this.tacticalRouteStep(player, zoneCenter, true, undefined, avoidanceCircle);
    if (detour) return detour;
    const recovery = this.agentZoneRecoveryStep(player, zoneCenter);
    if (recovery) return { complete: false, terminal: false, waypoints: [recovery] };
    return allowTargetBlockerClearance && target
      ? this.tacticalRouteStep(player, zoneCenter)
      : undefined;
  }

  private agentPointNavigable(point: { x: number; z: number }): boolean {
    const arena = this.arena;
    if (!arena) return false;
    const bounds = getArenaBounds(arena);
    const radius = this.playerCollisionRadius();
    return point.x >= bounds.minX + radius && point.x <= bounds.maxX - radius &&
      point.z >= bounds.minY + radius && point.z <= bounds.maxY - radius &&
      !isWallCollision(arena, point.x, point.z, radius);
  }

  private clearTacticalIntent(runtime: AgentRuntime, reason: AgentTacticalStopReason): void {
    runtime.tactical = undefined;
    runtime.tacticalStopReason = reason;
    runtime.tacticalTurnStartedAtMs = undefined;
    runtime.tacticalTurningToClear = false;
    runtime.tacticalRouteRepairAtMs = undefined;
    runtime.tacticalRouteRepairKey = undefined;
  }

  private armTacticalOpening(runtime: AgentRuntime, now: number): void {
    const opening = runtime.openingTacticalIntent;
    const owner = this.state.owners.get(runtime.principal.ownerId);
    if (
      runtime.principal.controlMode !== "tactical_reflex_v1" ||
      !opening ||
      runtime.paused ||
      !owner?.isConnected
    ) return;
    if (
      opening.objective.type === "move_to" &&
      !this.agentPointNavigable(opening.objective.position)
    ) {
      runtime.tacticalStopReason = "route_blocked";
      return;
    }
    runtime.tactical = {
      intent: opening,
      roundId: this.state.match.matchId,
      expiresAtMs: now + opening.validForMs,
      singleFireUsed: false,
      abilityUsed: false
    };
    runtime.tacticalStopReason = "waiting";
  }

  private evaluateTacticalReflex(runtime: AgentRuntime, now: number, force = false): void {
    if (runtime.principal.controlMode !== "tactical_reflex_v1") return;
    const seatId = runtime.principal.seatId;
    const tactical = runtime.tactical;
    const player = this.state.players.get(seatId);
    const owner = this.state.owners.get(runtime.principal.ownerId);
    const stop = (reason: AgentTacticalStopReason) => {
      this.neutralizeAgent(seatId, `tactical_${reason}`, false, now);
      this.clearTacticalIntent(runtime, reason);
    };
    if (!tactical) return;
    if (tactical.roundId !== this.state.match.matchId) return stop("match_inactive");
    if (now >= tactical.expiresAtMs) return stop("intent_expired");
    if (!owner?.isConnected) return stop("owner_unavailable");
    if (runtime.paused) return stop("paused");
    if (this.state.matchState === "waiting" || this.state.matchState === "countdown") {
      runtime.tacticalStopReason = "waiting";
      return;
    }
    if (!player || !this.isActiveMatchState() || !this.canParticipateInCombat(player)) {
      return stop("match_inactive");
    }
    if (tactical.intent.objective.type === "engage_target") {
      const target = this.state.players.get(tactical.intent.objective.targetId);
      if (
        !target?.isAlive ||
        this.areFriendly(player, target) ||
        isPlayerConcealedBySmoke(target, now)
      ) return stop("target_unavailable");
    }
    if (tactical.intent.objective.type === "collect_pickup") {
      const pickupId = tactical.intent.objective.pickupId;
      if (!this.state.pickups.some((pickup) => pickup.id === pickupId && pickup.isActive)) {
        return stop("pickup_unavailable");
      }
    }
    if (
      !force &&
      runtime.lastReflexAtMs > 0 &&
      now - runtime.lastReflexAtMs < AGENT_TACTICAL_REFLEX_INTERVAL_MS
    ) return;
    const activeZoneWaypoint = runtime.lease?.tacticalZoneRecovery
      ? runtime.lease.action.waypoints[runtime.lease.waypointIndex]
      : undefined;
    if (activeZoneWaypoint && !force) {
      const survivalZone = this.agentTacticalSurvivalZone(player, now);
      const plannedZone = runtime.lease?.tacticalZoneTarget;
      const activeTargetId = runtime.lease?.action.targetId;
      const activeTarget = activeTargetId ? this.state.players.get(activeTargetId) : undefined;
      const activeTargetSelected = tactical.intent.objective.type === "engage_target"
        ? activeTargetId === tactical.intent.objective.targetId
        : tactical.intent.objective.type === "engage_nearest" &&
          activeTargetId === tactical.selectedTargetId;
      const remainingWaypoints = runtime.lease?.action.waypoints.slice(
        runtime.lease.waypointIndex
      ) ?? [];
      const sameSurvivalZone = Boolean(
        plannedZone &&
        Math.hypot(plannedZone.x - survivalZone.x, plannedZone.z - survivalZone.z) < 0.001 &&
        Math.abs(plannedZone.radius - survivalZone.radius) < 0.001
      );
      if (
        Math.hypot(player.x - survivalZone.x, player.y - survivalZone.z) >
          survivalZone.safeRadius &&
        sameSurvivalZone &&
        activeTargetSelected &&
        activeTarget?.isAlive &&
        !isPlayerConcealedBySmoke(activeTarget, now) &&
        routeClearsCircle(player.x, player.y, remainingWaypoints, {
          x: activeTarget.x,
          z: activeTarget.y,
          radius: TANK_COLLISION_RADIUS * 2 + 12
        })
      ) return;
    }
    runtime.lastReflexAtMs = now;

    const projection = this.projectAgentWorld(player, now);
    const objective = tactical.intent.objective;
    let destination: { x: number; z: number } | undefined;
    let targetPosition: { x: number; z: number } | undefined;
    let pickupId: string | undefined;
    let targetId: string | undefined;
    let directRetreat = false;
    let tacticalApproach = false;
    switch (objective.type) {
      case "hold":
        break;
      case "move_to":
        destination = objective.position;
        break;
      case "zone_center":
        destination = { x: projection.zone.centerX, z: projection.zone.centerZ };
        break;
      case "engage_nearest": {
        const selectedPosition = tactical.selectedTargetId
          ? projection.visibleTargets.get(tactical.selectedTargetId)
          : undefined;
        if (!selectedPosition) tactical.selectedTargetId = undefined;
        const target = selectedPosition && tactical.selectedTargetId
          ? { id: tactical.selectedTargetId, position: selectedPosition }
          : [...projection.visibleTargets]
              .map(([id, position]) => ({
                id,
                position,
                distance: Math.hypot(
                  position.x - projection.self.position.x,
                  position.z - projection.self.position.z
                )
              }))
              .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))[0];
        if (target) {
          tactical.selectedTargetId = target.id;
          targetId = target.id;
          targetPosition = target.position;
        }
        break;
      }
      case "engage_target":
        targetId = objective.targetId;
        targetPosition = projection.visibleTargets.get(targetId);
        if (!targetPosition) return stop("target_unavailable");
        break;
      case "collect_pickup": {
        const pickup = projection.pickups.find((candidate) => candidate.id === objective.pickupId);
        if (!pickup) return stop("pickup_unavailable");
        pickupId = pickup.id;
        destination = { x: pickup.x, z: pickup.z };
        break;
      }
    }

    const engagementObjective =
      objective.type === "engage_nearest" || objective.type === "engage_target";
    const routeTargetPosition = targetPosition ? {
      ...targetPosition,
      radius: TANK_COLLISION_RADIUS * 2 + 12 + AGENT_TARGET_POSITION_MAX_ERROR
    } : undefined;
    const survivalZone = this.agentTacticalSurvivalZone(player, now);
    const zoneDistance = Math.hypot(
      player.x - survivalZone.x,
      player.y - survivalZone.z
    );
    const safeZoneRadius = survivalZone.safeRadius;
    const outsideSafeZone = engagementObjective && zoneDistance > safeZoneRadius;
    if (outsideSafeZone) {
      destination = { x: survivalZone.x, z: survivalZone.z };
    } else if (targetPosition) {
      const targetX = targetPosition.x - player.x;
      const targetZ = targetPosition.z - player.y;
      const targetDistance = Math.hypot(targetX, targetZ);
      const firingLaneBlocked = Boolean(
        this.arena && projectileWallHit(
          this.arena,
          player.x,
          player.y,
          targetPosition.x,
          targetPosition.z,
          projectileRadius(player.weaponType)
        ).hit
      );
      const wantsFiringLane = tactical.intent.fire === "hold" ||
        (tactical.intent.fire === "single" && !tactical.singleFireUsed);
      if (targetDistance < AGENT_TACTICAL_COMBAT_DISTANCE - AGENT_TACTICAL_COMBAT_DISTANCE_TOLERANCE) {
        destination = chooseAgentTacticalRetreat(
          { x: player.x, z: player.y },
          targetPosition,
          player.rotation,
          survivalZone,
          (point) =>
            Math.hypot(point.x - survivalZone.x, point.z - survivalZone.z) <= safeZoneRadius + 0.001 &&
            this.validAgentRoute(player, [point])
        );
        directRetreat = Boolean(destination);
      } else if (targetDistance >
        AGENT_TACTICAL_COMBAT_DISTANCE + AGENT_TACTICAL_COMBAT_DISTANCE_TOLERANCE) {
        destination = targetPosition;
        tacticalApproach = true;
      } else if (firingLaneBlocked && wantsFiringLane) {
        destination = targetPosition;
      }
      if (destination) {
        const destinationZoneX = destination.x - survivalZone.x;
        const destinationZoneZ = destination.z - survivalZone.z;
        const destinationZoneDistance = Math.hypot(destinationZoneX, destinationZoneZ);
        if (destinationZoneDistance > safeZoneRadius && destinationZoneDistance > 0) {
          if (directRetreat) {
            destination = undefined;
            directRetreat = false;
          } else {
            destination = {
              x: survivalZone.x + destinationZoneX / destinationZoneDistance * safeZoneRadius,
              z: survivalZone.z + destinationZoneZ / destinationZoneDistance * safeZoneRadius
            };
          }
        }
      }
    }
    if (objective.type === "engage_nearest" && !targetId && !destination) {
      this.neutralizeAgent(seatId, "target_unavailable", true, now);
      runtime.tacticalStopReason = "target_unavailable";
      return;
    }

    const waypoints: AgentMacroActionV1["waypoints"] = [];
    let tacticalTerminal = false;
    if (destination) {
      const pointObjective = objective.type === "move_to" || objective.type === "zone_center";
      const routeZone = engagementObjective
        ? {
            x: survivalZone.x,
            z: survivalZone.z,
            radius: outsideSafeZone
              ? zoneDistance + AGENT_WAYPOINT_REACHED_DISTANCE
              : safeZoneRadius
          }
        : undefined;
      let route = outsideSafeZone && !directRetreat
        ? this.tacticalZoneRecoveryRoute(player, {
          x: survivalZone.x,
          z: survivalZone.z
        }, routeTargetPosition, objective.type === "engage_nearest")
        : this.tacticalRouteStep(player, destination, !directRetreat, routeZone);
      if (!route && tacticalApproach && !outsideSafeZone) {
        route = this.tacticalRouteStep(player, {
          x: survivalZone.x,
          z: survivalZone.z
        }, true, routeZone);
        if (!route) {
          const physicalSafeRadius = Math.max(0, survivalZone.radius - this.playerCollisionRadius());
          route = this.tacticalRouteStep(player, {
            x: survivalZone.x,
            z: survivalZone.z
          }, true, {
            x: survivalZone.x,
            z: survivalZone.z,
            radius: physicalSafeRadius
          });
          if (!route) {
            route = this.tacticalRouteStep(player, {
              x: survivalZone.x,
              z: survivalZone.z
            }, true, {
              x: survivalZone.x,
              z: survivalZone.z,
              radius: survivalZone.radius + AGENT_WAYPOINT_REACHED_DISTANCE
            });
          }
          if (!route && zoneDistance > 0) {
            const recoveryDistance = Math.min(
              zoneDistance,
              AGENT_TACTICAL_REFLEX_STEP_DISTANCE * 0.25
            );
            route = this.tacticalRouteStep(player, {
              x: player.x + (survivalZone.x - player.x) / zoneDistance * recoveryDistance,
              z: player.y + (survivalZone.z - player.y) / zoneDistance * recoveryDistance
            }, false, {
              x: survivalZone.x,
              z: survivalZone.z,
              radius: physicalSafeRadius
            });
          }
        }
        tacticalApproach = false;
      }
      if (!route) {
        if (!directRetreat && !engagementObjective) return stop("route_blocked");
      } else {
        if (route.complete && pointObjective) return stop("objective_complete");
        waypoints.push(...route.waypoints);
        tacticalTerminal = route.terminal;
      }
    }

    const requestedFire = targetId ? tactical.intent.fire : "none";
    const fire = requestedFire === "single" && tactical.singleFireUsed
      ? "none"
      : requestedFire;
    const useAbility = tactical.intent.useAbility === "once" && tactical.abilityUsed
      ? false
      : tactical.intent.useAbility;
    const action: AgentMacroActionV1 = {
      version: AGENT_ACTION_VERSION,
      actionSeq: ++runtime.internalMacroSequence,
      basedOnObservationSeq: tactical.intent.basedOnObservationSeq ?? 0,
      leaseMs: AGENT_TACTICAL_REFLEX_LEASE_MS,
      waypoints,
      ...(pickupId ? { pickupId } : {}),
      ...(targetId ? { targetId } : {}),
      fire,
      useAbility
    };
    const continuationFrom = waypoints.length > 1 ? waypoints.at(-2)! : { x: player.x, z: player.y };
    const continuationTo = waypoints.at(-1);
    const continuationDistance = continuationTo
      ? Math.hypot(continuationTo.x - continuationFrom.x, continuationTo.z - continuationFrom.z)
      : 0;
    this.neutralizeAgent(seatId, "tactical_refresh", true, now);
    runtime.lease = {
      action,
      expiresAtMs: now + AGENT_TACTICAL_REFLEX_LEASE_MS,
      waypointIndex: 0,
      singleFireUsed: tactical.singleFireUsed,
      abilityUsed: tactical.abilityUsed,
      tacticalTerminal,
      tacticalRetreat: directRetreat,
      tacticalApproach,
      tacticalZoneRecovery: outsideSafeZone,
      tacticalZoneTarget: outsideSafeZone ? {
        x: survivalZone.x,
        z: survivalZone.z,
        radius: survivalZone.radius
      } : undefined,
      ...(continuationTo && continuationDistance > 0 && !tacticalTerminal && !outsideSafeZone ? {
        tacticalContinuation: {
          moveX: (continuationTo.x - continuationFrom.x) / continuationDistance,
          moveY: (continuationTo.z - continuationFrom.z) / continuationDistance
        }
      } : {}),
      ...(targetPosition ? { targetPosition } : {})
    };
    runtime.tacticalStopReason = waypoints.length === 0 ? "hold" : "moving";
    this.recordAgentAudit("tactical_reflex", seatId, {
      intentSeq: tactical.intent.intentSeq,
      lastReflexAtMs: now,
      stopReason: runtime.tacticalStopReason,
      macro: auditMacroAction(action, true)
    });
  }

  private runAgentExecutors(now: number, forceTactical = false): void {
    for (const [ownerId, expiresAt] of this.agentPairingExpiresAt) {
      if (now < expiresAt) continue;
      const owner = this.state.owners.get(ownerId);
      this.agentPairingExpiresAt.delete(ownerId);
      this.agentPairingRequests.delete(ownerId);
      if (owner?.agentSeatState === "pending") this.clearOwnerAgentState(owner);
      this.syncWaitingAdmissionLock();
    }

    for (const runtime of [...this.agentRuntimes.values()]) {
      const seatId = runtime.principal.seatId;
      const player = this.state.players.get(seatId);
      const owner = this.state.owners.get(runtime.principal.ownerId);
      if (now >= runtime.idleDeadlineMs) {
        const expiry = agentBroker.claimExpiredControl({
          roomId: this.roomId,
          ownerId: runtime.principal.ownerId,
          seatId
        }, now);
        if (expiry.state === "active") {
          this.syncAgentSession(expiry.session);
          continue;
        }
        this.releaseAgentSeat(
          expiry.state === "expired" ? expiry.principal : runtime.principal,
          now,
          this.state.matchState === "waiting" || this.state.matchState === "countdown"
            ? "none"
            : "disconnected"
        );
        continue;
      }
      if (runtime.principal.controlMode === "tactical_reflex_v1") {
        this.evaluateTacticalReflex(runtime, now, forceTactical);
      }
      if (
        !player ||
        !owner?.isConnected ||
        runtime.paused ||
        !this.isActiveMatchState() ||
        !this.canParticipateInCombat(player)
      ) {
        const preserveWaitingTactic =
          runtime.principal.controlMode === "tactical_reflex_v1" &&
          (this.state.matchState === "waiting" || this.state.matchState === "countdown") &&
          Boolean(player && owner?.isConnected && !runtime.paused && this.canParticipateInCombat(player));
        this.neutralizeAgent(seatId, "inactive", preserveWaitingTactic, now);
        continue;
      }
      let lease = runtime.lease;
      if (!lease || now >= lease.expiresAtMs) {
        this.neutralizeAgent(
          seatId,
          "lease_expired",
          runtime.principal.controlMode === "tactical_reflex_v1" && runtime.tactical !== undefined,
          now
        );
        continue;
      }

      let waypoint = lease.action.waypoints[lease.waypointIndex];
      let tacticalContinuation: AgentLease["tacticalContinuation"];
      while (
        waypoint &&
        Math.hypot(waypoint.x - player.x, waypoint.z - player.y) <= AGENT_WAYPOINT_REACHED_DISTANCE
      ) {
        lease.waypointIndex += 1;
        waypoint = lease.action.waypoints[lease.waypointIndex];
      }
      if (lease.action.waypoints.length > 0 && !waypoint) {
        const pointObjective = runtime.tactical && (
          runtime.tactical.intent.objective.type === "move_to" ||
          runtime.tactical.intent.objective.type === "zone_center"
        );
        if (
          runtime.principal.controlMode !== "tactical_reflex_v1" ||
          (lease.tacticalTerminal && pointObjective)
        ) {
          this.neutralizeAgent(seatId, "route_complete", false, now);
          continue;
        }
        if (lease.tacticalTerminal) runtime.tacticalStopReason = "hold";
        else tacticalContinuation = lease.tacticalContinuation;
      }

      const target = lease.action.targetId
        ? this.state.players.get(lease.action.targetId)
        : undefined;
      if (
        lease.action.targetId &&
        (!target || !target.isAlive || this.areFriendly(player, target) || isPlayerConcealedBySmoke(target, now))
      ) {
        const reselect = runtime.tactical?.intent.objective.type === "engage_nearest";
        this.neutralizeAgent(seatId, "target_invalid", reselect, now);
        if (reselect && runtime.tactical) {
          runtime.tactical.selectedTargetId = undefined;
          runtime.tacticalStopReason = "target_unavailable";
        }
        continue;
      }

      const targetDistance = target
        ? Math.hypot(target.x - player.x, target.y - player.y)
        : Infinity;
      const survivalZone = this.agentTacticalSurvivalZone(player, now);
      const liveZoneDistance = Math.hypot(
        player.x - survivalZone.x,
        player.y - survivalZone.z
      );
      const actualZoneDistance = Math.hypot(
        player.x - this.state.zone.x,
        player.y - this.state.zone.y
      );
      const liveSafeZoneRadius = survivalZone.safeRadius;
      const farTarget = target &&
        targetDistance > AGENT_TACTICAL_COMBAT_DISTANCE + AGENT_TACTICAL_COMBAT_DISTANCE_TOLERANCE;
      const closeTarget = target &&
        targetDistance < AGENT_TACTICAL_COMBAT_DISTANCE - AGENT_TACTICAL_COMBAT_DISTANCE_TOLERANCE;
      runtime.tacticalTurningToClear = false;
      if (!closeTarget && liveZoneDistance <= liveSafeZoneRadius) {
        runtime.tacticalTurnStartedAtMs = undefined;
      }
      const selectLiveMovement = (
        clear: { x: number; z: number } | undefined,
        needsTurn: { x: number; z: number } | undefined
      ) => {
        if (clear) {
          runtime.tacticalTurnStartedAtMs = undefined;
          return clear;
        }
        if (!needsTurn) return undefined;
        runtime.tacticalTurnStartedAtMs ??= now;
        if (now - runtime.tacticalTurnStartedAtMs >= AGENT_TACTICAL_REFLEX_INTERVAL_MS) return undefined;
        runtime.tacticalTurningToClear = true;
        return needsTurn;
      };
      const chooseLiveRetreat = (requireClearHorizon: boolean) => closeTarget
        ? chooseAgentTacticalRetreat(
            { x: player.x, z: player.y },
            { x: target.x, z: target.y },
            player.rotation,
            survivalZone,
            (point) => {
              const pointZoneDistance = Math.hypot(
                point.x - survivalZone.x,
                point.z - survivalZone.z
              );
              return pointZoneDistance <= liveSafeZoneRadius + 0.001 &&
                this.validAgentLocalRoute(player, point) &&
                (!requireClearHorizon || this.validAgentMovementHorizon(player, point));
            }
          )
        : undefined;
      const liveRetreat = liveZoneDistance <= liveSafeZoneRadius
        ? selectLiveMovement(chooseLiveRetreat(true), chooseLiveRetreat(false))
        : undefined;
      if (liveRetreat) runtime.tacticalStopReason = "moving";
      const liveApproachCandidate = farTarget && liveZoneDistance <= liveSafeZoneRadius
        ? {
            x: player.x + (target.x - player.x) / targetDistance *
              Math.min(targetDistance, AGENT_TACTICAL_REFLEX_STEP_DISTANCE),
            z: player.y + (target.y - player.y) / targetDistance *
              Math.min(targetDistance, AGENT_TACTICAL_REFLEX_STEP_DISTANCE)
          }
        : undefined;
      const liveApproachPoint = liveApproachCandidate && Math.hypot(
        liveApproachCandidate.x - survivalZone.x,
        liveApproachCandidate.z - survivalZone.z
      ) <= liveSafeZoneRadius + 0.001
        ? liveApproachCandidate
        : undefined;
      const routedLiveApproach = liveApproachPoint && this.validAgentRoute(player, [liveApproachPoint])
        ? liveApproachPoint
        : undefined;
      const liveApproach = selectLiveMovement(
        routedLiveApproach && this.validAgentMovementHorizon(player, routedLiveApproach)
          ? routedLiveApproach
          : undefined,
        routedLiveApproach
      );
      if (liveApproach) runtime.tacticalStopReason = "moving";
      const retreatSatisfied = lease.tacticalRetreat &&
        liveZoneDistance <= liveSafeZoneRadius &&
        targetDistance >= AGENT_TACTICAL_COMBAT_DISTANCE - AGENT_TACTICAL_COMBAT_DISTANCE_TOLERANCE;
      if (retreatSatisfied && !liveApproach) runtime.tacticalStopReason = "hold";
      const approachSatisfied = lease.tacticalApproach &&
        liveZoneDistance <= liveSafeZoneRadius &&
        targetDistance <= AGENT_TACTICAL_COMBAT_DISTANCE + AGENT_TACTICAL_COMBAT_DISTANCE_TOLERANCE;
      if (approachSatisfied && !liveRetreat) runtime.tacticalStopReason = "hold";
      const engagementObjective = runtime.tactical?.intent.objective.type === "engage_nearest" ||
        runtime.tactical?.intent.objective.type === "engage_target";
      const liveZoneRecovery = !waypoint && !tacticalContinuation && engagementObjective &&
        liveZoneDistance > liveSafeZoneRadius
        ? this.agentZoneRecoveryStep(player, survivalZone)
        : undefined;
      if (liveZoneRecovery) runtime.tacticalStopReason = "moving";
      const tacticalWaypointValid = Boolean(
        waypoint &&
        runtime.principal.controlMode === "tactical_reflex_v1" &&
        this.validAgentLocalRoute(player, waypoint)
      );
      const zoneRecoveryClearance = TANK_COLLISION_RADIUS * 2 + 12;
      const zoneRecoveryRouteActive = Boolean(
        target &&
        lease.tacticalZoneRecovery &&
        liveZoneDistance > liveSafeZoneRadius
      );
      let tacticalWaypointHorizonValid = Boolean(
        tacticalWaypointValid &&
        waypoint &&
        this.validAgentMovementHorizon(player, waypoint, (state) =>
          !zoneRecoveryRouteActive ||
          Math.hypot(state.x - target!.x, state.y - target!.y) >=
            zoneRecoveryClearance - 0.001
        )
      );
      let selectedWaypoint = !retreatSatisfied && !approachSatisfied && !liveRetreat && !liveApproach && waypoint &&
        runtime.principal.controlMode === "tactical_reflex_v1"
        ? selectLiveMovement(
            tacticalWaypointHorizonValid ? waypoint : undefined,
            tacticalWaypointValid && !zoneRecoveryRouteActive ? waypoint : undefined
          )
        : waypoint;
      let movementPoint = liveRetreat ?? liveApproach ??
        (retreatSatisfied || approachSatisfied ? undefined : selectedWaypoint ?? liveZoneRecovery);
      const needsZoneRepair = engagementObjective && liveZoneDistance > liveSafeZoneRadius;
      const liveTargetPosition = target
        ? { x: Math.round(target.x / 25) * 25, z: Math.round(target.y / 25) * 25 }
        : undefined;
      const routeRepairKey = liveTargetPosition
        ? [
            Math.round(player.x / 25),
            Math.round(player.y / 25),
            ...(needsZoneRepair
              ? ["zone"]
              : [liveTargetPosition.x / 25, liveTargetPosition.z / 25]),
            Math.round(survivalZone.x / 25),
            Math.round(survivalZone.z / 25),
            Math.round(survivalZone.radius / 25),
            needsZoneRepair ? 1 : 0
          ].join(":")
        : undefined;
      if (
        runtime.principal.controlMode === "tactical_reflex_v1" &&
        (farTarget || needsZoneRepair) &&
        liveTargetPosition &&
        routeRepairKey &&
        !movementPoint &&
        !tacticalContinuation &&
        runtime.lastReflexAtMs !== now &&
        now - (runtime.tacticalRouteRepairAtMs ?? -Infinity) >= AGENT_TACTICAL_ROUTE_REPAIR_INTERVAL_MS &&
        (
          routeRepairKey !== runtime.tacticalRouteRepairKey ||
          now - (runtime.tacticalRouteRepairAtMs ?? -Infinity) >= AGENT_TACTICAL_REFLEX_INTERVAL_MS
        )
      ) {
        runtime.tacticalRouteRepairAtMs = now;
        runtime.tacticalRouteRepairKey = routeRepairKey;
        const targetZoneX = liveTargetPosition.x - survivalZone.x;
        const targetZoneZ = liveTargetPosition.z - survivalZone.z;
        const targetZoneDistance = Math.hypot(targetZoneX, targetZoneZ);
        const destination = needsZoneRepair
          ? { x: survivalZone.x, z: survivalZone.z }
          : targetZoneDistance > liveSafeZoneRadius && targetZoneDistance > 0
            ? {
              x: survivalZone.x + targetZoneX / targetZoneDistance * liveSafeZoneRadius,
              z: survivalZone.z + targetZoneZ / targetZoneDistance * liveSafeZoneRadius
            }
            : liveTargetPosition;
        const physicalSafeRadius = Math.max(0, survivalZone.radius - this.playerCollisionRadius());
        let route = needsZoneRepair && target
          ? this.tacticalZoneRecoveryRoute(player, destination, {
              x: target.x,
              z: target.y
            }, runtime.tactical?.intent.objective.type === "engage_nearest")
          : this.tacticalRouteStep(player, destination, true, {
              x: survivalZone.x,
              z: survivalZone.z,
              radius: liveSafeZoneRadius
            });
        let repairedApproach = !needsZoneRepair;
        if (!route && !needsZoneRepair) {
          route = this.tacticalRouteStep(player, {
            x: survivalZone.x,
            z: survivalZone.z
          }, true, {
            x: survivalZone.x,
            z: survivalZone.z,
            radius: liveSafeZoneRadius
          });
          repairedApproach = false;
        }
        if (!route) {
          route = this.tacticalRouteStep(player, {
            x: survivalZone.x,
            z: survivalZone.z
          }, true, {
            x: survivalZone.x,
            z: survivalZone.z,
            radius: physicalSafeRadius
          });
          if (!route) {
            route = this.tacticalRouteStep(player, {
              x: survivalZone.x,
              z: survivalZone.z
            }, true, {
              x: survivalZone.x,
              z: survivalZone.z,
              radius: survivalZone.radius + AGENT_WAYPOINT_REACHED_DISTANCE
            });
          }
          if (!route && liveZoneDistance > 0) {
            const recoveryDistance = Math.min(
              liveZoneDistance,
              AGENT_TACTICAL_REFLEX_STEP_DISTANCE * 0.25
            );
            route = this.tacticalRouteStep(player, {
              x: player.x + (survivalZone.x - player.x) / liveZoneDistance * recoveryDistance,
              z: player.y + (survivalZone.z - player.y) / liveZoneDistance * recoveryDistance
            }, false, {
              x: survivalZone.x,
              z: survivalZone.z,
              radius: physicalSafeRadius
            });
          }
          repairedApproach = false;
        }
        if (route?.waypoints.length) {
          const action = {
            ...lease.action,
            actionSeq: ++runtime.internalMacroSequence,
            waypoints: route.waypoints
          };
          lease = {
            ...lease,
            action,
            expiresAtMs: now + AGENT_TACTICAL_REFLEX_LEASE_MS,
            waypointIndex: 0,
            tacticalTerminal: route.terminal,
            tacticalRetreat: false,
            tacticalApproach: repairedApproach,
            tacticalZoneRecovery: needsZoneRepair,
            tacticalZoneTarget: needsZoneRepair ? {
              x: survivalZone.x,
              z: survivalZone.z,
              radius: survivalZone.radius
            } : undefined,
            tacticalContinuation: undefined,
            targetPosition: liveTargetPosition
          };
          runtime.lease = lease;
          runtime.lastReflexAtMs = now;
          runtime.tacticalTurnStartedAtMs = undefined;
          waypoint = route.waypoints[0]!;
          const repairedZoneRecovery = Boolean(needsZoneRepair && target);
          tacticalWaypointHorizonValid = this.validAgentMovementHorizon(player, waypoint, (state) =>
            !repairedZoneRecovery ||
            Math.hypot(state.x - target!.x, state.y - target!.y) >=
              zoneRecoveryClearance - 0.001
          );
          selectedWaypoint = selectLiveMovement(
            tacticalWaypointHorizonValid ? waypoint : undefined,
            repairedZoneRecovery ? undefined : waypoint
          );
          movementPoint = selectedWaypoint;
          runtime.tacticalStopReason = movementPoint ? "moving" : "hold";
          this.recordAgentAudit("tactical_route_repair", seatId, {
            intentSeq: runtime.tactical?.intent.intentSeq,
            lastReflexAtMs: now,
            repair: repairedApproach ? "approach" : "zone_center",
            stopReason: runtime.tacticalStopReason,
            macro: auditMacroAction(action, true)
          });
        }
      }
      const distance = movementPoint
        ? Math.hypot(movementPoint.x - player.x, movementPoint.z - player.y)
        : 0;
      const directionX = movementPoint && distance > 0
        ? (movementPoint.x - player.x) / distance
        : tacticalContinuation?.moveX ?? 0;
      const directionY = movementPoint && distance > 0
        ? (movementPoint.z - player.y) / distance
        : tacticalContinuation?.moveY ?? 0;
      const steeringMagnitude = directionX === 0 && directionY === 0
        ? 0
        : runtime.principal.controlMode === "tactical_reflex_v1"
          ? tacticalSteeringMagnitude(player.rotation, directionX, directionY)
          : 1;
      let moveX = directionX * steeringMagnitude;
      let moveY = directionY * steeringMagnitude;
      const closesUnsafeTargetGap = target && targetDistance > 0 &&
        (target.x - player.x) * moveX + (target.y - player.y) * moveY > 0.001;
      const zoneRecoveryWaypointAllowed = Boolean(
        target &&
        lease.tacticalZoneRecovery &&
        waypoint &&
        selectedWaypoint === waypoint &&
        movementPoint === selectedWaypoint &&
        liveZoneDistance > liveSafeZoneRadius &&
        this.validAgentMovementHorizon(player, waypoint, (state) =>
          Math.hypot(state.x - target.x, state.y - target.y) >= zoneRecoveryClearance - 0.001
        )
      );
      let emergencyZoneEscape = Boolean(
        zoneRecoveryWaypointAllowed ||
        (lease.tacticalZoneRecovery && liveZoneDistance > liveSafeZoneRadius)
      );
      const needsCloseTargetEscape = liveZoneDistance > liveSafeZoneRadius ||
        closesUnsafeTargetGap ||
        Math.hypot(moveX, moveY) <= 0.04;
      if (
        runtime.principal.controlMode === "tactical_reflex_v1" &&
        targetDistance < AGENT_TACTICAL_COMBAT_DISTANCE - AGENT_TACTICAL_COMBAT_DISTANCE_TOLERANCE &&
        needsCloseTargetEscape &&
        !zoneRecoveryWaypointAllowed
      ) {
        if (liveZoneDistance > liveSafeZoneRadius) {
          const zoneInwardAngle = Math.atan2(
            survivalZone.z - player.y,
            survivalZone.x - player.x
          );
          const escapePoints = [70, 40, 20, 10, 5].flatMap((distance) =>
            [
              0,
              Math.PI / 8,
              -Math.PI / 8,
              Math.PI / 4,
              -Math.PI / 4,
              Math.PI * 3 / 8,
              -Math.PI * 3 / 8,
              Math.PI / 2,
              -Math.PI / 2
            ].map((offset) => ({
                x: player.x + Math.cos(zoneInwardAngle + offset) * distance,
                z: player.y + Math.sin(zoneInwardAngle + offset) * distance
              }))
          );
          const escapeHorizonAllowed = (point: { x: number; z: number }, minimumTargetDistance: number) => {
            let finalZoneDistance = liveZoneDistance;
            const valid = this.validAgentMovementHorizon(player, point, (state) => {
              finalZoneDistance = Math.hypot(
                state.x - survivalZone.x,
                state.y - survivalZone.z
              );
              return finalZoneDistance <= liveZoneDistance + 0.001 &&
                Math.hypot(state.x - target!.x, state.y - target!.y) >= minimumTargetDistance;
            });
            return valid && finalZoneDistance < liveZoneDistance - 0.001;
          };
          const chooseEscape = (minimumTargetDistance: number) => escapePoints.find((point) =>
            Math.hypot(point.x - survivalZone.x, point.z - survivalZone.z) < liveZoneDistance - 0.001 &&
            Math.hypot(point.x - target!.x, point.z - target!.y) >= minimumTargetDistance &&
            this.validAgentLocalRoute(player, point) &&
            escapeHorizonAllowed(point, minimumTargetDistance)
          );
          let selectedTangentPoint = chooseEscape(targetDistance - 0.001);
          if (
            !selectedTangentPoint &&
            (needsZoneRepair || actualZoneDistance > this.state.zone.radius)
          ) {
            const hardClearance = TANK_COLLISION_RADIUS * 2 + 12;
            selectedTangentPoint = chooseEscape(Math.min(targetDistance, hardClearance) - 0.001);
            emergencyZoneEscape = Boolean(selectedTangentPoint);
          }
          const tangentDistance = selectedTangentPoint
            ? Math.hypot(selectedTangentPoint.x - player.x, selectedTangentPoint.z - player.y)
            : 0;
          const tangent = selectedTangentPoint && tangentDistance > 0
            ? {
                x: (selectedTangentPoint.x - player.x) / tangentDistance,
                y: (selectedTangentPoint.z - player.y) / tangentDistance
              }
            : undefined;
          if (tangent) {
            runtime.tacticalTurnStartedAtMs = undefined;
            const tangentMagnitude = tacticalSteeringMagnitude(player.rotation, tangent.x, tangent.y);
            moveX = tangent.x * tangentMagnitude;
            moveY = tangent.y * tangentMagnitude;
            emergencyZoneEscape = true;
            runtime.tacticalStopReason = "moving";
          } else if (!zoneRecoveryWaypointAllowed) {
            moveX = 0;
            moveY = 0;
          }
        } else if (!zoneRecoveryWaypointAllowed) {
          moveX = 0;
          moveY = 0;
        }
      }
      const movementBlocker = runtime.principal.controlMode === "tactical_reflex_v1"
        ? this.firstTacticalMovementBlocker(player, { moveX, moveY }, now)
        : undefined;
      let movementBlockerRetargeted = false;
      if (movementBlocker) {
        moveX = 0;
        moveY = 0;
        runtime.tacticalTurningToClear = false;
        runtime.tacticalStopReason = "hold";
        this.fireIntents.delete(seatId);
        const tactical = runtime.tactical;
        const objective = tactical?.intent.objective;
        if (
          tactical &&
          objective?.type === "engage_nearest" &&
          movementBlocker.sessionId !== target?.sessionId &&
          !this.areFriendly(player, movementBlocker)
        ) {
          tactical.selectedTargetId = movementBlocker.sessionId;
          runtime.lease = undefined;
          runtime.lastReflexAtMs = 0;
          runtime.tacticalTurnStartedAtMs = undefined;
          runtime.tacticalRouteRepairAtMs = undefined;
          runtime.tacticalRouteRepairKey = undefined;
          this.abilityIntents.delete(seatId);
          movementBlockerRetargeted = true;
        }
      }
      if (
        runtime.principal.controlMode === "tactical_reflex_v1" &&
        Math.hypot(moveX, moveY) <= 0.04
      ) runtime.tacticalStopReason = "hold";
      const aimX = liveTargetPosition?.x ?? lease.targetPosition?.x ?? waypoint?.x ??
        player.x + Math.cos(player.turretRotation) * 100;
      const aimY = liveTargetPosition?.z ?? lease.targetPosition?.z ?? waypoint?.z ??
        player.y + Math.sin(player.turretRotation) * 100;
      const sequence = ++runtime.lowLevelSequence;
      this.inputIntents.set(seatId, {
        sequence,
        tick: this.state.match.tick,
        moveX,
        moveY,
        aimX,
        aimY,
        fire: false,
        ability: false,
        receivedAt: now
      });

      const clearShot = Boolean(
        target &&
        this.arena &&
        !projectileWallHit(
          this.arena,
          player.x,
          player.y,
          aimX,
          aimY,
          projectileRadius(player.weaponType)
        ).hit
      );
      const muzzleClear =
        runtime.principal.controlMode !== "tactical_reflex_v1" ||
        targetDistance >= agentMinimumFireDistance();
      const shouldFire =
        target &&
        lease.action.fire !== "none" &&
        (!emergencyZoneEscape || Boolean(movementBlocker)) &&
        !movementBlockerRetargeted &&
        player.fireCooldownMs <= 0 &&
        clearShot &&
        muzzleClear &&
        (lease.action.fire === "hold" || !lease.singleFireUsed);
      if (shouldFire) {
        this.fireIntents.set(seatId, { sequence, aimX, aimY, receivedAt: now });
        lease.singleFireUsed = true;
        if (runtime.tactical && lease.action.fire === "single") {
          runtime.tactical.singleFireUsed = true;
        }
      }
      let abilityIssued = false;
      if (
        lease.action.useAbility === "once" &&
        !lease.abilityUsed &&
        !movementBlockerRetargeted &&
        player.abilityCooldownMs <= 0 &&
        player.abilityCharge >= ABILITY_CONFIG[player.abilityType].chargeCost
      ) {
        this.abilityIntents.set(seatId, {
          sequence,
          abilityType: player.abilityType,
          targetX: lease.targetPosition?.x ?? player.x,
          targetY: lease.targetPosition?.z ?? player.y,
          receivedAt: now
        });
        lease.abilityUsed = true;
        if (runtime.tactical) runtime.tactical.abilityUsed = true;
        abilityIssued = true;
      }
      this.recordAgentAudit("executor_intent", seatId, {
        tick: this.state.match.tick,
        sequence,
        actionSeq: lease.action.actionSeq,
        moveX: Math.round(moveX * 100) / 100,
        moveY: Math.round(moveY * 100) / 100,
        aimX: Math.round(aimX),
        aimY: Math.round(aimY),
        fireRequested: lease.action.fire !== "none",
        fireIssued: Boolean(shouldFire),
        fireBlockedByWall: Boolean(target && lease.action.fire !== "none" && !clearShot),
        abilityIssued
      });
    }
  }

  private neutralizeInvalidAgentTargets(now: number): void {
    for (const runtime of this.agentRuntimes.values()) {
      const targetId = runtime.lease?.action.targetId;
      if (!targetId) continue;
      const player = this.state.players.get(runtime.principal.seatId);
      const target = this.state.players.get(targetId);
      if (
        !player ||
        !this.canParticipateInCombat(player) ||
        !target?.isAlive ||
        this.areFriendly(player, target) ||
        isPlayerConcealedBySmoke(target, now)
      ) {
        const reselect = runtime.tactical?.intent.objective.type === "engage_nearest";
        this.neutralizeAgent(runtime.principal.seatId, "target_invalid", reselect, now);
        if (reselect && runtime.tactical) {
          runtime.tactical.selectedTargetId = undefined;
          runtime.tacticalStopReason = "target_unavailable";
        }
      }
    }
  }

  private neutralizeAgent(
    seatId: string,
    reason = "neutralized",
    preserveTactical = false,
    now = Date.now(),
    preserveLease = false
  ): void {
    const runtime = this.agentRuntimes.get(seatId);
    const actionSeq = runtime?.lease?.action.actionSeq;
    if (runtime?.lease) {
      this.recordAgentAudit("executor_neutral", seatId, {
        tick: this.state.match.tick,
        actionSeq,
        reason
      });
    }
    if (runtime) {
      if (!preserveLease) runtime.lease = undefined;
      if (runtime.tactical && !preserveTactical) {
        const stopReason: AgentTacticalStopReason = reason === "paused"
          ? "paused"
          : reason === "owner_disconnected"
            ? "owner_unavailable"
            : reason === "route_blocked"
              ? "route_blocked"
              : reason === "route_complete"
                ? "objective_complete"
                : reason === "target_invalid"
                  ? "target_unavailable"
                  : reason === "released"
                    ? "released"
                    : reason === "inactive"
                      ? "match_inactive"
                      : "cleared";
        this.clearTacticalIntent(runtime, stopReason);
      }
    }
    this.fireIntents.delete(seatId);
    this.abilityIntents.delete(seatId);
    const player = this.state.players.get(seatId);
    if (!runtime || !player) {
      this.inputIntents.delete(seatId);
      return;
    }
    this.inputIntents.set(seatId, {
      sequence: ++runtime.lowLevelSequence,
      tick: this.state.match.tick,
      moveX: 0,
      moveY: 0,
      aimX: player.x + Math.cos(player.turretRotation) * 100,
      aimY: player.y + Math.sin(player.turretRotation) * 100,
      fire: false,
      ability: false,
      receivedAt: now
    });
  }

  private invalidateAgentObservation(seatId: string): void {
    const runtime = this.agentRuntimes.get(seatId);
    if (!runtime) return;
    runtime.observationRoundId = "";
    runtime.visibleTargets.clear();
  }

  private releaseAgentSeat(
    principal: AgentControlPrincipal,
    now: number,
    finalState: OwnerSchema["agentSeatState"] = "none"
  ): void {
    const runtime = this.agentRuntimes.get(principal.seatId);
    if (!runtime) return;
    if (
      runtime.principal.controlId !== principal.controlId ||
      runtime.principal.ownerId !== principal.ownerId
    ) {
      throw new AgentBrokerError("principal_mismatch");
    }
    const owner = this.state.owners.get(principal.ownerId);
    if (!owner || owner.agentSeatId !== principal.seatId) {
      throw new AgentBrokerError("principal_mismatch");
    }
    this.neutralizeAgent(principal.seatId, "released");
    this.agentRuntimes.delete(principal.seatId);
    const player = this.state.players.get(principal.seatId);
    this.clearPlayerRuntimeState(principal.seatId, player);
    if (player) {
      player.isConnected = false;
      if (this.state.matchState === "waiting" || this.state.matchState === "countdown") {
        this.state.players.delete(principal.seatId);
      } else if (player.isAlive) {
        this.eliminatePlayer(player, undefined, now);
      }
    }
    this.clearOwnerAgentState(owner);
    owner.agentSeatState = finalState;
    owner.isReady = false;
    const human = this.state.players.get(owner.humanSessionId);
    if (human) human.isReady = false;
    this.recordAgentAudit("released", principal.seatId, { finalState });
    this.state.match.alivePlayers = alivePlayerCount(this.state);
    if (this.state.matchState === "countdown" && !this.canBeginCountdown()) {
      this.cancelCountdown();
    }
    this.checkForMatchConclusion(now);
    this.syncWaitingAdmissionLock();
    void this.updateMetadata();
  }

  private clearOwnerAgentState(owner: OwnerSchema): void {
    owner.agentSeatId = "";
    owner.agentLabel = "";
    owner.agentSeatState = "none";
    owner.agentPairingExpiresAtMs = 0;
  }

  private cancelOwnerAgentBeforeMatch(owner: OwnerSchema, now: number): void {
    const requestId = this.agentPairingRequests.get(owner.ownerId);
    if (requestId) {
      try {
        agentBroker.cancelGrant(requestId, { roomId: this.roomId, ownerId: owner.ownerId });
      } catch {
        // A concurrent consume or expiry is handled by the runtime path below.
      }
      this.agentPairingRequests.delete(owner.ownerId);
      this.agentPairingExpiresAt.delete(owner.ownerId);
    }
    const runtime = owner.agentSeatId ? this.agentRuntimes.get(owner.agentSeatId) : undefined;
    if (runtime) {
      try {
        agentBroker.revokeControl(runtime.principal);
      } catch {
        try {
          agentBroker.cancelGrant(runtime.principal.requestId, {
            roomId: this.roomId,
            ownerId: runtime.principal.ownerId
          });
        } catch {
          // Already expired, released, consumed, or cancelled.
        }
      }
      this.releaseAgentSeat(runtime.principal, now);
      return;
    }
    this.clearOwnerAgentState(owner);
  }

  private recordAgentAudit(
    event: string,
    seatId: string,
    fields: Record<string, unknown> = {}
  ): void {
    const entry = {
      event,
      roomId: this.roomId,
      roundId: this.state.match.matchId,
      seatId,
      mode: this.policy.mode,
      observationVersion: AGENT_OBSERVATION_VERSION,
      actionVersion: AGENT_ACTION_VERSION,
      executorVersion: AGENT_EXECUTOR_VERSION,
      at: Date.now(),
      ...fields
    };
    if (this.agentAudit.length < AGENT_AUDIT_CAPACITY) {
      this.agentAudit.push(entry);
      return;
    }
    this.agentAudit[this.agentAuditCursor] = entry;
    this.agentAuditCursor = (this.agentAuditCursor + 1) % this.agentAudit.length;
  }

  private recordAgentOutcome(
    player: PlayerSchema,
    event: string,
    fields: Record<string, unknown>
  ): void {
    if (player.controlKind === "agent") this.recordAgentAudit(event, player.sessionId, fields);
  }

  debugAgentAuditSnapshot(): Array<Record<string, unknown>> {
    if (this.agentAudit.length < AGENT_AUDIT_CAPACITY || this.agentAuditCursor === 0) {
      return this.agentAudit.map((entry) => ({ ...entry }));
    }
    return [
      ...this.agentAudit.slice(this.agentAuditCursor),
      ...this.agentAudit.slice(0, this.agentAuditCursor)
    ].map((entry) => ({ ...entry }));
  }

  agentCapacitySnapshot() {
    const players = Array.from(this.state.players.values());
    const runtimes = Array.from(this.agentRuntimes.values());
    const activeLeases = runtimes.filter((runtime) => runtime.lease !== undefined).length;
    const combatants = players.filter((player) =>
      player.controlKind === "agent" ||
      this.state.owners.get(player.ownerId)?.principalKind === "combatant"
    );
    return {
      mode: this.policy.mode,
      matchState: this.state.matchState,
      owners: this.state.owners.size,
      connectedOwners: Array.from(this.state.owners.values()).filter((owner) => owner.isConnected).length,
      controls: runtimes.length,
      agentEntities: players.filter((player) => player.controlKind === "agent").length,
      combatants: combatants.length,
      activeLeases,
      pausedControls: runtimes.filter((runtime) => runtime.paused).length,
      pendingPairings: this.agentPairingRequests.size,
      auditEvents: this.agentAudit.length
    };
  }

  private hasMinimumPlayers(): boolean {
    const minimums = roomStartMinimums(this.policy.mode);
    return connectedPlayerCount(this.state) >= minimums.owners &&
      this.combatantCount() >= minimums.combatants;
  }

  private hasEnoughReadyPlayers(): boolean {
    if (!this.hasMinimumPlayers()) return false;
    if (
      this.state.owners.size > this.policy.ownerCap ||
      this.combatantCount() > this.policy.combatantCap ||
      this.agentRuntimes.size > this.policy.agentControlCap
    ) return false;

    for (const owner of this.state.owners.values()) {
      if (!owner.isConnected || !owner.isReady || !this.ownerPairingComplete(owner)) return false;
    }

    return true;
  }

  private canBeginCountdown(): boolean {
    return this.policy.mode === "classic" ? this.hasMinimumPlayers() : this.hasEnoughReadyPlayers();
  }

  private isActiveMatchState(): boolean {
    return (
      this.state.matchState === "running" ||
      this.state.matchState === "danger" ||
      this.state.matchState === "final_zone"
    );
  }

  private canAcceptPlayerIntent(player: PlayerSchema): boolean {
    return player.isConnected && player.isAlive && !player.isSpectator;
  }

  private canParticipateInCombat(player: PlayerSchema): boolean {
    return player.isAlive && !player.isSpectator;
  }

  private areFriendly(left: PlayerSchema, right: PlayerSchema): boolean {
    return (
      this.policy.mode === "wingman" &&
      left.pairId.length > 0 &&
      left.pairId === right.pairId
    );
  }

  private canAcceptActiveJoin(): boolean {
    if (this.state?.matchState !== "waiting" || this.state.owners.size >= this.policy.ownerCap) {
      return false;
    }
    return this.policy.mode !== "open_ffa" ||
      this.combatantCount() + this.agentPairingRequests.size < this.policy.combatantCap;
  }

  private syncWaitingAdmissionLock(): void {
    if (this.state?.matchState !== "waiting") return;
    void (this.canAcceptActiveJoin() ? this.unlock() : this.lock());
  }

  private ownerPairingComplete(owner: OwnerSchema): boolean {
    if (this.policy.mode === "classic") return owner.agentSeatState === "none";
    if (this.policy.mode === "open_ffa") {
      return owner.agentSeatState === "none" || (
        owner.agentSeatState === "connected" && this.agentRuntimes.has(owner.agentSeatId)
      );
    }
    return owner.agentSeatState === "connected" && this.agentRuntimes.has(owner.agentSeatId);
  }

  private combatantCount(): number {
    let count = 0;
    for (const player of this.state.players.values()) {
      if (!player.isSpectator) count += 1;
    }
    return count;
  }

  private getPlayerOrError(client: Client): PlayerSchema | undefined {
    const player = this.state.players.get(client.sessionId);
    if (!player) {
      this.sendError(client, "not_joined", "Player is not joined", false);
      return undefined;
    }
    return player;
  }

  private ensureHost(): void {
    let hostAssigned = false;
    for (const owner of this.state.owners.values()) {
      if (owner.isHost && owner.isConnected) {
        hostAssigned = true;
        continue;
      }
      if (!hostAssigned || owner.isHost) {
        owner.isHost = false;
      }
    }
    if (!hostAssigned) {
      for (const owner of this.state.owners.values()) {
        if (owner.isConnected) {
          owner.isHost = true;
          break;
        }
      }
    }

    for (const player of this.state.players.values()) {
      player.isHost =
        player.controlKind === "human" && (this.state.owners.get(player.ownerId)?.isHost ?? false);
    }
  }

  private sendSystem(client: Client, code: SystemMessageCode, message: string): void {
    client.send(SERVER_MESSAGE_TYPES.SYSTEM, {
      code,
      message,
      roomCode: this.state.roomCode,
      matchState: this.state.matchState,
      seed: this.state.seed,
      at: Date.now()
    });
  }

  private broadcastSystem(
    code: SystemMessageCode,
    message: string,
    extra?: Partial<
      Pick<
        SystemMessagePayload,
        "playerSessionId" | "playerName" | "pickupType" | "pickupName" | "pickupValue" | "pickupDurationMs"
      >
    >
  ): void {
    this.broadcast(SERVER_MESSAGE_TYPES.SYSTEM, {
      code,
      message,
      roomCode: this.state.roomCode,
      matchState: this.state.matchState,
      seed: this.state.seed,
      ...extra,
      at: Date.now()
    });
  }

  private sendError(
    client: Client,
    code: ErrorMessageCode,
    message: string,
    retryable: boolean,
    field?: string
  ): void {
    client.send(SERVER_MESSAGE_TYPES.ERROR, {
      code,
      message,
      retryable,
      field
    });
  }

  private async updateMetadata(): Promise<void> {
    await this.setMetadata({
      roomName: BATTLE_ROYALE_ROOM,
      roomCode: this.state.roomCode,
      private: this.isPrivateRoom,
      matchState: this.state.matchState,
      playerCount: playerCount(this.state),
      maxClients: this.maxClients,
      mode: this.policy.mode,
      roomMode: this.policy.mode,
      track: this.policy.track,
      combatantCap: this.policy.combatantCap,
      seed: this.state.seed
    });
  }
}
