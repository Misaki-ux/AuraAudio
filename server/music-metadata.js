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

// Shared track metadata parser used by the YouTube downloader, the lyrics
// lookup and the cover lookup so that the artist is never silently replaced
// by a generic "YouTube Audio" / "Topic" uploader name.
const GENERIC_ARTIST_RE = /^(unknown(?:\s+artist)?|youtube(?:\s+audio)?|various\s+artists?|topic|unknown)$/i;
const FEATURE_RE = /\s*(?:ft\.?|feat\.?|featuring|with)\s+[a-z0-9][a-z0-9'&. -]*/gi;
const PAREN_BRACKET_RE = /\s*[\[(](?:[^)\]]*(?:official|music\s+video|lyrics?|audio|explicit|remaster(?:ed)?|international\s+version|radio\s+edit|single\s+version|clip|preview|премьера\s+клипа|official\s+video)[^)]*)[)\]]/gi;

function cleanTitleToken(rawTitle) {
    return String(rawTitle || '')
        .replace(PAREN_BRACKET_RE, ' ')
        .replace(/\s*[-–—]\s*(?:\d{4}\s+)?remaster(?:ed)?\b.*$/i, ' ')
        .replace(FEATURE_RE, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanArtistToken(rawArtist) {
    return String(rawArtist || '')
        .replace(/\s*-\s*topic$/i, '')
        .replace(/\s*\(?\s*(?:official|music\s+video|vevo|topic)\s*\)?\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitArtistTitle(rawTitle) {
    // Split on the first " - " (or en/em dash) that separates artist from title.
    const match = String(rawTitle || '').match(/^(.*?)\s*[-–—]\s*(.+)$/);
    if (!match) return { artist: '', title: rawTitle };
    return { artist: match[1].trim(), title: match[2].trim() };
}

function normalizeCompareName(value) {
    return cleanArtistToken(String(value || '')
        .replace(/[\[(].*?[\])]/gi, ' ')
        .replace(/\s*[-–—]\s*(?:official|lyrics?|music video|audio|video|live|remix|mix|clip|explicit).*$/i, ' ')
        .replace(/\s+/g, ' ')
        .trim());
}

function removeTrailingArtistFromTitle(title, artist) {
    const safeTitle = String(title || '').replace(/[\[(].*?[\])]/gi, ' ').trim();
    const safeArtist = normalizeCompareName(artist);
    if (!safeTitle || !safeArtist) return safeTitle;
    const artistPattern = new RegExp(`\\s*[-–—]\\s*${safeArtist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    return safeTitle.replace(artistPattern, '').trim();
}

function parseTrackMeta(info = {}, fallbackTitle = '') {
    // info comes from yt-dlp metadata (or a hand-built object).
    const rawTitle = String(info.title || fallbackTitle || '').trim();

    // 1. Explicit artist fields from yt-dlp.
    const explicitArtist = cleanArtistToken(info.artist || info.creator || (info.artists && info.artists[0]) || '');

    // 2. Parse the title "Artist - Title".
    const split = splitArtistTitle(rawTitle);
    const titleParsedArtist = cleanArtistToken(split.artist);

    // 3. Channel / uploader, cleaned.
    const channelArtist = cleanArtistToken(info.channel || info.uploader || '');

    // 4. Generic names force us to fall through to the next candidate.
    const isGeneric = name => !name || GENERIC_ARTIST_RE.test(name);

    let artist = '';
    let titleCandidate = rawTitle;

    if (channelArtist && !isGeneric(channelArtist) && split.title && normalizeCompareName(split.title).toLowerCase() === channelArtist.toLowerCase()) {
        artist = channelArtist;
        titleCandidate = split.artist || rawTitle;
    } else if (!isGeneric(explicitArtist)) {
        artist = explicitArtist;
        titleCandidate = split.artist && split.title && normalizeCompareName(split.title).toLowerCase() === explicitArtist.toLowerCase() ? split.artist : split.title || rawTitle;
    } else if (!isGeneric(titleParsedArtist)) {
        artist = titleParsedArtist;
        titleCandidate = split.title || rawTitle;
    } else if (!isGeneric(channelArtist)) {
        artist = channelArtist;
        titleCandidate = split.title || rawTitle;
    }

    titleCandidate = removeTrailingArtistFromTitle(titleCandidate, artist);
    const title = cleanTitleToken(titleCandidate) || titleCandidate || rawTitle;
    return { artist, title };
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
        try {
            const value = await fetcher();
            this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
            return value;
        } catch (error) {
            // Keep previously fetched metadata useful during MusicBrainz outages/rate limits.
            if (entry) {
                console.warn(`[MusicMetadata] Serving stale cache for ${key}:`, error.message);
                return entry.value;
            }
            throw error;
        }
    }

    async requestJson(url, provider = 'musicbrainz') {
        // Apple's chart RSS is regularly slower than the JSON search APIs; aborting it
        // at the generic timeout left the new-releases and chart feeds intermittently empty.
        const timeoutMs = provider === 'apple' ? 15000 : 9000;
        for (let attempt = 0; ; attempt++) {
            if (provider === 'musicbrainz') {
                // MusicBrainz permits one request per second per client. Serialize every
                // attempt, including retries, so concurrent app activity cannot burst it.
                const turn = this.mbQueue.then(async () => {
                    const delay = Math.max(0, 1100 - (Date.now() - this.lastMusicBrainzRequest));
                    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
                    this.lastMusicBrainzRequest = Date.now();
                });
                this.mbQueue = turn.catch(() => {});
                await turn;
            }
            const response = await fetch(url, {
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'AuraAudio/1.6.2 (music discovery; https://github.com/auraplayer)'
                },
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (response.ok) return response.json();
            const retryable = provider === 'musicbrainz' && [429, 502, 503, 504].includes(response.status) && attempt < 2;
            if (!retryable) throw new Error(`${provider} returned HTTP ${response.status}`);
            const retryAfter = Number(response.headers.get('retry-after'));
            const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter * 1000, 10000)
                : 1200 * (2 ** attempt);
            console.warn(`[MusicMetadata] MusicBrainz returned HTTP ${response.status}; retrying in ${delayMs}ms.`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    async wikipediaSummary(title, force = false) {
        const fetchSummary = async () => {
            const summary = { description: '', image: '', articleUrl: '' };
            for (const language of ['en', 'fr']) {
                try {
                    const result = await this.requestJson(`https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, 'wikimedia');
                    summary.description ||= result.extract || '';
                    summary.image ||= result.thumbnail?.source || result.originalimage?.source || '';
                    summary.articleUrl ||= result.content_urls?.desktop?.page || result.desktop?.page || '';
                    if (summary.description) break;
                } catch {
                    continue;
                }
            }
            return summary;
        };
        if (!force) return this.cached(`wiki:${title.toLowerCase()}`, 24 * 60 * 60 * 1000, fetchSummary);

        const summary = await fetchSummary();
        this.cache.set(`wiki:${title.toLowerCase()}`, { value: summary, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
        return summary;
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
            const resultLimit = Math.max(1, Math.min(20, limit));
            const [musicBrainz, itunes] = await Promise.all([
                this.requestJson(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(q)}&fmt=json&limit=${resultLimit}`)
                    .catch(error => {
                        console.warn(`[MusicMetadata] MusicBrainz artist search failed for "${q}":`, error.message);
                        return { artists: [] };
                    }),
                this.requestJson(`https://itunes.apple.com/search?${new URLSearchParams({ term: q, entity: 'musicArtist', limit: String(resultLimit) })}`, 'itunes')
                    .catch(error => {
                        console.warn(`[MusicMetadata] iTunes artist search failed for "${q}":`, error.message);
                        return { results: [] };
                    })
            ]);
            const artistsByName = new Map();
            for (const artist of musicBrainz.artists || []) {
                const normalized = this.normalizeArtist(artist);
                const key = matchKey(normalized.name);
                if (key) artistsByName.set(key, normalized);
            }
            for (const artist of itunes.results || []) {
                if (artist.wrapperType !== 'artist' || !artist.artistName) continue;
                const key = matchKey(artist.artistName);
                if (key && !artistsByName.has(key)) {
                    artistsByName.set(key, {
                        id: '',
                        name: artist.artistName,
                        type: artist.artistType || 'Person',
                        country: '',
                        disambiguation: '',
                        score: 0,
                        tags: []
                    });
                }
            }
            return [...artistsByName.values()]
                .sort((a, b) => Number(matchKey(b.name) === matchKey(q)) - Number(matchKey(a.name) === matchKey(q))
                    || (Number(b.score) || 0) - (Number(a.score) || 0))
                .slice(0, resultLimit);
        });
    }

    async getArtistProfile(id, fallback = null) {
        if (!/^[a-f0-9-]{36}$/i.test(String(id))) throw new Error('Invalid MusicBrainz artist ID');
        return this.cached(`artist-profile:${id}`, 12 * 60 * 60 * 1000, async () => {
            const artistData = await this.requestJson(`https://musicbrainz.org/ws/2/artist/${encodeURIComponent(id)}?fmt=json&inc=genres+tags`);
            const artist = this.normalizeArtist(artistData);
            const trackQuery = new URLSearchParams({ term: artist.name, entity: 'song', limit: '50' });
            const [summary, releaseData, recordings, itunesAlbums, itunesTracks] = await Promise.all([
                this.wikipediaSummary(artist.name),
                this.requestJson(`https://musicbrainz.org/ws/2/release-group?artist=${encodeURIComponent(id)}&limit=100&fmt=json`).catch(() => ({ 'release-groups': [] })),
                this.requestJson(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(`arid:${id}`)}&limit=25&fmt=json`).catch(() => ({ recordings: [] })),
                this.getItunesAlbumsForArtist(artist.name),
                this.requestJson(`https://itunes.apple.com/search?${trackQuery}`, 'itunes').catch(error => {
                    console.warn(`[MusicMetadata] iTunes tracks lookup failed for "${artist.name}":`, error.message);
                    return { results: [] };
                })
            ]);
            const musicBrainzAlbums = (releaseData['release-groups'] || []).map(release => ({
                id: release.id,
                title: release.title,
                date: release['first-release-date'] || '',
                type: release['primary-type'] || 'Release',
                cover: `https://coverartarchive.org/release-group/${release.id}/front-250`,
                artist: artist.name,
                source: 'musicbrainz'
            }));
            const albumMap = new Map(musicBrainzAlbums.map(album => [matchKey(album.title), album]));
            for (const album of this.normalizeItunesAlbums(itunesAlbums.results, matchKey(artist.name))) {
                const key = matchKey(album.title);
                const existing = albumMap.get(key);
                if (!existing) albumMap.set(key, album);
                else {
                    existing.itunesId = album.id;
                    if (!existing.cover && album.cover) existing.cover = album.cover;
                }
            }
            const albums = [...albumMap.values()]
                .sort((a, b) => String(b.date).localeCompare(String(a.date)))
                .slice(0, 100);
            const musicBrainzTracks = (recordings.recordings || []).map(recording => ({
                id: recording.id,
                title: recording.title,
                artist: artist.name,
                duration: recording.length ? Math.round(recording.length / 1000) : 0,
                source: 'musicbrainz'
            }));
            const itunesTrackRows = (itunesTracks.results || [])
                .filter(track => track.wrapperType === 'track' && track.trackName && matchKey(track.artistName) === matchKey(artist.name))
                .map(track => ({
                    id: track.trackId ? `itunes_${track.trackId}` : `itunes_${matchKey(track.trackName)}`,
                    title: track.trackName,
                    artist: track.artistName || artist.name,
                    album: track.collectionName || '',
                    duration: track.trackTimeMillis ? Math.round(track.trackTimeMillis / 1000) : 0,
                    cover: String(track.artworkUrl100 || '').replace(/\d+x\d+bb\./, '600x600bb.'),
                    playQuery: `${track.artistName || artist.name} ${track.trackName}`.trim(),
                    source: 'itunes'
                }));
            const trackMap = new Map();
            for (const track of [...musicBrainzTracks, ...itunesTrackRows]) {
                const key = matchKey(track.title);
                if (key && !trackMap.has(key)) trackMap.set(key, track);
            }
            const curated = fallback || {};
            return {
                ...artist,
                description: summary.description || curated.bio || '',
                image: summary.image || await this.getArtistImage(artist.name, false, summary) || albums.find(album => album.cover)?.cover || curated.image || curated.avatar || '',
                articleUrl: summary.articleUrl || '',
                albums,
                topTracks: [...trackMap.values()].slice(0, 25).length
                    ? [...trackMap.values()].slice(0, 25)
                    : (curated.topTracks || []).map(track => ({ ...track, artist: artist.name })),
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
                && (!artistKey || matchKey(item.artistName) === artistKey))
            .map(item => ({
                id: String(item.collectionId),
                title: item.collectionName,
                artist: item.artistName || '',
                date: String(item.releaseDate || '').slice(0, 10),
                type: releaseType(item.collectionName, item.collectionType),
                genre: item.primaryGenreName || '',
                cover: String(item.artworkUrl100 || '').replace(/\d+x\d+bb\./, '600x600bb.'),
                source: 'itunes'
            }))
            .filter(release => release.id && release.title);
    }

    async getItunesAlbumsForArtist(name) {
        const cleanName = String(name || '').trim().slice(0, 120);
        if (cleanName.length < 2) return { results: [] };
        const artistQuery = new URLSearchParams({ term: cleanName, entity: 'musicArtist', limit: '25' });
        const artistData = await this.requestJson(`https://itunes.apple.com/search?${artistQuery}`, 'itunes').catch(error => {
            console.warn(`[MusicMetadata] iTunes artist lookup failed for "${cleanName}":`, error.message);
            return { results: [] };
        });
        const exactArtist = (artistData.results || []).find(item => item.wrapperType === 'artist'
            && matchKey(item.artistName) === matchKey(cleanName));
        const albumQuery = exactArtist?.artistId
            ? new URLSearchParams({ id: String(exactArtist.artistId), entity: 'album', limit: '200' })
            : new URLSearchParams({ term: cleanName, entity: 'album', limit: '200' });
        const endpoint = exactArtist?.artistId ? 'lookup' : 'search';
        return this.requestJson(`https://itunes.apple.com/${endpoint}?${albumQuery}`, 'itunes').catch(error => {
            console.warn(`[MusicMetadata] iTunes albums lookup failed for "${cleanName}":`, error.message);
            return { results: [] };
        });
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
        const cleanName = String(name || '').trim().slice(0, 120);
        if (cleanName.length < 2) return fallback ? this.getFeaturedArtist(fallback) : null;
        const matches = await this.searchArtists(name, 5);
        const exactMatch = matches.find(item => matchKey(item.name) === matchKey(cleanName));
        if (!exactMatch?.id) return this.getArtistCatalogProfile(cleanName, fallback);
        try {
            return await this.getArtistProfile(exactMatch.id, fallback);
        } catch (error) {
            console.warn(`[MusicMetadata] MusicBrainz profile failed for "${cleanName}"; trying the catalog profile:`, error.message);
            return this.getArtistCatalogProfile(cleanName, fallback);
        }
    }

    async getArtistCatalogProfile(name, fallback = null) {
        const cleanName = String(name || '').trim().slice(0, 120);
        if (cleanName.length < 2) return fallback ? this.getFeaturedArtist(fallback) : null;
        return this.cached(`artist-catalog-profile:${matchKey(cleanName)}`, 12 * 60 * 60 * 1000, async () => {
            const trackQuery = new URLSearchParams({ term: cleanName, entity: 'song', limit: '50' });
            const [summary, albumData, trackData] = await Promise.all([
                this.wikipediaSummary(cleanName),
                this.getItunesAlbumsForArtist(cleanName),
                this.requestJson(`https://itunes.apple.com/search?${trackQuery}`, 'itunes')
            ]);
            const artistName = [...(albumData.results || []), ...(trackData.results || [])]
                .find(item => matchKey(item.artistName) === matchKey(cleanName))?.artistName || cleanName;
            const artistKey = matchKey(artistName);
            const albums = this.normalizeItunesAlbums(albumData.results, artistKey)
                .sort((a, b) => String(b.date).localeCompare(String(a.date)));
            const topTracks = (trackData.results || [])
                .filter(track => track.wrapperType === 'track' && track.trackName && matchKey(track.artistName) === artistKey)
                .map(track => ({
                    id: track.trackId ? `itunes_${track.trackId}` : `itunes_${matchKey(track.trackName)}`,
                    title: track.trackName,
                    artist: track.artistName || artistName,
                    album: track.collectionName || '',
                    duration: track.trackTimeMillis ? Math.round(track.trackTimeMillis / 1000) : 0,
                    cover: String(track.artworkUrl100 || '').replace(/\d+x\d+bb\./, '600x600bb.'),
                    playQuery: `${track.artistName || artistName} ${track.trackName}`.trim(),
                    source: 'itunes'
                }));
            if (!albums.length && !topTracks.length) return fallback ? this.getFeaturedArtist(fallback) : null;
            return {
                id: '',
                name: artistName,
                type: 'Person',
                country: '',
                tags: [],
                description: summary.description || fallback?.bio || '',
                image: summary.image || albums.find(album => album.cover)?.cover || await this.getArtistImage(artistName, false, summary) || fallback?.image || fallback?.avatar || '',
                articleUrl: summary.articleUrl || '',
                albums,
                topTracks: topTracks.slice(0, 25),
                sourceUrls: { wikipedia: summary.articleUrl || '', itunes: 'https://www.apple.com/apple-music/' }
            };
        });
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
        const cacheKey = `itunes-album-name-v2:${matchKey(cleanName)}:${matchKey(cleanArtist)}`;
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now() && cached.value?.tracks?.length) return cached.value;

        const searchAndResolve = async (term, artistKey, strict = false) => {
            const query = new URLSearchParams({ term, entity: 'album', limit: '25' });
            const data = await this.requestJson(`https://itunes.apple.com/search?${query}`, 'itunes').catch(() => ({ results: [] }));
            const nameKey = matchKey(cleanName);
            const results = (data.results || []).filter(item => item.wrapperType === 'collection' && item.collectionName);
            const score = (item) => {
                const cKey = matchKey(item.collectionName);
                const aKey = matchKey(item.artistName);
                let v = 0;
                if (cKey === nameKey) v += 100;
                else if (cKey.includes(nameKey) || nameKey.includes(cKey)) v += 55;
                else if (strict) return -1;
                else v += 10;
                if (artistKey) {
                    if (aKey === artistKey) v += 60;
                    else if (aKey.includes(artistKey) || artistKey.includes(aKey)) v += 25;
                    else if (strict) return -1;
                }
                return v;
            };
            const candidates = results
                .map(item => ({ item, score: score(item) }))
                .filter(entry => entry.score > 0)
                .sort((a, b) => b.score - a.score);
            for (const candidate of candidates.slice(0, 5)) {
                const album = await this.lookupItunesCollection(candidate.item.collectionId).catch(() => null);
                if (album?.tracks?.length) return { ...album, found: true };
            }
            return candidates[0] ? await this.lookupItunesCollection(candidates[0].item.collectionId).catch(() => null) : null;
        };

        const artistKey = matchKey(cleanArtist);
        let result = null;
        if (cleanArtist) result = await searchAndResolve([cleanArtist, cleanName].filter(Boolean).join(' '), artistKey, false);
        if (!result?.tracks?.length) result = await searchAndResolve(cleanName, artistKey, false);
        if (!result?.tracks?.length && !artistKey) result = await searchAndResolve(cleanName, '', false);
        if (result?.tracks?.length) {
            result.found = true;
            this.cache.set(cacheKey, { value: result, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
            return result;
        }
        return result; // may be found with empty tracks, but don't cache empty as success
    }

    async lookupAlbumById(id, source, itunesId = '', title = '', artist = '') {
        const cleanId = String(id || '').trim();
        const cleanItunesId = /^d+$/.test(String(itunesId || '').trim()) ? String(itunesId).trim() : '';
        const hasTracks = (value) => Boolean(value && Array.isArray(value.tracks) && value.tracks.length);

        if (cleanItunesId) {
            const result = await this.lookupItunesCollection(cleanItunesId).catch(() => null);
            if (hasTracks(result)) return result;
        }
        if (/^d+$/.test(cleanId)) {
            const result = await this.lookupItunesCollection(cleanId).catch(() => null);
            if (hasTracks(result)) return result;
        }

        if (/^[a-f0-9-]{36}$/i.test(cleanId)) {
            const cacheKey = `musicbrainz-album-track-v2:${cleanId}`;
            const cached = this.cache.get(cacheKey);
            if (cached && cached.expiresAt > Date.now() && cached.value?.tracks?.length) return cached.value;
            try {
                const group = await this.requestJson(`https://musicbrainz.org/ws/2/release-group/${encodeURIComponent(cleanId)}?inc=releases&fmt=json`);
                const releases = group.releases || [];
                const ranked = [...releases].sort((a, b) => (a.status === 'Official' ? -1 : 1) - (b.status === 'Official' ? -1 : 1));
                for (const release of ranked.slice(0, 4)) {
                    if (!release?.id) continue;
                    try {
                        const releaseData = await this.requestJson(`https://musicbrainz.org/ws/2/release/${encodeURIComponent(release.id)}?inc=recordings+artist-credits&fmt=json`);
                        const artistName = (releaseData['artist-credit'] || [])
                            .filter(credit => typeof credit === 'object')
                            .map(credit => credit.name || credit.artist?.name)
                            .filter(Boolean)
                            .join(', ');
                        const tracks = (releaseData.media || []).flatMap(medium => (medium.tracks || []).map(track => ({
                            title: track.title || track.recording?.title || '',
                            artist: (track['artist-credit'] || releaseData['artist-credit'] || [])
                                .filter(credit => typeof credit === 'object')
                                .map(credit => credit.name || credit.artist?.name)
                                .filter(Boolean)
                                .join(', ') || artistName,
                            duration: track.length || track.recording?.length
                                ? Math.round((track.length || track.recording.length) / 1000)
                                : null,
                            source: 'musicbrainz'
                        }))).filter(track => track.title);
                        if (tracks.length) {
                            const result = {
                                found: true,
                                title: release.title || group.title || '',
                                artist: artistName,
                                cover: `https://coverartarchive.org/release/${release.id}/front-250`,
                                tracks
                            };
                            this.cache.set(cacheKey, { value: result, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
                            return result;
                        }
                    } catch (releaseError) {
                        console.warn('[MusicMetadata] Release lookup failed:', release?.id, releaseError.message);
                    }
                }
            } catch (error) {
                console.warn('[MusicMetadata] MusicBrainz album lookup failed:', cleanId, error.message);
            }
        }

        const fallbackTitle = String(title || '').trim();
        const fallbackArtist = String(artist || '').trim();
        if (fallbackTitle) return this.lookupAlbumByName(fallbackTitle, fallbackArtist);
        return null;
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
module.exports.parseTrackMeta = parseTrackMeta;
