/**
 * Startup self-check (spec §7.4, §9.4). Runs BEFORE the bridge serves anything.
 *
 *   1. Resolved dependency majors must match the package.json pins — the exact E1
 *      lesson (zod 4.x hoisted under the MCP SDK) fails loud with the drift named.
 *   2. The credential file, if present, must be 0600 owner-only — a world/group
 *      readable credential FAILS startup (it is never auto-fixed: it is a red flag).
 *   3. The audit file/dir modes (0600/0700) — fix-or-fail.
 *
 * A failing self-check stops the bridge before it listens, so a drifted tree or a
 * leaked credential is never served.
 */
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SelfCheckProblem {
	area: "deps" | "creds" | "audit";
	message: string;
}

export interface SelfCheckResult {
	ok: boolean;
	problems: SelfCheckProblem[];
	/** Human-readable report lines (fixes, drifts) for stderr. */
	lines: string[];
}

const CORE = new Set([
	"assert",
	"buffer",
	"child_process",
	"cluster",
	"crypto",
	"events",
	"fs",
	"http",
	"https",
	"net",
	"os",
	"path",
	"process",
	"querystring",
	"stream",
	"string_decoder",
	"timers",
	"tty",
	"url",
	"util",
	"zlib",
]);

function major(v: string): string {
	const m = /^v?(\d+)/.exec(v.trim());
	return m ? m[1]! : "";
}

type ReadJson = (path: string) => unknown;

/**
 * Assert resolved dependency majors match the package.json pins (spec §7.4).
 * Also guards against a core module masquerading as an npm dependency (E10).
 */
export function checkDependencies(
	projectDir: string,
	readJson: ReadJson = (p) => JSON.parse(readFileSync(p, "utf8")),
): { ok: boolean; problems: SelfCheckProblem[]; lines: string[] } {
	const problems: SelfCheckProblem[] = [];
	const lines: string[] = [];
	let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	try {
		pkg = readJson(join(projectDir, "package.json")) as typeof pkg;
	} catch (e) {
		problems.push({
			area: "deps",
			message: `cannot read package.json in ${projectDir}: ${e instanceof Error ? e.message : String(e)}`,
		});
		return { ok: false, problems, lines };
	}
	const expected = { ...pkg.dependencies, ...pkg.devDependencies };
	for (const [name, pinned] of Object.entries(expected)) {
		if (CORE.has(name)) {
			problems.push({
				area: "deps",
				message: `"${name}" is declared as an npm dependency but is a Node core module (fake-package smell)`,
			});
			continue;
		}
		let resolved = "NOT_INSTALLED";
		try {
			const p = readJson(join(projectDir, "node_modules", name, "package.json")) as {
				version?: string;
			};
			resolved = p.version ?? "UNKNOWN";
		} catch {
			// NOT_INSTALLED
		}
		const ok = major(pinned) !== "" && major(pinned) === major(resolved);
		if (!ok) {
			problems.push({
				area: "deps",
				message: `dependency drift: ${name} pinned ${pinned}, resolved ${resolved} (major mismatch)`,
			});
		} else {
			lines.push(`ok   ${name} pinned ${pinned} resolved ${resolved}`);
		}
	}
	return { ok: problems.length === 0, problems, lines };
}

/**
 * The credential file must be 0600 owner-only (spec §7.2). World/group-readable
 * fails loud — it is NOT auto-fixed, because a leaked credential is a red flag,
 * not a typo to paper over. Absent file → ok (nothing to check).
 */
export function checkCredentialFile(file: string): {
	ok: boolean;
	problems: SelfCheckProblem[];
	lines: string[];
} {
	const problems: SelfCheckProblem[] = [];
	const lines: string[] = [];
	if (!existsSync(file)) {
		lines.push(`ok   credential ${file} (absent — generated on first run)`);
		return { ok: true, problems, lines };
	}
	const mode = statSync(file).mode & 0o777;
	if (mode & 0o077) {
		problems.push({
			area: "creds",
			message: `credential file ${file} is group/world-readable (mode ${mode.toString(8)}); required 0600. Fix: chmod 600 ${file}`,
		});
	} else {
		lines.push(`ok   credential ${file} (mode ${mode.toString(8)})`);
	}
	return { ok: problems.length === 0, problems, lines };
}

/**
 * Audit file must be 0600 and its directory 0700 (spec §7.5). Fix-or-fail: attempt
 * to correct the mode; if it is still wrong afterwards (not our file), fail.
 */
export function checkAuditModes(
	file: string,
	fix: boolean,
): { ok: boolean; problems: SelfCheckProblem[]; lines: string[] } {
	const problems: SelfCheckProblem[] = [];
	const lines: string[] = [];
	if (!existsSync(file)) {
		lines.push(`ok   audit ${file} (absent — created on first record)`);
		return { ok: true, problems, lines };
	}
	const dir = dirname(file);
	const dirMode = () => statSync(dir).mode & 0o777;
	if (dirMode() !== 0o700) {
		if (fix) {
			try {
				chmodSync(dir, 0o700);
				lines.push(`fix  audit dir ${dir} ${dirMode().toString(8)} → ${dirMode().toString(8)}`);
			} catch {
				// fall through to the re-check below
			}
		}
		if (dirMode() !== 0o700) {
			problems.push({
				area: "audit",
				message: `audit directory ${dir} is mode ${dirMode().toString(8)}; required 0700`,
			});
		}
	}
	const fileMode = () => statSync(file).mode & 0o777;
	if (fileMode() !== 0o600) {
		if (fix) {
			try {
				chmodSync(file, 0o600);
				lines.push(`fix  audit file ${file} → mode 600`);
			} catch {
				// fall through to the re-check below
			}
		}
		if (fileMode() !== 0o600) {
			problems.push({
				area: "audit",
				message: `audit file ${file} is mode ${fileMode().toString(8)}; required 0600`,
			});
		}
	} else {
		lines.push(`ok   audit ${file} (mode 600)`);
	}
	return { ok: problems.length === 0, problems, lines };
}

export interface SelfCheckOptions {
	projectDir: string;
	credsFile?: string;
	auditFile?: string;
	/** Attempt to correct audit modes (default true). Creds are never auto-fixed. */
	fixAudit?: boolean;
	readJson?: ReadJson;
}

/** Run all self-checks; the bridge must not serve unless `ok` is true. */
export function runSelfCheck(opts: SelfCheckOptions): SelfCheckResult {
	const problems: SelfCheckProblem[] = [];
	const lines: string[] = [];

	const deps = checkDependencies(opts.projectDir, opts.readJson);
	problems.push(...deps.problems);
	lines.push(...deps.lines);

	if (opts.credsFile) {
		const creds = checkCredentialFile(opts.credsFile);
		problems.push(...creds.problems);
		lines.push(...creds.lines);
	}
	if (opts.auditFile) {
		const audit = checkAuditModes(opts.auditFile, opts.fixAudit ?? true);
		problems.push(...audit.problems);
		lines.push(...audit.lines);
	}

	return { ok: problems.length === 0, problems, lines };
}
