const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const geminiService = require('../services/gemini');

const { getStorage, saveStorage } = require('../services/storage');

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
        const { storeId, product, skuPrefix, price, comparePrice, collectionIds } = req.body;
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

            return {
                option1: v.option1 || null,
                option2: v.option2 || null,
                option3: v.option3 || null,
                price: String(price || (v.price / 100).toFixed(2)),
                compare_at_price: comparePrice ? String(comparePrice) : (v.compare_at_price ? String((v.compare_at_price / 100).toFixed(2)) : null),
                sku: generatedSku,
                taxable: false
            };
        });

        // Formulate images (append https: if start with //)
        const images = (product.images || []).map(imgUrl => {
            const src = imgUrl.startsWith('//') ? 'https:' + imgUrl : imgUrl;
            return { src };
        });

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
                handle: generateCleanHandle(product.title)
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

            for (let i = 0; i < createdVariants.length; i++) {
                const createdVar = createdVariants[i];
                // Find matching target scraped variant
                const targetVar = (product.variants || []).find(tv => 
                    tv.option1 === createdVar.option1 &&
                    tv.option2 === createdVar.option2 &&
                    tv.option3 === createdVar.option3
                );

                if (targetVar && targetVar.featured_image && targetVar.featured_image.src) {
                    const targetImageSrc = targetVar.featured_image.src;
                    // Find matching created image in Shopify
                    const matchedImage = createdImages.find(img => {
                        const cleanCreated = img.src.split('?')[0];
                        const cleanTarget = targetImageSrc.split('?')[0];
                        return cleanCreated.endsWith(cleanTarget.substring(cleanTarget.lastIndexOf('/') + 1));
                    });

                    if (matchedImage) {
                        const updateUrl = `https://${store.shopUrl}/admin/api/2024-04/variants/${createdVar.id}.json`;
                        await fetch(updateUrl, {
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
                        });
                    }
                }
            }
        } catch (variantImgErr) {
            console.error('Failed to link images to product variants:', variantImgErr.message);
        }

        // Link product to selected collections
        if (Array.isArray(collectionIds) && collectionIds.length > 0) {
            for (const collId of collectionIds) {
                try {
                    const collectUrl = `https://${store.shopUrl}/admin/api/2024-04/collects.json`;
                    await fetch(collectUrl, {
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
                } catch (collectErr) {
                    console.error(`Failed to associate product with collection ${collId}:`, collectErr.message);
                }
            }
        }

        const productUrl = `https://${actualDomain}/products/${createdProduct.handle}`;
        res.json({ success: true, productId: createdProductId, title: createdProduct.title, productUrl });
    } catch (error) {
        res.status(500).json({ error: 'Failed to import product to Shopify', details: error.message });
    }
});

module.exports = router;
