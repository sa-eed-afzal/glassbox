/**
 * SDK tool() registration (spec §4.2): the options object and the bare schema form
 * share one overload. Mixing them used to drop `tier` silently, so the tool ran at the
 * default `read` tier with no consent. Registration now fails loudly instead.
 */
import { describe, expect, it } from "vitest";
import { Glassbox, type ToolOptions } from "../sdk/glassbox.js";

const APP = "tool-options-app";

function definitionOf(gbox: Glassbox, name: string): ToolOptions & { description: string } {
	const entry = (
		gbox as unknown as { tools: Map<string, { def: ToolOptions & { description: string } }> }
	).tools.get(name);
	if (!entry) throw new Error(`no tool ${name}`);
	return entry.def;
}

describe("sdk tool() options vs schema (spec §4.2)", () => {
	it("accepts options-only and keeps tier, timeoutMs, and inputSchema", () => {
		const gbox = new Glassbox(APP);
		gbox.tool("shoot", "Shoot", { tier: "write", timeoutMs: 30000 }, () => ({}));
		expect(definitionOf(gbox, "shoot")).toMatchObject({ tier: "write", timeoutMs: 30000 });

		gbox.tool(
			"move",
			"Move",
			{ tier: "write", inputSchema: { type: "object", properties: { x: { type: "number" } } } },
			() => ({}),
		);
		expect(definitionOf(gbox, "move")).toMatchObject({
			tier: "write",
			inputSchema: { type: "object", properties: { x: { type: "number" } } },
		});
	});

	it("treats a bare property map as the input schema with the default tier", () => {
		const gbox = new Glassbox(APP);
		gbox.tool("add", "Sum", { a: { type: "number" } }, () => ({}));
		const def = definitionOf(gbox, "add");
		expect(def.tier).toBeUndefined();
		expect(def.inputSchema).toEqual({ type: "object", properties: { a: { type: "number" } } });
	});

	it("keeps a schema property named tier when its value is a schema, not a tier string", () => {
		const gbox = new Glassbox(APP);
		gbox.tool("label", "Label", { tier: { type: "string" } }, () => ({}));
		expect(definitionOf(gbox, "label").inputSchema).toEqual({
			type: "object",
			properties: { tier: { type: "string" } },
		});
	});

	it("rejects tier mixed with schema properties instead of dropping it", () => {
		const gbox = new Glassbox(APP);
		expect(() =>
			gbox.tool("shoot", "Shoot", { tier: "write", angle: { type: "number" } }, () => ({})),
		).toThrowError(/shoot.*tier.*mixed with schema properties.*inputSchema/s);
	});

	it("rejects an unknown tier value", () => {
		const gbox = new Glassbox(APP);
		expect(() => gbox.tool("shoot", "Shoot", { tier: "writ" }, () => ({}))).toThrowError(
			/unknown tier "writ"/,
		);
	});

	it("rejects a non-positive or non-finite timeoutMs", () => {
		const gbox = new Glassbox(APP);
		for (const timeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => gbox.tool("t", "T", { timeoutMs }, () => ({}))).toThrowError(
				/timeoutMs must be a positive number/,
			);
		}
	});
});
