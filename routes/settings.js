const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const geminiService = require('../services/gemini');

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
        res.json(storage.settings || {});
    } catch (error) {
        res.status(500).json({ error: 'Failed to read settings', details: error.message });
    }
});

router.post('/', (req, res) => {
    try {
        const updates = req.body;
        const storage = getStorage();
        
        storage.settings = { ...storage.settings, ...updates };
        saveStorage(storage);
        
        res.json({ success: true, settings: storage.settings });
    } catch (error) {
        res.status(500).json({ error: 'Failed to save settings', details: error.message });
    }
});

router.post('/test-gemini', async (req, res) => {
    try {
        const { apiKey, model } = req.body;
        
        if (!apiKey) {
            return res.status(400).json({ error: 'API key is required' });
        }
        
        await geminiService.testConnection(apiKey, model);
        res.json({ success: true, message: 'Connection successful' });
    } catch (error) {
        res.status(500).json({ error: 'Gemini test failed', details: error.message });
    }
});

module.exports = router;
