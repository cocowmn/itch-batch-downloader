import { load } from "cheerio";
import type { Bundle, BundleProduct } from "../../models/product.ts";
import { log } from "../../utils/log.ts";
import { comparable } from "../../utils/slugify.ts";
import type { ItchClient } from "./client.ts";
import { absoluteUrl, authorFromUrl, ITCH_BASE } from "./urls.ts";

export const MY_BUNDLES_URL = `${ITCH_BASE}/my-purchases/bundles`;

export function bundleUrl(key: string): string {
	return `${ITCH_BASE}/bundle/download/${key}`;
}

/**
 * Parse https://itch.io/my-purchases/bundles. Every bundle is a
 * `section.game_collection` whose header (`h2 > a.collection_title`) links to
 * the bundle download page; the item cells below it link there too, so only
 * the title links are used.
 */
export function parseBundlesPage(html: string): Bundle[] {
	const $ = load(html);
	const bundles: Bundle[] = [];
	$("a.collection_title[href*='/bundle/download/']").each((_, el) => {
		const link = $(el);
		const href = link.attr("href");
		// The title span excludes the "View all" button nested in the same link.
		const name = (
			link.find(".collection_title_wrap").first().text() || link.text()
		).trim();
		if (!href) return;
		const m = /\/bundle\/download\/([^/?#]+)/.exec(href);
		if (!m?.[1]) return;
		const key = m[1];
		if (bundles.some((b) => b.key === key)) return;
		bundles.push({ name, key, url: bundleUrl(key) });
	});
	return bundles;
}

export async function fetchOwnedBundles(client: ItchClient): Promise<Bundle[]> {
	const res = await client.get(MY_BUNDLES_URL);
	if (res.status !== 200)
		throw new Error(
			`Could not access ${MY_BUNDLES_URL} properly [${res.status}]`,
		);
	return parseBundlesPage(await res.text());
}

/**
 * Parse one page of https://itch.io/bundle/download/KEY. Claimed rows link to
 * the item's download page (`.../download/KEY`) from both the title and the
 * download button; unclaimed rows carry a claim form instead.
 */
export function parseBundlePage(html: string): {
	products: BundleProduct[];
	hasNext: boolean;
} {
	const $ = load(html);
	const products: BundleProduct[] = [];
	$("div.game_row").each((_, el) => {
		const row = $(el);
		const titleLink = row.find(".game_title a").first();
		const title = titleLink.text().trim();
		const titleHref = titleLink.attr("href");
		if (!title || !titleHref) return;
		const productUrl = absoluteUrl(titleHref).replace(
			/\/download\/[^/?#]+.*$/,
			"",
		);
		const dlHref = row.find("a.game_download_btn").first().attr("href");
		const authorLink = row.find(".game_author a").first();
		products.push({
			title,
			productUrl,
			author:
				authorFromUrl(productUrl) ||
				authorFromUrl(absoluteUrl(authorLink.attr("href") ?? "")),
			authorName: authorLink.text().trim(),
			claimed: !!dlHref,
			...(dlHref ? { dlurl: absoluteUrl(dlHref) } : {}),
		});
	});
	const hasNext = $("a.next_page, div.next_page").length > 0;
	return { products, hasNext };
}

export async function fetchBundleProducts(
	client: ItchClient,
	bundle: Bundle,
): Promise<BundleProduct[]> {
	const products: BundleProduct[] = [];
	let page = 1;
	for (;;) {
		const url = page === 1 ? bundle.url : `${bundle.url}?page=${page}`;
		const res = await client.get(url);
		if (res.status !== 200) {
			if (page === 1)
				throw new Error(
					`Could not access bundle "${bundle.name}" (${url}) [${res.status}]`,
				);
			log.warn(
				`Stopping bundle "${bundle.name}" at page ${page}: HTTP ${res.status}`,
			);
			break;
		}
		const { products: pageProducts, hasNext } = parseBundlePage(
			await res.text(),
		);
		products.push(...pageProducts);
		if (!hasNext || pageProducts.length === 0) break;
		page++;
		log.dot();
	}
	return products;
}

/**
 * Match user supplied selectors (name, key or URL) against the owned bundles.
 * Throws when a selector matches nothing, listing what is available.
 */
export function resolveBundleSelectors(
	selectors: string[],
	owned: Bundle[],
): Bundle[] {
	const result: Bundle[] = [];
	const missing: string[] = [];
	for (const sel of selectors) {
		const key = /\/bundle\/download\/([^/?#]+)/.exec(sel)?.[1] ?? sel;
		const match = owned.find(
			(b) =>
				b.key === key ||
				b.name.toLowerCase() === sel.toLowerCase() ||
				comparable(b.name) === comparable(sel),
		);
		if (!match) {
			missing.push(sel);
			continue;
		}
		if (!result.includes(match)) result.push(match);
	}
	if (missing.length) {
		const available = owned
			.map((b) => `  - ${b.name} (key: ${b.key})`)
			.join("\n");
		throw new Error(
			`Unknown bundle selector(s): ${missing.map((m) => JSON.stringify(m)).join(", ")}.\nBundles bound to this account:\n${available || "  (none)"}`,
		);
	}
	return result;
}
