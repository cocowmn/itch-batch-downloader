import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { parseFilePath, resolveFilePath } from "../src/www/server/server.ts";
import {
	availableName,
	entrySegments,
	extractZip,
	UnzipError,
} from "../src/www/server/unzip.ts";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "itch-unzip-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function writeZip(
	path: string,
	entries: Record<string, string | null>,
): Promise<void> {
	const data: Parameters<typeof zipSync>[0] = {};
	for (const [name, content] of Object.entries(entries)) {
		// A null entry is a folder; fflate writes it as an empty directory entry.
		data[name] = content === null ? {} : strToU8(content);
	}
	await Bun.write(path, zipSync(data));
}

const listing = async (dir: string) =>
	(await readdir(dir)).filter((n) => !n.startsWith(".")).sort();

describe("availableName", () => {
	test("counts up before a file's extension and after a folder name", async () => {
		await withDir(async (dir) => {
			expect(await availableName(dir, "readme.txt", false)).toBe("readme.txt");
			await Bun.write(join(dir, "readme.txt"), "");
			expect(await availableName(dir, "readme.txt", false)).toBe(
				"readme (1).txt",
			);
			await Bun.write(join(dir, "readme (1).txt"), "");
			await Bun.write(join(dir, "readme (2).txt"), "");
			expect(await availableName(dir, "readme.txt", false)).toBe(
				"readme (3).txt",
			);
			await mkdir(join(dir, "pack.v2"));
			expect(await availableName(dir, "pack.v2", true)).toBe("pack.v2 (1)");
			expect(await availableName(dir, "Makefile", false)).toBe("Makefile");
		});
	});
});

describe("entrySegments", () => {
	test("normalises separators and refuses escapes", () => {
		expect(entrySegments("a/b/c.txt")).toEqual(["a", "b", "c.txt"]);
		expect(entrySegments("a\\b\\c.txt")).toEqual(["a", "b", "c.txt"]);
		expect(entrySegments("/abs/x")).toEqual(["abs", "x"]);
		expect(entrySegments("./a//b/")).toEqual(["a", "b"]);
		expect(entrySegments("../x")).toBeNull();
		expect(entrySegments("a/../../x")).toBeNull();
		expect(entrySegments("a\0b")).toBeNull();
	});
});

describe("extractZip", () => {
	test("wraps several top-level entries in a folder named after the archive", async () => {
		await withDir(async (dir) => {
			await writeZip(join(dir, "pack.zip"), {
				"readme.txt": "hello",
				"art/a.png": "PNG",
				"art/deep/b.png": "PNG2",
				"empty/": null,
			});
			expect(await extractZip(join(dir, "pack.zip"))).toEqual({
				created: "pack",
			});
			expect(await listing(dir)).toEqual(["pack", "pack.zip"]);
			expect(await listing(join(dir, "pack"))).toEqual([
				"art",
				"empty",
				"readme.txt",
			]);
			expect(await Bun.file(join(dir, "pack", "readme.txt")).text()).toBe(
				"hello",
			);
			expect(
				await Bun.file(join(dir, "pack", "art", "deep", "b.png")).text(),
			).toBe("PNG2");
			expect((await stat(join(dir, "pack", "empty"))).isDirectory()).toBe(true);
		});
	});

	test("a single top-level folder or file comes out on its own", async () => {
		await withDir(async (dir) => {
			await writeZip(join(dir, "game-v3.zip"), {
				"game/game.exe": "EXE",
				"game/data/level.dat": "DAT",
				"__MACOSX/game/._game.exe": "junk",
			});
			expect(await extractZip(join(dir, "game-v3.zip"))).toEqual({
				created: "game",
			});
			expect(await listing(dir)).toEqual(["game", "game-v3.zip"]);
			expect(await listing(join(dir, "game"))).toEqual(["data", "game.exe"]);

			await writeZip(join(dir, "notes.zip"), { "notes.md": "# hi" });
			expect(await extractZip(join(dir, "notes.zip"))).toEqual({
				created: "notes.md",
			});
			expect(await Bun.file(join(dir, "notes.md")).text()).toBe("# hi");
		});
	});

	test("never overwrites: existing names get (1), (2), ...", async () => {
		await withDir(async (dir) => {
			await writeZip(join(dir, "pack.zip"), { "a.txt": "A", "b.txt": "B" });
			await mkdir(join(dir, "pack"));
			await Bun.write(join(dir, "pack", "keep.txt"), "mine");
			expect(await extractZip(join(dir, "pack.zip"))).toEqual({
				created: "pack (1)",
			});
			expect(await extractZip(join(dir, "pack.zip"))).toEqual({
				created: "pack (2)",
			});
			expect(await listing(join(dir, "pack"))).toEqual(["keep.txt"]);
			expect(await listing(join(dir, "pack (2)"))).toEqual(["a.txt", "b.txt"]);

			await writeZip(join(dir, "solo.zip"), { "readme.txt": "R" });
			await Bun.write(join(dir, "readme.txt"), "original");
			expect(await extractZip(join(dir, "solo.zip"))).toEqual({
				created: "readme (1).txt",
			});
			expect(await Bun.file(join(dir, "readme.txt")).text()).toBe("original");
			expect(await Bun.file(join(dir, "readme (1).txt")).text()).toBe("R");
		});
	});

	test("streams an archive larger than one chunk", async () => {
		await withDir(async (dir) => {
			const big = "x".repeat(3 * 1024 * 1024);
			const noise = Array.from({ length: 512 * 1024 }, (_, i) =>
				String.fromCharCode(97 + ((i * 7919) % 26)),
			).join("");
			await writeZip(join(dir, "big.zip"), { "big.txt": big, "n.txt": noise });
			await extractZip(join(dir, "big.zip"));
			expect(await Bun.file(join(dir, "big", "big.txt")).text()).toBe(big);
			expect(await Bun.file(join(dir, "big", "n.txt")).text()).toBe(noise);
		});
	});

	test("refuses escapes, garbage and empty archives, leaving nothing behind", async () => {
		await withDir(async (dir) => {
			await writeZip(join(dir, "evil.zip"), { "../escape.txt": "no" });
			await expect(extractZip(join(dir, "evil.zip"))).rejects.toThrow(
				UnzipError,
			);
			await Bun.write(join(dir, "bad.zip"), "this is not a zip file at all");
			await expect(extractZip(join(dir, "bad.zip"))).rejects.toThrow(
				/Not a zip archive, or an empty one/,
			);
			await writeZip(join(dir, "junk.zip"), { "__MACOSX/._x": "junk" });
			await expect(extractZip(join(dir, "junk.zip"))).rejects.toThrow(/empty/);
			await writeZip(join(dir, "empty.zip"), {});
			await expect(extractZip(join(dir, "empty.zip"))).rejects.toThrow(/empty/);
			expect((await readdir(dir)).sort()).toEqual([
				"bad.zip",
				"empty.zip",
				"evil.zip",
				"junk.zip",
			]);
			expect(await readdir(join(dir, ".."))).not.toContain("escape.txt");
		});
	});
});

describe("unzip route paths", () => {
	test("the admin unzip prefix resolves to a file inside the root", () => {
		expect(parseFilePath("/api/admin/unzip/item/pack.zip")).toEqual([
			"item",
			"pack.zip",
		]);
		expect(parseFilePath("/api/admin/unzip/author/item/sub/a%20b.zip")).toEqual(
			["author", "item", "sub", "a b.zip"],
		);
		expect(parseFilePath("/api/admin/unzip/item")).toBeNull();
		expect(resolveFilePath("/root", "/api/admin/unzip/item/../x.zip")).toBe(
			null,
		);
	});
});
