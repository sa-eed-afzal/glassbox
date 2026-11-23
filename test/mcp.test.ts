/**
 * MCP stdio server (spec §5.6, §5.7, §5.4): tools/list + tools/call +
 * notifications/tools/list_changed on every register/unregister, prompt parity,
 * glassbox://channels resource, and full result coercion. Driven through the
 * real SDK client over an in-memory transport pair — the same wire schema as stdio.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAudit } from "../src/bridge/audit.js";
import { Bridge } from "../src/bridge/bridge.js";
import type { Link } from "../src/bridge/link.js";
import { autoPolicy } from "../src/bridge/policy.js";
import { ManualScheduler } from "../src/bridge/scheduler.js";
import { FakeClock } from "../src/core/clock.js";
import { decode, encode, type PageToBridgeMsg } from "../src/core/codec.js";
import { GlassboxErrorCode } from "../src/core/errors.js";
import { bridgeToolName } from "../src/core/naming.js";
import { PROTOCOL_VERSION } from "../src/core/version.js";
import { createMcpServer, type McpHandle } from "../src/mcp/server.js";
import { flush, makePair } from "./link.js";

const ORIGIN = "http://localhost:8123";
const APP = "echo-app";
type WireMsg = { type: string } & Record<string, unknown>;

interface Page {
	send(m: unknown): void;
	onFrame: ((m: WireMsg) => void) | null;
}

interface Ctx {
	bridge: Bridge;
	mcp: McpHandle;
	client: Client;
	page: Page;
	register(name: string, opts?: { tier?: string; timeoutMs?: number; inputSchema?: unknown }): void;
}

async function start(): Promise<Ctx> {
	const bridge = new Bridge({
		serverVersion: "0.1.0",
		clock: new FakeClock(),
		scheduler: new ManualScheduler(),
		audit: new InMemoryAudit(),
		policy: autoPolicy(),
	});
	bridge.setEndpoint("127.0.0.1", 8123);
	const view = bridge.issueSession(bridge.mintCode({ app: APP, origin: ORIGIN }).code);
	bridge.hello(view.sid, {
		type: "hello",
		v: PROTOCOL_VERSION,
		sid: view.sid,
		app: APP,
		origin: ORIGIN,
		tab: "t",
	});

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const mcp = createMcpServer(bridge);
	await mcp.server.connect(serverTransport);
	const client = new Client({ name: "glassbox-test", version: "1.0.0" }, { capabilities: {} });
	await client.connect(clientTransport);

	const { a, b } = makePair();
	const page: Page = {
		send: (m: unknown) => b.send(encode(m as PageToBridgeMsg)),
		onFrame: null,
	};
	b.onMessage((frame) => {
		const m = decode(frame) as unknown as WireMsg;
		page.onFrame?.(m);
	});
	a.onMessage((frame) => bridge.deliver(view.sid, decode(frame) as PageToBridgeMsg));
	bridge.attach(view.sid, a as Link);

	const register = (
		name: string,
		opts?: { tier?: string; timeoutMs?: number; inputSchema?: unknown },
	) => {
		const msg: Record<string, unknown> = {
			type: "tool.register",
			name,
			description: `tool ${name}`,
		};
		if (opts?.tier) msg.tier = opts.tier;
		if (opts?.timeoutMs) msg.timeoutMs = opts.timeoutMs;
		if (opts?.inputSchema) msg.inputSchema = opts.inputSchema;
		page.send(msg);
	};
	return { bridge, mcp, client, page, register };
}

const handles: Array<{ mcp: McpHandle; client: Client }> = [];
afterEach(async () => {
	for (const h of handles.splice(0)) {
		await h.client.close().catch(() => {});
		await h.mcp.close().catch(() => {});
	}
});
async function setup(): Promise<Ctx> {
	const ctx = await start();
	handles.push({ mcp: ctx.mcp, client: ctx.client });
	return ctx;
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > timeoutMs) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe("mcp server (spec §5.6, §5.7, §5.4)", () => {
	it("lists built-ins plus channel tools with tier annotations", async () => {
		const { client, register } = await setup();
		register("add", {
			tier: "read",
			inputSchema: {
				type: "object",
				properties: { a: { type: "number" }, b: { type: "number" } },
				required: ["a", "b"],
			},
		});
		await flush();
		register("dangerous-thing", { tier: "dangerous" });
		await flush();

		const { tools } = await client.listTools();
		const byName = new Map(tools.map((t) => [t.name, t]));
		for (const builtin of [
			"glassbox_code",
			"glassbox_channels",
			"glassbox_status",
			"glassbox_prompt",
			"glassbox_resource",
			"glassbox_sample",
		]) {
			expect(byName.has(builtin)).toBe(true);
		}
		const add = byName.get(bridgeToolName(ORIGIN, "add"))!;
		expect(add.annotations?.readOnlyHint).toBe(true);
		expect(add.annotations?.destructiveHint).toBe(false);
		expect(add.inputSchema?.required).toEqual(["a", "b"]);
		const danger = byName.get(bridgeToolName(ORIGIN, "dangerous-thing"))!;
		expect(danger.annotations?.readOnlyHint).toBe(false);
		expect(danger.annotations?.destructiveHint).toBe(true);
	});

	it("answers glassbox_status, glassbox_code, glassbox_channels", async () => {
		const { client } = await setup();

		const status = await client.callTool({ name: "glassbox_status", arguments: {} });
		expect(status.isError).toBeUndefined();
		expect((status.structuredContent as { ok: boolean }).ok).toBe(true);

		const code = await client.callTool({
			name: "glassbox_code",
			arguments: { app: APP, origin: ORIGIN },
		});
		const sc = code.structuredContent as { code: string; endpoint: string; expiresMs: number };
		expect(typeof sc.code).toBe("string");
		expect(sc.code.length).toBeGreaterThan(10);
		expect(sc.endpoint).toBe("ws://127.0.0.1:8123/session");
		expect(sc.expiresMs).toBe(60_000);

		const chans = await client.callTool({ name: "glassbox_channels", arguments: {} });
		const chansArr = (chans.structuredContent as { value: Array<{ channel: string }> }).value;
		expect(chansArr.length).toBe(1);
		expect(chansArr[0]!.channel).toBe("localhost-8123");
	});

	it("dispatches a channel tool call through the page and coerces the result", async () => {
		const { client, page, register } = await setup();
		register("add");
		await flush();
		page.onFrame = (m) => {
			if (m.type === "tool.call") {
				const args = m.args as { a: number; b: number };
				page.send({ type: "tool.result", id: m.id, value: { sum: args.a + args.b } });
			}
		};
		const r = await client.callTool({
			name: bridgeToolName(ORIGIN, "add"),
			arguments: { a: 2, b: 3 },
		});
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent).toEqual({ sum: 5 });
	});

	it("returns a typed UNKNOWN_TOOL for an unknown tool", async () => {
		const { client } = await setup();
		const r = await client.callTool({ name: "localhost-8123__nope", arguments: {} });
		expect(r.isError).toBe(true);
		expect((r.structuredContent as { code: string }).code).toBe(GlassboxErrorCode.UNKNOWN_TOOL);
	});

	it("returns DEADLINE for a page that never answers", async () => {
		const { bridge, client, register } = await setup();
		register("hang", { timeoutMs: 200 });
		await flush();
		const p = client.callTool({ name: bridgeToolName(ORIGIN, "hang"), arguments: {} });
		await flush(); // let the request reach the server so the deadline timer is scheduled
		(bridge as unknown as { scheduler: ManualScheduler }).scheduler.fireAll();
		const r = await p;
		expect(r.isError).toBe(true);
		expect((r.structuredContent as { code: string }).code).toBe(GlassboxErrorCode.DEADLINE);
	});

	it("emits tools/list_changed on register and unregister (spec §5.6)", async () => {
		const { client, page, register } = await setup();
		let changes = 0;
		client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
			changes++;
		});
		register("echo");
		await flush();
		await waitFor(() => changes >= 1);
		const afterRegister = changes;
		page.send({ type: "tool.unregister", name: "echo" });
		await flush();
		await waitFor(() => changes > afterRegister);
	});

	it("serves glassbox://channels as a resource", async () => {
		const { client, register } = await setup();
		register("echo");
		await flush();
		const { resources } = await client.listResources();
		expect(resources.map((r) => String(r.uri))).toContain("glassbox://channels");
		const res = await client.readResource({ uri: "glassbox://channels" });
		const part = res.contents[0]!;
		const body = JSON.parse(String("text" in part ? part.text : "")) as Array<{
			channel: string;
			tools: string[];
		}>;
		expect(body.length).toBe(1);
		expect(body[0]!.channel).toBe("localhost-8123");
		expect(body[0]!.tools).toEqual([bridgeToolName(ORIGIN, "echo")]);
	});

	it("answers glassbox_prompt with the page's messages (spec §5.7 parity)", async () => {
		const { client, page } = await setup();
		page.onFrame = (m) => {
			if (m.type === "prompt.request") {
				page.send({
					type: "prompt.result",
					id: m.id,
					messages: [{ role: "user", content: `prompt:${String(m.name)}` }],
				});
			}
		};
		const r = await client.callTool({
			name: "glassbox_prompt",
			arguments: { channel: "localhost-8123", name: "explain", args: {} },
		});
		expect(r.isError).toBeUndefined();
		const sc = r.structuredContent as { messages: unknown[] };
		expect(sc.messages).toEqual([{ role: "user", content: "prompt:explain" }]);
	});
});
