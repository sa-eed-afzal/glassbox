/**
 * Policy file + tier enforcement (spec §7.3): project-over-global merge, the
 * read=auto/write=consent/dangerous=deny defaults, and malformed-file loud failure.
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_TIER_POLICY,
	defaultPolicy,
	loadPolicy,
	PolicyError,
	resolveDecision,
	validatePolicy,
} from "../src/bridge/policy.js";

describe("policy (spec §7.3)", () => {
	it("defaults to read=auto, write=consent, dangerous=deny", () => {
		expect(defaultPolicy.resolve("anything", "read")).toBe("auto");
		expect(defaultPolicy.resolve("anything", "write")).toBe("consent");
		expect(defaultPolicy.resolve("anything", "dangerous")).toBe("deny");
		expect(DEFAULT_TIER_POLICY).toEqual({ read: "auto", write: "consent", dangerous: "deny" });
	});

	it("resolves an explicit per-tier decision, falling back per tier", () => {
		const policy = validatePolicy({ mygame: { write: "auto" } }, "test");
		expect(resolveDecision(policy, "mygame", "write")).toBe("auto");
		expect(resolveDecision(policy, "mygame", "read")).toBe("auto"); // default
		expect(resolveDecision(policy, "mygame", "dangerous")).toBe("deny"); // default
		expect(resolveDecision(policy, "unknown-app", "write")).toBe("consent"); // unknown app → defaults
	});

	it("merges project over global per appId and per tier", () => {
		const files = new Map<string, string>([
			[
				"/proj/glassbox.json",
				JSON.stringify({ policy: { mygame: { write: "auto" }, other: { read: "deny" } } }),
			],
			[
				"/global/glassbox.json",
				JSON.stringify({
					policy: { mygame: { read: "deny", dangerous: "consent" }, onlyglobal: { write: "auto" } },
				}),
			],
		]);
		const p = loadPolicy({
			projectDir: "/proj",
			globalDir: "/global",
			read: (path) => (files.has(path) ? files.get(path)! : null),
		});
		// project overrides global for mygame.write; global fills mygame.read
		expect(p.resolve("mygame", "write")).toBe("auto");
		expect(p.resolve("mygame", "read")).toBe("deny");
		expect(p.resolve("mygame", "dangerous")).toBe("consent");
		expect(p.resolve("other", "read")).toBe("deny");
		expect(p.resolve("onlyglobal", "write")).toBe("auto");
	});

	it("treats a valid file without a policy key as empty", () => {
		const p = loadPolicy({
			projectDir: "/proj",
			globalDir: "/global",
			read: (path) => (path === "/proj/glassbox.json" ? JSON.stringify({ other: 1 }) : null),
		});
		expect(p.resolve("mygame", "write")).toBe("consent"); // defaults
	});

	it.each([
		["bad json", "{ not json"],
		["array root", "[1,2]"],
		["policy not object", '{"policy": ["x"]}'],
		["app not object", '{"policy": {"mygame": "auto"}}'],
		["unknown tier", '{"policy": {"mygame": {"ultra": "auto"}}}'],
		["bad decision", '{"policy": {"mygame": {"write": "maybe"}}}'],
	])("rejects %s with a PolicyError", (_label, raw) => {
		expect(() =>
			loadPolicy({
				projectDir: "/proj",
				globalDir: "/global",
				read: (path) => (path === "/proj/glassbox.json" ? raw : null),
			}),
		).toThrowError(PolicyError);
	});

	it("rejects an invalid decision value at validate time", () => {
		expect(() => validatePolicy({ a: { write: "auto", dangerous: "nope" } }, "x")).toThrowError(
			PolicyError,
		);
	});
});
