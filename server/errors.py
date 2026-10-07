"""
errors.py

The few exception types that carry meaning across the module boundary.

The stores raise ValueError for everything a caller did wrong, which is
right -- but routes.py has to answer with an HTTP status, and "this
prompt already exists" (409 Conflict) and "prompt text is required"
(400 Bad Request) are not the same answer. AlreadyExistsError subclasses
ValueError, so every existing `except ValueError` keeps catching it and
nothing downstream needs to know the type exists.
"""


class AlreadyExistsError(ValueError):
    """A prompt with this exact name + text is already in the library."""
