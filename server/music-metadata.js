// Music metadata from MusicBrainz, Wikimedia summaries, and Cover Art Archive.
// Responses are cached in memory to keep provider requests low.
class MusicMetadataService {
    constructor() {
        this.cache = new Map();
        this.lastMusicBrainzRequest = 0;
    }

    async cached(key, ttlMs, fetcher) {
        const entry = this.cache.get(key);
        if (entry && entry.expiresAt > Date.now()) return entry.value;
        const value = await fetcher();
        this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
        return value;
    }

    async requestJson(url, provider = 'musicbrainz') {
        if (provider === 'musicbrainz') {
            const delay = Math.max(0, 1100 - (Date.now() - this.lastMusicBrainzRequest));
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            this.lastMusicBrainzRequest = Date.now();
        }
        const response = await fetch(url, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'AuraAudio/1.2.0 (music discovery; https://github.com/auraplayer)'
            },
            signal: AbortSignal.timeout(9000)
        });
        if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}`);
        return response.json();
    }

    async wikipediaSummary(title) {
        return this.cached(`wiki:${title.toLowerCase()}`, 24 * 60 * 60 * 1000, async () => {
            try {
                const result = await this.requestJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, 'wikimedia');
                return {
                    description: result.extract || '',
                    image: result.thumbnail?.source || result.originalimage?.source || '',
                    articleUrl: result.content_urls?.desktop?.page || result.desktop?.page || ''
                };
            } catch {
                return { description: '', image: '', articleUrl: '' };
            }
        });
    }

    normalizeArtist(artist) {
        return {
            id: artist.id,
            name: artist.name,
            type: artist.type || '',
            country: artist.country || artist.area?.name || '',
            disambiguation: artist.disambiguation || '',
            score: Number(artist.score) || 0,
            tags: (artist.tags || artist.genres || []).slice(0, 6).map(tag => typeof tag === 'string' ? tag : tag.name).filter(Boolean)
        };
    }

    async searchArtists(query, limit = 8) {
        const q = String(query || '').trim();
        if (q.length < 2) return [];
        return this.cached(`artist-search:${q.toLowerCase()}`, 15 * 60 * 1000, async () => {
            const data = await this.requestJson(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(q)}&fmt=json&limit=${Math.max(1, Math.min(20, limit))}`);
            return (data.artists || []).map(artist => this.normalizeArtist(artist));
        });
    }

    async getArtistProfile(id, fallback = null) {
        if (!/^[a-f0-9-]{36}$/i.test(String(id))) throw new Error('Invalid MusicBrainz artist ID');
        return this.cached(`artist-profile:${id}`, 12 * 60 * 60 * 1000, async () => {
            const artistData = await this.requestJson(`https://musicbrainz.org/ws/2/artist/${encodeURIComponent(id)}?fmt=json&inc=genres+tags`);
            const artist = this.normalizeArtist(artistData);
            const [summary, releaseData, recordings] = await Promise.all([
                this.wikipediaSummary(artist.name),
                this.requestJson(`https://musicbrainz.org/ws/2/release-group?artist=${encodeURIComponent(id)}&limit=12&fmt=json`).catch(() => ({ 'release-groups': [] })),
                this.requestJson(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(`arid:${id}`)}&limit=12&fmt=json`).catch(() => ({ recordings: [] }))
            ]);
            const albums = (releaseData['release-groups'] || []).map(release => ({
                id: release.id,
                title: release.title,
                date: release['first-release-date'] || '',
                type: release['primary-type'] || 'Release',
                cover: `https://coverartarchive.org/release-group/${release.id}/front-250`
            }));
            const tracks = (recordings.recordings || []).map(recording => ({
                id: recording.id,
                title: recording.title,
                artist: artist.name,
                duration: recording.length ? Math.round(recording.length / 1000) : 0,
                source: 'musicbrainz'
            }));
            const curated = fallback || {};
            return {
                ...artist,
                description: summary.description || curated.bio || '',
                image: summary.image || '',
                articleUrl: summary.articleUrl || '',
                albums,
                topTracks: tracks.length ? tracks : (curated.topTracks || []).map(track => ({ ...track, artist: artist.name })),
                sourceUrls: {
                    musicbrainz: `https://musicbrainz.org/artist/${artist.id}`,
                    wikipedia: summary.articleUrl || ''
                }
            };
        });
    }

    async getFeaturedArtist(artist) {
        const summary = await this.wikipediaSummary(artist.name);
        return {
            ...artist,
            image: summary.image,
            articleUrl: summary.articleUrl,
            description: summary.description || artist.bio || ''
        };
    }

    async getArtistByName(name, fallback = null) {
        const matches = await this.searchArtists(name, 5);
        const normalized = String(name || '').trim().toLowerCase();
        const match = matches.find(item => item.name.toLowerCase() === normalized) || matches[0];
        if (!match) return fallback ? this.getFeaturedArtist(fallback) : null;
        return this.getArtistProfile(match.id, fallback);
    }

    async lookupTrack(title, artist = '') {
        const cleanTitle = String(title || '').trim().slice(0, 180);
        const cleanArtist = String(artist || '').trim().slice(0, 120);
        if (cleanTitle.length < 2) return null;
        const query = `recording:"${cleanTitle}"${cleanArtist ? ` AND artist:"${cleanArtist}"` : ''}`;
        return this.cached(`track:${query.toLowerCase()}`, 24 * 60 * 60 * 1000, async () => {
            const data = await this.requestJson(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&limit=5&fmt=json`);
            const recording = (data.recordings || []).find(item => item['artist-credit']?.length) || data.recordings?.[0];
            if (!recording) return null;
            const credits = (recording['artist-credit'] || []).filter(item => typeof item === 'object').map(item => item.name || item.artist?.name).filter(Boolean);
            return {
                title: recording.title || cleanTitle,
                artist: credits.join(', ') || cleanArtist,
                recordingId: recording.id,
                duration: recording.length ? Math.round(recording.length / 1000) : null,
                artistId: recording['artist-credit']?.find(item => typeof item === 'object')?.artist?.id || ''
            };
        });
    }
}

module.exports = MusicMetadataService;
