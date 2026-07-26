require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);

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

async function checkAsinRestrictions(asin, accessToken) {
  const url = `${CONFIG.apiBaseUrl}/listings/2021-08-01/restrictions?sellerId=${CONFIG.sellerId}&asin=${asin}&conditionType=new_new&marketplaceIds=${CONFIG.marketplaceId}`;
  
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-amz-access-token': accessToken,
      'Accept': 'application/json'
    }
  });

  if (!res.ok) {
    const errorBody = await res.text();
    let errorMessage = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(errorBody);
      if (parsed.errors && parsed.errors.length > 0) {
        errorMessage = `HTTP ${res.status}: ${JSON.stringify(parsed, null, 2)}`;
      }
    } catch (e) {}
    return { asin, status: 'error', error: errorMessage };
  }

  const data = await res.json();
  const restrictions = data.restrictions || [];

  if (restrictions.length === 0) {
    return { asin, status: 'ungated' };
  } else {
    const reasons = restrictions[0]?.reasons || [];
    const reasonCode = reasons[0]?.reasonCode || '';
    
    // Check if any restriction has an approval route or reasonCode === 'APPROVAL_REQUIRED'
    const hasApprovalRoute = reasonCode === 'APPROVAL_REQUIRED' || restrictions.some(r => 
      r.reasons && r.reasons.some(reason => 
        reason.reasonCode === 'APPROVAL_REQUIRED' || 
        (reason.links && reason.links.some(link => link.type === 'APPROVAL_REQUIRED' || link.type === 'APPROVAL_APPLICATION'))
      )
    );

    return { 
      asin, 
      status: 'gated', 
      restrictions, 
      hasApprovalRoute, 
      reasonCode: hasApprovalRoute ? 'APPROVAL_REQUIRED' : (reasonCode || 'NOT_ELIGIBLE'),
      reasons 
    };
  }
}

const fs = require('fs');

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
  // 1. Try SP-API Catalog API
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

  // 2. Fast Fallback: Fetch Amazon Product Page metadata for Brand & Title
  try {
    const res = await fetch(`https://www.amazon.com/dp/${asin}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (res.ok) {
      const html = await res.text();
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      if (titleMatch) {
        let rawTitle = titleMatch[1].replace(/^Amazon\.com\s*:\s*/i, '').replace(/\s*:\s*Everything Else$/i, '').trim();
        // Brand extraction
        const brandMatch = html.match(/id="bylineInfo"[^>]*>(.*?)<\/a>/i) || html.match(/class="a-link-normal"[^>]*>Visit the (.*?) Store<\/a>/i);
        const brand = brandMatch ? brandMatch[1].replace(/^Brand:\s*/i, '').trim() : '';
        const fullTitle = brand ? `[${brand}] ${rawTitle}` : rawTitle;
        return { brand, title: fullTitle };
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
      // Micro-delay between parallel dispatches to stay smooth
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

const cheerio = require('cheerio');

// Search Amazon Catalog for an ASIN using product keywords / title
async function searchAmazonCatalog(query, accessToken) {
  try {
    const cleanQuery = query.replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!cleanQuery) return null;
    const url = `${CONFIG.apiBaseUrl}/catalog/2022-04-01/items?keywords=${encodeURIComponent(cleanQuery)}&marketplaceIds=${CONFIG.marketplaceId}&includedData=summaries`;
    
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
        const brand = summary ? (summary.brandName || summary.brand || '') : '';
        const title = summary ? (summary.itemName || '') : '';
        return { asin, amazonTitle: brand ? `[${brand}] ${title}` : title, brand };
      }
    }
  } catch (e) {
    console.error('Catalog search error:', e.message);
  }
  return null;
}

// Header profiles to bypass WAF / anti-bot / 403 Forbidden restrictions
const BROWSER_HEADER_PROFILES = [
  // Profile 1: Modern macOS Chrome with full Sec-Fetch & Client-Hint headers
  {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0'
  },
  // Profile 2: Googlebot Crawler (frequently whitelisted by e-commerce WAFs/Cloudflare for SEO indexing)
  {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  },
  // Profile 3: Modern Windows Firefox
  {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Upgrade-Insecure-Requests': '1'
  },
  // Profile 4: Mobile Safari (iOS)
  {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  }
];

async function fetchWithFallback(targetUrl) {
  let lastRes = null;
  let lastError = null;

  for (const headers of BROWSER_HEADER_PROFILES) {
    try {
      const res = await fetch(targetUrl, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        return res;
      }
      lastRes = res;
      // If 403, 401, 405, or 503 anti-bot error, try next header profile
      if ([403, 401, 405, 503].includes(res.status)) {
        continue;
      } else {
        return res;
      }
    } catch (err) {
      lastError = err;
    }
  }

  return lastRes;
}

// System Curl Fallback (Bypasses Node.js TLS Fingerprint 403 Blocks via Darwin/libcurl)
async function fetchHtmlWithCurl(url) {
  const userAgents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0'
  ];

  for (const ua of userAgents) {
    try {
      const { stdout } = await execFilePromise('curl', [
        '-sL',
        '-A', ua,
        '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        '-H', 'Accept-Language: en-US,en;q=0.9',
        '-H', 'Cache-Control: no-cache',
        '--max-time', '15',
        url
      ], { maxBuffer: 15 * 1024 * 1024 });

      if (stdout && stdout.length > 300 && !stdout.includes('<title>403 Forbidden</title>') && !stdout.includes('Access Denied')) {
        return stdout;
      }
    } catch (e) {}
  }
  return null;
}

// Scrape product catalog from any wholesaler / supplier website URL
async function scrapeProductsFromUrl(rawUrl) {
  let targetUrl = rawUrl.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  const scrapedItems = [];
  const parsedUrl = new URL(targetUrl);
  const origin = parsedUrl.origin;

  // 1. Try Shopify JSON endpoints (/products.json & /collections/all/products.json)
  const shopifyEndpoints = [
    `${origin}/products.json?limit=50`,
    `${origin}/collections/all/products.json?limit=50`
  ];

  for (const shopifyUrl of shopifyEndpoints) {
    try {
      const shopifyRes = await fetchWithFallback(shopifyUrl);
      if (shopifyRes && shopifyRes.ok) {
        const data = await shopifyRes.json();
        if (data.products && Array.isArray(data.products) && data.products.length > 0) {
          data.products.slice(0, 30).forEach(p => {
            const price = p.variants && p.variants[0] ? parseFloat(p.variants[0].price) || null : null;
            const sku = p.variants && p.variants[0] ? p.variants[0].sku || '' : '';
            const upc = p.variants && p.variants[0] ? p.variants[0].barcode || '' : '';
            scrapedItems.push({
              supplierTitle: p.title,
              supplierBrand: p.vendor || '',
              supplierPrice: price,
              supplierUrl: `${origin}/products/${p.handle}`,
              sku: sku || upc,
              type: 'shopify'
            });
          });
          if (scrapedItems.length > 0) return scrapedItems;
        }
      }
    } catch (e) {}
  }

  // 2. Fetch HTML Page with multi-stage fallback: Node Fetch -> System Curl -> Subpath Curl
  let html = null;
  let res = await fetchWithFallback(targetUrl);

  if (res && res.ok) {
    html = await res.text();
  }

  // Fallback Stage A: Try system curl (bypasses Node.js TLS fingerprinting 403 blocks)
  if (!html) {
    console.log(`⚠️ Standard fetch returned 403/error for ${targetUrl}. Trying system curl bypass...`);
    html = await fetchHtmlWithCurl(targetUrl);
  }

  // Fallback Stage B: Try catalog subpaths if homepage was provided
  if (!html && (parsedUrl.pathname === '/' || parsedUrl.pathname === '')) {
    const altPaths = ['/collections/all', '/shop', '/products', '/catalog', '/store'];
    for (const altPath of altPaths) {
      const altUrl = `${origin}${altPath}`;
      try {
        const altRes = await fetchWithFallback(altUrl);
        if (altRes && altRes.ok) {
          html = await altRes.text();
          targetUrl = altUrl;
          break;
        }
      } catch (e) {}

      html = await fetchHtmlWithCurl(altUrl);
      if (html) {
        targetUrl = altUrl;
        break;
      }
    }
  }

  if (!html) {
    throw new Error(`Failed to fetch website (403 Forbidden - Cloudflare / WAF Security Challenge). Try scanning a direct category or product page URL.`);
  }

  const $ = cheerio.load(html);

  // 3. Check for Schema.org JSON-LD scripts
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const items = Array.isArray(json) ? json : (json['@graph'] || [json]);
      items.forEach(item => {
        if (item['@type'] === 'Product' || item['@type'] === 'IndividualProduct') {
          const price = item.offers ? (Array.isArray(item.offers) ? item.offers[0]?.price : item.offers?.price) : null;
          scrapedItems.push({
            supplierTitle: item.name,
            supplierBrand: item.brand?.name || item.brand || '',
            supplierPrice: price ? parseFloat(price) : null,
            supplierUrl: item.url || targetUrl,
            sku: item.sku || item.gtin13 || item.gtin8 || '',
            type: 'schema'
          });
        }
      });
    } catch (e) {}
  });

  if (scrapedItems.length > 0) return scrapedItems.slice(0, 30);

  // 3.5 Microdata parsing ([itemtype*="Product"])
  $('[itemtype*="Product"]').each((_, el) => {
    if (scrapedItems.length >= 30) return;
    const card = $(el);
    const title = card.find('[itemprop="name"]').text().trim();
    const priceStr = card.find('[itemprop="price"]').attr('content') || card.find('[itemprop="price"]').text().trim().replace(/[^0-9.]/g, '');
    const brand = card.find('[itemprop="brand"]').text().trim();
    const itemUrl = card.find('[itemprop="url"]').attr('href') || card.find('a[href]').attr('href');
    let fullUrl = itemUrl;
    if (fullUrl && !fullUrl.startsWith('http')) {
      try { fullUrl = new URL(fullUrl, origin).toString(); } catch (e) { fullUrl = targetUrl; }
    }
    if (title && title.length > 2) {
      scrapedItems.push({
        supplierTitle: title,
        supplierBrand: brand || '',
        supplierPrice: priceStr ? parseFloat(priceStr) : null,
        supplierUrl: fullUrl || targetUrl,
        type: 'microdata'
      });
    }
  });

  if (scrapedItems.length > 0) return scrapedItems.slice(0, 30);

  // 4. Fallback DOM Parsing (Generic & Supplier-Specific Product Cards / Grids)
  const productSelectors = [
    '.product', '.product-card', '.product-item', '.grid-product', '.product-tile',
    'article', '[data-product-id]', '.type-product', '.woocommerce-LoopProduct-link',
    'li.product', '.product-inner', '.product-item-info', '.card-figure', '.grid__item',
    '.product-grid-item', '.item-product', '.sc-product', '.catalog-item',
    '.style-card', '.style-item', 'a[href*="/p/"]', '.productCard', '[data-style-id]', '.styleTile'
  ];

  for (const selector of productSelectors) {
    const cards = $(selector);
    if (cards.length > 0) {
      cards.each((_, el) => {
        if (scrapedItems.length >= 30) return;
        const card = $(el);
        const titleEl = card.find('h1, h2, h3, h4, .product-title, .title, a[href*="/product"], a[href*="/p/"], .product-item-link, .style-name').first();
        const title = titleEl.text().trim();
        const priceEl = card.find('.price, .product-price, [data-price], .money, .price-wrapper, .style-price').first();
        const priceText = priceEl.text().trim().replace(/[^0-9.]/g, '');
        const linkEl = card.find('a[href]').first();
        let href = linkEl.attr('href') || '';
        if (href && !href.startsWith('http')) {
          try { href = new URL(href, origin).toString(); } catch (e) { href = targetUrl; }
        }

        if (title && title.length > 3 && !/looks like we're having|access denied|cloudflare|just a moment|security check|attention required/i.test(title)) {
          scrapedItems.push({
            supplierTitle: title,
            supplierBrand: '',
            supplierPrice: priceText ? parseFloat(priceText) : null,
            supplierUrl: href || targetUrl,
            type: 'dom'
          });
        }
      });
      if (scrapedItems.length > 0) break;
    }
  }

  // 5. Ultimate Fallback: Single page title if it's a direct product page
  const ERROR_PAGE_PATTERNS = /looks like we're having|access denied|just a moment|cloudflare|attention required|403 forbidden|503 service|security check|page not found|404 not found|site maintenance|robot or human|verify you are human|blocked/i;

  if (scrapedItems.length === 0) {
    const rawTitle = $('h1').first().text().trim() || $('title').text().trim();
    if (rawTitle && ERROR_PAGE_PATTERNS.test(rawTitle)) {
      throw new Error(`Wholesaler site returned a security/error page ("${rawTitle}"). Please try entering a direct product page URL or category link (e.g. /ps/t-shirts).`);
    }

    const priceText = $('.price, [data-price], .money').first().text().trim().replace(/[^0-9.]/g, '');
    if (rawTitle && rawTitle.length > 3) {
      scrapedItems.push({
        supplierTitle: rawTitle.replace(/^Amazon\.com\s*:\s*/i, ''),
        supplierBrand: '',
        supplierPrice: priceText ? parseFloat(priceText) : null,
        supplierUrl: targetUrl,
        type: 'page'
      });
    }
  }

  return scrapedItems.slice(0, 30);
}

// Endpoint 1: High-Speed ASIN Batch Check
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

// Endpoint 2: Wholesaler Website Scraper & Cross-Verifier
app.post('/api/scrape-and-verify', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" parameter in request body' });
  }

  try {
    console.log(`🌐 Scraping wholesaler catalog from: ${url}`);
    const scrapedItems = await scrapeProductsFromUrl(url);
    if (scrapedItems.length === 0) {
      return res.status(404).json({ error: 'No products or catalog items found on the target website.' });
    }

    console.log(`🔍 Found ${scrapedItems.length} products. Cross-matching to Amazon SP-API...`);
    const accessToken = await getAccessToken();
    const results = [];

    for (let i = 0; i < scrapedItems.length; i++) {
      const item = scrapedItems[i];
      const match = await searchAmazonCatalog(item.supplierTitle, accessToken);

      if (match && match.asin) {
        const checkResult = await checkSingleAsinWithRetry(match.asin, accessToken);
        results.push({
          supplierTitle: item.supplierTitle,
          supplierPrice: item.supplierPrice,
          supplierUrl: item.supplierUrl,
          asin: match.asin,
          amazonTitle: checkResult.title || match.amazonTitle || `ASIN ${match.asin}`,
          status: checkResult.status,
          hasApprovalRoute: checkResult.hasApprovalRoute,
          reasonCode: checkResult.reasonCode || '',
          reasons: checkResult.reasons || []
        });
      } else {
        results.push({
          supplierTitle: item.supplierTitle,
          supplierPrice: item.supplierPrice,
          supplierUrl: item.supplierUrl,
          asin: null,
          amazonTitle: 'No Match Found on Amazon',
          status: 'no_match',
          hasApprovalRoute: false,
          reasonCode: 'NO_AMAZON_MATCH',
          reasons: []
        });
      }
      await delay(200);
    }

    res.json({ url, totalScraped: scrapedItems.length, results });
  } catch (error) {
    console.error('Server error during scrape-and-verify:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint 3: Direct Wholesaler Product List / Text / CSV Verifier
app.post('/api/verify-product-list', async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Missing or empty "items" array in request body' });
  }

  try {
    console.log(`📋 Received ${items.length} supplier products for Amazon cross-verification...`);
    const accessToken = await getAccessToken();
    const results = [];

    for (let i = 0; i < Math.min(items.length, 50); i++) {
      const rawItem = items[i];
      const supplierTitle = typeof rawItem === 'string' ? rawItem.trim() : (rawItem.title || rawItem.supplierTitle || '').trim();
      const supplierPrice = typeof rawItem === 'object' ? parseFloat(rawItem.price || rawItem.supplierPrice) || null : null;
      const supplierUrl = typeof rawItem === 'object' ? rawItem.url || rawItem.supplierUrl || '' : '';

      if (!supplierTitle) continue;

      const match = await searchAmazonCatalog(supplierTitle, accessToken);

      if (match && match.asin) {
        const checkResult = await checkSingleAsinWithRetry(match.asin, accessToken);
        results.push({
          supplierTitle,
          supplierPrice,
          supplierUrl,
          asin: match.asin,
          amazonTitle: checkResult.title || match.amazonTitle || `ASIN ${match.asin}`,
          status: checkResult.status,
          hasApprovalRoute: checkResult.hasApprovalRoute,
          reasonCode: checkResult.reasonCode || '',
          reasons: checkResult.reasons || []
        });
      } else {
        results.push({
          supplierTitle,
          supplierPrice,
          supplierUrl,
          asin: null,
          amazonTitle: 'No Match Found on Amazon',
          status: 'no_match',
          hasApprovalRoute: false,
          reasonCode: 'NO_AMAZON_MATCH',
          reasons: []
        });
      }
      await delay(200);
    }

    res.json({ totalProcessed: results.length, results });
  } catch (error) {
    console.error('Server error during verify-product-list:', error);
    res.status(500).json({ error: error.message });
  }
});

// Brand IP Risk Database
const HIGH_IP_RISK_BRANDS = [
  'nike', 'otterbox', 'popsockets', 'apple', 'disney', 'logitech', 'bose', 'dyson',
  'hydro flask', 'yeti', 'under armour', 'levis', 'levi\'s', 'ray-ban', 'gopro',
  'anker', 'spigen', 'sorel', 'ugg', 'carhartt', 'theragun', 'weber', 'traeger',
  'velcro', 'samsung', 'sony', 'canon', 'nikon', 'nintendo', 'playstation', 'xbox',
  'beachbody', 'trx', 'insanity', 'p90x', 'spanx', 'zippo', 'tide', 'clorox',
  'instant pot', 'ninja', 'shark', 'keurig', 'roomba', 'irobot', 'fitbit', 'garmin'
];

const MEDIUM_IP_RISK_BRANDS = [
  'lego', 'hasbro', 'mattel', 'nerf', 'funko', 'stanley', 'burts bees', 'burt\'s bees',
  'neutrogena', 'cerave', 'loreal', 'l\'oreal', 'olay', 'crest', 'oral-b', 'gillette'
];

function getIpRiskLevel(brandName) {
  const clean = brandName.toLowerCase().trim();
  if (HIGH_IP_RISK_BRANDS.some(b => clean.includes(b) || b.includes(clean))) {
    return {
      level: 'high',
      label: '🔴 High IP Risk',
      warning: 'Known aggressive IP Complaints & Brand Protection claims reported by sellers'
    };
  }
  if (MEDIUM_IP_RISK_BRANDS.some(b => clean.includes(b) || b.includes(clean))) {
    return {
      level: 'medium',
      label: '🟡 Moderate Risk',
      warning: 'Requires authorized distributor invoice or Brand LOA'
    };
  }
  return {
    level: 'low',
    label: '🟢 Low IP Risk',
    warning: 'Standard wholesale reseller friendly'
  };
}

// Dedicated Brand Catalog Matcher - Dynamically matches official brand attributes based on Wholesaler Industry Focus
async function searchAmazonBrandCatalog(targetBrand, categoryFocus, accessToken) {
  const cleanBrand = targetBrand.trim();
  if (!cleanBrand) return null;

  let searchQueries = [];
  if (categoryFocus === 'apparel') {
    searchQueries = [
      `${cleanBrand} apparel clothing t-shirt`,
      `${cleanBrand} shirt hoodie polo`,
      cleanBrand
    ];
  } else if (categoryFocus === 'toys') {
    searchQueries = [
      `${cleanBrand} toy game action figure`,
      cleanBrand
    ];
  } else if (categoryFocus === 'beauty') {
    searchQueries = [
      `${cleanBrand} beauty skin care health`,
      cleanBrand
    ];
  } else if (categoryFocus === 'home') {
    searchQueries = [
      `${cleanBrand} home kitchen tumbler`,
      cleanBrand
    ];
  } else if (categoryFocus === 'electronics') {
    searchQueries = [
      `${cleanBrand} electronics cable charger tech`,
      cleanBrand
    ];
  } else {
    // General Wholesale / Auto-Detect
    searchQueries = [
      `${cleanBrand} official`,
      cleanBrand
    ];
  }

  for (const queryStr of searchQueries) {
    try {
      const url = `${CONFIG.apiBaseUrl}/catalog/2022-04-01/items?keywords=${encodeURIComponent(queryStr)}&marketplaceIds=${CONFIG.marketplaceId}&includedData=summaries`;
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
          const targetLower = cleanBrand.toLowerCase();

          const matchedItem = data.items.find(item => {
            const summary = item.summaries && item.summaries[0];
            if (!summary) return false;
            const b = (summary.brandName || summary.brand || summary.manufacturer || '').toLowerCase();
            const title = (summary.itemName || '').toLowerCase();

            if (categoryFocus === 'apparel') {
              const isTileOrHardware = /tile|flooring|ceramic|grout|hardware|automotive|tool|plumbing|wall tile|floor tile/i.test(title) || /tile|flooring|ceramic/i.test(b);
              if (isTileOrHardware) return false;
            }

            const isBrandMatch = b === targetLower || b.includes(targetLower) || targetLower.includes(b);
            return isBrandMatch;
          }) || data.items[0];

          if (matchedItem) {
            const asin = matchedItem.asin;
            const summary = matchedItem.summaries && matchedItem.summaries[0];
            const foundBrand = summary ? (summary.brandName || summary.brand || summary.manufacturer || '') : '';
            const title = summary ? (summary.itemName || '') : '';
            return {
              asin,
              verifiedBrand: foundBrand || cleanBrand,
              amazonTitle: foundBrand ? `[${foundBrand}] ${title}` : title
            };
          }
        }
      }
    } catch (e) {
      console.error('Brand catalog search error:', e.message);
    }
  }

  return null;
}

const JUNK_NAVIGATION_WORDS = [
  'home', 'brands', 'brand', 'shop all', 'view all', 'categories', 'category',
  'sort by', 'filter', 'filters', 'clear all', 'search', 'menu', 'account',
  'cart', 'checkout', 'products', 'top brands', 'featured brands', 'all brands',
  'new arrivals', 'best sellers', 'show more', 'select all', 'back to top',
  'privacy policy', 'terms of service', 'contact us', 'about us', 'help', 'faq',
  'shipping', 'returns', 'copyright', 'all rights reserved', 'cookie settings',
  'sign in', 'log in', 'my account', 'customer service', 'store locator'
];

function sanitizeBrandName(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  let clean = rawName.trim();
  if (!clean) return null;

  clean = clean.replace(/\s*\(\s*\d+\s*\)\s*$/g, '');
  clean = clean.replace(/\s*[-:|]\s*\d+\s*(items|products)?\s*$/gi, '');
  clean = clean.replace(/^[\d\s.\-•*–>#]+\s*/g, '');
  clean = clean.replace(/\s*\$\d+(\.\d+)?.*$/g, '');
  clean = clean.trim();

  if (clean.length < 2 || clean.length > 50) return null;
  if (/^\d+$/.test(clean)) return null;

  const lower = clean.toLowerCase();
  if (JUNK_NAVIGATION_WORDS.some(junk => lower === junk || lower.startsWith(junk + ' '))) {
    return null;
  }

  if (/^https?:\/\/|www\.|\.com|\.org|@/i.test(clean)) return null;

  return clean;
}

// Persistent Brand Cache
const BRAND_CACHE_FILE = path.join(__dirname, 'brand_cache.json');
let brandCache = {};
try {
  if (fs.existsSync(BRAND_CACHE_FILE)) {
    brandCache = JSON.parse(fs.readFileSync(BRAND_CACHE_FILE, 'utf8'));
  }
} catch (e) {
  brandCache = {};
}

function saveBrandCache() {
  try {
    fs.writeFileSync(BRAND_CACHE_FILE, JSON.stringify(brandCache, null, 2));
  } catch (e) {}
}

async function processSingleBrandCheck(brandName, categoryFocus, accessToken) {
  const cacheKey = `${brandName.toLowerCase()}_${categoryFocus || 'apparel'}`;
  if (brandCache[cacheKey]) {
    return { ...brandCache[cacheKey], cached: true };
  }

  const ipRisk = getIpRiskLevel(brandName);
  const match = await searchAmazonBrandCatalog(brandName, categoryFocus || 'apparel', accessToken);

  let result;
  if (match && match.asin) {
    const checkResult = await checkSingleAsinWithRetry(match.asin, accessToken);
    let overallVerdict = 'ungated';
    if (checkResult.status === 'ungated' && ipRisk.level === 'high') {
      overallVerdict = 'ungated_ip_risk';
    } else if (checkResult.status === 'ungated' && ipRisk.level === 'low') {
      overallVerdict = 'safe_ungated';
    } else if (checkResult.status === 'gated' && checkResult.hasApprovalRoute) {
      overallVerdict = 'softgated';
    } else if (checkResult.status === 'gated' && !checkResult.hasApprovalRoute) {
      overallVerdict = 'restricted';
    }

    result = {
      brand: brandName,
      verifiedBrand: match.verifiedBrand || brandName,
      matchedAsin: match.asin,
      amazonTitle: checkResult.title || match.amazonTitle || `ASIN ${match.asin}`,
      status: checkResult.status,
      hasApprovalRoute: checkResult.hasApprovalRoute,
      reasonCode: checkResult.reasonCode || '',
      ipRisk,
      overallVerdict
    };
  } else {
    result = {
      brand: brandName,
      verifiedBrand: 'Not Found on Amazon',
      matchedAsin: null,
      amazonTitle: 'No Official Brand Product Found on Amazon',
      status: 'no_match',
      hasApprovalRoute: false,
      reasonCode: 'BRAND_NOT_FOUND',
      ipRisk,
      overallVerdict: 'unknown'
    };
  }

  brandCache[cacheKey] = result;
  return result;
}

// Parallel Concurrency Worker Pool for High-Speed Brand Scanning (8 Workers in Parallel)
async function processBrandsBatchConcurrent(brands, categoryFocus, accessToken, concurrency = 8) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < brands.length) {
      const currentIndex = index++;
      const brandName = brands[currentIndex];
      const result = await processSingleBrandCheck(brandName, categoryFocus, accessToken);
      results[currentIndex] = result;
      await delay(50);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, brands.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  saveBrandCache();
  return results;
}

// Endpoint 4: High-Speed Bulk Brand Eligibility & IP Risk Profiler
app.post('/api/check-brands', async (req, res) => {
  const { brands, categoryFocus } = req.body;
  if (!brands || !Array.isArray(brands) || brands.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid "brands" array in request body' });
  }

  // Auto-Sanitize pasted web copy text
  const sanitizedBrands = [];
  const seen = new Set();
  for (let b of brands) {
    const clean = sanitizeBrandName(b);
    if (clean && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      sanitizedBrands.push(clean);
    }
  }

  if (sanitizedBrands.length === 0) {
    return res.status(400).json({ error: 'No valid brand names found after filtering out web navigation/junk text.' });
  }

  try {
    console.log(`⚡ High-Speed Scanning ${sanitizedBrands.length} brands in parallel (Focus: ${categoryFocus || 'apparel'})...`);
    const accessToken = await getAccessToken();
    const results = await processBrandsBatchConcurrent(sanitizedBrands.slice(0, 100), categoryFocus || 'apparel', accessToken, 8);

    res.json({ totalChecked: results.length, results });
  } catch (error) {
    console.error('Server error during check-brands:', error);
    res.status(500).json({ error: error.message });
  }
});

// Wholesaler Title & Attribute Extractor
function parseWholesalerAttributes(title, styleNum, upc) {
  const cleanTitle = (title || '').trim();
  const cleanStyle = (styleNum || '').trim();

  // Try extracting style number if not explicitly passed
  let style = cleanStyle;
  if (!style) {
    const styleMatch = cleanTitle.match(/\b([A-Za-z]?\d{3,5}[A-Za-z]?)\b/);
    if (styleMatch) style = styleMatch[1];
  }

  // Extract Color
  const colorMatch = cleanTitle.match(/\b(black|white|navy|red|royal|blue|grey|gray|heather|pink|green|yellow|maroon|purple|orange|charcoal|sand|ash|gold)\b/i);
  const color = colorMatch ? colorMatch[1] : '';

  // Extract Size
  const sizeMatch = cleanTitle.match(/\b(XS|S|M|L|XL|2XL|3XL|4XL|Small|Medium|Large|X-Large|2X-Large)\b/i);
  const size = sizeMatch ? sizeMatch[1] : '';

  // Extract Brand (First 1-2 words before numbers)
  let brand = '';
  const brandMatch = cleanTitle.match(/^([A-Za-z0-9'&.\s]+?)(?=\s\d|\s[A-Z]?\d|\s-|\s\(|$)/);
  if (brandMatch) {
    brand = brandMatch[1].trim();
  }

  return { cleanTitle, style, color, size, brand };
}

// Multi-Candidate Scorer for Best Amazon Listing Match
function scoreAmazonCandidate(candidate, parsedAttrs) {
  const summary = candidate.summaries && candidate.summaries[0];
  if (!summary) return 0;

  const itemTitle = (summary.itemName || '').toLowerCase();
  const itemBrand = (summary.brandName || summary.brand || summary.manufacturer || '').toLowerCase();

  let score = 30;

  // 1. Style Number Match (+35 pts)
  if (parsedAttrs.style && parsedAttrs.style.length >= 3) {
    const styleLower = parsedAttrs.style.toLowerCase();
    if (itemTitle.includes(styleLower) || itemBrand.includes(styleLower)) {
      score += 35;
    }
  }

  // 2. Brand Match (+30 pts)
  if (parsedAttrs.brand && parsedAttrs.brand.length >= 2) {
    const brandLower = parsedAttrs.brand.toLowerCase();
    if (itemBrand.includes(brandLower) || itemTitle.includes(brandLower) || brandLower.includes(itemBrand)) {
      score += 30;
    }
  }

  // 3. Color Match (+15 pts)
  if (parsedAttrs.color && itemTitle.includes(parsedAttrs.color.toLowerCase())) {
    score += 15;
  }

  // 4. Size Match (+10 pts)
  if (parsedAttrs.size && itemTitle.includes(parsedAttrs.size.toLowerCase())) {
    score += 10;
  }

  // 5. Exclude False Positives (-50 pts penalty)
  if (/tile|flooring|ceramic|grout|hardware|decal|sticker|replacement/i.test(itemTitle) && !/tile|flooring/i.test(parsedAttrs.cleanTitle)) {
    score -= 50;
  }

  return Math.min(99, Math.max(10, score));
}

// Exact Wholesaler Product to Amazon Listing Matcher
async function matchWholesalerItem(wholesalerTitle, styleNum, upc, wholesalePrice, accessToken) {
  const cleanTitle = (wholesalerTitle || '').trim();
  const cleanStyle = (styleNum || '').trim();
  const cleanUpc = (upc || '').replace(/[^\d]/g, '');

  // 0. Check if input contains a direct Amazon ASIN or Amazon URL (e.g. B0002TOZ1E or amazon.com/dp/B0002TOZ1E)
  const asinRegexMatch = (wholesalerTitle + ' ' + styleNum).match(/\b(B0[A-Z0-9]{8})\b/i);
  if (asinRegexMatch) {
    const directAsin = asinRegexMatch[1].toUpperCase();
    const checkResult = await checkSingleAsinWithRetry(directAsin, accessToken);
    return {
      wholesalerTitle: cleanTitle,
      styleNum: cleanStyle,
      upc: cleanUpc,
      wholesalePrice: wholesalePrice ? parseFloat(wholesalePrice) : null,
      asin: directAsin,
      amazonTitle: checkResult.title || `ASIN ${directAsin}`,
      status: checkResult.status,
      hasApprovalRoute: checkResult.hasApprovalRoute,
      reasonCode: checkResult.reasonCode || '',
      reasons: checkResult.reasons || [],
      confidenceScore: 100,
      allCandidates: [{ asin: directAsin, title: checkResult.title || `ASIN ${directAsin}`, score: 100 }]
    };
  }

  const parsedAttrs = parseWholesalerAttributes(cleanTitle, cleanStyle, cleanUpc);

  let bestMatch = null;
  let highestScore = 0;

  // 1. Try UPC / EAN Barcode lookup if provided (Highest Priority)
  if (cleanUpc && cleanUpc.length >= 8) {
    try {
      const upcUrl = `${CONFIG.apiBaseUrl}/catalog/2022-04-01/items?identifiers=${encodeURIComponent(cleanUpc)}&identifiersType=UPC&marketplaceIds=${CONFIG.marketplaceId}&includedData=summaries`;
      const res = await fetch(upcUrl, {
        method: 'GET',
        headers: { 'x-amz-access-token': accessToken, 'Accept': 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.items && data.items.length > 0) {
          const item = data.items[0];
          const summary = item.summaries && item.summaries[0];
          const b = summary ? (summary.brandName || summary.brand || '') : '';
          const title = summary ? (b ? `[${b}] ${summary.itemName}` : summary.itemName) : '';
          bestMatch = { asin: item.asin, title, brand: b };
          highestScore = 99; // Exact UPC Match
        }
      }
    } catch (e) {}
  }

  // 2. Try Smart Multi-Query Search if UPC did not match
  if (!bestMatch && cleanTitle) {
    const searchQueries = [];

    // Query A: Brand + Style + Color (Highly Targeted)
    if (parsedAttrs.brand && parsedAttrs.style) {
      searchQueries.push(`${parsedAttrs.brand} ${parsedAttrs.style} ${parsedAttrs.color}`.trim());
    }

    // Query B: Style + Clean Title
    if (parsedAttrs.style) {
      searchQueries.push(`${parsedAttrs.style} ${parsedAttrs.cleanTitle}`.trim());
    }

    // Query C: Clean Title Fallback
    searchQueries.push(parsedAttrs.cleanTitle);

    const candidateMap = new Map();

    for (const query of searchQueries) {
      try {
        const url = `${CONFIG.apiBaseUrl}/catalog/2022-04-01/items?keywords=${encodeURIComponent(query.slice(0, 80))}&marketplaceIds=${CONFIG.marketplaceId}&includedData=summaries`;
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'x-amz-access-token': accessToken, 'Accept': 'application/json' }
        });
        if (res.ok) {
          const data = await res.json();
          if (data.items && data.items.length > 0) {
            for (const item of data.items) {
              if (!candidateMap.has(item.asin)) {
                const score = scoreAmazonCandidate(item, parsedAttrs);
                const summary = item.summaries && item.summaries[0];
                const b = summary ? (summary.brandName || summary.brand || '') : '';
                const title = summary ? (b ? `[${b}] ${summary.itemName}` : summary.itemName) : '';
                candidateMap.set(item.asin, { asin: item.asin, title, brand: b, score });
              }
            }
          }
        }
      } catch (e) {
        console.error('Catalog query error:', e.message);
      }
    }

    const sortedCandidates = Array.from(candidateMap.values()).sort((a, b) => b.score - a.score);
    if (sortedCandidates.length > 0) {
      bestMatch = sortedCandidates[0];
      highestScore = bestMatch.score;
      parsedAttrs.allCandidates = sortedCandidates.slice(0, 4);
    }
  }

  if (bestMatch && bestMatch.asin) {
    const checkResult = await checkSingleAsinWithRetry(bestMatch.asin, accessToken);
    return {
      wholesalerTitle: cleanTitle,
      styleNum: parsedAttrs.style || cleanStyle,
      upc: cleanUpc,
      wholesalePrice: wholesalePrice ? parseFloat(wholesalePrice) : null,
      asin: bestMatch.asin,
      amazonTitle: checkResult.title || bestMatch.title || `ASIN ${bestMatch.asin}`,
      status: checkResult.status,
      hasApprovalRoute: checkResult.hasApprovalRoute,
      reasonCode: checkResult.reasonCode || '',
      reasons: checkResult.reasons || [],
      confidenceScore: highestScore,
      allCandidates: parsedAttrs.allCandidates || [{ asin: bestMatch.asin, title: bestMatch.title, score: highestScore }]
    };
  }

  return {
    wholesalerTitle: cleanTitle,
    styleNum: parsedAttrs.style || cleanStyle,
    upc: cleanUpc,
    wholesalePrice: wholesalePrice ? parseFloat(wholesalePrice) : null,
    asin: null,
    amazonTitle: 'No Exact Amazon Listing Match Found',
    status: 'no_match',
    hasApprovalRoute: false,
    reasonCode: 'PRODUCT_NOT_FOUND',
    reasons: [],
    confidenceScore: 0
  };
}

// Endpoint 5: High-Speed Parallel Wholesaler Item to Amazon Listing Matcher
app.post('/api/match-products', async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid "items" array in request body' });
  }

  try {
    console.log(`🔍 Received ${items.length} wholesaler items for Amazon listing matching...`);
    const accessToken = await getAccessToken();

    const results = [];
    let index = 0;

    async function worker() {
      while (index < items.length) {
        const currentIndex = index++;
        const raw = items[currentIndex];
        let title = '', style = '', upc = '', price = null;

        if (typeof raw === 'string') {
          const parts = raw.split(',').map(p => p.trim());
          title = parts[0] || '';
          style = parts[1] || '';
          if (parts[2]) price = parts[2].replace(/[^0-9.]/g, '');
        } else if (typeof raw === 'object') {
          title = raw.title || raw.name || '';
          style = raw.style || raw.sku || '';
          upc = raw.upc || raw.barcode || '';
          price = raw.price || raw.wholesalePrice || null;
        }

        if (!title) continue;

        const matched = await matchWholesalerItem(title, style, upc, price, accessToken);
        results[currentIndex] = matched;
        await delay(50);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(8, items.length); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
    res.json({ totalProcessed: results.length, results: results.filter(Boolean) });

  } catch (error) {
    console.error('Server error during match-products:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SP-API Backend Server running at http://localhost:${PORT}`);
  console.log(`📂 Serving Web App Dashboard...`);
});
