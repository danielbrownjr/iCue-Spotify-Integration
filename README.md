# Spotify Queue Dashboard for XENEON EDGE

A custom iCUE widget for the Corsair XENEON EDGE that shows **what's playing and what's actually next in Spotify**. It includes album art, song progress, volume, shuffle, repeat, and a scrollable queue. You can tap one of the first five upcoming songs to skip forward through Spotify's queue.

The widget was tested on a physical XENEON EDGE at **840 × 696 (medium horizontal)**. It talks to a small, local Node.js companion on your Windows PC. No separate project-hosted service or npm runtime dependencies are required, but the companion does need Spotify's Web API and initial setup is manual.

**Current download:** [v0.1.4-rc.1 release candidate](https://github.com/danielbrownjr/iCue-Spotify-Integration/releases/tag/v0.1.4-rc.1) · [Download the .icuewidget directly](https://github.com/danielbrownjr/iCue-Spotify-Integration/releases/download/v0.1.4-rc.1/spotify-queue-0.1.4.icuewidget)

This is a release candidate, not a one-click installer. If you hit a snag, [open an issue](https://github.com/danielbrownjr/iCue-Spotify-Integration/issues).

## Before you start

You'll need:

- A **Corsair XENEON EDGE** with **iCUE 5.52 or newer** (Widget API 1.9.0).
- **Windows** and **Node.js 22 or newer** on the same PC.
- **Spotify Premium** and an active playback device in Spotify Connect.
- Your **own Spotify Web API developer app** with access to the Spotify account you're signing in with.

Spotify's developer-mode access and API limits can prevent an app from working for arbitrary Spotify accounts. **Do not assume the Client ID built into this project gives your account access.** Set up your own app as described below. The Client ID is public, but your local widget pairing key and Spotify tokens are not.

## Install it

### 1. Download the widget and get the companion source

Download `spotify-queue-0.1.4.icuewidget` from the [RC release](https://github.com/danielbrownjr/iCue-Spotify-Integration/releases/tag/v0.1.4-rc.1). Keep it somewhere you can find it in iCUE.

Get the repository onto your PC, either by downloading **Code → Download ZIP** from GitHub and extracting it, or with Git:

```powershell
git clone https://github.com/danielbrownjr/iCue-Spotify-Integration.git
cd iCue-Spotify-Integration
```

The following commands assume PowerShell is open in that repository folder. **Node.js is required**, but you do not need to run `npm install` to start the companion.

### 2. Create a Spotify developer app

In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), create a Web API app and register **this exact redirect URI**:

```text
http://127.0.0.1:8765/callback
```

Use the app's **Client ID**, not a Client Secret. The companion uses Authorization Code with PKCE and requests `user-read-playback-state` and `user-modify-playback-state`. Check that your Spotify account is permitted to use the app in its current development mode.

In **ordinary Windows PowerShell**, set your Client ID for the current session:

```powershell
$env:SPOTIFY_CLIENT_ID = "YOUR_SPOTIFY_CLIENT_ID"
```

To use the same ID after signing out or setting up optional autostart, also save it in your **user** environment:

```powershell
[Environment]::SetEnvironmentVariable("SPOTIFY_CLIENT_ID", $env:SPOTIFY_CLIENT_ID, "User")
```

Sign out and back in before testing at-logon startup so the newly configured user environment is available. A Client ID is not a secret; **never put a Spotify Client Secret or access token into these commands**.

### 3. Connect Spotify

Start the companion from the repository folder:

```powershell
node .\companion\server.mjs
```

Keep this PowerShell window running for now. The companion binds to **127.0.0.1:8765** and prints a **Widget pairing key** on first launch. Save that key privately; don't share a screenshot or paste it into an issue.

Open [http://127.0.0.1:8765/connect](http://127.0.0.1:8765/connect) in your browser. Sign in to the Spotify account allowed by your developer app and approve access. You should see **Spotify connected**.

On Windows, the companion saves only the **refresh token**, encrypted for your signed-in Windows account with DPAPI. The access token stays in memory.

### 4. Import the widget into iCUE

Import the downloaded `.icuewidget` file through iCUE's widget import/add flow. Put it on the XENEON EDGE in a **medium horizontal tile**, then open its widget settings.

Set **Companion pairing key** to the key printed by the companion. Leave the terminal running and start playing something in Spotify. You should see the current song, artwork, and upcoming queue.

The widget itself does not sign in to Spotify. It communicates only with the local companion. If it says **Set pairing key in widget settings**, the key has not been entered.

### 5. Optional: start the companion silently at Windows sign-in

First confirm that Spotify login and the widget work while the companion is running manually. Then, **from native Windows PowerShell (not an MSIX/packaged terminal)** in the repository folder, you can opt into console-free startup:

```powershell
.\scripts\companion-autostart.ps1 -InstallHidden
```

This copies the companion into your user AppData directory and registers a **current-user Scheduled Task** called `iCUE Spotify Companion`. The console-free launcher uses a locally compiled Windows supervisor; no additional background service or second task is installed.

**Installation does not restart the companion you already have running.** Before testing the scheduled task, stop your manual `node` process with **Ctrl+C**. Then sign out and back in (or reboot) and verify that the widget reconnects without a visible terminal or a new Spotify login. Don't run another manual copy at the same time.

Useful commands from the repository folder:

```powershell
.\scripts\companion-autostart.ps1 -Status
.\scripts\companion-autostart.ps1 -Remove
```

`-Remove` unregisters autostart but does **not** delete your local pairing key or saved Spotify credential. For a visible-console launcher, use `-Install` instead of `-InstallHidden`. When updating an existing installation, rerun **the same launcher mode** you already use, and plan a controlled restart; changing the task does not restart an already-running process.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| **Set pairing key in widget settings** | Add the key from your companion's terminal to the widget's **Companion pairing key** setting. Keep it private. |
| **Companion offline** or no data | Check that `node .\companion\server.mjs` is running, or check `-Status` if you installed autostart. Only one process can listen on port 8765. |
| **Open companion /connect** or authentication expired | Open `http://127.0.0.1:8765/connect` again and authorize. Confirm you used the correct Spotify developer app and an account permitted to use it. |
| Spotify login fails | Check your `SPOTIFY_CLIENT_ID` and the **exact** redirect URI above, including `127.0.0.1` rather than `localhost`. Confirm your Spotify app's development-mode access. |
| **Nothing playing**, missing volume, or empty queue | Start playback in Spotify on an **active Spotify Connect device**. Available controls depend on what Spotify reports for that device. |
| Queue warning or buttons seem delayed | Spotify state can lag or be rate-limited. Give it a moment; don't repeatedly tap a queue-jump button after a partial skip. |
| Background startup doesn't work | Run `-Status` in native PowerShell and check the registered executable, Node installation path, and your user-level Client ID. Sign in again after changing user environment settings. |

If reporting a bug, include your widget version, iCUE version, what you expected, what happened, and any **non-sensitive** error text. Never post pairing keys, OAuth codes, tokens, or logs containing them.

## What the controls do

- **Previous / Play-Pause / Next:** standard Spotify playback controls, with vector icons in v0.1.4.
- **Seek and volume:** work when Spotify exposes those controls for the active device.
- **Shuffle:** on/off. Spotify's Web API doesn't expose Smart Shuffle as a distinct selectable mode.
- **Repeat:** Off → All → One → Off. A small **1** on the icon identifies Repeat One.
- **Up Next:** scroll the real Spotify queue, normally up to 20 upcoming tracks as returned by Spotify.

**Queue jump is not queue editing.** You can tap one of the first five upcoming entries to advance toward that track. Because Spotify has no atomic “jump to queue position” endpoint, the companion issues bounded, sequential **Next** commands and verifies each result. Earlier songs are **skipped/consumed**, and a changed device, queue, repeated track, or unexpected response can stop the jump partway through. Rows beyond the first five cannot be jumped to.

## Security and privacy

The companion listens on **127.0.0.1:8765**, uses Spotify's PKCE login, restricts widget API access with a per-install pairing key, and checks browser host/origin information. The widget's network permission is limited to that loopback address and port; album art is proxied by the companion.

On Windows, the Spotify refresh token is protected by **DPAPI CurrentUser** in `%LOCALAPPDATA%\iCueSpotifyIntegration\spotify-refresh.dpapi`. The pairing key is stored separately at `%LOCALAPPDATA%\iCueSpotifyIntegration\pairing-key`. Neither belongs in Git or a screenshot. DPAPI protects against casual disclosure on disk; it does not protect secrets from malicious software already running as the same Windows user. A change of Windows profile or revoked Spotify authorization may require signing in again.

## For developers

The code is organized as a dependency-free Node companion (`companion/`), a standalone iCUE widget (`widget/`), Windows autostart scripts (`scripts/`), and automated tests (`test/`).

```powershell
npm run check
npm test
```

To validate or build a widget package yourself, install Corsair's widget CLI separately:

```powershell
npm install -g icuewidget-cli
icuewidget validate widget
icuewidget package widget
```

The CI workflow also builds a downloadable widget artifact on pull requests. The [v0.1.4-rc.1 release](https://github.com/danielbrownjr/iCue-Spotify-Integration/releases/tag/v0.1.4-rc.1) contains the already-tested widget package. **The RC tag predates the later MIT documentation merge; the current source and license live on `main`.**

## Known limitations

This was built and tested on a physical XENEON EDGE, but installations on other PCs and Spotify accounts may uncover setup issues. It requires the companion to remain running and an active Spotify playback device. Spotify API access, developer-mode restrictions, queue responses, and rate limits are outside this project's control. There is no automatic device picker, general queue reorder/removal, or separate Smart Shuffle control. Unexpected device or queue changes can interrupt a skip-through operation.

## License

[MIT](LICENSE). This is an unofficial community project, not affiliated with or endorsed by Corsair or Spotify. Their names and trademarks, and album artwork returned by Spotify, are not licensed by this repository.
