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

  if (bulkPaste) {
    bulkPaste.addEventListener('input', () => {
      const asins = parseAsins(bulkPaste.value);
      pasteCount.textContent = `${asins.length} ASIN${asins.length !== 1 ? 's' : ''} detected`;
    });
  }

  const btnClearInput = $('#btn-clear-input');
  if (btnClearInput) {
    btnClearInput.addEventListener('click', () => {
      bulkPaste.value = '';
      pasteCount.textContent = '0 ASINs detected';
    });
  }

  // Drag & Drop File Handling
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  const btnBrowse = $('#btn-browse');

  if (btnBrowse) {
    btnBrowse.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
  }

  if (dropzone) {
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
  }

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length) handleFile(e.target.files[0]);
    });
  }

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

  if (btnStart) {
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
          const res = await fetch('/api/check', {
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
  }

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
    const elTotal = $('#stat-total');
    if (elTotal) elTotal.textContent = scannedResults.length;
    const elUngated = $('#stat-ungated');
    if (elUngated) elUngated.textContent = ungated.length;
    const elSoft = $('#stat-soft');
    if (elSoft) elSoft.textContent = softgated.length;
    const elHard = $('#stat-hard');
    if (elHard) elHard.textContent = hardgated.length;

    // Update Tab Badges
    const bAll = $('#badge-all');
    if (bAll) bAll.textContent = scannedResults.length;
    const bUngated = $('#badge-ungated');
    if (bUngated) bUngated.textContent = ungated.length;
    const bSoft = $('#badge-soft');
    if (bSoft) bSoft.textContent = softgated.length;
    const bHard = $('#badge-hard');
    if (bHard) bHard.textContent = hardgated.length;
    const bHist = $('#badge-history');
    if (bHist) bHist.textContent = historyList.length;

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
    if (!tbody) return;

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
  const elSearch = $('#search-input');
  if (elSearch) {
    elSearch.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      renderResults();
    });
  }

  // CSV Export (ONLY Ungated ASINs + Clickable Amazon Links)
  const elExport = $('#btn-export-csv');
  if (elExport) {
    elExport.addEventListener('click', () => {
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
  }

  // Save / Remove event listeners for table buttons
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-save-link');
    if (!btn) return;
    e.preventDefault();
    const asin = btn.dataset.asin;
    const title = btn.dataset.title;
    toggleSaveHistory(asin, title);
  });

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
    if (!container) return;
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
})();
