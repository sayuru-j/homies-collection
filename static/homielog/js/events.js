/** Group events list, detail view, RSVP, and create modal. */

let currentEventId = null;
let currentEventCanDelete = false;
let eventsCache = [];
let cachedGroups = [];

const eventsListEl = document.getElementById("events-list");
const eventDetailEl = document.getElementById("event-detail-view");
const messageComposerEl = document.getElementById("message-composer");
const eventDetailTitle = document.getElementById("event-detail-title");
const eventDetailGroup = document.getElementById("event-detail-group");
const eventDetailTime = document.getElementById("event-detail-time");
const eventDetailLocation = document.getElementById("event-detail-location");
const eventDetailDescription = document.getElementById("event-detail-description");
const eventRsvpSummary = document.getElementById("event-rsvp-summary");
const eventGoingList = document.getElementById("event-going-list");
const eventNotList = document.getElementById("event-not-list");
const eventNoResponseList = document.getElementById("event-noresponse-list");
const eventRsvpGoingBtn = document.getElementById("event-rsvp-going");
const eventRsvpNotBtn = document.getElementById("event-rsvp-not");
const deleteEventBtn = document.getElementById("delete-event-btn");
const createEventFromChatBtn = document.getElementById("create-event-from-chat-btn");
const toolbarMenuChat = document.getElementById("toolbar-menu-chat");
const toolbarMenuEvent = document.getElementById("toolbar-menu-event");
const eventPostsEl = document.getElementById("event-posts");
const eventPostsEmptyEl = document.getElementById("event-posts-empty");
let eventPostsLoadedFor = null;

function formatEventDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function rsvpLabel(status) {
  if (status === "going") return "Going";
  if (status === "not_going") return "Not going";
  return "";
}

function localDatetimeToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function hideEventDetail() {
  if (eventDetailEl) eventDetailEl.classList.add("hidden");
}

function showEventDetailPanel() {
  if (typeof showEmptyChat === "function") {
    document.getElementById("empty-state")?.classList.add("hidden");
    document.getElementById("messages")?.classList.add("hidden");
    document.getElementById("welcome-banner")?.classList.add("hidden");
  }
  if (eventDetailEl) eventDetailEl.classList.remove("hidden");
  if (messageComposerEl) messageComposerEl.classList.remove("hidden");
  if (typeof setComposerEnabled === "function") setComposerEnabled(true);
  const input = document.getElementById("message-input");
  if (input) input.placeholder = "Share what happened at this event…";
  if (typeof syncComposerInputHeight === "function") syncComposerInputHeight();
}

function closeEventView() {
  currentEventId = null;
  currentEventCanDelete = false;
  eventPostsLoadedFor = null;
  if (eventPostsEl) eventPostsEl.innerHTML = "";
  hideEventDetail();
  document.querySelectorAll(".event-item.active").forEach((el) => el.classList.remove("active"));
  updateChatToolbarMenu();
  const input = document.getElementById("message-input");
  if (input) input.placeholder = "Message @user";
  if (typeof syncComposerInputHeight === "function") syncComposerInputHeight();
}

function syncEventPostsEmpty() {
  if (!eventPostsEmptyEl || !eventPostsEl) return;
  const hasPosts = eventPostsEl.querySelector(".message-group") !== null;
  eventPostsEmptyEl.classList.toggle("hidden", hasPosts);
}

function eventPostAlreadyShown(postId) {
  if (!postId || !eventPostsEl) return false;
  return !!eventPostsEl.querySelector(`[data-message-id="${CSS.escape(postId)}"]`);
}

function renderEventPost(post, options = {}) {
  if (!eventPostsEl || typeof buildMessageElement !== "function" || typeof renderMessage !== "function") {
    return;
  }
  renderMessage(post, {
    ...options,
    container: eventPostsEl,
    forceFull: true,
    skipMenu: true,
  });
  syncEventPostsEmpty();
}

async function loadEventPosts(eventId) {
  if (!eventPostsEl || !eventId) return;
  eventPostsLoadedFor = eventId;
  eventPostsEl.innerHTML = "";
  try {
    const data = await api(`/api/events/${eventId}/posts`);
    (data.posts || []).forEach((p) => renderEventPost(p));
    if (typeof HomiesIcons !== "undefined") HomiesIcons.initIcons(eventPostsEl);
    const scroll = document.querySelector(".event-detail-scroll");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  } catch (ex) {
    if (eventPostsEmptyEl) {
      eventPostsEmptyEl.textContent = ex.message || "Could not load posts";
      eventPostsEmptyEl.classList.remove("hidden");
    }
  }
  syncEventPostsEmpty();
}

async function sendEventPost(body) {
  if (!currentEventId) throw new Error("No event open");
  const data = await api(`/api/events/${currentEventId}/posts`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (data.post && !eventPostAlreadyShown(data.post.id)) {
    renderEventPost(data.post);
    if (typeof HomiesIcons !== "undefined") HomiesIcons.initIcons(eventPostsEl);
    const scroll = document.querySelector(".event-detail-scroll");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }
  return data;
}

async function sendEventMedia(file, messageType, mediaType) {
  if (!currentEventId || !file) return;
  const pct = typeof getMediaCompressionPercent === "function" ? getMediaCompressionPercent() : 90;
  const doCompress = pct < 100;
  const signal = typeof beginActiveTransfer === "function" ? beginActiveTransfer() : null;

  try {
    if (doCompress && typeof setTransferStatus === "function") {
      setTransferStatus({
        stage: "compress",
        percent: 0,
        label: "Preparing compression…",
        originalSize: file.size,
        mediaType,
      });
    } else if (typeof setTransferStatus === "function") {
      setTransferStatus({ stage: "upload", percent: 0, label: "Uploading… 0%" });
    }

    const result = await uploadChunked(file, mediaType, {
      compress: doCompress,
      onProgress: (p) => {
        if (signal?.aborted) return;
        if (typeof setTransferStatus === "function") setTransferStatus({ mediaType, ...p });
      },
      signal: signal || undefined,
    });

    if (typeof throwIfTransferAborted === "function") throwIfTransferAborted(signal);
    if (typeof setTransferStatus === "function") {
      setTransferStatus({ stage: "upload", percent: 100, label: "Posting…" });
    }

    await sendEventPost({
      content: file.name,
      message_type: messageType,
      media_path: result.media_path,
      thumb_path: result.thumb_path || null,
    });
    if (typeof setTransferStatus === "function") setTransferStatus(null);
  } catch (ex) {
    if (typeof setTransferStatus === "function") setTransferStatus(null);
    if (typeof isTransferCancelled === "function" && isTransferCancelled(ex)) return;
    const status = document.getElementById("upload-status");
    if (status) status.textContent = ex.message;
    throw ex;
  }
}

function buildEventItem(ev) {
  const li = document.createElement("li");
  li.className = "dm-item event-item";
  if (ev.event_id === currentEventId) li.classList.add("active");
  li.dataset.eventId = ev.event_id;

  const pill =
    ev.my_rsvp === "going"
      ? '<span class="rsvp-pill rsvp-pill--going">Going</span>'
      : ev.my_rsvp === "not_going"
        ? '<span class="rsvp-pill rsvp-pill--not">Not going</span>'
        : "";

  const meta = document.createElement("div");
  meta.className = "dm-meta";
  meta.innerHTML = `
    <span class="dm-name">${escapeHtml(ev.title)}</span>
    <span class="dm-preview">${escapeHtml(ev.group_name || "")} · ${escapeHtml(formatEventDate(ev.starts_at))}</span>
  `;
  if (pill) {
    const pillWrap = document.createElement("span");
    pillWrap.className = "event-list-pill";
    pillWrap.innerHTML = pill;
    meta.appendChild(pillWrap);
  }

  const icon = document.createElement("div");
  icon.className = "dm-avatar-wrap";
  const ph = document.createElement("div");
  ph.className = "dm-avatar avatar-placeholder event-icon";
  ph.style.background = "var(--brand)";
  ph.innerHTML = '<i data-lucide="calendar" class="icon" aria-hidden="true"></i>';
  icon.appendChild(ph);

  li.appendChild(icon);
  li.appendChild(meta);
  li.onclick = () => openEvent(ev.event_id);
  return li;
}

async function refreshGroupsCache() {
  try {
    const data = await api("/api/chats/list");
    cachedGroups = (data.chats || []).filter((c) => c.type === "group");
  } catch (_) {
    cachedGroups = [];
  }
}

async function loadEvents() {
  if (!eventsListEl) return;
  try {
    const data = await api("/api/events");
    eventsCache = data.events || [];
  } catch (_) {
    eventsCache = [];
  }

  eventsListEl.innerHTML = "";
  const q = typeof searchQuery !== "undefined" ? searchQuery : "";
  const filtered = eventsCache.filter((ev) => {
    if (!q) return true;
    const hay = `${ev.title || ""} ${ev.group_name || ""}`.toLowerCase();
    return hay.includes(q);
  });

  if (!filtered.length) {
    const empty = document.createElement("li");
    empty.className = "events-empty";
    empty.textContent = q ? "No matching events" : "No upcoming events";
    eventsListEl.appendChild(empty);
    return;
  }

  filtered.forEach((ev) => eventsListEl.appendChild(buildEventItem(ev)));
  if (typeof HomiesIcons !== "undefined") HomiesIcons.initIcons(eventsListEl);
}

function renderMemberList(ul, members) {
  if (!ul) return;
  ul.innerHTML = "";
  if (!members?.length) {
    const li = document.createElement("li");
    li.className = "event-member-empty";
    li.textContent = "—";
    ul.appendChild(li);
    return;
  }
  members.forEach((m) => {
    const li = document.createElement("li");
    li.className = "event-member-item";
    li.textContent = m.display_name || m.name || "?";
    ul.appendChild(li);
  });
}

function updateRsvpButtons(myRsvp) {
  if (eventRsvpGoingBtn) {
    eventRsvpGoingBtn.classList.toggle("active", myRsvp === "going");
    eventRsvpGoingBtn.setAttribute("aria-pressed", myRsvp === "going" ? "true" : "false");
  }
  if (eventRsvpNotBtn) {
    eventRsvpNotBtn.classList.toggle("active", myRsvp === "not_going");
    eventRsvpNotBtn.setAttribute("aria-pressed", myRsvp === "not_going" ? "true" : "false");
  }
}

function renderEventDetail(data) {
  const ev = data.event || {};
  const group = data.group || {};
  const counts = data.counts || {};
  const myRsvp = me?.id ? (ev.rsvps || {})[me.id] : null;

  if (eventDetailTitle) eventDetailTitle.textContent = ev.title || "Event";
  if (eventDetailGroup) eventDetailGroup.textContent = group.name ? `# ${group.name}` : "";
  if (eventDetailTime) {
    let timeText = formatEventDate(ev.starts_at);
    if (ev.ends_at) timeText += ` — ${formatEventDate(ev.ends_at)}`;
    eventDetailTime.textContent = timeText;
  }
  if (eventDetailLocation) {
    const loc = (ev.location || "").trim();
    eventDetailLocation.textContent = loc ? `📍 ${loc}` : "";
    eventDetailLocation.classList.toggle("hidden", !loc);
  }
  if (eventDetailDescription) {
    const desc = (ev.description || "").trim();
    eventDetailDescription.textContent = desc;
    eventDetailDescription.classList.toggle("hidden", !desc);
  }
  if (eventRsvpSummary) {
    eventRsvpSummary.textContent = `${counts.going || 0} going · ${counts.not_going || 0} not going · ${counts.no_response || 0} no response`;
  }

  renderMemberList(eventGoingList, data.going);
  renderMemberList(eventNotList, data.not_going);
  renderMemberList(eventNoResponseList, data.no_response);
  updateRsvpButtons(myRsvp);
  currentEventCanDelete = !!data.can_delete;
  updateChatToolbarMenu();
}

async function deleteEvent(eventId) {
  if (!confirm("Delete this event? This cannot be undone.")) return;
  await api(`/api/events/${eventId}`, { method: "DELETE" });
  closeEventView();
  if (typeof closeChatView === "function") closeChatView();
  await loadEvents();
}

async function openEvent(eventId) {
  if (typeof VoiceCall !== "undefined" && VoiceCall.isInCall()) VoiceCall.forceEnd();
  if (typeof GroupMeshCall !== "undefined" && GroupMeshCall.isInCall()) GroupMeshCall.forceEnd();
  if (typeof GroupCall !== "undefined" && GroupCall.isInCall()) GroupCall.forceEnd();

  currentEventId = eventId;
  currentEventCanDelete = false;
  if (typeof currentChatId !== "undefined") {
    currentChatId = null;
    currentChatMeta = null;
  }
  updateChatToolbarMenu();
  document.querySelectorAll(".dm-item.active").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(`.event-item[data-event-id="${eventId}"]`).forEach((el) => el.classList.add("active"));

  if (typeof appEl !== "undefined" && typeof openChatView === "function") {
    openChatView();
    appEl.classList.add("chat-open");
  }

  const chatTitleEl = document.getElementById("chat-title");
  const hashEl = document.querySelector(".channel-hash");
  if (hashEl) hashEl.textContent = "📅";
  if (chatTitleEl) chatTitleEl.textContent = "Event";

  showEventDetailPanel();

  try {
    const data = await api(`/api/events/${eventId}`);
    if (chatTitleEl) chatTitleEl.textContent = data.event?.title || "Event";
    renderEventDetail(data);
    await loadEventPosts(eventId);
    updateChatToolbarMenu();
  } catch (ex) {
    if (chatTitleEl) chatTitleEl.textContent = "Event unavailable";
    if (eventRsvpSummary) eventRsvpSummary.textContent = ex.message || "Failed to load";
    updateChatToolbarMenu();
  }
}

async function setRsvp(eventId, status) {
  const data = await api(`/api/events/${eventId}/rsvp`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
  renderEventDetail(data);
  await loadEvents();
}

function populateEventGroupSelect(selectedGroupId = null) {
  const sel = document.getElementById("event-group-select");
  const field = document.getElementById("event-group-field");
  if (!sel) return;
  sel.innerHTML = "";
  cachedGroups.forEach((g) => {
    const opt = document.createElement("option");
    opt.value = g.group_id;
    opt.textContent = g.name;
    sel.appendChild(opt);
  });
  if (selectedGroupId) sel.value = selectedGroupId;
  if (field) field.classList.toggle("hidden", cachedGroups.length <= 1 && !!selectedGroupId);
}

function openCreateEventModal(presetGroupId = null) {
  const err = document.getElementById("event-form-error");
  if (err) {
    err.textContent = "";
    err.classList.add("hidden");
  }
  document.getElementById("event-title").value = "";
  document.getElementById("event-description").value = "";
  document.getElementById("event-location").value = "";
  document.getElementById("event-starts").value = "";
  document.getElementById("event-ends").value = "";

  populateEventGroupSelect(presetGroupId);
  const field = document.getElementById("event-group-field");
  if (field) field.classList.toggle("hidden", !!presetGroupId);

  if (typeof openModal === "function") openModal("event-modal");
  else document.getElementById("event-modal")?.classList.remove("hidden");
}

async function createEvent() {
  const err = document.getElementById("event-form-error");
  const title = document.getElementById("event-title")?.value?.trim();
  const groupId = document.getElementById("event-group-select")?.value;
  const starts = localDatetimeToIso(document.getElementById("event-starts")?.value);
  const ends = localDatetimeToIso(document.getElementById("event-ends")?.value);
  const location = document.getElementById("event-location")?.value?.trim() || "";
  const description = document.getElementById("event-description")?.value?.trim() || "";

  if (!title || !starts || !groupId) {
    if (err) {
      err.textContent = "Title, group, and start time are required.";
      err.classList.remove("hidden");
    }
    return;
  }

  try {
    const data = await api(`/api/groups/${groupId}/events`, {
      method: "POST",
      body: JSON.stringify({
        title,
        description,
        location,
        starts_at: starts,
        ends_at: ends,
      }),
    });
    if (typeof closeModal === "function") closeModal("event-modal");
    await loadEvents();
    if (data.event?.event_id) await openEvent(data.event.event_id);
    if (typeof loadChats === "function") await loadChats();
  } catch (ex) {
    if (err) {
      err.textContent = ex.message || "Failed to create event";
      err.classList.remove("hidden");
    }
  }
}

function updateChatToolbarMenu() {
  const chatMenuBtn = document.getElementById("chat-menu-btn");
  const deleteChatBtn = document.getElementById("delete-chat-btn");
  const inEvent = !!currentEventId;
  const inChat = !!currentChatId && !inEvent;

  const isGroup =
    (typeof currentChatMeta !== "undefined" && currentChatMeta?.type === "group") ||
    (typeof currentChatId !== "undefined" && currentChatId?.startsWith("group_"));
  const groupId =
    currentChatMeta?.group_id ||
    (currentChatId?.startsWith("group_") ? currentChatId.slice(6) : null);
  const showCreate = isGroup && !!groupId && inChat;
  const showDeleteEvent = inEvent && currentEventCanDelete;

  if (toolbarMenuChat) {
    toolbarMenuChat.classList.toggle("hidden", inEvent || !inChat);
  }
  if (toolbarMenuEvent) {
    toolbarMenuEvent.classList.toggle("hidden", !showDeleteEvent);
  }

  if (createEventFromChatBtn) {
    createEventFromChatBtn.classList.toggle("hidden", !showCreate);
    createEventFromChatBtn.disabled = !showCreate;
  }

  if (deleteEventBtn) {
    deleteEventBtn.disabled = !showDeleteEvent;
  }

  if (deleteChatBtn) {
    deleteChatBtn.disabled = !inChat;
  }

  if (chatMenuBtn) {
    chatMenuBtn.disabled = !(inChat || showDeleteEvent);
    chatMenuBtn.setAttribute(
      "aria-label",
      inEvent ? "Event options" : "Chat options"
    );
  }
}

function handleWsEventMessage(data) {
  if (data.type === "event_post") {
    if (data.event_id === currentEventId && data.post && !eventPostAlreadyShown(data.post.id)) {
      renderEventPost(data.post);
      if (typeof HomiesIcons !== "undefined") HomiesIcons.initIcons(eventPostsEl);
    }
    return true;
  }
  if (data.type === "event_post_deleted") {
    if (data.event_id === currentEventId && data.post_id && typeof removeMessageElement === "function") {
      removeMessageElement(data.post_id, eventPostsEl);
      syncEventPostsEmpty();
    }
    return true;
  }
  if (data.type !== "event_updated" && data.type !== "event_deleted") return false;
  loadEvents();
  if (data.type === "event_deleted" && data.event_id === currentEventId) {
    closeEventView();
    if (typeof showEmptyChat === "function") showEmptyChat();
    return true;
  }
  if (data.type === "event_updated" && data.event_id === currentEventId) {
    openEvent(data.event_id);
  }
  return true;
}

createEventFromChatBtn?.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (typeof closeAllMessageMenus === "function") closeAllMessageMenus();
  const groupId =
    currentChatMeta?.group_id ||
    (currentChatId?.startsWith("group_") ? currentChatId.slice(6) : null);
  if (!groupId) return;
  await refreshGroupsCache();
  openCreateEventModal(groupId);
});

document.getElementById("event-submit-btn")?.addEventListener("click", createEvent);

eventRsvpGoingBtn?.addEventListener("click", () => {
  if (currentEventId) setRsvp(currentEventId, "going").catch((ex) => alert(ex.message));
});

eventRsvpNotBtn?.addEventListener("click", () => {
  if (currentEventId) setRsvp(currentEventId, "not_going").catch((ex) => alert(ex.message));
});

deleteEventBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (typeof closeAllMessageMenus === "function") closeAllMessageMenus();
  if (currentEventId) deleteEvent(currentEventId).catch((ex) => alert(ex.message));
});

window.HomiesEvents = {
  loadEvents,
  openEvent,
  closeEventView,
  handleWsEventMessage,
  updateChatToolbarMenu,
  refreshGroupsCache,
  sendEventPost,
  sendEventMedia,
  get currentEventId() {
    return currentEventId;
  },
};
