// public/js/shopify.js
(function() {
    const ShopifyImporter = {
        scrapedProduct: null,
        userCollections: [],
        floatingVideos: [],
        importedProduct: null,

        // State for video-to-listing flow
        vtlFrames: [],        // [{index, filename, url, selected}]
        vtlVariantAssignments: {}, // {"filename": "VariantValue"}

        init: function() {
            this.bindEvents();
            this.initVideoToListing();
            this.loadStoresSelect();
            document.addEventListener('appReady', () => {
                this.loadStoresSelect();
                this.loadVtlStoresSelect();
            });
        },

        bindEvents: function() {
            const btnScrape = document.getElementById('btn-shopify-scrape');
            const btnImport = document.getElementById('btn-shopify-import-confirm');
            const videoInput = document.getElementById('shopify-import-video-file');
            const btnEnhance = document.getElementById('btn-shopify-ai-enhance');
            const btnRecreate = document.getElementById('btn-shopify-ai-recreate');
            const btnCreateAdConfirm = document.getElementById('btn-shopify-create-ad-confirm');

            if (btnScrape) {
                btnScrape.addEventListener('click', () => this.scrapeProduct());
            }

            if (btnImport) {
                btnImport.addEventListener('click', () => this.importProduct());
            }

            if (videoInput) {
                videoInput.addEventListener('change', (e) => this.handleVideoUpload(e));
            }

            if (btnEnhance) {
                btnEnhance.addEventListener('click', () => this.aiDescription('enhance'));
            }

            if (btnRecreate) {
                btnRecreate.addEventListener('click', () => this.aiDescription('recreate'));
            }

            if (btnCreateAdConfirm) {
                btnCreateAdConfirm.addEventListener('click', () => this.confirmAdCreationOptions());
            }

            // Video URL Paste UI toggling
            const btnUrlToggle = document.getElementById('btn-shopify-import-video-url-toggle');
            const urlContainer = document.getElementById('shopify-import-video-url-container');
            if (btnUrlToggle && urlContainer) {
                btnUrlToggle.addEventListener('click', () => {
                    const isHidden = urlContainer.style.display === 'none';
                    urlContainer.style.display = isHidden ? 'block' : 'none';
                    btnUrlToggle.textContent = isHidden ? '❌ Close Link' : '🔗 Paste Link';
                });
            }

            // Add row button
            const btnAddRow = document.getElementById('btn-shopify-add-url-row');
            const urlListContainer = document.getElementById('shopify-import-video-url-list');
            if (btnAddRow && urlListContainer) {
                btnAddRow.addEventListener('click', () => {
                    const row = document.createElement('div');
                    row.className = 'flex gap-2 mb-1 shopify-video-url-row';
                    row.style.cssText = 'display:flex; gap:8px; margin-bottom:8px; align-items:center;';
                    row.innerHTML = `
                        <input type="text" class="form-control shopify-video-url-input" placeholder="Paste link (FB Ads Library, YouTube, Insta, Pinterest…)" style="flex:1;">
                        <button type="button" class="btn btn-secondary btn-sm btn-remove-url-row" style="padding:4px 8px;">🗑️</button>
                    `;
                    urlListContainer.appendChild(row);

                    // Bind remove row button
                    row.querySelector('.btn-remove-url-row').addEventListener('click', () => {
                        row.remove();
                    });
                });
            }

            // Organic Publish settings toggle in Shopify
            const shopifyPublishToggle = document.getElementById('shopify-organic-publish-toggle');
            const shopifyPublishSettings = document.getElementById('shopify-organic-publish-settings');
            
            if (shopifyPublishToggle && shopifyPublishSettings) {
                shopifyPublishToggle.addEventListener('change', () => {
                    const isChecked = shopifyPublishToggle.checked;
                    shopifyPublishSettings.style.display = isChecked ? 'block' : 'none';
                    if (isChecked) {
                        this.loadPublishDestinations();
                    }
                });
            }

            // Video URL Download
            const btnUrlDownload = document.getElementById('btn-shopify-import-video-url-download');
            if (btnUrlDownload && urlListContainer) {
                btnUrlDownload.addEventListener('click', async () => {
                    const inputs = urlListContainer.querySelectorAll('.shopify-video-url-input');
                    const urls = Array.from(inputs).map(inp => inp.value.trim()).filter(Boolean);

                    if (!urls.length) {
                        window.AppController.showToast('Please paste at least one video URL.', 'warning');
                        return;
                    }

                    try {
                        btnUrlDownload.disabled = true;
                        btnUrlDownload.textContent = '⏳ Downloading...';
                        window.AppController.showToast(`Downloading and cleaning ${urls.length} video(s) in parallel... 📥`, 'info');

                        const promises = urls.map(async (url) => {
                            const result = await window.API.downloadVideoFromUrl(url, 'original');
                            return result;
                        });

                        const results = await Promise.allSettled(promises);
                        let successCount = 0;

                        results.forEach((res) => {
                            if (res.status === 'fulfilled' && res.value) {
                                const val = res.value;
                                successCount++;
                                this.floatingVideos.push({
                                    filePath: val.filePath,
                                    filename: val.filename
                                });

                                // Render preview
                                const previewContainer = document.getElementById('shopify-import-video-preview');
                                if (previewContainer) {
                                    const video = document.createElement('video');
                                    video.src = '/uploads/' + val.filename;
                                    video.controls = true;
                                    video.style.cssText = 'max-height:80px; border-radius:4px; border:1px solid var(--glass-border);';
                                    previewContainer.appendChild(video);
                                    previewContainer.style.display = 'flex';
                                }
                            } else {
                                console.error('Video download failed:', res.reason);
                            }
                        });

                        // Clear inputs back to single empty row
                        urlListContainer.innerHTML = `
                            <div class="flex gap-2 mb-1 shopify-video-url-row" style="display:flex; gap:8px; margin-bottom:8px; align-items:center;">
                                <input type="text" class="form-control shopify-video-url-input" placeholder="Paste link (FB Ads Library, YouTube, Insta, Pinterest…)" style="flex:1;">
                                <button type="button" class="btn btn-secondary btn-sm btn-remove-url-row" style="display:none; padding:4px 8px;">🗑️</button>
                            </div>
                        `;

                        window.AppController.showToast(`Successfully processed ${successCount} of ${urls.length} video(s)! 📹`, 'success');
                    } catch (err) {
                        window.AppController.showToast('Failed to download video: ' + err.message, 'error');
                    } finally {
                        btnUrlDownload.disabled = false;
                        btnUrlDownload.textContent = '📥 Download All';
                    }
                });
            }
        },

        loadStoresSelect: async function() {
            const select = document.getElementById('shopify-target-store-select');
            if (!select) return;
            select.innerHTML = '<option value="">-- Choose Store --</option>';

            try {
                const stores = await window.API.getShopifyStores();
                (stores || []).forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.id;
                    opt.textContent = `${s.name} (${s.shopUrl})`;
                    select.appendChild(opt);
                });
            } catch (err) {
                console.error("Failed to load stores inside select dropdown:", err.message);
            }
        },

        extractVideoFrame: function(file) {
            return new Promise((resolve) => {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.muted = true;
                video.playsInline = true;
                const blobUrl = URL.createObjectURL(file);
                video.src = blobUrl;
                const cleanup = () => URL.revokeObjectURL(blobUrl);
                const capture = () => {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = video.videoWidth || 1280;
                        canvas.height = video.videoHeight || 720;
                        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                        canvas.toBlob(blob => { cleanup(); resolve(blob); }, 'image/jpeg', 0.88);
                    } catch(e) { cleanup(); resolve(null); }
                };
                video.addEventListener('seeked', capture, { once: true });
                video.addEventListener('loadeddata', () => { video.currentTime = Math.min(1, video.duration * 0.05 || 1); }, { once: true });
                video.addEventListener('error', () => { cleanup(); resolve(null); }, { once: true });
                setTimeout(() => { cleanup(); resolve(null); }, 12000);
            });
        },

        handleVideoUpload: async function(e) {
            const files = e.target.files;
            const previewContainer = document.getElementById('shopify-import-video-preview');
            if (!files || !files.length) return;

            try {
                window.AppController.showToast(`Uploading ${files.length} video file(s) to server...`, 'info');
                this.floatingVideos = [];
                if (previewContainer) {
                    previewContainer.innerHTML = '';
                    previewContainer.style.display = 'none';
                }

                const promises = Array.from(files).map(async (file) => {
                    const formData = new FormData();
                    formData.append('file', file);
                    const response = await window.API.uploadMedia(formData);
                    
                    let thumbnailPath = '';
                    let thumbnailFile = '';

                    try {
                        window.AppController.showToast('Extracting video thumbnail...', 'info');
                        const frameBlob = await this.extractVideoFrame(file);
                        if (frameBlob) {
                            const thumbName = file.name.replace(/\.[^/.]+$/, '_thumb.jpg');
                            const thumbForm = new FormData();
                            thumbForm.append('file', new File([frameBlob], thumbName, { type: 'image/jpeg' }));
                            const thumbResp = await window.API.uploadMedia(thumbForm);
                            thumbnailPath = thumbResp.filePath || thumbResp.filename;
                            thumbnailFile = thumbResp.filename || thumbName;
                        }
                    } catch(e) {
                        console.log('Shopify video thumbnail extraction skipped:', e.message);
                    }

                    return {
                        filePath: response.filePath,
                        filename: response.filename,
                        thumbnail: thumbnailPath,
                        thumbnailFile: thumbnailFile
                    };
                });

                const results = await Promise.allSettled(promises);
                const successful = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
                
                this.floatingVideos = successful;

                if (previewContainer && this.floatingVideos.length > 0) {
                    this.floatingVideos.forEach(vid => {
                        const video = document.createElement('video');
                        video.src = '/uploads/' + vid.filename;
                        video.controls = true;
                        video.style.cssText = 'max-height:80px; border-radius:4px; border:1px solid var(--glass-border);';
                        previewContainer.appendChild(video);
                    });
                    previewContainer.style.display = 'flex';
                }
                window.AppController.showToast(`${this.floatingVideos.length} video(s) uploaded successfully with thumbnail extracted! 📹`, 'success');
            } catch (err) {
                window.AppController.showToast('Videos upload failed: ' + err.message, 'error');
            }
        },

        aiDescription: async function(action) {
            const descInput = document.getElementById('shopify-import-description');
            const titleInput = document.getElementById('shopify-import-title');
            const btnAI = document.getElementById(action === 'enhance' ? 'btn-shopify-ai-enhance' : 'btn-shopify-ai-recreate');
            if (!descInput || !btnAI) return;
            const originalText = descInput.value;
            const productTitle = titleInput?.value || '';

            if (!originalText) {
                window.AppController.showToast('Description is empty.', 'warning');
                return;
            }

            try {
                btnAI.disabled = true;
                btnAI.textContent = '⏳ Processing...';
                window.AppController.showToast(action === 'enhance' ? 'Enhancing description HTML with AI...' : 'Recreating description HTML with AI...', 'info');

                const response = await fetch('/api/shopify/ai-description', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action, description: originalText, productTitle })
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'AI request failed');

                descInput.value = data.description;
                window.AppController.showToast('Description updated successfully! ✨', 'success');
            } catch (err) {
                window.AppController.showToast(err.message, 'error');
            } finally {
                btnAI.disabled = false;
                btnAI.textContent = action === 'enhance' ? '🤖 AI Enhance' : '🪄 AI Recreate';
            }
        },

        scrapeProduct: async function() {
            const urlInput = document.getElementById('shopify-scrape-url');
            const storeSelect = document.getElementById('shopify-target-store-select');
            const btnScrape = document.getElementById('btn-shopify-scrape');
            const previewContainer = document.getElementById('shopify-preview-container');

            if (!urlInput || !storeSelect || !btnScrape || !previewContainer) return;

            const url = urlInput.value.trim();
            const storeId = storeSelect.value;

            if (!url || !storeId) {
                window.AppController.showToast('Please enter a Product URL and select a Store.', 'warning');
                return;
            }

            try {
                btnScrape.disabled = true;
                btnScrape.textContent = '🔍 Inspecting Listing...';
                previewContainer.style.display = 'none';

                this.floatingVideos = [];
                const videoInput = document.getElementById('shopify-import-video-file');
                if (videoInput) videoInput.value = '';
                const videoPreview = document.getElementById('shopify-import-video-preview');
                if (videoPreview) videoPreview.style.display = 'none';

                window.AppController.showToast('Fetching Shopify product metadata and analyzing with Gemini AI... 🤖', 'info');
                
                const data = await window.API.scrapeShopifyProduct(url, storeId);
                
                this.scrapedProduct = data.product;
                this.userCollections = data.userCollections || [];
                const suggestedIds = data.suggestedCollectionIds || [];

                // Fill preview fields
                document.getElementById('shopify-import-title').value = this.scrapedProduct.title || '';
                document.getElementById('shopify-import-sku-prefix').value = '';
                document.getElementById('shopify-import-price').value = '';
                document.getElementById('shopify-import-compare-price').value = '';
                document.getElementById('shopify-import-description').value = this.scrapedProduct.description || '';

                // Render Collections checklist
                const collectionsContainer = document.getElementById('shopify-import-collections-checklist');
                collectionsContainer.innerHTML = '';
                
                if (this.userCollections.length === 0) {
                    collectionsContainer.innerHTML = '<span style="color:var(--text-secondary); font-size:0.85rem;">No collections found on this store.</span>';
                } else {
                    this.userCollections.forEach(c => {
                        const isSuggested = suggestedIds.includes(String(c.id)) || suggestedIds.includes(Number(c.id));
                        const label = document.createElement('label');
                        label.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:0.85rem; color:white; cursor:pointer;';
                        label.innerHTML = `
                            <input type="checkbox" class="shopify-collection-checkbox" value="${c.id}" ${isSuggested ? 'checked' : ''}>
                            <span>${this.escapeHtml(c.title)} ${isSuggested ? '<span style="color:var(--accent-cyan); font-size:0.75rem;">✨ AI Match</span>' : ''}</span>
                        `;
                        collectionsContainer.appendChild(label);
                    });
                }

                // Render Variants Pricing Grid if multiple variants exist AND they have different prices
                const variantsContainer = document.getElementById('shopify-import-variants-container');
                const variantsTbody = document.getElementById('shopify-import-variants-tbody');
                const variants = this.scrapedProduct.variants || [];

                const uniquePrices = new Set(variants.map(v => v.price));
                const uniqueComparePrices = new Set(variants.map(v => v.compare_at_price));
                const hasPriceVariations = uniquePrices.size > 1 || uniqueComparePrices.size > 1;

                if (variants.length > 1 && hasPriceVariations) {
                    variantsContainer.style.display = 'block';
                    variantsTbody.innerHTML = '';
                    variants.forEach((v, idx) => {
                        const tr = document.createElement('tr');
                        tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
                        
                        const title = v.title || [v.option1, v.option2, v.option3].filter(Boolean).join(' / ');
                        const originalPrice = (v.price / 100).toFixed(2);
                        const originalCompare = v.compare_at_price ? (v.compare_at_price / 100).toFixed(2) : '';

                        tr.innerHTML = `
                            <td style="padding:6px; font-weight:600;">${this.escapeHtml(title)}</td>
                            <td style="padding:6px;">
                                <input type="number" step="0.01" class="form-control shopify-variant-price-input" 
                                    data-index="${idx}" value="${originalPrice}" style="padding:4px 8px; font-size:0.8rem; background:rgba(0,0,0,0.3); border-color:var(--glass-border); width:100px;">
                            </td>
                            <td style="padding:6px;">
                                <input type="number" step="0.01" class="form-control shopify-variant-compare-input" 
                                    data-index="${idx}" value="${originalCompare}" style="padding:4px 8px; font-size:0.8rem; background:rgba(0,0,0,0.3); border-color:var(--glass-border); width:100px;">
                            </td>
                            <td style="padding:6px; color:var(--text-secondary); font-size:0.8rem;" class="shopify-variant-sku-preview" data-index="${idx}">
                                (prefix)-${(v.option1 || '').replace(/[^a-zA-Z0-9]/g, '')}
                            </td>
                        `;
                        variantsTbody.appendChild(tr);
                    });

                    const prefixInput = document.getElementById('shopify-import-sku-prefix');
                    const updateSkuPreviews = () => {
                        const prefix = prefixInput.value.trim() || '(prefix)';
                        document.querySelectorAll('.shopify-variant-sku-preview').forEach(el => {
                            const idx = parseInt(el.getAttribute('data-index'));
                            const v = variants[idx];
                            const opt1 = v.option1 ? v.option1.replace(/[^a-zA-Z0-9]/g, '').trim() : '';
                            const opt2 = v.option2 ? '-' + v.option2.replace(/[^a-zA-Z0-9]/g, '').trim() : '';
                            const opt3 = v.option3 ? '-' + v.option3.replace(/[^a-zA-Z0-9]/g, '').trim() : '';
                            el.textContent = `${prefix}-${opt1}${opt2}${opt3}`.replace(/-+/g, '-').replace(/-$/, '');
                        });
                    };
                    prefixInput.addEventListener('input', updateSkuPreviews);
                    updateSkuPreviews();
                } else {
                    variantsContainer.style.display = 'none';
                }

                // Render Images Grid
                const imagesContainer = document.getElementById('shopify-import-images-grid');
                imagesContainer.innerHTML = '';
                const images = this.scrapedProduct.images || [];
                
                if (images.length === 0) {
                    imagesContainer.innerHTML = '<span style="color:var(--text-secondary); font-size:0.85rem;">No images found for this product.</span>';
                } else {
                    images.forEach(imgUrl => {
                        const src = imgUrl.startsWith('//') ? 'https:' + imgUrl : imgUrl;
                        const div = document.createElement('div');
                        div.style.cssText = 'width:80px; height:80px; flex-shrink:0; border:1px solid var(--glass-border); border-radius:6px; overflow:hidden; background:rgba(0,0,0,0.2);';
                        div.innerHTML = `<img src="${src}" style="width:100%; height:100%; object-fit:cover;">`;
                        imagesContainer.appendChild(div);
                    });
                }

                previewContainer.style.display = 'block';
                window.AppController.showToast('Product data retrieved and matched successfully! 🛍️', 'success');
            } catch (err) {
                window.AppController.showToast('Failed to scrape product details: ' + err.message, 'error');
            } finally {
                btnScrape.disabled = false;
                btnScrape.textContent = '🔍 Inspect Product Details';
            }
        },

        importProduct: async function() {
            const storeSelect = document.getElementById('shopify-target-store-select');
            const prefixInput = document.getElementById('shopify-import-sku-prefix');
            const titleInput = document.getElementById('shopify-import-title');
            const priceInput = document.getElementById('shopify-import-price');
            const comparePriceInput = document.getElementById('shopify-import-compare-price');
            const descInput = document.getElementById('shopify-import-description');
            const btnImport = document.getElementById('btn-shopify-import-confirm');

            if (!storeSelect || !prefixInput || !titleInput || !btnImport || !this.scrapedProduct) return;

            const storeId = storeSelect.value;
            const skuPrefix = prefixInput.value.trim();
            const title = titleInput.value.trim();
            const price = priceInput.value.trim();
            const comparePrice = comparePriceInput.value.trim();
            const description = descInput.value;

            if (!skuPrefix) {
                window.AppController.showToast('Please enter a Base SKU Prefix (e.g. MBD).', 'warning');
                prefixInput.focus();
                return;
            }

            if (!title) {
                window.AppController.showToast('Product title cannot be empty.', 'warning');
                return;
            }

            // Organic Publish Validation
            const organicChecked = document.getElementById('shopify-organic-publish-toggle')?.checked;
            const selectedPages = Array.from(document.querySelectorAll('.shopify-publish-page-checkbox:checked')).map(cb => cb.value);
            const selectedIgs = Array.from(document.querySelectorAll('.shopify-publish-ig-checkbox:checked')).map(cb => cb.value);

            if (organicChecked) {
                if (!selectedPages.length && !selectedIgs.length) {
                    window.AppController.showToast('Please select at least one organic page or Instagram destination.', 'warning');
                    return;
                }
                if (!this.floatingVideos.length) {
                    window.AppController.showToast('Please prepare at least one video (download or upload) to publish organically.', 'warning');
                    return;
                }
            }

            // Collect selected collections
            const checkedBoxes = document.querySelectorAll('.shopify-collection-checkbox:checked');
            const collectionIds = Array.from(checkedBoxes).map(cb => cb.value);

            // Collect custom variant prices/compare prices from variants grid
            if (this.scrapedProduct.variants && this.scrapedProduct.variants.length > 1) {
                document.querySelectorAll('.shopify-variant-price-input').forEach(el => {
                    const idx = parseInt(el.getAttribute('data-index'));
                    const val = el.value.trim();
                    if (val) this.scrapedProduct.variants[idx].price = val;
                });
                document.querySelectorAll('.shopify-variant-compare-input').forEach(el => {
                    const idx = parseInt(el.getAttribute('data-index'));
                    const val = el.value.trim();
                    this.scrapedProduct.variants[idx].compare_at_price = val || null;
                });
            }

            // Copy modifications back to scrapedProduct payload
            const productPayload = {
                ...this.scrapedProduct,
                title,
                description
            };

            try {
                btnImport.disabled = true;
                btnImport.textContent = '🚀 Auto-Importing Listings...';
                window.AppController.showToast('Uploading images and generating variants on Shopify... 🛍️', 'info');

                const result = await window.API.importShopifyProduct({
                    storeId,
                    product: productPayload,
                    skuPrefix,
                    price: price || null,
                    comparePrice: comparePrice || null,
                    collectionIds,
                    floatingVideos: this.floatingVideos
                });

                window.AppController.showToast(`Successfully imported: "${result.title}" to Shopify! 🎉`, 'success');

                // Perform Organic Publishing if checked
                if (organicChecked) {
                    try {
                        window.AppController.showToast('Generating AI caption and publishing organically... 📢', 'info');
                        const style = document.getElementById('shopify-publish-ai-style')?.value || 'viral';
                        
                        // Use the product title/details for post topic
                        const captionResult = await window.API.generatePostCaption(title, style);
                        const caption = captionResult.caption;

                        await window.API.publishPost({
                            pageIds: selectedPages,
                            instagramIds: selectedIgs,
                            videos: this.floatingVideos,
                            caption: caption
                        });
                        window.AppController.showToast('Organic post/reel published successfully! 📢', 'success');
                    } catch (pubErr) {
                        console.error("Organic publishing failed during Shopify import:", pubErr);
                        window.AppController.showToast('Product imported, but organic post publish failed: ' + pubErr.message, 'warning');
                    }
                }
                
                // Store imported details for later ad creation
                ShopifyImporter.importedProduct = {
                    title: result.title,
                    productUrl: result.productUrl,
                    videoPath: this.floatingVideos[0]?.filePath || null,
                    videoFilename: this.floatingVideos[0]?.filename || null,
                    thumbnail: this.floatingVideos[0]?.thumbnail || null,
                    thumbnailFile: this.floatingVideos[0]?.thumbnailFile || null
                };

                // Hide preview and clear URL
                document.getElementById('shopify-preview-container').style.display = 'none';
                document.getElementById('shopify-scrape-url').value = '';
                this.scrapedProduct = null;

                // Show custom result modal
                const modalTitle = document.getElementById('modal-result-title');
                const modalBody = document.getElementById('modal-result-body');
                if (modalTitle && modalBody) {
                    modalTitle.textContent = 'Import Successful! 🎉';
                    modalBody.innerHTML = `
                        <p style="margin-bottom:1.5rem; color:var(--text-secondary); font-size:0.9rem;">
                            Product <strong>"${this.escapeHtml(result.title)}"</strong> has been successfully imported into your Shopify store.
                        </p>
                        <div class="flex flex-column gap-2" style="display:flex; flex-direction:column; gap:10px;">
                            <a href="${result.productUrl}" target="_blank" class="btn btn-secondary" style="text-align:center; display:block; text-decoration:none;">
                                🌐 View Product on Store
                            </a>
                            <button id="btn-modal-open-ad-options" class="btn btn-primary" style="width:100%;">
                                ➕ Create Facebook Ad for this Product
                            </button>
                        </div>
                    `;
                    
                    window.AppController.openModal('modal-result');

                    const btnOpenAdOptions = document.getElementById('btn-modal-open-ad-options');
                    if (btnOpenAdOptions) {
                        btnOpenAdOptions.addEventListener('click', () => {
                            window.AppController.closeModal('modal-result');
                            this.openAdCreationOptionsModal();
                        });
                    }
                }
            } catch (err) {
                window.AppController.showToast('Import failed: ' + err.message, 'error');
            } finally {
                btnImport.disabled = false;
                btnImport.textContent = '🚀 Start Auto-Import Listing';
            }
        },

        openAdCreationOptionsModal: async function() {
            const modal = document.getElementById('modal-create-ad-options');
            const accountSelect = document.getElementById('shopify-ad-account-select');
            const pixelSelect = document.getElementById('shopify-ad-pixel-select');
            const pageSelect = document.getElementById('shopify-ad-page-select');
            const igSelect = document.getElementById('shopify-ad-instagram-select');
            const nameInput = document.getElementById('shopify-ad-campaign-name');

            if (!modal || !accountSelect || !pixelSelect || !pageSelect || !igSelect || !nameInput || !this.importedProduct) return;

            // Generate initial campaign name
            const shortName = this.extractShortProductName(this.importedProduct.title);
            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            const dateStr = `${pad(now.getDate())}-${pad(now.getMonth()+1)}-${now.getFullYear()}`;
            const personName = localStorage.getItem('last_person_name') || 'User';
            
            const getBudgetType = () => document.getElementById('shopify-ad-budget-cbo').checked ? 'CBO' : 'ABO';
            const skuPrefix = document.getElementById('shopify-import-sku-prefix')?.value?.trim() || 'GTS';

            const updateCampaignName = () => {
                nameInput.value = `${shortName} (${skuPrefix} ${dateStr}-${personName}) ${getBudgetType()}`;
            };

            // Set default name
            updateCampaignName();

            // Bind budget change listeners to update suffix in name
            document.getElementById('shopify-ad-budget-cbo').addEventListener('change', updateCampaignName);
            document.getElementById('shopify-ad-budget-abo').addEventListener('change', updateCampaignName);

            // Populate Ad Accounts
            accountSelect.innerHTML = '<option value="">-- Loading Accounts --</option>';
            pixelSelect.innerHTML = '<option value="">-- Select Pixel --</option>';
            pageSelect.innerHTML = '<option value="">-- Select Page --</option>';
            igSelect.innerHTML = '<option value="">No Instagram linked</option>';

            try {
                const accounts = await window.API.getAccounts();
                accountSelect.innerHTML = '<option value="">-- Choose Account --</option>';
                
                (accounts || []).forEach(acc => {
                    const opt = document.createElement('option');
                    opt.value = acc.id;
                    opt.textContent = `${acc.label || acc.name || 'Account'} (act_${acc.accountId})`;
                    accountSelect.appendChild(opt);
                });

                // Set saved default account if exists
                const savedDefault = localStorage.getItem('active_facebook_ad_account_id');
                if (savedDefault && accounts.some(a => a.id === savedDefault)) {
                    accountSelect.value = savedDefault;
                    this.loadAdAccountDetails(savedDefault);
                }

                accountSelect.addEventListener('change', (e) => {
                    this.loadAdAccountDetails(e.target.value);
                });

            } catch (err) {
                window.AppController.showToast('Failed to load ad accounts: ' + err.message, 'error');
            }

            window.AppController.openModal('modal-create-ad-options');
        },

        loadAdAccountDetails: async function(accountId) {
            const pixelSelect = document.getElementById('shopify-ad-pixel-select');
            const pageSelect = document.getElementById('shopify-ad-page-select');
            const igSelect = document.getElementById('shopify-ad-instagram-select');

            if (!pixelSelect || !pageSelect || !igSelect) return;

            if (!accountId) {
                pixelSelect.innerHTML = '<option value="">-- Select Pixel --</option>';
                pageSelect.innerHTML = '<option value="">-- Select Page --</option>';
                igSelect.innerHTML = '<option value="">No Instagram linked</option>';
                return;
            }

            pixelSelect.innerHTML = '<option value="">Loading pixels...</option>';
            pageSelect.innerHTML = '<option value="">Loading pages...</option>';
            igSelect.innerHTML = '<option value="">Loading...</option>';

            try {
                // Find account details from the stored accounts list
                const accounts = await window.API.getAccounts();
                const currentAcc = accounts.find(a => a.id === accountId);
                if (!currentAcc) throw new Error('Stored account details not found.');

                // Facebook API expects raw accountId (e.g. 658299073494340)
                const rawAccountId = currentAcc.accountId || currentAcc.id;

                // Get pixels
                const pixelsData = await window.API.getPixels(rawAccountId);
                const pixels = pixelsData.data || [];
                pixelSelect.innerHTML = '<option value="">-- Select Pixel --</option>';
                pixels.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = `${p.name} (${p.id})`;
                    pixelSelect.appendChild(opt);
                });

                // Get all pages and filter to this account
                const pagesData = await window.API.getAllPages();
                const pages = pagesData.pages || [];
                
                pageSelect.innerHTML = '<option value="">-- Select Page --</option>';
                igSelect.innerHTML = '<option value="">No Instagram linked</option>';

                const currentAccId = currentAcc.accountId || '';

                pages.forEach(page => {
                    const pageBelongs = !page.accountIds || page.accountIds.includes(accountId) || page.accountId === accountId || page.accountIds.includes(currentAccId);
                    
                    if (pageBelongs) {
                        const opt = document.createElement('option');
                        opt.value = page.id;
                        opt.textContent = page.name || page.id;
                        pageSelect.appendChild(opt);

                        if (page.instagram_business_account) {
                            const ig = page.instagram_business_account;
                            const o = document.createElement('option');
                            o.value = ig.id;
                            o.textContent = `@${ig.username || ig.name || ig.id}`;
                            igSelect.appendChild(o);
                        }
                    }
                });

                // Auto-select page if account has a default pageId
                if (currentAcc.pageId) {
                    pageSelect.value = currentAcc.pageId;
                }
                
                // Auto-select Instagram if account has a default instagramAccountId
                if (currentAcc.instagramAccountId) {
                    igSelect.value = currentAcc.instagramAccountId;
                }

            } catch (err) {
                console.error("Failed to load details for ad account:", err.message);
                pixelSelect.innerHTML = '<option value="">Error loading pixels</option>';
                pageSelect.innerHTML = '<option value="">Error loading pages</option>';
            }
        },

        confirmAdCreationOptions: function() {
            const campaignName = document.getElementById('shopify-ad-campaign-name')?.value?.trim();
            const budgetType = document.getElementById('shopify-ad-budget-cbo').checked ? 'CBO' : 'ABO';
            const accountId = document.getElementById('shopify-ad-account-select')?.value;
            const pixelId = document.getElementById('shopify-ad-pixel-select')?.value;
            const pageId = document.getElementById('shopify-ad-page-select')?.value;
            const instagramId = document.getElementById('shopify-ad-instagram-select')?.value || '';

            if (!campaignName || !accountId || !pixelId || !pageId) {
                window.AppController.showToast('Please fill out all required fields.', 'warning');
                return;
            }

            // Close modal
            window.AppController.closeModal('modal-create-ad-options');

            // Select Ad Account in DOM of campaign wizard
            const DOMAccountSelect = document.getElementById('campaign-account-select');
            if (DOMAccountSelect) {
                DOMAccountSelect.value = accountId;
                DOMAccountSelect.dispatchEvent(new Event('change'));
            }

            // Delay page and pixel selection slightly to let accounts finish loading
            setTimeout(() => {
                const DOMPixelSelect = document.getElementById('pixel-select');
                if (DOMPixelSelect) DOMPixelSelect.value = pixelId;

                const DOMPageSelect = document.getElementById('ad-page');
                if (DOMPageSelect) DOMPageSelect.value = pageId;

                const DOMIgSelect = document.getElementById('ad-instagram');
                if (DOMIgSelect) DOMIgSelect.value = instagramId;
            }, 800);

            // Pre-populate Campaign Wizard and inject the floating video directly
            let prefilledMedia = null;
            if (this.importedProduct.videoPath) {
                prefilledMedia = {
                    media: this.importedProduct.videoPath,
                    mediaFile: this.importedProduct.videoFilename,
                    previewUrl: '/uploads/' + this.importedProduct.videoFilename,
                    thumbnail: this.importedProduct.thumbnail || '',
                    thumbnailFile: this.importedProduct.thumbnailFile || '',
                    thumbnailPreviewUrl: this.importedProduct.thumbnail ? '/uploads/' + this.importedProduct.thumbnailFile : ''
                };
            }

            window.CampaignWizard.startCampaignWizardWithData(campaignName, this.importedProduct.productUrl, this.importedProduct.title, prefilledMedia);

            // Navigate to Create Campaign tab
            const navItem = document.querySelector('.nav-item[data-section="section-campaign"]');
            if (navItem) navItem.click();

            window.AppController.showToast('Campaign pre-populated and video attached automatically! 🚀', 'success');
        },

        extractShortProductName: function(title) {
            if (!title) return 'Product';
            
            let clean = title.replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDC00-\uDFFF]/g, '');
            clean = clean.replace(/[^a-zA-Z0-9\s]/g, ' ');
            
            const promoWords = [
                'limited-time', 'limited time', 'sale', 'off', 'subsidy', 'discount', 'free shipping', 'shipping', 'new', 
                'hot', 'deal', 'promo', 'exclusive', 'special', 'best', 'quality', 'price', 'low', 'cheap', 'click', 
                'buy', 'shop', 'order', 'gift', 'coupon', 'code', 'save', 'saving', 'percent', 'percentage', 'original',
                'luxury', 'premium', 'trending', 'viral', 'top', 'rated', 'review', 'guarantee', 'warranty', 'ship',
                'subsidies', 'limited', 'time', 'heat', 'summer', 'rechargeable', 'led', 'glasses', 'solar', 'fan',
                'with', 'and', 'the', 'for'
            ];
            
            let words = clean.split(/\s+/).filter(Boolean);
            let filtered = words.filter(w => {
                const lower = w.toLowerCase();
                return !promoWords.includes(lower) && !/^\d+%?$/.test(w) && lower.length > 2;
            });
            
            if (filtered.length === 0) filtered = words;
            
            return filtered.slice(0, 3).join(' ');
        },

        loadPublishDestinations: async function() {
            const destList = document.getElementById('shopify-publish-destinations');
            if (!destList) return;

            destList.innerHTML = '<p style="color:var(--text-secondary); font-size:0.85rem; padding:4px;">Loading...</p>';

            try {
                const result = await window.API.request('/api/accounts/pages');
                if (result.pages && result.pages.length) {
                    destList.innerHTML = '';
                    result.pages.forEach(page => {
                        // Render FB Page checkbox
                        const pageLabel = `${page.name} (${page.accountLabel || 'FB'})`;
                        const pageRow = document.createElement('label');
                        pageRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px; cursor:pointer; font-size:0.9rem;';
                        pageRow.innerHTML = `
                            <input type="checkbox" class="shopify-publish-page-checkbox" value="${page.id}">
                            <span>${pageLabel}</span>
                        `;
                        destList.appendChild(pageRow);

                        // Render linked IG checkbox if exists
                        if (page.instagram_business_account) {
                            const ig = page.instagram_business_account;
                            const igLabel = `@${ig.username} (IG via ${page.name})`;
                            const igRow = document.createElement('label');
                            igRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px; cursor:pointer; font-size:0.9rem;';
                            igRow.innerHTML = `
                                <input type="checkbox" class="shopify-publish-ig-checkbox" value="${ig.id}">
                                <span>${igLabel}</span>
                            `;
                            destList.appendChild(igRow);
                        }
                    });
                } else {
                    destList.innerHTML = '<p style="color:var(--text-secondary); font-size:0.85rem; padding:4px;">No Pages found. Connect an account first.</p>';
                }
            } catch (err) {
                console.error("Failed to load shopify destinations:", err);
                destList.innerHTML = `<p style="color:#f44336; font-size:0.85rem; padding:4px;">Failed to load: ${err.message}</p>`;
            }
        },

        // ── Video → AI Listing ────────────────────────────────────────────────

        // Pending analysis result (used to pass data into popup confirm)
        vtlPendingAnalysis: null,

        initVideoToListing: function() {
            const btnGenerate = document.getElementById('btn-vtl-generate');
            const fileInput   = document.getElementById('vtl-video-input');

            if (btnGenerate) btnGenerate.addEventListener('click', () => this.vtlGenerate());

            // File preview when files are selected
            if (fileInput) {
                fileInput.addEventListener('change', () => this.vtlRenderFilePreviews(fileInput));
            }

            // Variant popup: add option button
            const btnPopupAddOpt = document.getElementById('btn-vtl-popup-add-option');
            if (btnPopupAddOpt) btnPopupAddOpt.addEventListener('click', () => this.vtlPopupAddOptionRow());

            // Variant popup: confirm button
            const btnPopupConfirm = document.getElementById('btn-vtl-popup-confirm');
            if (btnPopupConfirm) btnPopupConfirm.addEventListener('click', () => this.vtlPopupConfirm());

            // Variant popup: no-variants checkbox
            const noVariantsCb = document.getElementById('vtl-popup-no-variants');
            if (noVariantsCb) {
                noVariantsCb.addEventListener('change', () => {
                    const optList = document.getElementById('vtl-popup-options-list');
                    const addBtn  = document.getElementById('btn-vtl-popup-add-option');
                    if (optList) optList.style.opacity = noVariantsCb.checked ? '0.35' : '1';
                    if (optList) optList.style.pointerEvents = noVariantsCb.checked ? 'none' : 'auto';
                    if (addBtn) addBtn.style.display = noVariantsCb.checked ? 'none' : 'inline-block';
                });
            }

            // Load stores into VTL store select
            this.loadVtlStoresSelect();
        },

        // Load stores into the VTL-specific store dropdown
        loadVtlStoresSelect: async function() {
            const select = document.getElementById('vtl-store-select');
            if (!select) return;
            select.innerHTML = '<option value="">-- Choose Store --</option>';
            try {
                const stores = await window.API.getShopifyStores();
                (stores || []).forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.id;
                    opt.textContent = `${s.name} (${s.shopUrl})`;
                    select.appendChild(opt);
                });
                // If only one store, auto-select it
                if (stores && stores.length === 1) select.value = stores[0].id;
            } catch (err) {
                console.error('Failed to load VTL stores:', err.message);
            }
        },

        // Show thumbnail/name previews for selected files
        vtlRenderFilePreviews: function(fileInput) {
            const previewDiv = document.getElementById('vtl-file-preview');
            if (!previewDiv || !fileInput.files) return;
            previewDiv.innerHTML = '';
            if (!fileInput.files.length) { previewDiv.style.display = 'none'; return; }

            Array.from(fileInput.files).forEach(file => {
                const item = document.createElement('div');
                item.style.cssText = 'display:flex; align-items:center; gap:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:6px; padding:4px 8px; font-size:0.78rem; color:var(--text-secondary);';

                const isVideo = file.type.startsWith('video/');
                const icon = isVideo ? '🎬' : '🖼️';
                const sizeMB = (file.size / 1024 / 1024).toFixed(1);
                item.textContent = `${icon} ${file.name} (${sizeMB}MB)`;
                previewDiv.appendChild(item);
            });
            previewDiv.style.display = 'flex';
        },

        // Add a variant option row to the dynamic list
        vtlAddOptionRow: function(isFirst) {
            const list = document.getElementById('vtl-options-list');
            if (!list) return;
            // Don't double-add the first row
            if (isFirst && list.children.length > 0) return;
            const idx = list.children.length;
            const row = document.createElement('div');
            row.className = 'vtl-option-row';
            row.style.cssText = 'display:grid; grid-template-columns:1fr 2fr auto; gap:8px; align-items:center;';
            row.innerHTML = `
                <input type="text" class="form-control vtl-opt-name" placeholder="${idx === 0 ? 'Color' : 'Size'}" style="font-size:0.88rem;">
                <input type="text" class="form-control vtl-opt-values" placeholder="${idx === 0 ? 'Red, Blue, Green' : 'S, M, L, XL'}" style="font-size:0.88rem;">
                <button type="button" class="btn btn-secondary btn-xs vtl-remove-option" style="padding:4px 8px;" title="Remove">🗑️</button>
            `;
            row.querySelector('.vtl-remove-option').addEventListener('click', () => {
                row.remove();
                // Clear assignments since options changed
                this.vtlVariantAssignments = {};
                const asgn = document.getElementById('vtl-variant-assignments');
                if (asgn) { asgn.style.display = 'none'; asgn.innerHTML = ''; }
            });
            // Changing values clears assignments
            row.querySelectorAll('input').forEach(inp => {
                inp.addEventListener('input', () => {
                    this.vtlVariantAssignments = {};
                    const asgn = document.getElementById('vtl-variant-assignments');
                    if (asgn) { asgn.style.display = 'none'; asgn.innerHTML = ''; }
                });
            });
            list.appendChild(row);
        },

        // Read all option rows → [{name, values[]}]
        vtlGetOptions: function() {
            const rows = document.querySelectorAll('#vtl-options-list .vtl-option-row');
            const options = [];
            rows.forEach(row => {
                const name = row.querySelector('.vtl-opt-name')?.value.trim();
                const valuesRaw = row.querySelector('.vtl-opt-values')?.value.trim();
                if (name && valuesRaw) {
                    const values = valuesRaw.split(',').map(v => v.trim()).filter(Boolean);
                    if (values.length) options.push({ name, values });
                }
            });
            return options;
        },

        vtlGenerate: async function() {
            const fileInput   = document.getElementById('vtl-video-input');
            const btnGen      = document.getElementById('btn-vtl-generate');
            const processing  = document.getElementById('vtl-processing');
            const procMsg     = document.getElementById('vtl-processing-msg');
            const storeSelect = document.getElementById('vtl-store-select');

            if (!storeSelect?.value) {
                window.AppController.showToast('Please select a Shopify store first.', 'warning');
                storeSelect?.focus();
                return;
            }

            if (!fileInput?.files?.length) {
                window.AppController.showToast('Please select at least one video or image file first.', 'warning');
                return;
            }

            const files = Array.from(fileInput.files);
            const videoCount = files.filter(f => f.type.startsWith('video/')).length;
            const imageCount = files.filter(f => f.type.startsWith('image/')).length;

            try {
                btnGen.disabled = true;
                results.style.display = 'none';
                processing.style.display = 'block';

                const parts = [];
                if (videoCount) parts.push(`${videoCount} video${videoCount > 1 ? 's' : ''}`);
                if (imageCount) parts.push(`${imageCount} image${imageCount > 1 ? 's' : ''}`);
                procMsg.textContent = `Uploading ${parts.join(' & ')} to server…`;

                const formData = new FormData();
                files.forEach(f => formData.append('files', f));

                procMsg.textContent = 'Gemini Vision is analyzing your media and detecting variants…';
                const response = await fetch('/api/shopify/video-to-listing', { method: 'POST', body: formData });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Failed to generate listing');

                processing.style.display = 'none';

                // Store the pending analysis result and show variant popup
                this.vtlPendingAnalysis = data;
                this.vtlShowVariantPopup(data.detectedAttributes || []);

            } catch (err) {
                processing.style.display = 'none';
                window.AppController.showToast('Error: ' + err.message, 'error');
            } finally {
                btnGen.disabled = false;
            }
        },

        // Show variant detection popup with AI-detected attributes pre-filled
        vtlShowVariantPopup: function(detectedAttributes) {
            const optList      = document.getElementById('vtl-popup-options-list');
            const detectedDiv  = document.getElementById('vtl-popup-detected-notice');
            const detectedTags = document.getElementById('vtl-popup-detected-tags');
            const noVarCb      = document.getElementById('vtl-popup-no-variants');

            if (!optList) return;
            optList.innerHTML = '';
            if (noVarCb) { noVarCb.checked = false; }
            if (optList) { optList.style.opacity = '1'; optList.style.pointerEvents = 'auto'; }
            const addBtn = document.getElementById('btn-vtl-popup-add-option');
            if (addBtn) addBtn.style.display = 'inline-block';

            // Show detected attributes notice
            const detected = (detectedAttributes || []).filter(a => a.detected);
            if (detected.length && detectedDiv && detectedTags) {
                detectedTags.innerHTML = '';
                detected.forEach(attr => {
                    attr.values.forEach(val => {
                        const tag = document.createElement('span');
                        tag.style.cssText = 'background:rgba(139,92,246,0.25); border:1px solid rgba(139,92,246,0.4); border-radius:20px; padding:3px 10px; font-size:0.78rem; color:#c4b5fd;';
                        tag.textContent = `${attr.name}: ${val}`;
                        detectedTags.appendChild(tag);
                    });
                });
                detectedDiv.style.display = 'block';
            } else if (detectedDiv) {
                detectedDiv.style.display = 'none';
            }

            // Pre-fill option rows from detected attributes
            if (detectedAttributes && detectedAttributes.length) {
                detectedAttributes.forEach(attr => {
                    this.vtlPopupAddOptionRow(attr.name, attr.values.join(', '), attr.detected);
                });
            } else {
                // Default: one empty Color row
                this.vtlPopupAddOptionRow('Color', '', false);
            }

            window.AppController.openModal('modal-vtl-variants');
        },

        // Add an option row inside the variant popup
        vtlPopupAddOptionRow: function(name, values, isDetected) {
            const list = document.getElementById('vtl-popup-options-list');
            if (!list) return;

            const row = document.createElement('div');
            row.className = 'vtl-popup-option-row';
            row.style.cssText = 'background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:8px; padding:12px;';

            const aiLabel = isDetected
                ? '<span style="background:rgba(139,92,246,0.3); color:#c4b5fd; font-size:0.7rem; padding:2px 7px; border-radius:10px; margin-left:6px;">🤖 AI Detected</span>'
                : '';

            row.innerHTML = `
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
                    <span style="font-size:0.8rem; color:var(--text-secondary); font-weight:600;">Variant Option ${list.children.length + 1}${aiLabel}</span>
                    <button type="button" class="btn btn-secondary btn-xs vtl-popup-remove-row" style="padding:2px 8px; font-size:0.75rem;">🗑️ Remove</button>
                </div>
                <div style="display:grid; grid-template-columns:1fr 2fr; gap:10px;">
                    <div>
                        <label style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:4px; display:block;">Option Name</label>
                        <input type="text" class="form-control vtl-popup-opt-name" placeholder="e.g. Color" value="${this.escapeHtml(name || '')}" style="font-size:0.85rem;">
                    </div>
                    <div>
                        <label style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:4px; display:block;">Values <span style="font-weight:400;">(comma-separated)</span></label>
                        <input type="text" class="form-control vtl-popup-opt-values" placeholder="e.g. Red, Blue, Green" value="${this.escapeHtml(values || '')}" style="font-size:0.85rem;">
                    </div>
                </div>
            `;

            row.querySelector('.vtl-popup-remove-row').addEventListener('click', () => {
                row.remove();
                // Re-number rows
                list.querySelectorAll('.vtl-popup-option-row').forEach((r, idx) => {
                    const titleEl = r.querySelector('span');
                    if (titleEl) {
                        const aiSpan = titleEl.querySelector('span');
                        titleEl.textContent = `Variant Option ${idx + 1}`;
                        if (aiSpan) titleEl.appendChild(aiSpan);
                    }
                });
            });

            list.appendChild(row);
        },

        // Confirm popup: build product and go directly to scraper-format preview
        vtlPopupConfirm: async function() {
            const data = this.vtlPendingAnalysis;
            if (!data) return;

            const noVarCb = document.getElementById('vtl-popup-no-variants');
            const noVariants = noVarCb && noVarCb.checked;

            // Read popup option rows
            const popupOptions = [];
            if (!noVariants) {
                document.querySelectorAll('#vtl-popup-options-list .vtl-popup-option-row').forEach(row => {
                    const name = row.querySelector('.vtl-popup-opt-name')?.value.trim();
                    const valuesRaw = row.querySelector('.vtl-popup-opt-values')?.value.trim();
                    if (name && valuesRaw) {
                        const values = valuesRaw.split(',').map(v => v.trim()).filter(Boolean);
                        if (values.length) popupOptions.push({ name, values });
                    }
                });
            }

            // Close popup
            window.AppController.closeModal('modal-vtl-variants');

            // Build frames & variant assignments from data directly
            this.vtlFrames = data.frames.map(f => ({ ...f, selected: true }));
            this.vtlVariantAssignments = {};

            const listing = data.listing;
            const title   = listing.title || '';
            const price   = listing.suggestedPrice || '';
            const compare = '';
            const tagsRaw = Array.isArray(listing.tags) ? listing.tags.join(', ') : (listing.tags || '');
            const desc    = listing.description || '';
            const tags    = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

            // If variants requested: Gemini assigns images, then deduplicate (1 image per color value)
            let selectedFrames = [...this.vtlFrames];
            let variants = [];

            if (popupOptions.length > 0) {
                const primaryOption = popupOptions[0];

                // Auto-assign images via Gemini if we have enough images & primary values
                if (selectedFrames.length > 0 && primaryOption.values.length >= 1) {
                    try {
                        window.AppController.showToast(`🤖 AI assigning images to "${primaryOption.name}" values…`, 'info');
                        const response = await fetch('/api/shopify/assign-variant-images', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                frameFilenames: selectedFrames.map(f => f.filename),
                                variantOption: primaryOption.name,
                                variantValues: primaryOption.values
                            })
                        });
                        const assignData = await response.json();
                        if (response.ok && assignData.assignments) {
                            selectedFrames.forEach((frame, i) => {
                                this.vtlVariantAssignments[frame.filename] = assignData.assignments[String(i)] || primaryOption.values[0];
                            });
                        }
                    } catch (e) {
                        console.warn('Auto-assign images failed, skipping:', e.message);
                    }
                }

                // Deduplicate: keep only the FIRST image for each primary option value
                // (Shopify supports only 1 image per variant value)
                const seenValues = new Set();
                const dedupedFrames = [];
                for (const frame of selectedFrames) {
                    const val = this.vtlVariantAssignments[frame.filename] || null;
                    if (val === null || !seenValues.has(val)) {
                        if (val !== null) seenValues.add(val);
                        dedupedFrames.push(frame);
                    }
                    // Deselect extras in vtlFrames
                }
                // Mark deselected frames in vtlFrames
                this.vtlFrames.forEach(f => {
                    f.selected = dedupedFrames.some(d => d.filename === f.filename);
                });
                selectedFrames = dedupedFrames;

                // For values that got no image assigned, keep them in options but warn
                variants = this.vtlBuildAllVariants(popupOptions, selectedFrames, price, compare);
            } else {
                variants = [{ option1: 'Default Title', price: price || '0', compare_at_price: null }];
            }

            // Build scrapedProduct in the same shape the import route expects
            const imageUrls = selectedFrames.map(f => f.url);
            this.scrapedProduct = {
                title,
                description: desc,
                tags,
                images: imageUrls,
                options: popupOptions,
                variants,
                type: '',
                vendor: ''
            };
            this.userCollections = [];
            this.floatingVideos = [];

            // Populate the shared import form fields (same as scraper format)
            document.getElementById('shopify-import-title').value = title;
            document.getElementById('shopify-import-sku-prefix').value = '';
            document.getElementById('shopify-import-price').value = price || '';
            document.getElementById('shopify-import-compare-price').value = compare;
            document.getElementById('shopify-import-description').value = desc;

            // Set the store selector to the VTL-selected store
            const vtlStoreId = document.getElementById('vtl-store-select')?.value;
            const mainStoreSelect = document.getElementById('shopify-target-store-select');
            if (vtlStoreId && mainStoreSelect) {
                mainStoreSelect.value = vtlStoreId;
            }

            // Fetch and render collections from selected store
            const collectionsContainer = document.getElementById('shopify-import-collections-checklist');
            if (collectionsContainer) collectionsContainer.innerHTML = '<span style="color:var(--text-secondary); font-size:0.85rem;">Loading collections…</span>';

            if (vtlStoreId) {
                try {
                    const colRes = await fetch(`/api/shopify/collections?storeId=${encodeURIComponent(vtlStoreId)}`);
                    if (colRes.ok) {
                        const colData = await colRes.json();
                        this.userCollections = colData.collections || [];
                    }
                } catch (e) { /* ignore */ }

                if (collectionsContainer) {
                    if (this.userCollections.length === 0) {
                        collectionsContainer.innerHTML = '<span style="color:var(--text-secondary); font-size:0.85rem;">No collections found on this store.</span>';
                    } else {
                        collectionsContainer.innerHTML = '';
                        this.userCollections.forEach(c => {
                            const label = document.createElement('label');
                            label.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:0.85rem; color:white; cursor:pointer;';
                            label.innerHTML = `
                                <input type="checkbox" class="shopify-collection-checkbox" value="${c.id}">
                                <span>${this.escapeHtml(c.title)}</span>
                            `;
                            collectionsContainer.appendChild(label);
                        });
                    }
                }
            } else if (collectionsContainer) {
                collectionsContainer.innerHTML = '<span style="color:var(--text-secondary); font-size:0.85rem;">No collections — select store first.</span>';
            }

            // Render variants pricing table
            const variantsContainer = document.getElementById('shopify-import-variants-container');
            const variantsTbody     = document.getElementById('shopify-import-variants-tbody');
            if (variantsContainer && variantsTbody) {
                if (variants.length > 1) {
                    variantsContainer.style.display = 'block';
                    variantsTbody.innerHTML = '';
                    variants.forEach((v, idx) => {
                        const label = [v.option1, v.option2, v.option3].filter(Boolean).join(' / ');
                        const tr = document.createElement('tr');
                        tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
                        tr.innerHTML = `
                            <td style="padding:6px; font-weight:600;">${this.escapeHtml(label)}</td>
                            <td style="padding:6px;">
                                <input type="number" step="0.01" class="form-control shopify-variant-price-input"
                                    data-index="${idx}" value="${price || ''}" style="padding:4px 8px; font-size:0.8rem; background:rgba(0,0,0,0.3); border-color:var(--glass-border); width:100px;">
                            </td>
                            <td style="padding:6px;">
                                <input type="number" step="0.01" class="form-control shopify-variant-compare-input"
                                    data-index="${idx}" value="" style="padding:4px 8px; font-size:0.8rem; background:rgba(0,0,0,0.3); border-color:var(--glass-border); width:100px;">
                            </td>
                            <td style="padding:6px; color:var(--text-secondary); font-size:0.8rem;" class="shopify-variant-sku-preview" data-index="${idx}">
                                (prefix)-${(v.option1 || '').replace(/[^a-zA-Z0-9]/g, '')}${v.option2 ? '-' + v.option2.replace(/[^a-zA-Z0-9]/g, '') : ''}
                            </td>`;
                        variantsTbody.appendChild(tr);
                    });
                } else {
                    variantsContainer.style.display = 'none';
                }
            }

            // Render images grid in scraper format
            const imagesContainer = document.getElementById('shopify-import-images-grid');
            if (imagesContainer) {
                imagesContainer.innerHTML = '';
                selectedFrames.forEach(frame => {
                    const div = document.createElement('div');
                    div.style.cssText = 'width:80px; height:80px; flex-shrink:0; border:1px solid var(--glass-border); border-radius:6px; overflow:hidden; background:rgba(0,0,0,0.2); position:relative;';
                    // Show color label if assigned
                    const colorVal = this.vtlVariantAssignments[frame.filename];
                    div.innerHTML = `
                        <img src="${frame.url}" style="width:100%; height:100%; object-fit:cover;">
                        ${colorVal ? `<div style="position:absolute;bottom:0;left:0;right:0;background:rgba(124,58,237,0.85);color:white;font-size:0.6rem;text-align:center;padding:2px;">${this.escapeHtml(colorVal)}</div>` : ''}
                    `;
                    imagesContainer.appendChild(div);
                });
            }

            // Show the shared preview container (same as scraper result)
            const previewTitle = document.getElementById('shopify-preview-title');
            if (previewTitle) previewTitle.textContent = '🎬 Product Preview (from Media)';
            const previewContainer = document.getElementById('shopify-preview-container');
            if (previewContainer) {
                previewContainer.style.display = 'block';
                previewContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }

            const variantMsg = popupOptions.length ? ` ${variants.length} variants ready.` : '';
            window.AppController.showToast(`Listing ready!${variantMsg} Review then click Import. 🎉`, 'success');
        },

        vtlToggleFrame: function(idx, el) {
            if (!this.vtlFrames[idx]) return;
            this.vtlFrames[idx].selected = !this.vtlFrames[idx].selected;
            const selected = this.vtlFrames[idx].selected;
            el.style.borderColor = selected ? 'rgba(139,92,246,0.6)' : 'rgba(255,255,255,0.15)';
            el.style.opacity = selected ? '1' : '0.35';
            const check = el.querySelector('.vtl-frame-check');
            if (check) check.style.display = selected ? 'flex' : 'none';
            // Clear variant assignments since images changed
            this.vtlVariantAssignments = {};
            const asgn = document.getElementById('vtl-variant-assignments');
            if (asgn) { asgn.style.display = 'none'; asgn.innerHTML = ''; }
        },

        vtlAssignVariants: async function() {
            const btn     = document.getElementById('btn-vtl-assign-variants');
            const asgnDiv = document.getElementById('vtl-variant-assignments');

            const options = this.vtlGetOptions();
            if (!options.length) {
                window.AppController.showToast('Add at least one variant option with values first.', 'warning');
                return;
            }
            // Only first option is used for image assignment (it's the visual/color option)
            const primaryOption = options[0];
            if (primaryOption.values.length < 2) {
                window.AppController.showToast(`"${primaryOption.name}" needs at least 2 values for image assignment.`, 'warning');
                return;
            }

            const selectedFrames = this.vtlFrames.filter(f => f.selected);
            if (!selectedFrames.length) {
                window.AppController.showToast('No images selected. Select at least one image first.', 'warning');
                return;
            }

            try {
                btn.disabled = true;
                btn.textContent = '⏳ Analyzing images…';
                window.AppController.showToast(`Gemini is assigning images to "${primaryOption.name}" values…`, 'info');

                const response = await fetch('/api/shopify/assign-variant-images', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        frameFilenames: selectedFrames.map(f => f.filename),
                        variantOption: primaryOption.name,
                        variantValues: primaryOption.values
                    })
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Assignment failed');

                // Store: filename → assigned primary value (e.g. "Red")
                this.vtlVariantAssignments = {};
                selectedFrames.forEach((frame, i) => {
                    this.vtlVariantAssignments[frame.filename] = data.assignments[String(i)] || primaryOption.values[0];
                });

                // Render result with labeled images
                asgnDiv.innerHTML = `
                    <p style="color:#a78bfa; font-size:0.85rem; margin-bottom:8px;">
                        ✅ Images assigned to <strong>${this.escapeHtml(primaryOption.name)}</strong> values:
                    </p>
                    <div style="display:flex; flex-wrap:wrap; gap:10px;">
                        ${selectedFrames.map(frame => `
                            <div style="text-align:center; font-size:0.78rem;">
                                <img src="${frame.url}" style="width:70px; height:55px; object-fit:cover; border-radius:6px; border:2px solid rgba(139,92,246,0.5); display:block; margin-bottom:4px;">
                                <span style="color:#a78bfa; font-weight:600; font-size:0.75rem;">${this.escapeHtml(this.vtlVariantAssignments[frame.filename] || primaryOption.values[0])}</span>
                            </div>`).join('')}
                    </div>`;
                asgnDiv.style.display = 'block';

                // Show how many combinations will be created
                const allOptions = this.vtlGetOptions();
                const totalCombos = allOptions.reduce((acc, opt) => acc * opt.values.length, 1);
                window.AppController.showToast(`Images assigned! Will create ${totalCombos} variant combinations. ✨`, 'success');
            } catch (err) {
                window.AppController.showToast('Variant assignment error: ' + err.message, 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = '🤖 Auto-Assign Images to First Option';
            }
        },

        // Build full cartesian-product variants with image assignment
        vtlBuildAllVariants: function(options, selectedFrames, price, compare) {
            if (!options.length) {
                return [{ option1: 'Default Title', price: price || '0', compare_at_price: compare || null }];
            }

            // primaryValue → index in selectedFrames (first match wins)
            const primaryValueToImgIdx = {};
            selectedFrames.forEach((frame, i) => {
                const val = this.vtlVariantAssignments[frame.filename];
                if (val && primaryValueToImgIdx[val] === undefined) {
                    primaryValueToImgIdx[val] = i;
                }
            });

            // Cartesian product of all option values
            const allValues = options.map(o => o.values);
            const cartesian = allValues.reduce(
                (acc, vals) => acc.flatMap(combo => vals.map(v => [...combo, v])),
                [[]]
            );

            return cartesian.map(combo => {
                const v = { price: price || '0', compare_at_price: compare || null };
                if (combo[0] !== undefined) v.option1 = combo[0]; // primary (Color)
                if (combo[1] !== undefined) v.option2 = combo[1];
                if (combo[2] !== undefined) v.option3 = combo[2];
                // Image matches the primary option value (option1)
                const primaryVal = combo[0];
                v.variant_image_index = primaryValueToImgIdx[primaryVal] !== undefined
                    ? primaryValueToImgIdx[primaryVal]
                    : 0;
                return v;
            });
        },

        // Populate the existing scraper import form with VTL data and open it
        vtlUseThisListing: function() {
            const title   = document.getElementById('vtl-title')?.value.trim();
            const price   = document.getElementById('vtl-price')?.value.trim();
            const compare = document.getElementById('vtl-compare-price')?.value.trim();
            const tagsRaw = document.getElementById('vtl-tags')?.value.trim();
            const desc    = document.getElementById('vtl-description')?.value.trim();

            if (!title) { window.AppController.showToast('Product title cannot be empty.', 'warning'); return; }

            const selectedFrames = this.vtlFrames.filter(f => f.selected);
            if (!selectedFrames.length) { window.AppController.showToast('No images selected.', 'warning'); return; }

            const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
            const imageUrls = selectedFrames.map(f => f.url);

            const hasVariants = document.getElementById('vtl-has-variants')?.checked;
            const options = hasVariants ? this.vtlGetOptions() : [];
            const variants = this.vtlBuildAllVariants(options, selectedFrames, price, compare);

            // Build scrapedProduct in the same shape the import route expects
            this.scrapedProduct = {
                title,
                description: desc,
                tags,
                images: imageUrls,
                options,
                variants,
                type: '',
                vendor: ''
            };
            this.userCollections = [];
            this.floatingVideos = [];

            // Populate the shared import form fields
            document.getElementById('shopify-import-title').value = title;
            document.getElementById('shopify-import-sku-prefix').value = '';
            document.getElementById('shopify-import-price').value = price || '';
            document.getElementById('shopify-import-compare-price').value = compare || '';
            document.getElementById('shopify-import-description').value = desc;

            // Render collections (empty)
            const collectionsContainer = document.getElementById('shopify-import-collections-checklist');
            if (collectionsContainer) collectionsContainer.innerHTML = '<span style="color:var(--text-secondary); font-size:0.85rem;">No collections — select store after import if needed.</span>';

            // Render variants table if multiple options with combinations
            const variantsContainer = document.getElementById('shopify-import-variants-container');
            const variantsTbody     = document.getElementById('shopify-import-variants-tbody');
            if (variantsContainer && variantsTbody) {
                if (variants.length > 1) {
                    variantsContainer.style.display = 'block';
                    variantsTbody.innerHTML = '';
                    variants.forEach((v, idx) => {
                        const label = [v.option1, v.option2, v.option3].filter(Boolean).join(' / ');
                        const tr = document.createElement('tr');
                        tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
                        tr.innerHTML = `
                            <td style="padding:6px; font-weight:600;">${this.escapeHtml(label)}</td>
                            <td style="padding:6px;">
                                <input type="number" step="0.01" class="form-control shopify-variant-price-input"
                                    data-index="${idx}" value="${price || ''}" placeholder="${price || ''}" style="padding:4px 8px; font-size:0.8rem; background:rgba(0,0,0,0.3); border-color:var(--glass-border); width:100px;">
                            </td>
                            <td style="padding:6px;">
                                <input type="number" step="0.01" class="form-control shopify-variant-compare-input"
                                    data-index="${idx}" value="${compare || ''}" style="padding:4px 8px; font-size:0.8rem; background:rgba(0,0,0,0.3); border-color:var(--glass-border); width:100px;">
                            </td>
                            <td style="padding:6px; color:var(--text-secondary); font-size:0.8rem;" class="shopify-variant-sku-preview" data-index="${idx}">
                                (prefix)-${(v.option1 || '').replace(/[^a-zA-Z0-9]/g, '')}${v.option2 ? '-' + v.option2.replace(/[^a-zA-Z0-9]/g, '') : ''}
                            </td>`;
                        variantsTbody.appendChild(tr);
                    });
                } else {
                    variantsContainer.style.display = 'none';
                }
            }

            // Render images grid
            const imagesContainer = document.getElementById('shopify-import-images-grid');
            if (imagesContainer) {
                imagesContainer.innerHTML = '';
                selectedFrames.forEach((frame, imgIdx) => {
                    const div = document.createElement('div');
                    div.style.cssText = 'position:relative; flex-shrink:0;';
                    div.innerHTML = `<img src="${frame.url}" style="width:100px; height:80px; object-fit:cover; border-radius:6px; border:1px solid var(--glass-border);">`;
                    imagesContainer.appendChild(div);
                });
            }

            // Update title and show the shared preview container
            const previewTitle = document.getElementById('shopify-preview-title');
            if (previewTitle) previewTitle.textContent = '🎬 Product Preview (from Video)';
            const previewContainer = document.getElementById('shopify-preview-container');
            if (previewContainer) previewContainer.style.display = 'block';

            // Scroll to the import form
            previewContainer?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            window.AppController.showToast('Listing loaded into import form. Fill SKU prefix & store, then import! 🚀', 'success');
        },

        // ─────────────────────────────────────────────────────────────────────

        escapeHtml: function(value) {
            return String(value).replace(/[&<>"']/g, char => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
            }[char]));
        }
    };

    window.ShopifyImporter = ShopifyImporter;

    document.addEventListener('DOMContentLoaded', () => {
        ShopifyImporter.init();
    });
})();
