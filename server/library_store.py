"""
library_store.py

Owns the "library" concept for Prompt Composer: prompt data lives on
disk as PNG images (in the same way ComfyUI saves generated images with
a workflow attached), and this module is the ONLY place that reads,
writes, scans, or resolves those files. Every other module (the compose
node, the JS preview via its resolve endpoint, the library CRUD routes)
goes through the functions here rather than touching PNG metadata
directly, so there is exactly one implementation of "what does this
prompt_data actually contain". That single source of truth matters
because Python resolves prompt_ref at compose/preview time, rather than
JS freezing resolved text at edit time.

Filename convention
--------------------
    <EncodedName>_<UID>.png

- "EncodedName" is the Prompt Name encoded for the filesystem (see
  "Naming" below): every literal underscore doubles to "__" (underscores
  first), and a space becomes a single "_".
- UID is an 8-digit id derived from hash(name.lower() + prompt text),
  both canonicalized (NFC, LF newlines, trimmed -- see
  canonical_prompt_text) so identical content produces an identical UID
  on any machine. Case-folded, because names differing only by case are
  the same name. When an import collides, a trailing number is appended
  to the DISPLAY name ("Beautiful" -> "Beautiful_002"; a name already
  ending in "_" reuses it: "Bright_" -> "Bright_002"), and the UID is
  computed from that FINAL name -- never from the pre-collision one --
  so the editor's "already exists" check agrees with what the import
  wrote. The suffix is then just part of the name, so it encodes like
  any other literal underscore ("Beautiful_002" -> "Beautiful__002").
- A prompt_data file is allowed to exist WITHOUT a UID in its filename
  (e.g. dropped in manually from another workflow, or generated outside
  this node). UID is not required to list/query a prompt.
- UID is assigned and the file is renamed on disk at SCAN time, not at
  entry-creation or entry-save time. By the time anything above this
  module ever sees a prompt_data, it always already has a UID. This
  also means two different Entries built from the same not-yet-UID'd
  file never race each other into generating two different UIDs -- the
  rename happens once, during the scan, before any Entry exists.
  "Already normalized", however, means the UID MATCHES the content
  (uid == generate_uid(name, prompt text)) -- a hand-renamed or
  legacy-scheme UID is only a filename shape. When two files carry the
  SAME name+text identity and both look normalized, the scan resolves
  them: the content-consistent file keeps its stem (preset refs stay
  valid) and each inconsistent twin is reladdered like a fresh import
  (display suffix + UID regenerated from the final name). No twin is
  consistent -> the first in sorted order keeps its name untouched.

Compatibility
-------------
Two file types can be ingested from the library folder:

1. PNG. Two acceptable shapes:
   a. Carries an attached ComfyUI `workflow` (or `prompt`) graph
      containing a node that is BOTH titled "user_prompt" AND of type
      "PrimitiveStringMultiline" (ComfyUI's native multiline-string
      primitive -- see USER_PROMPT_NODE_TYPE) with non-empty text.
      That text becomes prompt_data.prompt.
   b. Carries no such workflow/node at all (a plain image with no
      embedded prompt). This is still accepted as a name+thumbnail
      prompt: prompt_data.prompt is set to the file's own name (see
      "Naming" below) rather than being left empty -- an Entry always
      has SOME text to contribute, even if the person hasn't written a
      real prompt yet.
   In both cases the image itself must be at least 32x32 pixels in
   both dimensions; anything smaller is rejected outright (not
   upscaled -- too small to plausibly be a real thumbnail rather than
   accidental/garbage input). Images larger than the library thumbnail
   size are center-cropped and resized down (see LIBRARY_THUMB_SIZE);
   this happens at import/scan time and overwrites the original image
   bytes with the resized/re-encoded version -- there is no "original
   size" kept anywhere.

2. TXT. A plain-text file sitting directly in the library folder
   alongside PNGs is a prompt with NO thumbnail, and it stays a .txt --
   it is never converted into a PNG. `scan_library()` recognizes these
   (no separate upload route is needed): its filename (minus extension)
   becomes the name and its text content becomes prompt_data.prompt,
   and it is normalized in place exactly like an un-UID'd PNG -- name
   folded, a UID assigned, renamed to the usual `Name_UID.txt`
   convention. A .txt may carry a category tag list in a single leading
   `#pc_meta {...}` line (see PC_TXT_META_PREFIX); a .txt with no such
   line has no category. Everything after that optional line is the
   prompt text.

A prompt's on-disk shape is decided purely by whether it has a
thumbnail: a prompt WITH one is a `Name_UID.png` (image + embedded
workflow + embedded category tags); a prompt WITHOUT one is a
`Name_UID.txt` (text + optional category front-matter). Adding a
thumbnail to a .txt rewrites it as a .png and removes the .txt; removing
a thumbnail from a .png does the reverse (see update_prompt_data). The
UI renders a thumbnail-less prompt as a dark tile with an orange
"image off" glyph, never a placeholder image.

That shape rule also decides duplicates: if a `Name.txt` and a
`Name.png` hold the SAME prompt text (identity = case-folded name +
canonical text -- the UID formula's own inputs, so matching twins
share their `Name_UID` ref stem), the PNG is the same prompt with more
(it has the thumbnail), and the .txt is the older shape of it. Every
scan (library load, import refresh, "Rescan library folder") deletes
such a duplicate .txt from disk -- category tags only it carried are
merged into the PNG first -- and the PNG keeps the unsuffixed entry
where the classic collision rule would otherwise have made a "_002"
sibling. The reverse case needs no rule: `resolve()` already prefers
the .png for any stem both files share.

Anything else found while scanning the library folder (any other
extension, or a PNG that fails the minimum-size check) is silently
skipped -- no error, no warning surfaced to the user.

Naming
------
Two names exist for every prompt: the
human-readable Prompt Name shown in the UI, and the encoded name portion
of the prompt_data filename. They are related by an exact, reversible
encoding -- they are NOT the same string.

correct_prompt_name() turns raw editor input into a Prompt Name:
characters that are illegal in a filename (Windows' reserved set
`\\ / : * ? " < > |` plus control characters) become spaces, runs of
whitespace collapse to a single space, leading/trailing spaces are
trimmed, and the name must start with a word character or number
(leading punctuation is dropped; an input with nothing usable falls
back to "Prompt"). Names differing only by case are the same name --
the UID is hashed case-folded and the "already exists" check compares
case-insensitively.

encode_prompt_name() turns a Prompt Name into the filename's name
portion by per-character escaping: every literal "_" doubles to "__"
(underscores first), then every space becomes a single "_".
decode_prompt_name() is the greedy inverse ("__" -> "_", lone "_" ->
space), so "Bright Sun" stores as "Bright_Sun", "Bright_Sun" stores as
"Bright__Sun", "Bright__Sun" stores as "Bright____Sun". A collision
suffix is part of the name itself ("Beautiful_002" stores as
"Beautiful__002"), so it round-trips like any other characters -- there
is no special suffix interpretation on read.
Rule 8 in correct_prompt_name/_finalize_prompt_name removes any space
touching a literal "_", which is what makes this encoding injective on
corrected names: every encoded underscore-run is then unambiguously
even (literal underscores) or a lone "_" (a space).

For BOTH a workflow-less PNG (1b above) and a .txt import (2 above),
the prompt's name is always the file's own name (minus extension),
decoded through decode_prompt_name() -- never a placeholder, a
prompt-derived guess, or something asked of the user at import time.
An imported stem is normalized by normalize_imported_stem() (spaces and
illegal characters fold to "_") and then stored as-is (with the SAME
extension it arrived with -- a .txt stays a .txt); the person can rename
it afterward like any other library entry.

The name portion is always everything before the trailing "_<uid>": the
last "_<8 digits>" segment of the filename stem is stripped off by
split_name_uid()/UID_RE, regardless of how many underscores the encoded
name itself contains. `prompt_ref` and `filename` stay canonical --
`resolve()` turns a prompt_ref back into a path by string building, and
presets store it verbatim -- so nothing about the stored name is ever
rewritten once it's on disk except by an actual rename. Files that
already carry a UID are never re-encoded at scan time (their refs may be
referenced by presets); only their display name is decoded.

Categories
----------
Categories are DUAL-WRITE: each prompt_data carries its own embedded
category tags -- a private tEXt/iTXt key we control on a PNG (separate
from ComfyUI's own "workflow"/"prompt" keys), or the leading
`#pc_meta {...}` line on a thumbnail-less .txt (see PC_TXT_META_PREFIX)
-- which is what keeps a single dragged-out file fully portable and
self-describing on its own. In ADDITION, a sidecar
index file (library/_categories.json) tracks the set of category names
that exist as first-class, manageable things -- this is what makes
"create/rename/delete a category" possible as a real operation rather
than only an implicit side effect of tagging a prompt. The sidecar is
authoritative for CATEGORY IDENTITY (the list of names, and renaming/
deleting a name everywhere); each file's embedded tags remain the
authoritative record of which categories THAT prompt belongs to.
Renaming or deleting a category walks every library prompt_data (PNG and
TXT alike) and rewrites/removes the matching embedded tag, so both copies
stay in sync. A
category can exist in the sidecar with zero prompts currently tagged
(e.g. just created, or its last prompt was deleted/untagged) -- this is
valid and is exactly what "Hide Empty" is for.

The index is APPEND-ONLY from the files side: every scan_library() ends by
registering any tag it saw on a file that isn't in the index yet (see
_register_categories_from_scan). That is what makes a prompt_data file
dropped into the folder from outside the app -- copied in, restored from
a backup, dragged out and back -- appear in the category list on the next
scan instead of staying invisible until that prompt happened to be
edited. A scan never REMOVES an index entry, so an empty category is
still allowed to exist; only delete_category removes one.

One category is BUILT-IN: "Favorite" (see FAVORITE_CATEGORY). The library
folder and `_categories.json` are created on import and re-checked on
every read, with Favorite seeded into the index, so it is always present,
always sorts first, and cannot be renamed or deleted. It is otherwise an
ORDINARY category -- just another embedded tag on the prompt_data (a PNG
chunk or a .txt meta line), added and
removed through the same set_category/update_prompt_data path -- which is
what keeps a file dragged out of the library carrying its favorite state
with it. Only its presentation is special: the UI renders it as a star on
the card instead of as one of the category badges.

"Already exists" rule
----------------------
UID = hash(canonical(name.lower()) + canonical(prompt)), where
canonical() means NFC Unicode normalization, CRLF/CR folded to LF, and
outer whitespace stripped -- so the same prompt produces the same UID
on every machine and through every path (editor save, import, rescan).
If a proposed new/edited prompt_data would produce the same name
(compared case-insensitively, since names that differ only by case are
identical names) AND the same content as an existing library entry --
matched by UID, or by canonical text for files whose stored UID
predates the current scheme -- the content is identical, and creation
must be blocked; the existing entry should be used instead.
Collision protection (a trailing "_002"-style number appended to the
display name -- reusing a trailing "_" -- with the UID regenerated from
the suffixed name) applies to IMPORTS only -- see "Filename convention"
above.
"""

import hashlib
import io
import json
import logging
import os
import re
import shutil
import threading
import time
import unicodedata
import uuid as uuid_lib

from PIL import Image, PngImagePlugin

try:
    from . import image_utils
    from . import paths
    from .errors import AlreadyExistsError
except ImportError:  # pragma: no cover - allows standalone import during tests
    import image_utils
    import paths
    from errors import AlreadyExistsError


NODE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

log = logging.getLogger("prompt_composer")

# Sentinel for update_prompt_data's `folder` parameter: distinguishes
# "caller didn't mention folder at all -- leave it wherever it is" from
# "caller explicitly wants it at the library root" (folder=""). A plain
# default of None can't carry that distinction since "" and None would
# otherwise mean the same thing.
_UNSET = object()


def _lib_dir() -> str:
    """The library folder (see server/paths.py). Resolved lazily -- this
    module has NO import-time filesystem side effects, so importing it
    (tests, tooling, a docs build) never creates directories."""
    return paths.library_dir()


def _categories_index_path() -> str:
    return os.path.join(_lib_dir(), "_categories.json")


def _trash_dir() -> str:
    """Where a superseded prompt_data file is moved instead of being
    deleted outright (see scan_library's duplicate rule)."""
    return os.path.join(_lib_dir(), "_trash")


# The scan mutates the folder (renames, ingests, retires duplicates), so
# two concurrent scans could interleave the collision ladder and hand out
# duplicate "_002" names. One lock makes the whole pass atomic; it also
# guards the module-level read/memo caches those passes share between the
# aiohttp event loop and ComfyUI's execution worker thread.
_SCAN_LOCK = threading.RLock()

USER_PROMPT_NODE_TITLE = "user_prompt"

# The ONLY node type accepted as a "user_prompt" node -- ComfyUI's
# native multiline-string primitive (documented I/O: one required
# STRING input widget named "value", one STRING output named
# "output"). Both the title AND this type must match for a node to be
# recognized (see _find_user_prompt_text) -- a node merely titled
# "user_prompt" but of some other type (e.g. a regular CLIPTextEncode,
# or a differently-typed primitive) does NOT qualify. This is
# intentionally strict: matching on title alone would accept any node
# a person happened to rename, including ones whose "text" isn't
# stored where we expect it, silently producing garbage or empty
# prompt content.
USER_PROMPT_NODE_TYPE = "PrimitiveStringMultiline"


# Our own private embedded metadata keys. Chosen to be unlikely to
# collide with anything ComfyUI or other tooling writes into a PNG's
# text chunks. We only ever read/write these two keys and never touch
# "workflow" or "prompt" (ComfyUI's own keys) except to READ the
# workflow graph in order to locate the user_prompt node.
PC_CATEGORIES_KEY = "pc_categories"
PC_MANAGED_KEY = "pc_managed"  # marker so we know we authored/normalized this file

# A prompt with no thumbnail lives as a plain .txt file (see the module
# docstring's "Compatibility" section). Its whole content is the prompt
# text, EXCEPT for an optional single metadata line at the very top that
# carries the category tag list -- so a category can be attached to a
# thumbnail-less prompt without a sidecar. The line is
# `#pc_meta {"categories": [...]}`; a .txt with no such first line is a
# bare prompt with no category. The prefix is deliberately unlikely to
# start real prompt prose, and read_txt_prompt_data() only honors it when
# the rest of the line parses as a JSON object, so a prompt that happens
# to begin with the literal text never loses its first line.
PC_TXT_META_PREFIX = "#pc_meta "

UID_RE = re.compile(r"^(.*?)_(\d{8})$")

# Characters that are illegal in a filename on at least one supported
# operating system -- Windows' reserved set plus every control
# character. In a Prompt Name these become a space; in a stored
# filename they can only ever arrive via an outside import, where
# normalize_imported_stem() folds them into "_".
_INVALID_FILENAME_CHARS_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

# Fallback for a name whose corrected form would otherwise be empty
# (the system must never create an empty Prompt Name; the exact
# fallback is the implementation's call).
PROMPT_NAME_FALLBACK = "Prompt"

_MAX_PROMPT_NAME_CHARS = 128
_MAX_IMPORTED_STEM_CHARS = 256

LIBRARY_THUMB_SIZE = 256


# ---------------------------------------------------------------------------
# Filename / UID helpers
# ---------------------------------------------------------------------------

def split_name_uid(stem: str):
    """Split a filename stem (no extension) into (name, uid_or_None).

    A UID is only recognized if the final "_<digits>" segment is
    EXACTLY 8 digits. Anything else (no trailing number, wrong digit
    count) is treated as having no UID, and the whole stem is the name.
    """
    match = UID_RE.match(stem)
    if match:
        return match.group(1), match.group(2)
    return stem, None


def canonical_prompt_text(prompt: str) -> str:
    """The identity form of a prompt text.

    Two prompts that LOOK the same must BE the same for identity
    purposes, even when their bytes differ for reasons nobody chose:

    - Unicode normalization: macOS stores filenames (and often pasted
      text) decomposed (NFD: "e" + combining acute) while Windows and
      Linux keep them composed (NFC). "Café" written on one machine is
      a different code-point sequence than on another.
    - Line endings: a workflow authored on Windows may carry "\\r\\n"
      where the editor sends "\\n".
    - Outer whitespace: the editor trims before sending; text embedded
      in a PNG by another tool may not be.

    NFC + CRLF/CR -> LF + strip. Used for the UID material and for the
    text-identity comparison in check_already_exists(), so both agree
    on what "the same prompt" means. Mirror of canonicalPromptText()
    in web/js/naming.js -- keep the two in sync.
    """
    text = unicodedata.normalize("NFC", prompt or "")
    if "\r" in text:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text.strip()


def generate_uid(name: str, prompt: str) -> str:
    """Deterministic 8-digit UID from name + prompt text.

    The name is case-folded first: names that differ only by case are
    the same name, so "Bright Sun"
    and "bright sun" must hash to the same UID for the same prompt --
    that is what lets the "already exists" check treat them as one.
    Both parts are canonicalized (NFC, LF newlines, trimmed) so the
    same prompt produces the same UID on every machine and through
    every path (editor save, import, rescan) -- see
    canonical_prompt_text().

    Uses a stable hash (sha256) rather than Python's salted built-in
    hash(), truncated/reduced to 8 decimal digits. Deterministic across
    processes and runs, which is required since the "already exists"
    check depends on two independently-computed UIDs for the same
    name+prompt agreeing.
    """
    material = (
        f"{unicodedata.normalize('NFC', name or '').lower()}\x00{canonical_prompt_text(prompt)}"
    ).encode("utf-8")
    digest = hashlib.sha256(material).hexdigest()
    # Reduce the hex digest to an 8-digit decimal number.
    as_int = int(digest, 16) % 100_000_000
    return f"{as_int:08d}"


def _finalize_prompt_name(text: str) -> str:
    """Shared tail of every name correction: invalid filename characters become spaces, runs
    of whitespace collapse to a single space, leading/trailing spaces
    are trimmed, any space immediately before or after a literal "_" is
    removed (rule 8 -- it makes the per-character encoding injective),
    and leading characters up to (but not including) the first word
    character or number are dropped -- a Prompt Name always starts with
    a word or number. Text is NFC-normalized first so a name typed on a
    decomposed-Unicode machine (macOS) is stored identically to the
    same-looking name from anywhere else. May return ""; callers apply
    their own fallback.
    """
    text = unicodedata.normalize("NFC", text or "")
    text = _INVALID_FILENAME_CHARS_RE.sub(" ", text)
    text = re.sub(r"\s{2,}", " ", text).strip()
    # Rule 8: drop spaces touching a literal "_". One pass is provably
    # enough: after the collapse above every space is isolated, so
    # deleting spaces can neither create a new space-underscore
    # adjacency nor a new space run (and it cannot touch the trimmed
    # edges, which are non-space).
    text = re.sub(r"(?<=_) +| +(?=_)", "", text)
    start = 0
    while start < len(text) and not text[start].isalnum():
        start += 1
    return text[start:][:_MAX_PROMPT_NAME_CHARS].rstrip()


def correct_prompt_name(raw: str, fallback: str = PROMPT_NAME_FALLBACK) -> str:
    """Raw editor input -> corrected Prompt Name.

    Invalid filename characters are replaced with a SPACE (they become
    "_" only later, when the name is encoded into a filename),
    consecutive spaces merge, and leading/trailing spaces are removed.
    Never returns empty: input with no usable starting character falls
    back to `fallback`.
    """
    return _finalize_prompt_name(raw) or fallback


def encode_prompt_name(name: str) -> str:
    """Prompt Name -> the name portion of a prompt_data filename.

    Per-character escaping:
    every literal "_" doubles to "__", and every space becomes a single
    "_". Underscores are doubled FIRST so the "_" produced from a space
    is never mistaken for part of an escaped underscore. So "Bright Sun"
    -> "Bright_Sun", "Bright_Sun" -> "Bright__Sun", "Bright__Sun" ->
    "Bright____Sun".

    decode_prompt_name() is the exact inverse for every CORRECTED name:
    rule 8 guarantees a Prompt Name never has a space adjacent to "_",
    which makes every encoded underscore-run either even (literal
    underscores) or a lone "_" (a space) -- unambiguously decodable.
    (Non-canonical imported stems may still carry odd runs; decode
    projects them to the canonical name.)
    """
    return name.replace("_", "__").replace(" ", "_")


def decode_prompt_name(encoded_stem: str) -> str:
    """The name portion of a stored filename -> Prompt Name.

    Greedy inverse of encode_prompt_name: scan left to right, "__" -> a
    literal "_", a lone "_" -> a space. A collision suffix is part of the
    name, so "Bright_Sun__002" reads back as "Bright Sun_002" exactly --
    no special casing, the "_002" is just a literal underscore run.

    The decoded text is re-validated through _finalize_prompt_name, so
    rule 8 applies here too: a non-canonical stem like "Bright___Sun"
    projects to "Bright_Sun" (never to "Bright_ Sun"). Never returns
    empty.
    """
    s = encoded_stem or ""
    out = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == "_":
            if i + 1 < n and s[i + 1] == "_":
                out.append("_")
                i += 2
            else:
                out.append(" ")
                i += 1
        else:
            out.append(c)
            i += 1
    return _finalize_prompt_name("".join(out)) or PROMPT_NAME_FALLBACK


def normalize_imported_stem(stem: str) -> str:
    """An imported (not-yet-stored) filename stem -> the stored name
    portion.

    Spaces fold to "_", characters illegal in a filename fold to "_",
    leading/trailing dots are dropped (Windows strips them anyway), and
    the result is length-capped. Everything else is kept verbatim --
    the stem is stored as-is after this correction, and the Prompt Name
    is whatever decode_prompt_name() reads back from it.

    One normalization is applied to a trailing underscore run: if it is
    ODD, one more "_" is appended to make it even. A Prompt Name can
    never END in a space (rule 6 trims trailing spaces), so a lone
    trailing "_" cannot be a valid encoding of any real name -- it is a
    LITERAL underscore the importer wrote once instead of doubling it.
    Doubling it keeps that underscore from being swallowed (and, once
    scan_library() appends the "_<uid>" separator, keeps the separator
    unambiguous): "Bright_Sun_" -> "Bright_Sun__" -> stored as
    "Bright_Sun___<uid>" -- two underscores for the literal "_", one for
    the UID separator. An even trailing run is already a valid literal
    underscore encoding and is left untouched, so re-importing a
    UID-stripped file is stable.
    """
    cleaned = _INVALID_FILENAME_CHARS_RE.sub("_", stem or "")
    cleaned = cleaned.replace(" ", "_").strip(".")
    cleaned = cleaned[:_MAX_IMPORTED_STEM_CHARS]
    trailing_run = len(cleaned) - len(cleaned.rstrip("_"))
    if trailing_run % 2 == 1:
        cleaned += "_"
    return cleaned or PROMPT_NAME_FALLBACK


def collision_suffix(n: int) -> str:
    """The raw unified trailing-number suffix: "_" + number, at least three digits, width growing
    naturally past 999. Mirror of collisionSuffix() in web/js/naming.js.
    Prefer apply_collision_suffix() to attach it to a name (it handles a
    trailing "_"); this is just the suffix itself.
    """
    return f"_{n:03d}"


def apply_collision_suffix(base: str, n: int) -> str:
    """Attach the unified trailing number to a DISPLAY name.

    The number is always preceded by an underscore -- except when the
    base already ends in one, which is reused rather than doubled:
    "Beautiful" + 2 -> "Beautiful_002", "Bright_" + 2 -> "Bright_002".
    The result is an ordinary Prompt Name (the suffix carries no special
    meaning), so encode_prompt_name() doubles its "_" like any other
    literal underscore ("Bright_002" -> "Bright__002"). Mirror of
    applyCollisionSuffix() in web/js/naming.js -- keep the two in sync;
    sections and preset defaults use the same rule client-side.
    """
    if base.endswith("_"):
        return f"{base}{n:03d}"
    return f"{base}{collision_suffix(n)}"


def lowest_free_number(base: str, is_taken, start_at: int = 2) -> int:
    """The lowest n >= start_at for which apply_collision_suffix(base, n)
    is free. `is_taken` receives the FULL suffixed name, so each name
    space can compare on whatever it keys on (display name, filename,
    ...). Mirror of lowestFreeNumber() in web/js/naming.js.
    """
    n = start_at
    while is_taken(apply_collision_suffix(base, n)):
        n += 1
    return n


def to_client_entry(entry: dict | None) -> dict | None:
    """Copy of a library entry for anything crossing the HTTP boundary
    to the browser.

    `name` is the decoded, human-readable Prompt Name (see
    decode_prompt_name) -- the encoded filename half is carried in
    `name_portion`/`prompt_ref`/`filename` and is never what the UI
    renders. This function is kept (rather than sending `entry`
    directly) as the one seam where any future display-only transform
    would go, and so call sites don't need to change if that ever
    happens.
    """
    if not entry:
        return entry
    return dict(entry)


def _resolve_within_library(filename: str) -> str:
    """Resolve `filename` under _lib_dir(), refusing path traversal."""
    candidate = os.path.normpath(os.path.join(_lib_dir(), filename))
    base = os.path.normpath(_lib_dir())
    if candidate != base and not candidate.startswith(base + os.sep):
        raise ValueError("Invalid path")
    return candidate


def get_library_file_path(filename: str) -> str:
    """Public accessor: resolve a library filename to its on-disk path,
    refusing path traversal. Used by routes.py to serve thumbnail
    images without reaching into this module's private helpers.
    """
    return _resolve_within_library(filename)


# ---------------------------------------------------------------------------
# PNG metadata read/write
# ---------------------------------------------------------------------------

MIN_LIBRARY_IMAGE_DIMENSION = 32  # reject (not upscale) any import smaller than this in either dimension


def _read_png_text_chunks(path: str) -> dict:
    """Return the raw text-chunk dict (tEXt/iTXt/zTXt) of a PNG."""
    with Image.open(path) as img:
        return dict(getattr(img, "text", {}) or {})


def _read_png_size(path: str) -> tuple[int, int] | None:
    """Return (width, height) of a PNG on disk, or None if it can't be
    opened as an image at all."""
    try:
        with Image.open(path) as img:
            return img.size
    except Exception:
        return None


def _find_user_prompt_text(workflow_json) -> str | None:
    """Given a parsed ComfyUI workflow (either the editor "workflow"
    graph format with a `nodes` list, or the API "prompt" format keyed
    by node id), find a node that is BOTH titled "user_prompt" AND of
    type "PrimitiveStringMultiline" (USER_PROMPT_NODE_TYPE), and return
    its text value, or None if no such node exists / its value is
    empty.

    Matching requires BOTH title and type -- neither alone is
    sufficient. This is stricter than an earlier version of this
    function, which accepted a node matching EITHER its title OR its
    type/class_type against "user_prompt". That looser rule could
    match an unrelated node whose type happened to literally be
    "user_prompt" (never actually possible in stock ComfyUI, but not
    guarded against) as readily as a real PrimitiveStringMultiline a
    person renamed -- and, more importantly, doesn't verify the node
    it found is actually a multiline text primitive at all, so a
    same-titled node of a different type could be "matched" and then
    fail to yield any usable text (or worse, yield text from the wrong
    field). Requiring the real type guarantees whatever we find is
    genuinely a PrimitiveStringMultiline, so we know exactly where its
    value lives.
    """
    if workflow_json is None:
        return None

    # Editor "workflow" format: {"nodes": [{... "title": "...",
    # "type": "...", "widgets_values": [...]}, ...]}
    if isinstance(workflow_json, dict) and isinstance(workflow_json.get("nodes"), list):
        for node in workflow_json["nodes"]:
            if not isinstance(node, dict):
                continue
            title = node.get("title") or ""
            node_type = node.get("type") or ""
            if title == USER_PROMPT_NODE_TITLE and node_type == USER_PROMPT_NODE_TYPE:
                widgets_values = node.get("widgets_values")
                text = _extract_text_from_widgets_values(widgets_values)
                if text:
                    return text
        return None

    # API "prompt" format: {"<node_id>": {"class_type"/"_meta": {...},
    # "inputs": {...}}, ...}
    if isinstance(workflow_json, dict):
        for node in workflow_json.values():
            if not isinstance(node, dict):
                continue
            meta = node.get("_meta") or {}
            title = meta.get("title") or ""
            class_type = node.get("class_type") or ""
            if title == USER_PROMPT_NODE_TITLE and class_type == USER_PROMPT_NODE_TYPE:
                inputs = node.get("inputs") or {}
                # PrimitiveStringMultiline's documented input widget is
                # named "value" -- that's the one and only field we
                # trust for this node type once matched.
                if isinstance(inputs.get("value"), str):
                    return inputs["value"]
        return None

    return None


def _extract_text_from_widgets_values(widgets_values):
    """Read the text value out of a PrimitiveStringMultiline node's
    `widgets_values` (editor "workflow" format). This node has exactly
    one widget ("value"), so `widgets_values` is a one-element list
    holding that string -- support both that list shape and, for
    forward/backward robustness, a dict keyed by the widget's own name.
    """
    if widgets_values is None:
        return None
    if isinstance(widgets_values, list):
        for value in widgets_values:
            if isinstance(value, str) and value.strip():
                return value
        return None
    if isinstance(widgets_values, dict):
        if isinstance(widgets_values.get("value"), str):
            return widgets_values["value"]
    return None


def _read_png_prompt_data(path: str) -> dict | None:
    """Read one prompt_data PNG from disk and return its resolved
    fields, or None if the file is missing / unreadable as an image.

    Two shapes are both considered compatible (see module docstring's
    "Compatibility" section):
      - a PNG with an embedded user_prompt workflow -> prompt_text
        comes from that node's value.
      - a PNG with no such workflow (or no workflow at all) -> the
        prompt is not present at read time; the caller (scan_library)
        is responsible for falling back to the file's own name and
        writing that back as a real embedded workflow, since this
        function itself never writes to disk.

    "uid_source" in the returned dict is None when there's no valid
    embedded workflow, distinguishing "genuinely has no prompt yet"
    from "has a prompt but no UID assigned" -- scan_library() uses
    this to decide whether it needs to synthesize+embed a workflow
    (image-only import) in addition to the usual UID-assignment
    rename.

    Returned dict:
        {
            "name": str,                # decoded Prompt Name (display)
            "name_portion": str,        # raw encoded name half of the stem
            "uid": str | None,          # None if not yet assigned (pre-scan-normalize)
            "prompt": str | None,       # None if no user_prompt node was found at all
            "category": list[str],
            "filename": str,            # current on-disk filename
        }
    Returns None only if the file is missing or not a decodable PNG at
    all (i.e. not even usable as a plain image).
    """
    if not os.path.isfile(path):
        return None

    size = _read_png_size(path)
    if size is None:
        return None  # not a decodable image at all -- silently skipped
    width, height = size
    if width < MIN_LIBRARY_IMAGE_DIMENSION or height < MIN_LIBRARY_IMAGE_DIMENSION:
        return None  # too small to be a real thumbnail -- rejected, not upscaled

    try:
        chunks = _read_png_text_chunks(path)
    except Exception:
        return None

    prompt_text = None
    workflow_raw = chunks.get("workflow") or chunks.get("prompt")
    if workflow_raw:
        try:
            workflow_json = json.loads(workflow_raw)
        except (json.JSONDecodeError, TypeError):
            workflow_json = None
        if workflow_json is not None:
            found = _find_user_prompt_text(workflow_json)
            if found and found.strip():
                prompt_text = found

    filename = os.path.basename(path)
    stem, _ext = os.path.splitext(filename)
    name_portion, uid = split_name_uid(stem)

    category_raw = chunks.get(PC_CATEGORIES_KEY)
    category = []
    if category_raw:
        try:
            parsed = json.loads(category_raw)
            if isinstance(parsed, list):
                category = [str(c) for c in parsed if isinstance(c, (str, int))]
        except (json.JSONDecodeError, TypeError):
            category = []

    return {
        "name": decode_prompt_name(name_portion),
        "name_portion": name_portion,
        "uid": uid,
        "prompt": prompt_text,
        "category": category,
        "filename": filename,
        "has_thumbnail": True,
    }


def read_txt_prompt_data(path: str) -> dict | None:
    """Read one thumbnail-less prompt_data .txt from disk.

    The file's whole content is the prompt text, minus an optional
    leading `#pc_meta {...}` line that carries the category list (see
    PC_TXT_META_PREFIX). Returns the same dict shape as
    _read_png_prompt_data() -- with "has_thumbnail": False and "prompt"
    always a real string -- or None if the file is missing, undecodable,
    or empty (an empty .txt is not a usable prompt, so scan skips it).
    """
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except (OSError, UnicodeDecodeError):
        return None
    if content.startswith("\ufeff"):
        content = content[1:]  # strip a UTF-8 BOM some editors prepend

    prompt = content
    category: list = []
    newline = prompt.find("\n")
    first_line = prompt if newline == -1 else prompt[:newline]
    if first_line.startswith(PC_TXT_META_PREFIX):
        try:
            meta = json.loads(first_line[len(PC_TXT_META_PREFIX):])
        except (json.JSONDecodeError, TypeError):
            meta = None
        if isinstance(meta, dict):
            cats = meta.get("categories")
            if isinstance(cats, list):
                category = [str(c) for c in cats if isinstance(c, (str, int))]
            # Only strip the first line when it really was our meta line;
            # a prompt that merely starts with the literal prefix but
            # whose remainder isn't a JSON object keeps its first line.
            prompt = prompt[newline + 1:] if newline != -1 else ""

    if not prompt.strip():
        return None

    filename = os.path.basename(path)
    stem, _ext = os.path.splitext(filename)
    name_portion, uid = split_name_uid(stem)

    return {
        "name": decode_prompt_name(name_portion),
        "name_portion": name_portion,
        "uid": uid,
        "prompt": prompt,
        "category": category,
        "filename": filename,
        "has_thumbnail": False,
    }


def read_prompt_data(path: str) -> dict | None:
    """Read one prompt_data file from disk, dispatching on extension:
    a .png goes through _read_png_prompt_data(), a .txt through
    read_txt_prompt_data(). Anything else returns None (silently
    skipped by scan_library). Both branches return the same dict shape,
    distinguished by the "has_thumbnail" flag.
    """
    if path.lower().endswith(".txt"):
        return read_txt_prompt_data(path)
    return _read_png_prompt_data(path)


# ---------------------------------------------------------------------------
# mtime-keyed read cache
# ---------------------------------------------------------------------------
# scan_library() pass 1 fully parses EVERY candidate file (a PIL decode +
# text-chunk walk per PNG), and it re-runs on every library refresh --
# which the client does after every edit, star toggle, and create. Without
# a cache, repeated refreshes would cost O(entire library) on the CPU for
# no reason: unchanged files parse to identical data. This cache keys each
# parsed result on (size, mtime_ns), so a steady-state scan only stats
# files, and only files that actually changed (or entered the folder) get
# decoded again.
#
# Correctness notes:
#  - Every write path in this module goes through _write_prompt_data_*
#    or os.remove, and all of them drop the affected key explicitly, so
#    an in-process rewrite can never be masked by a filesystem whose
#    mtime granularity is too coarse to distinguish old from new.
#  - External changes (files edited/copied in outside the app) always
#    move size or mtime_ns, which the signature check catches. A file
#    REPLACED with byte-identical size AND mtime from outside is the
#    one case that reads stale; the explicit "Rescan library folder"
#    button (scan_library_page(force=True)) clears the whole cache for
#    exactly that pathological case.
#  - Returned dicts are copies (plus a copied category list): callers
#    like scan_library pass 2 mutate what they get, and that must never
#    leak back into the cached record.

_PROMPT_READ_CACHE: dict[str, tuple] = {}  # path -> ((size, mtime_ns), data|None)
_PROMPT_READ_CACHE_MAX = 5000  # unbounded growth would need an unbounded folder;
#                               # on overflow the whole map is dropped (cheap to
#                               # rebuild, and keeps this memory-bounded)


def _copy_prompt_data(data: dict | None) -> dict | None:
    if data is None:
        return None
    copied = dict(data)
    if isinstance(copied.get("category"), list):
        copied["category"] = list(copied["category"])
    return copied


def _drop_prompt_read(path: str) -> None:
    """Remove `path` from the read cache. Called by every write/rename/
    delete site in this module so a just-written file is always parsed
    fresh, regardless of filesystem mtime granularity."""
    with _SCAN_LOCK:
        _PROMPT_READ_CACHE.pop(path, None)


def read_prompt_data_cached(path: str) -> dict | None:
    """read_prompt_data() with the (size, mtime_ns)-keyed cache above.
    Same contract as read_prompt_data(); only the parsing is skipped
    when the file is provably unchanged since the last read."""
    try:
        st = os.stat(path)
    except OSError:
        # Missing/unreadable: defer to the plain reader so behavior
        # (silently None, or its own error handling) is identical, and
        # forget any stale record for a path that just disappeared.
        _drop_prompt_read(path)
        return read_prompt_data(path)
    sig = (st.st_size, st.st_mtime_ns)
    # _SCAN_LOCK (re-entrant) also guards this map: it is read and
    # written from BOTH the aiohttp event loop and ComfyUI's execution
    # worker thread (compose -> resolve -> here), and scan_library holds
    # the same lock while mutating the very files it caches.
    with _SCAN_LOCK:
        hit = _PROMPT_READ_CACHE.get(path)
        if hit is not None and hit[0] == sig:
            return _copy_prompt_data(hit[1])
    data = read_prompt_data(path)
    with _SCAN_LOCK:
        if len(_PROMPT_READ_CACHE) >= _PROMPT_READ_CACHE_MAX:
            _PROMPT_READ_CACHE.clear()
        _PROMPT_READ_CACHE[path] = (sig, _copy_prompt_data(data))
    return _copy_prompt_data(data)


def _remove_quietly(path: str) -> None:
    """Delete `path` if it is still there, swallowing every error. Used
    to clean up the temp file of an atomic write -- on the success path
    os.replace() already consumed it, so "not found" is the normal
    case."""
    try:
        os.remove(path)
    except OSError:
        pass


def _write_prompt_data_txt(path: str, prompt: str, category: list | None = None) -> None:
    """Write (or overwrite) a thumbnail-less prompt_data .txt at `path`.

    With no category the file is just the raw prompt text -- a plain,
    human-editable .txt. With categories, a single leading
    `#pc_meta {"categories": [...]}` line is prepended (see
    PC_TXT_META_PREFIX) so the tags ride in the file itself, exactly as
    they ride in a PNG's tEXt chunks.
    """
    if category:
        meta = json.dumps({"categories": list(category)}, ensure_ascii=False)
        content = f"{PC_TXT_META_PREFIX}{meta}\n{prompt}"
    else:
        content = prompt

    tmp_path = path + f".tmp-{uuid_lib.uuid4().hex}"
    try:
        with open(tmp_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        os.replace(tmp_path, path)
    finally:
        # A failed write must not leave a stray .tmp-<hex> behind. (The
        # scan ignores them, so they were invisible litter that only
        # ever grew.) os.replace() already consumed the temp on success.
        _remove_quietly(tmp_path)
    _drop_prompt_read(path)


def _write_prompt_data_png(path: str, base_image_bytes: bytes, workflow_json: dict,
                            category: list | None = None) -> None:
    """Write (or overwrite) a prompt_data PNG at `path`.

    `base_image_bytes`: raw bytes of the thumbnail image to embed the
    metadata into. A prompt_data PNG always carries a real thumbnail --
    a prompt with no image lives as a .txt instead (see
    _write_prompt_data_txt), so this is required, never a placeholder.
    `workflow_json`: the full workflow dict to embed under the
    "workflow" key so the file remains drag-and-droppable into ComfyUI.
    `category`: list of category tag strings to embed (empty/None ->
    no category).
    """
    if base_image_bytes is None:
        raise ValueError("A prompt_data PNG requires thumbnail image bytes")
    clean_png_bytes = image_utils.sanitize_image_bytes(base_image_bytes, LIBRARY_THUMB_SIZE)
    img = Image.open(io.BytesIO(clean_png_bytes))

    png_info = PngImagePlugin.PngInfo()
    png_info.add_text("workflow", json.dumps(workflow_json, ensure_ascii=False))
    png_info.add_text(PC_MANAGED_KEY, "1")
    if category:
        png_info.add_text(PC_CATEGORIES_KEY, json.dumps(list(category), ensure_ascii=False))

    tmp_path = path + f".tmp-{uuid_lib.uuid4().hex}"
    try:
        img.save(tmp_path, format="PNG", pnginfo=png_info, optimize=True)
        os.replace(tmp_path, path)
    finally:
        _remove_quietly(tmp_path)
    _drop_prompt_read(path)


# ---------------------------------------------------------------------------
# Metadata-only rewrite (no pixel re-encode)
# ---------------------------------------------------------------------------
# Changing a prompt's CATEGORY TAGS deliberately does not go through
# update_prompt_data(), which re-reads the PNG, re-sanitizes it, crops,
# resizes and re-encodes the whole image just to change one text chunk.
# For a category rename across a few hundred prompts that would be hundreds
# of full PNG encodes; for the favourite star it would be one per click.
#
# A PNG is a chunk stream, so the tags can be swapped by rewriting the
# bytes directly: copy every chunk through, drop the old pc_categories
# tEXt, and splice a new one in before IEND. Pixel data (IDAT) is never
# touched, never decoded and never re-compressed. The .txt shape gets the
# same treatment through its one-line `#pc_meta` front matter.

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _png_iter_chunks(raw: bytes):
    """Yield (chunk_type, full_chunk_bytes) for a PNG byte string.
    Raises ValueError if the stream is not a well-formed PNG."""
    if not raw.startswith(_PNG_SIGNATURE):
        raise ValueError("Not a PNG")
    pos = len(_PNG_SIGNATURE)
    total = len(raw)
    while pos + 8 <= total:
        length = int.from_bytes(raw[pos:pos + 4], "big")
        ctype = raw[pos + 4:pos + 8]
        end = pos + 12 + length  # length + type + data + crc
        if end > total:
            raise ValueError("Truncated PNG chunk")
        yield ctype, raw[pos:end]
        pos = end
        if ctype == b"IEND":
            return
    raise ValueError("PNG ended without IEND")


def _png_text_chunk(key: str, value: str) -> bytes:
    """Build one uncompressed tEXt chunk (Latin-1 keyword + payload).
    Falls back to iTXt when the value is not Latin-1 encodable, which is
    what Pillow does and what any reader (including Pillow) expects."""
    key_bytes = key.encode("latin-1")
    try:
        body = key_bytes + b"\x00" + value.encode("latin-1")
        ctype = b"tEXt"
    except UnicodeEncodeError:
        # iTXt: keyword \0 compression_flag compression_method \0 lang \0 translated \0 text
        body = key_bytes + b"\x00\x00\x00\x00\x00" + value.encode("utf-8")
        ctype = b"iTXt"
    import zlib
    crc = zlib.crc32(ctype + body) & 0xFFFFFFFF
    return (len(body).to_bytes(4, "big") + ctype + body + crc.to_bytes(4, "big"))


def _png_with_categories(raw: bytes, category: list | None) -> bytes:
    """Return `raw` with its pc_categories tEXt/iTXt chunk replaced by
    `category` (or removed when the list is empty). Pixel chunks are
    copied through byte-for-byte."""
    wanted = json.dumps(list(category), ensure_ascii=False) if category else None
    key_prefix = PC_CATEGORIES_KEY.encode("latin-1") + b"\x00"
    out = bytearray(_PNG_SIGNATURE)
    for ctype, chunk in _png_iter_chunks(raw):
        if ctype in (b"tEXt", b"iTXt", b"zTXt") and chunk[8:].startswith(key_prefix):
            continue  # the old tag list -- dropped; a new one is spliced in below
        if ctype == b"IEND":
            if wanted is not None:
                out += _png_text_chunk(PC_CATEGORIES_KEY, wanted)
            out += chunk
            break
        out += chunk
    return bytes(out)


def _rewrite_embedded_categories(filename: str, category: list | None) -> bool:
    """Replace ONLY the embedded category tags of an existing
    prompt_data file, leaving its name, prompt text and (for a PNG) its
    exact pixel bytes untouched. Returns True on success, False when the
    file could not be rewritten this way -- the caller then falls back to
    the full update_prompt_data() path.
    """
    try:
        path = _resolve_within_library(filename)
    except ValueError:
        return False
    if not os.path.isfile(path):
        return False

    if path.lower().endswith(".txt"):
        data = read_txt_prompt_data(path)
        if data is None:
            return False
        _write_prompt_data_txt(path, data["prompt"], list(category or []))
        return True

    try:
        with open(path, "rb") as f:
            raw = f.read()
        rebuilt = _png_with_categories(raw, category)
    except (OSError, ValueError) as exc:
        log.debug("metadata-only rewrite unavailable for %s (%s)", filename, exc)
        return False

    tmp_path = path + f".tmp-{uuid_lib.uuid4().hex}"
    try:
        with open(tmp_path, "wb") as f:
            f.write(rebuilt)
        os.replace(tmp_path, path)
    except OSError as exc:
        log.warning("category rewrite failed for %s: %s", filename, exc)
        return False
    finally:
        _remove_quietly(tmp_path)
    _drop_prompt_read(path)
    return True


# ---------------------------------------------------------------------------
# Ingestion of not-yet-normalized files found sitting in the library
# folder (a bare image dropped in with no embedded workflow, or a
# plain .txt) -- called ONLY from scan_library(), which is the single
# place responsible for turning these into normal, "pc_managed"
# prompt_data PNGs. Everything else in this module only ever deals
# with already-normalized prompt_data.
# ---------------------------------------------------------------------------

def _ingest_workflowless_png(path: str, name: str, category: list | None = None) -> None:
    """Normalize a bare PNG (no embedded user_prompt workflow) found in
    the library folder into a real prompt_data PNG, in place:
      - its own image bytes are re-sanitized/cropped/resized to
        LIBRARY_THUMB_SIZE (overwriting the original pixel data, per
        the documented "PNG import" rule -- there is no "original
        size" kept once this runs)
      - a workflow embedding `name` as the prompt text is attached
        (prompt_data.prompt == prompt_data.name for this path, per the
        "Naming" rule above)
      - `category`: tags to embed alongside -- scan_library
        passes the tags the file (or a deduped twin .txt, see
        _merge_txt_categories_into_png) already carries, so ingest
        never silently strips category information
      - the file is marked pc_managed so future scans treat it as a
        normal, already-ingested prompt_data and never re-run this

    Caller (scan_library) is responsible for having already verified
    minimum image size and for the eventual UID-assignment rename;
    this function only rewrites the file's CONTENT at its current
    path, it does not rename anything.
    """
    with open(path, "rb") as f:
        raw = f.read()
    workflow_json = _make_user_prompt_workflow(name)
    _write_prompt_data_png(path, raw, workflow_json, category=category or None)


def _retire_duplicate(path: str) -> None:
    """Move a superseded prompt_data file into `library/_trash/` instead
    of deleting it.

    The duplicate rule (a .txt whose name+text matches a .png) is an
    inference, and an inference that destroys a user file with no undo
    is a bad trade -- especially since the only notice is a log line.
    Retiring keeps the scan's outcome identical (the file leaves the
    library folder, `_trash` is not scanned) while staying fully
    recoverable: drag the file back out and rescan.

    A name already present in `_trash` gets a numeric suffix rather than
    overwriting the older casualty. Falls back to raising OSError (which
    the caller already handles by keeping the file in the current scan)
    if the move is impossible.
    """
    trash = _trash_dir()
    os.makedirs(trash, exist_ok=True)
    base = os.path.basename(path)
    stem, ext = os.path.splitext(base)
    target = os.path.join(trash, base)
    n = 2
    while os.path.exists(target):
        target = os.path.join(trash, f"{stem}_{n:03d}{ext}")
        n += 1
    shutil.move(path, target)


def _merge_txt_categories_into_png(png_path: str, png_data: dict, txt_data: dict) -> None:
    """PNG-wins dedup: fold a losing duplicate .txt's
    category tags into the surviving .png BEFORE the txt is deleted, so
    a user's tagging work is never silently destroyed. Case-insensitive
    union (the same matching rule _register_categories_from_scan uses).

    Best effort, deliberately: any failure is swallowed and the dedup
    proceeds -- prompt TEXT lives identically in both files, and the
    tags themselves also exist in the global category index, so the
    worst case is a tag not riding on this one card, never data loss.

    Mutates png_data["category"] on success (it is the same dict the
    scan carries into its result, and pass 2's ingest call for a
    workflow-less PNG re-embeds from it).
    """
    txt_cats = list((txt_data or {}).get("category") or [])
    if not txt_cats:
        return
    png_cats = list((png_data or {}).get("category") or [])
    merged = list(png_cats)
    for tag in txt_cats:
        if not any(tag.lower() == m.lower() for m in merged):
            merged.append(tag)
    if len(merged) == len(png_cats):
        return  # the PNG already carries every tag
    try:
        text = png_data.get("prompt")
        if text is None:
            # Workflow-less PNG: its prompt text IS its (normalized)
            # display name -- same fallback _record_identity uses.
            stem = png_data["name_portion"]
            if png_data.get("uid") is None:
                stem = normalize_imported_stem(stem)
            text = decode_prompt_name(stem)
        with open(png_path, "rb") as f:
            raw = f.read()
        _write_prompt_data_png(png_path, raw, _make_user_prompt_workflow(text), merged)
        png_data["category"] = merged
    except Exception:
        pass


def _make_user_prompt_workflow(prompt_text: str) -> dict:
    """Build a minimal ComfyUI editor-format workflow graph containing
    exactly one node: a genuine, built-in ComfyUI "PrimitiveStringMultiline"
    node titled "user_prompt", carrying `prompt_text` as its "value"
    widget.

    PrimitiveStringMultiline is ComfyUI's real, always-available core
    node for a standalone multiline STRING value (input widget "value",
    output "output" -- see the node's own documented I/O). This
    replaces an earlier version of this function that emitted a
    "PrimitiveNode" node instead; PrimitiveNode is a different,
    generic/typed primitive whose on-disk shape doesn't match what
    this project actually wants matched (see the "Compatibility"
    section in library_store.py's module docstring: the node must be
    THIS specific native multiline text node, not merely any node
    carrying the right title).

    `read_prompt_data()` / `_find_user_prompt_text()` require BOTH the
    title ("user_prompt") AND the type ("PrimitiveStringMultiline") to
    match -- see that function's docstring for why title-only matching
    was dropped.
    """
    return {
        "nodes": [
            {
                "id": 1,
                "type": USER_PROMPT_NODE_TYPE,
                "title": USER_PROMPT_NODE_TITLE,
                "pos": [0, 0],
                "size": [400, 200],
                "flags": {},
                "order": 0,
                "mode": 0,
                "inputs": [],
                "outputs": [
                    {
                        "name": "output",
                        "type": "STRING",
                        "links": [],
                        "slot_index": 0,
                    }
                ],
                "properties": {"Node name for S&R": USER_PROMPT_NODE_TYPE},
                "widgets_values": [prompt_text],
            }
        ],
        "links": [],
        "groups": [],
        "config": {},
        "extra": {},
        "version": 0.4,
    }


# ---------------------------------------------------------------------------
# Scan (the only place UID is assigned)
# ---------------------------------------------------------------------------

def scan_library(normalize: bool = True) -> list:
    """Scan the library folder -- AND every one of its subfolders, one
    level deep -- for compatible prompt_data files, ingesting/
    normalizing not-yet-processed files on disk as needed, and return
    an alphabetically sorted list of resolved entries:

        [{"name", "uid", "prompt_ref", "prompt", "category", "filename",
          "has_thumbnail", "folder"}, ...]

    SUBFOLDERS: the library root is scanned first, then every direct
    subfolder in alphabetical order (a folder inside a folder is not
    itself recursed into -- one level only), skipping any subfolder
    whose name starts with "_" (the existing internal-bookkeeping
    convention -- "_trash", the categories sidecar's own directory
    concept -- extended to mean "not a browsable folder" generally).
    `folder` on each entry is that subfolder's name, or "" for anything
    at the library root.

    Each folder is scanned by _scan_one_folder() using EXACTLY the
    single-folder algorithm this function has always run (collision
    ladder, .txt/.png dedup, workflowless-PNG ingestion -- all
    unchanged, all still scoped to files within that one folder only).
    What's new is the MERGE across folders once every one of them has
    been scanned independently:

    Cross-folder identity collision rule: if two folders each contain a
    prompt with the same identity (same Prompt Name, same canonical
    prompt text -- the same rule _scan_one_folder already uses WITHIN
    one folder), the file in whichever folder was scanned FIRST wins
    that identity, and the matching file(s) in every later folder are
    simply left out of the merged result entirely -- not renamed, not
    retired to _trash, not touched on disk at all, since there is
    nothing wrong with them; they are just shadowed by an
    earlier-folder entry with identical content. A file that stops
    being shadowed (the earlier copy is deleted, or edited so its
    identity no longer matches) reappears on the very next scan with no
    special handling needed, because the merge is recomputed fresh
    every time from that scan's own results.

    A prompt's `prompt_ref` never encodes which folder it lives in
    (see parse_prompt_ref's own security note -- a ref containing a
    path separator is deliberately treated as invalid, closing a path-
    traversal hole) -- so moving a file between folders on disk, either
    in-app or externally, changes only where resolve() finds it, never
    what ref it resolves under, and every preset pointing at it keeps
    working with no retargeting needed at all.

    `normalize=False` is the strictly read-only mode _scan_one_folder
    already documents, applied uniformly across every folder in this
    same call: nothing is renamed, ingested, retired or registered
    anywhere, and the returned entries describe what the FINAL names
    WOULD be. Pure queries (check_already_exists) use that mode so a
    "does this already exist?" probe can never mutate any folder as a
    side effect.
    """
    with _SCAN_LOCK:
        return _scan_library_locked(normalize)


def _iter_library_folders():
    """Yield (folder_abs, folder_rel) for the library root ("" ) first,
    then every direct subfolder in alphabetical order -- one level deep
    only; a folder's own subfolders are not walked. Any subfolder whose
    name starts with "_" is skipped (the "_trash"/"_categories.json"
    convention: an underscore-prefixed name is internal bookkeeping,
    never a user-browsable folder), and anything that isn't actually a
    directory (a stray file sitting next to the library root, say) is
    silently skipped rather than erroring.

    This is the ONE place "what counts as a library folder" is decided
    -- scan_library, _library_signature, and anywhere else that needs
    to walk the whole library all call this rather than each
    re-implementing the same os.listdir + filter + sort.
    """
    root = _lib_dir()
    yield root, ""
    try:
        names = sorted(os.listdir(root))
    except FileNotFoundError:
        return
    for name in names:
        if name.startswith("_"):
            continue
        abs_path = os.path.join(root, name)
        if os.path.isdir(abs_path):
            yield abs_path, name


def _scan_library_locked(normalize: bool) -> list:
    folders = list(_iter_library_folders())

    # Scan every folder independently first -- each folder's OWN
    # collision ladder/dedup only ever sees files within that folder,
    # exactly as before subfolders existed (see _scan_one_folder).
    per_folder_results = [
        _scan_one_folder(folder_abs, folder_rel, normalize)
        for folder_abs, folder_rel in folders
    ]

    # Cross-folder merge: first folder to claim an identity (Prompt
    # Name case-folded + canonical prompt text -- the SAME rule
    # _scan_one_folder uses internally) wins; every later folder's
    # matching entry is left out of the merged list untouched on disk.
    # `folders` is already root-first-then-alphabetical (see
    # _iter_library_folders), so iterating per_folder_results in that
    # same order is what makes "first" mean the root, then the
    # alphabetically earliest subfolder, exactly as specified.
    seen_identities = set()
    results = []
    ref_folder_index = {}
    for folder_results in per_folder_results:
        for entry in folder_results:
            identity = (entry["name"].lower(), canonical_prompt_text(entry["prompt"] or ""))
            if identity in seen_identities:
                continue  # shadowed by an earlier folder's identical entry
            seen_identities.add(identity)
            # entry["filename"] is a BARE name at this point (see
            # _scan_one_folder / read_prompt_data: os.path.basename(path)
            # -- correct for that function's own folder-scoped view, but
            # every consumer OUTSIDE this merge step (thumbnail serving,
            # rename/delete, resolve()'s own fallback search) needs a
            # path _resolve_within_library() can act on directly, which
            # for anything not at the root means folder-QUALIFIED. This
            # is the one place that qualification is added -- entries
            # never carry a bare name once they leave this function.
            # prompt_ref itself is NOT touched: it stays exactly
            # "Name_UID" regardless of folder (parse_prompt_ref
            # deliberately rejects a path separator in a ref -- see its
            # own security note -- so the folder can never live there).
            if entry["folder"]:
                entry["filename"] = os.path.join(entry["folder"], entry["filename"])
            results.append(entry)
            ref_folder_index[entry["prompt_ref"]] = entry["folder"]

    results.sort(key=lambda e: e["name"].lower())

    if normalize:
        _register_categories_from_scan(results)
        # Rebuilt from THIS scan's merged results every time (never
        # incrementally patched), so a file that moved, got shadowed,
        # or stopped being shadowed is reflected exactly as the merge
        # above just decided -- resolve() reads this to know which
        # folder to look in without searching all of them.
        _REF_FOLDER_INDEX.clear()
        _REF_FOLDER_INDEX.update(ref_folder_index)

    return results


def _scan_one_folder(folder_abs: str, folder_rel: str, normalize: bool) -> list:
    """Scan exactly ONE folder (no recursion of its own -- see
    _scan_library_locked, which calls this once per folder and merges
    the results) and return its entries, each carrying `"folder":
    folder_rel` (the relative subfolder name, "" for the library root).

    This is the untouched single-folder algorithm scan_library() has
    always run -- collision ladder, .txt/.png dedup, workflowless-PNG
    ingestion, all of it -- now parametrized on WHICH directory to walk
    (folder_abs) instead of hardcoding the library root. Every path this
    function reads or writes stays inside folder_abs; nothing here ever
    reaches into a different folder, which is what makes "first folder
    wins an identity, later folders are silently skipped" (see
    _scan_library_locked) safe to implement as a merge step performed
    AFTER all folders have been scanned independently, rather than
    needing this function to know about any other folder while it runs.
    """
    results = []

    try:
        filenames = sorted(os.listdir(folder_abs))
    except FileNotFoundError:
        return results

    # Case-insensitive view of every filename currently in play, so an
    # import never renames onto a name that differs from an existing
    # file only by case (names differing only by case are the same
    # name). Grows as this scan claims new names.
    taken = {f.lower() for f in filenames}

    # Candidate prompt_data files: a .png (carries a thumbnail) or a .txt
    # (no thumbnail). Both are first-class -- a .txt is normalized in
    # place (name folded, UID assigned, renamed to Name_UID.txt) exactly
    # like a .png, and is NEVER converted into one.
    candidate_filenames = [
        f for f in filenames if f.lower().endswith((".png", ".txt"))
    ]

    # Pass 1: read every candidate file's data BEFORE anything is
    # renamed, so the identity checks in pass 2 can see the whole
    # library -- including files dropped in the same batch. Each record
    # carries its own extension so pass 2 renames it in kind.
    records = []
    for filename in candidate_filenames:
        path = os.path.join(folder_abs, filename)
        data = read_prompt_data_cached(path)
        if data is None:
            continue  # incompatible/unreadable/empty -- silently skipped
        ext = ".txt" if filename.lower().endswith(".txt") else ".png"
        records.append((filename, path, data, ext))

    # Identity map: (Prompt Name lower-cased, canonical prompt text) ->
    # the filename claiming it. "Same name + same text" is the
    # identical-content rule; comparing the TEXT (not just the stored
    # UID) also catches files whose UID was written by an older scheme
    # or hand-renamed outside the app, which a pure filename-collision
    # check would miss and duplicate.
    def _record_identity(data):
        stem = data["name_portion"]
        if data["uid"] is None:
            stem = normalize_imported_stem(stem)
        display = decode_prompt_name(stem)
        text = data["prompt"] if data["prompt"] is not None else display
        return (display.lower(), canonical_prompt_text(text))

    # Pass 1.5: a .txt whose IDENTITY -- same
    # Prompt Name (case-folded) and same canonical prompt TEXT -- also
    # belongs to a .png in this same scan is a duplicate whose richer
    # twin is the PNG: the PNG keeps the entry (it carries everything
    # the txt has, plus a thumbnail) and the txt's data file is REMOVED
    # from disk, right here in the scan, so load, import (drop-in then
    # refresh) and "Rescan library folder" all converge on one card.
    # UID being hash(name+text) means the twins share their ref stem
    # whenever both were normalized by this scheme, so presets keep
    # resolving -- and resolve() already prefers .png for one stem.
    # Category tags only the txt carried are folded into the PNG first
    # (best effort -- a failed merge never blocks the documented rule).
    png_by_identity = {}
    for filename, path, data, ext in records:
        if ext == ".png":
            png_by_identity.setdefault(_record_identity(data), (filename, path, data))
    if png_by_identity:
        survivors = []
        for filename, path, data, ext in records:
            if ext != ".txt":
                survivors.append((filename, path, data, ext))
                continue
            twin = png_by_identity.get(_record_identity(data))
            if twin is None:
                survivors.append((filename, path, data, ext))
                continue
            png_filename, png_path, png_data = twin
            if not normalize:
                continue  # read-only scan: the PNG owns the entry, txt just drops out
            _merge_txt_categories_into_png(png_path, png_data, data)
            try:
                _retire_duplicate(path)
                _drop_prompt_read(path)
                taken.discard(filename.lower())
                log.info(
                    "retired duplicate '%s' to %s -- an identical PNG ('%s', "
                    "same name and prompt text) owns the entry now",
                    filename, os.path.basename(_trash_dir()), png_filename,
                )
            except OSError:
                # Locked/in-use right now: keep this txt in the scan for
                # this pass; the classic collision-suffix path makes it
                # a visible "_002" sibling until a later scan deletes it.
                survivors.append((filename, path, data, ext))
        records = survivors

    # Pass 1.75: pass 2 TRUSTS any
    # file whose filename already carries a UID and appends it untouched
    # -- so a COPY whose UID was hand-renamed into another valid-looking
    # 8-digit number (Woman_19321688.png -> Woman_19321388.png) would skip
    # the collision ladder entirely and show as a second identical
    # "Woman" card. "Already normalized" must mean UID-matches-CONTENT:
    # hash(name+text) is the invariant every normalization writes, so
    # among files sharing one identity the content-consistent file is
    # the original and keeps its stem (preset refs stay valid), while
    # each inconsistent twin is DEMOTED (in-memory UID dropped) --
    # which routes it through the classic import ladder in pass 2: the
    # display name gets _002, the UID regenerates from that FINAL name,
    # and the file is renamed on disk exactly like a fresh drop of the
    # same content would. If NO twin is consistent (hand-written/legacy
    # twins only), the first in sorted order keeps its name -- the scan
    # re-normalizes nothing without a duplicate forcing its hand --
    # and the rest are demoted.
    def _uid_consistent(data):
        text = data["prompt"] if data["prompt"] is not None else data["name"]
        return data["uid"] == generate_uid(data["name"], text)

    uid_members_by_identity = {}
    for filename, _path, data, _ext in records:
        if data["uid"] is not None:
            uid_members_by_identity.setdefault(
                _record_identity(data), []).append((filename, data))
    keeper_claim = {}
    for key, members in uid_members_by_identity.items():
        if len(members) < 2:
            continue
        consistent = [m for m in members if _uid_consistent(m[1])]
        keeper_filename = (consistent or members)[0][0]
        for filename, data in members:
            if filename != keeper_filename:
                data["uid"] = None  # demote -> pass 2 import ladder
        keeper_claim[key] = keeper_filename

    identity_owner = {}
    for filename, _path, data, _ext in records:
        identity_owner[_record_identity(data)] = filename
    # Pin each resolved group's claim to its KEEPER: a demoted twin's
    # own (identical) pre-claim must not be deletable by the import
    # branch's "owner is re-deciding itself" step, and must not be
    # out-voted by a same-identity file that arrives later in the pass.
    identity_owner.update(keeper_claim)

    # Pass 2: resolve each file's final stored name.
    for filename, path, data, ext in records:
        name, uid = data["name"], data["uid"]
        encoded_stem = data["name_portion"]
        embedded = data["prompt"]

        if uid is not None:
            # Already normalized on disk (pass 1.75 left it alone -- an
            # inconsistent twin of a same-identity file would have been
            # demoted into the import branch below): never renamed --
            # its prompt_ref is what presets store, and renaming would
            # orphan every entry pointing at it. A workflow-less PNG
            # that carries a UID still gets the bare-PNG ingest so it
            # has real prompt text (a .txt always has text already).
            if embedded is None and ext == ".png":
                if normalize:
                    _ingest_workflowless_png(path, name, data.get("category"))
                    data = read_prompt_data_cached(path)
                    if data is None:
                        continue  # ingestion failed unexpectedly -- skip defensively
                else:
                    # Read-only: report the text ingestion WOULD write
                    # (a bare PNG's prompt is its own name) without
                    # touching the file.
                    data = {**data, "prompt": name}
            results.append({
                "name": name,
                "uid": uid,
                "prompt_ref": os.path.splitext(filename)[0],
                "prompt": data["prompt"],
                "category": data["category"],
                "filename": filename,
                "has_thumbnail": ext == ".png",
                "folder": folder_rel,
            })
            continue

        # Import normalization:
        # spaces and illegal characters in the dropped filename fold
        # into "_" before the file is stored, and the Prompt Name is
        # whatever the corrected stem decodes to.
        encoded_stem = normalize_imported_stem(encoded_stem)

        # This record's original identity claim is being re-decided.
        own_key = _record_identity(data)
        if identity_owner.get(own_key) == filename:
            del identity_owner[own_key]

        def candidate_for(stem):
            display = decode_prompt_name(stem)
            # Bare PNG (no embedded user_prompt workflow): the prompt
            # text is the file's own name -- the FINAL name, so a
            # suffixed import carries "Beautiful_002", never the
            # pre-collision "Beautiful".
            text = display if embedded is None else embedded
            cand_uid = generate_uid(display, text)
            cand_filename = f"{stem}_{cand_uid}{ext}"
            cand_key = (display.lower(), canonical_prompt_text(text))
            return display, text, cand_uid, cand_filename, cand_key

        display, text, uid, new_filename, key = candidate_for(encoded_stem)
        if new_filename.lower() in taken or key in identity_owner:
            # Identical name + text already exists (or the filename is
            # taken): append the unified trailing number to the DISPLAY
            # name (reusing a trailing "_"), regenerate the UID from that
            # FINAL name exactly as the editor would for "Beautiful_002",
            # and re-encode. Working from the decoded name (not the raw
            # stem) is what keeps the suffix readable: the number rides
            # on the human name, so a non-canonical imported stem can
            # never swallow it into an ambiguous underscore run.
            base_display = display

            def is_taken(suffixed_display):
                _d, _t, _u, fname, k = candidate_for(
                    encode_prompt_name(suffixed_display))
                return fname.lower() in taken or k in identity_owner

            n = lowest_free_number(base_display, is_taken, start_at=2)
            display, text, uid, new_filename, key = candidate_for(
                encode_prompt_name(apply_collision_suffix(base_display, n)))

        taken.add(new_filename.lower())
        identity_owner[key] = new_filename

        # Step 2 (bare PNG): normalize in place now that the final name
        # is known, so the embedded prompt text equals the final Prompt
        # Name -- then rename (step 3). A .txt already carries its text.
        if embedded is None and ext == ".png" and normalize:
            _ingest_workflowless_png(path, display, data.get("category"))
            if read_prompt_data_cached(path) is None:
                continue  # ingestion itself failed unexpectedly -- skip defensively

        if normalize:
            new_path = os.path.join(folder_abs, new_filename)
            if not os.path.exists(new_path):
                try:
                    os.replace(path, new_path)
                    # The file now lives under a different path key; drop
                    # the old one so nothing ever serves it from a dead
                    # name (the new path re-parses once, then caches
                    # under its real key).
                    _drop_prompt_read(path)
                except OSError:
                    # Another process may have just renamed it; fall
                    # through and use the computed name/uid anyway.
                    pass

        data["filename"] = new_filename
        data["uid"] = uid
        # The display name reflects the FINAL stored name, so a collision
        # suffix is part of it ("Beautiful_002"), never dropped or read
        # back as a space.
        name = display
        data["prompt"] = text

        prompt_ref = os.path.splitext(data["filename"])[0]
        results.append({
            "name": name,
            "uid": uid,
            "prompt_ref": prompt_ref,
            "prompt": data["prompt"],
            "category": data["category"],
            "filename": data["filename"],
            "has_thumbnail": ext == ".png",
            "folder": folder_rel,
        })

    results.sort(key=lambda e: e["name"].lower())
    return results


def _register_categories_from_scan(results: list) -> None:
    """Fold every category tag observed on the scanned PNGs into the
    sidecar index, appending the ones that aren't in it yet.

    This is what makes a prompt_data.png dropped into `library/` from
    outside the app -- copied in, restored from a backup, brought back
    after being dragged out -- show up in the category list straight away.
    Its embedded tags are the only place that information exists, and
    before this they stayed invisible to the index until someone happened
    to edit that prompt (the only other path that registers a tag, see
    _register_categories_if_new).

    Runs at the end of every scan, which covers both moments that matter:
    when a node enters a workflow (the frontend's init refresh scans) and
    the "Rescan library folder" button. Cheap in the common case -- the
    index is only written when something is actually new, so a steady
    state scan does no more than read it once.

    Matching is case-insensitive, so a PNG tagged "favorite" folds onto
    the built-in "Favorite" rather than registering a rival.
    """
    index = _ensure_categories_index()
    changed = False
    for entry in results:
        for name in entry.get("category") or []:
            if not any(k.lower() == name.lower() for k in index):
                index[name] = {}
                changed = True
    if changed:
        _write_categories_index(index)


# ---------------------------------------------------------------------------
# Paged scanning (the chunked-load seam)
# ---------------------------------------------------------------------------
# The client fetches the library page by page (see api_client
# .scanLibraryPaged) so first cards appear while later ones are still
# in flight. The scan itself REMAINS whole-library-at-once: UID
# assignment and collision suffixing need the complete identity map,
# so a "first N files" scan could hand out names that a file arriving
# in page two would collide with. What pages instead is the RESULT of
# one scan, memoized briefly against a cheap directory signature, so
# page 2 doesn't re-run (re-stat + slice only, thanks to the read
# cache above). A later true-streaming scan (server ingests in the
# background, pages fill as work completes) replaces the internals of
# this function without changing its contract -- which is why the
# client already treats pages as advisory and dedups by prompt_ref.

_SCAN_MEMO_TTL_SECONDS = 10.0
_scan_memo = {"sig": None, "expires": 0.0, "results": None}

# Ref -> folder index, rebuilt every time scan_library() runs (see its
# tail). "" means the library root; any other value is a subfolder name
# relative to the root (only ONE level deep -- see _iter_library_folders).
# resolve() consults this so it can go straight to the right subfolder
# instead of searching every one of them on every call (resolve() runs
# on every compose/preview, so it has to stay a single stat, not an
# O(folders) directory walk). Entirely empty (and every lookup a miss)
# when the library has no subfolders at all, which is what keeps
# resolve() exactly as fast as before this feature existed for anyone
# not using subfolders.
_REF_FOLDER_INDEX: dict[str, str] = {}


def library_signature() -> str:
    """Public alias of _library_signature().

    Used to invalidate the library BROWSER's own paged-scan cache (see
    scan_library_page) -- NOT by PromptComposerNode.IS_CHANGED(), which
    computes the node's actual composed output directly instead of
    fingerprinting the library as a proxy for it (see IS_CHANGED()'s
    own docstring in prompt_composer_node.py for why a library-wide,
    byte-level signature was the wrong tool for that job).
    """
    return _library_signature()


def _library_signature() -> str:
    """Cheap content-independent fingerprint of the WHOLE library --
    the root plus every subfolder _iter_library_folders() walks:
    sorted (relative_name, size, mtime_ns) over every prompt_data
    candidate in any of them, hashed. Any add/remove/rename/rewrite --
    in-app or from outside, in the root OR any subfolder -- moves it;
    scanning costs one directory read plus one stat per file, per
    folder, never an open.

    This is a broad, byte-level "has anything at all touched the
    library" signal -- used to invalidate the PAGED SCAN CACHE
    (scan_library_page's memo), which backs the library BROWSER UI and
    genuinely needs to notice a thumbnail added/removed/replaced, a
    rename, a category edit, or any other on-disk change, because the
    browser displays all of that.

    Also stats the SUBFOLDER LIST ITSELF (each entry as ("<dirlist>",
    name)): adding or removing a subfolder changes nothing about any
    individual file's own stat data, so without this a brand new empty
    "Outfits/" folder (or one that was removed) would never move the
    signature -- the memo would keep serving a scan from before that
    folder existed until some unrelated file elsewhere happened to
    change too.
    """
    parts = []
    try:
        folders = list(_iter_library_folders())
    except OSError:
        return "missing"
    for folder_abs, folder_rel in folders:
        parts.append(("<dirlist>", folder_rel))
        try:
            filenames = os.listdir(folder_abs)
        except FileNotFoundError:
            continue
        for name in sorted(filenames):
            if not name.lower().endswith((".png", ".txt")):
                continue
            rel_name = os.path.join(folder_rel, name) if folder_rel else name
            try:
                st = os.stat(os.path.join(folder_abs, name))
            except OSError:
                parts.append((rel_name, "gone"))
                continue
            parts.append((rel_name, st.st_size, st.st_mtime_ns))
    return hashlib.sha1(repr(parts).encode("utf-8")).hexdigest()


def clear_scan_caches() -> None:
    """Drop the scan memo AND the per-file read cache. `force` on the
    library route maps here -- the explicit "Rescan library folder"
    button's guarantee that whatever is on disk right now gets
    re-read, even a file replaced with byte-identical size and
    preserved mtime."""
    with _SCAN_LOCK:
        _scan_memo.update({"sig": None, "expires": 0.0, "results": None})
        _PROMPT_READ_CACHE.clear()


def scan_library_page(page_size: int | None = None, cursor: int | None = None,
                       force: bool = False) -> tuple:
    """Chunked entry point over scan_library().

    Returns ``(entries, next_cursor, total)``:
      - ``entries``: ``total``-list slice for this page (sorted exactly
        like scan_library(), so pages concatenate into the same list);
      - ``next_cursor``: an opaque cursor for the following page, or
        None when the list is exhausted;
      - ``total``: the full list length, so the client can show
        progress and know when a rescan shifted the pages under it.

    page_size None/<=0 → the whole list in one page (next_cursor None).
    A directory change between pages invalidates the memo, and the new
    scan is then sliced at the old offset: pages may briefly
    duplicate/gap at the boundary, which is exactly what the client's
    prompt_ref dedup exists to absorb.
    """
    if force:
        clear_scan_caches()

    try:
        offset = max(0, int(cursor or 0))
    except (TypeError, ValueError):
        offset = 0

    now = time.time()
    with _SCAN_LOCK:
        sig = _library_signature()
        memo = _scan_memo
        if memo["results"] is None or memo["sig"] != sig or now >= memo["expires"]:
            results = scan_library()
            memo.update({"sig": _library_signature(),
                         "expires": now + _SCAN_MEMO_TTL_SECONDS,
                         "results": results})
        results = memo["results"]

    total = len(results)
    offset = min(offset, total)
    if not page_size or page_size <= 0:
        return results[offset:], None, total

    page = results[offset:offset + page_size]
    nxt = offset + len(page)
    next_cursor = str(nxt) if nxt < total else None
    return page, next_cursor, total


# ---------------------------------------------------------------------------
# Resolution (single source of truth -- used by compose() AND the JS
# preview's resolve endpoint; never duplicated anywhere else)
# ---------------------------------------------------------------------------

def parse_prompt_ref(prompt_ref: str):
    """Split a "Name_UID" pointer into (name, uid), where `name` is the
    ENCODED name half (the filename's name portion verbatim -- decode
    via decode_prompt_name for display). Returns (None, None) if it
    doesn't match the expected shape."""
    if not prompt_ref:
        return None, None
    name, uid = split_name_uid(prompt_ref)
    if uid is None:
        return None, None
    # A ref's name half is always produced by encode_prompt_name(), which
    # can emit neither a path separator nor "..". Anything that carries
    # one is not a ref this library ever wrote -- it is an attempt to
    # address a file outside the library folder (UID_RE's lazy ".*?"
    # happily matches "../../etc/passwd"), so it resolves to nothing.
    if os.sep in name or "/" in name or "\\" in name or os.path.isabs(name):
        return None, None
    if ".." in name.split("/") or ".." in name.split(os.sep) or name == "..":
        return None, None
    return name, uid


def resolve(prompt_ref: str) -> dict | None:
    """Resolve a "Name_UID" pointer to its current library content.

    Returns None if the pointer doesn't parse or no matching file
    exists (e.g. deleted/renamed since the entry was created) -- callers
    (compose(), the resolve route) are expected to treat that as "this
    entry contributes nothing" rather than erroring, per the documented
    "missing entry -> empty slot" rule.

    NOTE: a UID is only ever assigned by scan_library(), and
    scan_library() always ensures `prompt` is non-None before a file
    can reach that state (see its "Step 2" -- a workflow-less PNG is
    normalized, with its name filled in as the prompt, BEFORE UID
    assignment). So in practice a file reachable here (i.e. one whose
    filename already contains a valid UID) always has real prompt
    text. If a UID-named file's workflow was somehow removed/corrupted
    outside this app after the fact, `prompt` here would be None
    rather than this function returning None outright -- downstream
    compose()/preview code already treats a None/empty prompt as "this
    entry contributes nothing", so that's a safe (if theoretical)
    degradation, not a special case that needs handling here.

    This goes through read_prompt_data_cached(), so a repeated resolve
    of an unchanged file costs a stat rather than a fresh PNG decode.
    """
    name, uid = parse_prompt_ref(prompt_ref)
    if name is None:
        return None

    # Which folder currently holds this ref, per the most recent scan's
    # merge (see _scan_library_locked's tail) -- "" for the library
    # root, or a subfolder name. This is the ONLY candidate tried in the
    # overwhelmingly common case (something the last scan already knows
    # about), which is what keeps this a single stat per extension --
    # resolve() runs on every compose/preview (and once per entry in a
    # section's own entry list, which can be hundreds), so an
    # unconditional directory walk here is not a cheap thing to get
    # wrong: _iter_library_folders() itself does a real os.listdir(),
    # and calling it on every resolve() regardless of whether the index
    # already had the answer is exactly the kind of per-call cost that
    # turns a 500-entry section heavy. The full "search every folder"
    # fallback below is used ONLY when the index has nothing for this
    # ref (before the very first scan has ever run) or when the indexed
    # folder's own guess fails to actually contain the file (a stale
    # index -- the file moved since the last scan, in-app or
    # externally) -- both rare, unlike the lookup itself.
    indexed_folder = _REF_FOLDER_INDEX.get(prompt_ref)
    candidate_folders = [indexed_folder] if indexed_folder is not None else None

    # A prompt lives as a .png (with a thumbnail) or a .txt (without).
    # Try the PNG first -- it's the shape a prompt reaches once it has
    # any image -- then the .txt. The first that resolves wins.
    def _try_folders(folders):
        for folder_rel in folders:
            for ext in (".png", ".txt"):
                filename = f"{name}_{uid}{ext}"
                rel_path = os.path.join(folder_rel, filename) if folder_rel else filename
                # Belt and braces next to parse_prompt_ref's own
                # rejection: every path this module opens goes through
                # the traversal guard, regardless of which folder it
                # resolves into.
                try:
                    path = _resolve_within_library(rel_path)
                except ValueError:
                    return "invalid", None
                data = read_prompt_data_cached(path)
                if data is None:
                    continue
                return folder_rel, (rel_path, data)
        return None, None

    if candidate_folders is not None:
        folder_rel, hit = _try_folders(candidate_folders)
        if folder_rel == "invalid":
            return None
        if hit is not None:
            rel_path, data = hit
            return {
                "name": data["name"],
                "name_portion": data["name_portion"],
                "uid": data["uid"] or uid,
                "prompt_ref": prompt_ref,
                "prompt": data["prompt"],
                "category": data["category"],
                "filename": rel_path,
                "has_thumbnail": data["has_thumbnail"],
                "folder": folder_rel,
            }
        # Indexed folder's guess didn't pan out (stale index) -- fall
        # through to the full search below rather than reporting a
        # false miss.

    # Full fallback search: root first, then every subfolder
    # alphabetically (the same order the merge itself uses) -- reached
    # only when there was no indexed answer, or the indexed one was
    # stale.
    all_folders = [folder_rel for _folder_abs, folder_rel in _iter_library_folders()]
    folder_rel, hit = _try_folders(all_folders)
    if folder_rel == "invalid":
        return None
    if hit is None:
        return None
    rel_path, data = hit
    return {
        "name": data["name"],
        "name_portion": data["name_portion"],
        "uid": data["uid"] or uid,
        "prompt_ref": prompt_ref,
        "prompt": data["prompt"],
        "category": data["category"],
        "filename": rel_path,
        "has_thumbnail": data["has_thumbnail"],
        "folder": folder_rel,
    }


def resolve_many(prompt_refs: list) -> dict:
    """Resolve a list of prompt_refs at once, returning a dict keyed by
    prompt_ref (missing/unresolvable ones simply absent from the
    result). Convenience wrapper around resolve() for batch use by
    compose() and the preview resolve endpoint.
    """
    out = {}
    for ref in prompt_refs:
        resolved = resolve(ref)
        if resolved is not None:
            out[ref] = resolved
    return out


# ---------------------------------------------------------------------------
# Library CRUD (create / edit / delete a prompt_data)
# ---------------------------------------------------------------------------

def check_already_exists(name: str, prompt: str, exclude_prompt_ref: str | None = None,
                          entries: list | None = None) -> dict | None:
    """Check whether a prompt with this exact name + prompt text
    already exists in the library. Returns the existing entry dict if
    found, else None.

    `exclude_prompt_ref`: when editing an existing prompt_data in
    place, pass its own prompt_ref so it doesn't collide with itself.

    The name is run through the same correction used when writing, so
    a name that hasn't really changed compares equal to what's already
    on disk, and it is matched case-insensitively -- names that differ
    only by case are identical names, and the UID itself is hashed case-folded.

    Content identity is "same UID" -- which, because the UID is a
    deterministic hash of the canonicalized name+text, means identical
    content. The canonical TEXT is compared as well so a file whose
    stored UID predates the current hashing scheme (or was written by
    hand) is still recognized as the same prompt rather than silently
    duplicated.

    SIDE-EFFECT-FREE: this is a pure query, so it scans with
    `normalize=False`. A read-looking probe must not rename files,
    re-encode PNGs or retire duplicates as a side effect of answering
    "does this exist?" -- normalization is the job of the routes that
    genuinely load or rescan the library.

    `entries` (optional): a library listing already in hand. Pass it
    when checking many candidates in a row (a batch import, a category
    sweep) so the whole batch costs ONE scan instead of one per item.
    """
    name = correct_prompt_name(name)
    candidate_uid = generate_uid(name, prompt)
    name_key = name.lower()
    text_key = canonical_prompt_text(prompt)
    for entry in (entries if entries is not None else scan_library(normalize=False)):
        if exclude_prompt_ref and entry["prompt_ref"] == exclude_prompt_ref:
            continue
        if entry["name"].lower() != name_key:
            continue
        if entry["uid"] == candidate_uid or canonical_prompt_text(entry["prompt"] or "") == text_key:
            return entry
    return None


def _register_categories_if_new(category: list | None) -> None:
    """Ensure every name in `category` exists in the sidecar index,
    registering any that don't yet. Called after writes that carry
    category tags, so typing a brand-new category while editing a
    prompt "creates" it in the index automatically -- the same
    identity the dedicated Category Options toolbar operates on -- 
    without requiring the user to pre-create it there first.
    """
    if not category:
        return
    index = _read_categories_index()
    changed = False
    for name in category:
        if not any(k.lower() == name.lower() for k in index):
            index[name] = {}
            changed = True
    if changed:
        _write_categories_index(index)


def create_prompt_data(name: str, prompt: str, image_bytes: bytes | None = None,
                        category: list | None = None, entries: list | None = None,
                        folder: str | None = None) -> dict:
    """Create a new prompt_data PNG in the library.

    `name` is raw editor input: it is corrected into a Prompt Name
    (correct_prompt_name) and then encoded into the filename's name
    portion (encode_prompt_name). The entry's `name` is the corrected
    Prompt Name; `prompt_ref`/`filename` carry the encoded half.

    `folder`: an optional plain (unprefixed) subfolder name -- e.g.
    "Outfits" -- to create the prompt directly inside, matching an
    "assign to folder" choice made before the prompt existed yet (the
    edit panel's "New Prompt" flow can pick a folder category up front,
    same as any other category). None/"" means the library root, same
    as always. The folder itself is NOT created here -- it must already
    exist (see create_folder_category) -- so a bad/unknown folder
    raises rather than silently minting a new directory from a typo.

    Raises AlreadyExistsError (a ValueError) if a prompt with the same
    name+prompt already exists (caller/route is expected to have already
    surfaced the "already exists" dialog via check_already_exists(), but
    this is re-checked here defensively before writing).

    `entries`: an already-scanned library listing, forwarded to the
    duplicate check. Creating N prompts in a row otherwise costs N full
    library scans -- pass one snapshot and the batch costs one.
    """
    name = correct_prompt_name(name)
    if not prompt or not prompt.strip():
        raise ValueError("Prompt text is required")

    folder = (folder or "").strip()
    if folder and folder.lower() not in {f.lower() for f in list_folder_names()}:
        raise ValueError(f'Folder category "{folder}" does not exist')

    existing = check_already_exists(name, prompt, entries=entries)
    if existing is not None:
        raise AlreadyExistsError("This prompt already exists")

    uid = generate_uid(name, prompt)
    encoded_name = encode_prompt_name(name)
    has_thumbnail = image_bytes is not None
    ext = ".png" if has_thumbnail else ".txt"
    bare_filename = f"{encoded_name}_{uid}{ext}"
    filename = os.path.join(folder, bare_filename) if folder else bare_filename
    path = _resolve_within_library(filename)

    if os.path.exists(path):
        raise AlreadyExistsError("This prompt already exists")

    if has_thumbnail:
        workflow_json = _make_user_prompt_workflow(prompt)
        _write_prompt_data_png(path, image_bytes, workflow_json, category)
    else:
        _write_prompt_data_txt(path, prompt, category)
    _register_categories_if_new(category)

    return {
        "name": name,
        "name_portion": encoded_name,
        "uid": uid,
        "prompt_ref": f"{encoded_name}_{uid}",
        "prompt": prompt,
        "category": list(category or []),
        "filename": filename,
        "has_thumbnail": has_thumbnail,
        "folder": folder,
    }


def update_prompt_data(prompt_ref: str, name: str | None = None, prompt: str | None = None,
                        image_bytes: bytes | None = None, clear_image: bool = False,
                        category: list | None = None, folder=_UNSET) -> dict:
    """Edit an existing prompt_data in place. Any of name/prompt/image/
    category may be omitted to leave that field unchanged. A supplied
    `name` is raw editor input: it is corrected into a Prompt Name and
    re-encoded into the filename's name portion. Since name and/or
    prompt changing means the UID changes too, this renames the
    underlying file (old file removed, new file written) and carries
    the existing category tags forward unless `category` explicitly
    overrides them. When `name` is omitted the stored encoded stem is
    kept byte-for-byte, so a prompt-only edit never rewrites the name
    half of the ref beyond what the UID change already forces.

    `folder`: an explicit MOVE to a different library subfolder (a
    plain, unprefixed name, e.g. "Outfits"; "" moves it to the library
    root). Left at its default (_UNSET, an edit-not-a-move) the prompt
    stays exactly wherever it already lives, same as before this
    parameter existed. Raises ValueError if the target folder doesn't
    exist (see create_folder_category -- the edit panel always creates
    the folder up front, via "Add category", before anyone can pick it
    here) or is not different for the same-value no-op cost of one
    stat.

    Raises ValueError if the resulting name+prompt would collide with a
    DIFFERENT existing prompt_data, or if the source prompt_ref doesn't
    resolve to an existing file.
    """
    current = resolve(prompt_ref)
    if current is None:
        raise ValueError("Prompt not found")

    moving_folder = folder is not _UNSET and (folder or "") != (current.get("folder") or "")
    if folder is not _UNSET:
        target_folder = (folder or "").strip()
        if target_folder and target_folder.lower() not in {f.lower() for f in list_folder_names()}:
            raise ValueError(f'Folder category "{target_folder}" does not exist')
    else:
        target_folder = current.get("folder") or ""

    # Category-only edit: tags are not part of the UID, so nothing can
    # move (from a name/prompt/UID standpoint) and nothing needs
    # re-encoding. This fast path also covers a pure folder MOVE with
    # no other field touched: same file bytes, same filename stem, just
    # relocated to a different directory.
    if (name is None and prompt is None and image_bytes is None
            and not clear_image and not moving_folder and category is not None):
        tags = list(category or [])
        if _rewrite_embedded_categories(current["filename"], tags):
            _register_categories_if_new(tags)
            return {**current, "category": tags}

    if name is not None:
        new_name = correct_prompt_name(name)
        encoded_name = encode_prompt_name(new_name)
    else:
        new_name = current["name"]
        encoded_name = current.get("name_portion") or encode_prompt_name(new_name)
    new_prompt = prompt if prompt is not None else current["prompt"]
    if not new_prompt or not new_prompt.strip():
        raise ValueError("Prompt text is required")

    new_category = category if category is not None else current["category"]

    collision = check_already_exists(new_name, new_prompt, exclude_prompt_ref=prompt_ref)
    if collision is not None:
        raise AlreadyExistsError("This prompt already exists")

    old_path = _resolve_within_library(current["filename"])
    new_uid = generate_uid(new_name, new_prompt)
    # Whether the saved prompt has a thumbnail decides its whole on-disk
    # shape (PNG vs TXT) and so its extension:
    #   * a fresh image (image_bytes)  -> PNG
    #   * clear_image                  -> TXT (thumbnail removed)
    #   * neither                      -> keep the current shape
    if image_bytes is not None:
        has_thumbnail = True
        base_image_bytes = image_bytes
    elif clear_image:
        has_thumbnail = False
        base_image_bytes = None
    else:
        has_thumbnail = bool(current.get("has_thumbnail"))
        if has_thumbnail:
            # Keep the existing thumbnail image (re-read raw file bytes;
            # _write_prompt_data_png will re-sanitize/re-embed metadata).
            try:
                with open(old_path, "rb") as f:
                    base_image_bytes = f.read()
            except OSError:
                has_thumbnail = False
                base_image_bytes = None
        else:
            base_image_bytes = None

    ext = ".png" if has_thumbnail else ".txt"
    # A name/prompt edit changes the UID (and so the filename) but, on
    # its own, must never change which folder the entry lives in -- an
    # edit is not implicitly a move. target_folder is current["folder"]
    # unchanged UNLESS the caller explicitly passed a different
    # `folder` above, which is what lets a genuine move ride the same
    # write this function already does for a name/prompt/category edit
    # rather than needing its own separate file-shuffling path.
    bare_new_filename = f"{encoded_name}_{new_uid}{ext}"
    new_filename = (
        os.path.join(target_folder, bare_new_filename) if target_folder else bare_new_filename
    )
    new_path = _resolve_within_library(new_filename)

    if has_thumbnail:
        workflow_json = _make_user_prompt_workflow(new_prompt)
        _write_prompt_data_png(new_path, base_image_bytes, workflow_json, new_category)
    else:
        _write_prompt_data_txt(new_path, new_prompt, new_category)
    _register_categories_if_new(new_category)

    # normcase, not plain !=: on Windows a case-only rename lands on the
    # SAME file, so removing "old_path" after writing "new_path" would
    # delete the prompt we just saved. Names differing only by case are
    # the same name anyway. This
    # also removes the OTHER extension on a PNG<->TXT switch (a thumbnail
    # added to a .txt, or removed from a .png), AND the old copy left
    # behind by a folder move (old_path and new_path now differ by
    # directory as well as, potentially, nothing else).
    if os.path.normcase(new_path) != os.path.normcase(old_path) and os.path.isfile(old_path):
        os.remove(old_path)
        _drop_prompt_read(old_path)

    return {
        "name": new_name,
        "name_portion": encoded_name,
        "uid": new_uid,
        "prompt_ref": f"{encoded_name}_{new_uid}",
        "prompt": new_prompt,
        "category": list(new_category or []),
        "filename": new_filename,
        "has_thumbnail": has_thumbnail,
        "folder": target_folder,
    }


def delete_prompt_data(prompt_ref: str) -> bool:
    """Delete a prompt_data file from the library. Returns True if a
    file was removed, False if it didn't exist."""
    current = resolve(prompt_ref)
    if current is None:
        return False
    path = _resolve_within_library(current["filename"])
    if os.path.isfile(path):
        os.remove(path)
        _drop_prompt_read(path)
        return True
    return False


def set_category(prompt_ref: str, category: list) -> dict:
    """Set (replace) the embedded category tags for an existing
    prompt_data without touching its name/prompt/thumbnail.

    Tags do not feed the UID (which is hash(name+text)), so this can
    never move the ref -- which means it needs none of
    update_prompt_data()'s machinery: no collision check (and so no
    library scan), and no PNG re-encode. The tags are spliced straight
    into the file's metadata (see _rewrite_embedded_categories); the
    full path is kept only as a fallback for a file that cannot be
    rewritten that way.
    """
    tags = list(category or [])
    current = resolve(prompt_ref)
    if current is not None and _rewrite_embedded_categories(current["filename"], tags):
        _register_categories_if_new(tags)
        return {**current, "category": tags}
    return update_prompt_data(prompt_ref, category=tags)


# ---------------------------------------------------------------------------
# Category index (sidecar) -- gives categories their own manageable
# identity (create/rename/delete-everywhere) on top of the per-PNG
# embedded tags. See module docstring's "Categories" section for the
# dual-write rationale.
# ---------------------------------------------------------------------------

def _read_categories_index() -> dict:
    """Read library/_categories.json. Returns {} if missing/corrupt --
    a missing/broken index is treated as "no categories created yet"
    rather than an error, since it can always be reconstructed by
    re-adding categories or re-scanning embedded tags (see
    rebuild_categories_index_from_library).
    """
    if not os.path.isfile(_categories_index_path()):
        return {}
    try:
        with open(_categories_index_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def _write_categories_index(index: dict) -> None:
    target = _categories_index_path()
    tmp_path = target + f".tmp-{uuid_lib.uuid4().hex}"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, target)
    finally:
        _remove_quietly(tmp_path)


# The built-in category every library is guaranteed to have. Prompts are
# starred into/out of it exactly like any other category (it is an ordinary
# embedded tag, so a dragged-out PNG stays portable with its favorites
# marker intact) -- what makes it special is only that it always exists,
# always sorts first, and can never be renamed or deleted. The UI renders
# it as a star rather than as a badge, which is a presentation choice and
# changes nothing about how it is stored.
FAVORITE_CATEGORY = "Favorite"


def is_favorite_name(name) -> bool:
    """Case-insensitive test for the built-in category's name, so a user
    who typed "favorite" by hand still gets the protected behaviour
    rather than ending up with two competing Favorites."""
    return (name or "").strip().lower() == FAVORITE_CATEGORY.lower()


# Marker prefix for a FOLDER-derived pseudo-category (see
# folder_pseudo_category_name / is_folder_pseudo_category below). The
# leading folder emoji + space is deliberately something a normal
# category-name text field would never produce by accident, and
# create_category/rename_category actively REJECT any real category
# name starting with it (is_reserved_category_name) -- so a user cannot
# spoof, rename into, or otherwise manufacture a category that collides
# with or impersonates a folder-derived one. This is the same "one name
# is protected and un-typeable-by-coincidence" shape as FAVORITE_CATEGORY,
# just enforced by prefix-rejection rather than by name equality, since
# there can be many distinct folder pseudo-categories (one per subfolder)
# rather than exactly one.
FOLDER_CATEGORY_PREFIX = "\U0001F4C1 "  # "📁 "


def folder_pseudo_category_name(folder: str) -> str:
    """The display name for a subfolder's pseudo-category, e.g.
    "Outfits" -> "📁 Outfits". `folder` is the plain subfolder name as
    scan_library() records it (see _iter_library_folders) -- never the
    library root ("" has no pseudo-category at all; see
    list_categories_with_folders)."""
    return f"{FOLDER_CATEGORY_PREFIX}{folder}"


def is_reserved_category_name(name) -> bool:
    """True for any name a user must be BLOCKED from creating/renaming
    into -- currently just the folder-pseudo-category marker prefix.
    Checked by create_category and rename_category so the reservation
    is enforced at the one place names are ever accepted from the
    person, not left as a UI-only convention someone could bypass by
    calling the route directly."""
    return (name or "").startswith(FOLDER_CATEGORY_PREFIX)


def folder_name_from_pseudo_category(pseudo_category: str) -> str:
    """Inverse of folder_pseudo_category_name(): "📁 Outfits" -> "Outfits".
    Raises ValueError if `pseudo_category` doesn't actually carry the
    reserved marker -- callers should have already checked
    is_reserved_category_name() (or equivalently the "📁 " prefix)
    before calling this."""
    if not is_reserved_category_name(pseudo_category):
        raise ValueError("Not a folder-derived pseudo-category")
    return pseudo_category[len(FOLDER_CATEGORY_PREFIX):].strip()


_INVALID_FOLDER_CHARS = re.compile(r'[\\/:*?"<>|]')


def _sanitize_folder_name(name: str) -> str:
    """Validate a plain (unprefixed) folder name the same way a prompt
    name is protected from becoming a bad path segment: no path
    separators or other characters a filesystem would choke on, no
    leading "_" (that convention is reserved for internal bookkeeping
    folders like "_trash" -- see _iter_library_folders), and no
    leading/trailing whitespace. Returns the trimmed name; raises
    ValueError on anything invalid."""
    name = (name or "").strip()
    if not name:
        raise ValueError("Folder name is required")
    if _INVALID_FOLDER_CHARS.search(name):
        raise ValueError('Folder name cannot contain \\ / : * ? " < > |')
    if name.startswith("_"):
        raise ValueError('Folder name cannot start with "_"')
    if name in (".", ".."):
        raise ValueError("Invalid folder name")
    return name


def list_folder_names() -> list:
    """Plain (unprefixed) subfolder names currently on disk, one level
    deep, alphabetical -- the same set _iter_library_folders walks,
    without the library root. Used to validate a folder-category
    create/rename against what's already there."""
    return [folder_rel for _abs, folder_rel in _iter_library_folders() if folder_rel]


def create_folder_category(pseudo_category: str) -> str:
    """Create a new folder-derived pseudo-category: makes an actual
    subfolder on disk under the library root. `pseudo_category` is the
    full "📁 Name" form (as typed into the "Add category" field, which
    is where this is reached from -- see is_reserved_category_name's
    own docstring for why that marker is otherwise rejected). Returns
    the pseudo-category name. No-op (returns the existing name) if the
    folder already exists, matched case-insensitively -- same
    idempotent shape as create_category.
    """
    folder = _sanitize_folder_name(folder_name_from_pseudo_category(pseudo_category))
    existing = next((f for f in list_folder_names() if f.lower() == folder.lower()), None)
    if existing is not None:
        return folder_pseudo_category_name(existing)
    os.makedirs(_resolve_within_library(folder), exist_ok=True)
    clear_scan_caches()
    return folder_pseudo_category_name(folder)


def rename_folder_category(old_pseudo_category: str, new_pseudo_category: str) -> str:
    """Rename a folder-derived pseudo-category: renames the actual
    subfolder on disk, carrying every prompt inside it along for free
    (a directory rename, not a per-file move). Raises ValueError if the
    old folder doesn't exist, the new name is invalid, or a DIFFERENT
    folder already has that name (case-insensitively). Returns the new
    pseudo-category name.
    """
    old_folder = folder_name_from_pseudo_category(old_pseudo_category)
    new_folder = _sanitize_folder_name(folder_name_from_pseudo_category(new_pseudo_category))

    folders = list_folder_names()
    actual_old = next((f for f in folders if f.lower() == old_folder.lower()), None)
    if actual_old is None:
        raise ValueError("Folder category not found")

    collision = next(
        (f for f in folders if f.lower() == new_folder.lower() and f != actual_old), None
    )
    if collision is not None:
        raise ValueError("A folder category with that name already exists")

    old_path = _resolve_within_library(actual_old)
    new_path = _resolve_within_library(new_folder)
    # os.rename handles a case-only rename fine on its own; the
    # collision check above only needs to exclude `actual_old` itself
    # so renaming "Outfits" -> "outfits" isn't rejected as a collision
    # with itself.
    os.rename(old_path, new_path)
    clear_scan_caches()
    return folder_pseudo_category_name(new_folder)


def _ensure_categories_index() -> dict:
    """Guarantee the library folder and its category sidecar exist, and
    that "Favorite" is in the sidecar.

    Called on import (see the bottom of this module) and again on every
    read, because the folder is user-editable data: someone can delete
    `library/` or hand-edit `_categories.json` to drop Favorite, and the
    category lists the UI shows are only useful if the invariant holds by
    the time they are rendered. Idempotent and cheap -- one stat plus a
    write only when something is actually missing.

    Returns the index dict.
    """
    os.makedirs(_lib_dir(), exist_ok=True)
    index = _read_categories_index()
    if not any(is_favorite_name(existing) for existing in index):
        index[FAVORITE_CATEGORY] = {}
        _write_categories_index(index)
    return index


def list_categories() -> list:
    """All known category names: the built-in "Favorite" first (it is a
    permanent fixture, see FAVORITE_CATEGORY), then everything else
    alphabetically. Sourced from the sidecar index (category IDENTITY),
    not from what's currently observed on scanned PNGs -- a category can
    exist here with zero prompts currently tagged (freshly created, or
    all its prompts were untagged/deleted), which is what lets "Hide
    Empty" mean something.

    Deliberately EXCLUDES folder-derived pseudo-categories (see
    list_categories_with_folders): this is the list the "edit prompt"
    panel's tag picker uses, and a folder isn't something a prompt is
    individually tagged into -- it's just wherever the file happens to
    live on disk, entirely un-embedded (see scan_library's `folder`
    field) -- so it has no business appearing as an assignable tag.
    """
    names = sorted(_ensure_categories_index().keys(), key=lambda s: s.lower())
    favorite = next((n for n in names if is_favorite_name(n)), None)
    if favorite is None:
        return names
    return [favorite] + [n for n in names if n != favorite]


def list_categories_with_folders() -> list:
    """list_categories()'s result, with one FOLDER-derived pseudo-
    category appended per subfolder currently seen in the library --
    for the search toolbar's category dropdown, NOT the edit panel's
    tag picker (which stays on plain list_categories(); see its own
    docstring for why).

    Each pseudo-category is named via folder_pseudo_category_name(),
    e.g. "📁 Outfits" for a subfolder named "Outfits" -- the reserved
    "📁 " marker (see FOLDER_CATEGORY_PREFIX) is what lets the frontend
    tell a real, taggable category apart from "this is just where the
    file lives", and is_reserved_category_name() is what stops a user
    from typing that same marker into a real category name and
    spoofing one.

    Every subfolder _iter_library_folders() finds is listed here, EVEN
    ONE WITH NO PROMPTS IN IT -- an empty folder category is still a
    valid, pickable destination (the edit panel's folder picker is what
    lets someone assign the very first prompt to a brand-new folder),
    so this can't be derived purely from scanned entries' `folder`
    field; that would miss exactly the folders nobody has filed anything
    into yet.

    Sorted alphabetically by folder name and placed AFTER every real
    category (favorite-pinned list first, then folders) -- real,
    user-managed categories are the primary organizational tool; the
    folder view is a secondary, read-only convenience layered on top.
    """
    real = list_categories()
    return real + [folder_pseudo_category_name(f) for f in list_folder_names()]


def create_category(name: str) -> str:
    """Register a new category name in the index. No-op (returns the
    existing name) if it already exists case-insensitively. Does not
    tag any prompt -- creating a category and assigning it to a prompt
    are separate actions (see set_category / update_prompt_data).

    A name carrying the reserved "📁 " marker (FOLDER_CATEGORY_PREFIX)
    is NOT rejected here -- it is the one deliberate way to create a
    real, on-disk library subfolder from the "Add category" UI (see
    create_folder_category). Only a caller creating a genuinely ordinary
    category is blocked from smuggling that prefix in (the folder path
    is a distinct write: a directory, not a sidecar-index entry).
    """
    name = (name or "").strip()
    if not name:
        raise ValueError("Category name is required")
    if is_reserved_category_name(name):
        return create_folder_category(name)

    index = _read_categories_index()
    for existing in index:
        if existing.lower() == name.lower():
            return existing  # already exists; treat as idempotent

    index[name] = {}
    _write_categories_index(index)
    return name


def rename_category(old_name: str, new_name: str) -> str:
    """Rename a category everywhere: in the sidecar index, and in every
    library prompt_data's embedded tags (PNG chunk or .txt meta line)
    that currently carry the old name.
    Raises ValueError if old_name doesn't exist or new_name collides
    (case-insensitively) with a different existing category.

    If `old_name` is itself a folder-derived pseudo-category (the
    "📁 " marker), this is a folder rename instead -- see
    rename_folder_category -- since a folder's identity IS its
    on-disk directory name, not a sidecar-index row.
    """
    old_name = (old_name or "").strip()
    new_name = (new_name or "").strip()
    if not new_name:
        raise ValueError("New category name is required")
    if is_reserved_category_name(old_name):
        # A folder category's renamed name must keep the same marker
        # (it's still a folder, just under a new name) -- callers
        # (the edit panel's rename toolbar) always resupply the "📁 "
        # prefix themselves, but tolerate it being left off here too
        # rather than erroring on what is clearly the intended folder.
        new_folder_name = new_name if is_reserved_category_name(new_name) else folder_pseudo_category_name(new_name)
        return rename_folder_category(old_name, new_folder_name)
    if is_reserved_category_name(new_name):
        raise ValueError(
            f'Category names cannot start with "{FOLDER_CATEGORY_PREFIX.strip()}" '
            "-- that prefix is reserved for folder-based categories"
        )

    index = _read_categories_index()
    actual_old = next((k for k in index if k.lower() == old_name.lower()), None)
    if actual_old is None:
        raise ValueError("Category not found")
    if is_favorite_name(actual_old):
        raise ValueError('"Favorite" is a built-in category and cannot be renamed.')

    collision = next((k for k in index if k.lower() == new_name.lower() and k != actual_old), None)
    if collision is not None:
        raise ValueError("A category with that name already exists")

    # Update every prompt_data (PNG or .txt) that currently carries the
    # old tag. ONE scan for the whole sweep (the old code re-scanned the
    # entire library per tagged prompt, via update_prompt_data's
    # collision check), and each file gets a metadata-only rewrite
    # rather than a full re-encode.
    for entry in scan_library():
        if actual_old in (entry.get("category") or []):
            new_tags = [new_name if c == actual_old else c for c in entry["category"]]
            if not _rewrite_embedded_categories(entry["filename"], new_tags):
                update_prompt_data(entry["prompt_ref"], category=new_tags)

    # Re-read instead of committing the snapshot taken above: that walk
    # called scan_library() (which registers every tag it sees) and
    # update_prompt_data() (which registers the tags it writes), so the
    # index on disk may well have gained names since. Writing the old
    # dict back would silently erase them.
    fresh = _read_categories_index()
    meta = fresh.pop(actual_old, index.get(actual_old, {}))
    fresh[new_name] = meta
    _write_categories_index(fresh)
    return new_name


def delete_category(name: str) -> bool:
    """Delete a category everywhere: remove it from the sidecar index,
    and strip it from every library prompt_data's embedded tags (PNG
    chunk or .txt meta line) that currently
    carry it. Returns True if the category existed and was removed.

    Raises ValueError for the built-in "Favorite", which is protected
    here as well as in the UI: the endpoint is reachable by anything that
    can talk to the server, and a library without a Favorite would break
    the star controls that assume it is always there.
    """
    if is_favorite_name(name):
        raise ValueError('"Favorite" is a built-in category and cannot be deleted.')

    index = _read_categories_index()
    actual = next((k for k in index if k.lower() == (name or "").lower()), None)
    if actual is None:
        return False

    # Same single-scan + metadata-only rewrite as rename_category.
    for entry in scan_library():
        if actual in (entry.get("category") or []):
            new_tags = [c for c in entry["category"] if c != actual]
            if not _rewrite_embedded_categories(entry["filename"], new_tags):
                update_prompt_data(entry["prompt_ref"], category=new_tags)

    # Same re-read rationale as rename_category: the walk above can have
    # registered new names into the index on disk, and committing the
    # snapshot taken before it would drop them again.
    fresh = _read_categories_index()
    actual_now = next((k for k in fresh if k.lower() == (name or "").lower()), None)
    if actual_now is not None:
        del fresh[actual_now]
    _write_categories_index(fresh)
    return True


def rebuild_categories_index_from_library() -> list:
    """Force a scan-and-fold of the sidecar index from the PNGs on disk.

    This is now AUTOMATIC: every scan_library() ends by registering every
    category tag it observed (see _register_categories_from_scan), which
    covers both moments that matter -- a node entering a workflow (the
    frontend's init refresh scans) and the "Rescan library folder" button.
    Kept as an explicit entry point because it is the documented recovery
    path for a lost or corrupted _categories.json, and because a caller
    that wants to say "rebuild" out loud shouldn't have to know that
    scanning happens to do it.

    It can't recover a category that has zero prompts currently tagged
    with it -- there is nothing on disk left to observe -- but it never
    removes one either, so anything still named in the index survives.
    Always keeps the built-in "Favorite" (via _ensure_categories_index),
    and folds a hand-typed lowercase "favorite" tag onto it instead of
    registering a second, competing category.
    """
    scan_library()  # registers every tag it sees as it goes
    return list_categories()


# NO bootstrap on import (see paths.py and _lib_dir): importing this
# module must never touch the filesystem, so tests/tooling can import it
# freely and so the data directory is only created once it is genuinely
# needed. The invariant the old import-time call protected --
# "`library/` exists and `_categories.json` has Favorite in it by the
# time anything reads a category" -- is preserved by
# _ensure_categories_index(), which every read path already calls.
