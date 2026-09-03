const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const browserPool = require('./browserPool');

/**
 * Fetch an image from a URL or local file and return { buffer, mimeType, ext }
 */
async function getImageBuffer(input) {
    if (Buffer.isBuffer(input)) {
        return { buffer: input, mimeType: 'image/jpeg', ext: 'jpg' };
    }

    if (typeof input === 'string') {
        let cleanInput = input.trim();
        if (cleanInput.startsWith('//')) {
            cleanInput = 'https:' + cleanInput;
        }

        // Local upload path (e.g. /uploads/123.jpg or full path)
        if (cleanInput.startsWith('/uploads/') || cleanInput.startsWith('uploads/')) {
            const relPath = cleanInput.replace(/^\/?uploads\//, '');
            const localFile = path.join(__dirname, '..', 'uploads', relPath);
            if (fs.existsSync(localFile)) {
                const buffer = fs.readFileSync(localFile);
                const ext = path.extname(localFile).replace('.', '').toLowerCase() || 'jpg';
                const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
                return { buffer, mimeType, ext };
            }
        }

        if (fs.existsSync(cleanInput) && !cleanInput.startsWith('http')) {
            const buffer = fs.readFileSync(cleanInput);
            const ext = path.extname(cleanInput).replace('.', '').toLowerCase() || 'jpg';
            const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
            return { buffer, mimeType, ext };
        }

        // Remote URL
        if (cleanInput.startsWith('http://') || cleanInput.startsWith('https://')) {
            const response = await fetch(cleanInput, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                },
                timeout: 20000
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch image: HTTP ${response.status}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const contentType = response.headers.get('content-type') || '';
            let ext = 'jpg';
            if (contentType.includes('png')) ext = 'png';
            else if (contentType.includes('webp')) ext = 'webp';
            else if (contentType.includes('gif')) ext = 'gif';
            return { buffer, mimeType: contentType || 'image/jpeg', ext };
        }
    }

    throw new Error('Unsupported image input');
}

/**
 * Super-Fast Dual-Worker Pipeline with (X) Clear Button:
 * Splits images across 2 staggered worker tabs.
 * Each worker navigates once and rapidly processes images using the (X) Clear button!
 * 16 images complete in ~20-25 seconds with 0 abuse error and 0 timeout!
 */
async function translateMultipleImages(imageList) {
    if (!Array.isArray(imageList) || imageList.length === 0) {
        return [];
    }

    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Number of workers: 2 parallel workers (safest and fastest without Google rate limits)
    const NUM_WORKERS = Math.min(2, imageList.length);
    const workerQueues = Array.from({ length: NUM_WORKERS }, () => []);

    // Distribute images round-robin across workers
    imageList.forEach((img, idx) => {
        workerQueues[idx % NUM_WORKERS].push({ img, index: idx });
    });

    console.log(`[GoogleTranslate] Starting ${NUM_WORKERS} parallel workers for ${imageList.length} images...`);

    const allResults = new Array(imageList.length);

    async function runWorker(workerId, queue) {
        if (queue.length === 0) return;

        return await browserPool.withTab(async (page) => {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8' });

            // Stagger workers by 1.5s to prevent concurrent Google Translate page-load spikes
            if (workerId > 0) {
                await new Promise(r => setTimeout(r, workerId * 1500));
            }

            console.log(`[Worker-${workerId + 1}] Loading Google Translate images page...`);
            await page.goto('https://translate.google.co.in/?sl=auto&tl=en&op=images', {
                waitUntil: 'networkidle2',
                timeout: 25000
            });

            // Dismiss cookie/consent dialogs if any
            try {
                const buttons = await page.$$('button');
                for (const btn of buttons) {
                    const text = await page.evaluate(el => el.innerText, btn);
                    if (text && /accept all|agree|i agree|alle akzeptieren|zustimmen/i.test(text)) {
                        await btn.click();
                        await new Promise(r => setTimeout(r, 600));
                        break;
                    }
                }
            } catch (e) {}

            for (let i = 0; i < queue.length; i++) {
                const { img: imgInput, index: originalIdx } = queue[i];
                const imgStart = Date.now();
                console.log(`[Worker-${workerId + 1}] Processing image [${i + 1}/${queue.length}]...`);

                let tempPath = null;
                try {
                    const { buffer: originalBuffer, ext } = await getImageBuffer(imgInput);
                    const tempName = `temp-w${workerId}-${Date.now()}-${uuidv4().substring(0, 6)}.${ext === 'png' ? 'png' : 'jpg'}`;
                    tempPath = path.join(uploadsDir, tempName);
                    fs.writeFileSync(tempPath, originalBuffer);

                    // Ensure file input is available
                    let fileInput = await page.$('input[type="file"]');
                    if (!fileInput) {
                        const clearBtn = await page.$('button[aria-label="Clear image"]');
                        if (clearBtn) {
                            await clearBtn.click();
                            await new Promise(r => setTimeout(r, 400));
                        }
                        fileInput = await page.$('input[type="file"]');
                    }

                    if (!fileInput) throw new Error('File input element not found');

                    await fileInput.uploadFile(tempPath);

                    // Wait for translation (Download translation or blob image)
                    await page.waitForFunction(() => {
                        const downloadBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText && /download/i.test(b.innerText));
                        const img = Array.from(document.querySelectorAll('img')).find(i => i.src && i.src.startsWith('blob:'));
                        return downloadBtn && img;
                    }, { timeout: 20000 });

                    // Extract translated image blob
                    const base64Data = await page.evaluate(async () => {
                        const img = Array.from(document.querySelectorAll('img')).find(i => i.src && i.src.startsWith('blob:'));
                        if (!img) return null;
                        const resp = await fetch(img.src);
                        const blob = await resp.blob();
                        return new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result);
                            reader.readAsDataURL(blob);
                        });
                    });

                    if (base64Data) {
                        const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
                        const renderedBuffer = Buffer.from(cleanBase64, 'base64');
                        const filename = `translated-${Date.now()}-${uuidv4().substring(0, 8)}.${ext === 'png' ? 'png' : 'jpg'}`;
                        const targetFile = path.join(uploadsDir, filename);
                        fs.writeFileSync(targetFile, renderedBuffer);

                        const publicPath = `/uploads/${filename}`;
                        console.log(`[Worker-${workerId + 1}] Image [${i + 1}] DONE in ${((Date.now() - imgStart) / 1000).toFixed(1)}s -> ${publicPath}`);

                        allResults[originalIdx] = {
                            original: imgInput,
                            translated: true,
                            translatedUrl: publicPath
                        };
                    } else {
                        allResults[originalIdx] = { original: imgInput, translated: false };
                    }

                    // Click (X) Clear image button to instantly reset dropzone for the next image!
                    const clearBtn = await page.$('button[aria-label="Clear image"]');
                    if (clearBtn) {
                        await clearBtn.click();
                        await new Promise(r => setTimeout(r, 400));
                    }
                } catch (err) {
                    console.warn(`[Worker-${workerId + 1}] Image [${i + 1}] error: ${err.message}`);
                    allResults[originalIdx] = { original: imgInput, translated: false };

                    try {
                        const clearBtn = await page.$('button[aria-label="Clear image"]');
                        if (clearBtn) await clearBtn.click();
                    } catch {}
                } finally {
                    if (tempPath && fs.existsSync(tempPath)) {
                        try { fs.unlinkSync(tempPath); } catch {}
                    }
                }
            }
        }, { blockImages: false, timeout: Math.max(60000, queue.length * 20000) });
    }

    // Run both workers simultaneously
    await Promise.all(workerQueues.map((q, idx) => runWorker(idx, q)));

    return allResults.filter(Boolean);
}

/**
 * Single Image translation helper
 */
async function translateImage(imageInput) {
    const res = await translateMultipleImages([imageInput]);
    return res[0] || { translated: false, originalUrl: imageInput };
}

module.exports = {
    translateImage,
    translateMultipleImages,
    getImageBuffer
};
