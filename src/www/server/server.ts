// The download-browser: a local web app for browsing what has been downloaded.
// Serves the bundled UI, a JSON view of the download directory and the files
// themselves. Download keys never leave the server: the library JSON and the
// manifest files are served without them (see redactItem / serveManifest),
// so `--host` can open the browser to the network. With `admin_password`
// set, a signed-in admin can hide items (invisible and unreachable for
// everyone else), delete them and unzip archives in place; see admin.ts.

import { rm, rmdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, resolve, sep } from "node:path";
import {
	MANIFEST_SUFFIX,
	redactManifest,
} from "../../features/manifest/manifest.ts";
import type { Config } from "../../models/config.ts";
import type {
	AdminStatus,
	LibraryItem,
	LibraryResponse,
} from "../../models/library.ts";
import type { Manifest } from "../../models/manifest.ts";
import { log } from "../../utils/log.ts";
import ui from "../client/index.html";
import { AdminSessions, HiddenItems } from "./admin.ts";
import { FetchJobs, JobError } from "./jobs.ts";
import { scanItemTree, scanLibrary } from "./library.ts";
import { extractZip, UnzipError } from "./unzip.ts";
import { zipDirectory } from "./zip.ts";

export interface BrowserOptions {
	/** Preferred port; falls back to a free one when taken. Default 3737. */
	port?: number;
	/** Interface to listen on. Default 127.0.0.1. */
	host?: string;
	/** Open the page in the default browser once the server is up. */
	open?: boolean;
}

export const DEFAULT_PORT = 3737;
export const DEFAULT_HOST = "127.0.0.1";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

export function isLoopback(address: string | undefined): boolean {
	return address !== undefined && LOOPBACK.has(address);
}

/**
 * Strip everything a manifest only carries with `manifest_include_keys`:
 * the download page URL and the bundles' keys. The UI never needs them;
 * `fetchable` tells it whether the server could fetch the item again.
 */
export function redactItem(item: LibraryItem): LibraryItem {
	return {
		...item,
		urls: item.urls ? { page: item.urls.page } : null,
		bundles: item.bundles.map((b) => ({ name: b.name })),
	};
}

export function redactLibrary(lib: LibraryResponse): LibraryResponse {
	return { ...lib, items: lib.items.map(redactItem) };
}

/**
 * Unless the reader is an admin, drop the hidden items and recount the
 * totals as if they did not exist.
 */
export function applyHidden(
	lib: LibraryResponse,
	admin: boolean,
): LibraryResponse {
	const items = admin ? lib.items : lib.items.filter((i) => !i.hidden);
	return {
		...lib,
		totals: {
			items: items.length,
			size: items.reduce((acc, i) => acc + i.size, 0),
			withManifest: items.filter((i) => i.hasManifest).length,
			withCover: items.filter((i) => i.cover !== null).length,
		},
		items,
	};
}

/**
 * The decoded segments of a `/files/<dir>/<name...>` (or `/api/item/<dir>`,
 * `/api/zip/<dir>`, `/api/admin/unzip/<dir>/<name...>`) path, or null when a
 * segment is empty, `.`/`..` or otherwise unusable. Files need at least `dir/name`; `allowDirectory`
 * accepts a bare item directory (used by reveal and the item/zip routes,
 * never by the file route).
 */
export function parseFilePath(
	pathname: string,
	allowDirectory = false,
): string[] | null {
	let rel: string[];
	try {
		rel = pathname
			.replace(
				/^\/(?:files|api\/item|api\/zip|api\/fetch|api\/admin\/item|api\/admin\/unzip)\//,
				"",
			)
			.split("/")
			.map((s) => decodeURIComponent(s));
	} catch {
		return null;
	}
	if (
		rel.length < (allowDirectory ? 1 : 2) ||
		rel.some((s) => !s || s === "." || s === ".." || s.includes("\0"))
	)
		return null;
	return rel;
}

/** Resolve a `/files/...` path to a path inside `root`, or null. */
export function resolveFilePath(
	root: string,
	pathname: string,
	allowDirectory = false,
): string | null {
	const rel = parseFilePath(pathname, allowDirectory);
	if (!rel) return null;
	const full = resolve(root, ...rel);
	const base = resolve(root);
	if (full !== base && !full.startsWith(base + sep)) return null;
	return full;
}

/** The manifest at `path` as JSON without its keys, or null when unreadable. */
export async function redactedManifestBytes(
	path: string,
): Promise<Uint8Array | null> {
	try {
		const parsed: unknown = await Bun.file(path).json();
		if (typeof parsed !== "object" || parsed === null) return null;
		return new TextEncoder().encode(
			`${JSON.stringify(redactManifest(parsed as Manifest), null, 2)}\n`,
		);
	} catch {
		return null;
	}
}

/** Manifests are never sent as they are on disk: the keys stay here. */
async function serveManifest(path: string): Promise<Response> {
	const bytes = await redactedManifestBytes(path);
	if (!bytes) return new Response("Not found", { status: 404 });
	const name = path.split(sep).pop() ?? "manifest.json";
	return new Response(bytes, {
		headers: {
			"content-type": "application/json;charset=utf-8",
			"cache-control": "no-cache",
			"content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
		},
	});
}

async function serveFile(ctx: ServerContext, req: Request): Promise<Response> {
	const pathname = new URL(req.url).pathname;
	const path = resolveFilePath(ctx.root, pathname);
	if (!path || (await ctx.concealed(req, pathname)))
		return new Response("Not found", { status: 404 });
	if (path.endsWith(MANIFEST_SUFFIX)) return serveManifest(path);
	const file = Bun.file(path);
	if (!(await file.exists())) return new Response("Not found", { status: 404 });
	const inline =
		file.type.startsWith("image/") ||
		file.type.startsWith("video/") ||
		file.type.startsWith("audio/") ||
		file.type === "application/pdf" ||
		file.type.startsWith("text/") ||
		file.type.startsWith("application/json");
	const name = path.split(sep).pop() ?? "file";
	return new Response(file, {
		headers: {
			"cache-control": "no-cache",
			"content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
		},
	});
}

/** Show `path` in the platform's file manager (Finder, Explorer, ...). */
async function reveal(path: string, isDirectory: boolean): Promise<void> {
	let cmd: string[];
	switch (process.platform) {
		case "darwin":
			cmd = isDirectory ? ["open", path] : ["open", "-R", path];
			break;
		case "win32":
			cmd = isDirectory ? ["explorer", path] : ["explorer", `/select,${path}`];
			break;
		default:
			cmd = ["xdg-open", isDirectory ? path : resolve(path, "..")];
	}
	const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
}

function openInBrowser(url: string): void {
	const cmd =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: ["xdg-open", url];
	try {
		Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
	} catch (err) {
		log.warn(`Could not open a browser automatically: ${String(err)}`);
	}
}

interface ServerContext {
	root: string;
	host: string;
	port: number;
	jobs: FetchJobs;
	admin: AdminSessions;
	hidden: HiddenItems;
	/** Whether `pathname` (a files/item/zip/fetch route) is inside a hidden item the requester may not see. */
	concealed(req: Request, pathname: string): Promise<boolean>;
}

const NO_STORE = { "cache-control": "no-store" };

/**
 * Delete an item directory and the now-empty directories a nested
 * `download_name` left above it (an empty top-level directory would
 * otherwise be listed as a legacy item).
 */
export async function deleteItemDirectory(
	root: string,
	path: string,
): Promise<void> {
	await rm(path, { recursive: true, force: true });
	const base = resolve(root);
	for (let dir = dirname(path); dir !== base && dir.startsWith(base + sep); ) {
		try {
			await rmdir(dir); // only succeeds when empty
		} catch {
			break;
		}
		dir = dirname(dir);
	}
}

function listen(ctx: ServerContext) {
	const { root } = ctx;
	/** Resolve an item directory route, or answer why not. */
	const itemDirectory = async (
		req: Request,
	): Promise<{ rel: string[]; path: string } | Response> => {
		const pathname = new URL(req.url).pathname;
		const rel = parseFilePath(pathname, true);
		const path = resolveFilePath(root, pathname, true);
		if (!rel || !path || (await ctx.concealed(req, pathname)))
			return new Response("Not found", { status: 404 });
		const s = await Bun.file(path)
			.stat()
			.catch(() => null);
		if (!s?.isDirectory()) return new Response("Not found", { status: 404 });
		return { rel, path };
	};
	const requireAdmin = (req: Request): Response | null =>
		ctx.admin.isAdmin(req)
			? null
			: Response.json(
					{ error: "Admin sign-in required." },
					{ status: 401, headers: NO_STORE },
				);
	return Bun.serve({
		hostname: ctx.host,
		port: ctx.port,
		development: false,
		routes: {
			"/": ui,
			"/api/library": async (req) => {
				const lib = await scanLibrary(root);
				return Response.json(
					applyHidden(redactLibrary(lib), ctx.admin.isAdmin(req)),
					{ headers: NO_STORE },
				);
			},
			"/api/item/*": async (req) => {
				const dir = await itemDirectory(req);
				if (dir instanceof Response) return dir;
				const tree = await scanItemTree(root, dir.rel.join("/"));
				return Response.json(tree, { headers: NO_STORE });
			},
			"/api/zip/*": async (req) => {
				const dir = await itemDirectory(req);
				if (dir instanceof Response) return dir;
				const { path } = dir;
				const name = path.split(sep).pop() ?? "item";
				const stream = await zipDirectory(path, {
					override: (p) =>
						p.endsWith(MANIFEST_SUFFIX)
							? redactedManifestBytes(p)
							: Promise.resolve(null),
				});
				log.info(`Zipping '${name}' for download`);
				return new Response(stream, {
					headers: {
						"content-type": "application/zip",
						...NO_STORE,
						"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}.zip`,
					},
				});
			},
			// Admin: sign in / out, hide and delete items.
			"/api/admin": (req) => {
				const status: AdminStatus = {
					enabled: ctx.admin.enabled,
					admin: ctx.admin.isAdmin(req),
				};
				return Response.json(status, { headers: NO_STORE });
			},
			"/api/admin/login": {
				POST: async (req, server) => {
					let body: { password?: unknown };
					try {
						body = (await req.json()) as { password?: unknown };
					} catch {
						return new Response("Bad request", { status: 400 });
					}
					if (typeof body.password !== "string")
						return new Response("Bad request", { status: 400 });
					const address = server.requestIP(req)?.address;
					const result = ctx.admin.login(body.password, address);
					if (!result.ok) {
						if (result.status === 401)
							log.warn(`Admin sign-in failed from ${address ?? "?"}`);
						return Response.json(
							{ error: result.message },
							{ status: result.status, headers: NO_STORE },
						);
					}
					log.info(`Admin signed in from ${address ?? "?"}`);
					return Response.json(
						{ ok: true },
						{
							headers: {
								...NO_STORE,
								"set-cookie": AdminSessions.cookie(result.token),
							},
						},
					);
				},
			},
			"/api/admin/logout": {
				POST: (req) => {
					ctx.admin.logout(req);
					return Response.json(
						{ ok: true },
						{
							headers: {
								...NO_STORE,
								"set-cookie": AdminSessions.clearCookie(),
							},
						},
					);
				},
			},
			"/api/admin/item/*": {
				PATCH: async (req) => {
					const denied = requireAdmin(req);
					if (denied) return denied;
					const dir = await itemDirectory(req);
					if (dir instanceof Response) return dir;
					let body: { hidden?: unknown };
					try {
						body = (await req.json()) as { hidden?: unknown };
					} catch {
						return new Response("Bad request", { status: 400 });
					}
					if (typeof body.hidden !== "boolean")
						return new Response("Bad request", { status: 400 });
					const directory = dir.rel.join("/");
					await ctx.hidden.mark(directory, body.hidden);
					log.info(`Admin ${body.hidden ? "hid" : "unhid"} '${directory}'`);
					return Response.json(
						{ ok: true, hidden: body.hidden },
						{ headers: NO_STORE },
					);
				},
				DELETE: async (req) => {
					const denied = requireAdmin(req);
					if (denied) return denied;
					const dir = await itemDirectory(req);
					if (dir instanceof Response) return dir;
					const directory = dir.rel.join("/");
					await deleteItemDirectory(root, dir.path);
					log.info(`Admin deleted '${directory}'`);
					return Response.json({ ok: true }, { headers: NO_STORE });
				},
			},
			// Admin: extract a zip next to itself; answers when it is done.
			"/api/admin/unzip/*": {
				POST: async (req, server) => {
					const denied = requireAdmin(req);
					if (denied) return denied;
					const pathname = new URL(req.url).pathname;
					const path = resolveFilePath(root, pathname);
					if (!path?.toLowerCase().endsWith(".zip"))
						return new Response("Not found", { status: 404 });
					const s = await Bun.file(path)
						.stat()
						.catch(() => null);
					if (!s?.isFile()) return new Response("Not found", { status: 404 });
					const rel = parseFilePath(pathname)?.join("/") ?? path;
					// A large archive takes longer than the default idle timeout.
					server.timeout(req, 0);
					try {
						const { created } = await extractZip(path);
						log.info(`Admin unzipped '${rel}' to '${created}'`);
						return Response.json({ ok: true, created }, { headers: NO_STORE });
					} catch (err) {
						if (err instanceof UnzipError) {
							log.warn(`Unzipping '${rel}' failed: ${err.message}`);
							return Response.json(
								{ error: err.message },
								{ status: 422, headers: NO_STORE },
							);
						}
						throw err;
					}
				},
			},
			// "Download from itch.io": fetch an item again, server-side, as a job.
			"/api/fetch/current": () =>
				Response.json(ctx.jobs.currentStatus(), { headers: NO_STORE }),
			"/api/fetch/job/:id": {
				GET: (req) => {
					const status = ctx.jobs.get(req.params.id);
					if (!status) return new Response("Not found", { status: 404 });
					return Response.json(status, { headers: NO_STORE });
				},
				DELETE: async (req) => {
					if (!(await ctx.jobs.cancel(req.params.id)))
						return new Response("Not found", { status: 404 });
					return Response.json({ ok: true });
				},
			},
			"/api/fetch/job/:id/download": async (req) => {
				const zip = await ctx.jobs.download(req.params.id);
				if (!zip) return new Response("Not found", { status: 404 });
				return new Response(zip.stream, {
					headers: {
						"content-type": "application/zip",
						...NO_STORE,
						"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(zip.name)}`,
					},
				});
			},
			"/api/fetch/*": {
				POST: async (req) => {
					const dir = await itemDirectory(req);
					if (dir instanceof Response) return dir;
					try {
						const status = await ctx.jobs.start(dir.rel.join("/"));
						return Response.json(status, { status: 201, headers: NO_STORE });
					} catch (err) {
						if (err instanceof JobError)
							return new Response(err.message, { status: err.status });
						throw err;
					}
				},
			},
			"/api/reveal": {
				POST: async (req, server) => {
					// Opens windows on this machine: only for a browser running here.
					if (!isLoopback(server.requestIP(req)?.address))
						return new Response("Forbidden", { status: 403 });
					let body: { path?: unknown };
					try {
						body = (await req.json()) as { path?: unknown };
					} catch {
						return new Response("Bad request", { status: 400 });
					}
					if (typeof body.path !== "string")
						return new Response("Bad request", { status: 400 });
					const path = resolveFilePath(
						root,
						`/files/${body.path.split("/").map(encodeURIComponent).join("/")}`,
						true,
					);
					if (!path) return new Response("Not found", { status: 404 });
					const file = Bun.file(path);
					const s = await file.stat().catch(() => null);
					if (!s) return new Response("Not found", { status: 404 });
					await reveal(path, s.isDirectory());
					return Response.json({ ok: true });
				},
			},
			"/files/*": (req) => serveFile(ctx, req),
		},
		fetch: () => new Response("Not found", { status: 404 }),
	});
}

/** Addresses other devices can reach this machine at (IPv4, non-loopback). */
function lanAddresses(): string[] {
	const out: string[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const e of entries ?? []) {
			if (e.family === "IPv4" && !e.internal) out.push(e.address);
		}
	}
	return out;
}

/**
 * Start the download browser for `config.download_directory` and keep
 * running until Ctrl-C.
 */
export async function serveDownloadBrowser(
	config: Config,
	opts: BrowserOptions = {},
): Promise<void> {
	const root = config.download_directory;
	const host = opts.host ?? DEFAULT_HOST;
	const wanted = opts.port ?? DEFAULT_PORT;
	const jobs = new FetchJobs(config, root);
	const admin = new AdminSessions(config.admin_password);
	const hidden = new HiddenItems(root);
	const ctx: ServerContext = {
		root,
		host,
		port: wanted,
		jobs,
		admin,
		hidden,
		async concealed(req, pathname) {
			if (admin.isAdmin(req)) return false;
			const rel = parseFilePath(pathname, true);
			return rel !== null && (await hidden.covers(rel));
		},
	};
	let server: ReturnType<typeof listen>;
	try {
		server = listen(ctx);
	} catch (err) {
		if (opts.port !== undefined) throw err;
		log.warn(`Port ${wanted} is in use, picking a free one.`);
		server = listen({ ...ctx, port: 0 });
	}

	// The local browser always goes through loopback (so reveal works even
	// when listening on every interface).
	const localHost = host === "0.0.0.0" || host === "::" ? DEFAULT_HOST : host;
	const url = `http://${localHost}:${server.port}/`;
	// Bun bundles index.html once at startup and, when that fails (a bad
	// import in the client), serves empty pages without a word: check now.
	const page = await fetch(url).catch(() => null);
	if (!page?.ok || !(await page.text()).includes("<script")) {
		server.stop(true);
		throw new Error(
			"The download browser's page failed to build (see any bundler errors above); the server was not started.",
		);
	}
	log.info(`Browsing '${root}'`);
	log.info(`Download browser running at ${url} (press Ctrl-C to stop)`);
	if (!isLoopback(host)) {
		const reachable =
			host === "0.0.0.0" || host === "::" ? lanAddresses() : [host];
		for (const addr of reachable)
			log.info(`  also reachable at http://${addr}:${server.port}/`);
		log.info(
			"Anyone who can reach the port can browse and download the library; download keys are never sent.",
		);
	}
	if (admin.enabled) {
		log.info(
			"Admin features are on: click the library icon in the top bar to sign in.",
		);
	} else {
		log.info(
			"Admin features are off: set admin_password in the config file to hide, delete or unzip items.",
		);
	}
	if (opts.open !== false) openInBrowser(url);

	await new Promise<void>((done) => {
		const stop = async () => {
			log.raw();
			log.info("Stopping the download browser.");
			await jobs.shutdown();
			server.stop(true);
			done();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}
