"""
preset_store.py

Preset persistence for Prompt Composer.

A preset stores STRUCTURE ONLY: each section's own properties, and its
list of entries, where each entry is just a pointer (`prompt_ref`) plus
the two properties an Entry actually owns (`allow_random`,
`entry_separator`). No prompt text, name, thumbnail, or category is
ever written into a preset file -- all of that is always resolved live
from the library (see library_store.resolve) at load/compose time.

This is a deliberate simplification: presets never carry full entry
content or embedded base64 thumbnails for self-contained portability.
Portability lives at the prompt_data PNG level (see
library_store.py docstring), so presets can be small, and their
"content" is always whatever the library currently says it is.

Missing entries on load
------------------------
If a preset references a prompt_ref that no longer resolves to an
existing prompt_data (deleted, renamed outside the app, etc.), this
module does NOT error or attempt repair. Validation/normalization here
only checks STRUCTURE (are the fields the right shape?), not whether
prompt_ref currently resolves -- resolution and the "empty slot"
behavior for missing entries is the caller's (JS preview / compose())
responsibility, using library_store.resolve().

Rename relinking
----------------
A prompt rename is the one moment a ref changes ON PURPOSE (the UID is
hash(name+text)), and presets are the pointers that must follow:
`retarget_prompt_refs()` sweeps every saved preset file and swaps the
old ref for the new one, so relinking reaches across ALL presets, not
just the one currently open on a node. The library-update route calls
it as the preset side of the rename transaction.
"""

import json
import os
import re
import uuid as uuid_lib

NODE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRESETS_DIR = os.path.join(NODE_DIR, "presets")
INITIAL_PRESET_NAME = "Preset_001"

os.makedirs(PRESETS_DIR, exist_ok=True)

MAX_PRESET_JSON_BYTES = 5 * 1024 * 1024  # presets carry no images now; 5MB is generous

_SAFE_NAME_RE = re.compile(r"[^a-zA-Z0-9_\-]")

ENTRY_SEPARATOR_VALUES = ("none", "comma", "and")
END_SEPARATOR_VALUES = ("none", "comma", "period")


def _safe_component(name: str, fallback: str = "untitled") -> str:
    if not name:
        return fallback
    name = _SAFE_NAME_RE.sub("_", name.strip())[:64]
    return name or fallback


def _resolve_within(base_dir: str, filename: str) -> str:
    candidate = os.path.normpath(os.path.join(base_dir, filename))
    base = os.path.normpath(base_dir)
    if candidate != base and not candidate.startswith(base + os.sep):
        raise ValueError("Invalid path")
    return candidate


def _preset_path(name: str) -> str:
    filename = _safe_component(name) + ".json"
    return _resolve_within(PRESETS_DIR, filename)


def _ensure_initial_preset() -> None:
    """Create the first empty preset when no preset JSON exists."""
    try:
        has_json = any(fname.lower().endswith(".json") for fname in os.listdir(PRESETS_DIR))
    except FileNotFoundError:
        os.makedirs(PRESETS_DIR, exist_ok=True)
        has_json = False
    if has_json:
        return

    with open(_preset_path(INITIAL_PRESET_NAME), "w", encoding="utf-8") as f:
        json.dump({"name": INITIAL_PRESET_NAME, "sections": []}, f, ensure_ascii=False)


def normalize_entry_separator(value) -> str:
    """THE entry-separator normalizer for the Python side (prompt_composer_node
    imports it too) -- invalid or missing values fall back to "comma"."""
    if value in ENTRY_SEPARATOR_VALUES:
        return value
    return "comma"


def _normalize_end_separator(value) -> str:
    if value in END_SEPARATOR_VALUES:
        return value
    return "none"


def _normalize_entry(raw: dict) -> dict | None:
    if not isinstance(raw, dict):
        return None
    prompt_ref = raw.get("prompt_ref")
    if not isinstance(prompt_ref, str) or not prompt_ref:
        return None
    return {
        "id": str(raw.get("id") or uuid_lib.uuid4().hex),
        "prompt_ref": prompt_ref[:256],
        "visible": bool(raw.get("visible", True)),
        "allow_random": bool(raw.get("allow_random", True)),
        "entry_separator": normalize_entry_separator(raw.get("entry_separator", "comma")),
    }


def _normalize_section(raw: dict, index: int) -> dict | None:
    if not isinstance(raw, dict):
        return None

    raw_entries = raw.get("entries")
    entries = []
    if isinstance(raw_entries, list):
        for e in raw_entries:
            normalized = _normalize_entry(e)
            if normalized is not None:
                entries.append(normalized)

    order_value = raw.get("order", index)
    try:
        order = int(order_value)
    except (TypeError, ValueError):
        order = index

    return {
        "id": str(raw.get("id") or uuid_lib.uuid4().hex),
        "name": str(raw.get("name") or f"Section {index + 1}")[:64],
        "color": str(raw.get("color") or "#4a90d9")[:16],
        "enabled": bool(raw.get("enabled", True)),
        "randomize": bool(raw.get("randomize", False)),
        "show_label": bool(raw.get("show_label", False)),
        "end_separator": _normalize_end_separator(raw.get("end_separator", "none")),
        "order": order,
        "is_locked_prompt": bool(raw.get("is_locked_prompt", False)),
        "entries": entries,
    }


def validate_and_normalize_preset(data: dict) -> dict:
    """Coerce/validate a preset's structure defensively rather than
    trusting it blindly. Unknown fields are dropped; missing fields get
    sane defaults. Does NOT touch the library or resolve any
    prompt_ref -- structure only.
    """
    if not isinstance(data, dict):
        raise ValueError("Preset must be a JSON object")

    name = str(data.get("name") or "Untitled Preset")[:128]
    raw_sections = data.get("sections")
    if not isinstance(raw_sections, list):
        raw_sections = []

    sections = []
    for i, sec in enumerate(raw_sections):
        normalized = _normalize_section(sec, i)
        if normalized is not None:
            sections.append(normalized)

    return {"name": name, "sections": sections}


def list_presets() -> list:
    """List available presets with basic metadata (no full content)."""
    _ensure_initial_preset()
    result = []
    try:
        filenames = sorted(os.listdir(PRESETS_DIR))
    except FileNotFoundError:
        return result

    for fname in filenames:
        if not fname.endswith(".json"):
            continue
        path = os.path.join(PRESETS_DIR, fname)
        try:
            stat = os.stat(path)
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            result.append({
                "name": data.get("name", fname[:-5]),
                "filename": fname,
                "modified": stat.st_mtime,
                "section_count": len(data.get("sections", [])),
            })
        except Exception:
            continue

    result.sort(key=lambda p: p["name"].lower())
    return result


def get_preset(filename: str) -> dict:
    """Load and structurally validate a preset by filename. Raises
    FileNotFoundError / ValueError on missing or invalid files. Callers
    are responsible for resolving each entry's prompt_ref against the
    live library (missing ones simply won't resolve -- that's expected
    and not an error at this layer).
    """
    path = _resolve_within(PRESETS_DIR, filename)
    if not os.path.isfile(path):
        raise FileNotFoundError(filename)
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    return validate_and_normalize_preset(raw)


def save_preset(data: dict) -> str:
    """Save (create or overwrite) a preset. Returns the filename it was
    saved as."""
    preset = validate_and_normalize_preset(data)
    path = _preset_path(preset["name"])
    with open(path, "w", encoding="utf-8") as f:
        json.dump(preset, f, ensure_ascii=False)
    return os.path.basename(path)


def rename_preset(filename: str, new_name: str) -> str:
    old_path = _resolve_within(PRESETS_DIR, filename)
    if not os.path.isfile(old_path):
        raise FileNotFoundError(filename)

    new_name = (new_name or "").strip()
    if not new_name:
        raise ValueError("New name required")

    with open(old_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["name"] = new_name[:128]

    new_path = _preset_path(new_name)
    with open(new_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    if new_path != old_path:
        os.remove(old_path)

    return os.path.basename(new_path)


def delete_preset(filename: str) -> bool:
    path = _resolve_within(PRESETS_DIR, filename)
    if os.path.isfile(path):
        os.remove(path)
        return True
    return False


def _retarget_in_preset(data, pairs: dict) -> int:
    """Surgically rewrite matching entry prompt_refs inside ONE parsed
    preset dict; returns how many entries were rewritten. Deliberately
    NOT routed through validate_and_normalize_preset: a relink must not
    restamp entry ids, drop unknown fields, or otherwise rewrite parts
    of the file the user never touched -- swap the ref string, keep
    everything else byte-equal."""
    if not isinstance(data, dict):
        return 0
    changed = 0
    sections = data.get("sections")
    if not isinstance(sections, list):
        return 0
    for section in sections:
        if not isinstance(section, dict):
            continue
        entries = section.get("entries")
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            new = pairs.get(entry.get("prompt_ref"))
            if new is not None:
                entry["prompt_ref"] = new
                changed += 1
    return changed


def retarget_prompt_refs(ref_map: dict) -> dict:
    """Follow prompt_refs across ALL saved presets (round 15).

    A library rename re-hashes the UID (it is hash(name+text)), so the
    prompt's ref stem changes -- and every entry card in every preset
    file still holding the old ref would load as a missing card. The
    current node's live state is relinked client-side; this closes the
    server side of the same transaction: every .json in PRESETS_DIR is
    read, any entry ref found in `ref_map` ({old_ref: new_ref}) is
    swapped, and the file is rewritten atomically -- only if it changed.

    Never fatal for the rename that called it: unparseable or unwritable
    files are skipped (the rename itself already succeeded on disk), and
    a non-JSON file is simply not a preset. Presets are small structure
    files, so a whole-folder sweep costs milliseconds and needs no cache.

    Returns {"presets": <files rewritten>, "entries": <refs swapped>}.
    """
    stats = {"presets": 0, "entries": 0}
    try:
        pairs = {
            str(old): str(new)
            for old, new in (ref_map or {}).items()
            if isinstance(old, str) and old
            and isinstance(new, str) and new and old != new
        }
    except (AttributeError, TypeError):
        return stats
    if not pairs:
        return stats
    try:
        filenames = sorted(os.listdir(PRESETS_DIR))
    except FileNotFoundError:
        return stats
    for fname in filenames:
        if not fname.endswith(".json"):
            continue
        path = os.path.join(PRESETS_DIR, fname)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue  # unreadable/corrupt: never rewrite what cannot be parsed
        changed = _retarget_in_preset(data, pairs)
        if changed == 0:
            continue
        tmp_path = path + f".tmp-{uuid_lib.uuid4().hex}"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp_path, path)
        except OSError:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            continue
        # Count only what actually persisted: a file whose rewrite
        # failed still holds its old refs, so it reports nothing.
        stats["presets"] += 1
        stats["entries"] += changed
    return stats
