import { randomUUID } from "node:crypto";
import { GlassboxError, GlassboxErrorCode } from "../core/errors.js";

/**
 * Connect-code model (spec §5.2, §7.1).
 *
 * A connect code is a compact, self-describing token that carries the LOOPBACK
 * endpoint + channel + a one-shot codeId, and EXPIRES (default 60s). It carries
 * NO credential — the session token is issued separately by the session exchange.
 * This is the "code is the only discovery path" property, and it deliberately does
 * not embed the server token (the D4/D6 defect).
 */
const CODE_VERSION = "gbx/v1";

export interface ParsedCode {
	v: string;
	host: string;
	port: number;
	channel: string;
	app: string;
	codeId: string;
	expMs: number;
}

export interface CodeRecord {
	codeId: string;
	channel: string;
	app: string;
	origin: string;
	expiresAt: number;
	consumed: boolean;
}

export interface MintedCode {
	code: string;
	codeId: string;
	host: string;
	port: number;
	channel: string;
	app: string;
	expiresMs: number;
}

export interface MintOpts {
	host: string;
	port: number;
	channel: string;
	app: string;
	origin: string;
}

function toB64url(s: string): string {
	return Buffer.from(s, "utf8").toString("base64url");
}
function fromB64url(s: string): string {
	return Buffer.from(s, "base64url").toString("utf8");
}

export class CodeStore {
	private records = new Map<string, CodeRecord>();

	constructor(
		private readonly now: () => number,
		private readonly ttlMs: number,
	) {}

	mint(opts: MintOpts): MintedCode {
		this.gc();
		const codeId = randomUUID();
		const expiresAt = this.now() + this.ttlMs;
		this.records.set(codeId, {
			codeId,
			channel: opts.channel,
			app: opts.app,
			origin: opts.origin,
			expiresAt,
			consumed: false,
		});
		const payload: ParsedCode = {
			v: CODE_VERSION,
			host: opts.host,
			port: opts.port,
			channel: opts.channel,
			app: opts.app,
			codeId,
			expMs: this.ttlMs,
		};
		return {
			code: toB64url(JSON.stringify(payload)),
			codeId,
			host: opts.host,
			port: opts.port,
			channel: opts.channel,
			app: opts.app,
			expiresMs: this.ttlMs,
		};
	}

	parse(code: string): ParsedCode {
		if (typeof code !== "string" || code.length === 0) {
			throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "connect code is empty");
		}
		let payload: ParsedCode;
		try {
			payload = JSON.parse(fromB64url(code)) as ParsedCode;
		} catch {
			throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "connect code is malformed");
		}
		if (payload.v !== CODE_VERSION) {
			throw new GlassboxError(
				GlassboxErrorCode.VERSION_MISMATCH,
				`connect code version "${payload.v}" not supported`,
			);
		}
		if (
			typeof payload.host !== "string" ||
			!Number.isInteger(payload.port) ||
			typeof payload.codeId !== "string"
		) {
			throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "connect code is malformed");
		}
		return payload;
	}

	/** Validate a one-shot code and mark it consumed. Throws a typed error on any mismatch. */
	consume(code: string): CodeRecord {
		const p = this.parse(code);
		const rec = this.records.get(p.codeId);
		if (!rec) {
			throw new GlassboxError(
				GlassboxErrorCode.PROTOCOL_ERROR,
				"connect code unknown (minted by a different bridge?)",
			);
		}
		if (rec.consumed) {
			throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "connect code already used");
		}
		if (this.now() >= rec.expiresAt) {
			throw new GlassboxError(GlassboxErrorCode.DEADLINE, "connect code expired");
		}
		rec.consumed = true;
		return rec;
	}

	size(): number {
		return this.records.size;
	}

	private gc(): void {
		const t = this.now();
		for (const [id, rec] of this.records) {
			if (t >= rec.expiresAt) this.records.delete(id);
		}
	}
}
