/** Typed protocol errors. Every failure across Glassbox carries one of these codes. */
export const GlassboxErrorCode = {
	VERSION_MISMATCH: "VERSION_MISMATCH",
	PROTOCOL_ERROR: "PROTOCOL_ERROR",
	UNKNOWN_TOOL: "UNKNOWN_TOOL",
	DEADLINE: "DEADLINE",
	REVOKED: "REVOKED",
	POLICY_DENIED: "POLICY_DENIED",
	CONSENT_DENIED: "CONSENT_DENIED",
	UNAUTHORIZED: "UNAUTHORIZED",
} as const;

export type GlassboxErrorCodeType = (typeof GlassboxErrorCode)[keyof typeof GlassboxErrorCode];

export class GlassboxError extends Error {
	readonly code: GlassboxErrorCodeType | (string & {});
	readonly traceId?: string;

	constructor(
		code: GlassboxErrorCodeType | (string & {}),
		message: string,
		opts?: { traceId?: string; cause?: unknown },
	) {
		super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
		this.name = "GlassboxError";
		this.code = code;
		if (opts?.traceId !== undefined) this.traceId = opts.traceId;
	}
}

export function isGlassboxError(e: unknown): e is GlassboxError {
	return e instanceof Error && (e as GlassboxError).name === "GlassboxError";
}
