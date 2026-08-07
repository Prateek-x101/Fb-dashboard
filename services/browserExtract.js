/**
 * Browser-based Video Extraction Service
 * Ported from the user's pupperter-viewer repository.
 * Uses headless Chromium (via browserPool) to evaluate page context and intercept media responses.
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

// Browser-side script to collect initial state JSON blobs
const COLLECT_JSON_BLOBS_FN = `
(() => {
  const blobs = [];

  for (const key of [
    '__INITIAL_STATE__',
    '__INITIAL_DATA__',
    '_sharedData',
    '__APOLLO_STATE__',
    '__NEXT_DATA__',
    '__NUXT__',
  ]) {
    try {
      const w = window;
      const val = w[key];
      if (val) blobs.push({ key, value: val });
    } catch (_e) {}
  }

  document.querySelectorAll('script').forEach((s) => {
    const txt = s.textContent || '';
    if (!txt) return;
    if (s.type === 'application/json' || s.type === 'application/ld+json') {
      try {
        blobs.push({ key: 'json:' + (s.id || 'inline'), value: JSON.parse(txt) });
        return;
      } catch (_e) {}
    }
    if (
      txt.includes('video_url') ||
      txt.includes('playback_url') ||
      txt.includes('contentUrl') ||
      txt.includes('browser_native_hd') ||
      txt.includes('playable_url') ||
      txt.includes('.mp4') ||
      txt.includes('.m3u8') ||
      txt.includes('.mpd')
    ) {
      blobs.push({ key: 'inline-script', value: txt });
    }
  });

  return blobs;
})();
`;

// Browser-side script to collect video element details
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

const HD_KEY_REGEX = /(hd[_-]?(?:src|url)|browser[_-]?native[_-]?hd[_-]?url|playable[_-]?url[_-]?quality[_-]?hd|representative[_-]?thumb[_-]?hd|video[_-]?hd[_-]?src|video[_-]?dash[_-]?prefetch[_-]?representations)/i;
const VIDEO_KEY_REGEX = /(video[_-]?url|playback[_-]?url|content[_-]?url|hd[_-]?src|sd[_-]?src|browser[_-]?native[_-]?(?:hd|sd)[_-]?url|playable[_-]?url(?:[_-]?quality[_-]?(?:hd|sd))?|representative[_-]?thumb|src)$/i;
const URL_REGEX_GLOBAL = /https?:\/\/[^\s"'<>{}|\\^`\]\[]+\.(?:mp4|m3u8|mpd)(?:\?[^\s"'<>{}|\\^`\]\[]*)?/gi;

function classifyUrl(url) {
    const lower = url.split("?")[0]?.toLowerCase() ?? "";
    if (lower.endsWith(".mp4") || lower.includes(".mp4")) return "mp4";
    if (lower.endsWith(".m3u8") || lower.includes(".m3u8")) return "hls";
    if (lower.endsWith(".mpd") || lower.includes(".mpd")) return "dash";
    return "unknown";
}

function walkForVideoUrls(value) {
    const found = new Map();
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
        const item = stack.pop();
        if (!item) continue;
        const { v, k } = item;
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
            for (const sub of v) stack.push({ v: sub, k });
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

function scanHtmlForVideoUrls(html) {
    const found = new Set();
    const matches = html.match(URL_REGEX_GLOBAL);
    if (matches) {
        for (const m of matches) found.add(m);
    }
    return Array.from(found);
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

function detectPlatform(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (host.includes("facebook.com") || host.includes("fb.watch") || host.includes("fb.com")) {
            return "facebook";
        }
        if (host.includes("instagram.com")) return "instagram";
        if (host.includes("pinterest.com") || host.includes("pin.it")) return "pinterest";
        return "unknown";
    } catch {
        return "unknown";
    }
}

const VIDEO_HOST_HINTS = [
    "fbcdn.net",
    "cdninstagram.com",
    "pinimg.com",
    "akamaihd.net",
    "video",
    "stream",
    "cdn"
];

function isLikelyVideoNetworkUrl(url, contentType) {
    const lower = url.toLowerCase();
    if (lower.includes(".mp4") || lower.includes(".m3u8") || lower.includes(".mpd")) {
        return true;
    }
    if (contentType) {
        const ct = contentType.toLowerCase();
        if (ct.startsWith("video/") || ct.includes("mpegurl") || ct.includes("dash+xml")) {
            return true;
        }
    }
    if (VIDEO_HOST_HINTS.some((h) => lower.includes(h))) {
        if (lower.match(/\/(video|reel|watch|stream)/)) return true;
    }
    return false;
}

function extractTargetId(url) {
    try {
        const u = new URL(url);
        const queryId = u.searchParams.get("id") || u.searchParams.get("v");
        if (queryId) {
            const cleanId = queryId.replace(/[^0-9]/g, '');
            if (cleanId.length >= 6) return cleanId;
        }

        const path = u.pathname;
        const matches = [
            /\/videos?\/(\d{6,})/i,
            /\/reels?\/([A-Za-z0-9_-]+)/i,
            /\/pin\/(\d{6,})/i,
            /\/watch\/?\?v=(\d{6,})/i,
        ];
        for (const re of matches) {
            const m = path.match(re);
            if (m && m[1]) return m[1].replace(/[^0-9]/g, '');
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

async function extractVideoUrl(targetUrl) {
    return performExtraction(targetUrl);
}

async function performExtraction(targetUrl) {
    return withTab(async (page) => {
        const platform = detectPlatform(targetUrl);
        const targetId = extractTargetId(targetUrl);
        const navigationUrl = transformExtractionUrl(targetUrl);
        
        console.log(`[BrowserExtract] Platform: ${platform} | Target ID: ${targetId} | Navigating: ${navigationUrl}`);
        
        const networkVideos = new Map();
        const jsonBodyPromises = [];

        // LAYER 1 — Network response interception (also captures GraphQL JSON bodies)
        page.on('response', (response) => {
            try {
                const respUrl = response.url();
                const ct = response.headers()['content-type'] || '';
                
                if (isLikelyVideoNetworkUrl(respUrl, ct)) {
                    if (!networkVideos.has(respUrl)) {
                        networkVideos.set(respUrl, {
                            url: respUrl,
                            type: classifyUrl(respUrl),
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

        // Set realistic mobile user agent and viewport (to match user's repo mobile navigation)
        await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
        await page.setViewport({
            width: 390,
            height: 844,
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true
        });

        // Navigate page
        await page.goto(navigationUrl, {
            waitUntil: 'load',
            timeout: 25000
        }).catch(err => console.warn(`[BrowserExtract] Navigation warning: ${err.message}`));

        // Wait specifically for a <video> element
        try {
            await page.waitForSelector("video", { timeout: 10000 });
        } catch (e) {
            console.warn('[BrowserExtract] Video selector wait timed out');
        }

        // SPA video players settle time
        await delay(2500);

        try {
            await page.waitForNetworkIdle({ timeout: 5000, idleTime: 600 });
        } catch {}

        // LAYER 0 — actual <video> element sources
        const videoElementSources = await page.evaluate(COLLECT_VIDEO_ELEMENTS_FN).catch(() => []);
        const elementVideos = new Map();
        for (const v of videoElementSources) {
            if (!v.url || v.url.startsWith('blob:')) continue;
            if (!elementVideos.has(v.url)) {
                elementVideos.set(v.url, {
                    url: v.url,
                    type: classifyUrl(v.url),
                    source: 'element',
                    poster: v.poster || null
                });
            }
        }

        // LAYER 1.5 — scan captured network JSON / GraphQL responses for the requested target ID
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
                            type: classifyUrl(w.url),
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

        // LAYER 2 — JSON parsing from page context
        const jsonBlobs = await page.evaluate(COLLECT_JSON_BLOBS_FN).catch(() => []);
        const jsonVideos = new Map();
        for (const blob of jsonBlobs) {
            const walked = walkForVideoUrls(blob.value);
            for (const w of walked) {
                const existing = jsonVideos.get(w.url);
                if (!existing) {
                    jsonVideos.set(w.url, {
                        url: w.url,
                        type: classifyUrl(w.url),
                        source: 'json',
                        isHD: w.isHD
                    });
                } else if (w.isHD && !existing.isHD) {
                    existing.isHD = true;
                }
            }
        }

        // LAYER 3 — HTML scan
        const html = await page.content().catch(() => '');
        const htmlVideos = new Map();
        for (const u of scanHtmlForVideoUrls(html)) {
            if (!htmlVideos.has(u)) {
                htmlVideos.set(u, {
                    url: u,
                    type: classifyUrl(u),
                    source: 'html'
                });
            }
        }

        // Meta tags extraction
        const meta = await page.evaluate(() => {
            const get = (sel) => {
                const el = document.querySelector(sel);
                return el ? el.content : null;
            };
            return {
                ogVideo: get('meta[property="og:video"]') || get('meta[property="og:video:url"]'),
                ogVideoSecure: get('meta[property="og:video:secure_url"]'),
                ogImage: get('meta[property="og:image"]'),
                title: document.title || null
            };
        }).catch(() => ({}));

        if (meta.ogVideoSecure && !elementVideos.has(meta.ogVideoSecure)) {
            elementVideos.set(meta.ogVideoSecure, {
                url: meta.ogVideoSecure,
                type: classifyUrl(meta.ogVideoSecure),
                source: 'element'
            });
        }
        if (meta.ogVideo && !elementVideos.has(meta.ogVideo)) {
            elementVideos.set(meta.ogVideo, {
                url: meta.ogVideo,
                type: classifyUrl(meta.ogVideo),
                source: 'element'
            });
        }

        // Deduplicate and merge candidates
        const sourceRank = { element: 0, network: 1, json: 2, html: 3 };
        const merged = new Map();
        const ordered = [
            ...targetMatchedVideos.values(),
            ...elementVideos.values(),
            ...networkVideos.values(),
            ...jsonVideos.values(),
            ...htmlVideos.values()
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

        // Cross-map targetMatched flag via CDN video ID hints
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

        const candidates = Array.from(merged.values()).filter(v => {
            if (v.url.startsWith('data:') || v.url.startsWith('blob:')) return false;
            return true;
        });

        const typeRank = { mp4: 0, hls: 1, dash: 2, unknown: 3 };

        candidates.sort((a, b) => {
            const tmA = a.targetMatched ? 0 : 1;
            const tmB = b.targetMatched ? 0 : 1;
            if (tmA !== tmB) return tmA - tmB;

            const hdA = a.isHD ? 0 : 1;
            const hdB = b.isHD ? 0 : 1;
            if (hdA !== hdB) return hdA - hdB;

            const sa = sourceRank[a.source];
            const sb = sourceRank[b.source];
            if (sa !== sb) return sa - sb;

            const ta = typeRank[a.type] ?? 3;
            const tb = typeRank[b.type] ?? 3;
            return ta - tb;
        });

        // Facebook Ads Library safety net filtering
        const isFbAdsLibrary = targetUrl.includes("facebook.com") && targetUrl.includes("/ads/library");
        if (isFbAdsLibrary || (platform === 'facebook' && targetId)) {
            const matched = candidates.filter(c => c.targetMatched);
            if (matched.length > 0) {
                candidates.length = 0;
                candidates.push(...matched);
            } else {
                const elementOnly = candidates.filter(c => c.source === 'element');
                if (elementOnly.length > 0) {
                    candidates.length = 0;
                    candidates.push(elementOnly[0]);
                } else {
                    candidates.length = 0;
                }
            }
        }

        if (candidates.length === 0) {
            throw new Error('No trusted video sources detected on this page.');
        }

        return candidates[0].url;
    });
}

module.exports = {
    extractVideoUrl,
    extractFacebookAdsLibrary: extractVideoUrl,
    extractInstagram: extractVideoUrl,
    extractPinterest: extractVideoUrl
};
