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

test("queue failure does not create a playable snapshot and recovers after retry delay", async () => {
  const f = fixture();
  await f.reader.readState();
  f.advance(60000);
  f.setQueueFailure(new Error("Spotify quota exceeded"));
  const failed = await f.reader.readState();
  assert.match(failed.queueError, /quota exceeded/);
  assert.equal(failed.queueSnapshot, null);
  assert.equal(failed.queue.length, 1); // Old rows may be displayed, but cannot be acted on.
  f.setQueueFailure(null);
  f.advance(15000);
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
  const originalResult = await originalRead;
  assert.equal(originalResult.playing, false, "superseded caller must not receive pre-control playback");
  time += 100;
  const latest = await reader.readState();
  assert.equal(latest.playing, false);
  assert.equal(requests, 2);
});

test("a queue 429 propagates its retry delay instead of returning LIVE playback", async () => {
  const f = fixture();
  f.setQueueFailure(Object.assign(new Error("Quota exceeded"), { status: 429, retryAfterSeconds: 90 }));
  await assert.rejects(f.reader.readState(), { status: 429, retryAfterSeconds: 90 });
});

test("failed queue reads are budgeted across sustained multiple clients", async () => {
  const f = fixture();
  f.setQueueFailure(new Error("Spotify returned HTTP 503"));
  for (let i = 0; i < 100; i++) {
    await Promise.all(Array.from({ length: 8 }, () => f.reader.readState()));
    f.advance(100);
  }
  assert.equal(f.counts.queue, 1, "a failed read must not permit a hot retry loop");
});

test("old pending queue does not cross a device change with the same song", async () => {
  let now = 100000;
  let resolveOldQueue;
  let queueReads = 0;
  let device = "old-device";
  const reader = createStateReader(async (path) => {
    if (path === "/me/player") return {
      is_playing: true, item: { uri: "spotify:track:same", name: "Same", duration_ms: 180000 },
      device: { id: device, name: device }, progress_ms: 1000
    };
    queueReads++;
    if (queueReads === 1) return new Promise(resolve => { resolveOldQueue = resolve; });
    return { queue: [{ uri: "spotify:track:new", name: "New", type: "track" }] };
  }, { now: () => now });
  const old = reader.readState();
  while (!resolveOldQueue) await new Promise(resolve => setImmediate(resolve));
  device = "new-device";
  now += 15000;
  const latest = reader.readState();
  await new Promise(resolve => setImmediate(resolve));
  resolveOldQueue({ queue: [{ uri: "spotify:track:old", name: "Old", type: "track" }] });
  const [first, second] = await Promise.all([old, latest]);
  assert.equal(first.device, "new-device");
  assert.equal(second.device, "new-device");
  assert.equal(first.queue[0].title, "New");
  assert.equal(second.queue[0].title, "New");
  assert.equal(queueReads, 2);
});

test("progress is capped at duration and neither paused time nor backward clocks advance it", async () => {
  const f = fixture();
  f.playback.progress_ms = 175000;
  await f.reader.readState();
  f.advance(14000);
  assert.equal((await f.reader.readState()).progressMs, 180000);
  f.reader.invalidate();
  f.playback.is_playing = false;
  const paused = await f.reader.readState();
  f.advance(10000);
  assert.equal((await f.reader.readState()).progressMs, paused.progressMs);
  f.reader.invalidate();
  f.playback.is_playing = true;
  const playing = await f.reader.readState();
  f.advance(-1000);
  assert.equal((await f.reader.readState()).progressMs, playing.progressMs);
});

test("cached failures recover only after their budget expires", async () => {
  let now = 100000;
  let fail = true;
  let calls = 0;
  const reader = createStateReader(async path => {
    if (path === "/me/player") {
      calls++;
      if (fail) throw new Error("Spotify returned HTTP 503");
      return { is_playing: false };
    }
    return { queue: [] };
  }, { now: () => now });
  for (let i = 0; i < 50; i++) await assert.rejects(reader.readState(), /503/);
  assert.equal(calls, 1);
  fail = false;
  now += 14999;
  await assert.rejects(reader.readState(), /503/);
  now++;
  assert.equal((await reader.readState()).active, false);
  assert.equal(calls, 2);
});

test("a stale rejection after invalidation cannot replace the new state with an error", async () => {
  let rejectOld;
  let reads = 0;
  const reader = createStateReader(async path => {
    if (path === "/me/player") {
      if (++reads === 1) return new Promise((_resolve, reject) => { rejectOld = reject; });
      return { is_playing: false, progress_ms: 1234 };
    }
    return { queue: [] };
  });
  const pending = reader.readState();
  await Promise.resolve();
  reader.invalidate();
  const fresh = await reader.readState();
  rejectOld(new Error("Old request failed"));
  assert.equal((await pending).playing, fresh.playing);
  assert.equal(reads, 2);
});

test("a failed new-track queue does not reuse the previous track's rows", async () => {
  const f = fixture();
  await f.reader.readState();
  f.advance(15000);
  f.playback.item.uri = "spotify:track:new";
  f.setQueueFailure(new Error("queue offline"));
  const state = await f.reader.readState();
  assert.equal(state.track.uri, "spotify:track:new");
  assert.deepEqual(state.queue, []);
  assert.equal(state.queueSnapshot, null);
});

test("a superseded promise finishing cannot release the new pending-read ownership", async () => {
  const releases = [];
  let reads = 0;
  const reader = createStateReader(async path => {
    if (path === "/me/player") {
      reads++;
      return new Promise(resolve => releases.push(resolve));
    }
    return { queue: [] };
  });
  const old = reader.readState();
  await Promise.resolve();
  reader.invalidate();
  const latest = reader.readState();
  await Promise.resolve();
  releases[0]({ is_playing: true });
  await new Promise(resolve => setImmediate(resolve));
  const third = reader.readState();
  await Promise.resolve();
  assert.equal(reads, 2);
  releases[1]({ is_playing: false });
  assert.ok((await Promise.all([old, latest, third])).every(state => state.playing === false));
});
