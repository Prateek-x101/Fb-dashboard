const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const facebookService = require('../services/facebook');
const geminiService = require('../services/gemini');

const storagePath = path.join(__dirname, '..', 'config', 'storage.json');

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
        const { accountId, token, campaignData, adsets, creative, pageId } = req.body;
        
        // 1. Create Campaign
        const campaignResponse = await facebookService.createCampaign(accountId, token, {
            name: campaignData.name,
            objective: campaignData.objective,
            status: campaignData.status,
            special_ad_categories: campaignData.special_ad_categories,
            daily_budget: campaignData.daily_budget,
            bid_strategy: campaignData.bid_strategy
        });
        const campaignId = campaignResponse.id;
        
        // 2. Upload Media if needed (simplified)
        let imageHash = creative.image_hash;
        let videoId = creative.video_id;
        
        if (creative.filePath) {
            const ext = path.extname(creative.filePath).toLowerCase();
            if (['.mp4', '.mov'].includes(ext)) {
                const videoRes = await facebookService.uploadVideo(accountId, token, creative.filePath);
                videoId = videoRes.id;
            } else {
                const imageRes = await facebookService.uploadImage(accountId, token, creative.filePath);
                imageHash = imageRes.images[Object.keys(imageRes.images)[0]].hash;
            }
        }
        
        const results = { campaignId, adsets: [], ads: [] };
        
        // 3. Create AdSets and Ads
        for (const adset of adsets) {
            const adsetResponse = await facebookService.createAdSet(accountId, token, {
                campaign_id: campaignId,
                name: adset.name,
                optimization_goal: adset.optimization_goal,
                billing_event: adset.billing_event,
                daily_budget: adset.daily_budget,
                start_time: adset.start_time,
                end_time: adset.end_time,
                status: adset.status,
                targeting: adset.targeting,
                promoted_object: adset.promoted_object
            });
            results.adsets.push(adsetResponse.id);
            
            // 4. Create creatives and ads for each variation
            for (let i = 0; i < (creative.variations || []).length; i++) {
                const textVariation = creative.variations[i];
                
                const creativeParams = {
                    name: `${creative.name} - Var ${i+1}`,
                    page_id: pageId,
                    link: creative.link,
                    message: textVariation,
                    headline: creative.headline,
                    description: creative.description,
                    call_to_action_type: creative.call_to_action_type
                };
                
                if (imageHash) creativeParams.image_hash = imageHash;
                if (videoId) creativeParams.video_id = videoId;
                
                const creativeResponse = await facebookService.createAdCreative(accountId, token, creativeParams);
                
                const adResponse = await facebookService.createAd(accountId, token, {
                    name: `${creative.name} - Ad ${i+1}`,
                    adset_id: adsetResponse.id,
                    creative_id: creativeResponse.id,
                    status: 'PAUSED'
                });
                
                results.ads.push(adResponse.id);
            }
        }
        
        // Save to storage
        const storage = getStorage();
        if (!storage.recentCampaigns) storage.recentCampaigns = [];
        storage.recentCampaigns.push({
            id: uuidv4(),
            campaignId,
            name: campaignData.name,
            createdAt: new Date().toISOString(),
            status: 'success',
            details: results
        });
        saveStorage(storage);
        
        res.json({ success: true, results });
    } catch (error) {
        console.error('Campaign creation error:', error);
        res.status(500).json({ error: 'Failed to create campaign', details: error.message });
    }
});

router.get('/recent', (req, res) => {
    try {
        const storage = getStorage();
        res.json(storage.recentCampaigns || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch recent campaigns', details: error.message });
    }
});

module.exports = router;
