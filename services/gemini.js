const fetch = require('node-fetch');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1';
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
            validateAdCopy(result.primaryText, websiteUrl);
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

        const prompt = `You are a Facebook Ads targeting expert. Analyze the complete product information below and generate ${audienceCount} DISTINCT, product-relevant audience segments using Facebook's full targeting options.

Complete product information:
${websiteContent}
${usedList}

Rules:
- Generate exactly ${audienceCount} audience objects. Never return fewer than 3.
- Each audience targets a clearly different customer profile relevant to this product
- Each audience must contain 5 to 8 highly relevant targeting items drawn from multiple types:
  • "interest" — hobbies, pages, topics (e.g. "Online shopping", "Yoga", "Luxury goods")
  • "behavior" — purchase habits, device use, travel patterns (e.g. "Online shoppers", "Frequent travelers", "Small business owners")
  • "demographic" — life stage, education, relationship status (e.g. "Parents", "College graduates", "New homeowners", "Newly engaged")
  • "job_title" — profession or job role (e.g. "Software Engineer", "Fashion designer", "Marketing Manager")
- Mix types within each audience — do NOT use only interests
- Do not invent generic audiences unrelated to the product. Derive targeting from the product's category, materials/features, use cases, price/positioning, and likely buyer intent.
- NO targeting item should appear in more than one audience — every item must be unique across ALL ${audienceCount} audiences
- Use real Facebook Ads Manager targeting keywords that actually exist
- Return ONLY valid JSON — no markdown, no extra text
- Format: [{"audienceName":"Short label","targeting":[{"type":"interest|behavior|demographic|job_title","name":"keyword"},...]},...]`;

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
