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
        if (this.loading) return;
        this.loading = true;
        const list = document.getElementById('cm-list');
        if (list) list.innerHTML = `<div class="cm2-loading"><div class="cm2-spinner"></div> Loading…</div>`;

        // For "all" tab: load messenger + instagram (DMs only)
        const type = this.currentTab === 'all' ? 'all' : this.currentTab;
        const pageId = document.getElementById('cm-page-filter')?.value || '';
        const url = `/api/comments/inbox?type=${type}&pageId=${pageId}`;

        try {
            const data = await window.API.request(url);
            this.items = data.data || [];
            this.renderList();
        } catch (e) {
            if (list) list.innerHTML = `<div class="cm2-empty">⚠️ ${this.esc(e.message)}</div>`;
        } finally {
            this.loading = false;
        }
    },

    // ── Render conversation/post list ─────────────────────────────────────────
    renderList() {
        const list = document.getElementById('cm-list');
        if (!list) return;
        const query = (document.getElementById('cm-search')?.value || '').toLowerCase();
        const filtered = query
            ? this.items.filter(it => (it.name + it.preview + it.source).toLowerCase().includes(query))
            : this.items;

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
            const typeIcon = { messenger:'🔵', instagram:'📸', 'fb-comments':'👍', 'ig-comments':'❤️' }[item.type] || '💬';
            const time = this.relTime(item.time);

            return `<div class="cm2-item${this.currentItem === item ? ' selected' : ''}" data-idx="${idx}" onclick="InboxManager.openItem(${idx})">
                <div class="cm2-avatar" style="background:${item.avatarColor}">${initial}</div>
                <div class="cm2-item-body">
                    <div class="cm2-item-top">
                        <span class="cm2-item-name${item.unread > 0 ? ' unread' : ''}">${this.esc(item.name)}</span>
                        <span class="cm2-item-time">${time}</span>
                    </div>
                    <div class="cm2-item-preview">${this.esc(preview) || '&nbsp;'}</div>
                    <div class="cm2-item-source">${typeIcon} ${this.esc(sourceLabel)}${commentBadge}${unreadDot}</div>
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
            const data = await window.API.request(
                `/api/comments/conversation?type=${item.type}&id=${item.id}&accountId=${item.accountId}`
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
                    body: JSON.stringify({ type: item.type, recipientId: item.recipientId, message: text, accountId: item.accountId })
                });
            } else {
                // Comment reply
                const commentId = this.replyToId || item.id;
                await window.API.request('/api/comments/reply', {
                    method: 'POST',
                    body: JSON.stringify({ type: item.type, commentId, postId: item.id, message: text, accountId: item.accountId })
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
                    opt.textContent = `${page.name} (${page.accountLabel || page.id})`;
                    if (page.id === currentSelected) {
                        opt.selected = true;
                    }
                    pageFilter.appendChild(opt);
                });
            }
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
