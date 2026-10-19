# iCUE Spotify Integration

A touch-friendly Spotify Now Playing + **actual queue** widget for the Corsair XENEON EDGE, designed for a **medium horizontal 840×696 iCUE dashboard tile**. The desktop companion runs on Windows at 127.0.0.1:8765. This is a **work-in-progress** and has not yet been tested on the actual device.

## Prerequisites

- Spotify Premium account with a Spotify Developer application.
- Windows with Spotify playing on an active Spotify Connect device.
- Node.js 22 or later (no npm dependencies needed to run the companion).
- iCUE 5.52+ for Widget API 1.9.0 permissions and a XENEON EDGE.
- iCUE Widget CLI, optional until packaging: npm install -g icuewidget-cli.

## Spotify Developer setup

Create a Spotify **Web API** app at https://developer.spotify.com/dashboard. Add this exact redirect URI:

    http://127.0.0.1:8765/callback

The app uses Spotify Authorization Code + PKCE. Its **Client ID is a public identifier**. There is no Client Secret. The default Client ID is the one registered for this repository; override it with the SPOTIFY_CLIENT_ID environment variable if you fork.

Requested scopes: user-read-playback-state and user-modify-playback-state. The queue endpoint can be read with the first scope.

## First run (Windows PowerShell)

1. Open a terminal in this repository.
2. Run: node companion/server.mjs
3. The terminal shows a randomly generated **Widget pairing key** (saved under your local AppData folder, NOT the repository).
4. Open http://127.0.0.1:8765/connect in your normal browser and authorize Spotify.
5. Install/package the widget. In its iCUE settings, paste the companion pairing key into **Pairing key**.
6. Position the widget in a medium horizontal slot on the XENEON EDGE.

The companion **keeps Spotify tokens only in memory**. Restarting it requires revisiting /connect and reauthorizing. This is deliberate for the initial development slice. Later we can provide OS-protected token persistence and startup registration.

Run automated tests: npm test

If the CLI is installed:

    icuewidget validate widget
    icuewidget package widget

The resulting .icuewidget can then be imported into iCUE. We have not physically tested the package on the XENEON EDGE yet.

## Widget behavior

Shows cover artwork, title, artists, album, elapsed/duration, queue, active device, volume, shuffle and repeat. Tap controls or seek on the progress bar. The widget polls playback about every 3.5 seconds; the companion caches playback for 3 seconds and the queue for 15 seconds. API rate-limit responses are respected with backoff. A pending queue/API problem is shown as a warning rather than quietly displaying a fabricated queue.

The widget uses one narrowly scoped network permission:

- URL: 127.0.0.1 port 8765 (local companion only).

It does **not** request broad internet access, file permissions, microphone, or screen capture. Album art is proxied through the loopback companion rather than giving the widget unrestricted Spotify CDN access.

## Security boundaries

- Never commit Spotify access/refresh tokens, OAuth codes, local pairing keys or client secrets.
- The companion listens only on 127.0.0.1, checks the Host and browser Origin headers and requires X-Widget-Key for reading playback state or issuing commands. The key is generated locally, never committed, and must be treated as a local capability token.
- The companion's OAuth callback validates a one-time state and PKCE code verifier.
- It accepts only whitelisted transport commands, validates parameters and enforces JSON content type for mutations.
- CORS allows file-widget ("null") origins and the local companion origin, not arbitrary websites. Since sandboxed pages can also have a null origin, the independent pairing key is essential.
- Token storage is intentionally **memory-only** for this first release candidate.
- This project is personal/noncommercial. Spotify terms, API availability and development-mode quotas apply.

## Known limitations

- Requires a running local companion; automatic Windows startup is not yet implemented.
- iCUE display, permission prompt, widget package and touch behavior **require physical testing**.
- No queue reorder/removal: Spotify does not offer general queue editing endpoints.
- Spotify reports some state asynchronously, so skip/pause may take a polling interval to update.
- Artwork URL host support is restricted to known Spotify CDN hosts and may need adjustment if Spotify changes hosts.
- No automatic Spotify device-selection UI in this first slice.

## Development policy

Follow the canonical General Standing Orders (GSO) for repository work. Make scoped changes on branches, validate the exact current head, do not add AI attribution, and do not merge, tag, publish, deploy or run persistent services on the user's workstation without explicit authorization.
