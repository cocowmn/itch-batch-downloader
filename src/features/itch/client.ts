import pkg from "../../../package.json";
import type { Config } from "../../models/config.ts";
import { sleep } from "../../utils/abort.ts";
import { log } from "../../utils/log.ts";
import { formatDuration } from "../../utils/time.ts";
import { CookieJar } from "./cookie-jar.ts";

const MAX_REDIRECTS = 5;
/** Pause after an HTTP 429 without a usable Retry-After header. */
const DEFAULT_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 3_600_000;
const USER_AGENT = `itch-batch-downloader/${pkg.version} (+https://github.com/alteregocc/itch-batch-downloader)`;

export class NotAuthenticatedError extends Error {
	constructor() {
		super("Not properly authenticated, please provide (fresh) cookies.");
	}
}

export class HttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly url: string,
	) {
		super(`HTTP ${status} for ${url}`);
	}
}

/**
 * Small fetch wrapper that attaches the itch.io session cookies to requests
 * against *.itch.io and keeps the jar updated from responses.
 */
export class ItchClient {
	/**
	 * After an HTTP 429 every request of this client (all workers) waits until
	 * this time before going out.
	 */
	private pausedUntil = 0;

	/**
	 * @param signal Aborts every request of this client (a cancelled
	 *   download-browser job); requests may also pass their own.
	 */
	constructor(
		readonly jar: CookieJar,
		readonly signal?: AbortSignal,
	) {}

	private shouldSendCookies(url: string): boolean {
		const host = new URL(url).hostname;
		return host === "itch.io" || host.endsWith(".itch.io");
	}

	/**
	 * Redirects are followed manually so that a bounce to the login page (what
	 * itch.io does for unauthenticated requests to account pages) can be
	 * reported clearly instead of surfacing as a 403 from the login page's bot
	 * protection.
	 */
	async fetch(url: string, init: RequestInit = {}): Promise<Response> {
		let current = url;
		let method = init.method ?? "GET";
		let body = init.body;
		let retried = false;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			await this.waitIfPaused(init.signal ?? this.signal);
			const headers = new Headers(init.headers);
			headers.set("User-Agent", USER_AGENT);
			if (this.shouldSendCookies(current)) {
				const cookie = this.jar.headerFor(current);
				if (cookie) headers.set("Cookie", cookie);
			}
			log.debug(`${method} ${current}`);
			const res = await fetch(current, {
				...init,
				method,
				body,
				headers,
				redirect: "manual",
				signal: init.signal ?? this.signal,
			});
			if (this.shouldSendCookies(current))
				this.jar.applySetCookies(res, current);

			const location = res.headers.get("location");
			if (res.status >= 300 && res.status < 400 && location) {
				await res.body?.cancel();
				const next = new URL(location, current);
				if (next.hostname === "itch.io" && next.pathname === "/login")
					throw new NotAuthenticatedError();
				current = next.toString();
				if (
					res.status === 303 ||
					((res.status === 301 || res.status === 302) && method === "POST")
				) {
					method = "GET";
					body = undefined;
				}
				continue;
			}
			if (res.status === 429) {
				const pause = retryAfterMs(res.headers.get("retry-after"));
				this.pausedUntil = Math.max(this.pausedUntil, Date.now() + pause);
				log.warn(
					`Rate limited by ${new URL(current).hostname} (HTTP 429); pausing all requests for ${formatDuration(pause)}${retried ? "" : ", then retrying"}.`,
				);
				// One retry after the pause; a second 429 goes back to the caller.
				if (!retried) {
					retried = true;
					await res.body?.cancel();
					hop--;
					continue;
				}
			}
			return res;
		}
		throw new Error(`Too many redirects for ${url}`);
	}

	private async waitIfPaused(signal?: AbortSignal): Promise<void> {
		const wait = this.pausedUntil - Date.now();
		if (wait > 0) await sleep(wait, signal);
	}

	get(url: string, init: RequestInit = {}): Promise<Response> {
		return this.fetch(url, { ...init, method: "GET" });
	}

	head(url: string): Promise<Response> {
		return this.fetch(url, { method: "HEAD" });
	}

	post(
		url: string,
		body: URLSearchParams | FormData | string,
		init: RequestInit = {},
	): Promise<Response> {
		return this.fetch(url, { ...init, method: "POST", body });
	}

	/** GET and return the body as text; throws HttpError on non-2xx. */
	async text(url: string): Promise<string> {
		const res = await this.get(url);
		if (!res.ok) throw new HttpError(res.status, url);
		return res.text();
	}
}

/**
 * The pause a 429 asks for: `Retry-After` in seconds or as an HTTP date,
 * `DEFAULT_BACKOFF_MS` when absent or unreadable, capped at an hour.
 */
export function retryAfterMs(header: string | null): number {
	if (header === null) return DEFAULT_BACKOFF_MS;
	const value = header.trim();
	let ms: number;
	if (/^\d+$/.test(value)) ms = Number(value) * 1000;
	else {
		const date = Date.parse(value);
		if (Number.isNaN(date)) return DEFAULT_BACKOFF_MS;
		ms = date - Date.now();
	}
	return Math.min(MAX_BACKOFF_MS, Math.max(0, ms));
}

/** The client of a run: the session cookies from `config.cookie_file`. */
export async function createClient(
	config: Config,
	signal?: AbortSignal,
): Promise<ItchClient> {
	const jar = await CookieJar.fromFile(config.cookie_file);
	if (jar.size === 0) log.warn(`No cookies found in ${config.cookie_file}`);
	return new ItchClient(jar, signal);
}
