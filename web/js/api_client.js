/**
 * api_client.js
 *
 * Thin wrappers around the server routes (server/routes.py). Every
 * network call the frontend makes goes through here, so there is one
 * place that knows the URL shapes -- if routes.py's paths ever change,
 * this is the only file that needs updating.
 */

import { api, apiUrl } from "./dom_utils.js";

/**
 * Thumbnail cache-busters, keyed PER PROMPT.
 *
 * A prompt_ref is derived from name+prompt, so it only changes when the
 * prompt's identity does -- and a new ref is a URL the browser has never
 * seen, which it fetches fresh anyway. The one case that genuinely needs a
 * version bump is the SAME ref serving DIFFERENT pixels: replacing or
 * clearing a prompt's image while leaving its name and text alone.
 *
 * A single global counter bumped on every library refresh would rewrite the
 * URL of EVERY thumbnail on screen whenever one prompt is starred, throwing
 * away the browser's cached copy of the whole library and re-downloading
 * and re-decoding all of them at once -- a visible flash when toggling a
 * favorite. Per-prompt versions leave every unrelated <img> on a URL the
 * cache still answers instantly.
 *
 * Note: this map lives only in memory, so it cannot survive a page
 * reload -- and the reload case is exactly where a same-ref image swap
 * could otherwise reappear stale (bare URL, hard-cached old pixels). The
 * other half of correctness therefore lives in routes.py's image handler:
 * a ?v-keyed URL may be cached hard (the version pins the bytes), a bare
 * URL must revalidate. Client bump for the live session, server policy
 * for every session after it.
 */
const libraryImageVersions = new Map();
let libraryImageEpoch = 0;

/**
 * A monotonic counter, NOT a timestamp. Date.now() only has millisecond
 * resolution and these bumps arrive in bursts -- favouriting a prompt and
 * then pressing Rescan inside the same millisecond would hand back the
 * same value, the URL would not change, and the browser would keep serving
 * the stale picture. A counter cannot collide with itself, and because the
 * epoch draws from the same sequence it is always greater than every
 * version already handed out, so a rescan is guaranteed to move all URLs.
 *
 * It is SEEDED from the wall clock rather than starting at
 * 0 -- not for intra-session speed but for cross-session identity: the
 * ?v=N answers live in the browser cache for a day (immutable), while a
 * plain counter restarted every page load. Session #2's first image edit
 * would hand out exactly "?v=1" again -- the very URL session #1 had
 * already cached against the OLD pixels -- and the cache would answer it
 * instantly, so a replaced image would fail to update on first view.
 * Seeding past "now" makes every version this machine ever
 * issues strictly greater than anything an earlier session stored --
 * and MILLIsecond granularity, because a counter seeded per-second could
 * still hand a new page load (Ctrl+F5 inside the same second as the
 * previous load, with a save each) the exact URL the sibling session
 * cached. One wall-clock read per page load; monotonic within it.
 */
let libraryImageSeq = Date.now();
const nextVersion = () => ++libraryImageSeq;

// -- Library -----------------------------------------------------------

/**
 * Scan the library page by page, handing each page's entries to
 * `onPage` as they arrive, and resolve with the full accumulated list.
 *
 * This is the client half of the chunked-load seam: the UI can start
 * rendering (and the server can later start truly streaming its scan)
 * while this call is still in flight. Two shapes are accepted from the
 * server:
 *   - the paged object {"entries", "next_cursor", "total"} (current
 *     routes.py when page_size is supplied), and
 *   - a bare array -- what an older server answers any /library request
 *     with -- treated as a single final page so this never breaks.
 *
 * Entries are de-duplicated by prompt_ref across pages: a directory
 * that changes mid-paging (a rescan renaming files under us) can make
 * the server's page boundaries shift, and a ref seen twice must not
 * render twice.
 */
export async function scanLibraryPaged({ pageSize = 120, onPage, force = false } = {}) {
    const all = [];
    const seen = new Set();
    let cursor = null;
    // Hard page ceiling: 120 * 1000 entries of forward progress without
    // an end is a server bug, not a big library -- stop rather than loop
    // forever holding a half-populated panel open.
    for (let page = 0; page < 1000; page++) {
        const params = new URLSearchParams();
        params.set("page_size", String(pageSize));
        if (cursor !== null) params.set("cursor", String(cursor));
        else if (force) params.set("force", "1");
        const res = await api(`/library?${params.toString()}`);
        let entries;
        let next;
        if (Array.isArray(res)) {
            entries = res;
            next = null;
        } else {
            entries = (res && res.entries) || [];
            next = res ? res.next_cursor : null;
        }
        const fresh = [];
        for (const entry of entries) {
            if (!entry || seen.has(entry.prompt_ref)) continue;
            seen.add(entry.prompt_ref);
            all.push(entry);
            fresh.push(entry);
        }
        if (fresh.length && onPage) {
            try {
                await onPage(fresh);
            } catch (err) {
                console.error("Prompt Composer: library page handler failed", err);
            }
        }
        if (next === null || next === undefined) break;
        cursor = next;
    }
    return all;
}

function versionFor(promptRef) {
    return libraryImageVersions.get(promptRef) || libraryImageEpoch || "";
}

export function libraryImageUrl(promptRef) {
    const version = versionFor(promptRef);
    // Through apiUrl(), so the <img> resolves under a non-root base path
    // exactly as the fetch-based calls do.
    return apiUrl(`/library/${encodeURIComponent(promptRef)}/image${version ? `?v=${version}` : ""}`);
}

/** Re-fetch ONE prompt's thumbnail (a NEW version URL, always greater
 * than anything issued before). Callers that save a prompt bump
 * unconditionally -- one card re-fetching is cheap, and a conditional
 * bump is only as right as the caller's guess about which fields moved
 * image bytes. What must NEVER happen is bumping more than the touched
 * prompt: the old global-counter bump rewrote every thumbnail URL on
 * every refresh and that was the grid-wide flash. */
export function invalidateLibraryImage(promptRef) {
    if (promptRef) libraryImageVersions.set(promptRef, nextVersion());
}

/** Re-fetch every thumbnail. For the explicit "Rescan library folder"
 * button, where files may have been swapped out on disk underneath an
 * unchanged name -- a deliberate, user-initiated reload, so refetching the
 * whole grid is the point of it rather than a side effect. */
export function invalidateAllLibraryImages() {
    libraryImageEpoch = nextVersion();
    libraryImageVersions.clear();
}

/** Returns {exists: bool, entry: {...}|null} */
export function checkLibraryExists(name, prompt, excludePromptRef) {
    return api("/library/check_exists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, prompt, exclude_prompt_ref: excludePromptRef || null }),
    });
}

/**
 * Create a new prompt_data. `imageDataUrl` is a data: URL (from
 * fileToDataUrl or clipboard paste) or null/undefined for the default
 * 32x32 black thumbnail fallback. `folder` is an existing library
 * subfolder name (unprefixed, e.g. "Outfits") to create the prompt
 * directly inside; omit/null for the library root.
 */
export function createLibraryEntry({ name, prompt, category, imageDataUrl, folder }) {
    return api("/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            prompt,
            category: category || [],
            image_data_url: imageDataUrl || null,
            folder: folder || null,
        }),
    });
}

/**
 * Edit an existing prompt_data in place. Any of name/prompt/category/
 * imageDataUrl may be omitted (undefined) to leave that field
 * unchanged server-side. Pass clearImage: true to remove the image
 * (revert to the default black thumbnail). Pass `folder` (a plain,
 * unprefixed subfolder name, or "" for the library root) to MOVE the
 * prompt there; omit it (undefined) to leave the prompt wherever it
 * already lives.
 */
export function updateLibraryEntry(promptRef, { name, prompt, category, imageDataUrl, clearImage, folder }) {
    const body = {};
    if (name !== undefined) body.name = name;
    if (prompt !== undefined) body.prompt = prompt;
    if (category !== undefined) body.category = category;
    if (imageDataUrl !== undefined) body.image_data_url = imageDataUrl;
    if (clearImage !== undefined) body.clear_image = clearImage;
    if (folder !== undefined) body.folder = folder;

    return api(`/library/${encodeURIComponent(promptRef)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

export function deleteLibraryEntry(promptRef) {
    return api(`/library/${encodeURIComponent(promptRef)}`, { method: "DELETE" });
}

// -- Category identity (sidecar index; distinct from setLibraryCategory
// above, which only assigns/unassigns tags on one prompt_data) --------

export function listCategories({ withFolders = false } = {}) {
    // withFolders: also include one FOLDER-derived pseudo-category per
    // library subfolder (see server/library_store.py's
    // list_categories_with_folders) -- for the search toolbar's
    // dropdown, never for the "edit prompt" panel's tag picker (which
    // calls this with no arguments, i.e. the plain list).
    return api(withFolders ? "/categories?with_folders=1" : "/categories");
}

export function createCategory(name) {
    return api("/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
}

export function renameCategory(oldName, newName) {
    return api(`/categories/${encodeURIComponent(oldName)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
    });
}

export function deleteCategory(name) {
    return api(`/categories/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// -- Resolve -------------------------------------------------------------

/**
 * Resolve a batch of prompt_refs against the live library. Returns a
 * dict keyed by prompt_ref; refs that don't currently resolve are
 * simply absent from the result (per the "missing entry -> empty slot"
 * rule -- callers should treat an absent key as "this entry has no
 * content right now", not as an error).
 *
 * This is the SAME resolver Python's compose() uses at queue time
 * (library_store.resolve_many), so the live preview built from this
 * data can never disagree with the actual queued output.
 */
export function resolvePromptRefs(promptRefs) {
    if (!promptRefs.length) return Promise.resolve({});
    return api("/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_refs: promptRefs }),
    });
}

/**
 * Ask the server to run the node's OWN compose() against the given
 * state, returning the exact final prompt string plus the live library
 * resolution for every ref. This is what the live preview uses instead
 * of reproducing the assembly (and, crucially, the queue-time
 * randomization) in JS -- see ui_preview.js and
 * server/routes.py:/prompt_composer/compose. `fallbackContents` mirrors
 * compose's hidden composer_contents input (embedded workflow copies);
 * pass null/{} when there are none.
 */
export function composePreview({ sections, seed, userPrompt, fallbackContents }) {
    return api("/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            sections: sections || [],
            seed: seed || 0,
            user_prompt: userPrompt || "",
            fallback_contents: fallbackContents || {},
        }),
    });
}

/**
 * The literal string this node EMITTED when queued prompt
 * `promptId` executed (server stash -- see
 * prompt_composer_node.record_executed_output). Rejects like any api()
 * call on 404 ("never ran / history evicted / server restarted"), which
 * callers treat as the ordinary "no executed answer", NOT as an error.
 */
export function getExecutedOutput(promptId, nodeId, clientKey) {
    // clientKey disambiguates node ids across browser tabs (ids restart
    // at 1 in every workflow, so two tabs share addresses otherwise).
    // The server falls back to the bare node id when it is absent.
    const q = clientKey ? `?client_key=${encodeURIComponent(clientKey)}` : "";
    return api(`/last_output/${encodeURIComponent(promptId)}/${encodeURIComponent(nodeId)}${q}`);
}

/**
 * the executed-output diagnostics: {ok, recorded, entries[]} straight from the
 * server's executed-output stash (see server/routes.py c3_status).
 * Always 200, so it doubles as an endpoint-alive probe without
 * spraying a red 404 line through the console.
 */
export function getC3Status({ full = false } = {}) {
    // Prompt BODIES are opt-in server-side: the poll only needs
    // identity + timestamp to decide whether to adopt, and this route
    // is unauthenticated, so the full text is requested deliberately by
    // the one call that is about to use it.
    return api(full ? "/c3_status?full=1" : "/c3_status");
}

/** The installed node version, straight from Python's __version__. */
export function getVersion() {
    return api("/version");
}

// -- Presets ---------------------------------------------------------------

export function listPresets() {
    return api("/presets");
}

export function getPreset(filename) {
    return api(`/presets/${encodeURIComponent(filename)}`);
}

export function savePreset(name, sections) {
    return api("/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, sections }),
    });
}

export function renamePreset(filename, name) {
    return api(`/presets/${encodeURIComponent(filename)}/rename`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
}

export function deletePreset(filename) {
    return api(`/presets/${encodeURIComponent(filename)}`, { method: "DELETE" });
}
