import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/features/config/config.ts";
import { FetchJobs, JobError } from "../src/www/server/jobs.ts";

async function withLibrary(fn: (root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "itch-jobs-"));
	try {
		await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const manifest = (urls: Record<string, string>) =>
	JSON.stringify({
		manifestVersion: 1,
		title: "Pack",
		author: { slug: "a", name: "A", url: "https://a.itch.io" },
		urls,
		bundles: [],
		info: {},
		tags: [],
	});

describe("fetch jobs", () => {
	test("refuses items it cannot fetch, before touching the network", async () => {
		await withLibrary(async (root) => {
			const jobs = new FetchJobs(
				{ ...DEFAULTS, cookie_file: join(root, "missing-cookies.txt") },
				root,
			);
			await Bun.write(join(root, "bare", "file.zip"), "x");
			await Bun.write(
				join(root, "no-keys", "no-keys_manifest.json"),
				manifest({ page: "https://a.itch.io/pack" }),
			);
			await Bun.write(
				join(root, "ok", "ok_manifest.json"),
				manifest({
					page: "https://a.itch.io/pack",
					downloadPage: "https://a.itch.io/pack/download/KEY",
				}),
			);

			const status = async (dir: string) =>
				jobs.start([dir]).then(
					() => 0,
					(err: unknown) => (err instanceof JobError ? err.status : -1),
				);
			expect(await status("bare")).toBe(400);
			expect(await status("no-keys")).toBe(400);
			// fetchable, but the server has no cookies to do it with
			expect(await status("ok")).toBe(400);
			expect(jobs.currentStatus()).toBeNull();
			// a selection is refused as a whole when one item cannot be fetched
			await expect(jobs.start(["ok", "no-keys"])).rejects.toMatchObject({
				status: 400,
				message: expect.stringContaining("(no-keys)"),
			});
			await expect(jobs.start([])).rejects.toMatchObject({ status: 400 });
		});
	});

	test("one job at a time; a cancelled job reports so and cleans up", async () => {
		await withLibrary(async (root) => {
			const cookies = join(root, "cookies.txt");
			await Bun.write(cookies, "# empty jar\n");
			const jobs = new FetchJobs(
				{
					...DEFAULTS,
					cookie_file: cookies,
					create_png: false,
					create_pdf: false,
					download_videos: false,
				},
				root,
			);
			await Bun.write(
				join(root, "ok", "ok_manifest.json"),
				manifest({
					page: "https://127.0.0.1:9/pack",
					downloadPage: "https://127.0.0.1:9/pack/download/KEY",
				}),
			);
			const started = await jobs.start(["ok"]);
			expect(started.state).toBe("running");
			expect(jobs.get(started.id)?.title).toBe("Pack");
			expect(started.directories).toEqual(["ok"]);
			await expect(jobs.start(["ok"])).rejects.toBeInstanceOf(JobError);
			await expect(jobs.start(["ok"])).rejects.toMatchObject({ status: 409 });

			expect(await jobs.cancel("nope")).toBe(false);
			expect(await jobs.cancel(started.id)).toBe(true);
			const after = jobs.get(started.id);
			expect(["cancelled", "failed"]).toContain(after?.state ?? "");
			expect(after?.finishedAt).not.toBeNull();
			expect(await jobs.download(started.id)).toBeNull();
			// the slot is free again; a batch is titled by its count
			await Bun.write(
				join(root, "two", "two_manifest.json"),
				manifest({
					page: "https://127.0.0.1:9/two",
					downloadPage: "https://127.0.0.1:9/two/download/KEY2",
				}),
			);
			const next = await jobs.start(["ok", "two"], "my picks");
			expect(next.id).not.toBe(started.id);
			expect(next.title).toBe("2 items");
			expect(next.completed).toBe(0);
			await jobs.shutdown();
		});
	});
});
