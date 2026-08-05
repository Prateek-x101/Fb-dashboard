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
let idleTimer = null;         // auto-close timer
const waitQueue = [];         // resolve callbacks waiting for a free slot

// ── Helpers ─────────────────────────────────────────────────────────────────

function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
        if (activeTabCount === 0 && browser) {
            console.log('[BrowserPool] Idle timeout — closing browser');
            try { await browser.close(); } catch {}
            browser = null;
        }
    }, 60_000); // 60 seconds idle → close
}

async function ensureBrowser() {
    if (browser) return browser;

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

    browser = await puppeteer.launch(launchOpts);

    browser.on('disconnected', () => {
        console.log('[BrowserPool] Browser disconnected');
        browser = null;
        activeTabCount = 0;
    });

    resetIdleTimer();
    return browser;
}

// Acquire a tab slot (may block if all 6 are busy)
function acquireSlot() {
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
    }
    resetIdleTimer();
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run an extraction function inside a managed browser tab.
 * @param {Function} extractFn  async (page) => result — receives a Puppeteer Page.
 *                              Must return whatever data the caller needs.
 * @param {Object}   opts       { timeout?: number }
 * @returns {Promise<*>}        Whatever extractFn returns.
 */
async function withTab(extractFn, opts = {}) {
    const timeout = opts.timeout || 60000;

    await acquireSlot();
    let page = null;
    try {
        const br = await ensureBrowser();
        page = await br.newPage();

        // Block images, fonts, stylesheets — only keep scripts/documents/media
        await page.setRequestInterception(true);
        page.on('request', req => {
            const rt = req.resourceType();
            if (['image', 'stylesheet', 'font'].includes(rt)) {
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
        // Always close the tab
        if (page) {
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

module.exports = { withTab, closeBrowser };
