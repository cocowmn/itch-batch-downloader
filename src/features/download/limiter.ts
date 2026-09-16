// Item-level rate limiting of a run: a pause after each item, and an hourly
// budget that is either spread evenly over the hour or spent as fast as
// possible ("eager") before waiting for the rolling window to free up.
//
// Both pacings are the same rule - "at most `cap` starts in any window of
// `window` ms" - with different numbers: eager allows `perHour` starts per
// hour, spread allows `parallel` starts per `parallel * 3600 / perHour`
// seconds, so that with one worker items are evenly spaced and with several
// a full batch fires together, at the same hourly rate. The clock is
// injectable so the arithmetic can be tested without waiting.

import type { DownloadPacing } from "../../models/config.ts";
import { sleep } from "../../utils/abort.ts";
import { log } from "../../utils/log.ts";
import { formatDuration, timestamp } from "../../utils/time.ts";

export interface RateLimits {
	/** Seconds to pause after an item finishes before the same worker starts the next. */
	delay: number;
	/** Max items started per rolling hour; 0 = unlimited. */
	perHour: number;
	pacing: DownloadPacing;
	/** Workers processing items at the same time (the batch size of "spread"). */
	parallel?: number;
}

export interface Clock {
	now(): number;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface AcquireOptions {
	/** 1-based number of the item about to start, and the size of the run (for the log). */
	item: number;
	total: number;
	/** When the calling worker finished its previous item (`Date.now()`), if any. */
	previousFinishedAt?: number;
	signal?: AbortSignal;
}

const HOUR = 3_600_000;
/** Waits shorter than this are silent. */
const LOG_THRESHOLD = 1000;

export class RateLimiter {
	/** Start times (ms) of the items started within the current window. */
	private starts: number[] = [];
	/** The hourly budget as "at most `cap` starts per `window` ms"; null = unlimited. */
	readonly budget: { window: number; cap: number } | null;

	constructor(
		readonly limits: RateLimits,
		private readonly clock: Clock = { now: Date.now, sleep },
	) {
		const { perHour, pacing } = limits;
		const parallel = Math.max(1, limits.parallel ?? 1);
		if (perHour <= 0) this.budget = null;
		else if (pacing === "eager") this.budget = { window: HOUR, cap: perHour };
		else this.budget = { window: (HOUR / perHour) * parallel, cap: parallel };
	}

	/** Resolves when the next item may start and records that start. */
	async acquire(opts: AcquireOptions): Promise<void> {
		const { delay, pacing } = this.limits;
		const now = this.clock.now();
		let at = now;
		let reason: "delay" | "spread" | "eager" | null = null;
		const later = (t: number, why: typeof reason) => {
			if (t > at) {
				at = t;
				reason = why;
			}
		};

		if (delay > 0 && opts.previousFinishedAt !== undefined)
			later(opts.previousFinishedAt + delay * 1000, "delay");
		if (this.budget) {
			const { window, cap } = this.budget;
			this.starts = this.starts.filter((t) => t > now - window);
			if (this.starts.length >= cap)
				later((this.starts[0] as number) + window, pacing);
		}

		const wait = at - now;
		if (wait >= LOG_THRESHOLD) {
			this.announce(wait, at, reason, opts);
			await this.clock.sleep(wait, opts.signal);
		} else if (wait > 0) {
			await this.clock.sleep(wait, opts.signal);
		}

		if (this.budget) this.starts.push(Math.max(this.clock.now(), at));
	}

	private announce(
		wait: number,
		at: number,
		reason: "delay" | "spread" | "eager" | null,
		opts: AcquireOptions,
	): void {
		const { delay, perHour } = this.limits;
		const which = `item ${opts.item} of ${opts.total}`;
		switch (reason) {
			case "eager":
				log.info(
					`Hourly budget of ${perHour} items used; waiting until ${timestamp(new Date(at)).slice(11)} (${formatDuration(wait)}) before ${which}`,
				);
				return;
			case "spread":
				log.info(
					`Waiting ${formatDuration(wait)} before ${which} (downloads_per_hour = ${perHour}, spread)`,
				);
				return;
			default:
				log.info(
					`Waiting ${formatDuration(wait)} before ${which} (download_delay = ${delay} s)`,
				);
		}
	}

	/**
	 * Lower bound in milliseconds for starting `n` more items with `parallel`
	 * workers, counting only the waits (not the downloads themselves). Null
	 * when no limit applies.
	 */
	estimate(n: number, parallel = 1): number | null {
		const { delay } = this.limits;
		if (n <= 1) return null;
		const fromDelay = ((n - 1) * delay * 1000) / Math.max(1, parallel);
		const fromBudget = this.budget
			? (Math.ceil(n / this.budget.cap) - 1) * this.budget.window
			: 0;
		const total = Math.max(fromDelay, fromBudget);
		return total > 0 ? total : null;
	}

	/** One-line summary of the limits for the run log. */
	describe(parallel = 1): string {
		const { delay, perHour, pacing } = this.limits;
		const budget =
			perHour > 0 ? `${perHour} items/hour (${pacing})` : "no hourly limit";
		const pause =
			delay > 0 ? `${delay} s between items` : "no pause between items";
		return `${budget}, ${pause}, ${parallel} at a time`;
	}
}
