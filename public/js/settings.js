// public/js/settings.js
(function() {
    const SettingsManager = {
        init: function() {
            this.bindEvents();
            this.wireDefaultExcludeSearch();
            this.bindPostMessageListener();
            document.addEventListener('appReady', () => {
                this.loadSettings();
                this.renderAccounts();
                this.loadShopifyStores();
            });
        },

        bindPostMessageListener: function() {
            window.addEventListener('message', async (event) => {
                if (event.origin !== window.location.origin) return;
                
                const data = event.data;
                if (data.type === 'fb_auth_success') {
                    window.AppController.showToast('Facebook authorization successful! 🔵', 'success');
                    window.AppController.openModal('modal-token-connect');
                    await this.loadAccountsForToken(data.token);
                } else if (data.type === 'fb_auth_error') {
                    window.AppController.showToast('Facebook Login Failed: ' + data.error, 'error');
                }
            });
        },

        loginWithFacebookPopup: function() {
            const width = 600;
            const height = 650;
            const left = (window.screen.width - width) / 2;
            const top = (window.screen.height - height) / 2;
            window.open(
                '/api/accounts/auth/facebook',
                'facebook_login',
                `width=${width},height=${height},left=${left},top=${top},status=no,resizable=yes,scrollbars=yes`
            );
        },

        bindEvents: function() {
            // Settings form
            const btnSave = document.getElementById('btn-save-settings');
            const btnTestGemini = document.getElementById('btn-test-gemini');
            
            if (btnSave) {
                btnSave.addEventListener('click', () => this.saveSettings());
            }
            if (btnTestGemini) {
                btnTestGemini.addEventListener('click', () => this.testGemini());
            }

            // Login with Facebook button
            const btnLoginFb = document.getElementById('btn-login-facebook');
            if (btnLoginFb) {
                btnLoginFb.addEventListener('click', () => this.loginWithFacebookPopup());
            }

            // Add Account button
            const btnAddAcc = document.getElementById('btn-add-account');
            if (btnAddAcc) {
                btnAddAcc.addEventListener('click', () => {
                    const form = document.getElementById('account-form');
                    if (form) form.reset();
                    const hiddenIdInput = document.getElementById('edit-account-id-internal');
                    if (hiddenIdInput) hiddenIdInput.value = '';
                    const titleEl = document.getElementById('modal-account-title');
                    if (titleEl) titleEl.textContent = '➕ Add Facebook Ad Account';
                    const idInput = document.getElementById('account-id');
                    if (idInput) idInput.disabled = false;
                    window.AppController.openModal('modal-add-account');
                });
            }

            // Connect with Token button
            const btnConnectToken = document.getElementById('btn-connect-token');
            if (btnConnectToken) {
                btnConnectToken.addEventListener('click', () => {
                    document.getElementById('token-step-1').style.display = 'block';
                    document.getElementById('token-step-2').style.display = 'none';
                    document.getElementById('token-input').value = '';
                    document.getElementById('token-page-id').value = '';
                    window.AppController.openModal('modal-token-connect');
                });
            }

            // Fetch accounts button (inside token modal)
            const btnFetch = document.getElementById('btn-fetch-accounts');
            if (btnFetch) {
                btnFetch.addEventListener('click', () => this.fetchAccountsFromToken());
            }

            // Back button in token modal step 2
            const btnBackToken = document.getElementById('btn-back-to-token');
            if (btnBackToken) {
                btnBackToken.addEventListener('click', () => {
                    document.getElementById('token-step-1').style.display = 'block';
                    document.getElementById('token-step-2').style.display = 'none';
                });
            }

            // Add selected accounts button
            const btnAddSelected = document.getElementById('btn-add-selected-accounts');
            if (btnAddSelected) {
                btnAddSelected.addEventListener('click', () => this.addSelectedAccounts());
            }
            
            // Save Account button (in modal)
            const btnSaveAcc = document.getElementById('btn-save-account');
            if (btnSaveAcc) {
                btnSaveAcc.addEventListener('click', () => this.saveAccount());
            }

            // Test account connection button
            const btnTestConn = document.getElementById('btn-test-account-connection');
            if (btnTestConn) {
                btnTestConn.addEventListener('click', () => this.testNewAccountConnection());
            }

            // Save Shopify Store button
            const btnAddShopify = document.getElementById('btn-add-shopify-store');
            if (btnAddShopify) {
                btnAddShopify.addEventListener('click', () => this.saveShopifyStore());
            }
        },

        // Wire location search for the "Default Excluded Locations" field in Settings
        wireDefaultExcludeSearch: function() {
            const self = this;
            const input = document.getElementById('setting-default-exclude-search');
            const dropdown = document.getElementById('setting-default-exclude-dropdown');
            const container = document.getElementById('setting-default-exclude-tags');
            if (!input || !dropdown || !container) return;

            let timer;
            input.addEventListener('input', () => {
                clearTimeout(timer);
                const q = input.value.trim();
                if (q.length < 2) { dropdown.style.display = 'none'; return; }
                timer = setTimeout(async () => {
                    try {
                        const results = await window.API.searchLocations(q);
                        self._renderSettingsLocationDropdown(dropdown, container, input, results || []);
                    } catch { dropdown.style.display = 'none'; }
                }, 400);
            });
            input.addEventListener('blur', () => { setTimeout(() => { dropdown.style.display = 'none'; }, 200); });
            document.addEventListener('click', (e) => {
                if (!container.contains(e.target)) dropdown.style.display = 'none';
            });
        },

        _renderSettingsLocationDropdown: function(dropdown, container, input, results) {
            dropdown.innerHTML = '';
            if (!results.length) { dropdown.style.display = 'none'; return; }
            const typeIcon = { country: '🌍', region: '📍', city: '🏙️', zip: '📮' };
            results.slice(0, 15).forEach(r => {
                const item = document.createElement('div');
                item.style.cssText = 'padding:0.6rem 1rem; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.05); display:flex; gap:0.6rem;';
                item.innerHTML = `<span style="margin-top:2px;">${typeIcon[r.type] || '📍'}</span>
                    <div><div style="font-weight:600;">${r.name}</div>
                    <div style="font-size:0.72rem; color:var(--text-secondary);">${r.type}${r.country_code && r.type !== 'country' ? ' · ' + r.country_code : ''}</div></div>`;
                item.addEventListener('mouseenter', () => item.style.background = 'rgba(67,97,238,0.2)');
                item.addEventListener('mouseleave', () => item.style.background = 'transparent');
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    // Avoid duplicates
                    const existing = Array.from(container.querySelectorAll('.location-tag')).map(t => t.getAttribute('data-key'));
                    if (existing.includes(r.key)) return;
                    const tag = document.createElement('span');
                    tag.className = 'tag location-tag';
                    tag.setAttribute('data-key', r.key || '');
                    tag.setAttribute('data-type', r.type || 'region');
                    tag.setAttribute('data-name', r.name);
                    tag.setAttribute('data-value', r.name);
                    const ico = { country: '🌍', region: '📍', city: '🏙️' }[r.type] || '📍';
                    tag.innerHTML = `${r.name} ${ico} <span class="tag-remove" onclick="this.parentElement.remove()">✖</span>`;
                    container.insertBefore(tag, input);
                    input.value = '';
                    dropdown.style.display = 'none';
                });
                dropdown.appendChild(item);
            });
            dropdown.style.display = 'block';
        },

        renderDefaultExcludedTags: function(locations) {
            const container = document.getElementById('setting-default-exclude-tags');
            const input = document.getElementById('setting-default-exclude-search');
            if (!container || !input) return;
            // Remove existing tags
            container.querySelectorAll('.location-tag').forEach(t => t.remove());
            locations.forEach(loc => {
                const tag = document.createElement('span');
                tag.className = 'tag location-tag';
                tag.setAttribute('data-key', loc.key || '');
                tag.setAttribute('data-type', loc.type || 'region');
                tag.setAttribute('data-name', loc.name);
                tag.setAttribute('data-value', loc.name);
                const ico = { country: '🌍', region: '📍', city: '🏙️' }[loc.type] || '📍';
                tag.innerHTML = `${loc.name} ${ico} <span class="tag-remove" onclick="this.parentElement.remove()">✖</span>`;
                container.insertBefore(tag, input);
            });
        },

        loadSettings: async function() {
            try {
                const settings = await window.API.getSettings();
                window.APP.settings = settings;

                const appId = document.getElementById('setting-app-id');
                const appSecret = document.getElementById('setting-app-secret');
                const fbToken = document.getElementById('setting-fb-token');
                const geminiKey = document.getElementById('setting-gemini-key');
                const geminiModel = document.getElementById('setting-gemini-model');

                if (appId && settings.facebookAppId) appId.value = settings.facebookAppId;
                if (appSecret && settings.facebookAppSecret) appSecret.value = settings.facebookAppSecret;
                if (fbToken && settings.facebookAccessToken) fbToken.value = settings.facebookAccessToken;
                if (geminiKey && settings.geminiApiKey) geminiKey.value = settings.geminiApiKey;
                if (geminiModel && settings.geminiModel) geminiModel.value = settings.geminiModel;

                // Load default excluded locations
                if (settings.defaultExcludedLocations) {
                    this.renderDefaultExcludedTags(settings.defaultExcludedLocations);
                }
            } catch (error) {
                console.log("Settings not configured yet");
            }
        },

        saveSettings: async function() {
            const btn = document.getElementById('btn-save-settings');
            if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

            try {
                // Collect default excluded locations from tags
                const defaultExcludedLocations = [];
                document.querySelectorAll('#setting-default-exclude-tags .location-tag').forEach(tag => {
                    defaultExcludedLocations.push({
                        key: tag.getAttribute('data-key') || '',
                        name: tag.getAttribute('data-name') || tag.getAttribute('data-value') || '',
                        type: tag.getAttribute('data-type') || 'region'
                    });
                });

                const data = {
                    facebookAppId: document.getElementById('setting-app-id')?.value || '',
                    facebookAppSecret: document.getElementById('setting-app-secret')?.value || '',
                    facebookAccessToken: document.getElementById('setting-fb-token')?.value || '',
                    geminiApiKey: document.getElementById('setting-gemini-key')?.value || '',
                    geminiModel: document.getElementById('setting-gemini-model')?.value || 'gemini-1.5-flash',
                    defaultExcludedLocations
                };

                await window.API.saveSettings(data);
                window.APP.settings = { ...window.APP.settings, ...data };
                window.AppController.showToast('Settings saved successfully! ✅', 'success');
            } catch (error) {
                window.AppController.showToast('Failed to save settings: ' + error.message, 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '💾 Save All Settings'; }
            }
        },

        testGemini: async function() {
            const btn = document.getElementById('btn-test-gemini');
            if (btn) { btn.disabled = true; btn.textContent = '🧪 Testing...'; }

            try {
                const apiKey = document.getElementById('setting-gemini-key')?.value?.trim();
                const model = document.getElementById('setting-gemini-model')?.value || 'gemini-2.0-flash';
                if (!apiKey) {
                    window.AppController.showToast('Please enter a Gemini API key first', 'warning');
                    return;
                }
                await window.API.testGemini({ apiKey, model });
                window.AppController.showToast('Gemini connection successful! ✅', 'success');
            } catch (error) {
                window.AppController.showToast('❌ ' + error.message, 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '🧪 Test Gemini Connection'; }
            }
        },

        loadAccountsForToken: async function(token) {
            const listEl = document.getElementById('fetched-accounts-list');
            if (listEl) {
                listEl.innerHTML = `
                    <div style="text-align:center; padding:2rem;">
                        <div class="loading-spinner" style="margin: 0 auto;"></div>
                        <p style="color:var(--text-secondary); margin-top:1rem;">Fetching accounts from Facebook...</p>
                    </div>
                `;
            }

            try {
                const result = await window.API.fetchAccountsFromToken({ accessToken: token });
                const accounts = result.accounts || [];

                if (accounts.length === 0) {
                    window.AppController.showToast('No ad accounts found for this token', 'warning');
                    if (listEl) listEl.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:2rem;">No ad accounts found</p>';
                    return;
                }

                // Render account list with checkboxes
                const countEl = document.getElementById('fetched-count');
                if (countEl) countEl.textContent = `${accounts.length} account(s) found`;

                if (listEl) {
                    listEl.innerHTML = '';
                    accounts.forEach((acc, i) => {
                        const statusLabel = acc.account_status === 1 ? '🟢 Active' : '🔴 Inactive';
                        const row = document.createElement('label');
                        row.style.cssText = 'display:flex; align-items:center; gap:0.75rem; padding:0.75rem; border-radius:8px; cursor:pointer; border:1px solid var(--glass-border); margin-bottom:0.5rem; background:rgba(255,255,255,0.03);';
                        row.innerHTML = `
                            <input type="checkbox" class="fetched-acc-checkbox" data-index="${i}" checked style="width:16px;height:16px;accent-color:var(--accent-blue);">
                            <div style="flex:1;">
                                <div style="font-weight:600;">${acc.name || 'Unnamed Account'}</div>
                                <div style="font-size:0.78rem; color:var(--text-secondary);">ID: act_${acc.account_id} &nbsp;|&nbsp; ${statusLabel}</div>
                            </div>
                        `;
                        listEl.appendChild(row);
                    });
                }

                // Store fetched data for use in addSelectedAccounts
                this._fetchedAccounts = accounts;
                this._fetchedToken = token;

                document.getElementById('token-step-1').style.display = 'none';
                document.getElementById('token-step-2').style.display = 'block';

            } catch (error) {
                window.AppController.showToast('Failed to fetch accounts: ' + error.message, 'error');
                if (listEl) listEl.innerHTML = `<p style="text-align:center; color:var(--danger); padding:2rem;">Error: ${error.message}</p>`;
            }
        },

        fetchAccountsFromToken: async function() {
            const token = document.getElementById('token-input')?.value?.trim();
            if (!token) {
                window.AppController.showToast('Please enter an access token', 'warning');
                return;
            }

            const btn = document.getElementById('btn-fetch-accounts');
            if (btn) { btn.disabled = true; btn.textContent = '🔍 Fetching...'; }

            try {
                await this.loadAccountsForToken(token);
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '🔍 Fetch Ad Accounts'; }
            }
        },

        addSelectedAccounts: async function() {
            const checkboxes = document.querySelectorAll('.fetched-acc-checkbox:checked');
            if (checkboxes.length === 0) {
                window.AppController.showToast('Please select at least one account', 'warning');
                return;
            }

            const selectedAccounts = [];
            checkboxes.forEach(cb => {
                const idx = parseInt(cb.getAttribute('data-index'));
                if (this._fetchedAccounts && this._fetchedAccounts[idx]) {
                    selectedAccounts.push(this._fetchedAccounts[idx]);
                }
            });

            const pageId = document.getElementById('token-page-id')?.value?.trim() || '';

            const btn = document.getElementById('btn-add-selected-accounts');
            if (btn) { btn.disabled = true; btn.textContent = '⏳ Adding...'; }

            try {
                const result = await window.API.bulkAddAccounts({
                    accounts: selectedAccounts,
                    accessToken: this._fetchedToken,
                    pageId
                });

                const msg = result.skipped > 0
                    ? `${result.added.length} account(s) added, ${result.skipped} already existed ✅`
                    : `${result.added.length} account(s) added successfully! ✅`;

                window.AppController.showToast(msg, 'success');
                window.AppController.closeModal('modal-token-connect');

                // Refresh everything
                const accountsData = await window.API.getAccounts();
                window.APP.accounts = accountsData || [];
                this.renderAccounts();
                window.AppController.updateAccountSelector();
                window.AppController.updateDashboardStats();
                if (window.CampaignWizard) window.CampaignWizard.populateAccountSelect();

                // Auto-select first account if none active
                if (!window.APP.activeAccount && window.APP.accounts.length > 0) {
                    window.APP.activeAccount = window.APP.accounts[0];
                    const sel = document.getElementById('sidebar-account-select');
                    if (sel) sel.value = window.APP.activeAccount.id;
                }

            } catch (error) {
                window.AppController.showToast('Failed to add accounts: ' + error.message, 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '✅ Add Selected Accounts'; }
            }
        },

        renderAccounts: function() {
            const grid = document.getElementById('accounts-grid');
            if (!grid) return;
            
            if (!window.APP.accounts || window.APP.accounts.length === 0) {
                grid.innerHTML = `
                    <div class="glass-card" style="text-align:center; padding:3rem; grid-column: 1 / -1;">
                        <p style="font-size:3rem; margin-bottom:1rem;">👥</p>
                        <h3>No accounts added yet</h3>
                        <p class="mt-2" style="color:var(--text-secondary);">Add your first Facebook Ad Account to get started</p>
                    </div>
                `;
                return;
            }
            
            grid.innerHTML = '';
            window.APP.accounts.forEach(acc => {
                const igBadge = acc.instagramUsername
                    ? `<span class="badge" style="background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045); color:#fff;">📷 @${acc.instagramUsername}</span>`
                    : `<span class="badge" style="background:rgba(255,255,255,0.08); color:var(--text-secondary);">📷 No Instagram</span>`;
 
                const card = document.createElement('div');
                card.className = 'glass-card';
                card.innerHTML = `
                    <div class="flex justify-between align-center mb-2">
                        <h3>${acc.label || acc.name || 'Unknown Account'}</h3>
                        <span class="badge badge-success">Active</span>
                    </div>
                    <p class="mb-1">Ad Account: <code style="color:var(--accent-cyan);">act_${acc.accountId || acc.id}</code></p>
                    <p class="mb-1" style="font-size:0.8rem; color:var(--text-secondary);">Page ID: ${acc.pageId || '<em>Not set</em>'}</p>
                    <p class="mb-2" style="font-size:0.8rem; color:var(--text-secondary);">Token: <span style="color:var(--success);">${this.maskToken(acc.accessToken || acc.token)}</span></p>
                    <div class="mb-3">${igBadge}</div>
                    <div class="flex gap-2" style="flex-wrap:wrap;">
                        <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window.SettingsManager.editAccount('${acc.id}')">✏️ Edit</button>
                        <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window.SettingsManager.fetchInstagram('${acc.id}')">📷 Fetch Instagram</button>
                        <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window.SettingsManager.testAccountById('${acc.id}')">🧪 Test</button>
                        <button class="btn btn-danger btn-sm" style="flex:1" onclick="window.SettingsManager.deleteAccount('${acc.id}')">🗑️ Delete</button>
                    </div>
                `;
                grid.appendChild(card);
            });
        },

        fetchInstagram: async function(id) {
            window.AppController.showToast('Fetching Instagram account...', 'info');
            try {
                const result = await window.API.fetchInstagram(id);
                if (result.success) {
                    const ig = result.instagram;
                    window.AppController.showToast(`Instagram linked: @${ig.username || ig.name || ig.id} ✅`, 'success');
                    const accountsData = await window.API.getAccounts();
                    window.APP.accounts = accountsData || [];
                    this.renderAccounts();
                } else {
                    window.AppController.showToast(result.message || 'No Instagram Business account found', 'warning');
                }
            } catch (error) {
                window.AppController.showToast('Instagram fetch failed: ' + error.message, 'error');
            }
        },

        maskToken: function(token) {
            if (!token) return 'Not set';
            if (token.length <= 8) return '••••••';
            return token.substring(0, 6) + '••••••' + token.substring(token.length - 4);
        },

        saveAccount: async function() {
            const nameInput = document.getElementById('account-name');
            const idInput = document.getElementById('account-id');
            const tokenInput = document.getElementById('account-token');
            const pageIdInput = document.getElementById('account-page-id');
            const editId = document.getElementById('edit-account-id-internal')?.value;
            
            const data = {
                label: nameInput?.value?.trim() || '',
                accountId: idInput?.value?.trim() || '',
                accessToken: tokenInput?.value?.trim() || '',
                pageId: pageIdInput?.value?.trim() || ''
            };
            
            if (!data.accountId) {
                window.AppController.showToast('Ad Account ID is required', 'warning');
                return;
            }
            if (!data.accessToken) {
                window.AppController.showToast('Access Token is required', 'warning');
                return;
            }

            const btn = document.getElementById('btn-save-account');
            if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

            try {
                if (editId) {
                    await window.API.updateAccount(editId, data);
                    window.AppController.showToast('Account updated successfully! ✅', 'success');
                } else {
                    await window.API.addAccount(data);
                    window.AppController.showToast('Account added successfully! ✅', 'success');
                }
                window.AppController.closeModal('modal-add-account');
                
                // Refresh accounts
                const accountsData = await window.API.getAccounts();
                window.APP.accounts = accountsData || [];
                this.renderAccounts();
                window.AppController.updateAccountSelector();
                window.AppController.updateDashboardStats();
                if (window.CampaignWizard) window.CampaignWizard.populateAccountSelect();
                
            } catch (error) {
                window.AppController.showToast('Failed to save account: ' + error.message, 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = editId ? '💾 Update Account' : '💾 Save Account'; }
            }
        },

        testNewAccountConnection: async function() {
            const idInput = document.getElementById('account-id');
            const tokenInput = document.getElementById('account-token');
            
            if (!idInput?.value || !tokenInput?.value) {
                window.AppController.showToast('Please enter Account ID and Token first', 'warning');
                return;
            }

            const btn = document.getElementById('btn-test-account-connection');
            if (btn) { btn.disabled = true; btn.textContent = '🧪 Testing...'; }

            try {
                // Try to reach Facebook API with these credentials
                const response = await fetch(`/api/accounts/test-connection`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        accountId: idInput.value.trim(),
                        accessToken: tokenInput.value.trim()
                    })
                });
                const data = await response.json();
                
                if (response.ok) {
                    window.AppController.showToast('Connection successful! ✅', 'success');
                } else {
                    window.AppController.showToast('Connection failed: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                window.AppController.showToast('Connection test failed: ' + error.message, 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '🧪 Test Connection'; }
            }
        },

        testAccountById: async function(id) {
            try {
                await window.API.testAccount(id);
                window.AppController.showToast(`Account tested successfully! ✅`, 'success');
            } catch (error) {
                window.AppController.showToast('Account test failed: ' + error.message, 'error');
            }
        },

        editAccount: function(id) {
            const acc = (window.APP.accounts || []).find(a => a.id === id);
            if (!acc) {
                window.AppController.showToast('Account not found', 'error');
                return;
            }
            
            const titleEl = document.getElementById('modal-account-title');
            if (titleEl) titleEl.textContent = '✏️ Edit Facebook Ad Account';
            
            const hiddenIdInput = document.getElementById('edit-account-id-internal');
            if (hiddenIdInput) hiddenIdInput.value = acc.id;
            
            const nameInput = document.getElementById('account-name');
            const idInput = document.getElementById('account-id');
            const tokenInput = document.getElementById('account-token');
            const pageIdInput = document.getElementById('account-page-id');
            
            if (nameInput) nameInput.value = acc.label || acc.name || '';
            if (idInput) {
                idInput.value = acc.accountId || '';
                idInput.disabled = true; // Disable ID modification
            }
            if (pageIdInput) pageIdInput.value = acc.pageId || '';
            if (tokenInput) tokenInput.value = acc.accessToken || '';
            
            const btnSave = document.getElementById('btn-save-account');
            if (btnSave) btnSave.textContent = '💾 Update Account';
            
            window.AppController.openModal('modal-add-account');
        },

        deleteAccount: async function(id) {
            if (confirm('Are you sure you want to delete this account?')) {
                try {
                    await window.API.deleteAccount(id);
                    window.AppController.showToast('Account deleted', 'success');
                    
                    // Refresh
                    const accountsData = await window.API.getAccounts();
                    window.APP.accounts = accountsData || [];
                    this.renderAccounts();
                    window.AppController.updateAccountSelector();
                    window.AppController.updateDashboardStats();
                    
                } catch (error) {
                    window.AppController.showToast('Failed to delete account: ' + error.message, 'error');
                }
            }
        },

        loadShopifyStores: async function() {
            try {
                const stores = await window.API.getShopifyStores();
                this.renderShopifyStores(stores || []);
            } catch (err) {
                console.error("Failed to load shopify stores:", err.message);
            }
        },

        renderShopifyStores: function(stores) {
            const list = document.getElementById('shopify-stores-list');
            if (!list) return;
            list.innerHTML = '';
            
            if (!stores.length) {
                list.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:12px; color:var(--text-secondary);">No Shopify stores configured.</td></tr>`;
                return;
            }
            
            stores.forEach(s => {
                const tr = document.createElement('tr');
                tr.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
                tr.innerHTML = `
                    <td style="padding:10px 4px; border:none; font-weight:600; color:white;">${this.escapeHtml(s.name)}</td>
                    <td style="padding:10px 4px; border:none; color:var(--text-secondary);">${this.escapeHtml(s.shopUrl)}</td>
                    <td style="padding:10px 4px; border:none; text-align:right;">
                        <button class="btn btn-secondary btn-xs" onclick="window.SettingsManager.deleteShopifyStore('${s.id}')" style="background:rgba(239,71,111,0.15); color:var(--danger-color); border-color:rgba(239,71,111,0.25);">✖ Delete</button>
                    </td>
                `;
                list.appendChild(tr);
            });
        },

        saveShopifyStore: async function() {
            const nameEl = document.getElementById('shopify-store-name');
            const urlEl = document.getElementById('shopify-store-url');
            const tokenEl = document.getElementById('shopify-store-token');
            if (!nameEl || !urlEl || !tokenEl) return;
            
            const name = nameEl.value.trim();
            const shopUrl = urlEl.value.trim();
            const accessToken = tokenEl.value.trim();
            
            if (!name || !shopUrl || !accessToken) {
                window.AppController.showToast('Please fill all Shopify store details.', 'warning');
                return;
            }
            
            try {
                window.AppController.showToast('Saving Shopify store config...', 'info');
                const res = await window.API.addShopifyStore({ name, shopUrl, accessToken });
                window.AppController.showToast('Shopify store saved successfully! ✅', 'success');
                
                // Clear fields
                nameEl.value = '';
                urlEl.value = '';
                tokenEl.value = '';
                
                this.renderShopifyStores(res.shopifyStores || []);
                
                // If there is a shopify target store selector on the import page, reload it!
                if (window.ShopifyImporter && typeof window.ShopifyImporter.loadStoresSelect === 'function') {
                    window.ShopifyImporter.loadStoresSelect();
                }
            } catch (error) {
                window.AppController.showToast('Failed to save Shopify store config: ' + error.message, 'error');
            }
        },

        deleteShopifyStore: async function(id) {
            if (confirm('Are you sure you want to delete this Shopify store?')) {
                try {
                    const res = await window.API.deleteShopifyStore(id);
                    window.AppController.showToast('Shopify store deleted', 'success');
                    this.renderShopifyStores(res.shopifyStores || []);
                    
                    // Reload select dropdown
                    if (window.ShopifyImporter && typeof window.ShopifyImporter.loadStoresSelect === 'function') {
                        window.ShopifyImporter.loadStoresSelect();
                    }
                } catch (error) {
                    window.AppController.showToast('Failed to delete store: ' + error.message, 'error');
                }
            }
        },

        escapeHtml: function(value) {
            return String(value).replace(/[&<>"']/g, char => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
            }[char]));
        }
    };

    // Expose for inline onclick handlers in renderAccounts
    window.SettingsManager = SettingsManager;

    document.addEventListener('DOMContentLoaded', () => {
        SettingsManager.init();
    });
})();
