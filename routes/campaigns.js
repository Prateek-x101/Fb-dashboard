const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const facebookService = require('../services/facebook');
const geminiService = require('../services/gemini');
const dns = require('dns').promises;
const net = require('net');

const storagePath = path.join(__dirname, '..', 'config', 'storage.local.json');

function getStorage() {
    if (fs.existsSync(storagePath)) {
        const data = fs.readFileSync(storagePath, 'utf8');
        return JSON.parse(data);
    }
    return { accounts: [], settings: {}, recentCampaigns: [] };
}

function saveStorage(data) {
    fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), 'utf8');
}

router.get('/locations', async (req, res) => {
    try {
        const { q } = req.query;
        let token = req.query.token;
        if (!token) {
            const storage = getStorage();
            const first = (storage.accounts || [])[0];
            if (first) token = first.accessToken;
        }
        if (!q) return res.status(400).json({ error: 'Missing query' });
        if (!token) return res.status(400).json({ error: 'No account token available' });
        const result = await facebookService.searchLocations(q, token);
        res.json(result.data || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to search locations', details: error.message });
    }
});

router.get('/custom-audiences/:accountId', async (req, res) => {
    try {
        const { accountId } = req.params;
        let token = req.query.token;
        if (!token) {
            const storage = getStorage();
            const account = (storage.accounts || []).find(a => a.accountId === accountId);
            if (account) token = account.accessToken;
        }
        if (!token) return res.status(400).json({ error: 'Missing token' });
        const result = await facebookService.getCustomAudiences(accountId, token);
        res.json(result.data || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get custom audiences', details: error.message });
    }
});

router.get('/pixels/:accountId', async (req, res) => {
    try {
        const { accountId } = req.params;
        let token = req.query.token;

        // Auto-lookup token from storage when not provided
        if (!token) {
            const storage = getStorage();
            const account = (storage.accounts || []).find(a => a.accountId === accountId);
            if (account) token = account.accessToken;
        }

        if (!token) return res.status(400).json({ error: 'Missing token' });

        const result = await facebookService.getPixels(accountId, token);
        res.json(result.data || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get pixels', details: error.message });
    }
});

router.get('/interests', async (req, res) => {
    try {
        const { q } = req.query;
        let token = req.query.token;

        // Auto-lookup token from first available account
        if (!token) {
            const storage = getStorage();
            const first = (storage.accounts || [])[0];
            if (first) token = first.accessToken;
        }

        if (!q) return res.status(400).json({ error: 'Missing query' });
        if (!token) return res.status(400).json({ error: 'No account token available' });

        const result = await facebookService.searchInterests(q, token);
        res.json(result.data || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to search interests', details: error.message });
    }
});

router.post('/ai-audiences', async (req, res) => {
    try {
        const { websiteUrl, numAudiences, alreadyUsed } = req.body;
        const storage = getStorage();
        const settings = storage.settings || {};

        if (!settings.geminiApiKey) {
            return res.status(400).json({ error: 'Gemini API key not configured. Please add it in Settings.' });
        }
        if (!websiteUrl) {
            return res.status(400).json({ error: 'Website URL is required' });
        }
        await assertSafeExternalUrl(websiteUrl);

        // Fetch website content so Gemini can understand the product
        let websiteContent = `URL: ${websiteUrl}`;
        try {
            const response = await fetchSafeExternal(websiteUrl);
            if (response.ok) {
                const html = await response.text();
                const text = html
                    .replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 3000);
                websiteContent = `URL: ${websiteUrl}\n\nPage content:\n${text}`;
            }
        } catch (fetchErr) {
            console.log('Could not fetch website content, using URL only:', fetchErr.message);
        }

        const audiences = await geminiService.generateAudiences(
            settings.geminiApiKey,
            settings.geminiModel,
            websiteContent,
            numAudiences || 3,
            alreadyUsed || []
        );

        res.json({ audiences });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate audiences', details: error.message });
    }
});

router.post('/generate-ad-copy', async (req, res) => {
    try {
        const { websiteUrl } = req.body;
        const storage = getStorage();
        const settings = storage.settings || {};

        if (!settings.geminiApiKey) {
            return res.status(400).json({ error: 'Gemini API key not configured. Please add it in Settings.' });
        }
        if (!websiteUrl) {
            return res.status(400).json({ error: 'Website URL is required' });
        }

        const details = await fetchWebsiteDetails(websiteUrl);
        const copy = await geminiService.generateAdCopy(
            settings.geminiApiKey,
            settings.geminiModel,
            websiteUrl,
            details.content,
            details.productName
        );

        res.json({ ...copy, productName: details.productName });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate ad copy', details: error.message });
    }
});

router.post('/generate-variations', async (req, res) => {
    try {
        const { primaryText, baseText, count } = req.body;
        const textToUse = primaryText || baseText;
        const storage = getStorage();
        const settings = storage.settings || {};
        
        if (!settings.geminiApiKey) {
            return res.status(400).json({ error: 'Gemini API key not configured' });
        }
        
        const variations = await geminiService.generateVariations(
            settings.geminiApiKey,
            settings.geminiModel,
            textToUse,
            count || 3
        );
        
        res.json({ variations });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate variations', details: error.message });
    }
});

router.post('/create', async (req, res) => {
    try {
        // Data comes from campaign.js as: { campaign, adsets: step2, creative: step3 }
        const { campaign, adsets: step2, creative: step3 } = req.body;

        // Look up account + token from storage
        const storage = getStorage();
        const accountRecord = (storage.accounts || []).find(a => a.id === campaign.accountId);
        if (!accountRecord) return res.status(400).json({ error: 'Account not found. Please select a valid account.' });

        const accountId = accountRecord.accountId;
        const token = accountRecord.accessToken;
        const selectedPageId = step3.pageId || accountRecord.pageId || '';
        if (!selectedPageId) {
            return res.status(400).json({ error: 'Facebook Page is required.' });
        }
        const connectedPages = await facebookService.getConnectedInstagram(token);
        const pageIsConnected = (connectedPages.data || []).some(page => String(page.id) === String(selectedPageId));
        if (!pageIsConnected) {
            return res.status(400).json({ error: 'Selected Facebook Page is not connected to the selected ad account.' });
        }

        const creativeAds = normalizeCreativeAds(step3);
        if (!creativeAds.length || creativeAds.some(ad => !ad.media)) {
            return res.status(400).json({ error: 'Every ad must have an uploaded media file.' });
        }

        // ── 1. Create Campaign ──────────────────────────────────────────
        const isCBO = campaign.budgetType === 'CBO';
        const campaignParams = {
            name: campaign.name,
            objective: campaign.objective || 'OUTCOME_SALES',
            status: 'PAUSED',
            special_ad_categories: campaign.specialAdCategory && campaign.specialAdCategory !== 'NONE'
                ? [campaign.specialAdCategory] : []
        };
        if (isCBO) {
            campaignParams.daily_budget = Math.round(campaign.budgetAmount * 100); // cents
            campaignParams.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
        }
        const campaignResponse = await facebookService.createCampaign(accountId, token, campaignParams);
        const campaignId = campaignResponse.id;

        // ── 2. Normalize and upload each ad's media ──────────────────────
        const uploadedMedia = [];
        for (const ad of creativeAds) {
            let imageHash = null;
            let videoId = null;
            if (ad.media) {
                const ext = path.extname(ad.media).toLowerCase();
                try {
                    if (['.mp4', '.mov', '.avi', '.webm'].includes(ext)) {
                        const videoRes = await facebookService.uploadVideo(accountId, token, ad.media);
                        videoId = videoRes.id;
                    } else {
                        const imageRes = await facebookService.uploadImage(accountId, token, ad.media);
                        const firstKey = Object.keys(imageRes.images || {})[0];
                        if (firstKey) imageHash = imageRes.images[firstKey].hash;
                    }
                } catch (mediaErr) {
                    console.warn(`Media upload failed for ${ad.name}, continuing without media:`, mediaErr.message);
                }
            }
            uploadedMedia.push({ ...ad, imageHash, videoId });
        }

        const results = { campaignId, adsets: [], ads: [] };
        const pageId = selectedPageId;

        // ── 3. Create AdSets + Ads per audience ─────────────────────────
        for (const audience of (step2.audiences || [])) {
            // Build geo_locations from structured location objects
            const geoLocations = buildGeoLocations(audience.locationsInclude || []);
            const excludedGeo = buildGeoLocations(audience.locationsExclude || []);

            // Gender: 0=all, 1=male, 2=female
            const genders = audience.gender === 'male' ? [1] : audience.gender === 'female' ? [2] : [];

            const targeting = {
                age_min: audience.ageMin || 18,
                age_max: audience.ageMax || 65,
                geo_locations: Object.keys(geoLocations).length > 0 ? geoLocations : { countries: ['IN'] }
            };
            if (genders.length) targeting.genders = genders;
            if (Object.keys(excludedGeo).length > 0) targeting.excluded_geo_locations = excludedGeo;

            // Interests
            if (audience.interests && audience.interests.length > 0) {
                targeting.flexible_spec = [{ interests: audience.interests.map(i => ({ id: i.id, name: i.name })).filter(i => i.id) }];
                if (!targeting.flexible_spec[0].interests.length) delete targeting.flexible_spec;
            }

            // Custom audiences
            if (audience.customAudiencesInclude?.length) {
                targeting.custom_audiences = audience.customAudiencesInclude.map(id => ({ id }));
            }
            if (audience.customAudiencesExclude?.length) {
                targeting.excluded_custom_audiences = audience.customAudiencesExclude.map(id => ({ id }));
            }
            if (audience.lookalikeInclude?.length) {
                targeting.custom_audiences = [...(targeting.custom_audiences || []), ...audience.lookalikeInclude.map(id => ({ id }))];
            }
            if (audience.lookalikeExclude?.length) {
                targeting.excluded_custom_audiences = [...(targeting.excluded_custom_audiences || []), ...audience.lookalikeExclude.map(id => ({ id }))];
            }

            const adsetParams = {
                campaign_id: campaignId,
                name: audience.name,
                optimization_goal: step2.optimizationGoal || 'OFFSITE_CONVERSIONS',
                billing_event: 'IMPRESSIONS',
                status: 'PAUSED',
                targeting,
                promoted_object: step2.pixel ? {
                    pixel_id: step2.pixel,
                    custom_event_type: step2.conversionEvent || 'PURCHASE'
                } : undefined,
                start_time: campaign.scheduleStart ? new Date(campaign.scheduleStart).toISOString() : undefined
            };
            if (!isCBO) {
                adsetParams.daily_budget = Math.round(campaign.budgetAmount * 100);
            }
            if (campaign.scheduleEnd) adsetParams.end_time = new Date(campaign.scheduleEnd).toISOString();

            const adsetResponse = await facebookService.createAdSet(accountId, token, adsetParams);
            results.adsets.push(adsetResponse.id);

            // ── 4. Creative + Ad per media card ─────────────────────────
            for (const ad of uploadedMedia) {
                const textVariation = ad.primaryText || '';

                const creativeParams = {
                    name: `${campaign.name} — ${audience.name} — ${ad.name}`,
                    object_story_spec: {
                        page_id: pageId,
                        link_data: {
                            message: textVariation,
                            link: step2.url,
                            name: step3.headline || '',
                            description: step3.description || '',
                            call_to_action: { type: step3.cta || 'SHOP_NOW', value: { link: step2.url } }
                        }
                    }
                };

                if (ad.imageHash) creativeParams.object_story_spec.link_data.image_hash = ad.imageHash;
                if (ad.videoId) {
                    creativeParams.object_story_spec.video_data = {
                        video_id: ad.videoId,
                        message: textVariation,
                        title: step3.headline || '',
                        link_description: step3.description || '',
                        call_to_action: { type: step3.cta || 'SHOP_NOW', value: { link: step2.url } }
                    };
                    delete creativeParams.object_story_spec.link_data;
                }
                if (step3.instagramId) {
                    creativeParams.object_story_spec.instagram_actor_id = step3.instagramId;
                }

                const creativeResponse = await facebookService.createAdCreative(accountId, token, creativeParams);

                const adResponse = await facebookService.createAd(accountId, token, {
                    name: ad.name,
                    adset_id: adsetResponse.id,
                    creative: { creative_id: creativeResponse.id },
                    status: 'PAUSED'
                });
                results.ads.push(adResponse.id);
            }
        }

        // Save to recent campaigns
        if (!storage.recentCampaigns) storage.recentCampaigns = [];
        storage.recentCampaigns.unshift({
            id: uuidv4(),
            campaignId,
            name: campaign.name,
            createdAt: new Date().toISOString(),
            status: 'success',
            adSets: results.adsets.length,
            ads: results.ads.length
        });
        if (storage.recentCampaigns.length > 50) storage.recentCampaigns = storage.recentCampaigns.slice(0, 50);
        saveStorage(storage);

        res.json({ success: true, results });
    } catch (error) {
        console.error('Campaign creation error:', error);
        res.status(500).json({ error: 'Failed to create campaign', details: error.message });
    }
});

function normalizeCreativeAds(step3 = {}) {
    if (Array.isArray(step3.ads) && step3.ads.length > 0) {
        const total = step3.ads.length;
        return step3.ads.map((ad, index) => ({
            name: total === 1 ? 'Single content-Reel' : `Content-${index + 1} Reel`,
            media: ad.media || null,
            primaryText: ad.primaryText || '',
            mediaFile: ad.mediaFile || ''
        }));
    }

    const legacyVariations = Array.isArray(step3.variations) ? step3.variations : [];
    return legacyVariations.map((primaryText, index) => ({
        name: legacyVariations.length === 1 ? 'Single content-Reel' : `Content-${index + 1} Reel`,
        media: index === 0 ? step3.media || null : null,
        primaryText: typeof primaryText === 'string' ? primaryText : primaryText.primaryText || ''
    }));
}

async function fetchWebsiteDetails(websiteUrl) {
    let html;
    try {
        const response = await fetchSafeExternal(websiteUrl);
        if (!response.ok) throw new Error(`Website returned ${response.status}`);
        html = await response.text();
    } catch (error) {
        throw new Error(`Could not read website: ${error.message}`);
    }

    const firstMatch = (regex) => {
        const match = html.match(regex);
        return match ? match[1].replace(/\s+/g, ' ').trim() : '';
    };
    const productName =
        firstMatch(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
        firstMatch(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i) ||
        firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, '') ||
        firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i).replace(/<[^>]+>/g, '') ||
        'Product';
    const content = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 6000);

    return { productName, content: `URL: ${websiteUrl}\n\nPage content:\n${content}` };
}

function isPrivateIp(address) {
    if (net.isIP(address) === 4) {
        const parts = address.split('.').map(Number);
        return parts[0] === 10 ||
            parts[0] === 127 ||
            (parts[0] === 169 && parts[1] === 254) ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168) ||
            parts[0] === 0;
    }
    if (net.isIP(address) === 6) {
        const normalized = address.toLowerCase();
        return normalized === '::1' ||
            normalized.startsWith('fc') ||
            normalized.startsWith('fd') ||
            normalized.startsWith('fe80:');
    }
    return true;
}

async function assertSafeExternalUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('Website URL must be valid.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error('Only public HTTP(S) website URLs are allowed.');
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
        throw new Error('Private or local website URLs are not allowed.');
    }
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(entry => isPrivateIp(entry.address))) {
        throw new Error('Private or internal website URLs are not allowed.');
    }
    return parsed;
}

async function fetchSafeExternal(value) {
    const fetch = require('node-fetch');
    let currentUrl = value;
    for (let redirects = 0; redirects <= 3; redirects++) {
        await assertSafeExternalUrl(currentUrl);
        const response = await fetch(currentUrl, {
            timeout: 10000,
            redirect: 'manual',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AdPilot/1.0)' }
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get('location');
        if (!location) return response;
        currentUrl = new URL(location, currentUrl).toString();
    }
    throw new Error('Too many website redirects.');
}

// Build FB geo_locations object from structured location array
function buildGeoLocations(locations) {
    const geo = {};
    locations.forEach(loc => {
        const key = loc.key || '';
        const type = loc.type || 'country';
        if (!key) return;
        if (type === 'country') {
            geo.countries = geo.countries || [];
            if (!geo.countries.includes(key)) geo.countries.push(key);
        } else if (type === 'region') {
            geo.regions = geo.regions || [];
            geo.regions.push({ key });
        } else if (type === 'city') {
            geo.cities = geo.cities || [];
            geo.cities.push({ key });
        } else if (type === 'zip') {
            geo.zips = geo.zips || [];
            geo.zips.push({ key });
        }
    });
    return geo;
}

router.get('/recent', (req, res) => {
    try {
        const storage = getStorage();
        res.json(storage.recentCampaigns || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch recent campaigns', details: error.message });
    }
});

module.exports = router;
