const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');

const BASE_URL = 'https://graph.facebook.com/v21.0';

async function handleResponse(response) {
    const data = await response.json();
    if (!response.ok) {
        const apiError = data.error || {};
        const error = new Error(apiError.message || data.message || 'Unknown Facebook API Error');
        error.provider = 'facebook';
        error.code = apiError.code;
        error.errorSubcode = apiError.error_subcode;
        error.type = apiError.type;
        error.fbtraceId = apiError.fbtrace_id;
        error.details = data;
        throw error;
    }
    return data;
}

function formEncodedParams(params) {
    const body = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') return;
        body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    });
    return body;
}

const facebookService = {
    async createCampaign(accountId, token, params) {
        const url = `${BASE_URL}/act_${accountId}/campaigns?access_token=${token}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formEncodedParams(params)
        });
        return handleResponse(response);
    },

    async createAdSet(accountId, token, params) {
        const url = `${BASE_URL}/act_${accountId}/adsets?access_token=${token}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        return handleResponse(response);
    },

    async createAdCreative(accountId, token, params) {
        const url = `${BASE_URL}/act_${accountId}/adcreatives?access_token=${token}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        return handleResponse(response);
    },

    async createAd(accountId, token, params) {
        const url = `${BASE_URL}/act_${accountId}/ads?access_token=${token}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        return handleResponse(response);
    },

    async uploadImage(accountId, token, filePath) {
        const url = `${BASE_URL}/act_${accountId}/adimages?access_token=${token}`;
        const form = new FormData();
        form.append('filename', fs.createReadStream(filePath));
        
        const response = await fetch(url, {
            method: 'POST',
            body: form
        });
        return handleResponse(response);
    },

    async uploadVideo(accountId, token, filePath) {
        const url = `${BASE_URL}/act_${accountId}/advideos?access_token=${token}`;
        const form = new FormData();
        form.append('source', fs.createReadStream(filePath));
        
        const response = await fetch(url, {
            method: 'POST',
            body: form
        });
        return handleResponse(response);
    },

    async getPixels(accountId, token) {
        const url = `${BASE_URL}/act_${accountId}/adspixels?fields=id,name&access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async searchInterests(query, token) {
        const url = `${BASE_URL}/search?type=adinterest&q=${encodeURIComponent(query)}&access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async getAdAccounts(token) {
        const url = `${BASE_URL}/me/adaccounts?fields=name,account_id,account_status&access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async getInstagramFromPage(pageId, token) {
        const url = `${BASE_URL}/${pageId}?fields=instagram_business_account{id,name,username,profile_picture_url}&access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async getConnectedInstagram(token) {
        // Get every Page linked to this token, not only the first Graph API page.
        const fields = encodeURIComponent('id,name,instagram_business_account{id,name,username}');
        let nextUrl = `${BASE_URL}/me/accounts?fields=${fields}&limit=100&access_token=${token}`;
        const pages = [];
        let paging = null;

        for (let requestCount = 0; nextUrl && requestCount < 20; requestCount++) {
            const response = await fetch(nextUrl, { method: 'GET' });
            const result = await handleResponse(response);
            pages.push(...(result.data || []));
            paging = result.paging || null;
            nextUrl = paging && paging.next ? paging.next : null;
        }

        return { data: pages, paging };
    },

    async searchLocations(query, token) {
        const url = `${BASE_URL}/search?type=adgeolocation&q=${encodeURIComponent(query)}&location_types=["country","region","city","zip"]&access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async getCustomAudiences(accountId, token) {
        const url = `${BASE_URL}/act_${accountId}/customaudiences?fields=id,name,subtype,approximate_count_lower_bound&limit=200&access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async resolveLocationNames(names, token) {
        // Resolve a list of location names to their FB keys via search
        const resolved = [];
        for (const name of names) {
            try {
                const url = `${BASE_URL}/search?type=adgeolocation&q=${encodeURIComponent(name)}&location_types=["region","city","country"]&access_token=${token}`;
                const response = await fetch(url, { method: 'GET' });
                const data = await response.json();
                if (data.data && data.data.length > 0) {
                    const match = data.data.find(d => d.name.toLowerCase() === name.toLowerCase()) || data.data[0];
                    resolved.push({ key: match.key, name: match.name, type: match.type, countryCode: match.country_code });
                }
            } catch (e) { /* skip if can't resolve */ }
        }
        return resolved;
    },

    async testConnection(accountId, token) {
        const url = `${BASE_URL}/act_${accountId}?access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    }
};

module.exports = facebookService;
