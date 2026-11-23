import { GlassboxError, GlassboxErrorCode } from "./errors.js";

/** The protocol this bridge speaks (spec §5.1). Hard versioning: no silent drift. */
export const PROTOCOL_VERSION = "glassbox/v1";
export const PROTOCOL_MAJOR = 1;
export const SERVER_PRODUCT = "mcp-glassbox";

/** Throws VERSION_MISMATCH unless `v` is exactly the protocol this build supports. */
export function assertProtocolVersion(v: unknown): void {
	if (typeof v !== "string") {
		throw new GlassboxError(
			GlassboxErrorCode.VERSION_MISMATCH,
			"protocol version must be a string",
		);
	}
	const m = /^glassbox\/v(\d+)$/.exec(v);
	if (!m || Number(m[1]) !== PROTOCOL_MAJOR) {
		throw new GlassboxError(
			GlassboxErrorCode.VERSION_MISMATCH,
			`protocol "${v}" not supported (this bridge speaks ${PROTOCOL_VERSION})`,
		);
	}
}

export interface HelloAck {
	v: string;
	server: string;
	expiresMs: number;
}

export function helloAck(serverVersion: string, expiresMs: number): HelloAck {
	return { v: PROTOCOL_VERSION, server: `${SERVER_PRODUCT}/${serverVersion}`, expiresMs };
}
