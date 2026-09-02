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
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                timeout: 25000
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
 * Native Google Translate (Google Lens) Automated Translation
 * Renders exactly like official Google Translate with font matching and texture inpainting.
 */
async function translateViaGoogleTranslate(tempInputPath) {
    console.log('[ImageTranslator] Attempting Native Google Translate (Google Lens)...');
    return await browserPool.withTab(async (page) => {
        await page.goto('https://translate.google.com/?sl=auto&tl=en&op=images', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // Handle possible Google consent dialogs
        try {
            const buttons = await page.$$('button');
            for (const btn of buttons) {
                const text = await page.evaluate(el => el.innerText, btn);
                if (text && /accept all|agree|i agree|alle akzeptieren|zustimmen/i.test(text)) {
                    await btn.click();
                    await new Promise(r => setTimeout(r, 1000));
                    break;
                }
            }
        } catch (e) {}

        const fileInput = await page.$('input[type="file"]');
        if (!fileInput) throw new Error('Google Translate file input not found');

        await fileInput.uploadFile(tempInputPath);

        // Wait for translated result image blob
        await page.waitForFunction(() => {
            const img = Array.from(document.querySelectorAll('img')).find(i => i.src && i.src.startsWith('blob:'));
            const downloadBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText && /download/i.test(b.innerText));
            return img || downloadBtn;
        }, { timeout: 35000 });

        // Extract blob data directly as base64
        const base64 = await page.evaluate(async () => {
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

        if (!base64) throw new Error('Could not extract translated blob image from Google Translate');
        const cleanBase64 = base64.replace(/^data:image\/\w+;base64,/, '');
        return Buffer.from(cleanBase64, 'base64');
    }, { blockImages: false, timeout: 60000 });
}

/**
 * Calls Gemini Vision API to detect foreign text bounding boxes and their English translations (Fallback).
 */
async function detectAndTranslateText(imageBuffer, mimeType, apiKey, model = 'gemini-2.5-flash') {
    const base64Data = imageBuffer.toString('base64');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const prompt = `You are a high-precision OCR and visual e-commerce translator.
Analyze this product image, infographic, size chart, banner, or diagram.
Detect ALL text in non-English languages (such as Chinese, Japanese, Korean, Russian, Turkish, German, French, Spanish, Vietnamese, etc.) that should be translated into English for an English e-commerce store.

For each distinct foreign text line or block:
1. "box_2d": [ymin, xmin, ymax, xmax] - normalized coordinates in 0-1000 integer range.
2. "original_text": original foreign text detected.
3. "translated_text": accurate, natural English translation (concise for badges/tables).
4. "text_color": hex code of the text color (e.g. "#FFFFFF", "#111827", "#E11D48").
5. "bg_color": dominant solid or estimated background color behind this text (hex code, e.g. "#FFFFFF", "#F3F4F6", "#000000").
6. "font_weight": "normal" | "bold" | "600".
7. "text_align": "center" | "left" | "right".

CRITICAL RULES:
- If the image contains NO non-English text or no text at all, return:
  { "has_foreign_text": false, "text_blocks": [] }
- For size charts and tables, detect each header and cell accurately so labels like "胸围" -> "Bust", "衣长" -> "Length", "肩宽" -> "Shoulder", "袖长" -> "Sleeve", "腰围" -> "Waist", "尺码" -> "Size", "建议体重" -> "Weight" are translated.
- Return ONLY valid JSON adhering to the specified schema. Do not add markdown backticks outside of JSON.`;

    const requestBody = {
        contents: [
            {
                parts: [
                    {
                        text: prompt
                    },
                    {
                        inline_data: {
                            mime_type: mimeType,
                            data: base64Data
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json"
        }
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        timeout: 45000
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini Vision API error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    if (!candidate || !candidate.content?.parts?.[0]?.text) {
        throw new Error('Gemini did not return any OCR result.');
    }

    const rawText = candidate.content.parts[0].text.trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error('Could not parse JSON from Gemini OCR response.');
    }

    return JSON.parse(jsonMatch[0]);
}

/**
 * Renders the translated image using Puppeteer (Fallback renderer):
 */
async function renderTranslatedImage(imageBuffer, mimeType, ext, textBlocks) {
    const base64Data = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

    return await browserPool.withTab(async (page) => {
        const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    #stage {
        position: relative;
        display: inline-block;
        line-height: 0;
    }
    #bg-img {
        display: block;
        max-width: none;
    }
    .text-patch {
        position: absolute;
        display: flex;
        align-items: center;
        overflow: hidden;
        word-break: break-word;
        line-height: 1.15;
        border-radius: 2px;
        box-shadow: 0 0 1px rgba(0,0,0,0.05);
        z-index: 10;
    }
    .text-content {
        width: 100%;
        display: block;
    }
</style>
</head>
<body>
    <div id="stage">
        <img id="bg-img" src="${base64Data}" />
        ${textBlocks.map((block, i) => {
            const [ymin, xmin, ymax, xmax] = block.box_2d || [0, 0, 0, 0];
            const topPct = (ymin / 10).toFixed(2);
            const leftPct = (xmin / 10).toFixed(2);
            const widthPct = ((xmax - xmin) / 10).toFixed(2);
            const heightPct = ((ymax - ymin) / 10).toFixed(2);
            
            const bgColor = block.bg_color || '#FFFFFF';
            const textColor = block.text_color || '#111827';
            const fontWeight = block.font_weight || 'normal';
            const textAlign = block.text_align || 'center';
            const justify = textAlign === 'left' ? 'flex-start' : textAlign === 'right' ? 'flex-end' : 'center';

            return `
            <div class="text-patch" id="patch-${i}" style="
                top: ${topPct}%;
                left: ${leftPct}%;
                width: ${widthPct}%;
                height: ${heightPct}%;
                background-color: ${bgColor};
                color: ${textColor};
                font-weight: ${fontWeight};
                justify-content: ${justify};
                text-align: ${textAlign};
            ">
                <span class="text-content" style="padding: 1px 2px;">${escapeHtml(block.translated_text || '')}</span>
            </div>`;
        }).join('')}
    </div>

    <script>
        window.fitAllText = function() {
            const patches = document.querySelectorAll('.text-patch');
            patches.forEach(patch => {
                const content = patch.querySelector('.text-content');
                if (!content) return;
                
                const boxH = patch.clientHeight;
                const boxW = patch.clientWidth;
                if (boxH <= 0 || boxW <= 0) return;

                let fontSize = Math.max(8, Math.floor(boxH * 0.72));
                content.style.fontSize = fontSize + 'px';

                while ((content.scrollHeight > boxH || content.scrollWidth > boxW) && fontSize > 7) {
                    fontSize -= 1;
                    content.style.fontSize = fontSize + 'px';
                }
            });
        };
    </script>
</body>
</html>`;

        await page.setContent(html, { waitUntil: 'load' });

        const dimensions = await page.evaluate(async () => {
            const img = document.getElementById('bg-img');
            if (!img.complete) {
                await new Promise(r => img.onload = r);
            }
            window.fitAllText();
            return {
                width: img.naturalWidth || img.clientWidth,
                height: img.naturalHeight || img.clientHeight
            };
        });

        if (!dimensions.width || !dimensions.height) {
            throw new Error('Failed to retrieve image natural dimensions.');
        }

        await page.setViewport({
            width: dimensions.width,
            height: dimensions.height,
            deviceScaleFactor: 1
        });

        await page.evaluate(() => window.fitAllText());

        const stage = await page.$('#stage');
        const screenshotBuffer = await stage.screenshot({
            type: ext === 'png' ? 'png' : 'jpeg',
            quality: ext === 'png' ? undefined : 92
        });

        return screenshotBuffer;
    }, { blockImages: false, timeout: 60000 });
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Main Translate Image Function:
 * 1. Checks if image has foreign text.
 * 2. If foreign text exists, translates via Native Google Translate (Google Lens) for 100% professional pixel-quality.
 * 3. Falls back to Gemini Vision OCR + Inpainting if Google Translate encounters issues.
 */
async function translateImage(imageInput, apiKey, model = 'gemini-2.5-flash') {
    console.log(`[ImageTranslator] Processing image for translation: ${typeof imageInput === 'string' ? imageInput.substring(0, 100) : 'Buffer'}`);

    const { buffer: originalBuffer, mimeType, ext } = await getImageBuffer(imageInput);

    // Save temporary local file for upload
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const tempName = `temp-trans-${Date.now()}-${uuidv4().substring(0, 6)}.${ext === 'png' ? 'png' : 'jpg'}`;
    const tempPath = path.join(uploadsDir, tempName);
    fs.writeFileSync(tempPath, originalBuffer);

    let renderedBuffer = null;
    let methodUsed = 'google-lens';

    try {
        // Step 1: Try Native Google Translate (Google Lens) for 100% professional typography & inpainting
        renderedBuffer = await translateViaGoogleTranslate(tempPath);
        console.log(`[ImageTranslator] Successfully translated via Native Google Translate (Google Lens)!`);
    } catch (googleErr) {
        console.warn(`[ImageTranslator] Google Translate attempt failed (${googleErr.message}). Falling back to Gemini Vision...`);
        
        if (apiKey) {
            try {
                methodUsed = 'gemini-fallback';
                const ocrResult = await detectAndTranslateText(originalBuffer, mimeType, apiKey, model);
                if (ocrResult.has_foreign_text && Array.isArray(ocrResult.text_blocks) && ocrResult.text_blocks.length > 0) {
                    renderedBuffer = await renderTranslatedImage(originalBuffer, mimeType, ext, ocrResult.text_blocks);
                }
            } catch (geminiErr) {
                console.error(`[ImageTranslator] Gemini fallback error:`, geminiErr.message);
            }
        }
    } finally {
        if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch {}
        }
    }

    if (!renderedBuffer) {
        console.log(`[ImageTranslator] No foreign text translated / image returned.`);
        return {
            translated: false,
            originalUrl: typeof imageInput === 'string' ? imageInput : null,
            textBlocksCount: 0
        };
    }

    const filename = `translated-${Date.now()}-${uuidv4().substring(0, 8)}.${ext === 'png' ? 'png' : 'jpg'}`;
    const targetFile = path.join(uploadsDir, filename);
    fs.writeFileSync(targetFile, renderedBuffer);

    const publicPath = `/uploads/${filename}`;
    console.log(`[ImageTranslator] Translated image saved at: ${publicPath} (Engine: ${methodUsed})`);

    return {
        translated: true,
        originalUrl: typeof imageInput === 'string' ? imageInput : null,
        translatedUrl: publicPath,
        engine: methodUsed
    };
}

module.exports = {
    translateImage,
    getImageBuffer,
    translateViaGoogleTranslate,
    detectAndTranslateText,
    renderTranslatedImage
};
