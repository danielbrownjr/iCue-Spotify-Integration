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

function dashboardHarness() {
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
      return { ok: true, json: async () => ({ ...state }) };
    }
    if (url.endsWith("/api/control")) {
      const command = JSON.parse(options.body);
      commands.push(command);
      if (command.action === "repeat") state.repeat = command.value;
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error("Unexpected URL " + url);
  };
  const window = { pairingKey: "local-test-key" };
  runInNewContext(widgetSource, { window, document, fetch, setInterval() {},
    setTimeout: (callback) => { callback(); return 1; }, Date, console });
  return { window, elements, state, commands };
}

async function settle() {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("repeat visual states show off, repeat all and repeat one distinctly", async () => {
  const { elements, state, window } = dashboardHarness();
  await settle();

  assert.equal(elements.repeat.attributes["data-mode"], "off");
  assert.equal(elements.repeat.attributes["aria-label"], "Repeat off");
  assert.equal(elements.repeat.attributes["aria-pressed"], "false");
  assert.equal(elements["repeat-one"].hidden, true);
  assert.equal(elements.repeat.classes.has("selected"), false);

  state.repeat = "context";
  window.icueEvents.onDataUpdated();
  await settle();
  assert.equal(elements.repeat.attributes["data-mode"], "context");
  assert.equal(elements.repeat.attributes["aria-label"], "Repeat all");
  assert.equal(elements.repeat.attributes["aria-pressed"], "true");
  assert.equal(elements["repeat-one"].hidden, true);
  assert.equal(elements.repeat.classes.has("selected"), true);

  state.repeat = "track";
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
  const { elements, state, window } = dashboardHarness();
  await settle();
  state.shuffle = true;
  window.icueEvents.onDataUpdated();
  await settle();
  assert.equal(elements.shuffle.attributes["aria-pressed"], "true");
  assert.match(elements.shuffle.title, /Smart Shuffle status is not available/);
});
