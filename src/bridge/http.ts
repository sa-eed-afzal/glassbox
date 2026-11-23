/**
 * Nonce-signed HTTP for the management endpoints (spec §7.2) — shared by the
 * CLI and the conformance harness (`glassbox test`). The credential converges
 * on the same user's keychain/0600 file, so a signature made here verifies
 * against the bridge's principal allowlist.
 */
import { randomBytes } from "node:crypto";
import { loadOrCreate } from "../core/credentials.js";
import { signRequest } from "../core/nonce.js";

export function signedFetch(
	base: string,
	path: string,
	method: "GET" | "POST",
	body?: unknown,
): Promise<Response> {
	const cred = loadOrCreate();
	const bodyStr = body !== undefined ? JSON.stringify(body) : "";
	const nonce = randomBytes(16).toString("hex");
	const signature = signRequest(cred.privateKey, nonce, method, path, bodyStr);
	const headers: Record<string, string> = {
		"x-glassbox-nonce": nonce,
		"x-glassbox-signature": signature,
	};
	if (body !== undefined) headers["content-type"] = "application/json";
	return fetch(`${base}${path}`, {
		method,
		headers,
		...(bodyStr !== "" ? { body: bodyStr } : {}),
	});
}
