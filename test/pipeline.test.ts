import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PageCapturer } from "../src/features/capture/capture.ts";
import { processItem } from "../src/features/download/pipeline.ts";
import { ItchClient } from "../src/features/itch/client.ts";
import { CookieJar } from "../src/features/itch/cookie-jar.ts";
import { parseDownloadName } from "../src/features/naming/naming.ts";
import type { Config } from "../src/models/config.ts";
import type { Product } from "../src/models/product.ts";
import { isAbortError } from "../src/utils/abort.ts";

const downloadPage = await Bun.file(
	join(import.meta.dir, "fixtures", "download-page-new.html"),
).text();

const product: Product = {
	title: "Space Game",
	slug: "space-game",
	dlurl: "https://cool-dev.itch.io/space-game/download/AbC123",
	productUrl: "https://cool-dev.itch.io/space-game",
	author: "cool-dev",
	authorName: "Cool Dev",
	key: "AbC123",
	itchSlug: "space-game",
};

const CDN = "https://itchio-mirror.example.com/space-game.zip";

/**
 * A client that serves the download page from the fixture, resolves the
 * upload to a "Cloudflare" URL and streams that file slowly, honouring the
 * abort signal the way fetch() does.
 */
class StubClient extends ItchClient {
	chunksSent = 0;

	constructor(signal: AbortSignal) {
		super(new CookieJar(), signal);
	}

	override async fetch(url: string, init: RequestInit = {}): Promise<Response> {
		const signal = init.signal ?? this.signal;
		if (url === product.dlurl) return new Response(downloadPage);
		if (url.includes("/download/AbC123/5001"))
			return Response.json({ url: CDN });
		if (url === CDN) {
			const body = new ReadableStream<Uint8Array>({
				pull: async (controller) => {
					await Bun.sleep(5);
					if (signal?.aborted) {
						controller.error(new DOMException("Aborted", "AbortError"));
						return;
					}
					this.chunksSent++;
					controller.enqueue(new Uint8Array(1024));
				},
			});
			return new Response(body, {
				headers: {
					"content-length": String(1024 * 1000),
					"content-disposition": 'attachment; filename="space-game.zip"',
				},
			});
		}
		throw new Error(`Unexpected request: ${url}`);
	}
}

const config: Config = {
	download_directory: "",
	download_name: "{slug}",
	cookie_file: "",
	create_pdf: false,
	create_png: false,
	download_files: true,
	download_artwork: false,
	download_manifest: false,
	download_videos: false,
	manifest_include_keys: false,
	debug_logs: false,
	log_download_progress: false,
	create_log: false,
	download_delay: 0,
	downloads_per_hour: 0,
	download_pacing: "spread",
	parallel_downloads: 1,
	bundles: [],
	authors: [],
	products: [],
	yt_dlp_path: "yt-dlp",
};

describe("processItem", () => {
	test("an abort mid-download removes the .incomplete file and rejects", async () => {
		const root = await mkdtemp(join(tmpdir(), "itch-abort-"));
		try {
			const controller = new AbortController();
			const client = new StubClient(controller.signal);
			const run = processItem({
				client,
				config,
				product,
				index: 1,
				total: 1,
				runStarted: new Date(),
				name: parseDownloadName("{slug}"),
				capturer: new PageCapturer(client.jar, { png: false, pdf: false }),
				videos: null,
				downloadDir: root,
				signal: controller.signal,
			});
			// wait until the download is under way, then pull the plug
			while (client.chunksSent < 3) await Bun.sleep(5);
			const itemDir = join(root, "space-game");
			expect(await readdir(itemDir)).toContain("space-game.zip.incomplete");
			controller.abort();

			let error: unknown;
			await run.catch((err) => {
				error = err;
			});
			expect(isAbortError(error)).toBe(true);
			const left = await readdir(itemDir);
			expect(left).not.toContain("space-game.zip.incomplete");
			expect(left).not.toContain("space-game.zip");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
