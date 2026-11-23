#!/usr/bin/env node
/**
 * glassbox CLI (spec §4.1).
 *
 *   glassbox bridge                     run the bridge (MCP stdio ⇄ WS host), one process
 *   glassbox code   --port N [--app X]  mint a one-shot connect code against a running bridge
 *   glassbox channels --port N          list live channels + recent calls
 *   glassbox status --port N            bridge health/version
 *   glassbox decode <code> [--port N]   verify a connect code (QR payload) without a scanner
 *
 * No daemons, no PID files: `glassbox bridge` is the only long-lived process and lives
 * and dies with the MCP client that spawned it.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileAudit } from "./bridge/audit.js";
import { Bridge } from "./bridge/bridge.js";
import {
	type ConformanceCheck,
	type ConformanceOptions,
	type ConformanceReport,
	runConformance,
} from "./bridge/conformance.js";
import { signedFetch } from "./bridge/http.js";
import { loadPolicy } from "./bridge/policy.js";
import { defaultCredsFile, loadOrCreate } from "./core/credentials.js";
import { NonceAuth } from "./core/nonce.js";
import { encodeQr, qrToAscii } from "./core/qr.js";
import { runSelfCheck } from "./core/selfcheck.js";
import { PROTOCOL_VERSION, SERVER_PRODUCT } from "./core/version.js";
import { createHost } from "./host/host.js";
import { createMcpServer } from "./mcp/server.js";

function readVersion(): string {
	try {
		const url = new URL("../package.json", import.meta.url);
		const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/** The mcp-glassbox package root (for the dependency self-check), resolved from this file. */
function packageDir(): string {
	return fileURLToPath(new URL("../", import.meta.url));
}

function defaultAuditPath(): string {
	const state = process.env.XDG_STATE_DIR ?? `${process.env.HOME ?? "."}/.local/state`;
	return `${state}/glassbox/audit.jsonl`;
}

interface ParsedArgs {
	cmd: string;
	opts: Record<string, string>;
	pos: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
	const cmd = argv[0] ?? "";
	const opts: Record<string, string> = {};
	const pos: string[] = [];
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i]!;
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				opts[key] = next;
				i++;
			} else {
				opts[key] = "true";
			}
		} else {
			pos.push(a);
		}
	}
	return { cmd, opts, pos };
}

function endpointFrom(opts: Record<string, string>): string {
	const host = opts.host ?? "127.0.0.1";
	const port = Number(opts.port ?? process.env.GLASSBOX_PORT ?? "");
	if (!Number.isInteger(port) || port <= 0) {
		throw new Error("pass --port <n> (copy it from the bridge's `glassbox host on …` stderr line)");
	}
	return `http://${host}:${port}`;
}

async function runBridge(): Promise<void> {
	const version = readVersion();
	const auditPath =
		process.env.GLASSBOX_AUDIT ?? (process.env.GLASSBOX_NO_AUDIT ? "" : defaultAuditPath());
	const credsFile = defaultCredsFile();

	// Credential (spec §7.2): OS keychain, else a 0600 file (+ one-line warning).
	const cred = loadOrCreate({ credsFile });

	// Self-check BEFORE serving (spec §7.4, §9.4): dependency drift, credential file
	// mode, audit modes. A world-readable credential or a drifted tree stops startup.
	const selfOpts: Parameters<typeof runSelfCheck>[0] = {
		projectDir: packageDir(),
		credsFile,
	};
	if (auditPath) selfOpts.auditFile = auditPath;
	const self = runSelfCheck(selfOpts);
	for (const line of self.lines) process.stderr.write(`glassbox selfcheck: ${line}\n`);
	if (!self.ok) {
		for (const p of self.problems) process.stderr.write(`glassbox selfcheck FAIL: ${p.message}\n`);
		process.stderr.write("glassbox: self-check failed — refusing to start.\n");
		process.exit(1);
	}

	// Policy (spec §7.3): project glassbox.json overrides the global one.
	const policy = loadPolicy({ projectDir: process.cwd() });
	// Nonce enforcement for the management endpoints (spec §7.2): the credential's
	// public key is the single authorized principal.
	const auth = new NonceAuth({ principals: [cred.publicKeyB64] });

	const bridge = new Bridge({
		serverVersion: version,
		policy,
		auth,
		...(auditPath ? { audit: new FileAudit(auditPath) } : {}),
	});
	const host = await createHost(bridge);
	const mcp = createMcpServer(bridge);
	await mcp.connect();

	process.stderr.write(`glassbox host on ${host.endpoint.host}:${host.endpoint.port}\n`);
	process.stderr.write(`glassbox protocol ${PROTOCOL_VERSION} · ${SERVER_PRODUCT}/${version}\n`);

	let shuttingDown = false;
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		void (async () => {
			try {
				await mcp.close();
			} catch {
				// best effort
			}
			bridge.close();
			await host.close();
			process.exit(0);
		})();
	};

	// one supervised process: client dies (stdio closes) → bridge dies (spec §4.1)
	process.stdin.on("end", shutdown);
	process.stdin.on("close", shutdown);
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// keep the event loop alive (the stdio transport + WS server hold it)
	await new Promise<void>(() => {});
}

async function runCode(opts: Record<string, string>): Promise<void> {
	const base = endpointFrom(opts);
	const body: Record<string, unknown> = {};
	if (opts.app) body.app = opts.app;
	if (opts.origin) body.origin = opts.origin;
	const res = await signedFetch(base, "/code", "POST", Object.keys(body).length > 0 ? body : {});
	const json = (await res.json()) as Record<string, unknown>;
	if (!res.ok) throw new Error(`mint failed (${res.status}): ${JSON.stringify(json)}`);
	const code = String(json.code);
	console.log(code);
	if (opts.quiet !== "true") {
		const port = opts.port ?? process.env.GLASSBOX_PORT ?? "";
		console.error(
			`glassbox: ws://127.0.0.1:${port}/session · app ${String(json.app)} · ttl ${String(json.expiresMs)}ms`,
		);
	}
	if (opts["no-qr"] !== "true") {
		// the QR encodes the code verbatim (spec §5.2, §12 #5); it goes to stderr so
		// stdout stays the bare code for scripting
		process.stderr.write(`\nglassbox: scan with a phone camera (QR of the code above)\n`);
		process.stderr.write(`${qrToAscii(encodeQr(code))}\n`);
	}
}

async function runChannels(opts: Record<string, string>): Promise<void> {
	const base = endpointFrom(opts);
	const res = await signedFetch(base, "/channels", "GET");
	const json: unknown = await res.json();
	if (!res.ok) throw new Error(`channels failed (${res.status})`);
	console.log(JSON.stringify(json, null, 2));
}

async function runDrop(opts: Record<string, string>, sid: string): Promise<void> {
	if (!sid) throw new Error("pass a session id: glassbox drop <sid> --port N");
	const base = endpointFrom(opts);
	const res = await signedFetch(base, "/drop", "POST", { sid });
	const json = (await res.json()) as Record<string, unknown>;
	if (!res.ok) throw new Error(`drop failed (${res.status}): ${JSON.stringify(json)}`);
	console.log(`dropped session ${sid}`);
}

async function runStatus(opts: Record<string, string>): Promise<void> {
	const base = endpointFrom(opts);
	const res = await fetch(`${base}/health`);
	const json: unknown = await res.json();
	if (!res.ok) throw new Error(`status failed (${res.status})`);
	console.log(JSON.stringify(json, null, 2));
}

async function runTest(opts: Record<string, string>): Promise<number> {
	if (opts.page !== undefined && opts.port === undefined) {
		throw new Error("glassbox test: --page <url> needs --port N (a running bridge)");
	}
	let port: number | undefined;
	if (opts.port !== undefined) {
		port = Number(opts.port);
		if (!Number.isInteger(port) || port <= 0)
			throw new Error("glassbox test: --port N must be a positive integer");
	}
	const conformance: ConformanceOptions = {
		...(port !== undefined ? { port } : {}),
		...(!opts.page ? {} : { pageUrl: opts.page }),
		...(!opts.app ? {} : { app: opts.app }),
		...(!opts.origin ? {} : { origin: opts.origin }),
		hold: opts.hold === "true",
	};
	const report = await runConformance(conformance);
	for (const c of report.checks) console.log(checkLine(c));
	console.log(report.summary);
	if (report.ok && report.hold) await holdFixture(report);
	return report.ok ? 0 : 1;
}

function checkLine(c: ConformanceCheck): string {
	const mark = c.ok === false ? "FAIL" : c.skipped === true ? "SKIP" : "PASS";
	const detail = c.ok === false || c.skipped === true ? c.detail : undefined;
	return `${mark}  ${c.name}${detail === undefined ? "" : ` — ${detail}`}`;
}

/** `--hold`: keep the embedded fixture alive so a human can watch the widget (M4 quick-start). */
async function holdFixture(report: ConformanceReport): Promise<void> {
	const { bridge, page } = report.opens;
	console.error(
		`glassbox test: fixture kept alive (--hold) · bridge ws://127.0.0.1:${bridge}/session` +
			` · page ${report.pageUrl ?? "(static server offline — run npm run build)"}\n` +
			`	mint a code: glassbox code --port ${bridge} --origin ${page !== undefined ? `http://127.0.0.1:${page}` : "…"} --app ${report.app ?? "app"}\n` +
			`	paste it into the widget, then Ctrl-C here to stop the fixture.`,
	);
	await new Promise<void>(() => {});
}

/**
 * Scanner-less verification path (spec §5.2, §12 #5): verify a connect-code blob —
 * the QR payload verbatim, or the string as printed. Checks the blob structure
 * field-by-field and, against a running bridge, that the code's own endpoint
 * (or --port) answers /health. Expiry is not checkable from the blob alone
 * (expMs is a TTL; the mint timestamp lives on the bridge).
 */
async function runDecode(opts: Record<string, string>, code: string): Promise<number> {
	if (!code) throw new Error("pass the connect code: glassbox decode <code> [--port N]");
	const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
	const check = (name: string, ok: boolean, detail?: string): void => {
		results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
	};

	const p = (() => {
		try {
			return JSON.parse(Buffer.from(code.trim(), "base64url").toString("utf8")) as Record<
				string,
				unknown
			>;
		} catch (e) {
			check("blob decodes (base64url JSON)", false, e instanceof Error ? e.message : String(e));
			console.log(
				`glassbox decode: FAIL — ${code.trim().slice(0, 12)}… is not a connect-code blob`,
			);
			for (const r of results) console.log(checkLine2(r));
			return null;
		}
	})();
	if (p === null) return 1;
	check("blob decodes (base64url JSON)", true);
	check("v", p.v === "gbx/v1", p.v === undefined ? "missing" : String(p.v));
	const hostOk = typeof p.host === "string" && p.host.length > 0;
	check("host", hostOk, hostOk ? String(p.host) : "missing/invalid");
	const portOk =
		typeof p.port === "number" && Number.isInteger(p.port) && p.port > 0 && p.port <= 65535;
	check("port", portOk, portOk ? String(p.port) : "missing/invalid");
	check(
		"channel",
		typeof p.channel === "string" && p.channel.length > 0,
		typeof p.channel === "string" ? p.channel : "missing/invalid",
	);
	check(
		"app",
		typeof p.app === "string" && p.app.length > 0,
		typeof p.app === "string" ? p.app : "missing/invalid",
	);
	check("codeId", typeof p.codeId === "string" && p.codeId.length > 0);
	check(
		"expMs (TTL)",
		typeof p.expMs === "number" && p.expMs > 0,
		typeof p.expMs === "number" ? `${p.expMs} ms` : "missing/invalid",
	);

	const wantPort = opts.port !== undefined ? Number(opts.port) : undefined;
	if (wantPort !== undefined && (!Number.isInteger(wantPort) || wantPort <= 0))
		throw new Error("glassbox decode: --port N must be a positive integer");
	const port = portOk ? p.port : (wantPort ?? null);
	if (hostOk && port !== null) {
		const endpoint = `http://${p.host}:${port}`;
		try {
			const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2000) });
			check(`/health answers on ${endpoint}`, res.ok, `HTTP ${res.status}`);
		} catch (e) {
			check(`/health answers on ${endpoint}`, false, e instanceof Error ? e.message : String(e));
		}
	} else {
		check("/health answers", false, "no usable host/port — pass --port N if the blob's is missing");
	}

	let allOk = true;
	for (const r of results) {
		if (!r.ok) allOk = false;
		console.log(checkLine2(r));
	}
	console.log(allOk ? "glassbox decode: PASS — code verifies" : "glassbox decode: FAIL");
	return allOk ? 0 : 1;
}

function checkLine2(r: { name: string; ok: boolean; detail?: string }): string {
	return `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail === undefined ? "" : ` — ${r.detail}`}`;
}

const HELP = `glassbox — a transparent, trustworthy bridge between MCP clients and web pages

Usage:
  glassbox bridge                       run the bridge (MCP stdio ⇄ WS host) — one process
  glassbox code   --port N [--app X] [--origin O] [--no-qr]
                                        mint a one-shot connect code (60s) against a running
                                        bridge; the code is printed bare on stdout, its QR (a
                                        phone can scan the terminal, spec §5.2) on stderr
  glassbox channels --port N            list live channels, tools, and recent calls
  glassbox drop   <sid> --port N        revoke a session server-side (immediate RST)
  glassbox status --port N              bridge health / protocol / server version
  glassbox test   [--port N] [--page URL] [--app X] [--origin O] [--hold]
                                        run the public conformance suite: spins its own bridge +
                                        fixture page, or --port N against a running bridge;
                                        --page verifies the live channel of the page at URL
  glassbox decode <code> [--port N]     verify a connect code (the QR payload, spec §5.2):
                                        blob structure field-by-field + /health on the code's
                                        endpoint (or --port) — the scanner-less verification path

Env:
  GLASSBOX_PORT          default port for code/channels/drop/status
  GLASSBOX_AUDIT         audit JSONL path (default: ~/.local/state/glassbox/audit.jsonl)
  GLASSBOX_NO_AUDIT      disable file audit
  GLASSBOX_AUDIT_ARGS    =1 to log full args (not just argsHash) in the audit stream
`;

export async function main(argv: string[]): Promise<number> {
	const { cmd, opts, pos } = parseArgs(argv);
	try {
		switch (cmd) {
			case "bridge":
				await runBridge();
				return 0;
			case "code":
				await runCode(opts);
				return 0;
			case "channels":
				await runChannels(opts);
				return 0;
			case "drop":
				await runDrop(opts, pos[0] ?? "");
				return 0;
			case "status":
				await runStatus(opts);
				return 0;
			case "test":
				return await runTest(opts);
			case "decode":
				return await runDecode(opts, pos[0] ?? "");
			case "help":
			case "--help":
			case "-h":
				console.log(HELP);
				return 0;
			case "":
				console.log(HELP);
				return 1;
			default:
				console.error(`glassbox: unknown command "${cmd}"`);
				console.log(HELP);
				return 1;
		}
	} catch (e) {
		console.error(`glassbox: ${e instanceof Error ? e.message : String(e)}`);
		return 2;
	}
}

const isMain = (() => {
	const argv1 = process.argv[1];
	if (!argv1) return false;
	try {
		return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
	} catch {
		return false;
	}
})();

if (isMain) {
	void main(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((e: unknown) => {
			console.error(`glassbox: ${e instanceof Error ? e.message : String(e)}`);
			process.exitCode = 2;
		});
}
