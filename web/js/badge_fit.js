/**
 * badge_fit.js
 *
 * The measurement machinery behind buildOverflowBadgeRow (category pill
 * rows: as many badges as fit show whole, the LAST one shown clips with
 * an ellipsis, and only what follows it collapses into a "+N" pill --
 * round 57's grammar, see planVisibleBadges).
 *
 * Why this exists: the original fit ran PER ROW and read layout in
 * between its writes. Each `clientWidth`/`scrollWidth` read forces a
 * synchronous layout of the WHOLE document, and the old trim loop did
 * that once per badge candidate -- O(k) forced relayouts and O(k^2)
 * node churn per row -- scheduled via its own requestAnimationFrame AND
 * its own ResizeObserver, all while the chunked fill was still
 * appending siblings. Hundreds of rows meant hundreds of full-document
 * relayouts per load: that is why list-view rows (one badge row per
 * row, always laid out) measured several times heavier than everything
 * else on screen.
 *
 * What happens instead now:
 *  - ONE shared ResizeObserver for every badge row (the per-row ones are
 *    gone), and ONE batched rAF pass per wave of registrations:
 *  - all layout READS happen first in that pass -- a document already
 *    laid out answers consecutive reads without new flushes, so the
 *    whole wave costs one forced layout, not one per row --
 *  - all DOM WRITES happen last, and never read back, so they lay out
 *    once more at the browser's leisure rather than per row;
 *  - badge label widths are measured ONCE per unique text via a hidden
 *    offscreen probe and cached, so a category carried by 300 prompts
 *    is measured once ever; trimming after that is pure arithmetic in
 *    the exported planVisibleBadges() (unit-tested, DOM-free, in
 *    tests/verify_badge_fit.mjs);
 *  - a row whose available width equals what it was last fitted at is
 *    skipped outright -- that also cancels the old rAF+observer double
 *    pass, where every row was measured and trimmed twice.
 *
 * Importing this module touches no DOM: everything is lazy, so its pure
 * half tests under plain node.
 */

const DEFAULT_STYLE = {
    gap: 3, // mirrors .pc-badge-row's `gap: 3px`
    padL: 0,
    padR: 0,
};

const OVERFLOW_DIGITS = [1, 2, 3]; // sample widths for "+9" / "+99" / "+999"
const MAX_MEASURED_LABELS = 2000; // user-supplied category text: bound the cache
const MAX_MEASURED_EPOCHS = 4;    // distinct probe fonts kept before the oldest goes

const badgeWidths = new Map();    // widthKey(text) -> px width of a plain .pc-badge
const overflowWidths = new Map(); // digitsKey(digits) -> px width of a .pc-badge-overflow pill
const epochSizes = new Map();     // font epoch -> live badgeWidths entries for it
const epochOrder = [0];           // insertion order == oldest epoch first; the initial font is epoch 0
const styleContexts = new Map();  // resolved "gap|padL|padR" style key -> { gap, padL, padR }

const pending = new Set(); // rows awaiting their fit pass
let flushScheduled = false;
let sharedObserver = null;
let probeEl = null;
const probeFont = { family: null, lineHeight: null }; // what the probe CURRENTLY declares

/* ------------------------------------------------------------------ */
/* Pure planning (no DOM -- the tested heart of this module)           */
/* ------------------------------------------------------------------ */

/* A clipped badge must at least DRAW its ellipsis: 8px of .pc-badge
   padding (4px per side) plus the "…" glyph (~10px at 9px font). A
   candidate that cannot show "…" is not "shown", it is a stub -- the
   planner steps down a whole badge instead. */
const CLIP_MIN = 18;

/**
 * Round 57 badge grammar: show AS MANY whole badges as fit, and let the
 * LAST badge shown be the one that clips -- `Extra` `Light`
 * `last categ...` `[+2]`. (Round 56's "only the first badge, clipped"
 * wasted the row on multi-category prompts; the never-surrender-the-
 * seat principle survives, it just moved to the END of the visible
 * prefix.)
 *
 * Outcomes: everything whole (no clip, no pill); else the largest k
 * whole badges whose tail `[badge k+1 clipped]["+N"]` fits -- the
 * clipped badge reserving at least CLIP_MIN -- counting the remaining
 * n-k-1 labels (k = n-1 hides nothing, so no pill); and the final
 * fallback, first badge clipped + pill, overflowing if it must, which
 * keeps the seat doctrine true at every row width.
 *
 * @param {string[]} items - badge labels, display order
 * @param {(text: string) => number} widthOf - px width of a plain badge
 * @param {(remaining: number) => number} overflowWidthOf - px of the "+N" pill
 * @param {number} gap - row column-gap in px
 * @param {number} available - row content-box width in px
 * @returns {{visible: number, clipIndex: number, overflow: number}}
 *   visible = badges rendered (the clipped one included); clipIndex =
 *   index of the clipped badge, -1 when none; overflow = labels folded
 *   into the "+N" pill, 0 meaning no pill.
 */
export function planVisibleBadges(items, widthOf, overflowWidthOf, gap, available) {
    const n = items.length;
    if (n === 0) return { visible: 0, clipIndex: -1, overflow: 0 };
    if (available <= 0) return { visible: n, clipIndex: -1, overflow: 0 }; // width unknown: all

    const widths = items.map((text) => Math.max(0, widthOf(text) || 0));
    const sumAll = widths.reduce((a, w) => a + w, 0);
    // 1px tolerance: offsetWidth rounds each badge, so a summed width can
    // sit a hair over the pixel compare -- without it, a row one hair too
    // wide would ellipsize a badge that visibly fit whole.
    const limit = available + 1;
    if (sumAll + gap * (n - 1) <= limit) return { visible: n, clipIndex: -1, overflow: 0 };

    let prefix = sumAll - widths[n - 1]; // sum of widths[0..k-1], starting at k = n-1
    for (let k = n - 1; k >= 1; k--) {
        const hidden = n - k - 1;
        const pill = hidden > 0 ? gap + Math.max(0, overflowWidthOf(hidden)) : 0;
        // Rendered tail: k whole, 1 clipped, optionally the pill; gaps sit
        // between every pair of neighbours: k before/around the clipped
        // badge plus one more before the pill.
        const cost = prefix + gap * (k + (hidden > 0 ? 1 : 0)) + CLIP_MIN + pill;
        if (cost <= limit) return { visible: k + 1, clipIndex: k, overflow: hidden };
        prefix -= widths[k - 1];
    }
    // Even k=1 cannot pay its tail: the first badge clips alone with the
    // pill -- a sliver if it must (round 56's seat doctrine), never zero.
    return { visible: 1, clipIndex: 0, overflow: n - 1 };
}

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    const raf = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
    raf(() => {
        flushScheduled = false;
        flushBadgeFits();
    });
}

function observer() {
    if (!sharedObserver && typeof ResizeObserver !== "undefined") {
        sharedObserver = new ResizeObserver((entries) => {
            let any = false;
            for (const entry of entries) {
                const row = entry.target;
                if (!row.isConnected || !row._pcBadgeFit) continue;
                pending.add(row);
                any = true;
            }
            if (any) scheduleFlush();
        });
    }
    return sharedObserver;
}

/**
 * Register a freshly built badge row for batched fitting. The row is
 * expected to already contain all its badges (so it is never briefly
 * empty, and a row that never gets real width keeps them); this pass
 * trims to the "+N" form the frame after it has been laid out.
 */
export function registerBadgeRow(row, items) {
    row._pcBadgeFit = { items: items.slice(), available: null, applied: null };
    pending.add(row);
    scheduleFlush();
    const ro = observer();
    if (ro) ro.observe(row);
    return row;
}

/* ------------------------------------------------------------------ */
/* Measurement                                                         */
/* ------------------------------------------------------------------ */

function ensureProbe() {
    if (typeof document === "undefined" || !document.body) return null;
    if (probeEl) return probeEl;
    probeEl = document.createElement("div");
    probeEl.className = "pc-badge-probe";
    probeEl.setAttribute("aria-hidden", "true");
    document.body.append(probeEl);
    return probeEl;
}

/**
 * The probe is one shared offscreen strip, and it has to measure badges
 * in the same typography the real ones will be laid out in -- the FONT
 * at least, which a badge inherits from the panel root but a <body>
 * child does not, so it must be re-declared here. (The ROW GAP is NOT
 * needed on the probe: each span is measured standalone via offsetWidth,
 * and the planner takes the gap from the real row's own computed style
 * in styleContext().) Style writes to the probe dirty only the probe's
 * own subtree, so this cannot cascade into re-laying-out the rows we
 * are about to read.
 *
 * Cached widths are keyed by a font EPOCH rather than cleared on a font
 * change: within one batch, rows seen before the change were measured
 * validly and rows after it re-measure; the epoch keeps both honest and
 * simply ages out the old font's entries.
 */
let fontEpoch = 0;
const widthKey = (text) => fontEpoch + "|" + text;
const digitsKey = (digits) => "d:" + fontEpoch + ":" + digits;

/** Delete every key `epoch|...` holds; used when an epoch ages out. */
function dropEpoch(epoch) {
    const labelPrefix = epoch + "|";
    const digitPrefix = "d:" + epoch + ":";
    for (const key of badgeWidths.keys()) if (key.startsWith(labelPrefix)) badgeWidths.delete(key);
    for (const key of overflowWidths.keys()) if (key.startsWith(digitPrefix)) overflowWidths.delete(key);
    epochSizes.delete(epoch);
}

function tuneProbe(computed) {
    if (!probeEl) return;
    const family = computed.fontFamily || "";
    const lineHeight = computed.lineHeight || "";
    if ((family !== probeFont.family || lineHeight !== probeFont.lineHeight)
        && (probeFont.family !== null || probeFont.lineHeight !== null)) {
        fontEpoch++; // widths cached under the old font are unreachable now
        epochOrder.push(fontEpoch);
        while (epochOrder.length > MAX_MEASURED_EPOCHS) dropEpoch(epochOrder.shift());
    }
    if (probeEl.style.fontFamily !== family) probeEl.style.fontFamily = family;
    if (probeEl.style.lineHeight !== lineHeight) probeEl.style.lineHeight = lineHeight;
    probeFont.family = family;
    probeFont.lineHeight = lineHeight;
}

function probeNeedsTuning(computed) {
    return probeFont.family !== (computed.fontFamily || "")
        || probeFont.lineHeight !== (computed.lineHeight || "");
}

/** Row-class metrics (gap/padding), cached by RESOLVED style values --
 * pure reads, run inside the batch's read phase. */
function styleContext(computed) {
    const key = (computed.columnGap || "") + "|"
        + (computed.paddingLeft || "") + "|" + (computed.paddingRight || "");
    let ctx = styleContexts.get(key);
    if (ctx) return ctx;
    const gapRaw = parseFloat(computed.columnGap);
    ctx = {
        gap: Number.isFinite(gapRaw) ? gapRaw : DEFAULT_STYLE.gap,
        padL: parseFloat(computed.paddingLeft) || 0,
        padR: parseFloat(computed.paddingRight) || 0,
    };
    styleContexts.set(key, ctx);
    return ctx;
}

/**
 * Measure every label this batch needs that isn't cached. All probe
 * children are appended BEFORE any width is read, so the first read
 * pays one layout and every read after it comes free off that pass.
 */
function measureMissing(texts, needOverflow, probe) {
    if (!probe) return;
    const created = [];
    for (const text of texts) {
        if (badgeWidths.has(widthKey(text))) continue;
        const span = document.createElement("span");
        span.className = "pc-badge";
        span.textContent = text;
        probe.append(span);
        created.push({ text, span });
    }
    if (needOverflow) {
        for (const digits of OVERFLOW_DIGITS) {
            if (overflowWidths.has(digitsKey(digits))) continue;
            const span = document.createElement("span");
            span.className = "pc-badge pc-badge-overflow";
            span.textContent = `+${"1".repeat(digits)}`;
            probe.append(span);
            created.push({ digits, span });
        }
    }
    if (!created.length) return;
    if (!epochOrder.includes(fontEpoch)) epochOrder.push(fontEpoch);
    for (const entry of created) {
        const px = entry.span.offsetWidth;
        if (entry.text !== undefined) {
            const key = widthKey(entry.text);
            if (!badgeWidths.has(key)) epochSizes.set(fontEpoch, (epochSizes.get(fontEpoch) || 0) + 1);
            badgeWidths.set(key, px);
        } else {
            overflowWidths.set(digitsKey(entry.digits), px);
        }
    }
    // Per-epoch bound: a library with a pathological number of distinct
    // categories re-measures at worst once per flush-wave when its epoch
    // crosses MAX_MEASURED_LABELS -- and only THAT epoch's entries go,
    // never another font's still-valid ones. The current font's epoch is
    // always the one checked here, so its bookkeeping is re-armed.
    if ((epochSizes.get(fontEpoch) || 0) > MAX_MEASURED_LABELS) {
        dropEpoch(fontEpoch);
        epochOrder.push(fontEpoch); // still the current font; start fresh
    }
    probe.textContent = ""; // the cached numbers stand; the nodes go
}

function overflowWidthFor(remaining) {
    const digits = Math.min(3, String(remaining).length);
    return overflowWidths.get(digitsKey(digits)) || 0;
}

/* ------------------------------------------------------------------ */
/* The batch                                                           */
/* ------------------------------------------------------------------ */

/* Pinned children: the favorite-star badge (.pc-fav-star) is a permanent
   member of a badge row -- it is never a fit candidate (it carries state,
   not a label), so a re-render must not drop it, and its box must always
   be reserved from the row's available width. FAV_PIN_W mirrors the star's
   CSS box in .pc-fav-star (both seats share it now); the list-variant star
   is display:none while off, so the pills sit flush left and the reveal
   PUSHES them right -- into exactly this reserved space, which is why the
   push can never overflow (round 58: the push is the user's wanted
   behavior; fitting against the star-present state keeps the plan honest
   in the worst case). The coupling is test-pinned in
   verify_workflow_restore -- resize one, the pin fails. Grid cards are
   untouched: their star floats OUTSIDE the row and reserves its room via
   CSS padding instead, which styleContext already deducts. */
const FAV_PIN_W = 14;

function pinnedStar(row) {
    const kids = row.children;
    if (!kids) return null;
    for (const c of kids) {
        if (c.classList && c.classList.contains("pc-fav-star")) return c;
    }
    return null;
}

function flushBadgeFits() {
    if (typeof document === "undefined" || !document.body) return;
    const rows = Array.from(pending);
    pending.clear();

    /* -- READ phase: the layout is read here and written nowhere, so
       the first read's forced layout answers the whole wave. Consecutive
       reads against an unmodified document all come off that one pass. -- */
    const toPlan = [];
    const texts = new Set();
    let needOverflow = false;
    for (const row of rows) {
        const st = row._pcBadgeFit;
        if (!row.isConnected || !st || !st.items.length) continue;
        const computed = getComputedStyle(row);
        const ctx = styleContext(computed);
        st.pinned = !!pinnedStar(row);
        const available = row.clientWidth - ctx.padL - ctx.padR
            - (st.pinned ? FAV_PIN_W + ctx.gap : 0);
        st.available = available;
        st.ctx = ctx;
        if (available > 0 && st.applied === available) continue; // already right
        ensureProbe();
        if (probeNeedsTuning(computed)) tuneProbe(computed);
        toPlan.push(row);
        if (available > 0) {
            for (const text of st.items) if (!badgeWidths.has(widthKey(text))) texts.add(text);
            // Round 57 put the pill's width back into the plan's cost.
            if (st.items.length > 1) needOverflow = true;
        }
    }
    measureMissing(texts, needOverflow, probeEl);

    /* -- WRITE phase: no reads in here at all. -- */
    for (const row of toPlan) {
        const st = row._pcBadgeFit;
        if (!st || !row.isConnected) continue;
        const items = st.items;
        if (st.available <= 0) {
            // Hidden (no layout yet): everything, unclipped -- the old
            // fallback. The shared observer re-arms this row the moment
            // it gets a box.
            renderAllBadges(row, items, pinnedStar(row));
            st.applied = null;
            continue;
        }
        if (!probeEl || !items.every((t) => badgeWidths.has(widthKey(t)))) {
            // Probe unavailable or some label unmeasurable: leave the
            // all-badges build the caller already rendered; the next
            // resize wave retries.
            st.applied = null;
            continue;
        }
        const plan = planVisibleBadges(items, (t) => badgeWidths.get(widthKey(t)), overflowWidthFor, st.ctx.gap, st.available);
        const nodes = items.slice(0, plan.visible).map((item, i) => {
            const span = document.createElement("span");
            span.className = "pc-badge" + (i === plan.clipIndex ? " pc-badge-clip" : "");
            span.textContent = item;
            return span;
        });
        if (plan.overflow > 0) {
            const pill = document.createElement("span");
            pill.className = "pc-badge pc-badge-overflow";
            pill.textContent = `+${plan.overflow}`;
            nodes.push(pill);
        }
        // The pinned star keeps its seat FIRST (it leads the row it
        // belongs to); the fitted badges and the +N pill follow.
        const pin = st.pinned ? pinnedStar(row) : null;
        row.replaceChildren(...(pin ? [pin] : []), ...nodes);
        st.applied = st.available;
    }
}

function renderAllBadges(row, items, pin = null) {
    row.replaceChildren(...(pin ? [pin] : []), ...items.map((item) => {
        const span = document.createElement("span");
        span.className = "pc-badge";
        span.textContent = item;
        return span;
    }));
}

/** Drop every cached measurement (theme/font change, or tests). */
export function resetBadgeWidthCache() {
    badgeWidths.clear();
    overflowWidths.clear();
    styleContexts.clear();
    epochSizes.clear();
    epochOrder.length = 0;
    epochOrder.push(fontEpoch); // current font's epoch stays live
}

/** Exposed for tests only: rows registered but not yet batch-fitted. */
export function _pendingBadgeFitCount() {
    return pending.size;
}
