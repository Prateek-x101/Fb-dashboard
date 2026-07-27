const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const geminiService = require('../services/gemini');
const fetch = require('node-fetch');
const { getStorage, saveStorage } = require('../services/storage');

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
                    status
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

// Helper: Query definition of custom.floating_videos metafield to detect if it's file_reference or list.file_reference
async function getFloatingVideoMetafieldType(shopUrl, accessToken) {
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
                return match.node.type.name; // e.g. "file_reference" or "list.file_reference"
            }
        }
    } catch (e) {
        console.error('Failed to query metafield definitions:', e.message);
    }
    return 'file_reference'; // fallback
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

// 4. Scrape Product Details and fetch suggested collections
router.get('/scrape', async (req, res) => {
    try {
        const { url, storeId } = req.query;
        if (!url || !storeId) {
            return res.status(400).json({ error: 'Product URL and Store Selection are required.' });
        }

        // Parse target URL and append .js
        const parsedUrl = new URL(url);
        parsedUrl.search = '';
        const jsUrl = parsedUrl.origin + parsedUrl.pathname + '.js';

        console.log(`Scraping Shopify product metadata from: ${jsUrl}`);
        const scrapeRes = await fetch(jsUrl);
        if (!scrapeRes.ok) {
            throw new Error(`Failed to scrape target product page. Shopify returned status ${scrapeRes.status}`);
        }
        const product = await scrapeRes.json();

        // Get Shopify Store credentials
        const storage = getStorage();
        const store = (storage.shopifyStores || []).find(s => s.id === storeId);
        if (!store) {
            return res.status(400).json({ error: 'Selected shopify store config not found.' });
        }

        // Fetch user store's collections
        const userCollections = await fetchUserCollections(store.shopUrl, store.accessToken);

        // Get Gemini API Key to suggest collections
        const geminiApiKey = storage.settings?.geminiApiKey;
        const geminiModel = storage.settings?.geminiModel || 'gemini-1.5-flash';
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
                const cleanedSuggestion = suggestion.replace(/```json/g, '').replace(/```/g, '').trim();
                suggestedCollectionIds = JSON.parse(cleanedSuggestion);
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
        const { storeId, product, skuPrefix, price, comparePrice, collectionIds, floatingVideos } = req.body;
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
            const opt1 = v.option1 ? v.option1.replace(/[^a-zA-Z0-9]/g, '').trim() : '';
            const opt2 = v.option2 ? '-' + v.option2.replace(/[^a-zA-Z0-9]/g, '').trim() : '';
            const opt3 = v.option3 ? '-' + v.option3.replace(/[^a-zA-Z0-9]/g, '').trim() : '';
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
        if (Array.isArray(floatingVideos) && floatingVideos.length > 0) {
            try {
                console.log(`Uploading ${floatingVideos.length} Floating Video(s) to Shopify...`);
                // Upload all videos in parallel
                const uploadPromises = floatingVideos.map(async (vid) => {
                    if (vid.filePath && fs.existsSync(vid.filePath)) {
                        const fileId = await uploadFileToShopify(store.shopUrl, store.accessToken, vid.filePath, vid.filename || path.basename(vid.filePath));
                        return fileId;
                    }
                    return null;
                });
                
                const uploadResults = await Promise.allSettled(uploadPromises);
                uploadResults.forEach((r, idx) => {
                    if (r.status === 'rejected') {
                        console.error(`Video upload ${idx} failed:`, r.reason);
                    }
                });
                const fileIds = uploadResults
                    .filter(r => r.status === 'fulfilled' && r.value)
                    .map(r => r.value);
                
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
                handle: generateCleanHandle(product.title),
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

        // Match variants to their respective images (featured_image)
        try {
            const createdVariants = createdProduct.variants || [];
            const createdImages = createdProduct.images || [];
            const updatePromises = [];

            for (let i = 0; i < createdVariants.length; i++) {
                const createdVar = createdVariants[i];
                // Find matching target scraped variant
                const targetVar = (product.variants || []).find(tv => 
                    tv.option1 === createdVar.option1 &&
                    tv.option2 === createdVar.option2 &&
                    tv.option3 === createdVar.option3
                );

                // Support direct image index assignment (used by video-to-listing flow)
                if (targetVar && targetVar.variant_image_index !== undefined && createdImages[targetVar.variant_image_index]) {
                    const matchedImage = createdImages[targetVar.variant_image_index];
                    const updateUrl = `https://${store.shopUrl}/admin/api/2024-04/variants/${createdVar.id}.json`;
                    updatePromises.push(
                        fetch(updateUrl, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': store.accessToken },
                            body: JSON.stringify({ variant: { id: createdVar.id, image_id: matchedImage.id } })
                        }).then(async r => {
                            if (!r.ok) console.warn(`Failed to link image for variant ${createdVar.id}: ${await r.text()}`);
                        })
                    );
                } else if (targetVar && targetVar.featured_image && targetVar.featured_image.src) {
                    const targetImageSrc = targetVar.featured_image.src;
                    const targetClean = targetImageSrc.split('?')[0];
                    const targetFilename = targetClean.substring(targetClean.lastIndexOf('/') + 1);

                    // Method 1: Match by index of target image in original scraped gallery
                    let targetIndex = (product.images || []).findIndex(imgUrl => {
                        const cleanImgUrl = imgUrl.split('?')[0];
                        return cleanImgUrl.endsWith(targetFilename);
                    });

                    let matchedImage = null;
                    if (targetIndex !== -1 && createdImages[targetIndex]) {
                        matchedImage = createdImages[targetIndex];
                    } else {
                        // Method 2: Match by filename substring in newly created Shopify images
                        matchedImage = createdImages.find(img => {
                            const cleanCreated = img.src.split('?')[0];
                            return cleanCreated.includes(targetFilename) || targetClean.includes(cleanCreated.substring(cleanCreated.lastIndexOf('/') + 1));
                        });
                    }

                    if (matchedImage) {
                        const updateUrl = `https://${store.shopUrl}/admin/api/2024-04/variants/${createdVar.id}.json`;
                        updatePromises.push(
                            fetch(updateUrl, {
                                method: 'PUT',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'X-Shopify-Access-Token': store.accessToken
                                },
                                body: JSON.stringify({
                                    variant: {
                                        id: createdVar.id,
                                        image_id: matchedImage.id
                                    }
                                })
                            }).then(async r => {
                                if (!r.ok) {
                                    console.warn(`Failed to link image for variant ${createdVar.id}: ${await r.text()}`);
                                }
                            })
                        );
                    }
                }
            }

            if (updatePromises.length > 0) {
                console.log(`Linking ${updatePromises.length} variant images in parallel...`);
                await Promise.allSettled(updatePromises);
            }
        } catch (variantImgErr) {
            console.error('Failed to link images to product variants:', variantImgErr.message);
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
        res.json({ success: true, productId: createdProductId, title: createdProduct.title, productUrl });
    } catch (error) {
        res.status(500).json({ error: 'Failed to import product to Shopify', details: error.message });
    }
});

// 6. AI description enhancer/recreator
router.post('/ai-description', async (req, res) => {
    try {
        const { action, description, productTitle } = req.body;
        if (!description || !action) {
            return res.status(400).json({ error: 'Description and action are required.' });
        }

        const storage = getStorage();
        const geminiApiKey = storage.settings?.geminiApiKey;
        const geminiModel = storage.settings?.geminiModel || 'gemini-1.5-flash';

        if (!geminiApiKey) {
            return res.status(400).json({ error: 'Gemini API Key is not configured. Please add it in Settings.' });
        }

        let prompt = '';
        if (action === 'enhance') {
            prompt = `You are a professional e-commerce copywriter. Enhance and polish the following product description HTML for the product "${productTitle || ''}". 
Improve the copy, make it persuasive and professional, fix grammatical errors, and ensure it looks clean and attractive when rendered. 
Do NOT completely rewrite the entire structure or discard key product details unless they are spammy or irrelevant. 
Return ONLY the enhanced HTML code. Do not include any markdown block formatting (like \`\`\`html or \`\`\`), backticks, or introduction/explanation.`;
        } else if (action === 'recreate') {
            prompt = `You are a professional e-commerce copywriter. Recreate a brand-new, extremely high-converting and beautifully structured product description in HTML for the product "${productTitle || ''}".
Use modern copywriting techniques (hook, problem, solution, benefit bullet points, specifications, and trust badges or satisfaction guarantee).
Make it visually appealing with clean HTML formatting (use elements like <h3>, <p>, <ul>, <li>, and <strong>). Do not include any CSS styles or scripts.
The original description is:
"${description}"

Return ONLY the recreated HTML code. Do not include any markdown block formatting (like \`\`\`html or \`\`\`), backticks, or introduction/explanation.`;
        } else {
            return res.status(400).json({ error: 'Invalid action. Must be "enhance" or "recreate".' });
        }

        const resultHtml = await geminiService.generateResponseText(geminiApiKey, geminiModel, `${prompt}\n\nInput HTML/Description:\n${description}`);
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
            }
        }

        if (!allFrames.length) throw new Error('No usable frames or images could be extracted from the uploaded files.');
        console.log(`Media→Listing: ${allFrames.length} total frames/images. Analyzing with Gemini Vision...`);

        const framesBase64 = allFrames.map(f => f.base64);
        const analysis = await geminiService.analyzeProductFromFrames(geminiApiKey, geminiModel, framesBase64);

        // Save only selected frames/images to uploads/ for serving
        const selectedIndices = (analysis.selectedIndices && analysis.selectedIndices.length)
            ? analysis.selectedIndices
            : allFrames.map((_, i) => i).slice(0, 8);

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

        res.json({
            success: true,
            frames: savedFrames,
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
            if (filePath && fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch {} }
        }
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

        const uploadsDir = path.join(__dirname, '..', 'uploads');
        const framesBase64 = frameFilenames.map(filename => {
            const filePath = path.join(uploadsDir, filename);
            return fs.readFileSync(filePath).toString('base64');
        });

        const result = await geminiService.assignImagesToVariants(geminiApiKey, geminiModel, framesBase64, variantOption, variantValues);
        res.json({ success: true, assignments: result.assignments || {} });
    } catch (error) {
        console.error('Assign variant images error:', error.message);
        res.status(500).json({ error: 'Failed to assign images to variants', details: error.message });
    }
});

module.exports = router;
