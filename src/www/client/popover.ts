// A floating panel anchored to an element: the base for menus and, later,
// tooltips and the like. It sits below (or, short of room, above) its anchor,
// stays inside the viewport, and closes on Esc, a click elsewhere, a scroll
// outside itself or a resize. One popover is open at a time; opening another
// closes the first.

import { type Child, h } from "./dom.ts";

export interface PopoverOptions {
	/** The element the panel is positioned against and returns focus to. */
	anchor: HTMLElement;
	/** Side of the anchor the panel prefers. Default "bottom". */
	side?: "bottom" | "top";
	/** Which edge of the anchor the panel lines up with. Default "start". */
	align?: "start" | "end";
	/** Extra class on the panel, e.g. "menu". */
	class?: string;
	/** ARIA role of the panel. */
	role?: string;
	onClose?: () => void;
}

export interface Popover {
	el: HTMLElement;
	anchor: HTMLElement;
	close(): void;
	/** Recompute the position, e.g. after the content changed. */
	place(): void;
}

/** Gap between anchor and panel, and the least distance to the viewport edge. */
const GAP = 6;
const MARGIN = 8;

let current: Popover | null = null;

/** The popover currently open, if any. */
export function openPopoverFor(anchor: HTMLElement): Popover | null {
	return current?.anchor === anchor ? current : null;
}

export function closePopover(): void {
	current?.close();
}

export function openPopover(
	opts: PopoverOptions,
	...children: Child[]
): Popover {
	current?.close();
	const { anchor } = opts;
	const el = h(
		"div",
		{
			class: `popover${opts.class ? ` ${opts.class}` : ""}`,
			role: opts.role,
			tabindex: "-1",
		},
		...children,
	);
	// Where focus was (Safari does not focus a clicked button: then nowhere).
	const before = document.activeElement;
	const focusedBefore =
		before instanceof HTMLElement && before !== document.body ? before : null;

	const place = () => {
		const a = anchor.getBoundingClientRect();
		const width = el.offsetWidth;
		const height = el.offsetHeight;
		const roomBelow = window.innerHeight - a.bottom - GAP - MARGIN;
		const roomAbove = a.top - GAP - MARGIN;
		let side = opts.side ?? "bottom";
		if (side === "bottom" && height > roomBelow && roomAbove > roomBelow)
			side = "top";
		else if (side === "top" && height > roomAbove && roomBelow > roomAbove)
			side = "bottom";
		const top =
			side === "bottom"
				? a.bottom + GAP
				: Math.max(MARGIN, a.top - GAP - height);
		let left = (opts.align ?? "start") === "start" ? a.left : a.right - width;
		left = Math.max(MARGIN, Math.min(left, window.innerWidth - MARGIN - width));
		el.style.top = `${Math.round(top)}px`;
		el.style.left = `${Math.round(left)}px`;
		el.style.maxHeight = `${Math.max(80, side === "bottom" ? roomBelow : roomAbove)}px`;
		el.dataset.side = side;
	};

	const popover: Popover = {
		el,
		anchor,
		place,
		close() {
			if (!el.isConnected) return;
			el.remove();
			if (current === popover) current = null;
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", place);
			anchor.removeAttribute("aria-expanded");
			// Focus went into the panel (or nowhere): give it back to the anchor.
			const active = document.activeElement;
			if (!active || active === document.body || el.contains(active))
				(focusedBefore ?? anchor).focus();
			opts.onClose?.();
		},
	};
	const onPointerDown = (ev: PointerEvent) => {
		const target = ev.target as Node;
		if (el.contains(target) || anchor.contains(target)) return;
		popover.close();
	};
	const onKey = (ev: KeyboardEvent) => {
		if (ev.key !== "Escape") return;
		ev.stopPropagation();
		ev.preventDefault();
		popover.close();
	};
	const onScroll = (ev: Event) => {
		if (ev.target instanceof Node && el.contains(ev.target)) return;
		popover.close();
	};

	current = popover;
	anchor.setAttribute("aria-expanded", "true");
	document.body.append(el);
	place();
	// Capture phase: the page's own handlers never see what closes the panel.
	document.addEventListener("pointerdown", onPointerDown, true);
	document.addEventListener("keydown", onKey, true);
	document.addEventListener("scroll", onScroll, true);
	window.addEventListener("resize", place);
	return popover;
}
