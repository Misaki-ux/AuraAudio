// =========================================================================
// AuraAudio Discovery Engine (server/discovery.js)
// Builds live metadata-only feeds (artwork + titles) from real providers.
// A feed never carries audio: playback resolves the track on demand through
// POST /api/ytb/download using each item's playQuery.
// =========================================================================

const { matchKey } = require('./music-metadata');

const FEED_ITEM_LIMIT = 24;
const SIGNAL_ARTIST_LIMIT = 5;
const RECOMMENDATION_ARTIST_LIMIT = 3;
const RECOMMENDATION_ALBUMS_PER_ARTIST = 2;
const TRENDING_THEME_LIMIT = 3;

const MOOD_THEMES = [
    { id: 'mix_electro', title: 'Electro mood', badge: 'ELECTRO', description: 'Electronic, house and synth sounds.', color: 'from-violet-600 to-indigo-950', query: 'electro house electronic music hits' },
    { id: 'mix_pop', title: 'Pop mood', badge: 'POP', description: 'Pop favorites for an upbeat mood.', color: 'from-pink-600 to-rose-950', query: 'popular pop songs hits' },
    { id: 'mix_rock', title: 'Rock mood', badge: 'ROCK', description: 'Rock anthems and guitar-driven tracks.', color: 'from-orange-600 to-red-950', query: 'classic rock anthems hits' },
    { id: 'mix_rap', title: 'Rap mood', badge: 'RAP', description: 'Hip-hop beats and lyrical flows.', color: 'from-yellow-600 to-amber-950', query: 'hip hop rap hits' },
    { id: 'mix_asian', title: 'Asian mood', badge: 'ASIAN', description: 'K-pop, J-pop and Asian hits.', color: 'from-red-600 to-pink-950', query: 'kpop jpop asian hits' },
    { id: 'mix_jpop', title: 'J-Pop mood', badge: 'J-POP', description: 'Japanese pop and anime music.', color: 'from-pink-500 to-fuchsia-950', query: 'jpop anime songs hits' },
    { id: 'mix_jazz', title: 'Jazz mood', badge: 'JAZZ', description: 'Smooth jazz and instrumental classics.', color: 'from-teal-600 to-cyan-950', query: 'smooth jazz standards' },
    { id: 'mix_blues', title: 'Blues mood', badge: 'BLUES', description: 'Soulful blues and guitar licks.', color: 'from-blue-700 to-indigo-950', query: 'blues guitar classics' },
    { id: 'mix_country', title: 'Country mood', badge: 'COUNTRY', description: 'Country and folk Americana.', color: 'from-amber-700 to-yellow-950', query: 'country folk classics' },
    { id: 'mix_reggae', title: 'Reggae mood', badge: 'REGGAE', description: 'Laid-back reggae rhythms and roots classics.', color: 'from-lime-600 to-green-950', query: 'reggae roots classics' },
    { id: 'mix_rnb', title: 'R&B mood', badge: 'R&B', description: 'Smooth contemporary R&B and soulful grooves.', color: 'from-fuchsia-700 to-purple-950', query: 'rnb soul hits' },
    { id: 'mix_classical', title: 'Classical mood', badge: 'CLASSICAL', description: 'Orchestral favorites and quiet piano pieces.', color: 'from-sky-700 to-slate-950', query: 'classical piano orchestral' },
    { id: 'mix_techno', title: 'Techno mood', badge: 'TECHNO', description: 'Driving techno, club energy and hypnotic rhythms.', color: 'from-cyan-700 to-blue-950', query: 'techno club hits' },
    { id: 'mix_metal', title: 'Metal mood', badge: 'METAL', description: 'Heavy riffs, powerful drums and metal anthems.', color: 'from-slate-600 to-zinc-950', query: 'heavy metal anthems' },
    { id: 'mix_indie', title: 'Indie mood', badge: 'INDIE', description: 'Indie favorites and alternative discoveries.', color: 'from-rose-700 to-purple-950', query: 'indie alternative hits' },
    { id: 'mix_latin', title: 'Latin mood', badge: 'LATIN', description: 'Latin pop, reggaeton and dance-ready rhythms.', color: 'from-rose-600 to-amber-950', query: 'latin reggaeton hits' }
];

class DiscoveryService {
    constructor(musicMetadata) {
        this.musicMetadata = musicMetadata;
    }

    // Anything that could point at stored audio is dropped before a feed leaves
    // the server, so clients can only ever cache artwork and names.
    static feedItem(item) {
        if (!item || typeof item !== 'object') return null;
        const { streamUrl, audioUrl, downloadUrl, fileName, blob, src, ...meta } = item;
        if (!meta.title && !meta.name) return null;
        return meta;
    }

    static feedList(list) {
        return (Array.isArray(list) ? list : []).map(DiscoveryService.feedItem).filter(Boolean);
    }

    static playQuery(artist, title) {
        return `${String(artist || '').trim()} ${String(title || '').trim()}`.trim();
    }

    static normalize(value) {
        return String(value || '').trim().toLowerCase();
    }

    static trackKey(item) {
        return `${matchKey(item?.title)}|${matchKey(item?.artist)}`;
    }

    static uniqueTracks(list) {
        const seen = new Set();
        return (Array.isArray(list) ? list : []).filter(item => {
            const key = DiscoveryService.trackKey(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    // The three personalization signals, ordered by strength: artists you like,
    // artists behind songs you liked, then artists you recently played.
    static signalArtists(signals = {}) {
        const byName = new Map();
        const add = (name, source) => {
            const clean = String(name || '').trim();
            if (clean.length < 2 || /^(unknown(?: artist)?|youtube(?: audio)?|local(?: track| audio)?)$/i.test(clean)) return;
            const key = matchKey(clean);
            if (!byName.has(key)) byName.set(key, { name: clean, sources: new Set() });
            byName.get(key).sources.add(source);
        };
        for (const artist of signals.likedArtists || []) add(artist?.name || artist, 'likedArtist');
        for (const track of signals.likedTracks || []) add(track?.artist, 'likedSong');
        for (const track of signals.recentTracks || []) add(track?.artist, 'recentlyPlayed');
        return [...byName.values()];
    }

    static reasonFor(seed) {
        if (seed.sources.has('likedArtist')) return `Because you like ${seed.name}`;
        if (seed.sources.has('likedSong')) return `From a song you liked by ${seed.name}`;
        return `From what you recently played by ${seed.name}`;
    }

    static interleave(groups) {
        const out = [];
        const longest = Math.max(0, ...groups.map(group => group.length));
        for (let index = 0; index < longest; index++) {
            for (const group of groups) if (group[index]) out.push(group[index]);
        }
        return out;
    }

    // LATEST RELEASES — personalized from liked artists, liked songs and recent plays.
    async getLatestReleases(signals = {}, { limit = FEED_ITEM_LIMIT, perArtist = 4 } = {}) {
        const seeds = DiscoveryService.signalArtists(signals);
        const lookups = await Promise.all(seeds.slice(0, SIGNAL_ARTIST_LIMIT).map(async seed => {
            try {
                const profile = await this.musicMetadata.getLatestReleasesByArtist(seed.name);
                return { seed, name: profile?.artist?.name || seed.name, releases: profile?.releases || [] };
            } catch (error) {
                console.warn(`[Discovery] Latest releases lookup failed for "${seed.name}":`, error.message);
                return null;
            }
        }));

        const merged = [];
        for (const lookup of lookups.filter(Boolean)) {
            for (const release of lookup.releases.slice(0, perArtist)) {
                merged.push(DiscoveryService.feedItem({
                    ...release,
                    artist: lookup.name,
                    reason: DiscoveryService.reasonFor(lookup.seed),
                    basedOn: [...lookup.seed.sources],
                    playQuery: DiscoveryService.playQuery(lookup.name, release.title)
                }));
            }
        }

        const personalized = DiscoveryService.uniqueTracks(
            merged.sort((a, b) => String(b.date).localeCompare(String(a.date)))
        ).slice(0, limit);

        if (personalized.length) {
            return { personalized: true, basedOn: DiscoveryService.signalSummary(seeds), releases: personalized };
        }

        // No listening history yet: real charted new releases instead of anything invented.
        const fresh = await this.musicMetadata.getNewReleases(limit).catch(error => {
            console.warn('[Discovery] New releases feed unavailable:', error.message);
            return [];
        });
        return {
            personalized: false,
            basedOn: DiscoveryService.signalSummary(seeds),
            releases: fresh.map(release => DiscoveryService.feedItem({
                ...release,
                reason: 'New releases right now',
                basedOn: ['live'],
                playQuery: DiscoveryService.playQuery(release.artist, release.title)
            })).filter(Boolean)
        };
    }

    static signalSummary(seeds = []) {
        const pick = source => seeds.filter(seed => seed.sources.has(source)).map(seed => seed.name);
        return { likedArtists: pick('likedArtist'), likedSongs: pick('likedSong'), recentlyPlayed: pick('recentlyPlayed') };
    }

    // FEATURED ARTISTS — the people in your signals, plus those behind your feed releases.
    async getFeaturedArtists(signals = {}, releases = [], limit = 8) {
        const candidates = DiscoveryService.signalArtists(signals)
            .map(seed => ({ name: seed.name, reason: DiscoveryService.reasonFor(seed) }));
        const seen = new Set(candidates.map(candidate => matchKey(candidate.name)));
        for (const release of releases) {
            const name = String(release.artist || '').trim();
            const key = matchKey(name);
            if (name.length < 2 || seen.has(key)) continue;
            seen.add(key);
            candidates.push({ name, reason: release.reason || 'From your latest releases' });
        }

        const profiles = await Promise.all(candidates.slice(0, limit).map(async candidate => {
            const { name, reason } = candidate;
            try {
                const albums = await this.musicMetadata.getArtistTopAlbums(name);
                const image = await this.musicMetadata.getArtistImage(name);
                const genres = [...new Set(albums.map(album => album.genre).filter(Boolean))];
                return DiscoveryService.feedItem({
                    id: `name:${encodeURIComponent(name)}`,
                    name,
                    image: image || '',
                    genre: genres[0] || 'Artist',
                    bio: reason,
                    reason,
                    topTracks: albums.slice(0, 5).map(album => ({
                        id: `rel_${album.id}`,
                        title: album.title,
                        artist: name,
                        duration: '',
                        year: album.date ? Number(String(album.date).slice(0, 4)) : null,
                        cover: album.cover,
                        playQuery: DiscoveryService.playQuery(name, album.title)
                    }))
                });
            } catch (error) {
                console.warn(`[Discovery] Featured artist lookup failed for "${name}":`, error.message);
                return null;
            }
        }));
        return profiles.filter(Boolean);
    }

    // DAILY MIXES — assembled from live provider results passed in by the router.
    getDailyMixes(signals = {}, onlineRelatedTracks = [], moodTracks = {}, themeOffset = 0) {
        const likedArtists = (Array.isArray(signals.likedArtists) ? signals.likedArtists : [])
            .map(artist => ({ name: String(artist?.name || artist || '').trim(), image: artist?.image || '' }))
            .filter(artist => artist.name);
        const likedKeys = new Set(likedArtists.map(artist => DiscoveryService.normalize(artist.name)));

        const history = [...(signals.recentTracks || []), ...(signals.likedTracks || [])]
            .filter(track => track && track.title)
            .map(track => ({ title: track.title, artist: track.artist || '' }));
        const heard = new Set(history.map(DiscoveryService.trackKey));
        const listened = DiscoveryService.uniqueTracks(history);

        const dynamicRelated = DiscoveryService.uniqueTracks(
            (Array.isArray(onlineRelatedTracks) ? onlineRelatedTracks : [])
                .filter(track => track && track.title && track.artist)
                .filter(track => !heard.has(DiscoveryService.trackKey(track)))
                .map(track => ({ ...track, reason: track.reason || 'Because you like this artist' }))
        );

        // Everything live we know about one liked artist, else a real search that
        // resolves to audio only when the user plays it.
        const tracksForArtist = (name, image) => {
            const needle = DiscoveryService.normalize(name);
            const matches = track => DiscoveryService.normalize(track.artist).includes(needle)
                || DiscoveryService.normalize(track.forArtist) === needle;
            const pool = DiscoveryService.uniqueTracks([
                ...dynamicRelated.filter(matches),
                ...listened.filter(matches)
            ]).map(track => ({ ...track, cover: track.cover || image || '' }));
            return pool;
        };

        const artistGroups = likedArtists.map(artist => ({
            artist,
            tracks: tracksForArtist(artist.name, artist.image)
        })).filter(group => group.tracks.length);

        const tracks = DiscoveryService.uniqueTracks(DiscoveryService.interleave([
            DiscoveryService.interleave(artistGroups.map(group => group.tracks)).slice(0, 12),
            listened.slice(0, 6),
            dynamicRelated.slice(0, 6)
        ])).slice(0, FEED_ITEM_LIMIT);

        const personalizedMix = {
            id: 'mix_personalized',
            title: 'Your Aura Mix',
            description: likedArtists.length
                ? `Built around ${likedArtists.slice(0, 3).map(artist => artist.name).join(', ')} and your liked songs.`
                : 'A mix shaped by your liked songs and artists you listen to.',
            badge: 'Made for you',
            color: 'from-blue-600 to-indigo-900',
            personalized: true,
            basedOnArtists: likedArtists.map(artist => artist.name),
            tracksCount: tracks.length,
            tracks
        };

        const artistMixes = artistGroups.slice(0, 2).map(({ artist, tracks: list }) => ({
            id: `mix_artist_${matchKey(artist.name)}`,
            title: `${artist.name} Mix`,
            description: `Because you like ${artist.name}.`,
            badge: 'ARTIST MIX',
            color: 'from-emerald-600 to-teal-950',
            personalized: true,
            artist: artist.name,
            tracksCount: list.length,
            tracks: list
        }));

        // A mood mix is only offered when the live provider returned real tracks.
        const themes = MOOD_THEMES.map(theme => {
            const liveTracks = DiscoveryService.uniqueTracks(DiscoveryService.feedList(moodTracks[theme.id] || [])).slice(0, 12);
            if (!liveTracks.length) return null;
            const { query, ...display } = theme;
            return { ...display, personalized: false, tracks: liveTracks, tracksCount: liveTracks.length };
        }).filter(Boolean);

        return [...(themeOffset === 0 ? [personalizedMix, ...artistMixes] : []), ...themes].filter(mix => Array.isArray(mix.tracks) && mix.tracks.length);
    }

    getSignalArtists(signals = {}) {
        return DiscoveryService.signalArtists(signals);
    }

    // Runs the live lookups behind the mix feed, then assembles it.
    async buildDailyMix(signals = {}, { offset = 0, limit = 6 } = {}) {
        const safeOffset = Math.max(0, Math.min(MOOD_THEMES.length, Number(offset) || 0));
        const requestedLimit = Math.max(4, Math.min(8, Number(limit) || 6));
        // Reserve room in the first paint for personal and artist mixes while
        // keeping the first rendered batch within eight cards.
        const safeLimit = safeOffset === 0 ? Math.min(5, requestedLimit) : requestedLimit;
        const themes = MOOD_THEMES.slice(safeOffset, safeOffset + safeLimit);
        const seeds = DiscoveryService.signalArtists(signals);
        const relatedBatches = safeOffset === 0 ? await Promise.all(seeds.slice(0, 1).map(async seed => {
            try {
                const tracks = await this.musicMetadata.searchSongs(`${seed.name} hits`, 5);
                return tracks.map(track => ({ ...track, forArtist: seed.name, reason: DiscoveryService.reasonFor(seed) }));
            } catch (error) {
                console.warn(`[Discovery] Related tracks lookup failed for "${seed.name}":`, error.message);
                return [];
            }
        })) : [];
        const moodEntries = await Promise.all(themes.map(async theme => {
            try {
                return [theme.id, await this.musicMetadata.searchSongs(theme.query, 12)];
            } catch (error) {
                console.warn(`[Discovery] Mood mix "${theme.id}" unavailable:`, error.message);
                return [theme.id, []];
            }
        }));
        const mixes = this.getDailyMixes(signals, relatedBatches.flat(), Object.fromEntries(moodEntries), safeOffset);
        return { mixes, nextOffset: safeOffset + themes.length, hasMore: safeOffset + themes.length < MOOD_THEMES.length };
    }

    // RECOMMENDATIONS — real tracks off the newest releases of your artists,
    // falling back to live charted songs when there is no history.
    async getRecommendations(signals = {}, options = {}) {
        const seeds = DiscoveryService.signalArtists(signals).slice(0, RECOMMENDATION_ARTIST_LIMIT);
        const batches = await Promise.all(seeds.map(async seed => {
            const found = [];
            try {
                const albums = await this.musicMetadata.getArtistTopAlbums(seed.name);
                for (const album of albums.slice(0, RECOMMENDATION_ALBUMS_PER_ARTIST)) {
                    const detail = await this.musicMetadata.lookupItunesCollection(album.id).catch(() => null);
                    for (const track of detail?.tracks || []) {
                        found.push(DiscoveryService.feedItem({
                            ...track,
                            id: `itunes_${album.id}_${matchKey(track.title)}`,
                            reason: DiscoveryService.reasonFor(seed),
                            basedOn: [...seed.sources],
                            playQuery: DiscoveryService.playQuery(track.artist, track.title)
                        }));
                    }
                }
            } catch (error) {
                console.warn(`[Discovery] Recommendation lookup failed for "${seed.name}":`, error.message);
            }
            return found;
        }));

        const collected = batches.flat();
        if (!collected.length) collected.push(...await this.getChartRecommendations());

        return DiscoveryService.uniqueTracks(collected)
            .filter(track => !this.isExcluded(track, signals, options))
            .slice(0, FEED_ITEM_LIMIT);
    }

    // Cold-start feed: live charted songs, or the busiest mood queries if the
    // chart provider is unavailable.
    async getChartRecommendations(limit = FEED_ITEM_LIMIT) {
        const charted = await this.musicMetadata.getTopSongs(limit).catch(error => {
            console.warn('[Discovery] Chart songs unavailable:', error.message);
            return [];
        });
        if (charted.length) {
            return charted.map(track => DiscoveryService.feedItem({
                ...track,
                reason: 'Trending right now',
                basedOn: ['live'],
                playQuery: DiscoveryService.playQuery(track.artist, track.title)
            })).filter(Boolean);
        }

        const batches = await Promise.all(MOOD_THEMES.slice(0, TRENDING_THEME_LIMIT).map(async theme => {
            const tracks = await this.musicMetadata.searchSongs(theme.query, 12).catch(() => []);
            return tracks.map(track => DiscoveryService.feedItem({
                ...track,
                reason: `Trending in ${theme.badge.toLowerCase()}`,
                basedOn: ['live'],
                playQuery: DiscoveryService.playQuery(track.artist, track.title)
            }));
        }));
        return batches.flat().filter(Boolean);
    }

    isExcluded(track, signals = {}, options = {}) {
        const key = DiscoveryService.trackKey;
        const candidate = key(track);
        if (options.excludeLiked && (signals.likedTracks || []).some(item => key(item) === candidate)) return true;
        if (options.excludePlayed && (signals.recentTracks || []).some(item => key(item) === candidate)) return true;
        return false;
    }

    async search(query) {
        const q = String(query || '').trim();
        if (!q) return { artists: [], tracks: [], releases: [] };
        try {
            const releases = await this.musicMetadata.getNewReleases(FEED_ITEM_LIMIT);
            const needle = DiscoveryService.normalize(q);
            const matched = releases
                .filter(release => DiscoveryService.normalize(release.title).includes(needle)
                    || DiscoveryService.normalize(release.artist).includes(needle))
                .map(release => DiscoveryService.feedItem({
                    ...release,
                    reason: 'New releases right now',
                    basedOn: ['live'],
                    playQuery: DiscoveryService.playQuery(release.artist, release.title)
                }));
            // Tracks and artists come from the live providers wired into /api/search.
            return { artists: [], tracks: [], releases: matched };
        } catch (error) {
            if (!/abort|timeout/i.test(String(error?.message || ''))) {
                console.warn('[Discovery] Search feed lookup failed:', error.message);
            }
            return { artists: [], tracks: [], releases: [] };
        }
    }
}

module.exports = DiscoveryService;
module.exports.MOOD_THEMES = MOOD_THEMES;
