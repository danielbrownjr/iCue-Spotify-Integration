export const SCOPES = ["user-read-playback-state", "user-modify-playback-state"];
export const REDIRECT_URI = "http://127.0.0.1:8765/callback";
export const SPOTIFY_API = "https://api.spotify.com/v1";

export function normalizeTrack(item) {
  if (!item || typeof item !== "object") return null;
  return {
    id: item.id ?? null,
    uri: item.uri ?? null,
    title: item.name || "Unknown track",
    artist: (item.artists || item.show?.publisher && [item.show.publisher] || [])
      .map((artist) => typeof artist === "string" ? artist : artist.name)
      .filter(Boolean).join(", "),
    album: item.album?.name || item.show?.name || "",
    durationMs: Number.isFinite(item.duration_ms) ? item.duration_ms : 0,
    image: item.album?.images?.[0]?.url || item.images?.[0]?.url || null
  };
}

export function normalizePlayback(playback, queue) {
  const device = playback?.device || {};
  return {
    authenticated: true,
    active: !!(playback && playback.item),
    playing: !!playback?.is_playing,
    track: normalizeTrack(playback?.item || queue?.currently_playing),
    progressMs: Number.isFinite(playback?.progress_ms) ? playback.progress_ms : 0,
    shuffle: !!playback?.shuffle_state,
    repeat: playback?.repeat_state || "off",
    volumePercent: Number.isFinite(device.volume_percent) ? device.volume_percent : null,
    device: device.name || null,
    queue: Array.isArray(queue?.queue) ? queue.queue.map(normalizeTrack).filter(Boolean).slice(0, 30) : []
  };
}

export function spotifyControl(action, value) {
  const path = "/me/player/";
  switch (action) {
    case "play": return { method: "PUT", path: path + "play" };
    case "pause": return { method: "PUT", path: path + "pause" };
    case "next": return { method: "POST", path: path + "next" };
    case "previous": return { method: "POST", path: path + "previous" };
    case "shuffle":
      if (typeof value !== "boolean") throw new Error("Shuffle requires a boolean");
      return { method: "PUT", path: path + "shuffle?state=" + value };
    case "repeat":
      if (!["off", "context", "track"].includes(value)) throw new Error("Invalid repeat mode");
      return { method: "PUT", path: path + "repeat?state=" + value };
    case "volume":
      if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("Volume must be 0-100");
      return { method: "PUT", path: path + "volume?volume_percent=" + value };
    case "seek":
      if (!Number.isInteger(value) || value < 0 || value > 86400000) throw new Error("Invalid seek position");
      return { method: "PUT", path: path + "seek?position_ms=" + value };
    default: throw new Error("Unsupported control");
  }
}
