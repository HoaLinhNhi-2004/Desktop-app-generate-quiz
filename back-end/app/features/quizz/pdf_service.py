"""
PDF Service - Extract text from PDF files
"""

import os
import re
import logging

logger = logging.getLogger(__name__)

_PAGE_MARKER_RE = re.compile(r"^--- TRANG \d+ ---\n?", re.MULTILINE)

OCR_RENDER_DPI = 200

# Below this the vision models start dropping Vietnamese diacritics.
OCR_MIN_DPI = 120

# Long documents drop to OCR_MIN_DPI: a 200-dpi A4 page is ~11 MB of pixels, and
# the quality gain above 120 dpi is small next to the time it costs on 300 pages.
OCR_HIGH_DPI_PAGE_LIMIT = 40

# Each page is one vision call against the shared key pool. Past this the run
# stops being "slow" and starts being an outage for every other feature.
MAX_OCR_PAGES = 100


def ocr_dpi_for(page_count: int) -> int:
    return OCR_RENDER_DPI if page_count <= OCR_HIGH_DPI_PAGE_LIMIT else OCR_MIN_DPI


def render_pdf_page(doc, index: int, out_dir: str, dpi: int = OCR_RENDER_DPI) -> str:
    """Rasterise one page to a PNG in `out_dir` and return its path.

    Rendering goes through PyMuPDF rather than pdf2image. pdf2image shells out to
    poppler, a native toolchain that is not a Python package and so cannot travel
    inside the PyInstaller bundle: on a machine without it — which is every
    machine that installs the desktop app — scanned PDFs extracted to nothing,
    and material uploads failed outright with "Is poppler installed and in PATH?".
    PyMuPDF is already a dependency (heatmap bounding boxes) and needs nothing
    outside the wheel.

    One page at a time on purpose. Rasterising the whole document up front put
    every PNG on disk before a single page was OCR'd, so a 500-page scan filled
    %TEMP% with gigabytes and died with "No space left on device" before
    producing any text at all.
    """
    image_path = os.path.join(out_dir, f"page_{index}.png")
    pixmap = doc[index].get_pixmap(dpi=dpi)
    pixmap.save(image_path)
    return image_path


def render_pdf_pages(pdf_path: str, out_dir: str, dpi: int = OCR_RENDER_DPI) -> list[str]:
    """Rasterise every page to a PNG in `out_dir`, returning the paths in order.

    Retained for callers that genuinely need every page on disk at once. Prefer
    `render_pdf_page` in a loop — see the note there about disk usage.
    """
    import fitz

    paths: list[str] = []
    with fitz.open(pdf_path) as doc:
        for index in range(doc.page_count):
            paths.append(render_pdf_page(doc, index, out_dir, dpi))
    return paths


def extract_text_from_pdf(pdf_path: str) -> str:
    """
    Extract text from a PDF file using pdfplumber.
    Falls back to OCR if text extraction yields no results.

    Args:
        pdf_path: Path to the PDF file
    
    Returns:
        Extracted text as a single string
    """
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")

    import pdfplumber

    all_text = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for i, page in enumerate(pdf.pages):
                text = page.extract_text()
                if text and text.strip():
                    all_text.append(text.strip())
                    logger.debug(f"Page {i+1}: extracted {len(text)} chars")
    except Exception as e:
        logger.error(f"Error reading PDF {pdf_path}: {e}")
        raise

    combined = "\n\n".join(all_text)
    logger.info(f"Extracted {len(all_text)} pages of text from {os.path.basename(pdf_path)}")
    return combined


def extract_text_from_pdf_with_ocr(
    pdf_path: str, lang: str = "vi"
) -> str:
    """
    Extract text from PDF. If text extraction gives poor results,
    convert pages to images and use OCR.

    Args:
        pdf_path: Path to PDF file
        lang: OCR language
    
    Returns:
        Extracted text
    """
    # First try direct text extraction
    text = extract_text_from_pdf(pdf_path)
    
    # If we got decent text, return it
    if len(text.strip()) > 50:
        return text

    # Otherwise, convert to images and OCR
    logger.info("PDF text extraction yielded little text, falling back to OCR")
    return _pdf_to_images_ocr(pdf_path, lang=lang)


def extract_text_from_pdf_paged(pdf_path: str, lang: str = "vi") -> tuple[str, int]:
    """
    Extract PDF text with --- TRANG N --- page markers embedded.
    Returns (annotated_text, total_pages).
    Uses pdfplumber; falls back to per-page OCR for scanned/image PDFs.
    """
    if not os.path.exists(pdf_path):
        return ("", 0)
    try:
        import pdfplumber
        paged: list[tuple[int, str]] = []
        with pdfplumber.open(pdf_path) as pdf:
            for i, page in enumerate(pdf.pages):
                text = page.extract_text() or ""
                paged.append((i + 1, text.strip()))
        total_pages = len(paged)
        if total_pages == 0:
            return ("", 0)
        total_chars = sum(len(t) for _, t in paged)
        if total_chars < 50:
            # Scanned PDF — fall back to per-page OCR
            return _ocr_paged(pdf_path, lang=lang, expected_pages=total_pages)
        parts = [f"--- TRANG {n} ---\n{t}" for n, t in paged if t]
        return ("\n\n".join(parts), total_pages)
    except Exception as e:
        logger.warning("extract_text_from_pdf_paged failed for %s: %s", os.path.basename(pdf_path), e)
        return ("", 0)


def _ocr_paged(pdf_path: str, lang: str = "vi", expected_pages: int = 0) -> tuple[str, int]:
    """Per-page OCR extraction returning (annotated_text, total_pages).

    Failure keeps what has already been read. The previous version wrapped the
    whole loop in one `try` and returned `("", expected_pages)` from the handler,
    so running out of quota on page 56 of 60 threw away the 55 pages that had
    just cost ten minutes of vision calls.
    """
    import tempfile
    import fitz
    from .ocr_service import extract_text_from_image

    parts: list[str] = []
    total = expected_pages

    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        logger.error("Could not open %s for OCR: %s", os.path.basename(pdf_path), e)
        return ("", expected_pages)

    with doc:
        total = doc.page_count
        limit = min(total, MAX_OCR_PAGES)
        dpi = ocr_dpi_for(total)
        if limit < total:
            logger.warning(
                "%s has %d pages; OCR limited to the first %d",
                os.path.basename(pdf_path), total, limit,
            )

        with tempfile.TemporaryDirectory() as tmpdir:
            for index in range(limit):
                image_path = ""
                try:
                    image_path = render_pdf_page(doc, index, tmpdir, dpi)
                    text = extract_text_from_image(image_path, lang=lang)
                except Exception as e:
                    logger.error(
                        "OCR stopped at page %d/%d of %s (%s) — keeping %d page(s)",
                        index + 1, limit, os.path.basename(pdf_path), e, len(parts),
                    )
                    break
                finally:
                    # One page of pixels on disk at a time, not the whole book.
                    if image_path and os.path.isfile(image_path):
                        try:
                            os.remove(image_path)
                        except OSError:
                            pass

                if text.strip():
                    parts.append(f"--- TRANG {index + 1} ---\n{text.strip()}")

    return ("\n\n".join(parts), total)


def get_pdf_page_stats(pdf_path: str) -> list[dict]:
    """
    Return per-page character counts from a PDF (pdfplumber, no OCR).
    Used to build a question-distribution heatmap on the frontend.

    Returns: [{"page": 1, "char_count": 450}, ...], 1-indexed.
    Returns [] if the file cannot be read.
    """
    if not os.path.exists(pdf_path):
        return []
    try:
        import pdfplumber
        result = []
        with pdfplumber.open(pdf_path) as pdf:
            for i, page in enumerate(pdf.pages):
                text = page.extract_text() or ""
                result.append({"page": i + 1, "char_count": len(text.strip())})
        return result
    except Exception as e:
        logger.warning("Could not get PDF page stats for %s: %s", os.path.basename(pdf_path), e)
        return []


def _pdf_to_images_ocr(pdf_path: str, lang: str = "vi") -> str:
    """Convert PDF pages to images and run OCR, dropping the page markers."""
    text, _ = _ocr_paged(pdf_path, lang=lang)
    return _PAGE_MARKER_RE.sub("", text).strip()
