(function() {
    const PublisherModule = {
        preparedVideos: [],

        init: function() {
            this.bindEvents();
            
            if (window.APP && window.APP.accounts && window.APP.accounts.length > 0) {
                this.loadDestinations();
            }

            document.addEventListener('appReady', () => {
                this.loadDestinations();
            });

            // If tab is clicked manually
            document.querySelectorAll('.nav-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    const sec = e.currentTarget.getAttribute('data-section');
                    if (sec === 'section-publisher') {
                        this.loadDestinations();
                    }
                });
            });
        },

        bindEvents: function() {
            // Add Row
            const btnAddRow = document.getElementById('btn-publisher-add-url-row');
            const urlList = document.getElementById('publisher-video-url-list');
            if (btnAddRow && urlList) {
                btnAddRow.addEventListener('click', () => {
                    const row = document.createElement('div');
                    row.className = 'flex gap-2 mb-1 publisher-video-url-row';
                    row.style.cssText = 'display:flex; gap:8px; margin-bottom:8px; align-items:center;';
                    row.innerHTML = `
                        <input type="text" class="form-control publisher-video-url-input" placeholder="Paste link (FB Ads Library, YouTube, Insta, Pinterest…)" style="flex:1;">
                        <button type="button" class="btn btn-secondary btn-sm btn-remove-publisher-url-row" style="padding:4px 8px;">🗑️</button>
                    `;
                    urlList.appendChild(row);

                    row.querySelector('.btn-remove-publisher-url-row').addEventListener('click', () => {
                        row.remove();
                    });
                });
            }

            // Download & Prepare Videos
            const btnDownload = document.getElementById('btn-publisher-media-url-download');
            if (btnDownload && urlList) {
                btnDownload.addEventListener('click', async () => {
                    const inputs = urlList.querySelectorAll('.publisher-video-url-input');
                    const urls = Array.from(inputs).map(inp => inp.value.trim()).filter(Boolean);
                    const canvasSelect = document.getElementById('publisher-media-url-canvas');
                    const canvasType = canvasSelect?.value || 'original';

                    if (!urls.length) {
                        window.AppController.showToast('Please paste at least one video URL.', 'warning');
                        return;
                    }

                    try {
                        btnDownload.disabled = true;
                        btnDownload.textContent = '⏳ Preparing...';
                        window.AppController.showToast(`Downloading and fitting ${urls.length} video(s) to canvas... 📥`, 'info');

                        const promises = urls.map(async (url) => {
                            const result = await window.API.downloadVideoFromUrl(url, canvasType);
                            return result;
                        });

                        const results = await Promise.allSettled(promises);
                        let successCount = 0;
                        const previewContainer = document.getElementById('publisher-media-preview-container');
                        if (previewContainer) {
                            previewContainer.innerHTML = '';
                            previewContainer.style.display = 'none';
                        }

                        results.forEach((res) => {
                            if (res.status === 'fulfilled' && res.value) {
                                const val = res.value;
                                successCount++;
                                this.preparedVideos.push({
                                    filePath: val.filePath,
                                    filename: val.filename
                                });

                                // Render video preview
                                if (previewContainer) {
                                    const videoCard = document.createElement('div');
                                    videoCard.style.cssText = 'position:relative; width:100px;';
                                    videoCard.innerHTML = `
                                        <video src="/uploads/${val.filename}" style="width:100px; height:120px; object-fit:cover; border-radius:6px; border:1px solid var(--glass-border);"></video>
                                        <div style="font-size:0.7rem; color:var(--text-secondary); text-align:center; margin-top:4px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${val.filename}</div>
                                    `;
                                    previewContainer.appendChild(videoCard);
                                    previewContainer.style.display = 'flex';
                                }
                            } else {
                                console.error('Preparing video failed:', res.reason);
                            }
                        });

                        // Clear inputs back to single empty row
                        urlList.innerHTML = `
                            <div class="flex gap-2 mb-1 publisher-video-url-row" style="display:flex; gap:8px; margin-bottom:8px; align-items:center;">
                                <input type="text" class="form-control publisher-video-url-input" placeholder="Paste link (FB Ads Library, YouTube, Insta, Pinterest…)" style="flex:1;">
                                <button type="button" class="btn btn-secondary btn-sm btn-remove-publisher-url-row" style="display:none; padding:4px 8px;">🗑️</button>
                            </div>
                        `;

                        window.AppController.showToast(`Prepared ${successCount} of ${urls.length} video(s) successfully! 📹`, 'success');
                    } catch (err) {
                        window.AppController.showToast('Failed to prepare videos: ' + err.message, 'error');
                    } finally {
                        btnDownload.disabled = false;
                        btnDownload.textContent = '📥 Prepare Videos';
                    }
                });
            }

            // Generate AI Caption
            const btnGenCaption = document.getElementById('btn-publisher-generate-caption');
            const topicInput = document.getElementById('publisher-ai-topic');
            const styleSelect = document.getElementById('publisher-ai-style');
            const captionText = document.getElementById('publisher-caption-text');
            if (btnGenCaption && topicInput && captionText) {
                btnGenCaption.addEventListener('click', async () => {
                    const topic = topicInput.value.trim();
                    const style = styleSelect?.value || 'viral';

                    if (!topic) {
                        window.AppController.showToast('Please enter a product topic or description first.', 'warning');
                        return;
                    }

                    try {
                        btnGenCaption.disabled = true;
                        btnGenCaption.textContent = '⏳ Writing...';
                        window.AppController.showToast('Generating AI caption... 🤖', 'info');

                        const result = await window.API.generatePostCaption(topic, style);
                        captionText.value = result.caption;
                        window.AppController.showToast('AI caption written successfully! ✨', 'success');
                    } catch (err) {
                        window.AppController.showToast('Caption generation failed: ' + err.message, 'error');
                    } finally {
                        btnGenCaption.disabled = false;
                        btnGenCaption.textContent = '🤖 Generate with AI';
                    }
                });
            }

            // Publish Posts
            const btnSubmit = document.getElementById('btn-publisher-submit');
            if (btnSubmit) {
                btnSubmit.addEventListener('click', async () => {
                    const selectedPages = Array.from(document.querySelectorAll('.publisher-fb-page-checkbox:checked')).map(cb => cb.value);
                    const selectedIgs = Array.from(document.querySelectorAll('.publisher-ig-checkbox:checked')).map(cb => cb.value);
                    const caption = captionText?.value.trim() || '';

                    if (!this.preparedVideos.length) {
                        window.AppController.showToast('Please prepare at least one video to publish first.', 'warning');
                        return;
                    }
                    if (!selectedPages.length && !selectedIgs.length) {
                        window.AppController.showToast('Please select at least one Facebook Page or Instagram Account.', 'warning');
                        return;
                    }
                    if (!caption) {
                        window.AppController.showToast('Please write or generate a caption.', 'warning');
                        return;
                    }

                    const statusContainer = document.getElementById('publisher-status-container');
                    const statusText = document.getElementById('publisher-status-text');
                    const statusDetails = document.getElementById('publisher-status-details');

                    try {
                        btnSubmit.disabled = true;
                        if (statusContainer) statusContainer.style.display = 'block';
                        if (statusText) statusText.textContent = 'Publishing to selected destinations...';
                        if (statusDetails) {
                            statusDetails.innerHTML = '';
                            statusDetails.style.display = 'block';
                        }

                        const payload = {
                            pageIds: selectedPages,
                            instagramIds: selectedIgs,
                            videos: this.preparedVideos,
                            caption: caption,
                            thumbnailSource: document.getElementById('publisher-thumbnail-source')?.value || 'first_frame'
                        };

                        const response = await window.API.publishPost(payload);
                        
                        // Output logs
                        if (statusDetails && response.logs) {
                            response.logs.forEach(log => {
                                const div = document.createElement('div');
                                div.style.marginBottom = '4px';
                                if (log.type === 'success') {
                                    div.style.color = '#4caf50';
                                    div.textContent = `✅ ${log.message}`;
                                } else if (log.type === 'error') {
                                    div.style.color = '#f44336';
                                    div.textContent = `❌ ${log.message}`;
                                } else {
                                    div.style.color = '#2196f3';
                                    div.textContent = `ℹ️ ${log.message}`;
                                }
                                statusDetails.appendChild(div);
                            });
                        }

                        // Reset prepared videos list
                        this.preparedVideos = [];
                        const previewContainer = document.getElementById('publisher-media-preview-container');
                        if (previewContainer) {
                            previewContainer.innerHTML = '';
                            previewContainer.style.display = 'none';
                        }

                        window.AppController.showToast('Publishing execution finished!', 'success');
                    } catch (err) {
                        window.AppController.showToast('Publishing failed: ' + err.message, 'error');
                        if (statusDetails) {
                            const errDiv = document.createElement('div');
                            errDiv.style.color = '#f44336';
                            errDiv.textContent = `System Error: ${err.message}`;
                            statusDetails.appendChild(errDiv);
                        }
                    } finally {
                        btnSubmit.disabled = false;
                        if (statusText) statusText.textContent = 'Completed';
                    }
                });
            }
        },

        loadDestinations: async function() {
            const pagesList = document.getElementById('publisher-fb-pages-list');
            const igList = document.getElementById('publisher-ig-accounts-list');

            if (!pagesList || !igList) return;

            try {
                const result = await window.API.request('/api/accounts/pages');
                
                // Clear and render pages
                if (result.pages && result.pages.length) {
                    pagesList.innerHTML = '';
                    igList.innerHTML = '';

                    result.pages.forEach(page => {
                        // Render FB Page checkbox
                        const pageLabel = `${page.name} (${page.accountLabel})`;
                        const pageRow = document.createElement('label');
                        pageRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px; cursor:pointer; font-size:0.9rem;';
                        pageRow.innerHTML = `
                            <input type="checkbox" class="publisher-fb-page-checkbox" value="${page.id}">
                            <span>${pageLabel}</span>
                        `;
                        pagesList.appendChild(pageRow);

                        // Render linked IG checkbox if exists
                        if (page.instagram_business_account) {
                            const ig = page.instagram_business_account;
                            const igLabel = `@${ig.username} (${ig.name || 'Instagram Business'})`;
                            const igRow = document.createElement('label');
                            igRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px; cursor:pointer; font-size:0.9rem;';
                            igRow.innerHTML = `
                                <input type="checkbox" class="publisher-ig-checkbox" value="${ig.id}">
                                <span>${igLabel}</span>
                            `;
                            igList.appendChild(igRow);
                        }
                    });

                    if (!igList.children.length) {
                        igList.innerHTML = '<p style="color:var(--text-secondary); font-size:0.85rem; padding:4px;">No connected Instagram Business accounts found.</p>';
                    }
                } else {
                    pagesList.innerHTML = '<p style="color:var(--text-secondary); font-size:0.85rem; padding:4px;">No Pages found. Connect an account first.</p>';
                    igList.innerHTML = '<p style="color:var(--text-secondary); font-size:0.85rem; padding:4px;">No Instagram Accounts found.</p>';
                }
            } catch (err) {
                console.error("Failed to load publisher destinations:", err);
                pagesList.innerHTML = `<p style="color:#f44336; font-size:0.85rem; padding:4px;">Failed to load: ${err.message}</p>`;
                igList.innerHTML = `<p style="color:#f44336; font-size:0.85rem; padding:4px;">Failed to load: ${err.message}</p>`;
            }
        }
    };

    window.PublisherModule = PublisherModule;
    document.addEventListener('DOMContentLoaded', () => {
        PublisherModule.init();
    });
})();
