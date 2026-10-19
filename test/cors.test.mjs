import test from "node:test";
import assert from "node:assert/strict";
import { allowWidgetOrigin } from "../companion/cors.mjs";

function check(origin) {
  const headers = {};
  const allowed = allowWidgetOrigin({ headers: { origin } }, {
    setHeader: (name, value) => { headers[name] = value; }
  });
  return { allowed, headers };
}

test("iCUE file origin passes CORS preflight with pairing header allowed", () => {
  const { allowed, headers } = check("file://");
  assert.equal(allowed, true);
  assert.equal(headers["Access-Control-Allow-Origin"], "file://");
  assert.equal(headers["Access-Control-Allow-Headers"], "Content-Type, X-Widget-Key");
  assert.equal(headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS");
  assert.equal(headers.Vary, "Origin");
});

test("existing local and opaque origins remain supported", () => {
  for (const origin of ["null", "http://127.0.0.1:8765"]) {
    const result = check(origin);
    assert.equal(result.allowed, true);
    assert.equal(result.headers["Access-Control-Allow-Origin"], origin);
  }
  assert.equal(check(undefined).allowed, true);
  assert.equal(check(undefined).headers["Access-Control-Allow-Origin"], undefined);
});

test("websites and lookalike file origins remain blocked", () => {
  for (const origin of ["https://example.com", "file://example.com", "file:///", "http://127.0.0.1:8766"]) {
    const result = check(origin);
    assert.equal(result.allowed, false);
    assert.equal(result.headers["Access-Control-Allow-Origin"], undefined);
  }
});
