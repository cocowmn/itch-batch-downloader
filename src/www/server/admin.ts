// Admin features of the download browser: a password from the config unlocks
// hiding and deleting items. Signing in sets a session cookie whose token
// lives in memory here, so every session ends when the server stops.
// Whether an item is hidden is recorded in its own .itchio marker file.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
	isMarkerHidden,
	setMarkerHidden,
} from "../../features/manifest/marker.ts";

export const ADMIN_COOKIE = "itch_admin";

/** Failed attempts from one address before it has to wait. */
const MAX_FAILURES = 5;
/** How long an address waits after too many failures. */
const LOCKOUT_MS = 30_000;

export type LoginResult =
	| { ok: true; token: string }
	| { ok: false; status: 401 | 404 | 429; message: string };

interface Failures {
	count: number;
	/** Timestamp until which attempts are refused. */
	until: number;
}

export class AdminSessions {
	private readonly digest: Buffer | null;
	private readonly tokens = new Set<string>();
	private readonly failures = new Map<string, Failures>();

	constructor(password: string | undefined) {
		this.digest = password ? sha256(password) : null;
	}

	/** Whether a password is configured at all. */
	get enabled(): boolean {
		return this.digest !== null;
	}

	/** Check `password`; `address` is throttled after repeated failures. */
	login(password: string, address = "?"): LoginResult {
		if (!this.digest) {
			return {
				ok: false,
				status: 404,
				message:
					"Admin features are off: set admin_password in the config file and restart.",
			};
		}
		const failed = this.failures.get(address);
		if (failed && failed.until > Date.now()) {
			return {
				ok: false,
				status: 429,
				message: `Too many attempts; try again in ${Math.ceil((failed.until - Date.now()) / 1000)} s.`,
			};
		}
		if (!timingSafeEqual(sha256(password), this.digest)) {
			const count = (failed?.count ?? 0) + 1;
			this.failures.set(address, {
				count,
				until: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0,
			});
			return { ok: false, status: 401, message: "Wrong password." };
		}
		this.failures.delete(address);
		const token = randomBytes(32).toString("hex");
		this.tokens.add(token);
		return { ok: true, token };
	}

	/** Whether the request carries a live session cookie. */
	isAdmin(req: Request): boolean {
		const token = cookieValue(req, ADMIN_COOKIE);
		return token !== null && this.tokens.has(token);
	}

	logout(req: Request): void {
		const token = cookieValue(req, ADMIN_COOKIE);
		if (token) this.tokens.delete(token);
	}

	/** `Set-Cookie` value for a session; no expiry, so it ends with the browser session. */
	static cookie(token: string): string {
		return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
	}

	static clearCookie(): string {
		return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
	}
}

function sha256(text: string): Buffer {
	return createHash("sha256").update(text, "utf8").digest();
}

export function cookieValue(req: Request, name: string): string | null {
	const header = req.headers.get("cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return null;
}

/**
 * The hidden items, read from and written to their `.itchio` markers on
 * demand so the flag travels with the directory and survives a re-download.
 */
export class HiddenItems {
	constructor(private readonly root: string) {}

	private dir(directory: string): string {
		return join(this.root, ...directory.split("/"));
	}

	/** Whether the item at `directory` (relative to the root, "/"-joined) is hidden. */
	async has(directory: string): Promise<boolean> {
		return (await isMarkerHidden(this.dir(directory))) === true;
	}

	/**
	 * Whether `segments` (a request path inside the root) is in, or is, a
	 * hidden item. The first marker on the way down is the item itself, so
	 * the walk stops there: nothing below an item is an item.
	 */
	async covers(segments: string[]): Promise<boolean> {
		for (let i = 1; i <= segments.length; i++) {
			const hidden = await isMarkerHidden(
				this.dir(segments.slice(0, i).join("/")),
			);
			if (hidden !== null) return hidden;
		}
		return false;
	}

	mark(directory: string, hidden: boolean): Promise<void> {
		return setMarkerHidden(this.dir(directory), hidden);
	}
}
