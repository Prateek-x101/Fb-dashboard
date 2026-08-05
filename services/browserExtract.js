/**
 * Unified Browser-based Video Extraction Service
 * Uses headless Chromium (via browserPool) to render pages and intercept video URLs
 * from network traffic — exactly like DevTools Network tab.
 * 
 * Optimized for maximum speed:
 * - Uses 'domcontentloaded' navigation so pages finish loading in 1-2 seconds.
 * - Races navigation/interactions with the network intercept, resolving INSTANTLY the moment a video URL is seen.
 */

const { withTab } = require('./browserPool');

// Safe delay helper
const delay = ms => new Promise(r => setTimeout(r, ms));

async function extractVideoUrl(targetUrl) {
    return withTab(async (page) => {
        console.log(`[BrowserExtract] Starting extraction for: ${targetUrl}`);
        
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

        // Response Interception - catches the raw media/CDN URL as it streams
        page.on('response', async (response) => {
            if (resolved) return;
            try {
                const url = response.url();
                const contentType = response.headers()['content-type'] || '';
                
                const isVideo = contentType.includes('video') ||
                                /\.mp4(\?|$)/i.test(url) ||
                                /fbcdn\.net\/v\//i.test(url) ||
                                /cdninstagram\.com.*\/v\//i.test(url) ||
                                /scontent.*cdninstagram/i.test(url) ||
                                /pinimg\.com.*\.mp4/i.test(url);

                if (isVideo && url.startsWith('http')) {
                    finish(url, 'Network Intercept');
                }
            } catch {}
        });

        // Start loading the page in the background
        // Use 'domcontentloaded' for fast parsing startup
        page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
            .catch(err => console.warn(`[BrowserExtract] Navigation warning: ${err.message}`));

        // Dynamic polling check loop every 600ms
        const checkInterval = setInterval(async () => {
            if (resolved) {
                clearInterval(checkInterval);
                return;
            }
            
            try {
                // Simulate play click on all possible elements to force video load
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

                // If Instagram login wall button appears, click it
                await page.evaluate(() => {
                    const buttons = document.querySelectorAll('button');
                    for (const btn of buttons) {
                        if (btn.textContent.trim().toLowerCase().includes('not now')) {
                            btn.click();
                            break;
                        }
                    }
                }).catch(() => {});
                
                // Extract video from DOM
                const domUrl = await page.evaluate(() => {
                    // 1. Direct video tags
                    const videos = document.querySelectorAll('video');
                    for (const v of videos) {
                        if (v.src && v.src.startsWith('http') && !v.src.includes('blob:')) return v.src;
                        const srcNode = v.querySelector('source');
                        if (srcNode && srcNode.src && srcNode.src.startsWith('http')) return srcNode.src;
                    }
                    // 2. Meta tags
                    const ogVideo = document.querySelector('meta[property="og:video"]');
                    if (ogVideo && ogVideo.content && ogVideo.content.startsWith('http')) return ogVideo.content;
                    
                    // 3. Check iframe videos
                    const iframes = document.querySelectorAll('iframe');
                    for (const iframe of iframes) {
                        try {
                            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                            if (iframeDoc) {
                                const v = iframeDoc.querySelector('video');
                                if (v && v.src && v.src.startsWith('http')) return v.src;
                            }
                        } catch {}
                    }
                    return null;
                }).catch(() => null);

                if (domUrl) {
                    clearInterval(checkInterval);
                    finish(domUrl, 'DOM Polling');
                }
            } catch (e) {
                // Ignore transient frame errors
            }
        }, 600);

        // Overall safety timeout (15 seconds)
        setTimeout(() => {
            clearInterval(checkInterval);
            if (!resolved) {
                rejectFn(new Error('Extraction timed out. Could not locate video source URL.'));
            }
        }, 15000);

        return videoPromise;
    }, { timeout: 18000 });
}

module.exports = {
    extractVideoUrl,
    extractFacebookAdsLibrary: extractVideoUrl,
    extractInstagram: extractVideoUrl,
    extractPinterest: extractVideoUrl
};
