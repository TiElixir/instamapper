"""Load Instagram session cookies from local YAML/JSON files.

Cookie files are intentionally gitignored; the repository only ships a
`cookies.example.yaml` template. Credentials are never read or stored.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

COOKIE_FIELDS = {"name", "value", "domain", "path"}


class CookieLoadError(ValueError):
    pass


def _normalise_cookie(raw: dict[str, Any]) -> dict[str, str]:
    cookie: dict[str, Any] = {
        "name": str(raw.get("name", "")).strip(),
        "value": str(raw.get("value", "")).strip(),
        "domain": str(raw.get("domain", ".instagram.com")),
        "path": str(raw.get("path", "/")),
    }
    if raw.get("expires") not in (None, ""):
        try:
            cookie["expires"] = int(raw["expires"])
        except (TypeError, ValueError):
            pass
    if raw.get("httpOnly") is not None:
        cookie["httpOnly"] = bool(raw["httpOnly"])
    if raw.get("secure") is not None:
        cookie["secure"] = bool(raw["secure"])
    if raw.get("sameSite"):
        cookie["sameSite"] = str(raw["sameSite"]).lower()
    return cookie


def load_cookie_file(path: str | Path) -> list[dict[str, Any]]:
    """Load cookies from a YAML or JSON file (either a plain list or a dict
    with a top-level ``cookies`` key)."""
    file_path = Path(path)
    if not file_path.exists():
        raise CookieLoadError(f"cookie file not found: {file_path}")
    text = file_path.read_text(encoding="utf-8")
    if file_path.suffix.lower() in (".json",):
        data = json.loads(text)
    else:
        data = yaml.safe_load(text) or []
    if isinstance(data, dict):
        data = data.get("cookies", [])
    if not isinstance(data, list):
        raise CookieLoadError("cookie file must contain a list of cookies or a `cookies:` key")
    cookies = [_normalise_cookie(item) for item in data if isinstance(item, dict)]
    valid = [c for c in cookies if c["name"] and c["value"]]
    if len(valid) != len(cookies):
        raise CookieLoadError("cookie file contains entries missing name or value")
    if not valid:
        raise CookieLoadError("cookie file contains no cookies")
    return valid
