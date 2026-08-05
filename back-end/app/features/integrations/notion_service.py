"""
Notion Service - Search the connected workspace and flatten pages to text.

Access is scoped by Notion itself: the consent screen is the page picker, so
only pages the user explicitly shared are visible to /v1/search at all.
"""
import logging
import re
from typing import Optional

import requests

from app.features.integrations import oauth

logger = logging.getLogger(__name__)

API_BASE = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"
HTTP_TIMEOUT = 20

# Guards against a page graph that is deep, wide, or cyclic via synced blocks.
MAX_DEPTH = 4
MAX_BLOCKS = 4000

_UUID_RE = re.compile(r"([0-9a-fA-F]{32})|([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})")

# Block types rendered as a prefixed line; everything else falls back to bare text.
_PREFIXES = {
    "heading_1": "# ",
    "heading_2": "## ",
    "heading_3": "### ",
    "bulleted_list_item": "- ",
    "numbered_list_item": "- ",
    "to_do": "- ",
    "quote": "> ",
    "callout": "> ",
}


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {oauth.get_valid_access_token('notion')}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


def _request(method: str, path: str, **kwargs) -> dict:
    response = requests.request(
        method, f"{API_BASE}{path}", headers=_headers(), timeout=HTTP_TIMEOUT, **kwargs
    )
    if not response.ok:
        logger.error("Notion %s %s -> %s: %s", method, path, response.status_code, response.text[:400])
        if response.status_code in (401, 403):
            raise ValueError("Notion từ chối truy cập. Hãy kết nối lại hoặc chia sẻ trang với integration.")
        raise ValueError(f"Notion trả về lỗi HTTP {response.status_code}")
    return response.json()


def extract_page_id(url_or_id: str) -> Optional[str]:
    """Pull the page UUID out of a Notion URL (or accept a bare id)."""
    matches = _UUID_RE.findall(url_or_id or "")
    if not matches:
        return None
    raw = next((m[0] or m[1] for m in reversed(matches) if m[0] or m[1]), "")
    compact = raw.replace("-", "").lower()
    if len(compact) != 32:
        return None
    return f"{compact[:8]}-{compact[8:12]}-{compact[12:16]}-{compact[16:20]}-{compact[20:]}"


def _plain_text(rich_text: list) -> str:
    return "".join(part.get("plain_text", "") for part in rich_text or [])


def _object_title(obj: dict) -> str:
    """Title of a page or database object returned by /search."""
    if obj.get("object") == "database":
        return _plain_text(obj.get("title") or []) or "Untitled"
    for prop in (obj.get("properties") or {}).values():
        if prop.get("type") == "title":
            return _plain_text(prop.get("title") or []) or "Untitled"
    return "Untitled"


def search_pages(query: str = "", page_size: int = 20) -> list[dict]:
    """Pages shared with the integration, most recently edited first."""
    payload: dict = {
        "page_size": max(1, min(page_size, 100)),
        "filter": {"value": "page", "property": "object"},
        "sort": {"direction": "descending", "timestamp": "last_edited_time"},
    }
    if query.strip():
        payload["query"] = query.strip()

    data = _request("POST", "/search", json=payload)
    return [
        {
            "id": item.get("id", ""),
            "title": _object_title(item),
            "url": item.get("url", ""),
            "lastEditedTime": item.get("last_edited_time"),
        }
        for item in data.get("results", [])
    ]


def fetch_page_title(page_id: str) -> Optional[str]:
    """Best-effort title; returns None instead of raising (mirrors fetch_video_title)."""
    try:
        return _object_title(_request("GET", f"/pages/{page_id}"))
    except Exception as e:
        logger.warning("Failed to fetch Notion page title for %s: %s", page_id, e)
        return None


def _block_lines(block: dict) -> list[str]:
    block_type = block.get("type", "")
    body = block.get(block_type) or {}

    if block_type == "table_row":
        cells = body.get("cells") or []
        row = " | ".join(_plain_text(cell) for cell in cells).strip(" |")
        return [row] if row else []

    if block_type == "child_page":
        title = (body.get("title") or "").strip()
        return [f"## {title}"] if title else []

    text = _plain_text(body.get("rich_text") or [])
    if not text.strip():
        return []
    return [f"{_PREFIXES.get(block_type, '')}{text}"]


def _walk(block_id: str, depth: int, budget: list[int]) -> list[str]:
    lines: list[str] = []
    cursor: Optional[str] = None

    while budget[0] > 0:
        params = {"page_size": 100}
        if cursor:
            params["start_cursor"] = cursor
        data = _request("GET", f"/blocks/{block_id}/children", params=params)

        for block in data.get("results", []):
            budget[0] -= 1
            if budget[0] <= 0:
                break
            lines.extend(_block_lines(block))
            # child_page / child_database are separate documents — don't inline them.
            if (
                block.get("has_children")
                and depth < MAX_DEPTH
                and block.get("type") not in ("child_page", "child_database")
            ):
                lines.extend(_walk(block["id"], depth + 1, budget))

        if not data.get("has_more"):
            break
        cursor = data.get("next_cursor")

    return lines


def extract_page_text(page_id: str) -> str:
    """Flatten a Notion page (and its nested blocks) into Markdown-ish text."""
    budget = [MAX_BLOCKS]
    lines = _walk(page_id, depth=0, budget=budget)
    text = "\n".join(line for line in lines if line.strip())

    if not text.strip():
        raise ValueError(
            f"Trang Notion {page_id} không có nội dung văn bản nào để trích xuất."
        )

    if budget[0] <= 0:
        logger.warning("Notion page %s hit the %d-block cap", page_id, MAX_BLOCKS)

    logger.info("Extracted %d chars from Notion page %s", len(text), page_id)
    return text
