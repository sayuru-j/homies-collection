/**
 * Small group voice/video calls — mesh WebRTC (same stack as 1:1 VoiceCall).
 * Works without LiveKit for groups up to mesh_group_max members.
 */
(function () {
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: [
        "turn:4.193.96.33:3478?transport=udp",
        "turn:4.193.96.33:3478?transport=tcp",
      ],
      username: "homies",
      credential: "fGrPL8PE0XGq7SqJOIILzYrM8r6BmGPR",
    },
  ];

  let sendSignal = null;
  let getMe = () => null;
  let onUiUpdate = () => {};
  let onCallLogged = null;

  let state = "idle";
  let callMode = "voice";
  let callId = null;
  let chatId = null;
  let chatTitle = "";
  let hostId = null;
  let muted = false;
  let localStream = null;
  let pendingIncoming = null;

  /** @type {Map<string, { pc: RTCPeerConnection, iceQueue: RTCIceCandidate[], preOffer: object|null, audio: HTMLAudioElement|null, name: string }>} */
  const peers = new Map();

  const RINGTONE_URL = "/public/your-phone-lingoging.mp3";
  let ringAudio = null;
  let durationTimer = null;
  let callActiveStartedAt = null;

  function newCallId() {
    if (typeof newUploadId === "function") return newUploadId();
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `mesh-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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

  function participantCount() {
    const me = getMe();
    let n = peers.size;
    if (me && !peers.has(me.id) && state !== "idle") n += 1;
    return Math.max(n, state === "idle" ? 0 : 1);
  }

  function uiPayload(extra = {}) {
    return {
      callKind: "group-mesh",
      state,
      callMode,
      callId,
      chatId,
      chatTitle,
      muted,
      participantCount: participantCount(),
      ...getDurationPayload(),
      ...extra,
    };
  }

  function setState(next, detail = {}) {
    const prev = state;
    state = next;
    if (next === "incoming") startRinging();
    else stopRinging();
    if (next !== "active" && prev === "active") stopDurationTimer();
    onUiUpdate(uiPayload(detail));
  }

  function enterActive() {
    stopRinging();
    if (!callActiveStartedAt) {
      callActiveStartedAt = Date.now();
      startDurationTimer();
    }
    if (state !== "active") {
      state = "active";
      onUiUpdate(uiPayload());
    } else {
      onUiUpdate(uiPayload());
    }
  }

  function startRinging() {
    stopRinging();
    try {
      ringAudio = new Audio(RINGTONE_URL);
      ringAudio.loop = true;
      ringAudio.play().catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  function stopRinging() {
    if (!ringAudio) return;
    ringAudio.pause();
    ringAudio.currentTime = 0;
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

  function signal(msg) {
    if (!sendSignal || !chatId) return;
    sendSignal({ ...msg, chat_id: chatId, call_id: callId, call_mode: callMode });
  }

  function signalTo(peerId, msg) {
    if (!peerId) return;
    signal({ ...msg, to_user_id: peerId });
  }

  async function getMediaStream(withVideo) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone not available in this browser");
    }
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: withVideo ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false,
    });
  }

  function tileForPeer(peerId, name) {
    let tile = document.querySelector(`[data-participant-id="${peerId}"]`);
    if (tile) return tile;
    const grid = document.getElementById("call-participants-grid");
    if (!grid) return null;
    tile = document.createElement("div");
    tile.className = "call-participant-tile";
    tile.dataset.participantId = peerId;
    const media = document.createElement("div");
    media.className = "call-participant-media";
    const initial = (name || "?")[0].toUpperCase();
    media.innerHTML = `<div class="call-participant-avatar">${initial}</div>`;
    const label = document.createElement("span");
    label.className = "call-participant-name";
    label.textContent = name || peerId;
    tile.appendChild(media);
    tile.appendChild(label);
    grid.appendChild(tile);
    return tile;
  }

  function bindTrackToTile(peerId, name, ev) {
    const tile = tileForPeer(peerId, name);
    if (!tile) return;
    const media = tile.querySelector(".call-participant-media");
    if (!media) return;
    const stream = ev.streams?.[0] || new MediaStream([ev.track]);
    if (ev.track.kind === "video") {
      media.innerHTML = "";
      const el = document.createElement("video");
      el.className = "call-participant-track";
      el.srcObject = stream;
      el.autoplay = true;
      el.playsInline = true;
      el.setAttribute("playsinline", "");
      media.appendChild(el);
      el.play().catch(() => {});
    }
    if (ev.track.kind === "audio") {
      const entry = peers.get(peerId);
      if (entry) {
        if (!entry.audio) {
          entry.audio = document.createElement("audio");
          entry.audio.autoplay = true;
          entry.audio.playsInline = true;
          document.body.appendChild(entry.audio);
        }
        entry.audio.srcObject = stream;
        entry.audio.play().catch(() => {});
      }
    }
  }

  function bindLocalPreview() {
    const el = document.getElementById("call-local-video");
    const me = getMe();
    if (el && localStream && me) {
      tileForPeer(me.id, me.display_name || me.name);
      const tile = document.querySelector(`[data-participant-id="${me.id}"]`);
      const media = tile?.querySelector(".call-participant-media");
      if (media && callMode === "video") {
        media.innerHTML = "";
        const v = document.createElement("video");
        v.className = "call-participant-track";
        v.srcObject = localStream;
        v.muted = true;
        v.autoplay = true;
        v.playsInline = true;
        media.appendChild(v);
      }
      if (el) {
        el.srcObject = localStream;
        el.muted = true;
        el.play().catch(() => {});
      }
    }
  }

  function offerOptions() {
    return {
      offerToReceiveAudio: true,
      offerToReceiveVideo: callMode === "video",
    };
  }

  async function flushIce(entry) {
    if (!entry.pc.remoteDescription) return;
    while (entry.iceQueue.length) {
      const c = entry.iceQueue.shift();
      try {
        await entry.pc.addIceCandidate(c);
      } catch (_) {
        /* ignore */
      }
    }
  }

  function closePeerEntry(peerId) {
    const entry = peers.get(peerId);
    if (!entry) return;
    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.close();
    if (entry.audio) {
      entry.audio.srcObject = null;
      entry.audio.remove();
    }
    peers.delete(peerId);
    document.querySelector(`[data-participant-id="${peerId}"]`)?.remove();
  }

  function closeAllPeers() {
    [...peers.keys()].forEach((id) => closePeerEntry(id));
  }

  function createPeerConnection(peerId, peerName) {
    if (peers.has(peerId)) return peers.get(peerId);

    const entry = {
      pc: new RTCPeerConnection({ iceServers: ICE_SERVERS }),
      iceQueue: [],
      preOffer: null,
      audio: null,
      name: peerName || peerId,
    };
    peers.set(peerId, entry);

    entry.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        signalTo(peerId, {
          type: "call_ice",
          candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
        });
      }
    };
    entry.pc.ontrack = (ev) => {
      bindTrackToTile(peerId, entry.name, ev);
      if ([...peers.values()].some((e) => e.pc.connectionState === "connected")) {
        enterActive();
      }
    };
    entry.pc.onconnectionstatechange = () => {
      if (entry.pc.connectionState === "connected") {
        stopRinging();
        enterActive();
      }
    };

    if (localStream) {
      localStream.getTracks().forEach((t) => entry.pc.addTrack(t, localStream));
    }

    tileForPeer(peerId, entry.name);
    return entry;
  }

  async function sendOfferTo(peerId, peerName) {
    const entry = createPeerConnection(peerId, peerName);
    if (entry.pc.localDescription) return;
    const offer = await entry.pc.createOffer(offerOptions());
    await entry.pc.setLocalDescription(offer);
    signalTo(peerId, {
      type: "call_offer",
      sdp: { type: offer.type, sdp: offer.sdp },
    });
  }

  async function handleOffer(fromId, fromName, sdp) {
    let entry = peers.get(fromId);
    if (!entry) entry = createPeerConnection(fromId, fromName);
    if (entry.pc.signalingState === "stable" && entry.pc.localDescription) {
      return;
    }
    if (entry.pc.signalingState === "have-local-offer") {
      return;
    }
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await flushIce(entry);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    signalTo(fromId, {
      type: "call_answer",
      sdp: { type: answer.type, sdp: answer.sdp },
    });
    enterActive();
  }

  async function handleAnswer(fromId, sdp) {
    const entry = peers.get(fromId);
    if (!entry) return;
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await flushIce(entry);
    enterActive();
  }

  async function handleIce(fromId, candidate) {
    if (!candidate) return;
    const entry = peers.get(fromId);
    const c = new RTCIceCandidate(candidate);
    if (!entry) return;
    if (!entry.pc.remoteDescription) {
      entry.iceQueue.push(c);
      return;
    }
    try {
      await entry.pc.addIceCandidate(c);
    } catch (_) {
      entry.iceQueue.push(c);
    }
  }

  async function persistCallLog(targetChatId, mode, durationSec, logCallId) {
    if (!targetChatId || durationSec < 1 || typeof api !== "function") return;
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

  async function teardown(notifyEnd, reason) {
    const savedChatId = chatId;
    const savedMode = callMode;
    const savedCallId = callId;
    const startedAt = callActiveStartedAt;
    const durationSec = startedAt
      ? Math.max(1, Math.floor((Date.now() - startedAt) / 1000))
      : 0;

    stopRinging();
    stopDurationTimer();

    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    closeAllPeers();
    document.getElementById("call-participants-grid")?.replaceChildren();
    const localVid = document.getElementById("call-local-video");
    if (localVid) localVid.srcObject = null;

    const me = getMe();
    const isHost = me?.id && hostId === me.id;

    if (notifyEnd && chatId && callId) {
      signal({ type: "call_mesh_end", reason: reason || "ended" });
    }

    if (
      notifyEnd &&
      isHost &&
      durationSec >= 1 &&
      savedChatId &&
      savedCallId &&
      startedAt &&
      reason !== "declined"
    ) {
      await persistCallLog(savedChatId, savedMode, durationSec, savedCallId);
    }

    callId = null;
    chatId = null;
    chatTitle = "";
    hostId = null;
    pendingIncoming = null;
    muted = false;
    callActiveStartedAt = null;
    state = "idle";
    onUiUpdate(uiPayload({ reason }));
  }

  async function startGroupCall(targetChatId, title, mode) {
    if (state !== "idle") throw new Error("Already in a call");
    if (typeof VoiceCall !== "undefined" && VoiceCall.isInCall()) {
      throw new Error("End the current call first");
    }
    if (typeof GroupCall !== "undefined" && GroupCall.isInCall()) {
      throw new Error("End the current call first");
    }

    const me = getMe();
    if (!me?.id) throw new Error("Not signed in");

    callMode = mode === "video" ? "video" : "voice";
    chatId = targetChatId;
    chatTitle = title || "Group";
    callId = newCallId();
    hostId = me.id;
    setState("outgoing");

    try {
      localStream = await getMediaStream(callMode === "video");
      bindLocalPreview();
      signal({ type: "call_mesh_invite" });
      tileForPeer(me.id, me.display_name || me.name);
      onUiUpdate(uiPayload());
    } catch (err) {
      await teardown(false);
      throw err;
    }
  }

  async function acceptIncoming() {
    if (!pendingIncoming) throw new Error("No incoming group call");
    const me = getMe();
    if (!me?.id) throw new Error("Not signed in");

    const inv = pendingIncoming;
    pendingIncoming = null;
    callId = inv.call_id || newCallId();
    chatId = inv.chat_id;
    chatTitle = inv.chatTitle || inv.from_name || "Group";
    hostId = inv.from_user_id;
    callMode = inv.call_mode === "video" ? "video" : "voice";
    setState("connecting");

    try {
      localStream = await getMediaStream(callMode === "video");
      bindLocalPreview();

      const hostName = inv.from_name || "Host";
      createPeerConnection(hostId, hostName);
      await sendOfferTo(hostId, hostName);

      signal({ type: "call_mesh_join" });
    } catch (err) {
      await teardown(false);
      throw err;
    }
  }

  function rejectIncoming() {
    pendingIncoming = null;
    setState("idle");
  }

  async function onPeerJoined(peerId, peerName) {
    const me = getMe();
    if (!me || peerId === me.id || state === "idle") return;

    const existing = peers.get(peerId);
    if (existing?.pc?.remoteDescription || existing?.pc?.localDescription) {
      return;
    }

    if (hostId === me.id) {
      createPeerConnection(peerId, peerName);
      return;
    }

    await sendOfferTo(peerId, peerName);
  }

  function handleWsMessage(data) {
    if (!data?.type) return false;

    if (data.type === "call_mesh_incoming") {
      if (state !== "idle") {
        sendSignal?.({
          type: "call_busy",
          to_user_id: data.from_user_id,
          call_id: data.call_id,
          chat_id: data.chat_id,
        });
        return true;
      }
      pendingIncoming = data;
      setState("incoming", { from_name: data.from_name });
      return true;
    }

    if (data.type === "call_mesh_ended") {
      if (chatId && data.chat_id === chatId && state !== "idle") {
        void teardown(false, "remote_end");
      } else if (pendingIncoming?.chat_id === data.chat_id) {
        pendingIncoming = null;
        setState("idle");
      }
      return true;
    }

    if (data.type === "call_mesh_peer_joined") {
      if (data.call_id && callId && data.call_id !== callId) return false;
      if (!chatId || data.chat_id !== chatId) return false;
      void onPeerJoined(data.peer_id, data.peer_name);
      return true;
    }

    if (!callId || (data.call_id && data.call_id !== callId)) return false;
    if (!data.from_user_id) return false;

    const from = data.from_user_id;
    const me = getMe();
    if (from === me?.id) return false;

    switch (data.type) {
      case "call_offer":
        if (data.sdp) {
          handleOffer(from, data.from_name, data.sdp).catch(() => {});
        }
        return true;
      case "call_answer":
        if (data.sdp) handleAnswer(from, data.sdp).catch(() => {});
        return true;
      case "call_ice":
        handleIce(from, data.candidate).catch(() => {});
        return true;
      default:
        return false;
    }
  }

  window.GroupMeshCall = {
    init(deps) {
      sendSignal = deps.sendSignal;
      getMe = deps.getMe || (() => null);
      onUiUpdate = deps.onUiUpdate || (() => {});
      onCallLogged = deps.onCallLogged || null;
    },
    isIdle: () => state === "idle",
    isInCall: () => state !== "idle",
    getChatId: () => chatId,
    getPendingIncoming: () => pendingIncoming,
    startGroupCall,
    acceptIncoming,
    rejectIncoming,
    endCall: () => teardown(true),
    forceEnd: () => teardown(false),
    toggleMute: () => {
      muted = !muted;
      if (localStream) {
        localStream.getAudioTracks().forEach((t) => {
          t.enabled = !muted;
        });
      }
      onUiUpdate(uiPayload());
    },
    handleWsMessage,
  };
})();
