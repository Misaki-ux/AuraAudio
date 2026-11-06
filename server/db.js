// =========================================================================
// AuraAudio Embedded Database Engine (server/db.js)
// Zero-dependency file-backed JSON database with ACID-safe atomic writes
// =========================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseTrackMeta } = require('./music-metadata');

function normalizeLikedText(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function likedSongIdentity(track) {
    const title = normalizeLikedText(track.title || track.name);
    const artist = normalizeLikedText(track.artist);
    return title && artist ? `${title}|${artist}` : '';
}

function isGenericArtistName(value) {
    return /^(unknown(?:\s+artist)?|youtube(?:\s+audio)?|various\s+artists?|topic)$/i.test(String(value || '').trim());
}

function normalizedPlayMetadata(track = {}) {
    const rawTitle = String(track.title || track.name || '').trim();
    const parsed = parseTrackMeta({
        title: rawTitle,
        artist: track.artist,
        creator: track.creator,
        artists: track.artists,
        channel: track.channel,
        uploader: track.uploader
    }, rawTitle);
    return {
        title: String(parsed.title || rawTitle).trim(),
        artist: String(parsed.artist || '').trim()
    };
}

class Database {
    constructor(dbFilePath) {
        this.filePath = path.resolve(dbFilePath || path.join(__dirname, 'data', 'db.json'));
        this.dir = path.dirname(this.filePath);
        this.data = {
            users: [],
            liked_songs: [],
            liked_artists: [],
            playlists: [],
            imported_media: [],
            play_events: [],
            activity_events: [],
            diagnostics: [],
            downloads: [],
            download_metadata: [],
            play_history_preferences: [],
            mobile_sync_actions: [],
            settings: {
                version: "1.2.0",
                initializedAt: new Date().toISOString()
            }
        };
        this.init();
    }

    init() {
        try {
            if (!fs.existsSync(this.dir)) {
                fs.mkdirSync(this.dir, { recursive: true });
            }
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf8');
                if (raw.trim()) {
                    this.data = Object.assign(this.data, JSON.parse(raw));
                }
            } else {
                this.save();
            }
        } catch (err) {
            console.error('[AuraDB] Initialization error:', err.message);
        }
    }

    save() {
        try {
            const tempPath = `${this.filePath}.tmp.${Date.now()}`;
            fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
            fs.renameSync(tempPath, this.filePath);
        } catch (err) {
            console.error('[AuraDB] Save failed:', err.message);
        }
    }

    // --- User Operations ---
    findUserById(id) {
        return this.data.users.find(u => u.id === id);
    }

    findUserByEmail(email) {
        if (!email) return null;
        return this.data.users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
    }

    findUserByUsername(username) {
        if (!username) return null;
        return this.data.users.find(u => (u.username || '').toLowerCase() === username.toLowerCase());
    }

    createUser(userData) {
        const user = {
            id: 'usr_' + crypto.randomBytes(8).toString('hex'),
            username: userData.username,
            email: userData.email,
            passwordHash: userData.passwordHash || null,
            avatarUrl: userData.avatarUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${userData.username}`,
            provider: userData.provider || 'local',
            providerId: userData.providerId || null,
            createdAt: new Date().toISOString()
        };
        this.data.users.push(user);
        this.save();
        return user;
    }

    // --- Liked Songs ---
    getLikedSongs(userId = 'guest') {
        const unique = new Map();
        for (const item of this.data.liked_songs.filter(track => track.userId === userId)) {
            const identity = likedSongIdentity(item) || `id:${normalizeLikedText(item.trackId)}`;
            const existing = unique.get(identity);
            if (!existing) {
                unique.set(identity, { ...item });
                continue;
            }
            for (const key of ['cover', 'album', 'albumTitle', 'fileName', 'url', 'localAudioId', 'duration', 'durationFormatted', 'artist']) {
                if (!existing[key] && item[key]) existing[key] = item[key];
            }
        }
        return [...unique.values()];
    }

    updateLikedSongArtwork(userId = 'guest', trackId, cover, album = '', artist = '') {
        const track = this.data.liked_songs.find(item => item.userId === userId && item.trackId === trackId);
        if (!track) return false;
        let changed = false;
        if (!track.cover && cover) {
            track.cover = String(cover).slice(0, 1500);
            changed = true;
        }
        if (!track.album && album) {
            track.album = String(album).slice(0, 240);
            changed = true;
        }
        if (isGenericArtistName(track.artist) && artist && !isGenericArtistName(artist)) {
            track.artist = String(artist).trim().slice(0, 180);
            changed = true;
        }
        if (changed) this.save();
        return changed;
    }

    getLikedArtists(userId = 'guest') {
        return (this.data.liked_artists || []).filter(item => item.userId === userId);
    }

    updateLikedArtistImages(userId, updates) {
        let changed = 0;
        for (const { artist, image } of updates) {
            if (!image) continue;
            const entry = (this.data.liked_artists || []).find(item =>
                item.userId === userId
                && ((artist.key && item.key === artist.key) || (artist.id && item.id === artist.id) || (artist.name && item.name === artist.name))
            );
            if (!entry || entry.image === image) continue;
            entry.image = String(image).slice(0, 1000);
            changed++;
        }
        if (changed) this.save();
        return changed;
    }

    toggleLikedArtist(userId = 'guest', artist = {}) {
        const collection = this.data.liked_artists || (this.data.liked_artists = []);
        const key = String(artist.id || artist.name || '').trim().toLowerCase();
        const index = collection.findIndex(item => item.userId === userId && item.key === key);
        if (index >= 0) {
            collection.splice(index, 1);
            this.save();
            return { liked: false, artist };
        }
        const entry = { userId, key, id: String(artist.id || ''), name: String(artist.name).slice(0, 180), image: String(artist.image || ''), likedAt: new Date().toISOString() };
        collection.unshift(entry);
        this.save();
        return { liked: true, artist: entry };
    }

    setLikedArtist(userId = 'guest', artist = {}, liked = true) {
        const collection = this.data.liked_artists || (this.data.liked_artists = []);
        const name = String(artist.name || '').trim().slice(0, 180);
        const id = String(artist.id || name).trim();
        if (!name || !id) return false;
        const key = id.toLowerCase();
        const matches = item => item.userId === userId && (
            String(item.id || item.key || '').toLowerCase() === key
            || String(item.name || '').trim().toLowerCase() === name.toLowerCase()
        );
        const existing = collection.find(matches);
        if (!liked) {
            if (!existing) return false;
            this.data.liked_artists = collection.filter(item => !matches(item));
            return true;
        }
        if (existing) {
            if (!existing.image && artist.image) existing.image = String(artist.image).slice(0, 1000);
            return false;
        }
        collection.unshift({ userId, key, id, name, image: String(artist.image || '').slice(0, 1000), likedAt: new Date().toISOString() });
        return true;
    }

    importLikedArtists(userId = 'guest', artists = []) {
        const collection = this.data.liked_artists || (this.data.liked_artists = []);
        const known = new Set(collection.filter(item => item.userId === userId).map(item => String(item.id || item.key || item.name || '').toLowerCase()));
        let added = 0;
        for (const artist of artists.slice(0, 500)) {
            const name = String(artist.name || '').trim();
            const id = String(artist.id || name).trim();
            const key = id.toLowerCase();
            if (!name || !key || known.has(key)) continue;
            known.add(key);
            collection.unshift({ userId, key, id, name: name.slice(0, 180), image: String(artist.image || '').slice(0, 1000), source: String(artist.source || 'external').slice(0, 40), sourceUrl: String(artist.sourceUrl || '').slice(0, 1000), likedAt: new Date().toISOString() });
            added++;
        }
        if (added) this.save();
        return { added, total: artists.length };
    }

    getDiscoverySignals(userId = 'guest') {
        this.prunePlayHistory(userId);
        const liked = this.getLikedSongs(userId);
        const likedArtists = this.getLikedArtists(userId);
        const downloads = this.getDownloads(userId);
        const playlists = this.data.playlists.filter(p => p.userId === userId);
        const imported = (this.data.imported_media || []).filter(item => item.userId === userId);
        const played = (this.data.play_events || []).filter(item => item.userId === userId)
            .sort((a, b) => String(b.playedAt || '').localeCompare(String(a.playedAt || ''))).slice(0, 100)
            .map(item => ({ ...item, ...normalizedPlayMetadata(item) }));
        const tracks = [
            ...liked,
            ...downloads,
            ...playlists.flatMap(playlist => playlist.tracks || []),
            ...imported,
            ...played
        ];
        const artists = [...new Set(tracks.map(track => track.artist).filter(Boolean))];
        const titles = [...new Set(tracks.map(track => track.title).filter(Boolean))];
        return {
            sourceCounts: { liked: liked.length, likedArtists: likedArtists.length, downloads: downloads.length, playlists: playlists.length, imported: imported.length, recentPlays: played.length },
            artists,
            tracks: titles,
            likedArtists: likedArtists.map(artist => ({ id: artist.id || '', name: artist.name, image: artist.image || '' })),
            likedTracks: liked.map(track => ({ title: track.title, artist: track.artist })),
            recentTracks: played.map(track => ({ title: track.title, artist: track.artist })),
            hasListeningData: tracks.length > 0 || likedArtists.length > 0
        };
    }

    searchLibrary(userId = 'guest', query = '', limit = 30) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return [];
        const matches = [
            ...this.getLikedSongs(userId).map(track => ({ ...track, source: track.source || 'liked', favorite: true })),
            ...(this.data.imported_media || []).filter(track => track.userId === userId).map(track => ({ ...track, source: 'imported' })),
            ...this.getDownloads(userId).map(track => ({ ...track, source: 'download' })),
            ...this.data.playlists.filter(playlist => playlist.userId === userId)
                .flatMap(playlist => (playlist.tracks || []).map(track => ({ ...track, source: 'playlist' })))
        ].filter(track => `${track.title || track.name || ''} ${track.artist || ''}`.toLowerCase().includes(q));
        const unique = new Map();
        for (const track of matches) {
            const key = `${String(track.title || track.name || '').toLowerCase()}|${String(track.artist || '').toLowerCase()}`;
            const existing = unique.get(key);
            if (existing) {
                existing.favorite = existing.favorite || !!track.favorite;
                continue;
            }
            unique.set(key, {
                id: track.trackId || track.id || key,
                title: track.title || track.name || 'Untitled track',
                artist: track.artist || 'Unknown artist',
                source: track.source,
                favorite: !!track.favorite,
                duration: track.durationFormatted || track.duration || '',
                fileName: track.fileName || '',
                filePath: track.filePath || '',
                streamUrl: track.source === 'download' && track.fileName
                    ? `/api/media/${encodeURIComponent(track.fileName)}`
                    : ''
            });
        }
        return [...unique.values()].slice(0, Math.max(1, Math.min(100, Number(limit) || 30)));
    }

    syncImportedMedia(userId = 'guest', tracks = []) {
        if (!Array.isArray(tracks)) return [];
        const collection = this.data.imported_media || (this.data.imported_media = []);
        const synced = [];
        for (const track of tracks.slice(0, 100)) {
            if (!track || typeof track.title !== 'string' || !track.title.trim()) continue;
            const normalized = {
                userId,
                title: track.title.trim().slice(0, 200),
                artist: typeof track.artist === 'string' ? track.artist.trim().slice(0, 160) : '',
                fileName: typeof track.fileName === 'string' ? track.fileName.slice(0, 260) : '',
                fileSize: Number.isFinite(track.fileSize) ? Math.max(0, track.fileSize) : 0
            };
            const key = `${normalized.title.toLowerCase()}|${normalized.artist.toLowerCase()}|${normalized.fileName.toLowerCase()}|${normalized.fileSize}`;
            let existing = collection.find(item => item.userId === userId && item.key === key);
            if (!existing) {
                existing = { id: 'imp_' + crypto.randomBytes(6).toString('hex'), key, ...normalized, importedAt: new Date().toISOString() };
                collection.push(existing);
            }
            synced.push(existing);
        }
        if (synced.length) this.save();
        return synced;
    }

    recordPlay(userId = 'guest', track = {}, listenedSeconds = null) {
        if (!track || typeof track.title !== 'string' || !track.title.trim()) return null;
        const preferences = this.getPlayHistoryPreferences(userId);
        if (Number.isFinite(listenedSeconds) && listenedSeconds < preferences.minimumListenSeconds) return null;
        const collection = this.data.play_events || (this.data.play_events = []);
        const metadata = normalizedPlayMetadata(track);
        const event = {
            id: 'play_' + crypto.randomBytes(6).toString('hex'),
            userId,
            title: metadata.title.slice(0, 200),
            artist: metadata.artist.slice(0, 160),
            playedAt: new Date().toISOString()
        };
        collection.unshift(event);
        this.prunePlayHistory(userId, false);
        this.recordActivity(userId, 'play', event, false);
        this.save();
        return event;
    }

    exportLibraryTransfer(userId = 'guest') {
        const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
        const duration = value => {
            const parsed = Number(value);
            return Number.isFinite(parsed) && parsed >= 0 && parsed <= 86400 ? parsed : 0;
        };
        const date = value => {
            const parsed = Date.parse(value || '');
            return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
        };
        const safeTrack = track => ({
            title: text(track.title || track.name, 240),
            artist: text(track.artist, 180),
            album: text(track.album || track.albumTitle, 240),
            duration: duration(track.duration),
            addedAt: date(track.addedAt)
        });
        let playlistTrackBudget = 5000;
        const exportedPlaylists = this.data.playlists.filter(playlist => playlist.userId === userId)
            .slice(0, 100)
            .map(playlist => {
                const tracks = (playlist.tracks || []).slice(0, Math.min(200, playlistTrackBudget))
                    .map(safeTrack).filter(track => track.title);
                playlistTrackBudget -= tracks.length;
                return {
                    name: text(playlist.name, 100) || 'Untitled playlist',
                    description: text(playlist.description, 240),
                    createdAt: date(playlist.createdAt),
                    tracks
                };
            });
        return {
            format: 'AuraAudio-library-transfer',
            version: 1,
            exportedAt: new Date().toISOString(),
            likedSongs: this.getLikedSongs(userId).slice(0, 1000).map(safeTrack).filter(track => track.title),
            likedArtists: this.getLikedArtists(userId).slice(0, 500).map(artist => ({
                id: text(artist.id || artist.key, 180),
                name: text(artist.name, 180),
                likedAt: date(artist.likedAt)
            })).filter(artist => artist.name),
            listeningHistory: (this.data.play_events || [])
                .filter(event => event.userId === userId)
                .sort((a, b) => String(b.playedAt || '').localeCompare(String(a.playedAt || '')))
                .slice(0, 5000)
                .map(event => ({ ...safeTrack(event), playedAt: date(event.playedAt) }))
                .filter(event => event.title && event.playedAt),
            playlists: exportedPlaylists,
            downloadMetadata: [
                ...this.getDownloads(userId),
                ...(this.data.download_metadata || []).filter(download => download.userId === userId)
            ].slice(0, 1000).map(download => ({
                title: text(download.title, 240),
                artist: text(download.artist, 180),
                album: text(download.album || download.albumTitle, 240),
                duration: duration(download.duration),
                downloadedAt: date(download.downloadedAt)
            })).filter(download => download.title)
        };
    }

    importLibraryTransfer(userId = 'guest', transfer = {}) {
        const limits = {
            likedSongs: 1000,
            likedArtists: 500,
            listeningHistory: 5000,
            playlists: 100,
            downloadMetadata: 1000
        };
        for (const [key, limit] of Object.entries(limits)) {
            if (!Array.isArray(transfer[key]) || transfer[key].length > limit) {
                throw new Error(`Transfer ${key} must contain no more than ${limit} records.`);
            }
        }
        const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
        const duration = value => {
            const parsed = Number(value);
            return Number.isFinite(parsed) && parsed >= 0 && parsed <= 86400 ? parsed : 0;
        };
        const validDate = value => {
            const parsed = Date.parse(value || '');
            return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
        };
        const identity = track => {
            const title = normalizeLikedText(track.title);
            const artist = normalizeLikedText(track.artist);
            return title ? `${title}|${artist}` : '';
        };
        const safeTrack = track => {
            if (!track || typeof track !== 'object' || Array.isArray(track)) return null;
            const title = text(track.title || track.name, 240);
            if (!title) return null;
            return {
                title,
                artist: text(track.artist, 180),
                album: text(track.album, 240),
                duration: duration(track.duration),
                addedAt: validDate(track.addedAt)
            };
        };
        let likedSongs = 0;
        let likedArtists = 0;
        let listeningHistory = 0;
        let playlists = 0;
        let playlistTracks = 0;
        let downloadMetadata = 0;

        this.data.liked_songs ||= [];
        const likedIdentities = new Set(this.data.liked_songs.filter(track => track.userId === userId).map(identity).filter(Boolean));
        for (const source of transfer.likedSongs) {
            const track = safeTrack(source);
            if (!track) continue;
            const key = identity(track);
            if (!key || likedIdentities.has(key)) continue;
            likedIdentities.add(key);
            this.data.liked_songs.unshift({
                id: 'like_' + crypto.randomBytes(6).toString('hex'),
                userId,
                trackId: 'transfer_' + crypto.randomBytes(8).toString('hex'),
                ...track,
                source: 'library-transfer',
                url: '',
                fileName: '',
                cover: null,
                durationFormatted: '--:--'
            });
            likedSongs++;
        }

        this.data.liked_artists ||= [];
        const artistKeys = new Set(this.data.liked_artists.filter(artist => artist.userId === userId)
            .map(artist => normalizeLikedText(artist.name)).filter(Boolean));
        for (const source of transfer.likedArtists) {
            if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
            const name = text(source.name, 180);
            const key = normalizeLikedText(name);
            if (!name || !key || artistKeys.has(key)) continue;
            artistKeys.add(key);
            this.data.liked_artists.unshift({
                userId,
                key: text(source.id, 180).toLowerCase() || key,
                id: text(source.id, 180) || name,
                name,
                image: '',
                likedAt: validDate(source.likedAt) || new Date().toISOString()
            });
            likedArtists++;
        }

        this.data.playlists ||= [];
        const userPlaylists = this.data.playlists.filter(playlist => playlist.userId === userId);
        const playlistByName = new Map(userPlaylists.map(playlist => [normalizeLikedText(playlist.name), playlist]));
        for (const source of transfer.playlists) {
            if (!source || typeof source !== 'object' || Array.isArray(source) || !Array.isArray(source.tracks) || source.tracks.length > 200) continue;
            const name = text(source.name, 100) || 'Imported playlist';
            const key = normalizeLikedText(name);
            let playlist = playlistByName.get(key);
            if (!playlist) {
                if (userPlaylists.length >= 100) continue;
                playlist = {
                    id: 'pl_' + crypto.randomBytes(6).toString('hex'),
                    userId,
                    name,
                    description: text(source.description, 240) || 'Imported from AuraAudio mobile',
                    isPublic: false,
                    tracks: [],
                    createdAt: validDate(source.createdAt) || new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                this.data.playlists.push(playlist);
                userPlaylists.push(playlist);
                playlistByName.set(key, playlist);
                playlists++;
            }
            const knownTracks = new Set((playlist.tracks || []).map(identity).filter(Boolean));
            for (const sourceTrack of source.tracks) {
                const track = safeTrack(sourceTrack);
                const trackKey = track && identity(track);
                if (!track || !trackKey || knownTracks.has(trackKey) || playlist.tracks.length >= 500) continue;
                knownTracks.add(trackKey);
                playlist.tracks.push({
                    id: 'trk_' + crypto.randomBytes(6).toString('hex'),
                    ...track,
                    source: 'library-transfer',
                    url: '',
                    sourceUrl: '',
                    cover: null,
                    downloadable: false,
                    localAudioId: '',
                    addedAt: new Date().toISOString()
                });
                playlistTracks++;
            }
            playlist.updatedAt = new Date().toISOString();
        }

        this.data.play_events ||= [];
        const playKeys = new Set(this.data.play_events.filter(event => event.userId === userId)
            .map(event => `${identity(event)}|${validDate(event.playedAt)}`));
        for (const source of transfer.listeningHistory) {
            const track = safeTrack(source);
            const playedAt = validDate(source?.playedAt);
            const key = track && `${identity(track)}|${playedAt}`;
            if (!track || !track.title || !playedAt || playKeys.has(key)) continue;
            playKeys.add(key);
            this.data.play_events.unshift({
                id: 'play_' + crypto.randomBytes(6).toString('hex'),
                userId,
                title: track.title,
                artist: track.artist,
                playedAt,
                imported: true
            });
            listeningHistory++;
        }
        const retainedPlays = this.data.play_events.filter(event => event.userId === userId).slice(0, 5000);
        const retainedSet = new Set(retainedPlays);
        this.data.play_events = this.data.play_events.filter(event => event.userId !== userId || retainedSet.has(event));

        this.data.download_metadata ||= [];
        const downloadKeys = new Set([
            ...this.getDownloads(userId),
            ...this.data.download_metadata.filter(item => item.userId === userId)
        ].map(identity).filter(Boolean));
        for (const source of transfer.downloadMetadata) {
            const track = safeTrack(source);
            const downloadedAt = validDate(source?.downloadedAt);
            const key = track && identity(track);
            if (!track || !track.title || downloadKeys.has(key)) continue;
            downloadKeys.add(key);
            this.data.download_metadata.unshift({
                userId,
                title: track.title,
                artist: track.artist,
                album: track.album,
                duration: track.duration,
                downloadedAt: downloadedAt || new Date().toISOString(),
                importedAt: new Date().toISOString(),
                metadataOnly: true
            });
            downloadMetadata++;
        }

        const imported = { likedSongs, likedArtists, listeningHistory, playlists, playlistTracks, downloadMetadata };
        this.save();
        return { imported, totals: { ...imported } };
    }

    getPlayHistoryPreferences(userId = 'guest') {
        const preferences = (this.data.play_history_preferences || []).find(item => item.userId === userId);
        return {
            retentionDays: Number.isInteger(preferences?.retentionDays) ? preferences.retentionDays : 0,
            minimumListenSeconds: Number.isInteger(preferences?.minimumListenSeconds) ? preferences.minimumListenSeconds : 0
        };
    }

    setPlayHistoryPreferences(userId = 'guest', { retentionDays, minimumListenSeconds }) {
        const preferences = { userId, retentionDays, minimumListenSeconds, updatedAt: new Date().toISOString() };
        this.data.play_history_preferences ||= [];
        const index = this.data.play_history_preferences.findIndex(item => item.userId === userId);
        if (index >= 0) this.data.play_history_preferences[index] = preferences;
        else this.data.play_history_preferences.push(preferences);
        this.prunePlayHistory(userId, false);
        this.save();
        return this.getPlayHistoryPreferences(userId);
    }

    prunePlayHistory(userId = 'guest', persist = true) {
        const collection = this.data.play_events || [];
        const preferences = this.getPlayHistoryPreferences(userId);
        const cutoff = preferences.retentionDays > 0
            ? Date.now() - preferences.retentionDays * 24 * 60 * 60 * 1000
            : 0;
        const userEvents = collection.filter(event => event.userId === userId)
            .sort((a, b) => String(b.playedAt || '').localeCompare(String(a.playedAt || '')));
        const retained = userEvents.filter(event => {
            const timestamp = Date.parse(event.playedAt || '');
            return !cutoff || !Number.isFinite(timestamp) || timestamp >= cutoff;
        }).slice(0, 5000);
        const keep = new Set(retained);
        const filtered = collection.filter(event => event.userId !== userId || keep.has(event));
        const removed = collection.length - filtered.length;
        if (removed) {
            this.data.play_events = filtered;
            if (persist) this.save();
        }
        return removed;
    }

    recordActivity(userId = 'guest', type, payload = {}, persist = true) {
        const allowed = new Set(['play', 'download', 'like_added', 'like_removed', 'playlist_created', 'playlist_track_added']);
        if (!allowed.has(type)) return null;
        const collection = this.data.activity_events || (this.data.activity_events = []);
        const event = {
            id: 'activity_' + crypto.randomBytes(6).toString('hex'),
            userId,
            type,
            occurredAt: new Date().toISOString()
        };
        for (const field of ['title', 'artist', 'name']) {
            if (typeof payload[field] === 'string' && payload[field].trim()) {
                event[field] = payload[field].trim().slice(0, field === 'title' ? 200 : 160);
            }
        }
        collection.unshift(event);
        const userEvents = collection.filter(item => item.userId === userId);
        for (const expired of userEvents.slice(2000)) {
            const index = collection.indexOf(expired);
            if (index >= 0) collection.splice(index, 1);
        }
        if (persist) this.save();
        return event;
    }

    recordDiagnostic(userId = 'guest', category, method, statusCode) {
        const categories = new Set(['api', 'auth', 'search', 'discovery', 'library', 'download', 'media', 'telemetry', 'artwork']);
        const methods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD']);
        if (!categories.has(category) || !methods.has(method) || !Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) return null;
        const collection = this.data.diagnostics || (this.data.diagnostics = []);
        const event = {
            id: 'diag_' + crypto.randomBytes(6).toString('hex'),
            userId,
            category,
            method,
            statusCode,
            occurredAt: new Date().toISOString()
        };
        collection.unshift(event);
        const userEvents = collection.filter(item => item.userId === userId);
        for (const expired of userEvents.slice(500)) {
            const index = collection.indexOf(expired);
            if (index >= 0) collection.splice(index, 1);
        }
        this.save();
        return event;
    }

    getTelemetry(userId = 'guest') {
        this.prunePlayHistory(userId);
        const plays = (this.data.play_events || []).filter(event => event.userId === userId);
        const normalizedPlays = plays.map(event => ({ ...event, ...normalizedPlayMetadata(event) }));
        const actions = (this.data.activity_events || []).filter(event => event.userId === userId && event.type !== 'play');
        const diagnostics = (this.data.diagnostics || []).filter(event => event.userId === userId);
        const counts = (items, key) => {
            const result = new Map();
            for (const item of items) {
                const value = String(item[key] || '').trim();
                if (value) result.set(value, (result.get(value) || 0) + 1);
            }
            return [...result].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 5);
        };
        const byDay = new Map();
        for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
            const day = new Date();
            day.setHours(0, 0, 0, 0);
            day.setDate(day.getDate() - daysAgo);
            byDay.set(day.toISOString().slice(0, 10), 0);
        }
        for (const event of plays) {
            const day = String(event.playedAt || '').slice(0, 10);
            if (byDay.has(day)) byDay.set(day, byDay.get(day) + 1);
        }
        const recent = [
            ...normalizedPlays.map(event => ({ type: 'play', title: event.title, artist: event.artist, occurredAt: event.playedAt })),
            ...actions
        ].sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || ''))).slice(0, 25);
        const errors = diagnostics.sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || ''))).slice(0, 10)
            .map(({ category, method, statusCode, occurredAt }) => ({ category, method, statusCode, occurredAt }));
        return {
            totals: {
                plays: plays.length,
                likes: this.getLikedSongs(userId).length,
                downloads: this.getDownloads(userId).length,
                playlists: this.data.playlists.filter(item => item.userId === userId).length,
                diagnostics: diagnostics.length
            },
            playsByDay: [...byDay].map(([date, count]) => ({ date, count })),
            topArtists: counts(normalizedPlays, 'artist'),
            topTracks: counts(normalizedPlays, 'title'),
            recent,
            diagnostics: errors
        };
    }

    clearTelemetry(userId = 'guest') {
        const before = (this.data.play_events || []).length + (this.data.activity_events || []).length + (this.data.diagnostics || []).length;
        this.data.play_events = (this.data.play_events || []).filter(event => event.userId !== userId);
        this.data.activity_events = (this.data.activity_events || []).filter(event => event.userId !== userId);
        this.data.diagnostics = (this.data.diagnostics || []).filter(event => event.userId !== userId);
        const after = this.data.play_events.length + this.data.activity_events.length + this.data.diagnostics.length;
        if (before !== after) this.save();
        return before - after;
    }

    isLiked(userId = 'guest', trackId) {
        return this.data.liked_songs.some(item => item.userId === userId && item.trackId === trackId);
    }

    toggleLikeSong(userId = 'guest', track) {
        const trackId = String(track.id || track.trackId || track.name || track.title || '').trim();
        const identity = likedSongIdentity(track);
        const matches = item => item.userId === userId
            && (String(item.trackId || '').toLowerCase() === trackId.toLowerCase()
                || (identity && likedSongIdentity(item) === identity));
        if (this.data.liked_songs.some(matches)) {
            this.data.liked_songs = this.data.liked_songs.filter(item => !matches(item));
            this.save();
            return { liked: false, trackId };
        } else {
            // Add
            let fileName = typeof track.fileName === 'string' ? track.fileName : '';
            if (!fileName) {
                const mediaUrl = String(track.streamUrl || track.url || '').match(/^\/api\/media\/([^/?#]+)/i);
                if (mediaUrl) {
                    try { fileName = decodeURIComponent(mediaUrl[1]); }
                    catch { fileName = ''; }
                }
            }
            if (path.basename(fileName) !== fileName || fileName.includes('..')) fileName = '';
            const likedTrack = {
                id: 'like_' + crypto.randomBytes(6).toString('hex'),
                userId,
                trackId,
                title: track.title || track.name,
                artist: track.artist || 'Unknown Artist',
                duration: track.duration || 0,
                durationFormatted: track.durationFormatted || '--:--',
                url: track.url || track.streamUrl || '',
                fileName,
                localAudioId: String(track.localAudioId || '').slice(0, 100),
                source: track.source || 'local',
                cover: typeof track.cover === 'string' ? track.cover.slice(0, 1500) : null,
                addedAt: new Date().toISOString()
            };
            this.data.liked_songs.unshift(likedTrack);
            this.save();
            return { liked: true, track: likedTrack };
        }
    }

    setLikeSong(userId = 'guest', track = {}, liked = true) {
        const title = String(track.title || track.name || '').trim().slice(0, 240);
        const artist = String(track.artist || 'Unknown Artist').trim().slice(0, 180);
        if (!title) return false;
        const trackId = String(track.id || track.trackId || `${title}|${artist}`).trim().slice(0, 240);
        const identity = likedSongIdentity({ title, artist });
        const matches = item => item.userId === userId && (
            String(item.trackId || '').toLowerCase() === trackId.toLowerCase()
            || (identity && likedSongIdentity(item) === identity)
        );
        const existing = this.data.liked_songs.find(matches);
        if (!liked) {
            if (!existing) return false;
            this.data.liked_songs = this.data.liked_songs.filter(item => !matches(item));
            return true;
        }
        if (existing) {
            for (const field of ['cover', 'album', 'duration', 'durationFormatted']) {
                if (!existing[field] && track[field]) existing[field] = track[field];
            }
            return false;
        }
        this.data.liked_songs.unshift({
            id: 'like_' + crypto.randomBytes(6).toString('hex'), userId, trackId, title, artist,
            duration: Number(track.duration) || 0,
            durationFormatted: String(track.durationFormatted || '').slice(0, 24),
            url: '', fileName: '', source: String(track.source || 'external').slice(0, 40),
            cover: typeof track.cover === 'string' ? track.cover.slice(0, 1500) : null,
            addedAt: new Date().toISOString()
        });
        return true;
    }

    syncMobileActions(userId = 'guest', actions = []) {
        if (!Array.isArray(actions)) return { accepted: [], duplicates: 0 };
        const log = this.data.mobile_sync_actions || (this.data.mobile_sync_actions = []);
        const known = new Set(log.filter(item => item.userId === userId).map(item => item.id));
        const accepted = [];
        let duplicates = 0;
        for (const action of actions.slice(0, 200)) {
            const id = String(action?.id || '').trim();
            if (!id || id.length > 120 || !['track-like', 'artist-like'].includes(action.type)) continue;
            if (known.has(id)) { duplicates++; continue; }
            let applied = false;
            if (action.type === 'track-like' && action.track && typeof action.track === 'object') {
                applied = this.setLikeSong(userId, action.track, action.liked === true);
            } else if (action.type === 'artist-like' && action.artist && typeof action.artist === 'object') {
                applied = this.setLikedArtist(userId, action.artist, action.liked === true);
            } else continue;
            log.push({ userId, id, applied, syncedAt: new Date().toISOString() });
            known.add(id);
            accepted.push(id);
        }
        const userRows = log.filter(item => item.userId === userId);
        if (userRows.length > 2000) {
            const keep = new Set(userRows.slice(-2000).map(item => item.id));
            this.data.mobile_sync_actions = log.filter(item => item.userId !== userId || keep.has(item.id));
        }
        if (accepted.length) this.save();
        return { accepted, duplicates };
    }

    importLikedSongs(userId = 'guest', tracks = []) {
        const collection = this.data.liked_songs;
        const existingIds = new Set(collection.filter(item => item.userId === userId).map(item => String(item.trackId || '').toLowerCase()));
        const existingIdentities = new Set(collection.filter(item => item.userId === userId).map(likedSongIdentity).filter(Boolean));
        let added = 0;
        for (const track of tracks.slice(0, 1000)) {
            const trackId = String(track.id || track.trackId || '').trim();
            const idKey = trackId.toLowerCase();
            const identity = likedSongIdentity(track);
            if ((!idKey || existingIds.has(idKey)) || (identity && existingIdentities.has(identity))) continue;
            existingIds.add(idKey);
            if (identity) existingIdentities.add(identity);
            collection.unshift({
                id: 'like_' + crypto.randomBytes(6).toString('hex'), userId, trackId,
                title: String(track.title || track.name || 'Untitled').slice(0, 240),
                artist: String(track.artist || 'Unknown Artist').slice(0, 180),
                duration: Number(track.duration) || 0, durationFormatted: '--:--',
                url: '', source: String(track.source || 'external').slice(0, 40),
                sourceUrl: String(track.sourceUrl || '').slice(0, 1000), cover: typeof track.cover === 'string' ? track.cover.slice(0, 1500) : null,
                addedAt: new Date().toISOString()
            });
            added++;
        }
        if (added) this.save();
        return { added, total: tracks.length };
    }

    // --- Playlists ---
    getPlaylists(userId = 'guest') {
        const playlists = this.data.playlists.filter(p => p.userId === userId || p.isPublic);
        const orderedOwned = playlists.filter(p => p.userId === userId);
        if (orderedOwned.every(p => Number.isInteger(p.sortOrder))) {
            orderedOwned.sort((a, b) => a.sortOrder - b.sortOrder);
            let ownedIndex = 0;
            return playlists.map(p => p.userId === userId ? orderedOwned[ownedIndex++] : p);
        }
        return playlists;
    }

    getPlaylistById(id) {
        return this.data.playlists.find(p => p.id === id);
    }

    createPlaylist(userId = 'guest', name, description = '', isPublic = false) {
        const owned = this.data.playlists.filter(p => p.userId === userId);
        const playlist = {
            id: 'pl_' + crypto.randomBytes(6).toString('hex'),
            userId,
            name: String(name || 'Untitled Playlist').trim().slice(0, 100) || 'Untitled Playlist',
            description: description || 'Custom AuraAudio Playlist',
            isPublic: !!isPublic,
            tracks: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        if (owned.every(p => Number.isInteger(p.sortOrder))) {
            playlist.sortOrder = owned.length ? Math.max(...owned.map(p => p.sortOrder)) + 1 : 0;
        }
        this.data.playlists.push(playlist);
        this.save();
        return playlist;
    }

    renamePlaylist(playlistId, userId = 'guest', name) {
        const playlist = this.getPlaylistById(playlistId);
        const normalizedName = String(name || '').trim().slice(0, 100);
        if (!playlist || playlist.userId !== userId || !normalizedName) return null;
        playlist.name = normalizedName;
        playlist.updatedAt = new Date().toISOString();
        this.save();
        return playlist;
    }

    reorderPlaylists(userId = 'guest', orderedIds = []) {
        const owned = this.data.playlists.filter(p => p.userId === userId);
        const visible = this.data.playlists.filter(p => p.userId === userId || p.isPublic);
        if (!Array.isArray(orderedIds) || orderedIds.length !== visible.length) return null;
        const visibleIds = new Set(visible.map(playlist => playlist.id));
        if (new Set(orderedIds).size !== visible.length || orderedIds.some(id => !visibleIds.has(id))) return null;
        const byId = new Map(owned.map(playlist => [playlist.id, playlist]));
        const ownedOrder = orderedIds.filter(id => byId.has(id));
        if (ownedOrder.length !== owned.length) return null;
        ownedOrder.forEach((id, sortOrder) => {
            byId.get(id).sortOrder = sortOrder;
            byId.get(id).updatedAt = new Date().toISOString();
        });
        this.save();
        return this.getPlaylists(userId);
    }

    reorderPlaylistTracks(playlistId, userId = 'guest', orderedIndices = []) {
        const playlist = this.getPlaylistById(playlistId);
        if (!playlist || playlist.userId !== userId || !Array.isArray(orderedIndices)) return null;
        const tracks = playlist.tracks || [];
        if (orderedIndices.length !== tracks.length
            || new Set(orderedIndices).size !== tracks.length
            || orderedIndices.some(index => !Number.isInteger(index) || index < 0 || index >= tracks.length)) return null;
        playlist.tracks = orderedIndices.map(index => tracks[index]);
        playlist.updatedAt = new Date().toISOString();
        this.save();
        return playlist;
    }

    addTrackToPlaylist(playlistId, track, userId = 'guest') {
        const playlist = this.getPlaylistById(playlistId);
        if (!playlist || playlist.userId !== userId) return null;

        const trackEntry = {
            id: track.id || 'trk_' + crypto.randomBytes(4).toString('hex'),
            title: track.title || track.name,
            artist: track.artist || 'Unknown Artist',
            album: String(track.album || track.albumTitle || '').slice(0, 240),
            duration: track.duration || 0,
            url: track.url || '',
            source: track.source || 'local',
            sourceUrl: track.sourceUrl || '',
            cover: typeof track.cover === 'string' ? track.cover.slice(0, 1500) : null,
            downloadable: track.downloadable === true,
            localAudioId: String(track.localAudioId || '').slice(0, 100),
            addedAt: new Date().toISOString()
        };
        playlist.tracks.push(trackEntry);
        playlist.updatedAt = new Date().toISOString();
        this.save();
        return playlist;
    }

    addTracksToPlaylist(playlistId, tracks, userId = 'guest') {
        const playlist = this.getPlaylistById(playlistId);
        if (!playlist || playlist.userId !== userId) return null;
        const seen = new Set((playlist.tracks || []).map(track => String(track.id || '').toLowerCase()));
        for (const track of tracks.slice(0, 1000)) {
            const id = String(track.id || '').trim();
            if (!id || seen.has(id.toLowerCase())) continue;
            seen.add(id.toLowerCase());
            playlist.tracks.push({
                id, title: String(track.title || track.name || 'Untitled').slice(0, 240),
                artist: String(track.artist || 'Unknown Artist').slice(0, 180),
                album: String(track.album || track.albumTitle || '').slice(0, 240),
                duration: Number(track.duration) || 0, url: '',
                source: String(track.source || 'external').slice(0, 40),
                sourceUrl: String(track.sourceUrl || '').slice(0, 1000), downloadable: track.downloadable === true,
                cover: typeof track.cover === 'string' ? track.cover.slice(0, 1500) : null,
                localAudioId: String(track.localAudioId || '').slice(0, 100),
                addedAt: new Date().toISOString()
            });
        }
        playlist.updatedAt = new Date().toISOString();
        this.save();
        return playlist;
    }

    removeTrackFromPlaylist(playlistId, trackId) {
        const playlist = this.getPlaylistById(playlistId);
        if (!playlist) return null;
        playlist.tracks = playlist.tracks.filter(t => t.id !== trackId);
        playlist.updatedAt = new Date().toISOString();
        this.save();
        return playlist;
    }

    deletePlaylist(playlistId, userId = 'guest') {
        const index = this.data.playlists.findIndex(p => p.id === playlistId && (p.userId === userId || userId === 'admin'));
        if (index >= 0) {
            this.data.playlists.splice(index, 1);
            this.save();
            return true;
        }
        return false;
    }

    // --- Downloads Log ---
    addDownloadRecord(record) {
        const fileName = typeof record.fileName === 'string' ? record.fileName : '';
        const existing = fileName && this.data.downloads.find(item =>
            item.userId === record.userId && String(item.fileName || '').toLowerCase() === fileName.toLowerCase()
        );
        if (existing) {
            for (const field of ['title', 'artist', 'album', 'duration', 'source', 'cover', 'coverFile']) {
                if (record[field] !== undefined && record[field] !== null && record[field] !== '') existing[field] = record[field];
            }
            this.save();
            return existing;
        }
        const entry = {
            id: 'dl_' + crypto.randomBytes(6).toString('hex'),
            ...record,
            downloadedAt: new Date().toISOString()
        };
        this.data.downloads.unshift(entry);
        this.save();
        return entry;
    }

    updateDownloadCover(userId = 'guest', fileName, coverFile) {
        const track = this.data.downloads.find(item => item.userId === userId && item.fileName === fileName);
        if (!track) return null;
        track.coverFile = String(coverFile || '').slice(0, 100);
        track.cover = track.coverFile ? `/api/covers/${encodeURIComponent(track.coverFile)}` : '';
        track.coverChecked = true;
        this.save();
        return track;
    }

    getDownloads(userId = 'guest') {
        const unique = new Map();
        for (const download of this.data.downloads.filter(item => item.userId === userId)) {
            const fileName = String(download.fileName || '').trim().toLowerCase();
            const key = fileName || String(download.id || `${download.title || ''}|${download.downloadedAt || ''}`);
            if (!unique.has(key)) unique.set(key, download);
        }
        return [...unique.values()];
    }

    getDownloadMetadata(userId = 'guest') {
        return (this.data.download_metadata || [])
            .filter(item => item.userId === userId && typeof item.title === 'string' && item.title.trim())
            .sort((a, b) => String(b.downloadedAt || '').localeCompare(String(a.downloadedAt || '')))
            .map(item => ({
                title: item.title.trim().slice(0, 240),
                artist: typeof item.artist === 'string' ? item.artist.trim().slice(0, 180) : '',
                downloadedAt: typeof item.downloadedAt === 'string' ? item.downloadedAt : ''
            }));
    }

    removeDownload(userId = 'guest', fileName) {
        const normalizedFileName = String(fileName || '').toLowerCase();
        const index = this.data.downloads.findIndex(item => item.userId === userId && String(item.fileName || '').toLowerCase() === normalizedFileName);
        if (index < 0) return null;
        const removed = this.data.downloads[index];
        this.data.downloads = this.data.downloads.filter(item =>
            item.userId !== userId || String(item.fileName || '').toLowerCase() !== normalizedFileName
        );
        this.save();
        return removed;
    }

    removeImportedMedia(userId = 'guest', metadata = {}) {
        const fileName = String(metadata.fileName || '').trim().toLowerCase();
        if (!fileName) return 0;
        const fileSize = Number(metadata.fileSize);
        const collection = this.data.imported_media || [];
        const before = collection.length;
        this.data.imported_media = collection.filter(item => {
            if (item.userId !== userId || String(item.fileName || '').trim().toLowerCase() !== fileName) return true;
            if (Number.isFinite(fileSize) && fileSize > 0 && item.fileSize !== fileSize) return true;
            return false;
        });
        const removed = before - this.data.imported_media.length;
        if (removed) this.save();
        return removed;
    }
}

module.exports = Database;
