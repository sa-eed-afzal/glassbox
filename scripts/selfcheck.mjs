#!/usr/bin/env node
/**
 * Lesson D1, codified (spec §7.4): fail LOUD when the resolved dependency
 * tree drifts from the pins in package.json — that exact drift (zod 4.6.5
 * hoisted under the MCP SDK) crashed our first WebMCP integration.
 */
import { readFileSync } from "node:fs";

const here = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(here, "utf8"));
const expected = { ...pkg.dependencies, ...pkg.devDependencies };

// Fake-core-module dependency guard (lesson D10)
const CORE = new Set([
	"assert",
	"buffer",
	"child_process",
	"cluster",
	"crypto",
	"events",
	"fs",
	"http",
	"https",
	"net",
	"os",
	"path",
	"process",
	"querystring",
	"stream",
	"string_decoder",
	"timers",
	"tty",
	"url",
	"util",
	"zlib",
]);

let fail = 0;
for (const [name, pinned] of Object.entries(expected)) {
	if (CORE.has(name)) {
		console.log(`FAIL  ${name.padEnd(28)} dependency on a Node core module (fake-package smell)`);
		fail = 1;
		continue;
	}
	let resolved = "NOT_INSTALLED";
	try {
		resolved = JSON.parse(
			readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8"),
		).version;
	} catch {}
	const ok = resolved === pinned;
	if (!ok) fail = 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(28)} pinned ${pinned}  resolved ${resolved}`);
}

if (fail) {
	console.error("\nselfcheck FAILED: resolved tree drifted from package.json pins.");
	console.error("Fix with: npm ci   (or npm i -E <pkg>@<pinned-version>)");
} else {
	console.log("\nselfcheck passed: resolved tree matches pins.");
}
process.exit(fail);
