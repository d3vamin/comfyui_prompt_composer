"""
ComfyUI Prompt Composer
-----------------------------
A custom ComfyUI node for building, organizing, and randomizing prompts
from a disk-backed library of reusable prompt entries (PNG files with
an attached workflow, in the same way ComfyUI saves generated images),
presets, and queue-time randomization.

This file registers the node with ComfyUI and mounts the extra server
routes used by the in-node UI (library CRUD, resolve, preset CRUD).

Storage note: prompt content lives entirely as PNG files in the
user data folder (ComfyUI/user/prompt_composer/library), each
independently drag-and-droppable back into ComfyUI.
"""

from .prompt_composer_node import PromptComposerNode

# MAJOR.MINOR.PATCH -- the only home for the product version; the node
# name is plain "Prompt Composer" and never carries it.
__version__ = "1.0.261007"

NODE_CLASS_MAPPINGS = {
    "PromptComposer": PromptComposerNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptComposer": "Prompt Composer",
}

# Register the aiohttp routes used by the frontend (library, resolve,
# presets). Importing server.routes is what actually attaches the
# routes to ComfyUI's PromptServer instance.
from .server import routes  # noqa: E402,F401

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
