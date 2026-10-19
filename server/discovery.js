// =========================================================================
// AuraAudio Discovery & Recommendations Engine (server/discovery.js)
// Curated Artists, Daily Mix Generators, Algorithmic Recommendations & Releases
// =========================================================================

const ARTISTS_CATALOG = [
    {
        id: "art_kavinsky",
        name: "Kavinsky",
        genre: "Synthwave / Outrun",
        monthlyListeners: "4,820,300",
        avatar: "https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=400&auto=format&fit=crop&q=80",
        bio: "French electronic musician and pioneer of the retro-80s automotive synth sound made famous by Drive.",
        topTracks: [
            { id: "trk_kav_1", title: "Nightcall", duration: "04:19", plays: "389M", year: 2011 },
            { id: "trk_kav_2", title: "Pacific Coast Highway", duration: "03:55", plays: "98M", year: 2013 },
            { id: "trk_kav_3", title: "Protovision", duration: "03:26", plays: "74M", year: 2013 },
            { id: "trk_kav_4", title: "Renegade", duration: "03:18", plays: "41M", year: 2022 }
        ]
    },
    {
        id: "art_daft_punk",
        name: "Daft Punk",
        genre: "French House / Electronic",
        monthlyListeners: "22,410,000",
        avatar: "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=400&auto=format&fit=crop&q=80",
        bio: "Legendary French electronic music duo Guy-Manuel de Homem-Christo and Thomas Bangalter.",
        topTracks: [
            { id: "trk_dp_1", title: "Instant Crush (feat. Julian Casablancas)", duration: "05:37", plays: "590M", year: 2013 },
            { id: "trk_dp_2", title: "Get Lucky (feat. Pharrell Williams)", duration: "04:08", plays: "910M", year: 2013 },
            { id: "trk_dp_3", title: "Harder, Better, Faster, Stronger", duration: "03:44", plays: "480M", year: 2001 },
            { id: "trk_dp_4", title: "Around the World", duration: "03:58", plays: "350M", year: 1997 }
        ]
    },
    {
        id: "art_the_weeknd",
        name: "The Weeknd",
        genre: "Synth-Pop / Contemporary R&B",
        monthlyListeners: "105,800,000",
        avatar: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400&auto=format&fit=crop&q=80",
        bio: "Grammy-winning visionary Canadian artist behind monumental synth-pop hits and cinematic production.",
        topTracks: [
            { id: "trk_tw_1", title: "Blinding Lights", duration: "03:20", plays: "3.9B", year: 2020 },
            { id: "trk_tw_2", title: "Save Your Tears", duration: "03:35", plays: "1.8B", year: 2020 },
            { id: "trk_tw_3", title: "Starboy (feat. Daft Punk)", duration: "03:50", plays: "2.7B", year: 2016 },
            { id: "trk_tw_4", title: "Out of Time", duration: "03:34", plays: "410M", year: 2022 }
        ]
    },
    {
        id: "art_hans_zimmer",
        name: "Hans Zimmer",
        genre: "Cinematic / Neo-Classical",
        monthlyListeners: "14,350,000",
        avatar: "https://images.unsplash.com/photo-1465847899084-d164df4dedc6?w=400&auto=format&fit=crop&q=80",
        bio: "Acclaimed Academy Award-winning film score composer known for Interstellar, Inception, and Dune.",
        topTracks: [
            { id: "trk_hz_1", title: "Cornfield Chase (Interstellar)", duration: "02:07", plays: "420M", year: 2014 },
            { id: "trk_hz_2", title: "Time (Inception)", duration: "04:35", plays: "580M", year: 2010 },
            { id: "trk_hz_3", title: "Mombasa (Inception)", duration: "04:54", plays: "115M", year: 2010 },
            { id: "trk_hz_4", title: "Paul's Dream (Dune)", duration: "07:03", plays: "90M", year: 2021 }
        ]
    },
    {
        id: "art_lorn",
        name: "Lorn",
        genre: "Dark Ambient / Glitch",
        monthlyListeners: "1,240,000",
        avatar: "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=400&auto=format&fit=crop&q=80",
        bio: "American electronic musician Marcos Ortega crafting monolithic, atmospheric dark-sound architecture.",
        topTracks: [
            { id: "trk_lorn_1", title: "Acid Rain", duration: "03:32", plays: "65M", year: 2015 },
            { id: "trk_lorn_2", title: "Anvil", duration: "03:34", plays: "45M", year: 2016 },
            { id: "trk_lorn_3", title: "Ghosst(s)", duration: "03:48", plays: "28M", year: 2012 },
            { id: "trk_lorn_4", title: "555-5555", duration: "04:02", plays: "18M", year: 2012 }
        ]
    },
    {
        id: "art_gunship",
        name: "GUNSHIP",
        genre: "Synthwave / Cyberpunk",
        monthlyListeners: "950,000",
        avatar: "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=400&auto=format&fit=crop&q=80",
        bio: "British synthwave band known for cinematic retro 80s aesthetics and high-octane collaborations.",
        topTracks: [
            { id: "trk_gun_1", title: "Tech Noir", duration: "04:57", plays: "38M", year: 2015 },
            { id: "trk_gun_2", title: "Fly For Your Life", duration: "04:39", plays: "42M", year: 2015 },
            { id: "trk_gun_3", title: "Dark All Day", duration: "05:27", plays: "24M", year: 2018 },
            { id: "trk_gun_4", title: "Monster In Paradise", duration: "04:48", plays: "15M", year: 2023 }
        ]
    }
];

const DAILY_MIXES = [
    {
        id: "mix_1",
        title: "Daily Mix 1: Neon Highway",
        description: "High-octane retrowave, cyberpunk basslines, and analog synthesizers.",
        color: "from-blue-600 to-indigo-900",
        badge: "Retrowave",
        tracksCount: 25,
        tracks: [
            { title: "Nightcall", artist: "Kavinsky", duration: "04:19" },
            { title: "Tech Noir", artist: "GUNSHIP", duration: "04:57" },
            { title: "Blinding Lights", artist: "The Weeknd", duration: "03:20" },
            { title: "Instant Crush", artist: "Daft Punk", duration: "05:37" },
            { title: "Days of Thunder", artist: "The Midnight", duration: "05:24" }
        ]
    },
    {
        id: "mix_2",
        title: "Daily Mix 2: Midnight Coffee",
        description: "Warm tape-saturation, gentle lo-fi piano chords, and soothing study beats.",
        color: "from-amber-600 to-orange-950",
        badge: "Lo-Fi Beats",
        tracksCount: 30,
        tracks: [
            { title: "Morning Mist", artist: "Kupla", duration: "02:40" },
            { title: "Coffee Cold", artist: "Galdive", duration: "03:15" },
            { title: "Rainy Afternoon", artist: "Idealism", duration: "02:50" },
            { title: "Snowfall", artist: "Øneheart x reidenshi", duration: "02:04" }
        ]
    },
    {
        id: "mix_3",
        title: "Daily Mix 3: Cinematic Horizons",
        description: "Expansive orchestral crescendos, modular synthesizers, and timeless soundscapes.",
        color: "from-purple-600 to-slate-900",
        badge: "Soundtrack",
        tracksCount: 20,
        tracks: [
            { title: "Cornfield Chase", artist: "Hans Zimmer", duration: "02:07" },
            { title: "Time", artist: "Hans Zimmer", duration: "04:35" },
            { title: "Acid Rain", artist: "Lorn", duration: "03:32" },
            { title: "Day One", artist: "Hans Zimmer", duration: "03:19" }
        ]
    },
    {
        id: "mix_4",
        title: "Daily Mix 4: Midnight Electro",
        description: "French touch grooves, four-on-the-floor kicks, and robotic vocoders.",
        color: "from-emerald-600 to-teal-950",
        badge: "Electronic",
        tracksCount: 22,
        tracks: [
            { title: "Harder, Better, Faster, Stronger", artist: "Daft Punk", duration: "03:44" },
            { title: "Genesis", artist: "Justice", duration: "03:54" },
            { title: "Starboy", artist: "The Weeknd feat. Daft Punk", duration: "03:50" },
            { title: "Pacific Coast Highway", artist: "Kavinsky", duration: "03:55" }
        ]
    }
];

const LATEST_RELEASES = [
    {
        id: "rel_1",
        title: "Dune: Part Two (Original Motion Picture Soundtrack)",
        artist: "Hans Zimmer",
        type: "Album",
        releaseDate: "Recent Release",
        tracksCount: 25,
        cover: "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=300&auto=format&fit=crop&q=80",
        leadTrack: "A Time of Quiet Between the Storms"
    },
    {
        id: "rel_2",
        title: "Unicorn",
        artist: "GUNSHIP",
        type: "Album",
        releaseDate: "Recent Release",
        tracksCount: 14,
        cover: "https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=300&auto=format&fit=crop&q=80",
        leadTrack: "Monster In Paradise"
    },
    {
        id: "rel_3",
        title: "Dancing in the Flames",
        artist: "The Weeknd",
        type: "Single",
        releaseDate: "New Single",
        tracksCount: 1,
        cover: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&auto=format&fit=crop&q=80",
        leadTrack: "Dancing in the Flames"
    },
    {
        id: "rel_4",
        title: "Reborn (The Remixes)",
        artist: "Kavinsky",
        type: "EP",
        releaseDate: "Special Edition",
        tracksCount: 5,
        cover: "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&auto=format&fit=crop&q=80",
        leadTrack: "Cameo (David Guetta Remix)"
    }
];

class DiscoveryService {
    getArtists() {
        return ARTISTS_CATALOG;
    }

    getArtistById(id) {
        return ARTISTS_CATALOG.find(a => a.id === id);
    }

    getDailyMixes(signals = {}, onlineRelatedTracks = [], moodTracks = {}) {
        const history = [...(signals.recentTracks || []), ...(signals.likedTracks || [])]
            .filter(track => track && track.title)
            .map(track => ({ title: track.title, artist: track.artist || '' }));
        const seen = new Set();
        const listened = history.filter(track => {
            const key = `${track.title.toLowerCase()}|${track.artist.toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        const artistWeights = new Map();
        for (const track of history) {
            const artist = String(track.artist || '').trim();
            if (artist) artistWeights.set(artist.toLowerCase(), (artistWeights.get(artist.toLowerCase()) || 0) + 1);
        }
        const related = ARTISTS_CATALOG.flatMap(artist => artist.topTracks.map(track => ({
            id: track.id,
            title: track.title,
            artist: artist.name,
            duration: track.duration,
            cover: artist.avatar,
            reason: `Picked from your listening history`
        }))).filter(track => !seen.has(`${track.title.toLowerCase()}|${track.artist.toLowerCase()}`))
            .map(track => ({ ...track, score: artistWeights.get(track.artist.toLowerCase()) || 0 }))
            .filter(track => track.score > 0)
            .sort((a, b) => b.score - a.score);
        const dynamicRelated = (Array.isArray(onlineRelatedTracks) ? onlineRelatedTracks : [])
            .filter(track => track && track.title && track.artist)
            .filter(track => !seen.has(`${track.title.toLowerCase()}|${track.artist.toLowerCase()}`))
            .filter((track, index, tracks) => tracks.findIndex(candidate =>
                `${candidate.title.toLowerCase()}|${candidate.artist.toLowerCase()}` === `${track.title.toLowerCase()}|${track.artist.toLowerCase()}`
            ) === index)
            .map(track => ({ ...track, reason: track.reason || 'Because you like this artist' }));
        const tracks = [...listened.slice(0, 8), ...related.slice(0, 8), ...dynamicRelated.slice(0, 8)].slice(0, 20);
        const personalizedMix = {
            id: 'mix_personalized',
            title: 'Your Aura Mix',
            description: 'A mix shaped by your liked songs and artists you listen to.',
            badge: 'Made for you',
            color: 'from-blue-600 to-indigo-900',
            personalized: true,
            tracksCount: tracks.length,
            tracks
        };
        const themes = [
            { id: 'mix_electro', title: 'Electro mood', badge: 'ELECTRO', description: 'Electronic, house and synth sounds.', color: 'from-violet-600 to-indigo-950', fallback: [['One More Time', 'Daft Punk'], ['Nightcall', 'Kavinsky'], ['Tech Noir', 'GUNSHIP']] },
            { id: 'mix_pop', title: 'Pop mood', badge: 'POP', description: 'Pop favorites for an upbeat mood.', color: 'from-pink-600 to-rose-950', fallback: [['Blinding Lights', 'The Weeknd'], ['Save Your Tears', 'The Weeknd'], ['Get Lucky', 'Daft Punk']] },
            { id: 'mix_rock', title: 'Rock mood', badge: 'ROCK', description: 'Rock anthems and guitar-driven tracks.', color: 'from-orange-600 to-red-950', fallback: [['Smells Like Teen Spirit', 'Nirvana'], ['Everlong', 'Foo Fighters'], ['Seven Nation Army', 'The White Stripes']] }
        ].map(theme => {
            const remoteTracks = Array.isArray(moodTracks[theme.id]) ? moodTracks[theme.id] : [];
            const themeTracks = remoteTracks.length ? remoteTracks : theme.fallback.map(([title, artist], index) => ({
                id: `${theme.id}_fallback_${index}`, title, artist, playQuery: `${title} ${artist}`, reason: 'Mood mix pick'
            }));
            const { fallback, ...displayTheme } = theme;
            return { ...displayTheme, personalized: false, tracks: themeTracks, tracksCount: themeTracks.length };
        });
        return [personalizedMix, ...themes];
    }

    getLatestReleases() {
        return LATEST_RELEASES;
    }

    getRecommendations(preferredGenres = [], signals = {}, options = {}) {
        // Algorithmic recommendations tailored to listening vibe
        const recommendations = [
            {
                id: "rec_1",
                title: "Resonance",
                artist: "HOME",
                reason: "Because you enjoy Synthwave & Retro Electronics",
                duration: "03:32",
                cover: "https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=150&auto=format&fit=crop&q=80"
            },
            {
                id: "rec_2",
                title: "After Dark",
                artist: "Mr.Kitty",
                reason: "Trending in Dark Electro & Ambient",
                duration: "04:19",
                cover: "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150&auto=format&fit=crop&q=80"
            },
            {
                id: "rec_3",
                title: "Voyager",
                artist: "Daft Punk",
                reason: "Classic Electronic Masterpiece",
                duration: "03:47",
                cover: "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=150&auto=format&fit=crop&q=80"
            },
            {
                id: "rec_4",
                title: "Stay",
                artist: "Hans Zimmer",
                reason: "Interstellar Cinematic High",
                duration: "06:52",
                cover: "https://images.unsplash.com/photo-1465847899084-d164df4dedc6?w=150&auto=format&fit=crop&q=80"
            },
            {
                id: "rec_5",
                title: "Sunset",
                artist: "The Midnight",
                reason: "Similar to Kavinsky & Outrun vibes",
                duration: "05:26",
                cover: "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=150&auto=format&fit=crop&q=80"
            }
        ];
        const tokens = [
            ...(Array.isArray(preferredGenres) ? preferredGenres : []),
            ...(signals.artists || []),
            ...(signals.tracks || [])
        ].map(value => String(value || '').toLowerCase()).filter(Boolean);

        if (!tokens.length) return recommendations.filter(track => !this.isExcluded(track, signals, options));

        const catalogTracks = ARTISTS_CATALOG.flatMap(artist => artist.topTracks.map(track => ({
            id: track.id,
            title: track.title,
            artist: artist.name,
            duration: track.duration,
            cover: artist.avatar,
            reason: `Because you listen to ${artist.name}`,
            score: tokens.reduce((score, token) => score +
                ((artist.name.toLowerCase().includes(token) || token.includes(artist.name.toLowerCase())) ? 3 : 0) +
                ((track.title.toLowerCase().includes(token) || token.includes(track.title.toLowerCase())) ? 2 : 0) +
                ((artist.genre.toLowerCase().includes(token)) ? 1 : 0), 0)
        }))).filter(track => track.score > 0);

        const seeded = recommendations.map(track => ({
            ...track,
            score: tokens.reduce((score, token) => score +
                ((track.artist.toLowerCase().includes(token) || token.includes(track.artist.toLowerCase())) ? 3 : 0) +
                ((track.title.toLowerCase().includes(token) || token.includes(track.title.toLowerCase())) ? 2 : 0), 0)
        }));
        const ranked = [...catalogTracks, ...seeded].sort((a, b) => b.score - a.score);
        const seen = new Set();
        return ranked.filter(track => {
            const key = `${track.title.toLowerCase()}|${track.artist.toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).filter(track => !this.isExcluded(track, signals, options))
            .slice(0, 12).map(({ score, ...track }) => track);
    }

    isExcluded(track, signals, options) {
        const key = item => `${String(item.title || '').trim().toLowerCase()}|${String(item.artist || '').trim().toLowerCase()}`;
        const candidate = key(track);
        if (options.excludeLiked && (signals.likedTracks || []).some(item => key(item) === candidate)) return true;
        if (options.excludePlayed && (signals.recentTracks || []).some(item => key(item) === candidate)) return true;
        return false;
    }

    search(query) {
        if (!query || !query.trim()) {
            return { artists: [], tracks: [], releases: [] };
        }
        const q = query.toLowerCase().trim();

        const artists = ARTISTS_CATALOG.filter(a => 
            a.name.toLowerCase().includes(q) || 
            a.genre.toLowerCase().includes(q)
        );

        const tracks = [];
        ARTISTS_CATALOG.forEach(artist => {
            artist.topTracks.forEach(t => {
                if (t.title.toLowerCase().includes(q) || artist.name.toLowerCase().includes(q)) {
                    tracks.push({
                        ...t,
                        artist: artist.name,
                        artistId: artist.id,
                        avatar: artist.avatar
                    });
                }
            });
        });

        const releases = LATEST_RELEASES.filter(r => 
            r.title.toLowerCase().includes(q) || 
            r.artist.toLowerCase().includes(q)
        );

        return { artists, tracks, releases };
    }
}

module.exports = DiscoveryService;
