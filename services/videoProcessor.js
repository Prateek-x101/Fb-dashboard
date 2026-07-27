const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const fetch = require('node-fetch');

const binDir = path.join(__dirname, '..', 'bin');
const ytdlpPath = path.join(binDir, 'yt-dlp.exe');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpegPath = ffmpegInstaller.path;

// Ensure local directories exist
if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
}

// Download yt-dlp binary if not present
async function ensureBinaries() {
    if (fs.existsSync(ytdlpPath)) {
        return;
    }

    console.log("yt-dlp.exe not found. Downloading latest release from GitHub...");
    const downloadUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    
    try {
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`Failed to download yt-dlp: status ${res.status}`);
        
        const fileStream = fs.createWriteStream(ytdlpPath);
        await new Promise((resolve, reject) => {
            res.body.pipe(fileStream);
            res.body.on("error", reject);
            fileStream.on("finish", resolve);
        });
        console.log("yt-dlp.exe downloaded successfully!");
    } catch (err) {
        console.error("Failed to download yt-dlp binary:", err.message);
        throw err;
    }
}

// Download video using yt-dlp in HD (Optimized Speed)
async function downloadVideo(url, outputFilename) {
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
    processVideo,
    extractFrames,
    cleanupFrames
};
