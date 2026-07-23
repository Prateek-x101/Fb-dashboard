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

