const fetch = require('node-fetch');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const geminiService = {
    async generateVariations(apiKey, model, baseText, count) {
        const url = `${BASE_URL}/models/${model || 'gemini-2.5-flash'}:generateContent?key=${apiKey}`;
        
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
        const url = `${BASE_URL}/models/${model || 'gemini-2.5-flash'}:generateContent?key=${apiKey}`;

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
        const url = `${BASE_URL}/models/${model || 'gemini-2.5-flash'}:generateContent?key=${apiKey}`;
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

module.exports = geminiService;
