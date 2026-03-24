import pandas as pd
import logging

logger = logging.getLogger(__name__)

def extract_text_from_spreadsheet(file_path: str, ext: str) -> str:
    """
    Reads a CSV or Excel file and returns its content as a CSV string
    so that the LLM/RAG can understand the tabular structure.
    """
    try:
        if ext == "csv":
            df = pd.read_csv(file_path)
        else:
            df = pd.read_excel(file_path)
            
        # Convert to CSV formatted string. It preserves headers and tabular format well.
        return df.to_csv(index=False)
    except Exception as e:
        logger.error(f"Error reading spreadsheet {file_path}: {e}")
        raise ValueError(f"Không thể đọc file {ext}. Xin đảm bảo định dạng file hợp lệ.")
