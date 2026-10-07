/**
 * composer_state.js
 *
 * Owns the section/entry data and reorders/persists it.
 *
 * Core shape of the model:
 *  - Entry does not own name/prompt/thumbnail/category -- those are
 *    always resolved live from the library via `prompt_ref`. An Entry
 *    only owns: id (own identity), prompt_ref (pointer), visible
 *    (output-inclusion toggle: Show=true / Hide=false), allow_random,
 *    entry_separator.
 *  - The same prompt_ref may appear on multiple Entries, in the same
 *    section or different ones (duplicates). All entry operations key
 *    off `id`, never `prompt_ref` -- see addEntryFromLibrary,
 *    duplicateEntry, moveEntries, removeEntry below.
 *  - Entries need no name-dedup (dedupeName is not used here
 *    for entries at all -- see naming.js docstring).
 *  - The Library is NOT a section stored in `this.sections`. It is a
 *    separate, disk-backed data source (see ui_library.js), so
 *    ComposerState only ever holds the locked "Prompt" section plus
 *    user-made custom sections.
 */

import { uuid } from "./dom_utils.js";
import { randomColor, dedupeName, generateUniqueName } from "./naming.js";

export function makeLockedPromptSection() {
    return {
        id: "prompt-locked",
        name: "Prompt",
        color: "#8a5fd9",
        enabled: true,
        randomize: false,
        order: 0,
        is_locked_prompt: true,
        entries: [],
    };
}

export function makeSection(name) {
    return {
        id: uuid(),
        name: name || "New Section",
        color: randomColor(),
        enabled: true,
        randomize: false,
        end_separator: "none", // "period" | "comma" | "none"
        show_label: false,
        order: 0,
        is_locked_prompt: false,
        entries: [],
    };
}

/**
 * Create a new Entry pointing at a library prompt_ref. This is the ONLY
 * way an Entry comes into existence -- there is no "create a
 * blank entry and type its name/prompt in place" flow, since
 * an Entry has nothing of its own to type; prompt content always comes
 * from the library (see the Library panel / ui_library.js for
 * creating/editing prompt_data itself).
 */
/**
 * THE entry constructor -- this is the only way an Entry comes into
 * existence (see the file header). Fresh id + defaults for a
 * prompt_ref. Pass `base` (an existing
 * entry) to CLONE it -- duplicateEntry/transferEntries("copy") route
 * through here instead of hand-rolling `{ ...source, id: uuid() }`: the
 * base's fields win over the defaults, the id is always fresh, and the
 * prompt_ref comes from the caller (identical for a true clone,
 * different when re-pointing at another prompt).
 */
export function makeEntry(prompt_ref, base) {
    return {
        visible: true,
        allow_random: true,
        entry_separator: "none", // "none" | "comma" | "and"
        ...base,
        id: uuid(),
        prompt_ref,
    };
}

export class ComposerState {
    constructor(onChange) {
        this.sections = [makeLockedPromptSection()];
        this.activeSectionId = this.sections[0].id;
        this.presetName = null;
        this.onChange = onChange || (() => {});
        this._batchDepth = 0;
    }

    notify() {
        // Suppressed while inside withBatch() -- see below. The final
        // notify() when the outermost batch closes still runs
        // reindexOrder()+onChange() exactly once, so nothing here
        // skips real work; it just collapses N calls into 1.
        if (this._batchDepth > 0) return;
        this.reindexOrder();
        this.onChange();
    }

    /**
     * Run `fn` with notify() suppressed, then fire exactly one
     * notify() at the end (even if `fn` mutated state via several
     * calls that would each normally have called notify() on their
     * own, e.g. several removeEntry() calls in a loop). Nested calls
     * are safe -- only the outermost withBatch() triggers the final
     * notify().
     *
     * This exists purely to collapse "N state-mutating calls in a
     * loop" into a single render, e.g. bulk delete/cut/paste of
     * several entries at once (see prompt_composer.js's
     * onDeleteSelected/onCut/onPaste) -- each of those otherwise
     * calls a per-entry ComposerState method that ends in notify(),
     * which would trigger a full UI re-render (including
     * clearing and rebuilding the right panel) once per entry in the
     * batch rather than once for the whole operation.
     */
    withBatch(fn) {
        this._batchDepth += 1;
        try {
            fn();
        } finally {
            this._batchDepth -= 1;
            if (this._batchDepth === 0) this.notify();
        }
    }

    reindexOrder() {
        this.sections.forEach((s, i) => (s.order = i));
    }

    getActiveSection() {
        return this.sections.find((s) => s.id === this.activeSectionId) || this.sections[0];
    }

    addSection(name) {
        // Default names come from the unified trailing-number convention
        // (lowest free Section_001/002/... -- see naming.js); an explicit
        // name is deduped the same way a collision would be.
        const existing = this.sections.map((s) => s.name);
        const desired = name || generateUniqueName("Section", existing);
        const finalName = dedupeName(desired, existing);
        const section = makeSection(finalName);
        const activeIndex = this.sections.findIndex((s) => s.id === this.activeSectionId);
        const insertIndex = activeIndex === -1 ? this.sections.length : activeIndex + 1;
        this.sections.splice(insertIndex, 0, section);
        this.activeSectionId = section.id;
        this.notify();
        return section;
    }

    /**
     * Rename a section, automatically de-duplicating against every
     * other section's current name. Returns the name that was
     * actually applied (which may differ from `desiredName` if it
     * collided).
     */
    renameSection(id, desiredName) {
        const section = this.sections.find((s) => s.id === id);
        if (!section) return null;
        const others = this.sections.filter((s) => s.id !== id).map((s) => s.name);
        const finalName = dedupeName(desiredName, others);
        section.name = finalName;
        this.notify();
        return finalName;
    }

    removeSection(id) {
        const section = this.sections.find((s) => s.id === id);
        if (!section || section.is_locked_prompt) return; // cannot delete locked Prompt
        this.sections = this.sections.filter((s) => s.id !== id);
        if (this.activeSectionId === id) {
            this.activeSectionId = this.sections[0]?.id;
        }
        this.notify();
    }

    moveSection(id, newIndex) {
        const idx = this.sections.findIndex((s) => s.id === id);
        if (idx === -1) return;
        const [section] = this.sections.splice(idx, 1);
        const adjustedIndex = idx < newIndex ? newIndex - 1 : newIndex;
        this.sections.splice(adjustedIndex, 0, section);
        this.notify();
    }

    /**
     * Add a new Entry to a section, pointing at `prompt_ref`. Because
     * Entries no longer own a name, there is no dedup step here at
     * all -- adding the same prompt_ref twice is explicitly supported
     * (duplicates), each getting its own fresh `id`.
     */
    addEntryFromLibrary(sectionId, prompt_ref) {
        const section = this.sections.find((s) => s.id === sectionId);
        if (!section || !prompt_ref) return null;
        const entry = makeEntry(prompt_ref);
        section.entries.push(entry);
        this.notify();
        return entry;
    }

    /**
     * Duplicate an existing entry within its section: same prompt_ref,
     * same allow_random/entry_separator, fresh id, inserted
     * immediately after the source entry. This is the explicit
     * "use this same library prompt again, positioned differently"
     * flow.
     */
    duplicateEntry(sectionId, entryId) {
        const section = this.sections.find((s) => s.id === sectionId);
        if (!section) return null;
        const idx = section.entries.findIndex((e) => e.id === entryId);
        if (idx === -1) return null;
        const source = section.entries[idx];
        const copy = makeEntry(source.prompt_ref, source);
        section.entries.splice(idx + 1, 0, copy);
        this.notify();
        return copy;
    }

    removeEntry(sectionId, entryId) {
        const section = this.sections.find((s) => s.id === sectionId);
        if (!section) return;
        section.entries = section.entries.filter((e) => e.id !== entryId);
        this.notify();
    }

    /**
     * Copy or move a set of entries (by id) from one section into
     * another, appending them at the end of the target section's list
     * in their current relative order. Used by the cross-section
     * drag-and-drop flow (see prompt_composer.js's
     * onDropCrossSectionEntries) after the person has chosen Copy or
     * Move in the resulting approval dialog.
     *
     * - mode: "copy" -- entries are duplicated (fresh ids, same
     *   prompt_ref/allow_random/entry_separator) into targetSectionId;
     *   the source section is left untouched.
     * - mode: "move" -- the SAME entry objects are relocated: removed
     *   from sourceSectionId, appended to targetSectionId. Ids and all
     *   other properties are preserved exactly.
     *
     * No-ops (returns []) if either section can't be found, if
     * sourceSectionId === targetSectionId (this method is only ever
     * meant for an actual cross-section transfer -- the caller is
     * responsible for not calling it for a same-section drop), or if
     * none of `entryIds` are actually found in the source section.
     * Wrapped in withBatch so moving/copying several entries at once
     * only triggers a single render, same rationale as onCut/onPaste.
     */
    transferEntries(sourceSectionId, targetSectionId, entryIds, mode) {
        if (sourceSectionId === targetSectionId) return [];
        const source = this.sections.find((s) => s.id === sourceSectionId);
        const target = this.sections.find((s) => s.id === targetSectionId);
        if (!source || !target || target.is_locked_prompt) return [];

        const idSet = new Set(entryIds);
        const matched = source.entries.filter((e) => idSet.has(e.id));
        if (matched.length === 0) return [];

        const transferred = [];
        this.withBatch(() => {
            if (mode === "move") {
                source.entries = source.entries.filter((e) => !idSet.has(e.id));
                for (const entry of matched) {
                    target.entries.push(entry);
                    transferred.push(entry);
                }
            } else {
                // "copy" (default): leave source untouched, append
                // fresh-id duplicates to the target.
                for (const entry of matched) {
                    const copy = makeEntry(entry.prompt_ref, entry);
                    target.entries.push(copy);
                    transferred.push(copy);
                }
            }
        });
        return transferred;
    }

    /**
     * Move a set of entries (by id) to a new position within their
     * section, keeping their relative order. `targetIndex` is an
     * insertion point in the CURRENT list (0..length), exactly as the
     * drag code computes it from the hovered card's index plus a
     * before/after half -- i.e. measured BEFORE anything is removed.
     *
     * A single-entry reorder is just the one-id case, so this replaces
     * the old single `moveEntry`. The shift correction (subtract how many
     * dragged entries sat before the insertion point) is what makes the
     * block land where the cursor showed it, whether it moved up or down
     * the list.
     */
    moveEntries(sectionId, entryIds, targetIndex) {
        const section = this.sections.find((s) => s.id === sectionId);
        if (!section) return;
        const idSet = new Set(entryIds);
        // Dragged block in current section order (the payload's own order
        // is not guaranteed to be visual order).
        const dragged = section.entries.filter((e) => idSet.has(e.id));
        if (!dragged.length) return;
        // How many dragged entries originally sat before the insertion
        // point -- removing them shifts the point left by that much.
        let removedBefore = 0;
        section.entries.forEach((e, i) => {
            if (idSet.has(e.id) && i < targetIndex) removedBefore += 1;
        });
        const remaining = section.entries.filter((e) => !idSet.has(e.id));
        const insertAt = Math.max(0, Math.min(remaining.length, targetIndex - removedBefore));
        remaining.splice(insertAt, 0, ...dragged);
        section.entries = remaining;
        this.notify();
    }

    /**
     * Serialize sections for the hidden composer_state widget. Each
     * entry is sent as-is (id, prompt_ref, visible, allow_random,
     * entry_separator) -- resolution of prompt_ref into actual text
     * happens server-side in prompt_composer_node.py at queue time,
     * NOT here (the library is the single source of truth).
     *
     * IMPORTANT -- this is NOT what gets queued. See
     * serializeForQueue() below: ComfyUI folds this node's own literal
     * (non-link) input values into its execution cache signature
     * whenever UNIQUE_ID is one of its hidden inputs (which this node
     * needs for the executed-output stash), COMPLETELY INDEPENDENTLY
     * of whatever prompt_composer_node.py's IS_CHANGED() computes --
     * see that method's own docstring for the long version. That raw
     * string is this one, if it's what ends up in the widget: every
     * section/entry field, including ones the Python compose pipeline
     * never reads for its output (a section's own `id`/`color` when
     * show_label is off and randomize is off, an entry's own `id`, an
     * entirely empty section, drag order among entries that produces
     * the same joined text either way). Queuing THIS string directly
     * is exactly what made adding an empty section, renaming a prompt
     * that's hidden from output, or reordering things around a single
     * real section all force a full re-run even though the composed
     * prompt was byte-for-byte identical.
     *
     * serialize() itself stays exactly as it was and is still used
     * for anything that needs the FULL editable structure verbatim
     * (presets, the workflow's pc_state extra for onSerialize/
     * onConfigure round-tripping, any future export) -- none of that
     * changed. Only the hidden composer_state WIDGET now gets the
     * canonical form from serializeForQueue() instead.
     */
    serialize() {
        return JSON.stringify(this.sections);
    }

    /**
     * Canonical, minimal serialization of ONLY the fields
     * prompt_composer_node.py's compose_prompt()/_resolve_entries_text()
     * actually read to build the composed STRING (plus the small set of
     * identity fields the LIVE EDITOR needs regardless of composed
     * output, see the entry.id/section.id note below), in a fixed key
     * order -- this (not serialize()) is what ComposerUI.syncWidget()
     * writes into the hidden composer_state widget that ComfyUI
     * actually queues and hashes as part of this node's cache signature
     * (see this method's placement next to serialize() above for why
     * that distinction matters).
     *
     * FIRST, and just as important as which FIELDS survive below: a
     * section that is guaranteed to contribute nothing to the composed
     * string is dropped from the array ENTIRELY, not just trimmed down.
     * compose_prompt() itself skips a section whose block ends up empty
     * (`if not block: continue`) -- a brand new section with zero
     * entries, or one where every entry has been toggled to
     * visible=false, can NEVER produce a non-empty block regardless of
     * what any prompt_ref resolves to (_resolve_section_entries filters
     * to visible entries before anything else runs), so keeping such a
     * section IN this payload -- even with every field correctly
     * canonicalized -- would still change the queued string the moment
     * it's added, which is exactly "adding an empty section forces a
     * rerun", just moved one layer down instead of fixed. A disabled
     * section (enabled: false) is dropped the same way, matching
     * compose_prompt()'s own `if not section.get("enabled", True):
     * continue` skip.
     *
     * This can't catch every no-op case -- a VISIBLE entry whose
     * prompt_ref currently resolves to empty text (a live-library fact
     * this file has no access to; resolution only ever happens
     * server-side, see this module's own header) still keeps its
     * section in the payload even though compose_prompt() would still
     * see an empty block for it. That narrower gap is exactly what
     * IS_CHANGED() on the Python side is for: it re-resolves and
     * recomputes the actual output regardless of what this queued
     * string looks like, so the WORKFLOW never re-runs unnecessarily
     * even there -- what changes in that one case is only that
     * ComfyUI's separate literal-input part of its cache key moves too
     * (see IS_CHANGED()'s own docstring for why that part exists and
     * can't be silenced from the Python side). The section-count/
     * visible-entries filter below is what closes the common,
     * explicitly-reported cases -- a genuinely empty section, or every
     * entry in a section hidden -- which needed no server round trip to
     * already know were no-ops.
     *
     * Field-by-field, mirrored 1:1 against the Python side so the two
     * can never silently drift apart:
     *   - section.is_locked_prompt: routing only (compose_prompt skips
     *     straight to user_prompt for this one) -- included so the
     *     locked section is still recognizable, but it carries no
     *     entries here since user_prompt is ALREADY a separate,
     *     directly-hashed widget. Never dropped by the empty-section
     *     filter above (it isn't "empty" in the same sense -- its
     *     content is user_prompt, tracked by its own widget already;
     *     see section.enabled directly below for why it still has to
     *     survive into the payload rather than being skipped outright).
     *   - section.enabled: for a NORMAL section, one dropped entirely
     *     from the payload (see the filter above) rather than kept with
     *     the flag set, since compose_prompt() treats "enabled: false"
     *     and "absent" identically -- no reason for two different
     *     payloads to describe the same "contributes nothing" outcome.
     *     The LOCKED section is the one exception: compose_prompt()'s
     *     very first check for EVERY section, locked or not, is `if not
     *     section.get("enabled", True): continue` -- so unlike a normal
     *     section, the locked section can't simply be omitted from the
     *     payload when disabled (an entirely absent locked section is
     *     indistinguishable from one that's merely present-but-
     *     enabled, since there's no separate "locked section is
     *     missing" case for compose_prompt to fall into the way a
     *     missing normal section already means "excluded"). It has to
     *     stay IN the payload with enabled explicitly carried instead,
     *     or a disabled user_prompt section reads back as enabled on
     *     the Python side no matter what the toggle actually shows in
     *     the editor -- output and preview silently disagreeing, which
     *     is the "disabling the user prompt section still includes it
     *     in the composed output" bug this field exists to close.
     *   - section.randomize, section.id: id is fed into the per-section
     *     RNG seed (`f"{seed}:{section.get('id', index)}"`) and DOES
     *     change which entry gets picked whenever randomize is true and
     *     the random-eligible pool has 2+ entries -- so id can't be
     *     dropped just because it "looks like bookkeeping". Always
     *     included rather than conditionally, since a section can be
     *     toggled to randomize=true later without this list being
     *     recomputed from scratch.
     *   - section.order: compose() defensively RE-SORTS sections by
     *     this field whenever every section in the payload has one
     *     (see compose()'s own "sort defensively by an explicit order
     *     field" comment) -- so order can change join order and
     *     therefore the output even without touching array position.
     *     Always included so that re-sort can never see a mismatched
     *     "some sections have it, some don't" set here that the live
     *     sections array wouldn't have produced.
     *   - section.show_label, section.name: name is prepended as a
     *     literal "<name>: " label ONLY when show_label is true --
     *     same reasoning as id above, always included rather than
     *     conditionally.
     *   - section.end_separator: appended once at the end of the
     *     section's block (falls back to "none" exactly as
     *     compose_prompt's END_SEPARATOR_MAP.get(..., "none") does).
     *   - entry.id: NOT read by compose_prompt() for the composed
     *     STRING (it only ever surfaces through `chosen_out`, a side
     *     channel for the UI's "which entry did the server actually
     *     pick" highlight) -- but IS load-bearing for the live editor
     *     the moment ANY sections array is adopted (hydrateFromGraph
     *     included): every lookup, selection, and drag/drop operation
     *     in this file finds entries by `e.id === ...`, restore or not.
     *     Kept here purely so a workflow restored through the
     *     composer_state-widget fallback path (see workflow_restore.js
     *     -- no pc_state extras, e.g. an API-format prompt JSON) still
     *     produces a genuinely editable node instead of one where
     *     every entry looks identical to id-keyed lookups. A stable id
     *     never changes on its own without an accompanying add/remove/
     *     duplicate, so including it costs nothing toward the
     *     stability goal.
     *   - entry.prompt_ref, entry.visible, entry.allow_random,
     *     entry.entry_separator: the four remaining fields
     *     _resolve_entries_text / _resolve_section_entries / _entry_text
     *     read. An entry with visible === false is DROPPED from this
     *     payload entirely (not just kept with the flag set) once its
     *     section survives the "any visible entries at all" filter
     *     above, matching _resolve_section_entries' own `[p for p in
     *     prompts if p.get("visible")]` filter when randomize is off --
     *     a hidden entry can be renamed, re-pointed, toggled between
     *     allow_random states, all without ever moving this payload,
     *     which is exactly the "renaming a prompt that isn't even
     *     visible in the output" case this whole pass exists to fix.
     *     When randomize IS on, a visible-but-not-yet-picked pool entry
     *     can still change WHICH entry the RNG picks depending on the
     *     pool's composition, so hidden entries are only dropped when
     *     randomize is false; the small residual "hidden entries still
     *     listed under an always-randomize section" case is accepted
     *     rather than trying to replicate rng.choice's pool semantics
     *     here too.
     *   - Deliberately OMITTED: section.color (pure cosmetic accent
     *     stripe, never read anywhere in prompt_composer_node.py) --
     *     the one field in the whole live section shape that is
     *     neither output-relevant nor load-bearing for basic editing,
     *     so a fallback-path restore just gets a freshly-random accent
     *     color for each section instead of its original one.
     *   - ARRAY ORDER of both sections and entries is preserved as-is
     *     (JSON.stringify of a plain array keeps insertion order) since
     *     compose_prompt() joins blocks in exactly the order it
     *     iterates them (subject to the order-field re-sort above).
     *
     * Two different section/entry object shapes that would make
     * compose_prompt() produce the same string now always serialize to
     * the same canonical JSON (short of the live-library-resolution gap
     * noted above), and two that would produce a different string
     * always serialize to different JSON -- by construction, the same
     * guarantee IS_CHANGED() gives on the Python side, now extended to
     * the raw widget value ComfyUI hashes independently of IS_CHANGED
     * (see IS_CHANGED()'s own docstring in prompt_composer_node.py for
     * why that independent hashing happens at all and why it can't be
     * worked around from the Python side alone).
     */
    serializeForQueue() {
        const canonical = this.sections
            .filter((section) => {
                if (section.is_locked_prompt) return true;
                if (section.enabled === false) return false;
                const visibleCount = (section.entries || []).filter((e) => e.visible !== false).length;
                return visibleCount > 0;
            })
            .map((section) => {
                if (section.is_locked_prompt) {
                    // enabled MUST be carried here too: compose_prompt()
                    // checks `section.get("enabled", True)` for EVERY
                    // section, locked or not, BEFORE it ever looks at
                    // is_locked_prompt (see compose_prompt()'s own "if
                    // not section.get('enabled', True): continue" as
                    // its very first check) -- and the "Disable
                    // section" toggle in ui_panels.js is rendered for
                    // the locked section exactly like any other one,
                    // setting section.enabled = false on it same as it
                    // would for a normal section. Dropping this field
                    // here (as an earlier version of this method did)
                    // meant compose_prompt() always saw the locked
                    // section as absent-therefore-enabled regardless of
                    // that toggle's real, live state: disabling the
                    // user_prompt section correctly hid it from the
                    // PREVIEW (which reads live sections state
                    // directly, unaffected by this method) while the
                    // actual composed OUTPUT kept including it anyway --
                    // preview and output silently disagreeing, which is
                    // exactly the class of bug this whole file exists
                    // to prevent elsewhere.
                    return { is_locked_prompt: true, id: section.id, order: section.order ?? 0, enabled: section.enabled !== false };
                }
                const keepAllEntries = !!section.randomize;
                const entries = (section.entries || [])
                    .filter((e) => keepAllEntries || e.visible !== false)
                    .map((entry) => ({
                        id: entry.id,
                        prompt_ref: entry.prompt_ref || "",
                        visible: entry.visible !== false,
                        allow_random: !!entry.allow_random,
                        entry_separator: entry.entry_separator || "comma",
                    }));
                return {
                    is_locked_prompt: false,
                    id: section.id,
                    order: section.order ?? 0,
                    enabled: true,
                    randomize: !!section.randomize,
                    show_label: !!section.show_label,
                    name: section.name || "",
                    end_separator: section.end_separator || "none",
                    entries,
                };
            });
        return JSON.stringify(canonical);
    }

    loadFromPreset(preset) {
        const locked = this.sections.find((s) => s.is_locked_prompt) || makeLockedPromptSection();
        const importedLocked = preset.sections.find((s) => s.is_locked_prompt);
        if (importedLocked) {
            locked.order = importedLocked.order ?? 0;
        }
        const others = preset.sections.filter((s) => !s.is_locked_prompt);
        this.sections = [locked, ...others].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        this.presetName = preset.name;
        this.activeSectionId = this.sections[0]?.id;
        this.notify();
    }

    /** Count of entries with visible=true in a section (for the
     * section-list "N/total" badge). */
    countVisible(section) {
        return section.entries.filter((e) => e.visible).length;
    }
}

/**
 * The subset of usedPromptRefs(sections) (see workflow_restore.js) that can
 * actually reach compose_prompt()'s output string: refs from entries in
 * sections that survive the exact same "can this section contribute
 * anything" filter serializeForQueue() applies above (disabled sections
 * dropped; a non-randomize section keeps only its VISIBLE entries; a
 * randomize section keeps all of them, since any entry in its pool can
 * still be the one rng.choice() picks).
 *
 * Why this needs to exist separately from usedPromptRefs(): that function
 * is deliberately visibility-BLIND, because its OTHER callers legitimately
 * want every ref regardless of visibility --
 *   - ui_preview.js's cache-warmer: prefetching a hidden entry's content is
 *     harmless (just keeps the cache warm for if it's toggled visible), and
 *   - the SAVE-time workflow snapshot (buildSnapshotPayload, via the
 *     preset/file-save path): a saved workflow SHOULD keep a hidden entry's
 *     fallback copy, so re-enabling it later after a library edit still has
 *     something to fall back to. Narrowing usedPromptRefs() itself to
 *     visible-only would silently drop that fidelity from every save.
 *
 * This one function is for the ONE caller that must not see hidden refs at
 * all: syncComposerContents(), which mirrors "used" content into the
 * hidden composer_contents WIDGET -- a literal input ComfyUI hashes into
 * this node's execution-cache signature on every queue attempt,
 * independently of whatever IS_CHANGED() computes (see that method's own
 * docstring in prompt_composer_node.py for the full mechanism). Before
 * this function existed, syncComposerContents() called the visibility-
 * blind usedPromptRefs() directly, so renaming (or otherwise editing) a
 * prompt referenced ONLY by a hidden entry still changed that entry's
 * embedded {name, prompt, category} copy in composer_contents, which
 * changed the widget's JSON string, which moved the cache signature and
 * forced a real re-run -- the exact "renaming a prompt that isn't even
 * visible in the output still reruns the workflow" bug, surviving even
 * after composer_state itself (see serializeForQueue()) was fixed, because
 * it was leaking through this SECOND widget instead.
 */
export function usedPromptRefsForQueue(sections) {
    const refs = new Set();
    for (const section of Array.isArray(sections) ? sections : []) {
        if (!section || section.is_locked_prompt) continue;
        if (section.enabled === false) continue;
        const entries = Array.isArray(section.entries) ? section.entries : [];
        const keepAllEntries = !!section.randomize;
        const visibleEntries = entries.filter((e) => e && e.visible !== false);
        if (visibleEntries.length === 0) continue; // matches serializeForQueue()'s section-level drop
        const eligible = keepAllEntries ? entries : visibleEntries;
        for (const entry of eligible) {
            if (entry && entry.prompt_ref) refs.add(entry.prompt_ref);
        }
    }
    return refs;
}
