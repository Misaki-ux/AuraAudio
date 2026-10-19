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

## Optional YouTube downloads

YouTube search and audio downloads need `yt-dlp` and FFmpeg available on `PATH`. Local file playback and likes do not depend on these tools.
