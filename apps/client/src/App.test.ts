import { describe, expect, it } from "vitest";
import { agentOpeningTacticSummary, agentPairingCreatePayload } from "./App";

const openingTactic = {
  version: 1,
  intentSeq: 1,
  basedOnObservationSeq: null,
  validForMs: 45_000,
  objective: { type: "zone_center" as const },
  fire: "none" as const,
  useAbility: false as const,
  fallback: "hold" as const
} as const;

describe("agent pairing rollback", () => {
  it("keeps disabled rooms on Macro V1", () => {
    expect(agentPairingCreatePayload("Owned Agent", false, openingTactic)).toEqual({
      agentLabel: "Owned Agent"
    });
  });

  it("requests Tactical Reflex only when room policy enables it", () => {
    expect(agentPairingCreatePayload("Owned Agent", true, openingTactic)).toEqual({
      agentLabel: "Owned Agent",
      controlMode: "tactical_reflex_v1",
      openingTactic
    });
  });

  it("discloses server-authoritative engagement safety in the opening summary", () => {
    expect(agentOpeningTacticSummary({
      ...openingTactic,
      objective: { type: "engage_nearest" },
      fire: "hold"
    })).toContain("Spacing, obstacle escape, firing lanes + zone safety");
  });
});
