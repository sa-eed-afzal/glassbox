/**
 * `npm run setup` snippets (spec §9.6): each client block is valid JSON with the absolute
 * paths embedded, and Zed uses `context_servers` (an `mcp_servers` key is silently ignored).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no declaration file
import { renderSnippets } from "../scripts/setup-snippets.mjs";

const NODE = "/usr/local/bin/node";
const CLI = "/work/mcp-glassbox/dist/cli.js";

/** The JSON object under each `<label>:` heading, parsed. */
function blocks(text: string): Array<{ label: string; json: unknown }> {
	const out: Array<{ label: string; json: unknown }> = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.endsWith(":") || !/^(Zed|Claude Desktop|Cursor) /.test(line)) continue;
		const body: string[] = [];
		for (let j = i + 1; j < lines.length && lines[j] !== ""; j++) body.push(lines[j]!);
		out.push({ label: line, json: JSON.parse(body.join("\n")) });
	}
	return out;
}

describe("renderSnippets", () => {
	const text = renderSnippets({ node: NODE, cli: CLI });
	const server = { command: NODE, args: [CLI, "bridge"] };

	it("renders one block per client, each valid JSON", () => {
		const found = blocks(text);
		expect(found.map((b) => b.label.split(" —")[0])).toEqual(["Zed", "Claude Desktop", "Cursor"]);
	});

	it("uses the absolute node binary and cli path, not a bare `node`", () => {
		for (const b of blocks(text)) {
			expect(JSON.stringify(b.json)).toContain(JSON.stringify(server));
		}
	});

	it("keys Zed under context_servers and the others under mcpServers", () => {
		const [zed, claude, cursor] = blocks(text).map((b) => b.json as Record<string, unknown>);
		expect(zed).toEqual({ context_servers: { glassbox: server } });
		expect(zed).not.toHaveProperty("mcp_servers");
		expect(claude).toEqual({ mcpServers: { glassbox: server } });
		expect(cursor).toEqual({ mcpServers: { glassbox: server } });
	});
});

const ROOT = fileURLToPath(new URL("../", import.meta.url));

describe("scripts/setup.mjs — failure path (spec §9.6)", () => {
	it("a failing npm step stops the run: exit 1, cause named on stderr, no snippets", () => {
		const dir = mkdtempSync(join(tmpdir(), "gbx-setup-"));
		try {
			// setup.mjs drives npm through npm_execpath — a mock that fails every step
			const mock = join(dir, "npm.js");
			writeFileSync(
				mock,
				`#!/usr/bin/env node\nconsole.error("mock-npm " + process.argv.slice(2).join(" "));\nprocess.exit(1);\n`,
			);
			const r = spawnSync(process.execPath, [join(ROOT, "scripts", "setup.mjs")], {
				cwd: ROOT,
				env: { ...process.env, npm_execpath: mock },
				encoding: "utf8",
				timeout: 60_000,
			});
			expect(r.error).toBeFalsy();
			expect(r.status).toBe(1); // stops at the first failing step
			expect(r.stdout).toContain("setup: [1/3] installing exact dependencies (npm ci)");
			expect(r.stderr).toContain("mock-npm ci"); // the failing step was npm ci
			expect(r.stderr).toContain("setup: npm ci failed (exit 1)"); // cause is named
			expect(r.stdout).not.toContain("setup: OK"); // nothing after the failure
			expect(r.stdout).not.toContain("context_servers"); // no client snippet emitted
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
