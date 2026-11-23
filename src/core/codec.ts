/**
 * Wire codec (spec §5.8). JSON text frames over the session channel.
 * decode() is the ONLY gate between untrusted frames and bridge state:
 * every message type is validated field-by-field, with typed errors.
 */
import { GlassboxError, GlassboxErrorCode } from "./errors.js";

// ---------- message types ----------
export interface HelloMsg {
	type: "hello";
	v: string;
	sid: string;
	app: string;
	origin: string;
	tab: string;
}
export interface HelloAckMsg {
	type: "hello.ack";
	v: string;
	server: string;
	expiresMs: number;
}
export interface WireError {
	code: string;
	message: string;
}
export interface ErrorMsg {
	type: "error";
	code: string;
	message: string;
	/** Set when the error is tied to a traced frame (e.g. `tool.call`); omitted otherwise (M3). */
	traceId?: string;
}
export type Tier = "read" | "write" | "dangerous";
export interface ToolRegisterMsg {
	type: "tool.register";
	name: string;
	description: string;
	inputSchema?: unknown;
	tier?: Tier;
	timeoutMs?: number;
}
export interface ToolUnregisterMsg {
	type: "tool.unregister";
	name: string;
}
export interface ToolCallMsg {
	type: "tool.call";
	id: number;
	name: string;
	args: unknown;
	deadlineMs: number;
	traceId: string;
}
export interface ToolResultMsg {
	type: "tool.result";
	id: number;
	value?: unknown;
	error?: WireError;
}
export interface PromptRequestMsg {
	type: "prompt.request";
	id: number;
	name: string;
	args: Record<string, unknown>;
}
export interface PromptResultMsg {
	type: "prompt.result";
	id: number;
	messages?: unknown[];
	error?: WireError;
}
export interface ResourceRequestMsg {
	type: "resource.request";
	id: number;
	uri: string;
}
export interface ResourceResultMsg {
	type: "resource.result";
	id: number;
	contents?: unknown[];
	error?: WireError;
}
export interface SamplingRequestMsg {
	type: "sampling.request";
	id: number;
	messages: unknown[];
	systemPrompt?: string;
	maxTokens: number;
	schema?: unknown;
}
export interface SamplingResultMsg {
	type: "sampling.result";
	id: number;
	value?: unknown;
	error?: WireError;
}
export type CallPhase = "start" | "progress" | "end";
export interface CallEventMsg {
	type: "call.event";
	id: number;
	phase: CallPhase;
	ms?: number;
}
export interface SessionRevokeMsg {
	type: "session.revoke";
	reason: string;
}
/** B→P: ask the widget to gate a tiered call (spec §6.2, §7.3). */
export interface ConsentRequestMsg {
	type: "consent.request";
	id: number;
	tool: string;
	description: string;
	args: unknown;
	tier: Tier;
	deadlineMs: number;
}
/** P→B: the user's (or a programmatic caller's) decision on a consent request. */
export interface ConsentResultMsg {
	type: "consent.result";
	id: number;
	decision: "approved" | "denied";
}

export type PageToBridgeMsg =
	| HelloMsg
	| ToolRegisterMsg
	| ToolUnregisterMsg
	| ToolResultMsg
	| PromptResultMsg
	| ResourceResultMsg
	| SamplingResultMsg
	| CallEventMsg
	| ConsentResultMsg
	| SessionRevokeMsg;
export type BridgeToPageMsg =
	| HelloAckMsg
	| ErrorMsg
	| ToolCallMsg
	| PromptRequestMsg
	| ResourceRequestMsg
	| SamplingRequestMsg
	| ConsentRequestMsg
	| SessionRevokeMsg;
export type GlassboxMessage = PageToBridgeMsg | BridgeToPageMsg;

export const MESSAGE_TYPES = [
	"hello",
	"hello.ack",
	"error",
	"tool.register",
	"tool.unregister",
	"tool.call",
	"tool.result",
	"prompt.request",
	"prompt.result",
	"resource.request",
	"resource.result",
	"sampling.request",
	"sampling.result",
	"call.event",
	"consent.request",
	"consent.result",
	"session.revoke",
] as const;

// ---------- validation ----------
type AnyMsg = Record<string, unknown>;

function fail(field: string, msg: string): never {
	throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, `${msg} (field "${field}")`);
}
function str(m: AnyMsg, k: string): void {
	if (typeof m[k] !== "string" || (m[k] as string).length === 0)
		fail(k, "expected non-empty string");
}
function num(m: AnyMsg, k: string): void {
	if (typeof m[k] !== "number" || !Number.isFinite(m[k])) fail(k, "expected finite number");
}
function optStr(m: AnyMsg, k: string): void {
	if (k in m && typeof m[k] !== "string") fail(k, "expected string");
}
function optNum(m: AnyMsg, k: string): void {
	if (k in m && (typeof m[k] !== "number" || !Number.isFinite(m[k])))
		fail(k, "expected finite number");
}
function wireError(m: AnyMsg): void {
	const e = m.error;
	if (typeof e !== "object" || e === null) fail("error", "expected {code, message}");
	const err = e as Record<string, unknown>;
	if (typeof err.code !== "string" || typeof err.message !== "string") {
		fail("error", "expected {code, message}");
	}
}
/** result messages: exactly one of <payload>|error */
function xorPayload(
	m: AnyMsg,
	payload: "value" | "messages" | "contents",
	validate: (v: unknown) => boolean,
): void {
	const hasP = payload in m;
	const hasE = "error" in m;
	if (hasP === hasE) fail(`${payload}|error`, `exactly one of ${payload}|error required`);
	if (hasP && !validate(m[payload])) fail(payload, "invalid payload");
	if (hasE) wireError(m);
}

function valueXorError(m: AnyMsg): void {
	xorPayload(m, "value", () => true);
}

type Rule = (m: AnyMsg) => void;
const rules: Record<string, Rule> = {
	hello: (m) => {
		for (const k of ["v", "sid", "app", "origin", "tab"]) str(m, k);
	},
	"hello.ack": (m) => {
		str(m, "v");
		str(m, "server");
		num(m, "expiresMs");
	},
	error: (m) => {
		str(m, "code");
		str(m, "message");
		optStr(m, "traceId");
	},
	"tool.register": (m) => {
		str(m, "name");
		str(m, "description");
		if ("tier" in m && !["read", "write", "dangerous"].includes(m.tier as string)) {
			fail("tier", "expected read|write|dangerous");
		}
		optNum(m, "timeoutMs");
	},
	"tool.unregister": (m) => str(m, "name"),
	"tool.call": (m) => {
		num(m, "id");
		str(m, "name");
		num(m, "deadlineMs");
		str(m, "traceId");
	},
	"tool.result": (m) => {
		num(m, "id");
		valueXorError(m);
	},
	"prompt.request": (m) => {
		num(m, "id");
		str(m, "name");
		if (typeof m.args !== "object" || m.args === null || Array.isArray(m.args))
			fail("args", "expected object");
	},
	"prompt.result": (m) => {
		num(m, "id");
		xorPayload(m, "messages", Array.isArray);
	},
	"resource.request": (m) => {
		num(m, "id");
		str(m, "uri");
	},
	"resource.result": (m) => {
		num(m, "id");
		xorPayload(m, "contents", Array.isArray);
	},
	"sampling.request": (m) => {
		num(m, "id");
		if (!Array.isArray(m.messages)) fail("messages", "expected array");
		num(m, "maxTokens");
		optStr(m, "systemPrompt");
	},
	"sampling.result": (m) => {
		num(m, "id");
		valueXorError(m);
	},
	"call.event": (m) => {
		num(m, "id");
		if (!["start", "progress", "end"].includes(m.phase as string))
			fail("phase", "expected start|progress|end");
		optNum(m, "ms");
	},
	"consent.request": (m) => {
		num(m, "id");
		str(m, "tool");
		str(m, "description");
		if (!["read", "write", "dangerous"].includes(m.tier as string)) {
			fail("tier", "expected read|write|dangerous");
		}
		num(m, "deadlineMs");
	},
	"consent.result": (m) => {
		num(m, "id");
		if (!["approved", "denied"].includes(m.decision as string)) {
			fail("decision", "expected approved|denied");
		}
	},
	"session.revoke": (m) => str(m, "reason"),
};

// ---------- public API ----------
export function encode(msg: GlassboxMessage): string {
	const s = JSON.stringify(msg);
	if (s === undefined) {
		throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "message is not JSON-serializable");
	}
	return s;
}

export function decode(frame: string): GlassboxMessage {
	let m: unknown;
	try {
		m = JSON.parse(frame);
	} catch (e) {
		throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "frame is not valid JSON", {
			cause: e,
		});
	}
	if (typeof m !== "object" || m === null || Array.isArray(m)) {
		throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "frame must be a JSON object");
	}
	const t = (m as AnyMsg).type;
	if (typeof t !== "string" || !(t in rules)) {
		throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, `unknown message type: ${String(t)}`);
	}
	rules[t]!(m as AnyMsg);
	return m as GlassboxMessage;
}

export function roundTrip(msg: GlassboxMessage): GlassboxMessage {
	return decode(encode(msg));
}
