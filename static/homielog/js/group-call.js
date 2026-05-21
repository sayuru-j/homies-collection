/**
 * Group voice/video calls via LiveKit SFU (larger meetings).
 */
(function () {
  const RINGTONE_URL = "/public/your-phone-lingoging.mp3";

  let sendSignal = null;
  let getMe = () => null;
  let onUiUpdate = () => {};
  let onCallLogged = null;

  let config = { enabled: false, url: null };
  let state = "idle";
  let callMode = "voice";
  let callId = null;
  let chatId = null;
  let chatTitle = "";
  let hostId = null;
  let room = null;
  let muted = false;
  let pendingIncoming = null;

  let ringAudio = null;
  let durationTimer = null;
  let callActiveStartedAt = null;
  const participantNames = new Map();

  function newCallId() {
    if (typeof newUploadId === "function") return newUploadId();
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `gcall-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function formatCallDuration(totalSec) {
    const s = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
    }
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function getDurationPayload() {
    if (!callActiveStartedAt) return { durationSec: 0, durationLabel: "0:00" };
    const sec = Math.floor((Date.now() - callActiveStartedAt) / 1000);
    return { durationSec: sec, durationLabel: formatCallDuration(sec) };
  }

  function uiPayload(extra = {}) {
    const count = room ? room.remoteParticipants.size + 1 : participantNames.size || 1;
    return {
      callKind: "group",
      state,
      callMode,
      callId,
      chatId,
      chatTitle,
      muted,
      participantCount: count,
      ...getDurationPayload(),
      ...extra,
    };
  }

  function setState(next, detail = {}) {
    const prev = state;
    state = next;
    if (next === "incoming") {
      startRinging();
    } else {
      stopRinging();
    }
    if (next !== "active" && prev === "active") {
      stopDurationTimer();
    }
    onUiUpdate(uiPayload(detail));
  }

  function enterActive() {
    stopRinging();
    if (!callActiveStartedAt) {
      callActiveStartedAt = Date.now();
      startDurationTimer();
    }
    if (state !== "active") state = "active";
    onUiUpdate(uiPayload());
  }

  function startRinging() {
    stopRinging();
    try {
      ringAudio = new Audio(RINGTONE_URL);
      ringAudio.loop = true;
      ringAudio.preload = "auto";
      ringAudio.play().catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  function stopRinging() {
    if (!ringAudio) return;
    ringAudio.pause();
    ringAudio.currentTime = 0;
    ringAudio.removeAttribute("src");
    ringAudio.load();
    ringAudio = null;
  }

  function startDurationTimer() {
    stopDurationTimer();
    durationTimer = setInterval(() => {
      if (state === "active") onUiUpdate(uiPayload());
    }, 1000);
  }

  function stopDurationTimer() {
    if (durationTimer) {
      clearInterval(durationTimer);
      durationTimer = null;
    }
  }

  function clearCallTimer() {
    stopDurationTimer();
    callActiveStartedAt = null;
  }

  function signal(msg) {
    if (!sendSignal || !chatId) return;
    sendSignal({
      ...msg,
      chat_id: chatId,
      call_id: callId,
    });
  }

  async function loadConfig() {
    try {
      const data = await api("/api/calls/config");
      config = data.livekit || data;
      if (data.livekit) {
        config = { enabled: !!data.livekit.enabled, url: data.livekit.url || null };
      }
    } catch (_) {
      config = { enabled: false, url: null };
    }
    return config;
  }

  async function fetchJoinToken(targetChatId, mode) {
    return api("/api/calls/group/token", {
      method: "POST",
      body: JSON.stringify({ chat_id: targetChatId, call_mode: mode }),
    });
  }

  function lk() {
    return window.LivekitClient || window.LiveKitClient;
  }

  function clearParticipantGrid() {
    const grid = document.getElementById("call-participants-grid");
    if (grid) grid.innerHTML = "";
  }

  function tileForParticipant(identity, name) {
    let tile = document.querySelector(`[data-participant-id="${identity}"]`);
    if (tile) return tile;
    const grid = document.getElementById("call-participants-grid");
    if (!grid) return null;
    tile = document.createElement("div");
    tile.className = "call-participant-tile";
    tile.dataset.participantId = identity;
    const label = document.createElement("span");
    label.className = "call-participant-name";
    label.textContent = name || identity;
    const media = document.createElement("div");
    media.className = "call-participant-media";
    tile.appendChild(media);
    tile.appendChild(label);
    grid.appendChild(tile);
    return tile;
  }

  function attachTrackToTile(identity, name, track) {
    const tile = tileForParticipant(identity, name);
    if (!tile) return;
    const media = tile.querySelector(".call-participant-media");
    if (!media) return;
    const el = track.attach();
    el.classList.add("call-participant-track");
    if (track.kind === "video") {
      el.setAttribute("playsinline", "");
      el.autoplay = true;
    }
    media.innerHTML = "";
    media.appendChild(el);
  }

  function detachParticipantTiles(remoteOnly = false) {
    const grid = document.getElementById("call-participants-grid");
    if (!grid) return;
    const me = getMe();
    grid.querySelectorAll(".call-participant-tile").forEach((tile) => {
      if (remoteOnly && me && tile.dataset.participantId === me.id) return;
      tile.remove();
    });
  }

  function refreshParticipant(participant) {
    const id = participant.identity;
    const name = participant.name || participantNames.get(id) || id;
    participantNames.set(id, name);
    participant.trackPublications.forEach((pub) => {
      if (pub.track && pub.isSubscribed) {
        attachTrackToTile(id, name, pub.track);
      } else if (!pub.track) {
        tileForParticipant(id, name);
      }
    });
  }

  function wireRoomEvents(r) {
    const { RoomEvent, Track } = lk();

    r.on(RoomEvent.ParticipantConnected, (participant) => {
      refreshParticipant(participant);
      onUiUpdate(uiPayload());
    });

    r.on(RoomEvent.ParticipantDisconnected, (participant) => {
      const tile = document.querySelector(`[data-participant-id="${participant.identity}"]`);
      tile?.remove();
      participantNames.delete(participant.identity);
      onUiUpdate(uiPayload());
    });

    r.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Audio || track.kind === Track.Kind.Video) {
        attachTrackToTile(
          participant.identity,
          participant.name || participantNames.get(participant.identity),
          track
        );
      }
    });

    r.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
      track.detach().forEach((el) => el.remove());
      const tile = document.querySelector(`[data-participant-id="${participant.identity}"]`);
      const media = tile?.querySelector(".call-participant-media");
      if (media && !media.querySelector("video,audio")) {
        const me = getMe();
        const name = participant.name || participant.identity;
        if (participant.identity !== me?.id) {
          media.innerHTML = `<div class="call-participant-avatar">${(name[0] || "?").toUpperCase()}</div>`;
        }
      }
    });

    r.on(RoomEvent.Disconnected, () => {
      if (state !== "idle") cleanupLocal(false);
    });
  }

  async function connectToRoom(targetChatId, mode) {
    const LK = lk();
    if (!LK) throw new Error("LiveKit client failed to load");
    if (!config.enabled || !config.url) {
      throw new Error("Group calls are not configured on the server");
    }

    const tokenRes = await fetchJoinToken(targetChatId, mode);
    const { Room } = LK;

    if (room) {
      try {
        await room.disconnect();
      } catch (_) {
        /* ignore */
      }
      room = null;
    }

    clearParticipantGrid();
    participantNames.clear();

    room = new Room({ adaptiveStream: true, dynacast: true });
    wireRoomEvents(room);

    await room.connect(config.url, tokenRes.token);

    const me = getMe();
    if (me) {
      participantNames.set(me.id, me.display_name || me.name || me.id);
      tileForParticipant(me.id, participantNames.get(me.id));
    }

    await room.localParticipant.setMicrophoneEnabled(true);
    if (mode === "video") {
      await room.localParticipant.setCameraEnabled(true);
      const pub = room.localParticipant.getTrackPublication(LK.Track.Source.Camera);
      if (pub?.track) {
        attachTrackToTile(me?.id, participantNames.get(me?.id), pub.track);
      }
    }

    room.remoteParticipants.forEach((p) => refreshParticipant(p));
  }

  async function persistCallLog(targetChatId, mode, durationSec, logCallId) {
    if (!targetChatId || durationSec < 1) return;
    const id = logCallId || callId;
    if (!id) return;
    try {
      const res = await api("/api/chats/call-log", {
        method: "POST",
        body: JSON.stringify({
          chat_id: targetChatId,
          duration_sec: durationSec,
          call_mode: mode,
          call_id: id,
        }),
      });
      if (res?.message && onCallLogged) onCallLogged(res.message, targetChatId);
    } catch (err) {
      console.warn("Call log failed:", err.message || err);
    }
  }

  async function cleanupLocal(notifyEnd) {
    stopRinging();
    stopDurationTimer();

    const savedChatId = chatId;
    const savedMode = callMode;
    const savedHostId = hostId;
    const savedCallId = callId;
    const startedAt = callActiveStartedAt;
    const durationSec = startedAt
      ? Math.max(1, Math.floor((Date.now() - startedAt) / 1000))
      : 0;

    if (notifyEnd && chatId && callId) {
      signal({ type: "call_room_end", reason: "ended" });
    }

    if (room) {
      try {
        await room.disconnect();
      } catch (_) {
        /* ignore */
      }
      room = null;
    }

    clearParticipantGrid();
    participantNames.clear();
    pendingIncoming = null;
    callId = null;
    chatId = null;
    chatTitle = "";
    muted = false;
    state = "idle";
    onUiUpdate(uiPayload());

    const me = getMe();
    const isHost = me?.id && savedHostId === me.id;
    if (notifyEnd && isHost && savedChatId && savedCallId && startedAt && durationSec >= 1) {
      await persistCallLog(savedChatId, savedMode, durationSec, savedCallId);
    }
    hostId = null;
    clearCallTimer();
  }

  async function startGroupCall(targetChatId, title, mode) {
    if (!config.enabled) {
      throw new Error(
        "Group calls need a LiveKit server. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET on the server."
      );
    }
    if (typeof VoiceCall !== "undefined" && VoiceCall.isInCall()) {
      throw new Error("End the current call first");
    }
    if (!isIdle()) forceEnd();

    const me = getMe();
    callId = newCallId();
    chatId = targetChatId;
    chatTitle = title || "Group";
    hostId = me?.id || null;
    callMode = mode === "video" ? "video" : "voice";
    setState("outgoing");

    try {
      await connectToRoom(targetChatId, callMode);
      signal({ type: "call_room_invite", call_mode: callMode });
      enterActive();
    } catch (err) {
      await cleanupLocal(false);
      throw err;
    }
  }

  async function acceptIncoming() {
    if (!pendingIncoming) throw new Error("No incoming group call");
    if (typeof VoiceCall !== "undefined" && VoiceCall.isInCall()) {
      throw new Error("End the current call first");
    }

    const inv = pendingIncoming;
    pendingIncoming = null;
    callId = inv.call_id || newCallId();
    chatId = inv.chat_id;
    chatTitle = inv.chatTitle || inv.from_name || "Group";
    hostId = inv.from_user_id || null;
    callMode = inv.call_mode === "video" ? "video" : "voice";
    setState("connecting");

    try {
      await connectToRoom(chatId, callMode);
      enterActive();
    } catch (err) {
      await cleanupLocal(false);
      throw err;
    }
  }

  function rejectIncoming() {
    pendingIncoming = null;
    setState("idle");
  }

  function handleWsMessage(data) {
    if (!data?.type) return false;

    if (data.type === "call_room_incoming") {
      if (!isIdle()) return true;
      if (data.from_user_id === getMe()?.id) return true;
      pendingIncoming = data;
      chatTitle = data.from_name || "Group";
      setState("incoming", { from_name: data.from_name });
      return true;
    }

    if (data.type === "call_room_ended") {
      if (chatId && data.chat_id === chatId && state !== "idle") {
        cleanupLocal(false);
      } else if (pendingIncoming?.chat_id === data.chat_id) {
        pendingIncoming = null;
        setState("idle");
      }
      return true;
    }

    return false;
  }

  function isIdle() {
    return state === "idle";
  }

  function isInCall() {
    return state !== "idle";
  }

  function isEnabled() {
    return !!config.enabled;
  }

  function getChatId() {
    return chatId;
  }

  function toggleMute() {
    if (!room) return;
    muted = !muted;
    room.localParticipant.setMicrophoneEnabled(!muted);
    onUiUpdate(uiPayload());
  }

  function forceEnd() {
    cleanupLocal(false);
  }

  function endCall() {
    cleanupLocal(true);
  }

  window.GroupCall = {
    init(deps) {
      sendSignal = deps.sendSignal;
      getMe = deps.getMe || (() => null);
      onUiUpdate = deps.onUiUpdate || (() => {});
      onCallLogged = deps.onCallLogged || null;
      loadConfig();
    },
    refreshConfig: loadConfig,
    isEnabled,
    isIdle,
    isInCall,
    getChatId,
    getPendingIncoming: () => pendingIncoming,
    startGroupCall,
    acceptIncoming,
    rejectIncoming,
    endCall,
    forceEnd,
    toggleMute,
    handleWsMessage,
  };
})();
