const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { getStorage } = require('../services/storage');
const facebookService = require('../services/facebook');

const BASE = 'https://graph.facebook.com/v25.0';

// Helper for fetch with timeout
async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 12000); // 12 seconds timeout
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────
async function getPageToken(pageId, userToken) {
    try {
        const r = await fetchWithTimeout(`${BASE}/${pageId}?fields=access_token&access_token=${userToken}`);
        const d = await r.json();
        return d.access_token || userToken;
    } catch (_) { return userToken; }
}

function relTime(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    const d = new Date(iso);
    const now = new Date();
    if (d.getFullYear() === now.getFullYear())
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function avatarColor(name) {
    const colors = ['#4361ee','#7209b7','#e63946','#2ec4b6','#f77f00','#0077b6','#6a4c93','#d62828'];
    let h = 0;
    for (let i = 0; i < (name||'').length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
    return colors[Math.abs(h) % colors.length];
}

// type = all | messenger | instagram | fb-comments | ig-comments
router.get('/inbox', async (req, res) => {
    const storage = getStorage();
    const accounts = storage.accounts || [];
    const type = req.query.type || 'all';
    const filterPageId = (req.query.pageId || '').trim();
    const items = [];
    const errors = [];

    console.log(`GET /api/comments/inbox - type: ${type}, pageId filter: "${filterPageId}"`);

    await Promise.all(accounts.map(async (acc) => {
        const token = acc.accessToken;
        if (!token) return;

        try {
            // Get all Pages connected to this user account access token
            const pagesResult = await facebookService.getConnectedInstagram(token);
            const pages = pagesResult.data || [];

            // Let's process all pages in parallel!
            await Promise.all(pages.map(async (page) => {
                // If filterPageId is set, only process if page.id matches filterPageId
                if (filterPageId && filterPageId !== 'undefined' && filterPageId !== 'null' && String(page.id).trim() !== String(filterPageId).trim()) {
                    return;
                }

                const pageId = page.id;
                const pageName = page.name;
                const pageToken = page.access_token || token;
                const instagramAccountId = page.instagram_business_account?.id;
                const instagramUsername = page.instagram_business_account?.username;

                // Create a list of promises to fetch Messenger, Instagram DMs, FB comments, and IG comments in parallel!
                const fetchPromises = [];

                // ── Messenger DMs ─────────────────────────────────────────────────────
                if (type === 'all' || type === 'messenger') {
                    fetchPromises.push((async () => {
                        try {
                            const fields = 'id,participants{name,id},messages.limit(1){message,from,created_time},unread_count,updated_time';
                            const url = `${BASE}/${pageId}/conversations?platform=messenger&fields=${encodeURIComponent(fields)}&limit=30&access_token=${pageToken}`;
                            const r = await fetchWithTimeout(url);
                            const d = await r.json();
                            if (d.error) {
                                errors.push({
                                    accountLabel: `${acc.label || acc.accountId} (${pageName})`,
                                    message: `Messenger: ${d.error.message}`
                                });
                            } else if (d.data) {
                                d.data.forEach(conv => {
                                    const participants = conv.participants?.data || [];
                                    const customer = participants.find(p => p.id !== pageId) || participants[0];
                                    const lastMsg = conv.messages?.data?.[0];
                                    items.push({
                                        type: 'messenger',
                                        id: conv.id,
                                        name: customer?.name || 'Unknown',
                                        preview: lastMsg?.message || '(attachment)',
                                        time: conv.updated_time || lastMsg?.created_time,
                                        unread: conv.unread_count || 0,
                                        source: pageName,
                                        accountId: acc.id,
                                        pageId: pageId,
                                        recipientId: customer?.id,
                                        pageToken,
                                        avatarColor: avatarColor(customer?.name || '?')
                                    });
                                });
                            }
                        } catch (e) { console.warn(`Messenger inbox failed for page ${pageId}:`, e.message); }
                    })());
                }

                // ── Instagram DMs ─────────────────────────────────────────────────────
                if ((type === 'all' || type === 'instagram') && instagramAccountId) {
                    fetchPromises.push((async () => {
                        try {
                            const fields = 'id,participants{username,name,id},messages.limit(1){text,from,created_time},unread_count,updated_time';
                            const url = `${BASE}/${instagramAccountId}/conversations?platform=instagram&fields=${encodeURIComponent(fields)}&limit=30&access_token=${token}`;
                            const r = await fetchWithTimeout(url);
                            const d = await r.json();
                            if (d.error) {
                                errors.push({
                                    accountLabel: `${acc.label || acc.accountId} (@${instagramUsername})`,
                                    message: `Instagram DM: ${d.error.message}`
                                });
                            } else if (d.data) {
                                d.data.forEach(conv => {
                                    const participants = conv.participants?.data || [];
                                    const customer = participants.find(p => p.id !== instagramAccountId) || participants[0];
                                    const lastMsg = conv.messages?.data?.[0];
                                    const name = customer?.name || customer?.username || 'Unknown';
                                    items.push({
                                        type: 'instagram',
                                        id: conv.id,
                                        name,
                                        preview: lastMsg?.text || '(attachment)',
                                        time: conv.updated_time || lastMsg?.created_time,
                                        unread: conv.unread_count || 0,
                                        source: `@${instagramUsername}`,
                                        accountId: acc.id,
                                        pageId: pageId,
                                        igAccountId: instagramAccountId,
                                        recipientId: customer?.id,
                                        avatarColor: avatarColor(name)
                                    });
                                });
                            }
                        } catch (e) { console.warn(`Instagram DM inbox failed for IG ${instagramAccountId}:`, e.message); }
                    })());
                }

                // ── Facebook page comments ────────────────────────────────────────────
                if (type === 'all' || type === 'fb-comments') {
                    fetchPromises.push((async () => {
                        try {
                            const fields = 'id,message,story,full_picture,created_time,comments.summary(true).limit(3){id,message,from,created_time}';
                            const url = `${BASE}/${pageId}/posts?fields=${encodeURIComponent(fields)}&limit=25&access_token=${pageToken}`;
                            const r = await fetchWithTimeout(url);
                            const d = await r.json();
                            if (d.error) {
                                errors.push({
                                    accountLabel: `${acc.label || acc.accountId} (${pageName})`,
                                    message: `FB Comments: ${d.error.message}`
                                });
                            } else if (d.data) {
                                d.data.forEach(post => {
                                    const count = post.comments?.summary?.total_count || 0;
                                    if (count === 0) return;
                                    const latestComments = post.comments?.data || [];
                                    const last = latestComments[latestComments.length - 1];
                                    const commenters = latestComments.slice(0, 2).map(c => c.from?.name?.split(' ')[0] || 'User').join(', ');
                                    items.push({
                                        type: 'fb-comments',
                                        id: post.id,
                                        name: commenters || 'Comment',
                                        caption: post.message || post.story || '(no caption)',
                                        preview: last?.message || '',
                                        time: last?.created_time || post.created_time,
                                        unread: 0,
                                        commentCount: count,
                                        picture: post.full_picture || null,
                                        source: pageName,
                                        accountId: acc.id,
                                        pageId: pageId,
                                        pageToken: pageToken,
                                        avatarColor: avatarColor(commenters)
                                    });
                                });
                            }
                        } catch (e) { console.warn(`FB comments failed for page ${pageId}:`, e.message); }
                    })());
                }

                // ── Instagram post comments ───────────────────────────────────────────
                if ((type === 'all' || type === 'ig-comments') && instagramAccountId) {
                    fetchPromises.push((async () => {
                        try {
                            const fields = 'id,caption,media_type,thumbnail_url,media_url,timestamp,comments_count';
                            const url = `${BASE}/${instagramAccountId}/media?fields=${fields}&limit=25&access_token=${token}`;
                            const r = await fetchWithTimeout(url);
                            const d = await r.json();
                            if (d.error) {
                                errors.push({
                                    accountLabel: `${acc.label || acc.accountId} (@${instagramUsername})`,
                                    message: `IG Comments: ${d.error.message}`
                                });
                            } else if (d.data) {
                                await Promise.all(d.data.filter(m => m.comments_count > 0).map(async (media) => {
                                    let lastComment = null, commenterName = '';
                                    try {
                                        const cr = await fetchWithTimeout(`${BASE}/${media.id}/comments?fields=id,text,username,timestamp&limit=3&access_token=${token}`);
                                        const cd = await cr.json();
                                        const comments = cd.data || [];
                                        lastComment = comments[comments.length - 1];
                                        commenterName = comments.slice(0, 2).map(c => c.username).join(', ');
                                    } catch (_) {}
                                    items.push({
                                        type: 'ig-comments',
                                        id: media.id,
                                        name: commenterName || 'Comment',
                                        caption: media.caption || '(no caption)',
                                        preview: lastComment?.text || '',
                                        time: lastComment?.timestamp || media.timestamp,
                                        unread: 0,
                                        commentCount: media.comments_count,
                                        picture: media.thumbnail_url || media.media_url || null,
                                        source: `@${instagramUsername}`,
                                        accountId: acc.id,
                                        pageId: pageId,
                                        igAccountId: instagramAccountId,
                                        avatarColor: avatarColor(commenterName || '?')
                                    });
                                }));
                            }
                        } catch (e) { console.warn(`Instagram post comments failed for IG ${instagramAccountId}:`, e.message); }
                    })());
                }

                // Wait for all platform fetches of this page to finish
                await Promise.all(fetchPromises);
            }));
        } catch (err) {
            console.error(`Failed to fetch pages/comments for account:`, err.message);
            errors.push({ accountLabel: acc.label || acc.accountId, message: err.message });
        }
    }));

    // Deduplicate items by conversation/post ID
    const seen = new Set();
    const uniqueItems = [];
    for (const item of items) {
        if (item && item.id) {
            if (!seen.has(item.id)) {
                seen.add(item.id);
                uniqueItems.push(item);
            }
        } else {
            uniqueItems.push(item);
        }
    }

    // Sort items by time descending so newest comments/messages show first
    uniqueItems.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));

    res.json({ success: true, data: uniqueItems, errors });
});

// ── GET /api/comments/conversation ───────────────────────────────────────────
// type = messenger | instagram | fb-comments | ig-comments
router.get('/conversation', async (req, res) => {
    const { type, id, accountId, pageId, pageToken, igAccountId } = req.query;
    const storage = getStorage();
    const acc = (storage.accounts || []).find(a => a.id === accountId);
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    const token = acc.accessToken;

    try {
        if (type === 'messenger') {
            const resolvedPageId = pageId || acc.pageId;
            const resolvedPageToken = pageToken || await getPageToken(resolvedPageId, token);
            const fields = 'message,from,created_time,attachments{mime_type,file_url,image_data}';
            const url = `${BASE}/${id}/messages?fields=${encodeURIComponent(fields)}&limit=50&access_token=${resolvedPageToken}`;
            const r = await fetch(url);
            const d = await r.json();
            if (d.error) return res.status(400).json({ error: d.error.message });
            // Reverse to chronological order
            const messages = (d.data || []).reverse().map(m => ({
                id: m.id,
                text: m.message || '',
                from: m.from || {},
                time: m.created_time,
                isPage: m.from?.id === resolvedPageId,
                attachments: m.attachments?.data || []
            }));
            res.json({ messages, pageId: resolvedPageId });
        }
        else if (type === 'instagram') {
            const resolvedIgAccountId = igAccountId || acc.instagramAccountId;
            const fields = 'text,from,created_time,attachments';
            const url = `${BASE}/${id}/messages?fields=${encodeURIComponent(fields)}&limit=50&access_token=${token}`;
            const r = await fetch(url);
            const d = await r.json();
            if (d.error) return res.status(400).json({ error: d.error.message });
            const messages = (d.data || []).reverse().map(m => ({
                id: m.id,
                text: m.text || '',
                from: m.from || {},
                time: m.created_time,
                isPage: m.from?.id === resolvedIgAccountId,
                attachments: m.attachments?.data || []
            }));
            res.json({ messages, igAccountId: resolvedIgAccountId });
        }
        else if (type === 'fb-comments') {
            const resolvedPageId = pageId || acc.pageId;
            const resolvedPageToken = pageToken || await getPageToken(resolvedPageId, token);
            const fields = 'id,message,from,created_time,like_count,comments{id,message,from,created_time,like_count}';
            const r = await fetch(`${BASE}/${id}/comments?fields=${encodeURIComponent(fields)}&limit=100&access_token=${resolvedPageToken}`);
            const d = await r.json();
            if (d.error) return res.status(400).json({ error: d.error.message });
            res.json({ comments: d.data || [], pageToken: resolvedPageToken });
        }
        else if (type === 'ig-comments') {
            const fields = 'id,text,from,created_time,like_count,replies{id,text,from,created_time}';
            const r = await fetch(`${BASE}/${id}/comments?fields=${encodeURIComponent(fields)}&limit=100&access_token=${token}`);
            const d = await r.json();
            if (d.error) return res.status(400).json({ error: d.error.message });
            res.json({ comments: (d.data || []).map(c => ({
                id: c.id, message: c.text, from: { name: c.username }, created_time: c.timestamp,
                like_count: c.like_count || 0,
                replies: (c.replies?.data || []).map(r => ({ id: r.id, message: r.text, from: { name: r.username }, created_time: r.timestamp }))
            })) });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/comments/send ───────────────────────────────────────────────────
// Send a DM (Messenger or Instagram)
router.post('/send', async (req, res) => {
    const { type, recipientId, message, accountId, pageId, pageToken, igAccountId } = req.body;
    const storage = getStorage();
    const acc = (storage.accounts || []).find(a => a.id === accountId);
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    const token = acc.accessToken;
    try {
        if (type === 'messenger') {
            const resolvedPageId = pageId || acc.pageId;
            const resolvedPageToken = pageToken || await getPageToken(resolvedPageId, token);
            
            // Try HUMAN_AGENT tag first to support messaging up to 7 days
            const body = JSON.stringify({
                recipient: { id: recipientId },
                message: { text: message },
                messaging_type: 'MESSAGE_TAG',
                tag: 'HUMAN_AGENT'
            });
            
            console.log(`Attempting HUMAN_AGENT message to ${recipientId} via page ${resolvedPageId}...`);
            let r = await fetch(`${BASE}/${resolvedPageId}/messages?access_token=${resolvedPageToken}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body
            });
            let d = await r.json();
            
            // If HUMAN_AGENT tag isn't approved/supported on the account/app, fallback to standard RESPONSE
            if (d.error) {
                console.warn("HUMAN_AGENT tag failed, retrying with standard RESPONSE:", d.error.message);
                const fallbackBody = JSON.stringify({
                    recipient: { id: recipientId },
                    message: { text: message },
                    messaging_type: 'RESPONSE'
                });
                r = await fetch(`${BASE}/${resolvedPageId}/messages?access_token=${resolvedPageToken}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: fallbackBody
                });
                d = await r.json();
            }

            if (d.error) return res.status(400).json({ error: d.error.message });
            res.json({ success: true, messageId: d.message_id });
        } else if (type === 'instagram') {
            const resolvedIgAccountId = igAccountId || acc.instagramAccountId;
            const body = JSON.stringify({
                recipient: { id: recipientId },
                message: { text: message }
            });
            const r = await fetch(`${BASE}/${resolvedIgAccountId}/messages?access_token=${token}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body
            });
            const d = await r.json();
            if (d.error) return res.status(400).json({ error: d.error.message });
            res.json({ success: true, messageId: d.message_id });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/comments/reply ──────────────────────────────────────────────────
// Reply to a comment (FB or IG)
router.post('/reply', async (req, res) => {
    const { type, commentId, postId, message, accountId, pageId, pageToken } = req.body;
    const storage = getStorage();
    const acc = (storage.accounts || []).find(a => a.id === accountId);
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    const token = acc.accessToken;
    try {
        if (type === 'ig-comments') {
            const body = new URLSearchParams({ message, reply_to_id: commentId, access_token: token });
            const r = await fetch(`${BASE}/${postId}/comments`, { method: 'POST', body });
            const d = await r.json();
            if (d.error) return res.status(400).json({ error: d.error.message });
            res.json({ success: true, id: d.id });
        } else {
            const resolvedPageId = pageId || acc.pageId;
            const resolvedPageToken = pageToken || await getPageToken(resolvedPageId, token);
            const body = new URLSearchParams({ message, access_token: resolvedPageToken });
            const r = await fetch(`${BASE}/${commentId}/comments`, { method: 'POST', body });
            const d = await r.json();
            if (d.error) return res.status(400).json({ error: d.error.message });
            res.json({ success: true, id: d.id });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/comments/like ───────────────────────────────────────────────────
router.post('/like', async (req, res) => {
    const { commentId, accountId } = req.body;
    const storage = getStorage();
    const acc = (storage.accounts || []).find(a => a.id === accountId);
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    const pageToken = acc.pageId ? await getPageToken(acc.pageId, acc.accessToken) : acc.accessToken;
    const r = await fetch(`${BASE}/${commentId}/likes`, { method: 'POST', body: new URLSearchParams({ access_token: pageToken }) });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json({ success: true });
});

// ── DELETE /api/comments/:id ──────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    const { accountId } = req.query;
    const storage = getStorage();
    const acc = (storage.accounts || []).find(a => a.id === accountId);
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    const pageToken = acc.pageId ? await getPageToken(acc.pageId, acc.accessToken) : acc.accessToken;
    const r = await fetch(`${BASE}/${req.params.id}?access_token=${pageToken}`, { method: 'DELETE' });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json({ success: true });
});

module.exports = router;
