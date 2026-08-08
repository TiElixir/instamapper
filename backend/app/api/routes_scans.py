"""Scan lifecycle endpoints."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from app.collector import Collector
from app.config import AppConfig
from app.database import Database
from app.deps import get_app_config, get_database, get_scan_manager
from app.manager import ScanManager
from app.schemas import (
    CookieTestRequest,
    CookieTestResponse,
    ScanConfig,
    ScanCreateResponse,
    ScanDetail,
    ScanStatus,
    ScanSummary,
)
from app.logging_setup import get_logger

router = APIRouter(prefix="/scans", tags=["scans"])
logger = get_logger("instarl.api.scans")


def _to_summary(scan) -> ScanSummary:
    error_summary = {}
    if scan.error_summary:
        try:
            error_summary = json.loads(scan.error_summary)
        except json.JSONDecodeError:
            error_summary = {}

    pending_queue_size = 0
    if scan.checkpoint:
        try:
            checkpoint = json.loads(scan.checkpoint)
            pending_queue_size = len(checkpoint)
        except json.JSONDecodeError:
            pass

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
        pending_queue_size=pending_queue_size,
    )


@router.post("", response_model=ScanCreateResponse, status_code=202)
async def create_scan(
    cfg: ScanConfig,
    db: Database = Depends(get_database),
    manager: ScanManager = Depends(get_scan_manager),
    app_config: AppConfig = Depends(get_app_config),
) -> ScanCreateResponse:
    target = cfg.target.strip().lower()
    if not target:
        raise HTTPException(status_code=422, detail="target username is required")
    depth = cfg.depth or app_config.scan_defaults.depth
    effective = cfg.model_copy(update={"target": target, "depth": depth})
    scan_id = manager.start(effective)
    logger.info("scan created", extra={"scan_id": scan_id, "target": target, "depth": depth})
    return ScanCreateResponse(scan_id=scan_id, status=ScanStatus.PENDING, target=target, depth=depth)


@router.post("/test-cookies", response_model=CookieTestResponse)
async def test_cookies(
    request: CookieTestRequest,
    db: Database = Depends(get_database),
    app_config: AppConfig = Depends(get_app_config),
) -> CookieTestResponse:
    result = await Collector(db, app_config).test_cookies(request.cookie_path)
    logger.info("cookie test completed", extra={"valid": result["valid"]})
    return CookieTestResponse(**result)


@router.get("", response_model=list[ScanSummary])
async def list_scans(
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Database = Depends(get_database),
) -> list[ScanSummary]:
    return [_to_summary(scan) for scan in db.list_scans(limit=limit, offset=offset)]


@router.get("/{scan_id}", response_model=ScanDetail)
async def get_scan(
    scan_id: int,
    db: Database = Depends(get_database),
) -> ScanDetail:
    scan = db.get_scan(scan_id)
    if scan is None:
        raise HTTPException(status_code=404, detail=f"scan {scan_id} not found")
    error_summary: dict[str, int] = {}
    if scan.error_summary:
        try:
            error_summary = json.loads(scan.error_summary)
        except json.JSONDecodeError:
            error_summary = {}
    recent_errors = [
        {
            "id": err.id,
            "username": err.username,
            "error_type": err.error_type,
            "message": err.message,
            "occurred_at": err.occurred_at.isoformat() if err.occurred_at else None,
        }
        for err in db.scan_errors(scan_id, limit=50)
    ]
    return ScanDetail(
        id=scan.id,
        target=scan.target,
        depth=scan.depth,
        status=ScanStatus(scan.status),
        started_at=scan.started_at,
        finished_at=scan.finished_at,
        users_seen=scan.users_seen or 0,
        edges_seen=scan.edges_seen or 0,
        errors=sum(error_summary.values()) if error_summary else scan.errors or 0,
        error_summary=error_summary,
        recent_errors=recent_errors,
    )


@router.post("/{scan_id}/cancel", response_model=ScanDetail)
async def cancel_scan(
    scan_id: int,
    db: Database = Depends(get_database),
    manager: ScanManager = Depends(get_scan_manager),
) -> ScanDetail:
    scan = db.get_scan(scan_id)
    if scan is None:
        raise HTTPException(status_code=404, detail=f"scan {scan_id} not found")
    if scan.status in (ScanStatus.COMPLETED.value, ScanStatus.FAILED.value, ScanStatus.CANCELLED.value):
        raise HTTPException(status_code=409, detail=f"scan {scan_id} already finished")
    if manager.cancel(scan_id):
        return await get_scan(scan_id, db)
    if scan.status in (ScanStatus.PENDING.value, ScanStatus.RUNNING.value):
        db.update_scan(scan_id, status=ScanStatus.CANCELLED.value, finished_at=datetime.now(timezone.utc))
        return await get_scan(scan_id, db)
    raise HTTPException(status_code=409, detail=f"scan {scan_id} is not running")


@router.delete("/{scan_id}", status_code=200)
async def delete_scan(
    scan_id: int,
    db: Database = Depends(get_database),
    manager: ScanManager = Depends(get_scan_manager),
) -> dict:
    scan = db.get_scan(scan_id)
    if scan is None:
        raise HTTPException(status_code=404, detail=f"scan {scan_id} not found")
    if manager.is_running(scan_id) and not manager.cancel_and_wait(scan_id):
        raise HTTPException(status_code=409, detail="scan is still stopping; try again shortly")
    deleted = db.delete_scan(scan_id)
    if not deleted:
        raise HTTPException(status_code=500, detail="failed to delete scan")
    logger.info("scan deleted", extra={"scan_id": scan_id})
    return {"deleted": True, "scan_id": scan_id}


@router.delete("", status_code=200)
async def clear_all_data(
    db: Database = Depends(get_database),
    manager: ScanManager = Depends(get_scan_manager),
) -> dict:
    running_scan_ids = [
        scan.id
        for scan in db.list_scans(limit=1000)
        if manager.is_running(scan.id)
    ]
    for scan_id in running_scan_ids:
        if not manager.cancel_and_wait(scan_id):
            raise HTTPException(
                status_code=409,
                detail=f"scan {scan_id} is still stopping; try clearing again shortly",
            )
    counts = db.clear_all_data()
    logger.info("all data cleared", extra={"counts": counts})
    return {"cleared": True, "deleted_counts": counts}
