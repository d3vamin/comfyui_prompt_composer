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
     * which would previously trigger a full UI re-render (including
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
     * NOT here (see project docs: Approach B, single source of truth).
     */
    serialize() {
        return JSON.stringify(this.sections);
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
