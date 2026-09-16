// "Download from itch.io" jobs of the download browser: fetch one item (or a
// selection of items) again with the CLI pipeline into a temporary
// directory, then hand it out as a zip. One job at a time; the temp
// directory is removed after the download, on cancel, on expiry and on exit.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PageCapturer } from "../../features/capture/capture.ts";
import { processItem } from "../../features/download/pipeline.ts";
import { createClient } from "../../features/itch/client.ts";
import { productFromDownloadUrl } from "../../features/itch/purchases.ts";
import { MANIFEST_SUFFIX } from "../../features/manifest/manifest.ts";
import { parseDownloadName } from "../../features/naming/naming.ts";
import { VideoDownloader } from "../../features/videos/videos.ts";
import type { Config } from "../../models/config.ts";
import type { JobStatus } from "../../models/jobs.ts";
import type { Bundle, Product } from "../../models/product.ts";
import { isAbortError } from "../../utils/abort.ts";
import { log } from "../../utils/log.ts";
import { readManifest } from "./library.ts";
import { cleanArchiveName, zipDirectory, zipSize } from "./zip.ts";

/** Thrown by `start()`; `status` is the HTTP status to answer with. */
export class JobError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

interface Job {
	status: JobStatus;
	tmp: string;
	/** `<tmp>/<slug>` of each item the pipeline finished. */
	itemDirs: string[];
	/**
	 * A batch: the zip holds a folder per item under this name. A single
	 * item is zipped as its own folder instead.
	 */
	archiveName: string | null;
	controller: AbortController;
	/** Settles when the pipeline is finished, whatever the outcome. */
	finished: Promise<void>;
	expiry: ReturnType<typeof setTimeout> | null;
}

const LOG_LINES = 30;
/** A finished job's files are kept this long for the download. */
const EXPIRY_MS = 10 * 60 * 1000;

export class FetchJobs {
	private current: Job | null = null;

	constructor(
		private readonly config: Config,
		private readonly root: string,
	) {}

	/** The job that is running or was last finished, if any. */
	currentStatus(): JobStatus | null {
		return this.current?.status ?? null;
	}

	get(id: string): JobStatus | null {
		return this.current?.status.id === id ? this.current.status : null;
	}

	/**
	 * Fetch the items in `directories` (relative to the root) again; with
	 * more than one, the zip is named `archiveName` and holds a folder per
	 * item. Throws a `JobError` when another job is running, an item cannot
	 * be fetched or the cookie file is missing.
	 */
	async start(
		directories: string[],
		archiveName?: string | null,
	): Promise<JobStatus> {
		if (this.current?.status.state === "running")
			throw new JobError("Another download is already running.", 409);
		if (directories.length === 0)
			throw new JobError("Nothing to download.", 400);
		const products: Product[] = [];
		for (const directory of directories)
			products.push(await this.product(directory, directories.length > 1));
		if (!(await Bun.file(this.config.cookie_file).exists()))
			throw new JobError(
				`Cookie file ${this.config.cookie_file} not found; the server needs your itch.io session to download.`,
				400,
			);

		// A previous, finished job gives up its files now.
		if (this.current) await this.cleanup(this.current);

		const tmp = await mkdtemp(join(tmpdir(), "itch-fetch-"));
		const controller = new AbortController();
		const batch = products.length > 1;
		const status: JobStatus = {
			id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			state: "running",
			directories,
			title: batch ? `${products.length} items` : (products[0]?.title ?? ""),
			completed: 0,
			message: "",
			log: [],
			startedAt: new Date().toISOString(),
			finishedAt: null,
			size: null,
		};
		const job: Job = {
			status,
			tmp,
			itemDirs: [],
			archiveName: batch ? cleanArchiveName(archiveName) : null,
			controller,
			finished: Promise.resolve(),
			expiry: null,
		};
		this.current = job;
		job.finished = this.runJob(job, products).catch((err) => {
			log.error("Download job crashed", err);
		});
		return status;
	}

	/** The product an item's manifest describes, or why it cannot be fetched. */
	private async product(directory: string, named: boolean): Promise<Product> {
		const prefix = basename(directory);
		const which = named ? ` (${directory})` : "";
		const manifest = await readManifest(
			join(this.root, ...directory.split("/"), `${prefix}${MANIFEST_SUFFIX}`),
		);
		if (!manifest)
			throw new JobError(
				`This item has no manifest to fetch it from${which}.`,
				400,
			);
		const dlurl = manifest.urls?.downloadPage;
		if (!dlurl)
			throw new JobError(
				`The manifest has no download page${which}: run the downloader with manifest_include_keys = true.`,
				400,
			);
		const product = productFromDownloadUrl(manifest.title, dlurl, {
			productUrl: manifest.urls.page,
			authorName: manifest.author?.name,
		});
		if (!product)
			throw new JobError(
				`The manifest's download page URL is unusable${which}.`,
				400,
			);
		product.bundles = manifest.bundles
			.filter((b): b is Bundle => Boolean(b.key && b.url))
			.map((b) => ({ name: b.name, key: b.key, url: b.url }));
		return product;
	}

	private async runJob(job: Job, products: Product[]): Promise<void> {
		const { status, controller } = job;
		const untap = log.tap((line) => {
			status.log.push(line);
			if (status.log.length > LOG_LINES) status.log.shift();
		});
		// Keys never travel to a phone: the zip's manifest is written without them.
		const config: Config = {
			...this.config,
			download_name: "{slug}",
			manifest_include_keys: false,
			log_download_progress: false,
		};
		const what =
			products.length === 1
				? `'${products[0]?.slug}'`
				: `${products.length} items`;
		let capturer: PageCapturer | null = null;
		try {
			log.raw();
			log.info(`Download job for ${what} started by the download browser`);
			const client = await createClient(config, controller.signal);
			capturer = new PageCapturer(client.jar, {
				png: config.create_png,
				pdf: config.create_pdf,
				chromePath: config.chrome_path,
			});
			const videos = config.download_videos
				? new VideoDownloader(config.yt_dlp_path, {
						showProgress: config.log_download_progress,
					})
				: null;
			const runStarted = new Date();
			const name = parseDownloadName(config.download_name);
			const failed: string[] = [];
			for (const [i, product] of products.entries()) {
				if (products.length > 1) {
					log.raw();
					log.info(
						`Analysing item ${i + 1} of ${products.length}. Title: ${product.slug}`,
					);
				}
				try {
					const relative = await processItem({
						client,
						config,
						product,
						index: i + 1,
						total: products.length,
						runStarted,
						name,
						capturer,
						videos,
						downloadDir: job.tmp,
						signal: controller.signal,
					});
					if (!relative)
						throw new Error("The item was skipped by the pipeline.");
					job.itemDirs.push(join(job.tmp, relative));
				} catch (err) {
					// One item failing does not sink a batch; a single item does.
					if (isAbortError(err) || products.length === 1) throw err;
					log.error(`Could not fetch '${product.slug}'`, err);
					failed.push(product.title);
				}
				status.completed = i + 1;
			}
			if (job.itemDirs.length === 0)
				throw new Error("None of the items could be fetched.");
			status.size = await zipSize(job.tmp);
			status.state = "done";
			status.message = failed.length
				? `Ready to download; ${failed.length} of ${products.length} items could not be fetched: ${failed.join(", ")}.`
				: "Ready to download.";
			log.info(`Download job for ${what} finished`);
			job.expiry = setTimeout(() => {
				this.cleanup(job).catch(() => {});
			}, EXPIRY_MS);
		} catch (err) {
			if (isAbortError(err) || controller.signal.aborted) {
				status.state = "cancelled";
				status.message = "Cancelled.";
				log.info(`Download job for ${what} cancelled`);
			} else {
				status.state = "failed";
				status.message = err instanceof Error ? err.message : String(err);
				log.error(`Download job for ${what} failed`, err);
			}
			await rm(job.tmp, { recursive: true, force: true }).catch(() => {});
		} finally {
			status.finishedAt = new Date().toISOString();
			capturer?.close();
			untap();
		}
	}

	/** Abort a running job (its temp files go away once the pipeline stops). */
	async cancel(id: string): Promise<boolean> {
		const job = this.current;
		if (!job || job.status.id !== id) return false;
		if (job.status.state === "running") {
			job.controller.abort();
			await job.finished;
		} else {
			await this.cleanup(job);
		}
		return true;
	}

	/**
	 * The finished job's item as a zip stream. The temp directory is removed
	 * when the stream ends (or breaks).
	 */
	async download(
		id: string,
	): Promise<{ stream: ReadableStream<Uint8Array>; name: string } | null> {
		const job = this.current;
		if (!job || job.status.id !== id || job.status.state !== "done")
			return null;
		const [itemDir] = job.itemDirs;
		if (!itemDir) return null;
		// A batch zips the whole temp directory: one folder per item.
		const name = job.archiveName ?? basename(itemDir);
		const reader = (
			await (job.archiveName
				? zipDirectory(job.tmp, { rootName: job.archiveName })
				: zipDirectory(itemDir))
		).getReader();
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			this.cleanup(job).catch(() => {});
		};
		// Pass the zip through so the end (or a broken connection) is noticed.
		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				const { value, done } = await reader.read();
				if (done) {
					controller.close();
					finish();
				} else {
					controller.enqueue(value);
				}
			},
			cancel(reason) {
				reader.cancel(reason).catch(() => {});
				finish();
			},
		});
		return { stream, name: `${name}.zip` };
	}

	private async cleanup(job: Job): Promise<void> {
		if (job.expiry) clearTimeout(job.expiry);
		job.expiry = null;
		if (job.status.state === "running") {
			job.controller.abort();
			await job.finished;
		}
		await rm(job.tmp, { recursive: true, force: true }).catch(() => {});
		if (this.current === job && job.status.state !== "running")
			this.current = null;
	}

	/** Cancel whatever runs and remove the temp files; for server shutdown. */
	async shutdown(): Promise<void> {
		if (this.current) await this.cleanup(this.current);
	}
}
