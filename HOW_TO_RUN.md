# How to Run AuraAudio

## First launch

1. Install [Node.js 18 or newer](https://nodejs.org/) and npm.
2. Open a terminal in the AuraAudio project folder.
3. Install the app dependencies:

   ```powershell
   npm install
   ```

4. Start the desktop app:

   ```powershell
   npm start
   ```

The app opens in Guest mode by default. Local audio playback does not require an account or an internet connection. Click **Guest** in the top bar to open sign-in and cloud options.

## npm workflow

Run these commands from the project folder:

| Command | Purpose |
| --- | --- |
| `npm run app` or `npm start` | Launch the Electron desktop app for normal use (`electron .`) |
| `npm run web` | Serve the project over HTTP on port 8080 (`npx http-server . -p 8080`) |
| `npm run server` | Launch only the API server from the project source (`node server/index.js`) |
| `npm run dev` | Launch the Electron desktop app with logging enabled (`electron . --enable-logging`) |
| `npm run mobile:compile` | Build the static mobile page into `mobile-dist/` |
| `npm run mobile:dist` | Alias for `npm run mobile:compile` |
| `npm run server:compile` | Build the portable server-only folder at `standalone-server/` |
| `npm run server:dist` | Alias for `npm run server:compile` |
| `npm run android:apk` | Build and sync the Capacitor project, then create a debug Android APK at `dist/AuraAudio-debug.apk` |
| `npm run android:autonomous-apk` | Build the autonomous Android client APK (`node tools/build-autonomous-android.js`) |
| `npm run setup:ytdlp` | Install yt-dlp via `tools/install-ytdlp.ps1` |
| `npm run appcompile` | Build mobile and server outputs, then create desktop installers and a portable app in `dist/` |
| `npm run app:exe` | Build the mobile and server outputs, then create a portable Windows `.exe` in `dist/` |
| `npm run build` | Alias for `npm run appcompile` |
| `npm run pack` | Build mobile and server outputs, then create an unpacked desktop app in `dist/` |
| `npm run dist` | Alias for `npm run appcompile` |

`npm run build` and `npm run dist` are aliases for `npm run appcompile`. On Windows, `appcompile` creates the NSIS installer and portable `.exe` targets configured in `package.json`.

## Build and install the Android APK

You do not need to run Java or Gradle commands yourself. Install these prerequisites once:

1. Node.js 22 or newer and the project dependencies (`npm install`).
2. A JDK (17 or newer).
3. Android Studio with Android SDK Platform 35, Android SDK Build Tools 35.0.0, and the Android SDK command-line tools. Accept the SDK licenses in Android Studio's SDK Manager.

Then run this from the project folder:

```powershell
npm run android:apk
```

On the first build, the command creates the Capacitor `android/` project if it is missing, compiles `mobile/index.html` and copies its assets into `mobile-dist/`, syncs the Android project, and builds a debug APK. Find the installable file at `dist/AuraAudio-debug.apk`. To install it on a connected device with Android platform tools:

```powershell
adb install -r .\dist\AuraAudio-debug.apk
```

The APK's default API address is selected from the computer's private LAN IPv4 address on port 3456. Capacitor serves the packaged UI over HTTP so Android WebView can call the HTTP LAN API without mixed-content blocking. If the server runs on another computer, set the API address while building:

```powershell
$env:AURA_API_HOST = "192.168.1.50"
$env:AURA_PORT = "3456"
npm run android:apk
```

Or provide the whole address with `$env:AURA_API_URL = "http://192.168.1.50:3456"`. The server must listen on a LAN interface (`AURA_HOST=0.0.0.0`), and the host firewall must allow the selected port on the trusted local network. The API URL can also be changed in the app's Settings. Do not expose the unauthenticated HTTP server to an untrusted network. The generated APK is a debug build; Play Store release requires a signing key and a signed release build.

The Android project lives under `android/`; Capacitor configuration is in `capacitor.config.json`. Edit the mobile interface in `mobile/index.html`, then rerun `npm run android:apk` to compile, sync, and build. `mobile-dist/` is generated output. Changes made only inside `mobile-dist/` are overwritten by the next build.

Use the **Like imports** checkbox beside **Add Files** to add imported tracks to Liked Songs automatically. The Search tab searches your library, the built-in catalog, and YouTube; results update while you type. Discover requests fresh server data each time you open the tab.

## Email PIN sign-in (optional)

Email sign-in requires a Resend API key and a sender address authorized by Resend. Set these environment variables in the same terminal before starting AuraAudio:

```powershell
$env:AURA_EMAIL_API_KEY = "re_your_key"
$env:AURA_EMAIL_FROM = "AuraAudio <login@your-verified-domain.com>"
npm start
```

Without those values, Guest mode and local playback still work; email PIN sign-in reports that mail delivery is not configured. See [login.md](login.md) for account behavior and recovery details.

## Run the API server separately

For API development without opening Electron:

```powershell
npm run server
```

The server listens on `http://127.0.0.1:3456` by default. If Electron is started with the app, it starts the embedded server automatically.

To build a portable server-only folder, run `npm run server:compile`. Copy `standalone-server/` to the PC that will host the API, then run `start-server.ps1` in PowerShell. It keeps account data in `server/data/db.json` and downloaded audio in `downloads/` beside the launcher, and serves the mobile app at `/mobile/`. It includes yt-dlp on Windows when the project binary is present; FFmpeg must be available on PATH. Node.js 18 or newer is required.

## Use the mobile library

Edit the mobile source in `mobile/index.html`; `mobile-dist/index.html` is generated output, not a second data store. Build it with `npm run mobile:compile`. The desktop and standalone servers serve the page at `/mobile/` and artwork from `/assets/`. Mobile includes accent themes, track actions, an expandable queue, and Media Session controls for supported phone lock screens. Browser background audio depends on the phone's browser and OS; install/offline shell support requires a secure context such as HTTPS or localhost. The mobile Library reads saved likes and playlists from the server database. Sign in on mobile for an account library; guest mode reads the server's guest library.

To open the page from a phone on the same Wi-Fi, start AuraAudio with `AURA_HOST=0.0.0.0` (in PowerShell: `$env:AURA_HOST='0.0.0.0'; npm start`), then browse to `http://<computer-LAN-IP>:3456/mobile/`. Keep the server on a trusted network.

## Optional YouTube downloads

YouTube search and audio downloads need `yt-dlp` and FFmpeg available on `PATH`. Local file playback and likes do not depend on these tools.

## Windows Firewall (allow the HTTPS port)

If the phone cannot reach the server even though Caddy is running, Windows Defender Firewall is probably blocking the port. Run PowerShell as Administrator and allow the chosen HTTPS port (replace 32768 with your port):

```powershell
New-NetFirewallRule -DisplayName "AuraAudio HTTPS 32768" -Direction Inbound -Protocol TCP -LocalPort 32768 -Action Allow
# Or with netsh:
netsh advfirewall firewall add rule name="AuraAudio HTTPS 32768" dir=in action=allow protocol=TCP localport=32768
```

To remove the rule later:

```powershell
Remove-NetFirewallRule -DisplayName "AuraAudio HTTPS 32768"
```

## External HTTPS access (DuckDNS + autonomous client)

The standalone server ships an offline-capable autonomous client at /autonomousclientmobile/. To reach it from outside your home network over HTTPS:

1. Copy standalone-server/duckdns.config.example.json to standalone-server/duckdns.config.json and fill in your DuckDNS subdomain and token.
2. If your router can forward ports 80/443, run ./start-duckdns-server.ps1 inside standalone-server/. If it cannot, pick a high external port and forward only that one:
   `powershell
   .\start-duckdns-server.ps1 -HttpsPort 32768
   `
3. Certificates are obtained through DNS-01 via DuckDNS, so no inbound ports 80/443 are required for certificate issuance. Only your chosen HTTPS port needs forwarding.
4. Keep the PowerShell window open. It prints the full HTTPS URL (including the port when it is not 443) and a temporary access key.
5. Open the printed URL + /autonomousclientmobile/ on your phone and enter the access key. The client derives its server address from the page origin automatically.

The access key rotates on every launch; re-enter it in the client connection settings (gear icon) when the server restarts. See standalone-server/DUCKDNS-SETUP.md for full troubleshooting.
