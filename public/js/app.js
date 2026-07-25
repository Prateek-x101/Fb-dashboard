// public/js/app.js
(function() {
    window.APP = {
        activeAccount: null,
        accounts: [],
        settings: {}
    };

    const AppController = {
        init: async function() {
            this.setupNavigation();
            this.setupModals();
            this.setupAccountSelector();
            this.setupQuickCreate();
            
            await this.loadInitialData();
            
            // Dispatch event that app is ready
            document.dispatchEvent(new Event('appReady'));
        },

        setupNavigation: function() {
            const navItems = document.querySelectorAll('.nav-item[data-section]');
            
            navItems.forEach(item => {
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    
                    // Update active nav
                    navItems.forEach(nav => nav.classList.remove('active'));
                    item.classList.add('active');
                    
                    // Show target section, hide others
                    const targetSection = item.getAttribute('data-section');
                    if (targetSection === 'section-comments' && window.InboxManager) {
                        setTimeout(() => window.InboxManager.onShow(), 50);
                    }
                    document.querySelectorAll('.section').forEach(sec => {
                        sec.classList.remove('active');
                    });
                    
                    const target = document.getElementById(targetSection);
                    if (target) {
                        target.classList.add('active');
                    }
                });
            });
        },

        setupQuickCreate: function() {
            const btn = document.getElementById('btn-quick-create');
            if (btn) {
                btn.addEventListener('click', () => {
                    // Navigate to campaign creation
                    const campaignNav = document.querySelector('[data-section="section-campaign"]');
                    if (campaignNav) campaignNav.click();
                });
            }
        },

        setupModals: function() {
            // Close modals on clicking overlay
            document.querySelectorAll('.modal-overlay').forEach(overlay => {
                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) {
                        overlay.classList.remove('active');
                    }
                });
            });

            // ESC key to close
            window.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    document.querySelectorAll('.modal-overlay.active').forEach(modal => {
                        modal.classList.remove('active');
                    });
                }
            });
            
            // Close buttons in modals
            document.querySelectorAll('.modal-close, [data-dismiss="modal"]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const modal = e.target.closest('.modal-overlay');
                    if (modal) {
                        modal.classList.remove('active');
                    }
                });
            });

            // Password toggles
            document.querySelectorAll('.password-toggle').forEach(btn => {
                btn.addEventListener('click', function(e) {
                    e.preventDefault();
                    const input = this.closest('.password-input').querySelector('input');
                    if (input) {
                        if (input.type === 'password') {
                            input.type = 'text';
                            this.textContent = '🙈';
                        } else {
                            input.type = 'password';
                            this.textContent = '👁️';
                        }
                    }
                });
            });
        },

        openModal: function(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) {
                modal.classList.add('active');
            }
        },

        closeModal: function(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) {
                modal.classList.remove('active');
            }
        },

        showToast: function(message, type = 'info') {
            const container = document.getElementById('toast-container');
            if (!container) return;

            const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span> ${message}`;
            
            container.appendChild(toast);
            
            // Auto-dismiss after 4 seconds
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(100%)';
                setTimeout(() => {
                    if (container.contains(toast)) {
                        container.removeChild(toast);
                    }
                }, 300);
            }, 4000);
        },

        showLoading: function(elementId) {
            const el = document.getElementById(elementId);
            if (el) {
                el.classList.add('loading');
                el.setAttribute('disabled', 'true');
                el._originalText = el.textContent;
                el.textContent = 'Loading...';
            }
        },

        hideLoading: function(elementId) {
            const el = document.getElementById(elementId);
            if (el) {
                el.classList.remove('loading');
                el.removeAttribute('disabled');
                if (el._originalText) {
                    el.textContent = el._originalText;
                }
            }
        },

        loadInitialData: async function() {
            try {
                // 1. Fetch current settings from server
                let serverSettings = {};
                try {
                    serverSettings = await API.getSettings();
                } catch (e) {
                    console.warn('Settings load failed:', e.message);
                }

                // 2. Fetch ad accounts from server
                let serverAccounts = [];
                try {
                    serverAccounts = await API.getAccounts();
                } catch (e) {
                    console.warn('Accounts load failed:', e.message);
                }

                // 3. Fetch Shopify stores from server
                let serverStores = [];
                try {
                    serverStores = await API.getShopifyStores();
                } catch (e) {
                    console.warn('Shopify stores load failed:', e.message);
                }

                // --- SELF HEALING LOCALSTORAGE RESTORE LOGIC ---
                let restored = false;

                // Restoring Settings
                const localSettings = JSON.parse(localStorage.getItem('fb_dashboard_settings') || '{}');
                if ((!serverSettings || !serverSettings.geminiApiKey) && localSettings && localSettings.geminiApiKey) {
                    console.log('Restoring settings from localStorage backup...');
                    await API.saveSettings(localSettings);
                    serverSettings = localSettings;
                    restored = true;
                }

                // Restoring Ad Accounts
                const localAccounts = JSON.parse(localStorage.getItem('fb_dashboard_accounts') || '[]');
                if ((!serverAccounts || serverAccounts.length === 0) && localAccounts && localAccounts.length > 0) {
                    console.log('Restoring ad accounts from localStorage backup...');
                    for (const acc of localAccounts) {
                        try {
                            await API.addAccount({
                                label: acc.label || acc.name,
                                accountId: acc.accountId,
                                accessToken: acc.accessToken,
                                pageId: acc.pageId
                            });
                        } catch (accErr) {
                            console.error('Failed to restore account:', acc.accountId, accErr.message);
                        }
                    }
                    serverAccounts = await API.getAccounts();
                    restored = true;
                }

                // Restoring Shopify Stores
                const localStores = JSON.parse(localStorage.getItem('fb_dashboard_shopify_stores') || '[]');
                if ((!serverStores || serverStores.length === 0) && localStores && localStores.length > 0) {
                    console.log('Restoring Shopify stores from localStorage backup...');
                    for (const store of localStores) {
                        try {
                            await API.addShopifyStore({
                                name: store.shopName || store.name,
                                shopUrl: store.shopUrl,
                                accessToken: store.accessToken
                            });
                        } catch (storeErr) {
                            console.error('Failed to restore shopify store:', store.shopUrl, storeErr.message);
                        }
                    }
                    serverStores = await API.getShopifyStores();
                    restored = true;
                }

                if (restored) {
                    this.showToast('Dashboard connection restored from browser backup! 🔌✨', 'success');
                }

                // --- UPDATE CLIENT LOCALSTORAGE BACKUP ---
                if (serverSettings && serverSettings.geminiApiKey) {
                    localStorage.setItem('fb_dashboard_settings', JSON.stringify(serverSettings));
                }
                if (serverAccounts && serverAccounts.length > 0) {
                    localStorage.setItem('fb_dashboard_accounts', JSON.stringify(serverAccounts));
                }
                if (serverStores && serverStores.length > 0) {
                    localStorage.setItem('fb_dashboard_shopify_stores', JSON.stringify(serverStores));
                }

                // 4. Save to app memory and update UI
                window.APP.accounts = serverAccounts || [];
                window.APP.settings = serverSettings || {};
                
                this.updateAccountSelector();
                this.updateDashboardStats();
                
                if (window.APP.accounts.length > 0) {
                    window.APP.activeAccount = window.APP.accounts[0];
                    const accountSelector = document.getElementById('sidebar-account-select');
                    if (accountSelector) {
                        accountSelector.value = window.APP.activeAccount.id;
                    }
                }

                // Load recent campaigns for active account
                await this.loadRecentCampaigns();
            } catch (error) {
                console.error('Initial data load error:', error.message);
            }
        },

        setupAccountSelector: function() {
            const selector = document.getElementById('sidebar-account-select');
            if (selector) {
                selector.addEventListener('change', (e) => {
                    const selectedId = e.target.value;
                    const account = window.APP.accounts.find(a => a.id == selectedId);
                    if (account) {
                        window.APP.activeAccount = account;
                        this.showToast(`Switched to ${account.name || account.label || selectedId}`, 'info');
                        document.dispatchEvent(new CustomEvent('accountChanged', { detail: account }));
                        this.loadRecentCampaigns();
                    }
                });
            }
        },

        updateAccountSelector: function() {
            const selector = document.getElementById('sidebar-account-select');
            if (!selector) return;
            
            selector.innerHTML = '';
            if (window.APP.accounts.length === 0) {
                selector.innerHTML = '<option value="">No accounts added</option>';
                return;
            }
            window.APP.accounts.forEach(acc => {
                const option = document.createElement('option');
                option.value = acc.id;
                option.textContent = `${acc.label || acc.name || 'Account'} (${acc.accountId || acc.id})`;
                selector.appendChild(option);
            });
        },

        updateDashboardStats: function() {
            const statsAccounts = document.getElementById('stats-accounts');
            if (statsAccounts) statsAccounts.textContent = window.APP.accounts.length;
        },

        loadRecentCampaigns: async function() {
            try {
                const activeAccountId = window.APP.activeAccount?.accountId || null;
                const campaigns = await API.getRecentCampaigns(activeAccountId);
                const table = document.getElementById('recent-campaigns-table');
                if (!table) return;

                const tbody = table.querySelector('tbody');
                if (!tbody) return;
                
                if (!campaigns || campaigns.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-secondary); padding:2rem;">No campaigns yet. Create your first one! 🚀</td></tr>';
                    return;
                }

                tbody.innerHTML = '';
                campaigns.forEach(c => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${c.name || 'Unnamed'}</td>
                        <td><span class="badge badge-info">${c.status || 'Created'}</span></td>
                        <td>$${c.budget || '0'}</td>
                        <td>${this.formatDate(c.createdAt)}</td>
                    `;
                    tbody.appendChild(tr);
                });
                
                const statsCampaigns = document.getElementById('stats-campaigns');
                if (statsCampaigns) statsCampaigns.textContent = campaigns.length;
            } catch (error) {
                console.log("Could not load recent campaigns:", error.message);
            }
        },

        formatNumber: function(num) {
            return new Intl.NumberFormat().format(num);
        },

        formatDate: function(dateString) {
            if (!dateString) return '—';
            const d = new Date(dateString);
            return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        }
    };

    window.AppController = AppController;

    document.addEventListener('DOMContentLoaded', () => {
        AppController.init();
    });
})();
