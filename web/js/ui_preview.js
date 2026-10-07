/**
 * ui_preview.js
 *
 * Live assembled-prompt preview. The authoritative text
 * comes from the SERVER: when content it has not seen before is needed,
 * the render asks /prompt_composer/compose, which runs the node's very
 * own _resolve_entries_text + compose_prompt (library_store resolution
 * AND queue-time randomization with Python's RNG) -- the preview string
 * is then literally what compose() would emit at queue time. Fully
 * warm renders re-join locally without a request, EXCEPT whenever
 * _hasUnconfirmedRandomPool() finds an enabled, randomized section with
 * a real (2+) pool to pick from: Python's random.Random() and the
 * local mirror's hashStringToIndex() are different PRNGs that can (and
 * demonstrably do) choose different pool entries, so ANY render
 * touching such a section always asks the server for the authoritative
 * pick -- never trusting a locally-mirrored guess for it, and never
 * treating one past server answer as good forever after (a later
 * render with the exact same inputs re-confirms too; see
 * _scheduleAuthoritativeRecompose). The request is debounced
 * (RANDOM_POOL_DEBOUNCE_MS) so rapid edits -- typing in user_prompt,
 * dragging entries -- coalesce into one round-trip instead of one per
 * keystroke; the instant, un-debounced local mirror is still shown the
 * moment something changes so the preview never looks frozen while
 * that request is in flight, and is silently replaced by the server's
 * real answer as soon as it lands. Resolution goes through the
 * identical library_store.resolve_many() call as the queue, so the
 * preview can never show content the library does not hold. Resolution
 * lives server-side rather than being frozen into composer_state.
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

// How long to wait after the LAST render() call before firing the
// debounced server round-trip a randomized section needs (see the
// class docstring and _scheduleAuthoritativeRecompose). Short enough
// that the correction feels immediate to a human -- nobody perceives a
// sub-quarter-second delay as "the preview is wrong" -- but long
// enough that a burst of keystrokes or rapid entry clicks coalesces
// into a single request instead of one per event.
const RANDOM_POOL_DEBOUNCE_MS = 200;

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
     *   final_prompt widget / workflow snapshot -- the
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
        // The server's own record of which entry id(s) each randomized
        // section actually used to build _lastCompose.prompt (see
        // compose_prompt's chosen_out / the /compose route's "chosen"
        // field). Tagged with the exact seed it was confirmed under
        // (not folded into _lastCompose's memoKey, since a NON-random
        // edit -- e.g. typing in an unrelated section -- changes the
        // memo key but must NOT invalidate a still-correct randomize
        // pick for an untouched section). getSectionBlocks() prefers
        // this over its own hashStringToIndex() guess for any section
        // this map covers, which is what keeps the colorized overlay
        // (built by re-calling getSectionBlocks independently -- see
        // ComposerUI._renderColorizedPreview) from re-rolling a
        // DIFFERENT pick than the plain text is already showing.
        this._lastChosen = null;
        this._lastChosenSeed = null;
        // Debounce state for the randomized-section server round-trip
        // (see _scheduleAuthoritativeRecompose). A pending timer from
        // an EARLIER render is always cleared before a later one's is
        // set, so only the most recent render's inputs are ever the
        // ones actually sent -- an intermediate keystroke's state is
        // never fetched only to be immediately superseded.
        this._randomPoolDebounceTimer = null;
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
                // Prefer the SERVER's own record of which pool entry it
                // actually picked (see _lastChosen's own comment in the
                // constructor) over re-rolling a local guess -- this is
                // what keeps two independent callers of
                // getSectionBlocks (the plain preview text and the
                // colorized overlay; see ComposerUI._renderColorizedPreview)
                // from ever disagreeing with each other, since a local
                // hash re-roll on every call could hand each of them a
                // DIFFERENT pool entry even though both are describing
                // the exact same seed/state at the exact same instant.
                //
                // Only trusted when ALL of: (a) it was confirmed for
                // THIS exact seed -- a seed change invalidates it
                // immediately, before the debounced re-confirmation
                // even lands, so the local guess is what's shown in the
                // interim (see render()'s own docstring: this is a
                // known, intentional placeholder state); (b) this
                // SPECIFIC section is one the server actually reported
                // a pick for; (c) that recorded entry id is still
                // actually present in the CURRENT pool -- a pool that
                // changed shape since (an entry added/removed, or its
                // allow_random/visible flags flipped) makes the old
                // pick meaningless, and re-rolling locally is the
                // correct fallback exactly as it always was before
                // _lastChosen existed.
                if (this._lastChosenSeed === seedValue && this._lastChosen
                        && Object.prototype.hasOwnProperty.call(this._lastChosen, section.id)) {
                    const chosenIds = this._lastChosen[section.id] || [];
                    const randomPickId = chosenIds.find(
                        (id) => pool.some((e) => e.id === id)
                    );
                    if (randomPickId != null) {
                        const picked = pool.find((e) => e.id === randomPickId);
                        if (picked) return [...alwaysIncluded, picked];
                    }
                }
                const index = hashStringToIndex(`${seedValue}:${section.id}`, pool.length);
                return [...alwaysIncluded, pool[index]];
            }
            return [...alwaysIncluded, ...pool];
        }
        return section.entries.filter((e) => e.visible);
    }

    /**
     * True when at least one ENABLED section is set to randomize AND
     * has a pool (allow_random && visible entries) of 2 or more --
     * i.e. a section where Python's compose_prompt() will make a real,
     * seeded random.Random() pick rather than trivially including the
     * pool's only member.
     *
     * render() uses this to decide whether ANY locally-mirrored answer
     * for this section can ever be trusted as final. It normally can
     * be (see the class docstring) -- except for exactly this case:
     * _composeLocally() mirrors the pick with hashStringToIndex(), a
     * DIFFERENT PRNG from Python's random.Random(), which the class
     * docstring already documents as capable of diverging. So whenever
     * this is true, render() shows the local guess only as an INSTANT,
     * frankly-provisional placeholder, and always follows up with a
     * debounced, unconditional server round-trip (see
     * _scheduleAuthoritativeRecompose) to get -- and display -- the
     * real answer, regardless of whether an identical-looking request
     * already got one before.
     */
    _hasUnconfirmedRandomPool(state) {
        for (const section of state.sections) {
            if (!section.enabled || !section.randomize) continue;
            const poolSize = section.entries.filter((e) => e.allow_random && e.visible).length;
            if (poolSize >= 2) return true;
        }
        return false;
    }

    /**
     * Recompute and write the preview text.
     *
     * Two-phase per render:
     *
     * 1. INSTANT, always synchronous-feeling: uses the network only
     *    when genuinely new content needs resolving (an uncached ref --
     *    an edit that introduced a prompt, or any render after a
     *    library invalidation), via /prompt_composer/compose so that
     *    round-trip's answer is fully authoritative already. Otherwise
     *    joins locally with NO network at all, so plain edits (text
     *    that doesn't touch a randomized section) stay exactly as
     *    responsive as before this feature existed.
     *
     *    Anti-flicker exception: when this phase would otherwise fall
     *    back to a FRESH _composeLocally() guess for a randomized
     *    section (typically: the seed just changed, so neither the
     *    cache nor the memo has an answer for it yet) AND something is
     *    already on screen, the fresh guess is skipped entirely and the
     *    PREVIOUS text is left in place instead. A fresh local guess is
     *    frequently a DIFFERENT pool entry than the debounced server
     *    confirmation about to replace it a fraction of a second later
     *    -- showing it anyway produced a visible flash between two
     *    different prompts on every seed change (old -> wrong guess ->
     *    real answer) instead of one clean transition (old -> real
     *    answer). The very first render of a fresh node has nothing to
     *    hold onto, so that one still shows the local guess.
     *
     * 2. AUTHORITATIVE FOLLOW-UP, debounced: whenever
     *    _hasUnconfirmedRandomPool() finds an enabled, randomized
     *    section with a real pool, phase 1's answer for that section is
     *    NEVER treated as final -- even if it happened to come from the
     *    server a moment ago for what looks like the same inputs.
     *    _scheduleAuthoritativeRecompose() queues one more /compose
     *    call, debounced by RANDOM_POOL_DEBOUNCE_MS so a burst of
     *    keystrokes/drags collapses into a single request, and
     *    overwrites the preview the instant that call resolves. This
     *    is what guarantees the preview converges on the SAME entry
     *    the queued run will actually output, rather than the two
     *    PRNGs' guesses silently disagreeing (an "ask once, then trust the
     *    memo forever" design could still show a stale local guess after
     *    control_after_generate rolled the seed, a section's randomize
     *    toggle flipped, or any other change that didn't happen to
     *    introduce a fresh ref). The server's answer also carries
     *    "chosen" (see compose_prompt's chosen_out / the /compose
     *    route), recorded into _lastChosen/_lastChosenSeed so
     *    _resolvePreviewEntries() can make EVERY caller of
     *    getSectionBlocks() -- the plain text here, and the colorized
     *    overlay's own independent call (see
     *    ComposerUI._renderColorizedPreview) -- agree on the exact same
     *    entry instead of each re-rolling its own guess.
     *
     * Staleness guard: several UI actions can call render() in quick
     * succession (rapid clicking through entries, a fast seed change
     * right after a toggle, etc.), each potentially kicking off its own
     * network round-trip. Without ordering, a slower *earlier* call's
     * response could resolve after a *later* call's and overwrite
     * outputEl with stale text. _renderToken is bumped at the start of
     * every render() call; only the call still holding the current
     * token may write outputEl -- any continuation (phase 1's fetch,
     * or phase 2's debounced follow-up) that resumes after a newer
     * render() has started returns silently, since that newer call
     * will produce (or has already produced, or will itself schedule)
     * the up-to-date text.
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

        const memoKeyNow = composeMemoKey(state.sections, seedValue, userPromptValue);
        const memoAlreadyCovers = this._lastCompose && this._lastCompose.key === memoKeyNow;
        const hasRandomPool = this._hasUnconfirmedRandomPool(state);

        let composed = null;
        let memoKey = null;
        if (uncached.length > 0) {
            // Fresh content is needed anyway -- ask the AUTHORITY for
            // the whole string while we're on the wire. This answer is
            // authoritative for THIS render regardless of hasRandomPool
            // (it just came from the server), but phase 2 below still
            // schedules its own follow-up: the debounce there coalesces
            // correctly even when this branch already had a fresh
            // answer, and a section's pool can change again before that
            // timer fires.
            this._pending = true;
            memoKey = memoKeyNow;
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
                this._lastChosen = answer.chosen || {};
                this._lastChosenSeed = seedValue;
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
            // Reuses the SAME memoKeyNow/memoAlreadyCovers computed
            // above rather than re-deriving them. Reusing the memo here
            // is still safe even with hasRandomPool true: this is only
            // the INSTANT answer shown while phase 2's debounced
            // follow-up (scheduled below) goes and re-confirms it -- an
            // approximation is fine for something about to be
            // corrected within RANDOM_POOL_DEBOUNCE_MS regardless.
            memoKey = memoKeyNow;
            if (memoAlreadyCovers) {
                composed = this._lastCompose.prompt;
            }
        }

        if (composed === null) {
            if (hasRandomPool && this.outputEl.value) {
                // Anti-flicker: composed === null here means neither
                // the network branch nor the warm-memo branch had an
                // answer for these EXACT inputs (typically: the seed
                // just changed). The naive next step would be
                // _composeLocally()'s fresh hashStringToIndex() guess --
                // but that guess is frequently a DIFFERENT pool entry
                // than whatever the debounced server confirmation
                // (scheduled below) is about to show a fraction of a
                // second later, which is exactly what produced the
                // visible flash between two different prompts on every
                // seed change. Leaving outputEl untouched here means the
                // PREVIOUS (still-valid, still-displayed) text simply
                // stays on screen a little longer, and the debounced
                // confirmation becomes the ONLY thing that ever changes
                // it -- one clean transition instead of two.
                //
                // Guarded on this.outputEl.value being non-empty: the
                // very FIRST render of a fresh node has nothing to hold
                // onto, so that one still shows the local guess as its
                // instant placeholder rather than an empty box.
                this._scheduleAuthoritativeRecompose(myToken, state, used, seedValue, userPromptValue, memoKeyNow);
                return;
            }
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

        if (hasRandomPool) {
            // Phase 2: this render's answer (whatever branch produced
            // it) is NEVER final while a real randomize pool is in
            // play -- schedule the debounced, unconditional server
            // confirmation. Passing myToken (not re-reading
            // this._renderToken) means the scheduled call always knows
            // exactly which render it belongs to, so it can correctly
            // no-op if a NEWER render supersedes it before the debounce
            // timer even fires, let alone before the request resolves.
            this._scheduleAuthoritativeRecompose(myToken, state, used, seedValue, userPromptValue, memoKeyNow);
        }
    }

    /**
     * Debounced, unconditional /compose confirmation for a render that
     * touched an unconfirmed randomize pool (see _hasUnconfirmedRandomPool
     * and render()'s own docstring for the full rationale).
     *
     * "Unconditional" is the operative difference from render()'s own
     * uncached-refs branch: this fires even when _lastCompose already
     * has an answer for the exact same memoKey, because the ONLY
     * reason this method exists is that a memo hit for a randomized
     * section is not trustworthy proof the server was actually asked
     * about THIS pick -- it might be a stale answer from before a
     * seed/toggle change that render()'s local branch is currently
     * papering over with a locally-mirrored guess.
     *
     * Debounced by RANDOM_POOL_DEBOUNCE_MS: called on every render()
     * that has a random pool, but only the LAST call within the
     * debounce window actually reaches the network -- exactly one
     * request per burst of rapid edits, not one per keystroke.
     *
     * `used` is the render's own usedPromptRefs(state.sections) result,
     * passed through rather than recomputed, so the cache-refresh loop
     * below updates exactly the same ref set render()'s own uncached-
     * refs branch would have.
     */
    _scheduleAuthoritativeRecompose(token, state, used, seedValue, userPromptValue, memoKey) {
        if (this._randomPoolDebounceTimer) clearTimeout(this._randomPoolDebounceTimer);
        this._randomPoolDebounceTimer = setTimeout(async () => {
            this._randomPoolDebounceTimer = null;
            // Superseded before the debounce even finished waiting --
            // whatever render replaced this one will have scheduled
            // (or already run) its own follow-up if it still needs one.
            if (token !== this._renderToken) return;
            try {
                const answer = await apiClient.composePreview({
                    sections: state.sections,
                    seed: seedValue,
                    userPrompt: userPromptValue,
                    fallbackContents: Object.fromEntries(this.getCachedContents()),
                });
                if (!answer || typeof answer.prompt !== "string") {
                    throw new Error((answer && answer.error) || "malformed /compose response");
                }
                // Superseded while the request was in flight.
                if (token !== this._renderToken) return;
                const resolved = answer.resolved || {};
                for (const ref of used) {
                    this._cache.set(ref, resolved[ref] || null);
                }
                this._lastCompose = { key: memoKey, prompt: answer.prompt };
                this._lastChosen = answer.chosen || {};
                this._lastChosenSeed = seedValue;
                this.outputEl.value = answer.prompt;
                if (this._onComposed) {
                    try {
                        this._onComposed(answer.prompt);
                    } catch (err) {
                        console.error("Prompt Composer: onComposed mirror failed", err);
                    }
                }
            } catch (err) {
                // The instant local/memo answer stays on screen; the
                // NEXT render (or the next debounce cycle, since
                // nothing here clears hasRandomPool's cause) gets
                // another chance. A transient network hiccup here must
                // never surface as a hard preview error.
                console.error("Prompt Composer: authoritative randomize recompose failed", err);
            }
        }, RANDOM_POOL_DEBOUNCE_MS);
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
        return this.getSectionBlocks(state, userPromptValue)
            .map((block) => block.text)
            .join(" ");
    }

    /**
     * Per-SECTION preview blocks: the same walk and per-block assembly
     * as _composeLocally (mirroring compose_prompt()), but returned as
     * an ordered list of {sectionId, color, text, entries} instead of
     * one joined string. This is what the colorized preview (see
     * ComposerUI._renderColorizedPreview) paints per section -- it
     * needs to know WHICH block came from WHICH section's color, which
     * a flattened string can no longer tell you once blocks are joined
     * with plain spaces.
     *
     * `color` is null for the locked Prompt section (it has no accent
     * color of its own -- see makeLockedPromptSection) and for any
     * section missing one; the caller substitutes its own default
     * (the info color) in that case, keeping "what color means no
     * color" a UI decision rather than one baked in here.
     *
     * `entries` is the finer-grained breakdown WITHIN the block: one
     * run per chosen library entry (`{entryId, promptRef, text}`,
     * `text` including that entry's own trailing separator, e.g. the
     * comma from entry_separator). The section-name label prefix and
     * the end-separator suffix are NOT part of any entry -- neither
     * came from a library prompt, so there's no entry to attribute
     * them to -- which is exactly why `labelPrefix` (below) is reported
     * as its own field instead of folded into `entries[0]`.
     * The click/hover behavior this feeds is keyed to entries, not
     * sections, so a two-entry section can hover/select each of its
     * entries independently even though they share one section-level
     * color. For the locked Prompt section (no library entries at all)
     * `entries` holds one synthetic run standing for the typed text
     * itself, with `entryId: null` (there is no entry to jump to, only
     * the section). `labelPrefix` is `""` unless show_label produced
     * one, in which case it's the exact `"Name: "` string prepended to
     * `text`; `endSeparator` is `""` unless end_separator produced a
     * trailing `"."` or `","`, in which case it's that one character.
     * Both are reported directly (rather than left for a caller to
     * re-derive by pattern-matching `text`, which would be ambiguous
     * for a section literally named e.g. "Foo: Bar", or for text that
     * happens to end in its own literal period). Concatenating
     * `labelPrefix`, then every entries[].text joined by a space, then
     * `endSeparator`, reconstructs `text` exactly -- this is asserted
     * by the verify suite, since all of these are built from the same
     * intermediate values on purpose rather than any one being
     * re-derived from another after the fact.
     *
     * Skips exactly what _composeLocally skips: disabled sections, a
     * locked-prompt section with empty user_prompt, and a normal
     * section whose chosen entries all resolve to empty text -- so the
     * two stay in lockstep by construction (composeLocally now simply
     * joins this list's text fields).
     */
    getSectionBlocks(state, userPromptValue) {
        const blocks = [];
        for (const section of state.sections) {
            if (!section.enabled) continue;

            if (section.is_locked_prompt) {
                const text = (userPromptValue || "").trim();
                if (text) {
                    blocks.push({
                        sectionId: section.id,
                        color: section.color || null,
                        text,
                        entries: [{ entryId: null, promptRef: null, text }],
                        // The locked Prompt section never gets a label
                        // (is_locked_prompt sections don't render
                        // show_label at all) or an end-separator (typed
                        // user_prompt text isn't run through
                        // END_SEPARATOR_SUFFIX) -- both fields are still
                        // present, just always "", so a caller can read
                        // block.labelPrefix/block.endSeparator on every
                        // block uniformly without a special case for
                        // this one section type.
                        labelPrefix: "",
                        endSeparator: "",
                    });
                }
                continue;
            }

            const chosen = this._resolvePreviewEntries(section);
            if (chosen.length === 0) continue;

            const entryRuns = chosen
                .map((entry) => {
                    const resolved = this._contentFor(entry.prompt_ref);
                    const text = (resolved?.prompt || "").trim();
                    if (!text) return null;
                    const withSuffix = text + ENTRY_SEPARATOR_SUFFIX[normalizeEntrySeparator(entry.entry_separator)];
                    return { entryId: entry.id, promptRef: entry.prompt_ref, text: withSuffix };
                })
                .filter(Boolean);
            if (entryRuns.length === 0) continue;

            // Entry runs already carry their own separator suffix (the
            // comma/space baked into ENTRY_SEPARATOR_SUFFIX); the plain
            // " " here is only the JOIN between one entry's run and the
            // next, matching parts.join(" ") in the pre-entries version
            // of this method exactly.
            let combined = entryRuns.map((run) => run.text).join(" ");
            let labelPrefix = "";
            if (section.show_label && section.name) {
                labelPrefix = `${section.name}: `;
                combined = labelPrefix + combined;
            }
            const endChar = END_SEPARATOR_SUFFIX[normalizeEndSeparator(section.end_separator)] || "";
            if (endChar) {
                if (combined.endsWith(",")) {
                    combined = combined.slice(0, -1);
                    // The trimmed character came off the LAST entry
                    // run's own text -- keep that run (and therefore
                    // hover/click on its rendered span) matching what
                    // is actually on screen.
                    const last = entryRuns[entryRuns.length - 1];
                    last.text = last.text.slice(0, -1);
                } else if (combined.endsWith(" and")) {
                    combined = combined.slice(0, -4);
                    const last = entryRuns[entryRuns.length - 1];
                    // " and" spans the join space plus 3 letters off the
                    // last run's own text (ENTRY_SEPARATOR_SUFFIX for
                    // "and" is " and", attached to the SECOND-to-last
                    // run when there are exactly two entries -- but the
                    // trailing 3 letters removed here always come off
                    // whichever run's text currently ends the combined
                    // string, so slicing that run directly here (rather
                    // than re-deriving which run "and" belongs to) stays
                    // correct regardless of entry count).
                    if (last.text.endsWith("and")) last.text = last.text.slice(0, -3).replace(/\s+$/, "");
                }
                combined += endChar;
            }
            blocks.push({
                sectionId: section.id,
                color: section.color || null,
                text: combined,
                entries: entryRuns,
                // The show_label prefix, reported directly rather than
                // making a caller re-derive "did this block start with
                // a label?" by pattern-matching combined/text (fragile:
                // a section literally named e.g. "Foo: Bar" would make
                // that guess ambiguous). "" when show_label is off or
                // the section has no name -- callers can treat falsy
                // the same as "no prefix" either way.
                labelPrefix,
                // The section's end-separator character (a trailing "."
                // or ","), reported the same way as labelPrefix and for
                // the same reason: it sits OUTSIDE every entry run (it
                // isn't part of any one entry's own text -- see the
                // trimming just above, which removes it from `combined`
                // and from the last entry run alike before re-appending
                // it here), so a caller drawing per-entry spans needs it
                // as its own piece rather than losing it entirely. "" 
                // when end_separator is "none".
                endSeparator: endChar,
            });
        }
        return blocks;
    }
}
