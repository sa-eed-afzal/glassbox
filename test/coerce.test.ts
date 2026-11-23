import { describe, expect, it } from "vitest";
import { coerceError, coerceResult, supportsStructured } from "../src/core/coerce.js";
import { GlassboxErrorCode } from "../src/core/errors.js";

const NEW = "2025-06-18";
const OLD = "2024-11-05";

describe("coercion (spec §5.4)", () => {
	it("string → text content, no structuredContent, on any protocol version", () => {
		for (const pv of [NEW, OLD]) {
			const r = coerceResult("hello", pv);
			expect(r.content).toEqual([{ type: "text", text: "hello" }]);
			expect("structuredContent" in r).toBe(false);
			expect(r.isError).toBeUndefined();
		}
	});

	it('null/undefined → "null" text', () => {
		expect(coerceResult(undefined, NEW).content[0]!.text).toBe("null");
		expect(coerceResult(null, OLD).content[0]!.text).toBe("null");
	});

	it("object → JSON text always; structuredContent only when the protocol supports it", () => {
		const v = { score: 420, moves: 7 };
		const withStructured = coerceResult(v, NEW);
		expect(withStructured.structuredContent).toEqual(v);
		expect(JSON.parse(withStructured.content[0]!.text)).toEqual(v);

		const legacy = coerceResult(v, OLD);
		expect("structuredContent" in legacy).toBe(false);
		expect(JSON.parse(legacy.content[0]!.text)).toEqual(v);
	});

	it("array values survive round-trip through text; structured wraps under value (MCP object rule)", () => {
		const r = coerceResult([1, "two", { three: 3 }], NEW);
		expect(JSON.parse(r.content[0]!.text)).toEqual([1, "two", { three: 3 }]);
		expect(r.structuredContent).toEqual({ value: [1, "two", { three: 3 }] });

		const legacy = coerceResult([1], OLD);
		expect("structuredContent" in legacy).toBe(false);
		expect(JSON.parse(legacy.content[0]!.text)).toEqual([1]);
	});

	it("unserializable values degrade instead of throwing", () => {
		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular;
		const r = coerceResult(circular, NEW);
		expect(typeof r.content[0]!.text).toBe("string");
		expect(r.content[0]!.text.length).toBeGreaterThan(0);
		expect(r.isError).toBeUndefined();
	});

	it("error results are typed and carry the trace", () => {
		const r = coerceError(GlassboxErrorCode.DEADLINE, "too slow", "tr-9");
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toEqual({ code: "DEADLINE", message: "too slow", traceId: "tr-9" });
		expect(r.content[0]!.text).toBe("too slow");
	});

	it("supportsStructured is a boundary-correct date comparison", () => {
		expect(supportsStructured("2025-06-17")).toBe(false);
		expect(supportsStructured("2025-06-18")).toBe(true);
		expect(supportsStructured("2025-06-19")).toBe(true);
		expect(supportsStructured("2026-01-01")).toBe(true);
		expect(supportsStructured("garbage")).toBe(false);
	});
});
