import { createServer } from "node:http";
import { Encoder } from "@colyseus/schema";
import cors from "cors";
import express from "express";
import { matchMaker, Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  AGENT_ACTION_VERSION,
  AGENT_EXECUTOR_VERSION,
  AGENT_OBSERVATION_VERSION,
  AGENT_PROTOCOL_VERSION,
  AGENT_TACTICAL_INTENT_VERSION,
  AGENT_TACTICAL_PROTOCOL_VERSION,
  AGENT_TACTICAL_REFLEX_VERSION,
  BATTLE_ROYALE_ROOM,
  type AgentConnectionDescriptorV1,
  type AgentTacticalConnectionDescriptorV2,
  type AgentErrorCode,
  type HealthResponse
} from "@alpha7/shared";
import {
  AgentBrokerError,
  FixedWindowRateLimiter,
  agentBroker,
  runRateLimitedAgentCall,
  type AgentBrokerScope
} from "./agentBroker.js";
import { serverConfig } from "./config.js";
import {
  HumanAdmissionError,
  createHumanAdmission,
  trustedRequestSourceKey
} from "./humanAdmission.js";
import { BattleRoyaleRoom } from "./rooms/BattleRoyaleRoom.js";
import { createRuntimeMetrics } from "./runtimeMetrics.js";
import {
  countSiteVisitors,
  isSiteVisitorId,
  recordSiteVisitor
} from "./sitePresence.js";

Encoder.BUFFER_SIZE = 96 * 1024;

const app = express();
const siteVisitors = new Map<string, number>();
const runtimeMetrics = serverConfig.enableCapacityMetrics ? createRuntimeMetrics() : null;
const agentHttpRateLimiter = new FixedWindowRateLimiter();
const isRailway = Boolean(process.env.RAILWAY_REPLICA_ID);
const requestSourceKey = (req: express.Request): string =>
  trustedRequestSourceKey({
    isRailway,
    headers: { get: (name) => req.get(name) },
    remoteAddress: req.socket.remoteAddress
  });

export const normalizeMatchmakingOptions = (options: unknown): Record<string, unknown> => ({
  roomMode: "classic",
  ...(typeof options === "object" && options !== null && !Array.isArray(options) ? options : {})
});

export const publicServerUrlForHost = (host: string | undefined): string => {
  const requestedHost = host?.split(",", 1)[0]?.trim();
  return serverConfig.publicServerUrls.find((url) => new URL(url).host === requestedHost) ??
    serverConfig.publicServerUrl;
};

const agentErrorCode = (error: unknown): AgentErrorCode => {
  if (!(error instanceof AgentBrokerError)) return "agent_revoked";
  switch (error.code) {
    case "rate_limited":
      return "rate_limited";
    case "match_not_active":
      return "match_not_active";
    case "agent_paused":
    case "broker_paused":
      return "agent_paused";
    case "owner_unavailable":
      return "owner_unavailable";
    case "grant_expired":
    case "grant_invalid":
    case "grant_cancelled":
      return "grant_expired";
    case "grant_consumed":
      return "grant_consumed";
    case "principal_mismatch":
    case "scope_denied":
      return "principal_mismatch";
    case "pending_exists":
    case "seat_reserved":
    case "control_exists":
      return "pending_exists";
    default:
      return "agent_revoked";
  }
};

const agentErrorStatus = (code: AgentErrorCode): number =>
  code === "rate_limited"
    ? 429
    : code === "match_not_active" || code === "agent_paused" || code === "owner_unavailable"
      ? 409
      : code === "principal_mismatch"
        ? 403
        : 401;

const roomIdFrom = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(value) ? value : undefined;

const bearerFrom = (authorization: string | undefined): string | undefined => {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
  return match?.[1];
};

const agentActionRoomIdFromPath = (path: string): string | undefined => {
  const encodedRoomId = /^\/agent\/rooms\/([^/]+)\/action\/?$/i.exec(path)?.[1];
  if (!encodedRoomId) return undefined;
  try {
    return roomIdFrom(decodeURIComponent(encodedRoomId));
  } catch {
    return undefined;
  }
};

const agentTacticalIntentRoomIdFromPath = (path: string): string | undefined => {
  const encodedRoomId = /^\/agent\/rooms\/([^/]+)\/tactical-intent\/?$/i.exec(path)?.[1];
  if (!encodedRoomId) return undefined;
  try {
    return roomIdFrom(decodeURIComponent(encodedRoomId));
  } catch {
    return undefined;
  }
};

const authorizeAgentControl = (
  roomId: string | undefined,
  authorization: string | undefined,
  scope: AgentBrokerScope,
  allowPaused = false
) => {
  const brokerCredential = bearerFrom(authorization);
  if (!roomId || !brokerCredential) throw new AgentBrokerError("broker_invalid");
  let session;
  try {
    session = agentBroker.authorize({
      roomId,
      brokerCredential,
      requiredScope: scope,
      allowPaused
    });
  } catch (error) {
    if (
      error instanceof AgentBrokerError &&
      (error.code === "principal_mismatch" || error.code === "scope_denied")
    ) {
      throw new AgentBrokerError("broker_invalid");
    }
    throw error;
  }
  return {
    roomId,
    brokerCredential,
    session
  };
};

const callAgentActionRoom = (
  authorized: ReturnType<typeof authorizeAgentControl>,
  payload: unknown,
  brokerReceivedAtMs: number,
  transportRejectionCode?: "rate_limited"
) => matchMaker.remoteRoomCall<BattleRoyaleRoom, "agentAct">(
  authorized.roomId,
  "agentAct",
  [authorized.session, payload, Date.now(), brokerReceivedAtMs, transportRejectionCode]
);

const runAgentActionCall = async (
  authorized: ReturnType<typeof authorizeAgentControl>,
  payload: unknown,
  brokerReceivedAtMs: number
) => {
  let neutralizeOnLimit = false;
  try {
    return await runRateLimitedAgentCall(
      agentHttpRateLimiter,
      authorized.session.principal.controlId,
      "action",
      () => callAgentActionRoom(authorized, payload, brokerReceivedAtMs),
      brokerReceivedAtMs,
      () => {
        neutralizeOnLimit = true;
      }
    );
  } catch (error) {
    if (neutralizeOnLimit) {
      await callAgentActionRoom(authorized, undefined, brokerReceivedAtMs, "rate_limited");
    }
    throw error;
  }
};

const rejectTransportInvalidAgentAction = async (
  authorized: ReturnType<typeof authorizeAgentControl>,
  brokerReceivedAtMs: number
): Promise<void> => {
  await runAgentActionCall(
    authorized,
    undefined,
    brokerReceivedAtMs
  );
};

const callAgentTacticalIntentRoom = (
  authorized: ReturnType<typeof authorizeAgentControl>,
  payload: unknown,
  brokerReceivedAtMs: number
) => matchMaker.remoteRoomCall<BattleRoyaleRoom, "agentSetTacticalIntent">(
  authorized.roomId,
  "agentSetTacticalIntent",
  [authorized.session, payload, Date.now(), brokerReceivedAtMs]
);

const runAgentTacticalIntentCall = async (
  authorized: ReturnType<typeof authorizeAgentControl>,
  payload: unknown,
  brokerReceivedAtMs: number
) => {
  let neutralizeOnLimit = false;
  try {
    return await runRateLimitedAgentCall(
      agentHttpRateLimiter,
      authorized.session.principal.controlId,
      "action",
      () => callAgentTacticalIntentRoom(authorized, payload, brokerReceivedAtMs),
      brokerReceivedAtMs,
      () => {
        neutralizeOnLimit = true;
      }
    );
  } catch (error) {
    if (neutralizeOnLimit) {
      await callAgentTacticalIntentRoom(authorized, undefined, brokerReceivedAtMs);
    }
    throw error;
  }
};

const isAllowedOrigin = (origin: string | undefined): boolean =>
  !origin || serverConfig.allowedOrigins.includes(origin);

matchMaker.controller.DEFAULT_CORS_HEADERS["Access-Control-Allow-Origin"] = serverConfig.publicClientUrl;
matchMaker.controller.getCorsHeaders = (headers) => {
  const requestOrigin = headers.get("origin") ?? undefined;

  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(requestOrigin)
      ? requestOrigin ?? serverConfig.publicClientUrl
      : serverConfig.publicClientUrl,
    Vary: "Origin"
  };
};

app.disable("x-powered-by");
app.get("/", (_req, res) => {
  res.redirect(302, serverConfig.publicClientUrl);
});
app.use("/agent", (req, res, next) => {
  const path = `${req.baseUrl}${req.path}`;
  const tacticalRoute =
    (req.method === "PUT" && /^\/agent\/rooms\/[^/]+\/tactical-intent\/?$/i.test(path)) ||
    (req.method === "GET" && /^\/agent\/rooms\/[^/]+\/tactical-status\/?$/i.test(path)) ||
    (req.method === "DELETE" && /^\/agent\/rooms\/[^/]+\/tactical-intent\/?$/i.test(path));
  if (serverConfig.agentPlayEnabled && tacticalRoute && !serverConfig.agentTacticalReflexEnabled) {
    res.set("Cache-Control", "no-store");
    res.status(404).json({
      version: AGENT_TACTICAL_INTENT_VERSION,
      ok: false,
      error: { code: "agent_feature_disabled" }
    });
    return;
  }
  const bodylessRoute =
    (req.method === "POST" && /^\/agent\/rooms\/[^/]+\/(?:grants\/consume|heartbeat)\/?$/i.test(path)) ||
    (req.method === "GET" && /^\/agent\/rooms\/[^/]+\/(?:observation|status|tactical-status)\/?$/i.test(path)) ||
    (req.method === "DELETE" && /^\/agent\/rooms\/[^/]+\/(?:control|tactical-intent)\/?$/i.test(path));
  const contentLength = req.get("content-length");
  const hasBody = req.get("transfer-encoding") !== undefined ||
    (contentLength !== undefined && !/^0+$/.test(contentLength));
  if (serverConfig.agentPlayEnabled && bodylessRoute && hasBody) {
    res.set("Cache-Control", "no-store");
    res.status(413).json({
      version: AGENT_PROTOCOL_VERSION,
      ok: false,
      error: { code: "lease_invalid" }
    });
    return;
  }
  next();
});
app.use(express.json({ limit: "2kb", strict: true }));
app.use(async (error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number(error.status)
      : undefined;
  const roomId = agentActionRoomIdFromPath(req.path);
  const tacticalRoomId = agentTacticalIntentRoomIdFromPath(req.path);
  const isBodyParserClientError = status !== undefined && status >= 400 && status < 500;
  if ((isBodyParserClientError || error instanceof SyntaxError) && roomId && serverConfig.agentPlayEnabled) {
    res.set("Cache-Control", "no-store");
    try {
      await rejectTransportInvalidAgentAction(
        authorizeAgentControl(roomId, req.get("authorization"), "agent:act", true),
        Date.now()
      );
      res.status(status === 413 || status === 415 ? status : 400).json({
        version: AGENT_PROTOCOL_VERSION,
        ok: false,
        error: { code: "lease_invalid" }
      });
    } catch (agentError) {
      sendAgentFailure(res, agentError);
    }
    return;
  }
  if (
    (isBodyParserClientError || error instanceof SyntaxError) &&
    tacticalRoomId &&
    serverConfig.agentPlayEnabled &&
    serverConfig.agentTacticalReflexEnabled
  ) {
    res.set("Cache-Control", "no-store");
    try {
      await runAgentTacticalIntentCall(
        authorizeAgentControl(tacticalRoomId, req.get("authorization"), "agent:tactic", true),
        undefined,
        Date.now()
      );
      res.status(status === 413 || status === 415 ? status : 400).json({
        version: AGENT_TACTICAL_INTENT_VERSION,
        ok: false,
        error: { code: "tactical_intent_invalid" }
      });
    } catch (agentError) {
      sendAgentFailure(res, agentError);
    }
    return;
  }
  next(error);
});
app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    }
  })
);

app.get("/healthz", (_req, res) => {
  const payload: HealthResponse = {
    ok: true,
    service: "alpha7-server",
    room: BATTLE_ROYALE_ROOM,
    version: serverConfig.buildVersion
  };
  res.json(payload);
});

app.post("/presence", express.text({ type: "text/plain", limit: "64b" }), (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!isAllowedOrigin(req.get("origin"))) {
    res.status(403).json({ error: "origin_not_allowed" });
    return;
  }
  if (!isSiteVisitorId(req.body)) {
    res.status(400).json({ error: "invalid_visitor_id" });
    return;
  }
  const playersOnline = recordSiteVisitor(siteVisitors, req.body);
  if (playersOnline === null) {
    res.status(429).json({ error: "presence_capacity_reached" });
    return;
  }
  res.json({ playersOnline });
});

app.get("/stats", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ playersOnline: countSiteVisitors(siteVisitors) });
});

function sendAgentFailure(res: express.Response, error: unknown): void {
  const code = agentErrorCode(error);
  res.status(agentErrorStatus(code)).json({
    version: AGENT_PROTOCOL_VERSION,
    ok: false,
    error: { code }
  });
}

app.use("/agent", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!serverConfig.agentPlayEnabled) {
    res.status(404).json({
      version: AGENT_PROTOCOL_VERSION,
      ok: false,
      error: { code: "agent_feature_disabled" }
    });
    return;
  }
  next();
});

app.post("/agent/rooms/:roomId/grants/consume", async (req, res) => {
  const roomId = roomIdFrom(req.params.roomId);
  const grantCredential = bearerFrom(req.get("authorization"));
  if (!roomId || !grantCredential) {
    sendAgentFailure(res, new AgentBrokerError("grant_invalid"));
    return;
  }
  try {
    const consumed = await agentBroker.consumeGrant(
      { roomId, grantCredential, sourceKey: requestSourceKey(req) },
      (principal) =>
        matchMaker.remoteRoomCall<BattleRoyaleRoom, "agentMaterialize">(
          roomId,
          "agentMaterialize",
          [principal]
        )
    );
    const common = {
      roomId,
      seatId: consumed.session.principal.seatId,
      apiBaseUrl: publicServerUrlForHost(req.get("x-forwarded-host") ?? req.get("host")),
      brokerCredential: consumed.brokerCredential,
      idleDeadlineMs: consumed.session.idleDeadlineMs,
      observationVersion: AGENT_OBSERVATION_VERSION,
      arena: consumed.materialized
    };
    const descriptor: AgentConnectionDescriptorV1 | AgentTacticalConnectionDescriptorV2 =
      consumed.session.principal.controlMode === "tactical_reflex_v1"
        ? {
            protocolVersion: AGENT_TACTICAL_PROTOCOL_VERSION,
            controlMode: "tactical_reflex_v1",
            tacticalIntentVersion: AGENT_TACTICAL_INTENT_VERSION,
            reflexVersion: AGENT_TACTICAL_REFLEX_VERSION,
            executorVersion: AGENT_EXECUTOR_VERSION,
            ...common
          }
        : {
            protocolVersion: AGENT_PROTOCOL_VERSION,
            actionVersion: AGENT_ACTION_VERSION,
            ...common
          };
    res.status(201).json(descriptor);
  } catch (error) {
    sendAgentFailure(res, error);
  }
});

const authorizeAgentRequest = (
  req: express.Request,
  scope: AgentBrokerScope,
  allowPaused = false
) => authorizeAgentControl(
  roomIdFrom(req.params.roomId),
  req.get("authorization"),
  scope,
  allowPaused
);

app.get("/agent/rooms/:roomId/observation", async (req, res) => {
  try {
    const { roomId, session } = authorizeAgentRequest(req, "agent:observe", true);
    res.json(
      await runRateLimitedAgentCall(
        agentHttpRateLimiter,
        session.principal.controlId,
        "observation",
        () =>
          matchMaker.remoteRoomCall<BattleRoyaleRoom, "agentObserve">(
            roomId,
            "agentObserve",
            [session]
          )
      )
    );
  } catch (error) {
    sendAgentFailure(res, error);
  }
});

app.post("/agent/rooms/:roomId/action", async (req, res) => {
  const brokerReceivedAtMs = Date.now();
  try {
    const authorized = authorizeAgentRequest(req, "agent:act", true);
    if (!req.is("application/json")) {
      await rejectTransportInvalidAgentAction(authorized, brokerReceivedAtMs);
      res.status(415).json({
        version: AGENT_PROTOCOL_VERSION,
        ok: false,
        error: { code: "lease_invalid" }
      });
      return;
    }
    res.json(await runAgentActionCall(authorized, req.body, brokerReceivedAtMs));
  } catch (error) {
    sendAgentFailure(res, error);
  }
});

app.put("/agent/rooms/:roomId/tactical-intent", async (req, res) => {
  const brokerReceivedAtMs = Date.now();
  if (!serverConfig.agentTacticalReflexEnabled) {
    res.status(404).json({
      version: AGENT_TACTICAL_INTENT_VERSION,
      ok: false,
      error: { code: "agent_feature_disabled" }
    });
    return;
  }
  try {
    const authorized = authorizeAgentRequest(req, "agent:tactic", true);
    if (!req.is("application/json")) {
      await runAgentTacticalIntentCall(authorized, undefined, brokerReceivedAtMs);
      res.status(415).json({
        version: AGENT_TACTICAL_INTENT_VERSION,
        ok: false,
        error: { code: "tactical_intent_invalid" }
      });
      return;
    }
    res.json(await runAgentTacticalIntentCall(authorized, req.body, brokerReceivedAtMs));
  } catch (error) {
    sendAgentFailure(res, error);
  }
});

app.get("/agent/rooms/:roomId/tactical-status", async (req, res) => {
  if (!serverConfig.agentTacticalReflexEnabled) {
    res.status(404).json({
      version: AGENT_TACTICAL_INTENT_VERSION,
      ok: false,
      error: { code: "agent_feature_disabled" }
    });
    return;
  }
  try {
    const { roomId, session } = authorizeAgentRequest(req, "agent:tactic", true);
    res.json(await runRateLimitedAgentCall(
      agentHttpRateLimiter,
      session.principal.controlId,
      "status",
      () => matchMaker.remoteRoomCall<BattleRoyaleRoom, "agentTacticalStatus">(
        roomId,
        "agentTacticalStatus",
        [session]
      )
    ));
  } catch (error) {
    sendAgentFailure(res, error);
  }
});

app.delete("/agent/rooms/:roomId/tactical-intent", async (req, res) => {
  if (!serverConfig.agentTacticalReflexEnabled) {
    res.status(404).json({
      version: AGENT_TACTICAL_INTENT_VERSION,
      ok: false,
      error: { code: "agent_feature_disabled" }
    });
    return;
  }
  try {
    const { roomId, session } = authorizeAgentRequest(req, "agent:tactic", true);
    res.json(await runRateLimitedAgentCall(
      agentHttpRateLimiter,
      session.principal.controlId,
      "action",
      () => matchMaker.remoteRoomCall<BattleRoyaleRoom, "agentClearTacticalIntent">(
        roomId,
        "agentClearTacticalIntent",
        [session]
      )
    ));
  } catch (error) {
    sendAgentFailure(res, error);
  }
});

app.post("/agent/rooms/:roomId/heartbeat", async (req, res) => {
  try {
    const { roomId, brokerCredential, session } = authorizeAgentRequest(
      req,
      "agent:heartbeat",
      true
    );
    res.json(
      await runRateLimitedAgentCall(
        agentHttpRateLimiter,
        session.principal.controlId,
        "heartbeat",
        () => {
          const heartbeat = agentBroker.heartbeat(brokerCredential, roomId);
          return matchMaker.remoteRoomCall<BattleRoyaleRoom, "agentHeartbeat">(
            roomId,
            "agentHeartbeat",
            [heartbeat]
          );
        }
      )
    );
  } catch (error) {
    sendAgentFailure(res, error);
  }
});

app.get("/agent/rooms/:roomId/status", async (req, res) => {
  try {
    const { roomId, session } = authorizeAgentRequest(req, "agent:observe", true);
    res.json(
      await runRateLimitedAgentCall(
        agentHttpRateLimiter,
        session.principal.controlId,
        "status",
        () =>
          matchMaker.remoteRoomCall<BattleRoyaleRoom, "agentStatus">(
            roomId,
            "agentStatus",
            [session]
          )
      )
    );
  } catch (error) {
    sendAgentFailure(res, error);
  }
});

app.delete("/agent/rooms/:roomId/control", async (req, res) => {
  try {
    const { roomId, brokerCredential, session } = authorizeAgentRequest(
      req,
      "agent:release",
      true
    );
    await matchMaker.remoteRoomCall<BattleRoyaleRoom, "agentRelease">(
      roomId,
      "agentRelease",
      [session.principal]
    );
    agentBroker.releaseControl(brokerCredential, roomId);
    res.status(204).end();
  } catch (error) {
    sendAgentFailure(res, error);
  }
});

if (runtimeMetrics) {
  app.get("/capacityz", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    const processes = await matchMaker.stats.fetchAll();
    const rooms = await matchMaker.query({ name: BATTLE_ROYALE_ROOM });
    const agentSnapshots = await Promise.allSettled(
      rooms.map((room) =>
        matchMaker.remoteRoomCall<BattleRoyaleRoom, "agentCapacitySnapshot">(
          room.roomId,
          "agentCapacitySnapshot"
        )
      )
    );
    const snapshots = agentSnapshots.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
    const roomAgentTotals = snapshots.reduce(
      (totals, snapshot) => ({
        owners: totals.owners + snapshot.owners,
        connectedOwners: totals.connectedOwners + snapshot.connectedOwners,
        controls: totals.controls + snapshot.controls,
        agentEntities: totals.agentEntities + snapshot.agentEntities,
        combatants: totals.combatants + snapshot.combatants,
        activeLeases: totals.activeLeases + snapshot.activeLeases,
        pausedControls: totals.pausedControls + snapshot.pausedControls,
        pendingPairings: totals.pendingPairings + snapshot.pendingPairings,
        auditEvents: totals.auditEvents + snapshot.auditEvents
      }),
      {
        owners: 0,
        connectedOwners: 0,
        controls: 0,
        agentEntities: 0,
        combatants: 0,
        activeLeases: 0,
        pausedControls: 0,
        pendingPairings: 0,
        auditEvents: 0
      }
    );
    const snapshotFailures = agentSnapshots.length - snapshots.length;
    res.json({
      ok: snapshotFailures === 0,
      telemetryVersion: 3,
      environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? serverConfig.nodeEnv,
      environmentId: process.env.RAILWAY_ENVIRONMENT_ID ?? null,
      rooms: {
        local: matchMaker.stats.local,
        aggregate: processes.reduce(
          (total, processStats) => ({
            roomCount: total.roomCount + processStats.roomCount,
            ccu: total.ccu + processStats.ccu
          }),
          { roomCount: 0, ccu: 0 }
        )
      },
      agent: {
        enabled: serverConfig.agentPlayEnabled,
        expandedCombatantsEnabled: serverConfig.agentExpandedCombatantsEnabled,
        cupMaxControlsEnabled: serverConfig.agentCupMaxControlsEnabled,
        broker: {
          pendingGrants: agentBroker.pendingGrantCount,
          retainedGrants: agentBroker.retainedGrantCount,
          activeControls: agentBroker.activeControlCount,
          brokerRateBuckets: agentBroker.retainedRateBucketCount,
          httpRateBuckets: agentHttpRateLimiter.retainedBucketCount
        },
        roomTotals: roomAgentTotals,
        snapshotFailures
      },
      runtime: await runtimeMetrics.snapshot()
    });
  });
}

app.get("/rooms/:code", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const roomCode = req.params.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,32}$/.test(roomCode)) {
    res.status(400).json({ ok: false, error: "invalid_room_code" });
    return;
  }

  const rooms = await matchMaker.query({ name: BATTLE_ROYALE_ROOM });
  const room = rooms.find(
    (candidate) =>
      candidate.roomId === roomCode ||
      String(candidate.metadata?.roomCode ?? "").toUpperCase() === roomCode
  );

  if (!room || room.locked) {
    res.status(404).json({ ok: false, error: "room_not_found" });
    return;
  }

  res.json({
    ok: true,
    roomId: room.roomId,
    roomCode: room.metadata?.roomCode ?? room.roomId,
    matchState: room.metadata?.matchState,
    mode: room.metadata?.mode,
    track: room.metadata?.track,
    combatantCap: room.metadata?.combatantCap,
    playerCount: room.clients,
    maxClients: room.maxClients
  });
});

app.post("/rooms/:code/reserve", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const roomCode = req.params.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,32}$/.test(roomCode)) {
    res.status(400).json({ ok: false, error: "invalid_room_code" });
    return;
  }

  try {
    const rooms = await matchMaker.query({ name: BATTLE_ROYALE_ROOM });
    const room = rooms.find(
      (candidate) =>
        candidate.roomId === roomCode ||
        String(candidate.metadata?.roomCode ?? "").toUpperCase() === roomCode
    );

    if (!room || room.locked) {
      res.status(404).json({ ok: false, error: "room_not_found" });
      return;
    }

    const admission = createHumanAdmission(req.body, requestSourceKey(req));
    const reservation = await matchMaker.reserveSeatFor(
      room,
      admission.options,
      admission.principal
    );
    res.json(reservation);
  } catch (error) {
    if (error instanceof HumanAdmissionError) {
      res.status(400).json({ ok: false, error: error.message });
      return;
    }
    res.status(409).json({
      ok: false,
      error: "unable_to_reserve_room"
    });
  }
});

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : undefined;
    if (status === 413 || error instanceof SyntaxError) {
      res.set("Cache-Control", "no-store");
      res.status(status === 413 ? 413 : 400).json({
        ok: false,
        error: status === 413 ? "payload_too_large" : "invalid_json"
      });
      return;
    }
    next(error);
  }
);

export const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
    verifyClient(info, done) {
      if (isAllowedOrigin(info.origin)) {
        done(true);
        return;
      }
      done(false, 403, "Origin not allowed");
    }
  })
});

if (serverConfig.agentPlayEnabled) {
  setInterval(() => {
    agentBroker.sweepExpired();
    agentHttpRateLimiter.prune();
  }, 5_000).unref();
}

const battleRoyaleHandler = gameServer
  .define(BATTLE_ROYALE_ROOM, BattleRoyaleRoom, {
    config: serverConfig,
    recordSimulationTick: runtimeMetrics?.recordSimulationTick
  })
  .filterBy(["roomMode"]);
const getBattleRoyaleFilterOptions = battleRoyaleHandler.getFilterOptions.bind(battleRoyaleHandler);
battleRoyaleHandler.getFilterOptions = (options) =>
  getBattleRoyaleFilterOptions(normalizeMatchmakingOptions(options));

if (serverConfig.nodeEnv !== "test") {
  try {
    await gameServer.listen(serverConfig.port);
    console.log(
      `[alpha7] server listening on :${serverConfig.port} room=${BATTLE_ROYALE_ROOM} origins=${serverConfig.allowedOrigins.join(",")}`
    );
  } catch (error) {
    runtimeMetrics?.close();
    console.error("[alpha7] failed to start server", error);
    process.exit(1);
  }
}
