/**
 * File types the backend accepts, mirrored for the browser file picker.
 *
 * Kept in one place because three components declared the same `accept` string
 * independently and had already drifted from the backend: the picker offered
 * `.doc` and `.xlsx` but not `.pptx`, `.txt` or `.tiff`, so a user could not
 * choose a slide deck the server was perfectly able to read.
 *
 * Source of truth is `back-end/file_types.py` — keep the two in step.
 */

export const DOCUMENT_EXTENSIONS = [
  "pdf",
  "docx",
  "doc",
  "pptx",
  "txt",
] as const;

export const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "tiff",
] as const;

export const SPREADSHEET_EXTENSIONS = ["xlsx", "xls", "csv"] as const;

export const SUPPORTED_EXTENSIONS: readonly string[] = [
  ...DOCUMENT_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...SPREADSHEET_EXTENSIONS,
];

/** Value for an `<input type="file">` accept attribute. */
export const FILE_ACCEPT_ATTRIBUTE = SUPPORTED_EXTENSIONS.map(
  (ext) => `.${ext}`,
).join(",");

/** Mirrors Flask's MAX_CONTENT_LENGTH (config.py). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / (1024 * 1024);

export function isSupportedFile(name: string): boolean {
  const ext = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return SUPPORTED_EXTENSIONS.includes(ext);
}
