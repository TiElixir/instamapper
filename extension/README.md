# InstaRL Browser Collector

This extension replaces Playwright for Instagram collection. It uses the authenticated Instagram tab that you already control and sends only normalized usernames/relationship edges to the local API. It never exports cookies, headers, passwords, or raw response bodies.

## Install

1. Start the backend with `make backend`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this `extension/` directory.
5. Open Instagram in Chrome and confirm you are logged in.
6. Click the extension, enter the API URL, username, and depth, then click **Start capture**.
7. Keep the Instagram tab visible. The extension navigates through queued usernames, opens each profile's **Following** list (clicking the profile control, or falling back to `/username/following/`), scrolls it, and captures relationship users.
8. For depth `2`, the first account's Following usernames become the next queue level. Stop the capture from the popup when needed.
9. After reloading the extension from `chrome://extensions`, refresh the Instagram tab once (or click **Start capture** again — the service worker will reinject the content script).

## How capture works

Two independent sources feed the same per-account set:

1. **Network** — Chrome debugger reads `friendships/.../following` and GraphQL response bodies.
2. **DOM** — while the Following dialog scrolls, the content script scrapes visible profile links / handles and streams `FOLLOWING_DOM_BATCH` messages to the service worker.

Either source alone is enough to ingest users. Popup status should climb (`@user: N following captured so far` or `via DOM`).

## Troubleshooting empty Following captures

- **Always reload the unpacked extension** after code changes (`chrome://extensions` → Reload), then hard-refresh the Instagram tab. An old service worker will keep returning 0 users.
- Status stuck on `Following control did not render` → profile header never exposed a Following entry. Open `https://www.instagram.com/<user>/following/` yourself, then click **Capture current Following**.
- Status reports `Following dialog did not open` → Instagram blocked the modal (private account, age gate, or transient UI). Open Following manually once, then retry Capture — scroll + DOM scrape still run on an already-open list.
- Dialog scrolls through 200+ rows but status stays at 0 / backend gets 0 edges:
  - Confirm the debugger banner is attached to the Instagram tab.
  - Watch popup status for `via DOM` counts; if those appear, network parse is optional.
  - Open `chrome://extensions` → InstaRL → **service worker** Inspect and look for `response processing failed`.
- Capture finishes in under a second with 0 edges → extension/content script was not live; reload extension + Instagram tab.

The `debugger` and `scripting` permissions are required to read response bodies and reinject the content script after extension reloads. Keep the extension local and disable it when not collecting.
