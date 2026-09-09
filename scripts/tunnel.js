const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5000;
const isWindows = process.platform === 'win32';

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

async function startNgrok(authtoken, domain) {
    try {
        const ngrok = require('@ngrok/ngrok');
        console.log(`[Tunnel] Connecting permanent Ngrok tunnel (${domain || 'auto'})...`);
        const options = { addr: PORT, authtoken };
        if (domain) options.domain = domain;
        const listener = await ngrok.forward(options);
        const url = listener.url();
        console.log('\n=======================================================');
        console.log('🚀 PERMANENT STATIC HTTPS TUNNEL ACTIVE!');
        console.log('🌐 Dashboard URL:       ' + url);
        console.log('📋 Meta Redirect URI:   ' + url + '/api/accounts/auth/facebook/callback');
        console.log('=======================================================\n');
        saveActiveTunnel(url);
    } catch (err) {
        console.error('[Tunnel] Ngrok connection failed:', err.message);
        console.log('[Tunnel] Falling back to Cloudflare tunnel...');
        startCloudflare();
    }
}

function findCloudflared() {
    if (isWindows) {
        const paths = [
            'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
            'C:\\Program Files\\cloudflared\\cloudflared.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cloudflared', 'cloudflared.exe')
        ];
        for (const p of paths) {
            if (fs.existsSync(p)) return p;
        }
    }
    return 'cloudflared';
}

function startCloudflare() {
    const settings = getStorageSettings();
    const token = process.env.CLOUDFLARE_TUNNEL_TOKEN || settings.cloudflareTunnelToken;
    const bin = findCloudflared();
    const args = token ? ['tunnel', 'run', '--token', token] : ['tunnel', '--url', `http://localhost:${PORT}`];

    console.log(`[Tunnel] Starting Cloudflare Tunnel on port ${PORT}${token ? ' (Permanent Named Tunnel)' : ' (Quick Tunnel)'}...`);
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let capturedUrl = '';
    function handleData(d) {
        const str = d.toString();
        const m = str.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (m && !capturedUrl) {
            capturedUrl = m[0];
            console.log('\n=======================================================');
            console.log('🚀 PUBLIC HTTPS TUNNEL ACTIVE!');
            console.log('🌐 Dashboard URL:       ' + capturedUrl);
            console.log('📋 Meta Redirect URI:   ' + capturedUrl + '/api/accounts/auth/facebook/callback');
            console.log('=======================================================\n');
            saveActiveTunnel(capturedUrl);
        }
        if (process.env.DEBUG_TUNNEL) process.stdout.write(str);
    }

    proc.stdout.on('data', handleData);
    proc.stderr.on('data', handleData);
    proc.on('close', (code) => console.log(`[Tunnel] Exited with code ${code}`));
    process.on('SIGINT', () => { proc.kill(); process.exit(0); });
}

function init() {
    const settings = getStorageSettings();
    const ngrokToken = process.env.NGROK_AUTHTOKEN || settings.ngrokAuthtoken;
    const ngrokDomain = process.env.NGROK_DOMAIN || settings.ngrokDomain;

    if (ngrokToken) {
        startNgrok(ngrokToken, ngrokDomain);
    } else {
        startCloudflare();
    }
}

init();
