import { EventEmitter } from "node:events";
import { CloseCode, ErrorCode, ServerError, type Client } from "colyseus";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ABILITY_CONFIG,
  type ArenaConfig,
  type ArenaRect,
  BATTLE_ROYALE_ROOM,
  PICKUP_CONFIG,
  SERVER_MESSAGE_TYPES,
  TANK_ARCHETYPES,
  TANK_ARCHETYPE_CONFIG,
  TANK_COLLISION_RADIUS,
  AGENT_TACTICAL_INTENT_MAX_DURATION_MS,
  AGENT_TACTICAL_ZONE_SAFETY_MARGIN,
  WEAPON_CONFIG,
  generateArenaConfig,
  isAgentTacticalStatusV1,
  isWallCollision,
  type AgentTacticalIntentV1
} from "@alpha7/shared";
import { PickupSchema, PlayerSchema, ProjectileSchema } from "@alpha7/shared/schema";
import { agentBroker, type AgentBrokerSession } from "../agentBroker.js";
import type { ServerConfig } from "../config.js";
import { createHumanAdmission } from "../humanAdmission.js";
import { BattleRoyaleRoom } from "./BattleRoyaleRoom.js";

type RoomInternals = {
  handleAbilityMessage(client: Client, payload: unknown): void;
  handleAgentPairingCreate(client: Client, payload: unknown): void;
  handleAgentPairingCancel(client: Client, payload: unknown): void;
  handleAgentControl(client: Client, payload: unknown): void;
  handleFireMessage(client: Client, payload: unknown): void;
  handleInputMessage(client: Client, payload: unknown): void;
  handleJoinMessage(client: Client, payload: unknown): void;
  handleReadyMessage(client: Client, payload: unknown): void;
  handleRematchMessage(client: Client, payload: unknown): void;
  handleStartMessage(client: Client, payload: unknown): void;
  applyPlayerMovement(
    arena: ArenaConfig,
    player: PlayerSchema,
    intent: { moveX: number; moveY: number; aimX?: number; aimY?: number },
    deltaSeconds: number,
    now: number
  ): void;
  advanceTimedLifecycle(now: number): void;
  onSimulationTick(deltaTime: number): void;
  runAgentExecutors(now: number): void;
  resetForRematch(now: number): void;
  checkForMatchConclusion(now: number): void;
  applyDamage(
    target: PlayerSchema,
    source: PlayerSchema | undefined,
    rawDamage: number,
    now: number
  ): number;
  fireIntents: Map<string, unknown>;
  abilityIntents: Map<string, unknown>;
  inputIntents: Map<string, unknown>;
  rematchVotes: Map<string, unknown>;
  speedEffects: Map<string, { multiplier: number; expiresAt: number }>;
  agentPairingRequests: Map<string, string>;
  agentRuntimes: Map<string, {
    idleDeadlineMs?: number;
    lease?: {
      expiresAtMs?: number;
      waypointIndex?: number;
      tacticalContinuation?: { moveX: number; moveY: number };
      tacticalRetreat?: boolean;
      tacticalApproach?: boolean;
      tacticalZoneRecovery?: boolean;
      tacticalZoneTarget?: { x: number; z: number; radius: number };
      action?: {
        actionSeq?: number;
        fire?: string;
        useAbility?: false | "once";
        targetId?: string;
        waypoints?: Array<{ x: number; z: number }>;
      };
    };
    tactical?: {
      intent?: AgentTacticalIntentV1;
      roundId?: string;
      expiresAtMs?: number;
      selectedTargetId?: string;
    };
    lastReflexAtMs?: number;
  }>;
  arena?: ArenaConfig;
  tacticalRouteStep(
    player: PlayerSchema,
    destination: { x: number; z: number },
    allowDetour?: boolean,
    routeZone?: { x: number; z: number; radius: number },
    avoidanceCircle?: { x: number; z: number; radius: number }
  ): { waypoints: Array<{ x: number; z: number }> } | undefined;
  tacticalZoneRecoveryRoute(
    player: PlayerSchema,
    zoneCenter: { x: number; z: number },
    target?: { x: number; z: number; radius?: number },
    allowTargetBlockerClearance?: boolean
  ): { waypoints: Array<{ x: number; z: number }> } | undefined;
  agentTacticalSurvivalZone(player: PlayerSchema, now: number): {
    x: number;
    z: number;
    radius: number;
    safeRadius: number;
  };
  validAgentLocalRoute(player: PlayerSchema, point: { x: number; z: number }): boolean;
  validAgentMovementHorizon(
    player: PlayerSchema,
    point: { x: number; z: number },
    isAllowed?: (state: { x: number; y: number }) => boolean
  ): boolean;
  firstTacticalMovementBlocker(
    player: PlayerSchema,
    input: { moveX: number; moveY: number },
    now: number
  ): PlayerSchema | undefined;
  canAcceptActiveJoin(): boolean;
  debugAgentAuditSnapshot(): Array<Record<string, unknown>>;
};

type ReconnectableRoom = BattleRoyaleRoom & {
  allowReconnection(client: Client, seconds: number | "manual"): Promise<Client>;
};

interface TestArenaPoint {
  x: number;
  y: number;
  rotation?: number;
  radius?: number;
}

interface TestArenaWall {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TestArenaConfig {
  seed: string;
  width?: number;
  height?: number;
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | undefined;
  spawnPoints: TestArenaPoint[];
  pickupPoints?: TestArenaPoint[];
  pickupPlacements?: TestArenaPoint[];
  zonePhases: unknown[];
  walls?: TestArenaWall[];
  collisionRects?: TestArenaWall[];
}

const TACTICAL_OPENING: AgentTacticalIntentV1 = {
  version: 1,
  intentSeq: 1,
  basedOnObservationSeq: null,
  validForMs: AGENT_TACTICAL_INTENT_MAX_DURATION_MS,
  objective: { type: "engage_nearest" },
  fire: "hold",
  useAbility: false,
  fallback: "hold"
};

interface TestClient {
  client: Client;
  send: ReturnType<typeof vi.fn>;
}

interface TestRoom {
  room: BattleRoyaleRoom;
  rawOnJoin: (client: Client) => void;
  internals: RoomInternals;
  metadata: Record<string, unknown>;
  privateValue?: boolean;
  lock: ReturnType<typeof vi.fn>;
  unlock: ReturnType<typeof vi.fn>;
  setTimestep: ReturnType<typeof vi.fn>;
}

const testConfig: ServerConfig = {
  port: 2567,
  nodeEnv: "test",
  allowedOrigins: ["http://localhost:5173"],
  publicClientUrl: "http://localhost:5173",
  publicServerUrl: "http://localhost:2567",
  demoMaxPlayers: 4,
  roomTickRate: 30,
  roomPatchRate: 20,
  roomAutoStartSeconds: 12,
  enableCapacityMetrics: false,
  agentPlayEnabled: true,
  agentTacticalReflexEnabled: true,
  agentExpandedCombatantsEnabled: false,
  agentCupMaxControlsEnabled: false,
  logLevel: "silent",
  buildVersion: "test"
};

const rooms: BattleRoyaleRoom[] = [];
const brokerCredentials = new Map<string, string>();
let roomCounter = 0;
const TEST_TANK_RADIUS = TANK_COLLISION_RADIUS;
const distanceFromPointToSegment = (
  point: { x: number; z: number },
  start: { x: number; z: number },
  end: { x: number; z: number }
): number => {
  const segmentX = end.x - start.x;
  const segmentZ = end.z - start.z;
  const segmentLengthSquared = segmentX ** 2 + segmentZ ** 2;
  const fraction = segmentLengthSquared > 0
    ? Math.max(0, Math.min(1, (
        (point.x - start.x) * segmentX + (point.z - start.z) * segmentZ
      ) / segmentLengthSquared))
    : 0;
  return Math.hypot(
    point.x - (start.x + segmentX * fraction),
    point.z - (start.z + segmentZ * fraction)
  );
};

const makeClient = (sessionId: string): TestClient => {
  const send = vi.fn();
  const client = {
    sessionId,
    state: 1,
    ref: new EventEmitter(),
    send: send as unknown as Client["send"],
    sendBytes: vi.fn(),
    raw: vi.fn(),
    enqueueRaw: vi.fn(),
    leave: vi.fn(),
    close: vi.fn(),
    error: vi.fn(),
    reconnectionToken: ""
  } as unknown as Client;

  return { client, send };
};

const makeRoom = async (
  options: Partial<Parameters<BattleRoyaleRoom["onCreate"]>[0]> = {}
): Promise<TestRoom> => {
  const room = new BattleRoyaleRoom();
  const metadata: Record<string, unknown> = {};
  let privateValue: boolean | undefined;

  room.roomId = "ROOM123";
  const lock = vi.fn(async () => undefined);
  const unlock = vi.fn(async () => undefined);
  const setTimestep = vi.fn();

  vi.spyOn(room, "setPrivate").mockImplementation(async (value = true) => {
    privateValue = value;
  });
  vi.spyOn(room, "setMetadata").mockImplementation(async (nextMetadata) => {
    for (const key of Object.keys(metadata)) delete metadata[key];
    Object.assign(metadata, nextMetadata);
  });
  vi.spyOn(room, "setTimestep").mockImplementation(setTimestep);
  vi.spyOn(room, "lock").mockImplementation(lock);
  vi.spyOn(room, "unlock").mockImplementation(unlock);
  vi.spyOn(room, "broadcast").mockImplementation(() => undefined);

  await room.onCreate({
    config: testConfig,
    ...options
  });
  const roomSourceKey = `test-room:${++roomCounter}`;
  const rawOnJoin = room.onJoin.bind(room) as unknown as (client: Client) => void;
  room.onJoin = ((client: Client, joinOptions: unknown) => {
    client.auth = createHumanAdmission(joinOptions, roomSourceKey).principal;
    rawOnJoin(client);
  }) as typeof room.onJoin;

  rooms.push(room);
  return {
    room,
    rawOnJoin,
    internals: room as unknown as RoomInternals,
    metadata,
    privateValue,
    lock,
    unlock,
    setTimestep
  };
};

const readArenaConfig = (room: BattleRoyaleRoom): TestArenaConfig => {
  const state = room.state as typeof room.state & {
    arenaConfigJson?: string;
  };
  const arenaConfigJson = state.arenaConfigJson;
  expect(arenaConfigJson).toEqual(expect.any(String));
  return JSON.parse(arenaConfigJson ?? "{}") as TestArenaConfig;
};

const pairAgent = async (
  room: BattleRoyaleRoom,
  internals: RoomInternals,
  ownerClient: TestClient,
  label: string,
  controlMode: "macro_v1" | "tactical_reflex_v1" = "macro_v1",
  openingTactic: AgentTacticalIntentV1 = TACTICAL_OPENING
): Promise<AgentBrokerSession> => {
  internals.handleAgentPairingCreate(ownerClient.client, {
    agentLabel: label,
    controlMode,
    ...(controlMode === "tactical_reflex_v1" ? { openingTactic } : {})
  });
  const result = ownerClient.send.mock.calls
    .filter(([type]) => type === SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT)
    .at(-1)?.[1] as { pairingCode?: string; expiresAtMs?: number } | undefined;
  expect(result?.pairingCode).toEqual(expect.any(String));
  const ownerId = room.state.players.get(ownerClient.client.sessionId)?.ownerId ?? "";
  const owner = room.state.owners.get(ownerId);
  expect(owner?.agentPairingExpiresAtMs).toBe(result?.expiresAtMs);
  const code = JSON.parse(result?.pairingCode ?? "{}") as {
    version?: number;
    roomId?: string;
    grant?: string;
  };
  expect(Object.keys(code).sort()).toEqual(["grant", "roomId", "version"]);
  expect(code.version).toBe(controlMode === "macro_v1" ? 1 : 2);
  expect(code.roomId).toBe(room.roomId);
  expect(code.grant).toEqual(expect.any(String));
  const consumed = await agentBroker.consumeGrant(
    {
      roomId: room.roomId,
      grantCredential: code.grant ?? "",
      sourceKey: `test:${label}`
    },
    (principal) => room.agentMaterialize(principal)
  );
  expect(consumed.materialized).not.toHaveProperty("seed");
  brokerCredentials.set(consumed.session.principal.seatId, consumed.brokerCredential);
  expect(owner?.agentPairingExpiresAtMs).toBe(0);
  return consumed.session;
};

const beginMaterializationRace = async (
  agentLabel: string,
  sourceKey: string,
  roomMode: "wingman" | "open_ffa" = "wingman"
) => {
  const baselineActiveControls = agentBroker.activeControlCount;
  const baselinePendingGrants = agentBroker.pendingGrantCount;
  const { room, internals } = await makeRoom({ roomMode });
  const host = makeClient("host1");
  room.onJoin(host.client, { playerName: "Host", archetypeId: "quill" });
  const ownerId = room.state.players.get(host.client.sessionId)?.ownerId ?? "";
  internals.handleAgentPairingCreate(host.client, { agentLabel });
  const pairingResult = host.send.mock.calls
    .filter(([type]) => type === SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT)
    .at(-1)?.[1] as { pairingCode?: string } | undefined;
  const pairingCode = JSON.parse(pairingResult?.pairingCode ?? "{}") as {
    roomId?: string;
    grant?: string;
  };
  let releaseMaterialization: (() => void) | undefined;
  const materializationBarrier = new Promise<void>((resolve) => {
    releaseMaterialization = resolve;
  });
  let seatId = "";
  const consuming = agentBroker.consumeGrant(
    {
      roomId: pairingCode.roomId ?? "",
      grantCredential: pairingCode.grant ?? "",
      sourceKey
    },
    async (principal) => {
      seatId = principal.seatId;
      const descriptor = room.agentMaterialize(principal);
      await materializationBarrier;
      return descriptor;
    }
  );
  expect(seatId).not.toBe("");
  expect(internals.agentPairingRequests.size).toBe(0);
  return {
    room,
    internals,
    host,
    ownerId,
    seatId,
    consuming,
    finishMaterialization: () => releaseMaterialization?.(),
    baselineActiveControls,
    baselinePendingGrants
  };
};

const arenaBounds = (arena: TestArenaConfig): NonNullable<TestArenaConfig["bounds"]> => {
  if (arena.bounds) return arena.bounds;
  expect(arena.width).toEqual(expect.any(Number));
  expect(arena.height).toEqual(expect.any(Number));
  return {
    minX: 0,
    minY: 0,
    maxX: arena.width ?? 0,
    maxY: arena.height ?? 0
  };
};

const pickupPoints = (arena: TestArenaConfig): TestArenaPoint[] =>
  arena.pickupPlacements ?? arena.pickupPoints ?? [];

const firstInteriorWall = (arena: TestArenaConfig): TestArenaWall | undefined =>
  arena.collisionRects?.find((wall) => wall.x > TEST_TANK_RADIUS + 8 && wall.y > TEST_TANK_RADIUS + 8) ??
  arena.walls?.[0];

const wallLeft = (arena: TestArenaConfig, wall: TestArenaWall): number =>
  arena.collisionRects?.includes(wall) ? wall.x : wall.x - wall.width / 2;

const wallTop = (arena: TestArenaConfig, wall: TestArenaWall): number =>
  arena.collisionRects?.includes(wall) ? wall.y : wall.y - wall.height / 2;

const wallCenterY = (arena: TestArenaConfig, wall: TestArenaWall): number =>
  arena.collisionRects?.includes(wall) ? wall.y + wall.height / 2 : wall.y;

const findOpenDuelLine = (arena: TestArenaConfig) => {
  const bounds = arenaBounds(arena);
  const candidates = [
    { dx: 90, dy: 0 },
    { dx: -90, dy: 0 },
    { dx: 0, dy: 90 },
    { dx: 0, dy: -90 },
    { dx: 150, dy: 0 },
    { dx: 0, dy: 150 }
  ];

  for (const spawn of arena.spawnPoints) {
    for (const candidate of candidates) {
      const x = spawn.x + candidate.dx;
      const y = spawn.y + candidate.dy;
      if (
        x <= bounds.minX + TEST_TANK_RADIUS ||
        x >= bounds.maxX - TEST_TANK_RADIUS ||
        y <= bounds.minY + TEST_TANK_RADIUS ||
        y >= bounds.maxY - TEST_TANK_RADIUS
      ) {
        continue;
      }
      if (isWallCollision(arena as never, x, y, TEST_TANK_RADIUS)) continue;

      return {
        attackerX: spawn.x,
        attackerY: spawn.y,
        targetX: x,
        targetY: y
      };
    }
  }

  const fallback = arena.spawnPoints[0] ?? { x: bounds.minX + 120, y: bounds.minY + 120 };
  return {
    attackerX: fallback.x,
    attackerY: fallback.y,
    targetX: fallback.x + 90,
    targetY: fallback.y
  };
};

const findWallBlockedDuelLine = (arena: TestArenaConfig) => {
  const bounds = arenaBounds(arena);
  const walls = arena.collisionRects ?? arena.walls ?? [];
  const projectileStartClearance = TEST_TANK_RADIUS + 28;

  for (const wall of walls) {
    const left = wallLeft(arena, wall);
    const top = wallTop(arena, wall);
    const centerX = left + wall.width / 2;
    const centerY = top + wall.height / 2;

    const horizontal = {
      attackerX: left - projectileStartClearance,
      attackerY: centerY,
      targetX: left + wall.width + projectileStartClearance,
      targetY: centerY
    };
    if (
      horizontal.attackerX > bounds.minX + TEST_TANK_RADIUS &&
      horizontal.targetX < bounds.maxX - TEST_TANK_RADIUS &&
      !isWallCollision(arena as never, horizontal.attackerX, horizontal.attackerY, TEST_TANK_RADIUS) &&
      !isWallCollision(arena as never, horizontal.targetX, horizontal.targetY, TEST_TANK_RADIUS)
    ) {
      return horizontal;
    }

    const vertical = {
      attackerX: centerX,
      attackerY: top - projectileStartClearance,
      targetX: centerX,
      targetY: top + wall.height + projectileStartClearance
    };
    if (
      vertical.attackerY > bounds.minY + TEST_TANK_RADIUS &&
      vertical.targetY < bounds.maxY - TEST_TANK_RADIUS &&
      !isWallCollision(arena as never, vertical.attackerX, vertical.attackerY, TEST_TANK_RADIUS) &&
      !isWallCollision(arena as never, vertical.targetX, vertical.targetY, TEST_TANK_RADIUS)
    ) {
      return vertical;
    }
  }

  throw new Error("No wall-blocked duel line found for projectile sweep test");
};

const collisionRect = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number
): ArenaRect => ({
  id,
  x,
  y,
  width,
  height,
  kind: "collision"
});

const makeSyntheticArena = (collisionRects: ArenaRect[] = [], playerCount = 4): ArenaConfig => {
  const arena = generateArenaConfig({
    seed: "synthetic-projectile-contract",
    playerCount
  });

  return {
    ...arena,
    wallCells: [],
    wallRects: collisionRects.map((rect) => ({
      ...rect,
      id: rect.id.replace("collision", "wall"),
      kind: "wall" as const
    })),
    collisionRects,
    pockets: [],
    chokePoints: [],
    pickupPlacements: [],
    weather: {
      kind: "clear",
      intensity: 0,
      seed: "synthetic-projectile-contract:weather"
    }
  };
};

const useSyntheticArena = (
  room: BattleRoyaleRoom,
  collisionRects: ArenaRect[] = [],
  playerCount = 4
): ArenaConfig => {
  const arena = makeSyntheticArena(collisionRects, playerCount);
  (room as unknown as { arena: ArenaConfig }).arena = arena;
  const state = room.state as typeof room.state & {
    arenaConfigJson?: string;
  };
  state.arenaConfigJson = JSON.stringify(arena);
  room.state.pickups.splice(0, room.state.pickups.length);
  return arena;
};

const addProjectile = (
  room: BattleRoyaleRoom,
  fields: Partial<ProjectileSchema> & Pick<ProjectileSchema, "id" | "ownerId">
): ProjectileSchema => {
  const projectile = new ProjectileSchema();
  projectile.id = fields.id;
  projectile.ownerId = fields.ownerId;
  projectile.weaponType = fields.weaponType ?? "cannon";
  projectile.fireSequence = fields.fireSequence ?? 1;
  projectile.x = fields.x ?? 100;
  projectile.y = fields.y ?? 100;
  projectile.velocityX = fields.velocityX ?? 0;
  projectile.velocityY = fields.velocityY ?? 0;
  projectile.rotation = fields.rotation ?? 0;
  projectile.damage = fields.damage ?? WEAPON_CONFIG[projectile.weaponType].damage;
  projectile.radius = fields.radius ?? 8;
  projectile.splashRadius = fields.splashRadius ?? 0;
  projectile.spawnedAt = fields.spawnedAt ?? 0;
  projectile.expiresAt = fields.expiresAt ?? Number.MAX_SAFE_INTEGER;
  room.state.projectiles.push(projectile);
  return projectile;
};

const projectileImpactCalls = (room: BattleRoyaleRoom) =>
  (room.broadcast as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([messageType]) => messageType === SERVER_MESSAGE_TYPES.PROJECTILE_IMPACT
  );

const startSyntheticProjectileMatch = async (collisionRects: ArenaRect[] = []) => {
  const setup = await makeRoom({
    seed: "synthetic-projectile-seed"
  });
  const host = makeClient("host1");
  const guest = makeClient("guest1");

  setup.room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
  setup.room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
  setup.internals.handleStartMessage(host.client, {});
  setup.internals.advanceTimedLifecycle(setup.room.state.match.countdownEndsAt);
  useSyntheticArena(setup.room, collisionRects);

  const hostPlayer = setup.room.state.players.get(host.client.sessionId);
  const guestPlayer = setup.room.state.players.get(guest.client.sessionId);
  if (!hostPlayer || !guestPlayer) {
    throw new Error("Synthetic projectile match failed to create players");
  }

  return {
    ...setup,
    host,
    guest,
    hostPlayer,
    guestPlayer
  };
};

afterEach(() => {
  for (const room of rooms.splice(0)) {
    room.onDispose();
  }
  brokerCredentials.clear();
  vi.restoreAllMocks();
});

describe("BattleRoyaleRoom phase 3 lifecycle", () => {
  it("creates battle_royale metadata with private room code and configured rates", async () => {
    const { room, metadata, privateValue, setTimestep } = await makeRoom({
      privateRoom: true,
      seed: " phase-3-seed "
    });

    expect(room.state.match.roomName).toBe(BATTLE_ROYALE_ROOM);
    expect(room.state.roomCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(room.roomId).toBe("ROOM123");
    expect(room.state.roomCode).not.toBe(room.roomId);
    expect(room.state.seed).toBe("phase-3-seed");
    expect(room.state.serverTime).toBeGreaterThan(0);
    expect(room.maxClients).toBe(testConfig.demoMaxPlayers);
    expect(room.patchRate).toBe(50);
    expect(privateValue).toBe(true);
    expect(setTimestep).toHaveBeenCalledWith(expect.any(Function), 33);
    expect(metadata).toMatchObject({
      roomName: BATTLE_ROYALE_ROOM,
      roomCode: room.state.roomCode,
      private: true,
      matchState: "waiting",
      playerCount: 0,
      maxClients: testConfig.demoMaxPlayers,
      seed: "phase-3-seed"
    });
  });

  it("ignores caller-provided arena seeds in production", async () => {
    const { room } = await makeRoom({
      seed: "attacker-known-seed",
      config: {
        ...testConfig,
        nodeEnv: "production",
        publicClientUrl: "https://alpha7-client.example",
        publicServerUrl: "https://alpha7-server.example"
      }
    });

    expect(room.state.seed).not.toBe("attacker-known-seed");
    expect(room.state.seed).toMatch(/^alpha7-[0-9a-f-]{36}$/);
  });

  it("honors a fixed seed only in a production capacity environment", async () => {
    const { room } = await makeRoom({
      seed: "capacity-fixture-seed",
      config: {
        ...testConfig,
        nodeEnv: "production",
        enableCapacityMetrics: true,
        publicClientUrl: "https://alpha7-client.example",
        publicServerUrl: "https://alpha7-server.example"
      }
    });

    expect(room.state.seed).toBe("capacity-fixture-seed");
  });

  it("publishes complete metadata snapshots under replacement semantics", async () => {
    const { room, metadata } = await makeRoom({ seed: "metadata-replacement-seed" });
    const host = makeClient("host1");

    metadata.obsolete = true;
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });

    expect(metadata).toEqual({
      roomName: BATTLE_ROYALE_ROOM,
      roomCode: room.state.roomCode,
      private: false,
      matchState: "waiting",
      playerCount: 1,
      maxClients: testConfig.demoMaxPlayers,
      mode: "classic",
      roomMode: "classic",
      track: "none",
      combatantCap: testConfig.demoMaxPlayers,
      seed: "metadata-replacement-seed"
    });
  });

  it("syncs deterministic arena config onto room state for clients", async () => {
    const { room } = await makeRoom({
      seed: "arena-seed"
    });

    const arena = readArenaConfig(room);
    const bounds = arenaBounds(arena);
    expect(arena.seed).toBe("arena-seed");
    expect(bounds).toMatchObject({
      minX: expect.any(Number),
      minY: expect.any(Number),
      maxX: expect.any(Number),
      maxY: expect.any(Number)
    });
    expect(arena.spawnPoints.length).toBeGreaterThanOrEqual(testConfig.demoMaxPlayers);
    expect(pickupPoints(arena).length).toBeGreaterThan(0);
    expect(arena.zonePhases.length).toBeGreaterThanOrEqual(3);
    expect(room.state.zone.radius).toBeGreaterThan(0);
  });

  it("populates players from join options with sanitized names, host selection, and tank defaults", async () => {
    const { room, internals, metadata } = await makeRoom();
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    const arena = readArenaConfig(room);
    const hostSpawn = arena.spawnPoints[0];
    const guestSpawn = arena.spawnPoints[1];
    expect(hostSpawn).toBeDefined();
    expect(guestSpawn).toBeDefined();

    room.onJoin(host.client, {
      playerName: " <Rook>\nPilot ",
      archetypeId: "rook"
    });
    room.onJoin(guest.client, {
      playerName: "\u0000",
      archetypeId: "atlas"
    });

    const hostPlayer = room.state.players.get(host.client.sessionId);
    const guestPlayer = room.state.players.get(guest.client.sessionId);
    expect(hostPlayer).toMatchObject({
      id: "host1",
      sessionId: "host1",
      name: "Rook Pilot",
      archetypeId: "rook",
      weaponType: "cannon",
      abilityType: "repair",
      maxHealth: 140,
      health: 140,
      maxArmor: 60,
      armor: 60,
      x: hostSpawn?.x,
      y: hostSpawn?.y,
      isHost: true,
      isReady: false
    });
    expect(guestPlayer).toMatchObject({
      name: "Player",
      archetypeId: "atlas",
      x: guestSpawn?.x,
      y: guestSpawn?.y,
      isHost: false
    });

    internals.handleJoinMessage(guest.client, {
      playerName: "Rook Two",
      archetypeId: "rook"
    });
    expect(guestPlayer).toMatchObject({
      name: "Rook Two",
      archetypeId: "rook",
      maxHealth: 140,
      health: 140,
      maxArmor: 60,
      armor: 60
    });

    expect(host.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.SYSTEM,
      expect.objectContaining({
        code: "player_joined",
        roomCode: room.state.roomCode,
        matchState: "waiting"
      })
    );
    expect(metadata.playerCount).toBe(2);
  });

  it("rejects a client that bypasses authenticated admission", async () => {
    const { rawOnJoin } = await makeRoom();
    const attacker = makeClient("attacker");

    expect(() => rawOnJoin(attacker.client)).toThrow(ServerError);
  });

  it("reassigns a single host when the lobby host leaves", async () => {
    const { room, metadata } = await makeRoom();
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });

    room.onLeave(host.client);

    const guestPlayer = room.state.players.get(guest.client.sessionId);
    expect(room.state.players.has(host.client.sessionId)).toBe(false);
    expect(guestPlayer?.isHost).toBe(true);
    expect(metadata.playerCount).toBe(1);
  });

  it("reserves host authority during the transient reconnect window", async () => {
    const { room } = await makeRoom();
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    vi.spyOn(room as ReconnectableRoom, "allowReconnection")
      .mockImplementation(() => new Promise<Client>(() => undefined));

    room.onDrop(host.client, CloseCode.MAY_TRY_RECONNECT);
    expect(room.state.players.get(host.client.sessionId)).toMatchObject({
      isConnected: false,
      isHost: true
    });
    expect(room.state.players.get(guest.client.sessionId)?.isHost).toBe(false);

    room.onReconnect(makeClient("host1").client);
    expect(room.state.players.get(host.client.sessionId)).toMatchObject({
      isConnected: true,
      isHost: true
    });
    expect(room.state.players.get(guest.client.sessionId)?.isHost).toBe(false);
  });

  it("allows already-reserved final seats when Colyseus auto-locks a waiting room at capacity", async () => {
    const { room, metadata } = await makeRoom({
      config: {
        ...testConfig,
        demoMaxPlayers: 2
      }
    });
    const host = makeClient("host1");
    const finalSeat = makeClient("seat2");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    Object.defineProperty(room, "locked", {
      configurable: true,
      get: () => true
    });

    room.onJoin(finalSeat.client, { playerName: "Final", archetypeId: "atlas" });

    expect(room.state.players.has(finalSeat.client.sessionId)).toBe(true);
    expect(metadata.playerCount).toBe(2);
  });

  it("starts countdown when all joined players are ready and rejects active late joins by admission error", async () => {
    const { room, internals, metadata, lock, unlock } = await makeRoom();
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    const late = makeClient("late1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });

    internals.handleReadyMessage(host.client, { ready: true });
    expect(room.state.matchState).toBe("waiting");

    internals.handleReadyMessage(guest.client, { ready: true });
    expect(room.state.matchState).toBe("countdown");
    expect(room.state.zonePhase.matchState).toBe("countdown");
    expect(room.state.match.countdownEndsAt).toBeGreaterThan(room.state.match.stateStartedAt);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(metadata.matchState).toBe("countdown");

    expect(() => room.onJoin(late.client, { playerName: "Late", archetypeId: "atlas" })).toThrow(
      ServerError
    );
    try {
      room.onJoin(late.client, { playerName: "Late", archetypeId: "atlas" });
    } catch (error) {
      expect((error as ServerError).code).toBe(ErrorCode.AUTH_FAILED);
    }

    room.onLeave(guest.client);
    expect(room.state.matchState).toBe("waiting");
    expect(room.state.zonePhase.matchState).toBe("waiting");
    expect(room.state.match.countdownEndsAt).toBe(0);
    expect(unlock).toHaveBeenCalled();
    expect(() =>
      room.onJoin(late.client, { playerName: "Late", archetypeId: "atlas" })
    ).not.toThrow();
  });

  it("keeps unexpected lobby drops reserved and restores the same player on reconnect", async () => {
    const { room, internals } = await makeRoom();
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    const reconnectedGuest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    expect(room.state.matchState).toBe("countdown");

    const allowReconnection = vi
      .spyOn(room as ReconnectableRoom, "allowReconnection")
      .mockImplementation(() => new Promise<Client>(() => undefined));

    room.onDrop(guest.client, CloseCode.MAY_TRY_RECONNECT);

    const guestPlayer = room.state.players.get(guest.client.sessionId);
    expect(guestPlayer).toBeDefined();
    expect(guestPlayer?.isConnected).toBe(false);
    expect(guestPlayer?.isReady).toBe(true);
    expect(room.state.matchState).toBe("waiting");
    expect(room.state.match.alivePlayers).toBe(2);
    expect(allowReconnection).toHaveBeenCalledWith(guest.client, 45);

    room.onReconnect(reconnectedGuest.client);

    expect(room.state.players.has(guest.client.sessionId)).toBe(true);
    expect(guestPlayer?.isConnected).toBe(true);
    expect(room.state.matchState).toBe("countdown");
    expect(reconnectedGuest.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.SYSTEM,
      expect.objectContaining({
        code: "player_joined",
        message: "reconnected"
      })
    );
  });

  it("turns an expired active reconnect window into a permanent elimination", async () => {
    const { room, internals } = await makeRoom({
      seed: "active-reconnect-expiry-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    vi.spyOn(room as ReconnectableRoom, "allowReconnection").mockImplementation(
      () => new Promise<Client>(() => undefined)
    );

    room.onDrop(guest.client, CloseCode.MAY_TRY_RECONNECT);
    room.onLeave(guest.client, CloseCode.FAILED_TO_RECONNECT);

    const hostPlayer = room.state.players.get(host.client.sessionId);
    const guestPlayer = room.state.players.get(guest.client.sessionId);
    expect(hostPlayer).toMatchObject({
      isAlive: true,
      isSpectator: false,
      placement: 1
    });
    expect(guestPlayer).toMatchObject({
      isConnected: false,
      isAlive: false,
      isSpectator: true,
      placement: 2
    });
    expect(room.state.matchState).toBe("finished");
    expect(room.state.match.alivePlayers).toBe(1);
  });

  it("treats public resume fields as inert and creates a distinct waiting-room seat", async () => {
    const { room, internals } = await makeRoom({
      seed: "replacement-session-timeout-seed"
    });
    room.state.roomCode = "aBc123";
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    const refreshedGuest = makeClient("guest2");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });

    vi.spyOn(room as ReconnectableRoom, "allowReconnection").mockImplementation(
      () => new Promise<Client>(() => undefined)
    );

    room.onDrop(guest.client, CloseCode.MAY_TRY_RECONNECT);
    const originalGuest = room.state.players.get(guest.client.sessionId);

    room.onJoin(refreshedGuest.client, {
      playerName: "Guest",
      archetypeId: "atlas",
      resumeSessionId: guest.client.sessionId,
      resumeRoomCode: room.state.roomCode
    });
    const refreshedPlayer = room.state.players.get(refreshedGuest.client.sessionId);

    expect(room.state.players.get(guest.client.sessionId)).toBe(originalGuest);
    expect(refreshedPlayer).toBeDefined();
    expect(refreshedPlayer).not.toBe(originalGuest);
    expect(refreshedPlayer).toMatchObject({
      sessionId: refreshedGuest.client.sessionId,
      name: "Guest",
      isConnected: true
    });

    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    room.onLeave(guest.client, CloseCode.FAILED_TO_RECONNECT);

    expect(room.state.players.get(guest.client.sessionId)).toBe(originalGuest);
    expect(originalGuest).toMatchObject({
      isConnected: false,
      isAlive: false,
      isSpectator: true
    });
    expect(room.state.players.get(refreshedGuest.client.sessionId)).toBe(refreshedPlayer);
    expect(refreshedPlayer).toMatchObject({
      isConnected: true,
      isAlive: true,
      isSpectator: false
    });
    expect(room.state.matchState).toBe("running");
    expect(room.state.match.alivePlayers).toBe(2);
  });

  it("allows only the host to start countdown and requires at least two joined players", async () => {
    const { room, internals } = await makeRoom();
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    internals.handleStartMessage(host.client, {});
    expect(room.state.matchState).toBe("waiting");
    expect(host.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({
        code: "invalid_state",
        retryable: true
      })
    );

    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    internals.handleStartMessage(guest.client, {});
    expect(room.state.matchState).toBe("waiting");
    expect(guest.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({
        code: "invalid_state",
        retryable: false
      })
    );

    internals.handleStartMessage(host.client, {});
    expect(room.state.matchState).toBe("countdown");
  });

  it("advances countdown to running, danger, final_zone, and finished through timed lifecycle skeleton", async () => {
    const { room, internals } = await makeRoom();
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    internals.handleStartMessage(host.client, {});

    const runningAt = room.state.match.countdownEndsAt;
    internals.advanceTimedLifecycle(runningAt);
    expect(room.state.matchState).toBe("running");
    expect(room.state.zonePhase.matchState).toBe("running");
    expect(room.state.match.matchEndsAt).toBe(runningAt + 210_000);

    internals.advanceTimedLifecycle(runningAt + 90_000);
    expect(room.state.matchState).toBe("danger");

    internals.advanceTimedLifecycle(runningAt + 150_000);
    expect(room.state.matchState).toBe("final_zone");

    internals.advanceTimedLifecycle(runningAt + 210_000);
    expect(room.state.matchState).toBe("finished");
    expect(room.state.zonePhase.matchState).toBe("finished");
  });

  it("restores every tank's shared kit and deterministic spawn on match start", async () => {
    const { room, internals } = await makeRoom();
    const players = TANK_ARCHETYPES.map((archetypeId, index) => ({
      archetypeId,
      client: makeClient(`player${index + 1}`)
    }));
    const arena = readArenaConfig(room);

    for (const { archetypeId, client } of players) {
      room.onJoin(client.client, { playerName: archetypeId, archetypeId });
      const player = room.state.players.get(client.client.sessionId);
      const config = TANK_ARCHETYPE_CONFIG[archetypeId];
      expect(player).toMatchObject({
        archetypeId,
        weaponType: config.primaryWeapon,
        abilityType: config.ability,
        health: config.maxHealth,
        maxHealth: config.maxHealth,
        armor: config.maxArmor,
        maxArmor: config.maxArmor
      });
      if (!player) continue;
      player.weaponType = "explosive";
      player.abilityType = "barrage";
      player.health = 1;
      player.armor = 0;
    }

    const host = players[0];
    const hostPlayer = host ? room.state.players.get(host.client.client.sessionId) : undefined;
    if (hostPlayer) {
      hostPlayer.x = 999;
      hostPlayer.y = -999;
      hostPlayer.velocityX = 20;
      hostPlayer.velocityY = -20;
      hostPlayer.isReady = true;
    }
    expect(host).toBeDefined();
    if (!host) return;
    internals.handleStartMessage(host.client.client, {});
    internals.inputIntents.set(host.client.client.sessionId, {
      sequence: 99
    });

    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    expect(room.state.matchState).toBe("running");
    for (const [index, { archetypeId, client }] of players.entries()) {
      const config = TANK_ARCHETYPE_CONFIG[archetypeId];
      const spawn = arena.spawnPoints[index];
      expect(room.state.players.get(client.client.sessionId)).toMatchObject({
        archetypeId,
        weaponType: config.primaryWeapon,
        abilityType: config.ability,
        health: config.maxHealth,
        maxHealth: config.maxHealth,
        armor: config.maxArmor,
        maxArmor: config.maxArmor,
        x: spawn?.x,
        y: spawn?.y,
        velocityX: 0,
        velocityY: 0,
        isAlive: true,
        isReady: false
      });
    }
    expect(internals.inputIntents.size).toBe(0);
    expect(room.state.match.alivePlayers).toBe(TANK_ARCHETYPES.length);
  });

  it("applies server-authoritative movement with arena bounds and wall collision", async () => {
    const { room, internals } = await makeRoom({
      seed: "movement-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const arena = readArenaConfig(room);
    const bounds = arenaBounds(arena);
    const collisionRadius = TEST_TANK_RADIUS;
    const player = room.state.players.get(host.client.sessionId);
    expect(player).toBeDefined();
    if (!player) return;

    player.x = bounds.maxX - collisionRadius;
    player.y = (bounds.minY + bounds.maxY) / 2;
    internals.handleInputMessage(host.client, {
      sequence: 1,
      tick: 1,
      moveX: 1,
      moveY: 0,
      aimX: bounds.minX,
      aimY: player.y + 100,
      fire: false,
      ability: false
    });
    internals.onSimulationTick(1_000);

    expect(player.x).toBeLessThanOrEqual(bounds.maxX - collisionRadius);
    expect(player.y).toBe((bounds.minY + bounds.maxY) / 2);
    expect(player.turretRotation).toBeGreaterThan(1.4);

    const wall = firstInteriorWall(arena);
    expect(wall).toBeDefined();
    if (!wall) return;

    const left = wallLeft(arena, wall);
    const centerY = wallCenterY(arena, wall);
    player.x = left - collisionRadius - 2;
    player.y = centerY;
    player.velocityX = 0;
    player.velocityY = 0;
    internals.handleInputMessage(host.client, {
      sequence: 2,
      tick: 2,
      moveX: 1,
      moveY: 0,
      aimX: left,
      aimY: centerY,
      fire: false,
      ability: false
    });
    internals.onSimulationTick(1_000);

    expect(player.x).toBeCloseTo(left - collisionRadius - 2);
    expect(player.velocityX).toBe(0);
  });

  it("keeps unchanged cardinal and oblique human input moving safely around a rounded wall corner", async () => {
    const { room, internals } = await makeRoom();
    const human = makeClient("human-corner");
    room.onJoin(human.client, { playerName: "Human", archetypeId: "atlas" });
    const player = room.state.players.get(human.client.sessionId);
    expect(player).toBeDefined();
    if (!player) return;

    const arena = makeSyntheticArena([
      collisionRect("collision-human-corner", 100, 100, 96, 96)
    ]);
    for (const heading of [0, Math.atan2(2, 4)]) {
      player.x = 80;
      player.y = 80;
      player.rotation = heading;
      player.velocityX = 0;
      player.velocityY = 0;

      for (let tick = 0; tick < 12; tick += 1) {
        const previous = { x: player.x, y: player.y };
        internals.applyPlayerMovement(
          arena,
          player,
          { moveX: Math.cos(heading), moveY: Math.sin(heading) },
          1 / 30,
          1_000 + tick * (1_000 / 30)
        );
        expect(Math.hypot(player.x - previous.x, player.y - previous.y)).toBeGreaterThan(0);
        expect(isWallCollision(arena, player.x, player.y, TEST_TANK_RADIUS)).toBe(false);
      }

      const stoppedAt = { x: player.x, y: player.y };
      internals.applyPlayerMovement(arena, player, { moveX: 0, moveY: 0 }, 1 / 30, 1_500);
      expect({ x: player.x, y: player.y }).toEqual(stoppedAt);
      expect(Math.hypot(player.velocityX, player.velocityY)).toBe(0);
    }

    player.x = 80;
    player.y = 80;
    player.rotation = Math.PI / 4;
    player.velocityX = 0;
    player.velocityY = 0;
    internals.applyPlayerMovement(
      arena,
      player,
      { moveX: Math.SQRT1_2, moveY: Math.SQRT1_2 },
      1 / 30,
      1_600
    );
    expect({ x: player.x, y: player.y }).toEqual({ x: 80, y: 80 });
  });

  it("expires stale movement intents instead of replaying old input forever", async () => {
    const { room, internals } = await makeRoom({
      seed: "stale-intent-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const player = room.state.players.get(host.client.sessionId);
    expect(player).toBeDefined();
    if (!player) return;
    const startX = player.x;
    const startY = player.y;

    internals.inputIntents.set(host.client.sessionId, {
      sequence: 10,
      tick: room.state.match.tick,
      moveX: 1,
      moveY: 0,
      aimX: startX + 100,
      aimY: startY,
      fire: false,
      ability: false,
      receivedAt: Date.now() - 1_000
    });
    internals.onSimulationTick(16);

    expect(player.x).toBe(startX);
    expect(player.y).toBe(startY);
    expect(player.velocityX).toBe(0);
    expect(player.velocityY).toBe(0);
    expect(internals.inputIntents.has(host.client.sessionId)).toBe(false);
  });

  it("accepts a newer stop input even when its client tick lags the previous drive input", async () => {
    const { room, internals } = await makeRoom({
      seed: "movement-release-lag-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "atlas" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "nova" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    internals.handleInputMessage(host.client, {
      sequence: 10,
      tick: 120,
      moveX: 1,
      moveY: 0,
      aimX: 10,
      aimY: 0,
      fire: false,
      ability: false
    });
    internals.handleInputMessage(host.client, {
      sequence: 11,
      tick: 118,
      moveX: 0,
      moveY: 0,
      aimX: 10,
      aimY: 0,
      fire: false,
      ability: false
    });

    expect(internals.inputIntents.get(host.client.sessionId)).toMatchObject({
      sequence: 11,
      tick: 118,
      moveX: 0,
      moveY: 0
    });
  });

  it("keeps post-join payloads defensive and stores authoritative intent/rematch skeletons", async () => {
    const { room, internals } = await makeRoom();
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    internals.handleInputMessage(host.client, {
      sequence: 1,
      tick: 1,
      moveX: 1,
      moveY: 0,
      aimX: 4,
      aimY: 2,
      fire: false,
      ability: false
    });
    expect(host.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({
        code: "invalid_state"
      })
    );

    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    internals.handleInputMessage(host.client, {
      sequence: 2,
      tick: 3,
      moveX: 4,
      moveY: -4,
      aimX: 40,
      aimY: 20,
      fire: true,
      ability: false
    });
    expect(internals.inputIntents.get(host.client.sessionId)).toMatchObject({
      sequence: 2,
      moveX: 1,
      moveY: -1,
      fire: true
    });
    internals.handleFireMessage(host.client, {
      sequence: 6.5,
      weaponType: "explosive",
      aimX: 1,
      aimY: 2
    });
    expect(internals.fireIntents.has(host.client.sessionId)).toBe(false);
    expect(host.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({
        code: "invalid_payload"
      })
    );

    internals.handleAbilityMessage(host.client, {
      sequence: 3,
      abilityType: "repair"
    });
    expect(host.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({
        code: "invalid_payload"
      })
    );

    internals.handleRematchMessage(host.client, {
      ready: true,
      previousMatchId: room.state.match.matchId
    });
    expect(internals.rematchVotes.has(host.client.sessionId)).toBe(false);
    expect(host.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({
        code: "invalid_state"
      })
    );

    const matchStartedAt = room.state.match.stateStartedAt;
    internals.advanceTimedLifecycle(matchStartedAt + 90_000);
    internals.advanceTimedLifecycle(matchStartedAt + 150_000);
    internals.advanceTimedLifecycle(matchStartedAt + 210_000);
    expect(room.state.matchState).toBe("finished");
    internals.handleRematchMessage(host.client, {
      ready: true,
      previousMatchId: room.state.match.matchId
    });
    const hostOwnerId = room.state.players.get(host.client.sessionId)?.ownerId;
    expect(hostOwnerId).toEqual(expect.any(String));
    expect(internals.rematchVotes.get(hostOwnerId ?? "")).toMatchObject({
      ready: true,
      previousMatchId: room.state.match.matchId
    });
  });

  it("rejects active intents from dead or spectator players", async () => {
    const { room, internals } = await makeRoom();
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const hostPlayer = room.state.players.get(host.client.sessionId);
    const guestPlayer = room.state.players.get(guest.client.sessionId);
    if (hostPlayer) {
      hostPlayer.isAlive = false;
    }
    if (guestPlayer) {
      guestPlayer.isSpectator = true;
    }

    internals.handleInputMessage(host.client, {
      sequence: 4,
      tick: 4,
      moveX: 1,
      moveY: 0,
      aimX: 4,
      aimY: 2,
      fire: false,
      ability: false
    });
    internals.handleFireMessage(guest.client, {
      sequence: 5,
      aimX: 1,
      aimY: 2
    });

    expect(internals.inputIntents.has(host.client.sessionId)).toBe(false);
    expect(host.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({
        code: "invalid_state"
      })
    );
    expect(guest.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({
        code: "invalid_state"
      })
    );
  });

  it("simulates projectile hits, awards the kill, and finishes on the last elimination", async () => {
    const { room, internals } = await makeRoom({
      seed: "projectile-finish-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "quill" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const arena = readArenaConfig(room);
    const duel = findOpenDuelLine(arena);
    const hostPlayer = room.state.players.get(host.client.sessionId);
    const guestPlayer = room.state.players.get(guest.client.sessionId);
    expect(hostPlayer).toBeDefined();
    expect(guestPlayer).toBeDefined();
    if (!hostPlayer || !guestPlayer) return;

    hostPlayer.x = duel.attackerX;
    hostPlayer.y = duel.attackerY;
    guestPlayer.x = duel.targetX;
    guestPlayer.y = duel.targetY;
    guestPlayer.armor = 0;
    guestPlayer.health = 6;

    internals.handleFireMessage(host.client, {
      sequence: 1,
      weaponType: hostPlayer.weaponType,
      aimX: guestPlayer.x,
      aimY: guestPlayer.y
    });
    internals.onSimulationTick(100);

    expect(room.state.projectiles.length).toBe(0);
    expect(guestPlayer).toMatchObject({
      isAlive: false,
      isSpectator: true,
      placement: 2,
      deaths: 1
    });
    expect(hostPlayer).toMatchObject({
      kills: 1,
      placement: 1
    });
    expect(room.state.matchState).toBe("finished");
    expect(room.state.match.alivePlayers).toBe(1);
  });

  it("removes fast projectiles that sweep through a wall between simulation ticks", async () => {
    const { room, internals } = await makeRoom({
      seed: "projectile-wall-sweep-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "quill" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const arena = readArenaConfig(room);
    const duel = findWallBlockedDuelLine(arena);
    const hostPlayer = room.state.players.get(host.client.sessionId);
    const guestPlayer = room.state.players.get(guest.client.sessionId);
    expect(hostPlayer).toBeDefined();
    expect(guestPlayer).toBeDefined();
    if (!hostPlayer || !guestPlayer) return;

    hostPlayer.x = duel.attackerX;
    hostPlayer.y = duel.attackerY;
    guestPlayer.x = duel.targetX;
    guestPlayer.y = duel.targetY;
    guestPlayer.armor = 0;
    const healthBefore = guestPlayer.health;

    internals.handleFireMessage(host.client, {
      sequence: 1,
      weaponType: hostPlayer.weaponType,
      aimX: guestPlayer.x,
      aimY: guestPlayer.y
    });
    internals.onSimulationTick(0);
    expect(room.state.projectiles.length).toBe(1);

    internals.onSimulationTick(100);

    expect(room.state.projectiles.length).toBe(0);
    expect(guestPlayer.health).toBe(healthBefore);
    expect(guestPlayer.isAlive).toBe(true);
    expect(hostPlayer.kills).toBe(0);
  });

  it("copies the accepted fire sequence onto spawned projectiles", async () => {
    const { room, internals, host, hostPlayer } = await startSyntheticProjectileMatch();

    hostPlayer.x = 100;
    hostPlayer.y = 100;
    hostPlayer.weaponType = "cannon";
    hostPlayer.fireCooldownMs = 0;

    internals.handleFireMessage(host.client, {
      sequence: 42,
      weaponType: "cannon",
      aimX: 300,
      aimY: 100
    });
    internals.onSimulationTick(0);

    expect(room.state.projectiles.length).toBe(1);
    expect(room.state.projectiles[0]).toMatchObject({
      ownerId: host.client.sessionId,
      weaponType: "cannon",
      fireSequence: 42
    });
  });

  it("resolves a point-blank muzzle segment against an overlapping tank", async () => {
    const { room, internals, host, guest, hostPlayer, guestPlayer } = await startSyntheticProjectileMatch();
    const now = 73_456;
    vi.spyOn(Date, "now").mockReturnValue(now);
    hostPlayer.x = 500;
    hostPlayer.y = 500;
    hostPlayer.weaponType = "cannon";
    hostPlayer.fireCooldownMs = 0;
    guestPlayer.x = 500;
    guestPlayer.y = 500;
    guestPlayer.shield = 0;
    guestPlayer.armor = 0;
    guestPlayer.health = 100;

    internals.handleFireMessage(host.client, {
      sequence: 43,
      weaponType: "cannon",
      aimX: 700,
      aimY: 500
    });
    internals.onSimulationTick(0);

    expect(room.state.projectiles).toHaveLength(0);
    expect(guestPlayer.health).toBe(68);
    expect(projectileImpactCalls(room)).toEqual([
      [
        SERVER_MESSAGE_TYPES.PROJECTILE_IMPACT,
        expect.objectContaining({
          ownerId: host.client.sessionId,
          fireSequence: 43,
          reason: "tank",
          targetSessionId: guest.client.sessionId,
          x: 500,
          y: 500,
          damage: 32,
          at: now
        })
      ]
    ]);
  });

  it("does not spawn a projectile beyond thin cover inside the muzzle segment", async () => {
    const wall = collisionRect("collision-muzzle-wall", 150, 80, 10, 40);
    const { room, internals, host, hostPlayer, guestPlayer } = await startSyntheticProjectileMatch([wall]);
    const now = 83_456;
    vi.spyOn(Date, "now").mockReturnValue(now);
    hostPlayer.x = 100;
    hostPlayer.y = 100;
    hostPlayer.weaponType = "cannon";
    hostPlayer.fireCooldownMs = 0;
    guestPlayer.x = 200;
    guestPlayer.y = 100;
    guestPlayer.armor = 0;
    guestPlayer.health = 100;

    internals.handleFireMessage(host.client, {
      sequence: 44,
      weaponType: "cannon",
      aimX: guestPlayer.x,
      aimY: guestPlayer.y
    });
    internals.onSimulationTick(0);

    expect(room.state.projectiles).toHaveLength(0);
    expect(guestPlayer.health).toBe(100);
    expect(projectileImpactCalls(room)).toEqual([
      [
        SERVER_MESSAGE_TYPES.PROJECTILE_IMPACT,
        expect.objectContaining({ reason: "wall", x: 142, y: 100, at: now })
      ]
    ]);
  });

  it("broadcasts one exact tank impact at the swept entry point before removal", async () => {
    const { room, internals, host, guest, guestPlayer } = await startSyntheticProjectileMatch();
    const now = 123_456;
    vi.spyOn(Date, "now").mockReturnValue(now);

    guestPlayer.x = 190;
    guestPlayer.y = 100;
    guestPlayer.shield = 5;
    guestPlayer.armor = 10;
    guestPlayer.health = 20;

    addProjectile(room, {
      id: "projectile-tank",
      ownerId: host.client.sessionId,
      fireSequence: 7,
      x: 100,
      y: 100,
      velocityX: 1000,
      velocityY: 0,
      rotation: 0,
      damage: 22,
      radius: 8,
      splashRadius: 0,
      expiresAt: now + 1_000
    });

    internals.onSimulationTick(100);

    expect(room.state.projectiles.length).toBe(0);
    expect(guestPlayer).toMatchObject({
      shield: 0,
      armor: 0,
      health: 13,
      damageTaken: 22,
      isAlive: true
    });
    expect(projectileImpactCalls(room)).toEqual([
      [
        SERVER_MESSAGE_TYPES.PROJECTILE_IMPACT,
        {
          projectileId: "projectile-tank",
          ownerId: host.client.sessionId,
          fireSequence: 7,
          weaponType: "cannon",
          reason: "tank",
          x: 154,
          y: 100,
          rotation: 0,
          radius: 8,
          splashRadius: 0,
          targetSessionId: guest.client.sessionId,
          damage: 22,
          destroyed: false,
          shieldHit: true,
          at: now
        }
      ]
    ]);
  });

  it("lets a near-cover tank first-entry hit beat a later wall entry", async () => {
    const wall = collisionRect("collision-cover", 245, 70, 20, 22);
    const { room, internals, host, guest, guestPlayer } = await startSyntheticProjectileMatch([wall]);
    const now = 223_456;
    vi.spyOn(Date, "now").mockReturnValue(now);

    guestPlayer.x = 250;
    guestPlayer.y = 130;
    guestPlayer.shield = 0;
    guestPlayer.armor = 0;
    guestPlayer.health = 100;

    addProjectile(room, {
      id: "projectile-cover-graze",
      ownerId: host.client.sessionId,
      fireSequence: 8,
      x: 100,
      y: 100,
      velocityX: 3000,
      velocityY: 0,
      rotation: 0,
      damage: 22,
      radius: 8,
      splashRadius: 0,
      expiresAt: now + 1_000
    });

    internals.onSimulationTick(100);

    const calls = projectileImpactCalls(room);
    expect(room.state.projectiles.length).toBe(0);
    expect(guestPlayer.health).toBe(78);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      projectileId: "projectile-cover-graze",
      reason: "tank",
      targetSessionId: guest.client.sessionId,
      damage: 22
    });
    expect(calls[0]?.[1].x).toBeCloseTo(250 - Math.sqrt(36 ** 2 - 30 ** 2), 5);
    expect(calls[0]?.[1].x).toBeLessThan(wall.x - 8);
  });

  it("treats a projectile that starts inside a target as a t=0 hit", async () => {
    const { room, internals, host, guest, guestPlayer } = await startSyntheticProjectileMatch();
    const now = 323_456;
    vi.spyOn(Date, "now").mockReturnValue(now);

    guestPlayer.x = 150;
    guestPlayer.y = 100;
    guestPlayer.shield = 0;
    guestPlayer.armor = 0;
    guestPlayer.health = 6;

    addProjectile(room, {
      id: "projectile-start-inside",
      ownerId: host.client.sessionId,
      fireSequence: 9,
      x: 150,
      y: 100,
      velocityX: 1000,
      velocityY: 0,
      rotation: 0,
      damage: 22,
      radius: 8,
      splashRadius: 0,
      expiresAt: now + 1_000
    });

    internals.onSimulationTick(100);

    expect(room.state.projectiles.length).toBe(0);
    expect(guestPlayer.isAlive).toBe(false);
    expect(projectileImpactCalls(room)).toEqual([
      [
        SERVER_MESSAGE_TYPES.PROJECTILE_IMPACT,
        {
          projectileId: "projectile-start-inside",
          ownerId: host.client.sessionId,
          fireSequence: 9,
          weaponType: "cannon",
          reason: "tank",
          x: 150,
          y: 100,
          rotation: 0,
          radius: 8,
          splashRadius: 0,
          targetSessionId: guest.client.sessionId,
          damage: 6,
          destroyed: true,
          shieldHit: false,
          at: now
        }
      ]
    ]);
  });

  it("keeps wall-first projectile sweeps blocked and emits no tank fields", async () => {
    const wall = collisionRect("collision-wall-first", 150, 80, 20, 40);
    const { room, internals, host, guestPlayer } = await startSyntheticProjectileMatch([wall]);
    const now = 423_456;
    vi.spyOn(Date, "now").mockReturnValue(now);

    guestPlayer.x = 230;
    guestPlayer.y = 100;
    guestPlayer.shield = 0;
    guestPlayer.armor = 0;
    guestPlayer.health = 100;

    addProjectile(room, {
      id: "projectile-wall-first",
      ownerId: host.client.sessionId,
      fireSequence: 10,
      x: 100,
      y: 100,
      velocityX: 3000,
      velocityY: 0,
      rotation: 0,
      damage: 22,
      radius: 8,
      splashRadius: 0,
      expiresAt: now + 1_000
    });

    internals.onSimulationTick(100);

    expect(room.state.projectiles.length).toBe(0);
    expect(guestPlayer.health).toBe(100);
    expect(projectileImpactCalls(room)).toEqual([
      [
        SERVER_MESSAGE_TYPES.PROJECTILE_IMPACT,
        {
          projectileId: "projectile-wall-first",
          ownerId: host.client.sessionId,
          fireSequence: 10,
          weaponType: "cannon",
          reason: "wall",
          x: 142,
          y: 100,
          rotation: 0,
          radius: 8,
          splashRadius: 0,
          at: now
        }
      ]
    ]);
  });

  it("broadcasts one exact range impact when a projectile expires", async () => {
    const { room, internals, host } = await startSyntheticProjectileMatch();
    const now = 523_456;
    vi.spyOn(Date, "now").mockReturnValue(now);

    addProjectile(room, {
      id: "projectile-range",
      ownerId: host.client.sessionId,
      fireSequence: 11,
      x: 120,
      y: 110,
      velocityX: 500,
      velocityY: 0,
      rotation: 0.25,
      damage: 22,
      radius: 8,
      splashRadius: 0,
      expiresAt: now
    });

    internals.onSimulationTick(100);

    expect(room.state.projectiles.length).toBe(0);
    expect(projectileImpactCalls(room)).toEqual([
      [
        SERVER_MESSAGE_TYPES.PROJECTILE_IMPACT,
        {
          projectileId: "projectile-range",
          ownerId: host.client.sessionId,
          fireSequence: 11,
          weaponType: "cannon",
          reason: "range",
          x: 120,
          y: 110,
          rotation: 0.25,
          radius: 8,
          splashRadius: 0,
          at: now
        }
      ]
    ]);
  });

  it("blocks intents from disconnected tanks while keeping them damageable in combat", async () => {
    const { room, internals } = await makeRoom({
      seed: "disconnected-combat-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "quill" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const arena = readArenaConfig(room);
    const duel = findOpenDuelLine(arena);
    const hostPlayer = room.state.players.get(host.client.sessionId);
    const guestPlayer = room.state.players.get(guest.client.sessionId);
    expect(hostPlayer).toBeDefined();
    expect(guestPlayer).toBeDefined();
    if (!hostPlayer || !guestPlayer) return;

    hostPlayer.x = duel.attackerX;
    hostPlayer.y = duel.attackerY;
    guestPlayer.x = duel.targetX;
    guestPlayer.y = duel.targetY;
    guestPlayer.armor = 0;
    guestPlayer.health = 6;
    guestPlayer.isConnected = false;

    internals.handleInputMessage(guest.client, {
      sequence: 4,
      tick: 4,
      moveX: 1,
      moveY: 0,
      aimX: hostPlayer.x,
      aimY: hostPlayer.y,
      fire: false,
      ability: false
    });
    expect(internals.inputIntents.has(guest.client.sessionId)).toBe(false);
    expect(guest.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({
        code: "invalid_state"
      })
    );

    internals.handleFireMessage(host.client, {
      sequence: 1,
      weaponType: hostPlayer.weaponType,
      aimX: guestPlayer.x,
      aimY: guestPlayer.y
    });
    internals.onSimulationTick(100);

    expect(guestPlayer).toMatchObject({
      isAlive: false,
      isSpectator: true,
      placement: 2
    });
    expect(hostPlayer).toMatchObject({
      kills: 1,
      placement: 1
    });
    expect(room.state.matchState).toBe("finished");
  });

  it("does not admit fallback replacement sessions after the room locks", async () => {
    const { room, internals } = await makeRoom({
      seed: "refresh-fallback-session-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    const refreshedGuest = makeClient("guest2");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const originalGuest = room.state.players.get(guest.client.sessionId);
    expect(originalGuest).toBeDefined();
    expect(room.state.matchState).toBe("running");
    if (!originalGuest) return;

    const resumeOptions = {
      playerName: "Guest",
      archetypeId: "atlas",
      resumeSessionId: guest.client.sessionId,
      resumeRoomCode: room.state.roomCode
    };
    expect(() => room.onJoin(refreshedGuest.client, resumeOptions)).toThrow(ServerError);

    originalGuest.isConnected = false;
    expect(() => room.onJoin(refreshedGuest.client, resumeOptions)).toThrow(ServerError);

    expect(room.state.players.get(guest.client.sessionId)).toBe(originalGuest);
    expect(room.state.players.has(refreshedGuest.client.sessionId)).toBe(false);
    expect(room.state.matchState).toBe("running");
    expect(room.state.match.alivePlayers).toBe(2);
  });

  it("applies zone damage outside the safe area during danger and final zone states", async () => {
    const { room, internals } = await makeRoom({
      seed: "zone-damage-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "rook" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const runningStartedAt = room.state.match.stateStartedAt;
    internals.advanceTimedLifecycle(runningStartedAt + 90_000);
    expect(room.state.matchState).toBe("danger");

    const arena = readArenaConfig(room);
    const bounds = arenaBounds(arena);
    const hostPlayer = room.state.players.get(host.client.sessionId);
    const guestPlayer = room.state.players.get(guest.client.sessionId);
    expect(hostPlayer).toBeDefined();
    expect(guestPlayer).toBeDefined();
    if (!hostPlayer || !guestPlayer) return;

    hostPlayer.x = room.state.zone.x;
    hostPlayer.y = room.state.zone.y;

    const outsideRight = Math.min(
      bounds.maxX - TEST_TANK_RADIUS,
      room.state.zone.x + room.state.zone.radius + 120
    );
    guestPlayer.x =
      outsideRight > room.state.zone.x + room.state.zone.radius
        ? outsideRight
        : Math.max(bounds.minX + TEST_TANK_RADIUS, room.state.zone.x - room.state.zone.radius - 120);
    guestPlayer.y = room.state.zone.y;
    guestPlayer.shield = 0;
    guestPlayer.armor = 0;
    guestPlayer.health = 100;

    for (let tick = 0; tick < 30; tick += 1) {
      internals.onSimulationTick(33);
    }

    expect(guestPlayer.health).toBe(93);
    internals.onSimulationTick(33);
    expect(guestPlayer.health).toBe(92);

    internals.advanceTimedLifecycle(runningStartedAt + 150_000);
    expect(room.state.matchState).toBe("final_zone");
    const healthBeforeFinal = guestPlayer.health;
    for (let tick = 0; tick < 10; tick += 1) {
      internals.onSimulationTick(100);
    }
    expect(guestPlayer.health).toBeLessThan(healthBeforeFinal);
  });

  it("resolves a deterministic winner when final-zone damage eliminates all tanks in one tick", async () => {
    const { room, internals } = await makeRoom({
      seed: "zone-tiebreak-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    const closer = makeClient("closer1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "rook" });
    room.onJoin(closer.client, { playerName: "Closer", archetypeId: "quill" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const runningStartedAt = room.state.match.stateStartedAt;
    internals.advanceTimedLifecycle(runningStartedAt + 90_000);
    internals.advanceTimedLifecycle(runningStartedAt + 150_000);
    expect(room.state.matchState).toBe("final_zone");

    const arena = readArenaConfig(room);
    const bounds = arenaBounds(arena);
    const hostPlayer = room.state.players.get(host.client.sessionId);
    const guestPlayer = room.state.players.get(guest.client.sessionId);
    const closerPlayer = room.state.players.get(closer.client.sessionId);
    expect(hostPlayer).toBeDefined();
    expect(guestPlayer).toBeDefined();
    expect(closerPlayer).toBeDefined();
    if (!hostPlayer || !guestPlayer || !closerPlayer) return;

    const corners = [
      { x: bounds.minX + TEST_TANK_RADIUS, y: bounds.minY + TEST_TANK_RADIUS },
      { x: bounds.maxX - TEST_TANK_RADIUS, y: bounds.minY + TEST_TANK_RADIUS },
      { x: bounds.minX + TEST_TANK_RADIUS, y: bounds.maxY - TEST_TANK_RADIUS },
      { x: bounds.maxX - TEST_TANK_RADIUS, y: bounds.maxY - TEST_TANK_RADIUS }
    ].sort(
      (left, right) =>
        Math.hypot(right.x - room.state.zone.x, right.y - room.state.zone.y) -
        Math.hypot(left.x - room.state.zone.x, left.y - room.state.zone.y)
    );
    const outside = corners[0];
    expect(Math.hypot(outside.x - room.state.zone.x, outside.y - room.state.zone.y)).toBeGreaterThan(
      room.state.zone.radius
    );

    hostPlayer.x = outside.x;
    hostPlayer.y = outside.y;
    guestPlayer.x = outside.x;
    guestPlayer.y = outside.y;
    closerPlayer.x = outside.x;
    closerPlayer.y = outside.y;
    hostPlayer.shield = 0;
    hostPlayer.armor = 0;
    hostPlayer.health = 1;
    hostPlayer.damageDealt = 30;
    guestPlayer.shield = 0;
    guestPlayer.armor = 0;
    guestPlayer.health = 1;
    guestPlayer.damageDealt = 50;
    closerPlayer.shield = 0;
    closerPlayer.armor = 0;
    closerPlayer.health = 1;
    closerPlayer.damageDealt = 80;

    internals.onSimulationTick(1000);

    expect(room.state.matchState).toBe("finished");
    expect(room.state.match.alivePlayers).toBe(1);
    expect(closerPlayer).toMatchObject({
      isAlive: true,
      isSpectator: false,
      placement: 1
    });
    expect(hostPlayer).toMatchObject({
      isAlive: false,
      isSpectator: true,
      placement: 3
    });
    expect(guestPlayer).toMatchObject({
      isAlive: false,
      isSpectator: true,
      placement: 3
    });
  });

  it("collects pickups, applies server-side effects, and respawns inactive pickups", async () => {
    const { room, internals } = await makeRoom({
      seed: "pickup-effects-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "atlas" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "rook" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const hostPlayer = room.state.players.get(host.client.sessionId);
    const pickup = room.state.pickups[0];
    expect(hostPlayer).toBeDefined();
    expect(pickup).toBeDefined();
    if (!hostPlayer || !pickup) return;

    hostPlayer.health = 100;
    pickup.pickupType = "health_repair";
    pickup.value = PICKUP_CONFIG.health_repair.value;
    pickup.durationMs = PICKUP_CONFIG.health_repair.durationMs;
    pickup.x = hostPlayer.x;
    pickup.y = hostPlayer.y;
    pickup.isActive = true;
    internals.onSimulationTick(16);

    expect(hostPlayer.health).toBe(hostPlayer.maxHealth);
    expect(pickup.isActive).toBe(false);
    expect(room.broadcast).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.SYSTEM,
      expect.objectContaining({
        code: "pickup_collected",
        pickupType: "health_repair",
        pickupName: PICKUP_CONFIG.health_repair.name,
        pickupValue: 20,
        playerSessionId: host.client.sessionId
      })
    );

    pickup.isActive = true;
    internals.onSimulationTick(16);
    expect(pickup.isActive).toBe(true);

    pickup.pickupType = "ability_charge";
    pickup.value = PICKUP_CONFIG.ability_charge.value;
    pickup.durationMs = PICKUP_CONFIG.ability_charge.durationMs;
    hostPlayer.abilityCharge = 100;
    internals.onSimulationTick(16);
    expect(pickup.isActive).toBe(true);
    hostPlayer.abilityCharge = 0;
    internals.onSimulationTick(16);
    expect(hostPlayer.abilityCharge).toBeGreaterThanOrEqual(PICKUP_CONFIG.ability_charge.value);

    const effectInternals = internals as unknown as {
      speedMultiplierFor(player: typeof hostPlayer): number;
      isRapidFireActive(player: typeof hostPlayer, now: number): boolean;
      applyDamage(target: typeof hostPlayer, source: typeof hostPlayer | undefined, rawDamage: number, now: number): number;
    };

    pickup.isActive = true;
    pickup.pickupType = "shield_armor";
    pickup.value = PICKUP_CONFIG.shield_armor.value;
    pickup.durationMs = PICKUP_CONFIG.shield_armor.durationMs;
    hostPlayer.armor = 0;
    hostPlayer.shield = 0;
    internals.onSimulationTick(16);
    expect(hostPlayer.armor).toBe(PICKUP_CONFIG.shield_armor.value);
    expect(hostPlayer.shield).toBeGreaterThan(0);

    pickup.isActive = true;
    pickup.pickupType = "ammo_rapid_fire";
    pickup.value = PICKUP_CONFIG.ammo_rapid_fire.value;
    pickup.durationMs = PICKUP_CONFIG.ammo_rapid_fire.durationMs;
    hostPlayer.ammo = 0;
    internals.onSimulationTick(16);
    expect(hostPlayer.ammo).toBe(PICKUP_CONFIG.ammo_rapid_fire.value);
    expect(effectInternals.isRapidFireActive(hostPlayer, Date.now())).toBe(true);

    pickup.isActive = true;
    pickup.pickupType = "speed_boost";
    pickup.value = PICKUP_CONFIG.speed_boost.value;
    pickup.durationMs = PICKUP_CONFIG.speed_boost.durationMs;
    internals.onSimulationTick(16);
    expect(effectInternals.speedMultiplierFor(hostPlayer)).toBeGreaterThan(1);

    pickup.isActive = true;
    pickup.pickupType = "smoke";
    pickup.value = PICKUP_CONFIG.smoke.value;
    pickup.durationMs = PICKUP_CONFIG.smoke.durationMs;
    hostPlayer.health = 100;
    hostPlayer.armor = 0;
    hostPlayer.shield = 0;
    internals.onSimulationTick(16);
    const damageThroughSmoke = effectInternals.applyDamage(hostPlayer, undefined, 20, Date.now());
    expect(damageThroughSmoke).toBeLessThan(20);
    expect(hostPlayer.lastAbilityAt).toBe(0);
    expect(hostPlayer.smokeActivatedAt).toBeGreaterThan(0);
    const smokeEndsAt = hostPlayer.smokeEndsAt;
    hostPlayer.abilityCharge = 100;
    internals.handleAbilityMessage(host.client, {
      sequence: 1,
      abilityType: hostPlayer.abilityType
    });
    internals.onSimulationTick(16);
    expect(hostPlayer.lastAbilityType).toBe("shield_pulse");
    expect(hostPlayer.smokeEndsAt).toBe(smokeEndsAt);
    expect(hostPlayer.smokeEndsAt).toBeGreaterThan(Date.now());

    pickup.isActive = true;
    pickup.pickupType = "barrage_explosive";
    pickup.value = PICKUP_CONFIG.barrage_explosive.value;
    pickup.durationMs = PICKUP_CONFIG.barrage_explosive.durationMs;
    hostPlayer.ammo = 24;
    hostPlayer.abilityCharge = 0;
    internals.onSimulationTick(16);
    expect(hostPlayer.abilityType).toBe(TANK_ARCHETYPE_CONFIG.atlas.ability);
    expect(hostPlayer.abilityCharge).toBeLessThan(1);
    expect(hostPlayer.weaponType).toBe("explosive");
    expect(hostPlayer.ammo).toBe(WEAPON_CONFIG.explosive.ammoCost * 3);

    pickup.isActive = false;
    pickup.respawnsAt = Date.now() - 1;
    internals.onSimulationTick(16);
    expect(pickup.isActive).toBe(false);

    hostPlayer.x += 200;
    internals.onSimulationTick(16);
    expect(pickup.isActive).toBe(true);
  });

  it("collects an ability-charge pickup after a same-tick ability activation", async () => {
    const { room, internals } = await makeRoom({ seed: "same-tick-ability-pickup" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "atlas" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "rook" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const hostPlayer = room.state.players.get(host.client.sessionId);
    expect(hostPlayer).toBeDefined();
    if (!hostPlayer) return;

    const pickup = new PickupSchema();
    pickup.id = "same-tick-ability-charge";
    pickup.pickupType = "ability_charge";
    pickup.x = hostPlayer.x;
    pickup.y = hostPlayer.y;
    pickup.radius = 24;
    pickup.value = PICKUP_CONFIG.ability_charge.value;
    pickup.durationMs = PICKUP_CONFIG.ability_charge.durationMs;
    pickup.spawnedAt = Date.now();
    pickup.isActive = true;
    room.state.pickups.push(pickup);

    hostPlayer.abilityCharge = 100;
    internals.handleAbilityMessage(host.client, {
      sequence: 91,
      abilityType: hostPlayer.abilityType
    });
    internals.onSimulationTick(16);

    expect(hostPlayer.lastAbilityAt).toBeGreaterThan(0);
    expect(pickup.isActive).toBe(false);
    expect(hostPlayer.abilityCharge).toBeGreaterThanOrEqual(PICKUP_CONFIG.ability_charge.value);
  });

  it("applies an ammo pickup before a same-tick shot and uses the authoritative weapon", async () => {
    const { room, internals, host, hostPlayer } = await startSyntheticProjectileMatch();
    const pickup = new PickupSchema();
    pickup.id = "same-tick-explosive";
    pickup.pickupType = "barrage_explosive";
    pickup.x = hostPlayer.x;
    pickup.y = hostPlayer.y;
    pickup.radius = 24;
    pickup.value = PICKUP_CONFIG.barrage_explosive.value;
    pickup.durationMs = PICKUP_CONFIG.barrage_explosive.durationMs;
    pickup.spawnedAt = Date.now();
    pickup.respawnsAt = 0;
    pickup.isActive = true;
    room.state.pickups.push(pickup);

    internals.handleFireMessage(host.client, {
      sequence: 41,
      weaponType: "cannon",
      aimX: hostPlayer.x + 500,
      aimY: hostPlayer.y
    });
    internals.onSimulationTick(16);

    expect(pickup.isActive).toBe(false);
    expect(hostPlayer.weaponType).toBe("explosive");
    expect(room.state.projectiles[0]).toMatchObject({
      ownerId: host.client.sessionId,
      fireSequence: 41,
      weaponType: "explosive"
    });
    expect(host.send).not.toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({ code: "invalid_payload" })
    );
  });

  it("applies repair, shield, smoke, and barrage ability effects server-side", async () => {
    const { room, internals } = await makeRoom({
      seed: "ability-effects-seed"
    });
    const repairClient = makeClient("repair1");
    const shieldClient = makeClient("shield1");
    const smokeClient = makeClient("smoke1");
    const barrageClient = makeClient("barrage1");

    room.onJoin(repairClient.client, { playerName: "Repair", archetypeId: "rook" });
    room.onJoin(shieldClient.client, { playerName: "Shield", archetypeId: "atlas" });
    room.onJoin(smokeClient.client, { playerName: "Smoke", archetypeId: "quill" });
    room.onJoin(barrageClient.client, { playerName: "Barrage", archetypeId: "nova" });
    internals.handleStartMessage(repairClient.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const arena = readArenaConfig(room);
    const duel = findOpenDuelLine(arena);
    const repairPlayer = room.state.players.get(repairClient.client.sessionId);
    const shieldPlayer = room.state.players.get(shieldClient.client.sessionId);
    const smokePlayer = room.state.players.get(smokeClient.client.sessionId);
    const barragePlayer = room.state.players.get(barrageClient.client.sessionId);
    expect(repairPlayer).toBeDefined();
    expect(shieldPlayer).toBeDefined();
    expect(smokePlayer).toBeDefined();
    expect(barragePlayer).toBeDefined();
    if (!repairPlayer || !shieldPlayer || !smokePlayer || !barragePlayer) return;

    repairPlayer.health = 40;
    repairPlayer.armor = 5;
    repairPlayer.abilityType = "repair";
    repairPlayer.abilityCharge = 100;
    shieldPlayer.shield = 0;
    shieldPlayer.abilityType = "shield_pulse";
    shieldPlayer.abilityCharge = 100;
    smokePlayer.x = duel.targetX;
    smokePlayer.y = duel.targetY;
    smokePlayer.armor = 0;
    smokePlayer.shield = 0;
    smokePlayer.health = 100;
    smokePlayer.abilityType = "smoke";
    smokePlayer.abilityCharge = 100;
    barragePlayer.abilityType = "barrage";
    barragePlayer.abilityCharge = 100;

    internals.handleAbilityMessage(repairClient.client, { sequence: 1, abilityType: "repair" });
    internals.handleAbilityMessage(shieldClient.client, {
      sequence: 1,
      abilityType: "shield_pulse"
    });
    internals.handleAbilityMessage(smokeClient.client, { sequence: 1, abilityType: "smoke" });
    internals.handleAbilityMessage(barrageClient.client, { sequence: 1, abilityType: "barrage" });
    internals.onSimulationTick(16);

    expect(repairPlayer.health).toBeGreaterThan(40);
    expect(repairPlayer.armor).toBeGreaterThan(5);
    expect(shieldPlayer.shield).toBeGreaterThan(0);
    expect(barragePlayer.weaponType).toBe("explosive");
    expect(barragePlayer.ammo).toBe(WEAPON_CONFIG.explosive.ammoCost * 3);
    expect(smokePlayer).toMatchObject({
      lastAbilityType: "smoke",
      lastAbilityX: duel.targetX,
      lastAbilityY: duel.targetY,
      smokeX: duel.targetX,
      smokeY: duel.targetY
    });
    expect(smokePlayer.lastAbilityEndsAt).toBeGreaterThan(smokePlayer.lastAbilityAt);
    expect(smokePlayer.smokeEndsAt).toBeGreaterThan(smokePlayer.smokeActivatedAt);

    repairPlayer.x = duel.attackerX;
    repairPlayer.y = duel.attackerY;
    repairPlayer.weaponType = "cannon";
    repairPlayer.fireCooldownMs = 0;
    internals.handleFireMessage(repairClient.client, {
      sequence: 20,
      weaponType: repairPlayer.weaponType,
      aimX: smokePlayer.x,
      aimY: smokePlayer.y
    });
    internals.onSimulationTick(200);

    expect(smokePlayer.health).toBe(100 - Math.round(WEAPON_CONFIG.cannon.damage * 0.6));

    const damageInternals = internals as unknown as {
      applyDamage(
        target: typeof smokePlayer,
        source: typeof repairPlayer | undefined,
        rawDamage: number,
        now: number,
        smokeCanReduce?: boolean
      ): number;
    };
    smokePlayer.health = 100;
    smokePlayer.x = duel.targetX + ABILITY_CONFIG.smoke.radius + 1;
    expect(damageInternals.applyDamage(smokePlayer, repairPlayer, 20, Date.now())).toBe(20);
    smokePlayer.health = 100;
    smokePlayer.x = duel.targetX;
    expect(damageInternals.applyDamage(smokePlayer, undefined, 20, Date.now(), false)).toBe(20);
  });

  it("does not spend Field Repair when health and armor are already full", async () => {
    const { room, internals } = await makeRoom({ seed: "repair-full-seed" });
    const repairClient = makeClient("repair1");
    const guestClient = makeClient("guest1");

    room.onJoin(repairClient.client, { playerName: "Repair", archetypeId: "rook" });
    room.onJoin(guestClient.client, { playerName: "Guest", archetypeId: "atlas" });
    internals.handleStartMessage(repairClient.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const repairPlayer = room.state.players.get(repairClient.client.sessionId);
    expect(repairPlayer).toBeDefined();
    if (!repairPlayer) return;

    expect(repairPlayer.health).toBe(repairPlayer.maxHealth);
    expect(repairPlayer.armor).toBe(repairPlayer.maxArmor);
    internals.handleAbilityMessage(repairClient.client, {
      sequence: 1,
      abilityType: "repair"
    });
    internals.onSimulationTick(16);

    expect(repairPlayer.abilityCharge).toBe(100);
    expect(repairPlayer.abilityCooldownMs).toBe(0);
    expect(repairPlayer.lastAbilityAt).toBe(0);
  });

  it("applies speed burst movement and rejects ability spam while cooling down", async () => {
    const { room, internals } = await makeRoom({
      seed: "speed-burst-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const arena = readArenaConfig(room);
    const duel = findOpenDuelLine(arena);
    const hostPlayer = room.state.players.get(host.client.sessionId);
    expect(hostPlayer).toBeDefined();
    if (!hostPlayer) return;

    hostPlayer.x = duel.attackerX;
    hostPlayer.y = duel.attackerY;

    internals.handleAbilityMessage(host.client, {
      sequence: 1,
      abilityType: "speed_burst"
    });
    internals.onSimulationTick(16);

    const startX = hostPlayer.x;
    const startY = hostPlayer.y;
    const moveX = Math.sign(duel.targetX - duel.attackerX) || 1;
    const moveY = Math.sign(duel.targetY - duel.attackerY);
    internals.handleInputMessage(host.client, {
      sequence: 9,
      tick: 9,
      moveX,
      moveY,
      aimX: duel.targetX,
      aimY: duel.targetY,
      fire: false,
      ability: false
    });
    for (let tick = 0; tick < 4; tick += 1) {
      internals.onSimulationTick(100);
    }

    expect(Math.hypot(hostPlayer.x - startX, hostPlayer.y - startY)).toBeGreaterThan(35);
    expect(hostPlayer.speedMultiplier).toBe(1.55);
    expect(hostPlayer.abilityCooldownMs).toBeGreaterThan(0);
    expect(hostPlayer.abilityCharge).toBeLessThan(100);

    internals.handleAbilityMessage(host.client, {
      sequence: 2,
      abilityType: "speed_burst"
    });
    expect(host.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({
        code: "rate_limited",
        field: "ability"
      })
    );
  });

  it("drops stale fire intents and rejects weapon spam while cooling down", async () => {
    const { room, internals } = await makeRoom({
      seed: "fire-cooldown-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "rook" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const arena = readArenaConfig(room);
    const duel = findOpenDuelLine(arena);
    const hostPlayer = room.state.players.get(host.client.sessionId);
    expect(hostPlayer).toBeDefined();
    if (!hostPlayer) return;
    hostPlayer.x = duel.attackerX;
    hostPlayer.y = duel.attackerY;

    internals.fireIntents.set(host.client.sessionId, {
      sequence: 1,
      weaponType: hostPlayer.weaponType,
      aimX: duel.targetX,
      aimY: duel.targetY,
      receivedAt: Date.now() - 1_000
    });
    internals.onSimulationTick(16);

    expect(room.state.projectiles.length).toBe(0);
    expect(internals.fireIntents.has(host.client.sessionId)).toBe(false);

    internals.handleFireMessage(host.client, {
      sequence: 2,
      weaponType: hostPlayer.weaponType,
      aimX: duel.targetX,
      aimY: duel.targetY
    });
    internals.onSimulationTick(16);
    expect(room.state.projectiles.length).toBe(1);
    const projectile = room.state.projectiles[0];
    expect(projectile).toBeDefined();
    if (projectile) {
      const spawnDistance = Math.hypot(projectile.x - hostPlayer.x, projectile.y - hostPlayer.y);
      expect(spawnDistance).toBeGreaterThan(TEST_TANK_RADIUS + projectile.radius + 20);
    }

    internals.handleFireMessage(host.client, {
      sequence: 3,
      weaponType: hostPlayer.weaponType,
      aimX: duel.targetX,
      aimY: duel.targetY
    });
    expect(host.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({
        code: "rate_limited",
        field: "fire"
      })
    );
  });

  it("resets the match once all connected players vote for a rematch", async () => {
    const { room, internals } = await makeRoom({
      seed: "rematch-seed"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");

    room.onJoin(host.client, { playerName: "Host", archetypeId: "quill" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    internals.handleStartMessage(host.client, {});
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const arena = readArenaConfig(room);
    const duel = findOpenDuelLine(arena);
    const hostPlayer = room.state.players.get(host.client.sessionId);
    const guestPlayer = room.state.players.get(guest.client.sessionId);
    expect(hostPlayer).toBeDefined();
    expect(guestPlayer).toBeDefined();
    if (!hostPlayer || !guestPlayer) return;

    hostPlayer.x = duel.attackerX;
    hostPlayer.y = duel.attackerY;
    guestPlayer.x = duel.targetX;
    guestPlayer.y = duel.targetY;
    guestPlayer.armor = 0;
    guestPlayer.health = 6;

    internals.handleFireMessage(host.client, {
      sequence: 1,
      weaponType: hostPlayer.weaponType,
      aimX: guestPlayer.x,
      aimY: guestPlayer.y
    });
    internals.onSimulationTick(100);
    expect(room.state.matchState).toBe("finished");

    const previousMatchId = room.state.match.matchId;
    const previousRound = room.state.match.round;
    const previousSeed = room.state.seed;

    internals.handleRematchMessage(host.client, {
      ready: true,
      previousMatchId: "stale-round"
    });
    expect(hostPlayer.isReady).toBe(false);
    expect(internals.rematchVotes.size).toBe(0);
    expect(host.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({ code: "invalid_payload" })
    );

    internals.handleRematchMessage(host.client, {
      ready: true,
      previousMatchId
    });
    expect(hostPlayer.isReady).toBe(true);
    expect(room.state.matchState).toBe("finished");

    internals.handleRematchMessage(host.client, {
      ready: false,
      previousMatchId
    });
    expect(hostPlayer.isReady).toBe(false);
    expect(room.state.matchState).toBe("finished");

    internals.handleRematchMessage(host.client, {
      ready: true,
      previousMatchId
    });
    expect(hostPlayer.isReady).toBe(true);

    internals.handleRematchMessage(guest.client, {
      ready: true,
      previousMatchId
    });

    expect(room.state.match.round).toBe(previousRound + 1);
    expect(room.state.match.matchId).not.toBe(previousMatchId);
    expect(room.state.seed).toBe(`${previousSeed}:round:${previousRound + 1}`);
    expect(["waiting", "countdown"]).toContain(room.state.matchState);
    expect(hostPlayer).toMatchObject({
      isAlive: true,
      isSpectator: false,
      placement: 0
    });
    expect(guestPlayer).toMatchObject({
      isAlive: true,
      isSpectator: false,
      placement: 0
    });
    const rematchArena = readArenaConfig(room);
    expect(rematchArena.seed).toBe(room.state.seed);
    expect(rematchArena.seed).not.toBe(arena.seed);
    expect(rematchArena.spawnPoints).not.toEqual(arena.spawnPoints);
    expect(hostPlayer).toMatchObject({
      x: rematchArena.spawnPoints[0]?.x,
      y: rematchArena.spawnPoints[0]?.y
    });
    expect(guestPlayer).toMatchObject({
      x: rematchArena.spawnPoints[1]?.x,
      y: rematchArena.spawnPoints[1]?.y
    });
  });
});

describe("BattleRoyaleRoom agent modes", () => {
  it("keeps Classic unchanged and rejects agent modes while the feature is disabled", async () => {
    const classic = await makeRoom();
    expect(classic.room.state.policy).toMatchObject({
      mode: "classic",
      track: "none",
      ownerCap: testConfig.demoMaxPlayers,
      humanWsCap: testConfig.demoMaxPlayers,
      agentControlCap: 0,
      combatantCap: testConfig.demoMaxPlayers,
      tacticalReflexEnabled: true
    });

    await expect(
      makeRoom({
        roomMode: "wingman",
        config: { ...testConfig, agentPlayEnabled: false }
      })
    ).rejects.toThrow("agent play is disabled");
  });

  it("advertises tactical support and falls back to Macro V1 when the rollout flag is off", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      config: { ...testConfig, agentTacticalReflexEnabled: false }
    });
    const host = makeClient("host1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "quill" });

    expect(room.state.policy.tacticalReflexEnabled).toBe(false);
    internals.handleAgentPairingCreate(host.client, { agentLabel: "Compat Agent" });
    const result = host.send.mock.calls
      .filter(([type]) => type === SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT)
      .at(-1)?.[1] as { accepted?: boolean; pairingCode?: string } | undefined;
    expect(result?.accepted).toBe(true);
    expect(JSON.parse(result?.pairingCode ?? "{}")).toMatchObject({ version: 1 });

    internals.handleAgentPairingCancel(host.client, {});
    internals.handleAgentPairingCreate(host.client, {
      agentLabel: "Disabled Tactical Agent",
      controlMode: "tactical_reflex_v1",
      openingTactic: TACTICAL_OPENING
    });
    expect(host.send.mock.calls
      .filter(([type]) => type === SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT)
      .at(-1)?.[1]).toMatchObject({
      accepted: false,
      errorCode: "agent_feature_disabled",
      seatState: "none"
    });
  });

  it("constructs expanded Wingman capacity only behind the qualification flag", async () => {
    const { room } = await makeRoom({
      roomMode: "wingman",
      config: { ...testConfig, demoMaxPlayers: 8, agentExpandedCombatantsEnabled: true }
    });
    expect(room.state.policy).toMatchObject({
      ownerCap: 8,
      humanWsCap: 8,
      agentControlCap: 8,
      combatantCap: 16
    });
  });

  it("keeps maximum Agent Cup controls behind their independent qualification flag", async () => {
    const constrained = await makeRoom({
      roomMode: "agent_cup",
      config: { ...testConfig, demoMaxPlayers: 8 }
    });
    expect(constrained.room.state.policy).toMatchObject({
      ownerCap: 2,
      humanWsCap: 2,
      agentControlCap: 2,
      combatantCap: 2
    });

    const qualified = await makeRoom({
      roomMode: "agent_cup",
      config: { ...testConfig, demoMaxPlayers: 8, agentCupMaxControlsEnabled: true }
    });
    expect(qualified.room.state.policy).toMatchObject({
      ownerCap: 8,
      humanWsCap: 8,
      agentControlCap: 8,
      combatantCap: 8
    });
  });

  it("requires every agent-mode owner to pair and ready before host start", async () => {
    const { room, internals } = await makeRoom({ roomMode: "wingman" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });

    internals.handleStartMessage(host.client, {});
    expect(room.state.matchState).toBe("waiting");
    await pairAgent(room, internals, host, "Host Agent");
    await pairAgent(room, internals, guest, "Guest Agent");
    internals.handleStartMessage(host.client, {});
    expect(room.state.matchState).toBe("waiting");
    internals.handleReadyMessage(host.client, { ready: true });
    expect(room.state.matchState).toBe("waiting");
    internals.handleReadyMessage(guest.client, { ready: true });
    expect(room.state.matchState).toBe("countdown");
  });

  it("starts Open FFA with one ready owner and their connected agent", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa" });
    const host = makeClient("host1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    await pairAgent(room, internals, host, "Solo Open Agent");

    internals.handleReadyMessage(host.client, { ready: true });

    expect(room.agentCapacitySnapshot()).toMatchObject({
      owners: 1,
      connectedOwners: 1,
      combatants: 2
    });
    expect(room.state.matchState).toBe("countdown");
  });

  it("keeps solo Open FFA waiting without a second combatant", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa" });
    const host = makeClient("host1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });

    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleStartMessage(host.client, {});

    expect(room.state.matchState).toBe("waiting");
  });

  it.each(["wingman", "agent_cup"] as const)(
    "keeps one complete %s owner-agent pair below the start minimum",
    async (roomMode) => {
      const { room, internals } = await makeRoom({ roomMode });
      const host = makeClient("host1");
      room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
      await pairAgent(room, internals, host, `Solo ${roomMode} Agent`);

      internals.handleReadyMessage(host.client, { ready: true });
      internals.handleStartMessage(host.client, {});

      expect(room.state.matchState).toBe("waiting");
    }
  );

  it("cancels an agent-mode countdown when a required seat pauses", async () => {
    const { room, internals } = await makeRoom({ roomMode: "wingman" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    await pairAgent(room, internals, host, "Host Agent");
    await pairAgent(room, internals, guest, "Guest Agent");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    expect(room.state.matchState).toBe("countdown");

    internals.handleAgentControl(host.client, { action: "pause" });
    expect(room.state.matchState).toBe("waiting");
    internals.handleAgentControl(host.client, { action: "resume" });
    expect(room.state.matchState).toBe("countdown");
  });

  it("keeps agent control fail-closed through pause and owner reconnection", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    const reconnectedHost = makeClient("host1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const paired = await pairAgent(room, internals, host, "Host Agent");
    const credential = brokerCredentials.get(paired.principal.seatId) ?? "";
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const now = Date.now();
    const staleSession = agentBroker.authorize({
      brokerCredential: credential,
      roomId: room.roomId,
      requiredScope: "agent:observe"
    }, now);
    const observation = room.agentObserve(staleSession, now);
    internals.handleAgentControl(host.client, { action: "pause" });
    expect(room.state.owners.get(paired.principal.ownerId)?.agentSeatState).toBe("paused");
    expect(room.agentAct(staleSession, {
      version: 1,
      actionSeq: 1,
      basedOnObservationSeq: observation.observationSeq,
      leaseMs: 500,
      waypoints: [],
      fire: "none",
      useAbility: false
    }, now + 500)).toMatchObject({ accepted: false, code: "agent_paused" });
    expect(() => room.agentObserve(staleSession, now + 500)).toThrow("agent_paused");
    expect(room.state.owners.get(paired.principal.ownerId)?.agentSeatState).toBe("paused");
    expect(internals.inputIntents.get(paired.principal.seatId)).toMatchObject({
      moveX: 0,
      moveY: 0,
      fire: false,
      ability: false
    });
    expect(internals.fireIntents.has(paired.principal.seatId)).toBe(false);

    internals.handleAgentControl(host.client, { action: "resume" });
    const resumedSession = agentBroker.authorize({
      brokerCredential: credential,
      roomId: room.roomId,
      requiredScope: "agent:observe"
    }, now + 1_000);
    expect(room.agentAct(resumedSession, {
      version: 1,
      actionSeq: 99,
      basedOnObservationSeq: observation.observationSeq,
      leaseMs: 500,
      waypoints: [],
      fire: "none",
      useAbility: "once"
    }, now + 1_000)).toMatchObject({ accepted: false, code: "stale_observation" });
    const resumedObservation = room.agentObserve(resumedSession, now + 1_000);
    expect(resumedObservation.seatId).toBe(paired.principal.seatId);

    vi.spyOn(room as ReconnectableRoom, "allowReconnection")
      .mockImplementation(() => new Promise<Client>(() => undefined));
    room.onDrop(host.client, CloseCode.MAY_TRY_RECONNECT);
    const reconnectingSession = agentBroker.authorize({
      brokerCredential: credential,
      roomId: room.roomId,
      requiredScope: "agent:observe"
    }, now + 1_500);
    expect(room.agentStatus(reconnectingSession).state).toBe("reconnecting");
    expect(() => room.agentObserve(reconnectingSession, now + 1_500)).toThrow("owner_unavailable");

    room.onReconnect(reconnectedHost.client);
    expect(room.agentAct(reconnectingSession, {
      version: 1,
      actionSeq: 100,
      basedOnObservationSeq: resumedObservation.observationSeq,
      leaseMs: 500,
      waypoints: [],
      fire: "none",
      useAbility: "once"
    }, now + 2_000)).toMatchObject({ accepted: false, code: "stale_observation" });
    expect(room.agentObserve(reconnectingSession, now + 2_000).seatId).toBe(
      paired.principal.seatId
    );
    expect(room.state.owners.get(paired.principal.ownerId)?.agentSeatState).toBe("connected");
  });

  it("reserves Open FFA combatant capacity for pending agent grants", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      config: { ...testConfig, demoMaxPlayers: 8 }
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    internals.handleAgentPairingCreate(host.client, { agentLabel: "Host Agent" });
    internals.handleAgentPairingCreate(guest.client, { agentLabel: "Guest Agent" });
    expect(internals.agentPairingRequests.size).toBe(2);

    for (let index = 0; index < 4; index += 1) {
      const player = makeClient(`late${index}`);
      room.onJoin(player.client, { playerName: `Late ${index}`, archetypeId: "nova" });
    }
    expect(internals.canAcceptActiveJoin()).toBe(false);

    const lateJoin = makeClient("blocked-late");
    expect(() =>
      room.onJoin(lateJoin.client, { playerName: "Late", archetypeId: "nova" })
    ).toThrow("room is locked");
    expect(room.state.owners.size).toBe(6);
  });

  it("locks matchmaking when pending Open FFA seats fill capacity and unlocks after cancellation", async () => {
    const { room, internals, lock, unlock } = await makeRoom({
      roomMode: "open_ffa",
      config: { ...testConfig, demoMaxPlayers: 8 }
    });
    const owners = Array.from({ length: 4 }, (_, index) => makeClient(`owner${index}`));
    for (const [index, owner] of owners.entries()) {
      room.onJoin(owner.client, { playerName: `Owner ${index}`, archetypeId: "rook" });
      internals.handleAgentPairingCreate(owner.client, { agentLabel: `Agent ${index}` });
    }
    expect(lock).toHaveBeenCalled();

    const host = owners[0]!;
    const hostOwnerId = room.state.players.get(host.client.sessionId)?.ownerId ?? "";
    const requestId = internals.agentPairingRequests.get(hostOwnerId);
    expect(requestId).toEqual(expect.any(String));
    const unlocksBeforeCancel = unlock.mock.calls.length;
    internals.handleAgentPairingCancel(host.client, { requestId });
    expect(unlock.mock.calls.length).toBeGreaterThan(unlocksBeforeCancel);
    expect(internals.canAcceptActiveJoin()).toBe(true);
  });

  it("synchronizes and clears an expired pending agent grant", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa" });
    const host = makeClient("host1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });

    internals.handleAgentPairingCreate(host.client, { agentLabel: "Host Agent" });
    const result = host.send.mock.calls
      .filter(([type]) => type === SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT)
      .at(-1)?.[1] as { expiresAtMs?: number } | undefined;
    const ownerId = room.state.players.get(host.client.sessionId)?.ownerId ?? "";
    const owner = room.state.owners.get(ownerId);
    expect(result?.expiresAtMs).toEqual(expect.any(Number));
    expect(owner).toMatchObject({
      agentSeatState: "pending",
      agentPairingExpiresAtMs: result?.expiresAtMs
    });

    internals.runAgentExecutors(result?.expiresAtMs ?? 0);
    expect(owner).toMatchObject({ agentSeatState: "none", agentPairingExpiresAtMs: 0 });
  });

  it("cancels the authenticated owner's pending grant without client-local request state", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa" });
    const host = makeClient("host1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    internals.handleAgentPairingCreate(host.client, { agentLabel: "Host Agent" });
    const ownerId = room.state.players.get(host.client.sessionId)?.ownerId ?? "";
    expect(room.state.owners.get(ownerId)?.agentSeatState).toBe("pending");

    internals.handleAgentPairingCancel(host.client, {});

    expect(room.state.owners.get(ownerId)).toMatchObject({
      agentSeatState: "none",
      agentPairingExpiresAtMs: 0
    });
    expect(internals.agentPairingRequests.has(ownerId)).toBe(false);
    expect(host.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT,
      expect.objectContaining({ action: "cancel", accepted: true, seatState: "none" })
    );
  });

  it("materializes one internal Wingman seat per owner and excludes friendly fire", async () => {
    const { room, internals } = await makeRoom({ roomMode: "wingman", seed: "wingman-agent" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });

    const hostSession = await pairAgent(room, internals, host, "Host Agent");
    const guestSession = await pairAgent(room, internals, guest, "Guest Agent");
    const hostOwner = room.state.owners.get(hostSession.principal.ownerId);
    const hostHuman = room.state.players.get(host.client.sessionId);
    const hostAgent = room.state.players.get(hostSession.principal.seatId);
    expect(hostOwner).toMatchObject({
      agentSeatId: hostSession.principal.seatId,
      agentSeatState: "connected"
    });
    expect(hostAgent).toMatchObject({
      ownerId: hostOwner?.ownerId,
      pairId: hostOwner?.ownerId,
      controlKind: "agent",
      isHost: false
    });
    expect(guestSession.principal.seatId).not.toBe(hostSession.principal.seatId);
    expect(room.state.players.size).toBe(4);
    expect(() => room.agentObserve(hostSession)).toThrow("match_not_active");

    expect(hostHuman).toBeDefined();
    expect(hostAgent).toBeDefined();
    if (!hostHuman || !hostAgent) return;
    const before = hostAgent.health + hostAgent.armor;
    expect(internals.applyDamage(hostAgent, hostHuman, 50, Date.now())).toBe(0);
    expect(hostAgent.health + hostAgent.armor).toBe(before);
  });

  it("enforces observation/action cadence and executes a bounded macro at 20 Hz", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "agent-executor" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Runner");

    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const now = Date.now();
    const observation = room.agentObserve(session, now);
    expect(observation).toMatchObject({
      version: 1,
      observationSeq: 1,
      seatId: session.principal.seatId,
      mode: "open_ffa",
      track: "custom"
    });
    expect(JSON.stringify(observation)).not.toContain("agentSeatState");
    expect(internals.debugAgentAuditSnapshot()).toContainEqual(expect.objectContaining({
      event: "observed",
      seatId: session.principal.seatId,
      observationSeq: 1,
      observationHash: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/)
    }));
    expect(() => room.agentObserve(session, now + 499)).toThrow("rate_limited");

    const self = room.state.players.get(session.principal.seatId);
    expect(self).toBeDefined();
    if (!self) return;
    const actionPayload = {
      version: 1 as const,
      actionSeq: 1,
      basedOnObservationSeq: observation.observationSeq,
      leaseMs: 1_000,
      waypoints: [],
      fire: "none" as const,
      useAbility: false as const
    };
    const action = room.agentAct(
      session,
      actionPayload,
      now + 500
    );
    expect(action).toMatchObject({ accepted: true, code: "accepted", actionSeq: 1 });
    internals.runAgentExecutors(now + 550);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({
      moveX: 0,
      moveY: 0,
      receivedAt: now + 550
    });
    internals.runAgentExecutors(now + 600);
    expect(internals.debugAgentAuditSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "action_accepted",
        seatId: session.principal.seatId,
        actionSeq: 1,
        macro: expect.objectContaining({
          actionSeq: 1,
          basedOnObservationSeq: 1,
          leaseMs: 1_000,
          waypoints: []
        }),
        brokerLatencyMs: expect.any(Number),
        roomHandlerLatencyMs: expect.any(Number)
      }),
      expect.objectContaining({
        event: "executor_intent",
        seatId: session.principal.seatId,
        actionSeq: 1,
        tick: expect.any(Number),
        sequence: expect.any(Number)
      })
    ]));
    expect(internals.debugAgentAuditSnapshot().filter(
      (entry) => entry.event === "executor_intent" && entry.actionSeq === 1
    )).toHaveLength(2);
    expect(JSON.stringify(internals.debugAgentAuditSnapshot())).not.toContain(
      brokerCredentials.get(session.principal.seatId)
    );
    expect(room.agentAct(session, { ...actionPayload, actionSeq: 2 }, now + 999)).toMatchObject({
      accepted: false,
      code: "rate_limited"
    });
    expect(room.agentAct(session, actionPayload, now + 1_000)).toMatchObject({
      accepted: false,
      code: "stale_action"
    });
    expect(internals.debugAgentAuditSnapshot()).toContainEqual(expect.objectContaining({
      event: "action_rejected",
      seatId: session.principal.seatId,
      code: "rate_limited",
      parseError: null,
      macro: expect.objectContaining({ actionSeq: 2, basedOnObservationSeq: 1 })
    }));
    const auditCount = internals.debugAgentAuditSnapshot().length;
    expect(room.agentAct(
      session,
      undefined,
      now + 1_000,
      now + 1_000,
      "rate_limited"
    )).toMatchObject({ accepted: false, code: "rate_limited" });
    expect(internals.debugAgentAuditSnapshot()).toHaveLength(auditCount + 1);
    expect(internals.debugAgentAuditSnapshot().at(-1)).toMatchObject({
      event: "action_rejected",
      seatId: session.principal.seatId,
      code: "rate_limited",
      parseError: null,
      macro: null
    });
    const auditSecret = brokerCredentials.get(session.principal.seatId)!;
    expect(room.agentAct(session, { ...actionPayload, [auditSecret]: true }, now + 1_500)).toMatchObject({
      accepted: false,
      code: "lease_invalid"
    });
    expect(internals.debugAgentAuditSnapshot()).toContainEqual(expect.objectContaining({
      event: "action_rejected",
      seatId: session.principal.seatId,
      code: "lease_invalid",
      macro: null,
      parseError: { code: "unknown_key", field: "$.*" }
    }));
    expect(room.agentAct(session, {
      ...actionPayload,
      actionSeq: 3,
      targetId: auditSecret
    }, now + 2_000)).toMatchObject({
      accepted: false,
      code: "target_not_visible"
    });
    expect(internals.debugAgentAuditSnapshot()).toContainEqual(expect.objectContaining({
      event: "action_rejected",
      code: "target_not_visible",
      macro: expect.objectContaining({ targetId: null })
    }));
    expect(JSON.stringify(internals.debugAgentAuditSnapshot())).not.toContain(auditSecret);
  });

  it("pre-arms a tactical opening and emits its first short macro on match start", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-opening" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const opening: AgentTacticalIntentV1 = {
      ...TACTICAL_OPENING,
      validForMs: 30_000,
      objective: { type: "move_to", position: { x: 600, z: 500 } },
      fire: "none"
    };
    const session = await pairAgent(
      room,
      internals,
      host,
      "Tactical Runner",
      "tactical_reflex_v1",
      opening
    );
    const self = room.state.players.get(session.principal.seatId)!;
    self.x = 500;
    self.y = 500;
    self.rotation = 0;
    const acceptedAt = Date.now() + 1_000;
    expect(session.principal.openingTactic).toEqual(opening);
    expect(room.agentTacticalStatus(session)).toMatchObject({
      observationSeq: 0,
      active: false,
      stopReason: "waiting"
    });
    internals.runAgentExecutors(acceptedAt + 50);
    internals.runAgentExecutors(acceptedAt + 550);
    expect(internals.agentRuntimes.get(self.sessionId)?.tactical).toBeDefined();
    expect(room.agentTacticalStatus(session)).toMatchObject({
      active: false,
      stopReason: "waiting"
    });

    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    const startedAt = room.state.match.countdownEndsAt;
    internals.runAgentExecutors(startedAt - 50);
    expect(internals.agentRuntimes.get(self.sessionId)?.lastReflexAtMs).toBe(0);
    expect(internals.agentRuntimes.get(self.sessionId)?.tactical).toBeDefined();
    internals.advanceTimedLifecycle(startedAt);

    const openingInput = internals.inputIntents.get(self.sessionId) as {
      moveX?: number;
      moveY?: number;
    };
    expect(Math.hypot(openingInput.moveX ?? 0, openingInput.moveY ?? 0)).toBeGreaterThan(0);
    expect(Math.hypot(openingInput.moveX ?? 0, openingInput.moveY ?? 0)).toBeLessThanOrEqual(1);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease).toMatchObject({
      expiresAtMs: startedAt + 1_000
    });
    expect(room.agentTacticalStatus(session)).toMatchObject({
      observationSeq: 0,
      lastReflexAtMs: startedAt,
      active: true,
      stopReason: "moving"
    });
  });

  it("starts the default nearest-target opening without another model turn", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-default-opening" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    const session = await pairAgent(room, internals, host, "Default Hunter", "tactical_reflex_v1");

    internals.handleReadyMessage(host.client, { ready: true });
    const startedAt = room.state.match.countdownEndsAt;
    internals.advanceTimedLifecycle(startedAt);

    const self = room.state.players.get(session.principal.seatId)!;
    expect(internals.agentRuntimes.get(self.sessionId)?.tactical?.selectedTargetId).toBe(host.client.sessionId);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action).toMatchObject({
      targetId: host.client.sessionId,
      fire: "hold"
    });
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ fire: false });
    const input = internals.inputIntents.get(self.sessionId) as { moveX?: number; moveY?: number };
    expect(Math.hypot(input.moveX ?? 0, input.moveY ?? 0)).toBeGreaterThan(0);
    expect(internals.fireIntents.has(self.sessionId)).toBe(true);
    expect(room.agentTacticalStatus(session)).toMatchObject({
      observationSeq: 0,
      active: true,
      lastIntentSeq: 1
    });
    expect(internals.agentRuntimes.get(self.sessionId)?.tactical?.expiresAtMs)
      .toBe(startedAt + AGENT_TACTICAL_INTENT_MAX_DURATION_MS);
    const credential = brokerCredentials.get(self.sessionId)!;
    for (let elapsedMs = 5_000; elapsedMs <= 205_000; elapsedMs += 5_000) {
      agentBroker.heartbeat(credential, room.roomId, startedAt + elapsedMs);
    }
    for (const elapsedMs of [90_000, 150_000, 209_999]) {
      internals.advanceTimedLifecycle(startedAt + elapsedMs);
      expect(room.agentTacticalStatus(session).active).toBe(true);
    }
    internals.advanceTimedLifecycle(startedAt + AGENT_TACTICAL_INTENT_MAX_DURATION_MS);
    expect(room.state.matchState).toBe("finished");
    expect(room.agentTacticalStatus(session).active).toBe(false);
  });

  it("rejects a noninitial tactical opening before creating a grant", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-opening-seq" });
    const host = makeClient("host1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });

    internals.handleAgentPairingCreate(host.client, {
      agentLabel: "Unusable Opening",
      controlMode: "tactical_reflex_v1",
      openingTactic: { ...TACTICAL_OPENING, intentSeq: Number.MAX_SAFE_INTEGER }
    });

    expect(host.send).toHaveBeenCalledWith(
      SERVER_MESSAGE_TYPES.ERROR,
      expect.objectContaining({ code: "invalid_payload" })
    );
    expect(internals.agentPairingRequests.size).toBe(0);
  });

  it("rejects target and pickup objectives without a current-round observation", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-opening-targets" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Tactical Runner", "tactical_reflex_v1");
    const objectives = [
      { type: "engage_target" as const, targetId: guest.client.sessionId },
      { type: "collect_pickup" as const, pickupId: room.state.pickups[0]?.id ?? "pickup" }
    ];
    for (const [index, objective] of objectives.entries()) {
      expect(room.agentSetTacticalIntent(session, {
        version: 1,
        intentSeq: index + 2,
        basedOnObservationSeq: null,
        validForMs: 30_000,
        objective,
        fire: "none",
        useAbility: false,
        fallback: "hold"
      }, Date.now() + (index + 2) * 500)).toMatchObject({
        accepted: false,
        code: "stale_observation"
      });
    }
    expect(internals.agentRuntimes.get(session.principal.seatId)?.tactical).toBeUndefined();
  });

  it("re-arms the approved opening for a rematch without carrying the active tactic", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-rematch" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const opening = {
      version: 1 as const,
      intentSeq: 1,
      basedOnObservationSeq: null,
      validForMs: 30_000,
      objective: { type: "hold" as const },
      fire: "none" as const,
      useAbility: false as const,
      fallback: "hold" as const
    };
    const session = await pairAgent(
      room,
      internals,
      host,
      "Tactical Runner",
      "tactical_reflex_v1",
      opening
    );
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    const firstStartedAt = room.state.match.countdownEndsAt;
    internals.advanceTimedLifecycle(firstStartedAt);
    const observation = room.agentObserve(session, firstStartedAt + 500);
    expect(room.agentSetTacticalIntent(session, {
      ...opening,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      objective: { type: "hold" }
    }, firstStartedAt + 500)).toMatchObject({ accepted: true, code: "accepted" });

    const resetAt = firstStartedAt + 1_000;
    const firstRoundId = room.state.match.matchId;
    internals.resetForRematch(resetAt);
    const rematchRuntime = internals.agentRuntimes.get(session.principal.seatId);
    expect(room.state.match.matchId).not.toBe(firstRoundId);
    expect(rematchRuntime?.lease).toBeUndefined();
    expect(rematchRuntime?.tactical).toMatchObject({
      intent: opening,
      roundId: room.state.match.matchId,
      expiresAtMs: resetAt + opening.validForMs
    });
    expect(room.agentTacticalStatus(session)).toMatchObject({
      lastIntentSeq: 2,
      active: false,
      stopReason: "waiting"
    });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    expect(room.agentTacticalStatus(session)).toMatchObject({ active: true, stopReason: "hold" });

    room.agentClearTacticalIntent(session, resetAt + 5_000);
    internals.resetForRematch(resetAt + 6_000);
    expect(internals.agentRuntimes.get(session.principal.seatId)?.tactical).toBeUndefined();
  });

  it("does not remap an approved explicit opening when the rematch arena blocks it", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-rematch-point" });
    const currentArena = internals.arena!;
    const nextArena = generateArenaConfig({
      seed: `tactical-rematch-point:round:${room.state.match.round + 1}`,
      playerCount: room.state.policy.combatantCap
    });
    const point = currentArena.floorCells.find((cell) =>
      !isWallCollision(currentArena, cell.x, cell.y, TEST_TANK_RADIUS) &&
      isWallCollision(nextArena, cell.x, cell.y, TEST_TANK_RADIUS)
    );
    expect(point).toBeDefined();
    const host = makeClient("host1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    const opening: AgentTacticalIntentV1 = {
      version: 1,
      intentSeq: 1,
      basedOnObservationSeq: null,
      validForMs: 30_000,
      objective: { type: "move_to", position: { x: point!.x, z: point!.y } },
      fire: "none",
      useAbility: "once",
      fallback: "hold"
    };
    const session = await pairAgent(
      room,
      internals,
      host,
      "Explicit Runner",
      "tactical_reflex_v1",
      opening
    );

    internals.resetForRematch(Date.now() + 1_000);

    expect(internals.agentRuntimes.get(session.principal.seatId)?.tactical).toBeUndefined();
    expect(room.agentTacticalStatus(session)).toMatchObject({
      active: false,
      stopReason: "route_blocked"
    });
  });

  it("starts a fresh opening window after an unbounded lobby wait", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-long-lobby" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const opening: AgentTacticalIntentV1 = {
      ...TACTICAL_OPENING,
      validForMs: 500,
      objective: { type: "hold" },
      fire: "none"
    };
    const session = await pairAgent(
      room,
      internals,
      host,
      "Tactical Runner",
      "tactical_reflex_v1",
      opening
    );
    const acceptedAt = session.principal.issuedAtMs;
    internals.runAgentExecutors(acceptedAt + 500);
    expect(internals.agentRuntimes.get(session.principal.seatId)?.tactical).toBeUndefined();

    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    const startedAt = room.state.match.countdownEndsAt;
    internals.advanceTimedLifecycle(startedAt);
    expect(internals.agentRuntimes.get(session.principal.seatId)?.tactical).toMatchObject({
      roundId: room.state.match.matchId,
      expiresAtMs: startedAt + 500
    });
    expect(room.agentTacticalStatus(session)).toMatchObject({ active: true, stopReason: "hold" });
  });

  it("rejects a replacement round opening after the approved opening is bound", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-delayed-opening" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Tactical Runner", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    const startedAt = room.state.match.countdownEndsAt;
    internals.advanceTimedLifecycle(startedAt);
    const opening = {
      version: 1 as const,
      intentSeq: 1,
      basedOnObservationSeq: null,
      validForMs: 30_000,
      objective: { type: "hold" as const },
      fire: "none" as const,
      useAbility: false as const,
      fallback: "hold" as const
    };

    expect(room.agentSetTacticalIntent(session, opening, startedAt + 1)).toMatchObject({
      accepted: false,
      code: "stale_action"
    });
    expect(room.agentTacticalStatus(session)).toMatchObject({ active: false, stopReason: "cleared" });
    expect(room.agentSetTacticalIntent(session, {
      ...opening,
      intentSeq: 2
    }, startedAt + 501)).toMatchObject({ accepted: false, code: "stale_observation" });
    expect(room.agentTacticalStatus(session)).toMatchObject({ active: false, stopReason: "cleared" });
  });

  it("dispatches eight tactical openings in the same executor frame", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "tactical-eight-seat",
      config: { ...testConfig, demoMaxPlayers: 8, agentExpandedCombatantsEnabled: true }
    });
    const owners = Array.from({ length: 8 }, (_, index) => makeClient(`owner${index}`));
    for (const [index, owner] of owners.entries()) {
      room.onJoin(owner.client, { playerName: `Owner ${index}`, archetypeId: "nova" });
    }
    const sessions: AgentBrokerSession[] = [];
    for (const [index, owner] of owners.entries()) {
      sessions.push(await pairAgent(
        room,
        internals,
        owner,
        `Tactical ${index}`,
        "tactical_reflex_v1"
      ));
    }
    useSyntheticArena(room, [], 16);
    for (const owner of owners) internals.handleReadyMessage(owner.client, { ready: true });
    const startedAt = room.state.match.countdownEndsAt;
    internals.advanceTimedLifecycle(startedAt);

    const dispatchTimes = sessions.map((session) =>
      internals.agentRuntimes.get(session.principal.seatId)?.lastReflexAtMs
    );
    expect(dispatchTimes).toEqual(Array(8).fill(startedAt));
    expect(room.state.players.size).toBe(16);
  });

  it("reuses the filtered projection without consuming observation sequence and keeps single actions single", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-projection" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Tactical Guard", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    self.x = 500;
    self.y = 500;
    target.x = 650;
    target.y = 500;
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "single",
      useAbility: "once",
      fallback: "hold"
    }, now + 500)).toMatchObject({ accepted: true, intentSeq: 2 });

    internals.runAgentExecutors(now + 500);
    expect(internals.fireIntents.has(self.sessionId)).toBe(true);
    expect(internals.abilityIntents.has(self.sessionId)).toBe(true);
    expect(room.agentTacticalStatus(session).observationSeq).toBe(observation.observationSeq);

    internals.runAgentExecutors(now + 999);
    expect(internals.agentRuntimes.get(self.sessionId)?.lastReflexAtMs).toBe(now + 500);
    internals.runAgentExecutors(now + 1_000);
    expect(internals.agentRuntimes.get(self.sessionId)?.lastReflexAtMs).toBe(now + 1_000);
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
    expect(internals.abilityIntents.has(self.sessionId)).toBe(false);

    target.smokeX = target.x;
    target.smokeY = target.y;
    target.smokeEndsAt = now + 10_000;
    internals.runAgentExecutors(now + 1_050);
    expect(internals.agentRuntimes.get(self.sessionId)?.tactical).toBeUndefined();
    expect(internals.agentRuntimes.get(self.sessionId)?.lease).toBeUndefined();
    expect(room.agentTacticalStatus(session).stopReason).toBe("target_unavailable");
  });

  it("neutralizes tactical expiry and pickup invalidation on the next executor tick", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-safety" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Tactical Safety", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    self.x = 500;
    self.y = 500;
    const now = Date.now() + 1_000;
    const firstObservation = room.agentObserve(session, now);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: firstObservation.observationSeq,
      validForMs: 500,
      objective: { type: "hold" },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, now + 500)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(now + 999);
    expect(internals.agentRuntimes.get(self.sessionId)?.tactical).toBeDefined();
    internals.runAgentExecutors(now + 1_000);
    expect(room.agentTacticalStatus(session).stopReason).toBe("intent_expired");

    const pickup = new PickupSchema();
    pickup.id = "tactical-pickup";
    pickup.pickupType = "ammo";
    pickup.x = 650;
    pickup.y = 500;
    pickup.isActive = true;
    room.state.pickups.push(pickup);
    const secondObservation = room.agentObserve(session, now + 1_100);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 3,
      basedOnObservationSeq: secondObservation.observationSeq,
      validForMs: 30_000,
      objective: { type: "collect_pickup", pickupId: pickup.id },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, now + 1_100)).toMatchObject({ accepted: true });
    pickup.isActive = false;
    internals.runAgentExecutors(now + 1_150);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease).toBeUndefined();
    expect(room.agentTacticalStatus(session).stopReason).toBe("pickup_unavailable");
  });

  it("keeps a tactical objective active after reaching an internal movement segment", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-segments" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Tactical Walker", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    self.x = 500;
    self.y = 500;
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "move_to", position: { x: 900, z: 500 } },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, now + 500)).toMatchObject({ accepted: true });

    const firstWaypoint = internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints[0];
    expect(firstWaypoint).toEqual({ x: 780, z: 500 });
    self.x = firstWaypoint!.x;
    self.y = firstWaypoint!.z;
    internals.runAgentExecutors(now + 750);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease).toBeDefined();
    expect(internals.agentRuntimes.get(self.sessionId)?.tactical).toBeDefined();
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 1, moveY: 0 });
    internals.runAgentExecutors(now + 800);
    expect(internals.agentRuntimes.get(self.sessionId)?.tactical).toBeDefined();
    internals.runAgentExecutors(now + 1_000);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints[0]).toEqual({
      x: 900,
      z: 500
    });
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 1, moveY: 0 });
    expect(internals.agentRuntimes.get(self.sessionId)?.tactical).toBeDefined();
    expect(room.agentTacticalStatus(session).stopReason).toBe("moving");
  });

  it("keeps tracking a live engage target that moves after its prior segment", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-chase" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "quill" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Tactical Chaser", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    self.x = 500;
    self.y = 500;
    target.x = 900;
    target.y = 500;
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    self.x = 780;
    self.y = 500;
    target.x = 1_200;
    internals.runAgentExecutors(acceptedAt + 100);
    expect(internals.agentRuntimes.get(self.sessionId)?.lastReflexAtMs).toBe(acceptedAt);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 1, moveY: 0 });
    expect(room.agentTacticalStatus(session)).toMatchObject({
      active: true,
      stopReason: "moving",
      intentExpiresAtMs: acceptedAt + 30_000
    });
    expect(internals.agentRuntimes.get(self.sessionId)?.lease).toBeDefined();

    internals.runAgentExecutors(acceptedAt + 500);
    expect(internals.agentRuntimes.get(self.sessionId)?.lastReflexAtMs).toBe(acceptedAt + 500);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints[0]?.x).toBe(1_060);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 1, moveY: 0 });
  });

  it("holds a firing band and backs out before the muzzle can cross its target", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-spacing" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Tactical Gunner", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    self.x = 500;
    self.y = 500;
    self.rotation = 0;
    target.x = 825;
    target.y = 500;
    room.state.zone.x = 500;
    room.state.zone.y = 500;
    room.state.zone.radius = 2_000;
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(acceptedAt);

    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints).toEqual([]);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 0, moveY: 0 });
    expect(internals.fireIntents.has(self.sessionId)).toBe(true);

    target.x = 550;
    internals.fireIntents.clear();
    internals.runAgentExecutors(acceptedAt + 100);
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);

    internals.runAgentExecutors(acceptedAt + 500);
    const retreat = internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints[0];
    expect(retreat?.x).toBeLessThan(self.x);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: -1, moveY: 0 });
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
    self.x = retreat!.x;
    self.y = retreat!.z;
    internals.runAgentExecutors(acceptedAt + 550);
    expect(internals.agentRuntimes.get(self.sessionId)?.lastReflexAtMs).toBe(acceptedAt + 500);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: -1, moveY: 0 });

    self.x = target.x;
    self.y = target.y;
    internals.runAgentExecutors(acceptedAt + 1_000);
    const overlapEscape = internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints[0];
    expect(overlapEscape).toMatchObject({ x: 480, z: 500 });
    expect(Number.isFinite(overlapEscape?.x)).toBe(true);
    expect(Number.isFinite(overlapEscape?.z)).toBe(true);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: -1, moveY: 0 });
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
    internals.onSimulationTick(50);
    expect(Math.hypot(self.x - target.x, self.y - target.y)).toBeGreaterThan(0);

    for (const weaponType of Object.keys(WEAPON_CONFIG) as PlayerSchema["weaponType"][]) {
      self.weaponType = weaponType;
      self.fireCooldownMs = 0;
      internals.fireIntents.clear();
      internals.runAgentExecutors(acceptedAt + 1_500 + Object.keys(WEAPON_CONFIG).indexOf(weaponType) * 500);
      expect(internals.fireIntents.has(self.sessionId), weaponType).toBe(false);
    }
  });

  it("uses a bounded direct escape around a wall that blocks straight retreat", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-retreat-blocked" });
    useSyntheticArena(room, [collisionRect("collision-retreat", 400, 450, 50, 100)]);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Pinned Gunner", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    const hostPlayer = room.state.players.get(host.client.sessionId)!;
    self.x = 500;
    self.y = 500;
    self.rotation = 0;
    hostPlayer.x = 1_500;
    hostPlayer.y = 1_500;
    target.x = 570;
    target.y = 500;
    room.state.zone.x = 500;
    room.state.zone.y = 500;
    room.state.zone.radius = 2_000;
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, now + 500)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(now + 500);

    const retreat = internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints?.[0];
    expect(retreat).toBeDefined();
    expect(Math.hypot(retreat!.x - target.x, retreat!.z - target.y))
      .toBeGreaterThan(Math.hypot(self.x - target.x, self.y - target.y));
    expect(Math.hypot(
      (internals.inputIntents.get(self.sessionId) as { moveX: number; moveY: number }).moveX,
      (internals.inputIntents.get(self.sessionId) as { moveX: number; moveY: number }).moveY
    )).toBeGreaterThan(0);
    expect(internals.fireIntents.has(self.sessionId)).toBe(true);
  });

  it("opens a blocked firing lane only while the declared shot is pending", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-firing-lane" });
    const arena = internals.arena!;
    const wall = arena.collisionRects.find((candidate) => candidate.id === "collision-8-6-3x1")!;
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Lane Finder", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    self.x = target.x = 912;
    self.y = 464;
    target.y = 784;
    room.state.zone.x = 912;
    room.state.zone.y = 624;
    room.state.zone.radius = 2_000;
    const now = Date.now() + 1_000;
    const firstObservation = room.agentObserve(session, now);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: firstObservation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, now + 500)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(now + 500);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints).toEqual([]);

    const secondObservation = room.agentObserve(session, now + 500);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 3,
      basedOnObservationSeq: secondObservation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, now + 1_000)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(now + 1_000);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints?.length)
      .toBeGreaterThan(0);
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);

    arena.collisionRects.splice(arena.collisionRects.indexOf(wall), 1);
    internals.runAgentExecutors(now + 1_500);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints).toEqual([]);
    expect(internals.fireIntents.has(self.sessionId)).toBe(true);

    internals.fireIntents.clear();
    self.fireCooldownMs = 0;
    const thirdObservation = room.agentObserve(session, now + 1_500);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 4,
      basedOnObservationSeq: thirdObservation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "single",
      useAbility: false,
      fallback: "hold"
    }, now + 2_000)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(now + 2_000);
    expect(internals.fireIntents.has(self.sessionId)).toBe(true);

    internals.fireIntents.clear();
    arena.collisionRects.push(wall);
    internals.runAgentExecutors(now + 2_500);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints).toEqual([]);
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
  });

  it("separates an exact overlap inward near the safe-zone edge", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-overlap-zone-edge" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Edge Escape", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    self.x = target.x = 890;
    self.y = target.y = 500;
    self.rotation = Math.PI;
    room.state.zone.x = 500;
    room.state.zone.y = 500;
    room.state.zone.radius = 464;
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, now + 500)).toMatchObject({ accepted: true });
    const retreat = internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints?.[0];
    expect(retreat?.x).toBeLessThan(self.x);
    expect(Math.hypot((retreat?.x ?? Infinity) - 500, (retreat?.z ?? Infinity) - 500))
      .toBeLessThanOrEqual(400.001);
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
  });

  it("keeps generated engagement detours inside the safe-zone circle", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "zone-route-0" });
    const arena = generateArenaConfig({ seed: "zone-route-0", playerCount: 16 });
    (room as unknown as { arena: ArenaConfig }).arena = arena;
    const player = new PlayerSchema();
    player.x = 816;
    player.y = 432;
    const routeZone = { x: 1_104, z: 720, radius: 556.16 };
    const route = internals.tacticalRouteStep(
      player,
      { x: 550.6, z: 775.34 },
      true,
      routeZone
    );
    expect(route?.waypoints.length).toBeGreaterThan(0);
    for (const waypoint of route?.waypoints ?? []) {
      expect(Math.hypot(waypoint.x - routeZone.x, waypoint.z - routeZone.z))
        .toBeLessThanOrEqual(routeZone.radius + 0.001);
    }
  });

  it("stages toward each announced survival circle as damaging phases advance", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "tactical-sticky-survival-zone"
    });
    const player = new PlayerSchema();
    Object.assign(player, { x: 500, y: 500 });
    Object.assign(room.state.zone, {
      x: 1_000,
      y: 1_000,
      radius: 1_000,
      targetX: 500,
      targetY: 500,
      targetRadius: 200,
      damagePerSecond: 0
    });
    room.state.zonePhase.warningAt = 10_000;

    expect(internals.agentTacticalSurvivalZone(player, 9_999)).toEqual({
      x: 1_000,
      z: 1_000,
      radius: 1_000,
      safeRadius: 936
    });
    expect(internals.agentTacticalSurvivalZone(player, 10_000)).toEqual({
      x: 500,
      z: 500,
      radius: 200,
      safeRadius: 136
    });

    room.state.matchState = "danger";
    room.state.zone.damagePerSecond = 8;
    room.state.zonePhase.warningAt = 20_000;
    expect(internals.agentTacticalSurvivalZone(player, 10_001)).toEqual({
      x: 500,
      z: 500,
      radius: 200,
      safeRadius: 136
    });
    expect(internals.agentTacticalSurvivalZone(player, 20_000)).toEqual({
      x: 500,
      z: 500,
      radius: 200,
      safeRadius: 32
    });

    room.state.matchState = "final_zone";
    room.state.zone.damagePerSecond = 18;
    room.state.zonePhase.warningAt = 30_000;
    expect(internals.agentTacticalSurvivalZone(player, 20_001)).toEqual({
      x: 500,
      z: 500,
      radius: 200,
      safeRadius: 136
    });
    expect(internals.agentTacticalSurvivalZone(player, 30_000)).toEqual({
      x: 500,
      z: 500,
      radius: 200,
      safeRadius: 32
    });
  });

  it("refreshes the tactical route toward the announced final circle when danger starts", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "full-round-zone-000"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "atlas" });
    room.onJoin(guest.client, { playerName: "Target", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Danger Runner", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const runningStartedAt = room.state.match.stateStartedAt;
    const self = room.state.players.get(session.principal.seatId)!;
    const hostPlayer = room.state.players.get(host.client.sessionId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    Object.assign(self, {
      x: 1_290.0538,
      y: 918.4317,
      rotation: 0,
      velocityX: 0,
      velocityY: 0
    });
    hostPlayer.isAlive = false;
    Object.assign(target, { x: 2_064, y: 1_104, health: 10_000 });
    const observedAt = runningStartedAt + 1_000;
    const observation = room.agentObserve(session, observedAt);
    const acceptedAt = observedAt + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: AGENT_TACTICAL_INTENT_MAX_DURATION_MS,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    expect(room.state.matchState).toBe("running");
    const runtime = internals.agentRuntimes.get(self.sessionId)!;
    runtime.idleDeadlineMs = runningStartedAt + 220_000;

    const dangerAt = runningStartedAt + 90_000;
    vi.spyOn(Date, "now").mockReturnValue(dangerAt);
    internals.advanceTimedLifecycle(dangerAt);

    expect(room.state.matchState).toBe("danger");
    expect(dangerAt).toBeLessThan(room.state.zonePhase.warningAt);
    expect(internals.agentTacticalSurvivalZone(self, dangerAt)).toEqual({
      x: 720,
      z: 720,
      radius: 293.76,
      safeRadius: 229.76
    });
    expect(runtime.lease?.tacticalZoneRecovery).toBe(true);
    expect(runtime.lease?.tacticalZoneTarget).toEqual({
      x: 720,
      z: 720,
      radius: 293.76
    });
    expect(runtime.lease?.action?.waypoints?.length).toBeGreaterThan(0);
    const input = internals.inputIntents.get(self.sessionId) as { moveX: number; moveY: number };
    expect(Math.hypot(input.moveX, input.moveY)).toBeGreaterThan(0);
  });

  it("uses a bounded centre detour when the whole-hull-safe graph is disconnected", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "tactical-reflex-harness-151",
      config: { ...testConfig, agentExpandedCombatantsEnabled: true }
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Zone Detour", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    Object.assign(self, {
      x: 1_686.5281,
      y: 335.0316,
      rotation: 2.9943,
      velocityX: 0,
      velocityY: 0
    });
    Object.assign(target, { x: 2_161.2411, y: 577.2781 });
    Object.assign(room.state.zone, {
      x: 1_139.6821,
      y: 996.9536,
      radius: 993.7579
    });
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, now + 500)).toMatchObject({ accepted: true });

    const route = internals.agentRuntimes.get(self.sessionId)?.lease?.action?.waypoints ?? [];
    expect(route.length).toBeGreaterThan(0);
    expect(route.some((point) => Math.hypot(
      point.x - room.state.zone.x,
      point.z - room.state.zone.y
    ) > room.state.zone.radius - TANK_COLLISION_RADIUS)).toBe(true);
    for (const point of route) {
      expect(Math.hypot(point.x - room.state.zone.x, point.z - room.state.zone.y))
        .toBeLessThanOrEqual(room.state.zone.radius + 8.001);
    }
  });

  it("repairs a stale waypoint immediately when the shrinking zone demands movement", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "tactical-reflex-harness-151",
      config: { ...testConfig, agentExpandedCombatantsEnabled: true }
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Zone Repair", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    Object.assign(self, {
      x: 1_826.3405,
      y: 344.003,
      rotation: 0.3494,
      velocityX: 0,
      velocityY: 0
    });
    Object.assign(target, { x: 2_129.7581, y: 457.4572 });
    Object.assign(room.state.zone, { x: 1_139.0901, y: 998.7296, radius: 987.5596 });
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    const runtime = internals.agentRuntimes.get(self.sessionId)!;
    const wall = internals.arena!.collisionRects[0]!;
    runtime.lease!.action!.waypoints = [{
      x: wall.x + wall.width / 2,
      z: wall.y + wall.height / 2
    }];
    runtime.lease!.waypointIndex = 0;
    runtime.lease!.tacticalContinuation = undefined;
    runtime.lease!.tacticalRetreat = false;
    runtime.lease!.tacticalApproach = false;

    internals.runAgentExecutors(acceptedAt + 100);

    expect(runtime.lastReflexAtMs).toBe(acceptedAt + 100);
    const input = internals.inputIntents.get(self.sessionId) as { moveX: number; moveY: number };
    expect(Math.hypot(input.moveX, input.moveY)).toBeGreaterThan(0);
    expect(runtime.lease?.action?.waypoints?.[0]).not.toEqual({
      x: wall.x + wall.width / 2,
      z: wall.y + wall.height / 2
    });
  });

  it("reverses a stale approach as soon as the live target rushes inside the combat band", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-live-gap" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Gap Guard", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    self.x = 500;
    self.y = 500;
    self.rotation = 0;
    target.x = 1_000;
    target.y = 500;
    room.state.zone.x = 500;
    room.state.zone.y = 500;
    room.state.zone.radius = 2_000;
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(acceptedAt);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 1, moveY: 0 });

    target.x = 825;
    internals.runAgentExecutors(acceptedAt + 50);
    expect(internals.agentRuntimes.get(self.sessionId)?.lastReflexAtMs).toBe(acceptedAt);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 0, moveY: 0 });
    expect(room.agentTacticalStatus(session)).toMatchObject({ active: true, stopReason: "hold" });

    target.x = 550;
    internals.fireIntents.clear();
    internals.runAgentExecutors(acceptedAt + 100);
    expect(internals.agentRuntimes.get(self.sessionId)?.lastReflexAtMs).toBe(acceptedAt);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: -1, moveY: 0 });
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);

    internals.runAgentExecutors(acceptedAt + 500);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: -1, moveY: 0 });
  });

  it("retargets an unselected combatant before crossing it and lands the next clean shot", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-body-guard" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const selectedClient = makeClient("selected1");
    const blockerClient = makeClient("blocker1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "atlas" });
    room.onJoin(selectedClient.client, { playerName: "Selected", archetypeId: "atlas" });
    room.onJoin(blockerClient.client, { playerName: "Blocker", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Body Guard", "tactical_reflex_v1");
    for (const client of [host, selectedClient, blockerClient]) {
      internals.handleReadyMessage(client.client, { ready: true });
    }
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const self = room.state.players.get(session.principal.seatId)!;
    const hostPlayer = room.state.players.get(host.client.sessionId)!;
    const selected = room.state.players.get(selectedClient.client.sessionId)!;
    const blocker = room.state.players.get(blockerClient.client.sessionId)!;
    Object.assign(self, { x: 500, y: 500, rotation: 0, velocityX: 0, velocityY: 0 });
    Object.assign(hostPlayer, { x: 1_500, y: 900, velocityX: 0, velocityY: 0 });
    Object.assign(selected, { x: 1_000, y: 500, velocityX: 0, velocityY: 0 });
    Object.assign(blocker, { x: 1_000, y: 800, velocityX: 0, velocityY: 0 });
    Object.assign(room.state.zone, {
      x: 500,
      y: 500,
      radius: 2_000,
      targetX: 500,
      targetY: 500,
      targetRadius: 2_000,
      damagePerSecond: 0
    });
    const observedAt = Date.now() + 1_000;
    const observation = room.agentObserve(session, observedAt);
    const acceptedAt = observedAt + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_nearest" },
      fire: "hold",
      useAbility: "once",
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    const runtime = internals.agentRuntimes.get(self.sessionId)!;
    expect(runtime.lease?.action?.targetId).toBe(selected.sessionId);

    blocker.x = 570;
    blocker.y = 500;
    internals.runAgentExecutors(acceptedAt);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 0, moveY: 0 });
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
    expect(internals.abilityIntents.has(self.sessionId)).toBe(false);
    expect(runtime.tactical?.selectedTargetId).toBe(blocker.sessionId);
    expect(runtime.lease).toBeUndefined();

    const initialDurability = blocker.health + blocker.armor + blocker.shield;
    let minimumGap = Math.hypot(self.x - blocker.x, self.y - blocker.y);
    const clock = vi.spyOn(Date, "now");
    for (let elapsedMs = 50; elapsedMs <= 2_000; elapsedMs += 50) {
      clock.mockReturnValue(acceptedAt + elapsedMs);
      internals.runAgentExecutors(acceptedAt + elapsedMs);
      internals.onSimulationTick(50);
      minimumGap = Math.min(minimumGap, Math.hypot(self.x - blocker.x, self.y - blocker.y));
      if (blocker.health + blocker.armor + blocker.shield < initialDurability) break;
    }

    expect(runtime.lease?.action?.targetId).toBe(blocker.sessionId);
    expect(minimumGap).toBeGreaterThanOrEqual(TEST_TANK_RADIUS * 2 + 12 - 0.001);
    expect(blocker.health + blocker.armor + blocker.shield).toBeLessThan(initialDurability);
    expect(projectileImpactCalls(room).some(([, payload]) =>
      (payload as { targetSessionId?: string }).targetSessionId === blocker.sessionId
    )).toBe(true);

    Object.assign(self, { x: 500, y: 500, rotation: 0, velocityX: 0, velocityY: 0 });
    Object.assign(selected, { x: 1_000, y: 800, velocityX: 0, velocityY: 0 });
    Object.assign(blocker, { x: 430, y: 500, velocityX: 0, velocityY: 0, isAlive: true });
    const explicitObservedAt = acceptedAt + 3_000;
    const explicitAcceptedAt = explicitObservedAt + 500;
    Object.assign(room.state.zone, {
      x: 200,
      y: 500,
      radius: 200,
      targetX: 200,
      targetY: 500,
      targetRadius: 200,
      damagePerSecond: 0
    });
    room.state.zonePhase.warningAt = explicitAcceptedAt + 30_000;
    self.fireCooldownMs = 0;
    self.abilityCooldownMs = 0;
    self.abilityCharge = 100;
    internals.fireIntents.clear();
    internals.abilityIntents.clear();
    const explicitObservation = room.agentObserve(session, explicitObservedAt);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 3,
      basedOnObservationSeq: explicitObservation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: selected.sessionId },
      fire: "hold",
      useAbility: "once",
      fallback: "hold"
    }, explicitAcceptedAt)).toMatchObject({ accepted: true });

    internals.runAgentExecutors(explicitAcceptedAt);
    expect(runtime.lease?.action?.targetId).toBe(selected.sessionId);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 0, moveY: 0 });
    expect(internals.fireIntents.has(self.sessionId)).toBe(true);
    expect(internals.abilityIntents.has(self.sessionId)).toBe(true);
    let explicitMinimumGap = Math.hypot(self.x - blocker.x, self.y - blocker.y);
    for (let elapsedMs = 50; elapsedMs <= 500; elapsedMs += 50) {
      clock.mockReturnValue(explicitAcceptedAt + elapsedMs);
      internals.runAgentExecutors(explicitAcceptedAt + elapsedMs);
      internals.onSimulationTick(50);
      explicitMinimumGap = Math.min(
        explicitMinimumGap,
        Math.hypot(self.x - blocker.x, self.y - blocker.y)
      );
    }
    expect(runtime.lease?.action?.targetId).toBe(selected.sessionId);
    expect(explicitMinimumGap).toBeGreaterThanOrEqual(TEST_TANK_RADIUS * 2 + 12 - 0.001);
  });

  it("treats a concealed ally as solid without revealing a concealed hostile", async () => {
    const { room, internals } = await makeRoom({ roomMode: "wingman", seed: "tactical-smoke-bodies" });
    useSyntheticArena(room);
    room.state.players.clear();
    const now = Date.now() + 1_000;
    const self = new PlayerSchema();
    Object.assign(self, {
      sessionId: "self",
      archetypeId: "atlas",
      pairId: "pair-a",
      x: 500,
      y: 500,
      rotation: 0,
      velocityX: 0,
      velocityY: 0,
      isAlive: true,
      isSpectator: false
    });
    const ally = new PlayerSchema();
    Object.assign(ally, {
      sessionId: "ally",
      archetypeId: "atlas",
      pairId: "pair-a",
      x: 570,
      y: 500,
      isAlive: true,
      isSpectator: false,
      smokeX: 570,
      smokeY: 500,
      smokeEndsAt: now + 10_000
    });
    const concealedHostile = new PlayerSchema();
    Object.assign(concealedHostile, {
      sessionId: "hostile",
      archetypeId: "atlas",
      pairId: "pair-b",
      x: 570,
      y: 500,
      isAlive: true,
      isSpectator: false,
      smokeX: 570,
      smokeY: 500,
      smokeEndsAt: now + 10_000
    });
    room.state.players.set(self.sessionId, self);
    room.state.players.set(ally.sessionId, ally);
    room.state.players.set(concealedHostile.sessionId, concealedHostile);

    expect(internals.firstTacticalMovementBlocker(self, { moveX: 1, moveY: 0 }, now)?.sessionId)
      .toBe(ally.sessionId);
    ally.x = 1_500;
    ally.y = 1_500;
    expect(internals.firstTacticalMovementBlocker(self, { moveX: 1, moveY: 0 }, now))
      .toBeUndefined();
  });

  it("moves an engaged agent inward before pursuing beyond the damaging zone", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-zone-survival" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Zone Runner", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    const hostPlayer = room.state.players.get(host.client.sessionId)!;
    self.x = 500;
    self.y = 500;
    target.x = 300;
    target.y = 500;
    room.state.zone.x = 1_000;
    room.state.zone.y = 500;
    room.state.zone.radius = 200;
    room.state.zone.targetX = 1_000;
    room.state.zone.targetY = 500;
    room.state.zone.targetRadius = 200;
    room.state.zone.damagePerSecond = 8;
    room.state.matchState = "danger";
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(acceptedAt);

    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action).toMatchObject({
      targetId: target.sessionId,
      fire: "hold"
    });
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints[0]?.x).toBeGreaterThan(self.x);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({
      moveX: 1,
      moveY: 0,
      aimX: 300,
      aimY: 500
    });

    const nextObservation = room.agentObserve(session, acceptedAt + 100);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 3,
      basedOnObservationSeq: nextObservation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_nearest" },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt + 500)).toMatchObject({ accepted: true });
    for (const concealed of [hostPlayer, target]) {
      concealed.smokeX = concealed.x;
      concealed.smokeY = concealed.y;
      concealed.smokeEndsAt = acceptedAt + 10_000;
    }
    internals.runAgentExecutors(acceptedAt + 1_000);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action.targetId).toBeUndefined();
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints[0]?.x).toBeGreaterThan(self.x);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 1, moveY: 0 });

    self.x = room.state.zone.x;
    self.y = room.state.zone.y;
    internals.runAgentExecutors(acceptedAt + 1_500);
    expect(room.agentTacticalStatus(session)).toMatchObject({
      active: false,
      stopReason: "target_unavailable"
    });

    target.smokeEndsAt = 0;
    internals.runAgentExecutors(acceptedAt + 2_000);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action.targetId).toBe(target.sessionId);
    const safeWaypoint = internals.agentRuntimes.get(self.sessionId)?.lease?.action.waypoints[0];
    expect(safeWaypoint).toBeDefined();
    expect(Math.hypot(
      safeWaypoint!.x - room.state.zone.x,
      safeWaypoint!.z - room.state.zone.y
    )).toBeLessThanOrEqual(room.state.zone.radius - 64 + 0.001);
    expect(room.agentTacticalStatus(session).active).toBe(true);
  });

  it("moves around a close blocker instead of freezing outside the damaging zone", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-zone-blocker" });
    const arena = useSyntheticArena(room, [
      collisionRect("collision-left-tangent", 450, 535, 100, 100)
    ]);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Zone Orbit", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    self.x = 500;
    self.y = 500;
    self.rotation = 0;
    target.x = 600;
    target.y = 500;
    room.state.zone.x = 1_000;
    room.state.zone.y = 500;
    room.state.zone.radius = 200;
    room.state.zone.targetX = 1_000;
    room.state.zone.targetY = 500;
    room.state.zone.targetRadius = 200;
    room.state.zone.damagePerSecond = 8;
    room.state.matchState = "danger";
    Object.assign(arena.zonePhases.find((phase) => phase.matchState === "danger")!, {
      x: 1_000,
      y: 500,
      radius: 200,
      targetX: 1_000,
      targetY: 500,
      targetRadius: 200
    });
    const initialZoneDistance = Math.hypot(self.x - room.state.zone.x, self.y - room.state.zone.y);
    const initialTargetDistance = Math.hypot(self.x - target.x, self.y - target.y);
    let minimumTargetDistance = initialTargetDistance;
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(acceptedAt);
    const firstInput = internals.inputIntents.get(self.sessionId) as { moveX: number; moveY: number };
    expect(Math.hypot(firstInput.moveX, firstInput.moveY)).toBeGreaterThan(0);
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);

    for (let elapsedMs = 50; elapsedMs <= 2_000; elapsedMs += 50) {
      internals.onSimulationTick(50);
      minimumTargetDistance = Math.min(
        minimumTargetDistance,
        Math.hypot(self.x - target.x, self.y - target.y)
      );
      expect(isWallCollision(internals.arena!, self.x, self.y, TEST_TANK_RADIUS)).toBe(false);
      internals.runAgentExecutors(acceptedAt + elapsedMs);
    }
    expect(Math.hypot(self.x - room.state.zone.x, self.y - room.state.zone.y))
      .toBeLessThan(initialZoneDistance);
    expect(minimumTargetDistance)
      .toBeGreaterThanOrEqual(TEST_TANK_RADIUS * 2 + 12 - 0.001);
    expect(isWallCollision(internals.arena!, self.x, self.y, TEST_TANK_RADIUS)).toBe(false);

    self.x = 500;
    self.y = 500;
    self.rotation = 0;
    self.velocityX = 0;
    self.velocityY = 0;
    target.x = 600;
    target.y = 500;
    arena.collisionRects.push(collisionRect("collision-right-tangent", 450, 365, 100, 100));
    const blockedStartZoneDistance = Math.hypot(self.x - room.state.zone.x, self.y - room.state.zone.y);
    let minimumBlockedTargetDistance = Math.hypot(self.x - target.x, self.y - target.y);
    for (let elapsedMs = 2_500; elapsedMs <= 4_500; elapsedMs += 50) {
      internals.runAgentExecutors(acceptedAt + elapsedMs);
      internals.onSimulationTick(50);
      minimumBlockedTargetDistance = Math.min(
        minimumBlockedTargetDistance,
        Math.hypot(self.x - target.x, self.y - target.y)
      );
      expect(isWallCollision(internals.arena!, self.x, self.y, TEST_TANK_RADIUS)).toBe(false);
    }
    expect(Math.hypot(self.x - room.state.zone.x, self.y - room.state.zone.y))
      .toBeLessThan(blockedStartZoneDistance);
    expect(minimumBlockedTargetDistance).toBeGreaterThanOrEqual(TEST_TANK_RADIUS * 2 + 12 - 0.001);
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
  });

  it("uses live zone demand when an older hold lease straddles the safety margin", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "tactical-reflex-harness-151",
      config: { ...testConfig, agentExpandedCombatantsEnabled: true }
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Target", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Margin Runner", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const self = room.state.players.get(session.principal.seatId)!;
    const hostPlayer = room.state.players.get(host.client.sessionId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    Object.assign(self, {
      x: 1_870.4,
      y: 391.909,
      rotation: -1.61069,
      velocityX: 0,
      velocityY: 0
    });
    hostPlayer.isAlive = false;
    Object.assign(target, {
      x: 1_994.425,
      y: 466.488,
      health: 10_000,
      velocityX: 0,
      velocityY: 0
    });
    Object.assign(room.state.zone, {
      x: 1_140.953,
      y: 993.142,
      radius: 1_010,
      targetX: 1_140.953,
      targetY: 993.142,
      targetRadius: 1_010,
      damagePerSecond: 0
    });
    const observedAt = Date.now() + 1_000;
    const acceptedAt = observedAt + 500;
    room.state.zonePhase.warningAt = acceptedAt + 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(acceptedAt);
    const observation = room.agentObserve(session, observedAt);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_nearest" },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    const runtime = internals.agentRuntimes.get(self.sessionId)!;
    expect(runtime.lease?.tacticalZoneRecovery).toBe(false);
    expect(runtime.lease?.action?.waypoints).toEqual([]);

    room.state.zone.radius = 1_007.059;
    room.state.zone.targetRadius = 1_007.059;
    const initialZoneDistance = Math.hypot(
      self.x - room.state.zone.x,
      self.y - room.state.zone.y
    );
    expect(initialZoneDistance).toBeGreaterThan(room.state.zone.radius - 64);

    const roomInternals = internals as RoomInternals & {
      resolveArenaMovement(
        arena: ArenaConfig,
        currentX: number,
        currentY: number,
        desiredX: number,
        desiredY: number,
        radius: number
      ): { x: number; y: number };
    };
    const originalResolve = roomInternals.resolveArenaMovement.bind(roomInternals);
    let wallAdjustments = 0;
    roomInternals.resolveArenaMovement = (...args) => {
      const resolved = originalResolve(...args);
      if (Math.hypot(resolved.x - args[3], resolved.y - args[4]) > 0.001) {
        wallAdjustments += 1;
      }
      return resolved;
    };

    clock.mockReturnValue(acceptedAt + 50);
    internals.runAgentExecutors(acceptedAt + 50);
    const input = internals.inputIntents.get(self.sessionId) as { moveX: number; moveY: number };
    expect(Math.hypot(input.moveX, input.moveY)).toBeGreaterThan(0.04);
    expect(runtime.lease?.tacticalZoneRecovery).toBe(false);
    internals.onSimulationTick(50);

    expect(Math.hypot(self.x - room.state.zone.x, self.y - room.state.zone.y))
      .toBeLessThan(initialZoneDistance);
    expect(Math.hypot(self.x - target.x, self.y - target.y))
      .toBeGreaterThanOrEqual(TEST_TANK_RADIUS * 2 + 12 - 0.001);
    expect(isWallCollision(internals.arena!, self.x, self.y, TEST_TANK_RADIUS)).toBe(false);
    expect(wallAdjustments).toBe(0);
  });

  it("follows a forecast-zone detour past a close target without touching or firing", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "tactical-reflex-harness-151",
      config: { ...testConfig, agentExpandedCombatantsEnabled: true }
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Target", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Forecast Runner", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    Object.assign(self, {
      x: 1_868.5635986,
      y: 377.4662781,
      rotation: -2.02923179,
      velocityX: 0,
      velocityY: 0
    });
    Object.assign(target, {
      x: 1_973.8123779,
      y: 566.2518311,
      health: 10_000,
      velocityX: 0,
      velocityY: 0
    });
    const zone = {
      x: 1_141.3791504,
      y: 991.8624268,
      radius: 1_011.5264282,
      targetX: 1_104,
      targetY: 1_104,
      targetRadius: 620.16,
      damagePerSecond: 0
    };
    Object.assign(room.state.zone, zone);
    const now = Date.now() + 1_000;
    room.state.zonePhase.warningAt = now;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });

    const runtime = internals.agentRuntimes.get(self.sessionId)!;
    expect(runtime.lease?.tacticalZoneRecovery).toBe(true);
    expect(runtime.lease?.action?.waypoints?.[0]).toEqual({ x: 1_872, z: 432 });
    internals.runAgentExecutors(acceptedAt);
    const firstInput = internals.inputIntents.get(self.sessionId) as { moveX: number; moveY: number };
    expect(Math.hypot(firstInput.moveX, firstInput.moveY)).toBeGreaterThan(0);
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);

    const initialForecastDistance = Math.hypot(self.x - zone.targetX, self.y - zone.targetY);
    let minimumTargetDistance = Math.hypot(self.x - target.x, self.y - target.y);
    let stationaryRunMs = 0;
    let maximumStationaryRunMs = 0;
    const clock = vi.spyOn(Date, "now");
    for (let elapsedMs = 0; elapsedMs <= 2_000; elapsedMs += 50) {
      const tickNow = acceptedAt + elapsedMs;
      clock.mockReturnValue(tickNow);
      Object.assign(room.state.zone, zone);
      room.state.zonePhase.warningAt = now;
      internals.runAgentExecutors(tickNow);
      const before = { x: self.x, y: self.y, rotation: self.rotation };
      internals.onSimulationTick(50);
      Object.assign(room.state.zone, zone);
      const moved = Math.hypot(self.x - before.x, self.y - before.y) > 0.001;
      const turned = Math.abs(Math.atan2(
        Math.sin(self.rotation - before.rotation),
        Math.cos(self.rotation - before.rotation)
      )) > 0.0001;
      stationaryRunMs = moved || turned ? 0 : stationaryRunMs + 50;
      maximumStationaryRunMs = Math.max(maximumStationaryRunMs, stationaryRunMs);
      minimumTargetDistance = Math.min(
        minimumTargetDistance,
        Math.hypot(self.x - target.x, self.y - target.y)
      );
      expect(isWallCollision(internals.arena!, self.x, self.y, TEST_TANK_RADIUS)).toBe(false);
    }

    expect(maximumStationaryRunMs).toBeLessThanOrEqual(150);
    expect(minimumTargetDistance).toBeGreaterThanOrEqual(TEST_TANK_RADIUS * 2 + 12 - 0.001);
    expect(Math.hypot(self.x - zone.targetX, self.y - zone.targetY))
      .toBeLessThan(initialForecastDistance);
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
  });

  it("replans a retained forecast route when its live target crosses a later segment", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "full-round-zone-000"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Target", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Route Watcher", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    Object.assign(self, {
      x: 1_940.485,
      y: 516.229,
      rotation: -2.561,
      velocityX: 0,
      velocityY: 0
    });
    Object.assign(target, { x: 2_256, y: 624, health: 10_000 });
    Object.assign(room.state.zone, {
      x: 1_136,
      y: 880,
      radius: 955,
      targetX: 1_104,
      targetY: 912,
      targetRadius: 620.16,
      damagePerSecond: 0
    });
    const observedAt = Date.now() + 1_000;
    room.state.zonePhase.warningAt = observedAt;
    const observation = room.agentObserve(session, observedAt);
    const acceptedAt = observedAt + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });

    const runtime = internals.agentRuntimes.get(self.sessionId)!;
    const originalSequence = runtime.lease?.action?.actionSeq ?? 0;
    const originalWaypoints = runtime.lease?.action?.waypoints ?? [];
    expect(originalWaypoints.length).toBeGreaterThan(1);
    const blockedSegmentStart = originalWaypoints.at(-2)!;
    const blockedSegmentEnd = originalWaypoints.at(-1)!;
    target.x = (blockedSegmentStart.x + blockedSegmentEnd.x) / 2;
    target.y = (blockedSegmentStart.z + blockedSegmentEnd.z) / 2;

    internals.runAgentExecutors(acceptedAt + 250);
    expect(runtime.lease?.action?.actionSeq).toBe(originalSequence);
    internals.runAgentExecutors(acceptedAt + 500);

    expect(runtime.lease?.action?.actionSeq).toBeGreaterThan(originalSequence);
    const replacementWaypoints = runtime.lease?.action?.waypoints ?? [];
    expect(replacementWaypoints.length).toBeGreaterThan(0);
    let segmentStart = { x: self.x, z: self.y };
    for (const waypoint of replacementWaypoints) {
      expect(distanceFromPointToSegment(
        { x: target.x, z: target.y },
        segmentStart,
        waypoint
      )).toBeGreaterThanOrEqual(TEST_TANK_RADIUS * 2 + 12 - 0.001);
      segmentStart = waypoint;
    }
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
  });

  it("drops a retained recovery route when the selected survival circle changes", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "full-round-zone-000"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Target", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Zone Watcher", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    Object.assign(self, {
      x: 1_940.485,
      y: 516.229,
      rotation: -2.561,
      velocityX: 0,
      velocityY: 0
    });
    Object.assign(target, { x: 2_256, y: 624, health: 10_000 });
    Object.assign(room.state.zone, {
      x: 1_136,
      y: 880,
      radius: 955,
      targetX: 1_104,
      targetY: 912,
      targetRadius: 620.16,
      damagePerSecond: 0
    });
    const observedAt = Date.now() + 1_000;
    room.state.zonePhase.warningAt = observedAt;
    const observation = room.agentObserve(session, observedAt);
    const acceptedAt = observedAt + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });

    const runtime = internals.agentRuntimes.get(self.sessionId)!;
    const originalSequence = runtime.lease?.action?.actionSeq ?? 0;
    expect(runtime.lease?.tacticalZoneTarget).toEqual({
      x: 1_104,
      z: 912,
      radius: 620.16
    });
    Object.assign(room.state.zone, {
      targetX: 1_200,
      targetY: 720,
      targetRadius: 500
    });
    internals.runAgentExecutors(acceptedAt + 500);

    expect(runtime.lease?.action?.actionSeq).toBeGreaterThan(originalSequence);
    expect(runtime.lease?.tacticalZoneTarget).toEqual({
      x: 1_200,
      z: 720,
      radius: 500
    });
  });

  it("bounds zone detours before widening only enough to clear a real wall pocket", async () => {
    const strict = await makeRoom({
      roomMode: "open_ffa",
      seed: "audit-zone-tiers-0",
      config: { ...testConfig, agentExpandedCombatantsEnabled: true }
    });
    const strictPlayer = new PlayerSchema();
    Object.assign(strictPlayer, { archetypeId: "nova", x: 2_064, y: 816, rotation: 0 });
    const strictCenter = { x: 1_272, z: 600 };
    const strictStartRadius = Math.hypot(
      strictPlayer.x - strictCenter.x,
      strictPlayer.y - strictCenter.z
    );
    const strictRoute = strict.internals.tacticalZoneRecoveryRoute(strictPlayer, strictCenter);
    expect(strictRoute?.waypoints).toEqual([
      { x: 1_968, z: 816 },
      { x: 1_968, z: 912 },
      { x: 1_968, z: 1_008 },
      { x: 1_872, z: 1_008 }
    ]);
    for (const point of strictRoute?.waypoints ?? []) {
      expect(Math.hypot(point.x - strictCenter.x, point.z - strictCenter.z))
        .toBeLessThanOrEqual(strictStartRadius + 8.001);
    }

    const widened = await makeRoom({
      roomMode: "open_ffa",
      seed: "escape-radial-0",
      config: { ...testConfig, agentExpandedCombatantsEnabled: true }
    });
    const widenedPlayer = new PlayerSchema();
    Object.assign(widenedPlayer, {
      archetypeId: "nova",
      x: 931.2714633710613,
      y: 980.626715011352,
      rotation: -2.914304632377136
    });
    const widenedCenter = { x: 1_488, z: 1_104 };
    const widenedStartRadius = Math.hypot(
      widenedPlayer.x - widenedCenter.x,
      widenedPlayer.y - widenedCenter.z
    );
    const widenedRoute = widened.internals.tacticalZoneRecoveryRoute(widenedPlayer, widenedCenter);
    expect(widenedRoute?.waypoints.length).toBeGreaterThan(0);
    expect(Math.max(...(widenedRoute?.waypoints ?? []).map((point) =>
      Math.hypot(point.x - widenedCenter.x, point.z - widenedCenter.z)
    ))).toBeGreaterThan(widenedStartRadius + 32);
    for (const point of widenedRoute?.waypoints ?? []) {
      expect(Math.hypot(point.x - widenedCenter.x, point.z - widenedCenter.z))
        .toBeLessThanOrEqual(widenedStartRadius + 64.001);
    }
  });

  it("routes a forecast-zone detour around the target's quantized clearance envelope", async () => {
    const { internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "expanded-full-round-zone-000",
      config: { ...testConfig, agentExpandedCombatantsEnabled: true }
    });
    const player = new PlayerSchema();
    Object.assign(player, {
      archetypeId: "quill",
      x: 1_556.522609,
      y: 1_468.431619,
      rotation: 0.327356
    });
    const target = { x: 1_488, z: 1_488 };
    const exactClearance = TEST_TANK_RADIUS * 2 + 12;
    const projectedClearance = exactClearance + Math.SQRT2 * 12.5;
    const route = internals.tacticalZoneRecoveryRoute(
      player,
      { x: 1_200, z: 720 },
      { ...target, radius: projectedClearance }
    );

    expect(route?.waypoints.length).toBeGreaterThan(0);
    const waypoints = route?.waypoints ?? [];
    let segmentStart = { x: player.x, z: player.y };
    for (const waypoint of waypoints) {
      expect(distanceFromPointToSegment(target, segmentStart, waypoint))
        .toBeGreaterThanOrEqual(exactClearance - 0.001);
      segmentStart = waypoint;
    }
    expect(Math.hypot(waypoints[0]!.x - target.x, waypoints[0]!.z - target.z))
      .toBeGreaterThanOrEqual(projectedClearance - 0.001);
    expect(waypoints).not.toContainEqual(target);
  });

  it("clears a combatant that disconnects the only forecast-zone route", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "expanded-full-round-zone-000",
      config: { ...testConfig, agentExpandedCombatantsEnabled: true }
    });
    const host = makeClient("host1");
    const selectedClient = makeClient("selected1");
    const blockerClient = makeClient("blocker1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "atlas" });
    room.onJoin(selectedClient.client, { playerName: "Selected", archetypeId: "atlas" });
    room.onJoin(blockerClient.client, { playerName: "Blocker", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Corridor Breacher", "tactical_reflex_v1");
    for (const client of [host, selectedClient, blockerClient]) {
      internals.handleReadyMessage(client.client, { ready: true });
    }
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const self = room.state.players.get(session.principal.seatId)!;
    const hostPlayer = room.state.players.get(host.client.sessionId)!;
    const selected = room.state.players.get(selectedClient.client.sessionId)!;
    const blocker = room.state.players.get(blockerClient.client.sessionId)!;
    Object.assign(self, {
      x: 547.406235,
      y: 557.486025,
      rotation: -1.716616,
      velocityX: 0,
      velocityY: 0
    });
    Object.assign(hostPlayer, { x: 2_200, y: 1_500, velocityX: 0, velocityY: 0 });
    Object.assign(selected, { x: 914.947173, y: 335.713387, velocityX: 0, velocityY: 0 });
    Object.assign(blocker, { x: 798.847049, y: 341.53896, velocityX: 0, velocityY: 0 });
    Object.assign(room.state.zone, {
      x: 1_200,
      y: 752,
      radius: 955.205333,
      targetX: 1_200,
      targetY: 720,
      targetRadius: 620.16,
      damagePerSecond: 0
    });
    room.state.matchState = "running";

    const initialZoneDistance = Math.hypot(self.x - 1_200, self.y - 720);
    const targetEnvelope = {
      x: 925,
      z: 325,
      radius: TEST_TANK_RADIUS * 2 + 12 + Math.SQRT2 * 12.5
    };
    expect(internals.tacticalZoneRecoveryRoute(
      self,
      { x: 1_200, z: 720 },
      targetEnvelope
    )).toBeUndefined();
    const clearRoute = internals.tacticalRouteStep(self, { x: 1_200, z: 720 });
    expect(clearRoute?.waypoints).toEqual([
      { x: 528, z: 432 },
      { x: 528, z: 336 },
      { x: 624, z: 336 },
      { x: 720, z: 336 }
    ]);
    expect(internals.tacticalZoneRecoveryRoute(
      self,
      { x: 1_200, z: 720 },
      targetEnvelope,
      true
    )?.waypoints).toEqual(clearRoute?.waypoints);

    const observedAt = Date.now() + 1_000;
    const acceptedAt = observedAt + 500;
    room.state.zonePhase.warningAt = acceptedAt;
    const observation = room.agentObserve(session, observedAt);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_nearest" },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    const runtime = internals.agentRuntimes.get(self.sessionId)!;
    runtime.tactical!.selectedTargetId = selected.sessionId;
    runtime.lease = undefined;
    runtime.lastReflexAtMs = 0;

    const originalMovementBlocker = internals.firstTacticalMovementBlocker.bind(internals);
    let firstBlockerAt: number | undefined;
    internals.firstTacticalMovementBlocker = (player, input, now) => {
      const result = originalMovementBlocker(player, input, now);
      if (player === self && result === blocker) firstBlockerAt ??= now;
      return result;
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(acceptedAt);
    internals.runAgentExecutors(acceptedAt);
    const initialInput = internals.inputIntents.get(self.sessionId) as { moveX: number; moveY: number };
    expect(Math.hypot(initialInput.moveX, initialInput.moveY)).toBeGreaterThan(0);

    const initialDurability = blocker.health + blocker.armor + blocker.shield;
    let minimumGap = Math.hypot(self.x - blocker.x, self.y - blocker.y);
    let retargetedAt: number | undefined;
    let impactAt: number | undefined;
    for (let elapsedMs = 50; elapsedMs <= 5_000; elapsedMs += 50) {
      clock.mockReturnValue(acceptedAt + elapsedMs);
      internals.onSimulationTick(50);
      minimumGap = Math.min(minimumGap, Math.hypot(self.x - blocker.x, self.y - blocker.y));
      expect(isWallCollision(internals.arena!, self.x, self.y, TEST_TANK_RADIUS)).toBe(false);
      if (
        impactAt === undefined &&
        blocker.health + blocker.armor + blocker.shield < initialDurability
      ) {
        impactAt = acceptedAt + elapsedMs;
        expect(room.state.projectiles).toHaveLength(0);
      }
      internals.runAgentExecutors(acceptedAt + elapsedMs);
      if (runtime.tactical?.selectedTargetId === blocker.sessionId) {
        retargetedAt ??= acceptedAt + elapsedMs;
      }
      if (impactAt !== undefined) break;
    }

    expect(firstBlockerAt).toBeDefined();
    expect(retargetedAt).toBe(firstBlockerAt);
    expect(minimumGap).toBeGreaterThanOrEqual(TEST_TANK_RADIUS * 2 + 12 - 0.001);
    expect(impactAt).toBeDefined();
    expect(projectileImpactCalls(room).some(([, payload]) =>
      (payload as { targetSessionId?: string }).targetSessionId === blocker.sessionId
    )).toBe(true);
    expect(Math.hypot(self.x - 1_200, self.y - 720)).toBeLessThan(initialZoneDistance);
  });

  it("chooses a forecast-zone first hop that the current drivetrain can execute", async () => {
    const { internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "full-round-zone-000"
    });
    const player = new PlayerSchema();
    Object.assign(player, {
      archetypeId: "nova",
      x: 2_236.963,
      y: 354.945,
      rotation: 2.782,
      velocityX: 0,
      velocityY: 0
    });
    const target = { x: 2_256, z: 624 };
    const projectedClearance = TEST_TANK_RADIUS * 2 + 12 + Math.SQRT2 * 12.5;
    const route = internals.tacticalZoneRecoveryRoute(
      player,
      { x: 1_104, z: 912 },
      { ...target, radius: projectedClearance }
    );

    expect(route?.waypoints.length).toBeGreaterThan(0);
    expect(internals.validAgentMovementHorizon(
      player,
      route!.waypoints[0]!,
      (state) => Math.hypot(state.x - target.x, state.y - target.z) >= projectedClearance - 0.001
    )).toBe(true);
  });

  it("executes the rotated forecast-zone detour instead of freezing on its first edge", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "full-round-zone-000"
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Target", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Rotated Runner", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    Object.assign(self, {
      x: 2_236.963,
      y: 354.945,
      rotation: 2.782,
      velocityX: 0,
      velocityY: 0
    });
    Object.assign(target, {
      x: 2_256,
      y: 624,
      health: 10_000,
      velocityX: 0,
      velocityY: 0
    });
    const zone = {
      x: 1_136,
      y: 880,
      radius: 955,
      targetX: 1_104,
      targetY: 912,
      targetRadius: 620.16,
      damagePerSecond: 0
    };
    Object.assign(room.state.zone, zone);
    const observedAt = Date.now() + 1_000;
    room.state.zonePhase.warningAt = observedAt;
    const observation = room.agentObserve(session, observedAt);
    const acceptedAt = observedAt + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });

    const initialZoneDistance = Math.hypot(self.x - zone.targetX, self.y - zone.targetY);
    let minimumTargetDistance = Math.hypot(self.x - target.x, self.y - target.y);
    let stationaryRunMs = 0;
    let maximumStationaryRunMs = 0;
    const clock = vi.spyOn(Date, "now");
    for (let elapsedMs = 0; elapsedMs <= 2_000; elapsedMs += 50) {
      const tickNow = acceptedAt + elapsedMs;
      clock.mockReturnValue(tickNow);
      Object.assign(room.state.zone, zone);
      room.state.zonePhase.warningAt = observedAt;
      internals.runAgentExecutors(tickNow);
      const before = { x: self.x, y: self.y, rotation: self.rotation };
      internals.onSimulationTick(50);
      Object.assign(room.state.zone, zone);
      const moved = Math.hypot(self.x - before.x, self.y - before.y) > 0.001;
      const turned = Math.abs(Math.atan2(
        Math.sin(self.rotation - before.rotation),
        Math.cos(self.rotation - before.rotation)
      )) > 0.0001;
      stationaryRunMs = moved || turned ? 0 : stationaryRunMs + 50;
      maximumStationaryRunMs = Math.max(maximumStationaryRunMs, stationaryRunMs);
      minimumTargetDistance = Math.min(
        minimumTargetDistance,
        Math.hypot(self.x - target.x, self.y - target.y)
      );
      expect(isWallCollision(internals.arena!, self.x, self.y, TEST_TANK_RADIUS)).toBe(false);
    }

    expect(maximumStationaryRunMs).toBeLessThanOrEqual(150);
    expect(minimumTargetDistance).toBeGreaterThanOrEqual(TEST_TANK_RADIUS * 2 + 12 - 0.001);
    expect(Math.hypot(self.x - zone.targetX, self.y - zone.targetY))
      .toBeLessThan(initialZoneDistance);
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
  });

  it("escapes an exact close-zone trap without ramming or touching a wall", async () => {
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "escape-radial-0",
      config: { ...testConfig, agentExpandedCombatantsEnabled: true }
    });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Target", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Zone Escape", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    Object.assign(self, {
      x: 624,
      y: 144,
      rotation: 2.408777551803287,
      velocityX: 0,
      velocityY: 0,
      health: 10_000,
      armor: 0,
      shield: 0
    });
    Object.assign(target, { x: 690.896473162245, y: 218.3294146247166 });
    const zone = {
      x: 1_008,
      y: 336,
      radius: 620.16,
      targetX: 1_488,
      targetY: 1_104,
      targetRadius: 293.76,
      damagePerSecond: 18
    };
    Object.assign(room.state.zone, zone);
    room.state.matchState = "danger";
    const now = Date.now() + 1_000;
    room.state.zonePhase.warningAt = now;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });

    const initialZoneDistance = Math.hypot(self.x - zone.targetX, self.y - zone.targetY);
    let minimumTargetDistance = Math.hypot(self.x - target.x, self.y - target.y);
    let movingTicks = 0;
    const clock = vi.spyOn(Date, "now");
    for (let elapsedMs = 0; elapsedMs <= 15_000; elapsedMs += 50) {
      const tickNow = acceptedAt + elapsedMs;
      clock.mockReturnValue(tickNow);
      Object.assign(room.state.zone, zone);
      internals.runAgentExecutors(tickNow);
      const before = { x: self.x, y: self.y };
      internals.onSimulationTick(50);
      Object.assign(room.state.zone, zone);
      if (Math.hypot(self.x - before.x, self.y - before.y) > 0.001) movingTicks += 1;
      minimumTargetDistance = Math.min(
        minimumTargetDistance,
        Math.hypot(self.x - target.x, self.y - target.y)
      );
      expect(isWallCollision(internals.arena!, self.x, self.y, TEST_TANK_RADIUS)).toBe(false);
    }
    expect(movingTicks).toBeGreaterThanOrEqual(40);
    expect(minimumTargetDistance).toBeGreaterThanOrEqual(TEST_TANK_RADIUS * 2 + 12 - 0.001);
    expect(Math.hypot(self.x - zone.targetX, self.y - zone.targetY))
      .toBeLessThan(initialZoneDistance - 800);
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
  });

  it("repositions for the announced next circle before the closing zone becomes lethal", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "escape-radial-0" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Target", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Zone Planner", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const arena = readArenaConfig(room);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    const selfSpawn = arena.spawnPoints[6]!;
    const targetSpawn = arena.spawnPoints[7]!;
    Object.assign(self, {
      x: selfSpawn.x,
      y: selfSpawn.y,
      rotation: selfSpawn.rotation,
      velocityX: 0,
      velocityY: 0
    });
    Object.assign(target, {
      x: targetSpawn.x,
      y: targetSpawn.y,
      velocityX: 0,
      velocityY: 0,
      health: 10_000
    });

    const runningStartedAt = room.state.match.stateStartedAt;
    const observedAt = runningStartedAt + 1;
    const observation = room.agentObserve(session, observedAt);
    const acceptedAt = observedAt + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: AGENT_TACTICAL_INTENT_MAX_DURATION_MS,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    internals.agentRuntimes.get(self.sessionId)!.idleDeadlineMs = runningStartedAt + 220_000;

    let minimumTargetDistance = Math.hypot(self.x - target.x, self.y - target.y);
    const clock = vi.spyOn(Date, "now");
    for (let elapsedMs = 0; elapsedMs <= 209_400; elapsedMs += 50) {
      const now = acceptedAt + elapsedMs;
      clock.mockReturnValue(now);
      internals.runAgentExecutors(now);
      internals.onSimulationTick(50);
      minimumTargetDistance = Math.min(
        minimumTargetDistance,
        Math.hypot(self.x - target.x, self.y - target.y)
      );
      expect(isWallCollision(arena, self.x, self.y, TEST_TANK_RADIUS)).toBe(false);
    }

    const finalSafeRadius = room.state.zone.targetRadius - AGENT_TACTICAL_ZONE_SAFETY_MARGIN;
    expect(self.isAlive).toBe(true);
    expect(self.health).toBeGreaterThanOrEqual(90);
    expect(Math.hypot(self.x - room.state.zone.targetX, self.y - room.state.zone.targetY))
      .toBeLessThanOrEqual(finalSafeRadius + 0.001);
    expect(minimumTargetDistance).toBeGreaterThanOrEqual(TEST_TANK_RADIUS * 2 + 12);
  });

  it("retargets a nearer route blocker, then reports and recovers when it becomes invalid", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-nearest" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const firstGuest = makeClient("guest1");
    const secondGuest = makeClient("guest2");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(firstGuest.client, { playerName: "First", archetypeId: "quill" });
    room.onJoin(secondGuest.client, { playerName: "Second", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Tactical Hunter", "tactical_reflex_v1");
    for (const client of [host, firstGuest, secondGuest]) {
      internals.handleReadyMessage(client.client, { ready: true });
    }
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const hostPlayer = room.state.players.get(host.client.sessionId)!;
    const first = room.state.players.get(firstGuest.client.sessionId)!;
    const second = room.state.players.get(secondGuest.client.sessionId)!;
    self.x = 500;
    self.y = 500;
    hostPlayer.x = 1_500;
    hostPlayer.y = 1_500;
    first.x = 650;
    first.y = 500;
    second.x = 800;
    second.y = 500;
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_nearest" },
      fire: "hold",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action?.targetId).toBe(first.sessionId);

    first.x = 1_000;
    second.x = 550;
    internals.runAgentExecutors(acceptedAt + 500);
    expect(internals.agentRuntimes.get(self.sessionId)?.tactical?.selectedTargetId).toBe(second.sessionId);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease).toBeUndefined();

    internals.runAgentExecutors(acceptedAt + 550);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action?.targetId).toBe(second.sessionId);

    second.isAlive = false;
    internals.runAgentExecutors(acceptedAt + 600);
    const unavailable = room.agentTacticalStatus(session);
    expect(unavailable).toMatchObject({ active: false, stopReason: "target_unavailable" });
    expect(isAgentTacticalStatusV1(unavailable, {
      roomId: room.roomId,
      seatId: self.sessionId
    })).toBe(true);

    internals.runAgentExecutors(acceptedAt + 1_050);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action?.targetId).toBe(first.sessionId);
    expect(room.agentTacticalStatus(session)).toMatchObject({ active: true, stopReason: "moving" });
  });

  it("steers a real tank around a generated right-angle route without clipping the wall", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "audit-turn-0" });
    const arena = generateArenaConfig({ seed: "audit-turn-0", playerCount: 16 });
    (room as unknown as { arena: ArenaConfig }).arena = arena;
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Corner Runner", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const start = arena.spawnPoints[4]!;
    const destination = arena.spawnPoints[5]!;
    self.archetypeId = "nova";
    self.x = start.x;
    self.y = start.y;
    self.rotation = start.rotation;
    self.velocityX = 0;
    self.velocityY = 0;
    expect(internals.tacticalRouteStep(self, { x: destination.x, z: destination.y })?.waypoints)
      .toEqual([
        { x: 720, z: 336 },
        { x: 816, z: 336 },
        { x: 912, z: 336 },
        { x: 912, z: 432 }
      ]);

    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "move_to", position: { x: destination.x, z: destination.y } },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });

    const clock = vi.spyOn(Date, "now");
    for (let elapsed = 50; elapsed <= 2_500; elapsed += 50) {
      clock.mockReturnValue(acceptedAt + elapsed);
      internals.runAgentExecutors(acceptedAt + elapsed);
      internals.onSimulationTick(50);
    }

    expect(internals.debugAgentAuditSnapshot()).not.toContainEqual(expect.objectContaining({
      event: "executor_neutral",
      seatId: self.sessionId,
      reason: "route_blocked"
    }));
    expect(internals.agentRuntimes.get(self.sessionId)?.tactical).toBeDefined();
    expect(self.x).toBeGreaterThan(880);
    expect(self.y).toBeGreaterThan(350);
  });

  it("keeps conservative long-route clearance at a rounded wall corner", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "audit-turn-45" });
    const arena = generateArenaConfig({ seed: "audit-turn-45", playerCount: 16 });
    (room as unknown as { arena: ArenaConfig }).arena = arena;
    const player = new PlayerSchema();
    player.x = 1_136.2189;
    player.y = 164.0807;

    expect(isWallCollision(arena, player.x, player.y, TEST_TANK_RADIUS)).toBe(false);
    expect(internals.tacticalRouteStep(player, { x: 816, z: 240 })?.waypoints[0]).toEqual({
      x: 1_104,
      z: 144
    });
  });

  it("accepts a physically clear executor retreat at a rounded wall corner", async () => {
    const { internals } = await makeRoom({
      roomMode: "open_ffa",
      seed: "tactical-reflex-harness-151",
      config: { ...testConfig, agentExpandedCombatantsEnabled: true }
    });
    const player = new PlayerSchema();
    player.x = 1_862.9916;
    player.y = 368.9614;
    const retreat = { x: 1_830.6133, z: 353.4979 };

    expect(isWallCollision(internals.arena!, player.x, player.y, TEST_TANK_RADIUS)).toBe(false);
    expect(internals.tacticalRouteStep(player, retreat, false)).toBeUndefined();
    expect(internals.validAgentLocalRoute(player, retreat)).toBe(true);
  });

  it("rejects a tactical move point inside a generated wall", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-wall-point" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Wall Guard", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const wall = internals.arena?.collisionRects[0];
    expect(wall).toBeDefined();
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: {
        type: "move_to",
        position: { x: wall!.x + wall!.width / 2, z: wall!.y + wall!.height / 2 }
      },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, now + 500)).toMatchObject({
      accepted: false,
      code: "tactical_intent_invalid"
    });
  });

  it("reverses a stale retreat as soon as the live target leaves the combat band", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-close-chase" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "quill" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Tactical Chaser", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    self.x = 500;
    self.y = 500;
    self.rotation = 0;
    target.x = 510;
    target.y = 500;
    room.state.zone.x = 500;
    room.state.zone.y = 500;
    room.state.zone.radius = 2_000;
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 0, moveY: 0 });

    target.x = 1_000;
    internals.runAgentExecutors(acceptedAt + 50);
    expect(internals.agentRuntimes.get(self.sessionId)?.lastReflexAtMs).toBe(acceptedAt);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 1, moveY: 0 });
    expect(room.agentTacticalStatus(session)).toMatchObject({ active: true, stopReason: "moving" });
    expect(internals.agentRuntimes.get(self.sessionId)?.lease).toBeDefined();
  });

  it("keeps a far chase moving through the narrow generated corridor", async () => {
    const seed = "tactical-reflex-harness-151";
    const { room, internals } = await makeRoom({
      roomMode: "open_ffa",
      seed,
      config: { ...testConfig, agentExpandedCombatantsEnabled: true }
    });
    const arena = internals.arena!;
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Corridor Chaser", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    Object.assign(self, {
      x: 1_780.8549,
      y: 329.3295,
      rotation: -2.7951,
      velocityX: 0,
      velocityY: 0
    });
    const finalTarget = { x: 2_164.8286, y: 499.3635 };
    const finalDistance = Math.hypot(finalTarget.x - self.x, finalTarget.y - self.y);
    Object.assign(target, {
      x: self.x + (finalTarget.x - self.x) / finalDistance * 350,
      y: self.y + (finalTarget.y - self.y) / finalDistance * 350
    });
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "engage_target", targetId: target.sessionId },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    expect(internals.agentRuntimes.get(self.sessionId)?.lease?.action?.waypoints).toEqual([]);
    Object.assign(target, finalTarget);

    const start = { x: self.x, y: self.y, rotation: self.rotation };
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(acceptedAt + 50);
    internals.runAgentExecutors(acceptedAt + 50);
    const repairedInput = internals.inputIntents.get(self.sessionId) as { moveX: number; moveY: number };
    expect(Math.hypot(repairedInput.moveX, repairedInput.moveY)).toBeGreaterThan(0);
    expect(internals.agentRuntimes.get(self.sessionId)?.lastReflexAtMs).toBe(acceptedAt + 50);
    internals.onSimulationTick(50);
    for (let elapsed = 100; elapsed <= 150; elapsed += 50) {
      clock.mockReturnValue(acceptedAt + elapsed);
      internals.runAgentExecutors(acceptedAt + elapsed);
      internals.onSimulationTick(50);
      expect(isWallCollision(arena, self.x, self.y, TEST_TANK_RADIUS)).toBe(false);
    }
    expect(
      Math.hypot(self.x - start.x, self.y - start.y) > 0.02 ||
      Math.abs(Math.atan2(
        Math.sin(self.rotation - start.rotation),
        Math.cos(self.rotation - start.rotation)
      )) > 0.002
    ).toBe(true);
  });

  it("refreshes a maximum-speed tactical route without an empty executor frame", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-speed" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "quill" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Tactical Sprinter", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    self.archetypeId = "quill";
    self.x = 500;
    self.y = 500;
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "move_to", position: { x: 1_100, z: 500 } },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    internals.speedEffects.set(self.sessionId, {
      multiplier: 1.55,
      expiresAt: acceptedAt + 10_000
    });
    const clock = vi.spyOn(Date, "now");
    for (let elapsed = 50; elapsed < 500; elapsed += 50) {
      clock.mockReturnValue(acceptedAt + elapsed);
      internals.runAgentExecutors(acceptedAt + elapsed);
      internals.onSimulationTick(50);
      expect(internals.agentRuntimes.get(self.sessionId)?.tactical).toBeDefined();
      expect(internals.agentRuntimes.get(self.sessionId)?.lease).toBeDefined();
      expect(internals.agentRuntimes.get(self.sessionId)?.lastReflexAtMs).toBe(acceptedAt);
      expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 1, moveY: 0 });
    }

    internals.runAgentExecutors(acceptedAt + 500);
    expect(internals.agentRuntimes.get(self.sessionId)?.lastReflexAtMs).toBe(acceptedAt + 500);
  });

  it("reports objective completion in the executor frame that reaches a final segment", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-arrival" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "quill" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Tactical Finisher", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    self.archetypeId = "quill";
    self.x = 500;
    self.y = 500;
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    const acceptedAt = now + 500;
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "move_to", position: { x: 600, z: 500 } },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, acceptedAt)).toMatchObject({ accepted: true });
    const clock = vi.spyOn(Date, "now");
    let completedAt = 0;
    for (let elapsed = 50; elapsed <= 500; elapsed += 50) {
      clock.mockReturnValue(acceptedAt + elapsed);
      internals.runAgentExecutors(acceptedAt + elapsed);
      internals.onSimulationTick(50);
      if (!internals.agentRuntimes.get(self.sessionId)?.tactical) {
        completedAt = acceptedAt + elapsed;
        break;
      }
    }

    expect(completedAt).toBeGreaterThan(acceptedAt);
    expect(completedAt).toBeLessThanOrEqual(acceptedAt + 500);
    expect(room.agentTacticalStatus(session)).toMatchObject({
      active: false,
      stopReason: "objective_complete",
      intentExpiresAtMs: null
    });
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({ moveX: 0, moveY: 0 });
  });

  it("returns an accepted result when immediate evaluation completes the objective", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-complete" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Tactical Complete", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const self = room.state.players.get(session.principal.seatId)!;
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);

    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "move_to", position: { x: self.x, z: self.y } },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, now + 500)).toEqual({
      version: 1,
      type: "agent_tactical_intent_result",
      intentSeq: 2,
      accepted: true,
      code: "accepted",
      intentExpiresAtMs: now + 30_500
    });
    expect(room.agentTacticalStatus(session)).toMatchObject({
      active: false,
      stopReason: "objective_complete"
    });
  });

  it("clears a live tactical lease on an invalid replacement", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-invalid" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Tactical Invalid", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    const intent = {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "zone_center" },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    };
    expect(room.agentSetTacticalIntent(session, intent, now + 500)).toMatchObject({ accepted: true });
    expect(internals.agentRuntimes.get(session.principal.seatId)?.lease).toBeDefined();
    expect(room.agentSetTacticalIntent(session, { ...intent, intentSeq: 3, debug: true }, now + 1_000))
      .toMatchObject({ accepted: false, code: "tactical_intent_invalid" });
    expect(internals.agentRuntimes.get(session.principal.seatId)?.tactical).toBeUndefined();
    expect(internals.agentRuntimes.get(session.principal.seatId)?.lease).toBeUndefined();
    expect(internals.fireIntents.has(session.principal.seatId)).toBe(false);
    expect(internals.abilityIntents.has(session.principal.seatId)).toBe(false);
    internals.runAgentExecutors(now + 1_500);
    expect(room.agentTacticalStatus(session).stopReason).toBe("cleared");

    internals.resetForRematch(now + 2_000);
    expect(internals.agentRuntimes.get(session.principal.seatId)?.tactical?.intent).toEqual(
      TACTICAL_OPENING
    );
  });

  it("rejects tactical intents for a dead combatant instead of reporting them active", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-dead" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Tactical Dead", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    room.state.players.get(session.principal.seatId)!.isAlive = false;

    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "hold" },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, now + 500)).toMatchObject({
      accepted: false,
      code: "match_not_active",
      intentSeq: 2
    });
    expect(room.agentTacticalStatus(session)).toMatchObject({ active: false, stopReason: "cleared" });
    expect(internals.agentRuntimes.get(session.principal.seatId)?.lease).toBeUndefined();
  });

  it("does not rewrite executor input when an already-clear tactic is cleared again", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "tactical-clear" });
    useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Tactical Clear", "tactical_reflex_v1");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const now = Date.now() + 1_000;
    const observation = room.agentObserve(session, now);
    expect(room.agentSetTacticalIntent(session, {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 30_000,
      objective: { type: "zone_center" },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    }, now + 500)).toMatchObject({ accepted: true });
    room.agentClearTacticalIntent(session, now + 550);
    const input = internals.inputIntents.get(session.principal.seatId);
    const auditCount = internals.debugAgentAuditSnapshot().length;

    expect(room.agentClearTacticalIntent(session, now + 600)).toMatchObject({
      active: false,
      stopReason: "cleared"
    });
    expect(internals.inputIntents.get(session.principal.seatId)).toBe(input);
    expect(internals.debugAgentAuditSnapshot()).toHaveLength(auditCount);
  });

  it("neutralizes an agent lease when tank handling clips a blocked route", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa" });
    const arena = useSyntheticArena(room);
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const session = await pairAgent(room, internals, host, "Runner");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const player = room.state.players.get(session.principal.seatId)!;
    const bounds = arenaBounds(arena as unknown as TestArenaConfig);
    player.x = bounds.maxX - TEST_TANK_RADIUS;
    player.y = (bounds.minY + bounds.maxY) / 2;
    player.rotation = 0;
    player.velocityX = 0;
    player.velocityY = 0;
    const now = Date.now();
    const observation = room.agentObserve(session, now);
    expect(room.agentAct(session, {
      version: 1,
      actionSeq: 1,
      basedOnObservationSeq: observation.observationSeq,
      leaseMs: 1_000,
      waypoints: [{ x: player.x, z: player.y + 100 }],
      fire: "none",
      useAbility: false
    }, now + 500)).toMatchObject({ accepted: true });

    internals.runAgentExecutors(now + 550);
    expect(internals.inputIntents.get(player.sessionId)).toMatchObject({ moveY: 1 });
    internals.onSimulationTick(100);
    expect(internals.inputIntents.get(player.sessionId)).toMatchObject({ moveX: 0, moveY: 0 });
    expect(internals.debugAgentAuditSnapshot()).toContainEqual(expect.objectContaining({
      event: "executor_neutral",
      seatId: player.sessionId,
      actionSeq: 1,
      reason: "route_blocked"
    }));
  });

  it("projects one Wingman ally and retains eliminated opponent scoreboard rows", async () => {
    const { room, internals } = await makeRoom({ roomMode: "wingman", seed: "agent-allies" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Runner");
    await pairAgent(room, internals, guest, "Rival");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const first = room.agentObserve(session, Date.now());
    expect(first.arenaVersion).toBe(first.roundId);
    expect(first.arenaVersion).not.toBe(room.state.seed);
    expect(first.arenaUpdate).not.toHaveProperty("seed");
    expect(first.arenaUpdate).toMatchObject({ bounds: expect.any(Object), walls: expect.any(Array) });
    expect(first.allies).toHaveLength(1);
    expect(first.allies[0]?.id).toBe(host.client.sessionId);
    expect(first.opponents.some((opponent) => opponent.id === host.client.sessionId)).toBe(false);

    const eliminated = room.state.players.get(guest.client.sessionId)!;
    eliminated.isAlive = false;
    eliminated.isSpectator = true;
    eliminated.placement = 4;
    const second = room.agentObserve(session, first.serverTimeMs + 500);
    expect(second.arenaUpdate).toBeUndefined();
    expect(second.opponents.find((opponent) => opponent.id === eliminated.sessionId)).toMatchObject({
      alive: false,
      placement: 4,
      visible: false,
      position: null,
      motion: "unknown"
    });
  });

  it("neutralizes an active macro when an authenticated action body cannot be decoded", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "invalid-action-body" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "rook" });
    const session = await pairAgent(room, internals, host, "Transport Guard");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const now = Date.now();
    const observation = room.agentObserve(session, now);
    expect(room.agentAct(session, {
      version: 1,
      actionSeq: 1,
      basedOnObservationSeq: observation.observationSeq,
      leaseMs: 1_000,
      waypoints: [],
      fire: "none",
      useAbility: false
    }, now + 500)).toMatchObject({ accepted: true, code: "accepted" });
    expect(internals.agentRuntimes.get(session.principal.seatId)?.lease).toBeDefined();

    expect(room.agentAct(session, undefined, now + 501)).toMatchObject({
      accepted: false,
      code: "lease_invalid"
    });
    expect(internals.agentRuntimes.get(session.principal.seatId)?.lease).toBeUndefined();
    expect(internals.inputIntents.get(session.principal.seatId)).toMatchObject({
      moveX: 0,
      moveY: 0,
      fire: false,
      ability: false
    });
  });

  it("clears queued output when an accepted action replaces the active macro", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Replacement Guard");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const arena = useSyntheticArena(room);
    const bounds = arenaBounds(arena as unknown as TestArenaConfig);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    self.x = bounds.minX + 200;
    self.y = bounds.minY + 200;
    target.x = self.x + 100;
    target.y = self.y;

    const now = Date.now();
    const observation = room.agentObserve(session, now);
    expect(room.agentAct(session, {
      version: 1,
      actionSeq: 1,
      basedOnObservationSeq: observation.observationSeq,
      leaseMs: 1_000,
      waypoints: [],
      targetId: guest.client.sessionId,
      fire: "single",
      useAbility: "once"
    }, now + 500)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(now + 550);
    expect(internals.fireIntents.has(session.principal.seatId)).toBe(true);
    expect(internals.abilityIntents.has(session.principal.seatId)).toBe(true);

    expect(room.agentAct(session, {
      version: 1,
      actionSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      leaseMs: 1_000,
      waypoints: [],
      fire: "none",
      useAbility: false
    }, now + 1_000)).toMatchObject({ accepted: true });
    expect(internals.fireIntents.has(session.principal.seatId)).toBe(false);
    expect(internals.abilityIntents.has(session.principal.seatId)).toBe(false);

    internals.onSimulationTick(16);
    expect(room.state.projectiles).toHaveLength(0);
  });

  it("does not let a stale release principal clear a replacement agent seat", async () => {
    const { room, internals } = await makeRoom({ roomMode: "wingman", seed: "stale-release" });
    const host = makeClient("host1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    const original = await pairAgent(room, internals, host, "Original Agent");
    const originalCredential = brokerCredentials.get(original.principal.seatId) ?? "";

    room.agentRelease(original.principal);
    expect(internals.inputIntents.has(original.principal.seatId)).toBe(false);
    agentBroker.releaseControl(originalCredential, room.roomId);
    const replacement = await pairAgent(room, internals, host, "Replacement Agent");
    internals.handleReadyMessage(host.client, { ready: true });
    const owner = room.state.owners.get(replacement.principal.ownerId);
    expect(owner).toMatchObject({
      agentSeatId: replacement.principal.seatId,
      agentSeatState: "connected",
      isReady: true
    });

    room.agentRelease(original.principal);
    expect(owner).toMatchObject({
      agentSeatId: replacement.principal.seatId,
      agentSeatState: "connected",
      isReady: true
    });
    expect(room.state.players.has(replacement.principal.seatId)).toBe(true);
    expect(internals.agentRuntimes.has(replacement.principal.seatId)).toBe(true);
  });

  it("refreshes coarse target aim at executor cadence and suppresses fire through walls", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "agent-aim" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Runner");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const arena = readArenaConfig(room);
    const open = findOpenDuelLine(arena);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    self.x = open.attackerX;
    self.y = open.attackerY;
    target.x = open.targetX + 7;
    target.y = open.targetY + 6;
    target.velocityX = 0;
    target.velocityY = 120;
    const now = Date.now();
    const observation = room.agentObserve(session, now);
    const observedTarget = observation.opponents.find(
      (opponent) => opponent.id === target.sessionId
    )?.position;
    expect(observedTarget).toBeDefined();
    expect(room.agentAct(session, {
      version: 1,
      actionSeq: 1,
      basedOnObservationSeq: observation.observationSeq,
      leaseMs: 1_000,
      waypoints: [],
      targetId: target.sessionId,
      fire: "single",
      useAbility: false
    }, now + 500)).toMatchObject({ accepted: true });
    target.x += 11;
    target.y += 13;
    target.velocityX = 90;
    target.velocityY = -120;
    internals.runAgentExecutors(now + 550);
    expect(internals.inputIntents.get(self.sessionId)).toMatchObject({
      aimX: Math.round(target.x / 25) * 25,
      aimY: Math.round(target.y / 25) * 25
    });
    expect(internals.inputIntents.get(self.sessionId)).not.toMatchObject({
      aimX: observedTarget?.x,
      aimY: observedTarget?.z
    });
    expect(internals.fireIntents.has(self.sessionId)).toBe(true);

    const blocked = findWallBlockedDuelLine(arena);
    self.x = blocked.attackerX;
    self.y = blocked.attackerY;
    target.x = blocked.targetX;
    target.y = blocked.targetY;
    target.velocityX = 0;
    target.velocityY = 0;
    internals.fireIntents.delete(self.sessionId);
    const blockedObservation = room.agentObserve(session, now + 1_000);
    expect(room.agentAct(session, {
      version: 1,
      actionSeq: 2,
      basedOnObservationSeq: blockedObservation.observationSeq,
      leaseMs: 1_000,
      waypoints: [],
      targetId: target.sessionId,
      fire: "single",
      useAbility: false
    }, now + 1_500)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(now + 1_550);
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
  });

  it("rejects a target that dies or enters smoke after observation", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Runner");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const target = room.state.players.get(guest.client.sessionId)!;
    const now = Date.now();
    const observation = room.agentObserve(session, now);
    const action = {
      version: 1 as const,
      actionSeq: 1,
      basedOnObservationSeq: observation.observationSeq,
      leaseMs: 500,
      waypoints: [],
      targetId: target.sessionId,
      fire: "single" as const,
      useAbility: false as const
    };

    target.smokeX = target.x;
    target.smokeY = target.y;
    target.smokeEndsAt = now + 10_000;
    expect(room.agentAct(session, action, now + 500)).toMatchObject({
      accepted: false,
      code: "target_not_visible"
    });
    target.smokeEndsAt = 0;
    target.isAlive = false;
    expect(room.agentAct(session, { ...action, actionSeq: 2 }, now + 1_000)).toMatchObject({
      accepted: false,
      code: "target_not_visible"
    });
  });

  it("clears queued agent attacks when a target enters smoke or is eliminated", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Visibility Guard");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const arena = useSyntheticArena(room);
    const bounds = arenaBounds(arena as unknown as TestArenaConfig);
    const self = room.state.players.get(session.principal.seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    self.x = bounds.minX + 200;
    self.y = bounds.minY + 200;
    target.x = self.x + 100;
    target.y = self.y;

    const now = Date.now();
    const firstObservation = room.agentObserve(session, now);
    const action = {
      version: 1 as const,
      actionSeq: 1,
      basedOnObservationSeq: firstObservation.observationSeq,
      leaseMs: 1_000,
      waypoints: [],
      targetId: target.sessionId,
      fire: "single" as const,
      useAbility: false as const
    };
    expect(room.agentAct(session, action, now + 500)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(now + 550);
    expect(internals.fireIntents.has(self.sessionId)).toBe(true);

    internals.handleAbilityMessage(guest.client, { sequence: 1, abilityType: "smoke" });
    internals.onSimulationTick(16);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease).toBeUndefined();
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
    expect(room.state.projectiles).toHaveLength(0);

    target.smokeEndsAt = 0;
    const secondObservation = room.agentObserve(session, now + 1_000);
    expect(room.agentAct(session, {
      ...action,
      actionSeq: 2,
      basedOnObservationSeq: secondObservation.observationSeq
    }, now + 1_500)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(now + 1_550);
    expect(internals.fireIntents.has(self.sessionId)).toBe(true);

    target.shield = 0;
    target.armor = 0;
    internals.applyDamage(target, self, target.health * 10, now + 1_600);
    expect(internals.agentRuntimes.get(self.sessionId)?.lease).toBeUndefined();
    expect(internals.fireIntents.has(self.sessionId)).toBe(false);
  });

  it.each(["revoke", "idle"] as const)(
    "neutralizes an active fire/ability lease synchronously on %s",
    async (transition) => {
      const { room, internals } = await makeRoom({ roomMode: "wingman" });
      const host = makeClient("host1");
      const guest = makeClient("guest1");
      room.onJoin(host.client, { playerName: "Host", archetypeId: "quill" });
      room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
      const hostSession = await pairAgent(room, internals, host, "Lease Owner");
      const guestSession = await pairAgent(room, internals, guest, "Partner Guard");
      const credential = brokerCredentials.get(hostSession.principal.seatId) ?? "";
      internals.handleReadyMessage(host.client, { ready: true });
      internals.handleReadyMessage(guest.client, { ready: true });
      internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
      useSyntheticArena(room);
      const self = room.state.players.get(hostSession.principal.seatId)!;
      const target = room.state.players.get(guest.client.sessionId)!;
      self.x = 500;
      self.y = 500;
      target.x = 650;
      target.y = 500;

      const now = Date.now();
      const observation = room.agentObserve(hostSession, now);
      expect(room.agentAct(hostSession, {
        version: 1,
        actionSeq: 1,
        basedOnObservationSeq: observation.observationSeq,
        leaseMs: 3_000,
        waypoints: [],
        targetId: guest.client.sessionId,
        fire: "hold",
        useAbility: "once"
      }, now + 500)).toMatchObject({ accepted: true });
      internals.runAgentExecutors(now + 550);
      expect(internals.fireIntents.has(hostSession.principal.seatId)).toBe(true);
      expect(internals.abilityIntents.has(hostSession.principal.seatId)).toBe(true);
      expect(room.agentCapacitySnapshot()).toMatchObject({
        activeLeases: 1
      });
      expect(room.agentCapacitySnapshot().auditEvents).toBeGreaterThan(0);

      if (transition === "revoke") {
        internals.handleAgentControl(host.client, { action: "disconnect" });
      } else {
        agentBroker.heartbeat(
          brokerCredentials.get(guestSession.principal.seatId) ?? "",
          room.roomId,
          hostSession.idleDeadlineMs - 1
        );
        internals.runAgentExecutors(hostSession.idleDeadlineMs);
      }

      expect(internals.agentRuntimes.has(hostSession.principal.seatId)).toBe(false);
      expect(internals.fireIntents.has(hostSession.principal.seatId)).toBe(false);
      expect(internals.abilityIntents.has(hostSession.principal.seatId)).toBe(false);
      expect(internals.inputIntents.has(hostSession.principal.seatId)).toBe(false);
      expect(room.agentCapacitySnapshot().activeLeases).toBe(0);
      expect(room.state.projectiles).toHaveLength(0);
      expect(room.state.players.get(hostSession.principal.seatId)).toMatchObject({
        isAlive: false,
        isConnected: false,
        velocityX: 0,
        velocityY: 0
      });
      expect(room.state.players.get(host.client.sessionId)).toMatchObject({ isAlive: true });
      expect(room.state.players.get(guestSession.principal.seatId)).toMatchObject({ isAlive: true });
      expect(() => agentBroker.authorize({
        brokerCredential: credential,
        roomId: room.roomId,
        requiredScope: "agent:observe"
      }, hostSession.idleDeadlineMs + 1)).toThrow();
    }
  );

  it("revokes active controls and pending grants when the room disposes", async () => {
    const baselineActiveControls = agentBroker.activeControlCount;
    const baselinePendingGrants = agentBroker.pendingGrantCount;
    const { room, internals } = await makeRoom({ roomMode: "wingman" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "quill" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const activeSession = await pairAgent(room, internals, host, "Active Control");
    const credential = brokerCredentials.get(activeSession.principal.seatId) ?? "";
    internals.handleAgentPairingCreate(guest.client, { agentLabel: "Pending Control" });
    const pendingResult = guest.send.mock.calls
      .filter(([type]) => type === SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT)
      .at(-1)?.[1] as { pairingCode?: string } | undefined;
    const pendingCode = JSON.parse(pendingResult?.pairingCode ?? "{}") as {
      roomId?: string;
      grant?: string;
    };
    expect(agentBroker.activeControlCount).toBe(baselineActiveControls + 1);
    expect(agentBroker.pendingGrantCount).toBe(baselinePendingGrants + 1);

    room.onDispose();

    expect(agentBroker.activeControlCount).toBe(baselineActiveControls);
    expect(agentBroker.pendingGrantCount).toBe(baselinePendingGrants);
    expect(() => agentBroker.authorize({
      brokerCredential: credential,
      roomId: room.roomId,
      requiredScope: "agent:observe"
    })).toThrow();
    await expect(agentBroker.consumeGrant({
      roomId: pendingCode.roomId ?? "",
      grantCredential: pendingCode.grant ?? "",
      sourceKey: "test:disposed"
    }, () => undefined)).rejects.toThrow();
  });

  it("cancels materialization when the room disposes before broker activation", async () => {
    const race = await beginMaterializationRace("Racing Control", "test:dispose-race");

    race.room.onDispose();
    race.finishMaterialization();

    await expect(race.consuming).rejects.toMatchObject({ code: "grant_cancelled" });
    expect(agentBroker.pendingGrantCount).toBe(race.baselinePendingGrants);
    expect(agentBroker.activeControlCount).toBe(race.baselineActiveControls);
  });

  it("cancels materialization when its owner leaves before broker activation", async () => {
    const race = await beginMaterializationRace("Leaving Control", "test:owner-leave-race");

    race.room.onLeave(race.host.client);
    race.finishMaterialization();

    await expect(race.consuming).rejects.toMatchObject({ code: "grant_cancelled" });
    expect(agentBroker.pendingGrantCount).toBe(race.baselinePendingGrants);
    expect(agentBroker.activeControlCount).toBe(race.baselineActiveControls);
    expect(race.room.state.owners.has(race.ownerId)).toBe(false);
    expect(race.room.state.players.has(race.seatId)).toBe(false);
    expect(race.internals.agentRuntimes.has(race.seatId)).toBe(false);
  });

  it("cancels materialization when its owner leaves an active match before broker activation", async () => {
    const race = await beginMaterializationRace(
      "Active Leaving Control",
      "test:active-owner-leave-race",
      "open_ffa"
    );
    const guest = makeClient("guest1");
    race.room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    race.internals.handleReadyMessage(race.host.client, { ready: true });
    race.internals.handleReadyMessage(guest.client, { ready: true });
    race.internals.advanceTimedLifecycle(race.room.state.match.countdownEndsAt);
    expect(race.room.state.matchState).toBe("running");

    race.room.onLeave(race.host.client);
    race.finishMaterialization();

    await expect(race.consuming).rejects.toMatchObject({ code: "grant_cancelled" });
    expect(agentBroker.pendingGrantCount).toBe(race.baselinePendingGrants);
    expect(agentBroker.activeControlCount).toBe(race.baselineActiveControls);
    expect(race.internals.agentRuntimes.has(race.seatId)).toBe(false);
    expect(race.room.state.players.get(race.seatId)).toMatchObject({ isAlive: false });
  });

  it("cancels materialization when its owner disconnects the control", async () => {
    const race = await beginMaterializationRace("Cancelled Control", "test:disconnect-race");

    race.internals.handleAgentControl(race.host.client, { action: "disconnect" });
    race.finishMaterialization();

    await expect(race.consuming).rejects.toMatchObject({ code: "grant_cancelled" });
    expect(agentBroker.pendingGrantCount).toBe(race.baselinePendingGrants);
    expect(agentBroker.activeControlCount).toBe(race.baselineActiveControls);
    expect(race.room.state.players.has(race.seatId)).toBe(false);
    expect(race.internals.agentRuntimes.has(race.seatId)).toBe(false);
    expect(race.host.send.mock.calls
      .filter(([type]) => type === SERVER_MESSAGE_TYPES.AGENT_CONTROL_RESULT)
      .at(-1)?.[1]).toMatchObject({
        action: "disconnect",
        accepted: true,
        seatState: "none"
      });
  });

  it("cancels materialization when its owner cancels the pairing", async () => {
    const race = await beginMaterializationRace("Pairing Cancel", "test:pairing-cancel-race");

    race.internals.handleAgentPairingCancel(race.host.client, {});
    race.finishMaterialization();

    await expect(race.consuming).rejects.toMatchObject({ code: "grant_cancelled" });
    expect(agentBroker.pendingGrantCount).toBe(race.baselinePendingGrants);
    expect(agentBroker.activeControlCount).toBe(race.baselineActiveControls);
    expect(race.room.state.players.has(race.seatId)).toBe(false);
    expect(race.internals.agentRuntimes.has(race.seatId)).toBe(false);
    expect(race.room.state.owners.get(race.ownerId)).toMatchObject({
      agentSeatId: "",
      agentSeatState: "none"
    });
    expect(race.host.send.mock.calls
      .filter(([type]) => type === SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT)
      .at(-1)?.[1]).toMatchObject({
        action: "cancel",
        accepted: true,
        seatState: "none"
      });
  });

  it("honors a broker heartbeat accepted before the room's old idle deadline", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa" });
    const host = makeClient("host1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    const session = await pairAgent(room, internals, host, "Runner");
    const credential = brokerCredentials.get(session.principal.seatId);
    expect(credential).toEqual(expect.any(String));
    agentBroker.heartbeat(credential ?? "", room.roomId, session.idleDeadlineMs - 1);

    internals.runAgentExecutors(session.idleDeadlineMs);
    expect(room.state.players.get(session.principal.seatId)).toMatchObject({
      isConnected: true,
      isAlive: true
    });
  });

  it("keeps Agent Cup humans as controllers while only agents become combatants", async () => {
    const { room, internals } = await makeRoom({ roomMode: "agent_cup", seed: "agent-cup" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const hostHuman = room.state.players.get(host.client.sessionId);
    expect(hostHuman).toMatchObject({ controlKind: "human", isAlive: false, isSpectator: true });
    expect(room.state.owners.get(hostHuman?.ownerId ?? "")?.principalKind).toBe("controller");
    expect(room.state.match.alivePlayers).toBe(0);

    const hostSession = await pairAgent(room, internals, host, "Cup One");
    const guestSession = await pairAgent(room, internals, guest, "Cup Two");
    expect(Array.from(room.state.players.values()).filter((player) => !player.isSpectator)).toHaveLength(2);
    expect(room.agentCapacitySnapshot()).toMatchObject({
      owners: 2,
      controls: 2,
      agentEntities: 2,
      combatants: 2
    });
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    expect(room.state.matchState).toBe("countdown");
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const observedAt = Date.now();
    const observation = room.agentObserve(hostSession, observedAt);
    expect(observation.allies).toHaveLength(0);
    expect(observation.opponents.map((opponent) => opponent.id)).toEqual([
      guestSession.principal.seatId
    ]);
    expect(room.agentAct(hostSession, {
      version: 1,
      actionSeq: 1,
      basedOnObservationSeq: observation.observationSeq,
      leaseMs: 500,
      waypoints: [],
      targetId: guestSession.principal.seatId,
      fire: "single",
      useAbility: false
    }, observedAt + 500)).toMatchObject({ accepted: true, code: "accepted" });
    for (const player of room.state.players.values()) {
      if (player.controlKind !== "agent") continue;
      player.isAlive = false;
      player.isSpectator = true;
    }
    internals.checkForMatchConclusion(Date.now());
    expect(room.state.matchState).toBe("finished");
    expect(Array.from(room.state.players.values()).filter(
      (player) => player.controlKind === "human" && player.placement === 1
    )).toHaveLength(0);
    expect(Array.from(room.state.players.values()).filter(
      (player) => player.controlKind === "agent" && player.placement === 1
    )).toHaveLength(1);
    expect(room.agentCapacitySnapshot().combatants).toBe(2);
  });

  it("removes an idle agent before rematch and lets its owner pair again", async () => {
    const { room, internals } = await makeRoom({ roomMode: "wingman", seed: "idle-rematch" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const hostSession = await pairAgent(room, internals, host, "Host Agent");
    await pairAgent(room, internals, guest, "Guest Agent");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    internals.runAgentExecutors(hostSession.idleDeadlineMs);
    const expiredAgent = room.state.players.get(hostSession.principal.seatId);
    expect(expiredAgent).toMatchObject({ isAlive: false, isConnected: false });
    expect(room.state.owners.get(hostSession.principal.ownerId)?.agentSeatState).toBe("disconnected");

    internals.resetForRematch(hostSession.idleDeadlineMs + 1);
    expect(room.state.players.has(hostSession.principal.seatId)).toBe(false);
    expect(room.state.owners.get(hostSession.principal.ownerId)).toMatchObject({
      agentSeatState: "none",
      isReady: false
    });
    internals.handleAgentPairingCreate(host.client, { agentLabel: "Replacement" });
    const result = host.send.mock.calls
      .filter(([type]) => type === SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT)
      .at(-1)?.[1] as { accepted?: boolean; pairingCode?: string } | undefined;
    expect(result).toMatchObject({ accepted: true, pairingCode: expect.any(String) });
  });

  it("lets an owner replace an agent that expires before the match starts", async () => {
    const { room, internals } = await makeRoom({ roomMode: "wingman", seed: "idle-waiting" });
    const host = makeClient("host1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    const session = await pairAgent(room, internals, host, "First Agent");

    internals.runAgentExecutors(session.idleDeadlineMs);
    expect(room.state.players.has(session.principal.seatId)).toBe(false);
    expect(room.state.owners.get(session.principal.ownerId)).toMatchObject({
      agentSeatState: "none",
      agentSeatId: ""
    });

    internals.handleAgentPairingCreate(host.client, { agentLabel: "Replacement" });
    const result = host.send.mock.calls
      .filter(([type]) => type === SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT)
      .at(-1)?.[1] as { accepted?: boolean; pairingCode?: string } | undefined;
    expect(result).toMatchObject({ accepted: true, pairingCode: expect.any(String) });
  });

  it("purges a permanently departed owner after results without making its agent host", async () => {
    const { room, internals } = await makeRoom({ roomMode: "wingman", seed: "departed-rematch" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const hostSession = await pairAgent(room, internals, host, "Host Agent");
    const guestSession = await pairAgent(room, internals, guest, "Guest Agent");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    room.onLeave(host.client, CloseCode.CONSENTED);
    expect(room.state.players.get(guest.client.sessionId)?.isHost).toBe(true);
    expect(room.state.players.get(guestSession.principal.seatId)?.isHost).toBe(false);
    const departedAgent = room.state.players.get(hostSession.principal.seatId)!;
    const guestPlayer = room.state.players.get(guest.client.sessionId)!;
    departedAgent.shield = 0;
    departedAgent.armor = 0;
    internals.applyDamage(departedAgent, guestPlayer, departedAgent.health, Date.now());
    internals.checkForMatchConclusion(Date.now());
    expect(room.state.matchState).toBe("finished");

    const previousMatchId = room.state.match.matchId;
    internals.handleRematchMessage(guest.client, { ready: true, previousMatchId });
    expect(room.state.matchState).toBe("waiting");
    expect(room.state.owners.has(hostSession.principal.ownerId)).toBe(false);
    expect(Array.from(room.state.players.values()).some(
      (player) => player.ownerId === hostSession.principal.ownerId
    )).toBe(false);
  });

  it("revokes and releases queued agent output before a consented owner leave returns", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "owner-leave" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "quill" });
    const session = await pairAgent(room, internals, host, "Runner");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const seatId = session.principal.seatId;
    const brokerCredential = brokerCredentials.get(seatId);
    expect(brokerCredential).toEqual(expect.any(String));
    const agent = room.state.players.get(seatId)!;
    const target = room.state.players.get(guest.client.sessionId)!;
    const duel = findOpenDuelLine(readArenaConfig(room));
    agent.x = duel.attackerX;
    agent.y = duel.attackerY;
    agent.abilityCharge = 100;
    target.x = duel.targetX;
    target.y = duel.targetY;
    const now = Date.now();
    const observation = room.agentObserve(session, now);
    expect(room.agentAct(session, {
      version: 1,
      actionSeq: 1,
      basedOnObservationSeq: observation.observationSeq,
      leaseMs: 1_000,
      waypoints: [{ x: target.x, z: target.y }],
      targetId: target.sessionId,
      fire: "single",
      useAbility: "once"
    }, now + 500)).toMatchObject({ accepted: true });
    internals.runAgentExecutors(now + 550);
    expect(internals.agentRuntimes.get(seatId)?.lease).toBeDefined();
    expect(internals.fireIntents.has(seatId)).toBe(true);
    expect(internals.abilityIntents.has(seatId)).toBe(true);

    room.onLeave(host.client, CloseCode.CONSENTED);

    expect(internals.agentRuntimes.get(seatId)?.lease).toBeUndefined();
    expect(internals.fireIntents.has(seatId)).toBe(false);
    expect(internals.abilityIntents.has(seatId)).toBe(false);
    expect(internals.inputIntents.has(seatId)).toBe(false);
    expect(() => agentBroker.heartbeat(
      brokerCredential ?? "",
      room.roomId,
      now + 600
    )).toThrow("broker_invalid");
    expect(internals.agentRuntimes.has(seatId)).toBe(false);
    expect(room.state.players.get(seatId)).toMatchObject({ isAlive: false, isConnected: false });
    expect(room.state.owners.get(session.principal.ownerId)).toMatchObject({
      agentSeatState: "disconnected"
    });
  });

  it.each(["wingman", "open_ffa", "agent_cup"] as const)(
    "keeps %s policy and broker control live through owner-voted rematch",
    async (roomMode) => {
      const { room, internals } = await makeRoom({ roomMode, seed: `rematch-${roomMode}` });
      const host = makeClient("host1");
      const guest = makeClient("guest1");
      room.onJoin(host.client, { playerName: "Host", archetypeId: "quill" });
      room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
      const hostSession = await pairAgent(room, internals, host, "Round Runner");
      await pairAgent(room, internals, guest, "Round Rival");
      internals.handleReadyMessage(host.client, { ready: true });
      internals.handleReadyMessage(guest.client, { ready: true });
      internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

      for (const player of room.state.players.values()) {
        const owner = room.state.owners.get(player.ownerId);
        if (player.controlKind !== "agent" && owner?.principalKind !== "combatant") continue;
        player.isAlive = false;
        player.isSpectator = true;
      }
      internals.checkForMatchConclusion(Date.now());
      expect(room.state.matchState).toBe("finished");
      const previousMatchId = room.state.match.matchId;
      const previousRound = room.state.match.round;
      internals.handleRematchMessage(host.client, { ready: true, previousMatchId });
      internals.handleRematchMessage(guest.client, { ready: true, previousMatchId });

      expect(room.state.policy).toMatchObject({ mode: roomMode, track: "custom" });
      expect(room.state.match.round).toBe(previousRound + 1);
      expect(room.state.match.matchId).not.toBe(previousMatchId);
      expect(room.state.matchState).toBe("countdown");
      internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
      const observedAt = Date.now() + 1_000;
      const observation = room.agentObserve(hostSession, observedAt);
      expect(room.agentAct(hostSession, {
        version: 1,
        actionSeq: 1,
        basedOnObservationSeq: observation.observationSeq,
        leaseMs: 500,
        waypoints: [],
        fire: "none",
        useAbility: false
      }, observedAt + 500)).toMatchObject({ accepted: true, code: "accepted" });
    }
  );

  it("refreshes rematch geometry and rejects prior-round action replay", async () => {
    const { room, internals } = await makeRoom({ roomMode: "open_ffa", seed: "fresh-round-observation" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "nova" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "rook" });
    const session = await pairAgent(room, internals, host, "Runner");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    const observedAt = Date.now();
    const oldObservation = room.agentObserve(session, observedAt);
    const oldAction = {
      version: 1 as const,
      actionSeq: 1,
      basedOnObservationSeq: oldObservation.observationSeq,
      leaseMs: 500,
      waypoints: [],
      fire: "none" as const,
      useAbility: false as const
    };
    expect(room.agentAct(session, oldAction, observedAt + 500)).toMatchObject({
      accepted: true,
      code: "accepted"
    });

    internals.resetForRematch(observedAt + 1_000);
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);
    expect(room.agentAct(session, {
      ...oldAction,
      actionSeq: 99
    }, observedAt + 1_500)).toMatchObject({
      accepted: false,
      code: "stale_observation"
    });
    const rematchObservation = room.agentObserve(session, observedAt + 2_000);
    expect(rematchObservation).toMatchObject({
      observationSeq: oldObservation.observationSeq + 1,
      arenaVersion: room.state.match.matchId,
      arenaUpdate: { bounds: expect.any(Object), walls: expect.any(Array) }
    });
    expect(rematchObservation.arenaVersion).not.toBe(room.state.seed);
    expect(rematchObservation.arenaUpdate).not.toHaveProperty("seed");
    expect(room.agentAct(session, oldAction, observedAt + 2_500)).toMatchObject({
      accepted: false,
      code: "stale_action"
    });
    expect(room.agentAct(session, {
      ...oldAction,
      actionSeq: 99
    }, observedAt + 3_000)).toMatchObject({
      accepted: false,
      code: "stale_observation"
    });
  });

  it("finishes Wingman matches with authoritative pair results and resets them", async () => {
    const { room, internals } = await makeRoom({ roomMode: "wingman", seed: "wingman-winner" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const hostSession = await pairAgent(room, internals, host, "Host Agent");
    const guestSession = await pairAgent(room, internals, guest, "Guest Agent");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const hostPlayers = Array.from(room.state.players.values()).filter(
      (player) => player.pairId === hostSession.principal.ownerId
    );
    const guestPlayers = Array.from(room.state.players.values()).filter(
      (player) => player.pairId === guestSession.principal.ownerId
    );
    expect(hostPlayers).toHaveLength(2);
    expect(guestPlayers).toHaveLength(2);
    for (const target of guestPlayers) {
      target.shield = 0;
      target.armor = 0;
      internals.applyDamage(target, hostPlayers[0], target.health, Date.now());
    }
    internals.checkForMatchConclusion(Date.now());

    expect(room.state.matchState).toBe("finished");
    expect(hostPlayers.every((player) => (
      player.placement === 1 && player.teamPlacement === 1 && player.teamKills === 2
    ))).toBe(true);
    expect(guestPlayers.every((player) => (
      player.teamPlacement === 2 && player.teamKills === 0
    ))).toBe(true);
    expect(internals.debugAgentAuditSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "eliminated",
        seatId: guestSession.principal.seatId,
        placement: expect.any(Number)
      }),
      expect.objectContaining({
        event: "placement",
        seatId: hostSession.principal.seatId,
        placement: 1,
        teamPlacement: 1
      })
    ]));

    internals.resetForRematch(Date.now() + 1_000);
    expect(Array.from(room.state.players.values()).every(
      (player) => player.teamPlacement === 0 && player.teamKills === 0
    )).toBe(true);
  });

  it("ranks Wingman timeout results by the whole pair", async () => {
    const { room, internals } = await makeRoom({ roomMode: "wingman", seed: "wingman-timeout" });
    const host = makeClient("host1");
    const guest = makeClient("guest1");
    room.onJoin(host.client, { playerName: "Host", archetypeId: "rook" });
    room.onJoin(guest.client, { playerName: "Guest", archetypeId: "atlas" });
    const hostSession = await pairAgent(room, internals, host, "Host Agent");
    const guestSession = await pairAgent(room, internals, guest, "Guest Agent");
    internals.handleReadyMessage(host.client, { ready: true });
    internals.handleReadyMessage(guest.client, { ready: true });
    internals.advanceTimedLifecycle(room.state.match.countdownEndsAt);

    const hostPlayers = Array.from(room.state.players.values()).filter(
      (player) => player.pairId === hostSession.principal.ownerId
    );
    const guestPlayers = Array.from(room.state.players.values()).filter(
      (player) => player.pairId === guestSession.principal.ownerId
    );
    hostPlayers[0]!.kills = 2;
    hostPlayers[1]!.kills = 2;
    guestPlayers[0]!.kills = 3;
    const matchEndsAt = room.state.match.matchEndsAt;
    internals.advanceTimedLifecycle(matchEndsAt);
    internals.advanceTimedLifecycle(matchEndsAt);
    internals.advanceTimedLifecycle(matchEndsAt);

    expect(room.state.matchState).toBe("finished");
    expect(hostPlayers.every((player) => (
      player.teamPlacement === 1 && player.teamKills === 4
    ))).toBe(true);
    expect(guestPlayers.every((player) => (
      player.teamPlacement === 2 && player.teamKills === 3
    ))).toBe(true);
  });
});
