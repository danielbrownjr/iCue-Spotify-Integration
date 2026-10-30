import test from "node:test";
import assert from "node:assert/strict";
import { createStateReader, ACTIVE_PLAYBACK_TTL_MS, IDLE_PLAYBACK_TTL_MS, QUEUE_TTL_MS } from "../companion/state-reader.mjs";

function fixture() {
  let timestamp = 100000;
  const counts = { playback: 0, queue: 0 };
  const playback = {
    is_playing: true, progress_ms: 5000,
    item: { uri: "spotify:track:a", id: "a", name: "A", duration_ms: 180000 },
    device: { id: "desktop", name: "Desktop" }
  };
  const queue = { queue: [{ uri: "spotify:track:b", name: "B", type: "track", duration_ms: 180000 }] };
  let queueFailure = null;
  const reader = createStateReader(async (path) => {
    if (path === "/me/player") { counts.playback++; return structuredClone(playback); }
    if (path === "/me/player/queue") {
      counts.queue++;
      if (queueFailure) throw queueFailure;
      return structuredClone(queue);
    }
    throw new Error("Unexpected Spotify request " + path);
  }, { now: () => timestamp });
  return {
    counts, playback, queue, reader,
    advance(ms) { timestamp += ms; },
    setQueueFailure(value) { queueFailure = value; }
  };
}

test("continuous widget reads use at most one playing poll per 15s and one queue poll per 60s", async () => {
  const f = fixture();
  for (let i = 0; i < 60; i++) {
    await f.reader.readState();
    f.advance(1000);
  }
  assert.deepEqual(f.counts, { playback: 4, queue: 1 });
  assert.equal(ACTIVE_PLAYBACK_TTL_MS, 15000);
  assert.equal(QUEUE_TTL_MS, 60000);
  await f.reader.readState();
  assert.deepEqual(f.counts, { playback: 5, queue: 2 });
});

test("paused or absent playback slows polling to every 30 seconds", async () => {
  const f = fixture();
  f.playback.is_playing = false;
  for (let i = 0; i < 60; i++) {
    await f.reader.readState();
    f.advance(1000);
  }
  assert.equal(f.counts.playback, 2);
  assert.equal(IDLE_PLAYBACK_TTL_MS, 30000);
});

test("cached playback progress advances correctly without additional Spotify calls", async () => {
  const f = fixture();
  const first = await f.reader.readState();
  assert.equal(first.progressMs, 5000);
  f.advance(11000);
  const second = await f.reader.readState();
  assert.equal(second.progressMs, 16000);
  assert.equal(f.counts.playback, 1);
  f.playback.is_playing = false;
  f.reader.invalidate();
  const paused = await f.reader.readState();
  f.advance(11000);
  const pausedLater = await f.reader.readState();
  assert.equal(paused.progressMs, pausedLater.progressMs);
});

test("track changes force a fresh queue even inside its 60-second TTL", async () => {
  const f = fixture();
  await f.reader.readState();
  f.advance(15000);
  f.playback.item.uri = "spotify:track:b";
  f.playback.item.id = "b";
  await f.reader.readState();
  assert.deepEqual(f.counts, { playback: 2, queue: 2 });
});

test("commands invalidate both caches without sharing stale queued reads", async () => {
  const f = fixture();
  await f.reader.readState();
  f.reader.invalidate();
  await f.reader.readState();
  assert.deepEqual(f.counts, { playback: 2, queue: 2 });
});

test("concurrent readers share one request per endpoint", async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 12 }, () => f.reader.readState()));
  assert.deepEqual(f.counts, { playback: 1, queue: 1 });
});

test("queue failure does not create a playable snapshot and recovers on next read", async () => {
  const f = fixture();
  await f.reader.readState();
  f.advance(60000);
  f.setQueueFailure(new Error("Spotify quota exceeded"));
  const failed = await f.reader.readState();
  assert.match(failed.queueError, /quota exceeded/);
  assert.equal(failed.queueSnapshot, null);
  assert.equal(failed.queue.length, 1); // Old rows may be displayed, but cannot be acted on.
  f.setQueueFailure(null);
  const recovered = await f.reader.readState();
  assert.equal(recovered.queueError, null);
  assert.ok(recovered.queueSnapshot);
});

test("late responses from before a control do not repopulate invalidated caches", async () => {
  let resolveFirst;
  let requests = 0;
  let time = 10000;
  const reader = createStateReader(async (path) => {
    if (path === "/me/player") {
      requests++;
      if (requests === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return { is_playing: false, item: null, progress_ms: 0 };
    }
    return { queue: [] };
  }, { now: () => time });
  const originalRead = reader.readState();
  // Let the deferred request begin before invalidating it.
  await Promise.resolve();
  reader.invalidate();
  const newRead = await reader.readState();
  assert.equal(newRead.playing, false);
  resolveFirst({ is_playing: true, item: { uri: "spotify:track:old", name: "Old" }, progress_ms: 0 });
  await originalRead;
  time += 100;
  const latest = await reader.readState();
  assert.equal(latest.playing, false);
  assert.equal(requests, 2);
});
