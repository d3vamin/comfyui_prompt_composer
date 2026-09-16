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
  every saved preset file to relink entry cards (round 15, see
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

import os

from aiohttp import web

try:
    from . import library_store
    from . import preset_store
except ImportError:  # pragma: no cover - allows standalone import during tests
    import library_store
    import preset_store

from server import PromptServer

routes = PromptServer.instance.routes


def _error(exc: Exception, status: int = 400):
    return web.json_response({"error": str(exc)}, status=status)


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
            entries = library_store.scan_library()
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
        entries, next_cursor, total = library_store.scan_library_page(
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
    resolved = library_store.resolve(prompt_ref)
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
    # meantime. Caching that hard was the bug -- a replaced thumbnail
    # reappeared stale for up to a day after a reload. So unversioned
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

    existing = library_store.check_already_exists(name, prompt, exclude_prompt_ref=exclude_ref)
    return web.json_response({"exists": existing is not None,
                              "entry": library_store.to_client_entry(existing)})


@routes.post("/prompt_composer/library")
async def create_library_entry(request):
    """Accepts multipart/form-data with fields:
        name (str), prompt (str), category (JSON array string, optional),
        image (file, optional)
    or JSON body: {"name", "prompt", "category": [...], "image_data_url": "..."?}
    """
    try:
        name, prompt, category, image_bytes, _clear_image = await _parse_library_write_request(request)
        entry = library_store.create_prompt_data(name, prompt, image_bytes=image_bytes, category=category)
        return web.json_response(library_store.to_client_entry(entry))
    except ValueError as exc:
        return _error(exc, status=409)
    except Exception as exc:  # pragma: no cover
        return _error(exc, status=500)


@routes.put("/prompt_composer/library/{prompt_ref}")
async def update_library_entry(request):
    prompt_ref = request.match_info.get("prompt_ref", "")
    try:
        name, prompt, category, image_bytes, clear_image = await _parse_library_write_request(
            request, allow_partial=True
        )
        entry = library_store.update_prompt_data(
            prompt_ref,
            name=name,
            prompt=prompt,
            image_bytes=image_bytes,
            clear_image=clear_image,
            category=category,
        )
        # Round 15: the UID is hash(name+text), so any rename/text edit
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
                # Silence by design (user request, post-15c): the sweep
                # runs, but a successful relink is routine bookkeeping
                # and prints nothing. Only a FAILURE warns.
                preset_store.retarget_prompt_refs({prompt_ref: new_ref})
            except Exception as exc:  # pragma: no cover
                print(
                    f"Prompt Composer: WARNING preset relink failed after "
                    f"renaming '{prompt_ref}' -> '{new_ref}': {exc} -- other "
                    f"presets may still point at the old ref until a manual fix"
                )
        return web.json_response(library_store.to_client_entry(entry))
    except ValueError as exc:
        return _error(exc, status=409)
    except Exception as exc:  # pragma: no cover
        return _error(exc, status=500)


@routes.delete("/prompt_composer/library/{prompt_ref}")
async def delete_library_entry(request):
    prompt_ref = request.match_info.get("prompt_ref", "")
    deleted = library_store.delete_prompt_data(prompt_ref)
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
    return web.json_response(library_store.list_categories())


@routes.post("/prompt_composer/categories")
async def create_category(request):
    try:
        body = await request.json()
        name = library_store.create_category(body.get("name"))
        return web.json_response({"ok": True, "name": name})
    except ValueError as exc:
        return _error(exc, status=400)


@routes.put("/prompt_composer/categories/{name}")
async def rename_category(request):
    old_name = request.match_info.get("name", "")
    try:
        body = await request.json()
        new_name = library_store.rename_category(old_name, body.get("name"))
        return web.json_response({"ok": True, "name": new_name})
    except ValueError as exc:
        return _error(exc, status=400)


@routes.delete("/prompt_composer/categories/{name}")
async def delete_category(request):
    name = request.match_info.get("name", "")
    try:
        deleted = library_store.delete_category(name)
    except ValueError as exc:  # e.g. the protected built-in "Favorite"
        return _error(exc, status=400)
    return web.json_response({"ok": True, "deleted": deleted})


async def _parse_library_write_request(request, allow_partial=False):
    """Shared body-parsing for create/update: supports both
    multipart/form-data (file picker / drag-and-drop uploads) and a
    plain JSON body carrying a data: URL for the image. Returns
    (name, prompt, category, image_bytes, clear_image) where any of
    name/prompt/category/image_bytes may be None when
    allow_partial=True and the field wasn't supplied (used by the
    update route, where omitted fields mean "leave unchanged").

    IMPORTANT: an aiohttp request body can only be consumed ONCE. This
    function is the single place that reads it for both create and
    update, including the update-only "clear_image" flag -- do not add
    a second read (e.g. a follow-up request.json() call) anywhere else
    in a route handler that already called this.
    """
    import base64
    import json
    import re

    name = None
    prompt = None
    category = None
    image_bytes = None
    clear_image = False

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
            elif field.name == "image":
                image_bytes = await field.read(decode=True)
    else:
        body = await request.json()
        if "name" in body:
            name = str(body.get("name") or "")
        if "prompt" in body:
            prompt = str(body.get("prompt") or "")
        if "category" in body and isinstance(body.get("category"), list):
            category = body["category"]
        clear_image = bool(body.get("clear_image"))
        data_url = body.get("image_data_url")
        if data_url:
            match = re.match(r"^data:image/[a-zA-Z0-9.+-]+;base64,(.+)$", data_url)
            if match:
                image_bytes = base64.b64decode(match.group(1), validate=True)

    if not allow_partial:
        name = name or ""
        prompt = prompt or ""

    return name, prompt, category, image_bytes, clear_image


# ---------------------------------------------------------------------------
# Resolve routes (used by JS live preview -- see library_store.py
# docstring: this is the ONLY resolution path besides compose() itself,
# both going through library_store.resolve()/resolve_many() so preview
# and actual queued output can never disagree)
# ---------------------------------------------------------------------------

@routes.post("/prompt_composer/resolve")
async def resolve_prompt_refs(request):
    """Body: {"prompt_refs": ["Name_UID", ...]}
    Returns: {"Name_UID": {name, uid, prompt_ref, prompt, category, filename}, ...}
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

    resolved = library_store.resolve_many(prompt_refs)
    # Keys stay canonical prompt_refs -- the client looks entries up by
    # exactly the string it sent. Only the `name` inside is prettified.
    return web.json_response(
        {ref: library_store.to_client_entry(data) for ref, data in resolved.items()}
    )


@routes.post("/prompt_composer/compose")
async def compose_preview(request):
    """Body: {"sections": [...], "seed": int, "user_prompt": str,
              "fallback_contents": {prompt_ref: {"prompt": ...}, ...}}
    Returns: {"prompt": str, "resolved": {ref: client_entry, ...}}

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
    replaces. `fallback_contents` follows compose()'s exact rule:
    consulted only where the live library has nothing.
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
    try:
        # Same defensive sort compose() applies, in the same place.
        if sections and all(isinstance(s, dict) and "order" in s for s in sections):
            sections = sorted(sections, key=lambda s: s.get("order", 0))
        resolved_sections = prompt_composer_node._resolve_entries_text(
            sections, fallback_contents=fallback, resolved_out=resolved_live
        )
        prompt = prompt_composer_node.compose_prompt(
            resolved_sections, seed=seed, user_prompt=user_prompt
        )
    except Exception as exc:  # never leak a traceback as a 500 body
        return web.json_response({"error": str(exc)}, status=500)

    return web.json_response({
        "prompt": prompt,
        "resolved": {
            ref: library_store.to_client_entry(data)
            for ref, data in resolved_live.items()
        },
    })


@routes.get("/prompt_composer/last_output/{prompt_id}/{node_id}")
async def get_last_output(request):
    """Layer C3: the string Prompt Composer node `node_id` ACTUALLY
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
    record = prompt_composer_node.get_executed_output(prompt_id, node_id)
    if record is None:
        return web.json_response({"error": "no recorded output"}, status=404)
    return web.json_response(record)


@routes.get("/prompt_composer/c3_status")
async def c3_status(request):
    """Layer C3 diagnostics: is the stash alive, and WHAT has it recorded?

    Open this in a plain browser tab after queueing the node and the
    answer bisects the whole chain: "recorded: 0" means the node's
    compose() never wrote a record (check the ComfyUI terminal for a
    PromptComposer C3 warning -- injection or execution issue, server
    side); a listing whose node_id does not match the composer's id
    shown in the UI means the CLIENT fetch is asking for the wrong key;
    a matching entry with no chip means the browser event never landed
    (and the frontend's /c3_status poller now covers exactly that case,
    adopting full text through this endpoint alone). Local ComfyUI only;
    returns each node's most recent output (bounded 10 records, 20k
    chars) for that reason.
    """
    from .. import prompt_composer_node

    with prompt_composer_node._LAST_OUTPUTS_LOCK:
        items = list(prompt_composer_node._LAST_OUTPUTS.items())
    return web.json_response({
        "ok": True,
        "recorded": len(items),
        "entries": [
            {
                "node_id": node_id,
                "prompt_id": val.get("prompt_id", ""),
                "at": val.get("at"),
                "seed": val.get("seed"),
                # Full text (bounded): lets the frontend's fallback
                # poller adopt executed outputs through THIS endpoint
                # alone -- no dependence on any WS event shape, which
                # the live smoke proved can vary by build.
                "prompt": (val.get("prompt") or "")[:20000],
                "chars": len(val.get("prompt") or ""),
                "text_head": (val.get("prompt") or "")[:80],
            }
            for node_id, val in items[-10:]
        ],
    })


# ---------------------------------------------------------------------------
# Preset routes (structure only -- see preset_store.py)
# ---------------------------------------------------------------------------

@routes.get("/prompt_composer/presets")
async def list_presets(request):
    return web.json_response(preset_store.list_presets())


@routes.get("/prompt_composer/presets/{filename}")
async def get_preset(request):
    filename = request.match_info.get("filename", "")
    try:
        preset = preset_store.get_preset(filename)
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
        import json
        raw = json.loads(body_bytes.decode("utf-8"))
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    try:
        filename = preset_store.save_preset(raw)
        return web.json_response({"ok": True, "filename": filename})
    except ValueError as exc:
        return _error(exc, status=400)


@routes.put("/prompt_composer/presets/{filename}/rename")
async def rename_preset(request):
    filename = request.match_info.get("filename", "")
    try:
        body = await request.json()
        new_name = body.get("name")
        new_filename = preset_store.rename_preset(filename, new_name)
        return web.json_response({"ok": True, "filename": new_filename})
    except FileNotFoundError:
        return web.Response(status=404, text="Not found")
    except ValueError as exc:
        return _error(exc, status=400)


@routes.delete("/prompt_composer/presets/{filename}")
async def delete_preset(request):
    filename = request.match_info.get("filename", "")
    deleted = preset_store.delete_preset(filename)
    return web.json_response({"ok": True, "deleted": deleted})
