"""Background manager for the legacy cookie-based collector."""
from __future__ import annotations

import asyncio
import threading

from app.collector import Collector
from app.config import AppConfig
from app.database import Database
from app.schemas import ScanConfig, ScanStatus
from app.logging_setup import get_logger


class ScanManager:
    def __init__(self, db: Database, config: AppConfig):
        self.db = db
        self.config = config
        self.logger = get_logger("instarl.manager")
        self._threads: dict[int, threading.Thread] = {}
        self._collectors: dict[int, Collector] = {}

    def start(self, cfg: ScanConfig) -> int:
        session_id = self.db.create_scan_session(cfg.target, cfg.depth, cfg.cookie_path).id
        collector = Collector(self.db, self.config)
        self._collectors[session_id] = collector
        thread = threading.Thread(target=self._run, args=(collector, cfg, session_id), daemon=True, name=f"scan-{session_id}")
        self._threads[session_id] = thread
        thread.start()
        return session_id

    def _run(self, collector: Collector, cfg: ScanConfig, session_id: int) -> None:
        try:
            asyncio.run(
                collector.run_scan(
                    cfg.target,
                    depth=cfg.depth,
                    cookie_path=cfg.cookie_path,
                    resume=cfg.resume,
                    session_id=session_id,
                )
            )
        except Exception as exc:  # noqa: BLE001 - reported via scan status/errors
            self.logger.error("scan thread crashed", exc_info=exc)
            self.db.update_scan(session_id, status=ScanStatus.FAILED.value)
        finally:
            self._threads.pop(session_id, None)
            self._collectors.pop(session_id, None)

    def cancel(self, session_id: int) -> bool:
        collector = self._collectors.get(session_id)
        if collector is None:
            return False
        collector.cancel()
        return True

    def cancel_and_wait(self, session_id: int, timeout: float = 10.0) -> bool:
        """Cancel an active scan and wait until its worker thread has stopped."""
        self.cancel(session_id)
        thread = self._threads.get(session_id)
        if thread is None:
            return True
        if thread is threading.current_thread():
            return False
        thread.join(timeout=timeout)
        return not thread.is_alive()

    def is_running(self, session_id: int) -> bool:
        thread = self._threads.get(session_id)
        return thread is not None and thread.is_alive()
