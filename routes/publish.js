const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');
const geminiService = require('../services/gemini');
const { getStorage } = require('../services/storage');

// Helper sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Endpoint to generate post captions with emojis and hashtags using Gemini AI
router.post('/generate-caption', async (req, res) => {
    try {
        const { topic, style } = req.body;
        if (!topic) {
            return res.status(400).json({ error: 'Topic or description is required for caption generation.' });
        }

        let prompt = '';
        if (style === 'viral') {
            prompt = `Write a short, viral-style social media caption (reels/tiktok) for a post about: "${topic}".
Include a very strong hook in the first line, use highly contextual emojis throughout, and append 5-7 popular, relevant hashtags. Keep it concise, engaging, and modern. Do not include titles, quotes, or markdown formatting wrapper.`;
        } else if (style === 'sales') {
            prompt = `Write a persuasive product sales caption for: "${topic}".
Highlight key features, benefits, and include a clear, compelling Call to Action (CTA) at the end. Use structured bullet points (with emojis) and add 4-6 related hashtags. Do not include markdown formatting wrapper.`;
        } else {
            prompt = `Write a clean, informative description for: "${topic}".
Include useful context, write in a professional yet approachable tone, use subtle emojis, and add 3-5 relevant hashtags. Do not include markdown formatting wrapper.`;
        }

        const caption = await geminiService.generateText(prompt);
        res.json({ success: true, caption: caption.trim() });
    } catch (error) {
        console.error("AI Caption generation error:", error);
        res.status(500).json({ error: 'AI generation failed', details: error.message });
    }
});

// Endpoint to post to FB Pages & Instagram accounts
router.post('/post', async (req, res) => {
    try {
        const { pageIds = [], instagramIds = [], videos = [], caption = '' } = req.body;

        if (!videos.length) {
            return res.status(400).json({ error: 'Please prepare at least one video to publish.' });
        }
        if (!pageIds.length && !instagramIds.length) {
            return res.status(400).json({ error: 'Please select at least one Facebook Page or Instagram Account.' });
        }

        const storage = getStorage();
        const accounts = storage.accounts || [];
        const logs = [];

        console.log(`Starting bulk publishing job: pages=${pageIds.length}, IG=${instagramIds.length}, videos=${videos.length}`);

        // Loop through each prepared video
        for (let vIdx = 0; vIdx < videos.length; vIdx++) {
            const video = videos[vIdx];
            const videoPath = path.resolve(video.filePath);

            if (!fs.existsSync(videoPath)) {
                logs.push({
                    type: 'error',
                    message: `Prepared video file not found on disk: ${video.filename}`
                });
                continue;
            }

            // 1. Post to Facebook Pages
            for (const pageId of pageIds) {
                try {
                    // Resolve Page Token
                    // Locate parent stored account that has access to this page
                    let pageToken = null;
                    let parentUserToken = null;

                    for (const account of accounts) {
                        if (!account.accessToken) continue;
                        // Query user pages to see if it contains pageId
                        const url = `https://graph.facebook.com/v25.0/me/accounts?access_token=${account.accessToken}`;
                        const response = await fetch(url);
                        if (response.ok) {
                            const data = await response.json();
                            const matchedPage = (data.data || []).find(p => p.id === pageId);
                            if (matchedPage) {
                                pageToken = matchedPage.access_token;
                                parentUserToken = account.accessToken;
                                break;
                            }
                        }
                    }

                    if (!pageToken) {
                        throw new Error(`Could not resolve Page Access Token for Page ID: ${pageId}. Make sure the owning account is connected.`);
                    }

                    console.log(`Publishing video to FB Page ${pageId} using Page token...`);
                    logs.push({ type: 'info', message: `[FB Page: ${pageId}] Starting upload...` });

                    // Upload via multipart form-data directly to Facebook
                    const fbForm = new FormData();
                    fbForm.append('access_token', pageToken);
                    fbForm.append('description', caption);
                    fbForm.append('source', fs.createReadStream(videoPath));

                    const fbRes = await fetch(`https://graph-video.facebook.com/v25.0/${pageId}/videos`, {
                        method: 'POST',
                        body: fbForm,
                        headers: fbForm.getHeaders()
                    });

                    const fbResult = await fbRes.json();
                    if (!fbRes.ok) {
                        throw new Error(fbResult.error?.message || `FB upload HTTP status ${fbRes.status}`);
                    }

                    console.log(`FB Page Post success:`, fbResult);
                    logs.push({
                        type: 'success',
                        message: `[FB Page: ${pageId}] Successfully published video! Post ID: ${fbResult.id || fbResult.post_id}`
                    });

                } catch (err) {
                    console.error(`FB Page posting error:`, err);
                    logs.push({
                        type: 'error',
                        message: `[FB Page: ${pageId}] Failed to publish: ${err.message}`
                    });
                }
            }

            // 2. Post to Instagram Business Accounts
            for (const instagramId of instagramIds) {
                try {
                    // Resolve user token that has access to this IG account
                    let userToken = null;
                    for (const account of accounts) {
                        if (!account.accessToken) continue;
                        const url = `https://graph.facebook.com/v25.0/me/accounts?fields=instagram_business_account&access_token=${account.accessToken}`;
                        const response = await fetch(url);
                        if (response.ok) {
                            const data = await response.json();
                            const matchedIg = (data.data || []).find(p => p.instagram_business_account?.id === instagramId);
                            if (matchedIg) {
                                userToken = account.accessToken;
                                break;
                            }
                        }
                    }

                    if (!userToken) {
                        throw new Error(`Could not resolve authorization token for Instagram Account: ${instagramId}`);
                    }

                    // Upload to file.io to get public URL
                    console.log(`Uploading video to file.io for IG indexing...`);
                    logs.push({ type: 'info', message: `[Instagram: ${instagramId}] Generating public upload proxy...` });

                    const fileioForm = new FormData();
                    fileioForm.append('file', fs.createReadStream(videoPath));
                    
                    const fileioRes = await fetch('https://file.io/?expires=1h', {
                        method: 'POST',
                        body: fileioForm,
                        headers: fileioForm.getHeaders()
                    });

                    const fileioResult = await fileioRes.json();
                    if (!fileioRes.ok || !fileioResult.success) {
                        throw new Error(`Proxy file upload failed: ${fileioResult.message || 'Status ' + fileioRes.status}`);
                    }

                    const publicVideoUrl = fileioResult.link;
                    console.log(`Public video URL generated: ${publicVideoUrl}`);

                    // Create Instagram Media Container
                    console.log(`Creating IG Reels container...`);
                    logs.push({ type: 'info', message: `[Instagram: ${instagramId}] Creating Reels container...` });

                    const containerUrl = `https://graph.facebook.com/v25.0/${instagramId}/media`;
                    const containerRes = await fetch(containerUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            media_type: 'REELS',
                            video_url: publicVideoUrl,
                            caption: caption,
                            access_token: userToken
                        })
                    });

                    const containerResult = await containerRes.json();
                    if (!containerRes.ok) {
                        throw new Error(containerResult.error?.message || `IG container creation failed`);
                    }

                    const containerId = containerResult.id;
                    console.log(`IG container created: ${containerId}. Polling status...`);
                    logs.push({ type: 'info', message: `[Instagram: ${instagramId}] Reels container created: ${containerId}. Waiting for processing...` });

                    // Poll status
                    let isReady = false;
                    let attempt = 0;
                    const maxAttempts = 20;

                    while (!isReady && attempt < maxAttempts) {
                        attempt++;
                        await sleep(10000); // Wait 10 seconds between checks

                        const statusUrl = `https://graph.facebook.com/v25.0/${containerId}?fields=status_code,failure_reason&access_token=${userToken}`;
                        const statusRes = await fetch(statusUrl);
                        if (statusRes.ok) {
                            const statusData = await statusRes.json();
                            console.log(`IG container status check: status_code=${statusData.status_code}`);
                            if (statusData.status_code === 'FINISHED') {
                                isReady = true;
                            } else if (statusData.status_code === 'ERROR') {
                                throw new Error(`IG processing failed: ${statusData.failure_reason || 'Unknown error'}`);
                            }
                        }
                    }

                    if (!isReady) {
                        throw new Error("Instagram video processing timed out (took longer than 3 minutes).");
                    }

                    // Publish Reels container
                    console.log(`Publishing IG Reels container...`);
                    logs.push({ type: 'info', message: `[Instagram: ${instagramId}] Publishing Reel...` });

                    const publishUrl = `https://graph.facebook.com/v25.0/${instagramId}/media_publish`;
                    const publishRes = await fetch(publishUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            creation_id: containerId,
                            access_token: userToken
                        })
                    });

                    const publishResult = await publishRes.json();
                    if (!publishRes.ok) {
                        throw new Error(publishResult.error?.message || `IG publish failed`);
                    }

                    console.log(`IG Reels publish success:`, publishResult);
                    logs.push({
                        type: 'success',
                        message: `[Instagram: ${instagramId}] Successfully published Reel! Media ID: ${publishResult.id}`
                    });

                } catch (err) {
                    console.error(`Instagram posting error:`, err);
                    logs.push({
                        type: 'error',
                        message: `[Instagram: ${instagramId}] Failed to publish: ${err.message}`
                    });
                }
            }
        }

        res.json({ success: true, logs });
    } catch (error) {
        console.error("Bulk publishing failed:", error);
        res.status(500).json({ error: 'Bulk publishing failed', details: error.message });
    }
});

module.exports = router;
