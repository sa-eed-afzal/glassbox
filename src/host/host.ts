import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { Bridge } from "../bridge/bridge.js";
import type { Link } from "../bridge/link.js";
import {
	decode,
	encode,
	type GlassboxMessage,
	type HelloMsg,
	type PageToBridgeMsg,
} from "../core/codec.js";
import { GlassboxErrorCode, isGlassboxError } from "../core/errors.js";
import { PROTOCOL_VERSION, SERVER_PRODUCT } from "../core/version.js";

/** Keepalive ping interval (spec §5.5). */
const DEFAULT_KEEPALIVE_MS = 25_000;
const MAX_BODY_BYTES = 64 * 1024;

interface AliveSocket extends WsSocket {
	isAlive?: boolean;
}

export interface HostEndpoint {
	host: string;
	port: number;
	url: string;
}

export interface Host {
	endpoint: HostEndpoint;
	close(): Promise<void>;
}

export interface HostOptions {
	host?: string;
	keepaliveMs?: number;
}

const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-headers": "content-type",
};

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		...CORS_HEADERS,
	});
	res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
	json(res, status, { error: { code, message } });
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (raw.length === 0) {
				resolve({});
				return;
			}
			try {
				const v: unknown = JSON.parse(raw);
				if (typeof v !== "object" || v === null || Array.isArray(v))
					reject(new Error("expected a JSON object"));
				else resolve(v as Record<string, unknown>);
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

/** Read the EXACT raw body (needed to verify the nonce signature over `path || body`). */
function readRawBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function nonceHeaders(req: IncomingMessage): {
	nonce: string | undefined;
	signature: string | undefined;
} {
	const nonce = req.headers["x-glassbox-nonce"];
	const signature = req.headers["x-glassbox-signature"];
	return {
		nonce: typeof nonce === "string" ? nonce : undefined,
		signature: typeof signature === "string" ? signature : undefined,
	};
}

/** Parse an already-read raw body into a JSON object (null on bad input). */
function parseBody(raw: string): Record<string, unknown> | null {
	if (raw.length === 0) return {};
	try {
		const v: unknown = JSON.parse(raw);
		return typeof v === "object" && v !== null && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Messages the bridge expects FROM the page (spec §5.8). Anything else on the page→bridge
 *  direction is a protocol violation. */
const PAGE_TO_BRIDGE = new Set<GlassboxMessage["type"]>([
	"tool.register",
	"tool.unregister",
	"tool.result",
	"prompt.result",
	"resource.result",
	"sampling.result",
	"call.event",
	"consent.result",
	"session.revoke",
]);

export function createHost(bridge: Bridge, opts: HostOptions = {}): Promise<Host> {
	const bindHost = opts.host ?? "127.0.0.1";
	const keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;

	const server: Server = createServer();
	const portNow = (): number => {
		const a = server.address();
		return a && typeof a === "object" ? a.port : 0;
	};
	const endpointUrl = (): string => `ws://${bindHost}:${portNow()}/session`;

	server.on("request", (req, res) => {
		// CORS preflight for the cross-origin session exchange (spec §7.1)
		if (req.method === "OPTIONS") {
			res.writeHead(204, { ...CORS_HEADERS, "access-control-allow-methods": "GET, POST, OPTIONS" });
			res.end();
			return;
		}
		let pathname = "";
		try {
			pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? bindHost}`).pathname;
		} catch {
			fail(res, 400, GlassboxErrorCode.PROTOCOL_ERROR, "bad request url");
			return;
		}

		if (req.method === "POST" && pathname === "/session") {
			readJson(req)
				.then((body) => {
					if (typeof body.code === "string") {
						// spec §5.2: the exchange carries the page origin; the code is
						// bound to origin + app, and a mismatch is a typed rejection.
						json(res, 200, {
							...bridge.issueSession(
								body.code,
								typeof body.origin === "string" ? body.origin : undefined,
							),
							endpoint: endpointUrl(),
						});
						return;
					}
					if (typeof body.sid === "string" && typeof body.sessionToken === "string") {
						json(res, 200, {
							...bridge.refreshSession(body.sid, body.sessionToken),
							endpoint: endpointUrl(),
						});
						return;
					}
					fail(
						res,
						400,
						GlassboxErrorCode.PROTOCOL_ERROR,
						"expected {code} or {sid, sessionToken}",
					);
				})
				.catch((e: unknown) => {
					const code = isGlassboxError(e) ? e.code : GlassboxErrorCode.PROTOCOL_ERROR;
					fail(
						res,
						code === GlassboxErrorCode.DEADLINE ? 401 : 400,
						code,
						e instanceof Error ? e.message : String(e),
					);
				});
			return;
		}

		// Management endpoints (spec §7.2, §9.4): nonce-gated when the bridge has a
		// credential (always, in `glassbox bridge`). Unsigned / foreign-key / replayed
		// requests → 401 + an `impersonation` audit line. /session + /health stay open
		// (the connect code is the discovery path; /health is version-only).
		const isManaged =
			(req.method === "POST" && (pathname === "/code" || pathname === "/drop")) ||
			(req.method === "GET" && pathname === "/channels");

		if (bridge.auth && isManaged) {
			readRawBody(req)
				.then((rawBody) => {
					const { nonce, signature } = nonceHeaders(req);
					const verdict = bridge.auth!.verify(
						nonce,
						req.method ?? "",
						pathname,
						rawBody,
						signature,
					);
					if (!verdict.ok) {
						bridge.recordImpersonation(`${req.method} ${pathname}: ${verdict.reason}`);
						fail(res, 401, GlassboxErrorCode.UNAUTHORIZED, verdict.reason);
						return;
					}
					routeManaged(req, res, pathname, rawBody);
				})
				.catch(() => fail(res, 400, GlassboxErrorCode.PROTOCOL_ERROR, "bad body"));
			return;
		}

		if (req.method === "POST" && pathname === "/code") {
			readJson(req)
				.then((body) => {
					const app = typeof body.app === "string" ? body.app : undefined;
					const origin = typeof body.origin === "string" ? body.origin : undefined;
					const callOpts: { app?: string; origin?: string } = {};
					if (app !== undefined) callOpts.app = app;
					if (origin !== undefined) callOpts.origin = origin;
					json(res, 200, bridge.mintCode(Object.keys(callOpts).length > 0 ? callOpts : undefined));
				})
				.catch(() => fail(res, 400, GlassboxErrorCode.PROTOCOL_ERROR, "bad body"));
			return;
		}

		if (req.method === "GET" && pathname === "/channels") {
			json(res, 200, bridge.listChannels());
			return;
		}

		if (req.method === "GET" && pathname === "/health") {
			json(res, 200, {
				ok: true,
				v: PROTOCOL_VERSION,
				server: `${SERVER_PRODUCT}/${bridge.serverVersion}`,
				endpoint: endpointUrl(),
			});
			return;
		}

		fail(res, 404, GlassboxErrorCode.PROTOCOL_ERROR, "not found");
	});

	/** Body-already-verified management routing: /code, /channels, /drop (spec §7.2). */
	function routeManaged(
		req: IncomingMessage,
		res: ServerResponse,
		pathname: string,
		rawBody: string,
	): void {
		if (req.method === "GET" && pathname === "/channels") {
			json(res, 200, bridge.listChannels());
			return;
		}
		if (req.method === "POST" && pathname === "/code") {
			const body = parseBody(rawBody);
			if (body === null) {
				fail(res, 400, GlassboxErrorCode.PROTOCOL_ERROR, "expected a JSON object body");
				return;
			}
			const app = typeof body.app === "string" ? body.app : undefined;
			const origin = typeof body.origin === "string" ? body.origin : undefined;
			const callOpts: { app?: string; origin?: string } = {};
			if (app !== undefined) callOpts.app = app;
			if (origin !== undefined) callOpts.origin = origin;
			json(res, 200, bridge.mintCode(Object.keys(callOpts).length > 0 ? callOpts : undefined));
			return;
		}
		if (req.method === "POST" && pathname === "/drop") {
			const body = parseBody(rawBody);
			if (body === null || typeof body.sid !== "string" || body.sid.length === 0) {
				fail(res, 400, GlassboxErrorCode.PROTOCOL_ERROR, "expected { sid }");
				return;
			}
			bridge.revoke(body.sid, "cli-drop", "cli");
			json(res, 200, { ok: true, sid: body.sid });
			return;
		}
		fail(res, 404, GlassboxErrorCode.PROTOCOL_ERROR, "not found");
	}

	const wss = new WebSocketServer({ server, path: "/session" });

	wss.on("connection", (ws: WsSocket) => {
		const sock = ws as AliveSocket;
		sock.isAlive = true;
		sock.on("pong", () => {
			sock.isAlive = true;
		});

		let sid: string | null = null;
		const link: Link = {
			send: (frame) => {
				if (sock.readyState === 1 /* OPEN */) sock.send(frame);
			},
			onMessage: (cb) => {
				sock.on("message", (data) => cb(String(data)));
			},
			close: () => sock.terminate(),
		};

		link.onMessage((frame) => {
			if (sid === null) {
				let msg: GlassboxMessage;
				try {
					msg = decode(frame);
				} catch (e) {
					handshakeFail(ws, e);
					return;
				}
				if (msg.type !== "hello") {
					handshakeFail(ws, new Error("expected hello as the first frame"));
					return;
				}
				try {
					const ack = bridge.hello(msg.sid, msg as HelloMsg);
					bridge.attach(msg.sid, link);
					sid = msg.sid;
					sock.send(encode(ack));
				} catch (e) {
					handshakeFail(ws, e);
				}
				return;
			}

			let msg: GlassboxMessage;
			try {
				msg = decode(frame);
			} catch {
				sock.send(
					encode({
						type: "error",
						code: GlassboxErrorCode.PROTOCOL_ERROR,
						message: "invalid frame",
					}),
				);
				return;
			}
			if (!PAGE_TO_BRIDGE.has(msg.type)) {
				sock.send(
					encode({
						type: "error",
						code: GlassboxErrorCode.PROTOCOL_ERROR,
						message: `unexpected "${msg.type}" from page`,
					}),
				);
				return;
			}
			bridge.deliver(sid, msg as PageToBridgeMsg);
		});

		sock.on("close", () => {
			if (sid !== null) bridge.detach(sid);
		});
	});

	function handshakeFail(ws: WsSocket, e: unknown): void {
		const code = isGlassboxError(e) ? e.code : GlassboxErrorCode.PROTOCOL_ERROR;
		const message = e instanceof Error ? e.message : String(e);
		try {
			ws.send(encode({ type: "error", code, message }));
		} finally {
			ws.terminate();
		}
	}

	const heartbeat = setInterval(() => {
		for (const c of wss.clients) {
			const sock = c as AliveSocket;
			if (sock.isAlive === false) {
				sock.terminate();
				continue;
			}
			sock.isAlive = false;
			sock.ping();
		}
	}, keepaliveMs);
	heartbeat.unref?.();

	return new Promise<Host>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, bindHost, () => {
			const addr = server.address();
			if (addr === null || typeof addr === "string") {
				reject(new Error("no socket address"));
				return;
			}
			bridge.setEndpoint(bindHost, addr.port);
			resolve({
				endpoint: { host: bindHost, port: addr.port, url: `ws://${bindHost}:${addr.port}/session` },
				close: () =>
					new Promise<void>((r) => {
						clearInterval(heartbeat);
						for (const c of wss.clients) (c as WsSocket).terminate();
						server.close(() => r());
					}),
			});
		});
	});
}
