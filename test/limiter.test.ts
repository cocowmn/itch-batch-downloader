import { describe, expect, test } from "bun:test";
import {
	type Clock,
	RateLimiter,
	type RateLimits,
} from "../src/features/download/limiter.ts";
import { isAbortError } from "../src/utils/abort.ts";

const HOUR = 3_600_000;

/** A clock whose sleeps advance the time instantly (unless aborted). */
function fakeClock(start = 1_000_000) {
	let now = start;
	const sleeps: number[] = [];
	const clock: Clock = {
		now: () => now,
		sleep: (ms, signal) => {
			if (signal?.aborted)
				return Promise.reject(new DOMException("Aborted", "AbortError"));
			sleeps.push(ms);
			now += ms;
			return Promise.resolve();
		},
	};
	return {
		clock,
		sleeps,
		now: () => now,
		advance: (ms: number) => (now += ms),
	};
}

function limiter(limits: Partial<RateLimits>, clock: Clock) {
	return new RateLimiter(
		{ delay: 0, perHour: 0, pacing: "spread", ...limits },
		clock,
	);
}

describe("RateLimiter", () => {
	test("no limits never waits", async () => {
		const c = fakeClock();
		const l = limiter({}, c.clock);
		for (let i = 1; i <= 5; i++)
			await l.acquire({ item: i, total: 5, previousFinishedAt: c.now() });
		expect(c.sleeps).toEqual([]);
		expect(l.estimate(1000)).toBeNull();
	});

	test("spread spaces starts 3600 / perHour apart", async () => {
		const c = fakeClock();
		const l = limiter({ perHour: 120 }, c.clock);
		await l.acquire({ item: 1, total: 3 });
		expect(c.sleeps).toEqual([]);
		c.advance(5_000); // the item took 5 s
		await l.acquire({ item: 2, total: 3 });
		expect(c.sleeps).toEqual([25_000]);
		c.advance(40_000); // longer than the interval: no wait
		await l.acquire({ item: 3, total: 3 });
		expect(c.sleeps).toEqual([25_000]);
	});

	test("eager lets perHour items start, then waits for the oldest to expire", async () => {
		const c = fakeClock();
		const l = limiter({ perHour: 3, pacing: "eager" }, c.clock);
		const t0 = c.now();
		await l.acquire({ item: 1, total: 5 });
		c.advance(1_000);
		await l.acquire({ item: 2, total: 5 });
		c.advance(1_000);
		await l.acquire({ item: 3, total: 5 });
		expect(c.sleeps).toEqual([]);
		c.advance(1_000);
		await l.acquire({ item: 4, total: 5 });
		expect(c.sleeps).toEqual([HOUR - 3_000]);
		expect(c.now()).toBe(t0 + HOUR);
		// The second start is now the oldest one in the window.
		await l.acquire({ item: 5, total: 5 });
		expect(c.sleeps).toEqual([HOUR - 3_000, 1_000]);
	});

	test("delay is counted from the worker's previous finish", async () => {
		const c = fakeClock();
		const l = limiter({ delay: 5 }, c.clock);
		await l.acquire({ item: 1, total: 2 });
		const finished = c.now();
		c.advance(2_000);
		await l.acquire({ item: 2, total: 2, previousFinishedAt: finished });
		expect(c.sleeps).toEqual([3_000]);
	});

	test("the later of delay and spread wins", async () => {
		const c = fakeClock();
		const l = limiter({ delay: 60, perHour: 120 }, c.clock);
		await l.acquire({ item: 1, total: 2 });
		const finished = c.now();
		await l.acquire({ item: 2, total: 2, previousFinishedAt: finished });
		expect(c.sleeps).toEqual([60_000]);
		expect(l.budget).toEqual({ window: 30_000, cap: 1 });
	});

	test("spread with workers fires a batch together at the same hourly rate", async () => {
		const c = fakeClock();
		const l = limiter({ perHour: 120, parallel: 3 }, c.clock);
		expect(l.budget).toEqual({ window: 90_000, cap: 3 });
		for (let i = 1; i <= 3; i++) await l.acquire({ item: i, total: 6 });
		expect(c.sleeps).toEqual([]);
		c.advance(10_000);
		await l.acquire({ item: 4, total: 6 });
		expect(c.sleeps).toEqual([80_000]);
		await l.acquire({ item: 5, total: 6 });
		await l.acquire({ item: 6, total: 6 });
		expect(c.sleeps).toEqual([80_000]);
		expect(l.estimate(6, 3)).toBe(90_000);
		expect(l.estimate(7, 3)).toBe(180_000);
	});

	test("an abort during the wait rejects with an AbortError", async () => {
		const c = fakeClock();
		const l = limiter({ perHour: 60 }, c.clock);
		await l.acquire({ item: 1, total: 2 });
		const controller = new AbortController();
		controller.abort();
		let caught: unknown;
		try {
			await l.acquire({ item: 2, total: 2, signal: controller.signal });
		} catch (err) {
			caught = err;
		}
		expect(isAbortError(caught)).toBe(true);
	});

	test("estimate is a lower bound for the waits", () => {
		const c = fakeClock();
		expect(limiter({ perHour: 120 }, c.clock).estimate(901)).toBe(900 * 30_000);
		expect(
			limiter({ perHour: 100, pacing: "eager" }, c.clock).estimate(250),
		).toBe(2 * HOUR);
		expect(limiter({ delay: 10 }, c.clock).estimate(11, 2)).toBe(50_000);
		expect(limiter({ delay: 60, perHour: 120 }, c.clock).estimate(3)).toBe(
			120_000,
		);
		expect(limiter({ perHour: 120 }, c.clock).estimate(1)).toBeNull();
	});

	test("describe summarises the limits", () => {
		const c = fakeClock();
		expect(limiter({ delay: 5, perHour: 120 }, c.clock).describe(1)).toBe(
			"120 items/hour (spread), 5 s between items, 1 at a time",
		);
		expect(limiter({}, c.clock).describe(2)).toBe(
			"no hourly limit, no pause between items, 2 at a time",
		);
	});
});
