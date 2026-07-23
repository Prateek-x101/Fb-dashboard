// public/js/campaign.js
(function() {
    const CampaignWizard = {
        currentStep: 1,
        totalSteps: 4,
        campaignData: {
            step1: {},
            step2: { audiences: [] },
            step3: { media: null, mediaFile: null, variations: [] }
        },

        init: function() {
            this.bindEvents();
            document.addEventListener('appReady', () => {
                this.populateAccountSelect();
                this.updateAudienceCards();
            });
            document.addEventListener('accountChanged', (e) => {
                this.handleAccountChange(e.detail);
            });
        },

        bindEvents: function() {
            const btnNext = document.getElementById('btn-next-step');
            const btnPrev = document.getElementById('btn-prev-step');
            const btnCreate = document.getElementById('btn-create-campaign');

            if (btnNext) btnNext.addEventListener('click', () => this.nextStep());
            if (btnPrev) btnPrev.addEventListener('click', () => this.prevStep());
            if (btnCreate) btnCreate.addEventListener('click', () => this.createCampaign());

            // Adset number controls
            const numAdsets = document.getElementById('num-adsets');
            if (numAdsets) {
                numAdsets.addEventListener('change', () => this.updateAudienceCards());
            }

            // Add adset button
            const btnAddAdset = document.getElementById('btn-add-adset');
            if (btnAddAdset) {
                btnAddAdset.addEventListener('click', () => {
                    const numInput = document.getElementById('num-adsets');
                    if (numInput) {
                        numInput.value = parseInt(numInput.value) + 1;
                        this.updateAudienceCards();
                    }
                });
            }

            // Media upload
            const dropZone = document.getElementById('media-upload-zone');
            const fileInput = document.getElementById('media-file-input');
            if (dropZone && fileInput) {
                dropZone.addEventListener('click', () => fileInput.click());
                dropZone.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    dropZone.classList.add('dragover');
                    dropZone.style.borderColor = 'var(--accent-blue)';
                    dropZone.style.background = 'rgba(67, 97, 238, 0.1)';
                });
                dropZone.addEventListener('dragleave', () => {
                    dropZone.classList.remove('dragover');
                    dropZone.style.borderColor = '';
                    dropZone.style.background = '';
                });
                dropZone.addEventListener('drop', (e) => {
                    e.preventDefault();
                    dropZone.classList.remove('dragover');
                    dropZone.style.borderColor = '';
                    dropZone.style.background = '';
                    if (e.dataTransfer.files.length) {
                        this.handleMediaUpload(e.dataTransfer.files[0]);
                    }
                });
                fileInput.addEventListener('change', (e) => {
                    if (e.target.files.length) {
                        this.handleMediaUpload(e.target.files[0]);
                    }
                });
            }

            // Generate variations
            const btnGenerate = document.getElementById('btn-generate-variations');
            if (btnGenerate) {
                btnGenerate.addEventListener('click', () => this.generateVariations());
            }

            // Add variation manually
            const btnAddVariation = document.getElementById('btn-add-variation');
            if (btnAddVariation) {
                btnAddVariation.addEventListener('click', () => this.addManualVariation());
            }
        },

        updateStepUI: function() {
            // Update step visibility
            for (let i = 1; i <= this.totalSteps; i++) {
                const stepEl = document.getElementById(`step-${i}`);
                if (stepEl) {
                    if (i === this.currentStep) {
                        stepEl.classList.add('active');
                    } else {
                        stepEl.classList.remove('active');
                    }
                }
                
                // Update step indicators
                const indicator = document.getElementById(`step-indicator-${i}`);
                if (indicator) {
                    indicator.classList.remove('active', 'completed');
                    if (i < this.currentStep) {
                        indicator.classList.add('completed');
                    } else if (i === this.currentStep) {
                        indicator.classList.add('active');
                    }
                }
            }

            // Buttons visibility
            const btnNext = document.getElementById('btn-next-step');
            const btnPrev = document.getElementById('btn-prev-step');
            const btnCreate = document.getElementById('btn-create-campaign');

            if (btnPrev) btnPrev.style.display = this.currentStep > 1 ? 'inline-flex' : 'none';
            if (btnNext) btnNext.style.display = this.currentStep < this.totalSteps ? 'inline-flex' : 'none';

            // Show create button only on review step
            if (this.currentStep === this.totalSteps) {
                this.renderReviewSummary();
            }
        },

        validateStep: function(step) {
            if (step === 1) {
                const name = document.getElementById('campaign-name')?.value?.trim();
                const objective = document.getElementById('campaign-objective')?.value;
                const budgetAmount = document.getElementById('budget-amount')?.value;
                const start = document.getElementById('schedule-start')?.value;
                const account = document.getElementById('campaign-account-select')?.value;

                if (!name) {
                    window.AppController.showToast('Campaign name is required', 'warning');
                    return false;
                }
                if (!budgetAmount || budgetAmount <= 0) {
                    window.AppController.showToast('Please enter a valid budget amount', 'warning');
                    return false;
                }
                if (!start) {
                    window.AppController.showToast('Please set a start date', 'warning');
                    return false;
                }
                if (!account) {
                    window.AppController.showToast('Please select an ad account', 'warning');
                    return false;
                }

                this.campaignData.step1 = {
                    name,
                    objective,
                    budgetType: document.getElementById('budget-type-cbo')?.checked ? 'CBO' : 'ABO',
                    budgetAmount: parseFloat(budgetAmount),
                    scheduleStart: start,
                    scheduleEnd: document.getElementById('schedule-end')?.value || '',
                    accountId: account,
                    specialAdCategory: document.getElementById('camp-special')?.value || 'NONE'
                };
                return true;
            } else if (step === 2) {
                const url = document.getElementById('website-url')?.value?.trim();
                
                if (!url) {
                    window.AppController.showToast('Please enter a Website URL', 'warning');
                    return false;
                }
                
                // Collect audiences from cards
                const audienceCards = document.querySelectorAll('.audience-card');
                const audiences = [];
                
                audienceCards.forEach((card, idx) => {
                    const locations = [];
                    card.querySelectorAll('.location-tag').forEach(tag => {
                        locations.push(tag.getAttribute('data-value') || tag.textContent.replace('✖', '').trim());
                    });

                    const interests = [];
                    card.querySelectorAll('.interest-tag').forEach(tag => {
                        interests.push({
                            id: tag.getAttribute('data-id') || '',
                            name: tag.getAttribute('data-value') || tag.textContent.replace('✖', '').trim()
                        });
                    });

                    audiences.push({
                        name: `Audience ${idx + 1}`,
                        locations: locations.length > 0 ? locations : ['IN'],
                        ageMin: parseInt(card.querySelector('.age-min')?.value) || 18,
                        ageMax: parseInt(card.querySelector('.age-max')?.value) || 65,
                        gender: card.querySelector('input[name^="gender_"]:checked')?.value || 'all',
                        interests
                    });
                });

                this.campaignData.step2 = {
                    url,
                    pixel: document.getElementById('pixel-select')?.value || '',
                    optimizationGoal: document.getElementById('optimization-goal')?.value || 'OFFSITE_CONVERSIONS',
                    conversionEvent: document.getElementById('conversion-event')?.value || 'PURCHASE',
                    audiences
                };
                return true;
            } else if (step === 3) {
                // Collect variations from DOM
                this.collectVariationsFromDOM();

                if (this.campaignData.step3.variations.length === 0) {
                    window.AppController.showToast('Please add at least one primary text variation', 'warning');
                    return false;
                }

                this.campaignData.step3.headline = document.getElementById('headline')?.value || '';
                this.campaignData.step3.description = document.getElementById('description')?.value || '';
                this.campaignData.step3.cta = document.getElementById('cta-select')?.value || 'SHOP_NOW';
                this.campaignData.step3.pageId = document.getElementById('ad-page')?.value || '';

                return true;
            }
            return true;
        },

        collectVariationsFromDOM: function() {
            const container = document.getElementById('variations-container');
            if (!container) return;

            const variations = [];
            container.querySelectorAll('.variation-card').forEach(card => {
                const textarea = card.querySelector('textarea');
                if (textarea && textarea.value.trim()) {
                    variations.push(textarea.value.trim());
                }
            });
            this.campaignData.step3.variations = variations;
        },

        nextStep: function() {
            if (this.validateStep(this.currentStep)) {
                this.currentStep++;
                this.updateStepUI();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        },

        prevStep: function() {
            if (this.currentStep > 1) {
                this.currentStep--;
                this.updateStepUI();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        },

        populateAccountSelect: function() {
            const select = document.getElementById('campaign-account-select');
            if (select) {
                select.innerHTML = '<option value="">Select Account</option>';
                window.APP.accounts.forEach(acc => {
                    const opt = document.createElement('option');
                    opt.value = acc.id;
                    opt.textContent = `${acc.label || acc.name || 'Account'} (${acc.accountId || acc.id})`;
                    select.appendChild(opt);
                });
                if (window.APP.activeAccount) {
                    select.value = window.APP.activeAccount.id;
                    this.handleAccountChange(window.APP.activeAccount);
                }
            }
        },

        handleAccountChange: async function(account) {
            const pixelSelect = document.getElementById('pixel-select');
            if (!pixelSelect || !account) return;
            
            pixelSelect.innerHTML = '<option value="">Loading pixels...</option>';
            try {
                const pixels = await window.API.getPixels(account.accountId || account.id);
                pixelSelect.innerHTML = '<option value="">Select Pixel</option>';
                if (Array.isArray(pixels)) {
                    pixels.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p.id;
                        opt.textContent = p.name || p.id;
                        pixelSelect.appendChild(opt);
                    });
                }
            } catch (error) {
                pixelSelect.innerHTML = '<option value="">No pixels found</option>';
            }
        },

        updateAudienceCards: function() {
            const container = document.getElementById('audience-container');
            const numAdsets = parseInt(document.getElementById('num-adsets')?.value || 3, 10);
            
            if (!container) return;
            container.innerHTML = '';
            
            for (let i = 0; i < numAdsets; i++) {
                const card = document.createElement('div');
                card.className = 'glass-card audience-card mb-3';
                card.style.position = 'relative';
                card.innerHTML = `
                    <div class="flex justify-between align-center mb-2">
                        <h4>🎯 Audience ${i + 1}</h4>
                        ${numAdsets > 1 ? `<button class="remove-card-btn" onclick="this.closest('.audience-card').remove()"><span>✖</span></button>` : ''}
                    </div>
                    <div class="grid-2">
                        <div class="form-group">
                            <label>Locations</label>
                            <div class="form-control tags-input" style="min-height:45px;">
                                <span class="tag location-tag" data-value="IN">India <span class="tag-remove" onclick="this.parentElement.remove()">✖</span></span>
                                <input type="text" placeholder="Add country code..." class="location-input" style="background:transparent; border:none; color:white; outline:none; flex:1; min-width:100px;">
                            </div>
                        </div>
                        <div class="form-group">
                            <div class="flex gap-2">
                                <div style="flex:1">
                                    <label>Min Age</label>
                                    <input type="number" class="form-control age-min" value="18" min="13" max="65">
                                </div>
                                <div style="flex:1">
                                    <label>Max Age</label>
                                    <input type="number" class="form-control age-max" value="65" min="13" max="65">
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label>Gender</label>
                        <div class="flex gap-2">
                            <label style="cursor:pointer"><input type="radio" name="gender_${i}" value="all" checked> All</label>
                            <label style="cursor:pointer"><input type="radio" name="gender_${i}" value="male"> Male</label>
                            <label style="cursor:pointer"><input type="radio" name="gender_${i}" value="female"> Female</label>
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Interests (Detailed Targeting)</label>
                        <div class="form-control tags-input interests-tags-${i}" style="min-height:45px; position:relative;">
                            <input type="text" placeholder="Search interests..." class="interest-search" data-index="${i}" style="background:transparent; border:none; color:white; outline:none; flex:1; min-width:150px;">
                        </div>
                        <div class="interest-dropdown" id="interest-dropdown-${i}" style="display:none; position:absolute; z-index:50; background:rgba(26,26,46,0.98); border:1px solid var(--glass-border); border-radius:8px; max-height:200px; overflow-y:auto; width:calc(100% - 3rem);"></div>
                    </div>
                `;
                container.appendChild(card);
                
                // Set up location tag input
                const locationInput = card.querySelector('.location-input');
                locationInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        const val = e.target.value.trim().toUpperCase();
                        if (val) {
                            const tag = document.createElement('span');
                            tag.className = 'tag location-tag';
                            tag.setAttribute('data-value', val);
                            tag.innerHTML = `${val} <span class="tag-remove" onclick="this.parentElement.remove()">✖</span>`;
                            e.target.parentElement.insertBefore(tag, e.target);
                            e.target.value = '';
                        }
                    }
                });

                // Set up interest search with debounce
                const searchInput = card.querySelector('.interest-search');
                let debounceTimeout;
                searchInput.addEventListener('input', (e) => {
                    clearTimeout(debounceTimeout);
                    const idx = e.target.getAttribute('data-index');
                    debounceTimeout = setTimeout(async () => {
                        const val = e.target.value.trim();
                        const dropdown = document.getElementById(`interest-dropdown-${idx}`);
                        if (val.length > 2 && dropdown) {
                            try {
                                const results = await window.API.searchInterests(val);
                                dropdown.innerHTML = '';
                                if (Array.isArray(results) && results.length > 0) {
                                    results.forEach(r => {
                                        const item = document.createElement('div');
                                        item.style.cssText = 'padding:0.75rem 1rem; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.05);';
                                        item.textContent = r.name || r;
                                        item.addEventListener('mouseenter', () => item.style.background = 'rgba(67,97,238,0.2)');
                                        item.addEventListener('mouseleave', () => item.style.background = 'transparent');
                                        item.addEventListener('click', () => {
                                            const tagsContainer = card.querySelector(`.interests-tags-${idx}`);
                                            const input = tagsContainer?.querySelector('.interest-search');
                                            if (tagsContainer && input) {
                                                const tag = document.createElement('span');
                                                tag.className = 'tag interest-tag';
                                                tag.setAttribute('data-id', r.id || '');
                                                tag.setAttribute('data-value', r.name || r);
                                                tag.innerHTML = `${r.name || r} <span class="tag-remove" onclick="this.parentElement.remove()">✖</span>`;
                                                tagsContainer.insertBefore(tag, input);
                                            }
                                            dropdown.style.display = 'none';
                                            e.target.value = '';
                                        });
                                        dropdown.appendChild(item);
                                    });
                                    dropdown.style.display = 'block';
                                } else {
                                    dropdown.style.display = 'none';
                                }
                            } catch (err) {
                                console.error('Interest search failed', err);
                                dropdown.style.display = 'none';
                            }
                        } else if (dropdown) {
                            dropdown.style.display = 'none';
                        }
                    }, 500);
                });

                // Hide dropdown when clicking outside
                document.addEventListener('click', (e) => {
                    if (!e.target.classList.contains('interest-search')) {
                        document.querySelectorAll('.interest-dropdown').forEach(d => d.style.display = 'none');
                    }
                });
            }
        },

        handleMediaUpload: async function(file) {
            if (!file) return;
            
            const dropZone = document.getElementById('media-upload-zone');
            
            // Show local preview immediately
            const preview = document.getElementById('media-preview');
            if (preview) {
                if (file.type.startsWith('image/')) {
                    preview.innerHTML = `<img src="${URL.createObjectURL(file)}" style="max-width: 100%; max-height: 200px; border-radius:8px; margin-top:1rem;" />`;
                } else if (file.type.startsWith('video/')) {
                    preview.innerHTML = `<video src="${URL.createObjectURL(file)}" controls style="max-width: 100%; max-height: 200px; border-radius:8px; margin-top:1rem;"></video>`;
                }
            }

            // Update drop zone text
            if (dropZone) {
                dropZone.innerHTML = `<i>✅</i><h4>${file.name}</h4><p>${(file.size / (1024*1024)).toFixed(2)} MB — Click to change</p>`;
            }

            // Upload to server
            try {
                const formData = new FormData();
                formData.append('file', file);
                
                const response = await window.API.uploadMedia(formData);
                this.campaignData.step3.media = response.filePath || response.filename;
                this.campaignData.step3.mediaFile = file.name;
                
                window.AppController.showToast('Media uploaded successfully! ✅', 'success');
            } catch (error) {
                window.AppController.showToast('Media saved locally. Will upload during campaign creation.', 'info');
                this.campaignData.step3.media = file.name;
                this.campaignData.step3.mediaFile = file.name;
            }
        },

        generateVariations: async function() {
            const primaryText = document.getElementById('primary-text')?.value?.trim();
            const num = parseInt(document.getElementById('num-variations')?.value) || 3;
            
            if (!primaryText) {
                window.AppController.showToast('Please write base primary text first', 'warning');
                return;
            }

            const btn = document.getElementById('btn-generate-variations');
            if (btn) {
                btn.disabled = true;
                btn.textContent = '🤖 Generating...';
            }

            try {
                const response = await window.API.generateVariations({
                    primaryText,
                    count: num
                });
                
                const variations = response.variations || response || [];
                this.campaignData.step3.variations = Array.isArray(variations) ? variations : [primaryText];
                
                // Always include the original as first variation
                if (!this.campaignData.step3.variations.includes(primaryText)) {
                    this.campaignData.step3.variations.unshift(primaryText);
                }
                
                this.renderVariations();
                window.AppController.showToast(`${this.campaignData.step3.variations.length} variations generated! 🎉`, 'success');
            } catch (error) {
                window.AppController.showToast('Gemini generation failed: ' + error.message + '. Add variations manually.', 'error');
                // Fallback: create manual variations from base text
                this.campaignData.step3.variations = [primaryText];
                this.renderVariations();
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '🤖 Generate Variations with Gemini';
                }
            }
        },

        addManualVariation: function() {
            const container = document.getElementById('variations-container');
            if (!container) return;

            // Clear placeholder text if present
            const placeholder = container.querySelector('p');
            if (placeholder && !container.querySelector('.variation-card')) {
                container.innerHTML = '';
            }

            const idx = container.querySelectorAll('.variation-card').length + 1;
            const card = document.createElement('div');
            card.className = 'glass-card variation-card mb-2';
            card.style.background = 'rgba(0,0,0,0.2)';
            card.innerHTML = `
                <div class="flex justify-between align-center mb-1">
                    <label style="font-weight:600; color:var(--accent-cyan);">Variation ${idx}</label>
                    <button class="remove-card-btn" onclick="this.closest('.variation-card').remove()"><span>✖</span></button>
                </div>
                <textarea class="form-control" rows="3" placeholder="Write your ad copy variation here..."></textarea>
            `;
            container.appendChild(card);
        },

        renderVariations: function() {
            const container = document.getElementById('variations-container');
            if (!container) return;
            
            container.innerHTML = '';
            this.campaignData.step3.variations.forEach((text, idx) => {
                const card = document.createElement('div');
                card.className = 'glass-card variation-card mb-2';
                card.style.background = 'rgba(0,0,0,0.2)';
                card.innerHTML = `
                    <div class="flex justify-between align-center mb-1">
                        <label style="font-weight:600; color:var(--accent-cyan);">Variation ${idx + 1} ${idx === 0 ? '(Original)' : ''}</label>
                        <button class="remove-card-btn" onclick="this.closest('.variation-card').remove()"><span>✖</span></button>
                    </div>
                    <textarea class="form-control" rows="3">${typeof text === 'string' ? text : text.primaryText || ''}</textarea>
                `;
                container.appendChild(card);
            });
        },

        renderReviewSummary: function() {
            // Collect latest variations from DOM
            this.collectVariationsFromDOM();

            const { step1, step2, step3 } = this.campaignData;
            const totalAdsets = step2.audiences ? step2.audiences.length : 0;
            const totalVariations = step3.variations ? step3.variations.length : 0;
            const totalAds = totalAdsets * totalVariations;

            // Update review cards
            const nameEl = document.getElementById('review-campaign-name');
            const objEl = document.getElementById('review-campaign-objective');
            const budgetEl = document.getElementById('review-campaign-budget');
            const adsetsEl = document.getElementById('review-adsets-count');
            const varsEl = document.getElementById('review-variations-count');
            const totalEl = document.getElementById('review-total-ads');

            if (nameEl) nameEl.innerHTML = `Name: <strong>${step1.name || '—'}</strong>`;
            if (objEl) objEl.innerHTML = `Objective: <strong>${step1.objective || '—'}</strong>`;
            if (budgetEl) budgetEl.innerHTML = `Budget: <strong>$${step1.budgetAmount || 0}/day (${step1.budgetType || 'CBO'})</strong>`;
            if (adsetsEl) adsetsEl.innerHTML = `Ad Sets: <strong>${totalAdsets}</strong>`;
            if (varsEl) varsEl.innerHTML = `Ads per Ad Set: <strong>${totalVariations}</strong>`;
            if (totalEl) totalEl.textContent = `Total Ads: ${totalAds}`;

            // Render adset details
            const detailContainer = document.getElementById('review-adsets-detail');
            if (detailContainer && step2.audiences) {
                detailContainer.innerHTML = '';
                step2.audiences.forEach((aud, idx) => {
                    const card = document.createElement('div');
                    card.className = 'glass-card mb-2';
                    card.style.background = 'rgba(0,0,0,0.15)';
                    card.innerHTML = `
                        <h4 style="color:var(--accent-cyan);">📋 Ad Set ${idx + 1}: ${aud.name}</h4>
                        <div class="flex gap-2 mt-2" style="flex-wrap:wrap;">
                            <span class="badge badge-info">📍 ${(aud.locations || []).join(', ') || 'India'}</span>
                            <span class="badge badge-info">👤 ${aud.ageMin || 18}-${aud.ageMax || 65}</span>
                            <span class="badge badge-info">⚧ ${aud.gender || 'All'}</span>
                            <span class="badge badge-info">🎯 ${(aud.interests || []).map(i => i.name || i).join(', ') || 'Broad'}</span>
                        </div>
                    `;
                    detailContainer.appendChild(card);
                });
            }
        },

        createCampaign: async function() {
            const btn = document.getElementById('btn-create-campaign');
            const statusDiv = document.getElementById('creation-status');
            const statusText = document.getElementById('creation-status-text');
            
            if (btn) {
                btn.disabled = true;
                btn.textContent = '⏳ Creating...';
            }
            if (statusDiv) statusDiv.style.display = 'block';

            try {
                // Compile final payload
                const payload = {
                    campaign: this.campaignData.step1,
                    adsets: this.campaignData.step2,
                    creative: this.campaignData.step3
                };

                if (statusText) statusText.textContent = 'Creating campaign on Facebook...';
                
                const result = await window.API.createCampaign(payload);
                
                if (statusText) statusText.textContent = '✅ Campaign created successfully!';
                window.AppController.showToast('Campaign created successfully! 🎉', 'success');
                
                // Show result modal
                const resultBody = document.getElementById('modal-result-body');
                const resultTitle = document.getElementById('modal-result-title');
                if (resultTitle) resultTitle.textContent = '🎉 Campaign Created!';
                if (resultBody) {
                    resultBody.innerHTML = `
                        <div style="text-align:center; padding:1rem;">
                            <p style="font-size:3rem; margin-bottom:1rem;">✅</p>
                            <h3>Campaign "${this.campaignData.step1.name}" created!</h3>
                            <p class="mt-2" style="color:var(--text-secondary);">Campaign ID: ${result.campaignId || 'Created'}</p>
                            <p style="color:var(--text-secondary);">Ad Sets: ${result.adSetIds?.length || this.campaignData.step2.audiences?.length || 0}</p>
                            <p style="color:var(--text-secondary);">Ads: ${result.adIds?.length || 'Created'}</p>
                        </div>
                    `;
                }
                window.AppController.openModal('modal-result');

                // Refresh recent campaigns
                window.AppController.loadRecentCampaigns();

            } catch (error) {
                if (statusText) statusText.textContent = '❌ Failed: ' + error.message;
                window.AppController.showToast('Failed to create campaign: ' + error.message, 'error');
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '🚀 Create Campaign';
                }
            }
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        CampaignWizard.init();
    });
})();
