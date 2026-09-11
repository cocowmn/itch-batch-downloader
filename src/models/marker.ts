/** The hidden `.itchio` marker written into every item directory. Public data only. */
export interface ItemMarker {
	markerVersion: 1;
	title: string;

	/** itch.io URL slug. */
	slug: string;
	author: { slug: string; name: string; url: string };

	/** Public product page. */
	url: string;

	/** The download_name template that produced the directory. */
	downloadName: string;
	updatedAt: string;

	/** Hidden from the download browser by an admin; absent when shown. */
	hidden?: true;
}
