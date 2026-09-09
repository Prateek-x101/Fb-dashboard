const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5000;
const isWindows = process.platform === 'win32';

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

function getTunnelToken() {
    if (process.env.CLOUDFLARE_TUNNEL_TOKEN) return process.env.CLOUDFLARE_TUNNEL_TOKEN;
    try {
        const storagePath = path.join(__dirname, '..', 'config', 'storage.local.json');
        if (fs.existsSync(storagePath)) {
            const data = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
            if (data.settings?.cloudflareTunnelToken) return data.settings.cloudflareTunnelToken;
        }
    } catch(e){}
    return null;
}

const bin = findCloudflared();
const token = getTunnelToken();
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
    }
    if (process.env.DEBUG_TUNNEL) process.stdout.write(str);
}

proc.stdout.on('data', handleData);
proc.stderr.on('data', handleData);
proc.on('close', (code) => console.log(`[Tunnel] Exited with code ${code}`));
process.on('SIGINT', () => { proc.kill(); process.exit(0); });
