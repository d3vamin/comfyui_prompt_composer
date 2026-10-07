/**
 * prompt_composer.js
 *
 * Entry point for the Prompt Composer node's in-node UI. Wires
 * together the extracted modules under ./js/ and handles ComfyUI node
 * registration, lifecycle, and DOM-widget sizing.
 *
 * Module map (see each file's own docstring for details):
 *   js/icons.js           - SVG icon set
 *   js/dom_utils.js        - el(), api(), fileToDataUrl(), drag-reorder, hash util
 *   js/naming.js            - naming correction/encoding pipeline (mirror
 *                             of server/library_store.py) + the unified
 *                             trailing-number collision convention
 *   js/separators.js        - entry/end separator constants + normalize/cycle
 *   js/api_client.js        - typed wrappers around server/routes.py endpoints
 *   js/composer_state.js    - ComposerState (sections/entries data model)
 *   js/ui_library.js        - LibraryController (disk-backed library panel logic)
 *   js/ui_preview.js        - PreviewController (resolves prompt_ref server-side)
 *   js/ui_toolbars.js       - PresetToolbar, section bulk-action toolbar
 *   js/ui_panels.js         - left panel, entry grid/list, edit panels, confirm dialog
 *
 * The node-sizing/splitter/RAF machinery at the bottom of this file is
 * storage-agnostic plumbing that predates the module split; it has
 * nothing to do with how prompt content is kept.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { el, fileToDataUrl, ScrollPreserver, uuid } from "./js/dom_utils.js";
import { ChunkedFiller } from "./js/chunked_fill.js";
import { attachThumbPreview } from "./js/thumb_preview.js";
import { svgIcon } from "./js/icons.js";
import { uiBtn, uiToggle, buildSearchBox, modeNotice } from "./js/ui_chrome.js";
import { ComposerState, makeLockedPromptSection, usedPromptRefsForQueue } from "./js/composer_state.js";
import { LibraryController } from "./js/ui_library.js";
import { PreviewController } from "./js/ui_preview.js";
import { PresetToolbar, renderSectionToolbar } from "./js/ui_toolbars.js";
import { ENTRY_SEPARATOR_GLYPH, normalizeEntrySeparator, cycleEntrySeparator } from "./js/separators.js";
import { splitPromptRef } from "./js/naming.js";
import {
    parseComposerWidget,
    needsGraphHydration,
    buildSnapshotPayload,
    mergeWorkflowContent,
    usedPromptRefs,
    restorePlanFor,
    executedChipStates,
    shouldAdoptExecuted,
    baselineAfterHistoryLoad,
    resolveLinkedString,
    PC_SNAPSHOT_SCHEMA,
} from "./js/workflow_restore.js";
import {
    createConfirmDialog,
    renderLeftPanel,
    applyAlertCounts,
    resolveForDisplay,
    tryResolveForDisplay,
    buildEntryToolbar,
    buildBulkActionToolbar,
    buildEntryCard,
    buildEntryListRow,
    renderSectionEditPanel,
    renderLibraryEditPanel,
    renderLibraryColorEditPanel,
} from "./js/ui_panels.js";
import {
    FAVORITE_CATEGORY,
    isFavoriteCategory,
    isFavoriteEntry,
    sortCategoriesPinningFavorite,
    buildFavoriteFilterButton,
    buildFavoriteStar,
    categoryMembershipFor,
    isFolderPseudoCategory,
} from "./js/favorites.js";
import { planLibrarySync, planPlacements, isRowFresh, categoryStampKey } from "./js/library_sync.js";
import { tokenize, rankEntries, highlightHTML, searchBlob, scoreEntry } from "./js/library_search.js";
import { bindPressAndHold } from "./js/press_hold.js";
import * as apiClient from "./js/api_client.js";

// Inject stylesheet once per page load.
(function injectStyles() {
    const href = new URL("./css/prompt_composer.css", import.meta.url).href;
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
})();

/**
 * The dead-zone that still counts as "at the end of the list" for add
 * placement (see _captureAddPlacement). A pick commits to the plain end
 * only when the person had scrolled past 99% of the list -- i.e. the
 * bottom of the viewport sits in the last 1% of the content, which for
 * any list taller than the panel means the scrollbar is visibly at the
 * bottom. Fraction-of-list, not fixed pixels: an absolute margin is
 * "the end" for a short list while meaning nothing on a long one, and a
 * viewport-relative one scales with the panel instead of the content.
 */
const NEAR_END_FRACTION = 0.01;

/**
 * The element's static layout distance from the top of `container`, in
 * the container's OWN coordinate space (scrollTop units). Deliberately
 * built from `offsetTop` sums rather than `getBoundingClientRect()`:
 * the widget's DOM sits inside ComfyUI's canvas zoom/pan transform, so
 * rects come back in VISUAL pixels while scrollTop/scrollHeight/
 * offsetTop are LAYOUT pixels -- mixing them measures the content at
 * whatever the canvas scale is, which once made a mid-list position
 * look like the bottom of the list whenever the zoom wasn't exactly 1.
 * offsetTop ignores scrolling and transforms entirely, which is the
 * same currency the scroll properties are in.
 */
function layoutTopWithin(el, container) {
    const layoutTop = (node) => {
        let top = 0;
        for (let n = node; n; n = n.offsetParent) top += n.offsetTop;
        return top;
    };
    return layoutTop(el) - layoutTop(container);
}

/** The bottom dead-zone for one list, in layout pixels. */
function nearEndDistance(container) {
    return container.scrollHeight * NEAR_END_FRACTION;
}

/**
 * The scroll record kept per section: the exact pixel offset (right on
 * when the list comes back the same height) plus the proportion of the
 * scrollable range it sat at (what _applyEntry falls back to when the
 * list has since grown past or shrunk under those pixels).
 */
function browseScrollEntry(container) {
    const max = container.scrollHeight - container.clientHeight;
    return { pixels: container.scrollTop, fraction: max > 0 ? container.scrollTop / max : 0 };
}

/**
 * Per-section browse scroll memory. The ScrollPreserver has ONE slot
 * (`rightBrowse`) for whichever section's grid/list is mounted, but a
 * person expects each section to open where THEY left IT -- and with a
 * page refresh (F5) mid-workflow, "left it" should still be true. So
 * the memory lives in two layers: a Map on the UI instance (fast, dies
 * with the node) mirrored into sessionStorage (survives refresh; the
 * browser already scopes it to the tab, and clearing keys against the
 * live section set keeps it from leaking). Node id and section id are
 * both stable across save/load, so the keys still match after F5;
 * re-ADDING a node gets a fresh id and honestly starts at the top.
 * All storage access is try-wrapped: private-mode/blocked storage just
 * means the memory layer carries the feature alone.
 */
const SESSION_SCROLL_PREFIX = "pc-scroll:";

function readSessionScroll(key) {
    try {
        const raw = sessionStorage.getItem(key);
        if (!raw) return null;
        const sep = raw.indexOf(":");
        if (sep < 0) return null;
        const pixels = Number(raw.slice(0, sep));
        const fraction = Number(raw.slice(sep + 1));
        return Number.isFinite(pixels) && Number.isFinite(fraction)
            ? { pixels, fraction }
            : null;
    } catch {
        return null;
    }
}

function writeSessionScroll(key, { pixels, fraction }) {
    try {
        sessionStorage.setItem(key, `${Math.round(pixels)}:${fraction.toFixed(4)}`);
    } catch {
        /* storage unavailable: the in-memory Map is the record */
    }
}

function forgetSessionScroll(key) {
    try {
        sessionStorage.removeItem(key);
    } catch {
        /* nothing to forget */
    }
}

const LEFT_PANEL_MIN_WIDTH = 205;
const RIGHT_PANEL_MIN_WIDTH = 223;
const SPLITTER_WIDTH = 6;
const DEFAULT_SPLIT_FRACTION = 0.32;

/**
 * Byte-ish budget for the `contents` map inside pc_workflow_snapshot.
 * Snapshots ride in every save (workflow JSON AND the PNG tEXt chunk),
 * so the cap is what keeps a 500-entry composition from bloating files;
 * over-budget drops the LONGEST texts first (see buildSnapshotPayload)
 * and the always-kept final_prompt still carries the full assembled
 * string. ~200KB is generous for realistic text-only payloads.
 */
const PC_MAX_SNAPSHOT_CONTENTS_CHARS = 200 * 1024;

/**
 * Best-effort display name of the workflow being saved, used to name the
 * virtual preset. The workflow manager's public surface has
 * moved across frontend versions, so probe defensively and never throw:
 * a null name just means the snapshot has no suggested preset name.
 * Names arrive with directories and/or the ".json" suffix attached
 * ("my/stuff/cool workflow.json") -- keep the bare stem.
 */
function currentWorkflowName() {
    try {
        const active =
            (app.workflowManager && app.workflowManager.activeWorkflow) ||
            (app.workflowStore && app.workflowStore.activeWorkflow) ||
            null;
        let raw = active && (active.name || (typeof active.path === "string" ? active.path : null));
        if (!raw || !String(raw).trim()) {
            // Newer frontends also stamp the ACTIVE GRAPH itself with the
            // workflow it was loaded from (graph.extra.filepath) -- probe
            // that too, since the first live smoke saw the manager
            // surfaces come up empty while a named workflow was open.
            const graph = app.rootGraph || app.graph || null;
            const extra = graph && graph.extra;
            raw = (extra && (extra.filepath || extra.filename)) || raw;
        }
        if (typeof raw !== "string" || !raw.trim()) return null;
        const tail = raw.split(/[\\/]/).pop() || "";
        const stem = tail.replace(/\.(json|png)$/i, "").trim();
        return stem || null;
    } catch {
        return null;
    }
}

/**
 * the executed-output plumbing shared by all PromptComposer nodes.
 *
 * PC_NODES holds the LIVE node instances (added at onNodeCreated,
 * dropped at onRemoved) so the execution listeners below can find every
 * composer without walking the graph.
 *
 * Trigger choice matters -- the live smoke proved WHY. The frontend's
 * "executing" event detail is NOT the raw ws data: api.ts dispatches it
 * as the bare node-id STRING (`msg.data.display_node || msg.data.node`),
 * so keying prompt-id capture off it plants node ids like "7" where a
 * uuid belongs (that poisoned fallback was the invisible-chain bug --
 * every fetch went to /last_output/7/... and 404'd silently). Instead we
 * use "executed": it fires PER NODE the instant that node's compose
 * returned -- after the stash write, so the answer is guaranteed
 * present -- and its detail is the honest {node, display_node,
 * prompt_id} object. Nothing else is listened to.
 *
 * A fetch failing for a node that DID report "executed" is an anomaly,
 * not normal silence -- so it now logs a loud one-shot hint. The
 * classic cause is a stale server process: the stash route and the
 * UNIQUE_ID/PROMPT_ID injection are PYTHON-side and need a ComfyUI
 * restart; the browser refresh alone only updates the JS half.
 *
 * Semantics note: being per-node, the chip tracks "this node's compose
 * actually ran", so it refreshes even if a DOWNSTREAM node fails later
 * (the string really was emitted; a cache-served composer does NOT
 * re-fire executed and keeps its previous chip).
 */
const PC_NODES = new Set();
let _pcWsWired = false;
let _pcC3FailureLogged = false;
let _pcEndpointProbed = false;
let _pcPollTimer = null;
// Adaptive poll cadence (see startExecutedOutputPolling): fast while
// runs are landing, slow once the page has been idle for a while.
let _pcPollIntervalMs = 0;
let _pcLastAdoptAt = 0;
const PC_POLL_FAST_MS = 2500;
const PC_POLL_IDLE_MS = 10000;
const PC_POLL_IDLE_AFTER_MS = 60000;
// This page's executed-output disambiguator: one random string per PAGE LOAD,
// mirrored into each node's hidden client_key widget and sent with every
// executed-output fetch. Node ids restart at 1 in every workflow, so
// without it two browser tabs write to -- and adopt from -- the same
// server stash address. Deliberately NOT persisted: two tabs showing the
// SAME saved workflow must still get different keys.
const PC_CLIENT_KEY = uuid();

// The literal text of the preview toggle label -- built once into one
// span per character (see the previewLabel construction) so the ON
// state can color each letter independently. A plain constant rather
// than reading previewLabel.textContent back out, since that becomes
// "" the moment the per-letter spans replace it.
const PREVIEW_LABEL_TEXT = "PREVIEW";

function wireExecutedOutputListeners() {
    if (_pcWsWired) return;
    _pcWsWired = true;
    api.addEventListener("executed", (e) => {
        const d = e && e.detail;
        // prompt_id is OPTIONAL for addressing since the live smoke:
        // some ComfyUI builds inject an empty PROMPT_ID into nodes (and
        // could equally omit it here), so the server stash is keyed by
        // NODE ID and the URL's prompt segment is provenance only.
        const pid = d && typeof d.prompt_id === "string" && d.prompt_id
            ? d.prompt_id
            : "latest";
        const finished = String(d.display_node ?? d.node ?? "");
        if (!finished || finished === "null") return; // graph-terminal message
        for (const node of PC_NODES) {
            if (node._pcDestroyed || !node.composerUI) continue;
            if (String(node.id) === finished) {
                // Breadcrumb, not an error: proves event->node matching
                // worked for the one channel the user can read without
                // DevTools training (console search).
                console.info(`Prompt Composer C3: node ${node.id} finished in run ${pid} — fetching executed output`);
                node.composerUI.requestExecutedOutput(pid);
            }
        }
    });
}

/**
 * One-shot endpoint health check the first time a node exists, via the
 * always-200 /c3_status diagnostics route (NOT a 404 on the probe key --
 * a red console line on every page load confused the live smoke).
 * Success = the Python half answers; anything else (missing route on a
 * stale server process, network failure) -> every node on the page says
 * so with the red chip WITHOUT waiting for a run. The chip appearing at
 * load is also proof the browser is running the fixed JS.
 */
function probeC3EndpointOnce() {
    // The polling restart is deliberately OUTSIDE the once-guard: the
    // poller stops itself when the last composer leaves the page, so
    // creating a node again has to be able to bring it back.
    startExecutedOutputPolling();
    if (_pcEndpointProbed) return;
    _pcEndpointProbed = true;
    apiClient.getC3Status().catch((err) => {
        const msg = String((err && err.message) || err || "network failure");
        for (const node of PC_NODES) {
            if (!node._pcDestroyed && node.composerUI) node.composerUI.noteC3EndpointDown(msg);
        }
    });
}

/**
 * Build banner (round-7): six rounds of this bug were partly spent
 * wondering "is the page even running the code I shipped?" -- so the
 * current build id now logs unconditionally at extension setup, and a
 * console SEARCH for "Prompt Composer" either shows it (fresh JS) or
 * doesn't (stale page). One line per load; remove once nobody asks.
 */
// Product version. The authority is __version__ in the root
// __init__.py, served by GET /prompt_composer/version -- this constant
// is only the value shown until that answer lands (and the fallback if
// it never does). It is deliberately not a hand-maintained copy of
// the version.
let PC_VERSION = "1.0.261007";
const PC_BUILD = "e3r70";

// How long the library search waits for typing to stop before
// running the (heavier) rank + reorder + highlight pass. 180ms: half a
// keystroke's reaction time, full keystrokes in a normal flow.
const LIB_SEARCH_DEBOUNCE_MS = 180;

// The text elements each panel's rows expose to hit
// marking. Deliberately different lists -- a section card nests its
// name in a SPAN beside badges (marking the wrapper would shred them),
// a library card puts the text straight in the label div.
const LIB_ROW_TEXT = [".pc-entry-label", ".pc-entry-row-name", ".pc-entry-row-prompt"];
const SECTION_ROW_TEXT = [".pc-entry-label-name", ".pc-entry-row-prompt"];
// Sentinel stored in the hidden executed_prompt widget for a
// LEGITIMATELY EMPTY executed string. NUL is untypable, so it can never
// collide with real prompt text -- and unlike "", it stays
// distinguishable from a brand-new node's default widget value.
const PC_EMPTY_EXECUTED_MARK = "\u0000";

/**
 * The UNIVERSAL executed-output path: a slow poll of /c3_status, which needs NO WS
 * events at all. The live smoke proved events can vary by build (this
 * user's browser delivered neither my "executed" listener nor
 * LiteGraph's onExecuted) -- but /c3_status answered perfectly, so
 * adoption rides it: every 2.5s, take each node's newest record that is
 * NEWER THAN THE NODE'S OWN BIRTH (see primeC3Baseline) and that the
 * node has not already adopted. The birth-baseline is what makes this
 * safe across graphs: node ids restart from 1 in every new workflow
 * while the stash outlives them, so without it the first node of a new
 * graph would "inherit" an old run recorded under the same id (showing an
 * amber "edited since" chip on a node that had never run). The onExecuted/WS fast paths remain for instant updates
 * where events do fire; a duplicate adopt is idempotent.
 */
function stopExecutedOutputPolling() {
    if (!_pcPollTimer) return;
    clearInterval(_pcPollTimer);
    _pcPollTimer = null;
    _pcPollIntervalMs = 0;
}

function startExecutedOutputPolling(intervalMs = PC_POLL_FAST_MS) {
    if (_pcPollTimer && _pcPollIntervalMs === intervalMs) return;
    stopExecutedOutputPolling();
    _pcPollIntervalMs = intervalMs;
    _pcPollTimer = setInterval(async () => {
        const nodes = [];
        for (const node of PC_NODES) {
            if (!node._pcDestroyed && node.composerUI) nodes.push(node);
        }
        if (!nodes.length) {
            // Every composer is gone (deleted, or the graph was cleared).
            // Nothing is left to adopt an answer, so stop asking -- otherwise
            // the timer would poll a dead page forever. The next node
            // created restarts it (see probeC3EndpointOnce's caller).
            stopExecutedOutputPolling();
            return;
        }
        // Back off once nothing has been adopted for a while: the fast
        // cadence only earns its keep around an actual run.
        const idle = _pcLastAdoptAt && (Date.now() - _pcLastAdoptAt) > PC_POLL_IDLE_AFTER_MS;
        const wanted = idle ? PC_POLL_IDLE_MS : PC_POLL_FAST_MS;
        if (wanted !== _pcPollIntervalMs) {
            startExecutedOutputPolling(wanted);
            return;
        }
        let status = null;
        try {
            // Bodies included: this is the call that ADOPTS, so it is the
            // one that legitimately asks for the full text (the server
            // omits it by default -- see /c3_status).
            status = await apiClient.getC3Status({ full: true });
        } catch {
            return; // endpoint problems were voiced by the boot probe
        }
        if (!status || !Array.isArray(status.entries)) return;
        let maxAt = null;
        for (const rec of status.entries) {
            if (rec && typeof rec.at === "number" && (maxAt === null || rec.at > maxAt)) maxAt = rec.at;
        }
        for (const node of nodes) {
            const ui = node.composerUI;
            if (ui._pcBaselineAt == null) {
                // The birth-prime fetch had not landed/failed; baseline
                // from the first tick we can see at all (records from
                // BEFORE now are then correctly ignored; the fast paths
                // still adopt a genuine run of this node instantly).
                ui._pcBaselineAt = maxAt ?? 0;
                continue;
            }
            // Pure, tested predicate (workflow_restore.shouldAdoptExecuted):
            // right node, after this instance's birth, not yet consumed.
            let mine = null;
            for (const rec of status.entries) {
                const ok = shouldAdoptExecuted(rec, {
                    nodeId: node.id,
                    baselineAt: ui._pcBaselineAt,
                    adoptedAt: ui._pcAdoptedAt,
                    clientKey: PC_CLIENT_KEY,
                });
                if (ok && (!mine || ok.at > mine.at)) mine = ok;
            }
            if (!mine) {
                // This tick had its chance at newer data and
                // found none for this node -- the embedded record IS the
                // latest truth here, so any pending "Checking..." state
                // resolves back to the honest Edited/Reset Seed labels.
                if (ui._pcCatchingUp) {
                    ui._pcCatchingUp = false;
                    ui._refreshExecutedChip();
                }
                continue;
            }
            ui._pcAdoptedAt = mine.at;
            _pcLastAdoptAt = Date.now(); // keeps the fast cadence alive
            console.info(`Prompt Composer C3: adopted executed output for node ${node.id} via status poll`);
            ui.applyExecutedOutput(mine);
        }
    }, 2500);
}

/**
 * Birth-baseline: what the newest stash timestamp is RIGHT NOW. Called
 * once per node instance at creation; the poller may only adopt records
 * written after this moment, so a new node can never inherit an old
 * graph's output that happens to share its id. A failed/slow prime falls
 * back to the first poll tick (see the poller), and the event fast
 * paths adopt unconditionally because "this node just ran" needs no
 * baseline to be certain.
 */
function primeC3Baseline(node) {
    if (!node.composerUI) return;
    apiClient.getC3Status().then((status) => {
        let maxAt = null;
        for (const rec of (status && Array.isArray(status.entries)) ? status.entries : []) {
            if (rec && typeof rec.at === "number" && (maxAt === null || rec.at > maxAt)) maxAt = rec.at;
        }
        // Later value wins only if nothing was adopted in between.
        if (node.composerUI._pcBaselineAt == null) node.composerUI._pcBaselineAt = maxAt ?? 0;
    }).catch(() => { /* poller's first tick will baseline instead */ });
}

/** One-shot, diagnostic-quality warning for a failed executed fetch. */
function warnExecutedFetchFailure(err, nodeId, promptId) {
    if (_pcC3FailureLogged) return;
    _pcC3FailureLogged = true;
    const msg = String((err && err.message) || err || "");
    // A real route answers "no recorded output" when the stash simply
    // has nothing; anything else (plain "Not Found" over an HTML 404)
    // means the endpoint itself is missing -- stale Python process.
    const staleServerHint =
        /recorded output/i.test(msg)
            ? "The server stash has no record for this node/run -- queue the node again."
            : "The /last_output endpoint did not answer (" + msg + "). If ComfyUI was not RESTARTED after updating this node, the Python side (stash route + UNIQUE_ID/PROMPT_ID injection) is still the old code -- restart ComfyUI, then queue a run.";
    console.warn(`Prompt Composer C3: node ${nodeId} finished run ${promptId} but its executed output could not be fetched. ${staleServerHint}`);
}

/**
 * A prompt rename moves its ref (UID = hash(name+text)), and
 * the server now relinks every saved PRESET FILE -- but live nodes
 * still hold their loaded preset in MEMORY, and rewriteEntryPromptRefs
 * only reaches the one instance that performed the edit. Every other
 * open composer would keep rendering stale cards AND -- worse -- save
 * its stale in-memory sections straight back over the server's
 * relinked file. So the rename answer is applied through the PC_NODES
 * registry to every live node: refs swapped, display cache dropped,
 * preview memo invalidated, re-rendered. The preset toolbar's dirty
 * baseline is retargeted too: the relink is not a user
 * edit, and the server already rewrote the on-disk copy, so Save must
 * NOT light up green over it.
 */
function relinkLiveNodes(oldRef, newRef) {
    if (!oldRef || !newRef || oldRef === newRef) return;
    for (const node of PC_NODES) {
        const ui = node.composerUI;
        if (!ui || node._pcDestroyed) continue;
        ui.rewriteEntryPromptRefs(oldRef, newRef);
        // Re-baseline BEFORE render(): the render's refreshDirtyState
        // then compares new-ref sections against a new-ref baseline and
        // finds them equal, so there is no false-green flash.
        if (ui.presetToolbar) ui.presetToolbar.retargetSavedBaseline(oldRef, newRef);
        if (ui._displayCache) {
            ui._displayCache.delete(oldRef);
            ui._displayCache.delete(newRef);
        }
        if (ui.preview) ui.preview.invalidate([oldRef, newRef]);
        try { ui.render(); } catch { /* a torn-down instance just fails over */ }
    }
}

/**
 * Strip the underscore-prefixed, UI-runtime-only fields renderEntryGrid
 * attaches to a LIVE section object while the entry list is open:
 * _moveEntryCallback (a closure, used by drag-reorder), and
 * _selectedEntryIds / _missingEntryIds (Sets shared by reference with
 * the ComposerUI instance, used by bulk-select and cross-section drag).
 * None of the three is meant to be persisted or handed to anything
 * outside the live UI -- they are re-derived every time the entry list
 * renders. Every consumer that hands `sections` to something LiteGraph
 * or the server might clone/serialize (onSerialize's pc_state,
 * buildWorkflowSnapshot's embedded preset.sections) MUST call this
 * first: a still-attached _moveEntryCallback is a function, which
 * structuredClone cannot copy, and is exactly what produced "LiteGraph:
 * ignoring non-serializable extension payload" in the console --
 * repeatedly, on every one of LiteGraph's routine internal
 * serialization passes (which run far more often than an explicit
 * save, including during canvas panning) for as long as a section
 * (never the library view, which never attaches these) stayed active
 * with the entry list mounted.
 */
function stripTransientSectionFields(sections) {
    return sections.map((section) => {
        const { _moveEntryCallback, _selectedEntryIds, _missingEntryIds, ...clean } = section;
        return clean;
    });
}

class ComposerUI {
    constructor(node) {
        this.node = node;
        this.state = new ComposerState(() => this.render());
        this.library = new LibraryController();
        this.editTarget = null; // {type: 'section'|'library-edit'|'library-new', sectionId?, promptRef?}
        this.splitFraction = DEFAULT_SPLIT_FRACTION;
        this.viewMode = "grid"; // view mode for the ACTIVE SECTION's entry grid/list
        this.libraryViewMode = "grid"; // separate view mode for the Library browser -- kept independent so switching one doesn't affect the other
        this.showLibraryPanel = false; // when true, right panel shows the Library browser instead of the active section's entries
        this.selectedEntryIds = new Set(); // bulk-action "selected" state, per active section, NOT persisted
        this.librarySelectedPromptRefs = new Set(); // selected prompts in the Library browser for bulk delete + drag-drop
        this._entryClipboard = null; // {prompt_ref, allow_random, entry_separator}[] -- copy/cut buffer, in-memory only
        // Entry ids in the CURRENTLY RENDERED section whose prompt_ref no
        // longer resolves to a library prompt (the "(Missing)" cards).
        // Rebuilt from the resolve result on every entry-grid fill (see
        // renderEntryGrid) and used to keep those dead pointers out of
        // every bulk action that would clone them: the Copy/Cut
        // clipboard, cross-section drag-and-drop, and duplication.
        // Mutated in place (never reassigned) so the reference published
        // onto the section for drag-time reads stays live.
        this._missingEntryIds = new Set();
        // The loaded workflow's embedded prompt contents (ref ->
        // {name, prompt, category}), straight out of
        // pc_workflow_snapshot.contents. Null when the current graph
        // carried no snapshot. Feeds mergeWorkflowContent for card
        // display; the PreviewController holds its own copy for the
        // preview text (see applyWorkflowSnapshot).
        this._workflowContents = null;
        // Backing store for the "!" alert chips -- one entry
        // per prompt_ref: "live" | "workflow" | "missing". Fed two ways:
        // the per-section fill fast path (free -- it reuses the merged
        // resolve the cards were built from) and a whole-preset sweep
        // that lights chips for sections never opened. See _alertSweep.
        this._refStatus = new Map();
        this._alertSweptFingerprint = null;
        this._alertSweptWorkflow = null;
        this._alertSweepInFlight = false;
        this._alertSweepQueued = false;
        // The alert chip's toggle -- which section (if any) is
        // currently isolating its problem cards: null | a section id.
        // One select, like the visible-only flag: arming another chip
        // moves the ring. (There is no "library" global scope: the
        // Library row has no chip.)
        this.alertsOnlyMode = null;
        this._displayCache = new Map(); // prompt_ref -> resolved display data, for entry grid/list rendering
        this.sectionSearchVisible = false; // Search toolbar visibility is toggled, hidden by default
        this.sectionSearchText = ""; // search text for filtering entries WITHIN the active custom section
        this.sectionSelectedCategory = "All"; // category filter for entries WITHIN the active custom section
        // Star modifier on that category filter, mirroring
        // LibraryController.favoritesOnly: narrows the section's entries
        // to the ones whose prompt is favorited, ON TOP OF the category
        // already chosen. Transient view state like the rest of the
        // filters -- never persisted into the preset.
        this.sectionFavoritesOnly = false;
        // The section rows' "N/M" counter: a VIEW filter that hides the section's
        // visibility-OFF cards (entry.visible === false, the dimmed ones)
        // from the panel entirely, so what remains on screen is exactly
        // what this section composes. It changes no state -- hiding a
        // card never deletes it, and toggling the filter back shows the
        // dimmed cards again. Same transient-view doctrine as the other
        // filters: never persisted.
        this.sectionVisibleOnly = false;
        // The bulk toolbar's "N selected" chip doubles as a VIEW filter
        // (clicking it hides every card that is NOT currently
        // selected, so the panel shows exactly the selection the bar is
        // describing. Section cards key off the .pc-selected class (this panel's
        // selectedEntryIds); the Library browser keys off its own selection
        // marker (.pc-selected) via a parallel flag -- the two sets and two
        // passes are independent, so filtering one panel never leaks into
        // the other. View state only: it changes no pick, moves no dirty
        // flag, and is never persisted, exactly like the visible-only filter.
        this.sectionSelectedOnly = false;
        this.librarySelectedOnly = false;
        this.libraryColor = "#4a90d9"; // "Library" pseudo-section's only property (default Blue); persisted via onSerialize/onConfigure
        this.librarySearchVisible = false; // toggle for library search + category filters
        this._scrollPreserver = new ScrollPreserver();
        // A section id here means "the NEXT time that
        // section's browse view renders, pin it to the BOTTOM instead of
        // restoring memory" -- appended entries (library add, paste,
        // drag-and-drop) land at the end, and the new card is the thing
        // to see. Set inside the change batch so the render fired at
        // batch close already carries it; if some other view is showing
        // when the add happens, the request simply survives until the
        // section comes back on screen. Consumed once by render()'s
        // override, below the edit/library guards.
        this._browseToEndSectionId = null;
        // Companion to the above: a section id here means the next render of
        // ITS browse view restores the remembered position as a
        // PERCENTAGE of the scrollable range instead of the exact pixel
        // offset -- used when a cross-section MOVE shortens the list
        // being looked at and the old offset no longer lines up.
        this._browseFractionPrioritySectionId = null;
        // Set while the person is replacing a missing/broken entry's
        // prompt_ref (see buildMissingEntryNotice / onReplace below):
        // {sectionId, entryId}. While set, the Library panel enters a
        // special "pick a replacement" mode -- clicking any library
        // card there sets that entry's prompt_ref to the clicked
        // prompt instead of the library panel's normal bulk-select
        // behavior. Cleared on a successful pick, on Cancel, or if the
        // person navigates to a section instead of finishing the pick.
        this._replacingEntryTarget = null;

        // The Library panel is open for one purpose: choosing prompts to add
        // to a particular section. Unlike the replacement pick above, this
        // one survives many clicks -- it is a multi-select -- so it needs an
        // explicit commit button and a rule for when to abandon it. See
        // addingToSectionTarget.
        this._addingToSection = null; // { sectionId } | null

        this.root = el("div", "pc-root");
        // Full-resolution thumbnail tooltip (see
        // js/thumb_preview.js): delegated on the whole root so every
        // thumbnail in every panel — grid cards AND list rows, sections
        // AND library — gets it, including ones chunked-fillers mount
        // later. Returns its dispose, run below from onRemoved.
        this._thumbPreview = attachThumbPreview(this.root);
        // Chunked-fill state (see js/chunked_fill.js): the live fillers
        // for the currently-mounted views, plus the set of prompt_refs
        // the mounted Library browser has already handed to its filler
        // (streamed pages dedup against it). All three are cleared when
        // the right panel is torn down (see clearRightPanel).
        this._libFiller = null;
        this._libRenderedRefs = null;
        // Live search state. The debounced pass re-ranks,
        // highlights and summarizes the MOUNTED rows via CSS order --
        // the DOM itself never moves, so there is no "restore order"
        // debt to track. The input ref lets the "/" hotkey find the
        // field from anywhere in the page.
        this._libSearchTimer = null;
        this._libSearchInput = null;
        this._libSearchCount = null;
        this._libEmptyNode = null;
        // The same five facts for the SECTION panel. The
        // index maps entry id -> {name, prompt, category} built from
        // the very resolve that renders the rows (scorer sees exactly
        // what the cards show); it lives on the instance because the
        // live search pass has no access to the render's local maps.
        this._secSearchTimer = null;
        this._secSearchInput = null;
        this._secSearchCount = null;
        this._secEmptyNode = null;
        this._secSearchIndex = null;
        // "/" focuses the library search from anywhere --
        // the standard summon key. Guarded so it stays silent while the
        // user types in ANY field, and while this node owns no visible
        // search strip: every composer instance listens, but only one
        // can own a mounted, visible field at a time.
        document.addEventListener("keydown", (e) => {
            if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
            const t = e.target;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
            // Either panel's field answers -- whichever strip
            // is actually on screen (the two panels never are at once).
            let input = null;
            for (const candidate of [this._libSearchInput, this._secSearchInput]) {
                if (candidate && candidate.isConnected && candidate.offsetParent) { input = candidate; break; }
            }
            if (!input) return;
            e.preventDefault();
            input.focus();
            input.select();
        });
        this._entryFiller = null;
        // Panel round-trip state (see renderLibraryBrowser): the browse
        // wrap that render() will want back when an edit panel closes,
        // the view-key it was valid for, and the node builder its rows
        // were made with. These deliberately SURVIVE clearRightPanel --
        // that detach is exactly what they are stashed for.
        this._libWrapCache = null;
        this._libWrapCacheKey = null;
        this._libBuildNode = null;
        // The always-built search strip + its toggle button, stashed by
        // the build so the button can show/hide THIS node (see
        // _applyLibrarySearchVisibility) instead of re-rendering.
        this._libSearchToolbar = null;
        this._libSearchButton = null;
        // Section-panel counterparts (see _applySectionSearchToggle):
        // the always-built strip, the rows container it inserts above,
        // and the display map its dropdown is populated from.
        this._secSearchStrip = null;
        this._secRowsContainer = null;
        this._secResolvedMap = null;
        // Pick-to-add round trip (see startAddingToSection /
        // confirmAddingToSection): where the section's list was looking
        // when the person left for the Library -- the entry the picks
        // commit beside, or the plain end. Returning is purely the
        // ScrollPreserver's job: the section's remembered position,
        // untouched by the added entries.
        this._addReturnPlan = null;
        // Where each section's browse list opens (see _stashBrowseScroll /
        // _rememberedBrowseScroll): sectionId -> {pixels, fraction},
        // mirrored into sessionStorage so a page refresh keeps it.
        this._sectionScrolls = new Map();
        this._sectionScrollsSig = null;
        // Monotonic render identity (see the fill chain in render()):
        // whose promises still speak for the panel.
        this._renderSeq = 0;
        // See render()'s tail: replaced with a real promise on every
        // render, but defined from construction so a caller that runs
        // before the very first render (shouldn't happen in practice)
        // still has something safe to await.
        this._lastRenderSettled = Promise.resolve();
        this._starPending = new Set(); // refs with a favourite PATCH in flight

        this.buildStaticLayout();
        this.render();
        // The initial library load arrives page by page: if the person
        // opens the Library browser while it is still in flight, the
        // later pages stream straight into the mounted filler instead
        // of waiting for this call to finish and a manual refresh.
        this.library.refresh({ onChunk: (page) => this._pushLibraryChunk(page) })
            .then(() => this.render());

        if (typeof ResizeObserver !== "undefined") {
            this._resizeObserver = new ResizeObserver(() => this.applySplit());
            this._resizeObserver.observe(this.root);
        }
    }

    buildStaticLayout() {
        this.presetToolbar = new PresetToolbar({
            state: () => this.state,
            onLoad: (preset) => {
                this.state.loadFromPreset(preset);
                // Every section -- and so every entry id -- has just been
                // replaced, so any bulk-pick still held points at cards
                // that no longer exist anywhere.
                this.selectedEntryIds.clear();
            },
            onNew: () => {
                this.state.sections = [makeLockedPromptSection()];
                this.state.presetName = null;
                this.state.activeSectionId = this.state.sections[0].id;
                // Bulk-selected ids belong to the sections we just threw
                // away. Left in place, a "New Preset" would open with the
                // previous composition's stale picks still counted in the
                // entry toolbar ("2 selected" over an empty list).
                this.selectedEntryIds.clear();
                this.state.notify();
            },
        });

        this.sectionToolbar = el("div", "pc-toolbar pc-section-toolbar");

        this.body = el("div", "pc-body");
        this.leftPanel = el("div", "pc-left-panel");
        // Section toolbar sits permanently at the top of the left
        // panel, above the section list itself ("Left
        // Panel... Contain: Section toolbar at top. A vertical list
        // container for section row cards. Add section button.").
        // It's appended here once and left alone; renderLeftPanel()
        // only ever clears/rebuilds the list+add-button portion below
        // it, never this toolbar.
        this.leftPanel.append(this.sectionToolbar);
        this.splitter = el("div", "pc-splitter", { title: "Drag to resize panels" });
        this.rightPanel = el("div", "pc-right-panel");
        this.body.append(this.leftPanel, this.splitter, this.rightPanel);
        this.wireSplitter();

        this.rightPanel.style.position = "relative";
        this.showConfirmDialog = createConfirmDialog(this.rightPanel);

        this.previewBar = el("div", "pc-preview");
        const previewHeader = el("div", "pc-preview-header");
        // The colorized-preview toggle lives ON the "PREVIEW" label
        // itself (reusing the existing toggle-button pattern
        // rather than adding a second control). OFF looks exactly like
        // a plain label; ON repaints both this label's own
        // letters (rainbow, see _applyPreviewLabelColors) and the
        // preview text below (per-section color, see
        // _renderColorizedPreview) -- and stays live as section colors
        // change, since both repaints run again on every render().
        this.previewColorOn = false;
        const previewLabelTitleOn = "Showing preview in section colors -- click to turn off";
        const previewLabelTitleOff = "Click to show the preview in each section's color";
        this.previewLabel = uiToggle({
            on: false,
            text: "PREVIEW",
            bare: true,
            extra: "pc-preview-label",
            titleOn: previewLabelTitleOn,
            titleOff: previewLabelTitleOff,
            onClick: () => {
                this.previewColorOn = !this.previewColorOn;
                this.previewLabel.classList.toggle("pc-on", this.previewColorOn);
                // uiToggle only resolves titleOn/titleOff once, AT BUILD
                // TIME (applyState -- which would keep this live -- is
                // only wired up when iconOn/iconOff are given, and this
                // toggle has neither: it's text+per-letter spans, not an
                // icon). Flip it here so the tooltip still tracks state.
                this.previewLabel.title = this.previewColorOn ? previewLabelTitleOn : previewLabelTitleOff;
                // Preserve the textarea's own scroll position explicitly
                // across the toggle rather than assuming it survives on
                // its own: flipping .pc-preview-colorized-active changes
                // the textarea's computed `color` (transparent<->real)
                // and the overlay's `display` (none<->block) in the same
                // paint, and at least some engines can reflow/reset a
                // scrollable text control's scrollTop when its own
                // rendering characteristics change like that even though
                // its actual text and box size never do. Capturing
                // before and restoring after makes the toggle scroll-
                // neutral regardless of whether that reflow happens.
                const preservedScrollTop = this.previewText.scrollTop;
                const preservedScrollLeft = this.previewText.scrollLeft;
                this._refreshPreviewColorState();
                this.previewText.scrollTop = preservedScrollTop;
                this.previewText.scrollLeft = preservedScrollLeft;
                // _renderColorizedPreview() already re-syncs the overlay
                // to previewText.scrollTop once, but that happened
                // BEFORE the restore two lines up -- sync it again now
                // that the textarea is back where it started.
                this.previewColorLayer.scrollTop = this.previewText.scrollTop;
                this.previewColorLayer.scrollLeft = this.previewText.scrollLeft;
            },
        });
        // uiBtn(text:...) sets textContent, which would leave "PREVIEW"
        // as one un-splittable text node -- rebuild it as one span per
        // letter (spaces included, as empty-content spacers) so the
        // rainbow state can color each letter independently. Static:
        // built once here, never rebuilt, so a render() storm can't
        // thrash seven span elements pointlessly -- only their color
        // is ever touched afterward (_applyPreviewLabelColors).
        this.previewLabel.textContent = "";
        this._previewLabelLetterEls = [...PREVIEW_LABEL_TEXT].map((ch) => {
            const span = el("span", "pc-preview-label-letter", { text: ch === " " ? "\u00a0" : ch });
            this.previewLabel.appendChild(span);
            return span;
        });
        const btnCopy = uiBtn({ icon: "copy", size: 14, iconOnly: false, extra: "pc-copy-btn", title: "Copy to clipboard", onClick: () => navigator.clipboard.writeText(this.previewText.value) });

        const spacer = el("div", "pc-preview-header-spacer");
        // the executed-output face in the UI: two independent action chips in the
        // preview header, each visible ONLY while its own
        // difference from the last real run exists -- executedChipStates
        // owns the rules, headless-tested in verify_workflow_restore.mjs:
        //   "Edited"     composition drifted -> click copies the executed
        //                prompt (the literal string that made the output);
        //   "Reset Seed" seed drifted -> click writes the executed seed
        //                back into the widget (reproduce the run).
        // A red error chip covers "ran but the record could not arrive".
        this._executed = null; // {prompt, seed, at}
        // executed-output cross-graph hygiene: stash records outlive
        // workflows while node ids restart from 1, so THIS instance only
        // adopts writes that happened after its own birth. _pcBaselineAt
        // = newest stash timestamp seen at creation (null until primed);
        // _pcAdoptedAt = the exact record timestamp already consumed.
        this._pcBaselineAt = null;
        this._pcAdoptedAt = null;
        // True from "a loaded workflow lowered my baseline"
        // until the next poll tick resolves the question (adopted newer
        // OR confirmed none exists) -- drift chips label themselves
        // "Checking..." meanwhile instead of asserting queue-time data.
        this._pcCatchingUp = false;
        // Fetch-failure state for a node that DID execute (see
        // requestExecutedOutput): surfaced as a red chip so a broken
        // chain is visible without opening any console.
        this._executedError = null;
        // Two independent action chips + the error chip, each
        // visible ONLY while its own condition holds (pure rules in
        // executedChipStates). Edited -> copies the executed prompt;
        // Reset Seed -> writes the executed seed back into the widget.
        // Each ALSO answers a 1-second press-
        // and-hold, which accepts the CURRENT state as the executed
        // baseline instead of acting on the executed one -- the local,
        // deliberate way to retire a chip the user knows is stale
        // (e.g. re-adopted from a workflow file after a reload).
        this.editedChip = uiBtn({
            bare: true,
            extra: "pc-exec-chip pc-exec-chip-edited",
            type: "button",
            text: "Edited",
            onClick: () => {
                if (this.editedChip._pcHoldFired) return; // hold consumed it
                // An executed "" is a REAL record (empty run)
                // and clicking still copies it -- the string compare,
                // not truthiness, is the test.
                if (this._executed && typeof this._executed.prompt === "string") {
                    navigator.clipboard.writeText(this._executed.prompt);
                }
            },
        });
        this.resetSeedChip = uiBtn({
            bare: true,
            extra: "pc-exec-chip pc-exec-chip-seed",
            type: "button",
            text: "Reset Seed",
            onClick: () => {
                if (this.resetSeedChip._pcHoldFired) return; // hold consumed it
                this._resetSeedToExecuted();
            },
        });
        bindPressAndHold(this.editedChip, () => this.acceptCurrentAsExecuted());
        bindPressAndHold(this.resetSeedChip, () => this.acceptCurrentSeedAsExecuted());
        this.execErrorChip = uiBtn({
            bare: true,
            extra: "pc-exec-chip pc-exec-chip-error",
            type: "button",
            text: "as generated: unavailable",
            onClick: () => {}, // informational only; the tooltip carries the diagnosis
        });
        for (const chip of [this.editedChip, this.resetSeedChip, this.execErrorChip]) {
            chip.style.display = "none";
        }

        previewHeader.append(this.previewLabel, spacer, this.editedChip, this.resetSeedChip, this.execErrorChip, btnCopy);

        this.previewText = el("textarea", "pc-preview-text", { readonly: "readonly" });
        // The colorized view is a non-interactive overlay pinned exactly
        // over the textarea (see .pc-preview-colorized in the CSS) --
        // both live inside this wrapper so `position: absolute; inset:
        // 0` on the overlay is relative to it, not to the whole preview
        // bar (which also holds the header).
        this.previewTextWrap = el("div", "pc-preview-text-wrap");
        this.previewColorLayer = el("div", "pc-preview-colorized");
        this.previewTextWrap.append(this.previewText, this.previewColorLayer);
        // The overlay's own scrollbar is always hidden (see the CSS),
        // so it never reserves gutter width on its own. If the
        // textarea's NATIVE scrollbar is a classic, space-reserving one
        // (platform/engine dependent -- an overlay-style scrollbar
        // reserves none), its content area is a few pixels narrower
        // than the overlay's whenever a scrollbar is actually showing,
        // and the two would wrap their (otherwise identical) text
        // differently right at that threshold. Compensating with the
        // textarea's OWN measured gutter -- offsetWidth minus
        // clientWidth, zero when no scrollbar is showing or the
        // platform reserves none -- keeps the two boxes' available text
        // width identical without touching the textarea itself (so its
        // OFF-state look and behavior are exactly unchanged), and
        // without hard-coding a scrollbar width that varies by OS/zoom.
        const syncOverlayGutter = () => {
            const gutter = this.previewText.offsetWidth - this.previewText.clientWidth;
            this.previewColorLayer.style.paddingRight = `${4 + gutter}px`;
        };
        // Keep the (invisible-text) overlay's scroll position locked to
        // the real textarea's, so scrolling the preview -- wheel, drag,
        // keyboard -- moves the colored overlay in lockstep instead of
        // leaving it pinned at the top while the real text scrolls
        // underneath it. A no-op while OFF, since nothing looks at the
        // overlay's scroll position then.
        this.previewText.addEventListener("scroll", () => {
            this.previewColorLayer.scrollTop = this.previewText.scrollTop;
            this.previewColorLayer.scrollLeft = this.previewText.scrollLeft;
        });
        // The gutter only exists to measure once content is tall enough
        // to scroll -- re-measure on the same cadence the scroll
        // listener fires (a scroll can only happen once a scrollbar
        // exists) and once eagerly after layout, so turning the toggle
        // ON already has a correct value instead of waiting for a first
        // scroll event that may never come for short text.
        this.previewText.addEventListener("scroll", syncOverlayGutter);
        requestAnimationFrame(syncOverlayGutter);
        this._syncPreviewOverlayGutter = syncOverlayGutter;

        // Hover-highlight + click-to-select for the colorized preview's
        // word spans (see _renderColorizedPreview). Delegated on the
        // overlay's CONTAINER rather than attached per-span: the spans
        // are torn down and rebuilt on every repaint (every completed
        // compose, every color edit), and a per-span listener would
        // need re-attaching every single time; a delegated listener on
        // the stable container needs wiring exactly once here.
        this.previewColorLayer.addEventListener("mouseover", (ev) => this._handlePreviewHover(ev));
        this.previewColorLayer.addEventListener("mouseout", (ev) => this._handlePreviewHover(ev));
        this.previewColorLayer.addEventListener("click", (ev) => this._handlePreviewClick(ev));
        // Forward wheel scrolling straight to the real textarea instead
        // of letting the overlay handle it.
        //
        // The overlay must stay overflow:auto (not hidden) for its
        // scrollTop to be settable at all -- see .pc-preview-colorized's
        // own CSS comment -- but that inescapably also makes it a
        // legitimate wheel-scroll target in its own right the moment a
        // word span under the cursor has pointer-events:auto (needed
        // for hover/click -- see .pc-preview-word's CSS). Without this
        // listener, scrolling while the cursor happens to be over a
        // word span scrolled the OVERLAY's own internal view instead of
        // the textarea underneath -- the textarea (the thing every
        // other consumer of "the scroll position" actually reads) never
        // moved, which looked exactly like "scrolling doesn't work"
        // whenever the mouse was over text rather than blank space.
        // preventDefault() stops the browser from ALSO applying the
        // wheel delta to the overlay itself once it's manually applied
        // here to the textarea; the textarea's own "scroll" listener
        // (registered above) then re-syncs the overlay to match, same
        // as any other textarea scroll (drag, keyboard, trackpad).
        this.previewColorLayer.addEventListener("wheel", (ev) => {
            ev.preventDefault();
            this.previewText.scrollTop += ev.deltaY;
            this.previewText.scrollLeft += ev.deltaX;
        }, { passive: false });

        this.previewBar.append(previewHeader, this.previewTextWrap);

        // The composed string as of the last COMPLETED preview render.
        // Written from onComposed (below) and read at save time for the
        // final_prompt widget / pc_workflow_snapshot. Seeded empty; the
        // first render() (constructor and hydrateFromGraph both funnel
        // through it) refreshes it once resolution lands.
        this._lastComposedPreview = "";

        this.preview = new PreviewController({
            getState: () => this.state,
            getSeed: () => (this.node.seedWidget ? this.node.seedWidget.value : 0),
            getUserPrompt: () => {
                // A string LINKED into user_prompt outranks the
                // textarea, exactly like it does at queue time.
                const linked = resolveLinkedString(this.node);
                if (linked != null) return linked;
                return this.node.userPromptWidget ? this.node.userPromptWidget.value : "";
            },
            outputEl: this.previewText,
            onComposed: (text) => this._mirrorComposedPreview(text),
        });

        this.root.append(this.presetToolbar.root, this.body, this.previewBar);
        this.applySplit();
    }

    wireSplitter() {
        let dragging = false;
        let startX = 0;
        let startFraction = DEFAULT_SPLIT_FRACTION;

        const onMouseMove = (e) => {
            if (!dragging) return;
            const bodyRect = this.body.getBoundingClientRect();
            const bodyWidth = bodyRect.width || 1;
            const deltaX = e.clientX - startX;
            let newFraction = startFraction + deltaX / bodyWidth;
            const minLeftFraction = LEFT_PANEL_MIN_WIDTH / bodyWidth;
            const maxLeftFraction = 1 - (RIGHT_PANEL_MIN_WIDTH + SPLITTER_WIDTH) / bodyWidth;
            newFraction = Math.max(minLeftFraction, Math.min(maxLeftFraction, newFraction));
            this.splitFraction = newFraction;
            this.applySplit();
        };

        const onMouseUp = () => {
            if (!dragging) return;
            dragging = false;
            document.body.classList.remove("pc-resizing");
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
        };

        this.splitter.addEventListener("mousedown", (e) => {
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startFraction = this.splitFraction;
            document.body.classList.add("pc-resizing");
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });

        this.splitter.addEventListener("dblclick", () => this.setSplitFraction(DEFAULT_SPLIT_FRACTION));
    }

    setSplitFraction(fraction) {
        this.splitFraction = Math.max(0, Math.min(1, fraction));
        this.applySplit();
    }

    applySplit() {
        const pct = (this.splitFraction * 100).toFixed(3) + "%";
        this.root.style.setProperty("--pc-split", pct);
        this.root.style.setProperty("--pc-split-min", `${LEFT_PANEL_MIN_WIDTH}px`);
        this.root.style.setProperty("--pc-split-max-reserve", `${RIGHT_PANEL_MIN_WIDTH + SPLITTER_WIDTH}px`);
        this.leftPanel.style.minWidth = `${LEFT_PANEL_MIN_WIDTH}px`;
        this.rightPanel.style.minWidth = `${RIGHT_PANEL_MIN_WIDTH}px`;
    }

    // -- Rendering ----------------------------------------------------------

    toggleLibrarySelection(promptRef) {
        if (!promptRef) return;
        const hasSelection = this.librarySelectedPromptRefs.has(promptRef);
        if (hasSelection) this.librarySelectedPromptRefs.delete(promptRef);
        else this.librarySelectedPromptRefs.add(promptRef);
        // In-place: update the clicked card + the selection strips only. A
        // full render() here rebuilt every row on each click -- the list-view
        // selection lag.
        this.refreshLibrarySelectionUI();
    }

    /**
     * Enter "pick a replacement" mode for one entry whose prompt_ref no
     * longer resolves (the library prompt it pointed to was deleted).
     * Opens the Library panel and remembers which entry we're fixing;
     * renderLibraryBrowser() checks `_replacingEntryTarget` and, while
     * set, makes every library card act as "replace with this" instead
     * of the panel's normal bulk-select/drag behavior (see its onClick
     * wiring below).
     */
    startReplacingEntry(sectionId, entryId) {
        this.editTarget = null;
        this.librarySelectedPromptRefs.clear();
        this._addingToSection = null;
        this._replacingEntryTarget = { sectionId, entryId };
        this.showLibraryPanel = true;
        this.render();
    }

    cancelReplacingEntry() {
        const target = this._replacingEntryTarget;
        this._replacingEntryTarget = null;
        // Back out the same way a successful pick lands: close the Library
        // and return to the section the missing card lives in -- the section
        // the person was working on when they pressed "(Missing)". Leaving
        // them on the Library panel would strand them somewhere they only
        // opened to fix one card, with no obvious way back.
        const section = target && this.state.sections.find((s) => s.id === target.sectionId);
        this.showLibraryPanel = false;
        if (section) this.state.activeSectionId = section.id;
        this.render();
    }

    /**
     * Enter "pick prompts to add" mode for a section: open the Library panel
     * and remember which section the picks are for, so the toolbar can offer
     * one obvious way to finish and the person can see at a glance that the
     * panel is in a mode rather than being browsed.
     */
    startAddingToSection(section) {
        if (!section || section.is_locked_prompt) return;
        this.editTarget = null;
        // The two focused modes are mutually exclusive: both own the click
        // on a library card, and one asking "which prompt replaces it?" while
        // the other asks "which prompts to add?" would answer neither.
        this._replacingEntryTarget = null;
        this._addingToSection = { sectionId: section.id };
        this.librarySelectedPromptRefs.clear();
        // Snapshot WHERE in this section's list the person is looking --
        // the section grid is still mounted at this instant, so the
        // middle of its viewport (and everything else the plan needs)
        // can only be measured now, before the Library replaces it.
        // See confirmAddingToSection for how the commit uses it.
        this._addReturnPlan = this._captureAddPlacement(section);
        this.showLibraryPanel = true;
        this.render();
    }

    /**
     * The commit placement plan, measured against the live section
     * grid: which entry sits at the middle of the viewport right now
     * (the new entries will be inserted THERE, among what the person
     * can see), or the plain end when the scroll had already passed
     * 99% of the list -- or the whole list fits, or there is nothing
     * below the middle line.
     */
    _captureAddPlacement(section) {
        const container = this.rightPanel.querySelector(".pc-browse-section");
        const end = { sectionId: section.id, anchorEntryId: null, nearEnd: true };
        if (!container) return end;
        const max = container.scrollHeight - container.clientHeight;
        if (max <= 1) return end; // whole list visible -- appending IS the end
        if (max - container.scrollTop < nearEndDistance(container)) return end;
        const midline = container.scrollTop + container.clientHeight / 2;
        for (const card of container.children) {
            const id = card.dataset && card.dataset.entryId;
            if (!id) continue;
            // display:none cards have no layout at all (offsetParent is
            // null), and they can never be "the card at the middle"
            // anyway -- skip before measuring, or the zero offsetTop
            // would pick one.
            if (card.offsetParent === null) continue;
            if (layoutTopWithin(card, container) + card.offsetHeight > midline) {
                end.anchorEntryId = id;
                end.nearEnd = false;
                return end;
            }
        }
        return end; // nothing below the middle line: same as the end
    }

    /**
     * Back out of the mode and go where the person came from.
     *
     * The section they pressed Add in is the screen they were working on, so
     * that is where Cancel returns to -- leaving them sitting on the Library
     * panel would strand them somewhere they never asked to visit. Same
     * destination as a successful commit, for the same reason: the mode is
     * about that section, so it should always end on that section.
     */
    cancelAddingToSection() {
        const section = this.addingToSectionTarget();
        this._addingToSection = null;
        this._addReturnPlan = null;
        this.librarySelectedPromptRefs.clear();
        if (section) {
            this.showLibraryPanel = false;
            this.state.activeSectionId = section.id;
        }
        this.render();
    }

    /**
     * The section this mode is adding to, or null once the mode has stopped
     * meaning what it says.
     *
     * Evaluated on every render rather than cleared by hand at the few exit
     * points anyone thought to enumerate. The failure mode of a persistent
     * mode is precisely the action nobody listed -- open an unrelated panel,
     * delete the target section, close the library -- and each one would
     * leave a button on screen offering something that no longer applies.
     */
    addingToSectionTarget() {
        const target = this._addingToSection;
        if (!target) return null;
        if (!this.showLibraryPanel) return null;
        // Creating or editing a prompt is the mode reaching for something it
        // does not have yet -- you are picking prompts to add, notice the one
        // you want is wrong or missing, and go fix it. That is the same task
        // continued, not a change of subject, so the mode waits behind the
        // panel and resumes when it closes. Any other panel genuinely is a
        // different task, and drops the mode.
        if (this.editTarget && !isLibraryPromptEdit(this.editTarget)) return null;
        const section = this.state.sections.find((s) => s.id === target.sectionId);
        if (!section || section.is_locked_prompt) return null;
        return section;
    }

    /**
     * Drop any focused mode that has stopped meaning what it says. Called
     * at the top of render(), before a single panel is built, so the render
     * that the distracting action triggers already shows the ordinary UI.
     */
    pruneStaleModes() {
        if (this._addingToSection && !this.addingToSectionTarget()) this._addingToSection = null;
        // Drop selected prompts that no longer exist -- deleted in the OS file
        // explorer then rescanned, or removed through the edit panel -- so the
        // bulk-action counter never counts ghosts whose cards are already gone
        // from the rebuilt list. Runs before the panel is built, so the count
        // the strips show is the count of cards actually on screen.
        if (this.library._loaded && this.librarySelectedPromptRefs.size) {
            const live = new Set(this.library.entries.map((e) => e.prompt_ref));
            for (const ref of Array.from(this.librarySelectedPromptRefs)) {
                if (!live.has(ref)) this.librarySelectedPromptRefs.delete(ref);
            }
        }
    }

    /**
     * Select every prompt the current filters leave on screen.
     *
     * "All" means all you can SEE, never the ones the search box, the
     * category dropdown or the star have hidden -- same rule the section
     * panel's select-all follows, and the reason a person can reach for it
     * confidently after narrowing to one category.
     */
    selectAllPromptsToAdd() {
        for (const entry of this.library.getVisibleEntries()) {
            this.librarySelectedPromptRefs.add(entry.prompt_ref);
        }
        this.refreshLibrarySelectionUI();
    }

    deselectAllPromptsToAdd() {
        this.librarySelectedPromptRefs.clear();
        this.refreshLibrarySelectionUI();
    }

    /**
     * A freshly created prompt comes back ALREADY SELECTED -- the general
     * rule, not just inside the add-to-section mode. The usual reason to
     * reach for "Add prompt" mid-pick is that the prompt you need does
     * not exist yet, so the very next step after saving it is to use it;
     * pre-picking turns "find your new card in a list of hundreds and
     * tick it" into one click on the button that was already there.
     * Outside the mode it reads the same way: the new prompt is the
     * thing you just made, and the bulk bar opens with it selected.
     */
    autoSelectCreatedPrompt(promptRef) {
        if (!promptRef) return;
        this.librarySelectedPromptRefs.add(promptRef);
    }

    /** Commit the selected prompts into the section, and leave the mode. */
    confirmAddingToSection() {
        const section = this.addingToSectionTarget();
        this._addingToSection = null;
        const refs = Array.from(this.librarySelectedPromptRefs);
        const plan = this._addReturnPlan;
        this._addReturnPlan = null;
        this.librarySelectedPromptRefs.clear();
        if (!section || !refs.length) {
            this.render();
            return;
        }
        // Same batching as the drag-and-drop path this mode is the keyboard
        // equivalent of (see onDropLibraryPrompts): one notify for the whole
        // add, not one per prompt.
        //
        // The destination is set BEFORE the batch, not after it:
        // withBatch fires a notify() of its own when it closes, and the
        // old order (batch → then switch views → then render) burned a
        // frame re-rendering the Library the person had just committed
        // away from, before a second render finally showed the section.
        // One render, rendering the right thing. Where the viewport
        // lands on the way back is the batch's _requestBrowseToEnd /
        // remembered-position logic below: a tail-appended block is
        // revealed at the bottom, a moved block comes back
        // to the remembered position -- same as Cancel.
        const added = [];
        this.showLibraryPanel = false;
        this.state.activeSectionId = section.id;
        this.state.withBatch(() => {
            for (const promptRef of refs) {
                const entry = this.state.addEntryFromLibrary(section.id, promptRef);
                if (entry) added.push(entry);
            }
            if (!added.length) return;
            const ids = added.map((e) => e.id);
            // addEntryFromLibrary appends; the plan says the block
            // belongs among the entries the person was LOOKING AT, not
            // off the bottom of the list. moveEntries takes the
            // insertion point measured on the current list (block
            // included, sitting at the tail), so the anchor's own index
            // IS the target -- and with nothing dragged before it, the
            // block lands exactly there in pick order. Its notify is
            // batched like the adds', so this all flushes as the single
            // render below.
            let movedBlock = false;
            if (plan && plan.sectionId === section.id && !plan.nearEnd) {
                const anchorIdx = plan.anchorEntryId
                    ? section.entries.findIndex((e) => e.id === plan.anchorEntryId)
                    : -1;
                if (anchorIdx >= 0 && anchorIdx < section.entries.length - added.length) {
                    this.state.moveEntries(section.id, ids, anchorIdx);
                    movedBlock = true;
                }
            }
            // When the block STAYS at the end (plain append,
            // or a nearEnd plan) reveal it -- browsing back to the tail
            // is the whole point of adding there. A moved block sits by
            // the anchor, already inside the remembered viewport, so
            // memory stays untouched.
            if (!movedBlock) this._requestBrowseToEnd(section);
        });
    }

    /**
     * Other cards in the preset that are missing the same prompt as `entry`.
     *
     * Matched on the decoded Prompt Name half of the ref rather than the
     * whole string, because that is what a person recognises: a preset
     * can hold dead refs that share a name but differ in uid (the prompt
     * was deleted and a same-named one saved over the gap), and on screen
     * every one of them reads as the same broken thing. The comparison is
     * case-insensitive -- names differing only by case are the same name
     * under the naming rules.
     *
     * Only genuinely-missing cards come back. Anything still carrying
     * `entry`'s own ref is missing by identity -- same string, same failed
     * lookup -- so it needs no check; the different-ref candidates are
     * resolved and kept only if they fail too. If that resolve request
     * itself fails, we fall back to the identity-missing ones, because
     * sweeping refs we could not verify would silently repoint live cards.
     */
    async missingSiblingsFor(entry) {
        const nameKey = splitPromptRef(entry.prompt_ref).name.toLowerCase();
        if (!nameKey) return [];
        const sameName = [];
        for (const section of this.state.sections) {
            for (const other of section.entries) {
                if (other === entry || !other.prompt_ref) continue;
                if (splitPromptRef(other.prompt_ref).name.toLowerCase() !== nameKey) continue;
                sameName.push({ sectionId: section.id, entry: other });
            }
        }
        if (!sameName.length) return [];
        const toCheck = sameName
            .map((s) => s.entry.prompt_ref)
            .filter((ref) => ref !== entry.prompt_ref);
        if (!toCheck.length) return sameName;
        const resolved = await tryResolveForDisplay(toCheck);
        if (!resolved) return sameName.filter((s) => s.entry.prompt_ref === entry.prompt_ref);
        return sameName.filter(
            (s) => s.entry.prompt_ref === entry.prompt_ref || !resolved[s.entry.prompt_ref]
        );
    }

    /**
     * Called when the person clicks a library card while in
     * replacement-picking mode: point the target entry's prompt_ref at the
     * clicked prompt, drop pick mode, and return to that entry's own section
     * so the person immediately sees the fixed card.
     *
     * Where other cards are missing the same prompt, they are offered up
     * first -- see missingSiblingsFor.
     */
    async finishReplacingEntry(newPromptRef) {
        const target = this._replacingEntryTarget;
        if (!target || !newPromptRef) return;
        const section = this.state.sections.find((s) => s.id === target.sectionId);
        const entry = section && section.entries.find((e) => e.id === target.entryId);
        this._replacingEntryTarget = null;
        if (!section || !entry) {
            // The entry or its section was removed while the person was
            // off picking a replacement (e.g. deleted from another
            // action) -- nothing left to fix; just leave the library
            // panel open rather than erroring.
            this.render();
            return;
        }
        const oldRef = entry.prompt_ref;
        const siblings = oldRef === newPromptRef ? [] : await this.missingSiblingsFor(entry);
        let refsToRewrite = [];
        if (siblings.length && this.showConfirmDialog?.choice) {
            const count = siblings.length;
            const choice = await this.showConfirmDialog.choice({
                title: "Resolve the other missing cards?",
                message: `"${splitPromptRef(oldRef).name}" is missing on ${count} other card${count === 1 ? "" : "s"} in this preset. Fix them all with the prompt you just selected, or only the card you clicked?`,
                choices: [
                    { value: "one", label: "Resolve one" },
                    { value: "all", label: "Resolve all", primary: true },
                ],
            });
            // Cancel and "Resolve one" deliberately land in the same place:
            // fixing this one card is what picking a replacement already
            // asked for, so backing out of the wider offer must not throw
            // that away and send the person back to start over.
            if (choice === "all") {
                refsToRewrite = Array.from(new Set([oldRef, ...siblings.map((s) => s.entry.prompt_ref)]));
            }
        }
        if (refsToRewrite.length) {
            // rewriteEntryPromptRefs walks every section, which is exactly
            // the reach "Resolve all" promises.
            for (const ref of refsToRewrite) this.rewriteEntryPromptRefs(ref, newPromptRef);
        } else {
            // "Resolve one" means the one card, even where others carry the
            // identical dead ref -- they are the same missing prompt, but
            // the person was offered that choice and did not take it.
            entry.prompt_ref = newPromptRef;
        }
        this.showLibraryPanel = false;
        this.state.activeSectionId = section.id;
        this.state.notify();
    }

    /**
     * The Library panel's bulk-action bar: same idea as sectionBulkToolbar,
     * a shorter list. Prompts are files on disk, so there is no clipboard
     * to copy/cut/paste against -- only Delete and the selection controls.
     * With no clipboard to open it early either, this one appears exactly
     * when one or more prompts are selected.
     *
     * "Select all" means all CURRENTLY VISIBLE prompts rather than the
     * whole library: with a search or category filter on, that is what the
     * button appears to describe, and a delete that quietly swept up the
     * prompts hidden behind the filter would be a nasty surprise.
     */
    libraryBulkToolbar() {
        const selectedCount = this.librarySelectedPromptRefs.size;
        // A bar that says "0 selected" cannot exist -- and neither may the
        // filter it owns: releasing here covers every path that empties the
        // selection (Deselect-all, deleting the selected prompts, ...). If it
        // stayed on while the chip vanished, every row would sit
        // display:none behind a controlless filter -- the refetch/render
        // would show nothing until the view key happened to change.
        if (!selectedCount) {
            if (this.librarySelectedOnly) {
                this.librarySelectedOnly = false;
                this.filterLibraryEntries(this.library.searchText);
            }
            return null;
        }
        // While picking prompts to ADD, the very same checkboxes mean "to
        // add", not "to delete". Showing a delete bar over that selection
        // would offer the opposite of what the person is doing, so the bar
        // stands down for the duration of the mode -- and the filter stands
        // down with it (its clause already ignores add-mode ticks; lifting
        // the flag keeps the chip's ring and the rows honest when the mode
        // ends).
        if (this.addingToSectionTarget()) {
            if (this.librarySelectedOnly) {
                this.librarySelectedOnly = false;
                this.filterLibraryEntries(this.library.searchText);
            }
            return null;
        }
        return buildBulkActionToolbar({
            scope: "library",
            selectedCount: selectedCount,
            showClipboardActions: false,
            noun: "prompts",
            selectedOnly: this.librarySelectedOnly,
            onToggleSelectedOnly: () => this._applyLibrarySelectedOnlyToggle(),
            onDelete: async () => {
                const refs = Array.from(this.librarySelectedPromptRefs);
                if (!refs.length) return;
                const confirmed = await this.showConfirmDialog({
                    title: "Delete selected prompts?",
                    message: `Delete ${refs.length} selected prompt${refs.length === 1 ? "" : "s"} from the library? This cannot be undone.`,
                    confirmLabel: "Delete",
                });
                if (!confirmed) return;
                for (const promptRef of refs) {
                    await this.library.remove(promptRef);
                }
                this.librarySelectedPromptRefs.clear();
                this.preview.invalidate(refs);
                this.render();
            },
            onSelectAll: () => {
                for (const entry of this.library.getVisibleEntries()) {
                    this.librarySelectedPromptRefs.add(entry.prompt_ref);
                }
                this.refreshLibrarySelectionUI();
            },
            onClearSelected: () => {
                this.librarySelectedPromptRefs.clear();
                this.refreshLibrarySelectionUI();
            },
        });
    }

    /**
     * The "pick prompts to add" strip (Library panel, add-to-section mode).
     * Returns null outside that mode. Rebuilt in full on each selection
     * change -- it is three buttons, so this is cheap -- which is what lets
     * the confirm button's "Add N prompts" label and the deselect button's
     * disabled state track the selection without touching the rows.
     */
    libraryPickAddToolbar(section) {
        if (!section) return null;
        const count = this.librarySelectedPromptRefs.size;
        const visibleCount = this.library.getVisibleEntries().length;

        const btnSelectAllPrompts = uiBtn({
            icon: "list",
            size: 16,
            type: "button",
            title: visibleCount ? "Select all prompts" : "Nothing to select in the current view",
            onClick: () => this.selectAllPromptsToAdd(),
            extra: "pc-entry-selection-reset",
            hook: "pickAddSelectAll",
            disabled: visibleCount === 0,
        });

        const btnConfirmAdd = uiBtn({
            type: "button",
            text: count ? `Add ${count} prompt${count === 1 ? "" : "s"}` : `Select prompts`,
            title: count ? `Add the selected prompts to "${section.name}"` : "Select at least one prompt first",
            onClick: () => this.confirmAddingToSection(),
            variant: "primary",
            extra: "pc-pick-add-confirm",
            hook: "pickAddConfirm",
            disabled: count === 0,
        });

        const btnDeselectAllPrompts = uiBtn({
            icon: "cancel",
            size: 16,
            type: "button",
            title: "Deselect all prompts",
            onClick: () => this.deselectAllPromptsToAdd(),
            extra: "pc-entry-selection-reset",
            hook: "pickAddDeselectAll",
            disabled: count === 0,
        });

        const group = el("div", "pc-entry-toolbar-group pc-pick-add-group");
        group.append(btnSelectAllPrompts, btnConfirmAdd, btnDeselectAllPrompts);
        const pickAddToolbar = el("div", "pc-bulk-toolbar pc-pick-add-toolbar");
        pickAddToolbar.style.setProperty("--accent", section.color);
        pickAddToolbar.dataset.pickAddToolbar = "true";
        pickAddToolbar.append(group);
        return pickAddToolbar;
    }

    /**
     * Rebuild ONLY the two selection strips (pick-add + bulk-action) at
     * their stored anchors. Called on every selection change and once at the
     * end of renderLibraryBrowser, so there is a single code path that owns
     * them. Never touches the rows -- that is the whole point.
     */
    _renderLibrarySelectionChrome() {
        const wrap = this._libWrap;
        if (!wrap || !wrap.isConnected) return;
        if (this._libPickAddNode) {
            this._libPickAddNode.remove();
            this._libPickAddNode = null;
        }
        const pickAdd = this.libraryPickAddToolbar(this._libAddingSection);
        if (pickAdd) {
            wrap.insertBefore(pickAdd, this._libToolbarAnchor);
            this._libPickAddNode = pickAdd;
        }
        if (this._libBulkNode) {
            this._libBulkNode.remove();
            this._libBulkNode = null;
        }
        const bulk = this.libraryBulkToolbar();
        if (bulk) {
            wrap.insertBefore(bulk, this._libBulkBefore);
            this._libBulkNode = bulk;
        }
    }

    /**
     * Push the current selection set onto the already-built cards: toggle the
     * `.pc-selected` class and the select checkbox on each. This is a handful of
     * classList/property writes over existing nodes -- no element is created
     * or destroyed -- so it stays fast even with a large library, unlike a
     * full render() that rebuilds every row.
     */
    _syncLibraryCardsSelection() {
        const container = this._libRowsContainer;
        if (!container) return;
        const selected = this.librarySelectedPromptRefs;
        for (const card of container.querySelectorAll("[data-prompt-ref]")) {
            const on = selected.has(card.dataset.promptRef);
            card.classList.toggle("pc-selected", on);
            const checkbox = card.querySelector(".pc-entry-select-checkbox");
            if (checkbox) checkbox.checked = on;
        }
        // In THIS panel the .pc-selected class IS the pick, so the bulk
        // toolbar's show-only-selected filter reads exactly
        // what we just toggled. While it is on, a deselect must hide the
        // card and a (Select-all) select must reveal it -- re-run the one
        // display pass so the view tracks the class we just moved.
        if (this.librarySelectedOnly) {
            // Through the one search pass, so deselecting under
            // a live query refreshes rank + marks too, not just display.
            this.filterLibraryEntries(this.library.searchText);
        }
    }

    /**
     * The lightweight replacement for render() on a selection change: update
     * the cards in place and rebuild the selection strips. Falls back to a
     * full render() only if the Library browser isn't the mounted view (a
     * selection change can only originate from its cards, so this is just a
     * safety net against a stale container reference).
     */
    refreshLibrarySelectionUI() {
        if (!this._libRowsContainer || !this._libRowsContainer.isConnected) {
            this.render();
            return;
        }
        this._syncLibraryCardsSelection();
        this._renderLibrarySelectionChrome();
    }

    notifyInPlace() {
        this.state.reindexOrder();
        this.syncWidget();
        this.preview.render();
        // In-place edits (entry show/hide, randomize, separator) change
        // real preset fields but deliberately skip the full render() that
        // would otherwise re-check the Save button's dirty colour -- so
        // re-check it here. Without this, toggling a card's show/hide
        // updates the composition but leaves the toolbar claiming "saved".
        this.presetToolbar.refreshDirtyState();
    }

    refreshRenderedEntry(entry) {
        const element = this.rightPanel.querySelector(`[data-entry-id="${CSS.escape(entry.id)}"]`);
        if (!element) return;
        element.classList.toggle("pc-entry-visible", !!entry.visible);
        element.classList.toggle("pc-entry-hidden", !entry.visible);
        element.classList.toggle("pc-selected", this.selectedEntryIds.has(entry.id));
        // The visible-only filter reads the .pc-entry-visible class we JUST changed,
        // and the selected-only filter the .pc-selected class toggled
        // one line above -- so a card flipping either way while either
        // filter is on must re-evaluate its own display; otherwise
        // unchecking a card would leave it on screen (checking one would
        // leave it hidden). Only the single changed card moves; no
        // full-panel pass.
        if ((this.sectionVisibleOnly || this.sectionSelectedOnly || this.alertsOnlyMode) && element.dataset.searchText !== undefined) {
            // Through the shared row decision, so a card
            // flipping state under a live query also gets its rank and
            // marks refreshed -- not just its display.
            this._applySectionRow(
                element,
                this._sectionSearchCtx(this.sectionSearchText, this.sectionSelectedCategory),
            );
        }

        const randomButton = element.querySelector(".pc-entry-random-btn");
        if (randomButton) {
            // Routed through the toggle factory's own live
            // re-apply. The hand-written copy managed pc-on but NOT
            // pc-always-visible -- the class that keeps an ON button
            // shown while the card is not hovered -- so it drifted with
            // every in-place flip: an on-built card's button stayed
            // visible after turning off, an off-built one never showed
            // after turning on. applyState toggles every onClass token
            // the build used, which gives the random button exactly the
            // separator's behavior: gone while off and unhovered.
            randomButton.applyState(!!entry.allow_random);
        }

        const separatorButton = element.querySelector(".pc-entry-separator-btn");
        if (separatorButton) {
            const separator = normalizeEntrySeparator(entry.entry_separator);
            if (separator === "none") separatorButton.innerHTML = svgIcon("none", 14);
            else separatorButton.textContent = ENTRY_SEPARATOR_GLYPH[separator];
            separatorButton.title = `Entry separator: ${separator} (click to cycle none → , → and)`;
            separatorButton.classList.toggle("pc-always-visible", separator !== "none");
        }

        const checkbox = element.querySelector(".pc-entry-select-checkbox");
        if (checkbox) checkbox.checked = this.selectedEntryIds.has(entry.id);
    }

    /**
     * How many of a section's currently-selected entries can actually go
     * on the clipboard, i.e. everything selected EXCEPT the ones whose
     * prompt_ref no longer resolves. Missing entries are deliberately
     * not copyable/cuttable/pasteable: their only real content is a
    /**
     * How many of THIS section's entries are bulk-selected.
     *
     * Deliberately NOT `selectedEntryIds.size`. That Set is shared across
     * every section and only cleared on some navigation paths, so its raw
     * size can count picks made in a section the person already left --
     * which is exactly how a freshly created, empty section ended up
     * showing "2 selected" with a select-all/deselect pair for a selection
     * it does not have. Anything that reports or acts on the selection has
     * to ask relative to the section it is about to act on; Copy, Cut and
     * the missing-entry count already did, and this is the rest of them
     * catching up.
     */
    selectedCountInSection(section) {
        let count = 0;
        for (const entry of section.entries) {
            if (this.selectedEntryIds.has(entry.id)) count += 1;
        }
        return count;
    }

    /** How many selected entries of this section actually resolve. A dead
     * pointer to a prompt that isn't there anymore, so copying one just
     * clones a broken card into wherever it's pasted.
     */
    copyableSelectedCount(section) {
        let count = 0;
        for (const entry of section.entries) {
            if (this.selectedEntryIds.has(entry.id) && !this._missingEntryIds.has(entry.id)) count += 1;
        }
        return count;
    }

    /** The selected, non-missing entries, in section order, as clipboard
     * records. Shared by Copy and Cut so both agree on what "the
     * selection, minus what can't be copied" means. */
    buildClipboardEntries(section) {
        return section.entries
            .filter((e) => this.selectedEntryIds.has(e.id) && !this._missingEntryIds.has(e.id))
            .map((e) => ({ prompt_ref: e.prompt_ref, allow_random: e.allow_random, entry_separator: e.entry_separator }));
    }

    /**
     * The section panel's own toolbar: panel-level actions, plus Paste.
     *
     * Extracted from the render path because Paste tracks the clipboard, so
     * anything that puts something on the clipboard has to rebuild this bar
     * as well -- see refreshEntryToolbar.
     */
    sectionEntryToolbar(section) {
        return buildEntryToolbar(section, {
            viewMode: this.viewMode,
            searchVisible: this.sectionSearchVisible,
            hasClipboard: !!(this._entryClipboard && this._entryClipboard.length),
            onAdd: () => {
                // Not just "show the library": this opens it in a mode that
                // says which section the picks belong to and gives one
                // button to commit them. See startAddingToSection.
                this.startAddingToSection(section);
            },
            onPaste: async () => {
                if (!this._entryClipboard || !this._entryClipboard.length) return;
                // Re-resolve the clipboard's refs at paste time instead of
                // trusting it: a prompt can have been deleted from the
                // library after it was copied, and pasting that would plant
                // a brand-new missing entry. `null` means the resolve
                // request itself failed (not "everything is gone"), in which
                // case paste as-is rather than pretending the clipboard died.
                const refs = Array.from(new Set(this._entryClipboard.map((c) => c.prompt_ref)));
                const resolved = await tryResolveForDisplay(refs);
                const pastable = resolved
                    ? this._entryClipboard.filter((clip) => clip.prompt_ref && resolved[clip.prompt_ref])
                    : this._entryClipboard;
                if (!pastable.length) return;
                // Same batching rationale as onCut/onDelete --
                // addEntryFromLibrary() also notifies per call.
                this.state.withBatch(() => {
                    for (const clip of pastable) {
                        const entry = this.state.addEntryFromLibrary(section.id, clip.prompt_ref);
                        if (entry) {
                            entry.allow_random = clip.allow_random;
                            entry.entry_separator = clip.entry_separator;
                        }
                    }
                    // Pasted cards append at the end -- reveal them
                    // (the request is set inside the batch so the
                    // close-notify render already carries it).
                    this._requestBrowseToEnd(section);
                });
            },
            onShowAll: () => {
                for (const entry of section.entries) entry.visible = true;
                this.refreshAllRenderedEntries(section);
                this.refreshSectionCounter(section);
                // Hide-all must re-gate: this path flips counts without a
                // toolbar rebuild, and refreshAllRenderedEntries only
                // touches cards. Same rule as every other count-changing
                // path (and it releases the counter's view filter if the
                // flip emptied visibility while it was on).
                this.refreshEntryToolbarHideAllGate(section);
                this.notifyInPlace();
            },
            onHideAll: () => this.hideAllSectionEntries(section),
            onToggleView: () => {
                this.viewMode = this.viewMode === "grid" ? "list" : "grid";
                this.render();
            },
            onToggleSearch: () => this._applySectionSearchToggle(section),
        });
    }

    /**
     * The section panel's bulk-action bar: the controls that act on the
     * SET of selected entries rather than on the panel itself. Rendered
     * directly below the entry toolbar, and returns null -- contributing
     * no element at all -- unless something is selected.
     *
     * Paste does not live here: it would let the bar open on an empty
     * selection (its main use is a freshly-added, still-empty section),
     * showing a lone disabled-looking cluster over nothing. Paste sits in
     * the entry toolbar beside Add instead
     * (see sectionEntryToolbar), which is where it belongs and where it can
     * simply be absent when the clipboard is empty. This bar is now purely
     * about the selection.
     */
    sectionBulkToolbar(section) {
        const selectedCount = this.selectedCountInSection(section);
        if (!selectedCount) {
            // Same release doctrine as libraryBulkToolbar: the chip that
            // owns the filter is about to go absent, so the filter cannot
            // outlive it -- un-hide the rows before the bar disappears.
            if (this.sectionSelectedOnly) {
                this.sectionSelectedOnly = false;
                this.filterSectionEntries(this.sectionSearchText || "", this.sectionSelectedCategory || "All");
            }
            return null;
        }
        return buildBulkActionToolbar({
            scope: "section",
            selectedCount,
            copyableSelectedCount: this.copyableSelectedCount(section),
            showClipboardActions: true,
            noun: "entries",
            selectedOnly: this.sectionSelectedOnly,
            onToggleSelectedOnly: () => this._applySectionSelectedOnlyToggle(),
            onCopy: () => {
                // Copy only populates the clipboard -- it does NOT
                // duplicate/mutate anything in place. The user then
                // explicitly Pastes (here, to duplicate within the
                // same section, or after switching to a different
                // section, to copy entries across). This mirrors Cut
                // below, minus the removal step.
                //
                // Missing entries are filtered out (see
                // copyableSelectedCount): a dead prompt_ref is not
                // content, so it never enters the clipboard.
                const clipboard = this.buildClipboardEntries(section);
                if (!clipboard.length) return;
                this._entryClipboard = clipboard;
                this.refreshEntryToolbar(section);
            },
            onCut: () => {
                const clipboard = this.buildClipboardEntries(section);
                if (!clipboard.length) return;
                this._entryClipboard = clipboard;
                // Only the entries that actually made it onto the
                // clipboard are removed -- a selected-but-missing entry
                // stays put rather than being silently deleted with
                // nothing to show for it.
                const idsToCut = new Set(
                    section.entries
                        .filter((e) => this.selectedEntryIds.has(e.id) && !this._missingEntryIds.has(e.id))
                        .map((e) => e.id)
                );
                for (const id of idsToCut) this.selectedEntryIds.delete(id);
                // withBatch: removeEntry() would otherwise call
                // notify() (-> a full render()) once per id in this
                // loop, rebuilding the right panel N times for what
                // is, from the person's perspective, a single cut
                // action. Collapsing it to one notify() at the end
                // avoids the visible per-card stutter on larger
                // multi-select cuts.
                this.state.withBatch(() => {
                    for (const id of idsToCut) {
                        this.state.removeEntry(section.id, id);
                    }
                });
            },
            onDelete: async () => {
                // Section-scoped on purpose. The selected Set is shared
                // across sections, so working from its raw size could offer
                // to delete -- and then try to delete -- entries selected in
                // a section the person has already navigated away from.
                const idsToDelete = section.entries
                    .filter((e) => this.selectedEntryIds.has(e.id))
                    .map((e) => e.id);
                const count = idsToDelete.length;
                if (count === 0) return;
                const confirmed = await this.showConfirmDialog({
                    title: "Delete entries?",
                    message: `Delete ${count} selected entr${count === 1 ? "y" : "ies"}? This cannot be undone.`,
                    confirmLabel: "Delete",
                });
                if (!confirmed) return;
                for (const id of idsToDelete) this.selectedEntryIds.delete(id);
                // See onCut's comment above -- same batching rationale.
                this.state.withBatch(() => {
                    for (const id of idsToDelete) {
                        this.state.removeEntry(section.id, id);
                    }
                });
            },
            onSelectAll: () => {
                for (const entry of section.entries) this.selectedEntryIds.add(entry.id);
                this.refreshAllRenderedEntries(section);
                this.refreshEntryToolbar(section);
            },
            onClearSelected: () => {
                this.selectedEntryIds.clear();
                this.refreshAllRenderedEntries(section);
                this.refreshEntryToolbar(section);
            },
        });
    }

    /**
     * Re-sync both bars above the entry list after an in-place selection or
     * clipboard change, without paying for a full render().
     *
     * Two elements, because there are now two sources of truth: the bulk bar
     * exists or not based on the selection, and the entry toolbar's Paste
     * button appears or disappears with the clipboard -- which Copy and Cut
     * have just changed. Each is rebuilt whole rather than patched, since
     * rebuilding a handful of stateless buttons is cheaper, and far less
     * fragile, than keeping each in sync by hand.
     */
    refreshEntryToolbar(section) {
        const anchor = this.rightPanel.querySelector('[data-entry-toolbar="section"]');
        if (!anchor) return;
        anchor.replaceWith(this.sectionEntryToolbar(section));

        const existing = this.rightPanel.querySelector('[data-bulk-toolbar="section"]');
        const next = this.sectionBulkToolbar(section);
        if (!next) {
            existing?.remove();
            return;
        }
        if (existing) {
            existing.replaceWith(next);
        } else {
            // Re-query: `anchor` was swapped out above and is detached now,
            // so `after()` has to go through the toolbar that replaced it.
            this.rightPanel.querySelector('[data-entry-toolbar="section"]')?.after(next);
        }
    }

    refreshAllRenderedEntries(section) {
        for (const entry of section.entries) this.refreshRenderedEntry(entry);
    }

    /**
     * The live search pass -- everything a query changes,
     * in one place, over the MOUNTED rows of the library grid:
     *  1. visibility: word-AND over the row's search blob, plus the
     *     category / favourite / selected-only clauses the structural
     *     build cannot pre-bake;
     *  2. ORDER: relevance without DOM moves. Both row containers lay
     *     out by CSS (grid auto-placement / flex column), and both
     *     honour `order`, so ranking is a per-row integer. The DOM
     *     itself stays alphabetical -- exactly the order
     *     _syncLibraryRows expects -- and a cleared query is just
     *     "order back to zero". (An earlier design reordered the real
     *     nodes; it would have made every later sync see churn and
     *     rebuild. Never move rows for a search that leaves as fast
     *     as it came.)
     *  3. highlight: matched tokens wrapped in <mark> in the name
     *     (both views) and the list prompt preview, keyed per row so
     *     re-runs over untouched rows cost nothing;
     *  4. summary: the "N of M" readout + the honest empty state.
     */
    filterLibraryEntries(query) {
        const container = this._libRowsContainer;
        if (!container || !container.isConnected) return;
        const ctx = this._librarySearchCtx(query);
        let visibleCount = 0;
        for (const node of container.children) {
            if (!node.dataset?.promptRef) continue; // non-row child (defensive)
            if (this._applyLibraryRow(node, ctx)) visibleCount++;
            this._highlightRow(node, ctx.tokens, LIB_ROW_TEXT);
        }
        this._updateSearchSummary({
            countEl: this._libSearchCount,
            emptyEl: this._libEmptyNode,
            tokens: ctx.tokens,
            normalized: ctx.normalized,
            visible: visibleCount,
            total: ctx.structural.length,
            noun: "prompts",
        });
    }

    /** Same decisions, scoped to one freshly-appended batch of cards:
     * what ChunkedFiller's onBatch and _syncLibraryRows' rebuilt rows
     * use so a streamed-in card lands already filtered, ranked and
     * marked, never flashing in as a plain un-hidden row. (No summary
     * update -- the grid is mid-fill; the after-idle pass finishes.) */
    _filterLibraryNodes(nodes, query) {
        const ctx = this._librarySearchCtx(query);
        for (const node of nodes) {
            if (!node.dataset?.promptRef) continue;
            this._applyLibraryRow(node, ctx);
            this._highlightRow(node, ctx.tokens, LIB_ROW_TEXT);
        }
    }

    /** One search pass's shared inputs, computed once and handed to
     * every _applyLibraryRow it governs. */
    _librarySearchCtx(query) {
        const [normalized, category, favoritesOnly] = this._libraryFilterParams(query);
        const tokens = tokenize(normalized);
        const structural = this.library.getStructuralEntries();
        const result = rankEntries(structural, normalized);
        return {
            normalized,
            tokens,
            category,
            favoritesOnly,
            structural,
            result,
            scoreOf: result.scores,
            // Selected-only stands down while adding to a section (the
            // same ticks mean "to add" there, and the bar that owns the
            // filter is gone -- hiding the picker's own options).
            selectedGate: !this.librarySelectedOnly || !!this.addingToSectionTarget(),
        };
    }

    /** One row under one ctx: word-AND text clause over the row's
     * search blob (name + categories + prompt, stamped by searchBlob
     * at build), plus the category / favourite / selected clauses,
     * then the CSS-order rank. Returns whether it is visible.
     * The three structural clauses MUST keep agreeing with
     * LibraryController.getVisibleEntries -- this is the live-typing
     * path that skips the re-render, and disagreement would make the
     * star filter "come back" on the next keystroke. */
    _applyLibraryRow(node, ctx) {
        const blob = node.dataset.searchText || "";
        const matchesText = !ctx.tokens.length || ctx.tokens.every((token) => blob.includes(token));
        const cats = JSON.parse(node.dataset.categories || "[]");
        const matchesCategory = ctx.category === "All" || cats.includes(ctx.category);
        const matchesFavorite = !ctx.favoritesOnly || cats.some(isFavoriteCategory);
        const matchesSelected = ctx.selectedGate || node.classList.contains("pc-selected");
        const visible = matchesText && matchesCategory && matchesFavorite && matchesSelected;
        node.style.display = visible ? "" : "none";
        // Rank wins first, then the alphabetical DOM order the grid
        // already holds (CSS order ties fall back to DOM order).
        // Hidden rows keep order 0 while ranked rows go negative, so
        // a hidden row can never sit above a live result.
        node.style.order = visible && ctx.tokens.length ? -(ctx.scoreOf.get(node.dataset.promptRef) || 0) : 0;
        return visible;
    }

    /** One row's text-bearing targets re-marked for `tokens`, or
     * normalized back to plain text. The mark-up keeps textContent
     * byte-identical to the original (marks only wrap), so a row can
     * be re-marked from any previous state without an original-text
     * stash. The SELECTOR list differs per panel on purpose: a library
     * card keeps its name directly in the label div, while a section
     * card/row nests the name in a SPAN next to possible badges --
     * marking the wrapper would shred them. */
    _highlightRow(node, tokens, selectors) {
        const key = tokens.join(" ");
        if (node.dataset.pcHl === key) return;
        for (const selector of selectors) {
            const target = node.querySelector ? node.querySelector(selector) : null;
            if (!target) continue;
            const html = highlightHTML(target.textContent, tokens);
            if (html) target.innerHTML = html;
            else target.textContent = target.textContent; // strip marks from an older query
        }
        node.dataset.pcHl = key;
    }

    /** "N of M" beside the search field + the no-results block. Both
     * hide the moment no query is live -- with no filter running the
     * grid speaks for itself. Shared by the Library pass and the
     * Section pass (noun differs: prompts vs entries). */
    _updateSearchSummary(parts) {
        const { countEl, emptyEl, tokens, normalized, visible, total, noun } = parts;
        const live = tokens.length > 0;
        if (countEl) {
            if (live) {
                countEl.textContent = `${visible} of ${total}`;
                countEl.style.display = "";
            } else {
                countEl.textContent = "";
                countEl.style.display = "none";
            }
        }
        if (emptyEl) {
            const show = live && visible === 0;
            emptyEl.style.display = show ? "" : "none";
            if (show) {
                emptyEl.replaceChildren(
                    el("div", "pc-search-empty-title", { text: `No ${noun} match "${normalized}"` }),
                    ...(tokens.length > 1
                        ? [el("div", "pc-search-empty-hint", { text: "Try fewer words." })]
                        : []),
                );
            }
        }
    }

    /** Debounce seams. Typing schedules the pass; Enter / Esc / the ×
     * flush it immediately (a deliberate commit should never wait). */
    _scheduleLibrarySearch() {
        clearTimeout(this._libSearchTimer);
        this._libSearchTimer = setTimeout(() => {
            this._libSearchTimer = null;
            this.filterLibraryEntries(this.library.searchText);
        }, LIB_SEARCH_DEBOUNCE_MS);
    }

    _flushLibrarySearch() {
        clearTimeout(this._libSearchTimer);
        this._libSearchTimer = null;
        this.filterLibraryEntries(this.library.searchText);
    }

    _libraryFilterParams(query) {
        // The dataset side stores the name exactly as typed/displayed,
        // with no folding between spaces and underscores, so the query
        // is compared as-is.
        return [
            (query || "").trim().toLowerCase(),
            this.library.selectedCategory,
            this.library.favoritesOnly,
        ];
    }

    populateLibraryCategorySelect(select) {
        const counts = this.library.getCategoryCountsWithFolders();
        let selected = this.library.selectedCategory;
        select.innerHTML = "";
        select.append(el("option", null, { value: "All", text: "All" }));
        for (const category of this.library.getAllCategoriesWithFolders()) {
            // Zero-count categories drop out of the list -- except the
            // one currently selected. Showing "Foo (0)" is honest and
            // keeps the dropdown able to DISPLAY the filter that is
            // still applied; silently removing the option would make
            // the select fall back to "All" on a category the person
            // chose (see LibraryController.countCategories).
            if ((counts[category] || 0) > 0 || category === selected) {
                select.append(el("option", null, { value: category, text: `${category} (${counts[category] || 0})` }));
            }
        }
        if (selected !== "All" && !Array.from(select.options).some((option) => option.value === selected)) {
            selected = "All";
            this.library.selectedCategory = "All";
        }
        select.value = selected;
    }

    /**
     * The section-panel search pass -- the same engine as the Library search,
     * applied to a section's OWN entries. Same contract as
     * filterLibraryEntries (see its doc for the why behind CSS order
     * and the keyed highlight), two differences by necessity: rows are
     * keyed by ENTRY id (one prompt may sit in a section twice), and
     * the clauses carry the section's extra views (visible-only and
     * alerts-only isolation alongside category/favourite/selected).
     * The scoped container avoids a rightPanel-wide attribute
     * sweep, which section cards, library cards and anything else
     * wearing both attributes would all answer to.
     */
    filterSectionEntries(query, category) {
        const container = this._secRowsContainer;
        if (!container || !container.isConnected) return;
        const ctx = this._sectionSearchCtx(query, category);
        let visibleCount = 0;
        let total = 0;
        for (const node of container.children) {
            if (!node.dataset?.entryId) continue; // non-row child (defensive)
            total++;
            if (this._applySectionRow(node, ctx)) visibleCount++;
            this._highlightRow(node, ctx.tokens, SECTION_ROW_TEXT);
        }
        this._updateSearchSummary({
            countEl: this._secSearchCount,
            emptyEl: this._secEmptyNode,
            tokens: ctx.tokens,
            normalized: ctx.normalized,
            visible: visibleCount,
            total,
            noun: "entries",
        });
    }

    /** Batch-scoped variant: what the section grid's ChunkedFiller
     * onBatch runs, so a streamed-in card lands already filtered,
     * ranked and marked instead of flashing in plain. */
    _filterSectionNodes(nodes, query, category) {
        const ctx = this._sectionSearchCtx(query, category);
        for (const node of nodes) {
            if (!node.dataset?.entryId) continue;
            this._applySectionRow(node, ctx);
            this._highlightRow(node, ctx.tokens, SECTION_ROW_TEXT);
        }
    }

    /** Shared inputs for one section pass. The eligibility verdicts
     * hoist here (they scan sections -- never per card); the SCORE
     * INDEX is renderEntryGrid's, keyed by entry id from the very
     * resolve that built these rows, so scorer and DOM cannot disagree
     * about what a card shows. */
    _sectionSearchCtx(query, category) {
        return {
            normalized: (query || "").trim().toLowerCase(),
            tokens: tokenize(query),
            category: category || "All",
            favoritesOnly: this.sectionFavoritesOnly,
            visibleOnly: this._visibleOnlyApplies(),
            selectedOnly: this.sectionSelectedOnly,
            alertsOnly: this._alertsOnlyApplies(),
            index: this._secSearchIndex,
        };
    }

    /** One section row under one ctx. Word-AND + rank come from the
     * scorer when the entry id has an index record; rows from before
     * the index existed degrade to the IDENTICAL word-AND over the
     * stamped blob (same tokens, same fields) at order 0 -- they show
     * and hide correctly, they just cannot be ranked. */
    _applySectionRow(node, ctx) {
        const id = node.dataset.entryId;
        const rec = ctx.index && ctx.index.get(id);
        let matchesText;
        let score = 0;
        if (rec) {
            const r = ctx.tokens.length ? scoreEntry(rec, ctx.tokens) : { score: 0 };
            if (!r) {
                matchesText = false;
            } else {
                matchesText = true;
                score = r.score;
            }
        } else {
            const blob = node.dataset.searchText || "";
            matchesText = !ctx.tokens.length || ctx.tokens.every((token) => blob.includes(token));
        }
        const categories = node.dataset.categories ? JSON.parse(node.dataset.categories) : [];
        const matchesCategory = ctx.category === "All" || categories.includes(ctx.category);
        // The star has to be honoured here too. It intersects with the
        // category in the render path, so leaving it out of the live
        // path would mean a single keystroke silently re-widened a
        // favourites-only list.
        const matchesFavorites = !ctx.favoritesOnly || categories.some(isFavoriteCategory);
        // Visible-only view filter (counter chip; the
        // ELIGIBILITY-JUDGED flag -- false while the on-screen view cannot
        // isolate, so the clause lets every card through instead of
        // emptying the panel). "Visible" is read from the card's OWN
        // .pc-entry-visible class -- refreshRenderedEntry keeps that class and
        // entry.visible in lockstep on every live path (card click,
        // show/hide-all, reconcile), so this needs no extra dataset and
        // can never disagree with what the eye toggles show.
        const matchesVisible = !ctx.visibleOnly
            || node.classList.contains("pc-entry-visible");
        // The bulk toolbar's "show only selected" filter: the
        // section's SELECTED set (the top-right checkbox), distinct from
        // visibility. The class is toggled in refreshRenderedEntry
        // alongside the checkbox, so it is the live source of truth here
        // too. ANDed with the rest.
        const matchesSelected = !ctx.selectedOnly
            || node.classList.contains("pc-selected");
        // Alerts-only view filter (the alert chip's toggle). The
        // card's OWN dataset.entryAlert -- stamped by entrySearchDataset
        // from the same merged display the chip's counts classify -- is
        // the truth: "missing" and "workflow" pass, everything else
        // waits. No extra resolve round, nothing to disagree with.
        const matchesAlerts = !ctx.alertsOnly || !!node.dataset.entryAlert;
        const visible = matchesText && matchesCategory && matchesFavorites
            && matchesVisible && matchesSelected && matchesAlerts;
        node.style.display = visible ? "" : "none";
        node.style.order = visible && ctx.tokens.length ? -score : 0;
        return visible;
    }

    /**
     * THE visible-only eligibility -- the single truth the
     * filter clause, the counter ring and the chip tooltip all read, so
     * they can never disagree. The flag is an intention that travels
     * with section switches, but isolation is a VIEW of one section's
     * list: it cannot apply to the Library browse (its prompt grid has a
     * parallel, independent flag), to a locked "prompt" pseudo-section
     * (one card, no Show/Hide), or to a section with ZERO visible
     * entries -- isolating there would show nothing, exactly the
     * dead end to avoid. So those views show everything and
     * no chip wears the ring; leaving such a view behind, a return to a
     * section that CAN isolate resumes the armed filter.
     */
    _visibleOnlyApplies() {
        if (!this.sectionVisibleOnly || this.showLibraryPanel) return false;
        const section = this.state.sections.find((s) => s.id === this.state.activeSectionId);
        if (!section || section.is_locked_prompt) return false;
        return this.state.countVisible(section) > 0;
    }

    /**
     * Is the ALERTS-only filter (the alert chip toggle) SHOWING
     * for the entry list a filter pass is about to run over? Mirrors
     * _visibleOnlyApplies: the armed section must BE the viewed one, and
     * it must actually HAVE problem cards -- isolating a clean section
     * would show nothing, so there it just shows all.
     */
    _alertsOnlyApplies() {
        const mode = this.alertsOnlyMode;
        if (!mode || this.showLibraryPanel || this.editTarget) return false;
        const section = this.state.sections.find((s) => s.id === this.state.activeSectionId);
        if (!section || mode !== section.id) return false;
        const counts = this._alertCountsFor(section);
        return counts.missing + counts.workflow > 0;
    }

    /**
     * The view filter that shows ONLY the section's visibility-ON cards.
     * Its single entry point is the section row's "N/M" counter in the
     * left panel (the counter already tracks the same visible count, so a
     * second control would need syncing).
     * Purely a display pass -- hiding a card's view never changes
     * entry.visible, and the dimmed cards all stay mounted, so one filter
     * pass narrows and the next re-widens. The green ring rides the
     * active section's counter chip; we patch that in place (no rebuild,
     * same doctrine as the search strip) then re-run the one filter pass.
     */
    _applySectionVisibleOnlyToggle() {
        const on = !this.sectionVisibleOnly;
        this.sectionVisibleOnly = on;
        this._patchSectionCountRing();
        this.filterSectionEntries(this.sectionSearchText || "", this.sectionSelectedCategory || "All");
    }

    /**
     * The counter pill's one tooltip truth: an empty section
     * states "No visible entries" and never advertises a toggle (its
     * handler is not even wired); the ringed active chip explains what
     * the next click will undo; anything else offers the filter.
     */
    _sectionCountTitle(section) {
        if (this.state.countVisible(section) <= 0) return "No visible entries";
        if (this._visibleOnlyApplies() && section.id === this.state.activeSectionId) {
            return "Showing visible entries only - click to show all";
        }
        return "Click to show only visible entries";
    }

    /**
     * Sync the active section's counter chip with sectionVisibleOnly
     * without a full left-panel rebuild: toggle the .pc-on ring and its
     * tooltip. Only the ACTIVE section's chip can ever be ringed (the
     * filter narrows the one panel you are looking at), so we patch just
     * that [data-section-count-filter] node. A zero-visible section is
     * inert: the ring can never stay on an empty count --
     * the gates release the flag the moment visibility collapses -- and
     * the tooltip then reads "No visible entries".
     */
    _patchSectionCountRing() {
        const chip = this.leftPanel.querySelector(
            `[data-section-count-filter="${this.state.activeSectionId}"]`
        );
        if (!chip) return;
        const section = this.state.sections.find((s) => s.id === this.state.activeSectionId);
        // The ring answers "is isolation APPLIED right now",
        // not "was the flag armed" -- so it never outlives eligibility
        // (empty section, Library view, locked prompt).
        chip.classList.toggle("pc-on", this._visibleOnlyApplies());
        if (section) chip.title = this._sectionCountTitle(section);
    }

    /**
     * Counter chip click. On a non-active section it selects
     * it AND arms the filter in one move (the whole point is "let me see
     * what THIS section composes"); on the already-active section it is a
     * plain toggle. The select branch defers the ring to the ensuing
     * render (renderLeftPanel reads visibleOnlySectionId); the toggle
     * branch patches it in place.
     */
    _onCountFilterClick(section) {
        // Zero visible -> the pill is inert (the builder also
        // omits the handler; this guards programmatic callers). There is
        // nothing to filter TO, so arming here would only empty the panel.
        if (this.state.countVisible(section) <= 0) return;
        if (section.id === this.state.activeSectionId && !this.showLibraryPanel) {
            this._applySectionVisibleOnlyToggle();
            return;
        }
        this.editTarget = null;
        this.showLibraryPanel = false;
        this.selectedEntryIds.clear();
        this.sectionSearchText = "";
        this.sectionSelectedCategory = "All";
        this.sectionFavoritesOnly = false;
        this._replacingEntryTarget = null;
        this.state.activeSectionId = section.id;
        this.sectionVisibleOnly = true;
        this.render();
    }

    /**
     * The bulk toolbar's "N selected" chip: toggle the view
     * filter that narrows the panel to exactly the SELECTED cards. Same
     * display-pass doctrine as the visible-only filter above -- no pick is
     * made or cleared by it, the ordinary Deselect-all button still owns
     * that; the chip only changes what you look at, and its green ring
     * (.pc-on) is the promise that the number is what's on screen.
     */
    _applySectionSelectedOnlyToggle() {
        const on = !this.sectionSelectedOnly;
        this.sectionSelectedOnly = on;
        const chip = this.rightPanel.querySelector('[data-bulk-toolbar="section"] [data-entry-selected-only-toggle]');
        if (chip) {
            chip.classList.toggle("pc-on", on);
            chip.title = on
                ? "Showing selected entries only - click to show all"
                : "Show only the selected entries";
        }
        this.filterSectionEntries(this.sectionSearchText || "", this.sectionSelectedCategory || "All");
    }

    /** Library-panel twin of _applySectionSelectedOnlyToggle:
     * narrows the browser to the selected prompts through the one
     * library filter pass, and re-rings the chip in place -- the strips
     * get rebuilt whole by _renderLibrarySelectionChrome, so the patch
     * looks the chip up by its dataset hook. */
    _applyLibrarySelectedOnlyToggle() {
        const on = !this.librarySelectedOnly;
        this.librarySelectedOnly = on;
        const chip = this.rightPanel.querySelector('[data-bulk-toolbar="library"] [data-entry-selected-only-toggle]');
        if (chip) {
            chip.classList.toggle("pc-on", on);
            chip.title = on
                ? "Showing selected prompts only - click to show all"
                : "Show only the selected prompts";
        }
        this.filterLibraryEntries(this.library.searchText);
    }

    /**
     * Show/hide the section panel's search strip on the mounted DOM --
     * the same trick the Library toolbar uses, for the same reason:
     * render() to add or remove one toolbar row flashes every card
     * blank while resolveForDisplay and the chunked fill run again.
     *
     * The one case that still takes the full render is HIDING while a
     * structural filter (category, the favorites star) is active:
     * those narrow which cards get BUILT, so the widened default view
     * needs rows that do not exist in the DOM. The search text alone
     * only hides cards that are all still mounted -- un-hiding is one
     * filter pass.
     */
    _applySectionSearchToggle(section) {
        const showing = !this.sectionSearchVisible;
        const structuralWasNarrowing = this.sectionSelectedCategory !== "All" || this.sectionFavoritesOnly;
        this.sectionSearchVisible = showing;
        if (!showing) {
            // Hiding the toolbar hides its controls, so the filters
            // they set have to go with them -- otherwise the entry
            // list would stay narrowed by a star that is no longer
            // on screen.
            this.sectionSearchText = "";
            this.sectionSelectedCategory = "All";
            this.sectionFavoritesOnly = false;
        }
        const strip = this._secSearchStrip;
        const container = this._secRowsContainer;
        // The toggle button lives in a toolbar that refreshEntryToolbar
        // swaps out whole -- look it up fresh rather than caching it.
        const btn = this.rightPanel.querySelector("[data-entry-search-toggle]");
        if (!showing && structuralWasNarrowing) { this.render(); return; }
        if (!strip || !btn || !container || !container.isConnected) { this.render(); return; }
        btn.classList.toggle("pc-on", showing);
        btn.title = showing ? "Hide search" : "Show search";
        if (showing) {
            // Directly above the rows -- where the build mounts it.
            this.rightPanel.insertBefore(strip, container);
            // Repopulate from the current resolve map on the way in:
            // the strip may predate the latest entry changes (a
            // duplicate or paste that did not re-render), and options
            // are now query-independent, so this is the one cheap
            // refresh point. Before the first fill resolves there is
            // nothing to populate FROM -- skip, and the fill's own
            // populate runs once the data exists.
            if (this._secResolvedMap) {
                const select = strip.querySelector(".pc-search-category-select");
                if (select) this.populateSectionCategorySelect(select, section, this._secResolvedMap);
            }
        } else {
            strip.remove();
            // Text hid rows on the way out; it has just been cleared,
            // so this pass is what brings them back.
            this.filterSectionEntries("", "All");
        }
    }

    /**
     * The section's category dropdown options: the categories present
     * among THIS section's resolved entries, with honest totals. The
     * search text is deliberately not an input -- counts describe the
     * section, not the current filter, so a fruitless query can never
     * evict the selected category from the control that is displaying
     * it (the Library dropdown works the same way; see
     * LibraryController.countCategories).
     */
    populateSectionCategorySelect(select, section, resolvedMap) {
        const counts = new Map();
        for (const entry of section.entries) {
            const display = resolvedMap[entry.prompt_ref];
            // categoryMembershipFor (Favorite INCLUDED, unlike
            // categoryBadgesFor -- see its own comment), NOT
            // display?.category directly -- adds the folder pseudo-
            // category too (see entrySearchDataset's matching fix on
            // the filter side; both need to agree on what "this
            // entry's categories" means for MATCHING purposes, or the
            // dropdown could offer an option every row then fails to
            // match).
            for (const category of categoryMembershipFor(display)) {
                counts.set(category, (counts.get(category) || 0) + 1);
            }
        }
        const selected = this.sectionSelectedCategory;
        // The selected category stays displayable even at zero (its
        // last entry may have moved away since it was chosen): "Foo
        // (0)" over a silent rewrite to "All".
        if (selected !== "All" && !counts.has(selected)) counts.set(selected, 0);
        select.innerHTML = "";
        select.append(el("option", null, { value: "All", text: "All" }));
        // Folders FIRST, sorted alphabetically by their plain name (not
        // by the "📁 " marker, which would sort identically anyway
        // since every folder option shares it) -- then every real
        // category, Favorite pinned ahead of the rest. Matches the
        // Library toolbar's own ordering (see
        // LibraryController.getAllCategoriesWithFolders).
        const allNames = Array.from(counts.keys());
        const folderNames = allNames
            .filter(isFolderPseudoCategory)
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        const realNames = sortCategoriesPinningFavorite(allNames.filter((c) => !isFolderPseudoCategory(c)));
        for (const category of [...folderNames, ...realNames]) {
            select.append(el("option", null, { value: category, text: `${category} (${counts.get(category)})` }));
        }
        select.value = selected;
    }

    refreshSectionCounter(section) {
        const row = Array.from(this.leftPanel.querySelectorAll(".pc-section-row")).find(
            (candidate) => candidate.dataset.sectionId === section.id
        );
        const counter = row?.querySelector(".pc-section-count-value");
        const chip = counter ? counter.parentElement : null;
        if (chip) {
            const visible = this.state.countVisible(section);
            counter.textContent = `${visible}/${section.entries.length}`;
            // Toggling the last visible card off (or the first on) updates
            // this counter in place -- no full re-render -- so the
            // orange/gray empty-state pill has to follow the count here
            // too, not just when the row is first built. The
            // tooltip flips with it ("No visible entries" <-> the
            // filter's offer). NO handler juggling here --
            // the builder's single handler stays attached forever and
            // re-checks countVisible live, so this patch must never set
            // chip's onclick PROPERTY (a handler on top of the listener
            // would double-fire the toggle).
            chip.classList.toggle("pc-section-count-empty", visible === 0);
            chip.title = this._sectionCountTitle(section);
        }
        const hideAllButton = this.rightPanel.querySelector("[data-entry-hide-all]");
        if (hideAllButton && section.id === this.state.activeSectionId) {
            hideAllButton.hidden = this.state.countVisible(section) <= 0;
        }
    }

    hideAllSectionEntries(section) {
        for (const entry of section.entries) entry.visible = false;
        this.refreshSectionCounter(section);
        if (section.id === this.state.activeSectionId && !this.showLibraryPanel) {
            this.refreshAllRenderedEntries(section);
            this.refreshEntryToolbarHideAllGate(section);
        }
        this.notifyInPlace();
    }

    /**
     * Keep the visibility-count-gated toolbar state honest without a
     * rebuild: Hide-all -- with zero visible cards there is nothing to
     * hide, so it must not sit there. And if the counter's visible-only
     * filter was ACTIVE when the last visible card flipped off, it
     * releases first: otherwise the dimmed cards would stay display:none
     * behind a ringed counter on a section that composes nothing -- a
     * dead-end view. Releasing re-runs the filter pass so the dimmed
     * cards come back immediately and drops the green ring.
     */
    refreshEntryToolbarHideAllGate(section) {
        const visibleCount = this.state.countVisible(section);
        const hideAll = this.rightPanel.querySelector("[data-entry-hide-all]");
        if (hideAll) hideAll.hidden = visibleCount <= 0;
        if (visibleCount <= 0 && this.sectionVisibleOnly) {
            this.sectionVisibleOnly = false;
            this._patchSectionCountRing();
            this.filterSectionEntries(this.sectionSearchText || "", this.sectionSelectedCategory || "All");
        } else if (this.sectionVisibleOnly && section.id === this.state.activeSectionId) {
            // The OTHER eligibility edge: the viewed section
            // just went from nothing-to-isolate to something (first card
            // shown while the armed filter lay dormant, e.g. arrived at
            // 0/12 and flipped a card visible). The view must equal
            // flag AND eligibility -- re-pin the ring and re-run the one
            // filter pass so the isolation the flag promises appears
            // exactly when it becomes possible, not at some later
            // render.
            this._patchSectionCountRing();
            this.filterSectionEntries(this.sectionSearchText || "", this.sectionSelectedCategory || "All");
        }
    }

    /**
     * ---- The alert chips (rounds 26-28) --------------------------------
     * An icon-only alertTriangle button left of each section's counter.
     * RED while the section holds MISSING entries (library gone AND no
     * workflow-copy stand-in), AMBER while it holds WORKFLOW-COPY
     * entries (library gone; the loaded snapshot's embedded text stands
     * in) -- red outranks amber. Clicking arms an alerts-only view
     * filter for that section. There is NO Library-row chip: library
     * cards just ARE what the folder holds -- these states belong to
     * preset entries. The per-ref truth
     * lives in `_refStatus`. MISSING means exactly what the cards' own
     * eye-toggle rule reads off the same merged map -- NO entry (or a
     * null one): the server's resolve_many omits dead refs rather than
     * answering null, so a key-presence test would never learn "gone".
     * The network-hiccup protection lives one level UP instead: the
     * sweep only folds in a map the server actually ANSWERED with.
     */

    /** The one status rule -- an ABSENT ref is MISSING (see above). */
    _alertStatusFor(resolvedMap, ref) {
        const display = resolvedMap[ref];
        return !display ? "missing" : display.from_workflow ? "workflow" : "live";
    }

    /** Fold one merged resolve map (section fast path or full sweep)
     * into `_refStatus` for `section`'s refs, then push to the DOM. */
    _noteAlertStatuses(section, resolvedMap) {
        for (const entry of section.entries) {
            const ref = entry && entry.prompt_ref;
            if (!ref) continue;
            this._refStatus.set(ref, this._alertStatusFor(resolvedMap, ref));
        }
        this._applyAlertSnapshots();
    }

    _alertCountsFor(section) {
        let missing = 0;
        let workflow = 0;
        for (const entry of (section && section.entries) || []) {
            const status = this._refStatus.get((entry && entry.prompt_ref) || "");
            if (status === "missing") missing += 1;
            else if (status === "workflow") workflow += 1;
        }
        return { missing, workflow };
    }

    /** The chips' inputs as a stable string: every ref the preset uses
     * (sorted, so reorder/copy noise never reads as change) -- plus the
     * identity of the loaded workflow snapshot, compared separately. */
    _alertFingerprint() {
        const refs = Array.from(usedPromptRefs(this.state.sections));
        refs.sort();
        return refs.join("\u0000");
    }

    /**
     * One resolve round for EVERY ref the preset uses, so a section you
     * never opened still lights its chip. Skipped while nothing it
     * could answer has changed (same ref set, same workflow snapshot)
     * -- resolveForDisplay has NO cache, so that guard is what keeps
     * render storms off the network. Mid-flight changes queue exactly
     * one follow-up; a server that never answered leaves the last-known
     * truth standing and retries on the next render like everything
     * else does.
     */
    _alertSweep(force = false) {
        const refs = Array.from(usedPromptRefs(this.state.sections));
        refs.sort();
        const fp = refs.join("\u0000");
        if (!force && fp === this._alertSweptFingerprint && this._workflowContents === this._alertSweptWorkflow) return;
        if (this._alertSweepInFlight) {
            this._alertSweepQueued = true;
            return;
        }
        this._alertSweepInFlight = true;
        tryResolveForDisplay(refs).then((resolved) => {
            this._alertSweepInFlight = false;
            if (resolved) {
                this._alertSweptFingerprint = fp;
                this._alertSweptWorkflow = this._workflowContents;
                const merged = mergeWorkflowContent(resolved, this._workflowContents);
                for (const ref of refs) {
                    this._refStatus.set(ref, this._alertStatusFor(merged, ref));
                }
                this._applyAlertSnapshots();
            }
            if (this._alertSweepQueued || this._alertFingerprint() !== fp) {
                this._alertSweepQueued = false;
                this._alertSweep(true);
            }
        });
    }

    /**
     * Alert chip click.
     * Mirrors the counter chip: a non-viewed section's chip SELECTS it
     * AND arms in one move; the viewed section's chip toggles IN PLACE
     * (ring patch + one filter pass -- the pass only runs while an
     * ENTRY list is mounted). The live counts are re-asked on EVERY
     * click (round-21c doctrine): a section that went clean since its
     * chip was built refuses to arm, because isolating it would only
     * empty the panel.
     */
    _onAlertFilterClick(section) {
        if (!section) return; // no Library chip any more
        const key = section.id;
        const counts = this._alertCountsFor(section);
        if (counts.missing + counts.workflow <= 0) return;
        if (this.alertsOnlyMode === key) {
            this.alertsOnlyMode = null;
        } else if (!this.showLibraryPanel && this.editTarget === null
            && this.state.activeSectionId === section.id) {
            this.alertsOnlyMode = key;
        } else {
            this.editTarget = null;
            this.showLibraryPanel = false;
            this.selectedEntryIds.clear();
            this.sectionSearchText = "";
            this.sectionSelectedCategory = "All";
            this.sectionFavoritesOnly = false;
            this._replacingEntryTarget = null;
            this.state.activeSectionId = section.id;
            this.alertsOnlyMode = key;
            this.render();
            return;
        }
        this._applyAlertSnapshots();
        if (this.rightPanel.querySelector(".pc-browse-section")) {
            this.filterSectionEntries(this.sectionSearchText || "", this.sectionSelectedCategory || "All");
        }
    }

    /**
     * Push `_refStatus` into the mounted left panel -- hidden/class/
     * tooltip patched in place (no rebuild; the ring's doctrine), and
     * every chip was BUILT at every render (hidden ones included), so
     * the patcher always finds its node.
     */
    _applyAlertSnapshots() {
        if (!this.leftPanel) return;
        // A scope that went fully clean drops the mode with it (the
        // round-16b no-dead-end rule: an armed isolation that shows
        // nothing must not linger), before the chips are patched so
        // the rings agree with the release. A vanished section counts
        // as clean -- deleting it releases its mode too.
        if (this.alertsOnlyMode) {
            const armed = this.state.sections.find((s) => s.id === this.alertsOnlyMode);
            const scopeCounts = armed ? this._alertCountsFor(armed) : { missing: 0, workflow: 0 };
            if (scopeCounts.missing + scopeCounts.workflow <= 0) this.alertsOnlyMode = null;
        }
        for (const chip of this.leftPanel.querySelectorAll("[data-section-alert]")) {
            const key = chip.dataset.sectionAlert;
            const section = this.state.sections.find((s) => s.id === key);
            applyAlertCounts(chip, section ? this._alertCountsFor(section) : { missing: 0, workflow: 0 },
                this.alertsOnlyMode === key);
        }
    }

    /**
     * Region definitions for ScrollPreserver: for each named panel
     * region, a function returning its CURRENT actual scroll
     * container element (or null if that region isn't showing a
     * scrollable view right now). This is deliberately explicit about
     * which element really scrolls in each panel -- several panel
     * roots use `overflow: hidden` themselves and put the real
     * `overflow-y: auto` on an inner child (see prompt_composer.css),
     * so `this.leftPanel` / `this.rightPanel` themselves are USUALLY
     * not the right element to read/write scrollTop on.
     */
    getScrollRegions() {
        return {
            // Left panel: the section list is the only scrollable
            // child (see .pc-section-list's overflow-y: auto).
            left: () => this.leftPanel.querySelector(".pc-section-list"),
            // The right panel shows exactly one of a browse view (entry /
            // library grid or list) or an edit form at a time. They are
            // SEPARATE scroll regions on purpose:
            //
            //  - `rightBrowse` PERSISTS across renders, so its position is
            //    still remembered while an edit panel is open and the grid/
            //    list comes back exactly where you left it.
            //  - `rightEdit` is per-render, so every edit form opens at the
            //    top instead of inheriting the browse view's scroll.
            //
            // Keying them apart is what stops the scroll leaking between
            // the two kinds of view -- each region's getter only ever
            // matches its own element, so a browse scroll can never be
            // applied to an edit form (or the reverse). The right panel
            // hosts TWO browse views (a section's own grid and the
            // Library browser) built from the same shared row classes,
            // so they carry a purpose-built marker each: without the
            // split, going to the Library to pick prompts and coming
            // back would drive the section's list with the Library's
            // scroll position. The section slot is a single shared one;
            // per-section memory (see _stashBrowseScroll) retargets it
            // at the top of every render, so each section opens where
            // ITS OWN list was last left.
            rightBrowse: {
                getScrollEl: () => this.rightPanel.querySelector(".pc-browse-section"),
                persist: true,
            },
            rightBrowseLibrary: {
                getScrollEl: () => this.rightPanel.querySelector(".pc-browse-library"),
                persist: true,
            },
            rightEdit: {
                getScrollEl: () => this.rightPanel.querySelector(".pc-edit-panel"),
                persist: false,
            },
        };
    }

    /** sessionStorage key for one of this node's section scrolls. */
    _sessionScrollKey(sectionId) {
        return `${SESSION_SCROLL_PREFIX}${this.node?.id ?? "node"}:${sectionId}`;
    }

    /**
     * Record the mounted section container's scroll under the section it
     * BELONGS TO -- at render() top that is the one being LEFT, not
     * `activeSectionId`, which already points at the one about to be
     * built (that is why the container carries its id in the dataset).
     * The Library and edit panel show no section container, so those
     * renders stash nothing and the slots simply hold.
     */
    _stashBrowseScroll() {
        const container = this.rightPanel?.querySelector(".pc-browse-section");
        if (!container) return;
        const sectionId = container.dataset.browseSectionId || this.state.activeSectionId;
        if (!sectionId) return;
        const entry = browseScrollEntry(container);
        // A container that was just rebuilt and has NOT filled
        // yet (its cards still resolve in the background) reports scroll
        // 0 with no overflow -- that is not the user's position, and
        // memorising it poisons the section with "top". Skip; the slots
        // simply hold the last real position. A genuinely short list
        // lands at top on apply either way (nothing to scroll).
        if (entry.pixels === 0 && entry.fraction === 0
            && container.scrollHeight - container.clientHeight <= 0) {
            return;
        }
        this._sectionScrolls.set(sectionId, entry);
        writeSessionScroll(this._sessionScrollKey(sectionId), entry);
    }

    /**
     * Ask for `section`'s browse list to be revealed AT ITS END on the
     * next render that shows it. Call this INSIDE the change
     * batch (withBatch) so the notify fired at batch close renders with
     * the request already standing -- or right before an explicit
     * render(). Deliberately survives unrelated views being up in the
     * meantime (library browse, edit panels, another section).
     */
    _requestBrowseToEnd(section) {
        if (section) this._browseToEndSectionId = section.id;
    }

    /**
     * Ask for `section`'s next browse render to restore at the SAME
     * RELATIVE position (percentage from start to end of the list)
     * rather than the remembered pixels. Same consumption
     * rules as _requestBrowseToEnd (browse view of THAT section only);
     * a standing bottom-reveal request outranks it.
     */
    _requestBrowseFractionPriority(section) {
        if (section) this._browseFractionPrioritySectionId = section.id;
    }

    /**
     * Where this section's browse list was last left: the instance Map
     * first, then the sessionStorage mirror (the post-F5 path), then the
     * top of the list. Misses are cached as {0,0} so storage is read at
     * most once per section.
     */
    _rememberedBrowseScroll(sectionId) {
        if (!sectionId) return { pixels: 0, fraction: 0 };
        let entry = this._sectionScrolls.get(sectionId);
        if (!entry) {
            entry = readSessionScroll(this._sessionScrollKey(sectionId)) || { pixels: 0, fraction: 0 };
            this._sectionScrolls.set(sectionId, entry);
        }
        return entry;
    }

    /**
     * Keep a section's remembered scroll CURRENT as it happens, not just
     * whenever the next render bothers to record one: the money case is
     * a deep scroll followed straight by an F5 -- there is no next
     * render. rAF-coalesced so a scroll burst costs one storage write
     * per frame; the preserver's own programmatic scrolls fire through
     * here too, harmlessly re-recording positions it chose. The
     * isConnected guard drops a queued frame whose container got torn
     * down mid-burst (render()'s top-of-render stash already has that
     * value from the final settled position).
     */
    _wireBrowseScrollMemory(container, sectionId) {
        let queued = false;
        container.addEventListener("scroll", () => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                if (!container.isConnected) return;
                const entry = browseScrollEntry(container);
                this._sectionScrolls.set(sectionId, entry);
                writeSessionScroll(this._sessionScrollKey(sectionId), entry);
            });
        }, { passive: true });
    }

    /**
     * Forget scroll memory for sections that no longer exist. Section
     * MEMBERSHIP changes rarely (a delete, a preset/workflow swap), so
     * the live-id signature is checked cheaply on every render and the
     * sweep -- Map entries and this node's storage keys alike -- runs
     * only when it actually changed. Other nodes' keys are left alone.
     */
    _pruneSectionScrolls() {
        const sig = this.state.sections.map((s) => s.id).join(",");
        if (sig === this._sectionScrollsSig) return;
        this._sectionScrollsSig = sig;
        const live = new Set(this.state.sections.map((s) => s.id));
        for (const id of [...this._sectionScrolls.keys()]) {
            if (!live.has(id)) this._sectionScrolls.delete(id);
        }
        const prefix = `${SESSION_SCROLL_PREFIX}${this.node?.id ?? "node"}:`;
        try {
            const dead = [];
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (key && key.startsWith(prefix) && !live.has(key.slice(prefix.length))) dead.push(key);
            }
            for (const key of dead) forgetSessionScroll(key);
        } catch {
            /* storage unavailable: the Map sweep above already ran */
        }
    }

    render() {
        // Stamp BEFORE anything else: every async continuation this
        // render spawns compares against this value to learn whether it
        // still owns the panel (see the fill chain below).
        const renderSeq = ++this._renderSeq;
        // Per-section browse scroll (see _stashBrowseScroll): the mounted
        // container still belongs to the section being LEFT, so its live
        // scroll is recorded under ITS id first; then capture() and the
        // override retarget the shared `rightBrowse` slot at where the
        // section being ENTERED was last left. The override must come
        // after capture() (which measures the outgoing view into that same
        // slot) and before restore() -- whose immediate AND deferred passes
        // read the live entry, so one write here steers all of them.
        this._stashBrowseScroll();
        this._pruneSectionScrolls();
        this._scrollPreserver.capture(this.getScrollRegions());
        // A pending "reveal the appended tail" outranks memory.
        // pixels:Infinity + fraction:1 lands exactly on
        // maxScroll in EVERY apply pass (the immediate one, the double
        // rAF ones, and the deferred pass after the async chunk-fill
        // settles) -- which is precisely what a grid whose height keeps
        // growing during filling needs. Only consumed when this render
        // actually shows the section's own browse view; library browse
        // and edit panels leave the request standing.
        const browseToEnd = this._browseToEndSectionId
            && this._browseToEndSectionId === this.state.activeSectionId
            && !this.editTarget && !this.showLibraryPanel;
        if (browseToEnd) this._browseToEndSectionId = null;
        const browseFraction = !browseToEnd
            && this._browseFractionPrioritySectionId
            && this._browseFractionPrioritySectionId === this.state.activeSectionId
            && !this.editTarget && !this.showLibraryPanel;
        if (browseFraction) this._browseFractionPrioritySectionId = null;
        const browseMemory = this._rememberedBrowseScroll(this.state.activeSectionId);
        this._scrollPreserver.override(
            "rightBrowse",
            browseToEnd
                ? { pixels: Number.POSITIVE_INFINITY, fraction: 1 }
                : browseFraction
                    // pixels:Infinity makes _applyEntry take its fraction
                    // branch on every pass: round(fraction x the CURRENT
                    // maxScroll) -- "same relative position" over the
                    // shortened list after a move.
                    ? { pixels: Number.POSITIVE_INFINITY, fraction: browseMemory.fraction }
                    : browseMemory,
            () => this.rightPanel.querySelector(".pc-browse-section"),
        );
        const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (activeElement && (activeElement.matches("button, input") || activeElement.closest(".pc-entry-card, .pc-entry-row"))) {
            activeElement.blur();
        }
        this.applySplit();
        this.pruneStaleModes();
        // The preset toolbar is part of the static layout and is not
        // rebuilt here, so this is the only thing that keeps its Save
        // button honest about whether the composition still matches what
        // is on disk. Every content change funnels through notify() ->
        // render(), including the ones that don't touch the DOM at all.
        this.presetToolbar.refreshDirtyState();
        // The six bulk flag buttons flip the SAME section
        // flags the row toggles flip -- for every section at once.
        // Re-sync each mounted row's chrome in place (row._pcSync,
        // see renderLeftPanel) instead of rebuilding the list; the
        // grid never changes. Same edit-panel escape as the toggles.
        renderSectionToolbar(this.sectionToolbar, this.state.sections, () => {
            if (this.editTarget && this.editTarget.type === "section") { this.render(); return; }
            for (const row of this.leftPanel.querySelectorAll(".pc-section-row")) {
                if (row._pcSync) row._pcSync();
            }
            this.notifyInPlace();
        });
        renderLeftPanel(this.leftPanel, {
            state: this.state,
            // section-row flags (enabled/randomize/label/
            // end-separator) patch their own row in place; the entry
            // grid never changes, so compose + persist + dirty-check
            // only (notifyInPlace) -- no list rebuild, no flicker. The
            // one exception: if THIS section's edit panel is open it
            // mirrors those same flags, so it must re-render to stay
            // honest -- but that render replaces the grid, so there is
            // nothing left to flicker.
            onSectionFlagsChanged: (section) => {
                if (this.editTarget && this.editTarget.type === "section"
                    && this.editTarget.sectionId === section.id) this.render();
                else this.notifyInPlace();
            },
            countVisible: (s) => this.state.countVisible(s),
            isLibraryActive: this.showLibraryPanel,
            libraryColor: this.libraryColor,
            // Only ever one row: the visible-only filter narrows the
            // panel of the section you are looking at -- and
            // only while it CAN (not the Library view, not a
            // locked prompt, not a section with nothing visible to
            // isolate; see _visibleOnlyApplies).
            visibleOnlySectionId: this._visibleOnlyApplies() ? this.state.activeSectionId : null,
            // The alert chips -- per-section counts from
            // _refStatus (the Library row has none: its prompts simply
            // ARE the folder). Built every render (hidden at 0/0);
            // _applyAlertSnapshots keeps them honest between renders
            // without a rebuild.
            alertCountsFor: (section) => this._alertCountsFor(section),
            alertsOnlyMode: this.alertsOnlyMode,
            onToggleAlertFilter: (section) => this._onAlertFilterClick(section),
            onToggleCountFilter: (section) => this._onCountFilterClick(section),
            onOpenLibrary: () => {
                // re-clicking Library while it is already the
                // open, untargeted browse view is a NO-OP -- the handler
                // below would reset nothing and a rebuild just flashes
                // the prompt grid. Guarded to the exact set of fields it
                // mutates: any that differ (an open edit panel, an armed
                // add-mode, a lingering section selection) make the click
                // meaningful again, and the full path runs.
                if (this.showLibraryPanel && this.editTarget === null
                    && this._addingToSection === null && this.selectedEntryIds.size === 0) {
                    return;
                }
                this.editTarget = null;
                this.selectedEntryIds.clear();
                // Clicking "Library" is a fresh, untargeted open -- which is
                // exactly "doing something else", and the one case the
                // render-time invariant cannot see, because every part of it
                // still holds.
                this._addingToSection = null;
                this.showLibraryPanel = true;
                this.render();
            },
            onOpenLibraryColorEdit: () => {
                this.editTarget = { type: "library-color" };
                this.render();
            },
            onSelectSection: (id) => this.selectSection(id),
            onOpenSectionEdit: (id) => {
                this.editTarget = { type: "section", sectionId: id };
                this.render();
            },
            onAddSection: () => {
                // A new section starts with nothing selected. The selected Set
                // is shared across sections, so picks made in the one the
                // person was just looking at would otherwise be carried
                // straight in -- this is the path that produced "2 selected"
                // over a brand-new, empty section.
                this.selectedEntryIds.clear();
                const selectedPromptRefs = this.showLibraryPanel
                    ? Array.from(this.librarySelectedPromptRefs)
                    : [];
                let section;
                this.state.withBatch(() => {
                    section = this.state.addSection();
                    for (const promptRef of selectedPromptRefs) {
                        this.state.addEntryFromLibrary(section.id, promptRef);
                    }
                    if (selectedPromptRefs.length) this.librarySelectedPromptRefs.clear();
                    this.editTarget = { type: "section", sectionId: section.id };
                    // The batch-close notify IS the render -- the
                    // old trailing render() double-raced it (scroll-memory
                    // poisoning; see the cross-section drop handler).
                });
            },
            onDropLibraryPrompts: ({ sectionId, refs }) => {
                if (!Array.isArray(refs) || !refs.length) return;
                const section = this.state.sections.find((s) => s.id === sectionId);
                if (!section || section.is_locked_prompt) return;
                // Dropping several selected library cards at once
                // would otherwise notify() (-> full render()) once per
                // ref -- collapse to a single notify() for the whole
                // drop, same rationale as onCut/onPaste/onDeleteSelected.
                this.state.withBatch(() => {
                    for (const promptRef of refs) {
                        this.state.addEntryFromLibrary(section.id, promptRef);
                    }
                    // The drop appended at the end -- ask to reveal it
                    // (if the section is not the view on
                    // screen right now -- library browse usually still is --
                    // the request stands until it next renders.
                    this._requestBrowseToEnd(section);
                    this.librarySelectedPromptRefs.clear();
                    // Dragging prompts in is the other way of doing exactly
                    // what this mode exists for, so the mode is done -- the
                    // pick it was holding has just landed by another route.
                    this._addingToSection = null;
                    // Nothing AFTER the batch -- the close's own
                    // notify renders the settled state. The old trailing
                    // render() was a second, racing render (see the
                    // cross-section drop handler: it is what made scroll
                    // land on top).
                });
            },
            onDropCrossSectionEntries: async ({ sourceSectionId, targetSectionId, entryIds }) => {
                if (!Array.isArray(entryIds) || !entryIds.length) return;
                const sourceSection = this.state.sections.find((s) => s.id === sourceSectionId);
                const targetSection = this.state.sections.find((s) => s.id === targetSectionId);
                if (!sourceSection || !targetSection || targetSection.is_locked_prompt) return;

                // The drag-start handler already filters missing entries
                // out of the payload; re-check here because the payload
                // is a snapshot taken when the drag BEGAN, and this
                // section's resolve is the authoritative answer for
                // "does this pointer still work".
                const transferable = entryIds.filter((id) => !this._missingEntryIds.has(id));
                if (!transferable.length) return;

                const count = transferable.length;
                const choice = await this.showConfirmDialog.choice({
                    title: `${count} ${count === 1 ? "entry" : "entries"} dropped on "${targetSection.name}"`,
                    message: `Copy or move ${count === 1 ? "this entry" : "these entries"} from "${sourceSection.name}" into "${targetSection.name}"?`,
                    choices: [
                        { value: "copy", label: "Copy" },
                        { value: "move", label: "Move", primary: true },
                    ],
                });
                if (choice !== "copy" && choice !== "move") return; // cancelled/dismissed

                // Everything inside ONE outer batch. transferEntries
                // carries its own batch-close notify, and the old explicit
                // render() right after it was a SECOND render whose
                // stash/capture caught the first render's container before
                // its async fill had grown -- reading scroll 0 and storing
                // "top" as this section's real position (that is what made
                // the list jump to the start after Copy/Move). One render,
                // starting from a settled, filled container, restores
                // accurately.
                this.state.withBatch(() => {
                    this.state.transferEntries(sourceSectionId, targetSectionId, transferable, choice);
                    // Copy and move both land at the target's end -- reveal
                    // them when that section's list next comes on screen.
                    this._requestBrowseToEnd(targetSection);

                    // The dragged entries' bulk-selected state no longer
                    // makes sense once they've moved (or been duplicated)
                    // out of the section selectedEntryIds was scoped to --
                    // clear it so a stale checkbox count doesn't linger in
                    // the entry toolbar. Entries that were dropped from the
                    // payload for being missing stay selected, same as after
                    // a Cut.
                    for (const id of transferable) this.selectedEntryIds.delete(id);

                    // A MOVE shortens the list being looked at: keep the
                    // SAME RELATIVE position (percentage of the scrollable
                    // range) instead of the old pixel offset, which no
                    // longer lines up with the shorter content. A COPY
                    // leaves the source untouched, so its exact pixel
                    // restore reads as "nothing moved" -- nothing to pin.
                    if (choice === "move" && !this.showLibraryPanel && this.editTarget === null
                        && sourceSectionId === this.state.activeSectionId) {
                        this._requestBrowseFractionPriority(sourceSection);
                    }
                });
            },
        });

        // With fresh chips built, make sure their data is
        // current -- the sweep is a no-op while the ref set and the
        // workflow snapshot are unchanged, so re-renders cost one
        // string compare, not a network call.
        this._alertSweep();

        this.clearRightPanel();
        let pendingContentFill = null;
        if (this.editTarget) {
            this.renderEditTarget();
        } else if (this.showLibraryPanel) {
            // Returns the fill-complete promise (see ChunkedFiller):
            // scroll restore has to be re-applied after the LAST chunk
            // lands, not after the first frame of cards.
            pendingContentFill = this.renderLibraryBrowser();
        } else {
            // renderEntryGrid() fills its container ASYNCHRONOUSLY
            // (see resolveForDisplay(...).then(...) inside it): the
            // container is appended to the DOM empty first, then
            // populated once resolved content comes back from the
            // server. Restoring scrollTop before that population
            // happens is a guaranteed no-op -- an empty container has
            // nothing to scroll to, so the browser clamps scrollTop
            // back to 0 regardless of what we set it to. This was the
            // root cause of the "list jumps to top" bug: the fix below
            // restores once immediately (covers everything that
            // rendered synchronously) AND again after this promise
            // settles (covers the entry grid/list specifically, once
            // it actually has content to scroll within).
            pendingContentFill = this.renderEntryGrid();
        }

        this.preview.render();
        this.syncWidget();
        this._scrollPreserver.restore();
        if (pendingContentFill) {
            // The entry grid/list (and the library browser, see
            // renderLibraryBrowser) fill themselves in ASYNCHRONOUSLY
            // (resolving prompt_ref -> display data over the network)
            // -- restore() is safe to call again once that settles;
            // it's a no-op for any region whose element didn't change,
            // and correctly re-applies the captured position onto the
            // now-populated (and therefore actually scrollable)
            // container for regions that just got their content filled
            // in for the first time this render.
            pendingContentFill.then(() => {
                // Superseded by a newer render: its DOM is gone and the
                // newer render's own chain will restore once ITS fill
                // settles -- restoring from a stale callback would only
                // fight it.
                if (renderSeq !== this._renderSeq) return;
                this._scrollPreserver.restore();
            });
        }
        // Exposed so a caller that needs the right panel FULLY built --
        // not just synchronously appended, but past any chunked entry
        // fill too (see scrollPreviewEntryIntoView) -- has something to
        // await. Resolves once this SPECIFIC render's content has
        // settled; a render superseded before that point never resolves
        // its own promise (nothing to scroll to -- see the guard above),
        // but the newer render's own promise takes over correctly since
        // callers always read this property fresh, right before using
        // it, rather than capturing it early.
        this._lastRenderSettled = pendingContentFill
            ? pendingContentFill.then(() => {
                  if (renderSeq !== this._renderSeq) return null;
              })
            : Promise.resolve();
    }

    clearRightPanel() {
        // Any in-flight chunk fill belongs to the DOM we are about to
        // tear down: cancel it, or a pending frame would keep appending
        // cards into an orphaned container (and, worse, keep closures
        // over this render's entries alive after a newer render owns
        // the panel). Their whenIdle() promises resolve on cancel, so
        // the chained scroll-restore in render() stays harmless.
        if (this._libFiller) {
            this._libFiller.cancel();
            this._libFiller = null;
            this._libRenderedRefs = null;
        }
        if (this._entryFiller) {
            this._entryFiller.cancel();
            this._entryFiller = null;
        }
        for (const child of Array.from(this.rightPanel.children)) {
            child.remove();
        }
        // createConfirmDialog's overlay lives inside rightPanel and got
        // removed above; recreate it fresh each render so it's always
        // the last child (drawn on top).
        this.showConfirmDialog = createConfirmDialog(this.rightPanel);
    }

    rewriteEntryPromptRefs(oldRef, newRef) {
        if (!oldRef || !newRef || oldRef === newRef) return;
        for (const section of this.state.sections) {
            for (const entry of section.entries) {
                if (entry.prompt_ref === oldRef) entry.prompt_ref = newRef;
            }
        }
    }

    /**
     * Follow a rename through the pick-to-add mode's pending selection.
     *
     * The mode holds prompt_refs, and a prompt edited from inside it can come
     * back with a different one -- the ref is the filename, so renaming
     * changes it. Left alone, the stale ref still counts toward the total and
     * still shows as ticked, because the card it was ticked on has been
     * replaced by the edited one; then committing adds an entry pointing at a
     * file that no longer exists. That is a missing card, created by the one
     * action whose whole purpose was to avoid one.
     */
    remapLibrarySelection(oldRef, newRef) {
        if (!oldRef || !newRef || oldRef === newRef) return;
        if (!this.librarySelectedPromptRefs.has(oldRef)) return;
        this.librarySelectedPromptRefs.delete(oldRef);
        this.librarySelectedPromptRefs.add(newRef);
    }

    /**
     * Drop a pick whose prompt has just been deleted from the editor.
     *
     * The library edit panel can delete the prompt it was opened on, and the
     * pick-to-add mode holds prompt_refs across that panel -- so a tick can
     * outlive the file and commit into a missing card. Same failure the
     * rename remap above guards, reached the other way.
     */
    dropDeletedLibrarySelection(editTarget, result) {
        if (!result?.deleted) return;
        const ref = editTarget?.promptRef;
        if (ref) this.librarySelectedPromptRefs.delete(ref);
    }

    renderEditTarget() {
        if (this.editTarget.type === "section") {
            const section = this.state.sections.find((s) => s.id === this.editTarget.sectionId);
            if (!section) {
                this.editTarget = null;
                return this.render();
            }
            renderSectionEditPanel(this.rightPanel, section, {
                state: this.state,
                onClose: () => {
                    this.editTarget = null;
                    this.render();
                },
                onDelete: () => {
                    this.state.removeSection(section.id);
                    this.editTarget = null;
                    this.render();
                },
                // Fires on every accent-color commit (color picker
                // "change", and the dice/randomize button), WITHOUT a
                // full this.render() -- a full render tears down and
                // rebuilds this very edit panel (see clearRightPanel),
                // which would blow away the native color-picker popup
                // mid-interaction. The preview-only repaint has no such
                // cost: it touches only the PREVIEW label/text, never
                // rightPanel, so the color field keeps focus and the
                // preview updates live in the same breath -- exactly
                // the "immediately" behavior asked for.
                onColorChange: () => this._refreshPreviewColorState(),
                confirmDialog: this.showConfirmDialog,
            });
        } else if (this.editTarget.type === "library-new" || this.editTarget.type === "library-edit") {
            const existingEntry =
                this.editTarget.type === "library-edit"
                    ? this.library.entries.find((e) => e.prompt_ref === this.editTarget.promptRef)
                    : null;
            renderLibraryEditPanel(this.rightPanel, existingEntry, {
                library: this.library,
                fileToDataUrl,
                confirmDialog: this.showConfirmDialog,
                onCategoryRenamed: (oldName, newName) => {
                    // Mirror LibraryController.renameCategory's own
                    // self-heal of this.library.selectedCategory (the
                    // library browser's filter), but for a SECTION's
                    // filter, which lives here rather than on the
                    // library controller (see sectionSelectedCategory's
                    // own declaration). Every entry's category already
                    // moved to newName by the time this fires (the
                    // panel awaits the rename before calling this), so
                    // without this remap a section filtered to the old
                    // name keeps asking for a name nothing carries
                    // anymore -- an empty list until re-picked by hand.
                    if (this.sectionSelectedCategory === oldName) {
                        this.sectionSelectedCategory = newName;
                    }
                },
                onDone: (result) => {
                    const oldRef = this.editTarget?.promptRef;
                    const newRef = result?.entry?.prompt_ref;
                    const wasCreate = this.editTarget?.type === "library-new";
                    this.dropDeletedLibrarySelection(this.editTarget, result);
                    if (oldRef && newRef) {
                        relinkLiveNodes(oldRef, newRef); // every live node, not just this one
                        this.remapLibrarySelection(oldRef, newRef);
                    }
                    if (wasCreate) this.autoSelectCreatedPrompt(newRef);
                    this.editTarget = null;
                    this._displayCache.clear();
                    this.preview.invalidate([oldRef, newRef].filter(Boolean));
                    // When the panel reported the picture
                    // moved, bump AND remake the mounted card directly.
                    // The version/freshness bookkeeping is the normal
                    // route, but a library card that keeps showing an
                    // OLD picture after a confirmed image write is worse
                    // than one needless rebuild -- this path does not
                    // consult any freshness guess at all.
                    if (result?.imageChanged && newRef) {
                        apiClient.invalidateLibraryImage(newRef);
                        const verdict = this._rebuildLibraryRow(newRef);
                        // TEMPORARY round-30c probe (live-report triage):
                        // one line per image save. "repaired" shows the
                        // stamp the remounted row got; "no-*" says which
                        // precondition failed to hold. Remove once the
                        // stale-thumbnail report is closed.
                        console.log("[pc] img-save", newRef, "url", apiClient.libraryImageUrl(newRef), "row", verdict);
                    }
                    this.render();
                },
                onCancel: () => {
                    this.editTarget = null;
                    this.render();
                },
            });
        } else if (this.editTarget.type === "library-color") {
            renderLibraryColorEditPanel(this.rightPanel, this.libraryColor, {
                onSave: (color) => {
                    this.libraryColor = color;
                    this.render();
                },
                onClose: () => {
                    this.editTarget = null;
                    this.render();
                },
            });
        }
    }

    /**
     * Everything that would make the cached browse DOM WRONG rather
     * than merely stale. Search TEXT is deliberately not in here: it is
     * a show/hide pass over the same rows. Neither is search VISIBILITY
     * any more -- the strip is a node this build owns and can insert or
     * remove in place (see _applyLibrarySearchVisibility), so the search button
     * does not need a full (chunked, scroll-jumping) rebuild to show or
     * hide one toolbar. Category, favourite and view mode ARE
     * keys: they change which rows exist and in what shape. So does
     * either focused mode, whose notice and per-card badges belong to
     * the rows themselves.
     */
    _libraryViewKey() {
        return [
            this.libraryViewMode,
            this.library.selectedCategory,
            this.library.favoritesOnly ? "fav" : "all",
            this._replacingEntryTarget ? "replace" : "normal",
            this.addingToSectionTarget()?.id ?? "noadd",
        ].join("\u0000");
    }

    /**
     * Show/hide the Library search strip on the MOUNTED browse DOM --
     * one insert/remove plus the button's own state, no rebuild. The
     * strip keeps its typed text, its populated category select and its
     * listeners across the trip (it is literally the same nodes the
     * build created), and the bulk-toolbar anchor follows it so the
     * selection chrome keeps inserting at the same reading order.
     */
    _applyLibrarySearchVisibility() {
        const wrap = this._libWrap;
        const strip = this._libSearchToolbar;
        const btn = this._libSearchButton;
        const container = this._libRowsContainer;
        if (!wrap || !wrap.isConnected || !strip || !btn || !container) {
            this.render(); // not the mounted browser's problem -- rebuild
            return;
        }
        const show = this.librarySearchVisible;
        btn.classList.toggle("pc-on", show);
        btn.title = show ? "Hide search" : "Show search";
        if (show) {
            if (strip.parentElement !== wrap) wrap.insertBefore(strip, container);
            this._libBulkBefore = strip;
            // Counts move under our feet while the strip is hidden
            // (stars, edits): repopulate on the way back in.
            const select = strip.querySelector(".pc-search-category-select");
            if (select) this.populateLibraryCategorySelect(select);
        } else {
            strip.remove();
            this._libBulkBefore = container;
        }
    }

    /** The Library browser: search + category toolbars + card grid,
     * with the same entry-toolbar layout as section rows, minus copy/
     * cut/paste and with add/delete actions tied to library prompts. */
    renderLibraryBrowser() {
        // The panel-swap fast path. Rebuilding the whole browse DOM every
        // time render() comes back from an edit panel would re-create
        // hundreds of rows, spread the fill over frames, and land scrollTop
        // at 0 first -- lag plus a jump. So renderLibraryBrowser stashes
        // the wrap it built, and this path puts that exact DOM back (every row, its
        // loaded thumbnails and its badge fits intact; selection is
        // re-derived from the live set, never trusted from the cache)
        // and only patches what actually changed underneath it (see
        // _syncLibraryRows). Returning a resolved fill promise lets
        // render()'s chained scroll restore apply immediately -- with
        // all rows already present, there is nothing left to grow into,
        // so the restore is the container's final word.
        const viewKey = this._libraryViewKey();
        if (this._libWrapCache && this._libWrapCacheKey === viewKey) {
            const cached = this._libWrapCache;
            this._libWrapCache = null;
            this._libWrapCacheKey = null;
            this.rightPanel.append(cached);
            this._libWrap = cached;
            this._libRowsContainer = cached.querySelector(".pc-entry-grid, .pc-entry-list");
            this._libRenderedRefs = new Set(
                Array.from(this._libRowsContainer?.children || [])
                    .map((node) => node.dataset?.promptRef)
                    .filter(Boolean)
            );
            if (this._syncLibraryRows()) {
                // Selection first: a row this pass MOVED or REBUILT was
                // minted by buildNode, which reads the live selection set,
                // so it is already correct -- but the rows this pass left
                // ALONE kept whatever tick they were drawn with, and the
                // set has since moved on. Clearing the picks at a
                // commit is the everyday case: the grid comes back out of
                // the cache with every previously-selected row still
                // highlighted while the commit strip, built from the
                // (empty) set, says nothing is selected.
                this._syncLibraryCardsSelection();
                this._renderLibrarySelectionChrome();
                const select = cached.querySelector(".pc-search-category-select");
                if (select) this.populateLibraryCategorySelect(select);
                // Rebind the search refs (panel round-trips
                // return the SAME nodes, but the cache path is not the
                // place to trust it) and replay the live query over
                // whatever this sync moved, rebuilt or added -- rows
                // rebuilt from the stamp arrive unmarked.
                this._libSearchInput = cached.querySelector(".pc-search-toolbar .pc-text-input");
                this._libSearchCount = cached.querySelector(".pc-search-count");
                this._libEmptyNode = cached.querySelector(".pc-search-empty");
                this.filterLibraryEntries(this.library.searchText);
                return Promise.resolve();
            }
            // Churn was too big to call a patch. Fall through to the
            // ordinary chunked build with the cache gone.
            cached.remove();
        }

        const wrap = el("div", "pc-locked-prompt-wrap");

        const addingSection = this.addingToSectionTarget();

        if (this._replacingEntryTarget) {
            wrap.append(modeNotice({
                cls: "pc-replace-notice",
                text: "Pick a prompt below to replace the missing entry.",
                cancelTitle: "Cancel",
                onCancel: () => this.cancelReplacingEntry(),
            }));
        } else if (addingSection) {
            wrap.append(modeNotice({
                cls: "pc-pick-add-notice",
                text: `Adding prompts to "${addingSection.name}"`,
                cancelTitle: "Cancel and go back",
                onCancel: () => this.cancelAddingToSection(),
            }));
        }

        const toolbar = el("div", "pc-entry-toolbar");
        const left = el("div", "pc-entry-toolbar-group");

        const btnAdd = uiBtn({
            icon: "promptadd",
            title: "Add prompt",
            onClick: () => {
                this.editTarget = { type: "library-new" };
                this.render();
            },
            extra: "pc-add-entry-btn",
        });

        // Delete and the selection controls have moved to the bulk-action
        // bar under this toolbar (see libraryBulkToolbar). Copy/Cut/Paste
        // are deliberately absent here: a library prompt is a file on disk,
        // so there is no prompt clipboard and nothing to paste into.
        left.append(btnAdd);

        const spacer = el("div", "pc-entry-toolbar-spacer");

        const btnReloadLibrary = uiBtn({
            iconOnly: true, // content set below
            title: "Rescan library folder",
            onClick: async () => {
                btnReloadLibrary.disabled = true;
                // A rescan is BY DEFINITION the whole library moving --
                // files renamed in place under unchanged names, thumbnails
                // swapped byte-for-byte -- so the cached browse DOM is
                // untrustworthy top to bottom, and every thumbnail URL
                // must be re-fetched. Throw the cache away and let the
                // build below (and the library.rescan inside it) start
                // from scratch.
                this._libWrapCache = null;
                this._libWrapCacheKey = null;
                try {
                    // rescan(), not refresh(): this is the one path that
                    // deliberately throws away every cached thumbnail,
                    // because files may have been replaced on disk under an
                    // unchanged name -- and so under an unchanged URL.
                    // The force flag inside makes the server drop its scan
                    // memo + per-file read caches too, so a byte-identical
                    // swap still re-reads. onChunk keeps the mounted grid
                    // filling page by page instead of waiting for all of it.
                    await this.library.rescan({ onChunk: (page) => this._pushLibraryChunk(page) });
                    // A rescan can rename files on disk (UID assignment,
                    // imported-stem normalization, etc. -- see
                    // library_store.scan_library) and any already
                    // resolved display data this session is holding
                    // could now point at a stale filename, so drop the
                    // display cache and any per-prompt_ref preview
                    // cache entries rather than trust what's already
                    // in memory.
                    this._displayCache.clear();
                    this.preview.invalidate();
                } finally {
                    this.render();
                    this.preview.render();
                    // A rescan is exactly the change the
                    // sweep's ref-set guard CANNOT see -- the preset
                    // uses the same refs, but the LIBRARY under them
                    // moved (a gone prompt came back, a live one was
                    // deleted). Force one fresh round.
                    this._alertSweep(true);
                }
            },
        });
        btnReloadLibrary.innerHTML = svgIcon("reload");

        // Stable hook for the targeted show/hide in
        // ComposerUI._applyLibrarySearchVisibility -- same doctrine as the
        // section strip's search toggle: patch the mounted DOM, look the
        // button up rather than cache it.
        const btnSearchToggle = uiToggle({
            on: this.librarySearchVisible,
            icon: "search",
            titleOn: "Hide search",
            titleOff: "Show search",
            // Patches the mounted DOM (insert/remove one strip) rather
            // than re-rendering, which would rebuild the entire browse
            // list -- chunked fill and scroll jump included -- to show
            // or hide a single toolbar row.
            onClick: () => {
                this.librarySearchVisible = !this.librarySearchVisible;
                this._applyLibrarySearchVisibility();
            },
        });

        const btnViewToggle = uiBtn({
            icon: this.libraryViewMode === "grid" ? "list" : "grid",
            title: this.libraryViewMode === "grid" ? "Switch to list view" : "Switch to grid view",
            onClick: () => {
                this.libraryViewMode = this.libraryViewMode === "grid" ? "list" : "grid";
                this.render();
            },
            extra: "pc-view-toggle",
        });

        // The mode's own strip, between the notice and the panel's ordinary
        // toolbar. These three buttons belong to the mode rather than to the
        // panel, and a row of their own lets them take the bulk-action bar's
        // look -- same blue strip, same orange selection-reset buttons --
        // which is what tells a person "this row acts on the set of cards"
        // before they read a word of it.
        // The pick-add strip and the bulk-action strip are pure selection
        // chrome: they depend only on the selection set and the active mode,
        // never on the rows themselves. They are (re)built by
        // _renderLibrarySelectionChrome() into stable anchors below rather
        // than inline here -- that is what lets a single card click refresh
        // them WITHOUT rebuilding all 30-40+ rows (see
        // refreshLibrarySelectionUI), which was the list-view selection lag.
        this._libAddingSection = addingSection;

        toolbar.append(left, spacer, btnReloadLibrary, btnSearchToggle, btnViewToggle);

        const searchToolbar = this.library.buildSearchToolbar(
            () => this.render(),
            () => {
                // Category options refresh instantly (they never
                // depend on the query); the rank/reorder/highlight
                // pass waits for the typing to settle.
                this.populateLibraryCategorySelect(categorySelect);
                this._scheduleLibrarySearch();
            },
            () => this._flushLibrarySearch(),
        );
        this._libSearchInput = searchToolbar.searchInput;
        this._libSearchCount = searchToolbar.searchCount;
        const categorySelect = el("select", "pc-preset-select pc-search-category-select", {
            title: "Filter by category",
        });
        this.populateLibraryCategorySelect(categorySelect);
        categorySelect.addEventListener("change", () => {
            this.library.selectedCategory = categorySelect.value;
            // Choosing Favorite in the dropdown IS the favorites filter, so
            // the modifier is switched off rather than left armed behind
            // the hidden button -- otherwise it would spring back the
            // moment the dropdown moved to something else.
            if (isFavoriteCategory(this.library.selectedCategory)) this.library.favoritesOnly = false;
            this.render();
        });
        searchToolbar.append(categorySelect);
        // The star sits to the right of the dropdown it modifies, and is
        // absent when that dropdown already says "Favorite" -- there is
        // nothing left for a second control to narrow.
        if (!isFavoriteCategory(this.library.selectedCategory)) {
            searchToolbar.append(buildFavoriteFilterButton({
                active: this.library.favoritesOnly,
                onChange: (next) => {
                    this.library.favoritesOnly = next;
                    this.render();
                },
            }));
        }

        // Built from the STRUCTURAL set: category and favourites decide
        // which cards exist, the search text only decides which are shown.
        // See LibraryController.getVisibleEntries for why.
        //
        // Chunked fill: cards are appended across animation frames (see
        // js/chunked_fill.js) instead of one synchronous loop over the
        // whole list -- that loop blocked the main thread long enough on
        // bigger libraries to freeze the node on open and stall the
        // first scroll. The per-entry callbacks below are unchanged; only
        // WHEN each card is built moved. Pages streamed in by
        // library.refresh({onChunk}) arrive through _pushLibraryChunk.
        const container = this.libraryViewMode === "list" ? el("div", "pc-entry-list pc-browse-library") : el("div", "pc-entry-grid pc-browse-library");
        const buildNode = (entry) => {
            const selected = this.librarySelectedPromptRefs.has(entry.prompt_ref);
            const callbacks = {
                selected,
                pickMode: !!this._replacingEntryTarget,
                onOptions: (e) => {
                    this.editTarget = { type: "library-edit", promptRef: e.prompt_ref };
                    this.render();
                },
                // No onDelete: a library card has no delete button (see
                // ui_library.buildCard). Deletion goes through the edit
                // panel, or in bulk via the toolbar's trash button.
                onToggleSelect: (e) => {
                    if (this._replacingEntryTarget) {
                        this.finishReplacingEntry(e.prompt_ref);
                        return;
                    }
                    this.toggleLibrarySelection(e.prompt_ref);
                },
                onToggleFavorite: (e) => this._onLibraryStarToggle(e),
                onDragStart: (dragEvent, promptRef) => {
                    // Dragging doesn't make sense while picking a
                    // replacement (there's nowhere sensible to drop it
                    // that means anything different from just clicking
                    // it) -- suppress the drag payload entirely so a
                    // stray drag can't be misread as a normal
                    // library-to-section drop mid-pick.
                    if (this._replacingEntryTarget) {
                        dragEvent.preventDefault();
                        return;
                    }
                    // Read the selection from the live set, NOT the `selected`
                    // value captured when this card was built: a card toggled
                    // in place (see refreshLibrarySelectionUI) keeps a stale
                    // closure, but the set is always current.
                    const alreadySelected = this.librarySelectedPromptRefs.has(promptRef);
                    const refs = this.librarySelectedPromptRefs.size && alreadySelected
                        ? Array.from(this.librarySelectedPromptRefs)
                        : [promptRef];
                    dragEvent.dataTransfer.setData("text/pc-library-prompt", JSON.stringify(refs));
                    dragEvent.dataTransfer.effectAllowed = "copy";
                    if (!alreadySelected) this.librarySelectedPromptRefs.add(promptRef);
                },
            };
            return this.libraryViewMode === "list"
                ? this.library.buildListRow(entry, callbacks)
                : this.library.buildCard(entry, callbacks);
        };
        const structural = this.library.getStructuralEntries();
        const filler = new ChunkedFiller({
            build: buildNode,
            appendNode: (node) => container.append(node),
            onBatch: (nodes) => this._filterLibraryNodes(nodes, this.library.searchText),
        });
        this._libFiller = filler;
        // Every prompt_ref this browser instance owns a card (or a queued
        // build) for: the seed set now, plus later streamed pages through
        // _pushLibraryChunk. Reset per render together with the filler.
        this._libRenderedRefs = new Set(structural.map((e) => e.prompt_ref));
        filler.push(structural);

        // Anchor the selection chrome to the main toolbar: the pick-add strip
        // is inserted above it, the bulk-action strip directly below it
        // (ahead of the search row) -- the same top-to-bottom reading order
        // the inline build used. Storing these lets _renderLibrarySelectionChrome
        // swap just the strips on a selection change.
        this._libWrap = wrap;
        this._libToolbarAnchor = toolbar;
        this._libBulkBefore = this.librarySearchVisible ? searchToolbar : container;
        this._libPickAddNode = null;
        this._libBulkNode = null;
        this._libRowsContainer = container;
        // The search strip exists whether or not it is mounted (the
        // build always creates it), so the toggle button can hide and
        // re-show THIS node -- text, category select, listeners and all
        // -- instead of ever forcing a rebuild over a toolbar.
        this._libSearchToolbar = searchToolbar;
        this._libSearchButton = btnSearchToggle;
        wrap.append(toolbar);
        if (this.librarySearchVisible) wrap.append(searchToolbar);
        wrap.append(container);
        // The no-results block lives BESIDE the grid, never
        // inside it -- a child of the rows container would be scanned
        // by _syncLibraryRows as a candidate row.
        this._libEmptyNode = el("div", "pc-search-empty");
        this._libEmptyNode.style.display = "none";
        wrap.append(this._libEmptyNode);
        this.rightPanel.append(wrap);
        // Build the two selection strips now, through the one code path that
        // also refreshes them on every later selection change.
        this._renderLibrarySelectionChrome();
        // The text is a show/hide pass over the cards just built, run after
        // they are attached so the query below can find them. Without it a
        // re-render triggered by anything else -- a category change, a star,
        // a favourite toggle -- would silently drop the text still sitting
        // in the field and show the whole category again. With the chunked
        // fill this pass covers the first frame's cards; every later batch
        // gets the same treatment via the filler's onBatch hook, so a card
        // can never flash in unfiltered.
        this.filterLibraryEntries(this.library.searchText);
        // Stash this DOM for the next panel round-trip, and the builder
        // so _syncLibraryRows can mint replacement rows in the same
        // shape (same callbacks, same view mode) without rebuilding
        // anything else.
        this._libBuildNode = buildNode;
        this._libWrapCache = wrap;
        this._libWrapCacheKey = viewKey;
        // Resolves once the last chunk is in the DOM (immediately when
        // everything already fit in a frame); render() chains the final
        // scroll restore onto this. The same then() settles
        // the search view over the COMPLETE set -- batches only ever
        // saw themselves, so rank, marks and the summary get their
        // final pass here (guarded: a re-render mid-fill owns the view
        // by now and ran its own).
        return filler.whenIdle().then(() => {
            if (this._libFiller === filler) this.filterLibraryEntries(this.library.searchText);
        });
    }

    /**
     * Feed one streamed library page into the MOUNTED browser's filler.
     *
     * Called by LibraryController.refresh's onChunk, which fires while
     * later pages are still in flight. If the browser isn't mounted (no
     * live filler) this is a no-op -- the controller's accumulating
     * entries array means the next renderLibraryBrowser seeds itself
     * from everything that has arrived. When it IS mounted, entries
     * not yet rendered are appended straight into the existing grid:
     * same structural test getStructuralEntries would have applied
     * (category + favourite), same dedup prompt_ref set a re-render
     * resets -- so a page that raced a re-render's seed pass is
     * dropped rather than double-drawn.
     */
    _pushLibraryChunk(entries) {
        const filler = this._libFiller;
        const rendered = this._libRenderedRefs;
        if (!filler || !filler.active || !rendered) return;
        const container = this._libRowsContainer;
        if (!container || !container.isConnected) return;
        const category = this.library.selectedCategory;
        const favoritesOnly = this.library.favoritesOnly;
        const fresh = [];
        for (const entry of entries) {
            if (!entry || rendered.has(entry.prompt_ref)) continue;
            // categoryMembershipFor, not entry.category directly -- same
            // fix as getStructuralEntries()'s own category check
            // (folder pseudo-category + Favorite membership), applied
            // here too since this is a SEPARATE structural filter for
            // entries arriving via the chunked/streaming scan rather
            // than the initial full list.
            if (category !== "All" && !categoryMembershipFor(entry).includes(category)) continue;
            if (favoritesOnly && !isFavoriteEntry(entry)) continue;
            rendered.add(entry.prompt_ref);
            fresh.push(entry);
        }
        if (fresh.length) filler.push(fresh);
    }

    /**
     * Bring the mounted browse rows in line with library.entries
     * WITHOUT rebuilding them (see renderLibraryBrowser's cached path
     * and LibraryController's refresh-less update). Pure dataset reads
     * decide a minimal op set -- drop gone/stale rows, build a
     * replacement only for rows whose own facts changed, add genuinely
     * new ones, then a greedy placement pass moves only what is
     * actually out of order.
     *
     * @returns {boolean} false if the diff was too big to be a patch
     *   (an import landing twenty files, a rescan renaming half the
     *   folder) -- the caller then falls through to the ordinary
     *   chunked full build, which is the honest cheapest option there.
     */
    _syncLibraryRows() {
        const container = this._libRowsContainer;
        const buildNode = this._libBuildNode;
        if (!container || !container.isConnected || !buildNode) return false;

        const entryByRef = new Map();
        for (const entry of this.library.entries) entryByRef.set(entry.prompt_ref, entry);
        const mountedNodes = new Map();
        const mountedFacts = [];
        for (const node of container.children) {
            const ref = node.dataset && node.dataset.promptRef;
            if (!ref) continue;
            const entry = entryByRef.get(ref);
            mountedNodes.set(ref, node);
            mountedFacts.push({
                ref,
                fresh: !!entry && isRowFresh(node, entry)
                    // fThumb says WHETHER there is a picture; fImg says
                    // which one -- an image-only replacement changes the
                    // URL (via invalidateLibraryImage's bump) and nothing
                    // else the stamp covers.
                    && node.dataset.fImg === (entry.has_thumbnail === false
                        ? "none" : apiClient.libraryImageUrl(entry.prompt_ref)),
            });
        }

        const desired = this.library.getStructuralEntries();
        const plan = planLibrarySync(desired, mountedFacts);
        if (plan.abort) return false;
        if (!plan.churn) return true; // nothing at all happened -- the common case

        for (const ref of plan.removeRefs) mountedNodes.get(ref)?.remove();

        const builtNodes = new Map();
        for (const entry of plan.rebuild.concat(plan.add)) {
            const node = buildNode(entry);
            container.append(node);
            builtNodes.set(entry.prompt_ref, node);
            this._libRenderedRefs?.add(entry.prompt_ref);
        }

        // Ordered placement: only disturbed rows move; every insert or
        // rename re-slots the list around them. Lookups span the two
        // populations -- and BUILT must win over MOUNTED: mountedNodes
        // still holds the row this pass REMOVED from the DOM for its
        // rebuilt ref, and preferring it resurrected the dead old node
        // back into the slot while the fresh twin sat at the end of the
        // container (the "category badges never update after
        // an in-place edit" bug -- renames dodged it only because their
        // new ref was never mounted at all).
        const nodeFor = (ref) => builtNodes.get(ref) || mountedNodes.get(ref);
        const currentOrder = [];
        for (const node of container.children) {
            const ref = node.dataset && node.dataset.promptRef;
            if (ref) currentOrder.push(ref);
        }
        for (const op of planPlacements(desired.map((e) => e.prompt_ref), currentOrder)) {
            const node = nodeFor(op.ref);
            if (!node) continue;
            container.insertBefore(node, op.before ? nodeFor(op.before) || null : null);
        }

        // New nodes land unfiltered; existing ones keep whatever state
        // the last search pass left them in (structural drift cannot
        // reach here unnoticed -- category/favourite changes are in the
        // view key and force a full build instead).
        this._filterLibraryNodes(Array.from(builtNodes.values()), this.library.searchText);
        this._renderLibrarySelectionChrome();
        const select = container.parentElement?.querySelector(".pc-search-category-select");
        if (select) this.populateLibraryCategorySelect(select);
        return true;
    }

    /**
     * Replace ONE mounted library row with a freshly built node for its
     * CURRENT entry -- no freshness comparison, no plan, no bump
     * bookkeeping (called when the edit panel has just
     * confirmed the picture changed). Works on the detached cached wrap
     * too: the patch happens before the next render restores it. If the
     * row is not mounted (never rendered, renamed away, or the browser
     * was closed since), the ordinary build/patch paths own it and this
     * quietly does nothing.
     */
    _rebuildLibraryRow(promptRef) {
        const container = this._libRowsContainer;
        // isConnected is deliberately NOT required: mid-save the cached
        // wrap is DETACHED (the edit panel owns the right pane), and a
        // detached subtree accepts DOM surgery fine -- the repair lands
        // before the next render restores this very wrap.
        if (!promptRef || !container || !this._libBuildNode) return "no-wrap";
        const node = Array.from(container.children).find((n) => n.dataset?.promptRef === promptRef);
        if (!node) return "no-row";
        const entry = this.library.entries.find((e) => e.prompt_ref === promptRef);
        if (!entry) return "no-entry"; // gone, or renamed: the diff path owns it
        const fresh = this._libBuildNode(entry);
        container.insertBefore(fresh, node.nextSibling);
        node.remove();
        this._filterLibraryNodes([fresh], this.library.searchText);
        return fresh.dataset.fImg;
    }

    /**
     * The star click, end to end.
     *
     * Not: click -> PATCH -> full library rescan (one rewritten file
     * dirties the server's scan signature, so the rescan re-walks every
     * prompt) -> this.render() -> hundreds of cards rebuilt, which would
     * make the UI feel like it was thinking about it. A favorite is
     * one category tag on one prompt: the only visible effects are that
     * card's star, the favourite-filter show/hide state, and the
     * category dropdown's counts -- and the server's response to the
     * PATCH is authoritative for all three. So:
     *
     *   1. flip the star immediately (optimistic -- the click always
     *      answers itself, the network never gets to be the UI's
     *      bottleneck), without touching the filter;
     *   2. on success, adopt the server's entry (done inside
     *      library.toggleFavorite, refresh:false) and patch the card's
     *      datasets + the filter state for that one row + the dropdown
     *      counts;
     *   3. on failure, flip the star back and say so.
     *
     * A double-click mid-flight is ignored per ref rather than racing
     * two PATCHes against one another.
     */
    async _onLibraryStarToggle(entry) {
        const ref = entry && entry.prompt_ref;
        if (!ref || this._starPending.has(ref)) return;
        this._starPending.add(ref);
        const live = this.library.entries.find((e) => e.prompt_ref === ref) || entry;
        const wasFavorite = isFavoriteEntry(live);
        this._paintLibraryStars(ref, !wasFavorite);
        try {
            const updated = await this.library.toggleFavorite(live, !wasFavorite);
            const nowFavorite = isFavoriteEntry(updated);
            this._paintLibraryStars(ref, nowFavorite, { reconcile: updated });
            // Section views resolve display data through this cache;
            // their passive stars read it, so keep it truthful.
            const cached = this._displayCache.get(ref);
            if (cached) cached.category = (updated && updated.category) || cached.category;
            this._refreshLibraryCategorySelect();
        } catch (err) {
            console.error("Prompt Composer: favorite toggle failed", err);
            this._paintLibraryStars(ref, wasFavorite);
        } finally {
            this._starPending.delete(ref);
        }
    }

    /**
     * Re-render one ref's star(s) across every mounted library row, in
     * place -- one node swap per card, no list rebuild. With
     * `reconcile` (a server-confirmed entry) the row's filter-relevant
     * facts come along too, since "Favorite" is a category and the
     * search/favourite pass reads exactly those.
     */
    _paintLibraryStars(ref, favorite, { reconcile = null } = {}) {
        const container = this._libRowsContainer;
        if (!container || !container.isConnected) return;
        const filterCtx = reconcile
            ? this._librarySearchCtx(this.library.searchText)
            : null;
        for (const node of container.querySelectorAll(`[data-prompt-ref="${CSS.escape(ref)}"]`)) {
            if (reconcile) {
                node.dataset.categories = JSON.stringify(categoryMembershipFor(reconcile));
                node.dataset.fCategory = categoryStampKey(reconcile);
                // Categories live INSIDE the search blob now,
                // so a star is a TEXT change too -- restamp, or the row
                // would keep answering the old category query.
                node.dataset.searchText = searchBlob(reconcile);
            }
            const star = node.querySelector(".pc-fav-star");
            if (star) {
                const placement = star.classList.contains("pc-fav-star-list") ? "list" : "grid";
                star.replaceWith(buildFavoriteStar({
                    favorite,
                    placement,
                    onToggle: () => {
                        const live = this.library.entries.find((e) => e.prompt_ref === ref);
                        if (live) this._onLibraryStarToggle(live);
                    },
                }));
            }
            if (filterCtx) this._applyLibraryRow(node, filterCtx);
        }
    }

    /** The category dropdown's "(N)" counts shift with every favourite
     * (Favorite IS a category) -- refresh them without a render. */
    _refreshLibraryCategorySelect() {
        const wrap = this._libWrap;
        if (!wrap || !wrap.isConnected) return;
        const select = wrap.querySelector(".pc-search-category-select");
        if (select) this.populateLibraryCategorySelect(select);
    }

    renderEntryGrid() {
        const section = this.state.getActiveSection();
        if (!section) return;

        if (section.is_locked_prompt) {
            const wrap = el("div", "pc-locked-prompt-wrap");
            wrap.append(
                el("div", "pc-panel-title", { text: "Prompt" }),
                el("div", "pc-locked-note", {
                    text: "This section injects the User Prompt text field at the top of the node, at wherever this section sits in the list order.",
                })
            );
            this.rightPanel.append(wrap);
            return;
        }

        const toolbar = this.sectionEntryToolbar(section);

        this.rightPanel.append(toolbar);
        // The bulk-action bar goes immediately under the entry toolbar --
        // above the search row, so it stays adjacent to the controls it
        // complements rather than drifting with the filter.
        const bulkToolbar = this.sectionBulkToolbar(section);
        if (bulkToolbar) this.rightPanel.append(bulkToolbar);

        // Search toolbar, MOUNTED only when toggled on (hidden
        // by default and revealed via the Entry toolbar's Search button)
        // but always BUILT and stashed -- showing it is then inserting
        // this exact node back, not a full re-render: rebuilding to
        // reveal one toolbar row is what made the toggle flicker (the
        // rows flash blank while resolveForDisplay + the chunked fill
        // re-run). Its inline category dropdown filters which of the
        // section's OWN entries are visible/pickable, by resolved
        // library content (name/prompt/category) -- they never change
        // section.entries itself, only what's rendered.
        // The strip's DOM + grammar live in ui_chrome.buildSearchBox
        // (byte-twin of the Library's -- they merged into one). What stays
        // here is section-specific: whose state the text mirrors, the
        // debounce, and the extra category/favourite filters on the right.
        const searchToolbar = buildSearchBox({
            value: this.sectionSearchText,
            onLive: (v) => {
                this.sectionSearchText = v;
                scheduleSearch();
            },
            onFlush: () => flushSearch(),
        });
        const searchInput = searchToolbar.searchInput;
        const searchCount = searchToolbar.searchCount;
        const commitSearch = () => {
            this.sectionSearchText = searchInput.value;
            // No dropdown repopulate here: the "(N)" options describe
            // the section, not the query, so typing cannot change them
            // (see populateSectionCategorySelect). Text is a live pass
            // over the built cards -- never a reason to rebuild them.
            this.filterSectionEntries(this.sectionSearchText, this.sectionSelectedCategory);
        };
        // The same typing/commit split as the Library box --
        // keystrokes debounce, deliberate actions (Enter, Esc, the
        // cross) flush immediately. The isConnected guard lands a late
        // timer on a superseded render as the no-op it is.
        const scheduleSearch = () => {
            clearTimeout(this._secSearchTimer);
            this._secSearchTimer = setTimeout(() => {
                this._secSearchTimer = null;
                if (searchInput.isConnected) commitSearch();
            }, LIB_SEARCH_DEBOUNCE_MS);
        };
        const flushSearch = () => {
            clearTimeout(this._secSearchTimer);
            this._secSearchTimer = null;
            commitSearch();
        };
        this._secSearchInput = searchInput;
        this._secSearchCount = searchCount;
        const sectionCategorySelect = el("select", "pc-preset-select pc-search-category-select", {
            title: "Filter by category",
        });
        sectionCategorySelect.addEventListener("change", () => {
            this.sectionSelectedCategory = sectionCategorySelect.value;
            // Same rule as the Library toolbar: selecting Favorite
            // makes the modifier redundant, so it is cleared rather
            // than left armed behind a hidden button.
            if (isFavoriteCategory(this.sectionSelectedCategory)) this.sectionFavoritesOnly = false;
            this.render();
        });
        searchToolbar.append(sectionCategorySelect);
        if (!isFavoriteCategory(this.sectionSelectedCategory)) {
            const sectionFavBtn = buildFavoriteFilterButton({
                active: this.sectionFavoritesOnly,
                onChange: (next) => {
                    // Favourites is ONE CLAUSE of the live
                    // filter pass (_applySectionRow), exactly like the
                    // search text -- so flipping it rides that pass:
                    // flip the flag, redraw the button via applyState,
                    // re-run over the mounted rows (count + empty state
                    // included). No grid rebuild, no flicker -- the same
                    // contract the search box already honors on every
                    // keystroke. render() here was the odd one out.
                    this.sectionFavoritesOnly = next;
                    sectionFavBtn.applyState(next);
                    this.filterSectionEntries(this.sectionSearchText, this.sectionSelectedCategory);
                },
            });
            searchToolbar.append(sectionFavBtn);
        }
        this._secSearchStrip = searchToolbar;
        if (this.sectionSearchVisible) this.rightPanel.append(searchToolbar);

        // .pc-browse-section marks THIS container as the section panel's
        // scroll region (see getScrollRegions) and as the grid
        // _captureAddPlacement measures the entry-point viewport against.
        const container = this.viewMode === "list" ? el("div", "pc-entry-list pc-browse-section") : el("div", "pc-entry-grid pc-browse-section");
        // Which section this mounted grid belongs to (so _stashBrowseScroll
        // records its scroll under the RIGHT id at render top, where
        // activeSectionId has already moved on) plus the live write-through
        // of that scroll into the per-section memory (see
        // _wireBrowseScrollMemory).
        container.dataset.browseSectionId = section.id;
        this._wireBrowseScrollMemory(container, section.id);
        section._moveEntryCallback = (draggedIds, targetIndex) => {
            // Reordering is off the table while a query is
            // live. The drop position is measured in DOM order, but a
            // ranked search displays in CSS order -- the index a card
            // LOOKS like it is at is not the index it has, so any move
            // landing would place the entry somewhere other than the
            // visible gap it was dropped into. Silently refusing is
            // the honest answer; clear the box to reorder.
            if (this.sectionSearchText.trim()) return;
            this.state.moveEntries(section.id, draggedIds, targetIndex);
        };
        // Exposed so a drag-start on any entry card/row in THIS section
        // can read the live set of bulk-selected ids (see entryDragIds /
        // wireEntryDrag in ui_panels.js) without threading selectedEntryIds
        // through every card's props -- same "mutable property on the
        // section, read at drag time" pattern as _moveEntryCallback above.
        section._selectedEntryIds = this.selectedEntryIds;
        // ...and the same for the set of this section's entries whose
        // prompt_ref no longer resolves, which the cross-section payload
        // drops at drag-start time to keep dead pointers out of a copy
        // (see wireEntryDrag). Requires `_missingEntryIds` to be a stable
        // Set mutated in place rather than swapped for a new instance --
        // see renderEntryGrid's fill.
        section._missingEntryIds = this._missingEntryIds;

        this.rightPanel.append(container);
        // The section's no-results block -- BESIDE the rows
        // like the library's (a child of this container would be walked
        // by the chunk filler and the drag-reorder wiring).
        this._secEmptyNode = el("div", "pc-search-empty");
        this._secEmptyNode.style.display = "none";
        this.rightPanel.append(this._secEmptyNode);
        // Insertion anchor for the stashed search strip (see
        // _applySectionSearchToggle): the strip goes directly above the
        // rows, exactly where this build mounts it when visible.
        this._secRowsContainer = container;

        // Resolve display data for every entry's prompt_ref, then
        // populate the grid/list once resolved (progressive: toolbar
        // and empty container show immediately, cards fill in after).
        const refs = section.entries.map((e) => (e && e.prompt_ref) || "");
        return resolveForDisplay(refs)
            // Refs the library cannot resolve stand in with the
            // copy embedded in the loaded workflow (live library always
            // wins). Downstream -- the _missingEntryIds refresh, the
            // category strip, the cards themselves -- all read this one
            // merged map, so nothing can disagree about what's on screen.
            .then((resolvedMap) => mergeWorkflowContent(resolvedMap, this._workflowContents))
            .then((resolvedMap) => {
            // Stashed for the targeted category-dropdown repopulate in
            // _applySectionSearchToggle -- the strip outlives this fill,
            // and its options are computed from exactly this map.
            this._secResolvedMap = resolvedMap;
            // The search score index, keyed by ENTRY ID (one
            // prompt can sit in a section several times -- the ref
            // cannot tell the copies apart, the id can). Built from
            // this same resolve, so the scorer sees exactly what the
            // cards were drawn from. A missing entry searches on its
            // dead ref text -- the only identifier left, and what the
            // "(Missing)" row shows.
            this._secSearchIndex = new Map();
            for (const entry of section.entries) {
                const display = resolvedMap[entry.prompt_ref];
                this._secSearchIndex.set(entry.id, {
                    name: display?.name || "",
                    prompt: display ? display.prompt : (entry.prompt_ref || ""),
                    category: display?.category || [],
                });
            }
            // This very map decided what every card in this
            // section looks like right now -- fold it into the alert
            // status for free, so a card resolving (or going missing)
            // updates its row's chip THE SAME MOMENT the card itself
            // updates, no sweep round-trip needed.
            this._noteAlertStatuses(section, resolvedMap);
            // Refresh the "which entries are broken" set from the same
            // resolve that drives the "(Missing)" cards, so the bulk
            // action rules can never disagree with what's on screen.
            // Cleared and refilled rather than replaced: `section
            // ._missingEntryIds` (read at drag-start) and any other
            // holder of this reference must keep seeing live data.
            this._missingEntryIds.clear();
            for (const entry of section.entries) {
                if (!resolvedMap[entry.prompt_ref]) this._missingEntryIds.add(entry.id);
            }
            // Options come from the resolved map, so they can only be
            // built once it lands -- which is why the strip is stashed
            // rather than populated synchronously at build time.
            this.populateSectionCategorySelect(sectionCategorySelect, section, resolvedMap);
            container.innerHTML = "";

            // Only the structural filters decide which cards get built.
            // The search text is applied afterwards, by showing and
            // hiding -- see filterSectionEntries below and
            // LibraryController.getVisibleEntries for the reasoning.
            // Eligibility is decided once, up front (exactly like the
            // `continue`s in the old synchronous loop), and the cards
            // themselves then land across animation frames through the
            // ChunkedFiller -- filling hundreds of entries synchronously
            // would freeze the main thread before anything was visible.
            const eligible = [];
            for (const entry of section.entries) {
                const display = resolvedMap[entry.prompt_ref] || null;
                if (this.sectionSearchVisible) {
                    if (this.sectionSelectedCategory !== "All") {
                        // categoryMembershipFor (Favorite + folder
                        // pseudo-category INCLUDED -- see its own
                        // comment), NOT display?.category directly.
                        // This pre-filter decides which entries even
                        // get a card built at all for this render, so
                        // it has to agree with _applySectionRow's live
                        // filter (which already uses
                        // categoryMembershipFor via entrySearchDataset)
                        // on what "this entry's categories" means --
                        // otherwise selecting a folder pseudo-category
                        // discarded every entry here, before
                        // _applySectionRow's own (correct) check ever
                        // got a chance to run on anything.
                        const cats = categoryMembershipFor(display);
                        if (!cats.includes(this.sectionSelectedCategory)) continue;
                    }
                    // Intersects with the category above rather than
                    // replacing it: "the favorites in this category".
                    // A missing entry has no resolved categories, so it
                    // can never be a favorite and drops out here -- which
                    // is right, there is nothing to show about it.
                    if (this.sectionFavoritesOnly && !isFavoriteEntry(display)) continue;
                }
                eligible.push(entry);
            }

            const makeNode = (entry) => {
                const display = resolvedMap[entry.prompt_ref] || null;
                const selected = this.selectedEntryIds.has(entry.id);
                const sharedCallbacks = {
                    selected,
                    onToggleVisible: () => {
                        entry.visible = !entry.visible;
                        this.refreshRenderedEntry(entry);
                        this.refreshSectionCounter(section);
                        // Re-gate the count-dependent toolbar state on
                        // every visibility flip: Show-all
                        // always stays, Hide-all keeps the >=1-visible
                        // rule -- and if the counter's visible-only filter
                        // was on when this was the LAST visible card, the
                        // shared patch releases it (ring off, dimmed
                        // cards back) before the panel would empty itself.
                        this.refreshEntryToolbarHideAllGate(section);
                        this.notifyInPlace();
                    },
                    onToggleSelected: () => {
                        // Transient bulk-action selection only -- NOT
                        // persisted, and deliberately independent of
                        // entry.visible (output inclusion). This is
                        // the ONLY way entries are chosen for the entry
                        // toolbar's Copy/Cut/Delete actions now that
                        // there is no more per-entry delete button.
                        if (this.selectedEntryIds.has(entry.id)) this.selectedEntryIds.delete(entry.id);
                        else this.selectedEntryIds.add(entry.id);
                        this.refreshRenderedEntry(entry);
                        this.refreshEntryToolbar(section);
                        this.notifyInPlace();
                    },
                    onToggleRandom: () => {
                        entry.allow_random = !entry.allow_random;
                        this.refreshRenderedEntry(entry);
                        this.notifyInPlace();
                    },
                    onCycleSeparator: () => {
                        entry.entry_separator = cycleEntrySeparator(entry.entry_separator);
                        this.refreshRenderedEntry(entry);
                        this.notifyInPlace();
                    },
                    onDuplicate: () => {
                        // No card/row renders a duplicate control today
                        // (the toolbar's Copy/Paste pair is the live
                        // duplication path), but the rule is stated here
                        // so it holds if one is ever added: duplicating
                        // a missing entry only clones a dead pointer.
                        if (this._missingEntryIds.has(entry.id)) return;
                        this.state.duplicateEntry(section.id, entry.id);
                    },
                    onOptions: () => {
                        this.editTarget = { type: "library-edit", promptRef: entry.prompt_ref };
                        this.render();
                    },
                    onReplace: () => this.startReplacingEntry(section.id, entry.id),
                    // Affordance for "workflow copy" badges
                    // (only meaningful when display.from_workflow, which
                    // is exactly when the badge renders).
                    onRestore: () => this.restoreEmbeddedEntry(entry),
                };
                return this.viewMode === "list"
                    ? buildEntryListRow(section, entry, display, sharedCallbacks)
                    : buildEntryCard(section, entry, display, sharedCallbacks);
            };

            const filler = new ChunkedFiller({
                build: makeNode,
                appendNode: (node) => container.append(node),
                onBatch: (nodes) =>
                    this._filterSectionNodes(nodes, this.sectionSearchText, this.sectionSelectedCategory),
            });
            this._entryFiller = filler;
            filler.push(eligible);

            return filler.whenIdle().then(() => {
                // The toolbar was built -- and its Copy/Cut buttons
                // enabled/disabled -- BEFORE this resolve came back, so
                // re-sync it now that the missing set is actually known.
                // Guarded on `isConnected` because this fill can lose a race
                // with a newer render (fast clicking through sections): a
                // detached container means a newer render already owns the
                // right panel (and already cancelled this filler, resolving
                // this chain), and its own fill will refresh its own toolbar.
                if (!container.isConnected) return;
                if (this._entryFiller === filler) this._entryFiller = null;
                // Now that every structurally-eligible card exists, apply the
                // search text to it. This is the only place the text filter runs
                // for a section, which is what lets a shorter query widen the
                // list back out -- the cards it needs are in the DOM because the
                // text never decided whether to build them. It sits under the
                // same guard because it reaches into the right panel by query,
                // and a stale fill must not touch a render that has taken over.
                this.filterSectionEntries(this.sectionSearchText, this.sectionSelectedCategory);
                this.refreshEntryToolbar(section);
            });
        });
    }

    /**
     * Single entry point for "a loaded workflow owns the live
     * composition": replaces sections, re-points the active section,
     * tells the preset toolbar to reconcile WITHOUT auto-loading over
     * the restored state (noteWorkflowRestored), and renders.
     * render() itself syncs the hidden composer_state widget and the
     * preview, so both the queue payload and the visible UI agree with
     * the restored state immediately.
     *
     * @param {Array} sections - sections array from pc_state (or parsed
     *   from the hidden widget on the API-prompt load path).
     * @param {string|null} presetName - name the composition was saved
     *   under, or null when it had none.
     * @param {object|null} snapshot - the workflow's pc_workflow_snapshot
     *   (validated by the caller), whose embedded prompt contents stand in
     *   for any ref this machine's library cannot resolve.
     */
    hydrateFromGraph(sections, presetName = null, snapshot = null) {
        this.applyWorkflowSnapshot(snapshot);
        this.state.sections = sections;
        this.state.presetName = presetName;
        this.state.activeSectionId = sections[0]?.id;
        // The snapshot rides along so the toolbar can name a
        // virtual preset after the workflow when no disk preset matches.
        this.presetToolbar.noteWorkflowRestored(presetName, snapshot);
        this.render();
    }

    /**
     * Adopt (or clear, on null) the workflow's embedded prompt contents.
     * Runs BEFORE the first render so the preview and the entry grid both
     * see the fallback on their very first resolve pass. The copy is only
     * ever a stand-in -- where the live library resolves a ref, its answer
     * wins (see mergeWorkflowContent / PreviewController._contentFor).
     */
    applyWorkflowSnapshot(snapshot) {
        const contents =
            snapshot && snapshot.contents && typeof snapshot.contents === "object"
                ? snapshot.contents
                : null;
        this._workflowContents = contents;
        this.preview.setWorkflowContents(contents);
        // executed-output provenance travels INSIDE the snapshot: an executed string
        // saved with the workflow survives server restarts (the stash
        // itself does not) and is re-adopted on every load until a newer
        // run of this node overwrites it.
        if (snapshot && typeof snapshot.executed_prompt === "string") {
            // "" included -- an empty run is a real record;
            // only a MISSING key means "this node never ran here".
            this.applyExecutedOutput({
                prompt: snapshot.executed_prompt,
                seed: snapshot.executed_seed,
                at: snapshot.executed_at,
            });
            // The embedded value is baked at
            // QUEUE time, so the PNG that a run produces carries the
            // PREVIOUS adoption, never its own ("Edited" phantom on the
            // image you just made). A carried record proves this graph
            // ran here, so lower the birth baseline to its timestamp --
            // the poller then catches up to any strictly-newer stash
            // record for this node id (true latest run), while brand-new
            // nodes keep round-8's protection.
            this._pcBaselineAt = baselineAfterHistoryLoad(
                this._pcBaselineAt,
                snapshot.executed_at,
            );
            this._pcCatchingUp = typeof snapshot.executed_at === "number";
            this._refreshExecutedChip(); // render "Checking..." at once, not "Edited"
        }
        this.syncComposerContents();
    }

    /**
     * Turn a "workflow copy" entry back into a live library
     * prompt -- same name, same text, categories carried, thumbnail-less
     * (.txt with pc_meta; the embedded copy never held image bytes).
     * No confirmation dialog: creating a prompt is cheap and reversible
     * from the Library panel, and the server's collision rules (unified
     * trailing-number suffix, see naming.js) mean a name clash can
     * NEVER overwrite an existing record -- the worst case is a clearly
     * named sibling the entry then points at.
     *
     * Deliberately NOT wrapped in a re-create of the exact old ref: if
     * the UID reproduces (canonical name+prompt unchanged -- the normal
     * case on a fresh machine) the entry's ref is already right; if the
     * server settled on a suffix, the entry re-points at the created
     * ref so the card flips to live immediately rather than staying
     * "missing" next to a prompt the user can see.
     */
    async restoreEmbeddedEntry(entry) {
        const oldRef = entry && entry.prompt_ref;
        const plan = restorePlanFor(oldRef, this._workflowContents);
        if (!plan) {
            // Loud on purpose (smoke feedback #4 diagnosed a silent
            // no-op path here): a badge that finds nothing to restore
            // is a state bug worth seeing in the console.
            console.warn("Prompt Composer: workflow-copy badge had no embedded content to restore", oldRef);
            return;
        }
        try {
            const created = await this.library.create({
                name: plan.name,
                prompt: plan.prompt,
                category: plan.category,
                imageDataUrl: null,
            });
            const newRef = created && created.prompt_ref;
            if (newRef && newRef !== oldRef) {
                // The server landed elsewhere (a name/prompt collision
                // can make that happen). EVERY entry that pointed at the
                // dead ref follows the new record -- the clicked card
                // and all its siblings (smoke feedback #4: siblings kept
                // their badges when only one entry was re-pointed).
                for (const section of this.state.sections) {
                    for (const e of section.entries || []) {
                        if (e.prompt_ref === oldRef) e.prompt_ref = newRef;
                    }
                }
            }
            this.preview.invalidate([oldRef, newRef].filter(Boolean));
            // The grid resolves display data through this cache for some
            // passive paths (stars); drop both identities so the next
            // fill re-reads the freshly live answer.
            this._displayCache.delete(oldRef);
            if (newRef) this._displayCache.delete(newRef);
            // The saved workflow's own fallback copy stays in
            // _workflowContents: harmless (live resolutions always win
            // it everywhere) and still needed by any OTHER workflow
            // that shares it, or by re-save for provenance.
            //
            // Full render(), NOT notifyInPlace(): notify keeps entry
            // cards exactly as built -- right for entry-flag edits, but
            // a restore changes ref->display DATA, so the grid must
            // re-resolve to flip every badge-marked card live (smoke
            // feedback #4's "it stays still").
            this.render();
        } catch (err) {
            console.error("Prompt Composer: restore into library failed", err);
            alert(`Could not restore "${plan.name}" into the Library: ${err?.message || err}`);
        }
    }

    /**
     * the executed-output entry point: adopt an executed-output record from either
     * source -- the live WS fetch after a run, or the snapshot of a
     * loaded workflow ("what it said" survives saves and restarts this
     * way even though the server stash does not). Keeps the hidden
     * executed_prompt widget in step so the value rides widgets_values
     * too (the placeholder-visible channel, same trick as final_prompt).
     *
     * An EMPTY string is a real executed output (all sections
     * off -> compose emits ""), adopted like any other. Only a missing/
     * non-string prompt means "no record".
     */
    applyExecutedOutput(record) {
        if (!record || typeof record.prompt !== "string") return;
        this._executed = {
            prompt: record.prompt,
            seed: record.seed ?? null,
            at: record.at ?? null,
        };
        // Tell the status poller (round-7) this exact write is consumed,
        // whichever channel adopted it; a record without `at` (the
        // executed_prompt widget restore path) leaves the marker alone.
        if (record.at != null) this._pcAdoptedAt = record.at;
        this._executedError = null; // a success outranks any earlier failure
        this._pcCatchingUp = false; // any adoption resolves the question
        this._syncExecutedWidget();
        this._refreshExecutedChip();
    }

    /** Mirror the hidden executed_prompt widget to _executed.prompt (the
     * round-31 sentinel keeps an executed "" distinguishable from a
     * never-run node's default ""). Shared by live adoption and the
     * round-33 press-and-hold accept. */
    _syncExecutedWidget() {
        const widget = this.node && this.node.executedPromptWidget;
        if (!widget) return;
        const stored = this._executed.prompt === ""
            ? PC_EMPTY_EXECUTED_MARK
            : this._executed.prompt;
        if (widget.value !== stored) widget.value = stored;
    }

    /**
     * Press-and-hold on "Edited": accept the CURRENT
     * composition as what ran -- the chip's drift was inherited (a
     * re-adopted file record from before this browser session, say) and
     * the user is resolving it locally. Deliberately NOT a queue: the
     * server stash still holds the truth of the last real run and a
     * later genuine adoption will happily overwrite this.
     */
    acceptCurrentAsExecuted() {
        if (!this._executed) return;
        this._executed = { ...this._executed, prompt: this._lastComposedPreview || "" };
        this._syncExecutedWidget();
        this._refreshExecutedChip();
    }

    /**
     * Press-and-hold on "Reset Seed": accept the CURRENT
     * seed value as the executed one (a non-numeric/absent widget
     * clears the record's seed, which also hides the chip -- "I am not
     * chasing any seed" is a legitimate answer).
     */
    acceptCurrentSeedAsExecuted() {
        if (!this._executed) return;
        this._executed = { ...this._executed, seed: this._currentSeedValue() };
        this._refreshExecutedChip();
    }

    /** Re-derive the executed chips from (_executed, preview, seed, error). */
    _refreshExecutedChip() {
        const edited = this.editedChip, reset = this.resetSeedChip, err = this.execErrorChip;
        if (!edited || !reset || !err) return;
        const states = executedChipStates(
            this._executed,
            this._lastComposedPreview,
            this._currentSeedValue(),
            this._executedError,
            this._pcCatchingUp,
        );
        edited.style.display = states.edited ? "" : "none";
        if (states.edited) {
            edited.textContent = states.edited.label;
            edited.title = states.edited.tooltip;
        }
        edited.classList.toggle("pc-exec-chip-checking", !!this._pcCatchingUp && !!states.edited);
        reset.style.display = states.resetSeed ? "" : "none";
        if (states.resetSeed) {
            reset.textContent = states.resetSeed.label;
            reset.title = states.resetSeed.tooltip;
        }
        reset.classList.toggle("pc-exec-chip-checking", !!this._pcCatchingUp && !!states.resetSeed);
        err.style.display = states.error ? "" : "none";
        if (states.error) err.title = states.error.tooltip;
    }

    /** Live value of the seed widget (null when the node shape lacks it). */
    _currentSeedValue() {
        const w = (this.node && this.node.seedWidget)
            || (this.node && this.node.widgets && this.node.widgets.find((x) => x && x.name === "seed"));
        if (!w) return null;
        const n = Number(w.value);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * "Reset Seed" action: write the executed seed back into the widget.
     * The seed change is caught by the existing external-seed watcher
     * (watchSeedForExternalChanges) which recomposes the preview, and the
     * chip refresh here makes the button vanish the moment its reason
     * (the seed difference) is gone.
     */
    _resetSeedToExecuted() {
        if (!this._executed) return;
        const target = Number(this._executed.seed);
        if (!Number.isFinite(target)) return;
        const w = (this.node && this.node.seedWidget)
            || (this.node && this.node.widgets && this.node.widgets.find((x) => x && x.name === "seed"));
        if (!w) return;
        w.value = target;
        try { if (w.callback) w.callback(target, undefined, this.node, w); } catch { /* extension-owned; never block the reset */ }
        if (this.node && typeof this.node.setDirtyCanvas === "function") this.node.setDirtyCanvas(true, false);
        if (this.node && this.node.graph && typeof this.node.graph.change === "function") this.node.graph.change();
        this._refreshExecutedChip();
    }

    /**
     * Ask the server what this node EMITTED during `promptId`'s run.
     * Called the moment the node's own "executed" event lands, so a
     * record exists whenever compose() actually ran. Two failures are
     * ordinary and stay quiet: a cache-served node (compose never ran
     * this prompt -> "no recorded output") and nothing at all when the
     * node wasn't part of the run (we only fetch for matched ids).
     * Anything else -- above all a 404 ON THE ENDPOINT from a server
     * that predates the Python changes -- gets the one-shot warning.
     */
    async requestExecutedOutput(promptId) {
        const node = this.node;
        if (!node || node._pcDestroyed || node.id == null) return;
        try {
            const record = await apiClient.getExecutedOutput(promptId, String(node.id), PC_CLIENT_KEY);
            this.applyExecutedOutput(record);
        } catch (err) {
            const msg = String((err && err.message) || err || "");
            if (/recorded output/i.test(msg)) {
                // The node REPORTED executed, so compose() should have
                // recorded -- an empty stash here is an anomaly (e.g. an
                // empty PROMPT_ID, which Python also logs to the server
                // terminal). Surface it instead of swallowing it.
                this._executedError = "Server recorded nothing for this run (node "
                    + node.id + ", prompt " + promptId + ").";
                this._refreshExecutedChip();
                warnExecutedFetchFailure(err, node.id, promptId);
                return;
            }
            this._executedError = msg; // red chip: node ran, chain broken
            this._refreshExecutedChip();
            warnExecutedFetchFailure(err, node.id, promptId);
        }
    }

    /**
     * Startup-probe verdict: the /last_output endpoint itself is not
     * answering -- the classic shape of a server process that predates
     * the executed-output Python changes. Say so on every composer node immediately
     * (tooltip explains; a later successful adopt clears it).
     */
    noteC3EndpointDown(msg) {
        if (this._executed) return; // a real record always outranks doubt
        this._executedError = "Executed-output endpoint unreachable: " + msg;
        this._refreshExecutedChip();
    }

    /**
     * PreviewController.onComposed sink: keep the composed string where
     * save-time and queue-time readers can find it synchronously --
     * _lastComposedPreview for the snapshot extra, and the hidden
     * final_prompt widget so the value also rides in widgets_values (the
     * channel an unknown-node placeholder can display).
     * Also refreshes the composer_contents queue fallback, since
     * "what the preview just showed" is exactly the state both mirrors
     * must describe. Deliberately does NOT setDirtyCanvas: the mirror
     * follows an edit that already dirtied things, and stamping on every
     * debounce tick would make workflows look permanently unsaved.
     */
    /**
     * Make `id` the active (left-panel-focused) section, resetting
     * whatever transient UI state doesn't make sense to carry over to a
     * different section (an open edit panel, a live search/category/
     * favorites filter, a multi-select, a replacement pick in flight,
     * or the Library panel).
     *
     * Extracted from the left panel's own row-click handler (onSelect
     * Section) so the PREVIEW text's click-to-select behavior (see
     * _handlePreviewClick) can select a section exactly the same way a
     * left-panel click does, rather than maintaining two copies of this
     * reset list that could drift apart.
     */
    selectSection(id) {
        // re-selecting the ALREADY-active section is a no-op
        // -- every field this resets is already at its default, so the
        // only thing a rebuild would do is flash the entry grid. The
        // moment anything differs (an open edit panel, a live search/
        // category/favorites filter, a selection to clear, a
        // replacement pick in flight, or the Library panel to leave)
        // there's work to do and the full path runs unchanged.
        if (id === this.state.activeSectionId && !this.showLibraryPanel
            && this.editTarget === null && this.selectedEntryIds.size === 0
            && this.sectionSearchText === "" && this.sectionSelectedCategory === "All"
            && !this.sectionFavoritesOnly && this._replacingEntryTarget === null) {
            return;
        }
        this.editTarget = null;
        this.showLibraryPanel = false;
        this.selectedEntryIds.clear();
        this.sectionSearchText = "";
        this.sectionSelectedCategory = "All";
        this.sectionFavoritesOnly = false;
        // Navigating to a section implicitly cancels an in-progress
        // "pick a replacement" flow (see startReplacingEntry) -- there's
        // no sensible way to finish the pick once the Library panel
        // that was showing it is gone.
        this._replacingEntryTarget = null;
        this.state.activeSectionId = id;
        this.render();
    }

    _mirrorComposedPreview(text) {
        this._lastComposedPreview = text;
        const widget = this.node.finalPromptWidget;
        if (widget && widget.value !== text) widget.value = text;
        this.syncComposerContents();
        // Same/differs against the FRESHEST composition (executed-output chip).
        this._refreshExecutedChip();
        // Both the "PREVIEW" title's rainbow letters AND the colored
        // overlay track every completed render, not just the overlay --
        // calling _renderColorizedPreview() alone would leave
        // the title stuck on whatever it showed at the last color-picker
        // edit (or never painted at all): adding/removing a section,
        // toggling one's visibility, or loading a preset all change
        // which colors exist WITHOUT going through the color picker's
        // own onColorChange hook, and every one of those funnels through
        // a completed render -- this is the one place that reliably
        // catches all of them at once.
        this._refreshPreviewColorState();
    }

    /**
     * Repaint whatever depends on the preview-colorize toggle: the
     * "PREVIEW" label's own rainbow letters, and the colored overlay
     * over the preview text. Called on toggle click (immediate, no
     * network) and on every completed preview render (so a section
     * color edit or a composition change updates the paint live while
     * the toggle stays ON -- see _mirrorComposedPreview).
     */
    _refreshPreviewColorState() {
        this._applyPreviewLabelColors();
        this._renderColorizedPreview();
    }

    /**
     * Paint (or un-paint) each letter of the "PREVIEW" label.
     *
     * ON: cycles the EXISTING section colors across the letters, in
     * section order, wrapping if there are fewer colors than letters
     * (7, for "PREVIEW") -- "use existing colors", rather than
     * inventing a fixed rainbow palette that could clash with or
     * duplicate a section's own accent. Falls back to the info color
     * when there are no sections to draw a color from (a brand new/
     * emptied composition), so the label is never left blank or an
     * unstyled default while ON.
     * OFF: every inline color is cleared, which lets the CSS default
     * (the plain dim label color) show through exactly as it did
     * before this became a toggle.
     */
    _applyPreviewLabelColors() {
        if (!this.previewColorOn) {
            for (const span of this._previewLabelLetterEls) span.style.color = "";
            return;
        }
        // Enabled ("visible") sections only -- the section-row eye
        // toggle is what "visible" means at the section level (see
        // section.enabled throughout ui_panels.js/ui_preview.js); a
        // disabled section contributes nothing to the composed prompt
        // (getSectionBlocks skips it too), so its color has no business
        // showing up in the preview's own title either.
        const colors = this.state.sections
            .filter((section) => section.enabled)
            .map((section) => section.color)
            .filter((color) => typeof color === "string" && color.trim());
        const fallback = "var(--pc-info)";
        this._previewLabelLetterEls.forEach((span, i) => {
            span.style.color = colors.length ? colors[i % colors.length] : fallback;
        });
    }

    /**
     * Build (or clear) the colored overlay showing the live preview
     * text in each section's own accent color.
     *
     * Painted from getSectionBlocks() -- the SAME per-section walk
     * _composeLocally() joins into the plain preview string (see
     * ui_preview.js) -- rather than from the server's final joined
     * string, because once blocks are joined with plain spaces there
     * is no reliable way back to "which word came from which section"
     * (a separator character can coincide with real content, the same
     * text can appear from two different sections, etc). This can
     * differ from the exact server string in one place: a WARM,
     * randomized section reusing the server's last authoritative
     * choice shows this mirror's own (seed-hashed) pick instead --
     * the same documented approximation _composeLocally already
     * carries; a resolving network round-trip corrects it moments
     * later, same as the plain preview does.
     *
     * Locked-prompt/no-color sections fall back to the info color,
     * same rule and same reason as the label (see
     * _applyPreviewLabelColors) -- though in practice every section
     * factory hands out a color, so this mostly guards a hand-edited
     * or future section shape that doesn't.
     */
    _renderColorizedPreview() {
        const active = this.previewColorOn;
        this.previewTextWrap.classList.toggle("pc-preview-colorized-active", active);
        if (!active) {
            this.previewColorLayer.textContent = "";
            return;
        }
        const userPromptValue = this.node.userPromptWidget ? this.node.userPromptWidget.value : "";
        const linked = resolveLinkedString(this.node);
        const blocks = this.preview.getSectionBlocks(this.state, linked != null ? linked : userPromptValue);

        this.previewColorLayer.textContent = "";
        blocks.forEach((block, blockIndex) => {
            // The section-name label prefix (show_label) sits OUTSIDE
            // every entry run (see getSectionBlocks's own labelPrefix
            // field) -- there's no single entry it belongs to, only the
            // section as a whole. Rendered in the section's own color
            // so it still reads as part of the same colored block, but
            // as a plain (non entry-hoverable) span: hovering it
            // doesn't highlight any one entry, since it isn't one --
            // clicking it still selects the section (dataset.pcSectionId
            // is set on every span in this block, entries and label
            // alike; see _handlePreviewClick), which is the one thing
            // it IS "part of".
            if (block.labelPrefix) {
                const labelSpan = el("span", "pc-preview-word", { text: block.labelPrefix });
                labelSpan.style.color = block.color || "var(--pc-info)";
                labelSpan.dataset.pcSectionId = block.sectionId;
                this.previewColorLayer.appendChild(labelSpan);
            }
            block.entries.forEach((run, runIndex) => {
                const span = el("span", "pc-preview-word", { text: run.text });
                span.style.color = block.color || "var(--pc-info)";
                // Entry-level addressing for hover-highlight and
                // click-to-select (see the mouseover/click listeners
                // wired once on previewColorLayer itself, in the
                // constructor): every run from the SAME entry across
                // this block shares entryId, so a multi-word entry
                // still highlights as one unit even though it is one
                // span here already (an entry currently always
                // produces exactly one run/span; the shared-id grouping
                // is what makes future multi-span entries safe too).
                // A null entryId (the locked Prompt section's synthetic
                // run -- there's no library entry behind typed text)
                // still gets a sectionId, so hovering/clicking it still
                // highlights/selects the Prompt section itself.
                span.dataset.pcSectionId = block.sectionId;
                if (run.entryId != null) span.dataset.pcEntryId = run.entryId;
                this.previewColorLayer.appendChild(span);
                if (runIndex < block.entries.length - 1) {
                    // The join space BETWEEN two entries in the same
                    // section: not part of either entry's own span, but
                    // still carries the section id so hovering the gap
                    // between two words of the same block doesn't drop
                    // out of the highlight/pointer-cursor state.
                    const gap = el("span", "pc-preview-word", { text: " " });
                    gap.style.color = block.color || "var(--pc-info)";
                    gap.dataset.pcSectionId = block.sectionId;
                    this.previewColorLayer.appendChild(gap);
                }
            });
            if (block.endSeparator) {
                // The section's end-separator character ("." or ",")
                // sits OUTSIDE every entry (see getSectionBlocks) -- it
                // would be dropped entirely from the overlay if skipped,
                // and a section ending in a period would visibly
                // show one fewer character than the real textarea
                // underneath it. Rendered the same way as the label
                // prefix: same section color, carries data-pc-section-id
                // so clicking it still selects the section, but
                // deliberately WITHOUT data-pc-entry-id -- this
                // character never joins an entry's hover-highlight (the
                // CSS's .pc-preview-word[data-pc-entry-id] selector is
                // what makes a span interactive/highlightable at all,
                // and this span intentionally doesn't qualify).
                const endSpan = el("span", "pc-preview-word", { text: block.endSeparator });
                endSpan.style.color = block.color || "var(--pc-info)";
                endSpan.dataset.pcSectionId = block.sectionId;
                this.previewColorLayer.appendChild(endSpan);
            }
            if (blockIndex < blocks.length - 1) {
                // A literal space TEXT NODE between BLOCKS (sections) --
                // exactly what _composeLocally joins with, so the
                // overlay wraps at the same points the plain textarea
                // underneath it does. Deliberately a bare text node,
                // not a span: the gap between two DIFFERENT sections'
                // text belongs to neither one, so it carries no
                // pcSectionId and hovering/clicking it does nothing
                // (see _handlePreviewHover/_handlePreviewClick).
                this.previewColorLayer.appendChild(document.createTextNode(" "));
            }
        });
        // Rebuilding the overlay's children resets its own scrollTop to
        // 0 (a fresh DOM subtree always starts unscrolled) -- realign it
        // to wherever the real textarea currently sits, so re-painting
        // mid-scroll (e.g. turning the toggle ON while already scrolled
        // down, or a composition update while scrolled) doesn't snap
        // the visible overlay back to the top for a frame.
        this.previewColorLayer.scrollTop = this.previewText.scrollTop;
        this.previewColorLayer.scrollLeft = this.previewText.scrollLeft;
        // New content can newly trigger (or newly remove) the
        // textarea's own scrollbar, which changes its gutter width --
        // re-measure so the overlay's compensating padding
        // (see syncOverlayGutter) never lags one render behind.
        if (this._syncPreviewOverlayGutter) this._syncPreviewOverlayGutter();
    }

    /**
     * The identity a colorized-preview word span is addressed by: an
     * entry id when the span stands for a library entry's text, or (for
     * the locked Prompt section's entry-less synthetic span) just the
     * section id. Returns null for a span that isn't independently
     * interactive at all -- the inter-entry join gap, the section-name
     * label prefix, or the plain text-node spacing between two
     * different sections' blocks -- which is also what
     * .pc-preview-word[data-pc-entry-id] / [data-pc-section-id=
     * "prompt-locked"] in the CSS keys pointer-events/cursor off of, so
     * "is this span interactive" is decided in exactly one place.
     */
    _previewWordIdentity(span) {
        if (!span || !span.dataset) return null;
        if (span.dataset.pcEntryId) return { entryId: span.dataset.pcEntryId, sectionId: span.dataset.pcSectionId };
        if (span.dataset.pcSectionId === "prompt-locked") return { entryId: null, sectionId: span.dataset.pcSectionId };
        return null;
    }

    /**
     * Highlight every span belonging to the SAME entry as the one under
     * the cursor (mouseover), or clear the highlight when the cursor
     * leaves it (mouseout) -- "hovering a PART of a prompt highlights
     * the WHOLE prompt", not just the single span the pointer happens
     * to be over. In the current data model an entry is always exactly
     * one span (see getSectionBlocks), so this mostly toggles one
     * class on one element; matching by data-pc-entry-id (rather than
     * capturing "the span the mouse is over" and calling it done) is
     * what keeps this correct if an entry's text is ever split across
     * more than one span later (e.g. to color-highlight a search match
     * inside it) without this method needing to change at all.
     */
    _handlePreviewHover(ev) {
        const span = ev.target.closest ? ev.target.closest(".pc-preview-word") : null;
        const identity = this._previewWordIdentity(span);
        if (ev.type === "mouseout") {
            if (identity) this._setPreviewHoverHighlight(null);
            return;
        }
        this._setPreviewHoverHighlight(identity);
    }

    /**
     * Apply (or clear, for a null identity) the hover-highlight class
     * across every span in previewColorLayer sharing the given entry
     * (or, for the locked Prompt section, section) identity. Always
     * clears every OTHER span first, so moving the cursor directly from
     * one entry's span to another's never leaves the previous one stuck
     * highlighted (mouseover on the new span fires before mouseout on
     * the old one in that case, so a naive "just add to the new one"
     * would double-highlight for a frame).
     */
    _setPreviewHoverHighlight(identity) {
        const spans = this.previewColorLayer.querySelectorAll(".pc-preview-word-hover");
        for (const span of spans) span.classList.remove("pc-preview-word-hover");
        if (!identity) return;
        const selector = identity.entryId
            ? `.pc-preview-word[data-pc-entry-id="${CSS.escape(identity.entryId)}"]`
            : `.pc-preview-word[data-pc-section-id="${CSS.escape(identity.sectionId)}"]:not([data-pc-entry-id])`;
        for (const span of this.previewColorLayer.querySelectorAll(selector)) {
            span.classList.add("pc-preview-word-hover");
        }
    }

    /**
     * Clicking any part of an entry's text in the colorized preview
     * selects that entry's PARENT SECTION in the left panel -- the same
     * "select a section" ComposerUI already does for a left-panel row
     * click (see selectSection). There is no per-entry selection
     * target in this app (the left panel selects sections, not
     * individual entries within one), so "select the related section"
     * is the correct and complete behavior, not a placeholder
     * for something finer-grained.
     * A click that lands on non-interactive overlay space (the label
     * prefix's OWN span still carries a section id and is handled the
     * same way; the inter-entry gap or the space between two different
     * sections' blocks carry no identity at all and are ignored here)
     * simply falls through to the textarea underneath -- there is
     * nothing this handler needs to do for those, and (see
     * .pc-preview-colorized's pointer-events:none on the container)
     * the click already reached the textarea directly in that case
     * rather than this handler at all.
     */
    _handlePreviewClick(ev) {
        const span = ev.target.closest ? ev.target.closest(".pc-preview-word") : null;
        const sectionId = span && span.dataset ? span.dataset.pcSectionId : null;
        if (!sectionId) return;
        const entryId = span.dataset.pcEntryId || null;
        this.selectSection(sectionId);
        if (entryId) this.scrollPreviewEntryIntoView(entryId);
    }

    /**
     * Scroll the (just-selected) section's entry list so the given
     * entry's own card/row is visible -- the follow-through on clicking
     * an entry's text in the colorized preview: selecting its section
     * alone can still leave the entry itself scrolled off-screen in a
     * long list, which defeats the point of "click to find this entry".
     *
     * selectSection() just triggered a render(), and renderEntryGrid()
     * fills the entry list ASYNCHRONOUSLY (see its own comment) -- the
     * card for `entryId` may not exist in the DOM yet the instant this
     * runs. Awaiting this._lastRenderSettled (set at the tail of every
     * render(), see there) is what makes this reliable rather than a
     * "usually works" race: it resolves only once THIS render's content
     * fill has actually landed, and resolves to nothing (a no-op) if a
     * newer render superseded this one first -- the same supersede
     * guard render()'s own scroll-restore chain uses, reused here
     * rather than duplicated.
     */
    async scrollPreviewEntryIntoView(entryId) {
        const renderSeq = this._renderSeq;
        await this._lastRenderSettled;
        if (renderSeq !== this._renderSeq) return; // superseded meanwhile

        const jumpToCard = () => {
            if (renderSeq !== this._renderSeq) return false; // superseded meanwhile
            const card = this.rightPanel.querySelector(`.pc-browse-section [data-entry-id="${CSS.escape(entryId)}"]`);
            if (!card) return false; // filtered out by a live search/category, or the section changed underneath us
            card.scrollIntoView({ block: "nearest", inline: "nearest" });
            return true;
        };

        // render()'s OWN scroll-restore chain doesn't stop at
        // _lastRenderSettled's resolution either: ScrollPreserver.restore()
        // (see dom_utils.js) re-applies its captured/persisted position
        // once immediately AND THEN AGAIN across a double
        // requestAnimationFrame, specifically to correct for layout that
        // still settles a frame or two after the content fill promise
        // resolves. That means restore()'s two rAF passes fire AFTER the
        // very microtask this method already waited for -- so a single
        // scrollIntoView() here looked right for an instant and then got
        // silently overwritten back to wherever the freshly-opened
        // section's memory (nothing captured yet -> the top) says it
        // belongs, which is exactly the "works on the second click"
        // symptom: the FIRST click's section has no prior scroll memory
        // to fight, so restore()'s rAF passes have somewhere "correct" to
        // reset it TO; the second click's section already has this
        // method's own position captured as history by then.
        // Matching the same timing (jump now, then again after the same
        // double rAF) makes this scroll the one that's still standing once
        // every pass -- ours and render()'s -- has run.
        jumpToCard();
        requestAnimationFrame(() => {
            jumpToCard();
            requestAnimationFrame(jumpToCard);
        });
    }

    /**
     * Mirror the embedded/fallback content the PREVIEW currently relies
     * on into the hidden composer_contents widget, so Python's compose()
     * can stand in for refs the live library cannot resolve.
     *
     * Uses usedPromptRefsForQueue() (composer_state.js), NOT the general
     * usedPromptRefs() the save-time snapshot uses -- see that function's
     * own docstring for why the two must differ: this widget is a literal
     * input ComfyUI hashes into the node's cache signature on every queue
     * attempt, so a hidden entry's content changing (rename, edit, or
     * anything else) must NOT change what gets embedded here, the same
     * requirement serializeForQueue() already enforces for composer_state
     * itself. Building the {ref: {name, prompt, category}} map directly
     * here (rather than routing through buildSnapshotPayload, which is
     * hardwired to the visibility-blind usedPromptRefs()) keeps that
     * guarantee without touching buildSnapshotPayload's own behavior for
     * its real caller, the save-time workflow snapshot.
     *
     * Same cost budget as the save-side snapshot (cheapest-first, capped
     * at PC_MAX_SNAPSHOT_CONTENTS_CHARS) so the two never disagree on HOW
     * MUCH gets embedded, only on which refs are eligible at all. Cheap
     * and fully synchronous; safe to call after every completed render.
     */
    syncComposerContents() {
        const widget = this.node.composerContentsWidget;
        if (!widget) return;
        let value = "{}";
        try {
            const used = usedPromptRefsForQueue(this.state.sections);
            const cachedContents = this.preview.getCachedContents();
            const candidates = [];
            for (const [ref, entry] of cachedContents) {
                if (!used.has(ref) || !entry || typeof entry.prompt !== "string") continue;
                const cost =
                    ref.length +
                    entry.prompt.length +
                    (entry.name ? entry.name.length : 0) +
                    JSON.stringify(entry.category || []).length;
                candidates.push({ ref, entry, cost });
            }
            candidates.sort((a, b) => a.cost - b.cost);
            const collected = {};
            let bytes = 0;
            for (const { ref, entry, cost } of candidates) {
                if (bytes + cost > PC_MAX_SNAPSHOT_CONTENTS_CHARS) continue;
                collected[ref] = {
                    name: entry.name || "",
                    prompt: entry.prompt,
                    category: Array.isArray(entry.category) ? [...entry.category] : [],
                };
                bytes += cost;
            }
            value = JSON.stringify(collected);
        } catch (err) {
            // Worst case degrades to "no fallback",
            // never a broken queue payload.
            console.error("Prompt Composer: composer_contents sync failed", err);
        }
        if (widget.value !== value) widget.value = value;
    }

    /**
     * The self-contained payload embedded at save.
     * All synchronous by design -- onSerialize cannot await -- so it
     * reports what the preview pipeline last managed to resolve, which
     * (the preview runs on every render) in practice is everything the
     * node shows. Never fabricates: refs with no cached content are
     * simply absent, and `truncated` is only set by the documented size
     * cap.
     */
    buildWorkflowSnapshot() {
        return buildSnapshotPayload({
            nowIso: new Date().toISOString(),
            workflowName: currentWorkflowName(),
            presetName: this.state.presetName,
            sections: stripTransientSectionFields(this.state.sections),
            contents: this.preview.getCachedContents(),
            finalPrompt: this._lastComposedPreview || (this.previewText ? this.previewText.value : ""),
            seed: Number(this.node.seedWidget && this.node.seedWidget.value) || 0,
            userPrompt: (this.node.userPromptWidget && this.node.userPromptWidget.value) || "",
            // executed-output: "what actually ran" -- only when a run completed (or a
            // loaded workflow already carried it); buildSnapshotPayload
            // omits the keys entirely when this is null.
            executed: this._executed,
            maxContentsChars: PC_MAX_SNAPSHOT_CONTENTS_CHARS,
        });
    }

    syncWidget() {
        if (this.node.composerStateWidget) {
            // See ComposerState.serializeForQueue()'s own docstring:
            // this is the queued/hashed widget value, deliberately NOT
            // the full serialize() dump, so that structural-only edits
            // (an empty section, a hidden entry's prompt being renamed,
            // a reorder that doesn't change the joined text, ...) don't
            // change this string and force ComfyUI to treat the node as
            // "changed" independently of whatever IS_CHANGED() computes
            // on the Python side (see that method's docstring for why
            // the raw widget value matters at all here).
            this.node.composerStateWidget.value = this.state.serializeForQueue();
        }
    }
}

// Exported purely so the throwaway test harnesses can drive individual
// methods off the prototype -- Object.create(ComposerUI.prototype) --
// without constructing the whole widget. ComfyUI loads this module for its
// side effect and ignores its exports, so this changes nothing in the app.
export { ComposerUI };

/**
 * Whether an edit target is the library's own prompt editor -- either a new
 * prompt or an existing one. These two are treated as part of whatever task
 * was already open rather than as a change of subject, because reaching for
 * a prompt you do not have yet, or correcting one that is wrong, is how that
 * task gets finished. See ComposerUI.addingToSectionTarget.
 */
function isLibraryPromptEdit(target) {
    return !!target && (target.type === "library-new" || target.type === "library-edit");
}

// ---------------------------------------------------------------------------
// ComfyUI node registration
// ---------------------------------------------------------------------------

const NODE_CHROME_PADDING = 20;
const MIN_PANEL_WIDTH = LEFT_PANEL_MIN_WIDTH + SPLITTER_WIDTH + RIGHT_PANEL_MIN_WIDTH + NODE_CHROME_PADDING;
const MIN_PANEL_HEIGHT = 610;
const USER_PROMPT_MAX_HEIGHT = 128;

app.registerExtension({
    name: "PromptComposer.UI",
    setup() {
        apiClient.getVersion()
            .then((info) => {
                if (info && info.version) PC_VERSION = info.version;
                console.info(`Prompt Composer ${PC_VERSION} (build ${PC_BUILD}) loaded (C3 = executed-output capture; see /prompt_composer/c3_status)`);
            })
            .catch(() => {
                console.info(`Prompt Composer ${PC_VERSION}? (build ${PC_BUILD}) loaded -- version endpoint unavailable`);
            });
        // executed-output: one "executed" listener for the page; it fetches for
        // whichever PC_NODES member just finished its own compose. The
        // universal fallback (status polling) starts with the first
        // node, so it works even on a build where setup() or any WS
        // event or onExecuted gate misbehaves.
        wireExecutedOutputListeners();
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PromptComposer") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            this.userPromptWidget = this.widgets && this.widgets.find((w) => w.name === "user_prompt");
            if (this.userPromptWidget) {
                const originalCallback = this.userPromptWidget.callback;
                this.userPromptWidget.callback = (...cbArgs) => {
                    if (originalCallback) originalCallback.apply(this.userPromptWidget, cbArgs);
                    if (this.composerUI) this.composerUI.preview.render();
                };

                const originalWidgetComputeSize = this.userPromptWidget.computeSize;
                this.userPromptWidget.computeSize = function (width) {
                    const base = originalWidgetComputeSize
                        ? originalWidgetComputeSize.call(this, width)
                        : [width, USER_PROMPT_MAX_HEIGHT];
                    return [base[0], Math.min(base[1], USER_PROMPT_MAX_HEIGHT)];
                };

                const textareaEl = this.userPromptWidget.inputEl || this.userPromptWidget.element || null;
                if (textareaEl) {
                    textareaEl.style.maxHeight = `${USER_PROMPT_MAX_HEIGHT}px`;
                    textareaEl.style.overflowY = "auto";
                }
            }

            this.seedWidget = this.widgets && this.widgets.find((w) => w.name === "seed");
            if (this.seedWidget) {
                const originalSeedCallback = this.seedWidget.callback;
                this.seedWidget.callback = (...cbArgs) => {
                    if (originalSeedCallback) originalSeedCallback.apply(this.seedWidget, cbArgs);
                    if (this.composerUI) this.composerUI.preview.render();
                };
            }

            this.composerStateWidget = this.addWidget("text", "composer_state", "[]", () => {}, { multiline: false });
            this.composerStateWidget.hidden = true;
            this.composerStateWidget.computeSize = () => [0, -4];

            const ui = new ComposerUI(this);
            this.composerUI = ui;

            const domWidget = this.addDOMWidget("prompt_composer_ui", "div", ui.root, {
                // getValue() is what graphToPrompt() reads into
                // node["inputs"]["prompt_composer_ui"] -- a REAL,
                // literal input ComfyUI folds into this node's
                // execution-cache signature on every queue attempt,
                // exactly like composer_state/composer_contents,
                // DESPITE this widget never being declared in Python's
                // INPUT_TYPES at all (ComfyUI's cache signature reads
                // every key in node["inputs"], full stop -- it has no
                // notion of "but Python never asked for this one").
                // serializeForQueue() (not the raw serialize())
                // is the SAME canonical, output-
                // only-relevant string composer_state's own widget
                // carries (see ComposerState.serializeForQueue()'s own
                // docstring in composer_state.js) -- structural-only
                // edits (an empty/disabled section, a hidden entry
                // being added/renamed/re-pointed, a reorder that
                // doesn't change the joined text) must not change this
                // string either, or this ONE widget alone would keep
                // forcing a re-run no matter how stable every other
                // input on this node is made. That was the actual,
                // final leak: every other literal input on this node
                // (composer_state, composer_contents, seed) had already
                // been fixed, and a rename/disable/hide/add-section
                // STILL forced a re-run, because THIS widget -- easy to
                // miss since it exists purely to host the editor's DOM,
                // has no INPUT_TYPES entry, and doesn't show up next to
                // the other hidden widgets in this file -- was still
                // computing its literal value from the full, unfiltered
                // structural dump on every queue.
                getValue: () => ui.state.serializeForQueue(),
                setValue: () => {},
            });
            this._pcDomWidget = domWidget;

            // The composed prompt, mirrored from the preview on every
            // completed render (see _mirrorComposedPreview). Widgets may
            // ONLY ever be APPENDED (LiteGraph applies widgets_values
            // positionally), so this must stay behind every INPUT_TYPES
            // widget and the DOM widget -- the only thing allowed AFTER
            // it is more hidden tail mirrors like composer_contents.
            // On an unknown-node placeholder there is no node code to
            // run, and the frontend renders widgets_values positionally:
            // this near-tail slot is the channel through which a user
            // without this node reads the prompt that made the image
            // Hidden on the real node: the
            // PREVIEW bar already shows it.
            this.finalPromptWidget = this.addWidget("text", "final_prompt", "", () => {}, { multiline: true, serialize: false });
            this.finalPromptWidget.hidden = true;
            this.finalPromptWidget.computeSize = () => [0, -4];

            // Queue-side companion: the JSON map of prompt
            // copies the loaded workflow embedded, delivered to Python's
            // compose() as the hidden `composer_contents` INPUT_TYPES
            // input (the same widget-name -> hidden-input channel
            // composer_state already uses). Kept fresh by
            // ComposerUI.syncComposerContents() on every completed
            // preview, so the queue can never ship a prompt the PREVIEW
            // bar did not show. Hidden.
            this.composerContentsWidget = this.addWidget("text", "composer_contents", "{}", () => {}, { multiline: true });
            this.composerContentsWidget.hidden = true;
            this.composerContentsWidget.computeSize = () => [0, -4];

            // The node's LITERAL last-executed output, kept
            // fresh by applyExecutedOutput (WS fetch after a run, or a
            // loaded snapshot's executed_prompt). Not a queue input --
            // pure provenance that also rides widgets_values so an
            // unknown-node placeholder shows BOTH strings: "would
            // compose" (final_prompt) and "actually ran" (this one).
            // Append-only rule: this is now the tail; only hidden
            // mirrors may follow it. Hidden on the real node; the chip
            // + snapshot carry it there.
            this.executedPromptWidget = this.addWidget("text", "executed_prompt", "", () => {}, { multiline: true, serialize: false });
            this.executedPromptWidget.hidden = true;
            this.executedPromptWidget.computeSize = () => [0, -4];

            // the executed-output tab disambiguator, delivered to Python's compose()
            // through the hidden `client_key` input. Re-stamped with THIS
            // page's key on every configure() too (see below): a saved
            // workflow carries whatever key the session that saved it
            // had, and two tabs opening that same file must not inherit
            // one shared address. Append-only rule: new hidden mirrors go
            // at the tail, so widgets_values stays positionally stable
            // for every workflow saved before this widget existed.
            this.clientKeyWidget = this.addWidget("text", "client_key", PC_CLIENT_KEY, () => {}, { multiline: false });
            this.clientKeyWidget.hidden = true;
            this.clientKeyWidget.computeSize = () => [0, -4];

            PC_NODES.add(this); // executed-output execution listeners find live nodes here
            probeC3EndpointOnce(); // first node on the page checks the server half
            primeC3Baseline(this); // THIS node adopts only outputs newer than its birth

            this.size = [560, 760];
            this.min_size = [MIN_PANEL_WIDTH, MIN_PANEL_HEIGHT];
            // Position/edge baselines, refreshed every frame, used by
            // onResize to detect which edge is being dragged and to hold
            // the anchored edge at the minimum (see the onResize note).
            this._pcLastPos0 = this.pos[0];
            this._pcLastPos1 = this.pos[1];
            this._pcPrevRight = this.pos[0] + this.size[0];
            this._pcPrevBottom = this.pos[1] + this.size[1];

            const applyNodeSize = () => {
                const width = Math.max(this.size[0], MIN_PANEL_WIDTH);
                if (this.size[0] < MIN_PANEL_WIDTH) this.size[0] = MIN_PANEL_WIDTH;
                if (this.size[1] < MIN_PANEL_HEIGHT) this.size[1] = MIN_PANEL_HEIGHT;

                const panelWidth = `${Math.round(width - NODE_CHROME_PADDING)}px`;
                if (ui.root.style.width !== panelWidth) {
                    ui.root.style.width = panelWidth;
                }
                const parent = ui.root.parentElement;
                if (parent && parent.style.width !== panelWidth) {
                    parent.style.width = panelWidth;
                }

                // Keep the baselines fresh even while idle, so a node MOVE
                // (which never fires onResize) can't leave them stale and
                // make the next resize misread its drag direction / anchor.
                this._pcLastPos0 = this.pos[0];
                this._pcLastPos1 = this.pos[1];
                this._pcPrevRight = this.pos[0] + this.size[0];
                this._pcPrevBottom = this.pos[1] + this.size[1];
            };

            let lastSeedValue = this.seedWidget ? this.seedWidget.value : undefined;
            const watchSeedForExternalChanges = () => {
                if (!this.seedWidget) return;
                if (this.seedWidget.value !== lastSeedValue) {
                    lastSeedValue = this.seedWidget.value;
                    if (this.composerUI) this.composerUI.preview.render();
                }
            };

            // Watch the user_prompt LINK. This watcher owns
            // ONLY the link dimension: while UNLINKED its signature is a
            // constant, so it never interferes with the textarea's own
            // render path (no double recompose per keystroke); while
            // LINKED the signature is the resolved upstream string, so
            // connecting, disconnecting, or the upstream value changing
            // (e.g. a linked composer re-renders) flips it and
            // recomposes. Same resolution rule as
            // ComposerUI.getUserPrompt, so the two can never disagree
            // about what the preview shows.
            let lastLinkedSig;
            const watchLinkedUserPrompt = () => {
                const input = this.inputs && this.inputs.find(
                    (i) => i && (i.name === "user_prompt" || i.local_name === "user_prompt"),
                );
                const isLinked = !!(input && input.link != null);
                if (!isLinked) {
                    // Never been linked -> stay fully asleep; was linked
                    // -> wake once to restore the widget-backed view.
                    if (lastLinkedSig === undefined) return;
                    if (lastLinkedSig === null) return; // already resting on widget view
                    lastLinkedSig = null;
                    if (this.composerUI) this.composerUI.preview.render();
                    return;
                }
                const value = resolveLinkedString(this) ?? "";
                if (value === lastLinkedSig) return;
                lastLinkedSig = value;
                if (this.composerUI) this.composerUI.preview.render();
            };

            const tick = () => {
                if (!this._pcDestroyed) {
                    applyNodeSize();
                    watchSeedForExternalChanges();
                    watchLinkedUserPrompt();
                    this._pcRafId = requestAnimationFrame(tick);
                }
            };
            this._pcRafId = requestAnimationFrame(tick);

            const onRemoved = this.onRemoved;
            this.onRemoved = function () {
                this._pcDestroyed = true;
                PC_NODES.delete(this); // stop WS fetches for a deleted node
                if (this._pcRafId) cancelAnimationFrame(this._pcRafId);
                if (this.composerUI && this.composerUI._resizeObserver) {
                    this.composerUI._resizeObserver.disconnect();
                }
                if (this.composerUI && this.composerUI._thumbPreview) {
                    this.composerUI._thumbPreview(); // drop thumb-preview listeners + node
                }
                if (onRemoved) onRemoved.apply(this, arguments);
            };

            // executed-output canonical trigger. The frontend calls onExecuted(detail)
            // DIRECTLY on the instance that just ran (the same hook that
            // refreshes image/preview tiles), so there is no node-id string
            // to match and no WS event-shape to guess -- which is exactly
            // what broke the previous "executed"-listener on this build. We
            // ignore the OUTPUT argument's contents (a STRING node's value
            // may not even be in it); we only use it as the "fetch now"
            // signal, then read the literal from the server stash. detail
            // is {node, display_node, prompt_id, output, ...} on modern
            // builds but historically just the output object, so prompt_id
            // is optional here too.
            const onExecuted = this.onExecuted;
            this.onExecuted = function (detail) {
                if (onExecuted) onExecuted.apply(this, arguments);
                if (this._pcDestroyed || !this.composerUI) return;
                const pid = detail && typeof detail.prompt_id === "string" && detail.prompt_id
                    ? detail.prompt_id
                    : "latest";
                console.info(`Prompt Composer C3: node ${this.id} onExecuted — fetching executed output`);
                this.composerUI.requestExecutedOutput(pid);
            };

            return result;
        };

        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            // LiteGraph clamps min_size against the node's SIZE but does not
            // pull its POSITION back. When you drag the LEFT edge inward it
            // advances pos[0] every frame while shrinking width; once width
            // reaches the minimum the size freezes but pos[0] keeps moving,
            // so the whole node slides right (same for the top edge sliding
            // down). By the time onResize runs, LiteGraph has ALREADY clamped
            // size to min_size, so "size < min" is never true here -- the
            // signal is instead "size is at the minimum AND LiteGraph moved
            // pos this frame". It only moves pos[0] for a left-edge drag and
            // pos[1] for a top-edge drag, so that tells us which edge is
            // being pulled; we then hold the opposite edge at the value it
            // had on the last un-clamped frame (_pcPrevRight/_pcPrevBottom),
            // which stops the slide exactly.
            const pos0 = this.pos[0];
            const pos1 = this.pos[1];
            const leftDrag = pos0 !== this._pcLastPos0;
            const topDrag = pos1 !== this._pcLastPos1;

            if (size[0] <= MIN_PANEL_WIDTH) {
                if (leftDrag) {
                    size[0] = MIN_PANEL_WIDTH;
                    this.pos[0] = this._pcPrevRight - MIN_PANEL_WIDTH;
                } else if (size[0] < MIN_PANEL_WIDTH) {
                    size[0] = MIN_PANEL_WIDTH;
                }
            }
            if (size[1] <= MIN_PANEL_HEIGHT) {
                if (topDrag) {
                    size[1] = MIN_PANEL_HEIGHT;
                    this.pos[1] = this._pcPrevBottom - MIN_PANEL_HEIGHT;
                } else if (size[1] < MIN_PANEL_HEIGHT) {
                    size[1] = MIN_PANEL_HEIGHT;
                }
            }

            this._pcLastPos0 = this.pos[0];
            this._pcLastPos1 = this.pos[1];
            this._pcPrevRight = this.pos[0] + this.size[0];
            this._pcPrevBottom = this.pos[1] + this.size[1];

            if (onResize) onResize.apply(this, arguments);
        };

        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            if (onSerialize) onSerialize.apply(this, arguments);
            if (this.composerUI) {
                // See stripTransientSectionFields's docstring: sections
                // carry live UI-runtime fields (a function among them)
                // that must never reach anything LiteGraph or the server
                // might clone.
                o.pc_state = stripTransientSectionFields(this.composerUI.state.sections);
                o.pc_preset_name = this.composerUI.state.presetName;
                o.pc_split = this.composerUI.splitFraction;
                o.pc_library_color = this.composerUI.libraryColor;
                // The composed string, as a named extra (tooling
                // reads extras by key; the placeholder path uses the
                // positional final_prompt widget instead -- both are kept).
                o.pc_final_prompt = this.composerUI._lastComposedPreview || "";
                // The self-contained payload (structure + resolved
                // content + final prompt) that lets this workflow be opened
                // where the library has none of its prompts. Wrapped in a
                // try: a snapshot failure must never block saving the node
                // itself, whose pc_state/widgets_values already stand alone.
                try {
                    o.pc_workflow_snapshot = this.composerUI.buildWorkflowSnapshot();
                } catch (err) {
                    console.error("Prompt Composer: snapshot build failed", err);
                }
            }
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (o) {
            if (onConfigure) onConfigure.apply(this, arguments);
            // LiteGraph has just applied widgets_values, which includes
            // whatever client_key the session that SAVED this workflow
            // used. Stamp this page's key back over it: the whole point
            // of the key is that two tabs -- even two tabs holding the
            // same saved file -- address different stash entries.
            if (this.clientKeyWidget) this.clientKeyWidget.value = PC_CLIENT_KEY;
            if (!this.composerUI) return;
            if (typeof o.pc_library_color === "string") {
                this.composerUI.libraryColor = o.pc_library_color;
            }
            if (typeof o.pc_split === "number") {
                this.composerUI.setSplitFraction(o.pc_split);
            }
            // Restore channels, best first:
            //  1. pc_state -- the extras written by our onSerialize
            //     (present whenever the workflow/PNG was saved through
            //     the graph serializer);
            //  2. the hidden composer_state widget -- generic LiteGraph
            //     configure has ALREADY applied widgets_values before
            //     this hook runs, so an older/cleaned workflow that lost
            //     the pc_* extras still restores from the widget the
            //     queue itself uses;
            //  3. the snapshot's preset.sections -- last-resort structure
            //     (the preset NAME rides with it).
            // The validated snapshot additionally supplies embedded prompt
            // CONTENT for refs this machine's library cannot resolve.
            const snapshot =
                o.pc_workflow_snapshot && o.pc_workflow_snapshot.schema === PC_SNAPSHOT_SCHEMA
                    ? o.pc_workflow_snapshot
                    : null;
            let sections = Array.isArray(o.pc_state) && o.pc_state.length ? o.pc_state : null;
            let presetName = o.pc_preset_name || null;
            if (!sections) sections = parseComposerWidget(this.composerStateWidget?.value);
            if (!sections && snapshot && Array.isArray(snapshot.preset?.sections) && snapshot.preset.sections.length) {
                sections = snapshot.preset.sections;
                if (!presetName) presetName = snapshot.preset.name || null;
            }
            if (sections) {
                this._pcRestoredFromGraph = true; // stops the afterConfigureGraph sweep double-hydrating
                this.composerUI.hydrateFromGraph(sections, presetName, snapshot);
            }
            // executed-output third channel: a graph save whose pc_* extras were
            // stripped still kept widgets_values, so the executed string
            // can survive there too. Only adopted when nothing richer
            // came through the snapshot (which carries seed/at as well).
            const execWidgetValue = this.executedPromptWidget && this.executedPromptWidget.value;
            // The sentinel decodes to an executed ""; a plain
            // "" stays what it always was -- a never-run node's default.
            const execWidgetPrompt = execWidgetValue === PC_EMPTY_EXECUTED_MARK
                ? ""
                : execWidgetValue;
            if (!this.composerUI._executed && typeof execWidgetPrompt === "string" && execWidgetPrompt) {
                this.composerUI.applyExecutedOutput({ prompt: execWidgetPrompt });
            }
        };
    },

    /**
     * The API-prompt load path (app.loadApiJson, e.g. dragging a PNG or
     * opening a *_workflow_api.json that carries no `workflow` field)
     * never calls onConfigure on known node types -- it creates the node
     * and pushes input values straight into the same-named widgets. The
     * hidden composer_state widget therefore ends up holding the right
     * JSON while state.sections stays the fresh-node default, i.e. a
     * node that QUEUES the saved prompt but displays nothing. Sweep for
     * those after any graph load and hydrate them through the same door
     * as the workflow path. Nodes already restored via onConfigure are
     * flagged, and a node with no saved state (widget still "[]") falls
     * out at the parse, so freshly added nodes and normal loads are
     * untouched.
     */
    afterConfigureGraph: () => {
        const graph = app.rootGraph ?? app.graph;
        if (!graph) return;
        const sweep = (g) => {
            for (const node of g._nodes ?? []) {
                if (node.composerUI && !node._pcRestoredFromGraph) {
                    const saved = needsGraphHydration(node.composerUI.state)
                        ? parseComposerWidget(node.composerStateWidget?.value)
                        : null;
                    if (saved) {
                        node._pcRestoredFromGraph = true;
                        // No pc_workflow_snapshot exists on this channel
                        // (API prompts carry no extras), but the
                        // workflow NAME is still known here -- pass it
                        // so the toolbar can name a virtual preset even
                        // when this node was dragged in as a PNG.
                        node.composerUI.hydrateFromGraph(saved, null, {
                            workflow_name: currentWorkflowName(),
                        });
                    }
                }
                if (node.isSubgraphNode?.() && node.subgraph) sweep(node.subgraph);
            }
        };
        sweep(graph);
    },
});
