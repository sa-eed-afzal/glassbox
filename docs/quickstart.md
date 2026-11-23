# Quickstart — wire a page to an MCP client in < 5 minutes

A browser page exposes its tools to an MCP client (Zed, Claude Desktop, Cursor)
through the Glassbox bridge: one supervised process, a 60-second one-shot connect
code, and a widget the page pastes the code into. After this, the client's agent
can call the page's tools — and the page can answer the client's sampling
requests — with every call visible in the activity feed and the audit log.

Every command below was run and verified while writing this file (M4, 2026-10-01).

**Prerequisites:** Node ≥ 20 (spec §3; tested on v22.23.1), a browser, and one of
the MCP clients with a config section below.

## 1. Setup — one command

```sh
cd <path-to-mcp-glassbox>
npm run setup
```

This runs `npm ci` (exact pins from the lockfile), `npm run build` (tsup → `dist/`:
node CLI + browser `glassbox.js`), and the preflight in §2. If any step fails it stops
and prints no snippet. On success it prints a ready-to-paste config for Zed, Claude
Desktop, and Cursor, with the absolute Node and `dist/cli.js` paths already filled in.
Skip to §3 for the client config. (Manual equivalent: `npm ci && npm run build`, then §2.)

## 2. Preflight: `glassbox test`

Before wiring a page, prove the build works end-to-end. This spins its own
bridge + the echo-app fixture on loopback ephemeral ports and drives the whole
protocol (connect code → session → tools → sampling → consent → audit → drop):

```sh
node dist/cli.js test
```

Expected: one line per check, all `PASS`, ending in a summary like
`glassbox test: PASS 15/15 checks (embedded · 0.15s · page http://127.0.0.1:35063)`. Exit code 0.

## 3. Start the bridge in your MCP client

The bridge has **no daemon and no fixed port** (spec §4.1): the MCP client spawns
it over stdio, and it dies when the client does. The bridge listens on
`127.0.0.1` + an **ephemeral port** and prints it once to its stderr:

```
glassbox host on 127.0.0.1:39693
```

Add one snippet (`npm run setup` prints these with the absolute paths filled in; by
hand, replace `<path-to-mcp-glassbox>` with the **absolute** path to this checkout),
then (re)start the client or toggle the server so it spawns:

**Zed** — `~/.config/zed/settings.json`:

```json
{
	"context_servers": {
		"glassbox": {
			"command": "<absolute-path-to-node>",
			"args": ["<path-to-mcp-glassbox>/dist/cli.js", "bridge"]
		}
	}
}
```

> Zed gotchas: the key is `context_servers`, **not** `mcp_servers` — an
> `mcp_servers` entry is silently ignored (it just looks like “no MCP servers
> configured”). And Zed spawns servers **without your shell's PATH**, so
> `command` must be the absolute node path (`which node`). Zed hot-reloads the
> file — no restart needed.

**Claude Desktop** — `claude_desktop_config.json`
(`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows):

```json
{
	"mcpServers": {
		"glassbox": {
			"command": "node",
			"args": ["<path-to-mcp-glassbox>/dist/cli.js", "bridge"]
		}
	}
}
```

**Cursor** — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (user):

```json
{
	"mcpServers": {
		"glassbox": {
			"command": "node",
			"args": ["<path-to-mcp-glassbox>/dist/cli.js", "bridge"]
		}
	}
}
```

## 4. Find the bridge port

The bridge prints `glassbox host on 127.0.0.1:<port>` to **stderr**; that
line lands in the client's MCP server log. Where to find it:

- **Zed:** MCP panel → the `glassbox` server → its log/output.
- **Claude Desktop:** the `mcp*.log` files in the Claude log directory
  (`~/Library/Logs/Claude/` on macOS, `%APPDATA%\Claude\logs\` on Windows).
- **Cursor:** the MCP server log in Cursor's settings/logs.

Copy the port. If the client shows no log line, the process may have failed to
spawn (bad path in the snippet, or Node not on the client's `PATH`) — the same
stderr line is visible when you run it yourself: `node dist/cli.js bridge`
(it stays alive while your terminal's stdin is open).

## 5. Serve a page

**Your own page** — add two things:

```html
<script type="module">
	const { Glassbox, renderWidget } = await import("/glassbox.js");
	const gbox = new Glassbox("myapp");
	gbox.tool("status", "Current state", () => ({ score: 420 }));
	gbox.tool("play_move", "Do a thing", { tier: "write", x: { type: "number" } },
		({ x }) => ({ played: x }));
	renderWidget(gbox);
</script>
```

…and make `dist/glassbox.js` reachable from the page as `/glassbox.js` (copy it
into your static root after each build, or alias it in your dev server).

**No page yet — use the echo-app fixture** (tools: `echo`, `add`,
`commit` (write tier, consent-gated) + a sampling handler):

```sh
node scripts/serve-fixture.mjs 8080
# → echo-app fixture on http://127.0.0.1:8080 (bundle: dist/glassbox.js)
```

Open the printed URL. You'll see the widget: a code input + **Connect** button.

## 6. Mint the connect code

```sh
node dist/cli.js code --port <bridge-port> --app <app-id> --origin http://127.0.0.1:<page-port>
```

(echo-app example: `node dist/cli.js code --port 39693 --app echo-app
--origin http://127.0.0.1:8080`)

- **stdout** is the bare code (a base64url blob, ~240 chars) — copy it.
- **stderr** carries an ASCII **QR of the code**: point a phone camera at the
  terminal and the scan result *is* the code (no typing; spec §5.2).
  `--no-qr` suppresses the QR; `--quiet` suppresses the info line.
- The code is **one-shot** with a **60 s TTL** and is **bound to the origin** you
  passed (`--origin` must be the page's origin — the exchange and the WS hello
  both re-check it, spec §5.1/§5.2). Mint again if it expires.

Verify any code without a scanner:

```sh
node dist/cli.js decode <code> [--port <bridge-port>]
# PASS  blob decodes (base64url JSON) … PASS  /health answers on http://127.0.0.1:<port>
# glassbox decode: PASS — code verifies        (exit 0; non-zero on any FAIL)
```

## 7. Connect the page

Paste the code into the widget's input and press **Connect** (within the 60 s
TTL — re-mint if it's gone). The status flips to *connected*, and the widget
renders a live QR of the code with a *simulated scan: OK* self-check (a
structural round-trip of the encoded matrix — the scanner-less verification the
widget does on every keystroke).

The page's tools now appear in your MCP client (`tools/list_changed`); in the
widget's activity feed you'll see the session line and, from here on, every call.

## 8. First tool call

Ask the client's agent to use the page, e.g. with the fixture:
*“call the `echo` tool with the text ‘hello glassbox’”* — and for a write-tier
tool (*“call `commit`”*) the widget's **consent modal** appears first
(approve/deny; deny returns `CONSENT_DENIED` to the client).

Deterministic checks, no agent required:

```sh
node dist/cli.js channels --port <bridge-port>     # live channels, tools, recent calls
node dist/cli.js test --port <bridge-port> --page http://127.0.0.1:<page-port>
# the public conformance suite against YOUR running bridge + page: health, code
# mint, session semantics, origin binding — plus a `page.channel` check that
# fails until your page actually has a live channel. (The in-process checks —
# tool calls, consent, sampling — run in embedded mode: `glassbox test`.)
```

## Tiers & policy (`glassbox.json`)

Tools carry a tier: `read` (default), `write`, `dangerous`. The per-app decision
(`auto` | `consent` | `deny`) comes from policy files (spec §7.3):

- **project** `<cwd>/glassbox.json` (the directory you start the bridge in)
  overrides **global** `~/.config/glassbox/glassbox.json` per appId, per tier.
- Defaults when nothing says otherwise: **read=auto, write=consent,
  dangerous=deny**.
- A policy file is trust configuration: malformed JSON fails the bridge at
  startup (loud, typed) — it is never silently ignored.

```json
{ "policy": { "myapp": { "write": "auto" } } }
```

## Audit

Every tool call is appended to a JSONL audit file (`FileAudit`: 0600 file, 0700
dir, never throws — a broken audit must never crash the bridge, spec §7.5):

- default path: `~/.local/state/glassbox/audit.jsonl`
- `GLASSBOX_AUDIT=/path/to/audit.jsonl` — override the path
- `GLASSBOX_NO_AUDIT=1` — disable file audit
- `GLASSBOX_AUDIT_ARGS=1` — log full args (by default only `argsHash`, the first
  16 hex chars of sha256 of the canonicalized args)

Each line has `traceId`, `client` (stdio/cli/page), `tool`, `tier`, `consent`
(auto|approved|denied) and, after a call, the result/latency.

## Codes, reconnect, origin binding (don't duplicate — spec §5.2)

The connect code is the *only discovery path*: the self-describing base64url
blob `{ v, host, port, channel, app, codeId, expMs }` carries the endpoint
because the bridge has no fixed address. Codes are one-shot (a rejected
exchange consumes them too), 60 s TTL. The session itself persists in the page's
`sessionStorage`, so **a page reload reconnects automatically without
re-pasting**; if the bridge dies the widget backs off 250 ms → 4 s with a
*Reconnect* button. Origin binding (host:port) is enforced at both hops — the
`/session` exchange and the WS `hello`. Full model: spec §5.1–§5.2.

## QR connect & verification (spec §12 #5, closed M4)

The code renders as a QR verbatim from an in-bundle ISO/IEC 18004 encoder
(byte mode, auto version, all EC levels, full mask evaluation — **no runtime
deps**; cross-validated bit-for-bit in tests against a dev-only second
implementation). Where:

- **CLI:** `glassbox code` prints an ASCII QR on stderr — a phone camera scan
  yields the code text (scannable at normal terminal size).
- **Widget:** a live SVG QR next to the input, re-encoded on every keystroke.

Verification paths (no scanner in the loop): `glassbox decode <code>`
(blob structure field-by-field + `/health` on the code's endpoint) and the
widget's *simulated scan* (the encoded matrix is read back structurally —
format-info BCH, Reed–Solomon block integrity, byte-mode payload recovery —
and must round-trip to the typed code).

## CLI reference

```
glassbox bridge                     run the bridge (MCP stdio ⇄ WS host) — one process
glassbox code   --port N [--app X] [--origin O] [--no-qr]
                                    mint a one-shot connect code (60s); code on stdout, QR on stderr
glassbox channels --port N          list live channels, tools, recent calls
glassbox drop   <sid> --port N      revoke a session server-side (immediate RST)
glassbox status --port N            bridge health / protocol / server version
glassbox test   [--port N] [--page URL] [--app X] [--origin O] [--hold]
                                    public conformance suite (embedded, or against a running bridge;
                                    --page verifies your page has a live channel; --hold keeps the
                                    embedded fixture alive for watching)
glassbox decode <code> [--port N]   scanner-less verification of a connect code (QR payload)
```

Env: `GLASSBOX_PORT` (default port for the management commands), `GLASSBOX_AUDIT`,
`GLASSBOX_NO_AUDIT`, `GLASSBOX_AUDIT_ARGS` (above).

## Troubleshooting

- **Management commands need `--port <n>`** — the bridge port is ephemeral;
  read it from the client's MCP log (step 4).
- **Code rejected on paste** — expired (60 s), already used (one-shot), or minted
  for a different origin/app. Re-mint with the page's exact origin.
- **`origin mismatch` / `connect code is bound to origin …`** — the page's
  origin differs from `--origin`. Binding is an exact `host:port` match
  (lowercased; scheme, path and query ignored), so `localhost:8080` and
  `127.0.0.1:8080` are **different** origins — mint with the exact origin of
  the URL you open the page at.
- **Widget says *reconnecting*** — the bridge process died (the MCP client
  closed); restart the client's server and press *Reconnect*.
- **No tools in the client** — the client talks to *its own* bridge spawn; make
  sure you minted the code against the client's bridge port (step 4), not a
  bridge you started by hand.
- **Credential warning on stderr** — `glassbox bridge` stores its Ed25519
  credential in the OS keychain, falling back to a 0600 file with a one-line
  warning (spec §7.2). Expected on machines without `secret-tool`.
