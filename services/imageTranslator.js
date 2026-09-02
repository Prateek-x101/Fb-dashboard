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
                timeout: 15000
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
 * Calls Gemini Vision API to detect foreign text bounding boxes and their English translations.
 */
async function detectAndTranslateText(imageBuffer, mimeType, apiKey, model = 'gemini-2.5-flash') {
    const base64Data = imageBuffer.toString('base64');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const prompt = `You are an expert e-commerce image translator & graphic designer.
Analyze this product image, infographic, size chart, diagram, or banner.
Detect ALL text in foreign languages (German, Chinese, Turkish, French, Spanish, Japanese, Korean, Russian, Italian, Vietnamese, etc.) that must be translated into clean English for an international Shopify store.

For each distinct foreign text line or block:
1. "box_2d": [ymin, xmin, ymax, xmax] - normalized coordinates in 0-1000 integer range. Make sure the box covers the text completely with small margin.
2. "original_text": the foreign text.
3. "translated_text": professional, accurate, standard e-commerce English translation.
4. "text_color": exact hex color of the text (e.g. "#FFFFFF", "#1B3B2B", "#111827", "#E11D48").
5. "bg_color": dominant background color behind this text (hex code, e.g. "#1B3B2B", "#EAEFEA", "#FFFFFF", "#F3F4F6").
6. "font_weight": "bold" | "600" | "500" | "normal".
7. "text_align": "center" | "left" | "right".

CRITICAL RULES:
- If the image contains NO non-English text or no text at all, return:
  { "has_foreign_text": false, "text_blocks": [] }
- For size charts and tables, translate table headers cleanly: "Größentabelle" -> "Size Chart", "Brustumfang" -> "Bust", "Ärmel" -> "Sleeve", "Länge" -> "Length", "Schulter" -> "Shoulder", "Taille/Bund" -> "Waist", "Hüfte" -> "Hips".
- Return ONLY valid JSON adhering to the specified schema without backticks or extra text.`;

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
        timeout: 25000
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
 * Renders the translated image using Puppeteer with seamless edge-feathering, typography & clean blending:
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
        -webkit-font-smoothing: antialiased;
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
        z-index: 10;
        letter-spacing: -0.01em;
    }
    .text-content {
        width: 100%;
        display: block;
        transform: translateY(-0.5px);
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
                box-shadow: 0 0 4px 2px ${bgColor};
            ">
                <span class="text-content" style="padding: 0 3px;">${escapeHtml(block.translated_text || '')}</span>
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

                let fontSize = Math.max(9, Math.floor(boxH * 0.70));
                content.style.fontSize = fontSize + 'px';

                while ((content.scrollHeight > boxH || content.scrollWidth > boxW) && fontSize > 8) {
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
    }, { blockImages: false, timeout: 30000 });
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
 * Fast & Reliable AI Image Translation
 */
async function translateImage(imageInput, apiKey, model = 'gemini-2.5-flash') {
    if (!apiKey) {
        throw new Error('Gemini API key is required for image translation.');
    }

    const { buffer: originalBuffer, mimeType, ext } = await getImageBuffer(imageInput);

    // 1. Fast Multimodal Vision OCR & Translation
    const ocrResult = await detectAndTranslateText(originalBuffer, mimeType, apiKey, model);

    if (!ocrResult.has_foreign_text || !Array.isArray(ocrResult.text_blocks) || ocrResult.text_blocks.length === 0) {
        return {
            translated: false,
            originalUrl: typeof imageInput === 'string' ? imageInput : null,
            textBlocksCount: 0
        };
    }

    console.log(`[ImageTranslator] Detected ${ocrResult.text_blocks.length} foreign text blocks. Inpainting seamless overlay...`);

    // 2. Render Inpainted Image with Soft Blending
    const renderedBuffer = await renderTranslatedImage(originalBuffer, mimeType, ext, ocrResult.text_blocks);

    // 3. Save to /uploads/
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const filename = `translated-${Date.now()}-${uuidv4().substring(0, 8)}.${ext === 'png' ? 'png' : 'jpg'}`;
    const targetFile = path.join(uploadsDir, filename);
    fs.writeFileSync(targetFile, renderedBuffer);

    const publicPath = `/uploads/${filename}`;
    console.log(`[ImageTranslator] Successfully translated image saved at: ${publicPath}`);

    return {
        translated: true,
        originalUrl: typeof imageInput === 'string' ? imageInput : null,
        translatedUrl: publicPath,
        textBlocksCount: ocrResult.text_blocks.length
    };
}

module.exports = {
    translateImage,
    getImageBuffer,
    detectAndTranslateText,
    renderTranslatedImage
};
