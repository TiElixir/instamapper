"""User profile endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from app.database import Database
from app.deps import get_database
from app.schemas import UserOut

router = APIRouter(prefix="/users", tags=["users"])


def _to_user_out(user, snapshot_count: int = 0) -> UserOut:
    return UserOut(
        username=user.username,
        instagram_id=user.instagram_id,
        display_name=user.display_name,
        bio=user.bio,
        follower_count=user.follower_count,
        following_count=user.following_count,
        post_count=user.post_count,
        verified=user.verified,
        is_private=user.is_private,
        website=user.website,
        picture_url=user.picture_url,
        category=user.category,
        status=user.status,
        first_seen_at=user.first_seen_at,
        last_seen_at=user.last_seen_at,
        snapshot_count=snapshot_count,
    )


@router.get("", response_model=list[UserOut])
async def list_users(
    q: str | None = Query(default=None, description="username search"),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: Database = Depends(get_database),
) -> list[UserOut]:
    if q:
        users = db.search_users(q, limit=limit)
    else:
        users = db.list_users(limit=limit, offset=offset)
    return [_to_user_out(user, db.user_snapshot_count(user.id)) for user in users]


@router.get("/{username}", response_model=UserOut)
async def get_user(username: str, db: Database = Depends(get_database)) -> UserOut:
    user = db.get_user(username)
    if user is None:
        raise HTTPException(status_code=404, detail=f"user @{username} not found")
    return _to_user_out(user, db.user_snapshot_count(user.id))


@router.get("/{username}/snapshots")
async def user_snapshots(
    username: str,
    limit: int = Query(default=50, ge=1, le=500),
    db: Database = Depends(get_database),
) -> dict:
    snapshots = db.user_snapshots(username, limit=limit)
    return {
        "username": username,
        "count": len(snapshots),
        "snapshots": [
            {
                "id": snap.id,
                "session_id": snap.session_id,
                "display_name": snap.display_name,
                "bio": snap.bio,
                "follower_count": snap.follower_count,
                "following_count": snap.following_count,
                "post_count": snap.post_count,
                "verified": snap.verified,
                "is_private": snap.is_private,
                "status": snap.status,
                "scanned_at": snap.scanned_at.isoformat() if snap.scanned_at else None,
            }
            for snap in snapshots
        ],
    }
