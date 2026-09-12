// Turns the configured bundle / product / author filters into the list of
// items to process.

import type { Config } from "../../models/config.ts";
import type { Bundle, BundleProduct, Product } from "../../models/product.ts";
import { log } from "../../utils/log.ts";
import { comparable } from "../../utils/slugify.ts";
import {
	fetchBundleProducts,
	fetchOwnedBundles,
	resolveBundleSelectors,
} from "../itch/bundles.ts";
import type { ItchClient } from "../itch/client.ts";
import { fetchPurchases, productFromDownloadUrl } from "../itch/purchases.ts";
import { authorFromUrl } from "../itch/urls.ts";

export interface Selection {
	products: Product[];
	/** Bundles that were used as the source, if any. */
	bundles: Bundle[];
	/** Items of selected bundles that are not claimed yet, grouped per bundle. */
	unclaimed: { bundle: Bundle; products: BundleProduct[] }[];
}

/** Keep products whose author slug or display name matches one of `authors`. */
export function filterByAuthors(
	products: Product[],
	authors: string[],
): Product[] {
	if (authors.length === 0) return products;
	const wanted = new Set(authors.map((a) => comparable(a)));
	return products.filter(
		(g) =>
			wanted.has(comparable(g.author)) ||
			(g.authorName && wanted.has(comparable(g.authorName))),
	);
}

export function bundleProductsToProducts(products: BundleProduct[]): Product[] {
	const out: Product[] = [];
	for (const bg of products) {
		if (!bg.claimed || !bg.dlurl) continue;
		const product = productFromDownloadUrl(bg.title, bg.dlurl, {
			productUrl: bg.productUrl,
			authorName: bg.authorName,
		});
		if (product) out.push(product);
	}
	return out;
}

/** What a product selector pins down; `text` is the selector itself. */
interface ProductSelector {
	text: string;
	author?: string;
	slug?: string;
	key?: string;
}

/**
 * Read a product selector: the item's page URL (https://author.itch.io/game),
 * its download page URL (.../game/download/KEY), "author/game", or free text
 * (a title or the item's URL slug).
 */
export function parseProductSelector(text: string): ProductSelector {
	const author = authorFromUrl(text);
	if (author) {
		// https://author.itch.io/game[/download/KEY]  ->  ["", "game", "download", "KEY"]
		const segments = new URL(text).pathname.split("/");
		const slug = segments[1] || undefined;
		const key =
			segments[2] === "download" ? segments[3] || undefined : undefined;
		return { text, author, slug, key };
	}
	const m = /^([\w-]+)\/([\w-]+)$/.exec(text);
	if (m?.[1] && m[2]) return { text, author: m[1], slug: m[2] };
	return { text };
}

/**
 * Pick the library items named by `selectors`. Throws when a selector matches
 * nothing or more than one item (a title shared by several authors).
 */
export function resolveProductSelectors(
	selectors: string[],
	library: Product[],
): Product[] {
	const result: Product[] = [];
	const missing: string[] = [];
	const ambiguous: string[] = [];
	for (const text of selectors) {
		const sel = parseProductSelector(text);
		let matches: Product[] = [];
		if (sel.key) matches = library.filter((g) => g.key === sel.key);
		if (matches.length === 0 && sel.author && sel.slug) {
			const author = comparable(sel.author);
			const slug = sel.slug.toLowerCase();
			matches = library.filter(
				(g) =>
					comparable(g.author) === author && g.itchSlug.toLowerCase() === slug,
			);
		}
		if (matches.length === 0 && !sel.author) {
			const wanted = comparable(text);
			matches = library.filter(
				(g) =>
					comparable(g.title) === wanted || g.itchSlug.toLowerCase() === wanted,
			);
		}
		if (matches.length === 0) {
			missing.push(text);
			continue;
		}
		if (matches.length > 1) {
			ambiguous.push(
				`${JSON.stringify(text)} matches ${matches
					.map((g) => `${g.author}/${g.itchSlug}`)
					.join(", ")}`,
			);
			continue;
		}
		const match = matches[0] as Product;
		if (!result.includes(match)) result.push(match);
	}
	const problems: string[] = [];
	if (missing.length) {
		problems.push(
			`Unknown product(s): ${missing.map((m) => JSON.stringify(m)).join(", ")}. ` +
				'Give the item\'s page URL (https://author.itch.io/game), "author/game" or its title; `list-products` shows what is in your library.',
		);
	}
	if (ambiguous.length) {
		problems.push(
			`Ambiguous product(s): ${ambiguous.join("; ")}. Use "author/game" or the page URL.`,
		);
	}
	if (problems.length) throw new Error(problems.join("\n"));
	return result;
}

export async function selectProducts(
	client: ItchClient,
	config: Pick<Config, "bundles" | "authors" | "products">,
): Promise<Selection> {
	let products: Product[] = [];
	const bundles: Bundle[] = [];
	const unclaimed: Selection["unclaimed"] = [];
	const seen = new Map<string, Product>();

	if (config.bundles.length > 0) {
		log.info("Loading bundles bound to this account ...");
		const owned = await fetchOwnedBundles(client);
		bundles.push(...resolveBundleSelectors(config.bundles, owned));
		for (const bundle of bundles) {
			const rows = await fetchBundleProducts(client, bundle);
			log.info(`Loading bundle "${bundle.name}": ${rows.length} items`);
			const notClaimed = rows.filter((r) => !r.claimed);
			if (notClaimed.length) unclaimed.push({ bundle, products: notClaimed });
			for (const g of bundleProductsToProducts(rows)) {
				const already = seen.get(g.dlurl);
				if (already) {
					already.bundles?.push(bundle);
					continue;
				}
				g.bundles = [bundle];
				seen.set(g.dlurl, g);
				products.push(g);
			}
		}
	}

	if (config.products.length > 0) {
		const library = await fetchPurchases(client);
		log.info(
			`Loading and parsing my claimed purchases: ${library.length} items`,
		);
		const picked = resolveProductSelectors(config.products, library);
		log.info(`${picked.length} item(s) selected by product.`);
		for (const g of picked) {
			// Items that a selected bundle already contributed keep their bundle info.
			if (seen.has(g.dlurl)) continue;
			seen.set(g.dlurl, g);
			products.push(g);
		}
	}

	if (config.bundles.length === 0 && config.products.length === 0) {
		products = await fetchPurchases(client);
		log.info(
			`Loading and parsing my claimed purchases: ${products.length} items`,
		);
	}

	const filtered = filterByAuthors(products, config.authors);
	if (config.authors.length > 0) {
		log.info(
			`${filtered.length} of ${products.length} items match author filter (${config.authors.join(", ")}).`,
		);
	}
	return { products: filtered, bundles, unclaimed };
}

export function reportUnclaimed(unclaimed: Selection["unclaimed"]): void {
	for (const { bundle, products } of unclaimed) {
		log.warn(
			`${products.length} item(s) in bundle "${bundle.name}" are not claimed and were skipped. ` +
				`Claim them at ${bundle.url} to include them in the next run.`,
		);
		for (const g of products)
			log.debug(`  not claimed: ${g.title} (${g.productUrl})`);
	}
}
