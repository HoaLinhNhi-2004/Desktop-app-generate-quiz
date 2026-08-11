"""The single list of file extensions this app accepts, and what reads each one.

Five independent whitelists used to disagree, so what a file did depended on which
door it came through:
  - `.doc` was accepted everywhere and readable nowhere.
  - `.xlsx/.xls/.csv` were accepted by the upload route but rejected by Generate.
  - `.tiff` was accepted only by Generate.
  - `.pptx/.txt` were accepted only by Smart Import, whose extractor had no branch
    for either, so every slide deck imported and then failed processing.

Top-level module rather than `app/utils/` on purpose: `config.py` needs it, and
importing anything under `app.` from `config` would run `app/__init__.py`, which
imports `config` right back.
"""

# Rasterised or vector documents that go through a text extractor.
DOCUMENT_EXTENSIONS = frozenset({"pdf", "docx", "doc", "pptx", "txt"})

# Images — read by provider vision OCR.
IMAGE_EXTENSIONS = frozenset({"png", "jpg", "jpeg", "webp", "bmp", "tiff"})

# Tabular sources, including exported question banks.
SPREADSHEET_EXTENSIONS = frozenset({"xlsx", "xls", "csv"})

SUPPORTED_EXTENSIONS = DOCUMENT_EXTENSIONS | IMAGE_EXTENSIONS | SPREADSHEET_EXTENSIONS

# Smart Import walks a directory the user picked, so it deliberately leaves images
# out: pointing it at a folder that happens to contain photos would spend vision
# OCR quota on holiday snaps before anything could be classified.
SMART_IMPORT_EXTENSIONS = DOCUMENT_EXTENSIONS | SPREADSHEET_EXTENSIONS

# Comma-separated `accept` attribute for the browser file picker.
ACCEPT_ATTRIBUTE = ",".join(sorted(f".{e}" for e in SUPPORTED_EXTENSIONS))
