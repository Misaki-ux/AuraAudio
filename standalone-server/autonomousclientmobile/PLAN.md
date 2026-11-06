# Autonomous mobile client plan

## Goal

Keep a useful AuraAudio mobile client available when the phone cannot reach the standalone server, then synchronize likes when it reconnects.

## Implementation

1. Serve an installable client at `/autonomousclientmobile/` directly from the standalone server.
2. Cache the app shell and keep discovery/search metadata, liked tracks, pending actions, and downloaded audio blobs in IndexedDB on the device.
3. Let offline users search previously cached metadata and like or unlike tracks. Queue each change as an absolute state with a unique action ID.
4. Add an idempotent server sync endpoint so reconnect retries cannot toggle a like twice; fetch a fresh server snapshot after accepted actions.
5. Reconnect automatically when the browser reports network access and keep a manual Sync control.
6. Keep external access opt-in. DuckDNS updates the public DNS record and handles DNS-01 certificate challenges; Caddy terminates HTTPS on the user's PC and proxies to a loopback-only Node server. The router can forward a high external HTTPS port (32768 by default) to local TCP 443. The client sends a per-run API access key. Stop the launcher to stop the public listener and revoke the key.
7. Make the connection setting explicitly identify the AuraAudio API base URL, explain LAN and DuckDNS examples, and provide an API connectivity test. QR pairing continues to populate the same server origin and receive a device-scoped token.

## Available features

- The client exposes Library, Search, Discover, Liked, Playlists, Downloads, and Telemetry views, plus accent themes and a persistent bottom audio player.
- Connection settings accept the API server origin (including a custom HTTPS port); the client derives API routes from that origin and can test `/api/status`.
- Discovery mix metadata and search results are saved locally. The client loads fresh discovery and library data from the server when connected.
- Use the download control on a track to save its playable audio blob to device storage; the player uses that local copy while offline.

## Boundaries

- Offline search uses metadata cached on this device. New provider searches and live discovery need network access.
- New discovery, search, and server playlists need a network connection. Saved audio and metadata remain available offline.
- Internet access requires DuckDNS-enabled Caddy, local DuckDNS credentials, a publicly reachable home IP, and router forwarding from the chosen external HTTPS port to local TCP 443. DNS-01 validation does not require inbound ports 80/443. Use `start-autonomous-client.ps1` to launch a one-time QR pairing flow for this client; pairing tokens are device-scoped and expire after 30 days or when the launcher stops.
- Likes use the same server guest profile unless the client already has a valid AuraAudio login token saved for this origin.
