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

On Windows, this development branch keeps **access tokens in memory** and uses current-user **DPAPI** encryption to save **only the refresh token** in `%LOCALAPPDATA%\iCueSpotifyIntegration\spotify-refresh.dpapi`. After authenticating once with this updated companion, normal companion restarts can refresh without another Spotify login. The preexisting 0.1.1 companion was memory-only, so the first upgrade still requires one normal `/connect` authorization. On non-Windows development hosts the companion remains memory-only.

Run automated tests: npm test

If the CLI is installed:

    icuewidget validate widget
    icuewidget package widget

The resulting `.icuewidget` can then be imported into iCUE. The original 0.1.0 widget was tested on a real XENEON EDGE. **To use the new repeat-mode indicators, build/import the 0.1.1 widget package**; the running companion and existing pairing key can remain unchanged.

## Optional persistent Windows companion (draft feature)

The core widget package and its pairing key are unchanged. This repository branch adds **current-user DPAPI-protected Spotify refresh-token persistence**, but no scheduled task is created automatically.

1. Update the companion code and stop the existing companion only when ready to switch. Start the new version with `node companion/server.mjs` and authorize Spotify **once** at `http://127.0.0.1:8765/connect`.
2. When the new companion is running, test an ordinary stop/restart to check whether it restores Spotify authorization. The active Spotify access token is never stored on disk.
3. If you explicitly want automatic launch when you sign into Windows, run ` .\scripts\companion-autostart.ps1 -Install` from a PowerShell prompt in this repository. This copies the companion into a stable per-user AppData directory and creates a least-privilege, current-user Task Scheduler **at-logon** entry. It does not restart the currently running companion.
4. To disable future autostart, run ` .\scripts\companion-autostart.ps1 -Remove`. This leaves the pairing key and protected refresh credential in place for manual use.
5. After an installation/update, restart the companion at a convenient time or sign out and back in to run the copied version. Avoid launching a second manual instance against port 8765.

**Security and failure behavior:** Windows DPAPI normally binds decryption to the same Windows account and device. Corrupted or inaccessible encrypted credentials require reauthorization; confirmed Spotify token revocation also requires reauthorization. Network outages should not erase a valid token. The encrypted credential is stored under the user's `LOCALAPPDATA`; anyone able to run malicious code as that logged-in user may still access it. Never share the encrypted credential as though it were a portable backup.

**Acceptance still pending:** direct Windows user-account restart/autostart verification; successful CI alone does not prove a scheduled task behaves correctly on the user's PC.

## Widget behavior

Shows cover artwork, title, artists, album, elapsed/duration, queue, active device, volume, shuffle and repeat. Tap controls or seek on the progress bar. The widget polls playback about every 3.5 seconds; the companion caches playback for 3 seconds and the queue for 15 seconds. API rate-limit responses are respected with backoff. A pending queue/API problem is shown as a warning rather than quietly displaying a fabricated queue.

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
- Access tokens remain in memory. On Windows, only the refresh token is encrypted at rest with the logged-in user's DPAPI key; it is not placed in the GitHub repository, a scheduled task argument, or a plaintext file. User-scope DPAPI cannot defend against malware executing under the same logged-in account.
- This project is personal/noncommercial. Spotify terms, API availability and development-mode quotas apply.

## Verified integration status

As of 2026-10-19 (feature branch `feat/spotify-edge-dashboard`):

- **Verified live (user acceptance):** iCUE package installed on a physical XENEON EDGE; user confirms live Spotify playback, touchscreen play/pause without the previously reproduced intermittent 403, real queue scrolling without position resets, **seeking, volume, standard shuffle, and repeat playback behavior**. Repeat worked before the visual improvement, but its exact mode was not obvious on-screen.
- **Verified via local companion:** Spotify PKCE authentication and real playback/queue requests return successfully, with 20 actual upcoming tracks observed and album-art proxy responding successfully.
- **Automated checks:** the initial code head `4c57d512ecc2fc0afb61bcab875a31c2969d1aea` passed 15 tests and official iCUE validation (Actions `39237872256`). The subsequent 0.1.1 display update adds regression coverage for distinct repeat states, mode cycling, and Smart Shuffle status messaging; refer to the current PR head's Actions run for exact-head validation.
- **Not individually verified on hardware:** newly introduced repeat-mode visual indicators in 0.1.1, complete layout/readability, disconnect/recovery scenarios, and OAuth token refresh. Behavioral repeat, seek, volume and shuffle have been user-confirmed.
- **Runtime constraint (0.1.1 baseline):** the old companion requires reauthorization after restart. The new Windows persistent companion is a separate draft implementation; its DPAPI restore and at-logon behavior still require real-user testing before being marked accepted. The locally stored pairing key remains valid.

## Known limitations

- The companion must run locally. **At-logon autostart is opt-in** via `scripts/companion-autostart.ps1`; it is not enabled by installing/building/testing the widget.
- Touch play/pause, queue scrolling, seeking, volume, standard shuffle, and repeat behavior are user-confirmed on the XENEON EDGE. The new 0.1.1 repeat indicator still needs physical visual acceptance. Recovery behavior and actual token refresh have **not** been individually verified.
- No queue reorder/removal: Spotify does not offer general queue editing endpoints.
- Spotify reports some state asynchronously, so skip/pause may take a polling interval to update.
- Artwork URL host support is restricted to known Spotify CDN hosts and may need adjustment if Spotify changes hosts.
- No automatic Spotify device-selection UI in this first slice.
- Smart Shuffle cannot be distinguished or explicitly selected through the current Spotify Web API; shuffle control stays boolean on/off.

## Development policy

Follow the canonical General Standing Orders (GSO) for repository work. Make scoped changes on branches, validate the exact current head, do not add AI attribution, and do not merge, tag, publish, deploy or run persistent services on the user's workstation without explicit authorization.
