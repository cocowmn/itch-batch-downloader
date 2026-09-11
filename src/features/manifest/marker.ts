// Every item directory gets a small hidden marker file so the download
// browser can find items wherever download_name placed them, and can name
// them even when no manifest was written. Contains public data only. The
// browser's own state (whether an admin hid the item) lives in it too, so it
// travels with the directory.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Game } from "../../models/game.ts";
import type { ItemMarker } from "../../models/marker.ts";

export const MARKER_FILE = ".itchio";

export function buildMarker(game: Game, downloadName: string): ItemMarker {
	return {
		markerVersion: 1,
		title: game.title,
		slug: game.itchSlug,
		author: {
			slug: game.author,
			name: game.authorName || game.author,
			url: game.author
				? `https://${game.author}.itch.io`
				: new URL(game.gameUrl).origin,
		},
		url: game.gameUrl,
		downloadName,
		updatedAt: new Date().toISOString(),
	};
}

/** The marker's JSON as written, without checking its shape; null when absent or unreadable. */
async function readMarkerJson(
	dir: string,
): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = await Bun.file(join(dir, MARKER_FILE)).json();
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function writeMarkerJson(dir: string, marker: object): Promise<void> {
	await Bun.write(
		join(dir, MARKER_FILE),
		`${JSON.stringify(marker, null, 2)}\n`,
	);
}

/** Write a fresh marker; a hidden flag an admin set earlier is kept. */
export async function writeMarker(
	dir: string,
	game: Game,
	downloadName: string,
): Promise<void> {
	const marker = buildMarker(game, downloadName);
	if ((await readMarkerJson(dir))?.hidden === true) marker.hidden = true;
	await writeMarkerJson(dir, marker);
}

export async function readMarker(dir: string): Promise<ItemMarker | null> {
	const m = (await readMarkerJson(dir)) as Partial<ItemMarker> | null;
	if (!m || typeof m.title !== "string" || typeof m.slug !== "string")
		return null;
	return m as ItemMarker;
}

/** Whether an admin hid the item in `dir`; null when `dir` has no marker. */
export async function isMarkerHidden(dir: string): Promise<boolean | null> {
	const marker = await readMarkerJson(dir);
	return marker && marker.hidden === true;
}

/**
 * Record whether the item in `dir` is hidden. A legacy item (no marker yet)
 * gets a marker holding only the flag, removed again when it is unhidden.
 */
export async function setMarkerHidden(
	dir: string,
	hidden: boolean,
): Promise<void> {
	const marker = (await readMarkerJson(dir)) ?? {};
	if (hidden) marker.hidden = true;
	else delete marker.hidden;
	if (Object.keys(marker).length === 0) {
		await rm(join(dir, MARKER_FILE), { force: true });
		return;
	}
	await writeMarkerJson(dir, marker);
}
