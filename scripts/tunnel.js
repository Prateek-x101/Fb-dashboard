const fs = require('fs');
const path = require('path');
const ngrok = require('@ngrok/ngrok');

// Load environment variables from .env if present
try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of envLines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const [k, ...v] = trimmed.split('=');
            if (k && v.length) process.env[k.trim()] = v.join('=').trim();
        }
    }
} catch (e) {}

const PORT = process.env.PORT || 5000;

function getStorageSettings() {
    try {
        const storagePath = path.join(__dirname, '..', 'config', 'storage.local.json');
        if (fs.existsSync(storagePath)) {
            const data = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
            return data.settings || {};
        }
    } catch (e) {}
    return {};
}

function saveActiveTunnel(url) {
    try {
        const configDir = path.join(__dirname, '..', 'config');
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, 'active-tunnel.json'), JSON.stringify({
            url,
            callbackUrl: `${url}/api/accounts/auth/facebook/callback`,
            updatedAt: new Date().toISOString()
        }, null, 2));
    } catch (e) {}
}

async function startTunnel() {
    const settings = getStorageSettings();
    const authtoken = process.env.NGROK_AUTHTOKEN || settings.ngrokAuthtoken;
    const domain = process.env.NGROK_DOMAIN || settings.ngrokDomain;

    if (!authtoken) {
        console.error('[Tunnel Error] NGROK_AUTHTOKEN is missing! Please configure it in .env or Settings.');
        process.exit(1);
    }

    try {
        console.log(`[Tunnel] Connecting permanent Ngrok tunnel (${domain})...`);
        const options = { addr: PORT, authtoken };
        if (domain) options.domain = domain;
        
        const listener = await ngrok.forward(options);
        const url = listener.url();
        const callbackUrl = `${url}/api/accounts/auth/facebook/callback`;

        console.log('\n' + '='.repeat(65));
        console.log('🚀 PERMANENT HTTPS TUNNEL ACTIVE!');
        console.log('🌐 Dashboard URL:       ' + url);
        console.log('📋 Meta Redirect URI:   ' + callbackUrl);
        console.log('='.repeat(65) + '\n');

        saveActiveTunnel(url);

        // Keep process running indefinitely
        setInterval(() => {}, 1000 * 60 * 60);
    } catch (err) {
        console.error('[Tunnel Error]:', err.message);
        process.exit(1);
    }
}

startTunnel();
