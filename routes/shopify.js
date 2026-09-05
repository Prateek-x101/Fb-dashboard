const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const geminiService = require('../services/gemini');
const fetch = require('node-fetch');
const { getStorage, saveStorage } = require('../services/storage');
const imageTranslator = require('../services/imageTranslator');

// Multer for video uploads in this route
const videoUpload = multer({
    dest: path.join(__dirname, '..', 'uploads'),
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

function generateCleanHandle(title) {
    if (!title) return '';
    
    // Remove all emojis and non-alphanumeric chars
    let clean = title.replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDC00-\uDFFF]/g, '');
    clean = clean.toLowerCase();
    
    // Remove common promotional keywords
    const promoWords = [
        'limited-time', 'limited time', 'sale', 'off', 'subsidy', 'discount', 'free shipping', 'shipping', 'new', 
        'hot', 'deal', 'promo', 'exclusive', 'special', 'best', 'quality', 'price', 'low', 'cheap', 'click', 
        'buy', 'shop', 'order', 'gift', 'coupon', 'code', 'save', 'saving', 'percent', 'percentage', 'original',
        'luxury', 'premium', 'trending', 'viral', 'top', 'rated', 'review', 'guarantee', 'warranty', 'ship',
        'subsidies', 'limited', 'time', 'heat', 'summer'
    ];
    
    // Replace numbers followed by % off (e.g. 56% off, 50%off)
    clean = clean.replace(/\d+\s*%?\s*off/g, '');
    
    let words = clean.split(/\s+/);
    words = words.filter(w => {
        const cleanW = w.replace(/[^a-z0-9]/g, '');
        if (!cleanW) return false;
        return !promoWords.includes(cleanW) && cleanW.length > 2;
    });

    // Keep 3 to 5 words for a concise, meaningful handle
    const meaningfulWords = words.slice(0, 5).join('-');
    return meaningfulWords.replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function normalizeSuggestedCollectionIds(rawSuggestion, collections) {
    let suggestions = rawSuggestion;
    if (typeof suggestions === 'string') {
        const cleaned = suggestions.replace(/```json/gi, '').replace(/```/g, '').trim();
        suggestions = JSON.parse(cleaned);
    }
    if (!Array.isArray(suggestions)) return [];

    const byId = new Map(collections.map(collection => [String(collection.id), collection.id]));
    const byTitle = new Map(collections.map(collection => [String(collection.title).trim().toLowerCase(), collection.id]));

    return [...new Set(suggestions.map(item => {
        if (item && typeof item === 'object') {
            item = item.id ?? item.collectionId ?? item.title ?? item.name;
        }
        if (item === undefined || item === null) return null;
        const value = String(item).trim();
        return byId.get(value) ?? byTitle.get(value.toLowerCase()) ?? null;
    }).filter(Boolean))];
}

// 1. Get all shopify stores
router.get('/stores', (req, res) => {
    try {
        const storage = getStorage();
        res.json(storage.shopifyStores || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to read Shopify stores settings', details: error.message });
    }
});

// 2. Add or update shopify store
router.post('/stores', (req, res) => {
    try {
        const { id, name, shopUrl, accessToken } = req.body;
        if (!name || !shopUrl || !accessToken) {
            return res.status(400).json({ error: 'Store Name, URL, and Admin API Access Token are required.' });
        }
        
        // Clean URL to subdomain.myshopify.com
        let cleanedUrl = shopUrl.replace(/https?:\/\//, '').split('/')[0].trim();
        if (!cleanedUrl.endsWith('.myshopify.com')) {
            cleanedUrl = `${cleanedUrl}.myshopify.com`;
        }

        const storage = getStorage();
        if (!storage.shopifyStores) storage.shopifyStores = [];

        if (id) {
            // Update
            const index = storage.shopifyStores.findIndex(s => s.id === id);
            if (index !== -1) {
                storage.shopifyStores[index] = { id, name, shopUrl: cleanedUrl, accessToken };
            } else {
                storage.shopifyStores.push({ id, name, shopUrl: cleanedUrl, accessToken });
            }
        } else {
            // Insert new
            storage.shopifyStores.push({
                id: uuidv4(),
                name,
                shopUrl: cleanedUrl,
                accessToken
            });
        }

        saveStorage(storage);
        res.json({ success: true, shopifyStores: storage.shopifyStores });
    } catch (error) {
        res.status(500).json({ error: 'Failed to save Shopify store config', details: error.message });
    }
});

// 3. Delete shopify store
router.delete('/stores/:id', (req, res) => {
    try {
        const { id } = req.params;
        const storage = getStorage();
        if (!storage.shopifyStores) storage.shopifyStores = [];
        storage.shopifyStores = storage.shopifyStores.filter(s => s.id !== id);
        saveStorage(storage);
        res.json({ success: true, shopifyStores: storage.shopifyStores });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete Shopify store config', details: error.message });
    }
});

// Helper: Upload file to Shopify Files using GraphQL
async function uploadFileToShopify(shopUrl, accessToken, localFilePath, filename) {
    const FormData = require('form-data');
    const graphqlUrl = `https://${shopUrl}/admin/api/2024-04/graphql.json`;
    
    // 1. stagedUploadsCreate mutation to get signed upload URL
    const stagedQuery = {
        query: `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
            stagedUploadsCreate(input: $input) {
                stagedTargets {
                    url
                    resourceUrl
                    parameters {
                        name
                        value
                    }
                }
                userErrors {
                    field
                    message
                }
            }
        }`,
        variables: {
            input: [{
                resource: "VIDEO",
                filename: filename,
                mimeType: "video/mp4",
                fileSize: String(fs.statSync(localFilePath).size)
            }]
        }
    };

    const stagedRes = await fetch(graphqlUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken
        },
        body: JSON.stringify(stagedQuery)
    });
    const stagedData = await stagedRes.json();
    if (stagedData.errors || stagedData.data?.stagedUploadsCreate?.userErrors?.length) {
        throw new Error(`stagedUploadsCreate failed: ${JSON.stringify(stagedData)}`);
    }

    const target = stagedData.data.stagedUploadsCreate.stagedTargets[0];
    
    // 2. Post file to S3
    const formData = new FormData();
    target.parameters.forEach(p => {
        formData.append(p.name, p.value);
    });
    formData.append('file', fs.createReadStream(localFilePath));

    const s3Res = await fetch(target.url, {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders()
    });
    if (!s3Res.ok) {
        const s3Text = await s3Res.text();
        throw new Error(`S3 upload failed: ${s3Text}`);
    }

    // 3. fileCreate mutation to register video in Shopify Files
    const createQuery = {
        query: `mutation fileCreate($files: [FileCreateInput!]!) {
            fileCreate(files: $files) {
                files {
                    id
                }
                userErrors {
                    field
                    message
                }
            }
        }`,
        variables: {
            files: [{
                alt: "Floating Video",
                contentType: "VIDEO",
                originalSource: target.resourceUrl
            }]
        }
    };

    const registerRes = await fetch(graphqlUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken
        },
        body: JSON.stringify(createQuery)
    });
    const registerData = await registerRes.json();
    if (registerData.errors || registerData.data?.fileCreate?.userErrors?.length) {
        throw new Error(`fileCreate failed: ${JSON.stringify(registerData)}`);
    }

    const fileId = registerData.data.fileCreate.files[0]?.id;
    return fileId;
}

const metafieldTypeCache = new Map();

// Helper: Query definition of custom.floating_videos metafield to detect if it's file_reference or list.file_reference
async function getFloatingVideoMetafieldType(shopUrl, accessToken) {
    const cacheKey = `${shopUrl}`;
    if (metafieldTypeCache.has(cacheKey)) {
        return metafieldTypeCache.get(cacheKey);
    }
    try {
        const graphqlUrl = `https://${shopUrl}/admin/api/2024-04/graphql.json`;
        const res = await fetch(graphqlUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': accessToken
            },
            body: JSON.stringify({
                query: `query {
                    metafieldDefinitions(first: 50, ownerType: PRODUCT) {
                        edges {
                            node {
                                namespace
                                key
                                type {
                                    name
                                }
                            }
                        }
                    }
                }`
            })
        });
        if (res.ok) {
            const data = await res.json();
            const defs = data.data?.metafieldDefinitions?.edges || [];
            const match = defs.find(e => e.node.namespace === 'custom' && e.node.key === 'floating_videos');
            if (match) {
                const typeName = match.node.type.name; // e.g. "file_reference" or "list.file_reference"
                metafieldTypeCache.set(cacheKey, typeName);
                return typeName;
            }
        }
    } catch (e) {
        console.error('Failed to query metafield definitions:', e.message);
    }
    return 'list.file_reference'; // default fallback supporting multiple videos
}

// Helper: Fetch collections from User's Shopify Store
async function fetchUserCollections(shopUrl, accessToken) {
    const collections = [];
    try {
        // Fetch Smart Collections
        const smartUrl = `https://${shopUrl}/admin/api/2024-04/smart_collections.json?limit=250`;
        const smartRes = await fetch(smartUrl, {
            headers: { 'X-Shopify-Access-Token': accessToken }
        });
        if (smartRes.ok) {
            const data = await smartRes.json();
            if (data.smart_collections) {
                const smart_collections = data.smart_collections.map(c => ({ id: c.id, title: c.title }));
                collections.push(...smart_collections);
            }
        }

        // Fetch Custom Collections
        const customUrl = `https://${shopUrl}/admin/api/2024-04/custom_collections.json?limit=250`;
        const customRes = await fetch(customUrl, {
            headers: { 'X-Shopify-Access-Token': accessToken }
        });
        if (customRes.ok) {
            const data = await customRes.json();
            if (data.custom_collections) {
                const custom_collections = data.custom_collections.map(c => ({ id: c.id, title: c.title }));
                collections.push(...custom_collections);
            }
        }
    } catch (e) {
        console.error('Failed to fetch user shopify collections:', e.message);
    }
    return collections;
}

// 4a. Fetch collections for a store (used by VTL flow without needing a product URL)
router.get('/collections', async (req, res) => {
    try {
        const { storeId } = req.query;
        if (!storeId) return res.status(400).json({ error: 'storeId is required.' });

        const storage = getStorage();
        const store = (storage.shopifyStores || []).find(s => s.id === storeId);
        if (!store) return res.status(400).json({ error: 'Store not found.' });

        const collections = await fetchUserCollections(store.shopUrl, store.accessToken);
        res.json({ success: true, collections });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch collections', details: error.message });
    }
});

// 4. Scrape Product Details and fetch suggested collections
router.get('/scrape', async (req, res) => {
    try {
        const { url, storeId, autoTranslateImages } = req.query;
        if (!url || !storeId) {
            return res.status(400).json({ error: 'Product URL and storeId are required.' });
        }

        // Convert Product URL to .js JSON URL
        let jsUrl = url.split('?')[0].replace(/\/$/, '');
        if (!jsUrl.endsWith('.js')) {
            jsUrl = `${jsUrl}.js`;
        }

        const scrapeRes = await fetch(jsUrl);
        if (!scrapeRes.ok) {
            throw new Error(`Failed to scrape target product page. Shopify returned status ${scrapeRes.status}`);
        }
        const product = await scrapeRes.json();

        // Get Shopify Store credentials
        const storage = getStorage();
        const store = (storage.shopifyStores || []).find(s => s.id === storeId);
        if (!store) {
            return res.status(400).json({ error: 'Selected store not found.' });
        }

        // Fetch user store's collections
        const userCollections = await fetchUserCollections(store.shopUrl, store.accessToken);

        // Get Gemini API Key to suggest collections
        const geminiApiKey = storage.settings?.geminiApiKey;
        const geminiModel = storage.settings?.geminiModel || 'gemini-1.5-flash';

        if (geminiApiKey) {
            await translateProductToEnglish(product, geminiApiKey, geminiModel, true);
        }

        let suggestedCollectionIds = [];

        if (geminiApiKey && userCollections.length > 0) {
            try {
                const prompt = `You are a collection classifier. Map this product to the most relevant collections from the user's shopify store.
Product details:
Title: ${product.title}
Type: ${product.type || ''}
Tags: ${Array.isArray(product.tags) ? product.tags.join(', ') : ''}
Description: ${product.description || ''}

Available Collections List (ID and Title):
${userCollections.map(c => `ID: ${c.id}, Title: ${c.title}`).join('\n')}

Based on the details, identify which collections match this product. Return ONLY a valid JSON array of matched collection IDs, e.g., ["12345", "67890"]. Do not include any markdown format, markdown tags, backticks or explanation. Return raw JSON.`;

                const suggestion = await geminiService.generateResponseText(geminiApiKey, geminiModel, prompt);
                suggestedCollectionIds = normalizeSuggestedCollectionIds(suggestion, userCollections);
            } catch (err) {
                console.error('Failed to run Gemini collections suggestion:', err.message);
            }
        }

        res.json({
            product: {
                title: product.title,
                description: product.description,
                vendor: product.vendor,
                type: product.type,
                tags: product.tags,
                options: product.options,
                images: product.images,
                variants: product.variants
            },
            userCollections,
            suggestedCollectionIds
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to scrape or analyze product link', details: error.message });
    }
});

// 5. Import Product to user's Shopify store
router.post('/import', async (req, res) => {
    try {
        const { storeId, product, skuPrefix, price, comparePrice, collectionIds, floatingVideos, imageAssignments } = req.body;
        if (!storeId || !product || !skuPrefix) {
            return res.status(400).json({ error: 'Missing required parameters for Shopify import.' });
        }

        // Get Shopify Store credentials
        const storage = getStorage();
        const store = (storage.shopifyStores || []).find(s => s.id === storeId);
        if (!store) {
            return res.status(400).json({ error: 'Selected shopify store config not found.' });
        }

        console.log(`Starting Shopify product import to ${store.shopUrl} for "${product.title}"`);

        // Fetch shop details early to get the primary custom domain (e.g. www.sassyclothes.co.in) and store name
        let actualDomain = store.shopUrl;
        let shopName = store.shopName || "Scraped Product";
        try {
            const shopUrl = `https://${store.shopUrl}/admin/api/2024-04/shop.json`;
            const shopRes = await fetch(shopUrl, {
                headers: {
                    'X-Shopify-Access-Token': store.accessToken
                }
            });
            if (shopRes.ok) {
                const shopData = await shopRes.json();
                if (shopData.shop) {
                    if (shopData.shop.domain) actualDomain = shopData.shop.domain;
                    if (shopData.shop.name) shopName = shopData.shop.name;
                }
            }
        } catch (shopErr) {
            console.error('Failed to fetch shop details from Shopify:', shopErr.message);
        }

        // Formulate options
        const options = (product.options || []).map(opt => ({
            name: opt.name,
            values: opt.values
        }));

        // Formulate variants and generate SKUs
        const variants = (product.variants || []).map(v => {
            const cleanOpt1 = cleanOptionForSku(v.option1);
            const cleanOpt2 = cleanOptionForSku(v.option2);
            const cleanOpt3 = cleanOptionForSku(v.option3);

            const opt1 = cleanOpt1;
            const opt2 = cleanOpt2 ? '-' + cleanOpt2 : '';
            const opt3 = cleanOpt3 ? '-' + cleanOpt3 : '';
            const generatedSku = `${skuPrefix}-${opt1}${opt2}${opt3}`.replace(/-+/g, '-').replace(/-$/, '');

            // Use the variant's custom price if it's passed as a string/number from frontend, 
            // otherwise fallback to global price, otherwise fallback to original scraped price (scraped values are in cents, so we divide by 100)
            let finalPrice = '';
            if (v.price !== undefined && v.price !== null && v.price !== '') {
                if (typeof v.price === 'number') {
                    finalPrice = (v.price / 100).toFixed(2);
                } else {
                    finalPrice = String(v.price);
                }
            }
            if (price) finalPrice = String(price); // Global override

            let finalComparePrice = null;
            if (v.compare_at_price !== undefined && v.compare_at_price !== null && v.compare_at_price !== '') {
                if (typeof v.compare_at_price === 'number') {
                    finalComparePrice = (v.compare_at_price / 100).toFixed(2);
                } else {
                    finalComparePrice = String(v.compare_at_price);
                }
            }
            if (comparePrice) finalComparePrice = String(comparePrice); // Global override

            return {
                option1: v.option1 || null,
                option2: v.option2 || null,
                option3: v.option3 || null,
                price: finalPrice,
                compare_at_price: finalComparePrice,
                sku: generatedSku,
                taxable: false
            };
        });

        // Check if the listing is fashion-related to append size chart
        let isFashion = false;
        if (Array.isArray(product.options)) {
            const hasSizeOption = product.options.some(opt => 
                opt.name && /size|größe|taille|talla/i.test(opt.name)
            );
            if (hasSizeOption) isFashion = true;
        }
        const fashionKeywords = /apparel|clothing|shirt|dress|pants|shoes|hoodies|jacket|underwear|socks|fashion|outerwear|t-shirt|top|bottom|jeans|sweater|sneakers|sandals|boots|garment/i;
        if (product.type && fashionKeywords.test(product.type)) isFashion = true;
        if (product.title && fashionKeywords.test(product.title)) isFashion = true;
        if (Array.isArray(product.tags) && product.tags.some(t => fashionKeywords.test(t))) isFashion = true;

        if (isFashion && Array.isArray(storage.settings?.defaultSizeCharts) && storage.settings.defaultSizeCharts.length > 0) {
            console.log(`[ShopifyImport] Fashion listing detected. Appending ${storage.settings.defaultSizeCharts.length} default size chart image(s).`);
            if (!Array.isArray(product.images)) product.images = [];
            storage.settings.defaultSizeCharts.forEach(scPath => {
                if (!product.images.includes(scPath)) {
                    product.images.push(scPath);
                }
            });
        }

        // Formulate images (append https: if start with //)
        // Formulate images: support external URLs and local /uploads/ files (send as base64 attachment)
        const images = (product.images || []).map((imgUrl, idx) => {
            if (imgUrl.startsWith('/uploads/')) {
                const filePath = path.join(__dirname, '..', imgUrl.replace(/^\//, ''));
                if (fs.existsSync(filePath)) {
                    return {
                        attachment: fs.readFileSync(filePath).toString('base64'),
                        filename: path.basename(filePath),
                        position: idx + 1
                    };
                }
            }
            const src = imgUrl.startsWith('//') ? 'https:' + imgUrl : imgUrl;
            return { src, position: idx + 1 };
        });

        // Handle optional floating videos upload
        const metafields = [];
        let videoUploadError = null;
        if (Array.isArray(floatingVideos) && floatingVideos.length > 0) {
            try {
                console.log(`Uploading ${floatingVideos.length} Floating Video(s) to Shopify...`);
                // Upload all videos in parallel
                const uploadPromises = floatingVideos.map(async (vid) => {
                    if (vid.filePath && fs.existsSync(vid.filePath)) {
                        const fileId = await uploadFileToShopify(store.shopUrl, store.accessToken, vid.filePath, vid.filename || path.basename(vid.filePath));
                        return fileId;
                    } else {
                        throw new Error(`Video file "${vid.filename || 'unknown.mp4'}" was not found on server disk. Please re-download it.`);
                    }
                });
                
                const uploadResults = await Promise.allSettled(uploadPromises);
                const fileIds = [];
                
                uploadResults.forEach((r, idx) => {
                    if (r.status === 'fulfilled' && r.value) {
                        fileIds.push(r.value);
                    } else if (r.status === 'rejected') {
                        videoUploadError = r.reason?.message || 'Unknown S3/GraphQL error';
                        console.error(`Video upload ${idx} failed:`, r.reason);
                    }
                });
                
                if (fileIds.length > 0) {
                    // Get the exact metafield definition type
                    const metafieldType = await getFloatingVideoMetafieldType(store.shopUrl, store.accessToken);
                    console.log(`Detected custom.floating_videos metafield type: ${metafieldType}`);
                    
                    const value = metafieldType.includes('list') ? JSON.stringify(fileIds) : fileIds[0];
                    
                    metafields.push({
                        namespace: 'custom',
                        key: 'floating_videos',
                        value: value,
                        type: metafieldType
                    });
                }
            } catch (err) {
                videoUploadError = err.message;
                console.error('Failed to upload floating videos to Shopify Files:', err.message);
            }
        }

        // Create product payload with clean handle and store vendor name
        const productPayload = {
            product: {
                title: product.title,
                body_html: product.description,
                vendor: shopName,
                product_type: product.type || "",
                tags: Array.isArray(product.tags) ? product.tags.join(",") : (product.tags || ""),
                images: images,
                variants: variants,
                options: options,
                status: "active",
                handle: product.handle ? product.handle.trim() : generateCleanHandle(product.title),
                metafields: metafields.length > 0 ? metafields : undefined
            }
        };

        // Create product in Shopify
        const createUrl = `https://${store.shopUrl}/admin/api/2024-04/products.json`;
        const createRes = await fetch(createUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': store.accessToken
            },
            body: JSON.stringify(productPayload)
        });

        if (!createRes.ok) {
            const errBody = await createRes.text();
            throw new Error(`Shopify API product creation failed: ${errBody}`);
        }

        const createData = await createRes.json();
        const createdProduct = createData.product;
        const createdProductId = createdProduct.id;

        console.log(`Product created successfully with ID: ${createdProductId}`);

        // Update product description in Shopify to replace any local /uploads/ URLs with live Shopify CDN URLs!
        const createdImages = createdProduct.images || [];
        let updatedBodyHtml = product.description || '';
        let hasLocalUploads = false;

        createdImages.forEach(cImg => {
            const originalLocalUrl = (product.images || [])[cImg.position - 1];
            if (originalLocalUrl && originalLocalUrl.includes('/uploads/')) {
                const baseName = path.basename(originalLocalUrl);
                [originalLocalUrl, `/uploads/${baseName}`, baseName].forEach(pat => {
                    if (updatedBodyHtml.includes(pat)) {
                        updatedBodyHtml = updatedBodyHtml.split(pat).join(cImg.src);
                        hasLocalUploads = true;
                    }
                });
            }
        });

        if (hasLocalUploads) {
            console.log(`[ShopifyImport] Updating product description with live Shopify CDN image URLs...`);
            try {
                await fetch(`https://${store.shopUrl}/admin/api/2024-04/products/${createdProductId}.json`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Shopify-Access-Token': store.accessToken
                    },
                    body: JSON.stringify({
                        product: {
                            id: createdProductId,
                            body_html: updatedBodyHtml
                        }
                    })
                });
                console.log(`[ShopifyImport] Successfully updated body_html with Shopify CDN images!`);
            } catch (descUpdateErr) {
                console.warn('[ShopifyImport] Could not update body_html with CDN images:', descUpdateErr.message);
            }
        }

        // Associate variants with images based on assignments
        if (imageAssignments && Object.keys(imageAssignments).length > 0) {
            const createdImages = createdProduct.images || [];
            const createdVariants = createdProduct.variants || [];
            const variantImageUpdates = [];

            const normalizeVal = (val) => {
                if (!val) return '';
                return String(val)
                    .replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF]/g, '') // remove emojis
                    .replace(/[^a-zA-Z0-9]/g, '') // remove non-alphanumeric
                    .toLowerCase()
                    .trim();
            };

            for (const createdImg of createdImages) {
                // Get the original image URL/path using the position (1-indexed)
                const originalUrl = (product.images || [])[createdImg.position - 1];
                if (!originalUrl) continue;

                // Find matching key in imageAssignments
                const matchedKey = Object.keys(imageAssignments).find(key => {
                    return key === originalUrl || 
                           key.split('?')[0] === originalUrl.split('?')[0] ||
                           path.basename(key) === path.basename(originalUrl);
                });

                if (matchedKey) {
                    const targetValue = imageAssignments[matchedKey];
                    const targetNorm = normalizeVal(targetValue);

                    // Find matching variants that contain this option value (normalised to strip emojis, spacing, case differences)
                    const matchingVariants = createdVariants.filter(v => 
                        normalizeVal(v.option1) === targetNorm || 
                        normalizeVal(v.option2) === targetNorm || 
                        normalizeVal(v.option3) === targetNorm
                    );

                    for (const mv of matchingVariants) {
                        variantImageUpdates.push({
                            variantId: mv.id,
                            imageId: createdImg.id
                        });
                    }
                }
            }

            if (variantImageUpdates.length > 0) {
                console.log(`Linking ${variantImageUpdates.length} variant images in Shopify sequentially to avoid rate limits...`);
                // Update variant image linking sequentially with a 250ms delay to prevent 429 rate limits
                for (const update of variantImageUpdates) {
                    const variantUrl = `https://${store.shopUrl}/admin/api/2024-04/variants/${update.variantId}.json`;
                    try {
                        const vRes = await fetch(variantUrl, {
                            method: 'PUT',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Shopify-Access-Token': store.accessToken
                            },
                            body: JSON.stringify({
                                variant: {
                                    id: update.variantId,
                                    image_id: update.imageId
                                }
                            })
                        });
                        if (!vRes.ok) {
                            console.warn(`[ShopifyImport] Failed to link variant ${update.variantId} to image ${update.imageId}: ${vRes.status} ${vRes.statusText}`);
                        } else {
                            console.log(`[ShopifyImport] Successfully linked variant ${update.variantId} to image ${update.imageId}`);
                        }
                        // 250ms spacing to stay safe under Shopify's 2 req/sec REST bucket leak rate
                        await new Promise(r => setTimeout(r, 250));
                    } catch (err) {
                        console.warn(`[ShopifyImport] Error linking variant ${update.variantId}:`, err.message);
                    }
                }
            }
        }

        // Link product to selected collections in parallel
        if (Array.isArray(collectionIds) && collectionIds.length > 0) {
            console.log(`Linking product to ${collectionIds.length} collections in parallel...`);
            const collectPromises = collectionIds.map(async (collId) => {
                const collectUrl = `https://${store.shopUrl}/admin/api/2024-04/collects.json`;
                const r = await fetch(collectUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Shopify-Access-Token': store.accessToken
                    },
                    body: JSON.stringify({
                        collect: {
                            collection_id: collId,
                            product_id: createdProductId
                        }
                    })
                });
                if (!r.ok) {
                    console.warn(`Failed to associate product with collection ${collId}: ${await r.text()}`);
                }
            });
            await Promise.allSettled(collectPromises);
        }

        const productUrl = `https://${actualDomain}/products/${createdProduct.handle}`;
        res.json({ success: true, productId: createdProductId, title: createdProduct.title, productUrl, warning: videoUploadError });
    } catch (error) {
        res.status(500).json({ error: 'Failed to import product to Shopify', details: error.message });
    }
});

// 6. AI description enhancer/recreator
router.post('/ai-description', async (req, res) => {
    try {
        const { action, description, productTitle, images } = req.body;
        if (!description || !action) {
            return res.status(400).json({ error: 'Description and action are required.' });
        }

        const storage = getStorage();
        const geminiApiKey = storage.settings?.geminiApiKey;
        const geminiModel = storage.settings?.geminiModel || 'gemini-1.5-flash';

        if (!geminiApiKey) {
            return res.status(400).json({ error: 'Gemini API Key is not configured. Please add it in Settings.' });
        }

        let imagesContext = '';
        if (Array.isArray(images) && images.length > 0) {
            // Clean up image URLs (prepend https: if protocol relative)
            const cleanedImages = images.map(img => img.startsWith('//') ? 'https:' + img : img);
            imagesContext = `

Here is a list of available product image URLs that you MUST insert into the description HTML:
${cleanedImages.map((img, i) => `- Image URL ${i + 1}: ${img}`).join('\n')}

IMPORTANT IMAGE RULES:
1. Position 1 to 4 of these image URLs (depending on how many are available in the list) at natural, high-converting places in the description HTML (e.g., one below the main headline/hook, one near specification lists, and one before the satisfaction guarantee).
2. For each image you insert, you MUST output this exact HTML markup:
<img src="IMAGE_URL" style="max-width: 100%; display: block; margin: 15px auto; border-radius: 8px;" />
Replace IMAGE_URL with the exact URL from the list above. Do not modify, trim, or invent URLs.
3. If the input HTML already contains <img> tags, prioritize keeping and styling them, but feel free to add more from the list if needed to make the description look extremely premium.`;
        }

        let prompt = '';
        if (action === 'enhance') {
            prompt = `You are a professional e-commerce copywriter. Enhance and polish the following product description HTML for the product "${productTitle || ''}". 
Improve the copy, make it persuasive and professional, fix grammatical errors, and ensure it looks clean and attractive when rendered. 
Do NOT completely rewrite the entire structure or discard key product details unless they are spammy or irrelevant.
${imagesContext}

Output MUST be ONLY valid HTML code. Do not include any markdown block formatting (like \`\`\`html or \`\`\`), backticks, or explanation.`;
        } else if (action === 'recreate') {
            prompt = `You are a professional e-commerce copywriter. Recreate a brand-new, extremely high-converting and beautifully structured product description in HTML for the product "${productTitle || ''}".
Use modern copywriting techniques (hook, problem, solution, benefit bullet points, specifications, and trust badges or satisfaction guarantee).
Make it visually appealing with clean HTML formatting (use elements like <h3>, <p>, <ul>, <li>, and <strong>). Do not include any CSS styles or scripts.

The original description to rewrite is:
"${description}"
${imagesContext}

Output MUST be ONLY valid HTML code. Do not include any markdown block formatting (like \`\`\`html or \`\`\`), backticks, or explanation.`;
        } else {
            return res.status(400).json({ error: 'Invalid action. Must be "enhance" or "recreate".' });
        }

        const systemInstructions = `You are a strict HTML generator. You must output raw HTML matching the instructions.
CRITICAL: You MUST include the requested product image <img> tags in the generated HTML. Do not leave them out.`;

        const resultHtml = await geminiService.generateResponseText(geminiApiKey, geminiModel, `${systemInstructions}\n\n${prompt}\n\nInput HTML/Description:\n${description}`);
        const cleanHtml = resultHtml.replace(/```html/g, '').replace(/```/g, '').trim();

        res.json({ success: true, description: cleanHtml });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate AI description', details: error.message });
    }
});

// Helper: check if a mimetype or filename is an image
function isImageFile(file) {
    const mime = file.mimetype || '';
    const ext = path.extname(file.originalname || '').toLowerCase();
    return mime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);
}

// 7. Media (Video + Images) → AI Listing Generator
router.post('/video-to-listing', videoUpload.array('files', 20), async (req, res) => {
    let allExtractedFrames = []; // frames from video extraction (for cleanup)
    let uploadedFilePaths = [];  // uploaded file paths (for cleanup)
    const preservedVideoPaths = [];
    try {
        const files = req.files || [];
        if (!files.length) return res.status(400).json({ error: 'No files uploaded.' });

        const storage = getStorage();
        const geminiApiKey = storage.settings?.geminiApiKey;
        const geminiModel = storage.settings?.geminiModel || 'gemini-1.5-flash';
        if (!geminiApiKey) return res.status(400).json({ error: 'Gemini API Key is not configured. Please add it in Settings.' });

        uploadedFilePaths = files.map(f => f.path);
        const videoProcessor = require('../services/videoProcessor');
        const uploadsDir = path.join(__dirname, '..', 'uploads');

        // Build a unified list of frames: {base64, filePath, sourceType, originalIndex}
        const allFrames = [];

        for (const file of files) {
            if (isImageFile(file)) {
                // Image file: read directly as base64
                const imgBase64 = fs.readFileSync(file.path).toString('base64');
                allFrames.push({ base64: imgBase64, filePath: file.path, sourceType: 'image' });
                console.log(`Media→Listing: added image file ${file.originalname}`);
            } else {
                // Video file: extract frames
                console.log(`Media→Listing: extracting frames from video ${file.originalname}`);
                const videoFrames = await videoProcessor.extractFrames(file.path, 20);
                videoFrames.forEach(f => allFrames.push({ ...f, sourceType: 'video' }));
                allExtractedFrames.push(...videoFrames);

                // Keep the original upload for the Shopify floating-video metafield.
                // The extracted frames are temporary analysis assets; the source video
                // should survive the "Use this listing" step and be uploaded later.
                const extension = path.extname(file.originalname || '') || '.mp4';
                const safeName = `floating-${uuidv4()}${extension.toLowerCase()}`;
                const preservedPath = path.join(uploadsDir, safeName);
                fs.copyFileSync(file.path, preservedPath);
                preservedVideoPaths.push(preservedPath);
            }
        }

        if (!allFrames.length) throw new Error('No usable frames or images could be extracted from the uploaded files.');
        console.log(`Media→Listing: ${allFrames.length} total frames/images. Analyzing with Gemini Vision...`);

        const framesBase64 = allFrames.map(f => f.base64);
        const analysis = await geminiService.analyzeProductFromFrames(geminiApiKey, geminiModel, framesBase64);

        // Save only selected frames/images to uploads/ for serving
        let selectedIndices = (analysis.selectedIndices && analysis.selectedIndices.length)
            ? [...analysis.selectedIndices]
            : [];
        
        // Ensure at least 8-15 frames are extracted if available
        if (selectedIndices.length < 8 && allFrames.length > 0) {
            const limit = Math.min(15, allFrames.length);
            for (let i = 0; i < allFrames.length; i++) {
                if (!selectedIndices.includes(i)) {
                    selectedIndices.push(i);
                }
                if (selectedIndices.length >= limit) break;
            }
        }
        selectedIndices.sort((a, b) => a - b);

        const savedFrames = [];
        for (const idx of selectedIndices) {
            if (allFrames[idx]) {
                const frame = allFrames[idx];
                const destFilename = `vl_${Date.now()}_${idx}.jpg`;
                const destPath = path.join(uploadsDir, destFilename);
                if (frame.sourceType === 'image') {
                    // Copy image directly
                    fs.copyFileSync(frame.filePath, destPath);
                } else {
                    // Copy extracted video frame
                    fs.copyFileSync(frame.filePath, destPath);
                }
                savedFrames.push({ index: idx, filename: destFilename, url: '/uploads/' + destFilename });
            }
        }

        // Replace placeholder image tags in description with actual uploaded file paths
        let bodyHtml = analysis.description || '';
        savedFrames.forEach(frame => {
            const placeholder = new RegExp(`\\[IMAGE_${frame.index}\\]`, 'g');
            bodyHtml = bodyHtml.replace(placeholder, `<img src="${frame.url}" style="max-width: 100%; display: block; margin: 15px auto; border-radius: 8px;" />`);
        });
        // Clean up unmatched placeholders
        bodyHtml = bodyHtml.replace(/\[IMAGE_\d+\]/g, '');
        analysis.description = bodyHtml;

        res.json({
            success: true,
            frames: savedFrames,
            floatingVideos: preservedVideoPaths.map(filePath => ({
                filePath,
                filename: path.basename(filePath)
            })),
            listing: {
                title: analysis.title || '',
                description: analysis.description || '',
                tags: analysis.tags || [],
                suggestedPrice: analysis.suggestedPrice || ''
            },
            detectedAttributes: analysis.detectedAttributes || []
        });
    } catch (error) {
        console.error('Media→Listing error:', error.message);
        res.status(500).json({ error: 'Failed to generate listing from media', details: error.message });
    } finally {
        const videoProcessor = require('../services/videoProcessor');
        if (allExtractedFrames.length) { try { videoProcessor.cleanupFrames(allExtractedFrames); } catch {} }
        // Clean up uploaded files
        for (const filePath of uploadedFilePaths) {
            if (filePath && !preservedVideoPaths.includes(filePath) && fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch {}
            }
        }
    }
});

// ── 9. Universal Shopify Importer Gateway ─────────────────────────────────────
router.post('/universal-import', videoUpload.array('files', 20), async (req, res) => {
    let allExtractedFrames = [];  // frames from video extraction (for cleanup)
    let tempMediaPaths = [];       // downloaded media paths (for cleanup)
    let preservedVideoPaths = [];  // preserved video uploads
    const uploadsDir = path.join(__dirname, '..', 'uploads');

    try {
        const url = req.body.url ? req.body.url.trim() : null;
        const storeId = req.body.storeId;
        const files = req.files || [];

        if (!storeId) {
            return res.status(400).json({ error: 'Shopify Store selection is required.' });
        }

        const storage = getStorage();
        const geminiApiKey = storage.settings?.geminiApiKey;
        const geminiModel = storage.settings?.geminiModel || 'gemini-1.5-flash';
        
        // Get Shopify Store credentials
        const store = (storage.shopifyStores || []).find(s => s.id === storeId);
        if (!store) {
            return res.status(400).json({ 
                error: 'Selected Shopify store config not found.',
                details: `Received storeId: "${storeId}". Available stores: ${JSON.stringify((storage.shopifyStores || []).map(s => ({ id: s.id, name: s.name || s.shopName || s.shopUrl })))}`
            });
        }

        // Fetch user store's collections
        const userCollections = await fetchUserCollections(store.shopUrl, store.accessToken);

        // CASE A: Raw files uploaded directly
        if (files.length > 0) {
            if (!geminiApiKey) return res.status(400).json({ error: 'Gemini API Key is required to analyze files. Configure it in Settings.' });
            
            const allFrames = [];
            const uploadedFilePaths = files.map(f => f.path);

            for (const file of files) {
                if (isImageFile(file)) {
                    const imgBase64 = fs.readFileSync(file.path).toString('base64');
                    allFrames.push({ base64: imgBase64, filePath: file.path, sourceType: 'image' });
                } else {
                    const videoProcessor = require('../services/videoProcessor');
                    const videoFrames = await videoProcessor.extractFrames(file.path, 20);
                    videoFrames.forEach(f => allFrames.push({ ...f, sourceType: 'video' }));
                    allExtractedFrames.push(...videoFrames);

                    // Preserve original upload for Shopify metafield upload
                    const extension = path.extname(file.originalname || '') || '.mp4';
                    const safeName = `floating-${uuidv4()}${extension.toLowerCase()}`;
                    const preservedPath = path.join(uploadsDir, safeName);
                    fs.copyFileSync(file.path, preservedPath);
                    preservedVideoPaths.push(preservedPath);
                }
            }

            if (!allFrames.length) throw new Error('No usable images or frames could be extracted.');
            
            const framesBase64 = allFrames.map(f => f.base64);
            const analysis = await geminiService.analyzeProductFromFrames(geminiApiKey, geminiModel, framesBase64);

            let selectedIndices = (analysis.selectedIndices && analysis.selectedIndices.length)
                ? [...analysis.selectedIndices]
                : [];
            
            if (selectedIndices.length < 8 && allFrames.length > 0) {
                const limit = Math.min(15, allFrames.length);
                for (let i = 0; i < allFrames.length; i++) {
                    if (!selectedIndices.includes(i)) {
                        selectedIndices.push(i);
                    }
                    if (selectedIndices.length >= limit) break;
                }
            }
            selectedIndices.sort((a, b) => a - b);

            const savedFrames = [];
            const imagesList = [];
            for (const idx of selectedIndices) {
                if (allFrames[idx]) {
                    const frame = allFrames[idx];
                    const destFilename = `vl_${Date.now()}_${idx}.jpg`;
                    const destPath = path.join(uploadsDir, destFilename);
                    fs.copyFileSync(frame.filePath, destPath);
                    savedFrames.push({ index: idx, filename: destFilename, url: '/uploads/' + destFilename });
                    imagesList.push('/uploads/' + destFilename);
                }
            }

            // Clean up temporary uploads
            for (const p of uploadedFilePaths) {
                try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
            }

            // Get suggested collections via Gemini
            let suggestedCollectionIds = [];
            if (geminiApiKey && userCollections.length > 0) {
                try {
                    const prompt = `Classify this product into relevant collections:\nTitle: ${analysis.title}\nDescription: ${analysis.description}\nCollections:\n${userCollections.map(c => `ID: ${c.id}, Title: ${c.title}`).join('\n')}\nReturn only matching collection IDs as JSON array.`;
                    const suggestion = await geminiService.generateResponseText(geminiApiKey, geminiModel, prompt);
                    suggestedCollectionIds = normalizeSuggestedCollectionIds(suggestion, userCollections);
                } catch {}
            }

            // Replace placeholder image tags in description with actual uploaded file paths
            let bodyHtml = analysis.description || '';
            savedFrames.forEach(frame => {
                const placeholder = new RegExp(`\\[IMAGE_${frame.index}\\]`, 'g');
                bodyHtml = bodyHtml.replace(placeholder, `<img src="${frame.url}" style="max-width: 100%; display: block; margin: 15px auto; border-radius: 8px;" />`);
            });
            // Clean up unmatched placeholders
            bodyHtml = bodyHtml.replace(/\[IMAGE_\d+\]/g, '');
            analysis.description = bodyHtml;

            // Map options and variants for scraper-compatible preview format
            const options = (analysis.detectedAttributes || []).map(attr => ({
                name: attr.name,
                values: attr.values
            }));
            
            // Build simple default variant if no custom options returned
            const variants = [];
            if (options.length === 0) {
                variants.push({
                    title: 'Default Title',
                    price: analysis.suggestedPrice || '29.99',
                    compare_at_price: null,
                    option1: 'Default Title',
                    sku: `sku-${Date.now()}`
                });
            } else {
                // Generate variant combinations based on first option
                const firstOpt = options[0];
                firstOpt.values.forEach((val, idx) => {
                    variants.push({
                        title: val,
                        price: analysis.suggestedPrice || '29.99',
                        compare_at_price: null,
                        option1: val,
                        sku: `${val.toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now()}-${idx}`
                    });
                });
            }

            return res.json({
                success: true,
                importMode: 'media',
                frames: savedFrames,
                floatingVideos: preservedVideoPaths.map(filePath => ({
                    filePath,
                    filename: path.basename(filePath)
                })),
                product: {
                    title: analysis.title || '',
                    description: analysis.description || '',
                    vendor: '',
                    type: '',
                    tags: analysis.tags || [],
                    images: imagesList,
                    options: options.length > 0 ? options : [{"name": "Title", "values": ["Default Title"]}],
                    variants
                },
                userCollections,
                suggestedCollectionIds
            });
        }

        // CASE B: URL provided
        if (url) {
            // Split URL by commas, spaces, or newlines to support multiple links
            const urls = url.split(/[\s,\n\r]+/).map(u => u.trim()).filter(Boolean);
            if (urls.length === 0) {
                return res.status(400).json({ error: 'No valid URL provided.' });
            }

            // Check if any of the URLs is a media URL
            const isMediaUrl = urls.some(u => 
                /facebook\.com\/ads\/library/i.test(u) ||
                /instagram\.com/i.test(u) ||
                /pinterest\.(com|co)/i.test(u) ||
                /pin\.it/i.test(u) ||
                /youtube\.com/i.test(u) ||
                /youtu\.be/i.test(u) ||
                /\.(mp4|mov|m4v|png|jpg|jpeg|webp)(\?|$)/i.test(u)
            );

            if (isMediaUrl) {
                if (!geminiApiKey) return res.status(400).json({ error: 'Gemini API Key is required to analyze media links. Configure it in Settings.' });

                const videoProcessor = require('../services/videoProcessor');
                
                // Get facebook token for Ads Library download if available
                let fbAccessToken = null;
                const accs = storage.accounts || [];
                if (accs.length > 0) fbAccessToken = accs[0].accessToken || null;

                const allFrames = [];

                // Process each media URL
                for (let i = 0; i < urls.length; i++) {
                    const singleUrl = urls[i];
                    // Skip if it doesn't look like a media link
                    const isSingleMedia = /facebook\.com\/ads\/library/i.test(singleUrl) ||
                                         /instagram\.com/i.test(singleUrl) ||
                                         /pinterest\.(com|co)/i.test(singleUrl) ||
                                         /pin\.it/i.test(singleUrl) ||
                                         /youtube\.com/i.test(singleUrl) ||
                                         /youtu\.be/i.test(singleUrl) ||
                                         /\.(mp4|mov|m4v|png|jpg|jpeg|webp)(\?|$)/i.test(singleUrl);
                    if (!isSingleMedia) continue;

                    console.log(`[UniversalImport] Downloading target media URL (${i + 1}/${urls.length}): ${singleUrl}`);
                    try {
                        const targetFilename = `dl-import-${Date.now()}-${i}.mp4`;
                        const downloadedPath = await videoProcessor.downloadVideo(singleUrl, targetFilename, fbAccessToken);
                        tempMediaPaths.push(downloadedPath);

                        // Check if downloaded file is an image or video
                        const isImg = /\.(png|jpg|jpeg|webp)$/i.test(downloadedPath);
                        if (isImg) {
                            const imgBase64 = fs.readFileSync(downloadedPath).toString('base64');
                            allFrames.push({ base64: imgBase64, filePath: downloadedPath, sourceType: 'image' });
                        } else {
                            console.log(`[UniversalImport] Extracting frames from downloaded video...`);
                            const videoFrames = await videoProcessor.extractFrames(downloadedPath, 20);
                            videoFrames.forEach(f => allFrames.push({ ...f, sourceType: 'video' }));
                            allExtractedFrames.push(...videoFrames);

                            // Preserve video for metafield listing uploads
                            const safeName = `floating-${uuidv4()}.mp4`;
                            const preservedPath = path.join(uploadsDir, safeName);
                            fs.copyFileSync(downloadedPath, preservedPath);
                            preservedVideoPaths.push(preservedPath);
                        }
                    } catch (downloadErr) {
                        console.error(`[UniversalImport] Failed to process media URL: ${singleUrl}`, downloadErr);
                    }
                }

                if (!allFrames.length) throw new Error('No usable media frames could be extracted from downloaded URL(s).');
                
                const framesBase64 = allFrames.map(f => f.base64);
                const analysis = await geminiService.analyzeProductFromFrames(geminiApiKey, geminiModel, framesBase64);

                let selectedIndices = (analysis.selectedIndices && analysis.selectedIndices.length)
                    ? [...analysis.selectedIndices]
                    : [];
                
                if (selectedIndices.length < 8 && allFrames.length > 0) {
                    const limit = Math.min(15, allFrames.length);
                    for (let i = 0; i < allFrames.length; i++) {
                        if (!selectedIndices.includes(i)) {
                            selectedIndices.push(i);
                        }
                        if (selectedIndices.length >= limit) break;
                    }
                }
                selectedIndices.sort((a, b) => a - b);

                const savedFrames = [];
                const imagesList = [];
                for (const idx of selectedIndices) {
                    if (allFrames[idx]) {
                        const frame = allFrames[idx];
                        const destFilename = `vl_${Date.now()}_${idx}.jpg`;
                        const destPath = path.join(uploadsDir, destFilename);
                        fs.copyFileSync(frame.filePath, destPath);
                        savedFrames.push({ index: idx, filename: destFilename, url: '/uploads/' + destFilename });
                        imagesList.push('/uploads/' + destFilename);
                    }
                }

                // Get suggested collections via Gemini
                let suggestedCollectionIds = [];
                if (geminiApiKey && userCollections.length > 0) {
                    try {
                        const prompt = `Classify this product into relevant collections:\nTitle: ${analysis.title}\nDescription: ${analysis.description}\nCollections:\n${userCollections.map(c => `ID: ${c.id}, Title: ${c.title}`).join('\n')}\nReturn only matching collection IDs as JSON array.`;
                        const suggestion = await geminiService.generateResponseText(geminiApiKey, geminiModel, prompt);
                        suggestedCollectionIds = normalizeSuggestedCollectionIds(suggestion, userCollections);
                    } catch {}
                }

                // Replace placeholder image tags in description with actual uploaded file paths
                let bodyHtml = analysis.description || '';
                savedFrames.forEach(frame => {
                    const placeholder = new RegExp(`\\[IMAGE_${frame.index}\\]`, 'g');
                    bodyHtml = bodyHtml.replace(placeholder, `<img src="${frame.url}" style="max-width: 100%; display: block; margin: 15px auto; border-radius: 8px;" />`);
                });
                // Clean up unmatched placeholders
                bodyHtml = bodyHtml.replace(/\[IMAGE_\d+\]/g, '');
                analysis.description = bodyHtml;

                const options = (analysis.detectedAttributes || []).map(attr => ({
                    name: attr.name,
                    values: attr.values
                }));

                const variants = [];
                if (options.length === 0) {
                    variants.push({
                        title: 'Default Title',
                        price: analysis.suggestedPrice || '29.99',
                        compare_at_price: null,
                        option1: 'Default Title',
                        sku: `sku-${Date.now()}`
                    });
                } else {
                    const firstOpt = options[0];
                    firstOpt.values.forEach((val, idx) => {
                        variants.push({
                            title: val,
                            price: analysis.suggestedPrice || '29.99',
                            compare_at_price: null,
                            option1: val,
                            sku: `${val.toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now()}-${idx}`
                        });
                    });
                }

                const previewProductObj = {
                    title: analysis.title || '',
                    description: analysis.description || '',
                    images: imagesList,
                    options: options
                };
                autoAppendSizeCharts(previewProductObj, storage);

                return res.json({
                    success: true,
                    importMode: 'media',
                    frames: savedFrames,
                    floatingVideos: preservedVideoPaths.map(filePath => ({
                        filePath,
                        filename: path.basename(filePath)
                    })),
                    product: {
                        title: previewProductObj.title,
                        description: previewProductObj.description,
                        vendor: '',
                        type: '',
                        tags: analysis.tags || [],
                        images: previewProductObj.images,
                        options: options.length > 0 ? options : [{"name": "Title", "values": ["Default Title"]}],
                        variants
                    },
                    userCollections,
                    suggestedCollectionIds
                });
            }

            // Sub-case 2: Is it a Shopify product page link?
            const isShopifyUrl = /\/products\/[a-zA-Z0-9-_]+/i.test(url) && !url.includes('amazon.') && !url.includes('alibaba.');
            if (isShopifyUrl) {
                console.log(`[UniversalImport] Scraping Shopify direct JSON metadata...`);
                const parsedUrl = new URL(url);
                parsedUrl.search = '';
                const jsUrl = parsedUrl.origin + parsedUrl.pathname + '.js';

                const scrapeRes = await fetch(jsUrl);
                if (!scrapeRes.ok) {
                    throw new Error(`Failed to scrape Shopify product page. Status: ${scrapeRes.status}`);
                }
                const product = await scrapeRes.json();

                if (geminiApiKey) {
                    await translateProductToEnglish(product, geminiApiKey, geminiModel, true);
                }

                // Format options and images
                const options = (product.options || []).map(opt => ({
                    name: opt.name,
                    values: opt.values
                }));

                const images = (product.images || []).map(img => {
                    return img.startsWith('//') ? 'https:' + img : img;
                });

                // Format variants and collect direct image assignments (ONE image per variant value)
                const defaultAssignments = {};
                const assignedVariantValues = new Set(); // Track which variant values already have an image
                const variants = (product.variants || []).map(v => {
                    const imgUrl = v.featured_image ? (typeof v.featured_image === 'string' ? v.featured_image : v.featured_image.src) : null;
                    if (imgUrl && v.option1 && !assignedVariantValues.has(v.option1)) {
                        const normalizedVariantImg = imgUrl.startsWith('//') ? 'https:' + imgUrl : imgUrl;
                        const cleanVariantImg = normalizedVariantImg.split('?')[0];
                        const variantBase = path.basename(cleanVariantImg);
                        
                        // Find the matching image in the product images array
                        const matchedProductImg = images.find(prodImg => {
                            const cleanProdImg = prodImg.split('?')[0];
                            const prodBase = path.basename(cleanProdImg);
                            return cleanProdImg === cleanVariantImg || (variantBase.length > 8 && prodBase === variantBase);
                        });
                        
                        if (matchedProductImg) {
                            defaultAssignments[matchedProductImg] = v.option1;
                            // Also store clean URL and basename for fallback matching
                            defaultAssignments[matchedProductImg.split('?')[0]] = v.option1;
                            defaultAssignments[path.basename(matchedProductImg)] = v.option1;
                            assignedVariantValues.add(v.option1);
                        }
                    }
                    return {
                        title: v.title,
                        price: (v.price / 100).toFixed(2),
                        compare_at_price: v.compare_at_price ? (v.compare_at_price / 100).toFixed(2) : null,
                        option1: v.option1,
                        option2: v.option2,
                        option3: v.option3,
                        sku: v.sku || `sku-${v.id}`
                    };
                });

                // Get suggested collections via Gemini
                let suggestedCollectionIds = [];
                if (geminiApiKey && userCollections.length > 0) {
                    try {
                        const prompt = `Classify this product into relevant collections:\nTitle: ${product.title}\nDescription: ${product.description}\nCollections:\n${userCollections.map(c => `ID: ${c.id}, Title: ${c.title}`).join('\n')}\nReturn only matching collection IDs as JSON array.`;
                        const suggestion = await geminiService.generateResponseText(geminiApiKey, geminiModel, prompt);
                        suggestedCollectionIds = normalizeSuggestedCollectionIds(suggestion, userCollections);
                    } catch {}
                }

                const previewProductObj = {
                    title: product.title || '',
                    description: product.description || '',
                    images: images || [],
                    options: options
                };
                autoAppendSizeCharts(previewProductObj, storage);

                return res.json({
                    success: true,
                    importMode: 'scrape',
                    assignments: defaultAssignments,
                    product: {
                        title: previewProductObj.title,
                        description: previewProductObj.description,
                        vendor: product.vendor,
                        type: product.type,
                        tags: product.tags || [],
                        images: previewProductObj.images,
                        options: options.length > 0 ? options : [{"name": "Title", "values": ["Default Title"]}],
                        variants
                    },
                    userCollections,
                    suggestedCollectionIds
                });
            }

            // Sub-case 3: External e-commerce sites (Amazon, Alibaba, etc.)
            const os = require('os');
            const freeRam = () => Math.round(os.freemem() / 1024 / 1024);
            console.log(`[UniversalImport] Step 1/4: Launching browser scraper for: ${url} | Free RAM: ${freeRam()}MB`);
            
            // Use browser extraction to extract page details
            const pageData = await scrapeProductPageViaBrowser(url);
            console.log(`[UniversalImport] Step 2/4: Scraping complete. ${pageData.images.length} images found. | Free RAM: ${freeRam()}MB`);
            
            if (!geminiApiKey) {
                return res.status(400).json({ error: 'Gemini API Key is required to convert Amazon/Alibaba listings. Configure it in Settings.' });
            }

            console.log(`[UniversalImport] Step 3/4: Analyzing with Gemini AI... | Free RAM: ${freeRam()}MB`);
            const structuredProduct = await geminiService.analyzeProductFromScrapedText(
                geminiApiKey,
                geminiModel,
                `Page Title: ${pageData.title}\n\nPage Text:\n${pageData.bodyText}`,
                pageData.images || []
            );
            console.log(`[UniversalImport] Step 4/4: AI analysis complete. Building preview... | Free RAM: ${freeRam()}MB`);

            // Merge scraped browser images with Gemini's response
            const finalImages = pageData.images && pageData.images.length > 0 
                ? pageData.images 
                : (structuredProduct.images || []);

            // Replace placeholder image tags in description with actual scraped image urls
            let bodyHtml = structuredProduct.description || '';
            finalImages.forEach((imgUrl, i) => {
                const placeholder = new RegExp(`\\[IMAGE_${i}\\]`, 'g');
                const src = imgUrl.startsWith('//') ? 'https:' + imgUrl : imgUrl;
                bodyHtml = bodyHtml.replace(placeholder, `<img src="${src}" style="max-width: 100%; display: block; margin: 15px auto; border-radius: 8px;" />`);
            });
            // Clean up unmatched placeholders
            bodyHtml = bodyHtml.replace(/\[IMAGE_\d+\]/g, '');
            structuredProduct.description = bodyHtml;

            // Ensure variants have correct defaults/skus if lacking
            const variants = (structuredProduct.variants || []).map((v, i) => ({
                title: v.title || 'Default Option',
                price: v.price || structuredProduct.suggestedPrice || '29.99',
                compare_at_price: v.compare_at_price || null,
                option1: v.option1 || v.title || 'Default Option',
                option2: v.option2 || null,
                sku: v.sku || `sku-${Date.now()}-${i}`
            }));

            // Get suggested collections via Gemini
            let suggestedCollectionIds = [];
            if (geminiApiKey && userCollections.length > 0) {
                try {
                    const prompt = `Classify this product into relevant collections:\nTitle: ${structuredProduct.title}\nDescription: ${structuredProduct.description}\nCollections:\n${userCollections.map(c => `ID: ${c.id}, Title: ${c.title}`).join('\n')}\nReturn only matching collection IDs as JSON array.`;
                    const suggestion = await geminiService.generateResponseText(geminiApiKey, geminiModel, prompt);
                    suggestedCollectionIds = normalizeSuggestedCollectionIds(suggestion, userCollections);
                } catch {}
            }

            const previewProductObj = {
                title: structuredProduct.title || pageData.title || 'Imported Product',
                description: structuredProduct.description || '',
                images: finalImages || [],
                options: structuredProduct.options
            };
            autoAppendSizeCharts(previewProductObj, storage);

            return res.json({
                success: true,
                importMode: 'scrape',
                product: {
                    title: previewProductObj.title,
                    description: previewProductObj.description,
                    vendor: structuredProduct.vendor || '',
                    type: structuredProduct.type || '',
                    tags: structuredProduct.tags || [],
                    images: previewProductObj.images,
                    options: structuredProduct.options && structuredProduct.options.length > 0 
                        ? structuredProduct.options 
                        : [{"name": "Title", "values": ["Default Option"]}],
                    variants
                },
                userCollections,
                suggestedCollectionIds
            });
        }

        return res.status(400).json({ error: 'No media files uploaded or URL provided.' });

    } catch (error) {
        console.error('[UniversalImport] Failure:', error.message);
        res.status(500).json({ error: 'Failed to process universal import request.', details: error.message });
    } finally {
        const videoProcessor = require('../services/videoProcessor');
        if (allExtractedFrames.length) { try { videoProcessor.cleanupFrames(allExtractedFrames); } catch {} }
        
        // Clean up temporary downloaded file paths
        for (const tempPath of tempMediaPaths) {
            try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
        }
    }
});

// Helper function to extract product page layout via headless browser
async function scrapeProductPageViaBrowser(url) {
    const { withTab } = require('../services/browserPool');
    return withTab(async (page) => {
        console.log(`[UniversalScrape] Loading page in browser: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Wait 3 seconds for dynamic content / React loading
        await new Promise(r => setTimeout(r, 3000));
        
        // Find other variant color URLs on the page (matching path but different query parameters)
        const variantUrls = await page.evaluate((targetUrl) => {
            const currentUrl = new URL(targetUrl);
            const basePath = currentUrl.pathname;
            const hostname = currentUrl.hostname;
            
            const links = Array.from(document.querySelectorAll('a'));
            const matches = [];
            
            links.forEach(a => {
                try {
                    const href = a.getAttribute('href');
                    if (!href) return;
                    
                    const absoluteUrl = new URL(href, currentUrl.href);
                    if (absoluteUrl.hostname === hostname && absoluteUrl.pathname === basePath) {
                        const search = absoluteUrl.search;
                        if (search.includes('renk=') || search.includes('color=') || search.includes('colour=') || search.includes('variant=') || search.includes('beden=') || search.includes('boyut=') || search.includes('stil=') || search.includes('size=') || search.includes('style=')) {
                            matches.push(absoluteUrl.href);
                        }
                    }
                } catch(e) {}
            });
            return [...new Set(matches)];
        }, url);

        const pageData = await page.evaluate(() => {
            const title = document.title || '';
            const bodyText = document.body.innerText || '';
            
            const isAmazon = window.location.hostname.includes('amazon.');
            const isAlibaba = window.location.hostname.includes('alibaba.');
            const imageUrls = [];
            
            if (isAmazon) {
                // 1. Amazon main image
                const landing = document.querySelector('#landingImage');
                if (landing && landing.src) {
                    imageUrls.push(landing.src);
                }
                
                // 2. Amazon thumbnail images list
                document.querySelectorAll('#altImages img, #imageBlock img').forEach(img => {
                    const src = img.src || img.getAttribute('data-old-hires') || img.getAttribute('data-a-dynamic-image') || img.getAttribute('src');
                    if (src && !src.includes('sprite') && !src.includes('play-button') && !src.includes('videoplayer')) {
                        const hires = src.replace(/\._[A-Z0-9_-]+\./i, '.');
                        imageUrls.push(hires);
                    }
                });
                
                // 3. Amazon APlus description images
                document.querySelectorAll('#aplus img, .aplus-v2 img').forEach(img => {
                    const src = img.src;
                    if (src && !src.includes('pixel') && !src.includes('logo') && src.startsWith('http')) {
                        imageUrls.push(src);
                    }
                });
            } else if (isAlibaba) {
                // Alibaba thumbnail list, description images, and main gallery selectors
                document.querySelectorAll('.thumb-list img, .detail-description img, .main-image-container img, .image-viewer img, .detail-gallery img, .icbu-pc-detail-gallery img, .gallery-img-wrapper img, .main-layout img').forEach(img => {
                    let src = img.getAttribute('src') || img.getAttribute('data-src') || img.src || '';
                    if (src) {
                        if (src.startsWith('//')) {
                            src = 'https:' + src;
                        }
                        if (!src.includes('pixel') && !src.includes('logo') && (src.startsWith('http') || src.includes('alicdn.com'))) {
                            const hires = src.replace(/_\d+x\d+.*$/, '');
                            imageUrls.push(hires);
                        }
                    }
                });
            } else {
                // Helper: extract best (highest-res) single URL from a srcset string
                const parseSrcset = (srcsetStr) => {
                    if (!srcsetStr || !srcsetStr.includes(' ')) return srcsetStr;
                    const parts = srcsetStr.split(',').map(p => p.trim().split(/\s+/));
                    let best = null, bestW = 0;
                    parts.forEach(([url, descriptor]) => {
                        if (!url) return;
                        const w = descriptor ? parseInt(descriptor) : 0;
                        if (w > bestW || !best) { best = url; bestW = w; }
                    });
                    return best || srcsetStr;
                };

                // Generic page fallback + prominent e-commerce main images
                document.querySelectorAll('.product-image img, .gallery img, .main-image img, #main-image img, img.product-gallery-image, img[class*="product-img"], .thumb-list img, .swiper-slide img, .slick-slide img, .carousel img, .slider img, img[class*="gallery"], img[class*="image"], img[class*="product"], img[class*="thumb"], img[class*="media"], img[class*="slider"], img[class*="carousel"]').forEach(img => {
                    // Prefer clean single-URL attributes; only fall back to srcset
                    let src = img.getAttribute('data-src') || img.src;
                    if ((!src || src.startsWith('data:')) && img.getAttribute('srcset')) {
                        src = parseSrcset(img.getAttribute('srcset'));
                    } else if (!src || src.startsWith('data:')) {
                        src = parseSrcset(img.getAttribute('srcSet'));
                    }
                    if (src) {
                        if (src.startsWith('//')) {
                            src = 'https:' + src;
                        }
                        const srcLower = src.toLowerCase();
                        const isIgnored = [
                            'logo', 'banner', 'pixel', 'sprite', 'icon', 'button', 'loading', 'placeholder', 
                            'avatar', 'svg', 'theme', 'checkout', 'badge', 'trust', 'payment', 'shipping', 
                            'carrier', 'dhl', 'hepsijet', 'troy', 'visa', 'mastercard', 'maestro', 'amex', 
                            'klarna', 'stripe', 'paypal', 'facebook.com/tr', 'google-analytics', 'yandex', 
                            'doubleclick', 'facebook-pixel', 'connect.facebook.net', 'tracking', 'advert'
                        ].some(kw => srcLower.includes(kw)) || src.includes('.svg') || src.startsWith('data:image');

                        if (!isIgnored && src.startsWith('http')) {
                            imageUrls.push(src);
                        }
                    }
                });

                const imgElements = document.querySelectorAll('img');
                imgElements.forEach(img => {
                    // Prefer clean single-URL attributes; only fall back to srcset
                    let src = img.getAttribute('data-src') || img.src;
                    if ((!src || src.startsWith('data:')) && img.getAttribute('srcset')) {
                        src = parseSrcset(img.getAttribute('srcset'));
                    } else if (!src || src.startsWith('data:')) {
                        src = parseSrcset(img.getAttribute('srcSet'));
                    }
                    if (src) {
                        if (src.startsWith('//')) src = 'https:' + src;
                        const srcLower = src.toLowerCase();
                        const isIgnored = [
                            'logo', 'banner', 'pixel', 'sprite', 'icon', 'button', 'loading', 'placeholder', 
                            'avatar', 'svg', 'theme', 'checkout', 'badge', 'trust', 'payment', 'shipping', 
                            'carrier', 'dhl', 'hepsijet', 'troy', 'visa', 'mastercard', 'maestro', 'amex', 
                            'klarna', 'stripe', 'paypal', 'facebook.com/tr', 'google-analytics', 'yandex', 
                            'doubleclick', 'facebook-pixel', 'connect.facebook.net', 'tracking', 'advert'
                        ].some(kw => srcLower.includes(kw)) || src.includes('.svg') || src.startsWith('data:image');

                        if (!isIgnored && src.startsWith('http')) {
                            const width = img.naturalWidth || parseInt(img.getAttribute('width')) || 0;
                            const height = img.naturalHeight || parseInt(img.getAttribute('height')) || 0;
                            const className = img.className || '';
                            const isProductImage = className.includes('product') || className.includes('gallery') || className.includes('main') || className.includes('detail') || className.includes('swiper') || className.includes('slide') || className.includes('carousel') || className.includes('thumb');
                            
                            if (isProductImage || (width === 0 || width > 200) && (height === 0 || height > 200)) {
                                imageUrls.push(src);
                            }
                        }
                    }
                });
            }
            
            // Deduplicate and filter out invalid values
            const uniqueImages = [...new Set(imageUrls.filter(Boolean))].slice(0, 30);
            
            return {
                title,
                bodyText: bodyText.slice(0, 6000), // Cap to prevent large prompts
                images: uniqueImages
            };
        });

        // Crawl up to 2 sibling variants by REUSING the same tab (saves ~100MB RAM vs newPage)
        const otherVariantUrls = variantUrls.filter(vUrl => vUrl !== url).slice(0, 2);
        if (otherVariantUrls.length > 0) {
            const os = require('os');
            const freeRamMB = () => Math.round(os.freemem() / 1024 / 1024);
            console.log(`[UniversalScrape] Sibling variants detected: ${otherVariantUrls.length}. Reusing same tab for extraction. Free RAM: ${freeRamMB()}MB`);
            
            for (let vi = 0; vi < otherVariantUrls.length; vi++) {
                const vUrl = otherVariantUrls[vi];
                try {
                    console.log(`[UniversalScrape] Crawling sibling ${vi+1}/${otherVariantUrls.length}: ${vUrl} | Free RAM: ${freeRamMB()}MB`);
                    
                    // Reuse existing page — navigate to sibling URL (no new tab = no extra RAM)
                    await page.goto(vUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                    await new Promise(r => setTimeout(r, 1200));
                    
                    const variantImages = await page.evaluate(() => {
                        const parseSrcset = (srcsetStr) => {
                            if (!srcsetStr || !srcsetStr.includes(' ')) return srcsetStr;
                            const parts = srcsetStr.split(',').map(p => p.trim().split(/\s+/));
                            let best = null, bestW = 0;
                            parts.forEach(([url, descriptor]) => {
                                if (!url) return;
                                const w = descriptor ? parseInt(descriptor) : 0;
                                if (w > bestW || !best) { best = url; bestW = w; }
                            });
                            return best || srcsetStr;
                        };
                        const urls = [];
                        document.querySelectorAll('.product-image img, .gallery img, .main-image img, #main-image img, img.product-gallery-image, img[class*="product-img"], .thumb-list img, .swiper-slide img, .slick-slide img, .carousel img, .slider img, img[class*="gallery"], img[class*="image"], img[class*="product"], img[class*="thumb"]').forEach(img => {
                            let src = img.getAttribute('data-src') || img.src;
                            if ((!src || src.startsWith('data:')) && img.getAttribute('srcset')) {
                                src = parseSrcset(img.getAttribute('srcset'));
                            } else if (!src || src.startsWith('data:')) {
                                src = parseSrcset(img.getAttribute('srcSet'));
                            }
                            if (src) {
                                if (src.startsWith('//')) src = 'https:' + src;
                                const srcLower = src.toLowerCase();
                                const isIgnored = [
                                    'logo', 'banner', 'pixel', 'sprite', 'icon', 'button', 'loading', 'placeholder', 
                                    'avatar', 'svg', 'theme', 'checkout', 'badge', 'trust', 'payment', 'shipping', 
                                    'carrier', 'dhl', 'hepsijet', 'troy', 'visa', 'mastercard', 'maestro', 'amex', 
                                    'klarna', 'stripe', 'paypal', 'facebook.com/tr', 'google-analytics', 'yandex', 
                                    'doubleclick', 'facebook-pixel', 'connect.facebook.net', 'tracking', 'advert'
                                ].some(kw => srcLower.includes(kw)) || src.includes('.svg') || src.startsWith('data:image');

                                if (!isIgnored && src.startsWith('http')) {
                                    urls.push(src);
                                }
                            }
                        });
                        return [...new Set(urls)].slice(0, 5);
                    });
                    
                    if (variantImages && variantImages.length > 0) {
                        console.log(`[UniversalScrape] Got ${variantImages.length} images from sibling ${vi+1}`);
                        pageData.images.push(...variantImages);
                    }
                } catch (e) {
                    console.error(`[UniversalScrape] Sibling crawl failed for ${vUrl}:`, e.message);
                }
            }
            pageData.images = [...new Set(pageData.images)].slice(0, 30);
        }
        
        console.log(`[UniversalScrape] Extraction complete. Total images: ${pageData.images.length}. Free RAM: ${Math.round(require('os').freemem() / 1024 / 1024)}MB`);
        return pageData;
    }, { timeout: 60000, blockImages: true });
}

// Endpoint to upload manual images in Shopify Importer preview grid
router.post('/upload-scraped-images', videoUpload.array('files', 10), (req, res) => {
    try {
        const files = req.files || [];
        const paths = [];
        
        for (const file of files) {
            const extension = path.extname(file.originalname) || '.jpg';
            const safeName = `manual-${uuidv4()}${extension.toLowerCase()}`;
            const destPath = path.join(__dirname, '..', 'uploads', safeName);
            fs.renameSync(file.path, destPath);
            paths.push('/uploads/' + safeName);
        }
        
        res.json({ success: true, paths });
    } catch (error) {
        res.status(500).json({ error: 'Failed to upload scraped images', details: error.message });
    }
});

// Endpoint to translate text inside a single image to English
router.post('/translate-image', async (req, res) => {
    try {
        const { imageUrl } = req.body;
        if (!imageUrl) {
            return res.status(400).json({ error: 'imageUrl is required' });
        }

        const storage = getStorage();
        const geminiApiKey = storage.settings?.geminiApiKey;
        const geminiModel = storage.settings?.geminiModel || 'gemini-2.5-flash';

        if (!geminiApiKey) {
            return res.status(400).json({ error: 'Gemini API key is not configured in Settings.' });
        }

        const result = await imageTranslator.translateImage(imageUrl, geminiApiKey, geminiModel);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[TranslateImage] Error:', error.message);
        res.status(500).json({ error: 'Failed to translate image', details: error.message });
    }
});

// Endpoint to batch-translate multiple images
router.post('/translate-all-images', async (req, res) => {
    try {
        const { images } = req.body;
        if (!Array.isArray(images) || images.length === 0) {
            return res.status(400).json({ error: 'images array is required' });
        }

        const storage = getStorage();
        const geminiApiKey = storage.settings?.geminiApiKey;
        const geminiModel = storage.settings?.geminiModel || 'gemini-2.5-flash';

        if (!geminiApiKey) {
            return res.status(400).json({ error: 'Gemini API key is not configured in Settings.' });
        }

        const results = [];
        for (const imgUrl of images) {
            try {
                const resItem = await imageTranslator.translateImage(imgUrl, geminiApiKey, geminiModel);
                results.push({
                    originalUrl: imgUrl,
                    translatedUrl: resItem.translatedUrl || imgUrl,
                    translated: resItem.translated,
                    textBlocksCount: resItem.textBlocksCount || 0
                });
            } catch (err) {
                console.error(`[TranslateAllImages] Failed for ${imgUrl}:`, err.message);
                results.push({
                    originalUrl: imgUrl,
                    translatedUrl: imgUrl,
                    translated: false,
                    error: err.message
                });
            }
        }

        res.json({ success: true, results });
    } catch (error) {
        console.error('[TranslateAllImages] Error:', error.message);
        res.status(500).json({ error: 'Failed to batch translate images', details: error.message });
    }
});

// 8. Assign extracted images to variant values using Gemini Vision
router.post('/assign-variant-images', async (req, res) => {
    try {
        const { frameFilenames, variantOption, variantValues } = req.body;
        if (!frameFilenames?.length || !variantOption || !variantValues?.length) {
            return res.status(400).json({ error: 'Missing frameFilenames, variantOption, or variantValues.' });
        }

        const storage = getStorage();
        const geminiApiKey = storage.settings?.geminiApiKey;
        const geminiModel = storage.settings?.geminiModel || 'gemini-1.5-flash';
        if (!geminiApiKey) return res.status(400).json({ error: 'Gemini API Key is not configured. Please add it in Settings.' });

        const fetch = require('node-fetch');
        const uploadsDir = path.join(__dirname, '..', 'uploads');
        const framesBase64 = await Promise.all(frameFilenames.map(async (filenameOrUrl) => {
            if (filenameOrUrl.startsWith('http://') || filenameOrUrl.startsWith('https://')) {
                try {
                    const fetchRes = await fetch(filenameOrUrl);
                    if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
                    const buffer = await fetchRes.buffer();
                    return buffer.toString('base64');
                } catch (err) {
                    console.error(`[AssignVariantImages] Failed to fetch remote image ${filenameOrUrl}:`, err.message);
                    return '';
                }
            } else {
                // Handle /uploads/filename.jpg paths (from media imports) and bare filenames
                let localName = filenameOrUrl;
                if (localName.startsWith('/uploads/')) {
                    localName = localName.replace('/uploads/', '');
                }
                const filePath = path.join(uploadsDir, localName);
                if (fs.existsSync(filePath)) {
                    return fs.readFileSync(filePath).toString('base64');
                }
                console.warn(`[AssignVariantImages] Local file not found: ${filePath}`);
                return '';
            }
        }));

        // Track valid indices for re-mapping Gemini's 0-based output back to original filenames
        const validIndices = [];
        const validFramesBase64 = [];
        framesBase64.forEach((b64, idx) => {
            if (b64 !== '') {
                validIndices.push(idx);
                validFramesBase64.push(b64);
            }
        });

        const result = await geminiService.assignImagesToVariants(geminiApiKey, geminiModel, validFramesBase64, variantOption, variantValues);
        
        // Re-map: Gemini returns assignments keyed by sequential index (0, 1, 2...)
        // We need to map these back to the ORIGINAL frameFilenames indices
        const remappedAssignments = {};
        if (result.assignments) {
            Object.keys(result.assignments).forEach(geminiIdx => {
                const originalIdx = validIndices[parseInt(geminiIdx)];
                if (originalIdx !== undefined) {
                    remappedAssignments[String(originalIdx)] = result.assignments[geminiIdx];
                }
            });
        }
        res.json({ success: true, assignments: remappedAssignments });
    } catch (error) {
        console.error('Assign variant images error:', error.message);
        res.status(500).json({ error: 'Failed to assign images to variants', details: error.message });
    }
});

function autoAppendSizeCharts(product, storage) {
    if (!product) return;
    
    // Check if fashion-related
    let isFashion = false;
    if (Array.isArray(product.options)) {
        const hasSizeOption = product.options.some(opt => 
            opt.name && /size|größe|taille|talla|beden|boyut/i.test(opt.name)
        );
        if (hasSizeOption) isFashion = true;
    }
    const fashionKeywords = /apparel|clothing|shirt|dress|pants|shoes|hoodies|jacket|underwear|socks|fashion|outerwear|t-shirt|top|bottom|jeans|sweater|sneakers|sandals|boots|garment|elbise|beden|renk|etek|kombin|pantolon|bluz|ceket|hirka|hırka|kazak/i;
    if (product.type && fashionKeywords.test(product.type)) isFashion = true;
    if (product.title && fashionKeywords.test(product.title)) isFashion = true;
    if (Array.isArray(product.tags) && product.tags.some(t => fashionKeywords.test(t))) isFashion = true;
    
    if (isFashion && Array.isArray(storage.settings?.defaultSizeCharts) && storage.settings.defaultSizeCharts.length > 0) {
        console.log(`[UniversalImport] Fashion listing detected. Appending ${storage.settings.defaultSizeCharts.length} default size chart image(s) to product preview.`);
        
        // 1. Add to images list if not present
        if (!Array.isArray(product.images)) product.images = [];
        storage.settings.defaultSizeCharts.forEach(scPath => {
            if (!product.images.includes(scPath)) {
                product.images.push(scPath);
            }
        });
        
        // 2. Append size chart HTML to the end of the description if not already present
        let sizeChartHtml = '';
        storage.settings.defaultSizeCharts.forEach(scPath => {
            const scSrc = scPath.startsWith('//') ? 'https:' + scPath : scPath;
            sizeChartHtml += `<p style="text-align: center;"><img src="${scSrc}" style="max-width: 100%; display: block; margin: 15px auto; border-radius: 8px;" /></p>`;
        });
        
        const descLower = (product.description || '').toLowerCase();
        if (sizeChartHtml && !descLower.includes('size-chart') && !descLower.includes('size_chart') && !descLower.includes('size chart') && !descLower.includes('beden tablosu')) {
            product.description = (product.description || '') + `<br/><hr/><h3 style="color: #e67e23; margin-top: 15px; margin-bottom: 8px;">📐 Beden Tablosu / Size Chart</h3>` + sizeChartHtml;
        }
    }
}

function areSameImageUrls(url1, url2) {
    if (!url1 || !url2) return false;
    const str1 = typeof url1 === 'string' ? url1.trim() : (url1?.src || '');
    const str2 = typeof url2 === 'string' ? url2.trim() : (url2?.src || '');
    if (!str1 || !str2) return false;
    if (str1 === str2) return true;

    // Normalize: remove protocol (https:, http:, //), and query parameters (?v=...)
    const clean1 = str1.replace(/^https?:/, '').replace(/^\/\//, '').split('?')[0];
    const clean2 = str2.replace(/^https?:/, '').replace(/^\/\//, '').split('?')[0];
    if (clean1 === clean2) return true;

    // Match basenames (accounting for Shopify size suffixes like _small, _medium, _large, _grande, _800x, etc.)
    const base1 = path.basename(clean1).replace(/_(small|compact|medium|large|grande|pico|thumb|\d+x\d*|\d*x\d+)(\.[a-z0-9]+)$/i, '$2');
    const base2 = path.basename(clean2).replace(/_(small|compact|medium|large|grande|pico|thumb|\d+x\d*|\d*x\d+)(\.[a-z0-9]+)$/i, '$2');
    if (base1.length > 5 && base1 === base2) return true;

    return false;
}

async function translateProductToEnglish(product, geminiApiKey, geminiModel, autoTranslateImages = true) {
    if (!geminiApiKey) return product;

    // 1. Text Translation (Title, Description, Options, Variants)
    try {
        console.log(`[Translate] Starting translation to English for product: ${product.title}`);
        
        const simplifiedOptions = (product.options || []).map(opt => ({
            name: opt.name,
            values: opt.values
        }));

        const prompt = `You are a professional e-commerce translator. Translate the following product listing to English.

IMPORTANT RULES:
1. Translate all human-readable text (Title, Description HTML, Option Names, and Option Values) to English.
2. In the Description HTML, preserve ALL HTML tags, styles, classes, and image URLs (<img> tags) EXACTLY as they are. ONLY translate the text content inside the HTML. Do not alter, translate, or remove tag names, attributes, or image src URLs.
3. For Option Names, translate them to standard English equivalents (e.g., "Color" -> "Color", "Talla" -> "Size", "Taille" -> "Size", "Material" -> "Material", "Ancho" -> "Width", "Alto" -> "Height").
4. Keep the JSON structure exactly as provided. Do not change keys.

Input JSON:
${JSON.stringify({
    title: product.title || '',
    description: product.description || '',
    options: simplifiedOptions
}, null, 2)}

Return ONLY valid JSON in this exact shape:
{
  "title": "Translated Title",
  "description": "Translated HTML Description",
  "options": [
    { "name": "Translated Option Name", "values": ["Translated Value 1", "Translated Value 2", ...] }
  ]
}`;

        const suggestion = await geminiService.generateResponseText(geminiApiKey, geminiModel, prompt);
        const jsonMatch = suggestion ? suggestion.match(/\{[\s\S]*\}/) : null;
        if (jsonMatch) {
            const translated = JSON.parse(jsonMatch[0]);

            if (translated.title) {
                product.title = translated.title;
            }
            if (translated.description) {
                product.description = translated.description;
            }

            const translationMap = {};
            if (Array.isArray(translated.options) && Array.isArray(product.options)) {
                translated.options.forEach((newOpt, optIdx) => {
                    const oldOpt = product.options[optIdx];
                    if (oldOpt) {
                        oldOpt.name = newOpt.name;
                        if (Array.isArray(newOpt.values) && Array.isArray(oldOpt.values)) {
                            oldOpt.values.forEach((oldVal, valIdx) => {
                                const newVal = newOpt.values[valIdx];
                                if (newVal) translationMap[oldVal] = newVal;
                            });
                            oldOpt.values = newOpt.values;
                        }
                    }
                });
            }

            if (Array.isArray(product.variants)) {
                product.variants.forEach(variant => {
                    if (variant.option1 && translationMap[variant.option1]) variant.option1 = translationMap[variant.option1];
                    if (variant.option2 && translationMap[variant.option2]) variant.option2 = translationMap[variant.option2];
                    if (variant.option3 && translationMap[variant.option3]) variant.option3 = translationMap[variant.option3];

                    const activeOptions = [variant.option1, variant.option2, variant.option3].filter(Boolean);
                    if (activeOptions.length > 0) {
                        variant.title = activeOptions.join(' / ');
                    }
                });
            }
            console.log(`[Translate] Successfully translated text to: ${product.title}`);
        }
    } catch (textErr) {
        console.error('[Translate] Text translation error:', textErr.message);
    }

    // 2. High-Speed Google Translate Image Session (Single Tab with (X) Clear button)
    if (autoTranslateImages !== false) {
        try {
            // 1. Description images (Size charts, infographics, callouts)
            const descriptionImages = [];
            if (product.description && typeof product.description === 'string') {
                const imgMatches = product.description.match(/<img[^>]+src=["']([^"']+)["']/gi);
                if (imgMatches) {
                    imgMatches.forEach(match => {
                        const srcMatch = match.match(/src=["']([^"']+)["']/i);
                        const imgSrc = srcMatch ? srcMatch[1].trim() : null;
                        if (imgSrc && !imgSrc.includes('/uploads/translated-')) {
                            const exists = descriptionImages.some(existing => areSameImageUrls(existing, imgSrc));
                            if (!exists) {
                                descriptionImages.push(imgSrc);
                            }
                        }
                    });
                }
            }

            // 2. Gallery images from product.images
            const galleryImages = [];
            if (Array.isArray(product.images)) {
                product.images.forEach(img => {
                    const gStr = typeof img === 'string' ? img.trim() : (img?.src || '');
                    if (gStr && !gStr.includes('/uploads/translated-')) {
                        const exists = galleryImages.some(existing => areSameImageUrls(existing, gStr));
                        if (!exists) {
                            galleryImages.push(gStr);
                        }
                    }
                });
            }

            // 3. Deduplicate common images:
            // Any image present in BOTH Description and Gallery is COMMON.
            // We include it in allImagesToTranslate ONLY ONCE so Gemini and Translate never duplicate work!
            const allImagesToTranslate = [...descriptionImages];

            galleryImages.forEach(gImg => {
                const isCommon = descriptionImages.some(dImg => areSameImageUrls(dImg, gImg));
                if (!isCommon) {
                    allImagesToTranslate.push(gImg);
                } else {
                    console.log(`[Translate] Image is common to both Description and Gallery (will only scan & translate once): ${gImg}`);
                }
            });

            if (allImagesToTranslate.length > 0) {
                // Step 1: Ask AI (Gemini Vision) to inspect all images and pick ONLY the ones containing text/tables/callouts!
                let targetImagesForGoogle = allImagesToTranslate;
                if (geminiApiKey) {
                    try {
                        console.log(`[AI Filter] Asking Gemini Vision to inspect ${allImagesToTranslate.length} images before translation...`);
                        targetImagesForGoogle = await geminiService.filterImagesNeedingTranslation(geminiApiKey, geminiModel, allImagesToTranslate);
                        console.log(`[AI Filter] AI selected ${targetImagesForGoogle.length} images containing text/tables out of ${allImagesToTranslate.length}!`);
                    } catch (aiFilterErr) {
                        console.warn('[AI Filter] Gemini Vision filter error, proceeding with all images:', aiFilterErr.message);
                    }
                }

                // Detect source store language
                const detectedLang = 'auto';

                if (targetImagesForGoogle.length > 0) {
                    console.log(`[Translate] Starting 5-tab parallel translation for ${targetImagesForGoogle.length} images with Google Translate...`);
                    const translationResults = await imageTranslator.translateMultipleImages(targetImagesForGoogle, detectedLang);

                    // Robust replacement helper that matches //, https:, and base URLs without query parameters
                    const applyImageReplacement = (targetStr, origUrl, newUrl) => {
                        if (!targetStr || typeof targetStr !== 'string') return targetStr;
                        const origClean = origUrl.trim();
                        const origWithHttps = origClean.startsWith('//') ? 'https:' + origClean : origClean;
                        const origWithoutHttps = origWithHttps.replace(/^https?:/, '');
                        const origBase = origClean.split('?')[0];
                        const origBaseWithoutHttps = origWithoutHttps.split('?')[0];

                        let updated = targetStr;
                        [origClean, origWithHttps, origWithoutHttps, origBase, origBaseWithoutHttps].forEach(pattern => {
                            if (pattern && pattern.length > 15) {
                                updated = updated.split(pattern).join(newUrl);
                            }
                        });
                        return updated;
                    };

                    // Apply translated URLs to description HTML and/or product.images
                    translationResults.forEach(res => {
                        if (res.translated && res.translatedUrl) {
                            console.log(`[Translate] Applying translated image: ${res.original} -> ${res.translatedUrl}`);

                            // 1. Description replacement:
                            // Check if this translated image belonged to descriptionImages
                            const isInDescription = descriptionImages.some(dImg => areSameImageUrls(dImg, res.original));
                            if (isInDescription && product.description && typeof product.description === 'string') {
                                // Replace in description right at its original place
                                descriptionImages.forEach(dImg => {
                                    if (areSameImageUrls(dImg, res.original)) {
                                        product.description = applyImageReplacement(product.description, dImg, res.translatedUrl);
                                    }
                                });
                                product.description = applyImageReplacement(product.description, res.original, res.translatedUrl);

                                // Also replace any matching <img src="..."> in the HTML directly
                                const imgTagMatches = product.description.match(/<img[^>]+src=["']([^"']+)["']/gi);
                                if (imgTagMatches) {
                                    imgTagMatches.forEach(tag => {
                                        const m = tag.match(/src=["']([^"']+)["']/i);
                                        if (m && m[1] && areSameImageUrls(m[1], res.original)) {
                                            product.description = product.description.split(m[1]).join(res.translatedUrl);
                                        }
                                    });
                                }
                                console.log(`[Translate] Replaced in Description at original place: ${res.original} -> ${res.translatedUrl}`);
                            }

                            // 2. Gallery replacement:
                            // Check if this translated image belonged to galleryImages
                            const isInGallery = galleryImages.some(gImg => areSameImageUrls(gImg, res.original));
                            if (isInGallery && Array.isArray(product.images)) {
                                product.images = product.images.map(galleryImg => {
                                    if (areSameImageUrls(galleryImg, res.original)) {
                                        console.log(`[Translate] Replaced in Gallery: ${typeof galleryImg === 'string' ? galleryImg : galleryImg?.src} -> ${res.translatedUrl}`);
                                        return res.translatedUrl;
                                    }
                                    return galleryImg;
                                });
                            }
                            // NOTE: If !isInGallery (i.e. description-only image), we DO NOT add it to product.images (Gallery)!
                            // It stays strictly inside the description at its place!

                            // 3. Replace in product.featured_image
                            if (product.featured_image && areSameImageUrls(product.featured_image, res.original)) {
                                if (typeof product.featured_image === 'string') {
                                    product.featured_image = res.translatedUrl;
                                } else if (product.featured_image.src) {
                                    product.featured_image.src = res.translatedUrl;
                                }
                            }

                            // 4. Replace in product.variants
                            if (Array.isArray(product.variants)) {
                                product.variants.forEach(v => {
                                    if (v.featured_image && areSameImageUrls(v.featured_image, res.original)) {
                                        if (typeof v.featured_image === 'string') {
                                            v.featured_image = res.translatedUrl;
                                        } else if (v.featured_image.src) {
                                            v.featured_image.src = res.translatedUrl;
                                        }
                                    }
                                });
                            }
                        }
                    });
                    console.log(`[Translate] Successfully processed ${targetImagesForGoogle.length} images.`);
                } else {
                    console.log(`[Translate] No images have text overlays to translate. All original clean photos preserved.`);
                }
            }
        } catch (imgLoopErr) {
            console.error('[Translate] Image translation session error:', imgLoopErr.message);
        }
    }

    return product;
}

function cleanOptionForSku(value) {
    if (!value) return '';
    const str = String(value).trim();
    
    // Check if it matches a size pattern with suffix (e.g. SUK24, S/uk/24, XXL/UK26)
    // Matches common size codes (XS, S, M, L, XL, XXL, XXXL, 2XL, 3XL, 4XL) at the start,
    // optionally followed by non-letters (like / or -), or words like 'uk', 'us', 'eu', or digits.
    const sizeMatch = str.match(/^(XS|S|M|L|XL|XXL|XXXL|[234]XL)(?:[^a-zA-Z]|uk|us|eu|\d|$)/i);
    if (sizeMatch) {
        return sizeMatch[1].toUpperCase();
    }
    
    // Otherwise, clean default: remove special characters, trim
    return str.replace(/[^a-zA-Z0-9]/g, '').trim();
}

module.exports = router;
