/**
 * Sampling forms (spec §5.7): widget-side schema validation, form-field
 * derivation, and the no-handler → respondSampling() wire path against a
 * REAL host (same code path a browser page takes).
 */
import { afterAll, describe, expect, it } from "vitest";
import {
	Glassbox,
	type SampleField,
	samplingFields,
	validateSampleAnswer,
} from "../sdk/glassbox.js";
import { Bridge } from "../src/bridge/bridge.js";
import { autoPolicy } from "../src/bridge/policy.js";
import type { SamplingResultMsg } from "../src/core/codec.js";
import { createHost, type Host } from "../src/host/host.js";

const APP = "sample-app";
const PAGE_ORIGIN = "http://localhost:8123";

// The harness stands in for a browser TAB at PAGE_ORIGIN — the origin every
// connect code minted here is bound to (spec §5.2). A real page always
// presents location.origin in the exchange + hello, so the headless test does too.
Object.defineProperty(globalThis, "location", {
	value: { origin: PAGE_ORIGIN },
	configurable: true,
});

const hosts: Host[] = [];
afterAll(async () => {
	for (const h of hosts.splice(0)) await h.close();
});

async function start(): Promise<{ bridge: Bridge; host: Host }> {
	const bridge = new Bridge({ serverVersion: "0.1.0", policy: autoPolicy() });
	const host = await createHost(bridge);
	hosts.push(host);
	return { bridge, host };
}

function connectCode(bridge: Bridge): string {
	return bridge.mintCode({ app: APP, origin: PAGE_ORIGIN }).code;
}

function waitForStatus(gbox: Glassbox, want: string, timeoutMs = 8000): Promise<void> {
	return new Promise((resolve, reject) => {
		if (gbox.status === want) return resolve();
		const t = setTimeout(
			() => reject(new Error(`status "${want}" not reached (now ${gbox.status})`)),
			timeoutMs,
		);
		const cb = (s: { status: string }) => {
			if (s.status === want) {
				clearTimeout(t);
				resolve();
			}
		};
		gbox.on("status", cb as (data: never) => void);
	});
}

describe("validateSampleAnswer (spec §5.7)", () => {
	const SCHEMA = {
		type: "object",
		properties: {
			score: { type: "number", minimum: 0, maximum: 100, description: "Final score" },
			label: { type: "string", minLength: 2, maxLength: 12 },
			mode: { type: "string", enum: ["easy", "hard"] },
			done: { type: "boolean" },
			extras: { type: "array", items: { type: "string", maxLength: 4 } },
		},
		required: ["score", "mode"],
	};

	it("accepts a valid answer", () => {
		expect(
			validateSampleAnswer(SCHEMA, {
				score: 42,
				mode: "easy",
				label: "ok",
				done: true,
				extras: ["a", "bb"],
			}),
		).toBeNull();
	});

	it("flags missing required properties", () => {
		const err = validateSampleAnswer(SCHEMA, { score: 1 });
		expect(err).toMatch(/missing required "mode"/);
	});

	it("flags wrong types (incl. integer and null)", () => {
		expect(validateSampleAnswer({ type: "integer", minimum: 0 }, 1.5)).toMatch(/expected integer/);
		expect(validateSampleAnswer({ type: "number" }, "42")).toMatch(/expected number/);
		expect(validateSampleAnswer({ type: "object" }, null)).toMatch(/expected object/);
		expect(validateSampleAnswer({ type: ["string", "number"] }, true)).toMatch(
			/expected string \| number/,
		);
	});

	it("flags enum/minimum/maximum/length violations with a path", () => {
		expect(validateSampleAnswer(SCHEMA, { score: 5, mode: "medium" })).toMatch(
			/\$\.mode: not one of/,
		);
		expect(validateSampleAnswer(SCHEMA, { score: -1, mode: "easy" })).toMatch(
			/\$\.score: below minimum/,
		);
		expect(validateSampleAnswer(SCHEMA, { score: 500, mode: "easy" })).toMatch(
			/\$\.score: above maximum/,
		);
		expect(validateSampleAnswer(SCHEMA, { score: 5, mode: "easy", label: "x" })).toMatch(
			/shorter than 2 chars/,
		);
		expect(validateSampleAnswer(SCHEMA, { score: 5, mode: "easy", extras: ["toolong"] })).toMatch(
			/extras\[0\]: longer than 4/,
		);
	});

	it("ignores unknown keywords and missing schemas (no schema → any answer)", () => {
		expect(validateSampleAnswer(null, { anything: 1 })).toBeNull();
		expect(validateSampleAnswer({}, "plain")).toBeNull();
		expect(validateSampleAnswer({ $id: "x", title: "y" }, 3)).toBeNull();
	});
});

describe("samplingFields (spec §5.7)", () => {
	it("derives fields from an object schema", () => {
		const fields = samplingFields({
			type: "object",
			properties: {
				n: { type: "number", description: "a count" },
				b: { type: "boolean" },
				m: { type: "string", enum: ["a", "b"] },
				r: { type: "string" },
			},
			required: ["r"],
		});
		expect(fields).toHaveLength(4);
		const byName = new Map(fields.map((f: SampleField) => [f.name, f]));
		expect(byName.get("n")!.type).toBe("number");
		expect(byName.get("n")!.hint).toBe("a count");
		expect(byName.get("b")!.type).toBe("checkbox");
		expect(byName.get("m")!.type).toBe("select");
		expect(byName.get("m")!.enum).toEqual(["a", "b"]);
		expect(byName.get("r")!.required).toBe(true);
		expect(byName.get("n")!.required).toBe(false);
	});

	it("falls back to a single textarea without a schema", () => {
		expect(samplingFields(undefined)).toEqual([
			{ name: "answer", type: "textarea", required: true },
		]);
		expect(samplingFields({ type: "string" })).toEqual([
			{ name: "answer", type: "textarea", required: true },
		]);
	});
});

describe("sampling wire path via respondSampling (spec §5.7)", () => {
	it("no handler → sampling event → answer resolves the bridge request", async () => {
		const { bridge } = await start();
		const gbox = new Glassbox(APP);
		gbox.tool("t", "t", () => ({}));
		let sampling: { id: number; messages: unknown[]; maxTokens: number; schema?: unknown } | null =
			null;
		gbox.on(
			"sampling",
			(r: { id: number; messages: unknown[]; maxTokens: number; schema?: unknown }) => {
				sampling = r;
			},
		);
		await gbox.connect(connectCode(bridge));
		await waitForStatus(gbox, "connected");

		const p = bridge.requestSampling(
			"localhost-8123",
			{
				messages: [{ role: "user", content: "what is the score?" }],
				maxTokens: 16,
				schema: { type: "object", properties: { score: { type: "number" } } },
			},
			5000,
		);
		// give the frame a beat to arrive — the bridge promise must still be pending
		await new Promise((r) => setTimeout(r, 150));
		expect(sampling).toBeTruthy();
		gbox.respondSampling(sampling!.id, { score: 12 });

		const sr = (await p) as SamplingResultMsg;
		expect(sr.type).toBe("sampling.result");
		expect((sr as { value: unknown }).value).toEqual({ score: 12 });
		gbox.disconnect();
	});

	it("second invalid answer → typed PAGE_ERROR instead of a hang", async () => {
		const { bridge } = await start();
		const gbox = new Glassbox(APP);
		gbox.tool("t", "t", () => ({}));
		let reqId = -1;
		gbox.on("sampling", (r: { id: number }) => (reqId = r.id));
		await gbox.connect(connectCode(bridge));
		await waitForStatus(gbox, "connected");

		const p = bridge.requestSampling(
			"localhost-8123",
			{ messages: [{ role: "user", content: "hi" }], maxTokens: 4 },
			5000,
		);
		await new Promise((r) => setTimeout(r, 150));
		expect(reqId).toBeGreaterThan(0);
		// what the widget does after the repair prompt is also rejected
		gbox.respondSampling(reqId, undefined, {
			code: "PAGE_ERROR",
			message: "sampling answer rejected: $.score: expected number",
		});
		const sr = (await p) as SamplingResultMsg;
		expect((sr as { error: { code: string } }).error.code).toBe("PAGE_ERROR");
		gbox.disconnect();
	});

	it("a registered sampling() handler still wins over the widget fallback", async () => {
		const { bridge } = await start();
		const gbox = new Glassbox(APP);
		gbox.tool("t", "t", () => ({}));
		gbox.sampling((p) => ({ handler: p.messages.length }));
		let events = 0;
		gbox.on("sampling", () => events++);
		await gbox.connect(connectCode(bridge));
		const sr = (await bridge.requestSampling("localhost-8123", {
			messages: [{ role: "user", content: "hi" }],
			maxTokens: 4,
		})) as SamplingResultMsg;
		expect((sr as { value: unknown }).value).toEqual({ handler: 1 });
		expect(events).toBe(0);
		gbox.disconnect();
	});
});
