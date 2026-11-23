/**
 * echo-app: the conformance fixture page (spec §9).
 * Implements the PAGE side of glassbox/v1 (§5.8) over a Link —
 * in M0 in-process, in M1 the real browser via glassbox.js.
 */
import { type BridgeToPageMsg, decode, encode } from "../../src/core/codec.js";
import { PROTOCOL_VERSION } from "../../src/core/version.js";
import type { Link } from "../../test/link.js";

export interface EchoApp {
	ready: boolean;
	revoked?: string;
	lastError?: { code: string; message: string };
	hello(): void;
	register(name: string, description: string, tier?: "read" | "write" | "dangerous"): void;
	unregister(name: string): void;
}

export function createEchoApp(link: Link, origin = "http://localhost:8123"): EchoApp {
	const tools = new Map<
		string,
		{ description: string; run: (args: Record<string, unknown>) => unknown }
	>();
	tools.set("echo", { description: "Echo a string back", run: ({ text }) => text });
	tools.set("add", {
		description: "Sum two numbers",
		run: ({ a, b }) => ({ sum: Number(a) + Number(b) }),
	});
	tools.set("hang", { description: "Never resolves", run: () => new Promise(() => {}) });

	const app: EchoApp = {
		ready: false,
		hello() {
			link.send(
				encode({
					type: "hello",
					v: PROTOCOL_VERSION,
					sid: "sid-1",
					app: "echo-app",
					origin,
					tab: "tab-1",
				}),
			);
		},
		register(name, description, tier) {
			link.send(
				encode({
					type: "tool.register",
					name,
					description,
					...(tier !== undefined ? { tier } : {}),
				}),
			);
		},
		unregister(name) {
			link.send(encode({ type: "tool.unregister", name }));
		},
	};

	link.onMessage((frame) => {
		const m = decode(frame) as BridgeToPageMsg;
		switch (m.type) {
			case "hello.ack":
				app.ready = true;
				return;
			case "error":
				app.lastError = { code: m.code, message: m.message };
				return;
			case "session.revoke":
				app.revoked = m.reason;
				return;
			case "tool.call": {
				link.send(encode({ type: "call.event", id: m.id, phase: "start" }));
				const tool = tools.get(m.name);
				if (!tool) {
					link.send(
						encode({
							type: "tool.result",
							id: m.id,
							error: { code: "UNKNOWN_TOOL", message: `no such tool: ${m.name}` },
						}),
					);
					return;
				}
				Promise.resolve(tool.run((m.args ?? {}) as Record<string, unknown>)).then(
					(value) => {
						link.send(encode({ type: "call.event", id: m.id, phase: "end", ms: 1 }));
						link.send(encode({ type: "tool.result", id: m.id, value }));
					},
					(err: unknown) =>
						link.send(
							encode({
								type: "tool.result",
								id: m.id,
								error: { code: "PAGE_ERROR", message: String(err) },
							}),
						),
				);
				return;
			}
			case "resource.request":
				link.send(
					encode({
						type: "resource.result",
						id: m.id,
						contents: [{ uri: m.uri, mimeType: "text/plain", text: "echo-app page content" }],
					}),
				);
				return;
			case "prompt.request":
				link.send(
					encode({
						type: "prompt.result",
						id: m.id,
						messages: [{ role: "user", content: `explain ${m.name}: ${JSON.stringify(m.args)}` }],
					}),
				);
				return;
			case "sampling.request": {
				const value = { answer: "42", schemaHonored: m.schema !== undefined };
				link.send(encode({ type: "sampling.result", id: m.id, value }));
				return;
			}
			default:
				return;
		}
	});
	return app;
}
