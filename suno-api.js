// suno-api.js — the ONLY file you should need to edit after watching DevTools.
//
// HOW TO FILL THIS IN:
// 1. Open suno.com in Chrome, log in.
// 2. Press F12, go to Network tab, filter "Fetch/XHR".
// 3. Visit your /me page (your profile). Look for a request that returns JSON
//    with your follow list. Copy its URL into FOLLOWING_URL_TEMPLATE below.
// 4. Visit any creator's profile page (e.g. suno.com/@someone). Look for a
//    request that returns their songs in JSON. Copy URL into USER_SONGS_URL_TEMPLATE.
// 5. In each request, find these in the Headers tab:
//    - The Bearer token in the Authorization header.
//    - Any custom headers Suno requires (Affiliate-Id, etc).
//    Note them in DEFAULT_HEADERS.
//
// The fetch() calls below use credentials:'include' so your browser cookies
// (Clerk session) are sent automatically. Suno's web app additionally injects
// a short-lived Bearer JWT — we can't forge it, but we can read it from
// in-flight requests. See `interceptToken()` in content.js.

const ENDPOINTS = {
  // CONFIRMED. Used to fetch full data for a list of clip IDs.
  // POST with body: { filters: { ids: { presence: "True", clipIds: [...] } }, limit: N }
  // Response: { clips: [...], has_more: bool }
  FEED_V3_URL: "https://studio-api-prod.suno.com/api/feed/v3",

  // CONFIRMED. The unified home feed (algorithmic mix). Not used in path B.
  UNIFIED_FEED_URL: "https://studio-api-prod.suno.com/api/unified/feed",

  // CONFIRMED. Returns paginated list of who you follow.
  // Note: requires the CURRENT USER's own handle in the path.
  FOLLOWING_URL_TEMPLATE: "https://studio-api-prod.suno.com/api/profiles/{handle}/following?page={page}",

  // CONFIRMED. Returns metadata about a profile (NOT clips - just bio, cover photo, etc.)
  PROFILE_INFO_URL_TEMPLATE: "https://studio-api-prod.suno.com/api/profiles/{handle}/info",

  // Per-user clips: there is NO direct API for this. The web app server-renders
  // clip IDs into the profile page HTML, then calls feed/v3 with them.
  // fetchUserSongs() in this file does the same.
};

// DEFAULT_HEADERS will be merged with the captured Bearer token at call time.
const DEFAULT_HEADERS = {
  "Accept": "application/json",
  "Content-Type": "application/json",
};

const CLERK_CLIENT_URL = "https://auth.suno.com/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0";

/**
 * Decode a JWT's payload (no signature verification - we just want claims).
 * Returns null on any parsing error.
 */
function decodeJwtPayload(jwt) {
  try {
    const payload = jwt.split('.')[1];
    // base64url -> base64 with padding
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch (e) {
    return null;
  }
}

/**
 * Returns true if the JWT expires within the next `bufferSec` seconds
 * (or has already expired, or can't be decoded).
 */
function isTokenStale(jwt, bufferSec = 60) {
  if (!jwt) return true;
  const payload = decodeJwtPayload(jwt);
  if (!payload || !payload.exp) return true;
  const nowSec = Math.floor(Date.now() / 1000);
  return payload.exp - nowSec < bufferSec;
}

/**
 * Hit Clerk's /v1/client endpoint to get a fresh bearer token.
 * Uses the user's Clerk session cookie (sent automatically via credentials:include).
 *
 * Response shape contains a "response" object that includes session info,
 * with a JWT embedded somewhere. We scan the entire response for any
 * eyJ...eyJ...xxx pattern and pick the first JWT issued by auth.suno.com
 * with claim "suno.com/claims/token_type" = "session_token" or similar.
 */
async function refreshBearerToken() {
  const res = await fetch(CLERK_CLIENT_URL, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`refreshBearerToken: clerk client fetch ${res.status}`);
  }
  const text = await res.text();
  // Find any JWT in the response
  const jwts = text.match(/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g) || [];
  // Pick the one with the latest expiry (most recently issued).
  let best = null;
  let bestExp = 0;
  for (const jwt of jwts) {
    const p = decodeJwtPayload(jwt);
    if (p && p.iss === "https://auth.suno.com" && p.exp > bestExp) {
      best = jwt;
      bestExp = p.exp;
    }
  }
  if (!best) throw new Error("refreshBearerToken: no JWT found in clerk response");
  await chrome.storage.local.set({ sunoBearer: best });
  return best;
}

/**
 * Get the bearer token, refreshing if stale.
 */
async function getBearer() {
  const { sunoBearer } = await chrome.storage.local.get("sunoBearer");
  if (!isTokenStale(sunoBearer)) return sunoBearer;
  // Stale or missing - refresh.
  return await refreshBearerToken();
}

/**
 * Returns headers with a fresh bearer token.
 */
async function buildHeaders() {
  const headers = { ...DEFAULT_HEADERS };
  try {
    const token = await getBearer();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  } catch (e) {
    console.warn("[SuperFriends] Could not get bearer:", e.message);
    // Fall through with no auth - the call will likely 401, but at least
    // we don't crash here.
  }
  return headers;
}

/**
 * Get the current user's own handle. Cached in storage (set by popup or
 * captured from fetchFollowing response body).
 */
export async function getOwnHandle() {
  const { sunoOwnHandle } = await chrome.storage.local.get("sunoOwnHandle");
  return sunoOwnHandle || null;
}

/**
 * Get a paginated list of users that {handle} follows.
 * If no handle is given, uses the current user's own (must be discovered first).
 *
 * Returns { items: [{handle, displayName, avatarUrl, userId}], hasMore, total, currentPage }
 *
 * CONFIRMED response shape (Jason 2026-04-30):
 *   { user_id, handle, profiles: [...], current_page, num_total_profiles }
 *   profiles[i] = {
 *     external_user_id, handle, display_name, avatar_image_url,
 *     is_following, is_verified, stats: {...}
 *   }
 * Page size = 20.
 */
export async function fetchFollowing(page = 1, handle = null) {
  const ownerHandle = handle || await getOwnHandle();
  if (!ownerHandle) {
    throw new Error("fetchFollowing: no handle known yet. Visit suno.com to populate.");
  }
  const url = ENDPOINTS.FOLLOWING_URL_TEMPLATE
    .replace("{handle}", encodeURIComponent(ownerHandle))
    .replace("{page}", page);
  const res = await fetch(url, {
    method: "GET",
    headers: await buildHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`fetchFollowing failed: ${res.status}`);
  const json = await res.json();
  // Side benefit: the response includes the requester's user_id+handle at top level.
  // Cache it the first time we see it, in case we don't have it yet.
  if (json.handle && !handle) {
    chrome.storage.local.set({ sunoOwnHandle: json.handle, sunoOwnUserId: json.user_id });
  }
  const profiles = json.profiles || [];
  const total = json.num_total_profiles || 0;
  const currentPage = json.current_page || page;
  return {
    items: profiles.map(normalizeFollow),
    hasMore: currentPage * 20 < total,
    total,
    currentPage,
  };
}

function normalizeFollow(raw) {
  return {
    handle: raw.handle,
    displayName: raw.display_name || raw.handle,
    avatarUrl: raw.avatar_image_url || "",
    userId: raw.external_user_id,
    isVerified: Boolean(raw.is_verified),
    followersCount: raw.stats?.followers_count || 0,
  };
}

/**
 * Async generator over all pages of follows. Use this for bulk-import flows.
 * Yields one normalized user at a time.
 *
 *   for await (const user of iterFollowing()) { ... }
 *
 * Caller is responsible for stopping early if they only want a subset.
 * Includes a small delay between page fetches to be polite to the API.
 */
export async function* iterFollowing(delayMs = 250) {
  let page = 1;
  while (true) {
    const { items, hasMore } = await fetchFollowing(page);
    for (const item of items) yield item;
    if (!hasMore || items.length === 0) return;
    page += 1;
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }
}

/**
 * Get a creator's recent songs.
 *
 * Suno does NOT have a clean "list user's clips" endpoint. The web app does
 * this in two steps:
 *   1. Fetch the profile page HTML (server-rendered with clip IDs embedded)
 *   2. POST those IDs to /api/feed/v3 to get full clip data
 *
 * We do the same. We send all UUIDs we find on the page; the feed endpoint
 * silently ignores ones that aren't clip IDs, so the response is naturally
 * filtered to real clips.
 *
 * Returns { items: [{id, title, createdAt, url, imageUrl, isPublic}], hasMore }
 */
export async function fetchUserSongs(handle, page = 1) {
  // page is unused here - feed/v3 returns all the clips embedded on the
  // profile page in one shot. For "show more songs" pagination we'd need
  // a different approach, but for new-post detection we only care about
  // the most recent clips, which are always on page 1.

  // Step 1: fetch the profile HTML
  const profileUrl = `https://suno.com/@${encodeURIComponent(handle)}`;
  const htmlRes = await fetch(profileUrl, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "text/html" },
  });
  if (!htmlRes.ok) throw new Error(`fetchUserSongs(${handle}): profile HTML ${htmlRes.status}`);
  const html = await htmlRes.text();

  // Step 2: extract every UUID. Filter out the all-zeros placeholder.
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  let allIds = [...new Set(html.match(uuidRe) || [])]
    .filter(id => id !== "00000000-0000-0000-0000-000000000000");

  if (allIds.length === 0) {
    return { items: [], hasMore: false };
  }

  // Cap at 50 IDs. For new-post detection we only care about the newest
  // songs, and profiles with hundreds of songs blow past feed/v3's body
  // size or array length limit (causing 400 errors). The IDs in the HTML
  // are emitted in DOM order, which roughly mirrors display order on the
  // page (newest first), so the first 50 should cover anything recent
  // enough for "did they post since last poll" purposes.
  const MAX_IDS_PER_BATCH = 50;
  if (allIds.length > MAX_IDS_PER_BATCH) {
    allIds = allIds.slice(0, MAX_IDS_PER_BATCH);
  }

  // Step 3: POST to feed/v3 with the (capped) candidate IDs.
  // feed/v3 returns only clips matching real clip IDs; non-clip UUIDs
  // (user IDs, persona IDs, etc.) are silently dropped.
  const feedUrl = "https://studio-api-prod.suno.com/api/feed/v3";

  async function fetchFeedBatch(idBatch) {
    const body = JSON.stringify({
      filters: { ids: { presence: "True", clipIds: idBatch } },
      limit: idBatch.length,
    });
    let res = await fetch(feedUrl, {
      method: "POST",
      credentials: "include",
      headers: await buildHeaders(),
      body,
    });
    if (res.status === 401) {
      await refreshBearerToken();
      res = await fetch(feedUrl, {
        method: "POST",
        credentials: "include",
        headers: await buildHeaders(),
        body,
      });
    }
    return res;
  }

  let feedRes = await fetchFeedBatch(allIds);

  // If 400 on a batch of 50, halve and try again - server-side limits vary.
  if (feedRes.status === 400 && allIds.length > 25) {
    feedRes = await fetchFeedBatch(allIds.slice(0, 25));
  }
  if (feedRes.status === 400 && allIds.length > 10) {
    feedRes = await fetchFeedBatch(allIds.slice(0, 10));
  }
  if (!feedRes.ok) throw new Error(`fetchUserSongs(${handle}): feed/v3 ${feedRes.status}`);
  const json = await feedRes.json();

  const clips = (json.clips || [])
    // Defensive: only keep clips actually belonging to the requested handle.
    // (The page might mention OTHER users' clips - e.g., remixes, collabs.)
    .filter(c => c.handle === handle);

  // Sort newest first.
  clips.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return {
    items: clips.map(normalizeSong),
    hasMore: false,
  };
}

function normalizeSong(raw) {
  return {
    id: raw.id,
    title: raw.title || raw.metadata?.title || "(untitled)",
    createdAt: raw.created_at,
    isPublic: raw.is_public !== false,
    url: raw.id ? `https://suno.com/song/${raw.id}` : null,
    imageUrl: raw.image_url || raw.image_large_url || "",
  };
}

export const _internals = { ENDPOINTS, DEFAULT_HEADERS };
