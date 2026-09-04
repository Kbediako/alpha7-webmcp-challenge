import { describe, expect, it } from "vitest";
import type { AgentTacticalIntentV1 } from "@alpha7/shared";
import {
  AGENT_BROKER_IDLE_TTL_MS,
  AGENT_GRANT_TTL_MS,
  AgentBroker,
  AgentBrokerError,
  FixedWindowRateLimiter,
  runRateLimitedAgentCall,
  type AgentBrokerErrorCode,
  type AgentGrantBinding
} from "./agentBroker.js";

const BASE_BINDING: AgentGrantBinding = {
  roomId: "room-a",
  ownerId: "owner-a",
  seatId: "seat-a",
  roomMode: "wingman",
  agentName: "Pathfinder",
  archetype: "nova"
};
const TACTICAL_OPENING: AgentTacticalIntentV1 = {
  version: 1,
  intentSeq: 1,
  basedOnObservationSeq: null,
  validForMs: 45_000,
  objective: { type: "zone_center" },
  fire: "none",
  useAbility: false,
  fallback: "hold"
};

const expectBrokerError = (operation: () => unknown, code: AgentBrokerErrorCode): void => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentBrokerError);
    expect(error).toMatchObject({ code, message: code });
    return;
  }
  throw new Error(`expected ${code}`);
};

describe("AgentBroker grants", () => {
  it("issues a cryptographic 60-second capability without exposing it in stored state", () => {
    const broker = new AgentBroker();
    const nowMs = Date.now();
    const grant = broker.createGrant({ ...BASE_BINDING, sourceKey: "127.0.0.1" }, nowMs);

    expect(grant.requestId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(grant.grantCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grant.expiresAtMs).toBe(nowMs + AGENT_GRANT_TTL_MS);
    expect(grant.grantCredential).not.toBe(grant.requestId);
    expect(JSON.stringify(broker)).not.toContain(grant.grantCredential);
    expect(broker.pendingGrantCount).toBe(1);
  });

  it("enforces one pending owner and seat, and permits explicit cancellation", () => {
    const broker = new AgentBroker();
    const first = broker.createGrant({ ...BASE_BINDING, sourceKey: "source-a" }, 0);

    expectBrokerError(
      () => broker.createGrant({ ...BASE_BINDING, seatId: "seat-b", sourceKey: "source-b" }, 1),
      "pending_exists"
    );
    expectBrokerError(
      () => broker.createGrant({ ...BASE_BINDING, ownerId: "owner-b", sourceKey: "source-c" }, 2),
      "seat_reserved"
    );
    broker.cancelGrant(first.requestId, { roomId: "room-a", ownerId: "owner-a" }, 3);
    expect(broker.pendingGrantCount).toBe(0);
    expectBrokerError(
      () => broker.cancelGrant(first.requestId, { roomId: "room-a", ownerId: "owner-a" }, 4),
      "grant_cancelled"
    );
  });

  it("reports and prunes retained grant and rate-bucket capacity", () => {
    const broker = new AgentBroker();
    const grant = broker.createGrant({ ...BASE_BINDING, sourceKey: "source-a" }, 0);
    expect(broker.retainedGrantCount).toBe(1);
    expect(broker.retainedRateBucketCount).toBe(2);

    broker.cancelGrant(grant.requestId, { roomId: "room-a", ownerId: "owner-a" }, 1);
    broker.sweepExpired(60_001);

    expect(broker.retainedGrantCount).toBe(0);
    expect(broker.retainedRateBucketCount).toBe(0);
  });

  it("expires at exactly 60 seconds and reports the expired reservation once", async () => {
    const broker = new AgentBroker();
    const grant = broker.createGrant({ ...BASE_BINDING, sourceKey: "source-a" }, 5_000);

    await expect(
      broker.consumeGrant(
        {
          roomId: "room-a",
          grantCredential: grant.grantCredential,
          sourceKey: "source-b"
        },
        () => undefined,
        5_000 + AGENT_GRANT_TTL_MS
      )
    ).rejects.toMatchObject({ code: "grant_expired" });

    expect(broker.sweepExpired(5_000 + AGENT_GRANT_TTL_MS)).toEqual({
      expiredGrantRequestIds: [grant.requestId],
      expiredControls: []
    });
    expect(broker.sweepExpired(5_001 + AGENT_GRANT_TTL_MS)).toEqual({
      expiredGrantRequestIds: [],
      expiredControls: []
    });
  });

  it("locks consumption before materialization and rejects concurrent replay", async () => {
    const broker = new AgentBroker();
    const grant = broker.createGrant({ ...BASE_BINDING, sourceKey: "source-a" }, 0);
    let finishMaterialization: ((value: string) => void) | undefined;
    const materialization = new Promise<string>((resolve) => {
      finishMaterialization = resolve;
    });

    const firstConsume = broker.consumeGrant(
      {
        roomId: "room-a",
        grantCredential: grant.grantCredential,
        sourceKey: "source-b"
      },
      () => materialization,
      100
    );
    await Promise.resolve();

    await expect(
      broker.consumeGrant(
        {
          roomId: "room-a",
          grantCredential: grant.grantCredential,
          sourceKey: "source-c"
        },
        () => "duplicate",
        101
      )
    ).rejects.toMatchObject({ code: "grant_consumed" });
    expect(broker.activeControlCount).toBe(0);

    finishMaterialization?.("arena-ready");
    const consumed = await firstConsume;
    expect(consumed.materialized).toBe("arena-ready");
    expect(consumed.brokerCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(consumed.brokerCredential).not.toBe(grant.grantCredential);
    expect(consumed.session.idleDeadlineMs).toBe(100 + AGENT_BROKER_IDLE_TTL_MS);
    expect(broker.activeControlCount).toBe(1);
  });

  it("keeps a rejected materialization retryable and cancellable", async () => {
    const broker = new AgentBroker();
    const grant = broker.createGrant({ ...BASE_BINDING, sourceKey: "source-a" }, 0);

    await expect(
      broker.consumeGrant(
        {
          roomId: "room-a",
          grantCredential: grant.grantCredential,
          sourceKey: "source-b"
        },
        () => {
          throw new Error("room rejected seat");
        },
        10
      )
    ).rejects.toThrow("room rejected seat");
    expect(broker.activeControlCount).toBe(0);
    const retried = await broker.consumeGrant(
      {
        roomId: "room-a",
        grantCredential: grant.grantCredential,
        sourceKey: "source-c"
      },
      () => "retry accepted",
      11
    );
    expect(retried.materialized).toBe("retry accepted");

    const cancellableBroker = new AgentBroker();
    const cancellable = cancellableBroker.createGrant({ ...BASE_BINDING, sourceKey: "source-d" }, 0);
    await expect(
      cancellableBroker.consumeGrant(
        { roomId: "room-a", grantCredential: cancellable.grantCredential, sourceKey: "source-e" },
        () => Promise.reject(new Error("room rejected seat")),
        10
      )
    ).rejects.toThrow("room rejected seat");
    expect(() =>
      cancellableBroker.cancelGrant(cancellable.requestId, { roomId: "room-a", ownerId: "owner-a" }, 11)
    ).not.toThrow();
  });
});

describe("AgentBroker controls", () => {
  it("binds one immutable writer mode and derives mutually exclusive default scopes", async () => {
    const macroBroker = new AgentBroker();
    const macroGrant = macroBroker.createGrant({ ...BASE_BINDING, sourceKey: "macro" }, 0);
    const macro = await macroBroker.consumeGrant(
      { roomId: "room-a", grantCredential: macroGrant.grantCredential, sourceKey: "macro-consume" },
      () => undefined,
      1
    );
    expect(macro.session.principal).toMatchObject({
      controlMode: "macro_v1",
      scopes: ["agent:observe", "agent:act", "agent:heartbeat", "agent:release"]
    });
    expect(macro.session.principal.scopes).not.toContain("agent:tactic");

    const tacticalBroker = new AgentBroker();
    const tacticalGrant = tacticalBroker.createGrant({
      ...BASE_BINDING,
      controlMode: "tactical_reflex_v1",
      openingTactic: TACTICAL_OPENING,
      sourceKey: "tactical"
    }, 0);
    const tactical = await tacticalBroker.consumeGrant(
      { roomId: "room-a", grantCredential: tacticalGrant.grantCredential, sourceKey: "tactical-consume" },
      () => undefined,
      1
    );
    expect(tactical.session.principal).toMatchObject({
      controlMode: "tactical_reflex_v1",
      openingTactic: TACTICAL_OPENING,
      scopes: ["agent:observe", "agent:tactic", "agent:heartbeat", "agent:release"]
    });
    expect(tactical.session.principal.scopes).not.toContain("agent:act");
    expectBrokerError(() => tacticalBroker.authorize({
      brokerCredential: tactical.brokerCredential,
      roomId: "room-a",
      requiredScope: "agent:act"
    }, 2), "scope_denied");
    expect(() => tacticalBroker.createGrant({
      ...BASE_BINDING,
      ownerId: "owner-b",
      seatId: "seat-b",
      controlMode: "tactical_reflex_v1",
      openingTactic: TACTICAL_OPENING,
      scopes: ["agent:act"],
      sourceKey: "bad-scope"
    }, 3)).toThrow("control mode scope mismatch");
  });

  it("binds a sanitized opening to Tactical grants and rejects unbound writer modes", async () => {
    const opening: AgentTacticalIntentV1 = {
      ...TACTICAL_OPENING,
      objective: { type: "move_to", position: { x: 320, z: 640 } }
    };
    const broker = new AgentBroker();
    const grant = broker.createGrant({
      ...BASE_BINDING,
      controlMode: "tactical_reflex_v1",
      openingTactic: opening,
      sourceKey: "bound-opening"
    }, 0);
    if (opening.objective.type === "move_to") opening.objective.position.x = 999;
    const consumed = await broker.consumeGrant(
      { roomId: "room-a", grantCredential: grant.grantCredential, sourceKey: "bound-consume" },
      (principal) => principal.openingTactic,
      1
    );
    expect(consumed.materialized).toMatchObject({
      intentSeq: 1,
      objective: { type: "move_to", position: { x: 320, z: 640 } }
    });
    expect(consumed.session.principal.openingTactic).toEqual(consumed.materialized);

    expect(() => new AgentBroker().createGrant({
      ...BASE_BINDING,
      controlMode: "tactical_reflex_v1",
      sourceKey: "missing-opening"
    })).toThrow("tactical grant requires a valid opening tactic");
    expect(() => new AgentBroker().createGrant({
      ...BASE_BINDING,
      openingTactic: TACTICAL_OPENING,
      sourceKey: "macro-opening"
    })).toThrow("macro grant cannot include an opening tactic");
    expect(() => new AgentBroker().createGrant({
      ...BASE_BINDING,
      controlMode: "tactical_reflex_v1",
      openingTactic: { ...TACTICAL_OPENING, intentSeq: Number.MAX_SAFE_INTEGER },
      sourceKey: "noninitial-opening"
    })).toThrow("tactical grant requires a valid opening tactic");
  });

  it("binds room, owner, seat, scopes, mode, role, and track to the broker principal", async () => {
    const broker = new AgentBroker();
    const grant = broker.createGrant(
      {
        ...BASE_BINDING,
        scopes: ["agent:observe", "agent:heartbeat", "agent:release"],
        sourceKey: "source-a"
      },
      0
    );
    const materializedPrincipals: unknown[] = [];
    const consumed = await broker.consumeGrant(
      {
        roomId: "room-a",
        grantCredential: grant.grantCredential,
        sourceKey: "source-b"
      },
      (principal) => {
        materializedPrincipals.push(principal);
        return { arenaVersion: "arena-1" };
      },
      100
    );

    expect(materializedPrincipals).toEqual([consumed.session.principal]);
    expect(consumed.session.principal).toMatchObject({
      requestId: grant.requestId,
      roomId: "room-a",
      ownerId: "owner-a",
      seatId: "seat-a",
      roomMode: "wingman",
      role: "combatant",
      track: "custom",
      agentName: "Pathfinder",
      archetype: "nova",
      controlMode: "macro_v1",
      scopes: ["agent:observe", "agent:heartbeat", "agent:release"]
    });
    expect(JSON.stringify(consumed.session)).not.toContain(grant.grantCredential);
    expect(JSON.stringify(consumed.session)).not.toContain(consumed.brokerCredential);

    expect(
      broker.authorize(
        {
          brokerCredential: consumed.brokerCredential,
          roomId: "room-a",
          ownerId: "owner-a",
          seatId: "seat-a",
          requiredScope: "agent:observe"
        },
        101
      ).principal
    ).toEqual(consumed.session.principal);
    expectBrokerError(
      () => broker.authorize({
        brokerCredential: consumed.brokerCredential,
        roomId: "room-b",
        requiredScope: "agent:observe"
      }, 102),
      "principal_mismatch"
    );
    expectBrokerError(
      () => broker.authorize({
        brokerCredential: consumed.brokerCredential,
        roomId: "room-a",
        ownerId: "forged-owner",
        requiredScope: "agent:observe"
      }, 103),
      "principal_mismatch"
    );
    expectBrokerError(
      () => broker.authorize({
        brokerCredential: consumed.brokerCredential,
        roomId: "room-a",
        requiredScope: "agent:act"
      }, 104),
      "scope_denied"
    );
  });

  it("heartbeats while paused, resumes, and never extends idle on ordinary authorization", async () => {
    const broker = new AgentBroker();
    const grant = broker.createGrant({ ...BASE_BINDING, sourceKey: "source-a" }, 0);
    const consumed = await broker.consumeGrant(
      {
        roomId: "room-a",
        grantCredential: grant.grantCredential,
        sourceKey: "source-b"
      },
      () => undefined,
      100
    );
    const binding = { roomId: "room-a", ownerId: "owner-a", seatId: "seat-a" };

    const observed = broker.authorize({
      brokerCredential: consumed.brokerCredential,
      roomId: "room-a",
      requiredScope: "agent:observe"
    }, 5_000);
    expect(observed.lastUsedAtMs).toBe(5_000);
    expect(observed.idleDeadlineMs).toBe(100 + AGENT_BROKER_IDLE_TTL_MS);

    expect(broker.setPaused(binding, true, 5_001).paused).toBe(true);
    expectBrokerError(
      () => broker.authorize({
        brokerCredential: consumed.brokerCredential,
        roomId: "room-a",
        requiredScope: "agent:act"
      }, 5_002),
      "broker_paused"
    );
    const heartbeat = broker.heartbeat(consumed.brokerCredential, "room-a", 10_000);
    expect(heartbeat).toMatchObject({
      paused: true,
      lastUsedAtMs: 10_000,
      idleDeadlineMs: 10_000 + AGENT_BROKER_IDLE_TTL_MS
    });
    expect(broker.setPaused(binding, false, 10_001).paused).toBe(false);
    expect(
      broker.authorize({
        brokerCredential: consumed.brokerCredential,
        roomId: "room-a",
        requiredScope: "agent:act"
      }, 10_002).paused
    ).toBe(false);
  });

  it("fails closed at the idle deadline and returns expired controls for room cleanup", async () => {
    const broker = new AgentBroker();
    const grant = broker.createGrant({ ...BASE_BINDING, sourceKey: "source-a" }, 0);
    const consumed = await broker.consumeGrant(
      {
        roomId: "room-a",
        grantCredential: grant.grantCredential,
        sourceKey: "source-b"
      },
      () => undefined,
      100
    );
    const deadline = 100 + AGENT_BROKER_IDLE_TTL_MS;

    expectBrokerError(
      () => broker.authorize({
        brokerCredential: consumed.brokerCredential,
        roomId: "room-a",
        requiredScope: "agent:observe"
      }, deadline),
      "broker_expired"
    );
    const expired = broker.sweepExpired(deadline);
    expect(expired.expiredControls).toEqual([consumed.session.principal]);
    expect(broker.activeControlCount).toBe(0);
    expectBrokerError(
      () => broker.heartbeat(consumed.brokerCredential, "room-a", deadline + 1),
      "broker_invalid"
    );
  });

  it("supports credential release and owner revocation without retaining a usable secret", async () => {
    const releasedBroker = new AgentBroker();
    const releasedGrant = releasedBroker.createGrant(
      { ...BASE_BINDING, sourceKey: "source-a" },
      0
    );
    const released = await releasedBroker.consumeGrant(
      {
        roomId: "room-a",
        grantCredential: releasedGrant.grantCredential,
        sourceKey: "source-b"
      },
      () => undefined,
      1
    );
    expect(
      releasedBroker.releaseControl(released.brokerCredential, "room-a", 2)
    ).toEqual(released.session.principal);
    expectBrokerError(
      () => releasedBroker.heartbeat(released.brokerCredential, "room-a", 3),
      "broker_invalid"
    );

    const revokedBroker = new AgentBroker();
    const revokedGrant = revokedBroker.createGrant({ ...BASE_BINDING, sourceKey: "source-c" }, 0);
    const revoked = await revokedBroker.consumeGrant(
      {
        roomId: "room-a",
        grantCredential: revokedGrant.grantCredential,
        sourceKey: "source-d"
      },
      () => undefined,
      1
    );
    expect(
      revokedBroker.revokeControl({ roomId: "room-a", ownerId: "owner-a", seatId: "seat-a" })
    ).toEqual(revoked.session.principal);
    expectBrokerError(
      () => revokedBroker.authorize({
        brokerCredential: revoked.brokerCredential,
        roomId: "room-a",
        requiredScope: "agent:observe"
      }, 2),
      "broker_invalid"
    );
  });
});

describe("fixed-window limits", () => {
  it("resets at the window boundary and fails closed when key storage is full", () => {
    const limiter = new FixedWindowRateLimiter(1);
    const policy = { limit: 2, windowMs: 1_000 };

    expect(limiter.tryTake("a", policy, 0)).toBe(true);
    expect(limiter.tryTake("a", policy, 1)).toBe(true);
    expect(limiter.tryTake("a", policy, 2)).toBe(false);
    expect(limiter.tryTake("b", policy, 2)).toBe(false);
    expect(limiter.retainedBucketCount).toBe(1);
    expect(limiter.tryTake("b", policy, 1_000)).toBe(true);
    expect(limiter.retainedBucketCount).toBe(1);
    limiter.prune(2_000);
    expect(limiter.retainedBucketCount).toBe(0);
  });

  it("blocks excess agent HTTP calls before invoking the room", () => {
    const limiter = new FixedWindowRateLimiter();
    let remoteCalls = 0;
    let firstRejections = 0;
    const call = () => {
      remoteCalls += 1;
    };

    for (let request = 0; request < 4; request += 1) {
      runRateLimitedAgentCall(limiter, "control-a", "action", call, 0);
    }
    expectBrokerError(
      () => runRateLimitedAgentCall(
        limiter,
        "control-a",
        "action",
        call,
        0,
        () => {
          firstRejections += 1;
        }
      ),
      "rate_limited"
    );
    expectBrokerError(
      () => runRateLimitedAgentCall(
        limiter,
        "control-a",
        "action",
        call,
        0,
        () => {
          firstRejections += 1;
        }
      ),
      "rate_limited"
    );
    expect(remoteCalls).toBe(4);
    expect(firstRejections).toBe(1);
    expect(() =>
      runRateLimitedAgentCall(limiter, "control-a", "action", call, 1_000)
    ).not.toThrow();
    expect(remoteCalls).toBe(5);
  });

  it("retains action buckets beyond the longest accepted lease", () => {
    const limiter = new FixedWindowRateLimiter(1);

    for (let request = 0; request < 4; request += 1) {
      runRateLimitedAgentCall(limiter, "control-a", "action", () => undefined, request ? 999 : 0);
    }
    limiter.prune(1_000);

    expect(limiter.retainedBucketCount).toBe(1);
    expectBrokerError(
      () => runRateLimitedAgentCall(limiter, "control-b", "action", () => undefined, 1_000),
      "rate_limited"
    );
    expect(() =>
      runRateLimitedAgentCall(limiter, "control-a", "action", () => undefined, 1_000)
    ).not.toThrow();
    limiter.prune(5_999);
    expect(limiter.retainedBucketCount).toBe(1);
    limiter.prune(6_000);
    expect(limiter.retainedBucketCount).toBe(0);
  });

  it("limits grant creation by source and redemption before secret lookup", async () => {
    const broker = new AgentBroker({
      grantCreateRateLimit: { limit: 2, windowMs: 1_000 },
      grantConsumeRateLimit: { limit: 2, windowMs: 1_000 }
    });
    broker.createGrant({ ...BASE_BINDING, sourceKey: "shared-source" }, 0);
    broker.createGrant({
      ...BASE_BINDING,
      ownerId: "owner-b",
      seatId: "seat-b",
      sourceKey: "shared-source"
    }, 1);
    expectBrokerError(
      () => broker.createGrant({
        ...BASE_BINDING,
        ownerId: "owner-c",
        seatId: "seat-c",
        sourceKey: "shared-source"
      }, 2),
      "rate_limited"
    );

    for (const nowMs of [10, 11]) {
      await expect(
        broker.consumeGrant(
          { roomId: "room-a", grantCredential: "guessed-secret", sourceKey: "attacker" },
          () => undefined,
          nowMs
        )
      ).rejects.toMatchObject({ code: "grant_invalid" });
    }
    await expect(
      broker.consumeGrant(
        { roomId: "room-a", grantCredential: "another-guess", sourceKey: "attacker" },
        () => undefined,
        12
      )
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("does not allocate owner consume buckets for wrong-room grants", async () => {
    const broker = new AgentBroker({
      grantConsumeRateLimit: { limit: 1, windowMs: 1_000 }
    });
    const grant = broker.createGrant({ ...BASE_BINDING, sourceKey: "grant-source" }, 0);

    await expect(
      broker.consumeGrant(
        { roomId: "room-b", grantCredential: grant.grantCredential, sourceKey: "wrong-room-source" },
        () => undefined,
        1
      )
    ).rejects.toMatchObject({ code: "grant_invalid" });
    await expect(
      broker.consumeGrant(
        { roomId: "room-a", grantCredential: grant.grantCredential, sourceKey: "correct-source" },
        () => undefined,
        2
      )
    ).resolves.toMatchObject({ materialized: undefined });
  });

  it("does not allocate owner buckets after the source limit rejects", () => {
    const broker = new AgentBroker({
      grantCreateRateLimit: { limit: 1, windowMs: 1_000 },
      grantCreateSourceRateLimit: { limit: 1, windowMs: 1_000 }
    });
    broker.createGrant({ ...BASE_BINDING, sourceKey: "shared-source" }, 0);

    expectBrokerError(
      () => broker.createGrant({
        ...BASE_BINDING,
        ownerId: "owner-b",
        seatId: "seat-b",
        sourceKey: "shared-source"
      }, 1),
      "rate_limited"
    );
    expect(broker.retainedRateBucketCount).toBe(2);
  });
});
