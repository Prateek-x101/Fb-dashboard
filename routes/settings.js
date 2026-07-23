const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const geminiService = require('../services/gemini');

const storagePath = path.join(__dirname, '..', 'config', 'storage.local.json');

const DEFAULT_EXCLUDED_LOCATIONS = [
    'Andaman and Nicobar Islands',
    'Andhra Pradesh',
    'Arunachal Pradesh',
    'Assam',
    'Bihar - India',
    'Chhattisgarh',
    'Daman and Diu',
    'Jammu and Kashmir - India',
    'Jharkhand',
    'Manipur',
    'Meghalaya',
    'Mizoram',
    'Nagaland',
    'Odisha',
    'Sikkim',
    'Telangana',
    'Tripura',
    'Uttar Pradesh',
    'Pondicherry'
].map(name => ({ key: '', name, type: 'region' }));

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
        res.json({
            ...storage.settings,
            defaultExcludedLocations: storage.settings?.defaultExcludedLocations || DEFAULT_EXCLUDED_LOCATIONS
        });
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
