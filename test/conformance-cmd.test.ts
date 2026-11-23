/**
 * `glassbox test` — the public conformance command (spec §9.2, M4 WP2).
 * Runner + CLI argv matrix: embedded default, external --port, --page live
 * channel verification, the origin-binding rejection, and the CLI's exit codes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAudit } from "../src/bridge/audit.js";
import { Bridge } from "../src/bridge/bridge.js";
import { PageActor, runConformance } from "../src/bridge/conformance.js";
import { main } from "../src/cli.js";
import { loadOrCreate } from "../src/core/credentials.js";
import { NonceAuth } from "../src/core/nonce.js";
import { PROTOCOL_VERSION } from "../src/core/version.js";
import { createHost, type Host } from "../src/host/host.js";

const ORIGIN = "http://localhost:12345";
const OTHER = "http://localhost:12346";

const hosts: Array<{ host: Host; bridge: Bridge }> = [];
const tmpDirs: string[] = [];
afterEach(async () => {
	for (const h of hosts.splice(0)) {
		h.bridge.close();
		await h.host.close();
	}
	for (const d of tmpDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
});

function tmpAudit(): string {
	const d = mkdtempSync(join(tmpdir(), "gbx-cmd-"));
	tmpDirs.push(d);
	return join(d, "audit.jsonl");
}

/** A running external bridge (the CLI/runner reaches it only over the network). */
async function externalBridge(): Promise<{ port: number }> {
	const cred = loadOrCreate();
	const bridge = new Bridge({
		serverVersion: "0.1.0",
		auth: new NonceAuth({ principals: [cred.publicKeyB64] }),
		audit: new FileAudit(tmpAudit()),
	});
	const host = await createHost(bridge);
	hosts.push({ host, bridge });
	return { port: host.endpoint.port };
}

describe("glassbox test — embedded (full suite)", () => {
	it("passes all embedded checks and reports the summary", async () => {
		const report = await runConformance();
		const failed = report.checks.filter((c) => !c.ok);
		expect(failed).toEqual([]);
		const names = report.checks.map((c) => c.name);
		for (const expected of [
			"health",
			"code.mint",
			"session.exchange",
			"session.origin-bound",
			"mgmt.unsigned-rejected",
			"hello",
			"hello.origin-bound",
			"tools.register",
			"tool.call.string",
			"tool.call.object",
			"consent.approve",
			"consent.deny",
			"sampling.round-trip",
			"drop",
			"audit.lines",
		]) {
			expect(names).toContain(expected);
		}
		expect(report.ok).toBe(true);
		expect(report.summary).toContain("PASS");
		expect(report.opens.bridge).toBeGreaterThan(0);
	});
});

describe("glassbox test — external (--port)", () => {
	it("runs the network-visible checks and skips the in-process ones", async () => {
		const { port } = await externalBridge();
		const report = await runConformance({ port, origin: ORIGIN });
		const failed = report.checks.filter((c) => !c.ok);
		expect(failed).toEqual([]);
		const skips = report.checks.filter((c) => c.skipped === true);
		expect(skips.length).toBeGreaterThanOrEqual(4); // tool.call/consent/sampling need the in-process bridge
		expect(report.mode).toBe("external");
	});

	it("fails with a typed detail when no origin is given", async () => {
		const { port } = await externalBridge();
		const report = await runConformance({ port });
		expect(report.ok).toBe(false);
		const setup = report.checks.find((c) => c.name === "setup")!;
		expect(setup.ok).toBe(false);
		expect(setup.detail).toContain("--origin");
	});

	it("verifies a live page channel (--page)", async () => {
		const { port } = await externalBridge();
		// connect a page at ORIGIN to the bridge the way the SDK would
		const h = hosts[0]!;
		const code = h.bridge.mintCode({ app: "userapp", origin: ORIGIN }).code;
		const sv = h.bridge.issueSession(code, ORIGIN);
		const actor = new PageActor();
		await actor.open(`ws://127.0.0.1:${port}/session`);
		await actor.hello(PROTOCOL_VERSION, sv.sid, "userapp", ORIGIN, "tab-user");
		actor.registerTool("status", "user tool", undefined, () => ({ ok: true }));
		const report = await runConformance({ port, pageUrl: ORIGIN });
		const page = report.checks.find((c) => c.name === "page.channel")!;
		expect(page.ok).toBe(true);
	});

	it("fails the page check when the page never connected", async () => {
		const { port } = await externalBridge();
		const report = await runConformance({ port, pageUrl: OTHER });
		expect(report.ok).toBe(false);
		const page = report.checks.find((c) => c.name === "page.channel")!;
		expect(page.ok).toBe(false);
		expect(page.detail).toContain("paste a connect code");
	});
});

async function deadPort(): Promise<number> {
	return new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => resolve(p));
		});
	});
}

describe("glassbox test — CLI dispatch", () => {
	it("main([test]) runs the embedded suite and exits 0", async () => {
		const code = await main(["test"]);
		expect(code).toBe(0);
	});

	it("main([test, --page]) without --port is a usage error (exit 2)", async () => {
		const code = await main(["test", "--page", ORIGIN]);
		expect(code).toBe(2);
	});

	it("main([test, --port <dead>]) exits 1 with failed checks", async () => {
		const deadPortNum = await deadPort();
		const code = await main(["test", "--port", String(deadPortNum), "--origin", ORIGIN]);
		expect(code).toBe(1);
	});
});
