const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

// ─── Helper: Download/resolve image to local temp file ───
async function getLocalImageFile(input, uploadsDir) {
    if (typeof input === 'string') {
        let url = input.trim();
        if (url.startsWith('//')) url = 'https:' + url;

        // Already a local upload
        if (url.startsWith('/uploads/') || url.startsWith('uploads/')) {
            const relPath = url.replace(/^\/?uploads\//, '');
            const localFile = path.join(uploadsDir, relPath);
            if (fs.existsSync(localFile)) return { localPath: localFile, isTemp: false };
        }

        // Existing local file
        if (fs.existsSync(url) && !url.startsWith('http')) {
            return { localPath: url, isTemp: false };
        }

        // Remote URL → download to temp file
        if (url.startsWith('http://') || url.startsWith('https://')) {
            const resp = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
                timeout: 25000
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            const buffer = Buffer.from(await resp.arrayBuffer());
            const contentType = resp.headers.get('content-type') || '';
            let ext = 'jpg';
            if (contentType.includes('png') || url.includes('.png')) ext = 'png';
            else if (contentType.includes('webp') || url.includes('.webp')) ext = 'webp';
            else if (contentType.includes('gif') || url.includes('.gif')) ext = 'gif';

            const tempFile = path.join(uploadsDir, `temp-${Date.now()}-${uuidv4().substring(0, 8)}.${ext}`);
            fs.writeFileSync(tempFile, buffer);
            return { localPath: tempFile, isTemp: true };
        }
    }
    throw new Error('Unsupported image input');
}

// ─── Helper: Wait ms ───
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Helper: Click "Clear image" button and wait for fresh upload input ───
async function clearAndReset(page, sourceLang) {
    // Try exact "Clear image" button first
    const cleared = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const clearBtn = btns.find(b => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return aria === 'clear image' || aria === 'clear source image';
        });
        if (clearBtn) { clearBtn.click(); return true; }
        return false;
    }).catch(() => false);

    if (cleared) {
        try {
            await page.waitForSelector('input[accept*="image"]', { timeout: 3000 });
            return;
        } catch {}
    }

    // Fallback: fast navigation reset
    await page.goto(`https://translate.google.com/?hl=en&sl=${sourceLang}&tl=en&op=images`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
    });
    await page.waitForSelector('input[accept*="image"]', { timeout: 10000 });
}

// ─── Helper: Upload image and poll for translation result ───
async function uploadAndWaitForTranslation(page, localPath, tabId, imageIdx, totalImages) {
    // Bring tab to front for WebGL canvas rendering
    await page.bringToFront().catch(() => {});

    // Upload file on the image input (with retry if input missing)
    let input;
    try {
        input = await page.waitForSelector('input[accept*="image"]', { timeout: 5000 });
    } catch {
        // Input missing — reload page and retry
        console.log(`[Tab ${tabId}] Upload input missing, reloading page...`);
        await page.goto(`https://translate.google.com/?hl=en&sl=auto&tl=en&op=images`, {
            waitUntil: 'domcontentloaded', timeout: 15000
        });
        input = await page.waitForSelector('input[accept*="image"]', { timeout: 10000 });
    }
    await sleep(200);
    await input.uploadFile(localPath);

    // Dispatch events to trigger Google Translate processing
    await page.evaluate(() => {
        const fileInput = document.querySelector('input[accept*="image"]');
        if (fileInput) {
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }).catch(() => {});

    console.log(`[Tab ${tabId}] Uploaded image [${imageIdx + 1}/${totalImages}], waiting for translation...`);

    // Poll for result: max 50 polls × 500ms = 25 seconds
    for (let poll = 0; poll < 50; poll++) {
        await sleep(500);

        // Cycle tab focus every 2 polls so Chromium compositor paints WebGL canvas
        if (poll % 2 === 0) {
            await page.bringToFront().catch(() => {});
        }

        // Check for error toast (after poll 1 to give time for processing)
        if (poll >= 1) {
            const hasError = await page.evaluate(() => {
                const text = (document.body.innerText || '').toLowerCase();
                return text.includes("can't detect text") ||
                       text.includes("cant detect text") ||
                       text.includes("can't translate") ||
                       text.includes("cant translate") ||
                       text.includes("could not detect text") ||
                       text.includes("language may not be supported") ||
                       text.includes("couldn't translate") ||
                       text.includes("text kann nicht erkannt werden");
            }).catch(() => false);

            if (hasError) {
                console.log(`[Tab ${tabId}] Image [${imageIdx + 1}] Can't detect text — preserving original.`);
                return { status: 'no_text' };
            }
        }

        // Check for translated result (after poll 2 to let canvas render)
        if (poll >= 2) {
            const result = await page.evaluate(() => {
                const bodyText = document.body.innerText || '';
                const isTranslating = bodyText.includes('Translating') || bodyText.includes('translating');
                if (isTranslating) return null;

                // Check download button
                const hasDl = Array.from(document.querySelectorAll('button, a, [role="button"]')).some(b => {
                    const a = (b.getAttribute('aria-label') || '').toLowerCase();
                    const t = (b.innerText || '').toLowerCase();
                    const tip = (b.getAttribute('data-tooltip') || '').toLowerCase();
                    return a.includes('download') || t.includes('download') || tip.includes('download') ||
                           a.includes('herunterladen') || t.includes('herunterladen');
                });

                // Check rendered blob image
                const hasBlob = Array.from(document.querySelectorAll('img[src^="blob:"]'))
                    .some(img => img.naturalWidth > 50 && img.naturalHeight > 50);

                return (hasDl || hasBlob) ? { ready: true } : null;
            }).catch(() => null);

            if (result) {
                return { status: 'translated' };
            }
        }
    }

    console.log(`[Tab ${tabId}] Image [${imageIdx + 1}] Polling timed out (25s).`);
    return { status: 'timeout' };
}

// ─── Helper: Extract translated image blob from page ───
async function extractTranslatedBlob(page) {
    await sleep(600); // Let canvas fully settle

    const base64Data = await page.evaluate(async () => {
        const imgs = Array.from(document.querySelectorAll('img[src^="blob:"]'));
        const target = imgs.find(img => img.naturalWidth > 50 && img.naturalHeight > 50) || imgs[imgs.length - 1];
        if (!target) return null;

        try {
            const resp = await fetch(target.src);
            const blob = await resp.blob();
            return new Promise(resolve => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            });
        } catch {
            return null;
        }
    });

    return base64Data;
}

// ─── Main: Parallel 5-Tab Google Translate Image Translator ───
async function translateMultipleImages(imageList, sourceLang = 'auto') {
    if (!Array.isArray(imageList) || imageList.length === 0) return [];

    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const NUM_WORKERS = Math.min(5, imageList.length);
    const totalImages = imageList.length;
    console.log(`[GoogleTranslate] Launching ${NUM_WORKERS} parallel tabs for ${totalImages} images...`);

    // ── Launch Chrome ──
    let browser;
    try {
        const isLinux = process.platform === 'linux';
        const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

        if (isLinux) {
            const chromium = require('@sparticuz/chromium');
            browser = await puppeteer.launch({
                args: chromium.args,
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(),
                headless: chromium.headless,
                ignoreHTTPSErrors: true
            });
        } else {
            browser = await puppeteer.launch({
                executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
                headless: false,
                defaultViewport: null,
                ignoreDefaultArgs: ['--enable-automation'],
                args: [
                    '--start-maximized',
                    '--no-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-features=CalculateNativeWinOcclusion',
                    '--enable-gpu',
                    '--enable-webgl',
                    '--no-first-run',
                    '--no-default-browser-check'
                ]
            });
        }
    } catch (err) {
        console.error('[GoogleTranslate] Failed to launch Chrome:', err.message);
        return imageList.map(img => ({ original: img, translated: false }));
    }

    // ── Create worker tabs ──
    const existingPages = await browser.pages();
    const workers = [];
    for (let i = 0; i < NUM_WORKERS; i++) {
        const page = i < existingPages.length ? existingPages[i] : await browser.newPage();
        workers.push({ id: i + 1, page });
    }
    // Close surplus tabs
    for (let i = NUM_WORKERS; i < existingPages.length; i++) {
        existingPages[i].close().catch(() => {});
    }

    // ── Warm up all tabs in parallel ──
    console.log(`[GoogleTranslate] Warming up ${NUM_WORKERS} worker tabs in parallel...`);
    const warmStart = Date.now();
    await Promise.all(workers.map(async (w) => {
        try {
            await w.page.goto(`https://translate.google.com/?hl=en&sl=${sourceLang}&tl=en&op=images`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            await w.page.waitForSelector('input[accept*="image"]', { timeout: 20000 });
            console.log(`[GoogleTranslate] Worker tab ${w.id} warm and ready.`);
        } catch (err) {
            console.warn(`[GoogleTranslate] Worker tab ${w.id} warm-up failed: ${err.message}`);
        }
    }));
    console.log(`[GoogleTranslate] All ${NUM_WORKERS} worker tabs ready in ${((Date.now() - warmStart) / 1000).toFixed(1)}s.`);

    // ── Shared queue & results ──
    const queue = imageList.map((img, idx) => ({ img, idx }));
    const results = new Array(totalImages);

    // ── Worker loop ──
    async function workerLoop(worker) {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;

            const { img: imgInput, idx } = item;
            const imgStart = Date.now();
            console.log(`[Tab ${worker.id}] Processing image [${idx + 1}/${totalImages}]: ${imgInput}`);

            let localInfo = null;
            try {
                // Download image to local file
                localInfo = await getLocalImageFile(imgInput, uploadsDir);
                const ext = (path.extname(localInfo.localPath) || '').toLowerCase();

                // Skip non-translatable formats
                if (['.gif', '.svg', '.mp4'].includes(ext)) {
                    console.log(`[Tab ${worker.id}] Image [${idx + 1}] is ${ext} — skipping.`);
                    results[idx] = { original: imgInput, translated: false };
                    continue;
                }

                // Upload & wait for translation
                const pollResult = await uploadAndWaitForTranslation(worker.page, localInfo.localPath, worker.id, idx, totalImages);

                if (pollResult.status === 'translated') {
                    // Extract the translated blob
                    const base64Data = await extractTranslatedBlob(worker.page);

                    if (base64Data) {
                        const filename = `translated-${Date.now()}-${uuidv4().substring(0, 8)}.png`;
                        const targetFile = path.join(uploadsDir, filename);
                        const rawB64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
                        fs.writeFileSync(targetFile, Buffer.from(rawB64, 'base64'));

                        const publicPath = `/uploads/${filename}`;
                        const elapsed = ((Date.now() - imgStart) / 1000).toFixed(1);
                        const fileSize = fs.statSync(targetFile).size;
                        console.log(`[Tab ${worker.id}] ✅ Image [${idx + 1}] translated in ${elapsed}s → ${publicPath} (${fileSize} bytes)`);

                        results[idx] = { original: imgInput, translated: true, translatedUrl: publicPath };
                    } else {
                        console.warn(`[Tab ${worker.id}] Image [${idx + 1}] blob extraction failed — preserving original.`);
                        results[idx] = { original: imgInput, translated: false };
                    }
                } else {
                    // no_text or timeout — preserve original
                    results[idx] = { original: imgInput, translated: false };
                }

                // Clear image for next upload
                await clearAndReset(worker.page, sourceLang);

                // 1.5 second cooldown before next image
                await sleep(1500);

            } catch (err) {
                console.error(`[Tab ${worker.id}] Error on image [${idx + 1}]:`, err.message);
                results[idx] = { original: imgInput, translated: false };

                // Try to recover the tab for next image
                try {
                    await worker.page.goto(`https://translate.google.com/?hl=en&sl=${sourceLang}&tl=en&op=images`, {
                        waitUntil: 'domcontentloaded',
                        timeout: 15000
                    });
                    await worker.page.waitForSelector('input[accept*="image"]', { timeout: 10000 });
                } catch {}
            } finally {
                // Clean up temp files
                if (localInfo && localInfo.isTemp && fs.existsSync(localInfo.localPath)) {
                    try { fs.unlinkSync(localInfo.localPath); } catch {}
                }
            }
        }
    }

    // ── Run all workers in parallel ──
    const processStart = Date.now();
    await Promise.all(workers.map(w => workerLoop(w)));

    // ── Cleanup ──
    try { await browser.close(); } catch {}

    const totalTime = ((Date.now() - processStart) / 1000).toFixed(1);
    console.log(`[GoogleTranslate] All ${totalImages} images finished in ${totalTime}s across ${NUM_WORKERS} parallel tabs!`);

    return results.filter(Boolean);
}

module.exports = { translateMultipleImages };
