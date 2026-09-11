import { describe, expect, test } from "bun:test";
import {
	parseBundlePage,
	parseBundlesPage,
	resolveBundleSelectors,
} from "../src/features/itch/bundles.ts";
import {
	classifyHost,
	parseDownloadPage,
} from "../src/features/itch/download-page.ts";
import {
	gameFromDownloadUrl,
	parsePurchasesPage,
} from "../src/features/itch/purchases.ts";
import {
	findEmbeddedVideos,
	normalizeEmbedUrl,
} from "../src/features/videos/videos.ts";

const fixture = (name: string) =>
	Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

describe("parsePurchasesPage", () => {
	test("extracts games, authors and pagination", async () => {
		const { games, hasNext } = parsePurchasesPage(
			await fixture("purchases.html"),
		);
		expect(hasNext).toBe(true);
		expect(games).toHaveLength(2);
		expect(games[0]).toMatchObject({
			title: "Space Game: Ünïcode Edition",
			slug: "Space Game: Unicode Edition",
			dlurl: "https://cool-dev.itch.io/space-game/download/AbC123",
			gameUrl: "https://cool-dev.itch.io/space-game",
			author: "cool-dev",
			authorName: "Cool Dev",
			key: "AbC123",
			itchSlug: "space-game",
		});
		expect(games[1]!.author).toBe("other");
	});

	test("last page has no next link", async () => {
		const { games, hasNext } = parsePurchasesPage(
			await fixture("purchases-last.html"),
		);
		expect(hasNext).toBe(false);
		expect(games).toHaveLength(1);
	});
});

describe("gameFromDownloadUrl", () => {
	test("rejects garbage", () => {
		expect(gameFromDownloadUrl("x", "not a url")).toBeNull();
	});
});

describe("bundles", () => {
	test("parseBundlesPage", async () => {
		const bundles = parseBundlesPage(await fixture("bundles.html"));
		expect(bundles).toEqual([
			{
				name: "Bundle for Racial Justice and Equality",
				key: "bundlekey1",
				url: "https://itch.io/bundle/download/bundlekey1",
			},
			{
				name: "TTRPGs for Trans Rights in Texas!",
				key: "bundlekey2",
				url: "https://itch.io/bundle/download/bundlekey2",
			},
		]);
	});

	test("parseBundlePage distinguishes claimed and unclaimed rows", async () => {
		const { games, hasNext } = parseBundlePage(
			await fixture("bundle-page.html"),
		);
		expect(hasNext).toBe(true);
		expect(games).toEqual([
			{
				title: "Space Game",
				gameUrl: "https://cool-dev.itch.io/space-game",
				author: "cool-dev",
				authorName: "Cool Dev",
				claimed: true,
				dlurl: "https://cool-dev.itch.io/space-game/download/AbC123",
			},
			{
				title: "Unclaimed Thing",
				gameUrl: "https://someone.itch.io/unclaimed-thing",
				author: "someone",
				authorName: "Someone",
				claimed: false,
			},
		]);
	});

	test("resolveBundleSelectors matches key, name, slug and URL", async () => {
		const owned = parseBundlesPage(await fixture("bundles.html"));
		expect(resolveBundleSelectors(["bundlekey2"], owned)[0]!.key).toBe(
			"bundlekey2",
		);
		expect(
			resolveBundleSelectors(
				["bundle for racial justice and equality"],
				owned,
			)[0]!.key,
		).toBe("bundlekey1");
		expect(
			resolveBundleSelectors(["ttrpgs-for-trans-rights-in-texas"], owned)[0]!
				.key,
		).toBe("bundlekey2");
		expect(
			resolveBundleSelectors(
				["https://itch.io/bundle/download/bundlekey1?page=2"],
				owned,
			)[0]!.key,
		).toBe("bundlekey1");
		expect(
			resolveBundleSelectors(["bundlekey1", "bundlekey1"], owned),
		).toHaveLength(1);
		expect(() => resolveBundleSelectors(["nope"], owned)).toThrow(
			/Unknown bundle selector.*nope[\s\S]*bundlekey1/,
		);
	});
});

describe("parseDownloadPage", () => {
	test("legacy data-upload_id pages", async () => {
		const page = parseDownloadPage(await fixture("download-page-legacy.html"));
		expect(page.csrfToken).toBe("CSRF123");
		expect(page.uploads).toEqual([
			{ index: 1, uploadId: "1001" },
			{ index: 2, uploadId: "1002" },
		]);
	});

	test("new href based pages fall back to the page-wide button", async () => {
		const page = parseDownloadPage(await fixture("download-page-new.html"));
		expect(page.csrfToken).toBe("CSRF456");
		expect(page.uploads).toEqual([
			{
				index: 1,
				directUrl: "https://cool-dev.itch.io/space-game/download/AbC123/5001",
			},
			{
				index: 2,
				directUrl: "https://cool-dev.itch.io/space-game/download/AbC123/5001",
			},
		]);
	});
});

describe("classifyHost", () => {
	test.each([
		["https://w3g3a5v6.ssl.hwcdn.net/upload2/game/1/2?x=y", "hwcdn"],
		[
			"https://itchio-mirror.abc.r2.cloudflarestorage.com/file.zip",
			"cloudflare",
		],
		["https://r2.cloudflarestorage.com/file.zip", "cloudflare"],
		["https://drive.google.com/file/d/xyz", "google-drive"],
		["https://dropbox.com/s/xyz", "other"],
	] as const)("%s -> %s", (url, kind) => {
		expect(classifyHost(url)).toBe(kind);
	});
});

describe("videos", () => {
	test("normalizeEmbedUrl", () => {
		expect(normalizeEmbedUrl("//www.youtube.com/embed/x")).toBe(
			"https://www.youtube.com/embed/x",
		);
		expect(normalizeEmbedUrl("http://a/b")).toBe("http://a/b");
		expect(normalizeEmbedUrl("/vimeo.com/1")).toBe("https://vimeo.com/1");
	});
	test("findEmbeddedVideos", () => {
		const html = `<iframe src="//www.youtube.com/embed/x"></iframe><iframe></iframe><iframe src="https://player.vimeo.com/video/1"></iframe>`;
		expect(findEmbeddedVideos(html)).toEqual([
			"https://www.youtube.com/embed/x",
			"https://player.vimeo.com/video/1",
		]);
	});
});
