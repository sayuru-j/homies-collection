const CHUNK_SIZE = 256 * 1024;

let activeTransferController = null;

/** UUID for chunked uploads; many mobile browsers lack crypto.randomUUID. */
function newUploadId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function beginActiveTransfer() {
  cancelActiveTransfer();
  activeTransferController = new AbortController();
  return activeTransferController.signal;
}

function cancelActiveTransfer() {
  if (activeTransferController) {
    activeTransferController.abort();
    activeTransferController = null;
  }
}

function isTransferActive() {
  return activeTransferController != null && !activeTransferController.signal.aborted;
}

function throwIfTransferAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException("Upload cancelled", "AbortError");
  }
}

function isTransferCancelled(err) {
  return err?.name === "AbortError";
}

async function api(path, options = {}) {
  const { signal, ...fetchOptions } = options;
  const res = await fetch(path, {
    credentials: "include",
    headers: fetchOptions.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    ...fetchOptions,
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = data.message || res.statusText;
    if (typeof data.detail === "string") msg = data.detail;
    else if (Array.isArray(data.detail)) msg = data.detail.map((d) => d.msg || d).join(", ");
    throw new Error(msg);
  }
  return data;
}

function mediaUrl(pathOrUrl) {
  if (!pathOrUrl) return "";
  if (pathOrUrl.startsWith("/")) return pathOrUrl;
  const parts = pathOrUrl.replace(/^data\/media\//, "").split("/");
  if (parts.length >= 3) {
    return `/media/${parts[0]}/${parts[1]}/${parts.slice(2).join("/")}`;
  }
  return pathOrUrl;
}

/** Guess thumbnail path for image/video messages (legacy messages without thumb_path). */
function inferThumbPath(mediaPath) {
  if (!mediaPath || !mediaPath.startsWith("data/media/")) return null;
  const parts = mediaPath.replace(/^data\/media\//, "").split("/");
  if (parts.length < 3) return null;
  const [userId, mediaType, ...rest] = parts;
  if (mediaType !== "image" && mediaType !== "video") return null;
  const filename = rest.join("/");
  const stem = filename.replace(/\.[^.]+$/, "") || filename;
  return `data/media/${userId}/${mediaType}/thumbs/${stem}.jpg`;
}

function messageThumbUrl(message) {
  const path = message?.thumb_path || inferThumbPath(message?.media_path);
  return path ? mediaUrl(path) : "";
}

function mediaExtensionFromPath(path) {
  if (!path) return ".webm";
  const m = String(path).match(/(\.[a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : ".webm";
}

function formatDownloadTimestamp(isoOrDate) {
  const d =
    isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate || Date.now());
  if (Number.isNaN(d.getTime())) return formatDownloadTimestamp(new Date());
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** `{prefix-}YYYYMMDD-HHMMSS-{guid}{ext}` for saved downloads. */
function mediaDownloadFilename(options = {}) {
  const { createdAt, id, mediaPath, prefix, ext: extOverride } = options;
  const ext = extOverride || mediaExtensionFromPath(mediaPath);
  let guid = id;
  if (!guid && mediaPath) {
    const base = mediaPath.split("/").pop() || "";
    guid = base.replace(/\.[^.]+$/, "");
  }
  if (!guid && typeof newUploadId === "function") guid = newUploadId();
  guid = String(guid || "file")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 64);
  const time = formatDownloadTimestamp(createdAt);
  const pre = prefix ? `${prefix}-` : "";
  return `${pre}${time}-${guid}${ext}`;
}

/** URL that forces a streamed attachment download (not inline playback). */
function mediaDownloadUrl(pathOrUrl, filename) {
  const base = mediaUrl(pathOrUrl);
  if (!base) return "";
  const params = new URLSearchParams();
  params.set("download", "1");
  if (filename) params.set("name", filename);
  return `${base}?${params.toString()}`;
}

function filenameFromContentDisposition(header) {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;\s]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch (_) {
      /* ignore */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header) || /filename=([^;\s]+)/i.exec(header);
  return plain ? plain[1].trim() : null;
}

async function pumpStreamToSink(body, writeChunk, onProgress, totalBytes) {
  const reader = body.getReader();
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await writeChunk(value);
    received += value.byteLength;
    if (onProgress) {
      onProgress({
        received,
        total: totalBytes,
        percent: totalBytes > 0 ? Math.min(100, Math.round((received / totalBytes) * 100)) : null,
      });
    }
  }
}

function triggerNativeDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  if (filename) a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Download media via HTTP stream. Browsers without a save picker use a native
 * attachment download (streamed by the browser). Chromium can pipe fetch body
 * directly to disk via showSaveFilePicker.
 */
async function streamDownloadFile(url, filename, options = {}) {
  if (!url) throw new Error("Missing download URL");

  const wantProgress = typeof options.onProgress === "function";
  const canPickFile = typeof window.showSaveFilePicker === "function";

  if (!canPickFile) {
    triggerNativeDownload(url, filename);
    if (wantProgress) options.onProgress({ received: 0, total: 0, percent: 100 });
    return filename || "download";
  }

  const res = await fetch(url, { credentials: "include", signal: options.signal });
  if (!res.ok) throw new Error("Download failed");

  const saveName =
    filenameFromContentDisposition(res.headers.get("Content-Disposition")) ||
    filename ||
    "download";
  const totalBytes = Number(res.headers.get("Content-Length")) || 0;

  if (!res.body) {
    triggerNativeDownload(url, saveName);
    return saveName;
  }

  try {
    const handle = await window.showSaveFilePicker({ suggestedName: saveName });
    const writable = await handle.createWritable();
    await pumpStreamToSink(
      res.body,
      (chunk) => writable.write(chunk),
      options.onProgress,
      totalBytes
    );
    await writable.close();
    return saveName;
  } catch (ex) {
    if (ex.name === "AbortError") throw ex;
    triggerNativeDownload(url, saveName);
    if (wantProgress) options.onProgress({ received: 0, total: 0, percent: 100 });
    return saveName;
  }
}

async function uploadChunked(file, mediaType, options = {}) {
  const { compress = true, onProgress, signal } = options;
  const originalSize = file.size;
  let uploadFile = file;
  let compression = null;

  throwIfTransferAborted(signal);

  if (compress && typeof compressMediaForUpload === "function") {
    const pct =
      options.compressionPercent != null
        ? options.compressionPercent
        : typeof getMediaCompressionPercent === "function"
          ? getMediaCompressionPercent()
          : 5;
    const result = await compressMediaForUpload(file, mediaType, pct, onProgress, signal);
    throwIfTransferAborted(signal);
    if (result && result.file) {
      uploadFile = result.file;
      compression = {
        originalSize: result.originalSize,
        compressedSize: result.compressedSize,
        estimatedSize: result.estimatedSize,
      };
    } else if (result instanceof File || result instanceof Blob) {
      uploadFile = result;
    }
  }

  const uploadId = newUploadId();
  const totalChunks = Math.max(1, Math.ceil(uploadFile.size / CHUNK_SIZE));
  let last;

  for (let i = 0; i < totalChunks; i++) {
    throwIfTransferAborted(signal);

    const uploadPct = Math.round(((i + 1) / totalChunks) * 100);
    if (typeof onProgress === "function") {
      onProgress({
        stage: "upload",
        percent: uploadPct,
        label: `Uploading… ${uploadPct}%`,
        chunk: i + 1,
        totalChunks,
        originalSize: compression?.originalSize ?? originalSize,
        compressedSize: uploadFile.size,
      });
    }

    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, uploadFile.size);
    const blob = uploadFile.slice(start, end);
    const form = new FormData();
    form.append("upload_id", uploadId);
    form.append("chunk_index", String(i));
    form.append("total_chunks", String(totalChunks));
    form.append("filename", uploadFile.name || file.name || "file.bin");
    form.append("media_type", mediaType);
    form.append("file", blob, uploadFile.name || file.name || "chunk.bin");

    last = await api("/api/media/chunk", { method: "POST", body: form, signal });
  }

  throwIfTransferAborted(signal);
  return { ...last, compression };
}
