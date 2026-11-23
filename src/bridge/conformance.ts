/**
 * Public conformance harness (spec §9.2 — ships as `glassbox test`).
 *
 * Drives the real PAGE side of glassbox/v1 against a real bridge over loopback
 * HTTP + WebSocket — the same wire a browser page uses:
 *   health → connect code (nonce-signed) → session exchange (one-shot +
 *   origin binding) → WS hello → tool.register → tool.call (with consent
 *   gate on write tiers) → sampling round-trip → drop — asserting every hop,
 *   and in embedded mode the audit lines on disk.
 *
 * Embedded mode (default, no --port): the runner spins its own bridge host +
 * a static server for the fixtures/echo-app page, ephemeral ports, a temp
 * audit dir. It is the check CI and a new user run: exit 0 ⇔ all checks pass.
 *
 * External mode (--port N): the same checks against a running bridge. Tool
 * dispatch / consent / sampling need an in-process bridge entry point, so in
 * external mode those checks are reported as skipped, not failed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
	type ConsentRequestMsg,
	decode,
	type GlassboxMessage,
	type SamplingRequestMsg,
	type Tier,
	type ToolCallMsg,
} from "../core/codec.js";
import { loadOrCreate } from "../core/credentials.js";
import { bridgeToolName, channelFrom, hostKeyOf } from "../core/naming.js";
import { NonceAuth } from "../core/nonce.js";
import { PROTOCOL_VERSION, SERVER_PRODUCT } from "../core/version.js";
import { createHost } from "../host/host.js";
import { type AuditEntry, FileAudit } from "./audit.js";
import { Bridge } from "./bridge.js";
import { CodeStore } from "./code.js";
import { signedFetch } from "./http.js";

export interface ConformanceOptions {
	/** External mode: run against a bridge already listening on this port. */
	port?: number;
	/** `--page URL`: verify the live channel of the page at URL (external mode). */
	pageUrl?: string;
	/** App id for the minted code (default "echo-app"). */
	app?: string;
	/** Origin the minted code is bound to (embedded: the served page origin). */
	origin?: string;
	/** Embedded: keep the fixture bridge + page alive after the checks (M4 quick-start). */
	hold?: boolean;
}

export interface ConformanceCheck {
	name: string;
	ok: boolean;
	/** "skipped" checks are neither pass nor fail (mode-limited). */
	skipped?: boolean;
	detail?: string;
}

export interface ConformanceReport {
	ok: boolean;
	mode: "embedded" | "external";
	summary: string;
	checks: ConformanceCheck[];
	bridgeUrl?: string;
	pageUrl?: string;
	app?: string;
	origin?: string;
	opens: { bridge: number; page?: number };
	hold?: boolean;
}

// ---------- check plumbing ----------

async function check(
	calls: ConformanceCheck[],
	name: string,
	fn: () => Promise<string | undefined>,
): Promise<void> {
	try {
		const detail = await fn();
		calls.push({ name, ok: true, ...(detail !== undefined ? { detail } : {}) });
	} catch (e) {
		calls.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
	}
}

function skip(calls: ConformanceCheck[], name: string, reason: string): void {
	calls.push({ name, ok: true, skipped: true, detail: reason });
}

async function waitFor<T>(
	poll: () => T | null | undefined,
	timeoutMs = 4000,
	what = "condition",
): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = poll();
		if (v !== null && v !== undefined) return v;
		if (Date.now() - t0 > timeoutMs)
			throw new Error(`${what}: not observed within ${timeoutMs} ms`);
		await sleep(25);
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Locate the mcp-glassbox package root (walk up to a package.json with the right name). */
function packageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const pkg = join(dir, "package.json");
		if (existsSync(pkg)) {
			try {
				const meta = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string };
				if (meta.name === "mcp-glassbox") return dir;
			} catch {
				// unreadable package.json — keep walking up
			}
		}
		const parent = dir.slice(0, dir.lastIndexOf("/") > 0 ? dir.lastIndexOf("/") : 0);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("mcp-glassbox package root not found (is this a checkout of the repo?)");
}

/** Loopback static server for fixtures/echo-app (+ /glassbox.js from dist/). Ephemeral port. */
export function serveFixturePage(root: string): Promise<{
	url: string;
	port: number;
	close: () => Promise<void>;
}> {
	const dir = join(root, "fixtures", "echo-app");
	const bundle = join(root, "dist", "glassbox.js");
	const server: Server = createServer();
	server.on("request", (req: IncomingMessage, res: ServerResponse) => {
		const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`).pathname;
		if (pathname === "/glassbox.js" && existsSync(bundle)) {
			res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
			res.end(readFileSync(bundle));
			return;
		}
		if (!dir.startsWith("/")) throw new Error("fixture dir must be absolute");
		const file = join(dir, `.${pathname}`); // normalize + contain under dir
		if (!file.startsWith(dir)) {
			res.writeHead(404).end("not found");
			return;
		}
		try {
			const st = statSync(file);
			if (!st.isFile()) throw new Error("not a file");
			res.writeHead(200, {
				"content-type": pathname.endsWith(".html")
					? "text/html; charset=utf-8"
					: pathname.endsWith(".js")
						? "text/javascript; charset=utf-8"
						: "application/octet-stream",
			});
			res.end(readFileSync(file));
		} catch {
			res.writeHead(404).end("not found");
		}
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr === null || typeof addr === "string") {
				reject(new Error("no socket address"));
				return;
			}
			resolve({
				url: `http://127.0.0.1:${addr.port}`,
				port: addr.port,
				close: () =>
					new Promise<void>((r) => {
						server.closeAllConnections(); // drop live ws connections so close() resolves
						server.close(() => r());
					}),
			});
		});
	});
}

function readAuditEntries(path: string): AuditEntry[] {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as AuditEntry);
	} catch {
		return [];
	}
}

// ============================================================================
// PageActor — a scripted browser page speaking glassbox/v1 over a real socket
// ============================================================================

type AnyMsg = Record<string, unknown>;

/** The open-ports shape threaded through the report and the CLI hold banner. */
export interface OpenPorts {
	bridge: number;
	page?: number;
}

/** headless page: answers tool.call / consent.request / sampling.request the
 * way the SDK does, with consent decided by a callback instead of a modal
 * (spec §6.2: the programmatic half the header-less page uses in tests). */
export class PageActor {
	private ws: WebSocket | null = null;
	private inbox: GlassboxMessage[] = [];
	private tools = new Map<
		string,
		{ description: string; tier?: Tier; run: (args: Record<string, unknown>) => unknown }
	>();
	/** consent decision for the NEXT consent.request (widget headless stand-in). */
	consentDecision: (m: GlassboxMessage) => "approved" | "denied" = () => "approved";
	/** Turn off to observe frames unhandled (e.g. the wrong-origin hello check). */
	respond = true;

	/** Every tool.call frame this page saw (B→P). */
	get calls(): ToolCallMsg[] {
		return this.inbox.filter((m): m is ToolCallMsg => m.type === "tool.call");
	}
	/** Every consent.request frame this page saw (B→P). */
	get consents(): ConsentRequestMsg[] {
		return this.inbox.filter((m): m is ConsentRequestMsg => m.type === "consent.request");
	}
	/** Every sampling.request frame this page saw (B→P). */
	get samplingRequests(): SamplingRequestMsg[] {
		return this.inbox.filter((m): m is SamplingRequestMsg => m.type === "sampling.request");
	}
	/** All frames this page received, in order (B→P + its own sends are not queued). */
	get frames(): GlassboxMessage[] {
		return [...this.inbox];
	}
	/** True once the socket is gone (revoke, error, or manual close). */
	get socketClosed(): boolean {
		return this.ws === null || this.ws.readyState >= 2;
	}
	get revoked(): string | null {
		const m = this.inbox.find((m) => m.type === "session.revoke");
		return m === undefined ? null : m.reason;
	}

	async open(wssUrl: string): Promise<void> {
		this.ws = new WebSocket(wssUrl);
		this.ws.on("message", (data) => this.onFrame(String(data)));
		this.ws.on("close", () => {});
		await new Promise<void>((resolve, reject) => {
			this.ws!.once("open", () => resolve());
			this.ws!.once("error", (e) => reject(new Error(`ws open failed: ${e.message}`)));
		});
	}

	private onFrame(frame: string): void {
		let m: GlassboxMessage;
		try {
			m = decode(frame);
		} catch {
			return; // malformed frame: the real SDK would surface it, checks don't need it
		}
		this.inbox.push(m);
		if (m.type === "session.revoke") {
			this.ws?.terminate();
			return;
		}
		if (!this.respond) return;
		if (m.type === "tool.call") {
			const t = this.tools.get(m.name);
			if (t === undefined) {
				this.send({
					type: "tool.result",
					id: m.id,
					error: { code: "UNKNOWN_TOOL", message: `no such tool: ${String(m.name)}` },
				});
				return;
			}
			this.send({ type: "call.event", id: m.id, phase: "start" });
			const result = (value: unknown, error?: { code: string; message: string }) =>
				this.send({
					type: "tool.result",
					id: m.id,
					...(error === undefined ? { value } : { error }),
				});
			try {
				Promise.resolve(t.run((m.args ?? {}) as Record<string, unknown>)).then(
					(value) => {
						this.send({ type: "call.event", id: m.id, phase: "end", ms: 1 });
						result(value);
					},
					(err: unknown) => result(undefined, { code: "PAGE_ERROR", message: String(err) }),
				);
			} catch (e) {
				result(undefined, { code: "PAGE_ERROR", message: String(e) });
			}
			return;
		}
		if (m.type === "consent.request") {
			this.send({ type: "consent.result", id: m.id, decision: this.consentDecision(m) });
			return;
		}
		if (m.type === "sampling.request") {
			this.send({
				type: "sampling.result",
				id: m.id,
				value: { answer: "42", schemaHonored: m.schema !== undefined },
			});
			return;
		}
	}

	registerTool(
		name: string,
		description: string,
		tier: Tier | undefined,
		run: (a: Record<string, unknown>) => unknown,
	): void {
		this.tools.set(name, { description, ...(tier !== undefined ? { tier } : {}), run });
		this.send({
			type: "tool.register",
			name,
			description,
			...(tier !== undefined ? { tier } : {}),
		});
	}

	send(m: GlassboxMessage | Record<string, unknown>): void {
		if (this.ws === null || this.ws.readyState !== 1) throw new Error("page socket is not open");
		this.ws.send(JSON.stringify(m));
	}

	async hello(v: string, sid: string, app: string, origin: string, tab: string): Promise<void> {
		this.send({ type: "hello", v, sid, app, origin, tab });
		// the ack carries no sid (wire §5.1): the handshake is 1:1 with this socket, so
		// the first hello.ack here IS the answer to our hello.
		await this.next("hello.ack");
	}

	/** Wait for the next frame of `type` matching `pred` (fresh or already in the inbox). */
	async next<T extends GlassboxMessage["type"]>(
		type: T,
		pred: (m: AnyMsg) => boolean = () => true,
		timeoutMs = 4000,
	): Promise<Extract<GlassboxMessage, { type: T }>> {
		const found = (): Extract<GlassboxMessage, { type: T }> | undefined =>
			this.inbox.find((m) => m.type === type && pred(m as unknown as AnyMsg)) as
				| Extract<GlassboxMessage, { type: T }>
				| undefined;
		return waitFor(found, timeoutMs, `frame "${type}"`);
	}

	has(pred: (msg: GlassboxMessage) => boolean): boolean {
		return this.inbox.some(pred);
	}

	close(): void {
		this.ws?.terminate();
		this.ws = null;
	}
}

// ============================================================================
// The run
// ============================================================================

/** Mint a code against `base`, and prove it is bound to (host, port, origin, app). */
async function mintAndParse(
	base: string,
	app: string,
	origin: string,
	bridgePort: number,
): Promise<string> {
	const res = await signedFetch(base, "/code", "POST", { app, origin });
	if (!res.ok) throw new Error(`POST /code → HTTP ${res.status}: ${await res.text()}`);
	const j = (await res.json()) as { code?: string };
	if (typeof j.code !== "string" || j.code.length < 10)
		throw new Error(`mint returned no usable code: ${JSON.stringify(j)}`);
	const p = new CodeStore(Date.now, 60_000).parse(j.code);
	if (p.port !== bridgePort) throw new Error(`code endpoint port ${p.port} ≠ bridge ${bridgePort}`);
	if (p.channel !== channelFrom(origin))
		throw new Error(`code channel "${p.channel}" ≠ ${channelFrom(origin)}`);
	if (p.app !== app) throw new Error(`code app "${p.app}" ≠ ${app}`);
	if (p.expMs !== 60_000) throw new Error(`code ttl ${p.expMs} ms ≠ 60 000`);
	return j.code;
}

/** Complete the code → session exchange for `origin` (spec §5.2). */
async function exchange(
	base: string,
	code: string,
	origin: string,
): Promise<{ sid: string; sessionToken: string }> {
	const res = await fetch(`${base}/session`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code, origin }),
	});
	if (!res.ok) throw new Error(`POST /session → HTTP ${res.status}: ${await res.text()}`);
	const j = (await res.json()) as { sid?: string; sessionToken?: string };
	if (
		typeof j.sid !== "string" ||
		typeof j.sessionToken !== "string" ||
		j.sessionToken.length === 0
	)
		throw new Error(`session exchange returned no sid/sessionToken: ${JSON.stringify(j)}`);
	return { sid: j.sid, sessionToken: j.sessionToken };
}

/** Run the suite. Exit semantics: report.ok ⇔ every non-skipped check passed. */
export async function runConformance(opts: ConformanceOptions = {}): Promise<ConformanceReport> {
	const t0 = Date.now();
	const app = opts.app ?? "echo-app";
	const embedded = opts.port === undefined;
	const calls: ConformanceCheck[] = [];

	// Temp audit dir — embedded: FileAudit on disk (asserted below); external: unused.
	const auditDir = mkdtempSync(join(tmpdir(), "gbx-conform-"));
	const auditPath = join(auditDir, "audit.jsonl");

	let closeBridge: (() => Promise<void>) | null = null;
	let embeddedBridge: Bridge | null = null;
	const opens: OpenPorts = { bridge: 0 };
	let pageUrl: string | undefined = embedded ? undefined : opts.pageUrl;

	if (embedded) {
		const cred = loadOrCreate();
		const bridge = new Bridge({
			serverVersion: "0.0.0-test",
			auth: new NonceAuth({ principals: [cred.publicKeyB64] }),
			audit: new FileAudit(auditPath),
		});
		const host = await createHost(bridge);
		opens.bridge = host.endpoint.port;
		const staticPage = await serveFixturePage(packageRoot());
		opens.page = staticPage.port;
		// the code binds to the SERVED page's origin, so a browser tab that pastes it
		// presents exactly this origin on the exchange + hello (spec §5.2)
		pageUrl = staticPage.url;
		closeBridge = async () => {
			bridge.close();
			await host.close();
			await staticPage.close();
		};
		embeddedBridge = bridge;
	} else {
		opens.bridge = opts.port!;
		pageUrl = opts.origin ?? opts.pageUrl;
		if (pageUrl === undefined) {
			// External mode has no source for the code's origin: name it explicitly.
			calls.push({ name: "setup", ok: false, detail: externalModeOriginHint() });
			safeRm(auditDir);
			return finishReport(calls, t0, { mode: "external", opens, app });
		}
	}

	const base = `http://127.0.0.1:${opens.bridge}`;
	const origin = pageUrl!.startsWith("http") ? pageUrl!.split("/").slice(0, 3).join("/") : pageUrl!;
	const otherOrigin = "http://localhost:9999"; // guaranteed ≠ origin

	// ---- protocol checks (both modes) ----

	await check(calls, "health", async () => {
		const res = await fetch(`${base}/health`);
		if (!res.ok) throw new Error(`/health answered HTTP ${res.status}`);
		const j = (await res.json()) as { ok?: boolean; v?: string; server?: string };
		if (j.ok !== true || j.v !== PROTOCOL_VERSION)
			throw new Error(`/health: ${JSON.stringify(j)} (want ok, ${PROTOCOL_VERSION})`);
		if (typeof j.server !== "string" || !j.server.startsWith(SERVER_PRODUCT))
			throw new Error(`/health: server "${j.server}" is not ${SERVER_PRODUCT}/…`);
		return `${j.v} · ${j.server}`;
	});

	await check(calls, "code.mint", async () => {
		const code = await mintAndParse(base, app, origin, opens.bridge);
		return `blob ${code.length} B · ws://127.0.0.1:${opens.bridge}/session · ttl 60 s`;
	});

	// ---- --page: the user's own page must have a live channel (external mode) ----
	// Runs BEFORE the suite's own exchanges: the runner itself issues sessions on
	// the checked origin, and those would count as live tabs and mask a page that
	// never connected.

	if (!embedded && opts.pageUrl !== undefined) {
		const pageUrl = opts.pageUrl;
		await check(calls, "page.channel", async () => {
			const chans = (await signedFetch(base, "/channels", "GET").then((r) => r.json())) as Array<{
				channel: string;
				origin: string;
				tabs: number;
				tools: string[];
			}>;
			const want = hostKeyOf(urlOrigin(pageUrl));
			const ch = chans.find((c) => hostKeyOf(c.origin) === want);
			if (ch === undefined)
				throw new Error(
					`no live channel for page origin ${want} (paste a connect code into the page first)`,
				);
			if (ch.tabs < 1) throw new Error("page channel shows no attached tabs");
			return `${ch.channel} · ${ch.tools.length} tools`;
		});
	}

	let primarySid: string | null = null;
	let primaryActor: PageActor | null = null;

	await check(calls, "session.exchange", async () => {
		const code = await mintAndParse(base, app, origin, opens.bridge);
		const sv = await exchange(base, code, origin);
		primarySid = sv.sid;
		// one-shot: the same code must be dead now, with a typed rejection
		const again = await fetch(`${base}/session`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code, origin }),
		});
		if (again.ok) throw new Error("reused connect code was accepted (must be one-shot)");
		const err = (await again.json().catch(() => ({}))) as {
			error?: { code?: string; message?: string };
		};
		if (err.error?.code === undefined)
			throw new Error(`reuse rejection was not typed: ${JSON.stringify(err)}`);
		return `sid ${sv.sid.slice(0, 8)}… · reuse → ${err.error.code}`;
	});

	await check(calls, "session.origin-bound", async () => {
		const res = await signedFetch(base, "/code", "POST", { app, origin: otherOrigin });
		const j = (await res.json()) as { code: string };
		const bad = await fetch(`${base}/session`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: j.code, origin }),
		});
		if (bad.ok) throw new Error("session exchange accepted a mismatched origin");
		const err = (await bad.json().catch(() => ({}))) as {
			error?: { code?: string; message?: string };
		};
		if (!/bound to origin/i.test(err.error?.message ?? ""))
			throw new Error(`rejection missing origin detail: ${JSON.stringify(err)}`);
		return err.error?.code ?? "typed";
	});

	await check(calls, "mgmt.unsigned-rejected", async () => {
		const res = await fetch(`${base}/code`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ app, origin }),
		});
		if (res.status !== 401) throw new Error(`unsigned POST /code → HTTP ${res.status} (want 401)`);
		const err = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
		if (err.error?.code !== "UNAUTHORIZED")
			throw new Error(
				`unsigned request rejected as ${JSON.stringify(err.error)} (want UNAUTHORIZED)`,
			);
		return "401 UNAUTHORIZED";
	});

	await check(calls, "hello", async () => {
		const code = await mintAndParse(base, app, origin, opens.bridge);
		const sv = await exchange(base, code, origin);
		const actor = new PageActor();
		await actor.open(`ws://127.0.0.1:${opens.bridge}/session`);
		await actor.hello(PROTOCOL_VERSION, sv.sid, app, origin, "tab-conform");
		primaryActor = actor;
		primarySid = sv.sid;
		return `ack ${sv.sid.slice(0, 8)}…`;
	});

	await check(calls, "hello.origin-bound", async () => {
		const code = await mintAndParse(base, app, origin, opens.bridge);
		const sv = await exchange(base, code, origin);
		const actor = new PageActor();
		actor.respond = false;
		await actor.open(`ws://127.0.0.1:${opens.bridge}/session`);
		actor.send({
			type: "hello",
			v: PROTOCOL_VERSION,
			sid: sv.sid,
			app,
			origin: otherOrigin,
			tab: "tab-bad",
		});
		const err = await waitFor(
			() =>
				actor.frames.find((m) => m.type === "error") as
					| { code: string; message: string }
					| undefined,
			4000,
			"typed handshake error",
		);
		if (!/origin/i.test(err.message)) throw new Error(`error not origin-typed: ${err.message}`);
		await waitFor(() => (actor.socketClosed ? true : null), 4000, "socket close");
		actor.close();
		return err.code;
	});

	await check(calls, "tools.register", async () => {
		const actor = primaryActor;
		if (actor === null) throw new Error("no primary actor");
		prepareActor(actor); // echo / add / commit (write → consent)
		// give the register frames a moment of network lead over the /channels read
		await sleep(25);
		const chans = (await signedFetch(base, "/channels", "GET").then((r) => r.json())) as Array<{
			channel: string;
			app: string;
			origin: string;
			tabs: number;
			tools: string[];
		}>;
		const ch = chans.find((c) => hostKeyOf(c.origin) === hostKeyOf(origin));
		if (ch === undefined) throw new Error("channel for our origin not in /channels");
		if (ch.app !== app) throw new Error(`channel app "${ch.app}" ≠ ${app}`);
		if (!ch.tools.includes(bridgeToolName(origin, "echo")))
			throw new Error(`registered tool missing: ${JSON.stringify(ch.tools)}`);
		if (ch.tabs < 1) throw new Error("channel reports no attached tabs");
		return `${ch.channel} · ${ch.tools.length} tools · ${ch.tabs} tab`;
	});

	// ---- embedded-only: in-process bridge entry points (what the MCP server calls) ----

	if (embedded && embeddedBridge !== null) {
		const bridge = embeddedBridge;

		await check(calls, "tool.call.string", async () => {
			const r = await bridge.callTool(bridgeToolName(origin, "echo"), { text: "hello glassbox" });
			if (r.isError === true) throw new Error(`call failed: ${JSON.stringify(r)}`);
			const first = r.content[0];
			if (first === undefined || typeof first !== "object" || !("text" in first))
				throw new Error("no text content part");
			if ((first as { text?: string }).text !== "hello glassbox")
				throw new Error(`string result not coerced: ${JSON.stringify(first)}`);
			const m = await primaryActor!.next("tool.call", (x) => x.name === "echo", 4000);
			if (typeof m.deadlineMs !== "number" || m.deadlineMs <= 0)
				throw new Error("tool.call carries no deadlineMs");
			if (typeof m.traceId !== "string" || m.traceId.length === 0)
				throw new Error("tool.call carries no traceId");
			return "string → text part · deadlineMs + traceId on the wire";
		});

		await check(calls, "tool.call.object", async () => {
			const r = await bridge.callTool(bridgeToolName(origin, "add"), { a: 2, b: 3 });
			if (r.isError === true) throw new Error(`call failed: ${JSON.stringify(r)}`);
			if (JSON.stringify(r.structuredContent) !== JSON.stringify({ sum: 5 }))
				throw new Error(`structuredContent wrong: ${JSON.stringify(r.structuredContent)}`);
			return "object → structuredContent { sum: 5 }";
		});

		await check(calls, "consent.approve", async () => {
			primaryActor!.consentDecision = () => "approved";
			const r = await bridge.callTool(bridgeToolName(origin, "commit"), { x: 1 });
			if (r.isError === true) throw new Error(`approved call failed: ${JSON.stringify(r)}`);
			const m = await primaryActor!.next("consent.request", (x) => x.tool === "commit", 4000);
			if (m.tier !== "write") throw new Error(`consent.request tier "${String(m.tier)}" ≠ write`);
			return "write gated → approved → { ok: true }";
		});

		await check(calls, "consent.deny", async () => {
			const before = primaryActor!.calls.filter((c) => c.name === "commit").length;
			primaryActor!.consentDecision = () => "denied";
			const r = await bridge.callTool(bridgeToolName(origin, "commit"), { x: 2 });
			if (r.isError !== true) throw new Error("denied call was NOT an error");
			const sc = r.structuredContent as { code?: string } | undefined;
			if (sc?.code !== "CONSENT_DENIED")
				throw new Error(`denied call not CONSENT_DENIED: ${JSON.stringify(sc)}`);
			const duringClasses = primaryActor!.calls.filter((c) => c.name === "commit").length;
			if (duringClasses !== before)
				throw new Error("denied call still reached the page (no page traffic on deny)");
			primaryActor!.consentDecision = () => "approved";
			return "denied → CONSENT_DENIED · zero page traffic";
		});

		await check(calls, "sampling.round-trip", async () => {
			const r = await bridge.requestSampling(channelFrom(origin), {
				messages: [{ role: "user", content: "answer the number" }],
				maxTokens: 100,
				schema: { type: "object", properties: { answer: { type: "string" } } },
			});
			if (r.type !== "sampling.result")
				throw new Error(`sampling answered ${r.type}: ${JSON.stringify(r)}`);
			const v = r.value as { answer?: string; schemaHonored?: boolean };
			if (v?.answer !== "42" || v.schemaHonored !== true)
				throw new Error(`sampling value wrong: ${JSON.stringify(v)}`);
			return "schema-honored answer round-tripped";
		});
	} else if (!embedded) {
		skip(
			calls,
			"tool.call.string",
			"external mode: needs the in-process bridge (run without --port for the full suite)",
		);
		skip(calls, "tool.call.object", "external mode");
		skip(calls, "consent.approve", "external mode");
		skip(calls, "consent.deny", "external mode");
		skip(calls, "sampling.round-trip", "external mode");
	}

	// ---- drop + (embedded) audit on disk ----

	await check(calls, "drop", async () => {
		if (primarySid === null || primaryActor === null) throw new Error("no primary session to drop");
		const res = await signedFetch(base, "/drop", "POST", { sid: primarySid });
		if (!res.ok) throw new Error(`POST /drop → HTTP ${res.status}: ${await res.text()}`);
		const j = (await res.json()) as { ok?: boolean };
		if (j.ok !== true) throw new Error(`drop confirmed ${JSON.stringify(j)}`);
		const actor = primaryActor;
		await waitFor(
			() => (actor.revoked !== null ? actor.revoked : null),
			4000,
			"session.revoke on the page",
		);
		return `session.revoke(${actor.revoked}) · socket closed`;
	});

	if (embedded) {
		await check(calls, "audit.lines", async () => {
			const entries = readAuditEntries(auditPath);
			if (entries.length === 0) throw new Error(`audit file is empty (${auditPath})`);
			const has = (s: AuditEntry["status"], pred: (e: AuditEntry) => boolean = () => true) =>
				entries.some((e) => e.status === s && pred(e));
			if (!has("session")) throw new Error("no session audit line");
			const registers = entries.filter(
				(e) => e.status === "register" && e.channel === channelFrom(origin),
			);
			if (registers.length < 3)
				throw new Error(`only ${registers.length} register lines (want ≥ 3)`);
			if (
				!entries.every(
					(e) => typeof e.ts === "number" && typeof e.traceId === "string" && e.traceId.length > 0,
				)
			)
				throw new Error("audit line missing ts/traceId");
			const okLines = entries.filter((e) => e.status === "ok");
			for (const e of okLines) {
				if (e.consent === undefined || e.argsHash === undefined)
					throw new Error(`audit ${JSON.stringify(e)} missing consent/argsHash`);
				if (/^[0-9a-f]{16}$/.test(e.argsHash) !== true)
					throw new Error(`argsHash not 16 hex: ${e.argsHash}`);
			}
			if (!okLines.some((e) => e.consent === "auto"))
				throw new Error("no auto-consent ok line (read tier)");
			if (!okLines.some((e) => e.consent === "approved"))
				throw new Error("no approved-consent ok line (write tier)");
			if (!entries.some((e) => e.status === "error" && e.consent === "denied"))
				throw new Error("no denied-consent error line");
			if (!entries.some((e) => e.status === "revoke")) throw new Error("no revoke audit line");
			if (!entries.some((e) => e.status === "impersonation"))
				throw new Error("no impersonation line (unsigned /code)");
			return `${entries.length} lines · session/register/ok/approved/denied/revoke/impersonation all present`;
		});
	}

	// ---- teardown (or hold) ----

	if (embedded && opts.hold !== true) await closeBridge?.();
	if (embedded && opts.hold !== true) await actorTeardown(primaryActor);
	if (embedded && opts.hold !== true) safeRm(auditDir);

	return finishReport(calls, t0, {
		mode: embedded ? "embedded" : "external",
		opens,
		pageUrl,
		app,
		origin,
		hold: embedded && opts.hold === true,
	});
}

function urlOrigin(u: string): string {
	try {
		return new URL(u).origin;
	} catch {
		return u;
	}
}

function actorTeardown(actor: PageActor | null): Promise<void> {
	actor?.close();
	return Promise.resolve();
}

function safeRm(p: string): void {
	try {
		rmSync(p, { recursive: true, force: true });
	} catch {
		// best effort
	}
}

function finishReport(
	calls: ConformanceCheck[],
	t0: number,
	info: {
		mode: "embedded" | "external";
		opens: { bridge: number; page?: number };
		pageUrl?: string;
		app?: string;
		origin?: string;
		hold?: boolean;
	},
): ConformanceReport {
	const failed = calls.filter((c) => !c.ok);
	const skipped = calls.filter((c) => c.skipped !== undefined).length;
	const passed = calls.length - failed.length - skipped;
	const ms = Date.now() - t0;
	const bits = [info.mode, `${(ms / 1000).toFixed(2)}s`];
	if (skipped > 0) bits.push(`${skipped} skipped`);
	if (info.pageUrl !== undefined) bits.push(`page ${info.pageUrl}`);
	const tally = `${failed.length === 0 ? "PASS" : "FAIL"} ${passed}/${calls.length} checks`;
	const summary =
		failed.length === 0
			? `glassbox test: ${tally} (${bits.join(" · ")})` +
				(info.hold ? " · fixture held alive (--hold)" : "")
			: `glassbox test: ${tally} — failed: ${failed.map((f) => f.name).join(", ")} (${bits.join(" · ")})`;
	const report: ConformanceReport = {
		ok: failed.length === 0,
		mode: info.mode,
		summary,
		checks: calls,
		bridgeUrl: `ws://127.0.0.1:${info.opens.bridge}/session`,
		opens: info.opens,
	};
	if (info.app !== undefined) report.app = info.app;
	if (info.pageUrl !== undefined) report.pageUrl = info.pageUrl;
	if (info.origin !== undefined) report.origin = info.origin;
	if (info.hold !== undefined) report.hold = info.hold;
	return report;
}

function externalModeOriginHint(): string {
	return "--port N needs the page origin: pass --origin http://host:port (or --page, which also verifies its live channel)";
}

/** Register the fixture's tools on an actor (the echo-app surface, spec §9.2). */
function prepareActor(actor: PageActor): void {
	actor.registerTool("echo", "Echo a string back", undefined, (a) => a.text);
	actor.registerTool("add", "Sum two numbers", "read", (a) => ({ sum: Number(a.a) + Number(a.b) }));
	actor.registerTool("commit", "Write a marker (consent-gated)", "write", () => ({ ok: true }));
}
