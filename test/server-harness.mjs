import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { SCOPES, REDIRECT_URI, SPOTIFY_API } from "../companion/spotify.mjs";
import { performControl } from "../companion/control.mjs";
import { performQueueJump } from "../companion/queue-jump.mjs";
import { createStateReader } from "../companion/state-reader.mjs";
import { parseSpotifyRateLimit, spotifyRateLimitError } from "../companion/spotify-rate-limit.mjs";
import { allowWidgetOrigin } from "../companion/cors.mjs";

// Execute the actual HTTP handlers with injected network/storage boundaries.
// No port is bound, no filesystem or real credentials are accessed, no live
// Spotify request can escape this harness, and every clock is controlled.
const source = readFileSync(new URL("../companion/server.mjs", import.meta.url), "utf8")
  .replace(/^import .*;\r?$/gm, "");

export async function serverHarness(spotify) {
  let now = 100000;
  let handler;
  const calls = [];
  const bindings = [];
  const warnings = [];
  const key = "synthetic-test-pairing-key-0000000000000000000";
  class Clock extends Date { static now() { return now; } }
  await runInNewContext(`(async () => { ${source}\n })()`, {
    http: { createServer(callback) { handler = callback; return {
      listen(port, host, ready) { bindings.push({ port, host }); ready(); }
    }; } },
    fetch: async (url, { method = "GET" } = {}) => {
      if (url === "https://accounts.spotify.com/api/token") return new Response(JSON.stringify({
        access_token: "synthetic-access", expires_in: 3600
      }));
      if (!url.startsWith(SPOTIFY_API)) throw new Error("Unexpected network destination");
      const path = url.slice(SPOTIFY_API.length);
      calls.push({ path, method });
      return spotify(path, method);
    },
    randomBytes, createHash, join, homedir: () => "synthetic-home",
    readFile: async () => key,
    writeFile: async () => { throw new Error("Unexpected storage write"); }, mkdir: async () => {},
    createRefreshTokenStore: () => ({ supported: true, load: async () => "synthetic-refresh", clear: async () => {} }),
    createStateReader: request => createStateReader(request, { now: () => now }),
    performControl: (action, value, request) => performControl(action, value, request, async () => {}),
    performQueueJump: (selection, request) => performQueueJump(selection, request, { wait: async () => {} }),
    SCOPES, REDIRECT_URI, SPOTIFY_API, parseSpotifyRateLimit, spotifyRateLimitError, allowWidgetOrigin,
    process: { env: { LOCALAPPDATA: "synthetic-appdata", SPOTIFY_CLIENT_ID: "synthetic-client" } },
    Date: Clock, Buffer, URL, URLSearchParams,
    console: { log() {}, error() {}, warn(...args) { warnings.push(args.join(" ")); } }
  });
  return {
    calls, bindings, warnings, advance(ms) { now += ms; },
    api(path = "/api/state", { method = "GET", body = {}, origin = "file://", paired = true } = {}) {
      return new Promise((resolve, reject) => {
        const headers = { host: "127.0.0.1:8765", origin, "content-type": "application/json" };
        if (paired) headers["x-widget-key"] = key;
        const req = { url: path, method, headers,
          async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
        const result = { status: 0, headers: {}, body: null };
        const res = { headersSent: false,
          setHeader(name, value) { result.headers[name] = value; },
          writeHead(status, values = {}) { result.status = status; Object.assign(result.headers, values); this.headersSent = true; },
          end(data) { try { result.body = data ? JSON.parse(data) : null; resolve(result); } catch (error) { reject(error); } }
        };
        handler(req, res);
      });
    }
  };
}

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
export const playback = (id = "a", playing = true) => ({
  item: { id, uri: "spotify:track:" + id, name: id, duration_ms: 180000, type: "track" },
  is_playing: playing, progress_ms: 1000, device: { id: "desktop", name: "Desktop" }
});
export const queue = (...ids) => ({ queue: ids.map(id => playback(id).item) });
