/** Client-side media compression before upload (targets output size by %). */

const DEFAULT_MEDIA_COMPRESSION_PERCENT = 90;
const MIN_MEDIA_COMPRESSION_PERCENT = 0;
const MAX_MEDIA_COMPRESSION_PERCENT = 100;
const MIN_TARGET_BYTES = 50_000;

function clampCompressionPercent(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_MEDIA_COMPRESSION_PERCENT;
  return Math.max(MIN_MEDIA_COMPRESSION_PERCENT, Math.min(MAX_MEDIA_COMPRESSION_PERCENT, n));
}

/** Target output size as fraction of original. 0% = smallest, 100% = no compression. */
function targetSizeRatio(percent) {
  const p = clampCompressionPercent(percent);
  if (p >= 100) return 1;
  return 0.08 + (p / 100) * 0.92;
}

/** Red below 20% or above 90%; green between. */
function compressionQualityZone(percent) {
  const p = clampCompressionPercent(percent);
  if (p < 20 || p > 90) return "warn";
  return "good";
}

function applyCompressionSliderStyle(slider, percent) {
  if (!slider) return;
  const zone = compressionQualityZone(percent);
  slider.dataset.zone = zone;
  const label = document.getElementById("compression-value-label");
  if (label) label.dataset.zone = zone;
}

function targetBytes(originalSize, percent) {
  const ratio = targetSizeRatio(percent);
  if (ratio >= 1) return originalSize;
  return Math.max(MIN_TARGET_BYTES, Math.round(originalSize * ratio));
}

function encodeScale(percent) {
  return Math.sqrt(targetSizeRatio(percent));
}

function formatCompressionLabel(percent) {
  return `${clampCompressionPercent(percent)}%`;
}

function getMediaCompressionPercent() {
  const fromProfile = window.me?.settings?.media_compression_percent;
  if (fromProfile != null) return clampCompressionPercent(fromProfile);
  const stored = localStorage.getItem("media_compression_percent");
  if (stored != null) return clampCompressionPercent(stored);
  return DEFAULT_MEDIA_COMPRESSION_PERCENT;
}

function setMediaCompressionPercentLocal(percent) {
  localStorage.setItem("media_compression_percent", String(clampCompressionPercent(percent)));
}

function formatBytesForCompress(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function estimateCompressedSize(originalSize, mediaType, percent) {
  return targetBytes(originalSize, percent);
}

function compressionSummary(originalSize, compressedSize) {
  if (!compressedSize || compressedSize >= originalSize * 0.98) {
    return `${formatBytesForCompress(originalSize)} (minimal change)`;
  }
  const saved = Math.max(0, Math.round(((originalSize - compressedSize) / originalSize) * 100));
  return `${formatBytesForCompress(originalSize)} → ${formatBytesForCompress(compressedSize)} (−${saved}%)`;
}

function emitProgress(onProgress, data) {
  if (typeof onProgress === "function") onProgress(data);
}

function throwIfAborted(signal) {
  if (typeof throwIfTransferAborted === "function") {
    throwIfTransferAborted(signal);
  } else if (signal?.aborted) {
    throw new DOMException("Upload cancelled", "AbortError");
  }
}

function shouldKeepCompressed(originalSize, newSize, percent) {
  const goal = targetBytes(originalSize, percent);
  if (newSize <= goal * 1.2) return true;
  if (newSize < originalSize * 0.97) return true;
  return false;
}

async function compressImageFile(file, percent, onProgress, signal) {
  if (percent >= 100) return file;

  const goal = targetBytes(file.size, percent);
  const scale = encodeScale(percent);

  throwIfAborted(signal);
  emitProgress(onProgress, { percent: 5, label: "Loading image…" });

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (_) {
    return file;
  }

  let w = bitmap.width;
  let h = bitmap.height;
  let maxSide = Math.max(320, Math.round(2048 * scale));
  let quality = Math.max(0.04, Math.min(0.92, 0.05 + targetSizeRatio(percent) * 0.9));
  let bestBlob = null;

  for (let pass = 0; pass < 8; pass++) {
    throwIfAborted(signal);
    emitProgress(onProgress, {
      percent: Math.min(90, 15 + pass * 10),
      label: `Compressing image… (${formatBytesForCompress(goal)} target)`,
    });

    if (Math.max(w, h) > maxSide) {
      const r = maxSide / Math.max(w, h);
      w = Math.max(1, Math.round(w * r));
      h = Math.max(1, Math.round(h * r));
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) break;
    ctx.drawImage(bitmap, 0, 0, w, h);

    const blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
    });
    if (!blob) break;

    bestBlob = blob;
    if (blob.size <= goal * 1.15) break;

    quality = Math.max(0.03, quality * 0.72);
    maxSide = Math.max(240, Math.round(maxSide * 0.82));
  }

  bitmap.close?.();
  throwIfAborted(signal);
  emitProgress(onProgress, { percent: 95, label: "Finishing…" });

  if (!bestBlob || !shouldKeepCompressed(file.size, bestBlob.size, percent)) {
    return file;
  }

  const base = (file.name || "image").replace(/\.[^.]+$/, "") || "image";
  return new File([bestBlob], `${base}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
}

function pickVideoMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
}

function pickAudioMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
}

function drawVideoCover(ctx, video, cw, ch) {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const ox = (cw - dw) / 2;
  const oy = (ch - dh) / 2;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(video, ox, oy, dw, dh);
}

function waitVideoMetadata(video, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1 && video.duration && isFinite(video.duration)) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("Video metadata timeout")), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    video.addEventListener("loadedmetadata", done, { once: true });
    video.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Video load failed"));
    }, { once: true });
  });
}

function recordCanvasVideo(video, file, percent, passIndex, goal, onProgress, signal) {
  const mimeType = pickVideoMimeType();
  if (!mimeType || typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream) {
    return Promise.resolve(null);
  }

  const ratio = targetSizeRatio(percent);
  const squeeze = Math.pow(0.7, passIndex);
  const dimScale = Math.max(0.1, Math.sqrt(ratio) * squeeze);
  const cw = Math.max(256, Math.round(1280 * dimScale));
  const ch = Math.max(144, Math.round(720 * dimScale));
  const fps = Math.max(8, Math.round(20 * dimScale));
  const duration = video.duration;

  const totalBps = Math.max(
    28_000,
    Math.round(((goal * 8) / Math.max(duration, 1)) * Math.pow(0.72, passIndex))
  );
  const audioBitsPerSecond = Math.max(8_000, Math.round(totalBps * 0.12));
  const videoBitsPerSecond = Math.max(24_000, totalBps - audioBitsPerSecond);

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return Promise.resolve(null);

  const canvasStream = canvas.captureStream(fps);
  const mixed = new MediaStream(canvasStream.getVideoTracks());

  let audioCtx = null;
  try {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaElementSource(video);
    const audioDest = audioCtx.createMediaStreamDestination();
    src.connect(audioDest);
    audioDest.stream.getAudioTracks().forEach((t) => mixed.addTrack(t));
  } catch (_) {
    /* video-only if audio graph fails */
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let rafId = null;
    let recorder = null;

    const cleanup = () => {
      if (rafId) cancelAnimationFrame(rafId);
      canvasStream.getTracks().forEach((t) => t.stop());
      mixed.getTracks().forEach((t) => t.stop());
      if (audioCtx) audioCtx.close().catch(() => {});
    };

    const abort = () => {
      cleanup();
      try {
        if (recorder?.state === "recording") recorder.stop();
      } catch (_) {}
      reject(new DOMException("Upload cancelled", "AbortError"));
    };

    signal?.addEventListener("abort", abort, { once: true });

    const paint = () => {
      drawVideoCover(ctx, video, cw, ch);
      if (!video.ended) {
        rafId = requestAnimationFrame(paint);
      }
    };

    recorder = new MediaRecorder(mixed, {
      mimeType,
      videoBitsPerSecond,
      audioBitsPerSecond,
    });

    recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      cleanup();
      if (signal?.aborted) {
        reject(new DOMException("Upload cancelled", "AbortError"));
        return;
      }
      if (!chunks.length) {
        resolve(null);
        return;
      }
      const blob = new Blob(chunks, { type: mimeType });
      const ext = mimeType.includes("mp4") ? ".mp4" : ".webm";
      const base = (file.name || "video").replace(/\.[^.]+$/, "") || "video";
      resolve(new File([blob], `${base}${ext}`, { type: mimeType, lastModified: Date.now() }));
    };

    recorder.onerror = () => {
      cleanup();
      resolve(null);
    };

    emitProgress(onProgress, {
      percent: Math.min(90, 10 + passIndex * 15),
      label: `Compressing video (pass ${passIndex + 1})…`,
    });

    recorder.start(400);
    video.currentTime = 0;
    video
      .play()
      .then(() => {
        paint();
        video.onended = () => {
          try {
            if (recorder.state === "recording") recorder.stop();
          } catch (_) {
            resolve(null);
          }
        };
      })
      .catch(() => {
        cleanup();
        resolve(null);
      });
  });
}

async function compressVideoFile(file, percent, onProgress, signal) {
  if (percent >= 100 || !file.type.startsWith("video/")) return file;
  if (!pickVideoMimeType()) return file;

  const goal = targetBytes(file.size, percent);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const url = URL.createObjectURL(file);

  emitProgress(onProgress, { percent: 3, label: "Loading video…" });

  try {
    video.src = url;
    await waitVideoMetadata(video);
    throwIfAborted(signal);

    if (!video.duration || !isFinite(video.duration) || video.duration <= 0) {
      return file;
    }

    let best = null;
    for (let pass = 0; pass < 4; pass++) {
      throwIfAborted(signal);
      const tighter =
        pass === 0
          ? percent
          : clampCompressionPercent(percent - pass * 80);
      const out = await recordCanvasVideo(video, file, tighter, pass, goal, onProgress, signal);
      if (!out) continue;
      best = out;
      if (out.size <= goal * 1.25) break;
      video.pause();
      video.currentTime = 0;
    }

    if (!best || !shouldKeepCompressed(file.size, best.size, percent)) {
      return file;
    }
    return best;
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    return file;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function compressAudioFile(file, percent, onProgress, signal) {
  if (percent >= 100 || !file.type.startsWith("audio/")) return file;

  const mimeType = pickAudioMimeType();
  if (!mimeType) return file;

  const goal = targetBytes(file.size, percent);
  emitProgress(onProgress, { percent: 5, label: "Loading audio…" });

  let arrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch (_) {
    return file;
  }

  throwIfAborted(signal);

  let best = null;
  for (let pass = 0; pass < 4; pass++) {
    throwIfAborted(signal);
    const tighter =
      pass === 0 ? percent : clampCompressionPercent(percent - pass * 80);
    const passGoal = targetBytes(file.size, tighter);

    const audioCtx = new AudioContext();
    let audioBuffer;
    try {
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    } catch (_) {
      await audioCtx.close().catch(() => {});
      break;
    }

    const duration = audioBuffer.duration;
    if (!duration || !isFinite(duration)) {
      await audioCtx.close().catch(() => {});
      break;
    }

    const totalBps = Math.max(12_000, Math.round((passGoal * 8) / duration));

    emitProgress(onProgress, {
      percent: Math.min(88, 20 + pass * 18),
      label: `Compressing audio (pass ${pass + 1})…`,
    });

    try {
      const blob = await new Promise((resolve, reject) => {
        const chunks = [];
        const dest = audioCtx.createMediaStreamDestination();
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(dest);

        const recorder = new MediaRecorder(dest.stream, {
          mimeType,
          audioBitsPerSecond: totalBps,
        });

        const onAbort = () => {
          try {
            recorder.stop();
          } catch (_) {}
          reject(new DOMException("Upload cancelled", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        recorder.ondataavailable = (e) => {
          if (e.data?.size > 0) chunks.push(e.data);
        };
        recorder.onstop = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(chunks.length ? new Blob(chunks, { type: mimeType }) : null);
        };
        recorder.onerror = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(null);
        };

        recorder.start(200);
        source.start(0);
        source.onended = () => {
          try {
            if (recorder.state === "recording") recorder.stop();
          } catch (_) {
            resolve(null);
          }
        };
      });

      await audioCtx.close().catch(() => {});

      if (blob && blob.size > 0) {
        const ext = mimeType.includes("ogg") ? ".ogg" : ".webm";
        const base = (file.name || "audio").replace(/\.[^.]+$/, "") || "audio";
        best = new File([blob], `${base}${ext}`, { type: mimeType, lastModified: Date.now() });
        if (best.size <= goal * 1.25) break;
      }
    } catch (err) {
      await audioCtx.close().catch(() => {});
      if (err?.name === "AbortError") throw err;
    }
  }

  if (!best || !shouldKeepCompressed(file.size, best.size, percent)) {
    return file;
  }
  return best;
}

async function compressMediaForUpload(
  file,
  mediaType,
  percent = getMediaCompressionPercent(),
  onProgress,
  signal
) {
  const originalSize = file?.size || 0;
  const pct = clampCompressionPercent(percent);
  const estimatedSize = estimateCompressedSize(originalSize, mediaType, pct);

  if (!file) {
    return { file, originalSize, compressedSize: originalSize, estimatedSize };
  }

  if (pct >= 100) {
    return { file, originalSize, compressedSize: originalSize, estimatedSize: originalSize };
  }

  const wrapProgress = (p) => {
    emitProgress(onProgress, {
      stage: "compress",
      percent: p.percent,
      label: p.label,
      originalSize,
      estimatedSize,
    });
  };

  emitProgress(onProgress, {
    stage: "compress",
    percent: 0,
    label: `Preparing compression (target ~${formatBytesForCompress(estimatedSize)})…`,
    originalSize,
    estimatedSize,
  });

  try {
    let result = file;
    if (mediaType === "image" || mediaType === "avatar") {
      result = await compressImageFile(file, pct, wrapProgress, signal);
    } else if (mediaType === "video") {
      result = await compressVideoFile(file, pct, wrapProgress, signal);
    } else if (mediaType === "voice") {
      result = await compressAudioFile(file, pct, wrapProgress, signal);
    }

    throwIfAborted(signal);

    emitProgress(onProgress, {
      stage: "compress",
      percent: 100,
      label: "Compression complete",
      originalSize,
      compressedSize: result.size,
      estimatedSize,
      summary: compressionSummary(originalSize, result.size),
    });

    return {
      file: result,
      originalSize,
      compressedSize: result.size,
      estimatedSize,
    };
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    return { file, originalSize, compressedSize: originalSize, estimatedSize };
  }
}
