/**
 * ui_toolbars.js
 *
 * Top-level toolbars: the preset selector/actions toolbar, and the
 * section-level bulk-action toolbar (show/hide all, randomize on/off
 * all, label on/off all). Preset actions go through api_client.js
 * (structure-only preset CRUD, per preset_store.py).
 *
 * The per-entry Add/Copy/Paste/Cut/Delete/view-toggle toolbar (the
 * "entry toolbar") lives in ui_panels.js instead, since it's tightly
 * coupled to the entry grid/list it sits above.
 */

import { el } from "./dom_utils.js";
import { uiBtn, countPill } from "./ui_chrome.js";
import { applyCollisionSuffix, lowestFreeNumber } from "./naming.js";
import { shapePresetSectionsForBaseline } from "./workflow_restore.js";
import * as apiClient from "./api_client.js";

/**
 * The filename the server stores a preset under for a given display
 * name -- mirrors `_safe_component()` + ".json" in server/preset_store.py
 * (trim, every non `[A-Za-z0-9_-]` character becomes "_", truncated to
 * 64). Needed to spot two DIFFERENT names that would collide on the SAME
 * file (e.g. "My Preset" vs "My_Preset") before asking the server to
 * rename into it, which would otherwise silently overwrite the other
 * preset. Keep in sync with the Python if that ever changes.
 */
function presetFilenameFor(name) {
    return String(name || "").trim().replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 64) + ".json";
}

/**
 * A stable string form of a sections list, for "did this change?" tests.
 *
 * Object keys are sorted recursively before serialising, because the two
 * sides of the comparison do not necessarily build their objects in the
 * same order: the baseline comes from whatever was live right after a
 * load/save, and the current value is the same data after the user has
 * edited it -- but a section rebuilt by a preset load carries keys in the
 * server's JSON order, while one the client created has its own. A plain
 * JSON.stringify would call those two different and light up the Save
 * button for a preset nobody touched.
 *
 * `undefined` members vanish from JSON.stringify's output, which is what
 * we want: `{order: undefined}` and `{}` are the same thing on disk.
 *
 * Keys with a leading underscore are skipped: they are client-transient
 * plumbing the render pass hangs off section objects for drag-time reads
 * (`_selectedEntryIds`, `_missingEntryIds`, `_moveEntryCallback`), not preset
 * content. A `Set` serialises to `{}`, so leaving them in would make merely
 * VIEWING a section -- with no edit at all -- differ from the saved
 * baseline and light up "unsaved changes".
 *
 * Exported for tests/verify_workflow_restore.mjs, which checks that a
 * workflow-restored composition matching its disk preset fingerprints
 * identically (no false "unsaved" flag).
 */
export function fingerprintSections(sections) {
    const canonical = (value) => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === "object") {
            const out = {};
            for (const key of Object.keys(value).sort()) {
                if (key.startsWith("_")) continue;
                out[key] = canonical(value[key]);
            }
            return out;
        }
        return value;
    };
    return JSON.stringify(canonical(sections || []));
}

/**
 * Builds and manages the preset toolbar, implementing the exact
 * in-place-swap behavior from the spec rather than popup dialogs:
 *
 *   SELECTION mode: dropdown + Save/Reload/Rename/Delete icon buttons. The
 *   dropdown contains saved presets and "New Preset".
 *
 *   OPTIONS mode (entered via New/Save/Rename): the dropdown is replaced
 *   by a name field, with a Save (or Done, when renaming) button and a
 *   Cancel button -- and nothing else. Cancel restores the
 *   previously-selected preset with no changes.
 *
 *   CONFIRM mode (entered via Reload/Delete): the dropdown is locked
 *   (kept visible but disabled) and every other button is replaced by
 *   a single Yes/Cancel pair.
 *
 */
export class PresetToolbar {
    /**
     * @param {object} opts
     * @param {() => object} opts.state - returns the live ComposerState
     * @param {(preset: object) => void} opts.onLoad - called with the
     *   loaded preset (structure only) after a successful load
    * @param {() => void} opts.onNew - resets the composer to a genuinely empty section list (the locked "Prompt" row, no entries) and clears the preset name; called for the dropdown's "New Preset" and when a delete leaves no presets behind
     * @param {(confirmOpts) => Promise<boolean>} opts.confirmDialog - unused
     *   by this toolbar's own reload/delete flow (which uses its own
     *   inline Yes/Cancel per spec) but kept for API compatibility with
     *   callers that already pass one.
     */
    constructor({ state, onLoad, onNew }) {
        this.state = state;
        this.onLoad = onLoad;
        this.onNew = onNew;
        this._selectedFilename = "";
        this._presets = []; // [{name, filename}, ...] cache from the last refreshList()
        this._initialLoadComplete = false;
        // The composition that was open before "New Preset" wiped it, so
        // Cancel can put it back rather than losing unsaved work. See
        // `_startNewPreset`.
        this._preNewSnapshot = null;
        // Fingerprint of the sections as they last stood on disk for the
        // selected preset -- taken fresh on every load and every
        // successful save. Comparing the live composition against it is
        // what drives the Save button's "unsaved changes" colour. Null
        // until something has actually been loaded or written, which
        // reads as "nothing here is saved yet".
        this._savedFingerprint = null;
        this._saveBtn = null; // the selection-mode Save icon, kept for colour updates
        // -- graph-restore reconciliation (see noteWorkflowRestored) ----
        // Set by the host when a workflow's saved state was just applied
        // to the live composition ({ presetName } or null for an
        // unnamed). Non-null means the FIRST list response must select
        // (without loading) the matching disk preset instead of running
        // the "nothing selected yet -> auto-load preset #1" branch,
        // which used to land after configure() and clobber the restored
        // sections with Preset_001.
        this._pendingRestore = null;
        // Whether the constructor's GET /presets has come back at least
        // once, so noteWorkflowRestored knows whether the reconcile has
        // already had its chance to run.
        this._listResolvedOnce = false;
        // One-shot shield: true between a restore being noted and the
        // list response consuming it, so a response that beat
        // configure() (warm cache) can't auto-load in between.
        this._suppressAutoLoad = false;
        // Layer B2: a restore whose composition matches NO disk preset
        // is presented as an in-memory "virtual" preset -- dropdown
        // entry named after the composition, nothing written to disk,
        // and Save (coloured dirty) is what promotes it to a real file.
        // Null whenever no virtual is on offer or it has been consumed.
        this._virtualPreset = null;

        this.root = el("div", "pc-toolbar");
        this._renderSelectionMode();
        this.refreshList();
    }

    /**
     * Called by the host the moment a loaded workflow's own state has
     * been applied to the live composition (onConfigure with pc_state,
     * or the hidden-widget/API-prompt fallback). From here the toolbar's
     * job changes: it must NOT auto-load a preset over that state -- it
     * only has to pick which disk preset (if any) the dropdown should
     * point at, and baseline the dirty flag against it.
     *
     * @param {string|null} presetName - the name the composition was
     *   saved under (pc_preset_name), or null when it had none.
     * @param {object|null} [snapshot] - the workflow's
     *   pc_workflow_snapshot, whose workflow_name names the Layer-B2
     *   virtual preset when the composition matches no disk preset.
     */
    noteWorkflowRestored(presetName, snapshot = null) {
        this._pendingRestore = {
            presetName: presetName || null,
            workflowName: (snapshot && snapshot.workflow_name) || null,
        };
        this._suppressAutoLoad = true;
        this._initialLoadComplete = true;
        // Unknown until the reconcile fetches the disk copy; a null
        // fingerprint reads as "nothing saved yet" (Save coloured),
        // which is the honest answer while the list is still in flight.
        this._savedFingerprint = null;
        if (this._listResolvedOnce) this._consumePendingRestore();
        this.refreshDirtyState();
    }

    /**
     * Apply a pending graph-restore against the now-known preset list.
     * Safe to call from both the list response and noteWorkflowRestored;
     * whichever runs last wins, and a second call is a no-op.
     */
    _consumePendingRestore() {
        if (!this._pendingRestore || !this._listResolvedOnce) return;
        const pending = this._pendingRestore;
        this._pendingRestore = null;
        this._suppressAutoLoad = false; // one-shot; later refreshes behave as before
        const match = pending.presetName
            ? this._presets.find((preset) => preset.name === pending.presetName) || null
            : null;
        // Select WITHOUT loading: the live composition already IS what
        // the workflow held at save time -- reloading the disk copy could
        // differ (preset edited after the workflow was saved) and must
        // not overwrite it. No match (renamed/deleted preset, or the
        // composition was saved unnamed) hands the slot to the Layer-B2
        // virtual preset, named after the composition: what was actually
        // named wins even if its file is gone (the user's own word for
        // this work), else the workflow it was saved inside, else -- an
        // unnamed composition in an unsaved workflow -- there is simply
        // nothing honest to call it, and the dropdown stays empty.
        this._selectedFilename = match ? match.filename : "";
        if (match) {
            this._virtualPreset = null;
            this._baselineAgainstDiskPreset(match.filename);
        } else {
            this._savedFingerprint = null;
            const virtualName = pending.presetName || pending.workflowName || null;
            this._virtualPreset = virtualName ? { name: virtualName } : null;
        }
        if (this._mode === "selection" && this.presetSelect) {
            this._renderSelectionMode();
        } else {
            this.refreshDirtyState();
        }
    }

    /**
     * Set the dirty baseline from the DISK copy of the selected preset
     * without loading it: the restored composition gets compared against
     * what would land if the user pressed Reload. Reshaped through
     * shapePresetSectionsForBaseline so the comparison is apples-to-apples
     * with what a real load would produce (see that function's docstring).
     */
    async _baselineAgainstDiskPreset(filename) {
        try {
            const preset = await apiClient.getPreset(filename);
            if (this._selectedFilename !== filename) return; // superseded
            const shaped = shapePresetSectionsForBaseline(preset.sections, this.state().sections);
            this._savedFingerprint = fingerprintSections(shaped);
            this.refreshDirtyState();
        } catch (err) {
            // Can't verify the disk copy -> leave the baseline null so
            // Save stays coloured; a wrong "saved" claim is worse.
            console.error("Prompt Composer: failed to baseline preset against disk", err);
        }
    }

    /**
     * Re-read the preset list from disk.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.autoLoad=true] - when nothing sensible is
     *   selected yet (first refresh, or the selected preset vanished),
     *   load the first preset. Callers that are about to pick their own
     *   target preset (see `_deleteSelectedPreset`) pass false so this
     *   doesn't race them to preset #1. A pending graph-restore (see
     *   noteWorkflowRestored) outranks auto-load entirely.
     */
    async refreshList({ autoLoad = true } = {}) {
        try {
            this._presets = await apiClient.listPresets();
        } catch (err) {
            console.error("Prompt Composer: failed to list presets", err);
            this._presets = [];
        }
        this._listResolvedOnce = true;
        if (this._pendingRestore) {
            this._consumePendingRestore();
            return;
        }
        // Update the existing <select>'s options in place rather than
        // calling _renderSelectionMode() (which would rebuild the
        // entire toolbar, including handing out a brand-new
        // `this.presetSelect` element). This function resolves
        // asynchronously and can complete well after construction --
        // rebuilding unconditionally would silently orphan any
        // reference to the old presetSelect taken in the meantime
        // (e.g. by a caller reading toolbar.presetSelect right after
        // constructing it), and would also discard whatever mode the
        // toolbar is currently in if called while mid-edit.
        if (this._mode === "selection" && this.presetSelect) {
            this._populateSelectOptions();
            const selectedStillExists = this._presets.some((preset) => preset.filename === this._selectedFilename);
            if (autoLoad && !this._suppressAutoLoad && (!this._initialLoadComplete || !selectedStillExists) && this._presets.length) {
                this._initialLoadComplete = true;
                this._loadPreset(this._presets[0].filename);
            }
        }
    }

    _populateSelectOptions() {
        const select = this.presetSelect;
        select.innerHTML = "";
        const showVirtual = !!this._virtualPreset && !this._selectedFilename;
        if (showVirtual) {
            // The Layer-B2 entry: a TEMP preset that exists only in this
            // node's memory. Nothing was written to disk -- the user
            // decides that (Save), which is exactly what the coloured
            // dirty Save button is signalling while it's selected.
            select.append(
                el("option", null, {
                    value: "__virtual__",
                    text: `${this._virtualPreset.name} (from workflow copy)`,
                })
            );
        }
        for (const p of this._presets) {
            select.append(el("option", null, { value: p.filename, text: p.name }));
        }
        select.append(el("option", null, { value: "__new__", text: "New Preset" }));
        if (showVirtual) select.value = "__virtual__";
        else select.value = this._selectedFilename;
    }

    // -- Mode: selection (dropdown + action icons) ---------------------------

    _renderSelectionMode() {
        this._mode = "selection";
        this.root.innerHTML = "";

        this.presetSelect = el("select", "pc-preset-select");
        this._populateSelectOptions();

        this.presetSelect.addEventListener("change", () => {
            const value = this.presetSelect.value;
            if (value === "__new__") {
                this._startNewPreset();
            } else if (value === "__virtual__") {
                // The in-memory copy IS the live composition already --
                // re-selecting it has nothing to load and must not fall
                // through to _loadPreset("__virtual__") (which would try
                // to fetch a file that does not exist).
            } else {
                this._loadPreset(value);
            }
        });

        const btnSave = uiBtn({ icon: "save", title: "Save preset", onClick: () => this._onSaveClicked() });
        this._saveBtn = btnSave;

        this.root.append(this.presetSelect, btnSave);

        // Reload/Duplicate/Delete operate on a FILE -- they only make
        // sense (and only survive a click) with a disk preset selected.
        // Notably not for the virtual workflow copy: there is nothing on
        // disk to reload into, and "delete" would have no target.
        if (this._selectedFilename) {
            const btnReload = uiBtn({ icon: "reload", title: "Reload preset", onClick: () => this._enterConfirmMode("reload") });
            this.root.append(btnReload);
        }

        if (this._selectedFilename) {
            const btnRename = uiBtn({
                icon: "edit",
                title: "Rename preset",
                onClick: () => this._enterOptionsMode({ mode: "rename" }),
            });
            this.root.append(btnRename);

            const btnDelete = uiBtn({
                icon: "trash",
                title: "Delete preset",
                variant: "danger",
                onClick: () => this._enterConfirmMode("delete"),
            });
            this.root.append(btnDelete);
        }

        // The button is brand new, so it has no colour yet: re-apply the
        // current dirty state as part of building it, rather than waiting
        // for the next render() to notice.
        this._applyDirtyClass();
    }

    // -- Dirty state (Save button colour) ------------------------------------

    /** True when the live composition differs from the selected preset's
     * copy on disk. Public: the host UI reads it for tooltips/labels. */
    isDirty() {
        return fingerprintSections(this.state().sections) !== this._savedFingerprint;
    }

    /** Record the live composition as what disk now holds. Called after
     * every successful load and every successful write -- the only two
     * things that can make the two agree. */
    _markSaved() {
        this._savedFingerprint = fingerprintSections(this.state().sections);
    }

    /**
     * Round 15b: a library rename moves the prompt's ref, and the
     * server sweep rewrote this preset's FILE with the new one while
     * the host relinked our live sections to the SAME value -- the two
     * still agree, but the cached baseline string remembers the old
     * ref and would paint Save green as if the user had edited the
     * preset. A relink is not an edit.
     *
     * Two halves, in this order:
     *  1. Swap the old ref for the new one INSIDE the baseline string,
     *     right now. The host re-renders synchronously after relinking
     *     the sections, and refreshDirtyState would otherwise compare
     *     new-ref sections against an old-ref baseline and flash green
     *     for the round-trip. Refs are full JSON string values in that
     *     fingerprint (quoted, and the quoted token can only ever be a
     *     `prompt_ref`), so this swap is exact.
     *  2. Re-baseline from the (already-rewritten) disk copy as the
     *     authority. This catches the pathological case a string swap
     *     can't -- a user who named a SECTION after the old ref, which
     *     the sweep correctly left alone -- and is the value the button
     *     settles on. If the sweep somehow missed this file, the honest
     *     "differs from disk" answer comes back and the green flag
     *     correctly invites a save.
     *
     * With no selected file (a virtual/unsaved composition) the
     * baseline is null already -- there is nothing stale to fix.
     */
    retargetSavedBaseline(oldRef, newRef) {
        if (!this._selectedFilename) return;
        if (oldRef && newRef && oldRef !== newRef && typeof this._savedFingerprint === "string") {
            const from = JSON.stringify(oldRef);
            const to = JSON.stringify(newRef);
            this._savedFingerprint = this._savedFingerprint.split(from).join(to);
            this.refreshDirtyState();
        }
        this._baselineAgainstDiskPreset(this._selectedFilename);
    }

    /**
     * Re-check the dirty state. Called from the host's render(), which is
     * the single point every content change funnels through.
     *
     * The toolbar is built once and never rebuilt by render() (it lives in
     * the static layout, above the panels that get torn down), so nothing
     * else would ever revisit the Save button's colour.
     */
    refreshDirtyState() {
        this._applyDirtyClass();
    }

    _applyDirtyClass() {
        const btn = this._saveBtn;
        if (!btn || this._mode !== "selection") return;
        const dirty = this.isDirty();
        btn.classList.toggle("pc-preset-save-dirty", dirty);
        btn.title = dirty ? "Save preset (unsaved changes)" : "Save preset";
    }

    async _loadPreset(filename) {
        try {
            const preset = await apiClient.getPreset(filename);
            this._selectedFilename = filename;
            // Committing to a real (disk) preset ends the virtual one's
            // moment: the user chose to work on a saved preset instead.
            this._virtualPreset = null;
            this.onLoad(preset);
            // Baseline taken from the LIVE state after the load rather
            // than from the preset JSON: `onLoad` reshapes it (keeps the
            // existing locked section object, re-sorts by order), and
            // comparing the reshaped form against the raw file would read
            // every freshly-loaded preset as modified.
            this._markSaved();
            if (this._mode === "selection") this._renderSelectionMode();
        } catch (err) {
            console.error("Prompt Composer: failed to load preset", err);
            this._renderSelectionMode(); // restore dropdown to its prior value
            alert("Failed to load preset: " + err.message);
        }
    }

    // -- Deleting ------------------------------------------------------------

    /**
     * Delete the selected preset and land on a neighbour rather than on
     * a blank slate: the preset just ABOVE the one that was deleted, or
     * -- if it was first in the list -- the one just BELOW it, or -- if
     * that leaves nothing -- a freshly created, empty "Preset_001".
     *
     * "Above"/"below" mean adjacent in the dropdown, which is the
     * name-sorted order the server returns (see preset_store.list_presets),
     * so the selection moves exactly one step up the list the person is
     * looking at. Once the deleted entry is gone, whatever used to sit
     * after it occupies the deleted one's old index, which is why the
     * "next" preset is simply `_presets[index]` of the refreshed list.
     */
    async _deleteSelectedPreset() {
        const filename = this._selectedFilename;
        const index = this._presets.findIndex((preset) => preset.filename === filename);
        await apiClient.deletePreset(filename);
        this._selectedFilename = "";
        await this.refreshList({ autoLoad: false });

        const previous = index > 0 ? this._presets[index - 1] : null;
        const target = previous || this._presets[index] || this._presets[0] || null;
        if (target) {
            await this._loadPreset(target.filename);
            return;
        }
        await this._createEmptyPreset();
    }

    /**
     * Fallback for a delete that emptied the presets folder: build a
     * blank preset (just the locked "Prompt" section, no entries), save
     * it under the first free Preset_NNN, and select it -- so the
     * dropdown always has something current pointing at it.
     */
    async _createEmptyPreset() {
        this.onNew(); // reset the composer to an empty section list
        const name = this._nextAvailablePresetName();
        try {
            this.state().presetName = name;
            const result = await apiClient.savePreset(name, this.state().sections);
            this._selectedFilename = result.filename;
            this._markSaved();
        } catch (err) {
            console.error("Prompt Composer: failed to create an empty preset", err);
        }
        await this.refreshList({ autoLoad: false });
    }

    /**
     * The lowest free "Preset_###" name for a brand-new preset, scanned
     * against the preset list currently loaded.
     *
     * This is the unified trailing-number convention (see naming.js)
     * applied to the preset name space: gap-fill from _001 upwards,
     * three-digit minimum, width growing past 999 naturally -- the same
     * rule the section-name and prompt_data import paths follow. It has
     * to be gap-fill rather than "highest number + 1" or a fixed
     * default: a hardcoded suggestion hands back a name that is already
     * taken the second time around (the old behaviour kept offering
     * Preset_002 forever, so every new preset after the first collided
     * with the previous one).
     *
     *   001, 002, 006, 007            -> Preset_003
     *   001..007 all present          -> Preset_008
     *   nothing yet                   -> Preset_001
     *
     * Compared by target FILENAME, not display name, because the server
     * maps "Preset_003" and "Preset 003" to the same Preset_003.json --
     * either one already in the list makes the generated name unsafe to
     * offer.
     */
    _nextAvailablePresetName() {
        const takenFilenames = new Set(this._presets.map((preset) => preset.filename));
        const n = lowestFreeNumber(
            "Preset",
            (candidate) => takenFilenames.has(presetFilenameFor(candidate)),
            1
        );
        return applyCollisionSuffix("Preset", n);
    }

    // -- Mode: options (name field + Done/Save + Cancel) ---------------------

    /**
     * The dropdown's "New Preset" option: reset the composer to a
     * genuinely empty section list (just the locked "Prompt" row, no
     * custom sections and no entries) and then open the name field.
     *
     * It used to skip the reset entirely, so the "new" preset was saved
     * from whatever composition happened to be on screen -- a silent
     * copy of the preset you already had, which is the opposite of what
     * picking "New Preset" reads as.
     *
     * The outgoing composition is snapshotted first. Without that,
     * Cancel would have nothing to go back to and choosing "New Preset"
     * by accident would throw away unsaved work the instant the name
     * field appeared; with it, Cancel restores the previous preset's
     * sections, name, and active section exactly as they stood --
     * including any edits that were never saved to disk.
     */
    _startNewPreset() {
        const state = this.state();
        this._preNewSnapshot = {
            sections: state.sections,
            presetName: state.presetName,
            activeSectionId: state.activeSectionId,
            // A Cancel must give the virtual workflow copy back too, if
            // that was the offered preset before "New Preset" cleared
            // the field -- the user backing out chose nothing permanent.
            virtualPreset: this._virtualPreset,
        };
        this._virtualPreset = null; // the offered copy is being set aside
        this.onNew(); // empty section list + presetName cleared + re-render
        this._enterOptionsMode({ mode: "new" });
    }

    /**
     * Put back what `_startNewPreset` cleared, if anything. A no-op for
     * the other ways into options mode (Save / Save As / Rename), which
     * never touched the live composition and so never took a snapshot.
     */
    _restorePreNewSnapshot() {
        if (!this._preNewSnapshot) return;
        const snapshot = this._preNewSnapshot;
        this._preNewSnapshot = null;
        const state = this.state();
        state.sections = snapshot.sections;
        state.presetName = snapshot.presetName;
        state.activeSectionId = snapshot.activeSectionId;
        // (older snapshots taken field-by-field simply carry undefined
        // here, which is the correct "no virtual" restore anyway)
        this._virtualPreset = snapshot.virtualPreset || null;
        state.notify();
    }

    /**
     * @param {object} opts
     *   @param {"new"|"rename"|"save-as"} opts.mode
     *   @param {string|null} [opts.defaultName] - overrides the pre-fill
     *     for "new": when a virtual workflow copy is on offer we want to
     *     save UNDER ITS NAME, not a fresh Preset_###. Ignored for the
     *     other modes (rename/save-as pre-fill from the live state).
     *
     * "new":    name field pre-filled with the first free
     *     Preset_### (see `_nextAvailablePresetName`, or the supplied
     *     defaultName), Save button.
     *     Reached from the dropdown via `_startNewPreset`, which has
     *     already emptied the section list, or straight from the Save
     *     icon when no preset is selected -- which keeps the live
     *     composition, since that is a "save my current work" gesture
     *   "rename": pre-filled with the current name, Done button -- renames
     *     the selected preset IN PLACE (see `_renamePresetTo`), it does
     *     not write a second preset file and it does not save the live
     *     composition; that stays the Save button's job
     *   "save-as": entered right after pressing the toolbar's own Save
     *     icon on a selected preset -- pre-filled with its name, Save
     *     button, writes a NEW preset file under the typed name
     *
     * No variant of this mode shows a Delete button any more: deleting is
     * the selection toolbar's trash icon (with its own Yes/Cancel
     * confirm), not something to stumble into while renaming.
     */
    _enterOptionsMode({ mode, defaultName = null }) {
        const previousFilename = this._selectedFilename;
        // Live-typing in the name field doubles as "this composition's
        // name" (smoke feedback #1): saving the WORKFLOW (or queueing)
        // without ever pressing Save still carries it via
        // pc_preset_name, so a reload offers "typed name (from workflow
        // copy)". Cancel undoes it; a successful commit overwrites it
        // with the same value anyway.
        const previousPresetName = this.state().presetName;
        this._mode = "options";
        this.root.innerHTML = "";

        const isNew = mode === "new";
        const isRename = mode === "rename";
        const currentName = isNew ? "" : this.state().presetName || "";

        const nameInput = el("input", "pc-text-input pc-preset-name-input", {
            type: "text",
            placeholder: "Preset name",
        });
        // "New Preset" suggests the first free Preset_### rather than a
        // fixed name, so consecutive new presets never collide. Read at
        // open time, against the list as it stands right now -- and
        // recomputed on every entry into this mode, which is what fixes
        // the old "stuck on Preset_002" behaviour. A caller-supplied
        // defaultName (the virtual workflow copy's name, see
        // _onSaveClicked) wins over the generated suggestion: pressing
        // Save on "X (from workflow copy)" should hand back "X", not
        // Preset_004.
        nameInput.value = isNew
            ? (defaultName || this._nextAvailablePresetName())
            : currentName;

        nameInput.addEventListener("input", () => {
            // The mirror behind the comment at the top of this method.
            // Trim-only: whitespace typed so far is not a name yet.
            const nm = nameInput.value.trim();
            this.state().presetName = nm || null;
        });

        const errorLabel = countPill({ inert: true, extra: "pc-entry-toolbar-count", text: "" });
        errorLabel.style.display = "none";

        const saveBtn = uiBtn({
            text: isRename ? "Done" : "Save",
            variant: "primary",
            onClick: async () => {
                const name = nameInput.value.trim();
                if (!name) return;
                errorLabel.style.display = "none";
                try {
                    if (isRename) {
                        const filename = await this._renamePresetTo(name, previousFilename);
                        this.state().presetName = name;
                        this._selectedFilename = filename;
                        await this.refreshList();
                        this._renderSelectionMode();
                        return;
                    }
                    // Committing the new preset: the snapshot of the
                    // composition "New Preset" replaced is now obsolete,
                    // and keeping it around would let a later Cancel
                    // resurrect a preset the user has moved on from.
                    // Cleared only once the write has actually landed --
                    // if it fails we stay in options mode with the
                    // snapshot intact so Cancel can still put the old
                    // composition back. (Sections were already emptied by
                    // `_startNewPreset` when we got here from the
                    // dropdown; this handler deliberately does NOT touch
                    // them, so the other way into "new" mode -- the Save
                    // icon with nothing selected -- still saves the live
                    // composition.)
                    this.state().presetName = name;
                    const result = await apiClient.savePreset(name, this.state().sections);
                    this._selectedFilename = result.filename;
                    // Whatever virtual copy was on offer has now become
                    // a real file (possibly under an edited name) -- the
                    // in-memory stand-in is spent.
                    this._virtualPreset = null;
                    this._markSaved(); // disk and screen agree again
                    if (isNew) this._preNewSnapshot = null;
                    await this.refreshList();
                    this._renderSelectionMode();
                } catch (err) {
                    errorLabel.textContent = err.message || (isRename ? "Failed to rename preset." : "Failed to save preset.");
                    errorLabel.style.display = "inline";
                }
            },
        });

        const cancelBtn = uiBtn({
            text: "Cancel",
            onClick: () => {
                // Restore the previously-selected preset with no changes,
                // per spec: "If the user cancel and didn't save the
                // preset, it will cancel saving the preset and back to
                // the preset selection toolbar with the previous preset
                // selected." Undoing "New Preset"'s reset is part of
                // that -- otherwise backing out would have cost the user
                // the composition they were working on.
                // (Order matters: undo the live name mirror FIRST, then
                // let a "new"-mode snapshot overwrite it with the true
                // pre-reset name; other modes have no snapshot, so the
                // undo stands.)
                this.state().presetName = previousPresetName;
                this._restorePreNewSnapshot();
                this._selectedFilename = previousFilename;
                this._renderSelectionMode();
            },
        });

        this.root.append(nameInput, saveBtn, cancelBtn, errorLabel);
    }

    /**
     * Rename the selected preset in place and return the filename it now
     * lives at.
     *
     * Goes through the server's rename endpoint (write the new file, then
     * remove the old one) rather than save-under-new-name, which is what
     * used to happen here and left the original preset sitting next to
     * its renamed copy -- the preset appeared to be duplicated rather
     * than renamed.
     *
     * @param {string} newName
     * @param {string} fromFilename - the preset being renamed
     * @returns {Promise<string>} the resulting filename
     * @throws {Error} if another preset already occupies the new name
     */
    async _renamePresetTo(newName, fromFilename) {
        if (!fromFilename) {
            // Nothing on disk to rename (the Rename button only ever
            // renders for a selected preset) -- fall back to saving
            // under the new name rather than failing outright.
            const result = await apiClient.savePreset(newName, this.state().sections);
            return result.filename;
        }

        const targetFilename = presetFilenameFor(newName);
        if (targetFilename === fromFilename) {
            return fromFilename; // name effectively unchanged: nothing to do
        }
        const collision = this._presets.find(
            (preset) => preset.filename !== fromFilename && preset.filename === targetFilename
        );
        if (collision) {
            throw new Error(`A preset named "${collision.name}" already exists.`);
        }

        const result = await apiClient.renamePreset(fromFilename, newName);
        return result.filename;
    }

    _onSaveClicked() {
        // The toolbar's own Save icon: writes the CURRENT composition to
        // disk under the typed name. With a preset already selected that
        // means a NEW file alongside it (save-as) -- deliberately
        // different from the Rename icon, which moves the existing file
        // and never duplicates it. With a virtual workflow copy selected
        // it is the PROMOTION gesture (design guide B2): same "new"
        // mode, but pre-filled with the copy's name so one click saves
        // the composition under the name it arrived with.
        const promoteVirtual = !this._selectedFilename && this._virtualPreset;
        this._enterOptionsMode({
            mode: this._selectedFilename ? "save-as" : "new",
            defaultName: promoteVirtual ? this._virtualPreset.name : null,
        });
    }

    // -- Mode: confirm (locked dropdown + Yes/Cancel) ------------------------

    _enterConfirmMode(action) {
        this._mode = "confirm";
        this.root.innerHTML = "";

        const lockedSelect = el("select", "pc-preset-select");
        lockedSelect.append(el("option", null, { text: this.state().presetName || "Preset" }));
        lockedSelect.disabled = true;
        this.root.append(lockedSelect);

        const message = action === "reload" ? "Reload this preset? Unsaved changes will be lost." : "Delete this preset? This cannot be undone.";
        this.root.append(countPill({ inert: true, extra: "pc-entry-toolbar-count", text: message }));

        const yesBtn = uiBtn({
            text: "Yes",
            variant: action === "delete" ? "danger" : "primary",
            onClick: async () => {
                try {
                    if (action === "reload") {
                        await this._loadPreset(this._selectedFilename);
                    } else {
                        await this._deleteSelectedPreset();
                    }
                } catch (err) {
                    console.error("Prompt Composer: preset action failed", err);
                    alert(`Failed to ${action} preset: ` + (err?.message || err));
                } finally {
                    this._renderSelectionMode();
                }
            },
        });
        const cancelBtn = uiBtn({ text: "Cancel", onClick: () => this._renderSelectionMode() });

        this.root.append(yesBtn, cancelBtn);
    }
}

/**
 * Renders the section-level bulk-action toolbar (show/hide all,
 * randomize on/off all, label on/off all) into `container`. Pure
 * render function (no persistent object needed) since it has no state
 * of its own beyond what's read from `sections` at call time.
 */
export function renderSectionToolbar(container, sections, notify) {
    container.innerHTML = "";
    const targets = sections.filter((s) => !s.is_locked_prompt);

    const btn = (title, iconName, onClick) => uiBtn({ icon: iconName, title, onClick });

    container.append(
        btn("Show all sections", "eye", () => {
            targets.forEach((s) => (s.enabled = true));
            notify();
        }),
        btn("Hide all sections", "eyeOff", () => {
            targets.forEach((s) => (s.enabled = false));
            notify();
        }),
        btn("Randomize ON for all sections", "shuffle", () => {
            targets.forEach((s) => (s.randomize = true));
            notify();
        }),
        btn("Randomize OFF for all sections", "shuffleoff", () => {
            targets.forEach((s) => (s.randomize = false));
            notify();
        }),
        btn("Show section name label for all sections", "tag", () => {
            targets.forEach((s) => (s.show_label = true));
            notify();
        }),
        btn("Hide section name label for all sections", "tagoff", () => {
            targets.forEach((s) => (s.show_label = false));
            notify();
        })
    );
}
