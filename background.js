// background.js — service worker that polls super friends on an alarm.

import { fetchUserSongs } from "./suno-api.js";
import {
  getSuperFriends,
  recordSeenIds,
  bootstrapSeenIds,
  addRecentHit,
  getPollInterval,
  setLastCheck,
} from "./storage.js";

const ALARM_NAME = "superFriendsPoll";

// On install, set up the alarm at the configured interval.
chrome.runtime.onInstalled.addListener(async () => {
  const min = await getPollInterval();
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: min, delayInMinutes: 1 });
  console.log(`[SuperFriends] Alarm installed at ${min}min`);
});

// On startup (browser open), make sure alarm exists.
chrome.runtime.onStartup.addListener(async () => {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    const min = await getPollInterval();
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: min, delayInMinutes: 1 });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    pollAllFriends().catch(err => console.error("[SuperFriends] poll error:", err));
  }
});

// Listen for messages from popup/content.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "POLL_NOW") {
    pollAllFriends().then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "RESCHEDULE_POLL") {
    rescheduleAlarm(msg.minutes).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "CLEAR_BADGE") {
    chrome.action.setBadgeText({ text: "" });
  }
});

async function rescheduleAlarm(minutes) {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes, delayInMinutes: 0.5 });
  console.log(`[SuperFriends] Alarm rescheduled to ${minutes}min`);
}

async function pollAllFriends() {
  const friends = await getSuperFriends();
  if (!friends.length) {
    await setLastCheck(new Date().toISOString());
    return;
  }
  console.log(`[SuperFriends] Polling ${friends.length} friend(s)…`);

  let totalNew = 0;
  for (const friend of friends) {
    try {
      const newSongs = await checkOneFriend(friend);
      totalNew += newSongs.length;
    } catch (err) {
      console.warn(`[SuperFriends] failed for ${friend.handle}:`, err.message);
    }
    // Be polite: small jitter between requests so we don't hammer.
    await sleep(400 + Math.random() * 600);
  }

  await setLastCheck(new Date().toISOString());
  if (totalNew > 0) await updateBadge(totalNew);
  console.log(`[SuperFriends] Done. ${totalNew} new song(s).`);
}

// How recent a song's created_at must be to trigger a notification, in ms.
// Songs with unseen IDs but older created_at are silently added to seen-set
// without notification - they're just rotating-into-view old songs, not
// new publishes. 48 hours covers same-day and next-day backdated publishes
// while filtering out the noise from creators with deep catalogs whose
// profile pages return varying snapshots.
const MAX_AGE_FOR_NOTIFY_MS = 48 * 60 * 60 * 1000;

async function checkOneFriend(friend) {
  const { items } = await fetchUserSongs(friend.handle, 1);
  if (!items.length) return [];

  const seenSet = new Set(friend.seenSongIds || []);

  // First-time bootstrap: record everything we see now without notifying.
  // This prevents spamming the user with the entire backlog when they first
  // star a creator.
  if (seenSet.size === 0) {
    await bootstrapSeenIds(friend.handle, items.map(s => s.id));
    return [];
  }

  // Find IDs we've never seen before AND that are recent enough to be
  // plausibly a real new publish. Old-but-unseen IDs are usually songs
  // rotating into view from a creator's deep catalog (Suno's profile HTML
  // returns inconsistent snapshots), not real new publishes.
  const now = Date.now();
  const unseen = items.filter(s => s.isPublic && !seenSet.has(s.id));
  const newOnes = unseen.filter(s => {
    if (!s.createdAt) return true; // no timestamp = give benefit of doubt
    const ageMs = now - new Date(s.createdAt).getTime();
    return ageMs <= MAX_AGE_FOR_NOTIFY_MS;
  });

  // Always record ALL visible IDs into seen-set - including old ones that
  // we won't notify about. This way next time they show up they don't fire,
  // and over time the seen-set grows to cover the creator's full catalog.
  await recordSeenIds(friend.handle, items.map(s => s.id));

  for (const song of newOnes) {
    await fireNotification(friend, song);
    await addRecentHit({
      handle: friend.handle,
      displayName: friend.displayName,
      songTitle: song.title,
      songId: song.id,
      songUrl: song.url,
      imageUrl: song.imageUrl,
      ts: Date.now(),
    });
  }
  return newOnes;
}

async function fireNotification(friend, song) {
  const notifId = `suno-${song.id}`;
  chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: friend.avatarUrl || "icons/icon128.png",
    title: `${friend.displayName} posted a new song`,
    message: song.title,
    contextMessage: "Suno Super Friends",
    priority: 1,
  });
}

// When the user clicks a notification, open the song.
chrome.notifications.onClicked.addListener(async (notifId) => {
  const songId = notifId.replace(/^suno-/, "");
  chrome.tabs.create({ url: `https://suno.com/song/${songId}` });
  chrome.notifications.clear(notifId);
});

async function updateBadge(count) {
  const text = count > 99 ? "99+" : String(count);
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#e94560" });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
