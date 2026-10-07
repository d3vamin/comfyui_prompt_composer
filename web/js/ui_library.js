/**
 * ui_library.js
 *
 * The Library panel: a disk-backed, alphabetically-sorted list of
 * prompt_data entries scanned from the library folder (see
 * server/library_store.py). This is NOT a section stored in
 * ComposerState -- it's a live view onto the library, queried via
 * api_client.js.
 *
 * Responsibilities:
 *  - scan/refresh the library list
 *  - render library cards (name, prompt preview, thumbnail; a single
 *    "options" button -- no per-card delete, and no
 *    allow_random/entry_separator, those are Entry-only concepts)
 *  - search-as-you-type filtering (word-AND over name + category +
 *    prompt, relevance-ranked while a query is live; see
 *    library_search.js for the engine)
 *  - category filtering ("All" default; categories with no prompts are
 *    hidden -- except the selected one, which must keep showing even at
 *    zero hits, see buildCategoryOptions)
 *  - create/edit prompt_data via the edit panel, including the
 *    "already exists" blocking dialog
 *  - delete a prompt_data (with confirm) -- from the edit panel, or in
 *    bulk via the toolbar's "Delete selected prompts": a card/row body
 *    click toggles its membership in that selection (there is no
 *    separate checkbox -- the body click does the same job; section
 *    entry cards keep theirs, see the "Bulk-selection checkbox"
 *    note in the stylesheet).
 *
 * This module holds its own small piece of UI state (search text,
 * selected category, cached scan results) separate from ComposerState,
 * since none of it is persisted into composer_state/presets -- it's
 * purely how the Library panel presents what's already on disk.
 */

import { el } from "./dom_utils.js";
import { buildSearchBox, uiBtn } from "./ui_chrome.js";
import * as apiClient from "./api_client.js";
import { buildThumbnailOverlay, buildOverflowBadgeRow, buildNoThumbnailPlaceholder, listPromptPreview } from "./ui_panels.js";
import { stampRowFacts } from "./library_sync.js";
import { searchBlob, rankEntries } from "./library_search.js";
import {
    isFavoriteEntry,
    withFavorite,
    withFavoritePinned,
    buildFavoriteStar,
    categoryBadgesFor,
    categoryMembershipFor,
    FOLDER_CATEGORY_PREFIX,
} from "./favorites.js";

export class LibraryController {
    /**
     * @param {object} opts
     * @param {(entry: object) => void} opts.onPick - called with a
     *   library entry when the user chooses to add it into the active
     *   section (wired by ui_panels.js / the host UI).
     */
    constructor({ onPick } = {}) {
        this.entries = [];
        this.categories = []; // category IDENTITY list, from the sidecar index -- see api_client.listCategories
        // Same identity list PLUS one folder-derived pseudo-category per
        // library subfolder (see api_client.listCategories({withFolders:
        // true}) / server library_store.list_categories_with_folders).
        // Kept as a SEPARATE field, refreshed alongside `categories`
        // rather than folded into it, because the two lists serve
        // different consumers with a real behavioral difference: the
        // search toolbar's dropdown wants folders shown (getAllCategoriesWithFolders),
        // the "edit prompt" panel's tag picker must NEVER offer a folder
        // as something to individually tag a prompt into
        // (getAllCategories stays folder-free for exactly that reason).
        this.categoriesWithFolders = [];
        this.searchText = "";
        this.selectedCategory = "All";
        // Star filter modifier, shown as the star button beside the
        // category dropdown. Narrowing happens ON TOP OF selectedCategory
        // (see getVisibleEntries), not instead of it -- "favorites that
        // are also Characters" is the useful question, and the dropdown
        // already answers "which category" on its own.
        this.favoritesOnly = false;
        this.onPick = onPick || (() => {});
        this._loaded = false;
    }

    /**
     * Scan the library, chunk by chunk.
     *
     * @param {object} [opts]
     * @param {(entries: object[]) => void|Promise} [opts.onChunk] called
     *   per arrived page -- the Library browser uses it to append cards
     *   while later pages are still in flight.
     * @param {boolean} [opts.force] ask the server to drop its scan/reads
     *   memo (the explicit "Rescan library folder" button: files may have
     *   been swapped in under identical names).
     *
     * `this.entries` keeps the previous list until the first page lands
     * (a failed scan leaves the panel untouched, as the old one-shot
     * refresh did), then publishes a fresh snapshot after EVERY page, so
     * a render() that happens mid-load seeds itself from what has
     * arrived (and the remaining pages stream in through onChunk,
     * deduped by prompt_ref) instead of showing a stale list.
     */
    async refresh({ onChunk, force = false } = {}) {
        // Sequential, deliberately, rather than Promise.all: scanning the
        // library is the server-side step that folds any category tags
        // found embedded in the PNGs into the category index (see
        // library_store._register_categories_from_scan), so the category
        // list has to be read AFTER the scan has finished. Fetched in
        // parallel, the two requests race and the list can come back
        // without the category a freshly-dropped prompt carries -- it
        // would then be missing from the filter and the edit panel until
        // the library was reloaded a second time.
        // `this.entries` keeps the PREVIOUS list until the first page
        // arrives (so a failed scan leaves the panel as it was, exactly
        // like the old one-shot refresh did), then every page publishes
        // a fresh snapshot array -- consumers (getStructuralEntries,
        // category counts) treat it as stable data, and the snapshot
        // per page is what lets a mid-load render seed from what has
        // arrived while the rest still streams in through onChunk.
        const previous = this.entries;
        const accumulated = [];
        const publish = () => { this.entries = accumulated.slice(); };
        try {
            await apiClient.scanLibraryPaged({
                force,
                onPage: (page) => {
                    accumulated.push(...page);
                    publish();
                    if (onChunk) return onChunk(page);
                },
            });
        } catch (err) {
            // Failed before anything arrived: restore the old list (it
            // may never have been replaced, but restore it regardless
            // in case a partial stream raced this handler). Anything DID
            // arrive with: keep the partial -- it's already on screen.
            if (!accumulated.length) this.entries = previous;
            else publish();
            throw err;
        }
        publish();
        [this.categories, this.categoriesWithFolders] = await Promise.all([
            apiClient.listCategories(),
            apiClient.listCategories({ withFolders: true }),
        ]);
        // No thumbnail invalidation here on purpose. A refresh re-reads the
        // LIST; it says nothing about a picture's bytes changing, and
        // bumping every image URL on each one is what made the whole grid
        // flash when a single card was touched. Bumps belong on the save
        // path that actually rewrote an entry (see update()), scoped to
        // that one prompt.
        this._loaded = true;
        return this.entries;
    }

    /** The explicit "Rescan library folder" button: a refresh that also
     * throws away every cached thumbnail. That is the point of asking for a
     * rescan by hand -- files may have been swapped out on disk under an
     * unchanged name, and therefore under an unchanged prompt_ref and URL.
     * No automatic path does this (see refresh), which is exactly what
     * keeps the grid from flashing. */
    async rescan(opts = {}) {
        apiClient.invalidateAllLibraryImages();
        return this.refresh({ ...opts, force: true });
    }

    /** All known category names (sidecar identity, NOT just what's
     * currently observed on scanned entries -- a category can exist
     * with zero prompts tagged, e.g. freshly created), with the built-in
     * "Favorite" pinned first and everything else alphabetical. The
     * server already returns it that way; sorting here is what stops the
     * pin from being undone by this module's own comparator. */
    getAllCategories() {
        return withFavoritePinned(this.categories);
    }

    /**
     * getAllCategories()'s result, with every folder-derived pseudo-
     * category (see this.categoriesWithFolders) appended after it. For
     * the search toolbar's category dropdown ONLY -- see the field's
     * own comment in the constructor for why the edit panel must keep
     * using getAllCategories() instead.
     *
     * withFavoritePinned() is applied to the REAL categories only
     * (categoriesWithFolders already carries them in the exact
     * server-returned order -- real-then-folders -- so re-sorting the
     * combined list here would risk shuffling a folder pseudo-category
     * ahead of "Favorite" depending on name).
     */
    getAllCategoriesWithFolders() {
        const pinnedReal = withFavoritePinned(this.categories);
        const folderOnly = this.categoriesWithFolders
            .filter((c) => !this.categories.includes(c))
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        // Folders FIRST, alphabetically, then every real category
        // (Favorite still pinned ahead of the rest of those):
        // folder-derived categories lead the dropdown rather
        // than trailing it, so "where does this live" is the first
        // thing offered, ahead of "what else is it tagged".
        return [...folderOnly, ...pinnedReal];
    }

    /**
     * Plain (unprefixed) folder-category names currently on disk, e.g.
     * ["Characters", "Outfits"] -- for the edit panel's folder picker,
     * which needs to work with actual on-disk folder names (to send as
     * `folder` on save; see LibraryController.update/create) rather
     * than their "📁 " display form. Alphabetical -- same comparator
     * getAllCategoriesWithFolders() already uses for folderOnly.
     */
    getFolderNames() {
        return this.categoriesWithFolders
            .filter((c) => c.startsWith(FOLDER_CATEGORY_PREFIX))
            .map((c) => c.slice(FOLDER_CATEGORY_PREFIX.length))
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    }

    /**
     * Counts over the STRUCTURAL set -- every prompt that would be
     * listed right now if the search box were empty -- ignoring the
     * search text entirely.
     *
     * Search only ever SHOWS/HIDES rows (see _applyLibraryFilter and
     * getVisibleEntries); it does not change what the library holds. So
     * typing "zzz", which matches nothing, must not make the "Characters"
     * row of the filter dropdown read (0) or vanish: the category is
     * still there and still selected, exactly as it was before the
     * search, and the counts are meant to say so.
     *
     * Counting only the searched subset would be wrong: a search with no
     * hits would drive the selected category's count to 0, the zero-count
     * option would be dropped, the dropdown could no longer display the
     * filter it was still applying, and it would fall back to "All" while
     * the list stayed put. Clearing the search would then leave the filter
     * and the label disagreeing with each other.
     *
     * @param {Array} entries  the full scanned list, not a filtered one
     * @param {Array} categories  the known category names
     */
    static countCategories(entries, categories) {
        const counts = {};
        for (const cat of categories || []) counts[cat] = 0;
        for (const entry of entries || []) {
            // A folder-derived pseudo-category (see
            // FOLDER_CATEGORY_PREFIX / folder_pseudo_category_name
            // server-side) is never in entry.category -- it is
            // deliberately NOT an embedded tag, only a reflection of
            // entry.folder -- so it needs its own count path rather
            // than falling out of the loop below.
            if (entry.folder) {
                const folderCat = FOLDER_CATEGORY_PREFIX + entry.folder;
                if (folderCat in counts) counts[folderCat] += 1;
            }
            for (const cat of entry.category || []) {
                if (cat in counts) counts[cat] += 1;
            }
        }
        return counts;
    }

    /** Category counts over the whole library -- see countCategories.
     * Uses getAllCategories() (folder-free): the plain per-tag counts
     * the "edit prompt" panel and any other non-toolbar consumer need. */
    getCategoryCounts() {
        return LibraryController.countCategories(this.entries, this.getAllCategories());
    }

    /** Same as getCategoryCounts(), but over getAllCategoriesWithFolders()
     * -- for the search toolbar's dropdown, so a folder pseudo-category
     * shows a real, non-zero count instead of always reading (0). */
    getCategoryCountsWithFolders() {
        return LibraryController.countCategories(this.entries, this.getAllCategoriesWithFolders());
    }

    _searchFiltered(entries) {
        // Same word-AND engine the DOM pass ranks with --
        // one matcher for both, so the entry-level and DOM-level
        // answers can never disagree.
        const matched = rankEntries(entries, this.searchText).matched;
        if (!matched) return entries;
        return entries.filter((e) => matched.has(e.prompt_ref));
    }

    /** The entries the grid is BUILT from: everything matching the category
     * and favourite filters, regardless of the search text. */
    getStructuralEntries() {
        let list = this.entries;
        if (this.selectedCategory !== "All") {
            if (this.selectedCategory.startsWith(FOLDER_CATEGORY_PREFIX)) {
                // A folder-derived pseudo-category was picked: match by
                // entry.folder, not entry.category -- a folder is
                // deliberately never an embedded tag (see
                // FOLDER_CATEGORY_PREFIX's own comment), so the normal
                // tag-membership check below would always find zero
                // entries for one of these.
                const folder = this.selectedCategory.slice(FOLDER_CATEGORY_PREFIX.length);
                list = list.filter((e) => e.folder === folder);
            } else {
                list = list.filter((e) => (e.category || []).includes(this.selectedCategory));
            }
        }
        // Applied after the category filter, so the two intersect: the
        // star narrows whatever category is showing rather than
        // replacing it.
        if (this.favoritesOnly) {
            list = list.filter(isFavoriteEntry);
        }
        return [...list].sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * What is actually on screen right now: the built set minus whatever
     * the search text is currently hiding.
     *
     * The split matters. Building the grid with the text already applied
     * would mean prompts the text rejected never enter the DOM at all --
     * so shortening the query, or clearing it, had nothing left
     * to reveal and the list could not widen back out. Keeping the DOM
     * text-independent makes every text change, in either direction, a
     * pure show/hide pass (see ComposerUI.filterLibraryEntries), and leaves
     * a re-render only for the filters that genuinely rebuild the set.
     */
    getVisibleEntries() {
        return this._searchFiltered(this.getStructuralEntries());
    }

    /**
     * Add or remove the built-in "Favorite" category on one prompt.
     *
     * Goes through the ordinary category update, because that is what it
     * is -- the star is a different CONTROL, not a different kind of data.
     * The whole current category list is resent (minus/plus Favorite)
     * rather than a patch, matching how the edit panel saves categories,
     * and the entry's own casing is preserved by `withFavorite` so
     * starring then unstarring can't leave a stray duplicate spelling.
     *
     * @returns {Promise<object>} the updated library entry
     */
    async toggleFavorite(entry, nextValue) {
        const current = entry.category || [];
        const wanted = typeof nextValue === "boolean" ? nextValue : !isFavoriteEntry(entry);
        if (wanted === isFavoriteEntry(entry)) return entry; // no-op: don't rewrite the PNG
        // No thumbnail is involved in a category write, and no rescan:
        // the entry's own fields (search text, badges, star) are the
        // whole visible effect, all reachable from the returned entry.
        return this.update(entry.prompt_ref, { category: withFavorite(current, wanted) }, { refresh: false });
    }

    /** Check whether name+prompt would collide with an existing library
     * entry (the "already exists" rule). Returns {exists, entry}. */
    checkExists(name, prompt, excludePromptRef) {
        return apiClient.checkLibraryExists(name, prompt, excludePromptRef);
    }

    // -- Category identity CRUD (Category Options toolbar) ------------------

    async createCategory(name) {
        await apiClient.createCategory(name);
        await this.refresh();
    }

    async renameCategory(oldName, newName) {
        if (this.selectedCategory === oldName) this.selectedCategory = newName;
        await apiClient.renameCategory(oldName, newName);
        await this.refresh();
    }

    async deleteCategory(name) {
        if (this.selectedCategory === name) this.selectedCategory = "All";
        await apiClient.deleteCategory(name);
        await this.refresh();
    }

    async create({ name, prompt, category, imageDataUrl, folder }) {
        // The server's answer is the complete, authoritative entry --
        // including whatever final filename its collision/UID rules
        // settled on -- so a create adopts it locally like any other
        // single-prompt write. (Refreshing the whole scan here would
        // make "Add prompt" pause on the way back.)
        const entry = await apiClient.createLibraryEntry({ name, prompt, category, imageDataUrl, folder });
        this._adoptEntry(null, entry);
        if (category) {
            [this.categories, this.categoriesWithFolders] = await Promise.all([
                apiClient.listCategories(),
                apiClient.listCategories({ withFolders: true }),
            ]);
        }
        return entry;
    }

    async remove(promptRef) {
        await apiClient.deleteLibraryEntry(promptRef);
        // Local drop, no rescan: bulk delete loops this, and a scan per
        // deleted file would make deleting ten prompts ten full
        // library walks. Orphaned index categories are invisible to the
        // UI anyway (the dropdown filters by per-entry counts) and the
        // next genuine refresh tidies them.
        this.entries = this.entries.filter((e) => e.prompt_ref !== promptRef);
    }

    async update(promptRef, fields, { refresh = true } = {}) {
        const entry = await apiClient.updateLibraryEntry(promptRef, fields);
        // Bump THIS prompt's thumbnail on EVERY single-prompt
        // save, whatever the fields were. The old condition bumped only
        // when the payload carried an image change -- and when that
        // condition was ever wrong (a write that moved image bytes the
        // client didn't announce), the mounted card was judged fresh,
        // left untouched, and showed the old picture until a rescan.
        // The cost of always bumping is exactly ONE card re-fetching its
        // thumbnail per save. The old flash this guard protected
        // against came from the GLOBAL counter bumping every card --
        // per-ref bumping cannot reproduce it. (toggleFavorite stays a
        // separate, bump-free path -- a star truly never moves pixels.)
        apiClient.invalidateLibraryImage(entry?.prompt_ref || promptRef);
        // The rescan is conditional because an unconditional one makes
        // returning from the edit panel lag: one edited file dirties the
        // server's scan signature, so the "refresh" re-walks (and
        // re-reads what it can't reuse from) EVERY prompt, then the whole
        // browser rebuilds. The server's answer to a single update is
        // complete and authoritative for THAT prompt, so callers that
        // only changed one prompt pass refresh:false and adopt the
        // returned entry into the local list (see _adoptEntry); the
        // browser patches just its row.
        if (refresh) await this.refresh();
        else {
            this._adoptEntry(promptRef, entry);
            // A category write can mint brand-new category NAMES (the
            // server registers them in the index as part of the update);
            // the dropdown reads this.categories, so fetch the index --
            // one sidecar read, not the per-file walk a rescan is.
            if (fields && fields.category !== undefined) {
                [this.categories, this.categoriesWithFolders] = await Promise.all([
                    apiClient.listCategories(),
                    apiClient.listCategories({ withFolders: true }),
                ]);
            }
        }
        return entry;
    }

    /**
     * Splice one authoritative entry into the local list without a
     * rescan: replaces the row for `oldRef` (a rename means the server's
     * entry carries a NEW prompt_ref, so the old one simply leaves the
     * set -- the browser's diff drops its row and inserts the new one),
     * or appends if it is genuinely new. The array is swapped, not
     * mutated, so every consumer treating this.entries as a stable
     * snapshot keeps working.
     */
    _adoptEntry(oldRef, updated) {
        if (!updated || !updated.prompt_ref) return;
        const next = [];
        for (const entry of this.entries) {
            // Skip the same prompt's other identity (rename swaps the
            // ref) and any pre-existing row for the new ref.
            if (entry.prompt_ref === updated.prompt_ref || entry.prompt_ref === oldRef) continue;
            next.push(entry);
        }
        next.push(updated);
        this.entries = next;
    }

    // -- Rendering ---------------------------------------------------------

    /** Build the search toolbar and keep input handling separate from full renders.
     * `onInput` fires on every keystroke (the caller debounces it);
     * `onFlush` skips the debounce for deliberate commits -- Enter, the
     * clear ×, and Escape. The toolbar exposes `searchInput`/`searchCount`
     * so the panel layer can focus it from anywhere and update the
     * "N of M" readout without hunting selectors. */
    buildSearchToolbar(onChange, onInput, onFlush) {
        // The strip's DOM + grammar (typing, Enter, Esc-clear,
        // cross) live in ui_chrome.buildSearchBox -- identical to the
        // section panel's copy that grew into a byte-twin. This wrapper
        // owns only controller-side bookkeeping: the searchText mirror
        // and the legacy onChange fallback.
        return buildSearchBox({
            value: this.searchText,
            onLive: (v, field) => {
                this.searchText = v;
                if (onInput) onInput(v, field);
                else if (onChange) onChange();
            },
            onFlush: (v, field) => {
                this.searchText = v;
                if (onFlush) onFlush(v);
                else if (onInput) onInput(v, field);
            },
        });
    }

    /**
     * Build one library card: thumbnail, name, and a single options
     * button (no allow_random / entry_separator, those belong
     * to Entry, not prompt_data; and no per-card delete, which is handled
     * by the edit panel and the toolbar's bulk delete).
     *
     * Grid cards deliberately do NOT show a permanent category badge
     * row (unlike list rows, see buildListRow) -- category tags and
     * the full prompt text are only shown in a floating hover tooltip
     * instead (see buildThumbnailOverlay), so the card grid stays compact
     * and uniform regardless of how many categories a prompt carries.
     */
    buildCard(entry, { selected, onOptions, onToggleSelect, onDragStart, onToggleFavorite, pickMode }) {
        const card = el("div", "pc-entry-card pc-library-card" + (selected ? " pc-selected" : "") + (pickMode ? " pc-library-pick-mode" : ""));
        card.draggable = true;
        card.dataset.promptRef = entry.prompt_ref;
        card.dataset.searchText = searchBlob(entry);
        card.dataset.categories = JSON.stringify(categoryMembershipFor(entry));
        stampRowFacts(card.dataset, entry);
        // The exact image URL the row rendered -- see stampRowFacts:
        // an image REPLACEMENT on an unchanged prompt moves neither the
        // name nor the thumbnail flag, and only the version bump in the
        // URL distinguishes the stale <img> from a current one.
        card.dataset.fImg = entry.has_thumbnail === false ? "none" : apiClient.libraryImageUrl(entry.prompt_ref);

        const imageWrap = el("div", "pc-entry-image-wrap");
        if (entry.has_thumbnail === false) {
            imageWrap.append(buildNoThumbnailPlaceholder());
        } else {
            imageWrap.append(el("img", "pc-entry-image", {
                src: apiClient.libraryImageUrl(entry.prompt_ref),
                draggable: "false",
                // Lazy + async: every card in the library is a thumbnail
                // fetch, and firing them all at once is a network + decode
                // burst that competes with the first scroll. The browser
                // starts each one as its card approaches the viewport and
                // keeps decoding off the critical path.
                loading: "lazy",
                decoding: "async",
            }));
        }

        // Favorite is the star -- and the star now WEARS the badge
        // seat: it floats over the overlay badge row's right end (see
        // .pc-fav-star-grid), so showing the Favorite pill here too
        // would print the same fact twice in the same row.
        imageWrap.append(buildThumbnailOverlay(entry.prompt, categoryBadgesFor(entry)));
        imageWrap.append(buildFavoriteStar({
            favorite: isFavoriteEntry(entry),
            placement: "grid",
            onToggle: onToggleFavorite && (() => onToggleFavorite(entry)),
        }));

        const label = el("div", "pc-entry-label", { text: entry.name });

        const optionsBtn = uiBtn({ bare: true, extra: "pc-entry-options-btn", noStep: true, icon: "edit", size: 16, title: "Edit prompt", onClick: (e) => {
            e.stopPropagation();
            onOptions(entry);
        } });

        card.append(imageWrap, label, optionsBtn);

        // While picking a replacement for a missing entry, every card is
        // a single "use this one" choice -- a small "Use this" badge
        // labels the whole card as that click target. The bulk-select
        // There is no bulk-select checkbox here: the card body already
        // toggles selection (click handler below), so a box would be a
        // redundant second affordance for the same set.
        if (pickMode) {
            card.append(el("div", "pc-library-pick-badge", { text: "Use this" }));
        }

        card.addEventListener("click", (e) => {
            if (e.target.closest("button, input")) return;
            e.stopPropagation();
            onToggleSelect(entry);
        });

        card.addEventListener("dragstart", (e) => {
            if (onDragStart) onDragStart(e, entry.prompt_ref, selected);
        });

        return card;
    }

    /**
     * Build one library row (list view): small thumbnail, name +
     * prompt preview text stacked, category badges, and the same single
     * options action as the card -- mirrors the section entry list row's
     * layout (buildEntryListRow in ui_panels.js) so switching the Library
     * between grid/list feels consistent with the rest of the app.
     */
    buildListRow(entry, { selected, onOptions, onToggleSelect, onDragStart, onToggleFavorite, pickMode }) {
        const row = el("div", "pc-entry-row pc-library-row-item" + (selected ? " pc-selected" : "") + (pickMode ? " pc-library-pick-mode" : ""));
        row.draggable = true;
        row.dataset.promptRef = entry.prompt_ref;
        row.dataset.searchText = searchBlob(entry);
        row.dataset.categories = JSON.stringify(categoryMembershipFor(entry));
        stampRowFacts(row.dataset, entry);
        row.dataset.fImg = entry.has_thumbnail === false ? "none" : apiClient.libraryImageUrl(entry.prompt_ref);

        const thumbWrap = el("div", "pc-entry-row-thumb");
        if (entry.has_thumbnail === false) {
            thumbWrap.append(buildNoThumbnailPlaceholder());
        } else {
            thumbWrap.append(el("img", "pc-entry-image", {
                src: apiClient.libraryImageUrl(entry.prompt_ref),
                draggable: "false",
                loading: "lazy",
                decoding: "async",
            }));
        }

        const optionsBtn = uiBtn({ bare: true, extra: "pc-entry-options-btn pc-entry-row-options-overlay", noStep: true, icon: "edit", size: 16, title: "Edit prompt", onClick: (e) => {
            e.stopPropagation();
            onOptions(entry);
        } });
        thumbWrap.append(optionsBtn);

        const textWrap = el("div", "pc-entry-row-text");
        const name = el("div", "pc-entry-row-name", { text: entry.name });
        const promptText = el("div", "pc-entry-row-prompt", { text: listPromptPreview(entry.prompt) });
        textWrap.append(name, promptText);
        // The favorite star is the FIRST badge of the category row -- it
        // IS the Favorite category. On Library rows it is always built,
        // favourited or not: this is the toggle control, so the OFF
        // state must exist to be revealed (row hover shows it, per the
        // CSS reveal rule). Off it is display:none -- an ABSENT seat --
        // so revealing it on hover pushes the pills right by exactly the
        // 14px+gap badge_fit has been reserving all along (
        // the push is the behavior the user wants; the plan is fitted
        // against the star-present state, so it never overflows).
        const badgeRow = buildOverflowBadgeRow(categoryBadgesFor(entry), "pc-library-card-badges");
        badgeRow.prepend(buildFavoriteStar({
            favorite: isFavoriteEntry(entry),
            placement: "list",
            onToggle: onToggleFavorite && (() => onToggleFavorite(entry)),
        }));
        textWrap.append(badgeRow);

        const actions = el("div", "pc-entry-row-actions");
        // See buildCard's identical rationale: the "Use this" badge
        // labels single-pick rows; browse-mode actions stay empty
        // (the row body carries the selection click).
        if (pickMode) {
            actions.append(el("div", "pc-library-pick-badge", { text: "Use this" }));
        }

        row.append(thumbWrap, textWrap, actions);
        row.addEventListener("click", (e) => {
            if (e.target.closest("button, input")) return;
            e.stopPropagation();
            onToggleSelect(entry);
        });
        row.addEventListener("dragstart", (e) => {
            if (onDragStart) onDragStart(e, entry.prompt_ref, selected);
        });

        return row;
    }
}
