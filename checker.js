#!/usr/bin/env node

/**
 * Amazon Bulk Auto-Ungate Checker
 *
 * Connects to Amazon SP-API and checks listing restrictions for ASINs in bulk.
 * Uses the Listings Restrictions API (v2021-08-01) getListingsRestrictions endpoint.
 *
 * Usage:
 *   node checker.js asins.txt            # Check ASINs from a file (one per line)
 *   node checker.js keepa-export.csv     # Check ASINs from a Keepa CSV export
 *   node checker.js B08N5 B07XJ B09GK   # Check specific ASINs inline
 *
 * Results saved to: results/check-YYYY-MM-DD-HHmmss.json
 */

const fs = require('fs');
const path = require('path');

// Load .env
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ============================================================
// Configuration
// ============================================================
const CONFIG = {
  clientId:     process.env.SP_CLIENT_ID,
  clientSecret: process.env.SP_CLIENT_SECRET,
  refreshToken: process.env.SP_REFRESH_TOKEN,
  sellerId:     process.env.SELLER_ID,
  marketplaceId: process.env.MARKETPLACE_ID || 'ATVPDKIKX0DER',
  // SP-API endpoints
  tokenUrl:   'https://api.amazon.com/auth/o2/token',
  apiBaseUrl: 'https://sellingpartnerapi-na.amazon.com',
  // Rate limiting: SP-API allows ~5 requests/sec for this endpoint
  requestsPerSecond: 4,
  retryDelayMs: 2000,
  maxRetries: 3,
};

// ============================================================
// Validate config
// ============================================================
function validateConfig() {
  const missing = [];
  if (!CONFIG.clientId || CONFIG.clientId === 'your_client_id_here') missing.push('SP_CLIENT_ID');
  if (!CONFIG.clientSecret || CONFIG.clientSecret === 'your_client_secret_here') missing.push('SP_CLIENT_SECRET');
  if (!CONFIG.refreshToken || CONFIG.refreshToken === 'your_refresh_token_here') missing.push('SP_REFRESH_TOKEN');
  if (!CONFIG.sellerId || CONFIG.sellerId === 'your_seller_id_here') missing.push('SELLER_ID');

  if (missing.length > 0) {
    console.error('\n❌ Missing credentials in .env file:');
    missing.forEach(m => console.error(`   → ${m}`));
    console.error('\n📖 See SETUP.md for instructions on getting these credentials.');
    console.error('   Then copy .env.example to .env and fill in your values:\n');
    console.error('   cp .env.example .env\n');
    process.exit(1);
  }
}

// ============================================================
// Auth: Get access token from refresh token
// ============================================================
let accessToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry - 60000) {
    return accessToken;
  }

  console.log('🔑 Authenticating with Amazon SP-API...');

  const res = await fetch(CONFIG.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: CONFIG.refreshToken,
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`\n❌ Authentication failed (${res.status}):`);
    console.error(body);
    console.error('\n💡 Check your SP_CLIENT_ID, SP_CLIENT_SECRET, and SP_REFRESH_TOKEN in .env');
    process.exit(1);
  }

  const data = await res.json();
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  console.log('✅ Authenticated successfully\n');
  return accessToken;
}

// ============================================================
// SP-API: Check listing restrictions for an ASIN
// ============================================================
async function checkAsinRestrictions(asin, retryCount = 0) {
  const token = await getAccessToken();

  const params = new URLSearchParams({
    asin: asin,
    sellerId: CONFIG.sellerId,
    marketplaceIds: CONFIG.marketplaceId,
    conditionType: 'new_new',
  });

  const url = `${CONFIG.apiBaseUrl}/listings/2021-08-01/restrictions?${params}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-amz-access-token': token,
        'Content-Type': 'application/json',
      },
    });

    // Handle rate limiting
    if (res.status === 429) {
      if (retryCount < CONFIG.maxRetries) {
        const delay = CONFIG.retryDelayMs * (retryCount + 1);
        console.log(`   ⏳ Rate limited, waiting ${delay}ms...`);
        await sleep(delay);
        return checkAsinRestrictions(asin, retryCount + 1);
      }
      return { asin, status: 'error', error: 'Rate limited after retries' };
    }

    if (!res.ok) {
      const body = await res.text();
      if (retryCount < CONFIG.maxRetries) {
        await sleep(CONFIG.retryDelayMs);
        return checkAsinRestrictions(asin, retryCount + 1);
      }
      return { asin, status: 'error', error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = await res.json();

    // Parse the restrictions response
    const restrictions = data.restrictions || [];

    if (restrictions.length === 0) {
      // No restrictions = UNGATED
      return { asin, status: 'ungated', restrictions: [] };
    }

    // Check if all restrictions have approval-available routes
    const reasons = [];
    let hasApprovalRoute = false;

    for (const restriction of restrictions) {
      for (const reason of (restriction.reasons || [])) {
        reasons.push({
          reasonCode: reason.reasonCode,
          message: reason.message,
          links: (reason.links || []).map(l => ({ title: l.title, type: l.type })),
        });
        if (reason.links && reason.links.some(l => l.type === 'APPROVAL_REQUIRED')) {
          hasApprovalRoute = true;
        }
      }
    }

    return {
      asin,
      status: 'gated',
      hasApprovalRoute,
      reasons,
    };

  } catch (err) {
    if (retryCount < CONFIG.maxRetries) {
      await sleep(CONFIG.retryDelayMs);
      return checkAsinRestrictions(asin, retryCount + 1);
    }
    return { asin, status: 'error', error: err.message };
  }
}

// ============================================================
// Parse ASINs from various input formats
// ============================================================
function parseAsins(input) {
  const lines = input.split(/[\n,;\t\r]+/);
  const asins = new Set();

  for (const line of lines) {
    const trimmed = line.trim().toUpperCase();
    if (!trimmed) continue;

    // Try to extract 10-char alphanumeric ASIN
    const match = trimmed.match(/\b([A-Z0-9]{10})\b/);
    if (match) {
      asins.add(match[1]);
    }
  }

  return [...asins];
}

function loadAsinsFromArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage:');
    console.error('  node checker.js <file.txt|file.csv>    Check ASINs from a file');
    console.error('  node checker.js ASIN1 ASIN2 ASIN3     Check specific ASINs');
    console.error('');
    console.error('Examples:');
    console.error('  node checker.js asins.txt');
    console.error('  node checker.js keepa-export.csv');
    console.error('  node checker.js B08N5WRWNW B07XJ8C8F5');
    process.exit(1);
  }

  let allAsins = [];

  for (const arg of args) {
    // Check if arg is a file
    const filePath = path.resolve(arg);
    if (fs.existsSync(filePath)) {
      console.log(`📄 Reading ASINs from: ${arg}`);
      const content = fs.readFileSync(filePath, 'utf-8');
      const asins = parseAsins(content);
      console.log(`   Found ${asins.length} ASINs\n`);
      allAsins.push(...asins);
    } else if (/^[A-Z0-9]{10}$/i.test(arg.trim())) {
      allAsins.push(arg.trim().toUpperCase());
    } else {
      console.warn(`⚠️  Skipping unrecognized input: ${arg}`);
    }
  }

  // Deduplicate
  return [...new Set(allAsins)];
}

// ============================================================
// Rate-limited batch processing
// ============================================================
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processAsins(asins) {
  const results = {
    ungated: [],
    softGated: [],
    hardGated: [],
    errors: [],
    total: asins.length,
    timestamp: new Date().toISOString(),
  };

  const delayBetweenRequests = 1000 / CONFIG.requestsPerSecond;

  console.log(`🔍 Checking ${asins.length} ASINs...\n`);
  console.log('─'.repeat(60));

  for (let i = 0; i < asins.length; i++) {
    const asin = asins[i];
    const progress = `[${i + 1}/${asins.length}]`;

    const result = await checkAsinRestrictions(asin);

    if (result.status === 'ungated') {
      results.ungated.push(result);
      console.log(`${progress} ✅ ${asin}  →  UNGATED`);
    } else if (result.status === 'gated') {
      const reason = result.reasons[0]?.reasonCode || 'RESTRICTED';
      if (result.hasApprovalRoute) {
        results.softGated.push(result);
        console.log(`${progress} ⚠️  ${asin}  →  SOFT GATE (Requires Approval Button)`);
      } else {
        results.hardGated.push(result);
        console.log(`${progress} ❌ ${asin}  →  HARD GATE (${reason})`);
      }
    } else {
      results.errors.push(result);
      console.log(`${progress} 🚨 ${asin}  →  ERROR: ${result.error}`);
    }

    // Rate limiting
    if (i < asins.length - 1) {
      await sleep(delayBetweenRequests);
    }
  }

  console.log('─'.repeat(60));
  return results;
}

// ============================================================
// Save results
// ============================================================
function saveResults(results) {
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // Save full JSON
  const jsonPath = path.join(resultsDir, `check-${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  // Save ungated ASINs as simple text file
  if (results.ungated.length > 0) {
    const ungatedPath = path.join(resultsDir, `ungated-${timestamp}.txt`);
    fs.writeFileSync(ungatedPath, results.ungated.map(r => r.asin).join('\n'));
  }
  if (results.softGated.length > 0) {
    const softPath = path.join(resultsDir, `soft-gated-${timestamp}.txt`);
    fs.writeFileSync(softPath, results.softGated.map(r => r.asin).join('\n'));
  }
  if (results.hardGated.length > 0) {
    const hardPath = path.join(resultsDir, `hard-gated-${timestamp}.txt`);
    fs.writeFileSync(hardPath, results.hardGated.map(r => r.asin).join('\n'));
  }

  // Save CSV summary
  const csvPath = path.join(resultsDir, `check-${timestamp}.csv`);
  let csv = 'ASIN,Status,Reason\n';
  for (const r of results.ungated) {
    csv += `${r.asin},ungated,\n`;
  }
  for (const r of results.softGated) {
    const reason = r.reasons[0]?.reasonCode || '';
    csv += `${r.asin},soft-gated,${reason}\n`;
  }
  for (const r of results.hardGated) {
    const reason = r.reasons[0]?.reasonCode || '';
    csv += `${r.asin},hard-gated,${reason}\n`;
  }
  for (const r of results.errors) {
    csv += `${r.asin},error,"${(r.error || '').replace(/"/g, '""')}"\n`;
  }
  fs.writeFileSync(csvPath, csv);

  // Also update the web app's localStorage-compatible JSON
  const webAppPath = path.join(resultsDir, `webapp-import-${timestamp}.json`);
  const webAppData = [
    ...results.ungated.map(r => ({ asin: r.asin, status: 'ungated' })),
    ...results.softGated.map(r => ({ asin: r.asin, status: 'gated' })),
    ...results.hardGated.map(r => ({ asin: r.asin, status: 'gated' })),
  ];
  fs.writeFileSync(webAppPath, JSON.stringify(webAppData, null, 2));

  return { jsonPath, csvPath, webAppPath };
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Amazon Bulk Auto-Ungate Checker        ║');
  console.log('║   Powered by SP-API Restrictions API     ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  validateConfig();

  const asins = loadAsinsFromArgs();

  if (asins.length === 0) {
    console.error('❌ No valid ASINs found in input.');
    process.exit(1);
  }

  console.log(`📦 ${asins.length} unique ASINs to check\n`);

  // Authenticate
  await getAccessToken();

  // Process
  const startTime = Date.now();
  const results = await processAsins(asins);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   RESULTS SUMMARY                        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`   Total checked:  ${results.total}`);
  console.log(`   ✅ Ungated:     ${results.ungated.length}`);
  console.log(`   ⚠️  Soft Gate:   ${results.softGated.length}`);
  console.log(`   ❌ Hard Gate:   ${results.hardGated.length}`);
  console.log(`   🚨 Errors:      ${results.errors.length}`);
  console.log(`   ⏱️  Time:        ${elapsed}s`);

  const checked = results.ungated.length + results.softGated.length + results.hardGated.length;
  const hitRate = checked > 0 ? ((results.ungated.length / checked) * 100).toFixed(1) : 0;
  console.log(`   📊 Hit rate:    ${hitRate}%`);
  console.log('');

  // Show ungated ASINs
  if (results.ungated.length > 0) {
    console.log('🎉 UNGATED ASINs:');
    console.log('─'.repeat(40));
    results.ungated.forEach(r => {
      console.log(`   ✅ ${r.asin}  →  https://www.amazon.com/dp/${r.asin}`);
    });
    console.log('');
  }

  // Save
  const saved = saveResults(results);
  console.log('💾 Results saved:');
  console.log(`   JSON:  ${path.basename(saved.jsonPath)}`);
  console.log(`   CSV:   ${path.basename(saved.csvPath)}`);
  if (results.ungated.length > 0) {
    console.log(`   Import: ${path.basename(saved.webAppPath)} (for the web app)`);
  }
  console.log(`   📁 All in: ${path.relative(process.cwd(), path.join(__dirname, 'results'))}/`);
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
