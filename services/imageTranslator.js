const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

/**
 * Cleanly download or resolve an image to a local file on disk
 */
async function getLocalImageFile(input, uploadsDir) {
    if (typeof input === 'string') {
        let cleanInput = input.trim();
        if (cleanInput.startsWith('//')) cleanInput = 'https:' + cleanInput;

        // Local upload path (e.g. /uploads/123.jpg or uploads/123.jpg)
        if (cleanInput.startsWith('/uploads/') || cleanInput.startsWith('uploads/')) {
            const relPath = cleanInput.replace(/^\/?uploads\//, '');
            const localFile = path.join(uploadsDir, relPath);
            if (fs.existsSync(localFile)) {
                return { localPath: localFile, isTemp: false };
            }
        }

        if (fs.existsSync(cleanInput) && !cleanInput.startsWith('http')) {
            return { localPath: cleanInput, isTemp: false };
        }

        // Remote URL (Shopify CDN, etc.)
        if (cleanInput.startsWith('http://') || cleanInput.startsWith('https://')) {
            const resp = await fetch(cleanInput, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
                },
                timeout: 25000
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            const arrayBuffer = await resp.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const contentType = resp.headers.get('content-type') || '';
            let ext = 'jpg';
            if (contentType.includes('png') || cleanInput.includes('.png')) ext = 'png';
            else if (contentType.includes('webp') || cleanInput.includes('.webp')) ext = 'webp';
            else if (contentType.includes('gif') || cleanInput.includes('.gif')) ext = 'gif';

            const tempName = `temp-${Date.now()}-${uuidv4().substring(0, 8)}.${ext}`;
            const tempFile = path.join(uploadsDir, tempName);
            fs.writeFileSync(tempFile, buffer);
            return { localPath: tempFile, isTemp: true, ext };
        }
    }

    throw new Error('Unsupported image input');
}

/**
 * High-Speed Parallel Google Translate & Google Lens Engine:
 * - 4 Parallel Tabs processing the queue concurrently
 * - Isolated CDP download paths per tab to prevent download collisions
 * - 2s Warm-up delay for WebAssembly & OCR models
 * - 2s Canvas Settle delay to bake the in-painted canvas into downloadable memory
 * - Universal sl=auto & tl=en (translates German, French, Spanish, tables, charts, numbers)
 */
async function translateMultipleImages(imageList, sourceLang = 'auto') {
    if (!Array.isArray(imageList) || imageList.length === 0) {
        return [];
    }

    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const workersBaseDir = path.join(uploadsDir, 'workers');
    if (!fs.existsSync(workersBaseDir)) fs.mkdirSync(workersBaseDir, { recursive: true });

    const isLinux = process.platform === 'linux';
    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

    // Cap at 4 parallel tabs for optimal CPU/RAM balance and blistering speed
    const NUM_WORKERS = Math.min(4, imageList.length);
    console.log(`[GoogleTranslate] Launching ${NUM_WORKERS} parallel tabs for ${imageList.length} images...`);

    let browser = null;
    try {
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
                headless: false, // Real visible Chrome on Windows
                defaultViewport: null,
                ignoreDefaultArgs: ['--enable-automation'],
                args: [
                    '--start-maximized',
                    '--no-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--enable-gpu',
                    '--enable-webgl',
                    '--no-first-run',
                    '--no-default-browser-check'
                ]
            });
        }
    } catch (launchErr) {
        console.error('[GoogleTranslate] Failed to launch Chrome:', launchErr.message);
        return imageList.map(img => ({ original: img, translated: false }));
    }

    const queue = imageList.map((img, idx) => ({ img, originalIdx: idx }));
    const allResults = new Array(imageList.length);

    // Initialize worker tabs with CDP isolated download folders
    const workers = [];
    for (let w = 0; w < NUM_WORKERS; w++) {
        const workerDir = path.join(workersBaseDir, `worker_${w + 1}`);
        if (!fs.existsSync(workerDir)) fs.mkdirSync(workerDir, { recursive: true });

        const page = await browser.newPage();
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: workerDir
        });

        workers.push({ id: w + 1, page, client, workerDir });
    }

    console.log(`[GoogleTranslate] All ${NUM_WORKERS} tabs initialized with isolated download paths.`);

    // Worker queue consumer
    async function processQueue(worker) {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;

            const { img: imgInput, originalIdx } = item;
            const imgStart = Date.now();
            console.log(`[Tab ${worker.id}] Processing image [${originalIdx + 1}/${imageList.length}]: ${imgInput}`);

            let localInfo = null;
            try {
                localInfo = await getLocalImageFile(imgInput, uploadsDir);
                const ext = (path.extname(localInfo.localPath) || '').toLowerCase();

                // Skip animated gifs or video formats
                if (ext === '.gif' || ext === '.svg' || ext === '.mp4') {
                    console.log(`[Tab ${worker.id}] Image [${originalIdx + 1}] is ${ext} - preserving original.`);
                    allResults[originalIdx] = { original: imgInput, translated: false };
                    continue;
                }

                // Clear worker download folder
                try {
                    const oldFiles = fs.readdirSync(worker.workerDir);
                    oldFiles.forEach(f => {
                        try { fs.unlinkSync(path.join(worker.workerDir, f)); } catch {}
                    });
                } catch {}

                // Step 1: Fresh Google Translate session for this image
                await worker.page.goto('https://translate.google.co.in/?sl=auto&tl=en&op=images', {
                    waitUntil: 'networkidle2',
                    timeout: 35000
                });
                await worker.page.waitForSelector('input[accept*="image"]', { timeout: 15000 });

                // Step 2: 2s WARM-UP DELAY for Google Lens WebAssembly & OCR models
                await new Promise(r => setTimeout(r, 2000));

                const imageInput = await worker.page.$('input[accept*="image"]');
                await imageInput.uploadFile(localInfo.localPath);

                // Step 3: Wait for translation
                let hasTranslation = false;
                for (let poll = 0; poll < 35; poll++) {
                    await new Promise(r => setTimeout(r, 500));

                    const status = await worker.page.evaluate(() => {
                        const bodyText = document.body.innerText || '';
                        const isTranslating = bodyText.includes('Translating');
                        const dlBtn = Array.from(document.querySelectorAll('button, a')).find(b => {
                            const a = (b.getAttribute('aria-label') || '').toLowerCase();
                            const t = (b.innerText || '').toLowerCase();
                            return a.includes('download') || t.includes('download');
                        });
                        return { isTranslating, hasDl: !!dlBtn };
                    });

                    if (!status.isTranslating && status.hasDl && poll >= 3) {
                        hasTranslation = true;
                        break;
                    }

                    if (poll >= 10) {
                        const noText = await worker.page.evaluate(() => {
                            const bodyText = document.body.innerText || '';
                            return bodyText.includes("Can't detect text") || bodyText.includes("could not detect text");
                        });
                        if (noText) {
                            console.log(`[Tab ${worker.id}] Image [${originalIdx + 1}] has no foreign text - preserving original.`);
                            break;
                        }
                    }
                }

                if (hasTranslation) {
                    // Step 4: 2s CANVAS SETTLE DELAY to bake translated canvas into memory
                    await new Promise(r => setTimeout(r, 2000));

                    // Click Download translation button
                    await worker.page.evaluate(() => {
                        const dlBtn = Array.from(document.querySelectorAll('button, a')).find(b => {
                            const a = (b.getAttribute('aria-label') || '').toLowerCase();
                            const t = (b.innerText || '').toLowerCase();
                            return a.includes('download') || t.includes('download');
                        });
                        if (dlBtn) dlBtn.click();
                    });

                    // Step 5: Capture downloaded file from isolated worker directory
                    let downloadedFile = null;
                    for (let w = 0; w < 24; w++) {
                        await new Promise(r => setTimeout(r, 250));
                        try {
                            const files = fs.readdirSync(worker.workerDir).filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
                            if (files.length > 0) {
                                downloadedFile = path.join(worker.workerDir, files[0]);
                                break;
                            }
                        } catch {}
                    }

                    if (downloadedFile && fs.existsSync(downloadedFile)) {
                        const filename = `translated-${Date.now()}-${uuidv4().substring(0, 8)}.png`;
                        const targetFile = path.join(uploadsDir, filename);
                        fs.copyFileSync(downloadedFile, targetFile);
                        try { fs.unlinkSync(downloadedFile); } catch {}

                        const publicPath = `/uploads/${filename}`;
                        console.log(`[Tab ${worker.id}] >> SUCCESS: Image [${originalIdx + 1}] translated in ${((Date.now() - imgStart) / 1000).toFixed(1)}s -> ${publicPath}`);

                        allResults[originalIdx] = {
                            original: imgInput,
                            translated: true,
                            translatedUrl: publicPath
                        };
                    } else {
                        allResults[originalIdx] = { original: imgInput, translated: false };
                    }
                } else {
                    allResults[originalIdx] = { original: imgInput, translated: false };
                }
            } catch (err) {
                console.error(`[Tab ${worker.id}] Error on image [${originalIdx + 1}]:`, err.message);
                allResults[originalIdx] = { original: imgInput, translated: false };
            } finally {
                if (localInfo && localInfo.isTemp && fs.existsSync(localInfo.localPath)) {
                    try { fs.unlinkSync(localInfo.localPath); } catch {}
                }
            }
        }
    }

    const startTime = Date.now();
    await Promise.all(workers.map(w => processQueue(w)));

    try {
        await browser.close();
    } catch {}

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[GoogleTranslate] All ${imageList.length} images finished in ${totalSeconds}s across ${NUM_WORKERS} parallel tabs!`);
    return allResults.filter(Boolean);
}

module.exports = {
    translateMultipleImages
};
