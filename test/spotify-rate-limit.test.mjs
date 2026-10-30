import test from "node:test";
import assert from "node:assert/strict";
import { parseSpotifyRateLimit, spotifyRateLimitError } from "../companion/spotify-rate-limit.mjs";

test("Spotify quota response is classified and conservatively backed off without a header", async () => {
  const response = new Response(JSON.stringify({
    error: { status: 429, message: "Too many requests", reason: "QUOTA_EXCEEDED" }
  }), { status: 429 });
  const details = await parseSpotifyRateLimit(response);
  assert.deepEqual(details, { reason: "QUOTA_EXCEEDED", retryAfterSeconds: null, backoffSeconds: 300 });
  const error = spotifyRateLimitError(details, 21.2);
  assert.equal(error.status, 429);
  assert.match(error.message, /quota exceeded.*retry in about 22s/i);
});

test("normal 429 honors Retry-After and does not mislabel rate limit as quota", async () => {
  const response = new Response(JSON.stringify({ error: { status: 429, message: "rate limited" } }),
    { status: 429, headers: { "Retry-After": "75" } });
  assert.deepEqual(await parseSpotifyRateLimit(response),
    { reason: null, retryAfterSeconds: 75, backoffSeconds: 75 });
});

test("non-JSON 429 and invalid Retry-After are handled without leaking response text", async () => {
  const response = new Response("private upstream detail",
    { status: 429, headers: { "Retry-After": "nonsense" } });
  const details = await parseSpotifyRateLimit(response);
  assert.deepEqual(details, { reason: null, retryAfterSeconds: null, backoffSeconds: 10 });
  assert.doesNotMatch(spotifyRateLimitError(details, 10).message, /private upstream detail/);
});

test("oversized Retry-After is bounded and unknown reason is not forwarded", async () => {
  const response = new Response(JSON.stringify({ error: { reason: "INTERNAL_SECRET_VALUE" } }),
    { status: 429, headers: { "Retry-After": "999999999" } });
  assert.deepEqual(await parseSpotifyRateLimit(response),
    { reason: null, retryAfterSeconds: 604800, backoffSeconds: 604800 });
});
