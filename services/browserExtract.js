/**
 * Unified Browser-based Video Extraction Service
 * Uses headless Chromium (via browserPool) to render pages and intercept video URLs
 * from network traffic — exactly like DevTools Network tab.
 * 
 * Optimized for maximum speed:
 * - Translates Instagram and Facebook links to public embed links to bypass login walls.
 * - Parses page scripts recursively to extract raw mp4/m3u8 CDN links before playback starts.
 * - Races navigation/interactions with the network intercept, resolving INSTANTLY the moment a video URL is seen.
 */

const { withTab } = require('./browserPool');

// Safe delay helper
const delay = ms => new Promise(r => setTimeout(r, ms));

// Simple in-memory cache to prevent concurrent/duplicate extraction requests for the same media
const extractionCache = new Map();

function getCacheKey(url) {
    try {
        const u = new URL(url);
        // For Facebook Ads Library, the ad ID is the unique key
        if (/facebook\.com\/ads\/library/i.test(url)) {
            const id = u.searchParams.get('id');
            if (id) return `fb_${id}`;
        }
        // For Instagram/Pinterest, clean the URL (strip query parameters)
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

const HD_KEY_REGEX = /(hd[_-]?(?:src|url)|browser[_-]?native[_-]?hd[_-]?url|playable[_-]?url[_-]?quality[_-]?hd|representative[_-]?thumb[_-]?hd|video[_-]?hd[_-]?src|video[_-]?dash[_-]?prefetch[_-]?representations)/i;
const VIDEO_KEY_REGEX = /(video[_-]?url|playback[_-]?url|content[_-]?url|hd[_-]?src|sd[_-]?src|browser[_-]?native[_-]?(?:hd|sd)[_-]?url|playable[_-]?url(?:[_-]?quality[_-]?(?:hd|sd))?|representative[_-]?thumb|src)$/i;
const URL_REGEX_GLOBAL = /https?:\/\/[^\s"'<>{}|\\^`\]\[]+\.(?:mp4|m3u8|mpd)(?:\?[^\s"'<>{}|\\^`\]\[]*)?/gi;

function decodeJsonEncodedUrls(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/\\\//g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/\\u003d/g, "=")
        .replace(/\\u003f/g, "?");
}

function walkForVideoUrls(value) {
    const found = [];
    const stack = [{ v: value, k: null }];
    let visited = 0;
    const MAX_NODES = 20000;

    while (stack.length > 0 && visited < MAX_NODES) {
        const node = stack.pop();
        if (!node) continue;
        const { v, k } = node;
        visited++;
        if (v == null) continue;

        if (typeof v === "string") {
            const looksLikeMediaKey = k != null && VIDEO_KEY_REGEX.test(k);
            if (looksLikeMediaKey && /^https?:\/\//i.test(v)) {
                found.push(v);
            }
            const matches = v.match(URL_REGEX_GLOBAL);
            if (matches) {
                for (const m of matches) found.push(m);
            }
            continue;
        }

        if (Array.isArray(v)) {
            for (const item of v) stack.push({ v: item, k });
            continue;
        }

        if (typeof v === "object") {
            for (const [key, child] of Object.entries(v)) {
                stack.push({ v: child, k: key });
            }
        }
    }
    return [...new Set(found)];
}

async function extractVideoUrl(targetUrl) {
    const cacheKey = getCacheKey(targetUrl);
    
    // If there is an active or completed extraction for this key, return it
    if (extractionCache.has(cacheKey)) {
        console.log(`[BrowserExtract] Cache hit for: ${cacheKey}. Reusing extraction.`);
        return extractionCache.get(cacheKey);
    }
    
    const extractionPromise = (async () => {
        return performExtraction(targetUrl);
    })();
    
    // Save to cache
    extractionCache.set(cacheKey, extractionPromise);
    
    // If extraction fails, remove it from cache so the user can retry later
    extractionPromise.catch(() => {
        extractionCache.delete(cacheKey);
    });
    
    return extractionPromise;
}

async function performExtraction(targetUrl) {
    return withTab(async (page) => {
        const navigationUrl = transformExtractionUrl(targetUrl);
        console.log(`[BrowserExtract] Target: ${targetUrl} -> Navigating: ${navigationUrl}`);
        
        let resolved = false;
        let resolveFn = null;
        let rejectFn = null;
        
        const videoPromise = new Promise((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
        });

        const startTime = Date.now();

        // Helper to resolve early and clean up
        const finish = (url, method) => {
            if (!resolved) {
                resolved = true;
                console.log(`[BrowserExtract] SUCCESS! Found video via ${method} in ${((Date.now() - startTime) / 1000).toFixed(1)}s: ${url.slice(0, 80)}...`);
                resolveFn(url);
            }
        };

        const jsonBodyPromises = [];

        // Response Interception - catches the raw media/CDN URL as it streams
        page.on('response', async (response) => {
            if (resolved) return;
            try {
                const url = response.url();
                const contentType = response.headers()['content-type'] || '';
                
                // 1. Check if direct media url matching video types
                const isVideo = contentType.includes('video') ||
                                /\.mp4(\?|$)/i.test(url) ||
                                /fbcdn\.net\/v\//i.test(url) ||
                                /cdninstagram\.com.*\/v\//i.test(url) ||
                                /scontent.*cdninstagram/i.test(url) ||
                                /pinimg\.com.*\.mp4/i.test(url);

                if (isVideo && url.startsWith('http')) {
                    finish(url, 'Network Intercept');
                    return;
                }

                // 2. Queue text/JSON response bodies to parse for GraphQL structure
                const ctLower = contentType.toLowerCase();
                const looksLikeJson = ctLower.includes('application/json') ||
                                      ctLower.includes('x-javascript') ||
                                      ctLower.includes('text/javascript');
                if (looksLikeJson) {
                    jsonBodyPromises.push(
                        response.text()
                            .then(body => {
                                if (!body || body.length > 4000000) return null;
                                return body;
                            })
                            .catch(() => null)
                    );
                }
            } catch {}
        });

        // Start loading the page in the background
        page.goto(navigationUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
            .catch(err => console.warn(`[BrowserExtract] Navigation warning: ${err.message}`));

        // Dynamic polling check loop every 600ms
        const checkInterval = setInterval(async () => {
            if (resolved) {
                clearInterval(checkInterval);
                return;
            }
            
            try {
                // Simulate click play triggers on DOM
                await page.evaluate(() => {
                    const selectors = [
                        'div[role="button"][aria-label="Play"]',
                        'video',
                        '[data-testid="video_player"]',
                        'div[data-video-id]',
                        '.playButton',
                        'a[aria-label="Play video"]',
                        'button'
                    ];
                    for (const sel of selectors) {
                        const elements = document.querySelectorAll(sel);
                        for (const el of elements) {
                            try { el.click(); } catch {}
                        }
                    }
                }).catch(() => {});

                // Bypass IG captcha/cookie notice triggers
                await page.evaluate(() => {
                    const buttons = document.querySelectorAll('button');
                    for (const btn of buttons) {
                        if (btn.textContent.trim().toLowerCase().includes('not now')) {
                            btn.click();
                            break;
                        }
                    }
                }).catch(() => {});
                
                // Extract video from simple DOM elements
                const domUrl = await page.evaluate(() => {
                    const videos = document.querySelectorAll('video');
                    for (const v of videos) {
                        if (v.src && v.src.startsWith('http') && !v.src.includes('blob:')) return v.src;
                        const srcNode = v.querySelector('source');
                        if (srcNode && srcNode.src && srcNode.src.startsWith('http')) return srcNode.src;
                    }
                    const ogVideo = document.querySelector('meta[property="og:video"]');
                    if (ogVideo && ogVideo.content && ogVideo.content.startsWith('http')) return ogVideo.content;
                    return null;
                }).catch(() => null);

                if (domUrl) {
                    clearInterval(checkInterval);
                    finish(domUrl, 'DOM Polling');
                    return;
                }

                // Parse page scripts for inline JSON payloads
                const jsonBlobs = await page.evaluate(() => {
                    const blobs = [];
                    const keys = ['__INITIAL_STATE__', '__INITIAL_DATA__', '_sharedData', '__NEXT_DATA__', '__APOLLO_STATE__'];
                    for (const key of keys) {
                        try {
                            const val = window[key];
                            if (val) blobs.push(val);
                        } catch {}
                    }
                    document.querySelectorAll('script').forEach(s => {
                        const txt = s.textContent || '';
                        if (!txt) return;
                        if (s.type === 'application/json' || s.type === 'application/ld+json') {
                            try { blobs.push(JSON.parse(txt)); } catch {}
                        } else if (txt.includes('.mp4') || txt.includes('video_url')) {
                            blobs.push(txt);
                        }
                    });
                    return blobs;
                }).catch(() => []);

                for (const blob of jsonBlobs) {
                    const decoded = typeof blob === 'string' ? decodeJsonEncodedUrls(blob) : blob;
                    const walked = walkForVideoUrls(decoded);
                    if (walked.length > 0) {
                        const hdUrl = walked.find(u => HD_KEY_REGEX.test(u)) || walked[0];
                        if (hdUrl) {
                            clearInterval(checkInterval);
                            finish(hdUrl, 'Script parsing');
                            return;
                        }
                    }
                }

                // Check intercepted JSON response payloads
                const bodies = (await Promise.all(jsonBodyPromises)).filter(Boolean);
                for (const body of bodies) {
                    const decoded = decodeJsonEncodedUrls(body);
                    const walked = walkForVideoUrls(decoded);
                    if (walked.length > 0) {
                        const hdUrl = walked.find(u => HD_KEY_REGEX.test(u)) || walked[0];
                        if (hdUrl) {
                            clearInterval(checkInterval);
                            finish(hdUrl, 'Network JSON Scan');
                            return;
                        }
                    }
                }
            } catch (e) {
                // Ignore transient frame errors
            }
        }, 600);

        // Overall safety timeout (18 seconds)
        setTimeout(() => {
            clearInterval(checkInterval);
            if (!resolved) {
                rejectFn(new Error('Extraction timed out. Could not locate video source URL.'));
            }
        }, 18000);

        return videoPromise;
    }, { timeout: 22000 });
}

module.exports = {
    extractVideoUrl,
    extractFacebookAdsLibrary: extractVideoUrl,
    extractInstagram: extractVideoUrl,
    extractPinterest: extractVideoUrl
};
