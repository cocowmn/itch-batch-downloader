// A context menu on top of the popover: a list of actions with icons, arrow
// key navigation and the menu ARIA roles. `toggleMenu` wires a button so a
// click opens the menu and a second click (or picking an item) closes it.

import { h } from "./dom.ts";
import { icon } from "./icons.ts";
import {
	openPopover,
	openPopoverFor,
	type Popover,
	type PopoverOptions,
} from "./popover.ts";

export interface MenuAction {
	label: string;
	/** Icon name, shown before the label. */
	icon?: string;
	/** Small text after the label, e.g. a size. */
	detail?: string;
	/** Tooltip. */
	title?: string;
	/** Shown but not selectable; the title can say why. */
	disabled?: boolean;
	/** Red, for destructive actions. */
	danger?: boolean;
	/** Rendered as a link (with `download`) instead of a button. */
	href?: string;
	download?: string;
	onSelect?: () => void;
}

export type MenuItem = MenuAction | "separator";

export type MenuOptions = Pick<PopoverOptions, "align" | "side" | "onClose">;

export function openMenu(
	anchor: HTMLElement,
	items: MenuItem[],
	opts: MenuOptions = {},
): Popover {
	const list = h("div", { class: "menu-list" });
	const popover = openPopover(
		{ ...opts, anchor, class: "menu", role: "menu" },
		list,
	);
	for (const item of items) {
		if (item === "separator") {
			list.append(h("div", { class: "menu-separator", role: "separator" }));
			continue;
		}
		const kids = [
			item.icon ? icon(item.icon) : h("span", { class: "menu-icon-gap" }),
			h("span", { class: "menu-label" }, item.label),
			item.detail ? h("small", {}, item.detail) : null,
		];
		const attrs = {
			class: `menu-item${item.danger ? " danger" : ""}`,
			role: "menuitem",
			tabindex: "-1",
			title: item.title,
			"aria-disabled": item.disabled ? "true" : undefined,
		};
		if (item.disabled) {
			list.append(h("div", attrs, ...kids));
			continue;
		}
		const select = () => {
			popover.close();
			item.onSelect?.();
		};
		if (item.href) {
			list.append(
				h(
					"a",
					{
						...attrs,
						href: item.href,
						download: item.download,
						onclick: select,
					},
					...kids,
				),
			);
		} else {
			list.append(
				h("button", { ...attrs, type: "button", onclick: select }, ...kids),
			);
		}
	}

	const focusable = () =>
		[...list.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
			(el) => el.getAttribute("aria-disabled") !== "true",
		);
	const focusAt = (index: number) => {
		const items_ = focusable();
		items_
			.at(((index % items_.length) + items_.length) % items_.length)
			?.focus();
	};
	list.addEventListener("keydown", (ev) => {
		const items_ = focusable();
		const at = items_.indexOf(document.activeElement as HTMLElement);
		switch (ev.key) {
			case "ArrowDown":
				focusAt(at + 1);
				break;
			case "ArrowUp":
				focusAt(at - 1);
				break;
			case "Home":
				focusAt(0);
				break;
			case "End":
				focusAt(-1);
				break;
			case "Enter":
			case " ":
				// Activate the focused item ourselves: same for buttons and links.
				if (at !== -1) items_[at]?.click();
				break;
			case "Tab":
				popover.close();
				return;
			default:
				return;
		}
		ev.preventDefault();
	});
	popover.place();
	focusAt(0);
	return popover;
}

/**
 * Open `items` from `anchor`, or close the menu if it is already open from
 * there. `items` is a function so the entries reflect the state at click time.
 */
export function toggleMenu(
	anchor: HTMLElement,
	items: () => MenuItem[],
	opts: MenuOptions = {},
): void {
	const open = openPopoverFor(anchor);
	if (open) {
		open.close();
		return;
	}
	openMenu(anchor, items(), opts);
}
