const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const facebookService = require('../services/facebook');

const storagePath = path.join(__dirname, '..', 'config', 'storage.json');

function getStorage() {
    if (fs.existsSync(storagePath)) {
        const data = fs.readFileSync(storagePath, 'utf8');
        return JSON.parse(data);
    }
    return { accounts: [], settings: {}, recentCampaigns: [] };
}

function saveStorage(data) {
    fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), 'utf8');
}

router.get('/', (req, res) => {
    try {
        const storage = getStorage();
        res.json(storage.accounts || []);
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
                    pageId: pageId || ''
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

module.exports = router;

