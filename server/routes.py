"""
routes.py

Thin aiohttp route registration for the Prompt Composer frontend.
All actual logic lives in library_store.py / preset_store.py /
image_utils.py -- this module only translates HTTP requests into calls
against those, and translates results/errors back into JSON responses.

Route groups:
- Library: scan, get, create, update, delete a prompt_data; category
  set; "already exists" check; serving thumbnail images. An update that
  MOVES the prompt_ref (rename/text edit re-hashes the UID) also sweeps
  every saved preset file to relink entry cards (see
  preset_store.retarget_prompt_refs).
- Resolve: batch prompt_ref -> content lookup, used by the JS live
  preview so it never re-implements PNG/metadata parsing itself (see
  library_store.py docstring on why this matters for correctness).
- Preset: list/get/save/rename/delete (structure-only, no content).

Dropped (do not re-add): base64 image upload/paste as a
freestanding endpoint pair, section export/import routes. Image bytes
now only ever enter the system as part of a library create/update
call; portability is handled by the PNG files themselves.
"""

import asyncio
import base64
import binascii
import json
import logging
import os
import re

from aiohttp import web

try:
    from . import image_utils
    from . import library_store
    from . import preset_store
    from .errors import AlreadyExistsError
except ImportError:  # pragma: no cover - allows standalone import during tests
    import image_utils
    import library_store
    import preset_store
    from errors import AlreadyExistsError

from server import PromptServer

log = logging.getLogger("prompt_composer")

# Registering the same route twice raises inside aiohttp, which would
# take the whole ComfyUI server down. Importing this module is the
# documented way to attach the routes, and an in-process reload (some
# ComfyUI builds re-import custom nodes) would do exactly that -- so the
# registration is idempotent.
_ROUTES_REGISTERED = globals().get("_ROUTES_REGISTERED", False)


class _AlreadyRegistered:
    """Stand-in for aiohttp's route table on a re-import.

    Its decorators return the handler untouched, so the second pass
    defines the same functions without registering them again. (A real
    duplicate registration raises inside aiohttp, which would take the
    whole ComfyUI server down rather than just this node.)
    """

    def _noop(self, *_args, **_kwargs):
        def decorator(func):
            return func
        return decorator

    get = post = put = delete = _noop


if _ROUTES_REGISTERED:
    log.debug("routes already registered; skipping re-registration")
    routes = _AlreadyRegistered()
else:
    routes = PromptServer.instance.routes
    _ROUTES_REGISTERED = True


def _error(exc: Exception, status: int = 400):
    return web.json_response({"error": str(exc)}, status=status)


def _write_error(exc: Exception):
    """Map a library/preset write failure onto the right status code.

    Plain bad input ("Prompt text is required", an image below the minimum
    size) is a 400. 409 Conflict is reserved for the one thing it means:
    this prompt already exists.
    """
    if isinstance(exc, AlreadyExistsError):
        return _error(exc, status=409)
    return _error(exc, status=400)


async def _off_loop(func, *args, **kwargs):
    """Run a blocking library/preset call on a worker thread.

    Every store call underneath these handlers does synchronous disk
    work -- listdir, stat, PIL decodes, PNG writes. Run inline in an
    `async def` handler, that work blocks ComfyUI's ENTIRE web server:
    progress updates stall, the queue UI freezes and other extensions'
    routes time out while a library scan runs. Offloading keeps the
    event loop free; the stores stay plain synchronous code, which is
    also what compose() calls them as from the execution thread.
    """
    if kwargs:
        def call():
            return func(*args, **kwargs)
        return await asyncio.to_thread(call)
    return await asyncio.to_thread(func, *args)


# Cap on an uploaded thumbnail, enforced while the body is still being
# READ rather than after all of it is already in memory (image_utils
# applies the same number once it has the bytes).
MAX_UPLOAD_BYTES = image_utils.MAX_INPUT_IMAGE_BYTES


# ---------------------------------------------------------------------------
# Library routes
# ---------------------------------------------------------------------------

@routes.get("/prompt_composer/library")
async def list_library(request):
    """Scan and return the library, alphabetically sorted. Scanning
    also normalizes/assigns UIDs on disk as a side effect (see
    library_store.scan_library).

    Chunked loading (see library_store.scan_library_page): when the
    query carries page_size, the response is the OBJECT shape
    {"entries", "next_cursor", "total"} and the client walks pages.
    Without page_size the response stays the bare array -- every
    pre-paging caller (and the parity tests) keep working unchanged.
    cursor=...&page_size=N on a fresh directory re-scans transparently
    (the offset then applies to the new list; the client dedups refs).
    """
    try:
        raw_page = request.query.get("page_size")
        raw_cursor = request.query.get("cursor")
        if not raw_page:
            entries = await _off_loop(library_store.scan_library)
            return web.json_response([library_store.to_client_entry(e) for e in entries])
        try:
            page_size = max(0, int(raw_page))
        except ValueError:
            page_size = 0
        try:
            cursor = int(raw_cursor or 0)
        except ValueError:
            cursor = 0
        force = str(request.query.get("force") or "").strip().lower() in ("1", "true", "yes")
        entries, next_cursor, total = await _off_loop(
            library_store.scan_library_page,
            page_size=page_size, cursor=cursor, force=force)
        return web.json_response({
            "entries": [library_store.to_client_entry(e) for e in entries],
            "next_cursor": next_cursor,
            "total": total,
        })
    except Exception as exc:  # pragma: no cover
        return _error(exc, status=500)


@routes.get("/prompt_composer/library/{prompt_ref}/image")
async def get_library_image(request):
    prompt_ref = request.match_info.get("prompt_ref", "")
    resolved = await _off_loop(library_store.resolve, prompt_ref)
    if resolved is None:
        return web.Response(status=404, text="Not found")
    # A prompt with no thumbnail lives as a .txt and has no image to
    # serve -- the frontend renders a placeholder for it instead of
    # requesting this route, but guard anyway so a stray request can't
    # stream a text file back as if it were a picture.
    if not resolved["filename"].lower().endswith(".png"):
        return web.Response(status=404, text="No thumbnail")
    try:
        path = library_store.get_library_file_path(resolved["filename"])
    except ValueError:
        return web.Response(status=400, text="Invalid filename")
    if not os.path.isfile(path):
        return web.Response(status=404, text="Not found")
    response = web.FileResponse(path)
    # Split cache policy on the ONE thing that distinguishes a
    # content-keyed URL from an anonymous one: the ?v= cache-buster the
    # frontend appends when a prompt's image bytes changed in this
    # session (api_client.invalidateLibraryImage / the rescan epoch).
    #
    # WITH ?v -- the URL identifies these exact pixels: cache it hard
    # (max-age + immutable) so a big grid never revalidates. A stale
    # body is impossible by construction: any later change bumps the
    # version again and the URL moves.
    #
    # WITHOUT ?v -- the URL is a bare ref, and the version that WOULD
    # have distinguished an image-only replacement lives only in the
    # frontend's memory: it is gone after a page reload, while the
    # bytes behind this same bare URL may have changed on disk in the
    # meantime. Caching that hard would let a replaced thumbnail
    # reappear stale for up to a day after a reload. So unversioned
    # answers are "no-cache": the browser may keep the copy but MUST
    # revalidate, and FileResponse already serves Last-Modified +
    # If-Modified-Since as a ~300-byte 304 when the pixels did not
    # change. (Known nit: HTTP dates are whole seconds, so a replacement
    # landing in the same second the bare URL was last served would
    # revalidate to a 304 of the old picture -- within a session the
    # ?v bump already routes around it, and it needs a reload inside
    # the same second to survive, so it stays theoretical.)
    if "v" in request.query:
        response.headers["Cache-Control"] = "public, max-age=86400, immutable"
    else:
        response.headers["Cache-Control"] = "no-cache"
    return response


@routes.post("/prompt_composer/library/check_exists")
async def check_library_exists(request):
    """Body: {"name": "...", "prompt": "...", "exclude_prompt_ref": "..."?}
    Returns {"exists": bool, "entry": {...} | null}
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    name = str(body.get("name") or "")
    prompt = str(body.get("prompt") or "")
    exclude_ref = body.get("exclude_prompt_ref")

    existing = await _off_loop(library_store.check_already_exists, name, prompt,
                               exclude_prompt_ref=exclude_ref)
    return web.json_response({"exists": existing is not None,
                              "entry": library_store.to_client_entry(existing)})


@routes.post("/prompt_composer/library")
async def create_library_entry(request):
    """Accepts multipart/form-data with fields:
        name (str), prompt (str), category (JSON array string, optional),
        folder (str, optional -- an existing library subfolder to create
        the prompt directly inside; see library_store.create_prompt_data),
        image (file, optional)
    or JSON body: {"name", "prompt", "category": [...], "folder": "...",
    "image_data_url": "..."?}
    """
    try:
        name, prompt, category, image_bytes, _clear_image, folder = await _parse_library_write_request(request)
        entry = await _off_loop(
            library_store.create_prompt_data, name, prompt,
            image_bytes=image_bytes, category=category,
            folder=(folder if folder is not library_store._UNSET else None),
        )
        return web.json_response(library_store.to_client_entry(entry))
    except ValueError as exc:
        return _write_error(exc)
    except Exception as exc:  # pragma: no cover
        return _error(exc, status=500)


@routes.put("/prompt_composer/library/{prompt_ref}")
async def update_library_entry(request):
    prompt_ref = request.match_info.get("prompt_ref", "")
    try:
        name, prompt, category, image_bytes, clear_image, folder = await _parse_library_write_request(
            request, allow_partial=True
        )
        entry = await _off_loop(
            library_store.update_prompt_data,
            prompt_ref,
            name=name,
            prompt=prompt,
            image_bytes=image_bytes,
            clear_image=clear_image,
            category=category,
            folder=folder,
        )
        # The UID is hash(name+text), so any rename/text edit
        # CAN move the ref -- and every entry card in EVERY saved
        # preset pointing at the old one would load as missing. The
        # node's live state is relinked client-side; this is the
        # server half: sweep all preset files in the same transaction.
        # Failures never undo the completed library write -- they print
        # (terminal = the channel that needs no DevTools) and the next
        # refresh still shows the renamed prompt itself fine.
        new_ref = entry.get("prompt_ref") if isinstance(entry, dict) else None
        if new_ref and prompt_ref and new_ref != prompt_ref:
            try:
                # Silent by design: the sweep
                # runs, but a successful relink is routine bookkeeping
                # and logs nothing. Only a FAILURE warns.
                await _off_loop(preset_store.retarget_prompt_refs, {prompt_ref: new_ref})
            except Exception as exc:  # pragma: no cover
                log.warning(
                    "preset relink failed after renaming '%s' -> '%s': %s -- other "
                    "presets may still point at the old ref until a manual fix",
                    prompt_ref, new_ref, exc,
                )
        return web.json_response(library_store.to_client_entry(entry))
    except ValueError as exc:
        return _write_error(exc)
    except Exception as exc:  # pragma: no cover
        return _error(exc, status=500)


@routes.delete("/prompt_composer/library/{prompt_ref}")
async def delete_library_entry(request):
    prompt_ref = request.match_info.get("prompt_ref", "")
    try:
        deleted = await _off_loop(library_store.delete_prompt_data, prompt_ref)
    except ValueError as exc:
        return _error(exc, status=400)
    except Exception as exc:  # pragma: no cover - never answer with a traceback
        log.exception("delete failed for %s", prompt_ref)
        return _error(exc, status=500)
    return web.json_response({"ok": True, "deleted": deleted})


# ---------------------------------------------------------------------------
# Category routes -- category IDENTITY (the sidecar index), distinct
# from the tag-assignment on one prompt_data done by the
# create/update handlers above. These back the dedicated "Category
# Options" toolbar: create/rename/delete a category as a first-class
# thing, independent of which prompts currently carry it.
# ---------------------------------------------------------------------------

@routes.get("/prompt_composer/categories")
async def list_categories(request):
    """?with_folders=1 additionally appends one FOLDER-derived pseudo-
    category per library subfolder (see library_store.
    list_categories_with_folders) -- for the search toolbar's dropdown.
    Without it (the default), the plain list -- for the "edit prompt"
    panel's tag picker, which must never offer a folder as something to
    individually tag a prompt into."""
    with_folders = str(request.query.get("with_folders") or "").strip().lower() in ("1", "true", "yes")
    fn = library_store.list_categories_with_folders if with_folders else library_store.list_categories
    try:
        return web.json_response(await _off_loop(fn))
    except Exception as exc:  # pragma: no cover
        log.exception("category listing failed")
        return _error(exc, status=500)


@routes.post("/prompt_composer/categories")
async def create_category(request):
    """A `name` starting with the folder-pseudo-category marker ("📁 ")
    creates a real on-disk library subfolder instead of an ordinary
    sidecar-index category -- see library_store.create_category /
    create_folder_category."""
    try:
        body = await request.json()
        name = await _off_loop(library_store.create_category, body.get("name"))
        return web.json_response({"ok": True, "name": name})
    except (ValueError, OSError) as exc:
        return _error(exc, status=400)
    except Exception as exc:  # pragma: no cover
        log.exception("category create failed")
        return _error(exc, status=500)


@routes.put("/prompt_composer/categories/{name}")
async def rename_category(request):
    """Renaming a folder-derived pseudo-category (old name starts with
    "📁 ") renames the actual on-disk subfolder -- see
    library_store.rename_category / rename_folder_category."""
    old_name = request.match_info.get("name", "")
    try:
        body = await request.json()
        new_name = await _off_loop(library_store.rename_category, old_name, body.get("name"))
        return web.json_response({"ok": True, "name": new_name})
    except (ValueError, OSError) as exc:
        return _error(exc, status=400)
    except Exception as exc:  # pragma: no cover
        log.exception("category rename failed")
        return _error(exc, status=500)


@routes.delete("/prompt_composer/categories/{name}")
async def delete_category(request):
    name = request.match_info.get("name", "")
    try:
        deleted = await _off_loop(library_store.delete_category, name)
    except ValueError as exc:  # e.g. the protected built-in "Favorite"
        return _error(exc, status=400)
    except Exception as exc:  # pragma: no cover
        log.exception("category delete failed")
        return _error(exc, status=500)
    return web.json_response({"ok": True, "deleted": deleted})


async def _read_capped(field, max_bytes: int) -> bytes:
    """Read one multipart field, aborting past `max_bytes`.

    `field.read()` buffers the whole part before anyone can object, so a
    huge upload was fully resident in memory before image_utils applied
    the very same cap. Reading in chunks refuses it on the way in.
    """
    chunks = []
    total = 0
    while True:
        chunk = await field.read_chunk()
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise ValueError(
                f"Image too large (over {max_bytes // (1024 * 1024)} MB)")
        chunks.append(chunk)
    return b"".join(chunks)


async def _parse_library_write_request(request, allow_partial=False):
    """Shared body-parsing for create/update: supports both
    multipart/form-data (file picker / drag-and-drop uploads) and a
    plain JSON body carrying a data: URL for the image. Returns
    (name, prompt, category, image_bytes, clear_image, folder) where
    any of name/prompt/category/image_bytes may be None when
    allow_partial=True and the field wasn't supplied (used by the
    update route, where omitted fields mean "leave unchanged").
    `folder` is library_store._UNSET when the field wasn't supplied at
    all (leave unchanged), so it can still carry "" as a real, explicit
    "move to the library root" instruction.

    IMPORTANT: an aiohttp request body can only be consumed ONCE. This
    function is the single place that reads it for both create and
    update, including the update-only "clear_image" flag -- do not add
    a second read (e.g. a follow-up request.json() call) anywhere else
    in a route handler that already called this.
    """
    name = None
    prompt = None
    category = None
    image_bytes = None
    clear_image = False
    folder = library_store._UNSET

    if request.content_type and request.content_type.startswith("multipart/"):
        reader = await request.multipart()
        while True:
            field = await reader.next()
            if field is None:
                break
            if field.name == "name":
                name = (await field.read(decode=True)).decode("utf-8")
            elif field.name == "prompt":
                prompt = (await field.read(decode=True)).decode("utf-8")
            elif field.name == "category":
                raw_cat = (await field.read(decode=True)).decode("utf-8")
                try:
                    parsed = json.loads(raw_cat)
                    category = parsed if isinstance(parsed, list) else None
                except (json.JSONDecodeError, TypeError):
                    category = None
            elif field.name == "clear_image":
                raw_clear = (await field.read(decode=True)).decode("utf-8")
                clear_image = raw_clear.strip().lower() in ("1", "true", "yes")
            elif field.name == "folder":
                folder = (await field.read(decode=True)).decode("utf-8")
            elif field.name == "image":
                image_bytes = await _read_capped(field, MAX_UPLOAD_BYTES)
    else:
        body = await request.json()
        if "name" in body:
            name = str(body.get("name") or "")
        if "prompt" in body:
            prompt = str(body.get("prompt") or "")
        if "category" in body and isinstance(body.get("category"), list):
            category = body["category"]
        if "folder" in body:
            folder = str(body.get("folder") or "")
        clear_image = bool(body.get("clear_image"))
        data_url = body.get("image_data_url")
        if data_url:
            match = re.match(r"^data:image/[a-zA-Z0-9.+-]+;base64,(.+)$", data_url)
            if match:
                encoded = match.group(1)
                # 4 base64 characters carry 3 bytes: reject an oversized
                # payload from its LENGTH, before allocating the decode.
                if len(encoded) // 4 * 3 > MAX_UPLOAD_BYTES:
                    raise ValueError("Image too large")
                try:
                    image_bytes = base64.b64decode(encoded, validate=True)
                except (binascii.Error, ValueError) as exc:
                    raise ValueError(f"Malformed image data URL: {exc}") from exc

    if not allow_partial:
        name = name or ""
        prompt = prompt or ""

    return name, prompt, category, image_bytes, clear_image, folder


# ---------------------------------------------------------------------------
# Resolve routes (used by JS live preview -- see library_store.py
# docstring: this is the ONLY resolution path besides compose() itself,
# both going through library_store.resolve()/resolve_many() so preview
# and actual queued output can never disagree)
# ---------------------------------------------------------------------------

@routes.post("/prompt_composer/resolve")
async def resolve_prompt_refs(request):
    """Body: {"prompt_refs": ["Name_UID", ...]}
    Returns: {"Name_UID": {name, uid, prompt_ref, prompt, category,
              filename, has_thumbnail, folder}, ...}
    (Only successfully-resolved refs are present in the response --
    missing/unresolvable ones are simply absent, per the documented
    "missing entry -> empty slot" rule.)
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    prompt_refs = body.get("prompt_refs")
    if not isinstance(prompt_refs, list):
        return web.json_response({"error": "'prompt_refs' must be a list"}, status=400)

    resolved = await _off_loop(library_store.resolve_many, prompt_refs)
    # Keys stay canonical prompt_refs -- the client looks entries up by
    # exactly the string it sent. Only the `name` inside is prettified.
    return web.json_response(
        {ref: library_store.to_client_entry(data) for ref, data in resolved.items()}
    )


@routes.post("/prompt_composer/compose")
async def compose_preview(request):
    """Body: {"sections": [...], "seed": int, "user_prompt": str,
              "fallback_contents": {prompt_ref: {"prompt": ...}, ...}}
    Returns: {"prompt": str, "resolved": {ref: client_entry, ...},
              "chosen": {section_id: [entry_id, ...], ...}}

    Runs the node's OWN compose pipeline (the same
    _resolve_entries_text + compose_prompt that PromptComposerNode.
    compose() executes at queue time) against the supplied state, so
    the JS live preview can show the server's answer verbatim --
    including queue-time randomization picks, which the browser
    deliberately cannot reproduce (JS hashStringToIndex != Python
    random.Random). `resolved` carries the live library answer for
    every ref (via resolved_out -- one scan, no duplicated logic),
    letting the preview refresh its content cache (and thereby the
    save-side snapshot) in the same round-trip as the /resolve it
    replaces. `chosen` carries compose_prompt's own record (via
    chosen_out) of exactly which entry id(s) each section's block was
    built from -- the ONLY way to know which pool member a randomized
    section's rng.choice() actually picked, since the joined prompt
    string on its own no longer distinguishes "this text came from
    entry X" once it's flattened. `fallback_contents` follows
    compose()'s exact rule: consulted only where the live library has
    nothing.
    """
    # Lazy import: prompt_composer_node is a sibling of this package's
    # server/ dir; importing it at module load would risk a cycle
    # through __init__ (which imports the node before these routes).
    from .. import prompt_composer_node

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    sections = body.get("sections")
    if not isinstance(sections, list):
        return web.json_response({"error": "'sections' must be a list"}, status=400)
    try:
        seed = int(body.get("seed", 0) or 0)
    except (TypeError, ValueError):
        return web.json_response({"error": "'seed' must be an integer"}, status=400)
    user_prompt = body.get("user_prompt", "")
    if not isinstance(user_prompt, str):
        return web.json_response({"error": "'user_prompt' must be a string"}, status=400)
    fallback = body.get("fallback_contents")
    if fallback is not None and not isinstance(fallback, dict):
        return web.json_response({"error": "'fallback_contents' must be an object"}, status=400)

    resolved_live = {}
    chosen_entries_by_section = {}

    def run_compose():
        # Same defensive sort compose() applies, in the same place.
        ordered = sections
        if ordered and all(isinstance(x, dict) and "order" in x for x in ordered):
            ordered = sorted(ordered, key=lambda x: x.get("order", 0))
        resolved_sections = prompt_composer_node._resolve_entries_text(
            ordered, fallback_contents=fallback, resolved_out=resolved_live
        )
        return prompt_composer_node.compose_prompt(
            resolved_sections, seed=seed, user_prompt=user_prompt,
            chosen_out=chosen_entries_by_section,
        )

    try:
        # Resolution reads every referenced file: off the event loop.
        prompt = await _off_loop(run_compose)
    except Exception as exc:  # never leak a traceback as a 500 body
        return web.json_response({"error": str(exc)}, status=500)

    return web.json_response({
        "prompt": prompt,
        "resolved": {
            ref: library_store.to_client_entry(data)
            for ref, data in resolved_live.items()
        },
        # {section_id: [entry_id, ...]}, exactly what compose_prompt's
        # own randomization picked for each section (see its chosen_out
        # docstring). The JS preview uses this to paint/highlight the
        # SAME entry this prompt string was actually built from,
        # instead of recomputing its own guess with a different PRNG.
        "chosen": chosen_entries_by_section,
    })


@routes.get("/prompt_composer/last_output/{prompt_id}/{node_id}")
async def get_last_output(request):
    """The string Prompt Composer node `node_id` ACTUALLY
    emitted last (see the stash in prompt_composer_node.py). The address
    is the NODE ID -- prompt_id is in the URL for provenance but is not
    matched, because some ComfyUI builds inject an empty PROMPT_ID into
    the node while still sending the real one to the frontend, and
    requiring both could never agree. 404 whenever the stash has nothing
    for that node -- never-run, evicted, or a server restart -- which the
    frontend treats as "no executed answer", not an error.
    """
    # Same lazy-import rationale as /compose (avoid the __init__ cycle).
    from .. import prompt_composer_node

    prompt_id = request.match_info.get("prompt_id", "")
    node_id = request.match_info.get("node_id", "")
    client_key = request.query.get("client_key", "")
    record = prompt_composer_node.get_executed_output(prompt_id, node_id,
                                                      client_key=client_key)
    if record is None:
        return web.json_response({"error": "no recorded output"}, status=404)
    return web.json_response(record)


@routes.get("/prompt_composer/c3_status")
async def c3_status(request):
    """Executed-output diagnostics: is the stash alive, and WHAT has it recorded?

    Open this in a plain browser tab after queueing the node and the
    answer bisects the whole chain: "recorded: 0" means the node's
    compose() never wrote a record (check the ComfyUI terminal for a
    "C3: compose ran WITHOUT node identity injection" warning -- injection or execution issue, server
    side); a listing whose node_id does not match the composer's id
    shown in the UI means the CLIENT fetch is asking for the wrong key;
    a matching entry with no chip means the browser event never landed
    (and the frontend's /c3_status poller covers exactly that case,
    adopting full text through this endpoint alone). Local ComfyUI only;
    returns each node's most recent output (bounded 10 records, 20k
    chars) for that reason.
    """
    from .. import prompt_composer_node

    # Full prompt text is OPT-IN (?full=1). The default answer carries
    # only what the poller needs to decide whether to adopt -- identity,
    # timestamp, length, and a short head for diagnostics. This route is
    # unauthenticated like every ComfyUI route, and it was handing ten
    # nodes' worth of complete prompt text to any caller on every 2.5s
    # poll; the adopting client asks for the body deliberately.
    want_full = str(request.query.get("full") or "").strip().lower() in ("1", "true", "yes")
    with prompt_composer_node._LAST_OUTPUTS_LOCK:
        items = list(prompt_composer_node._LAST_OUTPUTS.items())
    entries = []
    for key, val in items[-10:]:
        text = val.get("prompt") or ""
        record = {
            # The stash address is (client_key, node_id); node_id is
            # reported on its own so a client can match its own nodes.
            "key": key,
            "node_id": val.get("node_id", key.split("|")[-1]),
            "client_key": val.get("client_key", ""),
            "prompt_id": val.get("prompt_id", ""),
            "at": val.get("at"),
            "seed": val.get("seed"),
            "chars": len(text),
            "text_head": text[:80],
        }
        if want_full:
            record["prompt"] = text[:20000]
        entries.append(record)
    return web.json_response({"ok": True, "recorded": len(items), "entries": entries})


@routes.get("/prompt_composer/version")
async def get_version(request):
    """The installed node's version, read from the package's single
    source of truth (__init__.__version__).

    The frontend reads the version from here instead of keeping its own
    copy, so the version has exactly one home.
    """
    try:
        from .. import __version__ as version
    except Exception:  # pragma: no cover - defensive
        version = "unknown"
    return web.json_response({"version": version})


# ---------------------------------------------------------------------------
# Preset routes (structure only -- see preset_store.py)
# ---------------------------------------------------------------------------

@routes.get("/prompt_composer/presets")
async def list_presets(request):
    try:
        return web.json_response(await _off_loop(preset_store.list_presets))
    except Exception as exc:  # pragma: no cover
        log.exception("preset listing failed")
        return _error(exc, status=500)


@routes.get("/prompt_composer/presets/{filename}")
async def get_preset(request):
    filename = request.match_info.get("filename", "")
    try:
        preset = await _off_loop(preset_store.get_preset, filename)
        return web.json_response(preset)
    except FileNotFoundError:
        return web.Response(status=404, text="Not found")
    except ValueError as exc:
        return _error(exc, status=400)


@routes.post("/prompt_composer/presets")
async def save_preset(request):
    body_bytes = await request.read()
    if len(body_bytes) > preset_store.MAX_PRESET_JSON_BYTES:
        return web.json_response({"error": "Preset too large"}, status=413)

    try:
        raw = json.loads(body_bytes.decode("utf-8"))
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    # An explicit `filename` means "overwrite the preset I loaded";
    # without it the store creates, never clobbers (see save_preset).
    target = raw.pop("filename", None) if isinstance(raw, dict) else None
    try:
        filename = await _off_loop(preset_store.save_preset, raw,
                                   filename=target if isinstance(target, str) else None)
        return web.json_response({"ok": True, "filename": filename})
    except ValueError as exc:
        return _error(exc, status=400)
    except Exception as exc:  # pragma: no cover
        log.exception("preset save failed")
        return _error(exc, status=500)


@routes.put("/prompt_composer/presets/{filename}/rename")
async def rename_preset(request):
    filename = request.match_info.get("filename", "")
    try:
        body = await request.json()
        new_name = body.get("name")
        new_filename = await _off_loop(preset_store.rename_preset, filename, new_name)
        return web.json_response({"ok": True, "filename": new_filename})
    except FileNotFoundError:
        return web.Response(status=404, text="Not found")
    except ValueError as exc:
        return _error(exc, status=400)


@routes.delete("/prompt_composer/presets/{filename}")
async def delete_preset(request):
    filename = request.match_info.get("filename", "")
    try:
        deleted = await _off_loop(preset_store.delete_preset, filename)
    except ValueError as exc:
        return _error(exc, status=400)
    except Exception as exc:  # pragma: no cover
        log.exception("preset delete failed")
        return _error(exc, status=500)
    return web.json_response({"ok": True, "deleted": deleted})
