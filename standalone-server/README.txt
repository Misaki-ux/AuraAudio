AuraAudio Standalone Server

Requires Node.js 18 or newer. On Windows, run start-server.ps1 from PowerShell.
The server API and mobile app are available at http://localhost:3456 and /mobile/.
By default the server listens on all network interfaces for phone access.
Persistent data is stored in server/data/db.json and downloads/ beside this file.
yt-dlp is bundled on Windows when available. FFmpeg must be installed on PATH.
Set AURA_HOST or AURA_PORT before launch to override the bind address or port.
Keep the server on a trusted network.