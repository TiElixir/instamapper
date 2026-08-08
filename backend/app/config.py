"""Application configuration loaded from YAML with environment overrides."""
from __future__ import annotations

import os
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, field_validator

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_PATH = REPO_ROOT / "config" / "config.yaml"

_DEFAULTS: dict[str, Any] = {
    "headless": True,
    "max_workers": 3,
    "per_action_delay_ms": 1500,
    "per_action_jitter_ms": 500,
    "retry_limit": 3,
    "retry_backoff_base_ms": 2000,
    "max_following_rows": 500,
    "depth": 1,
    "max_pages_per_user": 50,
    "database_path": str(REPO_ROOT / "data" / "instarl.db"),
    "scan_timeout_seconds": 180,
    "browser": "chromium",
    "user_agent": None,
    "proxy": None,
    "log_level": "INFO",
}


class RateLimit(BaseModel):
    per_action_delay_ms: int = Field(default=1500, ge=0)
    per_action_jitter_ms: int = Field(default=500, ge=0)


class CollectorConfig(BaseModel):
    headless: bool = True
    max_workers: int = Field(default=3, ge=1, le=16)
    retry_limit: int = Field(default=3, ge=0)
    retry_backoff_base_ms: int = Field(default=2000, ge=0)
    max_following_rows: int = Field(default=500, ge=1)
    max_pages_per_user: int = Field(default=50, ge=1)
    browser: Literal["chromium", "firefox", "webkit"] = "chromium"
    user_agent: str | None = None
    proxy: str | None = None
    rate_limit: RateLimit = Field(default_factory=RateLimit)
    scan_timeout_seconds: int = Field(default=180, ge=30)


class ScanDefaults(BaseModel):
    depth: int = Field(default=1, ge=1, le=3)
    resume: bool = True


class AppConfig(BaseModel):
    collector: CollectorConfig = Field(default_factory=CollectorConfig)
    scan_defaults: ScanDefaults = Field(default_factory=ScanDefaults)
    database_path: Path = Field(default_factory=lambda: REPO_ROOT / "data" / "instarl.db")
    log_level: str = "INFO"

    @field_validator("database_path", mode="before")
    @classmethod
    def _expand_path(cls, value: str | Path) -> Path:
        return Path(os.path.expandvars(os.path.expanduser(str(value)))).resolve()


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def load_config(path: str | Path = DEFAULT_CONFIG_PATH) -> AppConfig:
    """Load YAML config, merging defaults so missing keys never crash startup."""
    data = _deep_merge(_DEFAULTS, {})
    raw_path = Path(path)
    if raw_path.exists():
        with open(raw_path, "r", encoding="utf-8") as fh:
            user_cfg = yaml.safe_load(fh) or {}
        data = _deep_merge(data, user_cfg)
    return AppConfig.model_validate(data)


@lru_cache(maxsize=1)
def get_config(path: str | Path = DEFAULT_CONFIG_PATH) -> AppConfig:
    return load_config(path)


def reload_config(path: str | Path = DEFAULT_CONFIG_PATH) -> AppConfig:
    """Drop the cached config and reload (used by tests)."""
    get_config.cache_clear()
    return get_config(path)


_lock = threading.Lock()


def get_config_threadsafe(path: str | Path = DEFAULT_CONFIG_PATH) -> AppConfig:
    with _lock:
        return get_config(path)
