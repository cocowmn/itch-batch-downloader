import { isAbortError } from "./abort.ts";
import { log } from "./log.ts";

/**
 * Run `fn` up to `attempts` times. Mirrors the original "Retry x of 3 ...
 * Cannot recover from connection error" behaviour, but throws instead of
 * exiting so callers decide what to do. An abort is not retried.
 */
export async function withRetries<T>(
	what: string,
	fn: () => Promise<T>,
	attempts = 3,
): Promise<T> {
	let lastErr: unknown;
	for (let i = 1; i <= attempts; i++) {
		try {
			return await fn();
		} catch (err) {
			if (isAbortError(err)) throw err;
			lastErr = err;
			log.error(`${what}: connection error. Retry ${i} of ${attempts}`, err);
		}
	}
	throw new Error(`Cannot recover from connection error (${what})`, {
		cause: lastErr,
	});
}
