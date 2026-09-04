import { Decoder, Encoder, Metadata, Schema, deprecated, type as schemaType } from "@colyseus/schema";
import { describe, expect, it } from "vitest";
import {
  ABILITY_CONFIG,
  ABILITY_TYPES,
  ARENA_CONFIG_VERSION,
  BATTLE_ROYALE_ROOM,
  CLIENT_MESSAGE_TYPES,
  circleIntersectsCollisionRect,
  clampToArena,
  createSeededRng,
  generateArenaConfig,
  integrateTankMovement,
  isWallCollision,
  MATCH_STATES,
  planArenaWeather,
  planZonePhases,
  PICKUP_CONFIG,
  PICKUP_TYPES,
  SERVER_MESSAGE_TYPES,
  TANK_ARCHETYPE_CONFIG,
  TANK_ARCHETYPES,
  TANK_COLLISION_RADIUS,
  resolveTankCollisionMovement,
  validateArenaConnectivity,
  WEAPON_CONFIG,
  WEAPON_TYPES,
  type ArenaPoint,
  type ClientToServerMessage,
  type ServerToClientMessage,
  type TankMovementState
} from "./index.js";
import {
  Alpha7StateSchema,
  MatchCoreSchema,
  OwnerSchema,
  PickupSchema,
  PlayerSchema,
  ProjectileSchema,
  RoomPolicySchema,
  ZoneCoreSchema,
  ZonePhaseSchema
} from "./schema.js";

class LegacyWireState extends Schema {
  @schemaType("string") canonical = "";
  @schemaType("string") duplicate = "";
  @schemaType("string") trailing = "";
}

class CurrentWireState extends Schema {
  @schemaType("string") canonical = "";
  @deprecated()
  @schemaType("string") duplicate = "";
  @schemaType("string") trailing = "";
}

describe("phase 2 shared constants", () => {
  it("keeps room and match state protocol values exact", () => {
    expect(BATTLE_ROYALE_ROOM).toBe("battle_royale");
    expect(MATCH_STATES).toEqual([
      "waiting",
      "countdown",
      "running",
      "danger",
      "final_zone",
      "finished"
    ]);
  });

  it("exposes exact tank archetype keys and sane configs", () => {
    expect(TANK_ARCHETYPES).toEqual(["nova", "atlas", "quill", "rook"]);
    expect(TANK_ARCHETYPES.map((id) => TANK_ARCHETYPE_CONFIG[id].name)).toEqual([
      "Nova",
      "Atlas",
      "Quill",
      "Rook"
    ]);

    for (const id of TANK_ARCHETYPES) {
      const config = TANK_ARCHETYPE_CONFIG[id];

      expect(config.id).toBe(id);
      expect(WEAPON_TYPES).toContain(config.primaryWeapon);
      expect(ABILITY_TYPES).toContain(config.ability);
      expect(config.maxHealth).toBeGreaterThan(0);
      expect(config.speed).toBeGreaterThan(0);
      expect(config.handling.acceleration).toBeGreaterThan(0);
      expect(config.handling.brakeDeceleration).toBeGreaterThan(config.handling.acceleration);
      expect(config.handling.turnRate).toBeGreaterThan(0);
    }

    expect(TANK_COLLISION_RADIUS).toBe(28);
  });

  it("keeps weapon, pickup, and ability configs deterministic", () => {
    expect(WEAPON_TYPES).toEqual(["cannon", "light_cannon", "machine_gun", "explosive"]);
    expect(PICKUP_TYPES).toEqual([
      "health_repair",
      "shield_armor",
      "ammo_rapid_fire",
      "speed_boost",
      "ability_charge",
      "smoke",
      "barrage_explosive"
    ]);
    expect(ABILITY_TYPES).toEqual(["smoke", "repair", "shield_pulse", "speed_burst", "barrage"]);

    for (const weaponType of WEAPON_TYPES) {
      const config = WEAPON_CONFIG[weaponType];

      expect(config.id).toBe(weaponType);
      expect(config.damage).toBeGreaterThan(0);
      expect(config.fireCooldownMs).toBeGreaterThan(0);
      expect(config.projectileSpeed).toBeGreaterThan(0);
    }

    for (const pickupType of PICKUP_TYPES) {
      const config = PICKUP_CONFIG[pickupType];

      expect(config.id).toBe(pickupType);
      expect(config.respawnMs).toBeGreaterThan(0);
    }

    for (const abilityType of ABILITY_TYPES) {
      const config = ABILITY_CONFIG[abilityType];

      expect(config.id).toBe(abilityType);
      expect(config.description.length).toBeGreaterThan(12);
      expect(config.cooldownMs).toBeGreaterThan(0);
    }

    expect(WEAPON_CONFIG.explosive.enabledByDefault).toBe(false);
    expect(ABILITY_CONFIG.barrage.enabledByDefault).toBe(false);
    expect(ABILITY_CONFIG.barrage).toMatchObject({ durationMs: 0, radius: 0 });
    expect(ABILITY_CONFIG.smoke).toMatchObject({ durationMs: 4500, radius: 450 });
  });
});

describe("phase 2 schemas", () => {
  it("provides room state defaults for server and client rendering", () => {
    const state = new Alpha7StateSchema();

    expect(state.match.roomName).toBe(BATTLE_ROYALE_ROOM);
    expect(state.matchState).toBe("waiting");
    expect(state.zonePhase.matchState).toBe("waiting");
    expect(state.roomCode).toBe("");
    expect(state.seed).toBe("");
    expect(state.arenaConfigJson).toBe("");
    expect(state.players.size).toBe(0);
    expect(state.projectiles.length).toBe(0);
    expect(state.pickups.length).toBe(0);
  });

  it("keeps state helper methods synchronized", () => {
    const state = new Alpha7StateSchema();

    state.setMatchState("danger");
    state.seed = "phase-2-seed";
    state.arenaConfigJson = "{\"seed\":\"phase-4-seed\"}";

    expect(state.matchState).toBe("danger");
    expect(state.zonePhase.matchState).toBe("danger");
    expect(state.seed).toBe("phase-2-seed");
    expect(state.arenaConfigJson).toContain("phase-4-seed");
  });

  it("omits the deprecated arena duplicate without shifting legacy wire fields", () => {
    const current = new CurrentWireState();
    current.canonical = "canonical arena";
    current.trailing = "still aligned";
    const bytes = new Encoder(current).encodeAll();
    const legacy = new LegacyWireState();

    new Decoder(legacy).decode(bytes);

    expect(legacy.canonical).toBe("canonical arena");
    expect(legacy.duplicate).toBe("");
    expect(legacy.trailing).toBe("still aligned");
  });

  it("keeps an eight-player arena snapshot below half the server encoder buffer", () => {
    const state = new Alpha7StateSchema();
    state.arenaConfigJson = JSON.stringify(
      generateArenaConfig({ seed: "snapshot-headroom", playerCount: 8 })
    );

    expect(new Encoder(state).encodeAll().byteLength).toBeLessThan(48 * 1024);
  });

  it("keeps every synchronized schema below the 63-field limit with expansion headroom", () => {
    const synchronizedSchemas = [
      MatchCoreSchema,
      ZoneCoreSchema,
      ZonePhaseSchema,
      PlayerSchema,
      ProjectileSchema,
      PickupSchema,
      RoomPolicySchema,
      OwnerSchema,
      Alpha7StateSchema
    ];

    for (const synchronizedSchema of synchronizedSchemas) {
      const fieldCount = Object.keys(Metadata.getFields(synchronizedSchema)).length;
      expect(
        63 - fieldCount,
        `${synchronizedSchema.name} schema field headroom`
      ).toBeGreaterThanOrEqual(7);
    }
  });

  it("provides player, projectile, and pickup defaults", () => {
    const player = new PlayerSchema();
    const owner = new OwnerSchema();
    const projectile = new ProjectileSchema();
    const pickup = new PickupSchema();

    expect(player.archetypeId).toBe("atlas");
    expect(player.weaponType).toBe("light_cannon");
    expect(player.abilityType).toBe("shield_pulse");
    expect(player.health).toBe(120);
    expect(player.maxHealth).toBe(120);
    expect(player.armor).toBe(45);
    expect(player.maxArmor).toBe(45);
    expect(player.isAlive).toBe(true);
    expect(player.isSpectator).toBe(false);
    expect(player.speedMultiplier).toBe(1);
    expect(player.placement).toBe(0);
    expect(player.teamPlacement).toBe(0);
    expect(player.teamKills).toBe(0);
    expect(player.damageDealt).toBe(0);
    expect(owner.agentPairingExpiresAtMs).toBe(0);
    expect(projectile.weaponType).toBe("cannon");
    expect(projectile.fireSequence).toBe(0);
    expect(projectile.radius).toBeGreaterThan(0);
    expect(pickup.pickupType).toBe("health_repair");
    expect(pickup.isActive).toBe(true);
  });
});

describe("shared tank movement", () => {
  it("accelerates and brakes tanks instead of snapping to full speed", () => {
    const atlas = TANK_ARCHETYPE_CONFIG.atlas;
    const firstStep = integrateTankMovement({
      state: { x: 0, y: 0, rotation: 0, velocityX: 0, velocityY: 0 },
      input: { moveX: 1, moveY: 0 },
      deltaSeconds: 1 / 60,
      maxSpeed: atlas.speed,
      handling: atlas.handling
    });

    expect(firstStep.forwardSpeed).toBeGreaterThan(0);
    expect(firstStep.forwardSpeed).toBeLessThan(atlas.speed * 0.2);
    expect(firstStep.forwardSpeed).toBeCloseTo(atlas.handling.acceleration / 60);

    const brakeStep = integrateTankMovement({
      state: firstStep,
      input: { moveX: 0, moveY: 0 },
      deltaSeconds: 1 / 60,
      maxSpeed: atlas.speed,
      handling: atlas.handling
    });

    expect(Math.abs(brakeStep.forwardSpeed)).toBeLessThan(Math.abs(firstStep.forwardSpeed));

    const boostedStep = integrateTankMovement({
      state: firstStep,
      input: { moveX: 1, moveY: 0 },
      deltaSeconds: 1 / 60,
      maxSpeed: atlas.speed,
      handling: atlas.handling,
      speedMultiplier: 1.55
    });
    expect(boostedStep.targetForwardSpeed).toBeCloseTo(atlas.speed * 1.55);
  });

  it("turns toward a new heading using archetype turn rate", () => {
    const rook = TANK_ARCHETYPE_CONFIG.rook;
    const step = integrateTankMovement({
      state: { x: 0, y: 0, rotation: 0, velocityX: 0, velocityY: 0 },
      input: { moveX: 0, moveY: 1 },
      deltaSeconds: 1 / 60,
      maxSpeed: rook.speed,
      handling: rook.handling
    });

    expect(step.rotation).toBeGreaterThan(0);
    expect(step.rotation).toBeLessThan(Math.PI / 2);
  });

  it("uses the shortest drivetrain direction around the hull midpoint", () => {
    const atlas = TANK_ARCHETYPE_CONFIG.atlas;
    const stepAt = (
      degrees: number,
      state: TankMovementState = { x: 0, y: 0, rotation: 0, velocityX: 0, velocityY: 0 }
    ) => integrateTankMovement({
      state,
      input: {
        moveX: Math.cos((degrees * Math.PI) / 180),
        moveY: Math.sin((degrees * Math.PI) / 180)
      },
      deltaSeconds: 1 / 60,
      maxSpeed: atlas.speed,
      handling: atlas.handling
    });

    expect(stepAt(89).isReversing).toBe(false);
    expect(stepAt(91).isReversing).toBe(true);
    expect(stepAt(91).forwardSpeed).toBeCloseTo(-atlas.handling.acceleration / 60);

    const cardinalTravel = [0, 45, 90, 135].map((degrees) => {
      let state: TankMovementState = { x: 0, y: 0, rotation: 0, velocityX: 0, velocityY: 0 };
      for (let frame = 0; frame < 15; frame += 1) state = stepAt(degrees, state);
      return Math.hypot(state.x, state.y);
    });
    expect(Math.max(...cardinalTravel) - Math.min(...cardinalTravel)).toBeLessThan(3);
  });

  it("engages the track brake without coasting after movement is released", () => {
    for (const tank of Object.values(TANK_ARCHETYPE_CONFIG)) {
      const state: TankMovementState = {
        x: 0,
        y: 0,
        rotation: 0,
        velocityX: tank.speed,
        velocityY: 0
      };

      const stopped = integrateTankMovement({
        state,
        input: { moveX: 0, moveY: 0 },
        deltaSeconds: 1 / 60,
        maxSpeed: tank.speed,
        handling: tank.handling
      });

      expect(Math.hypot(stopped.velocityX, stopped.velocityY)).toBe(0);
      expect(stopped.x).toBe(0);
      expect(stopped.y).toBe(0);
    }
  });
});

describe("shared tank collision response", () => {
  const bounds = { minX: 0, minY: 0, maxX: 300, maxY: 300 };
  const wall = { x: 100, y: 100, width: 96, height: 96 };

  it("keeps flat-wall movement on the collision-free axis", () => {
    expect(resolveTankCollisionMovement({
      current: { x: 70, y: 140 },
      desired: { x: 80, y: 146 },
      radius: TANK_COLLISION_RADIUS,
      bounds,
      obstacles: [wall]
    })).toEqual({ x: 70, y: 146 });
  });

  it("preserves a safe rounded-corner tangent for both rectangle representations", () => {
    const resolveCorner = (
      current: ArenaPoint,
      obstacle = wall,
      obstacleOrigin: "center" | "top-left" = "top-left"
    ) => resolveTankCollisionMovement({
      current,
      desired: { x: current.x + 4, y: current.y + 2 },
      radius: TANK_COLLISION_RADIUS,
      bounds,
      obstacles: [obstacle],
      obstacleOrigin
    });

    const topLeft = resolveCorner({ x: 80, y: 80 });
    const centered = resolveCorner(
      { x: 80, y: 80 },
      { x: 148, y: 148, width: 96, height: 96 },
      "center"
    );
    expect(centered.x).toBeCloseTo(topLeft.x);
    expect(centered.y).toBeCloseTo(topLeft.y);
    expect(Math.hypot(topLeft.x - 80, topLeft.y - 80)).toBeGreaterThan(0);

    let point = topLeft;
    for (let step = 0; step < 11; step += 1) {
      const next = resolveCorner(point);
      expect(Math.hypot(next.x - point.x, next.y - point.y)).toBeGreaterThan(0);
      expect(circleIntersectsCollisionRect(next, TANK_COLLISION_RADIUS, wall)).toBe(false);
      point = next;
    }
  });

  it("does not mistake an unchanged cardinal slide for corner progress", () => {
    for (const desired of [{ x: 84, y: 80 }, { x: 80, y: 84 }]) {
      const current = { x: 80, y: 80 };
      const next = resolveTankCollisionMovement({
        current,
        desired,
        radius: TANK_COLLISION_RADIUS,
        bounds,
        obstacles: [wall]
      });

      expect(Math.hypot(next.x - current.x, next.y - current.y)).toBeGreaterThan(0);
      expect(circleIntersectsCollisionRect(next, TANK_COLLISION_RADIUS, wall)).toBe(false);
    }
  });

  it("does not invent sideways movement for a radial corner command or a stop", () => {
    const current = { x: 80, y: 80 };
    expect(resolveTankCollisionMovement({
      current,
      desired: { x: 84, y: 84 },
      radius: TANK_COLLISION_RADIUS,
      bounds,
      obstacles: [wall]
    })).toEqual(current);
    expect(resolveTankCollisionMovement({
      current,
      desired: current,
      radius: TANK_COLLISION_RADIUS,
      bounds,
      obstacles: [wall]
    })).toEqual(current);
  });
});

const pointDistance = (a: ArenaPoint, b: ArenaPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

describe("phase 4 seeded arena generation", () => {
  it("keeps seeded RNG streams deterministic and forkable", () => {
    const sequenceForSeed = () => {
      const rng = createSeededRng("alpha7-rng");
      return Array.from({ length: 8 }, () => rng.next());
    };
    const sequenceA = sequenceForSeed();
    const rngA = createSeededRng("alpha7-rng");
    const rngB = createSeededRng("alpha7-rng");

    expect(sequenceA).toEqual(sequenceForSeed());
    expect([rngA.int(1, 10), rngA.int(1, 10), rngA.bool(0.5)]).toEqual([
      rngB.int(1, 10),
      rngB.int(1, 10),
      rngB.bool(0.5)
    ]);
    expect(createSeededRng("alpha7-rng").shuffle([1, 2, 3, 4, 5])).toEqual(
      createSeededRng("alpha7-rng").shuffle([1, 2, 3, 4, 5])
    );
    expect(createSeededRng("alpha7-rng").fork("maze").next()).not.toBe(
      createSeededRng("alpha7-rng").fork("pickups").next()
    );
  });

  it("generates deterministic maze configs for a seed", () => {
    const arenaA = generateArenaConfig({ seed: "phase-4-maze", playerCount: 8 });
    const arenaB = generateArenaConfig({ seed: "phase-4-maze", playerCount: 8 });
    const arenaC = generateArenaConfig({ seed: "phase-4-maze-other", playerCount: 8 });

    expect(arenaA).toEqual(arenaB);
    expect(arenaA.version).toBe(ARENA_CONFIG_VERSION);
    expect(arenaA.grid.layout).not.toEqual(arenaC.grid.layout);
    expect(arenaA.wallRects.length).toBeGreaterThan(0);
    expect(arenaA.collisionRects.length).toBe(arenaA.wallRects.length);
    expect(arenaA.pockets.length).toBeGreaterThanOrEqual(3);
    expect(arenaA.chokePoints.length).toBeGreaterThan(0);
  });

  it("plans deterministic arena weather with a rain-biased distribution", () => {
    const weatherA = planArenaWeather("phase-4-weather");
    const weatherB = planArenaWeather("phase-4-weather");
    const rainyCount = Array.from({ length: 100 }, (_, index): number =>
      planArenaWeather(`phase-4-weather-${index}`).kind === "rain" ? 1 : 0
    ).reduce((sum, value) => sum + value, 0);

    expect(weatherA).toEqual(weatherB);
    expect(["clear", "rain"]).toContain(weatherA.kind);
    expect(weatherA.intensity).toBeGreaterThanOrEqual(0);
    expect(weatherA.intensity).toBeLessThanOrEqual(1);
    expect(rainyCount).toBeGreaterThan(55);
    expect(rainyCount).toBeLessThan(85);
  });

  it("validates floor connectivity across maze pockets and loops", () => {
    const arena = generateArenaConfig({
      seed: "phase-4-connectivity",
      playerCount: 8,
      width: 2200,
      height: 1500
    });
    const connectivity = validateArenaConnectivity(arena);

    expect(connectivity.ok).toBe(true);
    expect(connectivity.reachableFloorCount).toBe(connectivity.floorCount);
    expect(connectivity.floorCount).toBe(arena.floorCells.length);

    const clamped = clampToArena(arena, -100, -100, arena.spawnPoints[0]?.radius ?? 20);
    expect(isWallCollision(arena, clamped.x, clamped.y, arena.spawnPoints[0]?.radius ?? 20)).toBe(false);
  });

  it("places fair spawn points on clear floor cells", () => {
    const arena = generateArenaConfig({ seed: "phase-4-spawns", playerCount: 8 });
    const minFairDistance = Math.min(arena.width, arena.height) * 0.13;

    expect(arena.spawnPoints).toHaveLength(8);

    for (const spawn of arena.spawnPoints) {
      expect(isWallCollision(arena, spawn.x, spawn.y, TANK_COLLISION_RADIUS)).toBe(false);
      expect(Number.isFinite(spawn.rotation)).toBe(true);
    }

    for (let i = 0; i < arena.spawnPoints.length; i += 1) {
      const spawnA = arena.spawnPoints[i];
      if (!spawnA) continue;
      for (let j = i + 1; j < arena.spawnPoints.length; j += 1) {
        const spawnB = arena.spawnPoints[j];
        if (!spawnB) continue;
        expect(pointDistance(spawnA, spawnB)).toBeGreaterThan(minFairDistance);
      }
    }
  });

  it("places pickups on valid clear floor away from spawns and each other", () => {
    const arena = generateArenaConfig({ seed: "phase-4-pickups", playerCount: 8 });
    const pickupTypes = new Set(arena.pickupPlacements.map((pickup) => pickup.pickupType));

    expect(arena.pickupPlacements.length).toBeGreaterThanOrEqual(PICKUP_TYPES.length);
    expect(pickupTypes.size).toBeGreaterThan(3);

    for (const pickup of arena.pickupPlacements) {
      expect(PICKUP_TYPES).toContain(pickup.pickupType);
      expect(pickup.value).toBe(PICKUP_CONFIG[pickup.pickupType].value);
      expect(isWallCollision(arena, pickup.x, pickup.y, pickup.radius)).toBe(false);

      for (const spawn of arena.spawnPoints) {
        expect(pointDistance(pickup, spawn)).toBeGreaterThan(pickup.radius + spawn.radius);
      }
    }

    for (let i = 0; i < arena.pickupPlacements.length; i += 1) {
      const pickupA = arena.pickupPlacements[i];
      if (!pickupA) continue;
      for (let j = i + 1; j < arena.pickupPlacements.length; j += 1) {
        const pickupB = arena.pickupPlacements[j];
        if (!pickupB) continue;
        expect(pointDistance(pickupA, pickupB)).toBeGreaterThan(pickupA.radius + pickupB.radius);
      }
    }
  });

  it("plans deterministic shrinking zone phases with movable time origin", () => {
    const arena = generateArenaConfig({ seed: "phase-4-zones", playerCount: 6 });
    const zeroPlan = planZonePhases(arena, 0);
    const shiftedPlan = planZonePhases(arena, 12_345);

    expect(arena.zonePhases).toEqual(zeroPlan);
    expect(zeroPlan.map((phase) => phase.matchState)).toEqual(["running", "danger", "final_zone"]);
    expect(shiftedPlan[0]?.startsAt).toBe(12_345);

    for (let index = 0; index < zeroPlan.length; index += 1) {
      const phase = zeroPlan[index];
      if (!phase) continue;
      expect(phase.warningAt).toBeGreaterThanOrEqual(phase.startsAt);
      expect(phase.closesAt).toBeGreaterThan(phase.warningAt);
      expect(phase.targetRadius).toBeLessThan(phase.radius);
      expect(phase.x).toBeGreaterThanOrEqual(0);
      expect(phase.x).toBeLessThanOrEqual(arena.width);
      expect(phase.y).toBeGreaterThanOrEqual(0);
      expect(phase.y).toBeLessThanOrEqual(arena.height);
      if (index > 0) {
        const previous = zeroPlan[index - 1];
        if (previous) expect(phase.radius).toBeLessThan(previous.radius);
      }
    }
  });
});

describe("phase 2 messages", () => {
  it("provides typed client and server message payloads", () => {
    const join: ClientToServerMessage<"join"> = {
      playerName: "Nova Pilot",
      archetypeId: "nova",
      clientVersion: "test"
    };
    const input: ClientToServerMessage<typeof CLIENT_MESSAGE_TYPES.INPUT> = {
      sequence: 1,
      tick: 10,
      moveX: 1,
      moveY: 0,
      aimX: 10,
      aimY: 20,
      fire: true,
      ability: false
    };
    const start: ClientToServerMessage<typeof CLIENT_MESSAGE_TYPES.START> = {
      start: true
    };
    const pairing: ClientToServerMessage<typeof CLIENT_MESSAGE_TYPES.AGENT_PAIRING_CREATE> = {
      agentLabel: "Scout",
      controlMode: "tactical_reflex_v1"
    };
    const cancelPairing: ClientToServerMessage<typeof CLIENT_MESSAGE_TYPES.AGENT_PAIRING_CANCEL> = {
      requestId: "pairing-1"
    };
    const cancelPairingAfterReconnect: ClientToServerMessage<
      typeof CLIENT_MESSAGE_TYPES.AGENT_PAIRING_CANCEL
    > = {};
    const controlAgent: ClientToServerMessage<typeof CLIENT_MESSAGE_TYPES.AGENT_CONTROL> = {
      action: "pause"
    };
    const system: ServerToClientMessage<typeof SERVER_MESSAGE_TYPES.SYSTEM> = {
      code: "match_state",
      message: "Match running",
      matchState: "running",
      at: 123
    };
    const joined: ServerToClientMessage<"system"> = {
      message: "joined",
      roomCode: "ABC123",
      matchState: "waiting",
      seed: "phase-2-seed"
    };
    const error: ServerToClientMessage<typeof SERVER_MESSAGE_TYPES.ERROR> = {
      code: "invalid_payload",
      message: "Bad input",
      retryable: false,
      field: "moveX"
    };
    const impact: ServerToClientMessage<typeof SERVER_MESSAGE_TYPES.PROJECTILE_IMPACT> = {
      projectileId: "projectile-1",
      ownerId: "host1",
      fireSequence: 12,
      weaponType: "cannon",
      reason: "tank",
      x: 42,
      y: 64,
      rotation: 0,
      radius: 8,
      splashRadius: 0,
      targetSessionId: "guest1",
      damage: 18,
      destroyed: false,
      shieldHit: true,
      at: 123
    };
    const pairingResult: ServerToClientMessage<
      typeof SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT
    > = {
      requestId: "pairing-1",
      action: "create",
      accepted: true,
      seatState: "pending",
      pairingCode: "one-time-code",
      expiresAtMs: 60_000
    };
    const controlResult: ServerToClientMessage<
      typeof SERVER_MESSAGE_TYPES.AGENT_CONTROL_RESULT
    > = {
      action: "pause",
      accepted: true,
      seatState: "paused"
    };

    expect(CLIENT_MESSAGE_TYPES.JOIN).toBe("join");
    expect(CLIENT_MESSAGE_TYPES.START).toBe("start");
    expect(CLIENT_MESSAGE_TYPES.AGENT_PAIRING_CREATE).toBe("agent_pairing_create");
    expect(CLIENT_MESSAGE_TYPES.AGENT_PAIRING_CANCEL).toBe("agent_pairing_cancel");
    expect(CLIENT_MESSAGE_TYPES.AGENT_CONTROL).toBe("agent_control");
    expect(SERVER_MESSAGE_TYPES.PROJECTILE_IMPACT).toBe("projectile_impact");
    expect(SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT).toBe("agent_pairing_result");
    expect(SERVER_MESSAGE_TYPES.AGENT_CONTROL_RESULT).toBe("agent_control_result");
    expect(start.start).toBe(true);
    expect(input.sequence).toBe(1);
    expect(system.matchState).toBe("running");
    expect(joined.roomCode).toBe("ABC123");
    expect(error.retryable).toBe(false);
    expect(impact.fireSequence).toBe(12);
    expect(impact.reason).toBe("tank");
    expect(pairing.agentLabel).toBe("Scout");
    expect(pairing.controlMode).toBe("tactical_reflex_v1");
    expect(cancelPairing.requestId).toBe("pairing-1");
    expect(cancelPairingAfterReconnect.requestId).toBeUndefined();
    expect(controlAgent.action).toBe("pause");
    expect(pairingResult.pairingCode).toBe("one-time-code");
    expect(controlResult.seatState).toBe("paused");
  });
});
