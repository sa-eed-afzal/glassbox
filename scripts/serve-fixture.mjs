#!/usr/bin/env node
/**
 * Serve the echo-app fixture + the current `dist/glassbox.js` on one loopback
 * port — the quickstart's "no page of your own yet" path (docs/quickstart.md).
 * Zero deps; always serves the freshly built bundle (no copy to go stale).
 *
 *   npm run build
 *   node scripts/serve-fixture.mjs [port]     # default 8080
 *
 * Then:  mint a code with `glassbox code --port <bridge-port>
 *        --origin http://127.0.0.1:<this-port> --app echo-app` and paste it
 *        into the widget on http://127.0.0.1:<this-port>.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] ?? 8080);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
	console.error("usage: node scripts/serve-fixture.mjs [port]");
	process.exit(1);
}
const root = join(fileURLToPath(new URL("../", import.meta.url)));

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
	const send = (code, type, body) => {
		res.writeHead(code, { "content-type": type });
		res.end(body);
	};
	if (url.pathname === "/glassbox.js") {
		try {
			return send(
				200,
				"text/javascript; charset=utf-8",
				readFileSync(join(root, "dist/glassbox.js")),
			);
		} catch {
			return send(404, "text/plain", "dist/glassbox.js missing — run `npm run build` first");
		}
	}
	if (url.pathname === "/" || url.pathname === "/index.html") {
		return send(
			200,
			"text/html; charset=utf-8",
			readFileSync(join(root, "fixtures/echo-app/index.html")),
		);
	}
	send(404, "text/plain", "not found — the fixture serves / and /glassbox.js");
});
server.listen(port, "127.0.0.1", () => {
	console.log(`echo-app fixture on http://127.0.0.1:${port} (bundle: dist/glassbox.js)`);
});
