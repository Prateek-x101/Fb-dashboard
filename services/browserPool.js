/**
 * Browser Pool Service
 * Manages a shared headless Chromium instance with a capped number of tabs (pages).
 * 
 * Rules:
 *  1. Max 6 tabs open simultaneously — callers wait in a queue if all slots are busy.
 *  2. Each tab is closed immediately after the extraction completes (success or error).
 *  3. The browser itself is launched lazily on first request and auto-closes after
 *     an idle period (no active tabs for 60 s).
 */

const MAX_TABS = 6;

let browser = null;          // shared Puppeteer Browser instance
let activeTabCount = 0;       // currently open tabs
const waitQueue = [];         // resolve callbacks waiting for a free slot
let launchPromise = null;     // Promise for serialized browser launch

// ── Helpers ─────────────────────────────────────────────────────────────────

async function ensureBrowser() {
    if (browser) return browser;
    if (launchPromise) return launchPromise;

    launchPromise = (async () => {
        const isLinux = process.platform === 'linux';
        console.log(`[BrowserPool] Launching headless Chromium (platform: ${process.platform})...`);
        
        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--single-process',
            '--no-zygote',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-first-run',
        ];

        let launchOpts = {
            headless: 'new',
            args: launchArgs,
            defaultViewport: { width: 1280, height: 720 },
            timeout: 30000,
        };

        let puppeteer;

        if (isLinux) {
            // ── Render / Linux: use @sparticuz/chromium (lightweight, serverless-ready) ──
            try {
                const chromium = require('@sparticuz/chromium');
                puppeteer = require('puppeteer-core');

                launchOpts.args = [...chromium.args, ...launchArgs];
                launchOpts.executablePath = await chromium.executablePath();
                launchOpts.headless = chromium.headless;

                console.log(`[BrowserPool] Using @sparticuz/chromium: ${launchOpts.executablePath}`);
            } catch (err) {
                console.warn(`[BrowserPool] @sparticuz/chromium not available: ${err.message}`);
                // Fallback: try regular puppeteer
                try { puppeteer = require('puppeteer'); } catch { puppeteer = require('puppeteer-core'); }
                if (process.env.PUPPETEER_EXECUTABLE_PATH) {
                    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
                }
            }
        } else {
            // ── Windows / Mac: use regular puppeteer with bundled Chromium ──
            try { puppeteer = require('puppeteer'); } catch { puppeteer = require('puppeteer-core'); }
            if (process.env.PUPPETEER_EXECUTABLE_PATH) {
                launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
            }
        }

        const br = await puppeteer.launch(launchOpts);

        br.on('disconnected', () => {
            console.log('[BrowserPool] Browser disconnected');
            browser = null;
            activeTabCount = 0;
            launchPromise = null;
        });

        browser = br;
        launchPromise = null;
        return br;
    })();

    return launchPromise;
}

// Pre-warms the browser so the first request is instant
async function warmBrowser() {
    try {
        console.log('[BrowserPool] Pre-warming browser instance...');
        await ensureBrowser();
        console.log('[BrowserPool] Pre-warm completed.');
    } catch (err) {
        console.error('[BrowserPool] Pre-warm failed:', err.message);
    }
}

let idleTimeout = null;       // timeout handle for closing idle browser

// Acquire a tab slot (may block if all 6 are busy)
function acquireSlot() {
    if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = null;
    }

    if (activeTabCount < MAX_TABS) {
        activeTabCount++;
        return Promise.resolve();
    }
    // Queue the caller — they will be resolved when a slot frees up
    return new Promise(resolve => waitQueue.push(resolve));
}

// Release a tab slot and wake the next queued caller
function releaseSlot() {
    activeTabCount = Math.max(0, activeTabCount - 1);
    if (waitQueue.length > 0) {
        activeTabCount++;
        const next = waitQueue.shift();
        next();
    } else if (activeTabCount === 0) {
        // No active tabs. Auto-close browser after 5s idle to release RAM immediately
        if (idleTimeout) clearTimeout(idleTimeout);
        idleTimeout = setTimeout(async () => {
            if (browser && activeTabCount === 0) {
                console.log('[BrowserPool] 5s idle reached. Closing Chromium to release RAM...');
                await closeBrowser();
            }
        }, 5000);
    }
}

let lastNavTime = 0;
const NAV_SPACING_MS = 2000; // Space navigations by 2 seconds to prevent anti-bot blocking

/**
 * Run an extraction function inside a managed browser tab.
 * @param {Function} extractFn  async (page) => result — receives a Puppeteer Page.
 *                              Must return whatever data the caller needs.
 * @param {Object}   opts       { timeout?: number }
 * @returns {Promise<*>}        Whatever extractFn returns.
 */
async function withTab(extractFn, opts = {}) {
    const timeout = opts.timeout || 60000;
    const blockImages = opts.blockImages !== false;

    await acquireSlot();
    
    // Space out navigations to avoid triggering parallel request blocks
    const now = Date.now();
    const diff = now - lastNavTime;
    if (diff < NAV_SPACING_MS) {
        const delayTime = NAV_SPACING_MS - diff;
        lastNavTime = now + delayTime; // Reserve time slot
        await new Promise(r => setTimeout(r, delayTime));
    } else {
        lastNavTime = now;
    }

    let page = null;
    try {
        const br = await ensureBrowser();
        page = await br.newPage();

        // Block images, fonts, stylesheets — only keep scripts/documents/media
        await page.setRequestInterception(true);
        page.on('request', req => {
            const rt = req.resourceType();
            const shouldBlock = blockImages 
                ? ['image', 'stylesheet', 'font'].includes(rt)
                : ['stylesheet', 'font'].includes(rt);
            if (shouldBlock) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Set realistic UA
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        );

        // Run the caller's extraction logic with a timeout
        const result = await Promise.race([
            extractFn(page),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Browser extraction timed out')), timeout)
            )
        ]);

        return result;
    } finally {
        if (page) {
            try {
                // Clear browser cookies and cache to free up memory immediately
                const client = await page.target().createCDPSession();
                await client.send('Network.clearBrowserCookies').catch(() => {});
                await client.send('Network.clearBrowserCache').catch(() => {});
            } catch (e) {
                console.warn('[BrowserPool] Failed to clear page cache:', e.message);
            }
            try { await page.close(); } catch {}
        }
        releaseSlot();
    }
}

/**
 * Gracefully shut down the browser (for process exit handlers).
 */
async function closeBrowser() {
    if (browser) {
        try { await browser.close(); } catch {}
        browser = null;
    }
}

module.exports = { withTab, closeBrowser, warmBrowser };
