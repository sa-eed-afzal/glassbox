# Using Glassbox with OpenWorker

[OpenWorker](https://github.com/andrewyng/openworker) connects to MCP servers
over stdio using the official MCP Python SDK, so Glassbox plugs in as a standard
server — no changes to OpenWorker needed. Every step below was run end-to-end against the OpenWorker app (run from
source, browser UI) on 2026-11-22: the agent minted a connect code, the page paired, and the agent
called `127-0-0-1-3002__get_state` and received the live Sudoku grid
([verification log](#verification-log)).

> **TL;DR** — add one stdio connector, pair the page, then click **Test** on the
> connector so OpenWorker re-reads the tool list (6 → 15 tools). OpenWorker
> lists a server's tools once and ignores `tools/list_changed`, so this step is
> required, and starting a new session does not replace it. Step 4 is the only non-obvious part.

## Friendly prompt (copy-paste into an OpenWorker chat)

The setup has a few human-only steps (OpenWorker's connector UI and the page
widget), so the prompt is phased. It stops and waits for you at each one.

<details>
<summary><b>Copy this prompt</b></summary>

```text
Help me connect Glassbox to OpenWorker and play a Sudoku game through MCP tools.
Show me every command before running it. Do NOT edit my OpenWorker config files
and do NOT take screenshots. Use the general "Coworker" persona, not a specialist
one. If the default model is unavailable, ask me which model to switch to.

PHASE 1 — install and wire the connector
1. Clone https://github.com/sa-eed-afzal/glassbox.git into ~/Projects/glassbox
   (or pull if present), cd there, and run `npm run setup`. Stop if it fails.
2. Print the absolute Node path and the absolute path to dist/cli.js.
3. Show me this JSON and ask me to paste it into
   OpenWorker → Settings → Connectors → + Add custom MCP server → JSON,
   then click Add, Test, and Keep these tools:
   {"glassbox":{"command":"<ABSOLUTE_NODE_PATH>","args":["<ABSOLUTE_DIST_CLI>","bridge"],"enabled":true}}
4. Start the page: `python3 -m http.server 3002 --bind 127.0.0.1 --directory sudoku`
   and tell me to open http://127.0.0.1:3002.
5. Stop. Ask me to confirm the connector says "● Ready", then say "ready".

PHASE 2 — pair the page
6. Call the `glassbox_code` tool with app="sudoku-game" and
   origin="http://127.0.0.1:3002". Give me the code immediately (60 s TTL) and
   ask me to paste it into the widget on the page.
7. When I say connected, call `glassbox_channels` and confirm the channel shows
   1 tab and 9 Sudoku tools.

PHASE 3 — enable the page tools (human step I cannot do for you)
8. Tell me: go back to Settings → Connectors → glassbox → Test. The count must
   go from 6 tools to 15. Print the complete include_tools array (6 glassbox_*
   built-ins + the nine names starting with "127-0-0-1-3002__") for me to paste
   into the glassbox entry in ~/.config/coworker/mcp.json (first-time setup
   only), then ask me to click Test once more and start a new session.
   Wait for me.

PHASE 4 — play
9. Call the tool ending in __get_state and read the grid. Call __new_game with
   {"difficulty":"easy"}, call __get_state again, solve the board, and fill the
   first 12 empty cells with __input_number using {"index":N,"digit":D}.
10. A consent dialog will appear on the page for EVERY write — I will approve
    each one. Report each move and the final state. Stop after 12 moves.

Use 127.0.0.1 (not localhost). Page tools are gated twice (OpenWorker approval
and Glassbox consent); I will handle both.
```

</details>

## 1. Build Glassbox

```sh
git clone https://github.com/sa-eed-afzal/glassbox.git && cd glassbox
npm run setup          # prints the absolute Node + dist/cli.js paths you need
```

## 2. Add the connector in OpenWorker

**Settings → Connectors → + Add custom MCP server → JSON**, paste:

```json
{
  "glassbox": {
    "command": "/absolute/path/to/node",
    "args": ["/absolute/path/to/glassbox/dist/cli.js", "bridge"],
    "enabled": true
  }
}
```

Use the absolute paths printed by `npm run setup` (`which node` and `pwd` also
work). Click **Add**, then **Test**. Expected:

> `glassbox` · `stdio · 6 tools · tested just now` · **● Ready**
> ✓ server responded · 6 tools

Click **Keep these tools**. OpenWorker writes `~/.config/coworker/mcp.json`.

## 3. Pair the page

Start the showcase page:

```sh
python3 -m http.server 3002 --bind 127.0.0.1 --directory sudoku
```

Open `http://127.0.0.1:3002`. In an OpenWorker chat session, ask the agent:

> Call the `glassbox_code` MCP tool with app="sudoku-game" and
> origin="http://127.0.0.1:3002". Return the full code verbatim.

Paste the returned code into the widget within 60 seconds. **Use `127.0.0.1`,
not `localhost`** — origin binding is exact.

## 4. The important part: enable the page tools

OpenWorker pins tools with `include_tools` in `~/.config/coworker/mcp.json`.
The six built-in `glassbox_*` tools are added automatically, but **tools the
server registers later (i.e. all page tools) start unchecked**, and the
connector UI (as of 2026-11) does not surface them for ticking. Two things are
required:

1. **Re-test the connector** after the page is connected. The count should rise
   from `6 tools` to `15 tools` (6 built-ins + 9 Sudoku tools).
2. **Add the page tool names to `include_tools`** in `~/.config/coworker/mcp.json`:

```json
{
  "mcpServers": {
    "glassbox": {
      "command": "...",
      "args": ["...", "bridge"],
      "enabled": true,
      "include_tools": [
        "glassbox_code", "glassbox_channels", "glassbox_status",
        "glassbox_prompt", "glassbox_resource", "glassbox_sample",
        "127-0-0-1-3002__get_state", "127-0-0-1-3002__check",
        "127-0-0-1-3002__new_game", "127-0-0-1-3002__select",
        "127-0-0-1-3002__input_number", "127-0-0-1-3002__erase",
        "127-0-0-1-3002__hint", "127-0-0-1-3002__undo",
        "127-0-0-1-3002__toggle_notes"
      ]
    }
  }
}
```

Reload the connector settings — it should read `Tools 15 of 15 enabled`.

**Why Test, and not just a new session:** OpenWorker keeps one connection per
MCP server for the whole app, shared by every session. It runs `tools/list`
once when that connection opens and ignores
`notifications/tools/list_changed`, so a new session alone still sees the 6
tools the bridge had at startup. **Test** re-runs `tools/list` on the live
connection *without* restarting the bridge, so the page stays paired and the
count becomes 15 (see `verify()` in OpenWorker's `coworker/mcp/client.py`).
Then start a new chat session and use it.

**Do this after every pairing.** If the bridge restarts (for example after an
OpenWorker restart), the list falls back to 6. Pair the page again, then click
**Test** again.

Now ask the agent to call `127-0-0-1-3002__get_state`; it will return the board
as nine strings — no screenshot, no DOM dump.

## 5. Consent: pick one gate

A write tool can be gated twice: OpenWorker's approval flow **and** Glassbox's
page-side consent modal. Choose:

- **Both (defense in depth):** no policy file needed — the built-in default is
  `read=auto, write=consent, dangerous=deny`.
- **OpenWorker only:** put `~/.config/glassbox/glassbox.json` with
  `{"policy":{"sudoku-game":{"write":"auto"}}}`. Use the global path — the
  bridge's cwd is controlled by OpenWorker, so a project-local `glassbox.json`
  may not be found.

## Notes and caveats

- **Interactive only.** Pairing requires a human to paste the code into the
  page, so Glassbox does not work for OpenWorker's unattended/scheduled runs.
- **Coworker persona matters.** Specialist personas expose only their own MCP
  servers. Use the general **Coworker** persona.
- **Model availability.** The default model for a new coworker may be
  unavailable on your account; switch it to one you have access to.
- **Sandbox.** OpenWorker's OpenShell sandbox blocks direct HTTP fetches to
  `127.0.0.1`, but the MCP stdio bridge works normally — the tool call above
  succeeded with `OpenShell · 5 sites` enabled.
- **Tool names follow the page origin.** The `127-0-0-1-3002__` prefix is
  derived from the page's origin (`http://127.0.0.1:3002`), not the bridge's
  port, so `include_tools` survives bridge restarts. Serve the page on another
  host or port and the prefix changes — update `include_tools` to match.
- **Bridge restarts need a fresh pairing.** The bridge listens on an ephemeral
  loopback port; if OpenWorker restarts it, mint a new code, paste it again,
  then click **Test** on the connector so the page tools come back.

## Verification log

Run on 2026-11-22 against the OpenWorker app (run from source, browser UI at
`localhost:5173`), Glassbox at the commit that added this guide.

1. **Connector test:** `stdio · 6 tools · tested just now` → **● Ready**, all
   six built-ins listed.
2. **Pairing:** the agent's `glassbox_code` call returned a 208-char connect
   code; pasting it into the page gave `● connected`, and `glassbox_channels`
   showed 1 tab and 9 tools.
3. **The caveat, reproduced:** in the *same* session, calling a page tool
   failed — the agent reported *"The MCP client hasn't picked up the dynamically
   registered channel tools (no tool-list refresh)."* Glassbox emits
   `notifications/tools/list_changed`, but OpenWorker keeps the tool list from
   when the connection opened.
4. **After the fix** (re-test → 15 tools, `include_tools` updated, new
   session): the agent called `127-0-0-1-3002__get_state` and got
   `["002140000","060800450","700050618","000000005","020415030","400000000","239080001","056001020","000029500"]`.
5. **New session alone is not enough** (re-checked 2026-11-23): with the page
   paired but the connector still at `6 tools`, a brand-new session still lacked
   the page tools (*"The channel is live but the tool isn't in my direct
   list"*). Clicking **Test** raised it to `15 tools` with the page still
   connected, and the next session filled 5 cells correctly through
   `127-0-0-1-3002__input_number`, each approved on the page.
