/**
 * library_sync.js
 *
 * The pure "something changed on ONE prompt" diff for the Library
 * browser -- what to touch, given what SHOULD be on screen and what IS.
 *
 * Why: every single-prompt mutation -- starring, an edit-panel save, a
 * delete -- must not end in a full render(): that would re-create N
 * cards, re-apply the search filter over all of them, and throw away and
 * rebuild the container (and with it the browser's scroll position)
 * across chunk frames. Work out of proportion to the change makes the
 * star feel unresponsive and makes returning from an edit panel lag and
 * JUMP. The rule this encodes: a mutation's cost should be proportional to what it changed.
 *
 * Contract: the caller reads the DOM (refs + freshness stamps) and
 * hands that over; this decides the minimum set of node operations. No
 * DOM is touched here, which is what lets tests/verify_library_sync.mjs
 * cover the whole decision table under plain node.
 */

/**
 * Is this row built from exactly this entry's field values? Reads the
 * `data-f-*` stamp the row builders write alongside the content, so a
 * name edit, a category change, a thumbnail replace and a re-pick all
 * make the row visibly stale without any server round trip.
 *
 * fCategory folds in entry.folder alongside the real embedded tags
 * (not just entry.category) -- a folder-category RENAME changes every
 * member prompt's `folder` string but never touches its actual
 * `category` array, so comparing category alone judged those rows
 * "fresh" and left their folder badge showing the old name until some
 * unrelated change forced a full rebuild.
 */
export function isRowFresh(element, entry) {
    const d = element && element.dataset;
    if (!d || !entry) return false;
    return d.fName === String(entry.name || "")
        && d.fPrompt === String(entry.prompt || "")
        && d.fCategory === categoryStampKey(entry)
        && d.fThumb === (entry.has_thumbnail === false ? "0" : "1");
}

/** The exact string isRowFresh/stampRowFacts compare for "same tags AND
 * same folder membership" -- entry.category plus entry.folder (when
 * present), joined the same way categoryBadgesFor/categoryMembershipFor
 * order them (folder first) so the two folder-aware call sites and this
 * stamp can never quietly drift apart on ordering. "\u0000folder\u0000"
 * prefixes the folder segment with a byte no category name can contain,
 * so a real category literally named the same as some OTHER prompt's
 * folder can never collide with it in the stamp. Exported: any OTHER
 * spot that hand-restamps dataset.fCategory (see
 * prompt_composer.js's _paintLibraryStars) must build it through this
 * same function, or its rows silently fall back to judging staleness on
 * category alone -- exactly the folder-rename bug this stamp exists to
 * catch. */
export function categoryStampKey(entry) {
    const real = (entry.category || []).join("|");
    return entry.folder ? `\u0000folder\u0000${entry.folder}|${real}` : real;
}

/** Write the same stamp at build time -- one definition, no drift. */
export function stampRowFacts(dataset, entry) {
    dataset.fName = String(entry.name || "");
    dataset.fPrompt = String(entry.prompt || "");
    dataset.fCategory = categoryStampKey(entry);
    dataset.fThumb = entry.has_thumbnail === false ? "0" : "1";
}

/**
 * @param {object[]} desired entries in final display order (already
 *   category/favourite-filtered and name-sorted by the caller --
 *   LibraryController.getStructuralEntries is the authority).
 * @param {Array<{ref: string, fresh: boolean}>} mountedInOrder
 *   one per mounted row, in DOM order.
 * @param {number} [maxChurn] if the change touches more than this many
 *   rows, a rebuild-from-scratch is honestly cheaper than patching --
 *   the plan comes back `abort: true` and the caller falls through to
 *   its full (chunked) build.
 * @returns {{abort: boolean, churn: number,
 *   removeRefs: string[], rebuild: object[], add: object[],
 *   keptFreshInOrder: string[], needsPlacement: boolean}}
 */
export function planLibrarySync(desired, mountedInOrder, maxChurn = 96) {
    const desiredByRef = new Map();
    for (const entry of desired) if (entry && entry.prompt_ref) desiredByRef.set(entry.prompt_ref, entry);

    const mountedRefs = new Set();
    const removeRefs = [];
    const staleRefs = new Set();
    const keptFresh = [];
    for (const row of mountedInOrder) {
        if (!row || !row.ref) continue;
        mountedRefs.add(row.ref);
        const wanted = desiredByRef.has(row.ref);
        if (!wanted || !row.fresh) {
            // Gone, or changed beyond what a paint can patch: the node
            // goes, and if it's still wanted a rebuilt twin comes back
            // (as `rebuild` below, keeping its data identity).
            removeRefs.push(row.ref);
            if (wanted) staleRefs.add(row.ref);
        } else {
            keptFresh.push(row.ref);
        }
    }

    const rebuild = [];
    const add = [];
    for (const entry of desired) {
        if (!entry || !entry.prompt_ref || mountedRefs.has(entry.prompt_ref)) {
            if (staleRefs.has(entry.prompt_ref)) rebuild.push(entry);
            continue;
        }
        add.push(entry);
    }

    // Placement: the survivors' DOM order must match the order they
    // occupy in `desired`. A rename anywhere in the list can disturb it;
    // so can a rebuild re-inserting at a new slot. Comparing the
    // survivors against their desired subsequence is exact and linear.
    let needsPlacement = false;
    let cursor = 0;
    for (const entry of desired) {
        const ref = entry && entry.prompt_ref;
        if (cursor >= keptFresh.length || keptFresh[cursor] !== ref) continue;
        cursor++;
    }
    needsPlacement = cursor !== keptFresh.length || rebuild.length > 0 || add.length > 0;

    // Churn counts DISTINCT ROWS touched, not ops: a rebuild is one row
    // even though it removes and mints an element.
    const touchedRows = new Set(removeRefs);
    for (const entry of rebuild) touchedRows.add(entry.prompt_ref);
    for (const entry of add) touchedRows.add(entry.prompt_ref);
    const churn = touchedRows.size;
    return {
        abort: churn > maxChurn,
        churn,
        removeRefs,
        rebuild,
        add,
        keptFreshInOrder: keptFresh,
        needsPlacement,
    };
}

/**
 * Minimum-move ordered placement, expressed as data: given the desired
 * ref order and the refs currently in the container (after removals),
 * yield the sequence of (ref, beforeRef|null) insertBefore operations
 * that an apply loop executes with real elements.
 *
 * Algorithm: walk desired order with a cursor over the mounted order;
 * an element already at the cursor's slot is untouched (that's why the
 * common single-edit case emits one op, not N); an element that is not
 * gets moved to the cursor. This is the classic greedy that keeps every
 * already-correct element in place.
 */
export function planPlacements(desiredRefs, mountedRefs) {
    const ops = [];
    const order = mountedRefs.slice();
    const positionOf = new Map();
    order.forEach((ref, i) => positionOf.set(ref, i));
    let cursor = 0;
    for (let d = 0; d < desiredRefs.length; d++) {
        const ref = desiredRefs[d];
        const at = positionOf.get(ref);
        if (at === undefined) continue; // caller inserts these separately (adds/rebuilds)
        if (at === cursor) { cursor++; continue; }
        // Move `ref` to sit just before whatever is currently at the
        // cursor; null means "end of container" only when the cursor
        // sits past every kept row.
        const before = cursor < order.length && cursor !== at ? order[cursor] : null;
        ops.push({ ref, before });
        order.splice(at, 1);
        const insertAt = before ? positionOf.get(before) : order.length;
        order.splice(insertAt, 0, ref);
        positionOf.clear();
        order.forEach((r, i) => positionOf.set(r, i));
        cursor++;
    }
    return ops;
}
