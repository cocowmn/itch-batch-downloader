// Download videos embedded (iframe) in the public product page with yt-dlp.

import { join } from "node:path";
import { load } from "cheerio";
import { throwIfAborted } from "../../utils/abort.ts";
import { log } from "../../utils/log.ts";

const PREFIX = "External links downloader:";

export function normalizeEmbedUrl(src: string): string {
	if (src.startsWith("//")) return `https:${src}`;
	if (src.startsWith("http://") || src.startsWith("https://")) return src;
	return `https://${src.replace(/^\/+/, "")}`;
}

export function findEmbeddedVideos(html: string): string[] {
	const $ = load(html);
	const urls: string[] = [];
	$("iframe[src]").each((_, el) => {
		const src = $(el).attr("src");
		if (src) urls.push(normalizeEmbedUrl(src));
	});
	return urls;
}

export interface VideoOptions {
	/**
	 * Log yt-dlp's per-percentage progress lines. When false only the start
	 * and the end of each download are logged, like log_download_progress.
	 */
	showProgress?: boolean;
}

/** yt-dlp's live progress: `[download]  81.9% of 35.77MiB at 14.83MiB/s ETA 00:00`. */
const PROGRESS_LINE = /^\[download\]\s+\d+(?:\.\d+)?% of/;

export class VideoDownloader {
	private readonly binary: string | null;
	private warned = false;
	private readonly showProgress: boolean;

	constructor(ytDlpPath: string, opts: VideoOptions = {}) {
		this.showProgress = opts.showProgress ?? true;
		this.binary =
			Bun.which(ytDlpPath) ??
			(ytDlpPath.includes("/") || ytDlpPath.includes("\\") ? ytDlpPath : null);
	}

	/** Download the videos embedded in the product page `html`. */
	async download(
		html: string,
		dir: string,
		prefix: string,
		signal?: AbortSignal,
	): Promise<void> {
		const urls = findEmbeddedVideos(html);
		if (urls.length === 0) return;
		throwIfAborted(signal);

		if (!this.binary) {
			if (!this.warned) {
				log.warn(
					`yt-dlp not found; embedded videos will not be downloaded. Install yt-dlp or set yt_dlp_path.`,
				);
				this.warned = true;
			}
			for (const url of urls)
				log.warn(`Skipping video (yt-dlp missing): ${url}`);
			return;
		}

		for (const url of urls) {
			throwIfAborted(signal);
			log.info(`Found video URL: ${url}`);
			const proc = Bun.spawn(
				[
					this.binary,
					"--ignore-errors",
					"--no-warnings",
					"--newline",
					"-o",
					join(dir, `${prefix}_%(id)s.%(ext)s`),
					url,
				],
				{ stdout: "pipe", stderr: "pipe", stdin: "ignore" },
			);
			const kill = () => proc.kill();
			signal?.addEventListener("abort", kill, { once: true });
			await Promise.all([
				pipeLines(proc.stdout, (l) => {
					if (!this.showProgress && PROGRESS_LINE.test(l)) return;
					log.info(`${PREFIX} ${l}`);
				}),
				pipeLines(proc.stderr, (l) => logStderr(l)),
			]);
			const code = await proc.exited;
			signal?.removeEventListener("abort", kill);
			throwIfAborted(signal);
			if (code !== 0)
				log.warn(`${PREFIX} yt-dlp exited with code ${code} for ${url}`);
			else log.info(`${PREFIX} done downloading ${url}`);
		}
	}
}

function logStderr(line: string): void {
	if (/^ERROR/i.test(line)) log.error(`${PREFIX} ${line}`);
	else if (/^WARNING/i.test(line)) log.warn(`${PREFIX} ${line}`);
	else if (line.startsWith("[debug]")) log.debug(`${PREFIX} ${line}`);
	else log.info(`${PREFIX} ${line}`);
}

async function pipeLines(
	stream: ReadableStream<Uint8Array> | null,
	onLine: (line: string) => void,
): Promise<void> {
	if (!stream) return;
	let buffer = "";
	const decoder = new TextDecoder();
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
			const line = buffer.slice(0, nl).replace(/\r$/, "").trim();
			buffer = buffer.slice(nl + 1);
			if (line) onLine(line);
		}
	}
	const rest = buffer.trim();
	if (rest) onLine(rest);
}
