// public/js/api.js
(function() {
    const API = {
        async request(endpoint, options = {}) {
            try {
                const response = await fetch(endpoint, {
                    ...options,
                    headers: {
                        'Content-Type': 'application/json',
                        ...(options.headers || {})
                    }
                });
                
                let data;
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('application/json')) {
                    data = await response.json();
                } else {
                    data = await response.text();
                }

                if (!response.ok) {
                    const message = data && typeof data === 'object'
                        ? (data.details || data.message || data.error)
                        : data;
                    const error = new Error(message || `HTTP error! status: ${response.status}`);
                    error.status = response.status;
                    error.data = data;
                    throw error;
                }
                return data;
            } catch (error) {
                console.error(`API Error on ${endpoint}:`, error);
                throw error;
            }
        },

        // Accounts
        getAccounts: () => API.request('/api/accounts'),
        addAccount: (data) => API.request('/api/accounts', { method: 'POST', body: JSON.stringify(data) }),
        updateAccount: (id, data) => API.request(`/api/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
        deleteAccount: (id) => API.request(`/api/accounts/${id}`, { method: 'DELETE' }),
        testAccount: (id) => API.request(`/api/accounts/${id}/test`, { method: 'POST' }),
        fetchAccountsFromToken: (data) => API.request('/api/accounts/fetch-from-token', { method: 'POST', body: JSON.stringify(data) }),
        bulkAddAccounts: (data) => API.request('/api/accounts/bulk-add', { method: 'POST', body: JSON.stringify(data) }),
        fetchInstagram: (id) => API.request(`/api/accounts/${id}/fetch-instagram`, { method: 'POST' }),
        getAllPages: () => API.request('/api/accounts/pages'),
        getPages: (id) => API.request(`/api/accounts/${id}/pages`),
        getAccountBilling: (id) => API.request(`/api/accounts/${id}/billing`),
        getAccountCapabilities: (id) => API.request(`/api/accounts/${id}/capabilities`),
        aiAudiences: (data) => API.request('/api/campaigns/ai-audiences', { method: 'POST', body: JSON.stringify(data) }),

        // Settings
        getSettings: () => API.request('/api/settings'),
        saveSettings: (data) => API.request('/api/settings', { method: 'POST', body: JSON.stringify(data) }),
        testGemini: (data) => API.request('/api/settings/test-gemini', { method: 'POST', body: JSON.stringify(data) }),

        // Campaign
        getPixels: (accountId) => API.request(`/api/campaigns/pixels/${accountId}`),
        searchInterests: (query) => API.request(`/api/campaigns/interests?q=${encodeURIComponent(query)}`),
        searchLocations: (query) => API.request(`/api/campaigns/locations?q=${encodeURIComponent(query)}`),
        searchLanguages: (query) => API.request(`/api/campaigns/languages?q=${encodeURIComponent(query)}`),
        getCustomAudiences: (accountId) => API.request(`/api/campaigns/custom-audiences/${accountId}`),
        createCampaign: (data) => API.request('/api/campaigns/create', { method: 'POST', body: JSON.stringify(data) }),
        generateVariations: (data) => API.request('/api/campaigns/generate-variations', { method: 'POST', body: JSON.stringify(data) }),
        generateAdCopy: (data) => API.request('/api/campaigns/generate-ad-copy', { method: 'POST', body: JSON.stringify(data) }),
        getRecentCampaigns: (accountId) => API.request('/api/campaigns/recent' + (accountId ? `?accountId=${encodeURIComponent(accountId)}` : '')),
        getAccountFeatures: (accountId) => API.request(`/api/campaigns/account-features/${encodeURIComponent(accountId)}`),

        // Media
        uploadMedia: async (formData) => {
            try {
                const response = await fetch('/api/media/upload', {
                    method: 'POST',
                    body: formData
                    // Note: Don't set Content-Type for FormData, browser will set it with boundary
                });
                
                let data;
                if (response.headers.get('content-type')?.includes('application/json')) {
                    data = await response.json();
                } else {
                    data = await response.text();
                }

                if (!response.ok) {
                    throw new Error(data.message || data.error || `HTTP error! status: ${response.status}`);
                }
                return data;
            } catch (error) {
                console.error('API Error on /api/media/upload:', error);
                throw error;
            }
        },
        
        downloadVideoFromUrl: (url, canvasType = 'original') => API.request('/api/media/download-url', {
            method: 'POST',
            body: JSON.stringify({ url, canvasType })
        }),
        getRamStatus: () => API.request('/api/system/ram'),

        // Publisher Tab
        generatePostCaption: (topic, style) => API.request('/api/publish/generate-caption', {
            method: 'POST',
            body: JSON.stringify({ topic, style })
        }),
        publishPost: (data) => API.request('/api/publish/post', {
            method: 'POST',
            body: JSON.stringify(data)
        }),
        
        // Saved Audiences
        getSavedAudiences: () => API.request('/api/settings/saved-audiences'),
        saveSavedAudience: (data) => API.request('/api/settings/saved-audiences', { method: 'POST', body: JSON.stringify(data) }),
        deleteSavedAudience: (id) => API.request(`/api/settings/saved-audiences/${id}`, { method: 'DELETE' }),

        // Inbox (Messages + Comments)
        getInbox: (type) => API.request(`/api/comments/inbox?type=${type || 'all'}`),
        getConversation: (type, id, accountId) => API.request(`/api/comments/conversation?type=${type}&id=${id}&accountId=${accountId}`),
        sendMessage: (data) => API.request('/api/comments/send', { method: 'POST', body: JSON.stringify(data) }),
        replyToComment: (data) => API.request('/api/comments/reply', { method: 'POST', body: JSON.stringify(data) }),
        likeComment: (data) => API.request('/api/comments/like', { method: 'POST', body: JSON.stringify(data) }),
        deleteComment: (commentId, accountId) => API.request(`/api/comments/${commentId}?accountId=${accountId}`, { method: 'DELETE' }),

        // Shopify Importer
        getShopifyStores: () => API.request('/api/shopify/stores'),
        addShopifyStore: (data) => API.request('/api/shopify/stores', { method: 'POST', body: JSON.stringify(data) }),
        deleteShopifyStore: (id) => API.request(`/api/shopify/stores/${id}`, { method: 'DELETE' }),
        scrapeShopifyProduct: (url, storeId) => API.request(`/api/shopify/scrape?url=${encodeURIComponent(url)}&storeId=${storeId}`),
        importShopifyProduct: (data) => API.request('/api/shopify/import', { method: 'POST', body: JSON.stringify(data) })
    };

    window.API = API;
})();
