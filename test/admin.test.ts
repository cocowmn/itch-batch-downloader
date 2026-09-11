import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configTemplate,
	generateAdminPassword,
	loadConfig,
} from "../src/features/config/config.ts";
import {
	MARKER_FILE,
	readMarker,
	writeMarker,
} from "../src/features/manifest/marker.ts";
import type { Game } from "../src/models/game.ts";
import type { LibraryItem, LibraryResponse } from "../src/models/library.ts";
import {
	ADMIN_COOKIE,
	AdminSessions,
	cookieValue,
	HiddenItems,
} from "../src/www/server/admin.ts";
import { applyHidden, deleteItemDirectory } from "../src/www/server/server.ts";

const item = (directory: string, hidden = false): LibraryItem => ({
	directory,
	title: directory,
	author: null,
	urls: null,
	itchId: null,
	description: null,
	info: {},
	tags: [],
	bundles: [],
	hasManifest: false,
	fetchable: false,
	cover: null,
	captures: [],
	files: [],
	downloadCount: 0,
	size: 10,
	modified: "",
	hidden,
});

describe("admin config", () => {
	test("the template gets a fresh random password, which loads back", async () => {
		const a = generateAdminPassword();
		const b = generateAdminPassword();
		expect(a).toHaveLength(20);
		expect(a).not.toBe(b);
		expect(configTemplate()).not.toBe(configTemplate());
		expect(configTemplate()).toMatch(/^admin_password = "[a-zA-Z0-9]{20}"$/m);

		const dir = await mkdtemp(join(tmpdir(), "ibd-admin-"));
		try {
			const path = join(dir, "c.toml");
			expect(await loadConfig(path)).toBeNull();
			const cfg = await loadConfig(path);
			expect(cfg?.admin_password).toMatch(/^[a-zA-Z0-9]{20}$/);

			await Bun.write(path, 'admin_password = "  "\n');
			expect((await loadConfig(path))?.admin_password).toBeUndefined();
			await Bun.write(path, "admin_password = 5\n");
			await expect(loadConfig(path)).rejects.toThrow(/must be a string/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("AdminSessions", () => {
	const withCookie = (token: string) =>
		new Request("http://x/", {
			headers: { cookie: `a=b; ${ADMIN_COOKIE}=${token}` },
		});

	test("off without a password", () => {
		const s = new AdminSessions(undefined);
		expect(s.enabled).toBe(false);
		expect(s.login("anything")).toMatchObject({ ok: false, status: 404 });
	});

	test("right password gives a token the cookie proves; logout revokes it", () => {
		const s = new AdminSessions("hunter2");
		expect(s.login("hunter")).toMatchObject({ ok: false, status: 401 });
		const result = s.login("hunter2");
		if (!result.ok) throw new Error("expected a token");
		expect(s.isAdmin(withCookie(result.token))).toBe(true);
		expect(s.isAdmin(withCookie("nope"))).toBe(false);
		expect(s.isAdmin(new Request("http://x/"))).toBe(false);
		expect(AdminSessions.cookie(result.token)).toContain("HttpOnly");
		s.logout(withCookie(result.token));
		expect(s.isAdmin(withCookie(result.token))).toBe(false);
	});

	test("an address is locked out after repeated failures", () => {
		const s = new AdminSessions("pw");
		for (let i = 0; i < 5; i++) expect(s.login("x", "10.0.0.2").ok).toBe(false);
		expect(s.login("pw", "10.0.0.2")).toMatchObject({ ok: false, status: 429 });
		// other addresses are unaffected
		expect(s.login("pw", "10.0.0.3").ok).toBe(true);
	});

	test("cookieValue", () => {
		const req = new Request("http://x/", {
			headers: { cookie: "a=1; b = 2 ;c=x=y" },
		});
		expect(cookieValue(req, "a")).toBe("1");
		expect(cookieValue(req, "b")).toBe("2");
		expect(cookieValue(req, "c")).toBe("x=y");
		expect(cookieValue(req, "d")).toBeNull();
		expect(cookieValue(new Request("http://x/"), "a")).toBeNull();
	});
});

describe("HiddenItems", () => {
	test("flags the item's marker and covers nested paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "ibd-hidden-"));
		try {
			await mkdir(join(root, "a", "b"), { recursive: true });
			await mkdir(join(root, "top"));
			await Bun.write(
				join(root, "a", "b", MARKER_FILE),
				JSON.stringify({ markerVersion: 1, title: "B", slug: "b" }),
			);
			const hidden = new HiddenItems(root);
			expect(await hidden.has("a/b")).toBe(false);
			await hidden.mark("a/b", true);
			await hidden.mark("top", true);
			expect(await hidden.covers(["a", "b", "file.png"])).toBe(true);
			expect(await hidden.covers(["a", "b"])).toBe(true);
			expect(await hidden.covers(["a"])).toBe(false);
			expect(await hidden.covers(["a", "c", "x"])).toBe(false);
			expect(await hidden.covers(["top"])).toBe(true);
			expect(await hidden.covers(["gone"])).toBe(false);

			// The flag joins the existing marker fields
			expect(await Bun.file(join(root, "a", "b", MARKER_FILE)).json()).toEqual({
				markerVersion: 1,
				title: "B",
				slug: "b",
				hidden: true,
			});
			expect(await readMarker(join(root, "a", "b"))).toMatchObject({
				hidden: true,
			});
			// A legacy item gets a marker holding only the flag...
			expect(await Bun.file(join(root, "top", MARKER_FILE)).json()).toEqual({
				hidden: true,
			});
			expect(await readMarker(join(root, "top"))).toBeNull();

			const again = new HiddenItems(root);
			expect(await again.has("a/b")).toBe(true);
			await again.mark("a/b", false);
			await again.mark("top", false);
			expect(await Bun.file(join(root, "a", "b", MARKER_FILE)).json()).toEqual({
				markerVersion: 1,
				title: "B",
				slug: "b",
			});
			// ...which goes away again when it is unhidden
			expect(await Bun.file(join(root, "top", MARKER_FILE)).exists()).toBe(
				false,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a re-download keeps the hidden flag", async () => {
		const root = await mkdtemp(join(tmpdir(), "ibd-hidden-"));
		try {
			const game = {
				title: "Thing",
				itchSlug: "thing",
				author: "maker",
				authorName: "Maker",
				gameUrl: "https://maker.itch.io/thing",
			} as Game;
			await mkdir(join(root, "thing"));
			await writeMarker(join(root, "thing"), game, "{title}");
			const hidden = new HiddenItems(root);
			await hidden.mark("thing", true);
			await writeMarker(join(root, "thing"), game, "{title}");
			expect(await hidden.has("thing")).toBe(true);
			expect(await readMarker(join(root, "thing"))).toMatchObject({
				title: "Thing",
				hidden: true,
			});
			await hidden.mark("thing", false);
			await writeMarker(join(root, "thing"), game, "{title}");
			expect(await readMarker(join(root, "thing"))).not.toHaveProperty(
				"hidden",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("applyHidden keeps flagged items for admins and drops them for everyone else", () => {
		const lib: LibraryResponse = {
			root: "/x",
			scannedAt: "",
			platform: "test",
			totals: { items: 2, size: 20, withManifest: 0, withCover: 0 },
			items: [item("a"), item("b", true)],
		};
		const everyone = applyHidden(lib, false);
		expect(everyone.items.map((i) => i.directory)).toEqual(["a"]);
		expect(everyone.totals).toMatchObject({ items: 1, size: 10 });
		const admin = applyHidden(lib, true);
		expect(admin.items.map((i) => [i.directory, i.hidden])).toEqual([
			["a", false],
			["b", true],
		]);
		expect(admin.totals.items).toBe(2);
	});
});

describe("deleteItemDirectory", () => {
	test("removes the item and the empty directories a nested layout leaves", async () => {
		const root = await mkdtemp(join(tmpdir(), "ibd-del-"));
		try {
			await mkdir(join(root, "author", "one"), { recursive: true });
			await mkdir(join(root, "author", "two"), { recursive: true });
			await Bun.write(join(root, "author", "one", "f.txt"), "x");
			await Bun.write(join(root, "author", "two", "f.txt"), "y");
			await deleteItemDirectory(root, join(root, "author", "one"));
			expect(
				await Bun.file(join(root, "author", "two", "f.txt")).exists(),
			).toBe(true);
			await deleteItemDirectory(root, join(root, "author", "two"));
			// "author" is now empty and gone; the root itself stays
			expect(await Bun.file(join(root, "author")).exists()).toBe(false);
			expect((await Bun.file(root).stat()).isDirectory()).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
