# <img src="assets/icon_64x64.png" width="36" height="36" align="center" alt="AuraAudio Logo" /> AuraAudio (AuraPlayer)

> **Modern Dark Glassmorphic Audio Player** engineered for desktop multitasking with **3-State Dynamic Reduction**, an intelligent **Auto-Reduction Engine**, and custom branded artwork.

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Electron%20%7C%20Web-blue.svg)](#)
[![Version](https://img.shields.io/badge/Version-1.2.0-purple.svg)](#)
[![UI](https://img.shields.io/badge/Design-Glassmorphism%20Dark-zinc.svg)](#)

---

🎛️ **3-State Dynamic Reduction**:
  - **Full Mode (920 × 580)**: Complete dashboard with rotating vinyl disc and branded label, real-time audio spectrum visualizer, full playlist queue with instant search & drag-and-drop, track information, seekbar, and YT Shorts-style vertical volume popup.
  - **Compact Mode (520 × 240)**: Sleek horizontal media card with medium spinning vinyl disc, marquee ticker, seekbar, full controls, and horizontal volume slider.
  - **Micro Mode (360 × 74)**: Ultra-compact floating pill bar with mini vinyl disc, scrolling track marquee, time tracker, and micro controls.
- ⚡ **Intelligent Auto-Reduction Engine**:
  - **Inactivity / Idle Auto-Reduction**: Automatically detects when you are idle (configurable to 15s, 30s, 1m, 2m, or 5m) and smoothly shrinks the player to Compact or Micro mode with a graceful countdown toast.
  - **Blur Auto-Reduction**: Automatically shrinks the player when you switch focus to your code editor, browser, or documents.
  - **Focus Auto-Restore**: Seamlessly expands back to Full mode when you click back into the player.
  - **Responsive Window Adaptation**: Intelligently switches layouts dynamically when the window is resized manually.
- 🎨 **Branded Artwork & Assets**:
  - Official high-resolution disc icon embedded into the spinning vinyl record centers in Full, Compact, and Micro modes.
  - Native window taskbar and window frame icons (`assets/icon.ico` and `assets/icon.png`).
  - Web favicons in multiple resolutions (16×16, 24×24, 32×32, 64×64, 128×128).
  - PiP video overlay rendered with the branded app insignia.
- 📌 **Always-on-Top (Pin)**: Pin the Compact or Micro player above all your open windows while coding, studying, or gaming.
- 🎵 **High-Fidelity Audio Engine**:
  - HTML5 Audio API with Web Audio Analyser integration.
  - Real-time frequency spectrum visualizer rendered on HTML5 canvas with GPU acceleration.
  - CPU-saving visualizer loop (automatically pauses when idle, hidden, or minimized).
- 💾 **IndexedDB Audio Caching**:
  - Songs dropped or added to the player are persisted locally in browser IndexedDB.
  - Your playlist is automatically restored across app restarts without re-uploading files.
  - Server-downloaded tracks are also restored from the download library and can play without reimporting.
  - Use the Queue refresh button to reload local titles and server downloads. Removing a track from the Queue deletes its saved audio or import record too.
- ❤️ **Liked Songs**: Like the active track from the player, browse and remove favorites, and play or shuffle liked tracks available on this device. Likes use local fallback storage when the API is offline.
- 📥 **Favorite on Import**: Choose **Like imports** before adding audio files, and use the heart on any queue card to update favorites.
- 👤 **Guest-first account access**: The main navigation keeps Queue, Search, Discover, DL My Songs, and Liked. Create and load playlists from Queue; sign-in and cloud options open from the Guest/account button.
- 🔍 **Global Search**: Search the local library, curated catalog, and real YouTube results from a dedicated tab; results update as you type. Queue filtering remains available separately.
- 💗 **Liked library**: Liked songs and artists can be collapsed independently. Selecting a liked artist opens a dedicated profile with portrait, biography, albums, and songs.
- ✨ **Personalized Discovery**: Recommendations use the current user's likes, imported media, downloads, playlists, and recent plays. Opening Discover fetches fresh data from the server.
- 🎙️ **Artist discovery**: Search and open artist profiles with biographies, portraits, albums, artwork, and playable recording results. Selecting an album opens its details and track titles inside the themed desktop app instead of navigating to MusicBrainz. Favorite artists and songs directly from the discovery view. Metadata comes from MusicBrainz, Wikimedia, and Cover Art Archive when available.
- 🧹 **Cache controls**: Settings estimates local imported audio and server download sizes before partial or full cleanup.
- 🗂️ **Queue playlists**: Load playlists from the Queue selector, or use the vertical dots on a track to add it to a playlist, open its artist or album, or search related songs.
- 🔗 **Service playlist imports**: Import Spotify playlists and saved songs from Spotify's personal-data JSON export; desktop Liked and DL My Songs, plus mobile Liked, Playlists, and Settings, have direct import actions. AuraAudio does not connect to the Spotify Web API. Apple Music supports developer-token validation and MusicKit account authorization before playlist import. SoundCloud playlists are read through yt-dlp; tracks only play locally when the source marks them downloadable. Spotify and Apple Music audio stays in the official service.
- 🎚️ **Daily mixes**: Choose Your Aura Mix, Electro, Pop, Rock, Rap, Hip-Hop, Reggae, R&B, Classical, Jazz, Blues, Country, Alternative, Techno, Metal, Indie, or Latin in Discover or the Queue playlist selector. Your Aura Mix reflects liked songs and listening history; mood mixes use remote results for the primary moods and curated, playable-on-demand fallbacks for the others. Discover initially renders six cards and reveals more on request. Playback downloads tracks only after the user chooses to play them. Use **Download full mix** for an explicit batch download (up to two at a time) with per-track status. Discover data is cached per profile for ten minutes and can be refreshed manually.
- 📱 **Mobile player**: Open `/mobile/` on the server to browse server-backed likes and playlists, search, play, and access downloads. First launch presents sign-in or guest access; signed-in users can sign out from the account panel. Saved liked and downloaded tracks play from their existing server/device media and do not start a replacement download when a saved file is missing; stale missing-download entries are pruned from the download library. Standard mobile playlists use compact cards that open a separate track view with recommendations; the Library's named Playlists group and individual cards can be collapsed, switched between grid and compact-list layouts, renamed, deleted, and reordered. Expanded playlists provide track reordering. Playlist and track artwork uses cached server metadata lookups. Recommendation entries do not imply that playback is available—the server may return metadata without a playable source. Mobile Liked and Playlists screens provide direct Spotify import actions, while Settings offers separate playlist and saved-song choices. Settings can also import audio folders/files into device-local IndexedDB for playback, download a versioned backup of liked songs, artists, and playlists, and set per-profile play-history retention and minimum listen duration. Folder permissions are not retained; re-import after adding files. Missing or failed liked-track covers are retried through the server's free metadata lookup and saved to the profile and browser cache when found. Artist detail includes a portrait, biography, songs, and a free iTunes Search API latest-release lookup with locally cached artist/release metadata and artwork; it loads release names and covers first, and only loads album tracks after a release is selected. Audio is downloaded only when the user chooses Play. In Liked Songs, tap a row or its play button to play; double-tap a row to append it to the queue without starting a download. The expanded mobile player hides the tab navigation and stays below the top bar; fullscreen lyrics also start below the top bar. Download progress remains non-blocking, and unliking removes duplicate like records.
  <img width="341" height="668" alt="image" src="https://github.com/user-attachments/assets/192b93bf-6fca-4931-a537-ba40d979a0ca" />
  <img width="339" height="667" alt="image" src="https://github.com/user-attachments/assets/b9bc313c-451a-46a3-9ebe-7682f7e09195" />
  <img width="332" height="668" alt="image" src="https://github.com/user-attachments/assets/a2b38874-db94-4f73-b2f4-16aabb0d482f" />
  <img width="331" height="445" alt="image" src="https://github.com/user-attachments/assets/8d794a63-1df4-42fe-8feb-afd9655d437e" />
- 🔁 **Cross-server library transfer**: In desktop Settings, choose **Import mobile library → Create QR**. On the phone's autonomous client, open Settings → **Send library to desktop**, scan the expiring QR (or paste its payload), then send. The one-use receiver is limited to a private Wi-Fi/LAN connection and merges liked songs/artists, listening history, playlists, and download metadata. Audio files, local filenames, file paths, and stream URLs are never transferred. Keep both devices online and on the same private network until the desktop reports completion.
- 🌈 **Dynamic Accent Color & Glow Engine**:
  - Signature Aura Royal Blue (`#2563eb`) matching the official asset palette.
  - One-click color presets: Spotify Green, Cyber Violet, Vibrant Amber, Hot Pink.
  - Custom primary and glow color pickers with real-time CSS variable updates.
  - Replace each preset's `assets/<palette>/x.png` and `x.ico` placeholders to brand the app and favicon for that palette.
- 🖼️ **Picture-in-Picture (PiP)**: Pop out an OS-level floating video overlay with the live branded insignia, song title, and time progress.
- ⌨️ **Comprehensive Keyboard Navigation**: Control everything effortlessly with hotkeys.


## Build and Run

Install Node.js 18 or newer, then install the project dependencies with `npm install`. Edit the mobile source in `mobile/index.html`; `mobile-dist/index.html` is generated output, not a second library or database. Both the desktop and standalone servers serve the generated page and shared artwork.

| Command | Action | Output |
| --- | --- | --- |
| `npm run app` (or `npm start`) | Run the Electron app in development | Opens AuraAudio and starts its embedded API server |
| `npm run server` | Run only the API server from the project | API on port 3456; data in `server/data/db.json`, downloads in `downloads/` |
| `npm run mobile:compile` | Compile the mobile web client | `mobile-dist/index.html` |
| `npm run android:apk` | Compile the mobile client, sync the Capacitor Android project, and build a debug APK | `dist/AuraAudio-debug.apk` |
| `npm run android:autonomous-apk` | Build the standalone autonomous Android app with app-private local storage | `dist/AuraAudio-Autonomous-debug.apk` |
| `npm run server:compile` | Build the standalone server distribution, including the mobile client | `standalone-server/` |
| `npm run app:exe` | Build the standalone server and package a portable Windows executable | `dist-portable/` |
| `powershell -ExecutionPolicy Bypass -File tools/sync-standalone-server.ps1` | Copy newer root server JavaScript files into the existing standalone server | Updates `standalone-server/server/*.js`; leaves runtime data, configuration, and assets unchanged |
| `npm run appcompile` | Build mobile and standalone server outputs, then package the desktop app | `dist/` installers and portable app, plus both standalone folders |
| `npm run pack` | Prepare mobile and server outputs and create an unpacked desktop build | `dist/win-unpacked/` on Windows |

`npm run build` and `npm run dist` are aliases for `npm run appcompile`. On Windows, the packaged app produces NSIS installer and portable executable targets. `npm run app:exe` writes to `dist-portable/` so a running app or locked build output under `dist/` does not block the portable build. The standalone server needs Node.js 18+ and FFmpeg on PATH; the Windows yt-dlp executable is included when available. See [HOW_TO_RUN.md](HOW_TO_RUN.md) for LAN access and launch steps.

### Build the Android APK

Install Node.js 22+, JDK 17 or newer, and Android Studio with Android SDK Platform 35 and Build Tools 35.0.0. Install dependencies with `npm install`, then run `npm run android:apk`. On its first run this generates the `android/` Capacitor project, syncs the mobile client and its assets, and builds `dist/AuraAudio-debug.apk`. Android uses an HTTP local WebView origin and allows cleartext requests so it can reach the LAN API over HTTP. The build uses the first available private LAN IPv4 address and port 3456 for its default API URL. To choose a host explicitly, set `AURA_API_HOST` (and optionally `AURA_PORT`) or set the complete `AURA_API_URL` before building. The host server must be reachable from the phone; see [HOW_TO_RUN.md](HOW_TO_RUN.md) for configuring LAN access. Debug APKs are for installation and testing; Play Store distribution needs a signed release build.

### Standalone autonomous Android app

Build with `npm run android:autonomous-apk`. Unlike the LAN-connected APK above, this variant does not require a PC, configure an API URL, or run an embedded HTTP listener. A native Capacitor bridge stores library records and queued actions in app-private SQLite and audio in app-private files; no storage permission or cleartext network access is required. Settings shows storage usage and provides controls to import audio, clear saved audio, clear app cache, export a backup, or reset local data. The bridge enforces a 512 MiB logical storage quota and a 256 MiB per-audio-file limit. On upgrade, existing IndexedDB data is copied and verified before the old copy is removed.

The autonomous app can play imported/saved local audio and manage likes, playlists, and play history without a PC. Online discovery, server search, lyrics, and YouTube downloads still require the optional AuraAudio server; Android YouTube-download parity is not included. To optionally transfer library metadata to desktop, open Settings → **Send library to desktop** and scan the expiring QR created in desktop Settings while both devices share a private network. The transfer includes likes, artists, play history, playlists, and download metadata only—audio is never sent. iOS support is not included.

### Mobile installation and background audio

The mobile page includes a web app manifest and service worker and can be installed from a supported browser over HTTPS (or from `localhost` during development). When the browser exposes the Media Session API, AuraAudio publishes track metadata, playback position, and available play, pause, previous, next, and seek controls. Background playback is still controlled by the browser and operating system: mobile browsers may suspend a tab, stop audio under power or memory pressure, or limit lock-screen controls. Installing the web app can improve launch and media-control integration, but does not guarantee uninterrupted playback. iOS Safari and other mobile browser behavior varies by OS/browser version and user settings; AuraAudio cannot override those restrictions.

---

## 📐 3-State Dynamic Reduction

AuraAudio re-imagines how desktop audio players live alongside your daily workflow:

```
┌────────────────────────────────────────────────────────┐
│                      1. FULL MODE                      │
│                  (920 × 580 Default)                   │
│  - Branded Rotating Vinyl Disc - Playlist Queue        │
│  - Live Audio Visualizer       - Track Search & Filter │
│  - Seekbar & Time Stamps       - Drag & Drop Zone      │
│  - YT Shorts Vertical Volume   - Quick Accent Themes   │
└────────────────────────────────────────────────────────┘
                           │
             Tab / F8 / Auto-Reduction
                           ▼
            ┌─────────────────────────────┐
            │       2. COMPACT MODE       │
            │     (520 × 240 Media Card)  │
            │  - Medium Vinyl Disc        │
            │  - Marquee Title Ticker     │
            │  - Seekbar & Time Stamps    │
            │  - Core Playback & Volume   │
            │  - Pin On Top Toggle        │
            └─────────────────────────────┘
                           │
             Tab / F8 / Auto-Reduction
                           ▼
                  ┌─────────────────┐
                  │  3. MICRO MODE  │
                  │ (360 × 74 Pill) │
                  │ - Mini Vinyl    │
                  │ - Marquee Title │
                  │ - Play/Next     │
                  │ - Pin / Expand  │
                  └─────────────────┘
```

### How to Switch States:
1. **View State Switcher Button**: Hover to view `minimize 3 states (full,medium,min)` and click (<i class="fa-solid fa-arrow-up-right-from-square"></i>) in the topbar to cycle through Full, Medium (Compact), and Min (Micro).
2. **Keyboard Hotkeys**:
   - Press <kbd>Tab</kbd> or <kbd>F8</kbd> to cycle: `Full` ➔ `Compact` ➔ `Minimized` ➔ `Full`.
   - Press <kbd>1</kbd> for Full, <kbd>2</kbd> for Compact, <kbd>3</kbd> for Minimized.
3. **One-Click Expand**: Click the resize icon (<i class="fa-solid fa-up-right-and-down-left-from-center"></i>) in the Minimized or Compact widget to instantly return to Full mode.

---

## 🤖 Smart Auto-Reduction Engine

Open **Settings (<i class="fa-solid fa-gear"></i>)** to customize the auto-reduction behavior:

| Setting | Options | Description |
|---|---|---|
| **Idle Auto-Reduction** | `On` / `Off` (Default: `On`) | Automatically shrinks the player when you are inactive. |
| **Inactivity Timeout** | `15s`, `30s`, `1m`, `2m`, `5m` | Time of zero keyboard/mouse interaction before shrinking. |
| **Target Reduction Mode** | `Compact` or `Micro` | The target mode to switch into when idle. |
| **Window Blur Reduction** | `On` / `Off` (Default: `Off`) | Shrinks immediately when switching to another application. |
| **Focus Auto-Restore** | `On` / `Off` (Default: `On`) | Expands back to Full mode when you click back into AuraAudio. |
| **Responsive Adaptation** | `On` / `Off` (Default: `On`) | Detects manual window resizing and switches layout dynamically. |

> [!TIP]
> When the idle timer triggers, a sleek floating toast appears giving you a 3-second heads-up with a **Cancel** button if you want to keep the Full view active.

---

## ⌨️ Keyboard Shortcuts Reference

| Shortcut | Action |
|---|---|
| <kbd>Space</kbd> | Toggle Play / Pause |
| <kbd>←</kbd> / <kbd>→</kbd> | Seek Backward / Forward 5 seconds |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Increase / Decrease Volume 5% |
| <kbd>M</kbd> | Mute / Unmute Audio |
| <kbd>S</kbd> | Toggle Shuffle Mode |
| <kbd>R</kbd> | Cycle Repeat Mode (Off ➔ Repeat All ➔ Repeat One) |
| <kbd>Tab</kbd> or <kbd>F8</kbd> | Cycle 3 Reduction States (Full ➔ Compact ➔ Micro) |
| <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> | Jump directly to Full (1), Compact (2), or Micro (3) |
| <kbd>T</kbd> | Toggle Always on Top (Pin Window) |
| <kbd>?</kbd> or <kbd>Shift</kbd> + <kbd>/</kbd> | Show Keyboard Shortcuts Modal |
| <kbd>Esc</kbd> | Close Settings or Shortcuts Modals |

---

## 🚀 Getting Started

### Import playlists and saved tracks from a Spotify data export

Spotify can provide a copy of your account data, including playlist details and the songs in Your Library. Request it from [Spotify Account Privacy](https://www.spotify.com/fr/account/privacy/). Spotify sends the download link by email; delivery can take up to 5 days.

When the email arrives, download and extract the ZIP archive. On desktop, choose **Liked → Import saved songs** for `YourLibrary.json`, or **DL My Songs → Choose Spotify JSON** for a playlist or library export. On mobile, choose **Liked → Import saved songs** or **Playlists → Import playlists**; both are also available separately under Settings. Choose a `Playlist*.json` file to import playlists into Playlists/Queue, or `YourLibrary.json` to import saved songs into Liked. Repeat for additional playlist JSON files if the export contains more than one. Playlist names and duplicate tracks are deduplicated. To avoid duplicates, AuraAudio skips playlists whose names already exist.

This is a metadata import. Spotify tracks continue to play in Spotify; AuraAudio does not download or stream Spotify audio. Spotify API sign-in and playlist API requests are not used. Mobile library backups are local JSON downloads containing only liked songs, liked artists, and playlists—not play history, diagnostics, credentials, tokens, or audio files.

### Import audio on mobile

In the mobile app, open **Settings → Import audio folder** and select a folder. Use **Choose audio files** if the browser does not support folder selection. Supported audio files are stored in the browser's device-local IndexedDB and can be played from the **On this device** section; folder access is not linked or kept by AuraAudio, and storage availability depends on the browser/device.

### Connect Apple Music

In **DL My Songs**, paste an Apple Music developer token and click **Confirm API**. AuraAudio validates it against Apple's `/v1/test` endpoint and remembers the confirmed token locally. Click **Connect Apple Music** to authorize access to personal-library playlists through MusicKit. Then paste an Apple Music playlist URL and click **Import**. Playlist audio remains in Apple Music.

### Use the mobile player

The server serves a separate touch-friendly interface at `http://<server-address>:3456/mobile/`. Its service worker uses the V7 cache namespace and keeps the app shell available offline after a successful visit; API requests and audio streams still require the server. To make it reachable from a phone on the same network, set `server.host` to `0.0.0.0` in `server/config.json` (or set `AURA_HOST=0.0.0.0`) and run `npm run server`. Find the computer's LAN IP and use that address in the phone browser. The app and mobile page share the same API, profile data, and `downloads/` directory. The embedded desktop server stays bound to localhost by default. Background playback is best-effort and remains subject to browser and operating-system policies.

### Windows Firewall (allow the local HTTPS listener)

The DuckDNS launcher forwards external TCP port `32768` (or your selected `-HttpsPort`) to local TCP port `443`. If the phone cannot reach Caddy, run PowerShell as Administrator and allow the local listener:

```powershell
New-NetFirewallRule -DisplayName "AuraAudio HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
# Or with netsh:
netsh advfirewall firewall add rule name="AuraAudio HTTPS" dir=in action=allow protocol=TCP localport=443
```

To remove the rule later: `Remove-NetFirewallRule -DisplayName "AuraAudio HTTPS"`.

### External HTTPS access (DuckDNS + autonomous client)

The standalone server also ships an offline-capable autonomous client at `/autonomousclientmobile/`. To reach it from outside your home network over HTTPS without forwarding ports 80/443:

1. Copy `standalone-server/duckdns.config.example.json` to `standalone-server/duckdns.config.json` and fill in your DuckDNS subdomain and token.
2. The launcher prefers the bundled DuckDNS-enabled `caddy-duckdns.exe`. Reserve this PC's LAN address, then forward external TCP `32768` to local TCP `443`. Run `.\start-autonomous-client.ps1` inside `standalone-server/` to launch the server and open a one-time QR code for the autonomous client only. To choose another external port:
   ```powershell
   .\start-autonomous-client.ps1 -HttpsPort 32769
   ```
3. Certificates are issued through DNS-01 via DuckDNS, so no inbound ports 80/443 are required. Only your chosen external HTTPS port needs forwarding; allow local TCP 443 through Windows Firewall.
4. Keep the PowerShell window open; after the local Caddy HTTPS listener is ready, it opens a browser prompt containing the QR, the direct pairing link, and an expiry countdown. It does not depend on router NAT loopback. The QR expires after two minutes or its first successful scan and does not expose the shared server key.

The launcher rotates its access key on every run, invalidating paired devices when the server stops. For manual URL/key setup without a QR code, use `.\start-duckdns-server.ps1`. The DuckDNS token stays in the local config file and is passed to Caddy through a temporary environment variable. See `standalone-server/DUCKDNS-SETUP.md` for full troubleshooting.

Desktop search results and personalized mix tracks play through the queue. Online audio is downloaded by the server first; the download status card shows progress, errors, and the saved path. MP3 conversion requires FFmpeg alongside `yt-dlp`.

YouTube download also requires a current `yt-dlp` build with JavaScript runtime support. AuraAudio checks this before downloading and shows an update message if the installed version is too old. On Windows, update the `yt-dlp.exe` found on `PATH` from the [official yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases/latest), then restart AuraAudio. Current releases can use the Node runtime and fetch the EJS challenge scripts needed by YouTube.

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- `npm`

### Installation

1. **Clone or navigate to the repository:**
   ```bash
   cd auraplayer
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Launch the application:**
   ```bash
   npm start
   ```

See [HOW_TO_RUN.md](HOW_TO_RUN.md) for the full setup and [login.md](login.md) for Guest and email PIN access. AuraAudio opens in Guest mode; there is no shared default password.

### Passwordless Email Sign-In

AuraAudio supports signing in with a short-lived email PIN. No Google, GitHub, or password is required. The local server sends PIN emails through the [Resend email API](https://resend.com/docs/api-reference/emails/send-email) when these environment variables are set before launching the app:

- `AURA_EMAIL_API_KEY` — a Resend API key with email sending access.
- `AURA_EMAIL_FROM` — a sender address authorized for your Resend account.

PowerShell example (replace the values with your own credentials):

```powershell
$env:AURA_EMAIL_API_KEY = "re_your_key"
$env:AURA_EMAIL_FROM = "AuraAudio <login@your-verified-domain.com>"
npm start
```

The email code expires after 10 minutes, allows up to five attempts, and is stored only as a keyed hash in server memory. The PIN is a passwordless sign-in factor; by itself, it is not multi-factor authentication. Without the mail settings, the email sign-in UI remains visible but the server returns a configuration error when asked to send a code.

> [!NOTE]
> **Standalone Web Browser Mode**: AuraAudio is also completely functional in any modern browser! Simply open `index.html` directly in Chrome, Edge, Firefox, or Safari. The 3-state reduction will dynamically adjust the container viewport smoothly.

---

## 📁 Project Architecture & Assets

```
auraplayer/
├── assets/
│   ├── icon.ico              # Multi-resolution Windows application icon
│   ├── icon.png              # 256x256 Master PNG icon
│   ├── icon_128x128.png      # High-res Vinyl record center label & empty state
│   ├── icon_64x64.png        # Compact vinyl center label & PiP overlay icon
│   ├── icon_32x32.png        # Topbar brand logo & micro vinyl disk
│   ├── icon_24x24.png        # Settings footer icon
│   └── icon_16x16.png        # Browser favicon
├── index.html                # Unified UI, Audio Engine, Visualizer, 3-State Views, and Logic
├── main.js                   # Electron Main Process, IPC Handlers, Window Icon & Sizing
├── package.json              # Project Manifest, Build Configurations & Scripts
├── README.md                 # Complete Documentation & User Guide
└── LICENSE                   # MIT License
```

---

## 📄 License

This project is licensed under the terms of the [MIT License](LICENSE).
