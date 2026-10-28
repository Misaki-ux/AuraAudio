// =========================================================================
// AuraAudio Embedded Server Daemon (server/index.js)
// High-Performance Native Node HTTP Server with Auto-Port Fallback & Graceful Shutdown
// =========================================================================

const http = require('http');
const path = require('path');
const fs = require('fs');

const Database = require('./db');
const AuthService = require('./auth');
const EmailService = require('./email');
const DiscoveryService = require('./discovery');
const MusicMetadataService = require('./music-metadata');
const YouTubeService = require('./youtube');
const ApiRouter = require('./routes');

// Load Configuration
function loadConfig() {
    const configPath = path.join(__dirname, 'config.json');
    try {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (e) {
        console.warn('[Server] Error reading config.json, using defaults:', e.message);
    }
    return {
        server: { port: 3456, host: '127.0.0.1', jwtSecret: 'aura_jwt_secret_dev' },
        storage: { downloadsDir: './downloads', databaseFile: './server/data/db.json' },
        oauth: {}
    };
}

class AuraServer {
    constructor(options = {}) {
        this.config = loadConfig();
        const baseDir = path.resolve(__dirname, '..');
        const storageRoot = options.storageRoot ? path.resolve(options.storageRoot) : null;
        const dbPath = storageRoot
            ? path.join(storageRoot, 'server', 'data', 'db.json')
            : path.resolve(baseDir, this.config.storage.databaseFile);
        const dlDir = storageRoot
            ? path.join(storageRoot, 'downloads')
            : path.resolve(baseDir, this.config.storage.downloadsDir);

        this.downloadsDir = dlDir;
        this.db = new Database(dbPath);
        this.emailService = new EmailService();
        this.authService = new AuthService(this.config, this.db, this.emailService);
        this.musicMetadata = new MusicMetadataService();
        this.discoveryService = new DiscoveryService(this.musicMetadata);
        this.youtubeService = new YouTubeService(dlDir);
        this.router = new ApiRouter(this.db, this.authService, this.discoveryService, this.youtubeService, dlDir, this.musicMetadata);
        
        this.server = null;
        this.activePort = Number(process.env.AURA_PORT) || this.config.server.port || 3456;
        this.host = process.env.AURA_HOST || this.config.server.host || '127.0.0.1';
    }

    start(requestedPort = null) {
        return new Promise((resolve, reject) => {
            const port = requestedPort || this.activePort;
            this.server = http.createServer((req, res) => {
                this.router.handle(req, res).catch(err => {
                    console.error('[Router Error]', err);
                    if (res.headersSent) return res.destroy(err);
                    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: true, message: 'Internal Server Error' }));
                });
            });

            this.server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.warn(`[Server] Port ${port} is in use, attempting ${port + 1}...`);
                    this.server.close();
                    this.start(port + 1).then(resolve).catch(reject);
                } else {
                    reject(err);
                }
            });

            this.server.listen(port, this.host, () => {
                this.activePort = port;
                const clientHost = this.host === '0.0.0.0' ? '127.0.0.1' : this.host;
                console.log(`[AuraAudio Server] Running online at http://${this.host}:${this.activePort}`);
                console.log(`[AuraAudio Server] API Status: http://${this.host}:${this.activePort}/api/status`);
                console.log(`[AuraAudio Server] OAuth Config: http://${this.host}:${this.activePort}/api/auth/config`);
                console.log(`[AuraAudio Server] Discovery: http://${this.host}:${this.activePort}/api/discovery/artists`);
                resolve({
                    port: this.activePort,
                    host: this.host,
                    url: `http://${clientHost}:${this.activePort}`
                });
            });
        });
    }

    stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    console.log('[AuraAudio Server] Stopped.');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}

// Support direct CLI execution: node server/index.js
if (require.main === module) {
    const s = new AuraServer();
    s.start().catch(err => {
        console.error('[Server Start Error]:', err);
        process.exit(1);
    });
}

module.exports = AuraServer;
