import { describe, expect, test } from "bun:test";
import { runPool } from "../src/utils/pool.ts";

describe("runPool", () => {
	test("parallel = 1 runs the items in order, one after the other", async () => {
		const events: string[] = [];
		await runPool(["a", "b", "c"], 1, async (item, index, { lane }) => {
			events.push(`start ${item}${index} lane ${lane}`);
			await Bun.sleep(1);
			events.push(`end ${item}`);
		});
		expect(events).toEqual([
			"start a0 lane 0",
			"end a",
			"start b1 lane 0",
			"end b",
			"start c2 lane 0",
			"end c",
		]);
	});

	test("never runs more than `parallel` items at once", async () => {
		let running = 0;
		let peak = 0;
		const lanes = new Set<number>();
		await runPool(
			Array.from({ length: 10 }, (_, i) => i),
			3,
			async (_item, _index, { lane }) => {
				lanes.add(lane);
				running++;
				peak = Math.max(peak, running);
				await Bun.sleep(2);
				running--;
			},
		);
		expect(peak).toBe(3);
		expect([...lanes].sort()).toEqual([0, 1, 2]);
	});

	test("a failure aborts the other workers and rejects with the first error", async () => {
		const aborted: number[] = [];
		const started: number[] = [];
		const promise = runPool(
			[1, 2, 3, 4, 5, 6],
			2,
			async (item, _i, { signal }) => {
				started.push(item);
				if (item === 2) throw new Error("boom");
				await Bun.sleep(5);
				if (signal.aborted) aborted.push(item);
			},
		);
		await expect(promise).rejects.toThrow("boom");
		expect(aborted).toEqual([1]);
		expect(started).toEqual([1, 2]);
	});
});
