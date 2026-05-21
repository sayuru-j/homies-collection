/**
 * Beam: toggle live location sharing; long-press opens fellow homies on a map.
 */
const HomiesBeam = (function () {
  const LONG_PRESS_MS = 500;
  const POST_INTERVAL_MS = 12000;

  let beaming = false;
  let geoWatchId = null;
  let lastPostAt = 0;
  let longPressTimer = null;
  let longPressTriggered = false;
  let suppressNextClick = false;

  /** @type {Map<string, object>} */
  const peers = new Map();

  let map = null;
  let markersLayer = null;
  let leafletReady = typeof L !== "undefined";

  function locationShareAllowed() {
    return !!(typeof me !== "undefined" && me && (me.location_share_allowed || me.settings?.location_share_allowed));
  }

  function syncBeamButtons() {
    document.querySelectorAll(".guild-btn--beam").forEach((btn) => {
      btn.classList.toggle("guild-btn--beam-active", beaming);
      btn.setAttribute("aria-pressed", beaming ? "true" : "false");
      btn.title = beaming ? "Stop beaming (hold for map)" : "Beam live location (hold for map)";
      const off = btn.querySelector(".beam-icon-off");
      const on = btn.querySelector(".beam-icon-on");
      if (off) off.classList.toggle("hidden", beaming);
      if (on) on.classList.toggle("hidden", !beaming);
    });
    if (typeof HomiesIcons !== "undefined") HomiesIcons.refreshIcons();
  }

  function syncSettingsCheckbox() {
    const cb = document.getElementById("location-share-allowed");
    if (!cb || typeof me === "undefined" || !me) return;
    cb.checked = locationShareAllowed();
  }

  function onMeLoaded() {
    syncSettingsCheckbox();
    syncBeamButtons();
  }

  function upsertPeer(loc) {
    if (!loc?.id) return;
    peers.set(loc.id, loc);
  }

  function removePeer(userId) {
    peers.delete(userId);
  }

  function handleWsMessage(data) {
    if (data.type === "location_update" && data.location) {
      upsertPeer(data.location);
      if (map && !document.getElementById("beam-map-modal")?.classList.contains("hidden")) {
        renderMapMarkers();
      }
      return true;
    }
    if (data.type === "location_stopped" && data.user_id) {
      removePeer(data.user_id);
      if (map && !document.getElementById("beam-map-modal")?.classList.contains("hidden")) {
        renderMapMarkers();
      }
      return true;
    }
    return false;
  }

  function positionPayload(pos) {
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    };
  }

  async function postPosition(coords, force) {
    const now = Date.now();
    if (!force && now - lastPostAt < POST_INTERVAL_MS) return;
    lastPostAt = now;
    const body = {
      lat: coords.latitude,
      lng: coords.longitude,
      accuracy: coords.accuracy,
    };
    await api("/api/location/position", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async function startBeam() {
    if (!locationShareAllowed()) {
      alert("Turn on “Allow others to see me on the Beam map” in My Account, then try again.");
      if (typeof openProfileModal === "function") openProfileModal("account");
      return;
    }
    if (!navigator.geolocation) {
      alert("Your browser does not support location.");
      return;
    }

    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 5000,
      });
    }).catch((err) => {
      alert(err?.message || "Could not get your location. Allow location access and try again.");
      return null;
    });
    if (!pos) return;

    const payload = positionPayload(pos);
    await api("/api/location/beam", {
      method: "POST",
      body: JSON.stringify({ active: true, ...payload }),
    });

    beaming = true;
    syncBeamButtons();
    lastPostAt = Date.now();
    if (typeof me !== "undefined" && me?.id) {
      upsertPeer({
        id: me.id,
        name: me.name,
        display_name: me.display_name || me.name,
        avatar: me.avatar,
        lat: payload.lat,
        lng: payload.lng,
        accuracy: payload.accuracy,
      });
    }

    if (geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = navigator.geolocation.watchPosition(
      (p) => {
        postPosition(p.coords).catch(() => {});
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
  }

  async function stopBeam() {
    if (geoWatchId != null) {
      navigator.geolocation.clearWatch(geoWatchId);
      geoWatchId = null;
    }
    beaming = false;
    syncBeamButtons();
    try {
      await api("/api/location/beam", {
        method: "POST",
        body: JSON.stringify({ active: false }),
      });
    } catch (_) {
      /* offline — local state already off */
    }
    if (typeof me !== "undefined" && me?.id) removePeer(me.id);
  }

  async function toggleBeam() {
    if (beaming) await stopBeam();
    else await startBeam();
  }

  function bindLongPress(btn) {
    const clearTimer = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const onDown = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      longPressTriggered = false;
      clearTimer();
      longPressTimer = setTimeout(() => {
        longPressTriggered = true;
        suppressNextClick = true;
        clearTimer();
        openBeamMap();
      }, LONG_PRESS_MS);
    };

    btn.addEventListener("pointerdown", onDown);
    btn.addEventListener("pointerup", clearTimer);
    btn.addEventListener("pointerleave", clearTimer);
    btn.addEventListener("pointercancel", clearTimer);
    btn.addEventListener("click", (e) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (longPressTriggered) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      toggleBeam().catch((ex) => alert(ex?.message || "Beam failed"));
    });
  }

  function bindBeamBtn(btn) {
    if (!btn) return;
    bindLongPress(btn);
  }

  function avatarUrl(path) {
    if (!path) return null;
    if (path.startsWith("/")) return path;
    if (typeof mediaUrl === "function") return mediaUrl(path);
    return `/media/${path}`;
  }

  function markerHtml(label) {
    const safe = typeof escapeHtml === "function" ? escapeHtml(label) : label;
    return `<div class="beam-marker-label">${safe}</div>`;
  }

  function ensureMap() {
    if (!leafletReady) return false;
    const el = document.getElementById("beam-map");
    if (!el) return false;
    if (!map) {
      map = L.map(el, { zoomControl: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        maxZoom: 19,
      }).addTo(map);
      markersLayer = L.layerGroup().addTo(map);
    }
    return true;
  }

  function listMarkers() {
    const out = [];
    for (const loc of peers.values()) {
      if (loc.lat == null || loc.lng == null) continue;
      out.push(loc);
    }
    if (beaming && typeof me !== "undefined" && me?.id) {
      const mine = peers.get(me.id);
      if (!mine && geoWatchId != null) {
        /* may appear after first post */
      }
    }
    return out;
  }

  function renderMapMarkers() {
    if (!markersLayer) return;
    markersLayer.clearLayers();
    const items = listMarkers();
    const emptyEl = document.getElementById("beam-map-empty");
    if (emptyEl) emptyEl.classList.toggle("hidden", items.length > 0);

    const bounds = [];
    for (const loc of items) {
      const name = loc.display_name || loc.name || "Homie";
      const m = L.marker([loc.lat, loc.lng], {
        title: name,
      }).bindPopup(markerHtml(name));
      markersLayer.addLayer(m);
      bounds.push([loc.lat, loc.lng]);
    }

    if (bounds.length === 1) {
      map.setView(bounds[0], 14);
    } else if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    } else {
      map.setView([20, 0], 2);
    }
    setTimeout(() => map.invalidateSize(), 100);
  }

  async function fetchLiveLocations() {
    const res = await api("/api/location/live");
    peers.clear();
    for (const loc of res.locations || []) {
      upsertPeer(loc);
    }
  }

  async function openBeamMap() {
    if (!leafletReady) {
      alert("Map could not load. Check your connection and refresh.");
      return;
    }
    if (typeof openModal === "function") openModal("beam-map-modal");
    await fetchLiveLocations();
    if (!ensureMap()) return;
    renderMapMarkers();
  }

  function closeBeamMap() {
    if (typeof closeModal === "function") closeModal("beam-map-modal");
  }

  function init() {
    bindBeamBtn(document.getElementById("beam-btn-guild"));
    bindBeamBtn(document.getElementById("beam-btn-panel"));
    syncBeamButtons();
    syncSettingsCheckbox();

    document.getElementById("beam-map-modal")?.addEventListener("transitionend", () => {
      if (map) map.invalidateSize();
    });
  }

  function getLocationShareFromForm() {
    const cb = document.getElementById("location-share-allowed");
    return cb ? !!cb.checked : locationShareAllowed();
  }

  return {
    init,
    onMeLoaded,
    handleWsMessage,
    getLocationShareFromForm,
    isBeaming: () => beaming,
    stopBeam,
    openBeamMap,
    closeBeamMap,
  };
})();
