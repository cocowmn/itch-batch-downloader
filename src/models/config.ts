export type DownloadPacing = "spread" | "eager";

export interface Config {
	download_directory: string;

	/** Template for each item's directory inside download_directory, see features/naming. */
	download_name: string;

	cookie_file: string;
	create_pdf: boolean;
	create_png: boolean;
	download_files: boolean;
	download_artwork: boolean;
	download_manifest: boolean;
	manifest_include_keys: boolean;
	download_videos: boolean;
	debug_logs: boolean;
	log_download_progress: boolean;
	create_log: boolean;

	/** Seconds to pause after an item finishes before the next starts (per worker). */
	download_delay: number;

	/** Max items started per rolling hour; 0 = unlimited. */
	downloads_per_hour: number;

	/** How the hourly budget is spent: evenly spaced, or as fast as allowed then wait. */
	download_pacing: DownloadPacing;

	/** Items processed at the same time. */
	parallel_downloads: number;
	bundles: string[];
	authors: string[];

	/** Individual items to download: page URL, download URL, "author/slug" or title. */
	products: string[];
	chrome_path?: string;
	yt_dlp_path: string;

	/**
	 * Unlocks the admin features of the download browser (hide / delete
	 * items). Absent or empty = admin features off.
	 */
	admin_password?: string;
}
