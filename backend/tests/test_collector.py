"""Collector tests with mocked Playwright objects; no network or browser needed."""
import asyncio

import pytest

from app.collector import Collector, CollectorError, RateLimitedError, SELECTORS
from app.config import AppConfig
from app.database import Database
from app.schemas import AccountStatus, ScanStatus, UserProfile


@pytest.fixture
def db(tmp_path):
    return Database(tmp_path / "collector.db")


@pytest.fixture
def config(tmp_path):
    return AppConfig.model_validate(
        {
            "collector": {
                "headless": True,
                "max_workers": 1,
                "retry_limit": 1,
                "retry_backoff_base_ms": 0,
                "per_action_delay_ms": 0,
                "per_action_jitter_ms": 0,
                "max_following_rows": 50,
                "scan_timeout_seconds": 60,
            },
            "database_path": str(tmp_path / "collector.db"),
        }
    )


class FakePage:
    def __init__(self, html="<html></html>", dialog=True):
        self.html = html
        self.dialog = dialog
        self.content_calls = 0

    async def goto(self, url, **kwargs):
        pass

    async def content(self):
        self.content_calls += 1
        return self.html

    async def wait_for_selector(self, selector, timeout=None):
        if not self.dialog:
            raise TimeoutError("no dialog")
        return True

    async def click(self, selector, **kwargs):
        if not self.dialog:
            raise TimeoutError("no dialog")

    async def evaluate(self, expr, *args):
        return None

    def on(self, event, cb):
        pass

    def remove_listener(self, event, cb):
        pass

    async def mouse(self):
        return FakeMouse()

    async def eval_on_selector_all(self, selector, expr):
        return []


class FakeMouse:
    async def wheel(self, dx, dy):
        pass


class FakeContext:
    def __init__(self, page):
        self.page = page

    async def new_page(self):
        return self.page

    async def add_cookies(self, cookies):
        self.cookies = cookies


class FakeBrowser:
    def __init__(self, page):
        self.page = page
        self.closed = False

    async def new_context(self, **kwargs):
        return FakeContext(self.page)

    async def close(self):
        self.closed = True


class FakeBrowserType:
    def __init__(self, page):
        self.page = page

    async def launch(self, **kwargs):
        return FakeBrowser(self.page)


class FakePlaywright:
    def __init__(self, page):
        self._browser_type = FakeBrowserType(page)
        self.chromium = self._browser_type

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


def _collector(db, config):
    return Collector(db, config)


@pytest.mark.asyncio
async def test_scan_marks_failed_when_cookies_missing(db, config, tmp_path):
    collector = _collector(db, config)
    with pytest.raises(CollectorError):
        await collector.run_scan("alice", cookie_path=str(tmp_path / "missing.yaml"))
    scans = db.list_scans()
    assert len(scans) == 1
    assert scans[0].status == ScanStatus.FAILED.value


def test_checkpoint_save_and_resume(db, config):
    collector = _collector(db, config)
    session_id = db.create_scan_session("alice", 1).id
    db.save_checkpoint(session_id, ["bob", "carol"])
    pending = collector._previous_checkpoint("alice")
    assert pending == [("bob", 1), ("carol", 1)]


def test_initial_queue_resume_uses_checkpoint(db, config):
    collector = _collector(db, config)
    session_id = db.create_scan_session("alice", 1).id
    db.save_checkpoint(session_id, [["carol", 1]])
    queue = collector._initial_queue("alice", 1, resume=True, session_id=session_id)
    assert queue == [("carol", 1)]


def test_page_word_challenge_is_not_rate_limited():
    assert Collector._looks_like_access_wall("<html><body>Join our challenge and view this profile.</body></html>") is False


def test_page_explicit_login_wall_is_rate_limited():
    assert Collector._looks_like_access_wall(
        '<html><body>Log in to Instagram<form action="/accounts/login/"><input name="username"><input name="password"></form></body></html>'
    ) is True


def test_embedded_login_marker_is_not_treated_as_a_login_wall():
    assert Collector._looks_like_access_wall("<html><script>const state = 'login_required'</script></html>") is False


@pytest.mark.asyncio
async def test_process_account_collects_edges(db, config, monkeypatch):
    collector = _collector(db, config)
    session_id = db.create_scan_session("alice", 1).id

    async def fake_fetch_profile(*args, **kw):
        return UserProfile(username="alice", status=AccountStatus.AVAILABLE)

    async def fake_collect_following(page, username, scan_id, **kw):
        return ["bob", "carol"]

    monkeypatch.setattr(collector, "_fetch_profile_with_retry", fake_fetch_profile)
    monkeypatch.setattr(collector, "_collect_following_with_retry", fake_collect_following)
    queue = asyncio.Queue()
    seen = set()
    await collector._process_account(FakePage(), session_id, "alice", 2, queue, seen)

    saved = db.get_user("alice")
    assert saved is not None
    assert db.get_scan(session_id).users_seen == 1
    assert db.get_scan(session_id).edges_seen == 2
    assert sorted(queue._queue) == [("bob", 1), ("carol", 1)]


@pytest.mark.asyncio
async def test_collect_following_returns_rows(db, config, monkeypatch):
    collector = _collector(db, config)
    page = FakePage()

    session_id = db.create_scan_session("alice", 1).id

    async def fake_extract(page):
        return ["bob", "carol", "bob"]

    monkeypatch.setattr(collector, "_extract_dialog_usernames", fake_extract)
    monkeypatch.setattr(collector, "_sleep", lambda: asyncio.sleep(0))
    # mock ensure_user since it's not the focus here
    monkeypatch.setattr(db, "ensure_user", lambda _: None)
    
    rows = await collector._collect_following(page, "alice", session_id)
    assert rows == ["bob", "carol"]
    edges = db.list_edges(source="alice")
    assert len(edges) == 2


@pytest.mark.asyncio
async def test_rate_limited_collect_returns_empty(db, config):
    collector = _collector(db, config)

    class RateLimitedPage(FakePage):
        async def content(self):
            return (
                '<html><body>Log in to Instagram'
                '<form action="/accounts/login/"><input name="username"><input name="password"></form>'
                '</body></html>'
            )

    session_id = db.create_scan_session("alice", 1).id
    rows = await collector._collect_following_with_retry(RateLimitedPage(), "alice", session_id)
    assert rows == []
    errors = db.scan_errors(session_id)
    assert len(errors) == 1
    assert errors[0].error_type == "rate_limited"


@pytest.mark.asyncio
async def test_collect_followers_returns_rows(db, config, monkeypatch):
    collector = _collector(db, config)
    page = FakePage()

    session_id = db.create_scan_session("alice", 1).id

    async def fake_extract(page):
        return ["dave", "eve"]

    monkeypatch.setattr(collector, "_extract_dialog_usernames", fake_extract)
    monkeypatch.setattr(collector, "_sleep", lambda: asyncio.sleep(0))

    rows = await collector._collect_followers(page, "alice", session_id)
    assert rows == ["dave", "eve"]
    edges = db.list_edges(target="alice")
    assert len(edges) >= 1


@pytest.mark.asyncio
async def test_collect_list_does_not_use_arbitrary_network_responses(db, config, monkeypatch):
    collector = _collector(db, config)
    session_id = db.create_scan_session("alice", 1).id

    class StrictPage(FakePage):
        def __init__(self):
            super().__init__()
            self.on_calls = 0

        def on(self, event, callback):
            self.on_calls += 1

    page = StrictPage()

    async def fake_extract(_page):
        return ["bob"]

    monkeypatch.setattr(collector, "_extract_dialog_usernames", fake_extract)
    monkeypatch.setattr(collector, "_sleep", lambda: asyncio.sleep(0))

    rows = await collector._collect_following(page, "alice", session_id, expected_count=1)

    assert rows == ["bob"]
    assert page.on_calls == 0
    assert [(edge.source_user_id, edge.target_user_id) for edge in db.list_edges()] != []


@pytest.mark.asyncio
async def test_collect_list_caps_at_profile_relationship_count(db, config, monkeypatch):
    collector = _collector(db, config)
    session_id = db.create_scan_session("alice", 1).id
    page = FakePage()

    async def fake_extract(_page):
        return ["bob", "carol", "dave"]

    monkeypatch.setattr(collector, "_extract_dialog_usernames", fake_extract)
    monkeypatch.setattr(collector, "_sleep", lambda: asyncio.sleep(0))

    rows = await collector._collect_following(page, "alice", session_id, expected_count=2)

    assert rows == ["bob", "carol"]
    assert len(db.list_edges(source="alice")) == 2
