import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  AGENT_ACTION_MAX_LEASE_MS,
  AGENT_CONTROL_IDLE_TIMEOUT_MS,
  AGENT_CONTROL_SCOPES,
  AGENT_GRANT_TTL_MS as SHARED_AGENT_GRANT_TTL_MS,
  parseAgentTacticalIntentV1,
  type AgentControlMode,
  type AgentControlScope,
  type AgentTacticalIntentV1,
  type RoomMode
} from "@alpha7/shared";

export const AGENT_GRANT_TTL_MS = SHARED_AGENT_GRANT_TTL_MS;
export const AGENT_BROKER_IDLE_TTL_MS = AGENT_CONTROL_IDLE_TIMEOUT_MS;

export const AGENT_BROKER_SCOPES = AGENT_CONTROL_SCOPES;

export type AgentBrokerScope = AgentControlScope;
export type AgentRoomMode = Exclude<RoomMode, "classic">;

export type AgentBrokerErrorCode =
  | "rate_limited"
  | "match_not_active"
  | "agent_paused"
  | "owner_unavailable"
  | "pending_exists"
  | "seat_reserved"
  | "control_exists"
  | "grant_invalid"
  | "grant_expired"
  | "grant_consumed"
  | "grant_cancelled"
  | "principal_mismatch"
  | "broker_invalid"
  | "broker_expired"
  | "broker_paused"
  | "scope_denied"
  | "control_not_found";

export class AgentBrokerError extends Error {
  readonly code: AgentBrokerErrorCode;

  constructor(code: AgentBrokerErrorCode) {
    super(code);
    this.name = "AgentBrokerError";
    this.code = code;
  }
}

export interface FixedWindowRateLimit {
  limit: number;
  windowMs: number;
  retentionMs?: number;
}

interface FixedWindowRecord {
  count: number;
  resetsAtMs: number;
  retainedUntilMs: number;
  rejectionHandled: boolean;
}

export class FixedWindowRateLimiter {
  readonly #windows = new Map<string, FixedWindowRecord>();

  constructor(private readonly maxEntries = 4_096) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive safe integer");
    }
  }

  tryTake(
    key: string,
    policy: FixedWindowRateLimit,
    nowMs = Date.now(),
    onFirstRejection?: () => void
  ): boolean {
    if (!key) throw new TypeError("rate-limit key is required");
    if (!Number.isSafeInteger(policy.limit) || policy.limit < 1) {
      throw new TypeError("rate-limit limit must be a positive safe integer");
    }
    if (!Number.isFinite(policy.windowMs) || policy.windowMs <= 0) {
      throw new TypeError("rate-limit windowMs must be positive");
    }
    if (policy.retentionMs !== undefined && (
      !Number.isFinite(policy.retentionMs) || policy.retentionMs < policy.windowMs
    )) {
      throw new TypeError("rate-limit retentionMs must cover windowMs");
    }

    const existing = this.#windows.get(key);
    if (existing && nowMs < existing.resetsAtMs) {
      if (existing.count >= policy.limit) {
        if (!existing.rejectionHandled) {
          existing.rejectionHandled = true;
          onFirstRejection?.();
        }
        return false;
      }
      existing.count += 1;
      return true;
    }

    if (!existing && this.#windows.size >= this.maxEntries) {
      this.prune(nowMs);
      if (this.#windows.size >= this.maxEntries) return false;
    }

    this.#windows.set(key, {
      count: 1,
      resetsAtMs: nowMs + policy.windowMs,
      retainedUntilMs: nowMs + (policy.retentionMs ?? policy.windowMs),
      rejectionHandled: false
    });
    return true;
  }

  prune(nowMs = Date.now()): void {
    for (const [key, window] of this.#windows) {
      if (nowMs >= window.retainedUntilMs) this.#windows.delete(key);
    }
  }

  get retainedBucketCount(): number {
    return this.#windows.size;
  }
}

export interface AgentGrantBinding {
  roomId: string;
  ownerId: string;
  seatId: string;
  roomMode: AgentRoomMode;
  agentName: string;
  archetype: string;
  controlMode?: AgentControlMode;
  openingTactic?: AgentTacticalIntentV1;
  scopes?: readonly AgentBrokerScope[];
}

export interface CreateAgentGrantInput extends AgentGrantBinding {
  sourceKey: string;
}

export interface CreatedAgentGrant {
  requestId: string;
  grantCredential: string;
  expiresAtMs: number;
}

export interface AgentControlPrincipal {
  controlId: string;
  requestId: string;
  roomId: string;
  ownerId: string;
  seatId: string;
  roomMode: AgentRoomMode;
  track: "custom";
  role: "combatant";
  agentName: string;
  archetype: string;
  controlMode: AgentControlMode;
  openingTactic?: AgentTacticalIntentV1;
  scopes: readonly AgentBrokerScope[];
  issuedAtMs: number;
}

export interface AgentBrokerSession {
  principal: AgentControlPrincipal;
  paused: boolean;
  revision: number;
  issuedAtMs: number;
  lastUsedAtMs: number;
  idleDeadlineMs: number;
}

export type AgentHttpOperation = "observation" | "action" | "status" | "heartbeat";

const AGENT_HTTP_RATE_LIMITS: Record<AgentHttpOperation, FixedWindowRateLimit> = {
  observation: { limit: 4, windowMs: 1_000 },
  action: {
    limit: 4,
    windowMs: 1_000,
    retentionMs: AGENT_ACTION_MAX_LEASE_MS + 2_000
  },
  status: { limit: 4, windowMs: 1_000 },
  heartbeat: { limit: 6, windowMs: 10_000 }
};

export const runRateLimitedAgentCall = <T>(
  limiter: FixedWindowRateLimiter,
  controlId: string,
  operation: AgentHttpOperation,
  call: () => T,
  nowMs = Date.now(),
  onFirstRejection?: () => void
): T => {
  if (!limiter.tryTake(
    `agent:http:${controlId}:${operation}`,
    AGENT_HTTP_RATE_LIMITS[operation],
    nowMs,
    onFirstRejection
  )) {
    throw new AgentBrokerError("rate_limited");
  }
  return call();
};

export interface ConsumeAgentGrantInput {
  roomId: string;
  grantCredential: string;
  sourceKey: string;
}

export interface ConsumedAgentGrant<TMaterialized> {
  brokerCredential: string;
  session: AgentBrokerSession;
  materialized: TMaterialized;
}

export interface AuthorizeAgentControlInput {
  brokerCredential: string;
  roomId: string;
  requiredScope: AgentBrokerScope;
  ownerId?: string;
  seatId?: string;
  allowPaused?: boolean;
}

export interface AgentControlBinding {
  roomId: string;
  ownerId: string;
  seatId: string;
}

export interface ExpiredAgentBrokerState {
  expiredGrantRequestIds: string[];
  expiredControls: AgentControlPrincipal[];
}

export interface AgentBrokerOptions {
  grantTtlMs?: number;
  brokerIdleTtlMs?: number;
  grantCreateRateLimit?: FixedWindowRateLimit;
  grantCreateSourceRateLimit?: FixedWindowRateLimit;
  grantConsumeRateLimit?: FixedWindowRateLimit;
  rateLimiter?: FixedWindowRateLimiter;
}

interface PairingGrantRecord extends Omit<AgentGrantBinding, "controlMode" | "scopes"> {
  requestId: string;
  grantDigest: Buffer;
  controlMode: AgentControlMode;
  scopes: readonly AgentBrokerScope[];
  createdAtMs: number;
  expiresAtMs: number;
  consumedAtMs?: number;
  cancelledAtMs?: number;
  expiredAtMs?: number;
}

interface BrokerSessionRecord extends AgentControlPrincipal {
  credentialDigest: Buffer;
  paused: boolean;
  revision: number;
  lastUsedAtMs: number;
  idleDeadlineMs: number;
}

const DEFAULT_CREATE_RATE_LIMIT: FixedWindowRateLimit = {
  limit: 3,
  windowMs: 60_000
};

const DEFAULT_CREATE_SOURCE_RATE_LIMIT: FixedWindowRateLimit = {
  limit: 16,
  windowMs: 60_000
};

const DEFAULT_CONSUME_RATE_LIMIT: FixedWindowRateLimit = {
  limit: 10,
  windowMs: 60_000
};

const VALID_SCOPES = new Set<AgentBrokerScope>(AGENT_BROKER_SCOPES);
const TERMINAL_GRANT_RETENTION_MS = 60_000;

const secretDigest = (secret: string): Buffer =>
  createHash("sha256").update(secret, "utf8").digest();

const secretsMatch = (candidateDigest: Buffer, storedDigest: Buffer): boolean =>
  candidateDigest.length === storedDigest.length && timingSafeEqual(candidateDigest, storedDigest);

const newOpaqueSecret = (): string => randomBytes(32).toString("base64url");
const newOpaqueId = (): string => randomBytes(16).toString("base64url");

const requireNonEmpty = (value: string, field: string): void => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
};

const validateDuration = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
};

const normalizeScopes = (
  requested: readonly AgentBrokerScope[] | undefined,
  controlMode: AgentControlMode
): readonly AgentBrokerScope[] => {
  const forbiddenWriterScope = controlMode === "macro_v1" ? "agent:tactic" : "agent:act";
  const scopes = requested ?? AGENT_BROKER_SCOPES.filter((scope) => scope !== forbiddenWriterScope);
  const unique: AgentBrokerScope[] = [];
  for (const scope of scopes) {
    if (!VALID_SCOPES.has(scope)) throw new TypeError("invalid agent broker scope");
    if (!unique.includes(scope)) unique.push(scope);
  }
  if (unique.length === 0) throw new TypeError("at least one agent broker scope is required");
  if (unique.includes(forbiddenWriterScope)) throw new TypeError("control mode scope mismatch");
  return Object.freeze(unique);
};

const copyPrincipal = (record: AgentControlPrincipal): AgentControlPrincipal => ({
  controlId: record.controlId,
  requestId: record.requestId,
  roomId: record.roomId,
  ownerId: record.ownerId,
  seatId: record.seatId,
  roomMode: record.roomMode,
  track: "custom",
  role: "combatant",
  agentName: record.agentName,
  archetype: record.archetype,
  controlMode: record.controlMode,
  ...(record.openingTactic ? { openingTactic: structuredClone(record.openingTactic) } : {}),
  scopes: [...record.scopes],
  issuedAtMs: record.issuedAtMs
});

const sessionSnapshot = (record: BrokerSessionRecord): AgentBrokerSession => ({
  principal: copyPrincipal(record),
  paused: record.paused,
  revision: record.revision,
  issuedAtMs: record.issuedAtMs,
  lastUsedAtMs: record.lastUsedAtMs,
  idleDeadlineMs: record.idleDeadlineMs
});

export class AgentBroker {
  readonly #grants = new Map<string, PairingGrantRecord>();
  readonly #sessions = new Map<string, BrokerSessionRecord>();
  readonly #sessionsByCredentialDigest = new Map<string, BrokerSessionRecord>();
  readonly #materializingOwners = new Set<string>();
  readonly #materializingSeats = new Set<string>();
  readonly #grantTtlMs: number;
  readonly #brokerIdleTtlMs: number;
  readonly #grantCreateRateLimit: FixedWindowRateLimit;
  readonly #grantCreateSourceRateLimit: FixedWindowRateLimit;
  readonly #grantConsumeRateLimit: FixedWindowRateLimit;
  readonly #rateLimiter: FixedWindowRateLimiter;

  constructor(options: AgentBrokerOptions = {}) {
    this.#grantTtlMs = options.grantTtlMs ?? AGENT_GRANT_TTL_MS;
    this.#brokerIdleTtlMs = options.brokerIdleTtlMs ?? AGENT_BROKER_IDLE_TTL_MS;
    this.#grantCreateRateLimit = options.grantCreateRateLimit ?? DEFAULT_CREATE_RATE_LIMIT;
    this.#grantCreateSourceRateLimit =
      options.grantCreateSourceRateLimit ??
      options.grantCreateRateLimit ??
      DEFAULT_CREATE_SOURCE_RATE_LIMIT;
    this.#grantConsumeRateLimit = options.grantConsumeRateLimit ?? DEFAULT_CONSUME_RATE_LIMIT;
    this.#rateLimiter = options.rateLimiter ?? new FixedWindowRateLimiter();

    validateDuration(this.#grantTtlMs, "grantTtlMs");
    validateDuration(this.#brokerIdleTtlMs, "brokerIdleTtlMs");
  }

  createGrant(input: CreateAgentGrantInput, nowMs = Date.now()): CreatedAgentGrant {
    const { controlMode, openingTactic, scopes } = this.#validateGrantBinding(input);
    requireNonEmpty(input.sourceKey, "sourceKey");
    this.#takeRateLimit(`grant:create:owner:${input.ownerId}`, input.sourceKey, "create", nowMs);

    if (this.#materializingOwners.has(input.ownerId)) {
      throw new AgentBrokerError("pending_exists");
    }
    if (this.#materializingSeats.has(input.seatId)) {
      throw new AgentBrokerError("seat_reserved");
    }
    for (const grant of this.#grants.values()) {
      if (this.#isPendingGrant(grant, nowMs) && grant.ownerId === input.ownerId) {
        throw new AgentBrokerError("pending_exists");
      }
      if (this.#isPendingGrant(grant, nowMs) && grant.seatId === input.seatId) {
        throw new AgentBrokerError("seat_reserved");
      }
    }
    for (const session of this.#sessions.values()) {
      if (session.ownerId === input.ownerId) throw new AgentBrokerError("control_exists");
      if (session.seatId === input.seatId) throw new AgentBrokerError("seat_reserved");
    }

    const requestId = this.#uniqueId(this.#grants);
    const grantCredential = newOpaqueSecret();
    this.#grants.set(requestId, {
      requestId,
      grantDigest: secretDigest(grantCredential),
      roomId: input.roomId,
      ownerId: input.ownerId,
      seatId: input.seatId,
      roomMode: input.roomMode,
      agentName: input.agentName,
      archetype: input.archetype,
      controlMode,
      ...(openingTactic ? { openingTactic } : {}),
      scopes,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.#grantTtlMs
    } as PairingGrantRecord);

    return {
      requestId,
      grantCredential,
      expiresAtMs: nowMs + this.#grantTtlMs
    };
  }

  cancelGrant(requestId: string, binding: Pick<AgentControlBinding, "roomId" | "ownerId">, nowMs = Date.now()): void {
    const grant = this.#grants.get(requestId);
    if (!grant) throw new AgentBrokerError("grant_invalid");
    if (grant.roomId !== binding.roomId || grant.ownerId !== binding.ownerId) {
      throw new AgentBrokerError("principal_mismatch");
    }
    if (grant.consumedAtMs !== undefined) throw new AgentBrokerError("grant_consumed");
    if (grant.cancelledAtMs !== undefined) throw new AgentBrokerError("grant_cancelled");
    if (
      grant.expiredAtMs !== undefined ||
      (nowMs >= grant.expiresAtMs &&
        !this.#materializingOwners.has(grant.ownerId) &&
        !this.#materializingSeats.has(grant.seatId))
    ) {
      throw new AgentBrokerError("grant_expired");
    }
    grant.cancelledAtMs = nowMs;
  }

  async consumeGrant<TMaterialized>(
    input: ConsumeAgentGrantInput,
    materialize: (principal: AgentControlPrincipal) => TMaterialized | Promise<TMaterialized>,
    nowMs = Date.now()
  ): Promise<ConsumedAgentGrant<TMaterialized>> {
    requireNonEmpty(input.roomId, "roomId");
    requireNonEmpty(input.sourceKey, "sourceKey");
    if (typeof input.grantCredential !== "string") {
      throw new AgentBrokerError("grant_invalid");
    }
    if (!this.#rateLimiter.tryTake(
      `grant:consume:source:${input.sourceKey}`,
      this.#grantConsumeRateLimit,
      nowMs
    )) {
      throw new AgentBrokerError("rate_limited");
    }

    const grant = this.#findGrant(input.grantCredential);
    if (!grant) throw new AgentBrokerError("grant_invalid");
    if (grant.roomId !== input.roomId) throw new AgentBrokerError("grant_invalid");
    if (!this.#rateLimiter.tryTake(
      `grant:consume:owner:${grant.ownerId}`,
      this.#grantConsumeRateLimit,
      nowMs
    )) {
      throw new AgentBrokerError("rate_limited");
    }
    if (grant.consumedAtMs !== undefined) throw new AgentBrokerError("grant_consumed");
    if (grant.cancelledAtMs !== undefined) throw new AgentBrokerError("grant_cancelled");
    if (grant.expiredAtMs !== undefined || nowMs >= grant.expiresAtMs) {
      throw new AgentBrokerError("grant_expired");
    }
    if (this.#materializingOwners.has(grant.ownerId) || this.#materializingSeats.has(grant.seatId)) {
      throw new AgentBrokerError("grant_consumed");
    }
    if (this.#hasControl(grant.ownerId, grant.seatId)) {
      throw new AgentBrokerError("control_exists");
    }

    this.#materializingOwners.add(grant.ownerId);
    this.#materializingSeats.add(grant.seatId);

    const controlId = this.#uniqueId(this.#sessions);
    const principal: AgentControlPrincipal = {
      controlId,
      requestId: grant.requestId,
      roomId: grant.roomId,
      ownerId: grant.ownerId,
      seatId: grant.seatId,
      roomMode: grant.roomMode,
      track: "custom",
      role: "combatant",
      agentName: grant.agentName,
      archetype: grant.archetype,
      controlMode: grant.controlMode,
      ...(grant.openingTactic ? { openingTactic: structuredClone(grant.openingTactic) } : {}),
      scopes: [...grant.scopes],
      issuedAtMs: nowMs
    };

    try {
      const materialized = await materialize(copyPrincipal(principal));
      if (grant.cancelledAtMs !== undefined) throw new AgentBrokerError("grant_cancelled");
      const brokerCredential = newOpaqueSecret();
      const record: BrokerSessionRecord = {
        ...principal,
        scopes: [...principal.scopes],
        credentialDigest: secretDigest(brokerCredential),
        paused: false,
        revision: 0,
        lastUsedAtMs: nowMs,
        idleDeadlineMs: nowMs + this.#brokerIdleTtlMs
      };
      this.#sessions.set(controlId, record);
      this.#sessionsByCredentialDigest.set(record.credentialDigest.toString("base64url"), record);
      grant.consumedAtMs = nowMs;
      return {
        brokerCredential,
        session: sessionSnapshot(record),
        materialized
      };
    } finally {
      this.#materializingOwners.delete(grant.ownerId);
      this.#materializingSeats.delete(grant.seatId);
    }
  }

  authorize(input: AuthorizeAgentControlInput, nowMs = Date.now()): AgentBrokerSession {
    if (typeof input.brokerCredential !== "string") {
      throw new AgentBrokerError("broker_invalid");
    }
    const record = this.#findSession(input.brokerCredential);
    if (!record) throw new AgentBrokerError("broker_invalid");
    if (
      record.roomId !== input.roomId ||
      (input.ownerId !== undefined && record.ownerId !== input.ownerId) ||
      (input.seatId !== undefined && record.seatId !== input.seatId)
    ) {
      throw new AgentBrokerError("principal_mismatch");
    }
    if (nowMs >= record.idleDeadlineMs) throw new AgentBrokerError("broker_expired");
    if (!record.scopes.includes(input.requiredScope)) throw new AgentBrokerError("scope_denied");
    if (record.paused && !input.allowPaused) throw new AgentBrokerError("broker_paused");

    record.lastUsedAtMs = nowMs;
    return sessionSnapshot(record);
  }

  heartbeat(
    brokerCredential: string,
    roomId: string,
    nowMs = Date.now()
  ): AgentBrokerSession {
    const record = this.#authorizeRecord(
      {
        brokerCredential,
        roomId,
        requiredScope: "agent:heartbeat",
        allowPaused: true
      },
      nowMs
    );
    record.lastUsedAtMs = nowMs;
    record.idleDeadlineMs = nowMs + this.#brokerIdleTtlMs;
    return sessionSnapshot(record);
  }

  claimExpiredControl(
    binding: AgentControlBinding,
    nowMs = Date.now()
  ):
    | { state: "active"; session: AgentBrokerSession }
    | { state: "expired"; principal: AgentControlPrincipal }
    | { state: "missing" } {
    const record = this.#findSessionByBinding(binding);
    if (!record) return { state: "missing" };
    if (nowMs < record.idleDeadlineMs) {
      return { state: "active", session: sessionSnapshot(record) };
    }
    this.#deleteSession(record);
    return { state: "expired", principal: copyPrincipal(record) };
  }

  setPaused(binding: AgentControlBinding, paused: boolean, nowMs = Date.now()): AgentBrokerSession {
    const record = this.#findSessionByBinding(binding);
    if (!record) throw new AgentBrokerError("control_not_found");
    if (nowMs >= record.idleDeadlineMs) throw new AgentBrokerError("broker_expired");
    record.paused = paused;
    record.revision += 1;
    return sessionSnapshot(record);
  }

  revokeControl(binding: AgentControlBinding): AgentControlPrincipal {
    const record = this.#findSessionByBinding(binding);
    if (!record) throw new AgentBrokerError("control_not_found");
    this.#deleteSession(record);
    return copyPrincipal(record);
  }

  releaseControl(
    brokerCredential: string,
    roomId: string,
    nowMs = Date.now()
  ): AgentControlPrincipal {
    const record = this.#authorizeRecord(
      {
        brokerCredential,
        roomId,
        requiredScope: "agent:release",
        allowPaused: true
      },
      nowMs
    );
    this.#deleteSession(record);
    return copyPrincipal(record);
  }

  sweepExpired(nowMs = Date.now()): ExpiredAgentBrokerState {
    const expiredGrantRequestIds = this.#expireGrants(nowMs);
    const expiredControls: AgentControlPrincipal[] = [];
    for (const session of this.#sessions.values()) {
      if (nowMs < session.idleDeadlineMs) continue;
      this.#deleteSession(session);
      expiredControls.push(copyPrincipal(session));
    }
    this.#rateLimiter.prune(nowMs);
    return { expiredGrantRequestIds, expiredControls };
  }

  get activeControlCount(): number {
    return this.#sessions.size;
  }

  get retainedGrantCount(): number {
    return this.#grants.size;
  }

  get retainedRateBucketCount(): number {
    return this.#rateLimiter.retainedBucketCount;
  }

  get pendingGrantCount(): number {
    let count = 0;
    for (const grant of this.#grants.values()) {
      if (this.#isPendingGrant(grant, Date.now())) count += 1;
    }
    return count;
  }

  #authorizeRecord(input: AuthorizeAgentControlInput, nowMs: number): BrokerSessionRecord {
    const session = this.authorize(input, nowMs);
    const record = this.#sessions.get(session.principal.controlId);
    if (!record) throw new AgentBrokerError("broker_invalid");
    return record;
  }

  #findGrant(grantCredential: string): PairingGrantRecord | undefined {
    const candidateDigest = secretDigest(grantCredential);
    let match: PairingGrantRecord | undefined;
    for (const grant of this.#grants.values()) {
      if (secretsMatch(candidateDigest, grant.grantDigest)) match = grant;
    }
    return match;
  }

  #findSession(brokerCredential: string): BrokerSessionRecord | undefined {
    const candidateDigest = secretDigest(brokerCredential);
    const match = this.#sessionsByCredentialDigest.get(candidateDigest.toString("base64url"));
    return match && secretsMatch(candidateDigest, match.credentialDigest) ? match : undefined;
  }

  #deleteSession(record: BrokerSessionRecord): void {
    this.#sessions.delete(record.controlId);
    this.#sessionsByCredentialDigest.delete(record.credentialDigest.toString("base64url"));
  }

  #findSessionByBinding(binding: AgentControlBinding): BrokerSessionRecord | undefined {
    for (const session of this.#sessions.values()) {
      if (
        session.roomId === binding.roomId &&
        session.ownerId === binding.ownerId &&
        session.seatId === binding.seatId
      ) {
        return session;
      }
    }
    return undefined;
  }

  #hasControl(ownerId: string, seatId: string): boolean {
    for (const session of this.#sessions.values()) {
      if (session.ownerId === ownerId || session.seatId === seatId) return true;
    }
    return false;
  }

  #expireGrants(nowMs: number): string[] {
    const expiredRequestIds: string[] = [];
    for (const [requestId, grant] of this.#grants) {
      if (
        grant.consumedAtMs === undefined &&
        grant.cancelledAtMs === undefined &&
        grant.expiredAtMs === undefined &&
        !this.#materializingOwners.has(grant.ownerId) &&
        !this.#materializingSeats.has(grant.seatId) &&
        nowMs >= grant.expiresAtMs
      ) {
        grant.expiredAtMs = nowMs;
        expiredRequestIds.push(requestId);
      }

      const terminalAtMs =
        grant.consumedAtMs ??
        grant.cancelledAtMs ??
        (grant.expiredAtMs === undefined ? undefined : grant.expiresAtMs);
      if (terminalAtMs !== undefined && nowMs >= terminalAtMs + TERMINAL_GRANT_RETENTION_MS) {
        this.#grants.delete(requestId);
      }
    }
    return expiredRequestIds;
  }

  #isPendingGrant(grant: PairingGrantRecord, nowMs: number): boolean {
    return (
      grant.consumedAtMs === undefined &&
      grant.cancelledAtMs === undefined &&
      grant.expiredAtMs === undefined &&
      nowMs < grant.expiresAtMs
    );
  }

  #takeRateLimit(ownerKey: string, sourceKey: string, operation: "create", nowMs: number): void {
    const sourceAllowed = this.#rateLimiter.tryTake(
      `grant:${operation}:source:${sourceKey}`,
      this.#grantCreateSourceRateLimit,
      nowMs
    );
    const ownerAllowed = sourceAllowed && this.#rateLimiter.tryTake(
      ownerKey,
      this.#grantCreateRateLimit,
      nowMs
    );
    if (!ownerAllowed || !sourceAllowed) throw new AgentBrokerError("rate_limited");
  }

  #validateGrantBinding(binding: AgentGrantBinding): {
    controlMode: AgentControlMode;
    openingTactic?: AgentTacticalIntentV1;
    scopes: readonly AgentBrokerScope[];
  } {
    requireNonEmpty(binding.roomId, "roomId");
    requireNonEmpty(binding.ownerId, "ownerId");
    requireNonEmpty(binding.seatId, "seatId");
    requireNonEmpty(binding.agentName, "agentName");
    requireNonEmpty(binding.archetype, "archetype");
    if (!["wingman", "open_ffa", "agent_cup"].includes(binding.roomMode)) {
      throw new TypeError("invalid agent room mode");
    }
    const controlMode = binding.controlMode ?? "macro_v1";
    if (controlMode !== "macro_v1" && controlMode !== "tactical_reflex_v1") {
      throw new TypeError("invalid agent control mode");
    }
    const parsedOpening = binding.openingTactic === undefined
      ? undefined
      : parseAgentTacticalIntentV1(binding.openingTactic);
    if (
      controlMode === "tactical_reflex_v1" && (
        !parsedOpening?.ok ||
        parsedOpening.value.intentSeq !== 1 ||
        parsedOpening.value.basedOnObservationSeq !== null ||
        parsedOpening.value.objective.type === "engage_target" ||
        parsedOpening.value.objective.type === "collect_pickup"
      )
    ) throw new TypeError("tactical grant requires a valid opening tactic");
    if (controlMode === "macro_v1" && binding.openingTactic !== undefined) {
      throw new TypeError("macro grant cannot include an opening tactic");
    }
    return {
      controlMode,
      ...(parsedOpening?.ok ? { openingTactic: parsedOpening.value } : {}),
      scopes: normalizeScopes(binding.scopes, controlMode)
    };
  }

  #uniqueId<T>(records: Map<string, T>): string {
    let id = newOpaqueId();
    while (records.has(id)) id = newOpaqueId();
    return id;
  }
}

export const agentBroker = new AgentBroker();
