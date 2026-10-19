import test from "node:test";
import assert from "node:assert/strict";
import { MAX_QUEUE_JUMP, queueSnapshot, performQueueJump } from "../companion/queue-jump.mjs";

function fixture({ count = 8, duplicate = false, delays = 0, rejectMutationAt = null } = {}) {
  const songs = ["spotify:track:current", ...Array.from({ length: count }, (_, i) => "spotify:track:" + i)];
  if (duplicate) songs[2] = songs[1];
  let position = 0;
  let pendingNext = 0;
  let delayedReads = 0;
  let deviceId = "device-1";
  let writes = 0;
  const calls = [];
  const playback = () => ({
    is_playing: true, item: { uri: songs[position] },
    device: { id: deviceId, name: "Desktop" }
  });
  const queue = () => ({
    currently_playing: { uri: songs[position] },
    queue: songs.slice(position + 1).map((uri) => ({ uri, type: "track" }))
  });
  const request = async (path, method) => {
    calls.push([path, method]);
    if (method === "POST") {
      writes++;
      if (rejectMutationAt === writes)
        throw Object.assign(new Error("Spotify rate-limited"), { status: 429 });
      pendingNext++;
      delayedReads = delays;
      return null;
    }
    if (path === "/me/player") {
      if (pendingNext && delayedReads-- <= 0) {
        position += pendingNext;
        pendingNext = 0;
      }
      return playback();
    }
    if (path === "/me/player/queue") return queue();
    throw Error("Unexpected request " + path);
  };
  return {
    request,
    playback,
    queue,
    calls,
    get position() { return position; },
    get writes() { return writes; },
    moveToDevice: (id) => { deviceId = id; },
    setPosition: (next) => { position = next; },
    snapshot: () => queueSnapshot(playback(), queue())
  };
}

test("fingerprint binds current track, device, and only the first five queued URIs", () => {
  const f = fixture();
  const signature = f.snapshot();
  assert.match(signature, /^[A-Za-z0-9_-]{43}$/);
  const playback = f.playback();
  assert.notEqual(queueSnapshot({ ...playback, device: { id: "other" } }, f.queue()), signature);
  assert.notEqual(queueSnapshot({ ...playback, item: { uri: "other" } }, f.queue()), signature);
  const changedTail = f.queue();
  changedTail.queue[7].uri = "spotify:track:recommendation";
  assert.equal(queueSnapshot(playback, changedTail), signature);
  assert.equal(queueSnapshot(null, f.queue()), null);
});

test("one selected queue row consumes only the earlier entries, preserving suffix", async () => {
  const f = fixture();
  const result = await performQueueJump({ index: 2, snapshot: f.snapshot() }, f.request, {
    wait: async () => {}
  });
  assert.deepEqual(result, { ok: true, skipped: 3 });
  assert.equal(f.writes, 3);
  assert.equal(f.position, 3);
  assert.deepEqual(f.queue().queue.slice(0, 2).map((t) => t.uri),
    ["spotify:track:3", "spotify:track:4"]);
  assert.equal(f.calls.filter((c) => c[1] === "POST").length, 3);
});

test("first and fifth row selections succeed within bounded depth", async () => {
  for (const index of [0, MAX_QUEUE_JUMP - 1]) {
    const f = fixture();
    await performQueueJump({ index, snapshot: f.snapshot() }, f.request, { wait: async () => {} });
    assert.equal(f.writes, index + 1);
    assert.equal(f.position, index + 1);
  }
});

test("rejects malformed, too-deep, and stale requests without skipping", async () => {
  for (const selection of [null, { index: 5, snapshot: "x".repeat(43) },
    { index: 0, snapshot: "" }, { index: 1.5, snapshot: "x".repeat(43) }]) {
    const f = fixture();
    await assert.rejects(performQueueJump(selection, f.request), { status: 400 });
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(performQueueJump({ index: 2, snapshot: "x".repeat(43) }, f.request),
    { status: 409 });
  assert.equal(f.writes, 0);
});

test("rejects duplicate queued URIs because queue positions have no identity", async () => {
  const f = fixture({ duplicate: true });
  await assert.rejects(performQueueJump({ index: 2, snapshot: f.snapshot() }, f.request),
    /Repeated tracks/);
  assert.equal(f.writes, 0);
});

test("rejects non-track content in the intervening prefix", async () => {
  const f = fixture();
  const request = async (path, method) => {
    if (path === "/me/player/queue") {
      const q = f.queue();
      q.queue[1].type = "episode";
      return q;
    }
    return f.request(path, method);
  };
  await assert.rejects(performQueueJump({ index: 2, snapshot: f.snapshot() }, request), /Only available songs/);
  assert.equal(f.writes, 0);
});

test("waits for each confirmed skip before sending the next", async () => {
  const f = fixture({ delays: 2 });
  const waits = [];
  await performQueueJump({ index: 1, snapshot: f.snapshot() }, f.request, {
    wait: async (ms) => waits.push(ms)
  });
  assert.equal(f.writes, 2);
  assert.equal(f.position, 2);
  assert.deepEqual(waits, [300, 450, 650, 300, 450, 650]);
});

test("an unexpected device switch stops the jump before another mutation", async () => {
  const f = fixture();
  let switches = 0;
  await assert.rejects(performQueueJump({ index: 2, snapshot: f.snapshot() }, f.request, {
    wait: async () => {
      if (!switches++) f.moveToDevice("new-device");
    }
  }), /another device/);
  assert.equal(f.writes, 1);
});

test("an unexpected track change does not trigger further skips", async () => {
  const f = fixture();
  await assert.rejects(performQueueJump({ index: 3, snapshot: f.snapshot() }, f.request, {
    wait: async () => f.setPosition(7)
  }), /After Next command 1\/4.*original queue song #8.*instead of queue song #1/);
  assert.equal(f.writes, 1);
});

test("Spotify rejecting one next command aborts without retrying mutations", async () => {
  const f = fixture({ rejectMutationAt: 2 });
  await assert.rejects(performQueueJump({ index: 3, snapshot: f.snapshot() }, f.request, {
    wait: async () => {}
  }), { status: 429 });
  assert.equal(f.writes, 2);
  assert.equal(f.position, 1);
});

test("failure to confirm a skip stops after one mutation", async () => {
  const f = fixture({ delays: 999 });
  await assert.rejects(performQueueJump({ index: 4, snapshot: f.snapshot() }, f.request, {
    wait: async () => {}
  }), /did not confirm/);
  assert.equal(f.writes, 1);
});

test("refuses to skip when playback is paused, inactive or missing device", async () => {
  const f = fixture();
  for (const changes of [
    { is_playing: false },
    { device: null },
    { item: null }
  ]) {
    const request = async (path, method) => path === "/me/player"
      ? { ...f.playback(), ...changes }
      : f.request(path, method);
    await assert.rejects(performQueueJump({ index: 0, snapshot: f.snapshot() }, request), { status: 409 });
    assert.equal(f.writes, 0);
  }
});

test("a changed song after the selected target is detected before further skips", async () => {
  const f = fixture();
  const request = async (path, method) => {
    if (path === "/me/player/queue" && f.position > 0) {
      const altered = f.queue();
      altered.queue[5].uri = "spotify:track:unexpected-tail";
      return altered;
    }
    return f.request(path, method);
  };
  await assert.rejects(performQueueJump({ index: 3, snapshot: f.snapshot() }, request, {
    wait: async () => {}
  }), /did not confirm the remaining queue/);
  assert.equal(f.writes, 1);
});

test("new recommendations appended after the original queue are tolerated", async () => {
  const f = fixture();
  const request = async (path, method) => {
    if (path === "/me/player/queue" && f.position > 0) {
      const extended = f.queue();
      extended.queue.push({ uri: "spotify:track:new-recommendation", type: "track" });
      return extended;
    }
    return f.request(path, method);
  };
  const result = await performQueueJump({ index: 2, snapshot: f.snapshot() }, request, {
    wait: async () => {}
  });
  assert.equal(result.skipped, 3);
  assert.equal(f.position, 3);
});

test("playback can advance before the queue endpoint catches up without aborting multi-skip", async () => {
  const f = fixture();
  let queueLag = 0;
  let oldQueue = null;
  let lastPosition = 0;
  const request = async (path, method) => {
    if (method === "POST") {
      oldQueue = f.queue();
      await f.request(path, method);
      queueLag = 2;
      return null;
    }
    const result = await f.request(path, method);
    if (path === "/me/player/queue" && f.position > lastPosition) {
      lastPosition = f.position;
    }
    if (path === "/me/player/queue" && queueLag > 0 && f.position > 0) {
      queueLag--;
      return oldQueue;
    }
    return result;
  };
  const waits = [];
  const result = await performQueueJump({ index: 2, snapshot: f.snapshot() }, request, {
    wait: async (ms) => { waits.push(ms); }
  });
  assert.equal(result.skipped, 3);
  assert.equal(f.writes, 3);
  assert.equal(f.position, 3);
  assert.ok(waits.length > 3, "Each skip needed additional state confirmation");
});

test("persistent post-skip queue disagreement stops after one write, not five", async () => {
  const f = fixture();
  let fixedQueue = null;
  const request = async (path, method) => {
    if (path === "/me/player/queue" && f.position > 0)
      return fixedQueue;
    if (method === "POST") fixedQueue = f.queue();
    return f.request(path, method);
  };
  await assert.rejects(performQueueJump({ index: 4, snapshot: f.snapshot() }, request, {
    wait: async () => {}
  }), /did not confirm the remaining queue after 1 skip/);
  assert.equal(f.writes, 1);
  assert.equal(f.position, 1);
});

test("diagnostics identify when Spotify advances farther than the requested next song", async () => {
  const f = fixture();
  let skipped = false;
  const request = async (path, method) => {
    if (method === "POST") skipped = true;
    if (path === "/me/player" && skipped) {
      f.setPosition(3);
      skipped = false;
    }
    return f.request(path, method);
  };
  await assert.rejects(
    performQueueJump({ index: 4, snapshot: f.snapshot() }, request, { wait: async () => {} }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /After Next command 1\/5/);
      assert.match(error.message, /original queue song #4 instead of queue song #1/);
      assert.doesNotMatch(error.message, /spotify:track/);
      return true;
    }
  );
  assert.equal(f.writes, 1);
  assert.equal(f.position, 3);
});

test("diagnostics distinguish an unrelated Spotify track from a later queue entry", async () => {
  const f = fixture();
  let skipped = false;
  const request = async (path, method) => {
    if (method === "POST") skipped = true;
    if (path === "/me/player" && skipped) {
      skipped = false;
      return { ...f.playback(), item: { uri: "spotify:track:unrelated" } };
    }
    return f.request(path, method);
  };
  await assert.rejects(
    performQueueJump({ index: 2, snapshot: f.snapshot() }, request, { wait: async () => {} }),
    (error) => {
      assert.match(error.message, /After Next command 1\/3/);
      assert.match(error.message, /outside the original queue/);
      assert.doesNotMatch(error.message, /spotify:track/);
      return true;
    }
  );
  assert.equal(f.writes, 1);
});
