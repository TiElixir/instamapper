"""FastAPI application factory for InstaRL."""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import AppConfig, get_config
from app.database import Database
from app.logging_setup import configure_logging
from app.manager import ScanManager

from app.api import routes_exports, routes_extension, routes_graph, routes_scans, routes_users

configure_logging()


@asynccontextmanager
async def lifespan(app: FastAPI):
    config = getattr(app.state, "_config_override", None) or get_config()
    app.state.config = config
    app.state.db = Database(config.database_path)
    app.state.manager = ScanManager(app.state.db, config)
    yield


def create_app(config: AppConfig | None = None) -> FastAPI:
    app = FastAPI(
        title="InstaRL API",
        version="0.1.0",
        description="Instagram relationship graph OSINT scaffold",
        lifespan=lifespan,
    )
    if config is not None:
        app.state._config_override = config
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_origin_regex=r"^chrome-extension://[a-z0-9]{32}$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health", tags=["meta"])
    async def health() -> dict:
        return {"status": "ok", "version": app.version}

    app.include_router(routes_scans.router)
    app.include_router(routes_extension.router)
    app.include_router(routes_users.router)
    app.include_router(routes_graph.router)
    app.include_router(routes_exports.router)
    return app


app = create_app()
