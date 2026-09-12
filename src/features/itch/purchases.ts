import { load } from "cheerio";
import type { Product } from "../../models/product.ts";
import { log } from "../../utils/log.ts";
import { slugify } from "../../utils/slugify.ts";
import type { ItchClient } from "./client.ts";
import { absoluteUrl, authorFromUrl, ITCH_BASE } from "./urls.ts";

export const MY_PURCHASES_URL = `${ITCH_BASE}/my-purchases`;

/** Build a Product from its download page URL plus what the listing knew about it. */
export function productFromDownloadUrl(
	title: string,
	dlurl: string,
	extra: { authorName?: string; productUrl?: string } = {},
): Product | null {
	let u: URL;
	try {
		u = new URL(dlurl);
	} catch {
		return null;
	}
	// https://author.itch.io/game/download/KEY  ->  ["", "game", "download", "KEY"]
	const segments = u.pathname.split("/");
	const itchSlug = segments[1] ?? "";
	const key = segments[3] ?? "";
	if (!itchSlug) return null;
	const productUrl = extra.productUrl ?? `${u.origin}/${itchSlug}`;
	return {
		title: title.trim(),
		slug: slugify(title),
		dlurl,
		productUrl,
		author: authorFromUrl(productUrl) || authorFromUrl(dlurl),
		authorName: extra.authorName?.trim() ?? "",
		key,
		itchSlug,
	};
}

/** Parse one page of https://itch.io/my-purchases. */
export function parsePurchasesPage(html: string): {
	products: Product[];
	hasNext: boolean;
} {
	const $ = load(html);
	const products: Product[] = [];
	$("div.game_cell_data").each((_, el) => {
		const cell = $(el);
		const title = cell.find("a.title.game_link").first().text();
		const dlurl = cell.find("a.button").first().attr("href");
		if (!title || !dlurl) return;
		const authorLink = cell.find("div.game_author a").first();
		const product = productFromDownloadUrl(title, absoluteUrl(dlurl), {
			authorName: authorLink.text(),
		});
		if (!product) return;
		const authorHref = authorLink.attr("href");
		if (!product.author && authorHref)
			product.author = authorFromUrl(absoluteUrl(authorHref));
		products.push(product);
	});
	const hasNext = $("div.next_page.forward_link, a.next_page").length > 0;
	return { products, hasNext };
}

/** Fetch every item in the account library. */
export async function fetchPurchases(client: ItchClient): Promise<Product[]> {
	const products: Product[] = [];
	let page = 1;
	for (;;) {
		const url =
			page === 1 ? MY_PURCHASES_URL : `${MY_PURCHASES_URL}?page=${page}`;
		const res = await client.get(url);
		if (res.status !== 200) {
			if (page === 1)
				throw new Error(`Could not access ${url} properly [${res.status}]`);
			log.warn(`Stopping at page ${page}: HTTP ${res.status}`);
			break;
		}
		const { products: pageProducts, hasNext } = parsePurchasesPage(
			await res.text(),
		);
		for (const g of pageProducts)
			log.debug(`Item found - Title: ${g.slug}. url: ${g.dlurl}`);
		products.push(...pageProducts);
		if (!hasNext || pageProducts.length === 0) break;
		page++;
		log.dot();
	}
	return products;
}
