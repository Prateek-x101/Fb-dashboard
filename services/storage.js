const fs = require('fs');
const path = require('path');

const storagePath = path.join(__dirname, '..', 'config', 'storage.local.json');

function getStorage() {
    let data = { accounts: [], settings: {}, recentCampaigns: [], shopifyStores: [] };
    
    // 1. Read from local storage file if exists
    if (fs.existsSync(storagePath)) {
        try {
            data = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
        } catch (e) {
            console.error('Failed to parse storage.local.json:', e.message);
        }
    }
    
    // Ensure nested properties are initialized
    if (!data.accounts) data.accounts = [];
    if (!data.settings) data.settings = {};
    if (!data.recentCampaigns) data.recentCampaigns = [];
    if (!data.shopifyStores) data.shopifyStores = [];

    // 2. Dynamic Fallback / Merge from Environment Variables (for Render persistent settings)
    if (process.env.FB_APP_ID) {
        data.settings.facebookAppId = process.env.FB_APP_ID;
    }
    if (process.env.FB_APP_SECRET) {
        data.settings.facebookAppSecret = process.env.FB_APP_SECRET;
    }
    if (process.env.GEMINI_API_KEY) {
        data.settings.geminiApiKey = process.env.GEMINI_API_KEY;
    }
    if (process.env.GEMINI_MODEL) {
        data.settings.geminiModel = process.env.GEMINI_MODEL;
    }

    // Parse environment variable Shopify stores (format: Name:URL:Token;Name:URL:Token)
    if (process.env.SHOPIFY_STORES) {
        try {
            const parsedStores = process.env.SHOPIFY_STORES.split(';').map(storeStr => {
                const parts = storeStr.split(':');
                if (parts.length >= 3) {
                    return {
                        id: parts[1].replace(/[^a-zA-Z0-9]/g, ''),
                        shopName: parts[0].trim(),
                        shopUrl: parts[1].trim(),
                        accessToken: parts[2].trim()
                    };
                }
                return null;
            }).filter(Boolean);

            parsedStores.forEach(ps => {
                if (!data.shopifyStores.some(s => s.shopUrl === ps.shopUrl)) {
                    data.shopifyStores.push(ps);
                }
            });
        } catch (err) {
            console.error('Failed to parse SHOPIFY_STORES env var:', err.message);
        }
    }

    // Parse environment variable Facebook Ad Accounts (format: Label:ID:Token:PageID;Label:ID:Token:PageID)
    if (process.env.FB_ACCOUNTS) {
        try {
            const parsedAccounts = process.env.FB_ACCOUNTS.split(';').map(accStr => {
                const parts = accStr.split(':');
                if (parts.length >= 3) {
                    return {
                        id: parts[1].trim(),
                        label: parts[0].trim(),
                        accountId: parts[1].trim(),
                        accessToken: parts[2].trim(),
                        pageId: parts[3] ? parts[3].trim() : ''
                    };
                }
                return null;
            }).filter(Boolean);

            parsedAccounts.forEach(pa => {
                if (!data.accounts.some(a => a.accountId === pa.accountId)) {
                    data.accounts.push(pa);
                }
            });
        } catch (err) {
            console.error('Failed to parse FB_ACCOUNTS env var:', err.message);
        }
    }

    return data;
}

function saveStorage(data) {
    try {
        const dir = path.dirname(storagePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save storage.local.json:', e.message);
    }
}

module.exports = {
    getStorage,
    saveStorage
};
