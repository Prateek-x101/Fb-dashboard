const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const accountRoutes = require('./routes/accounts');
const campaignRoutes = require('./routes/campaigns');
const settingRoutes = require('./routes/settings');
const shopifyRoutes = require('./routes/shopify');
const commentsRoutes = require('./routes/comments');
const publishRoutes = require('./routes/publish');

const app = express();
const port = process.env.PORT || 5000;

app.set('trust proxy', true);

// Setup multer for file uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/accounts', accountRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/settings', settingRoutes);
app.use('/api/shopify', shopifyRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/publish', publishRoutes);

// Media upload endpoint
app.post('/api/media/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        res.json({ filePath: req.file.path, filename: req.file.filename });
    } catch (error) {
        res.status(500).json({ error: 'Upload failed', details: error.message });
    }
});

// Route to download video from URL and clean/process it using FFmpeg
app.post('/api/media/download-url', async (req, res) => {
    try {
        const { url, canvasType } = req.body; // canvasType is '9:16', '1:1', or 'original'
        if (!url) {
            return res.status(400).json({ error: 'Missing target URL' });
        }

        const videoProcessor = require('./services/videoProcessor');
        const outputFilename = `downloaded-${Date.now()}.mp4`;

        console.log(`Received download request for url: ${url}, canvasType: ${canvasType || 'original'}`);

        // Resolve a Facebook access token from stored accounts (needed for Ads Library URLs)
        let fbAccessToken = null;
        try {
            const { getStorage } = require('./services/storage');
            const stored = getStorage();
            const accs = stored.accounts || [];
            if (accs.length > 0) fbAccessToken = accs[0].accessToken || null;
        } catch (err) {
            console.error('Failed to resolve token from storage service:', err.message);
        }

        // 1. Download video (passes token only used for FB Ads Library)
        const tempPath = await videoProcessor.downloadVideo(url, outputFilename, fbAccessToken);

        // 2. Reprocess video (scale, pad, strip, re-encode)
        const result = await videoProcessor.processVideo(tempPath, outputFilename, canvasType || 'original');
        
        res.json({
            success: true,
            filePath: result.filePath,
            filename: result.filename
        });
    } catch (error) {
        console.error("Failed to download and process video url:", error.message);
        res.status(500).json({ error: 'Video download or processing failed', details: error.message });
    }
});

// Diagnostic route to test yt-dlp version and execution directly on the environment
app.get('/api/media/debug-ytdlp', async (req, res) => {
    try {
        const { execFile } = require('child_process');
        const path = require('path');
        const fs = require('fs');
        const binDir = path.join(__dirname, 'bin');
        const isWindows = process.platform === 'win32';
        const ytdlp = path.join(binDir, isWindows ? 'yt-dlp.exe' : 'yt-dlp');
        
        if (!fs.existsSync(ytdlp)) {
            return res.json({ error: 'yt-dlp binary not found', path: ytdlp });
        }
        
        const runTest = (args) => {
            return new Promise((resolve) => {
                execFile(ytdlp, args, { timeout: 10000 }, (error, stdout, stderr) => {
                    resolve({ args, error: error ? error.message : null, stdout: stdout.trim(), stderr: stderr.trim() });
                });
            });
        };

        const directResult = await runTest(['--version']);
        let py3Result = null;
        if (directResult.error && !isWindows) {
            py3Result = await new Promise((resolve) => {
                execFile('python3', [ytdlp, '--version'], { timeout: 10000 }, (error, stdout, stderr) => {
                    resolve({ error: error ? error.message : null, stdout: stdout.trim(), stderr: stderr.trim() });
                });
            });
        }

        res.json({
            exists: true,
            path: ytdlp,
            platform: process.platform,
            arch: process.arch,
            direct: directResult,
            python3Fallback: py3Result
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Diagnostic route to check what Facebook returns to Render for public Ad Library links
app.get('/api/media/debug-fb', async (req, res) => {
    try {
        const adId = req.query.id || '1574129074339531';
        const url = `https://www.facebook.com/ads/library/?id=${adId}`;
        const fetch = require('node-fetch');
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        const html = await response.text();
        res.json({
            status: response.status,
            statusText: response.statusText,
            url: response.url,
            headers: Object.fromEntries(response.headers.entries()),
            htmlLength: html.length,
            htmlSnippet: html.slice(0, 1500)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${port}`);
    // Pre-warm the headless browser instance on server startup so the first request is instant
    try {
        const { warmBrowser } = require('./services/browserPool');
        warmBrowser();
    } catch (err) {
        console.error('Failed to pre-warm browser pool:', err.message);
    }
});

// Graceful shutdown — close headless browser on exit
const cleanup = async () => {
    try {
        const { closeBrowser } = require('./services/browserPool');
        await closeBrowser();
    } catch {}
    process.exit(0);
};
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
