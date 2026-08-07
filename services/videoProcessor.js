const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const fetch = require('node-fetch');

// ── Facebook Ads Library extractor ──────────────────────────────────────────
// Returns a direct CDN video URL for an fb.com/ads/library/?id=XXX page.
// Helper to extract a video/CDN URL from Facebook HTML source using multiple regex strategies
function parseVideoUrlFromHtml(html) {
    function fbUnescape(s) {
        return s
            .replace(/\\u002F/gi, '/')
            .replace(/\\u0026/gi, '&')
            .replace(/\\u003A/gi, ':')
            .replace(/\\u003D/gi, '=')
            .replace(/\\u0025/gi, '%')
            .replace(/\\\//g, '/')
            .replace(/\\"/g, '"');
    }

    // Strategy A: look for any fbcdn.net video CDN URL directly (most robust)
    const cdnRe = /https:\/\/video[a-z0-9._-]*\.fbcdn\.net\/v\/[^\s"'<>\\]{20,}/g;
    const cdnMatches = html.match(cdnRe) || [];
    if (cdnMatches.length) {
        const best = cdnMatches.find(u => u.includes('_hd')) || cdnMatches[0];
        console.log(`[FBAdsLib] Strategy A: found CDN URL: ${best.slice(0, 80)}`);
        return fbUnescape(best);
    }

    // Strategy B: Unicode-escaped fbcdn URL
    const cdnReEncoded = /https:\\u002F\\u002Fvideo[a-z0-9._-]*\.fbcdn\.net\\u002Fv\\u002F[^\s"'<>]{20,}/g;
    const cdnEncoded = html.match(cdnReEncoded) || [];
    if (cdnEncoded.length) {
        const best = cdnEncoded.find(u => u.includes('_hd')) || cdnEncoded[0];
        console.log(`[FBAdsLib] Strategy B: found encoded CDN URL`);
        return fbUnescape(best);
    }

    // Strategy C: named JSON keys for video URL
    const keyPatterns = [
        /"browser_native_hd_url"\s*:\s*"([^"]{20,})"/,
        /"browser_native_sd_url"\s*:\s*"([^"]{20,})"/,
        /"playable_url_quality_hd"\s*:\s*"([^"]{20,})"/,
        /"playable_url"\s*:\s*"([^"]{20,})"/,
        /"video_hd_url"\s*:\s*"([^"]{20,})"/,
        /"video_sd_url"\s*:\s*"([^"]{20,})"/,
        /"videoUrl"\s*:\s*"([^"]{20,})"/,
        /"src"\s*:\s*"(https:\\?\/\\?\/[a-z0-9._-]+\.fbcdn\.net[^"]{20,})"/,
        /og:video[^>]+content="([^"]+)"/,
        /<video[^>]+src="(https?:\/\/[^"]+)"/,
        /source\s+src="(https?:\/\/[^"]+\.mp4[^"]*)"/
    ];
    for (const re of keyPatterns) {
        const m = html.match(re);
        if (m && m[1]) {
            const videoUrl = fbUnescape(m[1]);
            if (videoUrl.startsWith('http')) {
                console.log(`[FBAdsLib] Strategy C: key=${re.source.slice(0, 40)}`);
                return videoUrl;
            }
        }
    }

    // Strategy D: any .mp4 URL in the page
    const mp4Re = /https?:\/\/[^\s"'<>]{10,}\.mp4[^\s"'<>]*/g;
    const mp4Matches = html.match(mp4Re) || [];
    if (mp4Matches.length) {
        console.log(`[FBAdsLib] Strategy D: found mp4 URL`);
        return fbUnescape(mp4Matches[0]);
    }

    return null;
}

// Returns a direct CDN video URL for an fb.com/ads/library/?id=XXX page (HTML scraper fallback).
async function extractFbAdsLibraryVideo(pageUrl, accessToken) {
    // Parse the ad ID from the URL
    let adId;
    try {
        const u = new URL(pageUrl);
        adId = u.searchParams.get('id');
    } catch {}
    if (!adId) throw new Error('Could not find ad ID in Facebook Ads Library URL. Make sure the URL contains ?id=...');

    // ── Method 1: Public scraper (No token required!) ──────────────────────
    const publicUrl = `https://www.facebook.com/ads/library/?id=${adId}`;
    try {
        console.log(`[FBAdsLib] Attempting public extraction (no token) for ad ID: ${adId}`);
        const htmlRes = await fetch(publicUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        if (htmlRes.ok) {
            const html = await htmlRes.text();
            const videoUrl = parseVideoUrlFromHtml(html);
            if (videoUrl) {
                console.log(`[FBAdsLib] Public extraction successful for ad ID: ${adId}`);
                return videoUrl;
            }
        }
    } catch (publicErr) {
        console.warn(`[FBAdsLib] Public extraction failed: ${publicErr.message}`);
    }

    // ── Method 2: Fallback to token-based snapshot ──────────────────────────
    if (accessToken) {
        try {
            console.log(`[FBAdsLib] Falling back to token-based snapshot extraction for ad ID: ${adId}`);
            const snapshotUrl = `https://www.facebook.com/ads/archive/render_ad/?id=${adId}&access_token=${encodeURIComponent(accessToken)}`;
            const htmlRes = await fetch(snapshotUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            });
            const html = await htmlRes.text();

            // Check if it returned an error page
            if (html.length > 3000 || (!html.includes('Sorry, something went wrong') && !html.includes('<title>Error</title>'))) {
                const videoUrl = parseVideoUrlFromHtml(html);
                if (videoUrl) return videoUrl;
            }
        } catch (tokenErr) {
            console.warn(`[FBAdsLib] Token-based extraction failed: ${tokenErr.message}`);
        }
    }

    throw new Error(`Auto-extraction failed. Facebook blocks server requests. Please use the Inspect-Element method: Right-click video in browser -> Inspect -> Copy the direct '.mp4' URL from the <video> tag, and paste it here directly! It will download instantly.`);
}

const binDir = path.join(__dirname, '..', 'bin');
const isWindows = process.platform === 'win32';
const ytdlpPath = path.join(binDir, isWindows ? 'yt-dlp.exe' : 'yt-dlp');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpegPath = ffmpegInstaller.path;

// Ensure local directories exist
if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
}

// Download yt-dlp binary if not present
async function ensureBinaries() {
    if (fs.existsSync(ytdlpPath)) {
        // Make sure it is executable (survives redeployments)
        try { fs.chmodSync(ytdlpPath, 0o755); } catch {}
        return;
    }

    console.log(`yt-dlp not found. Downloading ${isWindows ? 'Windows' : 'Linux'} binary from GitHub...`);
    const downloadUrl = isWindows
        ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
        : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

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

// Resolve the actual downloaded file path (yt-dlp may change the extension)
function resolveActualPath(resolve, reject, tempOutputPath, uploadsDir, outputFilename) {
    let actualPath = tempOutputPath;
    if (!fs.existsSync(actualPath)) {
        const files = fs.readdirSync(uploadsDir);
        const matched = files.find(f => f.startsWith(`temp_${path.parse(outputFilename).name}`));
        if (matched) {
            actualPath = path.join(uploadsDir, matched);
        } else {
            return reject(new Error('Could not find downloaded file in uploads directory.'));
        }
    }
    console.log(`Video downloaded successfully to: ${actualPath}`);
    resolve(actualPath);
}

// Download video using yt-dlp in HD (Optimized Speed)
// accessToken is optional; used only for Facebook Ads Library URLs
async function downloadVideo(url, outputFilename, accessToken) {
    // ── Direct CDN / Video URL fallback (Bypass yt-dlp entirely) ───────────
    // If the URL is a direct link to a video file, fetch it directly
    const isDirectCdnUrl = /\.mp4(\?|$)/i.test(url) || 
                           /\.mov(\?|$)/i.test(url) || 
                           /fbcdn\.net\/v\//i.test(url) || 
                           /cdninstagram\.com/i.test(url) ||
                           url.includes('.mp4?') ||
                           url.startsWith('blob:');
    if (isDirectCdnUrl) {
        console.log(`Bypassing yt-dlp. Downloading direct video CDN link: ${url.slice(0, 80)}...`);
        return downloadDirectUrl(url, outputFilename);
    }

    // ── Facebook Ads Library: use dedicated browser extractor ────────────────
    const isFbAdsLib = /facebook\.com\/ads\/library/i.test(url);
    if (isFbAdsLib) {
        // Try the fast HTML scraper first (extremely quick - under 1s!)
        try {
            console.log(`[FBAdsLib] Trying fast HTML scraper first: ${url.slice(0, 80)}...`);
            const videoUrl = await extractFbAdsLibraryVideo(url, accessToken);
            console.log(`[FBAdsLib] Fast HTML scraper succeeded! Downloading: ${videoUrl.slice(0, 80)}...`);
            return downloadDirectUrl(videoUrl, outputFilename);
        } catch (scraperErr) {
            console.warn(`[FBAdsLib] Fast HTML scraper failed (${scraperErr.message}). Falling back to headless browser extractor...`);
            try {
                const { extractVideoUrl } = require('./browserExtract');
                console.log(`[Browser] Extracting Facebook Ads Library video via headless Chromium: ${url.slice(0, 80)}...`);
                const videoUrl = await extractVideoUrl(url);
                console.log(`[Browser] Got Facebook video URL, downloading: ${videoUrl.slice(0, 80)}...`);
                return downloadDirectUrl(videoUrl, outputFilename);
            } catch (browserErr) {
                console.error(`[Browser] Headless browser extraction also failed: ${browserErr.message}`);
                throw new Error(`Could not extract video. Try copying the direct .mp4 URL from the browser's Inspect Element and pasting it here.`);
            }
        }
    }

    await ensureBinaries();
    
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    const tempOutputPath = path.join(uploadsDir, `temp_${outputFilename}`);
    
    console.log(`Downloading video from ${url}...`);
    
    // Select format dynamically to optimize download speed.
    // Instagram and Pinterest publish single pre-merged videos.
    // Bypassing separate audio/video streams + FFmpeg merging saves 5-10 seconds!
    const isInstagram = /instagram\.com/i.test(url);
    const isPinterest = /pinterest\.(com|co)/i.test(url) || /pin\.it/i.test(url);
    const formatStr = (isInstagram || isPinterest) 
        ? 'best[ext=mp4]/best' 
        : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';

    // yt-dlp args: browser impersonation avoids 403 blocks from YouTube/Instagram/Pinterest
    // --no-call-home & --no-cache-dir: speed up startup by skipping check/update requests
    const args = [
        '--no-playlist',
        '-f', formatStr,
        '--concurrent-fragments', '5',
        '--no-warnings',
        '--no-check-certificates',
        '--no-call-home',
        '--no-cache-dir',
        '--impersonate', 'chrome',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--extractor-retries', '1',
        '--socket-timeout', '15',
        '-o', tempOutputPath,
        url
    ];

    const runYtdlp = (execArgs) => {
        return new Promise((resolve, reject) => {
            console.log(`Executing yt-dlp with path: ${ytdlpPath}`);
            execFile(ytdlpPath, execArgs, { timeout: 300000 }, (error, stdout, stderr) => {
                if (error) {
                    const isExecError = error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 127;
                    if (!isWindows && isExecError) {
                        console.warn('Direct yt-dlp execution failed. Retrying with python3 interpreter...');
                        execFile('python3', [ytdlpPath, ...execArgs], { timeout: 300000 }, (py3Err, py3Out, py3Serr) => {
                            if (py3Err) {
                                console.warn('python3 execution failed. Retrying with python...');
                                execFile('python', [ytdlpPath, ...execArgs], { timeout: 300000 }, (pyErr, pyOut, pySerr) => {
                                    if (pyErr) {
                                        return reject({ error: pyErr, stderr: pySerr });
                                    }
                                    resolve({ stdout: pyOut, stderr: pySerr });
                                });
                            } else {
                                resolve({ stdout: py3Out, stderr: py3Serr });
                            }
                        });
                    } else {
                        reject({ error, stderr });
                    }
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
    };

    return new Promise((resolve, reject) => {
        runYtdlp(args)
            .then(() => resolveActualPath(resolve, reject, tempOutputPath, uploadsDir, outputFilename))
            .catch(({ error, stderr }) => {
                // If impersonation flag unsupported on this yt-dlp build, retry without it
                if (/impersonate|unrecognized/i.test(stderr || error.message)) {
                    console.warn('yt-dlp --impersonate not supported, retrying without it...');
                    const fallbackArgs = args.filter((a, i) =>
                        a !== '--impersonate' && args[i - 1] !== '--impersonate'
                    );
                    runYtdlp(fallbackArgs)
                        .then(() => resolveActualPath(resolve, reject, tempOutputPath, uploadsDir, outputFilename))
                        .catch(({ error: err2, stderr: serr2 }) => {
                            console.error('yt-dlp fallback error:', err2.message);
                            console.error('yt-dlp fallback stderr:', serr2);
                            reject(new Error(`Failed to download video from URL: ${err2.message}`));
                        });
                } else {
                    console.error("yt-dlp execution error:", error.message);
                    console.error("yt-dlp stderr:", stderr);
                    reject(new Error(`Failed to download video from URL: ${error.message}`));
                }
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

    // 1 frame every second, scaled to 1080px wide, max `maxFrames` frames, high quality JPEG
    const args = [
        '-y', '-i', videoPath,
        '-vf', 'fps=1,scale=1080:-2',
        '-vframes', String(maxFrames),
        '-q:v', '2',
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
