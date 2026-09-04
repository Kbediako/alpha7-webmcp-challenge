import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  ABILITY_CONFIG,
  PICKUP_CONFIG,
  TANK_COLLISION_RADIUS,
  TANK_ARCHETYPE_CONFIG,
  WEAPON_CONFIG,
  integrateTankMovement,
  type ProjectileImpactMessagePayload,
  type TankArchetypeId
} from "@alpha7/shared";
import {
  isOwnedAlly,
  isPlayerConcealedBySmoke,
  isOuterBoundaryWall,
  snapshotServerNow,
  type ArenaMapConfig,
  type ArenaWall,
  type ClientPickup,
  type ClientPlayer,
  type ClientSnapshot,
  type InputFrame
} from "./clientState";
import {
  controlMoveToWorldMove,
  frameRateIndependentLerp,
  lerpAngle,
  movementIsSettling,
  normalizeAngle,
  resolvePredictedMovement,
  shouldHoldActivePosition,
  stepCameraOrbit,
  shouldHoldIdlePose,
  shouldKeepResolvedProjectile
} from "./inputMath";

export interface LocalPose {
  x: number;
  y: number;
  rotation: number;
  turretRotation: number;
  velocityX: number;
  velocityY: number;
}

interface ArenaRendererProps {
  snapshot: ClientSnapshot;
  authoritativeSnapshot: boolean;
  cameraFocusPlayerId?: string | null;
  inputRef: { current: InputFrame };
  aimSyncRef: { current: ((screenX: number, screenY: number) => void) | null };
  fireSignal: number;
  fireSequenceRef: { current: number };
  impactSignal: number;
  impactQueueRef: { current: ProjectileImpactMessagePayload[] };
  abilitySignal: number;
  onCameraOrbitAngle?: (angle: number) => void;
  onLocalPose: (pose: LocalPose) => void;
}

interface ArenaDebugState {
  map: {
    id: string;
    source: ArenaMapConfig["source"];
    width: number;
    height: number;
    wallCount: number;
    visibleWallCount: number;
    hiddenBoundaryWallCount: number;
    junctionCapCount: number;
    materialSource: typeof MAP_MATERIAL_SOURCE;
    textureContract: typeof MAP_TEXTURE_CONTRACT;
    textures: {
      floor: string;
      wall: string;
      floorPreview: FloorPreviewTextureId | null;
      wallPreview: WallPreviewTextureId | null;
      previewChannels: {
        floor: PreviewMaterialTextures | null;
        wall: PreviewMaterialTextures | null;
      };
      alternates: string[];
    };
  };
  renderer: {
    width: number;
    height: number;
    pixelRatio: number;
    mapKey: string;
  };
  weather: {
    source: typeof RAIN_LAYER_SOURCE;
    configured: boolean;
    kind: ArenaWeatherKind | "none";
    intensity: number;
    seed: string | null;
    active: boolean;
    streakCount: number;
    mobileReduced: boolean;
    reducedMotion: boolean;
    updateRateCap: number | null;
  };
  camera: {
    x: number;
    y: number;
    z: number;
    zoom: number;
    orbitDegrees: number;
    pendingOrbitDegrees: number;
    orbitDragging: boolean;
    focusPlayerId: string | null;
    focusNdc: { x: number; y: number };
    controls: string[];
  };
  localPose: LocalPose;
  visiblePlayers: Array<{
    id: string;
    x: number;
    y: number;
    rotation: number;
    turretRotation: number;
    health: number;
    armor: number;
    shield: number;
    isSelf: boolean;
    isAlive: boolean;
    isConnected: boolean;
    isSpectator: boolean;
    archetypeId: TankArchetypeId;
    concealedBySmoke: boolean;
    renderVisible: boolean;
  }>;
  pickups: {
    total: number;
    active: number;
    visible: number;
  };
  projectiles: {
    server: number;
    selfServer: number;
    predicted: number;
    localParticles: number;
    renderCap: number;
    resolved: number;
    lastImpact: ProjectileImpactMessagePayload | null;
  };
  abilities: {
    activeVisuals: Array<{
      type: ClientPlayer["abilityType"];
      remainingMs: number;
    }>;
    smoke: {
      prewarmStatus: Runtime["smokePrewarmStatus"];
      textureSize: number;
      spriteCap: { mobile: number; desktop: number };
      puffOpacity: { min: number; max: number };
      activeClouds: number;
      activeSprites: number;
    };
  };
  lighting: {
    source: typeof MAP_LIGHTING_SOURCE;
    mode: LightingMode;
    forcedMode: LightingMode | "auto";
    dynamicShadows: boolean;
    shadowMapSize: number;
    casterPolicy: "tanks-only";
  };
  visualChecks: {
    boundaryBarrier: {
      panels: Array<{
        side: BoundarySide;
        x: number;
        y: number;
        opacity: number;
        visible: boolean;
      }>;
    };
    zoneDarkness: {
      visible: boolean;
      opacity: number;
      feather: number;
      tint: string;
    };
    contactShadows: {
      tanks: boolean;
      walls: boolean;
      tankOpacity: number;
      wallBaseOpacity: number;
      wallCastOpacity: number;
      wallCastOffset: { x: number; y: number };
    };
  };
}

declare global {
  interface Window {
    __alpha7ArenaAdvance?: (ms: number) => void;
    __alpha7ArenaState?: () => ArenaDebugState;
    __alpha7ArenaSetLightingMode?: (mode: LightingMode | "auto") => void;
    __alpha7ArenaOrbitCamera?: (degrees: number) => void;
    __alpha7ArenaSetCameraOrbit?: (degrees: number) => void;
    __alpha7ArenaPreviewAbility?: (abilityType: ClientPlayer["abilityType"]) => void;
    __alpha7ArenaPreviewImpact?: (
      weaponType: ClientPlayer["weaponType"],
      reason?: ProjectileImpactMessagePayload["reason"]
    ) => void;
  }
}

interface TankParts {
  group: THREE.Group;
  turret: THREE.Group;
  barrel: THREE.Mesh;
  muzzle: THREE.Mesh;
  barrelBaseOffset: number;
  shieldGlow: THREE.Mesh;
  shieldRing: THREE.Mesh;
  target: LocalPose;
  current: LocalPose;
  isSelf: boolean;
  archetypeId: TankArchetypeId;
  shield: number;
  hitAt: number;
  hitRotation: number;
  hitStrength: number;
}

interface MuzzleSocket {
  position: THREE.Vector3;
  angle: number;
}

interface Particle {
  mesh: THREE.Object3D;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  kind: "shot" | "pulse" | "burst";
  radius: number;
  baseScale: number;
  predictedShot?: boolean;
  pendingContact?: boolean;
  fireSequence?: number;
  abilityType?: ClientPlayer["abilityType"];
}

interface PickupVisual {
  group: THREE.Group;
  core: THREE.Mesh;
  bobOffset: number;
  spinSpeed: number;
  pickupType: ClientPickup["pickupType"];
}

type ArenaWeatherKind = "clear" | "rain";

interface ArenaWeatherConfig {
  kind: ArenaWeatherKind;
  intensity: number;
  seed: string;
}

interface RainLayer {
  lines: THREE.LineSegments;
  material: THREE.LineBasicMaterial;
  positionAttribute: THREE.BufferAttribute;
  positions: Float32Array;
  baseX: Float32Array;
  baseZ: Float32Array;
  phase: Float32Array;
  speed: Float32Array;
  length: Float32Array;
  streakDx: Float32Array;
  streakDz: Float32Array;
  driftX: Float32Array;
  driftZ: Float32Array;
  topY: number;
  wrapHeight: number;
  segmentCount: number;
  mobileReduced: boolean;
  reducedMotion: boolean;
  weather: ArenaWeatherConfig;
  appearanceKey: string;
  lastUpdateTime: number;
}

interface Runtime {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  keyLight: THREE.DirectionalLight;
  keyLightTarget: THREE.Object3D;
  fillLight: THREE.HemisphereLight;
  raycaster: THREE.Raycaster;
  groundPlane: THREE.Plane;
  wallLayer: THREE.Group;
  tankLayer: THREE.Group;
  projectileLayer: THREE.Group;
  serverProjectileLayer: THREE.Group;
  pickupLayer: THREE.Group;
  zoneRing: THREE.Mesh;
  targetZoneRing: THREE.Mesh;
  zoneDarkness: THREE.Mesh;
  tankMeshes: Map<string, TankParts>;
  pickupMeshes: Map<string, PickupVisual>;
  serverProjectileMeshes: Map<string, THREE.Object3D>;
  resolvedProjectileIds: Map<string, number>;
  lastImpact: ProjectileImpactMessagePayload | null;
  rainLayer: RainLayer | null;
  particles: Particle[];
  seenAbilityActivations: Map<string, number>;
  mapKey: string;
  rainKey: string;
  snapshotKey: string;
  lastTime: number;
  visualTime: number;
  renderWidth: number;
  renderHeight: number;
  pixelRatio: number;
  shadowEnabled: boolean;
  lightingMode: LightingMode;
  lightingKey: string;
  forcedLightingMode: LightingMode | null;
  cameraOrbitAngle: number;
  cameraOrbitPendingDelta: number;
  orbitPointerId: number | null;
  orbitPointerLastX: number;
  smokePrewarmStatus: "idle" | "warming" | "ready" | "failed";
  rafId: number;
}

type LightingMode = "sun" | "evening" | "moon";

interface ArenaLightingPreset {
  mode: LightingMode;
  keyColor: number;
  keyIntensity: number;
  skyColor: number;
  groundColor: number;
  fillIntensity: number;
  fogColor: number;
  clearColor: number;
}

const COLORS = {
  ground: 0x928d84,
  groundDark: 0x746f66,
  wall: 0xb4ada1,
  wallSide: 0x9a9286,
  line: 0xa9a49a,
  white: 0xf7f3ed,
  ink: 0x47423d,
  accent: 0xf06b2b,
  accentHot: 0xff6a2b,
  blue: 0x5c7c8c,
  success: 0x88a06a,
  warning: 0xf0b45b,
  danger: 0xd75845
} as const;

const TANK_BARREL_BASE_OFFSET = 18;
const TANK_BARREL_MAX_LENGTH = 46;
const TANK_BARREL_MIN_LENGTH = 13;
const TANK_MUZZLE_SIZE = 7;
const TANK_MUZZLE_CLEARANCE = 7;
const TANK_PROJECTILE_VISUAL_Y = 32;
const TANK_PROJECTILE_SOCKET_Y_OFFSET = 0;
const SMOKE_TEXTURE_SIZE = 256;
const SMOKE_DESKTOP_PUFF_COUNT = 16;
const SMOKE_MOBILE_PUFF_COUNT = 12;
const SMOKE_PUFF_OPACITY_MIN = 0.52;
const SMOKE_PUFF_OPACITY_RANGE = 0.22;
const SMOKE_ALPHA_TEST = 0.01;

interface TankVisualConfig {
  hullColor: number;
  turretColor: number;
  trackColor: number;
  bodySize: [number, number, number];
  bodyY: number;
  trackSize: [number, number, number];
  trackY: number;
  trackOffset: number;
  turretSize: [number, number, number];
  barrelThickness: number;
}

const TANK_VISUAL_CONFIG = {
  nova: {
    hullColor: 0x9b452b,
    turretColor: 0xd05a2d,
    trackColor: 0x4f3932,
    bodySize: [70, 22, 46],
    bodyY: 19,
    trackSize: [68, 12, 9],
    trackY: 10,
    trackOffset: 27,
    turretSize: [38, 15, 30],
    barrelThickness: 6
  },
  atlas: {
    hullColor: 0xbdb8ae,
    turretColor: 0xd8d2c8,
    trackColor: 0x666159,
    bodySize: [68, 20, 44],
    bodyY: 18,
    trackSize: [66, 11, 9],
    trackY: 10,
    trackOffset: 26,
    turretSize: [34, 14, 28],
    barrelThickness: 5
  },
  quill: {
    hullColor: 0x444641,
    turretColor: 0x2f322f,
    trackColor: 0x292b29,
    bodySize: [70, 15, 38],
    bodyY: 15,
    trackSize: [68, 9, 8],
    trackY: 8,
    trackOffset: 23,
    turretSize: [30, 10, 22],
    barrelThickness: 4
  },
  rook: {
    hullColor: 0x65705f,
    turretColor: 0x7c8874,
    trackColor: 0x41473e,
    bodySize: [72, 25, 48],
    bodyY: 20,
    trackSize: [70, 14, 10],
    trackY: 11,
    trackOffset: 29,
    turretSize: [40, 18, 34],
    barrelThickness: 7
  }
} as const satisfies Record<TankArchetypeId, TankVisualConfig>;

const tankTurretY = (visual: TankVisualConfig): number =>
  visual.bodyY + visual.bodySize[1] / 2 + visual.turretSize[1] / 2 + 0.25;

const tankBarrelBaseOffset = (visual: TankVisualConfig): number =>
  Math.max(10, visual.turretSize[0] / 2 - 3);

const TANK_RADIUS = TANK_COLLISION_RADIUS;
const CAMERA_ZOOM = 1.15;
const CAMERA_LANDSCAPE_FRAME_HEIGHT = 980;
const CAMERA_PORTRAIT_FRAME_HEIGHT = 1340;
const CAMERA_MAX_FOCUSED_FRAME_HEIGHT = 1152;
const CAMERA_HEIGHT = 900;
const CAMERA_DISTANCE = 1220;
const CAMERA_ORBIT_SENSITIVITY = 0.006;
const MAP_TEXTURE_DETAIL_MULTIPLIER = 2;
const WALL_TEXTURE_WORLD_SCALE = 720 / MAP_TEXTURE_DETAIL_MULTIPLIER;
const STONE_WALL_PREVIEW_WORLD_SCALE = WALL_TEXTURE_WORLD_SCALE / 3;
const FLOOR_TEXTURE_WORLD_SCALE = 2450 / MAP_TEXTURE_DETAIL_MULTIPLIER;
const WORN_FLOOR_PREVIEW_WORLD_SCALE = FLOOR_TEXTURE_WORLD_SCALE * 0.1375;
const PLASTERED_FLOOR_PREVIEW_WORLD_SCALE = FLOOR_TEXTURE_WORLD_SCALE * 0.155;
const ROCK_FLOOR_PREVIEW_WORLD_SCALE = FLOOR_TEXTURE_WORLD_SCALE * 0.145;
const concreteTextureCache = new Map<"floor" | "wall", THREE.CanvasTexture>();
type ReferenceConcreteTextureId = "floorClean" | "floorWorn" | "floorDusty" | "wallClean" | "wallWorn" | "wallStained";
type FloorPreviewTextureId = "asphalt" | "worn" | "plaster" | "rock";
type WallPreviewTextureId = "stone";
type PreviewTextureScope = "floorPreview" | "wallPreview";
type PreviewTextureChannel = "color" | "normal" | "arm";
type PreviewMaterialTextures = Record<PreviewTextureChannel, string>;
type PreviewMaterialRequest = {
  scope: PreviewTextureScope;
  id: FloorPreviewTextureId | WallPreviewTextureId;
  textures: PreviewMaterialTextures;
  normalScale: number;
  roughness: number;
};
const referenceTextureSourceCache = new Map<ReferenceConcreteTextureId, THREE.Texture>();
const referenceTextureCache = new Map<string, THREE.Texture>();
const previewTextureSourceCache = new Map<string, THREE.Texture>();
const previewTextureSourcePromiseCache = new Map<string, Promise<THREE.Texture>>();
const previewTextureCache = new Map<string, THREE.Texture>();
const REFERENCE_CONCRETE_TEXTURES: Record<ReferenceConcreteTextureId, string> = {
  floorClean: "/assets/generated/textures/alpha7-floor-clean-albedo.png",
  floorWorn: "/assets/generated/textures/alpha7-floor-worn-albedo.png",
  floorDusty: "/assets/generated/textures/alpha7-floor-dusty-albedo.png",
  wallClean: "/assets/generated/textures/alpha7-wall-clean-tileable.png",
  wallWorn: "/assets/generated/textures/alpha7-wall-worn-tileable.png",
  wallStained: "/assets/generated/textures/alpha7-wall-stained-tileable.png"
};
const FLOOR_PREVIEW_TEXTURE_PARAM = "alpha7PreviewFloor";
const WALL_PREVIEW_TEXTURE_PARAM = "alpha7PreviewWall";
const FLOOR_PREVIEW_TEXTURES: Record<FloorPreviewTextureId, PreviewMaterialTextures> = {
  asphalt: {
    color: "/assets/generated/textures/alpha7-floor-asphalt-preview-color.jpg",
    normal: "/assets/generated/textures/alpha7-floor-asphalt-preview-normal.jpg",
    arm: "/assets/generated/textures/alpha7-floor-asphalt-preview-arm.jpg"
  },
  worn: {
    color: "/assets/generated/textures/alpha7-floor-concrete-worn-preview-color.jpg",
    normal: "/assets/generated/textures/alpha7-floor-concrete-worn-preview-normal.jpg",
    arm: "/assets/generated/textures/alpha7-floor-concrete-worn-preview-roughness.jpg"
  },
  plaster: {
    color: "/assets/generated/textures/alpha7-floor-plastered-preview-color.jpg",
    normal: "/assets/generated/textures/alpha7-floor-plastered-preview-normal.jpg",
    arm: "/assets/generated/textures/alpha7-floor-plastered-preview-arm.jpg"
  },
  rock: {
    color: "/assets/generated/textures/alpha7-floor-rock-dry-preview-color.jpg",
    normal: "/assets/generated/textures/alpha7-floor-rock-dry-preview-normal.jpg",
    arm: "/assets/generated/textures/alpha7-floor-rock-dry-preview-arm.jpg"
  }
};
const WALL_PREVIEW_TEXTURES: Record<WallPreviewTextureId, PreviewMaterialTextures> = {
  stone: {
    color: "/assets/generated/textures/alpha7-wall-stone-preview-color.jpg",
    normal: "/assets/generated/textures/alpha7-wall-stone-preview-normal.jpg",
    arm: "/assets/generated/textures/alpha7-wall-stone-preview-arm.jpg"
  }
};
let tankShadowTexture: THREE.CanvasTexture | null = null;
let wallShadowTexture: THREE.CanvasTexture | null = null;
let smokeTexture: THREE.CanvasTexture | null = null;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const MAP_MATERIAL_SOURCE = "reference-informed-concrete-v4";
const MAP_TEXTURE_CONTRACT = "seamless-reference-informed-generated";
const MAP_LIGHTING_SOURCE = "seeded-directional-v1";
const CANONICAL_FLOOR_TEXTURE: ReferenceConcreteTextureId = "floorClean";
const CANONICAL_WALL_TEXTURE: ReferenceConcreteTextureId = "wallClean";
const CANONICAL_FLOOR_MATERIAL: FloorPreviewTextureId = "worn";
const CANONICAL_WALL_MATERIAL: WallPreviewTextureId = "stone";
const TANK_CONTACT_SHADOW_OPACITY = 0.6;
const WALL_BASE_CONTACT_SHADOW_OPACITY = 0.82;
const WALL_CAST_SHADOW_OPACITY = 0.34;
const WALL_CAST_SHADOW_DISTANCE = 150;
const WALL_JUNCTION_EPSILON = 0.5;
const RAIN_LAYER_SOURCE = "weather-rain-lines-v1";
const RAIN_INTENSITY_MAX = 1;
const RAIN_TOP_Y_BASE = 430;
const RAIN_TOP_Y_VARIANCE = 110;
const RAIN_WRAP_HEIGHT_BASE = 760;
const RAIN_STREAK_LENGTH_BASE = 92;
const RAIN_FALL_SPEED_BASE = 480;
const RAIN_WORLD_MARGIN = 140;
const SERVER_PROJECTILE_RENDER_CAP = 24;
const DEBUG_TOOLS_COMPILED = import.meta.env.DEV || import.meta.env.VITE_DEBUG === "true";

const debugSearchParams = (): URLSearchParams | null => {
  if (!DEBUG_TOOLS_COMPILED || typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search);
};

const readInitialLightingMode = (): LightingMode | null => {
  const value = debugSearchParams()?.get("alpha7Lighting");
  return value === "sun" || value === "evening" || value === "moon" ? value : null;
};

const readInitialOrbitAngle = (): number => {
  const raw = debugSearchParams()?.get("alpha7Orbit");
  if (!raw) return 0;
  const degrees = Number(raw);
  if (!Number.isFinite(degrees)) return 0;
  return THREE.MathUtils.degToRad(clamp(degrees, -180, 180));
};

const readFloorPreviewTextureId = (): FloorPreviewTextureId | null => {
  const value = debugSearchParams()?.get(FLOOR_PREVIEW_TEXTURE_PARAM);
  if (value === "asphalt") return "asphalt";
  if (value === "worn" || value === "concrete-worn") return "worn";
  if (value === "plaster" || value === "plastered" || value === "plastered-wall") return "plaster";
  if (value === "rock" || value === "rock-dry" || value === "boulder" || value === "dry-boulder") return "rock";
  return null;
};

const readWallPreviewTextureId = (): WallPreviewTextureId | null => {
  const value = debugSearchParams()?.get(WALL_PREVIEW_TEXTURE_PARAM);
  return value === "stone" ? "stone" : null;
};

const mapKey = (
  map: ArenaMapConfig,
  floorPreviewTextureId: FloorPreviewTextureId | null = readFloorPreviewTextureId(),
  wallPreviewTextureId: WallPreviewTextureId | null = readWallPreviewTextureId()
): string =>
  `${map.source}:${map.id}:${map.width}:${map.height}:${map.walls.length}:${MAP_MATERIAL_SOURCE}:${floorPreviewTextureId ?? "canonical"}:${wallPreviewTextureId ?? "canonical"}`;

const createSeededRandom = (seed: string): (() => number) => {
  let state = hashString(seed) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const readMapWeather = (map: ArenaMapConfig): ArenaWeatherConfig | null => {
  const rawWeather = (map as ArenaMapConfig & { weather?: unknown }).weather as unknown;
  if (!rawWeather || typeof rawWeather !== "object" || Array.isArray(rawWeather)) return null;
  const weather = rawWeather as Record<string, unknown>;
  const kind = weather.kind;
  if (kind !== "clear" && kind !== "rain") return null;
  const intensity =
    typeof weather.intensity === "number" && Number.isFinite(weather.intensity)
      ? clamp(weather.intensity, 0, RAIN_INTENSITY_MAX)
      : 0;
  const seed = typeof weather.seed === "string" && weather.seed.trim() ? weather.seed.trim() : map.id || "alpha7";
  return { kind, intensity, seed };
};

const isActiveRainWeather = (weather: ArenaWeatherConfig | null): weather is ArenaWeatherConfig =>
  weather?.kind === "rain" && weather.intensity > 0;

const rainSegmentCount = (map: ArenaMapConfig, intensity: number, mobileLike: boolean): number => {
  const areaCount = (map.width * map.height) / 18000;
  const intensityScale = 0.28 + intensity * 0.92;
  const viewportScale = mobileLike ? 0.55 : 1;
  return Math.round(clamp(areaCount * intensityScale * viewportScale, mobileLike ? 36 : 60, mobileLike ? 120 : 220));
};

const snapshotPoseKey = (snapshot: ClientSnapshot): string =>
  `${snapshot.roomId}:${snapshot.matchId}:${snapshot.map.id}:${snapshot.self?.sessionId ?? "none"}`;

const hasServerPose = (player: ClientPlayer): boolean =>
  Math.abs(player.x) > 1 ||
  Math.abs(player.y) > 1 ||
  Math.abs(player.velocityX) > 0.01 ||
  Math.abs(player.velocityY) > 0.01;

const canDriveLocalTank = (snapshot: ClientSnapshot): boolean =>
  snapshot.roomId === "local" ||
  ((snapshot.matchState === "running" ||
    snapshot.matchState === "danger" ||
    snapshot.matchState === "final_zone") &&
    Boolean(snapshot.self?.isAlive && !snapshot.self.isSpectator));

const spawnForIndex = (map: ArenaMapConfig, index: number): { x: number; y: number } => {
  const spawn = map.spawns[index % Math.max(1, map.spawns.length)];
  return spawn ? { x: spawn.x, y: spawn.y } : { x: 0, y: 0 };
};

const spawnForSelf = (snapshot: ClientSnapshot): { x: number; y: number } => {
  const selfIndex = snapshot.self
    ? Math.max(0, snapshot.players.findIndex((player) => player.sessionId === snapshot.self?.sessionId))
    : 0;
  return spawnForIndex(snapshot.map, selfIndex);
};

const poseFromSnapshot = (snapshot: ClientSnapshot): LocalPose => {
  const self = snapshot.self;
  if (self && (snapshot.roomId === "local" || hasServerPose(self))) {
    return {
      x: self.x,
      y: self.y,
      rotation: self.rotation,
      turretRotation: self.turretRotation,
      velocityX: self.velocityX,
      velocityY: self.velocityY
    };
  }

  const spawn = spawnForSelf(snapshot);
  return {
    x: spawn.x,
    y: spawn.y,
    rotation: self?.rotation ?? 0,
    turretRotation: self?.turretRotation ?? 0,
    velocityX: self?.velocityX ?? 0,
    velocityY: self?.velocityY ?? 0
  };
};

const worldToThree = (x: number, y: number): THREE.Vector3 => new THREE.Vector3(x, 0, y);

const zoneDarknessSettings = (
  matchState: ClientSnapshot["matchState"],
  radius: number,
  time: number
): { opacity: number; feather: number; tint: number } => {
  const calmPhase = matchState === "waiting" || matchState === "countdown";
  const baseOpacity =
    matchState === "final_zone"
      ? 0.86
      : matchState === "danger"
        ? 0.8
        : calmPhase
          ? 0.045
          : 0.34;

  return {
    opacity: baseOpacity + Math.sin(time / 420) * 0.018,
    feather: Math.max(165, radius * 0.1),
    tint: matchState === "danger" || matchState === "final_zone" ? 0x050607 : 0x101213
  };
};

const canCreateWebGLContext = (): boolean => {
  const canvas = document.createElement("canvas");
  return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
};

const isMobileLikeViewport = (): boolean =>
  window.matchMedia("(pointer: coarse), (max-width: 760px), (max-height: 760px)").matches;

const prefersReducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const shouldUseDynamicShadows = (): boolean =>
  !window.matchMedia("(pointer: coarse), (max-width: 760px)").matches;

const isEditableElement = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
};

const disposeObject = (object: THREE.Object3D): void => {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    const disposeMaterial = (item: THREE.Material): void => {
      const textured = item as THREE.MeshStandardMaterial;
      const textures = new Set<THREE.Texture>();
      if (textured.map) textures.add(textured.map);
      if (textured.roughnessMap) textures.add(textured.roughnessMap);
      if (textured.normalMap) textures.add(textured.normalMap);
      if (textured.aoMap) textures.add(textured.aoMap);
      if (textured.emissiveMap) textures.add(textured.emissiveMap);
      textures.forEach((texture) => {
        if (!texture.userData.keepAlive) texture.dispose();
      });
      item.dispose();
    };
    if (Array.isArray(material)) {
      for (const item of material) disposeMaterial(item);
    } else if (material) {
      disposeMaterial(material);
    }
  });
};

const createZoneRing = (color: number, opacity: number, inner = 0.96, outer = 1): THREE.Mesh => {
  const geometry = new THREE.RingGeometry(inner, outer, 96);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide
  });
  const ring = new THREE.Mesh(geometry, material);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 3;
  ring.visible = false;
  return ring;
};

const createZoneDarkness = (): THREE.Mesh => {
  const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uCenter: { value: new THREE.Vector2(0, 0) },
      uRadius: { value: 0 },
      uFeather: { value: 120 },
      uOpacity: { value: 0 },
      uTint: { value: new THREE.Color(0x0f1112) }
    },
    vertexShader: `
      varying vec2 vWorld;

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec2 uCenter;
      uniform float uRadius;
      uniform float uFeather;
      uniform float uOpacity;
      uniform vec3 uTint;
      varying vec2 vWorld;

      void main() {
        float dist = distance(vWorld, uCenter);
        float alpha = smoothstep(uRadius - uFeather, uRadius + uFeather, dist) * uOpacity;
        gl_FragColor = vec4(uTint, alpha);
      }
    `
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 92;
  mesh.renderOrder = 25;
  mesh.visible = false;
  return mesh;
};

const seededNoise = (x: number, y: number, seed: number): number => {
  const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return value - Math.floor(value);
};

const wallTextureSet = (
  wall: ArenaWall
): { top: ReferenceConcreteTextureId; side: ReferenceConcreteTextureId; front: ReferenceConcreteTextureId } => {
  const wear = seededNoise(wall.x + wall.width * 0.37, wall.y + wall.height * 0.19, 71);
  const stain = seededNoise(wall.x - wall.height * 0.11, wall.y + wall.width * 0.23, 83);

  return {
    top: wear > 0.965 ? "wallWorn" : "wallClean",
    side: stain > 0.995 ? "wallStained" : wear > 0.955 ? "wallWorn" : "wallClean",
    front: stain > 0.997 ? "wallStained" : wear > 0.955 ? "wallWorn" : "wallClean"
  };
};

type WallEdgeSide = "left" | "right" | "top" | "bottom";

const wallBounds = (wall: ArenaWall): { left: number; right: number; top: number; bottom: number } => ({
  left: wall.x - wall.width / 2,
  right: wall.x + wall.width / 2,
  top: wall.y - wall.height / 2,
  bottom: wall.y + wall.height / 2
});

const rangesOverlap = (aMin: number, aMax: number, bMin: number, bMax: number): boolean =>
  Math.min(aMax, bMax) - Math.max(aMin, bMin) > WALL_JUNCTION_EPSILON;

type WallSideIntervals = Record<WallEdgeSide, Array<[number, number]>>;

const wallConnectionIntervals = (wall: ArenaWall, walls: ArenaWall[]): WallSideIntervals => {
  const bounds = wallBounds(wall);
  const intervals: WallSideIntervals = {
    left: [],
    right: [],
    top: [],
    bottom: []
  };

  // ponytail: O(n²) neighbor scan is fine for current arena sizes; add a spatial index if maps grow into thousands of wall segments.
  for (const other of walls) {
    if (other === wall || other.id === wall.id) continue;
    const otherBounds = wallBounds(other);
    const overlapZ: [number, number] = [
      Math.max(bounds.top, otherBounds.top),
      Math.min(bounds.bottom, otherBounds.bottom)
    ];
    const overlapX: [number, number] = [
      Math.max(bounds.left, otherBounds.left),
      Math.min(bounds.right, otherBounds.right)
    ];

    if (rangesOverlap(bounds.top, bounds.bottom, otherBounds.top, otherBounds.bottom)) {
      if (Math.abs(otherBounds.right - bounds.left) <= WALL_JUNCTION_EPSILON) intervals.left.push(overlapZ);
      if (Math.abs(otherBounds.left - bounds.right) <= WALL_JUNCTION_EPSILON) intervals.right.push(overlapZ);
    }
    if (rangesOverlap(bounds.left, bounds.right, otherBounds.left, otherBounds.right)) {
      if (Math.abs(otherBounds.bottom - bounds.top) <= WALL_JUNCTION_EPSILON) intervals.top.push(overlapX);
      if (Math.abs(otherBounds.top - bounds.bottom) <= WALL_JUNCTION_EPSILON) intervals.bottom.push(overlapX);
    }
  }

  return intervals;
};

const exposedWallIntervals = (
  min: number,
  max: number,
  covered: Array<[number, number]>
): Array<[number, number]> => {
  const merged: Array<[number, number]> = [];
  for (const interval of covered
    .map(([start, end]) => [Math.max(min, start), Math.min(max, end)] as [number, number])
    .filter(([start, end]) => end - start > WALL_JUNCTION_EPSILON)
    .sort(([a], [b]) => a - b)) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1] + WALL_JUNCTION_EPSILON) {
      previous[1] = Math.max(previous[1], interval[1]);
    } else {
      merged.push([...interval]);
    }
  }

  const exposed: Array<[number, number]> = [];
  let cursor = min;
  for (const [start, end] of merged) {
    if (start - cursor > WALL_JUNCTION_EPSILON) exposed.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (max - cursor > WALL_JUNCTION_EPSILON) exposed.push([cursor, max]);
  return exposed;
};

const intervalCoversPoint = (intervals: Array<[number, number]>, point: number): boolean =>
  intervals.some(
    ([start, end]) => point >= start - WALL_JUNCTION_EPSILON && point <= end + WALL_JUNCTION_EPSILON
  );

const createWallEdgeLines = (wall: ArenaWall, walls: ArenaWall[]): THREE.LineSegments => {
  const connections = wallConnectionIntervals(wall, walls);
  const bounds = wallBounds(wall);
  const exposedTop = exposedWallIntervals(bounds.left, bounds.right, connections.top);
  const exposedBottom = exposedWallIntervals(bounds.left, bounds.right, connections.bottom);
  const exposedLeft = exposedWallIntervals(bounds.top, bounds.bottom, connections.left);
  const exposedRight = exposedWallIntervals(bounds.top, bounds.bottom, connections.right);
  const toLocalX = (value: number): number => value - wall.x;
  const toLocalZ = (value: number): number => value - wall.y;
  const hx = wall.width / 2;
  const hy = wall.depth / 2;
  const hz = wall.height / 2;
  const points: number[] = [];
  const add = (a: [number, number, number], b: [number, number, number]): void => {
    points.push(...a, ...b);
  };
  const addHorizontalSegments = (segments: Array<[number, number]>, z: number): void => {
    for (const [start, end] of segments) {
      add([toLocalX(start), hy, z], [toLocalX(end), hy, z]);
      add([toLocalX(start), -hy, z], [toLocalX(end), -hy, z]);
    }
  };
  const addVerticalMapSegments = (segments: Array<[number, number]>, x: number): void => {
    for (const [start, end] of segments) {
      add([x, hy, toLocalZ(start)], [x, hy, toLocalZ(end)]);
      add([x, -hy, toLocalZ(start)], [x, -hy, toLocalZ(end)]);
    }
  };

  addHorizontalSegments(exposedTop, -hz);
  addHorizontalSegments(exposedBottom, hz);
  addVerticalMapSegments(exposedLeft, -hx);
  addVerticalMapSegments(exposedRight, hx);

  if (
    !intervalCoversPoint(connections.left, bounds.top) &&
    !intervalCoversPoint(connections.top, bounds.left)
  ) {
    add([-hx, -hy, -hz], [-hx, hy, -hz]);
  }
  if (
    !intervalCoversPoint(connections.right, bounds.top) &&
    !intervalCoversPoint(connections.top, bounds.right)
  ) {
    add([hx, -hy, -hz], [hx, hy, -hz]);
  }
  if (
    !intervalCoversPoint(connections.left, bounds.bottom) &&
    !intervalCoversPoint(connections.bottom, bounds.left)
  ) {
    add([-hx, -hy, hz], [-hx, hy, hz]);
  }
  if (
    !intervalCoversPoint(connections.right, bounds.bottom) &&
    !intervalCoversPoint(connections.bottom, bounds.right)
  ) {
    add([hx, -hy, hz], [hx, hy, hz]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color: 0x302c26,
      transparent: true,
      opacity: 0.025
    })
  );
};

const hashString = (source: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const lightingPresetForSeed = (seed: string, forcedMode?: LightingMode | null): ArenaLightingPreset => {
  const hash = hashString(`${seed || "alpha7"}:${MAP_LIGHTING_SOURCE}`);
  const mode: LightingMode = forcedMode ?? (hash % 13 === 0 ? "moon" : hash % 5 === 0 ? "evening" : "sun");
  if (mode === "moon") {
    return {
      mode,
      keyColor: 0xe0ebf7,
      keyIntensity: 1.72,
      skyColor: 0xcbd5df,
      groundColor: 0x67635a,
      fillIntensity: 1.24,
      fogColor: 0x4c5153,
      clearColor: 0x4c5153
    };
  }
  if (mode === "evening") {
    return {
      mode,
      keyColor: 0xffe3c7,
      keyIntensity: 2.04,
      skyColor: 0xe4d9d0,
      groundColor: 0x817a72,
      fillIntensity: 1.16,
      fogColor: 0x77736f,
      clearColor: 0x77736f
    };
  }

  return {
    mode,
    keyColor: 0xfff4e6,
    keyIntensity: 2.28,
    skyColor: 0xf7f2e9,
    groundColor: 0xaaa093,
    fillIntensity: 1.26,
    fogColor: COLORS.ground,
    clearColor: COLORS.ground
  };
};

const createTankShadowTexture = (): THREE.CanvasTexture => {
  if (tankShadowTexture) return tankShadowTexture;

  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    tankShadowTexture = new THREE.CanvasTexture(canvas);
    return tankShadowTexture;
  }

  const gradient = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
  gradient.addColorStop(0, "rgba(8, 8, 7, 0.58)");
  gradient.addColorStop(0.44, "rgba(8, 8, 7, 0.32)");
  gradient.addColorStop(1, "rgba(10, 10, 9, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);

  tankShadowTexture = new THREE.CanvasTexture(canvas);
  tankShadowTexture.colorSpace = THREE.SRGBColorSpace;
  return tankShadowTexture;
};

const createWallShadowTexture = (): THREE.CanvasTexture => {
  if (wallShadowTexture) return wallShadowTexture;

  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    wallShadowTexture = new THREE.CanvasTexture(canvas);
    return wallShadowTexture;
  }

  const image = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const index = (y * canvas.width + x) * 4;
      const dx = Math.abs(x - 64) / 56;
      const dy = Math.abs(y - 64) / 56;
      const edge = Math.max(dx, dy);
      const falloff = clamp((1 - edge) / 0.42, 0, 1);
      const alpha = Math.pow(falloff, 1.42) * 84;
      image.data[index] = 18;
      image.data[index + 1] = 16;
      image.data[index + 2] = 13;
      image.data[index + 3] = alpha;
    }
  }
  ctx.putImageData(image, 0, 0);

  wallShadowTexture = new THREE.CanvasTexture(canvas);
  wallShadowTexture.colorSpace = THREE.SRGBColorSpace;
  wallShadowTexture.userData.keepAlive = true;
  return wallShadowTexture;
};

const createSmokeTexture = (): THREE.CanvasTexture => {
  if (smokeTexture) return smokeTexture;

  const size = SMOKE_TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    smokeTexture = new THREE.CanvasTexture(canvas);
    smokeTexture.userData.keepAlive = true;
    return smokeTexture;
  }

  const lobes: Array<[number, number, number, number]> = [
    [128, 122, 92, 0.76],
    [82, 126, 70, 0.58],
    [174, 116, 72, 0.6],
    [108, 74, 62, 0.48],
    [155, 72, 58, 0.46],
    [99, 174, 66, 0.46],
    [162, 170, 64, 0.42],
    [58, 92, 48, 0.34],
    [205, 143, 46, 0.32],
    [130, 205, 50, 0.28]
  ];
  ctx.globalCompositeOperation = "lighter";
  for (const [x, y, radius, alpha] of lobes) {
    const lobe = ctx.createRadialGradient(x, y, radius * 0.08, x, y, radius);
    lobe.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    lobe.addColorStop(0.52, `rgba(255, 255, 255, ${alpha * 0.84})`);
    lobe.addColorStop(0.82, `rgba(255, 255, 255, ${alpha * 0.24})`);
    lobe.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = lobe;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  ctx.globalCompositeOperation = "destination-out";
  for (const [x, y, radius, alpha] of [
    [86, 91, 28, 0.1],
    [158, 132, 31, 0.09],
    [121, 175, 24, 0.08]
  ] as const) {
    const wisp = ctx.createRadialGradient(x, y, 0, x, y, radius);
    wisp.addColorStop(0, `rgba(0, 0, 0, ${alpha})`);
    wisp.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = wisp;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  smokeTexture = new THREE.CanvasTexture(canvas);
  smokeTexture.colorSpace = THREE.SRGBColorSpace;
  smokeTexture.magFilter = THREE.LinearFilter;
  smokeTexture.minFilter = THREE.LinearMipmapLinearFilter;
  smokeTexture.userData.keepAlive = true;
  return smokeTexture;
};

const createSmokePuffMaterial = (
  texture: THREE.Texture,
  color: number,
  opacity: number
): THREE.SpriteMaterial =>
  new THREE.SpriteMaterial({
    map: texture,
    color,
    transparent: true,
    opacity,
    alphaTest: SMOKE_ALPHA_TEST,
    depthWrite: false,
    depthTest: true,
    fog: true
  });

const prewarmSmokeResources = (runtime: Runtime): void => {
  if (runtime.smokePrewarmStatus !== "idle") return;
  runtime.smokePrewarmStatus = "warming";
  const texture = createSmokeTexture();
  runtime.renderer.initTexture(texture);

  const warmupScene = new THREE.Scene();
  warmupScene.fog = runtime.scene.fog;
  warmupScene.add(
    new THREE.Sprite(createSmokePuffMaterial(texture, 0x70756e, SMOKE_PUFF_OPACITY_MIN))
  );

  void runtime.renderer
    .compileAsync(warmupScene, runtime.camera)
    .then(() => {
      runtime.smokePrewarmStatus = "ready";
    })
    .catch(() => {
      runtime.smokePrewarmStatus = "failed";
    })
    .finally(() => {
      disposeObject(warmupScene);
    });
};

const createConcreteTexture = (kind: "floor" | "wall"): THREE.CanvasTexture => {
  const cached = concreteTextureCache.get(kind);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const empty = new THREE.CanvasTexture(canvas);
    concreteTextureCache.set(kind, empty);
    return empty;
  }

  const base: [number, number, number] = kind === "floor" ? [157, 153, 145] : [150, 142, 129];
  const [baseR, baseG, baseB] = base;
  ctx.fillStyle = `rgb(${baseR}, ${baseG}, ${baseB})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const index = (y * canvas.width + x) * 4;
      const noise = seededNoise(x, y, kind === "floor" ? 7 : 19);
      const broad = seededNoise(Math.floor(x / 24), Math.floor(y / 24), kind === "floor" ? 3 : 31);
      const cloud = seededNoise(Math.floor(x / 72), Math.floor(y / 72), kind === "floor" ? 13 : 43);
      const grain =
        (noise - 0.5) * (kind === "floor" ? 8 : 7) +
        (broad - 0.5) * (kind === "floor" ? 9 : 8) +
        (cloud - 0.5) * (kind === "floor" ? 13 : 11);
      image.data[index] = clamp(baseR + grain, 0, 255);
      image.data[index + 1] = clamp(baseG + grain, 0, 255);
      image.data[index + 2] = clamp(baseB + grain, 0, 255);
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  for (let i = 0; i < (kind === "floor" ? 20 : 16); i += 1) {
    const x = seededNoise(i, 4, 11) * canvas.width;
    const y = seededNoise(i, 9, 23) * canvas.height;
    const length = 18 + seededNoise(i, 2, 41) * (kind === "floor" ? 70 : 58);
    const angle = seededNoise(i, 8, 59) * Math.PI * 2;
    ctx.strokeStyle = `rgba(31, 29, 26, ${0.025 + seededNoise(i, 5, 71) * 0.04})`;
    ctx.lineWidth = 0.5 + seededNoise(i, 6, 83) * 0.75;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const midX = x + Math.cos(angle + 0.18) * length * 0.5;
    const midY = y + Math.sin(angle - 0.18) * length * 0.5;
    ctx.quadraticCurveTo(midX, midY, x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }

  for (let i = 0; i < (kind === "floor" ? 18 : 12); i += 1) {
    const x = seededNoise(i, 15, 97) * canvas.width;
    const y = seededNoise(i, 16, 109) * canvas.height;
    const radius = 28 + seededNoise(i, 17, 127) * (kind === "floor" ? 78 : 48);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(35, 32, 28, ${0.025 + seededNoise(i, 18, 139) * 0.045})`);
    gradient.addColorStop(1, "rgba(35, 32, 28, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  if (kind === "wall") {
    ctx.globalCompositeOperation = "screen";
    for (let i = 0; i < 7; i += 1) {
      const x = seededNoise(i, 22, 149) * canvas.width;
      const y = seededNoise(i, 23, 151) * canvas.height;
      const radius = 20 + seededNoise(i, 24, 157) * 36;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, "rgba(255, 248, 232, 0.055)");
      gradient.addColorStop(1, "rgba(255, 248, 232, 0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  concreteTextureCache.set(kind, texture);
  return texture;
};

const referenceTextureKey = (
  textureId: ReferenceConcreteTextureId,
  repeatX: number,
  repeatY: number
): string => `${textureId}:${repeatX.toFixed(3)}:${repeatY.toFixed(3)}`;

const previewTextureSourceKey = (
  scope: PreviewTextureScope,
  textureId: FloorPreviewTextureId | WallPreviewTextureId,
  channel: PreviewTextureChannel
): string => `${scope}:${textureId}:${channel}`;

const previewTextureKey = (
  scope: PreviewTextureScope,
  textureId: FloorPreviewTextureId | WallPreviewTextureId,
  channel: PreviewTextureChannel,
  repeatX: number,
  repeatY: number
): string => `${previewTextureSourceKey(scope, textureId, channel)}:${repeatX.toFixed(3)}:${repeatY.toFixed(3)}`;

const configureReferenceConcreteTexture = (texture: THREE.Texture): THREE.Texture => {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 6;
  texture.userData.keepAlive = true;
  texture.needsUpdate = true;
  return texture;
};

const configurePreviewTexture = (texture: THREE.Texture, channel: PreviewTextureChannel): THREE.Texture => {
  texture.colorSpace = channel === "color" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = channel === "color" ? 8 : 4;
  texture.userData.keepAlive = true;
  texture.needsUpdate = true;
  return texture;
};

const createNeutralPreviewTexture = (channel: PreviewTextureChannel): THREE.Texture => {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle =
      channel === "normal"
        ? "rgb(128, 128, 255)"
        : channel === "arm"
          ? "rgb(235, 235, 235)"
          : "rgb(180, 176, 168)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return configurePreviewTexture(new THREE.CanvasTexture(canvas), channel);
};

const proceduralConcreteSourceFor = (textureId: ReferenceConcreteTextureId): THREE.Texture => {
  const kind = textureId.startsWith("floor") ? "floor" : "wall";
  return configureReferenceConcreteTexture(createConcreteTexture(kind).clone());
};

const loadReferenceConcreteSource = (textureId: ReferenceConcreteTextureId): THREE.Texture => {
  const cached = referenceTextureSourceCache.get(textureId);
  if (cached) return cached;

  const texture = proceduralConcreteSourceFor(textureId);
  texture.userData.proceduralSource = true;
  referenceTextureSourceCache.set(textureId, texture);
  return texture;
};

const loadPreviewTextureSourceAsync = (
  scope: PreviewTextureScope,
  textureId: FloorPreviewTextureId | WallPreviewTextureId,
  channel: PreviewTextureChannel,
  path: string
): Promise<THREE.Texture> => {
  const sourceKey = previewTextureSourceKey(scope, textureId, channel);
  const cached = previewTextureSourceCache.get(sourceKey);
  if (cached) return Promise.resolve(cached);

  const pending = previewTextureSourcePromiseCache.get(sourceKey);
  if (pending) return pending;

  const promise = new THREE.TextureLoader()
    .loadAsync(path)
    .then((texture) => {
      const configured = configurePreviewTexture(texture, channel);
      previewTextureSourceCache.set(sourceKey, configured);
      previewTextureSourcePromiseCache.delete(sourceKey);
      return configured;
    })
    .catch((error) => {
      previewTextureSourcePromiseCache.delete(sourceKey);
      console.warn(`Alpha-7 preview texture failed to load: ${path}`, error);
      const fallback = channel === "color"
        ? loadReferenceConcreteSource(scope === "floorPreview" ? CANONICAL_FLOOR_TEXTURE : CANONICAL_WALL_TEXTURE)
        : createNeutralPreviewTexture(channel);
      previewTextureSourceCache.set(sourceKey, fallback);
      return fallback;
    });

  previewTextureSourcePromiseCache.set(sourceKey, promise);
  return promise;
};

const preloadArenaTextures = async (): Promise<void> => {
  const floorPreviewTextureId = readFloorPreviewTextureId();
  const wallPreviewTextureId = readWallPreviewTextureId();
  const activeFloorMaterialId = floorPreviewTextureId ?? CANONICAL_FLOOR_MATERIAL;
  const activeWallMaterialId = wallPreviewTextureId ?? CANONICAL_WALL_MATERIAL;
  const previewLoads: Promise<THREE.Texture>[] = [];
  if (activeFloorMaterialId) {
    const textures = FLOOR_PREVIEW_TEXTURES[activeFloorMaterialId];
    previewLoads.push(
      ...Object.entries(textures).map(([channel, path]) =>
        loadPreviewTextureSourceAsync("floorPreview", activeFloorMaterialId, channel as PreviewTextureChannel, path)
      )
    );
  }
  if (activeWallMaterialId) {
    const textures = WALL_PREVIEW_TEXTURES[activeWallMaterialId];
    previewLoads.push(
      ...Object.entries(textures).map(([channel, path]) =>
        loadPreviewTextureSourceAsync("wallPreview", activeWallMaterialId, channel as PreviewTextureChannel, path)
      )
    );
  }
  if (previewLoads.length > 0) await Promise.all(previewLoads);
};

const createReferenceConcreteTexture = (
  textureId: ReferenceConcreteTextureId,
  repeatX: number,
  repeatY: number
): THREE.Texture => {
  const key = referenceTextureKey(textureId, repeatX, repeatY);
  const cached = referenceTextureCache.get(key);
  if (cached) return cached;

  const texture = loadReferenceConcreteSource(textureId).clone();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(Math.max(1, repeatX), Math.max(1, repeatY));
  texture.anisotropy = 6;
  texture.userData.keepAlive = true;
  texture.needsUpdate = true;
  referenceTextureCache.set(key, texture);
  return texture;
};

const createPreviewTexture = (
  scope: PreviewTextureScope,
  textureId: FloorPreviewTextureId | WallPreviewTextureId,
  channel: PreviewTextureChannel,
  path: string,
  repeatX: number,
  repeatY: number
): THREE.Texture => {
  const source = previewTextureSourceCache.get(previewTextureSourceKey(scope, textureId, channel)) ??
    (channel === "color"
      ? loadReferenceConcreteSource(scope === "floorPreview" ? CANONICAL_FLOOR_TEXTURE : CANONICAL_WALL_TEXTURE)
      : createNeutralPreviewTexture(channel));

  const key = previewTextureKey(scope, textureId, channel, repeatX, repeatY);
  const cached = previewTextureCache.get(key);
  if (cached) return cached;

  const texture = source.clone();
  texture.colorSpace = channel === "color" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(Math.max(1, repeatX), Math.max(1, repeatY));
  texture.anisotropy = channel === "color" ? 8 : 4;
  texture.userData.keepAlive = true;
  texture.userData.sourcePath = path;
  texture.needsUpdate = true;
  previewTextureCache.set(key, texture);
  return texture;
};

const applyConcreteTexture = (
  material: THREE.MeshStandardMaterial,
  kind: "floor" | "wall",
  repeatX: number,
  repeatY: number,
  referenceTextureId?: ReferenceConcreteTextureId,
  previewMaterial?: PreviewMaterialRequest | null
): void => {
  const texture = previewMaterial
    ? createPreviewTexture(previewMaterial.scope, previewMaterial.id, "color", previewMaterial.textures.color, repeatX, repeatY)
    : referenceTextureId
      ? createReferenceConcreteTexture(referenceTextureId, repeatX, repeatY)
      : createConcreteTexture(kind).clone();
  if (!referenceTextureId && !previewMaterial) {
    texture.needsUpdate = true;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(Math.max(1, repeatX), Math.max(1, repeatY));
    texture.colorSpace = THREE.SRGBColorSpace;
  }
  material.map = texture;
  if (previewMaterial) {
    material.normalMap = createPreviewTexture(previewMaterial.scope, previewMaterial.id, "normal", previewMaterial.textures.normal, repeatX, repeatY);
    material.roughnessMap = createPreviewTexture(previewMaterial.scope, previewMaterial.id, "arm", previewMaterial.textures.arm, repeatX, repeatY);
    material.normalScale = new THREE.Vector2(previewMaterial.normalScale, previewMaterial.normalScale);
    material.roughness = previewMaterial.roughness;
    material.metalness = 0;
  }
  material.needsUpdate = true;
};

const createConcreteMaterial = (
  color: number,
  kind: "floor" | "wall",
  repeatX: number,
  repeatY: number,
  options: {
    roughness?: number;
    metalness?: number;
    textureId?: ReferenceConcreteTextureId;
    previewMaterial?: PreviewMaterialRequest | null;
    emissive?: number;
    emissiveIntensity?: number;
  } = {}
): THREE.MeshStandardMaterial => {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? (kind === "floor" ? 0.96 : 0.9),
    metalness: options.metalness ?? 0.01,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 0
  });
  applyConcreteTexture(material, kind, repeatX, repeatY, options.textureId, options.previewMaterial);
  return material;
};

const previewMaterialForWall = (wallPreviewTextureId: WallPreviewTextureId | null): PreviewMaterialRequest | null =>
  wallPreviewTextureId
    ? {
        scope: "wallPreview",
        id: wallPreviewTextureId,
        textures: WALL_PREVIEW_TEXTURES[wallPreviewTextureId],
        normalScale: 0.34,
        roughness: 0.92
      }
    : null;

const previewMaterialForFloor = (floorPreviewTextureId: FloorPreviewTextureId | null): PreviewMaterialRequest | null =>
  floorPreviewTextureId
    ? {
        scope: "floorPreview",
        id: floorPreviewTextureId,
        textures: FLOOR_PREVIEW_TEXTURES[floorPreviewTextureId],
        normalScale:
          floorPreviewTextureId === "worn"
            ? 0.5
            : floorPreviewTextureId === "plaster"
              ? 0.34
              : floorPreviewTextureId === "rock"
                ? 0.28
                : 0.42,
        roughness:
          floorPreviewTextureId === "worn"
            ? 0.9
            : floorPreviewTextureId === "plaster"
              ? 0.96
              : floorPreviewTextureId === "rock"
                ? 0.98
                : 0.95
      }
    : null;

const alignWallGeometryUvs = (
  geometry: THREE.BoxGeometry,
  wall: ArenaWall,
  texelScale: number
): void => {
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  const uvs = geometry.getAttribute("uv");

  for (let index = 0; index < positions.count; index += 1) {
    const localX = positions.getX(index);
    const localY = positions.getY(index);
    const localZ = positions.getZ(index);
    const normalX = Math.abs(normals.getX(index));
    const normalY = Math.abs(normals.getY(index));
    const worldY = localY + wall.depth / 2;
    let u: number;
    let v: number;

    if (normalY > 0.5) {
      u = (wall.x + localX) / texelScale;
      v = (wall.y + localZ) / texelScale;
    } else if (normalX > 0.5) {
      u = (wall.y + localZ) / texelScale;
      v = worldY / texelScale;
    } else {
      u = (wall.x + localX) / texelScale;
      v = worldY / texelScale;
    }

    uvs.setXY(index, u, v);
  }

  uvs.needsUpdate = true;
};

const alignWallCapUvs = (
  geometry: THREE.PlaneGeometry,
  centerX: number,
  centerZ: number,
  texelScale: number
): void => {
  const positions = geometry.getAttribute("position");
  const uvs = geometry.getAttribute("uv");
  for (let index = 0; index < positions.count; index += 1) {
    uvs.setXY(
      index,
      (centerX + positions.getX(index)) / texelScale,
      (centerZ - positions.getY(index)) / texelScale
    );
  }
  uvs.needsUpdate = true;
};

const createWallMesh = (
  wall: ArenaWall,
  wallMaterialId: WallPreviewTextureId | null,
  visibleWalls: ArenaWall[]
): THREE.Object3D => {
  const geometry = new THREE.BoxGeometry(wall.width, wall.depth, wall.height);
  const texelScale = wallMaterialId === "stone" ? STONE_WALL_PREVIEW_WORLD_SCALE : WALL_TEXTURE_WORLD_SCALE;
  alignWallGeometryUvs(geometry, wall, texelScale);
  const textureSet = wallTextureSet(wall);
  const previewMaterial = previewMaterialForWall(wallMaterialId);
  const topMaterial = createConcreteMaterial(
    0xffffff,
    "wall",
    1,
    1,
    {
      roughness: previewMaterial ? 0.92 : 0.94,
      metalness: 0,
      textureId: previewMaterial ? undefined : textureSet.top,
      previewMaterial,
      emissive: previewMaterial ? 0x000000 : 0x413c34,
      emissiveIntensity: previewMaterial ? 0 : 0.014
    }
  );
  const sideMaterial = createConcreteMaterial(
    previewMaterial ? 0xf7f2e8 : 0xe7decf,
    "wall",
    1,
    1,
    {
      roughness: previewMaterial ? 0.92 : 0.965,
      metalness: 0,
      textureId: previewMaterial ? undefined : textureSet.side,
      previewMaterial,
      emissive: previewMaterial ? 0x000000 : 0x5d5549,
      emissiveIntensity: previewMaterial ? 0 : 0.052
    }
  );
  const frontMaterial = createConcreteMaterial(
    previewMaterial ? 0xfbf7ef : 0xf0e8da,
    "wall",
    1,
    1,
    {
      roughness: previewMaterial ? 0.92 : 0.965,
      metalness: 0,
      textureId: previewMaterial ? undefined : textureSet.front,
      previewMaterial,
      emissive: previewMaterial ? 0x000000 : 0x625a4d,
      emissiveIntensity: previewMaterial ? 0 : 0.046
    }
  );
  const material = [sideMaterial, sideMaterial, topMaterial, sideMaterial, frontMaterial, frontMaterial];
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = true;

  const edges = createWallEdgeLines(wall, visibleWalls);

  const group = new THREE.Group();
  group.position.set(wall.x, wall.depth / 2, wall.y);
  const baseShadowMap = createWallShadowTexture().clone();
  baseShadowMap.needsUpdate = true;
  const baseContactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(wall.width + 42, wall.height + 42),
    new THREE.MeshBasicMaterial({
      map: baseShadowMap,
      transparent: true,
      opacity: WALL_BASE_CONTACT_SHADOW_OPACITY,
      depthWrite: false
    })
  );
  baseContactShadow.rotation.x = -Math.PI / 2;
  baseContactShadow.position.set(0, -wall.depth / 2 + 1.1, 0);

  const castShadowMap = createWallShadowTexture().clone();
  castShadowMap.needsUpdate = true;
  const contactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(wall.width + 300, wall.height + 260),
    new THREE.MeshBasicMaterial({
      map: castShadowMap,
      transparent: true,
      opacity: WALL_CAST_SHADOW_OPACITY,
      depthWrite: false
    })
  );
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.set(0, -wall.depth / 2 + 0.95, 0);
  contactShadow.userData.alpha7WallCastShadow = true;
  group.add(contactShadow, baseContactShadow, mesh, edges);
  return group;
};

const createWallJunctionCaps = (
  walls: ArenaWall[],
  wallMaterialId: WallPreviewTextureId | null
): THREE.Group => {
  const group = new THREE.Group();
  group.name = "wall-junction-caps";
  const texelScale = wallMaterialId === "stone" ? STONE_WALL_PREVIEW_WORLD_SCALE : WALL_TEXTURE_WORLD_SCALE;
  const previewMaterial = previewMaterialForWall(wallMaterialId);
  const seen = new Set<string>();

  for (let firstIndex = 0; firstIndex < walls.length; firstIndex += 1) {
    const first = walls[firstIndex];
    if (!first) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < walls.length; secondIndex += 1) {
      const second = walls[secondIndex];
      if (!second || (first.width >= first.height) === (second.width >= second.height)) continue;
      if (Math.abs(first.depth - second.depth) > 1) continue;

      const left = Math.max(first.x - first.width / 2, second.x - second.width / 2);
      const right = Math.min(first.x + first.width / 2, second.x + second.width / 2);
      const top = Math.max(first.y - first.height / 2, second.y - second.height / 2);
      const bottom = Math.min(first.y + first.height / 2, second.y + second.height / 2);
      const width = right - left;
      const height = bottom - top;
      if (width <= 1 || height <= 1) continue;

      const key = `${left.toFixed(2)}:${top.toFixed(2)}:${right.toFixed(2)}:${bottom.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const material = createConcreteMaterial(
        previewMaterial ? 0xffffff : 0xf5f0e6,
        "wall",
        1,
        1,
        {
          roughness: previewMaterial ? 0.92 : 0.94,
          metalness: 0,
          textureId: previewMaterial ? undefined : wallTextureSet(first).top,
          previewMaterial,
          emissive: previewMaterial ? 0x000000 : 0x5d5549,
          emissiveIntensity: previewMaterial ? 0 : 0.022
        }
      );
      const centerX = (left + right) / 2;
      const centerZ = (top + bottom) / 2;
      const geometry = new THREE.PlaneGeometry(width + 1.2, height + 1.2);
      alignWallCapUvs(geometry, centerX, centerZ, texelScale);
      const cap = new THREE.Mesh(geometry, material);
      cap.rotation.x = -Math.PI / 2;
      cap.position.set(centerX, Math.max(first.depth, second.depth) + 0.18, centerZ);
      cap.receiveShadow = true;
      cap.renderOrder = 1;
      group.add(cap);
    }
  }

  return group;
};

type BoundarySide = "top" | "right" | "bottom" | "left";

type BoundarySegment = {
  side: BoundarySide;
  start: number;
  end: number;
  coordinate: number;
};

const mergeBoundaryIntervals = (intervals: Array<[number, number]>): Array<[number, number]> => {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of intervals
    .filter(([start, end]) => end - start > WALL_JUNCTION_EPSILON)
    .sort(([a], [b]) => a - b)) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + WALL_JUNCTION_EPSILON) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
};

const boundarySegmentsForMap = (map: ArenaMapConfig): BoundarySegment[] => {
  const intervals: Record<BoundarySide, Array<[number, number]>> = {
    top: [],
    right: [],
    bottom: [],
    left: []
  };

  for (const wall of map.walls) {
    if (!isOuterBoundaryWall(wall, map)) continue;
    const bounds = wallBounds(wall);
    const horizontal = wall.width >= wall.height;
    const vertical = wall.height >= wall.width;
    if (horizontal && bounds.top <= 10) {
      intervals.top.push([clamp(bounds.left, 0, map.width), clamp(bounds.right, 0, map.width)]);
    }
    if (horizontal && bounds.bottom >= map.height - 10) {
      intervals.bottom.push([clamp(bounds.left, 0, map.width), clamp(bounds.right, 0, map.width)]);
    }
    if (vertical && bounds.left <= 10) {
      intervals.left.push([clamp(bounds.top, 0, map.height), clamp(bounds.bottom, 0, map.height)]);
    }
    if (vertical && bounds.right >= map.width - 10) {
      intervals.right.push([clamp(bounds.top, 0, map.height), clamp(bounds.bottom, 0, map.height)]);
    }
  }

  const horizontalBoundaryWalls = map.walls.filter(
    (wall) => isOuterBoundaryWall(wall, map) && wall.width >= wall.height
  );
  const verticalBoundaryWalls = map.walls.filter(
    (wall) => isOuterBoundaryWall(wall, map) && wall.height >= wall.width
  );
  const topFaces = horizontalBoundaryWalls
    .map(wallBounds)
    .filter((bounds) => bounds.top <= 10)
    .map((bounds) => bounds.bottom);
  const bottomFaces = horizontalBoundaryWalls
    .map(wallBounds)
    .filter((bounds) => bounds.bottom >= map.height - 10)
    .map((bounds) => bounds.top);
  const leftFaces = verticalBoundaryWalls
    .map(wallBounds)
    .filter((bounds) => bounds.left <= 10)
    .map((bounds) => bounds.right);
  const rightFaces = verticalBoundaryWalls
    .map(wallBounds)
    .filter((bounds) => bounds.right >= map.width - 10)
    .map((bounds) => bounds.left);
  const coordinates: Record<BoundarySide, number> = {
    top: topFaces.length > 0 ? Math.max(...topFaces) : 0,
    right: rightFaces.length > 0 ? Math.min(...rightFaces) : map.width,
    bottom: bottomFaces.length > 0 ? Math.min(...bottomFaces) : map.height,
    left: leftFaces.length > 0 ? Math.max(...leftFaces) : 0
  };

  return (Object.keys(intervals) as BoundarySide[]).flatMap((side) =>
    mergeBoundaryIntervals(intervals[side]).map(([start, end]) => ({
      side,
      start,
      end,
      coordinate: coordinates[side]
    }))
  );
};

const createBoundaryBarrier = (map: ArenaMapConfig): THREE.Group => {
  const group = new THREE.Group();
  group.name = "boundary-barrier";
  const height = 72;
  const material = () =>
    new THREE.MeshBasicMaterial({
      color: 0x9cc9dd,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      wireframe: true
    });

  for (const segment of boundarySegmentsForMap(map)) {
    const horizontal = segment.side === "top" || segment.side === "bottom";
    const segmentLength = segment.end - segment.start;
    const span = Math.min(segmentLength, 320);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(span, height, 8, 2),
      material()
    );
    if (horizontal) {
      panel.position.set((segment.start + segment.end) / 2, height / 2, segment.coordinate);
    } else {
      panel.position.set(segment.coordinate, height / 2, (segment.start + segment.end) / 2);
      panel.rotation.y = Math.PI / 2;
    }
    panel.userData.boundarySegment = segment;
    panel.userData.boundarySpan = span;
    group.add(panel);
  }
  return group;
};

const updateBoundaryBarrier = (
  runtime: Runtime,
  pose: LocalPose,
  dt: number
): void => {
  const barrier = runtime.wallLayer.getObjectByName("boundary-barrier");
  if (!barrier) return;
  const fade = frameRateIndependentLerp(0.34, dt);
  for (const panel of barrier.children) {
    const segment = panel.userData.boundarySegment as BoundarySegment | undefined;
    const panelMaterial = (panel as THREE.Mesh).material as THREE.MeshBasicMaterial;
    if (!segment || !panelMaterial) continue;
    const horizontal = segment.side === "top" || segment.side === "bottom";
    const nearestX = horizontal ? clamp(pose.x, segment.start, segment.end) : segment.coordinate;
    const nearestY = horizontal ? segment.coordinate : clamp(pose.y, segment.start, segment.end);
    const distance = Math.hypot(pose.x - nearestX, pose.y - nearestY);
    const contact = distance <= TANK_RADIUS + 64 ? 1 : 0;
    const span = Number(panel.userData.boundarySpan ?? 320);
    if (horizontal) {
      panel.position.x = clamp(
        pose.x,
        segment.start + span / 2,
        segment.end - span / 2
      );
    } else {
      panel.position.z = clamp(
        pose.y,
        segment.start + span / 2,
        segment.end - span / 2
      );
    }
    panelMaterial.opacity += (contact * 0.34 - panelMaterial.opacity) * fade;
    panel.visible = panelMaterial.opacity > 0.002;
  }
};

const createGround = (map: ArenaMapConfig, floorPreviewTextureId: FloorPreviewTextureId | null): THREE.Group => {
  const group = new THREE.Group();
  const floorPadding = Math.max(1000, Math.max(map.width, map.height) * 0.32);
  const floorWidth = map.width + floorPadding * 2;
  const floorHeight = map.height + floorPadding * 2;
  const activeFloorMaterialId = floorPreviewTextureId ?? CANONICAL_FLOOR_MATERIAL;
  const previewMaterial = previewMaterialForFloor(activeFloorMaterialId);
  const floorTextureWorldScale =
    activeFloorMaterialId === "worn"
      ? WORN_FLOOR_PREVIEW_WORLD_SCALE
      : activeFloorMaterialId === "plaster"
        ? PLASTERED_FLOOR_PREVIEW_WORLD_SCALE
        : activeFloorMaterialId === "rock"
          ? ROCK_FLOOR_PREVIEW_WORLD_SCALE
        : FLOOR_TEXTURE_WORLD_SCALE;
  const floorMaterial = createConcreteMaterial(
    0xffffff,
    "floor",
    Math.max(1.35, floorWidth / floorTextureWorldScale),
    Math.max(1.35, floorHeight / floorTextureWorldScale),
    {
      roughness: previewMaterial ? 0.94 : 0.985,
      metalness: 0,
      textureId: previewMaterial ? undefined : CANONICAL_FLOOR_TEXTURE,
      previewMaterial
    }
  );
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorWidth, floorHeight, 1, 1), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(map.width / 2, 0, map.height / 2);
  floor.receiveShadow = true;
  group.add(floor);

  return group;
};

const createRainLayer = (map: ArenaMapConfig, weather: ArenaWeatherConfig, mobileLike: boolean): RainLayer => {
  const segmentCount = rainSegmentCount(map, weather.intensity, mobileLike);
  const positions = new Float32Array(segmentCount * 6);
  const baseX = new Float32Array(segmentCount);
  const baseZ = new Float32Array(segmentCount);
  const phase = new Float32Array(segmentCount);
  const speed = new Float32Array(segmentCount);
  const length = new Float32Array(segmentCount);
  const streakDx = new Float32Array(segmentCount);
  const streakDz = new Float32Array(segmentCount);
  const driftX = new Float32Array(segmentCount);
  const driftZ = new Float32Array(segmentCount);

  const rng = createSeededRandom(`${weather.seed}:${mobileLike ? "mobile" : "desktop"}:${segmentCount}`);
  const windRng = createSeededRandom(`${weather.seed}:wind`);
  const windAngle = windRng() * Math.PI * 2;
  const driftDistance = 22 + weather.intensity * 30;
  const baseDx = Math.cos(windAngle) * driftDistance;
  const baseDz = Math.sin(windAngle) * driftDistance;
  const topY = RAIN_TOP_Y_BASE + weather.intensity * RAIN_TOP_Y_VARIANCE;
  const wrapHeight = RAIN_WRAP_HEIGHT_BASE + weather.intensity * 120;
  const baseSpeed = RAIN_FALL_SPEED_BASE * (0.78 + weather.intensity * 0.54);
  const baseLength = RAIN_STREAK_LENGTH_BASE * (0.8 + weather.intensity * 0.58);

  for (let index = 0; index < segmentCount; index += 1) {
    baseX[index] = -RAIN_WORLD_MARGIN + rng() * (map.width + RAIN_WORLD_MARGIN * 2);
    baseZ[index] = -RAIN_WORLD_MARGIN + rng() * (map.height + RAIN_WORLD_MARGIN * 2);
    phase[index] = rng() * wrapHeight;
    speed[index] = baseSpeed * (0.82 + rng() * 0.34);
    length[index] = baseLength * (0.72 + rng() * 0.46);
    const slantScale = 0.78 + rng() * 0.44;
    streakDx[index] = baseDx * slantScale;
    streakDz[index] = baseDz * slantScale;
    driftX[index] = baseDx * (1.08 + rng() * 0.42);
    driftZ[index] = baseDz * (1.08 + rng() * 0.42);
  }

  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", positionAttribute);

  const material = new THREE.LineBasicMaterial({
    color: 0xd8dde6,
    transparent: true,
    opacity: mobileLike ? 0.14 : 0.19,
    depthWrite: false
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = 5;
  lines.userData.alpha7Rain = true;

  return {
    lines,
    material,
    positionAttribute,
    positions,
    baseX,
    baseZ,
    phase,
    speed,
    length,
    streakDx,
    streakDz,
    driftX,
    driftZ,
    topY,
    wrapHeight,
    segmentCount,
    mobileReduced: mobileLike,
    reducedMotion: prefersReducedMotion(),
    weather,
    appearanceKey: "",
    lastUpdateTime: Number.NEGATIVE_INFINITY
  };
};

const updateRainAppearance = (layer: RainLayer, lightingMode: LightingMode): void => {
  const appearanceKey =
    `${lightingMode}:${layer.weather.intensity.toFixed(3)}:` +
    `${layer.mobileReduced ? "m" : "d"}:${layer.reducedMotion ? "r" : "a"}`;
  if (layer.appearanceKey === appearanceKey) return;
  layer.appearanceKey = appearanceKey;
  layer.material.color.setHex(lightingMode === "moon" ? 0xb5c6da : lightingMode === "evening" ? 0xf1d4ba : 0xd7dde4);
  layer.material.opacity = clamp(
    (layer.mobileReduced ? 0.12 : 0.17) *
      (0.78 + layer.weather.intensity * 0.5) *
      (layer.reducedMotion ? 0.58 : 1),
    0.08,
    0.28
  );
};

// Update a small dynamic line buffer instead of allocating transient particle meshes.
const updateRainLayer = (runtime: Runtime): void => {
  const layer = runtime.rainLayer;
  if (!layer) return;
  if (layer.reducedMotion && Number.isFinite(layer.lastUpdateTime)) return;
  const updateInterval = layer.mobileReduced ? 1000 / 30 : 0;
  if (runtime.visualTime - layer.lastUpdateTime < updateInterval) return;
  layer.lastUpdateTime = runtime.visualTime;
  updateRainAppearance(layer, runtime.lightingMode);
  const timeSeconds = runtime.visualTime * 0.001;
  for (let index = 0; index < layer.segmentCount; index += 1) {
    const phase = layer.phase[index] ?? 0;
    const speed = layer.speed[index] ?? 0;
    const driftX = layer.driftX[index] ?? 0;
    const driftZ = layer.driftZ[index] ?? 0;
    const streakDx = layer.streakDx[index] ?? 0;
    const streakDz = layer.streakDz[index] ?? 0;
    const streakLength = layer.length[index] ?? 0;
    const baseX = layer.baseX[index] ?? 0;
    const baseZ = layer.baseZ[index] ?? 0;
    const fall = (phase + timeSeconds * speed) % layer.wrapHeight;
    const driftProgress = fall / layer.wrapHeight;
    const startX = baseX + driftX * driftProgress;
    const startY = layer.topY - fall;
    const startZ = baseZ + driftZ * driftProgress;
    const positionIndex = index * 6;
    layer.positions[positionIndex] = startX;
    layer.positions[positionIndex + 1] = startY;
    layer.positions[positionIndex + 2] = startZ;
    layer.positions[positionIndex + 3] = startX + streakDx;
    layer.positions[positionIndex + 4] = startY - streakLength;
    layer.positions[positionIndex + 5] = startZ + streakDz;
  }
  layer.positionAttribute.needsUpdate = true;
};

const syncRainLayer = (runtime: Runtime, snapshot: ClientSnapshot): void => {
  const weather = readMapWeather(snapshot.map);
  const mobileLike = isMobileLikeViewport();
  const intensityKey = weather ? weather.intensity.toFixed(3) : "0.000";
  const nextRainKey =
    `${snapshot.map.id}:${snapshot.map.width}:${snapshot.map.height}:` +
    `${weather?.kind ?? "none"}:${weather?.seed ?? "na"}:${intensityKey}:${mobileLike ? "m" : "d"}`;
  if (runtime.rainKey === nextRainKey) return;
  runtime.rainKey = nextRainKey;

  if (runtime.rainLayer) {
    runtime.scene.remove(runtime.rainLayer.lines);
    disposeObject(runtime.rainLayer.lines);
    runtime.rainLayer = null;
  }

  if (!isActiveRainWeather(weather)) return;
  const layer = createRainLayer(snapshot.map, weather, mobileLike);
  runtime.rainLayer = layer;
  runtime.scene.add(layer.lines);
};

const updateWallCastShadowDirection = (runtime: Runtime, map: ArenaMapConfig): { x: number; y: number } => {
  const fromLightToArena = new THREE.Vector2(
    runtime.keyLightTarget.position.x - runtime.keyLight.position.x,
    runtime.keyLightTarget.position.z - runtime.keyLight.position.z
  ).normalize();
  const distance =
    runtime.lightingMode === "evening"
      ? WALL_CAST_SHADOW_DISTANCE * 1.28
      : runtime.lightingMode === "moon"
        ? WALL_CAST_SHADOW_DISTANCE * 0.92
        : WALL_CAST_SHADOW_DISTANCE;
  const offset = {
    x: Math.round(fromLightToArena.x * distance),
    y: Math.round(fromLightToArena.y * distance)
  };

  runtime.wallLayer.traverse((object) => {
    if (!object.userData.alpha7WallCastShadow) return;
    object.position.x = offset.x;
    object.position.z = offset.y;
  });

  return offset;
};

const applyLightingForSnapshot = (runtime: Runtime, snapshot: ClientSnapshot): void => {
  const map = snapshot.map;
  const seed = snapshot.seed || map.id || "alpha7";
  const preset = lightingPresetForSeed(seed, runtime.forcedLightingMode);
  const weather = readMapWeather(map);
  const rainIntensity = isActiveRainWeather(weather) ? weather.intensity : 0;
  const mobileLike = isMobileLikeViewport();
  const key =
    `${seed}:${map.width}:${map.height}:${preset.mode}:${runtime.shadowEnabled}:` +
    `${runtime.forcedLightingMode ?? "auto"}:${rainIntensity.toFixed(3)}:${mobileLike ? "m" : "d"}`;
  if (runtime.lightingKey === key) return;

  runtime.lightingMode = preset.mode;
  runtime.lightingKey = key;
  const rainMix = rainIntensity * 0.18;
  const keyColor = new THREE.Color(preset.keyColor).lerp(new THREE.Color(0xdce1e4), rainMix);
  const skyColor = new THREE.Color(preset.skyColor).lerp(new THREE.Color(0xc6ced1), rainMix);
  const groundColor = new THREE.Color(preset.groundColor).lerp(new THREE.Color(0x6f7473), rainMix);
  const clearColor = new THREE.Color(preset.clearColor).lerp(new THREE.Color(0x707677), rainMix);
  const fogColor = new THREE.Color(preset.fogColor).lerp(new THREE.Color(0x707677), rainMix);
  runtime.keyLight.color.copy(keyColor);
  runtime.keyLight.intensity = preset.keyIntensity * (1 - rainIntensity * 0.12);
  runtime.fillLight.color.copy(skyColor);
  runtime.fillLight.groundColor.copy(groundColor);
  runtime.fillLight.intensity = preset.fillIntensity * (1 - rainIntensity * 0.04);
  runtime.renderer.toneMappingExposure =
    (preset.mode === "evening" ? 1.08 : preset.mode === "moon" ? 1.11 : 1.13) *
    (mobileLike ? 0.98 : 1) *
    (1 - rainIntensity * 0.03);
  runtime.renderer.setClearColor(clearColor, 1);
  runtime.scene.background = clearColor;
  runtime.scene.fog = mobileLike ? null : new THREE.Fog(fogColor, 1700, 3100);

  const centerX = map.width / 2;
  const centerZ = map.height / 2;
  const maxDim = Math.max(map.width, map.height);
  const direction =
    preset.mode === "evening"
      ? { x: 0.68, y: 0.38, z: 0.3 }
      : preset.mode === "moon"
        ? { x: 0.5, y: 0.7, z: 0.52 }
        : { x: 0.54, y: 0.64, z: 0.46 };
  runtime.keyLightTarget.position.set(centerX, 0, centerZ);
  runtime.keyLight.position.set(
    centerX - maxDim * direction.x,
    maxDim * direction.y,
    centerZ + maxDim * direction.z
  );
  runtime.keyLight.target = runtime.keyLightTarget;

  runtime.keyLight.castShadow = runtime.shadowEnabled;
  runtime.keyLight.shadow.mapSize.set(1024, 1024);
  const shadowCamera = runtime.keyLight.shadow.camera as THREE.OrthographicCamera;
  const padding = clamp(maxDim * 0.16, 220, 520);
  const halfSpan = Math.max(map.width, map.height) / 2 + padding;
  shadowCamera.left = -halfSpan;
  shadowCamera.right = halfSpan;
  shadowCamera.top = halfSpan;
  shadowCamera.bottom = -halfSpan;
  shadowCamera.near = 40;
  shadowCamera.far = maxDim * 2.2;
  shadowCamera.updateProjectionMatrix();
  updateWallCastShadowDirection(runtime, map);
};

const pickupColor = (pickupType: ClientPickup["pickupType"]): number => {
  switch (PICKUP_CONFIG[pickupType].effect) {
    case "repair":
      return COLORS.success;
    case "armor":
      return COLORS.blue;
    case "ammo":
      return COLORS.accent;
    case "speed":
      return COLORS.warning;
    case "ability":
      return COLORS.white;
    case "smoke":
      return COLORS.ink;
    default:
      return COLORS.danger;
  }
};

const createPickupMesh = (pickup: ClientPickup): PickupVisual => {
  const color = pickupColor(pickup.pickupType);
  const group = new THREE.Group();

  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(Math.max(8, pickup.radius * 0.38), 0),
    new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color).multiplyScalar(0.18),
      roughness: 0.4,
      metalness: 0.15
    })
  );
  core.position.y = 18;
  group.add(core);

  return {
    group,
    core,
    bobOffset: Math.random() * Math.PI * 2,
    spinSpeed: 0.6 + Math.random() * 0.55,
    pickupType: pickup.pickupType
  };
};

const createTankMesh = (player: ClientPlayer): TankParts => {
  const isSelf = player.isSelf;
  const config = TANK_ARCHETYPE_CONFIG[player.archetypeId];
  const visual = TANK_VISUAL_CONFIG[player.archetypeId];
  const shieldY = Math.max(4.8, visual.bodyY - visual.bodySize[1] / 2 - 1.2);
  const turretY = tankTurretY(visual);
  const barrelBaseOffset = tankBarrelBaseOffset(visual);
  const group = new THREE.Group();
  const contactShadowMap = createTankShadowTexture().clone();
  contactShadowMap.needsUpdate = true;

  const contactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(136, 92),
    new THREE.MeshBasicMaterial({
      map: contactShadowMap,
      transparent: true,
      opacity: TANK_CONTACT_SHADOW_OPACITY,
      depthWrite: false
    })
  );
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.y = 1.2;
  group.add(contactShadow);

  const shieldGlow = new THREE.Mesh(
    new THREE.RingGeometry(44, 88, 64),
    new THREE.MeshBasicMaterial({
      color: COLORS.blue,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    })
  );
  shieldGlow.rotation.x = -Math.PI / 2;
  shieldGlow.position.y = shieldY;
  shieldGlow.visible = false;
  shieldGlow.renderOrder = 3;
  group.add(shieldGlow);

  const shieldRing = new THREE.Mesh(
    new THREE.RingGeometry(58, 70, 64),
    new THREE.MeshBasicMaterial({
      color: COLORS.blue,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    })
  );
  shieldRing.rotation.x = -Math.PI / 2;
  shieldRing.position.y = shieldY + 0.18;
  shieldRing.visible = false;
  shieldRing.renderOrder = 4;
  group.add(shieldRing);

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(...visual.bodySize),
    new THREE.MeshStandardMaterial({ color: visual.hullColor, roughness: 0.72, metalness: 0.04 })
  );
  body.position.y = visual.bodyY;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const leftTrack = new THREE.Mesh(
    new THREE.BoxGeometry(...visual.trackSize),
    new THREE.MeshStandardMaterial({ color: visual.trackColor, roughness: 0.9 })
  );
  leftTrack.position.set(0, visual.trackY, -visual.trackOffset);
  leftTrack.castShadow = true;
  leftTrack.receiveShadow = true;
  group.add(leftTrack);

  const rightTrack = leftTrack.clone();
  rightTrack.position.z = visual.trackOffset;
  group.add(rightTrack);

  const turret = new THREE.Group();
  turret.position.y = turretY;
  const turretBase = new THREE.Mesh(
    new THREE.BoxGeometry(...visual.turretSize),
    new THREE.MeshStandardMaterial({ color: visual.turretColor, roughness: 0.68 })
  );
  turretBase.castShadow = true;
  turretBase.receiveShadow = true;
  turret.add(turretBase);

  const mantlet = new THREE.Mesh(
    new THREE.BoxGeometry(6, visual.barrelThickness + 5, visual.barrelThickness + 8),
    new THREE.MeshStandardMaterial({ color: visual.turretColor, roughness: 0.7, metalness: 0.04 })
  );
  mantlet.position.x = visual.turretSize[0] / 2 - 1;
  mantlet.castShadow = true;
  turret.add(mantlet);

  const barrel = new THREE.Mesh(
    new THREE.BoxGeometry(1, visual.barrelThickness, visual.barrelThickness),
    new THREE.MeshStandardMaterial({ color: visual.turretColor, roughness: 0.62, metalness: 0.08 })
  );
  barrel.scale.x = TANK_BARREL_MAX_LENGTH;
  barrel.position.x = barrelBaseOffset + TANK_BARREL_MAX_LENGTH / 2;
  barrel.castShadow = true;
  turret.add(barrel);
  const muzzle = new THREE.Mesh(
    new THREE.BoxGeometry(TANK_MUZZLE_SIZE, TANK_MUZZLE_SIZE, TANK_MUZZLE_SIZE),
    new THREE.MeshStandardMaterial({ color: isSelf ? COLORS.accent : COLORS.accentHot, roughness: 0.42 })
  );
  muzzle.position.x = barrelBaseOffset + TANK_BARREL_MAX_LENGTH + TANK_MUZZLE_SIZE / 2;
  turret.add(muzzle);
  group.add(turret);

  const pose = {
    x: player.x,
    y: player.y,
    rotation: player.rotation,
    turretRotation: player.turretRotation,
    velocityX: player.velocityX,
    velocityY: player.velocityY
  };

  group.userData.tankName = `${config.name} ${player.name}`;
  return {
    group,
    turret,
    barrel,
    muzzle,
    barrelBaseOffset,
    shieldGlow,
    shieldRing,
    target: { ...pose },
    current: { ...pose },
    isSelf,
    archetypeId: player.archetypeId,
    shield: player.shield,
    hitAt: Number.NEGATIVE_INFINITY,
    hitRotation: 0,
    hitStrength: 0
  };
};

const updateCamera = (
  runtime: Runtime,
  canvas: HTMLCanvasElement,
  map: ArenaMapConfig,
  focus?: Pick<LocalPose, "x" | "y">
): void => {
  const rect = canvas.getBoundingClientRect();
  const aspect = Math.max(0.35, rect.width / Math.max(1, rect.height));
  const baseHeight = aspect < 0.75 ? CAMERA_PORTRAIT_FRAME_HEIGHT : CAMERA_LANDSCAPE_FRAME_HEIGHT;
  const mapScaledHeight = map.height * 0.96;
  const height = focus
    ? Math.max(baseHeight, Math.min(mapScaledHeight, CAMERA_MAX_FOCUSED_FRAME_HEIGHT))
    : Math.max(mapScaledHeight, baseHeight);
  const center = focus ?? { x: map.width / 2, y: map.height / 2 };
  runtime.camera.left = (-height * aspect) / 2;
  runtime.camera.right = (height * aspect) / 2;
  runtime.camera.top = height / 2;
  runtime.camera.bottom = -height / 2;
  runtime.camera.zoom = CAMERA_ZOOM;
  runtime.camera.near = 1;
  runtime.camera.far = 4000;
  const orbitX = Math.sin(runtime.cameraOrbitAngle) * CAMERA_DISTANCE;
  const orbitZ = Math.cos(runtime.cameraOrbitAngle) * CAMERA_DISTANCE;
  runtime.camera.position.set(center.x + orbitX, CAMERA_HEIGHT, center.y + orbitZ);
  runtime.camera.lookAt(center.x, 0, center.y);
  runtime.camera.updateProjectionMatrix();
  const nextWidth = Math.max(1, Math.round(rect.width));
  const nextHeight = Math.max(1, Math.round(rect.height));
  const nextPixelRatio = Math.min(isMobileLikeViewport() ? 1 : 1.5, window.devicePixelRatio || 1);
  if (
    runtime.renderWidth !== nextWidth ||
    runtime.renderHeight !== nextHeight ||
    runtime.pixelRatio !== nextPixelRatio
  ) {
    runtime.renderWidth = nextWidth;
    runtime.renderHeight = nextHeight;
    runtime.pixelRatio = nextPixelRatio;
    runtime.renderer.setPixelRatio(nextPixelRatio);
    runtime.renderer.setSize(nextWidth, nextHeight, false);
  }
};

const updateCameraControlBasis = (runtime: Runtime, dt: number): void => {
  const next = stepCameraOrbit(
    runtime.cameraOrbitAngle,
    runtime.cameraOrbitPendingDelta,
    frameRateIndependentLerp(0.22, dt)
  );
  runtime.cameraOrbitAngle = next.angle;
  runtime.cameraOrbitPendingDelta = next.pendingDelta;
};

const cameraFocus = (
  runtime: Runtime,
  snapshot: ClientSnapshot,
  localPose: LocalPose,
  playerId: string | null
): Pick<LocalPose, "x" | "y"> => {
  if (!playerId) return localPose;
  const player = snapshot.players.find((candidate) => candidate.sessionId === playerId);
  if (
    !player ||
    !player.isAlive ||
    !player.isConnected ||
    player.isSpectator ||
    (isPlayerConcealedBySmoke(player, snapshotServerNow(snapshot)) &&
      !isOwnedAlly(snapshot, player))
  ) {
    return localPose;
  }
  const parts = runtime.tankMeshes.get(playerId);
  return parts?.group.visible ? parts.current : player;
};

const rebuildMap = (
  runtime: Runtime,
  snapshot: ClientSnapshot,
  floorPreviewTextureId: FloorPreviewTextureId | null,
  wallPreviewTextureId: WallPreviewTextureId | null
): void => {
  const map = snapshot.map;
  runtime.mapKey = mapKey(map, floorPreviewTextureId, wallPreviewTextureId);

  while (runtime.wallLayer.children.length > 0) {
    const child = runtime.wallLayer.children[0];
    if (!child) break;
    runtime.wallLayer.remove(child);
    disposeObject(child);
  }

  const ground = createGround(map, floorPreviewTextureId);
  runtime.wallLayer.add(ground);
  runtime.wallLayer.add(createBoundaryBarrier(map));
  const wallMaterialId = wallPreviewTextureId ?? CANONICAL_WALL_MATERIAL;
  const visibleWalls = map.walls.filter((item) => !isOuterBoundaryWall(item, map));
  for (const wall of visibleWalls) {
    runtime.wallLayer.add(createWallMesh(wall, wallMaterialId, visibleWalls));
  }
  runtime.wallLayer.add(createWallJunctionCaps(visibleWalls, wallMaterialId));
  runtime.lightingKey = "";
};

const segmentExpandedWallHitT = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  wall: ArenaWall,
  radius: number
): number | undefined => {
  const minX = wall.x - wall.width / 2 - radius;
  const minY = wall.y - wall.height / 2 - radius;
  const maxX = wall.x + wall.width / 2 + radius;
  const maxY = wall.y + wall.height / 2 + radius;
  const dx = bx - ax;
  const dy = by - ay;
  let tMin = 0;
  let tMax = 1;

  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > tMax) return false;
      if (t > tMin) tMin = t;
    } else {
      if (t < tMin) return false;
      if (t < tMax) tMax = t;
    }
    return true;
  };

  if (
    !clip(-dx, ax - minX) ||
    !clip(dx, maxX - ax) ||
    !clip(-dy, ay - minY) ||
    !clip(dy, maxY - ay)
  ) {
    return undefined;
  }

  return clamp(tMin, 0, 1);
};

const visibleTankBarrelLength = (
  pose: LocalPose,
  map?: ArenaMapConfig,
  barrelBaseOffset = TANK_BARREL_BASE_OFFSET
): number => {
  const dirX = Math.cos(pose.turretRotation);
  const dirY = Math.sin(pose.turretRotation);
  const maxTipDistance =
    barrelBaseOffset + TANK_BARREL_MAX_LENGTH + TANK_MUZZLE_SIZE / 2;
  let nearestTipDistance = maxTipDistance;
  const bx = pose.x + dirX * maxTipDistance;
  const by = pose.y + dirY * maxTipDistance;

  if (!map) return TANK_BARREL_MAX_LENGTH;

  for (const wall of map.walls) {
    if (isOuterBoundaryWall(wall, map)) continue;
    const hitT = segmentExpandedWallHitT(
      pose.x,
      pose.y,
      bx,
      by,
      wall,
      TANK_MUZZLE_SIZE / 2
    );
    if (hitT === undefined) continue;
    nearestTipDistance = Math.min(nearestTipDistance, hitT * maxTipDistance - TANK_MUZZLE_CLEARANCE);
  }

  const safeTipDistance = clamp(
    nearestTipDistance,
    barrelBaseOffset + TANK_BARREL_MIN_LENGTH + TANK_MUZZLE_SIZE / 2,
    maxTipDistance
  );

  return clamp(
    safeTipDistance - barrelBaseOffset - TANK_MUZZLE_SIZE / 2,
    TANK_BARREL_MIN_LENGTH,
    TANK_BARREL_MAX_LENGTH
  );
};

const visualMuzzlePosition = (
  pose: LocalPose,
  map?: ArenaMapConfig,
  extraOffset = 4,
  barrelBaseOffset = TANK_BARREL_BASE_OFFSET
): { x: number; y: number; dirX: number; dirY: number; offset: number } => {
  const dirX = Math.cos(pose.turretRotation);
  const dirY = Math.sin(pose.turretRotation);
  const barrelLength = map ? visibleTankBarrelLength(pose, map, barrelBaseOffset) : TANK_BARREL_MAX_LENGTH;
  const offset = barrelBaseOffset + barrelLength + TANK_MUZZLE_SIZE + extraOffset;
  return {
    x: pose.x + dirX * offset,
    y: pose.y + dirY * offset,
    dirX,
    dirY,
    offset
  };
};

const renderedTankMuzzleWorldPosition = (
  parts: TankParts,
  extraOffset = 1,
  verticalOffset = TANK_PROJECTILE_SOCKET_Y_OFFSET
): MuzzleSocket => {
  parts.group.updateWorldMatrix(true, true);
  const muzzleFront = new THREE.Vector3(
    parts.muzzle.position.x + TANK_MUZZLE_SIZE / 2 + extraOffset,
    verticalOffset,
    0
  );
  const direction = new THREE.Vector3(1, 0, 0)
    .applyQuaternion(parts.turret.getWorldQuaternion(new THREE.Quaternion()))
    .normalize();
  return {
    position: parts.turret.localToWorld(muzzleFront),
    angle: Math.atan2(direction.z, direction.x)
  };
};

const segmentCircleEntryT = (
  centerX: number,
  centerY: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number
): number | undefined => {
  const offsetX = ax - centerX;
  const offsetY = ay - centerY;
  const radiusSquared = radius * radius;
  if (offsetX * offsetX + offsetY * offsetY <= radiusSquared) return 0;

  const dx = bx - ax;
  const dy = by - ay;
  const a = dx * dx + dy * dy;
  if (a <= Number.EPSILON) return undefined;
  const b = offsetX * dx + offsetY * dy;
  if (b >= 0) return undefined;
  const discriminant = b * b - a * (offsetX * offsetX + offsetY * offsetY - radiusSquared);
  if (discriminant < 0) return undefined;
  const t = (-b - Math.sqrt(discriminant)) / a;
  return t >= 0 && t <= 1 ? t : undefined;
};

const projectileContactPosition = (
  position: THREE.Vector3,
  nextPosition: THREE.Vector3,
  velocityX: number,
  velocityY: number,
  radius: number,
  leadDistance: number,
  ownerId: string | undefined,
  snapshot: ClientSnapshot
): THREE.Vector3 | null => {
  const map = snapshot.map;
  const speed = Math.hypot(velocityX, velocityY);
  if (speed <= Number.EPSILON) return null;
  const dirX = velocityX / speed;
  const dirY = velocityY / speed;
  const ax = position.x + dirX * leadDistance;
  const ay = position.z + dirY * leadDistance;
  const bx = nextPosition.x + dirX * leadDistance;
  const by = nextPosition.z + dirY * leadDistance;
  let nearestT: number | undefined;

  if (bx < radius || bx > map.width - radius || by < radius || by > map.height - radius) {
    nearestT = 1;
  }

  for (const wall of map.walls) {
    const hitT = segmentExpandedWallHitT(ax, ay, bx, by, wall, radius);
    if (hitT === undefined) continue;
    if (nearestT === undefined || hitT < nearestT) nearestT = hitT;
  }

  for (const player of snapshot.players) {
    if (
      player.sessionId === ownerId ||
      !player.isAlive ||
      player.isSpectator
    ) {
      continue;
    }
    const hitT = segmentCircleEntryT(
      player.x,
      player.y,
      ax,
      ay,
      bx,
      by,
      TANK_COLLISION_RADIUS + radius
    );
    if (hitT === undefined) continue;
    if (nearestT === undefined || hitT < nearestT) nearestT = hitT;
  }

  if (nearestT === undefined) return null;
  const centerX = ax + (bx - ax) * nearestT;
  const centerY = ay + (by - ay) * nearestT;
  return new THREE.Vector3(
    centerX - dirX * leadDistance,
    TANK_PROJECTILE_VISUAL_Y,
    centerY - dirY * leadDistance
  );
};

const predictedShotContact = (
  particle: Particle,
  snapshot: ClientSnapshot,
  nextPosition: THREE.Vector3
): THREE.Vector3 | null => {
  if (!particle.predictedShot || particle.kind !== "shot") return null;
  const leadDistance =
    typeof particle.mesh.userData.projectileLeadDistance === "number"
      ? particle.mesh.userData.projectileLeadDistance
      : projectileVisualLeadDistance(particle.radius);
  return projectileContactPosition(
    particle.mesh.position,
    nextPosition,
    particle.velocity.x,
    particle.velocity.z,
    particle.radius,
    leadDistance,
    snapshot.self?.sessionId,
    snapshot
  );
};

const applyLocalMovement = (
  pose: LocalPose,
  input: InputFrame,
  map: ArenaMapConfig,
  archetypeId: TankArchetypeId,
  speedMultiplier: number,
  dt: number,
  cameraOrbitAngle: number
): void => {
  const config = TANK_ARCHETYPE_CONFIG[archetypeId];
  const worldMove = controlMoveToWorldMove(input.moveX, input.moveY, cameraOrbitAngle);
  const step = integrateTankMovement({
    state: pose,
    input: { moveX: worldMove.x, moveY: worldMove.y },
    deltaSeconds: dt / 1000,
    maxSpeed: config.speed,
    handling: config.handling,
    speedMultiplier
  });
  const startX = pose.x;
  const startY = pose.y;

  pose.rotation = step.rotation;
  pose.velocityX = step.velocityX;
  pose.velocityY = step.velocityY;

  const resolved = resolvePredictedMovement(
    { x: startX, y: startY },
    step,
    TANK_RADIUS,
    map.width,
    map.height,
    map.walls
  );
  pose.x = resolved.x;
  pose.y = resolved.y;

  const seconds = Math.max(Math.min(dt / 1000, 0.1), 0.001);
  pose.velocityX = (pose.x - startX) / seconds;
  pose.velocityY = (pose.y - startY) / seconds;
};

const screenToWorld = (
  runtime: Runtime,
  canvas: HTMLCanvasElement,
  screenX: number,
  screenY: number
): THREE.Vector3 | null => {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = ((screenX - rect.left) / rect.width) * 2 - 1;
  const y = -(((screenY - rect.top) / rect.height) * 2 - 1);
  runtime.raycaster.setFromCamera(new THREE.Vector2(x, y), runtime.camera);
  const target = new THREE.Vector3();
  return runtime.raycaster.ray.intersectPlane(runtime.groundPlane, target) ?? null;
};

const updateAimFromScreen = (
  runtime: Runtime,
  canvas: HTMLCanvasElement,
  input: InputFrame,
  localPose: LocalPose
): void => {
  if (input.aimMode === "direction") {
    input.aimWorldX = localPose.x + input.aimDirX * 560;
    input.aimWorldY = localPose.y + input.aimDirY * 560;
    localPose.turretRotation = Math.atan2(input.aimDirY, input.aimDirX);
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const screenX = input.aimScreenX ?? rect.left + rect.width / 2 + 180;
  const screenY = input.aimScreenY ?? rect.top + rect.height / 2;
  const world = screenToWorld(runtime, canvas, screenX, screenY);
  if (!world) return;

  input.aimWorldX = world.x;
  input.aimWorldY = world.z;
  const dx = input.aimWorldX - localPose.x;
  const dy = input.aimWorldY - localPose.y;
  const length = Math.hypot(dx, dy);
  if (length > 0.001) {
    input.aimDirX = dx / length;
    input.aimDirY = dy / length;
  }
  localPose.turretRotation = Math.atan2(input.aimDirY, input.aimDirX);
};

const isRemoteTankConcealedBySmoke = (
  snapshot: ClientSnapshot,
  player: ClientPlayer,
  now: number
): boolean =>
  !player.isSelf &&
  player.isAlive &&
  player.isConnected &&
  !player.isSpectator &&
  isPlayerConcealedBySmoke(player, now) &&
  !isOwnedAlly(snapshot, player);

const updateTankTargets = (
  runtime: Runtime,
  snapshot: ClientSnapshot,
  localPose: LocalPose
): void => {
  const seen = new Set<string>();
  const now = snapshotServerNow(snapshot);

  snapshot.players.forEach((player, index) => {
    let parts = runtime.tankMeshes.get(player.sessionId);
    if (!parts || parts.isSelf !== player.isSelf || parts.archetypeId !== player.archetypeId) {
      if (parts) {
        runtime.tankLayer.remove(parts.group);
        disposeObject(parts.group);
      }
      parts = createTankMesh(player);
      runtime.tankMeshes.set(player.sessionId, parts);
      runtime.tankLayer.add(parts.group);
    }

    const spawn = spawnForIndex(snapshot.map, index);
    const serverHasPose = hasServerPose(player);
    const x = player.isSelf ? localPose.x : serverHasPose ? player.x : spawn.x;
    const y = player.isSelf ? localPose.y : serverHasPose ? player.y : spawn.y;
    const rotation = player.isSelf
      ? localPose.rotation
      : serverHasPose
        ? player.rotation
        : Math.atan2(-spawn.y, -spawn.x);
    const turretRotation = player.isSelf
      ? localPose.turretRotation
      : serverHasPose
        ? player.turretRotation
        : rotation;

    parts.target = {
      x,
      y,
      rotation,
      turretRotation,
      velocityX: player.isSelf ? localPose.velocityX : player.velocityX,
      velocityY: player.isSelf ? localPose.velocityY : player.velocityY
    };
    parts.shield = player.shield;
    const concealedBySmoke = isRemoteTankConcealedBySmoke(snapshot, player, now);
    parts.group.visible = player.isConnected && !player.isSpectator && !concealedBySmoke;
    parts.group.userData.concealedBySmoke = concealedBySmoke;
    seen.add(player.sessionId);
  });

  for (const [id, parts] of runtime.tankMeshes) {
    if (seen.has(id)) continue;
    runtime.tankLayer.remove(parts.group);
    disposeObject(parts.group);
    runtime.tankMeshes.delete(id);
  }
};

const renderTanks = (runtime: Runtime, dt: number, map?: ArenaMapConfig): void => {
  for (const parts of runtime.tankMeshes.values()) {
    const amount = parts.isSelf ? 1 : clamp(dt / 90, 0.12, 0.48);
    parts.current.x += (parts.target.x - parts.current.x) * amount;
    parts.current.y += (parts.target.y - parts.current.y) * amount;
    parts.current.rotation = lerpAngle(parts.current.rotation, parts.target.rotation, amount);
    parts.current.turretRotation = lerpAngle(parts.current.turretRotation, parts.target.turretRotation, amount);
    parts.current.velocityX += (parts.target.velocityX - parts.current.velocityX) * amount;
    parts.current.velocityY += (parts.target.velocityY - parts.current.velocityY) * amount;

    const barrelLength = visibleTankBarrelLength(parts.current, map, parts.barrelBaseOffset);
    parts.barrel.scale.x = barrelLength;
    parts.barrel.position.x = parts.barrelBaseOffset + barrelLength / 2;
    parts.muzzle.position.x = parts.barrelBaseOffset + barrelLength + TANK_MUZZLE_SIZE / 2;

    parts.group.position.copy(worldToThree(parts.current.x, parts.current.y));
    parts.group.rotation.y = -parts.current.rotation;
    const hitAge = runtime.visualTime - parts.hitAt;
    if (hitAge >= 0 && hitAge < 190) {
      const hitProgress = hitAge / 190;
      const kick = Math.sin(Math.PI * hitProgress) * (1 - hitProgress) * parts.hitStrength;
      parts.group.position.x -= Math.cos(parts.hitRotation) * kick;
      parts.group.position.z -= Math.sin(parts.hitRotation) * kick;
      parts.group.position.y += Math.sin(Math.PI * hitProgress) * Math.min(3.2, parts.hitStrength * 0.38);
      parts.group.rotation.z = Math.sin(Math.PI * hitProgress) * Math.min(0.045, parts.hitStrength * 0.005);
    } else {
      parts.group.rotation.z = 0;
    }
    parts.turret.rotation.y = -(parts.current.turretRotation - parts.current.rotation);
    const shieldRatio = clamp(parts.shield / 40, 0, 1);
    const shieldPulse = 0.95 + Math.sin(runtime.visualTime * 0.006) * 0.03;
    const glowMaterial = parts.shieldGlow.material as THREE.MeshBasicMaterial;
    const shieldMaterial = parts.shieldRing.material as THREE.MeshBasicMaterial;
    parts.shieldGlow.visible = shieldRatio > 0.01;
    parts.shieldRing.visible = shieldRatio > 0.01;
    glowMaterial.opacity = shieldRatio > 0 ? (0.04 + shieldRatio * 0.18) * shieldPulse : 0;
    shieldMaterial.opacity = shieldRatio > 0 ? (0.1 + shieldRatio * 0.32) * shieldPulse : 0;
    parts.shieldGlow.scale.setScalar(0.9 + shieldRatio * 0.18);
    parts.shieldRing.scale.setScalar(0.92 + shieldRatio * 0.12);
  }
};

const updateZone = (runtime: Runtime, snapshot: ClientSnapshot, time: number): void => {
  const radius = snapshot.zone.radius || snapshot.zone.targetRadius;
  const darknessMaterial = runtime.zoneDarkness.material as THREE.ShaderMaterial;
  const zoneUniforms = darknessMaterial.uniforms as {
    uCenter: THREE.IUniform<THREE.Vector2>;
    uRadius: THREE.IUniform<number>;
    uFeather: THREE.IUniform<number>;
    uOpacity: THREE.IUniform<number>;
    uTint: THREE.IUniform<THREE.Color>;
  };
  const mapExtent = Math.max(snapshot.map.width, snapshot.map.height) + 2800;

  runtime.zoneRing.visible = false;
  runtime.targetZoneRing.visible = false;
  runtime.zoneDarkness.visible = radius > 8;
  runtime.zoneDarkness.position.set(snapshot.map.width / 2, 92, snapshot.map.height / 2);
  runtime.zoneDarkness.scale.set(mapExtent, mapExtent, 1);

  zoneUniforms.uCenter.value.set(snapshot.zone.x, snapshot.zone.y);
  zoneUniforms.uRadius.value = radius;
  const darkness = zoneDarknessSettings(snapshot.matchState, radius, time);
  zoneUniforms.uFeather.value = darkness.feather;
  zoneUniforms.uOpacity.value = darkness.opacity;
  zoneUniforms.uTint.value.set(darkness.tint);
};

const updatePickups = (runtime: Runtime, snapshot: ClientSnapshot, time: number): void => {
  const activeIds = new Set<string>();
  const bobTime = time / 340;

  for (const pickup of snapshot.pickups.filter((item) => item.isActive).slice(0, 28)) {
    let visual = runtime.pickupMeshes.get(pickup.id);
    if (!visual || visual.pickupType !== pickup.pickupType) {
      if (visual) {
        runtime.pickupLayer.remove(visual.group);
        disposeObject(visual.group);
      }
      visual = createPickupMesh(pickup);
      runtime.pickupMeshes.set(pickup.id, visual);
      runtime.pickupLayer.add(visual.group);
    }

    visual.group.position.set(pickup.x, 0, pickup.y);
    visual.core.position.y = 28 + Math.sin(bobTime + visual.bobOffset) * 5.5;
    visual.group.rotation.y = bobTime * visual.spinSpeed;
    activeIds.add(pickup.id);
  }

  for (const [id, visual] of runtime.pickupMeshes) {
    if (activeIds.has(id)) continue;
    runtime.pickupLayer.remove(visual.group);
    disposeObject(visual.group);
    runtime.pickupMeshes.delete(id);
  }
};

const projectileColor = (weaponType: ClientPlayer["weaponType"]): number => {
  switch (weaponType) {
    case "machine_gun":
      return COLORS.warning;
    case "explosive":
      return COLORS.warning;
    case "light_cannon":
      return COLORS.accent;
    default:
      return COLORS.accentHot;
  }
};

const projectileVisualLeadDistance = (radius: number): number => Math.max(radius + 4, radius * 1.75);
const PREDICTED_SHOT_TIMEOUT_MS = 520;

const setObjectOpacity = (object: THREE.Object3D, opacity: number): void => {
  object.traverse((child) => {
    const material = (child as THREE.Mesh).material;
    const apply = (item: THREE.Material): void => {
      const baseOpacity =
        typeof item.userData.alpha7BaseOpacity === "number"
          ? item.userData.alpha7BaseOpacity
          : typeof item.opacity === "number"
            ? item.opacity
            : 1;
      item.userData.alpha7BaseOpacity = baseOpacity;
      item.transparent = true;
      item.opacity = baseOpacity * opacity;
    };
    if (Array.isArray(material)) {
      for (const item of material) apply(item);
    } else if (material) {
      apply(material);
    }
  });
};

const createProjectileStreak = (
  weaponType: ClientPlayer["weaponType"],
  radius: number,
  color: number
): THREE.Group => {
  const group = new THREE.Group();
  const leadDistance = projectileVisualLeadDistance(radius);
  group.userData.projectileLeadDistance = leadDistance;
  const rapid = weaponType === "machine_gun";
  const explosive = weaponType === "explosive";
  const light = weaponType === "light_cannon";
  const coreLength = radius * (rapid ? 2.2 : explosive ? 2.8 : 2.65);
  const trailLength = leadDistance * (rapid ? 0.9 : explosive ? 1.35 : light ? 1.12 : 1.2);

  const glow = new THREE.Mesh(
    new THREE.CylinderGeometry(
      radius * (rapid ? 0.3 : 0.5),
      radius * (rapid ? 0.48 : explosive ? 0.9 : 0.72),
      coreLength * 1.18,
      10
    ),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: rapid ? 0.28 : explosive ? 0.44 : 0.36,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  glow.rotation.z = Math.PI / 2;
  glow.position.x = leadDistance - radius * 0.28;
  group.add(glow);

  const hotCore = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.17, radius * 0.28, coreLength, 10),
    new THREE.MeshBasicMaterial({
      color: COLORS.white,
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  hotCore.rotation.z = Math.PI / 2;
  hotCore.position.x = leadDistance - radius * 0.18;
  group.add(hotCore);

  const nose = new THREE.Mesh(
    explosive
      ? new THREE.SphereGeometry(radius * 0.72, 12, 8)
      : new THREE.ConeGeometry(radius * (rapid ? 0.42 : 0.62), radius * (rapid ? 1.2 : 1.7), 12),
    new THREE.MeshBasicMaterial({
      color: explosive ? COLORS.warning : color,
      transparent: true,
      opacity: explosive ? 0.88 : 0.92,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  if (!explosive) nose.rotation.z = -Math.PI / 2;
  nose.position.x = leadDistance + radius * (explosive ? 0.22 : 0.56);
  group.add(nose);

  const trail = new THREE.Mesh(
    new THREE.CylinderGeometry(
      radius * (rapid ? 0.07 : 0.1),
      radius * (rapid ? 0.2 : explosive ? 0.4 : 0.28),
      trailLength,
      8
    ),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: rapid ? 0.42 : explosive ? 0.28 : 0.36,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  trail.rotation.z = Math.PI / 2;
  trail.position.x = trailLength * 0.5;
  group.add(trail);

  const smoke = new THREE.Mesh(
    new THREE.BoxGeometry(trailLength * (explosive ? 0.92 : 0.62), radius * (explosive ? 0.46 : 0.25), radius * 0.3),
    new THREE.MeshBasicMaterial({
      color: COLORS.ink,
      transparent: true,
      opacity: rapid ? 0.05 : explosive ? 0.18 : 0.09,
      depthWrite: false
    })
  );
  smoke.position.x = trailLength * (explosive ? 0.36 : 0.3);
  smoke.position.y = explosive ? 1.1 : 0.6;
  group.add(smoke);

  const sparkCount = rapid ? 1 : explosive ? 5 : 3;
  for (let index = 0; index < sparkCount; index += 1) {
    const spark = new THREE.Mesh(
      new THREE.BoxGeometry(radius * (rapid ? 0.8 : 1.2), radius * 0.13, radius * 0.13),
      new THREE.MeshBasicMaterial({
        color: COLORS.white,
        transparent: true,
        opacity: explosive ? 0.7 : 0.56,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    spark.position.set(
      leadDistance * (0.28 + index * 0.11),
      radius * (index % 2 === 0 ? 0.25 : -0.2),
      radius * (index % 3 === 0 ? 0.18 : -0.1)
    );
    spark.rotation.y = index % 2 === 0 ? 0.12 : -0.1;
    group.add(spark);
  }

  return group;
};

interface ImpactVisualOptions {
  radius: number;
  color: number;
  weaponType: ClientPlayer["weaponType"];
  reason: ProjectileImpactMessagePayload["reason"];
  rotation?: number;
  shieldHit?: boolean;
  destroyed?: boolean;
}

const createImpactBurst = (position: THREE.Vector3, options: ImpactVisualOptions): Particle => {
  const { radius, weaponType, reason } = options;
  const explosive = weaponType === "explosive" || options.destroyed === true;
  const rapid = weaponType === "machine_gun";
  const rangedOut = reason === "range" && !explosive;
  const impactColor = options.shieldHit ? COLORS.blue : options.color;
  const group = new THREE.Group();
  group.position.copy(position);
  group.position.y = Math.max(position.y, reason === "tank" ? 26 : 13);
  if (typeof options.rotation === "number") group.rotation.y = -options.rotation;

  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(rapid ? 5 : 9, radius * (explosive ? 2.05 : 1.25)), 12, 8),
    new THREE.MeshBasicMaterial({
      color: COLORS.white,
      transparent: true,
      opacity: rapid ? 0.72 : 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  group.add(flash);

  const fire = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(rapid ? 7 : 12, radius * (explosive ? 3.5 : 1.85)), 14, 9),
    new THREE.MeshBasicMaterial({
      color: impactColor,
      transparent: true,
      opacity: rangedOut ? 0.22 : rapid ? 0.34 : explosive ? 0.68 : 0.48,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  group.add(fire);

  const sparkCount = rangedOut ? 3 : rapid ? 4 : explosive ? 14 : reason === "tank" ? 10 : 7;
  for (let index = 0; index < sparkCount; index += 1) {
    const angle = (index / sparkCount) * Math.PI * 2 + (index % 2 === 0 ? 0.08 : -0.06);
    const sparkLength = Math.max(rapid ? 9 : 16, radius * (explosive ? 4.2 : 2.7)) * (0.7 + (index % 4) * 0.12);
    const spark = new THREE.Mesh(
      new THREE.BoxGeometry(sparkLength, rapid ? 1.1 : 1.8, rapid ? 1.1 : 1.8),
      new THREE.MeshBasicMaterial({
        color: index % 3 === 0 ? COLORS.white : impactColor,
        transparent: true,
        opacity: rapid ? 0.7 : 0.88,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    spark.position.set(Math.cos(angle) * radius * 1.25, 1.5 + (index % 3) * 1.3, Math.sin(angle) * radius * 1.25);
    spark.rotation.y = -angle;
    group.add(spark);
  }

  if ((reason === "wall" || explosive) && !rangedOut) {
    const dust = new THREE.Mesh(
      new THREE.RingGeometry(
        Math.max(rapid ? 8 : 16, radius * (explosive ? 2.4 : 1.8)),
        Math.max(rapid ? 12 : 24, radius * (explosive ? 4.8 : 3.1)),
        28
      ),
      new THREE.MeshBasicMaterial({
        color: COLORS.ink,
        transparent: true,
        opacity: explosive ? 0.3 : 0.18,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    dust.rotation.x = -Math.PI / 2;
    dust.position.y = reason === "tank" ? -20 : -9;
    group.add(dust);
  }

  if (explosive) {
    for (let index = 0; index < 5; index += 1) {
      const angle = (index / 5) * Math.PI * 2;
      const smoke = new THREE.Mesh(
        new THREE.SphereGeometry(radius * (1.5 + (index % 3) * 0.38), 10, 7),
        new THREE.MeshBasicMaterial({
          color: index % 2 === 0 ? 0x34312e : 0x56514b,
          transparent: true,
          opacity: 0.34,
          depthWrite: false
        })
      );
      smoke.position.set(Math.cos(angle) * radius * 2.1, radius * (1.1 + (index % 2) * 0.8), Math.sin(angle) * radius * 2.1);
      group.add(smoke);
    }
  }

  return {
    mesh: group,
    velocity: new THREE.Vector3(0, 0, 0),
    life: 0,
    maxLife: rangedOut ? 260 : rapid ? 240 : explosive ? 720 : reason === "tank" ? 430 : 480,
    kind: "burst",
    radius,
    baseScale: 1
  };
};

const spawnImpactBurst = (
  runtime: Runtime,
  position: THREE.Vector3,
  options: ImpactVisualOptions
): void => {
  const burst = createImpactBurst(position, options);
  runtime.particles.push(burst);
  runtime.projectileLayer.add(burst.mesh);
};

const abilityPulseScale = (abilityType: ClientPlayer["abilityType"] | undefined, t: number): number => {
  switch (abilityType) {
    case "smoke":
      return 0.72 + Math.min(1, t / 0.16) * 0.34;
    case "repair":
      return 0.9 + t * 0.65;
    case "speed_burst":
      return 0.85 + t * 0.5;
    case "barrage":
      return 0.9 + t * 0.45;
    case "shield_pulse":
      return 0.9 + t * 1.05;
    default:
      return 1 + t * 2.4;
  }
};

const abilityVisualDuration = (abilityType: ClientPlayer["abilityType"]): number =>
  abilityType === "smoke"
    ? ABILITY_CONFIG.smoke.durationMs
    : abilityType === "speed_burst"
      ? 520
      : 680;

const createMuzzleFlash = (
  pose: LocalPose,
  input: InputFrame,
  weaponType: ClientPlayer["weaponType"] = "cannon",
  map?: ArenaMapConfig,
  muzzleOverride?: MuzzleSocket
): Particle => {
  const color = projectileColor(weaponType);
  const rapid = weaponType === "machine_gun";
  const explosive = weaponType === "explosive";
  const dirX = Number.isFinite(input.aimDirX) ? input.aimDirX : Math.cos(pose.turretRotation);
  const dirY = Number.isFinite(input.aimDirY) ? input.aimDirY : Math.sin(pose.turretRotation);
  const muzzle = visualMuzzlePosition({ ...pose, turretRotation: Math.atan2(dirY, dirX) }, map, 1);
  const group = new THREE.Group();
  group.position.copy(muzzleOverride?.position ?? new THREE.Vector3(muzzle.x, TANK_PROJECTILE_VISUAL_Y, muzzle.y));
  group.rotation.y = -(muzzleOverride?.angle ?? Math.atan2(dirY, dirX));

  const flash = new THREE.Mesh(
    new THREE.ConeGeometry(rapid ? 3.4 : explosive ? 7.2 : 5.4, rapid ? 9 : explosive ? 18 : 14, 10),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: rapid ? 0.58 : 0.72,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  flash.rotation.z = -Math.PI / 2;
  flash.position.x = rapid ? 3.2 : 5;
  group.add(flash);

  const crossFlash = flash.clone();
  crossFlash.rotation.x = Math.PI / 2;
  crossFlash.scale.set(0.72, 1.1, 0.5);
  group.add(crossFlash);

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(rapid ? 2.4 : explosive ? 5.2 : 3.5, 10, 8),
    new THREE.MeshBasicMaterial({
      color: COLORS.white,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  group.add(core);

  if (!rapid) {
    const smoke = new THREE.Mesh(
      new THREE.SphereGeometry(explosive ? 6 : 4.2, 9, 6),
      new THREE.MeshBasicMaterial({
        color: COLORS.ink,
        transparent: true,
        opacity: explosive ? 0.24 : 0.14,
        depthWrite: false
      })
    );
    smoke.position.set(-4, 3, 0);
    group.add(smoke);
  }

  return {
    mesh: group,
    velocity: new THREE.Vector3(0, 0, 0),
    life: 0,
    maxLife: rapid ? 82 : explosive ? 138 : 112,
    kind: "burst",
    radius: 5,
    baseScale: rapid ? 0.45 : 0.58
  };
};

const createPredictedShot = (
  pose: LocalPose,
  input: InputFrame,
  weaponType: ClientPlayer["weaponType"],
  fireSequence: number,
  muzzleOverride?: MuzzleSocket
): Particle => {
  const radius =
    weaponType === "machine_gun" ? 4 : weaponType === "light_cannon" ? 6 : weaponType === "explosive" ? 10 : 8;
  const angle = muzzleOverride?.angle ?? Math.atan2(input.aimDirY, input.aimDirX);
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const mesh = createProjectileStreak(weaponType, radius, projectileColor(weaponType));
  mesh.position.copy(
    muzzleOverride?.position ??
      new THREE.Vector3(pose.x + dirX * 48, TANK_PROJECTILE_VISUAL_Y, pose.y + dirY * 48)
  );
  mesh.rotation.y = -angle;
  return {
    mesh,
    velocity: new THREE.Vector3(
      dirX * WEAPON_CONFIG[weaponType].projectileSpeed,
      0,
      dirY * WEAPON_CONFIG[weaponType].projectileSpeed
    ),
    life: 0,
    maxLife: PREDICTED_SHOT_TIMEOUT_MS,
    kind: "shot",
    radius,
    baseScale: 1,
    predictedShot: true,
    fireSequence
  };
};

const createAbilityParticle = (
  pose: LocalPose,
  abilityType: ClientPlayer["abilityType"],
  initialLife = 0
): Particle => {
  const ability = ABILITY_CONFIG[abilityType];
  const group = new THREE.Group();
  group.position.set(pose.x, 8, pose.y);
  const effectColor =
    abilityType === "repair"
      ? COLORS.success
      : abilityType === "shield_pulse"
        ? COLORS.blue
        : abilityType === "speed_burst"
          ? COLORS.warning
          : abilityType === "barrage"
            ? COLORS.accentHot
            : COLORS.ink;
  const radius = Math.max(64, ability.radius || (abilityType === "speed_burst" ? 110 : 88));
  const addRing = (inner: number, outer: number, color: number = effectColor, opacity = 0.58): void => {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 64),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);
  };

  if (abilityType === "smoke") {
    const texture = createSmokeTexture();
    const random = createSeededRandom(`smoke:${Math.round(pose.x)}:${Math.round(pose.y)}`);
    const puffCount = isMobileLikeViewport() ? SMOKE_MOBILE_PUFF_COUNT : SMOKE_DESKTOP_PUFF_COUNT;
    const puffMaterials: [THREE.SpriteMaterial, THREE.SpriteMaterial] = [
      createSmokePuffMaterial(texture, 0x666b64, SMOKE_PUFF_OPACITY_MIN),
      createSmokePuffMaterial(
        texture,
        0x80847d,
        SMOKE_PUFF_OPACITY_MIN + SMOKE_PUFF_OPACITY_RANGE
      )
    ];
    for (let index = 0; index < puffCount; index += 1) {
      const angle = random() * Math.PI * 2;
      const distance = radius * Math.pow(random(), 1.28) * 0.78;
      const width = radius * (0.72 + random() * 0.56);
      const height = radius * (0.42 + random() * 0.25);
      const smoke = new THREE.Sprite(puffMaterials[random() > 0.52 ? 1 : 0]);
      smoke.position.set(
        Math.cos(angle) * distance,
        height * 0.56 + 2 + random() * 10,
        Math.sin(angle) * distance
      );
      smoke.scale.set(width, height, 1);
      smoke.renderOrder = 3 + index * 0.01;
      smoke.userData.alpha7Smoke = {
        x: smoke.position.x,
        y: smoke.position.y,
        z: smoke.position.z,
        width,
        height,
        driftX: (random() - 0.5) * radius * 0.18,
        driftZ: (random() - 0.5) * radius * 0.18,
        phase: random() * Math.PI * 2,
        lift: 12 + random() * 18
      };
      group.add(smoke);
    }
  } else if (abilityType === "repair") {
    addRing(46, 56, COLORS.success, 0.58);
    const barMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.success,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    group.add(
      new THREE.Mesh(new THREE.BoxGeometry(16, 2, 82), barMaterial),
      new THREE.Mesh(new THREE.BoxGeometry(82, 2, 16), barMaterial.clone())
    );
  } else if (abilityType === "speed_burst") {
    for (let index = 0; index < 3; index += 1) {
      const streak = new THREE.Mesh(
        new THREE.BoxGeometry(58 - index * 8, 2, 5),
        new THREE.MeshBasicMaterial({
          color: COLORS.warning,
          transparent: true,
          opacity: 0.82 - index * 0.12,
          depthWrite: false,
          blending: THREE.AdditiveBlending
        })
      );
      streak.rotation.y = -pose.rotation;
      streak.position.set(
        -Math.cos(pose.rotation) * (38 + index * 18),
        0,
        -Math.sin(pose.rotation) * (38 + index * 18)
      );
      group.add(streak);
    }
    addRing(50, 60, COLORS.warning, 0.5);
  } else if (abilityType === "barrage") {
    addRing(radius * 0.74, radius * 0.78, COLORS.accentHot, 0.48);
    addRing(radius * 0.38, radius * 0.42, COLORS.accentHot, 0.38);
    for (let index = 0; index < 4; index += 1) {
      const angle = (Math.PI / 2) * index;
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(radius * 0.38, 2, 4),
        new THREE.MeshBasicMaterial({
          color: COLORS.accentHot,
          transparent: true,
          opacity: 0.5,
          depthWrite: false
        })
      );
      line.rotation.y = angle;
      line.position.set(Math.cos(angle) * radius * 0.55, 0, -Math.sin(angle) * radius * 0.55);
      group.add(line);
    }
  } else {
    addRing(radius * 0.9, radius, COLORS.blue, 0.58);
    addRing(54, 68, COLORS.white, 0.22);
  }

  return {
    mesh: group,
    velocity: new THREE.Vector3(0, 0, 0),
    life: initialLife,
    maxLife: abilityVisualDuration(abilityType),
    kind: "pulse",
    radius,
    baseScale: 1,
    abilityType
  };
};

const syncAbilityActivations = (runtime: Runtime, snapshot: ClientSnapshot): void => {
  const wallClock = snapshotServerNow(snapshot);
  for (const player of snapshot.players) {
    const activations: Array<{
      key: string;
      type: ClientPlayer["abilityType"];
      at: number;
      x: number;
      y: number;
    }> = [];
    if (player.lastAbilityType !== "smoke") {
      activations.push({
        key: `${player.sessionId}:ability`,
        type: player.lastAbilityType,
        at: player.lastAbilityAt,
        x: player.lastAbilityX,
        y: player.lastAbilityY
      });
    }
    activations.push({
      key: `${player.sessionId}:smoke`,
      type: "smoke",
      at: player.smokeActivatedAt,
      x: player.smokeX,
      y: player.smokeY
    });

    for (const activation of activations) {
      if (
        activation.at <= 0 ||
        activation.at <= (runtime.seenAbilityActivations.get(activation.key) ?? 0)
      ) {
        continue;
      }
      runtime.seenAbilityActivations.set(activation.key, activation.at);

      const maxLife = abilityVisualDuration(activation.type);
      const elapsed = Math.max(0, wallClock - activation.at);
      if (elapsed >= maxLife) continue;

      const particle = createAbilityParticle(
        {
          x: activation.x,
          y: activation.y,
          rotation: player.rotation,
          turretRotation: player.turretRotation,
          velocityX: 0,
          velocityY: 0
        },
        activation.type,
        elapsed
      );
      runtime.particles.push(particle);
      runtime.projectileLayer.add(particle.mesh);
    }
  }
};

const updateSmokeParticle = (particle: Particle, t: number): void => {
  const swell = Math.sin(Math.min(1, t) * Math.PI);
  particle.mesh.children.forEach((child) => {
    const smoke = child.userData.alpha7Smoke as
      | {
          x: number;
          y: number;
          z: number;
          width: number;
          height: number;
          driftX: number;
          driftZ: number;
          phase: number;
          lift: number;
        }
      | undefined;
    if (!smoke) return;
    child.position.x = smoke.x + smoke.driftX * t + Math.sin(smoke.phase + t * Math.PI * 2) * 7 * swell;
    child.position.y = smoke.y + smoke.lift * t + Math.sin(smoke.phase + t * Math.PI * 1.4) * 3;
    child.position.z = smoke.z + smoke.driftZ * t + Math.cos(smoke.phase + t * Math.PI * 1.8) * 7 * swell;
    child.scale.set(smoke.width * (0.78 + t * 0.36), smoke.height * (0.78 + t * 0.18 + swell * 0.12), 1);
  });
};

const updateParticles = (runtime: Runtime, dt: number, snapshot: ClientSnapshot): void => {
  for (let index = runtime.particles.length - 1; index >= 0; index -= 1) {
    const particle = runtime.particles[index];
    if (!particle) continue;
    particle.life += dt;
    const t = clamp(particle.life / particle.maxLife, 0, 1);
    if (!particle.pendingContact) {
      const nextPosition = particle.mesh.position.clone().addScaledVector(particle.velocity, dt / 1000);
      const contactPosition = predictedShotContact(particle, snapshot, nextPosition);
      if (contactPosition) {
        particle.mesh.position.copy(contactPosition);
        particle.velocity.set(0, 0, 0);
        particle.pendingContact = true;
      } else {
        particle.mesh.position.copy(nextPosition);
      }
    }
    if (particle.kind === "pulse") {
      const opacity =
        particle.abilityType === "smoke"
          ? t < 0.78
            ? Math.min(1, t / 0.12)
            : 1 - (t - 0.78) / 0.22
          : 1 - t;
      if (particle.abilityType === "smoke") updateSmokeParticle(particle, t);
      setObjectOpacity(particle.mesh, opacity);
      particle.mesh.scale.setScalar(particle.baseScale * abilityPulseScale(particle.abilityType, t));
    } else if (particle.kind === "burst") {
      setObjectOpacity(particle.mesh, 0.86 * (1 - t));
      particle.mesh.scale.setScalar(particle.baseScale + t * 1.85);
    } else {
      setObjectOpacity(particle.mesh, particle.pendingContact ? 0.72 * (1 - t * 0.55) : 0.95);
      particle.mesh.scale.setScalar(particle.baseScale);
    }
    if (particle.life >= particle.maxLife) {
      runtime.projectileLayer.remove(particle.mesh);
      disposeObject(particle.mesh);
      runtime.particles.splice(index, 1);
    }
  }
};

const createServerProjectileMesh = (projectile: ClientSnapshot["projectiles"][number]): THREE.Object3D => {
  const color = projectileColor(projectile.weaponType);
  return createProjectileStreak(projectile.weaponType, Math.max(4, projectile.radius), color);
};

const updateServerProjectiles = (runtime: Runtime, snapshot: ClientSnapshot, dt: number): void => {
  const activeIds = new Set(snapshot.projectiles.map((projectile) => projectile.id));
  const renderedIds = new Set<string>();
  const visibleProjectiles = [...snapshot.projectiles]
    .sort((left, right) => {
      const leftSelf = left.ownerId === snapshot.self?.sessionId ? 1 : 0;
      const rightSelf = right.ownerId === snapshot.self?.sessionId ? 1 : 0;
      return rightSelf - leftSelf;
    })
    .slice(0, SERVER_PROJECTILE_RENDER_CAP);

  for (const projectile of visibleProjectiles) {
    if (runtime.resolvedProjectileIds.has(projectile.id)) continue;
    renderedIds.add(projectile.id);
    let mesh = runtime.serverProjectileMeshes.get(projectile.id);
    const isNew = !mesh;
    const isSelfProjectile = projectile.ownerId === snapshot.self?.sessionId;
    let predictedPosition: THREE.Vector3 | null = null;
    let predictedContact = false;
    if (!mesh) {
      mesh = createServerProjectileMesh(projectile);
      mesh.userData.birthTime = runtime.visualTime;
      runtime.serverProjectileMeshes.set(projectile.id, mesh);
      runtime.serverProjectileLayer.add(mesh);
      if (isSelfProjectile) {
        const predictedIndex = runtime.particles.findIndex(
          (particle) =>
            particle.predictedShot &&
            particle.fireSequence === projectile.fireSequence
        );
        const predicted = runtime.particles[predictedIndex];
        if (predicted) {
          predictedPosition = predicted.mesh.position.clone();
          predictedContact = predicted.pendingContact === true;
          runtime.projectileLayer.remove(predicted.mesh);
          disposeObject(predicted.mesh);
          runtime.particles.splice(predictedIndex, 1);
        }
      }
    }
    const projectilePosition = new THREE.Vector3(projectile.x, TANK_PROJECTILE_VISUAL_Y, projectile.y);
    const velocityLength = Math.hypot(projectile.velocityX, projectile.velocityY) || 1;
    const dirX = projectile.velocityX / velocityLength;
    const dirY = projectile.velocityY / velocityLength;
    const leadDistance =
      typeof mesh.userData.projectileLeadDistance === "number"
        ? mesh.userData.projectileLeadDistance
        : projectileVisualLeadDistance(projectile.radius);
    const projectileTailPosition = projectilePosition.clone().add(new THREE.Vector3(-dirX * leadDistance, 0, -dirY * leadDistance));
    const snapshotChanged =
      mesh.userData.snapshotX !== projectile.x || mesh.userData.snapshotY !== projectile.y;
    if (snapshotChanged) {
      mesh.userData.snapshotX = projectile.x;
      mesh.userData.snapshotY = projectile.y;
      mesh.userData.lastSnapshotTime = runtime.visualTime;
      mesh.userData.pendingContact = false;
    }
    const birthTime = typeof mesh.userData.birthTime === "number" ? mesh.userData.birthTime : runtime.visualTime;
    const owner = snapshot.players.find((player) => player.sessionId === projectile.ownerId);
    let visualAngle = Math.atan2(projectile.velocityY, projectile.velocityX);
    if (predictedPosition) {
      mesh.position.copy(predictedPosition);
      mesh.userData.pendingContact = predictedContact;
    } else if (owner && !isSelfProjectile && runtime.visualTime - birthTime < 80) {
      const ownerParts = runtime.tankMeshes.get(projectile.ownerId);
      const renderedMuzzle = ownerParts ? renderedTankMuzzleWorldPosition(ownerParts, 1) : null;
      const fallbackMuzzle = renderedMuzzle
        ? null
        : visualMuzzlePosition(
            owner,
            snapshot.map,
            1,
            tankBarrelBaseOffset(TANK_VISUAL_CONFIG[owner.archetypeId])
          );
      const muzzlePosition =
        renderedMuzzle?.position ??
        new THREE.Vector3(fallbackMuzzle?.x ?? owner.x, TANK_PROJECTILE_VISUAL_Y, fallbackMuzzle?.y ?? owner.y);
      if (renderedMuzzle) visualAngle = renderedMuzzle.angle;
      const t = clamp((runtime.visualTime - birthTime) / 80, 0, 1);
      mesh.position.copy(muzzlePosition.lerp(projectileTailPosition, t));
    } else if (isNew || snapshotChanged) {
      if (isSelfProjectile && !isNew) {
        const correction = projectileTailPosition.clone().sub(mesh.position);
        const forwardCorrection = correction.x * dirX + correction.z * dirY;
        if (forwardCorrection > 0) {
          mesh.position.lerp(projectileTailPosition, frameRateIndependentLerp(0.35, dt));
        }
      } else {
        mesh.position.copy(projectileTailPosition);
      }
    } else if (
      mesh.userData.pendingContact !== true &&
      runtime.visualTime - Number(mesh.userData.lastSnapshotTime ?? runtime.visualTime) <=
      PREDICTED_SHOT_TIMEOUT_MS
    ) {
      const nextPosition = mesh.position.clone();
      nextPosition.x += projectile.velocityX * (dt / 1000);
      nextPosition.z += projectile.velocityY * (dt / 1000);
      const contactPosition = projectileContactPosition(
        mesh.position,
        nextPosition,
        projectile.velocityX,
        projectile.velocityY,
        projectile.radius,
        leadDistance,
        projectile.ownerId,
        snapshot
      );
      mesh.position.copy(contactPosition ?? nextPosition);
      mesh.userData.pendingContact = contactPosition !== null;
    }
    mesh.rotation.y = -visualAngle;
  }

  for (const [id, mesh] of runtime.serverProjectileMeshes) {
    if (renderedIds.has(id)) continue;
    runtime.serverProjectileLayer.remove(mesh);
    disposeObject(mesh);
    runtime.serverProjectileMeshes.delete(id);
  }

  for (const [id, resolvedAt] of runtime.resolvedProjectileIds) {
    if (!shouldKeepResolvedProjectile(resolvedAt, runtime.visualTime, activeIds.has(id))) {
      runtime.resolvedProjectileIds.delete(id);
    }
  }
};

const handleProjectileImpact = (
  runtime: Runtime,
  snapshot: ClientSnapshot,
  impact: ProjectileImpactMessagePayload
): void => {
  runtime.resolvedProjectileIds.set(impact.projectileId, runtime.visualTime);
  runtime.lastImpact = impact;

  const serverMesh = runtime.serverProjectileMeshes.get(impact.projectileId);
  if (serverMesh) {
    runtime.serverProjectileLayer.remove(serverMesh);
    disposeObject(serverMesh);
    runtime.serverProjectileMeshes.delete(impact.projectileId);
  }

  if (impact.ownerId === snapshot.self?.sessionId) {
    const predictedIndex = runtime.particles.findIndex(
      (particle) =>
        particle.predictedShot &&
        particle.fireSequence === impact.fireSequence
    );
    const predicted = runtime.particles[predictedIndex];
    if (predicted) {
      runtime.projectileLayer.remove(predicted.mesh);
      disposeObject(predicted.mesh);
      runtime.particles.splice(predictedIndex, 1);
    }
  }

  const impactPosition = new THREE.Vector3(
    impact.x,
    impact.reason === "tank" ? TANK_PROJECTILE_VISUAL_Y : 14,
    impact.y
  );
  spawnImpactBurst(runtime, impactPosition, {
    radius: Math.max(4, impact.radius),
    color: projectileColor(impact.weaponType),
    weaponType: impact.weaponType,
    reason: impact.reason,
    rotation: impact.rotation,
    shieldHit: impact.shieldHit,
    destroyed: impact.destroyed
  });

  if (impact.targetSessionId) {
    const target = runtime.tankMeshes.get(impact.targetSessionId);
    if (target) {
      target.hitAt = runtime.visualTime;
      target.hitRotation = impact.rotation;
      target.hitStrength =
        impact.weaponType === "explosive" || impact.destroyed
          ? 9
          : impact.weaponType === "machine_gun"
            ? 2.8
            : 5.5;
    }
  }
};

export function ArenaRenderer({
  snapshot,
  authoritativeSnapshot,
  cameraFocusPlayerId = null,
  inputRef,
  aimSyncRef,
  fireSignal,
  fireSequenceRef,
  impactSignal,
  impactQueueRef,
  abilitySignal,
  onCameraOrbitAngle,
  onLocalPose
}: ArenaRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapshotRef = useRef(snapshot);
  const authoritativeSnapshotRef = useRef(authoritativeSnapshot);
  const cameraFocusPlayerIdRef = useRef(cameraFocusPlayerId);
  const runtimeRef = useRef<Runtime | null>(null);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  const localPoseRef = useRef<LocalPose>({
    x: snapshot.self?.x ?? 0,
    y: snapshot.self?.y ?? 0,
    rotation: 0,
    turretRotation: 0,
    velocityX: snapshot.self?.velocityX ?? 0,
    velocityY: snapshot.self?.velocityY ?? 0
  });

  useEffect(() => {
    snapshotRef.current = snapshot;
    authoritativeSnapshotRef.current = authoritativeSnapshot;
  }, [authoritativeSnapshot, snapshot]);

  useEffect(() => {
    cameraFocusPlayerIdRef.current = cameraFocusPlayerId;
  }, [cameraFocusPlayerId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    if (!canCreateWebGLContext()) {
      setWebglUnavailable(true);
      return undefined;
    }

    let disposed = false;
    let cleanupRenderer: (() => void) | undefined;

    const createRenderer = (): (() => void) => {
      const mobileLike = isMobileLikeViewport();
      const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !mobileLike,
      alpha: false,
      powerPreference: "high-performance"
    });
    renderer.setClearColor(COLORS.ground, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = mobileLike ? 1.08 : 1.12;
    const dynamicShadows = shouldUseDynamicShadows();
    renderer.shadowMap.enabled = dynamicShadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    setWebglUnavailable(false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLORS.ground);
    scene.fog = mobileLike ? null : new THREE.Fog(COLORS.ground, 1700, 3100);

    const camera = new THREE.OrthographicCamera(-900, 900, 600, -600, 1, 4000);
    const keyLightTarget = new THREE.Object3D();
    const fillLight = new THREE.HemisphereLight(0xd6d3c8, 0x6a6257, 0.86);
    const keyLight = new THREE.DirectionalLight(0xf7f0e4, 2.04);
    keyLight.target = keyLightTarget;
    keyLight.castShadow = dynamicShadows;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(fillLight, keyLightTarget, keyLight);

    const wallLayer = new THREE.Group();
    const tankLayer = new THREE.Group();
    const projectileLayer = new THREE.Group();
    const serverProjectileLayer = new THREE.Group();
    const pickupLayer = new THREE.Group();
    const zoneRing = createZoneRing(COLORS.warning, 0.21);
    const targetZoneRing = createZoneRing(COLORS.white, 0.22, 0.97, 1);
    const zoneDarkness = createZoneDarkness();
    scene.add(wallLayer, pickupLayer, tankLayer, serverProjectileLayer, projectileLayer, targetZoneRing, zoneRing, zoneDarkness);

    const initialLightingMode = readInitialLightingMode();
    const initialOrbitAngle = readInitialOrbitAngle();
    const runtime: Runtime = {
      renderer,
      scene,
      camera,
      keyLight,
      keyLightTarget,
      fillLight,
      raycaster: new THREE.Raycaster(),
      groundPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      wallLayer,
      tankLayer,
      projectileLayer,
      serverProjectileLayer,
      pickupLayer,
      zoneRing,
      targetZoneRing,
      zoneDarkness,
      tankMeshes: new Map(),
      pickupMeshes: new Map(),
      serverProjectileMeshes: new Map(),
      resolvedProjectileIds: new Map(),
      lastImpact: null,
      rainLayer: null,
      particles: [],
      seenAbilityActivations: new Map(),
      mapKey: "",
      rainKey: "",
      snapshotKey: "",
      lastTime: performance.now(),
      visualTime: performance.now(),
      renderWidth: 0,
      renderHeight: 0,
      pixelRatio: 0,
      shadowEnabled: dynamicShadows,
      lightingMode: "sun",
      lightingKey: "",
      forcedLightingMode: initialLightingMode,
      cameraOrbitAngle: normalizeAngle(initialOrbitAngle),
      cameraOrbitPendingDelta: 0,
      orbitPointerId: null,
      orbitPointerLastX: 0,
      smokePrewarmStatus: "idle",
      rafId: 0
    };
    runtimeRef.current = runtime;
    prewarmSmokeResources(runtime);
    for (const impact of impactQueueRef.current.splice(0)) {
      handleProjectileImpact(runtime, snapshotRef.current, impact);
    }

    localPoseRef.current = poseFromSnapshot(snapshotRef.current);
    runtime.snapshotKey = snapshotPoseKey(snapshotRef.current);
    const syncAimFromScreen = (screenX: number, screenY: number): void => {
      inputRef.current.aimMode = "screen";
      inputRef.current.aimScreenX = screenX;
      inputRef.current.aimScreenY = screenY;
      updateAimFromScreen(runtime, canvas, inputRef.current, localPoseRef.current);
    };
    aimSyncRef.current = syncAimFromScreen;

    const resizeObserver = new ResizeObserver(() => {
      updateCamera(
        runtime,
        canvas,
        snapshotRef.current.map,
        cameraFocus(
          runtime,
          snapshotRef.current,
          localPoseRef.current,
          cameraFocusPlayerIdRef.current
        )
      );
    });
    resizeObserver.observe(canvas);
    updateCamera(runtime, canvas, snapshotRef.current.map, localPoseRef.current);

    const onOrbitPointerDown = (event: PointerEvent): void => {
      if (runtime.orbitPointerId !== null) return;
      const wantsOrbit =
        event.pointerType === "touch" ||
        (event.pointerType === "mouse" &&
          (event.button === 1 || event.button === 2 || event.shiftKey || event.altKey));
      if (!wantsOrbit) return;
      event.preventDefault();
      event.stopPropagation();
      runtime.orbitPointerId = event.pointerId;
      runtime.orbitPointerLastX = event.clientX;
      canvas.setPointerCapture(event.pointerId);
    };

    const onOrbitPointerMove = (event: PointerEvent): void => {
      if (runtime.orbitPointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const dx = event.clientX - runtime.orbitPointerLastX;
      runtime.orbitPointerLastX = event.clientX;
      runtime.cameraOrbitPendingDelta += dx * CAMERA_ORBIT_SENSITIVITY;
    };

    const clearOrbitPointer = (pointerId?: number): void => {
      if (pointerId !== undefined && runtime.orbitPointerId !== pointerId) return;
      const activePointerId = runtime.orbitPointerId;
      runtime.orbitPointerId = null;
      if (activePointerId !== null && canvas.hasPointerCapture(activePointerId)) {
        canvas.releasePointerCapture(activePointerId);
      }
    };

    const onOrbitPointerUp = (event: PointerEvent): void => {
      if (runtime.orbitPointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      clearOrbitPointer(event.pointerId);
    };

    const onLostOrbitPointerCapture = (event: PointerEvent): void => {
      clearOrbitPointer(event.pointerId);
    };

    const onWindowBlur = (): void => {
      clearOrbitPointer();
    };

    const onOrbitKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLElement && isEditableElement(event.target)) return;
      if (event.key === "[") {
        runtime.cameraOrbitPendingDelta -= Math.PI / 12;
      } else if (event.key === "]") {
        runtime.cameraOrbitPendingDelta += Math.PI / 12;
      } else if (event.key === "\\") {
        runtime.cameraOrbitPendingDelta = normalizeAngle(-runtime.cameraOrbitAngle);
      } else {
        return;
      }
      event.preventDefault();
    };

    canvas.addEventListener("pointerdown", onOrbitPointerDown, { capture: true });
    canvas.addEventListener("pointermove", onOrbitPointerMove, { capture: true });
    canvas.addEventListener("pointerup", onOrbitPointerUp, { capture: true });
    canvas.addEventListener("pointercancel", onOrbitPointerUp, { capture: true });
    canvas.addEventListener("lostpointercapture", onLostOrbitPointerCapture, { capture: true });
    window.addEventListener("keydown", onOrbitKeyDown, { passive: false });
    window.addEventListener("blur", onWindowBlur);

    const step = (dt: number): void => {
      const currentSnapshot = snapshotRef.current;
      const currentSnapshotKey = snapshotPoseKey(currentSnapshot);
      if (runtime.snapshotKey !== currentSnapshotKey) {
        runtime.snapshotKey = currentSnapshotKey;
        localPoseRef.current = poseFromSnapshot(currentSnapshot);
        onLocalPose({ ...localPoseRef.current });
      }

      const floorPreviewTextureId = readFloorPreviewTextureId();
      const wallPreviewTextureId = readWallPreviewTextureId();
      if (runtime.mapKey !== mapKey(currentSnapshot.map, floorPreviewTextureId, wallPreviewTextureId)) {
        rebuildMap(runtime, currentSnapshot, floorPreviewTextureId, wallPreviewTextureId);
      }
      applyLightingForSnapshot(runtime, currentSnapshot);
      syncRainLayer(runtime, currentSnapshot);
      updateCameraControlBasis(runtime, dt);
      onCameraOrbitAngle?.(runtime.cameraOrbitAngle);

      const input = inputRef.current;
      const self = currentSnapshot.self;
      const allowLocalMovement = canDriveLocalTank(currentSnapshot);
      if (authoritativeSnapshotRef.current && self && hasServerPose(self)) {
        const drift = Math.hypot(self.x - localPoseRef.current.x, self.y - localPoseRef.current.y);
        const movementInput = { x: input.moveX, y: input.moveY };
        const localVelocity = {
          x: localPoseRef.current.velocityX,
          y: localPoseRef.current.velocityY
        };
        const serverVelocity = { x: self.velocityX, y: self.velocityY };
        const isSettling =
          allowLocalMovement &&
          movementIsSettling(movementInput, localVelocity, serverVelocity);
        const holdIdlePose =
          allowLocalMovement &&
          shouldHoldIdlePose(movementInput, localVelocity, serverVelocity, drift, TANK_RADIUS);
        const holdActivePosition =
          allowLocalMovement &&
          shouldHoldActivePosition(movementInput, drift, TANK_RADIUS * 2);
        const correction = frameRateIndependentLerp(
          drift > 140 ? 0.55 : isSettling ? 0.08 : 0.2,
          dt
        );
        if (!holdActivePosition && !holdIdlePose) {
          localPoseRef.current.x += (self.x - localPoseRef.current.x) * correction;
          localPoseRef.current.y += (self.y - localPoseRef.current.y) * correction;
        }
        localPoseRef.current.velocityX += (self.velocityX - localPoseRef.current.velocityX) * correction;
        localPoseRef.current.velocityY += (self.velocityY - localPoseRef.current.velocityY) * correction;
        localPoseRef.current.rotation = lerpAngle(
          localPoseRef.current.rotation,
          self.rotation,
          frameRateIndependentLerp(drift > 140 ? 0.4 : isSettling ? 0.06 : 0.16, dt)
        );
      }

      if (allowLocalMovement) {
        applyLocalMovement(
          localPoseRef.current,
          input,
          currentSnapshot.map,
          currentSnapshot.self?.archetypeId ?? "atlas",
          currentSnapshot.self?.speedMultiplier ?? 1,
          dt,
          runtime.cameraOrbitAngle
        );
      }
      updateBoundaryBarrier(runtime, localPoseRef.current, dt);
      updateCamera(
        runtime,
        canvas,
        currentSnapshot.map,
        cameraFocus(
          runtime,
          currentSnapshot,
          localPoseRef.current,
          cameraFocusPlayerIdRef.current
        )
      );
      updateAimFromScreen(runtime, canvas, input, localPoseRef.current);
      updateTankTargets(runtime, currentSnapshot, localPoseRef.current);
      renderTanks(runtime, dt, currentSnapshot.map);
      updateZone(runtime, currentSnapshot, runtime.visualTime);
      updatePickups(runtime, currentSnapshot, runtime.visualTime);
      updateServerProjectiles(runtime, currentSnapshot, dt);
      syncAbilityActivations(runtime, currentSnapshot);
      updateParticles(runtime, dt, currentSnapshot);
      updateRainLayer(runtime);
      onLocalPose({ ...localPoseRef.current });
      renderer.render(scene, camera);
    };

    const loop = (time: number): void => {
      const dt = clamp(time - runtime.lastTime, 0, 64);
      runtime.lastTime = time;
      runtime.visualTime = time;
      step(dt);
      runtime.rafId = window.requestAnimationFrame(loop);
    };

    if (DEBUG_TOOLS_COMPILED) {
      window.__alpha7ArenaAdvance = (ms: number) => {
      const steps = Math.max(1, Math.round(ms / (1000 / 60)));
      for (let index = 0; index < steps; index += 1) {
        runtime.visualTime += 1000 / 60;
        step(1000 / 60);
      }
    };
    window.__alpha7ArenaSetLightingMode = (mode: LightingMode | "auto") => {
      runtime.forcedLightingMode = mode === "auto" ? null : mode;
      runtime.lightingKey = "";
      applyLightingForSnapshot(runtime, snapshotRef.current);
    };
    window.__alpha7ArenaOrbitCamera = (degrees: number) => {
      if (!Number.isFinite(degrees)) return;
      runtime.cameraOrbitPendingDelta += THREE.MathUtils.degToRad(degrees);
    };
    window.__alpha7ArenaSetCameraOrbit = (degrees: number) => {
      if (!Number.isFinite(degrees)) return;
      runtime.cameraOrbitAngle = normalizeAngle(THREE.MathUtils.degToRad(degrees));
      runtime.cameraOrbitPendingDelta = 0;
    };
    window.__alpha7ArenaPreviewAbility = (abilityType: ClientPlayer["abilityType"]) => {
      if (!(abilityType in ABILITY_CONFIG)) return;
      const particle = createAbilityParticle(localPoseRef.current, abilityType);
      runtime.particles.push(particle);
      runtime.projectileLayer.add(particle.mesh);
    };
    window.__alpha7ArenaPreviewImpact = (
      weaponType: ClientPlayer["weaponType"],
      reason: ProjectileImpactMessagePayload["reason"] = "tank"
    ) => {
      if (!(weaponType in WEAPON_CONFIG)) return;
      const currentSnapshot = snapshotRef.current;
      const target =
        reason === "tank"
          ? currentSnapshot.self ??
            currentSnapshot.players.find((player) => player.sessionId !== currentSnapshot.self?.sessionId)
          : null;
      const angle = localPoseRef.current.turretRotation;
      const x = target?.x ?? localPoseRef.current.x + Math.cos(angle) * 130;
      const y = target?.y ?? localPoseRef.current.y + Math.sin(angle) * 130;
      handleProjectileImpact(runtime, currentSnapshot, {
        projectileId: `debug-impact-${runtime.visualTime}`,
        ownerId: currentSnapshot.self?.sessionId ?? "debug",
        fireSequence: -1,
        weaponType,
        reason,
        x,
        y,
        rotation: angle,
        radius: weaponType === "machine_gun" ? 4 : weaponType === "light_cannon" ? 6 : weaponType === "explosive" ? 10 : 8,
        splashRadius: weaponType === "explosive" ? WEAPON_CONFIG.explosive.splashRadius : 0,
        ...(target
          ? {
              targetSessionId: target.sessionId,
              damage: WEAPON_CONFIG[weaponType].damage,
              destroyed: false,
              shieldHit: false
            }
          : {}),
        at: Date.now()
      });
    };
      window.__alpha7ArenaState = () => {
      const currentSnapshot = snapshotRef.current;
      const currentServerNow = snapshotServerNow(currentSnapshot);
      const weather = readMapWeather(currentSnapshot.map);
      const floorPreviewTextureId = readFloorPreviewTextureId();
      const wallPreviewTextureId = readWallPreviewTextureId();
      const visibleWalls = currentSnapshot.map.walls.filter((wall) => !isOuterBoundaryWall(wall, currentSnapshot.map));
      const visibleWallCount = visibleWalls.length;
      const currentRadius = currentSnapshot.zone.radius || currentSnapshot.zone.targetRadius;
      const zoneDarkness = zoneDarknessSettings(currentSnapshot.matchState, currentRadius, runtime.visualTime);
      const boundaryBarrier = runtime.wallLayer.getObjectByName("boundary-barrier");
      const wallJunctionCaps = runtime.wallLayer.getObjectByName("wall-junction-caps");
      const smokeVisuals = runtime.particles.filter(
        (particle) => particle.kind === "pulse" && particle.abilityType === "smoke"
      );
      const activeSmokeSprites = smokeVisuals.reduce(
        (total, particle) => total + particle.mesh.children.filter((child) => Boolean(child.userData.alpha7Smoke)).length,
        0
      );
      const focus = cameraFocus(
        runtime,
        currentSnapshot,
        localPoseRef.current,
        cameraFocusPlayerIdRef.current
      );
      const focusNdc = new THREE.Vector3(focus.x, 0, focus.y).project(runtime.camera);
      return {
        map: {
          id: currentSnapshot.map.id,
          source: currentSnapshot.map.source,
          width: currentSnapshot.map.width,
          height: currentSnapshot.map.height,
          wallCount: currentSnapshot.map.walls.length,
          visibleWallCount,
          hiddenBoundaryWallCount: currentSnapshot.map.walls.length - visibleWallCount,
          junctionCapCount: wallJunctionCaps?.children.length ?? 0,
          materialSource: MAP_MATERIAL_SOURCE,
          textureContract: MAP_TEXTURE_CONTRACT,
          textures: {
            floor: floorPreviewTextureId
              ? FLOOR_PREVIEW_TEXTURES[floorPreviewTextureId].color
              : FLOOR_PREVIEW_TEXTURES[CANONICAL_FLOOR_MATERIAL].color,
            wall: wallPreviewTextureId
              ? WALL_PREVIEW_TEXTURES[wallPreviewTextureId].color
              : WALL_PREVIEW_TEXTURES[CANONICAL_WALL_MATERIAL].color,
            floorPreview: floorPreviewTextureId,
            wallPreview: wallPreviewTextureId,
            previewChannels: {
              floor: floorPreviewTextureId ? FLOOR_PREVIEW_TEXTURES[floorPreviewTextureId] : null,
              wall: wallPreviewTextureId ? WALL_PREVIEW_TEXTURES[wallPreviewTextureId] : null
            },
            alternates: [
              REFERENCE_CONCRETE_TEXTURES.floorClean,
              FLOOR_PREVIEW_TEXTURES[CANONICAL_FLOOR_MATERIAL].color,
              REFERENCE_CONCRETE_TEXTURES.floorWorn,
              REFERENCE_CONCRETE_TEXTURES.floorDusty,
              WALL_PREVIEW_TEXTURES[CANONICAL_WALL_MATERIAL].color,
              REFERENCE_CONCRETE_TEXTURES.wallClean,
              REFERENCE_CONCRETE_TEXTURES.wallWorn,
              REFERENCE_CONCRETE_TEXTURES.wallStained
            ]
          }
        },
        renderer: {
          width: runtime.renderWidth,
          height: runtime.renderHeight,
          pixelRatio: runtime.pixelRatio,
          mapKey: runtime.mapKey
        },
        weather: {
          source: RAIN_LAYER_SOURCE,
          configured: Boolean(weather),
          kind: weather?.kind ?? "none",
          intensity: Number((weather?.intensity ?? 0).toFixed(3)),
          seed: weather?.seed ?? null,
          active: Boolean(runtime.rainLayer),
          streakCount: runtime.rainLayer?.segmentCount ?? 0,
          mobileReduced: runtime.rainLayer?.mobileReduced ?? isMobileLikeViewport(),
          reducedMotion: runtime.rainLayer?.reducedMotion ?? prefersReducedMotion(),
          updateRateCap: runtime.rainLayer?.mobileReduced ? 30 : null
        },
        camera: {
          x: Math.round(runtime.camera.position.x),
          y: Math.round(runtime.camera.position.y),
          z: Math.round(runtime.camera.position.z),
          zoom: runtime.camera.zoom,
          orbitDegrees: Math.round(THREE.MathUtils.radToDeg(runtime.cameraOrbitAngle)),
          pendingOrbitDegrees: Math.round(THREE.MathUtils.radToDeg(runtime.cameraOrbitPendingDelta)),
          orbitDragging: runtime.orbitPointerId !== null,
          focusPlayerId: cameraFocusPlayerIdRef.current,
          focusNdc: {
            x: Number(focusNdc.x.toFixed(3)),
            y: Number(focusNdc.y.toFixed(3))
          },
          controls: ["touch-drag-empty-arena", "right-drag", "middle-drag", "shift-drag", "alt-drag", "[", "]", "\\"]
        },
        localPose: { ...localPoseRef.current },
        visiblePlayers: Array.from(runtime.tankMeshes.entries()).map(([id, parts]) => {
          const player = currentSnapshot.players.find((entry) => entry.sessionId === id);
          const concealedBySmoke = player
            ? isRemoteTankConcealedBySmoke(currentSnapshot, player, currentServerNow)
            : Boolean(parts.group.userData.concealedBySmoke);
          return {
            id,
            x: Math.round(parts.current.x),
            y: Math.round(parts.current.y),
            rotation: Number(parts.current.rotation.toFixed(3)),
            turretRotation: Number(parts.current.turretRotation.toFixed(3)),
            health: player?.health ?? 0,
            armor: player?.armor ?? 0,
            shield: player?.shield ?? 0,
            isSelf: parts.isSelf,
            isAlive: player?.isAlive ?? false,
            isConnected: player?.isConnected ?? false,
            isSpectator: player?.isSpectator ?? false,
            archetypeId: parts.archetypeId,
            concealedBySmoke,
            renderVisible: parts.group.visible
          };
        }),
        pickups: {
          total: currentSnapshot.pickups.length,
          active: currentSnapshot.pickups.filter((pickup) => pickup.isActive).length,
          visible: runtime.pickupMeshes.size
        },
        projectiles: {
          server: runtime.serverProjectileMeshes.size,
          selfServer: currentSnapshot.projectiles.filter(
            (projectile) => projectile.ownerId === currentSnapshot.self?.sessionId
          ).length,
          predicted: runtime.particles.filter((particle) => particle.predictedShot).length,
          localParticles: runtime.particles.length,
          renderCap: SERVER_PROJECTILE_RENDER_CAP,
          resolved: runtime.resolvedProjectileIds.size,
          lastImpact: runtime.lastImpact
        },
        abilities: {
          activeVisuals: runtime.particles
            .filter((particle): particle is Particle & { abilityType: ClientPlayer["abilityType"] } =>
              particle.kind === "pulse" && Boolean(particle.abilityType)
            )
            .map((particle) => ({
              type: particle.abilityType,
              remainingMs: Math.max(0, Math.round(particle.maxLife - particle.life))
            })),
          smoke: {
            prewarmStatus: runtime.smokePrewarmStatus,
            textureSize: SMOKE_TEXTURE_SIZE,
            spriteCap: { mobile: SMOKE_MOBILE_PUFF_COUNT, desktop: SMOKE_DESKTOP_PUFF_COUNT },
            puffOpacity: {
              min: SMOKE_PUFF_OPACITY_MIN,
              max: SMOKE_PUFF_OPACITY_MIN + SMOKE_PUFF_OPACITY_RANGE
            },
            activeClouds: smokeVisuals.length,
            activeSprites: activeSmokeSprites
          }
        },
        lighting: {
          source: MAP_LIGHTING_SOURCE,
          mode: runtime.lightingMode,
          forcedMode: runtime.forcedLightingMode ?? "auto",
          dynamicShadows: runtime.shadowEnabled,
          shadowMapSize: runtime.keyLight.shadow.mapSize.x,
          casterPolicy: "tanks-only"
        },
        visualChecks: {
          boundaryBarrier: {
            panels: (boundaryBarrier?.children ?? []).map((panel) => ({
              side: (panel.userData.boundarySegment as BoundarySegment).side,
              x: Math.round(panel.position.x),
              y: Math.round(panel.position.z),
              opacity: Number(
                (((panel as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity ?? 0).toFixed(3)
              ),
              visible: panel.visible
            }))
          },
          zoneDarkness: {
            visible: runtime.zoneDarkness.visible,
            opacity: Number(zoneDarkness.opacity.toFixed(3)),
            feather: Math.round(zoneDarkness.feather),
            tint: `#${zoneDarkness.tint.toString(16).padStart(6, "0")}`
          },
          contactShadows: {
            tanks: true,
            walls: true,
            tankOpacity: TANK_CONTACT_SHADOW_OPACITY,
            wallBaseOpacity: WALL_BASE_CONTACT_SHADOW_OPACITY,
            wallCastOpacity: WALL_CAST_SHADOW_OPACITY,
            wallCastOffset: updateWallCastShadowDirection(runtime, currentSnapshot.map)
          }
        }
      };
      };
    }

    runtime.rafId = window.requestAnimationFrame(loop);

    return () => {
      window.cancelAnimationFrame(runtime.rafId);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onOrbitPointerDown, { capture: true });
      canvas.removeEventListener("pointermove", onOrbitPointerMove, { capture: true });
      canvas.removeEventListener("pointerup", onOrbitPointerUp, { capture: true });
      canvas.removeEventListener("pointercancel", onOrbitPointerUp, { capture: true });
      canvas.removeEventListener("lostpointercapture", onLostOrbitPointerCapture, { capture: true });
      window.removeEventListener("keydown", onOrbitKeyDown);
      window.removeEventListener("blur", onWindowBlur);
      if (window.__alpha7ArenaAdvance) delete window.__alpha7ArenaAdvance;
      if (window.__alpha7ArenaState) delete window.__alpha7ArenaState;
      if (window.__alpha7ArenaSetLightingMode) delete window.__alpha7ArenaSetLightingMode;
      if (window.__alpha7ArenaOrbitCamera) delete window.__alpha7ArenaOrbitCamera;
      if (window.__alpha7ArenaSetCameraOrbit) delete window.__alpha7ArenaSetCameraOrbit;
      if (window.__alpha7ArenaPreviewAbility) delete window.__alpha7ArenaPreviewAbility;
      if (window.__alpha7ArenaPreviewImpact) delete window.__alpha7ArenaPreviewImpact;
      if (aimSyncRef.current === syncAimFromScreen) aimSyncRef.current = null;
      renderer.dispose();
      disposeObject(scene);
      runtimeRef.current = null;
    };
    };

    void preloadArenaTextures().then(() => {
      if (!disposed) cleanupRenderer = createRenderer();
    });

    return () => {
      disposed = true;
      cleanupRenderer?.();
    };
  }, [aimSyncRef, impactQueueRef, inputRef, onCameraOrbitAngle, onLocalPose]);

  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || fireSignal === 0) return;
    const self = snapshotRef.current?.self;
    const selfParts = self ? runtime.tankMeshes.get(self.sessionId) : undefined;
    const weaponType = self?.weaponType ?? "cannon";
    const muzzle = selfParts ? renderedTankMuzzleWorldPosition(selfParts, 1) : undefined;
    const particle = createMuzzleFlash(
      localPoseRef.current,
      inputRef.current,
      weaponType,
      snapshotRef.current?.map,
      muzzle
    );
    const predictedShot = createPredictedShot(
      localPoseRef.current,
      inputRef.current,
      weaponType,
      fireSequenceRef.current,
      muzzle
    );
    runtime.particles.push(particle);
    runtime.particles.push(predictedShot);
    runtime.projectileLayer.add(particle.mesh);
    runtime.projectileLayer.add(predictedShot.mesh);
  }, [fireSequenceRef, fireSignal, inputRef]);

  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || impactSignal === 0) return;
    const queued = impactQueueRef.current.splice(0);
    for (const impact of queued) {
      handleProjectileImpact(runtime, snapshotRef.current, impact);
    }
  }, [impactQueueRef, impactSignal]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || abilitySignal === 0) return;
    const abilityType = snapshotRef.current?.self?.abilityType;
    if (!abilityType) return;
    const particle = createAbilityParticle(localPoseRef.current, abilityType);
    runtime.particles.push(particle);
    runtime.projectileLayer.add(particle.mesh);
  }, [abilitySignal]);

  return (
    <>
      <canvas aria-label="Alpha-7 3D arena" className="game-canvas" ref={canvasRef} />
      {webglUnavailable ? (
        <div className="webgl-fallback hud-panel" role="status">
          <strong>3D renderer unavailable</strong>
          <span>Lobby controls remain active.</span>
        </div>
      ) : null}
    </>
  );
}
