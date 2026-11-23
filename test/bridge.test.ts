/**
 * Bridge core (spec §5.2, §5.3, §5.5): code→session exchange, registration,
 * canonical names, deadline enforcement, channel pruning, audit. Deterministic
 * via FakeClock + ManualScheduler.
 */
import { describe, expect, it } from "vitest";
import { InMemoryAudit } from "../src/bridge/audit.js";
import { Bridge } from "../src/bridge/bridge.js";
import { autoPolicy } from "../src/bridge/policy.js";
import { ManualScheduler } from "../src/bridge/scheduler.js";
import { FakeClock } from "../src/core/clock.js";
import { decode, encode, type PageToBridgeMsg } from "../src/core/codec.js";
import { GlassboxErrorCode, isGlassboxError } from "../src/core/errors.js";
import { bridgeToolName } from "../src/core/naming.js";
import { PROTOCOL_VERSION } from "../src/core/version.js";
import { flush, makePair } from "./link.js";

const ORIGIN = "http://localhost:8123";
const APP = "echo-app";

function newBridge(policy = autoPolicy()) {
	const clock = new FakeClock();
	const scheduler = new ManualScheduler();
	const audit = new InMemoryAudit();
	const bridge = new Bridge({ serverVersion: "0.1.0", clock, scheduler, audit, policy });
	bridge.setEndpoint("127.0.0.1", 8123);
	return { bridge, clock, scheduler, audit };
}

function connect(bridge: Bridge) {
	const { a, b } = makePair();
	const code = bridge.mintCode({ app: APP, origin: ORIGIN });
	const view = bridge.issueSession(code.code);
	bridge.hello(view.sid, {
		type: "hello",
		v: PROTOCOL_VERSION,
		sid: view.sid,
		app: APP,
		origin: ORIGIN,
		tab: "t1",
	});
	bridge.attach(view.sid, a);
	const page = {
		received: [] as unknown[],
		send: (msg: unknown) => b.send(encode(msg as unknown as PageToBridgeMsg)),
		onFrame: null as null | ((m: { type: string; [k: string]: unknown }) => void),
	};
	b.onMessage((frame) => {
		const m = decode(frame) as unknown as { type: string } & Record<string, unknown>;
		page.received.push(m);
		page.onFrame?.(m);
	});
	a.onMessage((frame) => bridge.deliver(view.sid, decode(frame) as PageToBridgeMsg));
	return { view, page };
}

describe("bridge: code→session (spec §5.2)", () => {
	it("issues a session from a one-shot code and rejects reuse", () => {
		const { bridge } = newBridge();
		const code = bridge.mintCode({ app: APP, origin: ORIGIN });
		const view = bridge.issueSession(code.code);
		expect(view.sid).toBeTruthy();
		expect(view.sessionToken).toBeTruthy();
		expect(view.channel).toBe("localhost-8123");
		expect(() => bridge.issueSession(code.code)).toThrowError();
	});

	it("rejects an unknown code with a typed error", () => {
		const { bridge } = newBridge();
		try {
			bridge.issueSession("not-a-real-code");
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(isGlassboxError(e)).toBe(true);
		}
	});

	it("expires a code after its TTL", () => {
		const { bridge, clock } = newBridge();
		const code = bridge.mintCode({ app: APP, origin: ORIGIN });
		clock.advance(61_000);
		try {
			bridge.issueSession(code.code);
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(isGlassboxError(e)).toBe(true);
			if (isGlassboxError(e)) expect(e.code).toBe(GlassboxErrorCode.DEADLINE);
		}
	});

	it("refuses to refresh with a bad session token", () => {
		const { bridge } = newBridge();
		const view = bridge.issueSession(bridge.mintCode({ app: APP, origin: ORIGIN }).code);
		expect(() => bridge.refreshSession(view.sid, "wrong-token")).toThrowError();
	});
});

describe("bridge: handshake (spec §5.1)", () => {
	it("accepts a valid hello and rejects a version mismatch", () => {
		const { bridge } = newBridge();
		const view = bridge.issueSession(bridge.mintCode({ app: APP, origin: ORIGIN }).code);
		const ack = bridge.hello(view.sid, {
			type: "hello",
			v: PROTOCOL_VERSION,
			sid: view.sid,
			app: APP,
			origin: ORIGIN,
			tab: "t",
		});
		expect(ack.type).toBe("hello.ack");
		try {
			bridge.hello(view.sid, {
				type: "hello",
				v: "glassbox/v2",
				sid: view.sid,
				app: APP,
				origin: ORIGIN,
				tab: "t",
			});
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(isGlassboxError(e)).toBe(true);
			if (isGlassboxError(e)) expect(e.code).toBe(GlassboxErrorCode.VERSION_MISMATCH);
		}
	});

	it("rejects an unknown session on hello", () => {
		const { bridge } = newBridge();
		expect(() =>
			bridge.hello("bogus", {
				type: "hello",
				v: PROTOCOL_VERSION,
				sid: "bogus",
				app: APP,
				origin: ORIGIN,
				tab: "t",
			}),
		).toThrowError();
	});
});

describe("bridge: registration + canonical names (spec §5.3, §5.6)", () => {
	it("lists a registered tool under its canonical bridge name and fires change", async () => {
		const { bridge } = newBridge();
		const { page } = connect(bridge);
		let changed = 0;
		bridge.onToolsChanged = () => {
			changed++;
		};
		page.send({
			type: "tool.register",
			name: "Play Move (now!)",
			description: "Clear the group",
			tier: "write",
		});
		await flush();
		const tools = bridge.listTools();
		expect(tools.map((t) => t.bridgeName)).toEqual([bridgeToolName(ORIGIN, "Play Move (now!)")]);
		expect(tools[0]!.tier).toBe("write");
		expect(changed).toBeGreaterThanOrEqual(1);
	});

	it("unregister removes the tool from the channel", async () => {
		const { bridge } = newBridge();
		const { page } = connect(bridge);
		page.send({ type: "tool.register", name: "echo", description: "Echo" });
		await flush();
		expect(bridge.listTools().length).toBe(1);
		page.send({ type: "tool.unregister", name: "echo" });
		await flush();
		expect(bridge.listTools().length).toBe(0);
	});
});

describe("bridge: dispatch + coercion (spec §5.4)", () => {
	it("dispatches a call and coerces the page value", async () => {
		const { bridge } = newBridge();
		const { page } = connect(bridge);
		page.send({ type: "tool.register", name: "add", description: "Sum", tier: "read" });
		await flush();
		page.onFrame = (m) => {
			if (m.type === "tool.call") {
				page.send({
					type: "tool.result",
					id: m.id as number,
					value: {
						sum: (m.args as { a: number; b: number }).a + (m.args as { a: number; b: number }).b,
					},
				});
			}
		};
		const r = await bridge.callTool(bridgeToolName(ORIGIN, "add"), { a: 2, b: 3 });
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent).toEqual({ sum: 5 });
	});

	it("returns a typed UNKNOWN_TOOL for an unknown tool", async () => {
		const { bridge } = newBridge();
		connect(bridge);
		await flush();
		const r = await bridge.callTool("localhost-8123__nope", {});
		expect(r.isError).toBe(true);
		expect((r.structuredContent as { code: string }).code).toBe(GlassboxErrorCode.UNKNOWN_TOOL);
	});

	it("returns DEADLINE when the page never responds", async () => {
		const { bridge, scheduler } = newBridge();
		const { page } = connect(bridge);
		page.send({
			type: "tool.register",
			name: "hang",
			description: "Never resolves",
			tier: "write",
		});
		await flush();
		const p = bridge.callTool(bridgeToolName(ORIGIN, "hang"), {}, { timeoutMs: 100 });
		scheduler.fireAll();
		const r = await p;
		expect(r.isError).toBe(true);
		expect((r.structuredContent as { code: string }).code).toBe(GlassboxErrorCode.DEADLINE);
	});

	it("returns a typed error when the page throws", async () => {
		const { bridge } = newBridge();
		const { page } = connect(bridge);
		page.send({ type: "tool.register", name: "boom", description: "Throws", tier: "read" });
		await flush();
		page.onFrame = (m) => {
			if (m.type === "tool.call") {
				page.send({
					type: "tool.result",
					id: m.id as number,
					error: { code: "PAGE_ERROR", message: "kaboom" },
				});
			}
		};
		const r = await bridge.callTool(bridgeToolName(ORIGIN, "boom"), {});
		expect(r.isError).toBe(true);
		expect(r.content[0]!.text).toBe("kaboom");
	});
});

describe("bridge: lifecycle (spec §5.2, §8)", () => {
	it("prunes the channel's tools when the last session detaches", async () => {
		const { bridge } = newBridge();
		const { page, view } = connect(bridge);
		page.send({ type: "tool.register", name: "echo", description: "Echo" });
		await flush();
		expect(bridge.listTools().length).toBe(1);
		bridge.detach(view.sid);
		expect(bridge.listTools().length).toBe(0);
	});

	it("abandons in-flight calls with a typed DEADLINE on detach", async () => {
		const { bridge } = newBridge();
		const { page, view } = connect(bridge);
		page.send({ type: "tool.register", name: "hang", description: "Hangs", tier: "write" });
		await flush();
		const p = bridge.callTool(bridgeToolName(ORIGIN, "hang"), {}, { timeoutMs: 60_000 });
		bridge.detach(view.sid);
		const r = await p;
		expect(r.isError).toBe(true);
		expect((r.structuredContent as { code: string }).code).toBe(GlassboxErrorCode.DEADLINE);
	});

	it("records an audit entry per call", async () => {
		const { bridge, audit } = newBridge();
		const { page } = connect(bridge);
		page.send({ type: "tool.register", name: "echo", description: "Echo" });
		await flush();
		page.onFrame = (m) => {
			if (m.type === "tool.call")
				page.send({ type: "tool.result", id: m.id as number, value: "ok" });
		};
		await bridge.callTool(bridgeToolName(ORIGIN, "echo"), {});
		expect(audit.entries.some((e) => e.status === "ok" && e.channel === "localhost-8123")).toBe(
			true,
		);
	});
});
