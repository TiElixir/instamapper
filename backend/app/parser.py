"""Parse Instagram profile data from raw page HTML / embedded JSON state."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from app.schemas import AccountStatus, UserProfile


def normalize_count(raw: str | int | float | None) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, bool):
        return int(raw) if raw else 0
    if isinstance(raw, (int, float)):
        return int(raw)
    text = str(raw).strip().replace("\u00a0", " ")
    match = re.search(r"([\d.,]+)\s*([KkMm]?)", text)
    if not match:
        return None
    num_str, suffix = match.groups()

    # Handle European decimal commas like "1,2K" -> "1.2"
    if "," in num_str and "." not in num_str and suffix:
        num_str = num_str.replace(",", ".")
    else:
        num_str = num_str.replace(",", "")
    try:
        number = float(num_str)
    except ValueError:
        return None
    multiplier = {"": 1, "k": 1_000, "m": 1_000_000}.get(suffix.lower(), 1)
    return int(number * multiplier)


def _extract_embedded_json(html: str) -> dict[str, Any] | None:
    match = re.search(r"window\._sharedData\s*=\s*", html)
    if not match:
        return None
    start = match.end()
    depth = 0
    in_string = False
    escape = False
    for pos in range(start, len(html)):
        ch = html[pos]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(html[start : pos + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _nested_get(data: dict[str, Any], *keys: str | int) -> Any:
    current: Any = data
    for key in keys:
        if isinstance(current, dict) and isinstance(key, str):
            current = current.get(key)
        elif isinstance(current, list) and isinstance(key, int):
            if 0 <= key < len(current):
                current = current[key]
            else:
                return None
        else:
            return None
    return current


def parse_profile(username: str, html: str, scanned_at: datetime | None = None) -> UserProfile:
    data = _extract_embedded_json(html)
    timestamp = scanned_at or datetime.now(timezone.utc)
    user = None
    if data:
        user = _nested_get(data, "entry_data", "ProfilePage", 0, "graphql", "user")
        if user is None:
            user = data.get("user")

    if user is None:
        follower_count = _parse_visible_count(html, "followers")
        following_count = _parse_visible_count(html, "following")
        post_count = _parse_visible_count(html, "posts")
        if follower_count is not None or following_count is not None or post_count is not None:
            return UserProfile(
                username=username.strip().lower(),
                follower_count=follower_count,
                following_count=following_count,
                post_count=post_count,
                status=AccountStatus.AVAILABLE,
                scanned_at=timestamp,
            )
        return UserProfile(
            username=username.strip().lower(),
            status=AccountStatus.UNAVAILABLE if data is None else AccountStatus.ERROR,
            scanned_at=timestamp,
        )

    instagram_id = user.get("id") or user.get("pk")
    display_name = user.get("full_name")
    bio = user.get("biography")
    website = user.get("external_url")
    picture_url = user.get("profile_pic_url_hd") or user.get("profile_pic_url")
    category = user.get("category_name")
    verified = bool(user.get("is_verified"))
    is_private = bool(user.get("is_private"))

    edge_followed_by = user.get("edge_followed_by") or {}
    edge_follow = user.get("edge_follow") or {}
    follower_count = normalize_count(edge_followed_by.get("count"))
    following_count = normalize_count(edge_follow.get("count"))

    if follower_count is None:
        follower_count = _parse_visible_count(html, "followers")
    if following_count is None:
        following_count = _parse_visible_count(html, "following")
    post_count = normalize_count(_nested_get(user, "edge_owner_to_timeline_media", "count"))
    if post_count is None:
        post_count = _parse_visible_count(html, "posts")

    status = AccountStatus.PRIVATE if is_private else AccountStatus.AVAILABLE
    return UserProfile(
        username=username.strip().lower(),
        instagram_id=str(instagram_id) if instagram_id else None,
        display_name=display_name,
        bio=bio,
        follower_count=follower_count,
        following_count=following_count,
        post_count=post_count,
        verified=verified,
        is_private=is_private,
        website=website,
        picture_url=picture_url,
        category=category,
        status=status,
        scanned_at=timestamp,
    )


def _parse_visible_count(html: str, label: str) -> int | None:
    match = re.search(r"([\d.,]+\s*[KkMm]?)\s*" + re.escape(label), html, re.IGNORECASE)
    if not match:
        return None
    return normalize_count(match.group(1))


def parse_following_rows(html: str) -> list[str]:
    usernames: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(r'href="/?([A-Za-z0-9._]{1,30})/"', html):
        candidate = match.group(1)
        if candidate.lower() in {"explore", "accounts", "p", "reel", "stories", "direct", "about"}:
            continue
        if candidate not in seen:
            seen.add(candidate)
            usernames.append(candidate)
    return usernames


def parse_following_rows_from_dom(dialog_rows: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for row in dialog_rows:
        username = str(row.get("username") or "").strip().lower()
        if username and username not in out:
            out.append(username)
    return out
