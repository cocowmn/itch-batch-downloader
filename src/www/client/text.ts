// Pure helpers of the viewer (no DOM): what a file is shown as, JSON
// highlighting and a small safe markdown renderer. Unit tested.

import type { LibraryFile } from "../../models/library.ts";

/** File extension without the dot, lower-cased. */
export function extension(name: string): string {
	const i = name.lastIndexOf(".");
	return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const VIDEO_EXT = new Set(["mp4", "webm", "ogv", "mov", "m4v"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"]);
const MARKDOWN_EXT = new Set(["md", "markdown"]);
const TEXT_EXT = new Set([
	"txt",
	"log",
	"nfo",
	"csv",
	"ini",
	"cfg",
	"yml",
	"yaml",
	"toml",
	"xml",
	"license",
	"readme",
]);
/** Text files above this are shown as a card instead of fetched. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export type ViewerMode =
	| "image"
	| "json"
	| "markdown"
	| "text"
	| "pdf"
	| "video"
	| "audio"
	| "card";

export function viewerMode(file: LibraryFile): ViewerMode {
	if (!file.url || file.kind === "folder") return "card";
	const ext = extension(file.name);
	if (IMAGE_EXT.has(ext)) return "image";
	if (ext === "pdf") return "pdf";
	if (VIDEO_EXT.has(ext)) return "video";
	if (AUDIO_EXT.has(ext)) return "audio";
	if (file.size > MAX_TEXT_BYTES) return "card";
	if (ext === "json") return "json";
	if (MARKDOWN_EXT.has(ext)) return "markdown";
	if (TEXT_EXT.has(ext) || file.kind === "code") return "text";
	return "card";
}

// ---------------------------------------------------------------------------
// JSON highlighting and a safe markdown subset (no library, works offline)

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const JSON_TOKEN =
	/("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;

/** Markup for pretty-printed JSON with `.j-key/.j-str/.j-num/.j-lit/.j-p` spans. */
export function highlightJson(text: string): string {
	let out = "";
	let last = 0;
	for (const m of text.matchAll(JSON_TOKEN)) {
		out += escapeHtml(text.slice(last, m.index));
		last = m.index + m[0].length;
		if (m[1] !== undefined) {
			const cls = m[2] !== undefined ? "j-key" : "j-str";
			out += `<span class="${cls}">${escapeHtml(m[1])}</span>${m[2] ?? ""}`;
		} else if (m[3] !== undefined) {
			out += `<span class="j-num">${m[3]}</span>`;
		} else if (m[4] !== undefined) {
			out += `<span class="j-lit">${m[4]}</span>`;
		} else {
			out += `<span class="j-p">${m[5]}</span>`;
		}
	}
	return out + escapeHtml(text.slice(last));
}

/** http(s)/mailto only, resolved against the document's folder; else null. */
function safeUrl(raw: string, base: string): string | null {
	try {
		const u = new URL(raw, base);
		if (
			u.protocol === "http:" ||
			u.protocol === "https:" ||
			u.protocol === "mailto:"
		)
			return u.href;
	} catch {
		// unparsable
	}
	return null;
}

function unescapeHtml(s: string): string {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}

/** Code spans are cut out before the other inline rules and put back after. */
const CODE_MARK = "\uE000";
const CODE_MARK_RE = /\uE000(\d+)\uE000/g;

/** Inline markdown over already-escaped text. */
function inlineMarkdown(escaped: string, base: string): string {
	const codes: string[] = [];
	let out = escaped.replace(/`([^`]+)`/g, (_, c: string) => {
		codes.push(`<code>${c}</code>`);
		return `${CODE_MARK}${codes.length - 1}${CODE_MARK}`;
	});
	out = out.replace(
		/!\[([^\]]*)\]\(([^)\s]+)\)/g,
		(_, alt: string, src: string) => {
			const u = safeUrl(unescapeHtml(src), base);
			return u
				? `<img src="${escapeHtml(u)}" alt="${alt}" loading="lazy">`
				: alt;
		},
	);
	out = out.replace(
		/\[([^\]]+)\]\(([^)\s]+)\)/g,
		(_, text: string, href: string) => {
			const u = safeUrl(unescapeHtml(href), base);
			return u
				? `<a href="${escapeHtml(u)}" target="_blank" rel="noreferrer">${text}</a>`
				: text;
		},
	);
	out = out
		.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
		.replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
		.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
		.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
	return out.replace(CODE_MARK_RE, (_, i: string) => codes[Number(i)] ?? "");
}

/**
 * Render a markdown subset to HTML: headings, paragraphs, lists, block
 * quotes, fenced/inline code, bold/italic, links and images. Raw HTML in
 * the source is shown as text. `base` resolves relative image/link paths.
 */
export function renderMarkdown(source: string, base: string): string {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let paragraph: string[] = [];
	let list: { tag: "ul" | "ol"; items: string[] } | null = null;
	let quote: string[] = [];

	const flushParagraph = () => {
		if (paragraph.length)
			out.push(
				`<p>${inlineMarkdown(escapeHtml(paragraph.join(" ")), base)}</p>`,
			);
		paragraph = [];
	};
	const flushList = () => {
		if (list)
			out.push(
				`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`,
			);
		list = null;
	};
	const flushQuote = () => {
		if (quote.length)
			out.push(
				`<blockquote><p>${inlineMarkdown(escapeHtml(quote.join(" ")), base)}</p></blockquote>`,
			);
		quote = [];
	};
	const flushAll = () => {
		flushParagraph();
		flushList();
		flushQuote();
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const fence = /^\s*```/.exec(line);
		if (fence) {
			flushAll();
			const code: string[] = [];
			for (i++; i < lines.length && !/^\s*```/.test(lines[i] ?? ""); i++)
				code.push(lines[i] ?? "");
			out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
			continue;
		}
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading) {
			flushAll();
			const level = heading[1]?.length ?? 1;
			out.push(
				`<h${level}>${inlineMarkdown(escapeHtml(heading[2] ?? ""), base)}</h${level}>`,
			);
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			flushAll();
			out.push("<hr>");
			continue;
		}
		const item = /^\s*(?:([-*+])|(\d+[.)]))\s+(.*)$/.exec(line);
		if (item) {
			flushParagraph();
			flushQuote();
			const tag = item[1] ? "ul" : "ol";
			if (!list || list.tag !== tag) {
				flushList();
				list = { tag, items: [] };
			}
			list.items.push(inlineMarkdown(escapeHtml(item[3] ?? ""), base));
			continue;
		}
		const quoted = /^\s*>\s?(.*)$/.exec(line);
		if (quoted) {
			flushParagraph();
			flushList();
			quote.push(quoted[1] ?? "");
			continue;
		}
		if (!line.trim()) {
			flushAll();
			continue;
		}
		if (list && /^\s{2,}/.test(line)) {
			// continuation of the previous list item
			list.items[list.items.length - 1] +=
				` ${inlineMarkdown(escapeHtml(line.trim()), base)}`;
			continue;
		}
		flushList();
		flushQuote();
		paragraph.push(line.trim());
	}
	flushAll();
	return out.join("\n");
}
