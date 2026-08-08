# InstaRL — Instagram Relationship Graph OSINT Scaffold

InstaRL is a local-first scaffold for collecting and visualising relationship graphs from an authenticated Instagram session. Its main purpose is to build a durable SQLite database of users and directed relationships, preserve scan history, and explore the resulting graph in a React frontend.

> **Responsible use:** only collect data your authenticated session is authorized to view. Do not automate login, store credentials, bypass access controls, or scrape private/unavailable content. Instagram UI and terms can change; review applicable policies before use.

## Architecture

```text
Logged-in Chrome tab + InstaRL extension
                  ↓
        Following response capture
                  ↓
       FastAPI → SQLite snapshots
                  ↓
        React + Cytoscape frontend
```

### Backend

- Python 3.12+ package under `backend/app/`
- FastAPI + SQLAlchemy + SQLite
- Chrome Manifest V3 extension using the authenticated browser tab
- Network response capture is restricted to explicit Following-list activity
- Versioned relationship snapshots so historical scans are not lost
- JSON/CSV export endpoints
- Structured JSON logs for scan/error/skip events

### Frontend

- Vite + React + TypeScript under `frontend/`
- Cytoscape.js graph with searchable nodes, follower-based node sizing, verified borders, private opacity, status shapes, relationship arrows, scan history, filters, and dark mode

## Quickstart

### 1. Backend environment

```bash
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install -e ".[dev]"
```

Configure scan behaviour in `config/config.yaml`. The default database is `data/instarl.db`.

Start the API:

```bash
cd backend
.venv/bin/python run.py
```

API docs: `http://127.0.0.1:8000/docs`

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

The Vite dev server proxies `/api/*` to `http://127.0.0.1:8000/*`. For another API location, set `VITE_API_URL`.

## Frontend Usage

Start the backend before opening the frontend. The frontend reads graph and scan data from the FastAPI server; it does not contain a separate database.

```bash
# Terminal 1 — API
cd backend
.venv/bin/python run.py

# Terminal 2 — frontend
cd frontend
npm run dev
```

Open `http://127.0.0.1:5173` in a browser.

### Build the database with the browser extension

1. Load `extension/` as an unpacked extension from `chrome://extensions` with Developer mode enabled.
2. Open Instagram in Chrome and confirm that the session is logged in.
3. Open the InstaRL extension popup and enter the API URL, starting username, and depth.
4. Click **Start capture**. The extension uses the active Instagram tab and captures only Following-list response traffic.
5. Open each requested profile's **Following** list when the extension navigates there. At depth `2`, it queues the discovered accounts for the next level.
6. Watch **Scan History** for progress, users discovered, edges recorded, and recoverable errors.

The extension writes users and relationships incrementally. Private, unavailable, or inaccessible accounts are recorded as errors instead of creating guessed edges. Cookies, headers, passwords, and raw response bodies are never sent to the backend.

### Explore the graph

1. Open the **Graph** tab after a scan has stored data.
2. Search for a username with **Search nodes**. Matching nodes are highlighted and the view zooms toward them.
3. Click a node to view its stored profile details in the right sidebar.
4. Use the sidebar filters to show only verified accounts, hide private accounts, or set a minimum follower count.
5. Use the relationship toggle to include reverse relationship observations when those records exist.
6. Use the **JSON** or **CSV** buttons to export the currently stored graph.
7. Use the moon/sun button in the header to switch dark mode. The preference is saved locally in the browser.

### What the graph means

- Each circle/shape is a stored Instagram account.
- Node size is based on the latest follower count in the database.
- An arrow from `A` to `B` means the scan observed that `A` follows `B`.
- Verified accounts have a blue border.
- Private accounts are shown with reduced opacity unless hidden by a filter.
- A diamond indicates an unavailable account state.

If the graph is empty, check that the API is running, that the extension is attached to the correct Instagram tab, and that the scan completed. Reload the page after a completed scan if the graph was already open.

## Browser extension permissions

The extension requires the Chrome `debugger` permission because Chrome's normal request observer does not expose response bodies. It is restricted by its manifest to Instagram and the local API. Keep it installed locally, disable it when not collecting, and never distribute a build with additional host permissions.

## API highlights

- `POST /extension/scans` — start an extension-driven scan
- `POST /extension/scans/{id}/accounts` — ingest one explicit Following-list observation
- `POST /extension/scans/{id}/finish` — finish an extension scan
- `GET /scans` and `GET /scans/{id}` — scan history, progress, errors, and counts
- `GET /users` and `GET /users/{username}` — current profile records
- `GET /users/{username}/snapshots` — immutable profile history
- `GET /graph` — graph data with `verified_only`, `hide_private`, `min_followers`, `depth`, and relationship filters
- `GET /exports/json` and `GET /exports/csv` — current graph exports

Example scan request:

```bash
curl -X POST http://127.0.0.1:8000/scans \
  -H 'Content-Type: application/json' \
  -d '{"target":"example_user","depth":1}'
```

## Tests and builds

```bash
cd backend
.venv/bin/python -m pytest

cd ../frontend
npm test
npm run build
```

The scaffold includes backend unit/API/collector tests and frontend formatter/app tests. Real Instagram collection requires Chrome, the locally loaded extension, and a valid authenticated Instagram session.

## Data model

SQLite tables:

- `users` — stable current identity and lookup fields
- `user_snapshots` — immutable profile values per scan
- `edges` — stable directed relationship records
- `edge_snapshots` — immutable relationship observations per scan
- `scan_sessions` — lifecycle, progress, checkpoint, and error summary
- `scan_errors` — structured recoverable errors by account/session

Username changes are reconciled by Instagram ID when available; otherwise the canonical username is used.

## Extension points

Neo4j, scheduled rescans, GraphML/GEXF export, richer relationship types, and richer extension status reporting remain extension points.
