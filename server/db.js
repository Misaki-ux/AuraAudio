// =========================================================================
// AuraAudio Embedded Database Engine (server/db.js)
// Zero-dependency file-backed JSON database with ACID-safe atomic writes
// =========================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
            downloads: [],
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
        return this.data.liked_songs.filter(item => item.userId === userId);
    }

    getLikedArtists(userId = 'guest') {
        return (this.data.liked_artists || []).filter(item => item.userId === userId);
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
        const liked = this.getLikedSongs(userId);
        const downloads = this.getDownloads(userId);
        const playlists = this.data.playlists.filter(p => p.userId === userId);
        const imported = (this.data.imported_media || []).filter(item => item.userId === userId);
        const played = (this.data.play_events || []).filter(item => item.userId === userId)
            .sort((a, b) => b.playedAt.localeCompare(a.playedAt)).slice(0, 100);
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
            sourceCounts: { liked: liked.length, downloads: downloads.length, playlists: playlists.length, imported: imported.length, recentPlays: played.length },
            artists,
            tracks: titles,
            likedTracks: liked.map(track => ({ title: track.title, artist: track.artist })),
            recentTracks: played.map(track => ({ title: track.title, artist: track.artist })),
            hasListeningData: tracks.length > 0
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

    recordPlay(userId = 'guest', track = {}) {
        if (!track || typeof track.title !== 'string' || !track.title.trim()) return null;
        const collection = this.data.play_events || (this.data.play_events = []);
        const event = {
            id: 'play_' + crypto.randomBytes(6).toString('hex'),
            userId,
            title: track.title.trim().slice(0, 200),
            artist: typeof track.artist === 'string' ? track.artist.trim().slice(0, 160) : '',
            playedAt: new Date().toISOString()
        };
        collection.unshift(event);
        const userEvents = collection.filter(item => item.userId === userId);
        for (const expired of userEvents.slice(5000)) {
            const index = collection.indexOf(expired);
            if (index >= 0) collection.splice(index, 1);
        }
        this.save();
        return event;
    }

    isLiked(userId = 'guest', trackId) {
        return this.data.liked_songs.some(item => item.userId === userId && item.trackId === trackId);
    }

    toggleLikeSong(userId = 'guest', track) {
        const trackId = track.id || track.name || track.title;
        const index = this.data.liked_songs.findIndex(item => item.userId === userId && item.trackId === trackId);
        
        if (index >= 0) {
            // Remove
            this.data.liked_songs.splice(index, 1);
            this.save();
            return { liked: false, trackId };
        } else {
            // Add
            const likedTrack = {
                id: 'like_' + crypto.randomBytes(6).toString('hex'),
                userId,
                trackId,
                title: track.title || track.name,
                artist: track.artist || 'Unknown Artist',
                duration: track.duration || 0,
                durationFormatted: track.durationFormatted || '--:--',
                url: track.url || '',
                source: track.source || 'local',
                cover: track.cover || null,
                addedAt: new Date().toISOString()
            };
            this.data.liked_songs.unshift(likedTrack);
            this.save();
            return { liked: true, track: likedTrack };
        }
    }

    importLikedSongs(userId = 'guest', tracks = []) {
        const collection = this.data.liked_songs;
        const existing = new Set(collection.filter(item => item.userId === userId).map(item => String(item.trackId || '').toLowerCase()));
        let added = 0;
        for (const track of tracks.slice(0, 1000)) {
            const trackId = String(track.id || track.trackId || '').trim();
            const key = trackId.toLowerCase();
            if (!key || existing.has(key)) continue;
            existing.add(key);
            collection.unshift({
                id: 'like_' + crypto.randomBytes(6).toString('hex'), userId, trackId,
                title: String(track.title || track.name || 'Untitled').slice(0, 240),
                artist: String(track.artist || 'Unknown Artist').slice(0, 180),
                duration: Number(track.duration) || 0, durationFormatted: '--:--',
                url: '', source: String(track.source || 'external').slice(0, 40),
                sourceUrl: String(track.sourceUrl || '').slice(0, 1000), cover: track.cover || null,
                addedAt: new Date().toISOString()
            });
            added++;
        }
        if (added) this.save();
        return { added, total: tracks.length };
    }

    // --- Playlists ---
    getPlaylists(userId = 'guest') {
        return this.data.playlists.filter(p => p.userId === userId || p.isPublic);
    }

    getPlaylistById(id) {
        return this.data.playlists.find(p => p.id === id);
    }

    createPlaylist(userId = 'guest', name, description = '', isPublic = false) {
        const playlist = {
            id: 'pl_' + crypto.randomBytes(6).toString('hex'),
            userId,
            name: name || 'Untitled Playlist',
            description: description || 'Custom AuraAudio Playlist',
            isPublic: !!isPublic,
            tracks: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        this.data.playlists.push(playlist);
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
            duration: track.duration || 0,
            url: track.url || '',
            source: track.source || 'local',
            sourceUrl: track.sourceUrl || '',
            downloadable: track.downloadable === true,
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
                duration: Number(track.duration) || 0, url: '',
                source: String(track.source || 'external').slice(0, 40),
                sourceUrl: String(track.sourceUrl || '').slice(0, 1000), downloadable: track.downloadable === true,
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
        const entry = {
            id: 'dl_' + crypto.randomBytes(6).toString('hex'),
            ...record,
            downloadedAt: new Date().toISOString()
        };
        this.data.downloads.unshift(entry);
        this.save();
        return entry;
    }

    getDownloads(userId = 'guest') {
        return this.data.downloads.filter(d => d.userId === userId);
    }

    removeDownload(userId = 'guest', fileName) {
        const index = this.data.downloads.findIndex(item => item.userId === userId && item.fileName === fileName);
        if (index < 0) return null;
        const [removed] = this.data.downloads.splice(index, 1);
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
