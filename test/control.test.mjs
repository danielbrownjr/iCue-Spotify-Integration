import test from "node:test";
import assert from "node:assert/strict";
import { performControl } from "../companion/control.mjs";

test("duplicate play and pause do not send commands Spotify rejects", async () => {
  for (const action of ["play", "pause"]) {
    const calls = [];
    await performControl(action, undefined, async (path, method) => {
      calls.push([path, method]);
      if (method) throw Object.assign(new Error("Restriction violated"), { status: 403 });
      return { is_playing: action === "play" };
    });
    assert.deepEqual(calls, [["/me/player", undefined]]);
  }
});

test("play and pause still change the opposite playback state", async () => {
  for (const action of ["play", "pause"]) {
    const calls = [];
    await performControl(action, undefined, async (path, method) => {
      calls.push([path, method]);
      return method ? null : { is_playing: action !== "play" };
    });
    assert.deepEqual(calls, [["/me/player", undefined], ["/me/player/" + action, "PUT"]]);
  }
});

test("missing playback still attempts the command and preserves Spotify errors", async () => {
  const failure = Object.assign(new Error("Spotify returned HTTP 403"), { status: 403 });
  await assert.rejects(performControl("play", undefined, async (_path, method) => {
    if (!method) return null;
    throw failure;
  }, async () => {}), (error) => error === failure);
});

test("playback read failures are propagated without sending a command", async () => {
  const failure = Object.assign(new Error("Rate limited"), { status: 429 });
  let calls = 0;
  await assert.rejects(performControl("pause", undefined, async () => {
    calls++;
    throw failure;
  }), (error) => error === failure);
  assert.equal(calls, 1);
});

test("a denied state change remains a 403 error", async () => {
  const failure = Object.assign(new Error("Forbidden"), { status: 403 });
  await assert.rejects(performControl("pause", undefined, async (_path, method) => {
    if (!method) return { is_playing: true };
    throw failure;
  }, async () => {}), (error) => error === failure);
});

test("a rejected duplicate succeeds only after delayed playback confirms the state", async () => {
  for (const action of ["play", "pause"]) {
    let reads = 0;
    let writes = 0;
    const waits = [];
    await performControl(action, undefined, async (_path, method) => {
      if (method) {
        writes++;
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      }
      reads++;
      return { is_playing: reads >= 3 ? action === "play" : action !== "play" };
    }, async (ms) => { waits.push(ms); });
    assert.equal(writes, 1);
    assert.equal(reads, 3);
    assert.deepEqual(waits, [250, 500]);
  }
});

test("state rechecks are bounded and do not hide other errors", async () => {
  const failure = Object.assign(new Error("Forbidden"), { status: 403 });
  let reads = 0;
  await assert.rejects(performControl("pause", undefined, async (_path, method) => {
    if (method) throw failure;
    reads++;
    return { is_playing: true };
  }, async () => {}), (error) => error === failure);
  assert.equal(reads, 4);
  const rateLimit = Object.assign(new Error("Rate limited"), { status: 429 });
  await assert.rejects(performControl("pause", undefined, async (_path, method) => {
    if (method) throw rateLimit;
    return { is_playing: true };
  }, async () => { assert.fail("Must not recheck rate limits"); }), (error) => error === rateLimit);
});

test("other controls stay direct and invalid controls never reach Spotify", async () => {
  const calls = [];
  const request = async (...args) => { calls.push(args); };
  await performControl("next", undefined, request);
  assert.deepEqual(calls, [["/me/player/next", "POST"]]);
  await assert.rejects(performControl("volume", 101, request));
  assert.equal(calls.length, 1);
});
