// The batch run: build the item list, then for every item download its files,
// capture the product page and fetch embedded videos.

import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Config } from "../../models/config.ts";
import type { Product } from "../../models/product.ts";
import { isAbortError, throwIfAborted } from "../../utils/abort.ts";
import { log } from "../../utils/log.ts";
import { runPool } from "../../utils/pool.ts";
import { withRetries } from "../../utils/retry.ts";
import { slugify } from "../../utils/slugify.ts";
import { dateStamp, formatDuration } from "../../utils/time.ts";
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
	selectProducts,
} from "../selection/selection.ts";
import { VideoDownloader } from "../videos/videos.ts";
import { RateLimiter } from "./limiter.ts";
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
	product: Product;
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
	initialConfig: Config,
	opts: RunOptions = {},
): Promise<void> {
	const config = { ...initialConfig };
	await mkdir(config.download_directory, { recursive: true });
	if (config.create_log && !opts.dryRun)
		log.setFile(join(config.download_directory, LOG_FILE));
	log.info(`Download directory is '${config.download_directory}'`);
	const name = parseDownloadName(config.download_name);
	log.info(`Item directories follow download_name = "${name.source}"`);
	for (const warning of downloadNameWarnings(name)) log.warn(warning);
	const runStarted = new Date();
	const client = await createClient(config);

	const selection = await selectProducts(client, config);
	const products = selection.products;
	log.info(`${products.length} items found.`);
	reportUnclaimed(selection.unclaimed);
	warnAboutCollisions(name, products, runStarted);

	const parallel = config.parallel_downloads;
	const limiter = new RateLimiter({
		delay: config.download_delay,
		perHour: config.downloads_per_hour,
		pacing: config.download_pacing,
		parallel,
	});
	if (parallel > 1) {
		log.warn(
			`Processing ${parallel} items at a time; itch.io may answer with HTTP 429. The progress bar is off while running in parallel.`,
		);
		config.log_download_progress = false;
	}

	if (opts.dryRun) {
		printProductList(selection, name, runStarted);
		logRateLimits(limiter, parallel, products.length);
		return;
	}

	const tracker = new Tracker(
		config.download_directory,
		selectionFingerprint(config.bundles, config.authors, config.products),
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
	const remaining = products
		.map((product, i) => ({ product, number: i + 1 }))
		.filter(({ number }) => number >= resumeFrom);
	logRateLimits(limiter, parallel, remaining.length);

	const capturer = new PageCapturer(client.jar, {
		png: config.create_png,
		pdf: config.create_pdf,
		chromePath: config.chrome_path,
	});
	const videos = config.download_videos
		? new VideoDownloader(config.yt_dlp_path, {
				showProgress: config.log_download_progress,
			})
		: null;

	// The resume file points at the lowest item still in flight, so a resume
	// with several workers may redo up to parallel - 1 finished items.
	const inFlight = new Set<number>();
	const saveProgress = async () => {
		if (inFlight.size) await tracker.save(Math.min(...inFlight));
	};
	// Each worker's pause (download_delay) starts when its previous item ended.
	const finishedAt = new Map<number, number>();

	try {
		await runPool(remaining, parallel, async ({ product, number }, _i, ctx) => {
			const { lane, signal } = ctx;
			inFlight.add(number);
			await saveProgress();
			await limiter.acquire({
				item: number,
				total: products.length,
				previousFinishedAt: finishedAt.get(lane),
				signal,
			});
			log.raw();
			log.info(
				`Analysing item ${number} of ${products.length}. Title: ${product.slug}`,
			);
			try {
				await processItem({
					client,
					config,
					product,
					index: number,
					total: products.length,
					runStarted,
					name,
					capturer,
					videos,
					downloadDir: config.download_directory,
					signal,
				});
			} finally {
				finishedAt.set(lane, Date.now());
				inFlight.delete(number);
			}
			if (!signal.aborted) await saveProgress();
		});
		await tracker.save(0);
	} finally {
		capturer.close();
	}
}

/** The rate limits of the run and the waiting time they add up to. */
function logRateLimits(
	limiter: RateLimiter,
	parallel: number,
	items: number,
): void {
	const estimate = limiter.estimate(items, parallel);
	log.info(
		`Rate limits: ${limiter.describe(parallel)}${
			estimate !== null
				? ` - ${items} items take at least ~${formatDuration(estimate)}`
				: ""
		}`,
	);
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
		product,
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
			productPage = await fetchProductPage(client, product.productUrl);
		} catch (err) {
			if (isAbortError(err)) throw err;
			log.error(`Could not load product page ${product.productUrl}`, err);
		}
	}

	throwIfAborted(signal);
	let relativeDir: string;
	try {
		relativeDir = resolveDownloadName(name, {
			product,
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
	const productDir = join(downloadDir, relativeDir);
	// Generated files (cover, captures, manifest, videos) share this prefix.
	const prefix = basename(relativeDir);
	log.info(`Saving to ${relativeDir}`);
	await mkdir(productDir, { recursive: true });
	await writeMarker(productDir, product, name.source);

	let newDownloads = false;
	if (config.download_files) {
		try {
			newDownloads = await downloadProductFiles(
				client,
				config,
				product,
				productDir,
			);
		} catch (err) {
			if (isAbortError(err)) throw err;
			log.error(`Could not process download page ${product.dlurl}`, err);
		}
	} else {
		log.info("File downloads disabled as config setting is false");
	}

	if (config.download_artwork && productPage !== null) {
		try {
			await downloadCoverArtwork(
				client,
				productPage,
				product.productUrl,
				productDir,
				prefix,
				config.log_download_progress,
			);
		} catch (err) {
			if (isAbortError(err)) throw err;
			log.error(
				`Error while downloading cover artwork for ${product.productUrl}`,
				err,
			);
		}
	} else if (!config.download_artwork) {
		log.info("Cover artwork download disabled as config setting is false");
	}

	throwIfAborted(signal);
	if (capturer.enabled) {
		await capturer.capture(
			product.productUrl,
			productDir,
			prefix,
			newDownloads,
			signal,
		);
	} else if (!config.create_png && !config.create_pdf) {
		log.info("Screenshot/PDF creation disabled as config setting is false");
	}

	if (videos && productPage !== null) {
		try {
			await videos.download(productPage, productDir, prefix, signal);
		} catch (err) {
			if (isAbortError(err)) throw err;
			log.error(
				`Error while downloading videos for ${product.productUrl}`,
				err,
			);
		}
	} else if (!videos) {
		log.info("Video downloads disabled as config setting is false");
	}

	// Written last so the file list reflects everything saved above.
	throwIfAborted(signal);
	if (config.download_manifest && productPage !== null) {
		try {
			const path = await writeManifest(product, productPage, productDir, {
				includeKeys: config.manifest_include_keys,
				directory: relativeDir,
				prefix,
			});
			log.info(`Manifest written: ${path}`);
		} catch (err) {
			if (isAbortError(err)) throw err;
			log.error(`Error while writing manifest for ${product.productUrl}`, err);
		}
	} else if (!config.download_manifest) {
		log.info("Manifest creation disabled as config setting is false");
	}
	return relativeDir;
}

async function fetchProductPage(
	client: ItchClient,
	productUrl: string,
): Promise<string> {
	log.debug(`Downloading page: ${productUrl}`);
	const res = await client.get(productUrl);
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
	product: Product,
	index: number,
	total: number,
	runStarted: Date,
): string | null {
	if (name.needsPage) return null;
	return resolveDownloadName(name, { product, index, total, runStarted });
}

/** Items that resolve to the same directory would be mixed together. */
function warnAboutCollisions(
	name: DownloadName,
	products: Product[],
	runStarted: Date,
): void {
	if (name.needsPage) return;
	const byDir = new Map<string, string[]>();
	for (const [i, g] of products.entries()) {
		const dir = previewDirectory(name, g, i + 1, products.length, runStarted);
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
export function printProductList(
	selection: Selection,
	name?: DownloadName,
	runStarted = new Date(),
): void {
	const total = selection.products.length;
	const width = String(total).length;
	for (const [i, g] of selection.products.entries()) {
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
async function downloadProductFiles(
	client: ItchClient,
	config: Config,
	product: Product,
	productDir: string,
): Promise<boolean> {
	const res = await client.get(product.dlurl);
	if (res.status !== 200) {
		log.error(
			`Could not access download page ${product.dlurl} [${res.status}]`,
		);
		return false;
	}
	const page = parseDownloadPage(await res.text());
	let newDownloads = false;
	for (const upload of page.uploads) {
		log.debug(
			`fetch_upload - upload: ${JSON.stringify(upload)}. productUrl: ${product.productUrl}. key: ${product.key}. directory: ${product.itchSlug}`,
		);
		const downloaded = await fetchUpload(
			client,
			config,
			product,
			page,
			upload,
			productDir,
		);
		newDownloads ||= downloaded;
	}
	return newDownloads;
}

/** Port of fetch_upload(): resolve the CDN URL of one upload and download it. */
async function fetchUpload(
	client: ItchClient,
	config: Config,
	product: Product,
	page: DownloadPage,
	upload: UploadRef,
	productDir: string,
): Promise<boolean> {
	let url: string | null;
	try {
		url = await resolveUploadUrl(client, product, page, upload);
	} catch (err) {
		if (isAbortError(err)) throw err;
		log.warn(`Skipped a file: ${product.dlurl}`);
		log.error("", err);
		return false;
	}
	if (!url) return false;

	switch (classifyHost(url)) {
		case "cloudflare":
			// Signed, short-lived URLs without Last-Modified: keep the server's file name.
			return downloadFile(client, url, {
				dest: { dir: productDir },
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
			const undatedPath = join(productDir, safeName);
			const finalPath = join(productDir, stamped);
			await mkdir(productDir, { recursive: true });

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
