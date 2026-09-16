"""
server package for Prompt Composer.

Modules:
    image_utils    - untrusted image decode/sanitize helpers
    library_store  - the library (on-disk prompt_data PNGs): scan,
                      resolve, create/update/delete, category tags.
                      Single source of truth for prompt_ref -> content.
    preset_store    - structure-only preset persistence (sections +
                      entries as pointers, no content).
    routes         - aiohttp route registration wiring the above into
                      the frontend's HTTP API.

Importing this package's `routes` submodule (done from the top-level
__init__.py) is what actually registers the routes with ComfyUI's
PromptServer; the other modules have no import-time side effects.
"""
