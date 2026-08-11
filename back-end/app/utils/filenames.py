"""Filename helpers for uploads.

`werkzeug.utils.secure_filename` ASCII-folds its input, which is the wrong trade
for a Vietnamese-first app: "Đề thi Toán 12.pdf" comes back as "e_thi_Toan_12.pdf",
and a name with no ASCII at all ("试卷.pdf") collapses to "pdf" — losing the
extension, which then reads as an unsupported file type.

Two separate concerns, so two functions:
  - `display_name()`  — what the user sees; keeps every printable character.
  - `storage_name()`  — what lands on disk; keeps Unicode letters but drops
    anything a filesystem or a path parser could misread.
"""

import os
import re
import unicodedata

# Characters no mainstream filesystem accepts in a path segment. The C0 range is
# stripped separately because a raw control character in a name is either a bug
# or an attack, never a legitimate title.
_FORBIDDEN = r'<>:"/\\|?*'
_FORBIDDEN_RE = re.compile(f"[{re.escape(_FORBIDDEN)}]")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

# Windows refuses these as a *stem*, with or without an extension.
_RESERVED_STEMS = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

# NTFS caps a path segment at 255 UTF-16 units; leave room for the uuid prefix
# that upload routes prepend.
_MAX_STEM = 120


def split_extension(filename: str) -> tuple[str, str]:
    """Split into (stem, lowercase extension without dot) using the ORIGINAL name.

    Deriving the extension from a sanitized name is what made a CJK filename
    report `Unsupported file type: ` — sanitizing had already eaten the dot.
    """
    base = os.path.basename(filename or "").strip()
    if "." not in base:
        return base, ""
    stem, _, ext = base.rpartition(".")
    return stem, ext.lower()


def display_name(filename: str) -> str:
    """The name shown in material lists. Preserves Unicode; drops only path parts."""
    base = os.path.basename((filename or "").replace("\\", "/")).strip()
    base = _CONTROL_RE.sub("", base)
    return base or "untitled"


def storage_name(filename: str) -> str:
    """A filesystem-safe name that still reads as the original to a human.

    Keeps Vietnamese and CJK characters. Replaces separators and reserved
    punctuation with underscores, collapses whitespace, and always preserves the
    extension taken from the original name.
    """
    stem, ext = split_extension(display_name(filename))

    # NFC first: macOS hands over decomposed forms, so "ề" would otherwise be a
    # base letter plus a combining mark and compare unequal to the same name typed
    # on Windows.
    stem = unicodedata.normalize("NFC", stem)
    stem = _CONTROL_RE.sub("", stem)
    stem = _FORBIDDEN_RE.sub("_", stem)
    stem = re.sub(r"\s+", " ", stem).strip(" .")

    if not stem:
        stem = "file"
    if stem.upper() in _RESERVED_STEMS:
        stem = f"_{stem}"
    if len(stem) > _MAX_STEM:
        stem = stem[:_MAX_STEM].rstrip(" .") or "file"

    ext = _FORBIDDEN_RE.sub("", _CONTROL_RE.sub("", ext)).strip(" .")
    return f"{stem}.{ext}" if ext else stem
