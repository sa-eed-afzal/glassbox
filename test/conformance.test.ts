/**
 * M0 conformance (spec §9.2): the fixture echo-app + bridge harness run the
 * full catalogue over the real codec — 10 round-trips, all typed.
 */
import { describe, expect, it } from "vitest";
import { createEchoApp } from "../fixtures/echo-app/page.js";
import { FakeClock } from "../src/core/clock.js";
import { decode, encode } from "../src/core/codec.js";
import { GlassboxErrorCode } from "../src/core/errors.js";
import { bridgeToolName } from "../src/core/naming.js";
import { createBridgeHarness } from "./harness.js";
import { flush, makePair } from "./link.js";

const ORIGIN = "http://localhost:8123";

function setup() {
	const { a, b } = makePair();
	const clock = new FakeClock();
	const bridge = createBridgeHarness(a, clock);
	const page = createEchoApp(b, ORIGIN);
	return { bridge, page, clock };
}

describe("conformance: echo-app ⇄ bridge (glassbox/v1)", () => {
	it("1. hello handshake → hello.ack", async () => {
		const { bridge, page } = setup();
		page.hello();
		await flush();
		expect(page.ready).toBe(true);
		expect(bridge.pageMessages.some((m) => m.type === "hello")).toBe(true);
	});

	it("2. version mismatch → typed VERSION_MISMATCH error", async () => {
		const { a, b } = makePair();
		const bridge = createBridgeHarness(a);
		let wireError_: { code: string; message: string } | undefined;
		b.onMessage((frame) => {
			const m = decode(frame) as { type: string; code?: string; message?: string };
			if (m.type === "error") wireError_ = { code: m.code!, message: m.message! };
		});
		b.send(
			encode({ type: "hello", v: "glassbox/v2", sid: "s", app: "x", origin: ORIGIN, tab: "t" }),
		);
		await flush();
		expect(wireError_?.code).toBe(GlassboxErrorCode.VERSION_MISMATCH);
		expect(bridge.pageMessages.some((m) => m.type === "hello")).toBe(true);
	});

	it("3. tool registration lands with canonical bridge names", async () => {
		const { bridge, page } = setup();
		page.hello();
		await flush();
		page.register("echo", "Echo a string back", "read");
		page.register("add", "Sum two numbers", "read");
		page.register("hang", "Never resolves", "write");
		await flush();
		expect(bridge.registered.size).toBe(3);
		expect(bridge.registered.get("echo")?.tier).toBe("read");
		expect(bridgeToolName(ORIGIN, "echo")).toBe("localhost-8123__echo");
	});

	it('4. call "echo" → text result', async () => {
		const { bridge, page } = setup();
		page.hello();
		page.register("echo", "Echo a string back");
		await flush();
		const r = await bridge.call("echo", { text: "hello glassbox" });
		expect(r.isError).toBeUndefined();
		expect(r.content[0]!.text).toBe("hello glassbox");
		const phases = bridge.events.map((e) => e.phase);
		expect(phases[0]).toBe("start");
		expect(phases.at(-1)).toBe("end");
	});

	it('5. call "add" → structured + text result', async () => {
		const { bridge, page } = setup();
		page.hello();
		page.register("add", "Sum two numbers");
		await flush();
		const r = await bridge.call("add", { a: 2, b: 3 });
		expect(r.structuredContent).toEqual({ sum: 5 });
		expect(JSON.parse(r.content[0]!.text)).toEqual({ sum: 5 });
	});

	it("6. unknown tool → typed UNKNOWN_TOOL error result", async () => {
		const { bridge, page } = setup();
		page.hello();
		page.register("echo", "Echo");
		await flush();
		const r = await bridge.call("does_not_exist", {});
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toMatchObject({ code: GlassboxErrorCode.UNKNOWN_TOOL });
	});

	it("7. hanging call → DEADLINE error (deterministic clock)", async () => {
		const { bridge, page, clock } = setup();
		page.hello();
		page.register("hang", "Never resolves");
		await flush();
		const p = bridge.call("hang", {}, 100);
		clock.advance(150);
		bridge.tick();
		const r = await p;
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toMatchObject({
			code: GlassboxErrorCode.DEADLINE,
			traceId: expect.stringMatching(/^tr-\d+$/),
		});
	});

	it("8. resource request → contents result", async () => {
		const { bridge, page } = setup();
		page.hello();
		await flush();
		const r = await bridge.requestResource("board://state");
		expect(r.type).toBe("resource.result");
		if (r.type === "resource.result") {
			expect(r.contents?.[0]).toMatchObject({ uri: "board://state" });
		}
	});

	it("9. prompt request → messages result", async () => {
		const { bridge, page } = setup();
		page.hello();
		await flush();
		const r = await bridge.requestPrompt("explain", { why: "tests" });
		expect(r.type).toBe("prompt.result");
		if (r.type === "prompt.result") {
			expect(r.messages?.[0]).toMatchObject({ role: "user" });
		}
	});

	it("10. sampling request (with schema) → validated answer", async () => {
		const { bridge, page } = setup();
		page.hello();
		await flush();
		const r = await bridge.requestSampling([{ role: "user", content: "answer the number" }], 100, {
			type: "object",
			properties: { answer: { type: "string" } },
		});
		expect(r.type).toBe("sampling.result");
		if (r.type === "sampling.result") {
			expect(r.value).toEqual({ answer: "42", schemaHonored: true });
		}
	});
});
