// Stream a directory as a zip archive for the download browser. Pure JS via
// zip.js, so it works everywhere the compiled binary runs; already-compressed
// kinds are stored as they are, everything else is deflated. Entries and
// archives past 4 GiB (or 65535 entries) get Zip64 records automatically,
// so there is no size limit beyond what the client is willing to download.

import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { configure, ZipWriter } from "@zip.js/zip.js";

// No worker threads: the compiled binary cannot ship zip.js's worker script,
// and deflate goes through Bun's native CompressionStream anyway.
configure({ useWebWorkers: false });

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
 * stream stops the work.
 */
export async function zipDirectory(
	dir: string,
	opts: ZipOptions = {},
): Promise<ReadableStream<Uint8Array>> {
	const root = opts.rootName ?? basename(dir);
	const entries: Entry[] = [];
	await collect(dir, `${root}/`, opts.exclude ?? defaultExclude, entries);

	// zip.js writes into the writable side; the readable side is the response.
	// The queue is sized in bytes so a slow client stalls the reads, not RAM.
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(
		{},
		{ highWaterMark: 4 * 1024 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
		{ highWaterMark: 0 },
	);
	const zip = new ZipWriter(writable, { dataDescriptor: true });
	const pump = async () => {
		for (const entry of entries) {
			if (entry.directory) {
				await zip.add(entry.name, undefined, {
					directory: true,
					lastModDate: entry.mtime,
				});
				continue;
			}
			const ext = extname(entry.name).slice(1).toLowerCase();
			const options = {
				lastModDate: entry.mtime,
				level: STORED.has(ext) ? 0 : 6,
			};
			const replaced = opts.override ? await opts.override(entry.path) : null;
			// The size hint lets zip.js keep 32-bit records for small entries.
			const reader = replaced
				? { readable: new Blob([replaced]).stream(), size: replaced.byteLength }
				: { readable: Bun.file(entry.path).stream(), size: entry.size };
			await zip.add(entry.name, reader, options);
		}
		await zip.close();
	};
	pump().catch((err) => {
		// A cancelled response already errored the writable; anything else
		// (an unreadable file, a mid-way failure) errors it here so the
		// consumer sees a broken stream rather than a truncated zip.
		writable.abort(err).catch(() => {});
	});
	return readable;
}
