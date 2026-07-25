const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { getStorage } = require('../services/storage');

const BASE = 'https://graph.facebook.com/v25.0';

// ── helpers ───────────────────────────────────────────────────────────────────

async function getPageToken(pageId, userToken) {
    const r = await fetch(`${BASE}/${pageId}?fields=access_token&access_token=${userToken}`);
    const d = await r.json();
    return d.access_token || userToken; // fall back to user token if no page token
}

function relTime(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── GET /api/comments/feed ────────────────────────────────────────────────────
// Returns combined list of FB posts + IG media that have comments, sorted newest first
router.get('/feed', async (req, res) => {
    try {
        const storage = getStorage();
        const accounts = storage.accounts || [];
        const filter = req.query.filter || 'all'; // 'all' | 'pages' | 'instagram'

        const items = [];

        await Promise.all(accounts.map(async (acc) => {
            const token = acc.accessToken;

            // ── Facebook page posts ─────────────────────────────────────────
            if ((filter === 'all' || filter === 'pages') && acc.pageId) {
                try {
                    const pageToken = await getPageToken(acc.pageId, token);
                    const fields = [
                        'id', 'message', 'story', 'full_picture', 'created_time',
                        'comments.summary(true).limit(5){id,message,from,created_time,like_count}'
                    ].join(',');
                    const url = `${BASE}/${acc.pageId}/posts?fields=${encodeURIComponent(fields)}&limit=25&access_token=${pageToken}`;
                    const r = await fetch(url);
                    const d = await r.json();
                    if (d.data) {
                        d.data.forEach(post => {
                            const commentCount = post.comments?.summary?.total_count || 0;
                            if (commentCount === 0) return; // skip posts with no comments
                            const latestComments = (post.comments?.data || []).slice(0, 3);
                            const latestTime = latestComments.length > 0
                                ? latestComments[latestComments.length - 1].created_time
                                : post.created_time;
                            items.push({
                                type: 'fb',
                                id: post.id,
                                message: post.message || post.story || '(no caption)',
                                picture: post.full_picture || null,
                                created_time: post.created_time,
                                latest_activity: latestTime,
                                comment_count: commentCount,
                                latest_comments: latestComments,
                                page_name: acc.label || acc.name || 'Page',
                                page_id: acc.pageId,
                                account_id: acc.id,
                                page_token: pageToken
                            });
                        });
                    }
                } catch (e) {
                    console.warn(`FB feed failed for account ${acc.id}:`, e.message);
                }
            }

            // ── Instagram media ─────────────────────────────────────────────
            if ((filter === 'all' || filter === 'instagram') && acc.instagramAccountId) {
                try {
                    const fields = 'id,caption,media_type,thumbnail_url,media_url,timestamp,comments_count,like_count';
                    const url = `${BASE}/${acc.instagramAccountId}/media?fields=${fields}&limit=25&access_token=${token}`;
                    const r = await fetch(url);
                    const d = await r.json();
                    if (d.data) {
                        await Promise.all(d.data.map(async (media) => {
                            if (!media.comments_count) return;
                            // Fetch a few recent comments for preview
                            let previewComments = [];
                            try {
                                const cr = await fetch(`${BASE}/${media.id}/comments?fields=id,text,username,timestamp&limit=3&access_token=${token}`);
                                const cd = await cr.json();
                                previewComments = cd.data || [];
                            } catch (_) {}
                            const latestTime = previewComments.length > 0
                                ? previewComments[previewComments.length - 1].timestamp
                                : media.timestamp;
                            items.push({
                                type: 'ig',
                                id: media.id,
                                message: media.caption || '(no caption)',
                                picture: media.thumbnail_url || media.media_url || null,
                                created_time: media.timestamp,
                                latest_activity: latestTime,
                                comment_count: media.comments_count,
                                latest_comments: previewComments.map(c => ({
                                    id: c.id,
                                    message: c.text,
                                    from: { name: c.username },
                                    created_time: c.timestamp
                                })),
                                page_name: `@${acc.instagramUsername || 'Instagram'}`,
                                page_id: acc.instagramAccountId,
                                account_id: acc.id,
                                page_token: token
                            });
                        }));
                    }
                } catch (e) {
                    console.warn(`IG feed failed for account ${acc.id}:`, e.message);
                }
            }
        }));

        // Sort by latest activity descending
        items.sort((a, b) => new Date(b.latest_activity) - new Date(a.latest_activity));
        res.json({ data: items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/comments/thread ──────────────────────────────────────────────────
// Returns full comment thread for a post/media
// query: type=fb|ig, postId, accountId
router.get('/thread', async (req, res) => {
    try {
        const { type, postId, accountId } = req.query;
        const storage = getStorage();
        const acc = (storage.accounts || []).find(a => a.id === accountId);
        if (!acc) return res.status(404).json({ error: 'Account not found' });

        const token = acc.accessToken;

        if (type === 'ig') {
            // Instagram comments + replies
            const fields = 'id,text,username,timestamp,like_count,replies{id,text,username,timestamp}';
            const r = await fetch(`${BASE}/${postId}/comments?fields=${fields}&limit=50&access_token=${token}`);
            const d = await r.json();
            if (d.error) return res.status(400).json({ error: d.error.message });
            res.json({ data: (d.data || []).map(c => ({
                id: c.id,
                message: c.text,
                from: { name: c.username },
                created_time: c.timestamp,
                like_count: c.like_count || 0,
                replies: (c.replies?.data || []).map(r => ({
                    id: r.id,
                    message: r.text,
                    from: { name: r.username },
                    created_time: r.timestamp
                }))
            })) });
        } else {
            // Facebook comments + replies
            const pageToken = acc.pageId ? await getPageToken(acc.pageId, token) : token;
            const fields = 'id,message,from,created_time,like_count,can_reply_privately,comments{id,message,from,created_time,like_count}';
            const r = await fetch(`${BASE}/${postId}/comments?fields=${encodeURIComponent(fields)}&limit=50&access_token=${pageToken}`);
            const d = await r.json();
            if (d.error) return res.status(400).json({ error: d.error.message });
            const comments = (d.data || []).map(c => ({
                id: c.id,
                message: c.message,
                from: c.from || { name: 'Unknown' },
                created_time: c.created_time,
                like_count: c.like_count || 0,
                replies: (c.comments?.data || []).map(r => ({
                    id: r.id,
                    message: r.message,
                    from: r.from || { name: 'Unknown' },
                    created_time: r.created_time,
                    like_count: r.like_count || 0
                }))
            }));
            res.json({ data: comments, page_token: pageToken });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/comments/reply ──────────────────────────────────────────────────
// Reply to a FB comment or IG comment
// body: { type, commentId, postId, message, accountId }
router.post('/reply', async (req, res) => {
    try {
        const { type, commentId, postId, message, accountId } = req.body;
        if (!message || !accountId) return res.status(400).json({ error: 'Missing message or accountId' });

        const storage = getStorage();
        const acc = (storage.accounts || []).find(a => a.id === accountId);
        if (!acc) return res.status(404).json({ error: 'Account not found' });

        const token = acc.accessToken;

        if (type === 'ig') {
            // Instagram reply: POST /{media-id}/comments with reply_to_id
            const body = new URLSearchParams({ message, reply_to_id: commentId, access_token: token });
            const r = await fetch(`${BASE}/${postId}/comments`, { method: 'POST', body });
            const d = await r.json();
            if (d.error) return res.status(400).json({ error: d.error.message });
            res.json({ success: true, id: d.id });
        } else {
            // Facebook reply: POST /{comment-id}/comments
            const pageToken = acc.pageId ? await getPageToken(acc.pageId, token) : token;
            const body = new URLSearchParams({ message, access_token: pageToken });
            const r = await fetch(`${BASE}/${commentId}/comments`, { method: 'POST', body });
            const d = await r.json();
            if (d.error) return res.status(400).json({ error: d.error.message });
            res.json({ success: true, id: d.id });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/comments/like ───────────────────────────────────────────────────
// Like a FB comment
router.post('/like', async (req, res) => {
    try {
        const { commentId, accountId } = req.body;
        const storage = getStorage();
        const acc = (storage.accounts || []).find(a => a.id === accountId);
        if (!acc) return res.status(404).json({ error: 'Account not found' });
        const pageToken = acc.pageId ? await getPageToken(acc.pageId, acc.accessToken) : acc.accessToken;
        const r = await fetch(`${BASE}/${commentId}/likes`, { method: 'POST', body: new URLSearchParams({ access_token: pageToken }) });
        const d = await r.json();
        if (d.error) return res.status(400).json({ error: d.error.message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── DELETE /api/comments/:commentId ──────────────────────────────────────────
// Hide/delete a comment
router.delete('/:commentId', async (req, res) => {
    try {
        const { commentId } = req.params;
        const { accountId } = req.query;
        const storage = getStorage();
        const acc = (storage.accounts || []).find(a => a.id === accountId);
        if (!acc) return res.status(404).json({ error: 'Account not found' });
        const pageToken = acc.pageId ? await getPageToken(acc.pageId, acc.accessToken) : acc.accessToken;
        const r = await fetch(`${BASE}/${commentId}?access_token=${pageToken}`, { method: 'DELETE' });
        const d = await r.json();
        if (d.error) return res.status(400).json({ error: d.error.message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
