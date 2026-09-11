// Per-item manifest: a JSON file describing the item, written next to its
// files as <prefix>_manifest.json and refreshed on every run.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { load } from "cheerio";
import type { Bundle, Game } from "../../models/game.ts";
import type {
	Manifest,
	ManifestBundle,
	ProductMetadata,
} from "../../models/manifest.ts";
import { findCoverImage } from "../artwork/artwork.ts";

export const MANIFEST_SUFFIX = "_manifest.json";

export function parseProductMetadata(html: string): ProductMetadata {
	const $ = load(html);

	const itchPath = $('meta[name="itch:path"]').attr("content") ?? "";
	const idMatch = /^games\/(\d+)$/.exec(itchPath.trim());
	const itchId = idMatch?.[1] ? Number(idMatch[1]) : null;

	const description =
		$('meta[property="og:description"]').attr("content")?.trim() ||
		$('meta[name="description"]').attr("content")?.trim() ||
		null;

	const info: Record<string, string> = {};
	let tags: string[] = [];
	$(".game_info_panel_widget tr").each((_, tr) => {
		const cells = $(tr).find("td");
		if (cells.length < 2) return;
		const label = cells.first().text().trim();
		const valueCell = cells.last();
		if (!label) return;
		if (label === "Tags") {
			tags = valueCell
				.find("a")
				.map((_, a) => $(a).text().trim())
				.get()
				.filter(Boolean);
			return;
		}
		info[label] = valueCell.text().replace(/\s+/g, " ").trim();
	});

	const screenshots: string[] = [];
	$("a[data-image_lightbox][href], .screenshot_list a[href]").each((_, a) => {
		const href = $(a).attr("href")?.trim();
		if (href && /^https?:\/\//.test(href) && !screenshots.includes(href))
			screenshots.push(href);
	});

	const embeds: string[] = [];
	$("iframe[src]").each((_, el) => {
		const src = $(el).attr("src")?.trim();
		if (src) embeds.push(src);
	});

	return {
		itchId,
		description,
		coverImageUrl: findCoverImage(html),
		info,
		tags,
		screenshots,
		embeds,
	};
}

export interface ManifestOptions {
	/** The item's directory relative to download_directory ("/"-separated). */
	directory?: string;
	/** File name prefix shared by the item's generated files. */
	prefix?: string;
	/**
	 * Include the download key, download-page URL and bundle keys/URLs. These
	 * grant access to the downloads, so a manifest with them is a private file.
	 * Without them the manifest only describes the content.
	 */
	includeKeys?: boolean;
}

/**
 * A manifest without the parts that only `manifest_include_keys` writes
 * (the download key, the download page URL and the bundles' keys): what
 * the download browser sends to clients.
 */
export function redactManifest(manifest: Manifest): Manifest {
	const { downloadKey: _key, ...rest } = manifest;
	return {
		...rest,
		urls: { page: manifest.urls?.page ?? "" },
		bundles: (manifest.bundles ?? []).map((b) => ({ name: b.name })),
	};
}

export function buildManifest(
	game: Game,
	metadata: ProductMetadata,
	files: string[],
	options: ManifestOptions = {},
): Manifest {
	const includeKeys = options.includeKeys ?? true;
	const authorUrl = game.author
		? `https://${game.author}.itch.io`
		: new URL(game.gameUrl).origin;
	const bundles: ManifestBundle[] = (game.bundles ?? []).map((b: Bundle) =>
		includeKeys ? { name: b.name, key: b.key, url: b.url } : { name: b.name },
	);
	return {
		manifestVersion: 1,
		generatedAt: new Date().toISOString(),
		title: game.title,
		author: {
			slug: game.author,
			name: game.authorName || metadata.info.Author || game.author,
			url: authorUrl,
		},
		urls: includeKeys
			? { page: game.gameUrl, downloadPage: game.dlurl }
			: { page: game.gameUrl },
		...(includeKeys ? { downloadKey: game.key } : {}),
		directory: options.directory ?? game.itchSlug,
		bundles,
		...metadata,
		files,
	};
}

/** Write `<dir>/<prefix>_manifest.json`; returns the path written. */
export async function writeManifest(
	game: Game,
	html: string,
	dir: string,
	options: ManifestOptions = {},
): Promise<string> {
	const path = join(
		dir,
		`${options.prefix ?? game.itchSlug}${MANIFEST_SUFFIX}`,
	);
	const entries = await readdir(dir).catch(() => [] as string[]);
	const files = entries
		.filter(
			(f) =>
				!f.endsWith(".incomplete") &&
				!f.endsWith(MANIFEST_SUFFIX) &&
				!f.startsWith("."),
		)
		.sort();
	const manifest = buildManifest(
		game,
		parseProductMetadata(html),
		files,
		options,
	);
	await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
	return path;
}
