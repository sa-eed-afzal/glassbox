#!/usr/bin/env node
/**
 * One-command setup (spec §9.6): npm ci → build → `glassbox test` preflight → client
 * snippets. Stops at the first failing step and exits non-zero. Never edits client configs.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderSnippets } from "./setup-snippets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const MIN_NODE = 20;

function die(message) {
	console.error(`setup: ${message}`);
	process.exit(1);
}

/** Run npm via the npm that launched us (`npm run setup` sets npm_execpath). */
function npm(args, label) {
	const execPath = process.env.npm_execpath;
	const r = execPath
		? spawnSync(process.execPath, [execPath, ...args], { cwd: root, stdio: "inherit" })
		: spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
				cwd: root,
				stdio: "inherit",
			});
	if (r.status !== 0) die(`${label} failed (exit ${r.status ?? "signal"})`);
}

const major = Number(process.versions.node.split(".")[0]);
if (major < MIN_NODE) die(`Node ${MIN_NODE}+ required, found ${process.versions.node}`);

console.log(`setup: [1/3] installing exact dependencies (npm ci)`);
npm(["ci"], "npm ci");

console.log(`setup: [2/3] building dist/`);
npm(["run", "build"], "npm run build");
if (!existsSync(cli)) die(`build did not produce ${cli}`);

console.log(`setup: [3/3] preflight (glassbox test)`);
const preflight = spawnSync(process.execPath, [cli, "test"], { cwd: root, stdio: "inherit" });
if (preflight.status !== 0) die("preflight failed; no client snippet printed");

console.log("");
console.log("setup: OK — paste a snippet below into your MCP client");
console.log("");
console.log(renderSnippets({ node: process.execPath, cli }));
