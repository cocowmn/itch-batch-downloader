// Admin sign-in (long-press on the library mark) and the admin API calls.
// The session is a cookie the server sets on sign-in; `checkAdmin` asks
// whether it is still valid (it is not after a server restart).

import type { AdminStatus } from "../../models/library.ts";
import { openDialog } from "./dialog.ts";
import { h } from "./dom.ts";
import { icon } from "./icons.ts";

/** Milliseconds a press has to last to count as a long press. */
const LONG_PRESS_MS = 600;

export class AdminError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** `fetch` for the admin endpoints: JSON in, JSON out, errors as AdminError. */
async function call<T>(
	url: string,
	init: RequestInit & { json?: unknown } = {},
): Promise<T> {
	const { json, ...rest } = init;
	let res: Response;
	try {
		res = await fetch(url, {
			...rest,
			headers: json !== undefined ? { "content-type": "application/json" } : {},
			body: json !== undefined ? JSON.stringify(json) : undefined,
		});
	} catch (err) {
		throw new AdminError(`No answer from the server: ${String(err)}`, 0);
	}
	if (!res.ok) {
		let message = `HTTP ${res.status}`;
		try {
			const body = (await res.json()) as { error?: unknown };
			if (typeof body.error === "string") message = body.error;
		} catch {
			// not JSON; keep the status
		}
		throw new AdminError(message, res.status);
	}
	return (await res.json()) as T;
}

export const adminApi = {
	status: () => call<AdminStatus>("/api/admin"),
	login: (password: string) =>
		call<{ ok: true }>("/api/admin/login", {
			method: "POST",
			json: { password },
		}),
	logout: () => call<{ ok: true }>("/api/admin/logout", { method: "POST" }),
	setHidden: (directory: string, hidden: boolean) =>
		call<{ ok: true; hidden: boolean }>(itemUrl(directory), {
			method: "PATCH",
			json: { hidden },
		}),
	deleteItem: (directory: string) =>
		call<{ ok: true }>(itemUrl(directory), { method: "DELETE" }),
};

function itemUrl(directory: string): string {
	return `/api/admin/item/${directory.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Call `onLongPress` when `el` is held for LONG_PRESS_MS. Moving away or
 * letting go earlier cancels; the context menu a phone would open on a long
 * press is suppressed so the dialog is what comes up.
 */
export function onLongPress(el: HTMLElement, onLongPress: () => void): void {
	let timer = 0;
	const cancel = () => {
		clearTimeout(timer);
		timer = 0;
	};
	el.addEventListener("pointerdown", (ev) => {
		if (ev.button !== 0) return;
		cancel();
		timer = window.setTimeout(() => {
			timer = 0;
			onLongPress();
		}, LONG_PRESS_MS);
	});
	for (const type of ["pointerup", "pointercancel", "pointerleave"] as const)
		el.addEventListener(type, cancel);
	el.addEventListener("contextmenu", (ev) => ev.preventDefault());
}

export interface AdminDialogContext {
	admin: boolean;
	enabled: boolean;
	onSignedIn(): void;
	onSignedOut(): void;
}

/** The dialog behind the long press: sign in, or sign out when already in. */
export function openAdminDialog(ctx: AdminDialogContext): void {
	if (ctx.admin) {
		openSignOutDialog(ctx);
		return;
	}
	if (!ctx.enabled) {
		const dialog = openDialog(
			{},
			icon("lock"),
			h("h2", {}, "Admin features are off"),
			h(
				"p",
				{ class: "dialog-text" },
				"Set ",
				h("code", {}, "admin_password"),
				" in the configuration file and restart the download browser to hide or delete items.",
			),
			h(
				"div",
				{ class: "dialog-actions" },
				h(
					"button",
					{ type: "button", class: "button", onclick: () => dialog.close() },
					"Close",
				),
			),
		);
		return;
	}

	const input = h("input", {
		type: "password",
		class: "dialog-input",
		placeholder: "Admin password",
		autocomplete: "current-password",
		autocapitalize: "off",
		spellcheck: "false",
		"aria-label": "Admin password",
	});
	const error = h("p", { class: "dialog-error", role: "alert" });
	const submit = h(
		"button",
		{ type: "submit", class: "button primary" },
		icon("lock"),
		"Sign in",
	);
	const form = h(
		"form",
		{
			class: "dialog-form",
			onsubmit: (ev: Event) => {
				ev.preventDefault();
				signIn();
			},
		},
		input,
		error,
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
	);
	const dialog = openDialog(
		{ focus: input },
		icon("lock"),
		h("h2", {}, "Admin sign-in"),
		h(
			"p",
			{ class: "dialog-text" },
			"Enter the ",
			h("code", {}, "admin_password"),
			" from the configuration file.",
		),
		form,
	);

	const setBusy = (busy: boolean) => {
		dialog.locked = busy;
		submit.disabled = busy;
		input.disabled = busy;
		submit.classList.toggle("busy", busy);
		submit.replaceChildren(icon(busy ? "loader-circle" : "lock"), "Sign in");
	};
	const signIn = async () => {
		if (submit.disabled) return;
		error.textContent = "";
		setBusy(true);
		try {
			await adminApi.login(input.value);
			dialog.close();
			ctx.onSignedIn();
		} catch (err) {
			setBusy(false);
			error.textContent =
				err instanceof AdminError ? err.message : "Sign-in failed.";
			input.focus();
			input.select();
		}
	};
}

function openSignOutDialog(ctx: AdminDialogContext): void {
	const signOut = h(
		"button",
		{
			type: "button",
			class: "button",
			onclick: async () => {
				dialog.locked = true;
				signOut.disabled = true;
				try {
					await adminApi.logout();
				} catch {
					// the cookie is gone either way once the page forgets it
				}
				dialog.close();
				ctx.onSignedOut();
			},
		},
		icon("log-out"),
		"Sign out",
	);
	const dialog = openDialog(
		{ focus: signOut },
		icon("shield-check"),
		h("h2", {}, "Signed in as admin"),
		h(
			"p",
			{ class: "dialog-text" },
			"Items can be hidden from the details panel and hidden items shown with the eye button in the top bar. The session ends when the browser or the server closes.",
		),
		h(
			"div",
			{ class: "dialog-actions" },
			h(
				"button",
				{ type: "button", class: "button", onclick: () => dialog.close() },
				"Close",
			),
			signOut,
		),
	);
}
