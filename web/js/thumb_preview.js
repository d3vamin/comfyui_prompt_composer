/**
 * thumb_preview.js — the full-resolution hover tooltip (list-view rows,
 * 2 s dwell, scroll-retarget re-arm).
 *
 * Hovering an entry/prompt thumbnail -- the grid card's
 * .pc-entry-image-wrap OR the list row's .pc-entry-row-thumb, sections
 * and library alike -- for more than THUMB_PREVIEW_DELAY_MS pops a
 * floating tooltip showing that image at its
 * FULL resolution -- the stored PNG is a clean
 * 256x256 (LIBRARY_THUMB_SIZE) and the card only ever displays it
 * downscaled, so "full resolution" is simply the same cached URL rendered
 * at natural size: zero extra network, zero extra decoding. Wraps whose
 * state is a placeholder (no <img>, or a missing-prompt question mark)
 * never arm the timer.
 *
 * Positioning rules (the user's contract): the tooltip is aligned to the
 * MOUSE POINTER and never under it -- it floats to the pointer's RIGHT
 * (vertically centered on the cursor), flips to the left when the right
 * viewport edge is too close, and is clamped inside the viewport
 * vertically. While open it TRACKS the pointer (mousemove repositions),
 * so the cursor always sits beside its top-left corner, never over the
 * picture itself. pointer-events:none keeps it permanently click-through.
 *
 * Lifecycle: one timer per hovered thumb; leaving the thumb (or the thumb
 * being re-rendered away -- isConnected check) cancels the pending timer
 * or dismisses the open tooltip. Any wheel scroll, window scroll, mouse
 * press or Escape dismisses too -- a tooltip that lags behind scrolling
 * content is worse than none. The pending-timer state is deliberately
 * NOT reset by pointer motion inside the same thumb: "hover for 2s" means
 * 2s on the card, not 2s of stillness.
 *
 * Scroll retargeting: scrolling moves content UNDER a still
 * pointer, and browsers do not reliably announce that as a hover --
 * Firefox never synthesizes mouseover for it, Chrome only after the
 * scroll settles (after our own dismiss has already run). So every
 * wheel/scroll schedules a quiet-period re-check: when the motion pauses
 * (~150ms), whatever thumbnail now sits at the last-known pointer
 * position gets its dwell armed from scratch, exactly as if the cursor
 * had just arrived there. The pointer position rides on mouseover and
 * mousemove events, so it is current even with no synthetic events.
 *
 * The tooltip node is a lazy singleton mounted OUTSIDE the node panel
 * (document.body by default): the panels scroll, and LiteGraph's DOM
 * widget can sit under CSS transforms -- position:fixed anchored to the
 * viewport is the only placement that survives both.
 *
 * Everything host-shaped (mount point, viewport metrics) is injectable so
 * the tests can run this under a fake DOM with a shortened delay.
 */

export const THUMB_PREVIEW_DELAY_MS = 700;
// How long the pointer must sit still after wheel/scroll motion before
// the settle re-check looks at what arrived under it.
export const THUMB_RECHECK_MS = 150;
// Grid card wrap + list row thumb -- the two thumbnail hosts.
const THUMB_SELECTOR = ".pc-entry-image-wrap, .pc-entry-row-thumb";
// Gap between the pointer and the tooltip edge, and the viewport clamp.
const GAP = 14;
const EDGE = 8;

export function attachThumbPreview(root, {
    delayMs = THUMB_PREVIEW_DELAY_MS,
    recheckMs = THUMB_RECHECK_MS,
    mount = () => document.body,
    viewport = () => ({ w: window.innerWidth, h: window.innerHeight }),
    doc = () => document,
} = {}) {
    if (!root || typeof root.addEventListener !== "function") return () => {};

    let wrap = null;            // wrap currently under the pointer
    let timer = null;           // pending show timer
    let recheckTimer = null;    // pending settle re-check
    let tip = null;             // the floating element (lazy singleton)
    let tipImg = null;
    let lastX = 0;
    let lastY = 0;
    let pointerX = 0;           // last known pointer position, kept even
    let pointerY = 0;           // while NOTHING is armed (scroll re-check)

    function clearTimer() {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function hide() {
        if (tip) tip.style.display = "none";
    }

    /** The card's full-res source: the <img> our wrap already owns. */
    function imageOf(el) {
        const img = el && el.querySelector ? el.querySelector("img") : null;
        return img && img.getAttribute("src") ? img : null;
    }

    /**
     * Align to the pointer, never under it: right of the cursor, vertical
     * center on it; mirror to the left near the right edge; clamp inside
     * the viewport (flipping is preferred over clamping horizontally so
     * the pointer-alignment story stays honest).
     */
    function position() {
        if (!tip || tip.style.display === "none") return;
        const { w, h } = viewport();
        const tw = tip.offsetWidth || 0;
        const th = tip.offsetHeight || 0;
        let left = lastX + GAP;
        if (left + tw > w - EDGE) left = lastX - GAP - tw;      // flip left
        if (left < EDGE) left = EDGE;                           // squeeze fallback
        let top = lastY - Math.round(th / 2);                   // centered, not below
        top = Math.min(Math.max(top, EDGE), Math.max(EDGE, h - th - EDGE));
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
    }

    function show() {
        timer = null;
        if (!wrap || !wrap.isConnected) { wrap = null; return; }
        const src = imageOf(wrap);
        if (!src) return;
        if (!tip) {
            const d = doc();
            tip = d.createElement("div");
            tip.className = "pc-thumb-preview";
            tipImg = d.createElement("img");
            tipImg.className = "pc-thumb-preview-img";
            tip.append(tipImg);
            mount().appendChild(tip);
        }
        tipImg.src = src.getAttribute("src");
        tip.style.display = "block";
        position();
        // Natural size only lands once decoded; re-measure then (cached
        // thumbnails decode synchronously in practice -- this is a guard,
        // not a loading spinner).
        tipImg.addEventListener("load", position, { once: true });
    }

    function onMouseOver(e) {
        rememberPointer(e);
        const target = e.target && e.target.closest
            ? e.target.closest(THUMB_SELECTOR) : null;
        if (!target || target === wrap) return;   // same card / not a thumb
        // Leaving a previous wrap (no paired mouseout when jumping cards
        // fast) -- reset cleanly before arming the new one.
        clearTimer();
        hide();
        wrap = null;
        if (!imageOf(target)) return;             // placeholder-only: never arm
        wrap = target;
        lastX = e.clientX;
        lastY = e.clientY;
        timer = setTimeout(show, delayMs);
    }

    function onMouseMove(e) {
        rememberPointer(e);
        if (!wrap) return;
        lastX = e.clientX;
        lastY = e.clientY;
        position();                                // no-op while only pending
    }

    function onMouseOut(e) {
        if (!wrap) return;
        const to = e.relatedTarget;
        if (to && wrap.contains(to)) return;       // shifted between children
        clearTimer();
        hide();
        wrap = null;
    }

    function dismissAll() {
        clearTimer();
        hide();
        wrap = null;
    }

    function rememberPointer(e) {
        if (e && typeof e.clientX === "number") {
            pointerX = e.clientX;
            pointerY = e.clientY;
        }
    }

    /**
     * Scrolling slides content under a STILL pointer, which is
     * a brand-new hover the browser may never announce (Firefox
     * synthesizes no mouseover for it; Chrome fires only after the
     * scroll settles -- after our dismiss already ran). So each
     * wheel/scroll re-arms a quiet-period re-check: when motion pauses,
     * whatever thumbnail now sits at the last-known pointer position
     * starts its dwell from scratch, exactly as if the cursor had just
     * arrived. Mouse press and Escape do NOT re-check -- those are
     * intents to interact, not "the view moved under me".
     */
    function scheduleRecheck() {
        if (recheckTimer !== null) clearTimeout(recheckTimer);
        recheckTimer = setTimeout(() => {
            recheckTimer = null;
            const d = doc();
            if (!d || typeof d.elementFromPoint !== "function") return;
            const under = d.elementFromPoint(pointerX, pointerY);
            const target = under && under.closest ? under.closest(THUMB_SELECTOR) : null;
            if (!target || target === wrap || !root.contains(target)) return;
            if (!imageOf(target)) return;
            clearTimer();
            hide();
            wrap = target;
            lastX = pointerX;
            lastY = pointerY;
            timer = setTimeout(show, delayMs);
        }, recheckMs);
    }

    function onScrollMotion(e) {
        rememberPointer(e);
        dismissAll();
        scheduleRecheck();
    }

    function onKey(e) { if (e.key === "Escape") dismissAll(); }

    root.addEventListener("mouseover", onMouseOver);
    root.addEventListener("mousemove", onMouseMove);
    root.addEventListener("mouseout", onMouseOut);
    window.addEventListener("wheel", onScrollMotion, { passive: true });
    window.addEventListener("scroll", onScrollMotion, { capture: true, passive: true });
    window.addEventListener("mousedown", dismissAll);
    window.addEventListener("keydown", onKey);

    return function dispose() {
        clearTimer();
        if (recheckTimer !== null) clearTimeout(recheckTimer);
        root.removeEventListener("mouseover", onMouseOver);
        root.removeEventListener("mousemove", onMouseMove);
        root.removeEventListener("mouseout", onMouseOut);
        window.removeEventListener("wheel", onScrollMotion);
        window.removeEventListener("scroll", onScrollMotion);
        window.removeEventListener("mousedown", dismissAll);
        window.removeEventListener("keydown", onKey);
        if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
        tip = null;
        tipImg = null;
    };
}
