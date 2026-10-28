# InstaRL

> Local-first Instagram relationship graph collector and explorer.

InstaRL turns explicit Instagram **Following** and **Followers** observations into a searchable relationship graph. It pairs a local Chrome extension collector with a FastAPI + SQLite backend, a React/Cytoscape frontend, and an optional native C++ OpenGL viewer for large graphs, so you can capture relationships from an authenticated browser session, preserve scan history, and explore the resulting network visually.

![Python](https://img.shields.io/badge/Python-3.12%2B-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.111%2B-009688?logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Chrome Extension](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)

## Responsible use

Use InstaRL only with accounts, sessions, and data you are authorized to access. The project is designed for local, defensive, educational, and OSINT-style analysis of relationship data visible to your own authenticated Instagram session.

Do not use it to bypass access controls, automate login, harvest private content, evade platform restrictions, or collect data in violation of applicable laws, policies, or terms of service. Instagram can rate limit, challenge, or change UI/API behavior at any time.

## What it does

- Captures Instagram Following and Followers relationships from a real logged-in Chrome tab.
- Stores normalized users and directed `A follows B` edges in local SQLite.
- Preserves scan sessions, checkpoints, edge snapshots, and recoverable errors.
- Supports depth-based expansion where discovered users can become the next queue level.
- Can skip the current scan user from the extension popup.
- Can skip deeper queued users whose profile-level Following count is above a configured threshold.
- Uses Instagram's authenticated relationship APIs first, with DOM/dialog capture as a fallback.
- Displays the graph in a polished React frontend with search, filters, dark mode, scan history, exports, and node details.
- Includes an optional native C++ OpenGL graph viewer for larger 10k+ node / 15k+ edge exports.
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
├── viewer/               # Native C++ OpenGL graph viewer
├── Makefile              # Common install/dev/test/build commands
└── README.md
```

## Requirements

- Python 3.12+
- Node.js and npm
- Google Chrome or Chromium
- CMake, a C++20 compiler, and OpenGL development libraries for the optional native viewer
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
   - Scan mode: **Following** or **Followers**
   - Optional max-Following threshold for deeper queued users
9. Click **Start capture**.

The extension will navigate through queued profiles, capture the selected relationship mode, and send normalized relationship batches to the backend. Use **Skip current user** to abandon the currently open scan target and continue with the next queued account.

After changing extension code, always reload the unpacked extension from `chrome://extensions` and hard-refresh the Instagram tab. Old service workers can stay alive and make it look like fixes did not apply.

## How collection works

For every profile being scanned in **Following** mode, InstaRL records edges from the **current source account** to the accounts found in that source account's Following list. In **Followers** mode, users listed as followers are recorded as reverse canonical follows edges: if `B` appears in `A`'s Followers list, the stored edge is `B → A`.

When a max-Following threshold is configured, the extension minimizes Instagram API requests by using counts already present in relationship API results first. It only requests profile-level counts for queued users that are about to be scanned and are missing a usable `following_count`; those per-scan lookups are cached in the service worker. No cookies, headers, or raw Instagram response bodies are sent to the backend.

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

The browser collector only records immediate users observed in the current source account's selected relationship list:

1. **Relationship API capture** — the Chrome `debugger` API only accepts the active `/api/v1/friendships/{id}/following/` or `/api/v1/friendships/{id}/followers/` response and only parses its direct `users`/`items` list.
2. **DOM capture** — the content script scrapes visible profile links from the currently opened relationship UI while it scrolls.

GraphQL, profile, feed, recommendation, suggestion, and unrelated Instagram API responses are not allowed to create edges. The backend receives only normalized usernames/IDs and relationship edges; cookies, passwords, headers, and raw response bodies are not sent to the API.

## Using the graph explorer

Open `http://127.0.0.1:5173` after starting the backend and frontend.

The UI lets you:

- View scan progress and history.
- Import a local graph JSON export directly into the viewer.
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

## Native graph viewer

The React/Cytoscape viewer remains the easiest way to inspect small and medium graphs from the browser. For larger exports, InstaRL also includes a separate native C++ OpenGL viewer designed around batched drawing and incremental force simulation.

Build it with:

```bash
make viewer-build
```

Export graph JSON from the backend, then run:

```bash
make viewer-run GRAPH=path/to/instarl-graph.json
```

Controls:

- Drag to pan.
- Mouse wheel to zoom.
- Space pauses/resumes the layout simulation.
- Use the in-window layout controls to tune damping, repulsion, spring strength, cluster gravity, or reset node positions.
- `/` focuses native viewer search; `N` / `Shift+N` cycle username matches.
- The search panel highlights the selected result in yellow and its 1-hop neighbors in cyan.
- Zoom in to render username labels; focused search/path labels appear earlier than general labels.
- The shortest-path controls find an undirected BFS path between two usernames and highlight that path in magenta.
- R reloads the current JSON file from disk.
- I prompts for another JSON path in the terminal.
- Drag and drop a JSON file onto the viewer window to import it.
- Escape exits.

Current native viewer behavior:

- Loads InstaRL JSON exports with `nodes` and `edges` arrays.
- Uses compact integer node indices internally.
- Colors nodes by label-propagation clusters.
- Uses grid-approximated repulsion, weighted parent-child spring attraction, cluster gravity, center gravity, velocity inertia, stronger damping, and cooling so layouts settle instead of jittering endlessly.
- Renders mutual edges in green to match the web viewer semantics.
- Supports native search, selected-node neighborhood focus, and undirected shortest-path highlighting.
- Avoids rendering all labels, which keeps large 10k+ node / 15k+ edge graphs usable.

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
- Native viewer build output: `viewer/build/`
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
