import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/features/config/config.ts";
import {
	selectionFingerprint,
	Tracker,
} from "../src/features/download/tracker.ts";
import { filenameFromResponse } from "../src/features/download/transfer.ts";
import { CookieJar } from "../src/features/itch/cookie-jar.ts";
import {
	bundleProductsToProducts,
	filterByAuthors,
	parseProductSelector,
	resolveProductSelectors,
} from "../src/features/selection/selection.ts";
import type { Product } from "../src/models/product.ts";
import { comparable, slugify } from "../src/utils/slugify.ts";
import { isIgnoredFile, isSystemFile } from "../src/utils/system-files.ts";
import { compactTimestamp } from "../src/utils/time.ts";

describe("slugify", () => {
	test("plain strings are only ascii-folded and trimmed (matches Python)", () => {
		expect(slugify("  Café Ünïcode!  ")).toBe("Cafe Unicode!");
	});
	test("filenames are sanitized with the extension preserved", () => {
		expect(slugify("My Game (v1.2) FINAL.zip", true)).toBe(
			"my-game-v12-final.zip",
		);
		expect(slugify("weird__name--.TAR.GZ", true)).toBe("weird__name-tar.gz");
		expect(slugify("noext", true)).toBe("noext");
		expect(slugify("Ünï cödé.PNG", true)).toBe("uni-code.png");
	});
	test("comparable", () => {
		expect(comparable("TTRPGs for Trans Rights in Texas!")).toBe(
			"ttrpgs-for-trans-rights-in-texas",
		);
	});
});

describe("system files", () => {
	test("Finder and Explorer leftovers, at any case", () => {
		for (const name of [
			".DS_Store",
			".ds_store",
			"._readme.md",
			"__MACOSX",
			"Thumbs.db",
			"thumbs.db",
			"desktop.ini",
		])
			expect(isSystemFile(name)).toBe(true);
		for (const name of ["readme.md", "_private.txt", "Desktop.png", ".itchio"])
			expect(isSystemFile(name)).toBe(false);
	});

	test("ignored: system, hidden and partial files", () => {
		expect(isIgnoredFile("Thumbs.db")).toBe(true);
		expect(isIgnoredFile(".itchio")).toBe(true);
		expect(isIgnoredFile("big.zip.incomplete")).toBe(true);
		expect(isIgnoredFile("big.zip")).toBe(false);
	});
});

describe("CookieJar", () => {
	const text = [
		"# Netscape HTTP Cookie File",
		".itch.io\tTRUE\t/\tTRUE\t0\titchio\tSESSION",
		"#HttpOnly_.itch.io\tTRUE\t/\tTRUE\t0\titchio_token\tTOKEN",
		"itch.io\tFALSE\t/my-purchases\tFALSE\t0\tscoped\tS",
		"example.com\tFALSE\t/\tFALSE\t0\tother\tO",
		"malformed line",
	].join("\n");

	test("parses Netscape format incl. HttpOnly lines", () => {
		const jar = CookieJar.parse(text);
		expect(jar.size).toBe(4);
		expect(jar.headerFor("https://itch.io/my-purchases")).toBe(
			"scoped=S; itchio=SESSION; itchio_token=TOKEN",
		);
		expect(jar.headerFor("https://cool-dev.itch.io/game")).toBe(
			"itchio=SESSION; itchio_token=TOKEN",
		);
		expect(jar.headerFor("http://itch.io/")).toBe("");
		expect(jar.headerFor("https://cdn.example.net/")).toBe("");
	});

	test("accepts a raw Cookie header value pasted into the file", () => {
		for (const input of [
			"itchio=SESS; itchio_token=TOK%3d%3d; _ga=GA1.2",
			"cookie: itchio=SESS; itchio_token=TOK%3d%3d; _ga=GA1.2\n",
			"Cookie:itchio=SESS;itchio_token=TOK%3d%3d;\n_ga=GA1.2",
		]) {
			const jar = CookieJar.parse(input);
			expect(jar.size).toBe(3);
			expect(jar.headerFor("https://itch.io/my-purchases")).toBe(
				"itchio=SESS; itchio_token=TOK%3d%3d; _ga=GA1.2",
			);
			expect(jar.headerFor("https://cool-dev.itch.io/game")).toBe(
				"itchio=SESS; itchio_token=TOK%3d%3d; _ga=GA1.2",
			);
			expect(jar.headerFor("http://itch.io/")).toBe("");
		}
		expect(CookieJar.parse("").size).toBe(0);
		expect(CookieJar.parse("just some words").size).toBe(0);
	});

	test("applySetCookies updates existing cookies", () => {
		const jar = CookieJar.parse(text);
		const res = new Response("", {
			headers: [
				["set-cookie", "itchio=NEW; Domain=.itch.io; Path=/; Secure; HttpOnly"],
			],
		});
		Object.defineProperty(res, "url", { value: "https://itch.io/x" });
		jar.applySetCookies(res);
		expect(jar.headerFor("https://itch.io/")).toBe(
			"itchio=NEW; itchio_token=TOKEN",
		);
	});
});

describe("filenameFromResponse", () => {
	const res = (cd?: string) =>
		new Response("", { headers: cd ? { "content-disposition": cd } : {} });
	test("content-disposition variants", () => {
		expect(
			filenameFromResponse(
				res('attachment; filename="a b.zip"'),
				"https://x/y",
			),
		).toBe("a b.zip");
		expect(
			filenameFromResponse(
				res("attachment; filename=plain.zip"),
				"https://x/y",
			),
		).toBe("plain.zip");
		expect(
			filenameFromResponse(
				res("attachment; filename*=UTF-8''caf%C3%A9.zip"),
				"https://x/y",
			),
		).toBe("café.zip");
	});
	test("falls back to the URL path", () => {
		expect(
			filenameFromResponse(res(), "https://cdn/upload/game%20v2.zip?sig=1"),
		).toBe("game v2.zip");
	});
	test("compactTimestamp", () => {
		expect(compactTimestamp(new Date(2024, 0, 5, 7, 8, 9))).toBe(
			"20240105070809",
		);
	});
});

describe("filter", () => {
	const product = (author: string, authorName = ""): Product => ({
		title: "t",
		slug: "t",
		dlurl: `https://${author}.itch.io/g/download/k`,
		productUrl: `https://${author}.itch.io/g`,
		author,
		authorName,
		key: "k",
		itchSlug: "g",
	});
	test("filterByAuthors matches slug or display name, case-insensitively", () => {
		const products = [
			product("cool-dev", "Cool Dev"),
			product("other", "Other Person"),
		];
		expect(filterByAuthors(products, [])).toHaveLength(2);
		expect(filterByAuthors(products, ["COOL-DEV"])).toEqual([products[0]!]);
		expect(filterByAuthors(products, ["other person"])).toEqual([products[1]!]);
		expect(filterByAuthors(products, ["nobody"])).toEqual([]);
	});
	const item = (author: string, itchSlug: string, title: string, key: string) =>
		({
			...product(author),
			title,
			slug: title,
			itchSlug,
			key,
			dlurl: `https://${author}.itch.io/${itchSlug}/download/${key}`,
			productUrl: `https://${author}.itch.io/${itchSlug}`,
		}) satisfies Product;
	const library = [
		item("cool-dev", "space-game", "Space Game", "K1"),
		item("other", "space-game", "Space Game", "K2"),
		item("cool-dev", "moon-pack", "Moon Pack (v2)", "K3"),
	];
	test("parseProductSelector reads URLs, author/game and free text", () => {
		expect(
			parseProductSelector("https://cool-dev.itch.io/space-game/download/K1"),
		).toEqual({
			text: "https://cool-dev.itch.io/space-game/download/K1",
			author: "cool-dev",
			slug: "space-game",
			key: "K1",
		});
		expect(
			parseProductSelector("https://cool-dev.itch.io/space-game/"),
		).toEqual({
			text: "https://cool-dev.itch.io/space-game/",
			author: "cool-dev",
			slug: "space-game",
			key: undefined,
		});
		expect(parseProductSelector("cool-dev/moon-pack")).toEqual({
			text: "cool-dev/moon-pack",
			author: "cool-dev",
			slug: "moon-pack",
		});
		expect(parseProductSelector("Moon Pack")).toEqual({ text: "Moon Pack" });
	});
	test("resolveProductSelectors matches by key, author/slug, title or slug", () => {
		expect(
			resolveProductSelectors(
				[
					"https://cool-dev.itch.io/space-game/download/K1",
					"https://OTHER.itch.io/space-game?foo#bar",
					"cool-dev/moon-pack",
					"moon pack v2",
					"Moon-Pack",
				],
				library,
			),
		).toEqual([library[0]!, library[1]!, library[2]!]);
	});
	test("resolveProductSelectors rejects unknown and ambiguous selectors", () => {
		expect(() => resolveProductSelectors(["nobody/nothing"], library)).toThrow(
			/Unknown product\(s\): "nobody\/nothing"/,
		);
		expect(() =>
			resolveProductSelectors(["https://itch.io/bundle/download/x"], library),
		).toThrow(/Unknown product/);
		expect(() => resolveProductSelectors(["Space Game"], library)).toThrow(
			/Ambiguous product\(s\): "Space Game" matches cool-dev\/space-game, other\/space-game/,
		);
	});
	test("bundleProductsToProducts keeps only claimed rows", () => {
		const products = bundleProductsToProducts([
			{
				title: "A",
				productUrl: "https://a.itch.io/a",
				author: "a",
				authorName: "A",
				claimed: true,
				dlurl: "https://a.itch.io/a/download/K",
			},
			{
				title: "B",
				productUrl: "https://b.itch.io/b",
				author: "b",
				authorName: "B",
				claimed: false,
			},
		]);
		expect(products).toHaveLength(1);
		expect(products[0]).toMatchObject({
			title: "A",
			key: "K",
			itchSlug: "a",
			author: "a",
		});
	});
});

describe("Tracker", () => {
	test("round trip, legacy format and selection change", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ibd-"));
		try {
			const sel = selectionFingerprint(["B"], ["x"]);
			const t = new Tracker(dir, sel);
			expect(await t.load()).toBe(0);
			await t.save(7);
			expect(await t.load()).toBe(7);
			expect(await new Tracker(dir, selectionFingerprint([], [])).load()).toBe(
				0,
			);
			await Bun.write(t.path, "12");
			expect(await t.load()).toBe(12);
			await Bun.write(t.path, "garbage");
			expect(await t.load()).toBe(0);
			await t.reset();
			expect(await Bun.file(t.path).exists()).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	test("fingerprint is order-insensitive", () => {
		expect(selectionFingerprint(["b", "A"], [])).toBe(
			selectionFingerprint(["a", "B"], []),
		);
		expect(selectionFingerprint([], [], ["y/b", "x/a"])).toBe(
			selectionFingerprint([], [], ["x/a", "y/b"]),
		);
	});
	test("fingerprint without products keeps the pre-products format", () => {
		expect(selectionFingerprint(["B"], ["x"])).toBe("bundles=b|authors=x");
		expect(selectionFingerprint(["B"], ["x"], [])).toBe("bundles=b|authors=x");
		expect(selectionFingerprint([], [], ["x/a"])).not.toBe(
			selectionFingerprint([], [], []),
		);
	});
});

describe("loadConfig", () => {
	test("writes a template on first run and reads it back with overrides", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ibd-"));
		try {
			const path = join(dir, "c.toml");
			expect(await loadConfig(path)).toBeNull();
			const cfg = await loadConfig(path, { authors: ["X"], create_png: false });
			expect(cfg).toMatchObject({
				log_download_progress: true,
				create_log: true,
				create_pdf: true,
				create_png: false,
				download_files: true,
				download_artwork: true,
				download_manifest: true,
				authors: ["x"],
				bundles: [],
				products: [],
			});
			expect(cfg!.download_directory.endsWith("downloads")).toBe(true);

			await Bun.write(
				path,
				'create_pdf = "OFF"\nbundles = "a, b"\ncreate_log = false\nproducts = [" x/a ", ""]\n',
			);
			expect(await loadConfig(path)).toMatchObject({
				create_log: false,
				create_pdf: false,
				bundles: ["a", "b"],
				products: ["x/a"],
			});
			expect(
				await loadConfig(path, { products: ["https://y.itch.io/b"] }),
			).toMatchObject({ products: ["https://y.itch.io/b"] });

			await Bun.write(path, "create_pdf = 3\n");
			await expect(loadConfig(path)).rejects.toBeInstanceOf(ConfigError);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
