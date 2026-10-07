/**
 * favorites.js
 *
 * The one built-in category: "Favorite". Shared leaf module because both
 * the Library panel (ui_library.js) and the composer panels (ui_panels.js)
 * need it, and neither may import the other -- ui_library.js already
 * imports from ui_panels.js, so a constant living in either would create a
 * cycle.
 *
 * Storage: Favorite is an ORDINARY category tag. A favorited prompt simply
 * carries "Favorite" in its `category` array, exactly like any other
 * category, written through the same update endpoint. That is deliberate:
 * a PNG dragged out of the library folder keeps its favorite state with it,
 * for free, with no second sidecar to keep in sync. The server guarantees
 * the category exists and refuses to rename or delete it (see
 * library_store.FAVORITE_CATEGORY).
 *
 * Presentation is what differs, and it is the whole point of this module:
 *   - it never appears among the category BADGES on a card (the star takes
 *     its place), which is what `withoutFavorite` is for;
 *   - it is pinned to the front of every category LIST, ahead of the
 *     alphabetical order, which is what `sortCategoriesPinningFavorite` is
 *     for;
 *   - it cannot be renamed or deleted from the category list in the edit
 *     panel, so those rows render without the two action buttons.
 */

import { el } from "./dom_utils.js";
import { svgIcon } from "./icons.js";
import { uiToggle } from "./ui_chrome.js";

export const FAVORITE_CATEGORY = "Favorite";

/** Case-insensitive, trimmed match -- mirrors the server's is_favorite_name
 * so a hand-typed lowercase "favorite" tag is treated as the built-in one
 * here too, rather than showing up as a second, unprotected category. */
export function isFavoriteCategory(name) {
    return String(name || "").trim().toLowerCase() === FAVORITE_CATEGORY.toLowerCase();
}

/** Is this library/entry record favorited? Takes anything with a
 * `category` array. */
export function isFavoriteEntry(entry) {
    return !!entry && (entry.category || []).some(isFavoriteCategory);
}

/** Copy of `categories` with the Favorite tag removed, for the badge rows
 * on cards and rows. Case-insensitive, so the actual stored casing (which
 * may be a user's lowercase one) doesn't decide whether it leaks into the
 * badges. */
export function withoutFavorite(categories) {
    return (categories || []).filter((c) => !isFavoriteCategory(c));
}

/** The canonical name to WRITE for a favorite tag. Given the existing
 * categories, it reuses whichever casing is already stored so toggling a
 * favorite off and on again doesn't silently rewrite "favorite" into
 * "Favorite" and leave the old spelling behind as a duplicate. */
export function favoriteNameIn(categories) {
    return (categories || []).find(isFavoriteCategory) || FAVORITE_CATEGORY;
}

/**
 * A copy of `categories` with Favorite turned on or off.
 *
 * Returns a NEW array (never mutates the entry's own list, which may be the
 * cached resolve result shared by every card showing that prompt). Adding
 * is idempotent and preserves the existing casing; removing strips every
 * case variant, so a prompt that somehow carries both "Favorite" and
 * "favorite" ends up with neither.
 */
export function withFavorite(categories, on) {
    const list = categories || [];
    if (on) {
        return list.some(isFavoriteCategory) ? [...list] : [...list, favoriteNameIn(list)];
    }
    return list.filter((c) => !isFavoriteCategory(c));
}

/**
 * Sort category names for display: Favorite first (in its canonical
 * spelling), everything else alphabetically and case-insensitively.
 *
 * The server already returns it pinned (library_store.list_categories), but
 * every client sort would undo that -- this is the single comparator that
 * keeps the invariant regardless of which list it is fed.
 */
export function sortCategoriesPinningFavorite(names) {
    return [...(names || [])].sort((a, b) => {
        const aFav = isFavoriteCategory(a);
        const bFav = isFavoriteCategory(b);
        if (aFav !== bFav) return aFav ? -1 : 1;
        return String(a).toLowerCase() < String(b).toLowerCase() ? -1
            : String(a).toLowerCase() > String(b).toLowerCase() ? 1 : 0;
    });
}

/**
 * `sortCategoriesPinningFavorite`, plus the other half of the promise: if
 * the list is missing Favorite entirely, it is added.
 *
 * The server guarantees it exists, so this only ever fires on a client
 * that hasn't finished its first refresh yet (or one reading a state
 * captured before the bootstrap existed). Doing it anyway is what lets
 * every consumer treat "Favorite is in the list" as an invariant instead
 * of a check they each have to remember.
 */
export function withFavoritePinned(names) {
    const list = names || [];
    return sortCategoriesPinningFavorite(
        list.some(isFavoriteCategory) ? list : [FAVORITE_CATEGORY, ...list]
    );
}

/**
 * The star on a prompt card. Built here rather than in each panel so the
 * Library's interactive toggle and the composer's passive indicator are
 * guaranteed to be the same shape, in the same place, coloured the same
 * way -- they are the same piece of information, and having them drift
 * would make one of them a lie.
 *
 * @param {object} opts
 * @param {boolean} opts.favorite - the ON/OFF state
 * @param {() => void} [opts.onToggle] - pass it to get a real button that
 *   flips the favorite; omit it to get a plain, non-interactive `<div>`
 *   indicator (what the composer's entry cards use, since an entry is a
 *   pointer into the library and starring it from here would edit a
 *   library record the user didn't ask to edit).
 * @param {"grid"|"list"} [opts.placement="grid"] - where the badge sits:
 *   grid floats it square over the thumbnail's bottom-right, exactly at
 *   the hover overlay's badge-row height (its seat among the categories);
 *   list flows it as the FIRST badge of the row under the name. The two
 *   have nothing in common but the badge look, so each gets its own
 *   positioning class rather than one shared offset.
 * @param {string} [opts.title]
 * @returns {HTMLElement}
 */
export function buildFavoriteStar({ favorite, onToggle, placement = "grid", title }) {
    const interactive = typeof onToggle === "function";
    if (!interactive) {
        // The passive indicator is NOT chrome -- no button, no states:
        // a plain div wearing the same shape classes. A passive
        // indicator must not offer an action it cannot perform: a
        // "Remove from Favorite" tooltip on a star that does nothing
        // would be a tooltip lying about its own control.
        const node = el("div",
            `pc-fav-star pc-fav-star-${placement} ${favorite ? "pc-fav-on" : "pc-fav-off"} pc-fav-indicator`,
            { title: title || "This prompt is in the Favorite category" });
        node.innerHTML = svgIcon("star", 12, favorite ? "currentColor" : "none");
        return node;
    }
    // The interactive star goes through the toggle factory --
    // starOn/star are the SAME path with/without a baked fill, so the
    // silhouette never shifts, .pc-fav-on rides onClass, and applyState
    // can flip a live star without rebuilding its card. noHover: the
    // star is a thumbnail overlay; the shared wash would frost the
    // picture (its own .pc-fav-off:hover cue in CSS stays).
    return uiToggle({
        on: favorite,
        iconOn: "starOn",
        iconOff: "star",
        size: 12,
        onClass: "pc-fav-on",
        title: title || undefined,
        titleOn: "Remove from Favorite",
        titleOff: "Add to Favorite",
        bare: true,
        noHover: true,
        noStep: true,
        extra: `pc-fav-star pc-fav-star-${placement}`,
        type: "button",
        onClick: (e) => { e.stopPropagation(); onToggle(); },
    });
}

/**
 * The star beside a "filter by category" dropdown: ON narrows whatever is
 * already filtered down to favorites, OFF leaves the filter alone. It is a
 * modifier on the category selection rather than another category, which
 * is why it sits outside the dropdown -- and why the caller hides it when
 * the dropdown is already set to Favorite, where it would be a second
 * control for the same thing.
 *
 * @param {object} opts
 * @param {boolean} opts.active
 * @param {(next: boolean) => void} opts.onChange
 * @returns {HTMLElement}
 */
export function buildFavoriteFilterButton({ active, onChange }) {
    // The toggle factory -- same starOn/star pair as the
    // card star, .pc-fav-on via onClass, and applyState so a host can
    // flip the button LIVE (the section panel rides its in-place
    // filter pass -- clicking this rebuilds nothing). The
    // verdict is read from the button's own class at click time: a
    // closure over the build-time `active` would go stale the moment
    // the button survives its first click.
    const btn = uiToggle({
        on: active,
        iconOn: "starOn",
        iconOff: "star",
        size: 14,
        onClass: "pc-fav-on",
        titleOn: "Showing favorites only - click to show all",
        titleOff: "Show only favorites",
        extra: "pc-fav-filter-btn",
        type: "button",
        onClick: () => onChange(!btn.classList.contains("pc-fav-on")),
    });
    return btn;
}

// -- Folder-derived pseudo-categories ---------------------------------
//
// Shares this module for the SAME reason Favorite does (see the module
// docstring): both ui_library.js and ui_panels.js need it, and neither
// may import the other.
//
// A subfolder in the library gets a pseudo-category badge/filter entry
// -- "📁 Outfits" for a subfolder named "Outfits" -- WITHOUT it ever
// being an embedded tag: it is derived purely from where the file lives
// on disk (entry.folder, set by server library_store.scan_library),
// never written into entry.category, never persisted to
// _categories.json. FOLDER_CATEGORY_PREFIX MUST match
// FOLDER_CATEGORY_PREFIX in server/library_store.py exactly; the server
// is the actual source of truth for the reservation (is_reserved_
// category_name rejects any real category name starting with it), this
// is only the display-side copy used to recognize/derive one client-side.

export const FOLDER_CATEGORY_PREFIX = "\u{1F4C1} "; // "📁 "

/** The display badge/dropdown-option name for a subfolder, e.g.
 * "Outfits" -> "📁 Outfits". Mirrors server
 * library_store.folder_pseudo_category_name() exactly. */
export function folderPseudoCategoryName(folder) {
    return `${FOLDER_CATEGORY_PREFIX}${folder}`;
}

/** True for a category STRING that is a folder-derived pseudo-category
 * (as opposed to a real, user-managed one). */
export function isFolderPseudoCategory(category) {
    return typeof category === "string" && category.startsWith(FOLDER_CATEGORY_PREFIX);
}

/** The badge list a prompt CARD should show: its real (non-Favorite)
 * categories, plus its folder's pseudo-category prepended when it has
 * one -- so a card sitting inside a library subfolder visibly shows
 * that folder as a badge, the same way it shows any other tag, without
 * folder ever becoming a real, embedded, user-editable category (see
 * this module's own header comment). Folder-first ordering matches
 * where a person's eye tends to look for "where does this live" before
 * "what else is it tagged".
 *
 * Favorite is DELIBERATELY excluded (withoutFavorite): a card already
 * shows it as its own star icon, so a "Favorite" badge here would
 * print the same fact twice. This makes categoryBadgesFor the right
 * choice for building what a card VISUALLY DISPLAYS, but the WRONG
 * choice for anything that needs to know "is this entry a member of
 * category X" for filtering/matching purposes (a category dropdown's
 * "Favorite" option has to keep matching entries tagged Favorite) --
 * use categoryMembershipFor for that instead.
 *
 * @param {object} entry - a resolved/display library entry ({category, folder})
 */
export function categoryBadgesFor(entry) {
    const real = withoutFavorite(entry && entry.category);
    if (entry && entry.folder) {
        return [folderPseudoCategoryName(entry.folder), ...real];
    }
    return real;
}

/** Every category name an entry should be considered a MEMBER of, for
 * filtering/searching purposes: its real embedded categories (Favorite
 * INCLUDED, unlike categoryBadgesFor -- selecting "Favorite" from a
 * category dropdown has to keep matching a Favorite-tagged entry even
 * though the card doesn't print a redundant "Favorite" badge) plus its
 * folder's pseudo-category when it has one.
 *
 * This is what belongs in a `dataset.categories`-style stamp that a
 * live filter reads back (_applyLibraryRow / _applySectionRow), and in
 * populateLibraryCategorySelect's / populateSectionCategorySelect's own
 * per-entry counting loop -- both need "what can this entry match",
 * which is a strictly LARGER set than "what badge should this entry's
 * card print" (categoryBadgesFor).
 *
 * @param {object} entry - a resolved/display library entry ({category, folder})
 */
export function categoryMembershipFor(entry) {
    const real = (entry && entry.category) || [];
    if (entry && entry.folder) {
        return [folderPseudoCategoryName(entry.folder), ...real];
    }
    return real;
}
