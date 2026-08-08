import json
from datetime import datetime, timezone

import httpx
import pytest

from app.config import load_config
from app.database import Database
from app.main import create_app
from app.manager import ScanManager
from app.schemas import AccountStatus, RelationshipType, UserProfile


@pytest.fixture
def app_and_db(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(
        json.dumps({"database_path": str(tmp_path / "api.db"), "collector": {"max_workers": 1}}),
        encoding="utf-8",
    )
    config = load_config(cfg_path)
    app = create_app(config=config)
    db = Database(config.database_path)
    app.state.config = config
    app.state.db = db
    app.state.manager = ScanManager(db, config)
    return app, db


def _seed(db: Database, target="alice"):
    session_id = db.create_scan_session(target, 1).id
    db.upsert_user(
        UserProfile(
            username=target,
            instagram_id="1",
            follower_count=5000,
            verified=True,
            status=AccountStatus.AVAILABLE,
            scanned_at=datetime.now(timezone.utc),
        ),
        session_id,
    )
    db.upsert_user(
        UserProfile(
            username="bob",
            instagram_id="2",
            follower_count=100,
            is_private=True,
            status=AccountStatus.AVAILABLE,
            scanned_at=datetime.now(timezone.utc),
        ),
        session_id,
    )
    db.record_edge("alice", "bob", RelationshipType.FOLLOWS, session_id)
    db.record_edge("bob", "alice", RelationshipType.FOLLOWS, session_id)
    db.update_scan(session_id, status="completed")
    return db


def _client(app):
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_health(app_and_db):
    app, _ = app_and_db
    async with _client(app) as client:
        resp = await client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_scan_lifecycle(app_and_db, tmp_path):
    app, db = app_and_db
    async with _client(app) as client:
        resp = await client.post(
            "/scans",
            json={"target": "Alice", "depth": 1, "cookie_path": str(tmp_path / "nope.yaml")},
        )
        assert resp.status_code == 202
        body = resp.json()
        assert body["target"] == "alice"

        listing = (await client.get("/scans")).json()
        assert any(s["id"] == body["scan_id"] for s in listing)

        detail = (await client.get(f"/scans/{body['scan_id']}")).json()
        assert detail["target"] == "alice"

        # the background thread fails fast (missing cookie file) -> failed status
        import time

        for _ in range(50):
            detail = (await client.get(f"/scans/{body['scan_id']}")).json()
            if detail["status"] not in ("pending", "running"):
                break
            time.sleep(0.1)
        assert detail["status"] in ("failed", "completed", "cancelled")


@pytest.mark.asyncio
async def test_cookie_test_endpoint(app_and_db, monkeypatch):
    app, _ = app_and_db

    async def fake_test_cookies(self, cookie_path=None):
        assert cookie_path == "config/cookies.yaml"
        return {"valid": True, "username": "alice", "detail": "logged in as @alice"}

    monkeypatch.setattr("app.api.routes_scans.Collector.test_cookies", fake_test_cookies)
    async with _client(app) as client:
        response = await client.post("/scans/test-cookies", json={"cookie_path": "config/cookies.yaml"})

    assert response.status_code == 200
    assert response.json() == {
        "valid": True,
        "username": "alice",
        "detail": "logged in as @alice",
    }


@pytest.mark.asyncio
async def test_extension_scan_ingests_only_explicit_following_edges(app_and_db):
    app, db = app_and_db
    async with _client(app) as client:
        created = await client.post("/extension/scans", json={"target": "Alice", "depth": 2})
        assert created.status_code == 202
        scan_id = created.json()["scan_id"]

        ingested = await client.post(
            f"/extension/scans/{scan_id}/accounts",
            json={
                "source_username": "Alice",
                "depth": 2,
                "following": [
                    {"username": "Bob", "instagram_id": "2"},
                    {"username": "Bob", "instagram_id": "2"},
                ],
                "pending": [{"username": "bob", "remaining_depth": 1}],
            },
        )
        assert ingested.status_code == 200
        assert ingested.json()["edges"] == 1

        graph = (await client.get("/graph")).json()
        assert {(edge["source"], edge["target"]) for edge in graph["edges"]} == {("alice", "bob")}

        finished = await client.post(f"/extension/scans/{scan_id}/finish", json={"status": "completed"})
        assert finished.status_code == 200
        assert finished.json()["status"] == "completed"


@pytest.mark.asyncio
async def test_extension_depth2_yash_vardhan_rai_creates_over_100_users(app_and_db):
    """Simulate a depth-2 extension capture for yash.vardhan.rai.

    Depth 1 yields a large Following set; a subset is expanded at depth 1
    remaining so the finished graph contains well over 100 user rows.
    """
    app, db = app_and_db
    target = "yash.vardhan.rai"
    depth1_count = 80
    depth2_per_seed = 15
    depth2_seeds = 4  # 1 + 80 + (4 * 15) = 141 unique users

    depth1_following = [
        {"username": f"yv_follow_{index:03d}", "instagram_id": str(1000 + index)}
        for index in range(depth1_count)
    ]
    pending_after_depth1 = [
        {"username": user["username"], "remaining_depth": 1}
        for user in depth1_following[:depth2_seeds]
    ]

    async with _client(app) as client:
        created = await client.post("/extension/scans", json={"target": target, "depth": 2})
        assert created.status_code == 202
        body = created.json()
        assert body["target"] == target
        assert body["depth"] == 2
        scan_id = body["scan_id"]

        root = await client.post(
            f"/extension/scans/{scan_id}/accounts",
            json={
                "source_username": target,
                "depth": 2,
                "following": depth1_following,
                "pending": pending_after_depth1,
            },
        )
        assert root.status_code == 200
        assert root.json()["edges"] == depth1_count

        for seed_index, seed in enumerate(pending_after_depth1):
            seed_following = [
                {
                    "username": f"yv_d2_{seed_index:02d}_{index:03d}",
                    "instagram_id": str(5000 + seed_index * 100 + index),
                }
                for index in range(depth2_per_seed)
            ]
            # Last hop has an empty pending queue, matching extension finishCurrentAccount.
            remaining_pending = pending_after_depth1[seed_index + 1 :]
            hop = await client.post(
                f"/extension/scans/{scan_id}/accounts",
                json={
                    "source_username": seed["username"],
                    "depth": 1,
                    "following": seed_following,
                    "pending": remaining_pending,
                },
            )
            assert hop.status_code == 200
            assert hop.json()["edges"] == depth2_per_seed

        finished = await client.post(
            f"/extension/scans/{scan_id}/finish",
            json={"status": "completed"},
        )
        assert finished.status_code == 200
        summary = finished.json()
        assert summary["status"] == "completed"
        assert summary["target"] == target
        assert summary["depth"] == 2
        assert summary["users_seen"] == 1 + depth2_seeds  # accounts whose Following lists were ingested
        assert summary["edges_seen"] == depth1_count + (depth2_seeds * depth2_per_seed)

        users = (await client.get("/users", params={"limit": 500})).json()
        usernames = {user["username"] for user in users}
        assert target in usernames
        assert len(users) > 100
        assert len(usernames) > 100

        # expected unique users: root + depth1 following + depth2 discoveries
        expected_users = 1 + depth1_count + (depth2_seeds * depth2_per_seed)
        assert len(usernames) == expected_users
        assert expected_users > 100

        graph = (await client.get("/graph", params={"limit_nodes": 500})).json()
        assert graph["node_count"] > 100
        assert graph["edge_count"] == depth1_count + (depth2_seeds * depth2_per_seed)

        stats = db.stats()
        assert stats["users"] > 100
        assert stats["users"] == expected_users
        assert stats["edges"] == depth1_count + (depth2_seeds * depth2_per_seed)


@pytest.mark.asyncio
async def test_users_and_graph_endpoints(app_and_db):
    app, db = app_and_db
    _seed(db)
    async with _client(app) as client:
        users = (await client.get("/users")).json()
        assert len(users) == 2

        alice = (await client.get("/users/alice")).json()
        assert alice["follower_count"] == 5000
        assert alice["verified"] is True
        assert alice["snapshot_count"] == 1

        snapshots = (await client.get("/users/alice/snapshots")).json()
        assert snapshots["count"] == 1

        graph = (await client.get("/graph")).json()
        assert graph["node_count"] == 2
        assert graph["edge_count"] == 2

        filtered = (await client.get("/graph", params={"verified_only": True})).json()
        assert filtered["node_count"] == 1

        hidden = (await client.get("/graph", params={"hide_private": True})).json()
        assert hidden["node_count"] == 1

@pytest.mark.asyncio
async def test_export_endpoints(app_and_db):
    app, db = app_and_db
    _seed(db)
    async with _client(app) as client:
        js = await client.get("/exports/json")
        assert js.status_code == 200
        assert js.headers["content-type"].startswith("application/json")
        payload = js.json()
        assert len(payload["nodes"]) == 2

        csv_resp = await client.get("/exports/csv")
        assert csv_resp.status_code == 200
        assert "node" in csv_resp.text and "edge" in csv_resp.text

        future = await client.get("/exports/graphml")
        assert future.status_code == 501


@pytest.mark.asyncio
async def test_error_responses(app_and_db):
    app, _ = app_and_db
    async with _client(app) as client:
        assert (await client.get("/users/ghost")).status_code == 404
        assert (await client.get("/scans/9999")).status_code == 404


@pytest.mark.asyncio
async def test_delete_scan_and_clear_all_data(app_and_db):
    app, db = app_and_db
    _seed(db)
    second_scan = db.create_scan_session("carol", 1).id

    async with _client(app) as client:
        deleted = await client.delete(f"/scans/{second_scan}")
        assert deleted.status_code == 200
        assert deleted.json() == {"deleted": True, "scan_id": second_scan}
        assert db.get_scan(second_scan) is None

        reset = await client.delete("/scans")
        assert reset.status_code == 200
        assert reset.json()["cleared"] is True
        assert db.stats()["users"] == 0
        assert db.stats()["edges"] == 0
        assert db.stats()["scans"] == 0


@pytest.mark.asyncio
async def test_graph_ignores_legacy_followed_by_edges(app_and_db):
    app, db = app_and_db
    _seed(db)
    session_id = db.list_scans()[0].id
    db.record_edge("alice", "carol", RelationshipType.FOLLOWED_BY, session_id)

    async with _client(app) as client:
        graph = (await client.get("/graph")).json()

    edge_pairs = {(edge["source"], edge["target"]) for edge in graph["edges"]}
    assert ("alice", "carol") not in edge_pairs
    assert edge_pairs == {("alice", "bob"), ("bob", "alice")}
