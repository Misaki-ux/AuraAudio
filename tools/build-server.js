const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'standalone-server');
const autonomousClientSource = path.join(root, 'autonomous-client');
const autonomousClientOutput = path.join(outputDir, 'autonomousclientmobile');

// Pass --no-mobile to skip mobile build (used when called from Electron build chain
// where mobile:compile already ran separately). Default: build mobile first.
const skipMobile = process.argv.includes('--no-mobile');
if (!skipMobile) {
    const mobileBuild = spawnSync(process.execPath, [path.join(__dirname, 'build-mobile.js')], { stdio: 'inherit' });
    if (mobileBuild.status !== 0) process.exit(mobileBuild.status || 1);
}

fs.mkdirSync(outputDir, { recursive: true });
const sourceDb = path.join(root, 'server', 'data', 'db.json');
fs.cpSync(path.join(root, 'server'), path.join(outputDir, 'server'), {
    recursive: true,
    filter: (sourcePath, destinationPath) => path.resolve(sourcePath) !== sourceDb
        && !(path.basename(sourcePath) === 'config.json' && fs.existsSync(destinationPath))
});
const distConfigPath = path.join(outputDir, 'server', 'config.json');
const distConfig = JSON.parse(fs.readFileSync(distConfigPath, 'utf8'));
if (!distConfig.server.jwtSecret || distConfig.server.jwtSecret === 'aura_audio_jwt_super_secret_key_2026_dev') {
    distConfig.server.jwtSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(distConfigPath, JSON.stringify(distConfig, null, 2));
}
fs.cpSync(path.join(root, 'mobile-dist'), path.join(outputDir, 'mobile-dist'), { recursive: true });
fs.cpSync(path.join(root, 'assets'), path.join(outputDir, 'assets'), { recursive: true });
const autonomousClientDir = path.join(outputDir, 'autonomousclientmobile');
fs.mkdirSync(autonomousClientDir, { recursive: true });
fs.cpSync(path.join(root, 'assets'), path.join(autonomousClientDir, 'assets'), { recursive: true });
fs.cpSync(autonomousClientSource, autonomousClientOutput, { recursive: true });

const toolsDir = path.join(outputDir, 'tools');
fs.mkdirSync(toolsDir, { recursive: true });
for (const file of ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe', 'install-ytdlp.ps1']) {
    const source = path.join(root, 'tools', file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(toolsDir, file));
}
fs.copyFileSync(
    path.join(__dirname, 'standalone-templates', 'generate-autonomous-pairing-qr.js'),
    path.join(toolsDir, 'generate-autonomous-pairing-qr.js')
);
fs.cpSync(
    path.resolve(path.dirname(require.resolve('qrcode-generator')), '..'),
    path.join(outputDir, 'node_modules', 'qrcode-generator'),
    { recursive: true }
);

fs.writeFileSync(path.join(outputDir, 'start-server.ps1'), [
    "$ErrorActionPreference = 'Stop'",
    "if (-not $env:AURA_HOST) { $env:AURA_HOST = '0.0.0.0' }",
    'Set-Location $PSScriptRoot',
    'node .\\server\\index.js',
    ''
].join('\r\n'));

const standaloneTemplatesDir = path.join(__dirname, 'standalone-templates');
for (const file of ['Caddyfile', 'DUCKDNS-SETUP.md', 'duckdns.config.example.json', 'start-duckdns-server.ps1', 'start-autonomous-client.ps1', 'update-duckdns.ps1']) {
    fs.copyFileSync(path.join(standaloneTemplatesDir, file), path.join(outputDir, file));
}

fs.writeFileSync(path.join(outputDir, 'README.txt'), [
    'AuraAudio Standalone Server',
    '',
    'Requires Node.js 18 or newer. On Windows, run start-server.ps1 from PowerShell.',
    'The server API and mobile app are available at http://localhost:3456 and /mobile/.',
    'The offline-friendly client is available at /autonomousclientmobile/.',
    'By default the server listens on all network interfaces for phone access.',
    'Persistent data is stored in server/data/db.json and downloads/ beside this file.',
    'yt-dlp is bundled on Windows when available. FFmpeg must be installed on PATH.',
    'Set AURA_HOST or AURA_PORT before launch to override the bind address or port.',
    'For direct external HTTPS, copy duckdns.config.example.json to duckdns.config.json and enter your DuckDNS subdomain and token. The launcher prefers caddy-duckdns.exe and defaults to external TCP 32768 forwarded to local TCP 443. Run start-duckdns-server.ps1; use -HttpsPort to select a different external port. The API binds to loopback and requires a temporary access key.',
    'DuckDNS updates DNS only. Caddy uses the DuckDNS DNS challenge and handles HTTPS on this PC; no inbound ports 80/443 are needed for certificate validation. Do not expose the AuraAudio API port. A public IPv4 address is required for router port forwarding; CGNAT may prevent it.',
    'See DUCKDNS-SETUP.md for setup steps and for adding AuraAudio to an existing Caddy proxy.',
    'The autonomous Android app runs without this PC server and stores library data in app-private SQLite and audio in app-private files. Its online discovery, search, lyrics, and YouTube downloads still require an optional AuraAudio server.',
    'Optionally transfer likes, artists, play history, playlists, and download metadata between the autonomous app and desktop using the one-use QR in desktop Settings. Audio files are never sent. The browser autonomous client can still pair with this server or use start-autonomous-client.ps1 for protected external HTTPS and a QR code.'
].join('\r\n'));

console.log(`Standalone server distribution written to ${outputDir}`);
