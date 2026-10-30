import test from "node:test";
import assert from "node:assert/strict";
import { serverHarness, json, playback, queue } from "./server-harness.mjs";

test("real state handlers share the 5/minute budget across many old/new widget clients", async () => {
  const h = await serverHarness(path => json(path === "/me/player" ? playback() : queue("b")));
  for (let seconds = 0; seconds < 600; seconds++) {
    await Promise.all(Array.from({ length: 20 }, () => h.api()));
    h.advance(1000);
  }
  assert.equal(h.calls.filter(c => c.path === "/me/player").length, 40);
  assert.equal(h.calls.filter(c => c.path === "/me/player/queue").length, 10);
  assert.deepEqual(h.bindings, [{ port: 8765, host: "127.0.0.1" }]);
});

for (const failingPath of ["/me/player", "/me/player/queue"]) {
  test(`429 from ${failingPath} reaches first caller, blocks controls/polls, then recovers`, async () => {
    let fail = true;
    const h = await serverHarness(path => {
      if (fail && path === failingPath) return json({ error: {
        reason: "QUOTA_EXCEEDED", message: "private-upstream-detail"
      } }, 429, { "Retry-After": "60" });
      return json(path === "/me/player" ? playback() : queue("b"));
    });
    const first = await h.api();
    assert.equal(first.status, 429);
    assert.equal(first.body.retryAfterSeconds, 60);
    assert.match(first.body.error, /QUOTA_EXCEEDED/);
    assert.doesNotMatch(JSON.stringify(first), /private-upstream-detail|synthetic-access|synthetic-refresh/);
    const count = h.calls.length;
    for (let i = 0; i < 100; i++) assert.equal((await h.api()).status, 429);
    assert.equal((await h.api("/api/control", { method: "POST", body: { action: "next" } })).status, 429);
    h.advance(59000);
    assert.equal((await h.api()).body.retryAfterSeconds, 1);
    assert.equal(h.calls.length, count);
    fail = false;
    h.advance(1000);
    const recovered = await Promise.all(Array.from({ length: 50 }, () => h.api()));
    assert.ok(recovered.every(r => r.status === 200 && r.body.track.title === "a"));
    assert.equal(h.calls.length - count, 2, "one shared recovery read per endpoint");
  });
}

test("a concurrent control's 429 prevents an older successful state read being reported LIVE", async () => {
  let release;
  const h = await serverHarness((path, method) => {
    if (method === "POST") return json({ error: {} }, 429, { "Retry-After": "60" });
    if (path === "/me/player/queue") return new Promise(resolve => { release = () => resolve(json(queue("b"))); });
    return json(playback());
  });
  const pendingState = h.api();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.api("/api/control", { method: "POST", body: { action: "next" } })).status, 429);
  release();
  assert.equal((await pendingState).status, 429);
});

test("pairing and origin checks reject clients before any Spotify call", async () => {
  const h = await serverHarness(() => { throw new Error("Spotify must not be called"); });
  assert.equal((await h.api("/api/state", { paired: false })).status, 401);
  assert.equal((await h.api("/api/state", { origin: "https://example.com" })).status, 403);
  assert.equal(h.calls.length, 0);
});

test("idle handlers budget 3 calls/minute and an accepted control invalidates cached state", async () => {
  let playing = false;
  const h = await serverHarness((path, method) => {
    if (method === "PUT") { playing = true; return new Response(null, { status: 204 }); }
    return json(path === "/me/player" ? playback("a", playing) : queue("b"));
  });
  for (let i = 0; i < 120; i++) { await h.api(); h.advance(1000); }
  assert.equal(h.calls.length, 6);
  const control = await h.api("/api/control", { method: "POST", body: { action: "play" } });
  assert.equal(control.status, 200);
  assert.equal((await h.api()).body.playing, true);
});

test("rapid observed track transitions cause at most 8 background calls/minute", async () => {
  let id = 0;
  const h = await serverHarness(path => json(path === "/me/player" ? playback(String(id++)) : queue("next")));
  for (let i = 0; i < 600; i++) { await h.api(); h.advance(1000); }
  assert.equal(h.calls.length, 80);
});

test("a partially completed jump aborts on 429 and invalidates the prior cached queue", async () => {
  let current = "a";
  let writes = 0;
  const h = await serverHarness((path, method) => {
    if (method === "POST") {
      if (++writes === 2) return json({ error: { reason: "QUOTA_EXCEEDED" } }, 429, { "Retry-After": "30" });
      current = "b";
      return new Response(null, { status: 204 });
    }
    return json(path === "/me/player" ? playback(current) : current === "a" ? queue("b", "c", "d") : queue("c", "d"));
  });
  const before = await h.api();
  const result = await h.api("/api/queue-jump", {
    method: "POST", body: { index: 2, snapshot: before.body.queueSnapshot }
  });
  assert.equal(result.status, 429);
  assert.equal(writes, 2);
  const requests = h.calls.length;
  assert.equal((await h.api()).status, 429);
  assert.equal(h.calls.length, requests);
  h.advance(30000);
  const after = await h.api();
  assert.equal(after.body.track.id, "b");
  assert.equal(after.body.queue[0].id, "c");
  assert.equal(writes, 2, "no retry or extra Next after partial failure");
});

test("no active playback is successful idle state, not an API error", async () => {
  const h = await serverHarness(path => path === "/me/player"
    ? new Response(null, { status: 204 }) : json({ queue: null }));
  const result = await h.api();
  assert.equal(result.status, 200);
  assert.equal(result.body.active, false);
  assert.equal(result.body.playing, false);
  assert.deepEqual(result.body.queue, []);
  assert.equal(result.body.queueSnapshot, null);
});

test("ordinary controls cannot interrupt an in-progress verified queue jump", async () => {
  let release;
  let current = "a";
  const h = await serverHarness((path, method) => {
    if (method === "POST") return new Promise(resolve => {
      release = () => { current = "b"; resolve(new Response(null, { status: 204 })); };
    });
    return json(path === "/me/player" ? playback(current) : current === "a" ? queue("b", "c") : queue("c"));
  });
  const before = await h.api();
  const jump = h.api("/api/queue-jump", { method: "POST", body: { index: 0, snapshot: before.body.queueSnapshot } });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.api("/api/control", { method: "POST", body: { action: "next" } })).status, 409);
  assert.equal(h.calls.filter(c => c.method === "POST").length, 1);
  release();
  assert.equal((await jump).status, 200);
});
