/**
 * Composite 1:1 video call feeds — flat Discord-style tiles for MediaRecorder.
 */
(function () {
  const CANVAS_W = 1280;
  const CANVAS_H = 720;
  const FPS = 24;
  const GAP = 10;
  const PANEL_W = (CANVAS_W - GAP) / 2;
  const CANVAS_BG = "#2b2d31";
  const PANEL_PAD = 18;
  const HEADER_H = 40;
  const TILE_RADIUS = 14;

  /** Dark muted pastels (Discord-adjacent, flat solids). */
  const PASTEL_PANEL_COLORS = [
    "#3d3558",
    "#2d4548",
    "#453d4a",
    "#354238",
    "#3a3f55",
    "#4a3d52",
    "#2f3a4f",
    "#3d424a",
    "#423848",
    "#354550",
    "#3f3648",
    "#2e4048",
  ];

  let canvas = null;
  let ctx = null;
  let rafId = null;
  let recorder = null;
  let chunks = [];
  let mimeType = "video/webm";
  let audioCtx = null;
  let mixedStream = null;
  let active = false;
  let savedPercent = 5;
  let leftLabel = "Peer";
  let rightLabel = "You";
  let leftPanelBg = PASTEL_PANEL_COLORS[0];
  let rightPanelBg = PASTEL_PANEL_COLORS[1];

  function pickMimeType() {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    for (const t of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) {
        return t;
      }
    }
    return "video/webm";
  }

  function pickPanelColors() {
    const i = Math.floor(Math.random() * PASTEL_PANEL_COLORS.length);
    let j = Math.floor(Math.random() * PASTEL_PANEL_COLORS.length);
    if (j === i) j = (i + 1) % PASTEL_PANEL_COLORS.length;
    leftPanelBg = PASTEL_PANEL_COLORS[i];
    rightPanelBg = PASTEL_PANEL_COLORS[j];
  }

  function waitVideoReady(video, timeoutMs = 10000) {
    if (!video) return Promise.resolve();
    if (video.readyState >= 2 && (video.videoWidth || 0) > 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(done, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        done();
      };
      video.addEventListener("loadeddata", onReady, { once: true });
      video.addEventListener("loadedmetadata", onReady, { once: true });
      video.play?.().catch(() => {});
    });
  }

  function hasVideoFrame(video) {
    return (
      video &&
      video.readyState >= 2 &&
      (video.videoWidth || 0) > 0 &&
      (video.videoHeight || 0) > 0
    );
  }

  function roundRectPath(x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function containRect(video, bx, by, bw, bh) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(bw / vw, bh / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    return {
      x: bx + (bw - dw) / 2,
      y: by + (bh - dh) / 2,
      w: dw,
      h: dh,
    };
  }

  function drawRoundedVideo(video, frame) {
    const { x, y, w, h } = frame;
    ctx.save();
    roundRectPath(x, y, w, h, TILE_RADIUS);
    ctx.clip();
    ctx.drawImage(video, x, y, w, h);
    ctx.restore();
  }

  function drawLabel(panelX, text) {
    const chipX = panelX + PANEL_PAD;
    const chipY = 12;
    ctx.font = "600 15px Whitney, Inter, system-ui, sans-serif";
    const textW = ctx.measureText(text).width;
    const chipW = textW + 20;
    const chipH = 26;

    roundRectPath(chipX, chipY, chipW, chipH, 6);
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.fill();

    ctx.fillStyle = "#f2f3f5";
    ctx.fillText(text, chipX + 10, chipY + 18);
  }

  function drawPlaceholderTile(x, y, w, h, label, bgColor) {
    ctx.fillStyle = bgColor;
    ctx.fillRect(x, y, w, h);

    ctx.fillStyle = "rgba(242, 243, 245, 0.45)";
    ctx.font = "500 14px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No video", x + w / 2, y + h / 2 - 6);
    ctx.fillStyle = "#f2f3f5";
    ctx.font = "600 16px Inter, system-ui, sans-serif";
    ctx.fillText(label, x + w / 2, y + h / 2 + 16);
    ctx.textAlign = "left";
  }

  function drawDiscordPanel(video, panelX, bgColor, label) {
    const w = PANEL_W;
    const h = CANVAS_H;

    ctx.fillStyle = bgColor;
    ctx.fillRect(panelX, 0, w, h);

    const contentX = panelX + PANEL_PAD;
    const contentY = HEADER_H + PANEL_PAD * 0.5;
    const contentW = w - PANEL_PAD * 2;
    const contentH = h - HEADER_H - PANEL_PAD;

    if (hasVideoFrame(video)) {
      const frame = containRect(video, contentX, contentY, contentW, contentH);
      drawRoundedVideo(video, frame);
    } else {
      drawPlaceholderTile(panelX, HEADER_H, w, h - HEADER_H, label, bgColor);
    }

    drawLabel(panelX, label);
  }

  function paintFrame(localVideo, remoteVideo) {
    if (!ctx) return;

    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    drawDiscordPanel(remoteVideo, 0, leftPanelBg, leftLabel);
    drawDiscordPanel(localVideo, PANEL_W + GAP, rightPanelBg, rightLabel);

    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(PANEL_W, 0, GAP, CANVAS_H);
  }

  function loop(localVideo, remoteVideo) {
    paintFrame(localVideo, remoteVideo);
    rafId = requestAnimationFrame(() => loop(localVideo, remoteVideo));
  }

  function mixAudio(localStream, remoteStream) {
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const add = (stream) => {
      if (!stream) return;
      stream.getAudioTracks().forEach((track) => {
        try {
          const src = audioCtx.createMediaStreamSource(new MediaStream([track]));
          src.connect(dest);
        } catch (_) {
          /* ignore */
        }
      });
    };
    add(localStream);
    add(remoteStream);
    return dest.stream;
  }

  function cleanup() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch (_) {
        /* ignore */
      }
    }
    recorder = null;
    chunks = [];
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    mixedStream = null;
    canvas = null;
    ctx = null;
    active = false;
  }

  async function start({
    localStream,
    remoteStream,
    localVideoEl,
    remoteVideoEl,
    compressionPercent,
    leftLabel: leftName,
    rightLabel: rightName,
  }) {
    if (active) return false;
    if (typeof MediaRecorder === "undefined") {
      throw new Error("Recording is not supported in this browser");
    }

    leftLabel = leftName || "Peer";
    rightLabel = rightName || "You";
    pickPanelColors();

    savedPercent =
      typeof compressionPercent === "number"
        ? compressionPercent
        : typeof getMediaCompressionPercent === "function"
          ? getMediaCompressionPercent()
          : 5;

    canvas = document.createElement("canvas");
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not start recording");

    const localVideo = localVideoEl || document.createElement("video");
    const remoteVideo = remoteVideoEl || document.createElement("video");
    localVideo.muted = true;
    localVideo.playsInline = true;
    remoteVideo.muted = true;
    remoteVideo.playsInline = true;

    if (!localVideoEl && localStream) {
      localVideo.srcObject = localStream;
    }
    if (!remoteVideoEl && remoteStream) {
      remoteVideo.srcObject = remoteStream;
    }
    if (localVideoEl && localStream && !localVideo.srcObject) {
      localVideo.srcObject = localStream;
    }
    if (remoteVideoEl && remoteStream && !remoteVideo.srcObject) {
      remoteVideo.srcObject = remoteStream;
    }

    await Promise.all([
      waitVideoReady(remoteVideo),
      waitVideoReady(localVideo),
      localVideo.play?.().catch(() => {}) ?? Promise.resolve(),
      remoteVideo.play?.().catch(() => {}) ?? Promise.resolve(),
    ]);

    loop(localVideo, remoteVideo);

    const videoStream = canvas.captureStream(FPS);
    const audioMixed = mixAudio(localStream, remoteStream);
    const tracks = [...videoStream.getVideoTracks(), ...audioMixed.getAudioTracks()];
    mixedStream = new MediaStream(tracks);

    mimeType = pickMimeType();
    chunks = [];
    recorder = new MediaRecorder(mixedStream, {
      mimeType,
      videoBitsPerSecond: 3_200_000,
      audioBitsPerSecond: 128_000,
    });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.start(1000);
    active = true;
    return true;
  }

  function stop() {
    if (!active || !recorder) {
      cleanup();
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const finish = () => {
        const blob = chunks.length ? new Blob(chunks, { type: mimeType }) : null;
        const percent = savedPercent;
        cleanup();
        if (!blob || blob.size < 1024) {
          resolve(null);
          return;
        }
        resolve({ blob, compressionPercent: percent, mimeType });
      };

      recorder.onstop = finish;
      recorder.onerror = finish;
      try {
        if (recorder.state === "recording") recorder.stop();
        else finish();
      } catch (_) {
        finish();
      }
    });
  }

  window.CallRecording = {
    isActive: () => active,
    start,
    stop,
    forceStop: () => {
      cleanup();
      return Promise.resolve(null);
    },
  };
})();
