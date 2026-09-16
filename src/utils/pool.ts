// A small worker pool: `parallel` workers pull items from a shared queue in
// order. The first failure aborts the shared signal so the other workers can
// stop early; the pool then rejects with that error once every worker has
// settled. With `parallel = 1` this is a plain sequential loop.

export interface PoolContext {
	/** Which worker (0-based) is processing the item. */
	lane: number;
	/** Aborted as soon as any worker fails. */
	signal: AbortSignal;
}

export type PoolWorker<T> = (
	item: T,
	index: number,
	ctx: PoolContext,
) => Promise<void>;

export async function runPool<T>(
	items: readonly T[],
	parallel: number,
	worker: PoolWorker<T>,
): Promise<void> {
	const controller = new AbortController();
	let next = 0;
	let failure: { error: unknown } | undefined;

	const lane = async (lane: number) => {
		while (!controller.signal.aborted) {
			const index = next++;
			if (index >= items.length) return;
			try {
				await worker(items[index] as T, index, {
					lane,
					signal: controller.signal,
				});
			} catch (err) {
				failure ??= { error: err };
				controller.abort();
				return;
			}
		}
	};

	const lanes = Math.max(1, Math.min(parallel, items.length || 1));
	await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i)));
	if (failure !== undefined) throw (failure as { error: unknown }).error;
}
