// The download_name template: where an item's directory goes inside the
// download directory. Parsed and validated once at start-up, resolved per item.

import type { Game } from "../../models/game.ts";
import type { ProductMetadata } from "../../models/manifest.ts";

export class DownloadNameError extends Error {}

export interface TokenSpec {
	name: string;
	description: string;
	/** Enough to tell items apart; at least one is required. */
	identifying?: boolean;
	/** Needs the product page (fetched before the item's files, then). */
	needsPage?: boolean;
	/** A list that accepts a separator: {tags:--}. */
	list?: boolean;
}

export const TOKENS: TokenSpec[] = [
	{ name: "title", description: "the item's title", identifying: true },
	{
		name: "slug",
		description:
			"the item's itch.io URL slug (the directory names of earlier versions)",
		identifying: true,
	},
	{ name: "author", description: "author slug, the x in x.itch.io" },
	{ name: "author_name", description: "author display name" },
	{
		name: "bundle",
		description: 'bundle the item was selected from ("library" otherwise)',
	},
	{
		name: "id",
		description: "numeric itch.io id",
		identifying: true,
		needsPage: true,
	},
	{ name: "category", description: "Assets, Game, Tool, ...", needsPage: true },
	{
		name: "tags",
		description: 'tags, joined with ", " or the separator given',
		needsPage: true,
		list: true,
	},
	{
		name: "genre",
		description: "genres, joined like tags",
		needsPage: true,
		list: true,
	},
	{
		name: "published",
		description: "publication date as yyyy-mm-dd",
		needsPage: true,
	},
	{
		name: "updated",
		description: "last update date as yyyy-mm-dd",
		needsPage: true,
	},
	{
		name: "index",
		description: "position in the run, padded to the width of the total",
		identifying: true,
	},
	{ name: "total", description: "number of items in the run" },
	{ name: "yyyy", description: "year the run started" },
	{ name: "yy", description: "two-digit year" },
	{ name: "mm", description: "month 01-12" },
	{ name: "dd", description: "day 01-31" },
	{ name: "hh", description: "hour 00-23" },
	{ name: "min", description: "minute 00-59" },
	{ name: "ss", description: "second 00-59" },
	{ name: "ms", description: "millisecond 000-999" },
	{ name: "date", description: "yyyy-mm-dd" },
	{ name: "time", description: "hh-min-ss" },
];

const TOKEN_BY_NAME = new Map(TOKENS.map((t) => [t.name, t]));
const DEFAULT_SEPARATOR = ", ";
/** Characters that no file system segment may contain (besides the "/" separator). */
const INVALID_CHARS = /[\\:*?"<>|\p{Cc}]/u;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_SEGMENT_LENGTH = 120;

type Part = { literal: string } | { token: TokenSpec; separator: string };

function invalid(source: string, why: string): never {
	throw new DownloadNameError(`download_name = "${source}": ${why}`);
}

export interface DownloadName {
	source: string;
	/** Template segments (one per directory level), each a list of parts. */
	segments: Part[][];
	tokens: Set<string>;
	needsPage: boolean;
}

/**
 * Parse and validate a download_name template. Throws DownloadNameError with
 * a message that explains what is wrong.
 */
export function parseDownloadName(source: string): DownloadName {
	const fail = (why: string): never => invalid(source, why);
	const template = source.trim();
	if (!template) fail("must not be empty");
	if (/^([a-zA-Z]:|[/\\~])/.test(template))
		fail("must be a relative path inside download_directory");

	const tokens = new Set<string>();
	const segments: Part[][] = [];
	for (const [i, seg] of template.split("/").entries()) {
		if (!seg) {
			fail(
				i === 0 || i === template.split("/").length - 1
					? 'must not start or end with "/"'
					: 'contains an empty directory name ("//")',
			);
		}
		const parts: Part[] = [];
		let literal = "";
		for (let pos = 0; pos < seg.length; ) {
			const ch = seg[pos] ?? "";
			if (ch === "}") fail(`unexpected "}" in "${seg}"`);
			if (ch !== "{") {
				literal += ch;
				pos++;
				continue;
			}
			const end = seg.indexOf("}", pos);
			if (end === -1) fail(`missing "}" after "${seg.slice(pos)}"`);
			const inner = seg.slice(pos + 1, end);
			const m = /^([a-z_]+)(?::(.*))?$/s.exec(inner);
			const tokenName = m?.[1];
			if (!tokenName) return fail(`"{${inner}}" is not a valid token`);
			const spec = TOKEN_BY_NAME.get(tokenName);
			if (!spec) {
				return fail(
					`unknown token {${tokenName}}. Supported: ${TOKENS.map((t) => `{${t.name}}`).join(" ")}`,
				);
			}
			const explicitSeparator = m?.[2];
			if (explicitSeparator !== undefined && !spec.list)
				fail(`{${spec.name}} does not take a separator ({${inner}})`);
			const separator = explicitSeparator ?? DEFAULT_SEPARATOR;
			if (INVALID_CHARS.test(separator) || separator.includes("/"))
				fail(
					`the separator in {${inner}} contains a character not allowed in file names`,
				);
			if (literal) parts.push({ literal });
			literal = "";
			parts.push({ token: spec, separator });
			tokens.add(spec.name);
			pos = end + 1;
		}
		if (literal) parts.push({ literal });

		const literals = parts
			.map((p) => ("literal" in p ? p.literal : ""))
			.join("");
		if (literals.includes("\\"))
			fail('use "/" to separate directories, "\\" is not allowed');
		if (INVALID_CHARS.test(literals))
			fail(
				`"${seg}" contains a character not allowed in file names (\\ : * ? " < > |)`,
			);
		if (parts.every((p) => "literal" in p)) {
			if (/^\.\.?$/.test(literals))
				fail(`"${seg}" is not a safe directory name`);
			if (/[. ]$/.test(literals))
				fail(`"${seg}" must not end with a dot or a space`);
		}
		segments.push(parts);
	}

	if (![...tokens].some((t) => TOKEN_BY_NAME.get(t)?.identifying)) {
		fail(
			`needs at least one identifying token so items do not overwrite each other: ${TOKENS.filter(
				(t) => t.identifying,
			)
				.map((t) => `{${t.name}}`)
				.join(", ")}`,
		);
	}

	return {
		source: template,
		segments,
		tokens,
		needsPage: [...tokens].some((t) => TOKEN_BY_NAME.get(t)?.needsPage),
	};
}

/** Non-fatal observations about a template, for the log. */
export function downloadNameWarnings(name: DownloadName): string[] {
	const warnings: string[] = [];
	if (!name.tokens.has("title") && !name.tokens.has("slug")) {
		warnings.push(
			`download_name = "${name.source}" does not include {title} or {slug}; directories will be hard to tell apart by name.`,
		);
	}
	const volatile = [...name.tokens].filter((t) =>
		[
			"index",
			"total",
			"yyyy",
			"yy",
			"mm",
			"dd",
			"hh",
			"min",
			"ss",
			"ms",
			"date",
			"time",
		].includes(t),
	);
	if (volatile.length) {
		warnings.push(
			`download_name uses ${volatile.map((t) => `{${t}}`).join(", ")}, which change between runs: a re-run downloads into new directories instead of skipping files that already exist.`,
		);
	}
	return warnings;
}

export interface NameContext {
	game: Game;
	/** 1-based position in the run. */
	index: number;
	total: number;
	runStarted: Date;
	/** Product page metadata; required when the template needs it. */
	page?: ProductMetadata | null;
}

/**
 * Make a value usable as one path segment: strip characters file systems
 * reject, collapse whitespace, avoid names Windows reserves, cap the length.
 */
export function safeSegment(value: string, fallback: string): string {
	let s = value
		.normalize("NFC")
		.replace(/[/\\:*?"<>|]/g, "-")
		.replace(/\p{Cc}/gu, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[. ]+|[. ]+$/g, "");
	if (s.length > MAX_SEGMENT_LENGTH)
		s = s.slice(0, MAX_SEGMENT_LENGTH).replace(/[. ]+$/g, "");
	if (!s) return fallback;
	if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
	return s;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** "Dec 11, 2020" (itch.io info panel) -> "2020-12-11", or null. */
export function parseItchDate(text: string | undefined): string | null {
	if (!text) return null;
	const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
	if (!m) return null;
	const month =
		[
			"jan",
			"feb",
			"mar",
			"apr",
			"may",
			"jun",
			"jul",
			"aug",
			"sep",
			"oct",
			"nov",
			"dec",
		].indexOf((m[1] ?? "").toLowerCase()) + 1;
	if (!month || !m[2] || !m[3]) return null;
	return `${m[3]}-${pad(month)}-${pad(Number(m[2]))}`;
}

function tokenValue(
	spec: TokenSpec,
	separator: string,
	ctx: NameContext,
): string {
	const { game, runStarted: d } = ctx;
	const page = ctx.page ?? null;
	const list = (items: string[], fallback: string) =>
		items.length
			? items
					.map((t) => safeSegment(t, ""))
					.filter(Boolean)
					.join(separator)
			: fallback;
	switch (spec.name) {
		case "title":
			return game.title || game.itchSlug;
		case "slug":
			return game.itchSlug;
		case "author":
			return game.author || "unknown-author";
		case "author_name":
			return game.authorName || game.author || "unknown-author";
		case "bundle":
			return game.bundles?.[0]?.name || "library";
		case "id":
			return page?.itchId !== null && page?.itchId !== undefined
				? String(page.itchId)
				: "unknown-id";
		case "category":
			return page?.info.Category || "uncategorised";
		case "tags":
			return list(page?.tags ?? [], "untagged");
		case "genre":
			return list(
				(page?.info.Genre ?? "")
					.split(",")
					.map((g) => g.trim())
					.filter(Boolean),
				"no-genre",
			);
		case "published":
			return parseItchDate(page?.info.Published) ?? "unknown-date";
		case "updated":
			return parseItchDate(page?.info.Updated) ?? "unknown-date";
		case "index":
			return pad(ctx.index, String(ctx.total).length);
		case "total":
			return String(ctx.total);
		case "yyyy":
			return String(d.getFullYear());
		case "yy":
			return pad(d.getFullYear() % 100);
		case "mm":
			return pad(d.getMonth() + 1);
		case "dd":
			return pad(d.getDate());
		case "hh":
			return pad(d.getHours());
		case "min":
			return pad(d.getMinutes());
		case "ss":
			return pad(d.getSeconds());
		case "ms":
			return pad(d.getMilliseconds(), 3);
		case "date":
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		case "time":
			return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
		default:
			return "";
	}
}

/**
 * Resolve the template for one item into a relative path ("/"-separated).
 * Every token value is made file-system safe, so the result can never leave
 * download_directory. Throws DownloadNameError if a segment still ends up
 * unusable.
 */
export function resolveDownloadName(
	name: DownloadName,
	ctx: NameContext,
): string {
	if (name.needsPage && !ctx.page) {
		throw new DownloadNameError(
			`download_name = "${name.source}" needs the product page of "${ctx.game.title}", which could not be loaded`,
		);
	}
	const segments = name.segments.map((parts) => {
		const raw = parts
			.map((p) =>
				"literal" in p
					? p.literal
					: safeSegment(tokenValue(p.token, p.separator, ctx), "unknown"),
			)
			.join("");
		return safeSegment(raw, "");
	});
	for (const seg of segments) {
		if (!seg || seg === "." || seg === "..") {
			throw new DownloadNameError(
				`download_name = "${name.source}" produced an unusable directory name for "${ctx.game.title}" (${segments.map((s) => JSON.stringify(s)).join("/")})`,
			);
		}
	}
	return segments.join("/");
}
