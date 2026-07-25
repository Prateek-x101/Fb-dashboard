const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const facebookService = require('../services/facebook');

const { getStorage, saveStorage } = require('../services/storage');
const oauthCache = new Map();

router.get('/', async (req, res) => {
    try {
        const fetch = require('node-fetch');
        const storage = getStorage();
        let accounts = storage.accounts || [];
        let updated = false;

        for (let i = 0; i < accounts.length; i++) {
            const acc = accounts[i];

            // Auto-resolve missing Page ID
            if (acc.accessToken && !acc.pageId) {
                try {
                    const pagesResult = await facebookService.getConnectedInstagram(acc.accessToken);
                    if (pagesResult.data && pagesResult.data.length > 0) {
                        acc.pageId = pagesResult.data[0].id;
                        updated = true;
                        console.log(`Auto-assigned Page ID ${acc.pageId} to account ${acc.accountId || acc.label}`);
                    }
                } catch (err) {
                    console.error(`Failed to auto-fetch Page ID for account ${acc.accountId}:`, err.message);
                }
            }

            if (acc.accessToken && acc.accountId && (!acc.currency || !acc.timezone_name)) {
                try {
                    const rawId = acc.accountId.startsWith('act_') ? acc.accountId : `act_${acc.accountId}`;
                    const url = `https://graph.facebook.com/v25.0/${rawId}?fields=currency,timezone_name&access_token=${acc.accessToken}`;
                    const response = await fetch(url);
                    if (response.ok) {
                        const data = await response.json();
                        if (data.currency) { acc.currency = data.currency; updated = true; }
                        if (data.timezone_name) { acc.timezone_name = data.timezone_name; updated = true; }
                        console.log(`Updated account ${acc.accountId}: currency=${data.currency}, tz=${data.timezone_name}`);
                    }
                } catch (err) {
                    console.error(`Failed to fetch account info for ${acc.accountId}:`, err.message);
                }
            }
        }

        if (updated) {
            saveStorage(storage);
        }

        res.json(accounts);
    } catch (error) {
        res.status(500).json({ error: 'Failed to read accounts', details: error.message });
    }
});

router.post('/', (req, res) => {
    try {
        const { label, accountId, accessToken, pageId } = req.body;
        const newAccount = { id: uuidv4(), label, accountId, accessToken, pageId };
        
        const storage = getStorage();
        if (!storage.accounts) storage.accounts = [];
        storage.accounts.push(newAccount);
        saveStorage(storage);
        
        res.status(201).json(newAccount);
    } catch (error) {
        res.status(500).json({ error: 'Failed to create account', details: error.message });
    }
});

router.put('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        const storage = getStorage();
        const index = (storage.accounts || []).findIndex(a => a.id === id);
        
        if (index === -1) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        storage.accounts[index] = { ...storage.accounts[index], ...updates };
        saveStorage(storage);
        
        res.json(storage.accounts[index]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update account', details: error.message });
    }
});

router.delete('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const storage = getStorage();
        const filtered = (storage.accounts || []).filter(a => a.id !== id);
        
        if (filtered.length === (storage.accounts || []).length) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        storage.accounts = filtered;
        saveStorage(storage);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete account', details: error.message });
    }
});

router.post('/:id/test', async (req, res) => {
    try {
        const { id } = req.params;
        const storage = getStorage();
        const account = (storage.accounts || []).find(a => a.id === id);
        
        if (!account) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        const result = await facebookService.testConnection(account.accountId, account.accessToken);
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: 'Test connection failed', details: error.message });
    }
});

// Fetch all ad accounts linked to an access token
router.post('/fetch-from-token', async (req, res) => {
    try {
        const { accessToken } = req.body;
        if (!accessToken) {
            return res.status(400).json({ error: 'Access token is required' });
        }
        const result = await facebookService.getAdAccounts(accessToken);
        res.json({ success: true, accounts: result.data || [] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch accounts', details: error.message });
    }
});

// Bulk add accounts from a token
router.post('/bulk-add', async (req, res) => {
    try {
        const { accounts, accessToken, pageId } = req.body;
        if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
            return res.status(400).json({ error: 'No accounts provided' });
        }
        const storage = getStorage();
        if (!storage.accounts) storage.accounts = [];

        const added = [];
        accounts.forEach(acc => {
            // Avoid duplicates by accountId
            const exists = storage.accounts.find(a => a.accountId === acc.account_id);
            if (!exists) {
                const newAccount = {
                    id: uuidv4(),
                    label: acc.name || `Account ${acc.account_id}`,
                    accountId: acc.account_id,
                    accessToken: accessToken,
                    pageId: pageId || '',
                    currency: acc.currency || 'INR'
                };
                storage.accounts.push(newAccount);
                added.push(newAccount);
            }
        });

        saveStorage(storage);
        res.status(201).json({ success: true, added, total: accounts.length, skipped: accounts.length - added.length });
    } catch (error) {
        res.status(500).json({ error: 'Failed to add accounts', details: error.message });
    }
});

// Get Facebook Pages (with linked Instagram) for a stored account
router.get('/pages', async (req, res) => {
    try {
        const storage = getStorage();
        const accounts = storage.accounts || [];
        const pageMap = new Map();
        const errors = [];

        await Promise.all(accounts.map(async account => {
            if (!account.accessToken) return;
            try {
                const result = await facebookService.getConnectedInstagram(account.accessToken);
                (result.data || []).forEach(page => {
                    if (!page.id) return;
                    const existing = pageMap.get(page.id);
                    const accountLabel = account.label || account.name || account.accountId;
                    if (existing) {
                        if (!existing.accountIds.includes(account.id)) existing.accountIds.push(account.id);
                        if (!existing.accountLabels.includes(accountLabel)) existing.accountLabels.push(accountLabel);
                        return;
                    }
                    pageMap.set(page.id, {
                        ...page,
                        accountId: account.id,
                        accountIds: [account.id],
                        accountLabel,
                        accountLabels: [accountLabel]
                    });
                });
            } catch (error) {
                errors.push({ accountId: account.id, message: error.message });
            }
        }));

        res.json({ pages: Array.from(pageMap.values()), errors });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch connected pages', details: error.message });
    }
});

// Billing info for an account (balance, spend, funding source)
router.get('/:id/billing', async (req, res) => {
    try {
        const { id } = req.params;
        const fetch = require('node-fetch');
        const storage = getStorage();
        const account = (storage.accounts || []).find(a => a.id === id);
        if (!account) return res.status(404).json({ error: 'Account not found' });

        const rawId = account.accountId.startsWith('act_') ? account.accountId : `act_${account.accountId}`;
        const token = account.accessToken;
        const base = `https://graph.facebook.com/v25.0`;

        // Fetch account info + today spend + yesterday spend in parallel
        const [accResp, todayResp, yestResp] = await Promise.all([
            fetch(`${base}/${rawId}?fields=balance,currency,spend_cap,amount_spent,funding_source_details,account_status&access_token=${token}`),
            fetch(`${base}/${rawId}/insights?fields=spend&date_preset=today&access_token=${token}`),
            fetch(`${base}/${rawId}/insights?fields=spend&date_preset=yesterday&access_token=${token}`)
        ]);

        const data = await accResp.json();
        if (data.error) return res.status(400).json({ error: data.error.message, code: data.error.code });

        // Insights return spend in actual currency (not cents)
        const todayData = await todayResp.json();
        const yestData = await yestResp.json();
        data.today_spend = todayData.data && todayData.data[0] ? todayData.data[0].spend : '0';
        data.yesterday_spend = yestData.data && yestData.data[0] ? yestData.data[0].spend : '0';

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch billing info', details: error.message });
    }
});

router.get('/:id/pages', async (req, res) => {
    try {
        const { id } = req.params;
        const storage = getStorage();
        const account = (storage.accounts || []).find(a => a.id === id);
        if (!account) return res.status(404).json({ error: 'Account not found' });

        const result = await facebookService.getConnectedInstagram(account.accessToken);
        res.json({ pages: result.data || [] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch pages', details: error.message });
    }
});

// Fetch and save Instagram account linked to a stored account
router.post('/:id/fetch-instagram', async (req, res) => {
    try {
        const { id } = req.params;
        const storage = getStorage();
        const accountIndex = (storage.accounts || []).findIndex(a => a.id === id);

        if (accountIndex === -1) {
            return res.status(404).json({ error: 'Account not found' });
        }

        const account = storage.accounts[accountIndex];
        const token = account.accessToken;
        let instagramData = null;

        // Try pageId first
        if (account.pageId) {
            try {
                const result = await facebookService.getInstagramFromPage(account.pageId, token);
                if (result.instagram_business_account) {
                    instagramData = result.instagram_business_account;
                }
            } catch (e) { /* fall through */ }
        }

        // Fallback: scan all pages linked to this token
        if (!instagramData) {
            try {
                const pagesResult = await facebookService.getConnectedInstagram(token);
                for (const page of (pagesResult.data || [])) {
                    if (page.instagram_business_account) {
                        instagramData = page.instagram_business_account;
                        if (!storage.accounts[accountIndex].pageId) {
                            storage.accounts[accountIndex].pageId = page.id;
                        }
                        break;
                    }
                }
            } catch (e) { /* fall through */ }
        }

        if (instagramData) {
            storage.accounts[accountIndex].instagramAccountId = instagramData.id;
            storage.accounts[accountIndex].instagramUsername = instagramData.username || instagramData.name || instagramData.id;
            saveStorage(storage);
            res.json({ success: true, instagram: instagramData, account: storage.accounts[accountIndex] });
        } else {
            res.json({ success: false, message: 'No Instagram Business account linked to this Facebook Page' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch Instagram', details: error.message });
    }
});

// Test connection with new credentials (before saving)
router.post('/test-connection', async (req, res) => {
    try {
        const { accountId, accessToken } = req.body;
        if (!accountId || !accessToken) {
            return res.status(400).json({ error: 'Account ID and Access Token are required' });
        }
        const result = await facebookService.testConnection(accountId, accessToken);
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: 'Connection test failed', details: error.message });
    }
});

// OAuth routes for Facebook login redirect flow
router.get('/auth/facebook', (req, res) => {
    try {
        const storage = getStorage();
        const appId = storage.settings?.facebookAppId;
        
        if (!appId) {
            return res.send(`
                <html>
                <body>
                    <script>
                        try {
                            localStorage.setItem('fb_auth_error', 'Facebook App ID not configured in Settings. Please go to Settings and enter your App ID and Secret.');
                        } catch(e){}
                        if (window.opener) {
                            try { window.opener.postMessage({ type: 'fb_auth_error', error: 'Facebook App ID not configured in Settings. Please go to Settings and enter your App ID and Secret.' }, '*'); } catch(e){}
                        }
                        window.close();
                    </script>
                </body>
                </html>
            `);
        }
        
        let protocol = req.protocol;
        const host = req.get('host') || '';
        if (!host.includes('localhost') && !host.includes('127.0.0.1')) {
            protocol = 'https';
        }
        const redirectUri = `${protocol}://${host}/api/accounts/auth/facebook/callback`;
        const authUrl = `https://www.facebook.com/v25.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=ads_management,ads_read,pages_read_engagement,pages_show_list,instagram_basic`;
        res.redirect(authUrl);
    } catch (error) {
        res.send(`
            <html>
            <body>
                <script>
                    try {
                        localStorage.setItem('fb_auth_error', '${error.message.replace(/'/g, "\\'")}');
                    } catch(e){}
                    if (window.opener) {
                        try { window.opener.postMessage({ type: 'fb_auth_error', error: '${error.message.replace(/'/g, "\\'")}' }, '*'); } catch(e){}
                    }
                    window.close();
                </script>
            </body>
            </html>
        `);
    }
});

router.get('/auth/facebook/callback', async (req, res) => {
    try {
        const { code, error, error_description } = req.query;
        
        if (error || !code) {
            return res.send(`
                <html>
                <body>
                    <script>
                        try {
                            localStorage.setItem('fb_auth_error', '${(error_description || error || 'Authorization failed').replace(/'/g, "\\'")}');
                        } catch(e){}
                        if (window.opener) {
                            try { window.opener.postMessage({ type: 'fb_auth_error', error: '${(error_description || error || 'Authorization failed').replace(/'/g, "\\'")}' }, '*'); } catch(e){}
                        }
                        window.close();
                    </script>
                </body>
                </html>
            `);
        }
        
        const storage = getStorage();
        const appId = storage.settings?.facebookAppId;
        const appSecret = storage.settings?.facebookAppSecret;
        
        if (!appId || !appSecret) {
            return res.send(`
                <html>
                <body>
                    <script>
                        try {
                            localStorage.setItem('fb_auth_error', 'App ID or App Secret is missing in Settings.');
                        } catch(e){}
                        if (window.opener) {
                            try { window.opener.postMessage({ type: 'fb_auth_error', error: 'App ID or App Secret is missing in Settings.' }, '*'); } catch(e){}
                        }
                        window.close();
                    </script>
                </body>
                </html>
            `);
        }
        
        let protocol = req.protocol;
        const host = req.get('host') || '';
        if (!host.includes('localhost') && !host.includes('127.0.0.1')) {
            protocol = 'https';
        }
        const redirectUri = `${protocol}://${host}/api/accounts/auth/facebook/callback`;
        
        // Exchange code for token with request deduplication to prevent double request failure
        if (!oauthCache.has(code)) {
            const exchangePromise = (async () => {
                try {
                    // Exchange code for short-lived token
                    const shortLivedData = await facebookService.getAccessTokenFromCode(appId, appSecret, code, redirectUri);
                    const shortToken = shortLivedData.access_token;
                    
                    // Exchange short-lived token for long-lived token
                    const longLivedData = await facebookService.getLongLivedToken(appId, appSecret, shortToken);
                    return { token: longLivedData.access_token };
                } catch (err) {
                    return { error: err.message };
                }
            })();
            oauthCache.set(code, exchangePromise);
            // Evict from cache after 2 minutes
            setTimeout(() => oauthCache.delete(code), 120000);
        }

        const exchangeResult = await oauthCache.get(code);
        if (exchangeResult.error) {
            throw new Error(exchangeResult.error);
        }
        
        const longToken = exchangeResult.token;
        
        res.send(`
            <html>
            <body>
                <script>
                    try {
                        localStorage.setItem('fb_auth_token', '${longToken}');
                    } catch(e){}
                    if (window.opener) {
                        try { window.opener.postMessage({ type: 'fb_auth_success', token: '${longToken}' }, '*'); } catch(e){}
                    }
                    window.close();
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        res.send(`
            <html>
            <body>
                <script>
                    try {
                        localStorage.setItem('fb_auth_error', '${error.message.replace(/'/g, "\\'")}');
                    } catch(e){}
                    if (window.opener) {
                        try { window.opener.postMessage({ type: 'fb_auth_error', error: '${error.message.replace(/'/g, "\\'")}' }, '*'); } catch(e){}
                    }
                    window.close();
                </script>
            </body>
            </html>
        `);
    }
});

module.exports = router;

