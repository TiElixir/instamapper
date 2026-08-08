"""Legacy Playwright collector kept for compatibility and unit tests.

How it works:
1. Load session cookies from a local YAML/JSON file.
2. Open the target user's Following list (not the profile page).
3. Scroll the dialog until no new rows appear, record every
   ``source → target`` edge and ensure both usernames exist in the DB.
4. For each newly discovered username (up to the configured depth),
   repeat from step 2.

Guardrails:
- No login automation; only local cookie files are loaded.
- The collector visits a profile only to open its relationship dialog.
- Following lists that are not visible to the authenticated session
  produce a structured scan error and are skipped, never fatal.
- The queue is checkpointed to SQLite so interrupted scans resume.
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
import threading
from datetime import datetime, timezone
from typing import Any

from app import cookies as cookie_loader
from app.config import AppConfig
from app.database import Database
from app.parser import parse_profile
from app.schemas import AccountStatus, RelationshipType, ScanStatus, UserProfile
from app.logging_setup import get_logger, log_event

try:
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError
    from playwright.async_api import async_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    async_playwright = None
    PlaywrightTimeoutError = Exception
    PLAYWRIGHT_AVAILABLE = False

SELECTORS: dict[str, str] = {
    "following_dialog": '[role="dialog"]',
}

USERNAME_RE = re.compile(r"^/?([A-Za-z0-9._]{1,30})/?$")

_DEFAULT_COOKIE_CANDIDATES = ("cookies.yaml", "cookies.json", "cookies.local.yaml")


class CollectorError(RuntimeError):
    pass


class RateLimitedError(RuntimeError):
    pass


class PageUnavailableError(RuntimeError):
    pass


class ScanCancelled(Exception):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Collector:
    def __init__(self, db: Database, config: AppConfig, logger: logging.Logger | None = None):
        self.db = db
        self.config = config
        self.logger = logger or get_logger("instarl.collector")
        self._cancel_event = threading.Event()
        self._processed_count = 0

    def cancel(self) -> None:
        self._cancel_event.set()

    def _checkpoint_threshold(self) -> int:
        return max(5, self.config.collector.max_workers * 2)

    # -- cookie validation ----------------------------------------------
    async def test_cookies(self, cookie_path: str | None = None) -> dict:
        """Launch a headless browser, load cookies, visit Instagram, and
        report whether the session is authenticated.

        Returns a dict with ``valid`` (bool), ``username`` (str | None),
        and ``detail`` (str).
        """
        if not PLAYWRIGHT_AVAILABLE:
            return {"valid": False, "username": None, "detail": "playwright is not installed"}
        try:
            loaded_cookies = self._load_cookies(cookie_path)
        except Exception as exc:
            return {"valid": False, "username": None, "detail": str(exc)}

        cfg = self.config.collector
        try:
            async with async_playwright() as pw:
                browser = await getattr(pw, cfg.browser).launch(headless=True)
                context = await browser.new_context(
                    user_agent=cfg.user_agent or None,
                    base_url="https://www.instagram.com",
                )
                await context.add_cookies(loaded_cookies)
                page = await context.new_page()
                await page.goto("https://www.instagram.com/", wait_until="domcontentloaded")
                await asyncio.sleep(2)
                html = await page.content()

                if self._looks_like_access_wall(html):
                    await browser.close()
                    return {"valid": False, "username": None, "detail": "session is logged out or requires login"}

                username = await page.evaluate(
                    """() => {
                        try {
                            const meta = document.querySelector('meta[property="al:ios:url"]');
                            if (meta) {
                                const m = meta.getAttribute('content')?.match(/user\\?id=(\\d+)/);
                                if (m) return null;
                            }
                            const links = document.querySelectorAll('a[href]');
                            for (const a of links) {
                                const href = a.getAttribute('href') || '';
                                if (/^\\/[A-Za-z0-9._]{1,30}\\/$/.test(href)) {
                                    const text = (a.textContent || '').trim();
                                    if (text === 'Profile' || a.getAttribute('aria-label') === 'Profile') {
                                        return href.replace(/^\\//,'').replace(/\\/$/,'');
                                    }
                                }
                            }
                            const cfg = document.querySelector('script[type="application/json"]');
                            if (cfg) {
                                const m = cfg.textContent.match(/"username":"([^"]+)"/);
                                if (m) return m[1];
                            }
                        } catch {}
                        return null;
                    }"""
                )

                has_feed = "feed" in html.lower() or '"viewer"' in html or '"viewerId"' in html

                await browser.close()

                if has_feed or username:
                    return {
                        "valid": True,
                        "username": username,
                        "detail": f"logged in as @{username}" if username else "session is authenticated",
                    }
                return {"valid": False, "username": None, "detail": "could not confirm authentication"}
        except Exception as exc:
            return {"valid": False, "username": None, "detail": f"browser error: {exc}"}

    # -- entry point ----------------------------------------------------
    async def run_scan(
        self,
        target: str,
        depth: int = 1,
        cookie_path: str | None = None,
        resume: bool = True,
        session_id: int | None = None,
    ) -> int:
        if not PLAYWRIGHT_AVAILABLE:
            raise CollectorError(
                "playwright is not installed; run `pip install playwright && playwright install chromium`"
            )
        cfg = self.config.collector
        target = target.strip().lower()
        self._cancel_event.clear()
        self._processed_count = 0

        if session_id is None:
            session_id = self.db.create_scan_session(target, depth, cookie_path).id
        self.db.update_scan(session_id, status=ScanStatus.RUNNING.value, started_at=utcnow())

        queue: asyncio.Queue[tuple[str, int]] = asyncio.Queue()
        seen: set[str] = set()
        for username, remaining in self._initial_queue(target, depth, resume, session_id):
            if username not in seen:
                seen.add(username)
                queue.put_nowait((username, remaining))

        try:
            loaded_cookies = self._load_cookies(cookie_path)
            async with async_playwright() as playwright:
                browser_type = getattr(playwright, cfg.browser)
                launch_kwargs: dict[str, Any] = {"headless": cfg.headless}
                if cfg.proxy:
                    launch_kwargs["proxy"] = {"server": cfg.proxy}
                browser = await browser_type.launch(**launch_kwargs)
                context = await browser.new_context(
                    user_agent=cfg.user_agent or None,
                    base_url="https://www.instagram.com",
                )
                await context.add_cookies(loaded_cookies)
                pages = [await context.new_page() for _ in range(cfg.max_workers)]

                workers = [
                    asyncio.create_task(
                        self._worker(queue, pages[i % len(pages)], session_id, seen)
                    )
                    for i in range(cfg.max_workers)
                ]
                join_task = asyncio.create_task(queue.join())
                cancel_task = asyncio.create_task(self._wait_for_cancel())
                done, pending = await asyncio.wait(
                    {join_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED
                )
                was_cancelled = cancel_task in done
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)

                self._cancel_event.set()
                for worker in workers:
                    worker.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
                await self._finalize(session_id, queue, cancelled=was_cancelled)
                await browser.close()
        except asyncio.CancelledError:
            self._cancel_event.set()
            await self._finalize(session_id, queue, failed="scan cancelled")
            raise
        except Exception as exc:
            self._cancel_event.set()
            await self._finalize(session_id, queue, failed=str(exc))
            log_event(self.logger, "scan_failed", logging.ERROR, scan_id=session_id, reason=str(exc))
            raise CollectorError(f"scan {session_id} failed: {exc}") from exc

        log_event(self.logger, "scan_finished", scan_id=session_id, target=target, depth=depth)
        return session_id

    async def _wait_for_cancel(self) -> None:
        while not self._cancel_event.is_set():
            await asyncio.sleep(0.25)
        raise ScanCancelled("collector cancelled")

    def _initial_queue(self, target: str, depth: int, resume: bool, session_id: int) -> list[tuple[str, int]]:
        pending: list[tuple[str, int]] = []
        if resume:
            pending = self._previous_checkpoint(target)
        if not pending or not resume:
            pending = [(target, depth)]
        return pending

    def _previous_checkpoint(self, target: str) -> list[tuple[str, int]]:
        for scan in self.db.list_scans(limit=200):
            if scan.target != target:
                continue
            if scan.status in (ScanStatus.COMPLETED.value,):
                continue
            checkpoint = self.db.load_checkpoint(scan.id)
            if checkpoint:
                parsed: list[tuple[str, int]] = []
                for entry in checkpoint:
                    if isinstance(entry, (list, tuple)) and len(entry) >= 2:
                        parsed.append((str(entry[0]), int(entry[1])))
                    elif isinstance(entry, (list, tuple)) and len(entry) == 1:
                        parsed.append((str(entry[0]), 1))
                    elif isinstance(entry, str):
                        parsed.append((entry, 1))
                return parsed
        return []

    # -- cookie handling ------------------------------------------------
    def _load_cookies(self, cookie_path: str | None) -> list[dict[str, Any]]:
        if cookie_path:
            return cookie_loader.load_cookie_file(cookie_path)
        from app.config import REPO_ROOT
        for candidate in _DEFAULT_COOKIE_CANDIDATES:
            candidate_path = REPO_ROOT / "config" / candidate
            if candidate_path.exists():
                return cookie_loader.load_cookie_file(candidate_path)
        raise CollectorError(
            "no cookie file found; create config/cookies.yaml from config/cookies.example.yaml "
            "or pass cookie_path to the scan"
        )

    # -- worker ---------------------------------------------------------
    async def _worker(
        self,
        queue: asyncio.Queue,
        page: Any,
        session_id: int,
        seen: set[str],
    ) -> None:
        while True:
            if self._cancel_event.is_set():
                return
            item: Any = None
            username: str = "unknown"
            remaining: int = 1
            try:
                item = await asyncio.wait_for(queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                return
            try:
                if isinstance(item, (list, tuple)) and len(item) >= 2:
                    username, remaining = str(item[0]), int(item[1])
                elif isinstance(item, (list, tuple)) and len(item) == 1:
                    username, remaining = str(item[0]), 1
                elif isinstance(item, str):
                    username, remaining = item, 1
                else:
                    log_event(self.logger, "invalid_queue_item", logging.WARNING, item=repr(item))
                    continue

                await self._process_account(page, session_id, username, remaining, queue, seen)
            except asyncio.CancelledError:
                return
            except Exception as exc:
                self.db.add_scan_error(session_id, username, "worker_exception", str(exc))
                log_event(self.logger, "account_failed", logging.ERROR, username=username, reason=str(exc))
            finally:
                if item is not None:
                    queue.task_done()

    async def _process_account(
        self,
        page: Any,
        session_id: int,
        username: str,
        remaining: int,
        queue: asyncio.Queue,
        seen: set[str],
    ) -> None:
        log_event(self.logger, "scanning_account", username=username, remaining_depth=remaining)
        profile = await self._fetch_profile_with_retry(page, username, session_id)
        self.db.upsert_user(profile, session_id)

        if profile.status is not AccountStatus.AVAILABLE:
            reason = f"account {profile.status.value}"
            if profile.bio:
                reason = profile.bio
            self.db.add_scan_error(
                session_id,
                username,
                profile.status.value,
                reason,
                {"depth": remaining},
            )
            log_event(self.logger, "account_skipped", username=username, reason=reason)
            self._bump_counts(session_id, users=1)
            return

        if remaining <= 0:
            self._bump_counts(session_id, users=1)
            return

        following = await self._collect_following_with_retry(
            page,
            username,
            session_id,
            expected_count=profile.following_count,
        )
        discovered = following
        new_edges = len(following)
        if profile.following_count and not following:
            self.db.add_scan_error(
                session_id,
                username,
                "following_empty",
                "following list opened but no relationship rows were found",
                {"expected_count": profile.following_count, "depth": remaining},
            )
            log_event(
                self.logger,
                "following_empty",
                logging.WARNING,
                username=username,
                expected_count=profile.following_count,
            )
        for target_username in discovered:
            if remaining - 1 > 0 and target_username not in seen:
                seen.add(target_username)
                queue.put_nowait((target_username, remaining - 1))
        self._bump_counts(session_id, users=1, edges=new_edges)
        self._processed_count += 1
        if self._processed_count % self._checkpoint_threshold() == 0:
            self.db.save_checkpoint(session_id, self._snapshot_queue(queue))

    # -- profile fetching ------------------------------------------------
    async def _fetch_profile_with_retry(self, page: Any, username: str, session_id: int) -> UserProfile:
        retry_limit = self.config.collector.retry_limit
        for attempt in range(1, retry_limit + 1):
            try:
                html = await self._load_profile_page(page, username)
                profile = parse_profile(username, html)
                if profile.status is AccountStatus.ERROR and attempt < retry_limit:
                    raise PageUnavailableError("profile could not be parsed")
                return profile
            except RateLimitedError:
                await self._backoff(attempt)
                if attempt == retry_limit:
                    return UserProfile(username=username, status=AccountStatus.RATE_LIMITED, scanned_at=utcnow())
            except (PlaywrightTimeoutError, PageUnavailableError) as exc:
                await self._backoff(attempt)
                if attempt == retry_limit:
                    log_event(self.logger, "profile_fetch_failed", logging.WARNING, username=username, reason=str(exc))
                    return UserProfile(username=username, status=AccountStatus.ERROR, scanned_at=utcnow())
            except Exception as exc:
                log_event(self.logger, "profile_fetch_error", logging.WARNING, username=username, reason=str(exc))
                return UserProfile(username=username, status=AccountStatus.ERROR, scanned_at=utcnow())
        return UserProfile(username=username, status=AccountStatus.ERROR, scanned_at=utcnow())

    async def _load_profile_page(self, page: Any, username: str) -> str:
        await page.goto(f"https://www.instagram.com/{username}/", wait_until="domcontentloaded")
        await self._sleep()
        html = await page.content()
        if self._looks_like_access_wall(html):
            raise RateLimitedError("login/challenge wall detected")
        return html

    async def _open_list_dialog(self, page: Any, username: str, list_type: str) -> bool:
        dialog_selector = SELECTORS["following_dialog"]

        # Attempt 1: Direct navigation
        try:
            await page.goto(f"https://www.instagram.com/{username}/{list_type}/", wait_until="domcontentloaded")
            await self._sleep()
            html = await page.content()
            if self._looks_like_access_wall(html):
                raise RateLimitedError(f"authenticated {list_type} list is unavailable")
            try:
                await page.wait_for_selector(dialog_selector, timeout=5000)
                return True
            except PlaywrightTimeoutError:
                pass
        except RateLimitedError:
            raise
        except Exception:
            pass

        # Attempt 2: Profile page navigation and link click
        try:
            await page.goto(f"https://www.instagram.com/{username}/", wait_until="domcontentloaded")
            await self._sleep()
            html = await page.content()
            if self._looks_like_access_wall(html):
                raise RateLimitedError(f"authenticated {list_type} list is unavailable")

            profile_list_path = f"/{username}/{list_type}/"
            list_link = page.locator(
                f'a[href="{profile_list_path}"], a[href^="{profile_list_path}?"]'
            ).first
            await list_link.click(timeout=6000)
            await page.wait_for_selector(dialog_selector, timeout=8000)
            return True
        except RateLimitedError:
            raise
        except Exception:
            pass

        return False

    # -- followers and following list -----------------------------------
    async def _collect_followers_with_retry(
        self,
        page: Any,
        username: str,
        session_id: int,
        expected_count: int | None = None,
    ) -> list[str]:
        return await self._collect_list_with_retry(
            page,
            username,
            "followers",
            session_id,
            expected_count=expected_count,
        )

    async def _collect_following_with_retry(
        self,
        page: Any,
        username: str,
        session_id: int,
        expected_count: int | None = None,
    ) -> list[str]:
        return await self._collect_list_with_retry(
            page,
            username,
            "following",
            session_id,
            expected_count=expected_count,
        )

    async def _collect_followers(
        self,
        page: Any,
        username: str,
        session_id: int,
        expected_count: int | None = None,
    ) -> list[str]:
        return await self._collect_list(
            page,
            username,
            "followers",
            session_id,
            expected_count=expected_count,
        )

    async def _collect_following(
        self,
        page: Any,
        username: str,
        session_id: int,
        expected_count: int | None = None,
    ) -> list[str]:
        return await self._collect_list(
            page,
            username,
            "following",
            session_id,
            expected_count=expected_count,
        )

    async def _collect_list_with_retry(
        self,
        page: Any,
        username: str,
        list_type: str,
        session_id: int,
        expected_count: int | None = None,
    ) -> list[str]:
        retry_limit = self.config.collector.retry_limit
        last_exc: Exception | None = None
        for attempt in range(1, retry_limit + 1):
            try:
                return await self._collect_list(
                    page,
                    username,
                    list_type,
                    session_id,
                    expected_count=expected_count,
                )
            except RateLimitedError as exc:
                last_exc = exc
                await self._backoff(attempt)
            except (PlaywrightTimeoutError, PageUnavailableError) as exc:
                last_exc = exc
                await self._backoff(attempt)
        if last_exc is not None:
            error_type = "rate_limited" if isinstance(last_exc, RateLimitedError) else f"{list_type}_unavailable"
            self.db.add_scan_error(session_id, username, error_type, str(last_exc))
        return []

    async def _collect_list(
        self,
        page: Any,
        username: str,
        list_type: str,
        session_id: int,
        expected_count: int | None = None,
    ) -> list[str]:
        max_pages = max(150, self.config.collector.max_pages_per_user)
        max_rows = self.config.collector.max_following_rows
        relationship_limit = min(max_rows, expected_count) if expected_count is not None else max_rows
        rows: set[str] = set()

        opened = await self._open_list_dialog(page, username, list_type)
        if not opened:
            raise PageUnavailableError(f"{list_type} dialog did not open for @{username}")

        await self._sleep()

        stable_passes = 0
        for _ in range(max_pages):
            found = await self._extract_dialog_usernames(page)
            fresh = set(found) - rows
            fresh.discard(username)
            if fresh:
                remaining_slots = relationship_limit - len(rows)
                if remaining_slots <= 0:
                    break
                accepted = sorted(fresh)[:remaining_slots]
                rows.update(accepted)
                for target in accepted:
                    if list_type == "following":
                        self.db.record_edge(username, target, RelationshipType.FOLLOWS, session_id)
                    else:
                        self.db.record_edge(target, username, RelationshipType.FOLLOWS, session_id)
                stable_passes = 0
                if len(rows) >= relationship_limit:
                    break
            else:
                stable_passes += 1
                if stable_passes >= 6:
                    break

            try:
                scrolled = await page.evaluate(
                    """() => {
                        const dialog = document.querySelector('[role="dialog"]');
                        if (!dialog) return false;
                        const containers = Array.from(dialog.querySelectorAll('div')).filter(el => {
                            const style = window.getComputedStyle(el);
                            return (style.overflowY === 'auto' || style.overflowY === 'scroll' || el.classList.contains('_aano'));
                        });
                        const target = containers[0] || dialog.querySelector('div._aano') || dialog;
                        if (target) {
                            target.scrollTop += 3000;
                            const items = dialog.querySelectorAll('a[href^="/"], li, div[role="button"]');
                            if (items.length > 0) {
                                items[items.length - 1].scrollIntoView({ block: 'end', behavior: 'smooth' });
                            }
                            return true;
                        }
                        return false;
                    }"""
                )
                if not scrolled:
                    await page.mouse.wheel(0, 4000)
            except Exception:
                try:
                    await page.mouse.wheel(0, 4000)
                except Exception:
                    break

            await self._sleep()

        log_event(self.logger, f"{list_type}_collected", username=username, count=len(rows))
        return sorted(rows)

    async def _extract_dialog_usernames(self, page: Any) -> list[str]:
        """Read only individual profile links in the active list modal.

        In particular, do not infer relationships from page text, search results,
        suggestions, or arbitrary network payloads.  A username becomes an edge
        candidate only when Instagram renders it as a single-segment profile link
        before the modal's optional ``Suggested for you`` section.
        """
        excluded = {
            "explore", "accounts", "p", "reel", "reels", "stories", "direct",
            "about", "privacy", "terms", "locations", "api", "jobs", "help",
            "press", "meta", "verified", "following", "followers", "posts",
        }
        try:
            rows = await page.evaluate(
                """() => {
                    const dialog = document.querySelector('[role="dialog"]');
                    if (!dialog) return [];

                    const profileLinkPattern = /^\\/[A-Za-z0-9._]{1,30}\\/?$/;
                    const allLinks = Array.from(dialog.querySelectorAll('a[href]'));
                    const suggestionHeading = Array.from(
                        dialog.querySelectorAll('h1,h2,h3,h4,span,div')
                    ).find((element) => {
                        if (element.children.length > 0) return false;
                        const text = (element.textContent || '').trim().toLowerCase();
                        return text === 'suggested for you' || text === 'suggestions for you';
                    });

                    return allLinks.flatMap((link) => {
                        const href = link.getAttribute('href');
                        if (!href || !profileLinkPattern.test(href)) return [];
                        const afterSuggestion = Boolean(
                            suggestionHeading &&
                            (suggestionHeading.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING)
                        );
                        return afterSuggestion ? [] : [href];
                    });
                }"""
            )
        except Exception:
            return []

        usernames: list[str] = []
        for href in rows or []:
            match = USERNAME_RE.fullmatch(str(href).strip("/"))
            if match is None:
                continue
            username = match.group(1).lower()
            if username not in excluded:
                usernames.append(username)
        return list(dict.fromkeys(usernames))

    @staticmethod
    def _looks_like_access_wall(html: str) -> bool:
        """Identify an actual login/challenge document, not static JS strings.

        Instagram's normal application HTML can contain words such as
        ``login_required`` and ``challenge_required`` in bundled scripts. Those
        strings alone do not mean that a valid session has expired.
        """
        lowered = html.lower()
        has_login_form = (
            re.search(r'<input[^>]+name=["\']username["\']', lowered) is not None
            and re.search(r'<input[^>]+(?:name|type)=["\'](?:password)["\']', lowered) is not None
        )
        has_login_action = re.search(r'<form[^>]+action=["\'][^"\']*/accounts/login', lowered) is not None
        has_challenge_action = re.search(r'<form[^>]+action=["\'][^"\']*/challenge', lowered) is not None
        has_login_copy = "log in to instagram" in lowered or "login to instagram" in lowered
        return has_challenge_action or has_login_action or (has_login_form and has_login_copy)

    # -- helpers --------------------------------------------------------
    def _bump_counts(self, session_id: int, users: int = 0, edges: int = 0) -> None:
        scan = self.db.get_scan(session_id)
        if scan is None:
            return
        self.db.update_scan(
            session_id,
            users_seen=(scan.users_seen or 0) + users,
            edges_seen=(scan.edges_seen or 0) + edges,
        )

    async def _sleep(self) -> None:
        rate = self.config.collector.rate_limit
        delay = rate.per_action_delay_ms + random.randint(0, rate.per_action_jitter_ms)
        if delay > 0:
            await asyncio.sleep(delay / 1000)

    async def _backoff(self, attempt: int) -> None:
        base = self.config.collector.retry_backoff_base_ms
        delay = base * (2 ** (attempt - 1)) + random.randint(0, 250)
        await asyncio.sleep(delay / 1000)

    def _snapshot_queue(self, queue: asyncio.Queue) -> list[tuple[str, int]]:
        try:
            return list(queue._queue)
        except Exception:
            items: list[tuple[str, int]] = []
            drained = []
            while not queue.empty():
                try:
                    drained.append(queue.get_nowait())
                except asyncio.QueueEmpty:
                    break
            for item in drained:
                items.append(item)
                queue.put_nowait(item)
            return items

    def _drain_queue(self, queue: asyncio.Queue) -> list[tuple[str, int]]:
        remaining: list[tuple[str, int]] = []
        while True:
            try:
                remaining.append(queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        return remaining

    async def _finalize(
        self,
        session_id: int,
        queue: asyncio.Queue,
        failed: str | None = None,
        cancelled: bool = False,
    ) -> None:
        remaining = self._snapshot_queue(queue)
        self.db.save_checkpoint(session_id, remaining)
        scan = self.db.get_scan(session_id)
        if scan is None:
            return
        if failed is not None:
            status = ScanStatus.FAILED.value
        elif cancelled:
            status = ScanStatus.CANCELLED.value
        else:
            status = ScanStatus.COMPLETED.value
        self.db.update_scan(
            session_id,
            status=status,
            finished_at=utcnow(),
            checkpoint=scan.checkpoint or ("[]" if not remaining else None),
        )
        log_event(self.logger, "scan_finalized", scan_id=session_id, status=status, pending=len(remaining))
