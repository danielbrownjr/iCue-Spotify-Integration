# iCUE Spotify Integration

A touch-friendly Spotify Now Playing + **actual queue** widget for the Corsair XENEON EDGE, designed for a **medium horizontal 840×696 iCUE dashboard tile**. The desktop companion runs on Windows at 127.0.0.1:8765. The widget has been imported into iCUE and tested on the XENEON EDGE; see [Verified integration status](#verified-integration-status) for the exact scope of live testing.

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

The resulting `.icuewidget` can then be imported into iCUE. The original 0.1.0 widget was tested on a real XENEON EDGE. **To use the new repeat-mode indicators, build/import the 0.1.1 widget package**; the running companion and existing pairing key can remain unchanged.

## Widget behavior

Shows cover artwork, title, artists, album, elapsed/duration, queue, active device, volume, shuffle and repeat. Tap controls or seek on the progress bar. The widget polls playback about every 3.5 seconds; the companion caches playback for 3 seconds and the queue for 15 seconds. API rate-limit responses are respected with backoff. A pending queue/API problem is shown as a warning rather than quietly displaying a fabricated queue.

### Play an upcoming song without rebuilding the queue (v0.1.2)

The first **five** entries under **Up Next** have a play button in the index cell (the number swaps to ▶ on hover/focus, or is shown directly on touch devices). Selecting one advances through Spotify's actual queue using **one Next operation at a time**. The songs **before** the selected entry are consumed as skipped songs. The remaining entries are left to Spotify's native queue rather than copied into a new context.

Because Spotify's Web API does not support atomic jump-to-queue-position, this is a **best-effort, bounded operation**, not a guarantee of preserving every queue item. Each skip is verified against a fresh playback/queue read before another command is sent. The action aborts on a changed device, unexpected track or queue order, repeated URIs in the traversed prefix, Spotify rejection/rate-limit, or missing confirmation. Aborting after an accepted skip cannot undo earlier skips. The selected row must still match the widget's recent queue fingerprint; a stale view fails without altering playback.

- Requires active playing playback on a Spotify Connect device; paused or unavailable playback is rejected rather than silently starting a new context.
- Rows beyond the first five show their number but do not enable a queue jump. This deliberate cap limits API traffic and surprises.
- Another Spotify client can change the queue at any time. Spotify does not guarantee ordering of separate Player commands, even when requests are awaited; the companion checks state and stops on mismatches.
- No changes to the OAuth scopes, repeat/shuffle controls, companion startup, or native queue editing support. This is **skip-through**, not arbitrary native queue reordering.
- **Observed live defect (2026-10-19):** playing upcoming row 01 worked, but selecting row 03/05 advanced to 01 and then stopped with `Spotify switched tracks unexpectedly; stopped jumping.` The cause is not established yet. CI acceptance is not physical acceptance.
- **v0.1.3 diagnostic update:** reports which Next command and which original queue position (if any) Spotify reported. It does not bypass unexpected-track checks or send extra skips. Queue-jump errors remain visible in the widget warning area for 60 seconds instead of disappearing at the next 3.5-second refresh. Rebuild and import the new widget **and** restart the updated companion to test; older v0.1.2 UI does not display the persistent warning.
- Test a disposable queue with shuffle and repeat off; record the error text and actual playing song after tapping 03 or 05. Stop on partial failure, and do not immediately retry.

### Shuffle and repeat behavior

The repeat button cycles through **Off → Repeat all (`context`) → Repeat one (`track`) → Off**. Off is dimmed; repeat all is orange; repeat one is orange with a visible `1`. The button's accessibility label and tooltip identify the selected mode. These 0.1.1 indicators are code/CI-validated but still require confirmation on the real display after importing the updated widget.

Shuffle is a simple **on/off** control. Spotify's Web API reports `shuffle_state` as a boolean and the shuffle endpoint accepts only `true` or `false`. Spotify's app also has **Smart Shuffle**, but the API provides no distinct Smart Shuffle status or selection command. The widget therefore cannot accurately identify or cycle that third mode; use the Spotify app for Smart Shuffle.

The widget uses one narrowly scoped network permission:

- URL: 127.0.0.1 port 8765 (local companion only).

It does **not** request broad internet access, file permissions, microphone, or screen capture. Album art is proxied through the loopback companion rather than giving the widget unrestricted Spotify CDN access.

## Security boundaries

- Never commit Spotify access/refresh tokens, OAuth codes, local pairing keys or client secrets.
- The companion listens only on 127.0.0.1, checks the Host and browser Origin headers and requires X-Widget-Key for reading playback state or issuing commands. The key is generated locally, never committed, and must be treated as a local capability token.
- The companion's OAuth callback validates a one-time state and PKCE code verifier.
- It accepts only whitelisted transport commands, validates parameters and enforces JSON content type for mutations.
- CORS allows file-widget ("file://" and "null") origins and the local companion origin, not arbitrary websites. Since sandboxed pages can also have a null origin, the independent pairing key is essential.
- Token storage is intentionally **memory-only** for this first release candidate.
- This project is personal/noncommercial. Spotify terms, API availability and development-mode quotas apply.

## Verified integration status

As of 2026-10-19 (feature branch `feat/spotify-edge-dashboard`):

- **Verified live (user acceptance):** iCUE package installed on a physical XENEON EDGE; user confirms live Spotify playback, touchscreen play/pause without the previously reproduced intermittent 403, real queue scrolling without position resets, **seeking, volume, standard shuffle, and repeat playback behavior**. Repeat worked before the visual improvement, but its exact mode was not obvious on-screen.
- **Verified via local companion:** Spotify PKCE authentication and real playback/queue requests return successfully, with 20 actual upcoming tracks observed and album-art proxy responding successfully.
- **Automated checks:** the initial code head `4c57d512ecc2fc0afb61bcab875a31c2969d1aea` passed 15 tests and official iCUE validation (Actions `39237872256`). The subsequent 0.1.1 display update adds regression coverage for distinct repeat states, mode cycling, and Smart Shuffle status messaging; refer to the current PR head's Actions run for exact-head validation.
- **Not individually verified on hardware:** newly introduced repeat-mode visual indicators in 0.1.1, complete layout/readability, disconnect/recovery scenarios, and OAuth token refresh. Behavioral repeat, seek, volume and shuffle have been user-confirmed.
- **Runtime constraint:** the companion must keep running; its Spotify access/refresh tokens are memory-only, so restarting it requires Spotify sign-in again. The locally stored pairing key remains valid.

## Known limitations

- Requires a running local companion; automatic Windows startup is not yet implemented.
- Touch play/pause, queue scrolling, seeking, volume, standard shuffle, and repeat behavior are user-confirmed on the XENEON EDGE. The new 0.1.1 repeat indicator still needs physical visual acceptance. Recovery behavior and actual token refresh have **not** been individually verified.
- No queue reorder/removal: Spotify does not offer general queue editing endpoints.
- Spotify reports some state asynchronously, so skip/pause may take a polling interval to update.
- Artwork URL host support is restricted to known Spotify CDN hosts and may need adjustment if Spotify changes hosts.
- No automatic Spotify device-selection UI in this first slice.
- Smart Shuffle cannot be distinguished or explicitly selected through the current Spotify Web API; shuffle control stays boolean on/off.
- Queue-row play uses a maximum of five verified Next commands; it consumes earlier songs and may stop after a partial skip if Spotify changes the queue or device. It cannot guarantee an atomic position jump. The new 0.1.2 feature needs live acceptance.

## Development policy

Follow the canonical General Standing Orders (GSO) for repository work. Make scoped changes on branches, validate the exact current head, do not add AI attribution, and do not merge, tag, publish, deploy or run persistent services on the user's workstation without explicit authorization.
