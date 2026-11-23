/**
 * Per-bridge credential (spec §7.2): an Ed25519 keypair.
 *
 * The private key is the caller credential; the public key is the authorized
 * principal in the nonce allowlist. Storage order:
 *   1. OS keychain (libsecret via `secret-tool`, macOS Keychain/DPAPI on other OSes)
 *   2. Fallback: a 0600 file at ~/.config/glassbox/creds.json (with a startup warning).
 *
 * It is never world-readable and never committed. `loadOrCreate` is idempotent and
 * convergent: the bridge and the CLI, running as the same user against the same
 * store, always resolve to the same key — so a CLI request signed with the private
 * key verifies against the bridge's allowlisted public key.
 */
import { execFileSync } from "node:child_process";
import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const KEYCHAIN_LABEL = "mcp-glassbox";
export const CREDS_KEY = "app";
export const CREDS_VALUE = "mcp-glassbox-credential";

export interface Credential {
	privateKey: KeyObject;
	publicKey: KeyObject;
	/** base64 SPKI public key — the authorized-principal identity. */
	publicKeyB64: string;
	/** True when the fallback 0600 file was used (vs. the OS keychain). */
	fallback: boolean;
}

export interface CredentialOptions {
	/** Fallback credential file (default: ~/.config/glassbox/creds.json). */
	credsFile?: string;
	/** Force keychain use on/off (default: auto-detect secret-tool). */
	useKeychain?: boolean;
	/** Emit the one-line fallback warning here (default: process.stderr). */
	warn?: (message: string) => void;
}

export function defaultCredsFile(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
	return join(base, "glassbox", "creds.json");
}

interface CredsJson {
	publicKey: string; // SPKI PEM
	privateKey: string; // PKCS8 PEM
}

interface GeneratedKey {
	publicKey: KeyObject;
	privateKey: KeyObject;
	publicKeyB64: string;
	publicPem: string;
	privatePem: string;
}

/** Generate a fresh Ed25519 keypair, exported as PEM (+ base64 SPKI for the allowlist). */
export function generateKey(): GeneratedKey {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		publicKey,
		privateKey,
		publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
		publicPem: String(publicKey.export({ type: "spki", format: "pem" })),
		privatePem: String(privateKey.export({ type: "pkcs8", format: "pem" })),
	};
}

function fromPems(publicPem: string, privatePem: string, fallback: boolean): Credential {
	const publicKey = createPublicKey(publicPem);
	const privateKey = createPrivateKey(privatePem);
	return {
		publicKey,
		privateKey,
		publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
		fallback,
	};
}

function hasSecretTool(): boolean {
	try {
		execFileSync("secret-tool", ["lookup", CREDS_KEY, CREDS_VALUE], { stdio: "ignore" });
		return true;
	} catch (e) {
		// ENOENT → the binary is not installed; any other exit code → installed.
		return (e as { code?: string }).code !== "ENOENT";
	}
}

function keychainLookup(): string | null {
	try {
		const out = execFileSync("secret-tool", ["lookup", CREDS_KEY, CREDS_VALUE], {
			encoding: "utf8",
		});
		return out.trim().length > 0 ? out.trim() : null;
	} catch {
		return null;
	}
}

function keychainStore(secret: string): void {
	execFileSync(
		"secret-tool",
		["store", "--label", KEYCHAIN_LABEL, "--replace", CREDS_KEY, CREDS_VALUE],
		{ input: secret },
	);
}

function fileRead(file: string): string | null {
	if (!existsSync(file)) return null;
	const raw = readFileSync(file, "utf8").trim();
	return raw.length > 0 ? raw : null;
}

function fileStore(file: string, secret: string): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	try {
		chmodSync(dirname(file), 0o700);
	} catch {
		// best effort (dir may pre-exist owned by us)
	}
	writeFileSync(file, secret, { mode: 0o600 });
	chmodSync(file, 0o600); // enforce even if the file pre-existed with a lax mode
}

/**
 * Load the credential from the keychain or the 0600 file, or generate + store a
 * fresh one. Returns a `fallback` flag when the file path was used, so the caller
 * can emit the one-line warning (spec §7.2).
 */
export function loadOrCreate(opts: CredentialOptions = {}): Credential {
	const file = opts.credsFile ?? defaultCredsFile();
	const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
	const useKeychain = opts.useKeychain ?? (process.platform !== "win32" && hasSecretTool());

	if (useKeychain) {
		const raw = keychainLookup();
		const parsed = raw ? parseCredsJson(raw, "OS keychain") : null;
		if (parsed) return fromPems(parsed.publicKey, parsed.privateKey, false);
	} else {
		const raw = fileRead(file);
		const parsed = raw ? parseCredsJson(raw, file) : null;
		if (parsed) return fromPems(parsed.publicKey, parsed.privateKey, true);
	}

	const fresh = generateKey();
	const secret = JSON.stringify({
		publicKey: fresh.publicPem,
		privateKey: fresh.privatePem,
	} satisfies CredsJson);
	if (useKeychain) {
		keychainStore(secret);
		return fromPems(fresh.publicPem, fresh.privatePem, false);
	}
	fileStore(file, secret);
	warn(`glassbox: no OS keychain available — credential stored in ${file} (mode 0600)`);
	return fromPems(fresh.publicPem, fresh.privatePem, true);
}

function parseCredsJson(raw: string, where: string): CredsJson | null {
	try {
		const v = JSON.parse(raw) as Record<string, unknown>;
		if (typeof v.publicKey === "string" && typeof v.privateKey === "string") {
			return { publicKey: v.publicKey, privateKey: v.privateKey };
		}
		process.stderr.write(`glassbox: credential in ${where} is malformed; regenerating\n`);
		return null;
	} catch {
		process.stderr.write(`glassbox: credential in ${where} is not valid JSON; regenerating\n`);
		return null;
	}
}
