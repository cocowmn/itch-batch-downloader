import { mkdir, rename, stat, unlink, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { log } from "../../utils/log.ts";
import { compactTimestamp, timestamp } from "../../utils/time.ts";
import type { ItchClient } from "../itch/client.ts";

export interface DownloadOptions {
	/** Destination: either a directory (server supplied name is used) or a full path. */
	dest: { dir: string } | { path: string };
	/** Rename an existing file to `<name>_<timestamp>.old` instead of overwriting. */
	renameOld?: boolean;
	/** Skip when the local file has the same size and mtime as the remote one. */
	skipIfIdentical?: boolean;
	/**
	 * Draw a live progress bar. When false, a single line with size and speed
	 * is logged shortly after the download starts, then nothing until it ends.
	 */
	showProgress?: boolean;
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

function speedKbs(downloaded: number, startedAt: number): number {
	const elapsed = (Date.now() - startedAt) / 1000;
	return downloaded / 1024 / (elapsed || 1);
}

function isCompressed(res: Response): boolean {
	const enc = res.headers.get("content-encoding")?.toLowerCase();
	return !!enc && enc !== "identity";
}

function isCloudflare(url: string): boolean {
	return (
		url.startsWith("https://itchio-mirror.") ||
		url.startsWith("https://r2.cloudflarestorage.com")
	);
}

export function filenameFromResponse(res: Response, url: string): string {
	const cd = res.headers.get("content-disposition");
	if (cd) {
		const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
		if (star?.[1]) {
			try {
				return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
			} catch {
				// fall through to plain filename
			}
		}
		const plain = /filename=("?)([^";]+)\1/i.exec(cd);
		if (plain?.[2]) return plain[2].trim();
	}
	const path = url.split("?")[0] ?? "";
	return decodeURIComponent(path.split("/").pop() || "download");
}

function progressBar(
	downloaded: number,
	total: number,
	name: string,
	startedAt: number,
): void {
	const kbs = speedKbs(downloaded, startedAt);
	const prefix = `${timestamp()} [INFO] ${mb(downloaded)}/${mb(total)} MB (${kbs.toFixed(1)} KB/s)`;
	const columns = process.stdout.columns ?? 80;
	const length = Math.max(10, columns - 1 - prefix.length - name.length - 4);
	const filled =
		total > 0 ? Math.min(length, Math.floor((length * downloaded) / total)) : 0;
	const bar = "X".repeat(filled) + "-".repeat(length - filled);
	log.progress(`${prefix} |${bar}| ${name}`);
}

/**
 * Port of dltool.download_a_file(). Downloads `url` to disk, showing a
 * progress bar, writing to a `.incomplete` file first and restoring the
 * remote Last-Modified timestamp. Returns true when a file was written.
 */
export async function downloadFile(
	client: ItchClient,
	url: string,
	opts: DownloadOptions,
): Promise<boolean> {
	const cloudflare = isCloudflare(url);
	const renameOld = opts.renameOld ?? true;
	const skipIfIdentical = opts.skipIfIdentical ?? true;
	const showProgress = opts.showProgress ?? true;

	// Signed Cloudflare URLs are time limited: do a single GET and stream it.
	// For the regular CDN we HEAD first so we can compare metadata.
	const head: Response = cloudflare
		? await client.get(url)
		: await client.head(url);
	if (head.status !== 200) {
		log.error(
			`${cloudflare ? "GET" : "HEAD"} request failed (${head.status}) for ${url}`,
		);
		return false;
	}

	const rawName = filenameFromResponse(head, url);
	const finalPath =
		"path" in opts.dest ? opts.dest.path : join(opts.dest.dir, rawName);
	await mkdir(dirname(finalPath), { recursive: true });

	const lastModified = head.headers.get("last-modified");
	const remoteTime = lastModified ? new Date(lastModified) : null;
	// fetch() transparently decompresses; a compressed transfer's content-length
	// does not describe the bytes that end up on disk.
	const compressed = isCompressed(head);
	const remoteSize = compressed
		? 0
		: Number(head.headers.get("content-length") ?? 0);

	const existing = await stat(finalPath).catch(() => null);
	if (
		existing?.isFile() &&
		skipIfIdentical &&
		!cloudflare &&
		remoteTime &&
		remoteSize
	) {
		if (
			Math.floor(existing.mtimeMs / 1000) ===
				Math.floor(remoteTime.getTime() / 1000) &&
			existing.size === remoteSize
		) {
			log.info(`File ${finalPath} already fully downloaded - skipping`);
			return false;
		}
	}

	let stream: Response = head;
	if (!cloudflare) {
		stream = await client.get(url);
		if (stream.status !== 200) {
			log.error(`GET request failed (${stream.status}) for ${url}`);
			return false;
		}
	}

	if (existing?.isFile() && renameOld) {
		const oldName = `${finalPath}_${compactTimestamp()}.old`;
		log.info(`Renaming ${finalPath} -> ${oldName}`);
		await unlink(oldName).catch(() => {});
		await rename(finalPath, oldName);
	}

	const total = isCompressed(stream)
		? 0
		: Number(stream.headers.get("content-length") ?? 0);
	const totalNote = total ? ` (${mb(total)} MB)` : "";
	if (log.isDebug())
		log.debug(`Starting download of ${url} -> ${finalPath}${totalNote}`);
	else log.info(`Starting download of ${finalPath}${totalNote}`);

	const incomplete = `${finalPath}.incomplete`;
	const startedAt = Date.now();
	let downloaded = 0;
	let lastDraw = 0;
	// The live bar needs a terminal; otherwise fall back to the quiet mode.
	const liveBar = showProgress && process.stdout.isTTY === true;
	let speedReported = false;

	const writer = Bun.file(incomplete).writer();
	try {
		if (!stream.body) throw new Error("Empty response body");
		for await (const chunk of stream.body) {
			writer.write(chunk);
			downloaded += chunk.byteLength;
			const now = Date.now();
			if (liveBar) {
				if (now - lastDraw > 100) {
					progressBar(downloaded, total, basename(finalPath), startedAt);
					lastDraw = now;
				}
			} else if (!speedReported && now - startedAt >= 1000) {
				// Quiet mode: one line with the size and the current speed.
				speedReported = true;
				log.info(
					`Downloading ${basename(finalPath)}: ${mb(downloaded)}/${total ? mb(total) : "?"} MB so far at ${speedKbs(downloaded, startedAt).toFixed(1)} KB/s`,
				);
			}
		}
		await writer.end();
	} catch (err) {
		try {
			await writer.end();
		} catch {}
		await unlink(incomplete).catch(() => {});
		throw err;
	}
	if (liveBar) {
		progressBar(
			downloaded,
			total || downloaded,
			basename(finalPath),
			startedAt,
		);
		log.progressDone();
	}
	log.info(
		`Downloaded ${mb(downloaded)} MB in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${speedKbs(downloaded, startedAt).toFixed(1)} KB/s): ${basename(finalPath)}`,
	);

	await rename(incomplete, finalPath);

	const onDisk = (await stat(finalPath)).size;
	log.debug(`filename: ${finalPath}, disk: ${onDisk}, http: ${total}`);
	if (total && onDisk !== total) {
		log.info("Size on Disk differs from HTTP");
		return false;
	}

	if (remoteTime && !Number.isNaN(remoteTime.getTime())) {
		await utimes(finalPath, remoteTime, remoteTime);
	}
	return true;
}
