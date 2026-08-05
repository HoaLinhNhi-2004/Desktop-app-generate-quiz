"""
Web Service - Fetch a public web page and extract its readable text.

Stdlib only (urllib + html.parser). A readability library such as trafilatura
would extract cleaner article bodies, but it drags in lxml, which costs size and
hidden-import fixups in the PyInstaller desktop bundle — and the chunks pass
through filter_boilerplate()/clean_text() afterwards anyway.

Every request is checked against _assert_public_url() before it is sent, on each
redirect hop too: the backend listens on localhost and sits next to the user's
SQLite/ChromaDB, so an unchecked user-supplied URL is an SSRF hole.
"""

import gzip
import ipaddress
import logging
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Optional

logger = logging.getLogger(__name__)

MAX_RESPONSE_BYTES = 5 * 1024 * 1024
MAX_REDIRECTS = 5
REQUEST_TIMEOUT = 15

_USER_AGENT = "Mozilla/5.0 (compatible; QuizGenerator/1.0)"
_ACCEPTED_CONTENT_TYPES = {"text/html", "application/xhtml+xml", "text/plain"}

# Dropped wholesale — navigation and scripting carry no quiz-worthy content.
_SKIP_TAGS = {
    "script", "style", "noscript", "template", "svg", "canvas",
    "nav", "header", "footer", "aside", "form", "iframe", "button", "select",
}

# Force a line break so paragraphs don't run together into one blob.
_BLOCK_TAGS = {
    "p", "div", "section", "article", "main", "br", "hr", "li", "tr", "td", "th",
    "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "figcaption",
}


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Redirects are followed manually so each hop can be re-validated."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _PageParser(HTMLParser):
    """Collects <title> and the visible body text in a single pass."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self._in_title = False
        self._title_parts: list[str] = []
        self._body_parts: list[str] = []

    @property
    def title(self) -> Optional[str]:
        title = "".join(self._title_parts).strip()
        return title or None

    @property
    def text(self) -> str:
        return _collapse_whitespace("".join(self._body_parts))

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
        elif tag == "title":
            self._in_title = True
        elif tag in _BLOCK_TAGS:
            self._body_parts.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag == "title":
            self._in_title = False
        elif tag in _BLOCK_TAGS:
            self._body_parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self._title_parts.append(data)
        elif self._skip_depth == 0:
            self._body_parts.append(data)


def _collapse_whitespace(text: str) -> str:
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    lines = [line.strip() for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _normalize_url(url: str) -> str:
    """
    Turn an IRI into a URI: urllib speaks ASCII only, so a pasted link such as
    https://vi.wikipedia.org/wiki/Ngôn_ngữ raises UnicodeEncodeError otherwise.
    `%` stays in the safe set so an already-encoded link is not double-encoded.
    """
    parts = urllib.parse.urlsplit(url.strip())

    netloc = parts.netloc
    if "@" in netloc:
        raise ValueError("Đường dẫn chứa thông tin đăng nhập không được chấp nhận.")
    host, _, port = netloc.partition(":")
    try:
        host = host.encode("idna").decode("ascii")
    except (UnicodeError, ValueError):
        pass  # Leave it as-is; _assert_public_url resolves it and will fail there.
    netloc = f"{host}:{port}" if port else host

    return urllib.parse.urlunsplit((
        parts.scheme,
        netloc,
        urllib.parse.quote(parts.path, safe="/%:@&=+$,~"),
        urllib.parse.quote(parts.query, safe="/%:@&=+$,;?~"),
        "",  # the fragment never reaches the server
    ))


def _assert_public_url(url: str) -> None:
    """Reject anything that is not a publicly routable http(s) address."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Chỉ hỗ trợ đường dẫn http/https (nhận được: {parsed.scheme or 'không có'})")

    host = parsed.hostname
    if not host:
        raise ValueError(f"Đường dẫn không hợp lệ: {url!r}")

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise ValueError(f"Không phân giải được tên miền: {host}") from e

    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ValueError(
                f"Từ chối địa chỉ nội bộ: {host} → {ip}. Chỉ nhận trang web công khai."
            )


def _fetch(url: str) -> tuple[str, str]:
    """Return (decoded body, content type). Raises ValueError on any refusal."""
    opener = urllib.request.build_opener(_NoRedirectHandler)
    current = _normalize_url(url)

    for _ in range(MAX_REDIRECTS + 1):
        _assert_public_url(current)
        request = urllib.request.Request(
            current,
            headers={
                "User-Agent": _USER_AGENT,
                "Accept": "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
                "Accept-Language": "vi,en;q=0.8",
                "Accept-Encoding": "gzip",
            },
        )

        try:
            response = opener.open(request, timeout=REQUEST_TIMEOUT)
        except urllib.error.HTTPError as e:
            location = e.headers.get("Location") if e.headers else None
            e.close()
            if e.code in (301, 302, 303, 307, 308) and location:
                current = _normalize_url(urllib.parse.urljoin(current, location))
                continue
            raise ValueError(f"Máy chủ trả về HTTP {e.code} cho {current}") from e
        except urllib.error.URLError as e:
            raise ValueError(f"Không kết nối được tới {current}: {e.reason}") from e

        with response:
            content_type = (response.headers.get_content_type() or "").lower()
            if content_type not in _ACCEPTED_CONTENT_TYPES:
                raise ValueError(
                    f"Nội dung không phải trang web (Content-Type: {content_type or 'không rõ'})"
                )
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ValueError(
                    f"Trang web vượt quá giới hạn {MAX_RESPONSE_BYTES // (1024 * 1024)} MB"
                )
            if (response.headers.get("Content-Encoding") or "").lower() == "gzip":
                raw = gzip.decompress(raw)
            charset = response.headers.get_content_charset() or "utf-8"

        return raw.decode(charset, errors="replace"), content_type

    raise ValueError(f"Quá nhiều lần chuyển hướng từ {url}")


def fetch_page_title(url: str) -> Optional[str]:
    """Best-effort page title; returns None instead of raising (mirrors fetch_video_title)."""
    try:
        body, content_type = _fetch(url)
        if content_type == "text/plain":
            return None
        parser = _PageParser()
        parser.feed(body)
        return parser.title
    except Exception as e:
        logger.warning("Failed to fetch page title for %s: %s", url, e)
        return None


def extract_text_from_url(url: str) -> str:
    """Fetch a public web page and return its readable text."""
    body, content_type = _fetch(url)

    if content_type == "text/plain":
        text = _collapse_whitespace(body)
    else:
        parser = _PageParser()
        parser.feed(body)
        text = parser.text

    if not text.strip():
        raise ValueError(
            f"Không trích xuất được nội dung từ {url}. "
            "Trang có thể render bằng JavaScript hoặc yêu cầu đăng nhập."
        )

    logger.info("Extracted %d chars from %s", len(text), url)
    return text
