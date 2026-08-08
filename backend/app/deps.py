"""FastAPI dependency providers."""
from __future__ import annotations

from fastapi import Depends, Request

from app.config import AppConfig, get_config
from app.database import Database, get_db
from app.manager import ScanManager


async def get_app_config(request: Request) -> AppConfig:
    return request.app.state.config


async def get_database(request: Request) -> Database:
    return request.app.state.db


async def get_scan_manager(request: Request) -> ScanManager:
    return request.app.state.manager
