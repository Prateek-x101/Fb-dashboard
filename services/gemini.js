const fetch = require('node-fetch');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1';
const VISION_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-1.5-flash';
const OBSOLETE_MODELS = new Set();

function normalizeModel(model) {
    return !model || OBSOLETE_MODELS.has(model) ? DEFAULT_MODEL : model;
}

const geminiService = {
    async generateAdCopy(apiKey, model, websiteUrl, websiteContent, productName) {
        const url = `${BASE_URL}/models/${normalizeModel(model)}:generateContent?key=${apiKey}`;
        const prompt = `You are an expert Facebook ad copywriter.
Create one Facebook ad copy for this product.

Product name: ${productName || 'the product'}
Website URL: ${websiteUrl}
Website information:
${websiteContent}

Return ONLY valid JSON in this exact shape:
{"headline":"Product name or a short product-focused headline","primaryText":"...","description":"Short supporting description"}

Primary text rules:
- Start with a strong benefit-led hook mentioning the product.
- Use this structure: an opening sentence, a short benefit paragraph, exactly 4 lines beginning with ✔️, a use-cases sentence, a short punchy closing line, and a final CTA sentence.
- Keep the tone premium, clear.
- Use a few relevant emojis, but do not overdo them.
- Put the exact website URL as the final line by itself.
- Do not use markdown headings, bullets other than the four ✔️ lines, or placeholder text.
- Do not invent product claims that are not supported by the website information.`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error ? data.error.message : 'Unknown Gemini API Error');
        }

        try {
            const rawText = data.candidates[0].content.parts[0].text.trim();
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON object in response');
            const result = JSON.parse(jsonMatch[0]);
            if (!result.primaryText) throw new Error('Primary text missing');
            return {
                headline: String(productName || result.headline || '').trim(),
                primaryText: String(result.primaryText).trim(),
                description: ''
            };
        } catch (error) {
            throw new Error('Failed to parse Gemini ad copy response: ' + error.message);
        }
    },

    async generateVariations(apiKey, model, baseText, count) {
        const url = `${BASE_URL}/models/${normalizeModel(model)}:generateContent?key=${apiKey}`;
        
        const prompt = `You are an expert Facebook ad copywriter. Create ${count} unique variations of the following ad primary text.
 
Rules:
- Keep ALL URLs exactly as they appear — do not modify, shorten, or remove any links.
- Keep the checkmarks (✔️) list structure for the benefits section.
- Incorporate relevant emojis to make each variation visually distinct and engaging.
- Vary the opening line (hook), the description style, and the closing call-to-action to give each variation a fresh and unique feel.
- Maintain the core product details and specifications.
- Return ONLY the variations, separated strictly by "|||". Do not include any numbering, intro, or outro text.
 
Base text:
${baseText}`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });
        
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error ? data.error.message : 'Unknown Gemini API Error');
        }
        
        try {
            const rawText = data.candidates[0].content.parts[0].text;
            const variations = rawText.split('|||').map(v => v.trim()).filter(v => v);
            return variations.slice(0, count);
        } catch (error) {
            throw new Error('Failed to parse Gemini response');
        }
    },

    async generateAudiences(apiKey, model, websiteContent, numAudiences, alreadyUsedKeywords) {
        const url = `${BASE_URL}/models/${normalizeModel(model)}:generateContent?key=${apiKey}`;
        const audienceCount = Math.max(3, Number.parseInt(numAudiences, 10) || 3);

        const usedList = alreadyUsedKeywords && alreadyUsedKeywords.length > 0
            ? `\nKeywords already used in other audiences — DO NOT repeat any of these: ${alreadyUsedKeywords.join(', ')}`
            : '';

        const prompt = `You are a Facebook Ads targeting expert. Study the product information below carefully — understand the product category, materials, use cases, price point, and likely buyer — then generate ${audienceCount} DISTINCT audience segments.

PRODUCT INFORMATION:
${websiteContent}
${usedList}

STRICT RULES:

1. KEYWORD FORMAT — keywords must be SHORT (1–4 words max), exactly as they appear in Facebook Ads Manager search. Wrong: "Frequent online fashion shoppers". Right: "Online shopping", "Fast fashion", "Women's clothing". Wrong: "People who travel internationally". Right: "International travel", "Frequent travelers".

2. KEYWORD RELEVANCE — every single keyword inside an audience must directly relate to that audience's theme AND to the product. If the audience is "Women's Fashion Shoppers", every keyword must be about women's fashion or shopping. Never add unrelated fillers.

3. KEYWORD TYPES — use these types, mixed within each audience (at least 3 different types):
   • "interest"       — Facebook interest pages/topics: "Online shopping", "Yoga", "Luxury goods"
   • "behavior"       — FB purchase/device behaviors: "Online shoppers", "Engaged shoppers", "Small business owners"
   • "demographic"    — life stage/relationship: "Parents", "Newly engaged", "New homeowners", "Millennials"
   • "life_event"     — major milestones: "Newly married", "Recently moved", "New job", "New baby"
   • "job_title"      — specific job roles: "Fashion designer", "Marketing Manager", "Software Engineer"
   • "employer"       — specific companies: "Google", "Infosys", "Amazon", "TCS"
   • "field_of_study" — academic subjects as on Facebook: "Computer Science", "Fashion Design", "Marketing"
   • "school"         — university/institution names as on Facebook: "IIT Delhi", "Delhi University"

4. COVERAGE — 5 to 8 keywords per audience, drawn from at least 3 different types.

5. NO DUPLICATES — no keyword may appear in more than one audience across all ${audienceCount} audiences.

6. REAL FACEBOOK KEYWORDS ONLY — use common, well-known FB interest names. Prefer single-word or two-word keywords when possible ("Clothing", "Leggings", "Yoga", "Travel", "Lingerie"). Avoid inventing phrases.

7. Return ONLY valid JSON — no markdown, no extra text.
   Format: [{"audienceName":"Short label","targeting":[{"type":"interest|behavior|demographic|life_event|job_title|employer|field_of_study|school","name":"keyword"},...]},...]`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                }),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error ? data.error.message : 'Unknown Gemini API Error');
        }

        try {
            const rawText = data.candidates[0].content.parts[0].text;
            const jsonMatch = rawText.match(/\[[\s\S]*\]/);
            if (!jsonMatch) throw new Error('No JSON array in response');
            const audiences = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(audiences) || audiences.length < 3) {
                throw new Error(`Gemini returned ${audiences?.length || 0} audiences; at least 3 are required.`);
            }
            return audiences.slice(0, audienceCount);
        } catch (error) {
            throw new Error('Failed to parse Gemini audience response: ' + error.message);
        }
    },

    async generateResponseText(apiKey, model, prompt) {
        const url = `${BASE_URL}/models/${normalizeModel(model)}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error ? data.error.message : 'Unknown Gemini API Error');
        }
        return data.candidates[0].content.parts[0].text;
    },

    // Analyze video frames with Gemini Vision: pick best product images + generate listing
    async analyzeProductFromFrames(apiKey, model, framesBase64) {
        const url = `${VISION_BASE_URL}/models/${normalizeModel(model)}:generateContent?key=${apiKey}`;

        const parts = [
            {
                text: `You are a professional e-commerce product analyst. You will receive ${framesBase64.length} product images (extracted from video frames or uploaded directly).

Your tasks:
1. Select the best product images — choose images that clearly show the product, are sharp/in-focus, well-lit, and show different useful angles. Skip blurry, motion-blurred, text-only, or near-duplicate frames. Select 4 to 10 images max.
2. Detect product attributes visible in the images (colors, designs, styles, patterns, etc.) — these will be used to suggest product variants.
3. Generate a Shopify product listing from those images.

CRITICAL — The description HTML MUST follow this EXACT format and structure (use this as a template):

<p><span style="color: #e67e23;"><strong>FEATURES</strong></span></p>
<p><strong>FEATURE NAME 1</strong> - Detailed description of this feature and its benefit to the customer.</p>
<p><strong>FEATURE NAME 2</strong> - Detailed description of this feature and its benefit to the customer.</p>
<p><strong>FEATURE NAME 3</strong> - Detailed description of this feature and its benefit to the customer.</p>
<p><strong>FEATURE NAME 4</strong> - Detailed description of this feature and its benefit to the customer.</p>
<p><strong>FEATURE NAME 5</strong> - Detailed description of this feature and its benefit to the customer.</p>
<p><span style="color: #e67e23;"><strong>SPEC</strong></span></p>
<p>Color: [detected colors]</p>
<p>Size: [if applicable, e.g. S-2XL or One Size]</p>
<p>Material: [material if visible]</p>
<p><span style="color: #e67e23;"><strong>PACKAGE INCLUDES</strong></span></p>
<p>1 x [Product Name]</p>
<p><span style="color: #e67e23;"><strong>NOTES</strong></span></p>
<p>Color may not appear exactly as in real life due to variations between computer monitors.</p>
<p>Please allow a small error due to manual measurement. Please make sure you do not mind before purchasing.</p>

Rules:
- Section headers use: <span style="color: #e67e23;"><strong>HEADER</strong></span>
- Feature names use <strong>ALL CAPS NAME</strong> followed by " - " then the description
- Write 4-6 strong, benefit-led feature paragraphs based on what you see in the product images
- Fill SPEC section based on what you can see (colors, materials, style)
- Keep NOTES section exactly as shown

For detectedAttributes: analyze all images and identify the distinct visual variants present.
- If you see multiple colors (e.g., red dress, blue dress, green dress), list them as a "Color" attribute.
- If you see multiple designs/patterns, list them as a "Design" attribute.
- If you see size markings or multiple sizes, list as "Size" attribute.
- Only include attributes that are ACTUALLY VISIBLE in the images. Do not invent attributes.
- Each attribute should have a name and an array of values you can actually see/detect.
- Also suggest any additional common variant types for this product category that users may want to add (e.g., for clothing suggest Size even if not visible).

Return ONLY valid JSON (no markdown, no backticks):
{
  "selectedIndices": [0, 2, 5],
  "title": "Product title (clear, 3-7 words, no promotional fluff)",
  "description": "<p><span style=\\"color: #e67e23;\\"><strong>FEATURES</strong></span></p>...",
  "tags": ["tag1", "tag2", "tag3"],
  "suggestedPrice": "29.99",
  "detectedAttributes": [
    {"name": "Color", "values": ["Red", "Blue", "Green"], "detected": true},
    {"name": "Size", "values": ["S", "M", "L", "XL"], "detected": false, "suggestion": true}
  ]
}`
            }
        ];

        for (const b64 of framesBase64) {
            parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts }] })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ? data.error.message : 'Gemini Vision API Error');

        const rawText = data.candidates[0].content.parts[0].text.trim();
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in Gemini Vision response');
        const result = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(result.selectedIndices)) result.selectedIndices = [];
        return result;
    },

    // Convert scraped e-commerce page text (Amazon, Alibaba, etc.) into structured Shopify listing
    async analyzeProductFromScrapedText(apiKey, model, scrapedText) {
        const url = `${BASE_URL}/models/${normalizeModel(model)}:generateContent?key=${apiKey}`;
        
        const prompt = `You are a professional e-commerce product manager. You will receive scraped text from an external product page (like Amazon, Alibaba, or any other web store).
        
Your task: Convert this messy product information into a clean, professional Shopify listing structure.

CRITICAL - The product description HTML MUST follow this EXACT format and structure (use this as a template):

<p><span style="color: #e67e23;"><strong>FEATURES</strong></span></p>
<p><strong>FEATURE NAME 1</strong> - Detailed description of this feature and its benefit to the customer.</p>
<p><strong>FEATURE NAME 2</strong> - Detailed description of this feature and its benefit to the customer.</p>
<p><strong>FEATURE NAME 3</strong> - Detailed description of this feature and its benefit to the customer.</p>
<p><strong>FEATURE NAME 4</strong> - Detailed description of this feature and its benefit to the customer.</p>
<p><strong>FEATURE NAME 5</strong> - Detailed description of this feature and its benefit to the customer.</p>
<p><span style="color: #e67e23;"><strong>SPEC</strong></span></p>
<p>Color: [detected colors]</p>
<p>Size: [if applicable, e.g. S-2XL or One Size]</p>
<p>Material: [material if visible/known]</p>
<p><span style="color: #e67e23;"><strong>PACKAGE INCLUDES</strong></span></p>
<p>1 x [Product Name]</p>
<p><span style="color: #e67e23;"><strong>NOTES</strong></span></p>
<p>Color may not appear exactly as in real life due to variations between computer monitors.</p>
<p>Please allow a small error due to manual measurement. Please make sure you do not mind before purchasing.</p>

Rules for description:
- Section headers use: <span style="color: #e67e23;"><strong>HEADER</strong></span>
- Feature names use <strong>ALL CAPS NAME</strong> followed by " - " then the description
- Extract 4-6 strong, benefit-led feature paragraphs based on the product description
- Keep NOTES section exactly as shown

Format for variants and options:
- Identify if there are variants (e.g. Size, Color, Style).
- List options with name (e.g., "Color") and array of values.
- List variants with title, price (extract or suggest a clean decimal price like 29.99), compare_at_price (original price if discounted, otherwise empty), option1, option2 (if multi-attribute), and sku.

Scraped text data:
"""
${scrapedText}
"""

Return ONLY valid JSON (no markdown, no backticks, no comments):
{
  "title": "Clean product title (3-7 words, no promotional fluff)",
  "description": "<p><span style=\\"color: #e67e23;\\"><strong>FEATURES</strong></span></p>...",
  "vendor": "Clean brand/vendor name or empty string",
  "type": "Product category/type",
  "tags": ["tag1", "tag2", "tag3"],
  "suggestedPrice": "Suggested Retail Price (e.g. 29.99)",
  "options": [
    {"name": "Color", "values": ["Red", "Blue"]}
  ],
  "variants": [
    {"title": "Red", "price": "29.99", "compare_at_price": "39.99", "option1": "Red", "sku": "red-sku"}
  ]
}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error ? data.error.message : 'Gemini Text API Error');

        const rawText = data.candidates[0].content.parts[0].text.trim();
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in Gemini response');
        return JSON.parse(jsonMatch[0]);
    },

    // Use Gemini Vision to assign each selected image to the most visually matching variant value
    async assignImagesToVariants(apiKey, model, framesBase64, variantOption, variantValues) {
        const url = `${VISION_BASE_URL}/models/${normalizeModel(model)}:generateContent?key=${apiKey}`;

        const parts = [
            {
                text: `You are a product image classifier. You will receive ${framesBase64.length} product images (0-indexed).

The product has a variant option called "${variantOption}" with these possible values: ${variantValues.join(', ')}.

For EACH image, determine which variant value it most likely represents based on visual characteristics (color, style, design, pattern, etc.). If an image is ambiguous, assign it to the closest matching value.

Return ONLY valid JSON (no markdown, no backticks):
{
  "assignments": {"0": "${variantValues[0]}", "1": "${variantValues[1] || variantValues[0]}"}
}

Keys are image indices as strings. Every index from 0 to ${framesBase64.length - 1} must appear. Values must be one of: ${variantValues.join(', ')}`
            }
        ];

        for (const b64 of framesBase64) {
            parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts }] })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ? data.error.message : 'Gemini Vision API Error');

        const rawText = data.candidates[0].content.parts[0].text.trim();
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in Gemini Vision response');
        return JSON.parse(jsonMatch[0]);
    },

    async testConnection(apiKey, model) {
        const url = `${BASE_URL}/models/${normalizeModel(model)}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: 'Hello' }] }]
            })
        });
        
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error ? data.error.message : 'Unknown Gemini API Error');
        }
        return true;
    }
};

function validateAdCopy(primaryText, websiteUrl) {
    const lines = String(primaryText)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    const benefitLines = lines.filter(line => line.startsWith('✔️'));

    if (benefitLines.length !== 4) {
        throw new Error('Gemini returned invalid copy: expected exactly four ✔️ benefit lines.');
    }
    if (lines.length < 8 || lines[lines.length - 1] !== websiteUrl.trim()) {
        throw new Error('Gemini returned invalid copy: the exact website URL must be the final line.');
    }
}

module.exports = geminiService;
