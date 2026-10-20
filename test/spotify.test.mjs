import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTrack, normalizePlayback, spotifyControl, SCOPES, REDIRECT_URI } from "../companion/spotify.mjs";

test("scopes are limited to player read and controls", () => {
  assert.deepEqual(SCOPES, ["user-read-playback-state", "user-modify-playback-state"]);
  assert.equal(REDIRECT_URI, "http://127.0.0.1:8765/callback");
});

test("normalizes a real track and queue items", () => {
  const track = { id: "id1", name: "Song", duration_ms: 133000,
    artists: [{ name: "A" }, { name: "B" }],
    album: { name: "Album", images: [{ url: "https://i.scdn.co/image/a" }] } };
  const result = normalizePlayback({ item: track, is_playing: true, progress_ms: 20000,
    device: { name: "Desktop", volume_percent: 37 }, shuffle_state: true, repeat_state: "off" },
  { queue: [track] });
  assert.equal(result.track.artist, "A, B");
  assert.equal(result.queue[0].durationMs, 133000);
  assert.equal(result.volumePercent, 37);
  assert.equal(result.playing, true);
  assert.equal(result.track.image, "https://i.scdn.co/image/a");
});

test("empty player, episodes, and malformed queue do not crash", () => {
  assert.equal(normalizeTrack(null), null);
  assert.deepEqual(normalizePlayback(null, { queue: null }).queue, []);
  assert.equal(normalizeTrack({ name: "Episode", show: { name: "Show", publisher: "Maker" } }).artist, "Maker");
});

test("control whitelist rejects unsafe or malformed commands", () => {
  assert.deepEqual(spotifyControl("next"), { method: "POST", path: "/me/player/next" });
  assert.deepEqual(spotifyControl("seek", 1234), { method: "PUT", path: "/me/player/seek?position_ms=1234" });
  assert.throws(() => spotifyControl("volume", 101));
  assert.throws(() => spotifyControl("seek", -1));
  assert.throws(() => spotifyControl("shuffle", "true"));
  assert.throws(() => spotifyControl("delete"), /Unsupported/);
});
