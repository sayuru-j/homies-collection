/**
 * HomieLog server admin dashboard.
 */
(function () {
  const API = "/api/admin";

  async function adminFetch(path, options = {}) {
    const res = await fetch(API + path, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { detail: text };
    }
    if (!res.ok) {
      const msg = data?.detail || data?.message || res.statusText;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
  }

  function toast(msg, type = "ok") {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.className = "toast " + type;
    el.classList.remove("hidden");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add("hidden"), 4000);
  }

  function confirmAction(msg) {
    return window.confirm(msg);
  }

  function showLogin() {
    document.getElementById("login-screen").classList.remove("hidden");
    document.getElementById("dashboard").classList.add("hidden");
  }

  function showDashboard() {
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("dashboard").classList.remove("hidden");
  }

  async function checkAuth() {
    try {
      await adminFetch("/me");
      showDashboard();
      await loadAll();
      return true;
    } catch {
      showLogin();
      return false;
    }
  }

  document.getElementById("admin-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("login-error");
    errEl.classList.add("hidden");
    const password = document.getElementById("admin-password").value;
    try {
      await adminFetch("/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      document.getElementById("admin-password").value = "";
      showDashboard();
      await loadAll();
      toast("Signed in");
    } catch (ex) {
      errEl.textContent = ex.message || "Login failed";
      errEl.classList.remove("hidden");
    }
  });

  document.getElementById("btn-logout").addEventListener("click", async () => {
    try {
      await adminFetch("/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    showLogin();
  });

  document.getElementById("btn-refresh").addEventListener("click", () => loadAll());

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".panel").forEach((p) => {
        p.classList.toggle("active", p.id === "panel-" + tab);
      });
      if (tab === "media") loadMedia();
    });
  });

  async function loadStats() {
    const s = await adminFetch("/stats");
    const grid = document.getElementById("stats-grid");
    const cards = [
      ["Users", s.users],
      ["Online", s.online],
      ["Sessions", s.sessions],
      ["Chats", s.chats],
      ["Groups", s.groups],
      ["Events", s.events],
      ["Active invites", s.active_invites],
      ["Chunk files", s.chunk_files],
      ["Data size", s.data_size_human],
      ["Media size", s.media_size_human],
    ];
    grid.innerHTML = cards
      .map(
        ([label, value]) =>
          `<div class="stat-card"><div class="value">${escapeHtml(String(value))}</div><div class="label">${escapeHtml(label)}</div></div>`
      )
      .join("");
  }

  async function loadUsers() {
    const { users } = await adminFetch("/users");
    const tbody = document.querySelector("#users-table tbody");
    tbody.innerHTML = users
      .map(
        (u) => `
      <tr>
        <td><strong>${escapeHtml(u.display_name || u.name)}</strong><br><span class="muted">${escapeHtml(u.name)}</span></td>
        <td><code>${escapeHtml(u.id)}</code></td>
        <td><span class="badge ${u.online ? "badge-ok" : "badge-off"}">${u.online ? "yes" : "no"}</span></td>
        <td>${u.session_count}</td>
        <td>${escapeHtml(u.media_size_human)}</td>
        <td>${escapeHtml((u.created_at || "").slice(0, 10))}</td>
        <td>
          <button type="button" class="btn-danger" data-del-user="${escapeHtml(u.id)}" data-name="${escapeHtml(u.name)}">Delete</button>
          <button type="button" class="btn-warn" data-clear-media="${escapeHtml(u.id)}">Clear media</button>
        </td>
      </tr>`
      )
      .join("");

    tbody.querySelectorAll("[data-del-user]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.delUser;
        const name = btn.dataset.name;
        if (!confirmAction(`Delete user "${name}" and all their DMs, media, and sessions?`)) return;
        try {
          const r = await adminFetch(`/users/${id}`, { method: "DELETE" });
          toast(`Deleted ${r.name}`);
          await loadAll();
        } catch (ex) {
          toast(ex.message, "err");
        }
      });
    });

    tbody.querySelectorAll("[data-clear-media]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.clearMedia;
        if (!confirmAction("Delete all media files for this user?")) return;
        try {
          const r = await adminFetch(`/users/${id}/media`, { method: "DELETE" });
          toast(`Removed ${r.files_removed} files`);
          await loadUsers();
          await loadStats();
        } catch (ex) {
          toast(ex.message, "err");
        }
      });
    });
  }

  async function loadChats() {
    const { chats } = await adminFetch("/chats");
    const tbody = document.querySelector("#chats-table tbody");
    tbody.innerHTML = chats
      .map(
        (c) => `
      <tr>
        <td><code>${escapeHtml(c.chat_id)}</code></td>
        <td>${escapeHtml(c.type)}</td>
        <td>${escapeHtml(c.name || "—")}</td>
        <td>${c.message_count}</td>
        <td><code>${escapeHtml((c.members || []).join(", ").slice(0, 80))}</code></td>
        <td><button type="button" class="btn-danger" data-del-chat="${escapeHtml(c.chat_id)}">Purge</button></td>
      </tr>`
      )
      .join("");

    tbody.querySelectorAll("[data-del-chat]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const chatId = btn.dataset.delChat;
        if (!confirmAction(`Permanently delete chat ${chatId} and its media?`)) return;
        try {
          await adminFetch(`/chats/${encodeURIComponent(chatId)}`, { method: "DELETE" });
          toast("Chat purged");
          await loadChats();
          await loadStats();
        } catch (ex) {
          toast(ex.message, "err");
        }
      });
    });
  }

  async function loadMedia() {
    const filter = document.getElementById("media-user-filter").value.trim();
    const q = filter ? `?user_id=${encodeURIComponent(filter)}` : "";
    const { media } = await adminFetch("/media" + q);
    const tbody = document.querySelector("#media-table tbody");
    if (!media.length) {
      tbody.innerHTML = '<tr><td colspan="3">No media files</td></tr>';
      return;
    }
    tbody.innerHTML = media
      .map(
        (m) => `
      <tr>
        <td><code>${escapeHtml(m.path)}</code>${m.url ? `<br><a href="${escapeHtml(m.url)}" target="_blank" rel="noopener">open</a>` : ""}</td>
        <td>${escapeHtml(m.size_human)}</td>
        <td><button type="button" class="btn-danger" data-del-media="${escapeHtml(m.path)}">Delete</button></td>
      </tr>`
      )
      .join("");

    tbody.querySelectorAll("[data-del-media]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const path = btn.dataset.delMedia;
        if (!confirmAction(`Delete file ${path}?`)) return;
        try {
          await adminFetch("/media", { method: "DELETE", body: JSON.stringify({ path }) });
          toast("File deleted");
          await loadMedia();
          await loadStats();
        } catch (ex) {
          toast(ex.message, "err");
        }
      });
    });
  }

  async function loadEvents() {
    const { events } = await adminFetch("/events");
    const tbody = document.querySelector("#events-table tbody");
    tbody.innerHTML = events.length
      ? events
          .map(
            (ev) => `
      <tr>
        <td>${escapeHtml(ev.title || "—")}</td>
        <td><code>${escapeHtml(ev.event_id)}</code></td>
        <td><code>${escapeHtml(ev.group_id || "")}</code></td>
        <td>${ev.post_count}</td>
        <td><button type="button" class="btn-danger" data-del-event="${escapeHtml(ev.event_id)}">Delete</button></td>
      </tr>`
          )
          .join("")
      : '<tr><td colspan="5">No events</td></tr>';

    tbody.querySelectorAll("[data-del-event]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.delEvent;
        if (!confirmAction(`Delete event ${id}?`)) return;
        try {
          await adminFetch(`/events/${id}`, { method: "DELETE" });
          toast("Event deleted");
          await loadEvents();
          await loadStats();
        } catch (ex) {
          toast(ex.message, "err");
        }
      });
    });
  }

  document.getElementById("btn-media-load").addEventListener("click", () => loadMedia());

  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.action;
      const status = document.getElementById("maint-status");
      const inviteBox = document.getElementById("invite-result");

      if (action === "clear-invites") {
        if (!confirmAction("Clear all invite codes?")) return;
        try {
          await adminFetch("/maintenance/clear-invites", { method: "POST" });
          status.textContent = "Invites cleared.";
          toast("Invites cleared");
          await loadStats();
        } catch (ex) {
          toast(ex.message, "err");
        }
        return;
      }

      if (action === "create-invite") {
        try {
          const inv = await adminFetch("/maintenance/create-invite", { method: "POST" });
          inviteBox.textContent = JSON.stringify(inv, null, 2);
          inviteBox.classList.remove("hidden");
          toast(`Invite code: ${inv.code}`);
          await loadStats();
        } catch (ex) {
          toast(ex.message, "err");
        }
        return;
      }

      if (action === "clear-chunks") {
        if (!confirmAction("Delete all upload chunk temp files?")) return;
        try {
          const r = await adminFetch("/maintenance/clear-chunks", { method: "POST" });
          status.textContent = `Removed ${r.files_removed} chunk files.`;
          toast(status.textContent);
          await loadStats();
        } catch (ex) {
          toast(ex.message, "err");
        }
        return;
      }

      if (action === "clear-sessions") {
        if (!confirmAction("Log out ALL users (clear every session)?")) return;
        try {
          await adminFetch("/maintenance/clear-sessions", { method: "POST" });
          status.textContent = "All user sessions cleared.";
          toast(status.textContent);
          await loadStats();
        } catch (ex) {
          toast(ex.message, "err");
        }
      }
    });
  });

  async function loadAll() {
    await Promise.all([loadStats(), loadUsers(), loadChats(), loadEvents()]);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  checkAuth();
})();
