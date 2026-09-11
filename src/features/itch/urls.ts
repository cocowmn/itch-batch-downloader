export const ITCH_BASE = "https://itch.io";

/** Author slug from a *.itch.io URL (`author` in https://author.itch.io/game). */
export function authorFromUrl(url: string): string {
	try {
		const host = new URL(url).hostname.toLowerCase();
		if (host.endsWith(".itch.io")) {
			const sub = host.slice(0, -".itch.io".length);
			if (sub && sub !== "www") return sub;
		}
	} catch {
		// not a URL
	}
	return "";
}

export function absoluteUrl(href: string, base = ITCH_BASE): string {
	try {
		return new URL(href, base).toString();
	} catch {
		return href;
	}
}
