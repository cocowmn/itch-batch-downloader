import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LibraryFile, LibraryItem } from "../src/models/library.ts";
import { fuzzyScore, matchQuery, queryTerms } from "../src/www/client/fuzzy.ts";
import {
	highlightJson,
	renderMarkdown,
	viewerMode,
} from "../src/www/client/text.ts";
import {
	captureDate,
	fileKind,
	fileRole,
	groupCaptures,
	scanItemTree,
	scanLibrary,
	titleFromDirectory,
} from "../src/www/server/library.ts";
import {
	isLoopback,
	parseDirectory,
	redactedManifestBytes,
	redactItem,
	resolveFilePath,
	resolvePath,
} from "../src/www/server/server.ts";

describe("fuzzy", () => {
	test("substring beats subsequence beats miss", () => {
		const sub = fuzzyScore("boss", "the dark series - lord of flames boss");
		const seq = fuzzyScore("bss", "brawlers sprite sheet");
		expect(sub).toBeGreaterThan(seq);
		expect(seq).toBeGreaterThan(0);
		expect(fuzzyScore("xyz", "brawlers")).toBe(0);
	});

	test("word-start matches rank above mid-word ones", () => {
		expect(fuzzyScore("pack", "character pack")).toBeGreaterThan(
			fuzzyScore("pack", "backpacker"),
		);
	});

	test("quoted phrases are one term", () => {
		expect(queryTerms('"The DARK Series" boss')).toEqual([
			{ text: "The DARK Series", exact: true },
			{ text: "boss", exact: false },
		]);
		expect(queryTerms('pixel "unterminated phrase')).toEqual([
			{ text: "pixel", exact: false },
			{ text: "unterminated phrase", exact: true },
		]);
		expect(queryTerms('""  ')).toEqual([]);
		const fields = [{ text: "The DARK Series - Lord of Flames", weight: 1 }];
		expect(matchQuery('"The DARK Series"', fields)).toBeGreaterThan(0);
		expect(matchQuery('"Series DARK"', fields)).toBe(0);
		// quoted = verbatim only; the in-order-letters fallback is off
		expect(matchQuery("tdks", fields)).toBeGreaterThan(0);
		expect(matchQuery('"tdks"', fields)).toBe(0);
		// unquoted, the words match independently
		expect(matchQuery("Series DARK", fields)).toBeGreaterThan(0);
	});

	test("case sensitivity is opt-in", () => {
		const fields = [{ text: "The DARK Series", weight: 1 }];
		expect(matchQuery("dark", fields)).toBeGreaterThan(0);
		expect(matchQuery("dark", fields, { caseSensitive: true })).toBe(0);
		expect(matchQuery("DARK", fields, { caseSensitive: true })).toBeGreaterThan(
			0,
		);
	});

	test("every word of the query must match a field", () => {
		const fields = [
			{ text: "Brawler Character Pack 1", weight: 1 },
			{ text: "Penusbmic", weight: 0.9 },
		];
		expect(matchQuery("brawler penus", fields)).toBeGreaterThan(0);
		expect(matchQuery("brawler zelda", fields)).toBe(0);
		expect(matchQuery("   ", fields)).toBe(1);
	});
});

describe("library scan", () => {
	test("classifies files by the downloader's naming", () => {
		expect(fileRole("x_manifest.json", "x")).toBe("manifest");
		expect(fileRole("x_cover-artwork.gif", "x")).toBe("cover");
		expect(fileRole("x_webpage_screenshot_20260910.png", "x")).toBe(
			"screenshot",
		);
		expect(fileRole("x_webpage_screenshot_20260910.pdf", "x")).toBe("pdf");
		expect(fileRole("x_dQw4w9WgXcQ.mp4", "x")).toBe("video");
		expect(fileRole("1_pack_20240101.zip_20240102030405.old", "x")).toBe("old");
		expect(fileRole("pack.zip.incomplete", "x")).toBe("incomplete");
		expect(fileRole("pack.zip", "x")).toBe("download");
		expect(fileKind("pack.7Z")).toBe("archive");
		expect(fileKind("notes")).toBe("other");
		expect(titleFromDirectory("sci-fi_character-pack")).toBe(
			"Sci Fi Character Pack",
		);
	});

	test("reads manifests and falls back to directory names", async () => {
		const root = await mkdtemp(join(tmpdir(), "itch-browse-"));
		try {
			await mkdir(join(root, "with-manifest", "unpacked"), {
				recursive: true,
			});
			await Bun.write(
				join(root, "with-manifest", "with-manifest_manifest.json"),
				JSON.stringify({
					title: "Proper Title",
					author: { slug: "a", name: "Author A", url: "https://a.itch.io" },
					tags: ["2D"],
					info: {},
					bundles: [],
				}),
			);
			await Bun.write(
				join(root, "with-manifest", "with-manifest_cover-artwork.png"),
				"png",
			);
			await Bun.write(
				join(
					root,
					"with-manifest",
					"with-manifest_webpage_screenshot_20260101.png",
				),
				"a",
			);
			await Bun.write(
				join(
					root,
					"with-manifest",
					"with-manifest_webpage_screenshot_20260910.png",
				),
				"b",
			);
			await Bun.write(join(root, "with-manifest", "unpacked", "x.txt"), "1234");
			await Bun.write(join(root, "with-manifest", ".DS_Store"), "junk");
			await Bun.write(join(root, "with-manifest", "Thumbs.db"), "junk");
			await Bun.write(
				join(root, "with-manifest", "unpacked", "._x.txt"),
				"junk",
			);
			await Bun.write(
				join(root, "with-manifest", "unpacked", "__MACOSX", "x"),
				"junk",
			);
			await mkdir(join(root, "bare-item"));
			await Bun.write(join(root, "bare-item", "1_pack_20240101.zip"), "zip!");
			await Bun.write(join(root, "stray-file.txt"), "ignored");

			const lib = await scanLibrary(root);
			expect(lib.totals.items).toBe(2);
			expect(lib.totals.withManifest).toBe(1);
			expect(lib.totals.withCover).toBe(1);

			const [bare, full] = lib.items;
			expect(full?.title).toBe("Proper Title");
			expect(full?.author?.name).toBe("Author A");
			expect(full?.cover).toBe(
				"/files/with-manifest/with-manifest_cover-artwork.png",
			);
			// captures are grouped by date, newest first
			expect(full?.captures.map((c) => c.date)).toEqual([
				"2026-09-10",
				"2026-01-01",
			]);
			expect(full?.captures[0]?.png?.url).toContain("20260910");
			expect(full?.captures[0]?.pdf).toBeNull();
			expect(full?.files.map((f) => f.name)).not.toContain(".DS_Store");
			expect(full?.files.map((f) => f.name)).not.toContain("Thumbs.db");
			const folder = full?.files.find((f) => f.name === "unpacked");
			expect(folder?.kind).toBe("folder");
			expect(folder?.size).toBe(4);
			const tree = await scanItemTree(root, "with-manifest");
			expect(
				tree.files
					.find((f) => f.name === "unpacked")
					?.children?.map((f) => f.name),
			).toEqual(["x.txt"]);
			expect(folder?.url).toBeNull();

			expect(bare?.title).toBe("Bare Item");
			expect(bare?.hasManifest).toBe(false);
			expect(bare?.author).toBeNull();
			expect(bare?.downloadCount).toBe(1);
			expect(bare?.size).toBe(4);
			expect(bare?.hidden).toBe(false);
			expect(full?.hidden).toBe(false);

			// the hidden flag comes from the marker, even a flag-only one on a
			// legacy item
			await Bun.write(
				join(root, "with-manifest", ".itchio"),
				JSON.stringify({ title: "M", slug: "m", hidden: true }),
			);
			await Bun.write(
				join(root, "bare-item", ".itchio"),
				JSON.stringify({ hidden: true }),
			);
			const flagged = await scanLibrary(root);
			expect(flagged.items.map((i) => i.hidden)).toEqual([true, true]);
			expect(flagged.items[0]?.title).toBe("Bare Item");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("captures", () => {
	const file = (name: string, role: "screenshot" | "pdf") => ({
		name,
		path: name,
		size: 1,
		modified: "",
		kind: "image" as const,
		role,
		url: `/files/x/${name}`,
	});

	test("date stamp parsing", () => {
		expect(captureDate("x_webpage_screenshot_20260910.png")).toBe("2026-09-10");
		expect(captureDate("x_webpage_screenshot_20260910.PDF")).toBe("2026-09-10");
		expect(captureDate("x_webpage_screenshot_.png")).toBe("");
		expect(captureDate("x.png")).toBe("");
	});

	test("png and pdf of one day form a pair, newest first", () => {
		const groups = groupCaptures([
			file("x_webpage_screenshot_20260101.png", "screenshot"),
			file("x_webpage_screenshot_20260910.pdf", "pdf"),
			file("x_webpage_screenshot_20260910.png", "screenshot"),
			file("x_webpage_screenshot_20250505.pdf", "pdf"),
		]);
		expect(groups.map((g) => g.date)).toEqual([
			"2026-09-10",
			"2026-01-01",
			"2025-05-05",
		]);
		expect(groups[0]?.png?.name).toContain("20260910.png");
		expect(groups[0]?.pdf?.name).toContain("20260910.pdf");
		expect(groups[1]?.pdf).toBeNull();
		expect(groups[2]?.png).toBeNull();
	});
});

describe("item tree", () => {
	test("nested folders carry children, paths and summed sizes", async () => {
		const root = await mkdtemp(join(tmpdir(), "itch-tree-"));
		try {
			await Bun.write(join(root, "item", "top.zip"), "12345");
			await Bun.write(join(root, "item", "pack", "a.png"), "aa");
			await Bun.write(join(root, "item", "pack", "deep", "b.txt"), "bbb");
			await Bun.write(join(root, "item", "pack", ".hidden"), "x");
			await mkdir(join(root, "item", "empty"));

			const tree = await scanItemTree(root, "item");
			expect(tree.truncated).toBe(false);
			expect(tree.files.map((f) => f.path)).toEqual([
				"empty",
				"pack",
				"top.zip",
			]);
			const pack = tree.files[1]!;
			expect(pack.kind).toBe("folder");
			expect(pack.size).toBe(5);
			expect(pack.children?.map((f) => f.path)).toEqual([
				"pack/a.png",
				"pack/deep",
			]);
			const deep = pack.children?.[1];
			expect(deep?.children?.[0]?.path).toBe("pack/deep/b.txt");
			expect(deep?.children?.[0]?.url).toBe("/files/item/pack/deep/b.txt");
			expect(deep?.children?.[0]?.role).toBe("download");
			expect(tree.files[0]?.children).toEqual([]);

			// the library listing has the same top level without the nesting
			const lib = await scanLibrary(root);
			const item = lib.items[0]!;
			expect(item.files.map((f) => f.name)).toEqual([
				"empty",
				"pack",
				"top.zip",
			]);
			expect(item.files[1]?.children).toBeUndefined();
			expect(item.files[1]?.size).toBe(5);
			expect(item.size).toBe(10);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("file routes", () => {
	const root = "/srv/downloads";

	test("resolves item files inside the root", () => {
		expect(resolveFilePath(root, "/files/brawlpack/Brawlers.zip")).toBe(
			join(root, "brawlpack", "Brawlers.zip"),
		);
		expect(resolveFilePath(root, "/files/a/b/c%20d.png")).toBe(
			join(root, "a", "b", "c d.png"),
		);
	});

	test("rejects traversal and bare directories", () => {
		expect(resolveFilePath(root, "/files/../cookies.txt")).toBeNull();
		expect(resolveFilePath(root, "/files/a/..%2F..%2Fcookies.txt")).toBeNull();
		expect(resolveFilePath(root, "/files/a/%2e%2e/x")).toBeNull();
		expect(resolveFilePath(root, "/files/brawlpack")).toBeNull();
		// reveal may target the item directory itself, but never the root
		expect(resolveFilePath(root, "/files/brawlpack", true)).toBe(
			join(root, "brawlpack"),
		);
		expect(resolveFilePath(root, "/files/", true)).toBeNull();
		expect(resolveFilePath(root, "/files/..", true)).toBeNull();
		expect(resolveFilePath(root, "/files/a//b")).toBeNull();
		expect(resolveFilePath(root, "/files/a/%ZZ")).toBeNull();
	});

	test("directories from a request body are checked the same way", () => {
		expect(parseDirectory("brawlpack")).toEqual(["brawlpack"]);
		expect(parseDirectory("by author/100% pack")).toEqual([
			"by author",
			"100% pack",
		]);
		expect(parseDirectory("")).toBeNull();
		expect(parseDirectory("a//b")).toBeNull();
		expect(parseDirectory("../cookies.txt")).toBeNull();
		expect(parseDirectory("a/./b")).toBeNull();
		expect(parseDirectory("a\0b")).toBeNull();
		expect(parseDirectory("a", 2)).toBeNull();
		expect(resolvePath(root, ["by author", "100% pack"])).toBe(
			join(root, "by author", "100% pack"),
		);
		expect(resolvePath(root, ["..", "x"])).toBeNull();
	});
});

describe("network exposure", () => {
	test("loopback addresses", () => {
		expect(isLoopback("127.0.0.1")).toBe(true);
		expect(isLoopback("::1")).toBe(true);
		expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopback("192.168.1.20")).toBe(false);
		expect(isLoopback(undefined)).toBe(false);
	});

	test("library items are sent without keys", () => {
		const item: LibraryItem = {
			directory: "pack",
			title: "Pack",
			author: null,
			urls: {
				page: "https://a.itch.io/pack",
				downloadPage: "https://a.itch.io/pack/download/SECRET",
			},
			itchId: 1,
			description: null,
			info: {},
			tags: [],
			bundles: [{ name: "B", key: "KEY", url: "https://itch.io/b/KEY" }],
			hasManifest: true,
			fetchable: true,
			cover: null,
			captures: [],
			hidden: false,
			files: [
				{
					name: "pack_manifest.json",
					path: "pack_manifest.json",
					size: 1,
					modified: "",
					kind: "code",
					role: "manifest",
					url: "/files/pack/pack_manifest.json",
				},
				{
					name: "pack.zip",
					path: "pack.zip",
					size: 1,
					modified: "",
					kind: "archive",
					role: "download",
					url: "/files/pack/pack.zip",
				},
			],
			downloadCount: 1,
			size: 2,
			modified: "",
		};
		const safe = redactItem(item);
		expect(safe.urls).toEqual({ page: "https://a.itch.io/pack" });
		expect(safe.fetchable).toBe(true);
		expect(safe.bundles).toEqual([{ name: "B" }]);
		// the manifest stays listed: it is served redacted, not hidden
		expect(safe.files.map((f) => f.name)).toEqual([
			"pack_manifest.json",
			"pack.zip",
		]);
		expect(JSON.stringify(safe)).not.toContain("SECRET");
		expect(JSON.stringify(safe)).not.toContain("KEY");
		// the original is untouched
		expect(item.urls?.downloadPage).toContain("SECRET");
	});
});

describe("served manifests", () => {
	test("keys are stripped, the rest is kept, garbage is refused", async () => {
		const root = await mkdtemp(join(tmpdir(), "itch-manifest-"));
		try {
			const path = join(root, "pack_manifest.json");
			await Bun.write(
				path,
				JSON.stringify({
					manifestVersion: 1,
					title: "Pack",
					urls: {
						page: "https://a.itch.io/pack",
						downloadPage: "https://a.itch.io/pack/download/SECRET",
					},
					downloadKey: "SECRET",
					bundles: [{ name: "B", key: "KEY", url: "https://itch.io/b/KEY" }],
					tags: ["2D"],
					// an older manifest may list system files: not any more
					files: [".DS_Store", "pack.zip", "Thumbs.db"],
				}),
			);
			const text = new TextDecoder().decode(
				(await redactedManifestBytes(path)) ?? new Uint8Array(),
			);
			expect(text).not.toContain("SECRET");
			expect(text).not.toContain("KEY");
			expect(text).not.toContain("downloadKey");
			const parsed = JSON.parse(text);
			expect(parsed.title).toBe("Pack");
			expect(parsed.urls).toEqual({ page: "https://a.itch.io/pack" });
			expect(parsed.bundles).toEqual([{ name: "B" }]);
			expect(parsed.tags).toEqual(["2D"]);
			expect(parsed.files).toEqual(["pack.zip"]);
			expect(text.endsWith("}\n")).toBe(true);

			await Bun.write(path, "not json {");
			expect(await redactedManifestBytes(path)).toBeNull();
			expect(
				await redactedManifestBytes(join(root, "missing.json")),
			).toBeNull();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("viewer", () => {
	const file = (
		name: string,
		extra: Partial<LibraryFile> = {},
	): LibraryFile => ({
		name,
		path: name,
		size: 10,
		modified: "",
		kind: "other",
		role: "download",
		url: `/files/x/${name}`,
		...extra,
	});

	test("picks a mode by extension, falling back to the file card", () => {
		expect(viewerMode(file("a.PNG"))).toBe("image");
		expect(viewerMode(file("a.json"))).toBe("json");
		expect(viewerMode(file("a.md"))).toBe("markdown");
		expect(viewerMode(file("a.txt"))).toBe("text");
		expect(viewerMode(file("a.lua", { kind: "code" }))).toBe("text");
		expect(viewerMode(file("a.pdf"))).toBe("pdf");
		expect(viewerMode(file("a.mp4"))).toBe("video");
		expect(viewerMode(file("a.ogg"))).toBe("audio");
		expect(viewerMode(file("a.aseprite", { kind: "image" }))).toBe("card");
		expect(viewerMode(file("a.zip"))).toBe("card");
		expect(viewerMode(file("a.txt", { size: 5e6 }))).toBe("card");
		expect(viewerMode(file("dir", { kind: "folder", url: null }))).toBe("card");
	});

	test("json highlighting escapes and classifies tokens", () => {
		const html = highlightJson(
			'{\n  "a<b": "x&y",\n  "n": -1.5e3,\n  "t": true\n}',
		);
		expect(html).toContain('<span class="j-key">&quot;a&lt;b&quot;</span>:');
		expect(html).toContain('<span class="j-str">&quot;x&amp;y&quot;</span>');
		expect(html).toContain('<span class="j-num">-1.5e3</span>');
		expect(html).toContain('<span class="j-lit">true</span>');
		expect(html).not.toContain("<b");
	});

	test("markdown subset renders and raw html is escaped", () => {
		const base = "http://localhost/files/item/docs/README.md";
		const html = renderMarkdown(
			[
				"# Title",
				"",
				"Some **bold**, _it_ and `co<de>` text.",
				"<img src=x onerror=alert(1)>",
				"",
				"- one",
				"- [two](../a.zip)",
				"1. first",
				"",
				"> quoted",
				"",
				"```",
				"<raw>",
				"```",
				"![pic](../sprites/k.png) [bad](javascript:alert(1))",
			].join("\n"),
			base,
		);
		expect(html).toContain("<h1>Title</h1>");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>it</em>");
		expect(html).toContain("<code>co&lt;de&gt;</code>");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).not.toContain("<img src=x");
		expect(html).toContain(
			'<ul><li>one</li><li><a href="http://localhost/files/item/a.zip" target="_blank" rel="noreferrer">two</a></li></ul>',
		);
		expect(html).toContain("<ol><li>first</li></ol>");
		expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
		expect(html).toContain("<pre><code>&lt;raw&gt;</code></pre>");
		expect(html).toContain(
			'<img src="http://localhost/files/item/sprites/k.png" alt="pic"',
		);
		expect(html).not.toContain("javascript:");
		expect(html).toContain("bad");
	});
});
