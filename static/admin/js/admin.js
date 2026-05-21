/**
 * HomieLog Control Panel
 */
(function () {
  const API = "/api/admin";
  const PAGE_META = {
    overview: { title: "Overview", sub: "System health and capacity" },
    server: { title: "Server", sub: "Maintenance, backups, broadcasts" },
    users: { title: "Users", sub: "Accounts and sessions" },
    chats: { title: "Chats", sub: "Conversations on disk" },
    media: { title: "Media", sub: "Files and orphan cleanup" },
    events: { title: "Events", sub: "Group calendar data" },
    tools: { title: "Tools", sub: "Invites, chunks, session reset" },
  };

  let statsCache = null;
  let refreshTimer = null;
  let modalConfirmHandler = null;

  async function adminFetch(path, options = {}) {
    const res = await fetch(API + path, {
      ...options,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { detail: text };
    }
    if (!res.ok) {
      const msg = data?.detail || res.statusText;
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
    el._t = setTimeout(() => el.classList.add("hidden"), 4500);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showModal(title, body, onConfirm) {
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-body").textContent = body;
    modalConfirmHandler = onConfirm;
    document.getElementById("modal").classList.remove("hidden");
  }

  function hideModal() {
    document.getElementById("modal").classList.add("hidden");
    modalConfirmHandler = null;
  }

  document.querySelectorAll("[data-modal-close]").forEach((el) => {
    el.addEventListener("click", hideModal);
  });
  document.getElementById("modal-confirm").addEventListener("click", async () => {
    if (modalConfirmHandler) await modalConfirmHandler();
    hideModal();
  });

  function confirmModal(title, body) {
    return new Promise((resolve) => {
      showModal(title, body, () => {
        resolve(true);
      });
    });
  }

  function setDiskBar(barId, pct) {
    const bar = document.getElementById(barId);
    if (!bar) return;
    const p = Math.min(100, Math.max(0, pct || 0));
    bar.style.width = p + "%";
    bar.classList.remove("warn", "critical");
    if (p >= 90) bar.classList.add("critical");
    else if (p >= 75) bar.classList.add("warn");
  }

  function renderDisk(s) {
    const root = s.disk_root || {};
    const data = s.disk_data || {};
    document.getElementById("disk-root-path").textContent = root.path || "/";
    document.getElementById("disk-root-used").textContent =
      (root.used_human || "—") + " (" + (root.percent ?? 0) + "%)";
    document.getElementById("disk-root-free").textContent = (root.free_human || "—") + " free";
    document.getElementById("disk-root-total").textContent = root.total_human || "— total";
    setDiskBar("disk-root-bar", root.percent);

    document.getElementById("disk-data-used").textContent = data.used_human || "—";
    document.getElementById("disk-data-pct").textContent =
      data.available ? data.percent + "% of " + data.total_human + " on mount" : "unavailable";
    setDiskBar("disk-data-bar", data.percent);
  }

  function renderMaintenanceBanner(s) {
    const alert = document.getElementById("maint-alert");
    const pill = document.getElementById("status-pill");
    const m = s.maintenance || {};
    if (m.enabled) {
      alert.textContent = "Maintenance mode ON — public app is offline. " + (m.message || "");
      alert.classList.remove("hidden");
      pill.textContent = "Maintenance";
      pill.className = "status-pill status-maint";
      document.getElementById("maint-message").value = m.message || "";
    } else {
      alert.classList.add("hidden");
      pill.textContent = "Online";
      pill.className = "status-pill status-ok";
    }
  }

  async function loadStats() {
    const s = await adminFetch("/stats");
    statsCache = s;
    renderDisk(s);
    renderMaintenanceBanner(s);

    const grid = document.getElementById("stats-grid");
    const cards = [
      ["Users", s.users],
      ["Online", s.online],
      ["WS connections", s.websocket_connections],
      ["Sessions", s.sessions],
      ["Chats", s.chats],
      ["Groups", s.groups],
      ["Events", s.events],
      ["App data", s.data_size_human],
      ["Media", s.media_size_human],
      ["Invites", s.active_invites],
      ["Perm code", s.permanent_invite_enabled ? s.permanent_invite_code || "on" : "off"],
      ["Chunk files", s.chunk_files],
      ["Backups", s.backup_count],
    ];
    grid.innerHTML = cards
      .map(
        ([label, value]) =>
          `<div class="stat-card"><div class="value">${escapeHtml(String(value))}</div><div class="label">${escapeHtml(label)}</div></div>`
      )
      .join("");

    const breakdown = s.storage_breakdown || {};
    const totalData = s.data_size || 1;
    const tbody = document.querySelector("#storage-table tbody");
    tbody.innerHTML = Object.entries(breakdown)
      .map(([key, v]) => {
        const pct = totalData ? ((v.bytes / totalData) * 100).toFixed(1) : 0;
        return `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(v.human)}</td><td>${pct}%</td></tr>`;
      })
      .join("");

    const sys = s.system || {};
    document.getElementById("system-dl").innerHTML = [
      ["Hostname", sys.hostname],
      ["Uptime", sys.uptime_human],
      ["Started", sys.started_at],
      ["Python", sys.python],
      ["Platform", sys.platform],
      ["App version", s.app_version],
    ]
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v || "—")}</dd>`)
      .join("");
  }

  async function loadPermanentInvite() {
    const perm = await adminFetch("/permanent-invite");
    const input = document.getElementById("perm-invite-code");
    const status = document.getElementById("perm-invite-status");
    if (perm.enabled && perm.code) {
      input.value = perm.code;
      status.textContent = "Active — reusable for registration. Set at " + (perm.set_at || "").slice(0, 19);
    } else {
      input.value = "";
      status.textContent = "Not set — only temporary invite codes work.";
    }
  }

  async function loadBackups() {
    const { backups } = await adminFetch("/maintenance/backups");
    const tbody = document.querySelector("#backups-table tbody");
    tbody.innerHTML = backups.length
      ? backups
          .map(
            (b) =>
              `<tr><td><code>${escapeHtml(b.filename)}</code></td><td>${escapeHtml(b.size_human)}</td><td>${escapeHtml((b.modified_at || "").slice(0, 19))}</td></tr>`
          )
          .join("")
      : "<tr><td colspan='3'>No backups yet</td></tr>";
  }

  async function loadUsers() {
    const { users } = await adminFetch("/users");
    const tbody = document.querySelector("#users-table tbody");
    tbody.innerHTML = users
      .map(
        (u) => `
      <tr>
        <td>
          <strong>${escapeHtml(u.display_name || u.name)}</strong>
          <br><code>${escapeHtml(u.id)}</code>
        </td>
        <td><span class="badge ${u.online ? "badge-ok" : "badge-off"}">${u.online ? "Online" : "Offline"}</span></td>
        <td>${u.session_count}</td>
        <td>${escapeHtml(u.media_size_human)}</td>
        <td>
          <div class="action-group">
            <button type="button" class="btn btn-sm btn-warn" data-kick="${escapeHtml(u.id)}" data-name="${escapeHtml(u.name)}">Kick</button>
            <button type="button" class="btn btn-sm btn-secondary" data-clear-media="${escapeHtml(u.id)}">Clear media</button>
            <button type="button" class="btn btn-sm btn-danger" data-del-user="${escapeHtml(u.id)}" data-name="${escapeHtml(u.name)}">Delete</button>
          </div>
        </td>
      </tr>`
      )
      .join("");

    bindUserActions(tbody);
  }

  function bindUserActions(tbody) {
    tbody.querySelectorAll("[data-del-user]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.delUser;
        const name = btn.dataset.name;
        showModal(
          "Delete user",
          `Permanently delete "${name}" including DMs, media, and sessions?`,
          async () => {
            const r = await adminFetch(`/users/${id}`, { method: "DELETE" });
            toast(`Deleted ${r.name}`);
            await loadAll();
          }
        );
      };
    });
    tbody.querySelectorAll("[data-kick]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.kick;
        showModal("Kick user", `Disconnect "${btn.dataset.name}" and revoke sessions?`, async () => {
          const r = await adminFetch(`/users/${id}/kick`, { method: "POST" });
          toast(`Kicked — ${r.websockets_closed} socket(s)`);
          await loadUsers();
          await loadStats();
        });
      };
    });
    tbody.querySelectorAll("[data-clear-media]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.clearMedia;
        showModal("Clear media", "Delete all uploaded files for this user?", async () => {
          const r = await adminFetch(`/users/${id}/media`, { method: "DELETE" });
          toast(`Removed ${r.files_removed} file(s)`);
          await loadUsers();
          await loadStats();
        });
      };
    });
  }

  async function loadChats() {
    const { chats } = await adminFetch("/chats");
    const tbody = document.querySelector("#chats-table tbody");
    tbody.innerHTML = chats.length
      ? chats
          .map(
            (c) => `
        <tr>
          <td><strong>${escapeHtml(c.name || c.chat_id)}</strong><br><code>${escapeHtml(c.chat_id)}</code></td>
          <td>${escapeHtml(c.type)}</td>
          <td>${c.message_count}</td>
          <td><code>${escapeHtml((c.members || []).join(", ").slice(0, 60))}</code></td>
          <td><button type="button" class="btn btn-sm btn-danger" data-del-chat="${escapeHtml(c.chat_id)}">Purge</button></td>
        </tr>`
          )
          .join("")
      : "<tr><td colspan='5'>No chats</td></tr>";

    tbody.querySelectorAll("[data-del-chat]").forEach((btn) => {
      btn.onclick = async () => {
        const chatId = btn.dataset.delChat;
        showModal("Purge chat", `Delete ${chatId} and all message media?`, async () => {
          await adminFetch(`/chats/${encodeURIComponent(chatId)}`, { method: "DELETE" });
          toast("Chat purged");
          await loadChats();
          await loadStats();
        });
      };
    });
  }

  async function loadMedia() {
    const filter = document.getElementById("media-user-filter").value.trim();
    const q = filter ? `?user_id=${encodeURIComponent(filter)}` : "";
    const { media } = await adminFetch("/media" + q);
    const tbody = document.querySelector("#media-table tbody");
    tbody.innerHTML = media.length
      ? media
          .map(
            (m) => `
        <tr>
          <td><code>${escapeHtml(m.path)}</code>${m.url ? ` <a href="${escapeHtml(m.url)}" target="_blank" rel="noopener">view</a>` : ""}</td>
          <td>${escapeHtml(m.size_human)}</td>
          <td><button type="button" class="btn btn-sm btn-danger" data-del-media="${escapeHtml(m.path)}">Delete</button></td>
        </tr>`
          )
          .join("")
      : "<tr><td colspan='3'>No files</td></tr>";

    tbody.querySelectorAll("[data-del-media]").forEach((btn) => {
      btn.onclick = async () => {
        const path = btn.dataset.delMedia;
        showModal("Delete file", path, async () => {
          await adminFetch("/media", { method: "DELETE", body: JSON.stringify({ path }) });
          toast("File deleted");
          await loadMedia();
          await loadStats();
        });
      };
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
          <td><button type="button" class="btn btn-sm btn-danger" data-del-event="${escapeHtml(ev.event_id)}">Delete</button></td>
        </tr>`
          )
          .join("")
      : "<tr><td colspan='5'>No events</td></tr>";

    tbody.querySelectorAll("[data-del-event]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.delEvent;
        showModal("Delete event", id, async () => {
          await adminFetch(`/events/${id}`, { method: "DELETE" });
          toast("Event deleted");
          await loadEvents();
          await loadStats();
        });
      };
    });
  }

  function showLogin() {
    document.getElementById("login-screen").classList.remove("hidden");
    document.getElementById("dashboard").classList.add("hidden");
    if (refreshTimer) clearInterval(refreshTimer);
  }

  function showDashboard() {
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("dashboard").classList.remove("hidden");
    refreshTimer = setInterval(() => {
      if (document.querySelector("#panel-overview.active")) loadStats().catch(() => {});
    }, 30000);
  }

  function setTab(tab) {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + tab));
    const meta = PAGE_META[tab] || PAGE_META.overview;
    document.getElementById("page-title").textContent = meta.title;
    document.getElementById("page-subtitle").textContent = meta.sub;
    if (tab === "media") loadMedia().catch(() => {});
    if (tab === "server") {
      loadBackups().catch(() => {});
      loadPermanentInvite().catch(() => {});
    }
  }

  async function loadAll() {
    await Promise.all([loadStats(), loadUsers(), loadChats(), loadEvents(), loadBackups()]);
  }

  document.getElementById("admin-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("login-error");
    errEl.classList.add("hidden");
    try {
      await adminFetch("/login", {
        method: "POST",
        body: JSON.stringify({ password: document.getElementById("admin-password").value }),
      });
      document.getElementById("admin-password").value = "";
      showDashboard();
      setTab("overview");
      await loadAll();
      toast("Welcome");
    } catch (ex) {
      errEl.textContent = ex.message;
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

  document.getElementById("btn-refresh").addEventListener("click", () => loadAll().then(() => toast("Refreshed")));

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });

  document.getElementById("btn-maint-on").addEventListener("click", async () => {
    showModal(
      "Enable maintenance",
      "Public site and WebSockets will go offline. Admin panel stays up.",
      async () => {
        const msg = document.getElementById("maint-message").value.trim();
        await adminFetch("/maintenance", {
          method: "POST",
          body: JSON.stringify({ enabled: true, message: msg || undefined }),
        });
        toast("Maintenance mode enabled");
        await loadStats();
      }
    );
  });

  document.getElementById("btn-maint-off").addEventListener("click", async () => {
    await adminFetch("/maintenance", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });
    toast("Server is online");
    await loadStats();
  });

  document.getElementById("btn-perm-invite-save").addEventListener("click", async () => {
    const raw = document.getElementById("perm-invite-code").value.trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length !== 4) {
      toast("Enter exactly 4 digits", "err");
      return;
    }
    try {
      await adminFetch("/permanent-invite", {
        method: "PUT",
        body: JSON.stringify({ code: digits }),
      });
      toast("Permanent code saved");
      await loadPermanentInvite();
      await loadStats();
    } catch (ex) {
      toast(ex.message, "err");
    }
  });

  document.getElementById("btn-perm-invite-clear").addEventListener("click", async () => {
    showModal("Disable permanent code", "New users will need temporary invite codes again.", async () => {
      await adminFetch("/permanent-invite", {
        method: "PUT",
        body: JSON.stringify({ code: null }),
      });
      document.getElementById("perm-invite-code").value = "";
      toast("Permanent code disabled");
      await loadPermanentInvite();
      await loadStats();
    });
  });

  document.getElementById("btn-broadcast").addEventListener("click", async () => {
    const text = document.getElementById("broadcast-text").value.trim();
    if (!text) {
      toast("Enter a message", "err");
      return;
    }
    const r = await adminFetch("/broadcast", { method: "POST", body: JSON.stringify({ text }) });
    toast(`Broadcast sent to ${r.recipients} user(s)`);
  });

  document.getElementById("btn-backup").addEventListener("click", async () => {
    showModal("Create backup", "Archive all data/ to data/backups/?", async () => {
      toast("Creating backup…");
      const r = await adminFetch("/maintenance/backup", { method: "POST" });
      toast(`Backup: ${r.filename} (${r.size_human})`);
      await loadBackups();
      await loadStats();
    });
  });

  document.getElementById("btn-media-load").addEventListener("click", () => loadMedia());
  document.getElementById("btn-orphan-scan").addEventListener("click", async () => {
    const r = await adminFetch("/media/orphans");
    const box = document.getElementById("orphan-summary");
    box.textContent = `${r.orphan_count} orphan file(s), ${r.orphan_size_human} total`;
    box.classList.remove("hidden");
    toast("Orphan scan complete");
  });
  document.getElementById("btn-orphan-purge").addEventListener("click", async () => {
    showModal("Purge orphans", "Delete media files not referenced in chats/profiles?", async () => {
      const r = await adminFetch("/media/orphans/purge", { method: "POST" });
      toast(`Removed ${r.files_removed} file(s)`);
      document.getElementById("orphan-summary").classList.add("hidden");
      await loadMedia();
      await loadStats();
    });
  });

  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.action;
      const status = document.getElementById("tools-status");
      const inviteBox = document.getElementById("invite-result");

      if (action === "clear-invites") {
        showModal("Clear invites", "Remove all invite codes?", async () => {
          await adminFetch("/maintenance/clear-invites", { method: "POST" });
          status.textContent = "Invites cleared.";
          toast("Invites cleared");
          await loadStats();
        });
        return;
      }
      if (action === "create-invite") {
        const inv = await adminFetch("/maintenance/create-invite", { method: "POST" });
        inviteBox.textContent = JSON.stringify(inv, null, 2);
        inviteBox.classList.remove("hidden");
        toast(`Invite: ${inv.code}`);
        await loadStats();
        return;
      }
      if (action === "clear-chunks") {
        showModal("Clear chunks", "Delete temporary upload parts?", async () => {
          const r = await adminFetch("/maintenance/clear-chunks", { method: "POST" });
          status.textContent = `Removed ${r.files_removed} chunk file(s).`;
          toast(status.textContent);
          await loadStats();
        });
        return;
      }
      if (action === "clear-sessions") {
        showModal("Clear sessions", "Force logout for every user?", async () => {
          await adminFetch("/maintenance/clear-sessions", { method: "POST" });
          status.textContent = "All sessions cleared.";
          toast(status.textContent);
          await loadStats();
        });
      }
    });
  });

  async function checkAuth() {
    try {
      await adminFetch("/me");
      showDashboard();
      setTab("overview");
      await loadAll();
    } catch {
      showLogin();
    }
  }

  checkAuth();
})();
