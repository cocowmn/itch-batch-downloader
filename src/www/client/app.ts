// Download browser front end: grid / list / gallery views over the JSON the
// server derives from the download directory, with a fuzzy filter box.

import noArtwork from "../../assets/no-artwork.svg" with { type: "text" };
import type { JobStatus } from "../../models/jobs.ts";
import type {
	ItemResponse,
	LibraryCapture,
	LibraryFile,
	LibraryItem,
	LibraryResponse,
} from "../../models/library.ts";
import { AdminError, adminApi, openAdminDialog } from "./admin.ts";
import { confirmDialog } from "./dialog.ts";
import { byId, formatBytes, formatDate, formatDay, h } from "./dom.ts";
import { matchQuery, type SearchField } from "./fuzzy.ts";
import { busyIcon, fileIcon, hydrateIcons, icon, iconSvg } from "./icons.ts";
import { type MenuItem, toggleMenu } from "./menu.ts";
import { extension, viewerMode } from "./text.ts";
import { openViewer, type ViewerContext } from "./viewer.ts";

type View = "grid" | "list" | "gallery";
type SortKey = "title" | "author" | "modified" | "size";

interface State {
	library: LibraryResponse | null;
	query: string;
	view: View;
	sort: SortKey;
	/** 1 ascending, -1 descending. */
	dir: 1 | -1;
	selected: string | null;
	/** Filter matches case; off by default. */
	caseSensitive: boolean;
	/** Gallery view on narrow screens: the inspector only opens on request. */
	detailsOpen: boolean;
	/** The server has an admin_password configured. */
	adminEnabled: boolean;
	/** This session has signed in as admin. */
	admin: boolean;
	/** Admin: list the hidden items too. */
	showHidden: boolean;
}

const VIEWS: View[] = ["grid", "list", "gallery"];
const SORTS: SortKey[] = ["title", "author", "modified", "size"];
const DEFAULT_DIR: Record<SortKey, 1 | -1> = {
	title: 1,
	author: 1,
	modified: -1,
	size: -1,
};

const state: State = {
	library: null,
	query: "",
	view: "grid",
	sort: "title",
	dir: 1,
	selected: null,
	caseSensitive: false,
	detailsOpen: false,
	adminEnabled: false,
	admin: false,
	showHidden: false,
};

const searchIndex = new Map<string, SearchField[]>();
let visible: LibraryItem[] = [];

/**
 * Whether the browser runs on the machine that serves the files. Only then
 * can "Reveal in Finder" do anything (the server refuses it otherwise).
 */
const isLocal = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
	location.hostname,
);

function authorLabel(item: LibraryItem): string {
	return item.author?.name || item.author?.slug || "";
}

/** A directory or file path as URL path segments. */
function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

// ---------------------------------------------------------------------------
// Data

function buildSearchIndex(items: LibraryItem[]): void {
	searchIndex.clear();
	for (const item of items) {
		const fields: SearchField[] = [
			{ text: item.title, weight: 1 },
			{ text: item.directory, weight: 0.85 },
			{ text: item.author?.name ?? "", weight: 0.9 },
			{ text: item.author?.slug ?? "", weight: 0.9 },
			{ text: item.description ?? "", weight: 0.35 },
			{ text: item.info.Genre ?? "", weight: 0.5 },
			{ text: item.info.Category ?? "", weight: 0.5 },
			...item.tags.map((t) => ({ text: t, weight: 0.7 })),
			...item.bundles.map((b) => ({ text: b.name, weight: 0.5 })),
			...item.files
				.filter((f) => f.role === "download" || f.role === "video")
				.map((f) => ({ text: f.name, weight: 0.6 })),
		];
		searchIndex.set(item.directory, fields);
	}
}

function compare(a: LibraryItem, b: LibraryItem): number {
	switch (state.sort) {
		case "author":
			return (
				(authorLabel(a) || "￿").localeCompare(authorLabel(b) || "￿") ||
				a.title.localeCompare(b.title)
			);
		case "modified":
			return a.modified.localeCompare(b.modified);
		case "size":
			return a.size - b.size;
		default:
			return a.title.localeCompare(b.title);
	}
}

/** The items in scope: hidden ones only for an admin who asked for them. */
function scopedItems(): LibraryItem[] {
	const items = state.library?.items ?? [];
	return state.admin && state.showHidden
		? items
		: items.filter((i) => !i.hidden);
}

function computeVisible(): LibraryItem[] {
	const items = scopedItems();
	const query = state.query.trim();
	if (!query) return [...items].sort((a, b) => compare(a, b) * state.dir);
	const scored: { item: LibraryItem; score: number }[] = [];
	for (const item of items) {
		const score = matchQuery(query, searchIndex.get(item.directory) ?? [], {
			caseSensitive: state.caseSensitive,
		});
		if (score > 0) scored.push({ item, score });
	}
	scored.sort(
		(a, b) => b.score - a.score || compare(a.item, b.item) * state.dir,
	);
	return scored.map((s) => s.item);
}

function selectedItem(): LibraryItem | null {
	if (!state.selected) return null;
	return (
		state.library?.items.find((i) => i.directory === state.selected) ?? null
	);
}

async function loadLibrary(): Promise<void> {
	const button = byId<HTMLButtonElement>("refresh");
	button.classList.add("spinning");
	try {
		const res = await fetch("/api/library");
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		state.library = (await res.json()) as LibraryResponse;
		buildSearchIndex(state.library.items);
		if (
			state.selected &&
			!state.library.items.some((i) => i.directory === state.selected)
		) {
			state.selected = null;
		}
		renderAll();
	} catch (err) {
		toast(`Could not load the library: ${String(err)}`);
	} finally {
		button.classList.remove("spinning");
	}
}

// ---------------------------------------------------------------------------
// Persistence (view + sort in localStorage, selection in the URL hash)

function restorePreferences(): void {
	try {
		const view = localStorage.getItem("view") as View | null;
		if (view && VIEWS.includes(view)) state.view = view;
		state.caseSensitive = localStorage.getItem("matchCase") === "1";
		state.showHidden = localStorage.getItem("showHidden") === "1";
		const sort = localStorage.getItem("sort") as SortKey | null;
		if (sort && SORTS.includes(sort)) {
			state.sort = sort;
			state.dir = localStorage.getItem("dir") === "-1" ? -1 : 1;
		} else {
			state.dir = DEFAULT_DIR[state.sort];
		}
	} catch {
		// storage unavailable; defaults are fine
	}
	const hash = decodeURIComponent(location.hash.slice(1));
	if (hash) state.selected = hash;
}

function savePreferences(): void {
	try {
		localStorage.setItem("view", state.view);
		localStorage.setItem("sort", state.sort);
		localStorage.setItem("dir", String(state.dir));
		localStorage.setItem("matchCase", state.caseSensitive ? "1" : "0");
		localStorage.setItem("showHidden", state.showHidden ? "1" : "0");
	} catch {
		// ignore
	}
}

function syncHash(): void {
	const wanted = state.selected ? `#${encodeURIComponent(state.selected)}` : "";
	if (location.hash !== wanted) {
		history.replaceState(null, "", `${location.pathname}${wanted}`);
	}
}

// ---------------------------------------------------------------------------
// Rendering

const workspace = byId<HTMLElement>("workspace");
const results = byId<HTMLElement>("results");
const inspector = byId<HTMLElement>("inspector");
const narrowScreen = matchMedia("(max-width: 900px)");
/** Top bar is tight: the search box gets a shorter placeholder. */
const tightTopbar = matchMedia("(max-width: 1100px)");
/** Directory the inspector currently shows, to skip needless rebuilds. */
let inspectorFor: string | null = null;
const searchInput = byId<HTMLInputElement>("search");
const LONG_PLACEHOLDER = searchInput.placeholder;
const SHORT_PLACEHOLDER = "Filter…";
const sortSelect = byId<HTMLSelectElement>("sort");

function renderAll(): void {
	visible = computeVisible();
	if (
		state.view === "gallery" &&
		!visible.some((i) => i.directory === state.selected)
	) {
		state.selected = visible[0]?.directory ?? null;
	}
	renderStats();
	renderResults();
	renderInspector(true);
	syncHash();
}

function renderStats(): void {
	const lib = state.library;
	const stats = byId<HTMLElement>("stats");
	if (!lib) {
		stats.textContent = "";
		return;
	}
	const scoped = scopedItems();
	const size = scoped.reduce((acc, i) => acc + i.size, 0);
	const total = `${scoped.length} items · ${formatBytes(size)}`;
	const hidden = lib.items.length - scoped.length;
	stats.textContent =
		(state.query.trim() ? `${visible.length} of ${total}` : total) +
		(hidden ? ` · ${hidden} hidden` : "");
}

function renderResults(): void {
	results.replaceChildren();
	results.className = `results-inner view-${state.view} hidden-scrollbar`;
	if (!state.library) return;
	if (visible.length === 0) {
		results.append(renderEmpty());
		return;
	}
	switch (state.view) {
		case "list":
			results.append(renderList());
			break;
		case "gallery":
			results.append(renderGallery());
			break;
		default:
			results.append(renderGrid());
	}
}

function renderEmpty(): HTMLElement {
	const lib = state.library;
	if (lib && lib.items.length === 0) {
		return h(
			"div",
			{ class: "empty" },
			icon("image-off"),
			h("strong", {}, "Nothing downloaded yet"),
			h("span", {}, "Items will show up here after a download run into"),
			h("code", {}, lib.root),
		);
	}
	return h(
		"div",
		{ class: "empty" },
		icon("search"),
		h("strong", {}, "No items match"),
		h("span", {}, `Nothing in the library matches "${state.query.trim()}".`),
	);
}

function coverElement(item: LibraryItem, lazy = true): HTMLElement {
	const cover = h("div", { class: "cover" });
	if (item.cover) {
		cover.append(
			h("img", {
				src: item.cover,
				alt: "",
				loading: lazy ? "lazy" : "eager",
				decoding: "async",
			}),
		);
	} else {
		cover.innerHTML = noArtwork;
	}
	return cover;
}

/**
 * Select an item. `openDetails` is what a tap on a card or row means; the
 * gallery's filmstrip and arrows pass false so browsing on a phone does not
 * pop the inspector over the stage every time.
 */
function select(directory: string | null, openDetails = true): void {
	if (openDetails) state.detailsOpen = directory !== null;
	if (state.selected !== directory) {
		state.selected = directory;
		for (const el of results.querySelectorAll<HTMLElement>(
			"[data-directory]",
		)) {
			el.setAttribute(
				"aria-selected",
				String(el.dataset.directory === directory),
			);
		}
		if (state.view === "gallery") renderStage();
	}
	renderInspector();
	syncHash();
}

/** Close the inspector; outside the gallery that also drops the selection. */
function closeDetails(): void {
	state.detailsOpen = false;
	if (state.view === "gallery") renderInspector();
	else select(null);
}

/** Whether the inspector should be on screen for the current selection. */
function inspectorWanted(): boolean {
	if (!state.selected) return false;
	if (state.view !== "gallery") return true;
	return state.detailsOpen || !narrowScreen.matches;
}

function moveSelection(delta: number): void {
	if (visible.length === 0) return;
	const index = visible.findIndex((i) => i.directory === state.selected);
	const next =
		index === -1 ? 0 : (index + delta + visible.length) % visible.length;
	const item = visible[next];
	if (!item) return;
	select(item.directory, false);
	results
		.querySelector(`[data-directory="${CSS.escape(item.directory)}"]`)
		?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// Grid --------------------------------------------------------------------

function renderGrid(): HTMLElement {
	const grid = h("div", { class: "grid" });
	for (const item of visible) {
		const card = h(
			"button",
			{
				type: "button",
				class: `card${item.hidden ? " is-hidden" : ""}`,
				"data-directory": item.directory,
				"aria-selected": String(item.directory === state.selected),
				onclick: () => select(item.directory),
			},
			coverElement(item),
			h(
				"div",
				{ class: "card-body" },
				h("div", { class: "card-title" }, item.title),
				h("div", { class: "card-author" }, authorLabel(item) || " "),
				h(
					"div",
					{ class: "card-meta" },
					h(
						"span",
						{},
						`${item.downloadCount} file${item.downloadCount === 1 ? "" : "s"}`,
					),
					h("span", {}, formatBytes(item.size)),
				),
			),
		);
		if (item.hidden) {
			card
				.querySelector(".cover")
				?.append(h("span", { class: "badge" }, icon("eye-off"), "hidden"));
		} else if (!item.hasManifest) {
			card
				.querySelector(".cover")
				?.append(h("span", { class: "badge" }, "no manifest"));
		}
		grid.append(card);
	}
	return grid;
}

// List --------------------------------------------------------------------

const COLUMNS: { key: SortKey | null; label: string; class?: string }[] = [
	{ key: null, label: "", class: "thumb" },
	{ key: "title", label: "Title" },
	{ key: "author", label: "Author" },
	{ key: null, label: "Tags", class: "tags" },
	{ key: null, label: "Files", class: "num" },
	{ key: "size", label: "Size", class: "num" },
	{ key: "modified", label: "Modified", class: "num" },
];

function renderList(): HTMLElement {
	const head = h("tr", {});
	for (const col of COLUMNS) {
		const th = h("th", { class: col.class ?? "" }, col.label);
		if (col.key) {
			const key = col.key;
			if (state.sort === key) {
				th.setAttribute(
					"aria-sort",
					state.dir === 1 ? "ascending" : "descending",
				);
				th.innerHTML += iconSvg(
					state.dir === 1 ? "chevron-up" : "chevron-down",
				);
			}
			th.addEventListener("click", () =>
				setSort(
					key,
					state.sort === key ? (state.dir === 1 ? -1 : 1) : DEFAULT_DIR[key],
				),
			);
		}
		head.append(th);
	}

	const body = h("tbody", {});
	for (const item of visible) {
		const thumb = coverElement(item);
		body.append(
			h(
				"tr",
				{
					class: item.hidden ? "is-hidden" : "",
					"data-directory": item.directory,
					"aria-selected": String(item.directory === state.selected),
					onclick: () => select(item.directory),
				},
				h("td", { class: "thumb" }, thumb),
				h(
					"td",
					{},
					h(
						"div",
						{ class: "name" },
						item.hidden ? icon("eye-off") : null,
						item.title,
					),
					h("div", { class: "sub" }, item.directory),
				),
				h("td", {}, authorLabel(item)),
				h(
					"td",
					{ class: "tags", title: item.tags.join(", ") },
					item.tags.join(" · "),
				),
				h("td", { class: "num" }, String(item.downloadCount)),
				h("td", { class: "num" }, formatBytes(item.size)),
				h("td", { class: "num" }, formatDate(item.modified)),
			),
		);
	}
	return h("table", { class: "table" }, h("thead", {}, head), body);
}

function setSort(key: SortKey, dir: 1 | -1): void {
	state.sort = key;
	state.dir = dir;
	sortSelect.value = key;
	savePreferences();
	renderAll();
}

// Gallery -----------------------------------------------------------------

function renderGallery(): HTMLElement {
	const stage = h("div", { class: "stage", id: "stage" });
	const strip = h("div", { class: "filmstrip hidden-scrollbar" });
	for (const item of visible) {
		strip.append(
			h(
				"button",
				{
					type: "button",
					class: item.hidden ? "is-hidden" : "",
					"data-directory": item.directory,
					"aria-selected": String(item.directory === state.selected),
					title: item.hidden ? `${item.title} (hidden)` : item.title,
					onclick: () => select(item.directory, false),
				},
				coverElement(item),
			),
		);
	}
	const gallery = h("div", { class: "gallery" }, stage, strip);
	queueMicrotask(() => {
		renderStage();
		strip
			.querySelector('[aria-selected="true"]')
			?.scrollIntoView({ inline: "center", block: "nearest" });
	});
	return gallery;
}

function renderStage(): void {
	const stage = document.getElementById("stage");
	if (!stage) return;
	const item = selectedItem();
	stage.replaceChildren();
	if (!item) return;
	const index = visible.findIndex((i) => i.directory === item.directory);
	if (item.cover) {
		stage.append(
			h("div", {
				class: "stage-backdrop",
				style: `background-image:url("${item.cover}")`,
			}),
		);
	}
	stage.append(
		h(
			"div",
			{ class: "stage-image" },
			coverElement(item, false),
			h(
				"div",
				{ class: "stage-caption" },
				h("strong", {}, item.title),
				h("span", {}, authorLabel(item)),
			),
		),
		h(
			"button",
			{
				type: "button",
				class: "stage-nav prev",
				title: "Previous (←)",
				onclick: () => moveSelection(-1),
			},
			icon("chevron-left"),
		),
		h(
			"button",
			{
				type: "button",
				class: "stage-nav next",
				title: "Next (→)",
				onclick: () => moveSelection(1),
			},
			icon("chevron-right"),
		),
		h("span", { class: "stage-counter" }, `${index + 1} / ${visible.length}`),
		h(
			"button",
			{
				type: "button",
				class: "stage-details",
				onclick: () => {
					state.detailsOpen = true;
					renderInspector();
				},
			},
			icon("info"),
			"Details",
		),
	);
	results
		.querySelector(
			`.filmstrip [data-directory="${CSS.escape(item.directory)}"]`,
		)
		?.scrollIntoView({
			inline: "center",
			block: "nearest",
			behavior: "smooth",
		});
}

// Inspector ---------------------------------------------------------------

const ROLE_LABEL: Record<LibraryFile["role"], string> = {
	download: "",
	cover: "cover artwork",
	screenshot: "page capture",
	pdf: "page capture",
	video: "embedded video",
	manifest: "manifest",
	old: "previous version",
	incomplete: "incomplete download",
};

function fileManagerName(): string {
	switch (state.library?.platform) {
		case "darwin":
			return "Finder";
		case "win32":
			return "Explorer";
		default:
			return "file manager";
	}
}

async function reveal(path: string): Promise<void> {
	try {
		const res = await fetch("/api/reveal", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path }),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		toast(`Could not open ${fileManagerName()}: ${String(err)}`);
	}
}

function renderInspector(force = false): void {
	const item = selectedItem();
	const show = item !== null && inspectorWanted();
	// The panel keeps its content while sliding out; it is rebuilt on the next open.
	inspector.classList.toggle("open", show);
	inspector.setAttribute("aria-hidden", String(!show));
	workspace.classList.toggle("has-inspector", show);
	if (!item || !show) return;
	if (!force && inspectorFor === item.directory) return;
	inspectorFor = item.directory;
	const inner = h("div", { class: "inspector-inner" });

	inner.append(
		h(
			"div",
			{ class: "inspector-head" },
			h("h2", {}, item.title),
			h(
				"button",
				{
					type: "button",
					class: "close",
					title: "Close (Esc)",
					onclick: () => closeDetails(),
				},
				icon("x"),
			),
		),
		coverElement(item, false),
	);

	if (item.author) {
		inner.append(
			h(
				"div",
				{ class: "byline" },
				icon("user"),
				h(
					"a",
					{ href: item.author.url, target: "_blank", rel: "noreferrer" },
					authorLabel(item),
				),
				item.info.Category ? h("span", {}, `· ${item.info.Category}`) : null,
			),
		);
	}
	if (item.description)
		inner.append(h("p", { class: "description" }, item.description));

	inner.append(
		h(
			"div",
			{ class: "actions" },
			item.urls
				? h(
						"a",
						{
							class: "button primary",
							href: item.urls.page,
							target: "_blank",
							rel: "noreferrer",
						},
						icon("external-link"),
						"Open on itch.io",
					)
				: null,
			downloadButton(item),
			state.admin && topLevelZips(item).length
				? unzipAllButton(item, topLevelZips(item))
				: null,
			isLocal
				? h(
						"button",
						{
							type: "button",
							class: "button",
							onclick: () => reveal(item.directory),
						},
						icon("folder-open"),
						`Reveal in ${fileManagerName()}`,
					)
				: null,
			state.admin
				? h(
						"button",
						{
							type: "button",
							class: "button",
							title: item.hidden
								? "Show this item to everyone again"
								: "Hide this item from everyone but admins",
							onclick: () => setHidden(item, !item.hidden),
						},
						icon(item.hidden ? "eye" : "eye-off"),
						item.hidden ? "Unhide item" : "Hide item",
					)
				: null,
		),
	);
	if (item.hidden) {
		inner.append(
			h(
				"div",
				{ class: "notice" },
				icon("eye-off"),
				h(
					"span",
					{},
					"Hidden: only signed-in admins see this item and can open its files.",
				),
			),
		);
	}

	if (!item.hasManifest) {
		inner.append(
			h(
				"div",
				{ class: "notice" },
				icon("info"),
				h(
					"span",
					{},
					"No manifest for this item, so only the folder contents are known. Run the downloader with ",
					h("code", {}, "download_manifest = true"),
					" to add title, author, tags and links.",
				),
			),
		);
	}

	if (item.tags.length) {
		inner.append(
			section(
				"Tags",
				h(
					"div",
					{ class: "chips" },
					...item.tags.map((t) =>
						h(
							"button",
							{
								type: "button",
								class: "chip",
								title: `Filter by "${t}"`,
								onclick: () => setQuery(t),
							},
							icon("tag"),
							t,
						),
					),
				),
			),
		);
	}

	const details: [string, string][] = [];
	for (const key of [
		"Status",
		"Genre",
		"Published",
		"Updated",
		"Rating",
		"Content",
	]) {
		const value = item.info[key];
		if (value) details.push([key, value.replace(/stars\(/, "stars (")]);
	}
	details.push(["Size", formatBytes(item.size)]);
	details.push(["Files", String(item.downloadCount)]);
	details.push(["Folder", item.directory]);
	if (item.itchId !== null) details.push(["itch.io id", String(item.itchId)]);
	const dl = h("dl", { class: "kv" });
	for (const [k, v] of details) dl.append(h("dt", {}, k), h("dd", {}, v));
	inner.append(section("Details", dl));

	if (item.bundles.length) {
		inner.append(
			section(
				"Bundles",
				h(
					"div",
					{ class: "chips" },
					...item.bundles.map((b) =>
						h(
							"button",
							{
								type: "button",
								class: "chip",
								title: `Filter by "${b.name}"`,
								onclick: () => setQuery(b.name),
							},
							icon("layers"),
							b.name,
						),
					),
				),
			),
		);
	}

	if (item.captures.length)
		inner.append(section("Captures", renderCaptures(item)));

	inner.append(renderFilesSection(item));
	if (state.admin) {
		inner.append(
			h(
				"div",
				{ class: "danger-zone" },
				h(
					"button",
					{
						type: "button",
						class: "button stretch danger",
						onclick: () => deleteItem(item),
					},
					icon("trash-2"),
					"Delete item",
				),
				h(
					"span",
					{},
					"Removes the folder and everything in it from the library on disk.",
				),
			),
		);
	}
	inspector.replaceChildren(inner);
	inspector.scrollTop = 0;
}

// Admin -------------------------------------------------------------------

const showHiddenButton = byId<HTMLButtonElement>("show-hidden");

/** Show or hide the admin controls for the current sign-in state. */
function renderAdmin(): void {
	showHiddenButton.hidden = !state.admin;
	showHiddenButton.setAttribute("aria-pressed", String(state.showHidden));
	showHiddenButton.title = state.showHidden
		? "Hide hidden items"
		: "Show hidden items";
	showHiddenButton.replaceChildren(icon(state.showHidden ? "eye" : "eye-off"));
}

/** Ask the server whether this session is (still) signed in. */
async function checkAdmin(): Promise<void> {
	try {
		const status = await adminApi.status();
		state.adminEnabled = status.enabled;
		state.admin = status.admin;
	} catch {
		// unreachable server; the library load reports that
	}
	renderAdmin();
}

function setAdmin(admin: boolean): void {
	state.admin = admin;
	renderAdmin();
	// The library differs for admins (hidden items), so fetch it again.
	loadLibrary();
}

/** An admin call came back 401: the server forgot the session (restart). */
function adminFailed(err: unknown, what: string): void {
	if (err instanceof AdminError && err.status === 401) {
		toast("The admin session has ended; sign in again.");
		setAdmin(false);
		return;
	}
	toast(`${what}: ${err instanceof Error ? err.message : String(err)}`);
}

async function setHidden(item: LibraryItem, hidden: boolean): Promise<void> {
	try {
		await adminApi.setHidden(item.directory, hidden);
	} catch (err) {
		adminFailed(
			err,
			hidden ? "Could not hide the item" : "Could not unhide the item",
		);
		return;
	}
	item.hidden = hidden;
	toast(
		hidden
			? state.showHidden
				? `${item.title} is now hidden.`
				: `${item.title} is now hidden; the eye button in the top bar shows hidden items.`
			: `${item.title} is visible again.`,
	);
	renderAll();
}

async function deleteItem(item: LibraryItem): Promise<void> {
	const ok = await confirmDialog({
		title: `Delete ${item.title}?`,
		icon: icon("triangle-alert"),
		message: [
			"This removes the folder ",
			h("code", {}, item.directory),
			` (${formatBytes(item.size)}) and everything in it from disk. It cannot be undone.`,
		],
		confirmLabel: "Delete item",
		danger: true,
	});
	if (!ok) return;
	try {
		await adminApi.deleteItem(item.directory);
	} catch (err) {
		adminFailed(err, "Could not delete the item");
		return;
	}
	const lib = state.library;
	if (lib) lib.items = lib.items.filter((i) => i.directory !== item.directory);
	treeCache.delete(item.directory);
	if (state.selected === item.directory) {
		state.selected = null;
		state.detailsOpen = false;
	}
	toast(`Deleted ${item.title}.`);
	renderAll();
}

// Captures ----------------------------------------------------------------

/** Chip for one capture file: PNG opens the viewer, PDF opens a new tab. */
function captureChip(
	item: LibraryItem,
	capture: LibraryCapture,
	which: "png" | "pdf",
	withDate: boolean,
): HTMLElement | null {
	const file = capture[which];
	if (!file?.url) return null;
	const label = [
		which.toUpperCase(),
		formatBytes(file.size),
		withDate ? formatDay(capture.date) : "",
	]
		.filter(Boolean)
		.join(" · ");
	const kids = [icon(which === "png" ? "camera" : "file-text"), label];
	if (which === "png") {
		return h(
			"button",
			{
				type: "button",
				class: "capture-chip",
				title: `View ${file.name}`,
				onclick: () => openCapture(item, file),
			},
			...kids,
		);
	}
	return h(
		"a",
		{
			class: "capture-chip",
			href: file.url,
			target: "_blank",
			rel: "noreferrer",
			title: `Open ${file.name}`,
		},
		...kids,
	);
}

/** View a PNG capture; ←/→ walk the item's other PNG captures. */
function openCapture(item: LibraryItem, file: LibraryFile): void {
	const pngs = item.captures.flatMap((c) => (c.png ? [c.png] : []));
	openViewer(pngs, Math.max(0, pngs.indexOf(file)), viewerContext(item));
}

/**
 * The newest capture as a top-cropped strip with its PNG/PDF chips (a PDF
 * has no preview: on its own it gets a compact row), earlier dates folded
 * away below.
 */
function renderCaptures(item: LibraryItem): HTMLElement {
	const [newest, ...earlier] = item.captures;
	const wrap = h("div", { class: "captures" });
	if (!newest) return wrap;

	if (newest.png?.url) {
		const png = newest.png;
		const src = newest.png.url;
		wrap.append(
			h(
				"div",
				{ class: "capture-strip" },
				h(
					"button",
					{
						type: "button",
						class: "capture-preview",
						title: `View ${png.name}`,
						onclick: () => openCapture(item, png),
					},
					h("img", { src, alt: "", loading: "lazy" }),
				),
				h(
					"div",
					{ class: "capture-bar" },
					captureChip(item, newest, "png", true),
					captureChip(item, newest, "pdf", false),
				),
			),
		);
	} else if (newest.pdf?.url) {
		const pdf = newest.pdf;
		wrap.append(
			h(
				"a",
				{
					class: "capture-row",
					href: newest.pdf.url,
					target: "_blank",
					rel: "noreferrer",
					title: `Open ${pdf.name}`,
				},
				icon("file-text"),
				h(
					"span",
					{ class: "file-name" },
					"Page as PDF",
					h("small", {}, formatDay(newest.date)),
				),
				h("span", { class: "file-size" }, formatBytes(pdf.size)),
				h("span", { class: "file-action" }, icon("external-link")),
			),
		);
	}

	if (earlier.length) {
		const chips = h("div", { class: "chips" });
		for (const capture of earlier) {
			chips.append(
				captureChip(item, capture, "png", true) ?? "",
				captureChip(item, capture, "pdf", true) ?? "",
			);
		}
		wrap.append(
			h(
				"details",
				{ class: "captures-earlier" },
				h(
					"summary",
					{},
					icon("chevron-right"),
					`${earlier.length} earlier capture${earlier.length === 1 ? "" : "s"}`,
				),
				chips,
			),
		);
	}
	return wrap;
}

const FETCH_TITLE =
	"Fetch a fresh copy from itch.io with the downloader's settings and get it as a zip";

/**
 * The two ways to download an item: "Download folder" (the directory
 * streamed as a zip) and "Download from itch.io" (only with a fetchable
 * manifest). Both possible: one icon button with a chevron that opens a menu
 * of the two. Otherwise the folder download as an icon button.
 */
function downloadButton(item: LibraryItem): HTMLElement {
	const folderItem: MenuItem = {
		label: "Download folder",
		icon: "folder-down",
		detail: formatBytes(item.size),
		title: "Download the whole folder as a zip",
		href: `/api/zip/${encodePath(item.directory)}`,
		download: `${item.directory.split("/").pop()}.zip`,
	};
	if (item.fetchable) {
		const button = h(
			"button",
			{
				type: "button",
				class: "button icon-only has-menu",
				title: "Download…",
				"aria-label": "Download",
				"aria-haspopup": "menu",
				onclick: () =>
					toggleMenu(button, () => [
						folderItem,
						{
							label: "Download from itch.io",
							icon: "cloud-download",
							title: FETCH_TITLE,
							onSelect: () => startJob(item),
						},
					]),
			},
			icon("folder-down"),
			icon("chevron-down"),
		);
		return button;
	}
	return h(
		"a",
		{
			class: "button icon-only",
			href: folderItem.href,
			download: folderItem.download,
			title: `Download the whole folder as a zip (${formatBytes(item.size)})`,
			"aria-label": "Download folder",
		},
		icon("folder-down"),
	);
}

// Unzipping (admin) --------------------------------------------------------

function isZip(file: LibraryFile): boolean {
	return file.kind !== "folder" && extension(file.name) === "zip";
}

/** The zip archives directly inside the item directory. */
function topLevelZips(item: LibraryItem): LibraryFile[] {
	return item.files.filter(isZip);
}

function unzipKey(item: LibraryItem, file: LibraryFile): string {
	return `${item.directory}/${file.path}`;
}

/** Archives being extracted (`unzipKey`); their buttons show a spinner. */
const unzipping = new Set<string>();

/** Bring the unzip buttons of the open inspector in line with `unzipping`. */
function syncUnzipBusy(item: LibraryItem): void {
	if (inspectorFor !== item.directory) return;
	const anyTopLevel = topLevelZips(item).some((f) =>
		unzipping.has(unzipKey(item, f)),
	);
	for (const el of inspector.querySelectorAll<HTMLElement>(
		"[data-unzip], [data-unzip-all]",
	)) {
		const key = el.dataset.unzip;
		const busy = key !== undefined ? unzipping.has(key) : anyTopLevel;
		el.classList.toggle("busy", busy);
		if (el instanceof HTMLButtonElement) el.disabled = busy;
	}
}

/**
 * Extract `files` (zips of `item`) one after the other, next to themselves,
 * then rescan. Resolves with what was created; failures are toasted.
 */
async function unzipFiles(
	item: LibraryItem,
	files: LibraryFile[],
): Promise<string[]> {
	const todo = files.filter((f) => !unzipping.has(unzipKey(item, f)));
	if (todo.length === 0) return [];
	for (const f of todo) unzipping.add(unzipKey(item, f));
	syncUnzipBusy(item);
	const created: string[] = [];
	try {
		for (const file of todo) {
			try {
				created.push((await adminApi.unzip(item.directory, file.path)).created);
			} catch (err) {
				adminFailed(err, `Could not unzip ${file.name}`);
				if (!state.admin) break;
			}
		}
	} finally {
		for (const f of todo) unzipping.delete(unzipKey(item, f));
	}
	if (created.length) {
		toast(
			todo.length === 1
				? `Extracted ${todo[0]?.name} to ${created[0]}.`
				: `Extracted ${created.length} of ${todo.length} archives.`,
		);
	}
	// The folder changed: rescan, keeping the inspector where it was.
	treeCache.delete(item.directory);
	const scrollTop = inspector.scrollTop;
	await loadLibrary();
	if (inspectorFor === item.directory) inspector.scrollTop = scrollTop;
	return created;
}

/** "Unzip all": every zip at the top level of the item directory. */
function unzipAllButton(item: LibraryItem, zips: LibraryFile[]): HTMLElement {
	const busy = zips.some((f) => unzipping.has(unzipKey(item, f)));
	return h(
		"button",
		{
			type: "button",
			class: `button${busy ? " busy" : ""}`,
			disabled: busy,
			"data-unzip-all": "",
			title: `Extract ${zips.length === 1 ? "the zip archive" : `each of the ${zips.length} zip archives`} in the folder next to itself; nothing is overwritten`,
			onclick: () => unzipFiles(item, zips),
		},
		...busyIcon("package-open"),
		"Unzip all",
		zips.length > 1 ? h("small", {}, String(zips.length)) : null,
	);
}

/**
 * The icon of a zip row doubles as its unzip button for admins: hovering
 * shows an opened package, clicking extracts the archive next to itself.
 */
function zipIconButton(item: LibraryItem, file: LibraryFile): HTMLElement {
	const key = unzipKey(item, file);
	const busy = unzipping.has(key);
	return h(
		"button",
		{
			type: "button",
			class: `file-icon-action${busy ? " busy" : ""}`,
			disabled: busy,
			"data-unzip": key,
			title: "Unzip archive here",
			"aria-label": `Unzip ${file.name}`,
			onclick: (ev: Event) => {
				ev.stopPropagation();
				unzipFiles(item, [file]);
			},
			// Enter/Space on the button must not also open the row's viewer.
			onkeydown: (ev: Event) => ev.stopPropagation(),
		},
		...(
			[
				[fileIcon(file), "zip-idle"],
				["package-open", "zip-hover"],
				["loader-circle", "zip-busy"],
			] as const
		).map(([name, cls]) => {
			const el = icon(name);
			el.classList.add(cls);
			return el;
		}),
	);
}

// "Download from itch.io" jobs ---------------------------------------------

/** The job the overlay follows, if any. */
let job: { id: string; timer: number } | null = null;

async function startJob(item: LibraryItem): Promise<void> {
	if (job) return;
	try {
		const res = await fetch(`/api/fetch/${encodePath(item.directory)}`, {
			method: "POST",
		});
		if (!res.ok) throw new Error(await res.text());
		followJob((await res.json()) as JobStatus);
	} catch (err) {
		toast(
			`Could not start the download: ${String(err).replace(/^Error: /, "")}`,
		);
	}
}

/** Show the overlay for `status` and poll until the job is over. */
function followJob(status: JobStatus): void {
	if (job) return;
	const line = h("div", { class: "job-line" });
	const elapsed = h("span", { class: "job-elapsed" });
	const spinner = h("span", { class: "job-spinner" }, icon("loader-circle"));
	const message = h("p", { class: "job-message" });
	const cancel = h(
		"button",
		{ type: "button", class: "button", onclick: () => cancelJob() },
		icon("x"),
		"Cancel",
	);
	const overlay = h(
		"div",
		{
			class: "job",
			role: "dialog",
			"aria-modal": "true",
			"aria-live": "polite",
		},
		h(
			"div",
			{ class: "job-card" },
			spinner,
			h("h2", {}, status.title),
			h("div", { class: "job-sub" }, "Downloading from itch.io ", elapsed),
			line,
			message,
			h("div", { class: "job-actions" }, cancel),
		),
	);
	document.body.append(overlay);
	const started = new Date(status.startedAt).getTime();

	const render = (st: JobStatus) => {
		const last = st.log.at(-1) ?? "";
		line.textContent = last.replace(/^\S+ \S+ \[\w+\] /, "");
		const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
		elapsed.textContent = `· ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
		if (st.state === "running") return false;
		clearInterval(job?.timer);
		job = null;
		if (st.state === "done") {
			overlay.remove();
			toast(
				`${st.title} is ready${st.size ? ` (${formatBytes(st.size)})` : ""}; downloading.`,
			);
			location.assign(`/api/fetch/job/${encodeURIComponent(st.id)}/download`);
		} else if (st.state === "cancelled") {
			overlay.remove();
			toast("Cancelled.");
		} else {
			spinner.replaceChildren(icon("ban"));
			overlay.classList.add("failed");
			message.textContent = st.message || "The download failed.";
			cancel.replaceChildren(icon("x"), "Close");
			cancel.onclick = () => overlay.remove();
		}
		return true;
	};

	const poll = async () => {
		try {
			const res = await fetch(
				`/api/fetch/job/${encodeURIComponent(status.id)}`,
			);
			if (res.status === 404) {
				render({ ...status, state: "cancelled", log: [] });
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			render((await res.json()) as JobStatus);
		} catch (err) {
			line.textContent = `Lost contact with the server: ${String(err)}`;
		}
	};
	job = { id: status.id, timer: window.setInterval(poll, 1000) };
	render(status);
}

async function cancelJob(): Promise<void> {
	if (!job) return;
	try {
		await fetch(`/api/fetch/job/${encodeURIComponent(job.id)}`, {
			method: "DELETE",
		});
	} catch (err) {
		toast(`Could not cancel: ${String(err)}`);
	}
}

/** A job started earlier (or from another device) is still running: show it. */
async function resumeJob(): Promise<void> {
	try {
		const res = await fetch("/api/fetch/current");
		if (!res.ok) return;
		const status = (await res.json()) as JobStatus | null;
		if (status?.state === "running") followJob(status);
	} catch {
		// the server is unreachable; the library load reports that
	}
}

function section(
	title: string,
	body: HTMLElement,
	tool: HTMLElement | null = null,
): HTMLElement {
	return h(
		"div",
		{ class: "section" },
		h("div", { class: "section-head" }, h("h3", {}, title), tool),
		body,
	);
}

const ROLE_ORDER: LibraryFile["role"][] = [
	"download",
	"video",
	"incomplete",
	"old",
	"cover",
	"screenshot",
	"pdf",
	"manifest",
];

/** Full item trees from `/api/item`, by directory; cleared on refresh. */
const treeCache = new Map<string, ItemResponse>();

/** How the file list of an item is folded; not persisted. */
interface TreeView {
	/** Folder paths currently open. */
	expanded: Set<string>;
	/** Default for folders without an override: flattened or nested. */
	flatAll: boolean;
	/** Per-folder choice, by path. */
	flat: Map<string, boolean>;
}
const treeViews = new Map<string, TreeView>();

function treeView(directory: string): TreeView {
	let view = treeViews.get(directory);
	if (!view) {
		view = { expanded: new Set(), flatAll: false, flat: new Map() };
		treeViews.set(directory, view);
	}
	return view;
}

function isFlat(view: TreeView, path: string): boolean {
	return view.flat.get(path) ?? view.flatAll;
}

async function loadTree(item: LibraryItem): Promise<ItemResponse | null> {
	const cached = treeCache.get(item.directory);
	if (cached) return cached;
	try {
		const res = await fetch(`/api/item/${encodePath(item.directory)}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const tree = (await res.json()) as ItemResponse;
		treeCache.set(item.directory, tree);
		return tree;
	} catch (err) {
		toast(`Could not list the folder: ${String(err)}`);
		return null;
	}
}

/** One line of the file list. */
interface Row {
	file: LibraryFile;
	depth: number;
	/** Path relative to the flattened folder the row belongs to. */
	within?: string;
}

function compareFiles(a: LibraryFile, b: LibraryFile): number {
	return (
		ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
		Number(b.kind === "folder") - Number(a.kind === "folder") ||
		a.name.localeCompare(b.name)
	);
}

/** Every file below `folder`, images first, then by path. */
function descendants(folder: LibraryFile): LibraryFile[] {
	const out: LibraryFile[] = [];
	const walk = (files: LibraryFile[]) => {
		for (const f of files) {
			if (f.kind === "folder") walk(f.children ?? []);
			else out.push(f);
		}
	};
	walk(folder.children ?? []);
	// Viewable images first: a flattened folder is for browsing its pictures.
	const img = (f: LibraryFile) => Number(viewerMode(f) === "image");
	return out.sort((a, b) => img(b) - img(a) || a.path.localeCompare(b.path));
}

/** Rows in display order for `files`, honouring the fold state. */
function collectRows(
	files: LibraryFile[],
	depth: number,
	view: TreeView,
	rows: Row[],
): void {
	for (const file of [...files].sort(compareFiles)) {
		rows.push({ file, depth });
		if (file.kind !== "folder" || !view.expanded.has(file.path)) continue;
		if (isFlat(view, file.path)) {
			for (const f of descendants(file))
				rows.push({
					file: f,
					depth: depth + 1,
					within: f.path.slice(file.path.length + 1),
				});
		} else {
			collectRows(file.children ?? [], depth + 1, view, rows);
		}
	}
}

/** The Files section: header with the nested/flat default, then the list. */
function renderFilesSection(item: LibraryItem): HTMLElement {
	const view = treeView(item.directory);
	const tree = treeCache.get(item.directory);
	const toggle = h(
		"button",
		{
			type: "button",
			class: "section-tool",
			"aria-pressed": String(view.flatAll),
			title: view.flatAll
				? "Show folders nested"
				: "Flatten every folder: list all files inside",
			onclick: () => {
				view.flatAll = !view.flatAll;
				view.flat.clear();
				if (view.flatAll) {
					for (const f of tree?.files ?? item.files)
						if (f.kind === "folder") view.expanded.add(f.path);
				}
				refreshFiles(item);
			},
		},
		icon(view.flatAll ? "rows-3" : "list-tree"),
	);
	const hasFolders = (tree?.files ?? item.files).some(
		(f) => f.kind === "folder",
	);
	const el = section(
		"Files",
		renderFiles(item, tree?.files ?? item.files, view),
		hasFolders ? toggle : null,
	);
	el.classList.add("files-section");
	if (tree?.truncated) {
		el.append(
			h(
				"div",
				{ class: "sub" },
				"Large folder: only the first entries are listed.",
			),
		);
	}
	if (!tree) {
		loadTree(item).then((loaded) => {
			if (loaded && inspectorFor === item.directory) refreshFiles(item);
		});
	}
	return el;
}

/** Rebuild just the Files section of the open inspector. */
function refreshFiles(item: LibraryItem): void {
	const old = inspector.querySelector(".files-section");
	if (old && inspectorFor === item.directory)
		old.replaceWith(renderFilesSection(item));
}

function viewerContext(item: LibraryItem): ViewerContext {
	return {
		reveal: isLocal ? (f) => reveal(`${item.directory}/${f.path}`) : null,
		fileManager: fileManagerName(),
		unzip: state.admin
			? async (f) => {
					if (isZip(f)) await unzipFiles(item, [f]);
				}
			: null,
	};
}

function renderFiles(
	item: LibraryItem,
	files: LibraryFile[],
	view: TreeView,
): HTMLElement {
	const list = h("div", { class: "files" });
	const rows: Row[] = [];
	collectRows(files, 0, view, rows);
	// What ←/→ in the viewer walk over: the files as listed, top to bottom.
	const sequence = rows
		.filter((r) => r.file.kind !== "folder")
		.map((r) => r.file);
	const ctx = viewerContext(item);
	const treeLoaded = treeCache.has(item.directory);

	for (const row of rows) {
		const { file } = row;
		const dim = file.role === "old" || file.role === "incomplete";
		const path = `${item.directory}/${file.path}`;
		const revealButton = isLocal
			? h(
					"button",
					{
						type: "button",
						class: "file-action",
						title: `Reveal in ${fileManagerName()}`,
						onclick: (ev: Event) => {
							ev.stopPropagation();
							reveal(path);
						},
					},
					icon("folder-open"),
				)
			: null;

		if (file.kind === "folder") {
			const open = view.expanded.has(file.path);
			const flat = isFlat(view, file.path);
			const count = file.children?.length;
			const toggleOpen = () => {
				if (!treeLoaded) return;
				if (open) view.expanded.delete(file.path);
				else view.expanded.add(file.path);
				refreshFiles(item);
			};
			list.append(
				h(
					"div",
					{
						class: `file folder${dim ? " dim" : ""}${open ? " open" : ""}`,
						style: `--depth:${row.depth}`,
						role: "button",
						tabindex: "0",
						"aria-expanded": String(open),
						onclick: toggleOpen,
						onkeydown: ((ev: KeyboardEvent) => {
							if (ev.key === "Enter" || ev.key === " ") {
								ev.preventDefault();
								toggleOpen();
							}
						}) as EventListener,
					},
					h(
						"span",
						{ class: `file-chevron${treeLoaded ? "" : " pending"}` },
						icon("chevron-right"),
					),
					icon(open ? "folder-open" : "folder"),
					h(
						"span",
						{ class: "file-name", title: file.path },
						file.name,
						count !== undefined
							? h("small", {}, `${count} item${count === 1 ? "" : "s"}`)
							: null,
					),
					h("span", { class: "file-size" }, formatBytes(file.size)),
					h(
						"span",
						{ class: "file-actions" },
						treeLoaded && count
							? h(
									"button",
									{
										type: "button",
										class: "file-action",
										"aria-pressed": String(flat),
										title: flat
											? "Show subfolders nested"
											: "Flatten: list every file inside",
										onclick: (ev: Event) => {
											ev.stopPropagation();
											view.flat.set(file.path, !flat);
											view.expanded.add(file.path);
											refreshFiles(item);
										},
									},
									icon(flat ? "rows-3" : "list-tree"),
								)
							: null,
						revealButton,
					),
				),
			);
			continue;
		}

		const index = sequence.indexOf(file);
		const view_ = () => openViewer(sequence, index, ctx);
		const label = row.within
			? row.within.includes("/")
				? row.within.slice(0, row.within.lastIndexOf("/"))
				: ""
			: ROLE_LABEL[file.role];
		list.append(
			h(
				"div",
				{
					class: `file${dim ? " dim" : ""}${row.depth ? " nested" : ""}`,
					style: `--depth:${row.depth}`,
					role: "button",
					tabindex: "0",
					title: `View ${file.name}`,
					onclick: view_,
					onkeydown: ((ev: KeyboardEvent) => {
						if (ev.key === "Enter" || ev.key === " ") {
							ev.preventDefault();
							view_();
						}
					}) as EventListener,
				},
				state.admin && isZip(file)
					? zipIconButton(item, file)
					: icon(fileIcon(file)),
				h(
					"span",
					{ class: "file-name", title: file.path },
					file.name,
					label ? h("small", {}, label) : null,
				),
				h("span", { class: "file-size" }, formatBytes(file.size)),
				h(
					"span",
					{ class: "file-actions" },
					file.url
						? h(
								"a",
								{
									class: "file-action",
									href: file.url,
									download: file.name,
									title: `Download ${file.name}`,
									onclick: (ev: Event) => ev.stopPropagation(),
								},
								icon("download"),
							)
						: null,
					revealButton,
				),
			),
		);
	}
	if (rows.length === 0)
		list.append(h("span", { class: "sub" }, "Empty folder"));
	return list;
}

// ---------------------------------------------------------------------------
// Toasts

let toastTimer = 0;

function toast(message: string): void {
	document.querySelector(".toast")?.remove();
	const el = h("div", { class: "toast", role: "status" }, message);
	document.body.append(el);
	clearTimeout(toastTimer);
	toastTimer = window.setTimeout(() => el.remove(), 4000);
}

// ---------------------------------------------------------------------------
// Wiring

function setQuery(query: string): void {
	state.query = query;
	searchInput.value = query;
	renderAll();
}

function setView(view: View): void {
	state.view = view;
	state.detailsOpen = false;
	for (const button of document.querySelectorAll<HTMLButtonElement>(
		"[data-view]",
	)) {
		button.setAttribute("aria-pressed", String(button.dataset.view === view));
	}
	savePreferences();
	renderAll();
}

function init(): void {
	hydrateIcons(document);
	restorePreferences();
	sortSelect.value = state.sort;

	let debounce = 0;
	searchInput.addEventListener("input", () => {
		clearTimeout(debounce);
		debounce = window.setTimeout(() => {
			state.query = searchInput.value;
			renderAll();
		}, 60);
	});
	sortSelect.addEventListener("change", () => {
		const key = sortSelect.value as SortKey;
		setSort(key, DEFAULT_DIR[key]);
	});
	for (const button of document.querySelectorAll<HTMLButtonElement>(
		"[data-view]",
	)) {
		button.addEventListener("click", () =>
			setView(button.dataset.view as View),
		);
	}
	byId("refresh").addEventListener("click", () => {
		treeCache.clear();
		loadLibrary();
	});
	showHiddenButton.addEventListener("click", () => {
		state.showHidden = !state.showHidden;
		savePreferences();
		renderAdmin();
		renderAll();
	});
	const brandMenu = byId<HTMLButtonElement>("brand-menu");
	const adminDialog = () =>
		openAdminDialog({
			admin: state.admin,
			enabled: state.adminEnabled,
			onSignedIn: () => {
				toast("Signed in as admin.");
				setAdmin(true);
			},
			onSignedOut: () => {
				toast("Signed out.");
				setAdmin(false);
			},
		});
	brandMenu.addEventListener("click", () =>
		toggleMenu(brandMenu, () => [
			state.admin
				? {
						label: "Admin session",
						icon: "shield-check",
						onSelect: adminDialog,
					}
				: { label: "Admin sign-in", icon: "lock", onSelect: adminDialog },
		]),
	);
	const matchCase = byId<HTMLButtonElement>("match-case");
	const showMatchCase = () =>
		matchCase.setAttribute("aria-pressed", String(state.caseSensitive));
	showMatchCase();
	matchCase.addEventListener("click", () => {
		state.caseSensitive = !state.caseSensitive;
		showMatchCase();
		savePreferences();
		renderAll();
	});
	// Crossing the narrow-screen breakpoint changes the gallery's inspector rule.
	narrowScreen.addEventListener("change", () => renderInspector());
	const syncPlaceholder = () => {
		searchInput.placeholder = tightTopbar.matches
			? SHORT_PLACEHOLDER
			: LONG_PLACEHOLDER;
	};
	syncPlaceholder();
	tightTopbar.addEventListener("change", syncPlaceholder);

	document.addEventListener("keydown", (ev) => {
		const typing =
			ev.target instanceof HTMLInputElement ||
			ev.target instanceof HTMLSelectElement;
		if (ev.key === "Escape") {
			if (job) {
				cancelJob();
			} else if (typing && searchInput.value) {
				setQuery("");
			} else if (typing) {
				searchInput.blur();
			} else if (inspectorWanted()) {
				closeDetails();
			}
			return;
		}
		if (typing) return;
		if (
			ev.key === "/" ||
			((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k")
		) {
			ev.preventDefault();
			searchInput.focus();
			searchInput.select();
		} else if (ev.key === "ArrowRight" || ev.key === "ArrowDown") {
			ev.preventDefault();
			moveSelection(1);
		} else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
			ev.preventDefault();
			moveSelection(-1);
		} else if (ev.key === "1" || ev.key === "2" || ev.key === "3") {
			setView(VIEWS[Number(ev.key) - 1] ?? "grid");
		}
	});

	setView(state.view);
	// The library answer depends on the admin cookie; know the state first
	// so the first render already shows the admin controls.
	checkAdmin().then(loadLibrary);
	resumeJob();
}

init();
