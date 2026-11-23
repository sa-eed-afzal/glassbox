/**
 * Startup self-check (spec §7.4, §9.4): a world-readable credential fails loud
 * (naming the file + mode); dependency major drift fails; audit modes are
 * fix-or-fail.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkAuditModes,
	checkCredentialFile,
	checkDependencies,
	runSelfCheck,
} from "../src/core/selfcheck.js";

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "gbx-selfcheck-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("checkCredentialFile (spec §7.2, §9.4)", () => {
	it("passes when absent", () => {
		const r = checkCredentialFile(join(tmp, "nope.json"));
		expect(r.ok).toBe(true);
	});

	it("passes for a 0600 credential file", () => {
		const file = join(tmp, "creds.json");
		writeFileSync(file, "{}");
		chmodSync(file, 0o600);
		expect(checkCredentialFile(file).ok).toBe(true);
	});

	it("fails a world-readable credential, naming the file and its mode", () => {
		const file = join(tmp, "creds.json");
		writeFileSync(file, "{}");
		chmodSync(file, 0o644);
		const r = checkCredentialFile(file);
		expect(r.ok).toBe(false);
		expect(r.problems[0]!.message).toContain(file);
		expect(r.problems[0]!.message).toContain("644");
	});
});

describe("checkDependencies (spec §7.4, E1)", () => {
	it("fails loud on a major-version drift", () => {
		const readJson = (path: string): unknown => {
			if (path.endsWith("package.json") && !path.includes("node_modules")) {
				return { dependencies: { zod: "3.25.76" } };
			}
			if (path.endsWith("node_modules/zod/package.json")) return { version: "4.6.5" };
			throw new Error("not found");
		};
		const r = checkDependencies("/x", readJson);
		expect(r.ok).toBe(false);
		expect(r.problems.some((p) => p.message.includes("zod") && p.message.includes("4.6.5"))).toBe(
			true,
		);
	});

	it("passes when majors match and flags a core-module fake package", () => {
		const readJson = (path: string): unknown => {
			if (path.endsWith("package.json") && !path.includes("node_modules")) {
				return { dependencies: { ws: "8.22.0" }, devDependencies: { crypto: "1.0.0" } };
			}
			if (path.endsWith("node_modules/ws/package.json")) return { version: "8.22.0" };
			throw new Error("not found");
		};
		const r = checkDependencies("/x", readJson);
		expect(r.ok).toBe(false); // the fake core-module dep
		expect(r.problems.some((p) => p.message.includes("crypto"))).toBe(true);
	});
});

describe("checkAuditModes (spec §7.5)", () => {
	it("fixes a lax audit file/dir (fix-or-fail)", () => {
		const dir = join(tmp, "state", "glassbox");
		const file = join(dir, "audit.jsonl");
		// create with lax modes
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o755);
		writeFileSync(file, "{}\n");
		chmodSync(file, 0o664);
		const r = checkAuditModes(file, true);
		expect(r.ok).toBe(true);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("fails when the mode cannot be corrected (fix disabled)", () => {
		const dir = join(tmp, "glassbox2");
		const file = join(dir, "audit.jsonl");
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o755);
		writeFileSync(file, "{}\n");
		chmodSync(file, 0o664);
		const r = checkAuditModes(file, false);
		expect(r.ok).toBe(false);
	});
});

describe("runSelfCheck", () => {
	it("fails when the credential file is world-readable (spec §9.4)", () => {
		const credsFile = join(tmp, "creds.json");
		writeFileSync(credsFile, "{}");
		chmodSync(credsFile, 0o644);
		const readJson = (path: string): unknown => {
			if (path.endsWith("package.json") && !path.includes("node_modules"))
				return { dependencies: {} };
			throw new Error("not found");
		};
		const r = runSelfCheck({ projectDir: "/x", credsFile, readJson });
		expect(r.ok).toBe(false);
		expect(r.problems.some((p) => p.area === "creds")).toBe(true);
	});

	it("passes with a clean credential and matching deps", () => {
		const credsFile = join(tmp, "creds.json");
		writeFileSync(credsFile, "{}");
		chmodSync(credsFile, 0o600);
		const readJson = (path: string): unknown => {
			if (path.endsWith("package.json") && !path.includes("node_modules"))
				return { dependencies: {} };
			throw new Error("not found");
		};
		const r = runSelfCheck({ projectDir: "/x", credsFile, readJson });
		expect(r.ok).toBe(true);
	});
});
