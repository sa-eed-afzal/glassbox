import { describe, expect, it } from "vitest";
import { FakeClock, makeDeadline, SystemClock } from "../src/core/clock.js";

describe("clock & deadlines (spec §5.5, §8)", () => {
	it("fake clock drives deadlines deterministically", () => {
		const clock = new FakeClock();
		const d = makeDeadline(clock, 100);
		expect(d.expired()).toBe(false);
		clock.advance(99);
		expect(d.expired()).toBe(false);
		expect(d.remainingMs()).toBe(1);
		clock.advance(1);
		expect(d.expired()).toBe(true);
	});

	it("system clock reports sane monotonic values", () => {
		const c = new SystemClock();
		const a = c.now();
		expect(c.now()).toBeGreaterThanOrEqual(a);
	});

	it("rejects invalid limits", () => {
		expect(() => makeDeadline(new FakeClock(), 0)).toThrowError(RangeError);
		expect(() => makeDeadline(new FakeClock(), Number.NaN)).toThrowError(RangeError);
		expect(() => new FakeClock().advance(-1)).toThrowError(RangeError);
	});
});
