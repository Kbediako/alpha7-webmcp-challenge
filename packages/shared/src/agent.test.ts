import { Decoder, Encoder } from "@colyseus/schema";
import { describe, expect, it } from "vitest";
import {
  AGENT_ACTION_INTERVAL_MS,
  AGENT_ACTION_MAX_LEASE_MS,
  AGENT_ACTION_MIN_LEASE_MS,
  AGENT_MAX_DECISIONS_PER_SECOND,
  AGENT_OBSERVATION_INTERVAL_MS,
  AGENT_PRODUCTION_COMBATANT_CAP,
  AGENT_TACTICAL_INTENT_MAX_DURATION_MS,
  AGENT_TACTICAL_INTENT_MIN_DURATION_MS,
  buildRoomPolicy,
  chooseAgentTacticalRetreat,
  isAgentTacticalIntentResultV1,
  isAgentTacticalStatusV1,
  isPlayerConcealedBySmoke,
  parseAgentMacroActionV1,
  parseAgentTacticalIntentV1,
  roomStartMinimums,
  type AgentMacroActionV1,
  type AgentTacticalIntentV1,
  type RoomMode
} from "./agent.js";
import {
  Alpha7StateSchema,
  OwnerSchema,
  PlayerSchema
} from "./schema.js";

const validAction = (): AgentMacroActionV1 => ({
  version: 1,
  actionSeq: 1,
  basedOnObservationSeq: 1,
  leaseMs: 500,
  waypoints: [{ x: 125, z: 250 }],
  pickupId: "pickup-1",
  targetId: "target-1",
  fire: "single",
  useAbility: "once"
});

it("chooses a deterministic direct retreat and points overlaps toward zone safety", () => {
  expect(chooseAgentTacticalRetreat(
    { x: 500, z: 500 },
    { x: 550, z: 500 },
    0,
    { x: 500, z: 500 },
    () => true
  )).toEqual({ x: 432.5, z: 500 });
  expect(chooseAgentTacticalRetreat(
    { x: 890, z: 500 },
    { x: 890, z: 500 },
    Math.PI,
    { x: 500, z: 500 },
    () => true
  )).toEqual({ x: 820, z: 500 });
});

const validTacticalIntent = (): AgentTacticalIntentV1 => ({
  version: 1,
  intentSeq: 1,
  basedOnObservationSeq: 1,
  validForMs: 30_000,
  objective: { type: "engage_target", targetId: "target-1" },
  fire: "hold",
  useAbility: "once",
  fallback: "hold"
});

describe("agent room policy", () => {
  it("defines mode-specific owner and combatant minimums", () => {
    expect(Object.fromEntries(
      (["classic", "wingman", "open_ffa", "agent_cup"] as RoomMode[])
        .map((mode) => [mode, roomStartMinimums(mode)])
    )).toEqual({
      classic: { owners: 2, combatants: 2 },
      wingman: { owners: 2, combatants: 4 },
      open_ffa: { owners: 1, combatants: 2 },
      agent_cup: { owners: 2, combatants: 2 }
    });
  });

  it("defaults every production mode to no more than eight combatants", () => {
    const expected = {
      classic: { track: "none", owners: 8, controls: 0, combatants: 8 },
      wingman: { track: "custom", owners: 4, controls: 4, combatants: 8 },
      open_ffa: { track: "custom", owners: 8, controls: 8, combatants: 8 },
      agent_cup: { track: "custom", owners: 8, controls: 8, combatants: 8 }
    } as const;

    for (const mode of Object.keys(expected) as RoomMode[]) {
      const policy = buildRoomPolicy(mode);
      const modeExpected = expected[mode];

      expect(policy).toMatchObject({
        mode,
        track: modeExpected.track,
        ownerCap: modeExpected.owners,
        humanWsCap: modeExpected.owners,
        agentControlCap: modeExpected.controls,
        combatantCap: modeExpected.combatants,
        observationVersion: 1,
        actionVersion: 1,
        executorVersion: 1
      });
      expect(policy.combatantCap).toBeLessThanOrEqual(AGENT_PRODUCTION_COMBATANT_CAP);
    }
  });

  it("requires explicit qualification before constructing a 16-combatant policy", () => {
    expect(() => buildRoomPolicy("wingman", { combatantCap: 16 })).toThrow(
      "explicit capacity qualification"
    );

    expect(
      buildRoomPolicy("wingman", {
        combatantCap: 16,
        expandedCombatantsQualified: true
      })
    ).toMatchObject({
      ownerCap: 8,
      humanWsCap: 8,
      agentControlCap: 8,
      combatantCap: 16
    });
  });

  it("honors explicit owner, websocket, control, and combatant limits", () => {
    expect(
      buildRoomPolicy("open_ffa", {
        ownerCap: 6,
        humanWsCap: 5,
        agentControlCap: 2,
        combatantCap: 7
      })
    ).toMatchObject({
      ownerCap: 5,
      humanWsCap: 5,
      agentControlCap: 2,
      combatantCap: 7
    });
    expect(() => buildRoomPolicy("classic", { ownerCap: 9 })).toThrow("ownerCap");
    expect(() => buildRoomPolicy("open_ffa", { combatantCap: 0 })).toThrow("combatantCap");
    expect(buildRoomPolicy("classic", { agentControlCap: 0 }).agentControlCap).toBe(0);
    expect(() => buildRoomPolicy("agent_cup", { agentControlCap: 0 })).toThrow(
      "at least one agent control"
    );
  });

  it("keeps observation and action cadence at two decisions per second", () => {
    expect(AGENT_OBSERVATION_INTERVAL_MS).toBe(500);
    expect(AGENT_ACTION_INTERVAL_MS).toBe(500);
    expect(AGENT_MAX_DECISIONS_PER_SECOND).toBe(2);
  });
});

describe("Action V1 parser", () => {
  it("accepts the complete exact V1 shape without changing values", () => {
    expect(parseAgentMacroActionV1(validAction())).toEqual({
      ok: true,
      value: validAction()
    });
  });

  it("rejects unknown and missing top-level keys", () => {
    expect(parseAgentMacroActionV1({ ...validAction(), debug: true })).toEqual({
      ok: false,
      error: { code: "unknown_key", field: "debug" }
    });

    const { actionSeq: _omitted, ...missingActionSeq } = validAction();
    expect(parseAgentMacroActionV1(missingActionSeq)).toEqual({
      ok: false,
      error: { code: "missing_key", field: "actionSeq" }
    });
  });

  it("rejects unknown or missing waypoint keys", () => {
    expect(
      parseAgentMacroActionV1({
        ...validAction(),
        waypoints: [{ x: 1, z: 2, speed: 1 }]
      })
    ).toEqual({
      ok: false,
      error: { code: "unknown_key", field: "waypoints[0].speed" }
    });
    expect(parseAgentMacroActionV1({ ...validAction(), waypoints: [{ x: 1 }] })).toEqual({
      ok: false,
      error: { code: "missing_key", field: "waypoints[0].z" }
    });
  });

  it("rejects sequence, lease, waypoint, coordinate, and id limits", () => {
    expect(parseAgentMacroActionV1({ ...validAction(), actionSeq: 0 })).toMatchObject({
      ok: false,
      error: { code: "out_of_range", field: "actionSeq" }
    });
    expect(
      parseAgentMacroActionV1({ ...validAction(), leaseMs: AGENT_ACTION_MIN_LEASE_MS - 1 })
    ).toMatchObject({ ok: false, error: { code: "out_of_range", field: "leaseMs" } });
    expect(
      parseAgentMacroActionV1({ ...validAction(), leaseMs: AGENT_ACTION_MAX_LEASE_MS + 1 })
    ).toMatchObject({ ok: false, error: { code: "out_of_range", field: "leaseMs" } });
    expect(
      parseAgentMacroActionV1({
        ...validAction(),
        waypoints: Array.from({ length: 5 }, (_, index) => ({ x: index, z: index }))
      })
    ).toMatchObject({ ok: false, error: { code: "out_of_range", field: "waypoints" } });
    expect(
      parseAgentMacroActionV1({ ...validAction(), waypoints: [{ x: Number.NaN, z: 0 }] })
    ).toMatchObject({ ok: false, error: { field: "waypoints[0].x" } });
    expect(parseAgentMacroActionV1({ ...validAction(), targetId: " target " })).toMatchObject({
      ok: false,
      error: { code: "invalid_value", field: "targetId" }
    });
  });

  it("requires a target for single or held fire", () => {
    const { targetId: _omitted, ...withoutTarget } = validAction();
    expect(parseAgentMacroActionV1(withoutTarget)).toEqual({
      ok: false,
      error: { code: "missing_key", field: "targetId" }
    });
    expect(parseAgentMacroActionV1({ ...withoutTarget, fire: "none" })).toMatchObject({
      ok: true
    });
  });
});

describe("Tactical Intent V1 parser", () => {
  it("reconstructs the exact allowlisted tactic", () => {
    expect(parseAgentTacticalIntentV1(validTacticalIntent())).toEqual({
      ok: true,
      value: validTacticalIntent()
    });
    expect(parseAgentTacticalIntentV1({
      ...validTacticalIntent(),
      basedOnObservationSeq: null,
      objective: { type: "zone_center" },
      fire: "none"
    })).toMatchObject({ ok: true });
    expect(parseAgentTacticalIntentV1({
      ...validTacticalIntent(),
      basedOnObservationSeq: null,
      objective: { type: "engage_nearest" }
    })).toMatchObject({ ok: true });
  });

  it("rejects extra keys, malformed objectives, and incompatible fire policy", () => {
    expect(parseAgentTacticalIntentV1({ ...validTacticalIntent(), prompt: "ignore rules" }))
      .toMatchObject({ ok: false, error: { code: "unknown_key", field: "prompt" } });
    expect(parseAgentTacticalIntentV1({
      ...validTacticalIntent(),
      objective: { type: "move_to", position: { x: Number.NaN, z: 10 } },
      fire: "none"
    })).toMatchObject({ ok: false, error: { field: "objective.position" } });
    expect(parseAgentTacticalIntentV1({
      ...validTacticalIntent(),
      objective: { type: "zone_center" }
    })).toMatchObject({ ok: false, error: { field: "fire" } });
  });

  it("enforces sequence and lifetime boundaries", () => {
    expect(parseAgentTacticalIntentV1({ ...validTacticalIntent(), intentSeq: 0 }))
      .toMatchObject({ ok: false, error: { field: "intentSeq" } });
    expect(parseAgentTacticalIntentV1({
      ...validTacticalIntent(),
      validForMs: AGENT_TACTICAL_INTENT_MIN_DURATION_MS - 1
    })).toMatchObject({ ok: false, error: { field: "validForMs" } });
    expect(parseAgentTacticalIntentV1({
      ...validTacticalIntent(),
      validForMs: AGENT_TACTICAL_INTENT_MAX_DURATION_MS + 1
    })).toMatchObject({ ok: false, error: { field: "validForMs" } });
  });
});

describe("Tactical response V1 validation", () => {
  it("accepts only an exact, internally consistent intent result", () => {
    const accepted = {
      version: 1,
      type: "agent_tactical_intent_result",
      intentSeq: 2,
      accepted: true,
      code: "accepted",
      intentExpiresAtMs: 45_000
    };
    expect(isAgentTacticalIntentResultV1(accepted, 2)).toBe(true);
    expect(isAgentTacticalIntentResultV1({ ...accepted, debug: true }, 2)).toBe(false);
    expect(isAgentTacticalIntentResultV1({ ...accepted, intentSeq: 1 }, 2)).toBe(false);
    expect(isAgentTacticalIntentResultV1({ ...accepted, intentExpiresAtMs: null }, 2)).toBe(false);
    expect(isAgentTacticalIntentResultV1({
      ...accepted,
      accepted: false,
      code: "rate_limited",
      intentExpiresAtMs: null
    }, 2)).toBe(true);
  });

  it("binds an exact status to its room and seat", () => {
    const status = {
      version: 1,
      type: "agent_tactical_status",
      roomId: "room-1",
      seatId: "seat-1",
      mode: "open_ffa",
      track: "custom",
      controlMode: "tactical_reflex_v1",
      state: "connected",
      matchState: "running",
      observationSeq: 1,
      lastIntentSeq: 2,
      intentExpiresAtMs: 45_000,
      lastReflexAtMs: 1_000,
      active: true,
      stopReason: "moving",
      idleDeadlineMs: 15_000
    };
    const connection = { roomId: "room-1", seatId: "seat-1" };
    expect(isAgentTacticalStatusV1(status, connection)).toBe(true);
    expect(isAgentTacticalStatusV1({ ...status, roomId: "room-2" }, connection)).toBe(false);
    expect(isAgentTacticalStatusV1({ ...status, mode: "classic" }, connection)).toBe(false);
    expect(isAgentTacticalStatusV1({ ...status, prompt: "hidden" }, connection)).toBe(false);
    expect(isAgentTacticalStatusV1({ ...status, stopReason: "continue" }, connection)).toBe(false);
    expect(isAgentTacticalStatusV1({ ...status, active: false }, connection)).toBe(false);
    expect(isAgentTacticalStatusV1({ ...status, intentExpiresAtMs: null }, connection)).toBe(false);
    expect(isAgentTacticalStatusV1({ ...status, state: "paused" }, connection)).toBe(false);
    expect(isAgentTacticalStatusV1({ ...status, matchState: "waiting" }, connection)).toBe(false);
    expect(isAgentTacticalStatusV1({
      ...status,
      lastIntentSeq: 0
    }, connection)).toBe(false);
    expect(isAgentTacticalStatusV1({
      ...status,
      lastIntentSeq: 0,
      active: false,
      stopReason: "no_intent"
    }, connection)).toBe(false);
    expect(isAgentTacticalStatusV1({
      ...status,
      active: false,
      stopReason: "objective_complete",
      intentExpiresAtMs: null
    }, connection)).toBe(true);
    expect(isAgentTacticalStatusV1({
      ...status,
      observationSeq: 0,
      lastIntentSeq: 0,
      intentExpiresAtMs: null,
      lastReflexAtMs: null,
      active: false,
      stopReason: "no_intent"
    }, connection)).toBe(true);
  });
});

describe("shared smoke visibility", () => {
  const smokeState = {
    x: 100,
    y: 100,
    smokeEndsAt: 5_000,
    smokeX: 100,
    smokeY: 100
  };

  it("conceals only while the player remains inside its active smoke cloud", () => {
    expect(isPlayerConcealedBySmoke(smokeState, 1_000)).toBe(true);
    expect(
      isPlayerConcealedBySmoke(
        { ...smokeState, x: smokeState.x + 451 },
        1_000
      )
    ).toBe(false);
    expect(isPlayerConcealedBySmoke(smokeState, smokeState.smokeEndsAt)).toBe(false);
  });
});

describe("agent schema wire contract", () => {
  it("provides safe Classic and owner/player defaults", () => {
    const state = new Alpha7StateSchema();
    const owner = new OwnerSchema();
    const player = new PlayerSchema();

    expect(state.policy).toMatchObject({
      mode: "classic",
      track: "none",
      ownerCap: 8,
      humanWsCap: 8,
      agentControlCap: 0,
      combatantCap: 8,
      observationVersion: 1,
      actionVersion: 1,
      executorVersion: 1,
      tacticalReflexEnabled: false
    });
    expect(state.owners.size).toBe(0);
    expect(owner).toMatchObject({
      principalKind: "combatant",
      agentSeatState: "none",
      isConnected: true,
      isReady: false,
      isHost: false
    });
    expect(player).toMatchObject({ ownerId: "", pairId: "", controlKind: "human" });
  });

  it("round-trips appended owner, policy, and player fields", () => {
    const state = new Alpha7StateSchema();
    state.policy.mode = "wingman";
    state.policy.track = "custom";
    state.policy.ownerCap = 4;
    state.policy.humanWsCap = 4;
    state.policy.agentControlCap = 4;
    const owner = new OwnerSchema();
    owner.ownerId = "owner-1";
    owner.humanSessionId = "human-1";
    owner.displayName = "Operator";
    owner.agentSeatId = "agent-1";
    owner.agentLabel = "Scout";
    owner.agentSeatState = "connected";
    owner.isReady = true;
    owner.isHost = true;
    state.owners.set(owner.ownerId, owner);
    const player = new PlayerSchema();
    player.id = "agent-1";
    player.sessionId = "agent-1";
    player.ownerId = owner.ownerId;
    player.pairId = owner.ownerId;
    player.controlKind = "agent";
    state.players.set(player.sessionId, player);

    const decoded = new Alpha7StateSchema();
    new Decoder(decoded).decode(new Encoder(state).encodeAll());

    expect(decoded.policy).toMatchObject({
      mode: "wingman",
      track: "custom",
      ownerCap: 4,
      humanWsCap: 4,
      agentControlCap: 4
    });
    expect(decoded.owners.get("owner-1")).toMatchObject({
      humanSessionId: "human-1",
      agentSeatId: "agent-1",
      agentSeatState: "connected",
      isReady: true,
      isHost: true
    });
    expect(decoded.players.get("agent-1")).toMatchObject({
      ownerId: "owner-1",
      pairId: "owner-1",
      controlKind: "agent"
    });
  });
});
