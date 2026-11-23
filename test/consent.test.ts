/**
 * Consent gate (spec §6.2, §7.3): the bridge consults the policy per (appId, tier),
 * asks the widget via consent.request, and dispatches only on approval. Covers the
 * approve, deny, timeout, disconnect, and auto paths, plus audit consent/argsHash fields.
 */
import { describe, expect, it } from "vitest";
import { InMemoryAudit } from "../src/bridge/audit.js";
import { Bridge } from "../src/bridge/bridge.js";
import { autoPolicy, PolicyFile, type PolicyResolver } from "../src/bridge/policy.js";
import { ManualScheduler } from "../src/bridge/scheduler.js";
import { FakeClock } from "../src/core/clock.js";
import { decode, encode, type PageToBridgeMsg } from "../src/core/codec.js";
import { GlassboxErrorCode } from "../src/core/errors.js";
import { bridgeToolName } from "../src/core/naming.js";
import { PROTOCOL_VERSION } from "../src/core/version.js";
import { flush, makePair } from "./link.js";

const ORIGIN = "http://localhost:8123";
const APP = "echo-app";
type Wire = { type: string } & Record<string, unknown>;

interface Page {
	received: Wire[];
	onConsent: ((id: number) => void) | null;
	onCall: ((m: Wire) => void) | null;
	send: (msg: unknown) => void;
	consent: (id: number, decision: "approved" | "denied") => void;
}

/** A bridge with the SPEC default policy (read auto / write consent / dangerous deny). */
function newBridge(policy?: { policy: PolicyResolver }) {
	const clock = new FakeClock();
	const scheduler = new ManualScheduler();
	const audit = new InMemoryAudit();
	const bridge = new Bridge({
		serverVersion: "0.1.0",
		clock,
		scheduler,
		audit,
		...(policy ?? {}),
	});
	bridge.setEndpoint("127.0.0.1", 8123);
	return { bridge, clock, scheduler, audit };
}

function connect(bridge: Bridge): { view: { sid: string }; page: Page } {
	const { a, b } = makePair();
	const code = bridge.mintCode({ app: APP, origin: ORIGIN });
	const view = bridge.issueSession(code.code);
	bridge.hello(view.sid, {
		type: "hello",
		v: PROTOCOL_VERSION,
		sid: view.sid,
		app: APP,
		origin: ORIGIN,
		tab: "t1",
	});
	bridge.attach(view.sid, a);
	const page: Page = {
		received: [],
		onConsent: null,
		onCall: null,
		send: (msg) => b.send(encode(msg as unknown as PageToBridgeMsg)),
		consent: (id, decision) => page.send({ type: "consent.result", id, decision }),
	};
	b.onMessage((frame) => {
		const m = decode(frame) as unknown as Wire;
		page.received.push(m);
		if (m.type === "consent.request") page.onConsent?.(m.id as number);
		if (m.type === "tool.call") page.onCall?.(m);
	});
	a.onMessage((frame) => bridge.deliver(view.sid, decode(frame) as PageToBridgeMsg));
	return { view, page };
}

const auditEntries = (bridge: Bridge): InMemoryAudit["entries"] =>
	(bridge.auditSink as InMemoryAudit).entries;

describe("consent (spec §6.2, §7.3)", () => {
	it("approve path: consent tier dispatches after approval and audits consent:approved", async () => {
		const { bridge, audit } = newBridge();
		const { page } = connect(bridge);
		page.send({
			type: "tool.register",
			name: "play_move",
			description: "Clear group",
			tier: "write",
		});
		await flush();
		page.onConsent = (id) => page.consent(id, "approved");
		page.onCall = (m) => page.send({ type: "tool.result", id: m.id, value: { played: true } });

		const r = await bridge.callTool(bridgeToolName(ORIGIN, "play_move"), { x: 1, y: 2 });
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent).toEqual({ played: true });

		// the widget saw a consent.request carrying tool/args/tier/deadline
		const req = page.received.find((m) => m.type === "consent.request")!;
		expect(req.tool).toBe("play_move");
		expect(req.tier).toBe("write");
		expect(req.args).toEqual({ x: 1, y: 2 });
		expect(req.deadlineMs).toBeGreaterThan(0);

		const entry = auditEntries(bridge).find((e) => e.tool === "play_move" && e.status === "ok")!;
		expect(entry.consent).toBe("approved");
		expect(entry.argsHash).toBeTruthy();
		expect(entry.client).toBe("stdio");
		void audit;
	});

	it("deny path: consent tier never reaches the page and audits consent:denied", async () => {
		const { bridge } = newBridge();
		const { page } = connect(bridge);
		page.send({ type: "tool.register", name: "wreck", description: "Break", tier: "write" });
		await flush();
		page.onConsent = (id) => page.consent(id, "denied");

		const r = await bridge.callTool(bridgeToolName(ORIGIN, "wreck"), {});
		expect(r.isError).toBe(true);
		expect((r.structuredContent as { code: string }).code).toBe(GlassboxErrorCode.CONSENT_DENIED);
		expect(page.received.some((m) => m.type === "tool.call")).toBe(false);
		const entry = auditEntries(bridge).find((e) => e.tool === "wreck" && e.status === "error")!;
		expect(entry.consent).toBe("denied");
		expect(entry.status).toBe("error");
	});

	it("timeout path: no decision by the deadline is a denial (deterministic clock)", async () => {
		const { bridge, scheduler } = newBridge();
		const { page } = connect(bridge);
		page.send({
			type: "tool.register",
			name: "slow_write",
			description: "Needs consent",
			tier: "write",
		});
		await flush();
		page.onConsent = () => {}; // the widget never answers

		const p = bridge.callTool(bridgeToolName(ORIGIN, "slow_write"), {}, { timeoutMs: 60_000 });
		scheduler.fireAll(); // fire the consent deadline
		const r = await p;
		expect(r.isError).toBe(true);
		expect((r.structuredContent as { code: string }).code).toBe(GlassboxErrorCode.CONSENT_DENIED);
		expect(page.received.some((m) => m.type === "tool.call")).toBe(false);
		const entry = auditEntries(bridge).find(
			(e) => e.tool === "slow_write" && e.status === "error",
		)!;
		expect(entry.consent).toBe("denied");
	});

	it("auto path: a read-tier tool dispatches with no consent.request and audits consent:auto", async () => {
		const { bridge } = newBridge();
		const { page } = connect(bridge);
		page.send({ type: "tool.register", name: "status", description: "State", tier: "read" });
		await flush();
		page.onCall = (m) => page.send({ type: "tool.result", id: m.id, value: { ok: 1 } });

		const r = await bridge.callTool(bridgeToolName(ORIGIN, "status"), {});
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent).toEqual({ ok: 1 });
		expect(page.received.some((m) => m.type === "consent.request")).toBe(false);
		const entry = auditEntries(bridge).find((e) => e.tool === "status" && e.status === "ok")!;
		expect(entry.consent).toBe("auto");
	});

	it("deny policy: a dangerous tool with deny policy is rejected without any page traffic", async () => {
		const { bridge } = newBridge({
			policy: new PolicyFile({ [APP]: { dangerous: "deny" } }),
		});
		const { page } = connect(bridge);
		page.send({ type: "tool.register", name: "nuke", description: "Boom", tier: "dangerous" });
		await flush();

		const r = await bridge.callTool(bridgeToolName(ORIGIN, "nuke"), {});
		expect(r.isError).toBe(true);
		expect((r.structuredContent as { code: string }).code).toBe(GlassboxErrorCode.CONSENT_DENIED);
		expect(page.received.some((m) => m.type === "consent.request")).toBe(false);
		expect(page.received.some((m) => m.type === "tool.call")).toBe(false);
		const entry = auditEntries(bridge).find((e) => e.tool === "nuke" && e.status === "error")!;
		expect(entry.consent).toBe("denied");
	});

	it("autoPolicy override lets every tier dispatch immediately", async () => {
		const { bridge } = newBridge({ policy: autoPolicy() });
		const { page } = connect(bridge);
		page.send({ type: "tool.register", name: "w", description: "Write", tier: "write" });
		await flush();
		page.onCall = (m) => page.send({ type: "tool.result", id: m.id, value: "ok" });
		const r = await bridge.callTool(bridgeToolName(ORIGIN, "w"), {});
		expect(r.isError).toBeUndefined();
		expect(page.received.some((m) => m.type === "consent.request")).toBe(false);
	});

	it("denied and timed-out consent name their cause in the error and audit detail", async () => {
		const { bridge, scheduler } = newBridge();
		const { page } = connect(bridge);
		page.send({ type: "tool.register", name: "by_user", description: "A", tier: "write" });
		page.send({ type: "tool.register", name: "by_clock", description: "B", tier: "write" });
		await flush();
		page.onConsent = (id) => page.consent(id, "denied");
		const denied = await bridge.callTool(bridgeToolName(ORIGIN, "by_user"), {});
		expect(denied.structuredContent).toMatchObject({
			code: GlassboxErrorCode.CONSENT_DENIED,
			message: 'user denied consent for "by_user"',
		});
		expect(
			auditEntries(bridge).find((e) => e.tool === "by_user" && e.status === "error")!.detail,
		).toBe("consent denied by user");

		page.onConsent = () => {}; // never answers
		const p = bridge.callTool(bridgeToolName(ORIGIN, "by_clock"), {}, { timeoutMs: 60_000 });
		scheduler.fireAll();
		const timedOut = await p;
		expect(timedOut.structuredContent).toMatchObject({
			code: GlassboxErrorCode.CONSENT_DENIED,
			message: 'consent for "by_clock" timed out before the user answered',
		});
		expect(
			auditEntries(bridge).find((e) => e.tool === "by_clock" && e.status === "error")!.detail,
		).toBe("consent timed out");
	});

	it("disconnected path: widget loss while a consent is pending is a CONSENT_DENIED, named in audit", async () => {
		const { bridge } = newBridge();
		const { view, page } = connect(bridge);
		page.send({ type: "tool.register", name: "guarded", description: "G", tier: "write" });
		await flush();
		page.onConsent = () => {}; // the widget is on its way out — it never answers

		const p = bridge.callTool(bridgeToolName(ORIGIN, "guarded"), {});
		await flush(); // let the consent.request reach the page while still attached
		expect(page.received.some((m) => m.type === "consent.request")).toBe(true);

		// host dropped the socket (WS close → bridge.detach, spec §5.2)
		bridge.detach(view.sid);
		const r = await p;
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toMatchObject({
			code: GlassboxErrorCode.CONSENT_DENIED,
			message: 'widget disconnected before consent was given for "guarded"',
		});
		expect(page.received.some((m) => m.type === "tool.call")).toBe(false);
		const entry = auditEntries(bridge).find((e) => e.tool === "guarded" && e.status === "error")!;
		expect(entry.consent).toBe("denied");
		expect(entry.detail).toBe("widget disconnected before consent");
	});

	it("an untagged tool asks for consent (default tier is write)", async () => {
		const { bridge } = newBridge();
		const { page } = connect(bridge);
		page.send({ type: "tool.register", name: "untagged", description: "U" });
		await flush();
		page.onConsent = (id) => page.consent(id, "approved");
		page.onCall = (m) => page.send({ type: "tool.result", id: m.id, value: "ok" });
		const r = await bridge.callTool(bridgeToolName(ORIGIN, "untagged"), {});
		expect(r.isError).toBeUndefined();
		expect(page.received.some((m) => m.type === "consent.request")).toBe(true);
		expect(
			auditEntries(bridge).find((e) => e.tool === "untagged" && e.status === "ok")!.consent,
		).toBe("approved");
	});
});
