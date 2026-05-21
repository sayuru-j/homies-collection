let me = null;
let currentChatId = null;
let currentChatMeta = null;
let ws = null;
let mediaRecorder = null;
let voiceChunks = [];
let voiceRecordStream = null;
let voiceRecordStart = 0;
let voiceRecordTimer = null;
let previewAudio = null;
let activeVoiceAudio = null;
let activeVoiceEl = null;

const MIN_VOICE_SECONDS = 0.5;
let searchQuery = "";
/** @type {{ file: File, messageType: string, mediaType: string, previewUrl: string } | null} */
let pendingAttachment = null;

const AVATAR_COLORS = [
  "#5865f2", "#57f287", "#fee75c", "#eb459e", "#ed4245", "#f47fff", "#e67e22", "#1abc9c",
];

const MESSAGES_PAGE_SIZE = 10;

const appEl = document.getElementById("app");
const messagesEl = document.getElementById("messages");
const messagesTopEl = document.getElementById("messages-top");
const emptyStateEl = document.getElementById("empty-state");
const welcomeBannerEl = document.getElementById("welcome-banner");
const chatTitleEl = document.getElementById("chat-title");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const uploadStatus = document.getElementById("upload-status");

/** Single-panel mode: phones show sidebar OR chat, not both */
const SINGLE_PANEL_MQ = window.matchMedia("(max-width: 767px)");

function isSinglePanelLayout() {
  return SINGLE_PANEL_MQ.matches;
}

/** Short placeholder so long names don't overflow the composer on narrow screens */
function composerPlaceholder(title, isGroup) {
  const name = String(title || "").trim();
  const prefix = isGroup ? "Message #" : "Message @";
  const maxNameLen = isSinglePanelLayout() ? 12 : 28;
  if (!name) return isGroup ? "Message" : "Message";
  const short =
    name.length > maxNameLen ? `${name.slice(0, Math.max(1, maxNameLen - 1))}…` : name;
  return `${prefix}${short}`;
}

function syncLayoutState() {
  if (!isSinglePanelLayout()) {
    appEl.classList.remove("chat-open");
  } else if (currentChatId) {
    appEl.classList.add("chat-open");
  }
  if (currentChatId && currentChatMeta?.title != null) {
    messageInput.placeholder = composerPlaceholder(
      currentChatMeta.title,
      currentChatMeta.type === "group"
    );
  }
}

function openChatView() {
  if (isSinglePanelLayout()) appEl.classList.add("chat-open");
}

function getDmPeerId() {
  if (currentChatMeta?.type === "dm" && currentChatMeta?.id) return currentChatMeta.id;
  if (!currentChatId?.startsWith("dm_") || !me?.id) return null;
  const rest = currentChatId.slice(3);
  if (rest.startsWith(`${me.id}_`)) return rest.slice(me.id.length + 1);
  if (rest.endsWith(`_${me.id}`)) return rest.slice(0, -(me.id.length + 1));
  return null;
}

let callsConfig = {
  group_calls_enabled: false,
  mesh_group_max: 6,
  livekit: { enabled: false },
};

async function loadCallsConfig() {
  try {
    callsConfig = await api("/api/calls/config");
  } catch (_) {
    callsConfig = { mesh_group_max: 6, livekit: { enabled: false } };
  }
  if (!callsConfig.livekit) {
    callsConfig.livekit = { enabled: false, url: null };
  }
  return callsConfig;
}

function getGroupMemberCount() {
  const n = currentChatMeta?.members?.length;
  return typeof n === "number" && n > 0 ? n : 0;
}

function groupCallsEnabled() {
  return callsConfig.group_calls_enabled === true;
}

function groupCallStrategy() {
  if (!groupCallsEnabled()) return "none";
  const count = getGroupMemberCount();
  const maxMesh = callsConfig.mesh_group_max ?? 6;
  if (count < 2) return "none";
  if (count <= maxMesh) return "mesh";
  if (callsConfig.livekit?.enabled) return "livekit";
  return "none";
}

function anyCallIdle() {
  const voiceIdle = typeof VoiceCall === "undefined" || VoiceCall.isIdle();
  const groupIdle = typeof GroupCall === "undefined" || GroupCall.isIdle();
  const meshIdle = typeof GroupMeshCall === "undefined" || GroupMeshCall.isIdle();
  return voiceIdle && groupIdle && meshIdle;
}

/** User collapsed full-screen call UI; call continues in background. */
let callUiMinimized = false;

const CALL_PIP_POS_KEY = "homies-call-pip-pos";
let callPipDrag = { active: false, pointerId: null, offsetX: 0, offsetY: 0 };

function resetCallPipPosition() {
  const card = document.getElementById("call-card");
  if (!card) return;
  card.style.left = "";
  card.style.top = "";
  card.style.bottom = "";
  card.style.transform = "";
  card.classList.remove("call-pip-custom-pos", "call-pip-dragging");
  try {
    sessionStorage.removeItem(CALL_PIP_POS_KEY);
  } catch (_) {
    /* ignore */
  }
}

function applyCallPipPosition() {
  const card = document.getElementById("call-card");
  if (!card) return;
  try {
    const raw = sessionStorage.getItem(CALL_PIP_POS_KEY);
    if (!raw) return;
    const { left, top } = JSON.parse(raw);
    if (typeof left !== "number" || typeof top !== "number") return;
    card.classList.add("call-pip-custom-pos");
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    card.style.bottom = "auto";
    card.style.transform = "none";
  } catch (_) {
    /* ignore */
  }
}

function saveCallPipPosition(left, top) {
  try {
    sessionStorage.setItem(CALL_PIP_POS_KEY, JSON.stringify({ left, top }));
  } catch (_) {
    /* ignore */
  }
}

function clampCallPipPosition(left, top, card) {
  const pad = 8;
  const w = card.offsetWidth || 320;
  const h = card.offsetHeight || 72;
  const maxLeft = Math.max(pad, window.innerWidth - w - pad);
  const maxTop = Math.max(pad, window.innerHeight - h - pad);
  return {
    left: Math.min(maxLeft, Math.max(pad, left)),
    top: Math.min(maxTop, Math.max(pad, top)),
  };
}

function initCallPipDrag() {
  const card = document.getElementById("call-card");
  const overlay = document.getElementById("call-overlay");
  if (!card || card.dataset.pipDragInit) return;
  card.dataset.pipDragInit = "1";

  function pipActive() {
    return overlay?.classList.contains("call-overlay--minimized");
  }

  function isDragBlockedTarget(target) {
    return !!target.closest(
      ".call-action-btn, .call-chrome-btn, .call-mute-btn, .call-record-btn, .call-end-btn, button, a, input"
    );
  }

  card.addEventListener("pointerdown", (e) => {
    if (!pipActive() || isDragBlockedTarget(e.target)) return;
    const rect = card.getBoundingClientRect();
    callPipDrag.active = true;
    callPipDrag.pointerId = e.pointerId;
    callPipDrag.offsetX = e.clientX - rect.left;
    callPipDrag.offsetY = e.clientY - rect.top;
    card.classList.add("call-pip-dragging", "call-pip-custom-pos");
    card.style.bottom = "auto";
    card.style.transform = "none";
    try {
      card.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    e.preventDefault();
  });

  card.addEventListener("pointermove", (e) => {
    if (!callPipDrag.active || e.pointerId !== callPipDrag.pointerId) return;
    const pos = clampCallPipPosition(
      e.clientX - callPipDrag.offsetX,
      e.clientY - callPipDrag.offsetY,
      card
    );
    card.style.left = `${pos.left}px`;
    card.style.top = `${pos.top}px`;
    saveCallPipPosition(pos.left, pos.top);
  });

  function endDrag(e) {
    if (!callPipDrag.active) return;
    if (e && e.pointerId !== callPipDrag.pointerId) return;
    callPipDrag.active = false;
    callPipDrag.pointerId = null;
    card.classList.remove("call-pip-dragging");
    try {
      card.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
  }

  card.addEventListener("pointerup", endDrag);
  card.addEventListener("pointercancel", endDrag);
  window.addEventListener("resize", () => {
    if (!pipActive() || !card.classList.contains("call-pip-custom-pos")) return;
    const left = parseFloat(card.style.left);
    const top = parseFloat(card.style.top);
    if (Number.isNaN(left) || Number.isNaN(top)) return;
    const pos = clampCallPipPosition(left, top, card);
    card.style.left = `${pos.left}px`;
    card.style.top = `${pos.top}px`;
    saveCallPipPosition(pos.left, pos.top);
  });
}

function setCallMinimized(minimized) {
  callUiMinimized = !!minimized;
  const overlay = document.getElementById("call-overlay");
  const card = document.getElementById("call-card");
  if (overlay && !overlay.classList.contains("hidden")) {
    overlay.classList.toggle("call-overlay--minimized", callUiMinimized);
  }
  if (callUiMinimized) {
    applyCallPipPosition();
  } else {
    resetCallPipPosition();
  }
}

function syncCallChrome(ui) {
  const overlay = document.getElementById("call-overlay");
  const canMinimize = ["active", "connecting", "outgoing"].includes(ui.state);
  const minimizeBtn = document.getElementById("call-minimize-btn");
  const expandBtn = document.getElementById("call-expand-btn");

  if (ui.state === "idle" || ui.state === "incoming") {
    callUiMinimized = false;
    resetCallPipPosition();
  }

  const showMinimized =
    callUiMinimized && ui.state !== "idle" && ui.state !== "incoming";
  overlay?.classList.toggle("call-overlay--minimized", showMinimized);

  minimizeBtn?.classList.toggle("hidden", !canMinimize || showMinimized);
  expandBtn?.classList.toggle("hidden", !showMinimized);

  if (typeof refreshUiIcons === "function") {
    refreshUiIcons(minimizeBtn?.parentElement);
  }
}

function updateCallButton() {
  const voiceBtn = document.getElementById("call-btn");
  const videoBtn = document.getElementById("video-call-btn");
  if (typeof VoiceCall === "undefined" && typeof GroupCall === "undefined") return;

  const peerId = getDmPeerId();
  const isDm = currentChatMeta?.type === "dm" || currentChatId?.startsWith("dm_");
  const isGroup =
    currentChatMeta?.type === "group" || currentChatId?.startsWith("group_");
  const strategy = isGroup ? groupCallStrategy() : "none";
  const dmShow = isDm && peerId && anyCallIdle();
  const groupShow = isGroup && currentChatId && strategy !== "none" && anyCallIdle();

  [voiceBtn, videoBtn].forEach((btn) => {
    if (!btn) return;
    const show = dmShow || groupShow;
    btn.classList.toggle("hidden", !show);
    btn.disabled = !show;
    if (groupShow && !dmShow) {
      btn.title =
        btn.id === "video-call-btn"
          ? "Start group video call"
          : "Start group voice call";
    }
  });
}

let callNoticeTimer = null;

function showCallNotice(text) {
  if (!uploadStatus || !text) return;
  if (callNoticeTimer) {
    clearTimeout(callNoticeTimer);
    callNoticeTimer = null;
  }
  uploadStatus.textContent = text;
  callNoticeTimer = setTimeout(() => {
    if (uploadStatus?.textContent === text) uploadStatus.textContent = "";
    callNoticeTimer = null;
  }, 6000);
}

function callFailureMessage(reason, peerName) {
  const who = peerName || currentChatMeta?.title || "They";
  if (reason === "offline") return `${who} isn't online.`;
  if (reason === "busy") return `${who} is busy.`;
  if (reason === "declined") return `${who} declined the call.`;
  if (reason === "connection_lost") return "Call disconnected.";
  if (reason === "call_cancel") return "Call cancelled.";
  return null;
}

function updateGroupCallOverlay(ui) {
  const overlay = document.getElementById("call-overlay");
  const card = document.getElementById("call-card");
  if (!overlay) return;

  const nameEl = document.getElementById("call-peer-name");
  const statusEl = document.getElementById("call-status-text");
  const incoming = document.getElementById("call-incoming-actions");
  const active = document.getElementById("call-active-actions");
  const outgoing = document.getElementById("call-outgoing-actions");
  const muteBtn = document.getElementById("call-mute-btn");
  const groupStage = document.getElementById("call-group-stage");
  const videoStage = document.getElementById("call-video-stage");
  const audioStage = document.getElementById("call-audio-stage");
  const avatarEl = document.getElementById("call-avatar");
  const durationAudio = document.getElementById("call-duration");

  if (ui.state === "idle") {
    overlay.classList.add("hidden");
    overlay.classList.remove("call-overlay--minimized");
    card?.classList.remove("call-card--group", "call-card--video");
    groupStage?.classList.add("hidden");
    updateCallButton();
    syncCallChrome(ui);
    return;
  }

  overlay.classList.remove("hidden");
  card?.classList.add("call-card--group");
  card?.classList.toggle("call-card--video", ui.callMode === "video");

  const title = ui.chatTitle || currentChatMeta?.title || "Group";
  if (nameEl) nameEl.textContent = title;

  const isVideo = ui.callMode === "video";
  const inRoom = ui.state === "active" || ui.state === "connecting";
  groupStage?.classList.toggle("hidden", !inRoom);
  videoStage?.classList.add("hidden");
  audioStage?.classList.toggle("hidden", inRoom);

  if (!inRoom && avatarEl) {
    applyAvatarEl(avatarEl, title, currentChatMeta?.avatar, "3.5rem");
  }

  const kind = isVideo ? "video" : "voice";
  const countLabel =
    ui.participantCount > 1 ? ` · ${ui.participantCount} in call` : "";
  const labels = {
    outgoing: `Starting group ${kind} call…`,
    incoming: `Incoming group ${kind} call${ui.from_name ? ` from ${ui.from_name}` : ""}`,
    connecting: "Joining call…",
    active: "In call",
  };
  const timerText = ui.state === "active" ? (ui.durationLabel || "0:00") + countLabel : "";
  if (statusEl) {
    statusEl.textContent =
      ui.state === "active" ? timerText : labels[ui.state] || ui.state;
  }

  const showDuration = ui.state === "active";
  durationAudio?.classList.toggle("hidden", !showDuration);

  incoming?.classList.toggle("hidden", ui.state !== "incoming");
  active?.classList.toggle("hidden", ui.state !== "active" && ui.state !== "connecting");
  outgoing?.classList.toggle("hidden", ui.state !== "outgoing");

  if (muteBtn) {
    muteBtn.setAttribute("aria-pressed", ui.muted ? "true" : "false");
    muteBtn.querySelector(".call-mute-icon-on")?.classList.toggle("hidden", ui.muted);
    muteBtn.querySelector(".call-mute-icon-off")?.classList.toggle("hidden", !ui.muted);
  }
  updateCallButton();
  syncCallChrome(ui);
}

function updateCallRecordingNotice(ui) {
  const notice = document.getElementById("call-recording-notice");
  const card = document.getElementById("call-card");
  if (!notice) return;
  const active = ui.state === "active";
  const anyRec = !!(ui.recording || ui.peerRecording);
  notice.classList.toggle("hidden", !active || !anyRec);
  card?.classList.toggle("call-card--recording", active && anyRec);
  if (!active || !anyRec) {
    notice.textContent = "";
    return;
  }
  const peer = ui.peerName || ui.peerRecordingName || "Peer";
  if (ui.recording && ui.peerRecording) {
    notice.textContent = "Recording";
  } else if (ui.recording) {
    notice.textContent = "You are recording";
  } else {
    notice.textContent = `${peer} is recording`;
  }
}

function updateCallRecordButton(ui) {
  const recordBtn = document.getElementById("call-record-btn");
  if (!recordBtn) return;
  const isVideo = ui.callMode === "video";
  const show = isVideo && ui.state === "active";
  const peerRec = !!ui.peerRecording;
  recordBtn.classList.toggle("hidden", !show);
  recordBtn.disabled = peerRec && !ui.recording;
  recordBtn.classList.toggle("recording", !!ui.recording);
  recordBtn.classList.toggle("peer-recording", peerRec && !ui.recording);
  recordBtn.setAttribute("aria-pressed", ui.recording ? "true" : "false");
  recordBtn.setAttribute(
    "aria-label",
    ui.recording ? "Stop recording" : "Record call"
  );
  recordBtn.title = ui.recording ? "Stop recording" : "Record call";
  recordBtn.querySelector(".call-record-icon-idle")?.classList.toggle("hidden", !!ui.recording);
  recordBtn.querySelector(".call-record-icon-active")?.classList.toggle("hidden", !ui.recording);
  if (typeof refreshUiIcons === "function") refreshUiIcons(recordBtn);
}

function updateCallOverlay(ui) {
  if (ui?.callKind === "group" || ui?.callKind === "group-mesh") {
    updateGroupCallOverlay(ui);
    return;
  }
  const overlay = document.getElementById("call-overlay");
  const card = document.getElementById("call-card");
  if (!overlay) return;
  card?.classList.remove("call-card--group");
  document.getElementById("call-group-stage")?.classList.add("hidden");
  const nameEl = document.getElementById("call-peer-name");
  const statusEl = document.getElementById("call-status-text");
  const avatarEl = document.getElementById("call-avatar");
  const incoming = document.getElementById("call-incoming-actions");
  const active = document.getElementById("call-active-actions");
  const outgoing = document.getElementById("call-outgoing-actions");
  const muteBtn = document.getElementById("call-mute-btn");
  const videoStage = document.getElementById("call-video-stage");
  const audioStage = document.getElementById("call-audio-stage");
  const durationAudio = document.getElementById("call-duration");
  const durationVideo = document.getElementById("call-duration-video");
  const isVideo = ui.callMode === "video";
  const showVideoUi =
    isVideo &&
    (ui.state === "outgoing" || ui.state === "connecting" || ui.state === "active");

  if (ui.state === "idle") {
    const notice = callFailureMessage(ui.reason, ui.peerName);
    if (notice) showCallNotice(notice);
    overlay.classList.add("hidden");
    overlay.classList.remove("call-overlay--minimized");
    card?.classList.remove("call-card--video");
    updateCallRecordButton({
      callMode: "voice",
      state: "idle",
      recording: false,
      peerRecording: false,
    });
    updateCallRecordingNotice({ state: "idle", recording: false, peerRecording: false });
    updateCallButton();
    syncCallChrome(ui);
    return;
  }

  overlay.classList.remove("hidden");
  card?.classList.toggle("call-card--video", isVideo && !callUiMinimized);
  const name = ui.peerName || currentChatMeta?.title || "Friend";
  if (nameEl) nameEl.textContent = name;

  const avatar =
    ui.state === "incoming" ? null : currentChatMeta?.avatar;
  if (avatarEl) {
    applyAvatarEl(avatarEl, name, avatar, "3.5rem");
  }

  const kind = isVideo ? "video" : "voice";
  const labels = {
    outgoing: "Calling…",
    incoming: `Incoming ${kind} call`,
    connecting: "Connecting…",
    active: isVideo ? "Video call" : "In call",
  };
  const timerText = ui.state === "active" ? ui.durationLabel || "0:00" : "";
  const anyRec = !!(ui.recording || ui.peerRecording);
  if (statusEl) {
    if (ui.state === "active" && anyRec) {
      const peer = ui.peerName || ui.peerRecordingName || "Peer";
      statusEl.textContent = ui.recording
        ? `Recording · ${timerText}`
        : `${peer} is recording · ${timerText}`;
    } else {
      statusEl.textContent =
        ui.state === "active" ? timerText : labels[ui.state] || ui.state;
    }
  }

  updateCallRecordingNotice(ui);

  const showDuration = ui.state === "active";
  durationAudio?.classList.toggle("hidden", !showDuration || isVideo);
  durationVideo?.classList.toggle("hidden", !showDuration || !isVideo);
  if (showDuration) {
    const t = timerText;
    if (durationAudio) durationAudio.textContent = t;
    if (durationVideo) durationVideo.textContent = t;
  }

  videoStage?.classList.toggle("hidden", !showVideoUi);
  audioStage?.classList.toggle("hidden", showVideoUi);

  incoming?.classList.toggle("hidden", ui.state !== "incoming");
  active?.classList.toggle("hidden", ui.state !== "active" && ui.state !== "connecting");
  outgoing?.classList.toggle("hidden", ui.state !== "outgoing");

  if (muteBtn) {
    muteBtn.setAttribute("aria-pressed", ui.muted ? "true" : "false");
    muteBtn.querySelector(".call-mute-icon-on")?.classList.toggle("hidden", ui.muted);
    muteBtn.querySelector(".call-mute-icon-off")?.classList.toggle("hidden", !ui.muted);
  }
  updateCallRecordButton(ui);
  updateCallButton();
  syncCallChrome(ui);
}

async function uploadCallRecording(blob, targetChatId, compressionPercent) {
  if (!blob || !targetChatId) return;
  const pct =
    typeof compressionPercent === "number"
      ? compressionPercent
      : getMediaCompressionPercent();
  const ext = blob.type.includes("mp4") ? ".mp4" : ".webm";
  const file = new File(
    [blob],
    mediaDownloadFilename({
      createdAt: new Date(),
      id: newUploadId(),
      prefix: "call-recording",
      ext,
    }),
    {
    type: blob.type || "video/webm",
    lastModified: Date.now(),
  });
  const signal = beginActiveTransfer();
  const doCompress = pct < 100;

  try {
    if (doCompress) {
      setTransferStatus({
        stage: "compress",
        percent: 0,
        label: "Compressing call recording…",
        originalSize: file.size,
        mediaType: "video",
      });
    } else {
      setTransferStatus({
        stage: "upload",
        percent: 0,
        label: "Uploading call recording… 0%",
        mediaType: "video",
      });
    }

    const result = await uploadChunked(file, "video", {
      compress: doCompress,
      compressionPercent: pct,
      onProgress: (p) => {
        if (!signal.aborted) setTransferStatus({ mediaType: "video", ...p });
      },
      signal,
    });

    throwIfTransferAborted(signal);
    setTransferStatus({ stage: "upload", percent: 100, label: "Posting to chat…" });

    await api("/api/chats/send", {
      method: "POST",
      body: JSON.stringify({
        chat_id: targetChatId,
        content: "Call recording",
        message_type: "video",
        media_path: result.media_path,
        thumb_path: result.thumb_path || null,
      }),
      signal,
    });
    setTransferStatus(null);
    if (targetChatId === currentChatId) {
      uploadStatus.textContent = "Call recording posted to chat";
    }
    await loadChats();
  } catch (ex) {
    setTransferStatus(null);
    if (isTransferCancelled(ex)) return;
    uploadStatus.textContent = ex.message || "Could not save call recording";
  }
}

function messageAlreadyInStream(messageId) {
  if (!messageId || !messagesEl) return false;
  return !!messagesEl.querySelector(`[data-message-id="${messageId}"]`);
}

function handleCallLogged(message, chatIdLogged) {
  if (!message?.id) return;
  loadChats();
  if (chatIdLogged !== currentChatId) return;
  if (messageAlreadyInStream(message.id)) return;
  stickToBottom = true;
  renderMessage(message);
  scheduleScrollToEnd();
}

function initVoiceCall() {
  if (typeof VoiceCall === "undefined") return;
  initCallPipDrag();
  VoiceCall.init({
    getMe: () => me,
    sendSignal: (msg) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    onUiUpdate: updateCallOverlay,
    onCallLogged: handleCallLogged,
    onRecordingComplete: uploadCallRecording,
  });

  document.getElementById("call-record-btn")?.addEventListener("click", () => {
    VoiceCall.toggleRecording().catch((err) => {
      uploadStatus.textContent = err.message || "Recording failed";
    });
  });

  document.getElementById("call-btn")?.addEventListener("click", () => startAnyCall("voice"));
  document.getElementById("video-call-btn")?.addEventListener("click", () => startAnyCall("video"));

  document.getElementById("call-accept-btn")?.addEventListener("click", () => acceptAnyCall());
  document.getElementById("call-decline-btn")?.addEventListener("click", () => declineAnyCall());

  const endHandler = () => endAnyCall();
  document.getElementById("call-end-btn")?.addEventListener("click", endHandler);
  document.getElementById("call-cancel-btn")?.addEventListener("click", endHandler);
  document.getElementById("call-mute-btn")?.addEventListener("click", () => {
    if (typeof GroupCall !== "undefined" && GroupCall.isInCall()) {
      GroupCall.toggleMute();
    } else if (typeof GroupMeshCall !== "undefined" && GroupMeshCall.isInCall()) {
      GroupMeshCall.toggleMute();
    } else {
      VoiceCall.toggleMute();
    }
  });

  document.getElementById("call-minimize-btn")?.addEventListener("click", () => {
    setCallMinimized(true);
    const overlay = document.getElementById("call-overlay");
    if (overlay && !overlay.classList.contains("hidden")) {
      overlay.classList.add("call-overlay--minimized");
      applyCallPipPosition();
      document.getElementById("call-expand-btn")?.classList.remove("hidden");
      document.getElementById("call-minimize-btn")?.classList.add("hidden");
    }
  });

  document.getElementById("call-expand-btn")?.addEventListener("click", () => {
    setCallMinimized(false);
    const overlay = document.getElementById("call-overlay");
    overlay?.classList.remove("call-overlay--minimized");
    document.getElementById("call-expand-btn")?.classList.add("hidden");
    const uiState =
      typeof VoiceCall !== "undefined" && !VoiceCall.isIdle()
        ? "active"
        : typeof GroupMeshCall !== "undefined" && GroupMeshCall.isInCall()
          ? "active"
          : typeof GroupCall !== "undefined" && GroupCall.isInCall()
            ? "active"
            : "outgoing";
    syncCallChrome({ state: uiState });
  });
}

async function startAnyCall(mode) {
  const isGroup =
    currentChatMeta?.type === "group" || currentChatId?.startsWith("group_");
  if (isGroup) {
    if (!groupCallsEnabled()) return;
    const strategy = groupCallStrategy();
    const title = currentChatMeta?.title || chatTitleEl.textContent;
    if (strategy === "mesh" && typeof GroupMeshCall !== "undefined") {
      try {
        await GroupMeshCall.startGroupCall(currentChatId, title, mode);
      } catch (err) {
        uploadStatus.textContent = err.message || "Could not start group call";
        GroupMeshCall.forceEnd();
      }
      return;
    }
    if (strategy === "livekit" && typeof GroupCall !== "undefined") {
      try {
        await GroupCall.startGroupCall(currentChatId, title, mode);
      } catch (err) {
        uploadStatus.textContent = err.message || "Could not start group call";
        GroupCall.forceEnd();
      }
      return;
    }
    const maxMesh = callsConfig.mesh_group_max ?? 6;
    uploadStatus.textContent =
      getGroupMemberCount() > maxMesh
        ? `This group has ${getGroupMemberCount()} members. Configure LiveKit for calls larger than ${maxMesh}, or split into a smaller group.`
        : "Cannot start a group call in this chat.";
    return;
  }
  const peerId = getDmPeerId();
  if (!peerId || !currentChatId) return;
  try {
    await VoiceCall.startOutgoing(
      peerId,
      currentChatId,
      currentChatMeta?.title || chatTitleEl.textContent,
      mode
    );
  } catch (err) {
    uploadStatus.textContent = err.message || "Could not start call";
    VoiceCall.forceEnd();
  }
}

async function acceptAnyCall() {
  if (typeof GroupMeshCall !== "undefined" && GroupMeshCall.getPendingIncoming()) {
    const inv = GroupMeshCall.getPendingIncoming();
    if (inv?.chat_id && inv.chat_id !== currentChatId) {
      try {
        const { chats } = await api("/api/chats/list");
        const chat = chats.find((c) => c.chat_id === inv.chat_id);
        if (chat) {
          await selectChat(chat.chat_id, chat.name, "group", chat.avatar, {
            type: "group",
            group_id: chat.group_id,
            members: chat.members,
          });
        }
      } catch (_) {
        /* join anyway */
      }
    }
    try {
      await GroupMeshCall.acceptIncoming();
    } catch (err) {
      uploadStatus.textContent = err.message || "Could not join call";
      GroupMeshCall.forceEnd();
    }
    return;
  }
  if (typeof GroupCall !== "undefined" && GroupCall.getPendingIncoming()) {
    const inv = GroupCall.getPendingIncoming();
    if (inv?.chat_id && inv.chat_id !== currentChatId) {
      try {
        const { chats } = await api("/api/chats/list");
        const chat = chats.find((c) => c.chat_id === inv.chat_id);
        if (chat) {
          await selectChat(chat.chat_id, chat.name, "group", chat.avatar, {
            type: "group",
            group_id: chat.group_id,
            members: chat.members,
          });
        }
      } catch (_) {
        /* join anyway */
      }
    }
    try {
      await GroupCall.acceptIncoming();
    } catch (err) {
      uploadStatus.textContent = err.message || "Could not join call";
      GroupCall.forceEnd();
    }
    return;
  }
  const peerId = VoiceCall.getPeerId();
  if (peerId && (!currentChatId || getDmPeerId() !== peerId)) {
    openDm(peerId).catch(() => {});
  }
  VoiceCall.acceptIncoming().catch((err) => {
    uploadStatus.textContent = err.message || "Could not answer";
    VoiceCall.forceEnd();
  });
}

function declineAnyCall() {
  if (typeof GroupMeshCall !== "undefined" && GroupMeshCall.getPendingIncoming()) {
    GroupMeshCall.rejectIncoming();
    return;
  }
  if (typeof GroupCall !== "undefined" && GroupCall.getPendingIncoming()) {
    GroupCall.rejectIncoming();
    return;
  }
  VoiceCall.rejectIncoming();
}

function endAnyCall() {
  if (typeof GroupMeshCall !== "undefined" && GroupMeshCall.isInCall()) {
    GroupMeshCall.endCall();
    return;
  }
  if (typeof GroupCall !== "undefined" && GroupCall.isInCall()) {
    GroupCall.endCall();
    return;
  }
  VoiceCall.endCall();
}

function initGroupMeshCall() {
  if (typeof GroupMeshCall === "undefined") return;
  GroupMeshCall.init({
    getMe: () => me,
    sendSignal: (msg) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    onUiUpdate: updateCallOverlay,
    onCallLogged: handleCallLogged,
  });
}

function initGroupCall() {
  if (typeof GroupCall === "undefined") return;
  GroupCall.init({
    getMe: () => me,
    sendSignal: (msg) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    onUiUpdate: updateCallOverlay,
    onCallLogged: handleCallLogged,
  });
}

function closeChatView() {
  if (typeof HomiesEvents !== "undefined") HomiesEvents.closeEventView();
  if (typeof VoiceCall !== "undefined" && VoiceCall.isInCall()) {
    const peer = getDmPeerId();
    if (!peer || peer === VoiceCall.getPeerId()) VoiceCall.forceEnd();
  }
  if (typeof GroupMeshCall !== "undefined" && GroupMeshCall.isInCall()) {
    if (GroupMeshCall.getChatId() === currentChatId) GroupMeshCall.forceEnd();
  }
  if (typeof GroupCall !== "undefined" && GroupCall.isInCall()) {
    if (GroupCall.getChatId() === currentChatId) GroupCall.forceEnd();
  }
  cancelActiveTransfer();
  appEl.classList.remove("chat-open");
  currentChatId = null;
  currentChatMeta = null;
  updateChatHeaderAvatar();
  chatTitleEl.textContent = "Select a conversation";
  messageInput.placeholder = "Message";
  showEmptyChat();
  setComposerEnabled(false);
  clearPendingAttachment();
  resetMessagesPagination();
  setTransferStatus(null);
  document.querySelectorAll(".dm-item.active").forEach((el) => el.classList.remove("active"));
  updateCallButton();
}

function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function formatFileSize(bytes) {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setTransferStatus(data) {
  if (!uploadStatus) return;
  if (!data) {
    uploadStatus.innerHTML = "";
    return;
  }

  const percent = Math.max(0, Math.min(100, data.percent ?? 0));
  const label = data.label || "";
  let estimateHtml = "";

  if (data.stage === "compress" && data.originalSize) {
    const est =
      data.estimatedSize ??
      (typeof estimateCompressedSize === "function"
        ? estimateCompressedSize(data.originalSize, data.mediaType, getMediaCompressionPercent())
        : data.originalSize);
    estimateHtml = `<span class="transfer-estimate">Est. ${formatFileSize(data.originalSize)} → ${formatFileSize(est)}</span>`;
  } else if (data.summary) {
    estimateHtml = `<span class="transfer-estimate">${escapeHtml(data.summary)}</span>`;
  } else if (data.originalSize && data.compressedSize != null) {
    const summary =
      typeof compressionSummary === "function"
        ? compressionSummary(data.originalSize, data.compressedSize)
        : `${formatFileSize(data.originalSize)} → ${formatFileSize(data.compressedSize)}`;
    estimateHtml = `<span class="transfer-estimate">${escapeHtml(summary)}</span>`;
  }

  const showCancel = data.stage === "compress" || data.stage === "upload";

  uploadStatus.innerHTML = `
    <div class="transfer-status">
      <div class="transfer-status-head">
        <span class="transfer-label">${escapeHtml(label)}</span>
        ${showCancel ? '<button type="button" class="transfer-cancel-btn">Cancel</button>' : ""}
      </div>
      <div class="transfer-progress" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100">
        <div class="transfer-progress-fill" style="width:${percent}%"></div>
      </div>
      ${estimateHtml}
    </div>`;
}

if (uploadStatus) {
  uploadStatus.addEventListener("click", (e) => {
    if (e.target.closest(".transfer-cancel-btn")) {
      cancelActiveTransfer();
      setTransferStatus(null);
      updateSendButtonState();
    }
  });
}

function clearPendingAttachment() {
  if (isTransferActive()) cancelActiveTransfer();
  cancelVoiceRecord();
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  if (pendingAttachment?.previewUrl) {
    URL.revokeObjectURL(pendingAttachment.previewUrl);
  }
  pendingAttachment = null;
  const preview = document.getElementById("attachment-preview");
  if (preview) {
    preview.classList.add("hidden");
    preview.innerHTML = "";
  }
  updateSendButtonState();
}

function updateSendButtonState() {
  if (messageInput.disabled) {
    sendBtn.disabled = true;
    return;
  }
  const hasText = messageInput.value.trim().length > 0;
  const hasPending = !!pendingAttachment;
  sendBtn.disabled = !hasText && !hasPending;
}

function queueMediaAttachment(file, messageType, mediaType) {
  const inEvent =
    typeof HomiesEvents !== "undefined" && HomiesEvents.currentEventId;
  if (!file || (!currentChatId && !inEvent)) return;
  clearPendingAttachment();
  pendingAttachment = {
    file,
    messageType,
    mediaType,
    previewUrl: URL.createObjectURL(file),
  };
  renderAttachmentPreview();
  updateSendButtonState();
  uploadStatus.textContent = "Ready to send — click Send";
  setVoiceHint("Hold mic button to record");
}

function renderAttachmentPreview() {
  const el = document.getElementById("attachment-preview");
  if (!pendingAttachment) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const { file, messageType, previewUrl, duration } = pendingAttachment;
  el.classList.remove("hidden");

  if (messageType === "voice") {
    const dur = formatDuration(duration);
    el.innerHTML = `
      <div class="attachment-preview-inner attachment-preview-voice">
        <button type="button" class="voice-preview-play" aria-label="Preview recording">${ICON_PLAY}</button>
        <div class="voice-preview-wave">${buildWaveformBarsHtml(16)}</div>
        <div class="attachment-preview-meta">
          <span class="attachment-preview-name">Voice message</span>
          <span class="attachment-preview-hint">${dur} · click Send to send</span>
        </div>
        <button type="button" class="attachment-preview-remove" title="Remove" aria-label="Remove attachment">${icon("x", "", 18)}</button>
      </div>
    `;
    const playBtn = el.querySelector(".voice-preview-play");
    playBtn.onclick = () => togglePreviewPlayback(playBtn, previewUrl);
    el.querySelector(".attachment-preview-remove").onclick = () => {
      clearPendingAttachment();
      uploadStatus.textContent = "";
      setVoiceHint("Hold mic button to record");
    };
    refreshUiIcons(el);
    return;
  }

  if (messageType === "video") {
    const sizeLabel = formatFileSize(file.size);
    el.innerHTML = `
      <div class="attachment-preview-inner attachment-preview-video">
        <div class="video-preview">
          <video class="video-preview-el" src="${previewUrl}" muted ${VIDEO_SAFE_ATTRS}></video>
          <button type="button" class="custom-video-play video-preview-play" aria-label="Preview video">${ICON_PLAY}</button>
          <span class="video-preview-badge">VIDEO</span>
          <span class="video-preview-duration">0:00</span>
        </div>
        <div class="attachment-preview-meta">
          <span class="attachment-preview-name">${escapeHtml(file.name)}</span>
          <span class="attachment-preview-hint">${sizeLabel ? sizeLabel + " · " : ""}click Send to upload</span>
        </div>
        <button type="button" class="attachment-preview-remove" title="Remove" aria-label="Remove attachment">${icon("x", "", 18)}</button>
      </div>
    `;
    wireVideoPreview(el.querySelector(".video-preview"));
    el.querySelector(".attachment-preview-remove").onclick = () => {
      clearPendingAttachment();
      uploadStatus.textContent = "";
      setVoiceHint("Hold mic button to record");
    };
    refreshUiIcons(el);
    return;
  }

  el.innerHTML = `
    <div class="attachment-preview-inner attachment-preview-image">
      <div class="attachment-preview-media" id="attachment-preview-media-slot"></div>
      <div class="attachment-preview-meta">
        <span class="attachment-preview-name">${escapeHtml(file.name)}</span>
        <span class="attachment-preview-hint">Photo · click Send to send</span>
      </div>
      <button type="button" class="attachment-preview-remove" title="Remove" aria-label="Remove attachment">${icon("x", "", 18)}</button>
    </div>
  `;
  const slot = el.querySelector("#attachment-preview-media-slot");
  if (slot) {
    slot.appendChild(
      createProtectedImageView(previewUrl, {
        className: "attachment-preview-protected",
        alt: "Attachment preview",
        maxW: 140,
        maxH: 120,
        fallbackW: 120,
        fallbackH: 80,
      })
    );
  }
  el.querySelector(".attachment-preview-remove").onclick = () => {
    clearPendingAttachment();
    uploadStatus.textContent = "";
    setVoiceHint("Hold mic button to record");
  };
  refreshUiIcons(el);
}

const VIDEO_SAFE_ATTRS =
  'playsinline preload="metadata" disablepictureinpicture disableremoteplayback controlslist="nodownload noplaybackrate noremoteplayback nofullscreen"';

function icon(name, className = "", size = 20) {
  return typeof HomiesIcons !== "undefined"
    ? HomiesIcons.iconHtml(name, className, size)
    : "";
}

function refreshUiIcons(root) {
  if (typeof HomiesIcons !== "undefined") HomiesIcons.refreshIcons(root || document);
}

const ICON_PLAY = icon("play", "", 20);
const ICON_PAUSE = icon("pause", "", 20);
function hardenVideoElement(video) {
  if (!video) return;
  video.removeAttribute("controls");
  video.controls = false;
  video.setAttribute("playsinline", "");
  video.setAttribute("disablepictureinpicture", "");
  video.setAttribute("disableremoteplayback", "");
  video.setAttribute("controlsList", "nodownload noplaybackrate noremoteplayback nofullscreen");
  video.addEventListener("contextmenu", (e) => e.preventDefault());
}

/** Block right-click / long-press "Save image" on a node (not the in-app Download button). */
function blockNativeImageSave(el) {
  if (!el || el.dataset.nativeSaveBlocked === "1") return;
  el.dataset.nativeSaveBlocked = "1";
  const stop = (e) => e.preventDefault();
  el.addEventListener("contextmenu", stop);
  el.addEventListener("dragstart", stop);
  el.addEventListener("selectstart", stop);
  el.addEventListener("copy", stop);
}

/** Cap display size like the old <img> thumbnails (width/height auto + max bounds). */
function capImageDisplaySize(nw, nh, maxW, maxH) {
  if (!nw || !nh) return { w: maxW, h: Math.round(maxW * 0.65) };
  let w = nw;
  let h = nh;
  const scale = Math.min(maxW / w, maxH / h, 1);
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * Show a photo via background-image so the browser has no <img> to save from the context menu.
 * In-app Download still uses the real media URL.
 */
function createProtectedImageView(url, options = {}) {
  const {
    className = "",
    alt = "Image",
    maxW = 320,
    maxH = 280,
    fit = "contain",
    fallbackW = 320,
    fallbackH = 200,
  } = options;
  const wrap = document.createElement("div");
  wrap.className = `protected-image-view ${className}`.trim();
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", alt);
  blockNativeImageSave(wrap);

  const media = document.createElement("div");
  media.className = "protected-image-view__media";
  if (fit === "cover") {
    media.classList.add("protected-image-view__media--cover");
  }
  blockNativeImageSave(media);
  wrap.appendChild(media);

  const applyUrl = (src) => {
    const safe = String(src).replace(/"/g, '\\"');
    media.style.backgroundImage = `url("${safe}")`;
  };

  const applySize = (nw, nh) => {
    if (fit === "cover") {
      media.style.width = `min(${maxW}px, 100%)`;
      media.style.height = `${maxH}px`;
      media.style.maxHeight = `min(${maxH}px, 45vh)`;
      media.style.aspectRatio = nw && nh ? `${nw} / ${nh}` : "16 / 10";
      return;
    }
    const { w, h } = capImageDisplaySize(nw, nh, maxW, maxH);
    media.style.width = `${w}px`;
    media.style.height = `${h}px`;
    media.style.maxWidth = `min(${maxW}px, 100%)`;
    media.style.maxHeight = `min(${maxH}px, 45vh)`;
  };

  media.style.width = `${fallbackW}px`;
  media.style.height = `${fallbackH}px`;
  media.style.maxWidth = `min(${maxW}px, 100%)`;
  media.style.maxHeight = `min(${maxH}px, 45vh)`;

  const probe = new Image();
  probe.onload = () => {
    applySize(probe.naturalWidth, probe.naturalHeight);
    applyUrl(url);
  };
  probe.onerror = () => {
    applyUrl(url);
  };
  probe.src = url;

  return wrap;
}

function initMediaProtection() {
  const app = document.getElementById("app");
  if (!app) return;
  app.addEventListener(
    "contextmenu",
    (e) => {
      if (e.target.closest(".protected-image-view, .protected-image-view__media")) {
        e.preventDefault();
      }
    },
    true
  );
  app.addEventListener(
    "dragstart",
    (e) => {
      if (e.target.closest(".protected-image-view__media")) {
        e.preventDefault();
      }
    },
    true
  );
}

const VIDEO_MESSAGE_MAX_W = 420;
const VIDEO_MESSAGE_MAX_H = 360;

function sizeVideoMessageFrame(video, frame) {
  if (!video?.classList.contains("video-message-el") || !frame) return;

  const fit = () => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    const maxW = Math.min(
      VIDEO_MESSAGE_MAX_W,
      frame.closest(".message-text")?.clientWidth || VIDEO_MESSAGE_MAX_W
    );
    const capH = window.matchMedia("(max-width: 768px)").matches ? 240 : VIDEO_MESSAGE_MAX_H;
    const maxH = Math.min(capH, window.innerHeight * 0.55);
    const scale = Math.min(maxW / vw, maxH / vh, 1);
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));

    video.style.width = `${w}px`;
    video.style.height = `${h}px`;
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
  };

  video.addEventListener("loadedmetadata", fit);
  video.addEventListener("loadeddata", fit);
  if (video.readyState >= 1) fit();
}

function wireCustomVideoPlayer(frame, options = {}) {
  if (!frame) return;
  const {
    videoSelector = "video",
    playSelector = ".custom-video-play",
    durationSelector = ".custom-video-duration",
    progressSelector = ".custom-video-progress-fill",
    playLabel = "Play video",
    pauseLabel = "Pause video",
    unmuteOnPlay = true,
  } = options;

  const video = frame.querySelector(videoSelector);
  const playBtn = frame.querySelector(playSelector);
  const durationEl = frame.querySelector(durationSelector);
  const progressFill = frame.querySelector(progressSelector);
  if (!video || !playBtn) return;

  hardenVideoElement(video);
  sizeVideoMessageFrame(video, frame);

  const setPlayIcon = (playing) => {
    playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    playBtn.setAttribute("aria-label", playing ? pauseLabel : playLabel);
    refreshUiIcons(playBtn);
  };

  const updateDuration = () => {
    if (durationEl && video.duration && isFinite(video.duration)) {
      if (video.paused) {
        durationEl.textContent = formatDuration(video.duration);
      }
    }
  };

  const updateProgress = () => {
    if (progressFill && video.duration) {
      progressFill.style.width = `${(video.currentTime / video.duration) * 100}%`;
    }
    if (durationEl && video.duration && isFinite(video.duration)) {
      durationEl.textContent = `${formatDuration(video.currentTime)} / ${formatDuration(video.duration)}`;
    }
  };

  const setPlaying = (playing) => {
    frame.classList.toggle("is-playing", playing);
    frame.classList.toggle("playing", playing);
    setPlayIcon(playing);
    if (!playing) updateDuration();
  };

  const togglePlay = () => {
    if (video.paused) {
      if (unmuteOnPlay) video.muted = false;
      video.play();
    } else {
      video.pause();
    }
  };

  video.addEventListener("loadedmetadata", updateDuration);
  video.addEventListener("durationchange", updateDuration);
  video.addEventListener("timeupdate", updateProgress);
  video.addEventListener("play", () => setPlaying(true));
  video.addEventListener("pause", () => setPlaying(false));
  video.addEventListener("ended", () => {
    setPlaying(false);
    if (progressFill) progressFill.style.width = "0%";
    updateDuration();
  });

  playBtn.onclick = (e) => {
    e.stopPropagation();
    togglePlay();
  };

  frame.addEventListener("click", (e) => {
    if (e.target === playBtn || playBtn.contains(e.target)) return;
    if (frame.classList.contains("is-playing") || frame.classList.contains("playing")) {
      togglePlay();
    }
  });

  setPlayIcon(false);
  updateDuration();
}

function wireVideoPreview(frame) {
  wireCustomVideoPlayer(frame, {
    videoSelector: ".video-preview-el",
    playSelector: ".video-preview-play",
    durationSelector: ".video-preview-duration",
    playLabel: "Preview video",
    pauseLabel: "Pause preview",
    unmuteOnPlay: true,
  });
}

function openMediaLightbox({ type, url, downloadUrl, downloadName }) {
  const box = document.getElementById("media-lightbox");
  const content = document.getElementById("media-lightbox-content");
  const dlBtn = document.getElementById("media-lightbox-download");
  if (!box || !content || !url) return;

  content.innerHTML = "";
  if (type === "image") {
    const view = createProtectedImageView(url, {
      className: "media-lightbox-img",
      alt: "Full size image",
      maxW: 1200,
      maxH: Math.max(320, window.innerHeight - 140),
      fallbackW: 320,
      fallbackH: 240,
    });
    content.appendChild(view);
  } else if (type === "video") {
    const player = document.createElement("div");
    player.className = "media-lightbox-video custom-video-player";
    player.innerHTML = `
      <video class="media-lightbox-video-el" src="${escapeHtml(url)}" ${VIDEO_SAFE_ATTRS}></video>
      <button type="button" class="custom-video-play media-lightbox-play" aria-label="Play video">${ICON_PLAY}</button>
      <div class="custom-video-progress" aria-hidden="true"><div class="custom-video-progress-fill"></div></div>
      <span class="custom-video-duration media-lightbox-duration">0:00</span>
    `;
    content.appendChild(player);
    const video = player.querySelector("video");
    hardenVideoElement(video);
    wireCustomVideoPlayer(player, {
      videoSelector: "video",
      playLabel: "Play video",
      pauseLabel: "Pause video",
      unmuteOnPlay: true,
    });
    refreshUiIcons(player);
  }

  if (dlBtn) {
    dlBtn.classList.remove("hidden");
    dlBtn.disabled = !downloadUrl;
    dlBtn.onclick = downloadUrl
      ? async (e) => {
          e.preventDefault();
          const label = dlBtn.textContent;
          dlBtn.disabled = true;
          dlBtn.textContent = "Downloading…";
          try {
            await streamDownloadFile(downloadUrl, downloadName);
          } catch (err) {
            if (uploadStatus) uploadStatus.textContent = err.message || "Download failed";
          } finally {
            dlBtn.disabled = false;
            dlBtn.textContent = label;
          }
        }
      : null;
  }

  box.classList.remove("hidden");
  document.body.classList.add("media-lightbox-open");
}

function closeMediaLightbox() {
  const box = document.getElementById("media-lightbox");
  const content = document.getElementById("media-lightbox-content");
  if (!box) return;
  const video = content?.querySelector("video");
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  if (content) content.innerHTML = "";
  box.classList.add("hidden");
  document.body.classList.remove("media-lightbox-open");
}

function closeProfileSheet() {
  const sheet = document.getElementById("profile-sheet");
  if (!sheet) return;
  sheet.classList.add("hidden");
  document.body.classList.remove("profile-sheet-open");
}

function renderProfileSheetAvatar(container, name, avatarPath) {
  if (!container) return;
  container.innerHTML = "";
  container.classList.remove("avatar-placeholder");
  container.style.background = "";
  container.style.color = "";
  container.style.fontSize = "";

  if (avatarPath) {
    const url = avatarPath.startsWith("/") ? avatarPath : mediaUrl(avatarPath);
    const view = createProtectedImageView(url, {
      className: "profile-sheet-protected-img",
      alt: `${name || "User"} profile photo`,
      maxW: 128,
      maxH: 128,
      fit: "cover",
      fallbackW: 128,
      fallbackH: 128,
    });
    view.style.cursor = "zoom-in";
    view.addEventListener("click", (e) => {
      e.stopPropagation();
      openMediaLightbox({ type: "image", url });
    });
    container.appendChild(view);
    return;
  }

  container.classList.add("avatar-placeholder");
  container.style.background = avatarColor(name);
  container.textContent = initials(name);
}

function bindAvatarOpen(el, onActivate) {
  if (!el || typeof onActivate !== "function") return;
  el.classList.add("avatar-clickable");
  if (!el.getAttribute("role")) el.setAttribute("role", "button");
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
  const activate = (e) => {
    e.stopPropagation();
    e.preventDefault();
    onActivate();
  };
  el.onclick = activate;
  el.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") activate(e);
  };
}

async function openProfileSheet({ kind, userId, groupId, name, avatar, online, memberCount }) {
  const sheet = document.getElementById("profile-sheet");
  const nameEl = document.getElementById("profile-sheet-name");
  const statusEl = document.getElementById("profile-sheet-status");
  const avatarEl = document.getElementById("profile-sheet-avatar");
  if (!sheet || !nameEl || !statusEl || !avatarEl) return;

  let displayName = name || "Unknown";
  let avatarPath = avatar ?? null;
  let statusText = "";
  let isOnline = false;

  try {
    if (kind === "group" && groupId) {
      const data = await api(`/api/groups/${groupId}`);
      const g = data.group || {};
      displayName = g.name || displayName;
      avatarPath = g.avatar ?? avatarPath;
      const count = (data.members || g.members || []).length;
      statusText = count ? `${count} member${count === 1 ? "" : "s"}` : "Group";
    } else if (kind === "user" && userId) {
      const data = await api(`/api/users/${userId}`);
      displayName = data.display_name || data.name || displayName;
      avatarPath = data.avatar ?? avatarPath;
      isOnline = !!data.online;
      statusText = isOnline ? "Online" : "Offline";
    }
  } catch {
    if (kind === "group") {
      statusText = memberCount
        ? `${memberCount} member${memberCount === 1 ? "" : "s"}`
        : "Group";
    } else if (kind === "user") {
      isOnline = !!online;
      statusText = isOnline ? "Online" : "Offline";
    }
  }

  nameEl.textContent = displayName;
  statusEl.textContent = statusText;
  statusEl.classList.toggle("profile-sheet-status--online", kind === "user" && isOnline);
  renderProfileSheetAvatar(avatarEl, displayName, avatarPath);

  sheet.classList.remove("hidden");
  document.body.classList.add("profile-sheet-open");
  refreshUiIcons(sheet);
}

function updateChatHeaderAvatar() {
  const btn = document.getElementById("chat-header-avatar");
  if (!btn) return;
  if (!currentChatId || !currentChatMeta) {
    btn.classList.add("hidden");
    return;
  }
  const title = currentChatMeta.title || chatTitleEl?.textContent || "";
  btn.classList.remove("hidden");
  applyAvatarEl(btn, title, currentChatMeta.avatar, "0.85rem");

  const isGroup = currentChatMeta.type === "group";
  bindAvatarOpen(btn, () => {
    if (isGroup) {
      openProfileSheet({
        kind: "group",
        groupId: currentChatMeta.group_id,
        name: title,
        avatar: currentChatMeta.avatar,
        memberCount: currentChatMeta.members?.length,
      });
    } else {
      openProfileSheet({
        kind: "user",
        userId: currentChatMeta.id,
        name: title,
        avatar: currentChatMeta.avatar,
      });
    }
  });
}

let avatarCropState = null;

function closeAvatarCropModal() {
  closeModal("avatar-crop-modal");
  avatarCropState = null;
  const input = document.getElementById("avatar-input");
  if (input) input.value = "";
}

function drawAvatarCropPreview() {
  const state = avatarCropState;
  const canvas = document.getElementById("avatar-crop-canvas");
  if (!state || !canvas) return;
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  const img = state.image;
  const zoom = state.zoom;
  const scale = (size / Math.min(img.naturalWidth, img.naturalHeight)) * zoom;
  const sw = img.naturalWidth * scale;
  const sh = img.naturalHeight * scale;
  const maxPanX = Math.max(0, (sw - size) / 2);
  const maxPanY = Math.max(0, (sh - size) / 2);
  state.panX = Math.max(-maxPanX, Math.min(maxPanX, state.panX));
  state.panY = Math.max(-maxPanY, Math.min(maxPanY, state.panY));
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, (size - sw) / 2 + state.panX, (size - sh) / 2 + state.panY, sw, sh);
}

function openAvatarCropModal(file) {
  const canvas = document.getElementById("avatar-crop-canvas");
  const zoomInput = document.getElementById("avatar-crop-zoom");
  if (!canvas || !file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      avatarCropState = { image: img, zoom: 1, panX: 0, panY: 0, fileName: file.name };
      if (zoomInput) zoomInput.value = "1";
      drawAvatarCropPreview();
      openModal("avatar-crop-modal");
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function exportAvatarCropBlob(callback) {
  const state = avatarCropState;
  const srcCanvas = document.getElementById("avatar-crop-canvas");
  if (!state || !srcCanvas) return;
  const out = document.createElement("canvas");
  const outSize = 512;
  out.width = outSize;
  out.height = outSize;
  const ctx = out.getContext("2d");
  ctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, outSize, outSize);
  out.toBlob(
    (blob) => {
      if (!blob) return;
      const base = (state.fileName || "avatar.jpg").replace(/\.[^.]+$/, "");
      callback(new File([blob], `${base}.jpg`, { type: "image/jpeg" }));
    },
    "image/jpeg",
    0.92
  );
}

async function refreshAvatarsAfterOwnChange() {
  const name = me?.display_name || me?.name;
  const path = me?.avatar;
  applyAvatarEl(document.getElementById("my-avatar"), name, path, "0.85rem");
  applyAvatarEl(document.getElementById("profile-avatar-preview"), name, path, "2.25rem");
  syncAvatarRemoveButton();
  updateChatHeaderAvatar();
  if (typeof loadOnline === "function") await loadOnline();
  if (typeof loadUsers === "function") await loadUsers();
  if (typeof loadChats === "function") await loadChats();
  if (currentChatId && messagesEl) {
    messagesEl.querySelectorAll(".message-group").forEach((group) => {
      const av = group.querySelector(".message-avatar");
      if (!av || !group.classList.contains("own-message")) return;
      if (path && av.tagName === "IMG") {
        av.src = mediaUrl(path);
      } else if (path) {
        const img = document.createElement("img");
        img.className = "message-avatar";
        img.src = mediaUrl(path);
        img.alt = name;
        av.replaceWith(img);
      } else {
        const ph = document.createElement("div");
        ph.className = "message-avatar avatar-placeholder";
        ph.style.background = avatarColor(name);
        ph.textContent = initials(name);
        av.replaceWith(ph);
      }
    });
  }
}

const videoThumbEnsureCache = new Map();

async function ensureVideoThumbnail(mediaPath) {
  if (!mediaPath) return null;
  if (videoThumbEnsureCache.has(mediaPath)) {
    return videoThumbEnsureCache.get(mediaPath);
  }
  const promise = api("/api/media/thumbnail", {
    method: "POST",
    body: JSON.stringify({ media_path: mediaPath }),
  })
    .then((data) => data.thumb_url || (data.thumb_path ? mediaUrl(data.thumb_path) : null))
    .catch(() => null);
  videoThumbEnsureCache.set(mediaPath, promise);
  return promise;
}

function loadVideoPoster(posterEl, message, mediaPath) {
  if (!posterEl) return;
  posterEl.classList.add("video-message-poster--loading");
  blockNativeImageSave(posterEl);

  const apply = (posterUrl) => {
    if (!posterUrl) {
      posterEl.classList.add("video-message-poster--missing");
      posterEl.classList.remove("video-message-poster--loading");
      posterEl.style.backgroundImage = "";
      return;
    }
    posterEl.classList.remove("video-message-poster--missing", "video-message-poster--loading");
    const safe = String(posterUrl).replace(/"/g, '\\"');
    posterEl.style.backgroundImage = `url("${safe}")`;
    posterEl.style.backgroundSize = "cover";
    posterEl.style.backgroundPosition = "center";

    const probe = new Image();
    probe.onload = () => {
      const maxW = 320;
      const maxH = Math.min(280, Math.round(window.innerHeight * 0.45));
      const { w, h } = capImageDisplaySize(probe.naturalWidth, probe.naturalHeight, maxW, maxH);
      posterEl.style.width = `${w}px`;
      posterEl.style.height = `${h}px`;
      posterEl.style.maxWidth = `min(${maxW}px, 100%)`;
      posterEl.style.maxHeight = `min(${maxH}px, 45vh)`;
    };
    probe.src = posterUrl;
  };

  const thumbUrl =
    typeof messageThumbUrl === "function" ? messageThumbUrl(message) : "";

  if (thumbUrl) {
    const probe = new Image();
    probe.onload = () => apply(thumbUrl);
    probe.onerror = () => {
      ensureVideoThumbnail(mediaPath).then(apply);
    };
    probe.src = thumbUrl;
    return;
  }

  ensureVideoThumbnail(mediaPath).then(apply);
}

function buildVideoMessage(url, filename, mediaPath, message) {
  const wrap = document.createElement("div");
  wrap.className = "video-message video-message--thumb";
  const isCallRecording =
    (filename && String(filename).toLowerCase().includes("call recording")) ||
    (filename && String(filename).startsWith("call-recording"));
  const name = isCallRecording
    ? "Call recording"
    : filename && !filename.startsWith("voice-")
      ? filename
      : "Video";
  const downloadName = mediaDownloadFilename({
    createdAt: message?.created_at,
    id: message?.id,
    mediaPath,
    prefix: isCallRecording ? "call-recording" : undefined,
  });
  const downloadUrl = mediaDownloadUrl(mediaPath || url, downloadName);

  const player = document.createElement("button");
  player.type = "button";
  player.className = "video-message-thumb";
  player.setAttribute("aria-label", "View full video");

  const poster = document.createElement("div");
  poster.className = "video-message-poster video-message-poster--loading";
  poster.setAttribute("aria-hidden", "true");
  player.appendChild(poster);
  loadVideoPoster(poster, message, mediaPath);

  const play = document.createElement("span");
  play.className = "video-message-play";
  play.setAttribute("aria-hidden", "true");
  play.innerHTML = ICON_PLAY;
  player.appendChild(play);

  const badge = document.createElement("span");
  badge.className = "video-message-badge";
  badge.textContent = isCallRecording ? "RECORDING" : "VIDEO";
  player.appendChild(badge);

  player.addEventListener("click", (e) => {
    e.preventDefault();
    openMediaLightbox({
      type: "video",
      url,
      downloadUrl,
      downloadName,
    });
  });

  const footer = document.createElement("div");
  footer.className = "video-message-footer";
  footer.innerHTML = `
    ${icon("video", "video-message-icon", 16)}
    <span class="video-message-name">${escapeHtml(name)}</span>
    <button type="button" class="video-message-download">Download</button>
  `;

  wrap.appendChild(player);
  wrap.appendChild(footer);
  wireMessageDownloadButton(wrap.querySelector(".video-message-download"), downloadUrl, downloadName);
  refreshUiIcons(wrap);

  return wrap;
}

function wireMessageDownloadButton(btn, downloadUrl, downloadName) {
  if (!btn || !downloadUrl) {
    if (btn) btn.disabled = true;
    return;
  }
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Downloading…";
    try {
      await streamDownloadFile(downloadUrl, downloadName);
    } catch (err) {
      if (uploadStatus) {
        uploadStatus.textContent = err.message || "Download failed";
      }
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

function buildImageMessage(url, mediaPath, message) {
  const wrap = document.createElement("div");
  wrap.className = "image-message image-message--thumb";
  const downloadName = mediaDownloadFilename({
    createdAt: message?.created_at,
    id: message?.id,
    mediaPath,
    prefix: "image",
  });
  const downloadUrl = mediaDownloadUrl(mediaPath || url, downloadName);
  const thumbUrl =
    typeof messageThumbUrl === "function" ? messageThumbUrl(message) : "";
  const displayUrl = thumbUrl || url;

  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "image-message-preview";
  preview.setAttribute("aria-label", "View full image");
  blockNativeImageSave(preview);

  const view = createProtectedImageView(displayUrl, {
    className: "image-message-img",
    alt: "Image",
    maxW: 320,
    maxH: 280,
    fallbackW: 240,
    fallbackH: 180,
  });
  preview.appendChild(view);
  preview.addEventListener("click", (e) => {
    e.preventDefault();
    openMediaLightbox({
      type: "image",
      url,
      downloadUrl,
      downloadName,
    });
  });

  const footer = document.createElement("div");
  footer.className = "image-message-footer video-message-footer";
  footer.innerHTML = `<span class="video-message-name">Image</span>`;
  const dlBtn = document.createElement("button");
  dlBtn.type = "button";
  dlBtn.className = "video-message-download";
  dlBtn.textContent = "Download";
  footer.appendChild(dlBtn);
  wireMessageDownloadButton(dlBtn, downloadUrl, downloadName);

  wrap.appendChild(preview);
  wrap.appendChild(footer);
  return wrap;
}

function buildWaveformBarsHtml(count = 20) {
  let html = "";
  for (let i = 0; i < count; i++) {
    const h = 30 + Math.round(Math.random() * 70);
    html += `<span style="--h:${h}%"></span>`;
  }
  return html;
}

function togglePreviewPlayback(btn, url) {
  if (previewAudio && !previewAudio.paused) {
    previewAudio.pause();
    btn.classList.remove("playing");
    btn.innerHTML = ICON_PLAY;
    refreshUiIcons(btn);
    return;
  }
  if (!previewAudio || previewAudio.src !== url) {
    previewAudio = new Audio(url);
    previewAudio.onended = () => {
      btn.classList.remove("playing");
      btn.innerHTML = ICON_PLAY;
      refreshUiIcons(btn);
    };
  }
  previewAudio.play();
  btn.classList.add("playing");
  btn.innerHTML = ICON_PAUSE;
  refreshUiIcons(btn);
}

function buildVoicePlayer(url) {
  const wrap = document.createElement("div");
  wrap.className = "voice-message";
  wrap.innerHTML = `
    <button type="button" class="voice-play-btn" aria-label="Play voice message">
      ${icon("play", "icon-play", 20)}
      ${icon("pause", "icon-pause hidden", 20)}
    </button>
    <div class="voice-track">
      <div class="voice-wave-bars">${buildWaveformBarsHtml(24)}</div>
      <div class="voice-progress-fill"></div>
    </div>
    <span class="voice-duration">0:00</span>
  `;

  const audio = new Audio(url);
  const playBtn = wrap.querySelector(".voice-play-btn");
  const iconPlay = wrap.querySelector(".icon-play");
  const iconPause = wrap.querySelector(".icon-pause");
  const fill = wrap.querySelector(".voice-progress-fill");
  const durEl = wrap.querySelector(".voice-duration");

  audio.addEventListener("loadedmetadata", () => {
    durEl.textContent = formatDuration(audio.duration);
  });

  audio.addEventListener("timeupdate", () => {
    if (audio.duration) {
      fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
      durEl.textContent = formatDuration(audio.currentTime);
    }
  });

  refreshUiIcons(wrap);

  audio.addEventListener("ended", () => {
    playBtn.classList.remove("playing");
    iconPlay?.classList.remove("hidden");
    iconPause?.classList.add("hidden");
    fill.style.width = "0%";
    durEl.textContent = formatDuration(audio.duration);
    if (activeVoiceAudio === audio) {
      activeVoiceAudio = null;
      activeVoiceEl = null;
    }
  });

  playBtn.onclick = () => {
    if (activeVoiceAudio && activeVoiceAudio !== audio) {
      activeVoiceAudio.pause();
      activeVoiceEl?.classList.remove("playing");
      activeVoiceEl?.querySelector(".icon-play")?.classList.remove("hidden");
      activeVoiceEl?.querySelector(".icon-pause")?.classList.add("hidden");
      activeVoiceEl?.querySelector(".voice-progress-fill") &&
        (activeVoiceEl.querySelector(".voice-progress-fill").style.width = "0%");
    }

    if (audio.paused) {
      audio.play();
      playBtn.classList.add("playing");
      iconPlay.classList.add("hidden");
      iconPause.classList.remove("hidden");
      activeVoiceAudio = audio;
      activeVoiceEl = wrap;
    } else {
      audio.pause();
      playBtn.classList.remove("playing");
      iconPlay.classList.remove("hidden");
      iconPause.classList.add("hidden");
      activeVoiceAudio = null;
      activeVoiceEl = null;
    }
  };

  return wrap;
}

function setVoiceHint(text, recording = false) {
  const hint = document.getElementById("voice-hint");
  const btn = document.getElementById("voice-btn");
  if (hint) {
    hint.textContent = text;
    hint.classList.toggle("recording", recording);
  }
  if (btn) btn.classList.toggle("recording", recording);
}

function showEmptyChat() {
  if (typeof HomiesEvents !== "undefined") HomiesEvents.closeEventView();
  emptyStateEl.classList.remove("hidden");
  welcomeBannerEl.classList.add("hidden");
  messagesEl.classList.add("hidden");
  stopMessagesScrollObserver();
  messagesEl.innerHTML = "";
  resetMessagesPagination();
  if (messagesTopEl) messagesTopEl.classList.add("hidden");
}

function showActiveChat(title, hasMessages = false) {
  emptyStateEl.classList.add("hidden");
  messagesEl.classList.remove("hidden");
  welcomeBannerEl.classList.toggle("hidden", hasMessages);
  if (!hasMessages) {
    welcomeBannerEl.innerHTML = `
      <h3>@${escapeHtml(title)}</h3>
      <p>This is the beginning of your direct message history with <strong>${escapeHtml(title)}</strong>.</p>
    `;
  }
}

document.getElementById("back-btn").addEventListener("click", closeChatView);

function setComposerEnabled(on) {
  messageInput.disabled = !on;
  document.getElementById("image-input").disabled = !on;
  document.getElementById("video-input").disabled = !on;
  document.getElementById("voice-btn").disabled = !on;
  if (!on) closeAllMessageMenus();
  if (typeof HomiesEvents !== "undefined") {
    HomiesEvents.updateChatToolbarMenu();
  } else {
    const chatMenuBtn = document.getElementById("chat-menu-btn");
    const deleteChatBtn = document.getElementById("delete-chat-btn");
    if (chatMenuBtn) chatMenuBtn.disabled = !on;
    if (deleteChatBtn) deleteChatBtn.disabled = !on;
  }
  if (!on) {
    clearPendingAttachment();
    setVoiceHint("Hold mic button to record", false);
  } else {
    setVoiceHint("Hold mic button to record", false);
    if (typeof syncComposerInputHeight === "function") syncComposerInputHeight();
  }
  updateSendButtonState();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function avatarColor(name) {
  let n = 0;
  for (let i = 0; i < (name || "").length; i++) n += name.charCodeAt(i);
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
}

function avatarImgEl(name, avatarPath, className = "") {
  const img = document.createElement("img");
  img.className = className;
  img.alt = name || "";
  if (avatarPath) {
    img.src = mediaUrl(avatarPath);
  } else {
    img.removeAttribute("src");
    img.classList.add("avatar-placeholder");
    img.style.background = avatarColor(name);
    img.style.color = "#fff";
    img.style.display = "flex";
    img.style.alignItems = "center";
    img.style.justifyContent = "center";
    // Use span overlay trick - img can't show text, use wrapper in lists
  }
  return img;
}

function setAvatarElement(el, name, avatarPath) {
  if (avatarPath) {
    el.src = mediaUrl(avatarPath);
    el.classList.remove("avatar-placeholder");
    el.style.background = "";
    el.alt = name;
    el.textContent = "";
  } else {
    el.removeAttribute("src");
    el.classList.add("avatar-placeholder");
    el.style.background = avatarColor(name);
    el.alt = name;
  }
}

function initials(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

function formatTimestamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today at ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (
    d.getDate() === yesterday.getDate() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getFullYear() === yesterday.getFullYear()
  ) {
    return `Yesterday at ${time}`;
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) + ` ${time}`;
}

function matchesSearch(text) {
  if (!searchQuery) return true;
  return (text || "").toLowerCase().includes(searchQuery);
}

function buildDmItem({
  id,
  name,
  avatar,
  online,
  preview,
  onClick,
  chatId,
  chatType,
  groupId,
}) {
  const li = document.createElement("li");
  li.className = "dm-item";
  if (chatId && chatId === currentChatId) li.classList.add("active");
  if (id) li.dataset.userId = id;
  if (chatId) li.dataset.chatId = chatId;

  const wrap = document.createElement("div");
  wrap.className = "dm-avatar-wrap";
  wrap.setAttribute("aria-label", `View ${name} profile photo`);

  if (avatar) {
    const img = document.createElement("img");
    img.className = "dm-avatar";
    img.src = mediaUrl(avatar);
    img.alt = name;
    wrap.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "dm-avatar avatar-placeholder";
    ph.style.background = avatarColor(name);
    ph.textContent = initials(name);
    wrap.appendChild(ph);
  }

  if (online) {
    const dot = document.createElement("span");
    dot.className = "status-dot online";
    wrap.appendChild(dot);
  }

  const isGroupRow = chatType === "group" || (chatId && chatId.startsWith("group_"));
  const resolvedGroupId =
    groupId || (chatId && chatId.startsWith("group_") ? chatId.replace("group_", "") : null);
  bindAvatarOpen(wrap, () => {
    if (isGroupRow) {
      openProfileSheet({
        kind: "group",
        groupId: resolvedGroupId,
        name,
        avatar,
      });
    } else if (id) {
      openProfileSheet({ kind: "user", userId: id, name, avatar, online });
    }
  });

  const meta = document.createElement("div");
  meta.className = "dm-meta";
  meta.innerHTML = `
    <span class="dm-name">${escapeHtml(name)}</span>
    <span class="dm-preview">${escapeHtml(preview || "")}</span>
  `;

  li.appendChild(wrap);
  li.appendChild(meta);
  li.onclick = onClick;
  return li;
}

function buildMemberItem(u, online) {
  const li = document.createElement("li");
  li.className = "member-item";
  li.onclick = () => openDm(u.id);

  const displayName = u.display_name || u.name;
  const wrap = document.createElement("div");
  wrap.className = "dm-avatar-wrap";
  wrap.setAttribute("aria-label", `View ${displayName} profile photo`);

  if (u.avatar) {
    const img = document.createElement("img");
    img.className = "dm-avatar";
    img.src = mediaUrl(u.avatar);
    img.alt = displayName;
    wrap.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "dm-avatar avatar-placeholder";
    ph.style.background = avatarColor(displayName);
    ph.textContent = initials(displayName);
    wrap.appendChild(ph);
  }

  if (online) {
    const dot = document.createElement("span");
    dot.className = "status-dot online";
    wrap.appendChild(dot);
  }

  bindAvatarOpen(wrap, () => {
    openProfileSheet({
      kind: "user",
      userId: u.id,
      name: displayName,
      avatar: u.avatar,
      online,
    });
  });

  const span = document.createElement("span");
  span.className = "member-name";
  span.textContent = displayName;

  li.appendChild(wrap);
  li.appendChild(span);
  return li;
}

let lastMessageAuthor = null;
let lastMessageTime = null;
/** When true, new content and resizes keep the view at the newest messages. */
let stickToBottom = true;
let messagesScrollObserver = null;

const messagesPagination = {
  hasMore: false,
  loadingOlder: false,
  oldestId: null,
};

function resetMessagesPagination() {
  messagesPagination.hasMore = false;
  messagesPagination.loadingOlder = false;
  messagesPagination.oldestId = null;
  setMessagesTopStatus("");
}

function setMessagesTopStatus(text) {
  if (!messagesTopEl) return;
  if (!text) {
    messagesTopEl.classList.add("hidden");
    messagesTopEl.textContent = "";
    return;
  }
  messagesTopEl.classList.remove("hidden");
  messagesTopEl.textContent = text;
}

function isNearBottom(el, threshold = 120) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

function scrollMessagesToEnd() {
  if (!messagesEl || messagesEl.classList.contains("hidden")) return;
  const maxScroll = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
  messagesEl.scrollTop = maxScroll;
  const last = messagesEl.querySelector(
    ".message-group:last-of-type, .message-system:last-of-type"
  );
  if (last) {
    last.scrollIntoView({ block: "end", inline: "nearest" });
    messagesEl.scrollTop = maxScroll;
  }
}

function scheduleScrollToEnd() {
  scrollMessagesToEnd();
  requestAnimationFrame(() => {
    scrollMessagesToEnd();
    requestAnimationFrame(scrollMessagesToEnd);
  });
  setTimeout(scrollMessagesToEnd, 50);
  setTimeout(scrollMessagesToEnd, 150);
}

function startMessagesScrollObserver() {
  stopMessagesScrollObserver();
  if (typeof ResizeObserver === "undefined") return;
  messagesScrollObserver = new ResizeObserver(() => {
    if (stickToBottom) scrollMessagesToEnd();
  });
  messagesScrollObserver.observe(messagesEl);
}

function stopMessagesScrollObserver() {
  messagesScrollObserver?.disconnect();
  messagesScrollObserver = null;
}

function resetMessagesContainer() {
  messagesEl.innerHTML = "";
  const anchor = document.createElement("div");
  anchor.className = "messages-scroll-anchor";
  anchor.setAttribute("aria-hidden", "true");
  messagesEl.appendChild(anchor);
}

function firstMessageNode() {
  return messagesEl.querySelector(".message-group, .message-system");
}

function hasMessagesInStream() {
  return !!messagesEl.querySelector(".message-group, .message-system");
}

function createMessageSeparator() {
  const div = document.createElement("div");
  div.className = "message-separator";
  div.setAttribute("role", "separator");
  div.setAttribute("aria-hidden", "true");
  return div;
}

function removeMessageElement(messageId, container = messagesEl) {
  if (!messageId || !container) return;
  const el = container.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (el) el.remove();
}

async function deleteMessage(messageId) {
  if (!currentChatId || !messageId) return;
  if (!confirm("Delete this message? This cannot be undone.")) return;

  try {
    await api(
      `/api/chats/${encodeURIComponent(currentChatId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE" }
    );
    removeMessageElement(messageId);
    await loadChats();
  } catch (ex) {
    uploadStatus.textContent = ex.message || "Failed to delete message";
    setTimeout(() => {
      if (!pendingAttachment) uploadStatus.textContent = "";
    }, 3000);
  }
}

function resetMenuDropdown(dropdown) {
  if (!dropdown) return;
  dropdown.classList.remove("menu-dropdown--fixed", "toolbar-menu-dropdown--open");
  dropdown.style.display = "";
  dropdown.style.top = "";
  dropdown.style.left = "";
  dropdown.style.right = "";
  dropdown.style.bottom = "";
  dropdown.style.visibility = "";
}

function getActiveToolbarDropdown() {
  const eventDd = document.getElementById("toolbar-menu-event");
  const chatDd = document.getElementById("toolbar-menu-chat");
  if (eventDd && !eventDd.classList.contains("hidden")) return eventDd;
  if (chatDd && !chatDd.classList.contains("hidden")) return chatDd;
  return null;
}

let toolbarDropdownPortal = null;

function portalToolbarDropdown(dropdown) {
  if (!dropdown || dropdown.dataset.portaled === "1") return;
  toolbarDropdownPortal = {
    parent: dropdown.parentElement,
    next: dropdown.nextSibling,
  };
  dropdown.dataset.portaled = "1";
  document.body.appendChild(dropdown);
}

function restoreToolbarDropdown() {
  ["toolbar-menu-chat", "toolbar-menu-event"].forEach((id) => {
    const dropdown = document.getElementById(id);
    if (!dropdown || dropdown.dataset.portaled !== "1") return;
    resetMenuDropdown(dropdown);
    if (toolbarDropdownPortal?.parent) {
      toolbarDropdownPortal.parent.insertBefore(dropdown, toolbarDropdownPortal.next);
    }
    dropdown.dataset.portaled = "0";
  });
  toolbarDropdownPortal = null;
}

function toggleChatToolbarMenu() {
  const menu = document.getElementById("chat-toolbar-menu");
  const btn = document.getElementById("chat-menu-btn");
  if (!menu || !btn || btn.disabled) return;

  const wasOpen = menu.classList.contains("open");
  closeAllMessageMenus();
  if (wasOpen) return;

  const dropdown = getActiveToolbarDropdown();
  if (!dropdown) return;

  portalToolbarDropdown(dropdown);
  menu.classList.add("open");
  btn.setAttribute("aria-expanded", "true");
  dropdown.classList.add("toolbar-menu-dropdown--open");
  requestAnimationFrame(() => positionMenuDropdown(btn, dropdown));
}

function positionMenuDropdown(anchor, dropdown) {
  if (!anchor || !dropdown) return;
  dropdown.classList.add("menu-dropdown--fixed");
  dropdown.style.visibility = "hidden";
  dropdown.style.display = "block";
  const menuW = dropdown.offsetWidth;
  const menuH = dropdown.offsetHeight;
  const rect = anchor.getBoundingClientRect();
  const gap = 6;
  let top = rect.bottom + gap;
  let left = rect.right - menuW;
  if (left < 8) left = 8;
  if (left + menuW > window.innerWidth - 8) {
    left = window.innerWidth - menuW - 8;
  }
  if (top + menuH > window.innerHeight - 8) {
    top = Math.max(8, rect.top - menuH - gap);
  }
  dropdown.style.top = `${Math.round(top)}px`;
  dropdown.style.left = `${Math.round(left)}px`;
  dropdown.style.visibility = "";
}

function closeAllMessageMenus() {
  restoreToolbarDropdown();
  document.querySelectorAll(".message-menu.open").forEach((el) => {
    el.classList.remove("open");
    el.querySelectorAll(".message-menu-dropdown").forEach(resetMenuDropdown);
    el.querySelector(".message-menu-btn")?.setAttribute("aria-expanded", "false");
  });
  const toolbar = document.getElementById("chat-toolbar-menu");
  const toolbarBtn = document.getElementById("chat-menu-btn");
  toolbar?.classList.remove("open");
  toolbarBtn?.setAttribute("aria-expanded", "false");
}

const MESSAGE_LONG_PRESS_MS = 500;

function openMessageMenu(menu, toggle) {
  closeAllMessageMenus();
  menu.classList.add("open");
  toggle.setAttribute("aria-expanded", "true");
  const dropdown = menu.querySelector(".message-menu-dropdown:not(.hidden)");
  if (dropdown) {
    requestAnimationFrame(() => positionMenuDropdown(toggle, dropdown));
  }
}

function attachMessageLongPress(group, menu, toggle) {
  let pressTimer = null;
  let didLongPress = false;

  const clearPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  const startPress = (e) => {
    if (e.type === "mousedown" && e.button !== 0) return;
    didLongPress = false;
    clearPress();
    pressTimer = setTimeout(() => {
      didLongPress = true;
      openMessageMenu(menu, toggle);
      group.classList.add("message-long-press");
    }, MESSAGE_LONG_PRESS_MS);
  };

  const endPress = (e) => {
    clearPress();
    if (didLongPress) {
      e.preventDefault();
      e.stopPropagation();
    }
    group.classList.remove("message-long-press");
  };

  group.addEventListener("touchstart", startPress, { passive: true });
  group.addEventListener("touchend", endPress, { passive: false });
  group.addEventListener("touchcancel", endPress);
  group.addEventListener("touchmove", clearPress, { passive: true });
  group.addEventListener("mousedown", startPress);
  group.addEventListener("mouseup", endPress);
  group.addEventListener("mouseleave", clearPress);
  group.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openMessageMenu(menu, toggle);
  });
}

function attachMessageMenu(group, messageId) {
  const actions = document.createElement("div");
  actions.className = "message-actions";

  const menu = document.createElement("div");
  menu.className = "message-menu";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "message-menu-btn";
  toggle.title = "More";
  toggle.setAttribute("aria-label", "Message options");
  toggle.setAttribute("aria-haspopup", "true");
  toggle.setAttribute("aria-expanded", "false");
  toggle.innerHTML = '<span class="message-menu-dots" aria-hidden="true">⋮</span>';

  const dropdown = document.createElement("div");
  dropdown.className = "message-menu-dropdown";
  dropdown.setAttribute("role", "menu");

  const delItem = document.createElement("button");
  delItem.type = "button";
  delItem.className = "message-menu-item message-menu-item--danger";
  delItem.setAttribute("role", "menuitem");
  delItem.textContent = "Delete message";
  delItem.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMessageMenus();
    deleteMessage(messageId);
  });

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const wasOpen = menu.classList.contains("open");
    closeAllMessageMenus();
    if (!wasOpen) openMessageMenu(menu, toggle);
  });

  dropdown.appendChild(delItem);
  menu.appendChild(toggle);
  menu.appendChild(dropdown);
  actions.appendChild(menu);
  group.appendChild(actions);
  attachMessageLongPress(group, menu, toggle);
}

function buildMessageElement(m, options = {}) {
  const { forceFull = false, skipMenu = false, trackAuthor = true } = options;
  if (m.message_type === "system") {
    const div = document.createElement("div");
    div.className = "message-system";
    div.dataset.messageId = m.id || "";
    div.innerHTML = `<span>${escapeHtml(m.content || "")}</span>`;
    return div;
  }

  const author = m.sender_name || "Unknown";
  const ts = formatTimestamp(m.created_at);
  const sameAuthor = lastMessageAuthor === m.sender_id;
  const tsDate = m.created_at ? new Date(m.created_at).getTime() : 0;
  const compact =
    !forceFull &&
    sameAuthor &&
    lastMessageTime &&
    tsDate - lastMessageTime < 5 * 60 * 1000;

  const group = document.createElement("div");
  const isOwn = me?.id && m.sender_id === me.id;
  group.className =
    "message-group" + (compact ? " compact" : "") + (isOwn ? " own-message" : "");
  group.dataset.messageId = m.id || "";

  if (!compact) {
    let av;
    if (m.sender_avatar) {
      av = document.createElement("img");
      av.className = "message-avatar";
      av.src = mediaUrl(m.sender_avatar);
      av.alt = author;
    } else {
      av = document.createElement("div");
      av.className = "message-avatar avatar-placeholder";
      av.style.background = avatarColor(author);
      av.textContent = initials(author);
    }
    if (m.sender_id) {
      av.setAttribute("aria-label", `View ${author} profile photo`);
      bindAvatarOpen(av, () => {
        openProfileSheet({
          kind: "user",
          userId: m.sender_id,
          name: author,
          avatar: m.sender_avatar,
        });
      });
    }
    group.appendChild(av);
  }

  const content = document.createElement("div");
  content.className = "message-content";

  if (!compact) {
    const header = document.createElement("div");
    header.className = "message-header";
    header.innerHTML = `
      <span class="message-author">${escapeHtml(author)}</span>
      <span class="message-timestamp">${escapeHtml(ts)}</span>
    `;
    content.appendChild(header);
  } else {
    const header = document.createElement("div");
    header.className = "message-header";
    header.innerHTML = `<span class="message-timestamp">${escapeHtml(ts)}</span>`;
    content.appendChild(header);
  }

  const text = document.createElement("div");
  text.className = "message-text";

  if (m.message_type === "text") {
    text.textContent = m.content || "";
  } else if (m.message_type === "image" && m.media_path) {
    text.appendChild(buildImageMessage(mediaUrl(m.media_path), m.media_path, m));
  } else if (m.message_type === "video" && m.media_path) {
    text.appendChild(buildVideoMessage(mediaUrl(m.media_path), m.content, m.media_path, m));
  } else if (m.message_type === "voice" && m.media_path) {
    text.appendChild(buildVoicePlayer(mediaUrl(m.media_path)));
  } else {
    text.textContent = m.content || m.message_type;
  }

  content.appendChild(text);
  group.appendChild(content);

  if (isOwn && m.id && !skipMenu) {
    attachMessageMenu(group, m.id);
  }

  if (trackAuthor) {
    lastMessageAuthor = m.sender_id;
    lastMessageTime = tsDate;
  }
  return group;
}

function insertMessageElement(el, position = "append", container = messagesEl) {
  if (!container) return;
  if (position === "prepend") {
    const first = container.querySelector(".message-group, .message-system");
    if (first) container.insertBefore(el, first);
    else container.appendChild(el);
  } else {
    container.appendChild(el);
  }
}

function renderMessage(m, options = {}) {
  const {
    prepend = false,
    container = messagesEl,
    forceFull = false,
    skipMenu = false,
  } = options;
  const el = buildMessageElement(m, {
    forceFull,
    skipMenu,
    trackAuthor: container === messagesEl,
  });
  const isCompact = el.classList.contains("compact");

  const isChatStream = container === messagesEl;

  if (prepend) {
    if (isChatStream && !isCompact && hasMessagesInStream()) {
      insertMessageElement(el, "prepend", container);
      const next = el.nextElementSibling;
      if (
        next &&
        !next.classList.contains("message-separator") &&
        (next.classList.contains("message-group") || next.classList.contains("message-system"))
      ) {
        container.insertBefore(createMessageSeparator(), next);
      }
    } else {
      insertMessageElement(el, "prepend", container);
    }
  } else {
    if (isChatStream && !isCompact && hasMessagesInStream()) {
      insertMessageElement(createMessageSeparator(), "append", container);
    }
    insertMessageElement(el, "append", container);
  }

  if (isChatStream && !prepend && stickToBottom) {
    scrollMessagesToEnd();
  }
  refreshUiIcons(el);
}

async function fetchMessages(chatId, { before = null } = {}) {
  let url = `/api/chats/${encodeURIComponent(chatId)}/messages?limit=${MESSAGES_PAGE_SIZE}`;
  if (before) url += `&before=${encodeURIComponent(before)}`;
  return api(url);
}

async function loadInitialMessages(chatId) {
  resetMessagesPagination();
  const data = await fetchMessages(chatId);
  lastMessageAuthor = null;
  lastMessageTime = null;

  data.messages.forEach((m) => renderMessage(m, { scroll: false }));

  if (data.messages.length) {
    messagesPagination.oldestId = data.messages[0].id;
  }
  messagesPagination.hasMore = data.has_more;

  if (messagesPagination.hasMore) {
    setMessagesTopStatus("Scroll up for older messages");
  }

  stickToBottom = true;
  startMessagesScrollObserver();
  scheduleScrollToEnd();
}

async function loadOlderMessages() {
  if (
    !currentChatId ||
    !messagesPagination.hasMore ||
    messagesPagination.loadingOlder ||
    !messagesPagination.oldestId
  ) {
    return;
  }

  messagesPagination.loadingOlder = true;
  setMessagesTopStatus("Loading older messages…");

  const prevHeight = messagesEl.scrollHeight;
  const prevTop = messagesEl.scrollTop;

  try {
    const data = await fetchMessages(currentChatId, {
      before: messagesPagination.oldestId,
    });

    if (!data.messages.length) {
      messagesPagination.hasMore = false;
      setMessagesTopStatus("Beginning of conversation");
      return;
    }

    lastMessageAuthor = null;
    lastMessageTime = null;
    data.messages.forEach((m) => renderMessage(m, { prepend: true, scroll: false }));

    messagesPagination.oldestId = data.messages[0].id;
    messagesPagination.hasMore = data.has_more;

    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight - prevHeight + prevTop;
    });

    if (messagesPagination.hasMore) {
      setMessagesTopStatus("Scroll up for older messages");
    } else {
      setMessagesTopStatus("Beginning of conversation");
    }
  } catch (ex) {
    setMessagesTopStatus(ex.message || "Could not load older messages");
  } finally {
    messagesPagination.loadingOlder = false;
  }
}

function onMessagesScroll() {
  stickToBottom = isNearBottom(messagesEl);
  if (messagesEl.scrollTop < 80) {
    loadOlderMessages();
  }
}

messagesEl.addEventListener("scroll", onMessagesScroll);

messagesEl.addEventListener(
  "loadedmetadata",
  (e) => {
    if (stickToBottom && e.target.tagName === "VIDEO") scrollMessagesToEnd();
  },
  true
);

messagesEl.addEventListener(
  "load",
  (e) => {
    if (stickToBottom && e.target.tagName === "IMG") scrollMessagesToEnd();
  },
  true
);

function syncCompressionSettingsUI() {
  const slider = document.getElementById("media-compression");
  const label = document.getElementById("compression-value-label");
  if (!slider) return;
  const pct = getMediaCompressionPercent();
  slider.value = String(pct);
  if (label) {
    label.textContent =
      typeof formatCompressionLabel === "function" ? formatCompressionLabel(pct) : `${pct}%`;
  }
  if (typeof applyCompressionSliderStyle === "function") {
    applyCompressionSliderStyle(slider, pct);
  }
}

async function loadMe() {
  me = await api("/api/users/me");
  const name = me.display_name || me.name;
  document.getElementById("me-name").textContent = name;
  document.getElementById("display-name").value = name;

  const loginEl = document.getElementById("account-login-name");
  if (loginEl) {
    loginEl.innerHTML = `Account: <strong>${escapeHtml(me.name)}</strong>`;
  }

  if (me.media_compression_percent != null) {
    me.settings = me.settings || {};
    me.settings.media_compression_percent = me.media_compression_percent;
  }
  setMediaCompressionPercentLocal(getMediaCompressionPercent());

  applyAvatarEl(document.getElementById("my-avatar"), name, me.avatar, "0.85rem");
  applyAvatarEl(document.getElementById("profile-avatar-preview"), name, me.avatar, "2.25rem");
  syncAvatarRemoveButton();
  syncCompressionSettingsUI();
  if (typeof HomiesBeam !== "undefined") HomiesBeam.onMeLoaded();
}

function syncAvatarRemoveButton() {
  const btn = document.getElementById("remove-avatar-btn");
  if (!btn) return;
  const hasAvatar = !!(me?.avatar);
  btn.classList.toggle("hidden", !hasAvatar);
  btn.disabled = !hasAvatar;
}

function applyAvatarEl(el, name, avatarPath, fontSize) {
  if (!el) return;
  if (avatarPath) {
    const url = avatarPath.startsWith("/") ? avatarPath : mediaUrl(avatarPath);
    el.style.backgroundImage = `url(${url})`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.style.backgroundColor = "";
    el.textContent = "";
    el.classList.remove("avatar-placeholder");
    if (el.classList.contains("account-avatar")) {
      el.style.display = "block";
    }
  } else {
    el.style.backgroundImage = "";
    el.classList.add("avatar-placeholder");
    el.style.background = avatarColor(name);
    el.textContent = initials(name);
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.fontWeight = "600";
    el.style.color = "#fff";
    el.style.fontSize = fontSize || "0.85rem";
  }
}

async function loadOnline() {
  const { online } = await api("/api/users/online");
  document.getElementById("online-count").textContent = online.length;
  document.getElementById("members-online-count").textContent = online.length;

  const ul = document.getElementById("online-list");
  const membersUl = document.getElementById("members-online");
  ul.innerHTML = "";
  membersUl.innerHTML = "";

  online.forEach((u) => {
    const name = u.display_name || u.name;
    if (!matchesSearch(name)) return;

    ul.appendChild(
      buildDmItem({
        id: u.id,
        name,
        avatar: u.avatar,
        online: true,
        preview: "Online",
        onClick: () => openDm(u.id),
      })
    );
    membersUl.appendChild(buildMemberItem(u, true));
  });
}

async function loadUsers() {
  const { users } = await api("/api/users/all");
  const ul = document.getElementById("users-list");
  ul.innerHTML = "";

  users.forEach((u) => {
    const name = u.display_name || u.name;
    if (!matchesSearch(name)) return;
    ul.appendChild(buildMemberItem(u, u.online));
  });
}

let groupPickerUsers = [];
let groupPickerFilter = "";

function updateGroupMembersCount() {
  const countEl = document.getElementById("group-members-count");
  if (!countEl) return;
  const n = document.querySelectorAll(".group-member-pick.selected").length;
  countEl.textContent = n === 1 ? "1 selected" : `${n} selected`;
}

function buildGroupMemberPickRow(u) {
  const name = u.display_name || u.name;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "group-member-pick";
  btn.dataset.userId = u.id;
  btn.setAttribute("role", "option");
  btn.setAttribute("aria-selected", "false");

  const avWrap = document.createElement("div");
  avWrap.className = "dm-avatar-wrap";
  if (u.avatar) {
    const img = document.createElement("img");
    img.className = "dm-avatar";
    img.src = mediaUrl(u.avatar);
    img.alt = name;
    avWrap.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "dm-avatar avatar-placeholder";
    ph.style.background = avatarColor(name);
    ph.textContent = initials(name);
    avWrap.appendChild(ph);
  }
  if (u.online) {
    const dot = document.createElement("span");
    dot.className = "status-dot online";
    avWrap.appendChild(dot);
  }

  const check = document.createElement("span");
  check.className = "group-member-check";
  check.setAttribute("aria-hidden", "true");
  check.innerHTML = icon("check", "", 18);

  const nameEl = document.createElement("span");
  nameEl.className = "group-member-pick-name";
  nameEl.textContent = name;

  btn.appendChild(check);
  btn.appendChild(avWrap);
  btn.appendChild(nameEl);

  if (u.online) {
    const badge = document.createElement("span");
    badge.className = "group-member-pick-badge";
    badge.textContent = "Online";
    btn.appendChild(badge);
  }

  btn.addEventListener("click", () => {
    const selected = btn.classList.toggle("selected");
    btn.setAttribute("aria-selected", selected ? "true" : "false");
    updateGroupMembersCount();
  });

  return btn;
}

function renderGroupMembersPicker() {
  const list = document.getElementById("group-members-list");
  if (!list) return;
  list.innerHTML = "";

  const q = groupPickerFilter.trim().toLowerCase();
  const filtered = groupPickerUsers.filter((u) => {
    const name = (u.display_name || u.name || "").toLowerCase();
    return !q || name.includes(q);
  });

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "group-members-empty";
    empty.textContent = q ? "No friends match your search" : "No friends to add";
    list.appendChild(empty);
    updateGroupMembersCount();
    return;
  }

  filtered.forEach((u) => list.appendChild(buildGroupMemberPickRow(u)));
  updateGroupMembersCount();
  refreshUiIcons(list);
}

async function refreshGroupMembersPicker() {
  const { users } = await api("/api/users/all");
  groupPickerUsers = users.filter((u) => u.id !== me?.id);
  renderGroupMembersPicker();
}

function getSelectedGroupMemberIds() {
  return [...document.querySelectorAll(".group-member-pick.selected")].map((el) => el.dataset.userId);
}

function previewText(msg) {
  if (!msg) return "No messages yet";
  if (msg.message_type === "system") return msg.content || "";
  if (msg.message_type === "text") return msg.content || "";
  if (msg.message_type === "image") return "📷 Image";
  if (msg.message_type === "video") return "🎬 Video";
  if (msg.message_type === "voice") return "🎤 Voice message";
  return msg.content || msg.message_type;
}

async function loadChats() {
  const { chats } = await api("/api/chats/list");
  const ul = document.getElementById("chats-list");
  ul.innerHTML = "";

  chats.forEach((c) => {
    const name = c.name;
    if (!matchesSearch(name)) return;

    const preview = previewText(c.last_message);
    ul.appendChild(
      buildDmItem({
        id: c.type === "dm" ? c.peer_id : undefined,
        name,
        avatar: c.avatar,
        online: c.online,
        preview,
        chatId: c.chat_id,
        chatType: c.type,
        groupId: c.group_id,
        onClick: () =>
          selectChat(
            c.chat_id,
            name,
            c.type,
            c.avatar,
            c.type === "dm"
              ? { id: c.peer_id, type: "dm" }
              : { type: c.type, members: c.members, group_id: c.group_id }
          ),
      })
    );
  });
}

async function openDm(peerId) {
  const data = await api(`/api/chats/dm/${peerId}`);
  const peer = data.peer;
  await selectChat(
    data.chat_id,
    peer.display_name || peer.name,
    "dm",
    peer.avatar,
    { id: peer.id, type: "dm", display_name: peer.display_name, name: peer.name }
  );
  await loadChats();
}

async function selectChat(chatId, title, type, avatar, meta = null) {
  if (typeof HomiesEvents !== "undefined") HomiesEvents.closeEventView();
  if (typeof VoiceCall !== "undefined" && VoiceCall.isInCall()) {
    const nextPeer = type === "dm" && meta?.id ? meta.id : null;
    if (VoiceCall.getPeerId() !== nextPeer) VoiceCall.forceEnd();
  }
  if (typeof GroupMeshCall !== "undefined" && GroupMeshCall.isInCall()) {
    if (GroupMeshCall.getChatId() !== chatId) GroupMeshCall.forceEnd();
  }
  if (typeof GroupCall !== "undefined" && GroupCall.isInCall()) {
    if (GroupCall.getChatId() !== chatId) GroupCall.forceEnd();
  }
  cancelActiveTransfer();
  clearPendingAttachment();
  setTransferStatus(null);
  currentChatId = chatId;
  currentChatMeta = { title, type, avatar, ...meta };
  const isGroup = type === "group";
  document.querySelector(".channel-hash").textContent = isGroup ? "#" : "@";
  chatTitleEl.textContent = title;
  messageInput.placeholder = composerPlaceholder(title, isGroup);
  setComposerEnabled(true);
  openChatView();
  stickToBottom = true;
  emptyStateEl.classList.add("hidden");
  messagesEl.classList.remove("hidden");

  document.querySelectorAll(".dm-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.chatId === chatId);
  });

  lastMessageAuthor = null;
  lastMessageTime = null;
  resetMessagesContainer();
  resetMessagesPagination();

  await loadInitialMessages(chatId);
  const hasMessages = messagesEl.querySelector(".message-group, .message-system") !== null;
  showActiveChat(title, hasMessages);
  updateChatHeaderAvatar();
  scheduleScrollToEnd();
  updateCallButton();
  if (typeof HomiesEvents !== "undefined") HomiesEvents.updateChatToolbarMenu();
}

async function sendMedia(file, messageType, mediaType) {
  if (
    typeof HomiesEvents !== "undefined" &&
    HomiesEvents.currentEventId &&
    typeof HomiesEvents.sendEventMedia === "function"
  ) {
    return HomiesEvents.sendEventMedia(file, messageType, mediaType);
  }
  if (!currentChatId || !file) return;
  const pct = getMediaCompressionPercent();
  const doCompress = pct < 100;
  const signal = beginActiveTransfer();

  try {
    if (doCompress) {
      setTransferStatus({
        stage: "compress",
        percent: 0,
        label: "Preparing compression…",
        originalSize: file.size,
        mediaType,
      });
    } else {
      setTransferStatus({ stage: "upload", percent: 0, label: "Uploading… 0%" });
    }

    const result = await uploadChunked(file, mediaType, {
      compress: doCompress,
      onProgress: (p) => {
        if (!signal.aborted) setTransferStatus({ mediaType, ...p });
      },
      signal,
    });

    throwIfTransferAborted(signal);

    if (result.compression) {
      const summary =
        typeof compressionSummary === "function"
          ? compressionSummary(result.compression.originalSize, result.compression.compressedSize)
          : null;
      setTransferStatus({
        stage: "compress",
        percent: 100,
        label: "Compression done",
        summary,
        originalSize: result.compression.originalSize,
        compressedSize: result.compression.compressedSize,
      });
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 900);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new DOMException("Upload cancelled", "AbortError"));
          },
          { once: true }
        );
      });
    }

    throwIfTransferAborted(signal);
    setTransferStatus({ stage: "upload", percent: 100, label: "Sending message…" });

    await api("/api/chats/send", {
      method: "POST",
      body: JSON.stringify({
        chat_id: currentChatId,
        content: file.name,
        message_type: messageType,
        media_path: result.media_path,
        thumb_path: result.thumb_path || null,
      }),
      signal,
    });
    setTransferStatus(null);
  } catch (ex) {
    setTransferStatus(null);
    if (isTransferCancelled(ex)) return;
    uploadStatus.textContent = ex.message;
    throw ex;
  }
}

async function sendMessage() {
  const eventId =
    typeof HomiesEvents !== "undefined" ? HomiesEvents.currentEventId : null;
  if (!currentChatId && !eventId) return;

  const content = messageInput.value.trim();
  const attachment = pendingAttachment;

  if (!content && !attachment) return;

  sendBtn.disabled = true;

  try {
    if (content) {
      messageInput.value = "";
      if (typeof syncComposerInputHeight === "function") syncComposerInputHeight();
      if (eventId && typeof HomiesEvents.sendEventPost === "function") {
        await HomiesEvents.sendEventPost({ content, message_type: "text" });
      } else {
        await api("/api/chats/send", {
          method: "POST",
          body: JSON.stringify({ chat_id: currentChatId, content, message_type: "text" }),
        });
      }
    }

    if (attachment) {
      const { file, messageType, mediaType } = attachment;
      await sendMedia(file, messageType, mediaType);
      clearPendingAttachment();
    }
  } catch (ex) {
    if (!isTransferCancelled(ex)) {
      uploadStatus.textContent = ex.message || "Failed to send";
    } else {
      setTransferStatus(null);
    }
  } finally {
    updateSendButtonState();
  }
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (typeof VoiceCall !== "undefined" && VoiceCall.handleWsMessage(data)) {
      return;
    }
    if (typeof GroupMeshCall !== "undefined" && GroupMeshCall.handleWsMessage(data)) {
      return;
    }
    if (typeof GroupCall !== "undefined" && GroupCall.handleWsMessage(data)) {
      return;
    }
    if (typeof HomiesBeam !== "undefined" && HomiesBeam.handleWsMessage(data)) {
      return;
    }
    if (data.type === "presence") {
      loadOnline();
      loadUsers();
      loadChats();
      return;
    }
    if (data.type === "message" && data.chat_id === currentChatId) {
      if (!messageAlreadyInStream(data.message?.id)) {
        stickToBottom = isNearBottom(messagesEl);
        renderMessage(data.message);
        if (stickToBottom) scheduleScrollToEnd();
      }
      loadChats();
    }
    if (data.type === "message") loadChats();

    if (data.type === "message_deleted" && data.chat_id === currentChatId) {
      removeMessageElement(data.message_id);
      loadChats();
    }
    if (data.type === "message_deleted") loadChats();

    if (data.type === "chat_purged") {
      if (data.chat_id === currentChatId) closeChatView();
      loadChats();
      loadDeletedChats();
    }

    if (data.type === "event_post" || data.type === "event_post_deleted") {
      if (typeof HomiesEvents !== "undefined" && HomiesEvents.handleWsEventMessage(data)) {
        return;
      }
    }

    if (typeof HomiesEvents !== "undefined" && HomiesEvents.handleWsEventMessage(data)) {
      return;
    }
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  }, 30000);
}

function syncComposerInputHeight() {
  if (!messageInput) return;
  const maxH = 200;
  messageInput.style.height = "auto";
  const scrollH = messageInput.scrollHeight;
  const nextH = Math.min(scrollH, maxH);
  messageInput.style.height = `${nextH}px`;
  const needsScroll = scrollH > maxH;
  messageInput.classList.toggle("composer-input--scroll", needsScroll);
  if (!needsScroll) {
    messageInput.scrollTop = 0;
  }
}

messageInput.addEventListener("input", () => {
  syncComposerInputHeight();
  updateSendButtonState();
});

sendBtn.onclick = sendMessage;
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

document.getElementById("image-input").onchange = (e) => {
  const f = e.target.files[0];
  if (f) queueMediaAttachment(f, "image", "image");
  e.target.value = "";
};

document.getElementById("video-input").onchange = (e) => {
  const f = e.target.files[0];
  if (f) queueMediaAttachment(f, "video", "video");
  e.target.value = "";
};

const voiceBtn = document.getElementById("voice-btn");
let voiceHoldActive = false;
let voicePointerActive = false;
let voiceRecorderMime = "audio/webm";

function getPreferredAudioMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/aac",
    "audio/ogg;codecs=opus",
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function mimeToVoiceExtension(mime) {
  if (!mime) return "webm";
  if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

async function getMicrophoneStream() {
  if (!window.isSecureContext) {
    const host = location.hostname;
    const isLocal =
      host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    if (!isLocal) {
      throw new Error(
        "Microphone needs a secure connection. Use https:// on this server, or open http://localhost:8000 on this phone."
      );
    }
  }

  if (typeof MediaRecorder === "undefined") {
    throw new Error("Voice recording is not supported in this browser.");
  }

  const nav = navigator;
  if (nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === "function") {
    return nav.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  }

  const legacy =
    nav.getUserMedia ||
    nav.webkitGetUserMedia ||
    nav.mozGetUserMedia ||
    nav.msGetUserMedia;

  if (legacy) {
    return new Promise((resolve, reject) => {
      legacy.call(nav, { audio: true }, resolve, reject);
    });
  }

  throw new Error("Microphone API unavailable. Try Chrome/Safari over HTTPS.");
}

function createVoiceRecorder(stream) {
  voiceRecorderMime = getPreferredAudioMimeType() || "audio/webm";
  try {
    return voiceRecorderMime
      ? new MediaRecorder(stream, { mimeType: voiceRecorderMime })
      : new MediaRecorder(stream);
  } catch (_) {
    voiceRecorderMime = "";
    return new MediaRecorder(stream);
  }
}

function cancelVoiceRecord() {
  if (voiceRecordTimer) {
    clearInterval(voiceRecordTimer);
    voiceRecordTimer = null;
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.onstop = null;
    try {
      mediaRecorder.stop();
    } catch (_) {}
  }
  if (voiceRecordStream) {
    voiceRecordStream.getTracks().forEach((t) => t.stop());
    voiceRecordStream = null;
  }
  mediaRecorder = null;
  voiceChunks = [];
  voiceHoldActive = false;
  voicePointerActive = false;
  setVoiceHint("Hold mic button to record", false);
}

async function startVoiceRecord() {
  if (!voiceBtn || voiceBtn.disabled) return;
  if (!currentChatId || messageInput.disabled) return;
  if (mediaRecorder?.state === "recording") return;
  if (pendingAttachment) return;
  if (voiceHoldActive) return;

  try {
    const stream = await getMicrophoneStream();
    voiceRecordStream = stream;
    voiceChunks = [];
    mediaRecorder = createVoiceRecorder(stream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) voiceChunks.push(e.data);
    };
    mediaRecorder.onerror = () => {
      uploadStatus.textContent = "Recording error";
      cancelVoiceRecord();
    };

    try {
      mediaRecorder.start(250);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    }

    voiceRecordStart = Date.now();
    voiceHoldActive = true;
    setVoiceHint("Recording… release to preview", true);
    uploadStatus.textContent = "";
    voiceBtn.classList.add("recording");

    voiceRecordTimer = setInterval(() => {
      const sec = (Date.now() - voiceRecordStart) / 1000;
      setVoiceHint(`Recording ${formatDuration(sec)} — release to preview`, true);
    }, 200);
  } catch (ex) {
    voiceHoldActive = false;
    voicePointerActive = false;
    voiceBtn?.classList.remove("recording");
    const msg = ex?.message || "Microphone access denied";
    setVoiceHint("Mic unavailable", false);
    uploadStatus.textContent = msg;
  }
}

function finishVoiceRecord() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    voiceHoldActive = false;
    setVoiceHint("Hold mic button to record", false);
    return;
  }

  if (voiceRecordTimer) {
    clearInterval(voiceRecordTimer);
    voiceRecordTimer = null;
  }

  mediaRecorder.onstop = () => {
    const elapsed = (Date.now() - voiceRecordStart) / 1000;
    if (voiceRecordStream) {
      voiceRecordStream.getTracks().forEach((t) => t.stop());
      voiceRecordStream = null;
    }
    mediaRecorder = null;
    voiceHoldActive = false;
    voicePointerActive = false;
    voiceBtn?.classList.remove("recording");
    setVoiceHint("Hold mic button to record", false);

    if (elapsed < MIN_VOICE_SECONDS || voiceChunks.length === 0) {
      voiceChunks = [];
      uploadStatus.textContent = "Hold longer to record";
      setTimeout(() => {
        if (!pendingAttachment) uploadStatus.textContent = "";
      }, 2000);
      return;
    }

    const blobType = voiceRecorderMime || voiceChunks[0]?.type || "audio/webm";
    const ext = mimeToVoiceExtension(blobType);
    const blob = new Blob(voiceChunks, { type: blobType });
    voiceChunks = [];
    const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blobType });
    const previewUrl = URL.createObjectURL(blob);
    pendingAttachment = {
      file,
      messageType: "voice",
      mediaType: "voice",
      previewUrl,
      duration: elapsed,
    };
    renderAttachmentPreview();
    updateSendButtonState();
    uploadStatus.textContent = "Voice ready — click Send";
  };

  try {
    mediaRecorder.stop();
  } catch (_) {
    cancelVoiceRecord();
  }
}

function onVoiceHoldEnd() {
  if (!voiceHoldActive && !voicePointerActive) return;
  voiceHoldActive = false;
  voicePointerActive = false;
  finishVoiceRecord();
}

if (voiceBtn) {
  voiceBtn.addEventListener("contextmenu", (e) => e.preventDefault());

  voiceBtn.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary || voiceBtn.disabled) return;
    if (voicePointerActive) return;
    voicePointerActive = true;
    try {
      voiceBtn.setPointerCapture(e.pointerId);
    } catch (_) {}
    e.preventDefault();
    startVoiceRecord();
  });

  const endPointer = (e) => {
    if (!voicePointerActive) return;
    try {
      if (voiceBtn.hasPointerCapture?.(e.pointerId)) {
        voiceBtn.releasePointerCapture(e.pointerId);
      }
    } catch (_) {}
    e.preventDefault();
    onVoiceHoldEnd();
  };

  voiceBtn.addEventListener("pointerup", endPointer);
  voiceBtn.addEventListener("pointercancel", endPointer);
  voiceBtn.addEventListener("lostpointercapture", () => {
    if (voicePointerActive) onVoiceHoldEnd();
  });
}

SINGLE_PANEL_MQ.addEventListener("change", syncLayoutState);
window.addEventListener("resize", syncLayoutState);
window.addEventListener("orientationchange", () => setTimeout(syncLayoutState, 100));

function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
  if (id === "profile-modal") {
    switchSettingsTab("account");
  }
}

document.querySelectorAll(".modal-close").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.modal));
});

document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target !== overlay) return;
    overlay.classList.add("hidden");
    if (overlay.id === "profile-modal") switchSettingsTab("account");
    if (overlay.id === "avatar-crop-modal") closeAvatarCropModal();
  });
});

async function openGroupModal() {
  groupPickerFilter = "";
  const search = document.getElementById("group-members-search");
  const nameInput = document.getElementById("group-name");
  if (search) search.value = "";
  if (nameInput) nameInput.value = "";
  await refreshGroupMembersPicker();
  openModal("group-modal");
}

document.getElementById("open-group-btn").onclick = openGroupModal;
document.getElementById("open-group-btn-side").onclick = openGroupModal;
function switchSettingsTab(tab) {
  document.querySelectorAll(".settings-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.settingsTab === tab);
  });
  document.querySelectorAll(".settings-panel").forEach((p) => {
    p.classList.toggle("active", p.id === `settings-${tab}`);
  });
  document.getElementById("settings-footer-account").classList.toggle("hidden", tab !== "account");
  document.getElementById("settings-footer-media").classList.toggle("hidden", tab !== "media");
  document.getElementById("settings-footer-deleted").classList.toggle("hidden", tab !== "deleted");
  if (tab === "deleted") loadDeletedChats();
  if (tab === "media") syncCompressionSettingsUI();
}

async function loadDeletedChats() {
  const list = document.getElementById("deleted-chats-list");
  const empty = document.getElementById("deleted-empty");
  list.innerHTML = "";
  try {
    const { deleted } = await api("/api/chats/deleted");
    if (!deleted.length) {
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    deleted.forEach((c) => {
      const li = document.createElement("li");
      li.className = "deleted-chat-item";
      const deletedDate = c.deleted_at
        ? new Date(c.deleted_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
        : "";
      const typeLabel = c.type === "group" ? "Group" : "DM";
      li.innerHTML = `
        <div class="deleted-chat-info">
          <span class="deleted-chat-name">${escapeHtml(c.name)}</span>
          <span class="deleted-chat-meta">${typeLabel} · deleted ${escapeHtml(deletedDate)}</span>
        </div>
        <div class="deleted-chat-actions">
          <button type="button" class="btn-restore">Restore</button>
          <button type="button" class="btn-delete-forever">Delete forever</button>
        </div>
      `;
      li.querySelector(".btn-restore").onclick = async () => {
        await api(`/api/chats/${encodeURIComponent(c.chat_id)}/restore`, { method: "POST" });
        await loadDeletedChats();
        await loadChats();
      };
      li.querySelector(".btn-delete-forever").onclick = async () => {
        if (
          !confirm(
            `Permanently delete "${c.name}"?\n\nAll messages and media will be removed from the server. This cannot be undone.`
          )
        ) {
          return;
        }
        await api(`/api/chats/${encodeURIComponent(c.chat_id)}/permanent`, { method: "DELETE" });
        if (currentChatId === c.chat_id) closeChatView();
        await loadDeletedChats();
        await loadChats();
      };
      list.appendChild(li);
    });
  } catch (ex) {
    empty.textContent = ex.message;
    empty.classList.remove("hidden");
  }
}

async function deleteCurrentChat() {
  if (!currentChatId) return;
  const name = currentChatMeta?.title || "this conversation";
  if (!confirm(`Delete "${name}" for everyone? You can restore it later in Settings → Deleted Chats.`)) {
    return;
  }
  const res = await api(`/api/chats/${encodeURIComponent(currentChatId)}`, {
    method: "DELETE",
  });
  if (res.message) {
    stickToBottom = true;
    renderMessage(res.message);
    scheduleScrollToEnd();
  }
  closeChatView();
  await loadChats();
}

function openProfileModal(tab = "account") {
  if (typeof tab !== "string") tab = "account";
  clearPinFields();
  openModal("profile-modal");
  switchSettingsTab(tab);
}

document.querySelectorAll(".settings-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchSettingsTab(tab.dataset.settingsTab));
});

const chatToolbarMenu = document.getElementById("chat-toolbar-menu");
const chatMenuBtn = document.getElementById("chat-menu-btn");
if (chatMenuBtn && chatToolbarMenu) {
  const onToolbarMenuTap = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleChatToolbarMenu();
  };
  chatMenuBtn.addEventListener("click", onToolbarMenuTap);
}

document.getElementById("delete-chat-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeAllMessageMenus();
  deleteCurrentChat();
});

document.getElementById("open-profile-btn").onclick = () => openProfileModal("account");
document.getElementById("settings-btn").onclick = () => openProfileModal("account");

document.getElementById("media-lightbox")?.addEventListener("click", (e) => {
  if (
    e.target.classList.contains("media-lightbox-backdrop") ||
    e.target.classList.contains("media-lightbox-close")
  ) {
    closeMediaLightbox();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const sheet = document.getElementById("profile-sheet");
  if (sheet && !sheet.classList.contains("hidden")) {
    closeProfileSheet();
    return;
  }
  if (!document.getElementById("media-lightbox")?.classList.contains("hidden")) {
    closeMediaLightbox();
  }
});

const groupMembersSearch = document.getElementById("group-members-search");
if (groupMembersSearch) {
  groupMembersSearch.addEventListener("input", (e) => {
    groupPickerFilter = e.target.value;
    renderGroupMembersPicker();
  });
}

document.getElementById("create-group-btn").onclick = async () => {
  const name = document.getElementById("group-name").value.trim();
  const member_ids = getSelectedGroupMemberIds();
  if (!name) return;
  const { chat_id, group } = await api("/api/groups/create", {
    method: "POST",
    body: JSON.stringify({ name, member_ids }),
  });
  document.getElementById("group-name").value = "";
  closeModal("group-modal");
  await loadChats();
  await selectChat(chat_id, group.name, "group");
};

const mediaCompressionSlider = document.getElementById("media-compression");
if (mediaCompressionSlider) {
  mediaCompressionSlider.addEventListener("input", () => {
    const pct = clampCompressionPercent(mediaCompressionSlider.value);
    const label = document.getElementById("compression-value-label");
    if (label) {
      label.textContent =
        typeof formatCompressionLabel === "function" ? formatCompressionLabel(pct) : `${pct}%`;
    }
    if (typeof applyCompressionSliderStyle === "function") {
      applyCompressionSliderStyle(mediaCompressionSlider, pct);
    }
    setMediaCompressionPercentLocal(pct);
    if (me) {
      me.settings = me.settings || {};
      me.settings.media_compression_percent = pct;
    }
  });
}

function formatInviteExpiry(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `Expires ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

document.getElementById("generate-invite-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("generate-invite-btn");
  const box = document.getElementById("invite-code-result");
  const codeEl = document.getElementById("invite-code-value");
  const expEl = document.getElementById("invite-code-expires");
  if (!btn || !box || !codeEl) return;
  btn.disabled = true;
  try {
    const data = await api("/api/users/invite-code", { method: "POST" });
    codeEl.textContent = data.code || "";
    if (expEl) {
      expEl.textContent = formatInviteExpiry(data.expires_at) || "Valid for 10 minutes";
    }
    box.classList.remove("hidden");
    try {
      await navigator.clipboard.writeText(data.code);
      if (uploadStatus) uploadStatus.textContent = "Invite code copied to clipboard";
    } catch (_) {
      if (uploadStatus) uploadStatus.textContent = "Invite code generated";
    }
  } catch (ex) {
    if (uploadStatus) uploadStatus.textContent = ex.message || "Could not generate invite code";
  } finally {
    btn.disabled = false;
  }
});

function clearPinFields() {
  ["pin-current", "pin-new", "pin-confirm"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const status = document.getElementById("pin-reset-status");
  if (status) {
    status.textContent = "";
    status.classList.add("hidden");
    status.classList.remove("pin-reset-status--error", "pin-reset-status--ok");
  }
}

function setPinResetStatus(message, ok) {
  const status = document.getElementById("pin-reset-status");
  if (!status) return;
  status.textContent = message;
  status.classList.remove("hidden", "pin-reset-status--error", "pin-reset-status--ok");
  status.classList.add(ok ? "pin-reset-status--ok" : "pin-reset-status--error");
}

document.getElementById("reset-pin-btn")?.addEventListener("click", async () => {
  const current = document.getElementById("pin-current")?.value?.trim() ?? "";
  const newPin = document.getElementById("pin-new")?.value?.trim() ?? "";
  const confirm = document.getElementById("pin-confirm")?.value?.trim() ?? "";
  const btn = document.getElementById("reset-pin-btn");

  if (!/^\d{6}$/.test(current) || !/^\d{6}$/.test(newPin) || !/^\d{6}$/.test(confirm)) {
    setPinResetStatus("PIN must be exactly 6 digits.", false);
    return;
  }
  if (newPin !== confirm) {
    setPinResetStatus("New PIN and confirmation do not match.", false);
    return;
  }
  if (current === newPin) {
    setPinResetStatus("New PIN must be different from your current PIN.", false);
    return;
  }

  if (btn) btn.disabled = true;
  try {
    await api("/api/users/me/pin", {
      method: "PATCH",
      body: JSON.stringify({ current_pin: current, new_pin: newPin }),
    });
    clearPinFields();
    setPinResetStatus("PIN updated. Use the new PIN next time you sign in.", true);
  } catch (ex) {
    setPinResetStatus(ex.message || "Could not change PIN.", false);
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.getElementById("save-display-btn").onclick = async () => {
  const display_name = document.getElementById("display-name").value.trim();
  const location_share_allowed =
    typeof HomiesBeam !== "undefined"
      ? HomiesBeam.getLocationShareFromForm()
      : !!document.getElementById("location-share-allowed")?.checked;
  if (!location_share_allowed && typeof HomiesBeam !== "undefined" && HomiesBeam.isBeaming()) {
    await HomiesBeam.stopBeam();
  }
  await api("/api/users/me", {
    method: "PATCH",
    body: JSON.stringify({ display_name, location_share_allowed }),
  });
  await loadMe();
  closeModal("profile-modal");
};

document.getElementById("save-media-btn").onclick = async () => {
  const media_compression_percent = mediaCompressionSlider
    ? clampCompressionPercent(mediaCompressionSlider.value)
    : getMediaCompressionPercent();
  await api("/api/users/me", {
    method: "PATCH",
    body: JSON.stringify({ media_compression_percent }),
  });
  await loadMe();
  closeModal("profile-modal");
};

document.getElementById("remove-avatar-btn")?.addEventListener("click", async () => {
  if (!me?.avatar) return;
  if (!confirm("Remove your profile photo?")) return;
  const btn = document.getElementById("remove-avatar-btn");
  if (btn) btn.disabled = true;
  try {
    await api("/api/users/me/avatar", { method: "DELETE" });
    await loadMe();
    await refreshAvatarsAfterOwnChange();
  } catch (ex) {
    uploadStatus.textContent = ex.message || "Failed to remove photo";
    syncAvatarRemoveButton();
  } finally {
    if (btn) btn.disabled = false;
  }
});

async function uploadAvatarFile(f) {
  const pct = getMediaCompressionPercent();
  const signal = beginActiveTransfer();
  try {
    if (pct < 100) {
      setTransferStatus({
        stage: "compress",
        percent: 0,
        label: "Compressing avatar…",
        originalSize: f.size,
        mediaType: "avatar",
      });
    }
    const result = await uploadChunked(f, "avatar", {
      compress: pct < 100,
      onProgress: (p) => {
        if (!signal.aborted) setTransferStatus({ mediaType: "avatar", ...p });
      },
      signal,
    });
    throwIfTransferAborted(signal);
    if (result.compression) {
      setTransferStatus({
        stage: "compress",
        percent: 100,
        label: "Done",
        summary:
          typeof compressionSummary === "function"
            ? compressionSummary(result.compression.originalSize, result.compression.compressedSize)
            : null,
      });
      await new Promise((r) => setTimeout(r, 600));
    }
    await loadMe();
    await refreshAvatarsAfterOwnChange();
    setTransferStatus(null);
    closeModal("profile-modal");
  } catch (ex) {
    setTransferStatus(null);
    if (!isTransferCancelled(ex)) uploadStatus.textContent = ex.message;
    throw ex;
  }
}

document.getElementById("avatar-input").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  openAvatarCropModal(f);
});

document.getElementById("avatar-crop-apply")?.addEventListener("click", () => {
  exportAvatarCropBlob(async (file) => {
    closeAvatarCropModal();
    try {
      await uploadAvatarFile(file);
    } catch {
      /* uploadAvatarFile surfaces errors */
    }
  });
});

document.getElementById("avatar-crop-zoom")?.addEventListener("input", (e) => {
  if (!avatarCropState) return;
  avatarCropState.zoom = parseFloat(e.target.value) || 1;
  drawAvatarCropPreview();
});

const avatarCropCanvas = document.getElementById("avatar-crop-canvas");
if (avatarCropCanvas) {
  let cropDrag = null;
  avatarCropCanvas.addEventListener("pointerdown", (e) => {
    if (!avatarCropState) return;
    cropDrag = { x: e.clientX, y: e.clientY, panX: avatarCropState.panX, panY: avatarCropState.panY };
    avatarCropCanvas.setPointerCapture(e.pointerId);
  });
  avatarCropCanvas.addEventListener("pointermove", (e) => {
    if (!cropDrag || !avatarCropState) return;
    avatarCropState.panX = cropDrag.panX + (e.clientX - cropDrag.x);
    avatarCropState.panY = cropDrag.panY + (e.clientY - cropDrag.y);
    drawAvatarCropPreview();
  });
  avatarCropCanvas.addEventListener("pointerup", () => {
    cropDrag = null;
  });
  avatarCropCanvas.addEventListener("pointercancel", () => {
    cropDrag = null;
  });
}

const myAvatarEl = document.getElementById("my-avatar");
if (myAvatarEl) {
  bindAvatarOpen(myAvatarEl, () => {
    if (!me) return;
    openProfileSheet({
      kind: "user",
      userId: me.id,
      name: me.display_name || me.name,
      avatar: me.avatar,
      online: true,
    });
  });
}

document.getElementById("profile-sheet")?.addEventListener("click", (e) => {
  if (
    e.target.classList.contains("profile-sheet-backdrop") ||
    e.target.closest(".profile-sheet-close")
  ) {
    closeProfileSheet();
  }
});

document.querySelectorAll('[data-modal="avatar-crop-modal"]').forEach((btn) => {
  btn.addEventListener("click", () => closeAvatarCropModal());
});

document.getElementById("logout-btn").onclick = async () => {
  if (!confirm("Log out of HomieLog?")) return;
  if (typeof VoiceCall !== "undefined") VoiceCall.forceEnd();
  if (typeof GroupMeshCall !== "undefined") GroupMeshCall.forceEnd();
  if (typeof GroupCall !== "undefined") GroupCall.forceEnd();
  await api("/api/auth/logout", { method: "POST" });
  window.location.href = "/";
};

document.getElementById("search-input").addEventListener("input", (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  loadOnline();
  loadUsers();
  loadChats();
  if (typeof HomiesEvents !== "undefined") HomiesEvents.loadEvents();
});

document.addEventListener("click", (e) => {
  if (
    e.target.closest(
      "#chat-menu-btn, #chat-toolbar-menu, .message-menu-btn, .message-menu-dropdown, .message-menu-item"
    )
  ) {
    return;
  }
  closeAllMessageMenus();
});

messagesEl?.addEventListener("scroll", closeAllMessageMenus, { passive: true });
window.addEventListener("resize", closeAllMessageMenus);

async function init() {
  initMediaProtection();
  if (typeof HomiesIcons !== "undefined") HomiesIcons.initIcons();
  if (typeof HomiesBeam !== "undefined") HomiesBeam.init();
  try {
    await loadMe();
  } catch (_) {
    window.location.href = "/";
    return;
  }
  showEmptyChat();
  setComposerEnabled(false);
  await loadCallsConfig();
  initGroupMeshCall();
  initGroupCall();
  initVoiceCall();
  if (typeof GroupCall !== "undefined") await GroupCall.refreshConfig();
  connectWs();
  if (typeof HomiesEvents !== "undefined") await HomiesEvents.refreshGroupsCache();
  await Promise.all([
    loadOnline(),
    loadUsers(),
    loadChats(),
    typeof HomiesEvents !== "undefined" ? HomiesEvents.loadEvents() : Promise.resolve(),
  ]);
  updateCallButton();
  if (typeof HomiesEvents !== "undefined") HomiesEvents.updateChatToolbarMenu();
  syncLayoutState();
}

init();
