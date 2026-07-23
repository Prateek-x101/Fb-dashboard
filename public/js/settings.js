// public/js/settings.js
(function() {
    const SettingsManager = {
        init: function() {
            this.bindEvents();
            document.addEventListener('appReady', () => {
                this.loadSettings();
                this.renderAccounts();
            });
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

            // Add Account button
            const btnAddAcc = document.getElementById('btn-add-account');
            if (btnAddAcc) {
                btnAddAcc.addEventListener('click', () => {
                    const form = document.getElementById('account-form');
                    if (form) form.reset();
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
        },

        loadSettings: async function() {
            try {
                const settings = await window.API.getSettings();
                window.APP.settings = settings;

                const appId = document.getElementById('setting-app-id');
                const appSecret = document.getElementById('setting-app-secret');
                const geminiKey = document.getElementById('setting-gemini-key');
                const geminiModel = document.getElementById('setting-gemini-model');

                if (appId && settings.facebookAppId) appId.value = settings.facebookAppId;
                if (appSecret && settings.facebookAppSecret) appSecret.value = settings.facebookAppSecret;
                if (geminiKey && settings.geminiApiKey) geminiKey.value = settings.geminiApiKey;
                if (geminiModel && settings.geminiModel) geminiModel.value = settings.geminiModel;
                
            } catch (error) {
                console.log("Settings not configured yet");
            }
        },

        saveSettings: async function() {
            const btn = document.getElementById('btn-save-settings');
            if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

            try {
                const data = {
                    facebookAppId: document.getElementById('setting-app-id')?.value || '',
                    facebookAppSecret: document.getElementById('setting-app-secret')?.value || '',
                    geminiApiKey: document.getElementById('setting-gemini-key')?.value || '',
                    geminiModel: document.getElementById('setting-gemini-model')?.value || 'gemini-2.5-flash'
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
                const model = document.getElementById('setting-gemini-model')?.value || 'gemini-2.5-flash';
                if (!apiKey) {
                    window.AppController.showToast('Please enter a Gemini API key first', 'warning');
                    return;
                }
                await window.API.testGemini({ apiKey, model });
                window.AppController.showToast('Gemini connection successful! ✅', 'success');
            } catch (error) {
                window.AppController.showToast('Gemini test failed: ' + error.message, 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '🧪 Test Gemini Connection'; }
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
                const result = await window.API.fetchAccountsFromToken({ accessToken: token });
                const accounts = result.accounts || [];

                if (accounts.length === 0) {
                    window.AppController.showToast('No ad accounts found for this token', 'warning');
                    return;
                }

                // Render account list with checkboxes
                const listEl = document.getElementById('fetched-accounts-list');
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
                const card = document.createElement('div');
                card.className = 'glass-card';
                card.innerHTML = `
                    <div class="flex justify-between align-center mb-2">
                        <h3>${acc.label || acc.name || 'Unknown Account'}</h3>
                        <span class="badge badge-success">Active</span>
                    </div>
                    <p class="mb-1">Account ID: <code style="color:var(--accent-cyan);">act_${acc.accountId || acc.id}</code></p>
                    <p class="mb-1" style="font-size:0.8rem; color:var(--text-secondary);">Page ID: ${acc.pageId || 'Not set'}</p>
                    <p class="mb-3" style="font-size:0.8rem; color:var(--text-secondary);">Token: <span style="color:var(--success);">${this.maskToken(acc.accessToken || acc.token)}</span></p>
                    <div class="flex gap-2">
                        <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window.SettingsManager.testAccountById('${acc.id}')">🧪 Test</button>
                        <button class="btn btn-danger btn-sm" style="flex:1" onclick="window.SettingsManager.deleteAccount('${acc.id}')">🗑️ Delete</button>
                    </div>
                `;
                grid.appendChild(card);
            });
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
                await window.API.addAccount(data);
                window.AppController.showToast('Account added successfully! ✅', 'success');
                window.AppController.closeModal('modal-add-account');
                
                // Refresh accounts
                const accountsData = await window.API.getAccounts();
                window.APP.accounts = accountsData || [];
                this.renderAccounts();
                window.AppController.updateAccountSelector();
                window.AppController.updateDashboardStats();
                if (window.CampaignWizard) window.CampaignWizard.populateAccountSelect();
                
            } catch (error) {
                window.AppController.showToast('Failed to add account: ' + error.message, 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '💾 Save Account'; }
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
        }
    };

    // Expose for inline onclick handlers in renderAccounts
    window.SettingsManager = SettingsManager;

    document.addEventListener('DOMContentLoaded', () => {
        SettingsManager.init();
    });
})();
