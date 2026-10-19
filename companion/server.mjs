import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { SCOPES, REDIRECT_URI, SPOTIFY_API, normalizePlayback, spotifyControl } from "./spotify.mjs";

const HOST = "127.0.0.1";
const PORT = 8765;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "30545ff0123e4db089d85774cde21c05";
const CONFIG_DIR = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "iCueSpotifyIntegration")
  : join(homedir(), ".icue-spotify");
let pairingKey;
let credentials = null;
let authRequest = null;
let playbackCache = { expires: 0, value: null };
let queueCache = { expires: 0, value: null };
let spotifyBackoffUntil = 0;
let lastArtwork = null;

function base64url(bytes) { return Buffer.from(bytes).toString("base64url"); }
function randomString() { return base64url(randomBytes(32)); }

async function loadPairingKey() {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const file = join(CONFIG_DIR, "pairing-key");
  try {
    pairingKey = (await readFile(file, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{40,}$/.test(pairingKey)) throw new Error("Invalid pairing key");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    pairingKey = randomString();
    await writeFile(file, pairingKey + "\n", { flag: "wx", mode: 0o600 });
  }
}

function reply(res, status, data, headers = {}) {
  const json = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(json), ...headers });
  res.end(json);
}

function escapeHtml(str) {
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function html(res, title, message) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff" });
  res.end("<!doctype html><html><meta charset=utf-8><title>" + escapeHtml(title) +
    "</title><body style='background:#101010;color:#eee;font:18px system-ui;padding:3rem'><h1>" +
    escapeHtml(title) + "</h1><p>" + escapeHtml(message) + "</p></body></html>");
}

function startLogin(res) {
  authRequest = { state: randomString(), verifier: randomString(), created: Date.now() };
  const challenge = base64url(createHash("sha256").update(authRequest.verifier).digest());
  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", authRequest.state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  res.writeHead(302, { Location: url.toString(), "Cache-Control": "no-store" });
  res.end();
}

async function exchangeToken(parameters) {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters)
  });
  if (!response.ok) throw new Error("Spotify token exchange returned HTTP " + response.status);
  return response.json();
}

async function callback(url, res) {
  if (!authRequest || Date.now() - authRequest.created > 600000 ||
      url.searchParams.get("state") !== authRequest.state) {
    return reply(res, 400, { error: "Expired or invalid OAuth state. Return to /connect." });
  }
  const verifier = authRequest.verifier;
  authRequest = null;
  const code = url.searchParams.get("code");
  if (!code) return reply(res, 400, { error: "Spotify authorization was not completed." });
  try {
    const tokens = await exchangeToken({ grant_type: "authorization_code", code,
      redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: verifier });
    if (!tokens.access_token || !tokens.refresh_token) throw new Error("Missing tokens");
    credentials = { access: tokens.access_token, refresh: tokens.refresh_token,
      expires: Date.now() + tokens.expires_in * 1000 };
    playbackCache.expires = queueCache.expires = 0;
    html(res, "Spotify connected", "You can close this tab. Your XENEON EDGE widget can now load the live queue.");
  } catch (error) {
    console.error("Spotify authorization failed:", error.message);
    reply(res, 502, { error: "Spotify authentication failed. Return to /connect and retry." });
  }
}

async function getAccessToken() {
  if (!credentials) throw Object.assign(new Error("Connect Spotify first"), { status: 401 });
  if (Date.now() < credentials.expires - 60000) return credentials.access;
  const tokens = await exchangeToken({ grant_type: "refresh_token",
    refresh_token: credentials.refresh, client_id: CLIENT_ID });
  if (!tokens.access_token) throw new Error("Token refresh failed");
  credentials = { access: tokens.access_token, refresh: tokens.refresh_token || credentials.refresh,
    expires: Date.now() + tokens.expires_in * 1000 };
  return credentials.access;
}

async function spotifyRequest(path, method = "GET") {
  if (Date.now() < spotifyBackoffUntil)
    throw Object.assign(new Error("Spotify rate-limited; retry later"), { status: 429 });
  const token = await getAccessToken();
  const response = await fetch(SPOTIFY_API + path, {
    method, headers: { Authorization: "Bearer " + token }
  });
  if (response.status === 429) {
    spotifyBackoffUntil = Date.now() + Math.max(1, Number(response.headers.get("retry-after")) || 10) * 1000;
  }
  if (response.status === 204) return null;
  if (!response.ok) throw Object.assign(new Error("Spotify returned HTTP " + response.status),
    { status: response.status });
  if (method !== "GET") return null;
  return response.json();
}

async function cached(cache, lifetime, read) {
  if (Date.now() < cache.expires) return cache.value;
  // Do not flood Spotify when the widget refreshes or multiple clients are open.
  if (!cache.pending) cache.pending = read().then((value) => {
    cache.value = value;
    cache.expires = Date.now() + lifetime;
    return value;
  }).finally(() => { cache.pending = null; });
  return cache.pending;
}

async function readState() {
  if (!credentials) return { authenticated: false, queue: [], active: false };
  const playback = await cached(playbackCache, 3000, () => spotifyRequest("/me/player"));
  let queue, queueError = null;
  try {
    queue = await cached(queueCache, 15000, () => spotifyRequest("/me/player/queue"));
  } catch (error) {
    queueError = error.message;
    queue = queueCache.value;
  }
  const state = normalizePlayback(playback, queue);
  state.queueError = queueError;
  const art = state.track?.image;
  if (art && art.startsWith("https://")) lastArtwork = art;
  return state;
}

function allowWidgetOrigin(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== "null" && origin !== "http://127.0.0.1:8765") return false;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Widget-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return true;
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString("utf8");
    if (body.length > 2048) throw Object.assign(new Error("Body too large"), { status: 413 });
  }
  return JSON.parse(body);
}

async function serveArt(res) {
  if (!lastArtwork) return reply(res, 404, { error: "No cover artwork" });
  const url = new URL(lastArtwork);
  if (url.protocol !== "https:" || !["i.scdn.co", "image-cdn-ak.spotifycdn.com"].includes(url.hostname))
    return reply(res, 404, { error: "Artwork unavailable" });
  const response = await fetch(url);
  if (!response.ok) return reply(res, 502, { error: "Artwork fetch failed" });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 2000000) return reply(res, 502, { error: "Artwork too large" });
  res.writeHead(200, { "Content-Type": response.headers.get("content-type") || "image/jpeg",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(bytes);
}

async function handle(req, res) {
  if (req.headers.host !== HOST + ":" + PORT)
    return reply(res, 403, { error: "Invalid host" });
  const url = new URL(req.url, "http://" + HOST + ":" + PORT);
  if (url.pathname === "/connect" && req.method === "GET") return startLogin(res);
  if (url.pathname === "/callback" && req.method === "GET") return callback(url, res);
  if (url.pathname === "/" && req.method === "GET")
    return html(res, "iCUE Spotify Integration", "Visit /connect to authorize Spotify. Pairing key is printed in the companion terminal.");
  if (!allowWidgetOrigin(req, res)) return reply(res, 403, { error: "Origin not allowed" });
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (url.pathname === "/api/art" && req.method === "GET") return serveArt(res);
  if (req.headers["x-widget-key"] !== pairingKey)
    return reply(res, 401, { error: "Widget pairing key missing or incorrect" });
  if (url.pathname === "/api/state" && req.method === "GET") {
    try { return reply(res, 200, await readState()); }
    catch (error) { return reply(res, error.status || 502, { error: error.message }); }
  }
  if (url.pathname === "/api/control" && req.method === "POST") {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return reply(res, 415, { error: "JSON required" });
    try {
      const body = await readBody(req);
      const operation = spotifyControl(body.action, body.value);
      await spotifyRequest(operation.path, operation.method);
      playbackCache.expires = queueCache.expires = 0;
      return reply(res, 200, { ok: true });
    } catch (error) {
      return reply(res, error.status || 400, { error: error.message });
    }
  }
  return reply(res, 404, { error: "Not found" });
}

await loadPairingKey();
http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("Request failed:", error.message);
    if (!res.headersSent) reply(res, 500, { error: "Internal companion error" });
    else res.end();
  });
}).listen(PORT, HOST, () => {
  console.log("iCUE Spotify companion: http://" + HOST + ":" + PORT);
  console.log("Connect Spotify: http://" + HOST + ":" + PORT + "/connect");
  console.log("Widget pairing key: " + pairingKey);
  console.log("Tokens are memory-only and never written to disk. Reconnect after restarting.");
});
