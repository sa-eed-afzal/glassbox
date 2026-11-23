/**
 * Host (spec §5.1, §5.2, §5.5, §7.1): the SAME protocol core exercised over a REAL
 * in-process WebSocket link on 127.0.0.1 with an ephemeral port — not just the
 * in-memory pair. Covers: loopback bind, code→session over HTTP, hello handshake,
 * registration, dispatch+coercion, deadlines, and session refresh across reload.
 */
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Bridge } from "../src/bridge/bridge.js";
import { autoPolicy } from "../src/bridge/policy.js";
import { FakeClock } from "../src/core/clock.js";
import { GlassboxErrorCode } from "../src/core/errors.js";
import { bridgeToolName } from "../src/core/naming.js";
import { PROTOCOL_VERSION } from "../src/core/version.js";
import { createHost, type Host } from "../src/host/host.js";

const ORIGIN = "http://localhost:8123";
const APP = "echo-app";

type WireMsg = { type: string } & Record<string, unknown>;

/** Minimal WS test client: enqueues frames, supports onFrame replies (the page half). */
class TestPage {
	onFrame: ((m: WireMsg) => void) | null = null;
	closed = false;
	private ws: WebSocket;
	private queue: WireMsg[] = [];
	private waiters: Array<(m: WireMsg) => void> = [];
	private closeWaiters: Array<() => void> = [];

	constructor(url: string) {
		this.ws = new WebSocket(url);
		this.ws.on("message", (data) => {
			const m = JSON.parse(String(data)) as WireMsg;
			if (this.onFrame) {
				this.onFrame(m);
				return;
			}
			const w = this.waiters.shift();
			if (w) w(m);
			else this.queue.push(m);
		});
		this.ws.on("close", () => {
			this.closed = true;
			for (const w of this.closeWaiters.splice(0)) w();
		});
	}

	send(m: unknown): void {
		this.ws.send(JSON.stringify(m));
	}

	frame(timeoutMs = 5000): Promise<WireMsg> {
		const q = this.queue.shift();
		if (q) return Promise.resolve(q);
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
			this.waiters.push((m) => {
				clearTimeout(t);
				resolve(m);
			});
		});
	}

	waitForOpen(timeoutMs = 5000): Promise<void> {
		if (this.ws.readyState === 1) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("timed out waiting for ws open")), timeoutMs);
			this.ws.once("open", () => {
				clearTimeout(t);
				resolve();
			});
		});
	}

	waitForClose(timeoutMs = 5000): Promise<void> {
		if (this.closed) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("timed out waiting for ws close")), timeoutMs);
			this.closeWaiters.push(() => {
				clearTimeout(t);
				resolve();
			});
		});
	}

	close(): void {
		this.ws.close();
	}
}

async function post(
	port: number,
	path: string,
	body: unknown,
): Promise<{ status: number; json: WireMsg }> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as WireMsg };
}

async function get(port: number, path: string): Promise<{ status: number; json: unknown }> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`);
	const json = (await res.json()) as unknown;
	return { status: res.status, json };
}

function newBridge(clock: FakeClock | null = null) {
	const bridge = new Bridge({
		serverVersion: "0.1.0",
		policy: autoPolicy(),
		...(clock ? { clock } : {}),
	});
	return bridge;
}

describe("host: real-WS round-trips (spec §5.1, §5.2, §5.5, §7.1)", () => {
	const hosts: Host[] = [];
	afterAll(async () => {
		for (const h of hosts.splice(0)) await h.close();
	});
	async function start(
		clock: FakeClock | null = null,
	): Promise<{ bridge: Bridge; host: Host; port: number }> {
		const bridge = newBridge(clock);
		const host = await createHost(bridge);
		hosts.push(host);
		return { bridge, host, port: host.endpoint.port };
	}

	it("answers the CORS preflight for the cross-origin session exchange (spec §7.1)", async () => {
		const { port } = await start();
		const pre = await fetch(`http://127.0.0.1:${port}/session`, { method: "OPTIONS" });
		expect(pre.status).toBe(204);
		expect(pre.headers.get("access-control-allow-origin")).toBe("*");
		expect(pre.headers.get("access-control-allow-headers")).toBe("content-type");
		expect(pre.headers.get("access-control-allow-methods")?.includes("POST")).toBe(true);
	});

	it("binds 127.0.0.1 on an ephemeral port and reports health", async () => {
		const { host, port } = await start();
		expect(host.endpoint.host).toBe("127.0.0.1");
		expect(host.endpoint.port).toBeGreaterThanOrEqual(1024);
		expect(host.endpoint.port).toBeLessThan(65536);
		const health = await get(port, "/health");
		expect(health.status).toBe(200);
		expect((health.json as WireMsg).ok).toBe(true);
		expect((health.json as WireMsg).v).toBe(PROTOCOL_VERSION);
	});

	it("code→session over HTTP, hello over WS, register, call, coerced result", async () => {
		const { bridge, port } = await start();
		const mint = bridge.mintCode({ app: APP, origin: ORIGIN });

		// 1. code → session (spec §5.2)
		const sess = await post(port, "/session", { code: mint.code });
		expect(sess.status).toBe(200);
		expect(sess.json.sid).toBeTruthy();
		expect(sess.json.sessionToken).toBeTruthy();
		expect(sess.json.channel).toBe("localhost-8123");
		expect(sess.json.endpoint).toBe(`ws://127.0.0.1:${port}/session`);

		// 2. WS hello → hello.ack (spec §5.1)
		const page = new TestPage(String(sess.json.endpoint));
		await page.waitForOpen();
		page.send({
			type: "hello",
			v: PROTOCOL_VERSION,
			sid: String(sess.json.sid),
			app: APP,
			origin: ORIGIN,
			tab: "t1",
		});
		const ack = await page.frame();
		expect(ack.type).toBe("hello.ack");
		expect(ack.v).toBe(PROTOCOL_VERSION);
		expect(ack.expiresMs).toBeGreaterThan(0);

		// 3. registration (spec §5.3)
		page.send({ type: "tool.register", name: "add", description: "Sum", tier: "read" });
		await new Promise((r) => setTimeout(r, 50));
		const name = bridgeToolName(ORIGIN, "add");
		expect(bridge.listTools().map((t) => t.bridgeName)).toContain(name);

		// 4. dispatch → page replies over WS → coerced MCP result (spec §5.4)
		page.onFrame = (m) => {
			if (m.type === "tool.call") {
				const args = m.args as { a: number; b: number };
				page.send({ type: "tool.result", id: m.id, value: { sum: args.a + args.b } });
			}
		};
		const r = await bridge.callTool(name, { a: 2, b: 3 });
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent).toEqual({ sum: 5 });

		// 5. discovery surfaces the channel (spec §6)
		const ch = await get(port, "/channels");
		expect(ch.status).toBe(200);
		const chans = ch.json as Array<WireMsg & { tools: string[] }>;
		expect(chans.length).toBe(1);
		expect(chans[0]!.tools).toContain(name);

		page.close();
	});

	it("enforces the deadline when the page never responds (spec §5.5)", async () => {
		const { bridge, port } = await start();
		const sess = await post(port, "/session", {
			code: bridge.mintCode({ app: APP, origin: ORIGIN }).code,
		});
		const page = new TestPage(String(sess.json.endpoint));
		await page.waitForOpen();
		page.send({
			type: "hello",
			v: PROTOCOL_VERSION,
			sid: String(sess.json.sid),
			app: APP,
			origin: ORIGIN,
			tab: "t",
		});
		await page.frame();
		page.send({
			type: "tool.register",
			name: "hang",
			description: "Never resolves",
			tier: "write",
			timeoutMs: 500,
		});
		await new Promise((r) => setTimeout(r, 50));
		const r = await bridge.callTool(bridgeToolName(ORIGIN, "hang"), {}, { timeoutMs: 150 });
		expect(r.isError).toBe(true);
		expect((r.structuredContent as { code: string }).code).toBe(GlassboxErrorCode.DEADLINE);
		page.close();
	});

	it("rejects an unknown code at POST /session with a typed error", async () => {
		const { port } = await start();
		const r = await post(port, "/session", { code: "not-a-real-code" });
		expect(r.status).toBe(400);
		expect((r.json.error as WireMsg).code).toBe(GlassboxErrorCode.PROTOCOL_ERROR);
	});

	it("rejects an expired code with DEADLINE (HTTP 401)", async () => {
		const clock = new FakeClock();
		const { bridge, port } = await start(clock);
		const code = bridge.mintCode({ app: APP, origin: ORIGIN }).code;
		clock.advance(61_000);
		const r = await post(port, "/session", { code });
		expect(r.status).toBe(401);
		expect((r.json.error as WireMsg).code).toBe(GlassboxErrorCode.DEADLINE);
	});

	it("fails the WS handshake on a version mismatch (spec §5.1)", async () => {
		const { bridge, port } = await start();
		const sess = await post(port, "/session", {
			code: bridge.mintCode({ app: APP, origin: ORIGIN }).code,
		});
		const page = new TestPage(String(sess.json.endpoint));
		await page.waitForOpen();
		page.send({
			type: "hello",
			v: "glassbox/v2",
			sid: String(sess.json.sid),
			app: APP,
			origin: ORIGIN,
			tab: "t",
		});
		const err = await page.frame();
		expect(err.type).toBe("error");
		expect(err.code).toBe(GlassboxErrorCode.VERSION_MISMATCH);
		await page.waitForClose();
	});

	it("rejects a hello for an unknown session", async () => {
		const { port } = await start();
		const page = new TestPage(`ws://127.0.0.1:${port}/session`);
		await page.waitForOpen();
		page.send({
			type: "hello",
			v: PROTOCOL_VERSION,
			sid: "never-issued",
			app: APP,
			origin: ORIGIN,
			tab: "t",
		});
		const err = await page.frame();
		expect(err.type).toBe("error");
		expect(err.code).toBe(GlassboxErrorCode.PROTOCOL_ERROR);
		await page.waitForClose();
	});

	it("session survives a page reload: refresh with sid+sessionToken, reconnect, re-register (spec §5.2)", async () => {
		const { bridge, port } = await start();
		const sess = await post(port, "/session", {
			code: bridge.mintCode({ app: APP, origin: ORIGIN }).code,
		});
		const sid = String(sess.json.sid);
		const token = String(sess.json.sessionToken);

		// first load: register + detach (page closes / reloads)
		let page = new TestPage(`ws://127.0.0.1:${port}/session`);
		await page.waitForOpen();
		page.send({ type: "hello", v: PROTOCOL_VERSION, sid, app: APP, origin: ORIGIN, tab: "t1" });
		await page.frame();
		page.send({ type: "tool.register", name: "echo", description: "Echo" });
		await new Promise((r) => setTimeout(r, 50));
		expect(bridge.listTools().length).toBe(1);
		page.close();
		await page.waitForClose();
		// detach prunes the tool (no live session)
		await new Promise((r) => setTimeout(r, 50));
		expect(bridge.listTools().length).toBe(0);

		// reload: re-auth with the stored sid+token (no new connect code — spec §5.2, §7.2)
		const refresh = await post(port, "/session", { sid, sessionToken: token });
		expect(refresh.status).toBe(200);
		expect(refresh.json.sid).toBe(sid);

		// reconnect + re-register (the SDK does both on load)
		page = new TestPage(`ws://127.0.0.1:${port}/session`);
		await page.waitForOpen();
		page.send({ type: "hello", v: PROTOCOL_VERSION, sid, app: APP, origin: ORIGIN, tab: "t2" });
		const ack = await page.frame();
		expect(ack.type).toBe("hello.ack");
		page.send({ type: "tool.register", name: "echo", description: "Echo" });
		await new Promise((r) => setTimeout(r, 50));
		const name = bridgeToolName(ORIGIN, "echo");
		expect(bridge.listTools().length).toBe(1);
		page.onFrame = (m) => {
			if (m.type === "tool.call")
				page.send({ type: "tool.result", id: m.id, value: { reloaded: true } });
		};
		const r = await bridge.callTool(name, {});
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent).toEqual({ reloaded: true });
		page.close();
	});
});
