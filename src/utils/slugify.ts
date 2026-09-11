import { basename, extname } from "node:path";

/**
 * Port of the Django-derived slugify() from the Python version.
 * Converts to ASCII, lowercases, keeps only word characters, collapses
 * whitespace/dashes to a single dash and trims leading/trailing dashes and
 * underscores. When `isFilename` is set the extension is sanitized separately
 * and re-attached so it is not mangled.
 */
export function slugify(value: string, isFilename = false): string {
	value = String(value)
		.normalize("NFKD")
		.replace(/\P{ASCII}/gu, "");

	if (!isFilename) return value.trim();

	const ext = extname(value);
	const stem = ext ? basename(value, ext) : value;

	const cleanStem = clean(stem);
	const cleanExt = clean(ext);

	return cleanExt ? `${cleanStem}.${cleanExt}` : cleanStem;
}

function clean(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.replace(/[-\s]+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "");
}

/** Slug used when comparing user supplied names (bundle names, author names). */
export function comparable(value: string): string {
	return clean(
		String(value)
			.normalize("NFKD")
			.replace(/\P{ASCII}/gu, ""),
	);
}
