import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** One line of the append-only audit stream (spec §7.5). */
export type AuditConsent = "auto" | "approved" | "denied";

export interface AuditEntry {
	ts: number;
	traceId: string;
	channel?: string;
	client?: string;
	/**
	 * The page session involved (spec §7.5): for a call, the one that was asked for
	 * consent and ran it; for an ignored consent answer, the one that sent it.
	 */
	session?: string;
	tool?: string;
	tier?: string;
	argsHash?: string;
	consent?: AuditConsent;
	/** Full args — only present when GLASSBOX_AUDIT_ARGS=1 (spec §7.5). */
	args?: unknown;
	ms?: number;
	status:
		| "ok"
		| "error"
		| "deadline"
		| "lost"
		| "revoke"
		| "register"
		| "unregister"
		| "session"
		| "impersonation";
	detail?: string;
}

export interface AuditSink {
	record(entry: AuditEntry): void;
}

/** In-memory sink — the default for tests and `glassbox bridge`. */
export class InMemoryAudit implements AuditSink {
	readonly entries: AuditEntry[] = [];
	record(entry: AuditEntry): void {
		this.entries.push(entry);
	}
	last(n = 10): AuditEntry[] {
		return this.entries.slice(-n);
	}
}

/**
 * Append-only JSONL sink (spec §7.5). The file is 0600 and its directory 0700.
 * Never throws — audit must not crash the bridge.
 */
export class FileAudit implements AuditSink {
	private readonly dir: string;
	private ensured = false;

	constructor(private readonly path: string) {
		this.dir = dirname(path);
		this.ensure();
	}

	/** Create/ensure the 0700 dir and 0600 file. Best-effort: never throws. */
	private ensure(): void {
		if (this.ensured) return;
		try {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			try {
				chmodSync(this.dir, 0o700);
			} catch {
				// dir may pre-exist with a stricter mode
			}
			// touch the file so the mode is enforced even before the first record
			appendFileSync(this.path, "", { mode: 0o600 });
			chmodSync(this.path, 0o600);
			this.ensured = true;
		} catch {
			// best-effort; record() retries the mkdir on each write
		}
	}

	record(entry: AuditEntry): void {
		try {
			if (!this.ensured) this.ensure();
			mkdirSync(this.dir, { recursive: true });
			appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		} catch {
			// swallow: audit is best-effort
		}
	}
}
