// "Download from itch.io" jobs of the download browser: fetch one item again
// with the CLI pipeline into a temporary directory, then hand it out as a
// zip. One job at a time; the temp directory is removed after the download,
// on cancel, on expiry and on exit.

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
import { zipDirectory, zipSize } from "./zip.ts";

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
	/** `<tmp>/<slug>`, set once the pipeline created it. */
	itemDir: string | null;
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
	 * Fetch the item in `directory` (relative to the root) again. Throws a
	 * `JobError` when another job is running, the item cannot be fetched or
	 * the cookie file is missing.
	 */
	async start(directory: string): Promise<JobStatus> {
		if (this.current?.status.state === "running")
			throw new JobError("Another download is already running.", 409);
		const prefix = basename(directory);
		const manifest = await readManifest(
			join(this.root, ...directory.split("/"), `${prefix}${MANIFEST_SUFFIX}`),
		);
		if (!manifest)
			throw new JobError("This item has no manifest to fetch it from.", 400);
		const dlurl = manifest.urls?.downloadPage;
		if (!dlurl)
			throw new JobError(
				"The manifest has no download page: run the downloader with manifest_include_keys = true.",
				400,
			);
		const product = productFromDownloadUrl(manifest.title, dlurl, {
			productUrl: manifest.urls.page,
			authorName: manifest.author?.name,
		});
		if (!product)
			throw new JobError("The manifest's download page URL is unusable.", 400);
		product.bundles = manifest.bundles
			.filter((b): b is Bundle => Boolean(b.key && b.url))
			.map((b) => ({ name: b.name, key: b.key, url: b.url }));
		if (!(await Bun.file(this.config.cookie_file).exists()))
			throw new JobError(
				`Cookie file ${this.config.cookie_file} not found; the server needs your itch.io session to download.`,
				400,
			);

		// A previous, finished job gives up its files now.
		if (this.current) await this.cleanup(this.current);

		const tmp = await mkdtemp(join(tmpdir(), "itch-fetch-"));
		const controller = new AbortController();
		const status: JobStatus = {
			id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			state: "running",
			directory,
			title: manifest.title,
			message: "",
			log: [],
			startedAt: new Date().toISOString(),
			finishedAt: null,
			size: null,
		};
		const job: Job = {
			status,
			tmp,
			itemDir: null,
			controller,
			finished: Promise.resolve(),
			expiry: null,
		};
		this.current = job;
		job.finished = this.runJob(job, product).catch((err) => {
			log.error("Download job crashed", err);
		});
		return status;
	}

	private async runJob(job: Job, product: Product): Promise<void> {
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
		let capturer: PageCapturer | null = null;
		try {
			log.raw();
			log.info(
				`Download job for '${product.slug}' started by the download browser`,
			);
			const client = await createClient(config, controller.signal);
			capturer = new PageCapturer(client.jar, {
				png: config.create_png,
				pdf: config.create_pdf,
				chromePath: config.chrome_path,
			});
			const videos = config.download_videos
				? new VideoDownloader(config.yt_dlp_path)
				: null;
			const relative = await processItem({
				client,
				config,
				product,
				index: 1,
				total: 1,
				runStarted: new Date(),
				name: parseDownloadName(config.download_name),
				capturer,
				videos,
				downloadDir: job.tmp,
				signal: controller.signal,
			});
			if (!relative) throw new Error("The item was skipped by the pipeline.");
			job.itemDir = join(job.tmp, relative);
			status.size = await zipSize(job.itemDir);
			status.state = "done";
			status.message = "Ready to download.";
			log.info(`Download job for '${product.slug}' finished`);
			job.expiry = setTimeout(() => {
				this.cleanup(job).catch(() => {});
			}, EXPIRY_MS);
		} catch (err) {
			if (isAbortError(err) || controller.signal.aborted) {
				status.state = "cancelled";
				status.message = "Cancelled.";
				log.info(`Download job for '${product.slug}' cancelled`);
			} else {
				status.state = "failed";
				status.message = err instanceof Error ? err.message : String(err);
				log.error(`Download job for '${product.slug}' failed`, err);
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
		if (!job.itemDir) return null;
		const reader = (await zipDirectory(job.itemDir)).getReader();
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
		return { stream, name: `${basename(job.itemDir)}.zip` };
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
