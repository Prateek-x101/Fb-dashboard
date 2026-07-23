const fetch = require('node-fetch');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const geminiService = {
    async generateVariations(apiKey, model, baseText, count) {
        const url = `${BASE_URL}/models/${model || 'gemini-2.5-flash'}:generateContent?key=${apiKey}`;
        
        const prompt = `Create ${count} unique variations of the following ad primary text. Keep the core message but vary the hook, tone, and CTA. Return each variation separated by "|||". Do not include any extra formatting or numbering. Base text: "${baseText}"`;
        
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
