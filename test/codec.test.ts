import { describe, expect, it } from "vitest";
import { decode, encode, type GlassboxMessage, roundTrip } from "../src/core/codec.js";
import { type GlassboxError, GlassboxErrorCode, isGlassboxError } from "../src/core/errors.js";

const corpus: GlassboxMessage[] = [
	{
		type: "hello",
		v: "glassbox/v1",
		sid: "s1",
		app: "mygame",
		origin: "http://localhost:8123",
		tab: "t1",
	},
	{ type: "hello.ack", v: "glassbox/v1", server: "mcp-glassbox/0.1.0", expiresMs: 1800000 },
	{ type: "error", code: "X", message: "boom" },
	{ type: "error", code: "X", message: "boom", traceId: "tr-1" },
	{
		type: "tool.register",
		name: "play_move",
		description: "Clear group",
		tier: "write",
		timeoutMs: 5000,
	},
	{ type: "tool.unregister", name: "play_move" },
	{
		type: "tool.call",
		id: 7,
		name: "play_move",
		args: { x: 1, y: 2 },
		deadlineMs: 5000,
		traceId: "tr-7",
	},
	{ type: "tool.result", id: 7, value: { played: true } },
	{ type: "tool.result", id: 8, error: { code: "PAGE_ERROR", message: "nope" } },
	{ type: "prompt.request", id: 9, name: "explain", args: { why: "x" } },
	{ type: "prompt.result", id: 9, messages: [{ role: "user", content: "hi" }] },
	{ type: "resource.request", id: 10, uri: "board://state" },
	{ type: "resource.result", id: 10, contents: [{ uri: "board://state", text: "[]" }] },
	{
		type: "sampling.request",
		id: 11,
		messages: [{ role: "user", content: "q" }],
		maxTokens: 100,
		schema: { type: "object" },
	},
	{ type: "sampling.result", id: 11, value: { answer: "42" } },
	{ type: "call.event", id: 12, phase: "start" },
	{ type: "call.event", id: 12, phase: "end", ms: 12 },
	{
		type: "consent.request",
		id: 13,
		tool: "play_move",
		description: "Clear group at x,y",
		args: { x: 1, y: 2 },
		tier: "write",
		deadlineMs: 120000,
	},
	{ type: "consent.result", id: 13, decision: "approved" },
	{ type: "session.revoke", reason: "user-disconnect" },
];

describe("codec (spec §5.8)", () => {
	it("round-trips the full message catalogue", () => {
		for (const msg of corpus) {
			expect(roundTrip(msg)).toEqual(msg);
		}
	});

	it("encode produces single-line JSON", () => {
		const s = encode(corpus[0]!);
		expect(s).not.toContain("\n");
		expect(JSON.parse(s)).toEqual(corpus[0]);
	});

	it.each([
		["non-JSON", "this is not json"],
		["array frame", "[1,2,3]"],
		["null frame", "null"],
		["missing type", '{"v":"x"}'],
		["unknown type", '{"type":"teleport","x":1}'],
	])("decode rejects %s", (_label, frame) => {
		expect(() => decode(frame)).toThrowError();
	});

	it("enforces required fields per type", () => {
		expect(() => decode(JSON.stringify({ type: "hello", v: "glassbox/v1" }))).toThrowError();
		expect(() =>
			decode(JSON.stringify({ type: "tool.call", id: 1, name: "x", deadlineMs: 1, traceId: "t" })),
		).not.toThrow();
		expect(() =>
			decode(
				JSON.stringify({ type: "tool.call", id: "one", name: "x", deadlineMs: 1, traceId: "t" }),
			),
		).toThrowError();
		expect(() =>
			decode(JSON.stringify({ type: "sampling.request", id: 1, messages: "no", maxTokens: 5 })),
		).toThrowError();
	});

	it("error frames accept an optional traceId (M3)", () => {
		expect(() =>
			decode(JSON.stringify({ type: "error", code: "X", message: "m", traceId: "tr-1" })),
		).not.toThrow();
		expect(() =>
			decode(JSON.stringify({ type: "error", code: "X", message: "m", traceId: 12 })),
		).toThrowError();
	});

	it("enforces value XOR error on result messages", () => {
		expect(() => decode(JSON.stringify({ type: "tool.result", id: 1 }))).toThrowError();
		expect(() =>
			decode(
				JSON.stringify({
					type: "tool.result",
					id: 1,
					value: 1,
					error: { code: "A", message: "b" },
				}),
			),
		).toThrowError();
		expect(() =>
			decode(JSON.stringify({ type: "tool.result", id: 1, error: { code: "A" } })),
		).toThrowError();
	});

	it("enforces the tier enum", () => {
		expect(() =>
			decode(
				JSON.stringify({ type: "tool.register", name: "a", description: "b", tier: "nuclear" }),
			),
		).toThrowError();
		expect(() =>
			decode(
				JSON.stringify({ type: "tool.register", name: "a", description: "b", tier: "dangerous" }),
			),
		).not.toThrow();
	});

	it("all decode errors are typed GlassboxErrors", () => {
		try {
			decode("{");
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(isGlassboxError(e)).toBe(true);
			expect((e as GlassboxError).code).toBe(GlassboxErrorCode.PROTOCOL_ERROR);
		}
	});
});
