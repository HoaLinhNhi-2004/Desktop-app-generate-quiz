"""
PDF Service - Extract text from PDF files
"""

import os
import logging

logger = logging.getLogger(__name__)

OCR_RENDER_DPI = 200


def render_pdf_pages(pdf_path: str, out_dir: str, dpi: int = OCR_RENDER_DPI) -> list[str]:
    """Rasterise every page to a PNG in `out_dir`, returning the paths in order.

    Rendering goes through PyMuPDF rather than pdf2image. pdf2image shells out to
    poppler, a native toolchain that is not a Python package and so cannot travel
    inside the PyInstaller bundle: on a machine without it — which is every
    machine that installs the desktop app — scanned PDFs extracted to nothing,
    and material uploads failed outright with "Is poppler installed and in PATH?".
    PyMuPDF is already a dependency (heatmap bounding boxes) and needs nothing
    outside the wheel.
    """
    import fitz

    paths: list[str] = []
    with fitz.open(pdf_path) as doc:
        for index, page in enumerate(doc):
            image_path = os.path.join(out_dir, f"page_{index}.png")
            # Freed each iteration rather than held in a list: a 200-dpi A4 page
            # is ~11MB of pixels, and these PDFs run to hundreds of pages.
            pixmap = page.get_pixmap(dpi=dpi)
            pixmap.save(image_path)
            paths.append(image_path)
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
    """Per-page OCR extraction returning (annotated_text, total_pages)."""
    import tempfile
    from .ocr_service import extract_text_from_image

    parts: list[str] = []
    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            image_paths = render_pdf_pages(pdf_path, tmpdir)
            for i, img_path in enumerate(image_paths):
                text = extract_text_from_image(img_path, lang=lang)
                if text.strip():
                    parts.append(f"--- TRANG {i + 1} ---\n{text.strip()}")
            total = len(image_paths)
        except Exception as e:
            logger.error("_ocr_paged failed for %s: %s", os.path.basename(pdf_path), e)
            return ("", expected_pages)
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
    """Convert PDF pages to images and run OCR"""
    import tempfile
    from .ocr_service import extract_text_from_image

    all_texts = []
    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            for img_path in render_pdf_pages(pdf_path, tmpdir):
                text = extract_text_from_image(img_path, lang=lang)
                if text.strip():
                    all_texts.append(text)
        except Exception as e:
            logger.error(f"PDF to image OCR failed: {e}")

    return "\n\n".join(all_texts)
