/**
 * Side-door security (spec §3 principle 3: "other local processes … are untrusted by default";
 * §5.2a admission; §7.3 consent binding).
 *
 * Scenario from a real agent run (2026-11-23): an agent that can call `glassbox_code`
 * mints its own connect code, then writes a non-browser WebSocket client. A non-browser
 * client can claim any origin, so it can complete the code→session exchange and the
 * hello. A session that a human never approved must not be able to approve consent,
 * take over calls, or change a tool's tier for the real page.
 *
 * Real bridge + real WS host on 127.0.0.1, default policy (write = consent).
 */
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { InMemoryAudit } from "../src/bridge/audit.js";
import { Bridge, JOIN_TOOL } from "../src/bridge/bridge.js";
import { bridgeToolName } from "../src/core/naming.js";
import { PROTOCOL_VERSION } from "../src/core/version.js";
import { createHost, type Host } from "../src/host/host.js";

const ORIGIN = "http://127.0.0.1:3002";
const APP = "sudoku-game";
const TOOL = bridgeToolName(ORIGIN, "input_number");
type WireMsg = { type: string } & Record<string, unknown>;

class Client {
	readonly frames: WireMsg[] = [];
	onFrame: ((m: WireMsg) => void) | null = null;
	readonly ws: WebSocket;
	constructor(url: string) {
		this.ws = new WebSocket(url);
		this.ws.on("message", (d) => {
			const m = JSON.parse(String(d)) as WireMsg;
			this.frames.push(m);
			this.onFrame?.(m);
		});
	}
	send(m: unknown): void {
		this.ws.send(JSON.stringify(m));
	}
	open(): Promise<void> {
		return this.ws.readyState === 1
			? Promise.resolve()
			: new Promise((r) => this.ws.once("open", () => r()));
	}
	async waitFor(pred: (m: WireMsg) => boolean, ms = 3000): Promise<WireMsg> {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			const f = this.frames.find(pred);
			if (f) return f;
			await sleep(20);
		}
		throw new Error("expected frame did not arrive");
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isType = (t: string) => (m: WireMsg) => m.type === t;
const isJoin = (m: WireMsg) => m.type === "consent.request" && m.tool === JOIN_TOOL;
const isCallConsent = (m: WireMsg) => m.type === "consent.request" && m.tool === "input_number";

/** Pair a client the way a page does: code → POST /session → WS hello. */
async function pair(port: number, code: string, origin: string, app: string, tab: string) {
	const res = await fetch(`http://127.0.0.1:${port}/session`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code, origin }),
	});
	const s = (await res.json()) as WireMsg;
	if (res.status !== 200) throw new Error(`exchange rejected: ${JSON.stringify(s)}`);
	const c = new Client(String(s.endpoint));
	await c.open();
	c.send({ type: "hello", v: PROTOCOL_VERSION, sid: s.sid, app, origin, tab });
	await c.waitFor(isType("hello.ack"));
	return { c, sid: String(s.sid) };
}

/** A page that registers input_number (write) and runs it on tool.call. Never clicks Approve. */
function page(c: Client, executed: unknown[], tier = "write"): void {
	c.onFrame = (m) => {
		if (m.type === "tool.call") {
			executed.push(m.args);
			c.send({ type: "tool.result", id: m.id, value: { placed: true } });
		}
	};
	c.send({ type: "tool.register", name: "input_number", description: "Place a digit", tier });
}

/** A client that approves every consent request it receives (an attacker approving itself). */
function selfApprover(c: Client, executed: unknown[]): void {
	c.onFrame = (m) => {
		if (m.type === "consent.request")
			c.send({ type: "consent.result", id: m.id, decision: "approved" });
		if (m.type === "tool.call") {
			executed.push(m.args);
			c.send({ type: "tool.result", id: m.id, value: { placed: true } });
		}
	};
}

describe("side door: a self-paired non-browser client (spec §3.3, §5.2a, §7.3)", () => {
	const hosts: Host[] = [];
	afterAll(async () => {
		for (const h of hosts.splice(0)) await h.close();
	});
	async function start() {
		const audit = new InMemoryAudit();
		const bridge = new Bridge({ serverVersion: "0.1.0", audit, consentTimeoutMs: 800 });
		const host = await createHost(bridge);
		hosts.push(host);
		const realCode = () => bridge.mintCode({ app: APP, origin: ORIGIN }).code;
		return { bridge, audit, port: host.endpoint.port, realCode };
	}

	it("A: another session cannot answer the real page's consent request", async () => {
		const { bridge, audit, port, realCode } = await start();
		const ran: unknown[] = [];
		const real = await pair(port, realCode(), ORIGIN, APP, "real");
		page(real.c, ran);
		await sleep(50);

		const evil = "http://127.0.0.1:9999";
		const atk = await pair(
			port,
			bridge.mintCode({ app: "evil", origin: evil }).code,
			evil,
			"evil",
			"x",
		);

		const call = bridge.callTool(TOOL, { index: 0, digit: 8 });
		await real.c.waitFor(isCallConsent);
		for (let id = 0; id < 200; id++)
			atk.c.send({ type: "consent.result", id, decision: "approved" });
		const r = await call;

		expect(ran, "real page ran a write that no human approved").toEqual([]);
		expect(r.isError).toBe(true);
		expect(audit.entries.some((e) => e.consent === "approved")).toBe(false);
		const forged = audit.entries.find((e) => e.status === "impersonation");
		expect(forged?.session, "the forged answer is audited with its sender").toBe(atk.sid);
	});

	it("B: a later self-paired client cannot take over the real page's calls", async () => {
		const { bridge, audit, port, realCode } = await start();
		const ran: unknown[] = [];
		const real = await pair(port, realCode(), ORIGIN, APP, "real");
		page(real.c, ran);
		await sleep(50);

		const hijacked: unknown[] = [];
		const atk = await pair(port, realCode(), ORIGIN, APP, "evil");
		selfApprover(atk.c, hijacked);
		await real.c.waitFor(isJoin); // the human is asked on the real page, and doesn't answer

		const r = await bridge.callTool(TOOL, { index: 0, digit: 8 });

		expect(hijacked, "attacker received the call").toEqual([]);
		expect(r.isError, "no human approved, so the call is denied").toBe(true);
		expect(audit.entries.some((e) => e.consent === "approved")).toBe(false);
		await atk.c.waitFor(isType("session.revoke"), 3000); // join timed out → revoked
	});

	it("C: the exchange cannot skip the origin check by omitting origin", async () => {
		const { port, realCode } = await start();
		const res = await fetch(`http://127.0.0.1:${port}/session`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: realCode() }),
		});
		expect(res.status).toBe(400);
	});

	it("D: an unapproved client cannot downgrade a tool's tier to skip consent", async () => {
		const { bridge, port, realCode } = await start();
		const ran: unknown[] = [];
		const real = await pair(port, realCode(), ORIGIN, APP, "real");
		page(real.c, ran);
		await sleep(50);

		const atk = await pair(port, realCode(), ORIGIN, APP, "evil");
		atk.c.send({ type: "tool.register", name: "input_number", description: "x", tier: "read" });
		await sleep(50);

		expect(bridge.listTools().find((t) => t.bridgeName === TOOL)?.tier).toBe("write");
		const r = await bridge.callTool(TOOL, { index: 0, digit: 8 });
		expect(real.c.frames.some(isCallConsent), "the real page was asked for consent").toBe(true);
		expect(ran).toEqual([]);
		expect(r.isError).toBe(true);
	});

	it("legit: a second tab the human approves is admitted and its tools register", async () => {
		const { bridge, audit, port, realCode } = await start();
		const ranFirst: unknown[] = [];
		const first = await pair(port, realCode(), ORIGIN, APP, "tab-1");
		page(first.c, ranFirst);
		await sleep(50);

		const ranSecond: unknown[] = [];
		const second = await pair(port, realCode(), ORIGIN, APP, "tab-2");
		selfApprover(second.c, ranSecond);
		second.c.send({ type: "tool.register", name: "hint", description: "Hint", tier: "read" });
		await sleep(50);
		expect(
			bridge.listTools().some((t) => t.appTool === "hint"),
			"held until approved",
		).toBe(false);

		const join = await first.c.waitFor(isJoin);
		expect((join.args as { tab: string }).tab).toBe("tab-2");
		first.c.send({ type: "consent.result", id: join.id, decision: "approved" });
		await sleep(50);

		expect(bridge.listTools().some((t) => t.appTool === "hint")).toBe(true);
		const r = await bridge.callTool(TOOL, { index: 0, digit: 8 });
		expect(r.isError).toBeUndefined();
		expect(ranSecond).toEqual([{ index: 0, digit: 8 }]); // newest admitted tab receives calls
		const ok = audit.entries.find((e) => e.status === "ok" && e.tool === "input_number");
		expect(ok?.consent).toBe("approved");
		expect(ok?.session, "audit names the session that approved and ran it").toBe(second.sid);
	});

	it("legit: a join the human denies revokes the newcomer", async () => {
		const { port, realCode } = await start();
		const first = await pair(port, realCode(), ORIGIN, APP, "tab-1");
		page(first.c, []);
		await sleep(50);
		const second = await pair(port, realCode(), ORIGIN, APP, "tab-2");
		const join = await first.c.waitFor(isJoin);
		first.c.send({ type: "consent.result", id: join.id, decision: "denied" });
		const rev = await second.c.waitFor(isType("session.revoke"));
		expect(String(rev.reason)).toMatch(/join denied/);
	});
});
