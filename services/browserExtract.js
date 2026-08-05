/**
 * Browser-based video extraction for Facebook Ads Library, Instagram, and Pinterest.
 * Uses headless Chromium (via browserPool) to render pages and intercept video URLs
 * from network traffic — exactly like DevTools Network tab.
 */

const { withTab } = require('./browserPool');

// Safe delay — avoids deprecated page.waitForTimeout in newer Puppeteer
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Helper: collect video URLs from network traffic ─────────────────────────
function createVideoCollector(page) {
    const videoUrls = [];

    page.on('response', async (response) => {
        try {
            const url = response.url();
            const contentType = response.headers()['content-type'] || '';

            // Capture video CDN URLs from network traffic
            const isVideo = contentType.includes('video') ||
                            /\.mp4(\?|$)/i.test(url) ||
                            /fbcdn\.net\/v\//i.test(url) ||
                            /cdninstagram\.com.*\/v\//i.test(url) ||
                            /scontent.*cdninstagram/i.test(url) ||
                            /pinimg\.com.*\.mp4/i.test(url);

            if (isVideo && url.startsWith('http')) {
                const size = parseInt(response.headers()['content-length'] || '0', 10);
                videoUrls.push({ url, size, contentType });
            }
        } catch {}
    });

    return {
        getUrls: () => videoUrls,
        getBestUrl: () => {
            if (videoUrls.length === 0) return null;
            // Prefer largest file (usually HD)
            videoUrls.sort((a, b) => (b.size || 0) - (a.size || 0));
            return videoUrls[0].url;
        }
    };
}

// ── Facebook Ads Library Extraction ─────────────────────────────────────────
async function extractFacebookAdsLibrary(adUrl) {
    return withTab(async (page) => {
        console.log(`[BrowserExtract] Facebook Ads Library: ${adUrl}`);
        const collector = createVideoCollector(page);

        // Navigate to the ad page
        await page.goto(adUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait a bit for lazy-loaded video content
        await delay(3000);

        // Try to click play button if video is not auto-playing
        try {
            // Facebook Ads Library has various play button selectors
            const playSelectors = [
                'div[role="button"][aria-label="Play"]',
                'video',
                '[data-testid="video_player"]',
                'div[data-video-id]',
                '.playButton',
                'a[aria-label="Play video"]'
            ];
            for (const sel of playSelectors) {
                const el = await page.$(sel);
                if (el) {
                    await el.click().catch(() => {});
                    await delay(2000);
                    break;
                }
            }
        } catch {}

        // Check if we captured any video URLs from network
        let bestUrl = collector.getBestUrl();
        if (bestUrl) {
            console.log(`[BrowserExtract] FB Ads: Found video via network intercept`);
            return bestUrl;
        }

        // Fallback: extract from DOM
        bestUrl = await page.evaluate(() => {
            // Look for video elements
            const videos = document.querySelectorAll('video');
            for (const v of videos) {
                if (v.src && v.src.startsWith('http')) return v.src;
                // Check source children
                const source = v.querySelector('source');
                if (source && source.src) return source.src;
            }
            // Look for video in iframes
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (iframeDoc) {
                        const v = iframeDoc.querySelector('video');
                        if (v && v.src) return v.src;
                    }
                } catch {}
            }
            return null;
        });

        if (bestUrl) {
            console.log(`[BrowserExtract] FB Ads: Found video via DOM extraction`);
            return bestUrl;
        }

        // Final check — maybe the page loaded more resources
        await delay(3000);
        bestUrl = collector.getBestUrl();
        if (bestUrl) {
            console.log(`[BrowserExtract] FB Ads: Found video on second check`);
            return bestUrl;
        }

        throw new Error('Could not extract video from Facebook Ads Library page via browser.');
    }, { timeout: 45000 });
}

// ── Instagram Extraction ────────────────────────────────────────────────────
async function extractInstagram(reelUrl) {
    return withTab(async (page) => {
        console.log(`[BrowserExtract] Instagram: ${reelUrl}`);
        const collector = createVideoCollector(page);

        // Navigate to the reel/post page
        await page.goto(reelUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for content to load
        await delay(3000);

        // Check if login wall appeared — try to dismiss it
        try {
            await page.evaluate(() => {
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    if (btn.textContent.trim().toLowerCase().includes('not now')) {
                        btn.click();
                        break;
                    }
                }
            });
        } catch {}

        // Try to play the video
        try {
            const video = await page.$('video');
            if (video) {
                await video.click().catch(() => {});
                await delay(2000);
            }
        } catch {}

        // Check network-intercepted URLs
        let bestUrl = collector.getBestUrl();
        if (bestUrl) {
            console.log(`[BrowserExtract] Instagram: Found video via network intercept`);
            return bestUrl;
        }

        // Extract from DOM
        bestUrl = await page.evaluate(() => {
            const videos = document.querySelectorAll('video');
            for (const v of videos) {
                if (v.src && v.src.startsWith('http') && !v.src.includes('blob:')) {
                    return v.src;
                }
                // Check source tag
                const source = v.querySelector('source');
                if (source && source.src && source.src.startsWith('http')) {
                    return source.src;
                }
            }
            // Instagram sometimes puts video URL in og:video meta tag
            const ogVideo = document.querySelector('meta[property="og:video"]');
            if (ogVideo) return ogVideo.getAttribute('content');
            return null;
        });

        if (bestUrl) {
            console.log(`[BrowserExtract] Instagram: Found video via DOM`);
            return bestUrl;
        }

        // Wait more and check again
        await delay(4000);
        bestUrl = collector.getBestUrl();
        if (bestUrl) {
            console.log(`[BrowserExtract] Instagram: Found video on second check`);
            return bestUrl;
        }

        throw new Error('Could not extract video from Instagram page via browser.');
    }, { timeout: 45000 });
}

// ── Pinterest Extraction ────────────────────────────────────────────────────
async function extractPinterest(pinUrl) {
    return withTab(async (page) => {
        console.log(`[BrowserExtract] Pinterest: ${pinUrl}`);
        const collector = createVideoCollector(page);

        await page.goto(pinUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(3000);

        // Try to play the video
        try {
            const video = await page.$('video');
            if (video) {
                await video.click().catch(() => {});
                await delay(2000);
            }
        } catch {}

        let bestUrl = collector.getBestUrl();
        if (bestUrl) {
            console.log(`[BrowserExtract] Pinterest: Found video via network intercept`);
            return bestUrl;
        }

        bestUrl = await page.evaluate(() => {
            const videos = document.querySelectorAll('video');
            for (const v of videos) {
                if (v.src && v.src.startsWith('http')) return v.src;
                const source = v.querySelector('source');
                if (source && source.src) return source.src;
            }
            return null;
        });

        if (bestUrl) {
            console.log(`[BrowserExtract] Pinterest: Found video via DOM`);
            return bestUrl;
        }

        throw new Error('Could not extract video from Pinterest page via browser.');
    }, { timeout: 45000 });
}

// ── Universal extraction router ─────────────────────────────────────────────
async function extractVideoUrl(url) {
    if (/facebook\.com\/ads\/library/i.test(url)) {
        return extractFacebookAdsLibrary(url);
    }
    if (/instagram\.com/i.test(url)) {
        return extractInstagram(url);
    }
    if (/pinterest\.(com|co)/i.test(url) || /pin\.it/i.test(url)) {
        return extractPinterest(url);
    }
    throw new Error(`Browser extraction not supported for this URL: ${url}`);
}

module.exports = {
    extractVideoUrl,
    extractFacebookAdsLibrary,
    extractInstagram,
    extractPinterest
};
