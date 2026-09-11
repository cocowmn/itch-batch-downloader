// Small fuzzy matcher used by the download browser's filter box. No
// dependencies and no DOM so the same code runs in Bun and in the browser.

/**
 * Score how well `needle` matches `haystack` (both lower-cased by the caller).
 * 0 means no match. Substring matches score highest, then matches at word
 * starts, then plain in-order character matches with gaps.
 */
export function fuzzyScore(
	needle: string,
	haystack: string,
	exact = false,
): number {
	if (!needle) return 1;
	if (!haystack) return 0;

	const at = haystack.indexOf(needle);
	if (at !== -1) {
		let score = 100;
		if (haystack.length === needle.length) score += 50;
		if (at === 0 || isBoundary(haystack, at)) score += 30;
		return score - Math.min(haystack.length, 50) * 0.1;
	}
	if (exact) return 0;

	let score = 10;
	let h = 0;
	let previous = -2;
	for (const ch of needle) {
		const found = haystack.indexOf(ch, h);
		if (found === -1) return 0;
		if (found === previous + 1) score += 5;
		else if (found === 0 || isBoundary(haystack, found)) score += 8;
		else score -= Math.min(found - h, 10) * 0.5;
		previous = found;
		h = found + 1;
	}
	return Math.max(score, 1);
}

function isBoundary(text: string, index: number): boolean {
	const before = text[index - 1] ?? " ";
	return !/[a-z0-9]/i.test(before);
}

export interface SearchField {
	text: string;
	/** Multiplier applied to the field's score. */
	weight: number;
}

export interface QueryTerm {
	text: string;
	/** Quoted: must occur verbatim, no fuzzy matching. */
	exact: boolean;
}

/**
 * Split a query into terms: whitespace separates them, and anything inside
 * double quotes is one exact term with its spaces kept ("The DARK Series").
 * An unclosed quote runs to the end of the query.
 */
export function queryTerms(query: string): QueryTerm[] {
	const terms: QueryTerm[] = [];
	const re = /"([^"]*)"?|(\S+)/g;
	for (const m of query.matchAll(re)) {
		const quoted = m[1] !== undefined;
		const text = (m[1] ?? m[2] ?? "").trim();
		if (text) terms.push({ text, exact: quoted });
	}
	return terms;
}

export interface MatchOptions {
	caseSensitive?: boolean;
}

/**
 * Match every term of `query` (see queryTerms) against `fields`; each term
 * must match at least one field. Returns 0 when the query misses.
 */
export function matchQuery(
	query: string,
	fields: SearchField[],
	options: MatchOptions = {},
): number {
	const fold = (s: string) => (options.caseSensitive ? s : s.toLowerCase());
	const terms = queryTerms(query);
	if (terms.length === 0) return 1;
	let total = 0;
	for (const term of terms) {
		const needle = fold(term.text);
		let best = 0;
		for (const field of fields) {
			if (!field.text) continue;
			const s = fuzzyScore(needle, fold(field.text), term.exact) * field.weight;
			if (s > best) best = s;
		}
		if (best === 0) return 0;
		total += best;
	}
	return total;
}
