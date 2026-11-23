import { createHash } from "node:crypto";
import { GlassboxError, GlassboxErrorCode } from "./errors.js";

/**
 * Canonical tool naming (spec §5.3). One separator, always:  <channel>__<tool>
 *  - channel: sanitized origin host, [a-z0-9-], max CHANNEL_MAX
 *  - tool:    sanitized app tool name, [a-z0-9_-], max TOOL_MAX
 *  - total:   never more than NAME_MAX (MCP limit), enforced by hash-truncation
 */
export const NAME_SEP = "__";
export const CHANNEL_MAX = 32;
export const TOOL_MAX = 28;
export const NAME_MAX = 64;
export const BRIDGE_NAME_RE = /^[a-z0-9-]+__[a-z0-9_-]+$/;

function hash6(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 6);
}

/** Shorten to `max` by replacing the tail with a stable `__<hash6>` of the ORIGINAL value. */
function truncate(value: string, max: number, seed: string): string {
	if (value.length <= max) return value;
	const keep = max - (NAME_SEP.length + 6);
	if (keep < 1) throw new RangeError(`max=${max} too small for hash-truncation`);
	return value.slice(0, keep) + NAME_SEP + hash6(seed);
}

/**
 * Origin key for binding checks (spec §5.2): scheme/query/path stripped,
 * lowercased — 'http://Localhost:8123/x' and 'localhost:8123' are the same page.
 */
export function hostKeyOf(origin: string): string {
	if (typeof origin !== "string")
		throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "origin must be a string");
	return (origin.includes("://") ? origin.split("://", 2)[1]! : origin)
		.split("?")[0]!
		.split("/")[0]!
		.toLowerCase();
}

/** 'http://localhost:8123' or 'localhost:8123' → 'localhost-8123' (≤ CHANNEL_MAX). */
export function channelFrom(origin: string): string {
	if (typeof origin !== "string")
		throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "origin must be a string");
	const host = hostKeyOf(origin);
	const base = host
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (base === "") return "channel";
	return truncate(base, CHANNEL_MAX, host);
}

/** 'Play Move (now!)' → 'play-move-now' (≤ TOOL_MAX). */
export function toolName(appTool: string): string {
	if (typeof appTool !== "string" || appTool === "") {
		throw new GlassboxError(
			GlassboxErrorCode.PROTOCOL_ERROR,
			"tool name must be a non-empty string",
		);
	}
	const base = appTool
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (base === "") return "tool";
	return truncate(base, TOOL_MAX, appTool);
}

/** 'http://localhost:8123' + 'play_move' → 'localhost-8123__play_move' (≤ NAME_MAX, always). */
export function bridgeToolName(origin: string, appTool: string): string {
	const channel = channelFrom(origin);
	let tool = toolName(appTool);
	if (channel.length + NAME_SEP.length + tool.length > NAME_MAX) {
		const room = Math.max(8, NAME_MAX - channel.length - NAME_SEP.length);
		tool = truncate(tool, room, channel + appTool);
	}
	return channel + NAME_SEP + tool;
}

export interface ParsedBridgeName {
	channel: string;
	tool: string;
}

/** Inverse of bridgeToolName(). The channel alphabet has no '_' so the first '__' is unambiguous. */
export function parseBridgeToolName(name: string): ParsedBridgeName {
	const i = name.indexOf(NAME_SEP);
	if (i <= 0 || i + NAME_SEP.length >= name.length) {
		throw new GlassboxError(
			GlassboxErrorCode.PROTOCOL_ERROR,
			`not a glassbox tool name: "${name}"`,
		);
	}
	return { channel: name.slice(0, i), tool: name.slice(i + NAME_SEP.length) };
}

export function isBridgeToolName(name: string): boolean {
	return BRIDGE_NAME_RE.test(name) && name.length <= NAME_MAX;
}
