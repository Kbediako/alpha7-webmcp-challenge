import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const configDir = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(configDir, "../../../.env") });
loadEnv({ path: resolve(configDir, "../.env") });

const numberFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const booleanFromEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
};

const port = numberFromEnv("PORT", 2567);
const nodeEnv = process.env.NODE_ENV ?? "development";
const publicClientUrl = process.env.PUBLIC_CLIENT_URL ?? "http://localhost:5173";
const publicServerUrl = process.env.PUBLIC_SERVER_URL ?? `http://localhost:${port}`;
const publicServerCompatUrls = (process.env.PUBLIC_SERVER_COMPAT_URLS ?? "")
  .split(",")
  .map((url) => url.trim().replace(/\/$/, ""))
  .filter(Boolean);
const agentPlayEnabled = booleanFromEnv("AGENT_PLAY_ENABLED", false);

export const assertAgentPublicServerUrl = (
  environment: string,
  enabled: boolean,
  value: string
): void => {
  if (!enabled) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_SERVER_URL must be an absolute URL when agent play is enabled");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(environment !== "production" && loopback && url.protocol === "http:")) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (environment === "production" && loopback)
  ) {
    throw new Error("PUBLIC_SERVER_URL must be a public HTTPS origin when agent play is enabled");
  }
};

assertAgentPublicServerUrl(nodeEnv, agentPlayEnabled, publicServerUrl);
for (const compatUrl of publicServerCompatUrls) {
  assertAgentPublicServerUrl(nodeEnv, agentPlayEnabled, compatUrl);
}
const publicServerUrls = Array.from(new Set([publicServerUrl, ...publicServerCompatUrls]));
const allowedOrigins = Array.from(
  new Set(
    (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .concat(publicClientUrl)
  )
);

export const serverConfig = {
  port,
  nodeEnv,
  allowedOrigins,
  publicClientUrl,
  publicServerUrl,
  publicServerUrls,
  demoMaxPlayers: Math.min(8, Math.max(2, Math.floor(numberFromEnv("DEMO_MAX_PLAYERS", 8)))),
  roomTickRate: numberFromEnv("ROOM_TICK_RATE", 30),
  roomPatchRate: numberFromEnv("ROOM_PATCH_RATE", 20),
  roomAutoStartSeconds: numberFromEnv("ROOM_AUTO_START_SECONDS", 12),
  enableCapacityMetrics: booleanFromEnv("ENABLE_CAPACITY_METRICS", false),
  agentPlayEnabled,
  agentTacticalReflexEnabled: booleanFromEnv("AGENT_TACTICAL_REFLEX_ENABLED", false),
  agentExpandedCombatantsEnabled: booleanFromEnv("AGENT_EXPANDED_COMBATANTS_ENABLED", false),
  agentCupMaxControlsEnabled: booleanFromEnv("AGENT_CUP_MAX_CONTROLS_ENABLED", false),
  logLevel: process.env.LOG_LEVEL ?? "info",
  buildVersion: process.env.npm_package_version ?? "0.1.0"
} as const;

export type ServerConfig = typeof serverConfig;
