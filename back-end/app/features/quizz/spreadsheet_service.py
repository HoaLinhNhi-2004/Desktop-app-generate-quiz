import logging

import pandas as pd

logger = logging.getLogger(__name__)

# Guard against a sheet with a million blank-but-formatted rows, which openpyxl
# happily materialises.
MAX_ROWS_PER_SHEET = 5_000


def _frame_to_text(df: pd.DataFrame) -> str:
    """Render one sheet as CSV, dropping padding rows and columns."""
    df = df.dropna(axis=0, how="all").dropna(axis=1, how="all")
    if df.empty:
        return ""
    if len(df) > MAX_ROWS_PER_SHEET:
        logger.warning(
            "Sheet has %d rows; keeping the first %d", len(df), MAX_ROWS_PER_SHEET,
        )
        df = df.head(MAX_ROWS_PER_SHEET)
    return df.to_csv(index=False)


def extract_text_from_spreadsheet(file_path: str, ext: str) -> str:
    """
    Read a CSV or Excel file and return its content as CSV text so the LLM/RAG
    can see the tabular structure.

    Every sheet is read, not just the first. Question banks are routinely split
    one sheet per chapter, and `pd.read_excel(path)` returns only the first sheet
    — so a 12-chapter bank silently contributed one chapter and the rest of the
    workbook was never seen.

    `header=None` keeps row 1 as data. Inferring a header turned a title sitting
    in A1 into a column name and dropped it from the text entirely, which for a
    question bank is the question itself.
    """
    try:
        if ext == "csv":
            frames = {"": pd.read_csv(file_path, header=None, dtype=str)}
        else:
            frames = pd.read_excel(file_path, sheet_name=None, header=None, dtype=str)
    except Exception as e:
        logger.error("Error reading spreadsheet %s: %s", file_path, e)
        raise ValueError(f"Không thể đọc file {ext}. Xin đảm bảo định dạng file hợp lệ.")

    parts: list[str] = []
    for sheet_name, df in frames.items():
        body = _frame_to_text(df)
        if not body.strip():
            continue
        parts.append(f"--- SHEET {sheet_name} ---\n{body}" if sheet_name else body)

    if not parts:
        logger.warning("Spreadsheet %s contained no data rows", file_path)
        return ""

    logger.info("Extracted %d sheet(s) from %s", len(parts), file_path)
    return "\n\n".join(parts)
