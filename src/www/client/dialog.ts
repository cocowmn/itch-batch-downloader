// A small modal: a card in the middle of a blurred overlay. Esc or the
// backdrop closes it (unless `locked`, while a request is in flight). While
// it is open the rest of the page is `inert`: no clicks, no focus, no keys,
// hidden from assistive technology; focus returns where it was on close.

import { type Child, h } from "./dom.ts";

export interface Dialog {
	/** The card, for adding content and finding controls. */
	card: HTMLElement;
	close(): void;
	/** While locked, Esc and the backdrop do nothing (a request is running). */
	locked: boolean;
}

export interface DialogOptions {
	/** Extra class on the overlay, e.g. "danger". */
	class?: string;
	/** Focus this element once the dialog is shown. */
	focus?: HTMLElement;
	onClose?: () => void;
}

export function openDialog(opts: DialogOptions, ...children: Child[]): Dialog {
	const card = h("div", { class: "dialog-card" }, ...children);
	const overlay = h(
		"div",
		{
			class: `dialog${opts.class ? ` ${opts.class}` : ""}`,
			role: "dialog",
			"aria-modal": "true",
		},
		card,
	);
	// Everything else on the page, except what an outer dialog already froze.
	const frozen = [...document.body.children].filter(
		(el): el is HTMLElement => el instanceof HTMLElement && !el.inert,
	);
	const previouslyFocused =
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	const dialog: Dialog = {
		card,
		locked: false,
		close() {
			if (!overlay.isConnected) return;
			overlay.remove();
			for (const el of frozen) el.inert = false;
			document.removeEventListener("keydown", onKey, true);
			previouslyFocused?.focus();
			opts.onClose?.();
		},
	};
	const onKey = (ev: KeyboardEvent) => {
		if (ev.key !== "Escape") return;
		ev.stopPropagation();
		if (!dialog.locked) dialog.close();
	};
	overlay.addEventListener("click", (ev) => {
		if (ev.target === overlay && !dialog.locked) dialog.close();
	});
	// Capture phase so the page's own Esc handling never sees the key.
	document.addEventListener("keydown", onKey, true);
	for (const el of frozen) el.inert = true;
	document.body.append(overlay);
	(opts.focus ?? card.querySelector<HTMLElement>("button"))?.focus();
	return dialog;
}

export interface ConfirmOptions {
	title: string;
	message: Child[];
	confirmLabel: string;
	/** Red confirm button. */
	danger?: boolean;
	icon?: HTMLElement;
}

/** Ask a yes/no question; resolves with the answer. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
	return new Promise((done) => {
		let answer = false;
		const confirm = h(
			"button",
			{
				type: "button",
				class: `button${opts.danger ? " danger" : " primary"}`,
				onclick: () => {
					answer = true;
					dialog.close();
				},
			},
			opts.confirmLabel,
		);
		const dialog = openDialog(
			{
				class: opts.danger ? "danger" : "",
				focus: confirm,
				onClose: () => done(answer),
			},
			opts.icon ?? null,
			h("h2", {}, opts.title),
			h("p", { class: "dialog-text" }, ...opts.message),
			h(
				"div",
				{ class: "dialog-actions" },
				h(
					"button",
					{ type: "button", class: "button", onclick: () => dialog.close() },
					"Cancel",
				),
				confirm,
			),
		);
	});
}
