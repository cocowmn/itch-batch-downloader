import { type CheerioAPI, load } from "cheerio";
import type { Product } from "../../models/product.ts";
import { log } from "../../utils/log.ts";
import type { ItchClient } from "./client.ts";
import { absoluteUrl } from "./urls.ts";

/** One entry of the upload list on a download page. */
export interface UploadRef {
	/** 1-based position on the page, used to make local filenames unique. */
	index: number;
	/** Legacy pages: the data-upload_id attribute. */
	uploadId?: string;
	/** Newer pages: an href containing "/download/" that returns JSON. */
	directUrl?: string;
}

export interface DownloadPage {
	csrfToken: string;
	uploads: UploadRef[];
}

export function parseDownloadPage(html: string): DownloadPage {
	const $ = load(html);
	const csrfToken = $('meta[name="csrf_token"]').attr("value") ?? "";
	const uploads: UploadRef[] = [];
	const pageFallback = findDownloadHref($, $.root());

	$("div.upload_list_widget .upload").each((i, el) => {
		const block = $(el);
		const ref: UploadRef = { index: i + 1 };
		const uploadId = block
			.find("a[data-upload_id]")
			.first()
			.attr("data-upload_id");
		if (uploadId) {
			ref.uploadId = uploadId;
		} else {
			const direct = findDownloadHref($, block) ?? pageFallback;
			if (direct) ref.directUrl = direct;
		}
		uploads.push(ref);
	});
	return { csrfToken, uploads };
}

function findDownloadHref(
	$: CheerioAPI,
	scope: ReturnType<CheerioAPI>,
): string | undefined {
	let found: string | undefined;
	scope.find("a, button").each((_, el) => {
		if (found) return;
		const href = $(el).attr("href");
		if (href?.includes("/download/")) found = href;
	});
	return found;
}

/**
 * Resolve the real (CDN) URL of an upload. Returns null when itch.io does not
 * expose a download button for it.
 */
export async function resolveUploadUrl(
	client: ItchClient,
	product: Product,
	page: DownloadPage,
	upload: UploadRef,
): Promise<string | null> {
	const params = new URLSearchParams({
		source: "game_download",
		key: product.key,
	});
	let res: Response;
	if (upload.uploadId) {
		// Legacy flow: POST {productUrl}/file/{upload_id}?source=game_download&key=KEY
		const url = `${product.productUrl}/file/${upload.uploadId}?${params}`;
		res = await client.post(
			url,
			new URLSearchParams({ csrf_token: page.csrfToken }),
		);
	} else if (upload.directUrl) {
		const base = absoluteUrl(upload.directUrl, product.productUrl);
		const url = base.includes("?") ? `${base}&${params}` : `${base}?${params}`;
		res = await client.get(url);
	} else {
		log.warn(
			`Skipped a file (no download button found): ${product.productUrl}`,
		);
		return null;
	}
	if (!res.ok) {
		log.warn(`Skipped a file (HTTP ${res.status}): ${res.url}`);
		return null;
	}
	const json = (await res.json()) as { url?: string };
	if (!json.url) {
		log.warn(`Skipped a file (no url in response): ${res.url}`);
		return null;
	}
	return json.url;
}

export type HostKind = "cloudflare" | "hwcdn" | "google-drive" | "other";

export function classifyHost(url: string): HostKind {
	const host = new URL(url).hostname;
	if (
		host.includes("cloudflarestorage.com") ||
		host.startsWith("itchio-mirror")
	)
		return "cloudflare";
	if (host === "w3g3a5v6.ssl.hwcdn.net") return "hwcdn";
	if (host === "drive.google.com") return "google-drive";
	return "other";
}
