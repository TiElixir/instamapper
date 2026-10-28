"""Local ingestion endpoints used by the Chrome extension collector."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query

from app.database import Database, utcnow
from app.deps import get_database
from app.logging_setup import get_logger, log_event
from app.schemas import (
    ExtensionAccountIngest,
    ExtensionFinishRequest,
    ScanConfig,
    ScanCreateResponse,
    ScanStatus,
    ScanSummary,
)

router = APIRouter(prefix="/extension", tags=["extension"])
logger = get_logger("instarl.api.extension")


def _summary(scan) -> ScanSummary:
    error_summary = {}
    if scan.error_summary:
        try:
            error_summary = json.loads(scan.error_summary)
        except json.JSONDecodeError:
            error_summary = {}
    pending = 0
    if scan.checkpoint:
        try:
            pending = len(json.loads(scan.checkpoint))
        except json.JSONDecodeError:
            pending = 0
    return ScanSummary(
        id=scan.id,
        target=scan.target,
        depth=scan.depth,
        status=ScanStatus(scan.status),
        started_at=scan.started_at,
        finished_at=scan.finished_at,
        users_seen=scan.users_seen or 0,
        edges_seen=scan.edges_seen or 0,
        errors=sum(error_summary.values()) if error_summary else (scan.errors or 0),
        pending_queue_size=pending,
    )


@router.post("/scans", response_model=ScanCreateResponse, status_code=202)
async def create_extension_scan(cfg: ScanConfig, db: Database = Depends(get_database)) -> ScanCreateResponse:
    target = cfg.target.strip().lower()
    if not target:
        raise HTTPException(status_code=422, detail="target username is required")
    scan = db.create_scan_session(target, cfg.depth, cookie_path=None)
    db.update_scan(scan.id, status=ScanStatus.RUNNING.value, started_at=utcnow())
    log_event(logger, "extension_scan_started", scan_id=scan.id, target=target, depth=cfg.depth)
    return ScanCreateResponse(scan_id=scan.id, status=ScanStatus.RUNNING, target=target, depth=cfg.depth)


@router.get("/scans/pending", response_model=list[ScanSummary])
async def pending_extension_scans(
    limit: int = Query(default=50, ge=1, le=500),
    db: Database = Depends(get_database),
) -> list[ScanSummary]:
    return [
        _summary(scan)
        for scan in db.list_scans(limit=limit)
        if scan.status in (ScanStatus.PENDING.value, ScanStatus.RUNNING.value)
    ]


@router.post("/scans/{scan_id}/accounts")
async def ingest_account(
    scan_id: int,
    payload: ExtensionAccountIngest,
    db: Database = Depends(get_database),
) -> dict:
    scan = db.get_scan(scan_id)
    if scan is None:
        raise HTTPException(status_code=404, detail=f"scan {scan_id} not found")
    if scan.status not in (ScanStatus.PENDING.value, ScanStatus.RUNNING.value):
        raise HTTPException(status_code=409, detail=f"scan {scan_id} is not active")

    source = payload.source_username.strip().lower()
    if not source:
        raise HTTPException(status_code=422, detail="source_username is required")
    db.ensure_user(source)
    if (
        payload.source_instagram_id
        or payload.source_follower_count is not None
        or payload.source_following_count is not None
    ):
        db.update_user_counts(
            source,
            instagram_id=payload.source_instagram_id,
            follower_count=payload.source_follower_count,
            following_count=payload.source_following_count,
        )

    unique_targets = {}
    for relationship in payload.following:
        username = relationship.username.strip().lower()
        if username and username != source:
            unique_targets.setdefault(username, relationship)
            if relationship.follower_count is not None or relationship.following_count is not None or relationship.instagram_id:
                db.update_user_counts(
                    username,
                    instagram_id=relationship.instagram_id,
                    follower_count=relationship.follower_count,
                    following_count=relationship.following_count,
                )

    for username in unique_targets:
        if payload.mode == "followers":
            # A user listed in @source's Followers list follows @source.
            db.record_edge(username, source, relationship="follows", session_id=scan_id)
        else:
            # A user listed in @source's Following list is followed by @source.
            db.record_edge(source, username, relationship="follows", session_id=scan_id)

    if payload.error_type and payload.error_message:
        db.add_scan_error(scan_id, source, payload.error_type, payload.error_message, {"depth": payload.depth})
    db.update_scan(
        scan_id,
        status=ScanStatus.RUNNING.value,
        users_seen=(scan.users_seen or 0) + 1,
        edges_seen=(scan.edges_seen or 0) + len(unique_targets),
        checkpoint=json.dumps([item.model_dump() for item in payload.pending[:5000]]),
    )
    log_event(
        logger,
        "extension_account_ingested",
        scan_id=scan_id,
        username=source,
        edge_count=len(unique_targets),
    )
    return {"accepted": True, "source_username": source, "edges": len(unique_targets)}


@router.post("/scans/{scan_id}/finish", response_model=ScanSummary)
async def finish_extension_scan(
    scan_id: int,
    payload: ExtensionFinishRequest,
    db: Database = Depends(get_database),
) -> ScanSummary:
    scan = db.get_scan(scan_id)
    if scan is None:
        raise HTTPException(status_code=404, detail=f"scan {scan_id} not found")
    if payload.status in (ScanStatus.PENDING, ScanStatus.RUNNING):
        raise HTTPException(status_code=422, detail="finish status must be completed, failed, or cancelled")
    if payload.status is ScanStatus.FAILED and payload.error_message:
        db.add_scan_error(scan_id, scan.target, "extension_failed", payload.error_message)
    db.update_scan(scan_id, status=payload.status.value, finished_at=utcnow(), checkpoint="[]")
    finished = db.get_scan(scan_id)
    log_event(logger, "extension_scan_finished", scan_id=scan_id, status=payload.status.value)
    return _summary(finished)
