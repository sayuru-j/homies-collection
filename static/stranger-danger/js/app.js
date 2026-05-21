/**
 * StrangerDanger — standalone stranger matching (sd_* WS only).
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

  let ws = null;
  let me = null;
  let loggedIn = false;
  let started = false;
  let state = "idle";
  let sessionId = null;
  let peerId = null;
  let peerName = "Stranger";
  let pc = null;
  let localStream = null;
  let hasLocalVideo = false;
  let hasLocalAudio = false;
  let muted = false;
  let iceQueue = [];
  let connectedOnce = false;

  const overlayStart = document.getElementById("sd-overlay-start");
  const overlaySearch = document.getElementById("sd-overlay-search");
  const overlayConnected = document.getElementById("sd-overlay-connected");
  const localPip = document.getElementById("sd-local-pip");
  const controlsEl = document.getElementById("sd-controls");
  const statusEl = document.getElementById("sd-status");
  const startErrorEl = document.getElementById("sd-start-error");
  const remoteVideo = document.getElementById("sd-remote-video");
  const localVideo = document.getElementById("sd-local-video");
  const peerLabel = document.getElementById("sd-peer-label");
  const onlinePill = document.getElementById("sd-online-pill");
  const muteBtn = document.getElementById("sd-mute-btn");
  const nextBtn = document.getElementById("sd-next-btn");
  const leaveBtn = document.getElementById("sd-leave-btn");
  const startBtn = document.getElementById("sd-start-btn");
  const signinBtn = document.getElementById("sd-signin-btn");
  const guestHint = document.getElementById("sd-guest-hint");
  const cancelSearchBtn = document.getElementById("sd-cancel-search-btn");

  function isMobile() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function showStartError(msg) {
    if (!startErrorEl) return;
    if (msg) {
      startErrorEl.textContent = msg;
      startErrorEl.classList.remove("hidden");
    } else {
      startErrorEl.classList.add("hidden");
    }
  }

  function setUiMode(mode) {
    document.body.classList.toggle("sd-live", mode === "live");
    overlayStart?.classList.toggle("hidden", mode !== "start");
    overlaySearch?.classList.toggle("hidden", mode !== "search");
    overlayConnected?.classList.toggle("hidden", mode !== "live");
    localPip?.classList.toggle("hidden", mode === "start" || !hasLocalVideo);
    controlsEl?.classList.toggle("hidden", mode !== "live");
    onlinePill?.toggleAttribute("hidden", mode === "start");
    updateMediaControls();
  }

  function updateMediaControls() {
    if (!muteBtn) return;
    if (!hasLocalAudio) {
      muteBtn.disabled = true;
      muteBtn.textContent = "NO MIC";
      muteBtn.setAttribute("aria-pressed", "true");
      return;
    }
    muteBtn.disabled = false;
    muteBtn.textContent = muted ? "MIC OFF" : "MIC ON";
    muteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
  }

  function syncLocalPip() {
    hasLocalVideo = !!localStream?.getVideoTracks().length;
    hasLocalAudio = !!localStream?.getAudioTracks().length;
    if (!hasLocalVideo) {
      if (localVideo) localVideo.srcObject = null;
      localPip?.classList.add("hidden");
      return;
    }
    if (localVideo && localStream) {
      localVideo.srcObject = localStream;
      playVideo(localVideo);
    }
    if (started && state !== "idle") {
      localPip?.classList.remove("hidden");
    }
  }

  function send(msg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function playVideo(el) {
    if (!el?.srcObject) return;
    el.setAttribute("playsinline", "");
    el.setAttribute("webkit-playsinline", "");
    const p = el.play();
    if (p?.catch) p.catch(() => {});
  }

  function cleanupPeer() {
    iceQueue = [];
    connectedOnce = false;
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
      pc = null;
    }
    if (remoteVideo) remoteVideo.srcObject = null;
    sessionId = null;
    peerId = null;
    state = "idle";
  }

  async function stopLocalMedia() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    hasLocalVideo = false;
    hasLocalAudio = false;
    if (localVideo) localVideo.srcObject = null;
    localPip?.classList.add("hidden");
    updateMediaControls();
  }

  function audioConstraints() {
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
  }

  function videoConstraints() {
    if (isMobile()) {
      return {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
      };
    }
    return {
      width: { ideal: 1280 },
      height: { ideal: 720 },
    };
  }

  function wireLocalToPeerConnection(connection) {
    const tracks = localStream ? localStream.getTracks() : [];
    const hasVideo = tracks.some((t) => t.kind === "video" && t.readyState !== "ended");
    const hasAudio = tracks.some((t) => t.kind === "audio" && t.readyState !== "ended");
    tracks.forEach((t) => connection.addTrack(t, localStream));
    if (!hasVideo) connection.addTransceiver("video", { direction: "recvonly" });
    if (!hasAudio) connection.addTransceiver("audio", { direction: "recvonly" });
  }

  async function ensureLocalMedia() {
    if (localStream) {
      syncLocalPip();
      return localStream;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      syncLocalPip();
      return null;
    }

    const audio = audioConstraints();
    const attempts = [
      { video: videoConstraints(), audio },
      { video: false, audio },
      { audio: true },
    ];

    for (const constraints of attempts) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (localStream.getTracks().length) break;
        localStream.getTracks().forEach((t) => t.stop());
        localStream = null;
      } catch (_) {
        localStream = null;
      }
    }

    syncLocalPip();
    updateMediaControls();
    return localStream;
  }

  function createPeerConnection() {
    const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    conn.ontrack = (ev) => {
      if (remoteVideo && ev.streams[0]) {
        remoteVideo.srcObject = ev.streams[0];
        playVideo(remoteVideo);
      }
    };
    conn.onicecandidate = (ev) => {
      if (!ev.candidate || !peerId) return;
      send({
        type: "sd_ice",
        session_id: sessionId,
        to_user_id: peerId,
        candidate: ev.candidate.toJSON(),
      });
    };
    conn.onconnectionstatechange = () => {
      if (conn.connectionState === "connected" && !connectedOnce) {
        connectedOnce = true;
        onConnected();
      }
      if (conn.connectionState === "failed") {
        setStatus("Connection failed. Tap New to try again.");
      }
    };
    return conn;
  }

  async function startAsInitiator() {
    await ensureLocalMedia();
    pc = createPeerConnection();
    wireLocalToPeerConnection(pc);
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await pc.setLocalDescription(offer);
    send({
      type: "sd_offer",
      session_id: sessionId,
      to_user_id: peerId,
      sdp: offer,
    });
  }

  async function handleOffer(sdp) {
    await ensureLocalMedia();
    pc = createPeerConnection();
    wireLocalToPeerConnection(pc);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    while (iceQueue.length) {
      await pc.addIceCandidate(new RTCIceCandidate(iceQueue.shift()));
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({
      type: "sd_answer",
      session_id: sessionId,
      to_user_id: peerId,
      sdp: answer,
    });
  }

  async function handleAnswer(sdp) {
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    while (iceQueue.length) {
      await pc.addIceCandidate(new RTCIceCandidate(iceQueue.shift()));
    }
  }

  async function handleIce(candidate) {
    if (!candidate) return;
    if (pc?.remoteDescription) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      iceQueue.push(candidate);
    }
  }

  function onConnected() {
    state = "connected";
    setUiMode("live");
    if (peerLabel) peerLabel.textContent = (peerName || "Stranger").toUpperCase();
    setStatus("");
  }

  async function onMatched(data) {
    cleanupPeer();
    sessionId = data.session_id;
    peerId = data.peer_id;
    peerName = data.peer_name || "Stranger";
    setUiMode("search");
    await ensureLocalMedia();
    const modeLabel = hasLocalVideo ? "video" : hasLocalAudio ? "audio" : "watch";
    setStatus(`Matched with ${peerName}. Connecting ${modeLabel}…`);
    if (data.is_initiator) {
      await startAsInitiator();
    } else {
      pc = createPeerConnection();
      wireLocalToPeerConnection(pc);
    }
    syncLocalPip();
  }

  function onEnded(reason) {
    cleanupPeer();
    setUiMode("search");
    const msg =
      reason === "skipped"
        ? "They skipped. Finding someone new…"
        : reason === "left"
          ? "They left. Finding someone new…"
          : "Stranger disconnected. Searching…";
    setStatus(msg);
    send({ type: "sd_join_queue" });
  }

  function handleWsMessage(data) {
    if (!data?.type?.startsWith("sd_")) return;

    switch (data.type) {
      case "sd_queued":
        state = "queued";
        setUiMode("search");
        setStatus(
          data.position > 1 ? `Queue position ${data.position}…` : "Waiting for a stranger…"
        );
        break;
      case "sd_matched":
        onMatched(data).catch((ex) => {
          setUiMode("search");
          setStatus(ex.message || "Could not start video");
        });
        break;
      case "sd_offer":
        if (data.from_user_id === peerId) {
          handleOffer(data.sdp).catch(() => setStatus("Connection failed"));
        }
        break;
      case "sd_answer":
        if (data.from_user_id === peerId) {
          handleAnswer(data.sdp).catch(() => setStatus("Connection failed"));
        }
        break;
      case "sd_ice":
        if (data.from_user_id === peerId) handleIce(data.candidate);
        break;
      case "sd_ended":
        onEnded(data.reason);
        break;
      default:
        break;
    }
  }

  function connectWs() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      setUiMode("search");
      setStatus("Waiting for a stranger…");
      send({ type: "sd_join_queue" });
    };
    ws.onmessage = (ev) => {
      try {
        handleWsMessage(JSON.parse(ev.data));
      } catch (_) {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!started) return;
      setUiMode("search");
      setStatus("Reconnecting…");
      setTimeout(connectWs, 2000);
    };
  }

  async function onStart() {
    if (!loggedIn) {
      window.location.href = "/?next=" + encodeURIComponent("/stranger-danger");
      return;
    }
    showStartError(null);
    startBtn.disabled = true;
    await ensureLocalMedia();
    if (
      !window.isSecureContext &&
      !/localhost|127\.0\.0\.1/.test(location.hostname) &&
      !hasLocalVideo &&
      !hasLocalAudio
    ) {
      showStartError("No camera/mic here — you can still watch strangers (HTTPS helps for mic).");
    }
    started = true;
    connectWs();
  }

  function returnToStart() {
    started = false;
    send({ type: "sd_leave_queue" });
    cleanupPeer();
    stopLocalMedia();
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    if (startBtn) startBtn.disabled = false;
    showStartError(null);
    setUiMode("start");
  }

  function leaveSession() {
    returnToStart();
  }

  function updateAuthUi() {
    if (loggedIn) {
      startBtn?.classList.remove("hidden");
      signinBtn?.classList.add("hidden");
      guestHint?.classList.add("hidden");
      startBtn.disabled = false;
    } else {
      startBtn?.classList.add("hidden");
      signinBtn?.classList.remove("hidden");
      guestHint?.classList.remove("hidden");
    }
  }

  function cancelSearch() {
    returnToStart();
  }

  muteBtn?.addEventListener("click", () => {
    if (!hasLocalAudio) return;
    muted = !muted;
    localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    updateMediaControls();
  });

  nextBtn?.addEventListener("click", () => {
    cleanupPeer();
    connectedOnce = false;
    setUiMode("search");
    setStatus("Finding next stranger…");
    send({ type: "sd_skip" });
  });

  leaveBtn?.addEventListener("click", leaveSession);
  cancelSearchBtn?.addEventListener("click", cancelSearch);
  startBtn?.addEventListener("click", onStart);
  signinBtn?.addEventListener("click", () => {
    window.location.href = "/?next=" + encodeURIComponent("/stranger-danger");
  });
  function togglePipShape() {
    if (!localPip) return;
    const round = localPip.classList.toggle("sd-local-pip--round");
    localPip.classList.toggle("sd-local-pip--square", !round);
  }

  function onPipActivate(e) {
    e.preventDefault();
    togglePipShape();
  }

  localPip?.addEventListener("click", onPipActivate);
  localPip?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      togglePipShape();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (started) send({ type: "sd_leave_queue" });
  });

  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "visible") {
        playVideo(remoteVideo);
        playVideo(localVideo);
      }
    },
    false
  );

  async function init() {
    setUiMode("start");
    try {
      me = await api("/api/users/me");
      loggedIn = true;
    } catch (_) {
      loggedIn = false;
      me = null;
    }
    updateAuthUi();
    updateMediaControls();
  }

  init();
})();
