/**
 * ui_preview.js
 *
 * Live assembled-prompt preview. Since Layer C2 the authoritative text
 * comes from the SERVER: when content it has not seen before is needed,
 * the render asks /prompt_composer/compose, which runs the node's very
 * own _resolve_entries_text + compose_prompt (library_store resolution
 * AND queue-time randomization with Python's RNG) -- the preview string
 * is then literally what compose() would emit at queue time. Fully
 * warm renders re-join locally without a request (the local
 * mirror -- kept unit-correct against the Python join -- is also the
 * degradation path when the server is unreachable; its only known
 * divergence is WHICH entry a randomized section picks, documented in
 * render()). Resolution goes through the identical
 * library_store.resolve_many() call as the queue, so the preview can
 * never show content the library does not hold; see
 * comfyUI_Prompt_composer.md's "Resolution" section for why
 * resolution lives server-side rather than frozen into
 * composer_state (Approach B).
 */

import {
    ENTRY_SEPARATOR_SUFFIX,
    normalizeEntrySeparator,
    END_SEPARATOR_SUFFIX,
    normalizeEndSeparator,
} from "./separators.js";
import { hashStringToIndex } from "./dom_utils.js";
import { usedPromptRefs, composeMemoKey } from "./workflow_restore.js";
import * as apiClient from "./api_client.js";

export class PreviewController {
    /**
     * @param {object} opts
     * @param {() => object} opts.getState - returns the live ComposerState
     * @param {() => number} opts.getSeed - returns the current seed widget value
     * @param {() => string} opts.getUserPrompt - returns the current user_prompt widget value
     * @param {HTMLTextAreaElement} opts.outputEl - where resolved preview text is written
     * @param {(text: string) => void} [opts.onComposed] - called with the
     *   exact text written to outputEl, on every completed render. The
     *   host uses it to mirror the composed string into the hidden
     *   final_prompt widget / workflow snapshot (Layers B1/C1) -- the
     *   write happens in an async continuation, so an event, not a
     *   poll, is the only place that sees the fresh value.
     */
    constructor({ getState, getSeed, getUserPrompt, outputEl, onComposed }) {
        this.getState = getState;
        this.getSeed = getSeed;
        this.getUserPrompt = getUserPrompt;
        this.outputEl = outputEl;
        this._onComposed = onComposed || null;
        this._cache = new Map(); // prompt_ref -> resolved entry (or null if unresolved)
        // ref -> {name, prompt, category} embedded in the loaded
        // workflow's pc_workflow_snapshot. Used ONLY where the live
        // library does not resolve a ref (see _contentFor): precedence is
        // live library > workflow copy > empty. Set wholesale per graph
        // load (empty map clears it), never mutated by edits.
        this._workflowContents = new Map();
        this._pending = false;
        this._dirty = false;
        this._renderToken = 0; // see render()'s staleness guard below
        // The server's authoritative answer for the last /compose it
        // ran: reused (no network) by a fully-warm render at the SAME
        // seed. Any input change that matters -- an uncached ref, a
        // library edit (invalidate -> refs uncached again), or a
        // different seed -- bypasses or re-answers it.
        this._lastCompose = null;
    }

    /**
     * Replace the embedded-workflow fallback wholesale (pass the
     * snapshot's `contents` object, a Map, or nothing to clear). Called
     * by the host right after a graph restore, BEFORE the first
     * preview render, so the very first paint already stands in for any
     * ref this machine's library cannot resolve.
     */
    setWorkflowContents(contents) {
        this._workflowContents = new Map();
        // The embedded map IS a /compose input (fallback_contents): any
        // authoritative answer taken under the previous workflow's copy
        // set must not be reused against this one.
        this._lastCompose = null;
        if (!contents) return;
        const rows = contents instanceof Map ? contents.entries() : Object.entries(contents);
        for (const [ref, content] of rows) {
            if (content && typeof content.prompt === "string" && content.prompt.trim()) {
                this._workflowContents.set(ref, {
                    name: content.name || "",
                    prompt: content.prompt,
                    category: Array.isArray(content.category) ? [...content.category] : [],
                });
            }
        }
    }

    /**
     * The single content read for a ref: server-resolved cache entry
     * when there is one, else the workflow's embedded copy, else null.
     * A cached `null` means the server CONFIRMED the ref is gone -- the
     * embedded copy then stands in; refs not fetched yet fall through
     * too (harmless: render() fetches every uncached ref in a batch,
     * and a later response overwrites nothing here -- the live library
     * always wins once it answers).
     */
    _contentFor(ref) {
        const live = this._cache.get(ref);
        if (live && typeof live.prompt === "string" && live.prompt.trim()) return live;
        return this._workflowContents.get(ref) || null;
    }

    /**
     * A ref -> {name, prompt, category} view of everything this preview
     * currently has content for. Feeds the workflow snapshot
     * (buildSnapshotPayload filters to the refs the sections actually
     * use). Live server resolutions come first; refs the library could
     * NOT resolve are contributed from the loaded workflow's embedded
     * copy -- which is what keeps a workflow re-saved on a machine
     * WITHOUT the prompts provenance-complete instead of quietly
     * shedding its contents on the second hop. Null cache entries with
     * no embedded stand-in are excluded; refs with no content anywhere
     * simply don't appear, so the snapshot is honest best-effort, never
     * fabricated.
     */
    getCachedContents() {
        const out = new Map();
        for (const [ref, entry] of this._cache) {
            if (entry && typeof entry.prompt === "string") {
                out.set(ref, {
                    name: entry.name || "",
                    prompt: entry.prompt,
                    category: Array.isArray(entry.category) ? [...entry.category] : [],
                });
            }
        }
        for (const [ref, content] of this._workflowContents) {
            if (!out.has(ref)) out.set(ref, { ...content, category: [...content.category] });
        }
        return out;
    }

    /** Drop cached resolutions (e.g. after a library create/edit/delete)
     * so the next render re-fetches fresh content. */
    invalidate(promptRefs) {
        if (!promptRefs) {
            this._cache.clear();
        } else {
            for (const ref of promptRefs) this._cache.delete(ref);
        }
        // Belt and braces: a library edit can change the answer even if
        // every ref happens to still be cached (e.g. an edit that
        // touched a DIFFERENT ref but shifted a UID collision). The next
        // render will re-run /compose for the invalidated refs anyway
        // (uncached gate), so this reset only closes the hole around a
        // seed-matching _lastCompose reuse.
        this._lastCompose = null;
    }

    /**
     * Mirrors _resolve_section_entries() in prompt_composer_node.py:
     *
     * - if section.randomize is on:
     *   - pool = entries with BOTH allow_random true AND visible true
     *   - if pool has >= 2, choose one (deterministically, via seed+section
     *     id hash -- NOT Math.random(), so typing in the user prompt
     *     field doesn't visibly re-roll the preview on every keystroke)
     *   - if pool has < 2, include whatever's there as-is
     *   - entries with allow_random false AND visible true are ALWAYS
     *     included in addition
     * - if section.randomize is off: every entry with visible true
     *
     * This still won't match Python's exact choice bit-for-bit (different
     * PRNGs), but stays stable across renders and only changes when the
     * seed or the section's own pool changes.
     */
    _resolvePreviewEntries(section) {
        if (section.randomize) {
            const pool = section.entries.filter((e) => e.allow_random && e.visible);
            const alwaysIncluded = section.entries.filter((e) => !e.allow_random && e.visible);
            if (pool.length >= 2) {
                const seedValue = Number(this.getSeed()) || 0;
                const index = hashStringToIndex(`${seedValue}:${section.id}`, pool.length);
                return [...alwaysIncluded, pool[index]];
            }
            return [...alwaysIncluded, ...pool];
        }
        return section.entries.filter((e) => e.visible);
    }

    /**
     * Recompute and write the preview text.
     *
     * C2 -- server-authoritative compose: whenever the render needs
     * prompt content it has NOT resolved before (uncached refs: an edit
     * that introduced a prompt, or any render after a library
     * invalidation), the batch goes to /compose instead of /resolve.
     * One call returns BOTH the live resolution map for every used ref
     * (cache refresh -- now including DISABLED sections, which the
     * Python resolver walks and the old JS-side fetch skipped, so the
     * save-side snapshot warms more broadly) AND the final prompt
     * STRING from the node's own compose pipeline: same resolver, same
     * join, same seeded RNG, same fallback map (composer_contents) --
     * i.e. exactly what queueing would emit. While the cache stays
     * fully warm nothing new is needed and renders re-join locally
     * with NO network, preserving the pre-C2 rhythm (the old code only
     * fetched for uncached refs too); additionally a fully warm render
     * whose COMPLETE input set (sections + seed + user prompt -- see
     * composeMemoKey) still matches the server's last answered compose
     * reuses that authoritative string verbatim. The one documented
     * approximation left is any such change on a warm randomized
     * section: the fresh pick shows the JS hash mirror until any ref
     * needs re-resolving. (The first live smoke caught a seed-only
     * memo key freezing the preview on the save-time prompt after
     * entry edits -- every input the server honors is in the key now.)
     *
     * Staleness guard: several UI actions can call render() in quick
     * succession (rapid clicking through entries, a fast seed change
     * right after a toggle, etc.), each kicking off its own network
     * round-trip via composePreview()/resolvePromptRefs(). Without
     * ordering, a slower *earlier* call's response could resolve after
     * a *later* call's and overwrite outputEl with stale text.
     * _renderToken is bumped at the start of every render() call; only
     * the call still holding the current token may write outputEl --
     * any continuation that resumes after a newer render() has started
     * returns silently, since that newer call will produce (or has
     * already produced) the up-to-date text.
     */
    async render() {
        const myToken = ++this._renderToken;
        const state = this.getState();
        const userPromptValue = this.getUserPrompt() || "";
        const seedValue = Number(this.getSeed()) || 0;

        const used = usedPromptRefs(state.sections);
        const uncached = [];
        for (const ref of used) {
            if (!this._cache.has(ref)) uncached.push(ref);
        }

        let composed = null;
        let memoKey = null;
        if (uncached.length > 0) {
            // Fresh content is needed anyway -- ask the AUTHORITY for
            // the whole string while we're on the wire.
            this._pending = true;
            // Computed on the SAME tick as the request below, from the
            // same values it serializes: this key describes exactly the
            // inputs the server answered for.
            memoKey = composeMemoKey(state.sections, seedValue, userPromptValue);
            try {
                const answer = await apiClient.composePreview({
                    sections: state.sections,
                    seed: seedValue,
                    userPrompt: userPromptValue,
                    // Exactly the map the node's composer_contents
                    // widget carries at queue time (live cache +
                    // embedded copies): same inputs, same answer.
                    fallbackContents: Object.fromEntries(this.getCachedContents()),
                });
                if (!answer || typeof answer.prompt !== "string") {
                    throw new Error((answer && answer.error) || "malformed /compose response");
                }
                if (myToken !== this._renderToken) return; // superseded
                // Cache-refresh replaces the old /resolve batch loop:
                // every USED ref gets its live answer (absent key =
                // library has nothing; _contentFor then stands in with
                // the workflow copy, exactly like the Python fallback
                // rule did server-side).
                const resolved = answer.resolved || {};
                for (const ref of used) {
                    this._cache.set(ref, resolved[ref] || null);
                }
                composed = answer.prompt;
                this._lastCompose = { key: memoKey, prompt: answer.prompt };
            } catch (err) {
                console.error("Prompt Composer: server compose failed, falling back to /resolve", err);
                // Degrade to the pre-C2 rhythm: warm the cache via
                // /resolve and mirror the join locally -- best-effort,
                // byte-same for plain sections, approximate for
                // randomization picks (JS hash != Python RNG).
                try {
                    const resolved = await apiClient.resolvePromptRefs(uncached);
                    if (myToken !== this._renderToken) return;
                    for (const ref of uncached) {
                        this._cache.set(ref, resolved[ref] || null);
                    }
                } catch (err2) {
                    console.error("Prompt Composer: failed to resolve preview entries", err2);
                    // Leave unresolved refs uncached so a later render retries.
                }
            } finally {
                this._pending = false;
            }
        } else {
            // Fully warm cache: the server WOULD answer the same string
            // iff every join input still matches its last answer -- not
            // just the seed (a seed-only key kept showing the
            // save-time prompt after entry edits: smoke feedback #3).
            memoKey = composeMemoKey(state.sections, seedValue, userPromptValue);
            if (this._lastCompose && this._lastCompose.key === memoKey) {
                composed = this._lastCompose.prompt;
            }
        }

        if (composed === null) {
            composed = this._composeLocally(state, userPromptValue);
        }
        if (myToken !== this._renderToken) return; // superseded
        this.outputEl.value = composed;
        if (this._onComposed) {
            // Mirror only when this render still owns the output (every
            // async continuation above returns early for stale renders).
            try {
                this._onComposed(composed);
            } catch (err) {
                console.error("Prompt Composer: onComposed mirror failed", err);
            }
        }
    }

    /**
     * The local mirror of compose_prompt() -- synchronous, and always
     * run against an already-warm cache: every network branch in
     * render() populated it first, and a FAILED fetch leaves refs
     * uncached, which resolve to empty slots here -- mirroring the
     * server's own "missing -> empty" rule. Kept unit-correct against
     * the Python join (see the verify_*.mjs suites); the ONLY
     * documented divergence is which entry a randomized section picks.
     */
    _composeLocally(state, userPromptValue) {
        const blocks = [];
        for (const section of state.sections) {
            if (!section.enabled) continue;

            if (section.is_locked_prompt) {
                if (userPromptValue.trim()) blocks.push(userPromptValue.trim());
                continue;
            }

            const chosen = this._resolvePreviewEntries(section);
            if (chosen.length === 0) continue;

            const parts = chosen
                .map((entry) => {
                    const resolved = this._contentFor(entry.prompt_ref);
                    const text = (resolved?.prompt || "").trim();
                    if (!text) return "";
                    return text + ENTRY_SEPARATOR_SUFFIX[normalizeEntrySeparator(entry.entry_separator)];
                })
                .filter(Boolean);
            if (parts.length === 0) continue;

            let combined = parts.join(" ");
            if (section.show_label && section.name) {
                combined = `${section.name}: ${combined}`;
            }
            const endChar = END_SEPARATOR_SUFFIX[normalizeEndSeparator(section.end_separator)] || "";
            if (endChar) {
                if (combined.endsWith(",")) {
                    combined = combined.slice(0, -1);
                } else if (combined.endsWith(" and")) {
                    combined = combined.slice(0, -4);
                }
                combined += endChar;
            }
            blocks.push(combined);
        }

        return blocks.join(" ");
    }
}
