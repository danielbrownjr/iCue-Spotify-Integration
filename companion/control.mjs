import { spotifyControl } from "./spotify.mjs";

export async function performControl(action, value, request) {
  const operation = spotifyControl(action, value);
  if (action === "play" || action === "pause") {
    // Read Spotify directly: the poll cache can lag behind a recent touch.
    const playback = await request("/me/player");
    if (typeof playback?.is_playing === "boolean" &&
        playback.is_playing === (action === "play")) return;
  }
  await request(operation.path, operation.method);
}
