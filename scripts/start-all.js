const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';

console.log('='.repeat(65));
console.log('🚀 Starting Ad Pilot Dashboard & Permanent Tunnel...');
console.log('='.repeat(65));

// 1. Start Server
const serverProc = spawn(process.execPath, [path.join(rootDir, 'server.js')], {
    cwd: rootDir,
    stdio: 'inherit'
});

serverProc.on('error', (err) => {
    console.error('[Server Error]:', err.message);
});

// 2. Start Tunnel
const tunnelScript = path.join(rootDir, 'scripts', 'tunnel.js');
const tunnelProc = spawn(process.execPath, [tunnelScript], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe']
});

let browserOpened = false;

function openBrowser(url) {
    if (browserOpened) return;
    browserOpened = true;
    console.log(`[App] Opening browser to: ${url}`);
    if (isWindows) {
        exec(`start "" "${url}"`);
    } else if (process.platform === 'darwin') {
        exec(`open "${url}"`);
    } else {
        exec(`xdg-open "${url}"`);
    }
}

function handleTunnelOutput(data) {
    const text = data.toString();
    process.stdout.write(text);

    const match = text.match(/https:\/\/[a-zA-Z0-9-.]+\.(?:ngrok-free\.dev|ngrok-free\.app|ngrok\.app|ngrok\.io)/);
    if (match && !browserOpened) {
        const tunnelUrl = match[0];
        setTimeout(() => openBrowser(tunnelUrl), 1000);
    }
}

tunnelProc.stdout.on('data', handleTunnelOutput);
tunnelProc.stderr.on('data', handleTunnelOutput);

// Cleanup on exit
function shutdown() {
    console.log('\n[App] Shutting down Ad Pilot & Tunnel...');
    try { serverProc.kill(); } catch(e){}
    try { tunnelProc.kill(); } catch(e){}
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
