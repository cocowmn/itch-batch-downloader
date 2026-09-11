// Resume support: a small JSON file in the download directory remembering the
// 1-based index of the item being processed. When the selection (bundle /
// author filters) changes between runs the index is meaningless, so a
// fingerprint of the selection is stored next to it.

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../../utils/log.ts";

export const TRACK_FILE = "itch-batch-downloader-track.txt";

export interface TrackState {
	index: number;
	selection: string;
}

export function selectionFingerprint(
	bundles: string[],
	authors: string[],
): string {
	const norm = (xs: string[]) =>
		[...xs]
			.map((s) => s.trim().toLowerCase())
			.sort()
			.join(",");
	return `bundles=${norm(bundles)}|authors=${norm(authors)}`;
}

export class Tracker {
	readonly path: string;

	constructor(
		downloadDirectory: string,
		private readonly selection: string,
	) {
		this.path = join(downloadDirectory, TRACK_FILE);
	}

	/** Index to resume from (1-based); 0 when starting fresh. */
	async load(): Promise<number> {
		const file = Bun.file(this.path);
		if (!(await file.exists())) return 0;
		let parsed: unknown;
		try {
			parsed = JSON.parse((await file.text()).trim());
		} catch {
			log.warn(
				`Ignoring unreadable ${this.path}; starting from the beginning.`,
			);
			return 0;
		}
		// Legacy format written by the Python version: a bare number.
		if (typeof parsed === "number")
			return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
		if (typeof parsed === "object" && parsed !== null) {
			const state = parsed as Partial<TrackState>;
			if (typeof state.index !== "number") return 0;
			if (state.selection !== undefined && state.selection !== this.selection) {
				log.info(
					"Bundle/author selection changed since the last run; starting from the beginning.",
				);
				return 0;
			}
			return state.index > 0 ? Math.floor(state.index) : 0;
		}
		return 0;
	}

	async save(index: number): Promise<void> {
		const state: TrackState = { index, selection: this.selection };
		await Bun.write(this.path, JSON.stringify(state));
	}

	async reset(): Promise<void> {
		await unlink(this.path).catch(() => {});
	}
}
