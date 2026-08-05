/**
 * Runs as `postinstall` — downloads the yt-dlp Linux standalone binary.
 * Idempotent: skips download if the binary already exists and is executable.
 */
const https = require('https');
const fs   = require('fs');
const path = require('path');

const binDir  = path.join(__dirname, '..', 'bin');
const isWindows = process.platform === 'win32';
const binPath = path.join(binDir, isWindows ? 'yt-dlp.exe' : 'yt-dlp');
const DL_URL  = isWindows 
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

if (fs.existsSync(binPath)) {
    console.log('[setup-yt-dlp] yt-dlp already present, skipping download.');
    process.exit(0);
}

console.log(`[setup-yt-dlp] Downloading yt-dlp ${isWindows ? 'Windows' : 'Linux'} binary…`);

function download(url, dest, redirects) {
    if (redirects > 5) { console.error('Too many redirects'); process.exit(1); }
    https.get(url, { headers: { 'User-Agent': 'node-setup-script' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return download(res.headers.location, dest, redirects + 1);
        }
        if (res.statusCode !== 200) {
            console.error(`[setup-yt-dlp] HTTP ${res.statusCode}`);
            process.exit(1);
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => {
            fs.chmodSync(dest, 0o755);
            console.log('[setup-yt-dlp] yt-dlp downloaded and marked executable.');
        });
        out.on('error', (e) => { console.error(e.message); process.exit(1); });
    }).on('error', (e) => { console.error(e.message); process.exit(1); });
}

download(DL_URL, binPath, 0);
