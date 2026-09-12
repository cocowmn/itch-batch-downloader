import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import {
	cleanArchiveName,
	defaultArchiveName,
	defaultExclude,
	zipDirectories,
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

	test("several directories become folders under one root, base names deduplicated", async () => {
		const root = await mkdtemp(join(tmpdir(), "itch-zip-"));
		try {
			await Bun.write(join(root, "one", "a.txt"), "A");
			await Bun.write(join(root, "nested", "pack", "b.txt"), "B");
			await Bun.write(join(root, "other", "pack", "c.txt"), "C");
			await mkdir(join(root, "bare"));
			const files = unzipSync(
				await collect(
					await zipDirectories(
						[
							join(root, "one"),
							join(root, "nested", "pack"),
							join(root, "other", "pack"),
							join(root, "bare"),
							join(root, "missing"),
						],
						{ rootName: "picks" },
					),
				),
			);
			expect(Object.keys(files).sort()).toEqual([
				"picks/bare/",
				"picks/one/",
				"picks/one/a.txt",
				"picks/pack (2)/",
				"picks/pack (2)/c.txt",
				"picks/pack/",
				"picks/pack/b.txt",
			]);
			expect(new TextDecoder().decode(files["picks/pack (2)/c.txt"])).toBe("C");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("small archives stay classic 32-bit zips", async () => {
		const root = await mkdtemp(join(tmpdir(), "itch-zip-"));
		try {
			await Bun.write(join(root, "item", "a.txt"), "aaa");
			const bytes = await collect(await zipDirectory(join(root, "item")));
			// no Zip64 end-of-central-directory record (PK\x06\x06)
			expect(
				Buffer.from(bytes).indexOf(Buffer.from("PK\x06\x06", "latin1")),
			).toBe(-1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an entry over 4 GiB is written with Zip64 records", async () => {
		// A sparse file costs no disk space but streams its full size: stored,
		// so the zip is a little over 4 GiB and can be checked without
		// materialising it (the test counts bytes and keeps the tail).
		const root = await mkdtemp(join(tmpdir(), "itch-zip-"));
		try {
			const size = 4 * 1024 ** 3 + 1024;
			await mkdir(join(root, "item"));
			const proc = Bun.spawn([
				"truncate",
				"-s",
				String(size),
				join(root, "item", "huge.zip"),
			]);
			await proc.exited;
			let total = 0;
			let tail = new Uint8Array(0);
			for await (const chunk of await zipDirectory(join(root, "item"))) {
				total += chunk.length;
				const joined = new Uint8Array(tail.length + chunk.length);
				joined.set(tail);
				joined.set(chunk, tail.length);
				tail = joined.subarray(Math.max(0, joined.length - 4096));
			}
			expect(total).toBeGreaterThan(size);
			const buf = Buffer.from(tail);
			// Zip64 end of central directory record + locator, then the
			// classic EOCD with 0xffffffff placeholders.
			expect(buf.indexOf(Buffer.from("PK\x06\x06", "latin1"))).not.toBe(-1);
			expect(buf.indexOf(Buffer.from("PK\x06\x07", "latin1"))).not.toBe(-1);
			const eocd = buf.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
			expect(eocd).not.toBe(-1);
			expect(buf.readUInt32LE(eocd + 16)).toBe(0xffffffff);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 120_000);

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

describe("archive names", () => {
	test("the default carries the date", () => {
		expect(defaultArchiveName()).toMatch(
			/^\d{4}-\d{2}-\d{2}--itch\.io-downloads$/,
		);
	});

	test("user names are made safe for a file name", () => {
		expect(cleanArchiveName("my picks")).toBe("my picks");
		expect(cleanArchiveName("  my picks.zip ")).toBe("my picks");
		expect(cleanArchiveName("a/b\\c:d")).toBe("a-b-c-d");
		expect(cleanArchiveName("..hidden..")).toBe("hidden");
		expect(cleanArchiveName("x".repeat(200))).toHaveLength(120);
		expect(cleanArchiveName("")).toBe(defaultArchiveName());
		expect(cleanArchiveName("   ")).toBe(defaultArchiveName());
		expect(cleanArchiveName(null)).toBe(defaultArchiveName());
		expect(cleanArchiveName(".zip")).toBe(defaultArchiveName());
	});
});
