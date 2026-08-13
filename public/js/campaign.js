// public/js/campaign.js
(function() {
    const CampaignWizard = {
        currentStep: 1,
        totalSteps: 4,
        _customAudiences: [],   // cached after account change
        _step2DefaultsLoaded: false,
        campaignData: {
            step1: {},
            step2: { audiences: [] },
            step3: { ads: [], headline: '', description: '', cta: 'SHOP_NOW', pageId: '', instagramId: '', enhancements: {} }
        },
        _copyAutoFilledForUrl: '',
        _autoFilledCopy: { headline: '', description: '', primaryText: '' },
        _creationDraftId: '',
        _retryState: null,
        _accountEnhancements: {},   // { [accountId]: { key: bool, ... } }
        _currentAccountId: null,    // track which account is active

        // Colour/label metadata for each targeting type
        TYPE_META: {
            interest:       { label: 'Interest',        color: '#4361ee' },
            behavior:       { label: 'Behavior',        color: '#f77f00' },
            demographic:    { label: 'Demographic',     color: '#2d9e5f' },
            life_event:     { label: 'Life Event',      color: '#9b5de5' },
            job_title:      { label: 'Job Title',       color: '#e63946' },
            employer:       { label: 'Employer',        color: '#0096c7' },
            field_of_study: { label: 'Field of Study',  color: '#e9c46a' },
            school:         { label: 'School',          color: '#e76f51' }
        },

        init: function() {
            this.bindEvents();
            this.setDefaultDateTime();
            this.setupGlobalAudienceTags();
            
            const loadAll = () => {
                this.populateAccountSelect();
                this.updateAudienceCards();
                this.loadSavedAudiencesDropdown();
            };

            if (window.APP && window.APP.accounts && window.APP.accounts.length > 0) {
                loadAll();
            }

            document.addEventListener('appReady', () => {
                loadAll();
            });
            document.addEventListener('accountChanged', (e) => {
                this.handleAccountChange(e.detail);
            });
        },

        setDefaultDateTime: function() {
            const startInput = document.getElementById('schedule-start');
            if (startInput) {
                const now = new Date();
                const pad = n => String(n).padStart(2, '0');
                
                let year = now.getFullYear();
                let month = now.getMonth() + 1;
                let date = now.getDate();
                
                if (now.getHours() > 23 || (now.getHours() === 23 && now.getMinutes() >= 55)) {
                    const tomorrow = new Date(now);
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    year = tomorrow.getFullYear();
                    month = tomorrow.getMonth() + 1;
                    date = tomorrow.getDate();
                }
                
                const defaultVal = `${year}-${pad(month)}-${pad(date)} 23:55`;
                
                if (window.flatpickr) {
                    window.flatpickr(startInput, {
                        enableTime: true,
                        dateFormat: "Y-m-d H:i",
                        time_24hr: true,
                        defaultDate: defaultVal,
                        allowInput: true
                    });
                } else {
                    startInput.value = `${year}-${pad(month)}-${pad(date)}T23:55`;
                }
            }
        },

        // ── Wire global audience settings ────────────────────────────────
        setupGlobalAudienceTags: function() {
            const self = this;

            // Location search helper (connected to FB API)
            function wireLocationSearch(inputId, tagsContainerId, dropdownId) {
                const input = document.getElementById(inputId);
                const dropdown = document.getElementById(dropdownId);
                const container = document.getElementById(tagsContainerId);
                if (!input || !dropdown || !container) return;

                let timer;
                input.addEventListener('input', () => {
                    clearTimeout(timer);
                    const q = input.value.trim();
                    if (q.length < 2) { dropdown.style.display = 'none'; return; }
                    timer = setTimeout(async () => {
                        try {
                            const results = await window.API.searchLocations(q);
                            self._renderLocationDropdown(dropdown, container, input, results || []);
                        } catch { dropdown.style.display = 'none'; }
                    }, 400);
                });
                input.addEventListener('blur', () => { setTimeout(() => dropdown.style.display = 'none', 200); });
                document.addEventListener('click', (e) => {
                    if (!container.contains(e.target)) dropdown.style.display = 'none';
                });
            }

            wireLocationSearch('loc-include-search', 'location-include-tags', 'loc-include-dropdown');
            wireLocationSearch('loc-exclude-search', 'location-exclude-tags', 'loc-exclude-dropdown');

            // Languages search helper (calls API to get locales matching text)
            function wireLanguageSearch(inputId, tagsContainerId, dropdownId) {
                const input = document.getElementById(inputId);
                const dropdown = document.getElementById(dropdownId);
                const container = document.getElementById(tagsContainerId);
                if (!input || !dropdown || !container) return;

                let timer = null;
                input.addEventListener('input', () => {
                    clearTimeout(timer);
                    const q = input.value.trim();
                    if (!q) { dropdown.style.display = 'none'; return; }
                    timer = setTimeout(async () => {
                        try {
                            const results = await window.API.searchLanguages(q);
                            self._renderLanguageDropdown(dropdown, container, input, results || []);
                        } catch { dropdown.style.display = 'none'; }
                    }, 400);
                });
                input.addEventListener('blur', () => { setTimeout(() => dropdown.style.display = 'none', 200); });
                document.addEventListener('click', (e) => {
                    if (!container.contains(e.target)) dropdown.style.display = 'none';
                });
            }

            wireLanguageSearch('lang-search', 'language-tags', 'lang-dropdown');

            // Custom / Lookalike audience search helper (from cached API data)
            function wireAudienceSearch(inputId, tagsContainerId, dropdownId, audienceType) {
                const input = document.getElementById(inputId);
                const dropdown = document.getElementById(dropdownId);
                const container = document.getElementById(tagsContainerId);
                if (!input || !dropdown || !container) return;

                input.addEventListener('focus', () => self._renderAudienceDropdown(dropdown, container, input, audienceType, ''));
                input.addEventListener('input', () => self._renderAudienceDropdown(dropdown, container, input, audienceType, input.value.trim()));
                input.addEventListener('blur', () => { setTimeout(() => dropdown.style.display = 'none', 200); });
                document.addEventListener('click', (e) => {
                    if (!container.contains(e.target)) dropdown.style.display = 'none';
                });
            }

            wireAudienceSearch('custom-include-search', 'custom-include-tags', 'custom-include-dropdown', 'custom');
            wireAudienceSearch('custom-exclude-search', 'custom-exclude-tags', 'custom-exclude-dropdown', 'custom');
            wireAudienceSearch('lookalike-include-search', 'lookalike-include-tags', 'lookalike-include-dropdown', 'lookalike');
            wireAudienceSearch('lookalike-exclude-search', 'lookalike-exclude-tags', 'lookalike-exclude-dropdown', 'lookalike');
        },

        _renderLocationDropdown: function(dropdown, container, input, results) {
            dropdown.innerHTML = '';
            if (!results.length) { dropdown.style.display = 'none'; return; }
            const typeIcon = { country: '🌍', region: '📍', city: '🏙️', zip: '📮' };
            results.slice(0, 15).forEach(r => {
                const item = document.createElement('div');
                item.style.cssText = 'padding:0.6rem 1rem; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.05); display:flex; gap:0.6rem; align-items:flex-start;';
                item.innerHTML = `<span style="margin-top:2px;">${typeIcon[r.type] || '📍'}</span>
                    <div><div style="font-weight:600;">${r.name}</div>
                    <div style="font-size:0.72rem; color:var(--text-secondary);">${r.type}${r.country_code && r.type !== 'country' ? ' · ' + r.country_code : ''}</div></div>`;
                item.addEventListener('mouseenter', () => item.style.background = 'rgba(67,97,238,0.2)');
                item.addEventListener('mouseleave', () => item.style.background = 'transparent');
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    this._addLocationTag(container, input, r);
                    dropdown.style.display = 'none';
                });
                dropdown.appendChild(item);
            });
            dropdown.style.display = 'block';
        },

        _addLocationTag: function(container, inputEl, r) {
            const tag = document.createElement('span');
            tag.className = 'tag location-tag';
            tag.setAttribute('data-key', r.key || r.country_code || '');
            tag.setAttribute('data-type', r.type || 'region');
            tag.setAttribute('data-name', r.name);
            tag.setAttribute('data-value', r.name);
            const ico = { country: '🌍', region: '📍', city: '🏙️' }[r.type] || '📍';
            tag.innerHTML = `${r.name} ${ico} <span class="tag-remove" onclick="this.parentElement.remove()">✖</span>`;
            container.insertBefore(tag, inputEl);
            if (inputEl) inputEl.value = '';
        },

        _renderLanguageDropdown: function(dropdown, container, input, results) {
            dropdown.innerHTML = '';
            if (!results.length) { dropdown.style.display = 'none'; return; }
            results.slice(0, 15).forEach(r => {
                const item = document.createElement('div');
                item.style.cssText = 'padding:0.6rem 1rem; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.05); display:flex; gap:0.6rem; align-items:center;';
                item.innerHTML = `<span style="margin-top:2px;">🗣️</span>
                    <div><div style="font-weight:600;">${r.name}</div></div>`;
                item.addEventListener('mouseenter', () => item.style.background = 'rgba(67,97,238,0.2)');
                item.addEventListener('mouseleave', () => item.style.background = 'transparent');
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    this._addLanguageTag(container, input, r);
                    dropdown.style.display = 'none';
                });
                dropdown.appendChild(item);
            });
            dropdown.style.display = 'block';
        },

        _addLanguageTag: function(container, inputEl, r) {
            const tag = document.createElement('span');
            tag.className = 'tag language-tag';
            tag.setAttribute('data-key', r.key || r.id || '');
            tag.setAttribute('data-value', r.name);
            tag.innerHTML = `${r.name} 🗣️ <span class="tag-remove" onclick="this.parentElement.remove()">✖</span>`;
            container.insertBefore(tag, inputEl);
            if (inputEl) inputEl.value = '';
        },

        _renderAudienceDropdown: function(dropdown, container, input, audienceType, query) {
            const all = this._customAudiences || [];
            let list = all.filter(a => {
                const isLA = a.subtype === 'LOOKALIKE';
                if (audienceType === 'lookalike' && !isLA) return false;
                if (audienceType === 'custom' && isLA) return false;
                if (query && !a.name.toLowerCase().includes(query.toLowerCase())) return false;
                return true;
            });

            dropdown.innerHTML = '';
            if (!list.length) {
                dropdown.innerHTML = `<div style="padding:0.85rem 1rem; color:var(--text-secondary); font-size:0.82rem;">${all.length === 0 ? '⚠️ Select an account — audiences load automatically' : 'No matching audiences'}</div>`;
                dropdown.style.display = 'block';
                return;
            }
            list.slice(0, 20).forEach(a => {
                const item = document.createElement('div');
                item.style.cssText = 'padding:0.6rem 1rem; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.05);';
                const cnt = a.approximate_count_lower_bound ? ` (~${Number(a.approximate_count_lower_bound).toLocaleString()})` : '';
                item.innerHTML = `<div style="font-weight:600;">${a.name}</div><div style="font-size:0.72rem;color:var(--text-secondary);">${a.subtype}${cnt}</div>`;
                item.addEventListener('mouseenter', () => item.style.background = 'rgba(67,97,238,0.2)');
                item.addEventListener('mouseleave', () => item.style.background = 'transparent');
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    const tag = document.createElement('span');
                    tag.className = 'tag audience-tag';
                    tag.setAttribute('data-value', a.id);
                    tag.setAttribute('data-name', a.name);
                    tag.innerHTML = `${a.name} <span class="tag-remove" onclick="this.parentElement.remove()">✖</span>`;
                    container.insertBefore(tag, input);
                    input.value = '';
                    dropdown.style.display = 'none';
                });
                dropdown.appendChild(item);
            });
            dropdown.style.display = 'block';
        },

        // Pre-populate exclude tags from settings defaults (once per session)
        loadDefaultExcludedLocations: function() {
            if (this._step2DefaultsLoaded) return;
            this._step2DefaultsLoaded = true;

            const defaults = (window.APP.settings || {}).defaultExcludedLocations || [];
            if (!defaults.length) return;

            const container = document.getElementById('location-exclude-tags');
            const inputEl = document.getElementById('loc-exclude-search');
            if (!container) return;

            // Only pre-fill if the user hasn't added anything yet
            const existing = container.querySelectorAll('.location-tag');
            if (existing.length > 0) return;

            defaults.forEach(loc => {
                const tag = document.createElement('span');
                tag.className = 'tag location-tag';
                tag.setAttribute('data-key', loc.key || '');
                tag.setAttribute('data-type', loc.type || 'region');
                tag.setAttribute('data-name', loc.name);
                tag.setAttribute('data-value', loc.name);
                tag.innerHTML = `${loc.name} 📍 <span class="tag-remove" onclick="this.parentElement.remove()">✖</span>`;
                container.insertBefore(tag, inputEl);
            });
        },

        // ── Bind global events ───────────────────────────────────────────
        bindEvents: function() {
            const btnNext = document.getElementById('btn-next-step');
            const btnPrev = document.getElementById('btn-prev-step');
            const btnCreate = document.getElementById('btn-create-campaign');

            if (btnNext) btnNext.addEventListener('click', () => this.nextStep());
            if (btnPrev) btnPrev.addEventListener('click', () => this.prevStep());
            if (btnCreate) btnCreate.addEventListener('click', () => this.createCampaign());

            const numAdsets = document.getElementById('num-adsets');
            if (numAdsets) numAdsets.addEventListener('change', () => this.updateAudienceCards());

            // Dynamic count updates for exclusions
            const updateExclusionsCount = () => {
                const locationCount = document.querySelectorAll('#location-exclude-tags .location-tag').length;
                const customCount = document.querySelectorAll('#custom-exclude-tags .audience-tag').length;
                const lookalikeCount = document.querySelectorAll('#lookalike-exclude-tags .audience-tag').length;
                const total = locationCount + customCount + lookalikeCount;

                const locLabel = document.getElementById('location-exclude-label');
                if (locLabel) locLabel.innerHTML = `🚫 Exclude Locations <span style="background: var(--accent-red); color: white; padding: 2px 8px; border-radius: 20px; font-size: 0.75rem; margin-left: 6px;">${locationCount}</span>`;

                const customLabel = document.getElementById('custom-exclude-label');
                if (customLabel) customLabel.innerHTML = `❌ Exclude Custom Audiences <span style="background: var(--accent-red); color: white; padding: 2px 8px; border-radius: 20px; font-size: 0.75rem; margin-left: 6px;">${customCount}</span>`;

                const lookalikeLabel = document.getElementById('lookalike-exclude-label');
                if (lookalikeLabel) lookalikeLabel.innerHTML = `❌ Exclude Lookalike Audiences <span style="background: var(--accent-red); color: white; padding: 2px 8px; border-radius: 20px; font-size: 0.75rem; margin-left: 6px;">${lookalikeCount}</span>`;

                return { total, locationCount, customCount, lookalikeCount };
            };

            // Bind click listeners on exclusion boxes to show counts
            ['location-exclude-tags', 'custom-exclude-tags', 'lookalike-exclude-tags'].forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('click', () => {
                        setTimeout(() => {
                            const { total, locationCount, customCount, lookalikeCount } = updateExclusionsCount();
                            window.AppController.showToast(`Selected Exclusions: Total: ${total} (Locations: ${locationCount}, Custom: ${customCount}, Lookalike: ${lookalikeCount})`, 'info');
                        }, 80);
                    });
                }
            });

            // Initial count calculation when entering Step 2 or on action clicks
            document.addEventListener('click', (e) => {
                if (e.target.closest('#btn-next-step') || e.target.closest('.step-indicator') || e.target.closest('.tag-remove') || e.target.closest('.interest-dropdown div')) {
                    setTimeout(updateExclusionsCount, 250);
                }
            });

            // ── Enhancement toggle buttons ────────────────────────────────
            document.querySelectorAll('.enhancement-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    btn.classList.toggle('active');
                    const activeKeys = Array.from(document.querySelectorAll('.enhancement-btn.active'))
                        .map(b => b.getAttribute('data-key'));
                    const hint = document.getElementById('enhancements-desc-hint');
                    if (hint) {
                        hint.textContent = activeKeys.length
                            ? `${activeKeys.length} enhancement${activeKeys.length > 1 ? 's' : ''} enabled — will be applied to all ads.`
                            : 'Select any enhancements to enable them on all ads.';
                    }
                });
            });

            const btnAddAdset = document.getElementById('btn-add-adset');
            if (btnAddAdset) {
                btnAddAdset.addEventListener('click', () => {
                    const n = document.getElementById('num-adsets');
                    if (n) { n.value = parseInt(n.value) + 1; this.updateAudienceCards(); }
                });
            }

            const btnAiAll = document.getElementById('btn-ai-all-audiences');
            if (btnAiAll) btnAiAll.addEventListener('click', () => this.aiGenerateAllAudiences());

            const dropZone = document.getElementById('media-upload-zone');
            const fileInput = document.getElementById('media-file-input');
            if (dropZone && fileInput) {
                dropZone.addEventListener('click', () => fileInput.click());
                dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--accent-blue)'; });
                dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = ''; });
                dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.style.borderColor = ''; if (e.dataTransfer.files.length) this.handleMediaUpload(Array.from(e.dataTransfer.files)); });
                fileInput.addEventListener('change', (e) => { if (e.target.files.length) this.handleMediaUpload(Array.from(e.target.files)); e.target.value = ''; });
            }

            // Campaign media URL list management
            const btnCampaignAddRow = document.getElementById('btn-campaign-add-url-row');
            const campaignUrlList = document.getElementById('campaign-media-url-list');
            if (btnCampaignAddRow && campaignUrlList) {
                btnCampaignAddRow.addEventListener('click', () => {
                    const row = document.createElement('div');
                    row.className = 'flex gap-2 mb-1 campaign-video-url-row';
                    row.style.cssText = 'display:flex; gap:8px; margin-bottom:8px; align-items:center;';
                    row.innerHTML = `
                        <input type="text" class="form-control campaign-video-url-input" placeholder="Or paste video link (FB Ads Library, YouTube, Insta, Pinterest…)" style="flex:1;">
                        <button type="button" class="btn btn-secondary btn-sm btn-remove-campaign-url-row" style="padding:4px 8px;">🗑️</button>
                    `;
                    campaignUrlList.appendChild(row);

                    row.querySelector('.btn-remove-campaign-url-row').addEventListener('click', () => {
                        row.remove();
                    });
                });
            }

            const btnCampaignMediaDownload = document.getElementById('btn-campaign-media-url-download');
            if (btnCampaignMediaDownload) {
                btnCampaignMediaDownload.addEventListener('click', () => this.handleVideoUrlDownload());
            }

            // Campaign name → auto-switch ABO/CBO with animation
            const campaignNameInput = document.getElementById('campaign-name');
            if (campaignNameInput) {
                campaignNameInput.addEventListener('input', () => {
                    const val = campaignNameInput.value.toUpperCase();
                    const hasABO = val.includes('ABO');
                    const hasCBO = val.includes('CBO');
                    if (!hasABO && !hasCBO) return;

                    const aboRadio = document.getElementById('budget-type-abo');
                    const cboRadio = document.getElementById('budget-type-cbo');
                    const aboCard = aboRadio?.closest('.radio-card');
                    const cboCard = cboRadio?.closest('.radio-card');

                    const targetRadio  = hasABO ? aboRadio  : cboRadio;
                    const targetCard   = hasABO ? aboCard   : cboCard;
                    const otherCard    = hasABO ? cboCard   : aboCard;

                    if (!targetRadio || targetRadio.checked) return;
                    targetRadio.checked = true;
                    targetRadio.dispatchEvent(new Event('change', { bubbles: true }));

                    // Flash animation on the newly selected card
                    [aboCard, cboCard].forEach(c => c && c.classList.remove('budget-type-flash'));
                    if (targetCard) {
                        void targetCard.offsetWidth; // force reflow
                        targetCard.classList.add('budget-type-flash');
                        targetCard.addEventListener('animationend', () => targetCard.classList.remove('budget-type-flash'), { once: true });
                    }
                });
            }

            const btnAutoFill = document.getElementById('btn-auto-fill-copy');
            if (btnAutoFill) btnAutoFill.addEventListener('click', () => this.autoFillCreativeCopy());
            const btnAddAd = document.getElementById('btn-add-creative-ad');
            if (btnAddAd) btnAddAd.addEventListener('click', () => this.addCreativeAd());

            const campaignAccount = document.getElementById('campaign-account-select');
            if (campaignAccount) {
                campaignAccount.addEventListener('change', e => {
                    const account = window.APP.accounts.find(item => item.id === e.target.value);
                    if (account) {
                        window.APP.activeAccount = account;
                        this.handleAccountChange(account);
                    }
                });
            }

            // Save targeting template
            const btnSaveTargeting = document.getElementById('btn-save-current-targeting');
            if (btnSaveTargeting) {
                btnSaveTargeting.addEventListener('click', () => this.saveCurrentTargeting());
            }

            // Load saved targeting template
            const selectSavedAudience = document.getElementById('load-saved-audience-select');
            if (selectSavedAudience) {
                selectSavedAudience.addEventListener('change', (e) => this.loadTargetingTemplate(e.target.value));
            }
        },

        // ── Step navigation ──────────────────────────────────────────────
        updateStepUI: function() {
            for (let i = 1; i <= this.totalSteps; i++) {
                const stepEl = document.getElementById(`step-${i}`);
                if (stepEl) stepEl.classList.toggle('active', i === this.currentStep);
                const ind = document.getElementById(`step-indicator-${i}`);
                if (ind) {
                    ind.classList.remove('active', 'completed');
                    if (i < this.currentStep) ind.classList.add('completed');
                    else if (i === this.currentStep) ind.classList.add('active');
                }
            }
            const btnNext = document.getElementById('btn-next-step');
            const btnPrev = document.getElementById('btn-prev-step');
            if (btnPrev) btnPrev.style.display = this.currentStep > 1 ? 'inline-flex' : 'none';
            if (btnNext) btnNext.style.display = this.currentStep < this.totalSteps ? 'inline-flex' : 'none';

            // Creative initialization happens on entering step 2 (Ad Creative)
            if (this.currentStep === 2) {
                if (this.campaignData.step3.ads.length === 0) this.addCreativeAd();
                this.ensureCreativeCopyLoaded();
            }
            // Pre-populate default excluded locations on first entry to step 3 (Targeting)
            if (this.currentStep === 3) this.loadDefaultExcludedLocations();
            if (this.currentStep === this.totalSteps) this.renderReviewSummary();
        },

        validateStep: function(step) {
            if (step === 1) {
                const name = document.getElementById('campaign-name')?.value?.trim();
                const budgetAmount = document.getElementById('budget-amount')?.value;
                const start = document.getElementById('schedule-start')?.value;
                const account = document.getElementById('campaign-account-select')?.value;

                if (!name) { window.AppController.showToast('Campaign name is required', 'warning'); return false; }
                if (!budgetAmount || budgetAmount <= 0) { window.AppController.showToast('Please enter a valid budget amount', 'warning'); return false; }
                if (!start) { window.AppController.showToast('Please set a start date', 'warning'); return false; }
                if (!account) { window.AppController.showToast('Please select an ad account', 'warning'); return false; }

                // Convert "YYYY-MM-DD HH:mm" local time to UTC ISO string so the
                // backend receives an unambiguous timestamp regardless of server timezone.
                function localDateStrToUtcIso(str) {
                    if (!str) return '';
                    // Already a full ISO string with timezone — pass through
                    if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(str)) return str;
                    // "YYYY-MM-DD HH:mm" or "YYYY-MM-DDTHH:mm"
                    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[\sT](\d{2}):(\d{2})(?::(\d{2}))?/);
                    if (!m) return str;
                    const [, yr, mo, dy, hr, mn, sc] = m;
                    const d = new Date(+yr, +mo - 1, +dy, +hr, +mn, +(sc || 0));
                    return isNaN(d.getTime()) ? str : d.toISOString();
                }
                const endRaw = document.getElementById('schedule-end')?.value || '';
                this.campaignData.step1 = {
                    name,
                    objective: document.getElementById('campaign-objective')?.value,
                    budgetType: document.getElementById('budget-type-cbo')?.checked ? 'CBO' : 'ABO',
                    budgetAmount: parseFloat(budgetAmount),
                    scheduleStart: localDateStrToUtcIso(start),
                    scheduleEnd: localDateStrToUtcIso(endRaw),
                    accountId: account,
                    specialAdCategory: document.getElementById('camp-special')?.value || 'NONE'
                };
                return true;

            } else if (step === 2) {
                // Validate Campaign settings first (now in Step 2)
                const url = document.getElementById('website-url')?.value?.trim();
                if (!url) { window.AppController.showToast('Please enter a Website URL', 'warning'); return false; }

                const pixel = document.getElementById('pixel-select')?.value;
                const optGoal = document.getElementById('optimization-goal')?.value || 'OFFSITE_CONVERSIONS';
                if (optGoal === 'OFFSITE_CONVERSIONS' && !pixel) {
                    window.AppController.showToast('Please select a Meta Pixel for Conversion tracking', 'warning');
                    return false;
                }

                // Gathers website/pixel settings
                this.campaignData.step2 = {
                    url,
                    pixel: pixel || '',
                    optimizationGoal: optGoal,
                    conversionEvent: document.getElementById('conversion-event')?.value || 'PURCHASE',
                    audiences: this.campaignData.step2?.audiences || []
                };

                // Validate Creative fields
                this.collectCreativeAdsFromDOM();
                if (this.campaignData.step3.ads.length === 0) {
                    window.AppController.showToast('Please add at least one media/ad card', 'warning');
                    return false;
                }
                if (!document.getElementById('ad-page')?.value) {
                    window.AppController.showToast('Please select a Facebook Page', 'warning');
                    return false;
                }
                if (this.campaignData.step3.ads.some(ad => !ad.media)) {
                    window.AppController.showToast('Please upload media for every ad card', 'warning');
                    return false;
                }
                if (this.campaignData.step3.ads.some(ad => !ad.primaryText.trim())) {
                    window.AppController.showToast('Please add primary text for every ad', 'warning');
                    return false;
                }
                this.campaignData.step3.headline = document.getElementById('headline')?.value?.trim() || '';
                this.campaignData.step3.description = document.getElementById('description')?.value?.trim() || '';
                this.campaignData.step3.cta = document.getElementById('cta-select')?.value || 'SHOP_NOW';
                this.campaignData.step3.pageId = document.getElementById('ad-page')?.value || '';
                this.campaignData.step3.instagramId = document.getElementById('ad-instagram')?.value || '';

                // Collect selected enhancements
                const enhancements = {};
                document.querySelectorAll('.enhancement-btn.active').forEach(btn => {
                    const key = btn.getAttribute('data-key');
                    if (key) enhancements[key] = true;
                });
                this.campaignData.step3.enhancements = enhancements;
                return true;

            } else if (step === 3) {
                // Read Global settings — structured location tags
                const readLocTags = (selector) => {
                    const items = [];
                    document.querySelectorAll(selector).forEach(tag => {
                        items.push({
                            key: tag.getAttribute('data-key') || '',
                            name: tag.getAttribute('data-name') || tag.getAttribute('data-value') || '',
                            type: tag.getAttribute('data-type') || 'country'
                        });
                    });
                    return items;
                };
                const globalLocInclude = readLocTags('#location-include-tags .location-tag');
                const globalLocExclude = readLocTags('#location-exclude-tags .location-tag');
                const globalAgeMin = parseInt(document.getElementById('global-age-min')?.value) || 18;
                const globalAgeMax = parseInt(document.getElementById('global-age-max')?.value) || 65;
                const globalGender = document.querySelector('input[name="global-gender"]:checked')?.value || 'all';

                const customInclude = [];
                document.querySelectorAll('#custom-include-tags .audience-tag').forEach(t => customInclude.push(t.getAttribute('data-value')));
                const customExclude = [];
                document.querySelectorAll('#custom-exclude-tags .audience-tag').forEach(t => customExclude.push(t.getAttribute('data-value')));
                const lookalikeInclude = [];
                document.querySelectorAll('#lookalike-include-tags .audience-tag').forEach(t => lookalikeInclude.push(t.getAttribute('data-value')));
                const lookalikeExclude = [];
                document.querySelectorAll('#lookalike-exclude-tags .audience-tag').forEach(t => lookalikeExclude.push(t.getAttribute('data-value')));

                const globalLanguages = [];
                document.querySelectorAll('#language-tags .language-tag').forEach(t => {
                    globalLanguages.push({
                        key: t.getAttribute('data-key'),
                        name: t.getAttribute('data-value')
                    });
                });

                // Per-card targeting (all types: interests, behaviors, demographics, job titles, etc.)
                const audienceCards = document.querySelectorAll('.audience-card');
                const audiences = [];
                audienceCards.forEach((card, idx) => {
                    const targeting = [];
                    card.querySelectorAll('.interest-tag').forEach(tag => {
                        targeting.push({
                            id:   tag.getAttribute('data-id') || '',
                            name: tag.getAttribute('data-value') || tag.textContent.replace('✖','').trim(),
                            type: tag.getAttribute('data-type') || 'interest'
                        });
                    });
                    const adsetName = targeting.slice(0, 3).map(i => i.name).join(', ') || `Audience ${idx + 1}`;
                    audiences.push({
                        name: adsetName,
                        locationsInclude: globalLocInclude.length > 0 ? globalLocInclude : [{ key: 'IN', type: 'country', name: 'India' }],
                        locationsExclude: globalLocExclude,
                        ageMin: globalAgeMin,
                        ageMax: globalAgeMax,
                        gender: globalGender,
                        languages: globalLanguages,
                        customAudiencesInclude: customInclude,
                        customAudiencesExclude: customExclude,
                        lookalikeInclude,
                        lookalikeExclude,
                        targeting
                    });
                });

                // Update audiences list on step2 object
                if (!this.campaignData.step2) {
                    this.campaignData.step2 = {};
                }
                this.campaignData.step2.audiences = audiences;
                return true;
            }
            return true;
        },

        collectCreativeAdsFromDOM: function() {
            const container = document.getElementById('creative-ads-container');
            if (!container) return;
            const existingAds = this.campaignData.step3.ads || [];
            this.campaignData.step3.ads = Array.from(container.querySelectorAll('.creative-ad-card')).map((card, index) => {
                const existing = existingAds[index] || {};
                const textField = card.querySelector('.creative-primary-text');
                return {
                    ...existing,
                    media: card.getAttribute('data-media') || existing.media || '',
                    mediaFile: card.getAttribute('data-media-file') || existing.mediaFile || '',
                    // Keep the object-URL preview and uploaded thumbnail when
                    // moving between steps or re-rendering after Gemini.
                    previewUrl: existing.previewUrl || '',
                    thumbnail: existing.thumbnail || '',
                    thumbnailFile: existing.thumbnailFile || '',
                    thumbnailPreviewUrl: existing.thumbnailPreviewUrl || '',
                    primaryText: textField ? textField.value.trim() : (existing.primaryText || '')
                };
            });
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

        // ── Account handling ─────────────────────────────────────────────
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

        getCurrencySymbol: function(account) {
            if (!account) return '₹';
            const cur = (account.currency || '').toUpperCase();
            if (cur === 'USD') return '$';
            if (cur === 'EUR') return '€';
            if (cur === 'GBP') return '£';
            if (cur === 'INR') return '₹';
            // Check account label for currency hint
            const label = (account.label || '').toLowerCase();
            if (label.includes('usd') || label.includes('$')) return '$';
            return '₹'; // Default to INR
        },

        applyEnhancements: function(features) {
            // features = { advantageAudience: bool, multiAdvertiser: bool, ... }
            document.querySelectorAll('.enhancement-btn').forEach(btn => {
                const key = btn.getAttribute('data-key');
                if (!key || key === 'autoMusic') return; // autoMusic is always hidden
                const supported = features[key] !== false; // default to true if key not in response
                btn.style.display = supported ? '' : 'none';
                // Deactivate hidden buttons so they don't get submitted
                if (!supported) btn.classList.remove('active');
            });
            // Refresh hint text
            const activeKeys = Array.from(document.querySelectorAll('.enhancement-btn.active'))
                .map(b => b.getAttribute('data-key'));
            const hint = document.getElementById('enhancements-desc-hint');
            if (hint) {
                hint.textContent = activeKeys.length
                    ? `${activeKeys.length} enhancement${activeKeys.length > 1 ? 's' : ''} enabled — will be applied to all ads.`
                    : 'Select any enhancements to enable them on all ads.';
            }
        },

        handleAccountChange: async function(account) {
            if (!account) return;

            // Fetch supported enhancements for this account and update the UI
            const accountId = account.accountId || account.id;
            if (accountId) {
                try {
                    const features = await window.API.getAccountFeatures(accountId);
                    this._accountEnhancements[accountId] = features;
                    this.applyEnhancements(features);
                } catch (e) {
                    console.warn('Could not load account features:', e.message);
                }
            }

            // Update timezone label near datetime input
            const tzLabel = document.getElementById('schedule-timezone-label');
            if (tzLabel) {
                tzLabel.textContent = account.timezone_name ? `⏱ Account timezone: ${account.timezone_name}` : '';
            }

            // Update currency symbol display
            const symbol = this.getCurrencySymbol(account);
            document.querySelectorAll('.currency-symbol').forEach(el => { el.textContent = symbol; });
            const budgetInput = document.getElementById('budget-amount');
            if (budgetInput) {
                if (symbol === '$') {
                    budgetInput.value = '50';
                } else if (symbol === '₹') {
                    budgetInput.value = '500';
                }
            }

            // Fetch pixels
            const pixelSelect = document.getElementById('pixel-select');
            if (pixelSelect) {
                pixelSelect.innerHTML = '<option value="">Loading pixels...</option>';
                try {
                    const pixels = await window.API.getPixels(account.accountId || account.id);
                    pixelSelect.innerHTML = '<option value="">Select Pixel</option>';
                    (pixels || []).forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p.id;
                        opt.textContent = p.name ? `${p.name} (${p.id})` : p.id;
                        pixelSelect.appendChild(opt);
                    });
                } catch { pixelSelect.innerHTML = '<option value="">No pixels found</option>'; }
            }

            // Fetch custom audiences and cache them
            try {
                const audiences = await window.API.getCustomAudiences(account.accountId || account.id);
                this._customAudiences = audiences || [];
                const statusEl = document.getElementById('custom-load-status');
                if (statusEl) statusEl.textContent = `${this._customAudiences.length} audiences loaded`;
            } catch (err) {
                this._customAudiences = [];
                console.log('Could not load custom audiences:', err.message);
            }

            // Fetch pages + Instagram
            const pageSelect = document.getElementById('ad-page');
            const igSelect = document.getElementById('ad-instagram');
            if ((pageSelect || igSelect) && account.id) {
                if (pageSelect) pageSelect.innerHTML = '<option value="">Loading pages...</option>';
                if (igSelect) igSelect.innerHTML = '<option value="">Loading...</option>';
                try {
                    const result = await window.API.getAllPages();
                    const pages = result.pages || [];
                    if (pageSelect) pageSelect.innerHTML = '<option value="">Select Facebook Page</option>';
                    if (igSelect) igSelect.innerHTML = '<option value="">No Instagram linked</option>';
                    pages.forEach(page => {
                        const pageBelongsToAccount = !page.accountIds || page.accountIds.includes(account.id) || page.accountId === account.id;
                        if (!pageBelongsToAccount) return; // hide pages not linked to this ad account
                        if (pageSelect) {
                            const opt = document.createElement('option');
                            opt.value = page.id;
                            opt.textContent = page.name || page.id;
                            pageSelect.appendChild(opt);
                        }
                        if (igSelect && page.instagram_business_account) {
                            const ig = page.instagram_business_account;
                            const o = document.createElement('option');
                            o.value = ig.id;
                            o.textContent = `@${ig.username || ig.name || ig.id}`;
                            igSelect.appendChild(o);
                        }
                    });
                    // Auto-select page and matching Instagram
                    if (pageSelect) {
                        const matchingPage = pages.find(page =>
                            page.id === account.pageId &&
                            ((!page.accountIds && page.accountId === account.id) || page.accountIds?.includes(account.id))
                        );
                        const selectedPageId = matchingPage ? account.pageId : (pages.length === 1 ? pages[0].id : '');
                        pageSelect.value = selectedPageId;

                        // Auto-select Instagram linked to the selected page
                        if (selectedPageId && igSelect) {
                            const selectedPage = pages.find(p => p.id === selectedPageId);
                            if (selectedPage?.instagram_business_account) {
                                igSelect.value = selectedPage.instagram_business_account.id;
                            }
                        }
                    }

                    // When user manually picks a page, auto-select its Instagram
                    if (pageSelect && igSelect) {
                        pageSelect.addEventListener('change', () => {
                            const pid = pageSelect.value;
                            const pg = pages.find(p => p.id === pid);
                            if (pg?.instagram_business_account) {
                                igSelect.value = pg.instagram_business_account.id;
                            } else {
                                igSelect.value = '';
                            }
                        });
                    }
                } catch {
                    if (pageSelect) pageSelect.innerHTML = '<option value="">Could not load pages</option>';
                }
            }
        },

        // ── Audience cards ────────────────────────────────────────────────
        updateAudienceCards: function() {
            const container = document.getElementById('audience-container');
            const num = parseInt(document.getElementById('num-adsets')?.value || 5, 10);
            if (!container) return;
            // Clean up body-appended dropdowns from any previous render
            document.querySelectorAll('.interest-dropdown-body').forEach(d => d.remove());
            container.innerHTML = '';

            // Colour legend
            const legendEl = document.createElement('div');
            legendEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:14px;padding:10px 14px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid rgba(255,255,255,0.07);';
            legendEl.innerHTML = Object.entries(this.TYPE_META).map(([, m]) =>
                `<span style="display:inline-flex;align-items:center;gap:5px;font-size:0.72rem;">
                    <span style="width:9px;height:9px;border-radius:50%;background:${m.color};flex-shrink:0;display:inline-block;"></span>
                    <span style="color:${m.color};font-weight:600;">${m.label}</span>
                </span>`
            ).join('');
            container.appendChild(legendEl);

            for (let i = 0; i < num; i++) this._createAudienceCard(container, i, num);
        },

        _createAudienceCard: function(container, i, total) {
            const card = document.createElement('div');
            card.className = 'glass-card audience-card mb-3';
            card.style.position = 'relative';
            card.setAttribute('data-index', i);
            card.innerHTML = `
                <div class="flex justify-between align-center mb-2">
                    <h4>🎯 Audience ${i + 1}</h4>
                    <div class="flex gap-2 align-center">
                        <button class="btn btn-gemini btn-sm btn-ai-audience" data-index="${i}" title="Gemini reads your website and picks unique targeting">🤖 AI</button>
                        ${total > 1 ? `<button class="remove-card-btn" onclick="this.closest('.audience-card').remove()"><span>✖</span></button>` : ''}
                    </div>
                </div>
                <div class="form-group" style="margin-bottom:0;">
                    <label style="font-size:0.8rem; color:var(--text-secondary);">
                        Targeting Keywords
                        <span style="font-size:0.72rem; color:var(--accent-cyan); margin-left:0.4rem;">first 3 keywords → ad set name on Facebook</span>
                    </label>
                    <div class="form-control tags-input interests-tags-${i}" style="min-height:50px; flex-wrap:wrap;">
                        <input type="text" placeholder="Search or type keyword and press Enter…" class="interest-search" data-index="${i}" style="background:transparent; border:none; color:white; outline:none; flex:1; min-width:150px;">
                    </div>
                </div>
            `;
            container.appendChild(card);

            // Dropdown appended to <body> — backdrop-filter on .glass-card creates a new stacking
            // context so any child position:absolute is clipped inside it regardless of z-index.
            // position:fixed on a body child avoids that entirely.
            const dropdown = document.createElement('div');
            dropdown.className = 'interest-dropdown-body';
            dropdown.style.cssText = [
                'display:none','position:fixed','z-index:99999',
                'background:rgba(22,22,42,0.98)','border:1px solid var(--glass-border)',
                'border-radius:8px','max-height:220px','overflow-y:auto',
                'box-shadow:0 8px 32px rgba(0,0,0,0.55)','min-width:200px'
            ].join(';');
            document.body.appendChild(dropdown);

            const tagsContainer = card.querySelector(`.interests-tags-${i}`);
            const searchInput   = card.querySelector('.interest-search');

            const positionDropdown = () => {
                const rect = tagsContainer.getBoundingClientRect();
                dropdown.style.top   = `${rect.bottom + 4}px`;
                dropdown.style.left  = `${rect.left}px`;
                dropdown.style.width = `${rect.width}px`;
            };
            const closeDropdown = () => { dropdown.style.display = 'none'; };

            card.querySelector('.btn-ai-audience').addEventListener('click', () => this.aiGenerateAudience(i));

            let debounceTimeout;
            searchInput.addEventListener('input', () => {
                clearTimeout(debounceTimeout);
                debounceTimeout = setTimeout(async () => {
                    const val = searchInput.value.trim();
                    if (val.length > 2) {
                        try {
                            const results = await window.API.searchInterests(val);
                            dropdown.innerHTML = '';
                            if (Array.isArray(results) && results.length > 0) {
                                results.forEach(r => {
                                    const type = r.type || 'interest';
                                    const meta = this.TYPE_META[type] || this.TYPE_META.interest;
                                    const item = document.createElement('div');
                                    item.style.cssText = 'padding:0.5rem 1rem;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;align-items:center;gap:0.5rem;';
                                    item.innerHTML = `<span style="font-size:0.6rem;padding:2px 7px;border-radius:4px;background:${meta.color}30;color:${meta.color};white-space:nowrap;flex-shrink:0;font-weight:700;">${meta.label}</span><span style="font-size:0.85rem;">${r.name || r}</span>`;
                                    item.addEventListener('mouseenter', () => item.style.background = 'rgba(67,97,238,0.18)');
                                    item.addEventListener('mouseleave', () => item.style.background = 'transparent');
                                    item._result = { id: r.id || '', name: r.name || r, type };
                                    item.addEventListener('mousedown', (ev) => {
                                        ev.preventDefault();
                                        this._addInterestTag(card, i, r.id || '', r.name || r, type);
                                        closeDropdown();
                                        searchInput.value = '';
                                    });
                                    dropdown.appendChild(item);
                                });
                                positionDropdown();
                                dropdown.style.display = 'block';
                            } else { closeDropdown(); }
                        } catch { closeDropdown(); }
                    } else { closeDropdown(); }
                }, 400);
            });

            // Enter key: use stored result data from first item, or add raw typed text as interest
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    clearTimeout(debounceTimeout);
                    const firstItem = dropdown.style.display !== 'none'
                        ? dropdown.querySelector('div') : null;
                    if (firstItem && firstItem._result) {
                        const { id, name, type } = firstItem._result;
                        this._addInterestTag(card, i, id, name, type);
                        closeDropdown();
                        searchInput.value = '';
                    } else {
                        const val = searchInput.value.trim();
                        if (val) {
                            this._addInterestTag(card, i, '', val, 'interest');
                            searchInput.value = '';
                            closeDropdown();
                        }
                    }
                } else if (e.key === 'Escape') {
                    closeDropdown();
                }
            });

            // Reposition on any scroll (capture catches SPA container scrolls) or resize
            const reposition = () => { if (dropdown.style.display !== 'none') positionDropdown(); };
            document.addEventListener('scroll', reposition, { capture: true, passive: true });
            window.addEventListener('resize', reposition, { passive: true });

            document.addEventListener('mousedown', (e) => {
                if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) closeDropdown();
            });

            searchInput.addEventListener('focus', () => {
                if (dropdown.children.length > 0) { positionDropdown(); dropdown.style.display = 'block'; }
            });
        },

        _addInterestTag: function(card, idx, id, name, type = 'interest') {
            const tc = card.querySelector(`.interests-tags-${idx}`);
            const input = tc?.querySelector('.interest-search');
            if (!tc || !input) return;
            const meta = this.TYPE_META[type] || this.TYPE_META.interest;
            const tag = document.createElement('span');
            tag.className = 'tag interest-tag';
            tag.setAttribute('data-id', id);
            tag.setAttribute('data-value', name);
            tag.setAttribute('data-type', type);
            tag.style.cssText = `border-left:3px solid ${meta.color};background:${meta.color}18;border-radius:6px;padding:3px 8px 3px 6px;color:#fff;display:inline-flex;align-items:center;gap:4px;`;
            tag.innerHTML = `<span style="font-size:0.58rem;font-weight:700;color:${meta.color};text-transform:uppercase;letter-spacing:0.04em;white-space:nowrap;">${meta.label}</span><span>${name}</span><span class="tag-remove" onclick="this.parentElement.remove()" style="color:rgba(255,255,255,0.35);font-size:0.7rem;cursor:pointer;margin-left:2px;">✖</span>`;
            tc.insertBefore(tag, input);
        },

        _populateAudienceCard: function(card, idx, items) {
            const tc = card.querySelector(`.interests-tags-${idx}`);
            if (!tc) return;
            tc.querySelectorAll('.interest-tag').forEach(t => t.remove());
            const input = tc.querySelector('.interest-search');
            items.forEach(item => {
                const name = typeof item === 'string' ? item : (item.name || item);
                const id   = typeof item === 'object' ? (item.id   || '') : '';
                const type = typeof item === 'object' ? (item.type || 'interest') : 'interest';
                this._addInterestTag({ querySelector: sel => tc.closest('.audience-card')?.querySelector(sel) ?? tc.parentElement?.querySelector(sel) }, idx, id, name, type);
            });
        },

        // ── AI audience generation ────────────────────────────────────────
        aiGenerateAudience: async function(cardIndex) {
            const websiteUrl = document.getElementById('website-url')?.value?.trim();
            if (!websiteUrl) { window.AppController.showToast('Enter the Website URL in Campaign Settings first', 'warning'); return; }

            const alreadyUsed = [];
            document.querySelectorAll('.audience-card').forEach(card => {
                if (parseInt(card.getAttribute('data-index')) !== cardIndex) {
                    card.querySelectorAll('.interest-tag').forEach(tag => {
                        const kw = tag.getAttribute('data-value') || tag.textContent.replace('✖','').trim();
                        if (kw) alreadyUsed.push(kw);
                    });
                }
            });

            const targetCard = document.querySelector(`.audience-card[data-index="${cardIndex}"]`);
            if (!targetCard) return;
            const btn = targetCard.querySelector('.btn-ai-audience');
            if (btn) { btn.disabled = true; btn.textContent = '⏳…'; }

            const mediaFiles = [];
            document.querySelectorAll('.creative-ad-card').forEach(card => {
                const media = card.getAttribute('data-media');
                if (media) mediaFiles.push(media);
            });

            try {
                // The backend always asks Gemini for at least three strategies.
                // This card-level action uses the first unused strategy while
                // keeping the same minimum-quality generation rules as AI All.
                const result = await window.API.aiAudiences({ websiteUrl, numAudiences: 3, alreadyUsed, mediaFiles });
                const audiences = result.audiences || [];
                if (audiences.length > 0) {
                    this._populateAudienceCard(
                        targetCard,
                        cardIndex,
                        audiences[0].targeting || audiences[0].interests || []
                    );
                    window.AppController.showToast(`Audience ${cardIndex + 1} generated ✨`, 'success');
                } else { window.AppController.showToast('No audience returned. Try again.', 'warning'); }
            } catch (error) {
                window.AppController.showToast('AI error: ' + error.message, 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '🤖 AI'; }
            }
        },

        aiGenerateAllAudiences: async function() {
            const websiteUrl = document.getElementById('website-url')?.value?.trim();
            if (!websiteUrl) { window.AppController.showToast('Enter the Website URL in Campaign Settings first', 'warning'); return; }

            let cards = document.querySelectorAll('.audience-card');
            if (!cards.length) return;

            // Always show at least three audience cards so the minimum
            // generated strategies are visible and usable in the wizard.
            if (cards.length < 3) {
                const container = document.getElementById('audience-container');
                const countInput = document.getElementById('num-adsets');
                if (container) {
                    if (countInput) countInput.value = '3';
                    for (let i = cards.length; i < 3; i++) {
                        this._createAudienceCard(container, i, 3);
                    }
                    cards = document.querySelectorAll('.audience-card');
                }
            }

            const btn = document.getElementById('btn-ai-all-audiences');
            if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }

            const mediaFiles = [];
            document.querySelectorAll('.creative-ad-card').forEach(card => {
                const media = card.getAttribute('data-media');
                if (media) mediaFiles.push(media);
            });

            try {
                // Gemini must always produce at least three distinct audience
                // strategies, even if the user reduced the card count.
                const requestedCount = Math.max(3, cards.length);
                const result = await window.API.aiAudiences({ websiteUrl, numAudiences: requestedCount, alreadyUsed: [], mediaFiles });
                const audiences = result.audiences || [];
                cards.forEach((card, idx) => {
                    const cardIdx = parseInt(card.getAttribute('data-index'));
                    if (audiences[idx]) {
                        this._populateAudienceCard(
                            card,
                            cardIdx,
                            audiences[idx].targeting || audiences[idx].interests || []
                        );
                    }
                });
                const unresolved = audiences.reduce((sum, aud) => sum + (aud.unresolvedTargeting?.length || 0), 0);
                window.AppController.showToast(
                    `${Math.min(cards.length, audiences.length)} unique audiences generated${unresolved ? ` (${unresolved} unsupported items skipped)` : ''} 🎯`,
                    'success'
                );
            } catch (error) {
                window.AppController.showToast('AI generation failed: ' + error.message, 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '🤖 AI Generate All'; }
            }
        },

        handleVideoUrlDownload: async function() {
            const urlListContainer = document.getElementById('campaign-media-url-list');
            const canvasSelect = document.getElementById('campaign-media-url-canvas');
            const btnDownload = document.getElementById('btn-campaign-media-url-download');
            
            if (!urlListContainer || !btnDownload) return;
            
            const inputs = urlListContainer.querySelectorAll('.campaign-video-url-input');
            const urls = Array.from(inputs).map(inp => inp.value.trim()).filter(Boolean);
            const canvasType = canvasSelect?.value || 'original';
            
            if (!urls.length) {
                window.AppController.showToast('Please paste at least one video URL.', 'warning');
                return;
            }
            
            try {
                // Inject animated pulsing loader style dynamically if not present
                if (!document.getElementById('download-loader-style')) {
                    const style = document.createElement('style');
                    style.id = 'download-loader-style';
                    style.innerHTML = `
                        .btn-pulse-loading {
                            background: linear-gradient(270deg, #4361ee, #4895ef, #3f37c9, #4361ee) !important;
                            background-size: 300% 300% !important;
                            animation: pulseGlow 1.5s ease infinite !important;
                            border: none !important;
                            color: white !important;
                        }
                        @keyframes pulseGlow {
                            0% { background-position: 0% 50%; box-shadow: 0 0 8px rgba(67, 97, 238, 0.5); }
                            50% { background-position: 100% 50%; box-shadow: 0 0 20px rgba(72, 149, 239, 0.8); }
                            100% { background-position: 0% 50%; box-shadow: 0 0 8px rgba(67, 97, 238, 0.5); }
                        }
                    `;
                    document.head.appendChild(style);
                }

                btnDownload.disabled = true;
                btnDownload.classList.add('btn-pulse-loading');
                btnDownload.innerHTML = `⏳ Starting (0/${urls.length})...`;
                window.AppController.showToast(`Downloading and cleaning ${urls.length} video(s) in parallel... 📥`, 'info');
                
                let successCount = 0;
                let finishedCount = 0;

                const promises = urls.map(async (url) => {
                    try {
                        const result = await window.API.downloadVideoFromUrl(url, canvasType);
                        finishedCount++;
                        btnDownload.innerHTML = `⏳ Downloading ${finishedCount}/${urls.length}...`;
                        return result;
                    } catch (err) {
                        finishedCount++;
                        btnDownload.innerHTML = `⏳ Downloading ${finishedCount}/${urls.length}...`;
                        throw err;
                    }
                });

                const results = await Promise.allSettled(promises);
                successCount = 0;

                const failReasons = [];
                results.forEach((res) => {
                    if (res.status === 'fulfilled' && res.value) {
                        const val = res.value;
                        successCount++;
                        const item = {
                            mediaFile: val.filename,
                            media: val.filePath,
                            previewUrl: '/uploads/' + val.filename
                        };
                        
                        // Add to Step 3 creatives
                        const blankIndex = this.campaignData.step3.ads.findIndex(ad => !ad.media && !ad.mediaFile);
                        if (blankIndex !== -1) {
                            this.campaignData.step3.ads[blankIndex] = {
                                ...this.campaignData.step3.ads[blankIndex],
                                media: item.media,
                                mediaFile: item.mediaFile,
                                previewUrl: item.previewUrl
                            };
                        } else {
                            this.addCreativeAd(item, false);
                        }
                    } else {
                        const reason = res.reason?.message || res.reason || 'Unknown error';
                        console.error('Video download failed:', reason);
                        failReasons.push(reason);
                    }
                });
                
                this.renderCreativeAds();
                
                // Clear inputs back to single empty row
                urlListContainer.innerHTML = `
                    <div class="flex gap-2 mb-1 campaign-video-url-row" style="display:flex; gap:8px; margin-bottom:8px; align-items:center;">
                        <input type="text" class="form-control campaign-video-url-input" placeholder="Or paste video link (FB Ads Library, YouTube, Insta, Pinterest…)" style="flex:1;">
                        <button type="button" class="btn btn-secondary btn-sm btn-remove-campaign-url-row" style="display:none; padding:4px 8px;">🗑️</button>
                    </div>
                `;

                if (successCount > 0) {
                    window.AppController.showToast(`Successfully processed ${successCount} of ${urls.length} video(s)! 📹`, 'success');
                } else {
                    const errMsg = failReasons.length ? failReasons[0] : 'Download failed — check your URL and try again.';
                    window.AppController.showToast(`❌ Download failed: ${errMsg}`, 'error');
                }
            } catch (err) {
                window.AppController.showToast('Download failed: ' + err.message, 'error');
            } finally {
                btnDownload.disabled = false;
                btnDownload.classList.remove('btn-pulse-loading');
                btnDownload.textContent = '📥 Download & Clean All';
            }
        },

        // ── Media and ad cards ─────────────────────────────────────────────
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

        handleMediaUpload: async function(files, card = null) {
            const selectedFiles = Array.isArray(files) ? files : [files];
            if (!selectedFiles.length) return;
            const uploaded = [];

            for (const file of selectedFiles) {
                const isVid = /\.(mp4|mov|avi|webm)$/i.test(file.name);
                const item = {
                    mediaFile: file.name,
                    previewUrl: URL.createObjectURL(file),
                    thumbnail: '',
                    thumbnailFile: '',
                    thumbnailPreviewUrl: ''
                };
                try {
                    const formData = new FormData();
                    formData.append('file', file);
                    const response = await window.API.uploadMedia(formData);
                    item.media = response.filePath || response.filename;
                } catch {
                    item.media = file.name;
                }

                // Auto-extract thumbnail from video frame
                if (isVid) {
                    try {
                        const frameBlob = await this.extractVideoFrame(file);
                        if (frameBlob) {
                            const thumbName = file.name.replace(/\.[^/.]+$/, '_thumb.jpg');
                            const thumbForm = new FormData();
                            thumbForm.append('file', new File([frameBlob], thumbName, { type: 'image/jpeg' }));
                            const thumbResp = await window.API.uploadMedia(thumbForm);
                            item.thumbnail = thumbResp.filePath || thumbResp.filename;
                            item.thumbnailFile = thumbResp.filename || thumbName;
                            item.thumbnailPreviewUrl = URL.createObjectURL(frameBlob);
                        }
                    } catch(e) {
                        console.log('Auto thumbnail skipped:', e.message);
                    }
                }

                uploaded.push(item);
            }

            if (card && uploaded[0]) {
                card.setAttribute('data-media', uploaded[0].media);
                card.setAttribute('data-media-file', uploaded[0].mediaFile);
                this.setCreativePreview(card, uploaded[0]);
                // Sync thumbnail into ads data and re-render so thumbnail section shows
                const cardIdx = parseInt(card.getAttribute('data-index'), 10);
                if (!isNaN(cardIdx) && this.campaignData.step3.ads[cardIdx]) {
                    Object.assign(this.campaignData.step3.ads[cardIdx], {
                        media: uploaded[0].media,
                        mediaFile: uploaded[0].mediaFile,
                        previewUrl: uploaded[0].previewUrl,
                        thumbnail: uploaded[0].thumbnail || '',
                        thumbnailFile: uploaded[0].thumbnailFile || '',
                        thumbnailPreviewUrl: uploaded[0].thumbnailPreviewUrl || ''
                    });
                }
                if (uploaded[0].thumbnailFile) {
                    this.renderCreativeAds(); // full re-render to show auto thumbnail
                } else {
                    this.renumberCreativeAds();
                }

                // Trigger copy generation for this card after rendering/updating!
                if (!isNaN(cardIdx)) {
                    this.generateAdCopyForCard(cardIdx);
                }
            } else {
                const blankIndex = this.campaignData.step3.ads.findIndex(ad => !ad.media && !ad.mediaFile);
                uploaded.forEach((item, index) => {
                    if (index === 0 && blankIndex !== -1) {
                        this.campaignData.step3.ads[blankIndex] = {
                            ...this.campaignData.step3.ads[blankIndex],
                            media: item.media,
                            mediaFile: item.mediaFile,
                            previewUrl: item.previewUrl,
                            thumbnail: item.thumbnail || '',
                            thumbnailFile: item.thumbnailFile || '',
                            thumbnailPreviewUrl: item.thumbnailPreviewUrl || ''
                        };
                    } else {
                        this.addCreativeAd(item, false);
                    }
                });
                this.renderCreativeAds();

                // Trigger copy generation for newly added ads after rendering!
                uploaded.forEach((item, index) => {
                    if (index === 0 && blankIndex !== -1) {
                        this.generateAdCopyForCard(blankIndex);
                    } else {
                        const newIdx = this.campaignData.step3.ads.length - uploaded.length + index;
                        this.generateAdCopyForCard(newIdx);
                    }
                });
            }

            window.AppController.showToast(`${uploaded.length} media file${uploaded.length === 1 ? '' : 's'} added ✅`, 'success');
        },

        addCreativeAd: function(media = {}, rerender = true) {
            this.campaignData.step3.ads.push({
                media: media.media || '',
                mediaFile: media.mediaFile || '',
                previewUrl: media.previewUrl || '',
                primaryText: media.primaryText || '',
                thumbnail: media.thumbnail || '',
                thumbnailFile: media.thumbnailFile || '',
                thumbnailPreviewUrl: media.thumbnailPreviewUrl || ''
            });
            if (rerender) this.renderCreativeAds();
        },

        removeCreativeAd: function(index) {
            this.collectCreativeAdsFromDOM();
            this.campaignData.step3.ads.splice(index, 1);
            this.renderCreativeAds();
        },

        renumberCreativeAds: function() {
            const cards = document.querySelectorAll('.creative-ad-card');
            const total = cards.length;
            cards.forEach((card, index) => {
                const label = card.querySelector('.creative-ad-name');
                if (label) label.textContent = total === 1 ? 'Single content-Reel' : `Content-${index + 1} Reel`;
            });
        },

        setCreativePreview: function(card, item) {
            const preview = card.querySelector('.creative-media-preview');
            if (!preview || !item.previewUrl) return;
            const isVideo = /\.(mp4|mov|avi|webm)$/i.test(item.mediaFile || '');
            const controlsBar = card.querySelector('.creative-video-controls');

            if (isVideo) {
                const posterAttr = item.thumbnailPreviewUrl ? `poster="${item.thumbnailPreviewUrl}"` : '';
                preview.innerHTML = `<video src="${item.previewUrl}" ${posterAttr} muted playsinline style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;display:block;border-radius:0;"></video>`;
                if (controlsBar) controlsBar.style.display = 'flex';

                const video = preview.querySelector('video');
                const playBtn = controlsBar?.querySelector('.ctrl-play-pause');
                const muteBtn = controlsBar?.querySelector('.ctrl-mute');

                if (playBtn && video) {
                    playBtn.addEventListener('click', () => {
                        if (video.paused) { video.play(); playBtn.textContent = '⏸'; }
                        else { video.pause(); playBtn.textContent = '▶'; }
                    });
                }
                if (muteBtn && video) {
                    muteBtn.addEventListener('click', () => {
                        video.muted = !video.muted;
                        muteBtn.textContent = video.muted ? '🔇' : '🔊';
                    });
                }
            } else {
                preview.innerHTML = `<img src="${item.previewUrl}" alt="${this.escapeHtml(item.mediaFile || 'Ad media')}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;display:block;border-radius:0;">`;
                if (controlsBar) controlsBar.style.display = 'none';
            }
        },

        renderCreativeAds: function() {
            const container = document.getElementById('creative-ads-container');
            if (!container) return;
            container.innerHTML = '';
            const total = this.campaignData.step3.ads.length;

            this.campaignData.step3.ads.forEach((ad, index) => {
                const card = document.createElement('div');
                card.className = 'glass-card creative-ad-card mb-2';
                card.setAttribute('data-index', index);
                card.setAttribute('data-media', ad.media || '');
                card.setAttribute('data-media-file', ad.mediaFile || '');
                card.style.background = 'rgba(0,0,0,0.15)';

                const isVideo = /\.(mp4|mov|avi|webm)$/i.test(ad.mediaFile || '');

                // Build filmstrip-style thumbnail section for videos
                const filmstripRemoveBtn = (ad.thumbnailFile || ad.thumbnailPreviewUrl)
                    ? `<button type="button" class="filmstrip-remove-thumb">✖ Remove thumbnail</button>`
                    : '';

                const filmstripStatusText = ad.thumbnailFile
                    ? `✔ Thumbnail set — drag selector to change`
                    : `Drag the frame-box to pick a thumbnail`;

                const thumbnailHtml = isVideo ? `
                    <div class="creative-thumbnail-section">
                        <div class="filmstrip-upload-row">
                            <span style="font-size:0.82rem;color:var(--text-secondary);">🖼️ Thumbnail</span>
                            <div style="display:flex;gap:6px;align-items:center;">
                                ${filmstripRemoveBtn}
                                <label class="btn btn-secondary btn-xs" style="cursor:pointer;margin:0;">
                                    📁 Upload image
                                    <input type="file" class="creative-thumbnail-input" accept="image/*" style="display:none;">
                                </label>
                            </div>
                        </div>
                        <div class="filmstrip-wrap" data-ad-index="${index}">
                            <div class="filmstrip-status busy">${filmstripStatusText}</div>
                            <div class="filmstrip-row">
                                <button type="button" class="filmstrip-scroll-btn" data-dir="-1">&#8249;</button>
                                <div class="filmstrip-viewport">
                                    <div class="filmstrip-track"></div>
                                    <div class="filmstrip-selector"></div>
                                </div>
                                <button type="button" class="filmstrip-scroll-btn" data-dir="1">&#8250;</button>
                            </div>
                        </div>
                    </div>
                ` : '';

                card.innerHTML = `
                    <div class="flex justify-between align-center mb-2">
                        <h4 class="creative-ad-name" style="color:var(--accent-cyan);">${total === 1 ? 'Single content-Reel' : `Content-${index + 1} Reel`}</h4>
                        <div class="flex gap-2">
                            <label class="btn btn-secondary btn-sm" style="cursor:pointer;">📁 Change Media
                                <input type="file" class="creative-media-input" accept="image/*,video/*" style="display:none;">
                            </label>
                            <button type="button" class="remove-card-btn creative-remove-ad"><span>✖</span></button>
                        </div>
                    </div>
                    <div class="creative-card-body">
                        <div class="creative-left-panel">
                            ${thumbnailHtml}
                            <div style="display:flex;flex-direction:column;flex:1;">
                                <label>Primary Text *</label>
                                <textarea class="form-control creative-primary-text" rows="10" placeholder="Use Auto-fill from Website or write the primary text here...">${this.escapeHtml(ad.primaryText || '')}</textarea>
                            </div>
                        </div>
                        <div class="creative-preview-panel">
                            <div class="creative-media-preview">
                                ${ad.mediaFile
                                    ? ''
                                    : '<div class="no-media-msg"><span>📁</span><p>No media selected</p></div>'}
                            </div>
                            <div class="creative-video-controls" style="display:none;">
                                <button type="button" class="ctrl-btn ctrl-play-pause" title="Play / Pause">▶</button>
                                <button type="button" class="ctrl-btn ctrl-mute" title="Mute / Unmute">🔇</button>
                            </div>
                        </div>
                    </div>
                `;

                container.appendChild(card);
                if (ad.previewUrl) this.setCreativePreview(card, ad);

                card.querySelector('.creative-remove-ad').addEventListener('click', () => this.removeCreativeAd(index));
                card.querySelector('.creative-media-input').addEventListener('change', e => {
                    if (e.target.files[0]) this.handleMediaUpload([e.target.files[0]], card);
                });
                card.querySelector('.creative-primary-text').addEventListener('input', e => {
                    this.campaignData.step3.ads[index].primaryText = e.target.value;
                });

                if (isVideo) {
                    // Upload image manually as thumbnail
                    const thumbInput = card.querySelector('.creative-thumbnail-input');
                    if (thumbInput) {
                        thumbInput.addEventListener('change', async e => {
                            const file = e.target.files[0];
                            if (!file) return;
                            const formData = new FormData();
                            formData.append('file', file);
                            try {
                                const response = await window.API.uploadMedia(formData);
                                this.campaignData.step3.ads[index].thumbnail = response.filePath;
                                this.campaignData.step3.ads[index].thumbnailFile = response.filename;
                                this.campaignData.step3.ads[index].thumbnailPreviewUrl = URL.createObjectURL(file);
                                this.renderCreativeAds();
                            } catch (err) {
                                window.AppController.showToast(`Thumbnail upload failed: ${err.message}`, 'danger');
                            }
                        });
                    }

                    // Remove thumbnail button
                    const removeThumbBtn = card.querySelector('.filmstrip-remove-thumb');
                    if (removeThumbBtn) {
                        removeThumbBtn.addEventListener('click', () => {
                            this.campaignData.step3.ads[index].thumbnail = '';
                            this.campaignData.step3.ads[index].thumbnailFile = '';
                            this.campaignData.step3.ads[index].thumbnailPreviewUrl = '';
                            const videoEl = card.querySelector('.creative-preview-panel video');
                            if (videoEl) videoEl.removeAttribute('poster');
                            this.renderCreativeAds();
                        });
                    }

                    // Init Canva-style filmstrip scrubber
                    this.initFilmstrip(card, ad, index);
                }
            });
        },

        initFilmstrip: function(card, ad, index) {
            const wrap = card.querySelector('.filmstrip-wrap');
            if (!wrap || !ad.previewUrl) return;

            const track      = wrap.querySelector('.filmstrip-track');
            const viewport   = wrap.querySelector('.filmstrip-viewport');
            const selector   = wrap.querySelector('.filmstrip-selector');
            const statusEl   = wrap.querySelector('.filmstrip-status');
            const btnLeft    = wrap.querySelector('.filmstrip-scroll-btn[data-dir="-1"]');
            const btnRight   = wrap.querySelector('.filmstrip-scroll-btn[data-dir="1"]');

            const FRAME_W    = 64;   // px — matches CSS
            const NUM_FRAMES = 20;   // total frames extracted

            let videoDuration = 0;
            let frameDataUrls = [];  // dataURL per frame index
            let frameBlobs    = [];  // blob per frame index
            let selectedIdx   = 0;  // currently selected frame index
            let trackOffset   = 0;  // how many px the track is shifted left (scroll)
            let isDragging    = false;
            let dragStartX    = 0;
            let selectorLeft  = 0;  // selector position in px relative to viewport left

            // ── Hidden video for frame extraction ──────────────────────────
            const video = document.createElement('video');
            video.src        = ad.previewUrl;
            video.preload    = 'metadata';
            video.muted      = true;
            video.playsInline = true;

            const captureCurrentFrame = () => new Promise(resolve => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width  = video.videoWidth  || 1280;
                    canvas.height = video.videoHeight || 720;
                    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                    canvas.toBlob(blob => {
                        resolve({ blob, dataUrl: canvas.toDataURL('image/jpeg', 0.85) });
                    }, 'image/jpeg', 0.85);
                } catch(e) { resolve({ blob: null, dataUrl: '' }); }
            });

            const seekTo = (time) => new Promise(resolve => {
                video.addEventListener('seeked', resolve, { once: true });
                video.currentTime = time;
            });

            // ── Build the strip ────────────────────────────────────────────
            const buildStrip = async () => {
                videoDuration = video.duration || 0;
                if (!videoDuration) return;

                const interval = videoDuration / NUM_FRAMES;
                track.innerHTML = '';

                // Add placeholder cells first so layout appears immediately
                for (let i = 0; i < NUM_FRAMES; i++) {
                    const cell = document.createElement('div');
                    cell.className = 'filmstrip-loading-cell';
                    cell.innerHTML = '<span style="font-size:9px;color:rgba(255,255,255,0.2);">…</span>';
                    track.appendChild(cell);
                }

                // Extract frames one by one, replacing placeholders
                for (let i = 0; i < NUM_FRAMES; i++) {
                    if (!document.contains(wrap)) break; // card was removed, stop
                    const time = i * interval + 0.02;
                    await seekTo(time);
                    const { blob, dataUrl } = await captureCurrentFrame();
                    frameDataUrls[i] = dataUrl;
                    frameBlobs[i]    = blob;

                    const img = document.createElement('img');
                    img.src       = dataUrl;
                    img.className = 'filmstrip-frame-img';
                    track.children[i].replaceWith(img);
                }

                // Position selector on frame 0 (or restore saved position)
                placeSelector(0);

                // If no thumbnail is currently set, automatically save frame 0 as default
                if (!ad.thumbnailFile && !ad.thumbnailPreviewUrl) {
                    saveFrame(0);
                } else {
                    setStatus('✔ Thumbnail set', false);
                }
            };

            // ── Selector positioning ───────────────────────────────────────
            // viewportWidth is constant; total track width = NUM_FRAMES * FRAME_W
            const viewportW = () => viewport.clientWidth || 300;

            // Convert frame index → pixel left inside viewport (accounting for scroll)
            const frameToViewportLeft = (idx) => idx * FRAME_W - trackOffset;

            // Convert viewport-relative px → nearest frame index (clamped)
            const viewportPxToFrameIdx = (px) => {
                const trackPx = px + trackOffset;
                return Math.max(0, Math.min(NUM_FRAMES - 1, Math.round(trackPx / FRAME_W)));
            };

            const placeSelector = (idx) => {
                selectedIdx = idx;
                const left  = frameToViewportLeft(idx);
                // Clamp so selector stays within viewport visually
                selector.style.left = `${Math.max(0, Math.min(viewportW() - FRAME_W, left))}px`;
            };

            // Scroll the track by delta px, update selector, clamp
            const scrollTrack = (delta) => {
                const maxOffset = Math.max(0, NUM_FRAMES * FRAME_W - viewportW());
                trackOffset = Math.max(0, Math.min(maxOffset, trackOffset + delta));
                track.style.transform = `translateX(-${trackOffset}px)`;
                // Re-place selector so it follows the selected frame
                placeSelector(selectedIdx);
                updateScrollBtns();
            };

            const updateScrollBtns = () => {
                const maxOffset = Math.max(0, NUM_FRAMES * FRAME_W - viewportW());
                btnLeft.disabled  = trackOffset <= 0;
                btnRight.disabled = trackOffset >= maxOffset;
            };

            const setStatus = (msg, busy = true) => {
                if (!statusEl) return;
                statusEl.textContent = msg;
                statusEl.className   = 'filmstrip-status ' + (busy ? 'busy' : 'ok');
            };

            // ── Save selected frame as thumbnail ───────────────────────────
            const saveFrame = async (idx) => {
                const blob = frameBlobs[idx];
                if (!blob) return;
                setStatus('⏳ Saving thumbnail…', true);
                try {
                    const fname    = (ad.mediaFile || 'video').replace(/\.[^/.]+$/, '') + '_thumb.jpg';
                    const formData = new FormData();
                    formData.append('file', new File([blob], fname, { type: 'image/jpeg' }));
                    const resp = await window.API.uploadMedia(formData);

                    this.campaignData.step3.ads[index].thumbnail          = resp.filePath || resp.filename;
                    this.campaignData.step3.ads[index].thumbnailFile      = resp.filename || fname;
                    this.campaignData.step3.ads[index].thumbnailPreviewUrl = URL.createObjectURL(blob);

                    // Update video poster in DOM preview directly without full re-render
                    const videoEl = card.querySelector('.creative-preview-panel video');
                    if (videoEl) {
                        videoEl.setAttribute('poster', this.campaignData.step3.ads[index].thumbnailPreviewUrl);
                    }

                    setStatus('✔ Thumbnail set', false);
                    window.AppController.showToast('Thumbnail set ✔', 'success');

                    // Update remove button visibility without full re-render
                    const uploadRow = wrap.closest('.creative-thumbnail-section')?.querySelector('.filmstrip-upload-row');
                    if (uploadRow && !uploadRow.querySelector('.filmstrip-remove-thumb')) {
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'filmstrip-remove-thumb';
                        btn.textContent = '✖ Remove thumbnail';
                        btn.addEventListener('click', () => {
                            this.campaignData.step3.ads[index].thumbnail = '';
                            this.campaignData.step3.ads[index].thumbnailFile = '';
                            this.campaignData.step3.ads[index].thumbnailPreviewUrl = '';
                            if (videoEl) videoEl.removeAttribute('poster');
                            this.renderCreativeAds();
                        });
                        uploadRow.querySelector('div').prepend(btn);
                    }
                } catch(err) {
                    setStatus('⚠ Save failed — try again', true);
                }
            };

            // ── Drag on viewport ───────────────────────────────────────────
            let dragSaveTimer = null;

            const getClientX = (e) => e.touches ? e.touches[0].clientX : e.clientX;

            viewport.addEventListener('mousedown', (e) => {
                isDragging = true;
                dragStartX = getClientX(e) - frameToViewportLeft(selectedIdx);
                e.preventDefault();
            });
            viewport.addEventListener('touchstart', (e) => {
                isDragging = true;
                dragStartX = getClientX(e) - frameToViewportLeft(selectedIdx);
            }, { passive: true });

            // Click to jump selector to clicked frame
            viewport.addEventListener('click', (e) => {
                if (Math.abs(getClientX(e) - (dragStartX + frameToViewportLeft(selectedIdx))) > 4) return;
                const rect  = viewport.getBoundingClientRect();
                const newIdx = viewportPxToFrameIdx(getClientX(e) - rect.left);
                if (newIdx !== selectedIdx) {
                    placeSelector(newIdx);
                    clearTimeout(dragSaveTimer);
                    dragSaveTimer = setTimeout(() => saveFrame(newIdx), 300);
                }
            });

            const onMove = (e) => {
                if (!isDragging) return;
                const rect     = viewport.getBoundingClientRect();
                const relX     = getClientX(e) - rect.left;  // px inside viewport
                const newIdx   = viewportPxToFrameIdx(relX);
                if (newIdx !== selectedIdx) {
                    placeSelector(newIdx);
                    // Debounce save — upload only after dragging stops briefly
                    clearTimeout(dragSaveTimer);
                    dragSaveTimer = setTimeout(() => saveFrame(newIdx), 500);
                }
            };
            const onUp = () => { isDragging = false; };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('touchmove', onMove, { passive: true });
            document.addEventListener('mouseup',   onUp);
            document.addEventListener('touchend',  onUp);

            // ── Scroll buttons ─────────────────────────────────────────────
            btnLeft.addEventListener('click',  () => scrollTrack(-FRAME_W * 3));
            btnRight.addEventListener('click', () => scrollTrack(FRAME_W * 3));

            // ── Cleanup when card is removed ───────────────────────────────
            const observer = new MutationObserver(() => {
                if (!document.contains(wrap)) {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('touchmove', onMove);
                    document.removeEventListener('mouseup',   onUp);
                    document.removeEventListener('touchend',  onUp);
                    clearTimeout(dragSaveTimer);
                    observer.disconnect();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });

            // ── Start ──────────────────────────────────────────────────────
            setStatus('⏳ Loading frames…', true);
            updateScrollBtns();
            video.addEventListener('loadeddata', buildStrip, { once: true });
            video.addEventListener('error', () => setStatus('⚠ Could not load video', true), { once: true });
            video.load();
        },

        generateAdCopyForCard: async function(index) {
            const ad = this.campaignData.step3.ads[index];
            if (!ad || !ad.media) return;

            const websiteUrl = document.getElementById('website-url')?.value?.trim();
            if (!websiteUrl) return;

            // Dynamically query textarea to ensure it is captured in the correct render cycle
            const getTextArea = () => document.querySelector(`.creative-ad-card[data-index="${index}"] .creative-primary-text`);
            const initialTextarea = getTextArea();
            if (initialTextarea) {
                initialTextarea.value = '⏳ Generating ad copy matching this video... 🤖';
            }

            try {
                // Call API with websiteUrl and the media path on server (videoPath)
                const result = await window.API.generateAdCopy({ 
                    websiteUrl, 
                    videoPath: ad.media 
                });

                if (result.primaryText) {
                    ad.primaryText = result.primaryText.trim();
                    const currentTextarea = getTextArea();
                    if (currentTextarea) {
                        currentTextarea.value = ad.primaryText;
                    }
                    
                    // Also set headline and description if they are empty
                    const headline = document.getElementById('headline');
                    if (headline && !headline.value.trim() && result.headline) {
                        headline.value = this.extractHeadlineName(result.headline);
                    }
                }
            } catch (err) {
                console.error(`Failed to generate copy for card ${index}:`, err.message);
                const currentTextarea = getTextArea();
                if (currentTextarea && currentTextarea.value.startsWith('⏳')) {
                    currentTextarea.value = '';
                }
            }
        },

        escapeHtml: function(value) {
            return String(value).replace(/[&<>"']/g, char => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
            }[char]));
        },

        ensureCreativeCopyLoaded: function() {
            const websiteUrl = document.getElementById('website-url')?.value?.trim();
            if (websiteUrl && this._copyAutoFilledForUrl !== websiteUrl && this.campaignData.step3.ads.length > 0) {
                this.autoFillCreativeCopy(true);
            }
        },

        extractHeadlineName: function(title) {
            if (!title) return '';

            // 0. Decode HTML entities (e.g. &amp; → &, &quot; → ", &#039; → ')
            const txt = document.createElement('textarea');
            txt.innerHTML = title;
            title = txt.value;

            // 1. Remove all emojis
            let clean = title.replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDC00-\uDFFF]/g, '');
            
            // 2. Remove common promotional keywords
            const promoWords = [
                'limited-time', 'limited time', 'sale', 'off', 'subsidy', 'discount', 'free shipping', 'shipping', 'new', 
                'hot', 'deal', 'promo', 'exclusive', 'special', 'best', 'quality', 'price', 'low', 'cheap', 'click', 
                'buy', 'shop', 'order', 'gift', 'coupon', 'code', 'save', 'saving', 'percent', 'percentage', 'original',
                'luxury', 'premium', 'trending', 'viral', 'top', 'rated', 'review', 'guarantee', 'warranty', 'ship',
                'subsidies', 'limited', 'time', 'heat', 'summer'
            ];
            
            // Replace numbers followed by % off (e.g. 56% off, 50%off)
            clean = clean.replace(/\d+\s*%?\s*off/g, '');
            
            // Split into words
            let words = clean.split(/\s+/).filter(Boolean);
            
            // Filter words
            let filtered = words.filter(w => {
                const lower = w.replace(/[^a-zA-Z]/g, '').toLowerCase();
                return !promoWords.includes(lower);
            });
            
            if (filtered.length === 0) filtered = words;
            
            // Keep up to 8 words for a clean but descriptive headline name
            return filtered.slice(0, 8).join(' ').trim();
        },

        autoFillCreativeCopy: async function(silent = false) {
            const websiteUrl = document.getElementById('website-url')?.value?.trim();
            if (!websiteUrl) {
                if (!silent) window.AppController.showToast('Please enter Website URL in Campaign Settings first', 'warning');
                return;
            }

            const btn = document.getElementById('btn-auto-fill-copy');
            if (btn) { btn.disabled = true; btn.textContent = '⏳ Reading website...'; }
            try {
                const result = await window.API.generateAdCopy({ websiteUrl });
                const headline = document.getElementById('headline');
                const description = document.getElementById('description');
                
                const cleanHeadline = this.extractHeadlineName(result.productName || result.headline || '');
                if (headline && (!headline.value.trim() || headline.value === this._autoFilledCopy.headline)) {
                    headline.value = cleanHeadline;
                }
                if (description && (!description.value.trim() || description.value === this._autoFilledCopy.description)) {
                    description.value = result.description || '';
                }

                this._copyAutoFilledForUrl = websiteUrl;
                this._autoFilledCopy = {
                    headline: headline?.value || '',
                    description: description?.value || '',
                    primaryText: result.primaryText || ''
                };

                // Now generate unique variations for each ad (content card)
                const totalAds = this.campaignData.step3.ads.length;
                let variations = [];
                if (totalAds > 1 && result.primaryText) {
                    try {
                        if (btn) btn.textContent = '⏳ Generating unique ad variations...';
                        const varResult = await window.API.generateVariations({ baseText: result.primaryText, count: totalAds });
                        variations = varResult.variations || [];
                    } catch (e) {
                        console.warn('Failed to generate variations, falling back to base copy:', e.message);
                    }
                }

                // Update primary text IN-PLACE — never wipe and re-render the cards.
                // Re-rendering does container.innerHTML='' which destroys the filmstrip/
                // thumbnail section and causes the visible blank → reload flicker.
                const cards = document.querySelectorAll('#creative-ads-container .creative-ad-card');
                cards.forEach((card, index) => {
                    const textField = card.querySelector('.creative-primary-text');
                    const newText = (variations[index] || result.primaryText || '').trim();
                    if (textField) textField.value = newText;
                    // Keep campaignData in sync without touching the DOM structure
                    if (this.campaignData.step3.ads[index]) {
                        this.campaignData.step3.ads[index].primaryText = newText;
                    }
                });
                if (!silent) window.AppController.showToast('Headline and primary text auto-filled ✨', 'success');
            } catch (error) {
                if (!silent) window.AppController.showToast('Website/Gemini error: ' + error.message, 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '🤖 Auto-fill from Website'; }
            }
        },

        // ── Review ───────────────────────────────────────────────────────
        renderReviewSummary: function() {
            this.collectCreativeAdsFromDOM();
            const { step1, step2, step3 } = this.campaignData;
            const totalAdsets = step2.audiences?.length || 0;
            const totalAds = step3.ads?.length || 0;

            const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
            set('review-campaign-name', `Name: <strong>${step1.name || '—'}</strong>`);
            set('review-campaign-objective', `Objective: <strong>${step1.objective || '—'}</strong>`);
            set('review-campaign-budget', `Budget: <strong>$${step1.budgetAmount || 0}/day (${step1.budgetType || 'CBO'})</strong>`);
            set('review-adsets-count', `Ad Sets: <strong>${totalAdsets}</strong>`);
            set('review-variations-count', `Ads per Ad Set: <strong>${totalAds}</strong>`);
            const totalEl = document.getElementById('review-total-ads');
            if (totalEl) totalEl.textContent = `Total Ads: ${totalAdsets * totalAds}`;

            const detailContainer = document.getElementById('review-adsets-detail');
            if (detailContainer && step2.audiences) {
                detailContainer.innerHTML = '';
                step2.audiences.forEach((aud, idx) => {
                    const card = document.createElement('div');
                    card.className = 'glass-card mb-2';
                    card.style.background = 'rgba(0,0,0,0.15)';
                    const locNames = (aud.locationsInclude || []).map(l => l.name || l.key || l).join(', ') || 'IN';
                    const excNames = (aud.locationsExclude || []).map(l => l.name || l.key || l).join(', ');
                    const adNames = (step3.ads || []).map((ad, adIndex) =>
                        totalAds === 1 ? 'Single content-Reel' : `Content-${adIndex + 1} Reel`
                    ).join(', ');
                    card.innerHTML = `
                        <h4 style="color:var(--accent-cyan);">📋 Ad Set ${idx+1}: ${aud.name}</h4>
                        <div class="flex gap-2 mt-2" style="flex-wrap:wrap;">
                            <span class="badge badge-info">📍 ${locNames}</span>
                            ${excNames ? `<span class="badge badge-warning">🚫 ${excNames}</span>` : ''}
                            <span class="badge badge-info">👤 ${aud.ageMin||18}–${aud.ageMax||65}</span>
                            <span class="badge badge-info">⚧ ${aud.gender||'All'}</span>
                            <span class="badge badge-info">🎯 ${(aud.interests||[]).map(i=>i.name||i).join(', ')||'Broad'}</span>
                            <span class="badge badge-info">🖼️ ${adNames || 'No ads'}</span>
                        </div>
                    `;
                    detailContainer.appendChild(card);
                });
            }
        },

        // ── Create campaign ───────────────────────────────────────────────
        createCampaign: async function() {
            const btn = document.getElementById('btn-create-campaign');
            const statusDiv = document.getElementById('creation-status');
            const statusText = document.getElementById('creation-status-text');
            const errorDetails = document.getElementById('creation-error-details');

            if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating...'; }
            if (statusDiv) statusDiv.style.display = 'block';
            if (errorDetails) {
                errorDetails.style.display = 'none';
                errorDetails.innerHTML = '';
            }

            try {
                if (!this._creationDraftId) {
                    this._creationDraftId = window.crypto?.randomUUID
                        ? window.crypto.randomUUID()
                        : `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                }
                const payload = {
                    campaign: this.campaignData.step1,
                    adsets: this.campaignData.step2,
                    creative: this.campaignData.step3,
                    draftId: this._creationDraftId,
                    retryState: this._retryState || undefined
                };
                if (statusText) statusText.textContent = 'Creating campaign on Facebook...';
                const result = await window.API.createCampaign(payload);
                this._retryState = null;
                this._creationDraftId = '';
                
                // Cross-post organically if toggle is checked
                if (document.getElementById('campaign-organic-publish-toggle')?.checked) {
                    try {
                        if (statusText) statusText.textContent = 'Publishing organic post/reel... 📢';
                        const pageId = document.getElementById('ad-page')?.value;
                        const instagramId = document.getElementById('ad-instagram')?.value;
                        
                        const pageIds = pageId ? [pageId] : [];
                        const instagramIds = instagramId ? [instagramId] : [];
                        
                        const videos = (this.campaignData.step3.ads || [])
                            .map(ad => ({ filePath: ad.media, filename: ad.mediaFile }))
                            .filter(v => v.filePath && v.filename);
                        
                        const caption = this.campaignData.step3.ads?.[0]?.primaryText || '';

                        if ((pageIds.length || instagramIds.length) && videos.length) {
                            await window.API.publishPost({
                                pageIds,
                                instagramIds,
                                videos,
                                caption
                            });
                            window.AppController.showToast('Successfully published organically too! 📢', 'success');
                        }
                    } catch (pubErr) {
                        console.error("Organic publishing failed during campaign creation:", pubErr);
                        window.AppController.showToast('Campaign created, but organic publishing failed: ' + pubErr.message, 'warning');
                    }
                }

                if (statusText) statusText.textContent = '✅ Campaign created successfully!';
                window.AppController.showToast('Campaign created successfully! 🎉', 'success');

                const resultBody = document.getElementById('modal-result-body');
                const resultTitle = document.getElementById('modal-result-title');
                if (resultTitle) resultTitle.textContent = '🎉 Campaign Created!';
                if (resultBody) {
                    resultBody.innerHTML = `
                        <div style="text-align:center; padding:1rem;">
                            <p style="font-size:3rem; margin-bottom:1rem;">✅</p>
                            <h3>Campaign "${this.campaignData.step1.name}" created!</h3>
                            <p class="mt-2" style="color:var(--text-secondary);">Campaign ID: ${result.results?.campaignId || 'Created'}</p>
                            <p style="color:var(--text-secondary);">Ad Sets: ${result.results?.adsets?.length || 0}</p>
                            <p style="color:var(--text-secondary);">Ads: ${result.results?.ads?.length || 'Created'}</p>
                            <button id="btn-modal-create-another" class="btn btn-primary mt-3" style="width:100%;">➕ Create Another Campaign</button>
                        </div>
                    `;
                    
                    const btnCreateAnother = document.getElementById('btn-modal-create-another');
                    if (btnCreateAnother) {
                        btnCreateAnother.addEventListener('click', () => {
                            window.AppController.closeModal('modal-result');
                            this.resetWizard();
                        });
                    }
                }
                window.AppController.openModal('modal-result');
                window.AppController.loadRecentCampaigns();
            } catch (error) {
                if (statusText) statusText.textContent = '❌ Failed: ' + error.message;
                window.AppController.showToast('Failed to create campaign: ' + error.message, 'error');
                const data = error.data || {};
                this._retryState = data.retryState || this._retryState;
                if (errorDetails) {
                    const facebook = data.facebook || {};
                    const code = facebook.code
                        ? `Facebook code ${facebook.code}${facebook.errorSubcode ? ` / subcode ${facebook.errorSubcode}` : ''}`
                        : 'No Facebook error code returned';
                    const failedStep = data.failedStep || 'validation';
                    const params = data.requestParams
                        ? JSON.stringify(data.requestParams, null, 2)
                        : 'No request payload was available.';
                    errorDetails.innerHTML = `
                        <div style="border:1px solid rgba(239,35,60,0.45); background:rgba(239,35,60,0.08); border-radius:10px; padding:1rem;">
                            <h4 style="color:var(--danger); margin-bottom:0.5rem;">Facebook rejected a parameter</h4>
                            <p style="margin-bottom:0.35rem;"><strong>Failed step:</strong> ${this.escapeHtml(failedStep)}</p>
                            <p style="margin-bottom:0.35rem;"><strong>Error:</strong> ${this.escapeHtml(code)}</p>
                            ${facebook.type ? `<p style="margin-bottom:0.35rem;"><strong>Type:</strong> ${this.escapeHtml(facebook.type)}</p>` : ''}
                            ${facebook.fbtraceId ? `<p style="margin-bottom:0.6rem;"><strong>Trace ID:</strong> ${this.escapeHtml(facebook.fbtraceId)}</p>` : ''}
                            <p style="margin-bottom:0.35rem;"><strong>Details:</strong> ${this.escapeHtml(error.message)}</p>
                            <details>
                                <summary style="cursor:pointer; color:var(--accent-cyan);">Show request parameter</summary>
                                <pre style="white-space:pre-wrap; overflow:auto; max-height:220px; margin-top:0.5rem; font-size:0.72rem; color:var(--text-secondary);">${this.escapeHtml(params)}</pre>
                            </details>
                            ${data.retryable !== false ? '<button type="button" class="btn btn-primary mt-3" id="btn-retry-campaign">↻ Retry from failed step</button>' : ''}
                        </div>
                    `;
                    errorDetails.style.display = 'block';
                    const retryBtn = document.getElementById('btn-retry-campaign');
                    if (retryBtn) retryBtn.addEventListener('click', () => this.createCampaign());
                }
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '🚀 Create Campaign'; }
            }
        },

        escapeHtml: function(value) {
            return String(value ?? '').replace(/[&<>"']/g, char => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;'
            }[char]));
        },

        loadSavedAudiencesDropdown: async function() {
            const select = document.getElementById('load-saved-audience-select');
            if (!select) return;
            try {
                const list = await window.API.getSavedAudiences();
                select.innerHTML = '<option value="">📂 Load Saved Audience...</option>';
                if (Array.isArray(list)) {
                    list.forEach(aud => {
                        const opt = document.createElement('option');
                        opt.value = aud.id;
                        opt.textContent = aud.name;
                        select.appendChild(opt);
                    });
                }
            } catch (err) {
                console.error('Failed to load saved audiences:', err);
            }
        },

        saveCurrentTargeting: async function() {
            const name = window.prompt("Enter name for this targeting template:");
            if (!name || !name.trim()) return;

            const readLocTags = (selector) => {
                const items = [];
                document.querySelectorAll(selector).forEach(tag => {
                    items.push({
                        key: tag.getAttribute('data-key') || '',
                        name: tag.getAttribute('data-name') || tag.getAttribute('data-value') || '',
                        type: tag.getAttribute('data-type') || 'country'
                    });
                });
                return items;
            };

            const globalLocInclude = readLocTags('#location-include-tags .location-tag');
            const globalLocExclude = readLocTags('#location-exclude-tags .location-tag');
            const globalAgeMin = parseInt(document.getElementById('global-age-min')?.value) || 18;
            const globalAgeMax = parseInt(document.getElementById('global-age-max')?.value) || 65;
            const globalGender = document.querySelector('input[name="global-gender"]:checked')?.value || 'all';

            const customInclude = [];
            document.querySelectorAll('#custom-include-tags .audience-tag').forEach(t => customInclude.push(t.getAttribute('data-value')));
            const customExclude = [];
            document.querySelectorAll('#custom-exclude-tags .audience-tag').forEach(t => customExclude.push(t.getAttribute('data-value')));
            const lookalikeInclude = [];
            document.querySelectorAll('#lookalike-include-tags .audience-tag').forEach(t => lookalikeInclude.push(t.getAttribute('data-value')));
            const lookalikeExclude = [];
            document.querySelectorAll('#lookalike-exclude-tags .audience-tag').forEach(t => lookalikeExclude.push(t.getAttribute('data-value')));

            const audienceCards = document.querySelectorAll('.audience-card');
            const interestsSets = [];
            audienceCards.forEach(card => {
                const interests = [];
                card.querySelectorAll('.interest-tag').forEach(tag => {
                    interests.push({
                        id: tag.getAttribute('data-id') || '',
                        name: tag.getAttribute('data-value') || tag.textContent.replace('✖','').trim(),
                        type: tag.getAttribute('data-type') || 'interest'
                    });
                });
                interestsSets.push(interests);
            });

            const targeting = {
                globalLocInclude,
                globalLocExclude,
                globalAgeMin,
                globalAgeMax,
                globalGender,
                customInclude,
                customExclude,
                lookalikeInclude,
                lookalikeExclude,
                interestsSets
            };

            try {
                await window.API.saveSavedAudience({ name, targeting });
                window.AppController.showToast('Audience saved successfully! 💾', 'success');
                this.loadSavedAudiencesDropdown();
            } catch (err) {
                window.AppController.showToast('Failed to save audience: ' + err.message, 'error');
            }
        },

        loadTargetingTemplate: async function(id) {
            if (!id) return;
            try {
                const list = await window.API.getSavedAudiences();
                const selected = list.find(a => a.id === id);
                if (!selected || !selected.targeting) return;

                const t = selected.targeting;
                
                // 1. Populate global inputs
                const ageMinInput = document.getElementById('global-age-min');
                const ageMaxInput = document.getElementById('global-age-max');
                if (ageMinInput && t.globalAgeMin) ageMinInput.value = t.globalAgeMin;
                if (ageMaxInput && t.globalAgeMax) ageMaxInput.value = t.globalAgeMax;
                
                if (t.globalGender) {
                    const genderRadio = document.querySelector(`input[name="global-gender"][value="${t.globalGender}"]`);
                    if (genderRadio) genderRadio.checked = true;
                }

                // Locations include tags
                const locIncludeTags = document.getElementById('location-include-tags');
                const locIncludeSearch = document.getElementById('loc-include-search');
                if (locIncludeTags && locIncludeSearch && Array.isArray(t.globalLocInclude)) {
                    locIncludeTags.querySelectorAll('.location-tag').forEach(tag => tag.remove());
                    t.globalLocInclude.forEach(loc => {
                        const tag = document.createElement('span');
                        tag.className = 'tag location-tag';
                        tag.setAttribute('data-key', loc.key || '');
                        tag.setAttribute('data-type', loc.type || 'country');
                        tag.setAttribute('data-name', loc.name);
                        tag.setAttribute('data-value', loc.name);
                        const ico = { country: '🌍', region: '📍', city: '🏙️' }[loc.type] || '📍';
                        tag.innerHTML = `${loc.name} ${ico} <span class="tag-remove" onclick="this.parentElement.remove()">✖</span>`;
                        locIncludeTags.insertBefore(tag, locIncludeSearch);
                    });
                }

                // Locations exclude tags
                const locExcludeTags = document.getElementById('location-exclude-tags');
                const locExcludeSearch = document.getElementById('loc-exclude-search');
                if (locExcludeTags && locExcludeSearch && Array.isArray(t.globalLocExclude)) {
                    locExcludeTags.querySelectorAll('.location-tag').forEach(tag => tag.remove());
                    t.globalLocExclude.forEach(loc => {
                        const tag = document.createElement('span');
                        tag.className = 'tag location-tag';
                        tag.setAttribute('data-key', loc.key || '');
                        tag.setAttribute('data-type', loc.type || 'country');
                        tag.setAttribute('data-name', loc.name);
                        tag.setAttribute('data-value', loc.name);
                        const ico = { country: '🌍', region: '📍', city: '🏙️' }[loc.type] || '📍';
                        tag.innerHTML = `${loc.name} ${ico} <span class="tag-remove" onclick="this.parentElement.remove()">✖</span>`;
                        locExcludeTags.insertBefore(tag, locExcludeSearch);
                    });
                }

                // Custom Audiences Include/Exclude
                const renderCustomAudienceTags = (containerId, searchId, list) => {
                    const container = document.getElementById(containerId);
                    const search = document.getElementById(searchId);
                    if (container && search && Array.isArray(list)) {
                        container.querySelectorAll('.audience-tag').forEach(tag => tag.remove());
                        list.forEach(val => {
                            const tag = document.createElement('span');
                            tag.className = 'tag audience-tag';
                            tag.setAttribute('data-value', val);
                            tag.innerHTML = `${val} <span class="tag-remove" onclick="this.parentElement.remove()">✖</span>`;
                            container.insertBefore(tag, search);
                        });
                    }
                };

                renderCustomAudienceTags('custom-include-tags', 'custom-include-search', t.customInclude);
                renderCustomAudienceTags('custom-exclude-tags', 'custom-exclude-search', t.customExclude);
                renderCustomAudienceTags('lookalike-include-tags', 'lookalike-include-search', t.lookalikeInclude);
                renderCustomAudienceTags('lookalike-exclude-tags', 'lookalike-exclude-search', t.lookalikeExclude);

                // 2. Populate interest cards
                if (Array.isArray(t.interestsSets)) {
                    const numInput = document.getElementById('num-adsets');
                    if (numInput) numInput.value = t.interestsSets.length;
                    
                    this.updateAudienceCards();
                    
                    const cards = document.querySelectorAll('.audience-card');
                    t.interestsSets.forEach((interests, idx) => {
                        const card = cards[idx];
                        if (card) {
                            this._populateAudienceCard(card, idx, interests);
                        }
                    });
                }

                window.AppController.showToast('Targeting template loaded! 📂', 'success');
            } catch (err) {
                window.AppController.showToast('Failed to load targeting template: ' + err.message, 'error');
            }
        },

        resetWizard: function() {
            // Reset wizard step
            this.currentStep = 1;
            this.updateStepUI();

            // Clear inputs
            const nameInput = document.getElementById('campaign-name');
            if (nameInput) nameInput.value = '';
            
            const budgetInput = document.getElementById('budget-amount');
            if (budgetInput) {
                const symbol = this.getCurrencySymbol(window.APP?.activeAccount);
                budgetInput.value = symbol === '$' ? '50' : '500';
            }

            // Clear scheduling
            this.setDefaultDateTime();
            
            // Clear URL
            const urlInput = document.getElementById('website-url');
            if (urlInput) urlInput.value = '';

            // Reset campaignData state
            this.campaignData = {
                step1: {},
                step2: { audiences: [] },
                step3: { ads: [], headline: '', description: '', cta: 'SHOP_NOW', pageId: '', instagramId: '', enhancements: {} }
            };
            this._retryState = null;
            this._creationDraftId = '';
            this._copyAutoFilledForUrl = '';
            this._autoFilledCopy = { headline: '', description: '', primaryText: '' };
            
            // Re-render empty audience cards
            const numInput = document.getElementById('num-adsets');
            if (numInput) numInput.value = '5';
            this.updateAudienceCards();

            // Hide creation status
            const statusDiv = document.getElementById('creation-status');
            if (statusDiv) statusDiv.style.display = 'none';
        },

        startCampaignWizardWithData: function(campaignName, url, productTitle, prefilledMedia = null) {
            this.resetWizard();
            
            const nameInput = document.getElementById('campaign-name');
            if (nameInput) nameInput.value = campaignName;
            
            const urlInput = document.getElementById('website-url');
            if (urlInput) urlInput.value = url;

            // Pre-fill clean headline if productTitle is provided
            if (productTitle) {
                const headlineInput = document.getElementById('headline');
                if (headlineInput) {
                    headlineInput.value = this.extractHeadlineName(productTitle);
                }
            }

            // Set CBO/ABO settings based on campaignName suffix
            const isABO = campaignName.endsWith('ABO');
            const aboRadio = document.getElementById('budget-type-abo');
            const cboRadio = document.getElementById('budget-type-cbo');
            if (isABO && aboRadio) {
                aboRadio.checked = true;
            } else if (cboRadio) {
                cboRadio.checked = true;
            }

            // If prefilledMedia is an array, add each element as an ad card
            if (Array.isArray(prefilledMedia) && prefilledMedia.length > 0) {
                this.campaignData.step3.ads = [];
                prefilledMedia.forEach((mediaObj, idx) => {
                    this.addCreativeAd({
                        media: mediaObj.media,
                        mediaFile: mediaObj.mediaFile,
                        previewUrl: mediaObj.previewUrl,
                        thumbnail: mediaObj.thumbnail || '',
                        thumbnailFile: mediaObj.thumbnailFile || '',
                        thumbnailPreviewUrl: mediaObj.thumbnailPreviewUrl || ''
                    }, false);
                });
                this.renderCreativeAds();

                // Trigger copy generation AFTER rendering!
                prefilledMedia.forEach((_, idx) => {
                    this.generateAdCopyForCard(idx);
                });
            } else if (prefilledMedia && prefilledMedia.media) {
                // Single object fallback
                this.campaignData.step3.ads = [];
                this.addCreativeAd({
                    media: prefilledMedia.media,
                    mediaFile: prefilledMedia.mediaFile,
                    previewUrl: prefilledMedia.previewUrl,
                    thumbnail: prefilledMedia.thumbnail || '',
                    thumbnailFile: prefilledMedia.thumbnailFile || '',
                    thumbnailPreviewUrl: prefilledMedia.thumbnailPreviewUrl || ''
                }, true);
                
                // Trigger copy generation AFTER rendering!
                this.generateAdCopyForCard(0);
            }
            
            this.updateStepUI();
            this.renderReviewSummary();
        }
    };

    window.CampaignWizard = CampaignWizard;
    document.addEventListener('DOMContentLoaded', () => { CampaignWizard.init(); });
})();
