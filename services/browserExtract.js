/**
 * Unified Browser-based Video Extraction Service
 * Uses headless Chromium (via browserPool) to render pages and intercept video URLs
 * from network traffic — exactly like DevTools Network tab.
 * 
 * Optimized for maximum speed and Render free-tier reliability:
 * - Uses domcontentloaded and loops with 1-second check intervals (max 15s) to exit instantly when video is found.
 * - Scans GraphQL response bodies for target ad ID to resolve the correct ad.
 */

const { withTab } = require('./browserPool');
const fs = require('fs');
const path = require('path');

// Safe delay helper
const delay = ms => new Promise(r => setTimeout(r, ms));

// Simple in-memory cache to prevent concurrent/duplicate extraction requests
const extractionCache = new Map();

function getCacheKey(url) {
    try {
        const u = new URL(url);
        if (/facebook\.com\/ads\/library/i.test(url)) {
            const id = u.searchParams.get('id');
            if (id) return `fb_${id}`;
        }
        if (/instagram\.com/i.test(url) || /pinterest\.(com|co)/i.test(url) || /pin\.it/i.test(url)) {
            return `${u.origin}${u.pathname}`;
        }
    } catch {}
    return url;
}

// Transform gated post links into public embed links to bypass authentication walls
function transformExtractionUrl(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        if (host.includes("instagram.com")) {
            const m = u.pathname.match(/^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)\/?/);
            if (m) {
                const kind = m[1] === "reels" ? "reel" : m[1];
                return `https://www.instagram.com/${kind}/${m[2]}/embed/captioned/`;
            }
        }
        return url;
    } catch {
        return url;
    }
}

function decodeJsonEncodedUrls(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/\\\//g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/\\u003d/g, "=")
        .replace(/\\u003f/g, "?");
}

function extractHdSdFromText(text) {
    const out = [];
    const seen = new Map();

    const HD_KEY_PATTERN = /["']?(?:browser_native_hd_url|video_hd_url|playable_url_quality_hd|hd_src|hd_url)["']?\s*[:=]\s*["']([^"']+\.(?:mp4|m3u8|mpd)[^"']*)["']/gi;
    const SD_KEY_PATTERN = /["']?(?:browser_native_sd_url|video_sd_url|playable_url|sd_src|sd_url)["']?\s*[:=]\s*["']([^"']+\.(?:mp4|m3u8|mpd)[^"']*)["']/gi;

    const collect = (regex, isHD) => {
        let m;
        while ((m = regex.exec(text)) !== null) {
            const url = m[1];
            if (!url) continue;
            const prev = seen.get(url);
            if (prev === undefined) {
                seen.set(url, isHD);
            } else if (isHD && !prev) {
                seen.set(url, true);
            }
        }
    };

    collect(HD_KEY_PATTERN, true);
    collect(SD_KEY_PATTERN, false);

    for (const [url, isHD] of seen.entries()) {
        out.push({ url, isHD });
    }
    return out;
}

function extractTargetId(url) {
    try {
        const u = new URL(url);
        const queryId = u.searchParams.get("id") || u.searchParams.get("v");
        if (queryId) {
            const cleanId = queryId.replace(/[^0-9]/g, '');
            if (cleanId.length >= 6) return cleanId;
        }

        const pathSegment = u.pathname;
        const matches = [
            /\/videos?\/(\d{6,})/i,
            /\/reels?\/([A-Za-z0-9_-]+)/i,
            /\/pin\/(\d{6,})/i,
            /\/watch\/?\?v=(\d{6,})/i,
        ];
        for (const re of matches) {
            const m = pathSegment.match(re);
            if (m && m[1]) return m[1].replace(/[^0-9]/g, '');
        }
        return null;
    } catch {
        return null;
    }
}

async function extractVideoUrl(targetUrl) {
    const cacheKey = getCacheKey(targetUrl);
    if (extractionCache.has(cacheKey)) {
        console.log(`[BrowserExtract] Cache hit for: ${cacheKey}. Reusing extraction.`);
        return extractionCache.get(cacheKey);
    }
    
    const extractionPromise = performExtraction(targetUrl);
    extractionCache.set(cacheKey, extractionPromise);
    extractionPromise.catch(() => extractionCache.delete(cacheKey));
    return extractionPromise;
}

async function performExtraction(targetUrl) {
    return withTab(async (page) => {
        const navigationUrl = transformExtractionUrl(targetUrl);
        const targetId = extractTargetId(targetUrl);
        
        console.log(`[BrowserExtract] Target ID: ${targetId} | Navigating: ${navigationUrl}`);
        
        const networkVideos = new Map();
        const jsonBodyPromises = [];

        // LAYER 1 — Network response interception
        page.on('response', (response) => {
            try {
                const respUrl = response.url();
                const ct = response.headers()['content-type'] || '';
                
                const isVideo = ct.includes('video') ||
                                /\.mp4(\?|$)/i.test(respUrl) ||
                                /fbcdn\.net\/v\//i.test(respUrl) ||
                                /cdninstagram\.com.*\/v\//i.test(respUrl) ||
                                /scontent.*cdninstagram/i.test(respUrl) ||
                                /pinimg\.com.*\.mp4/i.test(respUrl);

                if (isVideo && respUrl.startsWith('http')) {
                    networkVideos.set(respUrl, true);
                }

                // Capture JSON/GraphQL response bodies to search for targetId
                const ctLower = ct.toLowerCase();
                const looksLikeJson = ctLower.includes('application/json') ||
                                      ctLower.includes('x-javascript') ||
                                      ctLower.includes('text/javascript');
                if (looksLikeJson) {
                    jsonBodyPromises.push(
                        response.text()
                            .then(body => {
                                if (!body || body.length > 8000000) return null;
                                return { url: respUrl, body };
                            })
                            .catch(() => null)
                    );
                }
            } catch {}
        });

        // Set realistic desktop user agent and viewport
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
        await page.setViewport({ width: 1280, height: 800 });

        // Navigate page fast using domcontentloaded
        await page.goto(navigationUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
            .catch(err => console.warn(`[BrowserExtract] Navigation warning: ${err.message}`));

        let resolvedVideoUrl = null;
        const maxPollSeconds = 15;

        for (let poll = 0; poll < maxPollSeconds; poll++) {
            // 1. Try Target ID match from captured network responses
            if (targetId) {
                const responses = (await Promise.all(jsonBodyPromises)).filter(Boolean);
                for (const r of responses) {
                    if (r.body.includes(targetId)) {
                        const decoded = decodeJsonEncodedUrls(r.body);
                        const walked = extractHdSdFromText(decoded);
                        const hdUrl = walked.find(w => w.isHD) || walked[0];
                        if (hdUrl) {
                            resolvedVideoUrl = hdUrl.url;
                            console.log(`[BrowserExtract] SUCCESS! Found target-matched video URL via JSON scan.`);
                            break;
                        }
                    }
                }
            }
            if (resolvedVideoUrl) break;

            // 2. Try getting direct video element from page DOM
            const domUrl = await page.evaluate(() => {
                const videos = document.querySelectorAll('video');
                for (const v of videos) {
                    if (v.src && v.src.startsWith('http') && !v.src.includes('blob:')) return v.src;
                    const srcNode = v.querySelector('source');
                    if (srcNode && srcNode.src && srcNode.src.startsWith('http')) return srcNode.src;
                }
                return null;
            }).catch(() => null);

            if (domUrl) {
                resolvedVideoUrl = domUrl;
                console.log(`[BrowserExtract] SUCCESS! Found video URL via DOM polling.`);
                break;
            }

            // Click play button triggers to force load
            await page.evaluate(() => {
                const playBtns = document.querySelectorAll('div[role="button"][aria-label="Play"], video, button');
                playBtns.forEach(btn => { try { btn.click(); } catch {} });
            }).catch(() => {});

            await delay(1000);
        }

        // Final fallback: use first network intercepted URL
        if (!resolvedVideoUrl && networkVideos.size > 0) {
            resolvedVideoUrl = Array.from(networkVideos.keys())[0];
            console.log(`[BrowserExtract] Fallback: Using network intercepted URL.`);
        }

        if (!resolvedVideoUrl) {
            throw new Error('No trusted video sources detected on this page.');
        }

        return resolvedVideoUrl;
    });
}

module.exports = {
    extractVideoUrl,
    extractFacebookAdsLibrary: extractVideoUrl,
    extractInstagram: extractVideoUrl,
    extractPinterest: extractVideoUrl
};
