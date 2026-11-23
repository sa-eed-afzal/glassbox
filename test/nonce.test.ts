/**
 * Credentials + nonce allowlist (spec §7.2, §9.4) and revocation UX (WP6):
 *
 * - A local process that cannot read the 0600 credential cannot sign a management
 *   request — unsigned / foreign-key / replayed requests → typed 401 + an
 *   `impersonation` audit line; a valid signature → 200.
 * - The allowlist holds exactly the spawn principal.
 * - `loadOrCreate` falls back to a 0600 file (with a one-line warning) and is
 *   convergent: the bridge and the CLI resolve to the same key.
 * - Signed POST /drop revokes the session server-side (WP6).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAudit } from "../src/bridge/audit.js";
import { Bridge } from "../src/bridge/bridge.js";
import { autoPolicy } from "../src/bridge/policy.js";
import { generateKey, loadOrCreate } from "../src/core/credentials.js";
import { GlassboxErrorCode } from "../src/core/errors.js";
import {
	NonceAuth,
	NonceRegistry,
	publicKeyFromB64,
	signRequest,
	verifyRequest,
} from "../src/core/nonce.js";
import { createHost, type Host } from "../src/host/host.js";

const APP = "echo-app";
const ORIGIN = "http://localhost:8123";

type WireMsg = { type: string } & Record<string, unknown>;

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "gbx-nonce-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("nonce sign/verify (spec §7.2)", () => {
	const spawn = generateKey();
	const foreign = generateKey();

	it("binds the signature to nonce, method, path, and body", () => {
		const sig = signRequest(spawn.privateKey, "n1", "POST", "/code", "{}");
		expect(verifyRequest(spawn.publicKey, "n1", "POST", "/code", "{}", sig)).toBe(true);
		// any single component changed → reject
		expect(verifyRequest(spawn.publicKey, "n2", "POST", "/code", "{}", sig)).toBe(false);
		expect(verifyRequest(spawn.publicKey, "n1", "GET", "/code", "{}", sig)).toBe(false);
		expect(verifyRequest(spawn.publicKey, "n1", "POST", "/channels", "{}", sig)).toBe(false);
		expect(verifyRequest(spawn.publicKey, "n1", "POST", "/code", "{}x", sig)).toBe(false);
		expect(verifyRequest(spawn.publicKey, "n1", "POST", "/code", "{}", "not-a-sig")).toBe(false);
	});

	it("rejects a signature from a foreign key", () => {
		const sig = signRequest(foreign.privateKey, "n1", "POST", "/code", "{}");
		expect(verifyRequest(spawn.publicKey, "n1", "POST", "/code", "{}", sig)).toBe(false);
	});

	it("round-trips the public key through base64 SPKI", () => {
		const k = publicKeyFromB64(spawn.publicKeyB64);
		const sig = signRequest(spawn.privateKey, "n1", "POST", "/code", "{}");
		expect(verifyRequest(k, "n1", "POST", "/code", "{}", sig)).toBe(true);
	});
});

describe("NonceRegistry (replay guard)", () => {
	it("accepts a nonce once, then forgets it after the TTL", () => {
		let now = 1_000;
		const reg = new NonceRegistry(() => now, 1_000);
		expect(reg.consume("a")).toBe(true);
		expect(reg.consume("a")).toBe(false);
		expect(reg.size()).toBe(1);
		now += 1_000; // past the expiry
		expect(reg.consume("a")).toBe(true); // forgotten → replayable again
		expect(reg.size()).toBe(1);
	});
});

describe("NonceAuth (spec §7.2, §9.4)", () => {
	const spawn = generateKey();
	const foreign = generateKey();

	it("exposes exactly the spawn principal", () => {
		const auth = new NonceAuth({ principals: [spawn.publicKeyB64] });
		expect(auth.principals()).toEqual([spawn.publicKeyB64]);
	});

	it("accepts a valid signature; rejects unsigned, foreign-key, and replayed (spec §9.4)", () => {
		const now = 100;
		const auth = new NonceAuth({
			principals: [spawn.publicKeyB64],
			now: () => now,
			nonceTtlMs: 60_000,
		});
		const sign = (key: ReturnType<typeof generateKey>, nonce: string) =>
			signRequest(key.privateKey, nonce, "POST", "/code", "{}");

		// valid
		expect(auth.verify("a", "POST", "/code", "{}", sign(spawn, "a")).ok).toBe(true);

		// unsigned (missing nonce and signature)
		const missing = auth.verify(undefined, "POST", "/code", "{}", undefined);
		expect(missing.ok).toBe(false);
		expect(missing.ok ? null : missing.reason).toBe("missing nonce or signature");

		// foreign key
		const foreignVerdict = auth.verify("b", "POST", "/code", "{}", sign(foreign, "b"));
		expect(foreignVerdict.ok).toBe(false);
		expect(foreignVerdict.ok ? null : foreignVerdict.reason).toContain("principal");

		// replay
		const good = sign(spawn, "c");
		expect(auth.verify("c", "POST", "/code", "{}", good).ok).toBe(true);
		const replay = auth.verify("c", "POST", "/code", "{}", good);
		expect(replay.ok).toBe(false);
		expect(replay.ok ? null : replay.reason).toBe("replayed nonce");
	});
});

describe("credentials (spec §7.2)", () => {
	it("falls back to a 0600 file (with a warning) and converges across calls", () => {
		const file = join(tmp, "glassbox", "creds.json");
		const warnings: string[] = [];
		const c1 = loadOrCreate({ credsFile: file, useKeychain: false, warn: (m) => warnings.push(m) });
		expect(c1.fallback).toBe(true);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(join(tmp, "glassbox")).mode & 0o777).toBe(0o700);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]!).toContain("0600");

		// the CLI and the bridge resolve to the SAME key (no regeneration)
		const c2 = loadOrCreate({ credsFile: file, useKeychain: false, warn: () => {} });
		expect(c2.publicKeyB64).toBe(c1.publicKeyB64);
		const sig = signRequest(c2.privateKey, "n", "POST", "/code", "{}");
		expect(verifyRequest(c1.publicKey, "n", "POST", "/code", "{}", sig)).toBe(true);
	});
});

describe("management endpoints over HTTP (spec §7.2, §9.4; WP6 /drop)", () => {
	const hosts: Host[] = [];
	afterAll(async () => {
		for (const h of hosts.splice(0)) await h.close();
	});

	const spawn = generateKey();
	const intruder = generateKey();

	async function start(): Promise<{ bridge: Bridge; port: number; audit: InMemoryAudit }> {
		const audit = new InMemoryAudit();
		const auth = new NonceAuth({ principals: [spawn.publicKeyB64] });
		const bridge = new Bridge({
			serverVersion: "0.1.0",
			audit,
			policy: autoPolicy(),
			auth,
			client: "cli",
		});
		const host = await createHost(bridge);
		hosts.push(host);
		return { bridge, port: host.endpoint.port, audit };
	}

	async function call(
		port: number,
		method: "GET" | "POST",
		path: string,
		body: string,
		key: ReturnType<typeof generateKey> = spawn,
	): Promise<{ status: number; json: WireMsg }> {
		const nonce = randomUUID();
		const sig = signRequest(key.privateKey, nonce, method, path, body);
		const headers: Record<string, string> = {
			"x-glassbox-nonce": nonce,
			"x-glassbox-signature": sig,
			...(body.length > 0 ? { "content-type": "application/json" } : {}),
		};
		const res = await fetch(`http://127.0.0.1:${port}${path}`, {
			method,
			headers,
			...(body.length > 0 ? { body } : {}),
		});
		return { status: res.status, json: (await res.json()) as WireMsg };
	}

	it("rejects an unsigned management request with 401 + an impersonation audit (spec §9.4)", async () => {
		const { port, audit } = await start();
		const res = await fetch(`http://127.0.0.1:${port}/code`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(401);
		const j = (await res.json()) as WireMsg;
		expect((j.error as WireMsg).code).toBe(GlassboxErrorCode.UNAUTHORIZED);
		const imp = audit.entries.find((e) => e.status === "impersonation");
		expect(imp).toBeTruthy();
		expect(imp!.detail).toContain("POST /code");
	});

	it("rejects a foreign-key signature (a random local process) with 401 (spec §9.4)", async () => {
		const { port, audit } = await start();
		const r = await call(port, "POST", "/code", "{}", intruder);
		expect(r.status).toBe(401);
		expect((r.json.error as WireMsg).code).toBe(GlassboxErrorCode.UNAUTHORIZED);
		expect(audit.entries.filter((e) => e.status === "impersonation")).toHaveLength(1);
	});

	it("allows a validly-signed request from the spawn principal", async () => {
		const { port, audit } = await start();
		const r = await call(port, "POST", "/code", JSON.stringify({ app: APP, origin: ORIGIN }));
		expect(r.status).toBe(200);
		expect(r.json.code).toBeTruthy();
		expect(audit.entries.filter((e) => e.status === "impersonation")).toHaveLength(0);

		// GET /channels is nonce-gated too (empty body signs as "")
		const g = await call(port, "GET", "/channels", "");
		expect(g.status).toBe(200);
	});

	it("rejects a replayed nonce + signature", async () => {
		const { port, audit } = await start();
		const body = "{}";
		const nonce = randomUUID();
		const sig = signRequest(spawn.privateKey, nonce, "POST", "/code", body);
		const opts = () => ({
			method: "POST" as const,
			headers: {
				"content-type": "application/json",
				"x-glassbox-nonce": nonce,
				"x-glassbox-signature": sig,
			},
			body,
		});
		expect((await fetch(`http://127.0.0.1:${port}/code`, opts())).status).toBe(200);
		const replay = await fetch(`http://127.0.0.1:${port}/code`, opts());
		expect(replay.status).toBe(401);
		const j = (await replay.json()) as WireMsg;
		expect((j.error as WireMsg).code).toBe(GlassboxErrorCode.UNAUTHORIZED);
		expect(j.error as WireMsg).toMatchObject({ message: expect.stringContaining("replayed") });
		expect(audit.entries.filter((e) => e.status === "impersonation")).toHaveLength(1);
	});

	it("signed POST /drop revokes the session server-side (WP6, spec §5.2)", async () => {
		const { bridge, port, audit } = await start();
		const view = bridge.issueSession(bridge.mintCode({ app: APP, origin: ORIGIN }).code);

		const r = await call(port, "POST", "/drop", JSON.stringify({ sid: view.sid }));
		expect(r.status).toBe(200);
		expect(r.json.ok).toBe(true);
		// the session is GONE: not listed, and a refresh cannot revive it (immediate RST)
		expect(bridge.listSessions().some((s) => s.sid === view.sid)).toBe(false);
		expect(() => bridge.refreshSession(view.sid, view.sessionToken)).toThrowError();
		const rev = audit.entries.find((e) => e.status === "revoke");
		expect(rev).toBeTruthy();
		expect(rev!.client).toBe("cli");
		expect(rev!.detail).toBe("cli-drop");
	});

	it("POST /drop requires a { sid } body", async () => {
		const { port } = await start();
		const r = await call(port, "POST", "/drop", "{}");
		expect(r.status).toBe(400);
		expect((r.json.error as WireMsg).code).toBe(GlassboxErrorCode.PROTOCOL_ERROR);
	});
});
