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
 * Translate multiple images using the proven Human-Like Google Translate & Google Lens Engine:
 * - Fresh session per image (Bypasses Google Clear-button download bug)
 * - 3s Warm-up delay for WebAssembly & OCR models to initialize
 * - 3s Canvas Settle delay to bake the in-painted canvas into downloadable memory
 * - Universal sl=auto & tl=en (translates German, French, Spanish, tables, charts, numbers flawlessly)
 */
async function translateMultipleImages(imageList, sourceLang = 'auto') {
    if (!Array.isArray(imageList) || imageList.length === 0) {
        return [];
    }

    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const downloadsDir = path.join(process.env.USERPROFILE || 'C:\\Users\\HP-PC', 'Downloads');
    const isLinux = process.platform === 'linux';

    console.log(`[GoogleTranslate] Starting translation session for ${imageList.length} images...`);

    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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
                headless: false, // Visible real Chrome
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

    const page = await browser.newPage();
    const allResults = [];

    for (let i = 0; i < imageList.length; i++) {
        const imgInput = imageList[i];
        console.log(`\n[GoogleTranslate] Processing image [${i + 1}/${imageList.length}]: ${imgInput}`);

        let localInfo = null;
        try {
            localInfo = await getLocalImageFile(imgInput, uploadsDir);
            const ext = (path.extname(localInfo.localPath) || '').toLowerCase();

            // Skip animated gifs or video formats
            if (ext === '.gif' || ext === '.svg' || ext === '.mp4') {
                console.log(`[GoogleTranslate] Image [${i + 1}] is ${ext} - preserving original.`);
                allResults.push({ original: imgInput, translated: false });
                continue;
            }

            // Step 1: Fresh Google Translate session for this image
            console.log(`[GoogleTranslate] Loading fresh Google Translate session...`);
            await page.goto('https://translate.google.co.in/?sl=auto&tl=en&op=images', {
                waitUntil: 'networkidle2',
                timeout: 35000
            });
            await page.waitForSelector('input[accept*="image"]', { timeout: 15000 });

            // Step 2: 3s WARM-UP DELAY for Google Lens WebAssembly & OCR models
            console.log(`[GoogleTranslate] [3s Warm-Up Delay] Initializing OCR models...`);
            await new Promise(r => setTimeout(r, 3000));

            const beforeDownloads = fs.existsSync(downloadsDir) ? fs.readdirSync(downloadsDir) : [];
            const imageInput = await page.$('input[accept*="image"]');

            console.log(`[GoogleTranslate] Uploading image [${i + 1}] into Google Translate...`);
            await imageInput.uploadFile(localInfo.localPath);

            // Step 3: Wait for translation
            let hasTranslation = false;
            for (let poll = 0; poll < 35; poll++) {
                await new Promise(r => setTimeout(r, 500));

                const status = await page.evaluate(() => {
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
                    console.log(`[GoogleTranslate] Translation complete in ${((poll + 1) * 0.5).toFixed(1)}s!`);
                    hasTranslation = true;
                    break;
                }

                // Check for "Can't detect text" toast after 5s of processing
                if (poll >= 10) {
                    const noText = await page.evaluate(() => {
                        const bodyText = document.body.innerText || '';
                        return bodyText.includes("Can't detect text") || bodyText.includes("could not detect text");
                    });
                    if (noText) {
                        console.log(`[GoogleTranslate] Image [${i + 1}] has no foreign text - preserving original.`);
                        break;
                    }
                }
            }

            if (hasTranslation) {
                // Step 4: 3s CANVAS SETTLE DELAY to bake translated canvas into memory
                console.log(`[GoogleTranslate] [3s Settle Delay] Baking canvas in memory...`);
                await new Promise(r => setTimeout(r, 3000));

                console.log(`[GoogleTranslate] Clicking Download translation button...`);
                await page.evaluate(() => {
                    const dlBtn = Array.from(document.querySelectorAll('button, a')).find(b => {
                        const a = (b.getAttribute('aria-label') || '').toLowerCase();
                        const t = (b.innerText || '').toLowerCase();
                        return a.includes('download') || t.includes('download');
                    });
                    if (dlBtn) dlBtn.click();
                });

                // Step 5: Capture downloaded file
                let downloadedFile = null;
                for (let w = 0; w < 24; w++) {
                    await new Promise(r => setTimeout(r, 250));
                    try {
                        const nowDownloads = fs.readdirSync(downloadsDir);
                        const newFiles = nowDownloads.filter(f => !beforeDownloads.includes(f) && !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
                        if (newFiles.length > 0) {
                            downloadedFile = path.join(downloadsDir, newFiles[0]);
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
                    console.log(`[GoogleTranslate] SUCCESS: Image [${i + 1}] saved to ${publicPath} (${fs.statSync(targetFile).size} bytes)`);

                    allResults.push({
                        original: imgInput,
                        translated: true,
                        translatedUrl: publicPath
                    });
                } else {
                    console.warn(`[GoogleTranslate] Could not find downloaded file for image [${i + 1}]`);
                    allResults.push({ original: imgInput, translated: false });
                }
            } else {
                allResults.push({ original: imgInput, translated: false });
            }
        } catch (imgErr) {
            console.error(`[GoogleTranslate] Error on image [${i + 1}]:`, imgErr.message);
            allResults.push({ original: imgInput, translated: false });
        } finally {
            if (localInfo && localInfo.isTemp && fs.existsSync(localInfo.localPath)) {
                try { fs.unlinkSync(localInfo.localPath); } catch {}
            }
        }
    }

    try {
        console.log(`[GoogleTranslate] All images finished. Closing browser session.`);
        await page.close();
        await browser.close();
    } catch {}

    return allResults;
}

module.exports = {
    translateMultipleImages
};
