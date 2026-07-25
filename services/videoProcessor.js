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

// Download video using yt-dlp in HD
async function downloadVideo(url, outputFilename) {
    await ensureBinaries();
    
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    const tempOutputPath = path.join(uploadsDir, `temp_${outputFilename}`);
    
    console.log(`Downloading video from ${url} in highest quality...`);
    
    // Command args: download in best format that is mp4 or merge to mp4, no playlist
    const args = [
        '--no-playlist',
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
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
            
            // yt-dlp might append .mp4 or other extensions if it merged
            // Let's resolve the actual downloaded file name
            let actualPath = tempOutputPath;
            if (!fs.existsSync(actualPath)) {
                // Check if yt-dlp appended extension or changed it
                const files = fs.readdirSync(uploadsDir);
                const matched = files.find(f => f.startsWith(`temp_${path.parse(outputFilename).name}`));
                if (matched) {
                    actualPath = path.join(uploadsDir, matched);
                } else {
                    return reject(new Error("Could not find downloaded file in uploads directory."));
                }
            }
            
            console.log(`Video downloaded successfully to temporary path: ${actualPath}`);
            resolve(actualPath);
        });
    });
}

// Reprocess video using FFmpeg: scale/pad to canvas, strip metadata, refresh MD5
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
    // -y: overwrite output file
    // -map_metadata -1: strip all metadata
    // -c:v libx264 -crf 20: compress using standard H.264
    // -preset fast: encode quickly
    // -c:a aac -b:a 128k: compress audio using standard AAC
    
    let args = [];
    if (filterString) {
        args = [
            '-y',
            '-i', inputPath,
            '-vf', filterString,
            '-c:v', 'libx264',
            '-crf', '20',
            '-preset', 'fast',
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
            '-preset', 'fast',
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
            
            console.log(`FFmpeg processing finished. Video is clean and hashed: ${finalOutputPath}`);
            resolve({
                filePath: finalOutputPath,
                filename: outputFilename
            });
        });
    });
}

module.exports = {
    downloadVideo,
    processVideo
};
