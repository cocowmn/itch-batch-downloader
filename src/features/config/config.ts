import { resolve } from "node:path";
import type { Config } from "../../models/config.ts";
import { DownloadNameError, parseDownloadName } from "../naming/naming.ts";

export const DEFAULT_CONFIG_FILE = "appconfig.toml";

export const DEFAULTS: Config = {
	download_directory: "downloads",
	download_name: "{slug}",
	cookie_file: "cookies.txt",
	create_log: true,
	create_pdf: true,
	create_png: true,
	download_files: true,
	download_artwork: true,
	download_manifest: true,
	manifest_include_keys: true,
	download_videos: true,
	debug_logs: false,
	log_download_progress: true,
	bundles: [],
	authors: [],
	yt_dlp_path: "yt-dlp",
};

/**
 * A fresh password for the download browser's admin features: 20 characters
 * from an alphabet without look-alikes, so it can be read off the file and
 * typed on a phone.
 */
export function generateAdminPassword(): string {
	const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Written on first run so users have something to edit. */
export const CONFIG_TEMPLATE = `# itch-batch-downloader configuration
# Every option here can also be overridden on the command line, see --help.

# Where downloads are stored. Relative paths are resolved from the current directory.
download_directory = "downloads"

# Where each item goes inside download_directory. "/" creates subdirectories.
# Tokens in braces are replaced per item and made safe for file names.
#   Item:     {title} {slug} {author} {author_name} {bundle}
#   Page:     {id} {category} {tags} {genre} {published} {updated}
#   Run:      {index} {total}
#   Time:     {yyyy} {yy} {mm} {dd} {hh} {min} {ss} {ms} {date} {time}
# {tags} and {genre} join with ", "; give another separator after a colon,
# e.g. {tags:--} -> "2D--Pixel Art--Sprites". At least one of {slug},
# {title}, {id} or {index} is required. Examples:
#   download_name = "{author}/{title}"
#   download_name = "{yyyy}-{mm}-{dd}/{author}--{index}"
download_name = "{slug}"

# Your itch.io session cookies: a Netscape cookies.txt export, or the raw
# "cookie" header value copied from the browser's developer tools (see README).
cookie_file = "cookies.txt"

# Write everything that is logged to <download_directory>/downloads.log.
create_log = true

# Capture the product page as PDF / PNG (needs Chrome, Chromium, Edge or Brave).
create_pdf = true
create_png = true

# Download the item's files (the entries of its download page).
download_files = true

# Save the product page's cover artwork as <item>_cover-artwork.<ext>.
download_artwork = true

# Write <item>_manifest.json with the item's title, author, URLs, tags, etc.
download_manifest = true

# Include your download keys in the manifest: the item's download key, the
# download-page URL (which contains it) and the keys/URLs of the bundles it
# came from. WARNING: with this on, manifests are PRIVATE files - anyone who
# gets one can download the item with your key. Set to false to write a
# manifest that only describes the content and is safe to share.
manifest_include_keys = true

# Download videos embedded in the product page (needs yt-dlp on PATH or yt_dlp_path).
download_videos = true

# Verbose logging.
debug_logs = false

# Show a live progress bar while a file downloads. When false, one line with the
# file size and current speed is logged at the start and one when it completes.
log_download_progress = true

# Limit the run to specific bundles. Entries can be a bundle name, its key or
# the full https://itch.io/bundle/download/KEY URL. Empty = whole library.
# Use \`list-bundles\` to see what you own.
bundles = []

# Limit the run to specific authors (the "author" in author.itch.io).
# Use \`list-authors\` to see the authors in your library. Empty = everyone.
authors = []

# Optional explicit browser executable for page captures.
# chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Optional path to the yt-dlp executable.
# yt_dlp_path = "yt-dlp"

# Password for the admin features of the download browser (hiding and
# deleting items). A random one is generated when this file is created;
# change it to anything you like. Long-press the library icon in the
# browser's top bar to sign in. Remove the line to turn admin features off.
admin_password = "{admin_password}"
`;

/** The template with a freshly generated admin password filled in. */
export function configTemplate(): string {
	return CONFIG_TEMPLATE.replace(
		'"{admin_password}"',
		JSON.stringify(generateAdminPassword()),
	);
}

/** Values that may be provided on the command line and win over the file. */
export interface ConfigOverrides {
	download_directory?: string;
	download_name?: string;
	cookie_file?: string;
	create_pdf?: boolean;
	create_png?: boolean;
	download_files?: boolean;
	download_artwork?: boolean;
	download_manifest?: boolean;
	manifest_include_keys?: boolean;
	download_videos?: boolean;
	debug_logs?: boolean;
	log_download_progress?: boolean;
	create_log?: boolean;
	bundles?: string[];
	authors?: string[];
	chrome_path?: string;
	yt_dlp_path?: string;
	admin_password?: string;
}

export class ConfigError extends Error {}

/**
 * Load the TOML config file and apply overrides. Returns `null` when the file
 * did not exist and a template was written instead (first run).
 */
export async function loadConfig(
	path: string,
	overrides: ConfigOverrides = {},
): Promise<Config | null> {
	const file = Bun.file(path);
	let fromFile: Partial<Config> = {};
	if (await file.exists()) {
		let parsed: unknown;
		try {
			parsed = Bun.TOML.parse(await file.text());
		} catch (err) {
			throw new ConfigError(
				`Cannot parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		fromFile = validate(parsed, path);
	} else {
		await Bun.write(path, configTemplate());
		return null;
	}

	const config: Config = {
		...DEFAULTS,
		...fromFile,
		...stripUndefined(overrides),
	};
	config.download_directory = resolve(config.download_directory);
	try {
		parseDownloadName(config.download_name);
	} catch (err) {
		if (err instanceof DownloadNameError) throw new ConfigError(err.message);
		throw err;
	}
	config.cookie_file = resolve(config.cookie_file);
	config.bundles = config.bundles.map((s) => s.trim()).filter(Boolean);
	config.authors = config.authors
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (!config.admin_password?.trim()) delete config.admin_password;
	return config;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(obj).filter(([, v]) => v !== undefined),
	) as Partial<T>;
}

function validate(raw: unknown, path: string): Partial<Config> {
	if (typeof raw !== "object" || raw === null)
		throw new ConfigError(`${path}: expected a table at top level`);
	const r = raw as Record<string, unknown>;
	const out: Partial<Config> = {};
	const str = (k: keyof Config) => {
		const v = r[k];
		if (v === undefined) return;
		if (typeof v !== "string")
			throw new ConfigError(`${path}: "${k}" must be a string`);
		(out as Record<string, unknown>)[k] = v;
	};
	const bool = (k: keyof Config) => {
		const v = r[k];
		if (v === undefined) return;
		// Accept the legacy "ON"/"OFF" strings too.
		if (typeof v === "string" && ["on", "off"].includes(v.toLowerCase())) {
			(out as Record<string, unknown>)[k] = v.toLowerCase() === "on";
			return;
		}
		if (typeof v !== "boolean")
			throw new ConfigError(`${path}: "${k}" must be true or false`);
		(out as Record<string, unknown>)[k] = v;
	};
	const list = (k: keyof Config) => {
		const v = r[k];
		if (v === undefined) return;
		if (typeof v === "string") {
			(out as Record<string, unknown>)[k] = v.split(",");
			return;
		}
		if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
			throw new ConfigError(`${path}: "${k}" must be an array of strings`);
		}
		(out as Record<string, unknown>)[k] = v;
	};

	str("download_directory");
	str("download_name");
	str("cookie_file");
	str("chrome_path");
	str("yt_dlp_path");
	str("admin_password");
	bool("create_pdf");
	bool("create_png");
	bool("download_files");
	bool("download_artwork");
	bool("download_manifest");
	bool("manifest_include_keys");
	bool("download_videos");
	bool("debug_logs");
	bool("log_download_progress");
	bool("create_log");
	list("bundles");
	list("authors");
	return out;
}
