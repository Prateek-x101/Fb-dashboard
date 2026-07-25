// public/js/shopify.js
(function() {
    const ShopifyImporter = {
        scrapedProduct: null,
        userCollections: [],
        floatingVideos: [],
        importedProduct: null,

        init: function() {
            this.bindEvents();
            document.addEventListener('appReady', () => {
                this.loadStoresSelect();
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
                    return {
                        filePath: response.filePath,
                        filename: response.filename
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
                window.AppController.showToast(`${this.floatingVideos.length} video(s) uploaded successfully to server! 📹`, 'success');
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
                
                // Store imported details for later ad creation
                ShopifyImporter.importedProduct = {
                    title: result.title,
                    productUrl: result.productUrl,
                    videoPath: this.floatingVideos[0]?.filePath || null,
                    videoFilename: this.floatingVideos[0]?.filename || null
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
                    opt.textContent = `${acc.name} (act_${acc.accountId})`;
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
                // Get pixels
                const pixelsData = await window.API.getPixels(accountId);
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

                // Get the ad account detail to know the original actId
                const accounts = await window.API.getAccounts();
                const currentAcc = accounts.find(a => a.id === accountId);
                const currentAccId = currentAcc?.accountId || '';

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
                if (currentAcc?.pageId) {
                    pageSelect.value = currentAcc.pageId;
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
                    previewUrl: '/uploads/' + this.importedProduct.videoFilename
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
