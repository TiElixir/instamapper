.PHONY: all dev backend frontend install install-backend install-frontend test test-backend test-frontend build stop clean help

BACKEND_DIR   := backend
FRONTEND_DIR  := frontend
VENV_BIN      := .venv/bin
PID_DIR       := .pids

# --- Default -------------------------------------------------------
all: dev

# --- Dev: run both servers in background ---------------------------
dev: $(PID_DIR)
	@echo "Starting backend on :8000 ..."
	@cd $(BACKEND_DIR) && $(VENV_BIN)/python run.py &> ../$(PID_DIR)/backend.log & echo $$! > $(PID_DIR)/backend.pid
	@echo "Starting frontend on :5173 ..."
	@cd $(FRONTEND_DIR) && npm run dev &> ../$(PID_DIR)/frontend.log & echo $$! > $(PID_DIR)/frontend.pid
	@sleep 1
	@echo ""
	@echo "  Backend  -> http://127.0.0.1:8000  (API docs: /docs)"
	@echo "  Frontend -> http://127.0.0.1:5173"
	@echo ""
	@echo "  Logs:  tail -f $(PID_DIR)/backend.log"
	@echo "         tail -f $(PID_DIR)/frontend.log"
	@echo "  Stop:  make stop"

$(PID_DIR):
	@mkdir -p $(PID_DIR)

# --- Run individually -----------------------------------------------
backend:
	cd $(BACKEND_DIR) && $(VENV_BIN)/python run.py

frontend:
	cd $(FRONTEND_DIR) && npm run dev

# --- Stop background servers ----------------------------------------
stop:
	@if [ -f $(PID_DIR)/backend.pid ]; then \
		kill $$(cat $(PID_DIR)/backend.pid) 2>/dev/null || true; \
		rm -f $(PID_DIR)/backend.pid; \
		echo "Backend stopped"; \
	fi
	@if [ -f $(PID_DIR)/frontend.pid ]; then \
		kill $$(cat $(PID_DIR)/frontend.pid) 2>/dev/null || true; \
		rm -f $(PID_DIR)/frontend.pid; \
		echo "Frontend stopped"; \
	fi

# --- Install --------------------------------------------------------
install: install-backend install-frontend

install-backend:
	cd $(BACKEND_DIR) && python3 -m venv .venv && \
		$(VENV_BIN)/pip install -e ".[dev]"

install-frontend:
	cd $(FRONTEND_DIR) && npm install

# --- Tests ----------------------------------------------------------
test: test-backend test-frontend

test-backend:
	cd $(BACKEND_DIR) && $(VENV_BIN)/pytest

test-frontend:
	cd $(FRONTEND_DIR) && npm test -- --run

# --- Build production frontend --------------------------------------
build:
	cd $(FRONTEND_DIR) && npm run build

# --- Clean ----------------------------------------------------------
clean: stop
	rm -rf $(PID_DIR)
	rm -rf $(FRONTEND_DIR)/dist
	find $(BACKEND_DIR) -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

# --- Help -----------------------------------------------------------
help:
	@echo "Usage:"
	@echo "  make              Start both backend + frontend (background)"
	@echo "  make dev          Same as above"
	@echo "  make backend      Run backend only (foreground)"
	@echo "  make frontend     Run frontend only (foreground)"
	@echo "  Extension         Load the extension/ directory at chrome://extensions"
	@echo "  make stop         Stop background servers"
	@echo "  make install      Install backend + frontend dependencies"
	@echo "  make test         Run all tests"
	@echo "  make build        Production build of frontend"
	@echo "  make clean        Stop servers and remove build artifacts"
	@echo "  make help         Show this help"
