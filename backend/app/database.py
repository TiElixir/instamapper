"""SQLAlchemy models and persistence helpers for InstaRL."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    event,
    func,
    select,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship

from app.schemas import AccountStatus, RelationshipType, ScanStatus


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    instagram_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    display_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    bio: Mapped[str | None] = mapped_column(Text, nullable=True)
    follower_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    following_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    post_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    is_private: Mapped[bool] = mapped_column(Boolean, default=False)
    website: Mapped[str | None] = mapped_column(Text, nullable=True)
    picture_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default=AccountStatus.AVAILABLE.value)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    snapshots: Mapped[list["UserSnapshot"]] = relationship(back_populates="user")


class UserSnapshot(Base):
    __tablename__ = "user_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    session_id: Mapped[int | None] = mapped_column(ForeignKey("scan_sessions.id"), nullable=True, index=True)
    display_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    bio: Mapped[str | None] = mapped_column(Text, nullable=True)
    follower_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    following_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    post_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    is_private: Mapped[bool] = mapped_column(Boolean, default=False)
    website: Mapped[str | None] = mapped_column(Text, nullable=True)
    picture_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32))
    scanned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    user: Mapped[User] = relationship(back_populates="snapshots")


class Edge(Base):
    __tablename__ = "edges"
    __table_args__ = (
        UniqueConstraint("source_user_id", "target_user_id", "relationship_type", name="uq_edge_direction"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    target_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    relationship_type: Mapped[str] = mapped_column(String(32))
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    observation_count: Mapped[int] = mapped_column(Integer, default=1)


class EdgeSnapshot(Base):
    __tablename__ = "edge_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    edge_id: Mapped[int] = mapped_column(ForeignKey("edges.id"), index=True)
    session_id: Mapped[int | None] = mapped_column(ForeignKey("scan_sessions.id"), nullable=True, index=True)
    source_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    target_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    relationship_type: Mapped[str] = mapped_column(String(32))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ScanSession(Base):
    __tablename__ = "scan_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    target: Mapped[str] = mapped_column(String(255), index=True)
    depth: Mapped[int] = mapped_column(Integer, default=1)
    cookie_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default=ScanStatus.PENDING.value, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    users_seen: Mapped[int] = mapped_column(Integer, default=0)
    edges_seen: Mapped[int] = mapped_column(Integer, default=0)
    errors: Mapped[int] = mapped_column(Integer, default=0)
    checkpoint: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_summary: Mapped[str | None] = mapped_column(Text, nullable=True)


class ScanError(Base):
    __tablename__ = "scan_errors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("scan_sessions.id"), index=True)
    username: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    error_type: Mapped[str] = mapped_column(String(64), index=True)
    message: Mapped[str] = mapped_column(Text)
    details: Mapped[str | None] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


def _set_pragmas(dbapi_conn, _record) -> None:
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


class Database:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(
            f"sqlite:///{self.path}",
            connect_args={"check_same_thread": False},
        )
        event.listen(self.engine, "connect", _set_pragmas)
        Base.metadata.create_all(self.engine)

    # -- lifecycle ------------------------------------------------------
    def session(self) -> Session:
        return Session(self.engine, expire_on_commit=False)

    def create_scan_session(self, target: str, depth: int, cookie_path: str | None = None) -> ScanSession:
        with self.session() as db:
            row = ScanSession(target=target, depth=depth, cookie_path=cookie_path, status=ScanStatus.PENDING.value)
            db.add(row)
            db.commit()
            db.refresh(row)
            return row

    def update_scan(self, session_id: int, **fields: Any) -> None:
        with self.session() as db:
            row = db.get(ScanSession, session_id)
            if row is None:
                raise KeyError(f"scan session {session_id} not found")
            for key, value in fields.items():
                setattr(row, key, value)
            db.commit()

    def get_scan(self, session_id: int) -> ScanSession | None:
        with self.session() as db:
            return db.get(ScanSession, session_id)

    def list_scans(self, limit: int = 100, offset: int = 0) -> list[ScanSession]:
        with self.session() as db:
            stmt = select(ScanSession).order_by(ScanSession.id.desc()).limit(limit).offset(offset)
            return list(db.scalars(stmt))

    def save_checkpoint(self, session_id: int, pending: list[str]) -> None:
        self.update_scan(session_id, checkpoint=json.dumps(pending[:5000]))

    def load_checkpoint(self, session_id: int) -> list[str]:
        row = self.get_scan(session_id)
        if not row or not row.checkpoint:
            return []
        try:
            return json.loads(row.checkpoint)
        except json.JSONDecodeError:
            return []

    # -- users ----------------------------------------------------------
    def upsert_user(self, profile: Any, session_id: int | None = None) -> User:
        """Upsert a user; append an immutable snapshot per scan."""
        username = profile.username.strip().lower()
        with self.session() as db:
            user = None
            if profile.instagram_id:
                user = db.scalar(select(User).where(User.instagram_id == profile.instagram_id))
            if user is None:
                user = db.scalar(select(User).where(func.lower(User.username) == username))
            if user is None:
                user = User(username=username, instagram_id=profile.instagram_id, first_seen_at=utcnow())
                db.add(user)
                db.flush()
            user.username = username
            if profile.instagram_id:
                user.instagram_id = profile.instagram_id
            user.display_name = profile.display_name
            user.bio = profile.bio
            user.follower_count = profile.follower_count
            user.following_count = profile.following_count
            user.post_count = profile.post_count
            user.verified = profile.verified
            user.is_private = profile.is_private
            user.website = profile.website
            user.picture_url = profile.picture_url
            user.category = profile.category
            user.status = profile.status.value
            user.last_seen_at = profile.scanned_at

            snapshot = UserSnapshot(
                user_id=user.id,
                session_id=session_id,
                display_name=profile.display_name,
                bio=profile.bio,
                follower_count=profile.follower_count,
                following_count=profile.following_count,
                post_count=profile.post_count,
                verified=profile.verified,
                is_private=profile.is_private,
                website=profile.website,
                picture_url=profile.picture_url,
                category=profile.category,
                status=profile.status.value,
                scanned_at=profile.scanned_at,
            )
            db.add(snapshot)
            db.commit()
            db.refresh(user)
            return user

    def get_user(self, username: str) -> User | None:
        with self.session() as db:
            stmt = select(User).where(func.lower(User.username) == username.lower())
            return db.scalar(stmt)

    def get_user_by_id(self, user_id: int) -> User | None:
        with self.session() as db:
            return db.get(User, user_id)

    def list_users(self, limit: int = 500, offset: int = 0) -> list[User]:
        with self.session() as db:
            stmt = select(User).order_by(User.username).limit(limit).offset(offset)
            return list(db.scalars(stmt))

    def search_users(self, query: str, limit: int = 50) -> list[User]:
        pattern = f"%{query.lower()}%"
        with self.session() as db:
            stmt = (
                select(User)
                .where(func.lower(User.username).like(pattern))
                .order_by(func.lower(User.username))
                .limit(limit)
            )
            return list(db.scalars(stmt))

    def ensure_user(self, username: str) -> User:
        """Ensure a username exists without requiring profile-page access."""
        canonical = username.strip().lower()
        with self.session() as db:
            user = db.scalar(select(User).where(func.lower(User.username) == canonical))
            if user is None:
                user = User(username=canonical)
                db.add(user)
                db.commit()
                db.refresh(user)
            return user
    def user_snapshots(self, username: str, limit: int = 100) -> list[UserSnapshot]:
        with self.session() as db:
            user = db.scalar(select(User).where(func.lower(User.username) == username.lower()))
            if user is None:
                return []
            stmt = (
                select(UserSnapshot)
                .where(UserSnapshot.user_id == user.id)
                .order_by(UserSnapshot.scanned_at.desc())
                .limit(limit)
            )
            return list(db.scalars(stmt))

    # -- edges ----------------------------------------------------------
    def upsert_edge(self, source: User, target: User, relationship: RelationshipType, session_id: int | None = None) -> Edge:
        with self.session() as db:
            edge = db.scalar(
                select(Edge).where(
                    Edge.source_user_id == source.id,
                    Edge.target_user_id == target.id,
                    Edge.relationship_type == relationship.value,
                )
            )
            existed = edge is not None
            if edge is None:
                edge = Edge(
                    source_user_id=source.id,
                    target_user_id=target.id,
                    relationship_type=relationship.value,
                    first_seen_at=utcnow(),
                    observation_count=1,
                )
                db.add(edge)
                db.flush()
            else:
                edge.observation_count += 1
            edge.last_seen_at = utcnow()
            snapshot = EdgeSnapshot(
                edge_id=edge.id,
                session_id=session_id,
                source_user_id=source.id,
                target_user_id=target.id,
                relationship_type=relationship.value,
                observed_at=utcnow(),
            )
            db.add(snapshot)
            db.commit()
            db.refresh(edge)
            return edge

    def record_edge(self, source_username: str, target_username: str, relationship: RelationshipType | str, session_id: int | None = None) -> tuple[Edge, User, User]:
        """Persist an edge by usernames, creating stub users as needed."""
        if isinstance(relationship, str):
            relationship = RelationshipType(relationship)
        with self.session() as db:
            src = db.scalar(select(User).where(func.lower(User.username) == source_username.lower()))
            if src is None:
                src = User(username=source_username.lower())
                db.add(src)
                db.flush()
            tgt = db.scalar(select(User).where(func.lower(User.username) == target_username.lower()))
            if tgt is None:
                tgt = User(username=target_username.lower())
                db.add(tgt)
                db.flush()
            edge = db.scalar(
                select(Edge).where(
                    Edge.source_user_id == src.id,
                    Edge.target_user_id == tgt.id,
                    Edge.relationship_type == relationship.value,
                )
            )
            existed = edge is not None
            if edge is None:
                edge = Edge(
                    source_user_id=src.id,
                    target_user_id=tgt.id,
                    relationship_type=relationship.value,
                    first_seen_at=utcnow(),
                    observation_count=1,
                )
                db.add(edge)
                db.flush()
            else:
                edge.observation_count += 1
            edge.last_seen_at = utcnow()
            snapshot = EdgeSnapshot(
                edge_id=edge.id,
                session_id=session_id,
                source_user_id=src.id,
                target_user_id=tgt.id,
                relationship_type=relationship.value,
                observed_at=utcnow(),
            )
            db.add(snapshot)
            db.commit()
            return edge, src, tgt

    def list_edges(self, source: str | None = None, target: str | None = None, limit: int = 20000) -> list[Edge]:
        with self.session() as db:
            stmt = select(Edge).limit(limit)
            if source:
                sub = select(User.id).where(func.lower(User.username) == source.lower())
                stmt = stmt.where(Edge.source_user_id.in_(sub))
            if target:
                sub = select(User.id).where(func.lower(User.username) == target.lower())
                stmt = stmt.where(Edge.target_user_id.in_(sub))
            return list(db.scalars(stmt))

    # -- errors ---------------------------------------------------------
    def add_scan_error(self, session_id: int, username: str | None, error_type: str, message: str, details: dict | None = None) -> None:
        with self.session() as db:
            db.add(
                ScanError(
                    session_id=session_id,
                    username=username,
                    error_type=error_type,
                    message=message,
                    details=json.dumps(details) if details else None,
                )
            )
            session = db.get(ScanSession, session_id)
            if session is not None:
                session.errors += 1
                summary = {}
                if session.error_summary:
                    try:
                        summary = json.loads(session.error_summary)
                    except json.JSONDecodeError:
                        summary = {}
                summary[error_type] = summary.get(error_type, 0) + 1
                session.error_summary = json.dumps(summary)
            db.commit()

    def scan_errors(self, session_id: int, limit: int = 100) -> list[ScanError]:
        with self.session() as db:
            stmt = (
                select(ScanError)
                .where(ScanError.session_id == session_id)
                .order_by(ScanError.id.desc())
                .limit(limit)
            )
            return list(db.scalars(stmt))

    def user_snapshot_count(self, user_id: int) -> int:
        with self.session() as db:
            return db.scalar(select(func.count()).select_from(UserSnapshot).where(UserSnapshot.user_id == user_id)) or 0

    def delete_scan(self, session_id: int) -> bool:
        with self.session() as db:
            scan = db.get(ScanSession, session_id)
            if scan is None:
                return False
            db.execute(EdgeSnapshot.__table__.delete().where(EdgeSnapshot.session_id == session_id))
            db.execute(UserSnapshot.__table__.delete().where(UserSnapshot.session_id == session_id))
            db.execute(ScanError.__table__.delete().where(ScanError.session_id == session_id))
            db.delete(scan)
            db.commit()
            return True

    def clear_all_data(self) -> dict[str, int]:
        with self.session() as db:
            counts = {
                "edge_snapshots": db.scalar(select(func.count()).select_from(EdgeSnapshot)) or 0,
                "user_snapshots": db.scalar(select(func.count()).select_from(UserSnapshot)) or 0,
                "scan_errors": db.scalar(select(func.count()).select_from(ScanError)) or 0,
                "edges": db.scalar(select(func.count()).select_from(Edge)) or 0,
                "users": db.scalar(select(func.count()).select_from(User)) or 0,
                "scans": db.scalar(select(func.count()).select_from(ScanSession)) or 0,
            }
            db.execute(EdgeSnapshot.__table__.delete())
            db.execute(UserSnapshot.__table__.delete())
            db.execute(ScanError.__table__.delete())
            db.execute(Edge.__table__.delete())
            db.execute(User.__table__.delete())
            db.execute(ScanSession.__table__.delete())
            db.commit()
            return counts

    def stats(self) -> dict[str, int]:
        with self.session() as db:
            return {
                "users": db.scalar(select(func.count()).select_from(User)) or 0,
                "user_snapshots": db.scalar(select(func.count()).select_from(UserSnapshot)) or 0,
                "edges": db.scalar(select(func.count()).select_from(Edge)) or 0,
                "edge_snapshots": db.scalar(select(func.count()).select_from(EdgeSnapshot)) or 0,
                "scans": db.scalar(select(func.count()).select_from(ScanSession)) or 0,
            }


# Keep a module-level default so API/database tests share one instance easily.
_db_instance: Database | None = None


def get_db(path: str | Path | None = None) -> Database:
    global _db_instance
    if path is not None:
        return Database(path)
    if _db_instance is None:
        from app.config import get_config

        _db_instance = Database(get_config().database_path)
    return _db_instance


def reset_db() -> None:
    global _db_instance
    _db_instance = None
