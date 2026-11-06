AuraAudio Standalone Server

Requires Node.js 18 or newer. On Windows, run start-server.ps1 from PowerShell.
The server API and mobile app are available at http://localhost:3456 and /mobile/.
The offline-friendly client is available at /autonomousclientmobile/.
By default the server listens on all network interfaces for phone access.
Persistent data is stored in server/data/db.json and downloads/ beside this file.
yt-dlp is bundled on Windows when available. FFmpeg must be installed on PATH.
Set AURA_HOST or AURA_PORT before launch to override the bind address or port.
For direct external HTTPS, copy duckdns.config.example.json to duckdns.config.json and enter your DuckDNS subdomain and token. The launcher prefers caddy-duckdns.exe and defaults to external TCP 32768 forwarded to local TCP 443. Run start-duckdns-server.ps1; use -HttpsPort to select a different external port. The API binds to loopback and requires a temporary access key.
DuckDNS updates DNS only. Caddy uses the DuckDNS DNS challenge and handles HTTPS on this PC; no inbound ports 80/443 are needed for certificate validation. Do not expose the AuraAudio API port. A public IPv4 address is required for router port forwarding; CGNAT may prevent it.
See DUCKDNS-SETUP.md for setup steps and for adding AuraAudio to an existing Caddy proxy.
The autonomous Android app runs without this PC server and stores library data in app-private SQLite and audio in app-private files. Its online discovery, search, lyrics, and YouTube downloads still require an optional AuraAudio server.
Optionally transfer likes, artists, play history, playlists, and download metadata between the autonomous app and desktop using the one-use QR in desktop Settings. Audio files are never sent. The browser autonomous client can still pair with this server or use start-autonomous-client.ps1 for protected external HTTPS and a QR code.