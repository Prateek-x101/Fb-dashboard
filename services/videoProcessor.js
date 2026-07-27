const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const fetch = require('node-fetch');

// ── Facebook Ads Library extractor ──────────────────────────────────────────
// Returns a direct CDN video URL for an fb.com/ads/library/?id=XXX page.
async function extractFbAdsLibraryVideo(pageUrl, accessToken) {
    // Parse the ad ID from the URL
    let adId;
    try {
        const u = new URL(pageUrl);
        adId = u.searchParams.get('id');
    } catch {}
    if (!adId) throw new Error('Could not find ad ID in Facebook Ads Library URL. Make sure the URL contains ?id=...');

    // ── Step 1: build snapshot URL directly (no Graph API call needed) ───────
    // The render_ad endpoint accepts any valid user token and the ad ID.
    const snapshotUrl = `https://www.facebook.com/ads/archive/render_ad/?id=${adId}&access_token=${encodeURIComponent(accessToken)}`;

    // ── Step 2: fetch the snapshot HTML page ──────────────────────────────
    const htmlRes = await fetch(snapshotUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    });
    const html = await htmlRes.text();

    // ── Step 3: extract CDN video URL from HTML ────────────────────────────
    // Facebook embeds video URLs as JSON-encoded strings in the snapshot HTML
    const patterns = [
        /"browser_native_hd_url"\s*:\s*"([^"]+)"/,
        /"browser_native_sd_url"\s*:\s*"([^"]+)"/,
        /"playable_url_quality_hd"\s*:\s*"([^"]+)"/,
        /"playable_url"\s*:\s*"([^"]+)"/,
        /"video_hd_url"\s*:\s*"([^"]+)"/,
        /"video_sd_url"\s*:\s*"([^"]+)"/,
        /og:video[^>]+content="([^"]+\.mp4[^"]*)"/,
        /<video[^>]+src="([^"]+)"/
    ];

    for (const re of patterns) {
        const m = html.match(re);
        if (m && m[1]) {
            // Unescape JSON unicode escapes (Facebook encodes \/ as \\/)
            const videoUrl = m[1].replace(/\\u0025/g, '%').replace(/\\\//g, '/');
            if (videoUrl.startsWith('http')) {
                console.log(`[FBAdsLib] Found video URL via pattern ${re.source.slice(0, 30)}`);
                return videoUrl;
            }
        }
    }

    throw new Error(`Found the ad snapshot but could not locate a video URL inside it. This ad may be image-only, or Facebook changed their page format.`);
}

const binDir = path.join(__dirname, '..', 'bin');
const ytdlpPath = path.join(binDir, 'yt-dlp');          // Linux binary (no .exe)
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpegPath = ffmpegInstaller.path;

// Ensure local directories exist
if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
}

// Download yt-dlp Linux binary if not present
async function ensureBinaries() {
    if (fs.existsSync(ytdlpPath)) {
        // Make sure it is executable (survives redeployments)
        try { fs.chmodSync(ytdlpPath, 0o755); } catch {}
        return;
    }

    console.log("yt-dlp not found. Downloading Linux binary from GitHub...");
    const downloadUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

    try {
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`Failed to download yt-dlp: status ${res.status}`);

        const fileStream = fs.createWriteStream(ytdlpPath);
        await new Promise((resolve, reject) => {
            res.body.pipe(fileStream);
            res.body.on("error", reject);
            fileStream.on("finish", resolve);
        });
        fs.chmodSync(ytdlpPath, 0o755);   // make executable
        console.log("yt-dlp downloaded and marked executable!");
    } catch (err) {
        console.error("Failed to download yt-dlp binary:", err.message);
        throw err;
    }
}

// Download a direct URL (no yt-dlp needed) — used for CDN video links
async function downloadDirectUrl(url, outputFilename) {
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const tempOutputPath = path.join(uploadsDir, `temp_${outputFilename}`);

    console.log(`Downloading direct CDN video from ${url.slice(0, 80)}...`);
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        }
    });
    if (!res.ok) throw new Error(`Failed to download video CDN URL: HTTP ${res.status}`);

    const buffer = await res.buffer();
    fs.writeFileSync(tempOutputPath, buffer);
    console.log(`Direct download complete: ${tempOutputPath}`);
    return tempOutputPath;
}

// Download video using yt-dlp in HD (Optimized Speed)
// accessToken is optional; used only for Facebook Ads Library URLs
async function downloadVideo(url, outputFilename, accessToken) {
    // ── Facebook Ads Library: use dedicated scraper ────────────────────────
    const isFbAdsLib = /facebook\.com\/ads\/library/i.test(url);
    if (isFbAdsLib) {
        if (!accessToken) throw new Error('A connected Facebook account is required to download from the Ads Library. Please connect an account in Settings.');
        const videoUrl = await extractFbAdsLibraryVideo(url, accessToken);
        // Download the direct CDN video URL with fetch
        return downloadDirectUrl(videoUrl, outputFilename);
    }

    await ensureBinaries();
    
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    const tempOutputPath = path.join(uploadsDir, `temp_${outputFilename}`);
    
    console.log(`Downloading video from ${url}...`);
    
    // Optimized yt-dlp parameters:
    // -f best[ext=mp4]/best: directly grab single pre-merged stream (avoid separate stream download & merge phase)
    // --concurrent-fragments 5: parallel chunks download (speeds up network throughput)
    const args = [
        '--no-playlist',
        '-f', 'best[ext=mp4]/best',
        '--concurrent-fragments', '5',
        '--no-warnings',
        '--no-check-certificates',
        '-o', tempOutputPath,
        url
    ];
    
    return new Promise((resolve, reject) => {
        execFile(ytdlpPath, args, (error, stdout, stderr) => {
            if (error) {
                console.error("yt-dlp execution error:", error);
                console.error("yt-dlp stderr:", stderr);
                return reject(new Error(`Failed to download video from URL: ${error.message}`));
            }
            
            // Resolve actual filename
            let actualPath = tempOutputPath;
            if (!fs.existsSync(actualPath)) {
                const files = fs.readdirSync(uploadsDir);
                const matched = files.find(f => f.startsWith(`temp_${path.parse(outputFilename).name}`));
                if (matched) {
                    actualPath = path.join(uploadsDir, matched);
                } else {
                    return reject(new Error("Could not find downloaded file in uploads directory."));
                }
            }
            
            console.log(`Video downloaded successfully to: ${actualPath}`);
            resolve(actualPath);
        });
    });
}

// Reprocess video using FFmpeg: scale/pad to canvas, strip metadata, refresh MD5 (Optimized Speed)
async function processVideo(inputPath, outputFilename, canvasType = 'original') {
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    const finalOutputPath = path.join(uploadsDir, outputFilename);
    
    let filterString = '';
    
    if (canvasType === '9:16') {
        // Fits video into a 1080x1920 vertical canvas with black background padding
        filterString = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black';
    } else if (canvasType === '1:1') {
        // Fits video into a 1080x1080 square canvas with black background padding
        filterString = 'scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:black';
    }
    
    console.log(`Processing video with FFmpeg. Canvas mode: ${canvasType}. Output: ${finalOutputPath}`);
    
    // Command parameters:
    // -preset ultrafast: encode video instantly
    // -map_metadata -1: clear metadata
    let args = [];
    if (filterString) {
        args = [
            '-y',
            '-i', inputPath,
            '-vf', filterString,
            '-c:v', 'libx264',
            '-crf', '20',
            '-preset', 'ultrafast',
            '-map_metadata', '-1',
            '-c:a', 'aac',
            '-b:a', '128k',
            finalOutputPath
        ];
    } else {
        // No resize filter, just clear metadata and re-encode/refresh hash
        args = [
            '-y',
            '-i', inputPath,
            '-c:v', 'libx264',
            '-crf', '20',
            '-preset', 'ultrafast',
            '-map_metadata', '-1',
            '-c:a', 'aac',
            '-b:a', '128k',
            finalOutputPath
        ];
    }
    
    return new Promise((resolve, reject) => {
        execFile(ffmpegPath, args, (error, stdout, stderr) => {
            // Clean up temporary downloaded file
            try {
                if (fs.existsSync(inputPath)) {
                    fs.unlinkSync(inputPath);
                }
            } catch (cleanupErr) {
                console.error("Failed to clean up temp video file:", cleanupErr.message);
            }
            
            if (error) {
                console.error("FFmpeg execution error:", error);
                console.error("FFmpeg stderr:", stderr);
                return reject(new Error(`Failed to clean/process video creative: ${error.message}`));
            }
            
            console.log(`FFmpeg processing finished: ${finalOutputPath}`);
            resolve({
                filePath: finalOutputPath,
                filename: outputFilename
            });
        });
    });
}

// Extract evenly-spaced frames from a video for AI analysis
async function extractFrames(videoPath, maxFrames = 20) {
    const framesDir = path.join(path.dirname(videoPath), `frames_${Date.now()}`);
    fs.mkdirSync(framesDir, { recursive: true });

    // 1 frame every 2 seconds, scaled to 720px wide, max `maxFrames` frames
    const args = [
        '-y', '-i', videoPath,
        '-vf', 'fps=0.5,scale=720:-2',
        '-vframes', String(maxFrames),
        '-q:v', '4',
        '-f', 'image2',
        path.join(framesDir, 'frame_%03d.jpg')
    ];

    await new Promise((resolve, reject) => {
        execFile(ffmpegPath, args, (err, stdout, stderr) => {
            if (err) {
                console.error('Frame extraction stderr:', stderr);
                return reject(new Error('Frame extraction failed: ' + err.message));
            }
            resolve();
        });
    });

    const files = fs.readdirSync(framesDir)
        .filter(f => f.endsWith('.jpg'))
        .sort();

    return files.map((f, i) => ({
        index: i,
        filename: f,
        filePath: path.join(framesDir, f),
        framesDir,
        base64: fs.readFileSync(path.join(framesDir, f)).toString('base64')
    }));
}

// Clean up extracted frame files and their temp directory
function cleanupFrames(frames) {
    const dirs = new Set();
    for (const frame of frames) {
        try { if (fs.existsSync(frame.filePath)) fs.unlinkSync(frame.filePath); } catch {}
        if (frame.framesDir) dirs.add(frame.framesDir);
    }
    for (const dir of dirs) {
        try { if (fs.existsSync(dir)) fs.rmdirSync(dir); } catch {}
    }
}

module.exports = {
    downloadVideo,
    downloadDirectUrl,
    processVideo,
    extractFrames,
    cleanupFrames
};
