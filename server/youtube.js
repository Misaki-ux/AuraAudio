// =========================================================================
// AuraAudio YouTube Downloader & Streamer Engine (server/youtube.js)
// Local Audio Downloader via yt-dlp & FFmpeg with Real-time Progress Tracking
// =========================================================================

const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ARTWORK_MIME_EXTENSIONS = new Map([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif']
]);

function isAllowedArtworkUrl(value) {
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        return parsed.protocol === 'https:' && (
            host === 'coverartarchive.org'
            || host.endsWith('.coverartarchive.org')
            || host === 'archive.org'
            || host.endsWith('.archive.org')
            || host === 'mzstatic.com'
            || host.endsWith('.mzstatic.com')
            || host === 'ytimg.com'
            || host.endsWith('.ytimg.com')
        );
    } catch {
        return false;
    }
}

async function fetchArtworkBytes(coverUrl) {
    if (!isAllowedArtworkUrl(coverUrl)) return null;
    try {
        const response = await fetch(coverUrl, { signal: AbortSignal.timeout(8000) });
        if (!response.ok || !isAllowedArtworkUrl(response.url || coverUrl)) return null;
        const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!ARTWORK_MIME_EXTENSIONS.has(contentType)) return null;
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > 5 * 1024 * 1024) return null;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 5 * 1024 * 1024) return null;
        const validSignature = contentType === 'image/jpeg' ? bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
            : contentType === 'image/png' ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
                : contentType === 'image/webp' ? bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
                    : bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
        if (!validSignature) return null;
        return { bytes, extension: ARTWORK_MIME_EXTENSIONS.get(contentType), contentType };
    } catch {
        return null;
    }
}

// Helper to fetch legitimate album covers (MusicBrainz -> Cover Art Archive -> iTunes)
async function fetchLegitimateCover(artist, title) {
    if (!artist || !title) return null;
    
    // 1. Try MusicBrainz + Cover Art Archive
    try {
        const query = encodeURIComponent(`recording:"${title}" AND artist:"${artist}"`);
        const mbRes = await fetch(`https://musicbrainz.org/ws/2/recording/?query=${query}&fmt=json&limit=1`, {
            headers: { 'User-Agent': 'AuraAudio/1.2.0 (https://github.com/auraplayer)' },
            signal: AbortSignal.timeout(4000) 
        });
        if (mbRes.ok) {
            const mbData = await mbRes.json();
            const recording = mbData.recordings?.[0];
            const releaseId = recording?.releases?.[0]?.id;
            if (releaseId) {
                const coverRes = await fetch(`https://coverartarchive.org/release/${releaseId}/front-500`, {
                    method: 'HEAD',
                    redirect: 'manual'
                });
                if (coverRes.status === 307) {
                    return coverRes.headers.get('location');
                }
            }
        }
    } catch (e) { /* Ignore timeout */ }

    // 2. Fallback: iTunes Search API
    try {
        const itunesRes = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(artist + ' ' + title)}&entity=song&limit=1`, {
            signal: AbortSignal.timeout(4000)
        });
        if (itunesRes.ok) {
            const itunesData = await itunesRes.json();
            const artworkUrl = itunesData.results?.[0]?.artworkUrl100;
            if (artworkUrl) {
                return artworkUrl.replace('100x100bb.jpg', '600x600bb.jpg');
            }
        }
    } catch (e) { /* Ignore */ }

    return null;
}

// Forced iTunes fallback: tries artist+title, then title alone (useful when the artist is unknown)
async function forceFetchFallbackCover(artist, title) {
    if (!title) return null;
    const clean = t => t.replace(/\(.*?\)|\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
    const unknownArtist = !artist || artist === 'YouTube Audio';
    const terms = unknownArtist ? [clean(title)] : [clean(`${artist} ${title}`), clean(title)];
    for (const term of terms) {
        if (!term) continue;
        try {
            const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`, { signal: AbortSignal.timeout(4000) });
            if (res.ok) {
                const data = await res.json();
                const url = data.results?.[0]?.artworkUrl100;
                if (url) return url.replace('100x100bb.jpg', '600x600bb.jpg');
            }
        } catch { /* try next term */ }
    }
    return null;
}

class YouTubeService {
    constructor(downloadsDir = './downloads') {
        this.downloadsDir = path.resolve(downloadsDir);
        this.activeDownloads = new Map();
        this.processes = new Map();
        this.ytDlpDownloadOptions = null;
        
        this.queue = [];
        this.activeProcesses = 0;
        this.maxConcurrent = 1; 
        this.proxy = process.env.YTB_PROXY_URL || null; 

        const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        const localCandidates = [
            process.resourcesPath && path.join(process.resourcesPath, 'tools', binaryName),
            path.resolve(__dirname, '..', 'tools', binaryName),
            process.resourcesPath && path.join(process.resourcesPath, 'app.asar.unpacked', 'tools', binaryName)
        ].filter(Boolean);
        
        this.ytDlpExecutable = localCandidates.find(candidate => fs.existsSync(candidate)) || 'yt-dlp';
        this.ensureDir();
    }

    getDownloadOptions() {
        if (this.ytDlpDownloadOptions) return this.ytDlpDownloadOptions;
        let help;
        let version = 'unknown';
        try {
            version = execFileSync(this.ytDlpExecutable, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
            help = execFileSync(this.ytDlpExecutable, ['--help'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
        } catch (error) {
            throw new Error(`Could not inspect yt-dlp (${error.message}). Run npm run setup:ytdlp.`);
        }
        if (!help.includes('--js-runtimes')) {
            throw new Error(`yt-dlp ${version} is too old. Run npm run setup:ytdlp.`);
        }
        const options = ['--js-runtimes', 'node'];
        if (help.includes('--remote-components')) options.push('--remote-components', 'ejs:github');
        this.ytDlpDownloadOptions = options;
        return options;
    }

    ensureDir() {
        if (!fs.existsSync(this.downloadsDir)) fs.mkdirSync(this.downloadsDir, { recursive: true });
    }

    async cacheCover(coverUrl, fileName) {
        const image = await fetchArtworkBytes(coverUrl);
        if (!image) return null;
        const coverFile = `cover-${crypto.createHash('sha256').update(fileName).digest('hex').slice(0, 24)}.${image.extension}`;
        try {
            fs.writeFileSync(path.join(this.downloadsDir, coverFile), image.bytes);
            return { coverFile, coverUrl: `/api/covers/${encodeURIComponent(coverFile)}`, contentType: image.contentType };
        } catch {
            return null;
        }
    }

    async resolveAndCacheCover(artist, title, fileName, sourceArtwork = '') {
        let coverUrl = await fetchLegitimateCover(artist, title);
        if (!coverUrl) coverUrl = await forceFetchFallbackCover(artist, title);
        if (!coverUrl && sourceArtwork) coverUrl = sourceArtwork;
        return coverUrl ? this.cacheCover(coverUrl, fileName) : null;
    }

    async processQueue() {
        if (this.activeProcesses >= this.maxConcurrent || this.queue.length === 0) return;
        this.activeProcesses++;
        const { task, resolve, reject } = this.queue.shift();
        try { resolve(await task()); } catch (err) { reject(err); } finally {
            this.activeProcesses--;
            this.processQueue();
        }
    }

    search(query, maxResults = 6) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                task: () => new Promise((res, rej) => {
                    const args = [`ytsearch${maxResults}:${query}`, '--dump-json', '--flat-playlist', '--no-warnings', '--ignore-errors'];
                    if (this.proxy) args.push('--proxy', this.proxy);

                    execFile(this.ytDlpExecutable, args, { maxBuffer: 1024 * 1024 * 10, timeout: 10000 }, (err, stdout, stderr) => {
                        if (err || !stdout.trim()) return res([]);
                        try {
                            const results = stdout.trim().split('\n').filter(Boolean).map(line => {
                                const data = JSON.parse(line);
                                let cleanTitle = data.title || 'Unknown';
                                cleanTitle = cleanTitle.replace(/\((?:official\s+)?(?:music\s+)?video\)|\[(?:official\s+)?(?:music\s+)?video\]|\(clip officiel\)|\(audio\)|\(lyrics?\)/gi, '').trim();
                                return {
                                    id: data.id, title: cleanTitle,
                                    uploader: data.uploader || data.channel || 'Unknown Creator',
                                    duration: this.formatSeconds(data.duration || 0),
                                    url: `https://www.youtube.com/watch?v=${data.id}`,
                                    thumbnail: data.thumbnail || `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`
                                };
                            }).filter(Boolean);
                            res(results);
                        } catch { res([]); }
                    });
                }), resolve, reject
            });
            this.processQueue();
        });
    }

    downloadAudio(targetUrl, customTitle = null, onStarted = null) {
        // Allocate the job before it enters the serialized yt-dlp queue. Callers
        // need a stable progress id even while another download is active.
        const downloadId = 'dl_' + crypto.randomBytes(8).toString('hex');
        this.activeDownloads.set(downloadId, { id: downloadId, status: 'queued', progress: 0, targetUrl, title: customTitle || 'Downloading…', stage: 'Queued' });
        if (onStarted) onStarted(downloadId);
        return new Promise((resolve, reject) => {
            this.queue.push({
                task: () => new Promise((res, rej) => {
                    this.ensureDir();
                    const job = this.activeDownloads.get(downloadId);
                    if (job) { job.status = 'downloading'; job.stage = 'Starting'; }
                    const outputTemplate = path.join(this.downloadsDir, `%(title)s [${downloadId}].%(ext)s`);
                    const isSearch = !/^https?:\/\//i.test(targetUrl);
                    const downloadTarget = isSearch ? `ytsearch3:${targetUrl}` : targetUrl;
                    
                    const args = [
                        downloadTarget, '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
                        ...(isSearch ? ['--playlist-end', '3', '--match-filter', 'availability = public', '--max-downloads', '1'] : ['--no-playlist']),
                        '--no-warnings', '--ignore-config', '--newline', '--progress', '--add-metadata', '-o', outputTemplate
                    ];
                    if (this.proxy) args.push('--proxy', this.proxy);

                    let process;
                    try {
                        args.unshift(...this.getDownloadOptions());
                        process = spawn(this.ytDlpExecutable, args);
                        this.processes.set(downloadId, process);
                    } catch (error) {
                        this.activeDownloads.get(downloadId).status = 'failed';
                        return rej(error);
                    }

                    let outputBuffer = '', downloadedFilePath = null, videoThumbnail = null, videoId = null;
                    const consumeOutput = (data, isError = false) => {
                        outputBuffer += data.toString();
                        const lines = outputBuffer.split(/\r?\n|\r/);
                        outputBuffer = lines.pop() || '';
                        for (const line of lines) {
                            const text = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
                            const match = text.match(/\[download\]\s+([\d.]+)%/);
                            const current = this.activeDownloads.get(downloadId);
                            if (match && current) { current.progress = parseFloat(match[1]); current.stage = 'Downloading'; }
                            
                            const thumbMatch = text.match(/\[info\] Writing video thumbnail.*?:\s*(.+)$/i);
                            if (thumbMatch) videoThumbnail = thumbMatch[1].trim();
                            
                            const idMatch = text.match(/^\[youtube\]\s+([a-zA-Z0-9_-]{11}):/);
                            if (idMatch && !videoId) videoId = idMatch[1];

                            const destMatch = text.match(/Destination:\s+(.+)$/i);
                            if (destMatch) downloadedFilePath = destMatch[1].trim().replace(/^['"]|['"]$/g, '');
                        }
                    };
                    process.stdout.on('data', d => consumeOutput(d));
                    process.stderr.on('data', d => consumeOutput(d, true));

                    process.on('close', async (code) => {
                        this.processes.delete(downloadId);
                        
                        if (!downloadedFilePath || !fs.existsSync(downloadedFilePath)) {
                            const files = fs.readdirSync(this.downloadsDir).filter(f => f.includes(`[${downloadId}]`));
                            if (files.length > 0) downloadedFilePath = path.join(this.downloadsDir, files[0]);
                        }

                        if ((code === 0 || (code === 101 && isSearch)) && downloadedFilePath && fs.existsSync(downloadedFilePath)) {
                            const stats = fs.statSync(downloadedFilePath);
                            const fileName = path.basename(downloadedFilePath);
                            let parsedName = path.parse(fileName).name.replace(` [${downloadId}]`, '');
                            
                            parsedName = parsedName.replace(/\((?:official\s+)?(?:music\s+)?video\)|\[(?:official\s+)?(?:music\s+)?video\]|\(clip officiel\)|\(audio\)|\(lyrics?\)/gi, '').trim();

                            let artist = 'YouTube Audio', title = parsedName;
                            if (parsedName.includes(' - ')) {
                                const split = parsedName.split(' - ');
                                artist = split[0].trim();
                                title = split.slice(1).join(' - ').trim();
                            }

                            const urlId = (targetUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/) || [])[1];
                            const id = videoId || urlId;
                            const sourceArtwork = isAllowedArtworkUrl(videoThumbnail) ? videoThumbnail
                                : (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '');
                            const cachedCover = await this.resolveAndCacheCover(artist, title, fileName, sourceArtwork);

                            const result = { 
                                id: downloadId, 
                                title: title || customTitle || 'Downloaded Audio', 
                                artist, 
                                filePath: downloadedFilePath, 
                                fileName, 
                                fileSize: stats.size,
                                coverFile: cachedCover?.coverFile || '',
                                cover: cachedCover?.coverUrl || ''
                            };
                            
                            this.activeDownloads.set(downloadId, { id: downloadId, status: 'completed', progress: 100, stage: 'Complete', result });
                            return res(result);
                        }

                        const current = this.activeDownloads.get(downloadId);
                        if (current) { current.status = 'failed'; current.stage = 'Failed'; }
                        rej(new Error(`Download failed (code ${code}). File not found.`));
                    });

                    process.on('error', (err) => {
                        this.processes.delete(downloadId);
                        this.activeDownloads.get(downloadId).status = 'failed';
                        rej(err);
                    });
                }), resolve, reject
            });
            this.processQueue();
        });
    }

    killDownload(downloadId) {
        const proc = this.processes.get(downloadId);
        if (proc) {
            try { proc.kill('SIGKILL'); } catch(e) {}
            this.processes.delete(downloadId);
            const current = this.activeDownloads.get(downloadId);
            if (current) { current.status = 'failed'; current.stage = 'Killed'; }
            return true;
        }
        return false;
    }

    getDownloadProgress(downloadId) { return this.activeDownloads.get(downloadId) || null; }
    
    formatSeconds(sec) { 
        if (!sec || isNaN(sec)) return '--:--'; 
        return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`; 
    }
}

module.exports = YouTubeService;
module.exports.isAllowedArtworkUrl = isAllowedArtworkUrl;
module.exports.fetchArtworkBytes = fetchArtworkBytes;
