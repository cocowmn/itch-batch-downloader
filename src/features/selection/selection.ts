// Turns the configured bundle / author filters into the list of items to process.

import type { Config } from "../../models/config.ts";
import type { Bundle, BundleGame, Game } from "../../models/game.ts";
import { log } from "../../utils/log.ts";
import { comparable } from "../../utils/slugify.ts";
import {
	fetchBundleGames,
	fetchOwnedBundles,
	resolveBundleSelectors,
} from "../itch/bundles.ts";
import type { ItchClient } from "../itch/client.ts";
import { fetchPurchases, gameFromDownloadUrl } from "../itch/purchases.ts";

export interface Selection {
	games: Game[];
	/** Bundles that were used as the source, if any. */
	bundles: Bundle[];
	/** Items of selected bundles that are not claimed yet, grouped per bundle. */
	unclaimed: { bundle: Bundle; games: BundleGame[] }[];
}

/** Keep games whose author slug or display name matches one of `authors`. */
export function filterByAuthors(games: Game[], authors: string[]): Game[] {
	if (authors.length === 0) return games;
	const wanted = new Set(authors.map((a) => comparable(a)));
	return games.filter(
		(g) =>
			wanted.has(comparable(g.author)) ||
			(g.authorName && wanted.has(comparable(g.authorName))),
	);
}

export function bundleGamesToGames(games: BundleGame[]): Game[] {
	const out: Game[] = [];
	for (const bg of games) {
		if (!bg.claimed || !bg.dlurl) continue;
		const game = gameFromDownloadUrl(bg.title, bg.dlurl, {
			gameUrl: bg.gameUrl,
			authorName: bg.authorName,
		});
		if (game) out.push(game);
	}
	return out;
}

export async function selectGames(
	client: ItchClient,
	config: Pick<Config, "bundles" | "authors">,
): Promise<Selection> {
	let games: Game[];
	const bundles: Bundle[] = [];
	const unclaimed: Selection["unclaimed"] = [];

	if (config.bundles.length > 0) {
		log.info("Loading bundles bound to this account ...");
		const owned = await fetchOwnedBundles(client);
		bundles.push(...resolveBundleSelectors(config.bundles, owned));
		games = [];
		const seen = new Map<string, Game>();
		for (const bundle of bundles) {
			const rows = await fetchBundleGames(client, bundle);
			log.info(`Loading bundle "${bundle.name}": ${rows.length} items`);
			const notClaimed = rows.filter((r) => !r.claimed);
			if (notClaimed.length) unclaimed.push({ bundle, games: notClaimed });
			for (const g of bundleGamesToGames(rows)) {
				const already = seen.get(g.dlurl);
				if (already) {
					already.bundles?.push(bundle);
					continue;
				}
				g.bundles = [bundle];
				seen.set(g.dlurl, g);
				games.push(g);
			}
		}
	} else {
		games = await fetchPurchases(client);
		log.info(`Loading and parsing my claimed purchases: ${games.length} items`);
	}

	const filtered = filterByAuthors(games, config.authors);
	if (config.authors.length > 0) {
		log.info(
			`${filtered.length} of ${games.length} items match author filter (${config.authors.join(", ")}).`,
		);
	}
	return { games: filtered, bundles, unclaimed };
}

export function reportUnclaimed(unclaimed: Selection["unclaimed"]): void {
	for (const { bundle, games } of unclaimed) {
		log.warn(
			`${games.length} item(s) in bundle "${bundle.name}" are not claimed and were skipped. ` +
				`Claim them at ${bundle.url} to include them in the next run.`,
		);
		for (const g of games)
			log.debug(`  not claimed: ${g.title} (${g.gameUrl})`);
	}
}
