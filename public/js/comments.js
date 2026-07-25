// public/js/comments.js
(function () {
    const CommentsManager = {
        currentFilter: 'all',
        currentPost: null,
        feedItems: [],
        loadingFeed: false,
        loadingThread: false,

        init: function () {
            this.bindFilterTabs();
            this.bindRefresh();
        },

        // Called when section becomes visible
        onShow: function () {
            if (this.feedItems.length === 0) this.loadFeed();
        },

        bindFilterTabs: function () {
            document.querySelectorAll('.cm-tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    document.querySelectorAll('.cm-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    this.currentFilter = tab.dataset.filter;
                    this.feedItems = [];
                    this.currentPost = null;
                    this.renderThread(null);
                    this.loadFeed();
                });
            });
        },

        bindRefresh: function () {
            const btn = document.getElementById('cm-refresh');
            if (btn) btn.addEventListener('click', () => {
                this.feedItems = [];
                this.currentPost = null;
                this.renderThread(null);
                this.loadFeed();
            });
        },

        loadFeed: async function () {
            if (this.loadingFeed) return;
            this.loadingFeed = true;
            const list = document.getElementById('cm-post-list');
            list.innerHTML = `<div class="cm-loading"><div class="cm-spinner"></div><span>Loading comments…</span></div>`;
            try {
                const data = await window.API.request(`/api/comments/feed?filter=${this.currentFilter}`);
                this.feedItems = data.data || [];
                this.renderFeed();
            } catch (e) {
                list.innerHTML = `<div class="cm-empty">⚠️ ${e.message}</div>`;
            } finally {
                this.loadingFeed = false;
            }
        },

        renderFeed: function () {
            const list = document.getElementById('cm-post-list');
            if (!this.feedItems.length) {
                list.innerHTML = `<div class="cm-empty">💬 No comments found.<br><small>Make sure your accounts have a Page ID set.</small></div>`;
                return;
            }
            list.innerHTML = this.feedItems.map((item, idx) => {
                const preview = item.message.length > 70 ? item.message.slice(0, 70) + '…' : item.message;
                const pageName = item.page_name.length > 22 ? item.page_name.slice(0, 22) + '…' : item.page_name;
                const commenters = item.latest_comments.slice(0, 2).map(c => c.from?.name?.split(' ')[0] || 'User').join(', ');
                const time = this.relTime(item.latest_activity);
                const typeIcon = item.type === 'ig' ? '📸' : '🔵';
                const thumb = item.picture
                    ? `<img src="${item.picture}" class="cm-post-thumb" onerror="this.style.display='none'">`
                    : `<div class="cm-post-thumb cm-post-thumb-placeholder">${typeIcon}</div>`;
                return `<div class="cm-post-item" data-idx="${idx}" onclick="CommentsManager.selectPost(${idx})">
                    ${thumb}
                    <div class="cm-post-info">
                        <div class="cm-post-title">${this.esc(preview)}</div>
                        <div class="cm-post-meta">
                            <span class="cm-commenter">${this.esc(commenters || 'No comments yet')}</span>
                            <span class="cm-time">${time}</span>
                        </div>
                        <div class="cm-post-page">${typeIcon} ${this.esc(pageName)} · ${item.comment_count} comment${item.comment_count !== 1 ? 's' : ''}</div>
                    </div>
                </div>`;
            }).join('');
        },

        selectPost: async function (idx) {
            // Highlight selected
            document.querySelectorAll('.cm-post-item').forEach((el, i) => {
                el.classList.toggle('selected', i === idx);
            });
            const item = this.feedItems[idx];
            this.currentPost = item;
            this.renderThread(item);
            await this.loadThread(item);
        },

        renderThread: function (item) {
            const panel = document.getElementById('cm-thread-panel');
            if (!item) {
                panel.innerHTML = `<div class="cm-thread-empty">
                    <div style="font-size:3rem;margin-bottom:1rem;">💬</div>
                    <p>Select a post from the left to view its comments</p>
                </div>`;
                return;
            }
            const typeIcon = item.type === 'ig' ? '📸' : '🔵';
            const caption = item.message.length > 120 ? item.message.slice(0, 120) + '…' : item.message;
            panel.innerHTML = `
                <div class="cm-thread-header">
                    ${item.picture ? `<img src="${item.picture}" class="cm-thread-thumb" onerror="this.style.display='none'">` : ''}
                    <div class="cm-thread-post-info">
                        <div class="cm-thread-post-caption">${this.esc(caption)}</div>
                        <div class="cm-thread-post-meta">${typeIcon} ${this.esc(item.page_name)} · ${item.comment_count} comments</div>
                    </div>
                </div>
                <div class="cm-comments-list" id="cm-comments-list">
                    <div class="cm-loading"><div class="cm-spinner"></div><span>Loading thread…</span></div>
                </div>
                <div class="cm-reply-bar" id="cm-reply-bar">
                    <div class="cm-reply-to-label" id="cm-reply-to-label" style="display:none"></div>
                    <div class="cm-reply-input-row">
                        <textarea id="cm-reply-input" class="cm-reply-input" placeholder="Write a comment…" rows="1" 
                            oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"></textarea>
                        <button class="cm-send-btn" onclick="CommentsManager.sendReply()">➤</button>
                    </div>
                </div>`;

            // Enter key to send (Shift+Enter for newline)
            setTimeout(() => {
                const inp = document.getElementById('cm-reply-input');
                if (inp) inp.addEventListener('keydown', e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); CommentsManager.sendReply(); }
                });
            }, 0);
        },

        loadThread: async function (item) {
            if (this.loadingThread) return;
            this.loadingThread = true;
            const list = document.getElementById('cm-comments-list');
            if (!list) return;
            try {
                const data = await window.API.request(`/api/comments/thread?type=${item.type}&postId=${item.id}&accountId=${item.account_id}`);
                const comments = data.data || [];
                this.renderComments(comments, item);
            } catch (e) {
                if (list) list.innerHTML = `<div class="cm-empty">⚠️ ${e.message}</div>`;
            } finally {
                this.loadingThread = false;
            }
        },

        renderComments: function (comments, item) {
            const list = document.getElementById('cm-comments-list');
            if (!list) return;
            if (!comments.length) {
                list.innerHTML = `<div class="cm-empty">No comments yet.</div>`;
                return;
            }
            list.innerHTML = comments.map(c => this.commentHTML(c, item, false)).join('');
            list.scrollTop = list.scrollHeight;
        },

        commentHTML: function (c, item, isReply) {
            const avatar = this.avatarLetter(c.from?.name || '?');
            const time = this.relTime(c.created_time);
            const replies = (c.replies || []).map(r => this.commentHTML(r, item, true)).join('');
            return `<div class="cm-comment ${isReply ? 'cm-reply' : ''}">
                <div class="cm-comment-avatar">${avatar}</div>
                <div class="cm-comment-body">
                    <div class="cm-comment-header">
                        <span class="cm-comment-name">${this.esc(c.from?.name || 'Unknown')}</span>
                        <span class="cm-comment-time">${time}</span>
                        ${c.like_count ? `<span class="cm-comment-likes">👍 ${c.like_count}</span>` : ''}
                    </div>
                    <div class="cm-comment-text">${this.esc(c.message || '')}</div>
                    <div class="cm-comment-actions">
                        <button class="cm-action-btn" onclick="CommentsManager.setReplyTo('${c.id}','${this.esc(c.from?.name || '')}')">↩ Reply</button>
                        ${!isReply && item.type === 'fb' ? `<button class="cm-action-btn" onclick="CommentsManager.likeComment('${c.id}')">👍 Like</button>` : ''}
                        <button class="cm-action-btn cm-del-btn" onclick="CommentsManager.deleteComment('${c.id}')">🗑 Delete</button>
                    </div>
                    ${replies ? `<div class="cm-replies">${replies}</div>` : ''}
                </div>
            </div>`;
        },

        _replyToCommentId: null,

        setReplyTo: function (commentId, name) {
            this._replyToCommentId = commentId;
            const label = document.getElementById('cm-reply-to-label');
            const inp = document.getElementById('cm-reply-input');
            if (label) {
                label.style.display = 'flex';
                label.innerHTML = `<span>↩ Replying to <strong>${this.esc(name)}</strong></span>
                    <button class="cm-cancel-reply" onclick="CommentsManager.clearReplyTo()">✕</button>`;
            }
            if (inp) inp.focus();
        },

        clearReplyTo: function () {
            this._replyToCommentId = null;
            const label = document.getElementById('cm-reply-to-label');
            if (label) label.style.display = 'none';
        },

        sendReply: async function () {
            const inp = document.getElementById('cm-reply-input');
            const message = inp ? inp.value.trim() : '';
            if (!message || !this.currentPost) return;
            const item = this.currentPost;
            const commentId = this._replyToCommentId;

            // Need a comment to reply to — if none selected, this is a top-level comment
            // For FB: reply to a comment; for IG: reply within media
            const btn = document.querySelector('.cm-send-btn');
            if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
            try {
                await window.API.request('/api/comments/reply', {
                    method: 'POST',
                    body: JSON.stringify({
                        type: item.type,
                        commentId: commentId || item.id, // fallback: post id won't work for FB top-level, but graceful
                        postId: item.id,
                        message,
                        accountId: item.account_id
                    })
                });
                inp.value = '';
                inp.style.height = 'auto';
                this.clearReplyTo();
                window.AppController?.showToast('Reply sent! ✅', 'success');
                // Reload thread
                await this.loadThread(item);
            } catch (e) {
                window.AppController?.showToast('Failed: ' + e.message, 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '➤'; }
            }
        },

        likeComment: async function (commentId) {
            if (!this.currentPost) return;
            try {
                await window.API.request('/api/comments/like', {
                    method: 'POST',
                    body: JSON.stringify({ commentId, accountId: this.currentPost.account_id })
                });
                window.AppController?.showToast('Liked! 👍', 'success');
            } catch (e) {
                window.AppController?.showToast('Failed: ' + e.message, 'error');
            }
        },

        deleteComment: async function (commentId) {
            if (!this.currentPost || !confirm('Delete this comment?')) return;
            try {
                await window.API.request(`/api/comments/${commentId}?accountId=${this.currentPost.account_id}`, { method: 'DELETE' });
                window.AppController?.showToast('Comment deleted', 'success');
                await this.loadThread(this.currentPost);
            } catch (e) {
                window.AppController?.showToast('Failed: ' + e.message, 'error');
            }
        },

        // ── utils ────────────────────────────────────────────────────────────
        relTime: function (iso) {
            const diff = (Date.now() - new Date(iso).getTime()) / 1000;
            if (diff < 60) return 'Just now';
            if (diff < 3600) return `${Math.floor(diff / 60)}m`;
            if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
            if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
            return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        },
        avatarLetter: function (name) {
            return (name || '?').charAt(0).toUpperCase();
        },
        esc: function (str) {
            return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }
    };

    window.CommentsManager = CommentsManager;
    document.addEventListener('DOMContentLoaded', () => CommentsManager.init());
})();
