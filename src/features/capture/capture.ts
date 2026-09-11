// Product page captures (PNG screenshot + PDF print) via Bun.WebView driving
// an installed Chrome. Replaces Selenium + the util.py stitching workaround.

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { throwIfAborted } from "../../utils/abort.ts";
import { log } from "../../utils/log.ts";
import { dateStamp } from "../../utils/time.ts";
import type { CookieJar } from "../itch/cookie-jar.ts";

export interface CaptureOptions {
	png: boolean;
	pdf: boolean;
	chromePath?: string;
}

const MAX_DIMENSION = 16384; // Bun.WebView limit
const IMAGE_WAIT_MS = 30_000;

/**
 * Owns a single WebView for the whole run. The browser is only launched on the
 * first capture, and if launching fails captures are disabled for the rest of
 * the run instead of aborting the downloads.
 */
export class PageCapturer {
	private view: Bun.WebView | null = null;
	private disabled = false;

	constructor(
		private readonly jar: CookieJar,
		private readonly opts: CaptureOptions,
	) {}

	get enabled(): boolean {
		return (this.opts.png || this.opts.pdf) && !this.disabled;
	}

	private async getView(): Promise<Bun.WebView | null> {
		if (this.view) return this.view;
		if (this.disabled) return null;
		try {
			const backend: Bun.WebView.Backend = this.opts.chromePath
				? { type: "chrome", path: this.opts.chromePath }
				: { type: "chrome", url: false };
			const view = new Bun.WebView({ width: 1280, height: 1024, backend });
			// A first navigation is required before CDP commands are accepted.
			await view.navigate("about:blank");
			await this.installCookies(view);
			this.view = view;
			return view;
		} catch (err) {
			this.disabled = true;
			log.error(
				"Cannot start a browser for page captures; PNG/PDF creation disabled for this run.",
				err,
			);
			log.error(
				"Install Chrome/Chromium/Edge/Brave or set chrome_path, or turn off create_png/create_pdf.",
			);
			return null;
		}
	}

	/** Push the itch.io session into the browser so captures are authenticated. */
	private async installCookies(view: Bun.WebView): Promise<void> {
		const cookies = this.jar
			.all()
			.filter((c) => c.domain === "itch.io" || c.domain.endsWith(".itch.io"))
			.map((c) => ({
				name: c.name,
				value: c.value,
				domain: c.includeSubdomains ? `.${c.domain}` : c.domain,
				path: c.path,
				secure: c.secure,
			}));
		if (cookies.length === 0) return;
		await view.cdp("Network.setCookies", { cookies });
	}

	/**
	 * Capture `url` into `dir` as `{prefix}_webpage_screenshot_{YYYYMMDD}.png/.pdf`.
	 * A capture is skipped when one already exists and `force` is false
	 * (i.e. nothing new was downloaded for the item).
	 */
	async capture(
		url: string,
		dir: string,
		prefix: string,
		force: boolean,
		signal?: AbortSignal,
	): Promise<void> {
		if (!this.enabled) return;
		throwIfAborted(signal);
		const view = await this.getView();
		if (!view) return;

		await mkdir(dir, { recursive: true });
		const existing = await readdir(dir).catch(() => [] as string[]);
		const stem = `${prefix}_webpage_screenshot_`;
		const hasPng = existing.some(
			(f) => f.startsWith(stem) && f.endsWith(".png"),
		);
		const hasPdf = existing.some(
			(f) => f.startsWith(stem) && f.endsWith(".pdf"),
		);
		const wantPng = this.opts.png && (force || !hasPng);
		const wantPdf = this.opts.pdf && (force || !hasPdf);

		if (this.opts.png && !wantPng)
			log.info("Recent screenshot exists. Skipped.");
		if (this.opts.pdf && !wantPdf) log.info("Recent PDF exists. Skipped.");
		if (!wantPng && !wantPdf) return;

		const stamp = dateStamp();
		try {
			await view.navigate(url);
		} catch (err) {
			log.error(`Cannot load ${url} for capture`, err);
			return;
		}
		await this.waitForImages(view);

		if (wantPng) {
			const file = join(dir, `${stem}${stamp}.png`);
			try {
				await this.screenshot(view, file);
				log.info(`Screenshot taken: ${file}`);
			} catch (err) {
				log.error(`Error while writing file: ${file}`, err);
			}
		}
		if (wantPdf) {
			const file = join(dir, `${stem}${stamp}.pdf`);
			try {
				await this.pdf(view, file);
				log.info(`PDF created: ${file}`);
			} catch (err) {
				log.error(`Error while writing file: ${file}`, err);
			}
		}
	}

	private async waitForImages(view: Bun.WebView): Promise<void> {
		try {
			await view.evaluate(`
        Promise.race([
          Promise.all([...document.images].map(img => img.complete ? null : img.decode().catch(() => null))),
          new Promise(r => setTimeout(r, ${IMAGE_WAIT_MS})),
        ]).then(() => true)
      `);
		} catch (err) {
			log.error(`Timeout error waiting for images on: ${view.url}`, err);
		}
	}

	private async screenshot(view: Bun.WebView, file: string): Promise<void> {
		const size = (await view.evaluate(
			"({ w: Math.max(document.body.offsetWidth, document.documentElement.clientWidth), h: document.documentElement.scrollHeight })",
		)) as { w: number; h: number };
		const width = Math.min(
			MAX_DIMENSION,
			Math.max(1, Math.ceil(size.w || 1280)),
		);
		const height = Math.min(
			MAX_DIMENSION,
			Math.max(1, Math.ceil(size.h || 1024)),
		);
		log.debug(`Taking screenshot, width: ${width}, height: ${height}`);
		await view.resize(width, height);
		// Give lazy-loaded content that just entered the viewport a moment.
		await Bun.sleep(500);
		const png = await view.screenshot({ encoding: "buffer", format: "png" });
		await Bun.write(file, png);
		await view.resize(1280, 1024);
	}

	private async pdf(view: Bun.WebView, file: string): Promise<void> {
		// Same page setup as the Selenium version: A0 landscape (inches).
		const result = (await view.cdp("Page.printToPDF", {
			landscape: true,
			displayHeaderFooter: true,
			printBackground: true,
			preferCSSPageSize: false,
			paperWidth: 46.81,
			paperHeight: 33.11,
		})) as { data: string };
		await Bun.write(file, Buffer.from(result.data, "base64"));
	}

	close(): void {
		this.view?.close();
		this.view = null;
	}
}
