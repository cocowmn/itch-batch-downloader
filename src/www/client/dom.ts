// Small DOM and formatting helpers shared by the UI modules.

export type Child = Node | string | null | undefined | false;

export type Attrs = Record<
	string,
	string | boolean | EventListener | undefined
>;

/** Create an element: `h("a", { href, onclick }, ...children)`. */
export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Attrs = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined || value === false) continue;
		if (typeof value === "function") {
			el.addEventListener(key.slice(2), value);
		} else if (value === true) {
			el.setAttribute(key, "");
		} else {
			el.setAttribute(key, value);
		}
	}
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		el.append(child);
	}
	return el;
}

export function byId<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Missing #${id}`);
	return el as T;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 100 ? 0 : 1)} ${UNITS[unit]}`;
}

export function formatDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

/** `2026-09-10` -> "Sep 10, 2026", as a local date (no timezone shift). */
export function formatDay(iso: string): string {
	const [y, m, d] = iso.split("-").map(Number);
	if (!y || !m || !d) return "";
	return new Date(y, m - 1, d).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}
