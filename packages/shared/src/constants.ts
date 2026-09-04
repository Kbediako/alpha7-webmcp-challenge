export const BATTLE_ROYALE_ROOM = "battle_royale" as const;

export const MATCH_STATES = [
  "waiting",
  "countdown",
  "running",
  "danger",
  "final_zone",
  "finished"
] as const;

export type MatchState = (typeof MATCH_STATES)[number];

export const WEAPON_TYPES = ["cannon", "light_cannon", "machine_gun", "explosive"] as const;
export type WeaponType = (typeof WEAPON_TYPES)[number];

export interface WeaponConfig {
  id: WeaponType;
  name: string;
  category: "standard" | "rapid" | "explosive";
  damage: number;
  fireCooldownMs: number;
  projectileSpeed: number;
  projectileLifetimeMs: number;
  ammoCost: number;
  spreadRadians: number;
  splashRadius: number;
  enabledByDefault: boolean;
}

export const WEAPON_CONFIG = {
  cannon: {
    id: "cannon",
    name: "Cannon",
    category: "standard",
    damage: 32,
    fireCooldownMs: 700,
    projectileSpeed: 620,
    projectileLifetimeMs: 1500,
    ammoCost: 1,
    spreadRadians: 0,
    splashRadius: 0,
    enabledByDefault: true
  },
  light_cannon: {
    id: "light_cannon",
    name: "Light Cannon",
    category: "standard",
    damage: 22,
    fireCooldownMs: 420,
    projectileSpeed: 760,
    projectileLifetimeMs: 1200,
    ammoCost: 1,
    spreadRadians: 0.02,
    splashRadius: 0,
    enabledByDefault: true
  },
  machine_gun: {
    id: "machine_gun",
    name: "Machine Gun",
    category: "rapid",
    damage: 8,
    fireCooldownMs: 90,
    projectileSpeed: 840,
    projectileLifetimeMs: 900,
    ammoCost: 1,
    spreadRadians: 0.08,
    splashRadius: 0,
    enabledByDefault: true
  },
  explosive: {
    id: "explosive",
    name: "Explosive",
    category: "explosive",
    damage: 42,
    fireCooldownMs: 1100,
    projectileSpeed: 460,
    projectileLifetimeMs: 1700,
    ammoCost: 2,
    spreadRadians: 0.04,
    splashRadius: 120,
    enabledByDefault: false
  }
} as const satisfies Record<WeaponType, WeaponConfig>;

export const DEFAULT_WEAPON_TYPE: WeaponType = "cannon";
export const RAPID_FIRE_COOLDOWN_MULTIPLIER = 0.55;

export const ABILITY_TYPES = ["smoke", "repair", "shield_pulse", "speed_burst", "barrage"] as const;
export type AbilityType = (typeof ABILITY_TYPES)[number];

export interface AbilityConfig {
  id: AbilityType;
  name: string;
  description: string;
  cooldownMs: number;
  chargeCost: number;
  durationMs: number;
  radius: number;
  enabledByDefault: boolean;
}

export const ABILITY_CONFIG = {
  smoke: {
    id: "smoke",
    name: "Smoke Screen",
    description: "Deploy 4.5 seconds of wide visual cover; Quill is concealed and takes 40% less weapon damage while inside.",
    cooldownMs: 12000,
    chargeCost: 50,
    durationMs: 4500,
    radius: 450,
    enabledByDefault: true
  },
  repair: {
    id: "repair",
    name: "Field Repair",
    description: "Restore 28 health and 12 armor without exceeding the chassis maximum.",
    cooldownMs: 15000,
    chargeCost: 65,
    durationMs: 0,
    radius: 0,
    enabledByDefault: true
  },
  shield_pulse: {
    id: "shield_pulse",
    name: "Shield Pulse",
    description: "Gain 40 temporary shield for 3.5 seconds.",
    cooldownMs: 18000,
    chargeCost: 70,
    durationMs: 3500,
    radius: 160,
    enabledByDefault: true
  },
  speed_burst: {
    id: "speed_burst",
    name: "Speed Burst",
    description: "Increase top speed by 55% for 3 seconds.",
    cooldownMs: 10000,
    chargeCost: 45,
    durationMs: 3000,
    radius: 0,
    enabledByDefault: true
  },
  barrage: {
    id: "barrage",
    name: "Explosive Barrage",
    description: "Load three explosive rounds, then return to the chassis weapon when spent.",
    cooldownMs: 24000,
    chargeCost: 100,
    durationMs: 0,
    radius: 0,
    enabledByDefault: false
  }
} as const satisfies Record<AbilityType, AbilityConfig>;

export const DEFAULT_ABILITY_TYPE: AbilityType = "smoke";

export const PICKUP_TYPES = [
  "health_repair",
  "shield_armor",
  "ammo_rapid_fire",
  "speed_boost",
  "ability_charge",
  "smoke",
  "barrage_explosive"
] as const;

export type PickupType = (typeof PICKUP_TYPES)[number];

export interface PickupConfig {
  id: PickupType;
  name: string;
  effect: "repair" | "armor" | "ammo" | "speed" | "ability" | "smoke" | "explosive";
  value: number;
  durationMs: number;
  respawnMs: number;
  stackable: boolean;
}

export const PICKUP_CONFIG = {
  health_repair: {
    id: "health_repair",
    name: "Health Repair",
    effect: "repair",
    value: 35,
    durationMs: 0,
    respawnMs: 12000,
    stackable: false
  },
  shield_armor: {
    id: "shield_armor",
    name: "Shield Armor",
    effect: "armor",
    value: 30,
    durationMs: 7000,
    respawnMs: 14000,
    stackable: false
  },
  ammo_rapid_fire: {
    id: "ammo_rapid_fire",
    name: "Ammo Rapid Fire",
    effect: "ammo",
    value: 30,
    durationMs: 5000,
    respawnMs: 10000,
    stackable: true
  },
  speed_boost: {
    id: "speed_boost",
    name: "Speed Boost",
    effect: "speed",
    value: 1.35,
    durationMs: 5000,
    respawnMs: 12000,
    stackable: false
  },
  ability_charge: {
    id: "ability_charge",
    name: "Ability Charge",
    effect: "ability",
    value: 40,
    durationMs: 0,
    respawnMs: 15000,
    stackable: true
  },
  smoke: {
    id: "smoke",
    name: "Smoke",
    effect: "smoke",
    value: 1,
    durationMs: 4500,
    respawnMs: 16000,
    stackable: false
  },
  barrage_explosive: {
    id: "barrage_explosive",
    name: "Explosive Rounds",
    effect: "explosive",
    value: 1,
    durationMs: 0,
    respawnMs: 20000,
    stackable: true
  }
} as const satisfies Record<PickupType, PickupConfig>;

export const TANK_ARCHETYPES = ["nova", "atlas", "quill", "rook"] as const;
export type TankArchetypeId = (typeof TANK_ARCHETYPES)[number];

export interface TankStatBlock {
  firepower: number;
  armor: number;
  mobility: number;
  support: number;
}

export const TANK_COLLISION_RADIUS = 28;

export interface TankHandlingConfig {
  acceleration: number;
  brakeDeceleration: number;
  turnRate: number;
  reverseSpeedMultiplier: number;
  turnSlowdown: number;
}

export interface TankArchetypeDefinition {
  id: TankArchetypeId;
  name: string;
  role: "Assault" | "Balanced" | "Skirmisher" | "Support";
  description: string;
  stats: TankStatBlock;
  maxHealth: number;
  maxArmor: number;
  speed: number;
  handling: TankHandlingConfig;
  primaryWeapon: WeaponType;
  ability: AbilityType;
}

export const TANK_ARCHETYPE_CONFIG = {
  nova: {
    id: "nova",
    name: "Nova",
    role: "Assault",
    description: "Frontline brawler with high burst damage.",
    stats: { firepower: 5, armor: 3, mobility: 3, support: 1 },
    maxHealth: 110,
    maxArmor: 35,
    speed: 270,
    handling: {
      acceleration: 980,
      brakeDeceleration: 2800,
      turnRate: 5.4,
      reverseSpeedMultiplier: 0.7,
      turnSlowdown: 0.22
    },
    primaryWeapon: "cannon",
    ability: "speed_burst"
  },
  atlas: {
    id: "atlas",
    name: "Atlas",
    role: "Balanced",
    description: "Reliable baseline with even armor, speed, and firepower.",
    stats: { firepower: 3, armor: 4, mobility: 3, support: 2 },
    maxHealth: 120,
    maxArmor: 45,
    speed: 245,
    handling: {
      acceleration: 820,
      brakeDeceleration: 2600,
      turnRate: 4.7,
      reverseSpeedMultiplier: 0.7,
      turnSlowdown: 0.28
    },
    primaryWeapon: "light_cannon",
    ability: "shield_pulse"
  },
  quill: {
    id: "quill",
    name: "Quill",
    role: "Skirmisher",
    description: "Fast flanker built for repositioning and weak-point strikes.",
    stats: { firepower: 3, armor: 2, mobility: 5, support: 1 },
    maxHealth: 90,
    maxArmor: 20,
    speed: 310,
    handling: {
      acceleration: 1150,
      brakeDeceleration: 3200,
      turnRate: 6.2,
      reverseSpeedMultiplier: 0.7,
      turnSlowdown: 0.18
    },
    primaryWeapon: "machine_gun",
    ability: "smoke"
  },
  rook: {
    id: "rook",
    name: "Rook",
    role: "Support",
    description: "Durable utility chassis with repairs and battlefield control.",
    stats: { firepower: 2, armor: 5, mobility: 2, support: 5 },
    maxHealth: 140,
    maxArmor: 60,
    speed: 215,
    handling: {
      acceleration: 700,
      brakeDeceleration: 2300,
      turnRate: 3.9,
      reverseSpeedMultiplier: 0.7,
      turnSlowdown: 0.34
    },
    primaryWeapon: "cannon",
    ability: "repair"
  }
} as const satisfies Record<TankArchetypeId, TankArchetypeDefinition>;

export type TankArchetypeConfig = (typeof TANK_ARCHETYPE_CONFIG)[TankArchetypeId];
export const DEFAULT_TANK_ARCHETYPE: TankArchetypeId = "atlas";

export interface HealthResponse {
  ok: true;
  service: "alpha7-server";
  room: typeof BATTLE_ROYALE_ROOM;
  version: string;
}
