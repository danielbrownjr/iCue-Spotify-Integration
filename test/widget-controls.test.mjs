import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const widgetSource = readFileSync(new URL("../widget/scripts/widget.js", import.meta.url), "utf8");

class FakeElement {
  constructor() {
    this.attributes = {};
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
      contains: (name) => this.classes.has(name)
    };
    this.hidden = false;
    this.textContent = "";
    this.value = "";
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  matches() { return false; }
  replaceChildren(...nodes) { this.children = nodes; }
  append(...nodes) { this.children = [...(this.children || []), ...nodes]; }
}

function dashboardHarness({ stateResponse } = {}) {
  let nowMs = Date.now();
  class FakeDate extends Date { static now() { return nowMs; } }
  let stateReads = 0;
  const intervals = new Map();
  const ids = ["art", "art-fallback", "status", "device", "title", "artist",
    "album", "play", "previous", "next", "shuffle", "repeat", "progress", "elapsed", "duration",
    "queue", "queue-count", "queue-warning", "volume", "volume-number", "repeat-one"];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const document = {
    getElementById: (id) => elements[id],
    createElement: () => new FakeElement(),
    documentElement: { style: { setProperty() {} } }
  };
  const state = {
    authenticated: true, active: true, playing: true, device: "Desktop",
    track: null, queue: [], progressMs: 0, repeat: "off",
    shuffle: false, volumePercent: 50
  };
  const commands = [];
  const fetch = async (url, options) => {
    if (url.endsWith("/api/state")) {
      stateReads++;
      if (stateResponse) return stateResponse(stateReads, { ...state });
      if (state.httpError) return {
        ok: false, status: state.httpError.status,
        json: async () => ({ error: state.httpError.error, retryAfterSeconds: state.httpError.retryAfterSeconds })
      };
      return { ok: true, status: 200, json: async () => ({ ...state }) };
    }
    if (url.endsWith("/api/queue-jump")) {
      commands.push({ action: "queue-jump", ...JSON.parse(options.body) });
      if (state.queueJumpError)
        return { ok: false, json: async () => ({ error: state.queueJumpError }) };
      return { ok: true, json: async () => ({ ok: true, skipped: 1 }) };
    }
    if (url.endsWith("/api/control")) {
      const command = JSON.parse(options.body);
      commands.push(command);
      if (state.controlError) return {
        ok: false, status: state.controlError.status,
        json: async () => ({ error: state.controlError.error, retryAfterSeconds: state.controlError.retryAfterSeconds })
      };
      if (command.action === "repeat") state.repeat = command.value;
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error("Unexpected URL " + url);
  };
  const window = { pairingKey: "local-test-key" };
  runInNewContext(widgetSource, { window, document, fetch,
    setInterval: (callback, ms) => { intervals.set(ms, callback); },
    setTimeout: (callback) => { callback(); return 1; }, Date: FakeDate, console });
  return { window, elements, state, commands, intervals,
    advance(ms) { nowMs += ms; },
    stateReads() { return stateReads; } };
}

async function settle() {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("repeat visual states show off, repeat all and repeat one distinctly", async () => {
  const { elements, state, window, advance } = dashboardHarness();
  await settle();

  assert.equal(elements.repeat.attributes["data-mode"], "off");
  assert.equal(elements.repeat.attributes["aria-label"], "Repeat off");
  assert.equal(elements.repeat.attributes["aria-pressed"], "false");
  assert.equal(elements["repeat-one"].hidden, true);
  assert.equal(elements.repeat.classes.has("selected"), false);

  state.repeat = "context";
  advance(15000);
  window.icueEvents.onDataUpdated();
  await settle();
  assert.equal(elements.repeat.attributes["data-mode"], "context");
  assert.equal(elements.repeat.attributes["aria-label"], "Repeat all");
  assert.equal(elements.repeat.attributes["aria-pressed"], "true");
  assert.equal(elements["repeat-one"].hidden, true);
  assert.equal(elements.repeat.classes.has("selected"), true);

  state.repeat = "track";
  advance(15000);
  window.icueEvents.onDataUpdated();
  await settle();
  assert.equal(elements.repeat.attributes["data-mode"], "track");
  assert.equal(elements.repeat.attributes["aria-label"], "Repeat one");
  assert.equal(elements["repeat-one"].hidden, false);
  assert.equal(elements.repeat.classes.has("selected"), true);
});

test("repeat touch advances off to all to one to off", async () => {
  const { elements, commands } = dashboardHarness();
  await settle();
  for (const value of ["context", "track", "off"]) {
    elements.repeat.listeners.get("click")();
    await settle();
    assert.equal(commands.at(-1).action, "repeat");
    assert.equal(commands.at(-1).value, value);
    assert.equal(elements.repeat.attributes["data-mode"], value);
  }
  assert.equal(commands.length, 3);
});

test("shuffle status does not claim to distinguish Smart Shuffle", async () => {
  const { elements, state, window, advance } = dashboardHarness();
  await settle();
  state.shuffle = true;
  advance(15000);
  window.icueEvents.onDataUpdated();
  await settle();
  assert.equal(elements.shuffle.attributes["aria-pressed"], "true");
  assert.match(elements.shuffle.title, /Smart Shuffle status is not available/);
});

test("the first five queued rows expose a play-over-number action, deeper entries stay disabled", async () => {
  const { elements, state, window, commands, advance } = dashboardHarness();
  const snapshot = "s".repeat(43);
  state.queueSnapshot = snapshot;
  state.queue = Array.from({ length: 7 }, (_, i) => ({
    uri: "spotify:track:" + i, title: "Queued song " + (i + 1),
    artist: "Artist", durationMs: 123000
  }));
  advance(15000);
  window.icueEvents.onDataUpdated();
  await settle();
  const rows = elements.queue.children;
  assert.equal(rows.length, 7);
  const buttonFor = (i) => rows[i].children[0].children[0];
  assert.equal(buttonFor(0).disabled, false);
  assert.equal(buttonFor(4).disabled, false);
  assert.equal(buttonFor(5).disabled, true);
  assert.match(buttonFor(2).attributes["aria-label"], /Play Queued song 3 from queue/);
  assert.equal(buttonFor(2).children[0].textContent, "03");
  assert.equal(buttonFor(2).children[1].textContent, "▶");
  buttonFor(2).listeners.get("click")();
  await settle();
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], { action: "queue-jump", index: 2, snapshot });
});

test("missing current queue snapshot disables jump actions", async () => {
  const { elements, state, window, commands, advance } = dashboardHarness();
  state.queue = [{ uri: "spotify:track:test", title: "Test" }];
  state.queueSnapshot = null;
  advance(15000);
  window.icueEvents.onDataUpdated();
  await settle();
  const button = elements.queue.children[0].children[0].children[0];
  assert.equal(button.disabled, true);
  button.listeners.get("click")();
  await settle();
  assert.equal(commands.length, 0);
});

test("queue jump failure stays visible across automatic playback refreshes", async () => {
  const { elements, state, window, commands, advance } = dashboardHarness();
  state.queueSnapshot = "s".repeat(43);
  state.queue = [{ uri: "spotify:track:first", title: "First", artist: "Artist" }];
  state.queueJumpError = "After Next command 1/3, Spotify reported original queue song #3 instead of queue song #1. Stopped safely.";
  advance(15000);
  window.icueEvents.onDataUpdated();
  await settle();
  elements.queue.children[0].children[0].children[0].listeners.get("click")();
  await settle();

  assert.equal(commands.length, 1);
  assert.equal(elements["queue-warning"].hidden, false);
  assert.match(elements["queue-warning"].textContent, /After Next command 1\/3/);
  assert.match(elements.status.textContent, /Queue jump stopped/);

  // iCUE polls state every 3.5s. Error must not flash away on the next poll.
  advance(15000);
  window.icueEvents.onDataUpdated();
  await settle();
  assert.equal(elements["queue-warning"].hidden, false);
  assert.match(elements["queue-warning"].textContent, /After Next command 1\/3/);
  assert.equal(elements.status.classes.has("warn"), true);
});

test("frequent iCUE events and timer ticks do not bypass 15-second local polling", async () => {
  const f = dashboardHarness();
  await settle();
  assert.equal(f.stateReads(), 1);
  assert.ok(f.intervals.has(15000));
  assert.ok(f.intervals.has(1000));
  for (let i = 0; i < 2000; i++) f.window.icueEvents.onDataUpdated();
  await settle();
  assert.equal(f.stateReads(), 1);
  f.advance(14999);
  f.intervals.get(15000)();
  await settle();
  assert.equal(f.stateReads(), 1);
  f.advance(1);
  f.intervals.get(15000)();
  await settle();
  assert.equal(f.stateReads(), 2);
});

test("an earlier successful poll cannot clear a command's active quota warning", async () => {
  let releasePoll;
  const f = dashboardHarness({ stateResponse: (count, state) => {
    const response = { ok: true, status: 200, json: async () => state };
    return count === 2 ? new Promise(resolve => { releasePoll = () => resolve(response); }) : response;
  } });
  await settle();
  f.advance(15000);
  f.window.icueEvents.onDataUpdated();
  await settle();
  f.state.controlError = { status: 429, retryAfterSeconds: 100, error: "Spotify quota exceeded" };
  f.elements.play.listeners.get("click")();
  await settle();
  assert.match(f.elements.status.textContent, /quota exceeded/);
  releasePoll();
  await settle();
  assert.match(f.elements.status.textContent, /quota exceeded/, "a stale successful poll must not show LIVE during cooldown");
  assert.equal(f.stateReads(), 2);
});

test("429 Retry-After prevents local fetches from event storms or forced refresh", async () => {
  const f = dashboardHarness();
  await settle();
  f.state.httpError = {
    status: 429, error: "Spotify Development Mode API quota exceeded",
    retryAfterSeconds: 100
  };
  f.advance(15000);
  f.window.icueEvents.onDataUpdated();
  await settle();
  assert.equal(f.stateReads(), 2);
  assert.match(f.elements.status.textContent, /quota exceeded/);
  f.state.httpError = null;
  f.advance(99000);
  for (let i = 0; i < 20; i++) f.window.icueEvents.onDataUpdated();
  f.intervals.get(15000)();
  await settle();
  assert.equal(f.stateReads(), 2);
  f.advance(1000);
  f.intervals.get(15000)();
  await settle();
  assert.equal(f.stateReads(), 3);
});
