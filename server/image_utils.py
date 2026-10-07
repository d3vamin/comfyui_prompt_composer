"""
image_utils.py

Image decoding/sanitizing helpers. They are storage-model-agnostic:
whether the sanitized bytes end up embedded in a prompt_data PNG
(server/library_store.py) or served back to the frontend, the same
untrusted-input handling applies.

Security notes
---------------
Images can come from files a user downloaded from someone else, so we
treat all incoming image bytes as untrusted input:

- Every incoming image is decoded and RE-ENCODED with Pillow before
  anything touches disk. This strips any non-image payload that might
  be smuggled inside image bytes (e.g. appended data, malformed
  chunks, embedded scripts in SVG-like tricks) because only actual
  decoded pixel data survives the round-trip. SVG is intentionally
  not supported for this reason.
- The rebuilt image is a brand-new Pillow Image object constructed
  from decoded pixel data only, guaranteeing no ancillary chunks or
  metadata survive from the source file (any workflow/category
  metadata a prompt_data PNG carries is added back deliberately, by
  library_store.py, AFTER this sanitize step -- never trusted from the
  incoming file).
"""

import io
import logging

from PIL import Image, ImageOps

log = logging.getLogger("prompt_composer")

MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MB safety cap
ALLOWED_IMAGE_FORMATS = {"PNG", "JPEG", "WEBP"}

# Decompression-bomb ceiling. A 20 MB PNG can legally decode to tens of
# GIGApixels: the byte cap above says nothing about how much memory the
# DECODED image needs. 64 megapixels (~8000x8000) is far beyond anything
# that could sensibly be dropped in as a 256px thumbnail source, and it
# is checked against the header's declared size BEFORE any pixel data is
# read, so a bomb is refused rather than rasterized.
MAX_IMAGE_PIXELS = 64_000_000

# Pillow's own global guard, pinned rather than left at its default so
# the limit is explicit and identical on every install. Pillow warns past
# this value and raises Image.DecompressionBombError past 2x it; we do
# our own stricter check below and catch its error by name either way.
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


def sanitize_image_bytes(raw_bytes: bytes, square_size: int, min_dimension: int | None = None) -> bytes:
    """Decode arbitrary image bytes, re-encode clean, center-crop and
    resize to a square of `square_size`, and return PNG bytes with no
    metadata/ancillary chunks from the source file.

    `min_dimension`, if given, rejects (raises ValueError) any source
    image whose width OR height is smaller than that many pixels,
    BEFORE any cropping/resizing happens -- this is a floor below
    which an image is treated as too small to plausibly be a real
    thumbnail (e.g. accidental/garbage input) rather than something to
    silently upscale. When omitted (the default), no minimum is
    enforced and a smaller source is upscaled to `square_size` like
    any other size mismatch -- this keeps the default behavior used by
    live entry-image editing (paste/drop into an existing prompt's
    thumbnail slot) exactly as it was; only library PNG import applies
    a minimum today (see library_store.py's create/update paths).

    Raises ValueError if the bytes are not a decodable image, are
    unreasonably large, or (when `min_dimension` is given) too small.
    """
    if len(raw_bytes) > MAX_INPUT_IMAGE_BYTES:
        raise ValueError("Image too large")

    try:
        img = Image.open(io.BytesIO(raw_bytes))
        img.verify()  # sanity check container integrity
        # verify() invalidates the file pointer/object; reopen to actually use it
        img = Image.open(io.BytesIO(raw_bytes))
        # Image.open() only parses the HEADER, so img.size is known here
        # while no pixel data has been decoded yet -- this is the one
        # moment a decompression bomb can be refused for free.
        _reject_if_oversized(img.size)
        img.load()
    except Image.DecompressionBombError as exc:
        raise ValueError(f"Image is too large to decode safely: {exc}") from exc
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"Not a valid image: {exc}") from exc

    # Format allowlist is a soft guard (not enforced) -- we always
    # re-save as PNG below regardless of source format, so anything
    # Pillow can decode is acceptable input.
    _ = img.format in ALLOWED_IMAGE_FORMATS or img.format is None

    if min_dimension is not None:
        w0, h0 = img.size
        if w0 < min_dimension or h0 < min_dimension:
            raise ValueError(
                f"Image is {w0}x{h0}, smaller than the {min_dimension}x{min_dimension} minimum"
            )

    # Normalize orientation (EXIF), convert to RGB, strip all metadata
    # by rebuilding a fresh image from raw pixel data only.
    img = ImageOps.exif_transpose(img)
    img = img.convert("RGB")

    # Center-crop to square, then resize down to the target size.
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side))
    img = img.resize((square_size, square_size), Image.LANCZOS)

    # Rebuild a brand new image object from pixel data to guarantee no
    # ancillary chunks / metadata survive from the source file.
    clean = Image.new("RGB", img.size)
    clean.paste(img, (0, 0))

    out = io.BytesIO()
    clean.save(out, format="PNG", optimize=True)
    return out.getvalue()


def _reject_if_oversized(size) -> None:
    """Raise ValueError when a decoded image would exceed
    MAX_IMAGE_PIXELS. Called with the header-declared size, before any
    pixel data is read."""
    try:
        width, height = size
    except (TypeError, ValueError):
        return
    if width * height > MAX_IMAGE_PIXELS:
        raise ValueError(
            f"Image is {width}x{height} ({width * height:,} pixels), above the "
            f"{MAX_IMAGE_PIXELS:,}-pixel limit"
        )
