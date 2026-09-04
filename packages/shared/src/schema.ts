import { ArraySchema, MapSchema, Schema, deprecated, type } from "@colyseus/schema";
import {
  BATTLE_ROYALE_ROOM,
  DEFAULT_TANK_ARCHETYPE,
  DEFAULT_WEAPON_TYPE,
  TANK_ARCHETYPE_CONFIG
} from "./constants.js";
import type { AbilityType, MatchState, PickupType, TankArchetypeId, WeaponType } from "./constants.js";
import {
  AGENT_ACTION_VERSION,
  AGENT_EXECUTOR_VERSION,
  AGENT_OBSERVATION_VERSION,
  type AgentSeatState,
  type AgentTrack,
  type ControlKind,
  type OwnerPrincipalKind,
  type RoomMode
} from "./agent.js";

const DEFAULT_TANK_CONFIG = TANK_ARCHETYPE_CONFIG[DEFAULT_TANK_ARCHETYPE];

export class MatchCoreSchema extends Schema {
  @type("string") roomName = BATTLE_ROYALE_ROOM;
  @type("string") matchId = "";
  @type("number") tick = 0;
  @type("number") round = 1;
  @type("number") alivePlayers = 0;
  @type("number") stateStartedAt = 0;
  @type("number") countdownEndsAt = 0;
  @type("number") matchEndsAt = 0;
}

export class ZoneCoreSchema extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") radius = 0;
  @type("number") targetX = 0;
  @type("number") targetY = 0;
  @type("number") targetRadius = 0;
  @type("number") damagePerSecond = 0;
}

export class ZonePhaseSchema extends Schema {
  @type("number") index = 0;
  @type("string") matchState: MatchState = "waiting";
  @type("number") startsAt = 0;
  @type("number") warningAt = 0;
  @type("number") closesAt = 0;
}

export class PlayerSchema extends Schema {
  @type("string") id = "";
  @type("string") sessionId = "";
  @type("string") name = "";
  @type("string") archetypeId: TankArchetypeId = DEFAULT_TANK_ARCHETYPE;
  @type("string") weaponType: WeaponType = DEFAULT_TANK_CONFIG.primaryWeapon;
  @type("string") abilityType: AbilityType = DEFAULT_TANK_CONFIG.ability;
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") rotation = 0;
  @type("number") turretRotation = 0;
  @type("number") velocityX = 0;
  @type("number") velocityY = 0;
  @type("number") speedMultiplier = 1;
  @type("number") health: number = DEFAULT_TANK_CONFIG.maxHealth;
  @type("number") maxHealth: number = DEFAULT_TANK_CONFIG.maxHealth;
  @type("number") armor: number = DEFAULT_TANK_CONFIG.maxArmor;
  @type("number") maxArmor: number = DEFAULT_TANK_CONFIG.maxArmor;
  @type("number") shield = 0;
  @type("number") ammo = 0;
  @type("number") abilityCharge = 0;
  @type("number") fireCooldownMs = 0;
  @type("number") abilityCooldownMs = 0;
  @type("string") lastAbilityType: AbilityType = DEFAULT_TANK_CONFIG.ability;
  @type("number") lastAbilityAt = 0;
  @type("number") lastAbilityEndsAt = 0;
  @type("number") lastAbilityX = 0;
  @type("number") lastAbilityY = 0;
  @type("number") smokeActivatedAt = 0;
  @type("number") smokeEndsAt = 0;
  @type("number") smokeX = 0;
  @type("number") smokeY = 0;
  @type("number") score = 0;
  @type("number") kills = 0;
  @type("number") deaths = 0;
  @type("number") damageDealt = 0;
  @type("number") damageTaken = 0;
  @type("number") placement = 0;
  @type("number") survivalTimeMs = 0;
  @type("number") joinedAt = 0;
  @type("number") respawnAt = 0;
  @type("boolean") isConnected = true;
  @type("boolean") isReady = false;
  @type("boolean") isAlive = true;
  @type("boolean") isSpectator = false;
  @type("boolean") isHost = false;
  @type("string") ownerId = "";
  @type("string") pairId = "";
  @type("string") controlKind: ControlKind = "human";
  @type("number") teamPlacement = 0;
  @type("number") teamKills = 0;
}

export class RoomPolicySchema extends Schema {
  @type("string") mode: RoomMode = "classic";
  @type("string") track: AgentTrack = "none";
  @type("number") ownerCap = 8;
  @type("number") humanWsCap = 8;
  @type("number") agentControlCap = 0;
  @type("number") combatantCap = 8;
  @type("number") observationVersion = AGENT_OBSERVATION_VERSION;
  @type("number") actionVersion = AGENT_ACTION_VERSION;
  @type("number") executorVersion = AGENT_EXECUTOR_VERSION;
  @type("boolean") tacticalReflexEnabled = false;
}

export class OwnerSchema extends Schema {
  @type("string") ownerId = "";
  @type("string") humanSessionId = "";
  @type("string") displayName = "";
  @type("string") principalKind: OwnerPrincipalKind = "combatant";
  @type("string") agentSeatId = "";
  @type("string") agentLabel = "";
  @type("string") agentSeatState: AgentSeatState = "none";
  @type("boolean") isConnected = true;
  @type("boolean") isReady = false;
  @type("boolean") isHost = false;
  @type("number") agentPairingExpiresAtMs = 0;
}

export class ProjectileSchema extends Schema {
  @type("string") id = "";
  @type("string") ownerId = "";
  @type("string") weaponType: WeaponType = DEFAULT_WEAPON_TYPE;
  @type("number") fireSequence = 0;
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") velocityX = 0;
  @type("number") velocityY = 0;
  @type("number") rotation = 0;
  @type("number") damage = 0;
  @type("number") radius = 4;
  @type("number") splashRadius = 0;
  @type("number") spawnedAt = 0;
  @type("number") expiresAt = 0;
}

export class PickupSchema extends Schema {
  @type("string") id = "";
  @type("string") pickupType: PickupType = "health_repair";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") radius = 24;
  @type("number") value = 0;
  @type("number") durationMs = 0;
  @type("number") spawnedAt = 0;
  @type("number") respawnsAt = 0;
  @type("boolean") isActive = true;
}

export class Alpha7StateSchema extends Schema {
  @type("string") matchState: MatchState = "waiting";
  @type("string") roomCode = "";
  @type("string") seed = "";
  @type("number") serverTime = 0;
  @type("string") arenaConfigJson = "";
  @deprecated()
  @type("string") mapConfigJson = "";
  @type(MatchCoreSchema) match = new MatchCoreSchema();
  @type(ZoneCoreSchema) zone = new ZoneCoreSchema();
  @type(ZonePhaseSchema) zonePhase = new ZonePhaseSchema();
  @type({ map: PlayerSchema }) players = new MapSchema<PlayerSchema>();
  @type([ProjectileSchema]) projectiles = new ArraySchema<ProjectileSchema>();
  @type([PickupSchema]) pickups = new ArraySchema<PickupSchema>();
  @type(RoomPolicySchema) policy = new RoomPolicySchema();
  @type({ map: OwnerSchema }) owners = new MapSchema<OwnerSchema>();

  setMatchState(matchState: MatchState): void {
    this.matchState = matchState;
    this.zonePhase.matchState = matchState;
  }
}
