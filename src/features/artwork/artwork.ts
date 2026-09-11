// Cover artwork of a product page, saved next to the item's files as
// <itchSlug>_cover-artwork.<ext>.

import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { load } from "cheerio";
import { log } from "../../utils/log.ts";
import { downloadFile } from "../download/transfer.ts";
import type { ItchClient } from "../itch/client.ts";

export const COVER_SUFFIX = "_cover-artwork";

/**
 * Locate the cover image of a product page. The Open Graph image is the cover
 * at original size; the other locations are scaled variants used as fallbacks
 * (the CDN hash differs per size, so a small variant cannot be upscaled).
 */
export function findCoverImage(html: string): string | null {
	const $ = load(html);
	const candidates = [
		$('meta[property="og:image"]').attr("content"),
		$('meta[name="og:image"]').attr("content"),
		$('meta[property="twitter:image"], meta[name="twitter:image"]').attr(
			"content",
		),
		backgroundImage($(".goal_banner_widget .cover_image").attr("style")),
	];
	for (const c of candidates) {
		const url = c?.trim();
		if (url && /^https?:\/\//.test(url)) return url;
	}
	return null;
}

function backgroundImage(style: string | undefined): string | undefined {
	const m = style ? /url\((['"]?)(.*?)\1\)/.exec(style) : null;
	return m?.[2];
}

function extensionOf(url: string): string {
	const ext = extname(new URL(url).pathname).toLowerCase();
	return /^\.[a-z0-9]{2,5}$/.test(ext) ? ext : ".png";
}

/**
 * Download the cover artwork of `gameUrl` into `dir` unless a cover file is
 * already there. Returns true when a file was written.
 */
export async function downloadCoverArtwork(
	client: ItchClient,
	html: string,
	gameUrl: string,
	dir: string,
	prefix: string,
	showProgress: boolean,
): Promise<boolean> {
	const stem = `${prefix}${COVER_SUFFIX}`;
	const existing = await readdir(dir).catch(() => [] as string[]);
	if (existing.some((f) => f.startsWith(`${stem}.`))) {
		log.info("Cover artwork exists. Skipped.");
		return false;
	}
	const url = findCoverImage(html);
	if (!url) {
		log.warn(`No cover artwork found on ${gameUrl}`);
		return false;
	}
	log.debug(`Cover artwork URL: ${url}`);
	return downloadFile(client, url, {
		dest: { path: join(dir, `${stem}${extensionOf(url)}`) },
		renameOld: false,
		skipIfIdentical: false,
		showProgress,
	});
}
