// The batch run: build the item list, then for every item download its files,
// capture the product page and fetch embedded videos.

import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Config } from "../../models/config.ts";
import type { Game } from "../../models/game.ts";
import { isAbortError, throwIfAborted } from "../../utils/abort.ts";
import { log } from "../../utils/log.ts";
import { withRetries } from "../../utils/retry.ts";
import { slugify } from "../../utils/slugify.ts";
import { dateStamp } from "../../utils/time.ts";
import { downloadCoverArtwork } from "../artwork/artwork.ts";
import { PageCapturer } from "../capture/capture.ts";
import { createClient, type ItchClient } from "../itch/client.ts";
import {
	classifyHost,
	type DownloadPage,
	parseDownloadPage,
	resolveUploadUrl,
	type UploadRef,
} from "../itch/download-page.ts";
import { parseProductMetadata, writeManifest } from "../manifest/manifest.ts";
import { writeMarker } from "../manifest/marker.ts";
import {
	type DownloadName,
	DownloadNameError,
	downloadNameWarnings,
	parseDownloadName,
	resolveDownloadName,
} from "../naming/naming.ts";
import {
	reportUnclaimed,
	type Selection,
	selectGames,
} from "../selection/selection.ts";
import { VideoDownloader } from "../videos/videos.ts";
import { selectionFingerprint, Tracker } from "./tracker.ts";
import { downloadFile } from "./transfer.ts";

export interface RunOptions {
	dryRun?: boolean;
	restart?: boolean;
	/** Skip the first N items of the selection (start at item N+1). */
	skip?: number;
}

export const LOG_FILE = "downloads.log";

/** Everything one item needs to be processed; shared by `run()` and the download browser. */
export interface ItemContext {
	client: ItchClient;
	config: Config;
	game: Game;
	/** 1-based position in the selection, and its size (for `{index}`/`{total}`). */
	index: number;
	total: number;
	runStarted: Date;
	name: DownloadName;
	capturer: PageCapturer;
	videos: VideoDownloader | null;
	/** Where the item directory is created; `config.download_directory` for runs. */
	downloadDir: string;
	/** Cancels the item: requests, downloads (the `.incomplete` file is removed) and captures. */
	signal?: AbortSignal;
}

export async function run(
	config: Config,
	opts: RunOptions = {},
): Promise<void> {
	await mkdir(config.download_directory, { recursive: true });
	if (config.create_log && !opts.dryRun)
		log.setFile(join(config.download_directory, LOG_FILE));
	log.info(`Download directory is '${config.download_directory}'`);
	const name = parseDownloadName(config.download_name);
	log.info(`Item directories follow download_name = "${name.source}"`);
	for (const warning of downloadNameWarnings(name)) log.warn(warning);
	const runStarted = new Date();
	const client = await createClient(config);

	const selection = await selectGames(client, config);
	const games = selection.games;
	log.info(`${games.length} items found.`);
	reportUnclaimed(selection.unclaimed);
	warnAboutCollisions(name, games, runStarted);

	if (opts.dryRun) {
		printGameList(selection, name, runStarted);
		return;
	}

	const tracker = new Tracker(
		config.download_directory,
		selectionFingerprint(config.bundles, config.authors),
	);
	if (opts.restart) await tracker.reset();
	let resumeFrom = await tracker.load();
	if (opts.skip) {
		resumeFrom = opts.skip + 1;
		log.info(
			`Skipping the first ${opts.skip} item(s); starting at item ${resumeFrom}.`,
		);
	} else if (resumeFrom > 1) {
		log.info(
			`Resuming from item ${resumeFrom} (delete ${tracker.path} or use --restart to start over).`,
		);
	}

	const capturer = new PageCapturer(client.jar, {
		png: config.create_png,
		pdf: config.create_pdf,
		chromePath: config.chrome_path,
	});
	const videos = config.download_videos
		? new VideoDownloader(config.yt_dlp_path)
		: null;

	try {
		for (const [i, game] of games.entries()) {
			const number = i + 1;
			if (number < resumeFrom) continue;

			log.raw();
			log.info(
				`Analysing item ${number} of ${games.length}. Title: ${game.slug}`,
			);
			await tracker.save(number);
			await processItem({
				client,
				config,
				game,
				index: number,
				total: games.length,
				runStarted,
				name,
				capturer,
				videos,
				downloadDir: config.download_directory,
			});
		}
		await tracker.save(0);
	} finally {
		capturer.close();
	}
}

/**
 * Download one item: files, cover artwork, page captures, videos and the
 * manifest, into `<downloadDir>/<download_name>`. Errors of single steps are
 * logged and the item continues; an abort propagates. Returns the item's
 * directory relative to `downloadDir`, or null when it was skipped.
 */
export async function processItem(ctx: ItemContext): Promise<string | null> {
	const {
		client,
		config,
		game,
		index,
		total,
		runStarted,
		name,
		capturer,
		videos,
		downloadDir,
		signal,
	} = ctx;

	// The public product page serves the cover artwork, the videos and the
	// manifest, and the download_name template may need it too.
	let productPage: string | null = null;
	if (
		name.needsPage ||
		config.download_artwork ||
		config.download_manifest ||
		videos
	) {
		try {
			productPage = await fetchProductPage(client, game.gameUrl);
		} catch (err) {
			if (isAbortError(err)) throw err;
			log.error(`Could not load product page ${game.gameUrl}`, err);
		}
	}

	throwIfAborted(signal);
	let relativeDir: string;
	try {
		relativeDir = resolveDownloadName(name, {
			game,
			index,
			total,
			runStarted,
			page:
				name.needsPage && productPage !== null
					? parseProductMetadata(productPage)
					: null,
		});
	} catch (err) {
		if (!(err instanceof DownloadNameError)) throw err;
		log.error(`Skipping item: ${err.message}`);
		return null;
	}
	const gameDir = join(downloadDir, relativeDir);
	// Generated files (cover, captures, manifest, videos) share this prefix.
	const prefix = basename(relativeDir);
	log.info(`Saving to ${relativeDir}`);
	await mkdir(gameDir, { recursive: true });
	await writeMarker(gameDir, game, name.source);

	let newDownloads = false;
	if (config.download_files) {
		try {
			newDownloads = await downloadGameFiles(client, config, game, gameDir);
		} catch (err) {
			if (isAbortError(err)) throw err;
			log.error(`Could not process download page ${game.dlurl}`, err);
		}
	} else {
		log.info("File downloads disabled as config setting is false");
	}

	if (config.download_artwork && productPage !== null) {
		try {
			await downloadCoverArtwork(
				client,
				productPage,
				game.gameUrl,
				gameDir,
				prefix,
				config.log_download_progress,
			);
		} catch (err) {
			if (isAbortError(err)) throw err;
			log.error(
				`Error while downloading cover artwork for ${game.gameUrl}`,
				err,
			);
		}
	} else if (!config.download_artwork) {
		log.info("Cover artwork download disabled as config setting is false");
	}

	throwIfAborted(signal);
	if (capturer.enabled) {
		await capturer.capture(game.gameUrl, gameDir, prefix, newDownloads, signal);
	} else if (!config.create_png && !config.create_pdf) {
		log.info("Screenshot/PDF creation disabled as config setting is false");
	}

	if (videos && productPage !== null) {
		try {
			await videos.download(productPage, gameDir, prefix, signal);
		} catch (err) {
			if (isAbortError(err)) throw err;
			log.error(`Error while downloading videos for ${game.gameUrl}`, err);
		}
	} else if (!videos) {
		log.info("Video downloads disabled as config setting is false");
	}

	// Written last so the file list reflects everything saved above.
	throwIfAborted(signal);
	if (config.download_manifest && productPage !== null) {
		try {
			const path = await writeManifest(game, productPage, gameDir, {
				includeKeys: config.manifest_include_keys,
				directory: relativeDir,
				prefix,
			});
			log.info(`Manifest written: ${path}`);
		} catch (err) {
			if (isAbortError(err)) throw err;
			log.error(`Error while writing manifest for ${game.gameUrl}`, err);
		}
	} else if (!config.download_manifest) {
		log.info("Manifest creation disabled as config setting is false");
	}
	return relativeDir;
}

async function fetchProductPage(
	client: ItchClient,
	gameUrl: string,
): Promise<string> {
	log.debug(`Downloading page: ${gameUrl}`);
	const res = await client.get(gameUrl);
	log.debug(`Got back response: ${res.status}`);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const html = await res.text();
	log.debug(`Page length: ${html.length}`);
	return html;
}

/**
 * Resolve every item's directory without the product page. Returns null when
 * the template needs page data (only known once the run reaches the item).
 */
function previewDirectory(
	name: DownloadName,
	game: Game,
	index: number,
	total: number,
	runStarted: Date,
): string | null {
	if (name.needsPage) return null;
	return resolveDownloadName(name, { game, index, total, runStarted });
}

/** Items that resolve to the same directory would be mixed together. */
function warnAboutCollisions(
	name: DownloadName,
	games: Game[],
	runStarted: Date,
): void {
	if (name.needsPage) return;
	const byDir = new Map<string, string[]>();
	for (const [i, g] of games.entries()) {
		const dir = previewDirectory(name, g, i + 1, games.length, runStarted);
		if (dir === null) return;
		byDir.set(dir, [...(byDir.get(dir) ?? []), g.title]);
	}
	for (const [dir, titles] of byDir) {
		if (titles.length > 1) {
			log.warn(
				`${titles.length} items share the directory "${dir}" with download_name = "${name.source}": ${titles.join(" / ")}`,
			);
		}
	}
}

/** Print the resolved item list with the numbers used by the resume file. */
export function printGameList(
	selection: Selection,
	name?: DownloadName,
	runStarted = new Date(),
): void {
	const total = selection.games.length;
	const width = String(total).length;
	for (const [i, g] of selection.games.entries()) {
		const dir = name
			? previewDirectory(name, g, i + 1, total, runStarted)
			: null;
		log.raw(
			`${String(i + 1).padStart(width)}  ${g.title}  [${g.author || "?"}]  ${g.dlurl}${dir !== null ? `\n${" ".repeat(width)}  -> ${dir}/` : ""}`,
		);
	}
	if (name?.needsPage) {
		log.info(
			`download_name = "${name.source}" uses product page data; directories are resolved when each item is processed.`,
		);
	}
}

/**
 * Download every file listed on the item's download page.
 * Returns true when at least one file was (re)downloaded.
 */
async function downloadGameFiles(
	client: ItchClient,
	config: Config,
	game: Game,
	gameDir: string,
): Promise<boolean> {
	const res = await client.get(game.dlurl);
	if (res.status !== 200) {
		log.error(`Could not access download page ${game.dlurl} [${res.status}]`);
		return false;
	}
	const page = parseDownloadPage(await res.text());
	let newDownloads = false;
	for (const upload of page.uploads) {
		log.debug(
			`fetch_upload - upload: ${JSON.stringify(upload)}. gameUrl: ${game.gameUrl}. key: ${game.key}. gamedirectory: ${game.itchSlug}`,
		);
		const downloaded = await fetchUpload(
			client,
			config,
			game,
			page,
			upload,
			gameDir,
		);
		newDownloads ||= downloaded;
	}
	return newDownloads;
}

/** Port of fetch_upload(): resolve the CDN URL of one upload and download it. */
async function fetchUpload(
	client: ItchClient,
	config: Config,
	game: Game,
	page: DownloadPage,
	upload: UploadRef,
	gameDir: string,
): Promise<boolean> {
	let url: string | null;
	try {
		url = await resolveUploadUrl(client, game, page, upload);
	} catch (err) {
		if (isAbortError(err)) throw err;
		log.warn(`Skipped a file: ${game.dlurl}`);
		log.error("", err);
		return false;
	}
	if (!url) return false;

	switch (classifyHost(url)) {
		case "cloudflare":
			// Signed, short-lived URLs without Last-Modified: keep the server's file name.
			return downloadFile(client, url, {
				dest: { dir: gameDir },
				showProgress: config.log_download_progress,
			});

		case "hwcdn": {
			const head = await withRetries("remote file check", async () => {
				const r = await client.head(url);
				if (!r.ok) throw new Error(`HEAD ${url} -> ${r.status}`);
				return r;
			});
			const lastModified = head.headers.get("last-modified");
			const remoteDate = lastModified ? new Date(lastModified) : new Date();
			const cd = head.headers.get("content-disposition");
			const serverName =
				(cd?.includes('"') ? cd.split('"')[1] : undefined) ??
				url.split("?")[0]?.split("/").pop() ??
				"download";

			// Unique, filesystem safe name with a date stamp, like the original:
			//   <n>_<slug>_<YYYYMMDD>.<ext>
			const safeName = `${upload.index}_${slugify(serverName, true)}`;
			const ext = extname(safeName);
			const stamped = ext
				? `${safeName.slice(0, -ext.length)}_${dateStamp(remoteDate)}${ext}`
				: `${safeName}_${dateStamp(remoteDate)}`;
			const undatedPath = join(gameDir, safeName);
			const finalPath = join(gameDir, stamped);
			await mkdir(gameDir, { recursive: true });

			// Files saved by older versions without a date stamp are renamed in place.
			if (
				await stat(undatedPath)
					.then((s) => s.isFile())
					.catch(() => false)
			) {
				await unlink(finalPath).catch(() => {});
				await rename(undatedPath, finalPath);
			}

			return withRetries("download", () =>
				downloadFile(client, url, {
					dest: { path: finalPath },
					showProgress: config.log_download_progress,
				}),
			);
		}

		case "google-drive":
			log.warn(`Download from Google Drive is UNSUPPORTED: ${url}`);
			return false;

		default:
			log.warn(`Skipped a file: ${url}`);
			return false;
	}
}
