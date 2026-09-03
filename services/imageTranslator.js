const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * 5-Tab Parallel Google Translate Engine:
 * 1. REAL IMAGE COPY TO CLIPBOARD: Draws the image to canvas and copies standard image/png to clipboard
 * 2. NATIVE "PASTE FROM CLIPBOARD": Clicks Google Translate's official "Paste from clipboard" button
 * 3. DIRECT RAM EXTRACTION: Hooks URL.createObjectURL to pull the translated image directly from Chrome RAM
 * 4. 2s Canvas settle delay before capture
 */
async function translateMultipleImages(imageList, sourceLang = 'auto') {
    if (!Array.isArray(imageList) || imageList.length === 0) {
        return [];
    }

    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const isLinux = process.platform === 'linux';
    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

    // 5 Parallel Tabs
    const NUM_WORKERS = Math.min(5, imageList.length);
    console.log(`[GoogleTranslate] Launching ${NUM_WORKERS} parallel tabs for ${imageList.length} images (Real Image Copy & Paste Engine)...`);

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

        // Grant full clipboard permissions so Chrome allows writing and reading images
        const context = browser.defaultBrowserContext();
        await context.overridePermissions('https://translate.google.co.in', [
            'clipboard-read',
            'clipboard-write',
            'clipboard-sanitized-write'
        ]);
    } catch (launchErr) {
        console.error('[GoogleTranslate] Failed to launch Chrome:', launchErr.message);
        return imageList.map(img => ({ original: img, translated: false }));
    }

    const queue = imageList.map((img, idx) => ({ img, originalIdx: idx }));
    const allResults = new Array(imageList.length);

    // Initialize 5 worker tabs
    const workers = [];
    for (let w = 0; w < NUM_WORKERS; w++) {
        const page = await browser.newPage();
        workers.push({ id: w + 1, page });
    }

    console.log(`[GoogleTranslate] All ${NUM_WORKERS} parallel tabs ready with clipboard permissions.`);

    async function processQueue(worker) {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;

            const { img: imgInput, originalIdx } = item;
            const imgStart = Date.now();
            console.log(`[Tab ${worker.id}] Processing image [${originalIdx + 1}/${imageList.length}]: ${imgInput}`);

            try {
                const ext = (path.extname(imgInput.split('?')[0]) || '').toLowerCase();
                if (ext === '.gif' || ext === '.svg' || ext === '.mp4') {
                    console.log(`[Tab ${worker.id}] Image [${originalIdx + 1}] is ${ext} - preserving original.`);
                    allResults[originalIdx] = { original: imgInput, translated: false };
                    continue;
                }

                // Stagger tabs slightly
                if (worker.id > 1) {
                    await new Promise(r => setTimeout(r, (worker.id - 1) * 300));
                }

                // Step 1: Fresh Google Translate session
                await worker.page.goto('https://translate.google.co.in/?sl=auto&tl=en&op=images', {
                    waitUntil: 'networkidle2',
                    timeout: 35000
                });

                // Ensure Google Translate is in Images mode
                await worker.page.evaluate(() => {
                    if (!window.location.href.includes('op=images')) {
                        const imgBtn = Array.from(document.querySelectorAll('button, a')).find(b => {
                            const t = (b.innerText || '').toLowerCase();
                            return t === 'images' || t.includes('bilder') || t.includes('images');
                        });
                        if (imgBtn) imgBtn.click();
                    }
                });

                // Step 2: 2s WARM-UP DELAY
                await new Promise(r => setTimeout(r, 2000));

                // Step 3: COPY THE ACTUAL IMAGE TO CLIPBOARD IN-MEMORY
                console.log(`[Tab ${worker.id}] Copying image bitmap to clipboard...`);
                let cleanUrl = imgInput.trim();
                if (cleanUrl.startsWith('//')) cleanUrl = 'https:' + cleanUrl;

                const copyResult = await worker.page.evaluate(async (url) => {
                    try {
                        const resp = await fetch(url);
                        const blob = await resp.blob();

                        // Draw on canvas to create pristine PNG image for clipboard
                        const bmp = await createImageBitmap(blob);
                        const canvas = document.createElement('canvas');
                        canvas.width = bmp.width;
                        canvas.height = bmp.height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(bmp, 0, 0);

                        const pngBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
                        const clipItem = new ClipboardItem({ 'image/png': pngBlob });
                        await navigator.clipboard.write([clipItem]);
                        return { success: true, width: bmp.width, height: bmp.height };
                    } catch (e) {
                        return { success: false, error: e.message };
                    }
                }, cleanUrl);

                if (!copyResult.success) {
                    console.warn(`[Tab ${worker.id}] Clipboard copy warning:`, copyResult.error);
                }

                // Step 4: CLICK GOOGLE TRANSLATE'S "PASTE FROM CLIPBOARD" BUTTON
                console.log(`[Tab ${worker.id}] Clicking "Paste from clipboard" button...`);
                await worker.page.evaluate(() => {
                    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').toLowerCase().includes('paste from clipboard'));
                    if (btn) btn.click();
                });

                // Step 5: Wait for translation
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
                    // Step 6: 2s CANVAS SETTLE DELAY
                    await new Promise(r => setTimeout(r, 2000));

                    // Hook URL.createObjectURL BEFORE clicking download
                    await worker.page.evaluate(() => {
                        window._capturedBlobUrl = null;
                        const origCreate = URL.createObjectURL;
                        URL.createObjectURL = function(blob) {
                            const u = origCreate.call(URL, blob);
                            window._capturedBlobUrl = u;
                            return u;
                        };
                    });

                    // Trigger download to capture translated blob in RAM
                    await worker.page.evaluate(() => {
                        const dlBtn = Array.from(document.querySelectorAll('button, a')).find(b => {
                            const a = (b.getAttribute('aria-label') || '').toLowerCase();
                            const t = (b.innerText || '').toLowerCase();
                            return a.includes('download') || t.includes('download');
                        });
                        if (dlBtn) dlBtn.click();
                    });

                    await new Promise(r => setTimeout(r, 600));

                    // Read translated blob from RAM
                    const base64Data = await worker.page.evaluate(async () => {
                        if (!window._capturedBlobUrl) return null;
                        try {
                            const resp = await fetch(window._capturedBlobUrl);
                            const blob = await resp.blob();
                            return new Promise(resolve => {
                                const reader = new FileReader();
                                reader.onloadend = () => resolve(reader.result);
                                reader.readAsDataURL(blob);
                            });
                        } catch (e) {
                            return null;
                        }
                    });

                    const filename = `translated-${Date.now()}-${uuidv4().substring(0, 8)}.png`;
                    const targetFile = path.join(uploadsDir, filename);

                    if (base64Data) {
                        const rawB64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
                        fs.writeFileSync(targetFile, Buffer.from(rawB64, 'base64'));

                        const publicPath = `/uploads/${filename}`;
                        console.log(`[Tab ${worker.id}] >> SUCCESS (RAM EXTRACTED): Image [${originalIdx + 1}] translated in ${((Date.now() - imgStart) / 1000).toFixed(1)}s -> ${publicPath} (${fs.statSync(targetFile).size} bytes)`);

                        allResults[originalIdx] = {
                            original: imgInput,
                            translated: true,
                            translatedUrl: publicPath
                        };
                    } else {
                        // Element screenshot fallback
                        const imgEl = await worker.page.$('img[src^="blob:"]');
                        if (imgEl) {
                            await imgEl.screenshot({ path: targetFile });
                            const publicPath = `/uploads/${filename}`;
                            console.log(`[Tab ${worker.id}] >> SUCCESS (SCREENSHOT EXTRACTED): Image [${originalIdx + 1}] translated -> ${publicPath}`);

                            allResults[originalIdx] = {
                                original: imgInput,
                                translated: true,
                                translatedUrl: publicPath
                            };
                        } else {
                            allResults[originalIdx] = { original: imgInput, translated: false };
                        }
                    }
                } else {
                    allResults[originalIdx] = { original: imgInput, translated: false };
                }
            } catch (err) {
                console.error(`[Tab ${worker.id}] Error on image [${originalIdx + 1}]:`, err.message);
                allResults[originalIdx] = { original: imgInput, translated: false };
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
