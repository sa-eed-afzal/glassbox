/**
 * Injectable timer abstraction (spec §5.5, §8) so deadlines and idle expiry are
 * deterministic in tests (ManualScheduler) and real in the host (nodeScheduler).
 */
export interface Scheduler {
	schedule(delayMs: number, fn: () => void): unknown;
	cancel(handle: unknown): void;
}

export const nodeScheduler: Scheduler = {
	schedule: (delayMs, fn) => setTimeout(fn, delayMs),
	cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Test scheduler: no real timers. fireAll() runs pending callbacks in order. */
export class ManualScheduler implements Scheduler {
	private timers: Array<{ id: number; fn: () => void }> = [];
	private next = 1;

	schedule(_delayMs: number, fn: () => void): unknown {
		const id = this.next++;
		this.timers.push({ id, fn });
		return id;
	}

	cancel(handle: unknown): void {
		this.timers = this.timers.filter((t) => t.id !== handle);
	}

	fireAll(): void {
		const pending = this.timers;
		this.timers = [];
		for (const t of pending) t.fn();
	}

	pending(): number {
		return this.timers.length;
	}
}
