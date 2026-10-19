# AuraAudio architecture

## Runtime

AuraAudio is an Electron renderer (`index.html`) backed by a small Node HTTP API (`server/`). Electron starts that API in `main.js` before showing the window. The standalone server can also be started with `npm run server`. By default it listens on `127.0.0.1:3456`; `AURA_HOST` overrides the configured host when LAN access is needed.

The mobile web client lives in `mobile/index.html` and is served at `/mobile/` by the same API process. It uses the browser origin as its API base, so it shares the desktop server, guest/account profile, likes, and downloads. The server remains local-only by default.

## Main data and playback paths

- Local imports are stored as audio blobs in renderer IndexedDB. The server receives only import metadata for discovery.
- Likes, playlists, download records, and play events are stored by `server/db.js` in the JSON database configured by `server/config.json`.
- Artist favorites are stored alongside liked songs. Imported artist fields are resolved from filenames when possible, using the metadata API; audio remains in IndexedDB.
- Discover payloads are cached per profile in renderer memory and local storage for ten minutes; the view has an explicit refresh action. Liked-song changes invalidate the cached personalized mix.
- Playing a Discover mix replaces the active Queue with a deduplicated full mix instance and downloads only the current track on demand as playback reaches it. A separate explicit “Download full mix” action downloads missing tracks at up to two concurrent server jobs, with per-track readiness in Queue.
- Artist discovery reads artist/recording/release data from MusicBrainz, biographies and portraits from Wikimedia page summaries, and album artwork from Cover Art Archive. Provider failures fall back to curated artist data or an empty image/description.
- The cache settings estimate browser IndexedDB blob sizes and server download sizes before deletion. Partial cleanup deletes server downloads; full cleanup also deletes local imports and their server metadata.
- Search combines the curated discovery catalog, the user's library, and live YouTube search results.
- The Discover mixes include a profile-based mix from recent plays and likes plus Electro, Pop, and Rock mood mixes. The mood mixes use live YouTube results with searchable curated fallbacks. Mixes are selectable from Discover and the Queue playlist selector; tracks use exact result URLs where available, and text-based playback searches up to three candidates to reduce wasted requests.
- Online play requests use the download API. `server/youtube.js` runs `yt-dlp`, parses progress from both output streams, converts audio to MP3 with FFmpeg, and stores it in the configured downloads directory. `/api/ytb/progress/:id` reports status; `/api/media/:filename` streams saved audio and supports byte ranges. The desktop client restores server download records into its queue on launch, so those files do not need to be imported into IndexedDB.
- The Queue refresh control re-reads IndexedDB imports and server downloads, updating their visible titles and media URLs. Removing a downloaded queue item deletes its media file and server record; removing an imported item deletes its local IndexedDB blob and synced server metadata.
- Choosing a saved playlist or daily mix in the Queue selector immediately renders its tracks in the Queue and labels the selected source. Imported Spotify and Apple Music entries retain service links; Spotify saved tracks and followed artists are added to AuraAudio's Liked view. SoundCloud playlist details come from yt-dlp and local downloads are attempted only when yt-dlp marks an item downloadable.
- Duplicate server downloads are removed when a matching title and artist is downloaded again or when the download library is refreshed. Spotify connection uses client-side OAuth Authorization Code with PKCE; the client ID and tokens stay client-side and the local API only relays the short-lived OAuth callback.
- The mobile client uses the same download and media endpoints, so the phone controls playback while the server machine handles fetching and storage.

## Key endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/status` | Server state and configured download directory |
| `GET /api/search?q=…` | Catalog, library, and YouTube search |
| `GET /api/discovery/daily-mix` | A profile-specific mix based on listening history |
| `GET /api/discovery/artists` | Curated artist cards enriched with public biographies and portraits |
| `GET /api/discovery/artists/search?q=…` | Search MusicBrainz artist records |
| `GET /api/discovery/artists/:id` | Curated artist profile enriched with releases and tracks |
| `GET /api/discovery/artist/:mbid` | MusicBrainz profile by artist MBID |
| `GET /api/music/track-metadata?title=…&artist=…` | Resolve imported recording/artist metadata |
| `GET /api/library/artists/liked` / `POST /api/library/artists/toggle` | Read and toggle artist favorites |
| `GET /api/library/playlists` / `POST /api/library/playlists/:id/tracks` | List playlists and add a track from Queue |
| `POST /api/ytb/download` | Start an asynchronous download and return its ID |
| `GET /api/ytb/progress/:id` | Download progress, terminal status, error, and output path |
| `GET /api/media/:filename` | Stream a saved audio file with range support |
| `DELETE /api/library/downloads` | Delete a profile-owned download record and its server audio file |
| `DELETE /api/library/imported` | Delete imported metadata for a local audio file |
| `GET /mobile/` | Mobile web client |

## Operational requirements

Node.js runs the API and Electron. yt-dlp is loaded from the project `tools/` directory when installed with `npm run setup:ytdlp`, with the server process `PATH` as a fallback; FFmpeg must be available on `PATH` for MP3 conversion. Downloads enable yt-dlp's Node JavaScript runtime and remote EJS challenge scripts because YouTube may omit media formats when challenge solving is unavailable. A network connection is needed the first time yt-dlp fetches those scripts. LAN/mobile access requires binding to a LAN-reachable address and opening the chosen server port in the host firewall. Downloads live under the configured `storage.downloadsDir`, which defaults to the repository's `downloads/` folder.

## Current limits

The JSON database is intended for a single local app instance, not concurrent multi-user hosting. Imported desktop audio blobs remain on the desktop and are not uploaded to the mobile client. Mobile online playback downloads the selected track before playing it. The recommendation catalog is a small curated fallback; personalized mixes supplement it with live YouTube search results based on liked and recently played artists.

External artist metadata is best-effort and depends on MusicBrainz, Wikimedia, and Cover Art Archive availability. Profiles are held in process memory for a limited time; they are not currently persisted as a disk cache. Track metadata lookup is rate-limited to about one MusicBrainz request per second.
