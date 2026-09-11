// Data shared between the download-browser server and its web UI.

import type { ManifestBundle } from "./manifest.ts";

/** What a file is, judged by its extension. */
export type FileKind =
	| "archive"
	| "image"
	| "audio"
	| "video"
	| "document"
	| "code"
	| "folder"
	| "other";

/** Why a file exists in an item directory. */
export type FileRole =
	/** A file from the item's download page (or something the user unpacked). */
	| "download"
	| "cover"
	| "screenshot"
	| "pdf"
	| "video"
	| "manifest"
	| "old"
	| "incomplete";

export interface LibraryFile {
	name: string;
	/** Path relative to the item directory, "/"-joined. */
	path: string;
	/** Bytes; for folders the total of everything inside. */
	size: number;
	/** ISO timestamp of the last modification. */
	modified: string;
	kind: FileKind;
	role: FileRole;
	/** URL the server serves the file at; folders have none. */
	url: string | null;
	/**
	 * A folder's entries, when scanned (the item tree from `/api/item`).
	 * Absent for folders in the library listing and beyond the depth limit.
	 */
	children?: LibraryFile[];
}

/** `/api/item/<directory>`: the item's full file tree. */
export interface ItemResponse {
	directory: string;
	files: LibraryFile[];
	/** The tree hit the entry cap and is incomplete. */
	truncated: boolean;
}

/** The PNG and/or PDF capture of the product page taken on one day. */
export interface LibraryCapture {
	/** ISO date (`2026-09-10`) from the file name's stamp. */
	date: string;
	png: LibraryFile | null;
	pdf: LibraryFile | null;
}

export interface LibraryItem {
	/** The item's directory name inside the download directory. */
	directory: string;
	title: string;
	author: { slug: string; name: string; url: string } | null;
	urls: { page: string; downloadPage?: string } | null;
	itchId: number | null;
	description: string | null;
	info: Record<string, string>;
	tags: string[];
	bundles: ManifestBundle[];
	hasManifest: boolean;
	/**
	 * The manifest carries the download page (written with
	 * `manifest_include_keys`), so the server can fetch the item again.
	 */
	fetchable: boolean;
	/** URL of the cover artwork, when downloaded. */
	cover: string | null;
	/** Page captures grouped by their date stamp, newest first. */
	captures: LibraryCapture[];
	files: LibraryFile[];
	/** Number of files with the "download" role. */
	downloadCount: number;
	/** Bytes used by the whole item directory. */
	size: number;
	/** ISO timestamp of the newest file in the directory. */
	modified: string;
	/** Hidden by an admin. Non-admins never receive hidden items. */
	hidden: boolean;
}

export interface LibraryResponse {
	root: string;
	scannedAt: string;
	/** `darwin`, `win32`, `linux`, ... so the UI can name the file manager. */
	platform: string;
	totals: {
		items: number;
		size: number;
		withManifest: number;
		withCover: number;
	};
	items: LibraryItem[];
}

/** `/api/admin`: whether a password is configured and whether this session has signed in. */
export interface AdminStatus {
	enabled: boolean;
	admin: boolean;
}
