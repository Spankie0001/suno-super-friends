# Changelog

All notable changes to Suno Super Friends will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project uses [semantic versioning](https://semver.org/spec/v2.0.0.html) loosely.

## [0.2.0] — 2026-05-04

### Added
- **Backup / restore.** Settings panel now has Export and Import buttons. Export downloads a JSON file (`super-friends-backup-YYYY-MM-DD.json`) containing your friends list and seen-song state. Import reads it back, with a confirmation dialog before overwriting your current list.
- **Soft cap at Dunbar's 150.** Friend count in the popup now displays as `X / 150`. Once you cross 150, the count turns yellow and a warning appears: "You've passed Dunbar's 150 — that's a lot of humans to keep track of." No hard restriction; you can still add more.

## [0.1.0] — 2026-05-02

### Initial working version
- Star creators on suno.com to add them as Super Friends
- Background polling on a configurable interval (default 15 min)
- Bearer JWT auto-refresh via Clerk's `/v1/client` endpoint, so polling works without a suno.com tab open
- Detection by ID-set diff against stored `seenSongIds` per friend, capped at 200 per friend
- 48-hour age filter on `created_at` to suppress false positives from creators with deep catalogs
- First-poll bootstrap: silently record current visible IDs without notifying for backlog
- Desktop notifications, badge counter, and in-popup "Recent Posts" feed
- Clip ID list capped at 50 per `feed/v3` request to avoid HTTP 400 from oversized request bodies; falls back to 25, then 10 on persistent 400s
- Star button injection on profile headers and on inline creator references throughout suno.com
- CSP-safe injection: the fetch/XHR sniffer is loaded as `<script src="chrome-extension://...">` rather than inline `textContent`, since Suno's CSP blocks inline scripts
