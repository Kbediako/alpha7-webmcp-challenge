import {
  ABILITY_CONFIG,
  DEFAULT_TANK_ARCHETYPE,
  isPlayerConcealedBySmoke,
  roomStartMinimums,
  TANK_ARCHETYPE_CONFIG,
  TANK_ARCHETYPES,
  WEAPON_CONFIG,
  type ArenaWeatherConfig,
  type AbilityType,
  type ControlKind,
  type AgentSeatState,
  type MatchState,
  type PickupType,
  type RoomMode,
  type TankArchetypeId,
  type WeaponType
} from "@alpha7/shared";
import type {
  Alpha7StateSchema,
  PickupSchema,
  PlayerSchema,
  ProjectileSchema
} from "@alpha7/shared/schema";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "offline" | "error";
export type ScreenMode = "menu" | "lobby" | "playing";
export type JoinMode = "quick" | "public" | "private" | "code";

export { isPlayerConcealedBySmoke } from "@alpha7/shared";

export interface ClientPlayer {
  id: string;
  sessionId: string;
  ownerId: string;
  pairId: string;
  controlKind: ControlKind;
  name: string;
  archetypeId: TankArchetypeId;
  weaponType: WeaponType;
  abilityType: AbilityType;
  x: number;
  y: number;
  rotation: number;
  turretRotation: number;
  velocityX: number;
  velocityY: number;
  speedMultiplier: number;
  health: number;
  maxHealth: number;
  armor: number;
  maxArmor: number;
  shield: number;
  ammo: number;
  abilityCharge: number;
  fireCooldownMs: number;
  abilityCooldownMs: number;
  lastAbilityType: AbilityType;
  lastAbilityAt: number;
  lastAbilityEndsAt: number;
  lastAbilityX: number;
  lastAbilityY: number;
  smokeActivatedAt: number;
  smokeEndsAt: number;
  smokeX: number;
  smokeY: number;
  score: number;
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
  placement: number;
  survivalTimeMs: number;
  teamPlacement: number;
  teamKills: number;
  joinedAt: number;
  respawnAt: number;
  isConnected: boolean;
  isReady: boolean;
  isAlive: boolean;
  isSpectator: boolean;
  isHost: boolean;
  isSelf: boolean;
}

export interface ClientOwner {
  ownerId: string;
  humanSessionId: string;
  displayName: string;
  agentSeatId: string;
  agentLabel: string;
  agentSeatState: AgentSeatState;
  agentPairingExpiresAtMs: number;
  isConnected: boolean;
  isReady: boolean;
  isHost: boolean;
}

export interface MatchStanding {
  id: string;
  name: string;
  placement: number;
  kills: number;
  damageDealt: number;
  survivalTimeMs: number;
  isAlive: boolean;
  isSelf: boolean;
  kind: "player" | "pair";
}

export const shouldRepeatHeldFire = (
  player: Pick<ClientPlayer, "weaponType" | "ammo">
): boolean =>
  WEAPON_CONFIG[player.weaponType].category === "rapid" ||
  (player.weaponType !== "explosive" && player.ammo > 0);

export const isOwnedAlly = (
  snapshot: Pick<ClientSnapshot, "policy" | "self">,
  player: Pick<ClientPlayer, "ownerId">
): boolean =>
  (snapshot.policy.mode === "wingman" || snapshot.policy.mode === "agent_cup") &&
  player.ownerId === snapshot.self?.ownerId;

export const spectatorTargets = (
  snapshot: Pick<ClientSnapshot, "players" | "policy" | "self">,
  now: number
): ClientPlayer[] =>
  snapshot.players.filter(
    (player) =>
      player.sessionId !== snapshot.self?.sessionId &&
      player.isAlive &&
      player.isConnected &&
      !player.isSpectator &&
      (!isPlayerConcealedBySmoke(player, now) || isOwnedAlly(snapshot, player))
  );

export const cycleSpectatorTarget = (
  targets: readonly Pick<ClientPlayer, "sessionId">[],
  currentId: string | null,
  direction: -1 | 1
): string | null => {
  if (targets.length === 0) return null;
  const currentIndex = targets.findIndex((target) => target.sessionId === currentId);
  if (currentIndex < 0) return targets[0]?.sessionId ?? null;
  return targets[(currentIndex + direction + targets.length) % targets.length]?.sessionId ?? null;
};

export interface ClientProjectile {
  id: string;
  ownerId: string;
  fireSequence: number;
  weaponType: WeaponType;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  rotation: number;
  radius: number;
  expiresAt: number;
}

export interface ClientPickup {
  id: string;
  pickupType: PickupType;
  x: number;
  y: number;
  radius: number;
  isActive: boolean;
}

export interface ArenaWall {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
}

export interface ArenaSpawn {
  id: string;
  x: number;
  y: number;
}

export interface ArenaMapConfig {
  id: string;
  source: "server" | "fallback";
  width: number;
  height: number;
  walls: ArenaWall[];
  spawns: ArenaSpawn[];
  weather: ArenaWeatherConfig;
}

export interface ClientSnapshot {
  roomId: string;
  roomCode: string;
  matchId: string;
  matchState: MatchState;
  seed: string;
  tick: number;
  alivePlayers: number;
  countdownEndsAt: number;
  matchEndsAt: number;
  stateStartedAt: number;
  serverTimeOffsetMs: number;
  policy: {
    mode: RoomMode;
    ownerCap: number;
    humanWsCap: number;
    agentControlCap: number;
    combatantCap: number;
  };
  zone: {
    x: number;
    y: number;
    radius: number;
    targetX: number;
    targetY: number;
    targetRadius: number;
    damagePerSecond: number;
  };
  players: ClientPlayer[];
  owners: ClientOwner[];
  self: ClientPlayer | null;
  projectiles: ClientProjectile[];
  pickups: ClientPickup[];
  map: ArenaMapConfig;
}

const sortStandings = (standings: MatchStanding[]): MatchStanding[] =>
  standings.sort((left, right) => {
    const leftPlacement = left.placement > 0 ? left.placement : Number.MAX_SAFE_INTEGER;
    const rightPlacement = right.placement > 0 ? right.placement : Number.MAX_SAFE_INTEGER;
    if (leftPlacement !== rightPlacement) return leftPlacement - rightPlacement;
    if (left.isAlive !== right.isAlive) return Number(right.isAlive) - Number(left.isAlive);
    if (left.kills !== right.kills) return right.kills - left.kills;
    if (left.damageDealt !== right.damageDealt) return right.damageDealt - left.damageDealt;
    return left.name.localeCompare(right.name);
  });

export const ownedAgentSessionId = (snapshot: Pick<ClientSnapshot, "owners" | "self">): string | null =>
  snapshot.owners.find((owner) => owner.ownerId === snapshot.self?.ownerId)?.agentSeatId || null;

export const matchStandings = (snapshot: ClientSnapshot, limit?: number): MatchStanding[] => {
  const selfOwnerId = snapshot.self?.ownerId;
  let standings: MatchStanding[];

  if (snapshot.policy.mode === "wingman") {
    standings = snapshot.owners.map((owner) => {
      const members = snapshot.players.filter((player) => player.pairId === owner.ownerId);
      const human = members.find((player) => player.controlKind === "human");
      const agent = members.find((player) => player.controlKind === "agent");
      return {
        id: owner.ownerId,
        name: `${human?.name ?? owner.displayName} + ${agent?.name ?? (owner.agentLabel || "Agent")}`,
        placement: members.find((player) => player.teamPlacement > 0)?.teamPlacement ?? 0,
        kills: members[0]?.teamKills ?? members.reduce((total, player) => total + player.kills, 0),
        damageDealt: members.reduce((total, player) => total + player.damageDealt, 0),
        survivalTimeMs: Math.max(0, ...members.map((player) => player.survivalTimeMs)),
        isAlive: members.some((player) => player.isAlive && !player.isSpectator),
        isSelf: owner.ownerId === selfOwnerId,
        kind: "pair" as const
      };
    });
  } else {
    const players = snapshot.policy.mode === "agent_cup"
      ? snapshot.players.filter((player) => player.controlKind === "agent")
      : snapshot.players.filter((player) => !player.isSpectator || player.placement > 0);
    standings = players.map((player) => {
      const owner = snapshot.owners.find((candidate) => candidate.ownerId === player.ownerId);
      return {
        id: player.sessionId,
        name:
          snapshot.policy.mode === "agent_cup"
            ? `${owner?.displayName ?? "Player"} · ${player.name}`
            : player.name,
        placement: player.placement,
        kills: player.kills,
        damageDealt: player.damageDealt,
        survivalTimeMs: player.survivalTimeMs,
        isAlive: player.isAlive && !player.isSpectator,
        isSelf: player.isSelf || player.ownerId === selfOwnerId,
        kind: "player" as const
      };
    });
  }

  sortStandings(standings);
  if (!limit || standings.length <= limit) return standings;
  const compact = standings.slice(0, limit);
  const owned = standings.find((standing) => standing.isSelf);
  return owned && !compact.includes(owned) ? [...compact, owned] : compact;
};

type AgentRoomOwner = {
  ownerId: string;
  isConnected: boolean;
  isReady: boolean;
  agentSeatState: AgentSeatState;
};

const ownerPairingComplete = (mode: RoomMode, owner?: AgentRoomOwner): boolean => {
  if (!owner) return false;
  if (mode === "classic") return true;
  if (mode === "open_ffa") {
    return owner.agentSeatState === "none" || owner.agentSeatState === "connected";
  }
  return owner.agentSeatState === "connected";
};

export const agentRoomReadiness = (
  mode: RoomMode,
  owners: readonly AgentRoomOwner[],
  selfOwnerId?: string
): { readinessBlocked: boolean; startBlocked: boolean } => ({
  readinessBlocked:
    mode !== "classic" && !ownerPairingComplete(mode, owners.find((owner) => owner.ownerId === selfOwnerId)),
  startBlocked:
    mode !== "classic" &&
    (owners.length < roomStartMinimums(mode).owners ||
      (mode === "open_ffa" &&
        owners.length + owners.filter((owner) => owner.agentSeatState === "connected").length <
          roomStartMinimums(mode).combatants) ||
      owners.some(
        (owner) => !owner.isConnected || !owner.isReady || !ownerPairingComplete(mode, owner)
      ))
});

export const activeAgentControlCount = (
  owners: readonly Pick<AgentRoomOwner, "agentSeatState">[]
): number => owners.filter((owner) => (
  owner.agentSeatState === "connected" ||
  owner.agentSeatState === "paused" ||
  owner.agentSeatState === "reconnecting"
)).length;

export const canRequestAgentPairing = (state: {
  matchState: MatchState;
  mode: RoomMode;
  agentSeatState: AgentSeatState;
  agentCount: number;
  pendingReservationCount: number;
  combatantCount: number;
  agentControlCap: number;
  combatantCap: number;
}): boolean => (
  state.matchState === "waiting" &&
  state.mode !== "classic" &&
  state.agentSeatState === "none" &&
  state.agentCount + state.pendingReservationCount < state.agentControlCap &&
  state.combatantCount + state.pendingReservationCount < state.combatantCap
);

export const canStartRoom = (
  mode: RoomMode,
  isHost: boolean,
  humanCount: number,
  readyCount: number,
  startBlocked: boolean
): boolean =>
  isHost &&
  humanCount >= roomStartMinimums(mode).owners &&
  (mode === "classic" || (readyCount === humanCount && !startBlocked));

export const snapshotServerNow = (
  snapshot: Pick<ClientSnapshot, "serverTimeOffsetMs">,
  localNow = Date.now()
): number => localNow + snapshot.serverTimeOffsetMs;

export interface InputFrame {
  moveX: number;
  moveY: number;
  aimMode: "screen" | "direction";
  aimScreenX: number | null;
  aimScreenY: number | null;
  aimWorldX: number;
  aimWorldY: number;
  aimDirX: number;
  aimDirY: number;
  fire: boolean;
  ability: boolean;
}

export type HudScenario = "lobby" | "lobby8" | "gameplay" | "danger" | "results8" | "spectator";

type StateWithOptionalMap = Alpha7StateSchema & {
  arenaConfigJson?: unknown;
  mapConfig?: unknown;
};

type UnknownRecord = Record<string, unknown>;

const DEFAULT_MAP_WIDTH = 1800;
const DEFAULT_MAP_HEIGHT = 1200;
const WALL_DEPTH = 118;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const parsePlayersOnline = (payload: unknown): number | null => {
  if (!isRecord(payload)) return null;
  const playersOnline = numberValue(payload.playersOnline);
  return playersOnline !== undefined && Number.isSafeInteger(playersOnline) && playersOnline >= 0
    ? playersOnline
    : null;
};

export const createSiteVisitorId = (): string => {
  // ponytail: non-secret browser dedupe token; use server-issued identity if this ever gates access.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const tankArchetype = (value: string): TankArchetypeId =>
  TANK_ARCHETYPES.includes(value as TankArchetypeId)
    ? (value as TankArchetypeId)
    : DEFAULT_TANK_ARCHETYPE;

const weaponType = (value: string): WeaponType =>
  value in WEAPON_CONFIG ? (value as WeaponType) : TANK_ARCHETYPE_CONFIG[DEFAULT_TANK_ARCHETYPE].primaryWeapon;

const abilityType = (value: string): AbilityType =>
  value in ABILITY_CONFIG ? (value as AbilityType) : TANK_ARCHETYPE_CONFIG[DEFAULT_TANK_ARCHETYPE].ability;

export const isActiveMatchState = (matchState: MatchState): boolean =>
  matchState === "running" || matchState === "danger" || matchState === "final_zone";

export const isWaitingRoomState = (matchState: MatchState): boolean =>
  matchState === "waiting" || matchState === "countdown";

export const isOuterBoundaryWall = (
  wall: ArenaWall,
  map: Pick<ArenaMapConfig, "width" | "height">
): boolean => {
  const left = wall.x - wall.width / 2;
  const right = wall.x + wall.width / 2;
  const top = wall.y - wall.height / 2;
  const bottom = wall.y + wall.height / 2;
  const horizontal = wall.width >= wall.height;
  const vertical = wall.height >= wall.width;

  return (
    (horizontal && (top <= 10 || bottom >= map.height - 10)) ||
    (vertical && (left <= 10 || right >= map.width - 10))
  );
};

export const shouldStartFreshQuickPlayAfterReconnect = (
  joinMode: JoinMode,
  matchState: MatchState,
  self: Pick<ClientPlayer, "isAlive" | "isSpectator"> | undefined
): boolean =>
  joinMode === "quick" &&
  !isWaitingRoomState(matchState) &&
  Boolean(self && (!self.isAlive || self.isSpectator));

export const shouldAutoReconnectOnPageLoad = (joinMode: JoinMode | undefined): boolean =>
  joinMode !== undefined && joinMode !== "quick";

export const shouldShowIphoneStandaloneHint = (
  userAgent: string,
  displayModeStandalone: boolean,
  legacyStandalone: boolean
): boolean =>
  /iPhone|iPod/.test(userAgent) && !displayModeStandalone && !legacyStandalone;

export const endpointFromEnv = (): string => {
  const configured = import.meta.env.VITE_WS_URL;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  if (typeof window !== "undefined" && window.location.host) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (window.location.port === "5173" || window.location.port === "4173") {
      return `${protocol}//${window.location.hostname}:2567`;
    }
    return `${protocol}//${window.location.host}`;
  }
  return "ws://localhost:2567";
};

export const httpEndpointFromEnv = (wsEndpoint = endpointFromEnv()): string => {
  const configured = import.meta.env.VITE_HTTP_API_URL;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim().replace(/\/$/, "");
  }

  try {
    const url = new URL(wsEndpoint);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "http://localhost:2567";
  }
};

export const fallbackMapConfig = (seed = "local"): ArenaMapConfig => {
  const outerThickness = 72;
  const halfW = DEFAULT_MAP_WIDTH / 2;
  const halfH = DEFAULT_MAP_HEIGHT / 2;
  const centeredWalls: ArenaWall[] = [
    { id: "outer-n", x: 0, y: -halfH + outerThickness / 2, width: DEFAULT_MAP_WIDTH, height: outerThickness, depth: WALL_DEPTH },
    { id: "outer-s", x: 0, y: halfH - outerThickness / 2, width: DEFAULT_MAP_WIDTH, height: outerThickness, depth: WALL_DEPTH },
    { id: "outer-w", x: -halfW + outerThickness / 2, y: 0, width: outerThickness, height: DEFAULT_MAP_HEIGHT, depth: WALL_DEPTH },
    { id: "outer-e", x: halfW - outerThickness / 2, y: 0, width: outerThickness, height: DEFAULT_MAP_HEIGHT, depth: WALL_DEPTH },
    { id: "block-nw", x: -555, y: -338, width: 300, height: 80, depth: WALL_DEPTH },
    { id: "block-ne", x: 455, y: -330, width: 92, height: 326, depth: WALL_DEPTH },
    { id: "block-sw", x: -470, y: 305, width: 96, height: 280, depth: WALL_DEPTH },
    { id: "block-se", x: 488, y: 330, width: 360, height: 84, depth: WALL_DEPTH },
    { id: "maze-left-a", x: -240, y: -126, width: 88, height: 438, depth: WALL_DEPTH },
    { id: "maze-left-b", x: -128, y: -304, width: 308, height: 78, depth: WALL_DEPTH },
    { id: "maze-mid", x: 40, y: 88, width: 86, height: 314, depth: WALL_DEPTH },
    { id: "maze-right-a", x: 290, y: -86, width: 310, height: 78, depth: WALL_DEPTH },
    { id: "cover-1", x: -612, y: 96, width: 100, height: 100, depth: 88 },
    { id: "cover-2", x: -70, y: 338, width: 104, height: 104, depth: 88 },
    { id: "cover-3", x: 228, y: -398, width: 104, height: 104, depth: 88 },
    { id: "cover-4", x: 614, y: 74, width: 104, height: 104, depth: 88 }
  ];
  const walls = centeredWalls.map((wall) => ({
    ...wall,
    x: wall.x + halfW,
    y: wall.y + halfH
  }));
  const centeredSpawns = [
    { id: "spawn-w", x: -720, y: 0 },
    { id: "spawn-e", x: 720, y: 0 },
    { id: "spawn-n", x: 0, y: -460 },
    { id: "spawn-s", x: 0, y: 460 },
    { id: "spawn-nw", x: -650, y: -420 },
    { id: "spawn-se", x: 650, y: 420 },
    { id: "spawn-ne", x: 650, y: -420 },
    { id: "spawn-sw", x: -650, y: 420 }
  ];

  return {
    id: `fallback-${seed}`,
    source: "fallback",
    width: DEFAULT_MAP_WIDTH,
    height: DEFAULT_MAP_HEIGHT,
    walls,
    weather: {
      kind: "clear",
      intensity: 0,
      seed: `${seed}:weather`
    },
    spawns: centeredSpawns.map((spawn) => ({
      ...spawn,
      x: spawn.x + halfW,
      y: spawn.y + halfH
    }))
  };
};

const wallFromRecord = (record: UnknownRecord, index: number): ArenaWall | undefined => {
  const rect = isRecord(record.rect) ? record.rect : record;
  const position = isRecord(record.position) ? record.position : {};
  const size = isRecord(record.size) ? record.size : {};
  const width = numberValue(rect.width) ?? numberValue(rect.w) ?? numberValue(size.width) ?? numberValue(size.x);
  const height = numberValue(rect.height) ?? numberValue(rect.h) ?? numberValue(size.height) ?? numberValue(size.y);
  const rawX =
    numberValue(rect.x) ??
    numberValue(rect.centerX) ??
    numberValue(position.x) ??
    numberValue(rect.left);
  const rawY =
    numberValue(rect.y) ??
    numberValue(rect.centerY) ??
    numberValue(position.y) ??
    numberValue(position.z) ??
    numberValue(rect.top);

  if (width === undefined || height === undefined || rawX === undefined || rawY === undefined) return undefined;

  const isTopLeftRect =
    typeof record.kind === "string" ||
    stringValue(record.id)?.startsWith("wall-") ||
    stringValue(record.id)?.startsWith("collision-") ||
    rect.left !== undefined ||
    rect.top !== undefined;
  const x = isTopLeftRect ? rawX + width / 2 : rawX;
  const y = isTopLeftRect ? rawY + height / 2 : rawY;

  return {
    id: stringValue(record.id) ?? stringValue(record.key) ?? `server-wall-${index}`,
    x,
    y,
    width: Math.max(8, width),
    height: Math.max(8, height),
    depth: Math.max(24, numberValue(record.depth) ?? numberValue(record.z) ?? WALL_DEPTH)
  };
};

const wallFromArray = (value: unknown[], index: number): ArenaWall | undefined => {
  const x = numberValue(value[0]);
  const y = numberValue(value[1]);
  const width = numberValue(value[2]);
  const height = numberValue(value[3]);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  return { id: `server-wall-${index}`, x, y, width, height, depth: WALL_DEPTH };
};

const spawnFromValue = (value: unknown, index: number): ArenaSpawn | undefined => {
  if (Array.isArray(value)) {
    const x = numberValue(value[0]);
    const y = numberValue(value[1]);
    return x === undefined || y === undefined ? undefined : { id: `server-spawn-${index}`, x, y };
  }
  if (!isRecord(value)) return undefined;
  const position = isRecord(value.position) ? value.position : value;
  const x = numberValue(position.x);
  const y = numberValue(position.y) ?? numberValue(position.z);
  return x === undefined || y === undefined
    ? undefined
    : { id: stringValue(value.id) ?? `server-spawn-${index}`, x, y };
};

const weatherFromValue = (value: unknown, seed = "alpha7"): ArenaWeatherConfig => {
  if (!isRecord(value)) {
    return { kind: "clear", intensity: 0, seed: `${seed}:weather` };
  }
  const kind = value.kind === "rain" ? "rain" : "clear";
  const intensity = kind === "rain" ? clamp(numberValue(value.intensity) ?? 0.7, 0, 1) : 0;
  return {
    kind,
    intensity,
    seed: stringValue(value.seed) ?? `${seed}:weather`
  };
};

const parseMapConfigUncached = (raw: unknown, seed?: string): ArenaMapConfig => {
  const fallback = fallbackMapConfig(seed);
  const parsed = typeof raw === "string" && raw.trim() ? safeJson(raw) : raw;
  if (!isRecord(parsed)) return fallback;

  const size = isRecord(parsed.size) ? parsed.size : {};
  const width = numberValue(parsed.width) ?? numberValue(parsed.arenaWidth) ?? numberValue(size.width);
  const height = numberValue(parsed.height) ?? numberValue(parsed.arenaHeight) ?? numberValue(size.height);
  const wallsRaw = Array.isArray(parsed.walls)
    ? parsed.walls
    : Array.isArray(parsed.wallRects)
      ? parsed.wallRects
      : Array.isArray(parsed.collisionRects)
        ? parsed.collisionRects
    : Array.isArray(parsed.obstacles)
      ? parsed.obstacles
      : [];

  const walls = wallsRaw
    .map((wall, index) =>
      Array.isArray(wall) ? wallFromArray(wall, index) : isRecord(wall) ? wallFromRecord(wall, index) : undefined
    )
    .filter((wall): wall is ArenaWall => Boolean(wall));

  if (width === undefined || height === undefined || walls.length === 0) return fallback;

  const spawnsRaw = Array.isArray(parsed.spawns)
    ? parsed.spawns
    : Array.isArray(parsed.spawnPoints)
      ? parsed.spawnPoints
      : [];
  const spawns = spawnsRaw
    .map((spawn, index) => spawnFromValue(spawn, index))
    .filter((spawn): spawn is ArenaSpawn => Boolean(spawn));

  return {
    id: stringValue(parsed.id) ?? stringValue(parsed.name) ?? `server-${seed ?? "arena"}`,
    source: "server",
    width,
    height,
    walls,
    weather: weatherFromValue(parsed.weather, seed ?? stringValue(parsed.seed) ?? stringValue(parsed.id) ?? "alpha7"),
    spawns: spawns.length > 0 ? spawns : fallback.spawns
  };
};

let parsedMapCache: { raw: string; seed: string | undefined; map: ArenaMapConfig } | null = null;

export const parseMapConfig = (raw: unknown, seed?: string): ArenaMapConfig => {
  if (typeof raw !== "string") return parseMapConfigUncached(raw, seed);
  if (parsedMapCache?.raw === raw && parsedMapCache.seed === seed) return parsedMapCache.map;
  const map = parseMapConfigUncached(raw, seed);
  parsedMapCache = { raw, seed, map };
  return map;
};

const safeJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const snapshotPlayer = (player: PlayerSchema, selfSessionId?: string): ClientPlayer => ({
  id: player.id || player.sessionId,
  sessionId: player.sessionId,
  ownerId: player.ownerId,
  pairId: player.pairId,
  controlKind: player.controlKind,
  name: player.name,
  archetypeId: tankArchetype(player.archetypeId),
  weaponType: weaponType(player.weaponType),
  abilityType: abilityType(player.abilityType),
  x: player.x,
  y: player.y,
  rotation: player.rotation,
  turretRotation: player.turretRotation,
  velocityX: player.velocityX,
  velocityY: player.velocityY,
  speedMultiplier: player.speedMultiplier,
  health: player.health,
  maxHealth: player.maxHealth,
  armor: player.armor,
  maxArmor: player.maxArmor,
  shield: player.shield,
  ammo: player.ammo,
  abilityCharge: player.abilityCharge,
  fireCooldownMs: player.fireCooldownMs,
  abilityCooldownMs: player.abilityCooldownMs,
  lastAbilityType: abilityType(player.lastAbilityType),
  lastAbilityAt: player.lastAbilityAt,
  lastAbilityEndsAt: player.lastAbilityEndsAt,
  lastAbilityX: player.lastAbilityX,
  lastAbilityY: player.lastAbilityY,
  smokeActivatedAt: player.smokeActivatedAt,
  smokeEndsAt: player.smokeEndsAt,
  smokeX: player.smokeX,
  smokeY: player.smokeY,
  score: player.score,
  kills: player.kills,
  deaths: player.deaths,
  damageDealt: player.damageDealt,
  damageTaken: player.damageTaken,
  placement: player.placement,
  survivalTimeMs: player.survivalTimeMs,
  teamPlacement: player.teamPlacement,
  teamKills: player.teamKills,
  joinedAt: player.joinedAt,
  respawnAt: player.respawnAt,
  isConnected: player.isConnected,
  isReady: player.isReady,
  isAlive: player.isAlive,
  isSpectator: player.isSpectator,
  isHost: player.isHost,
  isSelf: player.sessionId === selfSessionId
});

const snapshotProjectile = (projectile: ProjectileSchema): ClientProjectile => ({
  id: projectile.id,
  ownerId: projectile.ownerId,
  fireSequence: projectile.fireSequence,
  weaponType: weaponType(projectile.weaponType),
  x: projectile.x,
  y: projectile.y,
  velocityX: projectile.velocityX,
  velocityY: projectile.velocityY,
  rotation: projectile.rotation,
  radius: projectile.radius,
  expiresAt: projectile.expiresAt
});

const snapshotPickup = (pickup: PickupSchema): ClientPickup => ({
  id: pickup.id,
  pickupType: pickup.pickupType,
  x: pickup.x,
  y: pickup.y,
  radius: pickup.radius,
  isActive: pickup.isActive
});

export const snapshotFromState = (
  state: Alpha7StateSchema,
  roomId: string,
  selfSessionId?: string
): ClientSnapshot => {
  const receivedAt = Date.now();
  const extendedState = state as StateWithOptionalMap;
  const players = Array.from(state.players.values()).map((player) =>
    snapshotPlayer(player, selfSessionId)
  );
  const self = players.find((player) => player.isSelf) ?? null;
  const owners = Array.from(state.owners.values()).map((owner) => ({
    ownerId: owner.ownerId,
    humanSessionId: owner.humanSessionId,
    displayName: owner.displayName,
    agentSeatId: owner.agentSeatId,
    agentLabel: owner.agentLabel,
    agentSeatState: owner.agentSeatState,
    agentPairingExpiresAtMs: owner.agentPairingExpiresAtMs,
    isConnected: owner.isConnected,
    isReady: owner.isReady,
    isHost: owner.isHost
  }));

  return {
    roomId,
    roomCode: state.roomCode || roomId,
    matchId: state.match.matchId,
    matchState: state.matchState,
    seed: state.seed,
    tick: state.match.tick,
    alivePlayers: state.match.alivePlayers,
    countdownEndsAt: state.match.countdownEndsAt,
    matchEndsAt: state.match.matchEndsAt,
    stateStartedAt: state.match.stateStartedAt,
    serverTimeOffsetMs: state.serverTime > 0 ? state.serverTime - receivedAt : 0,
    policy: {
      mode: state.policy.mode,
      ownerCap: state.policy.ownerCap,
      humanWsCap: state.policy.humanWsCap,
      agentControlCap: state.policy.agentControlCap,
      combatantCap: state.policy.combatantCap
    },
    zone: {
      x: state.zone.x,
      y: state.zone.y,
      radius: state.zone.radius,
      targetX: state.zone.targetX,
      targetY: state.zone.targetY,
      targetRadius: state.zone.targetRadius,
      damagePerSecond: state.zone.damagePerSecond
    },
    players,
    owners,
    self,
    projectiles: Array.from(state.projectiles.values()).map(snapshotProjectile),
    pickups: Array.from(state.pickups.values()).map(snapshotPickup),
    map: parseMapConfig(
      extendedState.arenaConfigJson ?? extendedState.mapConfig,
      state.seed
    )
  };
};

export const previewSnapshot = (
  selectedTank: TankArchetypeId,
  playerName: string,
  seed = "preview"
): ClientSnapshot => {
  const config = TANK_ARCHETYPE_CONFIG[selectedTank];
  const map = fallbackMapConfig(seed);
  const spawn = { x: map.width / 2 - 72, y: map.height / 2 - 80 };
  const player: ClientPlayer = {
    id: "local-preview",
    sessionId: "local-preview",
    ownerId: "local-preview",
    pairId: "local-preview",
    controlKind: "human",
    name: playerName.trim() || "Operator",
    archetypeId: selectedTank,
    weaponType: config.primaryWeapon,
    abilityType: config.ability,
    x: spawn.x,
    y: spawn.y,
    rotation: 0,
    turretRotation: 0,
    velocityX: 0,
    velocityY: 0,
    speedMultiplier: 1,
    health: config.maxHealth,
    maxHealth: config.maxHealth,
    armor: config.maxArmor,
    maxArmor: config.maxArmor,
    shield: 0,
    ammo: 24,
    abilityCharge: 65,
    fireCooldownMs: 0,
    abilityCooldownMs: 0,
    lastAbilityType: config.ability,
    lastAbilityAt: 0,
    lastAbilityEndsAt: 0,
    lastAbilityX: spawn.x,
    lastAbilityY: spawn.y,
    smokeActivatedAt: 0,
    smokeEndsAt: 0,
    smokeX: spawn.x,
    smokeY: spawn.y,
    score: 0,
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    damageTaken: 0,
    placement: 0,
    survivalTimeMs: 0,
    teamPlacement: 0,
    teamKills: 0,
    joinedAt: Date.now(),
    respawnAt: 0,
    isConnected: true,
    isReady: false,
    isAlive: true,
    isSpectator: false,
    isHost: true,
    isSelf: true
  };

  return {
    roomId: "local",
    roomCode: "LOCAL",
    matchId: "preview-match",
    matchState: "waiting",
    seed,
    tick: 0,
    alivePlayers: 1,
    countdownEndsAt: 0,
    matchEndsAt: 0,
    stateStartedAt: Date.now(),
    serverTimeOffsetMs: 0,
    policy: {
      mode: "classic",
      ownerCap: 8,
      humanWsCap: 8,
      agentControlCap: 0,
      combatantCap: 8
    },
    zone: {
      x: 0,
      y: 0,
      radius: 0,
      targetX: 0,
      targetY: 0,
      targetRadius: 0,
      damagePerSecond: 0
    },
    players: [player],
    owners: [{
      ownerId: player.ownerId,
      humanSessionId: player.sessionId,
      displayName: player.name,
      agentSeatId: "",
      agentLabel: "",
      agentSeatState: "none",
      agentPairingExpiresAtMs: 0,
      isConnected: true,
      isReady: false,
      isHost: true
    }],
    self: player,
    projectiles: [],
    pickups: [],
    map
  };
};

const scenarioPickupTypes: PickupType[] = [
  "health_repair",
  "shield_armor",
  "ammo_rapid_fire",
  "speed_boost",
  "ability_charge",
  "smoke",
  "barrage_explosive"
];

const buildScenarioPlayer = (
  index: number,
  map: ArenaMapConfig,
  selectedTank: TankArchetypeId,
  playerName: string,
  matchState: MatchState,
  now: number
): ClientPlayer => {
  const archetypeId: TankArchetypeId =
    index === 0 ? selectedTank : (TANK_ARCHETYPES[index % TANK_ARCHETYPES.length] ?? DEFAULT_TANK_ARCHETYPE);
  const config = TANK_ARCHETYPE_CONFIG[archetypeId];
  const spawn = map.spawns[index % map.spawns.length] ?? { x: map.width / 2, y: map.height / 2 };
  const isFinished = matchState === "finished";
  const isSelf = index === 0;
  return {
    id: `scenario-player-${index + 1}`,
    sessionId: `scenario-player-${index + 1}`,
    ownerId: `scenario-owner-${index + 1}`,
    pairId: `scenario-owner-${index + 1}`,
    controlKind: "human",
    name: isSelf ? playerName.trim() || "Operator" : `HUD Bot ${index}`,
    archetypeId,
    weaponType: config.primaryWeapon,
    abilityType: config.ability,
    x: isSelf && matchState === "danger" ? map.width / 2 + 430 : spawn.x,
    y: isSelf && matchState === "danger" ? map.height / 2 + 12 : spawn.y,
    rotation: index * 0.55,
    turretRotation: index * 0.55 + 0.15,
    velocityX: 0,
    velocityY: 0,
    speedMultiplier: 1,
    health: isFinished && !isSelf ? 0 : Math.max(1, config.maxHealth - index * 9),
    maxHealth: config.maxHealth,
    armor: isFinished && !isSelf ? 0 : Math.max(0, config.maxArmor - index * 3),
    maxArmor: config.maxArmor,
    shield: isSelf ? 24 : 0,
    ammo: Math.max(0, 24 - index),
    abilityCharge: isSelf ? 100 : Math.max(0, 72 - index * 6),
    fireCooldownMs: 0,
    abilityCooldownMs: 0,
    lastAbilityType: config.ability,
    lastAbilityAt: 0,
    lastAbilityEndsAt: 0,
    lastAbilityX: spawn.x,
    lastAbilityY: spawn.y,
    smokeActivatedAt: 0,
    smokeEndsAt: 0,
    smokeX: spawn.x,
    smokeY: spawn.y,
    score: Math.max(0, 80 - index * 9),
    kills: isSelf ? 1 : Math.max(0, 3 - index),
    deaths: isFinished && !isSelf ? 1 : 0,
    damageDealt: isSelf ? 180 : Math.max(0, 120 - index * 12),
    damageTaken: index * 18,
    placement: isFinished ? index + 1 : 0,
    survivalTimeMs: Math.max(0, now - (now - 128000 - index * 8000)),
    teamPlacement: 0,
    teamKills: 0,
    joinedAt: now - 180000 - index * 4000,
    respawnAt: 0,
    isConnected: true,
    isReady: isSelf || index % 3 !== 0,
    isAlive: !isFinished || isSelf,
    isSpectator: isFinished && !isSelf,
    isHost: isSelf,
    isSelf
  };
};

export const buildHudScenarioSnapshot = (
  scenario: HudScenario,
  selectedTank: TankArchetypeId,
  playerName: string,
  now = Date.now(),
  abilityOverride?: AbilityType | null,
  shieldOverride?: number | null
): ClientSnapshot => {
  const map = fallbackMapConfig(`hud-${scenario}`);
  map.weather =
    scenario === "danger"
      ? { kind: "rain", intensity: 0.78, seed: `hud-${scenario}:rain` }
      : { ...map.weather, seed: `hud-${scenario}:weather` };

  const matchState: MatchState =
    scenario === "lobby" || scenario === "lobby8"
      ? "waiting"
      : scenario === "results8"
        ? "finished"
        : scenario === "danger"
          ? "danger"
          : "running";
  const playerCount = scenario === "lobby8" || scenario === "results8" ? 8 : scenario === "spectator" ? 4 : 2;
  const players = Array.from({ length: playerCount }, (_, index) =>
    buildScenarioPlayer(index, map, selectedTank, playerName, matchState, now)
  );
  const self = players[0] ?? null;
  if (self && scenario === "gameplay") {
    self.x = map.width / 2 - 120;
    self.y = map.height / 2 + 160;
  }
  if (self && scenario === "spectator") {
    self.health = 0;
    self.armor = 0;
    self.isAlive = false;
    self.isSpectator = true;
    self.placement = playerCount;
  }
  if (self && abilityOverride) self.abilityType = abilityOverride;
  if (self && shieldOverride !== null && shieldOverride !== undefined) self.shield = shieldOverride;
  const zoneRadius = scenario === "danger" ? 260 : 820;

  return {
    roomId: `hud-${scenario}`,
    roomCode:
      scenario === "results8"
        ? "RESULTS8"
        : scenario === "danger"
          ? "DANGER"
          : scenario === "spectator"
            ? "SPECTATE"
            : "HUDROOM",
    matchId: `hud-${scenario}-match`,
    matchState,
    seed: `hud-${scenario}`,
    tick: Math.floor(now / 50),
    alivePlayers: players.filter((player) => player.isAlive).length,
    countdownEndsAt: 0,
    matchEndsAt: isActiveMatchState(matchState) ? now + (scenario === "danger" ? 72000 : 198000) : 0,
    stateStartedAt: now - 42000,
    serverTimeOffsetMs: 0,
    policy: {
      mode: "classic",
      ownerCap: 8,
      humanWsCap: 8,
      agentControlCap: 0,
      combatantCap: 8
    },
    zone: {
      x: map.width / 2,
      y: map.height / 2,
      radius: zoneRadius,
      targetX: map.width / 2 + 40,
      targetY: map.height / 2 - 24,
      targetRadius: Math.max(128, zoneRadius - 120),
      damagePerSecond: scenario === "danger" ? 8 : 0
    },
    players,
    owners: players.map((player) => ({
      ownerId: player.ownerId,
      humanSessionId: player.sessionId,
      displayName: player.name,
      agentSeatId: "",
      agentLabel: "",
      agentSeatState: "none",
      agentPairingExpiresAtMs: 0,
      isConnected: player.isConnected,
      isReady: player.isReady,
      isHost: player.isHost
    })),
    self,
    projectiles:
      scenario === "gameplay"
        ? [
            {
              id: "hud-projectile-1",
              ownerId: self?.sessionId ?? "scenario-player-1",
              fireSequence: 1,
              weaponType: self?.weaponType ?? TANK_ARCHETYPE_CONFIG[selectedTank].primaryWeapon,
              x: map.width / 2 + 180,
              y: map.height / 2,
              velocityX: 420,
              velocityY: -80,
              rotation: -0.18,
              radius: 8,
              expiresAt: now + 1400
            }
          ]
        : [],
    pickups: scenarioPickupTypes.map((pickupType, index) => ({
      id: `hud-pickup-${index + 1}`,
      pickupType,
      x: map.width / 2 - 360 + index * 120,
      y: map.height / 2 + (index % 2 === 0 ? -250 : 250),
      radius: 22,
      isActive: true
    })),
    map
  };
};
