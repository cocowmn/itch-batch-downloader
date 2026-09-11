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
