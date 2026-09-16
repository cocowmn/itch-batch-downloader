/** Whether `err` is the rejection of an aborted request or wait. */
export function isAbortError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"name" in err &&
		(err as { name: unknown }).name === "AbortError"
	);
}

/** Throw the standard AbortError when `signal` has been aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/**
 * Wait `ms` milliseconds; rejects with the standard AbortError as soon as
 * `signal` is aborted (the timer is cleared).
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
