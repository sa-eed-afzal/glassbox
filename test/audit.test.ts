/**
 * Audit hardening (spec §7.5, WP1): FileAudit enforces 0600 file / 0700 dir,
 * never throws, argsHash is a stable 16-hex digest, and full args appear only
 * under GLASSBOX_AUDIT_ARGS=1.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuditEntry, FileAudit, type InMemoryAudit } from "../src/bridge/audit.js";
import { Bridge, hashArgs } from "../src/bridge/bridge.js";
import { autoPolicy } from "../src/bridge/policy.js";
import { FakeClock } from "../src/core/clock.js";
import { decode, encode, type PageToBridgeMsg } from "../src/core/codec.js";
import { bridgeToolName } from "../src/core/naming.js";
import { PROTOCOL_VERSION } from "../src/core/version.js";
import { flush, makePair } from "./link.js";

const APP = "echo-app";
const ORIGIN = "http://localhost:8123";
type Wire = { type: string } & Record<string, unknown>;

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "gbx-audit-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("FileAudit (spec §7.5)", () => {
	it("creates the file at 0600 and the parent dir at 0700", () => {
		const dir = join(tmp, "glassbox");
		const path = join(dir, "audit.jsonl");
		new FileAudit(path);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("re-tightens an existing world-readable file to 0600", () => {
		const dir = join(tmp, "glassbox");
		const path = join(dir, "audit.jsonl");
		// pre-create a lax file (like the stale 664 audit file)
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, "{}\n");
		chmodSync(path, 0o664);
		new FileAudit(path);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("never throws, even when the path cannot be created", () => {
		const audit = new FileAudit(join(tmp, "no", "such", "dir", "audit.jsonl"));
		expect(() => audit.record(entry())).not.toThrow();
		expect(() => audit.record(entry())).not.toThrow();
	});
});

describe("argsHash (spec §7.5)", () => {
	it("is a stable 16-hex digest for the same args", () => {
		expect(hashArgs({ x: 1, y: 2 })).toMatch(/^[0-9a-f]{16}$/);
		expect(hashArgs({ x: 1, y: 2 })).toBe(hashArgs({ x: 1, y: 2 }));
		expect(hashArgs({ x: 1, y: 2 })).not.toBe(hashArgs({ x: 2, y: 1 }));
		expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
	});
});

describe("full args only under GLASSBOX_AUDIT_ARGS=1 (spec §7.5)", () => {
	it("omits args by default and includes them when the env is set", async () => {
		const bridge = new Bridge({
			serverVersion: "0.1.0",
			policy: autoPolicy(),
			clock: new FakeClock(),
		});
		bridge.setEndpoint("127.0.0.1", 8123);
		const { a, b } = makePair();
		const view = bridge.issueSession(bridge.mintCode({ app: APP, origin: ORIGIN }).code);
		bridge.hello(view.sid, {
			type: "hello",
			v: PROTOCOL_VERSION,
			sid: view.sid,
			app: APP,
			origin: ORIGIN,
			tab: "t",
		});
		bridge.attach(view.sid, a);
		let onCall: ((m: Wire) => void) | null = null;
		b.onMessage((frame) => {
			const m = decode(frame) as unknown as Wire;
			if (m.type === "tool.call") onCall?.(m);
		});
		a.onMessage((frame) => bridge.deliver(view.sid, decode(frame) as PageToBridgeMsg));
		const pageSend = (msg: unknown) => b.send(encode(msg as unknown as PageToBridgeMsg));
		pageSend({ type: "tool.register", name: "echo", description: "E", tier: "read" });
		await flush();
		onCall = (m) => pageSend({ type: "tool.result", id: m.id, value: "ok" });

		// default: no args
		await bridge.callTool(bridgeToolName(ORIGIN, "echo"), { secret: 42 });
		const noArgs = (bridge.auditSink as InMemoryAudit).entries.find(
			(e) => e.tool === "echo" && e.status === "ok",
		)!;
		expect(noArgs.args).toBeUndefined();
		expect(noArgs.argsHash).toBeTruthy();

		// with env: full args present
		const prev = process.env.GLASSBOX_AUDIT_ARGS;
		process.env.GLASSBOX_AUDIT_ARGS = "1";
		try {
			await bridge.callTool(bridgeToolName(ORIGIN, "echo"), { secret: 42 });
		} finally {
			if (prev === undefined) delete process.env.GLASSBOX_AUDIT_ARGS;
			else process.env.GLASSBOX_AUDIT_ARGS = prev;
		}
		const withArgs = (bridge.auditSink as InMemoryAudit).entries
			.filter((e) => e.tool === "echo" && e.status === "ok")
			.at(-1)!;
		expect(withArgs.args).toEqual({ secret: 42 });
	});
});

function entry(): AuditEntry {
	return { ts: 1, traceId: "t", status: "ok" };
}
