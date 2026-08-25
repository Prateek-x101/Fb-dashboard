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

async function downloadUrlToTempFile(url) {
    const os = require('os');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch image from URL: ${url}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `fb_thumb_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`);
    fs.writeFileSync(tempFilePath, buffer);
    return tempFilePath;
}

function appendUtmParams(url) {
    if (!url) return '';
    let parsedUrl = url.trim();
    
    // If the URL already contains UTM parameters, don't append again
    if (parsedUrl.includes('utm_medium=') || parsedUrl.includes('utm_campaign=')) {
        return parsedUrl;
    }
    
    const utmString = 'utm_medium={{ad.name}}&utm_campaign={{campaign.name}}&utm_content={{adset.name}}';
    
    if (parsedUrl.includes('?')) {
        if (parsedUrl.endsWith('?') || parsedUrl.endsWith('&')) {
            return parsedUrl + utmString;
        }
        return parsedUrl + '&' + utmString;
    } else {
        return parsedUrl + '?' + utmString;
    }
}

function parseIsoDate(dateString) {
    if (!dateString) return undefined;
    if (dateString instanceof Date) return dateString.toISOString();
    let str = String(dateString).trim();
    if (!str) return undefined;

    let d = new Date(str);
    if (!isNaN(d.getTime())) {
        return d.toISOString();
    }

    // Try converting 12-hour format "11:55 PM" or "2026-07-24 11:55 PM" or "2026-07-24T11:55 PM"
    const regex12 = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i;
    const match12 = str.match(regex12);
    if (match12) {
        let [_, datePart, hoursStr, minsStr, secsStr, ampm] = match12;
        let hours = parseInt(hoursStr, 10);
        const mins = parseInt(minsStr, 10);
        const secs = secsStr ? parseInt(secsStr, 10) : 0;
        if (ampm.toUpperCase() === 'PM' && hours < 12) hours += 12;
        if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
        const normalized = `${datePart.replace(/\//g, '-')}T${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        d = new Date(normalized);
        if (!isNaN(d.getTime())) return d.toISOString();
    }

    // Handle 24-hour format with space instead of T: "2026-07-24 23:55"
    const regex24 = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
    const match24 = str.match(regex24);
    if (match24) {
        let [_, datePart, hoursStr, minsStr, secsStr] = match24;
        const hours = parseInt(hoursStr, 10);
        const mins = parseInt(minsStr, 10);
        const secs = secsStr ? parseInt(secsStr, 10) : 0;
        const normalized = `${datePart.replace(/\//g, '-')}T${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        d = new Date(normalized);
        if (!isNaN(d.getTime())) return d.toISOString();
    }

    return undefined;
}

// Returns which enhancements are supported for a given ad account
router.get('/account-features/:accountId', async (req, res) => {
    try {
        const { accountId } = req.params;
        const cleanId = accountId.replace('act_', '');
        const storage = getStorage();
        const account = (storage.accounts || []).find(a => {
            const aClean = (a.accountId || '').replace('act_', '');
            return aClean === cleanId;
        });
        let token = account?.accessToken || storage.settings?.facebookAccessToken;
        if (!token) return res.status(400).json({ error: 'No token for this account' });

        // Fetch account capabilities and check for product catalogs in parallel
        const [capRes, catRes] = await Promise.all([
            fetch(`https://graph.facebook.com/v25.0/act_${cleanId}?fields=capabilities,disable_reason&access_token=${token}`),
            fetch(`https://graph.facebook.com/v25.0/act_${cleanId}/product_catalogs?fields=id&limit=1&access_token=${token}`)
        ]);

        let capabilities = [];
        let hasCatalog = false;

        if (capRes.ok) {
            const capData = await capRes.json();
            capabilities = capData.capabilities || [];
        }
        if (catRes.ok) {
            const catData = await catRes.json();
            hasCatalog = Array.isArray(catData.data) && catData.data.length > 0;
        }

        // Determine supported enhancements based on capabilities
        const capSet = new Set(capabilities.map(c => String(c).toUpperCase()));

        res.json({
            advantageAudience:   true,   // universally available
            multiAdvertiser:     true,   // universally available
            autoCreative:        true,   // universally available (standard_enhancements)
            inlineComment:       false,  // legacy key is not in Meta's current enum
            textOptimizations:   !capSet.has('CANNOT_USE_CREATIVE_HUB'), // disabled for very restricted accounts
            // These legacy creative feature keys are rejected by the current
            // Meta API even when the account has a catalog or CTA enabled.
            productTags:         false,
            enhanceCta:          false
        });
    } catch (error) {
        // On any error fall back to all enabled so campaign creation isn't blocked
        res.json({
            advantageAudience: true, multiAdvertiser: true, autoCreative: true,
            inlineComment: false, textOptimizations: true, productTags: false, enhanceCta: false
        });
    }
});

router.get('/locations', async (req, res) => {
    try {
        const { q } = req.query;
        let token = req.query.token;
        if (!token) {
            const storage = getStorage();
            const first = (storage.accounts || [])[0];
            if (first) token = first.accessToken;
            if (!token && storage.settings?.facebookAccessToken) token = storage.settings.facebookAccessToken;
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
        const cleanId = accountId.replace('act_', '');
        let token = req.query.token;
        if (!token) {
            const storage = getStorage();
            const account = (storage.accounts || []).find(a => {
                const aClean = (a.accountId || '').replace('act_', '');
                return aClean === cleanId;
            });
            if (account) token = account.accessToken;
            if (!token && storage.settings?.facebookAccessToken) token = storage.settings.facebookAccessToken;
        }
        if (!token) return res.status(400).json({ error: 'Missing token' });
        const result = await facebookService.getCustomAudiences(cleanId, token);
        res.json(result.data || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get custom audiences', details: error.message });
    }
});

router.get('/pixels/:accountId', async (req, res) => {
    try {
        const { accountId } = req.params;
        const cleanId = accountId.replace('act_', '');
        let token = req.query.token;

        // Auto-lookup token from storage when not provided
        if (!token) {
            const storage = getStorage();
            const account = (storage.accounts || []).find(a => {
                const aClean = (a.accountId || '').replace('act_', '');
                return aClean === cleanId;
            });
            if (account) token = account.accessToken;
            if (!token && storage.settings?.facebookAccessToken) token = storage.settings.facebookAccessToken;
        }

        if (!token) return res.status(400).json({ error: 'Missing token' });

        const result = await facebookService.getPixels(cleanId, token);
        res.json(result.data || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get pixels', details: error.message });
    }
});

router.get('/languages', async (req, res) => {
    try {
        const { q } = req.query;
        let token = req.query.token;
        if (!token) {
            const storage = getStorage();
            const first = (storage.accounts || [])[0];
            if (first) token = first.accessToken;
            if (!token && storage.settings?.facebookAccessToken) token = storage.settings.facebookAccessToken;
        }
        if (!q) return res.status(400).json({ error: 'Missing query' });
        if (!token) return res.status(400).json({ error: 'No account token available' });
        const result = await facebookService.searchLanguages(q, token);
        res.json(result.data || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to search languages', details: error.message });
    }
});

router.get('/interests', async (req, res) => {
    try {
        const { q } = req.query;
        let token = req.query.token;

        if (!token) {
            const storage = getStorage();
            const first = (storage.accounts || [])[0];
            if (first) token = first.accessToken;
            if (!token && storage.settings?.facebookAccessToken) token = storage.settings.facebookAccessToken;
        }

        if (!q) return res.status(400).json({ error: 'Missing query' });
        if (!token) return res.status(400).json({ error: 'No account token available' });

        // Search across interests, behaviors, demographics, life events and job titles
        const results = await facebookService.searchAllTargeting(q, token);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Failed to search targeting', details: error.message });
    }
});

router.post('/ai-audiences', async (req, res) => {
    const framesToCleanup = [];
    try {
        const { websiteUrl, numAudiences, alreadyUsed, mediaFiles } = req.body;
        const storage = getStorage();
        const settings = storage.settings || {};

        if (!settings.geminiApiKey) {
            return res.status(400).json({ error: 'Gemini API key not configured. Please add it in Settings.' });
        }
        if (!websiteUrl) {
            return res.status(400).json({ error: 'Website URL is required' });
        }
        await assertSafeExternalUrl(websiteUrl);

        // Process visual media (scraped product images and video frames)
        const imagesBase64 = [];
        if (Array.isArray(mediaFiles) && mediaFiles.length > 0) {
            const videoProcessor = require('../services/videoProcessor');
            for (const file of mediaFiles) {
                try {
                    if (file && fs.existsSync(file)) {
                        const ext = path.extname(file).toLowerCase();
                        if (['.mp4', '.mov', '.avi', '.webm'].includes(ext)) {
                            // Extract 5 representative frames from video
                            const frames = await videoProcessor.extractFrames(file, 5);
                            frames.forEach(f => {
                                if (f.base64) imagesBase64.push(f.base64);
                            });
                            framesToCleanup.push(...frames);
                        } else if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
                            // Convert image to base64
                            const b64 = fs.readFileSync(file).toString('base64');
                            imagesBase64.push(b64);
                        }
                    }
                } catch (err) {
                    console.error(`Failed to process visual media file ${file}:`, err.message);
                }
            }
        }

        // Use the same product extractor as ad-copy generation. This gives
        // Gemini structured product data and a long product-page description,
        // instead of only a short generic HTML snippet.
        const details = await fetchWebsiteDetails(websiteUrl);
        const requestedCount = Math.max(3, Math.min(20, parseInt(numAudiences, 10) || 3));

        const audiences = await geminiService.generateAudiences(
            settings.geminiApiKey,
            settings.geminiModel,
            details.content,
            requestedCount,
            alreadyUsed || [],
            imagesBase64
        );

        // Validate every Gemini-suggested interest against Facebook's ad interest search API
        // Only keep interests that Facebook confirms as valid targeting options
        const activeAccount = (storage.accounts || []).find(a => a.accountId) || {};
        const token = activeAccount.accessToken || settings.facebookAccessToken;

        if (token) {
            for (const aud of audiences) {
                // Normalise: support new `targeting` array or legacy `interests` array from Gemini
                const rawItems = Array.isArray(aud.targeting) && aud.targeting.length > 0
                    ? aud.targeting
                    : (aud.interests || []).map(i => typeof i === 'string'
                        ? { name: i, type: 'interest' }
                        : { ...i, type: i.type || 'interest' });

                if (!rawItems.length) continue;

                const validatedItems = await facebookService.resolveAllTargeting(rawItems, token, activeAccount.accountId);
                aud.targeting = validatedItems;
                aud.unresolvedTargeting = rawItems
                    .filter(item => !validatedItems.some(valid =>
                        valid.type === (item.type || 'interest') &&
                        String(valid.name || '').trim().toLowerCase() === String(item.name || '').trim().toLowerCase()
                    ))
                    .map(item => ({ name: item.name, type: item.type || 'interest' }));
                delete aud.interests;
                console.log(`Audience "${aud.audienceName}": ${validatedItems.length} validated targeting items`);
            }
        }

        res.json({ audiences });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate audiences', details: error.message });
    } finally {
        if (framesToCleanup.length > 0) {
            try {
                const videoProcessor = require('../services/videoProcessor');
                videoProcessor.cleanupFrames(framesToCleanup);
            } catch (cleanupErr) {
                console.error('Failed to cleanup extracted frames:', cleanupErr.message);
            }
        }
    }
});

router.post('/generate-ad-copy', async (req, res) => {
    const framesToCleanup = [];
    try {
        const { websiteUrl, videoPath } = req.body;
        const storage = getStorage();
        const settings = storage.settings || {};

        if (!settings.geminiApiKey) {
            return res.status(400).json({ error: 'Gemini API key not configured. Please add it in Settings.' });
        }
        if (!websiteUrl) {
            return res.status(400).json({ error: 'Website URL is required' });
        }

        const imagesBase64 = [];
        if (videoPath) {
            try {
                const fs = require('fs');
                const path = require('path');
                // Resolve relative path if uploads/ is passed
                let resolvedPath = videoPath;
                if (!path.isAbsolute(videoPath)) {
                    resolvedPath = path.join(__dirname, '..', videoPath);
                }

                if (fs.existsSync(resolvedPath)) {
                    const videoProcessor = require('../services/videoProcessor');
                    // Extract 5 frames
                    const frames = await videoProcessor.extractFrames(resolvedPath, 5);
                    frames.forEach(f => {
                        if (f.base64) imagesBase64.push(f.base64);
                    });
                    framesToCleanup.push(...frames);
                }
            } catch (err) {
                console.error(`[AdCopy] Failed to process videoPath ${videoPath}:`, err.message);
            }
        }

        const details = await fetchWebsiteDetails(websiteUrl);
        const copy = await geminiService.generateAdCopy(
            settings.geminiApiKey,
            settings.geminiModel,
            websiteUrl,
            details.content,
            details.productName,
            imagesBase64
        );

        res.json({ ...copy, productName: details.productName });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate ad copy', details: error.message });
    } finally {
        if (framesToCleanup.length > 0) {
            try {
                const videoProcessor = require('../services/videoProcessor');
                videoProcessor.cleanupFrames(framesToCleanup);
            } catch (cleanupErr) {
                console.error('Failed to cleanup extracted frames:', cleanupErr.message);
            }
        }
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
    // A draft ID and checkpoint make this endpoint resumable. If a later
    // Facebook call fails, retrying reuses every object that already exists
    // instead of starting a second campaign.
    const draftId = req.body.draftId || uuidv4();
    const checkpoint = normalizeRetryState(req.body.retryState, draftId);
    const progress = { failedStep: 'validation', failedIndex: null, requestParams: null };

    try {
        // Data comes from campaign.js as: { campaign, adsets: step2, creative: step3 }
        const { campaign, adsets: step2, creative: step3 } = req.body;
        if (!campaign || !step2 || !step3) {
            return res.status(400).json({ error: 'Campaign details are incomplete.' });
        }

        const storage = getStorage();
        const accountRecord = (storage.accounts || []).find(a => a.id === campaign.accountId);
        if (!accountRecord) return res.status(400).json({ error: 'Account not found. Please select a valid account.' });

        const accountId = accountRecord.accountId;
        let token = accountRecord.accessToken || storage.settings?.facebookAccessToken;
        if (!token) return res.status(400).json({ error: 'Access token is required. Please set it in settings or select another account.' });
        const selectedPageId = step3.pageId || accountRecord.pageId || '';
        if (!selectedPageId) {
            return res.status(400).json({ error: 'Facebook Page is required.' });
        }

        // Cache incoming settings on the checkpoint for comparison/saving
        checkpoint._incomingPixel = step2.pixel || '';
        checkpoint._incomingUrl = step2.url || '';
        checkpoint._incomingHeadline = step3.headline || '';
        checkpoint._incomingDescription = step3.description || '';
        checkpoint._incomingCta = step3.cta || 'SHOP_NOW';
        checkpoint._incomingPageId = selectedPageId || '';
        checkpoint._incomingAudiencesHash = JSON.stringify(step2.audiences || []);

        // Compare and invalidate cached resources if parameters changed on retry
        if (checkpoint.campaignId) {
            if (checkpoint.accountId && checkpoint.accountId !== campaign.accountId) {
                console.log(`[Retry] Ad account changed from ${checkpoint.accountId} to ${campaign.accountId}. Recreating campaign.`);
                checkpoint.campaignId = null;
                checkpoint.adsets = [];
                checkpoint.creatives = [];
                checkpoint.ads = [];
            }
            
            const incomingObjective = campaign.objective || 'OUTCOME_SALES';
            if ((checkpoint.pixel && checkpoint.pixel !== checkpoint._incomingPixel) || 
                (checkpoint.objective && checkpoint.objective !== incomingObjective)) {
                console.log(`[Retry] Pixel or Objective changed. Recreating adsets.`);
                checkpoint.adsets = [];
                checkpoint.creatives = [];
                checkpoint.ads = [];
            }

            if (checkpoint.audiencesHash && checkpoint.audiencesHash !== checkpoint._incomingAudiencesHash) {
                console.log(`[Retry] Audiences targeting changed. Recreating adsets.`);
                checkpoint.adsets = [];
                checkpoint.creatives = [];
                checkpoint.ads = [];
            }

            if ((checkpoint.pageId && checkpoint.pageId !== checkpoint._incomingPageId) ||
                (checkpoint.url && checkpoint.url !== checkpoint._incomingUrl) ||
                (checkpoint.headline !== undefined && checkpoint.headline !== checkpoint._incomingHeadline) ||
                (checkpoint.description !== undefined && checkpoint.description !== checkpoint._incomingDescription) ||
                (checkpoint.cta && checkpoint.cta !== checkpoint._incomingCta)) {
                console.log(`[Retry] Creative parameters changed. Recreating creatives.`);
                checkpoint.creatives = [];
                checkpoint.ads = [];
            }
        }
        const connectedPages = await facebookService.getConnectedInstagram(token);
        const selectedPage = (connectedPages.data || []).find(page => String(page.id) === String(selectedPageId));
        if (!selectedPage) {
            return res.status(400).json({ error: 'Selected Facebook Page is not connected to the selected ad account.' });
        }
        const linkedInstagramId = selectedPage.instagram_business_account?.id
            ? String(selectedPage.instagram_business_account.id)
            : '';
        const requestedInstagramId = step3.instagramId ? String(step3.instagramId) : '';
        if (requestedInstagramId && requestedInstagramId !== linkedInstagramId) {
            return res.status(400).json({
                error: 'The selected Instagram account is not linked to the selected Facebook Page.'
            });
        }

        // Auto-detect offline event dataset ID from recent ads of the ad account
        let offlineDatasetId = null;
        try {
            const adsUrl = `https://graph.facebook.com/v25.0/act_${accountId}/ads?fields=tracking_specs&limit=10&access_token=${token}`;
            const adsRes = await fetch(adsUrl);
            const adsData = await adsRes.json();
            if (adsData.data && adsData.data.length > 0) {
                for (const adItem of adsData.data) {
                    if (adItem.tracking_specs) {
                        for (const spec of adItem.tracking_specs) {
                            if (spec["action.type"] && spec["action.type"].includes("onsite_conversion") && spec.conversion_id) {
                                const cid = spec.conversion_id[0];
                                if (cid) {
                                    offlineDatasetId = cid;
                                    break;
                                }
                            }
                        }
                    }
                    if (offlineDatasetId) break;
                }
            }
        } catch (e) {
            console.error("Failed to auto-detect offline dataset ID:", e.message);
        }
        if (offlineDatasetId) {
            console.log(`Auto-detected offline event dataset ID: ${offlineDatasetId}`);
        }

        const creativeAds = normalizeCreativeAds(step3);
        if (!creativeAds.length || creativeAds.some(ad => !ad.media)) {
            return res.status(400).json({ error: 'Every ad must have an uploaded media file.' });
        }

        // Upload only media missing from the checkpoint. A failed upload can
        // therefore be retried without uploading successful media again.
        const uploadedMedia = [];
        for (let adIndex = 0; adIndex < creativeAds.length; adIndex++) {
            const ad = creativeAds[adIndex];
            const savedMedia = checkpoint.uploadedMedia.find(item =>
                item.index === adIndex &&
                item.media === ad.media &&
                (item.imageHash || item.videoId)
            );
            if (savedMedia) {
                uploadedMedia.push({ 
                    ...ad, 
                    imageHash: savedMedia.imageHash || null, 
                    videoId: savedMedia.videoId || null,
                    videoThumbnailUrl: savedMedia.videoThumbnailUrl || null,
                    thumbnailHash: savedMedia.thumbnailHash || null
                });
                continue;
            }

            progress.failedStep = 'media upload';
            progress.failedIndex = adIndex;
            progress.requestParams = { name: ad.name, media: ad.media };

            // Verify if the local file exists on disk (crucial for Render ephemeral storage restarts)
            if (ad.media && !fs.existsSync(ad.media)) {
                throw new Error(`The media file for "${ad.name}" was removed because the server restarted. Please re-download or re-upload the video/image.`);
            }

            let imageHash = null;
            let videoId = null;
            let videoThumbnailUrl = null;
            let thumbnailHash = null;

            const ext = path.extname(ad.media).toLowerCase();
            if (['.mp4', '.mov', '.avi', '.webm'].includes(ext)) {
                const videoRes = await facebookService.uploadVideo(accountId, token, ad.media);
                videoId = videoRes.id || null;
                if (!videoId) throw new Error(`Facebook did not return a video ID for ${ad.name}.`);
                videoThumbnailUrl = '';
                
                // If a thumbnail file is provided, upload it to Meta
                if (ad.thumbnail) {
                    try {
                        const thumbRes = await facebookService.uploadImage(accountId, token, ad.thumbnail);
                        const firstKey = Object.keys(thumbRes.images || {})[0];
                        thumbnailHash = firstKey ? thumbRes.images[firstKey].hash : null;
                    } catch (thumbErr) {
                        console.error('Failed to upload custom video thumbnail to FB:', thumbErr.message);
                    }
                }
            } else {
                const imageRes = await facebookService.uploadImage(accountId, token, ad.media);
                const firstKey = Object.keys(imageRes.images || {})[0];
                imageHash = firstKey ? imageRes.images[firstKey].hash : null;
                if (!imageHash) throw new Error(`Facebook did not return an image hash for ${ad.name}.`);
            }
            checkpoint.uploadedMedia = checkpoint.uploadedMedia.filter(item => item.index !== adIndex);
            checkpoint.uploadedMedia.push({ index: adIndex, name: ad.name, media: ad.media, imageHash, videoId, videoThumbnailUrl, thumbnail: ad.thumbnail || null, thumbnailHash });
            saveRetryCheckpoint(draftId, req.body.campaign, checkpoint, progress);
            uploadedMedia.push({ ...ad, imageHash, videoId, videoThumbnailUrl, thumbnailHash });
        }

        const isCBO = campaign.budgetType === 'CBO';
        const campaignParams = {
            name: campaign.name,
            objective: campaign.objective || 'OUTCOME_SALES',
            status: 'ACTIVE',
            is_adset_budget_sharing_enabled: false,
            special_ad_categories: campaign.specialAdCategory && campaign.specialAdCategory !== 'NONE'
                ? [campaign.specialAdCategory] : []
        };
        if (isCBO) {
            campaignParams.daily_budget = Math.round(campaign.budgetAmount * 100); // cents
            campaignParams.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
        }

        let campaignId = checkpoint.campaignId;
        if (!campaignId) {
            progress.failedStep = 'campaign';
            progress.failedIndex = null;
            progress.requestParams = campaignParams;
            const campaignResponse = await facebookService.createCampaign(accountId, token, campaignParams);
            campaignId = campaignResponse.id;
            if (!campaignId) throw new Error('Facebook did not return a campaign ID.');
            checkpoint.campaignId = campaignId;
            saveRetryCheckpoint(draftId, campaign, checkpoint, progress);
        }

        const results = {
            campaignId,
            adsets: checkpoint.adsets.map(item => item.id),
            ads: checkpoint.ads.map(item => item.id)
        };
        const pageId = selectedPageId;

        // 1. Collect all unique locations to resolve upfront in a single batch
        const allLocationNames = new Set();
        (step2.audiences || []).forEach(audience => {
            (audience.locationsInclude || []).forEach(l => { if (l.name && !l.key) allLocationNames.add(l.name); });
            (audience.locationsExclude || []).forEach(l => { if (l.name && !l.key) allLocationNames.add(l.name); });
        });

        const locationCache = new Map();
        if (allLocationNames.size > 0) {
            try {
                const resolved = await facebookService.resolveLocationNames(Array.from(allLocationNames), token);
                resolved.forEach(r => {
                    locationCache.set(r.name, { key: r.key, type: r.type, name: r.name });
                });
            } catch (err) {
                console.error('Failed to resolve locations upfront:', err.message);
            }
        }

        // Helper to validate and get custom audiences owned by this account (cached/fetched once)
        let accountAudienceIdsCached = null;
        const getAccountAudienceIds = async () => {
            if (accountAudienceIdsCached) return accountAudienceIdsCached;
            const audienceIds = new Set();
            let url = `https://graph.facebook.com/v25.0/act_${accountId}/customaudiences?fields=id&limit=500&access_token=${token}`;
            try {
                while (url) {
                    const res = await fetch(url);
                    if (!res.ok) break;
                    const data = await res.json();
                    (data.data || []).forEach(a => audienceIds.add(a.id));
                    url = data.paging?.next || null;
                }
            } catch (e) {
                console.warn('Failed to fetch account custom audiences:', e.message);
            }
            accountAudienceIdsCached = audienceIds;
            return audienceIds;
        };

        // 2. Create all Ad Sets in parallel
        const adsetPromises = (step2.audiences || []).map(async (audience, audienceIndex) => {
            const existingAdset = checkpoint.adsets.find(item => item.audienceIndex === audienceIndex);
            let adsetId = existingAdset?.id;

            if (adsetId) {
                return { audienceIndex, adsetId };
            }

            // Map resolved locations
            const resolvedInclude = [];
            (audience.locationsInclude || []).forEach(l => {
                if (!l.name && l.key) {
                    resolvedInclude.push({ key: l.key, type: l.type || 'country', name: l.name });
                } else if (locationCache.has(l.name)) {
                    resolvedInclude.push(locationCache.get(l.name));
                }
            });

            const resolvedExclude = [];
            (audience.locationsExclude || []).forEach(l => {
                if (!l.name && l.key) {
                    resolvedExclude.push({ key: l.key, type: l.type || 'country', name: l.name });
                } else if (locationCache.has(l.name)) {
                    resolvedExclude.push(locationCache.get(l.name));
                }
            });

            const geoLocations = buildGeoLocations(resolvedInclude);
            const excludedGeo = buildGeoLocations(resolvedExclude);
            const genders = audience.gender === 'male' ? [1] : audience.gender === 'female' ? [2] : [];
            const enhancements = step3.enhancements || {};
            const targeting = {
                age_min: audience.ageMin || 18,
                age_max: audience.ageMax || 65,
                geo_locations: Object.keys(geoLocations).length > 0 ? geoLocations : { countries: ['IN'] },
                targeting_automation: {
                    advantage_audience: enhancements.advantageAudience ? 1 : 0
                }
            };
            if (Array.isArray(audience.languages) && audience.languages.length > 0) {
                targeting.locales = audience.languages.map(l => parseInt(l.key)).filter(Boolean);
            }
            if (genders.length) targeting.genders = genders;
            if (Object.keys(excludedGeo).length > 0) targeting.excluded_geo_locations = excludedGeo;

            // Resolve detailed targeting keywords
            const rawTargeting = Array.isArray(audience.targeting) && audience.targeting.length > 0
                ? audience.targeting
                : (audience.interests || []).map(i => ({ ...i, type: 'interest' }));

            if (rawTargeting.length > 0) {
                try {
                    const resolvedTargeting = await facebookService.resolveAllTargeting(rawTargeting, token, accountId);
                    const typeToField = {
                        interest:       'interests',
                        behavior:       'behaviors',
                        demographic:    'demographics',
                        life_event:     'life_events',
                        job_title:      'work_positions',
                        employer:       'work_employers',
                        field_of_study: 'education_majors',
                        school:         'education_schools'
                    };
                    const flexSpec = {};
                    resolvedTargeting.forEach(item => {
                        const field = typeToField[item.type] || 'interests';
                        if (!flexSpec[field]) flexSpec[field] = [];
                        flexSpec[field].push({ id: item.id });
                    });
                    if (Object.keys(flexSpec).length > 0) targeting.flexible_spec = [flexSpec];
                } catch (resolveErr) {
                    console.error('Failed to resolve targeting items:', resolveErr.message);
                }
            }

            if (targeting.custom_audiences?.length || targeting.excluded_custom_audiences?.length) {
                const validIds = await getAccountAudienceIds();
                if (targeting.custom_audiences?.length) {
                    targeting.custom_audiences = targeting.custom_audiences.filter(a => validIds.has(a.id));
                    if (targeting.custom_audiences.length === 0) delete targeting.custom_audiences;
                }
                if (targeting.excluded_custom_audiences?.length) {
                    targeting.excluded_custom_audiences = targeting.excluded_custom_audiences.filter(a => validIds.has(a.id));
                    if (targeting.excluded_custom_audiences.length === 0) delete targeting.excluded_custom_audiences;
                }
            }

            const obj = campaign.objective || 'OUTCOME_SALES';
            let promotedObject = undefined;
            let destinationType = undefined;

            if (obj === 'OUTCOME_SALES') {
                destinationType = 'WEBSITE';
                if (step2.pixel) {
                    promotedObject = {
                        pixel_id: step2.pixel,
                        custom_event_type: step2.conversionEvent || 'PURCHASE'
                    };
                }
            } else if (obj === 'OUTCOME_LEADS') {
                if (step2.pixel) {
                    destinationType = 'WEBSITE';
                    promotedObject = {
                        pixel_id: step2.pixel,
                        custom_event_type: step2.conversionEvent || 'LEAD'
                    };
                } else {
                    destinationType = 'ON_AD';
                    promotedObject = { page_id: pageId };
                }
            } else if (obj === 'OUTCOME_ENGAGEMENT') {
                if (step2.pixel) {
                    destinationType = 'WEBSITE';
                    promotedObject = {
                        pixel_id: step2.pixel,
                        custom_event_type: step2.conversionEvent || 'PURCHASE'
                    };
                } else if (step2.optimizationGoal === 'PAGE_LIKES') {
                    destinationType = 'FACEBOOK_PAGE';
                    promotedObject = { page_id: pageId };
                }
            } else if (obj === 'OUTCOME_TRAFFIC' || obj === 'OUTCOME_AWARENESS') {
                destinationType = 'WEBSITE';
            }

            const adsetParams = {
                campaign_id: campaignId,
                name: audience.name,
                optimization_goal: step2.optimizationGoal || 'OFFSITE_CONVERSIONS',
                billing_event: 'IMPRESSIONS',
                status: 'ACTIVE',
                targeting,
                ...(promotedObject && { promoted_object: promotedObject }),
                ...(destinationType && { destination_type: destinationType }),
                start_time: campaign.scheduleStart ? parseIsoDate(campaign.scheduleStart) : undefined
            };
            if (!isCBO) {
                adsetParams.daily_budget = Math.round(campaign.budgetAmount * 100);
                adsetParams.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
            }
            if (campaign.scheduleEnd) adsetParams.end_time = parseIsoDate(campaign.scheduleEnd);

            try {
                const adsetResponse = await facebookService.createAdSet(accountId, token, adsetParams);
                adsetId = adsetResponse.id;
            } catch (adsetErr) {
                if (adsetErr.errorSubcode === 1870247) {
                    const errorMsg = adsetErr.details?.error?.error_user_msg || '';
                    const altMatch = errorMsg.match(/Relevant alternative options:\s*(\[.*\])/);
                    if (altMatch) {
                        try {
                            const alternatives = JSON.parse(altMatch[1]);
                            if (adsetParams.targeting.flexible_spec) {
                                for (const spec of adsetParams.targeting.flexible_spec) {
                                    if (spec.interests) {
                                        for (const alt of alternatives) {
                                            const idx = spec.interests.findIndex(i => i.id === alt.deprecated_interest_id);
                                            if (idx !== -1) {
                                                spec.interests[idx] = { id: alt.alternative_interest_id, name: alt.alternative_interest_name };
                                            }
                                        }
                                    }
                                }
                            }
                            progress.requestParams = adsetParams;
                            const retryResponse = await facebookService.createAdSet(accountId, token, adsetParams);
                            adsetId = retryResponse.id;
                        } catch (parseErr) {
                            delete adsetParams.targeting.excluded_custom_audiences;
                            delete adsetParams.targeting.custom_audiences;
                            progress.requestParams = adsetParams;
                            const retryResponse = await facebookService.createAdSet(accountId, token, adsetParams);
                            adsetId = retryResponse.id;
                        }
                    } else {
                        delete adsetParams.targeting.excluded_custom_audiences;
                        delete adsetParams.targeting.custom_audiences;
                        progress.requestParams = adsetParams;
                        const retryResponse = await facebookService.createAdSet(accountId, token, adsetParams);
                        adsetId = retryResponse.id;
                    }
                } else {
                    progress.failedStep = 'ad set';
                    progress.failedIndex = audienceIndex;
                    progress.requestParams = adsetParams;
                    throw adsetErr;
                }
            }

            if (!adsetId) throw new Error(`Facebook did not return an ad set ID for ${audience.name}.`);
            
            // Push to checkpoint and save status
            checkpoint.adsets.push({ audienceIndex, id: adsetId });
            saveRetryCheckpoint(draftId, campaign, checkpoint, progress);

            return { audienceIndex, adsetId };
        });

        // Resolve all adsets concurrently
        const adsetResults = await Promise.all(adsetPromises);
        const adsetMap = new Map();
        adsetResults.forEach(r => {
            adsetMap.set(r.audienceIndex, r.adsetId);
            if (!results.adsets.includes(r.adsetId)) results.adsets.push(r.adsetId);
        });

        // 3. Create all Ad Creatives and Ads in parallel
        const adPromises = [];
        const enhancements = step3.enhancements || {};

        for (let audienceIndex = 0; audienceIndex < (step2.audiences || []).length; audienceIndex++) {
            const audience = step2.audiences[audienceIndex];
            const adsetId = adsetMap.get(audienceIndex);

            for (let adIndex = 0; adIndex < uploadedMedia.length; adIndex++) {
                const ad = uploadedMedia[adIndex];
                const creativeKey = `${audienceIndex}:${adIndex}`;

                adPromises.push((async () => {
                    let creativeId = checkpoint.creatives.find(item => item.key === creativeKey)?.id;
                    let adId = checkpoint.ads.find(item => item.key === creativeKey)?.id;
                    
                    const textVariation = ad.primaryText || '';
                    const destinationUrl = appendUtmParams(step2.url);
                    const dofFeatures = {};
                    
                    if (enhancements.autoCreative) {
                        dofFeatures.standard_enhancements_catalog = { enroll_status: 'OPT_IN' };
                    }
                    if (enhancements.textOptimizations) {
                        dofFeatures.text_overlay_translation = { enroll_status: 'OPT_IN' };
                    }

                    const creativeParams = {
                        name: `${campaign.name} — ${audience.name} — ${ad.name}`,
                        url_tags: 'utm_medium={{ad.name}}&utm_campaign={{campaign.name}}&utm_content={{adset.name}}',
                        contextual_multi_ads: { enroll_status: enhancements.multiAdvertiser ? 'OPT_IN' : 'OPT_OUT' },
                        ...(Object.keys(dofFeatures).length > 0 && {
                            degrees_of_freedom_spec: { creative_features_spec: dofFeatures }
                        }),
                        object_story_spec: {
                            page_id: pageId,
                            link_data: {
                                message: textVariation,
                                link: destinationUrl,
                                ...(step3.headline  && { name: step3.headline }),
                                ...(step3.description && { description: step3.description }),
                                call_to_action: { type: step3.cta || 'SHOP_NOW', value: { link: destinationUrl } }
                            }
                        }
                    };
                    if (ad.imageHash) creativeParams.object_story_spec.link_data.image_hash = ad.imageHash;
                    if (ad.videoId) {
                        let thumbnailUrl = ad.videoThumbnailUrl || null;
                        creativeParams.object_story_spec.video_data = {
                            video_id: ad.videoId,
                            message: textVariation,
                            ...(step3.headline    && { title: step3.headline }),
                            ...(step3.description && { link_description: step3.description }),
                            call_to_action: { type: step3.cta || 'SHOP_NOW', value: { link: destinationUrl } }
                        };
                        if (ad.thumbnailHash) {
                            creativeParams.object_story_spec.video_data.image_hash = ad.thumbnailHash;
                        } else if (thumbnailUrl) {
                            creativeParams.object_story_spec.video_data.image_url = thumbnailUrl;
                        }
                        delete creativeParams.object_story_spec.link_data;
                    }
                    if (requestedInstagramId) creativeParams.object_story_spec.instagram_user_id = requestedInstagramId;

                    if (!creativeId) {
                        progress.failedStep = 'creative';
                        progress.failedIndex = { audienceIndex, adIndex };
                        progress.requestParams = creativeParams;
                        const creativeResponse = await facebookService.createAdCreative(accountId, token, creativeParams);
                        creativeId = creativeResponse.id;
                        if (!creativeId) throw new Error(`Facebook did not return a creative ID for ${ad.name}.`);
                        checkpoint.creatives.push({ key: creativeKey, id: creativeId });
                        saveRetryCheckpoint(draftId, campaign, checkpoint, progress);
                    }

                    if (!adId) {
                        const adParams = {
                            name: ad.name,
                            adset_id: adsetId,
                            creative: { creative_id: creativeId },
                            status: 'ACTIVE'
                        };
                        progress.failedStep = 'ad';
                        progress.failedIndex = { audienceIndex, adIndex };
                        progress.requestParams = adParams;
                        const adResponse = await facebookService.createAd(accountId, token, adParams);
                        adId = adResponse.id;
                        if (!adId) throw new Error(`Facebook did not return an ad ID for ${ad.name}.`);
                        checkpoint.ads.push({ key: creativeKey, id: adId });
                        saveRetryCheckpoint(draftId, campaign, checkpoint, progress);
                    }

                    if (!results.ads.includes(adId)) results.ads.push(adId);
                    return adId;
                })());
            }
        }

        // Await all creative and ad creations concurrently
        await Promise.all(adPromises);

        if (!storage.recentCampaigns) storage.recentCampaigns = [];
        storage.recentCampaigns = storage.recentCampaigns.filter(item => item.draftId !== draftId);
        storage.recentCampaigns.unshift({
            id: uuidv4(),
            draftId,
            campaignId,
            accountId: campaign.accountId || null,
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
        const storage = getStorage();
        const providerDetails = error.provider === 'facebook' ? {
            code: error.code,
            errorSubcode: error.errorSubcode,
            type: error.type,
            fbtraceId: error.fbtraceId,
            errorData: error.details?.error?.error_data
        } : undefined;
        let detail = providerDetails?.code
            ? `${error.message} (Facebook code ${providerDetails.code}${providerDetails.errorSubcode ? `/${providerDetails.errorSubcode}` : ''})`
            : error.message;

        if (providerDetails?.errorSubcode === 1815645 || (providerDetails?.code === 100 && error.message.toLowerCase().includes('promotable'))) {
            detail += "\n\n💡 Troubleshooting Hint: This error means the Facebook Page or Instagram account you selected is not linked/authorized to your Ad Account in Meta Business Manager. To fix this:\n1. Open Meta Business Manager Settings (business.facebook.com).\n2. Go to 'Accounts' > 'Pages' and select your page.\n3. Click 'Connected Assets' and make sure your Ad Account is listed there. If not, click 'Add Assets' and add it.\n4. Go to 'Instagram Accounts' and ensure your Instagram account is linked to both the Page and Ad Account.";
        }

        if (providerDetails?.errorSubcode === 1443226) {
            detail += "\n\n💡 Troubleshooting Hint: This video ad requires a thumbnail. Please upload a custom thumbnail image for this video in step 3 (Ad Creative), or ensure that the video URL has a valid default preview image.";
        }
        const failedRecord = {
            id: `retry-${draftId}`,
            draftId,
            campaignId: checkpoint.campaignId || null,
            accountId: req.body.campaign?.accountId || null,
            name: req.body.campaign?.name || 'Unnamed campaign',
            createdAt: new Date().toISOString(),
            status: 'failed',
            retryable: Boolean(checkpoint.campaignId || checkpoint.uploadedMedia.length),
            failedStep: progress.failedStep,
            details: detail,
            checkpoint
        };
        storage.recentCampaigns = (storage.recentCampaigns || []).filter(item => item.draftId !== draftId);
        storage.recentCampaigns.unshift(failedRecord);
        if (storage.recentCampaigns.length > 50) storage.recentCampaigns = storage.recentCampaigns.slice(0, 50);
        saveStorage(storage);

        console.error('Campaign creation error:', {
            step: progress.failedStep,
            index: progress.failedIndex,
            params: progress.requestParams,
            message: error.message,
            provider: error.provider,
            code: error.code,
            errorSubcode: error.errorSubcode,
            type: error.type,
            fbtraceId: error.fbtraceId
        });
        res.status(error.provider === 'facebook' ? 400 : 500).json({
            error: error.provider === 'facebook' ? 'Facebook rejected a campaign request.' : 'Failed to create campaign',
            details: detail,
            facebook: providerDetails,
            failedStep: progress.failedStep,
            failedIndex: progress.failedIndex,
            requestParams: progress.requestParams,
            retryable: failedRecord.retryable,
            retryState: checkpoint
        });
    }
});

function normalizeCreativeAds(step3 = {}) {
    if (Array.isArray(step3.ads) && step3.ads.length > 0) {
        const total = step3.ads.length;
        return step3.ads.map((ad, index) => ({
            name: total === 1 ? 'Single content-Reel' : `Content-${index + 1} Reel`,
            media: ad.media || null,
            primaryText: ad.primaryText || '',
            mediaFile: ad.mediaFile || '',
            thumbnail: ad.thumbnail || null,
            thumbnailFile: ad.thumbnailFile || null
        }));
    }

    const legacyVariations = Array.isArray(step3.variations) ? step3.variations : [];
    return legacyVariations.map((primaryText, index) => ({
        name: legacyVariations.length === 1 ? 'Single content-Reel' : `Content-${index + 1} Reel`,
        media: index === 0 ? step3.media || null : null,
        primaryText: typeof primaryText === 'string' ? primaryText : primaryText.primaryText || ''
    }));
}

function normalizeRetryState(state, draftId) {
    const source = state && typeof state === 'object' ? state : {};
    const list = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
    return {
        draftId,
        campaignId: source.campaignId ? String(source.campaignId) : null,
        uploadedMedia: list(source.uploadedMedia),
        adsets: list(source.adsets),
        creatives: list(source.creatives),
        ads: list(source.ads),
        
        // Preserve settings variables in checkpoint
        accountId: source.accountId || null,
        objective: source.objective || null,
        pixel: source.pixel || null,
        url: source.url || null,
        headline: source.headline || null,
        description: source.description || null,
        cta: source.cta || null,
        pageId: source.pageId || null,
        audiencesHash: source.audiencesHash || null
    };
}

function saveRetryCheckpoint(draftId, campaign, checkpoint, progress) {
    if (!campaign) return;
    const storage = getStorage();
    
    // Save current parameters in the checkpoint so we can compare them on retry
    checkpoint.accountId = campaign.accountId;
    checkpoint.objective = campaign.objective || 'OUTCOME_SALES';
    checkpoint.pixel = checkpoint._incomingPixel || '';
    checkpoint.url = checkpoint._incomingUrl || '';
    checkpoint.headline = checkpoint._incomingHeadline || '';
    checkpoint.description = checkpoint._incomingDescription || '';
    checkpoint.cta = checkpoint._incomingCta || 'SHOP_NOW';
    checkpoint.pageId = checkpoint._incomingPageId || '';
    checkpoint.audiencesHash = checkpoint._incomingAudiencesHash || '';

    storage.recentCampaigns = (storage.recentCampaigns || []).filter(item => item.draftId !== draftId);
    storage.recentCampaigns.unshift({
        id: `retry-${draftId}`,
        draftId,
        campaignId: checkpoint.campaignId || null,
        name: campaign.name || 'Unnamed campaign',
        createdAt: new Date().toISOString(),
        status: 'in_progress',
        retryable: true,
        failedStep: progress.failedStep,
        checkpoint
    });
    if (storage.recentCampaigns.length > 50) storage.recentCampaigns = storage.recentCampaigns.slice(0, 50);
    saveStorage(storage);
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
        const m = html.match(regex);
        return m ? m[1].replace(/\s+/g, ' ').trim() : '';
    };

    const productName =
        firstMatch(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
        firstMatch(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i) ||
        firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, '') ||
        firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i).replace(/<[^>]+>/g, '') ||
        'Product';

    const metaDescription =
        firstMatch(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
        firstMatch(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);

    // Brand / store name
    const brand =
        firstMatch(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ||
        firstMatch(/<meta[^>]+name=["']twitter:site["'][^>]+content=["']([^"']+)["']/i) || '';

    // Price
    const priceAmount =
        firstMatch(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["']/i) ||
        firstMatch(/["']price["']\s*:\s*["']([0-9.,]+)["']/i) || '';
    const priceCurrency =
        firstMatch(/<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([^"']+)["']/i) || '';

    // JSON-LD Product nodes
    const structuredProducts = [];
    for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
            const parsed = JSON.parse(m[1].trim());
            const nodes = Array.isArray(parsed) ? parsed : [parsed];
            nodes.forEach(node => {
                const t = node && node['@type'];
                if (node && (t === 'Product' || (Array.isArray(t) && t.includes('Product')))) {
                    structuredProducts.push(node);
                }
            });
        } catch { /* ignore malformed blocks */ }
    }

    // Pull bullet/feature list items from the page (product details, specs, benefits)
    const listItems = [];
    for (const m of html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
        const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (text.length > 8 && text.length < 220) listItems.push(text);
    }
    const featuresBlock = listItems.length
        ? `\nProduct features / bullet points:\n${listItems.slice(0, 25).map(l => `• ${l}`).join('\n')}`
        : '';

    // Clean page text — keep meaningful content, trim to 8 000 chars
    const pageText = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);

    const structuredDetails = structuredProducts.length
        ? `\nStructured product data (JSON-LD):\n${JSON.stringify(structuredProducts.slice(0, 3), null, 2).slice(0, 6000)}`
        : '';

    return {
        productName,
        content: [
            `URL: ${websiteUrl}`,
            brand            ? `Brand/Store: ${brand}` : '',
            `Product name: ${productName}`,
            metaDescription  ? `Description: ${metaDescription}` : '',
            priceAmount      ? `Price: ${priceCurrency} ${priceAmount}`.trim() : '',
            featuresBlock,
            structuredDetails,
            `\nFull page content:\n${pageText}`
        ].filter(Boolean).join('\n')
    };
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
        let campaigns = storage.recentCampaigns || [];
        const { accountId } = req.query;
        if (accountId) {
            campaigns = campaigns.filter(c => c.accountId === accountId);
        }
        res.json(campaigns);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch recent campaigns', details: error.message });
    }
});

module.exports = router;
