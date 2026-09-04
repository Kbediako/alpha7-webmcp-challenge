import type { AbilityType, MatchState, PickupType, TankArchetypeId, WeaponType } from "./constants.js";
import type {
  AgentControlAction,
  AgentControlMode,
  AgentErrorCode,
  AgentSeatState,
  AgentTacticalIntentV1
} from "./agent.js";

export const CLIENT_MESSAGE_TYPES = {
  JOIN: "join",
  READY: "ready",
  START: "start",
  INPUT: "input",
  FIRE: "fire",
  ABILITY: "ability",
  REMATCH: "rematch",
  AGENT_PAIRING_CREATE: "agent_pairing_create",
  AGENT_PAIRING_CANCEL: "agent_pairing_cancel",
  AGENT_CONTROL: "agent_control"
} as const;

export type ClientMessageType = (typeof CLIENT_MESSAGE_TYPES)[keyof typeof CLIENT_MESSAGE_TYPES];

export interface JoinMessagePayload {
  playerName: string;
  archetypeId: TankArchetypeId;
  clientVersion?: string;
}

export interface ReadyMessagePayload {
  ready: boolean;
}

export interface StartMessagePayload {
  start?: true;
}

export interface InputMessagePayload {
  sequence: number;
  tick: number;
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  fire: boolean;
  ability: boolean;
}

export interface FireMessagePayload {
  sequence: number;
  weaponType?: WeaponType;
  aimX: number;
  aimY: number;
  chargeMs?: number;
}

export interface AbilityMessagePayload {
  sequence: number;
  abilityType: AbilityType;
  targetX?: number;
  targetY?: number;
}

export interface RematchMessagePayload {
  ready: boolean;
  previousMatchId?: string;
}

export interface AgentPairingCreatePayload {
  agentLabel?: string;
  controlMode?: AgentControlMode;
  openingTactic?: AgentTacticalIntentV1;
}

export interface AgentPairingCancelPayload {
  requestId?: string;
}

export interface AgentControlPayload {
  action: AgentControlAction;
}

export interface ClientToServerPayloadMap {
  join: JoinMessagePayload;
  ready: ReadyMessagePayload;
  start: StartMessagePayload;
  input: InputMessagePayload;
  fire: FireMessagePayload;
  ability: AbilityMessagePayload;
  rematch: RematchMessagePayload;
  agent_pairing_create: AgentPairingCreatePayload;
  agent_pairing_cancel: AgentPairingCancelPayload;
  agent_control: AgentControlPayload;
}

export type ClientToServerMessage<Type extends ClientMessageType = ClientMessageType> =
  ClientToServerPayloadMap[Type];

export const SERVER_MESSAGE_TYPES = {
  SYSTEM: "system",
  ERROR: "error",
  PROJECTILE_IMPACT: "projectile_impact",
  AGENT_PAIRING_RESULT: "agent_pairing_result",
  AGENT_CONTROL_RESULT: "agent_control_result"
} as const;

export type ServerMessageType = (typeof SERVER_MESSAGE_TYPES)[keyof typeof SERVER_MESSAGE_TYPES];

export type SystemMessageCode =
  | "player_joined"
  | "player_ready"
  | "match_state"
  | "pickup_collected"
  | "rematch";

export interface SystemMessagePayload {
  code?: SystemMessageCode;
  message: string;
  matchState?: MatchState;
  roomCode?: string;
  seed?: string;
  playerSessionId?: string;
  playerName?: string;
  pickupType?: PickupType;
  pickupName?: string;
  pickupValue?: number;
  pickupDurationMs?: number;
  at?: number;
}

export type ErrorMessageCode =
  | "invalid_payload"
  | "invalid_state"
  | "rate_limited"
  | "not_joined"
  | "server_error";

export interface ErrorMessagePayload {
  code: ErrorMessageCode;
  message: string;
  retryable: boolean;
  field?: string;
}

export type ProjectileImpactReason = "tank" | "wall" | "range";

export interface ProjectileImpactMessagePayload {
  projectileId: string;
  ownerId: string;
  fireSequence: number;
  weaponType: WeaponType;
  reason: ProjectileImpactReason;
  x: number;
  y: number;
  rotation: number;
  radius: number;
  splashRadius: number;
  targetSessionId?: string;
  damage?: number;
  destroyed?: boolean;
  shieldHit?: boolean;
  at: number;
}

export interface AgentPairingResultPayload {
  requestId: string;
  action: "create" | "cancel";
  accepted: boolean;
  seatState: AgentSeatState;
  pairingCode?: string;
  expiresAtMs?: number;
  errorCode?: AgentErrorCode;
}

export interface AgentControlResultPayload {
  action: AgentControlAction;
  accepted: boolean;
  seatState: AgentSeatState;
  errorCode?: AgentErrorCode;
}

export interface ServerToClientPayloadMap {
  system: SystemMessagePayload;
  error: ErrorMessagePayload;
  projectile_impact: ProjectileImpactMessagePayload;
  agent_pairing_result: AgentPairingResultPayload;
  agent_control_result: AgentControlResultPayload;
}

export type ServerToClientMessage<Type extends ServerMessageType = ServerMessageType> =
  ServerToClientPayloadMap[Type];
