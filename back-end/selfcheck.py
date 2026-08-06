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
    ("fitz", "PDF heatmap bounding boxes"),
    ("pdf2image", "scanned-PDF vision OCR"),
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


def run() -> int:
    """Import every required module and report what is missing. 0 == healthy."""
    failures: list[str] = []

    for name, purpose in REQUIRED_MODULES:
        try:
            importlib.import_module(name)
        except Exception as exc:
            failures.append(f"  {name} — breaks {purpose}\n      {type(exc).__name__}: {exc}")

    # Not an import: zoneinfo resolves against a tz database that Windows does
    # not ship, so the package being importable proves nothing on its own.
    try:
        from zoneinfo import ZoneInfo

        ZoneInfo("America/Los_Angeles")
    except Exception as exc:
        failures.append(
            "  tzdata — breaks Gemini daily-quota reset (and used to kill startup)\n"
            f"      {type(exc).__name__}: {exc}"
        )

    if failures:
        print(f"SELFCHECK FAILED — {len(failures)} module(s) missing from this build:")
        print("\n".join(failures))
        return 1

    print(f"SELFCHECK OK — {len(REQUIRED_MODULES) + 1} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
