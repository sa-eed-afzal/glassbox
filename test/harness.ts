/**
 * Bridge-side conformance harness: the minimal honest implementation of the
 * bridge half of glassbox/v1 over a Link (hello, registration, call dispatch,
 * deadlines, coercion). In M1 the WebSocket host + MCP server replace the
 * Link; codec, coercion, and deadlines stay exactly this code.
 */

import { type Clock, type Deadline, FakeClock, makeDeadline } from "../src/core/clock.js";
import {
	type CallEventMsg,
	decode,
	encode,
	type GlassboxMessage,
	type PromptResultMsg,
	type ResourceResultMsg,
	type SamplingResultMsg,
	type ToolRegisterMsg,
} from "../src/core/codec.js";
import { type CallToolResult, coerceError, coerceResult } from "../src/core/coerce.js";
import { GlassboxErrorCode } from "../src/core/errors.js";
import { assertProtocolVersion, helloAck } from "../src/core/version.js";
import type { Link } from "./link.js";

interface PendingCall {
	resolve: (r: CallToolResult) => void;
	deadline: Deadline;
	traceId: string;
}
interface PendingReq {
	resolve: (m: GlassboxMessage) => void;
	deadline: Deadline;
}

export interface BridgeHarness {
	registered: Map<string, ToolRegisterMsg>;
	events: CallEventMsg[];
	pageMessages: GlassboxMessage[];
	clock: Clock;
	/** Dispatch a tool call; resolves with the coerced CallToolResult (or DEADLINE on expiry). */
	call(name: string, args?: unknown, deadlineMs?: number): Promise<CallToolResult>;
	requestResource(uri: string): Promise<ResourceResultMsg>;
	requestPrompt(name: string, args: Record<string, unknown>): Promise<PromptResultMsg>;
	requestSampling(
		messages: unknown[],
		maxTokens: number,
		schema?: unknown,
	): Promise<SamplingResultMsg>;
	/** Check pending deadlines against the clock (deterministic stand-in for the timer). */
	tick(): void;
}

export function createBridgeHarness(
	link: Link,
	clock: Clock = new FakeClock(),
	protocolVersion = "2025-06-18",
): BridgeHarness {
	let nextId = 1;
	const pendingCalls = new Map<number, PendingCall>();
	const pendingReqs = new Map<number, PendingReq>();

	const h: BridgeHarness = {
		registered: new Map(),
		events: [],
		pageMessages: [],
		clock,
		call: (name, args, deadlineMs = 10000) => {
			const reg = h.registered.get(name);
			if (!reg) {
				return Promise.resolve(
					coerceError(GlassboxErrorCode.UNKNOWN_TOOL, `no such tool: ${name}`, `tr-${nextId}`),
				);
			}
			const id = nextId++;
			const traceId = `tr-${id}`;
			const deadline = makeDeadline(clock, deadlineMs);
			return new Promise<CallToolResult>((resolve) => {
				pendingCalls.set(id, { resolve, deadline, traceId });
				link.send(encode({ type: "tool.call", id, name, args: args ?? {}, deadlineMs, traceId }));
			});
		},
		requestResource: (uri) =>
			new Promise<ResourceResultMsg>((resolve) => {
				const id = nextId++;
				pendingReqs.set(id, {
					resolve: resolve as (m: GlassboxMessage) => void,
					deadline: makeDeadline(clock, 10000),
				});
				link.send(encode({ type: "resource.request", id, uri }));
			}),
		requestPrompt: (name, args) =>
			new Promise<PromptResultMsg>((resolve) => {
				const id = nextId++;
				pendingReqs.set(id, {
					resolve: resolve as (m: GlassboxMessage) => void,
					deadline: makeDeadline(clock, 10000),
				});
				link.send(encode({ type: "prompt.request", id, name, args }));
			}),
		requestSampling: (messages, maxTokens, schema) =>
			new Promise<SamplingResultMsg>((resolve) => {
				const id = nextId++;
				pendingReqs.set(id, {
					resolve: resolve as (m: GlassboxMessage) => void,
					deadline: makeDeadline(clock, 10000),
				});
				link.send(
					encode({
						type: "sampling.request",
						id,
						messages,
						maxTokens,
						...(schema !== undefined ? { schema } : {}),
					}),
				);
			}),
		tick: () => {
			for (const [id, p] of [...pendingCalls]) {
				if (p.deadline.expired()) {
					pendingCalls.delete(id);
					p.resolve(
						coerceError(GlassboxErrorCode.DEADLINE, "page did not respond in time", p.traceId),
					);
				}
			}
			for (const [id, p] of [...pendingReqs]) {
				if (p.deadline.expired()) {
					pendingReqs.delete(id);
					p.resolve({
						type: "error",
						code: GlassboxErrorCode.DEADLINE,
						message: "request deadline exceeded",
					});
				}
			}
		},
	};

	link.onMessage((frame) => {
		const m = decode(frame);
		h.pageMessages.push(m);
		switch (m.type) {
			case "hello":
				try {
					assertProtocolVersion(m.v);
					link.send(encode({ type: "hello.ack", ...helloAck("0.0.0", 1_800_000) }));
				} catch (e) {
					link.send(
						encode({
							type: "error",
							code: GlassboxErrorCode.VERSION_MISMATCH,
							message: e instanceof Error ? e.message : String(e),
						}),
					);
				}
				return;
			case "tool.register":
				h.registered.set(m.name, m);
				return;
			case "tool.unregister":
				h.registered.delete(m.name);
				return;
			case "tool.result": {
				const p = pendingCalls.get(m.id);
				if (!p) return;
				pendingCalls.delete(m.id);
				p.resolve(
					m.error
						? coerceError(m.error.code, m.error.message, p.traceId)
						: coerceResult(m.value, protocolVersion),
				);
				return;
			}
			case "resource.result":
			case "prompt.result":
			case "sampling.result": {
				const p = pendingReqs.get(m.id);
				if (p) {
					pendingReqs.delete(m.id);
					p.resolve(m);
				}
				return;
			}
			case "call.event":
				h.events.push(m);
				return;
			default:
				return;
		}
	});

	return h;
}
