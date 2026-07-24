// public/js/shopify.js
(function() {
    const ShopifyImporter = {
        scrapedProduct: null,
        userCollections: [],

        init: function() {
            this.bindEvents();
            document.addEventListener('appReady', () => {
                this.loadStoresSelect();
            });
        },

        bindEvents: function() {
            const btnScrape = document.getElementById('btn-shopify-scrape');
            const btnImport = document.getElementById('btn-shopify-import-confirm');

            if (btnScrape) {
                btnScrape.addEventListener('click', () => this.scrapeProduct());
            }

            if (btnImport) {
                btnImport.addEventListener('click', () => this.importProduct());
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

            // Get selected collections
            const checkedBoxes = document.querySelectorAll('.shopify-collection-checkbox:checked');
            const collectionIds = Array.from(checkedBoxes).map(cb => cb.value);

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
                    collectionIds
                });

                window.AppController.showToast(`Successfully imported: "${result.title}" to Shopify! 🎉`, 'success');
                
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
                            <button id="btn-modal-create-ad" class="btn btn-primary" style="width:100%;">
                                ➕ Create Facebook Ad for this Product
                            </button>
                        </div>
                    `;
                    
                    window.AppController.openModal('modal-result');

                    const btnCreateAd = document.getElementById('btn-modal-create-ad');
                    if (btnCreateAd) {
                        btnCreateAd.addEventListener('click', () => {
                            // Ask user for Person Name and budget choice
                            const defaultPerson = localStorage.getItem('last_person_name') || '';
                            const personName = prompt("Enter Person Name for Campaign (e.g. Prateek):", defaultPerson);
                            if (personName === null) return; // user cancelled
                            
                            const budgetChoice = prompt("Enter Budget Type (ABO or CBO):", "CBO");
                            if (budgetChoice === null) return; // user cancelled
                            const cleanBudget = budgetChoice.toUpperCase().trim() === 'ABO' ? 'ABO' : 'CBO';
                            
                            if (personName) {
                                localStorage.setItem('last_person_name', personName);
                            }
                            
                            // Close modal
                            window.AppController.closeModal('modal-result');
                            
                            // Extract 2-4 short words from the product title
                            const shortName = ShopifyImporter.extractShortProductName(result.title);
                            
                            // Format current date as DD-MM-YYYY
                            const now = new Date();
                            const pad = n => String(n).padStart(2, '0');
                            const dateStr = `${pad(now.getDate())}-${pad(now.getMonth()+1)}-${now.getFullYear()}`;
                            
                            // Get SKU prefix
                            const skuPrefix = document.getElementById('shopify-sku-prefix')?.value?.trim() || 'GTS';
                            
                            // Format campaign name: Baseball Cap (GTS 24-07-2026-Prateek) ABO
                            const campaignName = `${shortName} (${skuPrefix} ${dateStr}-${personName || 'User'}) ${cleanBudget}`;
                            
                            // Initialize campaign wizard with data
                            window.CampaignWizard.startCampaignWizardWithData(campaignName, result.productUrl);
                            
                            // Navigate to Create Campaign section
                            const navItem = document.querySelector('.nav-item[data-section="section-campaign"]');
                            if (navItem) navItem.click();
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

        extractShortProductName: function(title) {
            if (!title) return 'Product';
            
            // Remove all emojis and special characters
            let clean = title.replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDC00-\uDFFF]/g, '');
            clean = clean.replace(/[^a-zA-Z0-9\s]/g, ' ');
            
            // Common promotional and generic keywords to filter
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
            
            // Fallback to original words if everything gets filtered
            if (filtered.length === 0) filtered = words;
            
            // Pick 2 to 4 words
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
