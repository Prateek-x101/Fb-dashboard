const fetch = require('node-fetch');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.0-flash';
const OBSOLETE_MODELS = new Set(['gemini-2.5-flash', 'gemini-2.5-pro']);

function normalizeModel(model) {
    return !model || OBSOLETE_MODELS.has(model) ? DEFAULT_MODEL : model;
}

const geminiService = {
    async generateAdCopy(apiKey, model, websiteUrl, websiteContent, productName) {
        const url = `${BASE_URL}/models/${normalizeModel(model)}:generateContent?key=${apiKey}`;
        const prompt = `You are an expert Facebook fashion ad copywriter.

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
- Keep the tone premium, clear, and suitable for Indian fashion ecommerce.
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
            validateAdCopy(result.primaryText, websiteUrl);
            return {
                headline: String(result.headline || productName || '').trim(),
                primaryText: String(result.primaryText).trim(),
                description: String(result.description || '').trim()
            };
        } catch (error) {
            throw new Error('Failed to parse Gemini ad copy response: ' + error.message);
        }
    },

    async generateVariations(apiKey, model, baseText, count) {
        const url = `${BASE_URL}/models/${normalizeModel(model)}:generateContent?key=${apiKey}`;
        
        const prompt = `You are an expert Facebook ad copywriter. Create ${count} unique variations of the following ad primary text.

Rules:
- Keep ALL URLs exactly as they appear — do not modify, shorten, or remove any links
- Keep ALL emojis, checkmarks (✔️), and special characters
- Vary ONLY the hook (opening line), tone, and CTA (call-to-action) phrasing
- Maintain the same product details, features, and value propositions
- Each variation should feel fresh but carry the same message
- Return ONLY the variations separated by "|||" with no numbering or extra text

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

        const usedList = alreadyUsedKeywords && alreadyUsedKeywords.length > 0
            ? `\nKeywords already used in other audiences — DO NOT repeat any of these: ${alreadyUsedKeywords.join(', ')}`
            : '';

        const prompt = `You are a Facebook Ads targeting expert. Analyze the product/service from the website information below and generate ${numAudiences} DISTINCT Facebook interest-based audience segments.

Website info:
${websiteContent}
${usedList}

Rules:
- Generate exactly ${numAudiences} audience objects
- Each audience targets a clearly different interest/lifestyle group relevant to this product
- Each audience must contain 5 to 8 Facebook interest keywords (real targeting categories)
- NO keyword should appear in more than one audience — every keyword must be unique across ALL ${numAudiences} audiences
- Return ONLY valid JSON — no extra text, no markdown code fences
- Format: [{"audienceName":"Short label","interests":["keyword1","keyword2",...]},...]`;

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
            const jsonMatch = rawText.match(/\[[\s\S]*\]/);
            if (!jsonMatch) throw new Error('No JSON array in response');
            const audiences = JSON.parse(jsonMatch[0]);
            return audiences.slice(0, numAudiences);
        } catch (error) {
            throw new Error('Failed to parse Gemini audience response: ' + error.message);
        }
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
