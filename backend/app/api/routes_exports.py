"""Export endpoints (JSON and CSV for v1)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse

from app.database import Database
from app.deps import get_database
from app.exports import export_graph_csv, export_graph_json

from app.api.routes_graph import build_graph_payload

router = APIRouter(prefix="/exports", tags=["exports"])


@router.get("/{export_format}")
async def export_graph(
    export_format: str,
    verified_only: bool = Query(default=False),
    hide_private: bool = Query(default=False),
    min_followers: int | None = Query(default=None, ge=0),
    db: Database = Depends(get_database),
) -> PlainTextResponse:
    payload = build_graph_payload(
        db,
        verified_only=verified_only,
        hide_private=hide_private,
        min_followers=min_followers,
    )
    if export_format == "json":
        content = export_graph_json(payload.nodes, payload.edges)
        filename = "instarl-graph.json"
        media_type = "application/json"
    elif export_format == "csv":
        content = export_graph_csv(payload.nodes, payload.edges)
        filename = "instarl-graph.csv"
        media_type = "text/csv"
    elif export_format in ("graphml", "gexf"):
        raise HTTPException(status_code=501, detail=f"{export_format} export is a future extension")
    else:
        raise HTTPException(status_code=422, detail=f"unsupported export format: {export_format}")
    return PlainTextResponse(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
