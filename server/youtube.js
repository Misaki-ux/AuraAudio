// =========================================================================
// AuraAudio YouTube Downloader & Streamer Engine (server/youtube.js)
// Local Audio Downloader via yt-dlp & FFmpeg with Real-time Progress Tracking
// =========================================================================

const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class YouTubeService {
    constructor(downloadsDir = './downloads') {
        this.downloadsDir = path.resolve(downloadsDir);
        this.activeDownloads = new Map();
        this.ytDlpDownloadOptions = null;
        const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        const localCandidates = [
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
            throw new Error(`Could not inspect yt-dlp (${error.message}). Run npm run setup:ytdlp or install yt-dlp on PATH.`);
        }
        if (!help.includes('--js-runtimes')) {
            throw new Error(`yt-dlp ${version} is too old for current YouTube format extraction. Run npm run setup:ytdlp and restart AuraAudio.`);
        }
        const options = ['--js-runtimes', 'node'];
        if (help.includes('--remote-components')) options.push('--remote-components', 'ejs:github');
        this.ytDlpDownloadOptions = options;
        return options;
    }

    ensureDir() {
        if (!fs.existsSync(this.downloadsDir)) {
            fs.mkdirSync(this.downloadsDir, { recursive: true });
        }
    }

    cleanFilename(name) {
        return (name || 'track').replace(/[\\/*?:"<>|]/g, '').trim();
    }

    // --- Search YouTube via yt-dlp ---
    search(query, maxResults = 6) {
        return new Promise((resolve) => {
            const args = [
                `ytsearch${maxResults}:${query}`,
                '--dump-json',
                '--flat-playlist',
                '--no-warnings',
                '--ignore-errors'
            ];

            execFile(this.ytDlpExecutable, args, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
                if (err || !stdout.trim()) {
                    console.warn('[YouTubeService] yt-dlp search failed or returned no results:', (stderr || '').trim() || (err ? err.message : 'empty result'));
                    return resolve(this.getFallbackSearchResults(query));
                }

                try {
                    const lines = stdout.trim().split('\n').filter(Boolean);
                    const results = lines.map(line => {
                        try {
                            const data = JSON.parse(line);
                            return {
                                id: data.id,
                                title: data.title,
                                uploader: data.uploader || data.channel || 'Unknown Creator',
                                duration: this.formatSeconds(data.duration || 0),
                                durationSeconds: data.duration || 0,
                                url: `https://www.youtube.com/watch?v=${data.id}`,
                                thumbnail: data.thumbnail || (data.thumbnails && data.thumbnails[0] ? data.thumbnails[0].url : `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`)
                            };
                        } catch {
                            return null;
                        }
                    }).filter(Boolean);

                    resolve(results);
                } catch {
                    resolve(this.getFallbackSearchResults(query));
                }
            });
        });
    }

    // --- Get Single Video Metadata ---
    getVideoInfo(targetUrl) {
        return new Promise((resolve, reject) => {
            const args = [
                targetUrl,
                '--dump-json',
                '--no-playlist',
                '--no-warnings'
            ];

            execFile(this.ytDlpExecutable, args, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
                if (err || !stdout.trim()) {
                    return reject(new Error('Failed to retrieve video details: ' + (err ? err.message : 'No output')));
                }

                try {
                    const data = JSON.parse(stdout);
                    resolve({
                        id: data.id,
                        title: data.title,
                        uploader: data.uploader || data.channel || 'Unknown Artist',
                        duration: this.formatSeconds(data.duration || 0),
                        durationSeconds: data.duration || 0,
                        url: targetUrl,
                        thumbnail: data.thumbnail,
                        description: (data.description || '').slice(0, 300)
                    });
                } catch (parseErr) {
                    reject(parseErr);
                }
            });
        });
    }

    getPlaylistInfo(targetUrl) {
        return new Promise((resolve, reject) => {
            const args = [
                targetUrl, '--dump-single-json', '--flat-playlist', '--no-warnings',
                '--ignore-errors', '--playlist-end', '200'
            ];
            execFile(this.ytDlpExecutable, args, { maxBuffer: 8 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
                if (err || !stdout.trim()) return reject(new Error(`Could not read this SoundCloud playlist: ${(stderr || err?.message || 'empty result').trim().slice(-500)}`));
                try {
                    const data = JSON.parse(stdout);
                    const tracks = (data.entries || []).filter(entry => entry && (entry.title || entry.id)).map(entry => {
                        const sourceUrl = entry.webpage_url || entry.original_url || (String(entry.url || '').startsWith('http') ? entry.url : '');
                        return {
                            id: `soundcloud:${entry.id || encodeURIComponent(sourceUrl)}`,
                            title: entry.title || 'Untitled', artist: entry.uploader || entry.channel || data.uploader || 'SoundCloud',
                            duration: Number(entry.duration) || 0, source: 'soundcloud', sourceUrl,
                            downloadable: entry.is_downloadable === true
                        };
                    });
                    resolve({ name: data.title || 'SoundCloud playlist', tracks });
                } catch (parseError) { reject(new Error(`Could not parse SoundCloud playlist information: ${parseError.message}`)); }
            });
        });
    }

    // --- Download Audio Locally (.mp3) ---
    downloadAudio(targetUrl, customTitle = null, onStarted = null) {
        return new Promise((resolve, reject) => {
            this.ensureDir();
            const downloadId = 'dl_' + crypto.randomBytes(8).toString('hex');

            const outputTemplate = path.join(this.downloadsDir, `%(title)s [${downloadId}].%(ext)s`);
            const isSearch = !/^https?:\/\//i.test(targetUrl);
            const downloadTarget = isSearch ? `ytsearch3:${targetUrl}` : targetUrl;
            const args = [
                downloadTarget,
                '-f', 'bestaudio/best',
                '-x',
                '--audio-format', 'mp3',
                '--audio-quality', '0',
                ...(isSearch
                    ? ['--playlist-end', '3', '--match-filter', 'availability = public', '--max-downloads', '1']
                    : ['--no-playlist']),
                '--no-warnings',
                '--ignore-config',
                '--newline',
                '--progress',
                '--add-metadata',
                '-o', outputTemplate
            ];

            let downloadedFilePath = null;
            let percentProgress = 0;
            let finalTitle = customTitle || '';

            this.activeDownloads.set(downloadId, {
                id: downloadId,
                status: 'downloading',
                progress: 0,
                targetUrl,
                title: customTitle || 'Downloading audio…',
                downloadsDir: this.downloadsDir,
                stage: 'Starting yt-dlp'
            });

            if (onStarted) onStarted(downloadId);

            let process;
            try {
                args.unshift(...this.getDownloadOptions());
                process = spawn(this.ytDlpExecutable, args);
            } catch (error) {
                const current = this.activeDownloads.get(downloadId);
                if (current) {
                    current.status = 'failed';
                    current.stage = 'yt-dlp setup required';
                    current.error = error.message;
                }
                return reject(error);
            }

            let outputBuffer = '';
            const consumeOutput = (data, isError = false) => {
                outputBuffer += data.toString();
                const lines = outputBuffer.split(/\r?\n|\r/);
                outputBuffer = lines.pop() || '';
                for (const line of lines) {
                    const text = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
                    if (!text) continue;
                    if (isError) console.warn('[yt-dlp]:', text);
                    const match = text.match(/\[download\]\s+([\d.]+)%/);
                    const current = this.activeDownloads.get(downloadId);
                    if (isError && current && /error|unable|failed/i.test(text)) current.error = text;
                    if (match && current) {
                        percentProgress = parseFloat(match[1]);
                        current.progress = percentProgress;
                        current.stage = 'Downloading audio';
                    } else if (/\[ExtractAudio\]|\[ffmpeg\]/i.test(text) && current) {
                        current.stage = 'Converting to MP3';
                        current.progress = Math.max(current.progress || 0, 99);
                    }
                    const destMatch = text.match(/Destination:\s+(.+)$/i);
                    if (destMatch) downloadedFilePath = destMatch[1].trim().replace(/^['"]|['"]$/g, '');
                    if (/^\[download\] Destination:/i.test(text) && current) current.stage = 'Downloading audio';
                }
            };
            process.stdout.on('data', data => consumeOutput(data));
            process.stderr.on('data', data => consumeOutput(data, true));

            process.on('close', (code) => {
                if (outputBuffer.trim()) consumeOutput(Buffer.from('\n'));
                // yt-dlp returns 101 after --max-downloads is reached, even when
                // the one requested candidate was downloaded successfully.
                if (code === 0 || (code === 101 && isSearch)) {
                    // Locate the file if not captured in output
                    if (!downloadedFilePath || !fs.existsSync(downloadedFilePath)) {
                        const files = fs.readdirSync(this.downloadsDir);
                        // Find newest mp3
                        let newest = null;
                        let newestTime = 0;
                        files.forEach(f => {
                            if (f.includes(`[${downloadId}]`)) {
                                const full = path.join(this.downloadsDir, f);
                                const stat = fs.statSync(full);
                                if (stat.mtimeMs > newestTime) {
                                    newestTime = stat.mtimeMs;
                                    newest = full;
                                }
                            }
                        });
                        downloadedFilePath = newest;
                    }

                    if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
                        const stats = fs.statSync(downloadedFilePath);
                        const fileName = path.basename(downloadedFilePath);
                        const parsedName = path.parse(fileName).name.replace(` [${downloadId}]`, '');

                        // Parse artist and title from filename (e.g., "Artist - Title")
                        let artist = 'YouTube Audio';
                        let title = parsedName;
                        if (parsedName.includes(' - ')) {
                            const split = parsedName.split(' - ');
                            artist = split[0].trim();
                            title = split.slice(1).join(' - ').trim();
                        }

                        const result = {
                            id: downloadId,
                            title: title || finalTitle || 'Downloaded Audio',
                            artist,
                            filePath: downloadedFilePath,
                            fileName,
                            fileSize: stats.size,
                            fileSizeFormatted: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
                            downloadedAt: new Date().toISOString()
                        };

                        this.activeDownloads.set(downloadId, {
                            id: downloadId,
                            status: 'completed',
                            progress: 100,
                            stage: 'Complete',
                            downloadsDir: this.downloadsDir,
                            result
                        });

                        return resolve(result);
                    }
                }

                const current = this.activeDownloads.get(downloadId);
                if (current) {
                    current.status = 'failed';
                    current.stage = 'Download failed';
                    current.error = current.error || `yt-dlp exited with code ${code}`;
                }
                reject(new Error(`Download process exited with code ${code}${outputBuffer.trim() ? `: ${outputBuffer.trim()}` : ''}`));
            });

            process.on('error', (err) => {
                const current = this.activeDownloads.get(downloadId);
                if (current) {
                    current.status = 'failed';
                    current.stage = 'Download failed';
                    current.error = err.message;
                }
                reject(err);
            });
        });
    }

    getDownloadProgress(downloadId) {
        return this.activeDownloads.get(downloadId) || null;
    }

    formatSeconds(sec) {
        if (!sec || isNaN(sec)) return '--:--';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    getFallbackSearchResults(query) {
        return [];
    }
}

module.exports = YouTubeService;
