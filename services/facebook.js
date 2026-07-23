const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');

const BASE_URL = 'https://graph.facebook.com/v21.0';

async function handleResponse(response) {
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error ? data.error.message : 'Unknown Facebook API Error');
    }
    return data;
}

const facebookService = {
    async createCampaign(accountId, token, params) {
        const url = `${BASE_URL}/act_${accountId}/campaigns?access_token=${token}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        return handleResponse(response);
    },

    async createAdSet(accountId, token, params) {
        const url = `${BASE_URL}/act_${accountId}/adsets?access_token=${token}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        return handleResponse(response);
    },

    async createAdCreative(accountId, token, params) {
        const url = `${BASE_URL}/act_${accountId}/adcreatives?access_token=${token}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        return handleResponse(response);
    },

    async createAd(accountId, token, params) {
        const url = `${BASE_URL}/act_${accountId}/ads?access_token=${token}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        return handleResponse(response);
    },

    async uploadImage(accountId, token, filePath) {
        const url = `${BASE_URL}/act_${accountId}/adimages?access_token=${token}`;
        const form = new FormData();
        form.append('filename', fs.createReadStream(filePath));
        
        const response = await fetch(url, {
            method: 'POST',
            body: form
        });
        return handleResponse(response);
    },

    async uploadVideo(accountId, token, filePath) {
        const url = `${BASE_URL}/act_${accountId}/advideos?access_token=${token}`;
        const form = new FormData();
        form.append('source', fs.createReadStream(filePath));
        
        const response = await fetch(url, {
            method: 'POST',
            body: form
        });
        return handleResponse(response);
    },

    async getPixels(accountId, token) {
        const url = `${BASE_URL}/act_${accountId}/adspixels?fields=id,name&access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async searchInterests(query, token) {
        const url = `${BASE_URL}/search?type=adinterest&q=${encodeURIComponent(query)}&access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async getAdAccounts(token) {
        const url = `${BASE_URL}/me/adaccounts?fields=name,account_id,account_status&access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async getInstagramFromPage(pageId, token) {
        const url = `${BASE_URL}/${pageId}?fields=instagram_business_account{id,name,username,profile_picture_url}&access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async getConnectedInstagram(token) {
        // Get all pages linked to this token and their Instagram accounts
        const url = `${BASE_URL}/me/accounts?fields=id,name,instagram_business_account{id,name,username}&access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    },

    async testConnection(accountId, token) {
        const url = `${BASE_URL}/act_${accountId}?access_token=${token}`;
        const response = await fetch(url, { method: 'GET' });
        return handleResponse(response);
    }
};

module.exports = facebookService;
