"""File-search helpers shared by the Linux and Windows adapters: the structured ``FileSearch`` is
reduced to file-name, extension and date predicates (pure; unit-tested on any platform)."""

from __future__ import annotations

import os
import re
from datetime import datetime, timedelta
from pathlib import Path

from .base import FileSearch

# File extensions per FileSearch.kind (no Spotlight content-type tree outside macOS).
KIND_EXTENSIONS: dict[str, tuple[str, ...]] = {
    "image": ("png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "svg", "tif", "tiff", "avif"),
    "screenshot": ("png", "jpg", "jpeg", "webp"),
    "document": ("pdf", "doc", "docx", "odt", "rtf", "txt", "md", "pages", "xls", "xlsx", "ods", "ppt", "pptx", "odp", "epub"),
    "pdf": ("pdf",),
    "video": ("mp4", "mkv", "mov", "avi", "webm", "m4v", "mpg", "mpeg", "wmv"),
    "audio": ("mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus", "wma"),
    "code": ("py", "js", "ts", "tsx", "jsx", "go", "rs", "c", "h", "cpp", "hpp", "java", "rb", "sh", "swift", "kt", "php", "html", "css", "json", "yaml", "yml", "toml", "sql", "lua"),
    "archive": ("zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "deb", "rpm", "appimage"),
}
_SCREENSHOT_NAME = re.compile(r"screenshot|screen shot|screencapture|captura|capture d.[ée]cran|snip", re.IGNORECASE)


def search_time_bounds(search: FileSearch) -> tuple[float | None, float | None]:
    """``since`` (inclusive, start of day) / ``until`` (exclusive end of day) -> epoch bounds."""

    def to_epoch(value: str, end_of_day: bool) -> float:
        value = value.strip()
        try:
            if len(value) == 10:
                dt = datetime.fromisoformat(value)
                if end_of_day:
                    dt = dt + timedelta(days=1)
            else:
                dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(f"invalid date '{value}' (use YYYY-MM-DD or ISO 8601)") from exc
        return dt.timestamp()

    return (to_epoch(search.since, False) if search.since else None), (to_epoch(search.until, True) if search.until else None)


def search_extensions(search: FileSearch) -> set[str]:
    """Lower-case extensions (no dot) the search accepts; empty means any."""
    exts = {e.lstrip(".").lower() for e in search.extensions if e}
    kind = search.kind or "any"
    if kind in KIND_EXTENSIONS:
        kind_exts = set(KIND_EXTENSIONS[kind])
        exts = exts & kind_exts if exts else kind_exts
    return exts


def matches_search(path: str, search: FileSearch, *, is_dir: bool, mtime: float | None, bounds: tuple[float | None, float | None] | None = None) -> bool:
    """Decide whether a candidate path satisfies every FileSearch constraint (pure; unit-tested).

    ``text`` matches the file name only: Linux has no content index comparable to Spotlight.
    ``since``/``until`` apply to the modification time (birth time is not portable)."""
    name = Path(path).name
    lower = name.lower()
    kind = search.kind or "any"
    if kind == "folder":
        if not is_dir:
            return False
    elif kind != "any" and is_dir:
        return False
    if search.name and search.name.lower() not in lower:
        return False
    if search.text and search.text.lower() not in lower:
        return False
    exts = search_extensions(search)
    if exts:
        ext = lower.rsplit(".", 1)[1] if "." in lower else ""
        if is_dir or ext not in exts:
            return False
    if kind == "screenshot" and not _SCREENSHOT_NAME.search(name):
        return False
    if search.scope:
        scope = os.path.normcase(os.path.abspath(os.path.expanduser(search.scope))).rstrip("\\/") + os.sep
        if not (os.path.normcase(path) + os.sep).startswith(scope):
            return False
    since, until = bounds if bounds is not None else search_time_bounds(search)
    if (since is not None or until is not None) and mtime is None:
        return False
    if since is not None and mtime is not None and mtime < since:
        return False
    if until is not None and mtime is not None and mtime >= until:
        return False
    return True
