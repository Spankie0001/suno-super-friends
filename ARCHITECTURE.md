# Architecture

This is the honest tour of how Suno Super Friends works, what it hooks into, and where the failure modes live. Written for someone trying to understand or contribute to the code.

## Components

```
┌─────────────────────┐    ┌──────────────────────┐    ┌─────────────────────┐
│   suno.com page     │    │  background service  │    │   toolbar popup     │
│                     │    │      worker          │    │                     │
│  ┌──────────────┐   │    │                      │    │  - friend list      │
│  │ injected.js  │   │    │  - alarm scheduler   │    │  - recent posts     │
│  │ (main world) │   │    │  - poll loop         │    │  - settings         │
│  │ sniffs JWTs  │───┼────┼──┐                   │    │  - export/import    │
│  └──────────────┘   │    │  │ store JWT         │    │                     │
│                     │    │  ▼                   │    │                     │
│  ┌──────────────┐   │    │ ┌──────────────────┐ │    │                     │
│  │  content.js  │   │    │ │ chrome.storage   │◀┼────┤                     │
│  │ (isolated)   │───┼────┼▶│   .local         │ │    │                     │
│  │ injects ☆    │   │    │ └──────────────────┘ │    │                     │
│  └──────────────┘   │    │  │                   │    │                     │
└─────────────────────┘    │  ▼                   │    │                     │
                           │ fetch suno.com HTML  │    │                     │
                           │ + studio-api feed/v3 │    │                     │
                           │ + auth.suno token    │    │                     │
                           └──────────────────────┘    └─────────────────────┘
```

The three components share state via `chrome.storage.local` and exchange one-off messages via `chrome.runtime.sendMessage`. No shared memory — each runs in its own JS context.

## File-by-file

### `manifest.json`
Manifest V3. Declares permissions (`storage`, `alarms`, `notifications`), host permissions (`suno.com`, `studio-api-prod.suno.com`, `auth.suno.com`), and registers the service worker, content script, and popup.

### `content.js`
Runs on every suno.com page. Two jobs:

1. **Inject `injected.js` into the page's main world** as a `<script src="chrome-extension://...">` tag. Inline injection is blocked by Suno's CSP, so we have to load the script as a resource. The injected script monkey-patches `window.fetch` and `XMLHttpRequest.setRequestHeader` to read every outgoing `Authorization: Bearer ...` header. Captured tokens get posted back to the content script via `window.postMessage`, which stores them in `chrome.storage.local` as `sunoBearer`.

2. **Scan the DOM for `<a href="/@handle">` and inject ☆ buttons.** A MutationObserver re-scans whenever the page DOM changes (Suno is a React SPA, so content updates dynamically). For profile pages specifically (`suno.com/@somebody`), there's a separate path that injects a larger ☆ next to the page's `<h1>` heading, since the profile header isn't a self-link.

### `injected.js`
The fetch/XHR sniffer. Runs in the page's main world (different JS context than the content script). Loaded as `web_accessible_resource`. Posts captured tokens via `window.postMessage`.

### `background.js`
The service worker. The brain of the operation.

- On install/startup, schedules a `chrome.alarms` alarm at the configured polling interval (default 15 min).
- On each alarm, calls `pollAllFriends()` which iterates over `superFriends` from storage, calling `checkOneFriend()` for each with a 400-1000ms jitter between requests (politeness).
- `checkOneFriend()` is where the detection logic lives. See "Detection logic" below.
- Listens for `POLL_NOW`, `RESCHEDULE_POLL`, and `CLEAR_BADGE` messages from the popup.

### `suno-api.js`
The Suno API adapter. All HTTP calls to `studio-api-prod.suno.com` and `auth.suno.com` happen here.

Key functions:
- **`getBearer()` / `refreshBearerToken()`** — Decodes the JWT to check expiry. If stale, hits `auth.suno.com/v1/client` to get a fresh token. Without this, polling would die after ~1 hour and only revive when you opened a suno.com tab.
- **`fetchUserSongs(handle)`** — Two-step process: scrape the profile HTML for clip UUIDs, then POST those UUIDs to `feed/v3` to get full clip data. Filters response to only clips owned by `handle`.
- **`fetchFollowing(page, handle)`** — Returns paginated list of who the user follows. Currently used only for capturing the user's own handle (returned in the response body); not yet wired into a "browse follows" UI.
- **`iterFollowing()`** — Async generator over all pages of follows, with politeness delay. For future bulk-import flows.

### `storage.js`
Wraps `chrome.storage.local` with typed-feeling helpers. Manages:
- `superFriends` — array of `{handle, displayName, avatarUrl, seenSongIds[], addedAt}`
- `recentHits` — capped list of recent detections, shown in the popup
- `sunoBearer` — current JWT
- `sunoOwnHandle` — your handle (used by `fetchFollowing` and elsewhere)
- `pollIntervalMin` — your chosen polling interval
- `lastCheck` — ISO timestamp of last successful poll

Includes a migration shim: friends with the old `lastSeenSongId` field get auto-converted to the new `seenSongIds[]` shape on read.

### `popup.html`, `popup.js`, `popup.css`
The 360px-wide popup that appears when you click the toolbar icon. Shows recent posts, friend list, and settings (poll interval, your handle, backup/restore).

## Detection logic (the important part)

The whole reason this is non-trivial is that Suno doesn't expose a "give me user X's recent songs" API. So we have to be clever.

### Step 1: Get clip IDs from the profile HTML

When you visit `https://suno.com/@somebody`, Suno's server-side rendering bakes clip UUIDs into the HTML. We fetch the HTML, regex out every UUID, and filter out the all-zeros placeholder.

This is fragile. The HTML returns somewhere between 12 and 130 UUIDs depending on... something we don't fully understand (lazy-load state? caching? algorithmic ranking?). What's there at any given moment isn't a stable representation of the user's full catalog.

We cap the list at 50 IDs to avoid `feed/v3` rejecting oversized request bodies with HTTP 400.

### Step 2: Get clip data from `feed/v3`

`POST https://studio-api-prod.suno.com/api/feed/v3` with body:
```json
{
  "filters": {
    "ids": {
      "presence": "True",
      "clipIds": ["uuid1", "uuid2", ...]
    }
  },
  "limit": 50
}
```

Returns full clip metadata: title, `created_at`, `is_public`, image URL, owner handle, etc. Suno silently drops UUIDs that aren't real clip IDs (user IDs, persona IDs), so we can throw the kitchen sink at it.

We filter the response to only clips where `clip.handle === friend.handle`. Other clips returned (because the regex caught a remix's UUID) are someone else's content.

### Step 3: Diff against seen-set

For each friend, we store up to 200 song IDs we've previously seen on their profile (`seenSongIds`). Any clip in the current fetch whose ID isn't in the seen-set is a candidate "new publish."

### Step 4: 48-hour age filter

Here's the key detail. Naïvely, "unseen ID = new publish" produces tons of false positives. Suno's profile HTML returns inconsistent snapshots — songs rotate in and out — and creators with deep catalogs will continually surface "new" songs that are actually weeks or months old.

So we additionally require `created_at` within the last 48 hours. Old-but-unseen IDs get silently added to the seen-set without firing notifications. Over a few polls, the seen-set converges on the creator's full catalog and the false-positive rate drops to zero.

### Step 5: Bootstrap

When you first star a friend, their `seenSongIds` is empty. Instead of blasting you with notifications for their entire backlog, the first poll silently records every visible ID and returns nothing. Only subsequent polls produce notifications.

### Trade-offs

The 48-hour window means **we miss publishes of songs generated more than 48 hours before publishing**. That's a real loss. The alternative — no age filter — was unusable in practice (we tested this; it produced floods of notifications for weeks-old rotation noise).

If a friend regularly sits on their songs for days before publishing, they'll need a different approach. Could be a configurable window, or a "manual rescan ignoring age filter" button. Not built yet.

## Auth flow

Suno uses [Clerk](https://clerk.com) for authentication. Two pieces of state matter:

1. **Clerk session cookie** — set when you log in, valid for weeks, sent automatically with `credentials: "include"` requests
2. **Bearer JWT** — short-lived (~1 hour), required for `studio-api-prod` API calls

Our flow:
- Content script's injected sniffer captures the JWT whenever Suno's web app makes any authenticated request. Stored as `sunoBearer`.
- Before each background API call, we decode the stored JWT (no signature verification — we just look at `exp`). If it's stale, we hit `https://auth.suno.com/v1/client` with the session cookie to get a fresh JWT. This works without a suno.com tab being open, because the cookie is sent automatically.
- The Clerk response is JSON containing one or more JWTs. We scan for any JWT issued by `auth.suno.com` and pick the one with the latest `exp`.
- If a `feed/v3` call still 401s despite the proactive refresh (race condition / drift), we refresh once and retry.

## Risk register (failure modes ranked)

### Low risk: stable

- **Clerk cookie auth** — Suno can't change this without breaking their own login.
- **Chrome extension APIs** (`chrome.storage`, `chrome.notifications`, `chrome.alarms`) — stable browser primitives.

### Medium risk: might break with redesigns

- **Bearer JWT sniffing** — works as long as Suno uses standard `Authorization: Bearer` headers. A switch to custom transport (gRPC, websockets) or non-standard auth headers would break us.
- **Profile HTML containing clip UUIDs** — currently true because Suno server-renders with hydration data. If they switch to fully client-side data loading, we have nothing to scrape.
- **Star button injection** — depends on Suno's current DOM structure. A redesign that changes link patterns or moves to shadow DOM breaks the injection.

### High risk: could break any time

- **`studio-api-prod.suno.com` endpoints** — undocumented, exist for Suno's own web app. They can rename, change shape, or remove without notice. We depend on:
  - `POST /api/feed/v3`
  - `POST /api/profiles/{handle}/following`
  - `GET https://auth.suno.com/v1/client`
- **Cloudflare bot detection** — Turnstile is already on Suno's pages. They could add stricter checks that flag our background fetches as non-browser traffic.

## Other concerns

- **Suno ToS prohibits automated access.** Risk to your account is theoretically real but historically low; other extensions in this space have been tolerated.
- **The extension stores your JWT in unencrypted local storage.** Same exposure as cookies. Token expires hourly.
- **No telemetry, no monitoring.** When something breaks, you find out by not getting notifications. A "last successful poll" indicator in the popup would help; not built yet.
- **Polling overlap at scale.** At 150 friends with 5-min interval and ~700ms per friend, polling takes ~2 minutes. Fine. At 500+ friends, polls would overlap. No safeguard yet.

## What I'd watch for in practice

- **Sudden silence** — if you stop getting notifications for a week and you know friends are publishing, something's broken. Open the service worker console (`chrome://extensions` → Suno Super Friends → "service worker" link).
- **Sudden spam** — if you get 50+ notifications at once, the seen-set diff lost track somehow. There's a manual reset script in the conversation log; should be turned into a button.
- **Notification for a song that's clearly months old** — the 48-hour filter logic broke. Check the offending song's `created_at` via `feed/v3`.
- **Suno UI redesign** — if their site looks visibly different one day, plan for the extension to break that day.
