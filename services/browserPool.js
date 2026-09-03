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

const fs = require('fs');
const os = require('os');

function getOptimalMaxTabs() {
    // 1. Environmental Override
    if (process.env.MAX_CONCURRENT_TABS) {
        const val = parseInt(process.env.MAX_CONCURRENT_TABS);
        if (!isNaN(val) && val > 0) return val;
    }

    // 2. Linux Container (cgroups v1/v2) memory limit detection
    let containerMemoryLimit = null;
    try {
        if (process.platform === 'linux') {
            if (fs.existsSync('/sys/fs/cgroup/memory.max')) {
                const limitStr = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
                if (limitStr !== 'max') containerMemoryLimit = parseInt(limitStr);
            }
            if (!containerMemoryLimit && fs.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) {
                const limitStr = fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
                containerMemoryLimit = parseInt(limitStr);
            }
        }
    } catch (e) {
        console.warn('[BrowserPool] Failed to read cgroup memory limit:', e.message);
    }

    const totalMemoryBytes = containerMemoryLimit || os.totalmem();
    const totalMemoryMB = Math.round(totalMemoryBytes / (1024 * 1024));

    console.log(`[BrowserPool] Detected memory limit: ${totalMemoryMB} MB`);

    // Heuristics:
    // - <= 600MB (Render 512MB): Max 1 tab
    // - <= 1200MB (1GB): Max 2 tabs
    // - <= 2400MB (2GB): Max 4 tabs
    // - <= 4000MB (4GB): Max 6 tabs
    // - <= 8000MB (8GB): Max 10 tabs
    // - > 8000MB (16GB+): Max 16 tabs
    if (totalMemoryMB <= 600) return 1;
    if (totalMemoryMB <= 1200) return 2;
    if (totalMemoryMB <= 2400) return 4;
    if (totalMemoryMB <= 4000) return 6;
    if (totalMemoryMB <= 8000) return 10;
    return 16;
}

const MAX_TABS = getOptimalMaxTabs();
console.log(`[BrowserPool] Configured MAX_TABS = ${MAX_TABS}`);
let browser = null;          // shared Puppeteer Browser instance
const pagePool = [];          // Array of { page, inUse: boolean }
const waitQueue = [];         // resolve callbacks waiting for a free slot
let launchPromise = null;     // Promise for serialized browser launch

const MIN_SAFE_MEMORY_MB = 100;
const SAFETY_RESERVE_RAM_MB = 500;  // Always preserve at least 500MB free RAM for Windows and other apps
const ESTIMATED_TAB_RAM_MB = 90;    // Average memory per active Puppeteer tab

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
            '--disable-blink-features=AutomationControlled',
            '--enable-gpu',
            '--enable-webgl',
            '--no-first-run',
            '--no-default-browser-check'
        ];

        let launchOpts = {
            headless: isLinux ? 'new' : false, // Visible real Chrome on Windows
            ignoreDefaultArgs: ['--enable-automation'], // REMOVES "Chrome is being controlled by automated test software" BANNER!
            args: launchArgs,
            defaultViewport: null,
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
                try { puppeteer = require('puppeteer'); } catch { puppeteer = require('puppeteer-core'); }
                if (process.env.PUPPETEER_EXECUTABLE_PATH) {
                    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
                }
            }
        } else {
            // ── Windows: Use Real Google Chrome with Full Hardware Acceleration & Anti-Bot Stealth ──
            try { puppeteer = require('puppeteer'); } catch { puppeteer = require('puppeteer-core'); }
            const realChromeWin = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
            if (fs.existsSync(realChromeWin)) {
                launchOpts.executablePath = realChromeWin;
                console.log(`[BrowserPool] Using Real Google Chrome: ${realChromeWin}`);
            } else if (process.env.PUPPETEER_EXECUTABLE_PATH) {
                launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
            }
        }

        const br = await puppeteer.launch(launchOpts);

        br.on('disconnected', () => {
            console.log('[BrowserPool] Browser disconnected');
            browser = null;
            pagePool.length = 0; // Clear page pool
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

// Calculates dynamic available memory (accounting for Linux cgroups limit - current usage)
function getAvailableMemoryMB() {
    try {
        if (process.platform === 'linux') {
            let limit = null;
            let current = null;

            // cgroups v2
            if (fs.existsSync('/sys/fs/cgroup/memory.max') && fs.existsSync('/sys/fs/cgroup/memory.current')) {
                const limitStr = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
                const currentStr = fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim();
                if (limitStr !== 'max') {
                    limit = parseInt(limitStr);
                    current = parseInt(currentStr);
                }
            }
            // cgroups v1 fallback
            if (!limit && fs.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes') && fs.existsSync('/sys/fs/cgroup/memory/memory.usage_in_bytes')) {
                limit = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim());
                current = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim());
            }

            if (limit && current) {
                const availableBytes = limit - current;
                return Math.max(0, Math.round(availableBytes / (1024 * 1024)));
            }
        }
    } catch (e) {
        console.warn('[BrowserPool] Failed to read cgroup available memory:', e.message);
    }

    // Fallback to system free memory
    return Math.round(os.freemem() / (1024 * 1024));
}

// Acquire a tab slot, reusing an idle tab or allocating a new one if memory permits
async function acquirePage(blockImages = true) {
    const br = await ensureBrowser();

    // 1. Try to find an idle page in the pool
    const idleEntry = pagePool.find(p => !p.inUse);
    if (idleEntry) {
        idleEntry.inUse = true;
        console.log(`[BrowserPool] Reusing existing idle tab. Active pool size: ${pagePool.length}`);
        
        const page = idleEntry.page;
        // Clean any old listeners that might have been attached by previous extraction calls
        page.removeAllListeners('response');
        page.removeAllListeners('request');
        
        // Re-attach standard request interception for the reused page
        await page.setRequestInterception(true).catch(() => {});
        page.on('request', req => {
            const rt = req.resourceType();
            if (rt === 'image' && blockImages) {
                req.respond({
                    status: 200,
                    contentType: 'image/gif',
                    body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
                });
            } else if (['stylesheet', 'font'].includes(rt)) {
                req.abort();
            } else {
                req.continue();
            }
        });
        
        return page;
    }

    // 2. Real-Time Dynamic Memory Calculation:
    // Check how much RAM is CURRENTLY AVAILABLE right now
    const availableMem = getAvailableMemoryMB();
    
    // How many additional tabs can we safely open while preserving 500MB safety buffer?
    const safeParallelLimit = Math.max(1, Math.min(MAX_TABS, Math.floor((availableMem - SAFETY_RESERVE_RAM_MB) / ESTIMATED_TAB_RAM_MB)));
    
    // Allow opening new tab if under safe parallel limit and memory is above 500MB buffer (or if pool is totally empty)
    const canOpenNewTab = pagePool.length < safeParallelLimit && (pagePool.length === 0 || availableMem >= SAFETY_RESERVE_RAM_MB);

    console.log(`[BrowserPool] Allocation Guard: Active: ${pagePool.length}/${MAX_TABS} tabs. Current Available RAM: ${availableMem}MB. Dynamic Safe Limit: ${safeParallelLimit} tabs (500MB buffer preserved).`);

    if (canOpenNewTab) {
        const page = await br.newPage();
        
        // Hide webdriver flag
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        // Configure page interception and user agent ONCE upon creation
        await page.setRequestInterception(true);
        page.on('request', req => {
            const rt = req.resourceType();
            if (rt === 'image' && blockImages) {
                req.respond({
                    status: 200,
                    contentType: 'image/gif',
                    body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
                });
            } else if (['stylesheet', 'font'].includes(rt)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        );

        page.on('close', () => {
            const idx = pagePool.findIndex(p => p.page === page);
            if (idx !== -1) {
                console.log('[BrowserPool] Tab closed externally. Removing from pool.');
                pagePool.splice(idx, 1);
            }
        });

        pagePool.push({ page, inUse: true });
        console.log(`[BrowserPool] Created and allocated new tab. Active pool size: ${pagePool.length}`);
        return page;
    }

    // 3. Queue the request if available RAM or tab limit reached
    console.log(`[BrowserPool] Queueing request. Waiting for active tab release to preserve ${SAFETY_RESERVE_RAM_MB}MB safety RAM... (Queue length: ${waitQueue.length + 1})`);
    return new Promise(resolve => {
        waitQueue.push(resolve);
    });
}

// Release a tab slot and wake the next queued caller with the same tab
async function releasePage(page) {
    const entry = pagePool.find(p => p.page === page);
    if (entry) {
        // Clear page cookies & cache to free up memory on the background page
        try {
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies').catch(() => {});
            await client.send('Network.clearBrowserCache').catch(() => {});
        } catch (e) {
            console.warn('[BrowserPool] Failed to clear page cache:', e.message);
        }

        // Navigate to blank page to wipe previous DOM elements and stop any video player
        await page.goto('about:blank').catch(() => {});

        entry.inUse = false;
    }

    // If there is someone waiting in the queue, give them the page immediately
    if (waitQueue.length > 0) {
        const nextResolve = waitQueue.shift();
        if (entry) {
            entry.inUse = true;
            console.log(`[BrowserPool] Queue worker picked up reused tab.`);
            nextResolve(page);
        } else {
            // Fallback if the page was somehow lost
            acquirePage().then(nextResolve);
        }
    } else {
        console.log(`[BrowserPool] Tab released to idle pool. Active pool size: ${pagePool.length}`);
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
        page = await acquirePage(blockImages);

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
            await releasePage(page);
        }
    }
}

/**
 * Gracefully shut down the browser (for process exit handlers).
 */
async function closeBrowser() {
    if (browser) {
        try {
            // Close all pages in the pool first
            for (const entry of pagePool) {
                try { await entry.page.close(); } catch {}
            }
        } catch {}
        pagePool.length = 0;
        try { await browser.close(); } catch {}
        browser = null;
    }
}

function getMemoryStats() {
    const totalMemoryBytes = os.totalmem();
    const totalMB = Math.round(totalMemoryBytes / (1024 * 1024));
    const availableMB = getAvailableMemoryMB();
    return {
        free: availableMB,
        total: totalMB
    };
}

module.exports = { withTab, closeBrowser, warmBrowser, getAvailableMemoryMB, getMemoryStats };
