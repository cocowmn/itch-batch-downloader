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

export interface PromptOptions {
	title: string;
	message?: Child[];
	/** Initial value of the field. */
	value: string;
	/** Text after the field, e.g. an extension the value gets. */
	suffix?: string;
	confirmLabel: string;
	icon?: HTMLElement;
}

/** Ask for a line of text; resolves with it, or null when cancelled. */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
	return new Promise((done) => {
		let answer: string | null = null;
		const input = h("input", {
			type: "text",
			class: "dialog-input",
			value: opts.value,
			autocomplete: "off",
			autocapitalize: "off",
			spellcheck: "false",
			"aria-label": opts.title,
		});
		const submit = h(
			"button",
			{ type: "submit", class: "button primary" },
			opts.confirmLabel,
		);
		const dialog = openDialog(
			{ focus: input, onClose: () => done(answer) },
			opts.icon ?? null,
			h("h2", {}, opts.title),
			opts.message ? h("p", { class: "dialog-text" }, ...opts.message) : null,
			h(
				"form",
				{
					class: "dialog-form",
					onsubmit: (ev: Event) => {
						ev.preventDefault();
						if (!input.value.trim()) {
							input.focus();
							return;
						}
						answer = input.value.trim();
						dialog.close();
					},
				},
				h(
					"div",
					{ class: "dialog-field" },
					input,
					opts.suffix
						? h("span", { class: "dialog-suffix" }, opts.suffix)
						: null,
				),
				h(
					"div",
					{ class: "dialog-actions" },
					h(
						"button",
						{ type: "button", class: "button", onclick: () => dialog.close() },
						"Cancel",
					),
					submit,
				),
			),
		);
		input.select();
	});
}

/**
 * Show `text` in a box the user can copy from, for when the clipboard API
 * is not available (a plain-http page on the network) or refused.
 */
export function copyFallbackDialog(title: string, text: string): void {
	const area = h("textarea", {
		class: "dialog-textarea",
		readonly: true,
		spellcheck: "false",
		"aria-label": title,
	});
	area.value = text;
	const copy = h(
		"button",
		{
			type: "button",
			class: "button primary",
			onclick: () => {
				area.focus();
				area.select();
				// The one way left that works without a secure context.
				const ok = document.execCommand("copy");
				copy.replaceChildren(ok ? "Copied" : "Select and copy by hand");
			},
		},
		"Copy",
	);
	const dialog = openDialog(
		{ focus: copy },
		h("h2", {}, title),
		area,
		h(
			"div",
			{ class: "dialog-actions" },
			h(
				"button",
				{ type: "button", class: "button", onclick: () => dialog.close() },
				"Close",
			),
			copy,
		),
	);
}
