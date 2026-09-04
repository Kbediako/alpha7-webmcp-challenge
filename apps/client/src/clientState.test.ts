import { describe, expect, it } from "vitest";
import { ABILITY_CONFIG } from "@alpha7/shared";
import {
  activeAgentControlCount,
  agentRoomReadiness,
  canStartRoom,
  buildHudScenarioSnapshot,
  canRequestAgentPairing,
  cycleSpectatorTarget,
  createSiteVisitorId,
  isOuterBoundaryWall,
  isPlayerConcealedBySmoke,
  matchStandings,
  ownedAgentSessionId,
  parseMapConfig,
  parsePlayersOnline,
  shouldAutoReconnectOnPageLoad,
  shouldRepeatHeldFire,
  shouldShowIphoneStandaloneHint,
  shouldStartFreshQuickPlayAfterReconnect,
  spectatorTargets,
  snapshotServerNow
} from "./clientState";

describe("agent room readiness", () => {
  const owner = (ownerId: string, agentSeatState: "none" | "pending" | "connected") => ({
    ownerId,
    agentSeatState,
    isConnected: true,
    isReady: true
  });

  it("blocks only the local Ready action while another owner is pairing", () => {
    expect(
      agentRoomReadiness("wingman", [owner("self", "connected"), owner("other", "pending")], "self")
    ).toEqual({ readinessBlocked: false, startBlocked: true });
  });

  it("allows an Open FFA owner to ready without an optional agent", () => {
    expect(agentRoomReadiness("open_ffa", [owner("self", "none")], "self")).toEqual({
      readinessBlocked: false,
      startBlocked: true
    });
  });

  it("matches mode-specific host start minimums", () => {
    expect(canStartRoom("classic", true, 1, 0, false)).toBe(false);
    expect(canStartRoom("classic", true, 2, 0, false)).toBe(true);
    expect(canStartRoom("open_ffa", true, 1, 1, false)).toBe(true);
    expect(canStartRoom("wingman", true, 2, 1, false)).toBe(false);
    expect(canStartRoom("wingman", true, 2, 2, false)).toBe(true);
  });

  it("requires a second Open FFA combatant, not a second owner", () => {
    expect(agentRoomReadiness("open_ffa", [owner("self", "connected")], "self"))
      .toEqual({ readinessBlocked: false, startBlocked: false });
    expect(agentRoomReadiness("open_ffa", [owner("self", "none")], "self").startBlocked)
      .toBe(true);
    expect(agentRoomReadiness(
      "open_ffa",
      [owner("self", "none"), owner("other", "none")],
      "self"
    ).startBlocked).toBe(false);
  });

  it.each(["wingman", "agent_cup"] as const)(
    "keeps one complete %s owner-agent pair below the start minimum",
    (mode) => {
      const readiness = agentRoomReadiness(mode, [owner("self", "connected")], "self");
      expect(readiness.startBlocked).toBe(true);
      expect(canStartRoom(mode, true, 1, 1, readiness.startBlocked)).toBe(false);
    }
  );

  it("keeps reconnecting and paused broker controls in the agent count", () => {
    expect(activeAgentControlCount([
      { agentSeatState: "connected" },
      { agentSeatState: "paused" },
      { agentSeatState: "reconnecting" },
      { agentSeatState: "pending" },
      { agentSeatState: "none" }
    ])).toBe(3);
  });

  it("offers pairing only for an open waiting Custom seat", () => {
    const pairable = {
      matchState: "waiting" as const,
      mode: "wingman" as const,
      agentSeatState: "none" as const,
      agentCount: 1,
      pendingReservationCount: 0,
      combatantCount: 3,
      agentControlCap: 8,
      combatantCap: 8
    };
    expect(canRequestAgentPairing(pairable)).toBe(true);
    expect(canRequestAgentPairing({ ...pairable, matchState: "running" })).toBe(false);
    expect(canRequestAgentPairing({ ...pairable, agentSeatState: "connected" })).toBe(false);
    expect(canRequestAgentPairing({ ...pairable, combatantCount: 8 })).toBe(false);
    expect(canRequestAgentPairing({
      ...pairable,
      agentCount: 0,
      pendingReservationCount: 2,
      combatantCount: 6,
      combatantCap: 8
    })).toBe(false);
  });
});

describe("online player stats", () => {
  it("accepts only a non-negative whole-player count", () => {
    expect(parsePlayersOnline({ playersOnline: 7 })).toBe(7);
    expect(parsePlayersOnline({ playersOnline: -1 })).toBeNull();
    expect(parsePlayersOnline({ playersOnline: 1.5 })).toBeNull();
    expect(parsePlayersOnline({ playersOnline: "7" })).toBeNull();
  });

  it("creates a UUID v4 without requiring a secure context", () => {
    expect(createSiteVisitorId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});

describe("iPhone standalone guidance", () => {
  const iphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

  it("shows only in an iPhone browser, never in a Home Screen launch", () => {
    expect(shouldShowIphoneStandaloneHint(iphone, false, false)).toBe(true);
    expect(shouldShowIphoneStandaloneHint(iphone, true, false)).toBe(false);
    expect(shouldShowIphoneStandaloneHint(iphone, false, true)).toBe(false);
    expect(shouldShowIphoneStandaloneHint("Mozilla/5.0 (Linux; Android 15)", false, false)).toBe(false);
    expect(shouldShowIphoneStandaloneHint("Mozilla/5.0 (Macintosh)", false, false)).toBe(false);
  });
});

describe("arena map parsing", () => {
  it("reuses an unchanged synchronized map and invalidates on seed change", () => {
    const raw = JSON.stringify({
      id: "cache-map",
      width: 600,
      height: 480,
      walls: [{ id: "wall", x: 300, y: 240, width: 80, height: 80 }],
      spawns: [{ id: "spawn", x: 100, y: 100 }]
    });
    const first = parseMapConfig(raw, "round-1");

    expect(parseMapConfig(raw, "round-1")).toBe(first);
    expect(parseMapConfig(raw, "round-2")).not.toBe(first);
  });
});

describe("quick-play reconnect recovery", () => {
  it("starts a fresh quick-play room instead of restoring an active spectator", () => {
    expect(
      shouldStartFreshQuickPlayAfterReconnect("quick", "running", {
        isAlive: false,
        isSpectator: true
      })
    ).toBe(true);
    expect(
      shouldStartFreshQuickPlayAfterReconnect("quick", "finished", {
        isAlive: false,
        isSpectator: true
      })
    ).toBe(true);
  });

  it("preserves active players and explicitly joined spectator sessions", () => {
    expect(
      shouldStartFreshQuickPlayAfterReconnect("quick", "danger", {
        isAlive: true,
        isSpectator: false
      })
    ).toBe(false);
    expect(
      shouldStartFreshQuickPlayAfterReconnect("code", "running", {
        isAlive: false,
        isSpectator: true
      })
    ).toBe(false);
    expect(
      shouldStartFreshQuickPlayAfterReconnect("code", "finished", {
        isAlive: false,
        isSpectator: true
      })
    ).toBe(false);
  });

  it("does not auto-resume saved quick-play sessions on page load", () => {
    expect(shouldAutoReconnectOnPageLoad("quick")).toBe(false);
    expect(shouldAutoReconnectOnPageLoad(undefined)).toBe(false);
    expect(shouldAutoReconnectOnPageLoad("public")).toBe(true);
    expect(shouldAutoReconnectOnPageLoad("private")).toBe(true);
    expect(shouldAutoReconnectOnPageLoad("code")).toBe(true);
  });
});

describe("held-fire behavior", () => {
  it("repeats for native rapid weapons and rapid-fire pickup ammo", () => {
    expect(shouldRepeatHeldFire({ weaponType: "machine_gun", ammo: 0 })).toBe(true);
    expect(shouldRepeatHeldFire({ weaponType: "cannon", ammo: 6 })).toBe(true);
    expect(shouldRepeatHeldFire({ weaponType: "light_cannon", ammo: 6 })).toBe(true);
  });

  it("does not repeat for standard or explosive rounds", () => {
    expect(shouldRepeatHeldFire({ weaponType: "cannon", ammo: 0 })).toBe(false);
    expect(shouldRepeatHeldFire({ weaponType: "explosive", ammo: 6 })).toBe(false);
  });
});

describe("outer boundary classification", () => {
  const map = { width: 2400, height: 1632 };

  it("recognizes split horizontal edge segments as boundary walls", () => {
    expect(
      isOuterBoundaryWall(
        { id: "bottom-segment", x: 432, y: 1584, width: 672, height: 96, depth: 118 },
        map
      )
    ).toBe(true);
  });

  it("keeps perpendicular interior walls that happen to meet an edge visible", () => {
    expect(
      isOuterBoundaryWall(
        { id: "interior-column", x: 816, y: 1488, width: 96, height: 288, depth: 118 },
        map
      )
    ).toBe(false);
  });
});

describe("HUD gameplay scenario", () => {
  it("places the local tank in the open and applies visual QA overrides", () => {
    const snapshot = buildHudScenarioSnapshot(
      "gameplay",
      "rook",
      "Operator",
      1000,
      "shield_pulse",
      8
    );

    expect(snapshot.self).toMatchObject({
      archetypeId: "rook",
      abilityType: "shield_pulse",
      shield: 8,
      x: snapshot.map.width / 2 - 120,
      y: snapshot.map.height / 2 + 160
    });
    expect(snapshot.zone.radius).toBe(820);
  });
});

describe("spectator camera targets", () => {
  it("filters ineligible and concealed players and cycles with wraparound", () => {
    const snapshot = buildHudScenarioSnapshot("spectator", "atlas", "Operator", 1_000);
    const firstOpponent = snapshot.players[1];
    const concealedOpponent = snapshot.players[2];
    const disconnectedOpponent = snapshot.players[3];
    if (!firstOpponent || !concealedOpponent || !disconnectedOpponent) throw new Error("scenario missing players");
    concealedOpponent.smokeEndsAt = 5_000;
    concealedOpponent.smokeX = concealedOpponent.x;
    concealedOpponent.smokeY = concealedOpponent.y;
    disconnectedOpponent.isConnected = false;

    const targets = spectatorTargets(snapshot, 1_000);
    expect(targets.map((player) => player.sessionId)).toEqual([firstOpponent.sessionId]);
    expect(cycleSpectatorTarget(targets, null, 1)).toBe(firstOpponent.sessionId);
    expect(cycleSpectatorTarget(targets, firstOpponent.sessionId, 1)).toBe(firstOpponent.sessionId);

    concealedOpponent.smokeEndsAt = 0;
    const twoTargets = spectatorTargets(snapshot, 1_000);
    expect(cycleSpectatorTarget(twoTargets, firstOpponent.sessionId, -1)).toBe(concealedOpponent.sessionId);
    expect(cycleSpectatorTarget(twoTargets, "eliminated-target", 1)).toBe(firstOpponent.sessionId);
  });

  it("reveals a concealed owned ally only in cooperative modes", () => {
    const snapshot = buildHudScenarioSnapshot("spectator", "atlas", "Operator", 1_000);
    const self = snapshot.self;
    const ownedAgent = snapshot.players[2];
    if (!self || !ownedAgent) throw new Error("scenario missing players");
    ownedAgent.ownerId = self.ownerId;
    ownedAgent.controlKind = "agent";
    ownedAgent.smokeEndsAt = 5_000;
    ownedAgent.smokeX = ownedAgent.x;
    ownedAgent.smokeY = ownedAgent.y;

    snapshot.policy.mode = "agent_cup";
    expect(spectatorTargets(snapshot, 1_000)).toContain(ownedAgent);
    snapshot.policy.mode = "wingman";
    expect(spectatorTargets(snapshot, 1_000)).toContain(ownedAgent);
    snapshot.policy.mode = "open_ffa";
    expect(spectatorTargets(snapshot, 1_000)).not.toContain(ownedAgent);
  });
});

describe("mode-aware standings", () => {
  it("aggregates explicit Wingman pairs", () => {
    const snapshot = buildHudScenarioSnapshot("results8", "atlas", "Operator", 1_000);
    snapshot.policy.mode = "wingman";
    snapshot.players = snapshot.players.slice(0, 4);
    const [humanA, agentA, humanB, agentB] = snapshot.players;
    if (!humanA || !agentA || !humanB || !agentB) throw new Error("scenario missing players");
    humanA.ownerId = humanA.pairId = "pair-a";
    agentA.ownerId = agentA.pairId = "pair-a";
    agentA.controlKind = "agent";
    humanB.ownerId = humanB.pairId = "pair-b";
    agentB.ownerId = agentB.pairId = "pair-b";
    agentB.controlKind = "agent";
    for (const player of [humanA, agentA]) {
      player.teamPlacement = 1;
      player.teamKills = 5;
    }
    for (const player of [humanB, agentB]) {
      player.teamPlacement = 2;
      player.teamKills = 3;
    }
    snapshot.owners = [
      { ...snapshot.owners[0]!, ownerId: "pair-a", humanSessionId: humanA.sessionId, agentSeatId: agentA.sessionId, agentLabel: agentA.name },
      { ...snapshot.owners[1]!, ownerId: "pair-b", humanSessionId: humanB.sessionId, agentSeatId: agentB.sessionId, agentLabel: agentB.name }
    ];
    snapshot.self = humanA;

    expect(matchStandings(snapshot)).toMatchObject([
      { id: "pair-a", placement: 1, kills: 5, isSelf: true, kind: "pair" },
      { id: "pair-b", placement: 2, kills: 3, isSelf: false, kind: "pair" }
    ]);
  });

  it("attributes Agent Cup agents to owners and follows the owned seat first", () => {
    const snapshot = buildHudScenarioSnapshot("spectator", "atlas", "Operator", 1_000);
    snapshot.policy.mode = "agent_cup";
    const self = snapshot.self!;
    const ownedAgent = snapshot.players[2]!;
    ownedAgent.controlKind = "agent";
    ownedAgent.ownerId = self.ownerId;
    snapshot.owners[0]!.agentSeatId = ownedAgent.sessionId;
    snapshot.owners[0]!.agentLabel = ownedAgent.name;

    expect(ownedAgentSessionId(snapshot)).toBe(ownedAgent.sessionId);
    expect(matchStandings(snapshot)[0]).toMatchObject({
      id: ownedAgent.sessionId,
      isSelf: true,
      kind: "player"
    });
    expect(matchStandings(snapshot).some((standing) => standing.id === self.sessionId)).toBe(false);
  });

  it("keeps owned context after the top eight in compact Open FFA standings", () => {
    const snapshot = buildHudScenarioSnapshot("gameplay", "atlas", "Operator", 1_000);
    snapshot.policy.mode = "open_ffa";
    const template = snapshot.players[0]!;
    snapshot.players = Array.from({ length: 10 }, (_, index) => ({
      ...template,
      id: `player-${index}`,
      sessionId: `player-${index}`,
      ownerId: `owner-${index}`,
      pairId: `owner-${index}`,
      name: `Player ${index}`,
      placement: index + 1,
      isSelf: index === 9
    }));
    snapshot.self = snapshot.players[9]!;
    snapshot.owners = snapshot.players.map((player) => ({
      ...snapshot.owners[0]!,
      ownerId: player.ownerId,
      humanSessionId: player.sessionId,
      displayName: player.name
    }));

    const compact = matchStandings(snapshot, 8);
    expect(compact).toHaveLength(9);
    expect(compact.at(-1)?.isSelf).toBe(true);
  });
});

describe("smoke concealment", () => {
  it("uses the synchronized server clock offset instead of the device wall clock", () => {
    const snapshot = buildHudScenarioSnapshot("gameplay", "quill", "Operator", 1_000);
    snapshot.serverTimeOffsetMs = -120_000;

    expect(snapshotServerNow(snapshot, 121_000)).toBe(1_000);
  });

  it("hides a live smoke user only while inside the active cloud", () => {
    const player = buildHudScenarioSnapshot("gameplay", "quill", "Operator", 1_000).self;
    expect(player).not.toBeNull();
    if (!player) return;

    player.smokeActivatedAt = 900;
    player.smokeEndsAt = 5_400;
    player.smokeX = player.x;
    player.smokeY = player.y;
    expect(isPlayerConcealedBySmoke(player, 1_000)).toBe(true);

    player.x += ABILITY_CONFIG.smoke.radius + 1;
    expect(isPlayerConcealedBySmoke(player, 1_000)).toBe(false);
    player.x = player.smokeX;
    player.lastAbilityType = "repair";
    player.lastAbilityAt = 1_100;
    expect(isPlayerConcealedBySmoke(player, 1_200)).toBe(true);
    expect(isPlayerConcealedBySmoke(player, 5_400)).toBe(false);
  });
});
