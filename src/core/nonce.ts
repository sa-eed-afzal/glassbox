/**
 * Management-endpoint nonce challenge (spec §7.2, §9.4).
 *
 * Callers prove access to the authorized principal's Ed25519 private key by
 * signing a fresh `nonce || method || path || body` message. The bridge verifies
 * the signature against the allowlisted public key(s) and rejects replayed
 * nonces. A local process that cannot read the 0600 credential cannot sign, so it
 * is rejected with a typed 401 and audit-logged as an impersonation.
 *
 * Page ⇄ bridge traffic (one-shot connect codes) is intentionally NOT nonce-checked:
 * the code is the only discovery path and carries no credential (spec §7.1, §7.2).
 */
import { createPublicKey, type KeyObject, sign, verify } from "node:crypto";

/** Deterministic signed payload — the exact message every principal signs. */
export function signingMessage(nonce: string, method: string, path: string, body: string): string {
	return `${nonce}\n${method}\n${path}\n${body}`;
}

/** Sign a request with a principal's Ed25519 private key. Returns a base64 signature. */
export function signRequest(
	privateKey: KeyObject,
	nonce: string,
	method: string,
	path: string,
	body: string,
): string {
	return sign(null, Buffer.from(signingMessage(nonce, method, path, body)), privateKey).toString(
		"base64",
	);
}

/** Verify a request signature against a principal's Ed25519 public key. */
export function verifyRequest(
	publicKey: KeyObject,
	nonce: string,
	method: string,
	path: string,
	body: string,
	signature: string,
): boolean {
	try {
		return verify(
			null,
			Buffer.from(signingMessage(nonce, method, path, body)),
			publicKey,
			Buffer.from(signature, "base64"),
		);
	} catch {
		return false;
	}
}

/** Build a KeyObject from a base64 SPKI public key. */
export function publicKeyFromB64(publicKeyB64: string): KeyObject {
	return createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
}

/**
 * Replay guard: a nonce is single-use within its TTL window. The TTL bounds memory
 * (we only need to remember nonces for as long as a challenge stays replayable).
 */
export class NonceRegistry {
	private readonly used = new Map<string, number>();
	constructor(
		private readonly now: () => number,
		private readonly ttlMs: number,
	) {}
	/** Returns true the first time a nonce is seen; false on replay. */
	consume(nonce: string): boolean {
		this.gc();
		if (this.used.has(nonce)) return false;
		this.used.set(nonce, this.now() + this.ttlMs);
		return true;
	}
	size(): number {
		return this.used.size;
	}
	private gc(): void {
		const t = this.now();
		for (const [nonce, expiresAt] of this.used) {
			if (t >= expiresAt) this.used.delete(nonce);
		}
	}
}

export type NonceVerdict = { ok: true } | { ok: false; reason: string };

export interface NonceAuthOptions {
	/** Authorized principal public keys (base64 SPKI). The spawn principal lives here. */
	principals: string[];
	now?: () => number;
	nonceTtlMs?: number;
}

/**
 * Verifies nonce-signed management requests against the allowlisted principals.
 * `principals` is the per-client allowlist (spec §7.2): the launching client
 * auto-registers at spawn; other local processes are not authorized.
 */
export class NonceAuth {
	private readonly principalIds: string[];
	private readonly keys: KeyObject[];
	private readonly registry: NonceRegistry;

	constructor(opts: NonceAuthOptions) {
		this.principalIds = [...opts.principals];
		this.keys = this.principalIds.map(publicKeyFromB64);
		this.registry = new NonceRegistry(opts.now ?? Date.now, opts.nonceTtlMs ?? 60_000);
	}

	/** The allowlisted principal public keys — "exactly the spawn principal" (spec §9.4). */
	principals(): string[] {
		return [...this.principalIds];
	}

	/** Verify nonce + signature + replay. Returns a typed verdict on failure. */
	verify(
		nonce: string | undefined,
		method: string,
		path: string,
		body: string,
		signature: string | undefined,
	): NonceVerdict {
		if (!nonce || nonce.length === 0 || !signature || signature.length === 0) {
			return { ok: false, reason: "missing nonce or signature" };
		}
		if (!this.registry.consume(nonce)) {
			return { ok: false, reason: "replayed nonce" };
		}
		const data = Buffer.from(signingMessage(nonce, method, path, body));
		const sig = Buffer.from(signature, "base64");
		for (const key of this.keys) {
			try {
				if (verify(null, data, key, sig)) return { ok: true };
			} catch {
				// keep checking other principals; malformed sig is a fail, not a throw
			}
		}
		return { ok: false, reason: "signature does not match any authorized principal" };
	}
}
