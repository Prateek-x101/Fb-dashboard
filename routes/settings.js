const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
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

const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash';
const OBSOLETE_GEMINI_MODELS = new Set();

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
        const configuredModel = storage.settings?.geminiModel;
        res.json({
            ...storage.settings,
            geminiModel: OBSOLETE_GEMINI_MODELS.has(configuredModel) ? DEFAULT_GEMINI_MODEL : (configuredModel || DEFAULT_GEMINI_MODEL),
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
        
        const safeUpdates = { ...updates };
        if (OBSOLETE_GEMINI_MODELS.has(safeUpdates.geminiModel)) safeUpdates.geminiModel = DEFAULT_GEMINI_MODEL;
        storage.settings = { ...storage.settings, ...safeUpdates };
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

// Saved Audiences endpoints
router.get('/saved-audiences', (req, res) => {
    try {
        const storage = getStorage();
        res.json(storage.savedAudiences || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to read saved audiences', details: error.message });
    }
});

router.post('/saved-audiences', (req, res) => {
    try {
        const { name, targeting } = req.body;
        if (!name || !targeting) {
            return res.status(400).json({ error: 'Name and targeting data are required' });
        }
        const storage = getStorage();
        if (!storage.savedAudiences) storage.savedAudiences = [];
        
        // Remove duplicate name if exists
        storage.savedAudiences = storage.savedAudiences.filter(a => a.name !== name);
        
        storage.savedAudiences.push({
            id: uuidv4(),
            name,
            targeting,
            createdAt: new Date().toISOString()
        });
        saveStorage(storage);
        res.json({ success: true, savedAudiences: storage.savedAudiences });
    } catch (error) {
        res.status(500).json({ error: 'Failed to save audience', details: error.message });
    }
});

router.delete('/saved-audiences/:id', (req, res) => {
    try {
        const { id } = req.params;
        const storage = getStorage();
        if (!storage.savedAudiences) storage.savedAudiences = [];
        storage.savedAudiences = storage.savedAudiences.filter(a => a.id !== id && a.name !== id);
        saveStorage(storage);
        res.json({ success: true, savedAudiences: storage.savedAudiences });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete saved audience', details: error.message });
    }
});

module.exports = router;
