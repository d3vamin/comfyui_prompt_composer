"""
paths.py

Where Prompt Composer keeps USER DATA (the prompt library and the saved
presets).

Historically both lived inside the custom node's own folder
(``custom_nodes/comfyui_prompt_composer/library`` and ``.../presets``).
That is the one place they must not be: updating the node through git or
ComfyUI Manager can replace/clean that directory, and a user's entire
prompt library goes with it.

So the real home is ComfyUI's user directory --
``<user>/prompt_composer/{library,presets}`` -- resolved through
``folder_paths`` when ComfyUI is importable, and falling back to the
legacy in-node location when it is not (standalone tests, or a ComfyUI
build with no ``folder_paths``).

Migration is automatic, one-way and non-destructive: the first time a
directory is needed, every item still sitting in the legacy folder is
MOVED into the new one. It is a per-item MERGE, so a new folder that
already has files (an auto-created ``_categories.json`` or ``Preset_001``,
say) no longer blocks it:

  * an item missing from the new folder is moved across;
  * a sub-folder present on both sides is merged recursively;
  * a file whose NAME already exists in the new folder is never moved,
    copied or deleted -- the user's copy wins and the node-folder file
    stays where it is, whatever its content (this applies to prompts and
    presets alike);
  * only ``_categories.json`` is treated specially: category names that
    exist only in the legacy index are added to the user's index (the
    legacy file itself stays).

A ``_moved_to_user_dir.txt`` breadcrumb is written in the old folder once
the merge finished without failures (files that already existed in the new
folder may remain beside it). If an item fails to move, it simply stays in
the legacy folder, a warning is logged, and the next start retries it. A file that was copied across but whose
original is locked by another program (WinError 32) counts as migrated;
the original just stays where it is.
"""

import json
import logging
import os
import shutil
import threading
import time

log = logging.getLogger("prompt_composer")

_LOG_PREFIX = "[Prompt Composer] "


class _PrefixFilter(logging.Filter):
    """Start every message of the node's logger with "[Prompt Composer]" so
    a line in the shared ComfyUI console is clearly ours. Every module of
    the node logs through the "prompt_composer" logger and imports this
    module, so this is the one place it needs installing."""

    def filter(self, record):
        if isinstance(record.msg, str) and not record.msg.startswith(_LOG_PREFIX):
            record.msg = _LOG_PREFIX + record.msg
        return True


if not any(isinstance(f, _PrefixFilter) for f in log.filters):
    log.addFilter(_PrefixFilter())

NODE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LEGACY_LIBRARY_DIR = os.path.join(NODE_DIR, "library")
LEGACY_PRESETS_DIR = os.path.join(NODE_DIR, "presets")

_MIGRATION_NOTE = "_moved_to_user_dir.txt"


def _user_root() -> str | None:
    """ComfyUI's user directory, or None when ComfyUI isn't importable."""
    try:
        import folder_paths  # type: ignore
    except Exception:
        return None
    try:
        getter = getattr(folder_paths, "get_user_directory", None)
        if callable(getter):
            return getter()
        base = getattr(folder_paths, "base_path", None)
        if base:
            return os.path.join(base, "user")
    except Exception:  # pragma: no cover - defensive
        return None
    return None


def _has_content(path: str) -> bool:
    """True when `path` holds anything besides our own breadcrumb."""
    try:
        return any(e.name != _MIGRATION_NOTE for e in os.scandir(path))
    except OSError:
        return False


def _remove_with_retry(path: str, attempts: int = 5, delay: float = 0.2) -> bool:
    """Delete `path`, retrying briefly. On Windows a file can be locked for
    a moment by an indexer, antivirus scan, Explorer preview or cloud-sync
    client (WinError 32); that is usually transient."""
    for i in range(attempts):
        try:
            os.remove(path)
            return True
        except FileNotFoundError:
            return True
        except OSError:
            if i + 1 < attempts:
                time.sleep(delay)
    return False


def _move_file(src: str, dst: str, stats: dict) -> None:
    """Move one file to a destination that does not exist yet.

    Prefer an atomic rename. If the OS refuses (cross-device, or the
    source is held open on Windows) fall back to copy-then-delete -- but
    unlike shutil.move, a failed delete is NOT an error: the data is
    already safely in the new folder, so the original just stays where it
    is (counted in stats["present"]) and never fails the migration.
    """
    try:
        os.rename(src, dst)
        return
    except OSError:
        pass
    tmp = dst + ".tmp-migrate"
    try:
        shutil.copy2(src, tmp)
        os.replace(tmp, dst)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    # Best effort only: if the original is locked (WinError 32) it simply
    # stays behind, exactly like any other already-present file.
    if not _remove_with_retry(src):
        stats["present"] += 1


def _merge_categories_json(src: str, dst: str) -> bool:
    """Add any category names only the legacy `_categories.json` knows to the
    user one (destination wins on a clash). The legacy file is not touched."""
    try:
        with open(src, "r", encoding="utf-8") as f:
            old = json.load(f)
        with open(dst, "r", encoding="utf-8") as f:
            cur = json.load(f)
        if not isinstance(old, dict) or not isinstance(cur, dict):
            return False
        lower = {k.lower() for k in cur}
        for k, v in old.items():
            if k.lower() not in lower:
                cur[k] = v
        tmp = dst + ".tmp-migrate"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cur, f, ensure_ascii=False, indent=2)
        os.replace(tmp, dst)
        return True
    except (OSError, ValueError):
        return False


def _merge_dir(src_dir: str, dst_dir: str, top_level: bool, stats: dict) -> None:
    """Move every item of `src_dir` into `dst_dir` without overwriting."""
    os.makedirs(dst_dir, exist_ok=True)
    for name in os.listdir(src_dir):
        if top_level and name == _MIGRATION_NOTE:
            continue
        src = os.path.join(src_dir, name)
        dst = os.path.join(dst_dir, name)
        try:
            if os.path.isdir(src):
                if os.path.lexists(dst) and not os.path.isdir(dst):
                    stats["left"] += 1  # folder-vs-file clash: leave for the user
                else:
                    _merge_dir(src, dst, False, stats)  # creates dst if missing
            elif not os.path.lexists(dst):
                _move_file(src, dst, stats)
                stats["moved"] += 1
            elif os.path.isdir(dst):
                stats["left"] += 1  # file-vs-folder clash
            elif top_level and name == "_categories.json":
                _merge_categories_json(src, dst)  # additive only; src stays
            else:
                # A file with this name already exists in the user folder:
                # keep the user's copy and leave the node-folder one alone,
                # whatever its content (the library scan may have re-encoded
                # the user's copy, so bytes are not a reliable comparison).
                stats["present"] += 1
        except OSError as exc:
            stats["left"] += 1
            log.warning("could not move %s to %s: %s", src, dst, exc)
    if not top_level:
        try:
            os.rmdir(src_dir)  # only succeeds when fully emptied
        except OSError:
            pass


def _noun(legacy_dir: str) -> str:
    """"preset" for the presets folder, "prompt" for the library."""
    return "preset" if os.path.basename(legacy_dir.rstrip("/\\")) == "presets" else "prompt"


def _count(n: int, noun: str) -> str:
    """"1 prompt" / "3 prompts"."""
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def _migrate(legacy_dir: str, new_dir: str) -> None:
    """Merge everything from `legacy_dir` into `new_dir` (best effort)."""
    if not _has_content(legacy_dir):
        return
    noun = _noun(legacy_dir)
    stats = {"moved": 0, "left": 0, "present": 0}
    try:
        _merge_dir(legacy_dir, new_dir, True, stats)
    except OSError as exc:
        log.warning("data migration from %s to %s stopped after %s: %s",
                    legacy_dir, new_dir, _count(stats["moved"], noun), exc)
        return
    if stats["left"]:
        log.warning("data migration from %s to %s left %s behind "
                    "(name clash with a folder, or a move failed); "
                    "will retry on next start",
                    legacy_dir, new_dir, _count(stats["left"], noun))
    else:
        try:
            with open(os.path.join(legacy_dir, _MIGRATION_NOTE), "w",
                      encoding="utf-8") as f:
                f.write(
                    "Prompt Composer moved this folder's contents to:\n"
                    f"{new_dir}\n\n"
                    "User data no longer lives inside the custom node folder, so a\n"
                    "node update can never delete it. Any file still listed here\n"
                    "already exists in that folder and was left untouched; it is\n"
                    "safe to delete. This file is only a marker.\n"
                )
        except OSError as exc:
            log.warning("could not write migration marker in %s: %s", legacy_dir, exc)
    if stats["moved"]:
        log.info("moved %s from %s to %s",
                 _count(stats["moved"], noun), legacy_dir, new_dir)
    if stats["present"]:
        n = stats["present"]
        log.info("%s in %s already %s in %s and %s left in place",
                 _count(n, noun), legacy_dir,
                 "exists" if n == 1 else "exist", new_dir,
                 "was" if n == 1 else "were")


def _resolve(subdir: str, legacy_dir: str) -> str:
    root = _user_root()
    if not root:
        # No ComfyUI user directory available (standalone import, or a
        # build with no folder_paths): keep the legacy in-node location,
        # but it must still actually EXIST -- nothing else in this
        # module creates it at import time any more (see the "no
        # import-time side effects" note on library_store), so the
        # first caller to ask for the path is the only remaining place
        # that can.
        os.makedirs(legacy_dir, exist_ok=True)
        return legacy_dir
    new_dir = os.path.join(root, "prompt_composer", subdir)
    try:
        _migrate(legacy_dir, new_dir)
        os.makedirs(new_dir, exist_ok=True)
    except OSError as exc:  # pragma: no cover - defensive
        log.warning("cannot use %s (%s); falling back to %s", new_dir, exc, legacy_dir)
        os.makedirs(legacy_dir, exist_ok=True)
        return legacy_dir
    return new_dir


_cache: dict[str, str] = {}
# One lock for the whole resolve-and-migrate step: several first requests
# (library, presets, a queued execution) can arrive together, and two
# threads migrating the same files at once would fight over them -- on
# Windows that surfaces as "being used by another process".
_lock = threading.RLock()


def library_dir() -> str:
    """Absolute path of the prompt library folder (created on first use)."""
    with _lock:
        if "library" not in _cache:
            _cache["library"] = _resolve("library", LEGACY_LIBRARY_DIR)
        return _cache["library"]


def presets_dir() -> str:
    """Absolute path of the presets folder (created on first use)."""
    with _lock:
        if "presets" not in _cache:
            _cache["presets"] = _resolve("presets", LEGACY_PRESETS_DIR)
        return _cache["presets"]
