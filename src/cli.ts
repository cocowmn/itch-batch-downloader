#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
	ConfigError,
	type ConfigOverrides,
	DEFAULT_CONFIG_FILE,
	loadConfig,
	PACINGS,
} from "./features/config/config.ts";
import { printProductList, run } from "./features/download/pipeline.ts";
import { fetchOwnedBundles } from "./features/itch/bundles.ts";
import { createClient, NotAuthenticatedError } from "./features/itch/client.ts";
import {
	reportUnclaimed,
	selectProducts,
} from "./features/selection/selection.ts";
import type { Config, DownloadPacing } from "./models/config.ts";
import { log } from "./utils/log.ts";
import { DEFAULT_PORT, serveDownloadBrowser } from "./www/server/server.ts";

const VERSION = "0.2.0";

const USAGE = `itch-batch-downloader ${VERSION}

Usage: itch-batch-downloader [command] [options]

Commands:
  download        Download the selected items (default)
  list-bundles    List the bundles bound to this account
  list-authors    List the authors in the selection with item counts
  list-products   List the selected items with their resume numbers
  browser         Browse what has been downloaded in a local web UI

Options:
  -c, --config <file>       Config file (default: ${DEFAULT_CONFIG_FILE})
  -d, --download-dir <dir>  Override download_directory
  -n, --download-name <template>
                            Override download_name, e.g. "{author}/{title}"
      --cookie-file <file>  Override cookie_file
  -b, --bundle <name|key|url>
                            Only items of this bundle (repeatable)
  -a, --author <slug>       Only items by this author (repeatable)
  -p, --product <url|author/game|title>
                            This specific item of your library (repeatable)
      --png / --no-png      Enable/disable PNG page captures
      --pdf / --no-pdf      Enable/disable PDF page captures
      --files / --no-files  Enable/disable downloading the items' files
      --artwork / --no-artwork
                            Enable/disable saving the cover artwork
      --manifest / --no-manifest
                            Enable/disable writing <item>_manifest.json
      --manifest-keys / --no-manifest-keys
                            Include/omit your download keys in manifests
      --videos / --no-videos
                            Enable/disable embedded video downloads
      --chrome-path <file>  Browser executable used for captures
      --yt-dlp-path <file>  yt-dlp executable
      --progress / --no-progress
                            Show/hide the live download progress bar
      --log / --no-log      Enable/disable writing downloads.log
      --delay <seconds>     Pause between items (download_delay)
      --per-hour <n>        Max items started per hour, 0 = unlimited
                            (downloads_per_hour)
      --pacing <spread|eager>
                            How the hourly budget is spent (download_pacing)
      --parallel <n>        Items processed at the same time (parallel_downloads)
      --dry-run             Resolve the selection and list it, download nothing
      --restart             Ignore the resume file and start from the first item
      --skip <n>            Skip the first n items of the selection
      --port <n>            Port for browser (default: ${DEFAULT_PORT})
      --host [addr]         Interface for browser (default: 127.0.0.1;
                            a bare --host listens on 0.0.0.0, reachable from
                            other devices)
      --open / --no-open    Open the download browser UI in your default browser
      --debug               Verbose logging
  -h, --help                Show this help
  -V, --version             Show version
`;

/**
 * parseArgs has no optional option-arguments, so a bare `--host` (nothing
 * after it, or another flag) is rewritten to `--host=0.0.0.0` first, like
 * the dev servers that treat `--host` alone as "listen on every interface".
 */
function expandBareHost(argv: string[]): string[] {
	return argv.flatMap((arg, i) => {
		if (arg !== "--host") return [arg];
		const next = argv[i + 1];
		return next === undefined || next.startsWith("-")
			? ["--host=0.0.0.0"]
			: [arg];
	});
}

function parseCli(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: expandBareHost(argv),
		allowPositionals: true,
		allowNegative: true,
		options: {
			config: { type: "string", short: "c" },
			"download-dir": { type: "string", short: "d" },
			"download-name": { type: "string", short: "n" },
			"cookie-file": { type: "string" },
			bundle: { type: "string", short: "b", multiple: true },
			author: { type: "string", short: "a", multiple: true },
			product: { type: "string", short: "p", multiple: true },
			png: { type: "boolean" },
			pdf: { type: "boolean" },
			files: { type: "boolean" },
			artwork: { type: "boolean" },
			manifest: { type: "boolean" },
			"manifest-keys": { type: "boolean" },
			videos: { type: "boolean" },
			"chrome-path": { type: "string" },
			"yt-dlp-path": { type: "string" },
			progress: { type: "boolean" },
			log: { type: "boolean" },
			delay: { type: "string" },
			"per-hour": { type: "string" },
			pacing: { type: "string" },
			parallel: { type: "string" },
			"dry-run": { type: "boolean" },
			restart: { type: "boolean" },
			skip: { type: "string" },
			port: { type: "string" },
			host: { type: "string" },
			open: { type: "boolean" },
			debug: { type: "boolean" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "V" },
		},
	});
	const overrides: ConfigOverrides = {
		download_directory: values["download-dir"],
		download_name: values["download-name"],
		cookie_file: values["cookie-file"],
		create_png: values.png,
		create_pdf: values.pdf,
		download_files: values.files,
		download_artwork: values.artwork,
		download_manifest: values.manifest,
		manifest_include_keys: values["manifest-keys"],
		download_videos: values.videos,
		debug_logs: values.debug,
		log_download_progress: values.progress,
		create_log: values.log,
		download_delay: parseNumberOption("--delay", values.delay, { min: 0 }),
		downloads_per_hour: parseNumberOption("--per-hour", values["per-hour"], {
			integer: true,
			min: 0,
		}),
		download_pacing: parsePacing(values.pacing),
		parallel_downloads: parseNumberOption("--parallel", values.parallel, {
			integer: true,
			min: 1,
		}),
		bundles: values.bundle,
		authors: values.author,
		products: values.product,
		chrome_path: values["chrome-path"],
		yt_dlp_path: values["yt-dlp-path"],
	};
	return {
		command: positionals[0] ?? "download",
		configFile: values.config ?? DEFAULT_CONFIG_FILE,
		overrides,
		dryRun: values["dry-run"] ?? false,
		restart: values.restart ?? false,
		skip: parseSkip(values.skip),
		port: parsePort(values.port),
		host: values.host,
		open: values.open ?? true,
		help: values.help ?? false,
		version: values.version ?? false,
	};
}

function parseSkip(value: string | undefined): number {
	return parseNumberOption("--skip", value, { integer: true, min: 0 }) ?? 0;
}

function parseNumberOption(
	flag: string,
	value: string | undefined,
	opts: { integer?: boolean; min: number },
): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (
		value.trim() === "" ||
		!Number.isFinite(n) ||
		n < opts.min ||
		(opts.integer && !Number.isInteger(n))
	) {
		throw new ConfigError(
			`${flag} expects ${opts.integer ? "a whole number" : "a number"} of at least ${opts.min}, got "${value}"`,
		);
	}
	return n;
}

function parsePacing(value: string | undefined): DownloadPacing | undefined {
	if (value === undefined) return undefined;
	const lower = value.trim().toLowerCase();
	if (!(PACINGS as readonly string[]).includes(lower))
		throw new ConfigError(
			`--pacing expects ${PACINGS.join(" or ")}, got "${value}"`,
		);
	return lower as DownloadPacing;
}

function parsePort(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0 || n > 65535)
		throw new ConfigError(`--port expects a port number, got "${value}"`);
	return n;
}

async function pauseOnWindows(): Promise<void> {
	if (process.platform !== "win32" || !process.stdin.isTTY) return;
	process.stdout.write("Press ENTER to exit");
	for await (const _ of console) break;
}

async function listBundles(config: Config): Promise<void> {
	const client = await createClient(config);
	const bundles = await fetchOwnedBundles(client);
	if (bundles.length === 0) {
		log.info("No bundles bound to this account.");
		return;
	}
	log.info(`${bundles.length} bundle(s):`);
	for (const b of bundles)
		log.raw(`  ${b.name}\n      key: ${b.key}   ${b.url}`);
}

async function listAuthors(config: Config): Promise<void> {
	const client = await createClient(config);
	const selection = await selectProducts(client, {
		bundles: config.bundles,
		products: config.products,
		authors: [],
	});
	reportUnclaimed(selection.unclaimed);
	const counts = new Map<string, { name: string; count: number }>();
	for (const g of selection.products) {
		const key = g.author || "?";
		const entry = counts.get(key) ?? { name: g.authorName, count: 0 };
		entry.count++;
		if (!entry.name && g.authorName) entry.name = g.authorName;
		counts.set(key, entry);
	}
	const rows = [...counts.entries()].sort(
		(a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
	);
	log.info(
		`${rows.length} author(s) across ${selection.products.length} items:`,
	);
	const width = String(Math.max(...rows.map(([, v]) => v.count))).length;
	for (const [slug, { name, count }] of rows) {
		log.raw(
			`  ${String(count).padStart(width)}  ${slug}${name && name !== slug ? `  (${name})` : ""}`,
		);
	}
}

async function listProducts(config: Config): Promise<void> {
	const client = await createClient(config);
	const selection = await selectProducts(client, config);
	reportUnclaimed(selection.unclaimed);
	log.info(`${selection.products.length} item(s) selected:`);
	printProductList(selection);
}

async function main(): Promise<number> {
	const cli = parseCli(process.argv.slice(2));
	if (cli.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (cli.version) {
		console.log(VERSION);
		return 0;
	}

	log.raw(
		`itch-batch-downloader ${VERSION} (c) 2022-2026 alterego.cc Fabio Lichinchi (mukka)`,
	);
	log.raw(`$ itch-batch-downloader ${process.argv.slice(2).join(" ")}`);
	log.raw();

	const config = await loadConfig(cli.configFile, cli.overrides);
	if (!config) {
		log.info(
			`Created new configuration. Please edit ${cli.configFile} and run again.`,
		);
		await pauseOnWindows();
		return 1;
	}
	log.setDebug(config.debug_logs);

	switch (cli.command) {
		case "download":
			await run(config, {
				dryRun: cli.dryRun,
				restart: cli.restart,
				skip: cli.skip,
			});
			break;
		case "list-bundles":
			await listBundles(config);
			break;
		case "list-authors":
			await listAuthors(config);
			break;
		case "list-products":
			await listProducts(config);
			break;
		case "browser":
			await serveDownloadBrowser(config, {
				port: cli.port,
				host: cli.host,
				open: cli.open,
			});
			return 0;
		default:
			process.stderr.write(`Unknown command: ${cli.command}\n\n${USAGE}`);
			return 2;
	}

	console.log();
	console.log("Done");
	await pauseOnWindows();
	return 0;
}

main()
	.then((code) => process.exit(code))
	.catch(async (err) => {
		if (err instanceof NotAuthenticatedError || err instanceof ConfigError)
			log.error(err.message);
		else log.error(err instanceof Error ? err.message : String(err), err);
		await pauseOnWindows();
		process.exit(1);
	});
