# Suno Super Friends

A Chrome/Edge extension that notifies you when a curated subset of the [Suno](https://suno.com) creators you follow publishes a new song. Built because Suno's notifications are all-or-nothing — useless when you follow thousands of people but want to know the moment your 30 favorites drop something.

## What it does

- Star creators on suno.com to add them to your "Super Friends" list
- Every few minutes, the extension checks each starred friend's profile
- New publishes trigger desktop notifications, an extension badge, and a "Recent Posts" feed in the popup
- Tracks song IDs we've seen, so you don't get duplicate notifications when songs rotate on/off the visible profile page
- Token refresh happens automatically — no need to keep a suno.com tab open

## Status

Working. Tested across two machines. Catches real publishes from real creators in real time.

This is **v0.2.0** — first release with backup/restore. See [CHANGELOG.md](CHANGELOG.md) for history and [ARCHITECTURE.md](ARCHITECTURE.md) for the deep dive on how it works.

## Install

This is a developer-mode extension. There's no Chrome Web Store listing.

1. Download or clone this repo
2. Open `chrome://extensions/` (or `edge://extensions/`)
3. Toggle **Developer mode** on (top right)
4. Click **Load unpacked** and select the `super-friends/` folder
5. Pin the extension to your toolbar (puzzle-piece icon → pin Super Friends)

## First-time setup

1. Open suno.com in any tab. The extension watches for your auth token in the background — just navigate around for 5 seconds and it gets captured.
2. Click the Super Friends icon in your toolbar → click ⚙ Settings → enter your Suno handle (e.g., `spankie0001`) and click outside the field to save.
3. Visit any creator's profile page on suno.com. You'll see a ☆ button next to their name. Click it to add them as a Super Friend (turns ★ yellow).
4. The first poll bootstraps each friend silently — it learns what songs are already on their profile without notifying. Going forward, anything new triggers an alert.

## Usage

- **Adding friends:** click ☆ next to any creator name on any suno.com page. The button injection finds creator references throughout the site (profile pages, song cards, comment authors).
- **Removing friends:** in the extension popup, click the × next to a friend in your Super Friends list.
- **Adjusting poll frequency:** Settings → Poll every. Defaults to 15 minutes. 5 minutes for snappier detection, 30+ for lighter network use.
- **Backup:** Settings → Export friends. Downloads a JSON file with your friends list and seen-song state. Useful before extension updates or to move between machines.
- **Restore:** Settings → Import friends. File picker reads the JSON back. Asks for confirmation before overwriting your current list.

## Updating without losing data

**Don't remove and reinstall.** Chrome treats reinstalled extensions as a different extension instance and wipes your friends list.

To update:
1. Download the new files
2. **Overwrite the contents** of your existing `super-friends/` folder (don't change the folder location)
3. Go to `chrome://extensions/` and click the ↻ reload icon on the Super Friends card
4. Refresh any open suno.com tabs (otherwise their content scripts run old code)

If you do need to reinstall fresh, export your friends list first via Settings → Export friends, then import after the new install.

## Known limits and risks

- **Suno's ToS prohibits automated access** to their service. This extension is automated access. Other extensions (Suno Manager, Suno Explorer, SunoSync) operate the same way and Suno has so far tolerated them, but tolerance isn't permission. Use at your own risk.
- **Suno can change endpoint URLs at any time** — they're undocumented and exist for Suno's own web app. When they break the extension, it stays broken until someone updates the code.
- **48-hour detection window.** A friend who generates a song days ago and only publishes it today: detected if published within 48 hours of generation, missed otherwise. This filter exists to suppress false positives from creators with deep catalogs whose profile pages return inconsistent snapshots.
- **Soft cap at Dunbar's 150.** No hard limit, but the popup warns once you cross 150 friends because at that scale, polling time and notification volume both become annoying.
- **Token expiry.** Bearer tokens expire ~hourly. The extension auto-refreshes by hitting Clerk (Suno's auth provider) with your session cookie. If you're logged out of Suno, polling will start failing with 401s until you log back in.

## Architecture (the short version)

Three Chrome extension components talk to each other:

- **Content script** (`content.js`) runs on suno.com pages. Injects ☆ buttons and captures auth tokens from in-flight requests via a sniffer (`injected.js`).
- **Background service worker** (`background.js`) runs on a 15-min alarm. Polls each Super Friend's profile, diffs against stored "seen" song IDs, fires notifications.
- **Popup** (`popup.html` / `popup.js`) is the UI you see when you click the toolbar icon.

For the full story — including what we hook into, why each approach was chosen, and where the failure modes are — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Project status

This is a personal tool published in case other Suno power users find it useful. I'm not actively soliciting contributions, but PRs that fix bugs or improve robustness are welcome. If Suno changes their API and the extension breaks, the fix is usually a few lines in `suno-api.js`.

## Credits

Built collaboratively with Claude (Anthropic). The architecture decisions, debugging, and many of the implementation details came out of long iterative sessions.

## License

MIT. See [LICENSE](LICENSE).
