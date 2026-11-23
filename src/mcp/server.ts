import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult as McpCallToolResult,
	ReadResourceRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Bridge } from "../bridge/bridge.js";
import type { PromptResultMsg, ResourceResultMsg, SamplingResultMsg } from "../core/codec.js";
import { type CallToolResult, coerceError, coerceResult } from "../core/coerce.js";
import { PROTOCOL_VERSION, SERVER_PRODUCT } from "../core/version.js";

const PV = "2025-06-18";
const CHANNELS_URI = "glassbox://channels";

/** A wire result coming back from a page: either the typed payload or a typed error. */
type WireError = { type: "error"; code: string; message: string };
type WireResult = PromptResultMsg | ResourceResultMsg | SamplingResultMsg | WireError;

export interface McpHandle {
	server: Server;
	connect(): Promise<void>;
	close(): Promise<void>;
}

/** Normalize a page JSON Schema into the MCP `Tool.inputSchema` shape (`type: "object"`). */
function toMcpSchema(inputSchema?: unknown): {
	type: "object";
	properties?: Record<string, object>;
	required?: string[];
} {
	if (inputSchema && typeof inputSchema === "object") {
		const s = inputSchema as Record<string, unknown>;
		const out: { type: "object"; properties?: Record<string, object>; required?: string[] } = {
			type: "object",
		};
		if (s.properties && typeof s.properties === "object")
			out.properties = s.properties as Record<string, object>;
		if (Array.isArray(s.required)) out.required = s.required as string[];
		return out;
	}
	return { type: "object", properties: {} };
}

function builtinTools(): Tool[] {
	return [
		{
			name: "glassbox_code",
			description: "Mint a 60s one-shot connect code for a page to paste into the Glassbox widget.",
			inputSchema: {
				type: "object",
				properties: {
					app: { type: "string", description: "App id / channel label." },
					origin: { type: "string", description: "Page origin, e.g. http://localhost:8123." },
				},
			},
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		},
		{
			name: "glassbox_channels",
			description: "List live Glassbox channels, their tools, and recent calls.",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		},
		{
			name: "glassbox_status",
			description: "Bridge health, protocol version, and server version.",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		},
		{
			name: "glassbox_prompt",
			description: "Ask a connected page to produce a named prompt (parity).",
			inputSchema: {
				type: "object",
				properties: {
					channel: { type: "string" },
					name: { type: "string" },
					args: { type: "object" },
				},
				required: ["channel", "name"],
			},
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		},
		{
			name: "glassbox_resource",
			description: "Read a named resource from a connected page (parity).",
			inputSchema: {
				type: "object",
				properties: { channel: { type: "string" }, uri: { type: "string" } },
				required: ["channel", "uri"],
			},
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		},
		{
			name: "glassbox_sample",
			description: "Ask a connected page to produce a message via sampling (parity).",
			inputSchema: {
				type: "object",
				properties: {
					channel: { type: "string" },
					messages: { type: "array" },
					systemPrompt: { type: "string" },
					maxTokens: { type: "number" },
					schema: { type: "object" },
				},
				required: ["channel", "messages", "maxTokens"],
			},
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		},
	];
}

function listTools(bridge: Bridge): Tool[] {
	const out = builtinTools();
	for (const t of bridge.listTools()) {
		out.push({
			name: t.bridgeName,
			description: t.description,
			inputSchema: toMcpSchema(t.inputSchema),
			annotations: {
				readOnlyHint: t.tier === "read",
				destructiveHint: t.tier !== "read",
				openWorldHint: false,
			},
		});
	}
	return out;
}

function wireResult(msg: WireResult): CallToolResult {
	if (msg.type === "error") return coerceError(msg.code, msg.message);
	if (msg.type === "prompt.result")
		return coerceResult({ messages: (msg as PromptResultMsg).messages }, PV);
	if (msg.type === "resource.result")
		return coerceResult({ contents: (msg as ResourceResultMsg).contents }, PV);
	return coerceResult((msg as SamplingResultMsg).value, PV);
}

async function callTool(
	bridge: Bridge,
	name: string,
	args: Record<string, unknown>,
): Promise<McpCallToolResult> {
	const result: CallToolResult = await dispatch(bridge, name, args);
	return result as unknown as McpCallToolResult;
}

async function dispatch(
	bridge: Bridge,
	name: string,
	args: Record<string, unknown>,
): Promise<CallToolResult> {
	switch (name) {
		case "glassbox_code": {
			const opts: { app?: string; origin?: string } = {};
			if (typeof args.app === "string") opts.app = args.app;
			if (typeof args.origin === "string") opts.origin = args.origin;
			const code = bridge.mintCode(Object.keys(opts).length > 0 ? opts : undefined);
			return coerceResult({ ...code, endpoint: `ws://${code.host}:${code.port}/session` }, PV);
		}
		case "glassbox_channels":
			return coerceResult(bridge.listChannels(), PV);
		case "glassbox_status":
			return coerceResult(
				{ ok: true, v: PROTOCOL_VERSION, server: `${SERVER_PRODUCT}/${bridge.serverVersion}` },
				PV,
			);
		case "glassbox_prompt":
			return wireResult(
				await bridge.requestPrompt(
					String(args.channel),
					String(args.name),
					(args.args ?? {}) as Record<string, unknown>,
				),
			);
		case "glassbox_resource":
			return wireResult(await bridge.requestResource(String(args.channel), String(args.uri)));
		case "glassbox_sample":
			return wireResult(
				await bridge.requestSampling(String(args.channel), {
					messages: (args.messages ?? []) as unknown[],
					...(typeof args.systemPrompt === "string" ? { systemPrompt: args.systemPrompt } : {}),
					maxTokens: Number(args.maxTokens ?? 256),
					...(args.schema !== undefined ? { schema: args.schema } : {}),
				}),
			);
		default:
			return bridge.callTool(name, args);
	}
}

export function createMcpServer(bridge: Bridge): McpHandle {
	const server = new Server(
		{ name: "glassbox", version: bridge.serverVersion },
		{
			capabilities: {
				tools: { listChanged: true },
				prompts: { listChanged: false },
				resources: { listChanged: false },
			},
		},
	);

	bridge.onToolsChanged = () => {
		void server.sendToolListChanged().catch(() => {});
	};

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools(bridge) }));

	server.setRequestHandler(CallToolRequestSchema, async (req) =>
		callTool(bridge, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
	);

	server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

	server.setRequestHandler(GetPromptRequestSchema, async (req) => {
		throw new Error(
			`no prompt "${req.params.name}" registered (use the glassbox_prompt tool for on-demand prompts)`,
		);
	});

	server.setRequestHandler(ListResourcesRequestSchema, async () => ({
		resources: [
			{
				uri: CHANNELS_URI,
				name: "channels",
				description: "Bridge-name → channel → app-tool table.",
			},
		],
	}));

	server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
		if (req.params.uri === CHANNELS_URI) {
			return {
				contents: [
					{
						uri: CHANNELS_URI,
						mimeType: "application/json",
						text: JSON.stringify(bridge.listChannels(), null, 2),
					},
				],
			};
		}
		throw new Error(`unknown resource: ${req.params.uri}`);
	});

	return {
		server,
		connect: async () => {
			await server.connect(new StdioServerTransport());
		},
		close: async () => {
			await server.close();
		},
	};
}
