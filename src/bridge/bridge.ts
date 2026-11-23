import { createHash, randomUUID } from "node:crypto";
import { type Clock, SystemClock } from "../core/clock.js";
import {
	encode,
	type GlassboxMessage,
	type HelloAckMsg,
	type HelloMsg,
	type PageToBridgeMsg,
	type PromptResultMsg,
	type ResourceResultMsg,
	type SamplingResultMsg,
	type ToolRegisterMsg,
	type ToolUnregisterMsg,
} from "../core/codec.js";
import { type CallToolResult, coerceError, coerceResult } from "../core/coerce.js";
import { GlassboxError, GlassboxErrorCode } from "../core/errors.js";
import {
	channelFrom,
	hostKeyOf,
	type ParsedBridgeName,
	parseBridgeToolName,
	toolName,
} from "../core/naming.js";
import type { NonceAuth } from "../core/nonce.js";
import { assertProtocolVersion, helloAck } from "../core/version.js";
import { type AuditConsent, type AuditEntry, type AuditSink, InMemoryAudit } from "./audit.js";
import { type CodeRecord, CodeStore, type MintedCode } from "./code.js";
import type { Link } from "./link.js";
import { defaultPolicy, type PolicyResolver } from "./policy.js";
import { nodeScheduler, type Scheduler } from "./scheduler.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CODE_TTL_MS = 60_000;
const DEFAULT_CONSENT_TIMEOUT_MS = 120_000;
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_HOST = "127.0.0.1";

export type Tier = "read" | "write" | "dangerous";

/** sha256 of the canonical JSON of args, first 16 hex chars (spec §7.5 argsHash). */
export function hashArgs(args: unknown): string {
	let canonical: string;
	try {
		canonical = JSON.stringify(args ?? {});
	} catch {
		canonical = String(args);
	}
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export interface ToolRegistration {
	/** Original app tool name, exactly as the page registered it (used in tool.call). */
	name: string;
	/** Sanitized identity (toolName(name)); the stable key within a channel. */
	sanitized: string;
	description: string;
	inputSchema?: unknown;
	tier: Tier;
	timeoutMs: number;
}

export interface ChannelAgg {
	channel: string;
	app: string;
	origin: string;
	tools: Map<string, ToolRegistration>;
	owners: Map<string, Set<string>>;
	sids: Set<string>;
	lastActive: number;
}

interface PendingCall {
	resolve: (r: CallToolResult) => void;
	traceId: string;
	toolName: string;
	channel: string;
	tier: Tier;
	startedAt: number;
	deadlineHandle: unknown;
	consent: AuditConsent;
	argsHash: string;
	client?: string;
	args?: unknown;
}

/** How a consent request settled. Only "approved" lets the tool call through. */
export type ConsentOutcome = "approved" | "denied" | "timeout" | "disconnected";

/** Why a non-approved call failed; surfaced in CONSENT_DENIED's message and audit detail. */
const CONSENT_NOT_GRANTED: Record<
	Exclude<ConsentOutcome, "approved">,
	{ detail: string; message: (tool: string) => string }
> = {
	denied: {
		detail: "consent denied by user",
		message: (tool) => `user denied consent for "${tool}"`,
	},
	timeout: {
		detail: "consent timed out",
		message: (tool) => `consent for "${tool}" timed out before the user answered`,
	},
	disconnected: {
		detail: "widget disconnected before consent",
		message: (tool) => `widget disconnected before consent was given for "${tool}"`,
	},
};

interface PendingConsent {
	resolve: (outcome: ConsentOutcome) => void;
	deadlineHandle: unknown;
	session: Session;
	traceId: string;
}

interface WireErrorResult {
	type: "error";
	code: string;
	message: string;
}

interface PendingReq {
	resolve: (m: PromptResultMsg | ResourceResultMsg | SamplingResultMsg | WireErrorResult) => void;
	deadlineHandle: unknown;
}

export interface Session {
	sid: string;
	sessionToken: string;
	app: string;
	origin: string;
	channel: string;
	tab: string;
	link: Link | null;
	expiresAt: number;
	inFlight: number;
	idleHandle: unknown;
	created: number;
	pendingCalls: Map<number, PendingCall>;
	pendingReqs: Map<number, PendingReq>;
}

export interface SessionView {
	sid: string;
	sessionToken: string;
	app: string;
	origin: string;
	channel: string;
	expiresMs: number;
}

export interface ChannelView {
	channel: string;
	app: string;
	origin: string;
	tabs: number;
	tools: string[];
	lastCalls: AuditEntry[];
}

export interface McpToolView {
	bridgeName: string;
	channel: string;
	appTool: string;
	description: string;
	inputSchema?: unknown;
	tier: Tier;
	timeoutMs: number;
}

export interface BridgeOptions {
	serverVersion: string;
	clock?: Clock;
	scheduler?: Scheduler;
	audit?: AuditSink;
	idleTtlMs?: number;
	codeTtlMs?: number;
	defaultTimeoutMs?: number;
	maxTimeoutMs?: number;
	protocolVersion?: string;
	/** Consent gate timeout (spec §7.3); clamped to the tool deadline if shorter. */
	consentTimeoutMs?: number;
	/** Policy resolver consulted per (appId, tier). Default: spec §7.3 (write=consent). */
	policy?: PolicyResolver;
	/** Principal label recorded in the audit for tool calls (default: "stdio"). */
	client?: string;
	/** Nonce enforcement for management endpoints (set by the CLI; null = off). */
	auth?: NonceAuth | null;
}

export class Bridge {
	readonly clock: Clock;
	readonly serverVersion: string;
	readonly auth: NonceAuth | null;
	readonly policy: PolicyResolver;
	private readonly scheduler: Scheduler;
	private readonly audit: AuditSink;
	private readonly idleTtlMs: number;
	private readonly codeTtlMs: number;
	private readonly defaultTimeoutMs: number;
	private readonly maxTimeoutMs: number;
	private readonly protocolVersion: string;
	private readonly consentTimeoutMs: number;
	readonly client: string;

	private sessions = new Map<string, Session>();
	private channels = new Map<string, ChannelAgg>();
	private codeStore: CodeStore;
	private host = DEFAULT_HOST;
	private port = 0;
	private nextId = 1;
	private closed = false;
	private pendingConsents = new Map<number, PendingConsent>();

	onToolsChanged?: () => void;

	constructor(opts: BridgeOptions) {
		this.serverVersion = opts.serverVersion;
		this.clock = opts.clock ?? new SystemClock();
		this.scheduler = opts.scheduler ?? nodeScheduler;
		this.audit = opts.audit ?? new InMemoryAudit();
		this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
		this.codeTtlMs = opts.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
		this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxTimeoutMs = opts.maxTimeoutMs ?? MAX_TIMEOUT_MS;
		this.protocolVersion = opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
		this.consentTimeoutMs = opts.consentTimeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS;
		this.policy = opts.policy ?? defaultPolicy;
		this.client = opts.client ?? "stdio";
		this.auth = opts.auth ?? null;
		this.codeStore = new CodeStore(() => this.clock.now(), this.codeTtlMs);
	}

	// ---------- endpoint & code minting ----------

	setEndpoint(host: string, port: number): void {
		this.host = host;
		this.port = port;
	}

	mintCode(opts?: { app?: string; origin?: string }): MintedCode {
		const app = opts?.app ?? "app";
		const origin = opts?.origin ?? `${this.host}:${this.port}`;
		const channel = channelFrom(origin);
		return this.codeStore.mint({ host: this.host, port: this.port, channel, app, origin });
	}

	// ---------- session lifecycle (spec §5.2) ----------

	issueSession(code: string, bodyOrigin?: string): SessionView {
		const rec: CodeRecord = this.codeStore.consume(code);
		// spec §5.2: codes are bound to origin + app — a page presenting a different
		// origin than the code was minted for is rejected with a typed error
		// (the code is one-shot, so a rejected exchange also consumes it).
		if (
			bodyOrigin !== undefined &&
			bodyOrigin !== "" &&
			hostKeyOf(bodyOrigin) !== hostKeyOf(rec.origin)
		) {
			throw new GlassboxError(
				GlassboxErrorCode.PROTOCOL_ERROR,
				`connect code is bound to origin ${rec.origin} (session exchange presents ${bodyOrigin})`,
			);
		}
		const sid = randomUUID();
		const now = this.clock.now();
		const session: Session = {
			sid,
			sessionToken: randomUUID(),
			app: rec.app,
			origin: rec.origin,
			channel: rec.channel,
			tab: "",
			link: null,
			expiresAt: now + this.idleTtlMs,
			inFlight: 0,
			idleHandle: undefined,
			created: now,
			pendingCalls: new Map(),
			pendingReqs: new Map(),
		};
		this.sessions.set(sid, session);
		this.addSidToChannel(rec.channel, rec.app, rec.origin, sid);
		this.record({
			ts: now,
			traceId: sid,
			channel: rec.channel,
			status: "session",
			detail: "created",
		});
		return this.view(session);
	}

	refreshSession(sid: string, sessionToken: string): SessionView {
		const s = this.sessions.get(sid);
		if (!s) throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "unknown session");
		if (s.sessionToken !== sessionToken) {
			throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "invalid session token");
		}
		s.expiresAt = this.clock.now() + this.idleTtlMs;
		this.record({
			ts: this.clock.now(),
			traceId: sid,
			channel: s.channel,
			status: "session",
			detail: "refreshed",
		});
		return this.view(s);
	}

	/** WS handshake: validate version + sid + origin binding, then return the ack (spec §5.1, §5.2). */
	hello(sid: string, m: HelloMsg): HelloAckMsg {
		assertProtocolVersion(m.v);
		const s = this.sessions.get(sid);
		if (!s) {
			throw new GlassboxError(
				GlassboxErrorCode.PROTOCOL_ERROR,
				`unknown session ${sid} (complete the code→session exchange first)`,
			);
		}
		if (hostKeyOf(m.origin) !== hostKeyOf(s.origin)) {
			throw new GlassboxError(
				GlassboxErrorCode.PROTOCOL_ERROR,
				`origin mismatch: session ${sid} is bound to ${s.origin} (hello presents ${m.origin})`,
			);
		}
		s.tab = m.tab;
		return { type: "hello.ack", ...helloAck(this.serverVersion, this.idleRemaining(s)) };
	}

	attach(sid: string, link: Link): void {
		const s = this.sessions.get(sid);
		if (!s) throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "unknown session");
		s.link = link;
		this.touchChannel(s.channel);
		this.resumeIdle(s);
	}

	detach(sid: string): void {
		const s = this.sessions.get(sid);
		if (!s) return;
		s.link = null;
		this.suspendIdle(s);
		this.abandonPending(s);
		this.pruneChannelOwners(s);
	}

	revoke(sid: string, reason: string, client?: string): void {
		const s = this.sessions.get(sid);
		if (!s) return;
		try {
			s.link?.send(encode({ type: "session.revoke", reason }));
		} catch {
			// socket may already be gone
		}
		s.link = null;
		this.suspendIdle(s);
		this.abandonPending(s);
		this.pruneChannelOwners(s);
		// Terminal (spec §5.2: immediate RST): a revoked session cannot be refreshed
		// back to life on reload and no longer appears in listSessions().
		this.sessions.delete(sid);
		this.record({
			ts: this.clock.now(),
			traceId: sid,
			channel: s.channel,
			status: "revoke",
			detail: reason,
			...(client !== undefined ? { client } : {}),
		});
	}

	/** Record a failed management-auth (impersonation) attempt (spec §7.2, §9.4). */
	recordImpersonation(detail: string): void {
		this.record({
			ts: this.clock.now(),
			traceId: `imp-${this.nextId++}`,
			status: "impersonation",
			client: "cli",
			detail,
		});
	}

	// ---------- page→bridge message routing (spec §5.8) ----------

	deliver(sid: string, msg: PageToBridgeMsg): void {
		const s = this.sessions.get(sid);
		if (!s || this.closed) return;
		switch (msg.type) {
			case "tool.register":
				this.registerTool(s, msg);
				return;
			case "tool.unregister":
				this.unregisterTool(s, msg);
				return;
			case "tool.result":
				this.resolveCall(s, msg);
				return;
			case "prompt.result":
			case "resource.result":
			case "sampling.result":
				this.resolveReq(s, msg);
				return;
			case "call.event":
				this.onCallEvent(s, msg.phase);
				return;
			case "consent.result":
				this.resolveConsent(msg.id, msg.decision === "approved" ? "approved" : "denied");
				return;
			case "session.revoke":
				// Page-initiated revocation (widget Disconnect): drop server-side (spec §5.2).
				this.revoke(s.sid, msg.reason, "page");
				return;
			default:
				return;
		}
	}

	// ---------- tool inventory ----------

	listTools(): McpToolView[] {
		const out: McpToolView[] = [];
		for (const ch of this.channels.values()) {
			if (this.liveSids(ch).length === 0) continue;
			for (const [sanitized, reg] of ch.tools) {
				out.push({
					bridgeName: `${ch.channel}__${sanitized}`,
					channel: ch.channel,
					appTool: reg.name,
					description: reg.description,
					...(reg.inputSchema !== undefined ? { inputSchema: reg.inputSchema } : {}),
					tier: reg.tier,
					timeoutMs: reg.timeoutMs,
				});
			}
		}
		return out.sort((a, b) => a.bridgeName.localeCompare(b.bridgeName));
	}

	// ---------- dispatch (bridge→page) ----------

	async callTool(
		bridgeName: string,
		args: Record<string, unknown> = {},
		opts?: { timeoutMs?: number },
	): Promise<CallToolResult> {
		let parsed: ParsedBridgeName;
		try {
			parsed = parseBridgeToolName(bridgeName);
		} catch {
			return coerceError(
				GlassboxErrorCode.PROTOCOL_ERROR,
				`not a glassbox tool name: ${bridgeName}`,
				`tr-${this.nextId++}`,
			);
		}
		const ch = this.channels.get(parsed.channel);
		const live = ch ? this.liveSids(ch) : [];
		if (!ch || live.length === 0) {
			return coerceError(
				GlassboxErrorCode.UNKNOWN_TOOL,
				`no live channel for ${parsed.channel}`,
				`tr-${this.nextId++}`,
			);
		}
		const reg = ch.tools.get(parsed.tool);
		if (!reg) {
			return coerceError(
				GlassboxErrorCode.UNKNOWN_TOOL,
				`no such tool: ${bridgeName}`,
				`tr-${this.nextId++}`,
			);
		}

		const deadlineMs = this.clampTimeout(opts?.timeoutMs ?? reg.timeoutMs);
		const id = this.nextId++;
		const traceId = `tr-${id}`;
		const session = this.pickSession(live);
		const startedAt = this.clock.now();
		const argsHash = hashArgs(args);
		const fullArgs = process.env.GLASSBOX_AUDIT_ARGS === "1" ? args : undefined;
		session.inFlight++;
		this.suspendIdle(session);

		// Policy gate (spec §7.3): deny → typed error, never reaches the page.
		const decision = this.policy.resolve(ch.app, reg.tier);
		if (decision === "deny") {
			this.releaseCall(session);
			this.record({
				ts: this.clock.now(),
				traceId,
				channel: ch.channel,
				tool: reg.name,
				tier: reg.tier,
				argsHash,
				client: this.client,
				consent: "denied",
				ms: this.clock.now() - startedAt,
				status: "error",
				detail: `policy denies ${reg.tier} tier`,
				...(fullArgs !== undefined ? { args: fullArgs } : {}),
			});
			return coerceError(
				GlassboxErrorCode.CONSENT_DENIED,
				`policy denies the ${reg.tier}-tier tool "${reg.name}"`,
				traceId,
			);
		}

		// Auto tier: dispatch immediately (synchronously, so deadlines schedule now).
		if (decision !== "consent") {
			return this.dispatchCall(session, ch, reg, args, {
				id,
				traceId,
				deadlineMs,
				startedAt,
				argsHash,
				fullArgs,
				consent: "auto",
			});
		}

		// Consent tier: gate on the widget, then dispatch. requestConsent() schedules
		// its own deadline synchronously; only the outcome is a microtask away.
		return this.requestConsent(session, reg, args, deadlineMs, traceId).then((consent) => {
			if (consent !== "approved") {
				const reason = CONSENT_NOT_GRANTED[consent];
				this.releaseCall(session);
				this.record({
					ts: this.clock.now(),
					traceId,
					channel: ch.channel,
					tool: reg.name,
					tier: reg.tier,
					argsHash,
					client: this.client,
					consent: "denied",
					ms: this.clock.now() - startedAt,
					status: "error",
					detail: reason.detail,
					...(fullArgs !== undefined ? { args: fullArgs } : {}),
				});
				return coerceError(GlassboxErrorCode.CONSENT_DENIED, reason.message(reg.name), traceId);
			}
			return this.dispatchCall(session, ch, reg, args, {
				id,
				traceId,
				deadlineMs,
				startedAt,
				argsHash,
				fullArgs,
				consent,
			});
		});
	}

	/** Release the in-flight hold + resume the idle clock after a terminal path. */
	private releaseCall(session: Session): void {
		session.inFlight = Math.max(0, session.inFlight - 1);
		this.resumeIdleIfIdle(session);
	}

	/**
	 * Dispatch a tool call to the page with a deadline (spec §5.5). The caller has
	 * already passed the policy/consent gate; `consent` is recorded on the audit.
	 */
	private dispatchCall(
		session: Session,
		ch: ChannelAgg,
		reg: ToolRegistration,
		args: Record<string, unknown>,
		meta: {
			id: number;
			traceId: string;
			deadlineMs: number;
			startedAt: number;
			argsHash: string;
			fullArgs?: unknown;
			consent: AuditConsent;
		},
	): Promise<CallToolResult> {
		const { id, traceId, deadlineMs, startedAt, argsHash, fullArgs, consent } = meta;
		return new Promise<CallToolResult>((resolve) => {
			const deadlineHandle = this.scheduler.schedule(deadlineMs, () => {
				const p = session.pendingCalls.get(id);
				if (!p) return;
				session.pendingCalls.delete(id);
				this.releaseCall(session);
				resolve(coerceError(GlassboxErrorCode.DEADLINE, "page did not respond in time", traceId));
				this.record({
					ts: this.clock.now(),
					traceId,
					channel: ch.channel,
					tool: reg.name,
					tier: reg.tier,
					argsHash,
					client: this.client,
					consent,
					ms: this.clock.now() - startedAt,
					status: "deadline",
					...(fullArgs !== undefined ? { args: fullArgs } : {}),
				});
			});
			const pending: PendingCall = {
				resolve,
				traceId,
				toolName: reg.name,
				channel: ch.channel,
				tier: reg.tier,
				startedAt,
				deadlineHandle,
				consent,
				argsHash,
				client: this.client,
				...(fullArgs !== undefined ? { args: fullArgs } : {}),
			};
			session.pendingCalls.set(id, pending);
			try {
				session.link?.send(
					encode({ type: "tool.call", id, name: reg.name, args, deadlineMs, traceId }),
				);
			} catch {
				session.pendingCalls.delete(id);
				this.releaseCall(session);
				resolve(coerceError(GlassboxErrorCode.PROTOCOL_ERROR, "failed to dispatch call", traceId));
				this.record({
					ts: this.clock.now(),
					traceId,
					channel: ch.channel,
					tool: reg.name,
					tier: reg.tier,
					argsHash,
					client: this.client,
					consent,
					ms: this.clock.now() - startedAt,
					status: "error",
					detail: "failed to dispatch call",
					...(fullArgs !== undefined ? { args: fullArgs } : {}),
				});
			}
		});
	}

	/**
	 * Send a consent.request to the widget and await its decision (spec §6.2, §7.3).
	 * Times out to a denial after `consentTimeoutMs` clamped to the tool deadline.
	 */
	private requestConsent(
		session: Session,
		reg: ToolRegistration,
		args: Record<string, unknown>,
		deadlineMs: number,
		traceId: string,
	): Promise<ConsentOutcome> {
		return new Promise<ConsentOutcome>((resolve) => {
			const consentId = this.nextId++;
			const consentDeadline = Math.min(this.consentTimeoutMs, deadlineMs);
			const deadlineHandle = this.scheduler.schedule(consentDeadline, () => {
				const p = this.pendingConsents.get(consentId);
				if (!p) return;
				this.pendingConsents.delete(consentId);
				resolve("timeout"); // no answer in time → not granted (spec §7.3)
			});
			this.pendingConsents.set(consentId, {
				resolve,
				deadlineHandle,
				session,
				traceId,
			});
			try {
				session.link?.send(
					encode({
						type: "consent.request",
						id: consentId,
						tool: reg.name,
						description: reg.description,
						args,
						tier: reg.tier,
						deadlineMs: consentDeadline,
					}),
				);
			} catch {
				this.pendingConsents.delete(consentId);
				this.scheduler.cancel(deadlineHandle);
				resolve("disconnected");
			}
		});
	}

	/** A consent.result arrived (or a detach abandoned it): settle the gate. */
	private resolveConsent(id: number, outcome: ConsentOutcome): void {
		const p = this.pendingConsents.get(id);
		if (!p) return;
		this.pendingConsents.delete(id);
		this.scheduler.cancel(p.deadlineHandle);
		p.resolve(outcome);
	}

	requestPrompt(
		channel: string,
		name: string,
		args: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<PromptResultMsg> {
		return this.request(
			channel,
			(id, send) => send({ type: "prompt.request", id, name, args }),
			timeoutMs,
		);
	}

	requestResource(channel: string, uri: string, timeoutMs?: number): Promise<ResourceResultMsg> {
		return this.request(
			channel,
			(id, send) => send({ type: "resource.request", id, uri }),
			timeoutMs,
		);
	}

	requestSampling(
		channel: string,
		params: { messages: unknown[]; systemPrompt?: string; maxTokens: number; schema?: unknown },
		timeoutMs?: number,
	): Promise<SamplingResultMsg> {
		return this.request(
			channel,
			(id, send) =>
				send({
					type: "sampling.request",
					id,
					messages: params.messages,
					...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
					maxTokens: params.maxTokens,
					...(params.schema !== undefined ? { schema: params.schema } : {}),
				}),
			timeoutMs,
		);
	}

	// ---------- discovery / introspection ----------

	/** Live session ids (basis for revocation, spec §5.2: gbox-drop <sid>). */
	listSessions(): Array<{
		sid: string;
		app: string;
		origin: string;
		channel: string;
		attached: boolean;
	}> {
		const out: Array<{
			sid: string;
			app: string;
			origin: string;
			channel: string;
			attached: boolean;
		}> = [];
		for (const s of this.sessions.values()) {
			out.push({
				sid: s.sid,
				app: s.app,
				origin: s.origin,
				channel: s.channel,
				attached: s.link !== null,
			});
		}
		return out.sort((a, b) => a.sid.localeCompare(b.sid));
	}

	listChannels(): ChannelView[] {
		const out: ChannelView[] = [];
		for (const ch of this.channels.values()) {
			const tabs = this.liveSids(ch).length;
			const tools = [...ch.tools.values()].map((t) => `${ch.channel}__${t.sanitized}`);
			if (tabs === 0 && tools.length === 0) continue;
			out.push({
				channel: ch.channel,
				app: ch.app,
				origin: ch.origin,
				tabs,
				tools,
				lastCalls: this.auditLastFor(ch.channel, 10),
			});
		}
		return out.sort((a, b) => a.channel.localeCompare(b.channel));
	}

	now(): number {
		return this.clock.now();
	}

	get auditSink(): AuditSink {
		return this.audit;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const s of this.sessions.values()) {
			this.scheduler.cancel(s.idleHandle);
			s.link = null;
		}
		this.sessions.clear();
		this.channels.clear();
	}

	// ---------- internals ----------

	private request<T extends PromptResultMsg | ResourceResultMsg | SamplingResultMsg>(
		channel: string,
		build: (id: number, send: (m: GlassboxMessage) => void) => void,
		timeoutMs: number | undefined,
	): Promise<T> {
		const ch = this.channels.get(channel);
		const live = ch ? this.liveSids(ch) : [];
		if (!ch || live.length === 0) {
			return Promise.resolve({
				type: "error",
				code: GlassboxErrorCode.UNKNOWN_TOOL,
				message: `no live channel for ${channel}`,
			} as unknown as T);
		}
		const id = this.nextId++;
		const deadlineMs = this.clampTimeout(timeoutMs ?? this.defaultTimeoutMs);
		const session = this.pickSession(live);

		return new Promise<T>((resolve) => {
			const deadlineHandle = this.scheduler.schedule(deadlineMs, () => {
				const p = session.pendingReqs.get(id);
				if (!p) return;
				session.pendingReqs.delete(id);
				resolve({
					type: "error",
					code: GlassboxErrorCode.DEADLINE,
					message: "request deadline exceeded",
				} as unknown as T);
			});
			const pending: PendingReq = { resolve: resolve as PendingReq["resolve"], deadlineHandle };
			session.pendingReqs.set(id, pending);
			try {
				build(id, (m) => session.link?.send(encode(m)));
			} catch {
				session.pendingReqs.delete(id);
				resolve({
					type: "error",
					code: GlassboxErrorCode.PROTOCOL_ERROR,
					message: "failed to dispatch request",
				} as unknown as T);
			}
		});
	}

	private registerTool(s: Session, msg: ToolRegisterMsg): void {
		const sanitized = toolName(msg.name);
		const reg: ToolRegistration = {
			name: msg.name,
			sanitized,
			description: msg.description,
			...(msg.inputSchema !== undefined ? { inputSchema: msg.inputSchema } : {}),
			// untagged means write: a tool with side effects must not run without consent by accident
			tier: msg.tier ?? "write",
			timeoutMs: this.clampTimeout(msg.timeoutMs ?? this.defaultTimeoutMs),
		};
		const ch = this.ensureChannel(s.channel, s.app, s.origin);
		ch.tools.set(sanitized, reg);
		let owners = ch.owners.get(sanitized);
		if (!owners) {
			owners = new Set();
			ch.owners.set(sanitized, owners);
		}
		owners.add(s.sid);
		this.touchChannel(s.channel);
		this.record({
			ts: this.clock.now(),
			traceId: s.sid,
			channel: ch.channel,
			tool: reg.name,
			tier: reg.tier,
			status: "register",
		});
		this.onToolsChanged?.();
	}

	private unregisterTool(s: Session, msg: ToolUnregisterMsg): void {
		const sanitized = toolName(msg.name);
		const ch = this.channels.get(s.channel);
		if (!ch) return;
		const owners = ch.owners.get(sanitized);
		owners?.delete(s.sid);
		if (owners && owners.size === 0) {
			ch.owners.delete(sanitized);
			ch.tools.delete(sanitized);
		}
		this.record({
			ts: this.clock.now(),
			traceId: s.sid,
			channel: ch.channel,
			tool: msg.name,
			status: "unregister",
		});
		this.onToolsChanged?.();
	}

	private resolveCall(s: Session, msg: Extract<PageToBridgeMsg, { type: "tool.result" }>): void {
		const p = s.pendingCalls.get(msg.id);
		if (!p) return;
		s.pendingCalls.delete(msg.id);
		s.inFlight = Math.max(0, s.inFlight - 1);
		this.resumeIdleIfIdle(s);
		const ms = this.clock.now() - p.startedAt;
		if (msg.error) {
			p.resolve(coerceError(msg.error.code, msg.error.message, p.traceId));
			this.record({
				ts: this.clock.now(),
				traceId: p.traceId,
				channel: p.channel,
				tool: p.toolName,
				tier: p.tier,
				argsHash: p.argsHash,
				...(p.client !== undefined ? { client: p.client } : {}),
				consent: p.consent,
				ms,
				status: "error",
				detail: msg.error.message,
				...(p.args !== undefined ? { args: p.args } : {}),
			});
			return;
		}
		p.resolve(coerceResult(msg.value, this.protocolVersion));
		this.record({
			ts: this.clock.now(),
			traceId: p.traceId,
			channel: p.channel,
			tool: p.toolName,
			tier: p.tier,
			argsHash: p.argsHash,
			...(p.client !== undefined ? { client: p.client } : {}),
			consent: p.consent,
			ms,
			status: "ok",
			...(p.args !== undefined ? { args: p.args } : {}),
		});
	}

	private resolveReq(
		s: Session,
		msg: Extract<
			PageToBridgeMsg,
			{ type: "prompt.result" | "resource.result" | "sampling.result" }
		>,
	): void {
		const p = s.pendingReqs.get(msg.id);
		if (!p) return;
		s.pendingReqs.delete(msg.id);
		p.resolve(msg);
	}

	private onCallEvent(s: Session, phase: "start" | "progress" | "end"): void {
		if (phase === "start") this.suspendIdle(s);
		else if (phase === "end") this.resumeIdleIfIdle(s);
	}

	private abandonPending(s: Session): void {
		for (const p of s.pendingCalls.values()) {
			this.scheduler.cancel(p.deadlineHandle);
			p.resolve(
				coerceError(GlassboxErrorCode.DEADLINE, "connection lost before result", p.traceId),
			);
			this.record({
				ts: this.clock.now(),
				traceId: p.traceId,
				channel: p.channel,
				tool: p.toolName,
				tier: p.tier,
				argsHash: p.argsHash,
				...(p.client !== undefined ? { client: p.client } : {}),
				consent: p.consent,
				status: "lost",
				...(p.args !== undefined ? { args: p.args } : {}),
			});
		}
		for (const p of s.pendingReqs.values()) {
			this.scheduler.cancel(p.deadlineHandle);
			p.resolve({ type: "error", code: GlassboxErrorCode.DEADLINE, message: "connection lost" });
		}
		for (const [cid, c] of [...this.pendingConsents]) {
			if (c.session === s) {
				this.pendingConsents.delete(cid);
				this.scheduler.cancel(c.deadlineHandle);
				c.resolve("disconnected");
			}
		}
		s.pendingCalls.clear();
		s.pendingReqs.clear();
		s.inFlight = 0;
	}

	private pruneChannelOwners(s: Session): void {
		const ch = this.channels.get(s.channel);
		if (!ch) return;
		let changed = false;
		for (const [sanitized, owners] of ch.owners) {
			owners.delete(s.sid);
			if (owners.size === 0) {
				ch.owners.delete(sanitized);
				ch.tools.delete(sanitized);
				changed = true;
			}
		}
		if (changed) this.onToolsChanged?.();
	}

	private liveSids(ch: ChannelAgg): string[] {
		const out: string[] = [];
		for (const sid of ch.sids) {
			const s = this.sessions.get(sid);
			if (s?.link) out.push(sid);
		}
		return out;
	}

	private pickSession(live: string[]): Session {
		let best: Session | undefined;
		for (const sid of live) {
			const s = this.sessions.get(sid);
			if (!s) continue;
			if (!best || s.created > best.created) best = s;
		}
		if (!best)
			throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "no live session in channel");
		return best;
	}

	private ensureChannel(channel: string, app: string, origin: string): ChannelAgg {
		let ch = this.channels.get(channel);
		if (!ch) {
			ch = {
				channel,
				app,
				origin,
				tools: new Map(),
				owners: new Map(),
				sids: new Set(),
				lastActive: this.clock.now(),
			};
			this.channels.set(channel, ch);
		}
		return ch;
	}

	private addSidToChannel(channel: string, app: string, origin: string, sid: string): void {
		this.ensureChannel(channel, app, origin).sids.add(sid);
	}

	private touchChannel(channel: string): void {
		const ch = this.channels.get(channel);
		if (ch) ch.lastActive = this.clock.now();
	}

	private clampTimeout(ms: number): number {
		if (!Number.isFinite(ms) || ms <= 0) return this.defaultTimeoutMs;
		return Math.min(Math.max(ms, 1), this.maxTimeoutMs);
	}

	private idleRemaining(s: Session): number {
		return Math.max(0, s.expiresAt - this.clock.now());
	}

	private suspendIdle(s: Session): void {
		if (s.idleHandle !== undefined) {
			this.scheduler.cancel(s.idleHandle);
			s.idleHandle = undefined;
		}
	}

	private resumeIdleIfIdle(s: Session): void {
		if (s.inFlight <= 0 && s.link) this.resumeIdle(s);
	}

	private resumeIdle(s: Session): void {
		this.suspendIdle(s);
		s.expiresAt = this.clock.now() + this.idleTtlMs;
		const fire = () => {
			if (s.link === null && this.clock.now() >= s.expiresAt) this.revoke(s.sid, "idle-timeout");
			else this.resumeIdle(s);
		};
		s.idleHandle = this.scheduler.schedule(this.idleTtlMs, fire);
	}

	private auditLastFor(channel: string, n: number): AuditEntry[] {
		const sink = this.audit as unknown as { entries?: AuditEntry[] };
		return sink.entries?.filter((e) => e.channel === channel).slice(-n) ?? [];
	}

	private record(entry: AuditEntry): void {
		this.audit.record(entry);
	}

	private view(s: Session): SessionView {
		return {
			sid: s.sid,
			sessionToken: s.sessionToken,
			app: s.app,
			origin: s.origin,
			channel: s.channel,
			expiresMs: this.idleRemaining(s),
		};
	}
}
