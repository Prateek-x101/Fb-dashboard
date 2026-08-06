/**
 * Unified Browser-based Video Extraction Service
 * Uses headless Chromium (via browserPool) to render pages and intercept video URLs
 * from network traffic — exactly like DevTools Network tab.
 * 
 * Ported target-centric extraction logic from pupperter-viewer to ensure we download
 * the exact requested Meta Ads Library / Instagram video, rather than related/neighbor ads.
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
    const found = new Map(); // url -> isHD
    const stack = [{ v: value, k: null }];
    let visited = 0;
    const MAX_NODES = 40000;

    const add = (url, hd) => {
        const prev = found.get(url);
        if (prev === undefined) {
            found.set(url, hd);
        } else if (hd && !prev) {
            found.set(url, true);
        }
    };

    while (stack.length > 0 && visited < MAX_NODES) {
        const node = stack.pop();
        if (!node) continue;
        const { v, k } = node;
        visited++;
        if (v == null) continue;

        if (typeof v === "string") {
            const looksLikeMediaKey = k != null && VIDEO_KEY_REGEX.test(k);
            const isHdKey = k != null && HD_KEY_REGEX.test(k);
            if (looksLikeMediaKey && /^https?:\/\//i.test(v)) {
                add(v, isHdKey);
            }
            const matches = v.match(URL_REGEX_GLOBAL);
            if (matches) {
                for (const m of matches) add(m, isHdKey);
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
    return Array.from(found.entries()).map(([url, isHD]) => ({ url, isHD }));
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
        if (queryId && /^\d{6,}$/.test(queryId)) return queryId;

        const pathSegment = u.pathname;
        const matches = [
            /\/videos?\/(\d{6,})/i,
            /\/reels?\/([A-Za-z0-9_-]+)/i,
            /\/pin\/(\d{6,})/i,
            /\/watch\/?\?v=(\d{6,})/i,
        ];
        for (const re of matches) {
            const m = pathSegment.match(re);
            if (m && m[1]) return m[1];
        }
        return null;
    } catch {
        return null;
    }
}

function extractCdnVideoIdHint(url) {
    const m = url.match(/(\d{10,})/);
    return m && m[1] ? m[1] : null;
}

const COLLECT_VIDEO_ELEMENTS_FN = `
(() => {
  const out = [];
  document.querySelectorAll('video').forEach((v) => {
    try {
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const top = rect.top + (window.scrollY || 0);
      const poster = v.getAttribute('poster') || null;
      const cs = v.currentSrc || '';
      const s = v.getAttribute('src') || '';
      if (cs) out.push({ url: cs, poster, area, top });
      if (s && s !== cs) out.push({ url: s, poster, area, top });
      v.querySelectorAll('source').forEach((src) => {
        const u = src.getAttribute('src') || src.src || '';
        if (u) out.push({ url: u, poster, area, top });
      });
    } catch (_e) {}
  });
  const filtered = out.filter((v) => (v.area || 0) >= 10000);
  const final = filtered.length > 0 ? filtered : out;
  final.sort((a, b) => {
    if (Math.abs((a.top || 0) - (b.top || 0)) > 80) {
      return (a.top || 0) - (b.top || 0);
    }
    return (b.area || 0) - (a.area || 0);
  });
  return final;
})();
`;

const COLLECT_JSON_BLOBS_FN = `
(() => {
  const blobs = [];
  for (const key of ['__INITIAL_STATE__', '__INITIAL_DATA__', '_sharedData', '__APOLLO_STATE__', '__NEXT_DATA__']) {
    try {
      const val = window[key];
      if (val) blobs.push({ key, value: val });
    } catch (_e) {}
  }
  document.querySelectorAll('script').forEach((s) => {
    const txt = s.textContent || '';
    if (!txt) return;
    if (s.type === 'application/json' || s.type === 'application/ld+json') {
      try { blobs.push({ key: 'json:' + (s.id || 'inline'), value: JSON.parse(txt) }); } catch (_e) {}
    } else if (txt.includes('video_url') || txt.includes('playable_url') || txt.includes('.mp4')) {
      blobs.push({ key: 'inline-script', value: txt });
    }
  });
  return blobs;
})();
`;

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
        const isFbAdsLibrary = /facebook\.com\/ads\/library/i.test(targetUrl);
        
        console.log(`[BrowserExtract] Target ID: ${targetId} | Navigating: ${navigationUrl}`);
        
        const startTime = Date.now();
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
                    if (!networkVideos.has(respUrl)) {
                        networkVideos.set(respUrl, {
                            url: respUrl,
                            type: respUrl.includes('.m3u8') ? 'hls' : 'mp4',
                            source: 'network'
                        });
                    }
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
        await page.setViewport({
            width: 1280,
            height: 800
        });

        // Navigate page and wait for network to settle (critical for GraphQL payloads)
        await page.goto(navigationUrl, { waitUntil: 'networkidle2', timeout: 30000 })
            .catch(err => console.warn(`[BrowserExtract] Navigation warning: ${err.message}`));

        // Wait for video element
        try {
            await page.waitForSelector('video', { timeout: 10000 });
        } catch {}

        // Settle network
        await delay(2500);
        try {
            await page.waitForNetworkIdle({ timeout: 5000, idleTime: 600 });
        } catch {}

        // Click trigger buttons to ensure player initiates
        await page.evaluate(() => {
            const selectors = [
                'div[role="button"][aria-label="Play"]',
                'video',
                '[data-testid="video_player"]',
                'div[data-video-id]',
                'button'
            ];
            for (const sel of selectors) {
                try {
                    document.querySelectorAll(sel).forEach(el => el.click());
                } catch {}
            }
        }).catch(() => {});

        // LAYER 0 — Video Element sources (highest signal)
        const videoElementSources = await page.evaluate(COLLECT_VIDEO_ELEMENTS_FN).catch(() => []);
        const elementVideos = new Map();
        for (const v of videoElementSources) {
            if (!v.url || v.url.startsWith('blob:')) continue;
            if (!elementVideos.has(v.url)) {
                elementVideos.set(v.url, {
                    url: v.url,
                    type: 'mp4',
                    source: 'element'
                });
            }
        }

        // LAYER 1.5 — Scan captured network responses for requested Target ID
        const targetMatchedVideos = new Map();
        if (targetId) {
            const responses = (await Promise.all(jsonBodyPromises)).filter(Boolean);
            for (const r of responses) {
                if (!r.body.includes(targetId)) continue;
                const decoded = decodeJsonEncodedUrls(r.body);
                const walked = extractHdSdFromText(decoded);
                for (const w of walked) {
                    const existing = targetMatchedVideos.get(w.url);
                    if (!existing) {
                        targetMatchedVideos.set(w.url, {
                            url: w.url,
                            type: 'mp4',
                            source: 'json',
                            isHD: w.isHD,
                            targetMatched: true
                        });
                    } else if (w.isHD && !existing.isHD) {
                        existing.isHD = true;
                    }
                }
            }
        }

        // LAYER 2 — JSON blobs from page scripts
        const jsonBlobs = await page.evaluate(COLLECT_JSON_BLOBS_FN).catch(() => []);
        const jsonVideos = new Map();
        for (const blob of jsonBlobs) {
            const walked = walkForVideoUrls(blob.value);
            for (const w of walked) {
                const existing = jsonVideos.get(w.url);
                if (!existing) {
                    jsonVideos.set(w.url, {
                        url: w.url,
                        type: 'mp4',
                        source: 'json',
                        isHD: w.isHD
                    });
                } else if (w.isHD && !existing.isHD) {
                    existing.isHD = true;
                }
            }
        }

        // Merging and prioritization
        const sourceRank = { element: 0, network: 1, json: 2 };
        const merged = new Map();
        const ordered = [
            ...targetMatchedVideos.values(),
            ...elementVideos.values(),
            ...networkVideos.values(),
            ...jsonVideos.values()
        ];

        for (const v of ordered) {
            const existing = merged.get(v.url);
            if (!existing) {
                merged.set(v.url, { ...v });
            } else {
                if (v.isHD && !existing.isHD) existing.isHD = true;
                if (v.targetMatched && !existing.targetMatched) {
                    existing.targetMatched = true;
                }
            }
        }

        // Propagate targetMatched flag to elements sharing CDN IDs
        if (targetMatchedVideos.size > 0) {
            const matchedIds = new Set();
            for (const v of targetMatchedVideos.values()) {
                const id = extractCdnVideoIdHint(v.url);
                if (id) matchedIds.add(id);
            }
            for (const v of merged.values()) {
                const id = extractCdnVideoIdHint(v.url);
                if (id && matchedIds.has(id)) v.targetMatched = true;
            }
        }

        // Compile clean candidates
        let candidates = Array.from(merged.values()).filter(v => !v.url.startsWith('data:') && !v.url.startsWith('blob:'));

        // Rank candidates: target-matched wins first, then HD, then source priority, then type
        candidates.sort((a, b) => {
            const tmA = a.targetMatched ? 0 : 1;
            const tmB = b.targetMatched ? 0 : 1;
            if (tmA !== tmB) return tmA - tmB;

            const hdA = a.isHD ? 0 : 1;
            const hdB = b.isHD ? 0 : 1;
            if (hdA !== hdB) return hdA - hdB;

            const sa = sourceRank[a.source] ?? 2;
            const sb = sourceRank[b.source] ?? 2;
            return sa - sb;
        });

        // Facebook Ads Library specific filtering
        if (isFbAdsLibrary || targetId) {
            const matched = candidates.filter(c => c.targetMatched);
            if (matched.length > 0) {
                candidates = matched;
            } else {
                const elementOnly = candidates.filter(c => c.source === 'element');
                if (elementOnly.length > 0) {
                    candidates = [elementOnly[0]];
                } else {
                    candidates = [];
                }
            }
        }

        if (candidates.length === 0) {
            throw new Error('No trusted video sources detected on this page.');
        }

        // Return highest ranked URL
        const bestVideoUrl = candidates[0].url;
        console.log(`[BrowserExtract] Selected best candidate: ${bestVideoUrl.slice(0, 80)}...`);
        return bestVideoUrl;
    });
}

module.exports = {
    extractVideoUrl,
    extractFacebookAdsLibrary: extractVideoUrl,
    extractInstagram: extractVideoUrl,
    extractPinterest: extractVideoUrl
};
