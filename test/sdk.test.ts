/**
 * Page SDK (spec §4.2, §5.2): connect-code flow, tool dispatch, events,
 * auto-reconnect after a drop (no token re-paste), and revocation.
 * Runs in Node 22 against a REAL host (Node's built-in WebSocket + fetch),
 * so this is the same code path a browser page would take.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
	cycleFocusIndex,
	decodeConnectCode,
	Glassbox,
	pasteHint,
	renderWidget,
	widgetCss,
	widgetPhase,
	widgetStatusText,
} from "../sdk/glassbox.js";
import { Bridge } from "../src/bridge/bridge.js";
import { autoPolicy, PolicyFile } from "../src/bridge/policy.js";
import { createHost, type Host } from "../src/host/host.js";

const APP = "echo-app";
const PAGE_ORIGIN = "http://localhost:8123";

// The harness stands in for a browser TAB at PAGE_ORIGIN — the origin every
// connect code minted here is bound to (spec §5.2). A real page always
// presents location.origin in the exchange + hello, so the headless test does too.
Object.defineProperty(globalThis, "location", {
	value: { origin: PAGE_ORIGIN },
	configurable: true,
});

const hosts: Host[] = [];
afterAll(async () => {
	for (const h of hosts.splice(0)) await h.close();
});

async function start(): Promise<{ bridge: Bridge; host: Host }> {
	const bridge = new Bridge({ serverVersion: "0.1.0", policy: autoPolicy() });
	const host = await createHost(bridge);
	hosts.push(host);
	return { bridge, host };
}

function connectCode(bridge: Bridge): string {
	return bridge.mintCode({ app: APP, origin: PAGE_ORIGIN }).code;
}

/** connect() resolves once the handshake completes; registration is processed a beat later — poll. */
async function waitTool(bridge: Bridge, bridgeName: string, timeoutMs = 5000): Promise<void> {
	const t0 = Date.now();
	for (;;) {
		if (bridge.listTools().some((t) => t.bridgeName === bridgeName)) return;
		if (Date.now() - t0 > timeoutMs) throw new Error(`tool ${bridgeName} never appeared`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

function waitForStatus(gbox: Glassbox, want: string, timeoutMs = 8000): Promise<void> {
	return new Promise((resolve, reject) => {
		if (gbox.status === want) return resolve();
		const t = setTimeout(
			() => reject(new Error(`status "${want}" not reached (now ${gbox.status})`)),
			timeoutMs,
		);
		const cb = (s: { status: string }) => {
			if (s.status === want) {
				clearTimeout(t);
				resolve();
			}
		};
		gbox.on("status", cb as (data: never) => void);
	});
}

describe("sdk (spec §4.2, §5.2)", () => {
	it("decodes a self-describing connect code", () => {
		const { bridge } = startSync();
		const code = connectCode(bridge);
		const t = decodeConnectCode(code);
		expect(t.host).toBe("127.0.0.1");
		expect(t.port).toBe(8123);
		expect(t.app).toBe(APP);
		expect(() => decodeConnectCode("garbage")).toThrowError(/invalid connect code/);
	});

	it("connects, dispatches a tool, and emits call events", async () => {
		const { bridge } = await start();
		const gbox = new Glassbox(APP);
		const calls: Array<{ name: string; phase: string }> = [];
		gbox.on("call", (c: { name: string; phase: string }) =>
			calls.push({ name: c.name, phase: c.phase }),
		);

		gbox.tool("add", "Sum two numbers", { tier: "read" }, ({ a, b }) => ({
			sum: Number(a) + Number(b),
		}));
		gbox.tool("boom", "Throws", () => {
			throw new Error("kaboom");
		});

		await gbox.connect(connectCode(bridge));
		expect(gbox.status).toBe("connected");
		await waitTool(bridge, "localhost-8123__add");

		const r = await bridge.callTool("localhost-8123__add", { a: 2, b: 40 });
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent).toEqual({ sum: 42 });

		await waitTool(bridge, "localhost-8123__boom");
		const bad = await bridge.callTool("localhost-8123__boom", {});
		expect(bad.isError).toBe(true);
		expect(bad.content[0]!.text).toBe("kaboom");
		expect((bad.structuredContent as { code: string }).code).toBe("PAGE_ERROR");

		expect(calls.some((c) => c.name === "add" && c.phase === "start")).toBe(true);
		expect(calls.some((c) => c.name === "add" && c.phase === "end")).toBe(true);

		gbox.disconnect();
	});

	it("answers prompt, resource, and sampling requests", async () => {
		const { bridge } = await start();
		const gbox = new Glassbox(APP);
		gbox.prompt("explain", { description: "Explain state" }, (args) => [
			{ role: "user", content: `why:${String(args.why)}` },
		]);
		gbox.resource("board://state", "Live board", () => ({ tiles: 3 }));
		gbox.sampling((p) => ({ echo: p.messages.length, maxTokens: p.maxTokens }));

		await gbox.connect(connectCode(bridge));
		const pr = await bridge.requestPrompt("localhost-8123", "explain", { why: "test" });
		expect(pr.type).toBe("prompt.result");
		expect((pr as { messages: unknown[] }).messages).toEqual([
			{ role: "user", content: "why:test" },
		]);

		const rr = await bridge.requestResource("localhost-8123", "board://state");
		expect(rr.type).toBe("resource.result");
		const contents = (rr as { contents: Array<{ text: string }> }).contents;
		expect(JSON.parse(contents[0]!.text)).toEqual({ tiles: 3 });

		const sr = await bridge.requestSampling("localhost-8123", {
			messages: [{ role: "user", content: "hi" }],
			maxTokens: 64,
		});
		expect(sr.type).toBe("sampling.result");
		expect((sr as { value: unknown }).value).toEqual({ echo: 1, maxTokens: 64 });

		// unknown name → typed page error, not a hang
		const no = await bridge.requestPrompt("localhost-8123", "ghost", {});
		expect((no as { type: string }).type).toBe("prompt.result");
		expect((no as { error: { code: string } }).error.code).toBe("PAGE_ERROR");

		gbox.disconnect();
	});

	it("auto-reconnects after a drop: refresh with stored session, re-register, no new code (spec §5.2)", async () => {
		const { bridge } = await start();
		const gbox = new Glassbox(APP);
		gbox.tool("echo", "Echo", () => ({ reloaded: true }));
		await gbox.connect(connectCode(bridge));

		// simulate the drop (reload / bridge restart) from the wire side
		const ws = (gbox as unknown as { ws: WebSocket }).ws;
		expect(ws).toBeTruthy();
		ws!.close();

		await waitForStatus(gbox, "reconnecting");
		await waitForStatus(gbox, "connected", 10_000);
		await waitTool(bridge, "localhost-8123__echo");

		const r = await bridge.callTool("localhost-8123__echo", {});
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent).toEqual({ reloaded: true });

		gbox.disconnect();
	});

	it("the 'connected' status event flags a fresh connect vs a resumed session (feed wording, spec §5.2)", async () => {
		const { bridge } = await start();
		const gbox = new Glassbox(APP);
		const connected: Array<{ resumed?: boolean }> = [];
		gbox.on("status", (s: { status: string; resumed?: boolean }) => {
			if (s.status === "connected") connected.push(s);
		});

		// fresh pairing from a pasted code
		await gbox.connect(connectCode(bridge));
		expect(connected.map((e) => e.resumed)).toEqual([false]);

		// wire drop → auto-reconnect re-attaches the SAME session → "resumed"
		const ws = (gbox as unknown as { ws: WebSocket }).ws;
		expect(ws).toBeTruthy();
		ws!.close();
		await waitForStatus(gbox, "reconnecting");
		await waitForStatus(gbox, "connected", 10_000);
		expect(connected.map((e) => e.resumed)).toEqual([false, true]);

		gbox.disconnect();
	});

	it("reconnectNow() skips the backoff: ws drop with a live bridge → connected (spec §5.2)", async () => {
		const { bridge } = await start();
		const gbox = new Glassbox(APP);
		gbox.tool("echo", "Echo", () => ({ ok: true }));
		await gbox.connect(connectCode(bridge));

		const ws = (gbox as unknown as { ws: WebSocket }).ws;
		expect(ws).toBeTruthy();
		ws!.close();

		await waitForStatus(gbox, "reconnecting");
		const p = gbox.reconnectProgress;
		expect(p).not.toBeNull();
		expect(p!.attempt).toBeGreaterThanOrEqual(1);

		// manual affordance (widget "Reconnect"): no waiting for the backoff
		gbox.reconnectNow();
		await waitForStatus(gbox, "connected", 5_000);
		expect(gbox.reconnectProgress).toBeNull();
		await waitTool(bridge, "localhost-8123__echo"); // re-registration is async after hello.ack

		const r = await bridge.callTool("localhost-8123__echo", {});
		expect(r.isError).toBeUndefined();
		gbox.disconnect();
	});

	it("bridge offline → 'offline' at the backoff cap, with progress (spec §5.2)", async () => {
		const { bridge, host } = await start();
		const gbox = new Glassbox(APP);
		gbox.tool("echo", "Echo", () => ({}));
		await gbox.connect(connectCode(bridge));

		// kill the bridge: splice FIRST so afterAll doesn't double-close
		// (a second close on the terminated wss never fires its callback)
		hosts.splice(hosts.indexOf(host), 1);
		await host.close();

		// backoff 250/500/1000/2000 → cap 4000 → offline ≈ 4–5 s after the drop
		await waitForStatus(gbox, "offline", 15_000);
		const p = gbox.reconnectProgress;
		expect(p).not.toBeNull();
		expect(p!.attempt).toBeGreaterThanOrEqual(5);
		expect(p!.nextInMs).toBeLessThanOrEqual(4_000);

		gbox.disconnect(); // stop the retry loop so the suite exits cleanly
	}, 20_000);

	it("bridge restart → offline asks for a NEW code, and pasting one recovers (spec §5.2)", async () => {
		const first = await start();
		const gbox = new Glassbox(APP);
		gbox.tool("echo", "Echo", () => ({ recovered: true }));
		await gbox.connect(connectCode(first.bridge));

		// the bridge process goes away: its in-memory session registry goes with it
		hosts.splice(hosts.indexOf(first.host), 1);
		await first.host.close();
		await waitForStatus(gbox, "offline", 15_000);
		expect(widgetStatusText(gbox.status)).toMatch(/unreachable.*NEW code/);
		expect(pasteHint(gbox.status)).toBe("paste a NEW connect code");

		// a restarted bridge is a different process with a different port: paste its code
		const second = await start();
		await gbox.connect(connectCode(second.bridge));
		expect(gbox.status).toBe("connected");
		await waitTool(second.bridge, "localhost-8123__echo");
		const r = await second.bridge.callTool("localhost-8123__echo", {});
		expect(r.structuredContent).toEqual({ recovered: true });
		gbox.disconnect();
	}, 30_000);

	it("a fresh code after a bridge restart is not a 'resumed' session (feed wording, spec §5.2)", async () => {
		const first = await start();
		const gbox = new Glassbox(APP);
		const connected: Array<{ resumed?: boolean }> = [];
		gbox.on("status", (s: { status: string; resumed?: boolean }) => {
			if (s.status === "connected") connected.push(s);
		});
		await gbox.connect(connectCode(first.bridge));

		// the bridge process goes away: its in-memory session registry goes with it (spec §4.1)
		hosts.splice(hosts.indexOf(first.host), 1);
		await first.host.close();
		// wait for the SDK to notice the drop so no racing retry re-attaches after the new pair
		await waitForStatus(gbox, "reconnecting");

		// the restarted bridge is a different process with a different port: paste its code.
		// That is a NEW session — the feed must not call it a resume.
		const second = await start();
		await gbox.connect(connectCode(second.bridge));
		expect(connected.map((e) => e.resumed)).toEqual([false, false]);
		gbox.disconnect();
	});

	it("auto-resumes the stored session on page load — no new connect code (spec §5.2)", async () => {
		const mem: Record<string, string> = {};
		const storage = {
			getItem: (k: string) => mem[k] ?? null,
			setItem: (k: string, v: string) => {
				mem[k] = v;
			},
			removeItem: (k: string) => {
				delete mem[k];
			},
		};
		const { bridge } = await start();
		const g1 = new Glassbox(APP, { storage });
		g1.tool("echo", "Echo", () => ({ reloaded: true }));
		await g1.connect(connectCode(bridge));
		expect(Object.keys(mem).length).toBe(1); // session persisted
		g1.disconnect(); // old page unloads

		// new page load: fresh instance, same storage, NO code — must come up connected
		const g2 = new Glassbox(APP, { storage });
		g2.tool("echo", "Echo", () => ({ reloaded: true }));
		await waitForStatus(g2, "connected", 10_000);
		await waitTool(bridge, "localhost-8123__echo");
		const r = await bridge.callTool("localhost-8123__echo", {});
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent).toEqual({ reloaded: true });
		g2.disconnect();
	});

	it("stops reconnecting after revocation and reports expired (spec §5.2)", async () => {
		const { bridge } = await start();
		const gbox = new Glassbox(APP);
		gbox.tool("echo", "Echo", () => ({}));
		await gbox.connect(connectCode(bridge));
		const sid = bridge.listSessions()[0]!.sid;
		const revokeP = waitForStatus(gbox, "expired", 5000);
		bridge.revoke(sid, "test");
		await revokeP;
		// an intentional state: no reconnect attempts scheduled
		await new Promise((r) => setTimeout(r, 700));
		expect(gbox.status).toBe("expired");
	});

	it("revokeSession() asks the bridge to drop the session server-side (widget Disconnect, WP6)", async () => {
		const { bridge } = await start();
		const gbox = new Glassbox(APP);
		gbox.tool("echo", "Echo", () => ({}));
		await gbox.connect(connectCode(bridge));
		const sid = bridge.listSessions()[0]!.sid;

		const expired = waitForStatus(gbox, "expired", 5000);
		gbox.revokeSession("user-disconnect");
		await expired;

		// the bridge forgot the session too (the wire round-trip is async — poll)
		const t0 = Date.now();
		for (;;) {
			if (!bridge.listSessions().some((s) => s.sid === sid)) break;
			if (Date.now() - t0 > 5000) throw new Error("session was not dropped server-side");
			await new Promise((r) => setTimeout(r, 10));
		}
		// and it cannot be refreshed back to life on reload (immediate RST, spec §5.2)
		expect(() => bridge.refreshSession(sid, "whatever")).toThrowError();
	});

	it("page errors carry the call's traceId on the call end event (widget feed, spec §5.8)", async () => {
		const { bridge } = await start();
		const gbox = new Glassbox(APP);
		gbox.tool("boom", "Throws", () => {
			throw new Error("kaboom");
		});
		await gbox.connect(connectCode(bridge));
		await waitTool(bridge, "localhost-8123__boom");
		let end: { error?: { code: string; message: string; traceId?: string } } | undefined;
		gbox.on(
			"call",
			(c: { phase: string; error?: { code: string; message: string; traceId?: string } }) => {
				if (c.phase === "end") end = c;
			},
		);
		const r = await bridge.callTool("localhost-8123__boom", {});
		expect(r.isError).toBe(true);
		// the end event was emitted before the result reached the bridge — no polling needed
		expect(end?.error?.code).toBe("PAGE_ERROR");
		expect(end?.error?.message).toBe("kaboom");
		expect(end?.error?.traceId).toMatch(/^tr-\d+$/);
		gbox.disconnect();
	});

	it("emits multiple pending consent requests in order (widget queues them one at a time)", async () => {
		const bridge = new Bridge({
			serverVersion: "0.1.0",
			policy: new PolicyFile({ [APP]: { write: "consent" } }),
		});
		const host = await createHost(bridge);
		hosts.push(host);
		const gbox = new Glassbox(APP);
		gbox.tool("a", "A", { tier: "write" }, () => ({ a: true }));
		gbox.tool("b", "B", { tier: "write" }, () => ({ b: true }));
		const seen: Array<{ id: number; tool: string }> = [];
		gbox.on("consent", (r: { id: number; tool: string }) => {
			seen.push({ id: r.id, tool: r.tool });
		});
		await gbox.connect(connectCode(bridge));
		await waitTool(bridge, "localhost-8123__a");
		await waitTool(bridge, "localhost-8123__b");

		const pa = bridge.callTool("localhost-8123__a", {});
		await new Promise((r) => setTimeout(r, 150));
		const pb = bridge.callTool("localhost-8123__b", {});
		await new Promise((r) => setTimeout(r, 150));
		expect(seen.map((s) => s.tool)).toEqual(["a", "b"]);

		// resolve in order (as the serialized widget would) — both calls then dispatch
		gbox.resolveConsent(seen[0]!.id, "approved");
		const ra = await pa;
		gbox.resolveConsent(seen[1]!.id, "approved");
		const rb = await pb;
		expect(ra.isError).toBeUndefined();
		expect(rb.isError).toBeUndefined();
		gbox.disconnect();
	});

	it("renders the widget (code input + status + consent chip) into a mount", () => {
		// headless DOM smoke test: a minimal document stub that records attributes
		class El {
			children: Array<El> = [];
			textContent = "";
			className = "";
			attrs: Record<string, string> = {};
			setAttribute(k: string, v: string): void {
				this.attrs[k] = v;
			}
			getAttribute(k: string): string | null {
				return this.attrs[k] ?? null;
			}
			appendChild(c: El): void {
				this.children.push(c);
			}
			append(...c: El[]): void {
				for (const x of c) this.children.push(x);
			}
			addEventListener(): void {}
			remove(): void {}
			contains(): boolean {
				return false;
			}
			focus(): void {}
		}
		const doc = {
			body: new El(),
			createElement: () => new El(),
			querySelector: () => null,
			addEventListener(): void {},
		} as unknown as Document;
		const prev = (globalThis as Record<string, unknown>).document;
		(globalThis as Record<string, unknown>).document = doc;
		try {
			const gbox = new Glassbox(APP);
			const el = renderWidget(gbox);
			// style + status + expand toggle + input row + QR slot + feed + consent chip
			expect(el.children.length).toBe(7);
			expect(
				Array.from(el.children).some((c) => (c as HTMLElement).className === "gb-expand"),
			).toBe(true);
			// Widget buttons must not submit a host page's form if mounted inline.
			const row = Array.from(el.children).find((c) => (c as HTMLElement).className === "gb-row")!;
			const expand = Array.from(el.children).find(
				(c) => (c as HTMLElement).className === "gb-expand",
			)!;
			for (const b of [...Array.from(row.children), expand]) {
				if (["Connect", "Reconnect", "Disconnect", "▴ activity"].includes(b.textContent)) {
					expect((b as unknown as { type?: string }).type).toBe("button");
				}
			}
			expect(el.getAttribute("data-phase")).toBe("pairing");
			expect(el.getAttribute("data-expanded")).toBe("false");
			expect(el.getAttribute("data-placement")).toBe("auto");
			const inline = renderWidget(new Glassbox(APP), { placement: "inline" });
			expect(inline.getAttribute("data-placement")).toBe("inline");
		} finally {
			(globalThis as Record<string, unknown>).document = prev;
		}
	});

	it("the feed logs '● connected' for a fresh pairing and the resume line only for a resume (spec §5.2)", async () => {
		const { bridge } = await start();
		// headless DOM: the minimal stub from the render test, plus the feed's prepend/lastChild
		class El {
			children: Array<El> = [];
			textContent = "";
			className = "";
			appendChild(c: El): void {
				this.children.push(c);
			}
			prepend(c: El): void {
				this.children.unshift(c);
			}
			append(...c: El[]): void {
				for (const x of c) this.children.push(x);
			}
			get lastChild(): El | null {
				return this.children[0] ?? null;
			}
			addEventListener(): void {}
			setAttribute(): void {}
			remove(): void {}
			contains(): boolean {
				return false;
			}
			focus(): void {}
		}
		const doc = {
			body: new El(),
			createElement: () => new El(),
			querySelector: () => null,
			addEventListener(): void {},
		} as unknown as Document;
		const prev = (globalThis as Record<string, unknown>).document;
		(globalThis as Record<string, unknown>).document = doc;
		try {
			const mem: Record<string, string> = {};
			const storage = {
				getItem: (k: string) => mem[k] ?? null,
				setItem: (k: string, v: string) => {
					mem[k] = v;
				},
				removeItem: (k: string) => {
					delete mem[k];
				},
			};

			// fresh pairing (paste): the feed line is a first connect, not a resume
			const gbox = new Glassbox(APP, { storage });
			gbox.tool("echo", "Echo", () => ({}));
			const el = renderWidget(gbox) as unknown as El;
			await gbox.connect(connectCode(bridge));
			const feed = el.children.find((c) => c.className === "gb-feed")!;
			expect(feed.children[0]!.textContent).toBe("● connected");
			gbox.disconnect(); // the old page unloads

			// "page reload": a fresh instance, same storage — the constructor auto-resumes
			// the stored session, so the feed line is the resume wording
			const g2 = new Glassbox(APP, { storage });
			const el2 = renderWidget(g2) as unknown as El;
			await waitForStatus(g2, "connected", 10_000);
			const feed2 = el2.children.find((c) => c.className === "gb-feed")!;
			expect(feed2.children[0]!.textContent).toBe("↻ reconnected (session resumed)");
			g2.disconnect();
		} finally {
			(globalThis as Record<string, unknown>).document = prev;
		}
	});
});

describe("consent dialog focus (spec §7.3)", () => {
	it("Tab moves Deny → Approve → Deny and never leaves the two buttons", () => {
		// buttons in DOM order: [Approve, Deny]; focus starts on Deny (index 1)
		expect(cycleFocusIndex(1, 2, false)).toBe(0);
		expect(cycleFocusIndex(0, 2, false)).toBe(1);
	});

	it("Shift+Tab moves Deny → Approve → Deny", () => {
		expect(cycleFocusIndex(1, 2, true)).toBe(0);
		expect(cycleFocusIndex(0, 2, true)).toBe(1);
	});

	it("focus outside the buttons lands on the first (Tab) or last (Shift+Tab) button", () => {
		expect(cycleFocusIndex(-1, 2, false)).toBe(0);
		expect(cycleFocusIndex(-1, 2, true)).toBe(1);
	});

	it("no buttons means nothing to focus", () => {
		expect(cycleFocusIndex(-1, 0, false)).toBe(-1);
	});
});

describe("widget status wording (spec §5.2)", () => {
	it("offline names the restart and the NEW-code path; transient states show the attempt", () => {
		expect(widgetStatusText("offline", 3)).toMatch(/unreachable.*— attempt 3$/);
		expect(widgetStatusText("reconnecting", 2)).toMatch(/— attempt 2$/);
		expect(widgetStatusText("connected", 2)).not.toMatch(/attempt/);
		expect(widgetStatusText("expired", 0)).not.toMatch(/attempt/);
	});

	it("the paste placeholder asks for a NEW code in every dead-end or restart state", () => {
		for (const s of ["offline", "expired", "disconnected"] as const) {
			expect(pasteHint(s)).toBe("paste a NEW connect code");
		}
		for (const s of ["connecting", "connected", "reconnecting"] as const) {
			expect(pasteHint(s)).toBe("paste connect code");
		}
	});
});

describe("widget placement invariants (two-phase)", () => {
	it("only a live session docks; every other state is the centred pairing overlay", () => {
		expect(widgetPhase("connected")).toBe("live");
		for (const s of ["disconnected", "connecting", "reconnecting", "offline", "expired"] as const) {
			expect(widgetPhase(s)).toBe("pairing");
		}
	});

	it("the widget is fixed, consent stays viewport-centred and above it, and the root has no transform", () => {
		const css = widgetCss();
		const root = css.match(/\.gb-widget\{[^}]*\}/)?.[0] ?? "";
		expect(root).toMatch(/position:fixed/);
		// a transformed widget would become the containing block for the fixed
		// consent dialog — it would no longer cover the viewport (spec §7.3).
		expect(root).not.toMatch(/transform|translate/);
		expect(css).toMatch(/\.gb-widget\[data-phase="pairing"\]\{inset:0;margin:auto/);
		expect(css).toMatch(/0 0 0 100vmax rgba\(0,0,0,\.55\)/);
		expect(css).toMatch(/\.gb-widget\[data-phase="live"\]\{inset:auto/);
		expect(css).toMatch(/:not\(\[data-expanded="true"\]\)/);
		const consent = css.match(/\.gb-consent\{[^}]*\}/)?.[0] ?? "";
		expect(consent).toMatch(/position:fixed/);
		expect(consent).toMatch(/translate\(-50%,-50%\)/);
		const widgetZ = Number(root.match(/z-index:(\d+)/)?.[1]);
		const consentZ = Number(consent.match(/z-index:(\d+)/)?.[1]);
		expect(consentZ).toBeGreaterThan(widgetZ);
	});

	it("a real connect flips the overlay to a collapsed dock; disconnect re-opens the overlay", async () => {
		const { bridge } = await start();
		class El {
			children: Array<El> = [];
			textContent = "";
			className = "";
			attrs: Record<string, string> = {};
			setAttribute(k: string, v: string): void {
				this.attrs[k] = v;
			}
			getAttribute(k: string): string | null {
				return this.attrs[k] ?? null;
			}
			appendChild(c: El): void {
				this.children.push(c);
			}
			prepend(...c: El[]): void {
				this.children.unshift(...c);
			}
			append(...c: El[]): void {
				this.children.push(...c);
			}
			get lastChild(): El | null {
				return this.children[0] ?? null;
			}
			addEventListener(): void {}
			remove(): void {}
			contains(): boolean {
				return false;
			}
			focus(): void {}
		}
		const doc = {
			body: new El(),
			createElement: () => new El(),
			querySelector: () => null,
			addEventListener(): void {},
		} as unknown as Document;
		const prev = (globalThis as Record<string, unknown>).document;
		(globalThis as Record<string, unknown>).document = doc;
		try {
			const gbox = new Glassbox(APP);
			gbox.tool("echo", "Echo", () => ({}));
			const el = renderWidget(gbox) as unknown as El;
			expect(el.getAttribute("data-phase")).toBe("pairing");
			await gbox.connect(connectCode(bridge));
			expect(el.getAttribute("data-phase")).toBe("live");
			expect(el.getAttribute("data-expanded")).toBe("false");
			gbox.disconnect();
			expect(el.getAttribute("data-phase")).toBe("pairing");
		} finally {
			(globalThis as Record<string, unknown>).document = prev;
		}
	});
});

// helper for the sync-only decode test
function startSync(): { bridge: Bridge } {
	const bridge = new Bridge({ serverVersion: "0.1.0" });
	bridge.setEndpoint("127.0.0.1", 8123);
	return { bridge };
}
