/**
 * Glassbox page SDK (spec §4.2, §5.2, §5.5) + minimal widget.
 *
 * Vanilla ESM, zero runtime dependencies — the only imports are the project's
 * own zero-dependency protocol core (spec §5.8), which the bundler inlines.
 * Pages NEVER learn MCP framing: tools return plain values (spec §5.4).
 *
 *   const gbox = new Glassbox("mygame");
 *   gbox.tool("status", "Current state", () => ({ score: 420 }));
 *   gbox.tool("play_move", "Clear the group at x,y", { tier: "write", timeoutMs: 5000 },
 *             async ({ x, y }) => ({ played: true }));
 *   renderWidget(gbox);                      // code input + status + activity feed
 *   await gbox.connect(pastedCode);           // or let the widget do it
 */
import { decode, encode, type GlassboxMessage, type Tier } from "../src/core/codec.js";
import { decodeQrPayload, encodeQr, qrToSvg } from "../src/core/qr.js";
import { PROTOCOL_VERSION } from "../src/core/version.js";

// ---------- public types ----------

export type GlassboxStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "offline"
	| "expired";

export interface ToolOptions {
	tier?: Tier;
	timeoutMs?: number;
	inputSchema?: unknown;
}

export type ToolHandler = (args: Record<string, unknown>) => unknown;
export type PromptDef = {
	description?: string;
	args?: Array<{ name: string; description?: string }>;
};
export type PromptHandler = (args: Record<string, unknown>) => unknown[] | Promise<unknown[]>;
export type ResourceHandler = () => unknown;
export type SamplingHandler = (p: {
	messages: unknown[];
	systemPrompt?: string;
	maxTokens: number;
	schema?: unknown;
}) => unknown;

export type GlassboxEvent =
	| "status"
	| "ready"
	| "call"
	| "error"
	| "revoke"
	| "consent"
	| "sampling";

export type SamplingRequest = {
	id: number;
	messages: unknown[];
	systemPrompt?: string;
	maxTokens: number;
	schema?: unknown;
};

export type SessionInfo = { sid: string; sessionToken: string; host: string; port: number };

// ---------- code decoding (self-describing, spec §5.2, §7.1) ----------

function b64urlDecode(s: string): string {
	let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	while (b64.length % 4) b64 += "=";
	return atob(b64);
}

// ---------- sampling forms (spec §5.7) ----------

type SampleSchema = Record<string, unknown>;

function matchesType(t: string, v: unknown): boolean {
	switch (t) {
		case "string":
			return typeof v === "string";
		case "number":
			return typeof v === "number" && Number.isFinite(v);
		case "integer":
			return typeof v === "number" && Number.isInteger(v);
		case "boolean":
			return typeof v === "boolean";
		case "array":
			return Array.isArray(v);
		case "object":
			return v !== null && typeof v === "object" && !Array.isArray(v);
		case "null":
			return v === null;
		default:
			return true; // unknown keyword → do not gate
	}
}

function checkSchema(s: SampleSchema, v: unknown, path: string): string | null {
	if (Array.isArray(s.type)) {
		if (s.type.every((t) => typeof t !== "string" || !matchesType(t as string, v))) {
			return `${path}: expected ${s.type.join(" | ")}, got ${v === null ? "null" : Array.isArray(v) ? "array" : typeof v}`;
		}
	} else if (typeof s.type === "string" && !matchesType(s.type, v)) {
		return `${path}: expected ${s.type}, got ${v === null ? "null" : Array.isArray(v) ? "array" : typeof v}`;
	}
	if (Array.isArray(s.enum)) {
		const ok = (s.enum as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(v));
		if (!ok)
			return `${path}: not one of [${(s.enum as unknown[]).map((e) => JSON.stringify(e)).join(", ")}]`;
	}
	if (typeof v === "number") {
		if (typeof s.minimum === "number" && v < (s.minimum as number))
			return `${path}: below minimum ${s.minimum as number}`;
		if (typeof s.maximum === "number" && v > (s.maximum as number))
			return `${path}: above maximum ${s.maximum as number}`;
	}
	if (typeof v === "string") {
		if (typeof s.minLength === "number" && v.length < (s.minLength as number))
			return `${path}: shorter than ${s.minLength as number} chars`;
		if (typeof s.maxLength === "number" && v.length > (s.maxLength as number))
			return `${path}: longer than ${s.maxLength as number} chars`;
	}
	if (matchesType("object", v)) {
		if (s.properties !== undefined && s.properties !== null) {
			if (!matchesType("object", v) || Array.isArray(v)) return `${path}: expected object`;
			const props = s.properties as Record<string, SampleSchema>;
			const obj = v as Record<string, unknown>;
			if (Array.isArray(s.required)) {
				for (const r of s.required as string[]) {
					if (typeof r === "string" && !(r in obj)) return `${path}: missing required "${r}"`;
				}
			}
			for (const [k, ps] of Object.entries(props)) {
				if (k in obj) {
					const err = checkSchema(ps, obj[k], `${path}.${k}`);
					if (err) return err;
				}
			}
		}
	} else if (Array.isArray(v) && s.items !== undefined && s.items !== null) {
		if (!matchesType("array", v)) return `${path}: expected array`;
		const items = s.items as SampleSchema;
		for (let i = 0; i < (v as unknown[]).length; i++) {
			const err = checkSchema(items, (v as unknown[])[i], `${path}[${i}]`);
			if (err) return err;
		}
	}
	return null;
}

/**
 * Minimal JSON-Schema check for widget sampling answers (spec §5.7): type (incl.
 * arrays of types), required, properties, enum, min/maximum, min/maxLength, items.
 * Unknown keywords are ignored — this gates obviously-wrong answers, the bridge
 * stays the authoritative consumer. Returns an error string or null when valid.
 */
export function validateSampleAnswer(schema: unknown, value: unknown): string | null {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
	return checkSchema(schema as SampleSchema, value, "$");
}

export type SampleField = {
	name: string;
	type: "text" | "textarea" | "number" | "checkbox" | "select";
	enum?: string[];
	required: boolean;
	hint?: string;
};

function mkSampleField(f: {
	name: string;
	type: SampleField["type"];
	required: boolean;
	hint: string | undefined;
	enum?: string[];
}): SampleField {
	const out: SampleField = { name: f.name, type: f.type, required: f.required };
	if (f.hint !== undefined) out.hint = f.hint;
	if (f.enum) out.enum = f.enum;
	return out;
}

/**
 * Turn an answer schema into widget form fields (spec §5.7). No schema (or a
 * schema with no object properties) → a single textarea fallback.
 */
export function samplingFields(schema: unknown): SampleField[] {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return [{ name: "answer", type: "textarea", required: true }];
	}
	const s = schema as SampleSchema;
	const props =
		s.properties !== null && typeof s.properties === "object" && !Array.isArray(s.properties)
			? (s.properties as Record<string, SampleSchema>)
			: null;
	if (!props || Object.keys(props).length === 0) {
		return [{ name: "answer", type: "textarea", required: true }];
	}
	const required = new Set(
		(Array.isArray(s.required) ? (s.required as unknown[]) : []).filter(
			(r): r is string => typeof r === "string",
		),
	);
	return Object.entries(props).map(([name, p]) => {
		const hint = typeof p.description === "string" ? p.description : "";
		const req = required.has(name);
		if (Array.isArray(p.enum)) {
			const all = p.enum as unknown[];
			if (all.length > 0 && all.every((e): e is string => typeof e === "string")) {
				return mkSampleField({ name, type: "select", required: req, hint, enum: all });
			}
			// non-string enum → plain text with a hint; validation still applies
			return mkSampleField({
				name,
				type: "text",
				required: req,
				hint: hint || `one of: ${all.map((e) => JSON.stringify(e)).join(", ")}`,
			});
		}
		const types = Array.isArray(p.type) ? (p.type as string[]) : [p.type as string];
		if (types.includes("boolean"))
			return mkSampleField({ name, type: "checkbox", required: req, hint });
		if (types.includes("number") || types.includes("integer"))
			return mkSampleField({ name, type: "number", required: req, hint });
		return mkSampleField({ name, type: "text", required: req, hint });
	});
}

/** A connect code embeds its own loopback endpoint — the code is the only discovery path. */
export function decodeConnectCode(code: string): { host: string; port: number; app: string } {
	try {
		const p = JSON.parse(b64urlDecode(code.trim())) as {
			host?: unknown;
			port?: unknown;
			app?: unknown;
		};
		if (typeof p.host !== "string" || !Number.isInteger(p.port)) throw new Error("malformed code");
		return { host: p.host, port: p.port as number, app: typeof p.app === "string" ? p.app : "app" };
	} catch (e) {
		throw new Error(
			`glassbox: invalid connect code (${e instanceof Error ? e.message : String(e)})`,
		);
	}
}

// ---------- ambient browser access (kept defensive for non-browser hosts) ----------

function pageOrigin(): string {
	try {
		return globalThis.location?.origin ?? "http://localhost";
	} catch {
		return "http://localhost";
	}
}

export type GlassboxStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface GlassboxOptions {
	/** Storage for the stored session (default: sessionStorage — survives reloads). */
	storage?: GlassboxStorage;
}

function defaultStorage(): GlassboxStorage | null {
	try {
		return (globalThis.sessionStorage as GlassboxStorage | undefined) ?? null;
	} catch {
		return null;
	}
}

// ---------- SDK ----------

export class Glassbox {
	readonly app: string;
	status: GlassboxStatus = "disconnected";

	private readonly tools = new Map<
		string,
		{ def: ToolOptions & { description: string }; fn: ToolHandler }
	>();
	private readonly prompts = new Map<string, { def: PromptDef; fn: PromptHandler }>();
	private readonly resources = new Map<string, { description: string; fn: ResourceHandler }>();
	private sampler: SamplingHandler | null = null;
	private readonly pendingSampling = new Set<number>();

	private readonly listeners = new Map<GlassboxEvent, Set<(data: never) => void>>();
	private ws: WebSocket | null = null;
	private session: SessionInfo | null = null;
	private ackResolve: ((m: { type: string }) => void) | null = null;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectNextAt: number | null = null;
	private intentional = true;
	private gen = 0;
	// How the next "connected" was opened: a fresh session from a pasted/QR code, or a
	// re-attach of an existing session (reload-resume / reconnect). The widget's feed
	// wording depends on it ("● connected" vs "↻ reconnected (session resumed)"), and a
	// fresh code after a bridge restart is NOT a resume (spec §5.2).
	private connectKind: "fresh" | "resume" = "fresh";
	private readonly storage: GlassboxStorage | null;
	readonly tab: string;

	constructor(app: string, opts: GlassboxOptions = {}) {
		this.app = app;
		this.tab = `tab-${Math.random().toString(36).slice(2, 10)}`;
		this.storage = opts.storage ?? null;
		// spec §5.2: the stored session survives a page reload — resume it
		// automatically so no token re-paste is ever needed.
		const stored = this.readStored();
		if (stored) void this.resume(stored).catch(() => {});
	}

	// ---- registration (spec §4.2) ----

	tool(
		name: string,
		description: string,
		a?: ToolOptions | Record<string, unknown> | ToolHandler,
		b?: ToolHandler,
	): Glassbox {
		const OPT_KEYS = new Set(["tier", "timeoutMs", "inputSchema"]);
		const TIERS = new Set<string>(["read", "write", "dangerous"]);
		let opts: ToolOptions = {};
		let fn: ToolHandler;
		if (typeof a === "function") {
			fn = a;
		} else if (typeof b === "function") {
			fn = b;
			const given = (a ?? {}) as Record<string, unknown>;
			const keys = Object.keys(given);
			// An option key counts only when its value has the option's type; a schema
			// property that merely shares the name (e.g. `tier: {type: "string"}`) does not.
			const isOptionEntry = (k: string): boolean => {
				const v = given[k];
				if (k === "tier") return typeof v === "string";
				if (k === "timeoutMs") return typeof v === "number";
				return OPT_KEYS.has(k) && typeof v === "object" && v !== null;
			};
			if (keys.length > 0 && keys.every(isOptionEntry)) {
				const tier = given.tier;
				if (tier !== undefined && !TIERS.has(String(tier))) {
					throw new Error(
						`glassbox: tool "${name}": unknown tier "${String(tier)}" (want read|write|dangerous)`,
					);
				}
				const timeout = given.timeoutMs;
				if (typeof timeout === "number" && !(Number.isFinite(timeout) && timeout > 0)) {
					throw new Error(`glassbox: tool "${name}": timeoutMs must be a positive number`);
				}
				opts = given as ToolOptions;
			} else {
				const mixed = keys.filter(isOptionEntry);
				if (mixed.length > 0) {
					throw new Error(
						`glassbox: tool "${name}": ${mixed.join(", ")} mixed with schema properties. ` +
							`Put the schema under inputSchema, e.g. { tier, inputSchema: { type: "object", properties: {...} } }`,
					);
				}
				opts.inputSchema = { type: "object", properties: given };
			}
		} else {
			throw new Error("glassbox: tool(name, description, …, handler) — a handler is required");
		}
		this.tools.set(name, { def: { ...opts, description }, fn });
		if (this.status === "connected") this.sendRegister(name);
		return this;
	}

	untool(name: string): Glassbox {
		if (this.tools.delete(name) && this.status === "connected") {
			this.send({ type: "tool.unregister", name });
		}
		return this;
	}

	prompt(name: string, def: PromptDef, fn: PromptHandler): Glassbox {
		this.prompts.set(name, { def, fn });
		return this;
	}

	resource(uri: string, description: string, fn: ResourceHandler): Glassbox {
		this.resources.set(uri, { description, fn });
		return this;
	}

	sampling(fn: SamplingHandler): Glassbox {
		this.sampler = fn;
		return this;
	}

	// ---- events ----

	on(event: GlassboxEvent, cb: (data: never) => void): Glassbox {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(cb);
		return this;
	}

	private emit(event: GlassboxEvent, data: unknown): void {
		for (const cb of this.listeners.get(event) ?? []) {
			try {
				(cb as (d: unknown) => void)(data);
			} catch {
				// a listener must never break the protocol loop
			}
		}
	}

	// ---- connect / reconnect (spec §5.2) ----

	/** Exchange a one-shot connect code for a session, then open the session channel. */
	async connect(code: string): Promise<void> {
		const target = decodeConnectCode(code);
		this.gen++; // supersedes any in-flight auto-resume
		// a pending retry belongs to the old session: drop it so a pasted code wins (offline → new code)
		this.clearReconnect();
		this.intentional = false;
		this.connectKind = "fresh"; // a pasted code always opens a new session
		this.setStatus("connecting");
		const res = await fetch(`http://${target.host}:${target.port}/session`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code, origin: pageOrigin() }),
		});
		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))) as {
				error?: { code?: string; message?: string };
			};
			this.setStatus("disconnected");
			throw new Error(err.error?.message ?? `session exchange failed (HTTP ${res.status})`);
		}
		const v = (await res.json()) as { sid: string; sessionToken: string };
		this.session = {
			sid: v.sid,
			sessionToken: v.sessionToken,
			host: target.host,
			port: target.port,
		};
		this.reconnectAttempts = 0;
		this.persist();
		await this.openSocket();
	}

	/** Auto-resume a stored session (spec §5.2): refresh with sid+sessionToken, then reconnect. */
	private async resume(stored: SessionInfo): Promise<void> {
		const g = ++this.gen;
		this.session = stored;
		this.intentional = false;
		this.connectKind = "resume"; // the stored session survives the reload
		this.setStatus("connecting");
		try {
			const res = await fetch(`http://${stored.host}:${stored.port}/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sid: stored.sid, sessionToken: stored.sessionToken }),
			});
			if (g !== this.gen) return;
			if (!res.ok) {
				this.session = null;
				this.forget();
				this.setStatus("disconnected");
				return;
			}
			const v = (await res.json()) as { sid: string; sessionToken: string };
			if (g !== this.gen) return;
			this.session = { ...stored, sid: v.sid, sessionToken: v.sessionToken };
			this.persist();
			this.reconnectAttempts = 0;
			await this.openSocket();
		} catch {
			if (g !== this.gen) return;
			this.scheduleReconnect();
		}
	}

	disconnect(): void {
		this.gen++;
		this.intentional = true;
		this.clearReconnect();
		this.ws?.close();
		this.ws = null;
		this.setStatus("disconnected");
	}

	/**
	 * Ask the bridge to drop this session server-side (immediate RST, spec §5.2),
	 * then tear down locally and forget the stored session. Wired to the widget's
	 * Disconnect button — unlike `disconnect()`, the bridge forgets the session too.
	 */
	revokeSession(reason = "user-disconnect"): void {
		try {
			this.send({ type: "session.revoke", reason });
		} catch {
			// socket may already be gone; the local teardown below is best-effort
		}
		this.gen++;
		this.intentional = true;
		this.clearReconnect();
		this.session = null;
		this.forget();
		this.ws?.close();
		this.ws = null;
		this.setStatus("expired");
		this.emit("revoke", { reason });
	}

	/**
	 * Resolve a pending consent request (spec §7.3). The programmatic path for
	 * pages with no visible widget (tests, headless); the widget calls this too.
	 */
	resolveConsent(id: number, decision: "approved" | "denied"): void {
		this.send({ type: "consent.result", id, decision });
	}

	/**
	 * Reconnect progress for UIs (spec §5.2): attempts so far and the time until
	 * the next automatic retry, or null when no retry is scheduled.
	 */
	get reconnectProgress(): { attempt: number; nextInMs: number } | null {
		if (this.reconnectTimer === null || this.reconnectNextAt === null) return null;
		return {
			attempt: this.reconnectAttempts,
			nextInMs: Math.max(0, this.reconnectNextAt - Date.now()),
		};
	}

	/**
	 * Trigger a reconnect attempt immediately (widget "Reconnect" affordance,
	 * spec §5.2). No-op outside `reconnecting`/`offline` — the dead-end states
	 * (`disconnected`, `expired`) need a fresh connect code, not a retry.
	 */
	reconnectNow(): void {
		if (this.intentional || !this.session) return;
		if (this.status !== "reconnecting" && this.status !== "offline") return;
		this.clearReconnect();
		this.setStatus("reconnecting");
		void this.tryReconnect();
	}

	/**
	 * Answer a sampling request (spec §5.7) — used by the widget form when no
	 * `sampling()` handler is registered on the page, and by tests / headless.
	 */
	respondSampling(id: number, value?: unknown, error?: { code: string; message: string }): void {
		if (this.pendingSampling.size > 0) this.pendingSampling.delete(id);
		if (error) this.send({ type: "sampling.result", id, error });
		else this.send({ type: "sampling.result", id, value: value ?? null });
	}

	private setStatus(s: GlassboxStatus): void {
		if (this.status === s) return;
		this.status = s;
		this.emit(
			"status",
			// "connected" carries the kind of exchange that produced it, so UIs never call a
			// fresh pairing a "resume" (widget feed, spec §5.2)
			s === "connected" ? { status: s, resumed: this.connectKind === "resume" } : { status: s },
		);
	}

	/** Reconnect: refresh with the stored sid+sessionToken, backoff 250 ms → 4 s (spec §5.2). */
	private scheduleReconnect(): void {
		if (this.intentional || this.reconnectTimer !== null || !this.session) return;
		const delay = Math.min(250 * 2 ** this.reconnectAttempts, 4000);
		this.reconnectAttempts++;
		this.reconnectNextAt = Date.now() + delay;
		// backoff at its cap → the bridge is (probably) gone: say so (spec §5.2)
		this.setStatus(delay >= 4000 ? "offline" : "reconnecting");
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.reconnectNextAt = null;
			void this.tryReconnect();
		}, delay);
	}

	private async tryReconnect(): Promise<void> {
		const s = this.session;
		if (!s) return;
		this.connectKind = "resume"; // refresh + re-attach of the still-valid session
		try {
			const res = await fetch(`http://${s.host}:${s.port}/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sid: s.sid, sessionToken: s.sessionToken }),
			});
			if (!res.ok) {
				// session expired or revoked: only a fresh connect code restores us (spec §7.2)
				this.session = null;
				this.forget();
				this.setStatus("expired");
				this.emit("error", {
					code: "SESSION_EXPIRED",
					message: "session expired — paste a new connect code",
				});
				return;
			}
			const v = (await res.json()) as { sid: string; sessionToken: string };
			this.session = { ...s, sid: v.sid, sessionToken: v.sessionToken };
			this.persist();
			this.setStatus("connecting");
			await this.openSocket();
		} catch {
			this.scheduleReconnect();
		}
	}

	private clearReconnect(): void {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.reconnectNextAt = null;
	}

	private openSocket(): Promise<void> {
		const s = this.session!;
		const ws = new WebSocket(`ws://${s.host}:${s.port}/session`);
		this.ws = ws;
		let settled = false;
		const timeout = setTimeout(() => {
			if (!settled) ws.close();
		}, 5000);

		const ack = new Promise<{ type: string } & Record<string, unknown>>((resolve, reject) => {
			this.ackResolve = resolve;
			const fail = (e: unknown) => {
				clearTimeout(timeout);
				if (!settled) {
					settled = true;
					reject(e instanceof Error ? e : new Error(String(e)));
				}
			};
			ws.onerror = () => fail(new Error("session channel error"));
			ws.onclose = () => {
				fail(new Error("session channel closed"));
			};
		});

		ws.onopen = () => {
			ws.send(
				encode({
					type: "hello",
					v: PROTOCOL_VERSION,
					sid: s.sid,
					app: this.app,
					origin: pageOrigin(),
					tab: this.tab,
				}),
			);
		};
		ws.onmessage = (ev: MessageEvent) => {
			let msg: GlassboxMessage;
			try {
				msg = decode(String(ev.data));
			} catch (e) {
				this.emit("error", {
					code: "PROTOCOL_ERROR",
					message: e instanceof Error ? e.message : String(e),
				});
				ws.close();
				return;
			}
			if (msg.type === "hello.ack") {
				clearTimeout(timeout);
				if (!settled) {
					settled = true;
					this.ackResolve?.(msg);
				}
				this.ackResolve = null;
				this.reconnectAttempts = 0;
				this.setStatus("connected");
				this.registerAll();
				this.emit("ready", msg);
				// connected now: a later drop (reload, bridge restart) must auto-reconnect
				ws.onerror = null;
				ws.onclose = () => this.scheduleReconnect();
				return;
			}
			void this.handleFrame(msg);
		};

		return ack
			.then(() => undefined)
			.catch((e) => {
				this.intentional = false;
				this.setStatus(this.session ? "reconnecting" : "disconnected");
				this.scheduleReconnect();
				throw e;
			});
	}

	// ---- frame handling (spec §5.8) ----

	private async handleFrame(msg: GlassboxMessage): Promise<void> {
		switch (msg.type) {
			// SDK-side change (M3): page errors expose the call's traceId so the widget
			// feed can show "✗ tool — PAGE_ERROR: … (trace tr-N)" (wire traceId, spec §5.8).
			case "tool.call": {
				const entry = this.tools.get(msg.name);
				if (!entry) {
					this.send({
						type: "tool.result",
						id: msg.id,
						error: { code: "PAGE_ERROR", message: `no tool "${msg.name}" on this page` },
					});
					this.emit("error", {
						code: "PAGE_ERROR",
						message: `no tool "${msg.name}" on this page`,
						traceId: msg.traceId,
					});
					return;
				}
				const t0 = Date.now();
				this.emit("call", { name: msg.name, args: msg.args, phase: "start", ms: 0 });
				let error: { code: string; message: string } | null = null;
				try {
					const value = await entry.fn((msg.args as Record<string, unknown>) ?? {});
					this.send({ type: "tool.result", id: msg.id, value: value ?? null });
				} catch (e) {
					error = { code: "PAGE_ERROR", message: e instanceof Error ? e.message : String(e) };
					this.send({
						type: "tool.result",
						id: msg.id,
						error: { code: error.code, message: error.message },
					});
				}
				this.emit("call", {
					name: msg.name,
					args: msg.args,
					phase: "end",
					ms: Date.now() - t0,
					...(error
						? { error: { code: error.code, message: error.message, traceId: msg.traceId } }
						: {}),
				});
				return;
			}
			case "prompt.request": {
				const entry = this.prompts.get(msg.name);
				if (!entry) {
					this.send({
						type: "prompt.result",
						id: msg.id,
						error: { code: "PAGE_ERROR", message: `no prompt "${msg.name}"` },
					});
					return;
				}
				try {
					const messages = await entry.fn(msg.args);
					this.send({ type: "prompt.result", id: msg.id, messages });
				} catch (e) {
					this.send({
						type: "prompt.result",
						id: msg.id,
						error: { code: "PAGE_ERROR", message: String(e) },
					});
				}
				return;
			}
			case "resource.request": {
				const entry = this.resources.get(msg.uri);
				if (!entry) {
					this.send({
						type: "resource.result",
						id: msg.id,
						error: { code: "PAGE_ERROR", message: `no resource "${msg.uri}"` },
					});
					return;
				}
				try {
					const value = await entry.fn();
					const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
					this.send({
						type: "resource.result",
						id: msg.id,
						contents: [{ uri: msg.uri, mimeType: "application/json", text }],
					});
				} catch (e) {
					this.send({
						type: "resource.result",
						id: msg.id,
						error: { code: "PAGE_ERROR", message: String(e) },
					});
				}
				return;
			}
			case "sampling.request": {
				if (!this.sampler) {
					// no programmatic handler: hand the request to the widget form
					// (or a listener) — the answer arrives via respondSampling() (spec §5.7)
					this.pendingSampling.add(msg.id);
					this.emit("sampling", {
						id: msg.id,
						messages: msg.messages,
						...(msg.systemPrompt !== undefined ? { systemPrompt: msg.systemPrompt } : {}),
						maxTokens: msg.maxTokens,
						...(msg.schema !== undefined ? { schema: msg.schema } : {}),
					} satisfies SamplingRequest);
					return;
				}
				try {
					const value = await this.sampler({
						messages: msg.messages,
						...(msg.systemPrompt !== undefined ? { systemPrompt: msg.systemPrompt } : {}),
						maxTokens: msg.maxTokens,
						...(msg.schema !== undefined ? { schema: msg.schema } : {}),
					});
					this.send({ type: "sampling.result", id: msg.id, value: value ?? null });
				} catch (e) {
					this.send({
						type: "sampling.result",
						id: msg.id,
						error: { code: "PAGE_ERROR", message: String(e) },
					});
				}
				return;
			}
			case "error":
				this.emit("error", {
					code: msg.code,
					message: msg.message,
					...(msg.traceId !== undefined ? { traceId: msg.traceId } : {}),
				});
				return;
			case "consent.request":
				// The widget (or a programmatic caller) decides via resolveConsent();
				// a deadline with no decision is a denial on the bridge side (spec §7.3).
				this.emit("consent", {
					id: msg.id,
					tool: msg.tool,
					description: msg.description,
					args: msg.args,
					tier: msg.tier,
					deadlineMs: msg.deadlineMs,
				});
				return;
			case "session.revoke":
				this.session = null;
				this.forget();
				this.clearReconnect();
				this.intentional = true;
				this.ws?.close();
				this.ws = null;
				this.setStatus("expired");
				this.emit("revoke", { reason: msg.reason });
				return;
			default:
				return;
		}
	}

	// ---- wire ----

	private send(msg: GlassboxMessage): void {
		const ws = this.ws;
		if (ws && ws.readyState === 1 /* OPEN */) ws.send(encode(msg));
	}

	private sendRegister(name: string): void {
		const entry = this.tools.get(name);
		if (!entry) return;
		const { def } = entry;
		const m: Record<string, unknown> = {
			type: "tool.register",
			name,
			description: def.description,
		};
		if (def.tier) m.tier = def.tier;
		if (def.timeoutMs) m.timeoutMs = def.timeoutMs;
		if (def.inputSchema) m.inputSchema = def.inputSchema;
		this.send(m as unknown as GlassboxMessage);
	}

	private registerAll(): void {
		for (const name of this.tools.keys()) this.sendRegister(name);
	}

	// ---- persistence (survives reload, spec §5.2) ----

	private key(): string {
		return `glassbox.session.${this.app}`;
	}
	private persist(): void {
		if (!this.session) return;
		try {
			this.store()?.setItem(this.key(), JSON.stringify(this.session));
		} catch {
			// storage may be unavailable (private mode) — reconnects within a tab still work
		}
	}
	private forget(): void {
		try {
			this.store()?.removeItem(this.key());
		} catch {
			// ignore
		}
	}
	private store(): GlassboxStorage | null {
		return this.storage ?? defaultStorage();
	}
	private readStored(): SessionInfo | null {
		try {
			const raw = this.store()?.getItem(this.key());
			if (!raw) return null;
			const v = JSON.parse(raw) as SessionInfo;
			return v && typeof v.sid === "string" && typeof v.sessionToken === "string" ? v : null;
		} catch {
			return null;
		}
	}
}

/** Restore a previously issued session for this app (if any) — returns sid/token or null. */
export function storedSession(app: string): SessionInfo | null {
	try {
		const raw = defaultStorage()?.getItem(`glassbox.session.${app}`);
		if (!raw) return null;
		const v = JSON.parse(raw) as SessionInfo;
		return v && typeof v.sid === "string" && typeof v.sessionToken === "string" ? v : null;
	} catch {
		return null;
	}
}

// ---------- minimal widget (spec M1: code input + status + feed) ----------

const CSS = `
/* Two-phase placement (§SPEC-WIDGET): fixed in both phases, so the page never
   reflows and never needs to "scroll back" after pairing. Pairing is centred with
   inset+auto margins — NOT transform — because a transformed ancestor would
   re-anchor the consent dialog (z-index 2147483000) to the widget instead of
   the viewport. */
.gb-widget{font:13px/1.45 system-ui,sans-serif;border:1px solid #444;border-radius:8px;padding:10px 12px;background:#111;color:#ddd;box-sizing:border-box;position:fixed;z-index:2147482000;inline-size:min(360px,calc(100dvw - 32px));max-block-size:calc(100dvb - 32px);overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;box-shadow:0 6px 24px rgba(0,0,0,.45)}
.gb-widget[data-phase="pairing"]{inset:0;margin:auto;block-size:fit-content;box-shadow:0 6px 24px rgba(0,0,0,.45),0 0 0 100vmax rgba(0,0,0,.55)}
.gb-widget[data-phase="live"]{inset:auto max(16px,env(safe-area-inset-right,0px)) max(16px,env(safe-area-inset-bottom,0px)) auto;margin:0;inline-size:min(320px,calc(100dvw - 32px));max-block-size:min(60dvb,420px)}
.gb-widget[data-phase="live"]:not([data-expanded="true"])>.gb-row,
.gb-widget[data-phase="live"]:not([data-expanded="true"])>.gb-qr,
.gb-widget[data-phase="live"]:not([data-expanded="true"])>.gb-feed{display:none}
.gb-expand{display:none;background:#1c1408;color:#fbbf24;border-color:#d97706!important;flex:0 0 auto}
.gb-widget[data-phase="live"] .gb-expand{display:inline-flex}
/* explicit inline mount keeps the pre-two-phase behaviour for apps that opt out */
.gb-widget[data-placement="inline"]{position:static;inset:auto;margin:8px 0;max-block-size:none;overflow:visible;box-shadow:none}
.gb-widget[data-placement="inline"] .gb-expand{display:none}
.gb-widget .gb-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.gb-widget input{flex:1 1 200px;min-width:0;background:#1c1c1c;border:1px solid #555;border-radius:5px;color:#eee;padding:5px 8px;font:inherit}
.gb-widget button{flex:0 0 auto;background:#2b6cb0;color:#fff;border:0;border-radius:5px;padding:5px 12px;cursor:pointer;font:inherit}
.gb-widget button.gb-disconnect{background:#555;flex:0 0 auto}
.gb-widget button.gb-reconnect{background:#b45309;flex:0 0 auto}
.gb-widget .gb-status{font-weight:600}
.gb-widget .gb-feed{margin-top:6px;max-height:120px;overflow:auto;font-size:12px;color:#aaa;word-break:break-word}
.gb-widget .gb-feed div{padding:1px 0;border-top:1px dashed #333}
.gb-widget .gb-feed .gb-session{color:#7dd3fc}
.gb-widget .gb-feed .gb-feed-err{color:#fca5a5;cursor:pointer}
.gb-widget .gb-feed .gb-feed-detail{color:#8a93a6;padding-left:12px;white-space:pre-wrap;word-break:break-word}
.gb-consent{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483000;width:max-content;max-width:min(480px,calc(100vw - 24px));padding:10px;border:1px solid #d97706;border-radius:6px;background:#1c1408;box-sizing:border-box}
.gb-consent .gb-consent-title{font-weight:700;color:#fbbf24;margin-bottom:4px}
.gb-consent .gb-consent-desc{margin-bottom:6px;color:#ddd}
.gb-consent .gb-consent-args{margin:6px 0;padding:6px;background:#000;border-radius:4px;font:11px/1.4 ui-monospace,monospace;color:#a5f3fc;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
.gb-consent .gb-consent-meta{font-size:11px;color:#fbbf24;margin-bottom:6px}
.gb-consent .gb-consent-actions{display:flex;gap:6px}
.gb-consent .gb-consent-approve{background:#15803d}
.gb-consent .gb-consent-deny{background:#b91c1c}
.gb-sample{margin-top:8px;padding:10px;border:1px solid #0369a1;border-radius:6px;background:#081420}
.gb-sample .gb-sample-q{margin-bottom:6px;color:#ddd;font-weight:600}
.gb-sample .gb-sample-field{margin:4px 0;display:flex;gap:6px;align-items:center}
.gb-sample .gb-sample-name{min-width:90px;color:#7dd3fc;font-size:12px;text-align:right}
.gb-sample .gb-sample-hint{font-size:11px;color:#888}
.gb-sample input,.gb-sample select,.gb-sample textarea{flex:1;min-width:0;background:#001018;border:1px solid #155e75;border-radius:4px;color:#e2e8f0;padding:4px 6px;font:inherit}
.gb-sample textarea{min-height:56px;width:100%}
.gb-sample .gb-sample-err{color:#fca5a5;font-size:12px;margin-top:4px}
.gb-sample .gb-sample-actions{display:flex;gap:6px;margin-top:6px}
.gb-sample .gb-sample-submit{background:#0369a1}
.gb-sample .gb-sample-cancel{background:#555}
.gb-widget .gb-consent-wait{margin-top:6px;padding:6px 8px;border:1px solid #d97706;border-radius:5px;background:#1c1408;color:#fbbf24;font-size:12px;cursor:pointer}
.gb-widget .gb-qr{margin-top:6px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.gb-widget .gb-qr svg{width:132px;height:132px;flex:0 0 auto}
.gb-widget .gb-qr .gb-qr-note{font-size:11px;color:#888}
.gb-consent .gb-consent-approve:focus{outline:2px solid #93c5fd;outline-offset:1px}
.gb-sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;white-space:nowrap}
@media (max-width:480px){.gb-widget{padding:8px 10px}.gb-widget .gb-qr svg{width:112px;height:112px}.gb-widget[data-phase="live"]{inline-size:calc(100dvw - 24px);inset-inline:12px;inset-block-end:max(12px,env(safe-area-inset-bottom,0px))}}
`;

const STATUS_TEXT: Record<GlassboxStatus, string> = {
	disconnected: "○ disconnected",
	connecting: "… connecting",
	connected: "● connected",
	reconnecting: "↻ reconnecting",
	offline: "✕ bridge unreachable — retrying every 4 s (if it restarted, paste a NEW code)",
	expired: "✕ session expired or revoked — new code needed",
};

/**
 * The widget's status line (spec §5.2). `attempt` is the reconnect counter.
 * Exported so the state wording is unit-tested without a DOM.
 */
export function widgetStatusText(status: GlassboxStatus, attempt = 0): string {
	const transient = status === "reconnecting" || status === "offline";
	return transient && attempt > 0
		? `${STATUS_TEXT[status]} — attempt ${attempt}`
		: STATUS_TEXT[status];
}

/**
 * The paste input's placeholder (spec §5.2). `offline` asks for a NEW code too:
 * a restarted bridge can never resume the old session, so retries alone cannot recover.
 */
export function pasteHint(status: GlassboxStatus): string {
	return status === "expired" || status === "disconnected" || status === "offline"
		? "paste a NEW connect code"
		: "paste connect code";
}

/** Two-phase widget placement (§SPEC-WIDGET): only a live session docks; every
 *  other state is the centred pairing overlay. Pure so it is testable without a DOM. */
export type WidgetPhase = "pairing" | "live";
export function widgetPhase(status: GlassboxStatus): WidgetPhase {
	return status === "connected" ? "live" : "pairing";
}

/** The widget's own stylesheet, exported so placement/stacking invariants can be
 *  asserted without a browser (see test/sdk.test.ts, "widget placement invariants"). */
export function widgetCss(): string {
	return CSS;
}

/**
 * Next index for Tab / Shift+Tab inside the consent modal (spec §7.3). `current` is -1 when
 * focus is outside the buttons, so Tab lands on the first and Shift+Tab on the last.
 */
export function cycleFocusIndex(current: number, count: number, shift: boolean): number {
	if (count <= 0) return -1;
	if (current < 0) return shift ? count - 1 : 0;
	return (current + (shift ? count - 1 : 1)) % count;
}

/** The question shown above a sampling form: the last readable message (spec §5.7). */
function samplingQuestion(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (typeof m === "string") return truncateText(m);
		if (m !== null && typeof m === "object") {
			const c = (m as Record<string, unknown>).content;
			if (typeof c === "string") return truncateText(c);
			if (Array.isArray(c)) {
				const s = (c as unknown[])
					.map((p) =>
						p !== null && typeof p === "object" && "text" in p
							? String((p as { text: unknown }).text)
							: "",
					)
					.join(" ");
				if (s) return truncateText(s);
			}
		}
	}
	return "please answer";
}

function truncateText(s: string, maxLen = 90): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > maxLen ? `${t.slice(0, maxLen - 3)}…` : t || "please answer";
}

export interface WidgetOptions {
	/** A selector or element to mount into. Implies in-flow (inline) placement —
	 *  the pre-two-phase behaviour, kept for apps that manage layout themselves. */
	mount?: string | HTMLElement;
	/** "auto" (default): fixed centred pairing overlay → compact bottom dock on
	 *  connect. "inline": normal document flow, no overlay and no dock. */
	placement?: "auto" | "inline";
}

/** Attach (or create) the Glassbox widget: status, connect-code input, activity feed. */
export function renderWidget(gbox: Glassbox, opts: WidgetOptions = {}): HTMLElement {
	const el = document.createElement("div");
	el.className = "gb-widget";
	el.setAttribute(
		"data-placement",
		opts.placement === "inline" || opts.mount !== undefined ? "inline" : "auto",
	);
	el.setAttribute("data-expanded", "false");
	let phase: WidgetPhase | null = null;

	const style = document.createElement("style");
	style.textContent = CSS;
	el.append(style);

	const status = document.createElement("div");
	status.className = "gb-status";
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	// The live phase collapses to status + this button; clicking expands the feed.
	const toggle = document.createElement("button");
	toggle.className = "gb-expand";
	toggle.type = "button";
	toggle.textContent = "▴ activity";
	toggle.setAttribute("aria-expanded", "false");
	toggle.setAttribute("aria-label", "Show Glassbox activity feed");
	const feed = document.createElement("div");
	feed.className = "gb-feed";
	const row = document.createElement("div");
	row.className = "gb-row";
	const input = document.createElement("input");
	input.placeholder = "paste connect code";
	const btn = document.createElement("button");
	btn.type = "button";
	btn.textContent = "Connect";
	row.append(input, btn);
	const reconnectBtn = document.createElement("button");
	reconnectBtn.type = "button";
	reconnectBtn.className = "gb-reconnect";
	reconnectBtn.textContent = "Reconnect";
	reconnectBtn.hidden = true;
	reconnectBtn.title = "Retry the reconnect now (spec §5.2)";
	const disconnectBtn = document.createElement("button");
	disconnectBtn.type = "button";
	disconnectBtn.className = "gb-disconnect";
	disconnectBtn.textContent = "Disconnect";
	disconnectBtn.title = "Revoke this session on the bridge (spec §5.2)";
	row.append(reconnectBtn, disconnectBtn);
	// QR connect (spec §5.2, §12 #5): the pasted code is rendered as a QR live, so a
	// phone can scan the terminal/widget instead of the code being typed anywhere. The
	// "simulated scan" is the structural round-trip of the encoded matrix (decodeQrPayload).
	const qrSlot = document.createElement("div");
	qrSlot.className = "gb-qr";
	qrSlot.hidden = true;
	const qrNote = document.createElement("div");
	qrNote.className = "gb-qr-note";
	qrSlot.append(qrNote);
	const updateQr = () => {
		const code = input.value.trim();
		if (code === "") {
			qrSlot.hidden = true;
			return;
		}
		let ok = false;
		try {
			const qr = encodeQr(code);
			ok = decodeQrPayload(qr) === code;
			qrSlot.innerHTML = qrToSvg(qr);
		} catch {
			qrSlot.replaceChildren(); // payload too large / unencodable — note only
		}
		qrSlot.append(qrNote);
		qrNote.textContent = ok
			? "QR of the code above — scan it from a phone (simulated scan: OK)"
			: "simulated scan FAILED — the code above does not round-trip; check for typos";
		qrSlot.title = ok ? "simulated scan: OK" : "simulated scan: FAILED";
		qrSlot.hidden = false;
	};
	input.addEventListener("input", updateQr);
	let expanded = false;
	toggle.addEventListener("click", () => {
		expanded = !expanded;
		el.setAttribute("data-expanded", String(expanded));
		toggle.setAttribute("aria-expanded", String(expanded));
		toggle.textContent = expanded ? "▾ activity" : "▴ activity";
		toggle.setAttribute(
			"aria-label",
			expanded ? "Hide Glassbox activity feed" : "Show Glassbox activity feed",
		);
		if (expanded) feed.scrollTop = feed.scrollHeight;
	});
	el.append(status, toggle, row, qrSlot, feed);

	reconnectBtn.addEventListener("click", () => {
		note("↻ reconnecting (manual)");
		gbox.reconnectNow();
	});

	const trimFeed = () => {
		while (feed.children.length > 30) feed.lastChild?.remove();
	};
	const note = (text: string, session = false) => {
		const d = document.createElement("div");
		if (session) d.className = "gb-session";
		d.textContent = text;
		feed.prepend(d);
		trimFeed();
	};
	/**
	 * Error line + hidden detail line; clicking the line reveals the full message
	 * (M3 feed polish). `traceId` shows on the visible line for traced errors.
	 */
	const noteError = (e: { code: string; message: string; traceId?: string }, tool?: string) => {
		const line = document.createElement("div");
		line.className = "gb-feed-err";
		line.title = "click for details";
		const trace = e.traceId !== undefined ? ` · ${e.traceId}` : "";
		line.textContent = `${tool ? `${tool} — ` : ""}${e.code}: ${truncateText(e.message, 48)}${trace}`;
		const detail = document.createElement("div");
		detail.className = "gb-feed-detail";
		detail.textContent = e.message;
		detail.hidden = true;
		line.addEventListener("click", () => (detail.hidden = !detail.hidden));
		feed.prepend(line, detail);
		trimFeed();
	};

	status.textContent = STATUS_TEXT[gbox.status];
	const updateStatusLine = () => {
		const p = gbox.reconnectProgress;
		status.textContent = widgetStatusText(gbox.status, p?.attempt ?? 0);
		// dead-end states need a fresh code; transient ones need a retry
		reconnectBtn.hidden = !(gbox.status === "reconnecting" || gbox.status === "offline");
		input.placeholder = pasteHint(gbox.status);
		// Two-phase placement: the overlay becomes a dock exactly when the session
		// goes live, and re-opens as an overlay on any disconnect/reconnect state.
		const next = widgetPhase(gbox.status);
		if (phase !== next) {
			phase = next;
			el.setAttribute("data-phase", next);
			expanded = false;
			el.setAttribute("data-expanded", "false");
			toggle.setAttribute("aria-expanded", "false");
			toggle.textContent = "▴ activity";
			toggle.setAttribute("aria-label", "Show Glassbox activity feed");
			input.blur?.(); // keyboard goes back to the app, not a hidden input
		}
	};
	updateStatusLine();
	// Session events in the feed (M3): the SDK tags each "connected" with the kind of
	// exchange that opened it, so a fresh pairing — including the new code after a
	// bridge restart — logs "● connected", and only a resumed session logs the resume line
	gbox.on("status", (s: { status: string; resumed?: boolean }) => {
		if (s.status === "connected")
			note(s.resumed ? "↻ reconnected (session resumed)" : "● connected", true);
		updateStatusLine();
	});
	gbox.on(
		"call",
		(c: {
			name: string;
			phase: string;
			ms: number;
			error?: { code: string; message: string; traceId?: string };
		}) => {
			if (c.phase === "start") note(`▶ ${c.name}`);
			else if (c.error)
				noteError(c.error, c.name); // failed call: trace + tap for full message
			else note(`✓ ${c.name} (${c.ms} ms)`);
		},
	);
	gbox.on("error", (e: { code?: string; message?: string; traceId?: string }) =>
		noteError({
			code: e.code ?? "ERROR",
			message: e.message ?? "error",
			...(!e.traceId ? {} : { traceId: e.traceId }),
		}),
	);
	gbox.on("revoke", (r: { reason: string }) => note(`revoked: ${r.reason}`));

	// ---- consent (spec §6.2, §7.3): always shows args; pending requests are
	// queued and shown one at a time; Enter or Esc denies; dismissing the
	// modal keeps the request pending with a compact "waiting" chip. The bridge
	// stays authoritative (timeout → denial on the bridge side). ----
	type ConsentReq = {
		id: number;
		tool: string;
		description: string;
		args: unknown;
		tier: string;
		deadlineMs: number;
		expiresAt: number;
	};
	let consentQueue: ConsentReq[] = [];
	let activeConsent: {
		req: ConsentReq;
		modal: HTMLElement;
		meta: HTMLElement;
		countdown: ReturnType<typeof setInterval>;
		finish: (decision: "approved" | "denied") => void;
	} | null = null;

	const chip = document.createElement("div");
	chip.className = "gb-consent-wait";
	chip.hidden = true;
	chip.setAttribute("role", "status");
	chip.setAttribute("aria-live", "polite");
	chip.title = "Click to re-show the consent prompt";
	el.append(chip);

	const showChip = () => {
		const head = consentQueue[0];
		if (!head) {
			chip.hidden = true;
			return;
		}
		chip.hidden = false;
		const extra = consentQueue.length > 1 ? ` · +${consentQueue.length - 1} in queue` : "";
		chip.textContent = `⏳ waiting for consent: ${head.tool}${extra}`;
	};
	const fmtMs = (ms: number) => `${Math.max(0, Math.ceil(ms / 1000))}s`;

	const showNext = () => {
		if (activeConsent) {
			clearInterval(activeConsent.countdown);
			activeConsent.modal.remove();
			activeConsent = null;
		}
		const req = consentQueue[0];
		if (!req) {
			showChip();
			return;
		}
		const modal = document.createElement("div");
		modal.className = "gb-consent";
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");
		modal.setAttribute("aria-label", `Consent: ${req.tool}`);
		const live = document.createElement("div");
		live.className = "gb-sr";
		live.setAttribute("aria-live", "assertive");
		live.textContent = `Consent requested: ${req.tool}. Deny is focused. Enter or Escape denies; Tab to Approve and press Enter to approve.`;
		const title = document.createElement("div");
		title.className = "gb-consent-title";
		title.textContent = `Consent: ${req.tool}`;
		const desc = document.createElement("div");
		desc.className = "gb-consent-desc";
		desc.textContent = req.description;
		const meta = document.createElement("div");
		meta.className = "gb-consent-meta";
		meta.textContent = `tier: ${req.tier} · deadline ${fmtMs(req.expiresAt - Date.now())}`;
		const argsEl = document.createElement("div");
		argsEl.className = "gb-consent-args";
		argsEl.textContent = JSON.stringify(req.args ?? {}, null, 2);
		const actions = document.createElement("div");
		actions.className = "gb-consent-actions";
		const approve = document.createElement("button");
		approve.type = "button";
		approve.className = "gb-consent-approve";
		approve.textContent = "Approve";
		const deny = document.createElement("button");
		deny.type = "button";
		deny.className = "gb-consent-deny";
		deny.textContent = "Deny";
		actions.append(approve, deny);
		modal.append(live, title, desc, meta, argsEl, actions);
		el.append(modal);
		const finish = (decision: "approved" | "denied") => {
			if (!activeConsent || activeConsent.req.id !== req.id) return;
			clearInterval(activeConsent.countdown);
			gbox.resolveConsent(req.id, decision);
			note(`${decision === "approved" ? "✓ consent: " : "✕ consent denied: "}${req.tool}`);
			consentQueue = consentQueue.filter((c) => c.id !== req.id);
			showNext();
		};
		approve.addEventListener("click", () => finish("approved"));
		deny.addEventListener("click", () => finish("denied"));
		// the bridge is authoritative (timeout → denial); the countdown just reflects
		// the wall-clock expiry, so it survives dismissing and re-showing the modal
		const countdown = setInterval(() => {
			meta.textContent = `tier: ${req.tier} · deadline ${fmtMs(req.expiresAt - Date.now())}`;
			if (req.expiresAt - Date.now() <= 0) {
				note(`⏱ consent timed out: ${req.tool}`);
				consentQueue = consentQueue.filter((c) => c.id !== req.id);
				showNext();
			}
		}, 250);
		activeConsent = { req, modal, meta, countdown, finish };
		showChip();
		// focus Deny so an accidental Enter cannot approve a shot
		deny.focus();
	};

	gbox.on("consent", (r: Omit<ConsentReq, "expiresAt">) => {
		if (consentQueue.some((c) => c.id === r.id)) return;
		consentQueue.push({ ...r, expiresAt: Date.now() + r.deadlineMs });
		if (consentQueue.length > 1) {
			note(`⏳ consent queued: ${r.tool} (+${consentQueue.length - 1} waiting)`);
		}
		if (activeConsent) showChip();
		else showNext();
	});

	// dialog keyboard: Enter or Esc denies. Enter on a focused button (Tab to Approve) is left
	// to the browser so the button's own activation applies (a11y; the modal has role=dialog)
	document.addEventListener("keydown", (ev) => {
		if (!activeConsent) return;
		const t = ev.target as HTMLElement | null;
		const typing = t instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
		if (ev.key === "Escape") {
			ev.preventDefault();
			activeConsent.finish("denied");
		} else if (ev.key === "Enter" && !typing && !(t instanceof HTMLButtonElement)) {
			ev.preventDefault();
			activeConsent.finish("denied");
		} else if (ev.key === "Tab") {
			// keep keyboard focus inside the modal: Tab cycles Approve ↔ Deny
			ev.preventDefault();
			const buttons = Array.from(activeConsent.modal.querySelectorAll<HTMLButtonElement>("button"));
			const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
			buttons[cycleFocusIndex(current, buttons.length, ev.shiftKey)]?.focus();
		}
	});
	// click outside the modal → dismiss it but keep the request pending (chip stays)
	document.addEventListener("mousedown", (ev) => {
		if (!activeConsent) return;
		const t = ev.target;
		if (t instanceof Node && !activeConsent.modal.contains(t)) {
			clearInterval(activeConsent.countdown);
			activeConsent.modal.remove();
			activeConsent = null;
			showChip();
		}
	});
	chip.addEventListener("click", () => {
		if (!activeConsent && consentQueue.length > 0) showNext();
	});

	// ---- sampling form (spec §5.7): render the schema as a form, validate,
	// one repair prompt, then a typed error ----
	gbox.on("sampling", (req: SamplingRequest) => {
		note(`⬡ sampling request (${req.messages.length} msg${req.messages.length === 1 ? "" : "s"})`);
		const box = document.createElement("div");
		box.className = "gb-sample";
		const q = document.createElement("div");
		q.className = "gb-sample-q";
		q.textContent = samplingQuestion(req.messages);
		const fields = samplingFields(req.schema);
		const inputs = new Map<string, HTMLElement>();
		for (const f of fields) {
			const fieldEl = document.createElement("div");
			fieldEl.className = "gb-sample-field";
			if (f.type === "checkbox") {
				const cb = document.createElement("input");
				(cb as HTMLInputElement).type = "checkbox";
				inputs.set(f.name, cb);
				const label = document.createElement("span");
				label.textContent = `${f.name}${f.required ? " *" : ""}`;
				fieldEl.append(cb, label);
			} else {
				const name = document.createElement("span");
				name.className = "gb-sample-name";
				name.textContent = `${f.name}${f.required ? " *" : ""}`;
				let control: HTMLElement;
				if (f.type === "select") {
					const sel = document.createElement("select");
					for (const opt of f.enum ?? []) {
						const o = document.createElement("option");
						o.value = opt;
						o.textContent = opt;
						sel.appendChild(o);
					}
					control = sel;
				} else if (f.type === "textarea") {
					control = document.createElement("textarea");
				} else {
					const inp = document.createElement("input");
					if (f.type === "number") (inp as HTMLInputElement).type = "number";
					control = inp;
				}
				inputs.set(f.name, control);
				fieldEl.append(name, control);
				if (f.hint) {
					const hint = document.createElement("div");
					hint.className = "gb-sample-hint";
					hint.textContent = f.hint;
					fieldEl.appendChild(hint);
				}
			}
			box.appendChild(fieldEl);
		}
		const errEl = document.createElement("div");
		errEl.className = "gb-sample-err";
		const actions = document.createElement("div");
		actions.className = "gb-sample-actions";
		const submit = document.createElement("button");
		submit.type = "button";
		submit.className = "gb-sample-submit";
		submit.textContent = "Submit";
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className = "gb-sample-cancel";
		cancel.textContent = "Cancel";
		actions.append(submit, cancel);
		const showErr = (msg: string) => (errEl.textContent = msg);
		let firstField: HTMLElement | null = null;
		let invalids = 0;
		const collect = (): { answer?: Record<string, unknown>; err?: string } => {
			const out: Record<string, unknown> = {};
			for (const f of fields) {
				const el = inputs.get(f.name);
				if (!el) continue;
				if (f.type === "checkbox") {
					out[f.name] = (el as HTMLInputElement).checked;
					continue;
				}
				const raw = (el as HTMLInputElement).value ?? "";
				if (raw === "") {
					// optional + empty → key omitted; schema `required` will flag it
					continue;
				}
				if (f.type === "number") {
					const n = Number(raw);
					if (!Number.isFinite(n)) return { err: `"${f.name}" must be a number` };
					out[f.name] = n;
				} else {
					out[f.name] = raw;
				}
			}
			return { answer: out };
		};
		const failOnce = (msg: string): boolean => {
			// spec §5.7: invalid → ONE repair prompt, then a typed error
			invalids++;
			if (invalids >= 2) {
				gbox.respondSampling(req.id, undefined, {
					code: "PAGE_ERROR",
					message: `sampling answer rejected: ${msg}`,
				});
				done(`✕ sampling: ${msg}`);
				return true;
			}
			showErr(`repair — ${msg}`);
			return false;
		};
		const done = (msg: string) => {
			note(msg);
			box.remove();
		};
		submit.addEventListener("click", () => {
			const { answer, err } = collect();
			if (err) {
				if (failOnce(err)) return;
				return;
			}
			const verr = validateSampleAnswer(req.schema, answer);
			if (verr !== null) {
				if (failOnce(verr)) return;
				return;
			}
			gbox.respondSampling(req.id, answer);
			done("✓ sampling answered");
		});
		cancel.addEventListener("click", () => {
			gbox.respondSampling(req.id, undefined, {
				code: "PAGE_ERROR",
				message: "sampling cancelled",
			});
			done("✕ sampling cancelled");
		});
		box.append(q, errEl, actions);
		el.append(box);
		for (const v of inputs.values()) {
			if (
				v instanceof HTMLInputElement ||
				v instanceof HTMLTextAreaElement ||
				v instanceof HTMLSelectElement
			) {
				if (!firstField) firstField = v;
			}
		}
		firstField?.focus();
	});

	disconnectBtn.addEventListener("click", () => {
		note("↩ disconnecting (revoking session)");
		gbox.revokeSession("user-disconnect");
	});

	const doConnect = () => {
		const code = input.value.trim();
		if (!code) return;
		input.value = "";
		updateQr(); // clear the consumed code's QR (it is one-shot; showing it invites reuse)
		gbox.connect(code).catch((e: Error) => note(`! ${e.message}`));
	};
	btn.addEventListener("click", doConnect);
	input.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") doConnect();
	});

	const mount =
		typeof opts.mount === "string" ? document.querySelector<HTMLElement>(opts.mount) : opts.mount;
	if (mount) mount.appendChild(el);
	else (document.body ?? document.documentElement).appendChild(el);
	return el;
}
