/**
 * MCP client snippets for `npm run setup` (spec §9.6). Pure: takes absolute paths,
 * returns text. It never reads or writes client config files.
 */

/**
 * @param {{ node: string, cli: string }} paths absolute Node binary and dist/cli.js
 * @returns {string}
 */
export function renderSnippets({ node, cli }) {
	const server = { command: node, args: [cli, "bridge"] };
	const json = (value) => JSON.stringify(value, null, "\t");
	return [
		"Paste one snippet into your MCP client config, then restart or toggle the server.",
		"",
		"Zed — ~/.config/zed/settings.json (key is context_servers, not mcp_servers):",
		json({ context_servers: { glassbox: server } }),
		"",
		"Claude Desktop — claude_desktop_config.json:",
		json({ mcpServers: { glassbox: server } }),
		"",
		"Cursor — .cursor/mcp.json (project) or ~/.cursor/mcp.json (user):",
		json({ mcpServers: { glassbox: server } }),
		"",
	].join("\n");
}
