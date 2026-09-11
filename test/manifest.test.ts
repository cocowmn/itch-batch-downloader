import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildManifest,
	parseProductMetadata,
	writeManifest,
} from "../src/features/manifest/manifest.ts";
import type { Game } from "../src/models/game.ts";

const html = `<html><head>
<meta property="og:image" content="https://img.itch.zone/abc/original/cover.png"/>
<meta name="itch:path" content="games/653649"/>
<meta name="description" content="Contains 1 Free sprite!"/>
</head><body>
<div class="game_info_panel_widget"><table>
<tr><td>Status</td><td>Released</td></tr>
<tr><td>Category</td><td>Assets</td></tr>
<tr><td>Author</td><td><a href="https://penusbmic.itch.io">Penusbmic</a></td></tr>
<tr><td>Tags</td><td><a href="https://itch.io/game-assets/tag-2d">2D</a>, <a href="https://itch.io/game-assets/tag-pixel-art">Pixel Art</a></td></tr>
</table></div>
<div class="screenshot_list"><a href="https://img.itch.zone/abc/original/shot1.png" data-image_lightbox="true"><img src="https://img.itch.zone/abc/347x500/x.png"></a></div>
<iframe src="//www.youtube.com/embed/xyz"></iframe>
</body></html>`;

const game: Game = {
	title: "Sci-fi Character Pack 1",
	slug: "Sci-fi Character Pack 1",
	dlurl: "https://penusbmic.itch.io/characterpack1/download/KEY",
	gameUrl: "https://penusbmic.itch.io/characterpack1",
	author: "penusbmic",
	authorName: "",
	key: "KEY",
	itchSlug: "characterpack1",
	bundles: [
		{
			name: "Big Bundle",
			key: "B1",
			url: "https://itch.io/bundle/download/B1",
		},
	],
};

describe("manifest", () => {
	test("parseProductMetadata", () => {
		const meta = parseProductMetadata(html);
		expect(meta).toEqual({
			itchId: 653649,
			description: "Contains 1 Free sprite!",
			coverImageUrl: "https://img.itch.zone/abc/original/cover.png",
			info: { Status: "Released", Category: "Assets", Author: "Penusbmic" },
			tags: ["2D", "Pixel Art"],
			screenshots: ["https://img.itch.zone/abc/original/shot1.png"],
			embeds: ["//www.youtube.com/embed/xyz"],
		});
		expect(parseProductMetadata("<html></html>").itchId).toBeNull();
	});

	test("buildManifest fills the author name from the info panel", () => {
		const m = buildManifest(game, parseProductMetadata(html), ["a.zip"]);
		expect(m.author).toEqual({
			slug: "penusbmic",
			name: "Penusbmic",
			url: "https://penusbmic.itch.io",
		});
		expect(m.urls.downloadPage).toBe(game.dlurl);
		expect(m.downloadKey).toBe("KEY");
		expect(m.bundles[0]).toEqual({
			name: "Big Bundle",
			key: "B1",
			url: "https://itch.io/bundle/download/B1",
		});
		expect(m.files).toEqual(["a.zip"]);
	});

	test("includeKeys: false leaves no download keys anywhere", () => {
		const m = buildManifest(game, parseProductMetadata(html), [], {
			includeKeys: false,
		});
		expect(m.downloadKey).toBeUndefined();
		expect(m.urls).toEqual({ page: game.gameUrl });
		expect(m.bundles).toEqual([{ name: "Big Bundle" }]);
		expect(JSON.stringify(m)).not.toContain("KEY");
		expect(JSON.stringify(m)).not.toContain("B1");
	});

	test("writeManifest lists the directory contents and excludes itself", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ibd-manifest-"));
		try {
			await Bun.write(join(dir, "b.zip"), "x");
			await Bun.write(join(dir, "a.png"), "x");
			await Bun.write(join(dir, "c.zip.incomplete"), "x");
			const path = await writeManifest(game, html, dir);
			expect(path).toBe(join(dir, "characterpack1_manifest.json"));
			const written = await Bun.file(path).json();
			expect(written.manifestVersion).toBe(1);
			expect(written.title).toBe("Sci-fi Character Pack 1");
			expect(written.files).toEqual(["a.png", "b.zip"]);
			// A second write refreshes the file and still excludes the manifest itself.
			await writeManifest(game, html, dir);
			expect((await Bun.file(path).json()).files).toEqual(["a.png", "b.zip"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
