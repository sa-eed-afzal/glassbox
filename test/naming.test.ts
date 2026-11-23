import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GlassboxErrorCode, isGlassboxError } from "../src/core/errors.js";
import {
	BRIDGE_NAME_RE,
	bridgeToolName,
	CHANNEL_MAX,
	channelFrom,
	isBridgeToolName,
	NAME_MAX,
	parseBridgeToolName,
	TOOL_MAX,
	toolName,
} from "../src/core/naming.js";

describe("naming (spec §5.3)", () => {
	it("maps localhost origins to the canonical channel", () => {
		expect(channelFrom("http://localhost:8123")).toBe("localhost-8123");
		expect(channelFrom("localhost:8123")).toBe("localhost-8123");
		expect(channelFrom("https://EXAMPLE.COM:443/x")).toBe("example-com-443");
	});

	it("builds <channel>__<tool> with one separator", () => {
		expect(bridgeToolName("http://localhost:8123", "status")).toBe("localhost-8123__status");
		expect(bridgeToolName("http://localhost:8123", "Play Move (now!)")).toBe(
			"localhost-8123__play-move-now",
		);
	});

	it("round-trips through parseBridgeToolName", () => {
		const name = bridgeToolName("http://192.168.1.10:9000", "some_tool");
		const { channel, tool } = parseBridgeToolName(name);
		expect(channel).toBe(channelFrom("http://192.168.1.10:9000"));
		expect(tool).toBe(toolName("some_tool"));
	});

	it("rejects non-glassbox names with a typed error", () => {
		for (const bad of ["no-separator", "a", "__x", "x__"]) {
			expect(() => parseBridgeToolName(bad)).toThrowError();
			try {
				parseBridgeToolName(bad);
			} catch (e) {
				expect(isGlassboxError(e) && e.code === GlassboxErrorCode.PROTOCOL_ERROR).toBe(true);
			}
		}
	});

	it("sanitizes hostnames and tools", () => {
		expect(toolName("A-B.C/D?")).toBe("a-b-c-d");
		expect(isBridgeToolName("localhost-8123__ok")).toBe(true);
		expect(isBridgeToolName("UPPER__case")).toBe(false);
	});

	it("keeps long channels and tools within bounds (property)", () => {
		const arbOrigin = fc
			.tuple(fc.string(), fc.integer({ min: 1, max: 65535 }))
			.map(([host, port]) => `${host}:${port}`);
		fc.assert(
			fc.property(arbOrigin, fc.string({ minLength: 1 }), (origin, appTool) => {
				const ch = channelFrom(origin);
				const tool = toolName(appTool);
				expect(ch.length).toBeLessThanOrEqual(CHANNEL_MAX);
				expect(tool.length).toBeLessThanOrEqual(TOOL_MAX);
				const name = bridgeToolName(origin, appTool);
				expect(name.length).toBeLessThanOrEqual(NAME_MAX);
				expect(name).toMatch(BRIDGE_NAME_RE);
				const parsed = parseBridgeToolName(name);
				expect(parsed.tool.length).toBeGreaterThan(0);
			}),
			{ numRuns: 200 },
		);
	});

	it("is deterministic (stable hashes)", () => {
		const long = bridgeToolName(
			"http://an-extremely-long-origin-host-name.example.com:8123",
			"an-extremely-long-app-tool-name-here",
		);
		expect(long).toBe(
			bridgeToolName(
				"http://an-extremely-long-origin-host-name.example.com:8123",
				"an-extremely-long-app-tool-name-here",
			),
		);
	});
});
