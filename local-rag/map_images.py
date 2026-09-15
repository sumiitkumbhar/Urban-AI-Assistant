"""Renders map-graphic PDFs (see common.py's MAP_GRAPHIC_FILENAMES) to
PNG images so the visual citations site_context.py already computes
(_find_map_citations()) can actually be looked at, not just named by
filename. These PDFs carry no real prose (see common.py's docstring for
why they're excluded from the text index) - the whole page IS the map,
so a full-page render already is "just the map graphic" with no
surrounding prose to crop away; the only post-processing here trims the
uniform blank margins these PDFs are laid out with, so the delivered
image isn't mostly white border around a small map in the middle.

Rendered images are cached to disk under data/map_images/ (gitignored,
same as the rest of data/), keyed off the source PDF's filename and
mtime - a request for a map that's already been rendered is an instant
file read, not a re-render. PyMuPDF's page.get_pixmap() is fast (well
under a second per page even at this DPI), but there's no reason to
redo it on every single query that happens to match the same
conservation area.

Both PyMuPDF (`pip install pymupdf`, imported as `fitz`) and Pillow are
new dependencies for this folder - added to requirements.txt alongside
this file. Import failures here are swallowed and treated as "no image
available" (returns None), not raised, so a missing/uninstalled
renderer degrades to the pre-existing filename-only citation rather
than breaking the answer it's attached to.
"""

import hashlib
from pathlib import Path

from common import CORPUS_DIR, DATA_DIR

MAP_IMAGES_DIR = DATA_DIR / "map_images"

# ~2.8x a PDF's native 72dpi - legible street labels and area boundaries
# without producing a huge file; these are vector-graphic pages, not
# scanned raster, so there's no upper limit imposed by source quality.
RENDER_DPI = 200


def _cache_key(pdf_path):
    """Filename + mtime, hashed short - changes if the source PDF is
    ever replaced (a corpus refresh, a corrected map), so a stale
    cached render never silently lingers under the old key."""
    stat = pdf_path.stat()
    raw = f"{pdf_path.name}:{stat.st_mtime_ns}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _trim_blank_margins(img):
    """Auto-crops uniform-color borders using the top-left corner pixel
    as the background color to diff against. Falls back to the
    untrimmed image if the diff bbox is missing or implausibly small
    (e.g. a blank page, or a page that isn't actually margin-bordered) -
    better to ship an untrimmed map than risk cropping real content
    away on a page shape this wasn't tested against."""
    from PIL import Image, ImageChops

    background = Image.new(img.mode, img.size, img.getpixel((0, 0)))
    diff = ImageChops.difference(img, background)
    bbox = diff.getbbox()
    if not bbox:
        return img

    pad = 12  # don't shave crop lines right up against map ink
    left, upper, right, lower = bbox
    left = max(0, left - pad)
    upper = max(0, upper - pad)
    right = min(img.width, right + pad)
    lower = min(img.height, lower + pad)
    if right - left < 50 or lower - upper < 50:
        return img
    return img.crop((left, upper, right, lower))


def render_map_image(pdf_filename, page_number=1):
    """Renders one page of a map-graphic PDF (data/map_documents.json's
    `filename`, relative to CORPUS_DIR) to a trimmed PNG, caching the
    result under MAP_IMAGES_DIR. Returns the cached Path, or None if the
    source PDF is missing, or PyMuPDF/Pillow aren't installed, or
    rendering fails for any reason - callers treat None as "no image
    available" and fall back to the filename-only citation rather than
    letting a rendering problem break the text answer it's attached to.
    """
    pdf_path = CORPUS_DIR / pdf_filename
    if not pdf_path.exists():
        return None

    MAP_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = MAP_IMAGES_DIR / f"{_cache_key(pdf_path)}_p{page_number}.png"
    if cache_path.exists():
        return cache_path

    try:
        import fitz  # PyMuPDF
        from PIL import Image
    except Exception:
        return None

    try:
        doc = fitz.open(str(pdf_path))
        try:
            if not (1 <= page_number <= len(doc)):
                page_number = 1
            page = doc[page_number - 1]
            zoom = RENDER_DPI / 72
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            img = _trim_blank_margins(img)
            img.save(cache_path, "PNG", optimize=True)
        finally:
            doc.close()
    except Exception:
        return None

    return cache_path
