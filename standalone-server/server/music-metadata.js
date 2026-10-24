// Music metadata from MusicBrainz, Wikimedia summaries, and Cover Art Archive.
// Responses are cached in memory to keep provider requests low.
function matchKey(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/(\d)\s*(?:eme|e)\b/gi, '$1eme')
        .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function releaseType(title, fallback) {
    const suffix = /(?:^|\s[-–]\s)(single|ep)$/i.exec(String(title || '').trim());
    return suffix ? `${suffix[1][0].toUpperCase()}${suffix[1].slice(1).toLowerCase()}` : (fallback || 'Release');
}

class MusicMetadataService {
    constructor() {
        this.cache = new Map();
        this.lastMusicBrainzRequest = 0;
        this.mbQueue = Promise.resolve();
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
            // Serialize MusicBrainz calls: parallel callers used to read the same timestamp and burst past 1 req/s (HTTP 503)
            const turn = this.mbQueue.then(async () => {
                const delay = Math.max(0, 1100 - (Date.now() - this.lastMusicBrainzRequest));
                if (delay) await new Promise(resolve => setTimeout(resolve, delay));
                this.lastMusicBrainzRequest = Date.now();
            });
            this.mbQueue = turn.catch(() => {});
            await turn;
        }
        // Apple's chart RSS is regularly slower than the JSON search APIs; aborting it
        // at the generic timeout left the new-releases and chart feeds intermittently empty.
        const timeoutMs = provider === 'apple' ? 15000 : 9000;
        const response = await fetch(url, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'AuraAudio/1.2.0 (music discovery; https://github.com/auraplayer)'
            },
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}`);
        return response.json();
    }

    async wikipediaSummary(title, force = false) {
        if (!force) {
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

        try {
            const result = await this.requestJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, 'wikimedia');
            const summary = {
                description: result.extract || '',
                image: result.thumbnail?.source || result.originalimage?.source || '',
                articleUrl: result.content_urls?.desktop?.page || result.desktop?.page || ''
            };
            this.cache.set(`wiki:${title.toLowerCase()}`, { value: summary, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
            return summary;
        } catch {
            return { description: '', image: '', articleUrl: '' };
        }
    }

    async wikipediaArtistImage(name) {
        try {
            const query = new URLSearchParams({
                action: 'query',
                generator: 'search',
                gsrsearch: name,
                gsrnamespace: '0',
                gsrlimit: '8',
                prop: 'pageimages',
                piprop: 'thumbnail',
                pithumbsize: '600',
                format: 'json'
            });
            const data = await this.requestJson(`https://en.wikipedia.org/w/api.php?${query}`, 'wikimedia');
            const normalizedName = name.trim().toLowerCase();
            const pages = Object.values(data.query?.pages || {});
            const page = pages.find(item => item.title.toLowerCase() === normalizedName)
                || pages.find(item => item.title.toLowerCase().startsWith(`${normalizedName} (`));
            return page?.thumbnail?.source || '';
        } catch (error) {
            console.warn(`[MusicMetadata] Wikipedia image search failed for "${name}":`, error.message);
            return '';
        }
    }

    async itunesArtistArtwork(name) {
        try {
            const query = new URLSearchParams({ term: name, entity: 'album', limit: '10' });
            const data = await this.requestJson(`https://itunes.apple.com/search?${query}`, 'itunes');
            const normalizedName = name.trim().toLowerCase();
            const album = (data.results || []).find(item => String(item.artistName || '').trim().toLowerCase() === normalizedName);
            return (album?.artworkUrl100 || '').replace(/\d+x\d+bb\./, '600x600bb.');
        } catch (error) {
            console.warn(`[MusicMetadata] iTunes artwork lookup failed for "${name}":`, error.message);
            return '';
        }
    }

    async getArtistImage(name, force = false, summary = null, exclude = '') {
        const key = `artist-image:${name.trim().toLowerCase()}`;
        const cached = this.cache.get(key);
        if (!force && cached?.expiresAt > Date.now()) return cached.value;
        const artistSummary = summary || await this.wikipediaSummary(name, force);
        let image = artistSummary.image === exclude ? '' : artistSummary.image;
        if (!image) image = await this.wikipediaArtistImage(name);
        if (!image || image === exclude) image = await this.itunesArtistArtwork(name);
        if (image === exclude) image = '';
        this.cache.set(key, { value: image, expiresAt: Date.now() + (image ? 24 * 60 * 60 * 1000 : 15 * 60 * 1000) });
        return image;
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
                image: summary.image || await this.getArtistImage(artist.name, false, summary) || curated.image || curated.avatar || '',
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

    async getLatestReleasesByArtist(name) {
        const cleanName = String(name || '').trim().slice(0, 120);
        if (cleanName.length < 2) throw new Error('Artist name must be at least 2 characters.');
        const key = `latest-releases:${matchKey(cleanName)}`;
        return this.cached(key, 24 * 60 * 60 * 1000, async () => {
            const artistQuery = new URLSearchParams({ term: cleanName, entity: 'musicArtist', limit: '20' });
            const artistResults = await this.requestJson(`https://itunes.apple.com/search?${artistQuery}`, 'itunes');
            const exactArtist = (artistResults.results || []).find(item => item.wrapperType === 'artist'
                && matchKey(item.artistName) === matchKey(cleanName));
            const canonicalName = exactArtist?.artistName || cleanName;
            const albumQuery = exactArtist?.artistId
                ? new URLSearchParams({ id: String(exactArtist.artistId), entity: 'album', limit: '200' })
                : new URLSearchParams({ term: cleanName, entity: 'album', limit: '200' });
            const [data, summary] = await Promise.all([
                this.requestJson(`https://itunes.apple.com/${exactArtist?.artistId ? 'lookup' : 'search'}?${albumQuery}`, 'itunes'),
                this.wikipediaSummary(canonicalName)
            ]);
            const artistKey = matchKey(canonicalName);
            const releases = this.normalizeItunesAlbums(data.results, artistKey)
                .sort((a, b) => String(b.date).localeCompare(String(a.date)));
            const unique = [...new Map(releases.map(release => [matchKey(release.title), release])).values()].slice(0, 12);
            return {
                artist: {
                    name: String(data.results?.find(item => item.artistName)?.artistName || canonicalName),
                    image: summary.image || unique.find(release => release.cover)?.cover || ''
                },
                releases: unique,
                source: 'itunes'
            };
        });
    }

    normalizeItunesAlbums(results, artistKey) {
        return (results || [])
            .filter(item => item.wrapperType === 'collection'
                && item.collectionName
                && (!artistKey || matchKey(item.artistName) === artistKey || matchKey(item.artistName).includes(artistKey)))
            .map(item => ({
                id: String(item.collectionId),
                title: item.collectionName,
                artist: item.artistName || '',
                date: String(item.releaseDate || '').slice(0, 10),
                type: releaseType(item.collectionName, item.collectionType),
                genre: item.primaryGenreName || '',
                cover: String(item.artworkUrl100 || '').replace(/\d+x\d+bb\./, '600x600bb.')
            }))
            .filter(release => release.id && release.title);
    }

    async getArtistTopAlbums(name) {
        const cleanName = String(name || '').trim().slice(0, 120);
        if (cleanName.length < 2) return [];
        return this.cached(`artist-top-albums:${matchKey(cleanName)}`, 24 * 60 * 60 * 1000, async () => {
            const query = new URLSearchParams({ term: cleanName, entity: 'album', limit: '25' });
            const data = await this.requestJson(`https://itunes.apple.com/search?${query}`, 'itunes').catch(() => null);
            return this.normalizeItunesAlbums(data?.results, matchKey(cleanName))
                .sort((a, b) => String(b.date).localeCompare(String(a.date)))
                .slice(0, 6);
        });
    }

    // Apple's public chart feed: genuine recent releases with real dates and real artwork,
    // used when a profile has no listening history to personalize against yet.
    async getNewReleases(limit = 24, country = 'us') {
        const cleanCountry = /^[a-z]{2}$/.test(String(country).toLowerCase()) ? String(country).toLowerCase() : 'us';
        const count = Math.max(1, Math.min(50, Number(limit) || 24));
        return this.cached(`new-releases:${cleanCountry}:${count}`, 12 * 60 * 60 * 1000, async () => {
            const data = await this.requestJson(`https://rss.marketingtools.apple.com/api/v2/${cleanCountry}/music/most-played/${count}/albums.json`, 'apple');
            return (data.feed?.results || [])
                .map(item => ({
                    id: String(item.id || ''),
                    title: item.name || '',
                    artist: item.artistName || '',
                    artistId: String(item.artistId || ''),
                    date: String(item.releaseDate || '').slice(0, 10),
                    type: releaseType(item.name, 'Album'),
                    genre: '',
                    cover: String(item.artworkUrl100 || '').replace(/\d+x\d+bb\./, '600x600bb.'),
                    storeUrl: item.url || '',
                    source: 'apple'
                }))
                .filter(release => release.title && release.artist);
        });
    }

    async getTopSongs(limit = 25, country = 'us') {
        const cleanCountry = /^[a-z]{2}$/.test(String(country).toLowerCase()) ? String(country).toLowerCase() : 'us';
        const count = Math.max(1, Math.min(50, Number(limit) || 25));
        return this.cached(`top-songs:${cleanCountry}:${count}`, 12 * 60 * 60 * 1000, async () => {
            const data = await this.requestJson(`https://rss.marketingtools.apple.com/api/v2/${cleanCountry}/music/most-played/${count}/songs.json`, 'apple');
            return (data.feed?.results || [])
                .map(item => ({
                    id: String(item.id || ''),
                    title: item.name || '',
                    artist: item.artistName || '',
                    artistId: String(item.artistId || ''),
                    cover: String(item.artworkUrl100 || '').replace(/\d+x\d+bb\./, '600x600bb.'),
                    date: String(item.releaseDate || '').slice(0, 10),
                    storeUrl: item.url || '',
                    source: 'apple'
                }))
                .filter(track => track.title && track.artist);
        });
    }

    // Real tracks for a mood/genre or artist query: title, artist and artwork only.
    async searchSongs(term, limit = 8) {
        const cleanTerm = String(term || '').trim().slice(0, 120);
        if (cleanTerm.length < 2) return [];
        const count = Math.max(1, Math.min(25, Number(limit) || 8));
        return this.cached(`songs:${matchKey(cleanTerm)}:${count}`, 24 * 60 * 60 * 1000, async () => {
            const query = new URLSearchParams({ term: cleanTerm, entity: 'song', limit: String(count) });
            const data = await this.requestJson(`https://itunes.apple.com/search?${query}`, 'itunes');
            return (data.results || [])
                .filter(item => item.trackName && item.artistName)
                .map(item => ({
                    id: `itunes_${item.trackId}`,
                    title: item.trackName,
                    artist: item.artistName,
                    album: item.collectionName || '',
                    duration: item.trackTimeMillis ? Math.round(item.trackTimeMillis / 1000) : null,
                    genre: item.primaryGenreName || '',
                    cover: String(item.artworkUrl100 || '').replace(/\d+x\d+bb\./, '600x600bb.'),
                    playQuery: `${item.artistName} ${item.trackName}`.trim(),
                    source: 'itunes'
                }));
        });
    }

    async getFeaturedArtist(artist, { force = false } = {}) {
        const summary = await this.wikipediaSummary(artist.name, force);
        const image = force
            ? await this.getArtistImage(artist.name, true, summary, artist.image || '') || artist.image || artist.avatar || ''
            : summary.image
                || await this.getArtistImage(artist.name, false, summary)
                || artist.image
                || artist.avatar
                || '';
        return {
            ...artist,
            image,
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

    async findItunesTrack(title, artist = '') {
        const cleanTitle = String(title || '').trim().slice(0, 180);
        const cleanArtist = String(artist || '').trim().slice(0, 120);
        if (!cleanTitle) return null;
        const key = `itunes-track:${matchKey(cleanTitle)}:${matchKey(cleanArtist)}`;
        return this.cached(key, 24 * 60 * 60 * 1000, async () => {
            const term = [cleanArtist, cleanTitle].filter(Boolean).join(' ');
            const query = new URLSearchParams({ term, entity: 'song', limit: '25' });
            const data = await this.requestJson(`https://itunes.apple.com/search?${query}`, 'itunes');
            const titleKey = matchKey(cleanTitle);
            const artistKey = matchKey(cleanArtist);
            const exact = (data.results || []).filter(item => matchKey(item.trackName) === titleKey);
            return exact.find(item => !artistKey || matchKey(item.artistName) === artistKey
                || matchKey(item.artistName).includes(artistKey) || artistKey.includes(matchKey(item.artistName))) || null;
        });
    }

    async lookupItunesCollection(collectionId) {
        if (!Number.isSafeInteger(Number(collectionId)) || Number(collectionId) <= 0) return null;
        const query = new URLSearchParams({ id: String(collectionId), entity: 'song', limit: '100' });
        const data = await this.requestJson(`https://itunes.apple.com/lookup?${query}`, 'itunes');
        const items = data.results || [];
        const collection = items.find(item => item.wrapperType === 'collection') || items[0];
        if (!collection) return null;
        const songs = items.filter(item => item.wrapperType === 'track').map(item => ({
            title: item.trackName || '',
            artist: item.artistName || collection.artistName || '',
            album: item.collectionName || collection.collectionName || '',
            duration: item.trackTimeMillis ? Math.round(item.trackTimeMillis / 1000) : null,
            cover: item.artworkUrl100 || collection.artworkUrl100 || '',
            source: 'itunes'
        })).filter(item => item.title);
        return {
            found: true,
            title: collection.collectionName || collection.trackName || '',
            artist: collection.artistName || '',
            cover: (collection.artworkUrl100 || '').replace(/\d+x\d+bb\./, '600x600bb.'),
            tracks: songs
        };
    }

    async lookupAlbum(title, artist = '') {
        const cleanTitle = String(title || '').trim().slice(0, 180);
        const cleanArtist = String(artist || '').trim().slice(0, 120);
        if (cleanTitle.length < 2) return null;
        return this.cached(`itunes-album-track:${matchKey(cleanTitle)}:${matchKey(cleanArtist)}`, 24 * 60 * 60 * 1000, async () => {
            const track = await this.findItunesTrack(cleanTitle, cleanArtist);
            if (!track?.collectionId) return null;
            const album = await this.lookupItunesCollection(track.collectionId);
            if (!album) return null;
            return {
                ...album,
                title: track.collectionName || album.title,
                artist: track.artistName || album.artist,
                matchedTrack: track.trackName,
                found: true
            };
        });
    }

    async lookupAlbumByName(name, artist = '') {
        const cleanName = String(name || '').trim().slice(0, 180);
        const cleanArtist = String(artist || '').trim().slice(0, 120);
        if (cleanName.length < 2) return null;
        return this.cached(`itunes-album-name:${matchKey(cleanName)}:${matchKey(cleanArtist)}`, 24 * 60 * 60 * 1000, async () => {
            const query = new URLSearchParams({ term: [cleanArtist, cleanName].filter(Boolean).join(' '), entity: 'album', limit: '25' });
            const data = await this.requestJson(`https://itunes.apple.com/search?${query}`, 'itunes');
            const nameKey = matchKey(cleanName);
            const artistKey = matchKey(cleanArtist);
            const match = (data.results || []).find(item => matchKey(item.collectionName) === nameKey
                && (!artistKey || matchKey(item.artistName) === artistKey || matchKey(item.artistName).includes(artistKey)));
            return match ? this.lookupItunesCollection(match.collectionId) : null;
        });
    }

    async lookupTrack(title, artist = '') {
        const cleanTitle = String(title || '').trim().slice(0, 180);
        const cleanArtist = String(artist || '').trim().slice(0, 120);
        if (cleanTitle.length < 2) return null;
        return this.cached(`track:${matchKey(cleanTitle)}:${matchKey(cleanArtist)}`, 24 * 60 * 60 * 1000, async () => {
            const itunes = await this.findItunesTrack(cleanTitle, cleanArtist).catch(() => null);
            if (itunes) {
                const album = itunes.collectionId ? await this.lookupAlbum(cleanTitle, cleanArtist).catch(() => null) : null;
                return {
                    found: true,
                    title: itunes.trackName || cleanTitle,
                    artist: itunes.artistName || cleanArtist,
                    album: itunes.collectionName || album?.title || '',
                    cover: (itunes.artworkUrl100 || '').replace(/\d+x\d+bb\./, '600x600bb.'),
                    recordingId: String(itunes.trackId || ''),
                    duration: itunes.trackTimeMillis ? Math.round(itunes.trackTimeMillis / 1000) : null,
                    artistId: '',
                    source: 'itunes'
                };
            }
            const query = `recording:"${cleanTitle}"${cleanArtist ? ` AND artist:"${cleanArtist}"` : ''}`;
            const data = await this.requestJson(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&limit=10&fmt=json`);
            const titleKey = matchKey(cleanTitle);
            const artistKey = matchKey(cleanArtist);
            const recording = (data.recordings || []).find(item => {
                if (matchKey(item.title) !== titleKey) return false;
                const names = (item['artist-credit'] || []).filter(credit => typeof credit === 'object')
                    .map(credit => matchKey(credit.name || credit.artist?.name)).filter(Boolean);
                return !artistKey || names.some(name => name === artistKey || name.includes(artistKey) || artistKey.includes(name));
            });
            if (!recording) return null;
            const credits = (recording['artist-credit'] || []).filter(item => typeof item === 'object').map(item => item.name || item.artist?.name).filter(Boolean);
            return {
                found: true,
                title: recording.title || cleanTitle,
                artist: credits.join(', ') || cleanArtist,
                album: recording.releases?.[0]?.title || '',
                cover: '',
                recordingId: recording.id,
                duration: recording.length ? Math.round(recording.length / 1000) : null,
                artistId: recording['artist-credit']?.find(item => typeof item === 'object')?.artist?.id || '',
                source: 'musicbrainz'
            };
        });
    }
}

module.exports = MusicMetadataService;
module.exports.matchKey = matchKey;
