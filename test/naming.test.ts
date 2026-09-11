import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/features/config/config.ts";
import {
	buildMarker,
	readMarker,
	writeMarker,
} from "../src/features/manifest/marker.ts";
import {
	DownloadNameError,
	downloadNameWarnings,
	parseDownloadName,
	parseItchDate,
	resolveDownloadName,
	safeSegment,
} from "../src/features/naming/naming.ts";
import type { Game } from "../src/models/game.ts";
import { scanLibrary } from "../src/www/server/library.ts";

const game: Game = {
	title: "Sci-fi: Character Pack 1?",
	slug: "Sci-fi Character Pack 1",
	dlurl: "https://penusbmic.itch.io/characterpack1/download/KEY",
	gameUrl: "https://penusbmic.itch.io/characterpack1",
	author: "penusbmic",
	authorName: "Penusbmic",
	key: "KEY",
	itchSlug: "characterpack1",
	bundles: [{ name: "Big Bundle", key: "B1", url: "https://itch.io/b/B1" }],
};

const page = {
	itchId: 653649,
	description: null,
	coverImageUrl: null,
	info: {
		Category: "Assets",
		Genre: "Action, Platformer",
		Published: "Dec 11, 2020",
		Updated: "Jun 24, 2025",
	},
	tags: ["2D", "Pixel Art", "Sprites"],
	screenshots: [],
	embeds: [],
};

const runStarted = new Date(2026, 8, 11, 7, 5, 9, 42);
const ctx = { game, index: 7, total: 217, runStarted, page };

describe("download_name template", () => {
	test("default and nested templates resolve to safe paths", () => {
		expect(resolveDownloadName(parseDownloadName("{title}"), ctx)).toBe(
			"Sci-fi- Character Pack 1-",
		);
		expect(resolveDownloadName(parseDownloadName("{slug}"), ctx)).toBe(
			"characterpack1",
		);
		expect(
			resolveDownloadName(parseDownloadName("{author}/{title}"), ctx),
		).toBe("penusbmic/Sci-fi- Character Pack 1-");
		expect(
			resolveDownloadName(
				parseDownloadName("{yyyy}-{mm}-{dd}/{author}--{index}"),
				ctx,
			),
		).toBe("2026-09-11/penusbmic--007");
	});

	test("every token has a value", () => {
		// Three segments, since one is capped at 120 characters.
		const all =
			"{title}+{slug}+{author}+{author_name}+{bundle}+{id}+{category}/{tags}+{genre}+{published}+{updated}/{index}+{total}+{yyyy}+{yy}+{mm}+{dd}+{hh}+{min}+{ss}+{ms}+{date}+{time}";
		expect(resolveDownloadName(parseDownloadName(all), ctx)).toBe(
			[
				"Sci-fi- Character Pack 1-",
				"characterpack1",
				"penusbmic",
				"Penusbmic",
				"Big Bundle",
				"653649",
				"Assets/2D, Pixel Art, Sprites",
				"Action, Platformer",
				"2020-12-11",
				"2025-06-24/007",
				"217",
				"2026",
				"26",
				"09",
				"11",
				"07",
				"05",
				"09",
				"042",
				"2026-09-11",
				"07-05-09",
			].join("+"),
		);
	});

	test("list separators", () => {
		expect(
			resolveDownloadName(parseDownloadName("{tags:--}/{slug}"), ctx),
		).toBe("2D--Pixel Art--Sprites/characterpack1");
		expect(
			resolveDownloadName(parseDownloadName("{genre:_}/{slug}"), ctx),
		).toBe("Action_Platformer/characterpack1");
		expect(
			resolveDownloadName(parseDownloadName("{tags}/{slug}"), {
				...ctx,
				page: { ...page, tags: [] },
			}),
		).toBe("untagged/characterpack1");
		expect(() => parseDownloadName("{tags:--}")).toThrow(/identifying/);
	});

	test("missing values fall back instead of producing empty segments", () => {
		const anonymous = { ...game, author: "", authorName: "", bundles: [] };
		expect(
			resolveDownloadName(parseDownloadName("{author}/{bundle}/{slug}"), {
				...ctx,
				game: anonymous,
			}),
		).toBe("unknown-author/library/characterpack1");
	});

	test("page tokens need the product page", () => {
		const name = parseDownloadName("{category}/{title}");
		expect(name.needsPage).toBe(true);
		expect(() => resolveDownloadName(name, { ...ctx, page: null })).toThrow(
			DownloadNameError,
		);
		expect(parseDownloadName("{author}/{title}").needsPage).toBe(false);
	});

	test("rejects unsafe or malformed templates with a reason", () => {
		const cases: [string, RegExp][] = [
			["", /empty/],
			["/{title}", /relative path/],
			["{title}/", /start or end/],
			["{author}//{title}", /empty directory/],
			["../{title}", /not a safe/],
			["{author}/./{title}", /not a safe/],
			["C:/{title}", /relative path/],
			["{author}\\{title}", /use "\/" to separate/],
			["{title}:", /not allowed in file names/],
			["{title", /missing "}"/],
			["title}", /unexpected "}"/],
			["{}", /not a valid token/],
			["{Title}", /not a valid token/],
			["{nope}", /unknown token \{nope\}/],
			["{title:-}", /does not take a separator/],
			["{tags:/}", /missing "}"/],
			["{tags::}/{slug}", /separator/],
			["{author}", /identifying token/],
			["{yyyy}/{author}", /identifying token/],
			["backup.", /dot or a space/],
		];
		for (const [template, why] of cases) {
			expect(() => parseDownloadName(template), template).toThrow(why);
		}
	});

	test("warnings for templates without a title and with volatile tokens", () => {
		expect(downloadNameWarnings(parseDownloadName("{title}"))).toEqual([]);
		const w = downloadNameWarnings(
			parseDownloadName("{yyyy}-{mm}-{dd}/{author}--{index}"),
		);
		expect(w).toHaveLength(2);
		expect(w[0]).toContain("{title} or {slug}");
		expect(w[1]).toContain("{yyyy}");
		expect(downloadNameWarnings(parseDownloadName("{id}"))).toHaveLength(1);
	});

	test("safeSegment", () => {
		expect(safeSegment('a/b\\c:d*e?f"g<h>i|j', "x")).toBe(
			"a-b-c-d-e-f-g-h-i-j",
		);
		expect(safeSegment("  .. hidden..  ", "x")).toBe("hidden");
		expect(safeSegment("\u0007", "x")).toBe("x");
		expect(safeSegment("con", "x")).toBe("_con");
		expect(safeSegment("a".repeat(300), "x")).toHaveLength(120);
		expect(safeSegment("Ünïcödé — ok", "x")).toBe("Ünïcödé — ok");
	});

	test("parseItchDate", () => {
		expect(parseItchDate("Dec 11, 2020")).toBe("2020-12-11");
		expect(parseItchDate("September 3, 2024")).toBe("2024-09-03");
		expect(parseItchDate("2 days ago")).toBeNull();
		expect(parseItchDate(undefined)).toBeNull();
	});

	test("config validation reports template errors as ConfigError", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ibd-name-"));
		try {
			const file = join(dir, "appconfig.toml");
			await Bun.write(file, 'download_name = "{author}"\n');
			await expect(loadConfig(file)).rejects.toThrow(ConfigError);
			await expect(loadConfig(file)).rejects.toThrow(/identifying token/);
			await Bun.write(file, "download_directory = 'x'\n");
			expect((await loadConfig(file))?.download_name).toBe("{slug}");
			expect(
				(await loadConfig(file, { download_name: "{author}/{slug}" }))
					?.download_name,
			).toBe("{author}/{slug}");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("item marker", () => {
	test("contains public identity only", () => {
		const marker = buildMarker(game, "{author}/{title}");
		expect(JSON.stringify(marker)).not.toContain("KEY");
		expect(marker.author.url).toBe("https://penusbmic.itch.io");
		expect(marker.url).toBe(game.gameUrl);
	});

	test("nested item directories are found through their markers", async () => {
		const root = await mkdtemp(join(tmpdir(), "ibd-nested-"));
		try {
			const nested = join(root, "penusbmic", "Sci-fi Pack");
			await Bun.write(join(nested, "pack.zip"), "zip");
			await writeMarker(nested, game, "{author}/{title}");
			await Bun.write(join(nested, "Sci-fi Pack_cover-artwork.png"), "png");
			// a legacy flat directory without marker next to it
			await Bun.write(join(root, "oldie", "1_old_20240101.zip"), "zip");
			// an unpacked folder inside a legacy item must not become an item
			await Bun.write(join(root, "oldie", "unpacked", "a.txt"), "a");

			expect(await readMarker(nested)).toMatchObject({
				slug: "characterpack1",
			});
			const lib = await scanLibrary(root);
			expect(lib.items.map((i) => i.directory)).toEqual([
				"oldie",
				"penusbmic/Sci-fi Pack",
			]);
			const [oldie, item] = lib.items;
			expect(item?.title).toBe(game.title);
			expect(item?.author?.name).toBe("Penusbmic");
			expect(item?.urls).toEqual({ page: game.gameUrl });
			expect(item?.cover).toBe(
				"/files/penusbmic/Sci-fi%20Pack/Sci-fi%20Pack_cover-artwork.png",
			);
			expect(item?.files.map((f) => f.name)).toEqual([
				"pack.zip",
				"Sci-fi Pack_cover-artwork.png",
			]);
			expect(oldie?.hasManifest).toBe(false);
			expect(oldie?.files.map((f) => f.name)).toEqual([
				"1_old_20240101.zip",
				"unpacked",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
