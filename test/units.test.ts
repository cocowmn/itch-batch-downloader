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
	bundleGamesToGames,
	filterByAuthors,
} from "../src/features/selection/selection.ts";
import type { Game } from "../src/models/game.ts";
import { comparable, slugify } from "../src/utils/slugify.ts";
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
	const game = (author: string, authorName = ""): Game => ({
		title: "t",
		slug: "t",
		dlurl: `https://${author}.itch.io/g/download/k`,
		gameUrl: `https://${author}.itch.io/g`,
		author,
		authorName,
		key: "k",
		itchSlug: "g",
	});
	test("filterByAuthors matches slug or display name, case-insensitively", () => {
		const games = [game("cool-dev", "Cool Dev"), game("other", "Other Person")];
		expect(filterByAuthors(games, [])).toHaveLength(2);
		expect(filterByAuthors(games, ["COOL-DEV"])).toEqual([games[0]!]);
		expect(filterByAuthors(games, ["other person"])).toEqual([games[1]!]);
		expect(filterByAuthors(games, ["nobody"])).toEqual([]);
	});
	test("bundleGamesToGames keeps only claimed rows", () => {
		const games = bundleGamesToGames([
			{
				title: "A",
				gameUrl: "https://a.itch.io/a",
				author: "a",
				authorName: "A",
				claimed: true,
				dlurl: "https://a.itch.io/a/download/K",
			},
			{
				title: "B",
				gameUrl: "https://b.itch.io/b",
				author: "b",
				authorName: "B",
				claimed: false,
			},
		]);
		expect(games).toHaveLength(1);
		expect(games[0]).toMatchObject({
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
			});
			expect(cfg!.download_directory.endsWith("downloads")).toBe(true);

			await Bun.write(
				path,
				'create_pdf = "OFF"\nbundles = "a, b"\ncreate_log = false\n',
			);
			expect(await loadConfig(path)).toMatchObject({
				create_log: false,
				create_pdf: false,
				bundles: ["a", "b"],
			});

			await Bun.write(path, "create_pdf = 3\n");
			await expect(loadConfig(path)).rejects.toBeInstanceOf(ConfigError);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
