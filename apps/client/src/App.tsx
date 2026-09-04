import {
  useCallback,
  useEffect,
  Fragment,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent
} from "react";
import { Client, CloseCode, type Room } from "@colyseus/sdk";
import {
  ABILITY_CONFIG,
  BATTLE_ROYALE_ROOM,
  CLIENT_MESSAGE_TYPES,
  DEFAULT_TANK_ARCHETYPE,
  PICKUP_CONFIG,
  RAPID_FIRE_COOLDOWN_MULTIPLIER,
  SERVER_MESSAGE_TYPES,
  TANK_ARCHETYPE_CONFIG,
  TANK_ARCHETYPES,
  WEAPON_CONFIG,
  createSeededRng,
  hashSeed,
  type AbilityMessagePayload,
  type AbilityType,
  type AgentControlAction,
  type AgentControlResultPayload,
  type AgentPairingCreatePayload,
  type AgentPairingResultPayload,
  type AgentSeatState,
  type AgentTacticalIntentV1,
  type ArenaConfig,
  type ArenaWeatherConfig,
  type ErrorMessagePayload,
  type FireMessagePayload,
  type InputMessagePayload,
  type JoinMessagePayload,
  type PickupType,
  type ProjectileImpactMessagePayload,
  type ReadyMessagePayload,
  type RematchMessagePayload,
  type RoomMode,
  type StartMessagePayload,
  type SystemMessagePayload,
  type TankArchetypeId
} from "@alpha7/shared";
import { Alpha7StateSchema } from "@alpha7/shared/schema";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Crosshair,
  Eye,
  Lock,
  LogOut,
  Play,
  RadioTower,
  RefreshCcw,
  Shield,
  SquareArrowUp,
  Target,
  Unlock,
  WifiOff,
  Wrench,
  Zap
} from "lucide-react";
import { ArenaRenderer, type LocalPose } from "./ArenaRenderer";
import { AudioReviewLab } from "./AudioReviewLab";
import { AgentConnectPage, isAgentConnectPath } from "./AgentConnectPage";
import { DEFAULT_AGENT_OPENING_TACTIC, agentWebMcp } from "./webMcp";
import {
  DEFAULT_ALPHA7_ASSET_MANIFEST,
  loadAlpha7AssetManifest,
  manifestRuntimeSignature,
  type Alpha7AssetManifest
} from "./assets";
import {
  BACKGROUND_MUSIC_AUDIO,
  PRELOAD_AUDIO_CUES,
  RAIN_AUDIO_CUE,
  THUNDER_AUDIO,
  UI_AUDIO,
  chooseNextMenuMusicIndex,
  fireAudioForTank,
  menuMusicPlayCount,
  movementAudioForTank,
  weatherCanThunder,
  type AudioCueDefinition,
  type UiAudioCue
} from "./audioCatalog";
import {
  endpointFromEnv,
  agentRoomReadiness,
  activeAgentControlCount,
  buildHudScenarioSnapshot,
  canRequestAgentPairing,
  canStartRoom,
  cycleSpectatorTarget,
  createSiteVisitorId,
  httpEndpointFromEnv,
  isActiveMatchState,
  isOuterBoundaryWall,
  isPlayerConcealedBySmoke,
  isWaitingRoomState,
  parsePlayersOnline,
  matchStandings,
  ownedAgentSessionId,
  previewSnapshot,
  shouldAutoReconnectOnPageLoad,
  shouldRepeatHeldFire,
  shouldShowIphoneStandaloneHint,
  shouldStartFreshQuickPlayAfterReconnect,
  snapshotFromState,
  snapshotServerNow,
  spectatorTargets,
  type ClientPlayer,
  type ClientSnapshot,
  type ConnectionStatus,
  type HudScenario,
  type InputFrame,
  type JoinMode,
  type ScreenMode
} from "./clientState";
import {
  aimStickIntent,
  controlMoveToWorldMove,
  lightningFlashAlpha,
  movementStickIntent,
  normalizeVector
} from "./inputMath";

declare global {
  interface Window {
    advanceTime?: (ms: number) => void;
    render_game_to_text?: () => string;
  }
}

type MatchmakingJoinMode = Exclude<JoinMode, "code">;
type QueuedJoin = { mode: JoinMode; roomMode: RoomMode };
type PickupNotice = {
  pickupType: PickupType;
  name: string;
  detail: string;
  durationMs: number;
  expiresAt: number;
};
type MobileAimGesture = {
  pointerId: number | null;
  startedAt: number;
  startX: number;
  startY: number;
  armed: boolean;
  everArmed: boolean;
  rapidStarted: boolean;
};

type AgentRoomUi = {
  mode: RoomMode;
  humanCount: number;
  agentCount: number;
  pendingAgentCount: number;
  combatantCount: number;
  ownerCap: number;
  agentControlCap: number;
  combatantCap: number;
  tacticalReflexEnabled: boolean;
  agentLabel: string;
  agentState: AgentSeatState;
  requestId: string | null;
  pairingCode: string | null;
  expiresAtMs: number | null;
  readinessBlocked: boolean;
  startBlocked: boolean;
  openingTactic: AgentTacticalIntentV1;
};
type ConfirmedAgentControlAction = Exclude<AgentControlAction, "pause">;

const RAIN_SCREEN_OVERLAY_SOURCE = "rain-lens-wet-glass-v5-tail-free" as const;
const MOBILE_AIM_QUICK_TAP_MS = 180;
const MOBILE_AIM_QUICK_TAP_DISTANCE = 12;
const MOBILE_RAPID_FIRE_HOLD_MS = 220;
const AGENT_PLAY_ENABLED = import.meta.env.VITE_AGENT_PLAY_ENABLED === "true";
const DEBUG_TOOLS_COMPILED = import.meta.env.DEV || import.meta.env.VITE_DEBUG === "true";
const ROOM_MODE_OPTIONS: ReadonlyArray<{
  id: RoomMode;
  label: string;
  description: string;
}> = [
  { id: "classic", label: "Classic", description: "Human-only last tank standing." },
  { id: "wingman", label: "Wingman", description: "Fight with one owned agent. Friendly fire is off." },
  { id: "open_ffa", label: "Open FFA", description: "Humans and agents fight as independent rivals." },
  { id: "agent_cup", label: "Agent Cup", description: "Your agent fights while human owners spectate." }
];
const DEFAULT_AGENT_ROOM_UI: AgentRoomUi = {
  mode: "classic",
  humanCount: 0,
  agentCount: 0,
  pendingAgentCount: 0,
  combatantCount: 0,
  ownerCap: 8,
  agentControlCap: 0,
  combatantCap: 8,
  tacticalReflexEnabled: false,
  agentLabel: "Owned Agent",
  agentState: "none",
  requestId: null,
  pairingCode: null,
  expiresAtMs: null,
  readinessBlocked: false,
  startBlocked: false,
  openingTactic: DEFAULT_AGENT_OPENING_TACTIC
};
export const agentPairingCreatePayload = (
  agentLabel: string,
  tacticalReflexEnabled: boolean,
  openingTactic: AgentTacticalIntentV1
): AgentPairingCreatePayload => ({
  agentLabel,
  ...(tacticalReflexEnabled ? { controlMode: "tactical_reflex_v1", openingTactic } : {})
});
const MOVEMENT_KEYS = new Set([
  "w",
  "a",
  "s",
  "d",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright"
]);
const MOBILE_ABILITY_LABELS: Record<AbilityType, string> = {
  smoke: "Smoke",
  repair: "Repair",
  shield_pulse: "Shield",
  speed_burst: "Boost",
  barrage: "Barrage"
};

const isDebugToolsEnabled = (): boolean => {
  if (!DEBUG_TOOLS_COMPILED || typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("alpha7Debug") === "1" || params.get("alpha7DebugHud") === "1";
};

type WeatherPreviewMode = "lens-impact" | "lightning-peak";

const readWeatherPreviewMode = (): WeatherPreviewMode | null => {
  if (!isDebugToolsEnabled()) return null;
  const value = new URLSearchParams(window.location.search).get("alpha7WeatherPreview");
  return value === "lens-impact" || value === "lightning-peak" ? value : null;
};

const statLabels = ["firepower", "armor", "mobility", "support"] as const;
const archetypes = TANK_ARCHETYPES.map((id) => TANK_ARCHETYPE_CONFIG[id]);
const hudScenarios: HudScenario[] = ["lobby", "lobby8", "gameplay", "danger", "results8", "spectator"];

const readHudScenario = (): HudScenario | null => {
  if (!DEBUG_TOOLS_COMPILED || typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("alpha7Scenario");
  if (!value) return null;
  return hudScenarios.includes(value as HudScenario) ? (value as HudScenario) : null;
};

const readScenarioTank = (): TankArchetypeId | null => {
  if (!DEBUG_TOOLS_COMPILED || typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("alpha7Tank");
  if (!value) return null;
  return (TANK_ARCHETYPES as readonly string[]).includes(value) ? (value as TankArchetypeId) : null;
};

const readScenarioAbility = (): AbilityType | null => {
  if (!DEBUG_TOOLS_COMPILED || typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("alpha7Ability");
  if (!value) return null;
  return value in ABILITY_CONFIG ? (value as AbilityType) : null;
};

const readScenarioShield = (): number | null => {
  if (!DEBUG_TOOLS_COMPILED || typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("alpha7Shield");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? clamp(value, 0, 40) : null;
};

const readScenarioPickupNotice = (): PickupNotice | null => {
  if (typeof window === "undefined" || !readHudScenario()) return null;
  const value = new URLSearchParams(window.location.search).get("alpha7Pickup");
  if (!value || !(value in PICKUP_CONFIG)) return null;
  const pickupType = value as PickupType;
  const config = PICKUP_CONFIG[pickupType];
  return {
    pickupType,
    name: config.name,
    detail: formatPickupDetail(pickupType, config.value),
    durationMs: config.durationMs,
    expiresAt: Date.now() + Math.max(config.durationMs, 60000)
  };
};

const defaultInputFrame = (): InputFrame => ({
  moveX: 0,
  moveY: 0,
  aimMode: "screen",
  aimScreenX: null,
  aimScreenY: null,
  aimWorldX: 520,
  aimWorldY: 0,
  aimDirX: 1,
  aimDirY: 0,
  fire: false,
  ability: false
});

const isMobileRainViewport = (
  viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280,
  viewportHeight = typeof window !== "undefined" ? window.innerHeight : 720,
  coarsePointer =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
): boolean => coarsePointer || viewportWidth <= 900 || viewportHeight <= 500;

const rainScreenDropletCount = (
  weather: ArenaWeatherConfig,
  viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280,
  viewportHeight = typeof window !== "undefined" ? window.innerHeight : 720,
  coarsePointer =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
): number => {
  if (weather.kind !== "rain" || weather.intensity <= 0.05) return 0;
  const mobile = isMobileRainViewport(viewportWidth, viewportHeight, coarsePointer);
  const baseCount = mobile ? 4 : 7;
  return Math.max(mobile ? 2 : 4, Math.round(baseCount * Math.min(1, Math.max(0.35, weather.intensity))));
};

const rainScreenImpactCount = (
  weather: ArenaWeatherConfig,
  viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280,
  viewportHeight = typeof window !== "undefined" ? window.innerHeight : 720,
  coarsePointer =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
): number => {
  if (weather.kind !== "rain" || weather.intensity <= 0.05) return 0;
  return isMobileRainViewport(viewportWidth, viewportHeight, coarsePointer) ? 1 : 3;
};

const rainScreenOverlayDebug = (weather: ArenaWeatherConfig) => {
  const dropletCount = rainScreenDropletCount(weather);
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 720;
  const coarsePointer =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const mobileReduced = isMobileRainViewport(viewportWidth, viewportHeight, coarsePointer);
  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const previewMode = readWeatherPreviewMode();

  return {
    source: RAIN_SCREEN_OVERLAY_SOURCE,
    active: dropletCount > 0,
    dropletCount,
    impactCount: reducedMotion
      ? 0
      : rainScreenImpactCount(weather, viewportWidth, viewportHeight, coarsePointer),
    lightningEnabled: weather.kind === "rain" && weather.intensity >= 0.65 && !reducedMotion,
    previewMode,
    mobileReduced,
    reducedMotion,
    layer: "screen-space-canvas",
    updateRateCap: mobileReduced && !reducedMotion ? 30 : null,
    pixelRatioCap: mobileReduced ? 1 : 1.75,
    pointerEvents: "none"
  };
};

function RainScreenOverlay({
  weather,
  onThunder
}: {
  weather: ArenaWeatherConfig;
  onThunder?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastThunderCycleRef = useRef(Number.NEGATIVE_INFINITY);
  const previewMode = readWeatherPreviewMode();
  const [viewportKey, setViewportKey] = useState(() =>
    typeof window === "undefined" ? "1280x720" : `${window.innerWidth}x${window.innerHeight}`
  );

  useEffect(() => {
    const updateViewportKey = () => setViewportKey(`${window.innerWidth}x${window.innerHeight}`);
    window.addEventListener("resize", updateViewportKey);
    window.addEventListener("orientationchange", updateViewportKey);
    return () => {
      window.removeEventListener("resize", updateViewportKey);
      window.removeEventListener("orientationchange", updateViewportKey);
    };
  }, []);

  const marks = useMemo(() => {
    const count = rainScreenDropletCount(weather);
    if (count <= 0) return [];

    const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;
    const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 720;
    const coarsePointer =
      typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    const mobile = isMobileRainViewport(viewportWidth, viewportHeight, coarsePointer);
    const rng = createSeededRng(`${weather.seed}:lens-streaks`);
    return Array.from({ length: count }, (_, index) => {
      const edge = rng.next();
      const x = edge < 0.28 ? rng.float(3, 18) : edge < 0.56 ? rng.float(82, 97) : rng.float(18, 82);
      const y = mobile ? rng.float(4, 38) : edge < 0.76 ? rng.float(4, 32) : rng.float(62, 86);
      return {
        id: `${weather.seed}:${index}`,
        x,
        y,
        angle: rng.float(-22, -8),
        length: rng.float(28, 84),
        width: rng.float(0.7, 1.55),
        driftX: rng.float(-8, 10),
        driftY: rng.float(8, 26),
        duration: rng.float(3.8, 7.6),
        phase: rng.float(0, 1),
        breakRatio: rng.float(0.36, 0.68),
        gap: rng.float(5, 14),
        opacity: rng.float(0.07, 0.16) * Math.min(1.08, 0.72 + weather.intensity * 0.5)
      };
    });
  }, [viewportKey, weather.intensity, weather.kind, weather.seed]);

  const impacts = useMemo(() => {
    const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;
    const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 720;
    const coarsePointer =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    const reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const count = reducedMotion
      ? 0
      : rainScreenImpactCount(weather, viewportWidth, viewportHeight, coarsePointer);
    if (count <= 0) return [];

    const mobile = isMobileRainViewport(viewportWidth, viewportHeight, coarsePointer);
    const rng = createSeededRng(`${weather.seed}:lens-impacts`);
    return Array.from({ length: count }, (_, index) => {
      const rightEdge = rng.next() > 0.5;
      return {
        id: `${weather.seed}:impact:${index}`,
        x: rightEdge ? rng.float(76, 93) : rng.float(7, 24),
        y: mobile ? rng.float(5, 32) : rng.float(8, 78),
        angle: rng.float(-0.18, 0.18),
        size: rng.float(mobile ? 18 : 24, mobile ? 24 : 34),
        slide: rng.float(mobile ? 16 : 20, mobile ? 25 : 34),
        cycle: rng.float(6, 9),
        phase: (index / count + rng.float(0, 0.18)) % 1,
        duration: rng.float(2.4, 3.8),
        opacity: rng.float(0.28, 0.4) * Math.min(1.08, 0.76 + weather.intensity * 0.38)
      };
    });
  }, [viewportKey, weather.intensity, weather.kind, weather.seed]);

  const lightning = useMemo(() => {
    if (weather.kind !== "rain" || weather.intensity < 0.65) return null;
    const reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return null;
    const rng = createSeededRng(`${weather.seed}:lightning`);
    return {
      cycle: rng.float(16, 24),
      phase: rng.float(0, 1),
      sourceX: rng.next() > 0.5 ? rng.float(68, 92) : rng.float(8, 32),
      strength: rng.float(0.1, 0.15) * Math.min(1, weather.intensity + 0.16)
    };
  }, [weather.intensity, weather.kind, weather.seed]);

  useEffect(() => {
    lastThunderCycleRef.current = Number.NEGATIVE_INFINITY;
  }, [weather.seed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || (marks.length === 0 && impacts.length === 0 && !lightning)) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let rafId = 0;
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let mobileReduced = false;
    let lastDrawTime = Number.NEGATIVE_INFINITY;
    const reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      mobileReduced = window.matchMedia("(pointer: coarse)").matches || width <= 900 || height <= 500;
      pixelRatio = mobileReduced ? 1 : Math.min(1.75, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    const clear = () => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    };

    const drawLensStreak = (
      mark: (typeof marks)[number],
      progress: number
    ) => {
      const x = (mark.x * width) / 100 + mark.driftX * progress;
      const y = (mark.y * height) / 100 + mark.driftY * progress;
      const alpha = mark.opacity * Math.sin(Math.PI * Math.min(1, Math.max(0, progress)));

      if (alpha <= 0.002) return;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((mark.angle * Math.PI) / 180);
      ctx.globalAlpha = alpha;
      ctx.lineCap = "round";
      ctx.lineWidth = mark.width;
      ctx.shadowColor = mobileReduced ? "transparent" : "rgba(247, 243, 237, 0.22)";
      ctx.shadowBlur = mobileReduced ? 0 : 5;

      if (mobileReduced) {
        ctx.strokeStyle = "rgba(247, 243, 237, 0.2)";
      } else {
        const gradient = ctx.createLinearGradient(0, -mark.length / 2, 0, mark.length / 2);
        gradient.addColorStop(0, "rgba(247, 243, 237, 0)");
        gradient.addColorStop(0.22, "rgba(247, 243, 237, 0.34)");
        gradient.addColorStop(0.44, "rgba(247, 243, 237, 0.08)");
        gradient.addColorStop(0.6, "rgba(247, 243, 237, 0.28)");
        gradient.addColorStop(1, "rgba(247, 243, 237, 0)");
        ctx.strokeStyle = gradient;
      }
      ctx.beginPath();
      const halfLength = mark.length / 2;
      const breakY = -halfLength + mark.length * mark.breakRatio;
      ctx.moveTo(0, -halfLength);
      ctx.quadraticCurveTo(mark.width * 2.2, breakY - mark.gap, mark.width * 0.7, breakY - mark.gap / 2);
      ctx.moveTo(mark.width * 0.25, breakY + mark.gap / 2);
      ctx.quadraticCurveTo(-mark.width * 1.8, halfLength * 0.62, 0, halfLength);
      ctx.stroke();

      ctx.globalAlpha = alpha * 0.68;
      ctx.fillStyle = "rgba(247, 243, 237, 0.42)";
      ctx.beginPath();
      ctx.ellipse(0, halfLength + mark.width, mark.width * 1.2, mark.width * 1.7, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    };

    const drawLensImpact = (
      impact: (typeof impacts)[number],
      seconds: number,
      forcedProgress?: number
    ) => {
      const activeRatio = impact.duration / impact.cycle;
      const cycleProgress = (seconds / impact.cycle + impact.phase) % 1;
      if (forcedProgress === undefined && cycleProgress > activeRatio) return;
      const progress = forcedProgress ?? cycleProgress / activeRatio;
      const alpha = impact.opacity * Math.sin(Math.PI * progress);
      if (alpha <= 0.003) return;

      const x = (impact.x * width) / 100;
      const y = (impact.y * height) / 100;
      const size = impact.size * (0.92 + progress * 0.08);
      ctx.save();
      ctx.translate(x, y + impact.slide * progress * 0.55);
      ctx.rotate(impact.angle);
      ctx.lineCap = "round";

      ctx.globalAlpha = alpha;
      if (mobileReduced) {
        ctx.fillStyle = "rgba(167, 194, 204, 0.16)";
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
      } else {
        const wetGlass = ctx.createRadialGradient(
          0,
          0,
          size * 0.18,
          size * 0.05,
          size * 0.08,
          size * 1.12
        );
        wetGlass.addColorStop(0, "rgba(205, 225, 233, 0.04)");
        wetGlass.addColorStop(0.56, "rgba(167, 194, 204, 0.05)");
        wetGlass.addColorStop(0.72, "rgba(34, 67, 79, 0.18)");
        wetGlass.addColorStop(0.86, "rgba(231, 243, 247, 0.44)");
        wetGlass.addColorStop(1, "rgba(231, 243, 247, 0)");
        ctx.fillStyle = wetGlass;
        ctx.shadowColor = "rgba(8, 20, 26, 0.2)";
        ctx.shadowBlur = 10;
      }
      ctx.beginPath();
      ctx.moveTo(-size * 0.12, -size * 0.94);
      ctx.bezierCurveTo(size * 0.52, -size * 0.86, size * 0.8, -size * 0.16, size * 0.58, size * 0.48);
      ctx.bezierCurveTo(size * 0.35, size * 0.98, -size * 0.36, size * 1.02, -size * 0.64, size * 0.42);
      ctx.bezierCurveTo(-size * 0.88, -size * 0.08, -size * 0.64, -size * 0.8, -size * 0.12, -size * 0.94);
      ctx.closePath();
      ctx.fill();

      ctx.globalAlpha = alpha * 0.72;
      ctx.fillStyle = "rgba(248, 252, 253, 0.88)";
      ctx.shadowColor = "rgba(232, 245, 249, 0.7)";
      ctx.shadowBlur = 5;
      ctx.beginPath();
      ctx.ellipse(-size * 0.3, -size * 0.42, size * 0.1, size * 0.16, -0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const drawLightning = (seconds: number) => {
      if (!lightning) return;
      const envelope =
        previewMode === "lightning-peak"
          ? 1
          : lightningFlashAlpha(seconds, lightning.cycle, lightning.phase);
      if (envelope <= 0.002) return;
      const cycleIndex = Math.floor(seconds / lightning.cycle + lightning.phase);
      if (
        previewMode !== "lightning-peak" &&
        envelope >= 0.8 &&
        lastThunderCycleRef.current !== cycleIndex
      ) {
        lastThunderCycleRef.current = cycleIndex;
        onThunder?.();
      }
      const strength = lightning.strength * envelope * (mobileReduced ? 0.78 : 1);
      const sourceX = (lightning.sourceX * width) / 100;
      ctx.save();
      ctx.globalAlpha = strength;
      if (mobileReduced) {
        ctx.fillStyle = "rgba(215, 229, 236, 0.34)";
      } else {
        const glow = ctx.createRadialGradient(
          sourceX,
          -height * 0.16,
          0,
          sourceX,
          0,
          Math.max(width, height)
        );
        glow.addColorStop(0, "rgba(242, 247, 249, 0.96)");
        glow.addColorStop(0.36, "rgba(215, 229, 236, 0.58)");
        glow.addColorStop(1, "rgba(183, 205, 216, 0)");
        ctx.fillStyle = glow;
      }
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = strength * 0.28;
      ctx.fillStyle = "rgba(230, 239, 243, 0.72)";
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    };

    const draw = (time: number) => {
      if (!reducedMotion && mobileReduced && time - lastDrawTime < 1000 / 30) {
        rafId = window.requestAnimationFrame(draw);
        return;
      }
      lastDrawTime = time;
      clear();
      const seconds = time / 1000;
      marks.forEach((mark) => {
        const progress = reducedMotion ? 0.48 : (seconds / mark.duration + mark.phase) % 1;
        drawLensStreak(mark, progress);
      });
      if (!reducedMotion) {
        impacts.forEach((impact) => {
          drawLensImpact(impact, seconds, previewMode === "lens-impact" ? 0.46 : undefined);
        });
        drawLightning(seconds);
      }

      if (!reducedMotion) {
        rafId = window.requestAnimationFrame(draw);
      }
    };

    resize();
    window.addEventListener("resize", resize);
    rafId = window.requestAnimationFrame(draw);

    return () => {
      window.removeEventListener("resize", resize);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [impacts, lightning, marks, onThunder, previewMode]);

  if (marks.length === 0 && impacts.length === 0 && !lightning) return null;

  return (
    <div className="rain-screen-overlay rain-lens-overlay" aria-hidden="true" data-source={RAIN_SCREEN_OVERLAY_SOURCE}>
      <canvas ref={canvasRef} />
    </div>
  );
}

const sanitizeName = (value: string): string =>
  value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 18) || "Operator";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const requestMobileFullscreen = (): void => {
  if (
    document.fullscreenElement ||
    !window.matchMedia("(pointer: coarse)").matches ||
    typeof document.documentElement.requestFullscreen !== "function"
  ) {
    return;
  }
  void document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => undefined);
};

const formatPickupDetail = (pickupType: PickupType, value: number): string => {
  switch (PICKUP_CONFIG[pickupType].effect) {
    case "repair":
      return `+${Math.round(value)} HP restored`;
    case "armor":
      return value > 0 ? `+${Math.round(value)} armor + shield` : "Shield protection active";
    case "ammo":
      return `+${Math.round(value)} ammo, rapid fire`;
    case "speed":
      return `Speed x${value.toFixed(2)}`;
    case "ability":
      return `+${Math.round(value)} ability charge`;
    case "smoke":
      return "Damage dampening";
    case "explosive":
      return "Explosive rounds loaded";
  }
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const isInteractiveTarget = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  Boolean(target.closest("button, input, select, textarea, a, .interactive-panel"));

interface RoomLookupResponse {
  ok?: boolean;
  roomId?: string;
}

type SeatReservationPayload = Parameters<Client["consumeSeatReservation"]>[0];
const RECONNECT_TOKEN_STORAGE_KEY = "alpha7.reconnectionToken";
const ROOM_RECOVERY_STORAGE_KEY = "alpha7.roomRecovery";

interface RoomRecoveryPayload {
  lastJoinMode: JoinMode;
}

const readReconnectToken = (): string | null => {
  try {
    return window.sessionStorage.getItem(RECONNECT_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
};

const writeReconnectToken = (token: string | null): void => {
  try {
    if (token) {
      window.sessionStorage.setItem(RECONNECT_TOKEN_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(RECONNECT_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Session storage can be unavailable in locked-down browser modes.
  }
};

const readRoomRecovery = (): RoomRecoveryPayload | null => {
  try {
    const raw = window.sessionStorage.getItem(ROOM_RECOVERY_STORAGE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw) as Partial<RoomRecoveryPayload>;
    if (!["quick", "public", "private", "code"].includes(String(payload.lastJoinMode))) {
      return null;
    }
    return { lastJoinMode: payload.lastJoinMode as JoinMode };
  } catch {
    return null;
  }
};

const writeRoomRecovery = (payload: RoomRecoveryPayload | null): void => {
  try {
    if (payload) {
      window.sessionStorage.setItem(ROOM_RECOVERY_STORAGE_KEY, JSON.stringify(payload));
    } else {
      window.sessionStorage.removeItem(ROOM_RECOVERY_STORAGE_KEY);
    }
  } catch {
    // Session storage can be unavailable in locked-down browser modes.
  }
};

const resolveRoomIdByCode = async (
  httpEndpoint: string,
  roomCode: string
): Promise<string | null> => {
  const response = await fetch(`${httpEndpoint}/rooms/${encodeURIComponent(roomCode)}`);
  if (!response.ok) return null;
  const payload = (await response.json()) as RoomLookupResponse;
  return payload.ok && typeof payload.roomId === "string" && payload.roomId.trim()
    ? payload.roomId.trim()
    : null;
};

const reserveRoomByCode = async (
  httpEndpoint: string,
  roomCode: string,
  joinPayload: JoinMessagePayload
): Promise<SeatReservationPayload | null> => {
  const response = await fetch(`${httpEndpoint}/rooms/${encodeURIComponent(roomCode)}/reserve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(joinPayload)
  });
  return response.ok ? ((await response.json()) as SeatReservationPayload) : null;
};

const SITE_VISITOR_STORAGE_KEY = "alpha7.siteVisitorId";
const SITE_PRESENCE_HEARTBEAT_MS = 20_000;
const MENU_PRESENCE_HEARTBEAT_MS = 5_000;
const SITE_VISITOR_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const readSiteVisitorId = (): string => {
  try {
    const stored = window.localStorage.getItem(SITE_VISITOR_STORAGE_KEY);
    if (stored && SITE_VISITOR_ID_PATTERN.test(stored)) return stored;
    const visitorId = createSiteVisitorId();
    window.localStorage.setItem(SITE_VISITOR_STORAGE_KEY, visitorId);
    return visitorId;
  } catch {
    return createSiteVisitorId();
  }
};

const heartbeatSitePresence = async (
  httpEndpoint: string,
  visitorId: string,
  signal: AbortSignal
): Promise<number> => {
  const response = await fetch(`${httpEndpoint}/presence`, {
    body: visitorId,
    cache: "no-store",
    headers: { "Content-Type": "text/plain" },
    method: "POST",
    signal
  });
  if (!response.ok) throw new Error(`Presence request failed (${response.status})`);
  const playersOnline = parsePlayersOnline(await response.json());
  if (playersOnline === null) throw new Error("Presence response was invalid");
  return playersOnline;
};

const TANK_INFO_COLLAPSE_QUERY =
  "(pointer: coarse), (max-height: 760px) and (max-width: 1100px), (max-width: 760px)";
const MOBILE_PORTRAIT_QUERY = "(max-width: 760px) and (orientation: portrait)";

const shouldCollapseTankInfoForViewport = (): boolean =>
  typeof window !== "undefined" && window.matchMedia(TANK_INFO_COLLAPSE_QUERY).matches;

const isMobilePortraitViewport = (): boolean =>
  typeof window !== "undefined" && window.matchMedia(MOBILE_PORTRAIT_QUERY).matches;

const copyTextToClipboard = async (value: string): Promise<boolean> => {
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.inset = "0 auto auto 0";
  textArea.style.opacity = "0";
  textArea.style.pointerEvents = "none";
  document.body.appendChild(textArea);

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  textArea.focus({ preventScroll: true });
  textArea.select();
  textArea.setSelectionRange(0, textArea.value.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textArea);
    activeElement?.focus({ preventScroll: true });
  }

  if (copied) return true;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
  }

  return false;
};

const formatTime = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
};

const formatPlacement = (value: number): string => {
  if (value <= 0) return "--";
  const suffix =
    value % 100 >= 11 && value % 100 <= 13
      ? "th"
      : value % 10 === 1
        ? "st"
        : value % 10 === 2
          ? "nd"
          : value % 10 === 3
            ? "rd"
            : "th";
  return `${value}${suffix}`;
};

const createSeed = (): string => `A7-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const getSafeZoneRadius = (snapshot: ClientSnapshot): number =>
  snapshot.zone.radius > 0 ? snapshot.zone.radius : snapshot.zone.targetRadius;

const isOutsideSafeZone = (snapshot: ClientSnapshot, pose: Pick<LocalPose, "x" | "y">): boolean => {
  const radius = getSafeZoneRadius(snapshot);
  if (radius <= 8) return false;
  return Math.hypot(pose.x - snapshot.zone.x, pose.y - snapshot.zone.y) > radius;
};

const abilityIconPath = (
  abilityType: ClientPlayer["abilityType"],
  assetManifest: Alpha7AssetManifest | null
): string | undefined => {
  if (abilityType === "repair") return assetManifest?.ui?.icons?.repair;
  if (abilityType === "shield_pulse") return assetManifest?.ui?.icons?.shield;
  if (abilityType === "barrage") return assetManifest?.ui?.icons?.reticle;
  return undefined;
};

const abilityIcon = (
  abilityType: ClientPlayer["abilityType"],
  size = 21,
  assetManifest: Alpha7AssetManifest | null = null
) => {
  const iconPath = abilityIconPath(abilityType, assetManifest);
  if (iconPath) {
    return <img alt="" className="hud-icon-img" height={size} src={iconPath} width={size} />;
  }

  switch (abilityType) {
    case "repair":
      return <Wrench size={size} />;
    case "shield_pulse":
      return <Shield size={size} />;
    case "speed_burst":
      return <Zap size={size} />;
    case "barrage":
      return <Target size={size} />;
    default:
      return <RadioTower size={size} />;
  }
};

function Dots({ value }: { value: number }) {
  return (
    <span className="dots" aria-label={`${value} of 5`}>
      {Array.from({ length: 5 }, (_, index) => (
        <span className={index < value ? "dot is-filled" : "dot"} key={index} />
      ))}
    </span>
  );
}

function TankCard({
  selected,
  tank,
  onSelect
}: {
  selected: boolean;
  tank: (typeof TANK_ARCHETYPE_CONFIG)[TankArchetypeId];
  onSelect: () => void;
}) {
  return (
    <button
      aria-pressed={selected}
      className={selected ? "tank-card is-selected" : "tank-card"}
      data-audio-cue="select"
      onClick={onSelect}
      type="button"
    >
      <span className="tank-card-title">
        <strong>{tank.name}</strong>
        <small>{tank.role}</small>
      </span>
      <span className="tank-card-description">{tank.description}</span>
      {statLabels.map((label) => (
        <span className="stat-row" key={label}>
          <em>{label}</em>
          <Dots value={tank.stats[label]} />
        </span>
      ))}
    </button>
  );
}

function NetworkBadge({
  status,
  endpoint
}: {
  status: ConnectionStatus;
  endpoint: string;
}) {
  const label =
    status === "connected"
      ? "online"
      : status === "connecting"
        ? "linking"
        : status === "error"
          ? "error"
          : status === "offline"
            ? "offline"
            : "idle";
  return (
    <span className={`network-badge is-${status}`}>
      {status === "error" || status === "offline" ? <WifiOff size={14} /> : <RadioTower size={14} />}
      <span>{label}</span>
      <b>{endpoint.replace(/^wss?:\/\//, "")}</b>
    </span>
  );
}

function PlayerRow({ player }: { player: ClientPlayer }) {
  return (
    <li className={player.isSelf ? "player-row is-self" : "player-row"}>
      <span className="player-index">{player.isHost ? "H" : player.isReady ? "R" : "--"}</span>
      <span className="player-dot" />
      <span className="player-name">{player.name}</span>
      <span className="player-kit">{TANK_ARCHETYPE_CONFIG[player.archetypeId].name}</span>
    </li>
  );
}

function AgentOwnerRows({ now, owner, players }: {
  now: number;
  owner: ClientSnapshot["owners"][number];
  players: ClientPlayer[];
}) {
  const human = players.find((player) => player.sessionId === owner.humanSessionId);
  const agent = players.find((player) => player.sessionId === owner.agentSeatId);
  return (
    <Fragment>
      {human ? <PlayerRow player={human} /> : null}
      <li className={`player-row is-agent-child is-${owner.agentSeatState}`}>
        <span className="player-index">AI</span>
        <span className="player-dot" />
        <span className="player-name">{agent?.name || owner.agentLabel || "Owned Agent"}</span>
        <span className="player-kit">
          {agent
            ? TANK_ARCHETYPE_CONFIG[agent.archetypeId].name
            : agentSeatStatusLabel(owner.agentSeatState, owner.agentPairingExpiresAtMs || null, now)}
        </span>
      </li>
    </Fragment>
  );
}

const agentSeatStatusLabel = (state: AgentSeatState, expiresAtMs: number | null, now: number): string => {
  if (state === "pending") {
    if (expiresAtMs === null) return "Pairing";
    const remainingSeconds = Math.max(0, Math.ceil(((expiresAtMs ?? now) - now) / 1000));
    return `Pairing ${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`;
  }
  if (state === "none") return "Not connected";
  return state.charAt(0).toUpperCase() + state.slice(1);
};

const agentRoomUiFromState = (
  state: Alpha7StateSchema,
  selfSessionId: string,
  previous: AgentRoomUi
): AgentRoomUi => {
  const mode = state.policy?.mode ?? "classic";
  const players = Array.from(state.players.values());
  const owners = Array.from(state.owners.values());
  const selfOwner = owners.find((owner) => owner.humanSessionId === selfSessionId);
  const selfPlayer = state.players.get(selfSessionId);
  const selfOwnerId = selfOwner?.ownerId || selfPlayer?.ownerId;
  const resolvedOwner = selfOwner ?? owners.find((owner) => owner.ownerId === selfOwnerId);
  const agentState = resolvedOwner?.agentSeatState ?? "none";
  const pairingStillActive = agentState === "pending";
  const readiness = agentRoomReadiness(mode, owners, resolvedOwner?.ownerId);

  return {
    mode,
    humanCount: owners.length || players.filter((player) => player.controlKind === "human").length,
    agentCount: activeAgentControlCount(owners),
    pendingAgentCount: owners.filter((owner) => owner.agentSeatState === "pending").length,
    combatantCount: players.filter((player) => !player.isSpectator).length,
    ownerCap: state.policy?.ownerCap ?? 8,
    agentControlCap: state.policy?.agentControlCap ?? 0,
    combatantCap: state.policy?.combatantCap ?? 8,
    tacticalReflexEnabled: state.policy?.tacticalReflexEnabled ?? false,
    agentLabel: resolvedOwner?.agentLabel || previous.agentLabel,
    agentState,
    requestId: pairingStillActive ? previous.requestId : null,
    pairingCode: pairingStillActive ? previous.pairingCode : null,
    expiresAtMs: pairingStillActive ? previous.expiresAtMs : null,
    openingTactic: previous.openingTactic,
    ...readiness
  };
};

export const agentOpeningTacticSummary = (tactic: AgentTacticalIntentV1): string => {
  const objective = tactic.objective.type === "zone_center"
    ? "Zone centre"
    : tactic.objective.type === "engage_nearest"
      ? "Engage nearest opponent"
    : tactic.objective.type === "move_to"
      ? `Move to ${Math.round(tactic.objective.position.x)}, ${Math.round(tactic.objective.position.z)}`
      : tactic.objective.type === "engage_target"
        ? "Engage selected target"
        : tactic.objective.type === "collect_pickup"
          ? "Collect selected pickup"
          : "Hold position";
  const fire = tactic.fire === "none" ? "No fire" : tactic.fire === "single" ? "Fire once" : "Fire continuously";
  const ability = tactic.useAbility === false ? "No ability" : "Use ability once";
  const positioning = tactic.objective.type === "engage_nearest" || tactic.objective.type === "engage_target"
    ? "Spacing, obstacle escape, firing lanes + zone safety · "
    : "";
  return `${objective} · ${positioning}${fire} · ${ability} · ${Math.round(tactic.validForMs / 1_000)}s`;
};

function AgentLobbyPanel({
  roomCode,
  setupOpen,
  ui,
  onCancelPairing,
  onCloseSetup,
  onControl,
  onCopyOrCreatePairing,
  onOpenSetup,
  onUseBrowser,
  webMcpSupported
}: {
  roomCode: string;
  setupOpen: boolean;
  ui: AgentRoomUi;
  onCancelPairing: () => void;
  onCloseSetup: () => void;
  onControl: (action: AgentControlAction) => void;
  onCopyOrCreatePairing: () => void;
  onOpenSetup: () => void;
  onUseBrowser: () => void;
  webMcpSupported: boolean;
}) {
  const canOpenSetup = ui.agentState === "none" || ui.agentState === "revoked" || ui.agentState === "disconnected";
  const pairingPending = ui.agentState === "pending";
  const hasLiveControl = ui.agentState === "connected" || ui.agentState === "paused";
  const canDisconnect = hasLiveControl || ui.agentState === "reconnecting";

  return (
    <section className="agent-lobby-panel" aria-label="Owned agent setup">
      <dl className="agent-room-counts" aria-label="Room participants">
        <div><dt>Humans</dt><dd>{ui.humanCount}/{ui.ownerCap}</dd></div>
        <div><dt>Agents</dt><dd>{ui.agentCount}/{ui.agentControlCap}</dd></div>
        <div><dt>Combatants</dt><dd>{ui.combatantCount}/{ui.combatantCap}</dd></div>
      </dl>
      {canOpenSetup || pairingPending || canDisconnect ? (
        <div className="agent-control-actions">
          {canOpenSetup ? (
            <button className="secondary-button" onClick={onOpenSetup} type="button">Connect Agent</button>
          ) : null}
          {pairingPending ? (
            <button className="secondary-button" onClick={onCancelPairing} type="button">Cancel Pairing</button>
          ) : null}
          {hasLiveControl ? (
            <button
              className="secondary-button"
              onClick={() => onControl(ui.agentState === "paused" ? "resume" : "pause")}
              type="button"
            >
              {ui.agentState === "paused" ? "Resume" : "Pause"}
            </button>
          ) : null}
          {canDisconnect ? (
            <button className="secondary-button" onClick={() => onControl("disconnect")} type="button">
              Disconnect
            </button>
          ) : null}
        </div>
      ) : null}
      {setupOpen || pairingPending ? (
        <div className="agent-pairing-panel">
          <p>Allow {ui.agentLabel} to use 1 agent seat in ROOM {roomCode} until this room ends?</p>
          {ui.tacticalReflexEnabled ? (
            <p>Round opening · {agentOpeningTacticSummary(ui.openingTactic)}</p>
          ) : null}
          <button
            className="secondary-button"
            disabled={!webMcpSupported}
            onClick={onUseBrowser}
            title={webMcpSupported ? "Connect through this browser's site tools" : "Site tools unavailable"}
            type="button"
          >
            Use This Browser
          </button>
          <button className="primary-button" onClick={onCopyOrCreatePairing} type="button">
            <Copy size={15} />
            Copy One-Time Code
          </button>
          {ui.pairingCode ? <code className="agent-pairing-code">{ui.pairingCode}</code> : null}
          <details className="agent-setup-details">
            <summary>Codex / CLI Setup</summary>
            <p>Give the code to your agent and ask it to open alpha7.asabeko.com/agent. If site tools are unavailable, run the public connector:</p>
            <code>npx --yes github:Kbediako/alpha7-agent#v0.2.0</code>
          </details>
          {!webMcpSupported ? (
            <p className="agent-browser-note">Site tools aren’t available here. Copy a one-time code or use the Codex / CLI connector.</p>
          ) : null}
          {!pairingPending ? (
            <button className="agent-setup-close" onClick={onCloseSetup} type="button">Cancel</button>
          ) : null}
        </div>
      ) : null}
      {ui.readinessBlocked ? <p className="agent-ready-note">Resolve agent setup before readying this room.</p> : null}
    </section>
  );
}

function RoomModeDialog({
  joinMode,
  onCancel,
  onSelect
}: {
  joinMode: MatchmakingJoinMode;
  onCancel: () => void;
  onSelect: (mode: RoomMode) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onCancel();
    };
    dialog.addEventListener("cancel", handleCancel);
    if (!dialog.open) dialog.showModal();
    dialog.focus();
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      if (dialog.open) dialog.close();
      returnFocus?.focus();
    };
  }, [onCancel]);

  return (
    <dialog
      aria-labelledby="room-mode-dialog-title"
      className="room-mode-dialog"
      ref={dialogRef}
      tabIndex={-1}
    >
      <div className="panel-heading">
        <span id="room-mode-dialog-title">Select Mode</span>
        <span>{joinMode}</span>
      </div>
      <div className="room-mode-dialog-grid">
        {ROOM_MODE_OPTIONS.map((mode) => (
          <button
            className="room-mode-dialog-option"
            key={mode.id}
            onClick={() => onSelect(mode.id)}
            type="button"
          >
            <strong>{mode.label}</strong>
            <span>{mode.description}</span>
            {mode.id !== "classic" ? <small>Custom / Unranked</small> : <small>Standard</small>}
          </button>
        ))}
      </div>
      <button className="secondary-button room-mode-dialog-cancel" onClick={onCancel} type="button">Back</button>
    </dialog>
  );
}

function AgentControlDialog({
  action,
  agentLabel,
  onCancel,
  onConfirm
}: {
  action: ConfirmedAgentControlAction;
  agentLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onCancel();
    };
    dialog.addEventListener("cancel", handleCancel);
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      if (dialog.open) dialog.close();
      returnFocus?.focus();
    };
  }, [onCancel]);

  const disconnecting = action === "disconnect";
  return (
    <dialog
      aria-describedby="agent-control-dialog-description"
      aria-labelledby="agent-control-dialog-title"
      className="room-mode-dialog agent-control-dialog"
      ref={dialogRef}
    >
      <div className="panel-heading">
        <span id="agent-control-dialog-title">Confirm Agent Control</span>
        <span>{disconnecting ? "Disconnect" : "Resume"}</span>
      </div>
      <p id="agent-control-dialog-description">
        {disconnecting
          ? `Disconnect ${agentLabel} and revoke its control for this round?`
          : `Resume ${agentLabel} and allow it to control its tank again?`}
      </p>
      <div className="agent-control-dialog-actions">
        <button className="secondary-button" onClick={onCancel} type="button">Cancel</button>
        <button className="primary-button" onClick={onConfirm} type="button">
          {disconnecting ? "Disconnect Agent" : "Resume Agent"}
        </button>
      </div>
    </dialog>
  );
}

const isManagedAgentState = (state: AgentSeatState): boolean =>
  state === "connected" || state === "paused" || state === "reconnecting";

function AgentStatusControls({
  className = "",
  onControl,
  ui
}: {
  className?: string;
  onControl: (action: AgentControlAction) => void;
  ui: AgentRoomUi;
}) {
  if (!isManagedAgentState(ui.agentState)) return null;
  const status = ui.agentState === "connected" ? "Live" : ui.agentState;
  return (
    <details className={`agent-status-controls is-${ui.agentState}${className ? ` ${className}` : ""}`}>
      <summary aria-label={`Manage ${ui.agentLabel}, ${status}`}>
        <RadioTower size={14} />
        <span>Agent</span>
        <strong aria-live="polite">{status}</strong>
      </summary>
      <div className="agent-status-actions">
        {ui.agentState === "connected" ? (
          <button onClick={() => onControl("pause")} type="button">Pause</button>
        ) : ui.agentState === "paused" ? (
          <button onClick={() => onControl("resume")} type="button">Resume</button>
        ) : null}
        <button onClick={() => onControl("disconnect")} type="button">Disconnect</button>
      </div>
    </details>
  );
}

function MenuPanel({
  connectionStatus,
  endpoint,
  joinCode,
  networkMessage,
  pendingJoinMode,
  playersOnline,
  playerName,
  selectedTank,
  showNetworkDiagnostics,
  setJoinCode,
  setPlayerName,
  setSelectedTank,
  onBeginMatchmaking,
  onCloseModeDialog,
  onJoin,
  onSelectRoomMode
}: {
  connectionStatus: ConnectionStatus;
  endpoint: string;
  joinCode: string;
  networkMessage: string;
  pendingJoinMode: MatchmakingJoinMode | null;
  playersOnline: number | null;
  playerName: string;
  selectedTank: TankArchetypeId;
  showNetworkDiagnostics: boolean;
  setJoinCode: (value: string) => void;
  setPlayerName: (value: string) => void;
  setSelectedTank: (value: TankArchetypeId) => void;
  onBeginMatchmaking: (mode: MatchmakingJoinMode) => void;
  onCloseModeDialog: () => void;
  onJoin: (mode: JoinMode) => void;
  onSelectRoomMode: (mode: RoomMode) => void;
}) {
  const isConnecting = connectionStatus === "connecting";
  const showIphoneStandaloneHint = shouldShowIphoneStandaloneHint(
    navigator.userAgent,
    window.matchMedia("(display-mode: standalone)").matches,
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
  return (
    <>
      <section className="landing-panel hud-panel interactive-panel" aria-label="Alpha-7 join panel">
        <div className="panel-heading">
          <span>Room Protocol</span>
          <span>{BATTLE_ROYALE_ROOM}</span>
        </div>
        <h1>Alpha-7</h1>
        <form
          className="join-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (joinCode.trim()) onJoin("code");
            else onBeginMatchmaking("quick");
          }}
        >
          <label>
            Callsign
            <input
              autoComplete="nickname"
              maxLength={18}
              name="playerName"
              onChange={(event) => setPlayerName(event.target.value)}
              placeholder="Operator"
              value={playerName}
            />
          </label>
          <div className="action-grid">
            <button
              className="primary-button"
              data-audio-cue="confirm"
              disabled={isConnecting}
              onClick={() => onBeginMatchmaking("quick")}
              type="button"
            >
              <Play size={17} />
              Quick Play
            </button>
            <button
              className="secondary-button"
              data-audio-cue="confirm"
              disabled={isConnecting}
              onClick={() => onBeginMatchmaking("public")}
              type="button"
            >
              <Unlock size={17} />
              Public
            </button>
            <button
              className="secondary-button"
              data-audio-cue="confirm"
              disabled={isConnecting}
              onClick={() => onBeginMatchmaking("private")}
              type="button"
            >
              <Lock size={17} />
              Private
            </button>
          </div>
          <div className="room-code-entry">
            <label>
              Room Code
              <input
                autoCapitalize="off"
                autoCorrect="off"
                maxLength={16}
                onChange={(event) => setJoinCode(event.target.value)}
                placeholder="A7CODE / room ID"
                spellCheck={false}
                value={joinCode}
              />
            </label>
            <button
              aria-label="Join room by code"
              className="secondary-button"
              data-audio-cue="confirm"
              disabled={isConnecting || !joinCode.trim()}
              onClick={() => onJoin("code")}
              type="button"
            >
              <Target size={17} />
              Join
            </button>
          </div>
        </form>
        <div className="online-count" role="status">
          {playersOnline !== null ? <span aria-hidden="true" className="online-count-dot" /> : null}
          <strong>{playersOnline ?? "—"}</strong>
          <span>{playersOnline === 1 ? "Player online" : "Players online"}</span>
        </div>
        {showIphoneStandaloneHint ? (
          <aside className="iphone-fullscreen-note" role="note">
            <SquareArrowUp aria-hidden="true" size={17} />
            <span>
              <strong>Full-screen on iPhone</strong>
              In Safari, tap Share → Add to Home Screen, then open Alpha-7 from its icon.
            </span>
          </aside>
        ) : null}
        {networkMessage &&
        (showNetworkDiagnostics || connectionStatus === "error" || connectionStatus === "offline") ? (
          <p aria-live="polite" className="network-message" role="status">
            {networkMessage}
          </p>
        ) : null}
        {showNetworkDiagnostics ? <NetworkBadge endpoint={endpoint} status={connectionStatus} /> : null}
      </section>

      {AGENT_PLAY_ENABLED && pendingJoinMode ? (
        <RoomModeDialog
          joinMode={pendingJoinMode}
          onCancel={onCloseModeDialog}
          onSelect={onSelectRoomMode}
        />
      ) : null}

      <section className="tank-select hud-panel interactive-panel" aria-label="Tank selection">
        <div className="panel-heading">
          <span>Tank Kit</span>
          <span>4 Chassis</span>
        </div>
        <div className="tank-grid">
          {archetypes.map((tank) => (
            <TankCard
              key={tank.id}
              onSelect={() => setSelectedTank(tank.id)}
              selected={tank.id === selectedTank}
              tank={tank}
            />
          ))}
        </div>
      </section>
    </>
  );
}

function LobbyPanel({
  agentRoomUi,
  agentSetupOpen,
  connectionStatus,
  endpoint,
  networkMessage,
  now,
  showNetworkDiagnostics,
  snapshot,
  onCopyCode,
  onCancelAgentPairing,
  onCloseAgentSetup,
  onControlAgent,
  onCopyOrCreateAgentPairing,
  onLeave,
  onOpenAgentSetup,
  onUseBrowserAgent,
  onReady,
  onStart,
  webMcpSupported
}: {
  agentRoomUi: AgentRoomUi;
  agentSetupOpen: boolean;
  connectionStatus: ConnectionStatus;
  endpoint: string;
  networkMessage: string;
  now: number;
  showNetworkDiagnostics: boolean;
  snapshot: ClientSnapshot;
  onCopyCode: () => void;
  onCancelAgentPairing: () => void;
  onCloseAgentSetup: () => void;
  onControlAgent: (action: AgentControlAction) => void;
  onCopyOrCreateAgentPairing: () => void;
  onLeave: () => void;
  onOpenAgentSetup: () => void;
  onUseBrowserAgent: () => void;
  onReady: () => void;
  onStart: () => void;
  webMcpSupported: boolean;
}) {
  const self = snapshot.self;
  const humanPlayers = snapshot.players.filter((player) => player.controlKind === "human");
  const readyCount = humanPlayers.filter((player) => player.isReady).length;
  const canStart = canStartRoom(
    agentRoomUi.mode,
    Boolean(self?.isHost),
    humanPlayers.length,
    readyCount,
    agentRoomUi.startBlocked
  );
  const countdown = snapshot.matchState === "countdown" ? formatTime(snapshot.countdownEndsAt - now) : null;

  return (
    <section className="lobby-panel hud-panel interactive-panel" aria-label="Lobby waiting room">
      <div className="panel-heading">
        <span>{snapshot.matchState === "countdown" ? "Countdown" : "Waiting Room"}</span>
        <span>{readyCount}/{humanPlayers.length} Ready</span>
      </div>
      <div className="room-code-display">
        <span>{snapshot.roomCode}</span>
        <button aria-label="Copy room code" className="icon-button" data-audio-cue="select" onClick={onCopyCode} type="button">
          <Copy size={17} />
        </button>
      </div>
      {AGENT_PLAY_ENABLED ? (
        <div className="agent-mode-summary room-mode-summary" aria-label="Room mode">
          <span>Room Mode</span>
          <strong>{ROOM_MODE_OPTIONS.find((mode) => mode.id === agentRoomUi.mode)?.label ?? "Classic"}</strong>
          <small>{agentRoomUi.mode === "classic" ? "Standard" : "Custom / Unranked"}</small>
        </div>
      ) : null}
      {countdown ? <div className="countdown-block">{countdown}</div> : null}
      <ul className="player-list">
        {agentRoomUi.mode === "classic"
          ? snapshot.players.map((player) => <PlayerRow key={player.sessionId} player={player} />)
          : snapshot.owners.map((owner) => (
              <AgentOwnerRows key={owner.ownerId} now={now} owner={owner} players={snapshot.players} />
            ))}
      </ul>
      {AGENT_PLAY_ENABLED && agentRoomUi.mode !== "classic" ? (
        <AgentLobbyPanel
          onCancelPairing={onCancelAgentPairing}
          onCloseSetup={onCloseAgentSetup}
          onControl={onControlAgent}
          onCopyOrCreatePairing={onCopyOrCreateAgentPairing}
          onOpenSetup={onOpenAgentSetup}
          onUseBrowser={onUseBrowserAgent}
          roomCode={snapshot.roomCode}
          setupOpen={agentSetupOpen}
          ui={agentRoomUi}
          webMcpSupported={webMcpSupported}
        />
      ) : null}
      <div className="lobby-actions">
        <button
          aria-pressed={Boolean(self?.isReady)}
          className={`${self?.isReady ? "secondary-button is-active" : "primary-button"} match-cta-orange`}
          data-audio-cue="ready"
          disabled={agentRoomUi.readinessBlocked}
          onClick={onReady}
          type="button"
        >
          <Check size={17} />
          {self?.isReady ? "Cancel Ready" : "Ready Up"}
        </button>
        <button
          className="secondary-button"
          data-audio-cue="confirm"
          disabled={!canStart}
          onClick={onStart}
          type="button"
        >
          <Play size={17} />
          Start
        </button>
        <button aria-label="Leave room" className="icon-button" data-audio-cue="back" onClick={onLeave} type="button">
          <LogOut size={17} />
        </button>
      </div>
      {networkMessage && (
        showNetworkDiagnostics ||
        networkMessage.startsWith("Room code") ||
        agentRoomUi.mode !== "classic"
      ) ? (
        <p aria-live="polite" className="network-message" role="status">
          {networkMessage}
        </p>
      ) : null}
      {showNetworkDiagnostics ? <NetworkBadge endpoint={endpoint} status={connectionStatus} /> : null}
    </section>
  );
}

function MatchHeader({
  now,
  outsideSafeZone,
  snapshot
}: {
  now: number;
  outsideSafeZone: boolean;
  snapshot: ClientSnapshot;
}) {
  const timer =
    snapshot.matchState === "countdown"
      ? formatTime(snapshot.countdownEndsAt - now)
      : snapshot.matchEndsAt > 0
        ? formatTime(snapshot.matchEndsAt - now)
        : "--:--";
  const aliveCount = isActiveMatchState(snapshot.matchState)
    ? snapshot.alivePlayers
    : snapshot.players.filter((player) => !player.isSpectator).length;
  const rosterCount = Math.max(1, snapshot.players.filter((player) => !player.isSpectator).length);
  const aliveRatio = clamp(aliveCount / rosterCount, 0, 1);
  const pressureRatio = isActiveMatchState(snapshot.matchState) ? 1 - aliveRatio : 0;
  const modeLabel = outsideSafeZone
    ? "ZONE BREACH"
    : isActiveMatchState(snapshot.matchState)
      ? "BATTLE ROYALE"
      : snapshot.matchState.replace("_", " ").toUpperCase();

  return (
    <section className={outsideSafeZone ? "hud-panel match-header is-alert" : "hud-panel match-header"} aria-label="Match status">
      <div className="match-header-top">
        <span>ROOM {snapshot.roomCode}</span>
        <strong>{timer}</strong>
        <span>{modeLabel}</span>
      </div>
      <div className="match-pressure-row" aria-label={`${aliveCount} of ${rosterCount} tanks active`}>
        <b>{aliveCount}</b>
        <span className="match-pressure-track">
          <i className="match-pressure-safe" style={{ width: `${aliveRatio * 100}%` }} />
          <i className="match-pressure-threat" style={{ width: `${pressureRatio * 100}%` }} />
          <em style={{ left: `${aliveRatio * 100}%` }} />
        </span>
        <b>{rosterCount}</b>
      </div>
    </section>
  );
}

function MiniMap({
  expanded,
  now,
  onToggleExpanded,
  outsideSafeZone,
  snapshot,
  localPose
}: {
  expanded: boolean;
  now: number;
  onToggleExpanded: () => void;
  outsideSafeZone: boolean;
  snapshot: ClientSnapshot;
  localPose: LocalPose;
}) {
  const visibleWalls = snapshot.map.walls.filter((wall) => !isOuterBoundaryWall(wall, snapshot.map));
  const zoneRadius = getSafeZoneRadius(snapshot);
  const targetRadius = snapshot.zone.targetRadius;
  const viewWidth = Math.max(1, snapshot.map.width);
  const viewHeight = Math.max(1, snapshot.map.height);
  const mapX = (x: number, min = 0, max = 100): number => clamp((x / viewWidth) * 100, min, max);
  const mapY = (y: number, min = 0, max = 100): number => clamp((y / viewHeight) * 100, min, max);
  const markers = snapshot.players
    .filter((player) => {
      if (player.isSpectator) return false;
      return player.isSelf || !isPlayerConcealedBySmoke(player, now);
    })
    .map((player) => {
      const x = player.isSelf ? localPose.x : player.x;
      const y = player.isSelf ? localPose.y : player.y;
      return {
        id: player.sessionId,
        isSelf: player.isSelf,
        left: mapX(x, 2, 98),
        top: mapY(y, 2, 98)
      };
    });
  const zoneWidth = zoneRadius > 0 ? (zoneRadius * 2 * 100) / viewWidth : 0;
  const zoneHeight = zoneRadius > 0 ? (zoneRadius * 2 * 100) / viewHeight : 0;
  const targetWidth = targetRadius > 0 ? (targetRadius * 2 * 100) / viewWidth : 0;
  const targetHeight = targetRadius > 0 ? (targetRadius * 2 * 100) / viewHeight : 0;
  const zoneLeft = mapX(snapshot.zone.x);
  const zoneTop = mapY(snapshot.zone.y);
  const targetLeft = mapX(snapshot.zone.targetX);
  const targetTop = mapY(snapshot.zone.targetY);
  const mapFrameStyle: CSSProperties = {
    aspectRatio: `${viewWidth} / ${viewHeight}`
  };
  return (
    <section
      className={`${outsideSafeZone ? "hud-panel minimap-panel interactive-panel is-alert" : "hud-panel minimap-panel interactive-panel"}${
        expanded ? " is-expanded" : ""
      }`}
      aria-label="Minimap"
    >
      <div className="minimap-grid">
        <div className="minimap-map" style={mapFrameStyle}>
          {zoneRadius > 0 ? (
            <span
              className="minimap-zone is-current"
              style={{
                height: `${zoneHeight}%`,
                left: `${zoneLeft}%`,
                top: `${zoneTop}%`,
                width: `${zoneWidth}%`
              }}
            />
          ) : null}
          {snapshot.zone.targetRadius > 0 ? (
            <span
              className="minimap-zone is-target"
              style={{
                height: `${targetHeight}%`,
                left: `${targetLeft}%`,
                top: `${targetTop}%`,
                width: `${targetWidth}%`
              }}
            />
          ) : null}
          {visibleWalls.map((wall) => (
            <span
              className="minimap-wall"
              key={wall.id}
              style={{
                left: `${mapX(wall.x)}%`,
                top: `${mapY(wall.y)}%`,
                width: `${clamp((wall.width / viewWidth) * 100, 1, 100)}%`,
                height: `${clamp((wall.height / viewHeight) * 100, 1, 100)}%`
              }}
            />
          ))}
          {snapshot.pickups.filter((pickup) => pickup.isActive).slice(0, 24).map((pickup) => (
            <span
              className={`minimap-pickup is-${PICKUP_CONFIG[pickup.pickupType].effect}`}
              key={pickup.id}
              style={{
                left: `${mapX(pickup.x, 1, 99)}%`,
                top: `${mapY(pickup.y, 1, 99)}%`
              }}
            />
          ))}
          {markers.map((marker) => (
            <span
              className={marker.isSelf ? (outsideSafeZone ? "self-marker is-alert" : "self-marker") : "threat-marker"}
              key={marker.id}
              style={{ left: `${marker.left}%`, top: `${marker.top}%` }}
            />
          ))}
        </div>
      </div>
      <footer className="minimap-controls">
        <button aria-label={expanded ? "Toggle minimap compact" : "Toggle minimap expanded"} onClick={onToggleExpanded} type="button">
          M
        </button>
      </footer>
    </section>
  );
}

function TankStatusCard({
  agentRoomUi,
  collapsed,
  onControlAgent,
  onToggle,
  player
}: {
  agentRoomUi: AgentRoomUi;
  collapsed: boolean;
  onControlAgent: (action: AgentControlAction) => void;
  onToggle: () => void;
  player: ClientPlayer | null;
}) {
  if (!player) return null;
  const tank = TANK_ARCHETYPE_CONFIG[player.archetypeId];
  const healthRatio = clamp(player.health / Math.max(1, player.maxHealth), 0, 1);
  const armorRatio = clamp(player.armor / Math.max(1, player.maxArmor), 0, 1);
  const healthPips = 7;
  const hotPips = Math.ceil(healthRatio * healthPips);
  const weapon = WEAPON_CONFIG[player.weaponType];
  const ammo = player.ammo > 0 ? player.ammo : weapon.category === "rapid" ? 60 : 24;

  return (
    <section className={collapsed ? "hud-panel tank-status-card interactive-panel is-collapsed" : "hud-panel tank-status-card interactive-panel"} aria-label="Tank status">
      <div className="tank-status-head">
        <span>
          <strong>{tank.name}</strong>
          <em>{tank.role}</em>
        </span>
        <b>{player.name}</b>
        <button aria-label={collapsed ? "Expand tank status" : "Collapse tank status"} className="tank-status-toggle" onClick={onToggle} type="button">
          {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
      </div>
      {collapsed ? (
        <div className="tank-status-summary">
          <span>HP {Math.round(player.health)}</span>
          <span>AR {Math.round(player.armor)}</span>
          <span>{WEAPON_CONFIG[player.weaponType].name}</span>
        </div>
      ) : (
        <>
          <div className="tank-health-pips" aria-label={`${Math.round(player.health)} health`}>
            {Array.from({ length: healthPips }, (_, index) => (
              <i className={index < hotPips ? "is-hot" : ""} key={index} />
            ))}
            <span>{Math.round(player.health)} / {player.maxHealth}</span>
          </div>
          <div className="tank-schematic" aria-hidden="true">
            <span className="schematic-hull" />
            <span className="schematic-turret" />
            <span className="schematic-barrel" />
          </div>
          <div className="tank-loadout-list">
            <span>
              <b>1</b>
              {weapon.name}
              <em>{ammo}</em>
            </span>
            <span>
              <b>2</b>
              Armor
              <em>{Math.round(armorRatio * 100)}%</em>
            </span>
          </div>
        </>
      )}
      <AgentStatusControls className="tank-agent-status" onControl={onControlAgent} ui={agentRoomUi} />
    </section>
  );
}

function WeaponStrip({
  now,
  pickupNotice,
  player
}: {
  now: number;
  pickupNotice: PickupNotice | null;
  player: ClientPlayer | null;
}) {
  if (!player) return null;
  const activePickup = pickupNotice && pickupNotice.expiresAt > now ? pickupNotice : null;
  const pickupSeconds = activePickup ? Math.ceil((activePickup.expiresAt - now) / 1000) : 0;
  const pickupDetail = activePickup
    ? `${activePickup.detail}${activePickup.durationMs > 0 ? ` · ${pickupSeconds}s` : ""}`
    : "Diamond pickups grant combat buffs";
  return (
    <section
      aria-label="Pickup status"
      aria-live="polite"
      className={activePickup ? "hud-panel weapon-strip has-pickup" : "hud-panel weapon-strip"}
      role="status"
    >
      <span className={activePickup ? "weapon-strip-cell is-pickup is-active" : "weapon-strip-cell is-pickup"}>
        <span className="pickup-strip-title">
          <Zap size={14} />
          {activePickup ? activePickup.name : "Power-up"}
        </span>
        <span className="pickup-strip-detail">
          {pickupDetail}
        </span>
      </span>
    </section>
  );
}

const abilityWouldHaveEffect = (player: ClientPlayer): boolean =>
  player.abilityType !== "repair" ||
  player.health < player.maxHealth ||
  player.armor < player.maxArmor;

const abilityActiveRemainingMs = (player: ClientPlayer, now: number): number => {
  if (player.abilityType === "barrage") {
    return player.weaponType === "explosive" && player.ammo > 0 ? Number.POSITIVE_INFINITY : 0;
  }
  if (player.abilityType === "smoke") {
    return isPlayerConcealedBySmoke(player, now) ? Math.max(0, player.smokeEndsAt - now) : 0;
  }
  if (player.lastAbilityType !== player.abilityType) return 0;
  if (player.abilityType === "shield_pulse" && player.shield <= 0) return 0;
  if (player.abilityType === "speed_burst" && player.speedMultiplier <= 1) return 0;
  return Math.max(0, player.lastAbilityEndsAt - now);
};

function AbilityDock({
  assetManifest,
  now,
  player,
  onAbility
}: {
  assetManifest: Alpha7AssetManifest | null;
  now: number;
  player: ClientPlayer | null;
  onAbility: (abilityType?: ClientPlayer["abilityType"]) => void;
}) {
  if (!player) return null;
  const ability = ABILITY_CONFIG[player.abilityType];
  const chargeTarget = Math.max(ability.chargeCost, 100);
  const chargeRatio = clamp(player.abilityCharge / chargeTarget, 0, 1);
  const chargePercent = Math.round(chargeRatio * 100);
  const hasEffect = abilityWouldHaveEffect(player);
  const ready =
    player.abilityCharge >= ability.chargeCost &&
    player.abilityCooldownMs <= 0 &&
    hasEffect;
  const activeRemainingMs = abilityActiveRemainingMs(player, now);
  const active = activeRemainingMs > 0;
  const status =
    activeRemainingMs === Number.POSITIVE_INFINITY
      ? `${Math.floor(player.ammo / WEAPON_CONFIG.explosive.ammoCost)} RDS`
      : active
        ? `${Math.ceil(activeRemainingMs / 100) / 10}S`
        : player.abilityCooldownMs > 0
          ? `${Math.ceil(player.abilityCooldownMs / 100) / 10}S`
          : !hasEffect
            ? "FULL"
            : ready
              ? "READY"
              : `${chargePercent}%`;

  return (
    <section className="hud-panel ability-dock interactive-panel" aria-label="Ability dock">
      <button
        className={`ability-primary ability-primary-solo${ready ? " is-ready" : ""}${active ? " is-active" : ""}`}
        disabled={!ready}
        onClick={() => onAbility(player.abilityType)}
        title={ability.description}
        type="button"
      >
        <span className="utility-key">Q</span>
        {abilityIcon(player.abilityType, 21, assetManifest)}
        <strong>{status}</strong>
        <small>{ability.name}</small>
      </button>
    </section>
  );
}

function CompactHudBar({
  agentRoomUi,
  collapsed,
  onControlAgent,
  outsideSafeZone,
  player,
  scoreboardExpanded,
  snapshot,
  onToggleCollapse,
  onToggleScoreboard
}: {
  agentRoomUi: AgentRoomUi;
  collapsed: boolean;
  onControlAgent: (action: AgentControlAction) => void;
  outsideSafeZone: boolean;
  player: ClientPlayer | null;
  scoreboardExpanded: boolean;
  snapshot: ClientSnapshot;
  onToggleCollapse: () => void;
  onToggleScoreboard: () => void;
}) {
  if (!player) return null;
  const ammo = player.ammo > 0 ? player.ammo : WEAPON_CONFIG[player.weaponType].category === "rapid" ? 60 : 24;
  if (scoreboardExpanded) {
    return (
      <section className="compact-hud hud-panel interactive-panel is-scoreboard-open" aria-label="Compact mobile HUD">
        <button className="compact-summary-chip" onClick={onToggleScoreboard} type="button">
          <span>Players</span>
          <strong>{snapshot.alivePlayers || snapshot.players.length}</strong>
          <ChevronUp size={15} />
        </button>
        <AgentStatusControls className="compact-agent-status" onControl={onControlAgent} ui={agentRoomUi} />
      </section>
    );
  }
  if (collapsed) {
    return (
      <section className="compact-hud hud-panel interactive-panel is-collapsed" aria-label="Compact mobile HUD">
        <button className="compact-summary-chip" onClick={onToggleCollapse} type="button">
          <span>{TANK_ARCHETYPE_CONFIG[player.archetypeId].name}</span>
          <strong>{Math.round(player.health)} HP</strong>
          <ChevronDown size={15} />
        </button>
        <AgentStatusControls className="compact-agent-status" onControl={onControlAgent} ui={agentRoomUi} />
      </section>
    );
  }

  return (
    <section className="compact-hud hud-panel interactive-panel" aria-label="Compact mobile HUD">
      <button className="compact-chip is-collapse" onClick={onToggleCollapse} type="button">
        <small>Tank</small>
        <strong><ChevronUp size={16} /></strong>
      </button>
      <div className="compact-chip is-health">
        <small>HP</small>
        <strong>{Math.round(player.health)}</strong>
      </div>
      <div className="compact-chip is-armor">
        <small>AR</small>
        <strong>{Math.round(player.armor)}</strong>
      </div>
      <div className="compact-chip is-ammo">
        <small>Ammo</small>
        <strong>{ammo}</strong>
      </div>
      {outsideSafeZone ? (
        <div className="compact-chip is-warning">
          <small>Zone</small>
          <strong>{Math.max(1, Math.round(snapshot.zone.damagePerSecond))}/s</strong>
        </div>
      ) : null}
      <button className={scoreboardExpanded ? "compact-chip is-score is-open" : "compact-chip is-score"} onClick={onToggleScoreboard} type="button">
        <small>Players</small>
        <strong>{snapshot.alivePlayers || snapshot.players.length}</strong>
        {scoreboardExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
    </section>
  );
}

function ScoreboardPanel({
  expanded,
  snapshot
}: {
  expanded: boolean;
  snapshot: ClientSnapshot;
}) {
  const allStandings = matchStandings(snapshot);
  const standings = expanded ? allStandings : matchStandings(snapshot, 8);
  const label = snapshot.policy.mode === "wingman"
    ? "Teams"
    : snapshot.policy.mode === "agent_cup"
      ? "Agents"
      : "Players";
  return (
    <aside className={expanded ? "hud-panel scoreboard-panel is-open" : "hud-panel scoreboard-panel"} aria-label={label}>
      <div className="panel-heading">
        <span>{label}</span>
        <span>{allStandings.filter((standing) => standing.isAlive).length}/{Math.max(1, allStandings.length)}</span>
      </div>
      <ul className="scoreboard-list">
        {standings.map((standing, index) => (
          <li className={standing.isSelf ? "scoreboard-row is-self" : "scoreboard-row"} key={standing.id}>
            <span className="scoreboard-rank">
              {standing.placement > 0 ? formatPlacement(standing.placement) : standing.isAlive ? `#${index + 1}` : "OUT"}
            </span>
            <span className="scoreboard-dot" />
            <span className="scoreboard-name">{standing.name}</span>
            <span className="scoreboard-stat">{standing.kills}K</span>
            <span className="scoreboard-stat">{Math.round(standing.damageDealt)}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function ZoneWarningBanner({ snapshot }: { snapshot: ClientSnapshot }) {
  return (
    <section className="zone-warning-banner hud-panel" role="alert">
      <span>Safe Zone Breach</span>
      <strong>Drive back inside the ring</strong>
      <b>{Math.max(1, Math.round(snapshot.zone.damagePerSecond))} dmg/s</b>
    </section>
  );
}

function ResultsOverlay({
  connectionStatus,
  onLeave,
  onQuickPlay,
  onRematch,
  snapshot
}: {
  connectionStatus: ConnectionStatus;
  onLeave: () => void;
  onQuickPlay: () => void;
  onRematch: () => void;
  snapshot: ClientSnapshot;
}) {
  const standings = matchStandings(snapshot);
  const self = standings.find((standing) => standing.isSelf);
  const winner = standings[0];

  return (
    <section
      aria-label="Match results"
      aria-modal="true"
      className="match-overlay is-results interactive-panel"
      role="dialog"
    >
      <div className="overlay-card">
        <div className="panel-heading">
          <span>Match Complete</span>
          <span>{snapshot.policy.mode === "classic" ? snapshot.roomCode : "Custom / Unranked"}</span>
        </div>
        <div className="results-hero">
          <span className="results-kicker">{winner ? "Winner" : "Standings"}</span>
          <strong>{winner?.name ?? "Room Closed"}</strong>
          <p>
            {winner
              ? `${winner.kills} kills · ${Math.round(winner.damageDealt)} damage`
              : "The room ended before a winner snapshot arrived."}
          </p>
        </div>
        {self ? (
          <div className="results-summary-grid">
            <div>
              <small>Placement</small>
              <strong>{formatPlacement(self.placement || standings.findIndex((standing) => standing.id === self.id) + 1)}</strong>
            </div>
            <div>
              <small>Kills</small>
              <strong>{self.kills}</strong>
            </div>
            <div>
              <small>Damage</small>
              <strong>{Math.round(self.damageDealt)}</strong>
            </div>
            <div>
              <small>Survival</small>
              <strong>{formatTime(self.survivalTimeMs)}</strong>
            </div>
          </div>
        ) : null}
        <div className="results-actions">
          <button
            aria-pressed={Boolean(snapshot.self?.isReady)}
            autoFocus={connectionStatus === "connected"}
            className={`${snapshot.self?.isReady ? "secondary-button is-active" : "primary-button"} match-cta-orange`}
            data-audio-cue="ready"
            disabled={connectionStatus !== "connected"}
            onClick={onRematch}
            type="button"
          >
            <Play size={17} />
            {snapshot.self?.isReady ? "Cancel Rematch" : "Play Again"}
          </button>
          <button
            autoFocus={connectionStatus !== "connected"}
            className="secondary-button"
            data-audio-cue="confirm"
            onClick={onQuickPlay}
            type="button"
          >
            <RefreshCcw size={17} />
            Fresh Room
          </button>
          <button className="secondary-button" data-audio-cue="back" onClick={onLeave} type="button">
            <LogOut size={17} />
            Leave
          </button>
        </div>
        <div className="results-table">
          {standings.map((standing, index) => (
            <div className={standing.isSelf ? "results-row is-self" : "results-row"} key={standing.id}>
              <span>{standing.placement > 0 ? formatPlacement(standing.placement) : formatPlacement(index + 1)}</span>
              <strong>{standing.name}</strong>
              <span>{standing.kills}K</span>
              <span>{Math.round(standing.damageDealt)} DMG</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SpectatorOverlay({
  agentRoomUi,
  now,
  onControlAgent,
  onDismiss,
  onLeave,
  onQuickPlay,
  snapshot
}: {
  agentRoomUi: AgentRoomUi;
  now: number;
  onControlAgent: (action: AgentControlAction) => void;
  onDismiss: () => void;
  onLeave: () => void;
  onQuickPlay: () => void;
  snapshot: ClientSnapshot;
}) {
  const self = snapshot.self;
  if (!self) return null;
  const respawnTimer = self.respawnAt > now ? formatTime(self.respawnAt - now) : null;
  const isAgentCupController = snapshot.policy.mode === "agent_cup" && self.controlKind === "human";
  const agentCupHeadline =
    agentRoomUi.agentState === "paused"
      ? "Your agent is paused"
      : agentRoomUi.agentState === "reconnecting"
        ? "Your agent is reconnecting"
        : "Your agent is fighting";

  return (
    <section
      aria-label="Spectator status"
      aria-modal="true"
      className="match-overlay is-spectator interactive-panel"
      role="dialog"
    >
      <div className="overlay-card overlay-card-compact">
        <div className="panel-heading">
          <span>Spectator Feed</span>
          <span>{snapshot.alivePlayers} alive</span>
        </div>
        <div className="results-hero is-compact">
          <span className="results-kicker">{isAgentCupController ? "Agent Cup" : self.placement > 0 ? formatPlacement(self.placement) : "Eliminated"}</span>
          <strong>{isAgentCupController ? agentCupHeadline : respawnTimer ? `Respawn in ${respawnTimer}` : "You are spectating"}</strong>
          <p>{isAgentCupController ? "Follow your agent or cycle through the arena." : `${self.kills} kills · ${Math.round(self.damageDealt)} damage · ${Math.round(self.damageTaken)} taken`}</p>
        </div>
        <AgentStatusControls className="spectator-overlay-agent-status" onControl={onControlAgent} ui={agentRoomUi} />
        <div className="results-actions">
          <button autoFocus className="primary-button" data-audio-cue="confirm" onClick={onDismiss} type="button">
            <Eye size={17} />
            Continue Spectating
          </button>
          <button className="secondary-button" data-audio-cue="confirm" onClick={onQuickPlay} type="button">
            <RefreshCcw size={17} />
            New Match
          </button>
          <button className="secondary-button" data-audio-cue="back" onClick={onLeave} type="button">
            <LogOut size={17} />
            Leave
          </button>
        </div>
      </div>
    </section>
  );
}

function SpectatorControls({
  agentRoomUi,
  onControlAgent,
  onNext,
  onPrevious,
  target,
  targetCount
}: {
  agentRoomUi: AgentRoomUi;
  onControlAgent: (action: AgentControlAction) => void;
  onNext: () => void;
  onPrevious: () => void;
  target: ClientPlayer | null;
  targetCount: number;
}) {
  return (
    <div aria-label="Spectator camera" className="spectator-controls interactive-panel" role="group">
      <button
        aria-label="Follow previous tank"
        className="icon-button"
        disabled={targetCount < 2}
        onClick={onPrevious}
        type="button"
      >
        <ChevronLeft size={18} />
      </button>
      <div>
        <span>Spectating</span>
        <strong aria-live="polite">{target?.name ?? "No visible target"}</strong>
        <AgentStatusControls className="spectator-agent-status" onControl={onControlAgent} ui={agentRoomUi} />
      </div>
      <button
        aria-label="Follow next tank"
        className="icon-button"
        disabled={targetCount < 2}
        onClick={onNext}
        type="button"
      >
        <ChevronRight size={18} />
      </button>
    </div>
  );
}

function ConnectionOverlay({
  connectionStatus,
  message,
  onLeave,
  onReconnect,
  roomCode
}: {
  connectionStatus: ConnectionStatus;
  message: string;
  onLeave: () => void;
  onReconnect: () => void;
  roomCode: string;
}) {
  return (
    <section
      aria-label="Connection status"
      aria-modal="true"
      className="match-overlay is-connection interactive-panel"
      role="dialog"
    >
      <div className="overlay-card overlay-card-compact">
        <div className="panel-heading">
          <span>{connectionStatus === "offline" ? "Room Offline" : "Link Error"}</span>
          <span>{roomCode}</span>
        </div>
        <div className="results-hero is-compact">
          <span className="results-kicker">Connection Lost</span>
          <strong>{connectionStatus === "offline" ? "Room disconnected" : "Unable to talk to the server"}</strong>
          <p>{message || "Try reconnecting to continue spectating or rejoin the room."}</p>
        </div>
        <div className="results-actions">
          <button autoFocus className="primary-button" data-audio-cue="confirm" onClick={onReconnect} type="button">
            <RefreshCcw size={17} />
            Reconnect
          </button>
          <button className="secondary-button" data-audio-cue="back" onClick={onLeave} type="button">
            <LogOut size={17} />
            Leave to Menu
          </button>
        </div>
      </div>
    </section>
  );
}

function DebugDriveHarness({
  onDisconnect,
  onMove,
  onMoveTowardTarget
}: {
  onDisconnect: () => void;
  onMove: (x: number, y: number) => void;
  onMoveTowardTarget: () => void;
}) {
  const previewImpact = (
    weaponType: ClientPlayer["weaponType"],
    reason: ProjectileImpactMessagePayload["reason"] = "tank"
  ) => {
    window.__alpha7ArenaPreviewImpact?.(weaponType, reason);
  };

  return (
    <section aria-label="Debug drive harness" className="debug-drive-harness interactive-panel">
      <div className="debug-drive-row">
        <button aria-label="Drive forward" onClick={() => onMove(0, -1)} type="button">
          ↑
        </button>
        <button aria-label="Drive left" onClick={() => onMove(-1, 0)} type="button">
          ←
        </button>
        <button aria-label="Stop driving" onClick={() => onMove(0, 0)} type="button">
          ■
        </button>
        <button aria-label="Drive right" onClick={() => onMove(1, 0)} type="button">
          →
        </button>
        <button aria-label="Drive reverse" onClick={() => onMove(0, 1)} type="button">
          ↓
        </button>
        <button aria-label="Drive toward nearest target" onClick={onMoveTowardTarget} type="button">
          ◎
        </button>
      </div>
      <div className="debug-drive-row" role="group" aria-label="Impact and network previews">
        <button aria-label="Preview cannon tank impact" onClick={() => previewImpact("cannon")} type="button">
          C
        </button>
        <button aria-label="Preview light cannon tank impact" onClick={() => previewImpact("light_cannon")} type="button">
          L
        </button>
        <button aria-label="Preview machine gun tank impact" onClick={() => previewImpact("machine_gun")} type="button">
          M
        </button>
        <button aria-label="Preview explosive tank impact" onClick={() => previewImpact("explosive")} type="button">
          X
        </button>
        <button aria-label="Preview cannon wall impact" onClick={() => previewImpact("cannon", "wall")} type="button">
          W
        </button>
        <button aria-label="Drop room connection" onClick={onDisconnect} type="button">
          D
        </button>
      </div>
    </section>
  );
}

function MobileControls({
  aimArmed,
  aimKnob,
  assetManifest,
  joystickKnob,
  now,
  player,
  onAbility,
  onAimPointerCancel,
  onAimPointerDown,
  onAimPointerMove,
  onAimPointerUp,
  onStickPointerDown,
  onStickPointerMove,
  onStickPointerUp
}: {
  aimArmed: boolean;
  aimKnob: { x: number; y: number };
  assetManifest: Alpha7AssetManifest | null;
  joystickKnob: { x: number; y: number };
  now: number;
  player: ClientPlayer | null;
  onAbility: () => void;
  onAimPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  onAimPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onAimPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onAimPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onStickPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onStickPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onStickPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  const ability = player ? ABILITY_CONFIG[player.abilityType] : null;
  const abilityReady =
    Boolean(
      player &&
        ability &&
        player.abilityCharge >= ability.chargeCost &&
        player.abilityCooldownMs <= 0 &&
        abilityWouldHaveEffect(player)
    );
  const abilityActive = Boolean(player && abilityActiveRemainingMs(player, now) > 0);
  const chargeTarget = ability ? Math.max(ability.chargeCost, 100) : 100;
  const chargeRatio = player ? clamp(player.abilityCharge / chargeTarget, 0, 1) : 0;
  const abilityButtonStyle = {
    "--ability-charge": `${Math.round(chargeRatio * 100)}%`
  } as CSSProperties;

  return (
    <div className="mobile-controls interactive-panel" aria-label="Mobile controls">
      <div
        aria-label="Movement joystick"
        className="mobile-stick"
        onLostPointerCapture={onStickPointerUp}
        onPointerCancel={onStickPointerUp}
        onPointerDown={onStickPointerDown}
        onPointerMove={onStickPointerMove}
        onPointerUp={onStickPointerUp}
        role="group"
      >
        <span style={{ transform: `translate(${joystickKnob.x}px, ${joystickKnob.y}px)` }} />
      </div>
      <div
        aria-label="Aim and release to fire"
        className={aimArmed ? "mobile-aim-zone is-armed" : "mobile-aim-zone"}
        onLostPointerCapture={onAimPointerCancel}
        onPointerCancel={onAimPointerCancel}
        onPointerDown={onAimPointerDown}
        onPointerMove={onAimPointerMove}
        onPointerUp={onAimPointerUp}
        role="group"
      >
        <span
          className="mobile-aim-knob"
          style={{ transform: `translate(${aimKnob.x}px, ${aimKnob.y}px)` }}
        >
          <Crosshair size={26} />
        </span>
        <small>{aimArmed ? "Release" : "Aim"}</small>
      </div>
      <button
        aria-label={
          ability
            ? `${ability.name} ${abilityActive ? "active" : abilityReady ? "ready" : "charging or cooling down"}. ${ability.description}`
            : "Ability"
        }
        className={`mobile-ability-button${abilityReady ? " is-ready" : ""}${abilityActive ? " is-active" : ""}`}
        disabled={!abilityReady}
        onClick={onAbility}
        style={abilityButtonStyle}
        type="button"
      >
        {player ? abilityIcon(player.abilityType, 22, assetManifest) : <Zap size={22} />}
        <small>{player ? MOBILE_ABILITY_LABELS[player.abilityType] : ability ? ability.name : "Ability"}</small>
      </button>
    </div>
  );
}


function GameApp() {
  const route = "arena" as const;
  const endpoint = useMemo(() => endpointFromEnv(), []);
  const httpEndpoint = useMemo(() => httpEndpointFromEnv(endpoint), [endpoint]);
  const siteVisitorId = useMemo(readSiteVisitorId, []);
  const [playerName, setPlayerName] = useState("Operator");
  const [selectedTank, setSelectedTank] = useState<TankArchetypeId>(DEFAULT_TANK_ARCHETYPE);
  const [pendingJoinMode, setPendingJoinMode] = useState<MatchmakingJoinMode | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [playersOnline, setPlayersOnline] = useState<number | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [networkMessage, setNetworkMessage] = useState("");
  const [pickupNotice, setPickupNotice] = useState<PickupNotice | null>(() => readScenarioPickupNotice());
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [fireSignal, setFireSignal] = useState(0);
  const [impactSignal, setImpactSignal] = useState(0);
  const [abilitySignal, setAbilitySignal] = useState(0);
  const [joystickKnob, setJoystickKnob] = useState({ x: 0, y: 0 });
  const [aimKnob, setAimKnob] = useState({ x: 0, y: 0 });
  const [aimArmed, setAimArmed] = useState(false);
  const [minimapExpanded, setMinimapExpanded] = useState(false);
  const [scoreboardExpanded, setScoreboardExpanded] = useState(false);
  const [tankInfoCollapsed, setTankInfoCollapsed] = useState(() => shouldCollapseTankInfoForViewport());
  const [mobilePortraitHud, setMobilePortraitHud] = useState(() => isMobilePortraitViewport());
  const [spectatorOverlayDismissed, setSpectatorOverlayDismissed] = useState(false);
  const [spectatorTargetId, setSpectatorTargetId] = useState<string | null>(null);
  const [menuMusicIndex, setMenuMusicIndex] = useState(() => chooseNextMenuMusicIndex(-1));
  const [queuedJoin, setQueuedJoin] = useState<QueuedJoin | null>(null);
  const [agentRoomUi, setAgentRoomUi] = useState<AgentRoomUi>(DEFAULT_AGENT_ROOM_UI);
  const [agentSetupOpen, setAgentSetupOpen] = useState(false);
  const [pendingAgentControl, setPendingAgentControl] = useState<ConfirmedAgentControlAction | null>(null);
  const [webMcpReady, setWebMcpReady] = useState(false);
  const [assetManifest, setAssetManifest] = useState<Alpha7AssetManifest>(DEFAULT_ALPHA7_ASSET_MANIFEST);

  const inputRef = useRef<InputFrame>(defaultInputFrame());
  const roomRef = useRef<Room<any, Alpha7StateSchema> | null>(null);
  const snapshotRef = useRef<ClientSnapshot | null>(null);
  const agentRoomUiRef = useRef<AgentRoomUi>(DEFAULT_AGENT_ROOM_UI);
  const agentPairingIntentRef = useRef<"browser" | "copy" | null>(null);
  const roomTokenRef = useRef(0);
  const sequenceRef = useRef(1);
  const localPoseRef = useRef<LocalPose>({
    x: 0,
    y: 0,
    rotation: 0,
    turretRotation: 0,
    velocityX: 0,
    velocityY: 0
  });
  const keyboardMoveRef = useRef({ x: 0, y: 0 });
  const joystickMoveRef = useRef({ x: 0, y: 0 });
  const joystickPointerIdRef = useRef<number | null>(null);
  const pressedKeysRef = useRef(new Set<string>());
  const fireThrottleRef = useRef(0);
  const fireSequenceRef = useRef(0);
  const aimSyncRef = useRef<((screenX: number, screenY: number) => void) | null>(null);
  const projectileImpactQueueRef = useRef<ProjectileImpactMessagePayload[]>([]);
  const lastProjectileImpactRef = useRef<ProjectileImpactMessagePayload | null>(null);
  const abilityThrottleRef = useRef(0);
  const mobileAimGestureRef = useRef<MobileAimGesture>({
    pointerId: null,
    startedAt: 0,
    startX: 0,
    startY: 0,
    armed: false,
    everArmed: false,
    rapidStarted: false
  });
  const mobileRapidFireDelayRef = useRef<number | null>(null);
  const cameraOrbitAngleRef = useRef(0);
  const lastJoinModeRef = useRef<JoinMode>("quick");
  const reconnectTokenRef = useRef<string | null>(readReconnectToken());
  const reconnectInFlightRef = useRef(false);
  const backgroundMusicAudioRef = useRef<HTMLAudioElement | null>(null);
  const rainAudioRef = useRef<HTMLAudioElement | null>(null);
  const tankMoveAudioRef = useRef<HTMLAudioElement | null>(null);
  const shortAudioPoolsRef = useRef(
    new globalThis.Map<string, { cursor: number; elements: HTMLAudioElement[] }>()
  );
  const audioUnlockedRef = useRef(false);
  const audioCueCountRef = useRef(0);
  const lastAudioCueRef = useRef<string | null>(null);
  const lastAudioErrorRef = useRef<string | null>(null);
  const thunderCueIndexRef = useRef(0);
  const thunderTimeoutsRef = useRef(new Set<number>());
  const backgroundMusicStartPendingRef = useRef(false);
  const backgroundMusicCompletedLoopsRef = useRef(0);
  const backgroundMusicPreviousTimeRef = useRef(0);
  const rainStartPendingRef = useRef(false);
  const bedDuckTimeoutRef = useRef<number | null>(null);
  const bedDuckLevelRef = useRef(1);
  const backgroundMusicTargetVolumeRef = useRef(0);
  const rainTargetVolumeRef = useRef(0);

  useEffect(() => {
    if (window.location.pathname !== "/") window.history.replaceState({}, "", "/");
  }, []);

  useEffect(() => {
    const syncTankInfoCollapse = () => {
      setMobilePortraitHud(isMobilePortraitViewport());
      setTankInfoCollapsed(shouldCollapseTankInfoForViewport());
    };
    syncTankInfoCollapse();
    window.addEventListener("resize", syncTankInfoCollapse);
    window.addEventListener("orientationchange", syncTankInfoCollapse);
    return () => {
      window.removeEventListener("resize", syncTankInfoCollapse);
      window.removeEventListener("orientationchange", syncTankInfoCollapse);
    };
  }, []);

  const hudScenario = useMemo(() => readHudScenario(), []);
  const scenarioTank = useMemo(() => readScenarioTank() ?? selectedTank, [selectedTank]);
  const scenarioAbility = useMemo(() => readScenarioAbility(), []);
  const scenarioShield = useMemo(() => readScenarioShield(), []);
  const scenarioSnapshot = useMemo(
    () =>
      hudScenario
        ? buildHudScenarioSnapshot(hudScenario, scenarioTank, playerName, now, scenarioAbility, scenarioShield)
        : null,
    [hudScenario, now, playerName, scenarioAbility, scenarioShield, scenarioTank]
  );
  const liveSnapshot = snapshot ?? scenarioSnapshot;
  const displaySnapshot = useMemo(
    () => liveSnapshot ?? previewSnapshot(selectedTank, playerName),
    [liveSnapshot, playerName, selectedTank]
  );
  const authoritativeNow = snapshotServerNow(displaySnapshot, now);
  const isSpectating = Boolean(
    displaySnapshot.self &&
      (!displaySnapshot.self.isAlive || displaySnapshot.self.isSpectator) &&
      isActiveMatchState(displaySnapshot.matchState)
  );
  const availableSpectatorTargets = useMemo(
    () => spectatorTargets(displaySnapshot, authoritativeNow),
    [authoritativeNow, displaySnapshot]
  );
  const spectatorTargetKey = availableSpectatorTargets
    .map((player) => player.sessionId)
    .join(":");
  const preferredSpectatorTargetId =
    displaySnapshot.policy.mode === "agent_cup" ? ownedAgentSessionId(displaySnapshot) : null;
  const spectatorTarget =
    availableSpectatorTargets.find((player) => player.sessionId === spectatorTargetId) ?? null;
  const screenMode: ScreenMode = liveSnapshot
    ? isWaitingRoomState(liveSnapshot.matchState)
      ? "lobby"
      : "playing"
    : "menu";
  const active = isActiveMatchState(displaySnapshot.matchState);
  const selfPlayer = displaySnapshot.self;
  const rainIntensity =
    displaySnapshot.map.weather.kind === "rain"
      ? Math.max(0, Math.min(1, displaySnapshot.map.weather.intensity))
      : 0;
  const backgroundMusicContext =
    screenMode !== "playing" ? "menu" : rainIntensity > 0 ? "rain" : "gameplay";
  const backgroundMusicBank = BACKGROUND_MUSIC_AUDIO[backgroundMusicContext];
  const backgroundMusicIndex =
    backgroundMusicContext === "menu"
      ? menuMusicIndex
      : hashSeed(
          `${displaySnapshot.roomId}:${displaySnapshot.matchId}:${displaySnapshot.map.weather.seed}:${backgroundMusicContext}`
        ) % backgroundMusicBank.length;
  const backgroundMusicCue =
    backgroundMusicBank[backgroundMusicIndex] ?? backgroundMusicBank[0];
  const rainVolume =
    rainIntensity > 0 ? RAIN_AUDIO_CUE.volume * (0.38 + rainIntensity * 0.62) : 0;
  backgroundMusicTargetVolumeRef.current = backgroundMusicCue.volume;
  rainTargetVolumeRef.current = rainVolume;
  const movementAudioCue = movementAudioForTank(selfPlayer?.archetypeId ?? selectedTank);
  const outsideSafeZone =
    Boolean(
      selfPlayer &&
        selfPlayer.isAlive &&
        !selfPlayer.isSpectator &&
        route === "arena" &&
        isOutsideSafeZone(displaySnapshot, localPoseRef.current)
    );
  const canControlLivePlayer = Boolean(
    route === "arena" &&
      snapshot &&
      connectionStatus === "connected" &&
      snapshot.self &&
      snapshot.self.isAlive &&
      !snapshot.self.isSpectator &&
      isActiveMatchState(snapshot.matchState)
  );
  const canControlScenarioPlayer = Boolean(
    route === "arena" &&
      scenarioSnapshot &&
      scenarioSnapshot.self &&
      scenarioSnapshot.self.isAlive &&
      !scenarioSnapshot.self.isSpectator &&
      isActiveMatchState(scenarioSnapshot.matchState)
  );
  const canControlLocalPlayer = canControlLivePlayer || canControlScenarioPlayer;
  const showResults = Boolean(liveSnapshot && liveSnapshot.matchState === "finished");
  const showGameplayHud = screenMode === "playing" && !showResults;
  const showLobbyHudDebug = useMemo(() => {
    if (!DEBUG_TOOLS_COMPILED) return false;
    const params = new URLSearchParams(window.location.search);
    return params.get("alpha7LobbyHud") === "1";
  }, []);
  const showDebugPayload = useMemo(() => isDebugToolsEnabled(), []);
  const showDebugDriveHarness = useMemo(
    () => DEBUG_TOOLS_COMPILED && new URLSearchParams(window.location.search).get("alpha7DriveHarness") === "1",
    []
  );
  const showNetworkDiagnostics = useMemo(() => {
    if (!DEBUG_TOOLS_COMPILED) return false;
    const params = new URLSearchParams(window.location.search);
    return (
      params.get("alpha7NetworkHud") === "1" ||
      params.get("alpha7DebugHud") === "1" ||
      params.get("alpha7LobbyHud") === "1"
    );
  }, []);
  const showHudLayer = screenMode !== "lobby" || showLobbyHudDebug;
  const showConnectionOverlay = Boolean(snapshot && (connectionStatus === "offline" || connectionStatus === "error"));
  const showSpectatorOverlay = Boolean(
    liveSnapshot &&
      !showResults &&
      !showConnectionOverlay &&
      liveSnapshot.self &&
      (!liveSnapshot.self.isAlive || liveSnapshot.self.isSpectator) &&
      !spectatorOverlayDismissed &&
      active
  );
  const blockingOverlayOpen =
    showResults || showConnectionOverlay || showSpectatorOverlay || pendingAgentControl !== null;

  useEffect(() => {
    if (!isSpectating) {
      setSpectatorTargetId(null);
      setSpectatorOverlayDismissed(false);
      return;
    }
    setSpectatorTargetId((current) =>
      availableSpectatorTargets.some((player) => player.sessionId === current)
        ? current
        : availableSpectatorTargets.find(
              (player) => player.sessionId === preferredSpectatorTargetId
            )?.sessionId ?? availableSpectatorTargets[0]?.sessionId ?? null
    );
  }, [isSpectating, preferredSpectatorTargetId, spectatorTargetKey]);

  const createShortAudio = useCallback((cue: AudioCueDefinition): HTMLAudioElement => {
    const audio = new Audio(cue.src);
    audio.preload = "auto";
    audio.volume = cue.volume;
    return audio;
  }, []);

  const duckAudioBeds = useCallback((level: number, durationMs: number) => {
    if (bedDuckTimeoutRef.current !== null) window.clearTimeout(bedDuckTimeoutRef.current);
    bedDuckLevelRef.current = level;
    const music = backgroundMusicAudioRef.current;
    const rain = rainAudioRef.current;
    if (music) music.volume = backgroundMusicTargetVolumeRef.current * level;
    if (rain) rain.volume = rainTargetVolumeRef.current * level;
    bedDuckTimeoutRef.current = window.setTimeout(() => {
      bedDuckTimeoutRef.current = null;
      bedDuckLevelRef.current = 1;
      if (backgroundMusicAudioRef.current) {
        backgroundMusicAudioRef.current.volume = backgroundMusicTargetVolumeRef.current;
      }
      if (rainAudioRef.current) rainAudioRef.current.volume = rainTargetVolumeRef.current;
    }, durationMs);
  }, []);

  const playShortAudio = useCallback(
    (cue: AudioCueDefinition) => {
      let pool = shortAudioPoolsRef.current.get(cue.id);
      if (!pool) {
        pool = { cursor: 0, elements: [createShortAudio(cue)] };
        shortAudioPoolsRef.current.set(cue.id, pool);
      }

      let audio = pool.elements.find((candidate) => candidate.paused || candidate.ended);
      const poolLimit = cue.poolSize ?? 2;
      if (!audio && pool.elements.length < poolLimit) {
        audio = createShortAudio(cue);
        pool.elements.push(audio);
      }
      if (!audio) {
        audio = pool.elements[pool.cursor % pool.elements.length];
        pool.cursor = (pool.cursor + 1) % pool.elements.length;
      }
      if (!audio) return;

      audio.volume = cue.volume;
      audio.currentTime = 0;
      void audio
        .play()
        .then(() => {
          lastAudioErrorRef.current = null;
          lastAudioCueRef.current = cue.id;
          audioCueCountRef.current += 1;
          if (cue.category === "fire") duckAudioBeds(0.55, 320);
          if (cue.category === "weather") duckAudioBeds(0.45, 700);
        })
        .catch((error: unknown) => {
          lastAudioErrorRef.current = `${cue.category}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
        });
    },
    [createShortAudio, duckAudioBeds]
  );

  const startBackgroundMusic = useCallback(() => {
    const audio = backgroundMusicAudioRef.current;
    if (!audio) return;
    if (backgroundMusicStartPendingRef.current || !audio.paused) return;
    audio.volume = backgroundMusicCue.volume * bedDuckLevelRef.current;
    backgroundMusicStartPendingRef.current = true;
    void audio
      .play()
      .then(() => {
        lastAudioErrorRef.current = null;
        lastAudioCueRef.current = backgroundMusicCue.id;
        audioCueCountRef.current += 1;
      })
      .catch((error: unknown) => {
        lastAudioErrorRef.current = `music: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
      })
      .finally(() => {
        backgroundMusicStartPendingRef.current = false;
      });
  }, [backgroundMusicCue]);

  const handleBackgroundMusicEnded = useCallback(() => {
    if (backgroundMusicContext !== "menu") return;
    setMenuMusicIndex((currentIndex) => chooseNextMenuMusicIndex(currentIndex));
  }, [backgroundMusicContext]);

  const configureBackgroundMusicLoop = useCallback(() => {
    const audio = backgroundMusicAudioRef.current;
    if (!audio) return;
    backgroundMusicCompletedLoopsRef.current = 0;
    backgroundMusicPreviousTimeRef.current = 0;
    audio.loop =
      backgroundMusicContext !== "menu" || menuMusicPlayCount(audio.duration) > 1;
  }, [backgroundMusicContext]);

  const handleBackgroundMusicTimeUpdate = useCallback(() => {
    const audio = backgroundMusicAudioRef.current;
    if (!audio || backgroundMusicContext !== "menu") return;
    if (audio.currentTime < backgroundMusicPreviousTimeRef.current) {
      backgroundMusicCompletedLoopsRef.current += 1;
      if (
        backgroundMusicCompletedLoopsRef.current + 1 >=
        menuMusicPlayCount(audio.duration)
      ) {
        audio.loop = false;
      }
    }
    backgroundMusicPreviousTimeRef.current = audio.currentTime;
  }, [backgroundMusicContext]);

  const syncRainAudio = useCallback(() => {
    const audio = rainAudioRef.current;
    if (!audio) return;
    const shouldPlay = audioUnlockedRef.current && rainIntensity > 0;
    const targetVolume = rainVolume * bedDuckLevelRef.current;
    if (!shouldPlay) {
      audio.volume = targetVolume;
      rainStartPendingRef.current = false;
      if (!audio.paused) audio.pause();
      audio.currentTime = 0;
      return;
    }
    if (!audio.paused) {
      audio.volume = targetVolume;
      return;
    }
    audio.volume = targetVolume;
    if (rainStartPendingRef.current) return;
    rainStartPendingRef.current = true;
    void audio
      .play()
      .then(() => {
        lastAudioErrorRef.current = null;
        lastAudioCueRef.current = RAIN_AUDIO_CUE.id;
        audioCueCountRef.current += 1;
      })
      .catch((error: unknown) => {
        lastAudioErrorRef.current = `rain: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
      })
      .finally(() => {
        rainStartPendingRef.current = false;
      });
  }, [rainIntensity, rainVolume]);

  const unlockAudio = useCallback(() => {
    audioUnlockedRef.current = true;
    startBackgroundMusic();
    syncRainAudio();
  }, [startBackgroundMusic, syncRainAudio]);

  const playTankFireAudio = useCallback(
    (archetypeId: TankArchetypeId, weaponType: ClientPlayer["weaponType"]) => {
      playShortAudio(fireAudioForTank(archetypeId, weaponType));
    },
    [playShortAudio]
  );

  const playThunderAudio = useCallback(() => {
    const weather = snapshotRef.current?.map.weather;
    if (
      !audioUnlockedRef.current ||
      document.visibilityState !== "visible" ||
      !weather ||
      !weatherCanThunder(weather)
    ) {
      return;
    }

    const cueIndex = thunderCueIndexRef.current % THUNDER_AUDIO.length;
    thunderCueIndexRef.current += 1;
    const cue = THUNDER_AUDIO[cueIndex];
    if (!cue) return;
    const scheduledWeatherSeed = weather.seed;
    const delayMs = cueIndex === 0 ? 180 : 720;
    const timeout = window.setTimeout(() => {
      thunderTimeoutsRef.current.delete(timeout);
      const currentWeather = snapshotRef.current?.map.weather;
      if (
        document.visibilityState === "visible" &&
        currentWeather &&
        currentWeather.seed === scheduledWeatherSeed &&
        weatherCanThunder(currentWeather)
      ) {
        playShortAudio(cue);
      }
    }, delayMs);
    thunderTimeoutsRef.current.add(timeout);
  }, [playShortAudio]);

  const handleUiAudioClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest<HTMLElement>("[data-audio-cue]");
      if (!target || target.matches(":disabled") || target.getAttribute("aria-disabled") === "true") return;
      const cueName = target.dataset.audioCue as UiAudioCue | undefined;
      if (cueName && cueName in UI_AUDIO) playShortAudio(UI_AUDIO[cueName]);
    },
    [playShortAudio]
  );

  useEffect(() => {
    for (const cue of PRELOAD_AUDIO_CUES) {
      const audio = createShortAudio(cue);
      audio.load();
      shortAudioPoolsRef.current.set(cue.id, { cursor: 0, elements: [audio] });
    }
    return () => {
      for (const pool of shortAudioPoolsRef.current.values()) {
        for (const audio of pool.elements) {
          audio.pause();
          audio.removeAttribute("src");
        }
      }
      shortAudioPoolsRef.current.clear();
      for (const timeout of thunderTimeoutsRef.current) window.clearTimeout(timeout);
      thunderTimeoutsRef.current.clear();
      if (bedDuckTimeoutRef.current !== null) window.clearTimeout(bedDuckTimeoutRef.current);
      bedDuckTimeoutRef.current = null;
      bedDuckLevelRef.current = 1;
    };
  }, [createShortAudio]);

  useEffect(() => {
    const audio = backgroundMusicAudioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    audio.load();
    backgroundMusicCompletedLoopsRef.current = 0;
    backgroundMusicPreviousTimeRef.current = 0;
    backgroundMusicStartPendingRef.current = false;
    if (audioUnlockedRef.current) startBackgroundMusic();
  }, [backgroundMusicCue, startBackgroundMusic]);

  useEffect(() => {
    syncRainAudio();
  }, [syncRainAudio]);

  useEffect(() => {
    const audio = tankMoveAudioRef.current;
    if (!audio) return;
    const input = inputRef.current;
    const isMoving = canControlLocalPlayer && Math.hypot(input.moveX, input.moveY) > 0.09;
    audio.loop = true;
    audio.playbackRate = movementAudioCue.playbackRate ?? 1;
    audio.volume = isMoving ? movementAudioCue.volume : 0;
    if (isMoving && audio.paused) {
      void audio
        .play()
        .then(() => {
          lastAudioErrorRef.current = null;
          lastAudioCueRef.current = movementAudioCue.id;
          audioCueCountRef.current += 1;
        })
        .catch((error: unknown) => {
          lastAudioErrorRef.current = `movement: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
        });
    }
    if (!isMoving && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
    }
  }, [canControlLocalPlayer, movementAudioCue, now]);

  useEffect(() => {
    snapshotRef.current = liveSnapshot;
  }, [liveSnapshot]);

  useEffect(() => {
    let activeRequest: AbortController | null = null;
    let timer: number | null = null;
    let stopped = false;
    const canDisplayPlayersOnline = (): boolean =>
      !document.hidden && route === "arena" && screenMode === "menu";
    const heartbeat = (): void => {
      if (activeRequest) return;
      const request = new AbortController();
      const timeout = window.setTimeout(() => request.abort(), 10_000);
      activeRequest = request;
      void heartbeatSitePresence(httpEndpoint, siteVisitorId, request.signal)
        .then((count) => {
          if (!stopped && canDisplayPlayersOnline()) setPlayersOnline(count);
        })
        .catch(() => {
          if (!stopped && canDisplayPlayersOnline()) setPlayersOnline(null);
        })
        .finally(() => {
          window.clearTimeout(timeout);
          if (activeRequest === request) activeRequest = null;
        });
    };
    const scheduleHeartbeat = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        heartbeat();
        scheduleHeartbeat();
      }, canDisplayPlayersOnline()
        ? MENU_PRESENCE_HEARTBEAT_MS
        : SITE_PRESENCE_HEARTBEAT_MS);
    };
    const onVisibilityChange = (): void => {
      if (!document.hidden) heartbeat();
      scheduleHeartbeat();
    };
    heartbeat();
    scheduleHeartbeat();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      activeRequest?.abort();
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [httpEndpoint, route, screenMode, siteVisitorId]);

  useEffect(() => {
    if (!queuedJoin || connectionStatus !== "idle") return;
    setQueuedJoin(null);
    void joinRoom(queuedJoin.mode, queuedJoin.roomMode);
  }, [connectionStatus, queuedJoin]);

  useEffect(() => {
    if (!snapshot || snapshot.matchState === "finished" || snapshot.self?.isAlive) {
      setSpectatorOverlayDismissed(false);
    }
  }, [snapshot?.matchId, snapshot?.matchState, snapshot?.self?.isAlive]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onFirstGesture = (): void => unlockAudio();
    window.addEventListener("pointerdown", onFirstGesture, { capture: true, passive: true });
    window.addEventListener("pointerup", onFirstGesture, { capture: true, passive: true });
    window.addEventListener("keydown", onFirstGesture);
    window.addEventListener("keyup", onFirstGesture);
    return () => {
      window.removeEventListener("pointerdown", onFirstGesture, true);
      window.removeEventListener("pointerup", onFirstGesture, true);
      window.removeEventListener("keydown", onFirstGesture);
      window.removeEventListener("keyup", onFirstGesture);
    };
  }, [unlockAudio]);

  useEffect(() => {
    let mounted = true;
    loadAlpha7AssetManifest()
      .then((manifest) => {
        if (
          mounted &&
          manifestRuntimeSignature(manifest) !== manifestRuntimeSignature(DEFAULT_ALPHA7_ASSET_MANIFEST)
        ) {
          setAssetManifest(manifest);
        }
      })
      .catch(() => {
        if (mounted) setAssetManifest(DEFAULT_ALPHA7_ASSET_MANIFEST);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const recomputeMove = useCallback(() => {
    const combined = normalizeVector(
      keyboardMoveRef.current.x + joystickMoveRef.current.x,
      keyboardMoveRef.current.y + joystickMoveRef.current.y
    );
    inputRef.current.moveX = combined.x;
    inputRef.current.moveY = combined.y;
  }, []);

  const sendInputIntent = useCallback(() => {
    const room = roomRef.current;
    const currentSnapshot = snapshotRef.current;
    if (
      !room ||
      !currentSnapshot ||
      !currentSnapshot.self?.isAlive ||
      currentSnapshot.self.isSpectator ||
      !isActiveMatchState(currentSnapshot.matchState)
    ) {
      return;
    }

    const input = inputRef.current;
    const worldMove = controlMoveToWorldMove(input.moveX, input.moveY, cameraOrbitAngleRef.current);
    const payload: InputMessagePayload = {
      sequence: sequenceRef.current++,
      tick: currentSnapshot.tick,
      moveX: worldMove.x,
      moveY: worldMove.y,
      aimX: input.aimWorldX,
      aimY: input.aimWorldY,
      fire: input.fire,
      ability: input.ability
    };
    try {
      room.send(CLIENT_MESSAGE_TYPES.INPUT, payload);
    } catch (error) {
      setNetworkMessage(error instanceof Error ? error.message : "Input send failed");
    }
  }, []);

  const setDebugMove = useCallback(
    (x: number, y: number) => {
      keyboardMoveRef.current = { x: 0, y: 0 };
      joystickMoveRef.current = normalizeVector(x, y);
      recomputeMove();
      sendInputIntent();
    },
    [recomputeMove, sendInputIntent]
  );
  const setDebugMoveTowardTarget = useCallback(() => {
    const currentSnapshot = snapshotRef.current;
    const self = currentSnapshot?.self;
    if (!currentSnapshot || !self) return;
    const target = currentSnapshot.players
      .filter((player) => !player.isSelf && player.isAlive && !player.isSpectator)
      .sort(
        (left, right) =>
          Math.hypot(left.x - self.x, left.y - self.y) -
          Math.hypot(right.x - self.x, right.y - self.y)
      )[0];
    if (!target) return;
    setDebugMove(target.x - self.x, target.y - self.y);
  }, [setDebugMove]);
  const dropDebugRoomConnection = useCallback(() => {
    roomRef.current?.connection.close();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(sendInputIntent, 50);
    return () => window.clearInterval(timer);
  }, [sendInputIntent]);

  const triggerFire = useCallback((): boolean => {
    if (!canControlLocalPlayer) return false;
    const currentSnapshot = snapshotRef.current;
    const self = currentSnapshot?.self;
    if (!currentSnapshot || !self || self.fireCooldownMs > 0) return false;

    const weapon = WEAPON_CONFIG[self.weaponType];
    if (self.weaponType === "explosive" && self.ammo < weapon.ammoCost) return false;
    const time = performance.now();
    const effectiveCooldown =
      self.weaponType !== "explosive" && self.ammo > 0
        ? weapon.fireCooldownMs * RAPID_FIRE_COOLDOWN_MULTIPLIER
        : weapon.fireCooldownMs;
    if (time < fireThrottleRef.current) return false;
    const room = roomRef.current;
    const input = inputRef.current;
    const pose = localPoseRef.current;
    const aimWorldX = Number.isFinite(input.aimWorldX) ? input.aimWorldX : pose.x + input.aimDirX * 560;
    const aimWorldY = Number.isFinite(input.aimWorldY) ? input.aimWorldY : pose.y + input.aimDirY * 560;
    const fireSequence = sequenceRef.current++;
    const payload: FireMessagePayload = {
      sequence: fireSequence,
      aimX: aimWorldX,
      aimY: aimWorldY,
      chargeMs: 0
    };
    if (room) {
      try {
        room.send(CLIENT_MESSAGE_TYPES.FIRE, payload);
      } catch (error) {
        setNetworkMessage(error instanceof Error ? error.message : "Fire send failed");
        return false;
      }
    } else if (!hudScenario) {
      return false;
    }

    fireThrottleRef.current = time + effectiveCooldown;
    fireSequenceRef.current = fireSequence;
    setFireSignal((value) => value + 1);
    playTankFireAudio(self.archetypeId, self.weaponType);
    return true;
  }, [canControlLocalPlayer, hudScenario, playTankFireAudio]);

  const stopMobileRapidFire = useCallback(() => {
    if (mobileRapidFireDelayRef.current !== null) {
      window.clearTimeout(mobileRapidFireDelayRef.current);
      mobileRapidFireDelayRef.current = null;
    }
    inputRef.current.fire = false;
  }, []);

  const resetMobileAim = useCallback(() => {
    stopMobileRapidFire();
    mobileAimGestureRef.current = {
      pointerId: null,
      startedAt: 0,
      startX: 0,
      startY: 0,
      armed: false,
      everArmed: false,
      rapidStarted: false
    };
    setAimKnob({ x: 0, y: 0 });
    setAimArmed(false);
  }, [stopMobileRapidFire]);

  useEffect(() => {
    if (canControlLocalPlayer) return;
    inputRef.current.ability = false;
    fireThrottleRef.current = 0;
    keyboardMoveRef.current = { x: 0, y: 0 };
    joystickMoveRef.current = { x: 0, y: 0 };
    joystickPointerIdRef.current = null;
    pressedKeysRef.current.clear();
    setJoystickKnob({ x: 0, y: 0 });
    resetMobileAim();
    recomputeMove();
  }, [canControlLocalPlayer, recomputeMove, resetMobileAim]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const self = snapshotRef.current?.self;
      if (!inputRef.current.fire || !self || !shouldRepeatHeldFire(self)) return;
      if (triggerFire() && mobileAimGestureRef.current.pointerId !== null) {
        mobileAimGestureRef.current.rapidStarted = true;
      }
    }, 45);
    return () => window.clearInterval(timer);
  }, [triggerFire]);

  const triggerAbility = useCallback(
    (abilityType?: ClientPlayer["abilityType"]) => {
      unlockAudio();
      if (!canControlLocalPlayer) return;
      const room = roomRef.current;
      const currentSnapshot = snapshotRef.current;
      const self = currentSnapshot?.self;
      if (!currentSnapshot || !self || (!room && !hudScenario)) return;
      const selectedAbility = abilityType ?? self.abilityType;
      const ability = ABILITY_CONFIG[selectedAbility];
      if (self.abilityCooldownMs > 0 || self.abilityCharge < ability.chargeCost) return;
      if (selectedAbility === self.abilityType && !abilityWouldHaveEffect(self)) return;
      const time = performance.now();
      if (time - abilityThrottleRef.current < 350) return;
      abilityThrottleRef.current = time;
      if (!room) setAbilitySignal((value) => value + 1);
      inputRef.current.ability = true;
      window.setTimeout(() => {
        inputRef.current.ability = false;
      }, 140);
      if (!room) return;

      const input = inputRef.current;
      const payload: AbilityMessagePayload = {
        sequence: sequenceRef.current++,
        abilityType: selectedAbility,
        targetX: input.aimWorldX,
        targetY: input.aimWorldY
      };
      try {
        room.send(CLIENT_MESSAGE_TYPES.ABILITY, payload);
      } catch (error) {
        setNetworkMessage(error instanceof Error ? error.message : "Ability send failed");
      }
    },
    [canControlLocalPlayer, hudScenario, unlockAudio]
  );

  useEffect(() => {
    agentRoomUiRef.current = agentRoomUi;
  }, [agentRoomUi]);

  useEffect(() => {
    if (isManagedAgentState(agentRoomUi.agentState)) setAgentSetupOpen(false);
  }, [agentRoomUi.agentState]);

  const connectBrowserPairing = useCallback(async (pairingCode: string) => {
    try {
      await agentWebMcp.connectPairingCode(pairingCode, httpEndpoint);
      setAgentSetupOpen(false);
      setNetworkMessage("Agent connected through this browser");
    } catch (error) {
      setNetworkMessage(error instanceof Error ? error.message : "Browser agent pairing failed");
    } finally {
      agentPairingIntentRef.current = null;
    }
  }, [httpEndpoint]);

  const setupRoom = useCallback(
    (room: Room<any, Alpha7StateSchema>, reconnected = false) => {
      room.reconnection.enabled = false;
      const token = ++roomTokenRef.current;
      projectileImpactQueueRef.current = [];
      lastProjectileImpactRef.current = null;
      let recoveredQuickParticipant = false;
      writeRoomRecovery({ lastJoinMode: lastJoinModeRef.current });
      const redirectRecoveredQuickSpectator = (state: Alpha7StateSchema): boolean => {
        if (!reconnected) return false;
        const self = state.players.get(room.sessionId);
        if (!self) return false;
        if (isActiveMatchState(state.matchState) && self.isAlive && !self.isSpectator) {
          recoveredQuickParticipant = true;
          return false;
        }
        if (recoveredQuickParticipant) return false;
        if (
          !shouldStartFreshQuickPlayAfterReconnect(
            lastJoinModeRef.current,
            state.matchState,
            self
          )
        ) {
          return false;
        }

        roomTokenRef.current += 1;
        roomRef.current = null;
        reconnectTokenRef.current = null;
        writeReconnectToken(null);
        writeRoomRecovery(null);
        setSnapshot(null);
        setConnectionStatus("idle");
        setNetworkMessage("Finding a fresh match");
        setQueuedJoin({ mode: "quick", roomMode: state.policy.mode });
        void room.leave();
        return true;
      };

      roomRef.current = room;
      setConnectionStatus("connected");
      setNetworkMessage(reconnected ? "Reconnected" : "Connected");
      if (room.reconnectionToken) {
        reconnectTokenRef.current = room.reconnectionToken;
        writeReconnectToken(room.reconnectionToken);
      }
      const initialSelf = room.state.players.get(room.sessionId);
      if (!redirectRecoveredQuickSpectator(room.state) && (!reconnected || initialSelf)) {
        setSnapshot(snapshotFromState(room.state, room.roomId, room.sessionId));
      }
      if (AGENT_PLAY_ENABLED) {
        setAgentRoomUi((current) => agentRoomUiFromState(room.state, room.sessionId, current));
      }
      setJoinCode(room.roomId);

      room.onStateChange((state) => {
        if (roomTokenRef.current !== token) return;
        if (redirectRecoveredQuickSpectator(state)) return;
        if (room.reconnectionToken && reconnectTokenRef.current !== room.reconnectionToken) {
          reconnectTokenRef.current = room.reconnectionToken;
          writeReconnectToken(room.reconnectionToken);
        }
        setSnapshot(snapshotFromState(state, room.roomId, room.sessionId));
        if (AGENT_PLAY_ENABLED) {
          setAgentRoomUi((current) => agentRoomUiFromState(state, room.sessionId, current));
        }
      });
      room.onMessage<SystemMessagePayload>(SERVER_MESSAGE_TYPES.SYSTEM, (message) => {
        if (roomTokenRef.current !== token) return;
        setNetworkMessage(message.message);
        if (message.code === "pickup_collected" && message.pickupType && message.playerSessionId === room.sessionId) {
          const config = PICKUP_CONFIG[message.pickupType];
          const value = message.pickupValue ?? config.value;
          const durationMs = message.pickupDurationMs ?? config.durationMs;
          setPickupNotice({
            pickupType: message.pickupType,
            name: message.pickupName ?? config.name,
            detail: formatPickupDetail(message.pickupType, value),
            durationMs,
            expiresAt: Date.now() + Math.max(durationMs, 4500)
          });
        }
      });
      room.onMessage<ProjectileImpactMessagePayload>(SERVER_MESSAGE_TYPES.PROJECTILE_IMPACT, (message) => {
        if (roomTokenRef.current !== token) return;
        projectileImpactQueueRef.current.push(message);
        lastProjectileImpactRef.current = message;
        setImpactSignal((value) => value + 1);
      });
      room.onMessage<AgentPairingResultPayload>(SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT, (message) => {
        if (roomTokenRef.current !== token) return;
        if (!message.accepted) {
          setNetworkMessage(`Agent pairing unavailable${message.errorCode ? ` · ${message.errorCode}` : ""}`);
          return;
        }
        setAgentRoomUi((current) => ({
          ...current,
          agentState: message.seatState,
          requestId: message.requestId || current.requestId,
          pairingCode: message.pairingCode ?? current.pairingCode,
          expiresAtMs: message.expiresAtMs ?? current.expiresAtMs,
          readinessBlocked:
            current.mode === "wingman" || current.mode === "agent_cup"
              ? message.seatState !== "connected"
              : current.mode === "open_ffa"
                ? message.seatState !== "none" && message.seatState !== "connected"
                : false
        }));
        if (message.action === "cancel") {
          agentPairingIntentRef.current = null;
          setAgentSetupOpen(false);
          setNetworkMessage("Agent pairing cancelled");
        } else if (message.pairingCode && agentPairingIntentRef.current === "browser") {
          void connectBrowserPairing(message.pairingCode);
        } else {
          setAgentSetupOpen(message.seatState === "pending");
          setNetworkMessage("One-time agent code ready");
        }
      });
      room.onMessage<AgentControlResultPayload>(SERVER_MESSAGE_TYPES.AGENT_CONTROL_RESULT, (message) => {
        if (roomTokenRef.current !== token) return;
        if (!message.accepted) {
          setNetworkMessage(`Agent control unavailable${message.errorCode ? ` · ${message.errorCode}` : ""}`);
          return;
        }
        setAgentRoomUi((current) => ({
          ...current,
          agentState: message.seatState,
          readinessBlocked:
            current.mode === "wingman" || current.mode === "agent_cup"
              ? message.seatState !== "connected"
              : current.mode === "open_ffa"
                ? message.seatState !== "none" && message.seatState !== "connected"
                : false
        }));
        if (message.action === "disconnect") agentWebMcp.clearConnection();
        setPendingAgentControl(null);
        setNetworkMessage(`Agent ${message.seatState}`);
      });
      room.onMessage<ErrorMessagePayload>(SERVER_MESSAGE_TYPES.ERROR, (message) => {
        if (roomTokenRef.current !== token) return;
        setNetworkMessage(message.message);
      });
      room.onError((code, message) => {
        if (roomTokenRef.current !== token) return;
        setConnectionStatus("error");
        setNetworkMessage(message ?? `Room error ${code}`);
      });
      room.onLeave((code) => {
        if (roomTokenRef.current !== token) return;
        const leftVoluntarily =
          code === CloseCode.CONSENTED || code === CloseCode.NORMAL_CLOSURE;
        roomRef.current = null;
        setConnectionStatus(leftVoluntarily ? "idle" : "offline");
        setNetworkMessage(leftVoluntarily ? "Left room" : `Disconnected (${code})`);
        if (leftVoluntarily) {
          void agentWebMcp.disconnect().catch(() => undefined);
          reconnectTokenRef.current = null;
          writeReconnectToken(null);
          writeRoomRecovery(null);
          setSnapshot(null);
          setAgentRoomUi(DEFAULT_AGENT_ROOM_UI);
          setAgentSetupOpen(false);
          setPendingAgentControl(null);
        }
      });
    },
    [connectBrowserPairing]
  );

  const joinRoom = useCallback(
    async (mode: JoinMode, roomModeOverride?: RoomMode) => {
      if (connectionStatus === "connecting") return;
      requestMobileFullscreen();
      const requestedRoomMode = roomModeOverride ?? "classic";
      lastJoinModeRef.current = mode;
      setConnectionStatus("connecting");
      setNetworkMessage("");
      setScoreboardExpanded(false);
      setAgentRoomUi(DEFAULT_AGENT_ROOM_UI);
      setAgentSetupOpen(false);
      setPendingAgentControl(null);
      reconnectTokenRef.current = null;
      writeReconnectToken(null);
      writeRoomRecovery(null);

      const room = roomRef.current;
      if (room) {
        roomTokenRef.current += 1;
        roomRef.current = null;
        void room.leave();
      }

      const client = new Client(endpoint);
      const joinPayload: JoinMessagePayload = {
        playerName: sanitizeName(playerName),
        archetypeId: selectedTank,
        clientVersion: "0.1.0"
      };
      const query = new URLSearchParams(window.location.search);
      const debugRoomSeed =
        DEBUG_TOOLS_COMPILED && mode === "private" && query.get("alpha7DriveHarness") === "1"
          ? query.get("alpha7TestSeed")?.trim().slice(0, 64)
          : undefined;
      const options = {
        ...joinPayload,
        privateRoom: mode === "private" ? true : undefined,
        seed: debugRoomSeed || undefined,
        ...(AGENT_PLAY_ENABLED && mode !== "code"
          ? { roomMode: requestedRoomMode }
          : {})
      };

      try {
        let nextRoom: Room<any, Alpha7StateSchema>;

        if (mode === "quick") {
          nextRoom = await client.joinOrCreate(BATTLE_ROYALE_ROOM, options, Alpha7StateSchema);
        } else if (mode === "code") {
          const enteredRoom = joinCode.trim();
          const normalizedCode = enteredRoom.toUpperCase();
          try {
            nextRoom = await client.joinById(enteredRoom, joinPayload, Alpha7StateSchema);
          } catch (joinByIdError) {
            const resolvedRoomId = await resolveRoomIdByCode(httpEndpoint, normalizedCode);
            if (resolvedRoomId && resolvedRoomId !== enteredRoom) {
              nextRoom = await client.joinById(resolvedRoomId, joinPayload, Alpha7StateSchema);
            } else {
              const reservation = await reserveRoomByCode(httpEndpoint, normalizedCode, joinPayload);
              if (!reservation) throw joinByIdError;
              nextRoom = await client.consumeSeatReservation(reservation, Alpha7StateSchema);
            }
          }
        } else {
          nextRoom = await client.create(BATTLE_ROYALE_ROOM, options, Alpha7StateSchema);
        }

        setupRoom(nextRoom);
        nextRoom.send(CLIENT_MESSAGE_TYPES.JOIN, joinPayload);
      } catch (error) {
        setConnectionStatus("error");
        setSnapshot(null);
        setNetworkMessage(error instanceof Error ? error.message : "Unable to join room");
      }
    },
    [connectionStatus, endpoint, httpEndpoint, joinCode, playerName, selectedTank, setupRoom]
  );

  const beginMatchmaking = useCallback((mode: MatchmakingJoinMode) => {
    if (AGENT_PLAY_ENABLED) {
      setPendingJoinMode(mode);
      return;
    }
    void joinRoom(mode);
  }, [joinRoom]);

  const closeModeDialog = useCallback(() => {
    setPendingJoinMode(null);
  }, []);

  const selectRoomModeAndJoin = useCallback((mode: RoomMode) => {
    const joinMode = pendingJoinMode;
    if (!joinMode) return;
    setPendingJoinMode(null);
    void joinRoom(joinMode, mode);
  }, [joinRoom, pendingJoinMode]);

  const leaveRoom = useCallback(() => {
    void agentWebMcp.disconnect().catch(() => undefined);
    roomTokenRef.current += 1;
    const room = roomRef.current;
    roomRef.current = null;
    setSnapshot(null);
    setConnectionStatus("idle");
    setNetworkMessage("Left room");
    setJoinCode("");
    setScoreboardExpanded(false);
    setAgentRoomUi(DEFAULT_AGENT_ROOM_UI);
    setAgentSetupOpen(false);
    setPendingAgentControl(null);
    setPendingJoinMode(null);
    projectileImpactQueueRef.current = [];
    lastProjectileImpactRef.current = null;
    reconnectTokenRef.current = null;
    writeReconnectToken(null);
    writeRoomRecovery(null);
    if (room) void room.leave();
  }, []);

  const queueFreshQuickPlay = useCallback(() => {
    requestMobileFullscreen();
    const roomMode = snapshot?.policy.mode ?? "classic";
    if (roomRef.current) {
      setQueuedJoin({ mode: "quick", roomMode });
      leaveRoom();
      return;
    }
    setSnapshot(null);
    setConnectionStatus("idle");
    setNetworkMessage("");
    void joinRoom("quick", roomMode);
  }, [joinRoom, leaveRoom, snapshot?.policy.mode]);

  const reconnectRoom = useCallback(async () => {
    if (connectionStatus === "connecting" || reconnectInFlightRef.current) return;

    const token = reconnectTokenRef.current ?? readReconnectToken();
    if (!token) {
      void joinRoom(lastJoinModeRef.current);
      return;
    }

    reconnectInFlightRef.current = true;
    setConnectionStatus("connecting");
    setNetworkMessage("Reconnecting");

    try {
      const recovery = readRoomRecovery();
      if (recovery) lastJoinModeRef.current = recovery.lastJoinMode;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        try {
          const client = new Client(endpoint);
          const nextRoom = await client.reconnect(token, Alpha7StateSchema);
          const self = nextRoom.state.players.get(nextRoom.sessionId);
          if (
            shouldStartFreshQuickPlayAfterReconnect(
              recovery?.lastJoinMode ?? lastJoinModeRef.current,
              nextRoom.state.matchState,
              self
            )
          ) {
            await nextRoom.leave();
            reconnectTokenRef.current = null;
            writeReconnectToken(null);
            writeRoomRecovery(null);
            setSnapshot(null);
            setConnectionStatus("idle");
            setNetworkMessage("Finding a fresh match");
            setQueuedJoin({ mode: "quick", roomMode: nextRoom.state.policy.mode });
            return;
          }
          setupRoom(nextRoom, true);
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 6) {
            setNetworkMessage(`Reconnecting (${attempt + 1}/6)`);
            await sleep(220 * attempt);
          }
        }
      }
      throw lastError;
    } catch (error) {
      void agentWebMcp.disconnect().catch(() => undefined);
      reconnectTokenRef.current = null;
      writeReconnectToken(null);
      writeRoomRecovery(null);
      setConnectionStatus("error");
      setNetworkMessage(
        error instanceof Error
          ? `Session resume failed: ${error.message}`
          : "Session resume failed. Rejoin by room code."
      );
    } finally {
      reconnectInFlightRef.current = false;
    }
  }, [connectionStatus, endpoint, joinRoom, setupRoom]);

  useEffect(() => {
    if (scenarioSnapshot || route !== "arena" || connectionStatus !== "offline" || roomRef.current) {
      return;
    }
    if (!(reconnectTokenRef.current ?? readReconnectToken())) return;

    const reconnectTimer = window.setTimeout(() => {
      void reconnectRoom();
    }, 350);
    return () => window.clearTimeout(reconnectTimer);
  }, [connectionStatus, reconnectRoom, route, scenarioSnapshot]);

  useEffect(() => {
    if (scenarioSnapshot || route !== "arena" || connectionStatus !== "idle" || roomRef.current || snapshot) return;
    const token = reconnectTokenRef.current ?? readReconnectToken();
    if (!token) return;
    const recovery = readRoomRecovery();
    if (!shouldAutoReconnectOnPageLoad(recovery?.lastJoinMode)) {
      reconnectTokenRef.current = null;
      writeReconnectToken(null);
      writeRoomRecovery(null);
      return;
    }
    void reconnectRoom();
  }, [connectionStatus, reconnectRoom, route, scenarioSnapshot, snapshot]);

  const requestAgentPairing = useCallback((intent: "browser" | "copy") => {
    const room = roomRef.current;
    if (!room) return;
    agentPairingIntentRef.current = intent;
    const payload = agentPairingCreatePayload(
      agentRoomUiRef.current.agentLabel,
      agentRoomUiRef.current.tacticalReflexEnabled,
      agentRoomUiRef.current.openingTactic
    );
    try {
      room.send(CLIENT_MESSAGE_TYPES.AGENT_PAIRING_CREATE, payload);
      setNetworkMessage("Requesting one-time agent code");
    } catch (error) {
      agentPairingIntentRef.current = null;
      setNetworkMessage(error instanceof Error ? error.message : "Agent pairing request failed");
    }
  }, []);

  const copyOrCreateAgentPairing = useCallback(() => {
    if (agentRoomUi.pairingCode) {
      void copyTextToClipboard(agentRoomUi.pairingCode).then((copied) => {
        setNetworkMessage(copied ? "One-time agent code copied" : "Copy unavailable. Select and copy the visible code.");
      });
      return;
    }
    requestAgentPairing("copy");
  }, [agentRoomUi.pairingCode, requestAgentPairing]);

  const useBrowserAgentPairing = useCallback(() => {
    if (agentRoomUi.pairingCode) {
      agentPairingIntentRef.current = "browser";
      void connectBrowserPairing(agentRoomUi.pairingCode);
      return;
    }
    requestAgentPairing("browser");
  }, [agentRoomUi.pairingCode, connectBrowserPairing, requestAgentPairing]);

  const cancelAgentPairing = useCallback(() => {
    agentPairingIntentRef.current = null;
    const room = roomRef.current;
    if (!room) {
      setAgentSetupOpen(false);
      return;
    }
    try {
      room.send(CLIENT_MESSAGE_TYPES.AGENT_PAIRING_CANCEL, {});
      setNetworkMessage("Cancelling agent pairing");
    } catch (error) {
      setNetworkMessage(error instanceof Error ? error.message : "Agent pairing cancellation failed");
    }
  }, []);

  const controlAgent = useCallback((action: AgentControlAction) => {
    const room = roomRef.current;
    if (!room) return;
    try {
      room.send(CLIENT_MESSAGE_TYPES.AGENT_CONTROL, { action });
      setNetworkMessage(`${action.charAt(0).toUpperCase()}${action.slice(1)} agent requested`);
    } catch (error) {
      setNetworkMessage(error instanceof Error ? error.message : "Agent control request failed");
    }
  }, []);

  const requestAgentControl = useCallback((action: AgentControlAction): boolean => {
    if (action === "pause") {
      controlAgent(action);
      return false;
    }
    setPendingAgentControl(action);
    setNetworkMessage(`Confirm ${action} in Alpha-7`);
    return true;
  }, [controlAgent]);

  const confirmAgentControl = useCallback(() => {
    if (pendingAgentControl) controlAgent(pendingAgentControl);
    setPendingAgentControl(null);
  }, [controlAgent, pendingAgentControl]);

  const openAgentSetup = useCallback(() => {
    setAgentRoomUi((current) => ({
      ...current,
      agentLabel:
        current.agentLabel === DEFAULT_AGENT_ROOM_UI.agentLabel
          ? `${sanitizeName(playerName)} Agent`
          : current.agentLabel
    }));
    setAgentSetupOpen(true);
  }, [playerName]);

  useEffect(() => {
    if (
      !AGENT_PLAY_ENABLED ||
      !agentWebMcp.supported ||
      agentRoomUi.mode === "classic"
    ) {
      setWebMcpReady(false);
      return undefined;
    }
    setWebMcpReady(false);
    let disposed = false;
    let unregister: (() => void) | undefined;
    const releaseOnPageHide = () => void agentWebMcp.disconnect().catch(() => undefined);
    window.addEventListener("pagehide", releaseOnPageHide);
    void agentWebMcp.register({
      getAccessStatus: () => {
        const ui = agentRoomUiRef.current;
        const pairable = canRequestAgentPairing({
          matchState: snapshotRef.current?.matchState ?? "finished",
          mode: ui.mode,
          agentSeatState: ui.agentState,
          agentCount: ui.agentCount,
          pendingReservationCount: ui.pendingAgentCount,
          combatantCount: ui.combatantCount,
          agentControlCap: ui.agentControlCap,
          combatantCap: ui.combatantCap
        });
        return {
          eligible: Boolean(roomRef.current) && pairable,
          mode: ui.mode,
          track: ui.mode === "classic" ? "none" : "custom",
          agentSeatState: ui.agentState,
          humans: ui.humanCount,
          agents: ui.agentCount,
          combatants: ui.combatantCount,
          pairingConfirmationOpen: ui.agentState === "pending",
          readinessBlocked: ui.readinessBlocked
        };
      },
      requestPairing: (agentLabel, openingTactic) => {
        const ui = agentRoomUiRef.current;
        const pairable = canRequestAgentPairing({
          matchState: snapshotRef.current?.matchState ?? "finished",
          mode: ui.mode,
          agentSeatState: ui.agentState,
          agentCount: ui.agentCount,
          pendingReservationCount: ui.pendingAgentCount,
          combatantCount: ui.combatantCount,
          agentControlCap: ui.agentControlCap,
          combatantCap: ui.combatantCap
        });
        if (!roomRef.current || !pairable) {
          setNetworkMessage("Agent pairing is available in a waiting Custom / Unranked room with an open seat");
          return false;
        }
        setAgentRoomUi((current) => ({
          ...current,
          ...(agentLabel?.trim() ? { agentLabel: agentLabel.trim().slice(0, 32) } : {}),
          openingTactic
        }));
        setAgentSetupOpen(true);
        setNetworkMessage("Confirm agent access in Alpha-7");
        return true;
      },
      requestCancelPairing: () => {
        const pending = agentRoomUiRef.current.agentState === "pending";
        if (pending) {
          setAgentSetupOpen(true);
          setNetworkMessage("Confirm pairing cancellation in Alpha-7");
        }
        return pending;
      },
      requestControl: requestAgentControl
    }).then((dispose) => {
      if (disposed) dispose();
      else {
        unregister = dispose;
        setWebMcpReady(true);
      }
    }).catch((error) => {
      if (!disposed) console.warn("[alpha7] Site tool registration failed", error);
    });
    return () => {
      disposed = true;
      window.removeEventListener("pagehide", releaseOnPageHide);
      unregister?.();
      setWebMcpReady(false);
    };
  }, [agentRoomUi.mode, requestAgentControl]);

  const toggleReady = useCallback(() => {
    requestMobileFullscreen();
    const room = roomRef.current;
    const self = snapshotRef.current?.self;
    if (!room || !self) return;
    const payload: ReadyMessagePayload = { ready: !self.isReady };
    room.send(CLIENT_MESSAGE_TYPES.READY, payload);
  }, []);

  const startMatch = useCallback(() => {
    requestMobileFullscreen();
    const room = roomRef.current;
    if (!room) return;
    const payload: StartMessagePayload = { start: true };
    room.send(CLIENT_MESSAGE_TYPES.START, payload);
  }, []);

  const requestRematch = useCallback(() => {
    requestMobileFullscreen();
    const room = roomRef.current;
    const currentSnapshot = snapshotRef.current;
    const self = currentSnapshot?.self;
    if (!room || !currentSnapshot || !self) return;
    const payload: RematchMessagePayload = {
      ready: !self.isReady,
      previousMatchId: currentSnapshot.matchId
    };
    try {
      room.send(CLIENT_MESSAGE_TYPES.REMATCH, payload);
      setNetworkMessage(self.isReady ? "Rematch ready cleared" : "Rematch ready sent");
    } catch (error) {
      setNetworkMessage(error instanceof Error ? error.message : "Rematch send failed");
    }
  }, []);

  const copyRoomCode = useCallback(async (code: string) => {
    if (!code) return;
    setNetworkMessage(`Room code: ${code}`);
    const copied = await copyTextToClipboard(code);
    if (copied) setNetworkMessage("Room code copied");
  }, []);

  const updateAimScreen = useCallback((clientX: number, clientY: number) => {
    inputRef.current.aimMode = "screen";
    inputRef.current.aimScreenX = clientX;
    inputRef.current.aimScreenY = clientY;
    aimSyncRef.current?.(clientX, clientY);
  }, []);

  const toggleMinimapExpanded = useCallback(() => {
    setScoreboardExpanded(false);
    if (shouldCollapseTankInfoForViewport()) setTankInfoCollapsed(true);
    setMinimapExpanded((value) => !value);
  }, []);

  const toggleScoreboardExpanded = useCallback(() => {
    setMinimapExpanded(false);
    if (shouldCollapseTankInfoForViewport()) setTankInfoCollapsed(true);
    setScoreboardExpanded((value) => !value);
  }, []);

  useEffect(() => {
    if (route !== "arena") return undefined;

    const keyMove = (): void => {
      const keys = pressedKeysRef.current;
      let x = 0;
      let y = 0;
      if (keys.has("a") || keys.has("arrowleft")) x -= 1;
      if (keys.has("d") || keys.has("arrowright")) x += 1;
      if (keys.has("w") || keys.has("arrowup")) y -= 1;
      if (keys.has("s") || keys.has("arrowdown")) y += 1;
      keyboardMoveRef.current = normalizeVector(x, y);
      recomputeMove();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isInteractiveTarget(event.target)) return;
      const currentSnapshot = snapshotRef.current;
      const key = event.key.toLowerCase();
      if (key === "m" && !event.repeat) {
        event.preventDefault();
        toggleMinimapExpanded();
        return;
      }
      if (!currentSnapshot || !currentSnapshot.self?.isAlive || currentSnapshot.self.isSpectator) return;
      if (!isActiveMatchState(currentSnapshot.matchState) || connectionStatus !== "connected") return;

      const isMovementKey = MOVEMENT_KEYS.has(key);
      if (isMovementKey || key === " ") {
        event.preventDefault();
      }
      if (key === " " && !event.repeat) {
        inputRef.current.fire = true;
        triggerFire();
        return;
      }
      if (key === "q" && !event.repeat) {
        triggerAbility();
        return;
      }
      pressedKeysRef.current.add(key);
      keyMove();
      if (isMovementKey && !event.repeat) sendInputIntent();
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      if (key === " ") inputRef.current.fire = false;
      pressedKeysRef.current.delete(key);
      keyMove();
      if (MOVEMENT_KEYS.has(key)) sendInputIntent();
    };

    const onPointerUp = (event: globalThis.PointerEvent): void => {
      if (event.pointerType === "mouse") inputRef.current.fire = false;
    };

    const resetInput = (): void => {
      pressedKeysRef.current.clear();
      keyboardMoveRef.current = { x: 0, y: 0 };
      joystickMoveRef.current = { x: 0, y: 0 };
      joystickPointerIdRef.current = null;
      inputRef.current.fire = false;
      setJoystickKnob({ x: 0, y: 0 });
      resetMobileAim();
      recomputeMove();
      sendInputIntent();
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        resetInput();
        backgroundMusicAudioRef.current?.pause();
        rainAudioRef.current?.pause();
        tankMoveAudioRef.current?.pause();
        return;
      }
      if (audioUnlockedRef.current) {
        startBackgroundMusic();
        syncRainAudio();
      }
    };

    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", resetInput);
    window.addEventListener("orientationchange", resetInput);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", resetInput);
      window.removeEventListener("orientationchange", resetInput);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopMobileRapidFire();
    };
  }, [
    connectionStatus,
    recomputeMove,
    resetMobileAim,
    route,
    sendInputIntent,
    startBackgroundMusic,
    stopMobileRapidFire,
    syncRainAudio,
    toggleMinimapExpanded,
    triggerAbility,
    triggerFire
  ]);

  const buildDebugPayload = useCallback(() => {
      const currentSnapshot = snapshotRef.current ?? displaySnapshot;
      const currentServerNow = snapshotServerNow(currentSnapshot);
      const arena = typeof window !== "undefined" ? window.__alpha7ArenaState?.() : undefined;
      const activePickups = currentSnapshot.pickups.filter((pickup) => pickup.isActive).length;
      const worldMove = controlMoveToWorldMove(
        inputRef.current.moveX,
        inputRef.current.moveY,
        cameraOrbitAngleRef.current
      );
      const weatherDebug = arena?.weather ?? {
        configured: Boolean(currentSnapshot.map.weather),
        kind: currentSnapshot.map.weather.kind,
        intensity: currentSnapshot.map.weather.intensity,
        seed: currentSnapshot.map.weather.seed,
        active: false
      };
      const rectFor = (selector: string) => {
        const element = typeof document !== "undefined" ? document.querySelector<HTMLElement>(selector) : null;
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom)
        };
      };
      const overlaps = (
        a: ReturnType<typeof rectFor>,
        b: ReturnType<typeof rectFor>
      ): boolean =>
        Boolean(
          a &&
            b &&
            a.x < b.right &&
            a.right > b.x &&
            a.y < b.bottom &&
            a.bottom > b.y
        );
      const outsideViewport = (rect: ReturnType<typeof rectFor>): boolean =>
        Boolean(
          rect &&
            (rect.x < 0 ||
              rect.y < 0 ||
              rect.right > window.innerWidth ||
              rect.bottom > window.innerHeight)
        );
      const matchHeaderRect = rectFor(".match-header");
      const minimapRect = rectFor(".minimap-panel");
      const zoneWarningRect = rectFor(".zone-warning-banner");
      const compactHudRect = rectFor(".compact-hud");
      const tankStatusRect = rectFor(".tank-status-card");
      const scoreboardRect = rectFor(".scoreboard-panel.is-open");
      const abilityButtonRect = rectFor(".mobile-ability-button");
      const aimControlRect = rectFor(".mobile-aim-zone");
      const movementControlRect = rectFor(".mobile-stick");
      const weaponStripRect = rectFor(".weapon-strip");
      const currentAbility = currentSnapshot.self ? ABILITY_CONFIG[currentSnapshot.self.abilityType] : null;
      const abilityReady = Boolean(
        currentSnapshot.self &&
          currentAbility &&
          currentSnapshot.self.abilityCharge >= currentAbility.chargeCost &&
          currentSnapshot.self.abilityCooldownMs <= 0 &&
          abilityWouldHaveEffect(currentSnapshot.self)
      );
      return {
        route,
        mode: screenMode,
        connection: connectionStatus,
        coordinateSystem: "world origin at arena top-left; x increases right, y increases toward lower map edge",
        debug: {
          generatedAt: new Date().toISOString(),
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            dpr: window.devicePixelRatio
          },
          hud: {
            active,
            outsideSafeZone,
            showResults,
            showGameplayHud,
            showHudLayer,
            showLobbyHudDebug,
            showNetworkDiagnostics,
            showConnectionOverlay,
            showSpectatorOverlay,
            minimapExpanded,
            scoreboardExpanded,
            tankInfoCollapsed,
            mobilePortraitHud,
            scenario: hudScenario,
            abilityReady,
            abilityLabel: currentSnapshot.self ? MOBILE_ABILITY_LABELS[currentSnapshot.self.abilityType] : null,
            layout: {
              matchHeaderRect,
              minimapRect,
              zoneWarningRect,
              compactHudRect,
              tankStatusRect,
              scoreboardRect,
              abilityButtonRect,
              aimControlRect,
              movementControlRect,
              fireButtonRect: null,
              weaponStripRect,
              overlap: {
                matchHeaderWithMinimap: overlaps(matchHeaderRect, minimapRect),
                zoneWarningWithMinimap: overlaps(zoneWarningRect, minimapRect),
                zoneWarningWithMatchHeader: overlaps(zoneWarningRect, matchHeaderRect),
                compactHudWithZoneWarning: overlaps(compactHudRect, zoneWarningRect),
                compactHudWithMinimap: overlaps(compactHudRect, minimapRect),
                compactHudWithWeaponStrip: overlaps(compactHudRect, weaponStripRect),
                compactHudWithScoreboard: overlaps(compactHudRect, scoreboardRect),
                compactHudWithAim: overlaps(compactHudRect, aimControlRect),
                tankStatusWithMovement: overlaps(tankStatusRect, movementControlRect),
                scoreboardWithMinimap: overlaps(scoreboardRect, minimapRect),
                scoreboardWithAbility: overlaps(scoreboardRect, abilityButtonRect),
                scoreboardWithAim: overlaps(scoreboardRect, aimControlRect),
                scoreboardWithZoneWarning: overlaps(scoreboardRect, zoneWarningRect),
                scoreboardWithWeaponStrip: overlaps(scoreboardRect, weaponStripRect),
                minimapWithWeaponStrip: overlaps(minimapRect, weaponStripRect),
                aimWithAbility: overlaps(aimControlRect, abilityButtonRect),
                abilityWithFireButton: false,
                abilityWithBottomInset: Boolean(abilityButtonRect && abilityButtonRect.bottom > window.innerHeight - 4),
                abilityOutsideViewport: outsideViewport(abilityButtonRect)
              }
            }
          },
          network: {
            status: connectionStatus,
            message: networkMessage,
            endpoint,
            playersOnline,
            inlineVisible:
              showNetworkDiagnostics ||
              (Boolean(networkMessage) &&
                ((screenMode === "menu" && (connectionStatus === "error" || connectionStatus === "offline")) ||
                  (screenMode === "lobby" && networkMessage.startsWith("Room code"))))
          },
          audio: {
            unlocked: audioUnlockedRef.current,
            backgroundMusicCue: backgroundMusicCue.id,
            backgroundMusicContext,
            backgroundMusicIndex,
            backgroundMusicSource: backgroundMusicCue.src,
            backgroundMusicPlayNumber: backgroundMusicCompletedLoopsRef.current + 1,
            backgroundMusicTargetPlays:
              backgroundMusicContext === "menu"
                ? menuMusicPlayCount(backgroundMusicAudioRef.current?.duration ?? 0)
                : null,
            backgroundMusicPlaying: Boolean(
              backgroundMusicAudioRef.current && !backgroundMusicAudioRef.current.paused
            ),
            backgroundMusicVolume:
              Math.round((backgroundMusicAudioRef.current?.volume ?? 0) * 100) / 100,
            bedsDucked: bedDuckTimeoutRef.current !== null,
            rainCue: RAIN_AUDIO_CUE.id,
            rainPlaying: Boolean(rainAudioRef.current && !rainAudioRef.current.paused),
            rainVolume: Math.round(rainVolume * 100) / 100,
            rainActualVolume: Math.round((rainAudioRef.current?.volume ?? 0) * 100) / 100,
            movementCue: movementAudioCue.id,
            movementSource: movementAudioCue.src,
            movementPlaying: Boolean(tankMoveAudioRef.current && !tankMoveAudioRef.current.paused),
            thunderEligible: weatherCanThunder(currentSnapshot.map.weather),
            lastCue: lastAudioCueRef.current,
            lastError: lastAudioErrorRef.current,
            playedCueCount: audioCueCountRef.current
          },
          counts: {
            players: currentSnapshot.players.length,
            pickups: currentSnapshot.pickups.length,
            activePickups,
            projectiles: currentSnapshot.projectiles.length
          },
          pickupNotice: pickupNotice
            ? {
                pickupType: pickupNotice.pickupType,
                name: pickupNotice.name,
                detail: pickupNotice.detail,
                durationMs: pickupNotice.durationMs,
                expiresAt: pickupNotice.expiresAt,
                active: pickupNotice.expiresAt > Date.now()
              }
            : null,
          reconnect: {
            hasToken: Boolean(reconnectTokenRef.current ?? readReconnectToken()),
            tokenRoomId:
              (reconnectTokenRef.current ?? readReconnectToken())?.split(":")[0] ?? null
          }
        },
        room: {
          id: currentSnapshot.roomId,
          code: currentSnapshot.roomCode,
          matchState: currentSnapshot.matchState,
          tick: currentSnapshot.tick,
          serverTimeOffsetMs: currentSnapshot.serverTimeOffsetMs
        },
        map: {
          id: currentSnapshot.map.id,
          source: currentSnapshot.map.source,
          width: currentSnapshot.map.width,
          height: currentSnapshot.map.height,
          walls: currentSnapshot.map.walls.length,
          spawns: currentSnapshot.map.spawns.length,
          pickups: currentSnapshot.pickups.length,
          materialSource: arena?.map.materialSource ?? "unmounted",
          textureContract: arena?.map.textureContract ?? "unmounted",
          weather: {
            ...weatherDebug,
            screenOverlay: rainScreenOverlayDebug(currentSnapshot.map.weather)
          }
        },
        zone: currentSnapshot.zone,
        local: {
          pose: arena?.localPose ?? localPoseRef.current,
          health: currentSnapshot.self?.health ?? 0,
          armor: currentSnapshot.self?.armor ?? 0,
          speedMultiplier: currentSnapshot.self?.speedMultiplier ?? 1,
          weapon: currentSnapshot.self?.weaponType,
          ability: currentSnapshot.self?.abilityType,
          lastAbility: currentSnapshot.self
            ? {
                type: currentSnapshot.self.lastAbilityType,
                at: currentSnapshot.self.lastAbilityAt,
                endsAt: currentSnapshot.self.lastAbilityEndsAt,
                x: currentSnapshot.self.lastAbilityX,
                y: currentSnapshot.self.lastAbilityY,
                activeRemainingMs: abilityActiveRemainingMs(currentSnapshot.self, currentServerNow)
              }
            : null,
          activeSmoke: currentSnapshot.self
            ? {
                at: currentSnapshot.self.smokeActivatedAt,
                endsAt: currentSnapshot.self.smokeEndsAt,
                x: currentSnapshot.self.smokeX,
                y: currentSnapshot.self.smokeY,
                activeRemainingMs: isPlayerConcealedBySmoke(currentSnapshot.self, currentServerNow)
                  ? Math.max(0, currentSnapshot.self.smokeEndsAt - currentServerNow)
                  : 0
              }
            : null,
          acceptedFireSignals: fireSignal,
          lastFireSequence: fireSequenceRef.current,
          lastProjectileImpact: lastProjectileImpactRef.current
        },
        input: {
          ...inputRef.current,
          worldMove,
          mobileAim: {
            armed: aimArmed,
            knob: aimKnob,
            pointerActive: mobileAimGestureRef.current.pointerId !== null,
            rapidStarted: mobileAimGestureRef.current.rapidStarted
          },
          controlBasis: {
            orbitDegrees: Math.round((cameraOrbitAngleRef.current * 180) / Math.PI),
            screenForwardWorld: controlMoveToWorldMove(0, -1, cameraOrbitAngleRef.current),
            screenRightWorld: controlMoveToWorldMove(1, 0, cameraOrbitAngleRef.current)
          }
        },
        players: currentSnapshot.players.map((player) => ({
          id: player.sessionId,
          name: player.name,
          x: player.x,
          y: player.y,
          velocityX: player.velocityX,
          velocityY: player.velocityY,
          armor: player.armor,
          health: player.health,
          ready: player.isReady,
          alive: player.isAlive,
          spectator: player.isSpectator,
          self: player.isSelf
        })),
        pickups: currentSnapshot.pickups
          .filter((pickup) => pickup.isActive)
          .map((pickup) => ({
            id: pickup.id,
            type: pickup.pickupType,
            x: pickup.x,
            y: pickup.y,
            radius: pickup.radius
          })),
        arena
      };
    }, [
      active,
      aimArmed,
      aimKnob,
      connectionStatus,
      displaySnapshot,
      endpoint,
      fireSignal,
      hudScenario,
      minimapExpanded,
      mobilePortraitHud,
      backgroundMusicCue,
      backgroundMusicContext,
      backgroundMusicIndex,
      movementAudioCue,
      networkMessage,
      outsideSafeZone,
      pickupNotice,
      playersOnline,
      rainVolume,
      route,
      scoreboardExpanded,
      screenMode,
      showConnectionOverlay,
      showGameplayHud,
      showHudLayer,
      showLobbyHudDebug,
      showNetworkDiagnostics,
      showResults,
      showSpectatorOverlay,
      tankInfoCollapsed
    ]);

  useEffect(() => {
    if (!DEBUG_TOOLS_COMPILED) return undefined;
    window.advanceTime = (ms: number) => {
      window.__alpha7ArenaAdvance?.(ms);
    };
    window.render_game_to_text = () => JSON.stringify(buildDebugPayload());
    return () => {
      delete window.advanceTime;
      delete window.render_game_to_text;
    };
  }, [buildDebugPayload]);

  useEffect(() => {
    const closeRoomForReconnect = (): void => {
      roomTokenRef.current += 1;
      const room = roomRef.current;
      if (!room) return;
      roomRef.current = null;
      void room.leave(false);
    };
    const restoreRoomAfterPageShow = (event: PageTransitionEvent): void => {
      if (!event.persisted || roomRef.current) return;
      if (!(reconnectTokenRef.current ?? readReconnectToken())) return;
      setConnectionStatus("offline");
      setNetworkMessage("Restoring connection");
    };

    window.addEventListener("pagehide", closeRoomForReconnect);
    window.addEventListener("pageshow", restoreRoomAfterPageShow);
    window.addEventListener("beforeunload", closeRoomForReconnect);

    return () => {
      window.removeEventListener("pagehide", closeRoomForReconnect);
      window.removeEventListener("pageshow", restoreRoomAfterPageShow);
      window.removeEventListener("beforeunload", closeRoomForReconnect);
      closeRoomForReconnect();
    };
  }, []);

  const handleShellPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (route !== "arena") return;
      if (event.pointerType === "mouse" && !isInteractiveTarget(event.target)) {
        updateAimScreen(event.clientX, event.clientY);
      }
    },
    [route, updateAimScreen]
  );

  const handleShellPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      unlockAudio();
      if (
        !canControlLocalPlayer ||
        event.pointerType !== "mouse" ||
        event.button !== 0 ||
        event.shiftKey ||
        event.altKey ||
        isInteractiveTarget(event.target)
      ) {
        return;
      }
      updateAimScreen(event.clientX, event.clientY);
      inputRef.current.fire = true;
      triggerFire();
    },
    [canControlLocalPlayer, triggerFire, unlockAudio, updateAimScreen]
  );

  const updateJoystickFromPointer = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (joystickPointerIdRef.current !== event.pointerId) return false;
      const rect = event.currentTarget.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      const max = rect.width * 0.32;
      const length = Math.hypot(dx, dy);
      const scale = length > max ? max / length : 1;
      const knob = { x: dx * scale, y: dy * scale };
      setJoystickKnob(knob);
      joystickMoveRef.current = movementStickIntent(dx, dy, max, rect.width * 0.06);
      recomputeMove();
      return true;
    },
    [recomputeMove]
  );

  const handleStickPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      unlockAudio();
      if (!canControlLocalPlayer || joystickPointerIdRef.current !== null) return;
      joystickPointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      updateJoystickFromPointer(event);
      sendInputIntent();
    },
    [canControlLocalPlayer, sendInputIntent, unlockAudio, updateJoystickFromPointer]
  );

  const handleStickPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      updateJoystickFromPointer(event);
    },
    [updateJoystickFromPointer]
  );

  const handleStickPointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (joystickPointerIdRef.current !== event.pointerId) return;
      joystickPointerIdRef.current = null;
      joystickMoveRef.current = { x: 0, y: 0 };
      setJoystickKnob({ x: 0, y: 0 });
      recomputeMove();
      sendInputIntent();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [recomputeMove, sendInputIntent]
  );

  const updateMobileAimFromPointer = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const intent = aimStickIntent(
        event.clientX - (rect.left + rect.width / 2),
        event.clientY - (rect.top + rect.height / 2),
        rect.width * 0.32,
        rect.width * 0.13
      );
      const gesture = mobileAimGestureRef.current;
      if (gesture.pointerId !== event.pointerId) return;

      setAimKnob(intent.knob);
      if (!intent.active) {
        gesture.armed = false;
        gesture.rapidStarted = false;
        setAimArmed(false);
        stopMobileRapidFire();
        return;
      }

      const worldAim = controlMoveToWorldMove(
        intent.direction.x,
        intent.direction.y,
        cameraOrbitAngleRef.current
      );
      const pose = localPoseRef.current;
      inputRef.current.aimMode = "direction";
      inputRef.current.aimDirX = worldAim.x;
      inputRef.current.aimDirY = worldAim.y;
      inputRef.current.aimWorldX = pose.x + worldAim.x * 560;
      inputRef.current.aimWorldY = pose.y + worldAim.y * 560;

      const wasArmed = gesture.armed;
      gesture.armed = true;
      gesture.everArmed = true;
      setAimArmed(true);

      const self = snapshotRef.current?.self;
      if (!wasArmed && self && shouldRepeatHeldFire(self)) {
        stopMobileRapidFire();
        mobileRapidFireDelayRef.current = window.setTimeout(() => {
          const activeGesture = mobileAimGestureRef.current;
          const activeSelf = snapshotRef.current?.self;
          if (
            activeGesture.pointerId !== event.pointerId ||
            !activeGesture.armed ||
            !activeSelf ||
            !shouldRepeatHeldFire(activeSelf)
          ) {
            return;
          }
          mobileRapidFireDelayRef.current = null;
          inputRef.current.fire = true;
          if (triggerFire()) activeGesture.rapidStarted = true;
        }, MOBILE_RAPID_FIRE_HOLD_MS);
      }
    },
    [stopMobileRapidFire, triggerFire]
  );

  const handleAimPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      unlockAudio();
      if (!canControlLocalPlayer || mobileAimGestureRef.current.pointerId !== null) return;
      mobileAimGestureRef.current = {
        pointerId: event.pointerId,
        startedAt: performance.now(),
        startX: event.clientX,
        startY: event.clientY,
        armed: false,
        everArmed: false,
        rapidStarted: false
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      updateMobileAimFromPointer(event);
    },
    [canControlLocalPlayer, unlockAudio, updateMobileAimFromPointer]
  );

  const handleAimPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      updateMobileAimFromPointer(event);
    },
    [updateMobileAimFromPointer]
  );

  const finishMobileAim = useCallback(
    (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const gesture = mobileAimGestureRef.current;
      if (gesture.pointerId !== event.pointerId) return;

      const quickTap =
        !gesture.everArmed &&
        performance.now() - gesture.startedAt <= MOBILE_AIM_QUICK_TAP_MS &&
        Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) <=
          MOBILE_AIM_QUICK_TAP_DISTANCE;
      const shouldFire =
        !cancelled && !gesture.rapidStarted && (gesture.armed || quickTap);

      resetMobileAim();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (shouldFire) triggerFire();
    },
    [resetMobileAim, triggerFire]
  );

  const handleAimPointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      finishMobileAim(event, false);
    },
    [finishMobileAim]
  );

  const handleAimPointerCancel = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      finishMobileAim(event, true);
    },
    [finishMobileAim]
  );

  const handleLocalPose = useCallback((pose: LocalPose) => {
    localPoseRef.current = pose;
  }, []);

  const handleCameraOrbitAngle = useCallback((angle: number) => {
    cameraOrbitAngleRef.current = angle;
  }, []);

  const shellClass = `game-shell mode-${screenMode}${active ? " is-active-match" : ""}${outsideSafeZone ? " is-zone-breach" : ""}${showResults ? " has-results-overlay" : ""}${minimapExpanded ? " has-expanded-minimap" : ""}`;
  const debugPayloadText = showDebugPayload ? JSON.stringify(buildDebugPayload()) : null;

  return (
    <main
      className={shellClass}
      onClickCapture={handleUiAudioClick}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={handleShellPointerDown}
      onPointerMove={handleShellPointerMove}
    >
      {debugPayloadText ? (
        <pre data-testid="alpha7-debug-json" hidden>
          {debugPayloadText}
        </pre>
      ) : null}
      <audio
        aria-hidden="true"
        loop={backgroundMusicContext !== "menu"}
        onEnded={handleBackgroundMusicEnded}
        onLoadedMetadata={configureBackgroundMusicLoop}
        onTimeUpdate={handleBackgroundMusicTimeUpdate}
        preload="auto"
        ref={backgroundMusicAudioRef}
        src={backgroundMusicCue.src}
      />
      <audio
        aria-hidden="true"
        loop
        preload="auto"
        ref={rainAudioRef}
        src={RAIN_AUDIO_CUE.src}
      />
      <audio
        aria-hidden="true"
        preload="none"
        ref={tankMoveAudioRef}
        src={movementAudioCue.src}
      />
      <ArenaRenderer
        abilitySignal={abilitySignal}
        aimSyncRef={aimSyncRef}
        authoritativeSnapshot={Boolean(snapshot)}
        cameraFocusPlayerId={isSpectating ? spectatorTargetId : null}
        fireSequenceRef={fireSequenceRef}
        fireSignal={fireSignal}
        impactQueueRef={projectileImpactQueueRef}
        impactSignal={impactSignal}
        inputRef={inputRef}
        onCameraOrbitAngle={handleCameraOrbitAngle}
        onLocalPose={handleLocalPose}
        snapshot={displaySnapshot}
      />
      <RainScreenOverlay onThunder={playThunderAudio} weather={displaySnapshot.map.weather} />

      {outsideSafeZone ? <div className="zone-danger-vignette" /> : null}

      {showHudLayer ? (
        <div
          aria-hidden={blockingOverlayOpen || undefined}
          aria-label="Game HUD"
          className="hud-layer"
          inert={blockingOverlayOpen || undefined}
        >
          <MatchHeader now={authoritativeNow} outsideSafeZone={outsideSafeZone} snapshot={displaySnapshot} />
          <MiniMap
            expanded={minimapExpanded}
            localPose={localPoseRef.current}
            now={authoritativeNow}
            onToggleExpanded={toggleMinimapExpanded}
            outsideSafeZone={outsideSafeZone}
            snapshot={displaySnapshot}
          />
          {showGameplayHud && !isSpectating ? (
            <>
              {!mobilePortraitHud ? (
                <TankStatusCard
                  agentRoomUi={agentRoomUi}
                  collapsed={tankInfoCollapsed}
                  onControlAgent={requestAgentControl}
                  onToggle={() => setTankInfoCollapsed((value) => !value)}
                  player={selfPlayer}
                />
              ) : null}
              <WeaponStrip now={now} pickupNotice={pickupNotice} player={selfPlayer} />
              <AbilityDock
                assetManifest={assetManifest}
                now={authoritativeNow}
                onAbility={triggerAbility}
                player={selfPlayer}
              />
            </>
          ) : null}
          {liveSnapshot ? <ScoreboardPanel expanded={scoreboardExpanded} snapshot={liveSnapshot} /> : null}
          {outsideSafeZone && liveSnapshot ? <ZoneWarningBanner snapshot={liveSnapshot} /> : null}
          {liveSnapshot && showGameplayHud && !isSpectating ? (
            <CompactHudBar
              agentRoomUi={agentRoomUi}
              outsideSafeZone={outsideSafeZone}
              player={selfPlayer}
              scoreboardExpanded={scoreboardExpanded}
              snapshot={liveSnapshot}
              collapsed={tankInfoCollapsed}
              onControlAgent={requestAgentControl}
              onToggleCollapse={() => setTankInfoCollapsed((value) => !value)}
              onToggleScoreboard={toggleScoreboardExpanded}
            />
          ) : null}
        </div>
      ) : null}

      {screenMode === "menu" ? (
        <MenuPanel
          connectionStatus={connectionStatus}
          endpoint={endpoint}
          joinCode={joinCode}
          networkMessage={networkMessage}
          onBeginMatchmaking={beginMatchmaking}
          onCloseModeDialog={closeModeDialog}
          onJoin={joinRoom}
          onSelectRoomMode={selectRoomModeAndJoin}
          pendingJoinMode={pendingJoinMode}
          playerName={playerName}
          playersOnline={playersOnline}
          selectedTank={selectedTank}
          showNetworkDiagnostics={showNetworkDiagnostics}
          setJoinCode={setJoinCode}
          setPlayerName={setPlayerName}
          setSelectedTank={setSelectedTank}
        />
      ) : null}

      {screenMode === "lobby" && liveSnapshot ? (
        <LobbyPanel
          agentRoomUi={agentRoomUi}
          agentSetupOpen={agentSetupOpen}
          connectionStatus={connectionStatus}
          endpoint={endpoint}
          networkMessage={networkMessage}
          now={authoritativeNow}
          onCopyCode={() => {
            void copyRoomCode(liveSnapshot.roomCode);
          }}
          onCancelAgentPairing={cancelAgentPairing}
          onCloseAgentSetup={() => setAgentSetupOpen(false)}
          onControlAgent={requestAgentControl}
          onCopyOrCreateAgentPairing={copyOrCreateAgentPairing}
          onLeave={leaveRoom}
          onOpenAgentSetup={openAgentSetup}
          onUseBrowserAgent={useBrowserAgentPairing}
          onReady={toggleReady}
          onStart={startMatch}
          showNetworkDiagnostics={showNetworkDiagnostics}
          snapshot={liveSnapshot}
          webMcpSupported={webMcpReady}
        />
      ) : null}

      {canControlLocalPlayer ? (
        <MobileControls
          aimArmed={aimArmed}
          aimKnob={aimKnob}
          assetManifest={assetManifest}
          joystickKnob={joystickKnob}
          now={authoritativeNow}
          player={selfPlayer}
          onAbility={() => triggerAbility(selfPlayer?.abilityType)}
          onAimPointerCancel={handleAimPointerCancel}
          onAimPointerDown={handleAimPointerDown}
          onAimPointerMove={handleAimPointerMove}
          onAimPointerUp={handleAimPointerUp}
          onStickPointerDown={handleStickPointerDown}
          onStickPointerMove={handleStickPointerMove}
          onStickPointerUp={handleStickPointerUp}
        />
      ) : null}

      {canControlLocalPlayer && showDebugDriveHarness ? (
        <DebugDriveHarness
          onDisconnect={dropDebugRoomConnection}
          onMove={setDebugMove}
          onMoveTowardTarget={setDebugMoveTowardTarget}
        />
      ) : null}

      {showSpectatorOverlay && liveSnapshot ? (
        <SpectatorOverlay
          agentRoomUi={agentRoomUi}
          now={authoritativeNow}
          onControlAgent={requestAgentControl}
          onDismiss={() => setSpectatorOverlayDismissed(true)}
          onLeave={leaveRoom}
          onQuickPlay={queueFreshQuickPlay}
          snapshot={liveSnapshot}
        />
      ) : null}

      {isSpectating && spectatorOverlayDismissed && !blockingOverlayOpen ? (
        <SpectatorControls
          agentRoomUi={agentRoomUi}
          onControlAgent={requestAgentControl}
          onNext={() =>
            setSpectatorTargetId((current) =>
              cycleSpectatorTarget(availableSpectatorTargets, current, 1)
            )
          }
          onPrevious={() =>
            setSpectatorTargetId((current) =>
              cycleSpectatorTarget(availableSpectatorTargets, current, -1)
            )
          }
          target={spectatorTarget}
          targetCount={availableSpectatorTargets.length}
        />
      ) : null}

      {showResults && liveSnapshot ? (
        <ResultsOverlay
          connectionStatus={connectionStatus}
          onLeave={leaveRoom}
          onQuickPlay={queueFreshQuickPlay}
          onRematch={requestRematch}
          snapshot={liveSnapshot}
        />
      ) : null}

      {showConnectionOverlay && snapshot ? (
        <ConnectionOverlay
          connectionStatus={connectionStatus}
          message={networkMessage}
          onLeave={leaveRoom}
          onReconnect={reconnectRoom}
          roomCode={snapshot.roomCode}
        />
      ) : null}

      {pendingAgentControl ? (
        <AgentControlDialog
          action={pendingAgentControl}
          agentLabel={agentRoomUi.agentLabel}
          onCancel={() => setPendingAgentControl(null)}
          onConfirm={confirmAgentControl}
        />
      ) : null}

    </main>
  );
}

export function App() {
  if (typeof window !== "undefined" && isAgentConnectPath(window.location.pathname)) {
    return <AgentConnectPage apiBaseUrl={httpEndpointFromEnv()} />;
  }
  const audioLabEnabled =
    DEBUG_TOOLS_COMPILED &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("alpha7AudioLab") === "1";
  return audioLabEnabled ? <AudioReviewLab /> : <GameApp />;
}
