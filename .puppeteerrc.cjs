/**
 * Puppeteer configuration for Render deployment.
 * Ensures Chromium is cached in node_modules (default) and uses
 * the correct executable path on Linux.
 */
const { join } = require('path');

module.exports = {
    // Cache Chromium inside the project so Render can find it
    cacheDirectory: join(__dirname, 'node_modules', '.cache', 'puppeteer'),
};
