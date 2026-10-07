/**
 * workflow_restore.js
 *
 * Pure helpers behind restoring Prompt Composer state from a loaded
 * workflow (.json file or PNG-embedded), extracted so
 * tests/verify_workflow_restore.mjs can run them under bare Node --
 * same "keep the decision logic DOM-free and testable" seam as
 * library_sync.js.
 *
 * The race these exist to fix: LiteGraph's graph load is synchronous --
 * onNodeCreated builds the ComposerUI (whose PresetToolbar immediately fires an ASYNC
 * GET /presets), then node.configure() applies the workflow's pc_state.
 * The fetch lands afterwards and PresetToolbar's "first refresh, nothing
 * selected yet -> load preset #1" auto-load replaced the just-restored
 * composition with whatever Preset_001 happens to hold on disk. The
 * toolbar now asks noteWorkflowRestored() first (prompt_composer.js
 * onConfigure / afterConfigureGraph), which consumes the auto-load via
 * the reconcile in refreshList(); shapePresetSectionsForBaseline() is
 * what lets the Save button's dirty baseline compare against the DISK
 * copy of the restored preset without actually reloading (and clobbering)
 * the workflow's state.
 */

/**
 * Parse a hidden `composer_state` widget value into a sections array.
 * Returns null when the value is absent, unparseable, not an array, or
 * empty -- empty is treated as "nothing to restore" because the live
 * state can never serialize to `[]` (the locked "Prompt" section always
 * exists), so an empty array is either a fresh node's default or a
 * corrupt write, never a real composition.
 */
export function parseComposerWidget(raw) {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let value;
    try {
        value = JSON.parse(trimmed);
    } catch {
        return null;
    }
    if (!Array.isArray(value) || value.length === 0) return null;
    return value;
}

/**
 * Reshape a disk preset's sections the way ComposerState.loadFromPreset()
 * would lay them out ON the live state -- without mutating anything.
 *
 * Why this exists instead of fingerprinting the raw file: loadFromPreset
 * keeps the node's OWN locked "Prompt" section object (only adopting the
 * preset's order for it) and sorts `[locked, ...others]` by order. The
 * locked section the client constructs has a different default colour
 * than whatever a preset stores for it, so comparing the live
 * composition against the raw file would read every freshly-loaded preset
 * as modified -- the exact bug _markSaved()'s comment in
 * ui_toolbars.js warns about. Mirroring the reshaping here lets the
 * toolbar baseline a workflow-restored composition against disk without
 * reloading the preset over it.
 *
 * Must stay in lockstep with ComposerState.loadFromPreset():
 *   - imported preset HAS a locked section  -> live locked's order
 *     becomes the preset's (?? 0);
 *   - imported preset has NO locked section -> live locked's order is
 *     left as-is;
 *   - non-locked sections come from the preset, array sorted by order.
 */
export function shapePresetSectionsForBaseline(presetSections, liveSections) {
    const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
    const preset = Array.isArray(presetSections) ? presetSections : [];
    const live = Array.isArray(liveSections) ? liveSections : [];
    const locked = live.find((s) => s.is_locked_prompt);
    const importedLocked = preset.find((s) => s.is_locked_prompt);
    const others = preset.filter((s) => !s.is_locked_prompt);
    if (!locked) return [...preset].sort(byOrder);
    const lockedCopy = {
        ...locked,
        order: importedLocked ? importedLocked.order ?? 0 : locked.order,
    };
    return [lockedCopy, ...others].sort(byOrder);
}

/**
 * Whether a ComposerUI state still looks like the fresh-node default --
 * i.e. whether it is OK to hydrate from a secondary restore channel
 * (the afterConfigureGraph sweep for API-prompt loads) without
 * clobbering something real. True only while there are no custom
 * sections AND no preset name: once a preset was loaded, renamed, or
 * restored by name, the composition is "owned" and the sweep must keep
 * its hands off it even if the graph load that produced it hasn't
 * finished settling.
 */
export function needsGraphHydration(state) {
    if (!state || !Array.isArray(state.sections)) return false;
    const hasCustomSection = state.sections.some((s) => !s.is_locked_prompt);
    return !hasCustomSection && state.presetName == null;
}

/**
 * Version of the `pc_workflow_snapshot` payload. Bump on any breaking
 * shape change; readers must ignore unknown versions rather than guess.
 */
export const PC_SNAPSHOT_SCHEMA = 1;

/** Every distinct prompt_ref used by ANY section's entries, including
 * disabled sections: a workflow saved with a section switched off should
 * still carry its content, because re-enabling after a load is one edit
 * away. Unresolvable refs simply never appear in the contents map. */
export function usedPromptRefs(sections) {
    const refs = new Set();
    for (const section of Array.isArray(sections) ? sections : []) {
        for (const entry of section && Array.isArray(section.entries) ? section.entries : []) {
            if (entry && entry.prompt_ref) refs.add(entry.prompt_ref);
        }
    }
    return refs;
}

/**
 * Turn one `pc_workflow_snapshot.contents` row into the same shape the
 * `/resolve` route hands back, so the grid/list card builders treat a
 * workflow-carried prompt exactly like a live library hit -- except for
 * the `from_workflow` marker (badge) and `has_thumbnail:false` (there is
 * no PNG on this machine to point <img> at, so the card shows the
 * image-off tile instead of a broken request).
 *
 * Returns null for a content row with no usable prompt text.
 */
export function contentToDisplay(ref, content) {
    if (!content || typeof content.prompt !== "string" || !content.prompt.trim()) return null;
    const underscore = typeof ref === "string" ? ref.lastIndexOf("_") : -1;
    return {
        name: content.name || (underscore > 0 ? ref.slice(0, underscore) : ref || ""),
        prompt: content.prompt,
        category: Array.isArray(content.category) ? [...content.category] : [],
        has_thumbnail: false,
        from_workflow: true,
        filename: null,
        uid: null,
        prompt_ref: ref,
    };
}

/**
 * Merge a server resolve map with the workflow's embedded contents.
 * PRECEDENCE IS: live library > workflow copy > empty. A ref the server
 * resolved is left byte-for-byte as-is; a ref it did NOT return (null in
 * the map = "gone", absent = "never answered") is filled from the
 * embedded copy. So on a machine that HAS the prompt, the live version
 * wins and the embedded copy is invisible; only where the prompt is
 * missing does the snapshot content stand in.
 *
 * `resolved` is the object from tryResolveForDisplay ({} on a total
 * network failure -- in which case every embedded ref stands in, which is
 * the honest best-effort for display). `contents` accepts the snapshot's
 * plain object or a Map.
 */
export function mergeWorkflowContent(resolved, contents) {
    const out = { ...(resolved || {}) };
    if (!contents) return out;
    const rows =
        contents instanceof Map ? contents.entries() : Object.entries(contents);
    for (const [ref, content] of rows) {
        const live = out[ref];
        if (live && typeof live.prompt === "string" && live.prompt.trim()) continue; // live wins
        const display = contentToDisplay(ref, content);
        if (display) out[ref] = display;
    }
    return out;
}

/**
 * Decision core for re-creating a missing prompt: given a dead ref and the loaded workflow's
 * embedded contents (object or Map), return {name, prompt, category} to
 * re-create the prompt under -- or null when there is no usable copy.
 * The name falls back to the ref's encoded stem (same rule as
 * contentToDisplay) so a copy that recorded an empty name still
 * restores sensibly. Deliberately NOT aimed at "reproduce the old ref":
 * the server's own collision/UID rules decide the final identity, and
 * the caller re-points the entry at whatever was created.
 */
export function restorePlanFor(ref, contents) {
    if (!ref || !contents) return null;
    const raw = contents instanceof Map ? contents.get(ref) : contents[ref];
    const display = contentToDisplay(ref, raw);
    if (!display) return null;
    return { name: display.name, prompt: display.prompt, category: display.category };
}

/**
 * Identity of a server /compose answer for the preview's reuse memo
 * The answer depends on EVERYTHING the join reads -- the
 * section structure, the seed, and the user prompt -- so the memo key
 * must too. (A seed-only key would freeze the preview: any edit on a
 * fully warm cache would keep showing the old server string.) The embedded fallback contents deliberately stay OUT
 * of the key: they only ever change via setWorkflowContents()/a new
 * node load, and those paths void the memo directly.
 */
export function composeMemoKey(sections, seed, userPrompt) {
    return JSON.stringify([sections || [], Number(seed) || 0, userPrompt || ""]);
}

/**
 * the executed-output cross-graph hygiene (pure, headless-tested): decide whether a
 * node instance may adopt one `/c3_status` entry. The stash is
 * process-wide but node ids restart from 1 in every new workflow, so a
 * fresh node must NOT grab an old run recorded under its id. A record is
 * adoptable only when it belongs to this node, is NEWER than the node's
 * birth timestamp, and has not already been consumed. Server-generated
 * `at` on both sides, so no client-clock skew. Returns the record or null.
 */
export function shouldAdoptExecuted(entry, { nodeId, baselineAt, adoptedAt, clientKey }) {
    if (!entry || entry.prompt == null || typeof entry.at !== "number") return null;
    if (String(entry.node_id) !== String(nodeId)) return null;
    // Node id alone is ambiguous ACROSS TABS -- ids restart at 1 in
    // every workflow, so two tabs running two graphs both record under
    // "1". When the record carries a client_key (the page that produced
    // it) it must be OURS. A record without one came from a client that
    // sent none: fall back to the id-only rule so such records are
    // still adopted.
    if (clientKey && entry.client_key && String(entry.client_key) !== String(clientKey)) return null;
    // baselineAt === null means "not primed yet" -> adopt nothing (the
    // poller baselines first; event fast paths never consult this).
    if (baselineAt == null) return null;
    if (entry.at <= baselineAt) return null;   // predates this instance
    if (adoptedAt === entry.at) return null;    // already consumed
    return entry;
}

/**
 * Round-10 companion to shouldAdoptExecuted. A workflow that LOADS with
 * an embedded executed record carries a timestamp (E.at) of a run that
 * really happened ON THIS MACHINE (it was adopted from this machine's
 * stash at save time) -- but the embedded value itself can be one save
 * cycle stale, because ComfyUI bakes the queue-time graph (including our
 * extras) into the PNG BEFORE that run's compose produces the newer
 * string. So for nodes that have such history, the birth baseline is
 * lowered to E.at: the poller may then adopt any stash record strictly
 * NEWER than the embedded one (catching up to the true latest run, and
 * healing the stale embed on the next save), while brand-new nodes
 * (no history, no timestamp) keep the full round-8 protection against
 * id-reuse from unrelated graphs. Returns the baseline to use.
 */
export function baselineAfterHistoryLoad(baselineAt, snapshotAt) {
    if (typeof snapshotAt !== "number" || !Number.isFinite(snapshotAt)) return baselineAt;
    if (baselineAt == null) return snapshotAt;
    return Math.min(baselineAt, snapshotAt);
}

/**
 * The `user_prompt` string-input connector: at
 * QUEUE time ComfyUI ignores the widget and feeds the node whatever the
 * linked upstream produces -- so while the link exists, the preview must
 * show that upstream string, not the local textarea. This resolver is
 * the client-side mirror of that rule (pure LiteGraph duck-typing, so
 * it headless-tests): returns the best-known upstream value, or null to
 * mean "no link / cannot resolve -> fall back to the widget", which is
 * exactly what the queue will use too when unlinked.
 *
 * Resolution order (most authoritative first):
 *  1. an upstream PromptComposer -- its _lastComposedPreview is the
 *     SERVER's own answer for what it will emit (the single source of truth), with the
 *     final_prompt widget as the fallback for not-yet-rendered nodes;
 *  2. any STRING-typed source slot whose node exposes a non-empty string
 *     widget (PrimitiveString, ShowText-style nodes all follow this);
 *  3. null -- never guess from non-STRING slots.
 */
export function resolveLinkedString(node, inputName = "user_prompt") {
    if (!node || !Array.isArray(node.inputs) || !node.graph) return null;
    const input = node.inputs.find(
        (i) => i && (i.name === inputName || i.local_name === inputName),
    );
    if (!input || input.link == null) return null;
    const link = (node.graph.links && node.graph.links[input.link])
        || (typeof node.graph.getLink === "function" ? node.graph.getLink(input.link) : null);
    if (!link || link.origin_id == null) return null;
    const src = typeof node.graph.getNodeById === "function"
        ? node.graph.getNodeById(link.origin_id)
        : null;
    if (!src) return null;
    if (src.composerUI) {
        return src.composerUI._lastComposedPreview
            || (src.finalPromptWidget && src.finalPromptWidget.value)
            || "";
    }
    const slotType = (src.outputs && src.outputs[link.origin_slot] && src.outputs[link.origin_slot].type)
        || link.type;
    if (String(slotType || "").toUpperCase() === "STRING" && Array.isArray(src.widgets)) {
        for (const w of src.widgets) {
            if (w && typeof w.value === "string" && w.value) return w.value;
        }
    }
    return null;
}

/**
 * the executed-output presentation logic (pure, so the rules are testable without
 * DOM/WS). The single "as generated" chip became TWO
 * independent, action-bearing chips, each visible ONLY while its own
 * difference exists:
 *
 *  - `edited`: current composition != executed string -> click copies
 *    the executed prompt (provenance first: "this is what actually
 *    ran", reachable exactly when the screen no longer shows it).
 *  - `resetSeed`: current seed != executed seed -> click writes the
 *    executed seed back into the widget (reproduce the run that made
 *    the image, even after "control after generate" bumped it).
 *  - `error`: the node ran but the chain could
 *    not deliver the record; visible so nothing fails silently.
 *
 * A record always outranks an older error; no record and no error means
 * nothing shows (node never ran -- never imply otherwise). `at`
 * (seconds, server clock) renders into the tooltips as the human
 * "when"; it is optional, so widget-only restored records simply omit
 * it, and seedless records hide resetSeed (cannot reset to unknown).
 * `catchingUp`: relabels visible drift chips "Checking..."
 * while the node waits for its first post-load verdict on possibly
 * queue-time-stale embedded data; labels settle by themselves.
 */
export function executedChipStates(executed, currentComposed, currentSeed, error = null, catchingUp = false) {
    const states = { edited: null, resetSeed: null, error: null };
    // An empty executed string is a REAL record (the node ran
    // and emitted nothing) -- it takes part in the honest compare below
    // instead of hiding every chip. Only a missing record (never ran /
    // never adopted) is "nothing to say".
    if (!executed || typeof executed.prompt !== "string") {
        if (error) {
            states.error = {
                label: "as generated: unavailable",
                tooltip:
                    "This node finished a run but its executed output could not " +
                    "be fetched:\n" + String(error) +
                    "\n\nMost likely the ComfyUI SERVER process is still running " +
                    "old Python code: the /last_output + /c3_status routes and the " +
                    "UNIQUE_ID injection are server-side. Fully restart ComfyUI " +
                    "(not just a page refresh) after copying the new files, then " +
                    "hard-refresh the browser (Ctrl+F5) for the JS half.",
            };
        }
        return states;
    }
    const execSeed = Number(executed.seed);
    const hasExecSeed =
        executed.seed !== null && executed.seed !== undefined && Number.isFinite(execSeed);
    const bits = [];
    if (hasExecSeed) bits.push(`seed ${execSeed}`);
    if (typeof executed.at === "number" && Number.isFinite(executed.at)) {
        try {
            bits.push(`ran ${new Date(executed.at * 1000).toLocaleString()}`);
        } catch {
            /* exotic locale/DOM environments: omit the when-part */
        }
    }
    const when = bits.length ? ` (${bits.join(", ")})` : "";
    if ((currentComposed || "") !== executed.prompt) {
        states.edited = {
            label: "Edited",
            text: executed.prompt,
            tooltip:
                "The composition has changed since this node last ran" + when +
                ". The executed string that produced the current output:\n\n" +
                // An empty executed string would render as an
                // empty tooltip block; say what it is. (The COPY action
                // still hands out the real "" via `text`.)
                (executed.prompt === "" ? "(empty)" : executed.prompt) +
                "\n\nClick to copy it, or hold 1s to accept the current" +
                " composition as what ran.",
        };
    }
    const curNum = Number(currentSeed);
    const hasCurSeed =
        currentSeed !== null && currentSeed !== undefined && currentSeed !== "" && Number.isFinite(curNum);
    if (hasExecSeed && (!hasCurSeed || curNum !== execSeed)) {
        states.resetSeed = {
            seed: execSeed,
            label: "Reset Seed",
            tooltip:
                (hasCurSeed
                    ? `The seed is now ${curNum}, but the last run used ${execSeed}.`
                    : `The last run used seed ${execSeed}.`) +
                "\n\nClick to restore it, or hold 1s to accept the current" +
                " seed as what ran.",
        };
    }
    if (catchingUp) {
        // While the round-10 catch-up probe is still pending,
        // a difference chip derived from a QUEUE-TIME-BAKED embed may be
        // asserting the previous run's value. The chip and its action
        // stay (the embedded data is still the best available until the
        // poll lands), but the label tells the truth about its status.
        if (states.edited) {
            states.edited.label = "Checking...";
            states.edited.tooltip =
                "Checking this machine for a newer run record — the string " +
                "below was embedded at queue time and may be one run behind.\n\n" +
                states.edited.tooltip;
        }
        if (states.resetSeed) {
            states.resetSeed.label = "Checking...";
            states.resetSeed.tooltip =
                "Checking this machine for a newer run record — this seed " +
                "comes from the embedded (possibly stale) record.\n\n" +
                states.resetSeed.tooltip;
        }
    }
    return states;
}

/**
 * Assemble the self-contained `pc_workflow_snapshot` a workflow carries
 * so it can be opened on a machine WITHOUT the prompts it references
 * (the "write side" of workflow restore).
 *
 * `contents` is the PreviewController cache view (ref -> {name, prompt,
 * category}) -- a superset spanning everything ever resolved. Only refs
 * actually used by the sections are kept. If the total exceeds
 * `maxContentsChars`, the CHEAPEST entries are kept and `truncated` is
 * set, because the payload's job is provenance: partial content beats
 * none, and `final_prompt` (always kept, uncapped) carries the complete
 * assembled string even when some individual texts are dropped.
 *
 * `preset.sections` intentionally duplicates `pc_state`: the snapshot is
 * designed to stand alone, independent of pc_state.
 */
export function buildSnapshotPayload({
    schema = PC_SNAPSHOT_SCHEMA,
    nowIso = "",
    workflowName = null,
    presetName = null,
    sections = [],
    contents = new Map(),
    finalPrompt = "",
    seed = 0,
    userPrompt = "",
    executed = null,
    maxContentsChars = Number.POSITIVE_INFINITY,
} = {}) {
    const used = usedPromptRefs(sections);
    const candidates = [];
    for (const [ref, entry] of contents) {
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
    let truncated = false;
    for (const { ref, entry, cost } of candidates) {
        if (bytes + cost > maxContentsChars) {
            truncated = true;
            continue;
        }
        collected[ref] = {
            name: entry.name || "",
            prompt: entry.prompt,
            category: Array.isArray(entry.category) ? [...entry.category] : [],
        };
        bytes += cost;
    }
    return {
        schema,
        workflow_name: workflowName || null,
        captured_at: nowIso || null,
        preset: { name: presetName || null, sections },
        contents: collected,
        final_prompt: finalPrompt || "",
        seed,
        user_prompt: userPrompt || "",
        truncated,
        // The LITERAL executed string from the node's last
        // queued run (fetched from the server's stash), when there was
        // one since the last clear. Additive on schema 1: readers must
        // treat these keys as optional. final_prompt above stays "what
        // the current state would compose" -- this is "what actually
        // ran", and the two can legitimately differ after edits.
        // "" is baked too (an empty run IS a record); only a
        // never-run node omits the keys.
        ...(executed && typeof executed.prompt === "string"
            ? {
                  executed_prompt: executed.prompt,
                  executed_seed: Number.isFinite(Number(executed.seed))
                      ? Number(executed.seed)
                      : null,
                  executed_at: executed.at || null,
              }
            : {}),
    };
}
