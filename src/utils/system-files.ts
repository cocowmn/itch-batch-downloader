// Files the operating system leaves in folders and archives: Finder's
// `.DS_Store` and `._*` resource forks, `__MACOSX` sidecar folders, Windows'
// `Thumbs.db` and `desktop.ini`. Nothing of ours, and never anyone's content.

const SYSTEM_NAMES = new Set([
	".ds_store",
	"__macosx",
	"thumbs.db",
	"ehthumbs.db",
	"desktop.ini",
	".spotlight-v100",
	".trashes",
	".fseventsd",
]);

/** Whether a file or folder name is one of the system's bookkeeping files. */
export function isSystemFile(name: string): boolean {
	const lower = name.toLowerCase();
	return SYSTEM_NAMES.has(lower) || lower.startsWith("._");
}

/**
 * Whether a file or folder is left out of listings, manifests and
 * archives: hidden (dot-prefixed, which includes the `.itchio` marker),
 * partial (`.incomplete`) or the system's.
 */
export function isIgnoredFile(name: string): boolean {
	return (
		name.startsWith(".") || name.endsWith(".incomplete") || isSystemFile(name)
	);
}
