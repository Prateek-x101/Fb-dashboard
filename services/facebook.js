const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');

const BASE_URL = 'https://graph.facebook.com/v25.0';

const TARGETING_TYPES = new Set(['interest', 'behavior', 'demographic', 'life_event', 'job_title', 'employer', 'field_of_study', 'school']);

function normalizeTargetingName(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function normalizeTargetingType(value) {
    const type = String(value || 'interest').trim().toLowerCase();
    return TARGETING_TYPES.has(type) ? type : null;
}

function targetingSearchUrl(name, type, token, accountId = null) {
    const q = encodeURIComponent(name);
    const cleanAccountId = accountId ? String(accountId).replace('act_', '') : null;
    const prefix = cleanAccountId ? `${BASE_URL}/act_${cleanAccountId}/targetingsearch` : `${BASE_URL}/search`;

    if (type === 'behavior')       return `${prefix}?type=adTargetingCategory&class=behaviors&q=${q}&access_token=${token}`;
    if (type === 'demographic')    return `${prefix}?type=adTargetingCategory&class=demographics&q=${q}&access_token=${token}`;
    if (type === 'life_event')     return `${prefix}?type=adTargetingCategory&class=life_events&q=${q}&access_token=${token}`;
    if (type === 'job_title')      return `${prefix}?type=adworkposition&q=${q}&access_token=${token}`;
    if (type === 'employer')       return `${prefix}?type=adworkemployer&q=${q}&access_token=${token}`;
    if (type === 'field_of_study') return `${prefix}?type=adeducationmajor&q=${q}&access_token=${token}`;
    if (type === 'school')         return `${prefix}?type=adeducationschool&q=${q}&access_token=${token}`;
    return `${prefix}?type=adinterest&q=${q}&access_token=${token}`;
}

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
        const fileStats = fs.statSync(filePath);
        const fileSize = fileStats.size;

        console.log(`[FacebookService] Starting chunked upload for video (${(fileSize / (1024 * 1024)).toFixed(2)} MB): ${filePath}`);

        // 1. Initialize upload session
        const initUrl = `https://graph.facebook.com/v25.0/act_${accountId}/advideos`;
        const initParams = new URLSearchParams({
            access_token: token,
            upload_phase: 'start',
            file_size: String(fileSize)
        });

        const initRes = await fetch(`${initUrl}?${initParams.toString()}`, { method: 'POST' });
        const initData = await initRes.json();
        if (initRes.status >= 400 || initData.error) {
            throw new Error(`Facebook video upload init failed: ${JSON.stringify(initData.error || initData)}`);
        }

        const { video_id, upload_session_id } = initData;
        let startOffset = parseInt(initData.start_offset || '0');

        // 2. Transfer chunks loop
        const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
        const fileFd = fs.openSync(filePath, 'r');

        try {
            while (startOffset < fileSize) {
                const currentChunkSize = Math.min(CHUNK_SIZE, fileSize - startOffset);
                const buffer = Buffer.alloc(currentChunkSize);
                fs.readSync(fileFd, buffer, 0, currentChunkSize, startOffset);

                const form = new FormData();
                form.append('upload_phase', 'transfer');
                form.append('upload_session_id', upload_session_id);
                form.append('start_offset', String(startOffset));
                form.append('video_file_chunk', buffer, {
                    filename: 'chunk.mp4',
                    contentType: 'video/mp4'
                });

                const transferUrl = `https://graph.facebook.com/v25.0/act_${accountId}/advideos?access_token=${token}`;
                const transferRes = await fetch(transferUrl, {
                    method: 'POST',
                    body: form,
                    headers: form.getHeaders()
                });

                const transferData = await transferRes.json();
                if (transferRes.status >= 400 || transferData.error) {
                    throw new Error(`Facebook video chunk transfer failed at offset ${startOffset}: ${JSON.stringify(transferData.error || transferData)}`);
                }

                startOffset = parseInt(transferData.start_offset || String(startOffset + currentChunkSize));
            }
        } finally {
            fs.closeSync(fileFd);
        }

        // 3. Finish upload session
        const finishParams = new URLSearchParams({
            access_token: token,
            upload_phase: 'finish',
            upload_session_id: upload_session_id
        });

        const finishRes = await fetch(`${initUrl}?${finishParams.toString()}`, { method: 'POST' });
        const finishData = await finishRes.json();
        if (finishRes.status >= 400 || finishData.error) {
            throw new Error(`Facebook video upload finish failed: ${JSON.stringify(finishData.error || finishData)}`);
        }

        console.log(`[FacebookService] Chunked upload completed. Video ID: ${video_id}`);
        return { id: video_id };
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

    // Search all targeting types in parallel
    async searchAllTargeting(query, token) {
        const searches = [
            { url: `${BASE_URL}/search?type=adinterest&q=${encodeURIComponent(query)}&access_token=${token}`, type: 'interest' },
            { url: `${BASE_URL}/search?type=adTargetingCategory&class=behaviors&q=${encodeURIComponent(query)}&access_token=${token}`, type: 'behavior' },
            { url: `${BASE_URL}/search?type=adTargetingCategory&class=demographics&q=${encodeURIComponent(query)}&access_token=${token}`, type: 'demographic' },
            { url: `${BASE_URL}/search?type=adTargetingCategory&class=life_events&q=${encodeURIComponent(query)}&access_token=${token}`, type: 'life_event' },
            { url: `${BASE_URL}/search?type=adworkposition&q=${encodeURIComponent(query)}&access_token=${token}`, type: 'job_title' },
            { url: `${BASE_URL}/search?type=adworkemployer&q=${encodeURIComponent(query)}&access_token=${token}`, type: 'employer' },
            { url: `${BASE_URL}/search?type=adeducationmajor&q=${encodeURIComponent(query)}&access_token=${token}`, type: 'field_of_study' },
            { url: `${BASE_URL}/search?type=adeducationschool&q=${encodeURIComponent(query)}&access_token=${token}`, type: 'school' }
        ];
        const settled = await Promise.allSettled(
            searches.map(s =>
                fetch(s.url)
                    .then(r => r.json())
                    .then(data => (data.data || []).map(item => ({ id: item.id, name: item.name, type: s.type })))
            )
        );
        const results = [];
        settled.forEach(s => { if (s.status === 'fulfilled') results.push(...s.value); });
        return results;
    },

    // Resolve a mixed array of {id?, name, type} items to full {id, name, type} using the right FB endpoint per type
    async resolveAllTargeting(items, token, accountId = null) {
        if (!Array.isArray(items) || !token) return [];

        // Do not trust IDs from saved audiences or old Gemini responses.
        // Targeting IDs can become unavailable and an ID must be validated
        // for the targeting type that will be used in flexible_spec.
        const promises = items.map(async item => {
            try {
                if (!item || typeof item !== 'object') return null;
                const type = normalizeTargetingType(item.type);
                if (!type) return null;

                if (item.id && /^\d+$/.test(String(item.id))) {
                    return { id: String(item.id), name: item.name || '', type: type };
                }

                const name = String(item.name || '').trim();
                if (name) {
                    const normalizedName = normalizeTargetingName(name);
                    const sigWords = normalizedName.split(' ').filter(w => w.length > 2);

                    // Score a candidate pool against the target keyword — returns best match or null
                    function bestFromPool(pool) {
                        // 1. Exact
                        let m = pool.find(c => normalizeTargetingName(c.name) === normalizedName);
                        if (m) return m;
                        // 2. One string contains the other
                        m = pool.find(c => {
                            const cn = normalizeTargetingName(c.name);
                            return cn.includes(normalizedName) || normalizedName.includes(cn);
                        });
                        if (m) return m;
                        // 3. All significant words present in candidate
                        if (sigWords.length > 0) {
                            m = pool.find(c => {
                                const cn = normalizeTargetingName(c.name);
                                return sigWords.every(w => cn.includes(w));
                            });
                            if (m) return m;
                        }
                        // 4. Best word-overlap ≥ 60%
                        if (sigWords.length > 1) {
                            let best = null, bestScore = 0;
                            for (const c of pool) {
                                const cn = normalizeTargetingName(c.name);
                                const hits = sigWords.filter(w => cn.includes(w)).length;
                                const score = hits / sigWords.length;
                                if (score >= 0.6 && score > bestScore) { best = c; bestScore = score; }
                            }
                            if (best) return best;
                        }
                        return null;
                    }

                    // Fetch + score one search query, return best match or null
                    async function searchAndMatch(searchName, searchType) {
                        try {
                            // Try account-specific targetingsearch first if accountId is provided
                            if (accountId) {
                                try {
                                    const url = targetingSearchUrl(searchName, searchType, token, accountId);
                                    const d = await fetch(url, { timeout: 5000 }).then(r => r.json());
                                    if (d && !d.error) {
                                        const match = bestFromPool(Array.isArray(d.data) ? d.data : []);
                                        if (match) return match;
                                    }
                                } catch (err) {
                                    console.warn(`targetingsearch failed for ${searchName}, falling back to global search:`, err.message);
                                }
                            }

                            // Fallback to global search
                            const url = targetingSearchUrl(searchName, searchType, token, null);
                            const d = await fetch(url, { timeout: 5000 }).then(r => r.json());
                            let match = bestFromPool(Array.isArray(d.data) ? d.data : []);
                            if (match) return match;

                            // Casing fallbacks
                            const titleCase = searchName.replace(/\b\w/g, c => c.toUpperCase());
                            if (titleCase !== searchName) {
                                const urlTC = targetingSearchUrl(titleCase, searchType, token, null);
                                const dTC = await fetch(urlTC, { timeout: 5000 }).then(r => r.json());
                                match = bestFromPool(Array.isArray(dTC.data) ? dTC.data : []);
                                if (match) return match;
                            }

                            const capitalized = searchName.charAt(0).toUpperCase() + searchName.slice(1);
                            if (capitalized !== searchName && capitalized !== titleCase) {
                                const urlCap = targetingSearchUrl(capitalized, searchType, token, null);
                                const dCap = await fetch(urlCap, { timeout: 5000 }).then(r => r.json());
                                match = bestFromPool(Array.isArray(dCap.data) ? dCap.data : []);
                                if (match) return match;
                            }

                            return null;
                        } catch { return null; }
                    }

                    // Round 1 — full keyword, declared type
                    let match = await searchAndMatch(name, type);
                    let matchedType = type;

                    // Round 2 — multi-word: retry with longest significant word, same type
                    if (!match && sigWords.length > 1) {
                        const pivot = sigWords.reduce((a, b) => b.length > a.length ? b : a, sigWords[0]);
                        match = await searchAndMatch(pivot, type);
                    }

                    // Round 3 — type fallback: behavior/demographic/life_event → also try as interest
                    //   (Facebook often lists the same concept under a different category)
                    if (!match && type !== 'interest') {
                        match = await searchAndMatch(name, 'interest');
                        if (match) matchedType = 'interest';
                    }

                    // Round 4 — interest → also try behavior (e.g. "Online shoppers" is a behavior)
                    if (!match && type === 'interest') {
                        match = await searchAndMatch(name, 'behavior');
                        if (match) matchedType = 'behavior';
                    }

                    // Round 5 — pivot word + interest fallback
                    if (!match && sigWords.length > 1 && type !== 'interest') {
                        const pivot = sigWords.reduce((a, b) => b.length > a.length ? b : a, sigWords[0]);
                        match = await searchAndMatch(pivot, 'interest');
                        if (match) matchedType = 'interest';
                    }

                    // Last resort — first result from full-keyword primary search only if ≥1 word matches
                    if (!match) {
                        try {
                            const url = targetingSearchUrl(name, type, token, accountId);
                            const d = await fetch(url).then(r => r.json());
                            const primary = Array.isArray(d.data) ? d.data : [];
                            if (primary.length > 0) {
                                const firstCn = normalizeTargetingName(primary[0].name);
                                if (sigWords.some(w => firstCn.includes(w))) {
                                    match = primary[0];
                                    matchedType = type;
                                }
                            }
                        } catch { /* skip */ }
                    }

                    if (match?.id) {
                        return { id: String(match.id), name: match.name, type: match.type || matchedType };
                    }
                    return null;
                }

                // An ID without the original name cannot be safely checked
                // against the requested targeting type. Drop it rather than
                // risking a stale/cross-type key in flexible_spec.
            } catch (e) { /* skip */ }
            return null;
        });

        const resolved = (await Promise.allSettled(promises))
            .filter(r => r.status === 'fulfilled' && r.value)
            .map(r => r.value);
        const seen = new Set();
        return resolved.filter(item => {
            const key = `${item.type}:${item.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
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
        // Get every Page linked to this token (including Business Portfolio pages). Includes Page access_token.
        const fields = encodeURIComponent('id,name,access_token,instagram_business_account{id,name,username}');
        const pagesMap = new Map();

        // 1. Fetch direct user accounts (Pages)
        let nextUrl = `${BASE_URL}/me/accounts?fields=${fields}&limit=100&access_token=${token}`;
        try {
            for (let requestCount = 0; nextUrl && requestCount < 20; requestCount++) {
                const response = await fetch(nextUrl, { method: 'GET' });
                const result = await handleResponse(response);
                (result.data || []).forEach(page => {
                    if (page.id) pagesMap.set(page.id, page);
                });
                const paging = result.paging || null;
                nextUrl = paging && paging.next ? paging.next : null;
            }
        } catch (err) {
            console.error("Failed to fetch user accounts directly:", err.message);
        }

        // 2. Fetch Business Portfolios and scan their client/owned pages in parallel
        try {
            const bizUrl = `${BASE_URL}/me/businesses?fields=id,name&limit=100&access_token=${token}`;
            const bizResp = await fetch(bizUrl, { method: 'GET' });
            if (bizResp.ok) {
                const bizData = await bizResp.json();
                const businesses = bizData.data || [];
                
                await Promise.all(businesses.map(async (biz) => {
                    try {
                        // Query owned pages
                        const ownedUrl = `${BASE_URL}/${biz.id}/owned_pages?fields=${fields}&limit=100&access_token=${token}`;
                        const ownedResp = await fetch(ownedUrl, { method: 'GET' });
                        if (ownedResp.ok) {
                            const ownedData = await ownedResp.json();
                            (ownedData.data || []).forEach(page => {
                                if (page.id && !pagesMap.has(page.id)) {
                                    pagesMap.set(page.id, page);
                                }
                            });
                        }

                        // Query client pages
                        const clientUrl = `${BASE_URL}/${biz.id}/client_pages?fields=${fields}&limit=100&access_token=${token}`;
                        const clientResp = await fetch(clientUrl, { method: 'GET' });
                        if (clientResp.ok) {
                            const clientData = await clientResp.json();
                            (clientData.data || []).forEach(page => {
                                if (page.id && !pagesMap.has(page.id)) {
                                    pagesMap.set(page.id, page);
                                }
                            });
                        }
                    } catch (bizPagesErr) {
                        console.warn(`Failed to fetch pages for business ${biz.id}:`, bizPagesErr.message);
                    }
                }));
            }
        } catch (err) {
            console.log("Failed to fetch business portfolios (normal if no permission):", err.message);
        }

        return { data: Array.from(pagesMap.values()) };
    },

    async searchLocations(query, token) {
        const url = `${BASE_URL}/search?type=adgeolocation&q=${encodeURIComponent(query)}&location_types=["country","region","city","zip"]&access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async searchLanguages(query, token) {
        const url = `${BASE_URL}/search?type=adlocale&q=${encodeURIComponent(query)}&access_token=${token}`;
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
                    const normalizedName = normalizeTargetingName(cleanName);
                    const match = data.data.find(d => normalizeTargetingName(d.name) === normalizedName);
                    if (!match?.key) return null;
                    return { key: match.key, name: match.name, type: match.type, countryCode: match.country_code };
                }
            } catch (e) { /* skip if can't resolve */ }
            return null;
        });
        const results = await Promise.allSettled(promises);
        return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    },

    async resolveInterestNames(names, token) {
        const resolved = await this.resolveAllTargeting(
            (names || []).map(name => ({ name, type: 'interest' })),
            token
        );
        return resolved.map(({ id, name }) => ({ id, name }));
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
