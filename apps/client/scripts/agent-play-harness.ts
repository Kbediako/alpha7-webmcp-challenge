import { Client, type Room } from "@colyseus/sdk";
import { readFileSync } from "node:fs";
import {
  AGENT_ACTION_INTERVAL_MS,
  AGENT_OBSERVATION_INTERVAL_MS,
  AGENT_TACTICAL_REFLEX_INTERVAL_MS,
  AGENT_TACTICAL_ZONE_SAFETY_MARGIN,
  BATTLE_ROYALE_ROOM,
  CLIENT_MESSAGE_TYPES,
  chooseAgentTacticalRetreat,
  isAgentTacticalIntentResultV1,
  isAgentTacticalStatusV1,
  SERVER_MESSAGE_TYPES,
  type AgentArenaDescriptorV1,
  type AgentConnectionDescriptorV1,
  type AgentControlStatusV1,
  type AgentMacroActionV1,
  type AgentObservationV1,
  type AgentPairingResultPayload,
  type AgentTacticalConnectionDescriptorV2,
  type AgentTacticalIntentResultV1,
  type AgentTacticalIntentV1,
  type AgentTacticalStatusV1,
  type InputMessagePayload,
  type RoomMode
} from "@alpha7/shared";
import { Alpha7StateSchema } from "@alpha7/shared/schema";
import {
  agentFailureCode,
  agentActionResultCode,
  capacityFlagsMatchProfile,
  harnessTargetsMatch,
  isRetryableAuthoritativeStaleActionRejection,
  isLoopbackTarget,
  tacticalUnsupportedFlag,
  tacticalMovementDemanded,
  tacticalMotionGapsWithinLimits,
  type HarnessAgentActionResult
} from "./agent-play-harness-policy.js";

type GameRoom = Room<any, Alpha7StateSchema>;
type ReleasableConnection = Pick<
  AgentConnectionDescriptorV1 | AgentTacticalConnectionDescriptorV2,
  "roomId" | "brokerCredential"
>;

const args = process.argv.slice(2);
const valueAfter = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const mode = (valueAfter("--mode") ?? (args.includes("--tactical-reflex") ? "open_ffa" : "agent_cup")) as RoomMode;
const wsUrl = valueAfter("--ws") ?? process.env.VITE_WS_URL ?? "ws://localhost:2567";
const httpUrl = (valueAfter("--http") ?? process.env.ALPHA7_HTTP_API_URL ?? process.env.VITE_HTTP_API_URL ?? "http://localhost:2567").replace(/\/$/, "");
const connectOnly = args.includes("--connect");
const tacticalReflex = args.includes("--tactical-reflex");
const lifecycle = args.includes("--lifecycle");
const smokeLifecycle = args.includes("--smoke");
const rematchLifecycle = args.includes("--rematch");
const idleExpiryLifecycle = args.includes("--idle-expiry");
const revokeLifecycle = args.includes("--revoke");
const verifyCapacity = args.includes("--verify-capacity");
const verifyCleanup = args.includes("--verify-cleanup");
const durationValue = valueAfter("--duration-ms");
const durationMs = durationValue === undefined && connectOnly
  ? Number.POSITIVE_INFINITY
  : Number(durationValue ?? 15_000);
const ownerCount = Number(valueAfter("--owners") ?? 2);
const cleanupHoldMs = Number(valueAfter("--cleanup-hold-ms") ?? 0);
const json = args.includes("--json");
const allowRemote = args.includes("--allow-remote");
const expectedEnvironmentId = valueAfter("--environment-id");
const unsupportedTacticalFlag = tacticalUnsupportedFlag(args);
const temporaryControlCodes = new Set(["match_not_active", "agent_paused", "owner_unavailable"]);
const HARNESS_REQUEST_INTERVAL_MS = 600;
const TACTICAL_REACQUISITION_LIMIT_MS = AGENT_TACTICAL_REFLEX_INTERVAL_MS + 100;
const TACTICAL_STALL_CHECKPOINTS_MS = [5_000, 10_000, 20_000, 30_000, 60_000] as const;
const productionHosts = new Set([
  "alpha7.asabeko.com",
  "api.alpha7.asabeko.com",
  "alpha7-production.up.railway.app"
]);
const isLoopback = isLoopbackTarget;

if (!(["wingman", "open_ffa", "agent_cup"] as RoomMode[]).includes(mode)) {
  throw new Error("--mode must be wingman, open_ffa, or agent_cup");
}
const httpTarget = new URL(httpUrl);
if (httpTarget.protocol !== "https:" && !(isLoopback(httpUrl) && httpTarget.protocol === "http:")) {
  throw new Error("remote agent targets require HTTPS");
}
if (!connectOnly) {
  const wsTarget = new URL(wsUrl);
  const targetHosts = [wsTarget.hostname, httpTarget.hostname];
  if (targetHosts.some((host) => productionHosts.has(host))) {
    throw new Error("capacity harness refuses Alpha-7 production targets");
  }
  if (!allowRemote && (!isLoopback(wsUrl) || !isLoopback(httpUrl))) {
    throw new Error("remote capacity targets require --allow-remote");
  }
  if ((!isLoopback(wsUrl) || !isLoopback(httpUrl)) && (
    wsTarget.protocol !== "wss:" || httpTarget.protocol !== "https:"
  )) {
    throw new Error("remote capacity targets require HTTPS and WSS");
  }
  if ((!isLoopback(wsUrl) || !isLoopback(httpUrl)) && !expectedEnvironmentId) {
    throw new Error("remote capacity targets require --environment-id");
  }
}
if (!connectOnly && (!Number.isInteger(ownerCount) || ownerCount < 2 || ownerCount > 8)) {
  throw new Error("--owners must be an integer from 2 to 8");
}
if (tacticalReflex && (connectOnly || mode !== "open_ffa")) {
  throw new Error("--tactical-reflex requires the open_ffa harness (and cannot combine with --connect)");
}
if (tacticalReflex && unsupportedTacticalFlag) {
  throw new Error(`${unsupportedTacticalFlag} is not supported with --tactical-reflex`);
}
if (durationMs !== Number.POSITIVE_INFINITY && (
  !Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 3_600_000
)) {
  throw new Error("--duration-ms must be an integer from 1000 to 3600000");
}
if (!Number.isSafeInteger(cleanupHoldMs) || cleanupHoldMs < 0 || cleanupHoldMs > 120_000) {
  throw new Error("--cleanup-hold-ms must be an integer from 0 to 120000");
}
if (cleanupHoldMs > 0 && !verifyCleanup) {
  throw new Error("--cleanup-hold-ms requires --verify-cleanup");
}
if ((idleExpiryLifecycle || revokeLifecycle) && durationMs > 60_000) {
  throw new Error("run destructive lifecycle checks separately with --duration-ms <= 60000");
}
if (idleExpiryLifecycle && revokeLifecycle) {
  throw new Error("run --idle-expiry and --revoke as separate lifecycle trials");
}
if (rematchLifecycle && (idleExpiryLifecycle || revokeLifecycle)) {
  throw new Error("run --rematch separately from destructive idle/revoke lifecycle trials");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const fetchAgent = (
  input: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<Response> => fetch(input, {
  ...init,
  signal: signal
    ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
    : AbortSignal.timeout(5_000)
});
const responseFailure = async (label: string, response: Response): Promise<never> => {
  const code = agentFailureCode(await response.json().catch(() => undefined));
  throw new Error(`${label} failed with ${response.status}${code ? ` (${code})` : ""}`);
};
const assertSafeHarnessTarget = async (): Promise<void> => {
  if (!harnessTargetsMatch(wsUrl, httpUrl)) {
    throw new Error("--ws and --http must target the same host and port");
  }
  if (isLoopback(wsUrl) && isLoopback(httpUrl)) return;
  const response = await fetchAgent(`${httpUrl}/capacityz`, {
    headers: { Accept: "application/json", Connection: "close" }
  });
  const payload = response.ok
    ? await response.json() as {
        telemetryVersion?: unknown;
        environment?: unknown;
        environmentId?: unknown;
      }
    : undefined;
  if (
    payload?.telemetryVersion !== 3 ||
    typeof payload.environment !== "string" ||
    !payload.environment.startsWith("capacity-") ||
    payload.environmentId !== expectedEnvironmentId
  ) {
    throw new Error("remote capacity harness requires the expected disposable environment identity");
  }
};
const waitFor = async (
  label: string,
  predicate: () => boolean,
  timeoutMs = 15_000,
  signal?: AbortSignal
): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error(`${label} interrupted`);
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const connectRoom = async (
  label: string,
  start: () => Promise<GameRoom>,
  signal: AbortSignal,
  timeoutMs = 15_000
): Promise<GameRoom> => {
  if (signal.aborted) throw new Error(`${label} interrupted`);
  const operation = start();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<GameRoom>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
        onAbort = () => reject(new Error(`${label} interrupted`));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } catch (error) {
    void operation.then((room) => room.leave().catch(() => undefined), () => undefined);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};

interface CleanupCapacitySnapshot {
  telemetryVersion: 3;
  rooms: {
    local: { roomCount: number; ccu: number };
    aggregate: { roomCount: number; ccu: number };
  };
  agent: {
    enabled: boolean;
    expandedCombatantsEnabled: boolean;
    cupMaxControlsEnabled: boolean;
    broker: {
      pendingGrants: number;
      retainedGrants: number;
      activeControls: number;
      brokerRateBuckets: number;
      httpRateBuckets: number;
    };
    roomTotals: {
      owners: number;
      connectedOwners: number;
      controls: number;
      agentEntities: number;
      combatants: number;
      activeLeases: number;
      pausedControls: number;
      pendingPairings: number;
    };
    snapshotFailures: number;
  };
  runtime: {
    simulationTick: {
      count: number;
      p95Ms: number;
      p99Ms: number;
      maxMs: number;
      overBudgetCount: number;
      droppedSlowTickCount: number;
    };
    eventLoop: {
      utilization: number;
      p95DelayMs: number;
      p99DelayMs: number;
      maxDelayMs: number;
    };
    memory: { rssBytes: number; heapUsedBytes: number };
    uptimeSeconds: number;
  };
}

const readCleanupCapacity = async (): Promise<CleanupCapacitySnapshot> => {
  const response = await fetchAgent(`${httpUrl}/capacityz`, {
    headers: { Accept: "application/json", Connection: "close" }
  });
  const payload = response.ok
    ? await response.json() as Partial<CleanupCapacitySnapshot>
    : undefined;
  if (
    !response.ok ||
    payload?.telemetryVersion !== 3 ||
    typeof payload.rooms?.local?.roomCount !== "number" ||
    typeof payload.rooms.local.ccu !== "number" ||
    typeof payload.rooms?.aggregate?.roomCount !== "number" ||
    typeof payload.rooms.aggregate.ccu !== "number" ||
    typeof payload.agent?.enabled !== "boolean" ||
    typeof payload.agent.expandedCombatantsEnabled !== "boolean" ||
    typeof payload.agent.cupMaxControlsEnabled !== "boolean" ||
    typeof payload.agent?.broker?.pendingGrants !== "number" ||
    typeof payload.agent.broker.retainedGrants !== "number" ||
    typeof payload.agent.broker.activeControls !== "number" ||
    typeof payload.agent.broker.brokerRateBuckets !== "number" ||
    typeof payload.agent.broker.httpRateBuckets !== "number" ||
    typeof payload.agent.roomTotals?.controls !== "number" ||
    typeof payload.agent.roomTotals.activeLeases !== "number" ||
    typeof payload.agent.snapshotFailures !== "number" ||
    typeof payload.runtime?.simulationTick?.p95Ms !== "number" ||
    typeof payload.runtime.simulationTick.p99Ms !== "number" ||
    typeof payload.runtime.eventLoop?.utilization !== "number" ||
    typeof payload.runtime.memory?.rssBytes !== "number"
  ) {
    throw new Error(`/capacityz unavailable for cleanup verification (${response.status})`);
  }
  return payload as CleanupCapacitySnapshot;
};

const cleanupIsEmpty = (snapshot: CleanupCapacitySnapshot): boolean => {
  const totals = snapshot.agent.roomTotals;
  return (
    snapshot.rooms.aggregate.roomCount === 0 &&
    snapshot.rooms.aggregate.ccu === 0 &&
    snapshot.agent.broker.pendingGrants === 0 &&
    snapshot.agent.broker.retainedGrants === 0 &&
    snapshot.agent.broker.activeControls === 0 &&
    snapshot.agent.broker.brokerRateBuckets === 0 &&
    snapshot.agent.broker.httpRateBuckets === 0 &&
    snapshot.agent.snapshotFailures === 0 &&
    Object.values(totals).every((value) => value === 0)
  );
};

const verifyCleanupHold = async (holdMs: number): Promise<{ holdMs: number; samples: number }> => {
  const cleanupDeadline = Date.now() + 75_000;
  let snapshot = await readCleanupCapacity();
  while (!cleanupIsEmpty(snapshot) && Date.now() < cleanupDeadline) {
    await sleep(250);
    snapshot = await readCleanupCapacity();
  }
  if (!cleanupIsEmpty(snapshot)) {
    throw new Error(`cleanup did not reach zero: ${JSON.stringify(snapshot)}`);
  }

  let samples = 1;
  const holdDeadline = Date.now() + holdMs;
  while (Date.now() < holdDeadline) {
    await sleep(Math.min(5_000, holdDeadline - Date.now()));
    snapshot = await readCleanupCapacity();
    samples += 1;
    if (!cleanupIsEmpty(snapshot)) {
      throw new Error(`cleanup regressed during idle hold: ${JSON.stringify(snapshot)}`);
    }
  }
  return { holdMs, samples };
};

const collectCapacityEvidence = async (
  stopAt: number,
  expectedOwners: number,
  expectedCombatants: number,
  shouldStop: () => boolean
): Promise<{
  samples: number;
  checks: Record<string, boolean>;
  simulationTickMs: { maxP95: number; maxP99: number; max: number };
  eventLoop: { maxUtilization: number; maxP95DelayMs: number; maxP99DelayMs: number };
  memory: {
    firstRssBytes: number;
    lastRssBytes: number;
    growthBytes: number;
    finalWindowGrowthBytes: number;
  };
}> => {
  const samples: CleanupCapacitySnapshot[] = [];
  while (Date.now() < stopAt && !shouldStop()) {
    const snapshot = await readCleanupCapacity();
    samples.push(snapshot);
    await sleep(Math.min(2_000, Math.max(1, stopAt - Date.now())));
  }
  if (samples.length === 0) throw new Error("capacity validation collected no samples");
  const activeSamples = samples.filter((snapshot) => snapshot.runtime.simulationTick.count > 0);
  const rss = activeSamples.map((snapshot) => snapshot.runtime.memory.rssBytes);
  const simulationTickMs = {
    maxP95: Math.max(0, ...activeSamples.map((snapshot) => snapshot.runtime.simulationTick.p95Ms)),
    maxP99: Math.max(0, ...activeSamples.map((snapshot) => snapshot.runtime.simulationTick.p99Ms)),
    max: Math.max(0, ...activeSamples.map((snapshot) => snapshot.runtime.simulationTick.maxMs))
  };
  const eventLoop = {
    maxUtilization: Math.max(0, ...activeSamples.map((snapshot) => snapshot.runtime.eventLoop.utilization)),
    maxP95DelayMs: Math.max(0, ...activeSamples.map((snapshot) => snapshot.runtime.eventLoop.p95DelayMs)),
    maxP99DelayMs: Math.max(0, ...activeSamples.map((snapshot) => snapshot.runtime.eventLoop.p99DelayMs))
  };
  const memory = {
    firstRssBytes: rss[0] ?? 0,
    lastRssBytes: rss.at(-1) ?? 0,
    growthBytes: (rss.at(-1) ?? 0) - (rss[0] ?? 0),
    finalWindowGrowthBytes: (rss.at(-1) ?? 0) - (rss.at(-4) ?? rss[0] ?? 0)
  };
  const checks = {
    capacityProfileFlags: samples.every((snapshot) =>
      snapshot.agent.enabled &&
      capacityFlagsMatchProfile({
        mode,
        ownerCount: expectedOwners,
        expectedCombatants,
        expandedCombatantsEnabled: snapshot.agent.expandedCombatantsEnabled,
        cupMaxControlsEnabled: snapshot.agent.cupMaxControlsEnabled
      })
    ),
    exactRoomCounts: samples.every((snapshot) =>
      snapshot.rooms.local.roomCount === 1 &&
      snapshot.rooms.local.ccu === expectedOwners &&
      snapshot.rooms.aggregate.roomCount === 1 &&
      snapshot.rooms.aggregate.ccu === expectedOwners
    ),
    exactControlCounts: samples.every((snapshot) =>
      snapshot.agent.broker.pendingGrants === 0 &&
      snapshot.agent.broker.activeControls === expectedOwners &&
      snapshot.agent.roomTotals.owners === expectedOwners &&
      snapshot.agent.roomTotals.connectedOwners === expectedOwners &&
      snapshot.agent.roomTotals.controls === expectedOwners &&
      snapshot.agent.roomTotals.agentEntities === expectedOwners &&
      snapshot.agent.roomTotals.combatants === expectedCombatants &&
      snapshot.agent.roomTotals.pausedControls === 0 &&
      snapshot.agent.roomTotals.pendingPairings === 0 &&
      snapshot.agent.snapshotFailures === 0
    ),
    fullExecutorConcurrencyObserved: samples.some((snapshot) =>
      snapshot.agent.roomTotals.activeLeases === expectedOwners &&
      snapshot.agent.roomTotals.pausedControls === 0
    ),
    simulationTick:
      activeSamples.length > 0 &&
      simulationTickMs.maxP95 <= 16.7 &&
      simulationTickMs.maxP99 < 33.3 &&
      activeSamples.every((snapshot) =>
        snapshot.runtime.simulationTick.overBudgetCount === 0 &&
        snapshot.runtime.simulationTick.droppedSlowTickCount === 0
      ),
    eventLoop:
      eventLoop.maxUtilization < 0.6 &&
      eventLoop.maxP95DelayMs < 20 &&
      eventLoop.maxP99DelayMs < 50,
    stableMemory:
      memory.growthBytes <= 64 * 1024 * 1024 &&
      memory.finalWindowGrowthBytes <= 32 * 1024 * 1024,
    noRestart: samples.every((snapshot, index) =>
      index === 0 || snapshot.runtime.uptimeSeconds >= (samples[index - 1]?.runtime.uptimeSeconds ?? 0)
    )
  };
  if (!Object.values(checks).every(Boolean)) {
    throw new Error(`capacity checks failed: ${JSON.stringify({ checks, simulationTickMs, eventLoop, memory })}`);
  }
  return { samples: samples.length, checks, simulationTickMs, eventLoop, memory };
};

const heartbeatControl = async (
  connection: AgentConnectionDescriptorV1,
  signal?: AbortSignal
): Promise<void> => {
  const response = await fetchAgent(`${httpUrl}/agent/rooms/${connection.roomId}/heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.brokerCredential}` }
  }, signal);
  if (!response.ok) throw new Error(`heartbeat failed with ${response.status}`);
};

const readControlStatus = async (
  connection: AgentConnectionDescriptorV1,
  signal?: AbortSignal
): Promise<AgentControlStatusV1> => {
  const response = await fetchAgent(`${httpUrl}/agent/rooms/${connection.roomId}/status`, {
    headers: { Authorization: `Bearer ${connection.brokerCredential}` }
  }, signal);
  if (!response.ok) throw new Error(`status failed with ${response.status}`);
  return await response.json() as AgentControlStatusV1;
};

const readObservation = async (
  connection: AgentConnectionDescriptorV1,
  signal?: AbortSignal
): Promise<AgentObservationV1> => {
  const response = await fetchAgent(`${httpUrl}/agent/rooms/${connection.roomId}/observation`, {
    headers: { Authorization: `Bearer ${connection.brokerCredential}` }
  }, signal);
  if (!response.ok) throw new Error(`observation failed with ${response.status}`);
  return await response.json() as AgentObservationV1;
};

const expectCredentialRejected = async (
  connection: ReleasableConnection
): Promise<string> => {
  const response = await fetchAgent(`${httpUrl}/agent/rooms/${connection.roomId}/status`, {
    headers: { Authorization: `Bearer ${connection.brokerCredential}` }
  });
  const payload = await response.json().catch(() => undefined) as unknown;
  const valid = Boolean(
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    exactObjectKeys(payload as Record<string, unknown>, ["version", "ok", "error"]) &&
    (payload as { version?: unknown }).version === 1 &&
    (payload as { ok?: unknown }).ok === false &&
    (payload as { error?: unknown }).error &&
    typeof (payload as { error: unknown }).error === "object" &&
    exactObjectKeys((payload as { error: Record<string, unknown> }).error, ["code"]) &&
    (payload as { error: { code?: unknown } }).error.code === "agent_revoked"
  );
  if (response.ok || !valid) {
    throw new Error(`stale credential rejection was invalid (${response.status})`);
  }
  return "agent_revoked";
};

const clearSegment = (
  arena: AgentArenaDescriptorV1,
  from: { x: number; z: number },
  to: { x: number; z: number },
  margin = 42
): boolean => {
  const distance = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.max(1, Math.ceil(distance / 18));
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const x = from.x + (to.x - from.x) * progress;
    const z = from.z + (to.z - from.z) * progress;
    if (
      x < arena.bounds.minX + margin ||
      x > arena.bounds.maxX - margin ||
      z < arena.bounds.minZ + margin ||
      z > arena.bounds.maxZ - margin
    ) return false;
    if (arena.walls.some((wall) =>
      x >= wall.x - margin &&
      x <= wall.x + wall.width + margin &&
      z >= wall.z - margin &&
      z <= wall.z + wall.depth + margin
    )) return false;
  }
  return true;
};

const chooseWaypoint = (
  observation: AgentObservationV1,
  arena: AgentArenaDescriptorV1,
  target: AgentObservationV1["opponents"][number] | undefined
): { x: number; z: number } | undefined => {
  const self = observation.self.position;
  const outsideZone = Math.hypot(
    self.x - observation.zone.centerX,
    self.z - observation.zone.centerZ
  ) > Math.max(0, observation.zone.radius - 90);
  const destination = outsideZone
    ? { x: observation.zone.centerX, z: observation.zone.centerZ }
    : target?.position;
  if (!destination) return undefined;
  const baseAngle = Math.atan2(destination.z - self.z, destination.x - self.x);
  const offsets = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI];
  for (const offset of offsets) {
    const candidate = {
      x: self.x + Math.cos(baseAngle + offset) * 140,
      z: self.z + Math.sin(baseAngle + offset) * 140
    };
    if (clearSegment(arena, self, candidate)) return candidate;
  }
  return undefined;
};

const exerciseSmokeVisibility = async (
  host: GameRoom,
  connections: readonly AgentConnectionDescriptorV1[],
  actionSequences: Map<string, number>,
  signal?: AbortSignal
): Promise<{
  actorSeatId: string;
  observerSeatId: string;
  concealedObservationSeq: number;
  revealedObservationSeq: number;
}> => {
  const actor = connections[0];
  const observer = connections[1];
  if (!actor || !observer) throw new Error("smoke validation requires two agent controls");
  const actorPlayer = host.state.players.get(actor.seatId);
  if (actorPlayer?.abilityType !== "smoke") {
    throw new Error("smoke validation requires the first owner to use Quill");
  }

  await Promise.all(connections.map((connection) => heartbeatControl(connection, signal)));
  const [actorObservation, observerBefore] = await Promise.all([
    readObservation(actor, signal),
    readObservation(observer, signal)
  ]);
  const beforeTarget = observerBefore.opponents.find((target) => target.id === actor.seatId);
  if (!beforeTarget?.visible || !beforeTarget.position) {
    throw new Error("smoke target was not visible before activation");
  }

  const actionSeq = (actionSequences.get(actor.seatId) ?? 0) + 1;
  const action: AgentMacroActionV1 = {
    version: 1,
    actionSeq,
    basedOnObservationSeq: actorObservation.observationSeq,
    leaseMs: 750,
    waypoints: [],
    fire: "none",
    useAbility: "once"
  };
  const actionResponse = await fetchAgent(`${httpUrl}/agent/rooms/${actor.roomId}/action`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${actor.brokerCredential}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(action)
  }, signal);
  const actionResult = await actionResponse.json() as { accepted?: boolean; code?: string };
  if (!actionResponse.ok || !actionResult.accepted) {
    throw new Error(`smoke action rejected: ${actionResult.code ?? actionResponse.status}`);
  }
  actionSequences.set(actor.seatId, actionSeq);

  await waitFor(
    "smoke activation",
    () => (host.state.players.get(actor.seatId)?.smokeEndsAt ?? 0) > Date.now(),
    15_000,
    signal
  );
  await sleep(AGENT_OBSERVATION_INTERVAL_MS + 75);
  const observerDuring = await readObservation(observer, signal);
  const concealedTarget = observerDuring.opponents.find((target) => target.id === actor.seatId);
  if (
    concealedTarget?.visible !== false ||
    concealedTarget.position !== null ||
    concealedTarget.motion !== "unknown"
  ) {
    throw new Error(`smoke leaked target state: ${JSON.stringify(concealedTarget)}`);
  }

  const smokeEndsAt = host.state.players.get(actor.seatId)?.smokeEndsAt ?? 0;
  let nextHeartbeatAt = Date.now() + 3_500;
  while (Date.now() <= smokeEndsAt + 100) {
    if (Date.now() >= nextHeartbeatAt) {
      await Promise.all(connections.map((connection) => heartbeatControl(connection, signal)));
      nextHeartbeatAt = Date.now() + 3_500;
    }
    await sleep(Math.min(150, Math.max(1, smokeEndsAt + 101 - Date.now())));
  }
  const observerAfter = await readObservation(observer, signal);
  const revealedTarget = observerAfter.opponents.find((target) => target.id === actor.seatId);
  if (!revealedTarget?.visible || !revealedTarget.position) {
    throw new Error(`smoke target did not become visible after expiry: ${JSON.stringify(revealedTarget)}`);
  }

  return {
    actorSeatId: actor.seatId,
    observerSeatId: observer.seatId,
    concealedObservationSeq: observerDuring.observationSeq,
    revealedObservationSeq: observerAfter.observationSeq
  };
};

const installActiveMacro = async (
  connection: AgentConnectionDescriptorV1,
  actionSequences: Map<string, number>,
  signal?: AbortSignal
): Promise<{ actionSeq: number; leaseExpiresAtMs: number }> => {
  await sleep(AGENT_OBSERVATION_INTERVAL_MS + 75);
  const observation = await readObservation(connection, signal);
  if (!observation.self.alive || !["running", "danger", "final_zone"].includes(observation.matchState)) {
    throw new Error(`cannot install active macro during ${observation.matchState}`);
  }
  const target = observation.opponents.find(
    (opponent) => opponent.alive && opponent.visible && opponent.position
  );
  const actionSeq = (actionSequences.get(connection.seatId) ?? 0) + 1;
  const action: AgentMacroActionV1 = {
    version: 1,
    actionSeq,
    basedOnObservationSeq: observation.observationSeq,
    leaseMs: 3_000,
    waypoints: [],
    ...(target ? { targetId: target.id } : {}),
    fire: target ? "hold" : "none",
    useAbility: false
  };
  const response = await fetchAgent(`${httpUrl}/agent/rooms/${connection.roomId}/action`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.brokerCredential}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(action)
  }, signal);
  const result = await response.json() as {
    accepted?: boolean;
    code?: string;
    leaseExpiresAtMs?: number;
  };
  if (!response.ok || !result.accepted || typeof result.leaseExpiresAtMs !== "number") {
    throw new Error(`active macro rejected: ${result.code ?? response.status}`);
  }
  actionSequences.set(connection.seatId, actionSeq);
  return { actionSeq, leaseExpiresAtMs: result.leaseExpiresAtMs };
};

const coordinateRematches = async (
  getHost: () => GameRoom,
  rooms: readonly GameRoom[],
  stopAt: number,
  shouldStop: () => boolean,
  signal?: AbortSignal
): Promise<Array<{ previousMatchId: string; nextMatchId: string; round: number }>> => {
  const transitions: Array<{ previousMatchId: string; nextMatchId: string; round: number }> = [];
  const votedMatchIds = new Set<string>();
  while (Date.now() < stopAt && !shouldStop()) {
    const host = getHost();
    if (host.state.matchState !== "finished") {
      await sleep(100);
      continue;
    }
    const previousMatchId = host.state.match.matchId;
    if (votedMatchIds.has(previousMatchId)) {
      await sleep(100);
      continue;
    }
    const resultAgents = Array.from(host.state.players.values()).filter(
      (player) => player.controlKind === "agent"
    );
    if (resultAgents.length === 0 || resultAgents.some((player) => player.placement <= 0)) {
      throw new Error("finished match did not contain complete agent placements");
    }
    votedMatchIds.add(previousMatchId);
    const previousRound = host.state.match.round;
    const previousSeed = host.state.seed;
    const previousArena = host.state.arenaConfigJson;
    if (stopAt - Date.now() < 10_000) return transitions;
    for (const room of rooms) {
      room.send(CLIENT_MESSAGE_TYPES.REMATCH, { ready: true, previousMatchId });
    }
    await waitFor(
      "rematch reset",
      () => getHost().state.match.matchId !== previousMatchId,
      15_000,
      signal
    );
    const rematchedHost = getHost();
    if (
      rematchedHost.state.match.round !== previousRound + 1 ||
      rematchedHost.state.seed === previousSeed ||
      rematchedHost.state.arenaConfigJson === previousArena
    ) {
      throw new Error("rematch did not refresh round, seed, and arena");
    }
    transitions.push({
      previousMatchId,
      nextMatchId: rematchedHost.state.match.matchId,
      round: rematchedHost.state.match.round
    });
  }
  return transitions;
};

const exerciseIdleExpiry = async (
  host: GameRoom,
  rooms: readonly GameRoom[],
  connections: readonly AgentConnectionDescriptorV1[],
  invalidatedSeatIds: Set<string>,
  actionSequences: Map<string, number>,
  signal?: AbortSignal
): Promise<{
  seatId: string;
  brokerCode: string;
  expiredAtMs: number;
  activeLeaseExpiresAtMs: number;
  activeActionSeq: number;
}> => {
  const idleConnection = connections[0];
  const idleOwnerRoom = rooms[0];
  if (!idleConnection || !idleOwnerRoom) throw new Error("idle validation requires one control");
  const ownerId = idleOwnerRoom.state.players.get(idleOwnerRoom.sessionId)?.ownerId;
  if (!ownerId) throw new Error("idle owner was not materialized");
  const status = await readControlStatus(idleConnection, signal);
  const keepAliveConnections = connections.slice(1).filter(
    (connection) => !invalidatedSeatIds.has(connection.seatId)
  );
  let nextHeartbeatAt = 0;
  let activeMacro: Awaited<ReturnType<typeof installActiveMacro>> | undefined;
  const expiryDeadline = status.idleDeadlineMs + 10_000;
  while (Date.now() < expiryDeadline) {
    const seatState = host.state.owners.get(ownerId)?.agentSeatState;
    if (seatState === "none" || seatState === "disconnected") break;
    if (Date.now() >= nextHeartbeatAt) {
      await Promise.all(keepAliveConnections.map((connection) => heartbeatControl(connection, signal)));
      nextHeartbeatAt = Date.now() + 4_000;
    }
    if (Date.now() < status.idleDeadlineMs - AGENT_OBSERVATION_INTERVAL_MS - 150) {
      activeMacro = await installActiveMacro(idleConnection, actionSequences, signal);
      continue;
    }
    await sleep(25);
  }
  const seatState = host.state.owners.get(ownerId)?.agentSeatState;
  if (seatState !== "none" && seatState !== "disconnected") {
    throw new Error(`idle agent did not expire (state=${seatState ?? "missing"})`);
  }
  const expiredPlayer = host.state.players.get(idleConnection.seatId);
  if (
    expiredPlayer &&
    (expiredPlayer.isConnected || expiredPlayer.isAlive ||
      Math.hypot(expiredPlayer.velocityX, expiredPlayer.velocityY) > 0.001)
  ) {
    throw new Error("idle agent entity remained active");
  }
  if (!activeMacro || activeMacro.leaseExpiresAtMs <= status.idleDeadlineMs) {
    throw new Error("idle expiry did not interrupt an active macro lease");
  }
  invalidatedSeatIds.add(idleConnection.seatId);
  return {
    seatId: idleConnection.seatId,
    brokerCode: await expectCredentialRejected(idleConnection),
    expiredAtMs: status.idleDeadlineMs,
    activeLeaseExpiresAtMs: activeMacro.leaseExpiresAtMs,
    activeActionSeq: activeMacro.actionSeq
  };
};

const exerciseOwnerRevoke = async (
  host: GameRoom,
  rooms: readonly GameRoom[],
  connections: readonly AgentConnectionDescriptorV1[],
  invalidatedSeatIds: Set<string>,
  actionSequences: Map<string, number>,
  signal?: AbortSignal
): Promise<{
  seatId: string;
  brokerCode: string;
  activeLeaseExpiresAtMs: number;
  activeActionSeq: number;
}> => {
  const index = connections.findIndex((connection) => !invalidatedSeatIds.has(connection.seatId));
  const connection = connections[index];
  const ownerRoom = rooms[index];
  if (!connection || !ownerRoom) throw new Error("revoke validation requires a live control");
  const ownerId = ownerRoom.state.players.get(ownerRoom.sessionId)?.ownerId;
  if (!ownerId) throw new Error("revoke owner was not materialized");
  const activeMacro = await installActiveMacro(connection, actionSequences, signal);
  ownerRoom.send(CLIENT_MESSAGE_TYPES.AGENT_CONTROL, { action: "disconnect" });
  await waitFor("owner agent revoke", () => {
    const seatState = host.state.owners.get(ownerId)?.agentSeatState;
    return seatState === "none" || seatState === "disconnected";
  }, 15_000, signal);
  const revokedPlayer = host.state.players.get(connection.seatId);
  if (
    revokedPlayer &&
    (revokedPlayer.isConnected || revokedPlayer.isAlive ||
      Math.hypot(revokedPlayer.velocityX, revokedPlayer.velocityY) > 0.001)
  ) {
    throw new Error("revoked agent entity remained active");
  }
  invalidatedSeatIds.add(connection.seatId);
  return {
    seatId: connection.seatId,
    brokerCode: await expectCredentialRejected(connection),
    activeLeaseExpiresAtMs: activeMacro.leaseExpiresAtMs,
    activeActionSeq: activeMacro.actionSeq
  };
};

const pairingCode = (
  room: GameRoom,
  label: string,
  controlMode?: "macro_v1" | "tactical_reflex_v1",
  openingTactic?: AgentTacticalIntentV1
): Promise<string> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`pairing timed out for ${label}`)), 5_000);
    room.onMessage(SERVER_MESSAGE_TYPES.AGENT_PAIRING_RESULT, (payload: AgentPairingResultPayload) => {
      if (payload.action !== "create") return;
      clearTimeout(timeout);
      if (!payload.accepted || !payload.pairingCode) {
        reject(new Error(`pairing rejected for ${label}: ${payload.errorCode ?? "unknown"}`));
        return;
      }
      resolve(payload.pairingCode);
    });
    room.send(CLIENT_MESSAGE_TYPES.AGENT_PAIRING_CREATE, {
      agentLabel: label,
      ...(controlMode ? { controlMode } : {}),
      ...(openingTactic ? { openingTactic } : {})
    });
  });

const silenceExpectedMessages = (
  room: GameRoom,
  runtimeFailures?: string[],
  expectedLeaves?: WeakSet<GameRoom>
): void => {
  room.onMessage(SERVER_MESSAGE_TYPES.SYSTEM, () => undefined);
  room.onMessage(SERVER_MESSAGE_TYPES.ERROR, (payload: unknown) => {
    if (!runtimeFailures) return;
    const code =
      typeof payload === "object" && payload !== null && "code" in payload &&
      typeof payload.code === "string"
        ? payload.code
        : "unknown";
    runtimeFailures.push(`server:${code}`);
  });
  room.onMessage(SERVER_MESSAGE_TYPES.PROJECTILE_IMPACT, () => undefined);
  room.onMessage(SERVER_MESSAGE_TYPES.AGENT_CONTROL_RESULT, () => undefined);
  room.onError((code) => runtimeFailures?.push(`transport:${code}`));
  room.onLeave((code) => {
    if (!expectedLeaves?.has(room)) runtimeFailures?.push(`leave:${code}`);
  });
};

const consumePairing = async (
  code: string,
  signal?: AbortSignal
): Promise<AgentConnectionDescriptorV1> => {
  const parsed = JSON.parse(code) as { roomId?: string; grant?: string };
  if (!parsed.roomId || !parsed.grant) throw new Error("invalid pairing code");
  const response = await fetchAgent(`${httpUrl}/agent/rooms/${encodeURIComponent(parsed.roomId)}/grants/consume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${parsed.grant}` }
  }, signal);
  if (!response.ok) throw new Error(`pairing consume failed with ${response.status}`);
  const connection = (await response.json()) as AgentConnectionDescriptorV1;
  if (connection.apiBaseUrl.replace(/\/$/, "") !== httpUrl) {
    await releaseControl(connection);
    throw new Error(`pairing returned unusable API base ${connection.apiBaseUrl}`);
  }
  return connection;
};

const exactObjectKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const validTacticalArena = (value: unknown): value is AgentArenaDescriptorV1 => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const arena = value as Record<string, unknown>;
  if (!exactObjectKeys(arena, ["bounds", "walls"]) || !arena.bounds || typeof arena.bounds !== "object") {
    return false;
  }
  const bounds = arena.bounds as Record<string, unknown>;
  return exactObjectKeys(bounds, ["minX", "minZ", "maxX", "maxZ"]) &&
    finiteNumber(bounds.minX) && finiteNumber(bounds.minZ) &&
    finiteNumber(bounds.maxX) && finiteNumber(bounds.maxZ) &&
    bounds.minX < bounds.maxX && bounds.minZ < bounds.maxZ &&
    Array.isArray(arena.walls) && arena.walls.length <= 2_048 &&
    arena.walls.every((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const wall = value as Record<string, unknown>;
      return exactObjectKeys(wall, ["id", "x", "z", "width", "depth"]) &&
        typeof wall.id === "string" && wall.id.length > 0 && wall.id.length <= 128 &&
        finiteNumber(wall.x) && finiteNumber(wall.z) &&
        finiteNumber(wall.width) && wall.width > 0 &&
        finiteNumber(wall.depth) && wall.depth > 0;
    });
};

const consumeTacticalPairing = async (
  code: string,
  signal?: AbortSignal
): Promise<AgentTacticalConnectionDescriptorV2> => {
  const parsed = JSON.parse(code) as { version?: unknown; roomId?: unknown; grant?: unknown };
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.version !== 2 ||
    typeof parsed.roomId !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(parsed.roomId) ||
    typeof parsed.grant !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(parsed.grant) ||
    Object.keys(parsed).length !== 3
  ) {
    throw new Error("invalid Tactical V2 pairing code");
  }
  const response = await fetchAgent(`${httpUrl}/agent/rooms/${encodeURIComponent(parsed.roomId)}/grants/consume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${parsed.grant}` }
  }, signal);
  if (!response.ok) await responseFailure("tactical pairing consume", response);
  const connection = await response.json() as unknown;
  const candidate = connection && typeof connection === "object" && !Array.isArray(connection)
    ? connection as Partial<AgentTacticalConnectionDescriptorV2>
    : undefined;
  const releaseCandidate = async (): Promise<void> => {
    if (
      typeof candidate?.brokerCredential === "string" &&
      /^[A-Za-z0-9_-]{1,512}$/.test(candidate.brokerCredential)
    ) await releaseControl({
      roomId: parsed.roomId,
      brokerCredential: candidate.brokerCredential
    }).catch(() => undefined);
  };
  if (
    !candidate ||
    Object.keys(connection).sort().join(",") !== [
      "apiBaseUrl",
      "arena",
      "brokerCredential",
      "controlMode",
      "executorVersion",
      "idleDeadlineMs",
      "observationVersion",
      "protocolVersion",
      "reflexVersion",
      "roomId",
      "seatId",
      "tacticalIntentVersion"
    ].join(",")
  ) {
    await releaseCandidate();
    throw new Error("pairing returned an invalid Tactical V2 descriptor");
  }
  if (
    candidate.protocolVersion !== 2 ||
    candidate.controlMode !== "tactical_reflex_v1" ||
    candidate.roomId !== parsed.roomId ||
    typeof candidate.seatId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(candidate.seatId) ||
    typeof candidate.brokerCredential !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(candidate.brokerCredential) ||
    !Number.isSafeInteger(candidate.idleDeadlineMs) ||
    (candidate.idleDeadlineMs ?? 0) <= 0 ||
    candidate.observationVersion !== 1 ||
    candidate.tacticalIntentVersion !== 1 ||
    candidate.reflexVersion !== 1 ||
    candidate.executorVersion !== 1 ||
    typeof candidate.apiBaseUrl !== "string" ||
    candidate.apiBaseUrl.replace(/\/$/, "") !== httpUrl ||
    !validTacticalArena(candidate.arena)
  ) {
    await releaseCandidate();
    throw new Error("pairing returned an invalid Tactical V2 descriptor");
  }
  return candidate as AgentTacticalConnectionDescriptorV2;
};

const releaseControl = async (connection: ReleasableConnection): Promise<void> => {
  const response = await fetchAgent(`${httpUrl}/agent/rooms/${connection.roomId}/control`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${connection.brokerCredential}` }
  });
  if (!response.ok) await responseFailure("agent release", response);
};

const tacticalRequest = async <Result>(
  connection: AgentTacticalConnectionDescriptorV2,
  path: "tactical-intent" | "tactical-status",
  init: RequestInit,
  signal?: AbortSignal
): Promise<Result> => {
  const response = await fetchAgent(`${httpUrl}/agent/rooms/${connection.roomId}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.brokerCredential}`,
      ...init.headers
    }
  }, signal);
  if (!response.ok) await responseFailure(path, response);
  return await response.json() as Result;
};

const setTacticalIntent = async (
  connection: AgentTacticalConnectionDescriptorV2,
  intent: AgentTacticalIntentV1,
  signal?: AbortSignal
): Promise<AgentTacticalIntentResultV1> => {
  const result = await tacticalRequest<unknown>(connection, "tactical-intent", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(intent)
  }, signal);
  if (!isAgentTacticalIntentResultV1(result, intent.intentSeq)) {
    throw new Error("tactical-intent returned an invalid response");
  }
  return result;
};

const readTacticalStatus = async (
  connection: AgentTacticalConnectionDescriptorV2,
  signal?: AbortSignal
): Promise<AgentTacticalStatusV1> => {
  const status = await tacticalRequest<unknown>(
    connection,
    "tactical-status",
    { method: "GET" },
    signal
  );
  if (!isAgentTacticalStatusV1(status, connection)) {
    throw new Error("tactical-status returned an invalid response");
  }
  return status;
};

const clearTacticalIntent = async (
  connection: AgentTacticalConnectionDescriptorV2,
  signal?: AbortSignal
): Promise<AgentTacticalStatusV1> => {
  const status = await tacticalRequest<unknown>(
    connection,
    "tactical-intent",
    { method: "DELETE" },
    signal
  );
  if (!isAgentTacticalStatusV1(status, connection)) {
    throw new Error("tactical-intent clear returned an invalid response");
  }
  return status;
};

const heartbeatTacticalControl = async (
  connection: AgentTacticalConnectionDescriptorV2,
  signal?: AbortSignal
): Promise<void> => {
  const response = await fetchAgent(`${httpUrl}/agent/rooms/${connection.roomId}/heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.brokerCredential}` }
  }, signal);
  if (!response.ok) await responseFailure("tactical heartbeat", response);
};

interface HarnessPoint { x: number; z: number }

const tacticalFixtureArena = (room: GameRoom): {
  descriptor: AgentArenaDescriptorV1;
  spawnPoints: Array<{ x: number; y: number }>;
} => {
  const arena = JSON.parse(room.state.arenaConfigJson) as {
    collisionRects?: Array<{ id: string; x: number; y: number; width: number; height: number }>;
    spawnPoints?: Array<{ x: number; y: number }>;
    width?: number;
    height?: number;
  };
  if (
    !Array.isArray(arena.collisionRects) ||
    !Array.isArray(arena.spawnPoints) ||
    !Number.isFinite(arena.width) ||
    !Number.isFinite(arena.height)
  ) throw new Error("tactical harness arena fixture was invalid");
  return {
    descriptor: {
      bounds: {
        minX: 0,
        minZ: 0,
        maxX: arena.width!,
        maxZ: arena.height!
      },
      walls: arena.collisionRects.map((wall) => ({
        id: wall.id,
        x: wall.x,
        z: wall.y,
        width: wall.width,
        depth: wall.height
      }))
    },
    spawnPoints: arena.spawnPoints
  };
};

const pointClearance = (arena: AgentArenaDescriptorV1, point: HarnessPoint): number => {
  let clearance = Math.min(
    point.x - arena.bounds.minX,
    arena.bounds.maxX - point.x,
    point.z - arena.bounds.minZ,
    arena.bounds.maxZ - point.z
  );
  for (const wall of arena.walls) {
    const dx = Math.max(wall.x - point.x, 0, point.x - wall.x - wall.width);
    const dz = Math.max(wall.z - point.z, 0, point.z - wall.z - wall.depth);
    clearance = Math.min(clearance, Math.hypot(dx, dz));
  }
  return clearance;
};

const chooseTacticalOpening = (
  arena: AgentArenaDescriptorV1,
  spawn: HarnessPoint
): HarnessPoint => {
  const towardCenter = Math.atan2(
    (arena.bounds.minZ + arena.bounds.maxZ) / 2 - spawn.z,
    (arena.bounds.minX + arena.bounds.maxX) / 2 - spawn.x
  );
  for (const distance of [160, 120, 90]) {
    for (const offset of [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const point = {
        x: spawn.x + Math.cos(towardCenter + offset) * distance,
        z: spawn.z + Math.sin(towardCenter + offset) * distance
      };
      if (pointClearance(arena, point) >= 30 && clearSegment(arena, spawn, point, 30)) return point;
    }
  }
  throw new Error("tactical harness could not find a safe opening segment");
};

const chooseTacticalOrbit = (
  arena: AgentArenaDescriptorV1,
  agent: HarnessPoint,
  pacer: HarnessPoint
): { center: HarnessPoint; start: HarnessPoint; radius: number } => {
  const safety = 30;
  let best: { center: HarnessPoint; start: HarnessPoint; radius: number; score: number } | undefined;
  for (let z = arena.bounds.minZ + safety; z <= arena.bounds.maxZ - safety; z += 24) {
    for (let x = arena.bounds.minX + safety; x <= arena.bounds.maxX - safety; x += 24) {
      const center = { x, z };
      if (Math.hypot(center.x - pacer.x, center.z - pacer.z) > 650) continue;
      const clearance = pointClearance(arena, center);
      if (Math.hypot(center.x - agent.x, center.z - agent.z) > clearance - safety) continue;
      const radius = Math.min(110, clearance - safety);
      if (radius < 55) continue;
      const phase = Math.atan2(pacer.z - center.z, pacer.x - center.x);
      const start = {
        x: center.x + Math.cos(phase) * radius,
        z: center.z + Math.sin(phase) * radius
      };
      if (!clearSegment(arena, pacer, start, safety)) continue;
      let visibleFromAgent = true;
      for (let index = 0; index < 12; index += 1) {
        const angle = index / 12 * Math.PI * 2;
        const point = {
          x: center.x + Math.cos(angle) * radius,
          z: center.z + Math.sin(angle) * radius
        };
        if (!clearSegment(arena, agent, point, safety)) {
          visibleFromAgent = false;
          break;
        }
      }
      if (!visibleFromAgent) continue;
      const score = radius * 20 - Math.hypot(start.x - pacer.x, start.z - pacer.z);
      if (!best || score > best.score) best = { center, start, radius, score };
    }
  }
  if (!best) {
    throw new Error(`deterministic arena did not provide a safe tactical pacer orbit (${JSON.stringify({ agent, pacer, walls: arena.walls.length })})`);
  }
  return { center: best.center, start: best.start, radius: best.radius };
};

const sendHarnessInput = (
  room: GameRoom,
  sequence: number,
  moveX: number,
  moveY: number,
  aim: HarnessPoint
): void => {
  const input: InputMessagePayload = {
    sequence,
    tick: room.state.match.tick,
    moveX,
    moveY,
    aimX: aim.x,
    aimY: aim.z,
    fire: false,
    ability: false
  };
  room.send(CLIENT_MESSAGE_TYPES.INPUT, input);
};

const runTacticalReflexHarness = async (): Promise<void> => {
  const clients = [new Client(wsUrl), new Client(wsUrl)];
  const rooms: GameRoom[] = [];
  const runtimeFailures: string[] = [];
  const expectedLeaves = new WeakSet<GameRoom>();
  const abortController = new AbortController();
  let connection: AgentTacticalConnectionDescriptorV2 | undefined;
  let evidence: Record<string, unknown> | undefined;
  let released = false;
  let stopping = false;
  const stop = () => {
    stopping = true;
    abortController.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const host = await connectRoom("tactical host room creation", () => clients[0]!.create(
      BATTLE_ROYALE_ROOM,
      {
        playerName: "Reflex Owner",
        archetypeId: "rook",
        privateRoom: true,
        roomMode: "open_ffa",
        seed: "tactical-reflex-harness-151"
      },
      Alpha7StateSchema
    ), abortController.signal);
    host.reconnection.enabled = false;
    silenceExpectedMessages(host, runtimeFailures, expectedLeaves);
    rooms.push(host);
    const pacerRoom = await connectRoom("tactical pacer join", () => clients[1]!.joinById(
      host.roomId,
      { playerName: "Reflex Pacer", archetypeId: "quill" },
      Alpha7StateSchema
    ), abortController.signal);
    pacerRoom.reconnection.enabled = false;
    silenceExpectedMessages(pacerRoom, runtimeFailures, expectedLeaves);
    rooms.push(pacerRoom);
    await waitFor(
      "two tactical harness owners",
      () => host.state.owners.size === 2,
      15_000,
      abortController.signal
    );

    const fixture = tacticalFixtureArena(host);
    const openingSpawn = fixture.spawnPoints[host.state.players.size];
    if (!openingSpawn) throw new Error("tactical harness opening spawn was unavailable");
    const openingTarget = chooseTacticalOpening(
      fixture.descriptor,
      { x: openingSpawn.x, z: openingSpawn.y }
    );
    const openingIntent: AgentTacticalIntentV1 = {
      version: 1,
      intentSeq: 1,
      basedOnObservationSeq: null,
      validForMs: 90_000,
      objective: { type: "move_to", position: openingTarget },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    };

    connection = await consumeTacticalPairing(
      await pairingCode(host, "Reflex Runner", "tactical_reflex_v1", openingIntent),
      abortController.signal
    );
    await waitFor(
      "tactical agent materialization",
      () => host.state.players.has(connection!.seatId),
      15_000,
      abortController.signal
    );
    const agent = host.state.players.get(connection.seatId);
    const pacer = host.state.players.get(pacerRoom.sessionId);
    if (!agent || !pacer) throw new Error("tactical harness players were not materialized");
    const openingDistance = Math.hypot(openingTarget.x - agent.x, openingTarget.z - agent.y);
    if (openingDistance < 80) throw new Error("tactical opening route was too short to measure");
    const openingPosition = { x: agent.x, z: agent.y };
    host.send(CLIENT_MESSAGE_TYPES.READY, { ready: true });
    pacerRoom.send(CLIENT_MESSAGE_TYPES.READY, { ready: true });
    await waitFor(
      "tactical countdown",
      () => host.state.matchState === "countdown",
      15_000,
      abortController.signal
    );
    await waitFor(
      "tactical match start",
      () => host.state.matchState === "running",
      20_000,
      abortController.signal
    );
    const runningStartedAt = host.state.match.stateStartedAt;
    let firstMotionAt = 0;
    try {
      await waitFor("opening authoritative movement", () => {
        const current = host.state.players.get(connection!.seatId);
        if (!current || Math.hypot(current.x - openingPosition.x, current.y - openingPosition.z) < 0.5) {
          return false;
        }
        firstMotionAt = host.state.serverTime;
        return true;
      }, 2_000, abortController.signal);
    } catch (error) {
      const status = await readTacticalStatus(connection, abortController.signal);
      throw new Error(`${error instanceof Error ? error.message : String(error)} (${JSON.stringify({
        active: status.active,
        stopReason: status.stopReason,
        lastIntentSeq: status.lastIntentSeq,
        lastReflexAtMs: status.lastReflexAtMs
      })})`);
    }
    const openingStatus = await readTacticalStatus(connection, abortController.signal);
    if (openingStatus.lastReflexAtMs === null) throw new Error("opening tactic emitted no reflex frame");
    const firstExecutorIntentLatencyMs = openingStatus.lastReflexAtMs - runningStartedAt;
    const firstAuthoritativeMotionLatencyMs = firstMotionAt - runningStartedAt;
    if (firstExecutorIntentLatencyMs < 0 || firstExecutorIntentLatencyMs > 100) {
      throw new Error(`first executor intent exceeded 100 ms (${firstExecutorIntentLatencyMs})`);
    }
    if (firstAuthoritativeMotionLatencyMs < 0 || firstAuthoritativeMotionLatencyMs > 250) {
      throw new Error(`first authoritative motion exceeded 250 ms (${firstAuthoritativeMotionLatencyMs})`);
    }

    await clearTacticalIntent(connection, abortController.signal);
    await waitFor("opening tactic neutral", () => {
      const current = host.state.players.get(connection!.seatId);
      return Boolean(current && Math.hypot(current.velocityX, current.velocityY) <= 5);
    }, 1_000, abortController.signal);
    const neutralAgent = host.state.players.get(connection.seatId);
    const currentPacer = host.state.players.get(pacerRoom.sessionId);
    if (!neutralAgent || !currentPacer) throw new Error("tactical harness players disappeared before pacing");
    const orbit = chooseTacticalOrbit(
      connection.arena,
      { x: neutralAgent.x, z: neutralAgent.y },
      { x: currentPacer.x, z: currentPacer.y }
    );

    let inputSequence = 0;
    let nextHeartbeatAt = 0;
    const driveDeadline = Date.now() + 8_000;
    while (Date.now() < driveDeadline) {
      const current = host.state.players.get(pacerRoom.sessionId);
      if (!current) throw new Error("tactical pacer disappeared during setup");
      const dx = orbit.start.x - current.x;
      const dz = orbit.start.z - current.y;
      const distance = Math.hypot(dx, dz);
      if (distance <= 24) break;
      sendHarnessInput(
        pacerRoom,
        ++inputSequence,
        dx / distance,
        dz / distance,
        orbit.center
      );
      if (Date.now() >= nextHeartbeatAt) {
        await heartbeatTacticalControl(connection, abortController.signal);
        nextHeartbeatAt = Date.now() + 4_000;
      }
      await sleep(50);
    }
    const paced = host.state.players.get(pacerRoom.sessionId);
    if (!paced || Math.hypot(paced.x - orbit.start.x, paced.y - orbit.start.z) > 40) {
      throw new Error("tactical pacer did not reach its safe orbit");
    }

    let phase = Math.atan2(paced.y - orbit.center.z, paced.x - orbit.center.x);
    const pace = () => {
      phase += 0.14;
      const desired = {
        x: orbit.center.x + Math.cos(phase) * orbit.radius,
        z: orbit.center.z + Math.sin(phase) * orbit.radius
      };
      const current = host.state.players.get(pacerRoom.sessionId);
      if (!current) throw new Error("tactical pacer disappeared");
      const dx = desired.x - current.x;
      const dz = desired.z - current.y;
      const distance = Math.max(1, Math.hypot(dx, dz));
      sendHarnessInput(pacerRoom, ++inputSequence, dx / distance, dz / distance, orbit.center);
    };
    for (let index = 0; index < 12; index += 1) {
      pace();
      await sleep(50);
    }

    const observationResponse = await fetchAgent(`${httpUrl}/agent/rooms/${connection.roomId}/observation`, {
      headers: { Authorization: `Bearer ${connection.brokerCredential}` }
    }, abortController.signal);
    if (!observationResponse.ok) await responseFailure("tactical observation", observationResponse);
    const observation = await observationResponse.json() as AgentObservationV1;
    if (!observation.opponents.some((opponent) => opponent.id === pacerRoom.sessionId && opponent.visible)) {
      throw new Error("tactical pacer was not present in the filtered observation");
    }
    const chaseIntent: AgentTacticalIntentV1 = {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: observation.observationSeq,
      validForMs: 90_000,
      objective: { type: "engage_target", targetId: pacerRoom.sessionId },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    };
    const chase = await setTacticalIntent(connection, chaseIntent, abortController.signal);
    if (!chase.accepted || chase.intentExpiresAtMs === null) {
      throw new Error(`chase tactic rejected: ${chase.code}`);
    }
    const chaseStatus = await readTacticalStatus(connection, abortController.signal);
    const acceptedAtMs = chase.intentExpiresAtMs - chaseIntent.validForMs;
    const updateToReflexMs = (chaseStatus.lastReflexAtMs ?? Number.POSITIVE_INFINITY) - acceptedAtMs;
    if (!chaseStatus.active || updateToReflexMs < 0 || updateToReflexMs > 100) {
      throw new Error(`tactical update did not produce an immediate reflex (${updateToReflexMs})`);
    }

    const silenceStartedAt = performance.now();
    const silenceEndsAt = silenceStartedAt + TACTICAL_STALL_CHECKPOINTS_MS.at(-1)!;
    const checkpoints: Array<Record<string, number>> = [];
    const movementGaps: number[] = [];
    const demandReacquisitionGaps: number[] = [];
    let checkpointIndex = 0;
    let firstChaseMotionAt = 0;
    let previousPosition = { x: agent.x, z: agent.y };
    let previousRotation = agent.rotation;
    let demandActive = false;
    let demandMotionAcquired = false;
    let demandStartedAt = silenceStartedAt;
    let lastDemandedMotionAt = silenceStartedAt;
    let neutralStartedAt: number | undefined;
    let maxNeutralGapMs = 0;
    let nextPaceAt = performance.now();
    nextHeartbeatAt = Date.now() + 4_000;
    while (true) {
      const now = performance.now();
      if (now >= nextPaceAt) {
        pace();
        nextPaceAt = now + 50;
      }
      if (Date.now() >= nextHeartbeatAt) {
        await heartbeatTacticalControl(connection, abortController.signal);
        nextHeartbeatAt = Date.now() + 4_000;
      }
      const currentAgent = host.state.players.get(connection.seatId);
      const currentPacer = host.state.players.get(pacerRoom.sessionId);
      if (!currentAgent?.isAlive || !currentPacer?.isAlive) {
        throw new Error("tactical stall combatants did not remain alive");
      }
      const translated = Math.hypot(
        currentAgent.x - previousPosition.x,
        currentAgent.y - previousPosition.z
      ) > 0.02;
      const rotated = Math.abs(Math.atan2(
        Math.sin(currentAgent.rotation - previousRotation),
        Math.cos(currentAgent.rotation - previousRotation)
      )) > 0.002;
      previousRotation = currentAgent.rotation;
      const moved = translated || rotated;
      if (translated) {
        previousPosition = { x: currentAgent.x, z: currentAgent.y };
      }
      if (moved && firstChaseMotionAt === 0) firstChaseMotionAt = now;
      const targetDistance = Math.hypot(
        currentAgent.x - currentPacer.x,
        currentAgent.y - currentPacer.y
      );
      const safeZoneRadius = Math.max(
        0,
        host.state.zone.radius - AGENT_TACTICAL_ZONE_SAFETY_MARGIN
      );
      const zoneDistance = Math.hypot(
        currentAgent.x - host.state.zone.x,
        currentAgent.y - host.state.zone.y
      );
      const retreatAvailable = Boolean(chooseAgentTacticalRetreat(
        { x: currentAgent.x, z: currentAgent.y },
        { x: currentPacer.x, z: currentPacer.y },
        currentAgent.rotation,
        { x: host.state.zone.x, z: host.state.zone.y },
        (point) =>
          Math.hypot(point.x - host.state.zone.x, point.z - host.state.zone.y) <= safeZoneRadius + 0.001 &&
          clearSegment(connection.arena, { x: currentAgent.x, z: currentAgent.y }, point, 30)
      ));
      const demanded = tacticalMovementDemanded(
        targetDistance,
        retreatAvailable,
        zoneDistance > safeZoneRadius
      );
      const speed = Math.hypot(currentAgent.velocityX, currentAgent.velocityY);
      if (!demanded) {
        demandActive = false;
        demandMotionAcquired = false;
        lastDemandedMotionAt = now;
        neutralStartedAt = undefined;
      } else {
        if (!demandActive) {
          demandActive = true;
          demandStartedAt = now;
          demandMotionAcquired = moved || speed > 5;
          lastDemandedMotionAt = now;
          neutralStartedAt = demandMotionAcquired && speed <= 5 && !rotated ? now : undefined;
          if (demandMotionAcquired) demandReacquisitionGaps.push(0);
        } else if (!demandMotionAcquired) {
          const reacquisitionMs = now - demandStartedAt;
          if (moved || speed > 5) {
            demandMotionAcquired = true;
            demandReacquisitionGaps.push(reacquisitionMs);
            lastDemandedMotionAt = now;
            neutralStartedAt = speed <= 5 && !rotated ? now : undefined;
          } else if (reacquisitionMs > TACTICAL_REACQUISITION_LIMIT_MS) {
            const status = await readTacticalStatus(connection, abortController.signal);
            throw new Error(`tactical movement reacquisition exceeded ${TACTICAL_REACQUISITION_LIMIT_MS} ms (${JSON.stringify({
              reacquisitionMs,
              speed,
              targetDistance,
              agent: {
                x: currentAgent.x,
                z: currentAgent.y,
                rotation: currentAgent.rotation,
                velocityX: currentAgent.velocityX,
                velocityY: currentAgent.velocityY
              },
              target: { x: currentPacer.x, z: currentPacer.y },
              zone: {
                x: host.state.zone.x,
                z: host.state.zone.y,
                radius: host.state.zone.radius,
                safeRadius: safeZoneRadius,
                agentDistance: zoneDistance
              },
              tactical: {
                active: status.active,
                stopReason: status.stopReason,
                lastReflexAtMs: status.lastReflexAtMs
              }
            })})`);
          }
        } else {
          if (moved) {
            movementGaps.push(now - lastDemandedMotionAt);
            lastDemandedMotionAt = now;
          }
          if (speed <= 5 && !rotated) {
            neutralStartedAt ??= now;
            maxNeutralGapMs = Math.max(maxNeutralGapMs, now - neutralStartedAt);
          } else {
            neutralStartedAt = undefined;
          }
          if (now - silenceStartedAt > 250) {
            const positionGapMs = now - lastDemandedMotionAt;
            if (positionGapMs > 150 || maxNeutralGapMs > 150) {
              const status = await readTacticalStatus(connection, abortController.signal);
              throw new Error(`neutral movement gap exceeded 150 ms (${JSON.stringify({
                positionGapMs,
                maxNeutralGapMs,
                speed,
                targetDistance,
                agent: {
                  x: currentAgent.x,
                  z: currentAgent.y,
                  rotation: currentAgent.rotation,
                  velocityX: currentAgent.velocityX,
                  velocityY: currentAgent.velocityY
                },
                target: { x: currentPacer.x, z: currentPacer.y },
                zone: {
                  x: host.state.zone.x,
                  z: host.state.zone.y,
                  radius: host.state.zone.radius,
                  safeRadius: safeZoneRadius,
                  agentDistance: zoneDistance
                },
                tactical: {
                  active: status.active,
                  stopReason: status.stopReason,
                  lastReflexAtMs: status.lastReflexAtMs
                }
              })})`);
            }
          }
        }
      }
      while (
        checkpointIndex < TACTICAL_STALL_CHECKPOINTS_MS.length &&
        now - silenceStartedAt >= TACTICAL_STALL_CHECKPOINTS_MS[checkpointIndex]!
      ) {
        checkpoints.push({
          requestedMs: TACTICAL_STALL_CHECKPOINTS_MS[checkpointIndex]!,
          observedMs: now - silenceStartedAt,
          speed: Math.hypot(currentAgent.velocityX, currentAgent.velocityY)
        });
        checkpointIndex += 1;
      }
      if (now >= silenceEndsAt) break;
      await sleep(20);
    }
    if (firstChaseMotionAt === 0 || firstChaseMotionAt - silenceStartedAt > 250) {
      throw new Error(`chase authoritative motion exceeded 250 ms (${firstChaseMotionAt - silenceStartedAt})`);
    }
    if (checkpoints.length !== TACTICAL_STALL_CHECKPOINTS_MS.length) {
      throw new Error("tactical model-stall checkpoints were incomplete");
    }
    const authoritativeMotionGapMs = {
      p50: percentile(movementGaps, 0.5),
      p95: percentile(movementGaps, 0.95),
      max: Math.max(0, ...movementGaps)
    };
    const demandReacquisitionMs = {
      p50: percentile(demandReacquisitionGaps, 0.5),
      p95: percentile(demandReacquisitionGaps, 0.95),
      max: Math.max(0, ...demandReacquisitionGaps)
    };
    if (!tacticalMotionGapsWithinLimits(authoritativeMotionGapMs)) {
      throw new Error(`authoritative motion gaps exceeded p50/p95 limits (${JSON.stringify(authoritativeMotionGapMs)})`);
    }
    const afterSilence = await readTacticalStatus(connection, abortController.signal);
    if (
      !afterSilence.active ||
      (afterSilence.stopReason !== "moving" && afterSilence.stopReason !== "hold")
    ) {
      throw new Error(`tactic stopped during model silence (${afterSilence.stopReason})`);
    }

    const clearStartedAt = performance.now();
    const cleared = await clearTacticalIntent(connection, abortController.signal);
    if (cleared.active || cleared.stopReason !== "cleared") {
      throw new Error("explicit tactical clear did not neutralize the intent");
    }
    await waitFor("cleared tactical movement to neutralize", () => {
      const current = host.state.players.get(connection!.seatId);
      return Boolean(current && Math.hypot(current.velocityX, current.velocityY) <= 5);
    }, 1_000, abortController.signal);
    const clearToNeutralMs = performance.now() - clearStartedAt;
    if (clearToNeutralMs > 150) {
      throw new Error(`tactical clear exceeded 150 ms (${clearToNeutralMs})`);
    }

    await releaseControl(connection);
    released = true;
    await waitFor("released tactical seat cleanup", () => {
      const current = host.state.players.get(connection!.seatId);
      return !current || !current.isConnected;
    }, 15_000, abortController.signal);
    const revokedCode = await expectCredentialRejected(connection);
    if (runtimeFailures.length > 0) throw new Error(`unexpected room failure: ${runtimeFailures[0]}`);
    evidence = {
      ok: true,
      mode: "open_ffa",
      roomId: host.roomId,
      firstExecutorIntentLatencyMs,
      firstAuthoritativeMotionLatencyMs,
      tacticalUpdateToReflexMs: updateToReflexMs,
      modelSilenceMs: TACTICAL_STALL_CHECKPOINTS_MS,
      checkpoints,
      authoritativeMotionGapMs,
      demandReacquisitionMs,
      maxNeutralGapMs,
      clearToNeutralMs,
      released,
      credentialRejected: revokedCode === "agent_revoked"
    };
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (connection && !released) await releaseControl(connection).catch(() => undefined);
    for (const room of rooms) expectedLeaves.add(room);
    await Promise.allSettled(rooms.reverse().map((room) => room.leave()));
  }
  if (stopping) throw new Error("tactical reflex qualification interrupted before completion");
  if (verifyCleanup && evidence) evidence.cleanup = await verifyCleanupHold(cleanupHoldMs);
  if (evidence) {
    console.log(json ? JSON.stringify(evidence, null, 2) : `Alpha-7 tactical reflex harness ok ${JSON.stringify(evidence)}`);
  }
};

interface ControlRequestCadence {
  observationStartedAt: number[];
  observationAcceptedAt: number[];
  actionStartedAt: number[];
  actionAcceptedAt: number[];
  heartbeatStartedAt: number[];
  acceptedActions: number;
}

interface ControlLoopState {
  nextHeartbeatAt: number;
  cadence?: ControlRequestCadence;
}

const heartbeatIfDue = async (
  connection: AgentConnectionDescriptorV1,
  state: ControlLoopState,
  signal?: AbortSignal
): Promise<void> => {
  const now = Date.now();
  if (now < state.nextHeartbeatAt) return;
  state.cadence?.heartbeatStartedAt.push(now);
  await heartbeatControl(connection, signal);
  state.nextHeartbeatAt = now + 5_000;
};

const runControl = async (
  connection: AgentConnectionDescriptorV1,
  stopAt: number,
  latencies: number[] | undefined,
  actionSequences: Map<string, number>,
  acceptedByRound: Map<string, number> | undefined,
  requestCadenceBySeat: Map<string, ControlRequestCadence> | undefined,
  allowCombat: boolean,
  shouldStop = () => false,
  signal?: AbortSignal
): Promise<number> => {
  let accepted = 0;
  let nextObservationAt = Date.now();
  let nextActionAt = Date.now();
  const cadence: ControlRequestCadence | undefined = requestCadenceBySeat
    ? {
        observationStartedAt: [],
        observationAcceptedAt: [],
        actionStartedAt: [],
        actionAcceptedAt: [],
        heartbeatStartedAt: [],
        acceptedActions: 0
      }
    : undefined;
  if (cadence) requestCadenceBySeat?.set(connection.seatId, cadence);
  const loopState: ControlLoopState = { nextHeartbeatAt: 0, cadence };
  let arena = connection.arena;
  while (Date.now() < stopAt && !shouldStop()) {
    await sleep(Math.max(0, nextObservationAt - Date.now()));
    if (Date.now() >= stopAt || shouldStop()) break;
    await heartbeatIfDue(connection, loopState, signal);
    const observationWallStartedAt = Date.now();
    cadence?.observationStartedAt.push(observationWallStartedAt);
    const observationStartedAt = performance.now();
    const response = await fetchAgent(`${httpUrl}/agent/rooms/${connection.roomId}/observation`, {
      headers: { Authorization: `Bearer ${connection.brokerCredential}` }
    }, signal);
    nextObservationAt = Math.max(
      observationWallStartedAt + HARNESS_REQUEST_INTERVAL_MS,
      Date.now() + AGENT_OBSERVATION_INTERVAL_MS
    );
    if (response.status === 429) throw new Error("observation cadence rejected");
    if (!response.ok) {
      const failure = await response.json().catch(() => undefined) as
        | { error?: { code?: string } }
        | undefined;
      if (temporaryControlCodes.has(failure?.error?.code ?? "")) {
        if (!await waitForPairedMatch(connection, stopAt, shouldStop, loopState, signal)) break;
        continue;
      }
      throw new Error(`observation failed with ${failure?.error?.code ?? response.status}`);
    }
    const observation = (await response.json()) as AgentObservationV1;
    cadence?.observationAcceptedAt.push(observation.serverTimeMs);
    latencies?.push(performance.now() - observationStartedAt);
    if (observation.arenaUpdate) arena = observation.arenaUpdate;
    if (!["running", "danger", "final_zone"].includes(observation.matchState) || !observation.self.alive) {
      await sleep(500);
      continue;
    }
    const target = observation.opponents
      .filter((opponent) => opponent.visible && opponent.alive && opponent.position)
      .sort((left, right) => {
        const leftDistance = Math.hypot(
          (left.position?.x ?? 0) - observation.self.position.x,
          (left.position?.z ?? 0) - observation.self.position.z
        );
        const rightDistance = Math.hypot(
          (right.position?.x ?? 0) - observation.self.position.x,
          (right.position?.z ?? 0) - observation.self.position.z
        );
        return leftDistance - rightDistance;
      })[0];
    const waypoint = chooseWaypoint(observation, arena, target);
    const actionSeq = (actionSequences.get(connection.seatId) ?? 0) + 1;
    const action: AgentMacroActionV1 = {
      version: 1,
      actionSeq,
      basedOnObservationSeq: observation.observationSeq,
      leaseMs: 750,
      waypoints: waypoint ? [waypoint] : [],
      ...(target ? { targetId: target.id } : {}),
      fire: target && allowCombat ? "hold" : "none",
      useAbility: observation.self.abilityCharge >= 90 ? "once" : false
    };
    await sleep(Math.max(0, nextActionAt - Date.now()));
    if (Date.now() >= stopAt || shouldStop()) break;
    const actionWallStartedAt = Date.now();
    const actionStartedAt = performance.now();
    cadence?.actionStartedAt.push(actionWallStartedAt);
    const actionResponse = await fetchAgent(`${httpUrl}/agent/rooms/${connection.roomId}/action`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.brokerCredential}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(action)
    }, signal);
    nextActionAt = Math.max(
      actionWallStartedAt + HARNESS_REQUEST_INTERVAL_MS,
      Date.now() + AGENT_ACTION_INTERVAL_MS
    );
    const result = (await actionResponse.json()) as HarnessAgentActionResult;
    latencies?.push(performance.now() - actionStartedAt);
    const resultCode = agentActionResultCode(result);
    if (isRetryableAuthoritativeStaleActionRejection(actionResponse.ok, result, actionSeq)) continue;
    if (!result.accepted && temporaryControlCodes.has(resultCode ?? "")) {
      if (!await waitForPairedMatch(connection, stopAt, shouldStop, loopState, signal)) break;
      continue;
    }
    if (!actionResponse.ok || !result.accepted) {
      throw new Error(`action rejected: ${resultCode ?? actionResponse.status} ${JSON.stringify(action)}`);
    }
    if (typeof result.leaseExpiresAtMs !== "number") {
      throw new Error("accepted action omitted its authoritative lease timestamp");
    }
    actionSequences.set(connection.seatId, actionSeq);
    if (acceptedByRound) {
      acceptedByRound.set(
        observation.roundId,
        (acceptedByRound.get(observation.roundId) ?? 0) + 1
      );
    }
    if (cadence) {
      cadence.acceptedActions += 1;
      cadence.actionAcceptedAt.push(result.leaseExpiresAtMs - action.leaseMs);
    }
    accepted += 1;
  }
  return accepted;
};

const waitForPairedMatch = async (
  connection: AgentConnectionDescriptorV1,
  stopAt: number,
  shouldStop: () => boolean,
  loopState: ControlLoopState = { nextHeartbeatAt: 0 },
  signal?: AbortSignal
): Promise<boolean> => {
  while (Date.now() < stopAt && !shouldStop()) {
    await heartbeatIfDue(connection, loopState, signal);
    const response = await fetchAgent(`${httpUrl}/agent/rooms/${connection.roomId}/status`, {
      headers: { Authorization: `Bearer ${connection.brokerCredential}` }
    }, signal);
    if (!response.ok) throw new Error(`status failed with ${response.status}`);
    const status = (await response.json()) as AgentControlStatusV1;
    if (status.state === "revoked" || status.state === "disconnected") {
      throw new Error(`agent control ${status.state}`);
    }
    if (
      status.state === "connected" &&
      ["running", "danger", "final_zone"].includes(status.matchState)
    ) return true;
    await sleep(500);
  }
  return false;
};

const runPairedControl = async (): Promise<void> => {
  const code = (process.env.ALPHA7_PAIRING_CODE ?? readFileSync(0, "utf8")).trim();
  if (!code) throw new Error("paste the one-time pairing code on stdin");
  let connection: AgentConnectionDescriptorV1 | undefined;
  let stopping = false;
  const abortController = new AbortController();
  const stop = () => {
    stopping = true;
    abortController.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    connection = await consumePairing(code, abortController.signal);
    const stopAt = Date.now() + durationMs;
    console.error("Alpha-7 agent connected and waiting for the match. Press Ctrl-C to release it.");
    if (await waitForPairedMatch(
      connection,
      stopAt,
      () => stopping,
      { nextHeartbeatAt: 0 },
      abortController.signal
    )) {
      await runControl(
        connection,
        stopAt,
        undefined,
        new Map<string, number>(),
        undefined,
        undefined,
        true,
        () => stopping,
        abortController.signal
      );
    }
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (connection) await releaseControl(connection);
  }
};

const main = async (): Promise<void> => {
  const clients = Array.from({ length: ownerCount }, () => new Client(wsUrl));
  const rooms: GameRoom[] = [];
  const connections: AgentConnectionDescriptorV1[] = [];
  const latencies: number[] = [];
  const actionSequences = new Map<string, number>();
  const acceptedByRound = new Map<string, number>();
  const requestCadenceBySeat = new Map<string, ControlRequestCadence>();
  const invalidatedSeatIds = new Set<string>();
  const runtimeFailures: string[] = [];
  const expectedLeaves = new WeakSet<GameRoom>();
  const validation: Record<string, unknown> = {};
  let result: Record<string, unknown> | undefined;
  let stopping = false;
  let interrupted = false;
  const abortController = new AbortController();
  const stop = () => {
    interrupted = true;
    stopping = true;
    abortController.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    let host = await clients[0]!.create(
      BATTLE_ROYALE_ROOM,
      { playerName: "Harness One", archetypeId: "quill", privateRoom: true, roomMode: mode },
      Alpha7StateSchema
    );
    host.reconnection.enabled = false;
    silenceExpectedMessages(host, runtimeFailures, expectedLeaves);
    rooms.push(host);
    for (let index = 1; index < ownerCount; index += 1) {
      const guest = await clients[index]!.joinById(
        host.roomId,
        { playerName: `Harness ${index + 1}`, archetypeId: index % 2 === 0 ? "atlas" : "rook" },
        Alpha7StateSchema
      );
      guest.reconnection.enabled = false;
      silenceExpectedMessages(guest, runtimeFailures, expectedLeaves);
      rooms.push(guest);
    }
    await waitFor(
      `${ownerCount} owners`,
      () => host.state.owners.size === ownerCount,
      15_000,
      abortController.signal
    );

    connections.push(...await Promise.all(rooms.map(async (room, index) =>
      consumePairing(await pairingCode(room, `Vector ${index + 1}`), abortController.signal)
    )));
    await waitFor(
      `${ownerCount} connected agent seats`,
      () => Array.from(host.state.owners.values())
        .every((owner) => owner.agentSeatState === "connected"),
      15_000,
      abortController.signal
    );
    for (const room of rooms) room.send(CLIENT_MESSAGE_TYPES.READY, { ready: true });
    await waitFor(
      "countdown",
      () => host.state.matchState === "countdown",
      15_000,
      abortController.signal
    );
    await waitFor(
      "running",
      () => host.state.matchState === "running",
      20_000,
      abortController.signal
    );
    if (lifecycle) {
      const ownerId = host.state.players.get(host.sessionId)?.ownerId;
      if (!ownerId) throw new Error("host owner was not materialized");
      host.send(CLIENT_MESSAGE_TYPES.AGENT_CONTROL, { action: "pause" });
      await waitFor(
        "paused agent",
        () => host.state.owners.get(ownerId)?.agentSeatState === "paused",
        15_000,
        abortController.signal
      );
      host.send(CLIENT_MESSAGE_TYPES.AGENT_CONTROL, { action: "resume" });
      await waitFor(
        "resumed agent",
        () => host.state.owners.get(ownerId)?.agentSeatState === "connected",
        15_000,
        abortController.signal
      );

      const reconnectToken = host.reconnectionToken;
      if (!reconnectToken) throw new Error("host did not receive a reconnection token");
      expectedLeaves.add(host);
      const dropped = host.leave(false).catch(() => undefined);
      const observer = rooms[1]!;
      await waitFor(
        "owner reconnecting",
        () => observer.state.owners.get(ownerId)?.agentSeatState === "reconnecting",
        15_000,
        abortController.signal
      );
      host = await clients[0]!.reconnect(reconnectToken, Alpha7StateSchema);
      host.reconnection.enabled = false;
      silenceExpectedMessages(host, runtimeFailures, expectedLeaves);
      rooms[0] = host;
      await waitFor(
        "owner reconnected",
        () => host.state.owners.get(ownerId)?.agentSeatState === "connected",
        15_000,
        abortController.signal
      );
      await dropped;
      validation.pauseResumeReconnect = true;
    }
    const initialCombatants = Array.from(host.state.players.values()).filter(
      (player) => !player.isSpectator
    ).length;
    const expectedCombatants = mode === "agent_cup" ? ownerCount : ownerCount * 2;
    if (initialCombatants !== expectedCombatants) {
      throw new Error(`expected ${expectedCombatants} combatants, received ${initialCombatants}`);
    }

    if (smokeLifecycle) {
      validation.smoke = await exerciseSmokeVisibility(
        host,
        connections,
        actionSequences,
        abortController.signal
      );
      await sleep(AGENT_OBSERVATION_INTERVAL_MS + 75);
    }

    const patchGaps: number[] = [];
    let previousPatchAt = 0;
    host.onStateChange(() => {
      const now = performance.now();
      if (previousPatchAt > 0) patchGaps.push(now - previousPatchAt);
      previousPatchAt = now;
    });
    const stopAt = Date.now() + durationMs;
    const rematchPromise = rematchLifecycle
      ? coordinateRematches(
          () => host,
          rooms,
          stopAt,
          () => stopping || runtimeFailures.length > 0,
          abortController.signal
        )
      : Promise.resolve([]);
    const capacityPromise = verifyCapacity
      ? collectCapacityEvidence(
          stopAt,
          ownerCount,
          expectedCombatants,
          () => stopping || runtimeFailures.length > 0
        )
      : Promise.resolve(undefined);
    const [accepted, rematches, capacity] = await Promise.all([
      Promise.all(connections.map((connection) =>
        runControl(
          connection,
          stopAt,
          latencies,
          actionSequences,
          acceptedByRound,
          verifyCapacity ? requestCadenceBySeat : undefined,
          !(idleExpiryLifecycle || revokeLifecycle),
          () => stopping || runtimeFailures.length > 0,
          abortController.signal
        )
      )),
      rematchPromise,
      capacityPromise
    ]);
    if (runtimeFailures.length > 0) {
      throw new Error(`unexpected room failure: ${runtimeFailures[0]}`);
    }
    if (rematchLifecycle && rematches.length === 0) {
      throw new Error("no finished-results-to-rematch transition occurred during the run");
    }
    const acceptedActionsByRound = Object.fromEntries(acceptedByRound);
    if (rematchLifecycle) {
      if (rematches.some((transition) => (acceptedByRound.get(transition.nextMatchId) ?? 0) === 0)) {
        throw new Error("rematch did not resume accepted broker actions in the new round");
      }
      validation.rematches = rematches;
      validation.acceptedActionsByRound = acceptedActionsByRound;
    }
    const patchCadence = {
      samples: patchGaps.length,
      p95: percentile(patchGaps, 0.95),
      p99: percentile(patchGaps, 0.99),
      max: Math.max(0, ...patchGaps)
    };
    if (verifyCapacity) {
      const minimumAcceptedActionsPerSeat = 2;
      const minimumAcceptedObservationsPerSeat = Math.max(
        2,
        Math.floor(durationMs / (HARNESS_REQUEST_INTERVAL_MS + 150))
      );
      const brokerLatency = {
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        max: Math.max(0, ...latencies)
      };
      const summarizeStarts = (startedAt: number[]) => {
        const gaps = startedAt.slice(1).map((at, index) => at - (startedAt[index] ?? at));
        return {
          requests: startedAt.length,
          minGapMs: gaps.length > 0 ? Math.min(...gaps) : null,
          maxGapMs: gaps.length > 0 ? Math.max(...gaps) : null
        };
      };
      const requestCadenceBySeatSummary = Object.fromEntries(
        Array.from(requestCadenceBySeat, ([seatId, cadence]) => [seatId, {
          acceptedActions: cadence.acceptedActions,
          observations: summarizeStarts(cadence.observationStartedAt),
          acceptedObservations: summarizeStarts(cadence.observationAcceptedAt),
          actions: summarizeStarts(cadence.actionStartedAt),
          acceptedArrivals: summarizeStarts(cadence.actionAcceptedAt),
          heartbeats: summarizeStarts(cadence.heartbeatStartedAt)
        }])
      );
      const requestCadencePassed =
        requestCadenceBySeat.size === ownerCount &&
        Array.from(requestCadenceBySeat.values()).every((cadence) => {
          const observationGaps = cadence.observationStartedAt
            .slice(1)
            .map((at, index) => at - (cadence.observationStartedAt[index] ?? at));
          const actionGaps = cadence.actionStartedAt
            .slice(1)
            .map((at, index) => at - (cadence.actionStartedAt[index] ?? at));
          const heartbeatGaps = cadence.heartbeatStartedAt
            .slice(1)
            .map((at, index) => at - (cadence.heartbeatStartedAt[index] ?? at));
          const acceptedArrivalGaps = cadence.actionAcceptedAt
            .slice(1)
            .map((at, index) => at - (cadence.actionAcceptedAt[index] ?? at));
          const acceptedObservationGaps = cadence.observationAcceptedAt
            .slice(1)
            .map((at, index) => at - (cadence.observationAcceptedAt[index] ?? at));
          return (
            cadence.acceptedActions >= minimumAcceptedActionsPerSeat &&
            cadence.observationAcceptedAt.length >= minimumAcceptedObservationsPerSeat &&
            cadence.actionAcceptedAt.length === cadence.acceptedActions &&
            observationGaps.length > 0 &&
            observationGaps.every((gap) => gap >= AGENT_OBSERVATION_INTERVAL_MS) &&
            acceptedObservationGaps.length > 0 &&
            acceptedObservationGaps.every((gap) => gap >= AGENT_OBSERVATION_INTERVAL_MS) &&
            actionGaps.length > 0 &&
            actionGaps.every((gap) => gap >= AGENT_ACTION_INTERVAL_MS) &&
            acceptedArrivalGaps.length > 0 &&
            acceptedArrivalGaps.every((gap) => gap >= AGENT_ACTION_INTERVAL_MS) &&
            heartbeatGaps.length > 0 &&
            heartbeatGaps.every((gap) => gap >= 4_500 && gap <= 6_000)
          );
        });
      const patchCadencePassed =
        patchCadence.samples > 0 &&
        patchCadence.p95 <= 100 &&
        patchCadence.p99 <= 250 &&
        patchCadence.max < 1_000;
      if (
        !capacity ||
        brokerLatency.p95 > 100 ||
        brokerLatency.p99 >= 250 ||
        brokerLatency.max >= 1_000 ||
        !requestCadencePassed ||
        !patchCadencePassed
      ) {
        throw new Error(`agent capacity checks failed: ${JSON.stringify({
          brokerLatency,
          requestCadencePassed,
          requestCadenceBySeat: requestCadenceBySeatSummary,
          patchCadence
        })}`);
      }
      validation.capacity = {
        ...capacity,
        brokerLatency,
        minimumAcceptedActionsPerSeat,
        minimumAcceptedObservationsPerSeat,
        requestCadencePassed,
        requestCadenceBySeat: requestCadenceBySeatSummary,
        patchCadence
      };
    }
    if (idleExpiryLifecycle) {
      validation.idleExpiry = await exerciseIdleExpiry(
        host,
        rooms,
        connections,
        invalidatedSeatIds,
        actionSequences,
        abortController.signal
      );
    }
    if (revokeLifecycle) {
      validation.revoke = await exerciseOwnerRevoke(
        host,
        rooms,
        connections,
        invalidatedSeatIds,
        actionSequences,
        abortController.signal
      );
    }

    result = {
      ok: true,
      mode,
      roomId: host.roomId,
      owners: host.state.owners.size,
      initialCombatants,
      aliveCombatants: Array.from(host.state.players.values()).filter((player) => !player.isSpectator).length,
      acceptedActions: accepted.reduce((total, count) => total + count, 0),
      durationMs,
      brokerLatencyMs: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        max: Math.max(0, ...latencies)
      },
      validation
    };
  } catch (error) {
    if (!stopping) {
      stopping = true;
      abortController.abort();
      throw error;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    const releases = await Promise.allSettled(
      connections
        .filter((connection) => !invalidatedSeatIds.has(connection.seatId))
        .map(releaseControl)
    );
    for (const room of rooms) expectedLeaves.add(room);
    await Promise.allSettled(rooms.reverse().map((room) => room.leave()));
    if (verifyCleanup && !interrupted) {
      validation.cleanup = await verifyCleanupHold(cleanupHoldMs);
    }
    const failedRelease = releases.find((release) => release.status === "rejected");
    if (failedRelease?.status === "rejected") throw failedRelease.reason;
  }
  if (interrupted && verifyCapacity) {
    throw new Error("capacity qualification interrupted before cleanup proof");
  }
  if (result) {
    console.log(
      json
        ? JSON.stringify(result, null, 2)
        : `Alpha-7 agent harness ok ${JSON.stringify(result)}`
    );
  }
};

const runHarness = async (): Promise<void> => {
  if (connectOnly) return runPairedControl();
  await assertSafeHarnessTarget();
  return tacticalReflex ? runTacticalReflexHarness() : main();
};

runHarness().catch((error) => {
  console.error(`Alpha-7 agent harness failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
