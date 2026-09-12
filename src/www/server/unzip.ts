// Extract a zip archive next to itself, the way Archive Utility does: the
// entries are unpacked into a staging directory first, then land beside the
// archive either as they are (a single top-level file or folder) or wrapped
// in a folder named after the archive. Nothing is ever overwritten: a name
// that is taken gets " (1)", " (2)", ... appended. Streams through fflate so
// archives larger than memory work.

import {
	type FileHandle,
	mkdir,
	open,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { Unzip, UnzipInflate } from "fflate";

export class UnzipError extends Error {}

/** Finder's resource-fork sidecars; never wanted on extraction. */
const IGNORED_TOP_LEVEL = new Set(["__MACOSX"]);
/** Bytes of the archive read per push. */
const CHUNK = 1024 * 1024;
/** Zip compression methods fflate can expand: stored and deflate. */
const SUPPORTED = new Set([0, 8]);

export interface UnzipResult {
	/** Name of the file or folder created next to the archive. */
	created: string;
}

/**
 * The first of `name`, `name (1)`, `name (2)`, ... that does not exist in
 * `dir`. The counter goes before the extension of a file (`readme (1).txt`)
 * and at the end of a folder name.
 */
export async function availableName(
	dir: string,
	name: string,
	isDirectory: boolean,
): Promise<string> {
	const ext = isDirectory ? "" : extname(name);
	const base = name.slice(0, name.length - ext.length);
	for (let n = 0; ; n++) {
		const candidate = n === 0 ? name : `${base} (${n})${ext}`;
		if (!(await exists(join(dir, candidate)))) return candidate;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * The path segments of an entry name, or null for an entry that must not be
 * written: absolute paths and `..` would escape the target folder.
 */
export function entrySegments(name: string): string[] | null {
	const segments = name
		.replace(/\\/g, "/")
		.split("/")
		.filter((s) => s !== "" && s !== ".");
	if (segments.some((s) => s === ".." || s.includes("\0"))) return null;
	return segments;
}

/**
 * Extract `zipPath` next to itself and return what was created. Throws
 * `UnzipError` for a broken or unsafe archive (nothing is left behind).
 */
export async function extractZip(zipPath: string): Promise<UnzipResult> {
	const dir = dirname(zipPath);
	const archiveName = basename(zipPath, extname(zipPath)) || "archive";
	const staging = join(dir, `.unzip-${crypto.randomUUID().slice(0, 8)}`);
	await mkdir(staging);
	try {
		const { topLevel, entries } = await unpack(zipPath, staging);
		if (entries === 0)
			throw new UnzipError("Not a zip archive, or an empty one.");
		if (topLevel.size === 0) throw new UnzipError("The archive is empty.");
		const [only] = topLevel;
		if (only !== undefined && topLevel.size === 1) {
			// A lone file or folder comes out on its own, like Archive Utility.
			const isDirectory = (await stat(join(staging, only))).isDirectory();
			const created = await availableName(dir, only, isDirectory);
			await rename(join(staging, only), join(dir, created));
			return { created };
		}
		const created = await availableName(dir, archiveName, true);
		await rename(staging, join(dir, created));
		return { created };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/**
 * Stream the archive into `target`; resolves with the names created at its
 * top level and the number of entries seen. The next chunk of the archive
 * is only read once everything the previous one produced is on disk, which
 * bounds memory use.
 */
async function unpack(
	zipPath: string,
	target: string,
): Promise<{ topLevel: Set<string>; entries: number }> {
	const topLevel = new Set<string>();
	let entries = 0;
	const unzipper = new Unzip();
	unzipper.register(UnzipInflate);
	/** Disk writes queued by the callbacks, awaited between pushes. */
	let pending: Promise<void> = Promise.resolve();
	let failure: Error | null = null;
	const fail = (err: Error) => {
		failure ??= err;
	};
	const enqueue = (work: () => Promise<void>) => {
		pending = pending.then(work).catch(fail);
	};
	/** Files being written, closed on the way out should extraction fail. */
	const openHandles = new Set<FileHandle>();

	unzipper.onfile = (file) => {
		entries++;
		const segments = entrySegments(file.name);
		if (!segments) {
			fail(new UnzipError(`Unsafe path in the archive: ${file.name}`));
			return;
		}
		const [top] = segments;
		if (!top || IGNORED_TOP_LEVEL.has(top)) return;
		const isDirectory = file.name.endsWith("/");
		const path = join(target, ...segments);
		topLevel.add(top);
		if (isDirectory) {
			enqueue(async () => {
				await mkdir(path, { recursive: true });
			});
			return;
		}
		if (!SUPPORTED.has(file.compression)) {
			fail(
				new UnzipError(
					`${file.name} uses an unsupported compression method (${file.compression}).`,
				),
			);
			return;
		}
		let handle: FileHandle | null = null;
		file.ondata = (err, data, final) => {
			if (err) {
				fail(new UnzipError(`Could not read ${file.name}: ${err.message}`));
				return;
			}
			enqueue(async () => {
				let h = handle;
				if (!h) {
					await mkdir(dirname(path), { recursive: true });
					h = await open(path, "w");
					handle = h;
					openHandles.add(h);
				}
				if (data.length) await h.write(data);
				if (final) {
					openHandles.delete(h);
					handle = null;
					await h.close();
				}
			});
		};
		file.start();
	};

	const fd = await open(zipPath, "r");
	try {
		const buffer = new Uint8Array(CHUNK);
		const size = (await fd.stat()).size;
		let offset = 0;
		for (;;) {
			const { bytesRead } = await fd.read(buffer, 0, CHUNK, offset);
			offset += bytesRead;
			const final = offset >= size || bytesRead === 0;
			try {
				unzipper.push(buffer.slice(0, bytesRead), final);
			} catch (err) {
				throw new UnzipError(
					`Not a valid zip archive: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			await pending;
			if (failure) throw failure;
			if (final) break;
		}
	} finally {
		await fd.close();
		for (const h of openHandles) await h.close().catch(() => {});
	}
	return { topLevel, entries };
}
