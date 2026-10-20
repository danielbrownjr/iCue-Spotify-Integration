import { spotifyControl } from "./spotify.mjs";

export async function performControl(action, value, request,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const operation = spotifyControl(action, value);
  if (action === "play" || action === "pause") {
    // Read Spotify directly: the poll cache can lag behind a recent touch.
    const playback = await request("/me/player");
    if (typeof playback?.is_playing === "boolean" &&
        playback.is_playing === (action === "play")) return;
  }
  try {
    await request(operation.path, operation.method);
  } catch (error) {
    if (error.status !== 403 || !["play", "pause"].includes(action)) throw error;
    // Spotify may reject a duplicate before its playback read reflects the
    // first command. Never resend it; confirm the requested state instead.
    for (const delay of [250, 500, 1000]) {
      await wait(delay);
      let playback;
      try { playback = await request("/me/player"); }
      catch { throw error; }
      if (typeof playback?.is_playing === "boolean" &&
          playback.is_playing === (action === "play")) return;
    }
    throw error;
  }
}
