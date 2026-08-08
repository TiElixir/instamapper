import os
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

os.environ.setdefault("INSTARL_CONFIG", str(Path(__file__).parents[2] / "config" / "config.yaml"))

from app.config import get_config as _get_config  # noqa: E402
from app.config import reload_config  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_config(tmp_path):
    from app import config as config_module

    old = config_module.get_config()
    config_module.get_config.cache_clear()

    db_path = tmp_path / "test.db"
    base = {
        "collector": {
            "headless": True,
            "max_workers": 2,
            "per_action_delay_ms": 0,
            "per_action_jitter_ms": 0,
            "retry_limit": 1,
            "retry_backoff_base_ms": 10,
            "max_following_rows": 50,
            "scan_timeout_seconds": 60,
        },
        "database_path": str(db_path),
        "log_level": "WARNING",
    }
    cfg_path = tmp_path / "config.yaml"
    import yaml

    cfg_path.write_text(yaml.safe_dump(base), encoding="utf-8")
    config_module._DEFAULT_CONFIG_PATH = cfg_path
    config_module.get_config.cache_clear()
    yield config_module.get_config(cfg_path)
    config_module._DEFAULT_CONFIG_PATH = Path(__file__).parents[2] / "config" / "config.yaml"
    config_module.get_config.cache_clear()
