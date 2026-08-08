from datetime import datetime, timezone

import pytest

from app.database import Database
from app.schemas import AccountStatus, RelationshipType, UserProfile


@pytest.fixture
def db(tmp_path):
    return Database(tmp_path / "test.db")


def _profile(username, instagram_id=None, followers=100, **kw):
    return UserProfile(
        username=username,
        instagram_id=instagram_id,
        follower_count=followers,
        status=AccountStatus.AVAILABLE,
        scanned_at=datetime.now(timezone.utc),
        **kw,
    )


def test_upsert_user_and_snapshot_history(db):
    session_id = db.create_scan_session("alice", 1).id
    user1 = db.upsert_user(_profile("alice", "111", followers=100), session_id)
    user2 = db.upsert_user(_profile("alice", "111", followers=200), session_id)
    assert user1.id == user2.id
    assert user2.follower_count == 200
    snapshots = db.user_snapshots("alice")
    assert len(snapshots) == 2
    counts = sorted(s.follower_count for s in snapshots)
    assert counts == [100, 200]


def test_username_change_preserved_by_instagram_id(db):
    session_id = db.create_scan_session("oldname", 1).id
    db.upsert_user(_profile("oldname", "999"), session_id)
    db.upsert_user(_profile("newname", "999"), session_id)
    # same instagram id -> single row, canonical username updated
    users = db.list_users()
    assert len(users) == 1
    assert users[0].username == "newname"
    assert users[0].instagram_id == "999"


def test_record_edge_and_counts(db):
    session_id = db.create_scan_session("alice", 1).id
    edge, src, tgt = db.record_edge("alice", "bob", RelationshipType.FOLLOWS, session_id)
    assert src.username == "alice"
    assert tgt.username == "bob"
    assert edge.observation_count == 1
    edge2, _, _ = db.record_edge("alice", "bob", RelationshipType.FOLLOWS, session_id)
    assert edge2.id == edge.id
    assert edge2.observation_count == 2
    snapshots = db.user_snapshots("bob")
    assert len(snapshots) == 0  # stub users are not profile-scanned


def test_snapshot_rows_are_append_only(db):
    session_id = db.create_scan_session("alice", 1).id
    db.upsert_user(_profile("alice", followers=100), session_id)
    db.upsert_user(_profile("alice", followers=200), session_id)
    db.record_edge("alice", "bob", RelationshipType.FOLLOWS, session_id)
    db.record_edge("alice", "bob", RelationshipType.FOLLOWS, session_id)
    with db.session() as s:
        from app.database import EdgeSnapshot, UserSnapshot

        user_snaps = list(s.query(UserSnapshot).order_by(UserSnapshot.id).all())
        assert len(user_snaps) == 2
        # historical rows keep their original observed values
        assert user_snaps[0].follower_count == 100
        assert user_snaps[1].follower_count == 200
        edge_snaps = list(s.query(EdgeSnapshot).all())
        assert len(edge_snaps) == 2
        assert edge_snaps[0].relationship_type == "follows"


def test_scan_errors_and_summary(db):
    session_id = db.create_scan_session("alice", 1).id
    db.add_scan_error(session_id, "bob", "private", "account is private")
    db.add_scan_error(session_id, "carol", "rate_limited", "too fast")
    scan = db.get_scan(session_id)
    assert scan.errors == 2
    import json

    assert json.loads(scan.error_summary) == {"private": 1, "rate_limited": 1}
    errors = db.scan_errors(session_id)
    assert len(errors) == 2


def test_checkpoint_roundtrip(db):
    session_id = db.create_scan_session("alice", 1).id
    db.save_checkpoint(session_id, ["bob", "carol"])
    assert db.load_checkpoint(session_id) == ["bob", "carol"]


def test_clear_all_data_removes_graph_and_scan_history(db):
    session_id = db.create_scan_session("alice", 1).id
    db.upsert_user(_profile("alice"), session_id)
    db.upsert_user(_profile("bob"), session_id)
    db.record_edge("alice", "bob", RelationshipType.FOLLOWS, session_id)
    db.add_scan_error(session_id, "bob", "private", "account is private")

    deleted = db.clear_all_data()

    assert deleted["users"] == 2
    assert deleted["edges"] == 1
    assert deleted["scans"] == 1
    assert db.stats() == {
        "users": 0,
        "user_snapshots": 0,
        "edges": 0,
        "edge_snapshots": 0,
        "scans": 0,
    }


def test_delete_scan_removes_only_its_history_rows(db):
    first_scan = db.create_scan_session("alice", 1).id
    second_scan = db.create_scan_session("bob", 1).id
    db.upsert_user(_profile("alice"), first_scan)
    db.upsert_user(_profile("bob"), second_scan)
    db.record_edge("alice", "bob", RelationshipType.FOLLOWS, first_scan)
    db.add_scan_error(first_scan, "alice", "private", "not accessible")

    assert db.delete_scan(first_scan) is True
    assert db.get_scan(first_scan) is None
    assert db.get_scan(second_scan) is not None
    assert db.scan_errors(first_scan) == []
    assert db.stats()["scans"] == 1
