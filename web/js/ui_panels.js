/**
 * ui_panels.js
 *
 * Left panel (section list) + right panel (entry grid/list, edit
 * panels, library panel) + the reusable confirm dialog. This is the
 * bulk of the interactive UI, assembled by prompt_composer.js's
 * ComposerUI host class.
 *
 * Design notes for the panels assembled by ComposerUI:
 *  - Entry cards/rows render NAME/PROMPT/THUMBNAIL resolved live
 *    from the library (via a small per-render resolve cache; see
 *    resolveEntryDisplay), not from locally-stored entry.name/text.
 *  - Entry cards/rows carry VISIBILITY (Show/Hide, the persisted
 *    output-inclusion toggle) as well as allow_random/entry_separator.
 *    Terminology (unified): "visible" = entry Show/Hide; "selected" =
 *    the top-right checkbox (bulk actions); "enabled" = section toggle.
 *  - "Add entry" opens the Library panel to pick a prompt_ref, rather
 *    than a blank name/prompt edit form -- there is nothing to type on
 *    an Entry anymore.
 *  - A "Duplicate entry" action exists (copies id fresh, same
 *    prompt_ref) since the same prompt_ref may appear multiple times.
 *  - The old free-form Entry Options edit panel (name/prompt/thumbnail
 *    fields on an Entry) is GONE -- editing a prompt's actual content
 *    now only happens in the Library panel, on the prompt_data itself,
 *    via LibraryController.
 */

import { el, wireDragReorder } from "./dom_utils.js";
import { svgIcon } from "./icons.js";
import { uiBtn, uiToggle, countPill } from "./ui_chrome.js";
import { registerBadgeRow } from "./badge_fit.js";
import { randomColor, correctPromptName } from "./naming.js";
import { sectionSearchBlob } from "./library_search.js";
import {
    ENTRY_SEPARATOR_GLYPH,
    normalizeEntrySeparator,
    END_SEPARATOR_GLYPH,
    normalizeEndSeparator,
    cycleEndSeparator,
} from "./separators.js";
import * as apiClient from "./api_client.js";
import {
    isFavoriteCategory,
    isFavoriteEntry,
    withoutFavorite,
    withFavoritePinned,
    buildFavoriteStar,
} from "./favorites.js";

// ---------------------------------------------------------------------------
// Reusable confirm/approval dialog
// ---------------------------------------------------------------------------

/**
 * Creates a reusable pair of approval dialogs anchored inside
 * `hostPanel` (must have position: relative set by the caller), both
 * sharing one overlay element so at most one can ever be showing at a
 * time:
 *
 *   - showConfirmDialog(opts) -> Promise<boolean> : the original
 *     yes/no dialog (Cancel / Confirm), unchanged.
 *   - showChoiceDialog(opts) -> Promise<string|null> : a 3+-option
 *     variant (e.g. Copy / Move / Cancel) for actions with more than
 *     one non-cancel outcome. Resolves to the `value` of whichever
 *     choice was clicked, or null if cancelled/dismissed.
 *
 * Kept as a single factory (rather than two separate ones) specifically
 * so both dialogs share the exact same overlay node -- if a second
 * call comes in while one is already open, .innerHTML = "" below
 * clears whatever was showing rather than stacking a second overlay
 * on top of the first.
 */
export function createConfirmDialog(hostPanel) {
    const overlay = el("div", "pc-confirm-overlay-backdrop");
    overlay.style.display = "none";
    hostPanel.append(overlay);

    /** The dialog chrome shared by every modal question: box with
     * optional title/message, a row of buttons (each resolving to its
     * own `value`), Escape and backdrop-click resolving to
     * `cancelValue`, and full listener/innerHTML teardown on settle.
     * The two entry points below differ ONLY in buttons + cancel value. */
    function showDialog({ title, message, buttons, cancelValue }) {
        return new Promise((resolve) => {
            overlay.innerHTML = "";

            const box = el("div", "pc-confirm-box");
            if (title) box.append(el("div", "pc-confirm-title", { text: title }));
            if (message) box.append(el("div", "pc-confirm-message", { text: message }));

            const actions = el("div", "pc-confirm-actions");
            for (const b of buttons) {
                actions.append(uiBtn({ text: b.label, variant: b.variant, onClick: () => finish(b.value) }));
            }
            box.append(actions);

            overlay.append(box);
            overlay.style.display = "flex";

            const onBackdropClick = (e) => {
                if (e.target === overlay) finish(cancelValue);
            };
            const onKeydown = (e) => {
                if (e.key === "Escape") finish(cancelValue);
            };
            overlay.addEventListener("click", onBackdropClick);
            document.addEventListener("keydown", onKeydown);

            const finish = (result) => {
                overlay.style.display = "none";
                overlay.innerHTML = "";
                overlay.removeEventListener("click", onBackdropClick);
                document.removeEventListener("keydown", onKeydown);
                resolve(result);
            };
        });
    }

    function showConfirmDialog({ title, message, confirmLabel = "Delete", cancelLabel = "Cancel", danger = true }) {
        return showDialog({
            title,
            message,
            cancelValue: false,
            buttons: [
                { label: cancelLabel, value: false },
                { label: confirmLabel, value: true, variant: danger ? "danger" : "primary" },
            ],
        });
    }

    /**
     * `choices`: array of { value, label, primary? }. `primary: true`
     * styles that one button as the highlighted/default action (e.g.
     * "Move"); all others render as plain buttons. A dedicated Cancel
     * button (resolving to null) is always appended last regardless of
     * what's passed in `choices` -- callers should NOT include their
     * own cancel option in `choices`.
     */
    function showChoiceDialog({ title, message, choices, cancelLabel = "Cancel" }) {
        return showDialog({
            title,
            message,
            cancelValue: null,
            buttons: [
                ...choices.map((c) => ({
                    label: c.label,
                    value: c.value,
                    variant: c.primary ? "primary" : undefined,
                })),
                { label: cancelLabel, value: null },
            ],
        });
    }

    showConfirmDialog.choice = showChoiceDialog;
    return showConfirmDialog;
}

// ---------------------------------------------------------------------------
// Left panel: section list
// ---------------------------------------------------------------------------

/**
 * The alert chip: an ICON-ONLY button (round 28: alertTriangle glyph)
 * sitting LEFT of the section counter on section rows. It is RED while
 * the section holds entries whose prompts resolve to NOTHING
 * (library-missing and no workflow-snapshot stand-in either), and
 * AMBER while it holds entries displayed via the workflow's embedded
 * COPY (their library prompt is gone; the snapshot text stands in).
 * Red outranks amber when both occur; the chip hides entirely at
 * zero/zero. The tooltip lists only the NON-ZERO tallies -- "Missing:
 * N" and/or "Workflow: N".
 *
 * (There is deliberately NO Library-row chip: library prompt cards are
 * by definition just what exists in the library folder -- missing and
 * workflow-copy states belong to preset ENTRIES, not to library rows.)
 *
 * It is a TOGGLE: clicking arms an alerts-only view filter -- the
 * entry list then shows ONLY the missing/workflow-copy cards of that
 * section. The armed chip wears the green ring (.pc-on) and its click
 * stops there (not a row select); arming another section's chip MOVES
 * the ring. The live zero-guard (arming a scope that just went clean
 * is refused) sits inside the ComposerUI handler -- re-asked on every
 * click, round-21c doctrine.
 *
 * applyAlertCounts is shared by the row BUILD and ComposerUI's
 * in-place patcher, so build-time and patch-time chips can never
 * disagree about what a pair of counts looks like.
 */
export function applyAlertCounts(chip, counts, armed) {
    const missing = (counts && counts.missing) || 0;
    const workflow = (counts && counts.workflow) || 0;
    chip.hidden = missing <= 0 && workflow <= 0;
    chip.classList.toggle("pc-alert-red", missing > 0);
    chip.classList.toggle("pc-alert-amber", missing <= 0 && workflow > 0);
    chip.classList.toggle("pc-on", !!armed);
    const lines = [];
    if (missing > 0) lines.push(`Missing: ${missing}`);
    if (workflow > 0) lines.push(`Workflow: ${workflow}`);
    chip.title = lines.join("\n");
}

function buildAlertChip(alertKey, counts, armed, onToggle) {
    // The row's OWN icon-button skin (pc-icon-btn: eye/shuffle/tag) plus
    // the alert-specific colors/ring -- never a duplicated button base.
    // (uiBtn bare branch: family skin + shared .pc-pressable states.)
    const chip = uiBtn({
        icon: "alertTriangle",
        size: 12,
        bare: true,
        extra: "pc-icon-btn pc-section-alert",
        hook: "sectionAlert",
        hookValue: alertKey,
        onClick: (e) => {
            e.stopPropagation();
            onToggle();
        },
    });
    applyAlertCounts(chip, counts, armed);
    return chip;
}

export function renderLeftPanel(leftPanel, { state, countVisible, isLibraryActive, libraryColor, visibleOnlySectionId = null, alertCountsFor = null, alertsOnlyMode = null, onToggleAlertFilter, onOpenLibrary, onOpenLibraryColorEdit, onSelectSection, onOpenSectionEdit, onAddSection, onDropLibraryPrompts, onDropCrossSectionEntries, onToggleCountFilter, onSectionFlagsChanged }) {
    // The section toolbar (buildStaticLayout's this.sectionToolbar) is
    // appended into leftPanel ONCE, permanently, above everything this
    // function manages -- per spec, the Left Panel's top-to-bottom
    // contents are: Section toolbar, section list, Add section button.
    // Clearing leftPanel.innerHTML unconditionally would wipe that
    // toolbar out on every render, so instead we remove and rebuild
    // only the list+add-button elements, leaving any other existing
    // children (i.e. the toolbar) untouched.
    for (const child of Array.from(leftPanel.children)) {
        if (!child.classList.contains("pc-section-toolbar")) child.remove();
    }

    const list = el("div", "pc-section-list");

    // "Library" is not a real section -- it never contributes to
    // compose, is never saved into presets, and has no entries/
    // randomize/separator/label properties (per spec: "It only has
    // the Color property"). It's rendered here as a synthetic first
    // row, pinned above even the locked "Prompt" row, and is NOT
    // draggable/reorderable ("it will sit on the top of the section
    // list and can not move"). Its only per-row action is a color
    // swatch (opens a minimal color-only edit), matching "Library...
    // It only has the Color property (Default color: Blue)".
    const libraryRow = el("div", "pc-section-row pc-library-row" + (isLibraryActive ? " pc-active-row" : ""));
    if (libraryColor) {
        libraryRow.style.background = `color-mix(in srgb, ${libraryColor} 25%, #262626)`;
    }
    libraryRow.addEventListener("dragover", (e) => {
        if (!e.dataTransfer || !e.dataTransfer.types.includes("text/pc-library-prompt")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "none";
        libraryRow.classList.add("pc-drop-forbidden");
    });
    libraryRow.addEventListener("dragleave", () => libraryRow.classList.remove("pc-drop-forbidden"));
    libraryRow.addEventListener("drop", (e) => {
        if (!e.dataTransfer || !e.dataTransfer.getData("text/pc-library-prompt")) return;
        e.preventDefault();
        libraryRow.classList.remove("pc-drop-forbidden");
    });
    const librarySwatch = uiBtn({
        bare: true,
        extra: "pc-swatch",
        title: "Library color",
        onClick: (e) => {
            e.stopPropagation();
            onOpenLibraryColorEdit();
        },
    });
    librarySwatch.style.background = libraryColor || "#4a90d9";
    // The same pencil other section swatches carry (see the swatch build
    // below): the affordance reads "this swatch edits the section", and
    // for Library that edit is its color panel.
    librarySwatch.innerHTML = svgIcon("edit", 12);
    const libraryIcon = el("span", "pc-icon-btn", { text: "" });
    libraryIcon.innerHTML = svgIcon("folder");
    const libraryName = el("div", "pc-section-name", { text: "Library" });
    libraryRow.append(librarySwatch, libraryIcon, libraryName);
    libraryRow.addEventListener("click", () => onOpenLibrary());
    list.append(libraryRow);

    state.sections.forEach((section) => {
        const row = el(
            "div",
            "pc-section-row" +
                (!isLibraryActive && section.id === state.activeSectionId ? " pc-active-row" : "") +
                (section.enabled ? "" : " pc-disabled")
        );
        row.dataset.sectionId = section.id;

        // The enabled/disabled row look is ONE rule pair (dim class +
        // tinted inline background), written once and re-applied by the
        // in-place enable/disable patch below -- build and patch can
        // never disagree.
        const applyEnabledLook = (on) => {
            row.classList.toggle("pc-disabled", !on);
            if (on) row.style.background = `color-mix(in srgb, ${section.color} 25%, #262626)`;
            else row.style.removeProperty("background");
        };
        if (section.enabled) applyEnabledLook(true);

        const swatch = uiBtn({
            bare: true,
            extra: "pc-swatch",
            title: "Section options",
            onClick: (e) => {
                e.stopPropagation();
                onOpenSectionEdit(section.id);
            },
        });
        swatch.style.background = section.color;
        swatch.innerHTML = svgIcon("edit", 12);

        const visBtn = uiToggle({
            on: section.enabled,
            iconOn: "eye",
            iconOff: "eyeOff",
            titleOn: "Disable section",
            titleOff: "Enable section",
            bare: true,
            noHover: true,
            extra: "pc-icon-btn",
            onClick: (e) => {
                e.stopPropagation();
                // Round 41: a section's Enable/Disable redraws its OWN
                // row (icon, ring, dim + tint) and recomposes; it never
                // changes the entry grid -- so patch in place and let
                // the light chrome-notify do the rest. No list rebuild.
                const on = section.enabled = !section.enabled;
                visBtn.applyState(on);
                applyEnabledLook(on);
                onSectionFlagsChanged(section);
            },
        });

        const randBtn = uiToggle({
            on: section.randomize,
            iconOn: "shuffle",
            iconOff: "shuffleoff",
            title: "Randomize on queue",
            bare: true,
            noHover: true,
            extra: "pc-icon-btn",
            onClick: (e) => {
                e.stopPropagation();
                if (section.is_locked_prompt) return;
                const on = section.randomize = !section.randomize;
                randBtn.applyState(on);
                onSectionFlagsChanged(section);
            },
        });
        if (section.is_locked_prompt) randBtn.style.visibility = "hidden";

        const labelBtn = uiToggle({
            on: section.show_label,
            iconOn: "tag",
            iconOff: "tagoff",
            titleOn: "Hide section label",
            titleOff: "Show section label",
            bare: true,
            noHover: true,
            extra: "pc-icon-btn",
            onClick: (e) => {
                e.stopPropagation();
                if (section.is_locked_prompt) return;
                const on = section.show_label = !section.show_label;
                labelBtn.applyState(on);
                onSectionFlagsChanged(section);
            },
        });
        if (section.is_locked_prompt) labelBtn.style.visibility = "hidden";

        const name = el("div", "pc-section-name", { text: section.name });

        // "N visible / M total" pill -- and (round 21) the sole entry
        // point for the VISIBLE-ONLY view filter: click arms it for this
        // section (selecting it first if needed); click again on the
        // ringed, active row disarms. The green 2px ring is .pc-on and
        // rides ONLY the active row, because the filter narrows exactly
        // one panel -- the one you are looking at. dataset.sectionCountFilter
        // is the in-place patch hook (see _patchSectionCountRing).
        // Round 21b: at zero visible the pill is INERT -- tooltip "No
        // visible entries", no ring, and no arming. Round 21c: that
        // decision is made LIVE inside one permanently-attached handler
        // (re-ask countVisible on every click) instead of attaching/
        // detaching handlers per state -- a chip that became non-empty
        // in place works on the very next click, and there is only EVER
        // one handler mechanism, so nothing can double-fire. An inert
        // click does not stopPropagation, so it bubbles to the row and
        // selects the section like a click anywhere else on it.
        const visible = countVisible(section);
        const countEmpty = visible <= 0;
        const countOn = visibleOnlySectionId === section.id;
        const count = section.is_locked_prompt ? null : countPill({
            tag: "div",
            extra: "pc-section-count" + (countEmpty ? " pc-section-count-empty" : ""),
            on: countOn,
            title: countEmpty
                ? "No visible entries"
                : countOn
                    ? "Showing visible entries only - click to show all"
                    : "Click to show only visible entries",
            onClick: (e) => {
                if (countVisible(section) <= 0) return;
                e.stopPropagation();
                onToggleCountFilter(section);
            },
            hook: "sectionCountFilter",
            hookValue: section.id,
            children: [el("span", "pc-section-count-value", { text: `${visible}/${section.entries.length}` })],
        });

        const endSepBtn = !section.is_locked_prompt
            ? uiBtn({
                  extra: "pc-end-separator-btn",
                  onClick: (e) => {
                      e.stopPropagation();
                      // Round 41: cycling redraws just this button (the
                      // post-build apply below owns title + glyph), no
                      // list rebuild.
                      section.end_separator = cycleEndSeparator(section.end_separator);
                      applyEndSep();
                      onSectionFlagsChanged(section);
                  },
              })
            : null;
        const applyEndSep = () => {
            const endSeparator = normalizeEndSeparator(section.end_separator);
            endSepBtn.title = `End separator for "${section.name}" (click to cycle): ${endSeparator}`;
            // Round 59: pc-always-visible means what it already means on
            // the entry separator button -- "this flag is SET, light the
            // control gold". The section-row button is always laid out,
            // so here the class rides as color only (see CSS).
            endSepBtn.classList.toggle("pc-always-visible", endSeparator !== "none");
            if (endSeparator === "none") endSepBtn.innerHTML = svgIcon("none", 10);
            else endSepBtn.textContent = END_SEPARATOR_GLYPH[endSeparator];
        };
        if (endSepBtn) applyEndSep();

        // Round 42: one closure per row that re-derives ALL flag chrome
        // from the section's LIVE state. The bulk section toolbar (Show
        // all / Randomize OFF for all / ...) flips these same flags for
        // every section at once and calls this for each mounted row --
        // the same in-place contract as a single toggle click, so the
        // list never rebuilds.
        row._pcSync = () => {
            visBtn.applyState(section.enabled);
            applyEnabledLook(section.enabled);
            randBtn.applyState(section.randomize);
            labelBtn.applyState(section.show_label);
            if (endSepBtn) applyEndSep();
        };

        const meta = el("div", "pc-section-row-meta");
        // Round 26: alert chip LEFT of the counter pill -- built on EVERY
        // row (locked ones included; they have no pill but can absolutely
        // have dead or workflow-copy cards) and hidden at 0/0, so the
        // in-place patcher always finds the node.
        meta.append(buildAlertChip(section.id, alertCountsFor ? alertCountsFor(section) : null,
            alertsOnlyMode === section.id, () => onToggleAlertFilter(section)));
        if (count) meta.append(count);
        if (endSepBtn) meta.append(endSepBtn);

        row.append(swatch, visBtn, randBtn, labelBtn, name);
        if (meta.childNodes.length) row.append(meta);

        row.addEventListener("click", () => onSelectSection(section.id));

        row.addEventListener("dragover", (e) => {
            if (!e.dataTransfer) return;
            const isLibraryDrag = e.dataTransfer.types.includes("text/pc-library-prompt");
            const isCrossSectionDrag = e.dataTransfer.types.includes("text/pc-cross-section-entries");
            if (!isLibraryDrag && !isCrossSectionDrag) return;
            if (section.is_locked_prompt) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "none";
                row.classList.add("pc-drop-forbidden");
                return;
            }
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            row.classList.add("pc-drop-valid");
        });
        row.addEventListener("dragleave", () => {
            row.classList.remove("pc-drop-valid", "pc-drop-forbidden");
        });
        row.addEventListener("drop", (e) => {
            if (!e.dataTransfer) return;
            row.classList.remove("pc-drop-valid", "pc-drop-forbidden");

            const crossSectionRaw = e.dataTransfer.getData("text/pc-cross-section-entries");
            if (crossSectionRaw) {
                e.preventDefault();
                if (section.is_locked_prompt) return;
                try {
                    const payload = JSON.parse(crossSectionRaw);
                    if (payload && payload.sourceSectionId && Array.isArray(payload.entryIds) && payload.entryIds.length) {
                        // Dropping onto the SAME section it came from is
                        // not a cross-section action at all -- ignore it
                        // silently rather than popping a copy/move
                        // dialog for a no-op (reordering within a
                        // section is handled entirely by
                        // wireDragReorder's own onDrop, on the entry
                        // cards/rows themselves, not here).
                        if (payload.sourceSectionId !== section.id) {
                            onDropCrossSectionEntries?.({
                                sourceSectionId: payload.sourceSectionId,
                                targetSectionId: section.id,
                                entryIds: payload.entryIds,
                            });
                        }
                    }
                } catch (_) {}
                return;
            }

            if (!e.dataTransfer.getData("text/pc-library-prompt")) return;
            e.preventDefault();
            if (section.is_locked_prompt) return;
            const raw = e.dataTransfer.getData("text/pc-library-prompt");
            try {
                const refs = JSON.parse(raw);
                if (Array.isArray(refs) && refs.length) onDropLibraryPrompts?.({ sectionId: section.id, refs });
            } catch (_) {}
        });

        wireDragReorder(row, {
            dragType: "text/pc-section",
            getDragIds: () => [section.id],
            getSelfId: () => section.id,
            getIndex: () => state.sections.findIndex((s) => s.id === section.id),
            onDrop: (ids, targetIndex) => state.moveSection(ids[0], targetIndex),
        });

        list.append(row);
    });

    const addSectionBtn = uiBtn({ bare: true, extra: "pc-add-section-btn", icon: "plus", size: 14, onClick: onAddSection });

    leftPanel.append(list, addSectionBtn);
}

// ---------------------------------------------------------------------------
// Entry display resolution (small per-render cache)
// ---------------------------------------------------------------------------

/**
 * Resolves a batch of prompt_refs for DISPLAY purposes (name, prompt
 * preview text, thumbnail) in the entry grid/list. Uses the same
 * /resolve endpoint as the preview (see ui_preview.js) -- this is
 * display convenience, not the authoritative compose-time resolution,
 * but it's still backed by the identical library_store.resolve_many()
 * call so there's no risk of the grid showing something different from
 * what the library actually contains.
 */
export async function resolveForDisplay(promptRefs) {
    return (await tryResolveForDisplay(promptRefs)) || {};
}

/**
 * Same batch resolve as `resolveForDisplay`, but it can tell "the
 * server says this ref is gone" apart from "we never got an answer".
 * Returns `null` when the request itself failed (network/server error),
 * rather than an empty object -- an empty object means "every ref in
 * the batch is missing", and a caller that can't tell the two apart
 * would silently treat a transient failure as mass deletion. Callers
 * that get `null` back should fall back to their permissive behavior.
 */
export async function tryResolveForDisplay(promptRefs) {
    const unique = Array.from(new Set((promptRefs || []).filter(Boolean)));
    if (!unique.length) return {};
    try {
        return await apiClient.resolvePromptRefs(unique);
    } catch (err) {
        console.error("Prompt Composer: failed to resolve entries for display", err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Entry toolbar (add/duplicate/cut/paste/delete + view toggle)
// ---------------------------------------------------------------------------

/**
 * Tooltip text for the entry toolbar's Copy/Cut buttons. When some of
 * the selected entries are missing (their prompt_ref no longer resolves
 * to anything in the library), say so up front rather than letting the
 * button quietly act on a subset of what the person checked.
 */
export function missingAwareLabel(baseLabel, skippedCount) {
    if (!skippedCount) return baseLabel;
    return `${baseLabel} — ${skippedCount} missing ${skippedCount === 1 ? "entry" : "entries"} skipped`;
}

/**
 * The contextual bulk-action bar: everything that operates on a SET of
 * cards rather than on the panel itself. Callers place it directly below
 * the panel's own toolbar and only while there is something to act on.
 *
 * `showClipboardActions` is what separates the two panels. Copy/Cut/Paste
 * only mean anything for section entries -- a library prompt is a file on
 * disk, with no prompt clipboard and no target to paste into -- so the
 * Library panel passes false and gets Delete plus the selection controls.
 */
export function buildBulkActionToolbar({
    scope,
    selectedCount,
    copyableSelectedCount,
    showClipboardActions = false,
    noun = "entries",
    selectedOnly = false,
    onCopy,
    onCut,
    onDelete,
    onSelectAll,
    onClearSelected,
    onToggleSelectedOnly,
}) {
    const toolbar = el("div", "pc-bulk-toolbar");
    toolbar.dataset.bulkToolbar = scope;

    const count = selectedCount;
    // Entries whose prompt_ref no longer resolves carry nothing but a dead
    // pointer, so they can't be meaningfully copied/cut. Delete still acts
    // on every selected card, missing or not -- removing a dead pointer is
    // exactly what you would want to do with one.
    const copyable = typeof copyableSelectedCount === "number" ? copyableSelectedCount : count;
    const skippedCount = Math.max(0, count - copyable);

    const group = el("div", "pc-entry-toolbar-group");

    if (showClipboardActions) {
        const btnCopy = uiBtn({
            icon: "copy",
            title: missingAwareLabel(`Copy selected ${noun} (paste here or in another section)`, skippedCount),
            onClick: onCopy,
            hook: "entryAction",
            hookValue: "copy",
            disabled: copyable === 0,
        });
        const btnCut = uiBtn({
            icon: "cut",
            title: missingAwareLabel(`Cut selected ${noun}`, skippedCount),
            onClick: onCut,
            hook: "entryAction",
            hookValue: "cut",
            disabled: copyable === 0,
        });
        group.append(btnCopy, btnCut);
    }

    const btnDelete = uiBtn({
        icon: "trash",
        title: `Delete selected ${noun}`,
        variant: "danger",
        onClick: onDelete,
        hook: "entryAction",
        hookValue: "delete",
        disabled: count === 0,
    });
    group.append(btnDelete);

    // The whole selection cluster -- the count, Select all, Deselect all --
    // describes a selection that exists. The bar itself is only built while
    // something is selected, so in practice this always renders; the guard
    // keeps a caller from ever getting a bar that says "0 selected".
    if (count > 0) {
        // The count is also the "show only selected" VIEW toggle (round 17):
        // clicking it narrows the panel to exactly these cards via the
        // panel's ordinary display filter pass -- it changes no state, and
        // clicking again widens back out. It used to clear the selection on
        // click; that command has its own Deselect-all button right here,
        // so nothing was lost. While ON, .pc-on draws the green 2px ring (css):
        // the number you can SEE through is ringed. The dataset-hook
        // doctrine applies: the bar is rebuilt whole, the in-place patch
        // looks the chip up by attribute.
        const label = countPill({
            extra: "pc-entry-toolbar-count",
            on: selectedOnly,
            title: selectedOnly
                ? `Showing selected ${noun} only - click to show all`
                : `Show only the selected ${noun}`,
            text: `${count} selected`,
            onClick: onToggleSelectedOnly,
            hook: "entrySelectedOnlyToggle",
        });

        const selectAll = uiBtn({
            icon: "list",
            size: 16,
            title: `Select all ${noun}`,
            type: "button",
            onClick: onSelectAll,
            extra: "pc-entry-selection-reset",
            hook: "entrySelectionSelectAll",
        });

        const clearSelected = uiBtn({
            icon: "cancel",
            size: 16,
            title: `Deselect all ${noun}`,
            type: "button",
            onClick: onClearSelected,
            extra: "pc-entry-selection-reset",
            hook: "entrySelectionClear",
        });

        group.append(label, selectAll, clearSelected);
    }

    toolbar.append(group);
    return toolbar;
}

export function buildEntryToolbar(section, { viewMode, searchVisible, hasClipboard = false, onAdd, onPaste, onShowAll, onHideAll, onToggleView, onToggleSearch }) {
    const toolbar = el("div", "pc-entry-toolbar");
    toolbar.dataset.entryToolbar = "section";

    const btnAdd = uiBtn({
        icon: "plus",
        title: "Add entry from library",
        onClick: onAdd,
        extra: "pc-add-entry-btn",
        hook: "entryAction",
        hookValue: "add",
    });

    // Paste sits next to Add because that is what it does: it puts entries
    // into this section, exactly like picking them from the library. It is
    // also the one bulk-ish action that is NOT about the selection -- it
    // keys off the clipboard -- so it deliberately does not live in the
    // bulk bar below, which only exists while cards are selected. Hidden
    // rather than disabled: with nothing on the clipboard there is no
    // paste to hint at.
    const left = el("div", "pc-entry-toolbar-group");
    left.append(btnAdd);
    if (hasClipboard) {
        const btnPaste = uiBtn({
            icon: "paste",
            title: "Paste copied/cut entries here",
            type: "button",
            onClick: onPaste,
            hook: "entryAction",
            hookValue: "paste",
        });
        left.append(btnPaste);
    }

    // Everything else that acts on a SET of entries -- copy/cut/delete and
    // the selection controls -- lives in buildBulkActionToolbar, which
    // renders directly below this bar while something is selected. What is
    // left here is panel-level only: adding, pasting, the show/hide-all
    // visibility toggles, search, and the grid/list switch.
    const spacer = el("div", "pc-entry-toolbar-spacer");

    // Hoisted for the Hide-all gate below: its purpose is to bring views
    // BACK, so Show-all stays rendered even at zero -- but Hide-all has
    // nothing to hide when no card is visible, so it hides itself (same
    // build-time-staleness trade as refreshEntryToolbarHideAllGate).
    const visibleCount = section.entries.filter((entry) => entry.visible).length;

    const showAll = uiBtn({
        icon: "eye",
        title: "Show all entries",
        type: "button",
        onClick: onShowAll,
        extra: "pc-view-toggle",
    });

    const hideAll = uiBtn({
        icon: "eyeOff",
        size: 16,
        title: "Hide all entries",
        type: "button",
        onClick: onHideAll,
        extra: "pc-entry-selection-reset",
        hook: "entryHideAll",
    });
    hideAll.hidden = visibleCount <= 0;

    // Stable hook for the targeted show/hide in
    // ComposerUI._applySectionSearchToggle -- the toolbar node gets
    // rebuilt whole on selection/clipboard changes, so the patch looks
    // this button up by attribute instead of caching a reference.
    const btnSearchToggle = uiToggle({
        on: searchVisible,
        icon: "search",
        titleOn: "Hide search",
        titleOff: "Show search",
        onClick: onToggleSearch,
        hook: "entrySearchToggle",
    });

    const btnViewToggle = uiBtn({
        icon: viewMode === "grid" ? "list" : "grid",
        title: viewMode === "grid" ? "Switch to list view" : "Switch to grid view",
        type: "button",
        onClick: onToggleView,
        extra: "pc-view-toggle",
    });

    toolbar.append(left, spacer, showAll, hideAll, btnSearchToggle, btnViewToggle);
    return toolbar;
}

// ---------------------------------------------------------------------------
// Entry card / row (grid + list view)
// ---------------------------------------------------------------------------

/**
 * @param {object} entry - the Entry (id, prompt_ref, visible, allow_random, entry_separator)
 * @param {object} display - resolved {name, prompt, category} for entry.prompt_ref, or null if unresolved (missing)
 *
 * NOTE on the unified pick/select model (grid view only): clicking the
 * card body toggles ONE flag that serves two purposes at once --
 * whether this entry is included in the composed output (entry.visible)
 * AND whether it counts toward the entry toolbar's bulk-action
 * selection (selected/highlighted, used for copy/cut/delete). These were
 * previously two separate concepts; per an explicit product decision,
 * grid cards now treat them as the same thing: a highlighted card IS
 * an included-in-output card, and vice versa. This means copy/cut/
 * delete in the entry toolbar always act on exactly the currently-
 * included entries -- there is no way to bulk-select entries for those
 * actions without also toggling their output inclusion. List view
 * (buildEntryListRow) is UNCHANGED and still keeps these as two
 * separate concepts (its own dedicated check/x button for inclusion,
 * row click for bulk-select).
 *
 * The card's top-left button, which used to BE the inclusion toggle,
 * is now the Options/Edit button (matching the Library card's pencil
 * button) -- clicking it opens the Edit Prompt panel for
 * the prompt_data this entry points to, exactly like the Library
 * card's own options button.
 */
/**
 * @param {object} entry - the Entry (id, prompt_ref, visible, allow_random, entry_separator)
 * @param {object} display - resolved {name, prompt, category} for entry.prompt_ref, or null if unresolved (missing)
 *
 * Two independent concepts, both grid and list view (reverted from an
 * earlier unified-click experiment):
 *   - entry.visible: whether this entry is included in the composed
 *     output. Toggled by clicking the card/row body.
 *   - "selected": transient bulk-action selection (copy/cut/delete via
 *     the entry toolbar), tracked by the caller (ComposerUI's
 *     selectedEntryIds) and never persisted. Toggled ONLY via the
 *     dedicated checkbox -- top-right on grid cards, right side on
 *     list rows -- never by clicking the card/row body itself, so the
 *     two actions can't be confused for one another. While selected,
 *     the card's THUMBNAIL carries an inset --pc-info glow over its
 *     inner edge (a ::after overlay stacking above the image, under the
 *     hover overlay and the star/checkbox/options controls), so a glance
 *     finds the selected set without the eye visiting each corner.
 *
 * There is no per-entry delete button anymore in either view -- bulk
 * delete (via the entry toolbar, acting on whatever's checked) is the
 * only way to remove entries now, which is also why the checkbox
 * replaces the delete button's old position.
 */
/**
 * The set of entry ids a drag on `entry` carries: the whole bulk-selected
 * set (in section order) when the dragged card is itself selected -- so
 * dragging any one of several checked entries acts on all of them, the
 * same unit the toolbar's copy/cut/delete already use -- or just the
 * dragged entry when it isn't selected, so a single drag needs no checkbox
 * first. Read lazily from `section._selectedEntryIds` at drag-start time
 * (set in prompt_composer.js right before the grid/list is built) so it
 * always reflects what is checked the moment the drag actually begins.
 */
function entryDragIds(section, entry) {
    const selected = section._selectedEntryIds;
    if (selected && selected.has(entry.id) && selected.size > 0) {
        return section.entries.filter((e) => selected.has(e.id)).map((e) => e.id);
    }
    return [entry.id];
}

/**
 * Unified drag wiring for one entry card/row -- grid and list call this
 * one function, so both views behave identically. A SINGLE dragstart
 * publishes both payloads any target reads (the old code wired two
 * separate dragstart listeners for the same two payloads):
 *
 *  - "text/pc-entry" (via wireDragReorder): the same-section reorder set,
 *    INCLUDING missing entries -- moving a broken card around the list it
 *    is already in clones nothing, so it stays reorderable.
 *  - "text/pc-cross-section-entries": { sourceSectionId, entryIds } for a
 *    copy/move onto another section's row. Missing entries are dropped
 *    here (a dead pointer copied elsewhere is just a second broken card),
 *    exactly like the toolbar's Copy/Cut. If nothing live remains the
 *    payload is not set, so no section row lights up for it.
 *
 * `vertical` picks the insertion-line split: false for the horizontal
 * grid, true for the vertical list.
 */
function wireEntryDrag(element, section, entry, { vertical }) {
    wireDragReorder(element, {
        dragType: "text/pc-entry",
        vertical,
        // Entry cards are ALSO dropped on a section row as a cross-section
        // COPY (dropEffect "copy"); effectAllowed must include "copy" or
        // the browser silently refuses to fire "drop" on that target.
        effectAllowed: "copyMove",
        getDragIds: () => entryDragIds(section, entry),
        getSelfId: () => entry.id,
        getIndex: () => section.entries.findIndex((e) => e.id === entry.id),
        onDrop: (ids, targetIndex) => section._moveEntryCallback?.(ids, targetIndex),
        onDragStart: (e) => {
            const missing = section._missingEntryIds;
            const ids = entryDragIds(section, entry);
            const crossIds = missing ? ids.filter((id) => !missing.has(id)) : ids;
            if (!crossIds.length) return; // nothing live -> no cross-section drop offered
            e.dataTransfer.setData(
                "text/pc-cross-section-entries",
                JSON.stringify({ sourceSectionId: section.id, entryIds: crossIds })
            );
        },
    });
}

/**
 * The inline marker for an entry whose prompt does NOT exist in this
 * machine's library but whose TEXT was carried inside the loaded
 * workflow's pc_workflow_snapshot (see workflow_restore.js
 * mergeWorkflowContent). It is deliberately not the red "(Missing)"
 * treatment -- the person can see the prompt, which is the whole point.
 * Clicking asks the host to SAVE the copy into the library (Layer B5):
 * same name, same text, categories carried too; the server's collision
 * rules apply and on success the live entry takes the card over.
 */
export function buildWorkflowCopyBadge(onClick) {
    return uiBtn({
        bare: true,
        extra: "pc-entry-workflow-badge",
        text: "workflow copy",
        title:
            "Not in the local library -- showing the copy embedded in this workflow. " +
            "Click to save it into the Library and make this entry live again.",
        onClick: (e) => {
            e.stopPropagation();
            if (onClick) onClick();
        },
    });
}

/**
 * Thumbnail stand-in for an entry whose prompt_ref no longer resolves
 * (the library prompt it pointed to was deleted/renamed). On top of the
 * warning glyph it prints the entry's CURRENT prompt_ref as text: once
 * the prompt itself is gone, that pointer is the only identifying
 * information the entry still carries, and without it every broken card
 * in a grid looks identical -- the person can't tell which prompt they
 * need to go re-add, or which of several broken entries is the one they
 * were just working on.
 *
 * @param {string} promptRef - the entry's raw (unresolvable) prompt_ref
 * @returns {HTMLElement} element to drop into a .pc-entry-image-wrap
 */
export function buildMissingThumbnail(promptRef, showRef = true) {
    const wrap = el("div", "pc-entry-image-placeholder pc-entry-image-placeholder-missing");
    wrap.append(el("div", "pc-entry-missing-glyph", { text: "!" }));

    if (showRef) {
        const ref = (promptRef || "").trim();
        wrap.append(
            el("div", "pc-entry-missing-ref", {
                text: ref || "(no prompt_ref)",
                title: ref ? `Missing prompt_ref: ${ref}` : "This entry has no prompt_ref",
            })
        );
    }

    return wrap;
}

/**
 * The thumbnail a prompt with NO image shows: a flat dark-gray tile with
 * an orange "image off" glyph centered. This is the on-screen face of a
 * thumbnail-less prompt_data (stored as a .txt -- see library_store);
 * it is NOT the same as a MISSING entry (buildMissingThumbnail), which
 * is a dead pointer to a prompt that no longer exists.
 */
export function buildNoThumbnailPlaceholder() {
    const wrap = el("div", "pc-entry-image-placeholder pc-entry-image-placeholder-nothumb");
    wrap.title = "No thumbnail";
    wrap.innerHTML = svgIcon("imageOff", 26);
    return wrap;
}

/**
 * The searchable text and category list a card/row carries in its dataset,
 * which is what lets a keystroke filter the grid without a re-render.
 *
 * One function on purpose: the card and the row have to agree
 * character for character. When they drifted -- the grid filtering on
 * `display.name` while the cards carried no searchable dataset at all
 * -- typing in a section did nothing until some unrelated action
 * forced a render, and then the list would change all at once. The
 * name is matched as the decoded Prompt Name the server displays (see
 * library_store.decode_prompt_name) -- the filename's underscore
 * encoding is deliberately invisible here.
 *
 * Round 35: the blob moved into the shared engine (sectionSearchBlob)
 * and now includes the category names -- the same word-AND haystack
 * the Library rows stamp, so "red cat" works identically in either
 * panel. The blob stays the FALLBACK matcher only: rows the resolve
 * index knows about are scored field-by-field (name > category >
 * prompt) for the ranking; the blob decides nothing the scorer would
 * disagree with (word-AND over a blob of those same fields is the
 * identical predicate).
 */
export function entrySearchDataset(entry, display) {
    return {
        searchText: sectionSearchBlob(entry, display),
        categories: JSON.stringify(display?.category || []),
        // Round 27: the row-26 alert status, stamped on the CARD itself
        // so the alert filter (chip toggle) is one dataset read per card,
        // exactly like the visibility class -- and it can never disagree
        // with what the row's "!" chip counts, because both classify the
        // same merged display object. "" = nothing to isolate.
        entryAlert: !display ? "missing" : display.from_workflow ? "workflow" : "",
    };
}

/**
 * The one-line prompt preview a list-view row shows.
 *
 * The row is `white-space: nowrap; overflow: hidden; text-overflow:
 * ellipsis`, so CSS already clips it -- but clipping happens AFTER the
 * browser has shaped and laid out the whole string, and a ComfyUI
 * prompt can run to several thousand characters. Every visible row
 * paying for thousands of characters to show about sixty is a large
 * share of the remaining gap between "row builds" and "card builds"
 * (a grid card's equivalent text is capped at 140 characters inside a
 * hover overlay a fifth the width). The badge-row batching in
 * js/badge_fit.js was the bigger half of that gap; this is the second.
 * Cutting at 160 whitespace-collapsed characters is strictly invisible
 * -- it is well past what the row can ever show -- while bounding the
 * per-row layout cost.
 *
 * Search is unaffected: the full text still rides in the card's
 * data-search-text (see entrySearchDataset), which is what the filter
 * matches against.
 */
export function listPromptPreview(text) {
    const MAX_PREVIEW_CHARS = 160;
    const flat = (text || "").replace(/\s+/g, " ").trim();
    if (flat.length <= MAX_PREVIEW_CHARS) return flat;
    return `${flat.slice(0, MAX_PREVIEW_CHARS).trimEnd()} \u2026`;
}

export function buildEntryCard(section, entry, display, { selected, onToggleVisible, onToggleSelected, onOptions, onToggleRandom, onCycleSeparator, onDuplicate, onReplace, onRestore }) {
    const card = el("div", "pc-entry-card" + (entry.visible ? " pc-entry-visible" : " pc-entry-hidden") + (selected ? " pc-selected" : ""));
    card.style.setProperty("--accent", section.color);
    card.dataset.entryId = entry.id;
    Object.assign(card.dataset, entrySearchDataset(entry, display));

    const imageWrap = el("div", "pc-entry-image-wrap");
    imageWrap.style.setProperty("--accent", section.color);
    if (display) {
        if (display.has_thumbnail === false) {
            // A thumbnail-less prompt (a .txt on disk): dark tile + orange
            // image-off glyph, not a broken <img> request.
            imageWrap.append(buildNoThumbnailPlaceholder());
        } else {
            // draggable=false: an <img> is natively draggable, so grabbing the
            // thumbnail would start a browser image drag (carrying the prompt
            // PNG) instead of the card's custom reorder drag -- and dropping
            // that PNG on the canvas loads it as a workflow. Forcing the image
            // non-draggable keeps the CARD the sole drag source.
            // loading=lazy + decoding=async: a section with hundreds of
            // entries otherwise fires every thumbnail fetch at once and
            // each decode lands on the frame the user is scrolling through.
            const img = el("img", "pc-entry-image", {
                src: apiClient.libraryImageUrl(entry.prompt_ref),
                draggable: "false",
                loading: "lazy",
                decoding: "async",
            });
            imageWrap.append(img);
        }
        imageWrap.append(buildThumbnailOverlay(display.prompt, withoutFavorite(display.category)));
        // An entry is a pointer into the library, so the star here REPORTS
        // the prompt's favorite state rather than changing it -- flipping
        // it from inside a section would silently edit a library record.
        // Only rendered when the prompt actually is a favorite: an outline
        // star on every other card would be noise, and "is this one
        // favorited?" is the only question worth the pixels.
        if (isFavoriteEntry(display)) {
            imageWrap.append(buildFavoriteStar({ favorite: true, placement: "grid" }));
        }
    } else {
        imageWrap.append(buildMissingThumbnail(entry.prompt_ref));
    }

    // The label slot. When the prompt resolves this is its name; when it
    // doesn't, the "(Missing)" action takes that SAME slot instead of
    // the name -- not a third row stacked under it. That keeps the card
    // the same two-row shape as every other card in the grid (the
    // thumbnail above already prints the dead prompt_ref, see
    // buildMissingThumbnail), and it's still a real <button> rather than
    // plain red text so the person has an obvious next step: clicking it
    // opens the Library panel in "pick a replacement" mode (see
    // ComposerUI.startReplacingEntry), which then points this SAME entry
    // at whichever prompt they click there.
    const label = display
        ? el("div", "pc-entry-label")
        : uiBtn({
              bare: true,
              extra: "pc-entry-missing-btn pc-entry-missing-btn-card",
              text: "(Missing)",
              title: entry.prompt_ref
                  ? `This entry's prompt was removed from the library. Click to choose a replacement.\n\nMissing prompt_ref: ${entry.prompt_ref}`
                  : "This entry has no prompt_ref. Click to choose a prompt.",
              onClick: (e) => {
                  e.stopPropagation();
                  onReplace();
              },
          });
    if (display) {
        // Name and badge as flex siblings (smoke feedback #2): the bare
        // text + append form let a long name push the badge out of the
        // label's overflow-hidden box -- the badge simply vanished. The
        // name span ellipsizes; the badge never shrinks and never wraps.
        label.append(el("span", "pc-entry-label-name", { text: display.name }));
        if (display.from_workflow) label.append(buildWorkflowCopyBadge(onRestore || onReplace));
    }

    const optionsBtn = uiBtn({
        bare: true,
        extra: "pc-entry-options-btn",
        noStep: true, // absolute overlay (round 43)
        icon: "edit",
        size: 12,
        title: "Edit prompt",
        onClick: (e) => {
            e.stopPropagation();
            onOptions();
        },
    });

    // Bulk-selection checkbox, top-right on the card. Deliberately a real
    // <input type="checkbox"> (not another icon button) so its
    // checked state is visually unambiguous at a glance, distinct
    // from the other icon toggles on the card.
    const selectCheckbox = el("input", "pc-entry-select-checkbox", { type: "checkbox" });
    selectCheckbox.checked = !!selected;
    selectCheckbox.title = "Select for bulk actions (copy/cut/delete)";
    selectCheckbox.addEventListener("click", (e) => e.stopPropagation());
    selectCheckbox.addEventListener("change", () => onToggleSelected());

    const randomBtn = uiToggle({
        on: entry.allow_random,
        iconOn: "shuffle",
        iconOff: "shuffleoff",
        size: 12,
        titleOn: "Randomizable (click to exclude from randomization)",
        titleOff: "Excluded from randomization (click to allow)",
        onClass: "pc-on pc-always-visible",
        bare: true,
        extra: "pc-entry-random-btn",
        noStep: true, // bottom-anchored overlay: top would teleport it
        onClick: (e) => {
            e.stopPropagation();
            onToggleRandom();
        },
    });

    const entrySep = normalizeEntrySeparator(entry.entry_separator);
    const separatorBtn = uiBtn({
        bare: true,
        extra: "pc-entry-separator-btn" + (entrySep !== "none" ? " pc-always-visible" : ""),
        noStep: true, // bottom-anchored overlay
        title: `Entry separator: ${entrySep} (click to cycle none → , → and)`,
        onClick: (e) => {
            e.stopPropagation();
            onCycleSeparator();
        },
    });
    if (entrySep === "none") separatorBtn.innerHTML = svgIcon("none", 14);
    else separatorBtn.textContent = ENTRY_SEPARATOR_GLYPH[entrySep];

    card.append(imageWrap, label, optionsBtn, selectCheckbox, randomBtn, separatorBtn);

    card.addEventListener("click", (e) => {
        if (e.target.closest("button, input")) return;
        onToggleVisible();
    });

    wireEntryDrag(card, section, entry, { vertical: false });

    return card;
}

export function buildEntryListRow(section, entry, display, { selected, onToggleVisible, onToggleSelected, onToggleRandom, onCycleSeparator, onDuplicate, onOptions, onReplace, onRestore }) {
    const row = el("div", "pc-entry-row" + (selected ? " pc-selected" : "") + (entry.visible ? " pc-entry-visible" : " pc-entry-hidden"));
    row.style.setProperty("--accent", section.color);
    row.dataset.entryId = entry.id;
    Object.assign(row.dataset, entrySearchDataset(entry, display));

    const thumbWrap = el("div", "pc-entry-row-thumb");
    if (display) {
        if (display.has_thumbnail === false) {
            thumbWrap.append(buildNoThumbnailPlaceholder());
        } else {
            thumbWrap.append(el("img", "pc-entry-image", {
                src: apiClient.libraryImageUrl(entry.prompt_ref),
                draggable: "false",
                loading: "lazy",
                decoding: "async",
            }));
        }
    } else {
        thumbWrap.append(buildMissingThumbnail(entry.prompt_ref, false));
    }

    const optionsBtn = uiBtn({
        bare: true,
        extra: "pc-entry-options-btn pc-entry-row-options-overlay",
        noStep: true,
        icon: "edit",
        size: 12,
        title: "Edit prompt",
        onClick: (e) => {
            e.stopPropagation();
            onOptions();
        },
    });
    thumbWrap.append(optionsBtn);

    const textWrap = el("div", "pc-entry-row-text");
    if (display) {
        const name = el("div", "pc-entry-row-name");
        // Same flex-name-then-badge structure as buildEntryCard's label
        // (smoke feedback #2): the long name ellipsizes instead of
        // shoving the badge out of the row.
        name.append(el("span", "pc-entry-label-name", { text: display.name }));
        if (display.from_workflow) name.append(buildWorkflowCopyBadge(onRestore || onReplace));
        const promptText = el("div", "pc-entry-row-prompt", { text: listPromptPreview(display.prompt) });
        textWrap.append(name, promptText);
        const badgeCategories = withoutFavorite(display.category);
        // The favorite IS a category, so it rides the badge row as its
        // FIRST badge -- same level, same height as its siblings. A
        // section row only ever builds it when the prompt actually is a
        // favorite (this only REPORTS; the Library row is the toggle),
        // but a favorite alone still earns the row.
        const rowFavorite = isFavoriteEntry(display);
        if (badgeCategories.length || rowFavorite) {
            const badgeRow = buildOverflowBadgeRow(badgeCategories, "pc-library-card-badges");
            if (rowFavorite) {
                badgeRow.prepend(buildFavoriteStar({ favorite: true, placement: "list" }));
            }
            textWrap.append(badgeRow);
        }
    } else {
        // Same swap as buildEntryCard's label slot: the "(Missing)"
        // action takes the NAME line rather than hanging underneath it,
        // so the row keeps its normal two-line shape. The dead
        // prompt_ref -- the only identifying information this entry has
        // left -- takes the prompt-preview line, mirroring the grid
        // card's thumbnail (see buildMissingThumbnail). Still a real
        // clickable control rather than plain red text, so there's an
        // obvious next step.
        const missingBtn = uiBtn({
            bare: true,
            extra: "pc-entry-missing-btn pc-entry-missing-btn-row",
            text: "(Missing)",
            title: entry.prompt_ref
                ? `This entry's prompt was removed from the library. Click to choose a replacement.\n\nMissing prompt_ref: ${entry.prompt_ref}`
                : "This entry has no prompt_ref. Click to choose a prompt.",
            onClick: (e) => {
                e.stopPropagation();
                onReplace();
            },
        });
        const refLine = el("div", "pc-entry-row-prompt pc-entry-row-prompt-missing", {
            text: entry.prompt_ref ? `prompt_ref: ${entry.prompt_ref}` : "prompt_ref: (none)",
        });
        textWrap.append(missingBtn, refLine);
    }

    const randomBtn = uiToggle({
        on: entry.allow_random,
        iconOn: "shuffle",
        iconOff: "shuffleoff",
        size: 12,
        titleOn: "Randomizable (click to exclude from randomization)",
        titleOff: "Excluded from randomization (click to allow)",
        onClass: "pc-on pc-always-visible",
        bare: true,
        extra: "pc-entry-random-btn pc-entry-row-action",
        onClick: (e) => {
            e.stopPropagation();
            onToggleRandom();
        },
    });

    const entrySepList = normalizeEntrySeparator(entry.entry_separator);
    const separatorBtn = uiBtn({
        bare: true,
        extra: "pc-entry-separator-btn pc-entry-row-action" + (entrySepList !== "none" ? " pc-always-visible" : ""),
        title: `Entry separator: ${entrySepList} (click to cycle none → , → and)`,
        onClick: (e) => {
            e.stopPropagation();
            onCycleSeparator();
        },
    });
    if (entrySepList === "none") separatorBtn.innerHTML = svgIcon("none", 14);
    else separatorBtn.textContent = ENTRY_SEPARATOR_GLYPH[entrySepList];

    // Bulk-selection checkbox, right side of the row (see buildEntryCard
    // for why a real checkbox rather than another icon button).
    const selectCheckbox = el("input", "pc-entry-select-checkbox pc-entry-row-action pc-always-visible", { type: "checkbox" });
    selectCheckbox.checked = !!selected;
    selectCheckbox.title = "Select for bulk actions (copy/cut/delete)";
    selectCheckbox.addEventListener("click", (e) => e.stopPropagation());
    selectCheckbox.addEventListener("change", () => onToggleSelected());

    const actions = el("div", "pc-entry-row-actions");
    actions.append(randomBtn, separatorBtn, selectCheckbox);

    row.append(thumbWrap, textWrap, actions);

    row.addEventListener("click", (e) => {
        if (e.target.closest("button, input")) return;
        onToggleVisible();
    });

    wireEntryDrag(row, section, entry, { vertical: true });

    return row;
}

// ---------------------------------------------------------------------------
// Section edit panel
// ---------------------------------------------------------------------------

/**
 * Minimal edit panel for the "Library" row's only property (its
 * accent color). Library is not a real section -- it has no name to
 * rename, no label/end-separator, and can't be deleted -- so this is
 * deliberately smaller than renderSectionEditPanel. Round 40 (user):
 * the color row is the section panel's own (picker + randomize).
 * Round 41 (user): the draft is STAGED like the other panels -- the
 * picker and randomize only move the swatch; Done applies, Cancel
 * discards. Nothing hits the library until a button is pressed.
 */
export function renderLibraryColorEditPanel(rightPanel, currentColor, { onSave, onClose }) {
    const panel = el("div", "pc-edit-panel");
    panel.append(el("div", "pc-panel-title", { text: "Library Color" }));

    const colorRow = el("div", "pc-field-row");
    colorRow.append(el("label", null, { text: "Accent color" }));
    const colorInput = el("input", "pc-color-input", { type: "color" });
    colorInput.value = currentColor || "#4a90d9";
    const randomColorButton = uiBtn({
        icon: "reload",
        size: 14,
        title: "Randomize accent color",
        type: "button",
        onClick: () => {
            colorInput.value = randomColor();
        },
    });
    colorRow.append(colorInput, randomColorButton);

    const actions = el("div", "pc-edit-actions");
    const doneBtn = uiBtn({
        text: "Done",
        variant: "primary",
        onClick: () => {
            onSave(colorInput.value);
            onClose();
        },
    });
    const cancelBtn = uiBtn({ text: "Cancel", onClick: onClose });
    actions.append(doneBtn, cancelBtn);

    panel.append(colorRow, actions);
    rightPanel.append(panel);
}

export function renderSectionEditPanel(rightPanel, section, { state, onClose, onDelete, confirmDialog }) {
    const originalSection = {
        name: section.name,
        color: section.color,
        end_separator: section.end_separator,
        show_label: section.show_label,
        randomize: section.randomize,
    };
    const panel = el("div", "pc-edit-panel");
    panel.append(el("div", "pc-panel-title", { text: "Section Options" }));

    const nameRow = el("div", "pc-field-row");
    nameRow.append(el("label", null, { text: "Name" }));
    const nameInput = el("input", "pc-text-input", { type: "text" });
    nameInput.value = section.name;
    nameInput.addEventListener("input", () => {
        section.name = nameInput.value;
    });
    nameRow.append(nameInput);

    const colorRow = el("div", "pc-field-row");
    colorRow.append(el("label", null, { text: "Accent color" }));
    const colorInput = el("input", "pc-color-input", { type: "color" });
    colorInput.value = section.color;
    colorInput.addEventListener("change", () => {
        section.color = colorInput.value;
    });
    const randomColorButton = uiBtn({
        icon: "reload",
        size: 14,
        title: "Randomize accent color",
        type: "button",
        onClick: () => {
            section.color = randomColor();
            colorInput.value = section.color;
        },
    });
    colorRow.append(colorInput, randomColorButton);

    const endSepRow = el("div", "pc-field-row");
    endSepRow.append(el("label", null, { text: "Section Separator" }));
    const endSepSelect = el("select", "pc-sep-select");
    for (const [value, labelText] of [["none", "None"], ["period", "Period ( . )"], ["comma", "Comma ( , )"]]) {
        const opt = el("option", null, { value, text: labelText });
        if (normalizeEndSeparator(section.end_separator) === value) opt.selected = true;
        endSepSelect.append(opt);
    }
    endSepSelect.addEventListener("change", () => {
        section.end_separator = endSepSelect.value;
    });
    endSepRow.append(endSepSelect);

    const labelRow = el("div", "pc-checkbox-field");
    const labelCheckbox = el("input", null, { type: "checkbox" });
    labelCheckbox.checked = !!section.show_label;
    labelCheckbox.addEventListener("change", () => {
        section.show_label = labelCheckbox.checked;
    });
    labelRow.append(labelCheckbox, el("label", null, { text: ` Prefix output with "${section.name}: "` }));

    const randRow = el("div", "pc-field-row");
    if (!section.is_locked_prompt) {
        const randCheckbox = el("input", null, { type: "checkbox" });
        randCheckbox.checked = section.randomize;
        randCheckbox.addEventListener("change", () => {
            section.randomize = randCheckbox.checked;
        });
        randRow.append(randCheckbox, el("label", null, { text: " Randomize on queue" }));
    }

    const actions = el("div", "pc-edit-actions");
    const doneBtn = uiBtn({
        text: "Done",
        variant: "primary",
        onClick: () => {
            state.renameSection(section.id, nameInput.value);
            onClose();
        },
    });
    actions.append(doneBtn);
    const cancelBtn = uiBtn({
        text: "Cancel",
        onClick: () => {
            Object.assign(section, originalSection);
            state.notify();
            onClose();
        },
    });
    actions.append(cancelBtn);
    if (!section.is_locked_prompt) {
        const deleteBtn = uiBtn({
            text: "Delete section",
            variant: "danger",
            onClick: async () => {
                const confirmed = await confirmDialog({
                    title: "Delete section?",
                    message: `Delete section "${section.name}"? This cannot be undone.`,
                    confirmLabel: "Delete",
                });
                if (confirmed) onDelete();
            },
        });
        actions.append(deleteBtn);
    }

    panel.append(
        nameRow,
        colorRow,
        section.is_locked_prompt ? el("div") : endSepRow,
        section.is_locked_prompt ? el("div") : labelRow,
        section.is_locked_prompt ? el("div") : randRow,
        actions
    );
    rightPanel.append(panel);
}

// ---------------------------------------------------------------------------
// Library prompt_data edit panel (create/edit a prompt_data itself --
// NOT an Entry. This is the only place prompt text/name/thumbnail are
// ever typed/edited.)
// ---------------------------------------------------------------------------

/**
 * Builds the shared prompt-card thumbnail overlay used to show prompt
 * text and category tags on hover.
 *
 * @param {string} promptText - full prompt text (shortened for display)
 * @param {string[]} categories - category tags to show at the bottom
 * @returns {HTMLElement} the overlay element
 */
export function buildThumbnailOverlay(promptText, categories) {
    const MAX_PROMPT_CHARS = 140; // keeps the tooltip a fixed, small size -- no scroll, per spec
    const text = (promptText || "").trim();
    const overlay = el("div", "pc-entry-image-overlay");
    if (text) {
        overlay.append(
            el("div", "pc-entry-overlay-text", {
                text: text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS).trimEnd()} ...` : text,
            })
        );
    }
    if (categories && categories.length) {
        overlay.append(buildOverflowBadgeRow(categories, "pc-entry-overlay-badges"));
    }
    return overlay;
}

/**
 * Renders `items` as a horizontal row of small pill badges (matching
 * .pc-badge's existing look), capped to the row's actual available
 * width. Round 57 grammar: as many badges as fit show WHOLE; when the
 * next one wouldn't, THAT one is shown CLIPPED (its text ends in an
 * ellipsis -- .pc-badge-clip) and only what comes after it collapses
 * into a "+N" pill -- `Extra` `Light` `last categ...` [+2]. Nothing
 * hidden, nothing pill; one badge too long, just an ellipsis. The
 * arithmetic lives in badge_fit's planVisibleBadges; the Category
 * field's summary text (see buildMultiSelectDropdown's fitSummaryText)
 * keeps its older drop-trim because it is one text run, not pills.
 *
 * The measuring is NOT done here any more. It used to be: a per-row
 * requestAnimationFrame plus a per-row ResizeObserver, each one reading
 * clientWidth/scrollWidth -- and every such read forces a synchronous
 * layout of the WHOLE document. The trim loop did it once per badge
 * candidate, on every row, while the chunked fill was still appending
 * siblings: hundreds of full-document relayouts per load, which is why
 * list-view rows (a badge row per row) cost several times what a grid
 * card does. js/badge_fit.js now batches all rows into one pass with
 * reads before writes and a shared observer, and caches per-label badge
 * widths so a repeated category is measured once ever. The look is
 * unchanged; only when-and-how-often we measure moved.
 *
 * @param {string[]} items - values to show as badges, in display order
 * @param {string} [rowClassName="pc-badge-row"] - class for the row element
 * @returns {HTMLElement} the row element (append this into a card/row)
 */
export function buildOverflowBadgeRow(items, rowClassName = "pc-badge-row") {
    const row = el("div", rowClassName);
    if (!items || items.length === 0) return row;

    // Everything, unclipped, immediately: correct for a row with no
    // layout yet, and the batch pass below replaces it with the fitted
    // prefix the frame after real width is known.
    for (const item of items) row.append(el("span", "pc-badge", { text: item }));
    registerBadgeRow(row, items);
    return row;
}

/**
 * A closed-by-default multi-select dropdown: shows a short summary
 * (e.g. "Characters, Environments" or "None"), and expands into a
 * checkbox list when clicked. Selecting/deselecting items doesn't
 * close the list -- the user can toggle several before dismissing it
 * (by clicking the summary again, clicking outside, or pressing
 * Escape). Used for the library edit panel's Category field so the
 * options don't take up permanent vertical space the way a plain
 * checkbox stack does.
 *
 * "None" behaves as its own special option: selecting it clears every
 * other selection (mirrors the checkbox version's original rule),
 * and it shows as checked whenever the selection set is empty.
 *
 * The closed summary has a hard-capped width (see .pc-multiselect-summary
 * CSS) and never lets long selections push the panel into horizontal
 * scroll or grow past its field. When the full "A, B, C, ..." text
 * would overflow, it's truncated to however many whole items actually
 * fit, followed by a "+N" badge for the rest (N = however many
 * selected items didn't fit) -- e.g. "Characters, Environments +3".
 * This requires knowing the summary's real rendered width, so the
 * fitting pass runs after the element is attached to the DOM (see
 * fitSummaryText, called via requestAnimationFrame from renderSummary).
 *
 * @param {string[]} options - every selectable value (excluding "None",
 *   which is added automatically as the first entry)
 * @param {string[]} initialSelected - values selected at build time
 * @param {(selected: string[]) => void} onChange - called with the
 *   full updated selection (as an array) after every toggle
 * @returns {HTMLElement} the dropdown's root element
 */
function buildMultiSelectDropdown(options, initialSelected, onChange, { onCreateCategory, onRenameCategory, onDeleteCategory, confirmDialog } = {}) {
    const root = el("div", "pc-multiselect");
    // Favorite first, everything else as supplied (already alphabetical
    // from the library controller). `withFavoritePinned` also adds it if
    // it's somehow absent, so the protected row is always the one the
    // user sees at the top.
    const categoryOptions = withFavoritePinned(Array.from(new Set(options || [])));
    let selected = new Set(initialSelected || []);
    let isOpen = false;
    let editCategory = null;

    const summaryBtn = uiBtn({ bare: true, extra: "pc-multiselect-summary pc-text-input", type: "button" });
    // Two children instead of plain textContent: a text span for
    // whatever items currently fit, and a "+N" badge for however many
    // don't. Kept as persistent child elements (rather than rebuilt
    // from scratch every time) so fitSummaryText can measure and
    // adjust them directly.
    const summaryText = el("span", "pc-multiselect-summary-text");
    const summaryBadge = el("span", "pc-multiselect-summary-badge");
    summaryBadge.style.display = "none";
    summaryBtn.append(summaryText, summaryBadge);

    const panel = el("div", "pc-multiselect-panel");
    panel.style.display = "none";

    const categoryToolbar = el("div", "pc-multiselect-category-toolbar");
    categoryToolbar.style.display = "none";

    function closeCategoryToolbar() {
        editCategory = null;
        categoryToolbar.style.display = "none";
        categoryToolbar.innerHTML = "";
    }

    function openCategoryToolbar(category = null) {
        editCategory = category;
        panel.style.display = "none";
        categoryToolbar.innerHTML = "";
        categoryToolbar.style.display = "flex";

        const addButton = uiBtn({
            icon: "check",
            size: 13,
            title: category ? "Save category name" : "Add category",
            type: "button",
            extra: "pc-category-add-button",
        });

        const cancelButton = uiBtn({
            icon: "cancel",
            size: 13,
            title: "Cancel",
            type: "button",
            extra: "pc-category-cancel-button",
            onClick: closeCategoryToolbar,
        });

        const input = el("input", "pc-text-input pc-multiselect-category-input", {
            type: "text",
            placeholder: category ? "Rename category" : "New category",
        });
        input.value = category || "";

        const validate = () => {
            const value = input.value.trim();
            const duplicate = categoryOptions.some(
                (option) => option.toLowerCase() === value.toLowerCase() && option !== category
            );
            input.classList.toggle("pc-category-invalid", !!value && duplicate);
            addButton.disabled = !value || duplicate;
        };
        input.addEventListener("input", validate);
        addButton.addEventListener("click", async () => {
            const value = input.value.trim();
            if (!value || addButton.disabled) return;
            try {
                if (category) {
                    await onRenameCategory?.(category, value);
                    const index = categoryOptions.indexOf(category);
                    if (index >= 0) categoryOptions[index] = value;
                    if (selected.delete(category)) selected.add(value);
                } else {
                    await onCreateCategory?.(value);
                    categoryOptions.push(value);
                    selected.add(value);
                }
                closeCategoryToolbar();
                renderPanel();
                renderSummary();
                onChange(Array.from(selected));
            } catch (err) {
                input.classList.add("pc-category-invalid");
                input.title = err.message || "Category operation failed";
            }
        });

        categoryToolbar.append(input, addButton, cancelButton);
        input.focus();
        validate();
    }

    /**
     * Recomputes summaryText/summaryBadge to fit within the summary
     * button's actual current width, given the full sorted list of
     * selected items. Adds items one at a time (each measured via a
     * temporary text update) and stops as soon as adding the next one
     * -- or the "+N" badge needed for the remainder -- would overflow,
     * falling back to that last-fitting state. Runs after DOM
     * attachment (offsetWidth is 0 otherwise).
     */
    function fitSummaryText(items) {
        if (items.length === 0) {
            summaryText.textContent = "None";
            summaryBadge.style.display = "none";
            return;
        }

        const available = summaryBtn.clientWidth;
        // No real layout yet (e.g. not attached to the DOM, panel
        // hidden with zero width somewhere up the tree) -- show
        // everything unclipped rather than guessing wrong; a later
        // call (e.g. after the node/panel resizes) will refine this.
        if (!available) {
            summaryText.textContent = items.join(", ");
            summaryBadge.style.display = "none";
            return;
        }

        // Try showing all of them first; only start trimming if that
        // actually overflows, so the common case (everything fits)
        // does a single cheap measurement.
        summaryText.textContent = items.join(", ");
        summaryBadge.style.display = "none";
        if (summaryText.scrollWidth <= available) return;

        // Binary-search-free linear trim: shrink the visible count
        // until the text fits alongside its "+N" badge. Item lists
        // here are short (a handful of categories at most), so a
        // simple decrementing loop is plenty fast and much easier to
        // follow than a binary search would be.
        for (let visibleCount = items.length - 1; visibleCount >= 0; visibleCount--) {
            const remaining = items.length - visibleCount;
            summaryText.textContent = items.slice(0, visibleCount).join(", ");
            summaryBadge.textContent = `+${remaining}`;
            summaryBadge.style.display = remaining > 0 ? "inline" : "none";

            if (visibleCount === 0) break; // nothing left to trim further
            const totalWidth = summaryText.scrollWidth + summaryBadge.scrollWidth;
            if (totalWidth <= available) return;
        }
    }

    let lastFitItems = [];
    function renderSummary() {
        lastFitItems = Array.from(selected).sort();
        // Deferred one frame so the button has already been laid out
        // (and reflects any just-applied selection change) before we
        // measure it -- matches the rAF-based post-layout measurement
        // pattern already used elsewhere in this UI (see
        // prompt_composer.js's node-size sync loop). This alone isn't
        // sufficient on its own (see the ResizeObserver set up below,
        // near the end of this function, for why), but it covers the
        // common case cheaply.
        requestAnimationFrame(() => fitSummaryText(lastFitItems));
    }

    function renderPanel() {
        panel.innerHTML = "";

        const noneRow = el("label", "pc-checkbox-field pc-multiselect-option");
        const noneCb = el("input", null, { type: "checkbox" });
        noneCb.checked = selected.size === 0;
        noneCb.addEventListener("change", () => {
            if (noneCb.checked) {
                selected = new Set();
                renderPanel();
                renderSummary();
                onChange(Array.from(selected));
            }
        });
        noneRow.append(noneCb, document.createTextNode(" None"));
        panel.append(noneRow);

        for (const opt of categoryOptions) {
            const row = el("label", "pc-checkbox-field pc-multiselect-option");
            const cb = el("input", null, { type: "checkbox" });
            cb.checked = selected.has(opt);
            cb.addEventListener("change", () => {
                if (cb.checked) selected.add(opt);
                else selected.delete(opt);
                renderPanel();
                renderSummary();
                onChange(Array.from(selected));
            });
            const labelText = el("span", "pc-multiselect-option-label", { text: " " + opt });
            const actions = el("span", "pc-multiselect-option-actions");
            // The built-in category is still tickable -- that's the
            // point of it -- but it has no identity to rename and no
            // existence to delete, so it gets no action buttons at all
            // rather than ones that would only ever fail. The server
            // refuses both anyway (library_store.rename_category /
            // delete_category); leaving the buttons off is what stops
            // the user from trying.
            if (!isFavoriteCategory(opt)) {
                const editButton = uiBtn({
                    icon: "edit",
                    size: 12,
                    title: `Edit category "${opt}"`,
                    type: "button",
                    onClick: (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        close();
                        openCategoryToolbar(opt);
                    },
                });
                const deleteButton = uiBtn({
                    icon: "trash",
                    size: 12,
                    title: `Delete category "${opt}"`,
                    variant: "danger",
                    type: "button",
                    onClick: async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const confirmed = await confirmDialog?.({
                            title: "Delete category?",
                            message: `Delete category "${opt}"? This cannot be undone.`,
                            confirmLabel: "Delete",
                        });
                        if (!confirmed) return;
                        await onDeleteCategory?.(opt);
                        const index = categoryOptions.indexOf(opt);
                        if (index >= 0) categoryOptions.splice(index, 1);
                        selected.delete(opt);
                        renderPanel();
                        renderSummary();
                        onChange(Array.from(selected));
                    },
                });
                actions.append(editButton, deleteButton);
            } else {
                labelText.title = "Built-in category. It cannot be renamed or deleted.";
            }
            row.append(cb, labelText, actions);
            panel.append(row);
        }

        const addRow = uiBtn({
            bare: true,
            extra: "pc-multiselect-option pc-multiselect-add-category",
            type: "button",
            title: "Add category",
            onClick: () => {
                close();
                openCategoryToolbar();
            },
        });
        addRow.innerHTML = `${svgIcon("plus", 12)}<span>Add category</span>`;
        panel.append(addRow);
    }

    function open() {
        if (isOpen) return;
        isOpen = true;
        panel.style.display = "flex";
        document.addEventListener("click", onOutsideClick, true);
        document.addEventListener("keydown", onKeydown);
    }
    function close() {
        if (!isOpen) return;
        isOpen = false;
        panel.style.display = "none";
        document.removeEventListener("click", onOutsideClick, true);
        document.removeEventListener("keydown", onKeydown);
    }
    function onOutsideClick(e) {
        if (!root.contains(e.target)) close();
    }
    function onKeydown(e) {
        if (e.key === "Escape") close();
    }

    summaryBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isOpen) close();
        else open();
    });

    // The very first fit pass (triggered by renderSummary() below) can
    // run before the button has real layout -- e.g. it's momentarily
    // inside a panel whose width itself is still being synced to the
    // ComfyUI node's size via a separate rAF loop elsewhere in this
    // UI. A single requestAnimationFrame isn't guaranteed to land
    // after that settles. Rather than guessing how many frames to
    // wait, watch the button's actual size directly: any time its
    // real width changes (first real layout, node resize, panel-split
    // drag, etc.), re-run the fit pass against whatever's currently
    // selected. This also keeps the "+N" count correct if the node is
    // resized after the fact.
    if (typeof ResizeObserver !== "undefined") {
        const resizeObserver = new ResizeObserver(() => fitSummaryText(lastFitItems));
        resizeObserver.observe(summaryBtn);
    }

    renderSummary();
    renderPanel();
    root.append(summaryBtn, categoryToolbar, panel);
    return root;
}

export function renderLibraryEditPanel(rightPanel, existingEntry, { library, onDone, onCancel, confirmDialog, fileToDataUrl }) {
    const panel = el("div", "pc-edit-panel");
    panel.append(el("div", "pc-panel-title", { text: existingEntry ? "Edit Prompt" : "New Prompt" }));

    let pendingImageDataUrl; // undefined = unchanged, null = cleared, string = new
    // A thumbnail-less prompt (stored as .txt) has no image to show, so
    // open the editor on the "Add Image" placeholder rather than a broken
    // <img> request -- has_thumbnail === false is the signal.
    let currentImageUrl = (existingEntry && existingEntry.has_thumbnail !== false)
        ? apiClient.libraryImageUrl(existingEntry.prompt_ref)
        : null;

    const imagePreview = el("div", "pc-edit-image-preview");
    const renderImagePreview = () => {
        imagePreview.innerHTML = "";
        if (pendingImageDataUrl === null) {
            const placeholder = el("div", "pc-entry-image-placeholder pc-edit-image-placeholder");
            placeholder.innerHTML = `<div style="text-align:center;">${svgIcon("plus", 14)}<br>Add Image</div>`;
            imagePreview.append(placeholder);
        } else if (pendingImageDataUrl) {
            imagePreview.append(el("img", null, { src: pendingImageDataUrl }));
            imagePreview.append(deleteImageBtn());
        } else if (currentImageUrl) {
            imagePreview.append(el("img", null, { src: currentImageUrl }));
            imagePreview.append(deleteImageBtn());
        } else {
            const placeholder = el("div", "pc-entry-image-placeholder pc-edit-image-placeholder");
            placeholder.innerHTML = `<div style="text-align:center;">${svgIcon("plus", 14)}<br>Add Image</div>`;
            imagePreview.append(placeholder);
        }
    };
    function deleteImageBtn() {
        const btn = uiBtn({
            bare: true,
            extra: "pc-entry-image-delete",
            noStep: true, // absolute overlay (was a :not() exclusion pre-round 43)
            title: "Remove image",
            onClick: async (e) => {
                e.stopPropagation();
                const confirmed = await confirmDialog({
                    title: "Remove image?",
                    message: "Remove the current image? This cannot be undone.",
                    confirmLabel: "Remove",
                });
                if (!confirmed) return;
                pendingImageDataUrl = null;
                currentImageUrl = null;
                renderImagePreview();
            },
        });
        btn.innerHTML = svgIcon("trash", 14);
        return btn;
    }

    const fileInput = el("input", null, { type: "file", accept: "image/*" });
    fileInput.hidden = true;
    fileInput.addEventListener("change", async () => {
        if (fileInput.files && fileInput.files[0]) {
            await handleIncomingImage(fileInput.files[0]);
        }
    });

    /**
     * Single entry point for every way a new image can arrive at this
     * placeholder (file picker, drag & drop, clipboard paste). If a
     * real image is already showing (either a freshly pending one from
     * this same editing session, or the entry's existing saved image),
     * ask for replacement approval first -- consistent with how the
     * rest of the app confirms before overwriting an image (see
     * deleteImageBtn above). A placeholder (no image at all, or one
     * already cleared via pendingImageDataUrl === null) needs no
     * confirmation since there's nothing to lose yet.
     */
    async function handleIncomingImage(file) {
        if (!file || !file.type || !file.type.startsWith("image/")) return;
        const hasExistingImage = pendingImageDataUrl
            ? true
            : pendingImageDataUrl === null
                ? false
                : !!currentImageUrl;
        if (hasExistingImage) {
            const confirmed = await confirmDialog({
                title: "Replace image?",
                message: "Replace the current image? This cannot be undone.",
                confirmLabel: "Replace",
            });
            if (!confirmed) return;
        }
        pendingImageDataUrl = await fileToDataUrl(file);
        renderImagePreview();
    }

    imagePreview.addEventListener("click", (e) => {
        if (e.target === imagePreview || e.target.closest(".pc-edit-image-placeholder")) {
            fileInput.click();
        }
    });
    imagePreview.addEventListener("dragover", (e) => {
        e.preventDefault();
        imagePreview.classList.add("pc-drag-over");
    });
    imagePreview.addEventListener("dragleave", () => imagePreview.classList.remove("pc-drag-over"));
    imagePreview.addEventListener("drop", async (e) => {
        e.preventDefault();
        imagePreview.classList.remove("pc-drag-over");
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) await handleIncomingImage(file);
    });

    // Paste (Ctrl+V) support: only acts while the mouse is hovering
    // the placeholder/preview, same convention used elsewhere in this
    // app for hover-scoped paste. Registered on `window` in the CAPTURE
    // phase -- not `document` in the bubble phase -- because ComfyUI
    // itself listens for pastes to turn clipboard images into a new
    // LoadImage node, and that listener is wired up at app start: it
    // runs before anything this panel attaches, and preventDefault()
    // alone cannot cancel another listener's JS (it only stops the
    // browser's native default action). Capture begins at the top of
    // the tree, so this handler sees every paste before ComfyUI's does
    // -- and stopImmediatePropagation() there cuts it off entirely when
    // the paste belongs to this image box. Both gates stay narrow
    // (hovering AND clipboard image), so text pastes and ordinary
    // canvas image pastes elsewhere flow through untouched.
    let hoveringImagePreview = false;
    imagePreview.addEventListener("mouseenter", () => (hoveringImagePreview = true));
    imagePreview.addEventListener("mouseleave", () => (hoveringImagePreview = false));
    const onPasteImage = (e) => {
        // isConnected: a panel torn down WITHOUT its onDone/onCancel exits
        // (shouldn't happen -- but leaked listeners from a stale session
        // would still carry a true hoveringImagePreview, because no
        // mouseleave ever fires on a removed element) must stay inert:
        // harmless to the paste AND unable to swallow it via the stop
        // below.
        if (!imagePreview.isConnected || !hoveringImagePreview) return;
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (const item of items) {
            if (item.type && item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) {
                    e.preventDefault(); // for hosts that respect it
                    e.stopImmediatePropagation(); // for the ones that don't -- the LoadImage-node builder
                    void handleIncomingImage(file);
                }
                break;
            }
        }
    };
    window.addEventListener("paste", onPasteImage, true);
    // This panel is torn down and rebuilt (not just hidden) every time
    // it opens/closes/re-renders elsewhere in the app, so the window
    // listener above must be explicitly removed when the panel goes
    // away -- otherwise every past edit session's listener keeps
    // firing (and hoveringImagePreview would be stale/always-false, so
    // it wouldn't misbehave, but it's still a real leak). onDone/
    // onCancel are this panel's only two exits; wrap both.
    const cleanupPasteListener = () => window.removeEventListener("paste", onPasteImage, true);
    const wrappedOnDone = (...args) => {
        cleanupPasteListener();
        return onDone(...args);
    };
    const wrappedOnCancel = (...args) => {
        cleanupPasteListener();
        return onCancel(...args);
    };

    renderImagePreview();

    const nameRow = el("div", "pc-field-row");
    nameRow.append(el("label", null, { text: "Name" }));
    const nameInput = el("input", "pc-text-input", { type: "text" });
    nameInput.value = existingEntry ? existingEntry.name : "";
    // Reflect the correction in the field itself when the person leaves
    // it, so what gets saved is visibly what was typed-and-fixed (e.g.
    // "Bright//Sun" -> "Bright Sun"). An untouched empty field stays
    // empty -- the "Prompt" fallback is for imports, not a suggestion
    // to type into.
    nameInput.addEventListener("blur", () => {
        if (!nameInput.value.trim()) return;
        nameInput.value = correctPromptName(nameInput.value);
    });
    nameRow.append(nameInput);

    const textRow = el("div", "pc-field-row");
    textRow.append(el("label", null, { text: "Prompt text" }));
    const textArea = el("textarea", "pc-text-area");
    textArea.value = existingEntry ? existingEntry.prompt : "";
    textRow.append(textArea);

    // Category multi-select: closed-by-default dropdown showing a
    // summary, expanding into a checkbox list (incl. "None", which
    // clears every other selection when selected) on click.
    const categoryRow = el("div", "pc-field-row");
    categoryRow.append(el("label", null, { text: "Category" }));
    let selectedCategories = new Set(existingEntry ? existingEntry.category : []);
    const categoryDropdown = buildMultiSelectDropdown(
        library.getAllCategories(),
        Array.from(selectedCategories),
        (updated) => {
            selectedCategories = new Set(updated);
        },
        {
            onCreateCategory: (name) => library.createCategory(name),
            onRenameCategory: (oldName, newName) => library.renameCategory(oldName, newName),
            onDeleteCategory: (name) => library.deleteCategory(name),
            confirmDialog,
        }
    );
    categoryRow.append(categoryDropdown);

    const existsWarning = el("div", "pc-locked-note", { text: "" });
    existsWarning.style.display = "none";
    existsWarning.style.color = "#f5c2c2";

    const actions = el("div", "pc-edit-actions");
    const saveBtn = uiBtn({ text: existingEntry ? "Done" : "Save", variant: "primary" });
    const cancelBtn = uiBtn({ text: "Cancel", onClick: wrappedOnCancel });
    actions.append(saveBtn, cancelBtn);
    if (existingEntry) {
        const deleteBtn = uiBtn({
            text: "Delete",
            variant: "danger",
            onClick: async () => {
                const confirmed = await confirmDialog({
                    title: "Delete prompt?",
                    message: `Delete "${existingEntry.name}" from the library? This cannot be undone and will remove it from any section using it.`,
                    confirmLabel: "Delete",
                });
                if (confirmed) {
                    await library.remove(existingEntry.prompt_ref);
                    wrappedOnDone({ deleted: true });
                }
            },
        });
        actions.append(deleteBtn);
    }

    async function trySave() {
        // Raw input is corrected into the Prompt Name first
        // (Naming_Correction_Rules.md section 2): invalid characters
        // become spaces, consecutive spaces merge, edges trim, and the
        // name starts with a word/number. The server re-applies the
        // same correction (idempotent); correcting here is what makes
        // the live "already exists" check query the name the entry
        // would actually get.
        const name = correctPromptName(nameInput.value);
        const promptText = textArea.value.trim();
        if (!nameInput.value.trim() || !promptText) {
            existsWarning.textContent = "Name and prompt text are both required.";
            existsWarning.style.display = "block";
            return;
        }

        const excludeRef = existingEntry ? existingEntry.prompt_ref : undefined;
        const check = await library.checkExists(name, promptText, excludeRef);
        if (check.exists) {
            existsWarning.textContent = "This Prompt Already Exist";
            existsWarning.style.display = "block";
            saveBtn.disabled = true;
            return;
        }
        existsWarning.style.display = "none";
        saveBtn.disabled = false;

        const category = Array.from(selectedCategories);
        // The panel KNOWS, beyond any doubt, whether the user's session
        // moved the picture: any explicit add/replace/remove action (or
        // a clear to null) sets pendingImageDataUrl, which stays
        // undefined only when the image was left alone. Round 30: this
        // truth rides out to the caller, because the mounted library
        // card must be remade when the bytes changed no matter how any
        // version-bump bookkeeping downstream fares.
        const imageChanged = pendingImageDataUrl !== undefined;
        try {
            if (existingEntry) {
                const fields = { name, prompt: promptText, category };
                if (pendingImageDataUrl === null) fields.clearImage = true;
                else if (pendingImageDataUrl) fields.imageDataUrl = pendingImageDataUrl;
                const updated = await library.update(existingEntry.prompt_ref, fields, { refresh: false });
                wrappedOnDone({ entry: updated, imageChanged });
            } else {
                const created = await library.create({
                    name,
                    prompt: promptText,
                    category,
                    imageDataUrl: pendingImageDataUrl || null,
                });
                wrappedOnDone({ entry: created, imageChanged });
            }
        } catch (err) {
            existsWarning.textContent = err.message || "Failed to save prompt.";
            existsWarning.style.display = "block";
        }
    }

    // Live "already exists" check as the user types, matching the
    // documented dialog: disable Save/Done until resolved.
    let checkTimer = null;
    const scheduleCheck = () => {
        clearTimeout(checkTimer);
        checkTimer = setTimeout(async () => {
            const name = correctPromptName(nameInput.value);
            const promptText = textArea.value.trim();
            if (!nameInput.value.trim() || !promptText) return;
            const excludeRef = existingEntry ? existingEntry.prompt_ref : undefined;
            const check = await library.checkExists(name, promptText, excludeRef);
            if (check.exists) {
                existsWarning.textContent = "This Prompt Already Exist";
                existsWarning.style.display = "block";
                saveBtn.disabled = true;
            } else {
                existsWarning.style.display = "none";
                saveBtn.disabled = false;
            }
        }, 300);
    };
    nameInput.addEventListener("input", scheduleCheck);
    textArea.addEventListener("input", scheduleCheck);
    saveBtn.addEventListener("click", trySave);

    panel.append(imagePreview, fileInput, nameRow, textRow, categoryRow, existsWarning, actions);
    rightPanel.append(panel);
}
