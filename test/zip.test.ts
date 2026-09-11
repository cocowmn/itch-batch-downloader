import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import {
	defaultExclude,
	ZIP_LIMIT,
	ZipTooLargeError,
	zipDirectory,
} from "../src/www/server/zip.ts";

async function collect(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

describe("zipDirectory", () => {
	test("round-trips a nested folder, skipping hidden and incomplete files", async () => {
		const root = await mkdtemp(join(tmpdir(), "itch-zip-"));
		try {
			const dir = join(root, "my-item");
			await Bun.write(join(dir, "readme.txt"), "hello ".repeat(1000));
			await Bun.write(join(dir, "pack", "art", "a.png"), "PNG-bytes");
			await Bun.write(join(dir, "pack", "b.zip"), "already zipped");
			await Bun.write(join(dir, "big.zip.incomplete"), "partial");
			await Bun.write(join(dir, ".itchio"), "{}");
			await mkdir(join(dir, "empty"));

			const bytes = await collect(await zipDirectory(dir));
			const files = unzipSync(bytes);
			expect(Object.keys(files).sort()).toEqual([
				"my-item/empty/",
				"my-item/pack/",
				"my-item/pack/art/",
				"my-item/pack/art/a.png",
				"my-item/pack/b.zip",
				"my-item/readme.txt",
			]);
			expect(new TextDecoder().decode(files["my-item/readme.txt"])).toBe(
				"hello ".repeat(1000),
			);
			expect(new TextDecoder().decode(files["my-item/pack/art/a.png"])).toBe(
				"PNG-bytes",
			);
			// text is deflated, the zip inside is stored: the archive is smaller
			// than its content but not by much more than the text allows
			expect(bytes.length).toBeLessThan(6000);

			const custom = unzipSync(
				await collect(
					await zipDirectory(dir, {
						rootName: "renamed",
						exclude: (n) => defaultExclude(n) || n.endsWith(".txt"),
					}),
				),
			);
			expect(Object.keys(custom)).not.toContain("renamed/readme.txt");
			expect(Object.keys(custom)).toContain("renamed/pack/b.zip");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an override replaces a file's bytes in the archive", async () => {
		const root = await mkdtemp(join(tmpdir(), "itch-zip-"));
		try {
			const dir = join(root, "item");
			await Bun.write(join(dir, "secret.json"), '{"key":"SECRET"}');
			await Bun.write(join(dir, "plain.txt"), "keep");
			const files = unzipSync(
				await collect(
					await zipDirectory(dir, {
						override: async (path) =>
							path.endsWith("secret.json")
								? new TextEncoder().encode('{"key":null}')
								: null,
					}),
				),
			);
			expect(new TextDecoder().decode(files["item/secret.json"])).toBe(
				'{"key":null}',
			);
			expect(new TextDecoder().decode(files["item/plain.txt"])).toBe("keep");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("refuses folders over the 32-bit limit before streaming", async () => {
		const root = await mkdtemp(join(tmpdir(), "itch-zip-"));
		try {
			// a sparse file costs no disk space but reports its full size
			const big = join(root, "item", "huge.bin");
			await mkdir(join(root, "item"));
			const proc = Bun.spawn(["truncate", "-s", String(ZIP_LIMIT + 1), big]);
			await proc.exited;
			await expect(zipDirectory(join(root, "item"))).rejects.toBeInstanceOf(
				ZipTooLargeError,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("cancelling the stream stops reading", async () => {
		const root = await mkdtemp(join(tmpdir(), "itch-zip-"));
		try {
			const dir = join(root, "item");
			await Bun.write(join(dir, "a.bin"), new Uint8Array(8 * 1024 * 1024));
			await Bun.write(join(dir, "b.bin"), new Uint8Array(8 * 1024 * 1024));
			const stream = await zipDirectory(dir);
			const reader = stream.getReader();
			const first = await reader.read();
			expect(first.done).toBe(false);
			await reader.cancel();
			// nothing more arrives and nothing throws
			const after = await reader.read();
			expect(after.done).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
