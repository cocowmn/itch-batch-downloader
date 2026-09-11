import { load } from "cheerio";
import type { Game } from "../../models/game.ts";
import { log } from "../../utils/log.ts";
import { slugify } from "../../utils/slugify.ts";
import type { ItchClient } from "./client.ts";
import { absoluteUrl, authorFromUrl, ITCH_BASE } from "./urls.ts";

export const MY_PURCHASES_URL = `${ITCH_BASE}/my-purchases`;

/** Build a Game from its download page URL plus what the listing knew about it. */
export function gameFromDownloadUrl(
	title: string,
	dlurl: string,
	extra: { authorName?: string; gameUrl?: string } = {},
): Game | null {
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
	const gameUrl = extra.gameUrl ?? `${u.origin}/${itchSlug}`;
	return {
		title: title.trim(),
		slug: slugify(title),
		dlurl,
		gameUrl,
		author: authorFromUrl(gameUrl) || authorFromUrl(dlurl),
		authorName: extra.authorName?.trim() ?? "",
		key,
		itchSlug,
	};
}

/** Parse one page of https://itch.io/my-purchases. */
export function parsePurchasesPage(html: string): {
	games: Game[];
	hasNext: boolean;
} {
	const $ = load(html);
	const games: Game[] = [];
	$("div.game_cell_data").each((_, el) => {
		const cell = $(el);
		const title = cell.find("a.title.game_link").first().text();
		const dlurl = cell.find("a.button").first().attr("href");
		if (!title || !dlurl) return;
		const authorLink = cell.find("div.game_author a").first();
		const game = gameFromDownloadUrl(title, absoluteUrl(dlurl), {
			authorName: authorLink.text(),
		});
		if (!game) return;
		const authorHref = authorLink.attr("href");
		if (!game.author && authorHref)
			game.author = authorFromUrl(absoluteUrl(authorHref));
		games.push(game);
	});
	const hasNext = $("div.next_page.forward_link, a.next_page").length > 0;
	return { games, hasNext };
}

/** Fetch every item in the account library. */
export async function fetchPurchases(client: ItchClient): Promise<Game[]> {
	const games: Game[] = [];
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
		const { games: pageGames, hasNext } = parsePurchasesPage(await res.text());
		for (const g of pageGames)
			log.debug(`Item found - Title: ${g.slug}. url: ${g.dlurl}`);
		games.push(...pageGames);
		if (!hasNext || pageGames.length === 0) break;
		page++;
		log.dot();
	}
	return games;
}
