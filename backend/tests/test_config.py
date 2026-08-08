import yaml

from app.config import AppConfig, load_config


def test_load_config_with_defaults(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(
        yaml.safe_dump(
            {
                "collector": {"max_workers": 5, "headless": False},
                "database_path": str(tmp_path / "data" / "x.db"),
            }
        ),
        encoding="utf-8",
    )
    cfg = load_config(cfg_path)
    assert cfg.collector.max_workers == 5
    assert cfg.collector.headless is False
    assert cfg.collector.retry_limit == 3  # default preserved
    assert cfg.scan_defaults.depth == 1
    assert cfg.database_path == (tmp_path / "data" / "x.db").resolve()


def test_load_config_missing_file_uses_defaults(tmp_path):
    cfg = load_config(tmp_path / "does-not-exist.yaml")
    assert cfg.collector.max_workers >= 1
    assert cfg.database_path.name == "instarl.db"


def test_scan_defaults_override():
    cfg = AppConfig.model_validate({"scan_defaults": {"depth": 2}, "collector": {"max_workers": 4}})
    assert cfg.scan_defaults.depth == 2
    assert cfg.collector.max_workers == 4
