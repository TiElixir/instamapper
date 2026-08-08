# InstaRL

> Local-first Instagram relationship graph collector and explorer.

InstaRL turns explicit Instagram **Following** observations into a searchable relationship graph. It pairs a local Chrome extension collector with a FastAPI + SQLite backend and a React/Cytoscape frontend, so you can capture relationships from an authenticated browser session, preserve scan history, and explore the resulting network visually.

![Python](https://img.shields.io/badge/Python-3.12%2B-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.111%2B-009688?logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Chrome Extension](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)

## Responsible use

Use InstaRL only with accounts, sessions, and data you are authorized to access. The project is designed for local, defensive, educational, and OSINT-style analysis of relationship data visible to your own authenticated Instagram session.

Do not use it to bypass access controls, automate login, harvest private content, evade platform restrictions, or collect data in violation of applicable laws, policies, or terms of service. Instagram can rate limit, challenge, or change UI/API behavior at any time.

## What it does

- Captures Instagram Following relationships from a real logged-in Chrome tab.
- Stores normalized users and directed `A follows B` edges in local SQLite.
- Preserves scan sessions, checkpoints, edge snapshots, and recoverable errors.
- Supports depth-based expansion where discovered users can become the next queue level.
- Uses both network response parsing and DOM scraping so visible rows can still be ingested when one source fails.
- Displays the graph in a polished React frontend with search, filters, dark mode, scan history, exports, and node details.
- Highlights search hits plus their 1-hop neighbors for easier graph navigation.
- Exports the current graph as JSON or CSV.

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│ Logged-in Chrome tab on instagram.com                       │
│  └─ InstaRL Manifest V3 extension                           │
│     ├─ opens profile Following lists                        │
│     ├─ captures Following network responses                 │
│     └─ scrapes visible Following dialog/profile links        │
└───────────────────────────────┬─────────────────────────────┘
                                │ normalized usernames + edges
                                ▼
┌─────────────────────────────────────────────────────────────┐
│ FastAPI backend                                              │
│  ├─ extension ingest endpoints                              │
│  ├─ scan lifecycle + checkpoint state                       │
│  ├─ SQLite persistence                                      │
│  └─ graph/export APIs                                       │
└───────────────────────────────┬─────────────────────────────┘
                                │ graph JSON
                                ▼
┌─────────────────────────────────────────────────────────────┐
│ React + TypeScript frontend                                 │
│  └─ Cytoscape graph explorer                                │
└─────────────────────────────────────────────────────────────┘
```

## Repository layout

```text
.
├── backend/              # FastAPI app, SQLite models, APIs, tests
├── config/               # Local scan/database configuration
├── data/                 # Local SQLite databases (gitignored)
├── extension/            # Chrome Manifest V3 collector
├── frontend/             # Vite + React + TypeScript graph UI
├── Makefile              # Common install/dev/test/build commands
└── README.md
```

## Requirements

- Python 3.12+
- Node.js and npm
- Google Chrome or Chromium
- An Instagram account/session that can view the profiles you intend to inspect

## Quickstart

### 1. Install dependencies

From the repository root:

```bash
make install
```

Or install each side manually:

```bash
# Backend
cd backend
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"

# Frontend
cd ../frontend
npm install
```

### 2. Start the app

Run both servers in the background:

```bash
make dev
```

This starts:

- Backend API: `http://127.0.0.1:8000`
- API docs: `http://127.0.0.1:8000/docs`
- Frontend: `http://127.0.0.1:5173`

Stop background servers with:

```bash
make stop
```

You can also run them separately:

```bash
make backend
make frontend
```

## Configuration

Default scan settings live in [config/config.yaml](config/config.yaml):

```yaml
database_path: ../data/instarl.db
scan_defaults:
  depth: 1
  resume: true
collector:
  max_following_rows: 500
  scan_timeout_seconds: 180
```

The default database is stored at [data/instarl.db](data/instarl.db). Local databases, cookies, logs, PID files, caches, and build artifacts are ignored by Git.

## Chrome extension setup

The extension is the recommended collector because it uses your already-authenticated browser tab instead of automating login.

1. Start the backend: `make backend` or `make dev`.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the [extension/](extension/) folder.
6. Open Instagram in Chrome and confirm you are logged in.
7. Open the InstaRL extension popup.
8. Enter:
   - API URL: `http://127.0.0.1:8000`
   - Starting username
   - Scan depth
9. Click **Start capture**.

The extension will navigate through queued profiles, open each profile's **Following** list, scroll it, capture discovered users, and send normalized relationship batches to the backend.

After changing extension code, always reload the unpacked extension from `chrome://extensions` and hard-refresh the Instagram tab. Old service workers can stay alive and make it look like fixes did not apply.

## How collection works

For every profile being scanned, InstaRL records edges from the **current source account** to the accounts found in that source account's Following list.

Example:

```text
A follows B
B follows C
C follows D
```

The graph stores:

```text
A → B
B → C
C → D
```

It does **not** flatten deeper discoveries into direct edges from the original target.

The browser collector uses two independent capture sources:

1. **Network capture** — the Chrome `debugger` API reads relevant Instagram Following/GraphQL response bodies during explicit Following-list activity.
2. **DOM capture** — the content script scrapes visible profile links from the Following UI while it scrolls.

Either source can contribute users. The backend receives only normalized usernames/IDs and relationship edges; cookies, passwords, headers, and raw response bodies are not sent to the API.

## Using the graph explorer

Open `http://127.0.0.1:5173` after starting the backend and frontend.

The UI lets you:

- View scan progress and history.
- Search usernames in the graph.
- Highlight matching nodes and their 1st-degree neighbors.
- Click a node to inspect stored profile details.
- Filter by verified status, private status, follower count, depth, and relationship direction.
- Toggle dark mode.
- Export graph data as JSON or CSV.

Graph semantics:

- Each node is an Instagram account stored in SQLite.
- Each directed edge `A → B` means InstaRL observed `A` following `B`.
- Node size reflects the latest stored follower count when available.
- Verified accounts use a stronger visual border.
- Private/unavailable accounts are visually distinguished and can be filtered.

## API highlights

Extension-driven scan endpoints:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/extension/scans` | Start a browser-extension scan |
| `GET` | `/extension/scans/pending` | List active extension scans |
| `POST` | `/extension/scans/{id}/accounts` | Ingest one source account's Following observations |
| `POST` | `/extension/scans/{id}/finish` | Mark an extension scan completed, failed, or cancelled |

Graph/data endpoints:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/scans` | Scan history |
| `GET` | `/scans/{id}` | Scan details, counts, and errors |
| `GET` | `/users` | Stored users |
| `GET` | `/users/{username}` | User detail |
| `GET` | `/users/{username}/snapshots` | Historical snapshots for a user |
| `GET` | `/graph` | Graph nodes and edges |
| `GET` | `/exports/json` | JSON export |
| `GET` | `/exports/csv` | CSV export |

Example extension scan request:

```bash
curl -X POST http://127.0.0.1:8000/extension/scans \
  -H 'Content-Type: application/json' \
  -d '{"target":"example_user","depth":1}'
```

## Testing

Run everything:

```bash
make test
```

Run backend tests only:

```bash
cd backend
.venv/bin/pytest
```

Run frontend tests only:

```bash
cd frontend
npm test -- --run
```

Build the frontend:

```bash
make build
```

## Troubleshooting

### Following list is blank in Instagram

If the Following list is visually blank even with the extension disabled, the issue is likely Instagram-side: a soft rate limit, challenge/checkpoint, session restriction, or temporary UI/API behavior. Pause collection, use Instagram normally, and try again later.

A `302` response when requesting a Following route can indicate a redirect to login, challenge, checkpoint, or another restriction page. Inspect the `Location` header to confirm the destination.

### Capture scrolls but records zero users

- Reload the unpacked extension from `chrome://extensions`.
- Hard-refresh the Instagram tab.
- Confirm the popup is attached to the correct tab.
- Confirm the backend is running at the configured API URL.
- Watch the popup status for DOM capture counts such as `via DOM`.
- Inspect the extension service worker console for response parsing errors.

### Extension opens the wrong control

Instagram profiles can show a relationship button labeled **Following** when you already follow the account. InstaRL attempts to distinguish that CTA from the actual profile Following count/list control. If Instagram changes the DOM again, reload the extension, hard-refresh Instagram, and open the list manually once before retrying capture.

### API or frontend will not start

- Check whether the ports are already in use: backend `8000`, frontend `5173`.
- Stop background processes with `make stop`.
- Reinstall dependencies with `make install`.
- Check logs in `.pids/backend.log` and `.pids/frontend.log` when using `make dev`.

## Data and Git safety

The project is intended to keep sensitive and generated local files out of Git. The current ignore rules cover:

- SQLite databases: `data/*.db`, `data/*.db-*`
- Local cookie files: `config/cookies.yaml`, `config/cookies.json`, `config/cookies.local.*`
- Logs and PID files: `*.log`, `.pids/`
- Python caches and virtual environments
- Node dependencies and build output
- Playwright reports/artifacts

Before pushing public changes, still run:

```bash
git status --short
git diff --cached
```

Make sure no personal data, cookies, database snapshots, screenshots, or logs were intentionally added.

## Notes and limitations

- InstaRL is local-first and stores data in SQLite by default.
- Instagram UI/API behavior changes frequently; collector selectors and parsers may require maintenance.
- Rate limits or account challenges are external to the app and cannot be solved by code alone.
- The Chrome `debugger` permission is required to access response bodies; keep the extension local and disable it when not collecting.
- Legacy Playwright-style collection code exists, but the browser extension flow is the primary collection path.

## Roadmap ideas

- Neo4j export or optional graph database backend
- GraphML/GEXF export
- Scheduled rescans and diff views
- Richer relationship types
- Better extension telemetry and resumable capture UX
- Packaged desktop/local installer

## License

No license file is currently included. Add one before publishing if you want others to use, modify, or redistribute the project.
