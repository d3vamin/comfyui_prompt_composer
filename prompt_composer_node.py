"""
prompt_composer_node.py

Python-side implementation of the Prompt Composer node.

Responsibilities:
- Define the ComfyUI node (INPUT_TYPES, RETURN_TYPES, execution function).
- Own the "compose" logic that turns a list of Sections/Entries (sent
  from the JS frontend as a hidden JSON widget) into a single assembled
  STRING.
- Perform queue-time randomization: for any section marked "randomize
  on queue", deterministically pick one eligible entry using a seed,
  rather than whatever was shown (visible) live in the UI.
- Resolve each Entry's `prompt_ref` pointer against the on-disk library
  via `library_store.resolve()` immediately before composing, so the
  library is always the single, current source of truth for prompt
  content (see comfyUI_Prompt_composer.md, "Resolution" section, for
  why this happens in Python rather than being frozen into
  composer_state by the frontend).

Data model (as JSON, produced by the frontend)
----------------------------------------------------

    Entry:
        id: str                     # entry's own identity (uuid);
                                     # NOT the same as prompt_ref -- the
                                     # same prompt_ref may appear on
                                     # multiple Entries (duplicates, or
                                     # the same library prompt used in
                                     # several sections/positions)
        prompt_ref: str              # "Name_UID" pointer into the
                                     # library; resolved at compose time
        visible: bool                # output-inclusion / Show-Hide
                                     # toggle, owned by the Entry itself
                                     # and independent of section
                                     # membership -- an entry can sit
                                     # in a section's list yet be
                                     # switched off (Hidden). This is
                                     # DISTINCT from the transient
                                     # "selected" checkbox state used
                                     # for copy/cut/delete in the UI,
                                     # which never reaches
                                     # composer_state.
        allow_random: bool           # membership in the section's
                                     # randomize pool (see
                                     # _resolve_section_entries); when
                                     # the section's randomize is OFF,
                                     # this has no effect -- only
                                     # `visible` matters
        entry_separator: "none" | "comma" | "and"
                                     # what this entry's own text gets
                                     # appended with: nothing, a
                                     # trailing "," or a trailing
                                     # " and"; entries are then joined
                                     # with a plain space.

    Section:
        id: str
        name: str
        color: str                  # accent color, hex
        enabled: bool                # section Enable/Disable toggle
        randomize: bool              # randomize on queue
        end_separator: "comma" | "period" | "none"  # appended once at
                                     # the END of the section's block,
                                     # overriding whatever the last
                                     # entry's own entry_separator would
                                     # have produced
        show_label: bool             # prefix the block with
                                     # "<Section Name>: "
        order: int
        is_locked_prompt: bool       # True only for the built-in
                                     # "Prompt" section
        entries: list[Entry]         # unused when is_locked_prompt is True

The node receives the full list of sections (already ordered) as a
JSON string via a hidden widget called "composer_state", the standard
"seed" widget used to drive deterministic randomization, and a
top-level multiline "user_prompt" STRING input/widget. The locked
"Prompt" section injects the current value of "user_prompt" at
wherever it sits in the section order.
"""

import json
import random
import threading
import time
from collections import OrderedDict

try:
    from .server import library_store
    from .server.preset_store import normalize_entry_separator
except ImportError:  # pragma: no cover - allows standalone import during tests
    from server import library_store
    from server.preset_store import normalize_entry_separator


# ---------------------------------------------------------------------------
# Layer C3: last-executed-output stash.
#
# compose() runs at EXECUTION time with the server-injected UNIQUE_ID
# hidden input, so it is the only place that knows the string a node
# ACTUALLY emitted (as opposed to "what the current preview would
# compose", which C1/C2 mirror). We keep a small bounded in-memory map
# keyed by NODE ID, holding the latest executed output for each. The
# frontend's execution_success listener fetches from it (GET
# /prompt_composer/last_output/{prompt_id}/{node_id}) and folds the
# answer into pc_workflow_snapshot as executed_prompt/seed/at, so a
# saved workflow/PNG records not just "what it would say" but "what it
# said".
#
# Why node id (UNIQUE_ID) and not (prompt_id, node id): PROMPT_ID is not
# reliably injected across ComfyUI builds -- some deliver an empty string
# for it while still delivering UNIQUE_ID, and the prompt_id in the
# frontend's `executed` event can then disagree with the (empty) one the
# node saw, so a two-part key could never match. Node id alone is the
# stable handle: within a session a node id is unique and stable, and
# because compose() always runs BEFORE that node's `executed` event is
# delivered to the browser, latest-write-wins is exactly the right
# semantics for "what this node most recently emitted". prompt_id is
# still captured (when present) purely for provenance in /c3_status.
#
# Deliberately volatile: a server restart clears it, which is fine --
# workflows saved BEFORE the restart already carry the executed string in
# their snapshot, and the next run repopulates the stash. Bounded FIFO
# (~512 nodes-worth of string outputs is a few MB at most).
# ---------------------------------------------------------------------------

_LAST_OUTPUTS = OrderedDict()  # node_id -> {prompt, seed, at, prompt_id}
_LAST_OUTPUTS_MAX = 512
_LAST_OUTPUTS_LOCK = threading.Lock()


def record_executed_output(prompt_id, node_id, prompt_text, seed):
    """Stash one executed output under its node id (latest wins). Never
    raises: capture is provenance, and a provenance failure must not sink
    the run that produced it."""
    try:
        key = str(node_id or "")
        if not key:
            return  # no UNIQUE_ID injected -> nothing addressable to store
        with _LAST_OUTPUTS_LOCK:
            _LAST_OUTPUTS[key] = {
                "prompt": prompt_text,
                "seed": seed,
                "at": time.time(),
                "prompt_id": str(prompt_id or ""),
            }
            _LAST_OUTPUTS.move_to_end(key)
            while len(_LAST_OUTPUTS) > _LAST_OUTPUTS_MAX:
                _LAST_OUTPUTS.popitem(last=False)
    except Exception:  # pragma: no cover - defensive
        pass


def get_executed_output(prompt_id, node_id):
    """The most recent stashed output for one node, or None. prompt_id is
    accepted for signature/route stability but is NOT part of the address
    (see the header comment -- some builds inject an empty PROMPT_ID)."""
    key = str(node_id or "")
    if not key:
        return None
    with _LAST_OUTPUTS_LOCK:
        return _LAST_OUTPUTS.get(key)


ENTRY_SEPARATOR_SUFFIX = {
    "none": "",
    "comma": ",",
    "and": " and",
}


def _entry_text(entry):
    """Return the text contribution of a single (already-decided,
    already-resolved) entry, with its own trailing separator appended
    based on `entry_separator`: "none" (nothing), "comma" (","), or
    "and" (" and").

    NOTE: this function is intentionally unchanged -- it reads
    `entry.get("text")`, which by the time this is called has already
    been populated by _resolve_entries_text() below from the library.
    The randomization/joining/section-assembly logic downstream has no
    awareness of prompt_ref at all; it only ever sees plain text, exactly
    as before.
    """
    text = (entry.get("text") or "").strip()
    if not text:
        return text
    text += ENTRY_SEPARATOR_SUFFIX.get(
        normalize_entry_separator(entry.get("entry_separator", "comma")), "")
    return text


def _join_entries(entries):
    """Join multiple visible entries within one section.

    Each entry supplies its own trailing "," (via `entry_separator`) as
    part of its own text; entries are then joined with a single plain
    space. There is no section-wide separator character anymore -- only
    the section's `end_separator` (applied afterward, see compose_prompt)
    and each entry's own on/off comma.
    """
    parts = [_entry_text(entry) for entry in entries]
    parts = [p for p in parts if p]
    return " ".join(parts)


def _resolve_section_entries(section, rng):
    """Determine which entries are VISIBLE for output, applying
    queue-time randomization when the section requests it.

    Rules:
    - if section.randomize is True:
        - the "pool" is entries with BOTH allow_random True AND
          visible True.
        - if the pool has 2 or more entries, pick exactly one at
          random from the pool using rng.
        - if the pool has fewer than 2 entries, there's nothing to
          randomize among, so those 0 or 1 pool entries are included
          as-is (falling back to always-included) rather than dropped.
        - separately, and always, also include any entries with
          allow_random False AND visible True -- these are added
          alongside the pool pick (if any) regardless of pool size.
    - if section.randomize is False:
        - include every entry with visible True, regardless of its
          allow_random value.

    NOTE: unchanged. Operates purely on the already-resolved
    `text` field; has no knowledge of prompt_ref.
    """
    prompts = section.get("prompts", [])

    if section.get("randomize"):
        pool = [p for p in prompts if p.get("allow_random") and p.get("visible")]
        always_included = [p for p in prompts if not p.get("allow_random") and p.get("visible")]
        if len(pool) >= 2:
            return always_included + [rng.choice(pool)]
        # Pool too small to randomize among (0 or 1 entries) — include
        # whatever's there as-is instead of silently dropping it.
        return always_included + pool

    return [p for p in prompts if p.get("visible")]


END_SEPARATOR_MAP = {
    "period": ".",
    "comma": ",",
    "none": "",
}


def compose_prompt(sections, seed=0, user_prompt=""):
    """Build the final assembled prompt string from an ordered list of
    section dicts, applying queue-time randomization deterministically
    based on `seed`.

    UNCHANGED: this function and everything it calls
    (_resolve_section_entries, _join_entries, _entry_text) operates
    purely on plain `text` fields already present on each entry dict.
    It has zero awareness of prompt_ref/library resolution -- that
    happens one layer up, in PromptComposerNode.compose(), via
    _resolve_entries_text(), before sections ever reach this function.

    Sections are processed in the order given (the frontend is
    responsible for sending them already sorted by the user's drag
    order). Each section contributes a block of text; non-empty
    section blocks are joined with a single space " ".

    The locked "Prompt" section injects `user_prompt` (the value of the
    node's top-level multiline "user_prompt" widget/input) at wherever
    it sits in the section order.

    There is no section-wide separator character. Instead:
    - each entry supplies its own trailing "," via `entry_separator`,
      and entries within a section are joined with a plain space
      (e.g. "A woman," + "A man" -> "A woman, A man").
    - `end_separator` ("period" | "comma" | "none") is applied once at
      the very end of the section's block, and OVERRIDES whatever the
      last visible entry's own `entry_separator` would have produced.
    - `show_label`: if true, the block is prefixed with "<Section Name>: ".
    """
    blocks = []

    for index, section in enumerate(sections):
        if not section.get("enabled", True):
            continue

        if section.get("is_locked_prompt"):
            raw = (user_prompt or "").strip()
            if raw:
                blocks.append(raw)
            continue

        # Each section gets its own rng derived from the global seed and
        # section id, so that changing one section's contents doesn't
        # reshuffle every other section's random pick.
        section_seed_material = f"{seed}:{section.get('id', index)}"
        rng = random.Random(section_seed_material)

        chosen_entries = _resolve_section_entries(section, rng)
        block = _join_entries(chosen_entries)
        if not block:
            continue

        if section.get("show_label"):
            label = (section.get("name") or "").strip()
            if label:
                block = f"{label}: {block}"

        end_char = END_SEPARATOR_MAP.get(section.get("end_separator", "none"), "")
        if end_char:
            # The section's end separator overrides the last entry's
            # own trailing separator (comma or " and") rather than
            # stacking after it.
            if block.endswith(","):
                block = block[:-1]
            elif block.endswith(" and"):
                block = block[: -len(" and")]
            block = f"{block}{end_char}"

        blocks.append(block)

    return " ".join(blocks)


def _resolve_entries_text(sections, fallback_contents=None, resolved_out=None):
    """Walk every non-locked section's entries and resolve each
    `prompt_ref` against the current library, producing the
    `text`-bearing shape that compose_prompt()/_entry_text()/
    _join_entries() already expect (long-standing contract).

    This is the ONE place per compose() call where prompt_ref ->
    content resolution happens on the Python side, going through
    library_store.resolve() -- the same function the JS preview's
    resolve endpoint calls, so preview and actual output can never
    disagree (see library_store.py module docstring).

    `resolved_out` (optional): a dict that receives the RAW live
    resolution map (ref -> record, resolvable refs only) for this call.
    The /prompt_composer/compose route uses it to hand the JS preview
    the library answer in the same round-trip, without a second library
    scan and without re-implementing any of this function's logic.

    An entry whose prompt_ref no longer resolves (deleted/renamed since
    the entry was created) contributes empty text -- it is not an
    error, it's simply treated the same as any other entry with no
    text (dropped by _join_entries' `if p` filter).

    `fallback_contents` (optional) is a dict of prompt_ref ->
    {"prompt": str, ...} embedded in the loaded workflow
    (pc_workflow_snapshot.contents, mirrored into the hidden
    composer_contents widget at restore). It is consulted ONLY when the
    live library does NOT resolve a ref, so opening a workflow on a
    machine that lacks its prompts still reproduces the original text.
    Precedence is EXACTLY the JS side's (live library > workflow copy >
    empty -- see PreviewController._contentFor / mergeWorkflowContent),
    which is what keeps this fallback from ever masking a live edit.

    Returns a NEW list of section dicts (does not mutate the input),
    with each entry now also carrying:
        - "text": resolved prompt text (or "" if unresolved)
        - "visible": copied straight through from the entry's own
          on/off output-inclusion (Show/Hide) toggle (a real,
          independent property an Entry owns, distinct from the
          transient "selected" checkbox used for copy/cut/delete -- see
          comfyUI_Prompt_composer.md).
          Defaults to True only if the field is entirely absent (e.g.
          an older/partial composer_state payload), so existing
          behavior degrades gracefully rather than silently dropping
          everything.
    """
    # Collect all distinct prompt_refs across all non-locked sections in
    # one pass, then resolve them all at once (single batch), rather
    # than resolving the same prompt_ref repeatedly if it's duplicated
    # across many entries/sections.
    all_refs = set()
    for section in sections:
        if section.get("is_locked_prompt"):
            continue
        for entry in section.get("entries", []) or []:
            ref = entry.get("prompt_ref")
            if ref:
                all_refs.add(ref)

    resolved_map = library_store.resolve_many(list(all_refs))
    if resolved_out is not None:
        resolved_out.update(resolved_map)
    fallback = fallback_contents or {}

    def _text_for(ref):
        if not ref:
            return ""
        resolved = resolved_map.get(ref)
        # NOTE the .strip() checks: a live record with ONLY whitespace
        # counts as "no content" and lets the embedded copy stand in --
        # deliberately mirroring PreviewController._contentFor and
        # mergeWorkflowContent on the JS side, so preview and queue can
        # never disagree about which source spoke.
        if resolved and (resolved.get("prompt") or "").strip():
            return resolved["prompt"]
        # Live library had nothing for this ref: stand in with the copy
        # the workflow carried, if it had one.
        fb = fallback.get(ref)
        if isinstance(fb, dict) and (fb.get("prompt") or "").strip():
            return fb["prompt"]
        return ""

    new_sections = []
    for section in sections:
        if section.get("is_locked_prompt"):
            new_sections.append(section)
            continue

        new_entries = []
        for entry in section.get("entries", []) or []:
            ref = entry.get("prompt_ref")
            new_entries.append({
                **entry,
                "text": _text_for(ref),
                "visible": bool(entry.get("visible", True)),
            })

        new_section = {**section, "prompts": new_entries}
        new_sections.append(new_section)

    return new_sections


class PromptComposerNode:
    """The ComfyUI node itself.

    The heavy lifting UI lives in web/prompt_composer.js. This Python
    class only needs to accept the serialized state from the frontend
    (as a hidden STRING widget) and the seed, resolve each entry's
    prompt_ref against the library, and emit the assembled STRING
    output.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "user_prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                }),
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 0xffffffffffffffff,
                    "control_after_generate": True,
                }),
            },
            "hidden": {
                # JSON-serialized list of sections; populated/maintained
                # entirely by the JS frontend widget.
                "composer_state": ("STRING", {"default": "[]"}),
                # JSON-serialized dict of prompt_ref -> {name, prompt,
                # category} for whatever the loaded workflow embedded in
                # its pc_workflow_snapshot. Mirror-image of the JS
                # fallback: used at compose time ONLY for refs the live
                # library cannot resolve, so a workflow opened where its
                # prompts are missing still queues the original text.
                # "{}" (the default) keeps every pre-B4 workflow
                # behaving exactly as before.
                "composer_contents": ("STRING", {"default": "{}"}),
                # Layer C3: server-injected execution identity (never
                # widgets, never in widgets_values -- old workflows
                # configure untouched). compose() stashes the emitted
                # string under (prompt_id, unique_id) so the frontend
                # can show, and SAVE, what was really generated.
                "unique_id": "UNIQUE_ID",
                "prompt_id": "PROMPT_ID",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "compose"
    CATEGORY = "utils/prompt"
    DESCRIPTION = "Compose a prompt from reusable, library-backed prompt entries with queue-time randomization."

    def compose(self, seed=0, user_prompt="", composer_state="[]", composer_contents="{}",
                unique_id=None, prompt_id=None):
        try:
            sections = json.loads(composer_state) if composer_state else []
        except (json.JSONDecodeError, TypeError):
            sections = []

        # The workflow's embedded prompt copies (Layer B4). Any malformed
        # or non-object payload degrades to "no fallback" -- the pre-B4
        # behavior -- rather than failing the queue.
        try:
            fallback_contents = json.loads(composer_contents) if composer_contents else {}
            if not isinstance(fallback_contents, dict):
                fallback_contents = {}
        except (json.JSONDecodeError, TypeError):
            fallback_contents = {}

        # Keep sections in the order provided (frontend sends them
        # pre-sorted by the user's drag order), but sort defensively by
        # an explicit `order` field if present, for robustness.
        if sections and all(isinstance(s, dict) and "order" in s for s in sections):
            sections = sorted(sections, key=lambda s: s.get("order", 0))

        resolved_sections = _resolve_entries_text(sections, fallback_contents=fallback_contents)
        result = compose_prompt(resolved_sections, seed=seed, user_prompt=user_prompt)
        # C3: only a REAL execution carries UNIQUE_ID (injected by the
        # server); the /compose preview route calls this function without
        # it, so preview refreshes never masquerade as executed output.
        # PROMPT_ID is OPTIONAL here -- captured for provenance only. The
        # stash is addressed by node id because some ComfyUI builds inject
        # an empty PROMPT_ID while still giving UNIQUE_ID (see the
        # _LAST_OUTPUTS header). unique_id=None is the real anomaly: it
        # means a stale copy of this class ran (no identity injection), so
        # we print a terminal warning rather than silently storing nothing.
        if unique_id is None:
            print("PromptComposer C3: compose ran WITHOUT node identity injection "
                  "(unique_id=None) -- the executing server holds a stale copy of "
                  "this node class (wrong custom_nodes folder or no restart).",
                  flush=True)
        else:
            record_executed_output(prompt_id, unique_id, result, seed)
        return (result,)


NODE_CLASS_MAPPINGS = {
    "PromptComposer": PromptComposerNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptComposer": "Prompt Composer",
}
