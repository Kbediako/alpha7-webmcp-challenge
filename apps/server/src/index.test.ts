import { request, type Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentBroker } from "./agentBroker.js";

const TACTICAL_OPENING = {
  version: 1,
  intentSeq: 1,
  basedOnObservationSeq: null,
  validForMs: 45_000,
  objective: { type: "zone_center" as const },
  fire: "none" as const,
  useAbility: false as const,
  fallback: "hold" as const
};

const transportState = vi.hoisted(() => ({ leaseActive: false }));
const remoteRoomCall = vi.hoisted(() => vi.fn(async (_roomId, method, args) => {
  const payload = (args as unknown[])[1] as { intentSeq?: number } | undefined;
  const transportRejectionCode = (args as unknown[])[4];
  if (method === "agentMaterialize") {
    return { bounds: { minX: 0, minZ: 0, maxX: 100, maxZ: 100 }, walls: [] };
  }
  if (method === "agentSetTacticalIntent") {
    return {
      version: 1,
      type: "agent_tactical_intent_result",
      intentSeq: payload?.intentSeq ?? null,
      accepted: payload !== undefined,
      code: payload === undefined ? "tactical_intent_invalid" : "accepted",
      intentExpiresAtMs: payload === undefined ? null : Date.now() + 1_000
    };
  }
  if (method === "agentTacticalStatus" || method === "agentClearTacticalIntent") {
    return {
      version: 1,
      type: "agent_tactical_status",
      controlMode: "tactical_reflex_v1",
      active: false,
      stopReason: method === "agentClearTacticalIntent" ? "cleared" : "no_intent"
    };
  }
  if (method === "agentAct" && payload === undefined) {
    transportState.leaseActive = false;
    return {
      version: 1,
      type: "agent_action_result",
      actionSeq: null,
      accepted: false,
      code: transportRejectionCode ?? "lease_invalid",
      leaseExpiresAtMs: null
    };
  }
  transportState.leaseActive = true;
  return {
    version: 1,
    type: "agent_action_result",
    actionSeq: 1,
    accepted: true,
    code: "accepted",
    leaseExpiresAtMs: Date.now() + 500
  };
}));

vi.mock("colyseus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("colyseus")>();
  return {
    ...actual,
    matchMaker: {
      ...actual.matchMaker,
      remoteRoomCall
    }
  };
});

describe("agent action HTTP transport", () => {
  let brokerCredential = "";
  let tacticalBrokerCredential = "";
  let httpServer: HttpServer;
  let normalizeMatchmakingOptions: typeof import("./index.js")["normalizeMatchmakingOptions"];
  let publicServerUrlForHost: typeof import("./index.js")["publicServerUrlForHost"];
  let mutableServerConfig: { agentTacticalReflexEnabled: boolean };
  let origin = "";

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AGENT_PLAY_ENABLED", "true");
    vi.stubEnv("AGENT_TACTICAL_REFLEX_ENABLED", "true");
    vi.stubEnv("PUBLIC_SERVER_COMPAT_URLS", "https://api.alpha7.asabeko.com");
    ({ httpServer, normalizeMatchmakingOptions, publicServerUrlForHost } = await import("./index.js"));
    mutableServerConfig = (await import("./config.js")).serverConfig;
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    origin = `http://127.0.0.1:${address.port}`;

    const grant = agentBroker.createGrant({
      roomId: "ROOM123",
      ownerId: "owner-http-route",
      seatId: "seat-http-route",
      roomMode: "open_ffa",
      agentName: "Route Guard",
      archetype: "nova",
      sourceKey: "test:http-route"
    });
    const consumed = await agentBroker.consumeGrant(
      {
        roomId: "ROOM123",
        grantCredential: grant.grantCredential,
        sourceKey: "test:http-route"
      },
      () => ({})
    );
    brokerCredential = consumed.brokerCredential;
    const tacticalGrant = agentBroker.createGrant({
      roomId: "ROOM123",
      ownerId: "owner-http-tactical",
      seatId: "seat-http-tactical",
      roomMode: "open_ffa",
      controlMode: "tactical_reflex_v1",
      openingTactic: TACTICAL_OPENING,
      agentName: "Tactical Guard",
      archetype: "nova",
      sourceKey: "test:http-tactical"
    });
    tacticalBrokerCredential = (await agentBroker.consumeGrant(
      {
        roomId: "ROOM123",
        grantCredential: tacticalGrant.grantCredential,
        sourceKey: "test:http-tactical"
      },
      () => ({})
    )).brokerCredential;
    const rateWindowNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(rateWindowNow);
  });

  it("defaults legacy matchmaking requests to Classic without overriding an explicit mode", () => {
    expect(normalizeMatchmakingOptions({ archetypeId: "rook" })).toMatchObject({
      roomMode: "classic",
      archetypeId: "rook"
    });
    expect(normalizeMatchmakingOptions({ roomMode: "wingman" })).toEqual({ roomMode: "wingman" });
  });

  it("redirects the backend root to the canonical client", async () => {
    const response = await fetch(`${origin}/`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173");
  });

  it("returns only a configured backend origin for the request host", () => {
    expect(publicServerUrlForHost("api.alpha7.asabeko.com")).toBe(
      "https://api.alpha7.asabeko.com"
    );
    expect(publicServerUrlForHost("attacker.example")).toBe("http://localhost:2567");
  });

  it("keeps the Macro V1 descriptor exact and returns a distinct Tactical V2 descriptor", async () => {
    const consume = async (controlMode: "macro_v1" | "tactical_reflex_v1", suffix: string) => {
      const grant = agentBroker.createGrant({
        roomId: "ROOM123",
        ownerId: `owner-descriptor-${suffix}`,
        seatId: `seat-descriptor-${suffix}`,
        roomMode: "open_ffa",
        controlMode,
        ...(controlMode === "tactical_reflex_v1" ? { openingTactic: TACTICAL_OPENING } : {}),
        agentName: "Descriptor Guard",
        archetype: "nova",
        sourceKey: `test:descriptor-${suffix}`
      });
      const response = await fetch(`${origin}/agent/rooms/ROOM123/grants/consume`, {
        method: "POST",
        headers: { Authorization: `Bearer ${grant.grantCredential}` }
      });
      expect(response.status).toBe(201);
      return await response.json() as Record<string, unknown>;
    };

    const macro = await consume("macro_v1", "macro");
    expect(Object.keys(macro).sort()).toEqual([
      "actionVersion",
      "apiBaseUrl",
      "arena",
      "brokerCredential",
      "idleDeadlineMs",
      "observationVersion",
      "protocolVersion",
      "roomId",
      "seatId"
    ]);
    expect(macro.protocolVersion).toBe(1);
    expect(macro).not.toHaveProperty("controlMode");

    const tactical = await consume("tactical_reflex_v1", "tactical");
    expect(tactical).toMatchObject({
      protocolVersion: 2,
      controlMode: "tactical_reflex_v1",
      observationVersion: 1,
      tacticalIntentVersion: 1,
      reflexVersion: 1,
      executorVersion: 1
    });
    expect(tactical).not.toHaveProperty("actionVersion");

    for (const descriptor of [macro, tactical]) {
      await fetch(`${origin}/agent/rooms/ROOM123/control`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${descriptor.brokerCredential as string}` }
      });
    }
  });

  it("routes tactical set/status/clear and keeps writers mutually exclusive", async () => {
    const authorization = { Authorization: `Bearer ${tacticalBrokerCredential}` };
    const intent = {
      version: 1,
      intentSeq: 2,
      basedOnObservationSeq: 1,
      validForMs: 30_000,
      objective: { type: "zone_center" },
      fire: "none",
      useAbility: false,
      fallback: "hold"
    };
    const set = await fetch(`${origin}/agent/rooms/ROOM123/tactical-intent`, {
      method: "PUT",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify(intent)
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      type: "agent_tactical_intent_result",
      accepted: true,
      intentSeq: 2
    });
    expect(remoteRoomCall.mock.calls.at(-1)?.[1]).toBe("agentSetTacticalIntent");
    expect((remoteRoomCall.mock.calls.at(-1)?.[2] as unknown[])[1]).toEqual(intent);

    const status = await fetch(`${origin}/agent/rooms/ROOM123/tactical-status`, {
      headers: authorization
    });
    expect(status.status).toBe(200);
    expect(remoteRoomCall.mock.calls.at(-1)?.[1]).toBe("agentTacticalStatus");

    const clear = await fetch(`${origin}/agent/rooms/ROOM123/tactical-intent`, {
      method: "DELETE",
      headers: authorization
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toMatchObject({ stopReason: "cleared" });
    expect(remoteRoomCall.mock.calls.at(-1)?.[1]).toBe("agentClearTacticalIntent");

    const macroRoute = await fetch(`${origin}/agent/rooms/ROOM123/action`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    expect(macroRoute.status).toBe(401);
    expect(await macroRoute.json()).toEqual({
      version: 1,
      ok: false,
      error: { code: "agent_revoked" }
    });
  });

  it("disables every tactical route while leaving Macro V1 available", async () => {
    Object.defineProperty(mutableServerConfig, "agentTacticalReflexEnabled", { value: false });
    try {
      const callsBefore = remoteRoomCall.mock.calls.length;
      const authorization = { Authorization: `Bearer ${tacticalBrokerCredential}` };
      const responses = await Promise.all([
        fetch(`${origin}/agent/rooms/ROOM123/tactical-intent`, {
          method: "PUT",
          headers: { ...authorization, "Content-Type": "application/json" },
          body: JSON.stringify({})
        }),
        fetch(`${origin}/agent/rooms/ROOM123/tactical-status`, { headers: authorization }),
        fetch(`${origin}/agent/rooms/ROOM123/tactical-intent`, {
          method: "DELETE",
          headers: authorization
        })
      ]);
      for (const response of responses) {
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          version: 1,
          ok: false,
          error: { code: "agent_feature_disabled" }
        });
      }
      const rawDisabledRequest = (method: "GET" | "PUT" | "DELETE", path: string, body: string) =>
        new Promise<{ status: number; body: unknown }>((resolve, reject) => {
          const req = request(`${origin}${path}`, {
            method,
            headers: {
              ...authorization,
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(body))
            }
          }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.once("error", reject);
            response.once("end", () => resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
            }));
          });
          req.once("error", reject);
          req.end(body);
        });
      const malformedOrBodyful = await Promise.all([
        rawDisabledRequest("PUT", "/agent/rooms/ROOM123/tactical-intent", "{"),
        rawDisabledRequest("GET", "/agent/rooms/ROOM123/tactical-status", "{}"),
        rawDisabledRequest("DELETE", "/agent/rooms/ROOM123/tactical-intent", "{}")
      ]);
      for (const response of malformedOrBodyful) {
        expect(response).toEqual({
          status: 404,
          body: {
            version: 1,
            ok: false,
            error: { code: "agent_feature_disabled" }
          }
        });
      }
      expect(remoteRoomCall.mock.calls).toHaveLength(callsBefore);

      const macroStatus = await fetch(`${origin}/agent/rooms/ROOM123/status`, {
        headers: { Authorization: `Bearer ${brokerCredential}` }
      });
      expect(macroStatus.status).toBe(200);
      expect(remoteRoomCall.mock.calls.at(-1)?.[1]).toBe("agentStatus");
    } finally {
      Object.defineProperty(mutableServerConfig, "agentTacticalReflexEnabled", { value: true });
    }
  });

  it("rate-limits concurrent tactical clears before excess room calls", async () => {
    const grant = agentBroker.createGrant({
      roomId: "ROOM123",
      ownerId: "owner-clear-limit",
      seatId: "seat-clear-limit",
      roomMode: "open_ffa",
      controlMode: "tactical_reflex_v1",
      openingTactic: TACTICAL_OPENING,
      agentName: "Clear Guard",
      archetype: "nova",
      sourceKey: "test:clear-limit"
    });
    const credential = (await agentBroker.consumeGrant(
      {
        roomId: "ROOM123",
        grantCredential: grant.grantCredential,
        sourceKey: "test:clear-limit"
      },
      () => ({})
    )).brokerCredential;
    const callsBefore = remoteRoomCall.mock.calls.length;
    const responses = await Promise.all(Array.from({ length: 5 }, () =>
      fetch(`${origin}/agent/rooms/ROOM123/tactical-intent`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${credential}` }
      })
    ));

    expect(responses.filter((response) => response.status === 200)).toHaveLength(4);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
    expect(remoteRoomCall.mock.calls.slice(callsBefore).filter(
      ([, method]) => method === "agentClearTacticalIntent"
    )).toHaveLength(4);
    expect(await responses.find((response) => response.status === 429)?.json()).toEqual({
      version: 1,
      ok: false,
      error: { code: "rate_limited" }
    });
    agentBroker.releaseControl(credential, "ROOM123");
  });

  it("does not disclose whether a syntactically valid broker credential belongs to another room", async () => {
    const callsBefore = remoteRoomCall.mock.calls.length;
    const responses = await Promise.all([
      fetch(`${origin}/agent/rooms/ROOM999/status`, {
        headers: { Authorization: `Bearer ${brokerCredential}` }
      }),
      fetch(`${origin}/agent/rooms/ROOM123/status`, {
        headers: { Authorization: `Bearer ${"A".repeat(43)}` }
      })
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        version: 1,
        ok: false,
        error: { code: "agent_revoked" }
      });
    }
    expect(remoteRoomCall.mock.calls).toHaveLength(callsBefore);
  });

  it("does not disclose whether a grant credential belongs to another room", async () => {
    const grant = agentBroker.createGrant({
      roomId: "ROOM123",
      ownerId: "owner-grant-oracle",
      seatId: "seat-grant-oracle",
      roomMode: "open_ffa",
      agentName: "Grant Guard",
      archetype: "nova",
      sourceKey: "test:grant-oracle"
    });
    const callsBefore = remoteRoomCall.mock.calls.length;
    const responses = await Promise.all([
      fetch(`${origin}/agent/rooms/ROOM999/grants/consume`, {
        method: "POST",
        headers: { Authorization: `Bearer ${grant.grantCredential}` }
      }),
      fetch(`${origin}/agent/rooms/ROOM123/grants/consume`, {
        method: "POST",
        headers: { Authorization: `Bearer ${"A".repeat(43)}` }
      })
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        version: 1,
        ok: false,
        error: { code: "grant_expired" }
      });
    }
    expect(remoteRoomCall.mock.calls).toHaveLength(callsBefore);
    agentBroker.cancelGrant(grant.requestId, { roomId: "ROOM123", ownerId: "owner-grant-oracle" });
  });

  it("rejects bodies on bodyless agent routes before authorization or room work", async () => {
    const grant = agentBroker.createGrant({
      roomId: "ROOM123",
      ownerId: "owner-body-guard",
      seatId: "seat-body-guard",
      roomMode: "open_ffa",
      agentName: "Body Guard",
      archetype: "nova",
      sourceKey: "test:body-guard"
    });
    const callsBefore = remoteRoomCall.mock.calls.length;
    const payload = "x".repeat(4_096);
    for (const [path, method, credential] of [
      ["/agent/rooms/ROOM123/grants/consume", "POST", grant.grantCredential],
      ["/agent/rooms/ROOM123/heartbeat", "POST", brokerCredential],
      ["/agent/rooms/ROOM123/control", "DELETE", brokerCredential]
    ] as const) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "text/plain"
        },
        body: payload
      });
      expect(response.status).toBe(413);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        version: 1,
        ok: false,
        error: { code: "lease_invalid" }
      });
    }
    expect(remoteRoomCall.mock.calls).toHaveLength(callsBefore);
    expect(agentBroker.authorize({
      roomId: "ROOM123",
      brokerCredential,
      requiredScope: "agent:observe"
    })).toBeDefined();
    agentBroker.cancelGrant(grant.requestId, { roomId: "ROOM123", ownerId: "owner-body-guard" });
  });

  it("accepts zero-length framing with leading zeros on bodyless routes", async () => {
    const callsBefore = remoteRoomCall.mock.calls.length;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${origin}/agent/rooms/ROOM123/status`, {
        headers: {
          Authorization: `Bearer ${brokerCredential}`,
          "Content-Length": "00"
        }
      }, (res) => {
        res.once("error", reject);
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
      });
      req.once("error", reject);
      req.end();
    });
    expect(status).toBe(200);
    expect(remoteRoomCall.mock.calls).toHaveLength(callsBefore + 1);
  });

  afterAll(async () => {
    try {
      agentBroker.releaseControl(brokerCredential, "ROOM123");
    } catch {
      // The focused route test may already have expired during a slow suite.
    }
    try {
      agentBroker.releaseControl(tacticalBrokerCredential, "ROOM123");
    } catch {
      // A focused route test may already have expired during a slow suite.
    }
    remoteRoomCall.mockClear();
    transportState.leaseActive = false;
    vi.restoreAllMocks();
    httpServer?.closeAllConnections();
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    vi.unstubAllEnvs();
  });

  const assertFailClosed = async (
    invalidRequest: RequestInit,
    expectedStatus: number,
    actionPath = "/agent/rooms/ROOM123/action"
  ) => {
    const headers = {
      Authorization: `Bearer ${brokerCredential}`,
      "Content-Type": "application/json"
    };
    const callsBefore = remoteRoomCall.mock.calls.length;
    const response = await fetch(`${origin}${actionPath}`, {
      method: "POST",
      headers,
      ...invalidRequest
    });
    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      version: 1,
      ok: false,
      error: { code: "lease_invalid" }
    });
    expect(remoteRoomCall.mock.calls).toHaveLength(callsBefore + 1);
    const rejectionCall = remoteRoomCall.mock.calls.at(-1);
    expect(rejectionCall?.[1]).toBe("agentAct");
    expect((rejectionCall?.[2] as unknown[])[1]).toBeUndefined();
  };

  it("neutralizes authenticated macros for invalid transport and the first action-limit rejection", async () => {
    await assertFailClosed({
      headers: {
        Authorization: `Bearer ${brokerCredential}`,
        "Content-Type": "text/plain"
      },
      body: "not-json"
    }, 415);
    await assertFailClosed({ body: "{" }, 400);
    await assertFailClosed({ body: JSON.stringify({ padding: "x".repeat(2_100) }) }, 413);

    const accepted = await fetch(`${origin}/agent/rooms/ROOM123/action`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${brokerCredential}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        version: 1,
        actionSeq: 1,
        basedOnObservationSeq: 1,
        leaseMs: 500,
        waypoints: [],
        fire: "none",
        useAbility: false
      })
    });
    expect(accepted.status).toBe(200);
    expect(transportState.leaseActive).toBe(true);

    const callsBeforeLimit = remoteRoomCall.mock.calls.length;
    const limited = await fetch(`${origin}/agent/rooms/ROOM123/action`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${brokerCredential}`,
        "Content-Type": "application/json"
      },
      body: "{"
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      version: 1,
      ok: false,
      error: { code: "rate_limited" }
    });
    expect(remoteRoomCall.mock.calls).toHaveLength(callsBeforeLimit + 1);
    expect((remoteRoomCall.mock.calls.at(-1)?.[2] as unknown[])[1]).toBeUndefined();
    expect((remoteRoomCall.mock.calls.at(-1)?.[2] as unknown[])[4]).toBe("rate_limited");
    expect(transportState.leaseActive).toBe(false);

    const callsBeforeRepeat = remoteRoomCall.mock.calls.length;
    const repeated = await fetch(`${origin}/agent/rooms/ROOM123/action`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${brokerCredential}`,
        "Content-Type": "application/json"
      },
      body: "{"
    });
    expect(repeated.status).toBe(429);
    expect(remoteRoomCall.mock.calls).toHaveLength(callsBeforeRepeat);

    vi.mocked(Date.now).mockReturnValue(Date.now() + 1_000);
    await assertFailClosed({
      headers: {
        Authorization: `Bearer ${brokerCredential}`,
        "Content-Type": "application/json; charset=iso-8859-1"
      },
      body: "{}"
    }, 415);
    await assertFailClosed({
      headers: {
        Authorization: `Bearer ${brokerCredential}`,
        "Content-Type": "application/json",
        "Content-Encoding": "unsupported"
      },
      body: "{}"
    }, 415);
    await assertFailClosed({ body: "{" }, 400, "/AGENT/ROOMS/ROOM123/ACTION");
    await assertFailClosed({ body: "{" }, 400, "/agent/rooms/%52OOM123/action");
  });
});
