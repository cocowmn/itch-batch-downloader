// Full-screen file viewer: images (pixel-art friendly), JSON, markdown and
// text, PDF, video and audio, and a file card for everything else. Navigates
// over the sequence it was opened with (←/→, buttons, swipe, filmstrip).

import type { LibraryFile } from "../../models/library.ts";
import { formatBytes, formatDate, h } from "./dom.ts";
import { fileIcon, icon } from "./icons.ts";
import {
	extension,
	highlightJson,
	MAX_TEXT_BYTES,
	renderMarkdown,
	type ViewerMode,
	viewerMode,
} from "./text.ts";

export interface ViewerContext {
	/** Show the file in the file manager; null when the browser is remote. */
	reveal: ((file: LibraryFile) => void) | null;
	/** Name of the file manager for button labels. */
	fileManager: string;
}

type Zoom = "fit" | 1 | 2 | 4 | 8;
const ZOOMS: Zoom[] = ["fit", 1, 2, 4, 8];

/** Mat behind an image: checkerboard, a preset, or a picked colour. */
type Mat = "transparent" | "white" | "black" | "custom";
const MATS: { mat: Mat; title: string }[] = [
	{ mat: "transparent", title: "Transparent mat" },
	{ mat: "white", title: "White mat" },
	{ mat: "black", title: "Black mat" },
	{ mat: "custom", title: "Pick a mat colour" },
];

interface Viewer {
	el: HTMLElement;
	body: HTMLElement;
	head: HTMLElement;
	counter: HTMLElement;
	strip: HTMLElement;
	sequence: LibraryFile[];
	index: number;
	ctx: ViewerContext;
	/** Cancels the fetch of the file being shown when moving on. */
	abort: AbortController;
	restoreFocus: Element | null;
}

let viewer: Viewer | null = null;
// Image settings stick for the session: pixel art stays pixel art.
let pixelated = true;
let zoom: Zoom = "fit";
let mat: Mat = "transparent";
let customMat = "#808080";

export function viewerOpen(): boolean {
	return viewer !== null;
}

export function openViewer(
	sequence: LibraryFile[],
	index: number,
	ctx: ViewerContext,
): void {
	if (sequence.length === 0) return;
	if (viewer) closeViewer();
	const body = h("div", { class: "viewer-body" });
	const head = h("header", { class: "viewer-head" });
	const counter = h("div", { class: "viewer-counter" });
	const strip = h("div", {
		class: "viewer-strip hidden-scrollbar",
		role: "tablist",
	});
	const el = h(
		"div",
		{ class: "viewer", role: "dialog", "aria-modal": "true" },
		head,
		body,
		strip,
		h(
			"button",
			{
				type: "button",
				class: "viewer-nav prev",
				title: "Previous (←)",
				onclick: () => step(-1),
			},
			icon("chevron-left"),
		),
		h(
			"button",
			{
				type: "button",
				class: "viewer-nav next",
				title: "Next (→)",
				onclick: () => step(1),
			},
			icon("chevron-right"),
		),
		counter,
	);
	viewer = {
		el,
		body,
		head,
		counter,
		strip,
		sequence,
		index: Math.max(0, Math.min(index, sequence.length - 1)),
		ctx,
		abort: new AbortController(),
		restoreFocus: document.activeElement,
	};
	el.classList.toggle("single", sequence.length < 2);
	renderStrip(viewer);
	document.body.append(el);
	document.body.classList.add("viewer-open");
	document.addEventListener("keydown", onKey, true);
	installSwipe(body);
	show();
}

export function closeViewer(): void {
	if (!viewer) return;
	viewer.abort.abort();
	viewer.el.remove();
	document.body.classList.remove("viewer-open");
	document.removeEventListener("keydown", onKey, true);
	const focus = viewer.restoreFocus;
	viewer = null;
	if (focus instanceof HTMLElement) focus.focus();
}

function step(delta: number): void {
	if (!viewer || viewer.sequence.length < 2) return;
	const n = viewer.sequence.length;
	viewer.index = (viewer.index + delta + n) % n;
	show();
}

function goTo(index: number): void {
	if (!viewer || index === viewer.index) return;
	viewer.index = index;
	show();
}

function onKey(ev: KeyboardEvent): void {
	if (!viewer) return;
	// The viewer owns the keyboard while open: nothing reaches the app.
	if (ev.key === "Escape") {
		ev.preventDefault();
		ev.stopPropagation();
		closeViewer();
	} else if (ev.key === "ArrowLeft") {
		ev.preventDefault();
		ev.stopPropagation();
		step(-1);
	} else if (ev.key === "ArrowRight") {
		ev.preventDefault();
		ev.stopPropagation();
		step(1);
	} else if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
		ev.stopPropagation();
	}
}

/** Swipe left/right over the content (touch only; pans of a zoomed image win). */
function installSwipe(body: HTMLElement): void {
	let start: { x: number; y: number; id: number } | null = null;
	body.addEventListener("pointerdown", (ev) => {
		if (ev.pointerType !== "touch") return;
		const pane = (ev.target as HTMLElement).closest(".viewer-image");
		if (pane && pane.scrollWidth > pane.clientWidth) return;
		start = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
	});
	const end = (ev: PointerEvent) => {
		if (!start || ev.pointerId !== start.id) return;
		const dx = ev.clientX - start.x;
		const dy = ev.clientY - start.y;
		start = null;
		if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.5)
			step(dx < 0 ? 1 : -1);
	};
	body.addEventListener("pointerup", end);
	body.addEventListener("pointercancel", () => {
		start = null;
	});
}

// ---------------------------------------------------------------------------
// Rendering the current file

function show(): void {
	if (!viewer) return;
	const v = viewer;
	v.abort.abort();
	v.abort = new AbortController();
	const file = v.sequence[v.index];
	if (!file) return;
	const mode = viewerMode(file);
	v.counter.textContent = `${v.index + 1} / ${v.sequence.length}`;
	renderHead(v, file, mode);
	v.body.replaceChildren();
	v.body.dataset.mode = mode;
	const url = file.url ?? "";
	switch (mode) {
		case "image":
			v.body.append(renderImage(v, file, url));
			break;
		case "pdf":
			v.body.append(
				h("iframe", { class: "viewer-pdf", src: url, title: file.name }),
				h(
					"div",
					{ class: "viewer-pdf-fallback" },
					"If the PDF does not show here, ",
					h(
						"a",
						{ href: url, target: "_blank", rel: "noreferrer" },
						"open it in a new tab",
					),
					".",
				),
			);
			break;
		case "video":
			v.body.append(
				h(
					"div",
					{ class: "viewer-media" },
					h("video", { class: "viewer-video", src: url, controls: true }),
				),
			);
			break;
		case "audio":
			v.body.append(
				h(
					"div",
					{ class: "viewer-media viewer-audio" },
					icon("file-audio"),
					h("strong", {}, file.name),
					h("audio", { src: url, controls: true }),
				),
			);
			break;
		case "json":
		case "markdown":
		case "text":
			v.body.append(
				h("div", { class: "viewer-loading" }, icon("loader-circle")),
			);
			renderText(v, url, mode, v.abort.signal);
			break;
		default:
			v.body.append(renderCard(v, file));
	}
	preloadNeighbours(v);
	updateStrip(v);
	v.head.querySelector<HTMLElement>(".viewer-close")?.focus();
}

/** Filmstrip of the whole sequence: image thumbnails, icons for the rest. */
function renderStrip(v: Viewer): void {
	v.strip.replaceChildren(
		...v.sequence.map((file, i) =>
			h(
				"button",
				{
					type: "button",
					class: "viewer-strip-item",
					role: "tab",
					title: file.name,
					onclick: () => goTo(i),
				},
				file.url && viewerMode(file) === "image"
					? h("img", {
							src: file.url,
							alt: "",
							loading: "lazy",
							draggable: "false",
						})
					: icon(fileIcon(file)),
			),
		),
	);
}

function updateStrip(v: Viewer): void {
	v.strip.classList.toggle("pixelated", pixelated);
	const items = v.strip.children;
	for (let i = 0; i < items.length; i++) {
		const item = items[i] as HTMLElement;
		const active = i === v.index;
		item.classList.toggle("active", active);
		item.setAttribute("aria-selected", String(active));
		item.tabIndex = active ? 0 : -1;
		if (active)
			item.scrollIntoView({
				inline: "center",
				block: "nearest",
				behavior: "smooth",
			});
	}
}

function renderHead(v: Viewer, file: LibraryFile, mode: ViewerMode): void {
	const folder = file.path.includes("/")
		? file.path.slice(0, file.path.lastIndexOf("/"))
		: "";
	const meta = h(
		"span",
		{ class: "viewer-meta" },
		...[folder, formatBytes(file.size), formatDate(file.modified)]
			.filter(Boolean)
			.flatMap((s, i) => (i ? [" · ", s] : [s])),
		h("span", { class: "viewer-dims" }),
	);
	const url = file.url ?? "";
	const tools = h(
		"div",
		{ class: "viewer-tools" },
		h(
			"a",
			{
				class: "viewer-tool",
				href: url,
				download: file.name,
				title: "Download",
			},
			icon("download"),
		),
		v.ctx.reveal
			? h(
					"button",
					{
						type: "button",
						class: "viewer-tool",
						title: `Reveal in ${v.ctx.fileManager}`,
						onclick: () => v.ctx.reveal?.(file),
					},
					icon("folder-open"),
				)
			: null,
		h(
			"a",
			{
				class: "viewer-tool",
				href: url,
				target: "_blank",
				rel: "noreferrer",
				title: "Open in a new tab",
			},
			icon("external-link"),
		),
		h(
			"button",
			{
				type: "button",
				class: "viewer-tool viewer-close",
				title: "Close (Esc)",
				onclick: () => closeViewer(),
			},
			icon("x"),
		),
	);
	// Image tools sit between the name and the actions so the actions (and
	// especially close) stay on the first row when the head wraps on phones.
	v.head.replaceChildren(
		h(
			"div",
			{ class: "viewer-info" },
			icon(fileIcon(file)),
			h(
				"div",
				{ class: "viewer-name" },
				h("strong", { title: file.path }, file.name),
				meta,
			),
		),
		...(mode === "image" ? [imageTools(v)] : []),
		tools,
	);
}

/** Mat colour, pixel/smooth toggle and the zoom steps. */
function imageTools(v: Viewer): HTMLElement {
	const mats = h("div", { class: "viewer-mat", role: "group" });
	const pressMat = (which: Mat) => {
		mat = which;
		MATS.forEach(({ mat: other }, i) => {
			mats.children[i]?.setAttribute("aria-pressed", String(other === which));
		});
		applyMat(v);
	};
	for (const { mat: which, title } of MATS) {
		if (which === "custom") {
			// A label so the native colour picker opens from the button itself.
			const input = h("input", {
				type: "color",
				alpha: true,
				value: customMat,
				"aria-label": title,
				oninput: () => {
					customMat = input.value;
					pressMat("custom");
				},
			});
			mats.append(
				h(
					"label",
					{
						class: "viewer-tool",
						"aria-pressed": String(mat === which),
						title,
					},
					icon("pipette"),
					input,
				),
			);
		} else {
			mats.append(
				h(
					"button",
					{
						type: "button",
						class: "viewer-tool",
						"aria-pressed": String(mat === which),
						title,
						onclick: () => pressMat(which),
					},
					h("span", { class: `viewer-swatch ${which}` }),
				),
			);
		}
	}
	const zoomButtons = h("div", { class: "viewer-zoom", role: "group" });
	for (const z of ZOOMS) {
		zoomButtons.append(
			h(
				"button",
				{
					type: "button",
					"aria-pressed": String(z === zoom),
					title: z === "fit" ? "Fit to window" : `${z}× (integer scale)`,
					onclick: () => {
						zoom = z;
						ZOOMS.forEach((other, i) => {
							zoomButtons.children[i]?.setAttribute(
								"aria-pressed",
								String(other === z),
							);
						});
						applyZoom(v);
					},
				},
				z === "fit" ? "Fit" : `${z}×`,
			),
		);
	}
	const pixel = h(
		"button",
		{
			type: "button",
			class: "viewer-tool",
			"aria-pressed": String(pixelated),
			title: "Pixel art: nearest-neighbour scaling (toggle for smooth)",
			onclick: () => {
				pixelated = !pixelated;
				pixel.setAttribute("aria-pressed", String(pixelated));
				v.strip.classList.toggle("pixelated", pixelated);
				applyZoom(v);
			},
		},
		icon("grid-2x2"),
	);
	return h("div", { class: "viewer-image-tools" }, mats, pixel, zoomButtons);
}

function applyMat(
	v: Viewer,
	pane = v.body.querySelector<HTMLElement>(".viewer-image"),
): void {
	if (!pane) return;
	const colour =
		mat === "custom" ? customMat : mat === "transparent" ? "" : mat;
	pane.classList.toggle("matted", colour !== "");
	pane.style.setProperty("--mat", colour);
	const pipette = v.head.querySelector<HTMLElement>(".viewer-mat label");
	pipette?.style.setProperty("--picked", customMat);
	pipette?.classList.toggle("picked", mat === "custom");
}

function renderImage(v: Viewer, file: LibraryFile, url: string): HTMLElement {
	const img = h("img", { src: url, alt: file.name, draggable: "false" });
	const pane = h("div", { class: "viewer-image" }, img);
	img.addEventListener("load", () => {
		const dims = v.head.querySelector(".viewer-dims");
		if (dims)
			dims.textContent = ` · ${img.naturalWidth} × ${img.naturalHeight}`;
		applyZoom(v);
	});
	img.addEventListener("error", () => {
		pane.replaceChildren(
			h("div", { class: "viewer-error" }, "The image could not be loaded."),
		);
	});
	installPan(pane);
	// Fit depends on the pane size.
	window.addEventListener("resize", () => applyZoom(v), {
		signal: v.abort.signal,
	});
	applyMat(v, pane);
	return pane;
}

function applyZoom(v: Viewer): void {
	const pane = v.body.querySelector<HTMLElement>(".viewer-image");
	const img = pane?.querySelector("img");
	if (!pane || !img) return;
	pane.classList.toggle("pixelated", pixelated);
	pane.classList.toggle("fit", zoom === "fit");
	let factor: number | null = zoom === "fit" ? null : zoom;
	if (zoom === "fit" && img.naturalWidth) {
		// Fit fills the pane, scaling small images up as well as large ones
		// down; pixel art snaps to a whole multiple so pixels stay square.
		let fit = Math.min(
			(pane.clientWidth - 32) / img.naturalWidth,
			(pane.clientHeight - 32) / img.naturalHeight,
		);
		if (pixelated) fit = Math.floor(fit);
		// Below 1 the CSS max-width/height does the shrinking.
		if (fit >= 1) factor = fit;
	}
	if (factor === null || !img.naturalWidth) {
		img.style.width = "";
		img.style.height = "";
	} else {
		img.style.width = `${img.naturalWidth * factor}px`;
		img.style.height = `${img.naturalHeight * factor}px`;
	}
	// A zoomed image opens centred, like the fitted one.
	pane.scrollLeft = (pane.scrollWidth - pane.clientWidth) / 2;
	pane.scrollTop = (pane.scrollHeight - pane.clientHeight) / 2;
}

/** Drag to pan an image larger than the pane (mouse/pen; touch scrolls natively). */
function installPan(pane: HTMLElement): void {
	let drag: { x: number; y: number; left: number; top: number } | null = null;
	pane.addEventListener("pointerdown", (ev) => {
		if (ev.pointerType === "touch" || ev.button !== 0) return;
		if (
			pane.scrollWidth <= pane.clientWidth &&
			pane.scrollHeight <= pane.clientHeight
		)
			return;
		drag = {
			x: ev.clientX,
			y: ev.clientY,
			left: pane.scrollLeft,
			top: pane.scrollTop,
		};
		pane.setPointerCapture(ev.pointerId);
		pane.classList.add("dragging");
		ev.preventDefault();
	});
	pane.addEventListener("pointermove", (ev) => {
		if (!drag) return;
		pane.scrollLeft = drag.left - (ev.clientX - drag.x);
		pane.scrollTop = drag.top - (ev.clientY - drag.y);
	});
	const stop = () => {
		drag = null;
		pane.classList.remove("dragging");
	};
	pane.addEventListener("pointerup", stop);
	pane.addEventListener("pointercancel", stop);
}

async function renderText(
	v: Viewer,
	url: string,
	mode: "json" | "markdown" | "text",
	signal: AbortSignal,
): Promise<void> {
	let text: string;
	try {
		const res = await fetch(url, { signal });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		text = await res.text();
	} catch (err) {
		if (signal.aborted) return;
		v.body.replaceChildren(
			h("div", { class: "viewer-error" }, `Could not load: ${String(err)}`),
		);
		return;
	}
	if (signal.aborted) return;
	let content: HTMLElement;
	if (mode === "json") {
		content = h("pre", { class: "viewer-code" });
		try {
			content.innerHTML = highlightJson(
				JSON.stringify(JSON.parse(text), null, 2),
			);
		} catch {
			content.textContent = text;
		}
	} else if (mode === "markdown") {
		content = h("div", { class: "viewer-markdown" });
		content.innerHTML = renderMarkdown(text, new URL(url, location.href).href);
	} else {
		content = h("pre", { class: "viewer-code" }, text);
	}
	v.body.replaceChildren(h("div", { class: "viewer-scroll" }, content));
}

function renderCard(v: Viewer, file: LibraryFile): HTMLElement {
	const ext = extension(file.name);
	return h(
		"div",
		{ class: "viewer-card" },
		icon(fileIcon(file)),
		h("strong", {}, file.name),
		h(
			"span",
			{ class: "viewer-card-meta" },
			[
				ext ? `${ext.toUpperCase()} file` : "File",
				formatBytes(file.size),
				formatDate(file.modified),
			]
				.filter(Boolean)
				.join(" · "),
		),
		file.size > MAX_TEXT_BYTES && viewerModeIgnoringSize(file) !== "card"
			? h("span", { class: "viewer-card-note" }, "Too large to show here.")
			: null,
		file.url
			? h(
					"a",
					{ class: "button primary", href: file.url, download: file.name },
					icon("download"),
					"Download",
				)
			: null,
		v.ctx.reveal
			? h(
					"button",
					{
						type: "button",
						class: "button",
						onclick: () => v.ctx.reveal?.(file),
					},
					icon("folder-open"),
					`Reveal in ${v.ctx.fileManager}`,
				)
			: null,
	);
}

function viewerModeIgnoringSize(file: LibraryFile): ViewerMode {
	return viewerMode({ ...file, size: 0 });
}

function preloadNeighbours(v: Viewer): void {
	for (const delta of [1, -1]) {
		const n = v.sequence.length;
		const file = v.sequence[(v.index + delta + n) % n];
		if (file?.url && viewerMode(file) === "image") new Image().src = file.url;
	}
}
