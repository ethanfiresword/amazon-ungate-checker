require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve the frontend web app statically
app.use(express.static(__dirname));

// SP-API Configuration
const CONFIG = {
  clientId: process.env.SP_CLIENT_ID,
  clientSecret: process.env.SP_CLIENT_SECRET,
  refreshToken: process.env.SP_REFRESH_TOKEN,
  sellerId: process.env.SELLER_ID,
  marketplaceId: process.env.MARKETPLACE_ID || 'ATVPDKIKX0DER',
  tokenUrl: 'https://api.amazon.com/auth/o2/token',
  apiBaseUrl: 'https://sellingpartnerapi-na.amazon.com',
  requestsPerSecond: 5,
};

let cachedAccessToken = null;
let tokenExpirationTime = null;

async function getAccessToken() {
  if (cachedAccessToken && tokenExpirationTime && Date.now() < tokenExpirationTime) {
    return cachedAccessToken;
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: CONFIG.refreshToken,
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
  });

  const res = await fetch(CONFIG.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to get access token: ${res.status} - ${errText}`);
  }

  const data = await res.json();
  cachedAccessToken = data.access_token;
  tokenExpirationTime = Date.now() + (data.expires_in - 60) * 1000;
  return cachedAccessToken;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Persistent Disk Cache
const CACHE_FILE = path.join(__dirname, 'asin_cache.json');
let asinCache = {};
try {
  if (fs.existsSync(CACHE_FILE)) {
    asinCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  }
} catch (e) {
  asinCache = {};
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(asinCache, null, 2));
  } catch (e) {}
}

// Fetch real Amazon Brand & Title via SP-API Catalog API + Fallback
async function getAsinTitleAndBrand(asin, accessToken) {
  try {
    const url = `${CONFIG.apiBaseUrl}/catalog/2022-04-01/items/${asin}?marketplaceIds=${CONFIG.marketplaceId}&includedData=summaries`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-amz-access-token': accessToken,
        'Accept': 'application/json'
      }
    });
    if (res.ok) {
      const data = await res.json();
      const summary = data.summaries && data.summaries[0];
      if (summary) {
        const brand = summary.brandName || summary.brand || summary.manufacturer || '';
        const itemName = summary.itemName || '';
        if (brand || itemName) {
          const fullTitle = brand ? `[${brand}] ${itemName}` : itemName;
          return { brand, title: fullTitle };
        }
      }
    }
  } catch (e) {}

  return { brand: '', title: `ASIN ${asin}` };
}

// Single ASIN Check with 429 Retry Backoff & Cache
async function checkSingleAsinWithRetry(asin, accessToken, retries = 3) {
  // Check cache first
  if (asinCache[asin] && asinCache[asin].title && !asinCache[asin].title.startsWith('Amazon Product') && asinCache[asin].title !== '-') {
    return { ...asinCache[asin], cached: true };
  }

  // Fetch real Brand & Title
  const productInfo = await getAsinTitleAndBrand(asin, accessToken);
  const fetchedTitle = productInfo.title;
  const fetchedBrand = productInfo.brand;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const url = `${CONFIG.apiBaseUrl}/listings/2021-08-01/restrictions?sellerId=${CONFIG.sellerId}&asin=${asin}&conditionType=new_new&marketplaceIds=${CONFIG.marketplaceId}`;
    
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-amz-access-token': accessToken,
        'Accept': 'application/json'
      }
    });

    if (res.status === 429) {
      const backoffMs = attempt * 1500;
      await delay(backoffMs);
      continue;
    }

    if (!res.ok) {
      const errorBody = await res.text();
      let errorMessage = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(errorBody);
        if (parsed.errors && parsed.errors.length > 0) {
          errorMessage = `HTTP ${res.status}: ${JSON.stringify(parsed, null, 2)}`;
        }
      } catch (e) {}
      return { asin, brand: fetchedBrand, title: fetchedTitle, status: 'error', error: errorMessage };
    }

    const data = await res.json();
    const restrictions = data.restrictions || [];

    let result;
    if (restrictions.length === 0) {
      result = { asin, brand: fetchedBrand, title: fetchedTitle, status: 'ungated' };
    } else {
      const reasons = restrictions[0]?.reasons || [];
      const reasonCode = reasons[0]?.reasonCode || '';
      
      const hasApprovalRoute = reasonCode === 'APPROVAL_REQUIRED' || restrictions.some(r => 
        r.reasons && r.reasons.some(reason => 
          reason.reasonCode === 'APPROVAL_REQUIRED' || 
          (reason.links && reason.links.some(link => link.type === 'APPROVAL_REQUIRED' || link.type === 'APPROVAL_APPLICATION'))
        )
      );

      result = { 
        asin, 
        brand: fetchedBrand,
        title: fetchedTitle,
        status: 'gated', 
        restrictions, 
        hasApprovalRoute, 
        reasonCode: hasApprovalRoute ? 'APPROVAL_REQUIRED' : (reasonCode || 'NOT_ELIGIBLE'),
        reasons 
      };
    }

    // Save to cache
    asinCache[asin] = result;
    return result;
  }

  return { asin, brand: fetchedBrand, title: fetchedTitle, status: 'error', error: 'HTTP 429 Rate limit exceeded after retries' };
}

// Parallel Concurrency Pool (Runs 6 requests in parallel for maximum speed)
async function processBatchConcurrent(asins, accessToken, concurrency = 6) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < asins.length) {
      const currentIndex = index++;
      const asin = asins[currentIndex];
      const result = await checkSingleAsinWithRetry(asin, accessToken);
      results[currentIndex] = result;
      await delay(120);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, asins.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  saveCache();
  return results;
}

// Look up product name from free barcode databases when we only have a UPC
async function lookupProductNameByUpc(upc) {
  const cleanUpc = (upc || '').trim().replace(/\D/g, '');
  if (!cleanUpc || cleanUpc.length < 8) return null;

  // Try 1: UPCitemdb.com (free, no key required for basic lookups)
  try {
    const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${cleanUpc}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'Amazon-Product-Finder/1.0' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.items && data.items.length > 0) {
        const item = data.items[0];
        const title = item.title || item.description || '';
        const brand = item.brand || '';
        if (title) {
          console.log(`  [UPCitemdb] Found: "${brand ? brand + ' ' : ''}${title}" for UPC ${cleanUpc}`);
          return { title, brand };
        }
      }
    }
  } catch (e) {}

  // Try 2: Open Food Facts (free, open source, good for health/beauty/food)
  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${cleanUpc}.json?fields=product_name,brands`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'Amazon-Product-Finder/1.0' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.status === 1 && data.product) {
        const title = data.product.product_name || '';
        const brand = data.product.brands || '';
        if (title) {
          console.log(`  [OpenFoodFacts] Found: "${brand ? brand + ' ' : ''}${title}" for UPC ${cleanUpc}`);
          return { title, brand };
        }
      }
    }
  } catch (e) {}

  return null;
}

// Enhanced UPC/EAN/GTIN/Title lookup in Amazon SP-API Catalog API
async function lookupUpcInAmazonCatalog(itemInput, accessToken) {
  let rawUpc = '';
  let itemTitle = '';

  if (typeof itemInput === 'string') {
    rawUpc = itemInput;
  } else if (typeof itemInput === 'object' && itemInput !== null) {
    rawUpc = itemInput.upc || itemInput.barcode || itemInput.code || '';
    itemTitle = itemInput.title || itemInput.name || itemInput.productName || '';
  }

  let cleanUpc = (rawUpc || '').trim().replace(/\D/g, '');
  if (cleanUpc.length === 11) {
    cleanUpc = '0' + cleanUpc;
  }

  // 1. Try identifier-based lookups (UPC, GTIN-14, EAN)
  if (cleanUpc) {
    const typesToTry = [];
    if (cleanUpc.length === 12) {
      typesToTry.push({ type: 'GTIN', value: cleanUpc.padStart(14, '0') });
      typesToTry.push({ type: 'UPC', value: cleanUpc });
      typesToTry.push({ type: 'EAN', value: '0' + cleanUpc });
    } else if (cleanUpc.length === 13) {
      typesToTry.push({ type: 'EAN', value: cleanUpc });
      typesToTry.push({ type: 'GTIN', value: '0' + cleanUpc });
    } else if (cleanUpc.length === 14) {
      typesToTry.push({ type: 'GTIN', value: cleanUpc });
    } else if (cleanUpc.length === 8) {
      typesToTry.push({ type: 'JAN', value: cleanUpc });
    } else {
      typesToTry.push({ type: 'UPC', value: cleanUpc });
    }

    for (const entry of typesToTry) {
      try {
        const url = `${CONFIG.apiBaseUrl}/catalog/2022-04-01/items?identifiers=${encodeURIComponent(entry.value)}&identifiersType=${entry.type}&marketplaceIds=${CONFIG.marketplaceId}&includedData=summaries`;
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'x-amz-access-token': accessToken,
            'Accept': 'application/json'
          }
        });

        if (res.ok) {
          const data = await res.json();
          if (data.items && data.items.length > 0) {
            const item = data.items[0];
            const asin = item.asin;
            const summary = item.summaries && item.summaries[0];
            const brand = summary ? (summary.brandName || summary.brand || summary.manufacturer || '') : '';
            const title = summary ? (summary.itemName || '') : '';
            const fullTitle = brand ? `[${brand}] ${title}` : title;
            return { asin, title: fullTitle, brand, matchedBy: entry.type };
          }
        }
      } catch (e) {}
    }
  }

  // 2. If no title was provided by the frontend, look up the UPC in free barcode databases
  if (!itemTitle && cleanUpc) {
    const productInfo = await lookupProductNameByUpc(cleanUpc);
    if (productInfo && productInfo.title) {
      itemTitle = productInfo.brand ? `${productInfo.brand} ${productInfo.title}` : productInfo.title;
      console.log(`  [Barcode DB Fallback] Using title "${itemTitle}" for UPC ${cleanUpc}`);
    }
  }

  // 3. Title / Keyword Fallback Search using Amazon Catalog keyword search
  if (itemTitle && itemTitle.length > 3) {
    try {
      const cleanKeywords = itemTitle.replace(/[^\w\s]/gi, '').slice(0, 60).trim();
      if (cleanKeywords) {
        const url = `${CONFIG.apiBaseUrl}/catalog/2022-04-01/items?keywords=${encodeURIComponent(cleanKeywords)}&marketplaceIds=${CONFIG.marketplaceId}&includedData=summaries`;
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'x-amz-access-token': accessToken,
            'Accept': 'application/json'
          }
        });

        if (res.ok) {
          const data = await res.json();
          if (data.items && data.items.length > 0) {
            const item = data.items[0];
            const asin = item.asin;
            const summary = item.summaries && item.summaries[0];
            const brand = summary ? (summary.brandName || summary.brand || summary.manufacturer || '') : '';
            const title = summary ? (summary.itemName || '') : '';
            const fullTitle = brand ? `[${brand}] ${title}` : title;
            return { asin, title: fullTitle, brand, matchedBy: 'KEYWORD_TITLE' };
          }
        }
      }
    } catch (e) {}
  }

  return null;
}

// High-Speed API Endpoint 1: ASIN Batch Check
app.post('/api/check', async (req, res) => {
  const { asins } = req.body;
  if (!asins || !Array.isArray(asins)) {
    return res.status(400).json({ error: 'Missing or invalid "asins" array in request body' });
  }

  try {
    const accessToken = await getAccessToken();
    const results = await processBatchConcurrent(asins, accessToken, 6);
    res.json({ results });
  } catch (error) {
    console.error('Server error during check:', error);
    res.status(500).json({ error: error.message });
  }
});

// Fetch Amazon Buy Box / Competitive Price for an ASIN
async function lookupAsinPrice(asin, accessToken) {
  if (!asin) return null;
  try {
    const url = `${CONFIG.apiBaseUrl}/products/pricing/v0/competitivePrice?MarketplaceId=${CONFIG.marketplaceId}&ItemType=Asin&Asins=${encodeURIComponent(asin)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-amz-access-token': accessToken,
        'Accept': 'application/json'
      }
    });
    if (res.ok) {
      const data = await res.json();
      const payload = data.payload && data.payload[0];
      if (payload && payload.Product && payload.Product.CompetitivePricing) {
        const prices = payload.Product.CompetitivePricing.CompetitivePrices || [];
        if (prices.length > 0) {
          const p = prices[0].Price;
          const listingPrice = p && p.LandedPrice ? parseFloat(p.LandedPrice.Amount) : (p && p.ListingPrice ? parseFloat(p.ListingPrice.Amount) : null);
          return listingPrice;
        }
      }
    }
  } catch (e) {
    console.error(`Error fetching price for ASIN ${asin}:`, e.message);
  }
  return null;
}

// API Endpoint 2: Convert UPCs to ASINs & Check Ungating Eligibility
app.post('/api/convert-upc', async (req, res) => {
  const { upcs } = req.body;
  if (!upcs || !Array.isArray(upcs)) {
    return res.status(400).json({ error: 'Missing or invalid "upcs" array in request body' });
  }

  try {
    const accessToken = await getAccessToken();
    const results = [];
    const concurrency = 6;
    let index = 0;

    async function worker() {
      while (index < upcs.length) {
        const currentIndex = index++;
        const itemInput = upcs[currentIndex];
        const rawUpc = typeof itemInput === 'string' ? itemInput : (itemInput.upc || itemInput.barcode || '');
        const match = await lookupUpcInAmazonCatalog(itemInput, accessToken);

        if (match && match.asin) {
          const checkResult = await checkSingleAsinWithRetry(match.asin, accessToken);
          const price = await lookupAsinPrice(match.asin, accessToken);
          results[currentIndex] = {
            upc: rawUpc,
            asin: match.asin,
            title: checkResult.title || match.title || `ASIN ${match.asin}`,
            brand: checkResult.brand || match.brand || '',
            amazonPrice: price,
            status: checkResult.status,
            hasApprovalRoute: checkResult.hasApprovalRoute,
            reasonCode: checkResult.reasonCode || '',
            reasons: checkResult.reasons || []
          };
        } else {
          results[currentIndex] = {
            upc: rawUpc,
            asin: null,
            title: typeof itemInput === 'object' && itemInput.title ? itemInput.title : 'No Amazon ASIN Found',
            brand: '',
            amazonPrice: null,
            status: 'no_match',
            hasApprovalRoute: false,
            reasonCode: 'NO_AMAZON_MATCH',
            reasons: []
          };
        }
        await delay(120);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, upcs.length); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
    saveCache();
    res.json({ results });
  } catch (error) {
    console.error('Server error during UPC conversion:', error);
    res.status(500).json({ error: error.message });
  }
});

// Fetch UPC/EAN barcodes for a given ASIN via SP-API Catalog API (identifiers data)
async function lookupAsinBarcodes(asin, accessToken) {
  try {
    const url = `${CONFIG.apiBaseUrl}/catalog/2022-04-01/items/${asin}?marketplaceIds=${CONFIG.marketplaceId}&includedData=summaries,identifiers`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-amz-access-token': accessToken,
        'Accept': 'application/json'
      }
    });

    if (!res.ok) return null;

    const data = await res.json();

    // Pull title/brand from summaries
    const summary = data.summaries && data.summaries[0];
    const brand = summary ? (summary.brandName || summary.brand || summary.manufacturer || '') : '';
    const itemName = summary ? (summary.itemName || '') : '';
    const fullTitle = brand ? `[${brand}] ${itemName}` : itemName;

    // Pull barcodes from identifiers
    const barcodes = [];
    if (data.identifiers) {
      for (const identGroup of data.identifiers) {
        if (identGroup.identifiers) {
          for (const ident of identGroup.identifiers) {
            if (['UPC', 'EAN', 'ISBN', 'JAN'].includes(ident.identifierType)) {
              barcodes.push({ type: ident.identifierType, value: ident.identifier });
            }
          }
        }
      }
    }

    return { asin, title: fullTitle, brand, barcodes };
  } catch (e) {
    return null;
  }
}

// API Endpoint 3: Reverse Lookup - Get UPCs for ASINs
app.post('/api/asin-to-upc', async (req, res) => {
  const { asins } = req.body;
  if (!asins || !Array.isArray(asins)) {
    return res.status(400).json({ error: 'Missing or invalid "asins" array in request body' });
  }

  try {
    const accessToken = await getAccessToken();
    const results = [];
    const concurrency = 6;
    let index = 0;

    async function worker() {
      while (index < asins.length) {
        const currentIndex = index++;
        const asin = asins[currentIndex];
        const data = await lookupAsinBarcodes(asin, accessToken);
        results[currentIndex] = data || { asin, title: `ASIN ${asin}`, brand: '', barcodes: [] };
        await delay(120);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, asins.length); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
    res.json({ results });
  } catch (error) {
    console.error('Server error during ASIN to UPC lookup:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Amazon Product Finder Server running on http://localhost:${PORT}`);
});
