/**
 * 1:1 voice & video calls over WebRTC with WebSocket signaling.
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
  let onRecordingComplete = null;

  let state = "idle";
  let callMode = "voice";
  let callId = null;
  let peerId = null;
  let peerName = "";
  let chatId = null;
  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let remoteAudio = null;
  let isRecording = false;
  let peerRecording = false;
  let peerRecordingName = "";
  let pendingOffer = null;
  let muted = false;
  let iceQueue = [];
  let preConnectIce = [];

  const RINGTONE_URL = "/public/your-phone-lingoging.mp3";
  let ringAudio = null;
  let durationTimer = null;
  let callActiveStartedAt = null;

  function newCallId() {
    if (typeof newUploadId === "function") return newUploadId();
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `call-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
    return {
      state,
      callMode,
      callId,
      peerId,
      peerName,
      chatId,
      muted,
      recording: isRecording,
      peerRecording,
      peerRecordingName,
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
    if (state === "idle" || state === "incoming") return;
    stopRinging();
    if (!callActiveStartedAt) {
      callActiveStartedAt = Date.now();
      startDurationTimer();
    }
    if (state !== "active") {
      setState("active");
    } else {
      onUiUpdate(uiPayload());
    }
  }

  function maybeEnterActive() {
    if (!pc || state === "idle" || state === "incoming") return;
    if (!pc.remoteDescription) return;
    enterActive();
  }

  function signal(msg) {
    if (!sendSignal || !peerId) return;
    sendSignal({
      ...msg,
      to_user_id: peerId,
      call_id: callId,
      chat_id: chatId,
      call_mode: callMode,
    });
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

  async function getMediaStream(withVideo) {
    const nav = navigator;
    if (nav.mediaDevices?.getUserMedia) {
      return nav.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: withVideo
          ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }
          : false,
      });
    }
    const legacy = nav.getUserMedia || nav.webkitGetUserMedia || nav.mozGetUserMedia;
    if (legacy) {
      return new Promise((resolve, reject) => {
        legacy.call(nav, { audio: true, video: !!withVideo }, resolve, reject);
      });
    }
    throw new Error("Camera/microphone unavailable. Use HTTPS in this browser.");
  }

  function stopLocalStream() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    const localVid = document.getElementById("call-local-video");
    if (localVid) localVid.srcObject = null;
  }

  function clearRemoteMedia() {
    remoteStream = null;
    if (remoteAudio) {
      remoteAudio.srcObject = null;
      remoteAudio.pause();
    }
    const remoteVid = document.getElementById("call-remote-video");
    if (remoteVid) remoteVid.srcObject = null;
  }

  function closePeerConnection() {
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
      pc = null;
    }
    iceQueue = [];
    preConnectIce = [];
    pendingOffer = null;
  }

  async function persistCallLog(chatIdParam, modeParam, durationSec, logCallId) {
    if (!chatIdParam || durationSec < 1 || typeof api !== "function") return null;
    const id = logCallId || callId;
    if (!id) return null;
    try {
      const res = await api("/api/chats/call-log", {
        method: "POST",
        body: JSON.stringify({
          chat_id: chatIdParam,
          duration_sec: durationSec,
          call_mode: modeParam,
          call_id: id,
        }),
      });
      if (res?.message && onCallLogged) onCallLogged(res.message, chatIdParam);
      return res;
    } catch (err) {
      console.warn("Call log failed:", err.message || err);
      return null;
    }
  }

  async function teardown(notifyPeer, reason) {
    const prevState = state;
    const wasActive = prevState !== "idle";
    const pid = peerId;
    const cid = callId;
    const savedPeerName = peerName;
    const savedChatId = chatId;
    const savedMode = callMode;
    const savedCallId = callId;
    const startedAt = callActiveStartedAt;
    const durationSec = startedAt
      ? Math.max(1, Math.floor((Date.now() - startedAt) / 1000))
      : 0;
    const isCancel =
      prevState === "outgoing" && durationSec < 1 && !startedAt;
    const shouldLog =
      notifyPeer &&
      savedChatId &&
      savedCallId &&
      durationSec >= 1 &&
      !isCancel &&
      startedAt &&
      reason !== "declined" &&
      reason !== "busy" &&
      reason !== "call_cancel";

    stopRinging();
    stopDurationTimer();
    await finalizeRecording();
    stopLocalStream();
    closePeerConnection();
    clearRemoteMedia();

    if (shouldLog) {
      await persistCallLog(savedChatId, savedMode, durationSec, savedCallId);
    }

    if (notifyPeer && pid && cid && wasActive) {
      const payload = {
        type: isCancel ? "call_cancel" : "call_end",
        to_user_id: pid,
        call_id: cid,
        chat_id: savedChatId,
        reason,
        call_mode: savedMode,
      };
      if (!isCancel && durationSec >= 1) {
        payload.duration_sec = durationSec;
      }
      sendSignal?.(payload);
    }

    callId = null;
    peerId = null;
    peerName = "";
    chatId = null;
    callMode = "voice";
    muted = false;
    preConnectIce = [];
    isRecording = false;
    peerRecording = false;
    peerRecordingName = "";
    callActiveStartedAt = null;
    setState("idle", { reason, peerName: savedPeerName });
  }

  async function finalizeRecording() {
    if (!isRecording || typeof CallRecording === "undefined") return;
    signal({ type: "call_recording_stop" });
    isRecording = false;
    onUiUpdate(uiPayload());
    const result = await CallRecording.stop();
    if (!result?.blob || !chatId) return;
    const savedChat = chatId;
    if (onRecordingComplete) {
      await onRecordingComplete(result.blob, savedChat, result.compressionPercent);
    }
  }

  async function toggleRecording() {
    if (callMode !== "video" || state !== "active") {
      throw new Error("Recording is only available during an active video call");
    }
    if (typeof CallRecording === "undefined") {
      throw new Error("Recording is not available");
    }
    if (peerRecording) {
      throw new Error(
        `${peerRecordingName || peerName || "The other person"} is already recording`
      );
    }
    if (isRecording) {
      await finalizeRecording();
      return false;
    }
    const pct =
      typeof getMediaCompressionPercent === "function"
        ? getMediaCompressionPercent()
        : 5;
    const me = getMe();
    const myName = me?.display_name || me?.name || "You";
    await CallRecording.start({
      localStream,
      remoteStream,
      localVideoEl: document.getElementById("call-local-video"),
      remoteVideoEl: document.getElementById("call-remote-video"),
      compressionPercent: pct,
      leftLabel: peerName || "Peer",
      rightLabel: myName,
    });
    isRecording = true;
    signal({ type: "call_recording_start" });
    onUiUpdate(uiPayload());
    return true;
  }

  function ensureRemoteAudio() {
    if (!remoteAudio) {
      remoteAudio = document.createElement("audio");
      remoteAudio.autoplay = true;
      remoteAudio.playsInline = true;
      remoteAudio.setAttribute("playsinline", "");
      document.body.appendChild(remoteAudio);
    }
    return remoteAudio;
  }

  function bindLocalPreview() {
    const el = document.getElementById("call-local-video");
    if (el && localStream) {
      el.srcObject = localStream;
      el.muted = true;
      el.play().catch(() => {});
    }
  }

  function bindRemoteTrack(ev) {
    const stream = ev.streams?.[0] || new MediaStream([ev.track]);
    if (!remoteStream) remoteStream = stream;
    else {
      stream.getTracks().forEach((t) => {
        const existing = remoteStream.getTracks().find((x) => x.kind === t.kind);
        if (existing) remoteStream.removeTrack(existing);
        remoteStream.addTrack(t);
      });
    }
    const remoteVid = document.getElementById("call-remote-video");
    if (remoteVid && remoteStream.getVideoTracks().length) {
      remoteVid.srcObject = remoteStream;
      remoteVid.play().catch(() => {});
    }
    if (remoteStream.getAudioTracks().length) {
      const audio = ensureRemoteAudio();
      audio.srcObject = remoteStream;
      audio.play().catch(() => {});
    }
  }

  async function flushIceQueue() {
    if (!pc || !pc.remoteDescription) return;
    while (iceQueue.length) {
      const c = iceQueue.shift();
      try {
        await pc.addIceCandidate(c);
      } catch (_) {
        /* ignore stale */
      }
    }
  }

  function createPeerConnection() {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        signal({
          type: "call_ice",
          candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
        });
      }
    };
    pc.ontrack = (ev) => {
      bindRemoteTrack(ev);
      maybeEnterActive();
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === "connected") {
        maybeEnterActive();
      }
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        teardown(false, "connection_lost");
      }
    };
    return pc;
  }

  async function attachLocalMedia() {
    const withVideo = callMode === "video";
    localStream = await getMediaStream(withVideo);
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    if (withVideo) bindLocalPreview();
  }

  function offerOptions() {
    return {
      offerToReceiveAudio: true,
      offerToReceiveVideo: callMode === "video",
    };
  }

  async function startOutgoing(targetPeerId, targetChatId, name, mode = "voice") {
    if (state !== "idle") throw new Error("Already in a call");
    const me = getMe();
    if (!me?.id || !targetPeerId) throw new Error("Cannot start call");

    callMode = mode === "video" ? "video" : "voice";
    peerId = targetPeerId;
    peerName = name || "Friend";
    chatId = targetChatId;
    callId = newCallId();
    setState("outgoing");

    try {
      createPeerConnection();
      await attachLocalMedia();
      const offer = await pc.createOffer(offerOptions());
      await pc.setLocalDescription(offer);
      signal({
        type: "call_invite",
        call_mode: callMode,
        sdp: { type: offer.type, sdp: offer.sdp },
      });
    } catch (err) {
      await teardown(false);
      throw err;
    }
  }

  async function acceptIncoming() {
    if (state !== "incoming" || !pendingOffer) return;
    setState("connecting");
    try {
      createPeerConnection();
      await attachLocalMedia();
      await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));
      pendingOffer = null;
      preConnectIce.forEach((c) => iceQueue.push(c));
      preConnectIce = [];
      await flushIceQueue();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signal({
        type: "call_answer",
        call_mode: callMode,
        sdp: { type: answer.type, sdp: answer.sdp },
      });
      maybeEnterActive();
    } catch (err) {
      signal({ type: "call_reject", reason: "setup_failed" });
      await teardown(false);
      throw err;
    }
  }

  function rejectIncoming(reason = "declined") {
    if (state !== "incoming") return;
    signal({ type: "call_reject", reason });
    void teardown(false, reason);
  }

  function endCall() {
    void teardown(true);
  }

  function toggleMute() {
    muted = !muted;
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => {
        t.enabled = !muted;
      });
    }
    onUiUpdate(uiPayload());
  }

  async function onRemoteAnswer(sdp) {
    if (!pc || (state !== "outgoing" && state !== "connecting")) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await flushIceQueue();
    maybeEnterActive();
  }

  async function onRemoteOffer(sdp) {
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await flushIceQueue();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signal({ type: "call_answer", sdp: { type: answer.type, sdp: answer.sdp } });
    maybeEnterActive();
  }

  async function onRemoteIce(candidate) {
    if (!candidate) return;
    const c = new RTCIceCandidate(candidate);
    if (!pc) {
      preConnectIce.push(c);
      return;
    }
    if (!pc.remoteDescription) {
      iceQueue.push(c);
      return;
    }
    try {
      await pc.addIceCandidate(c);
    } catch (_) {
      iceQueue.push(c);
    }
  }

  function handleIncoming(data) {
    if (state !== "idle") {
      sendSignal?.({
        type: "call_busy",
        to_user_id: data.from_user_id,
        call_id: data.call_id,
        chat_id: data.chat_id,
      });
      return true;
    }
    callId = data.call_id;
    peerId = data.from_user_id;
    peerName = data.from_name || "Someone";
    chatId = data.chat_id || null;
    callMode = data.call_mode === "video" ? "video" : "voice";
    if (data.sdp) pendingOffer = data.sdp;
    setState("incoming");
    return true;
  }

  function handleWsMessage(data) {
    const from = data.from_user_id;
    if (!from && data.type !== "call_incoming") return false;

    if (data.type === "call_incoming") {
      return handleIncoming(data);
    }

    if (data.call_id && callId && data.call_id !== callId) return false;
    if (from && peerId && from !== peerId) return false;

    switch (data.type) {
      case "call_answer":
        if (data.sdp) onRemoteAnswer(data.sdp).catch(() => teardown(false));
        return true;
      case "call_offer":
        if (data.sdp) onRemoteOffer(data.sdp).catch(() => teardown(false));
        return true;
      case "call_ice":
        onRemoteIce(data.candidate).catch(() => {});
        return true;
      case "call_reject":
      case "call_cancel":
        void teardown(false, data.reason || data.type);
        return true;
      case "call_end": {
        const logChat = data.chat_id || chatId;
        const sec = Number(data.duration_sec) || 0;
        if (logChat && sec >= 1 && data.call_id) {
          void persistCallLog(logChat, callMode, sec, data.call_id);
        }
        void teardown(false, data.reason || data.type);
        return true;
      }
      case "call_busy":
        void teardown(false, data.reason || "busy");
        return true;
      case "call_recording_start":
        peerRecording = true;
        peerRecordingName = data.from_name || "";
        onUiUpdate(uiPayload());
        return true;
      case "call_recording_stop":
        peerRecording = false;
        peerRecordingName = "";
        onUiUpdate(uiPayload());
        return true;
      default:
        return false;
    }
  }

  window.VoiceCall = {
    init(deps) {
      sendSignal = deps.sendSignal;
      getMe = deps.getMe || getMe;
      onUiUpdate = deps.onUiUpdate || onUiUpdate;
      onCallLogged = deps.onCallLogged || null;
      onRecordingComplete = deps.onRecordingComplete || null;
    },
    getState: () => state,
    isRecording: () => isRecording,
    getCallMode: () => callMode,
    getPeerId: () => peerId,
    isIdle: () => state === "idle",
    isInCall: () => state !== "idle",
    startOutgoing,
    acceptIncoming,
    rejectIncoming,
    endCall,
    toggleMute,
    toggleRecording,
    handleWsMessage,
    forceEnd: () => {
      void teardown(false);
    },
  };
})();
