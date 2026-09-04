import { describe, expect, it } from "vitest";
import {
  HumanAdmissionError,
  createHumanAdmission,
  isHumanPrincipal,
  trustedRequestSourceKey
} from "./humanAdmission.js";

describe("human admission", () => {
  it("allowlists preferences and creates a fresh server-owned principal", () => {
    const forged = {
      playerName: " <Rook>\nPilot ",
      archetypeId: "rook",
      clientVersion: "v".repeat(40),
      ownerId: "attacker-owner",
      role: "admin",
      sessionId: "public-session",
      resumeSessionId: "victim-session",
      resumeRoomCode: "ROOM123",
      scopes: ["agent:act"]
    };

    const first = createHumanAdmission(forged, "trusted-source");
    const replay = createHumanAdmission(forged, "trusted-source");

    expect(first.options).toEqual({
      playerName: "Rook Pilot",
      archetypeId: "rook",
      clientVersion: "v".repeat(32)
    });
    expect(Object.keys(first.options)).toEqual(["playerName", "archetypeId", "clientVersion"]);
    expect(first.principal).toEqual({
      principalKind: "human",
      ownerId: expect.any(String),
      sourceKey: "trusted-source",
      preferences: first.options
    });
    expect(first.principal.ownerId).not.toBe("attacker-owner");
    expect(first.principal.ownerId).not.toBe(replay.principal.ownerId);
    expect(isHumanPrincipal(first.principal)).toBe(true);
  });

  it("rejects malformed archetypes and client versions", () => {
    expect(() => createHumanAdmission(null)).toThrow(HumanAdmissionError);
    expect(() => createHumanAdmission({ archetypeId: "bogus" })).toThrow(HumanAdmissionError);
    expect(() => createHumanAdmission({ archetypeId: "atlas", clientVersion: 7 })).toThrow(
      HumanAdmissionError
    );
  });

  it("ignores forged forwarding headers on direct requests", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.90",
      "x-real-ip": "198.51.100.40"
    });

    expect(
      trustedRequestSourceKey({
        isRailway: false,
        headers,
        remoteAddress: "127.0.0.1"
      })
    ).toBe("direct:127.0.0.1");
    expect(
      trustedRequestSourceKey({
        isRailway: true,
        headers,
        remoteAddress: "10.0.0.2"
      })
    ).toBe("railway:198.51.100.40");
  });

  it("isolates direct owners when the matchmaking transport cannot expose a peer address", () => {
    const first = createHumanAdmission({ archetypeId: "rook" }, "direct:unknown").principal;
    const second = createHumanAdmission({ archetypeId: "rook" }, "direct:unknown").principal;
    expect(first.sourceKey).toBe(`direct-owner:${first.ownerId}`);
    expect(second.sourceKey).toBe(`direct-owner:${second.ownerId}`);
    expect(first.sourceKey).not.toBe(second.sourceKey);
  });
});
