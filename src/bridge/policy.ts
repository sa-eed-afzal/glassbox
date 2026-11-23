/**
 * Permission tiers & consent policy (spec §7.3).
 *
 * A policy file (`glassbox.json`) maps appId → per-tier decision:
 *
 *   { "policy": { "mygame": { "read": "auto", "write": "consent", "dangerous": "deny" } } }
 *
 * Resolution: the project file (`<cwd>/glassbox.json`) overrides the global file
 * (`~/.config/glassbox/glassbox.json`) per appId, per tier. Defaults when nothing
 * says otherwise: read=auto, write=consent, dangerous=deny.
 *
 * A policy is TRUST configuration, not user content — a malformed file fails loud
 * (throws PolicyError) and is never silently ignored.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Tier = "read" | "write" | "dangerous";
export type ConsentDecision = "auto" | "consent" | "deny";
export type TierPolicy = Partial<Record<Tier, ConsentDecision>>;
export type Policy = Record<string, TierPolicy>;

/** Spec §7.3 default: read auto, write consent, dangerous deny. */
export const DEFAULT_TIER_POLICY: Record<Tier, ConsentDecision> = {
	read: "auto",
	write: "consent",
	dangerous: "deny",
};

const TIER_KEYS: string[] = ["read", "write", "dangerous"];
const DECISIONS: string[] = ["auto", "consent", "deny"];

export class PolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PolicyError";
	}
}

/** Validate a parsed `policy` object; throws PolicyError on any malformation. */
export function validatePolicy(value: unknown, where: string): Policy {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new PolicyError(`policy in ${where} must be an object of appId → tier decisions`);
	}
	const out: Policy = {};
	for (const [appId, tiers] of Object.entries(value as Record<string, unknown>)) {
		if (typeof appId !== "string" || appId.length === 0) {
			throw new PolicyError(`policy in ${where} has a non-string appId`);
		}
		if (typeof tiers !== "object" || tiers === null || Array.isArray(tiers)) {
			throw new PolicyError(
				`policy in ${where}: app "${appId}" must be an object of tier → decision`,
			);
		}
		const tp: TierPolicy = {};
		for (const [tier, decision] of Object.entries(tiers as Record<string, unknown>)) {
			if (!TIER_KEYS.includes(tier)) {
				throw new PolicyError(
					`policy in ${where}: app "${appId}" has unknown tier "${tier}" (want read|write|dangerous)`,
				);
			}
			if (!DECISIONS.includes(decision as string)) {
				throw new PolicyError(
					`policy in ${where}: app "${appId}" tier "${tier}" has invalid decision "${String(
						decision,
					)}" (want auto|consent|deny)`,
				);
			}
			tp[tier as Tier] = decision as ConsentDecision;
		}
		out[appId] = tp;
	}
	return out;
}

/** Resolve a (appId, tier) decision against a policy, falling back to the spec default. */
export function resolveDecision(policy: Policy, appId: string, tier: Tier): ConsentDecision {
	return policy[appId]?.[tier] ?? DEFAULT_TIER_POLICY[tier];
}

export interface PolicyResolver {
	resolve(appId: string, tier: Tier): ConsentDecision;
	readonly policy: Policy;
}

/** A policy resolver built from an in-memory policy (test / default path). */
export class PolicyFile implements PolicyResolver {
	readonly policy: Policy;
	constructor(policy: Policy) {
		this.policy = policy;
	}
	resolve(appId: string, tier: Tier): ConsentDecision {
		return resolveDecision(this.policy, appId, tier);
	}
}

/** The spec §7.3 default resolver (read auto / write consent / dangerous deny). */
export const defaultPolicy: PolicyFile = new PolicyFile({});

/** A permissive resolver (every call auto) — for tests that are not about consent. */
export function autoPolicy(): PolicyResolver {
	return { resolve: () => "auto", policy: {} };
}

export interface LoadPolicyOptions {
	/** Project directory holding a local glassbox.json (default: process.cwd()). */
	projectDir?: string;
	/** Global config directory (default: $XDG_CONFIG_HOME/glassbox or ~/.config/glassbox). */
	globalDir?: string;
	/** Override the file reader (tests). */
	read?: (path: string) => string | null;
}

export function defaultGlobalDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
	return join(base, "glassbox");
}

function readPolicyFile(path: string, read?: (p: string) => string | null): Policy | null {
	const raw = read ? read(path) : existsSync(path) ? readFileSync(path, "utf8") : null;
	if (raw === null || raw.trim() === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new PolicyError(
			`malformed JSON in policy file ${path}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new PolicyError(`policy file ${path} must contain a JSON object`);
	}
	const obj = parsed as Record<string, unknown>;
	if (!("policy" in obj)) return {}; // valid file, just no policy key
	return validatePolicy(obj.policy, path);
}

/**
 * Load and merge the project + global policy files (project wins per appId/tier).
 * Fails loud (throws PolicyError) on any malformed file — policy is trust config.
 */
export function loadPolicy(opts: LoadPolicyOptions = {}): PolicyFile {
	const projectDir = opts.projectDir ?? process.cwd();
	const globalDir = opts.globalDir ?? defaultGlobalDir();
	const read = opts.read;
	const project = readPolicyFile(join(projectDir, "glassbox.json"), read) ?? {};
	const global = readPolicyFile(join(globalDir, "glassbox.json"), read) ?? {};
	const merged: Policy = {};
	for (const appId of new Set([...Object.keys(global), ...Object.keys(project)])) {
		merged[appId] = { ...global[appId], ...project[appId] };
	}
	return new PolicyFile(merged);
}
