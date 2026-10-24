// =========================================================================
// AuraAudio REST API Route Dispatcher (server/routes.js)
// Modular REST Endpoints for Auth, OAuth, Discovery, YTB Download, Library & Streaming
// =========================================================================

const url = require('url');
const path = require('path');
const fs = require('fs');
const MusicMetadataService = require('./music-metadata');
const { matchKey } = require('./music-metadata');

function downloadIdentity(track) {
    const title = String(track.title || path.parse(track.fileName || '').name).toLocaleLowerCase()
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s*\[(?:dl_)?[a-f0-9]{8,}\]\s*/gi, ' ')
        .replace(/\((?:official\s+)?(?:music\s+)?video\)|\[(?:official\s+)?(?:music\s+)?video\]/gi, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const artist = String(track.artist || '').toLocaleLowerCase().trim();
    const knownArtist = artist && !/^(unknown(?: artist)?|youtube(?: audio)?|local(?: track| audio)?)$/i.test(artist);
    return title ? { title, artist: knownArtist ? artist : '' } : null;
}

function sameDownload(trackA, trackB) {
    const a = downloadIdentity(trackA);
    const b = downloadIdentity(trackB);
    return !!a && !!b && a.title === b.title && (!a.artist || !b.artist || a.artist === b.artist);
}

class ApiRouter {
    constructor(db, authService, discoveryService, youtubeService, downloadsDir, musicMetadata) {
        this.db = db;
        this.auth = authService;
        this.discovery = discoveryService;
        this.ytb = youtubeService;
        this.downloadsDir = path.resolve(downloadsDir);
        this.musicMetadata = musicMetadata || new MusicMetadataService();
    }

    sendJson(res, statusCode, data) {
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Range'
        });
        res.end(JSON.stringify(data));
    }

    sendError(res, statusCode, message) {
        this.sendJson(res, statusCode, { error: true, message });
    }

    parseBody(req) {
        return new Promise((resolve, reject) => {
            let body = '';
            let size = 0;
            let failed = false;
            req.on('data', chunk => {
                if (failed) return;
                size += chunk.length;
                if (size > 1024 * 1024) {
                    failed = true;
                    const error = new Error('Request body exceeds the 1 MB limit.');
                    error.statusCode = 413;
                    reject(error);
                    req.resume();
                    return;
                }
                body += chunk;
            });
            req.on('end', () => {
                if (failed) return;
                try {
                    const parsed = body ? JSON.parse(body) : {};
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                        const error = new Error('Request body must be a JSON object.');
                        error.statusCode = 400;
                        return reject(error);
                    }
                    resolve(parsed);
                } catch (cause) {
                    const error = new Error('Malformed JSON request body.');
                    error.statusCode = 400;
                    reject(error);
                }
            });
            req.on('error', error => {
                if (!failed) reject(error);
            });
        });
    }

    getAuthUser(req) {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
        const token = authHeader.slice(7).trim();
        return this.auth.verifyToken(token);
    }

    async handle(req, res) {
        const fullUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
        const pathname = fullUrl.pathname;
        const method = req.method.toUpperCase();
        const query = Object.fromEntries(fullUrl.searchParams.entries());
        const diagnosticCategory = pathname.startsWith('/api/auth/') ? 'auth'
            : pathname.startsWith('/api/search') ? 'search'
                : pathname.startsWith('/api/discovery/') ? 'discovery'
                    : pathname.startsWith('/api/library/') ? 'library'
                        : pathname.startsWith('/api/ytb/') ? 'download'
                            : pathname.startsWith('/api/media/') ? 'media'
                                : pathname.startsWith('/api/covers/') ? 'artwork'
                                    : pathname.startsWith('/api/telemetry') ? 'telemetry' : 'api';
        const writeHead = res.writeHead.bind(res);
        res.writeHead = (statusCode, ...args) => {
            if (pathname.startsWith('/api/') && Number(statusCode) >= 400) {
                const authUser = this.getAuthUser(req);
                this.db.recordDiagnostic(authUser ? authUser.userId : 'guest', diagnosticCategory, method, Number(statusCode));
            }
            return writeHead(statusCode, ...args);
        };
        
        // CORS preflight: browsers send OPTIONS before POST/DELETE with JSON or Authorization headers.
        // It must answer 2xx or the real request is never sent.
        if (method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Range',
                'Access-Control-Allow-Private-Network': 'true',
                'Access-Control-Max-Age': '86400'
            });
            return res.end();
        }

        // GET /api/lyrics (Proxied to LRCLIB)
        if (pathname === '/api/lyrics' && method === 'GET') {
            let title = String(query.title || '').trim();
            const artist = String(query.artist || '').trim();
            if (!title) return this.sendJson(res, 200, { lines: [] });
            
            // Clean raw YouTube titles (e.g. remove "(Clip Officiel)")
            title = title.replace(/\((?:official\s+)?(?:music\s+)?video\)|\[(?:official\s+)?(?:music\s+)?video\]|\(clip officiel\)|\(audio\)|\(lyrics?\)/gi, '').trim();

            const fetchLyrics = async (url) => {
                try {
                    const lrcRes = await fetch(url, { 
                        headers: { 'User-Agent': 'AuraAudio/1.2.0 (https://github.com/auraplayer)' },
                        signal: AbortSignal.timeout(5000)
                    });
                    if (!lrcRes.ok) return null;
                    const data = await lrcRes.json();
                    if (!Array.isArray(data) || data.length === 0) return null;
                    return data.find(item => item.syncedLyrics) || data[0];
                } catch { return null; }
            };

            try {
                // Strategy 1: Exact Title + Artist
                let bestMatch = await fetchLyrics(`https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`);
                
                // Strategy 2: Title only (if Artist failed)
                if (!bestMatch && artist) {
                    bestMatch = await fetchLyrics(`https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}`);
                }

                // Strategy 3: Generic text query (helps with French accents/spelling variants)
                if (!bestMatch) {
                    bestMatch = await fetchLyrics(`https://lrclib.net/api/search?q=${encodeURIComponent(title + ' ' + artist)}`);
                }

                if (!bestMatch) return this.sendJson(res, 200, { lines: [] });

                if (bestMatch.syncedLyrics) {
                    const lines = bestMatch.syncedLyrics.split('\n')
                        .map(line => {
                            const match = line.match(/\[(\d+):(\d+\.\d+)\](.*)/);
                            if (match) {
                                const time = parseInt(match[1]) * 60 + parseFloat(match[2]);
                                const text = match[3].trim();
                                return text ? { t: time, text } : null;
                            }
                            return null;
                        }).filter(Boolean);
                    return this.sendJson(res, 200, { lines });
                } else if (bestMatch.plainLyrics) {
                    const lines = bestMatch.plainLyrics.split('\n').filter(l => l.trim()).map((text, i) => ({ t: i * 4, text }));
                    return this.sendJson(res, 200, { lines });
                }
                return this.sendJson(res, 200, { lines: [] });
            } catch (err) {
                return this.sendJson(res, 200, { lines: [] });
            }
            }
            if (method === 'GET' && (pathname === '/mobile' || pathname === '/mobile/')) {
                const mobileDistFile = path.resolve(__dirname, '..', 'mobile-dist', 'index.html');
                const mobileFile = fs.existsSync(mobileDistFile)
                    ? mobileDistFile
                    : path.resolve(__dirname, '..', 'mobile', 'index.html');
                if (!fs.existsSync(mobileFile)) return this.sendError(res, 404, 'Mobile app is not installed.');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
                return fs.createReadStream(mobileFile).pipe(res);
            }
            if (method === 'GET' && (pathname === '/manifest.webmanifest' || pathname === '/service-worker.js')) {
                const mobileDistPath = path.resolve(__dirname, '..', 'mobile-dist', path.basename(pathname));
                const mobileSourcePath = path.resolve(__dirname, '..', 'mobile', path.basename(pathname));
                const filePath = fs.existsSync(mobileDistPath) ? mobileDistPath : mobileSourcePath;
                if (!fs.existsSync(filePath)) return this.sendError(res, 404, 'Mobile app resource not found.');
                const isWorker = pathname === '/service-worker.js';
                res.writeHead(200, {
                    'Content-Type': isWorker ? 'application/javascript; charset=utf-8' : 'application/manifest+json; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    ...(isWorker ? { 'Service-Worker-Allowed': '/' } : {})
                });
                return fs.createReadStream(filePath).pipe(res);
            }
            if (method === 'GET' && pathname.startsWith('/assets/')) {
                let requestedAsset;
                try { requestedAsset = decodeURIComponent(pathname.slice('/assets/'.length)); }
                catch { return this.sendError(res, 400, 'Invalid asset path.'); }
                // Assets live beside server/ in the standalone build, never inside mobile-dist/.
                const assetRoot = path.resolve(__dirname, '..', 'assets');
                const assetPath = path.resolve(assetRoot, requestedAsset);
                if (!assetPath.startsWith(assetRoot + path.sep)) return this.sendError(res, 400, 'Invalid asset path.');
                if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) return this.sendError(res, 404, 'Asset not found.');
                const contentType = { '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(assetPath).toLowerCase()] || 'application/octet-stream';
                res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
                return fs.createReadStream(assetPath).pipe(res);
            }
            if (method === 'GET' && pathname === '/') {
                res.writeHead(302, { Location: '/mobile/', 'Cache-Control': 'no-store' });
                return res.end();
            }

            // -------------------------------------------------------------
            // SYSTEM & STATUS
            // -------------------------------------------------------------
            if (pathname === '/api/status' && method === 'GET') {
                return this.sendJson(res, 200, {
                    status: 'online',
                    app: 'AuraAudio Engine Backend',
                    version: '1.2.0',
                    node: process.version,
                    uptimeSeconds: Math.floor(process.uptime()),
                    downloadsDir: this.downloadsDir,
                    features: {
                        jwtAuth: true,
                        oauthMultiProvider: true,
                        youtubeDownloader: true,
                        artistDiscovery: true,
                        cloudLibrary: true
                    }
                });
            }

            // -------------------------------------------------------------
            // AUTHENTICATION & OAUTH 2.0
            // -------------------------------------------------------------
            // GET /api/auth/config (Public OAuth provider settings for UI)
            if (pathname === '/api/auth/config' && method === 'GET') {
                return this.sendJson(res, 200, {
                    providers: this.auth.getPublicOAuthConfig(),
                    emailPinEnabled: !!(this.auth.emailService && this.auth.emailService.isConfigured())
                });
            }

            // POST /api/auth/email/request (Passwordless email sign-in)
            if (pathname === '/api/auth/email/request' && method === 'POST') {
                const body = await this.parseBody(req);
                const result = await this.auth.requestEmailPin(body.email, body.username, req.socket.remoteAddress || 'unknown');
                return this.sendJson(res, 200, result);
            }

            // POST /api/auth/email/verify
            if (pathname === '/api/auth/email/verify' && method === 'POST') {
                const body = await this.parseBody(req);
                const result = this.auth.verifyEmailPin(body.email, body.code);
                return this.sendJson(res, 200, result);
            }

            // POST /api/auth/register (Local Sign Up)
            if (pathname === '/api/auth/register' && method === 'POST') {
                const body = await this.parseBody(req);
                const result = this.auth.register(body.username, body.email, body.password);
                return this.sendJson(res, 201, result);
            }

            // POST /api/auth/login (Local Sign In)
            if (pathname === '/api/auth/login' && method === 'POST') {
                const body = await this.parseBody(req);
                const result = this.auth.login(body.identifier || body.email || body.username, body.password);
                return this.sendJson(res, 200, result);
            }

            // GET /api/auth/me (Current Session Profile)
            if (pathname === '/api/auth/me' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                if (!authUser) {
                    return this.sendError(res, 401, 'Unauthorized or expired session.');
                }
                const user = this.db.findUserById(authUser.userId);
                if (!user) {
                    return this.sendError(res, 404, 'User account no longer found.');
                }
                return this.sendJson(res, 200, {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    avatarUrl: user.avatarUrl,
                    provider: user.provider,
                    createdAt: user.createdAt
                });
            }

            // GET /api/auth/oauth/:provider/url (Get OAuth redirect link)
            const oauthUrlMatch = pathname.match(/^\/api\/auth\/oauth\/([a-z0-9_-]+)\/url$/i);
            if (oauthUrlMatch && method === 'GET') {
                const provider = oauthUrlMatch[1].toLowerCase();
                const result = this.auth.getOAuthRedirectUrl(provider);
                return this.sendJson(res, 200, result);
            }

            // POST /api/auth/oauth/:provider/callback or mock login
            const oauthMockMatch = pathname.match(/^\/api\/auth\/oauth\/([a-z0-9_-]+)\/mock$/i);
            if (oauthMockMatch && method === 'POST') {
                const provider = oauthMockMatch[1].toLowerCase();
                const body = await this.parseBody(req);
                const result = this.auth.handleOAuthCallback(provider, body.code || 'mock_code', body.state || 'mock_state', body.profile);
                return this.sendJson(res, 200, result);
            }

            // -------------------------------------------------------------
            // ARTIST DISCOVERY, RECOMMENDATIONS & RELEASES
            // -------------------------------------------------------------
            // GET /api/discovery/artists
            if (pathname === '/api/discovery/artists' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const signals = this.db.getDiscoverySignals(userId);
                const { releases } = await this.discovery.getLatestReleases(signals);
                const artists = await this.discovery.getFeaturedArtists(signals, releases);
                res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=86400');
                return this.sendJson(res, 200, artists);
            }

            // Search real artist records for the discovery interface.
            if (pathname === '/api/discovery/artists/search' && method === 'GET') {
                const artists = await this.musicMetadata.searchArtists(query.q || '', 12);
                return this.sendJson(res, 200, artists);
            }

            // GET /api/artists/profile?name=  (used by the mobile artist pop-up)
            if (pathname === '/api/artists/profile' && method === 'GET') {
                const name = String(query.name || '').trim();
                if (!name) return this.sendError(res, 400, 'name is required');
                try {
                    const profile = await this.musicMetadata.getArtistByName(name);
                    if (profile) return this.sendJson(res, 200, profile);
                    return this.sendError(res, 404, 'Artist not found');
                } catch (error) {
                    console.warn('[Discovery] Artist profile lookup failed:', error.message);
                    return this.sendError(res, 502, 'Artist profile is temporarily unavailable.');
                }
            }

            // Fast artist-specific song lookup used to paint the artist sheet before
            // slower biography, release-group, and artwork providers finish.
            if (pathname === '/api/artists/songs' && method === 'GET') {
                const artist = String(query.artist || '').trim().slice(0, 120);
                if (artist.length < 2) return this.sendError(res, 400, 'Artist name must be at least 2 characters.');
                try {
                    const tracks = await this.musicMetadata.searchSongs(artist, 25);
                    const artistKey = matchKey(artist);
                    return this.sendJson(res, 200, tracks.filter(track => matchKey(track.artist) === artistKey).slice(0, 20));
                } catch (error) {
                    console.warn(`[Discovery] Artist songs lookup failed for "${artist}":`, error.message);
                    return this.sendJson(res, 200, []);
                }
            }

            // Related tracks use this artist's live MusicBrainz genre tags rather
            // than unrelated user-wide recommendations.
            if (pathname === '/api/discovery/related-tracks' && method === 'GET') {
                const artist = String(query.artist || '').trim().slice(0, 120);
                const tags = String(query.tags || '').split(',').map(tag => tag.trim().slice(0, 40)).filter(Boolean).slice(0, 5);
                if (artist.length < 2 || !tags.length) return this.sendJson(res, 200, { tracks: [] });
                try {
                    const results = await this.musicMetadata.searchSongs(tags.join(' '), 25);
                    const artistKey = matchKey(artist);
                    const unique = new Map();
                    for (const track of results) {
                        if (!track.title || !track.artist || matchKey(track.artist) === artistKey) continue;
                        const genre = matchKey(track.genre || '');
                        const genreMatches = genre && tags.some(rawTag => {
                            const tag = matchKey(rawTag);
                            if (/indie|independent|alternative/.test(tag)) return /alternative|rock|indie/.test(genre);
                            if (/electro|electronic|techno|house/.test(tag)) return /electro|electronic|dance/.test(genre);
                            if (/russia|russian/.test(tag)) return /russian|world|folk/.test(genre);
                            return genre.includes(tag) || tag.includes(genre);
                        });
                        if (!genreMatches) continue;
                        const key = `${matchKey(track.title)}|${matchKey(track.artist)}`;
                        if (!unique.has(key)) unique.set(key, track);
                    }
                    return this.sendJson(res, 200, { tracks: [...unique.values()].slice(0, 10) });
                } catch (error) {
                    console.warn(`[Discovery] Related tracks lookup failed for "${artist}":`, error.message);
                    return this.sendJson(res, 200, { tracks: [] });
                }
            }

            // GET /api/discovery/artists/:id — MusicBrainz id or a live name handle
            const artistDetailMatch = pathname.match(/^\/api\/discovery\/artists\/(.+)$/);
            if (artistDetailMatch && method === 'GET') {
                const handle = decodeURIComponent(artistDetailMatch[1]);
                const id = handle.startsWith('name:') ? decodeURIComponent(handle.slice(5)) : handle;
                try {
                    const profile = /^[a-f0-9-]{36}$/i.test(id)
                        ? await this.musicMetadata.getArtistProfile(id)
                        : await this.musicMetadata.getArtistByName(id);
                    if (profile) return this.sendJson(res, 200, profile);
                    return this.sendError(res, 404, 'Artist not found');
                } catch (error) {
                    console.warn('[Discovery] Artist detail lookup failed:', error.message);
                    return this.sendError(res, 502, 'Artist details are temporarily unavailable.');
                }
            }

            const dynamicArtistMatch = pathname.match(/^\/api\/discovery\/artist\/([a-f0-9-]{36})$/i);
            if (dynamicArtistMatch && method === 'GET') return this.sendJson(res, 200, await this.musicMetadata.getArtistProfile(dynamicArtistMatch[1]));

            if (pathname === '/api/music/track-metadata' && method === 'GET') {
                const result = await this.musicMetadata.lookupTrack(query.title || '', query.artist || '');
                return this.sendJson(res, 200, result || { found: false, message: 'No matching recording was found.' });
            }

            if ((pathname === '/api/music/album' || pathname === '/api/albums') && method === 'GET') {
                const result = pathname === '/api/albums'
                    ? await this.musicMetadata.lookupAlbumByName(query.title || query.name || '', query.artist || '')
                    : await this.musicMetadata.lookupAlbum(query.title || '', query.artist || '');
                return this.sendJson(res, 200, result || { found: false, message: 'No matching album was found.' });
            }

            // GET /api/discovery/daily-mix
            if (pathname === '/api/discovery/daily-mix' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const signals = this.db.getDiscoverySignals(userId);
                const paged = query.offset !== undefined || query.limit !== undefined;
                const offset = Math.max(0, Number.parseInt(query.offset || '0', 10) || 0);
                const limit = Math.max(4, Math.min(8, Number.parseInt(query.limit || '6', 10) || 6));
                res.setHeader('Cache-Control', 'no-store');
                const result = await this.discovery.buildDailyMix(signals, { offset, limit });
                // Older Discover clients expect this endpoint to return an array.
                // The current client opts into pagination with offset/limit.
                return this.sendJson(res, 200, paged ? result : result.mixes);
            }

            // GET /api/discovery/releases — personalized from liked artists,
            // liked songs and recently played music.
            if (pathname === '/api/discovery/releases' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const signals = this.db.getDiscoverySignals(userId);
                res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=86400');
                return this.sendJson(res, 200, await this.discovery.getLatestReleases(signals));
            }

            // GET /api/discovery/latest-releases?artist=name
            if (pathname === '/api/discovery/latest-releases' && method === 'GET') {
                const artist = String(query.artist || '').trim();
                if (artist.length < 2 || artist.length > 120) {
                    return this.sendError(res, 400, 'Artist name must be between 2 and 120 characters.');
                }
                try {
                    const result = await this.musicMetadata.getLatestReleasesByArtist(artist);
                    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
                    return this.sendJson(res, 200, result);
                } catch (error) {
                    console.warn(`[Discovery] Latest releases lookup failed for "${artist}":`, error.message);
                    return this.sendError(res, 502, 'Latest releases are temporarily unavailable. Try again shortly.');
                }
            }

            // GET /api/discovery/recommendations
            if (pathname === '/api/discovery/recommendations' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const signals = this.db.getDiscoverySignals(userId);
                const options = {
                    excludeLiked: query.excludeLiked === 'true',
                    excludePlayed: query.excludePlayed === 'true'
                };
                return this.sendJson(res, 200, await this.discovery.getRecommendations(signals, options));
            }

            // GET /api/discovery/profile (Signals used to personalize discovery)
            if (pathname === '/api/discovery/profile' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                return this.sendJson(res, 200, this.db.getDiscoverySignals(userId));
            }

            // POST /api/library/imported (Sync local track metadata only)
            if (pathname === '/api/library/imported' && method === 'POST') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const body = await this.parseBody(req);
                if (!Array.isArray(body.tracks)) return this.sendError(res, 400, 'Tracks array is required');
                const synced = this.db.syncImportedMedia(userId, body.tracks);
                return this.sendJson(res, 200, { synced: synced.length });
            }

            // DELETE /api/library/imported (Remove imported metadata for this profile)
            if (pathname === '/api/library/imported' && method === 'DELETE') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const body = await this.parseBody(req);
                const removed = this.db.removeImportedMedia(userId, body);
                return this.sendJson(res, 200, { removed });
            }

            // POST /api/library/played (Record a successful playback)
            if (pathname === '/api/library/played' && method === 'POST') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const body = await this.parseBody(req);
                if (!body.track || typeof body.track.title !== 'string') return this.sendError(res, 400, 'Track title is required');
                let listenedSeconds = null;
                if (body.listenedSeconds !== undefined) {
                    listenedSeconds = Number(body.listenedSeconds);
                    if (!Number.isFinite(listenedSeconds) || listenedSeconds < 0 || listenedSeconds > 86400) {
                        return this.sendError(res, 400, 'Listened seconds must be a number between 0 and 86,400.');
                    }
                }
                const recorded = this.db.recordPlay(userId, body.track, listenedSeconds);
                return this.sendJson(res, 202, { recorded: !!recorded });
            }

            if (pathname === '/api/telemetry/preferences' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                return this.sendJson(res, 200, this.db.getPlayHistoryPreferences(authUser ? authUser.userId : 'guest'));
            }

            if (pathname === '/api/telemetry/preferences' && method === 'PUT') {
                const authUser = this.getAuthUser(req);
                const body = await this.parseBody(req);
                const retentionDays = Number(body.retentionDays);
                const minimumListenSeconds = Number(body.minimumListenSeconds);
                const validRetention = new Set([0, 7, 30, 90, 180, 365]);
                const validMinimumListen = new Set([0, 10, 30, 60, 120]);
                if (!Number.isInteger(retentionDays) || !validRetention.has(retentionDays)) {
                    return this.sendError(res, 400, 'Retention must be 0, 7, 30, 90, 180, or 365 days.');
                }
                if (!Number.isInteger(minimumListenSeconds) || !validMinimumListen.has(minimumListenSeconds)) {
                    return this.sendError(res, 400, 'Minimum listen duration must be 0, 10, 30, 60, or 120 seconds.');
                }
                const preferences = this.db.setPlayHistoryPreferences(authUser ? authUser.userId : 'guest', {
                    retentionDays, minimumListenSeconds
                });
                return this.sendJson(res, 200, preferences);
            }

            if (pathname === '/api/telemetry' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                return this.sendJson(res, 200, this.db.getTelemetry(userId));
            }

            if (pathname === '/api/telemetry' && method === 'DELETE') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                return this.sendJson(res, 200, { cleared: this.db.clearTelemetry(userId) });
            }

            // GET /api/search?q=query
            if (pathname === '/api/search' && method === 'GET') {
                const q = String(query.q || '').trim();
                if (q.length > 120) return this.sendError(res, 400, 'Search query must be 120 characters or fewer.');
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const feedResults = q ? await this.discovery.search(q) : { artists: [], tracks: [], releases: [] };
                const library = this.db.searchLibrary(userId, q, 30);
                const withTimeout = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), ms))]);
                // Internal lookups pass yt=0 / artists=0 to skip the slow external providers
                const wantYoutube = query.yt !== '0', wantArtists = query.artists !== '0';
                const [youtube, onlineArtists] = await Promise.all([
                    q && wantYoutube
                        ? this.ytb.search(q, 8).catch(error => { console.warn('[Search] YouTube results unavailable:', error.message); return []; })
                        : [],
                    q.length >= 2 && wantArtists
                        ? withTimeout(this.musicMetadata.searchArtists(q, 6).catch(() => []), 3500)
                        : []
                ]);
                // Real MusicBrainz artists, enriched with a picture from Wikipedia.
                const matchedArtists = (onlineArtists || []).filter(artist => artist.name && artist.score >= 70).slice(0, 5);
                const artists = await Promise.all(matchedArtists.map(async artist => {
                    const wiki = await withTimeout(this.musicMetadata.wikipediaSummary(artist.name), 2500);
                    return { id: artist.id, name: artist.name, genre: [artist.type, ...(artist.tags || []).slice(0, 2)].filter(Boolean).join(' · ') || 'Artist',
                        image: wiki?.image || '', description: artist.disambiguation || wiki?.description || '' };
                }));
                const youtubeResults = (youtube || []).map(video => {
                    const videoId = String(video.id || '').replace(/^yt_/, '');
                    const externalUrl = /^https?:\/\//i.test(video.url || '') ? video.url : (/^[\w-]{11}$/.test(videoId) ? `https://www.youtube.com/watch?v=${videoId}` : '');
                    return { ...video, externalUrl };
                });
                return this.sendJson(res, 200, { ...feedResults, artists, library, youtube: youtubeResults });
            }

            // -------------------------------------------------------------
            // YOUTUBE SEARCH & LOCAL DOWNLOAD ENGINE
            // -------------------------------------------------------------
            // GET /api/ytb/search?q=query
            if (pathname === '/api/ytb/search' && method === 'GET') {
                const q = String(query.q || 'synthwave').trim();
                if (q.length > 120) return this.sendError(res, 400, 'Search query must be 120 characters or fewer.');
                const results = await this.ytb.search(q);
                return this.sendJson(res, 200, results);
            }

            // POST /api/ytb/info
            if (pathname === '/api/ytb/info' && method === 'POST') {
                const body = await this.parseBody(req);
                if (!body.url) return this.sendError(res, 400, 'YouTube URL is required');
                const info = await this.ytb.getVideoInfo(body.url);
                return this.sendJson(res, 200, info);
            }

            // POST /api/ytb/download (Start Audio Download to Local Folder)
            if (pathname === '/api/ytb/download' && method === 'POST') {
                const body = await this.parseBody(req);
                if (!body.url) return this.sendError(res, 400, 'Target URL is required');

                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';

                let downloadId;
                const downloadPromise = this.ytb.downloadAudio(body.url, body.title, id => { downloadId = id; });
                
                downloadPromise.then(result => {
                    for (const existing of this.db.getDownloads(userId)) {
                        if (!sameDownload(result, existing)) continue;
                        const previousPath = path.basename(existing.fileName || '') === existing.fileName ? path.join(this.downloadsDir, existing.fileName) : '';
                        try { if (previousPath && fs.existsSync(previousPath)) fs.unlinkSync(previousPath); }
                        catch (error) { console.warn('[API] Could not remove duplicate downloaded audio:', error.message); continue; }
                        if (/^cover-[a-f0-9]{24}\.(?:jpg|png|webp|gif)$/.test(existing.coverFile || '')) {
                            try { fs.unlinkSync(path.join(this.downloadsDir, existing.coverFile)); } catch {}
                        }
                        this.db.removeDownload(userId, existing.fileName);
                    }
                    this.db.addDownloadRecord({ userId, ...result, coverChecked: true });
                    this.db.recordActivity(userId, 'download', result);
                    const progress = this.ytb.getDownloadProgress(downloadId);
                    if (progress) progress.result = { ...result, streamUrl: `/api/media/${encodeURIComponent(result.fileName)}` };
                }).catch(error => {
                    console.error('[API] YouTube download failed:', error.message);
                    const progress = this.ytb.getDownloadProgress(downloadId);
                    if (progress) {
                        progress.status = 'failed';
                        progress.error = error.message;
                    }
                });
                
                return this.sendJson(res, 202, {
                    success: true,
                    id: downloadId,
                    status: 'downloading',
                    downloadsDir: this.downloadsDir
                });
            }

            // GET /api/ytb/progress/:id
            const ytbProgressMatch = pathname.match(/^\/api\/ytb\/progress\/([a-z0-9_-]+)$/i);
            if (ytbProgressMatch && method === 'GET') {
                const progress = this.ytb.getDownloadProgress(ytbProgressMatch[1]);
                return this.sendJson(res, 200, progress || { status: 'unknown' });
            }
            // POST /api/ytb/cancel/:id (Panic Kill Downloads)
            const ytbCancelMatch = pathname.match(/^\/api\/ytb\/cancel\/([a-z0-9_-]+)$/i);
            if (ytbCancelMatch && method === 'POST') {
                const success = this.ytb.killDownload(ytbCancelMatch[1]);
                return this.sendJson(res, 200, { success, message: success ? 'Download killed' : 'Download not found or already finished' });
            }

            // -------------------------------------------------------------
            // LOCAL MEDIA STREAMING (Downloaded Audio Files)
            // -------------------------------------------------------------
            const mediaMatch = pathname.match(/^\/api\/media\/(.+)$/);
            if (mediaMatch && method === 'GET') {
                const decodedFilename = decodeURIComponent(mediaMatch[1]);
                if (path.basename(decodedFilename) !== decodedFilename || decodedFilename.includes('..')) {
                    return this.sendError(res, 400, 'Invalid media filename');
                }

                const filePath = path.join(this.downloadsDir, decodedFilename);
                if (!fs.existsSync(filePath)) {
                    return this.sendError(res, 404, 'Audio file not found');
                }

                const stat = fs.statSync(filePath);
                const fileSize = stat.size;
                const range = req.headers.range;

                if (range) {
                    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
                    if (!match || (!match[1] && !match[2])) {
                        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}`, 'Access-Control-Allow-Origin': '*' });
                        return res.end();
                    }
                    const start = match[1] ? Number(match[1]) : Math.max(0, fileSize - Number(match[2]));
                    const end = match[1] && match[2] ? Number(match[2]) : fileSize - 1;
                    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= fileSize || end < start || end >= fileSize) {
                        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}`, 'Access-Control-Allow-Origin': '*' });
                        return res.end();
                    }
                    const chunksize = (end - start) + 1;
                    const file = fs.createReadStream(filePath, { start, end });
                    const head = {
                        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                        'Accept-Ranges': 'bytes',
                        'Content-Length': chunksize,
                        'Content-Type': 'audio/mpeg',
                        'Access-Control-Allow-Origin': '*'
                    };
                    res.writeHead(206, head);
                    return file.pipe(res);
                } else {
                    const head = {
                        'Content-Length': fileSize,
                        'Content-Type': 'audio/mpeg',
                        'Access-Control-Allow-Origin': '*'
                    };
                    res.writeHead(200, head);
                    return fs.createReadStream(filePath).pipe(res);
                }
            }

            const coverMatch = pathname.match(/^\/api\/covers\/([^/]+)$/);
            if (coverMatch && method === 'GET') {
                const fileName = decodeURIComponent(coverMatch[1]);
                if (!/^cover-[a-f0-9]{24}\.(?:jpg|png|webp|gif)$/.test(fileName)) {
                    return this.sendError(res, 400, 'Invalid cover filename.');
                }
                const filePath = path.join(this.downloadsDir, fileName);
                if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                    return this.sendError(res, 404, 'Cover image not found.');
                }
                const contentType = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[path.extname(fileName).slice(1)];
                res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
                return fs.createReadStream(filePath).pipe(res);
            }

            // -------------------------------------------------------------
            // LIKED SONGS & PLAYLISTS (Cloud Library)
            // -------------------------------------------------------------
            // GET /api/library/liked
            if (pathname === '/api/library/liked' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const downloads = this.db.getDownloads(userId);
                const liked = this.db.getLikedSongs(userId).map(track => {
                    const match = downloads.find(download => sameDownload(track, download));
                    const fileName = String(match?.fileName || '');
                    const safePath = fileName && path.basename(fileName) === fileName && !fileName.includes('..')
                        ? path.join(this.downloadsDir, fileName)
                        : '';
                    if (!safePath || !fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) return track;
                    return {
                        ...track,
                        fileName,
                        streamUrl: `/api/media/${encodeURIComponent(fileName)}`,
                        cover: track.cover || match.cover || '',
                        duration: track.duration || match.duration || 0
                    };
                });
                return this.sendJson(res, 200, liked);
            }

            if (pathname === '/api/library/liked/import' && method === 'POST') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const body = await this.parseBody(req);
                if (!Array.isArray(body.tracks)) return this.sendError(res, 400, 'Tracks must be an array.');
                return this.sendJson(res, 200, this.db.importLikedSongs(userId, body.tracks));
            }

            if (pathname === '/api/library/liked/artwork' && method === 'POST') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const body = await this.parseBody(req);
                if (typeof body.trackId !== 'string' || !body.trackId.trim() || body.trackId.length > 240) {
                    return this.sendError(res, 400, 'A valid liked-track ID is required.');
                }
                const cover = typeof body.cover === 'string' ? body.cover : '';
                const album = typeof body.album === 'string' ? body.album.trim().slice(0, 240) : '';
                if (!cover && !album) return this.sendError(res, 400, 'Artwork or album metadata is required.');
                if (cover && (cover.length > 1500 || !(/^https?:\/\//i.test(cover) || /^\/api\/covers\/cover-[a-f0-9]{24}\.(?:jpg|png|webp|gif)$/i.test(cover)))) {
                    return this.sendError(res, 400, 'A valid artwork URL is required.');
                }
                const updated = this.db.updateLikedSongArtwork(userId, body.trackId, cover, album);
                return this.sendJson(res, 200, { updated });
            }

            // GET /api/library/downloads
            if (pathname === '/api/library/downloads' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const downloads = [];
                for (const track of this.db.getDownloads(userId)) {
                    const fileName = String(track.fileName || '');
                    const filePath = fileName && path.basename(fileName) === fileName && !fileName.includes('..')
                        ? path.join(this.downloadsDir, fileName)
                        : '';
                    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                        console.info(`[Library] Pruned stale download record: ${fileName || '(invalid filename)'}`);
                        this.db.removeDownload(userId, fileName);
                        continue;
                    }
                    if (downloads.some(existing => sameDownload(track, existing))) {
                        const duplicatePath = filePath;
                        try {
                            if (duplicatePath && fs.existsSync(duplicatePath)) fs.unlinkSync(duplicatePath);
                            if (/^cover-[a-f0-9]{24}\.(?:jpg|png|webp|gif)$/.test(track.coverFile || '')) {
                                try { fs.unlinkSync(path.join(this.downloadsDir, track.coverFile)); } catch {}
                            }
                            this.db.removeDownload(userId, track.fileName);
                        } catch (error) { console.warn('[Library] Could not remove duplicate download:', error.message); }
                        continue;
                    }
                    downloads.push(track);
                }
                const result = downloads.map(track => ({
                    ...track,
                    streamUrl: `/api/media/${encodeURIComponent(track.fileName)}`
                }));
                for (const track of result) {
                    const safeCoverFile = /^cover-[a-f0-9]{24}\.(?:jpg|png|webp|gif)$/.test(track.coverFile || '');
                    if (safeCoverFile && fs.existsSync(path.join(this.downloadsDir, track.coverFile))) {
                        track.cover = `/api/covers/${encodeURIComponent(track.coverFile)}`;
                        continue;
                    }
                    if (track.coverChecked) {
                        track.coverFile = '';
                        track.cover = '';
                        continue;
                    }
                    const cached = track.fileName
                        ? await this.ytb.resolveAndCacheCover(track.artist || '', track.title || '', track.fileName, track.cover || '')
                        : null;
                    if (cached) {
                        this.db.updateDownloadCover(userId, track.fileName, cached.coverFile);
                        track.coverFile = cached.coverFile;
                        track.cover = cached.coverUrl;
                    } else {
                        this.db.updateDownloadCover(userId, track.fileName, '');
                        track.coverFile = '';
                        track.cover = '';
                    }
                }
                return this.sendJson(res, 200, result);
            }

            // DELETE /api/library/downloads (Remove a downloaded file and its record)
            if (pathname === '/api/library/downloads' && method === 'DELETE') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const body = await this.parseBody(req);
                const fileName = typeof body.fileName === 'string' ? body.fileName : '';
                if (!fileName || path.basename(fileName) !== fileName || fileName.includes('..')) {
                    return this.sendError(res, 400, 'A valid download filename is required');
                }
                const record = this.db.getDownloads(userId).find(item => item.fileName === fileName);
                if (!record) return this.sendError(res, 404, 'Downloaded track not found');
                const filePath = path.join(this.downloadsDir, fileName);
                try {
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch (error) {
                    return this.sendError(res, 500, `Could not delete downloaded audio: ${error.message}`);
                }
                this.db.removeDownload(userId, fileName);
                const coverFile = record.coverFile;
                if (/^cover-[a-f0-9]{24}\.(?:jpg|png|webp|gif)$/.test(coverFile || '')) {
                    try { fs.unlinkSync(path.join(this.downloadsDir, coverFile)); } catch {}
                }
                return this.sendJson(res, 200, { deleted: true, fileName });
            }

            // POST /api/library/liked/toggle
            if (pathname === '/api/library/liked/toggle' && method === 'POST') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const body = await this.parseBody(req);
                if (!body.track) return this.sendError(res, 400, 'Track payload is required');
                const result = this.db.toggleLikeSong(userId, body.track);
                this.db.recordActivity(userId, result.liked ? 'like_added' : 'like_removed', body.track);
                return this.sendJson(res, 200, result);
            }

            // GET /api/library/playlists
            if (pathname === '/api/library/playlists' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const playlists = this.db.getPlaylists(userId);
                return this.sendJson(res, 200, playlists);
            }

            if (pathname === '/api/library/artists/liked' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                return this.sendJson(res, 200, this.db.getLikedArtists(authUser ? authUser.userId : 'guest'));
            }

            if (pathname === '/api/library/artists/refresh-images' && method === 'POST') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const body = await this.parseBody(req);
                if (body.names !== undefined && (!Array.isArray(body.names) || body.names.some(name => typeof name !== 'string'))) {
                    return this.sendError(res, 400, 'Artist names must be an array of strings.');
                }
                const requestedNames = new Set((body.names || []).map(name => name.trim().toLowerCase()).filter(Boolean));
                const artists = this.db.getLikedArtists(userId).filter(artist =>
                    requestedNames.size ? requestedNames.has(String(artist.name || '').toLowerCase()) : !artist.image
                );
                let updated = 0;
                const failed = [];
                for (let index = 0; index < artists.length; index += 3) {
                    const results = await Promise.all(artists.slice(index, index + 3).map(async artist => {
                        try {
                            const refreshed = await this.musicMetadata.getFeaturedArtist(
                                { id: artist.id, key: artist.key, name: artist.name, image: artist.image },
                                { force: true }
                            );
                            return refreshed.image && refreshed.image !== artist.image
                                ? { artist, image: refreshed.image }
                                : { failed: artist.name };
                        } catch (error) {
                            console.warn(`[Library] Could not refresh image for "${artist.name}":`, error.message);
                            return { failed: artist.name };
                        }
                    }));
                    const updates = results.filter(result => result.artist);
                    updated += this.db.updateLikedArtistImages(userId, updates);
                    failed.push(...results.filter(result => result.failed).map(result => result.failed));
                }
                return this.sendJson(res, 200, { updated, failed });
            }

            if (pathname === '/api/library/artists/toggle' && method === 'POST') {
                const authUser = this.getAuthUser(req);
                const body = await this.parseBody(req);
                if (!body.artist || !body.artist.name) return this.sendError(res, 400, 'Artist payload is required');
                return this.sendJson(res, 200, this.db.toggleLikedArtist(authUser ? authUser.userId : 'guest', body.artist));
            }

            if (pathname === '/api/library/artists/import' && method === 'POST') {
                const authUser = this.getAuthUser(req);
                const body = await this.parseBody(req);
                if (!Array.isArray(body.artists)) return this.sendError(res, 400, 'Artists must be an array.');
                return this.sendJson(res, 200, this.db.importLikedArtists(authUser ? authUser.userId : 'guest', body.artists));
            }

            // POST /api/library/playlists
            if (pathname === '/api/library/playlists' && method === 'POST') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const body = await this.parseBody(req);
                const playlist = this.db.createPlaylist(userId, body.name, body.description, body.isPublic);
                if (playlist) this.db.recordActivity(userId, 'playlist_created', { name: playlist.name });
                return this.sendJson(res, 201, playlist);
            }

            // POST /api/library/playlists/:id/tracks
            const playlistBulkTracksMatch = pathname.match(/^\/api\/library\/playlists\/([a-z0-9_-]+)\/tracks\/bulk$/i);
            if (playlistBulkTracksMatch && method === 'POST') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const body = await this.parseBody(req);
                if (!Array.isArray(body.tracks)) return this.sendError(res, 400, 'Tracks must be an array.');
                const playlist = this.db.addTracksToPlaylist(playlistBulkTracksMatch[1], body.tracks, userId);
                if (!playlist) return this.sendError(res, 404, 'Playlist not found or access denied.');
                return this.sendJson(res, 200, playlist);
            }

            const playlistAddTrackMatch = pathname.match(/^\/api\/library\/playlists\/([a-z0-9_-]+)\/tracks$/i);
            if (playlistAddTrackMatch && method === 'POST') {
                const playlistId = playlistAddTrackMatch[1];
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const body = await this.parseBody(req);
                if (!body.track) return this.sendError(res, 400, 'Track payload is required');
                const updated = this.db.addTrackToPlaylist(playlistId, body.track, userId);
                if (!updated) return this.sendError(res, 404, 'Playlist not found');
                this.db.recordActivity(userId, 'playlist_track_added', { title: body.track.title, artist: body.track.artist, name: updated.name });
                return this.sendJson(res, 200, updated);
            }

            // DELETE /api/library/playlists/:id
            const playlistDeleteMatch = pathname.match(/^\/api\/library\/playlists\/([a-z0-9_-]+)$/i);
            if (playlistDeleteMatch && method === 'DELETE') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const deleted = this.db.deletePlaylist(playlistDeleteMatch[1], userId);
                return this.sendJson(res, 200, { success: deleted });
            }

            // 404 For Unmatched API Routes
            return this.sendError(res, 404, `Route ${method} ${pathname} not found on AuraAudio API`);

        } catch (err) {
            console.error('[ApiRouter Error]:', err);
            return this.sendError(res, err.statusCode || 500, err.statusCode === 502 ? err.message : (err.message || 'Internal Server Error'));
        }
    }


module.exports = ApiRouter;
