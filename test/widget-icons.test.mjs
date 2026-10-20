import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../widget/index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../widget/scripts/widget.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../widget/styles/widget.css", import.meta.url), "utf8");

test("transport controls have vector icons instead of platform-dependent glyphs", () => {
  for (const id of ["previous", "play", "next", "shuffle", "repeat"]) {
    const start = html.indexOf('id="' + id + '"');
    assert.ok(start >= 0, "missing button: " + id);
    const end = html.indexOf("</button>", start);
    assert.ok(end > start);
    const control = html.slice(start, end);
    assert.match(control, /<svg /);
    assert.match(control, /aria-hidden="true"/);
    assert.doesNotMatch(control, /⏮|⏭|Ⅱ/);
  }
});

test("play/pause icon switches without replacing SVG DOM", () => {
  assert.match(html, /class="control-icon icon-play"/);
  assert.match(html, /class="control-icon icon-pause"/);
  assert.match(js, /elements\.play\.setAttribute\("data-playing", String\(!!data\.playing\)\)/);
  assert.doesNotMatch(js, /elements\.play\.textContent\s*=/);
  assert.match(css, /#play\[data-playing="true"\] \.icon-play/);
  assert.match(css, /#play\[data-playing="true"\] \.icon-pause/);
});
