#!/usr/bin/env node
/**
 * Diagnostic: Test SP-API Catalog Items identifier lookup
 * Tests a known UPC against every identifier type to find what works
 */
require('dotenv').config();

const CONFIG = {
  clientId: process.env.SP_CLIENT_ID,
  clientSecret: process.env.SP_CLIENT_SECRET,
  refreshToken: process.env.SP_REFRESH_TOKEN,
  marketplaceId: process.env.MARKETPLACE_ID || 'ATVPDKIKX0DER',
  tokenUrl: 'https://api.amazon.com/auth/o2/token',
  apiBaseUrl: 'https://sellingpartnerapi-na.amazon.com',
};

async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: CONFIG.refreshToken,
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
  });
  const res = await fetch(CONFIG.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Auth failed: ${res.status} - ${err}`);
  }
  const data = await res.json();
  return data.access_token;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function tryLookup(accessToken, identifier, identifierType, label) {
  const url = `${CONFIG.apiBaseUrl}/catalog/2022-04-01/items?identifiers=${encodeURIComponent(identifier)}&identifiersType=${identifierType}&marketplaceIds=${CONFIG.marketplaceId}&includedData=summaries`;
  
  console.log(`\n--- [${label}] identifiersType=${identifierType}  value=${identifier} ---`);
  console.log(`    URL: ${url}`);
  
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-amz-access-token': accessToken,
        'Accept': 'application/json',
      },
    });

    const status = res.status;
    const body = await res.text();
    
    console.log(`    HTTP ${status}`);
    
    if (status === 200) {
      const data = JSON.parse(body);
      const count = (data.items || []).length;
      console.log(`    Items found: ${count}`);
      if (count > 0) {
        for (const item of data.items) {
          const summary = item.summaries && item.summaries[0];
          console.log(`    ✅ MATCH! ASIN=${item.asin}  Title="${summary?.itemName || 'N/A'}"  Brand="${summary?.brandName || 'N/A'}"`);
        }
        return true;
      } else {
        console.log(`    ❌ No items returned`);
      }
    } else {
      console.log(`    ❌ Error response: ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`    ❌ Exception: ${e.message}`);
  }
  return false;
}

async function tryKeywordSearch(accessToken, keywords, label) {
  const cleanKw = keywords.replace(/[^\w\s]/gi, '').slice(0, 60).trim();
  const url = `${CONFIG.apiBaseUrl}/catalog/2022-04-01/items?keywords=${encodeURIComponent(cleanKw)}&marketplaceIds=${CONFIG.marketplaceId}&includedData=summaries`;
  
  console.log(`\n--- [${label}] KEYWORD SEARCH: "${cleanKw}" ---`);
  
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-amz-access-token': accessToken,
        'Accept': 'application/json',
      },
    });

    const status = res.status;
    const body = await res.text();
    
    console.log(`    HTTP ${status}`);
    
    if (status === 200) {
      const data = JSON.parse(body);
      const count = (data.items || []).length;
      console.log(`    Items found: ${count}`);
      if (count > 0) {
        const item = data.items[0];
        const summary = item.summaries && item.summaries[0];
        console.log(`    ✅ TOP MATCH: ASIN=${item.asin}  Title="${summary?.itemName || 'N/A'}"  Brand="${summary?.brandName || 'N/A'}"`);
        return true;
      } else {
        console.log(`    ❌ No items returned`);
      }
    } else {
      console.log(`    ❌ Error: ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`    ❌ Exception: ${e.message}`);
  }
  return false;
}

async function main() {
  console.log('=== SP-API UPC/EAN/GTIN Diagnostic Test ===\n');
  
  const token = await getAccessToken();
  console.log('✅ Authenticated successfully\n');

  // Test UPCs: products we KNOW are on Amazon
  const testCases = [
    { upc: '049056102016', title: 'JR Liggetts Bar Shampoo Original 3.5 oz', expectedAsin: 'B00016X68Q' },
    { upc: '079565006215', title: 'Ancient Secrets Nasal Cleansing Salt 8 oz', expectedAsin: 'B001E0WE5E' },
    { upc: '727616171169', title: 'Aztec Secret Indian Healing Bentonite Clay 1 lb', expectedAsin: 'B00028O646' },
    { upc: '018787785058', title: 'Dr Bronners Pure Castile Peppermint Soap 5 oz', expectedAsin: 'B000HK1652' },
    { upc: '9327693006883', title: 'Sukin Signature Hair Care Hydrating Shampoo 16.9 oz', expectedAsin: 'B00A0J00E0' },
  ];

  for (const tc of testCases) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`TESTING: ${tc.title}`);
    console.log(`UPC: ${tc.upc}  |  Expected ASIN: ${tc.expectedAsin}`);
    console.log('='.repeat(70));

    let found = false;

    // Test 1: Raw UPC as "UPC" type
    found = await tryLookup(token, tc.upc, 'UPC', 'Raw UPC');
    await delay(300);

    // Test 2: Zero-padded to 14 digits as "GTIN" type
    const gtin14 = tc.upc.padStart(14, '0');
    found = found || await tryLookup(token, gtin14, 'GTIN', 'GTIN-14 padded');
    await delay(300);

    // Test 3: As "EAN" type
    if (tc.upc.length === 13) {
      found = found || await tryLookup(token, tc.upc, 'EAN', 'EAN-13');
      await delay(300);
    } else if (tc.upc.length === 12) {
      const ean13 = '0' + tc.upc;
      found = found || await tryLookup(token, ean13, 'EAN', 'EAN-13 (0-prefixed)');
      await delay(300);
    }

    // Test 4: Direct ASIN lookup (to prove the product exists)
    console.log(`\n--- [Direct ASIN check] ---`);
    try {
      const url = `${CONFIG.apiBaseUrl}/catalog/2022-04-01/items/${tc.expectedAsin}?marketplaceIds=${CONFIG.marketplaceId}&includedData=summaries,identifiers`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'x-amz-access-token': token, 'Accept': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        const summary = data.summaries && data.summaries[0];
        console.log(`    ✅ ASIN ${tc.expectedAsin} EXISTS: "${summary?.itemName || 'N/A'}"`);
        
        // Show what identifiers Amazon has stored for this ASIN
        if (data.identifiers) {
          console.log(`    Stored identifiers:`);
          for (const group of data.identifiers) {
            for (const ident of (group.identifiers || [])) {
              console.log(`      - ${ident.identifierType}: ${ident.identifier}`);
            }
          }
        }
      } else {
        const body = await res.text();
        console.log(`    ❌ ASIN lookup failed: HTTP ${res.status} - ${body.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`    ❌ ASIN lookup error: ${e.message}`);
    }
    await delay(300);

    // Test 5: Keyword/Title fallback
    if (!found) {
      await tryKeywordSearch(token, tc.title, 'Title Fallback');
      await delay(300);
    }

    console.log('');
  }

  console.log('\n=== DIAGNOSTIC COMPLETE ===');
}

main().catch(e => console.error('Fatal:', e));
