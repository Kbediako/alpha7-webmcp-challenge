import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  TANK_ARCHETYPES,
  type JoinMessagePayload,
  type TankArchetypeId
} from "@alpha7/shared";

const MAX_DISPLAY_NAME_LENGTH = 18;
const MAX_CLIENT_VERSION_LENGTH = 32;

export interface HumanPrincipal {
  principalKind: "human";
  ownerId: string;
  sourceKey: string;
  preferences: JoinMessagePayload;
}

export interface HumanAdmission {
  options: JoinMessagePayload;
  principal: HumanPrincipal;
}

export class HumanAdmissionError extends Error {
  constructor() {
    super("invalid_join_options");
    this.name = "HumanAdmissionError";
  }
}

interface TrustedRequestSourceInput {
  isRailway: boolean;
  headers: { get(name: string): string | null | undefined };
  remoteAddress?: string;
}

export const trustedRequestSourceKey = ({
  isRailway,
  headers,
  remoteAddress
}: TrustedRequestSourceInput): string => {
  const railwayAddress = isRailway ? headers.get("x-real-ip")?.trim() : undefined;
  const trustedRailwayAddress = railwayAddress && isIP(railwayAddress) ? railwayAddress : undefined;
  const candidate = trustedRailwayAddress ?? remoteAddress?.trim();
  const address = candidate && isIP(candidate) ? candidate.toLowerCase() : "unknown";
  return `${trustedRailwayAddress ? "railway" : "direct"}:${address}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTankArchetypeId = (value: unknown): value is TankArchetypeId =>
  typeof value === "string" && TANK_ARCHETYPES.includes(value as TankArchetypeId);

export const sanitizeDisplayName = (value: unknown, fallback = "Player"): string => {
  if (typeof value !== "string") return fallback;

  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_DISPLAY_NAME_LENGTH);

  return sanitized || fallback;
};

export const createHumanAdmission = (value: unknown, sourceKey = "unknown"): HumanAdmission => {
  if (!isRecord(value) || !isTankArchetypeId(value.archetypeId)) {
    throw new HumanAdmissionError();
  }
  if (value.clientVersion !== undefined && typeof value.clientVersion !== "string") {
    throw new HumanAdmissionError();
  }

  const options: JoinMessagePayload = {
    playerName: sanitizeDisplayName(value.playerName),
    archetypeId: value.archetypeId,
    clientVersion: value.clientVersion?.slice(0, MAX_CLIENT_VERSION_LENGTH)
  };

  const ownerId = randomUUID();
  return {
    options,
    principal: {
      principalKind: "human",
      ownerId,
      sourceKey: sourceKey === "direct:unknown" ? `direct-owner:${ownerId}` : sourceKey,
      preferences: options
    }
  };
};

export const isHumanPrincipal = (value: unknown): value is HumanPrincipal =>
  isRecord(value) &&
  value.principalKind === "human" &&
  typeof value.ownerId === "string" &&
  value.ownerId.length > 0 &&
  typeof value.sourceKey === "string" &&
  value.sourceKey.length > 0 &&
  isRecord(value.preferences) &&
  typeof value.preferences.playerName === "string" &&
  isTankArchetypeId(value.preferences.archetypeId);
