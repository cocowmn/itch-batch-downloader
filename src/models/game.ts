/** An item bound to the account that can be downloaded. */
export interface Game {
	/** Human readable title as shown on itch.io. */
	title: string;

	/** Slugified title, used in log lines. */
	slug: string;

	/** Download page, e.g. https://author.itch.io/game/download/KEY */
	dlurl: string;

	/** Public product page, e.g. https://author.itch.io/game */
	gameUrl: string;

	/** Author slug, the `author` part of author.itch.io. Empty when unknown. */
	author: string;

	/** Author display name when the listing exposes one. */
	authorName: string;

	/** Download key taken from the download page URL. */
	key: string;

	/** The item's itch.io URL slug (the `game` in author.itch.io/game). */
	itchSlug: string;

	/** Bundles the item was selected from, when the run is bundle based. */
	bundles?: Bundle[];
}

export interface Bundle {
	name: string;
	key: string;

	/** https://itch.io/bundle/download/KEY */
	url: string;
}

/** A row of a bundle download page. Only claimed rows carry a download page. */
export interface BundleGame {
	title: string;
	gameUrl: string;
	author: string;
	authorName: string;
	claimed: boolean;
	dlurl?: string;
}
