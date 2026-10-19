// =========================================================================
// AuraAudio REST API Route Dispatcher (server/routes.js)
// Modular REST Endpoints for Auth, OAuth, Discovery, YTB Download, Library & Streaming
// =========================================================================

const url = require('url');
const path = require('path');
const fs = require('fs');
const MusicMetadataService = require('./music-metadata');

function downloadIdentity(track) {
    const title = String(track.title || path.parse(track.fileName || '').name).toLocaleLowerCase()
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s*\[(?:dl_)?[a-f0-9]{8,}\]\s*/gi, ' ')
        .replace(/\((?:official\s+)?(?:music\s+)?video\)|\[(?:official\s+)?(?:music\s+)?video\]/gi, ' ')
        .replace(/\s+/g, ' ').trim();
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
    constructor(db, authService, discoveryService, youtubeService, downloadsDir) {
        this.db = db;
        this.auth = authService;
        this.discovery = discoveryService;
        this.ytb = youtubeService;
        this.downloadsDir = path.resolve(downloadsDir);
        this.musicMetadata = new MusicMetadataService();
    }

    sendJson(res, statusCode, data) {
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
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

        // Handle CORS preflight
        if (method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
            });
            return res.end();
        }

        try {
            if (pathname === '/api/integrations/apple/validate' && method === 'POST') {
                const body = await this.parseBody(req);
                const developerToken = typeof body.developerToken === 'string' ? body.developerToken.trim() : '';
                if (developerToken.split('.').length !== 3) return this.sendError(res, 400, 'Paste a signed Apple Music developer token (JWT).');
                const headers = { Authorization: `Bearer ${developerToken}` };
                try {
                    const origin = typeof body.origin === 'string' ? new URL(body.origin).origin : '';
                    if (origin) headers.Origin = origin;
                } catch (_) { return this.sendError(res, 400, 'The app origin is invalid.'); }
                const upstream = await fetch('https://api.music.apple.com/v1/test', { headers, signal: AbortSignal.timeout(12000) });
                const responseText = await upstream.text();
                const payload = responseText ? (() => { try { return JSON.parse(responseText); } catch (_) { return {}; } })() : {};
                if (!upstream.ok) {
                    const message = payload.errors?.[0]?.detail || payload.errors?.[0]?.title || `Apple Music API rejected the token (HTTP ${upstream.status}).`;
                    return this.sendError(res, upstream.status, message);
                }
                return this.sendJson(res, 200, { valid: true, message: 'Apple Music developer token confirmed.' });
            }
            if (pathname === '/api/integrations/soundcloud/playlist' && method === 'POST') {
                const body = await this.parseBody(req);
                let target;
                try { target = new URL(body.url); } catch { return this.sendError(res, 400, 'Enter a valid SoundCloud playlist URL.'); }
                if (!['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(target.hostname)) return this.sendError(res, 400, 'Only SoundCloud playlist URLs are supported.');
                return this.sendJson(res, 200, await this.ytb.getPlaylistInfo(target.toString()));
            }
            if (pathname === '/api/integrations/apple/playlist' && method === 'POST') {
                const body = await this.parseBody(req);
                let target;
                try { target = new URL(body.url); } catch { return this.sendError(res, 400, 'Enter a valid Apple Music playlist URL.'); }
                if (target.hostname !== 'music.apple.com') return this.sendError(res, 400, 'Only Apple Music URLs are supported.');
                if (typeof body.developerToken !== 'string' || body.developerToken.split('.').length !== 3) return this.sendError(res, 400, 'Paste a valid Apple Music developer token to import Apple Music catalog playlists.');
                const parts = target.pathname.split('/').filter(Boolean);
                const playlistId = parts.find(part => /^(?:pl|p)\./i.test(part));
                if (!playlistId) return this.sendError(res, 400, 'The Apple Music URL must point to a playlist.');
                if (body.musicUserToken && (typeof body.musicUserToken !== 'string' || body.musicUserToken.length > 8192)) return this.sendError(res, 400, 'The Apple Music user token is invalid. Reconnect Apple Music and try again.');
                const appleHeaders = { Authorization: `Bearer ${body.developerToken}` };
                if (body.musicUserToken) appleHeaders['Music-User-Token'] = body.musicUserToken;
                let upstream = await fetch(`https://api.music.apple.com/v1/catalog/${encodeURIComponent(parts[0] || 'us')}/playlists/${encodeURIComponent(playlistId)}?include=tracks`, { headers: appleHeaders });
                let payload = await upstream.json().catch(() => ({}));
                if (!upstream.ok && body.musicUserToken && [403, 404].includes(upstream.status)) {
                    upstream = await fetch(`https://api.music.apple.com/v1/me/library/playlists/${encodeURIComponent(playlistId)}?include=tracks`, { headers: appleHeaders });
                    payload = await upstream.json().catch(() => ({}));
                }
                if (!upstream.ok) return this.sendError(res, upstream.status, payload.errors?.[0]?.detail || 'Apple Music could not return this playlist.');
                const playlist = payload.data?.[0];
                let appleTracks = [...(playlist?.relationships?.tracks?.data || [])];
                let next = playlist?.relationships?.tracks?.next || '';
                while (next && appleTracks.length < 1000) {
                    const nextUrl = new URL(next, 'https://api.music.apple.com');
                    if (nextUrl.hostname !== 'api.music.apple.com') break;
                    const pageResponse = await fetch(nextUrl.toString(), { headers: appleHeaders });
                    const page = await pageResponse.json().catch(() => ({}));
                    if (!pageResponse.ok) break;
                    appleTracks.push(...(page.data || []));
                    next = page.next || '';
                }
                return this.sendJson(res, 200, { name: playlist?.attributes?.name || 'Apple Music playlist', tracks: appleTracks.slice(0, 1000).map(track => ({
                    id: `apple:${track.id}`, title: track.attributes?.name || 'Untitled', artist: track.attributes?.artistName || '',
                    duration: Math.floor((track.attributes?.durationInMillis || 0) / 1000), source: 'apple-music', sourceUrl: track.attributes?.url || ''
                })) });
            }
            if (method === 'GET' && (pathname === '/mobile' || pathname === '/mobile/')) {
                const mobileFile = path.resolve(__dirname, '..', 'mobile', 'index.html');
                if (!fs.existsSync(mobileFile)) return this.sendError(res, 404, 'Mobile app is not installed.');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
                return fs.createReadStream(mobileFile).pipe(res);
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
                const artists = await Promise.all(this.discovery.getArtists().map(artist => this.musicMetadata.getFeaturedArtist(artist).catch(() => ({ ...artist, image: '' }))));
                return this.sendJson(res, 200, artists);
            }

            // Search real artist records for the discovery interface.
            if (pathname === '/api/discovery/artists/search' && method === 'GET') {
                const artists = await this.musicMetadata.searchArtists(query.q || '', 12);
                return this.sendJson(res, 200, artists);
            }

            // GET /api/discovery/artists/:id
            const artistDetailMatch = pathname.match(/^\/api\/discovery\/artists\/([a-z0-9_-]+)$/i);
            if (artistDetailMatch && method === 'GET') {
                const artist = this.discovery.getArtistById(artistDetailMatch[1]);
                if (!artist && /^[a-f0-9-]{36}$/i.test(artistDetailMatch[1])) {
                    return this.sendJson(res, 200, await this.musicMetadata.getArtistProfile(artistDetailMatch[1]));
                }
                try {
                    const profile = /^[a-f0-9-]{36}$/i.test(artistDetailMatch[1])
                        ? await this.musicMetadata.getArtistProfile(artistDetailMatch[1], artist)
                        : artist && await this.musicMetadata.getArtistByName(artist.name, artist);
                    if (profile) return this.sendJson(res, 200, profile);
                } catch (error) { console.warn('[Discovery] Artist profile lookup failed:', error.message); }
                if (!artist) return this.sendError(res, 404, 'Artist not found');
                return this.sendJson(res, 200, await this.musicMetadata.getFeaturedArtist(artist));
            }

            const dynamicArtistMatch = pathname.match(/^\/api\/discovery\/artist\/([a-f0-9-]{36})$/i);
            if (dynamicArtistMatch && method === 'GET') return this.sendJson(res, 200, await this.musicMetadata.getArtistProfile(dynamicArtistMatch[1]));

            if (pathname === '/api/music/track-metadata' && method === 'GET') {
                const result = await this.musicMetadata.lookupTrack(query.title || '', query.artist || '');
                return this.sendJson(res, 200, result || {});
            }

            // GET /api/discovery/daily-mix
            if (pathname === '/api/discovery/daily-mix' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const signals = this.db.getDiscoverySignals(userId);
                const artists = [...new Map([
                    ...(signals.recentTracks || []).map(track => track.artist),
                    ...(signals.likedTracks || []).map(track => track.artist)
                ].map(artist => String(artist || '').trim()).filter(Boolean).map(artist => [artist.toLowerCase(), artist])).values()].slice(0, 4);
                const relatedResults = await Promise.all(artists.map(artist =>
                    this.ytb.search(`${artist} popular songs`, 4).catch(error => {
                        console.warn(`[Discovery] Could not find related tracks for ${artist}:`, error.message);
                        return [];
                    })
                ));
                const relatedTracks = relatedResults.flat().map(track => ({
                    id: `yt_${track.id}`,
                    title: track.title,
                    artist: track.uploader || 'YouTube',
                    playQuery: track.url || `https://www.youtube.com/watch?v=${track.id}`,
                    duration: track.duration,
                    reason: 'Because you like this artist'
                }));
                const moodQueries = [
                    ['mix_electro', 'electro house electronic music hits'],
                    ['mix_pop', 'popular pop songs hits'],
                    ['mix_rock', 'rock music classics hits']
                ];
                const moodResults = await Promise.all(moodQueries.map(async ([id, search]) => {
                    try { return [id, await this.ytb.search(search, 6)]; }
                    catch (error) { console.warn(`[Discovery] Could not load ${id} tracks:`, error.message); return [id, []]; }
                }));
                const moodTracks = Object.fromEntries(moodResults.map(([id, results]) => [id, results.map(track => ({
                    id: `yt_${track.id}`, title: track.title, artist: track.uploader || 'YouTube',
                    playQuery: track.url || `https://www.youtube.com/watch?v=${track.id}`,
                    duration: track.duration, reason: 'Curated mood mix'
                }))]));
                return this.sendJson(res, 200, this.discovery.getDailyMixes(signals, relatedTracks, moodTracks));
            }

            // GET /api/discovery/releases
            if (pathname === '/api/discovery/releases' && method === 'GET') {
                return this.sendJson(res, 200, this.discovery.getLatestReleases());
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
                return this.sendJson(res, 200, this.discovery.getRecommendations([], signals, options));
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
                this.db.recordPlay(userId, body.track);
                return this.sendJson(res, 202, { recorded: true });
            }

            // GET /api/search?q=query
            if (pathname === '/api/search' && method === 'GET') {
                const q = String(query.q || '').trim();
                if (q.length > 120) return this.sendError(res, 400, 'Search query must be 120 characters or fewer.');
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const catalogResults = this.discovery.search(q);
                const library = this.db.searchLibrary(userId, q, 30);
                let youtube = [];
                if (q) {
                    try {
                        youtube = await this.ytb.search(q, 8);
                    } catch (error) {
                        console.warn('[Search] YouTube results unavailable:', error.message);
                    }
                }
                return this.sendJson(res, 200, { ...catalogResults, library, youtube });
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
                        this.db.removeDownload(userId, existing.fileName);
                    }
                    this.db.addDownloadRecord({ userId, ...result });
                    const progress = this.ytb.getDownloadProgress(downloadId);
                    if (progress) progress.result = { ...result, streamUrl: `/api/media/${encodeURIComponent(result.fileName)}` };
                }).catch(error => {
                    console.error('[API] YouTube download failed:', error.message);
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

            // -------------------------------------------------------------
            // LIKED SONGS & PLAYLISTS (Cloud Library)
            // -------------------------------------------------------------
            // GET /api/library/liked
            if (pathname === '/api/library/liked' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const liked = this.db.getLikedSongs(userId);
                return this.sendJson(res, 200, liked);
            }

            if (pathname === '/api/library/liked/import' && method === 'POST') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const body = await this.parseBody(req);
                if (!Array.isArray(body.tracks)) return this.sendError(res, 400, 'Tracks must be an array.');
                return this.sendJson(res, 200, this.db.importLikedSongs(userId, body.tracks));
            }

            // GET /api/library/downloads
            if (pathname === '/api/library/downloads' && method === 'GET') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const downloads = [];
                for (const track of this.db.getDownloads(userId)) {
                    if (downloads.some(existing => sameDownload(track, existing))) {
                        const duplicatePath = path.basename(track.fileName || '') === track.fileName ? path.join(this.downloadsDir, track.fileName) : '';
                        try {
                            if (duplicatePath && fs.existsSync(duplicatePath)) fs.unlinkSync(duplicatePath);
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
                return this.sendJson(res, 200, { deleted: true, fileName });
            }

            // POST /api/library/liked/toggle
            if (pathname === '/api/library/liked/toggle' && method === 'POST') {
                const authUser = this.getAuthUser(req);
                const userId = authUser ? authUser.userId : 'guest';
                const body = await this.parseBody(req);
                if (!body.track) return this.sendError(res, 400, 'Track payload is required');
                const result = this.db.toggleLikeSong(userId, body.track);
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
}

module.exports = ApiRouter;
