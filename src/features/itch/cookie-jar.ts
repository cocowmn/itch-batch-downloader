// Netscape cookies.txt support. Only the pieces needed to talk to itch.io:
// parsing the exported file and building a Cookie header for a request URL.

export interface CookieRecord {
	domain: string;
	/** Whether the domain line started with a dot (also matches subdomains). */
	includeSubdomains: boolean;
	path: string;
	secure: boolean;
	name: string;
	value: string;
}

/** True when no line is a Netscape record but the text has `name=value` pairs. */
function looksLikeCookieHeader(text: string): boolean {
	const lines = text
		.split(/\r?\n/)
		.filter((l) => l.trim() && !l.startsWith("#"));
	if (lines.length === 0) return false;
	if (lines.some((l) => l.split("\t").length >= 7)) return false;
	return lines.every((l) => l.split(";").some((p) => p.includes("=")));
}

export class CookieJar {
	private cookies: CookieRecord[] = [];

	static async fromFile(path: string): Promise<CookieJar> {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			throw new Error(`Cookie file not found: ${path}`);
		}
		return CookieJar.parse(await file.text());
	}

	/**
	 * Accepts either the Netscape cookies.txt format or the raw value of a
	 * `Cookie` request header (`name=value; name2=value2`) as copied from the
	 * browser's developer tools. Header-format cookies are bound to
	 * `defaultDomain` and its subdomains.
	 */
	static parse(text: string, defaultDomain = "itch.io"): CookieJar {
		const jar = new CookieJar();
		if (looksLikeCookieHeader(text)) {
			const raw = text.replace(/^\s*cookie\s*:/i, "").replace(/\r?\n/g, " ");
			for (const part of raw.split(";")) {
				const eq = part.indexOf("=");
				if (eq < 0) continue;
				const name = part.slice(0, eq).trim();
				const value = part.slice(eq + 1).trim();
				if (!name) continue;
				jar.set({
					domain: defaultDomain,
					includeSubdomains: true,
					path: "/",
					secure: true,
					name,
					value,
				});
			}
			return jar;
		}
		for (let line of text.split(/\r?\n/)) {
			// Browser extensions write HttpOnly cookies as "#HttpOnly_.itch.io\t...".
			// Python's MozillaCookieJar drops those; we keep them since the
			// session cookie is HttpOnly.
			if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
			if (!line.trim() || line.startsWith("#")) continue;
			const parts = line.split("\t");
			if (parts.length < 7) continue;
			const [domain, flag, path, secure, , name, value] = parts as [
				string,
				string,
				string,
				string,
				string,
				string,
				string,
			];
			jar.set({
				domain: domain.replace(/^\./, "").toLowerCase(),
				includeSubdomains:
					domain.startsWith(".") || flag.toUpperCase() === "TRUE",
				path: path || "/",
				secure: secure.toUpperCase() === "TRUE",
				name,
				value: value.trimEnd(),
			});
		}
		return jar;
	}

	get size(): number {
		return this.cookies.length;
	}

	all(): readonly CookieRecord[] {
		return this.cookies;
	}

	set(cookie: CookieRecord): void {
		const idx = this.cookies.findIndex(
			(c) =>
				c.name === cookie.name &&
				c.domain === cookie.domain &&
				c.path === cookie.path,
		);
		if (idx >= 0) this.cookies[idx] = cookie;
		else this.cookies.push(cookie);
	}

	/** Cookies applicable to `url`, longest path first (RFC 6265 ordering). */
	cookiesFor(url: string | URL): CookieRecord[] {
		const u = typeof url === "string" ? new URL(url) : url;
		const host = u.hostname.toLowerCase();
		const isHttps = u.protocol === "https:";
		return this.cookies
			.filter((c) => {
				if (c.secure && !isHttps) return false;
				const domainMatch =
					host === c.domain ||
					(c.includeSubdomains && host.endsWith(`.${c.domain}`));
				if (!domainMatch) return false;
				return (
					u.pathname === c.path ||
					u.pathname.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`)
				);
			})
			.sort((a, b) => b.path.length - a.path.length);
	}

	headerFor(url: string | URL): string {
		return this.cookiesFor(url)
			.map((c) => `${c.name}=${c.value}`)
			.join("; ");
	}

	/** Merge `Set-Cookie` headers from a response into the jar. */
	applySetCookies(response: Response, requestUrl = response.url): void {
		const reqHost = new URL(requestUrl).hostname.toLowerCase();
		for (const raw of response.headers.getSetCookie()) {
			const [pair, ...attrs] = raw.split(";");
			if (!pair) continue;
			const eq = pair.indexOf("=");
			if (eq < 0) continue;
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			let domain = reqHost;
			let includeSubdomains = false;
			let path = "/";
			let secure = false;
			for (const attr of attrs) {
				const [k, v = ""] = attr.trim().split("=", 2) as [string, string?];
				switch (k.toLowerCase()) {
					case "domain":
						domain = v.replace(/^\./, "").toLowerCase();
						includeSubdomains = true;
						break;
					case "path":
						path = v || "/";
						break;
					case "secure":
						secure = true;
						break;
				}
			}
			this.set({ domain, includeSubdomains, path, secure, name, value });
		}
	}
}
