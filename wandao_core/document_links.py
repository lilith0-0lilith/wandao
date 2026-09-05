"""Shared, browser-safe references for failed source documents."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit


def direct_document_reference(document_url: Any, *, document_id: Any = "", label: str = "定位到原文") -> dict[str, str]:
    """Return the standard task-report reference for an HTTPS document page.

    Providers must pass a document page URL they already used during export,
    never an API endpoint or a downloadable resource URL.  Invalid values are
    deliberately omitted so the task center does not expose a misleading link.
    """

    url = str(document_url or "").strip()
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.netloc or any(char.isspace() for char in url):
        return {}
    result = {
        "documentUrl": url,
        "documentUrlKind": "direct_page",
        "documentUrlLabel": label,
    }
    identifier = str(document_id or "").strip()
    if identifier:
        result["documentId"] = identifier
    return result
