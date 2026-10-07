/**
 * naming.js
 *
 * Name helpers for Prompt Composer, in two groups:
 *
 *  1. The naming-correction pipeline (correctPromptName /
 *     encodePromptName / decodePromptName / splitPromptRef /
 *     canonicalPromptText) -- the browser-side mirror of the same
 *     functions in server/library_store.py. The two MUST agree exactly:
 *     the server writes `prompt_data` filenames, the client decodes refs
 *     for display (dead refs in presets, "is missing" dialogs). See
 *     the naming rules that both sides implement.
 *
 *  2. The unified trailing-number collision convention (collisionSuffix /
 *     applyCollisionSuffix / lowestFreeNumber / dedupeName /
 *     generateUniqueName) shared by section names and preset default
 *     names -- and mirrored server-side by library_store.py for
 *     prompt_data import collisions -- plus the section color pool.
 *
 * Scope note: an Entry owns no name -- it only holds `id` +
 * `prompt_ref` + `allow_random` + `entry_separator`; name is always
 * resolved live from the library via `prompt_ref`. dedupeName/
 * generateUniqueName are therefore used for section names (and preset
 * defaults via ui_toolbars.js); prompt_data name identity is enforced
 * server-side (the "already exists" rule + import collision suffixes).
 */

export const SECTION_COLORS = [
    "#e05252", // red
    "#4a90d9", // blue
    "#e0a052", // orange
    "#8a5fd9", // purple
    "#6bbf59", // green
    "#d95fa0", // pink
    "#d9c93a", // yellow
    "#45b8b0", // teal
    "#d95f5f", // coral
    "#5367c9", // indigo
    "#b87845", // brown
    "#58a85c", // forest
    "#c85c9e", // magenta
    "#4b9bb8", // steel blue
    "#d28b45", // amber
    "#707a82", // slate
];

let colorPool = [];

function refillColorPool() {
    colorPool = [...SECTION_COLORS];

    for (let i = colorPool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [colorPool[i], colorPool[j]] = [colorPool[j], colorPool[i]];
    }
}

export function randomColor() {
    if (colorPool.length === 0) {
        refillColorPool();
    }

    return colorPool.pop();
}

// ---------------------------------------------------------------------------
// The unified trailing-number collision convention
//
// One convention, every name space:
//   - section names (dedupeName / generateUniqueName, via composer_state.js)
//   - preset default names (ui_toolbars.js _nextAvailablePresetName)
//   - prompt_data import collision suffixes (library_store.py's
//     collision_suffix()/lowest_free_number() -- the mirror of the two
//     functions below; keep them in sync)
//
// Rules:
//   - suffix format: "_" + number, at least three digits, width growing
//     naturally past 999 (_002 ... _999, _1000, _1001, ...)
//   - the number attaches to the DISPLAY name with an underscore, but a
//     base that ALREADY ends in "_" reuses it instead of doubling:
//     "Beautiful" -> "Beautiful_002", "Bright_" -> "Bright_002" (this is
//     applyCollisionSuffix; the raw collisionSuffix is just the "_002")
//   - collision resolution starts at _002 -- the unsuffixed base counts
//     as "number 1" and is never rewritten
//   - generated default names start at _001 and always carry the suffix
//   - the LOWEST available number wins (gap-fill)
//   - matching against taken names is case-insensitive
//   - a base name is never reinterpreted: a trailing number the USER
//     typed is content, not a counter to increment. (The old dedupeName
//     incremented "Photo 2024" to "Photo 2025"; under the unified rule
//     it becomes "Photo 2024_002", exactly like the import path treats
//     names.)
// ---------------------------------------------------------------------------

/** `_002`-style suffix for n >= 1 (at least three digits). Prefer
 *  applyCollisionSuffix() to attach it to a name (it reuses a trailing
 *  "_"); this is just the suffix itself. */
export function collisionSuffix(n) {
    return `_${String(n).padStart(3, "0")}`;
}

/**
 * Attach the unified trailing number to a DISPLAY name, reusing a
 * trailing underscore rather than doubling it: "Beautiful" + 2 ->
 * "Beautiful_002", "Bright_" + 2 -> "Bright_002". The result is an
 * ordinary name -- for prompt_data the suffix then encodes like any
 * other literal underscore ("Bright_002" -> "Bright__002"). Mirror of
 * apply_collision_suffix() in server/library_store.py -- keep in sync.
 */
export function applyCollisionSuffix(base, n) {
    const digits = String(n).padStart(3, "0");
    return base.endsWith("_") ? `${base}${digits}` : `${base}${collisionSuffix(n)}`;
}

/**
 * The lowest n >= startAt for which applyCollisionSuffix(base, n) is
 * free. `isTaken` receives the FULL suffixed name, so each name space
 * can compare on whatever it keys on (display name, target filename, ...).
 */
export function lowestFreeNumber(base, isTaken, startAt = 2) {
    let n = startAt;
    while (isTaken(applyCollisionSuffix(base, n))) n += 1;
    return n;
}

function takenNames(existingNames) {
    return new Set((existingNames || []).map((n) => (n || "").toLowerCase()));
}

/**
 * Generate a default name like "Section_001" / "Preset_002": the lowest
 * suffixed number (starting at 001) that no name in `existingNames`
 * occupies. Case-insensitive.
 */
export function generateUniqueName(prefix, existingNames) {
    const taken = takenNames(existingNames);
    const n = lowestFreeNumber(prefix, (c) => taken.has(c.toLowerCase()), 1);
    return applyCollisionSuffix(prefix, n);
}

/**
 * Given a desired `name` and the names already in use in the same scope
 * (excluding the item being named), return a collision-free name under
 * the unified convention:
 *
 *  - a free name is returned unchanged (trimmed)
 *  - a colliding name gets the lowest free `_002`-style suffix --
 *    never a re interpretation of digits the user typed
 *
 * Matching against existing names is case-insensitive.
 */
export function dedupeName(name, existingNames) {
    const taken = takenNames(existingNames);
    const trimmed = (name || "").trim();
    if (!trimmed) return trimmed;
    if (!taken.has(trimmed.toLowerCase())) return trimmed;
    const n = lowestFreeNumber(trimmed, (c) => taken.has(c.toLowerCase()), 2);
    return applyCollisionSuffix(trimmed, n);
}

// ---------------------------------------------------------------------------
// Naming correction (mirror of server/library_store.py -- keep in sync)
// ---------------------------------------------------------------------------

/**
 * Characters illegal in a filename on at least one supported OS
 * (Windows' reserved set plus control characters). In a Prompt Name
 * they become a space; the server folds them into "_" only when
 * normalizing an imported filename stem.
 */
const INVALID_FILENAME_CHARS_RE = /[\\/:*?"<>|\x00-\x1f]/g;

/** A Prompt Name must start with a word character or number. */
const WORD_START_RE = /[\p{L}\p{N}]/u;

/**
 * Whitespace class pinned to Python's str.isspace() (the server's
 * _finalize_prompt_name runs on str). JS's \s additionally matches
 * \uFEFF, which Python does NOT treat as whitespace -- an explicit
 * class keeps the two implementations byte-for-byte equivalent. The
 * control characters (\t \n \v \f \r \x1c-\x1f) are already folded to
 * spaces by INVALID_FILENAME_CHARS_RE before this runs, but they stay
 * listed for exactness.
 */
const PY_WS = "\\x09-\\x0d\\x1c-\\x1f\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WHITESPACE_RUN_RE = new RegExp(`[${PY_WS}]{2,}`, "g");
const WHITESPACE_EDGES_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

/** Fallback for an input that corrects to nothing usable (never empty). */
export const PROMPT_NAME_FALLBACK = "Prompt";

const MAX_PROMPT_NAME_CHARS = 128;

/**
 * Shared tail of every correction: invalid chars -> space, whitespace
 * runs -> single space, trim, then drop leading characters until the
 * first word/number. May return ""; callers apply their own fallback.
 * Operates on code points (like Python's str indexing) so surrogate
 * pairs never get split by the 128-char cap.
 */
function finalizePromptName(text) {
    // NFC first (mirror of unicodedata.normalize in _finalize_prompt_name):
    // macOS decomposes ("e" + combining acute), Windows/Linux compose --
    // the same-looking name must be ONE name on every machine.
    let out = String(text ?? "").normalize("NFC").replace(INVALID_FILENAME_CHARS_RE, " ");
    out = out.replace(WHITESPACE_RUN_RE, " ").replace(WHITESPACE_EDGES_RE, "");
    // Rule 8 (mirror of the server): drop spaces touching a literal "_".
    // One pass is provably enough (isolated spaces only; deletion cannot
    // create a new adjacency). This is what makes
    // encodePromptName/decodePromptName injective.
    out = out.replace(/(?<=_) +| +(?=_)/g, "");
    const chars = Array.from(out);
    const start = chars.findIndex((ch) => WORD_START_RE.test(ch));
    // Slice the CODE-POINT array (Python's str[:128] counts code points;
    // a plain string .slice could split a surrogate pair).
    const kept = start === -1 ? [] : chars.slice(start, start + MAX_PROMPT_NAME_CHARS);
    return kept.join("").replace(WHITESPACE_EDGES_RE, "");
}

/**
 * Raw editor input -> corrected Prompt Name. Never returns empty: input with no usable starting
 * character falls back to `fallback`.
 */
export function correctPromptName(raw, fallback = PROMPT_NAME_FALLBACK) {
    return finalizePromptName(raw) || fallback;
}

/**
 * Prompt Name -> the name portion of a prompt_data filename.
 *
 * Per-character escaping: every literal "_" doubles to "__" (underscores
 * first, so the "_" made from a space is never re-doubled), and a space
 * becomes a single "_" ("Bright Sun" -> "Bright_Sun", "Bright_Sun" ->
 * "Bright__Sun", "Bright__Sun" -> "Bright____Sun"). decodePromptName is
 * the exact inverse for every corrected name -- rule 8 in
 * finalizePromptName guarantees no space sits adjacent to "_", so every
 * encoded underscore-run is unambiguously even (underscores) or a lone
 * "_" (a space).
 */
export function encodePromptName(name) {
    return String(name ?? "")
        .replace(/_/g, "__")
        .replace(/ /g, "_");
}

/**
 * The name portion of a stored filename -> Prompt Name.
 *
 * Greedy inverse of encodePromptName: scanning left to right, "__" reads
 * back as a literal "_" and a lone "_" as a space. A collision suffix is
 * part of the name, so "Bright_Sun__002" reads back as "Bright Sun_002"
 * exactly -- no special casing. The result is re-validated through
 * finalizePromptName (rule 8 included), so non-canonical imported stems
 * project to their canonical name ("Bright___Sun" -> "Bright_Sun");
 * never returns empty.
 */
export function decodePromptName(encodedStem) {
    const s = String(encodedStem ?? "");
    let out = "";
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "_") {
            if (s[i + 1] === "_") {
                out += "_";
                i++;
            } else {
                out += " ";
            }
        } else {
            out += s[i];
        }
    }
    return finalizePromptName(out) || PROMPT_NAME_FALLBACK;
}

/**
 * The identity form of a prompt text -- mirror of canonical_prompt_text()
 * in server/library_store.py (keep in sync). The server hashes this into
 * the UID and compares it for "already exists" / import-collision
 * identity, so two prompts that LOOK the same (NFC vs NFD Unicode, CRLF
 * vs LF newlines, stray outer whitespace) are THE SAME prompt on every
 * machine. The client never computes a UID, but anything client-side
 * that ever needs to ask "is this the same prompt text?" must go
 * through here, not raw equality.
 */
export function canonicalPromptText(prompt) {
    return String(prompt ?? "")
        .normalize("NFC")
        .replace(/\r\n?/g, "\n")
        // Python str.strip() whitespace, pinned via PY_WS -- NOT JS
        // .trim(), which also eats \uFEFF and misses \x1c-\x1f.
        .replace(WHITESPACE_EDGES_RE, "");
}

/**
 * Split a prompt_ref into its halves.
 *
 * Mirrors `split_name_uid()` in server/library_store.py, which is what
 * writes these filenames: `UID_RE = ^(.*?)_(\d{8})$`. The two must agree
 * exactly or the client will disagree with the server about which part of a
 * ref is the name -- and because the name group is non-greedy and the UID
 * must be exactly eight digits, encoded names may themselves contain
 * underscores ("Dark__room_12345678" carries the name portion
 * "Dark__room", not "Dark").
 *
 * Returns { name, encoded, uid }: `encoded` is the raw filename half
 * (what the ref/path is built from), `name` is the decoded Prompt Name
 * (what a person reads). A ref with no UID suffix is legal (the server
 * assigns one at scan time), so `uid` is null and the whole string is
 * the encoded name.
 */
const UID_SUFFIX_RE = /^(.*?)_(\d{8})$/;

export function splitPromptRef(ref) {
    const text = String(ref || "");
    const match = UID_SUFFIX_RE.exec(text);
    if (!match) return { name: decodePromptName(text), encoded: text, uid: null };
    return { name: decodePromptName(match[1]), encoded: match[1], uid: match[2] };
}
