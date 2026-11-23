/**
 * Result coercion (spec §5.4) — the page NEVER learns MCP framing.
 * Whatever a page tool returns, the bridge produces a valid MCP CallToolResult.
 */
export interface TextContentPart {
	type: "text";
	text: string;
}

export interface CallToolResult {
	content: TextContentPart[];
	structuredContent?: unknown;
	isError?: boolean;
}

const STRUCTURED_SINCE: [number, number, number] = [2025, 6, 18];

function parsePv(p: string): [number, number, number] {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p);
	if (!m) return [0, 0, 0];
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when the negotiated MCP protocolVersion supports `structuredContent`. */
export function supportsStructured(protocolVersion: string): boolean {
	const v = parsePv(protocolVersion);
	const s = STRUCTURED_SINCE;
	return v[0] > s[0] || (v[0] === s[0] && (v[1] > s[1] || (v[1] === s[1] && v[2] >= s[2])));
}

function textPart(t: string): TextContentPart {
	return { type: "text", text: t };
}

export function coerceResult(value: unknown, protocolVersion: string): CallToolResult {
	if (typeof value === "string") return { content: [textPart(value)] };
	if (value === undefined || value === null) return { content: [textPart("null")] };
	let text: string;
	try {
		text = JSON.stringify(value) ?? "null";
	} catch {
		text = String(value); // circular or otherwise unserializable: degrade, never throw
	}
	const base: CallToolResult = { content: [textPart(text)] };
	if (!supportsStructured(protocolVersion)) return base;
	// MCP schema: structuredContent must be a JSON object → wrap array payloads under `value`.
	const structured = Array.isArray(value) ? { value } : value;
	return { ...base, structuredContent: structured };
}

/** Standard error result (spec §5.4 last row). */
export function coerceError(code: string, message: string, traceId?: string): CallToolResult {
	return {
		content: [textPart(message)],
		isError: true,
		structuredContent: { code, message, traceId },
	};
}
