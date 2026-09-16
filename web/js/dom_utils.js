/**
 * dom_utils.js
 *
 * Generic DOM/element/fetch helpers with no composer-specific
 * knowledge. Extracted verbatim (behavior unchanged) from the
 * original single-file prompt_composer.js.
 */

export const API_BASE = "/prompt_composer";

export function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Deterministically hash a string to an index in [0, length). Used to
 * derive a stable "random" pick for the live preview from a seed +
 * section id, so the same inputs always produce the same index rather
 * than a fresh Math.random() roll on every render.
 */
export function hashStringToIndex(str, length) {
    if (length <= 0) return 0;
    // FNV-1a accumulation...
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    // ...followed by a MurmurHash3-style finalizer (fmix32) to spread
    // entropy across every bit of the hash before reducing it to a
    // pool index. This matters a lot for SMALL pools: reducing straight
    // to `hash % 2` (a pool of 2 entries) only looks at the hash's
    // lowest bit, and a plain polynomial/FNV-1a accumulation does not
    // reliably randomize that bit. The finalizer avalanches the hash so
    // a 1-bit reduction is no longer correlated with the input's
    // structure, restoring proper per-section independence.
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return Math.abs(h) % length;
}

/**
 * Shared drag-and-drop wiring for reorderable rows/cards (sections,
 * grid entry cards, list entry rows). One implementation covers both the
 * single-item case (a section row) and the multi-item case (a bulk-selected
 * set of entry cards), so grid and list views and same-section reorder all
 * run through the same code. Provides two pieces of visual feedback, kept
 * deliberately simple (pure CSS classes + minimal state, no animation
 * library):
 *
 *  - the element being dragged gets a "pc-dragging" class (lifted with a
 *    shadow via CSS) for the duration of the drag.
 *  - the element currently under the cursor gets a thin insertion-line
 *    indicator on its top or bottom edge (via "pc-drag-over-top" /
 *    "pc-drag-over-bottom" classes), depending on which half of the
 *    target the cursor is over -- but ONLY while a drag of THIS
 *    element's own `dragType` is in progress, so an unrelated drag
 *    (a library prompt, a cross-section entry set) passing over never
 *    paints a misleading insertion line here.
 *
 * @param {HTMLElement} el - the draggable element (also its own drop target)
 * @param {object} opts
 * @param {string} opts.dragType - MIME type this reorder reads/writes
 * @param {() => string[]} opts.getDragIds - ids this element carries when
 *   dragged (a section returns [id]; an entry returns the selected set, or
 *   just itself when unselected). Serialised to JSON in the payload.
 * @param {() => string} opts.getSelfId - this element's own id, used to
 *   ignore a drop that lands on a member of its own drag set (a no-op).
 * @param {(el) => number} opts.getIndex - current index of a target element
 *   within its list, used to compute the insertion point (above vs below).
 * @param {(ids, targetIndex) => void} opts.onDrop - commit the move
 * @param {boolean} [opts.vertical=true] - split target top/bottom (list) vs
 *   left/right (grid) for the before/after decision
 * @param {string} [opts.effectAllowed="move"] - "copyMove" when the same
 *   drag also carries a copy payload another target can accept
 * @param {(e) => void} [opts.onDragStart] - extra dragstart wiring, run
 *   after this helper has set its own payload (used by entry cards to also
 *   publish the cross-section copy/move payload from the SAME dragstart,
 *   so one drag sets every MIME type any target might read)
 */
export function wireDragReorder(el, { dragType, getDragIds, getSelfId, getIndex, onDrop, vertical = true, effectAllowed = "move", onDragStart }) {
    el.draggable = true;

    el.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData(dragType, JSON.stringify(getDragIds()));
        // "move" is correct for reorder-only elements (section rows). An
        // entry card ALSO carries a cross-section copy payload that a
        // section row accepts with dropEffect="copy"; effectAllowed must
        // include "copy" or the browser silently refuses to fire "drop"
        // on that target -- so entry cards pass "copyMove".
        e.dataTransfer.effectAllowed = effectAllowed;
        if (onDragStart) onDragStart(e);
        requestAnimationFrame(() => el.classList.add("pc-dragging"));
    });

    el.addEventListener("dragend", () => {
        el.classList.remove("pc-dragging", "pc-drag-over-top", "pc-drag-over-bottom");
    });

    el.addEventListener("dragover", (e) => {
        if (!e.dataTransfer || !e.dataTransfer.types.includes(dragType)) return;
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const isBefore = vertical
            ? e.clientY - rect.top < rect.height / 2
            : e.clientX - rect.left < rect.width / 2;
        el.classList.toggle("pc-drag-over-top", isBefore);
        el.classList.toggle("pc-drag-over-bottom", !isBefore);
    });

    el.addEventListener("dragleave", () => {
        el.classList.remove("pc-drag-over-top", "pc-drag-over-bottom");
    });

    el.addEventListener("drop", (e) => {
        if (!e.dataTransfer) return;
        const raw = e.dataTransfer.getData(dragType);
        if (!raw) return;
        let ids;
        try {
            ids = JSON.parse(raw);
        } catch (_) {
            return;
        }
        if (!Array.isArray(ids) || !ids.length) return;
        // This is our drag -- claim the drop so the browser / ComfyUI don't
        // ALSO act on it. Without preventDefault a prompt PNG dragged over
        // the canvas loads as a workflow (and clobbers the reorder).
        e.preventDefault();
        // Read the insertion side BEFORE clearing the indicator classes --
        // once they're gone "pc-drag-over-top" is always false and every drop
        // lands AFTER the target, so nothing can ever reach the top.
        const droppedBefore = el.classList.contains("pc-drag-over-top");
        el.classList.remove("pc-drag-over-top", "pc-drag-over-bottom");
        // Dropping the dragged set onto one of its own members is a no-op.
        if (ids.includes(getSelfId())) return;
        let targetIndex = getIndex(el);
        if (!droppedBefore) targetIndex += 1;
        onDrop(ids, targetIndex);
    });
}

export function el(tag, className, attrs) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (k === "text") node.textContent = v;
            else if (k.startsWith("on") && typeof v === "function") {
                node.addEventListener(k.slice(2), v);
            } else {
                node.setAttribute(k, v);
            }
        }
    }
    return node;
}

export async function api(path, opts) {
    const res = await fetch(API_BASE + path, opts);
    if (!res.ok) {
        let msg = res.statusText;
        try {
            const body = await res.json();
            msg = body.error || msg;
        } catch (_) {}
        throw new Error(msg);
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) return res.json();
    return null;
}

export function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * Preserves scroll position across a full panel re-render (tear down
 * + rebuild the DOM subtree, as this app's render() does throughout).
 *
 * Replaces an earlier, more fragile approach that snapshotted
 * `scrollTop` keyed by `${panelName}.${element.className}.${index}`
 * and restored it onto whatever element(s) matched that same key
 * after the rebuild. That broke silently whenever:
 *   - the "scrollable" element wasn't actually the panel root itself
 *     (several panels use `overflow: hidden` on their own root and
 *     put the real `overflow-y: auto` scrollbar on an inner child --
 *     capturing `panelRoot.scrollTop` there is always 0, a no-op)
 *   - the rebuilt content is populated ASYNCHRONOUSLY (e.g. the entry
 *     grid resolves prompt_ref -> display data over the network before
 *     filling itself in) -- restoring before that content exists is a
 *     guaranteed no-op, since an empty container has nothing to
 *     scroll to and the browser clamps scrollTop back to 0
 *   - the element's className changed between the two renders (e.g.
 *     toggling grid/list view), silently breaking the key match
 *
 * This version fixes all three by:
 *   1. Being told explicitly which element is the ACTUAL scroll
 *      container for each named region (`getScrollEl` -- a function
 *      that returns the live scrolling element, rather than guessing
 *      from a CSS selector), so root-vs-child mismatches can't happen.
 *   2. Storing scroll position as a FRACTION of `scrollHeight` (not an
 *      absolute pixel offset), so it survives minor content-height
 *      changes across the rebuild gracefully rather than needing an
 *      exact pixel match.
 *   3. Applying the snapshot IMMEDIATELY (synchronously, in the same
 *      task as the DOM rebuild -- see `restore()`), and then again
 *      after a double `requestAnimationFrame`, which guarantees the
 *      browser has completed layout for whatever synchronous DOM
 *      changes were just made before we read/write scroll positions --
 *      and callers additionally re-invoke `restore()` after any async
 *      content-fill promise resolves, for panels that populate
 *      themselves progressively (see ComposerUI.render()'s use of this
 *      class).
 *
 * Why the immediate pass matters (this is what kills the visible
 * "scroll jumps to the top and snaps back" flicker): a rebuilt scroll
 * container is a BRAND-NEW element, so it starts at scrollTop 0. When
 * the restore only happened inside `requestAnimationFrame`, the browser
 * got one or two paint opportunities in between -- enough to actually
 * draw a frame at the top of the list before the deferred pass put the
 * scroll back where it belonged. Setting `scrollTop` synchronously
 * right after the DOM was swapped happens before the next paint, so
 * that intermediate frame is never drawn at all. Reading `scrollHeight`
 * in the process forces the one layout pass we need, which is exactly
 * what the deferred rAF passes were paying for anyway.
 *
 * Usage: construct once, call `capture(regions)` at the START of a
 * render (before tearing down DOM), then call `restore()` any number
 * of times afterward (each call is safe/idempotent -- it just
 * reapplies the same captured snapshot to whatever the region's
 * `getScrollEl` currently returns).
 */
export class ScrollPreserver {
    constructor() {
        this._snapshot = null;
        // Regions flagged `persist` keep their captured position across
        // renders (merged here, never cleared by capture), so a view that is
        // momentarily OFF-SCREEN -- e.g. the browse grid/list while an edit
        // panel is open -- still has its scroll remembered for when it comes
        // back. Non-persistent regions live only in the per-render snapshot.
        this._persistent = {};
    }

    /**
     * @param {Record<string, (() => HTMLElement | null) | {
     *   getScrollEl: () => HTMLElement | null, persist?: boolean }>} regions
     *   map of region name -> either the scroll-container getter (legacy,
     *   non-persistent) or `{ getScrollEl, persist }`. A region's getter is
     *   called live, so a persistent region keeps working after the DOM is
     *   rebuilt underneath it (it re-queries for the current element).
     */
    capture(regions) {
        const snapshot = {};
        for (const [name, def] of Object.entries(regions)) {
            const { getScrollEl, persist } = typeof def === "function"
                ? { getScrollEl: def, persist: false }
                : def;
            const scrollEl = getScrollEl();
            // Element not on screen this render: a persistent region keeps
            // its last captured position (that is the point -- it must be
            // there to restore when the view returns); a per-render region
            // simply has nothing to record.
            if (!scrollEl) continue;
            const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
            const entry = {
                getScrollEl,
                fraction: maxScroll > 0 ? scrollEl.scrollTop / maxScroll : 0,
                // Also keep the raw pixel value: when the rebuilt content's
                // height comes out identical (the common case -- same items,
                // nothing added/removed), applying the exact pixel offset is
                // more precise than a fraction recomputed against a
                // `scrollHeight` that may have been measured a frame apart
                // with subpixel rounding differences.
                pixels: scrollEl.scrollTop,
                hadOverflow: maxScroll > 0,
            };
            if (persist) this._persistent[name] = entry;
            else snapshot[name] = entry;
        }
        this._snapshot = snapshot;
    }

    /**
     * Re-point a PERSISTENT region's remembered position between
     * captures. The apply passes read the entry live, so an override
     * made after capture() -- and before restore() -- steers the
     * immediate pass AND the deferred double-rAF ones. This is how a
     * caller with a richer notion of "where this region should be"
     * (ComposerUI keeps one scroll memory PER SECTION; the slot is
     * shared) retargets a single slot at the position that belongs to
     * the view about to be mounted. When the region has never been
     * captured there is no entry to re-point, and the caller must
     * supply `getScrollEl` to mint one -- otherwise a first visit
     * (fresh page, remembered position in storage, nothing mounted at
     * capture time) would have nowhere to seed the memory into.
     * Names unknown and getterless are ignored: per-render entries
     * have no meaning outside their own render.
     */
    override(name, { pixels, fraction = 0 }, getScrollEl) {
        let entry = this._persistent[name];
        if (!entry) {
            if (!getScrollEl) return;
            entry = this._persistent[name] = { getScrollEl, pixels: 0, fraction: 0, hadOverflow: false };
        }
        entry.pixels = pixels;
        entry.fraction = fraction;
        entry.hadOverflow = fraction > 0 || pixels > 0;
    }

    /**
     * Reapply the captured snapshot to whatever each region's
     * `getScrollEl` currently returns. Safe to call multiple times
     * (e.g. once synchronously after a render's synchronous DOM work,
     * and again after any async content-fill promise settles) and
     * safe to call when a region's element no longer exists (skipped).
     *
     * Applies immediately (same task as the caller's DOM work, so
     * BEFORE the browser paints -- see the class docstring: this is
     * what prevents the "jump to top then snap back" flicker) and then
     * again after a double rAF, so regions whose content only becomes
     * scrollable once layout has committed or an async fill lands are
     * still corrected onto the captured position.
     */
    restore() {
        if (!this._snapshot) return;
        this._apply();
        requestAnimationFrame(() => {
            this._apply();
            requestAnimationFrame(() => this._apply());
        });
    }

    /**
     * One synchronous application pass over every captured region.
     * Idempotent: re-applying an already-correct `scrollTop` is a
     * no-op, so calling this repeatedly (once per `restore()`, plus
     * again after each async content fill) is harmless.
     */
    _apply() {
        if (this._snapshot) {
            for (const entry of Object.values(this._snapshot)) this._applyEntry(entry);
        }
        for (const entry of Object.values(this._persistent)) this._applyEntry(entry);
    }

    /**
     * Apply one captured entry to whatever its getter returns right now.
     * A no-op when the element is gone or has nothing to scroll to yet.
     */
    _applyEntry(entry) {
        const scrollEl = entry.getScrollEl();
        if (!scrollEl) return;
        const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
        if (maxScroll <= 0) return; // nothing to scroll to (yet) -- leave at 0
        // Prefer the exact pixel offset when the content's scrollable range
        // hasn't shrunk below it (i.e. the same position is still reachable);
        // otherwise fall back to the proportional fraction so a meaningfully
        // shorter/taller list still lands in roughly the right place instead
        // of clamping to an edge.
        const target = Math.round(entry.pixels <= maxScroll ? entry.pixels : entry.fraction * maxScroll);
        // Only write when it actually differs: `scrollTop` reads back
        // rounded, so re-assigning an already-correct value would otherwise
        // look like a change on every pass and dirty the layout for no reason.
        if (scrollEl.scrollTop !== target) scrollEl.scrollTop = target;
    }
}
