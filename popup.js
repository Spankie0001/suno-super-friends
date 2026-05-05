// popup.js — wires up the popup UI.

import {
  getSuperFriends,
  setSuperFriends,
  removeSuperFriend,
  getRecentHits,
  getPollInterval,
  setPollInterval,
  getLastCheck,
} from "./storage.js";

const DUNBAR = 150;
const BACKUP_VERSION = 1;

document.addEventListener("DOMContentLoaded", async () => {
  // Clear badge as soon as popup opens.
  chrome.runtime.sendMessage({ type: "CLEAR_BADGE" });

  await renderRecent();
  await renderFriends();
  await renderSettings();

  document.getElementById("poll-now").addEventListener("click", async () => {
    setStatus("Polling…");
    const resp = await chrome.runtime.sendMessage({ type: "POLL_NOW" });
    if (resp?.ok) {
      setStatus("Done.");
      await renderRecent();
      await renderSettings();
    } else {
      setStatus("Error: " + (resp?.error || "unknown"));
    }
    setTimeout(() => setStatus(""), 2500);
  });

  document.getElementById("settings-btn").addEventListener("click", () => {
    document.getElementById("settings").classList.toggle("hidden");
  });
  document.getElementById("settings-close").addEventListener("click", () => {
    document.getElementById("settings").classList.add("hidden");
  });

  document.getElementById("poll-interval").addEventListener("change", async (ev) => {
    const min = Number(ev.target.value);
    await setPollInterval(min);
    await chrome.runtime.sendMessage({ type: "RESCHEDULE_POLL", minutes: min });
    setStatus(`Polling every ${min}min`);
    setTimeout(() => setStatus(""), 2000);
  });

  // Own handle: load and save on blur.
  const handleInput = document.getElementById("own-handle");
  const { sunoOwnHandle } = await chrome.storage.local.get("sunoOwnHandle");
  if (sunoOwnHandle) handleInput.value = sunoOwnHandle;
  handleInput.addEventListener("blur", async () => {
    const v = handleInput.value.trim().replace(/^@/, "");
    if (v) {
      await chrome.storage.local.set({ sunoOwnHandle: v });
      setStatus(`Handle saved: ${v}`);
      setTimeout(() => setStatus(""), 1500);
    }
  });

  // Backup: export current friends list to a JSON file.
  document.getElementById("export-btn").addEventListener("click", async () => {
    const friends = await getSuperFriends();
    const payload = {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      friendCount: friends.length,
      friends,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `super-friends-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBackupStatus(`Exported ${friends.length} friend${friends.length === 1 ? "" : "s"}.`);
  });

  // Backup: import. Open file picker.
  document.getElementById("import-btn").addEventListener("click", () => {
    document.getElementById("import-file").click();
  });

  document.getElementById("import-file").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const incoming = Array.isArray(data) ? data : data.friends;
      if (!Array.isArray(incoming)) {
        throw new Error("File does not contain a friends list.");
      }
      // Validate each entry has minimum required fields.
      const cleaned = incoming
        .filter(f => f && typeof f.handle === "string" && f.handle.length > 0)
        .map(f => ({
          handle: f.handle,
          displayName: f.displayName || f.handle,
          avatarUrl: f.avatarUrl || "",
          addedAt: f.addedAt || Date.now(),
          seenSongIds: Array.isArray(f.seenSongIds) ? f.seenSongIds : [],
        }));
      if (cleaned.length === 0) {
        throw new Error("No valid friend entries found.");
      }
      const current = await getSuperFriends();
      const ok = confirm(
        `Replace your ${current.length} current friend${current.length === 1 ? "" : "s"} ` +
        `with ${cleaned.length} friend${cleaned.length === 1 ? "" : "s"} from this backup?\n\n` +
        `(Your current list will be overwritten.)`
      );
      if (!ok) {
        setBackupStatus("Import canceled.");
        ev.target.value = "";
        return;
      }
      await setSuperFriends(cleaned);
      setBackupStatus(`Imported ${cleaned.length} friend${cleaned.length === 1 ? "" : "s"}.`);
      await renderFriends();
    } catch (err) {
      setBackupStatus(`Import failed: ${err.message}`);
    }
    ev.target.value = ""; // reset file input
  });
});

function setBackupStatus(msg) {
  const el = document.getElementById("backup-status");
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 4000);
}

async function renderRecent() {
  const list = await getRecentHits();
  const container = document.getElementById("recent-list");
  container.innerHTML = "";
  if (!list.length) {
    container.innerHTML = '<p class="empty">No new posts yet.</p>';
    return;
  }
  for (const hit of list.slice(0, 20)) {
    const row = document.createElement("div");
    row.className = "row";
    row.title = "Open song";
    row.innerHTML = `
      <img class="avatar" src="${hit.imageUrl || ""}" />
      <div class="meta">
        <div class="title">${escape(hit.songTitle)}</div>
        <div class="sub">${escape(hit.displayName || hit.handle)} · ${timeAgo(hit.ts)}</div>
      </div>
    `;
    row.addEventListener("click", () => {
      if (hit.songUrl) chrome.tabs.create({ url: hit.songUrl });
    });
    container.appendChild(row);
  }
}

async function renderFriends() {
  const list = await getSuperFriends();
  const count = list.length;
  const countEl = document.getElementById("friend-count");
  countEl.textContent = count;
  countEl.classList.toggle("over-dunbar", count >= DUNBAR);

  const warning = document.getElementById("dunbar-warning");
  if (warning) warning.classList.toggle("hidden", count < DUNBAR);

  const container = document.getElementById("friends-list");
  container.innerHTML = "";
  if (!list.length) {
    container.innerHTML = '<p class="empty">Star a creator on suno.com to add them.</p>';
    return;
  }
  for (const friend of list) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <img class="avatar" src="${friend.avatarUrl || ""}" />
      <div class="meta">
        <div class="title">${escape(friend.displayName)}</div>
        <div class="sub">@${escape(friend.handle)}</div>
      </div>
      <button class="remove" title="Remove">×</button>
    `;
    row.querySelector(".meta").addEventListener("click", () => {
      chrome.tabs.create({ url: `https://suno.com/@${friend.handle}` });
    });
    row.querySelector(".remove").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await removeSuperFriend(friend.handle);
      await renderFriends();
    });
    container.appendChild(row);
  }
}

async function renderSettings() {
  const min = await getPollInterval();
  document.getElementById("poll-interval").value = String(min);
  const last = await getLastCheck();
  document.getElementById("last-check").textContent = last
    ? `Last check: ${new Date(last).toLocaleTimeString()}`
    : "Last check: never";
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function timeAgo(ts) {
  const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
