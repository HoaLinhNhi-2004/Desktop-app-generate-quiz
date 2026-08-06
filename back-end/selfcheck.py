"""
Bundle self-check — proves a packaged backend can reach every module it needs.

Most third-party packages here are imported *inside* functions (lazily, to keep
startup fast), which PyInstaller's static analysis cannot see. A build missing
one of them starts up perfectly and only fails when a user touches the feature —
and one that misses a package imported at module scope does not start at all.
Releases v1.5.0 through v1.7.0 shipped without `tzdata` and the backend died on
every machine before it bound a port.

So the build scripts and CI run `WebQuizBackend --selfcheck`: it imports the lot
inside the frozen executable and exits non-zero on the first miss.
"""
from __future__ import annotations

import importlib
import sys

# (module, what breaks without it). Keep in step with the --hidden-import list in
# build_backend.ps1 / build_backend.sh.
REQUIRED_MODULES: list[tuple[str, str]] = [
    ("flask", "the whole app"),
    ("flask_cors", "browser requests from the Electron renderer"),
    ("flask_sqlalchemy", "every DB model"),
    ("dotenv", "config loading"),
    ("cryptography", "API key encryption at rest"),
    ("chromadb", "RAG vector store"),
    ("chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2", "the default embedder"),
    # chromadb pulls these three through importlib.import_module, which no static
    # analysis can see, and only when it first embeds a chunk — so a bundle
    # without them boots perfectly and fails every single material upload.
    ("onnxruntime", "running the embedding model"),
    ("tokenizers", "tokenising chunks before embedding"),
    ("tqdm", "downloading the embedding model on first use"),
    ("pdfplumber", "PDF text extraction"),
    ("fitz", "PDF heatmap bounding boxes and scanned-PDF page rendering"),
    ("PIL", "image handling"),
    ("numpy", "image handling"),
    ("docx", "DOCX material import"),
    ("pptx", "PPTX detection in smart folder import"),
    ("pandas", "spreadsheet material import"),
    ("openpyxl", "reading .xlsx"),
    ("xlrd", "reading legacy .xls"),
    ("google.generativeai", "Gemini generation"),
    ("google.genai", "Gemini key verification + model listing"),
    ("anthropic", "Claude provider"),
    ("openai", "OpenAI, DeepSeek, Groq, xAI, Mistral and OpenRouter providers"),
    ("youtube_transcript_api", "YouTube transcripts"),
    ("yt_dlp", "YouTube transcript fallback"),
    ("requests", "Notion / Google Drive / web page fetching"),
]


def _check_timezone_database() -> str | None:
    """zoneinfo resolves against a tz database Windows does not ship, so `tzdata`
    being importable proves nothing — the lookup itself has to work."""
    from zoneinfo import ZoneInfo

    ZoneInfo("America/Los_Angeles")
    return None


def _check_pdf_rendering() -> str | None:
    """Rasterise a page, the operation scanned-PDF OCR is built on.

    This used to run through pdf2image + poppler, a native toolchain that cannot
    live inside the bundle, so every installed copy silently extracted nothing
    from a scanned PDF. Rendering is PyMuPDF's job now, and this proves it works
    in the frozen executable rather than only in a developer's environment.
    """
    import fitz

    with fitz.open() as doc:
        page = doc.new_page(width=200, height=200)
        page.insert_text((20, 100), "selfcheck")
        png = page.get_pixmap(dpi=72).tobytes("png")
    if len(png) < 100:
        return "rendered an empty image"
    return None


# (label, what breaks, callable) — capabilities that an import alone cannot prove.
CAPABILITY_CHECKS = [
    ("tzdata", "the Gemini daily-quota reset (and used to kill startup)", _check_timezone_database),
    ("PDF page rendering", "scanned-PDF OCR — it would extract nothing", _check_pdf_rendering),
]


def run() -> int:
    """Import every required module and report what is missing. 0 == healthy."""
    failures: list[str] = []

    for name, purpose in REQUIRED_MODULES:
        try:
            importlib.import_module(name)
        except Exception as exc:
            failures.append(f"  {name} — breaks {purpose}\n      {type(exc).__name__}: {exc}")

    for label, purpose, check in CAPABILITY_CHECKS:
        try:
            problem = check()
        except Exception as exc:
            problem = f"{type(exc).__name__}: {exc}"
        if problem:
            failures.append(f"  {label} — breaks {purpose}\n      {problem}")

    if failures:
        print(f"SELFCHECK FAILED — {len(failures)} check(s) failed for this build:")
        print("\n".join(failures))
        return 1

    print(f"SELFCHECK OK — {len(REQUIRED_MODULES) + len(CAPABILITY_CHECKS)} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
