/**
 * separators.js
 *
 * Shared constants + helpers for entry-level and section-level
 * separators. Extracted verbatim (behavior unchanged) from the
 * original prompt_composer.js so ui_panels.js and ui_preview.js both
 * use the exact same normalization rules the Python side expects.
 */

export const ENTRY_SEPARATOR_ORDER = ["none", "comma", "and"];
export const ENTRY_SEPARATOR_GLYPH = { none: "∅", comma: ",", and: "&" };
export const ENTRY_SEPARATOR_SUFFIX = { none: "", comma: ",", and: " and" };

export const END_SEPARATOR_ORDER = ["none", "period", "comma"];
export const END_SEPARATOR_GLYPH = { none: "∅", period: ".", comma: "," };
export const END_SEPARATOR_SUFFIX = { none: "", period: ".", comma: "," };

/**
 * Normalize an entry's `entry_separator` value to one of "none" |
 * "comma" | "and". Tolerates the old boolean form used before this
 * became a 3-state field (true -> "comma", false -> "none"), for
 * robustness against any stray old data.
 */
export function normalizeEntrySeparator(value) {
    if (value === true) return "comma";
    if (value === false) return "none";
    if (ENTRY_SEPARATOR_ORDER.includes(value)) return value;
    return "comma";
}

/** Cycle none -> comma -> and -> none. */
export function cycleEntrySeparator(value) {
    const current = normalizeEntrySeparator(value);
    const idx = ENTRY_SEPARATOR_ORDER.indexOf(current);
    return ENTRY_SEPARATOR_ORDER[(idx + 1) % ENTRY_SEPARATOR_ORDER.length];
}

export function normalizeEndSeparator(value) {
    if (END_SEPARATOR_ORDER.includes(value)) return value;
    return "none";
}

/** Cycle none -> period -> comma -> none (the section end-separator button order). */
export function cycleEndSeparator(value) {
    const current = normalizeEndSeparator(value);
    const idx = END_SEPARATOR_ORDER.indexOf(current);
    return END_SEPARATOR_ORDER[(idx + 1) % END_SEPARATOR_ORDER.length];
}
