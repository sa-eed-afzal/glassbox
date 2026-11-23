/** One monotonic clock for all deadlines (spec §8). Injectable so tests are deterministic. */
export interface Clock {
	readonly label: string;
	/** Monotonic milliseconds. */
	now(): number;
}

export class SystemClock implements Clock {
	readonly label = "system";
	now(): number {
		return performance.now();
	}
}

/** Test clock: advance() drives deadlines without real waiting. */
export class FakeClock implements Clock {
	readonly label = "fake";
	private t = 0;
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		if (!Number.isFinite(ms) || ms < 0) throw new RangeError("FakeClock.advance: ms must be >= 0");
		this.t += ms;
	}
}

export interface Deadline {
	startedAt: number;
	readonly limitMs: number;
	remainingMs(): number;
	expired(): boolean;
}

export function makeDeadline(clock: Clock, limitMs: number): Deadline {
	if (!Number.isFinite(limitMs) || limitMs <= 0)
		throw new RangeError("limitMs must be a positive number");
	const startedAt = clock.now();
	return {
		startedAt,
		limitMs,
		remainingMs: () => limitMs - (clock.now() - startedAt),
		expired: () => clock.now() - startedAt >= limitMs,
	};
}
