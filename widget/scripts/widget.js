/* iCUE injects x-icue-property globals before the widget scripts load. */
(() => {
  "use strict";
  const API = "http://127.0.0.1:8765";
  const elements = Object.fromEntries(["art", "art-fallback", "status", "device", "title", "artist",
    "album", "play", "previous", "next", "shuffle", "repeat", "progress", "elapsed", "duration",
    "queue", "queue-count", "queue-warning", "volume", "volume-number", "repeat-one"]
    .map((id) => [id, document.getElementById(id)]));
  let lastState = null;
  let receivedAt = 0;
  let currentCoverId = null;
  let waitingOnCommand = false;
  let queueJumpInProgress = false;
  let queueJumpWarning = null;
  let seeking = false;

  function setting(name, fallback) {
    const value = window[name];
    return typeof value === "string" && value.trim() ? value : fallback;
  }
  function key() { return setting("pairingKey", "").trim(); }
  function status(message, warning = false) {
    elements.status.textContent = message;
    elements.status.classList.toggle("warn", warning);
  }
  function activeJumpWarning() {
    if (queueJumpWarning && Date.now() < queueJumpWarning.expires) return queueJumpWarning.message;
    queueJumpWarning = null;
    return null;
  }
  function renderWarning(queueError = null) {
    const message = activeJumpWarning() || (queueError ? "Queue unavailable: " + queueError : null);
    elements["queue-warning"].hidden = !message;
    elements["queue-warning"].textContent = message || "";
  }
  function formatMs(milliseconds) {
    const s = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function applyStyle() {
    document.documentElement.style.setProperty("--accent-color", setting("accentColor", "#ff9e3b"));
    document.documentElement.style.setProperty("--background-color", setting("backgroundColor", "#000000"));
  }
  function updateProgress() {
    if (!lastState || !lastState.track) return;
    const duration = lastState.track.durationMs || 0;
    const elapsed = Math.min(duration, lastState.progressMs +
      (lastState.playing ? Date.now() - receivedAt : 0));
    elements.elapsed.textContent = formatMs(elapsed);
    elements.duration.textContent = formatMs(duration);
    if (!seeking) elements.progress.value = duration ? Math.round(elapsed / duration * 1000) : 0;
  }
  function queueRender(items) {
    const container = elements.queue;
    container.replaceChildren();
    elements["queue-count"].textContent = items.length ? " · " + items.length : "";
    if (!items.length) {
      const paragraph = document.createElement("p");
      paragraph.className = "placeholder";
      paragraph.textContent = "Queue is empty or Spotify has not returned upcoming tracks.";
      container.append(paragraph);
      return;
    }
    items.forEach((track, index) => {
      const row = document.createElement("div");
      row.className = "queue-item";
      const number = document.createElement("span");
      number.className = "queue-index";
      const playable = index < 5 && !!track.uri && !!lastState?.queueSnapshot;
      const playButton = document.createElement("button");
      playButton.type = "button";
      playButton.className = "queue-play";
      playButton.disabled = !playable || !!lastState?.queueJumpPending || queueJumpInProgress;
      playButton.title = playable ? "Skip to " + track.title + " (consumes earlier queue songs)"
        : "Only the first five upcoming songs support a verified jump";
      playButton.setAttribute("aria-label", playable
        ? "Play " + track.title + " from queue; skips earlier songs"
        : "Queue item " + (index + 1) + ": jump unavailable");
      const indexLabel = document.createElement("span");
      indexLabel.className = "queue-number";
      indexLabel.textContent = String(index + 1).padStart(2, "0");
      const playGlyph = document.createElement("span");
      playGlyph.className = "queue-play-glyph";
      playGlyph.textContent = "▶";
      playGlyph.setAttribute("aria-hidden", "true");
      playButton.append(indexLabel, playGlyph);
      playButton.addEventListener("click", () => jumpToQueue(index, track));
      number.append(playButton);
      const meta = document.createElement("div");
      meta.className = "queue-meta";
      const title = document.createElement("span");
      title.className = "queue-title";
      title.textContent = track.title || "Untitled";
      const artist = document.createElement("span");
      artist.className = "queue-artist";
      artist.textContent = track.artist || "Unknown artist";
      meta.append(title, artist);
      const duration = document.createElement("span");
      duration.className = "queue-length";
      duration.textContent = formatMs(track.durationMs);
      row.append(number, meta, duration);
      container.append(row);
    });
  }
  function render(data) {
    lastState = data;
    receivedAt = Date.now();
    if (!data.authenticated) {
      status("Open companion /connect", true);
      elements.title.textContent = "Spotify not connected";
      elements.artist.textContent = "Authorize Spotify using your browser";
      elements.album.textContent = "";
      elements.queue.replaceChildren();
      elements["queue-count"].textContent = "";
      return;
    }
    const track = data.track;
    status(activeJumpWarning() ? "Queue jump stopped (details below)" :
      queueJumpInProgress || data.queueJumpPending ? "Skipping queued tracks…" :
      data.active ? (data.playing ? "● LIVE" : "Ⅱ PAUSED") : "No active playback",
      !!activeJumpWarning());
    elements.title.textContent = track?.title || "Nothing playing";
    elements.artist.textContent = track?.artist || "Start Spotify playback to begin";
    elements.album.textContent = track?.album || "";
    elements.device.textContent = data.device || "UNKNOWN DEVICE";
    elements.play.setAttribute("data-playing", String(!!data.playing));
    elements.play.setAttribute("aria-label", data.playing ? "Pause" : "Play");
    elements.shuffle.classList.toggle("selected", !!data.shuffle);
    elements.shuffle.setAttribute("aria-pressed", String(!!data.shuffle));
    elements.shuffle.setAttribute("aria-label", data.shuffle ? "Shuffle on" : "Shuffle off");
    elements.shuffle.title = data.shuffle
      ? "Shuffle on (Smart Shuffle status is not available through Spotify Web API)"
      : "Shuffle off";
    const repeatMode = ["off", "context", "track"].includes(data.repeat) ? data.repeat : "off";
    const repeatLabel = { off: "Repeat off", context: "Repeat all", track: "Repeat one" }[repeatMode];
    elements.repeat.classList.toggle("selected", repeatMode !== "off");
    elements.repeat.setAttribute("data-mode", repeatMode);
    elements.repeat.setAttribute("aria-label", repeatLabel);
    elements.repeat.setAttribute("aria-pressed", String(repeatMode !== "off"));
    elements.repeat.title = repeatLabel;
    elements["repeat-one"].hidden = repeatMode !== "track";
    elements.volume.disabled = data.volumePercent == null;
    if (data.volumePercent != null && !elements.volume.matches(":active")) {
      elements.volume.value = data.volumePercent;
      elements["volume-number"].textContent = String(data.volumePercent);
    }
    const coverId = track?.id || track?.uri || null;
    if (coverId !== currentCoverId) {
      currentCoverId = coverId;
      if (track?.image) {
        elements.art.src = API + "/api/art?track=" + encodeURIComponent(coverId || "current");
        elements.art.hidden = false;
        elements["art-fallback"].hidden = true;
      } else {
        elements.art.hidden = true;
        elements["art-fallback"].hidden = false;
      }
    }
    renderWarning(data.queueError);
    queueRender(data.queue || []);
    updateProgress();
  }

  async function refresh() {
    applyStyle();
    if (!key()) { status("Set pairing key in widget settings", true); return; }
    try {
      const response = await fetch(API + "/api/state", {
        headers: { "X-Widget-Key": key() }, cache: "no-store"
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
      render(data);
    } catch (error) {
      status(error.message || "Companion offline", true);
    }
  }
  async function jumpToQueue(index, track) {
    if (waitingOnCommand || index >= 5 || !track?.uri || !lastState?.queueSnapshot) return;
    waitingOnCommand = true;
    queueJumpInProgress = true;
    const snapshot = lastState.queueSnapshot;
    queueJumpWarning = null;
    let failure = null;
    status("Skipping to " + track.title + "…");
    try {
      const response = await fetch(API + "/api/queue-jump", {
        method: "POST",
        headers: { "X-Widget-Key": key(), "Content-Type": "application/json" },
        body: JSON.stringify({ index, snapshot })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Spotify could not verify queue jump");
    } catch (error) {
      // A successful earlier skip cannot be undone. Keep the failure visible
      // after refreshing the real playback state; never imply full success.
      failure = error.message || "Queue jump stopped";
    } finally {
      queueJumpInProgress = false;
      waitingOnCommand = false;
      if (failure) queueJumpWarning = { message: failure, expires: Date.now() + 60000 };
      await refresh();
      renderWarning(lastState?.queueError);
      if (failure) status("Queue jump stopped (details below)", true);
    }
  }
  async function command(action, value) {
    if (waitingOnCommand || !key()) return;
    waitingOnCommand = true;
    try {
      const response = await fetch(API + "/api/control", {
        method: "POST", headers: { "X-Widget-Key": key(), "Content-Type": "application/json" },
        body: JSON.stringify({ action, value })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Command failed");
      await new Promise((resolve) => setTimeout(resolve, 350));
      await refresh();
    } catch (error) { status(error.message, true); }
    finally { waitingOnCommand = false; }
  }
  elements.previous.addEventListener("click", () => command("previous"));
  elements.next.addEventListener("click", () => command("next"));
  elements.play.addEventListener("click", () => command(lastState?.playing ? "pause" : "play"));
  elements.shuffle.addEventListener("click", () => command("shuffle", !lastState?.shuffle));
  elements.repeat.addEventListener("click", () => {
    const modes = ["off", "context", "track"];
    const current = modes.indexOf(lastState?.repeat || "off");
    command("repeat", modes[(current + 1) % modes.length]);
  });
  elements.progress.addEventListener("pointerdown", () => { seeking = true; });
  elements.progress.addEventListener("pointerup", () => { seeking = false; });
  elements.progress.addEventListener("change", () => {
    seeking = false;
    const duration = lastState?.track?.durationMs || 0;
    if (duration) command("seek", Math.round(duration * Number(elements.progress.value) / 1000));
  });
  elements.volume.addEventListener("change", () => command("volume", Number(elements.volume.value)));
  elements.art.addEventListener("error", () => {
    elements.art.hidden = true;
    elements["art-fallback"].hidden = false;
  });
  window.icueEvents = {
    onICUEInitialized: () => { applyStyle(); refresh(); },
    onDataUpdated: () => { applyStyle(); refresh(); }
  };
  if (typeof iCUE_initialized !== "undefined" && iCUE_initialized) applyStyle();
  applyStyle();
  refresh();
  setInterval(refresh, 3500);
  setInterval(updateProgress, 1000);
})();
