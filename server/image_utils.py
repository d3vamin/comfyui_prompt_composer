"""
image_utils.py

Image decoding/sanitizing helpers, lifted (logic unchanged) from the
earlier server_routes.py implementation. This is storage-model-agnostic:
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

from PIL import Image, ImageOps

MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MB safety cap
ALLOWED_IMAGE_FORMATS = {"PNG", "JPEG", "WEBP"}


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
        img.load()
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
