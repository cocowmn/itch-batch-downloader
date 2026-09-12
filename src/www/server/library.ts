// Scan the download directory into the structure the download browser shows.
// Item directories are found by their .itchio marker at any depth (the
// download_name template may nest them); directories at the top level without
// a marker are treated as items of the flat layout older versions produced.
// Titles and authors come from the manifest, else the marker, else the name.

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { COVER_SUFFIX } from "../../features/artwork/artwork.ts";
import { MANIFEST_SUFFIX } from "../../features/manifest/manifest.ts";
import {
	isMarkerHidden,
	MARKER_FILE,
	readMarker,
} from "../../features/manifest/marker.ts";
import type {
	FileKind,
	FileRole,
	ItemResponse,
	LibraryCapture,
	LibraryFile,
	LibraryItem,
	LibraryResponse,
} from "../../models/library.ts";
import type { Manifest } from "../../models/manifest.ts";
import { isSystemFile } from "../../utils/system-files.ts";

const KINDS: Record<string, FileKind> = {
	zip: "archive",
	rar: "archive",
	"7z": "archive",
	gz: "archive",
	tgz: "archive",
	bz2: "archive",
	xz: "archive",
	tar: "archive",
	dmg: "archive",
	pkg: "archive",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	svg: "image",
	bmp: "image",
	psd: "image",
	ase: "image",
	aseprite: "image",
	mp3: "audio",
	wav: "audio",
	ogg: "audio",
	flac: "audio",
	m4a: "audio",
	mp4: "video",
	webm: "video",
	mkv: "video",
	mov: "video",
	pdf: "document",
	txt: "document",
	md: "document",
	doc: "document",
	docx: "document",
	rtf: "document",
	epub: "document",
	json: "code",
	js: "code",
	ts: "code",
	cs: "code",
	gd: "code",
	lua: "code",
	py: "code",
	html: "code",
	css: "code",
};

export function fileKind(name: string): FileKind {
	const ext = extname(name).slice(1).toLowerCase();
	return KINDS[ext] ?? "other";
}

/** Work out why a file is in the item directory from the downloader's naming. */
export function fileRole(name: string, directory: string): FileRole {
	if (name.endsWith(".incomplete")) return "incomplete";
	if (name.endsWith(".old")) return "old";
	if (name === `${directory}${MANIFEST_SUFFIX}`) return "manifest";
	if (name.startsWith(`${directory}${COVER_SUFFIX}.`)) return "cover";
	if (name.startsWith(`${directory}_webpage_screenshot_`)) {
		return name.endsWith(".pdf") ? "pdf" : "screenshot";
	}
	// yt-dlp output: <directory>_<video id>.<ext>
	if (name.startsWith(`${directory}_`) && fileKind(name) === "video")
		return "video";
	return "download";
}

/** "sci-fi_character-pack" -> "Sci Fi Character Pack" for items without a manifest. */
export function titleFromDirectory(directory: string): string {
	return directory
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

/** URL of `path` (relative to the item, "/"-joined) inside item `directory`. */
export function fileUrl(directory: string, path: string): string {
	const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
	return `/files/${enc(directory)}/${enc(path)}`;
}

/** The `YYYYMMDD` stamp of a capture file name as an ISO date, or "". */
export function captureDate(name: string): string {
	const m = /_webpage_screenshot_(\d{4})(\d{2})(\d{2})\.(?:png|pdf)$/i.exec(
		name,
	);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/** Pair up PNG and PDF captures by date, newest first. */
export function groupCaptures(files: LibraryFile[]): LibraryCapture[] {
	const byDate = new Map<string, LibraryCapture>();
	for (const f of files) {
		if (f.role !== "screenshot" && f.role !== "pdf") continue;
		const date = captureDate(f.name);
		let group = byDate.get(date);
		if (!group) {
			group = { date, png: null, pdf: null };
			byDate.set(date, group);
		}
		if (f.role === "screenshot") group.png = f;
		else group.pdf = f;
	}
	return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/** How deep inside an item directory the tree is scanned. */
const MAX_TREE_DEPTH = 8;
/** Entries per item beyond which the tree is cut off. */
const MAX_TREE_ENTRIES = 5000;

interface TreeScan {
	/** Entries still allowed before the tree is cut off. */
	budget: number;
	truncated: boolean;
}

/**
 * Scan the directory `sub` of item `directory` recursively into a tree of
 * `LibraryFile`s. Folders carry `children` and the size of everything inside;
 * beyond the depth limit they are listed without children. Hidden files are
 * skipped; `prefix` names the item for the role of top-level files.
 */
async function scanTree(
	root: string,
	directory: string,
	prefix: string,
	sub: string,
	depth: number,
	scan: TreeScan,
): Promise<LibraryFile[]> {
	const dir = join(root, ...directory.split("/"), ...sub.split("/"));
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const files: LibraryFile[] = [];
	for (const name of names.sort((a, b) => a.localeCompare(b))) {
		// Hidden and system files are not content (`.incomplete` ones are
		// listed: they show what is still on its way).
		if (name.startsWith(".") || isSystemFile(name)) continue;
		if (scan.budget <= 0) {
			scan.truncated = true;
			break;
		}
		let s: Awaited<ReturnType<typeof stat>>;
		try {
			s = await stat(join(dir, name));
		} catch {
			continue;
		}
		scan.budget--;
		const path = sub ? `${sub}/${name}` : name;
		if (s.isDirectory()) {
			const children =
				depth < MAX_TREE_DEPTH
					? await scanTree(root, directory, prefix, path, depth + 1, scan)
					: undefined;
			files.push({
				name,
				path,
				size: children
					? children.reduce((acc, f) => acc + f.size, 0)
					: await directorySize(join(dir, name)),
				modified: s.mtime.toISOString(),
				kind: "folder",
				role: "download",
				url: null,
				children,
			});
			continue;
		}
		files.push({
			name,
			path,
			size: s.size,
			modified: s.mtime.toISOString(),
			kind: fileKind(name),
			role: depth === 0 ? fileRole(name, prefix) : "download",
			url: fileUrl(directory, path),
		});
	}
	return files;
}

async function directorySize(path: string): Promise<number> {
	let total = 0;
	let entries: string[] = [];
	try {
		entries = await readdir(path);
	} catch {
		return 0;
	}
	for (const name of entries) {
		const full = join(path, name);
		try {
			const s = await stat(full);
			total += s.isDirectory() ? await directorySize(full) : s.size;
		} catch {
			// unreadable entry; ignore
		}
	}
	return total;
}

/** The full file tree of item `directory` (relative to `root`, "/"-separated). */
export async function scanItemTree(
	root: string,
	directory: string,
): Promise<ItemResponse> {
	const scan: TreeScan = { budget: MAX_TREE_ENTRIES, truncated: false };
	const files = await scanTree(
		root,
		directory,
		basename(directory),
		"",
		0,
		scan,
	);
	return { directory, files, truncated: scan.truncated };
}

/** Drop the nested entries: the library listing only shows the top level. */
function withoutChildren(files: LibraryFile[]): LibraryFile[] {
	return files.map((f) => {
		const { children: _children, ...rest } = f;
		return rest;
	});
}

export async function readManifest(path: string): Promise<Manifest | null> {
	try {
		const parsed: unknown = await Bun.file(path).json();
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as Manifest;
	} catch {
		return null;
	}
}

/** `directory` is relative to `root`, "/"-separated (may be nested). */
export async function scanItem(
	root: string,
	directory: string,
): Promise<LibraryItem | null> {
	const dir = join(root, ...directory.split("/"));
	// Generated files are prefixed with the directory's own name.
	const prefix = basename(directory);
	try {
		await readdir(dir);
	} catch {
		return null;
	}
	const files = withoutChildren((await scanItemTree(root, directory)).files);

	const manifest = files.some((f) => f.role === "manifest")
		? await readManifest(join(dir, `${prefix}${MANIFEST_SUFFIX}`))
		: null;
	const marker = await readMarker(dir);
	const cover = files.find((f) => f.role === "cover") ?? null;
	const newest = files.reduce(
		(acc, f) => (f.modified > acc ? f.modified : acc),
		"",
	);

	return {
		directory,
		title:
			manifest?.title?.trim() ||
			marker?.title?.trim() ||
			titleFromDirectory(prefix),
		author: manifest?.author ?? marker?.author ?? null,
		urls: manifest?.urls ?? (marker ? { page: marker.url } : null),
		itchId: manifest?.itchId ?? null,
		description: manifest?.description ?? null,
		info: manifest?.info ?? {},
		tags: manifest?.tags ?? [],
		bundles: manifest?.bundles ?? [],
		hasManifest: manifest !== null,
		fetchable: Boolean(manifest?.urls?.downloadPage),
		cover: cover?.url ?? null,
		captures: groupCaptures(files),
		files,
		downloadCount: files.filter((f) => f.role === "download").length,
		size: files.reduce((acc, f) => acc + f.size, 0),
		modified: newest || new Date(0).toISOString(),
		// A legacy item hidden by an admin has a marker holding only the flag.
		hidden: marker
			? marker.hidden === true
			: (await isMarkerHidden(dir)) === true,
	};
}

/** How deep below the root item directories are looked for. */
const MAX_DEPTH = 8;

async function subdirectories(dir: string): Promise<string[]> {
	const entries: Dirent[] = await readdir(dir, { withFileTypes: true }).catch(
		() => [],
	);
	return entries
		.filter((e) => e.isDirectory() && !e.name.startsWith("."))
		.map((e) => e.name)
		.sort((a, b) => a.localeCompare(b));
}

/**
 * Collect the items below `relative` into `items`; returns whether any were
 * found. Marked directories are items (nothing inside them is looked at as
 * one); unmarked top-level directories with no items inside are legacy items.
 */
async function walk(
	root: string,
	relative: string,
	depth: number,
	items: LibraryItem[],
): Promise<boolean> {
	const dir = relative ? join(root, ...relative.split("/")) : root;
	let found = false;
	for (const name of await subdirectories(dir)) {
		const rel = relative ? `${relative}/${name}` : name;
		const marked = await Bun.file(join(dir, name, MARKER_FILE)).exists();
		if (!marked && depth + 1 < MAX_DEPTH) {
			if (await walk(root, rel, depth + 1, items)) {
				found = true;
				continue;
			}
			if (depth > 0) continue;
		}
		if (marked || depth === 0) {
			const item = await scanItem(root, rel);
			if (item) {
				items.push(item);
				found = true;
			}
		}
	}
	return found;
}

export async function scanLibrary(root: string): Promise<LibraryResponse> {
	const items: LibraryItem[] = [];
	await walk(root, "", 0, items);

	return {
		root,
		scannedAt: new Date().toISOString(),
		platform: process.platform,
		totals: {
			items: items.length,
			size: items.reduce((acc, i) => acc + i.size, 0),
			withManifest: items.filter((i) => i.hasManifest).length,
			withCover: items.filter((i) => i.cover !== null).length,
		},
		items,
	};
}
