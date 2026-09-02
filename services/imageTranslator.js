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
 * Direct Google Translate Image Translation via Puppeteer
 * Navigates to https://translate.google.co.in/?sl=auto&tl=en&op=images and uploads the image.
 */
async function translateViaGoogleTranslate(tempInputPath) {
    console.log('[GoogleTranslate] Opening https://translate.google.co.in/?sl=auto&tl=en&op=images...');
    return await browserPool.withTab(async (page) => {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8'
        });

        // Stealth override
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

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
                    await new Promise(r => setTimeout(r, 800));
                    break;
                }
            }
        } catch (e) {}

        const fileInput = await page.$('input[type="file"]');
        if (!fileInput) {
            throw new Error('File input not found on Google Translate page');
        }

        console.log('[GoogleTranslate] Uploading image file to Google Translate...');
        await fileInput.uploadFile(tempInputPath);

        // Wait for translated image or download button
        await page.waitForFunction(() => {
            const img = Array.from(document.querySelectorAll('img')).find(i => i.src && i.src.startsWith('blob:'));
            const downloadBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText && /download/i.test(b.innerText));
            return img || downloadBtn;
        }, { timeout: 30000 });

        console.log('[GoogleTranslate] Translation ready! Extracting image blob...');
        const base64Data = await page.evaluate(async () => {
            const img = Array.from(document.querySelectorAll('img')).find(i => i.src && i.src.startsWith('blob:'));
            if (!img) return null;
            const blobUrl = img.src;
            const resp = await fetch(blobUrl);
            const blob = await resp.blob();
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
            });
        });

        if (!base64Data) {
            throw new Error('Could not extract blob from Google Translate result');
        }

        const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
        return Buffer.from(cleanBase64, 'base64');
    }, { blockImages: false, timeout: 50000 });
}

/**
 * Main Translate Image Function:
 * Translates one image using Google Translate Image (https://translate.google.co.in/?sl=auto&tl=en&op=images)
 */
async function translateImage(imageInput, apiKey, model = 'gemini-2.5-flash') {
    console.log(`[ImageTranslator] Processing image: ${typeof imageInput === 'string' ? imageInput.substring(0, 100) : 'Buffer'}`);

    const { buffer: originalBuffer, mimeType, ext } = await getImageBuffer(imageInput);

    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const tempName = `temp-trans-${Date.now()}-${uuidv4().substring(0, 6)}.${ext === 'png' ? 'png' : 'jpg'}`;
    const tempPath = path.join(uploadsDir, tempName);
    fs.writeFileSync(tempPath, originalBuffer);

    let renderedBuffer = null;

    try {
        renderedBuffer = await translateViaGoogleTranslate(tempPath);
        console.log(`[ImageTranslator] Successfully translated via Google Translate!`);
    } catch (err) {
        console.warn(`[ImageTranslator] Google Translate failed: ${err.message}`);
    } finally {
        if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch {}
        }
    }

    if (!renderedBuffer) {
        return {
            translated: false,
            originalUrl: typeof imageInput === 'string' ? imageInput : null
        };
    }

    const filename = `translated-${Date.now()}-${uuidv4().substring(0, 8)}.${ext === 'png' ? 'png' : 'jpg'}`;
    const targetFile = path.join(uploadsDir, filename);
    fs.writeFileSync(targetFile, renderedBuffer);

    const publicPath = `/uploads/${filename}`;
    console.log(`[ImageTranslator] Saved translated image at: ${publicPath}`);

    return {
        translated: true,
        originalUrl: typeof imageInput === 'string' ? imageInput : null,
        translatedUrl: publicPath
    };
}

module.exports = {
    translateImage,
    getImageBuffer,
    translateViaGoogleTranslate
};
