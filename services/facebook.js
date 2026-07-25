const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');

const BASE_URL = 'https://graph.facebook.com/v25.0';

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
        const url = `${BASE_URL}/me/adaccounts?fields=name,account_id,account_status,currency&access_token=${token}`;
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
        // Resolve all location names in PARALLEL for maximum speed
        const promises = names.map(async (name) => {
            try {
                // Strip common suffixes like " - India" that cause incorrect city matches
                const cleanName = name.replace(/\s*-\s*India$/i, '').trim();
                const url = `${BASE_URL}/search?type=adgeolocation&q=${encodeURIComponent(cleanName)}&location_types=["region","city","country"]&access_token=${token}`;
                const response = await fetch(url, { method: 'GET' });
                const data = await response.json();
                if (data.data && data.data.length > 0) {
                    // Prefer region matches over city matches for state/region exclusions
                    const regionMatch = data.data.find(d => d.type === 'region' && d.name.toLowerCase().includes(cleanName.toLowerCase().split(',')[0]));
                    const exactMatch = data.data.find(d => d.name.toLowerCase() === cleanName.toLowerCase());
                    const match = regionMatch || exactMatch || data.data[0];
                    return { key: match.key, name: match.name, type: match.type, countryCode: match.country_code };
                }
            } catch (e) { /* skip if can't resolve */ }
            return null;
        });
        const results = await Promise.allSettled(promises);
        return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    },

    async resolveInterestNames(names, token) {
        // Resolve all interest names in PARALLEL for maximum speed
        const promises = names.map(async (name) => {
            try {
                const url = `${BASE_URL}/search?type=adinterest&q=${encodeURIComponent(name)}&access_token=${token}`;
                const response = await fetch(url, { method: 'GET' });
                const data = await response.json();
                if (data.data && data.data.length > 0) {
                    const match = data.data.find(d => d.name.toLowerCase() === name.toLowerCase()) || data.data[0];
                    return { id: match.id, name: match.name };
                }
            } catch (e) { /* skip if can't resolve */ }
            return null;
        });
        const results = await Promise.allSettled(promises);
        return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    },

    async getVideoThumbnailWithRetry(videoId, token) {
        // Step 1: Check picture field first (fastest, usually available immediately)
        try {
            const response = await fetch(`${BASE_URL}/${videoId}?fields=picture&access_token=${token}`);
            if (response.ok) {
                const data = await response.json();
                if (data && data.picture) {
                    return data.picture;
                }
            }
        } catch (err) {
            console.error('Fast fetch video picture failed:', err.message);
        }

        // Step 2: Fallback to thumbnails edge with retries
        for (let attempt = 0; attempt < 8; attempt++) {
            try {
                const response = await fetch(`${BASE_URL}/${videoId}/thumbnails?access_token=${token}`);
                const data = await response.json();
                if (data && data.data && data.data.length > 0) {
                    const preferred = data.data.find(t => t.is_preferred) || data.data[0];
                    if (preferred.uri) {
                        return preferred.uri;
                    }
                }
            } catch (err) {
                console.error(`Attempt ${attempt + 1} to fetch video thumbnail failed:`, err.message);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // Step 3: Final fallback try on picture field again
        try {
            const response = await fetch(`${BASE_URL}/${videoId}?fields=picture&access_token=${token}`);
            const data = await response.json();
            if (data && data.picture) {
                return data.picture;
            }
        } catch (err) {
            console.error('Final fallback fetch video picture failed:', err.message);
        }
        return null;
    },

    async testConnection(accountId, token) {
        const url = `${BASE_URL}/act_${accountId}?access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async getAccessTokenFromCode(appId, appSecret, code, redirectUri) {
        const url = `${BASE_URL}/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async getLongLivedToken(appId, appSecret, shortLivedToken) {
        const url = `${BASE_URL}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    }
};

module.exports = facebookService;
