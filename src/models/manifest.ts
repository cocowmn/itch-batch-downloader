// The per-item manifest written by features/manifest and read back by the
// download browser.

/**
 * A bundle reference as written to manifests; key and URL are private and
 * only present when `manifest_include_keys` is on.
 */
export interface ManifestBundle {
	name: string;
	key?: string;
	url?: string;
}

/** What the public product page tells about an item. */
export interface ProductMetadata {
	/** Numeric itch.io id from the `itch:path` meta tag (`games/123`). */
	itchId: number | null;
	description: string | null;
	coverImageUrl: string | null;

	/** Rows of the "More information" panel, e.g. Status, Category, Genre. */
	info: Record<string, string>;
	tags: string[];

	/** Original-size screenshot URLs. */
	screenshots: string[];

	/** Embedded iframe sources (videos, players). */
	embeds: string[];
}

export interface Manifest extends ProductMetadata {
	manifestVersion: 1;
	generatedAt: string;
	title: string;
	author: { slug: string; name: string; url: string };

	/** `downloadPage` contains the download key and is only written with includeKeys. */
	urls: { page: string; downloadPage?: string };

	/** Only written with includeKeys. */
	downloadKey?: string;
	directory: string;
	bundles: ManifestBundle[];

	/** Files present in the item directory when the manifest was written. */
	files: string[];
}
