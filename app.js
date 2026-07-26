/* =============================================
   Boxem-Style Auto-Ungate App Logic
   ============================================= */
(function () {
  'use strict';

  // DOM Elements
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // State
  let scannedResults = []; // array of { asin, title, status, hasApprovalRoute, reasons, error }
  let activeTab = 'all';
  let searchQuery = '';
  let asinTitleMap = {}; // ASIN -> Title map from file/paste

  // Persistent History (localStorage)
  const HISTORY_KEY = 'boxem_ungated_history_v1';

  // One-time deletion of previous history as explicitly requested by user
  if (!localStorage.getItem('boxem_history_deleted_user_request_v1')) {
    localStorage.removeItem(HISTORY_KEY);
    localStorage.setItem('boxem_history_deleted_user_request_v1', 'true');
  }

  function loadHistory() {
    try { 
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    } catch { return []; }
  }
  function saveHistory(history) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }
  function toggleSaveHistory(asin, title) {
    const history = loadHistory();
    const existingIndex = history.findIndex(h => h.asin === asin);

    if (existingIndex !== -1) {
      history.splice(existingIndex, 1);
      saveHistory(history);
      showToast(`Removed ${asin} from History`, 'info');
    } else {
      const itemTitle = (title && !title.startsWith('Amazon Product') && title !== '-') ? title : (asinTitleMap[asin] || `ASIN ${asin}`);
      history.unshift({
        asin,
        title: itemTitle,
        link: `https://www.amazon.com/dp/${asin}`,
        date: new Date().toLocaleDateString()
      });
      saveHistory(history);
      showToast(`Saved ${asin} to History ⭐`, 'success');
    }
    renderResults();
  }

  function clearAllHistory() {
    saveHistory([]);
    showToast('Saved History cleared!', 'info');
    renderResults();
  }

  // Helpers
  const validAsin = (a) => /^[A-Z0-9]{10}$/i.test((a || '').trim());

  function parseAsins(text) {
    const lines = text.split(/[\n\r]+/);
    const asins = [];
    const seen = new Set();

    let asinIdx = -1;
    let titleIdx = -1;
    let brandIdx = -1;

    if (lines.length > 0) {
      const headerCols = lines[0].split(/[,;\t]/).map(c => c.trim().replace(/^["']|["']$/g, '').toLowerCase());
      asinIdx = headerCols.findIndex(c => c === 'asin');
      titleIdx = headerCols.findIndex(c => c === 'title' || c === 'product name' || c === 'item name' || c === 'name');
      brandIdx = headerCols.findIndex(c => c === 'brand' || c === 'manufacturer');
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = line.split(/[,;\t]/).map(c => c.trim().replace(/^["']|["']$/g, ''));
      let asin = '';
      let title = '';
      let brand = '';

      if (asinIdx !== -1 && cols[asinIdx]) {
        const match = cols[asinIdx].match(/\b([A-Z0-9]{10})\b/i);
        if (match) asin = match[1].toUpperCase();
        if (titleIdx !== -1 && cols[titleIdx]) title = cols[titleIdx];
        if (brandIdx !== -1 && cols[brandIdx]) brand = cols[brandIdx];
      } else {
        const match = line.match(/\b([A-Z0-9]{10})\b/i);
        if (match) asin = match[1].toUpperCase();
      }

      if (validAsin(asin) && !seen.has(asin)) {
        seen.add(asin);
        asins.push(asin);
        const fullTitle = brand ? `[${brand}] ${title}` : (title || `ASIN ${asin}`);
        asinTitleMap[asin] = fullTitle;
      }
    }
    return asins;
  }

  // Textarea Live Detection
  const bulkPaste = $('#bulk-paste');
  const pasteCount = $('#paste-count');

  bulkPaste.addEventListener('input', () => {
    const asins = parseAsins(bulkPaste.value);
    pasteCount.textContent = `${asins.length} ASIN${asins.length !== 1 ? 's' : ''} detected`;
  });

  $('#btn-clear-input').addEventListener('click', () => {
    bulkPaste.value = '';
    pasteCount.textContent = '0 ASINs detected';
  });

  // Drag & Drop File Handling
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  const btnBrowse = $('#btn-browse');

  btnBrowse.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener('click', () => fileInput.click());

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length) handleFile(files[0]);
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });

  function handleFile(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      const asins = parseAsins(text);
      if (asins.length > 0) {
        bulkPaste.value = asins.join('\n');
        pasteCount.textContent = `${asins.length} ASINs loaded from ${file.name}`;
        showToast(`Loaded ${asins.length} ASINs from file`, 'success');
      } else {
        showToast('No valid ASINs found in file', 'error');
      }
    };
    reader.readAsText(file);
  }

  // Start Bulk Scan Execution (Chunked for 2,800+ ASINs)
  const btnStart = $('#btn-start-scan');
  const btnStop = $('#btn-stop-scan');
  const progressCard = $('#progress-card');
  const progressBarFill = $('#progress-bar-fill');
  const progressStatus = $('#progress-status');
  const progressCount = $('#progress-count');
  const progressEta = $('#progress-eta');

  let isScanning = false;
  let cancelScan = false;

  if (btnStop) {
    btnStop.addEventListener('click', () => {
      cancelScan = true;
      showToast('Stopping scan...', 'info');
    });
  }

  btnStart.addEventListener('click', async () => {
    const asins = parseAsins(bulkPaste.value);
    if (asins.length === 0) {
      showToast('Please enter or drop a list of ASINs first', 'error');
      return;
    }

    scannedResults = [];
    isScanning = true;
    cancelScan = false;

    progressCard.style.display = 'flex';
    progressBarFill.style.width = '0%';
    progressStatus.textContent = `Starting batch scan for ${asins.length} ASINs...`;
    progressCount.textContent = `0 / ${asins.length}`;
    progressEta.textContent = 'Est. time: --';

    const CHUNK_SIZE = 50; // 50 ASINs per batch with 6 parallel workers
    const startTime = Date.now();

    for (let i = 0; i < asins.length; i += CHUNK_SIZE) {
      if (cancelScan) {
        showToast('Scan stopped by user', 'info');
        break;
      }

      const chunk = asins.slice(i, i + CHUNK_SIZE);
      const processedCount = scannedResults.length;
      const pct = Math.round((processedCount / asins.length) * 100);

      progressBarFill.style.width = `${pct}%`;
      progressCount.textContent = `${processedCount} / ${asins.length}`;

      // Live ETA Calculation
      if (processedCount > 0) {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const ratePerSec = processedCount / elapsedSec;
        const remainingSec = Math.ceil((asins.length - processedCount) / ratePerSec);
        const mins = Math.floor(remainingSec / 60);
        const secs = remainingSec % 60;
        progressEta.textContent = `Est. time: ${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}`;
      }

      progressStatus.textContent = `Scanning batch ${Math.floor(i / CHUNK_SIZE) + 1} of ${Math.ceil(asins.length / CHUNK_SIZE)}...`;

      try {
        const res = await fetch('http://localhost:3000/api/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ asins: chunk })
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(errText);
        }

        const data = await res.json();
        const chunkResults = data.results || [];
        scannedResults.push(...chunkResults);

        // LIVE UPDATE UI: Table and counter update immediately after every batch!
        renderResults();

      } catch (err) {
        console.error('Batch error:', err);
        showToast(`Batch error: ${err.message}`, 'error');
      }
    }

    progressBarFill.style.width = '100%';
    progressCount.textContent = `${scannedResults.length} / ${asins.length}`;
    progressStatus.textContent = cancelScan ? 'Scan Stopped' : 'Scan Complete!';
    progressEta.textContent = 'Done!';

    setTimeout(() => {
      progressCard.style.display = 'none';
      renderResults();
      showToast(`Scan finished! ${scannedResults.length} ASINs processed`, 'success');
      isScanning = false;
    }, 600);
  });

  // Render Dashboard & Results Table
  function renderResults() {
    const ungated = scannedResults.filter(r => r.status === 'ungated');
    const softgated = scannedResults.filter(r => r.status === 'gated' && r.hasApprovalRoute);
    const hardgated = scannedResults.filter(r => r.status === 'gated' && !r.hasApprovalRoute || r.status === 'error');
    const historyList = loadHistory();
    const savedAsinsSet = new Set(historyList.map(h => h.asin));

    // Show or hide Clear History button based on active tab
    const btnClearHist = $('#btn-clear-history');
    if (btnClearHist) {
      btnClearHist.style.display = activeTab === 'history' ? 'inline-flex' : 'none';
    }

    // Update Stats Cards
    $('#stat-total').textContent = scannedResults.length;
    $('#stat-ungated').textContent = ungated.length;
    $('#stat-soft').textContent = softgated.length;
    $('#stat-hard').textContent = hardgated.length;

    // Update Tab Badges
    $('#badge-all').textContent = scannedResults.length;
    $('#badge-ungated').textContent = ungated.length;
    $('#badge-soft').textContent = softgated.length;
    $('#badge-hard').textContent = hardgated.length;
    $('#badge-history').textContent = historyList.length;

    // Filter Table Data based on Active Tab & Search
    let filtered = [];

    if (activeTab === 'history') {
      filtered = historyList.map(h => ({
        asin: h.asin,
        title: h.title || asinTitleMap[h.asin] || '-',
        status: 'ungated',
        date: h.date,
        isHistory: true
      }));
    } else if (activeTab === 'ungated') {
      filtered = ungated;
    } else if (activeTab === 'softgated') {
      filtered = softgated;
    } else if (activeTab === 'hardgated') {
      filtered = hardgated;
    } else {
      filtered = scannedResults;
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(r => 
        r.asin.toLowerCase().includes(q) || 
        (r.title && r.title.toLowerCase().includes(q)) ||
        (asinTitleMap[r.asin] && asinTitleMap[r.asin].toLowerCase().includes(q))
      );
    }

    const tbody = $('#table-body');
    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="5">
            <div class="empty-state">
              <div class="empty-icon">${activeTab === 'history' ? '📜' : '🔍'}</div>
              <div class="empty-title">${activeTab === 'history' ? 'No Saved Products in History' : 'No Results in This Category'}</div>
              <div class="empty-desc">${activeTab === 'history' ? 'Click the "☆ Save" button on any product during your scan to save it here!' : 'Try selecting a different tab or starting a new scan.'}</div>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered.map(item => {
      let badgeHtml = '';
      let detailsHtml = '';
      let quickLinksHtml = '';
      const rawTitle = (item.title && !item.title.startsWith('Amazon Product') && item.title !== '-') ? item.title : (asinTitleMap[item.asin] || `ASIN ${item.asin}`);
      const displayTitle = rawTitle;
      const isSaved = savedAsinsSet.has(item.asin);

      let saveBtnHtml = '';
      if (item.isHistory) {
        saveBtnHtml = `<button class="btn-save-link btn-remove-history" data-asin="${item.asin}" data-title="${displayTitle.replace(/"/g, '&quot;')}" title="Remove from History">🗑️ Remove</button>`;
      } else if (isSaved) {
        saveBtnHtml = `<button class="btn-save-link saved" data-asin="${item.asin}" data-title="${displayTitle.replace(/"/g, '&quot;')}" title="Saved to History">⭐ Saved</button>`;
      } else {
        saveBtnHtml = `<button class="btn-save-link" data-asin="${item.asin}" data-title="${displayTitle.replace(/"/g, '&quot;')}" title="Save to History">☆ Save</button>`;
      }

      if (item.isHistory) {
        badgeHtml = `<span class="badge badge-ungated">📜 SAVED HISTORY</span>`;
        detailsHtml = `<span class="text-green">Saved on ${item.date || 'Previous Scan'}</span>`;
        quickLinksHtml = `
          <div class="link-group" style="justify-content: flex-end; align-items: center; gap: 6px;">
            <a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="icon-link" title="Amazon">Amazon</a>
            <a href="https://keepa.com/#!product/1-${item.asin}" target="_blank" class="icon-link" title="Keepa">Keepa</a>
            <a href="https://sas.selleramp.com/sas/lookup?asin=${item.asin}&country=us" target="_blank" class="icon-link" title="SellerAmp">SAS</a>
            ${saveBtnHtml}
          </div>
        `;
      } else if (item.status === 'ungated') {
        badgeHtml = `<span class="badge badge-ungated">✅ AUTO UNGATED</span>`;
        detailsHtml = `<span class="text-green">Ready to List & Sell</span>`;
        quickLinksHtml = `
          <div class="link-group" style="justify-content: flex-end; align-items: center; gap: 6px;">
            <a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="icon-link" title="Amazon">Amazon</a>
            <a href="https://keepa.com/#!product/1-${item.asin}" target="_blank" class="icon-link" title="Keepa">Keepa</a>
            <a href="https://sas.selleramp.com/sas/lookup?asin=${item.asin}&country=us" target="_blank" class="icon-link" title="SellerAmp">SAS</a>
            ${saveBtnHtml}
          </div>
        `;
      } else if (item.status === 'gated' && item.hasApprovalRoute) {
        badgeHtml = `<span class="badge badge-softgated">⚠️ SOFT GATE</span>`;
        detailsHtml = `<span class="text-yellow">APPROVAL_REQUIRED</span>`;
        const ungateUrl = `https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=${item.asin}`;
        quickLinksHtml = `
          <div class="link-group" style="justify-content: flex-end; align-items: center; gap: 6px;">
            <a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="icon-link" title="Amazon">Amazon</a>
            <a href="https://keepa.com/#!product/1-${item.asin}" target="_blank" class="icon-link" title="Keepa">Keepa</a>
            <a href="${ungateUrl}" target="_blank" class="btn-ungate-link" style="margin-left: 2px;">⚡ 1-Click Ungate</a>
            ${saveBtnHtml}
          </div>
        `;
      } else {
        badgeHtml = `<span class="badge badge-hardgated">❌ RESTRICTED</span>`;
        const reason = item.reasonCode || (item.reasons && item.reasons[0] ? item.reasons[0].reasonCode : 'NOT_ELIGIBLE');
        detailsHtml = `<span class="text-red">${reason}</span>`;
        quickLinksHtml = `
          <div class="link-group" style="justify-content: flex-end; align-items: center; gap: 6px;">
            <a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="icon-link" title="Amazon">Amazon</a>
            <a href="https://keepa.com/#!product/1-${item.asin}" target="_blank" class="icon-link" title="Keepa">Keepa</a>
            <a href="https://sellercentral.amazon.com/product-search/search?q=${item.asin}" target="_blank" class="icon-link" title="Seller Central">Seller Central</a>
            ${saveBtnHtml}
          </div>
        `;
      }

      return `
        <tr>
          <td class="title-cell" title="${item.asin} - ${displayTitle.replace(/"/g, '&quot;')}">${displayTitle}</td>
          <td class="asin-cell">${item.asin}</td>
          <td>${badgeHtml}</td>
          <td>${detailsHtml}</td>
          <td style="text-align: right;">${quickLinksHtml}</td>
        </tr>
      `;
    }).join('');
  }

  // Tab Switching
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.tab;
      renderResults();
    });
  });

  // Search Filter
  $('#search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderResults();
  });

  // CSV Export (ONLY Ungated ASINs + Clickable Amazon Links)
  $('#btn-export-csv').addEventListener('click', () => {
    let ungatedList = [];

    if (activeTab === 'history') {
      ungatedList = loadHistory().map(h => ({ asin: h.asin, date: h.date }));
    } else {
      ungatedList = scannedResults.filter(r => r.status === 'ungated').map(r => ({ asin: r.asin, date: new Date().toLocaleDateString() }));
    }

    if (ungatedList.length === 0) {
      showToast('No ungated ASINs found to export', 'info');
      return;
    }

    let csv = 'ASIN,Amazon Link,Status,Date Discovered\n';
    ungatedList.forEach(item => {
      csv += `"${item.asin}","https://www.amazon.com/dp/${item.asin}","Ungated","${item.date || ''}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ungated-asins-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${ungatedList.length} Ungated ASINs with Amazon links`, 'success');
  });

  // Top-Level Tool Switcher Navigation
  $$('.nav-tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.nav-tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const targetTool = btn.dataset.tool;
      $$('.tool-view').forEach(v => {
        v.style.display = (v.id === `tool-view-${targetTool}`) ? 'flex' : 'none';
      });
    });
  });

  // Wholesaler Scraper State & Handlers
  let scraperResults = [];
  let activeScraperTab = 'scraper-all';

  // Sample URL Buttons
  $$('.sample-url-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $('#scraper-url-input').value = btn.dataset.url;
    });
  });

  // Start Scrape Action
  const btnStartScrape = $('#btn-start-scrape');
  const scraperProgressCard = $('#scraper-progress-card');
  const scraperProgressFill = $('#scraper-progress-fill');
  const scraperProgressStatus = $('#scraper-progress-status');
  const scraperProgressCount = $('#scraper-progress-count');

  // Scraper Mode Toggling (URL vs Product List)
  const modeBtnUrl = $('#mode-btn-url');
  const modeBtnList = $('#mode-btn-list');
  const scraperModeUrl = $('#scraper-mode-url');
  const scraperModeList = $('#scraper-mode-list');

  if (modeBtnUrl && modeBtnList) {
    modeBtnUrl.addEventListener('click', () => {
      modeBtnUrl.classList.add('active');
      modeBtnList.classList.remove('active');
      scraperModeUrl.style.display = 'flex';
      scraperModeList.style.display = 'none';
    });

    modeBtnList.addEventListener('click', () => {
      modeBtnList.classList.add('active');
      modeBtnUrl.classList.remove('active');
      scraperModeList.style.display = 'flex';
      scraperModeUrl.style.display = 'none';
    });
  }

  const scraperTextInput = $('#scraper-text-input');
  const scraperTextCount = $('#scraper-text-count');
  if (scraperTextInput && scraperTextCount) {
    scraperTextInput.addEventListener('input', () => {
      const text = scraperTextInput.value.trim();
      const lines = text ? text.split('\n').map(l => l.trim()).filter(Boolean) : [];
      scraperTextCount.textContent = `${lines.length} items detected`;
    });
  }

  const btnStartVerifyList = $('#btn-start-verify-list');
  if (btnStartVerifyList) {
    btnStartVerifyList.addEventListener('click', async () => {
      const text = (scraperTextInput ? scraperTextInput.value : '').trim();
      if (!text) {
        showToast('Please paste at least one product name or line', 'error');
        return;
      }

      const items = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (items.length === 0) {
        showToast('No valid product names found', 'error');
        return;
      }

      scraperProgressCard.style.display = 'flex';
      scraperProgressFill.style.width = '20%';
      scraperProgressStatus.textContent = `Matching ${items.length} supplier items on Amazon SP-API...`;
      scraperProgressCount.textContent = `0 / ${items.length} items matched`;

      let currentPct = 20;
      const interval = setInterval(() => {
        if (currentPct < 90) {
          currentPct += Math.floor(Math.random() * 5) + 2;
          scraperProgressFill.style.width = `${currentPct}%`;
        }
      }, 400);

      try {
        const res = await fetch('http://localhost:3000/api/verify-product-list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items })
        });

        clearInterval(interval);

        if (!res.ok) {
          const errText = await res.text();
          let errMsg = errText;
          try {
            const parsed = JSON.parse(errText);
            if (parsed.error) errMsg = parsed.error;
          } catch (e) {}
          throw new Error(errMsg);
        }

        const data = await res.json();
        scraperResults = data.results || [];

        scraperProgressFill.style.width = '100%';
        scraperProgressStatus.textContent = 'Verification Complete!';
        scraperProgressCount.textContent = `${scraperResults.length} items processed`;

        setTimeout(() => {
          scraperProgressCard.style.display = 'none';
          renderScraperResults();
          showToast(`Verified ${data.totalProcessed} products against Amazon!`, 'success');
        }, 600);

      } catch (err) {
        clearInterval(interval);
        console.error('Verify error:', err);
        scraperProgressCard.style.display = 'none';
        showToast(`Verification failed: ${err.message}`, 'error');
      }
    });
  }

  if (btnStartScrape) {
    btnStartScrape.addEventListener('click', async () => {
      const url = $('#scraper-url-input').value.trim();
      if (!url) {
        showToast('Please enter a wholesaler or supplier URL', 'error');
        return;
      }

      scraperProgressCard.style.display = 'flex';
      scraperProgressFill.style.width = '20%';
      scraperProgressStatus.textContent = 'Crawling wholesaler website catalog...';
      scraperProgressCount.textContent = '0 items matched';

      let currentPct = 20;
      const interval = setInterval(() => {
        if (currentPct < 90) {
          currentPct += Math.floor(Math.random() * 5) + 2;
          scraperProgressFill.style.width = `${currentPct}%`;
        }
      }, 400);

      try {
        const res = await fetch('http://localhost:3000/api/scrape-and-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });

        clearInterval(interval);

        if (!res.ok) {
          const errText = await res.text();
          let errMsg = errText;
          try {
            const parsed = JSON.parse(errText);
            if (parsed.error) errMsg = parsed.error;
          } catch(e) {}
          throw new Error(errMsg);
        }

        const data = await res.json();
        scraperResults = data.results || [];

        scraperProgressFill.style.width = '100%';
        scraperProgressStatus.textContent = 'Scrape & Cross-Verification Complete!';
        scraperProgressCount.textContent = `${scraperResults.length} items processed`;

        setTimeout(() => {
          scraperProgressCard.style.display = 'none';
          renderScraperResults();
          showToast(`Scraped ${data.totalScraped} items and verified against Amazon!`, 'success');
        }, 600);

      } catch (err) {
        clearInterval(interval);
        console.error('Scrape error:', err);
        scraperProgressCard.style.display = 'none';
        showToast(`Scrape failed: ${err.message}`, 'error');
      }
    });
  }

  // Render Scraper Results Datatable
  function renderScraperResults() {
    const ungated = scraperResults.filter(r => r.status === 'ungated');
    const softgated = scraperResults.filter(r => r.status === 'gated' && r.hasApprovalRoute);
    const hardgated = scraperResults.filter(r => r.status === 'gated' && !r.hasApprovalRoute);

    $('#scraper-stat-total').textContent = scraperResults.length;
    $('#scraper-stat-ungated').textContent = ungated.length;
    $('#scraper-stat-soft').textContent = softgated.length;
    $('#scraper-stat-hard').textContent = hardgated.length + scraperResults.filter(r => r.status === 'no_match').length;

    $('#scraper-badge-all').textContent = scraperResults.length;
    $('#scraper-badge-ungated').textContent = ungated.length;

    let filtered = [...scraperResults];
    if (activeScraperTab === 'scraper-ungated') {
      filtered = ungated;
    }

    const tbody = $('#scraper-table-body');
    if (!tbody) return;

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="5">
            <div class="empty-state">
              <div class="empty-icon">🌐</div>
              <div class="empty-title">${scraperResults.length === 0 ? 'No Wholesaler Website Scraped Yet' : 'No Ungated Matches Found'}</div>
              <div class="empty-desc">${scraperResults.length === 0 ? 'Enter a wholesaler or supplier URL above and click "Scrape & Verify Ungating".' : 'Try scanning a different catalog page or site.'}</div>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered.map(item => {
      let badgeHtml = '';
      let actionsHtml = '';
      const priceFmt = item.supplierPrice ? `$${parseFloat(item.supplierPrice).toFixed(2)}` : '-';
      const historyList = loadHistory();
      const isSaved = historyList.some(h => h.asin === item.asin);

      let saveBtnHtml = '';
      if (item.asin) {
        if (isSaved) {
          saveBtnHtml = `<button class="btn-save-link saved" data-asin="${item.asin}" data-title="${(item.amazonTitle || '').replace(/"/g, '&quot;')}" title="Saved to History">⭐ Saved</button>`;
        } else {
          saveBtnHtml = `<button class="btn-save-link" data-asin="${item.asin}" data-title="${(item.amazonTitle || '').replace(/"/g, '&quot;')}" title="Save to History">☆ Save</button>`;
        }
      }

      if (item.status === 'ungated') {
        badgeHtml = `<span class="badge badge-ungated">✅ AUTO UNGATED</span>`;
        actionsHtml = `
          <div class="link-group" style="justify-content: flex-end; align-items: center; gap: 6px;">
            <a href="${item.supplierUrl}" target="_blank" class="icon-link" title="Supplier Link">Supplier Site ↗</a>
            <a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="icon-link" title="Amazon Link">Amazon ↗</a>
            ${saveBtnHtml}
          </div>
        `;
      } else if (item.status === 'gated' && item.hasApprovalRoute) {
        badgeHtml = `<span class="badge badge-softgated">⚠️ SOFT GATE</span>`;
        const ungateUrl = `https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=${item.asin}`;
        actionsHtml = `
          <div class="link-group" style="justify-content: flex-end; align-items: center; gap: 6px;">
            <a href="${item.supplierUrl}" target="_blank" class="icon-link" title="Supplier Link">Supplier Site ↗</a>
            <a href="${ungateUrl}" target="_blank" class="btn-ungate-link">⚡ 1-Click Ungate</a>
            ${saveBtnHtml}
          </div>
        `;
      } else if (item.status === 'gated') {
        badgeHtml = `<span class="badge badge-hardgated">❌ RESTRICTED</span>`;
        actionsHtml = `
          <div class="link-group" style="justify-content: flex-end; align-items: center; gap: 6px;">
            <a href="${item.supplierUrl}" target="_blank" class="icon-link" title="Supplier Link">Supplier Site ↗</a>
            <a href="https://sellercentral.amazon.com/product-search/search?q=${item.asin}" target="_blank" class="icon-link">Seller Central</a>
            ${saveBtnHtml}
          </div>
        `;
      } else {
        badgeHtml = `<span class="badge" style="background: var(--bg-input); color: var(--text-muted); border: 1px solid var(--border-color);">❓ NO MATCH</span>`;
        actionsHtml = `
          <div class="link-group" style="justify-content: flex-end; align-items: center; gap: 6px;">
            <a href="${item.supplierUrl}" target="_blank" class="icon-link" title="Supplier Link">Supplier Site ↗</a>
          </div>
        `;
      }

      return `
        <tr>
          <td class="title-cell" title="${(item.supplierTitle || '').replace(/"/g, '&quot;')}">${item.supplierTitle || '-'}</td>
          <td style="font-weight: 700; color: var(--green); font-family: 'JetBrains Mono', monospace;">${priceFmt}</td>
          <td>
            ${item.asin ? `<div class="asin-cell">${item.asin}</div><div style="font-size: 0.8rem; color: var(--text-secondary);" class="title-cell" title="${(item.amazonTitle || '').replace(/"/g, '&quot;')}">${item.amazonTitle || ''}</div>` : '<span style="color: var(--text-muted); font-size: 0.85rem;">No Amazon ASIN Match</span>'}
          </td>
          <td>${badgeHtml}</td>
          <td style="text-align: right;">${actionsHtml}</td>
        </tr>
      `;
    }).join('');
  }

  // Scraper Tabs
  $$('.tab-btn[data-tab^="scraper-"]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn[data-tab^="scraper-"]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeScraperTab = btn.dataset.tab;
      renderScraperResults();
    });
  });

  // Export Scraped Ungated CSV
  const btnExportScraperCsv = $('#btn-export-scraper-csv');
  if (btnExportScraperCsv) {
    btnExportScraperCsv.addEventListener('click', () => {
      const ungatedList = scraperResults.filter(r => r.status === 'ungated');
      if (ungatedList.length === 0) {
        showToast('No scraped ungated matches to export', 'info');
        return;
      }

      let csv = 'Supplier Product Title,Wholesale Price,Supplier Link,Matched Amazon ASIN,Amazon Title,Amazon Link\n';
      ungatedList.forEach(item => {
        const price = item.supplierPrice ? `$${parseFloat(item.supplierPrice).toFixed(2)}` : '';
        csv += `"${(item.supplierTitle || '').replace(/"/g, '""')}","${price}","${item.supplierUrl || ''}","${item.asin || ''}","${(item.amazonTitle || '').replace(/"/g, '""')}","https://www.amazon.com/dp/${item.asin}"\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wholesaler-ungated-matches-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${ungatedList.length} Wholesaler Ungated Matches`, 'success');
    });
  }

  // Tool Switcher (Bulk Ungate Checker vs Brand Ungate & IP Risk Profiler)
  const navToolBtns = $$('.nav-tool-btn');
  const toolViews = $$('.tool-view');

  navToolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      navToolBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const tool = btn.dataset.tool;
      toolViews.forEach(v => v.style.display = 'none');

      const activeView = $(`#tool-view-${tool}`);
      if (activeView) activeView.style.display = 'block';
    });
  });

  // ===================================================
  // BRAND UNGATE & IP RISK PROFILER LOGIC
  // ===================================================
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

  function getCleanedBrandList(rawText) {
    if (!rawText) return [];
    const lines = rawText.split(/[\n,;\t\r]/);
    const cleaned = [];
    const seen = new Set();
    for (let l of lines) {
      const clean = sanitizeBrandName(l);
      if (clean && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        cleaned.push(clean);
      }
    }
    return cleaned;
  }

  let brandResults = [];
  let activeBrandTab = 'brands-all';

  const brandsInput = $('#brands-input');
  const brandsCount = $('#brands-count');
  if (brandsInput && brandsCount) {
    brandsInput.addEventListener('input', () => {
      const text = brandsInput.value.trim();
      const rawLines = text ? text.split(/[\n,;\t\r]/).filter(Boolean) : [];
      const cleanBrands = getCleanedBrandList(text);
      const filteredCount = rawLines.length - cleanBrands.length;

      if (cleanBrands.length > 0) {
        brandsCount.textContent = `✨ ${cleanBrands.length} clean brands detected${filteredCount > 0 ? ` (filtered ${filteredCount} junk lines)` : ''}`;
      } else {
        brandsCount.textContent = `0 brands detected`;
      }
    });
  }

  const btnStartBrandsScan = $('#btn-start-brands-scan');
  const brandsProgressCard = $('#brands-progress-card');
  const brandsProgressFill = $('#brands-progress-fill');
  const brandsProgressStatus = $('#brands-progress-status');
  const brandsProgressCount = $('#brands-progress-count');

  if (btnStartBrandsScan) {
    btnStartBrandsScan.addEventListener('click', async () => {
      const text = (brandsInput ? brandsInput.value : '').trim();
      if (!text) {
        showToast('Please enter or paste at least one brand name', 'error');
        return;
      }

      const brands = getCleanedBrandList(text);
      if (brands.length === 0) {
        showToast('No valid brand names found after filtering web copy junk', 'error');
        return;
      }

      brandsProgressCard.style.display = 'flex';
      brandsProgressFill.style.width = '20%';
      brandsProgressStatus.textContent = `Profiling ${brands.length} clean brands against Amazon SP-API & IP Risk database...`;
      brandsProgressCount.textContent = `0 / ${brands.length} brands`;

      let currentPct = 20;
      const interval = setInterval(() => {
        if (currentPct < 90) {
          currentPct += Math.floor(Math.random() * 5) + 2;
          brandsProgressFill.style.width = `${currentPct}%`;
        }
      }, 400);

      try {
        const categoryFocus = $('#category-focus-select') ? $('#category-focus-select').value : 'apparel';
        const res = await fetch('http://localhost:3000/api/check-brands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brands, categoryFocus })
        });

        clearInterval(interval);

        if (!res.ok) {
          const errText = await res.text();
          let errMsg = errText;
          try {
            const parsed = JSON.parse(errText);
            if (parsed.error) errMsg = parsed.error;
          } catch(e) {}
          throw new Error(errMsg);
        }

        const data = await res.json();
        brandResults = data.results || [];

        brandsProgressFill.style.width = '100%';
        brandsProgressStatus.textContent = 'Brand Profiling & IP Risk Analysis Complete!';
        brandsProgressCount.textContent = `${brandResults.length} brands processed`;

        setTimeout(() => {
          brandsProgressCard.style.display = 'none';
          renderBrandResults();
          showToast(`Profiled ${data.totalChecked} brands for ungating & IP risk!`, 'success');
        }, 600);

      } catch (err) {
        clearInterval(interval);
        console.error('Brand scan error:', err);
        brandsProgressCard.style.display = 'none';
        showToast(`Brand profiling failed: ${err.message}`, 'error');
      }
    });
  }

  function renderBrandResults() {
    const safe = brandResults.filter(r => r.overallVerdict === 'safe_ungated');
    const soft = brandResults.filter(r => r.status === 'gated' && r.hasApprovalRoute);
    const iprisk = brandResults.filter(r => r.ipRisk && r.ipRisk.level === 'high');

    if ($('#brands-stat-total')) $('#brands-stat-total').textContent = brandResults.length;
    if ($('#brands-stat-safe')) $('#brands-stat-safe').textContent = safe.length;
    if ($('#brands-stat-soft')) $('#brands-stat-soft').textContent = soft.length;
    if ($('#brands-stat-iprisk')) $('#brands-stat-iprisk').textContent = iprisk.length;

    if ($('#brands-badge-all')) $('#brands-badge-all').textContent = brandResults.length;
    if ($('#brands-badge-safe')) $('#brands-badge-safe').textContent = safe.length;
    if ($('#brands-badge-soft')) $('#brands-badge-soft').textContent = soft.length;
    if ($('#brands-badge-iprisk')) $('#brands-badge-iprisk').textContent = iprisk.length;

    let filtered = [...brandResults];
    if (activeBrandTab === 'brands-safe') filtered = safe;
    else if (activeBrandTab === 'brands-soft') filtered = soft;
    else if (activeBrandTab === 'brands-iprisk') filtered = iprisk;

    const tbody = $('#brands-table-body');
    if (!tbody) return;

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="5">
            <div class="empty-state">
              <div class="empty-icon">🏷️</div>
              <div class="empty-title">${brandResults.length === 0 ? 'No Brands Profiled Yet' : 'No Matching Brands Found'}</div>
              <div class="empty-desc">${brandResults.length === 0 ? 'Paste brand names above and click "Profile Brands & IP Risk".' : 'Try selecting a different tab filter.'}</div>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered.map(item => {
      let ungateBadgeHtml = '';
      if (item.status === 'ungated') {
        ungateBadgeHtml = `<span class="badge badge-ungated">✅ AUTO UNGATED</span>`;
      } else if (item.status === 'gated' && item.hasApprovalRoute) {
        ungateBadgeHtml = `<span class="badge badge-softgated">⚠️ APPROVAL NEEDED</span>`;
      } else if (item.status === 'gated') {
        ungateBadgeHtml = `<span class="badge badge-hardgated">❌ RESTRICTED</span>`;
      } else {
        ungateBadgeHtml = `<span class="badge" style="background: var(--bg-input); color: var(--text-muted);">❓ UNKNOWN</span>`;
      }

      let ipBadgeHtml = '';
      if (item.ipRisk.level === 'high') {
        ipBadgeHtml = `<span class="badge badge-hardgated" style="background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3);" title="${item.ipRisk.warning}">🔴 High IP Risk</span>`;
      } else if (item.ipRisk.level === 'medium') {
        ipBadgeHtml = `<span class="badge badge-softgated" title="${item.ipRisk.warning}">🟡 Moderate Risk</span>`;
      } else {
        ipBadgeHtml = `<span class="badge badge-ungated" title="${item.ipRisk.warning}">🟢 Low Risk</span>`;
      }

      let actionsHtml = '';
      if (item.matchedAsin) {
        if (item.hasApprovalRoute) {
          const ungateUrl = `https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=${item.matchedAsin}`;
          actionsHtml = `<a href="${ungateUrl}" target="_blank" class="btn-ungate-link">⚡ Apply Ungate</a>`;
        } else {
          actionsHtml = `<a href="https://www.amazon.com/dp/${item.matchedAsin}" target="_blank" class="icon-link">Amazon ↗</a>`;
        }
      }

      const verifiedTag = (item.verifiedBrand && item.verifiedBrand !== 'Not Found on Amazon')
        ? `<div style="font-size: 0.78rem; font-weight: 500; color: var(--green); margin-top: 2px;">Verified Amazon Brand: ${item.verifiedBrand}</div>`
        : `<div style="font-size: 0.78rem; font-weight: 500; color: var(--text-muted); margin-top: 2px;">${item.verifiedBrand || 'No Brand Match'}</div>`;

      return `
        <tr>
          <td style="font-weight: 700; font-size: 0.95rem; color: var(--text-primary);">
            <div>${item.brand}</div>
            ${verifiedTag}
          </td>
          <td>${ungateBadgeHtml}</td>
          <td>
            ${ipBadgeHtml}
            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">${item.ipRisk.warning}</div>
          </td>
          <td>
            ${item.matchedAsin ? `<div class="asin-cell">${item.matchedAsin}</div><div style="font-size: 0.8rem; color: var(--text-secondary);" class="title-cell">${item.amazonTitle}</div>` : '<span style="color: var(--text-muted); font-size: 0.85rem;">No Official Brand ASIN Match</span>'}
          </td>
          <td style="text-align: right;">${actionsHtml}</td>
        </tr>
      `;
    }).join('');
  }

  // Brand Tabs
  $$('.tab-btn[data-tab^="brands-"]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn[data-tab^="brands-"]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeBrandTab = btn.dataset.tab;
      renderBrandResults();
    });
  });

  // ===================================================
  // TOOL 3: WHOLESALER ITEM MATCHER & VERIFIER LOGIC
  // ===================================================
  let matcherResults = [];
  let activeMatcherTab = 'matcher-all';

  const modeSingleBtn = $('#matcher-mode-btn-single');
  const modeBulkBtn = $('#matcher-mode-btn-bulk');
  const modeSingleDiv = $('#matcher-mode-single');
  const modeBulkDiv = $('#matcher-mode-bulk');

  if (modeSingleBtn && modeBulkBtn && modeSingleDiv && modeBulkDiv) {
    modeSingleBtn.addEventListener('click', () => {
      modeSingleBtn.classList.add('active');
      modeBulkBtn.classList.remove('active');
      modeSingleDiv.style.display = 'block';
      modeBulkDiv.style.display = 'none';
    });
    modeBulkBtn.addEventListener('click', () => {
      modeBulkBtn.classList.add('active');
      modeSingleBtn.classList.remove('active');
      modeBulkDiv.style.display = 'block';
      modeSingleDiv.style.display = 'none';
    });
  }

  const matcherTextInput = $('#matcher-text-input');
  const matcherTextCount = $('#matcher-text-count');
  if (matcherTextInput && matcherTextCount) {
    matcherTextInput.addEventListener('input', () => {
      const text = matcherTextInput.value.trim();
      const lines = text ? text.split('\n').map(l => l.trim()).filter(Boolean) : [];
      matcherTextCount.textContent = `${lines.length} items detected`;
    });
  }

  const btnMatcherSingle = $('#btn-start-matcher-single');
  const btnMatcherBulk = $('#btn-start-matcher-bulk');
  const matcherProgressCard = $('#matcher-progress-card');
  const matcherProgressFill = $('#matcher-progress-fill');
  const matcherProgressStatus = $('#matcher-progress-status');
  const matcherProgressCount = $('#matcher-progress-count');

  async function executeMatcherCheck(itemsPayload) {
    matcherProgressCard.style.display = 'flex';
    matcherProgressFill.style.width = '20%';
    matcherProgressStatus.textContent = `Matching ${itemsPayload.length} items against Amazon Catalog...`;
    matcherProgressCount.textContent = `0 / ${itemsPayload.length} items`;

    let currentPct = 20;
    const interval = setInterval(() => {
      if (currentPct < 90) {
        currentPct += Math.floor(Math.random() * 5) + 2;
        matcherProgressFill.style.width = `${currentPct}%`;
      }
    }, 300);

    try {
      const res = await fetch('http://localhost:3000/api/match-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: itemsPayload })
      });

      clearInterval(interval);
      matcherProgressFill.style.width = '100%';

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Matching failed');
      }

      const data = await res.json();
      matcherResults = data.results || [];
      renderMatcherResults();
      showToast(`Successfully matched ${matcherResults.length} items!`, 'success');
      setTimeout(() => { matcherProgressCard.style.display = 'none'; }, 800);

    } catch (e) {
      clearInterval(interval);
      matcherProgressCard.style.display = 'none';
      showToast(`Matcher Error: ${e.message}`, 'error');
    }
  }

  if (btnMatcherSingle) {
    btnMatcherSingle.addEventListener('click', () => {
      const title = ($('#matcher-single-title') ? $('#matcher-single-title').value : '').trim();
      const style = ($('#matcher-single-style') ? $('#matcher-single-style').value : '').trim();
      const price = ($('#matcher-single-price') ? $('#matcher-single-price').value : '').trim();

      if (!title) {
        showToast('Please enter a Wholesaler Item Title / Description', 'error');
        return;
      }

      executeMatcherCheck([{ title, style, wholesalePrice: price }]);
    });
  }

  if (btnMatcherBulk) {
    btnMatcherBulk.addEventListener('click', () => {
      const text = (matcherTextInput ? matcherTextInput.value : '').trim();
      if (!text) {
        showToast('Please paste wholesaler catalog lines or CSV', 'error');
        return;
      }

      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) {
        showToast('No valid item lines found', 'error');
        return;
      }

      executeMatcherCheck(lines);
    });
  }

  function renderMatcherResults() {
    const total = matcherResults.length;
    const ungated = matcherResults.filter(r => r.status === 'ungated').length;
    const soft = matcherResults.filter(r => r.status === 'gated' && r.hasApprovalRoute).length;
    const hard = matcherResults.filter(r => r.status === 'gated' && !r.hasApprovalRoute || r.status === 'no_match').length;

    if ($('#matcher-stat-total')) $('#matcher-stat-total').textContent = total;
    if ($('#matcher-stat-ungated')) $('#matcher-stat-ungated').textContent = ungated;
    if ($('#matcher-stat-soft')) $('#matcher-stat-soft').textContent = soft;
    if ($('#matcher-stat-hard')) $('#matcher-stat-hard').textContent = hard;

    if ($('#matcher-badge-all')) $('#matcher-badge-all').textContent = total;
    if ($('#matcher-badge-ungated')) $('#matcher-badge-ungated').textContent = ungated;
    if ($('#matcher-badge-soft')) $('#matcher-badge-soft').textContent = soft;

    let filtered = matcherResults;
    if (activeMatcherTab === 'matcher-ungated') {
      filtered = matcherResults.filter(r => r.status === 'ungated');
    } else if (activeMatcherTab === 'matcher-soft') {
      filtered = matcherResults.filter(r => r.status === 'gated' && r.hasApprovalRoute);
    }

    const tbody = $('#matcher-table-body');
    if (!tbody) return;

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">
            <div class="empty-state">
              <div class="empty-icon">🔍</div>
              <div class="empty-title">${matcherResults.length === 0 ? 'No Items Matched Yet' : 'No Matching Items Found'}</div>
              <div class="empty-desc">${matcherResults.length === 0 ? 'Search a single item or paste catalog lines above.' : 'Try selecting a different tab filter.'}</div>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered.map(item => {
      let ungateBadgeHtml = '';
      if (item.status === 'ungated') {
        ungateBadgeHtml = `<span class="badge badge-ungated">✅ AUTO UNGATED</span>`;
      } else if (item.status === 'gated' && item.hasApprovalRoute) {
        ungateBadgeHtml = `<span class="badge badge-softgated">⚠️ APPROVAL NEEDED</span>`;
      } else if (item.status === 'gated') {
        ungateBadgeHtml = `<span class="badge badge-hardgated">❌ RESTRICTED</span>`;
      } else {
        ungateBadgeHtml = `<span class="badge" style="background: var(--bg-input); color: var(--text-muted);">❓ UNKNOWN</span>`;
      }

      let confBadgeHtml = '';
      if (item.confidenceScore >= 80) {
        confBadgeHtml = `<span class="badge badge-ungated" style="font-weight: 700;">🔥 ${item.confidenceScore}% Match</span>`;
      } else if (item.confidenceScore >= 50) {
        confBadgeHtml = `<span class="badge badge-softgated" style="font-weight: 700;">⚡ ${item.confidenceScore}% Match</span>`;
      } else {
        confBadgeHtml = `<span class="badge" style="background: var(--bg-input); color: var(--text-muted);">❓ Low Confidence</span>`;
      }

      let actionsHtml = '';
      if (item.asin) {
        if (item.hasApprovalRoute) {
          const ungateUrl = `https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=${item.asin}`;
          actionsHtml = `<a href="${ungateUrl}" target="_blank" class="btn-ungate-link">⚡ Apply Ungate</a>`;
        } else {
          actionsHtml = `<a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="icon-link">Amazon ↗</a>`;
        }
      }

      const candidateBadges = (item.allCandidates && item.allCandidates.length > 1) ? `
        <div style="margin-top: 6px; font-size: 0.75rem; color: var(--text-muted);">
          Alternative Amazon Matches:
          <div style="display: flex; gap: 4px; flex-wrap: wrap; margin-top: 2px;">
            ${item.allCandidates.map(c => `
              <a href="https://www.amazon.com/dp/${c.asin}" target="_blank" class="badge" style="font-size: 0.7rem; cursor: pointer; text-decoration: none; background: var(--bg-card); border: 1px solid var(--border-color); color: var(--text-primary);" title="${(c.title || '').replace(/"/g, '')}">
                ${c.asin} (${c.score}%) ↗
              </a>
            `).join('')}
          </div>
        </div>
      ` : '';

      return `
        <tr>
          <td style="font-weight: 700; font-size: 0.9rem; color: var(--text-primary);">
            <div>${item.wholesalerTitle}</div>
            ${item.styleNum ? `<div style="font-size: 0.78rem; font-weight: 500; color: var(--text-muted); margin-top: 2px;">Style/SKU: ${item.styleNum}</div>` : ''}
          </td>
          <td style="font-family: 'JetBrains Mono', monospace; font-weight: 700; color: var(--green);">
            ${item.wholesalePrice ? `$${item.wholesalePrice.toFixed(2)}` : '<span style="color: var(--text-muted); font-size: 0.85rem;">N/A</span>'}
          </td>
          <td>
            ${item.asin ? `<div class="asin-cell">${item.asin}</div><div style="font-size: 0.8rem; color: var(--text-secondary);" class="title-cell">${item.amazonTitle}</div>${candidateBadges}` : '<span style="color: var(--text-muted); font-size: 0.85rem;">No ASIN match found</span>'}
          </td>
          <td>${confBadgeHtml}</td>
          <td>${ungateBadgeHtml}</td>
          <td style="text-align: right;">${actionsHtml}</td>
        </tr>
      `;
    }).join('');
  }

  // Matcher Tabs
  $$('.tab-btn[data-tab^="matcher-"]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn[data-tab^="matcher-"]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeMatcherTab = btn.dataset.tab;
      renderMatcherResults();
    });
  });

  // Export Matcher CSV
  const btnExportMatcherCsv = $('#btn-export-matcher-csv');
  if (btnExportMatcherCsv) {
    btnExportMatcherCsv.addEventListener('click', () => {
      const ungatedItems = matcherResults.filter(r => r.status === 'ungated' && r.asin);
      if (ungatedItems.length === 0) {
        showToast('No matched ungated items to export', 'error');
        return;
      }

      let csv = 'Wholesaler Title,Style SKU,Wholesale Price,Amazon ASIN,Amazon Listing Title,Confidence Score,Status\n';
      ungatedItems.forEach(item => {
        const title = `"${(item.wholesalerTitle || '').replace(/"/g, '""')}"`;
        const azTitle = `"${(item.amazonTitle || '').replace(/"/g, '""')}"`;
        csv += `${title},"${item.styleNum || ''}",${item.wholesalePrice || ''},${item.asin},${azTitle},${item.confidenceScore}%,${item.status}\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Matched_Ungated_Wholesale_Items_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${ungatedItems.length} matched ungated items to CSV`, 'success');
    });
  }

  // Export Safe Brands CSV
  const btnExportBrandsCsv = $('#btn-export-brands-csv');
  if (btnExportBrandsCsv) {
    btnExportBrandsCsv.addEventListener('click', () => {
      const safeList = brandResults.filter(r => r.overallVerdict === 'safe_ungated' || r.status === 'ungated');
      if (safeList.length === 0) {
        showToast('No safe ungated brands to export', 'info');
        return;
      }

      let csv = 'Brand Name,Ungating Status,IP Risk Profile,Matched ASIN,Sample Product Title\n';
      safeList.forEach(item => {
        csv += `"${item.brand}","${item.status}","${item.ipRisk.label}","${item.matchedAsin || ''}","${(item.amazonTitle || '').replace(/"/g, '""')}"\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `safe-ungated-brands-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${safeList.length} Safe Ungated Brands`, 'success');
    });
  }

  // Clear History Button
  const btnClearHist = $('#btn-clear-history');
  if (btnClearHist) {
    btnClearHist.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear your saved history?')) {
        clearAllHistory();
      }
    });
  }

  // Toast System
  function showToast(msg, type = 'info') {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
    toast.innerHTML = `<span>${icon}</span> <span>${msg}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.2s ease';
      setTimeout(() => toast.remove(), 200);
    }, 3000);
  }

  // Initial render
  renderResults();
  renderBrandResults();
})();
