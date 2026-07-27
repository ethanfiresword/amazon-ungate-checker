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

// Lookup UPC or EAN barcode in Amazon SP-API Catalog API
async function lookupUpcInAmazonCatalog(upc, accessToken) {
  try {
    const cleanUpc = upc.trim().replace(/\D/g, '');
    if (!cleanUpc) return null;
    const type = cleanUpc.length === 13 ? 'EAN' : (cleanUpc.length === 8 ? 'JAN' : 'UPC');
    const url = `${CONFIG.apiBaseUrl}/catalog/2022-04-01/items?identifiers=${encodeURIComponent(cleanUpc)}&identifiersType=${type}&marketplaceIds=${CONFIG.marketplaceId}&includedData=summaries`;
    
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
        return { asin, title: fullTitle, brand };
      }
    }
  } catch (e) {
    console.error(`UPC Lookup error for ${upc}:`, e.message);
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
        const rawUpc = upcs[currentIndex];
        const match = await lookupUpcInAmazonCatalog(rawUpc, accessToken);

        if (match && match.asin) {
          const checkResult = await checkSingleAsinWithRetry(match.asin, accessToken);
          results[currentIndex] = {
            upc: rawUpc,
            asin: match.asin,
            title: checkResult.title || match.title || `ASIN ${match.asin}`,
            brand: checkResult.brand || match.brand || '',
            status: checkResult.status,
            hasApprovalRoute: checkResult.hasApprovalRoute,
            reasonCode: checkResult.reasonCode || '',
            reasons: checkResult.reasons || []
          };
        } else {
          results[currentIndex] = {
            upc: rawUpc,
            asin: null,
            title: 'No Amazon ASIN Found',
            brand: '',
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

// Helper: Live AI Dynamic Product & Brand Intelligence Engine via Gemini
async function analyzeAnyBrandWithAi(brandName, productTitle, asin, spApiResult, userApiKey) {
  const apiKey = userApiKey || process.env.GEMINI_API_KEY;
  const isUngatedOrSoft = !spApiResult || spApiResult.status === 'ungated' || (spApiResult.status === 'gated' && spApiResult.hasApprovalRoute);

  if (apiKey && !apiKey.startsWith('AIzaSyBx9')) {
    try {
      const prompt = `You are an expert Amazon Wholesale Arbitrage & Brand Compliance AI Analyst.
Analyze the feasibility of selling products by brand "${brandName}" (Product: "${productTitle}", ASIN: ${asin || 'N/A'}).

Respond strictly with a JSON object (no markdown formatting, no text wrap) matching this exact schema:
{
  "brandName": "${brandName}",
  "resellersAllowed": true,
  "resellerPolicy": "Detailed breakdown of brand reseller policy on Amazon (e.g. MAP compliance vs strict IP enforcement)",
  "ipRiskLevel": "LOW",
  "overallDoable": true,
  "overallReason": "1-sentence summary explanation for an Amazon reseller",
  "distributors": [
    {
      "name": "Authorized B2B Wholesaler or Distributor Name",
      "url": "https://exact-distributor-website.com",
      "email": "sales@exact-distributor-website.com"
    }
  ]
}

Rules:
1. If the brand is a Private Label / Direct-to-Consumer brand that enforces strict Brand Registry IP complaints on Amazon 3rd-party sellers (e.g. Apple, Bose, Nike, Dyson, Chanel, Rolex, Lume), set resellersAllowed: false, ipRiskLevel: "HIGH", overallDoable: false.
2. If the brand allows MAP-compliant 3rd-party wholesale sellers, set resellersAllowed: true, overallDoable: true.
3. Provide 1-3 REAL, ACCURATE B2B wholesale suppliers or official corporate sales portals for this brand with real website URLs and sales emails.`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const parsed = JSON.parse(text);
          parsed.overallDoable = parsed.resellersAllowed && parsed.ipRiskLevel !== 'HIGH' && isUngatedOrSoft;
          return parsed;
        }
      }
    } catch (e) {
      console.error('Gemini AI Dynamic Brand Error:', e.message);
    }
  }

  // Built-in Dynamic Fallback Rules Engine for Any Brand
  const cleanBrand = (brandName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const HIGH_RISK_BRANDS = new Set(['apple', 'bose', 'nike', 'chanel', 'dyson', 'rolex', 'louisvuitton', 'beats', 'lume']);
  const isHighRisk = HIGH_RISK_BRANDS.has(cleanBrand);
  const resellersAllowed = !isHighRisk;
  const overallDoable = resellersAllowed && isUngatedOrSoft;

  let overallReason = '';
  if (!overallDoable) {
    if (isHighRisk) {
      overallReason = `Brand "${brandName}" restricts 3rd-party Amazon resellers and carries high Brand Registry IP complaint risk.`;
    } else if (!isUngatedOrSoft) {
      overallReason = `Hard restricted on Amazon (Your account is not eligible for ungating application for this ASIN).`;
    }
  } else {
    overallReason = `Product & brand "${brandName}" are 100% viable for wholesale arbitrage & 3rd-party selling!`;
  }

  const brandSlug = cleanBrand || 'brand';
  const distributors = isHighRisk ? [] : [
    {
      name: `${brandName} Direct Corporate B2B Wholesale Portal`,
      url: `https://www.${brandSlug}.com`,
      email: `wholesale@${brandSlug}.com`
    }
  ];

  return {
    brandName,
    resellersAllowed,
    resellerPolicy: isHighRisk ? `Brand "${brandName}" enforces strict Brand Registry IP complaints.` : `Brand "${brandName}" permits MAP-compliant 3rd-party resellers.`,
    ipRiskLevel: isHighRisk ? 'HIGH' : 'LOW',
    overallDoable,
    overallReason,
    distributors
  };
}

// API Endpoint 3: Dynamic AI Product & Brand Verification Engine
app.post('/api/verify-product', async (req, res) => {
  const { input, apiKey } = req.body;
  if (!input || typeof input !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "input" parameter' });
  }

  const query = input.trim();
  let asin = '';
  let brandName = query;
  let productTitle = query;
  let spApiResult = null;

  try {
    const accessToken = await getAccessToken();

    // Check 1: ASIN lookup
    if (/^[A-Z0-9]{10}$/i.test(query)) {
      asin = query.toUpperCase();
      spApiResult = await checkSingleAsinWithRetry(asin, accessToken);
      if (spApiResult.brand) brandName = spApiResult.brand;
      if (spApiResult.title) productTitle = spApiResult.title;
    } 
    // Check 2: UPC lookup
    else if (/^\d{12,14}$/.test(query)) {
      const upcMatch = await lookupUpcInAmazonCatalog(query, accessToken);
      if (upcMatch && upcMatch.asin) {
        asin = upcMatch.asin;
        spApiResult = await checkSingleAsinWithRetry(asin, accessToken);
        if (spApiResult.brand) brandName = spApiResult.brand;
        if (spApiResult.title) productTitle = upcMatch.title;
      }
    } 
    // Check 3: Brand or Keyword search
    else {
      asin = '';
    }

    const aiReport = await analyzeAnyBrandWithAi(brandName, productTitle, asin, spApiResult, apiKey);

    res.json({
      query,
      asin,
      brandName: aiReport.brandName || brandName,
      productTitle: productTitle || query,
      overallDoable: aiReport.overallDoable,
      overallReason: aiReport.overallReason,
      resellersAllowed: aiReport.resellersAllowed,
      ipRiskLevel: aiReport.ipRiskLevel,
      resellerPolicy: aiReport.resellerPolicy,
      distributors: aiReport.distributors || [],
      spApiResult
    });

  } catch (error) {
    console.error('Error during product verification:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SP-API Backend Server running at http://localhost:${PORT}`);
  console.log(`📂 Serving Web App Dashboard...`);
});
