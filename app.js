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

  // UPC Converter State & Helper
  let converterResults = [];
  let activeConverterTab = 'converter-all';
  let converterSearchQuery = '';

  function parseUpcs(text) {
    const matches = text.match(/\b\d{12,14}\b/g) || [];
    const seen = new Set();
    const upcs = [];
    for (const m of matches) {
      if (!seen.has(m)) {
        seen.add(m);
        upcs.push(m);
      }
    }
    return upcs;
  }

  // UPC Input Handlers & Conversion Loop
  const upcPaste = $('#upc-paste');
  const upcPasteCount = $('#upc-paste-count');
  if (upcPaste) {
    upcPaste.addEventListener('input', () => {
      const upcs = parseUpcs(upcPaste.value);
      upcPasteCount.textContent = `${upcs.length} Barcodes detected`;
    });
  }

  const btnClearUpc = $('#btn-clear-upc-input');
  if (btnClearUpc) {
    btnClearUpc.addEventListener('click', () => {
      upcPaste.value = '';
      upcPasteCount.textContent = '0 Barcodes detected';
    });
  }

  const dropzoneUpc = $('#dropzone-upc');
  const fileInputUpc = $('#file-input-upc');
  const btnBrowseUpc = $('#btn-browse-upc');

  if (btnBrowseUpc) {
    btnBrowseUpc.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInputUpc.click();
    });
  }

  if (dropzoneUpc) {
    dropzoneUpc.addEventListener('click', () => fileInputUpc.click());

    ['dragenter', 'dragover'].forEach(evt => {
      dropzoneUpc.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzoneUpc.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach(evt => {
      dropzoneUpc.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzoneUpc.classList.remove('drag-over');
      });
    });

    dropzoneUpc.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (dt.files.length) handleUpcFile(dt.files[0]);
    });
  }

  if (fileInputUpc) {
    fileInputUpc.addEventListener('change', (e) => {
      if (e.target.files.length) handleUpcFile(e.target.files[0]);
    });
  }

  function handleUpcFile(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const upcs = parseUpcs(ev.target.result);
      if (upcs.length > 0) {
        upcPaste.value = upcs.join('\n');
        upcPasteCount.textContent = `${upcs.length} Barcodes loaded from ${file.name}`;
        showToast(`Loaded ${upcs.length} barcodes from file`, 'success');
      } else {
        showToast('No valid 12-14 digit UPCs found in file', 'error');
      }
    };
    reader.readAsText(file);
  }

  // Start UPC to ASIN Conversion
  const btnStartConvert = $('#btn-start-convert');
  const converterProgressCard = $('#converter-progress-card');
  const converterProgressFill = $('#converter-progress-fill');
  const converterProgressStatus = $('#converter-progress-status');
  const converterProgressCount = $('#converter-progress-count');

  if (btnStartConvert) {
    btnStartConvert.addEventListener('click', async () => {
      const upcs = parseUpcs(upcPaste.value);
      if (upcs.length === 0) {
        showToast('Please enter or drop a list of UPCs first', 'error');
        return;
      }

      converterResults = [];
      converterProgressCard.style.display = 'flex';
      converterProgressFill.style.width = '0%';
      converterProgressStatus.textContent = `Querying Amazon SP-API for ${upcs.length} barcodes...`;
      converterProgressCount.textContent = `0 / ${upcs.length}`;

      const CHUNK_SIZE = 50;
      for (let i = 0; i < upcs.length; i += CHUNK_SIZE) {
        const chunk = upcs.slice(i, i + CHUNK_SIZE);
        const pct = Math.round((converterResults.length / upcs.length) * 100);
        converterProgressFill.style.width = `${pct}%`;
        converterProgressCount.textContent = `${converterResults.length} / ${upcs.length}`;

        try {
          const res = await fetch('/api/convert-upc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ upcs: chunk })
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText);
          }

          const data = await res.json();
          const chunkResults = data.results || [];
          converterResults.push(...chunkResults);
          renderConverterResults();

        } catch (err) {
          console.error('UPC conversion error:', err);
          showToast(`Conversion error: ${err.message}`, 'error');
        }
      }

      converterProgressFill.style.width = '100%';
      converterProgressCount.textContent = `${converterResults.length} / ${upcs.length}`;
      converterProgressStatus.textContent = 'Conversion Complete!';

      setTimeout(() => {
        converterProgressCard.style.display = 'none';
        renderConverterResults();
        showToast(`Converted ${converterResults.filter(r => r.asin).length} of ${upcs.length} barcodes into ASINs!`, 'success');
      }, 600);
    });
  }

  // Render Converter Results Datatable
  function renderConverterResults() {
    const converted = converterResults.filter(r => r.asin);
    const ungated = converterResults.filter(r => r.status === 'ungated');
    const softgated = converterResults.filter(r => r.status === 'gated' && r.hasApprovalRoute);
    const hardgated = converterResults.filter(r => r.status === 'gated' && !r.hasApprovalRoute);

    const cTotal = $('#converter-stat-total');
    if (cTotal) cTotal.textContent = converterResults.length;
    const cAsins = $('#converter-stat-asins');
    if (cAsins) cAsins.textContent = converted.length;
    const cUngated = $('#converter-stat-ungated');
    if (cUngated) cUngated.textContent = ungated.length;
    const cSoft = $('#converter-stat-soft');
    if (cSoft) cSoft.textContent = softgated.length;

    const bAll = $('#converter-badge-all');
    if (bAll) bAll.textContent = converterResults.length;
    const bUngated = $('#converter-badge-ungated');
    if (bUngated) bUngated.textContent = ungated.length;

    let filtered = [...converterResults];
    if (activeConverterTab === 'converter-ungated') {
      filtered = ungated;
    }

    if (converterSearchQuery) {
      const q = converterSearchQuery.toLowerCase();
      filtered = filtered.filter(r => 
        r.upc.toLowerCase().includes(q) || 
        (r.asin && r.asin.toLowerCase().includes(q)) || 
        (r.title && r.title.toLowerCase().includes(q))
      );
    }

    const tbody = $('#converter-table-body');
    if (!tbody) return;

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="5">
            <div class="empty-state">
              <div class="empty-icon">🏷️</div>
              <div class="empty-title">${converterResults.length === 0 ? 'No UPCs Converted Yet' : 'No Converted Results in This Category'}</div>
              <div class="empty-desc">${converterResults.length === 0 ? 'Paste barcodes above or drop a wholesale CSV file to convert to ASINs.' : 'Try clearing your search or selecting a different tab.'}</div>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    const historyList = loadHistory();
    const savedSet = new Set(historyList.map(h => h.asin));

    tbody.innerHTML = filtered.map(item => {
      let badgeHtml = '';
      let quickLinksHtml = '';

      if (item.asin) {
        const isSaved = savedSet.has(item.asin);
        const saveBtnHtml = isSaved ? 
          `<button class="btn-save-link saved" data-asin="${item.asin}" data-title="${(item.title || '').replace(/"/g, '&quot;')}" title="Saved to History">⭐ Saved</button>` : 
          `<button class="btn-save-link" data-asin="${item.asin}" data-title="${(item.title || '').replace(/"/g, '&quot;')}" title="Save to History">☆ Save</button>`;

        if (item.status === 'ungated') {
          badgeHtml = `<span class="badge badge-ungated">✅ AUTO UNGATED</span>`;
          quickLinksHtml = `
            <div class="link-group" style="justify-content: flex-end; align-items: center; gap: 6px;">
              <a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="icon-link">Amazon ↗</a>
              <a href="https://keepa.com/#!product/1-${item.asin}" target="_blank" class="icon-link">Keepa</a>
              <a href="https://sas.selleramp.com/sas/lookup?asin=${item.asin}&country=us" target="_blank" class="icon-link">SAS</a>
              ${saveBtnHtml}
            </div>
          `;
        } else if (item.status === 'gated' && item.hasApprovalRoute) {
          badgeHtml = `<span class="badge badge-softgated">⚠️ SOFT GATE</span>`;
          const ungateUrl = `https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=${item.asin}`;
          quickLinksHtml = `
            <div class="link-group" style="justify-content: flex-end; align-items: center; gap: 6px;">
              <a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="icon-link">Amazon ↗</a>
              <a href="${ungateUrl}" target="_blank" class="btn-ungate-link">⚡ 1-Click Ungate</a>
              ${saveBtnHtml}
            </div>
          `;
        } else {
          badgeHtml = `<span class="badge badge-hardgated">❌ RESTRICTED</span>`;
          quickLinksHtml = `
            <div class="link-group" style="justify-content: flex-end; align-items: center; gap: 6px;">
              <a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="icon-link">Amazon ↗</a>
              <a href="https://sellercentral.amazon.com/product-search/search?q=${item.asin}" target="_blank" class="icon-link">Seller Central</a>
              ${saveBtnHtml}
            </div>
          `;
        }
      } else {
        badgeHtml = `<span class="badge" style="background: var(--bg-input); color: var(--text-muted); border: 1px solid var(--border-color);">❓ NO MATCH</span>`;
        quickLinksHtml = `<span style="color: var(--text-muted); font-size: 0.8rem;">-</span>`;
      }

      return `
        <tr>
          <td class="asin-cell" style="color: var(--text-primary); font-size: 0.88rem;">${item.upc}</td>
          <td class="asin-cell">${item.asin || '-'}</td>
          <td class="title-cell" title="${(item.title || '').replace(/"/g, '&quot;')}">${item.title || '-'}</td>
          <td>${badgeHtml}</td>
          <td style="text-align: right;">${quickLinksHtml}</td>
        </tr>
      `;
    }).join('');
  }

  // Converter Tabs
  $$('.tab-btn[data-tab^="converter-"]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn[data-tab^="converter-"]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeConverterTab = btn.dataset.tab;
      renderConverterResults();
    });
  });

  // Converter Search Filter
  const elConverterSearch = $('#converter-search-input');
  if (elConverterSearch) {
    elConverterSearch.addEventListener('input', (e) => {
      converterSearchQuery = e.target.value.trim();
      renderConverterResults();
    });
  }

  // Converter CSV Export
  const btnExportConverterCsv = $('#btn-export-converter-csv');
  if (btnExportConverterCsv) {
    btnExportConverterCsv.addEventListener('click', () => {
      const converted = converterResults.filter(r => r.asin);
      if (converted.length === 0) {
        showToast('No converted ASINs to export', 'info');
        return;
      }

      let csv = 'Input UPC,Matched ASIN,Product Title,Ungating Status,Amazon Link\n';
      converted.forEach(item => {
        csv += `"${item.upc}","${item.asin}","${(item.title || '').replace(/"/g, '""')}","${item.status}","https://www.amazon.com/dp/${item.asin}"\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `converted-upc-asins-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${converted.length} converted UPC-to-ASIN records`, 'success');
    });
  }

  // Wholesale Feasibility State & Handlers
  let currentFeasibilityData = null;

  // Sample Brand Chips
  $$('.sample-brand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const brand = btn.dataset.brand;
      $('#feasibility-input').value = brand;
      runFeasibilityAnalysis(brand);
    });
  });

  const btnCheckFeasibility = $('#btn-check-feasibility');
  if (btnCheckFeasibility) {
    btnCheckFeasibility.addEventListener('click', () => {
      const val = $('#feasibility-input').value.trim();
      if (!val) {
        showToast('Please enter an ASIN, barcode, or brand name first', 'error');
        return;
      }
      runFeasibilityAnalysis(val);
    });
  }

  // Load saved Gemini API Key
  const elApiKey = $('#gemini-api-key-input');
  if (elApiKey) {
    elApiKey.value = localStorage.getItem('gemini_api_key_v1') || '';
    elApiKey.addEventListener('input', () => {
      localStorage.setItem('gemini_api_key_v1', elApiKey.value.trim());
    });
  }

  async function runFeasibilityAnalysis(inputVal) {
    const apiKey = elApiKey ? elApiKey.value.trim() : '';
    showToast(`Analyzing feasibility for "${inputVal}"...`, 'info');
    try {
      const res = await fetch('/api/check-feasibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: inputVal, apiKey })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText);
      }

      const data = await res.json();
      currentFeasibilityData = data;
      renderFeasibilityUI(data);
      if (data.isAiPowered) {
        showToast(`🤖 Live AI LLM reasoning complete for ${data.brandName}!`, 'success');
      } else {
        showToast(`Feasibility analysis complete for ${data.brandName}!`, 'success');
      }

    } catch (err) {
      console.error('Feasibility error:', err);
      showToast(`Feasibility error: ${err.message}`, 'error');
    }
  }

  function renderFeasibilityUI(data) {
    const resultsSec = $('#feasibility-results');
    if (resultsSec) resultsSec.style.display = 'flex';

    // Render Matched Product & Brand Bar
    const elProdTitle = $('#matched-product-title');
    const elProdMeta = $('#matched-product-meta');
    const elAmzLink = $('#matched-amazon-link');

    if (elProdTitle) elProdTitle.textContent = data.productTitle || data.brandName;
    if (elProdMeta) elProdMeta.textContent = `Brand: ${data.brandName}${data.asin ? ` | ASIN: ${data.asin}` : ''}`;
    
    if (elAmzLink) {
      if (data.asin) {
        elAmzLink.href = `https://www.amazon.com/dp/${data.asin}`;
        elAmzLink.style.display = 'inline-flex';
      } else {
        elAmzLink.style.display = 'none';
      }
    }

    // 1. Populate 3 Separate Reseller Check Cards
    if (data.checks) {
      // Check 1: Ungating Status
      const uVal = $('#check-ungating-val');
      const uSub = $('#check-ungating-sub');
      if (uVal) {
        uVal.innerHTML = data.checks.ungating.isGreen ? `<span>✅</span> <span>${data.checks.ungating.status}</span>` : `<span>❌</span> <span>${data.checks.ungating.status}</span>`;
        uVal.style.color = data.checks.ungating.isGreen ? 'var(--green)' : 'var(--red)';
      }
      if (uSub) uSub.textContent = data.checks.ungating.desc;

      // Check 2: Brand Reseller & IP Policy
      const pVal = $('#check-policy-val');
      const pSub = $('#check-policy-sub');
      if (pVal) {
        pVal.innerHTML = data.checks.brandPolicy.isGreen ? `<span>✅</span> <span>${data.checks.brandPolicy.status}</span>` : `<span>❌</span> <span>${data.checks.brandPolicy.status}</span>`;
        pVal.style.color = data.checks.brandPolicy.isGreen ? 'var(--green)' : 'var(--red)';
      }
      if (pSub) pSub.textContent = data.checks.brandPolicy.desc;

      // Check 3: Valid Ungating Invoice
      const iVal = $('#check-invoice-val');
      const iSub = $('#check-invoice-sub');
      if (iVal) {
        iVal.innerHTML = data.checks.invoice.isGreen ? `<span>✅</span> <span>${data.checks.invoice.status}</span>` : `<span>❌</span> <span>${data.checks.invoice.status}</span>`;
        iVal.style.color = data.checks.invoice.isGreen ? 'var(--green)' : 'var(--red)';
      }
      if (iSub) iSub.textContent = data.checks.invoice.desc;
    }

    // 2. Single Overall Verdict Summary Banner (YES / NO)
    const banner = $('#feasibility-status-banner');
    const title = $('#feasibility-status-title');
    const desc = $('#feasibility-status-desc');

    if (data.overallDoable) {
      if (banner) banner.style.border = '1px solid var(--green)';
      if (title) {
        title.textContent = '✅ YES - DOABLE WHOLESALE PRODUCT';
        title.style.color = 'var(--green)';
      }
      if (desc) desc.textContent = data.overallReason;
    } else {
      if (banner) banner.style.border = '1px solid var(--red)';
      if (title) {
        title.textContent = '❌ NO - NOT DOABLE ON AMAZON';
        title.style.color = 'var(--red)';
      }
      if (desc) desc.textContent = data.overallReason;
    }

    // 3. Sleek, Minimalist Cut-Down Authorized Distributors & 1-Click Outreach List
    const elDistBadge = $('#distributors-count-badge');
    const elDistGrid = $('#distributors-full-grid');

    const count = data.distributors ? data.distributors.length : 0;
    if (elDistBadge) elDistBadge.textContent = `${count} Supplier${count === 1 ? '' : 's'}`;

    if (count > 0 && elDistGrid) {
      elDistGrid.innerHTML = data.distributors.map(d => `
        <div style="padding: 10px 14px; border-radius: var(--radius-sm); background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
          <div style="font-weight: 700; font-size: 0.88rem; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
            <span>🏢 ${d.name}</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <a href="${d.url}" target="_blank" class="btn btn-secondary btn-sm" style="font-size: 0.78rem; padding: 4px 10px;">Website ↗</a>
            <button class="btn btn-primary btn-sm btn-pitch-distributor" data-email="${d.email}" style="font-size: 0.78rem; padding: 4px 10px; background: linear-gradient(135deg, var(--green), #16a34a);">⚡ Pitch Sales</button>
          </div>
        </div>
      `).join('');

      // Add event listeners for Pitch Sales Team buttons
      elDistGrid.querySelectorAll('.btn-pitch-distributor').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const targetEmail = e.target.dataset.email;
          const selectRecip = $('#b2b-recipient-select');
          if (selectRecip) selectRecip.value = targetEmail;
          updateB2bPitchText();
          const emailCard = $('#b2b-email-card');
          if (emailCard) {
            emailCard.scrollIntoView({ behavior: 'smooth' });
            showToast(`Pre-filled pitch for ${targetEmail}!`, 'success');
          }
        });
      });
    } else if (elDistGrid) {
      elDistGrid.innerHTML = `<div style="color: var(--text-muted); font-size: 0.84rem; padding: 8px; text-align: center;">No 3rd party wholesale distributors permitted for this brand.</div>`;
    }

    // 3. Automated 1-Click B2B Wholesale Application Email Sender Box
    const emailCard = $('#b2b-email-card');
    if (data.distributors && data.distributors.length > 0) {
      if (emailCard) emailCard.style.display = 'block';

      // Populate recipient select
      const selectRecip = $('#b2b-recipient-select');
      if (selectRecip) {
        selectRecip.innerHTML = data.distributors.map(d => 
          `<option value="${d.email}">${d.name} (${d.email})</option>`
        ).join('');
      }

      updateB2bPitchText();
    } else if (emailCard) {
      emailCard.style.display = 'none';
    }
  }

  function updateB2bPitchText() {
    if (!currentFeasibilityData) return;
    const company = $('#b2b-company-name').value.trim() || '[Company Name]';
    const ein = $('#b2b-ein').value.trim() || '[Tax ID / EIN]';
    const contact = $('#b2b-contact-name').value.trim() || '[Your Name]';
    const brand = currentFeasibilityData.brandName;

    const pitch = `Hello Sales & Purchasing Team,

My name is ${contact} representing ${company} (Tax ID / EIN: ${ein}).

We are an established commercial retail & e-commerce distributor actively expanding our B2B wholesale catalog. We are looking to open a direct wholesale reseller account with your team to purchase itemized inventory for ${brand} products.

Key Details of Our Business:
- Business Entity: ${company}
- EIN / Resell State Tax ID: ${ein}
- Payment Terms: Pre-payment via Credit Card / ACH wire
- Estimated Initial Order Value: $2,500 - $10,000+

Could you please forward the new wholesale customer application form or put us in touch with a sales account representative? We are ready to submit our credit application and tax documentation immediately.

Thank you,
${contact}
${company}`;

    $('#b2b-pitch-textarea').value = pitch;
  }

  ['#b2b-company-name', '#b2b-ein', '#b2b-contact-name'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('input', updateB2bPitchText);
  });

  // Action: 1-Click Send Email
  const btnSendEmail = $('#btn-send-email');
  if (btnSendEmail) {
    btnSendEmail.addEventListener('click', () => {
      const recipient = $('#b2b-recipient-select').value;
      const brand = currentFeasibilityData ? currentFeasibilityData.brandName : 'Wholesale Catalog';
      const company = $('#b2b-company-name').value.trim();
      const subject = encodeURIComponent(`B2B Wholesale Account Application - ${company} (${brand})`);
      const body = encodeURIComponent($('#b2b-pitch-textarea').value);

      window.location.href = `mailto:${recipient}?subject=${subject}&body=${body}`;
      showToast('Opened your email client with pre-filled pitch!', 'success');
    });
  }

  // Action: Copy Pitch
  const btnCopyPitch = $('#btn-copy-pitch');
  if (btnCopyPitch) {
    btnCopyPitch.addEventListener('click', () => {
      const pitchText = $('#b2b-pitch-textarea').value;
      navigator.clipboard.writeText(pitchText);
      showToast('B2B Wholesale Pitch copied to clipboard!', 'success');
    });
  }

  // Action: Copy Matched Product Name
  const btnCopyProdTitle = $('#btn-copy-product-title');
  if (btnCopyProdTitle) {
    btnCopyProdTitle.addEventListener('click', () => {
      const title = $('#matched-product-title').textContent;
      if (title && title !== '-') {
        navigator.clipboard.writeText(title);
        showToast('Product Name copied to clipboard!', 'success');
      }
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
    renderConverterResults();
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
  renderConverterResults();
})();
