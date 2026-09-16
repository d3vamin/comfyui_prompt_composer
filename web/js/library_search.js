/**
 * library_search.js -- the Library query engine (round 34).
 *
 * Everything about WHICH prompts a search text selects, in what order,
 * and how the hits are rendered lives here as pure functions. The DOM
 * side (ComposerUI.filterLibraryEntries) only APPLIES a result:
 * show/hide, reorder, highlight, count.
 *
 * Matching is WORD-AND (round 34, replacing the single substring):
 * every whitespace-separated token must appear somewhere in the
 * entry's haystack (name + categories + prompt, case-folded). So
 * "red hair" finds "red-haired small cat" -- the old one-blob
 * substring could not, because the typed words are never adjacent in
 * the text. Phrases ("quoted") are deliberately absent: nothing asks
 * for them yet; tokens are all the vocabulary that matters.
 *
 * Ranking is weighted per token: name hit > category hit > prompt hit
 * (a prompt NAMED "cat" outranks fifty that merely mention one), with
 * a prefix bonus, and ties fall back to the alphabetical order the
 * grid is built in (Array.sort is stable, so feeding it the already
 * alphabetical structural list does the work). An empty query means
 * no relevance mode at all: order and highlighting stay exactly as
 * built.
 */

export const WEIGHTS = { name: 6, namePrefix: 2, category: 3, prompt: 1 };

export function tokenize(query) {
    return (query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** The lowercase haystack a row's `dataset.searchText` must mirror --
 * single definition so the DOM stamp and the scorer can never drift. */
export function searchBlob(entry) {
    return `${entry.name || ""} ${(entry.category || []).join(" ")} ${entry.prompt || ""}`
        .toLowerCase();
}

/**
 * Section-entry variant (round 35): a section row displays a LIBRARY
 * prompt (resolved `display`) or a dead pointer, and the prompt_ref
 * itself stays searchable -- it is the only place the UID half of the
 * name survives, and the uid is what a "(Missing)" tooltip shows.
 * Unresolved rows search on the ref alone, exactly as before.
 */
export function sectionSearchBlob(entry, display) {
    if (!display) return String(entry.prompt_ref || "").toLowerCase();
    return (`${display.name || ""} ${(display.category || []).join(" ")} ` +
        `${display.prompt || ""} ${entry.prompt_ref || ""}`).toLowerCase();
}
/**
 * Word-AND over one entry. `null` = does not match (some token hit
 * nothing at all); otherwise the summed per-token weight.
 */
export function scoreEntry(entry, tokens) {
    if (!tokens.length) return { score: 0 };
    const name = (entry.name || "").toLowerCase();
    const cats = (entry.category || []).join(" ").toLowerCase();
    const prompt = (entry.prompt || "").toLowerCase();
    let score = 0;
    for (const token of tokens) {
        let hit = 0;
        if (name.includes(token)) {
            hit += WEIGHTS.name + (name.startsWith(token) ? WEIGHTS.namePrefix : 0);
        }
        if (cats.includes(token)) hit += WEIGHTS.category;
        if (prompt.includes(token)) hit += WEIGHTS.prompt;
        if (!hit) return null; // AND: one unmapped token ends the entry
        score += hit;
    }
    return { score };
}

/**
 * Rank the structural list for a query.
 * @returns {{tokens: string[], matched: Set<string>|null,
 *            orderedRefs: string[]|null, scores: Map<string,number>}}
 *   `matched` answers "does this ref pass the text filter"; `scores`
 *   carries each matched ref's weight (the DOM side turns it into a
 *   CSS `order` integer); `orderedRefs` is the same list in final
 *   display order. All of them are null when the query is empty --
 *   callers then leave order and highlight exactly as built.
 */
export function rankEntries(entries, query) {
    const tokens = tokenize(query);
    if (!tokens.length) {
        return { tokens, matched: null, orderedRefs: null, scores: new Map() };
    }
    const scored = [];
    const scores = new Map();
    for (const entry of entries) {
        const r = scoreEntry(entry, tokens);
        if (!r) continue;
        scores.set(entry.prompt_ref, r.score);
        scored.push({ ref: entry.prompt_ref, score: r.score });
    }
    scored.sort((a, b) => b.score - a.score); // stable: equal score keeps alphabetical
    return {
        tokens,
        matched: new Set(scored.map((s) => s.ref)),
        orderedRefs: scored.map((s) => s.ref),
        scores,
    };
}

export function escapeHTML(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * HTML for `text` with every occurrence of every token wrapped in
 * <mark class="pc-search-hit">; returns null when nothing in THIS
 * string matched (the caller then keeps the plain text node -- a
 * prompt-only match leaves the name unhighlighted, and that is the
 * truth). Ranges from different tokens merge when they overlap or
 * touch, so "ca"+"cat" in "cat" marks once.
 */
export function highlightHTML(text, tokens) {
    if (!tokens.length || !text) return null;
    const lower = String(text).toLowerCase();
    const ranges = [];
    for (const token of tokens) {
        let from = 0;
        for (;;) {
            const at = lower.indexOf(token, from);
            if (at === -1) break;
            ranges.push([at, at + token.length]);
            from = at + token.length;
        }
    }
    if (!ranges.length) return null;
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [ranges[0].slice()];
    for (let i = 1; i < ranges.length; i++) {
        const last = merged[merged.length - 1];
        const [s, e] = ranges[i];
        if (s <= last[1]) last[1] = Math.max(last[1], e);
        else merged.push([s, e]);
    }
    let html = "";
    let cursor = 0;
    for (const [s, e] of merged) {
        html += escapeHTML(text.slice(cursor, s));
        html += `<mark class="pc-search-hit">${escapeHTML(text.slice(s, e))}</mark>`;
        cursor = e;
    }
    return html + escapeHTML(text.slice(cursor));
}
