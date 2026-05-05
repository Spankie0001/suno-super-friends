// storage.js — wraps chrome.storage.local for super-friend state.

const KEYS = {
  SUPER_FRIENDS: "superFriends",       // [{handle, displayName, avatarUrl, seenSongIds[]}]
  LAST_CHECK: "lastCheck",             // ISO timestamp
  RECENT_HITS: "recentHits",           // [{handle, songTitle, songId, songUrl, ts}], cap 100
  POLL_INTERVAL_MIN: "pollIntervalMin", // number, default 15
  SUNO_BEARER: "sunoBearer",           // captured by content script
};

// How many recent IDs to remember per friend. Bigger = more memory but
// resilient to "old song republished after a long gap." 200 covers
// effectively any creator's full public catalog for ID-set tracking.
const MAX_SEEN_IDS_PER_FRIEND = 200;

export async function getSuperFriends() {
  const { [KEYS.SUPER_FRIENDS]: list } = await chrome.storage.local.get(KEYS.SUPER_FRIENDS);
  return (list || []).map(migrateFriend);
}

// Migrate older shape ({lastSeenSongId}) to new shape ({seenSongIds[]}) on read.
function migrateFriend(f) {
  if (Array.isArray(f.seenSongIds)) return f;
  const seen = [];
  if (f.lastSeenSongId) seen.push(f.lastSeenSongId);
  return {
    handle: f.handle,
    displayName: f.displayName,
    avatarUrl: f.avatarUrl || "",
    addedAt: f.addedAt,
    seenSongIds: seen,
  };
}

export async function setSuperFriends(list) {
  await chrome.storage.local.set({ [KEYS.SUPER_FRIENDS]: list });
}

export async function addSuperFriend(friend) {
  const list = await getSuperFriends();
  if (list.some(f => f.handle === friend.handle)) return list;
  list.push({
    handle: friend.handle,
    displayName: friend.displayName || friend.handle,
    avatarUrl: friend.avatarUrl || "",
    seenSongIds: [],
    addedAt: Date.now(),
  });
  await setSuperFriends(list);
  return list;
}

export async function removeSuperFriend(handle) {
  const list = await getSuperFriends();
  const next = list.filter(f => f.handle !== handle);
  await setSuperFriends(next);
  return next;
}

export async function isSuperFriend(handle) {
  const list = await getSuperFriends();
  return list.some(f => f.handle === handle);
}

/**
 * Add the given song IDs to a friend's seen-set, capped at MAX_SEEN_IDS_PER_FRIEND.
 * Returns the updated friend record.
 */
export async function recordSeenIds(handle, newIds) {
  const list = await getSuperFriends();
  const friend = list.find(f => f.handle === handle);
  if (!friend) return null;
  const seen = new Set(friend.seenSongIds || []);
  for (const id of newIds) seen.add(id);
  let arr = Array.from(seen);
  if (arr.length > MAX_SEEN_IDS_PER_FRIEND) {
    // Keep the most recently added ones (Sets preserve insertion order in JS).
    arr = arr.slice(-MAX_SEEN_IDS_PER_FRIEND);
  }
  friend.seenSongIds = arr;
  await setSuperFriends(list);
  return friend;
}

/**
 * Initialize a friend's seen-set from a list of current IDs (used for bootstrap
 * on first poll - records what was already there without notifying).
 */
export async function bootstrapSeenIds(handle, ids) {
  const list = await getSuperFriends();
  const friend = list.find(f => f.handle === handle);
  if (!friend) return null;
  friend.seenSongIds = ids.slice(0, MAX_SEEN_IDS_PER_FRIEND);
  await setSuperFriends(list);
  return friend;
}

export async function getRecentHits() {
  const { [KEYS.RECENT_HITS]: list } = await chrome.storage.local.get(KEYS.RECENT_HITS);
  return list || [];
}

export async function addRecentHit(hit) {
  const list = await getRecentHits();
  list.unshift(hit);
  if (list.length > 100) list.length = 100;
  await chrome.storage.local.set({ [KEYS.RECENT_HITS]: list });
}

export async function getPollInterval() {
  const { [KEYS.POLL_INTERVAL_MIN]: n } = await chrome.storage.local.get(KEYS.POLL_INTERVAL_MIN);
  return n || 15;
}

export async function setPollInterval(min) {
  await chrome.storage.local.set({ [KEYS.POLL_INTERVAL_MIN]: min });
}

export async function setLastCheck(ts) {
  await chrome.storage.local.set({ [KEYS.LAST_CHECK]: ts });
}

export async function getLastCheck() {
  const { [KEYS.LAST_CHECK]: ts } = await chrome.storage.local.get(KEYS.LAST_CHECK);
  return ts || null;
}

export const STORAGE_KEYS = KEYS;
