// public/js/comments.js — Full Inbox Manager
(function () {
'use strict';

const InboxManager = {
    currentTab: 'all',
    currentItem: null,
    items: [],
    replyToId: null,
    loading: false,

    TABS: [
        { id: 'all',         label: 'All messages',       icon: '💬' },
        { id: 'messenger',   label: 'Messenger',          icon: '🔵' },
        { id: 'instagram',   label: 'Instagram',          icon: '📸' },
        { id: 'fb-comments', label: 'Facebook comments',  icon: '👍' },
        { id: 'ig-comments', label: 'Instagram comments', icon: '❤️' }
    ],

    init() {
        this.renderTabs();
        this.bindSearch();
        document.getElementById('cm-refresh-btn')?.addEventListener('click', () => this.reload());
        
        // Bind page filter change
        document.getElementById('cm-page-filter')?.addEventListener('change', () => this.reload());
    },

    onShow() {
        this.loadPagesFilter();
        if (!this.items.length) this.loadInbox();
    },

    reload() {
        this.items = [];
        this.currentItem = null;
        this.clearThread();
        this.loadInbox();
    },

    // ── Tabs ─────────────────────────────────────────────────────────────────
    renderTabs() {
        const bar = document.getElementById('cm-tabs-bar');
        if (!bar) return;
        bar.innerHTML = this.TABS.map(t =>
            `<button class="cm2-tab${t.id === this.currentTab ? ' active' : ''}" data-tab="${t.id}">
                <span class="cm2-tab-icon">${t.icon}</span>
                <span class="cm2-tab-label">${t.label}</span>
            </button>`
        ).join('');
        bar.querySelectorAll('.cm2-tab').forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });
    },

    switchTab(tab) {
        this.currentTab = tab;
        this.items = [];
        this.currentItem = null;
        this.replyToId = null;
        this.clearThread();
        this.renderTabs();
        this.loadInbox();
    },

    // ── Load inbox list ───────────────────────────────────────────────────────
    async loadInbox() {
        this.loading = true;
        const list = document.getElementById('cm-list');
        if (list) list.innerHTML = `<div class="cm2-loading"><div class="cm2-spinner"></div> Loading…</div>`;
 
        const type = this.currentTab === 'all' ? 'all' : this.currentTab;
        const pageId = document.getElementById('cm-page-filter')?.value || '';
        const url = `/api/comments/inbox?type=${type}&pageId=${pageId}`;
 
        const reqTime = Date.now();
        this._lastReqTime = reqTime;

        try {
            const data = await window.API.request(url);
            if (this._lastReqTime !== reqTime) return;

            this.items = data.data || [];
            
            if (data.errors && data.errors.length > 0) {
                const warningMsg = data.errors.map(err => `${err.accountLabel}: ${err.message}`).join(', ');
                window.AppController?.showToast(`⚠️ Connection warning: ${warningMsg}`, 'warning', 10000);
            }
            
            this.renderList();
        } catch (e) {
            if (this._lastReqTime !== reqTime) return;
            if (list) list.innerHTML = `<div class="cm2-empty">⚠️ ${this.esc(e.message)}</div>`;
        } finally {
            if (this._lastReqTime === reqTime) {
                this.loading = false;
            }
        }
    },

    // ── Render conversation/post list ─────────────────────────────────────────
    renderList() {
        const list = document.getElementById('cm-list');
        if (!list) return;
        const pageFilter = document.getElementById('cm-page-filter');
        const selectedPageId = pageFilter ? pageFilter.value : '';
        
        let filtered = this.items;
        if (selectedPageId) {
            filtered = filtered.filter(it => it.pageId && String(it.pageId).trim() === String(selectedPageId).trim());
        }

        const query = (document.getElementById('cm-search')?.value || '').toLowerCase();
        if (query) {
            filtered = filtered.filter(it => (it.name + it.preview + it.source).toLowerCase().includes(query));
        }

        if (!filtered.length) {
            list.innerHTML = `<div class="cm2-empty">
                <div style="font-size:2.5rem;margin-bottom:8px;">💬</div>
                <div>No conversations found.</div>
                <div style="font-size:0.78rem;margin-top:6px;color:var(--text-secondary)">Make sure accounts have a Page ID set in Accounts.</div>
            </div>`;
            return;
        }

        list.innerHTML = filtered.map((item, idx) => {
            const isCommentType = item.type === 'fb-comments' || item.type === 'ig-comments';
            const initial = (item.name || '?').charAt(0).toUpperCase();
            const preview = (item.preview || '').length > 55 ? item.preview.slice(0, 55) + '…' : (item.preview || '');
            const sourceLabel = item.source.length > 18 ? item.source.slice(0, 18) + '…' : item.source;
            const unreadDot = item.unread > 0 ? `<span class="cm2-unread-dot">${item.unread}</span>` : '';
            const commentBadge = isCommentType ? `<span class="cm2-badge-comment">${item.commentCount} 💬</span>` : '';
            const time = this.relTime(item.time);

            // Platform SVGs for Messenger, Instagram, Facebook Comments
            const messengerSvg = `<svg width="10" height="10" viewBox="0 0 24 24" fill="#0084FF"><path d="M12 2C6.36 2 2 6.13 2 11.7c0 3.23 1.45 6.06 3.75 7.96.19.16.3.4.29.64l-.08 2.25c-.02.48.47.85.92.68l2.5-1c.21-.08.44-.08.64.01 1.25.5 2.62.76 3.98.76 5.64 0 10-4.13 10-9.7S17.64 2 12 2zm1.31 12.8-2.61-2.77-5.07 2.77 5.56-5.91 2.67 2.77 5.01-2.77-5.56 5.91z"/></svg>`;
            const instagramSvg = `<svg width="10" height="10" viewBox="0 0 24 24" fill="#E1306C"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.051.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/></svg>`;
            const facebookSvg = `<svg width="10" height="10" viewBox="0 0 24 24" fill="#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`;

            let badgeSvg = '';
            if (item.type === 'messenger') badgeSvg = messengerSvg;
            else if (item.type === 'instagram' || item.type === 'ig-comments') badgeSvg = instagramSvg;
            else if (item.type === 'fb-comments') badgeSvg = facebookSvg;

            const profilePicHtml = (item.type === 'messenger' && item.recipientId && item.pageToken)
                ? `<img src="https://graph.facebook.com/${item.recipientId}/picture?type=square&access_token=${item.pageToken}" onerror="this.style.display='none'; this.nextElementSibling.style.display='inline';" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;">`
                : '';

            return `<div class="cm2-item${this.currentItem === item ? ' selected' : ''}" data-idx="${idx}" onclick="InboxManager.openItem(${idx})">
                <div class="cm2-avatar-wrapper" style="position:relative; width:40px; height:40px; flex-shrink:0;">
                    <div class="cm2-avatar" style="background:${item.avatarColor}; width:100%; height:100%; display:flex; align-items:center; justify-content:center; border-radius:50%; font-weight:bold; color:white; overflow:hidden;">
                        ${profilePicHtml}
                        <span class="cm2-avatar-fallback" style="font-size:1.1rem;">${initial}</span>
                    </div>
                    <div class="cm2-platform-badge" style="position:absolute; bottom:-3px; right:-3px; background:white; border-radius:50%; width:16px; height:16px; display:flex; align-items:center; justify-content:center; box-shadow:0 1px 3px rgba(0,0,0,0.3); border:1px solid #ddd; padding:2px;">
                        ${badgeSvg}
                    </div>
                </div>
                <div class="cm2-item-body" style="margin-left:12px;">
                    <div class="cm2-item-top">
                        <span class="cm2-item-name${item.unread > 0 ? ' unread' : ''}">${this.esc(item.name)}</span>
                        <span class="cm2-item-time">${time}</span>
                    </div>
                    <div class="cm2-item-preview">${this.esc(preview) || '&nbsp;'}</div>
                    <div class="cm2-item-source" style="font-size:0.75rem; color:var(--text-secondary); margin-top:2px;">${this.esc(sourceLabel)}${commentBadge}${unreadDot}</div>
                </div>
            </div>`;
        }).join('');
    },

    bindSearch() {
        const inp = document.getElementById('cm-search');
        if (inp) inp.addEventListener('input', () => this.renderList());
    },

    // ── Open a conversation / post ────────────────────────────────────────────
    async openItem(idx) {
        const item = this.items[idx];
        if (!item) return;
        this.currentItem = item;
        this.replyToId = null;
        this.renderList(); // update highlight
        this.showThreadSkeleton(item);
        await this.loadThread(item);
    },

    showThreadSkeleton(item) {
        const panel = document.getElementById('cm-thread-panel');
        if (!panel) return;
        const isComment = item.type === 'fb-comments' || item.type === 'ig-comments';
        const typeLabel = { messenger:'Messenger', instagram:'Instagram DM', 'fb-comments':'Facebook Comments', 'ig-comments':'Instagram Comments' }[item.type] || '';
        const typeIcon = { messenger:'🔵', instagram:'📸', 'fb-comments':'👍', 'ig-comments':'❤️' }[item.type] || '💬';
        const headerPic = isComment && item.picture
            ? `<img src="${item.picture}" class="cm2-thread-post-pic" onerror="this.style.display='none'">`
            : '';
        const headerName = isComment
            ? `<div class="cm2-thread-post-caption">${this.esc((item.caption||'').slice(0,100))}${(item.caption||'').length>100?'…':''}</div>`
            : `<div class="cm2-thread-user-name">${this.esc(item.name)}</div>`;

        panel.innerHTML = `
            <div class="cm2-thread-header">
                ${headerPic}
                <div class="cm2-thread-header-info">
                    ${headerName}
                    <div class="cm2-thread-source">${typeIcon} ${this.esc(item.source)} · ${typeLabel}</div>
                </div>
            </div>
            <div class="cm2-messages" id="cm2-messages">
                <div class="cm2-loading"><div class="cm2-spinner"></div> Loading thread…</div>
            </div>
            <div class="cm2-reply-bar" id="cm2-reply-bar">
                <div class="cm2-reply-to" id="cm2-reply-to" style="display:none"></div>
                <div class="cm2-input-row">
                    <textarea id="cm2-input" class="cm2-input" placeholder="${isComment ? 'Write a comment…' : 'Reply in ' + typeLabel + '…'}" rows="1"
                        oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"></textarea>
                    <button class="cm2-send-btn" onclick="InboxManager.send()" title="Send">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                    </button>
                </div>
            </div>`;

        // Bind Enter key
        setTimeout(() => {
            const inp = document.getElementById('cm2-input');
            if (inp) inp.addEventListener('keydown', e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); InboxManager.send(); }
            });
        }, 0);
    },

    async loadThread(item) {
        const msgs = document.getElementById('cm2-messages');
        try {
            const pageParam = item.pageId ? `&pageId=${item.pageId}` : '';
            const pageTokenParam = item.pageToken ? `&pageToken=${encodeURIComponent(item.pageToken)}` : '';
            const igParam = item.igAccountId ? `&igAccountId=${item.igAccountId}` : '';
            const data = await window.API.request(
                `/api/comments/conversation?type=${item.type}&id=${item.id}&accountId=${item.accountId}${pageParam}${pageTokenParam}${igParam}`
            );
            if (item.type === 'messenger' || item.type === 'instagram') {
                this.renderMessages(data.messages || [], item);
            } else {
                this.renderComments(data.comments || [], item);
            }
        } catch (e) {
            if (msgs) msgs.innerHTML = `<div class="cm2-empty">⚠️ ${this.esc(e.message)}</div>`;
        }
    },

    // ── Render DM bubbles ─────────────────────────────────────────────────────
    renderMessages(messages, item) {
        const msgs = document.getElementById('cm2-messages');
        if (!msgs) return;
        if (!messages.length) {
            msgs.innerHTML = `<div class="cm2-empty">No messages yet.</div>`;
            return;
        }
        msgs.innerHTML = messages.map(m => {
            const mine = m.isPage;
            const text = m.text || '';
            const time = this.relTime(m.time);
            const name = m.from?.name || m.from?.username || 'User';
            const initial = name.charAt(0).toUpperCase();
            const avatar = mine ? '' : `<div class="cm2-msg-avatar" style="background:${item.avatarColor}">${initial}</div>`;
            return `<div class="cm2-msg-row ${mine ? 'mine' : 'theirs'}">
                ${avatar}
                <div class="cm2-msg-bubble-wrap">
                    ${!mine ? `<div class="cm2-msg-sender">${this.esc(name)}</div>` : ''}
                    <div class="cm2-msg-bubble">${this.esc(text)}</div>
                    <div class="cm2-msg-time">${time}</div>
                </div>
            </div>`;
        }).join('');
        msgs.scrollTop = msgs.scrollHeight;
    },

    // ── Render comment threads ────────────────────────────────────────────────
    renderComments(comments, item) {
        const msgs = document.getElementById('cm2-messages');
        if (!msgs) return;
        if (!comments.length) {
            msgs.innerHTML = `<div class="cm2-empty">No comments yet.</div>`;
            return;
        }
        msgs.innerHTML = comments.map(c => this.commentHTML(c, item)).join('');
        msgs.scrollTop = msgs.scrollHeight;
    },

    commentHTML(c, item, isReply = false) {
        const name = c.from?.name || '?';
        const initial = name.charAt(0).toUpperCase();
        const color = this.avatarColor(name);
        const time = this.relTime(c.created_time);
        const replies = (c.replies || []).map(r => this.commentHTML(r, item, true)).join('');
        const likeBtn = !isReply && item.type === 'fb-comments'
            ? `<button class="cm2-action" onclick="InboxManager.likeComment('${c.id}')">👍 Like${c.like_count > 0 ? ' · ' + c.like_count : ''}</button>`
            : (c.like_count > 0 ? `<span class="cm2-action-info">👍 ${c.like_count}</span>` : '');
        return `<div class="cm2-comment${isReply ? ' reply' : ''}">
            <div class="cm2-comment-av" style="background:${color}">${initial}</div>
            <div class="cm2-comment-right">
                <div class="cm2-comment-bubble">
                    <span class="cm2-comment-name">${this.esc(name)}</span>
                    <span class="cm2-comment-text">${this.esc(c.message || '')}</span>
                </div>
                <div class="cm2-comment-meta">
                    <span class="cm2-comment-time">${time}</span>
                    ${likeBtn}
                    ${!isReply ? `<button class="cm2-action" onclick="InboxManager.setReplyTo('${c.id}','${this.esc(name)}')">↩ Reply</button>` : ''}
                    <button class="cm2-action cm2-del" onclick="InboxManager.deleteComment('${c.id}')">Delete</button>
                </div>
                ${replies ? `<div class="cm2-replies">${replies}</div>` : ''}
            </div>
        </div>`;
    },

    // ── Reply to / set reply context ──────────────────────────────────────────
    setReplyTo(commentId, name) {
        this.replyToId = commentId;
        const el = document.getElementById('cm2-reply-to');
        if (el) {
            el.style.display = 'flex';
            el.innerHTML = `<span>↩ Replying to <strong>${this.esc(name)}</strong></span>
                <button class="cm2-cancel-reply" onclick="InboxManager.clearReplyTo()">✕</button>`;
        }
        document.getElementById('cm2-input')?.focus();
    },

    clearReplyTo() {
        this.replyToId = null;
        const el = document.getElementById('cm2-reply-to');
        if (el) el.style.display = 'none';
    },

    // ── Send message / comment ────────────────────────────────────────────────
    async send() {
        const inp = document.getElementById('cm2-input');
        const text = inp?.value.trim();
        if (!text || !this.currentItem) return;
        const item = this.currentItem;
        const btn = document.querySelector('.cm2-send-btn');
        if (btn) btn.disabled = true;
        try {
            if (item.type === 'messenger' || item.type === 'instagram') {
                await window.API.request('/api/comments/send', {
                    method: 'POST',
                    body: JSON.stringify({ 
                        type: item.type, 
                        recipientId: item.recipientId, 
                        message: text, 
                        accountId: item.accountId,
                        pageId: item.pageId,
                        pageToken: item.pageToken,
                        igAccountId: item.igAccountId
                    })
                });
            } else {
                // Comment reply
                const commentId = this.replyToId || item.id;
                await window.API.request('/api/comments/reply', {
                    method: 'POST',
                    body: JSON.stringify({ 
                        type: item.type, 
                        commentId, 
                        postId: item.id, 
                        message: text, 
                        accountId: item.accountId,
                        pageId: item.pageId,
                        pageToken: item.pageToken
                    })
                });
            }
            inp.value = ''; inp.style.height = 'auto';
            this.clearReplyTo();
            window.AppController?.showToast('Sent ✅', 'success');
            await this.loadThread(item);
        } catch (e) {
            window.AppController?.showToast('Failed: ' + e.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    },

    async likeComment(commentId) {
        if (!this.currentItem) return;
        try {
            await window.API.request('/api/comments/like', { method: 'POST', body: JSON.stringify({ commentId, accountId: this.currentItem.accountId }) });
            window.AppController?.showToast('Liked 👍', 'success');
            await this.loadThread(this.currentItem);
        } catch (e) { window.AppController?.showToast(e.message, 'error'); }
    },

    async deleteComment(commentId) {
        if (!this.currentItem || !confirm('Delete this comment?')) return;
        try {
            await window.API.request(`/api/comments/${commentId}?accountId=${this.currentItem.accountId}`, { method: 'DELETE' });
            window.AppController?.showToast('Deleted', 'success');
            await this.loadThread(this.currentItem);
        } catch (e) { window.AppController?.showToast(e.message, 'error'); }
    },

    async loadPagesFilter() {
        const pageFilter = document.getElementById('cm-page-filter');
        if (!pageFilter) return;

        const currentSelected = pageFilter.value;

        try {
            const result = await window.API.request('/api/accounts/pages');
            pageFilter.innerHTML = '<option value="">-- All Pages --</option>';
            if (result.pages && result.pages.length) {
                result.pages.forEach(page => {
                    const opt = document.createElement('option');
                    opt.value = page.id;
                    
                    // Check if page has linked Instagram business account
                    if (page.instagram_business_account) {
                        const igName = page.instagram_business_account.username || page.instagram_business_account.name || 'ig';
                        opt.textContent = `${page.name} (FB + IG: @${igName})`;
                    } else {
                        opt.textContent = `${page.name} (FB)`;
                    }

                    if (page.id === currentSelected) {
                        opt.selected = true;
                    }
                    pageFilter.appendChild(opt);
                });
            }
            this.renderList();
        } catch (e) {
            console.error("Failed to load page filter values:", e.message);
        }
    },

    clearThread() {
        const panel = document.getElementById('cm-thread-panel');
        if (panel) panel.innerHTML = `<div class="cm2-thread-empty">
            <div style="font-size:3rem;margin-bottom:10px">💬</div>
            <p>Select a conversation or post to view</p>
        </div>`;
    },

    // ── utils ─────────────────────────────────────────────────────────────────
    relTime(iso) {
        if (!iso) return '';
        const diff = (Date.now() - new Date(iso).getTime()) / 1000;
        if (diff < 60) return 'Just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
        const d = new Date(iso), now = new Date();
        const opts = d.getFullYear() === now.getFullYear()
            ? { month: 'short', day: 'numeric' }
            : { month: 'short', day: 'numeric', year: 'numeric' };
        return d.toLocaleDateString('en-US', opts);
    },
    avatarColor(name) {
        const colors = ['#4361ee','#7209b7','#e63946','#2ec4b6','#f77f00','#0077b6','#6a4c93','#d62828'];
        let h = 0;
        for (let i = 0; i < (name||'').length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
        return colors[Math.abs(h) % colors.length];
    },
    esc(str) {
        return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
};

window.InboxManager = InboxManager;
document.addEventListener('DOMContentLoaded', () => InboxManager.init());
})();
