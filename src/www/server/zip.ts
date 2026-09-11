// Stream a directory as a zip archive for the download browser. Pure JS via
// fflate, so it works everywhere the compiled binary runs; already-compressed
// kinds are stored as they are, everything else is deflated.

import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

/**
 * fflate writes 32-bit sizes and offsets (no Zip64): archives and entries
 * must stay below 4 GiB.
 */
export const ZIP_LIMIT = 4 * 1024 ** 3 - 1;

export class ZipTooLargeError extends Error {}

/** Compressing these again gains nothing: store them. */
const STORED = new Set([
	"zip",
	"rar",
	"7z",
	"gz",
	"tgz",
	"bz2",
	"xz",
	"dmg",
	"pkg",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"mp4",
	"webm",
	"mkv",
	"mov",
	"mp3",
	"ogg",
	"m4a",
	"flac",
	"pdf",
]);

export interface ZipOptions {
	/** Skip an entry by its file name. Default: hidden and `.incomplete` files. */
	exclude?: (name: string) => boolean;
	/** Name of the top-level folder inside the archive. Default: `basename(dir)`. */
	rootName?: string;
	/**
	 * Replace a file's content: called with the file's path on disk, bytes
	 * returned go into the archive instead of the file (null keeps the file).
	 */
	override?: (path: string) => Promise<Uint8Array | null>;
}

interface Entry {
	/** Path inside the archive. */
	name: string;
	path: string;
	size: number;
	mtime: Date;
	directory: boolean;
}

export function defaultExclude(name: string): boolean {
	return name.startsWith(".") || name.endsWith(".incomplete");
}

/** Every entry below `dir`, depth first, folders before their contents. */
async function collect(
	dir: string,
	prefix: string,
	exclude: (name: string) => boolean,
	out: Entry[],
): Promise<void> {
	const names = (await readdir(dir)).sort((a, b) => a.localeCompare(b));
	for (const name of names) {
		if (exclude(name)) continue;
		const path = join(dir, name);
		let s: Awaited<ReturnType<typeof stat>>;
		try {
			s = await stat(path);
		} catch {
			continue;
		}
		const archiveName = `${prefix}${name}`;
		if (s.isDirectory()) {
			out.push({
				name: `${archiveName}/`,
				path,
				size: 0,
				mtime: s.mtime,
				directory: true,
			});
			await collect(path, `${archiveName}/`, exclude, out);
		} else if (s.isFile()) {
			out.push({
				name: archiveName,
				path,
				size: s.size,
				mtime: s.mtime,
				directory: false,
			});
		}
	}
}

/** Total bytes of the files that would go into the archive. */
export async function zipSize(
	dir: string,
	opts: ZipOptions = {},
): Promise<number> {
	const entries: Entry[] = [];
	await collect(dir, "", opts.exclude ?? defaultExclude, entries);
	return entries.reduce((acc, e) => acc + e.size, 0);
}

/**
 * Zip `dir` (as `<rootName>/...`) into a byte stream. The archive is written
 * as files are read, with backpressure from the consumer; cancelling the
 * stream stops the work. Throws `ZipTooLargeError` before any output when
 * the content cannot fit in a 32-bit zip.
 */
export async function zipDirectory(
	dir: string,
	opts: ZipOptions = {},
): Promise<ReadableStream<Uint8Array>> {
	const root = opts.rootName ?? basename(dir);
	const entries: Entry[] = [];
	await collect(dir, `${root}/`, opts.exclude ?? defaultExclude, entries);
	const total = entries.reduce((acc, e) => acc + e.size, 0);
	if (total > ZIP_LIMIT || entries.some((e) => e.size > ZIP_LIMIT))
		throw new ZipTooLargeError(
			`The folder is ${(total / 1024 ** 3).toFixed(1)} GB; zips are limited to 4 GB.`,
		);

	let cancelled = false;
	let wake: (() => void) | null = null;
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				const zip = new Zip((err, chunk, final) => {
					if (cancelled) return;
					if (err) {
						controller.error(err);
						cancelled = true;
						return;
					}
					controller.enqueue(chunk);
					if (final) controller.close();
				});
				const waitForRoom = async () => {
					while (!cancelled && (controller.desiredSize ?? 1) <= 0) {
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
					}
				};
				const pump = async () => {
					for (const entry of entries) {
						if (cancelled) return;
						const ext = extname(entry.name).slice(1).toLowerCase();
						const file =
							entry.directory || STORED.has(ext)
								? new ZipPassThrough(entry.name)
								: new ZipDeflate(entry.name, { level: 6 });
						file.mtime = entry.mtime;
						zip.add(file);
						if (entry.directory) {
							file.push(new Uint8Array(0), true);
							continue;
						}
						const replaced = opts.override
							? await opts.override(entry.path)
							: null;
						if (replaced) {
							file.push(replaced, true);
							await waitForRoom();
							continue;
						}
						const reader = Bun.file(entry.path).stream().getReader();
						try {
							for (;;) {
								const { value, done } = await reader.read();
								if (cancelled) return;
								if (done) break;
								file.push(value);
								await waitForRoom();
							}
						} finally {
							reader.releaseLock();
						}
						file.push(new Uint8Array(0), true);
					}
					zip.end();
				};
				pump().catch((err) => {
					if (!cancelled) controller.error(err);
					cancelled = true;
				});
			},
			pull() {
				wake?.();
				wake = null;
			},
			cancel() {
				cancelled = true;
				wake?.();
			},
		},
		{ highWaterMark: 4 * 1024 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
	);
}
