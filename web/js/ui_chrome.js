/**
 * ui_chrome.js
 *
 * The shared chrome builders: EVERY button, toggle, counter pill and
 * the two search boxes are constructed through the factories here.
 *
 * Why: the app used to hand-build `el("button", "pc-btn pc-icon-only",
 * {...})` + `innerHTML = svgIcon(...)` at 50+ sites, each one free to
 * drift (icon size 12 here, 13 there; hover states only on some
 * families; a pressed state on NONE). Now there is one door:
 *
 *   uiBtn        - normal/hover/pressed/focus via the .pc-pressable
 *                  CSS cluster; branches on `icon` (SVG, pc-icon-only)
 *                  vs `text`; `bare: true` for family-skinned controls
 *                  (swatch, exec chips, counters, multiselect summary)
 *                  that keep their own geometry but want the same
 *                  state affordance.
 *   uiToggle     - boolean on/off button: build-time icon/title/ring
 *                  swap (section eye/shuffle/tag, view & search
 *                  toggles, favourites filter).
 *   countPill    - the counter chip shared by the section row pill and
 *                  the bulk toolbar "N selected" chip.
 *   buildSearchBox - the library/section search strip (one grammar:
 *                  Enter + Esc + cross flush, typing goes through
 *                  onLive, the CALLER owns debouncing).
 *   modeNotice   - the one-line banner over the library grid while a
 *                  modal picking mode is armed (replace / add-to-
 *                  section), with its cancel button.
 *
 * Behavior is data-driven through callbacks; nothing in this file
 * touches app state. The dataset hooks (hook/hookValue, e.g.
 * data-entry-action, data-section-count-filter) stay exactly the
 * strings the in-place patchers and delegated handlers query.
 */

import { el } from "./dom_utils.js";
import { svgIcon } from "./icons.js";

/**
 * One button to make every button.
 * @param {object} o
 * @param {string} [o.icon] - icon name; when set (and `bare` is false)
 *   the button carries `pc-icon-only` and the icon is rendered inside.
 * @param {number} [o.size] - svgIcon size override (factory-callers
 *   that used a custom px size pass it; default is svgIcon's own).
 * @param {string} [o.text] - text label branch (mutually preferred
 *   with icon: icon wins if both given).
 * @param {string} [o.title] - tooltip; omitted when null/undefined.
 * @param {(e: MouseEvent) => void} [o.onClick]
 * @param {string} [o.extra] - extra classes appended verbatim.
 * @param {"primary"|"danger"} [o.variant]
 * @param {boolean} [o.bare] - skip the pc-btn/pc-icon-only skin (the
 *   control has a family class that owns its look). .pc-pressable and
 *   element hygiene are still applied.
 * @param {boolean} [o.iconOnly] - force pc-icon-only on/off when the
 *   auto rule (icon && !bare && !text) is wrong for a specific site.
 * @param {string} [o.hook] [o.hookValue] - dataset key (camelCase) +
 *   value stamped as data-<hook> (in-place patchers' lookup contract).
 * @param {boolean|string} [o.disabled] - property, not attribute
 *   (reliable across re-renders).
 * @param {string} [o.type] - defaults to unset (all current hosts are
 *   outside <form>s; pass "button" where one existed before).
 * @returns {HTMLButtonElement}
 */
export function uiBtn({ icon, size, text, title, onClick, extra = "", variant, bare = false, iconOnly, hook, hookValue, disabled, type, noHover = false, noStep = false } = {}) {
    const useIconOnly = iconOnly !== undefined ? iconOnly : Boolean(icon && !bare && !text);
    const classes = [
        ...(!bare ? ["pc-btn"] : []),
        ...(useIconOnly ? ["pc-icon-only"] : []),
        variant === "primary" ? "pc-primary" : variant === "danger" ? "pc-danger" : "",
        "pc-pressable",
        // Round 42: opt OUT of the hover wash -- the section-row flag
        // toggles sit inside a row that already lights on hover, and
        // the user asked for no extra background on the icons. Press
        // feedback (wash + 1px step) stays: noHover is about hover.
        ...(noHover ? ["pc-no-hover"] : []),
        // Round 43: absolutely-positioned controls place themselves
        // with top/bottom -- the press STEP would clobber that anchor,
        // so the factory marks them noStep and the CSS lets them sit.
        ...(noStep ? ["pc-no-step"] : []),
        extra,
    ].filter(Boolean).join(" ");
    const attrs = {};
    if (title !== undefined && title !== null) attrs.title = title;
    if (type !== undefined) attrs.type = type;
    if (onClick) attrs.onclick = onClick;
    const btn = el("button", classes, attrs);
    if (icon) btn.innerHTML = svgIcon(icon, size);
    else if (text !== undefined && text !== null) btn.textContent = text;
    if (disabled) btn.disabled = true;
    if (hook) btn.dataset[hook] = hookValue === undefined ? "true" : String(hookValue);
    return btn;
}

/**
 * A boolean toggle: same construction as uiBtn plus the
 * on-state affordances (ring class + icon pair + title pair)
 * resolved AT BUILD TIME. Round 41 adds `btn.applyState(on)`: the
 * same pairs re-applied to the LIVE node, so hosts that patch
 * in place (section-row flags) never pay for a panel rebuild
 * just to redraw a button.
 * @param {object} o - uiBtn options minus icon/title, plus:
 *   on, iconOn, iconOff, titleOn, titleOff, onClass (default "pc-on",
 *   may be a space list, e.g. "pc-on pc-always-visible").
 *   `icon`/`title` override the pairs for stateless-icon toggles.
 */
export function uiToggle({ on, iconOn, iconOff, titleOn, titleOff, onClass = "pc-on", icon, title, size, extra = "", onClick, bare = false, hook, hookValue, disabled, variant, noHover, noStep }) {
    const btn = uiBtn({
        icon: icon ?? (on ? iconOn : iconOff),
        size,
        title: title ?? (on ? titleOn : titleOff),
        onClick,
        variant,
        bare,
        noHover,
        noStep,
        extra: (on && onClass ? onClass + " " : "") + extra,
        hook,
        hookValue,
        disabled,
    });
    if (!icon && (iconOn || iconOff)) {
        // Stateful icons: expose the live re-apply. Icon swap, title
        // swap and ring classes share the exact rules the build used.
        const ringClasses = onClass.split(/\s+/).filter(Boolean);
        btn.applyState = (next) => {
            btn.innerHTML = svgIcon(next ? iconOn : iconOff, size);
            if (title === undefined && (titleOn || titleOff)) btn.title = next ? titleOn : titleOff;
            for (const c of ringClasses) btn.classList.toggle(c, !!next);
        };
    }
    return btn;
}

/**
 * The counter pill shared by the section row ("N visible / M total")
 * and the bulk toolbar ("N selected"). Both are inline pills with a
 * .pc-on ring when they represent an ACTIVE VIEW FILTER.
 * @param {object} o
 * @param {string} [o.tag] - "span" (bulk chip) or "div" (section pill).
 * @param {string} [o.text] - simple text branch.
 * @param {string} [o.extra] - family classes ("pc-section-count",
 *   "pc-entry-toolbar-count", ...).
 * @param {boolean} [o.on] - active-filter ring.
 * @param {string} [o.hook] [o.hookValue] - dataset lookup contract.
 * @param {HTMLElement[]} [o.children] - appended after creation (the
 *   section pill's pc-section-count-value span).
 * @param {boolean} [o.inert] - pill that merely carries the look (error
 *   text): no press affordance, no pointer cue (.pc-count-inert).
 */
export function countPill({ tag = "span", text, title, on = false, onClick, extra = "", hook, hookValue, children, inert = false } = {}) {
    const attrs = {};
    if (title !== undefined && title !== null) attrs.title = title;
    if (onClick) attrs.onclick = onClick;
    const pill = el(tag, ["pc-count-pill", inert ? "pc-count-inert" : "pc-pressable", on ? "pc-on" : "", extra].filter(Boolean).join(" "), attrs);
    if (text !== undefined && text !== null) pill.textContent = text;
    if (children) pill.append(...children);
    if (hook) pill.dataset[hook] = hookValue === undefined ? "true" : String(hookValue);
    return pill;
}

/** The shared search strip grammar (library browser AND section entry
 *  toolbar -- they were byte-twins across 50 lines; now they're one).
 *  @param {object} o
 *  @param {string} [o.value] - initial text.
 *  @param {string} [o.placeholder]
 *  @param {(value: string, field: HTMLElement) => void} [o.onLive] - every keystroke; the CALLER debounces.
 *  @param {(value: string, field: HTMLElement) => void} [o.onFlush] - Enter / Esc-clear / cross-clear, immediate.
 *  @returns {HTMLDivElement} toolbar with .searchField/.searchInput/.searchCount mounted (host code relies on them).
 */
export function buildSearchBox({ value = "", placeholder = "Search name, category or prompt text\u2026  ( / to focus )", onLive, onFlush } = {}) {
    const toolbar = el("div", "pc-toolbar pc-search-toolbar");
    const icon = el("span", "pc-icon-btn", { text: "" });
    icon.innerHTML = svgIcon("search");
    const field = el("div", "pc-search-field");
    const input = el("input", "pc-text-input", { type: "text", placeholder });
    input.value = value;
    // Returns true only if something WAS there to clear (so Esc on an
    // empty box releases focus instead of eating the keypress).
    const clearValue = () => {
        if (!input.value) return false;
        input.value = "";
        return true;
    };
    input.addEventListener("input", () => {
        if (onLive) onLive(input.value, field);
    });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            // A deliberate commit: run the search NOW, do not wait out
            // the caller's debounce.
            e.preventDefault();
            if (onFlush) onFlush(input.value, field);
        } else if (e.key === "Escape") {
            // Universal search-box grammar: first Esc empties the field
            // (restoring the full list), a second one lets go.
            e.stopPropagation();
            if (clearValue()) {
                if (onFlush) onFlush("", field);
            } else {
                input.blur();
            }
        }
    });
    const clearButton = uiBtn({
        bare: true,
        extra: "pc-search-clear",
        // Round 43 (user): the little x is a furnishing inside the
        // field -- no hover wash; it is absolutely placed, no step.
        noHover: true,
        noStep: true,
        title: "Clear search",
        type: "button",
        onClick: () => {
            if (!clearValue()) return;
            if (onFlush) onFlush("", field);
            input.focus();
        },
    });
    clearButton.innerHTML = svgIcon("cancel", 13);
    const count = el("span", "pc-search-count");
    count.style.display = "none";
    field.append(input, clearButton);
    toolbar.append(icon, field, count);
    toolbar.searchField = field;
    toolbar.searchInput = input;
    toolbar.searchCount = count;
    return toolbar;
}

/** The one-line banner above the library grid while a picking mode is
 *  armed (replace a missing entry / add-to-section), with its cancel X.
 *  @returns {HTMLDivElement}
 */
export function modeNotice({ cls, text, cancelTitle, onCancel }) {
    const notice = el("div", cls);
    notice.append(el("div", "pc-notice-text", { text }));
    notice.append(uiBtn({ icon: "x", size: 14, title: cancelTitle, onClick: onCancel }));
    return notice;
}
