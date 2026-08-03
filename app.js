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
  try {
    if (!localStorage.getItem('boxem_history_deleted_user_request_v1')) {
      localStorage.removeItem(HISTORY_KEY);
      localStorage.setItem('boxem_history_deleted_user_request_v1', 'true');
    }
  } catch (e) {
    console.warn('localStorage is not available:', e);
  }

  function loadHistory() {
    try { 
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    } catch { return []; }
  }
  function saveHistory(history) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {}
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

  function detectDelimiter(line) {
    if (!line) return ',';
    const commas = (line.match(/,/g) || []).length;
    const tabs = (line.match(/\t/g) || []).length;
    const semicolons = (line.match(/;/g) || []).length;
    if (tabs > commas && tabs > semicolons) return '\t';
    if (semicolons > commas && semicolons > tabs) return ';';
    return ',';
  }

  function splitCsvLine(line, delimiter = ',') {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  }

  // Helpers
  const validAsin = (a) => /^[A-Z0-9]{10}$/i.test((a || '').trim());
  const validUpc = (u) => /^\d{8,14}$/.test((u || '').trim());

  function parseAsins(text) {
    const lines = text.split(/[\n\r]+/);
    const items = [];
    const seen = new Set();

    let asinIdx = -1;
    let upcIdx = -1;
    let titleIdx = -1;
    let brandIdx = -1;

    let delimiter = ',';
    if (lines.length > 0) {
      delimiter = detectDelimiter(lines[0]);
      const headerCols = splitCsvLine(lines[0], delimiter).map(c => c.trim().replace(/^["']|["']$/g, '').toLowerCase());
      asinIdx = headerCols.findIndex(c => c === 'asin');
      upcIdx = headerCols.findIndex(c => c === 'upc' || c === 'ean' || c === 'gtin' || c === 'barcode');
      titleIdx = headerCols.findIndex(c => c === 'title' || c === 'product name' || c === 'item name' || c === 'name');
      brandIdx = headerCols.findIndex(c => c === 'brand' || c === 'manufacturer');
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = splitCsvLine(line, delimiter).map(c => c.trim().replace(/^["']|["']$/g, ''));
      let asin = '';
      let upc = '';
      let title = '';
      let brand = '';

      if (asinIdx !== -1 && cols[asinIdx]) {
        const match = cols[asinIdx].match(/\b([A-Z0-9]{10})\b/i);
        if (match) asin = match[1].toUpperCase();
      }
      if (upcIdx !== -1 && cols[upcIdx]) {
        const clean = cols[upcIdx].replace(/\D/g, '');
        if (validUpc(clean)) upc = clean;
      }
      if (titleIdx !== -1 && cols[titleIdx]) title = cols[titleIdx];
      if (brandIdx !== -1 && cols[brandIdx]) brand = cols[brandIdx];

      if (!asin && !upc) {
        const trimmedLine = line.trim();
        // If the line is purely digits (8-14 chars), it's a barcode — never try ASIN regex
        if (/^\d{8,14}$/.test(trimmedLine)) {
          upc = trimmedLine;
        } else {
          // Only try ASIN regex on lines that contain at least one letter
          const asinMatch = trimmedLine.match(/\b([A-Z][A-Z0-9]{9}|[A-Z0-9]{9}[A-Z]|B[A-Z0-9]{9})\b/i);
          if (asinMatch && /[A-Za-z]/.test(asinMatch[1])) {
            asin = asinMatch[1].toUpperCase();
          } else {
            // Last resort: try to extract a barcode from mixed content
            const digitsMatch = trimmedLine.match(/\b(\d{8,14})\b/);
            if (digitsMatch) {
              upc = digitsMatch[1];
            }
          }
        }
      }

      if (asin && validAsin(asin) && !seen.has(asin)) {
        seen.add(asin);
        const fullTitle = brand ? `[${brand}] ${title}` : (title || `ASIN ${asin}`);
        asinTitleMap[asin] = fullTitle;
        items.push({ type: 'asin', value: asin, title: fullTitle, brand });
      } else if (upc && validUpc(upc) && !seen.has(upc)) {
        seen.add(upc);
        const fullTitle = brand ? `[${brand}] ${title}` : title;
        items.push({ type: 'upc', value: upc, upc, title: fullTitle, brand });
      }
    }
    return items;
  }

  // Textarea Live Detection
  const bulkPaste = $('#bulk-paste');
  const pasteCount = $('#paste-count');

  if (bulkPaste) {
    bulkPaste.addEventListener('input', () => {
      const items = parseAsins(bulkPaste.value);
      pasteCount.textContent = `${items.length} item${items.length !== 1 ? 's' : ''} detected`;
    });
  }

  const btnClearInput = $('#btn-clear-input');
  if (btnClearInput) {
    btnClearInput.addEventListener('click', () => {
      bulkPaste.value = '';
      pasteCount.textContent = '0 items detected';
    });
  }

  // Drag & Drop File Handling
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  const btnBrowse = $('#btn-browse');

  if (btnBrowse) {
    btnBrowse.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput && fileInput.click();
    });
  }

  if (dropzone) {
    dropzone.addEventListener('click', (e) => {
      if (e.target.closest('#btn-browse')) return;
      fileInput && fileInput.click();
    });

    dropzone.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragover',  (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('drag-over'); });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('drag-over');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) handleFile(files[0]);
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length) handleFile(e.target.files[0]);
      e.target.value = '';
    });
  }

  function handleFile(file) {
    readAnyFile(file, (text) => {
      const items = parseAsins(text);
      if (items.length > 0) {
        bulkPaste.value = items.map(it => it.upc || it.value).join('\n');
        pasteCount.textContent = `${items.length} items loaded from ${file.name}`;
        showToast(`Loaded ${items.length} items from ${file.name}`, 'success');
      } else {
        showToast('No valid ASINs or UPCs found in file', 'error');
      }
    });
  }

  // Universal File Reader (supports .xlsx, .xls, .ods, .csv, .txt)
  function readAnyFile(file, callback) {
    if (!file) return callback('');
    const ext = (file.name || '').split('.').pop().toLowerCase();
    const isExcel = ['xlsx', 'xls', 'ods', 'xlsb'].includes(ext);

    if (isExcel && typeof XLSX !== 'undefined') {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array', cellDates: false, raw: true });
          let textParts = [];
          workbook.SheetNames.forEach(sheetName => {
            const sheet = workbook.Sheets[sheetName];
            if (sheet) {
              textParts.push(XLSX.utils.sheet_to_csv(sheet));
            }
          });
          callback(textParts.join('\n'));
        } catch (err) {
          console.error('SheetJS parse error, falling back to text read:', err);
          fallbackTextRead(file, callback);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      fallbackTextRead(file, callback);
    }
  }

  function fallbackTextRead(file, callback) {
    const reader = new FileReader();
    reader.onload = (e) => callback(e.target.result || '');
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
      const items = parseAsins(bulkPaste.value);
      if (items.length === 0) {
        showToast('Please enter or drop a list of ASINs or UPCs first', 'error');
        return;
      }

      scannedResults = [];
      isScanning = true;
      cancelScan = false;

      progressCard.style.display = 'flex';
      progressBarFill.style.width = '0%';
      progressStatus.textContent = `Starting batch scan for ${items.length} items...`;
      progressCount.textContent = `0 / ${items.length}`;
      progressEta.textContent = 'Est. time: --';

      const CHUNK_SIZE = 50;
      const startTime = Date.now();

      for (let i = 0; i < items.length; i += CHUNK_SIZE) {
        if (cancelScan) {
          showToast('Scan stopped by user', 'info');
          break;
        }

        const chunk = items.slice(i, i + CHUNK_SIZE);
        const asinsChunk = chunk.filter(it => it.type === 'asin').map(it => it.value);
        const upcsChunk = chunk.filter(it => it.type === 'upc').map(it => ({ upc: it.value, title: it.title }));

        const processedCount = scannedResults.length;
        const pct = Math.round((processedCount / items.length) * 100);

        progressBarFill.style.width = `${pct}%`;
        progressCount.textContent = `${processedCount} / ${items.length}`;

        if (processedCount > 0) {
          const elapsedSec = (Date.now() - startTime) / 1000;
          const ratePerSec = processedCount / elapsedSec;
          const remainingSec = Math.ceil((items.length - processedCount) / ratePerSec);
          const mins = Math.floor(remainingSec / 60);
          const secs = remainingSec % 60;
          progressEta.textContent = `Est. time: ${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}`;
        }

        progressStatus.textContent = `Scanning batch ${Math.floor(i / CHUNK_SIZE) + 1} of ${Math.ceil(items.length / CHUNK_SIZE)}...`;

        try {
          if (asinsChunk.length > 0) {
            const res = await fetch('/api/check', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ asins: asinsChunk })
            });
            if (res.ok) {
              const data = await res.json();
              scannedResults.push(...(data.results || []));
            }
          }

          if (upcsChunk.length > 0) {
            const res = await fetch('/api/convert-upc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ upcs: upcsChunk })
            });
            if (res.ok) {
              const data = await res.json();
              scannedResults.push(...(data.results || []));
            }
          }

          renderResults();
        } catch (err) {
          console.error('Batch error:', err);
          showToast(`Batch error: ${err.message}`, 'error');
        }
      }

      progressBarFill.style.width = '100%';
      progressCount.textContent = `${scannedResults.length} / ${items.length}`;
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
        saveBtnHtml = `<button class="a-save btn-remove-history" data-asin="${item.asin}" data-title="${displayTitle.replace(/"/g, '&quot;')}" title="Remove from History">🗑 Remove</button>`;
      } else if (isSaved) {
        saveBtnHtml = `<button class="a-save saved" data-asin="${item.asin}" data-title="${displayTitle.replace(/"/g, '&quot;')}" title="Saved to History">⭐ Saved</button>`;
      } else {
        saveBtnHtml = `<button class="a-save" data-asin="${item.asin}" data-title="${displayTitle.replace(/"/g, '&quot;')}" title="Save to History">☆ Save</button>`;
      }

      if (item.isHistory) {
        badgeHtml = `<span class="badge badge-ungated">📜 HISTORY</span>`;
        detailsHtml = `<span class="t-green">Saved ${item.date || 'Previous Scan'}</span>`;
        quickLinksHtml = `
          <div class="action-cluster">
            <a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="a-link">Amazon</a>
            <a href="https://keepa.com/#!product/1-${item.asin}" target="_blank" class="a-link">Keepa</a>
            <a href="https://sas.selleramp.com/sas/lookup?asin=${item.asin}&country=us" target="_blank" class="a-link">SAS</a>
            ${saveBtnHtml}
          </div>
        `;
      } else if (item.status === 'ungated') {
        badgeHtml = `<span class="badge badge-ungated">✅ UNGATED</span>`;
        detailsHtml = `<span class="t-green">Ready to Sell</span>`;
        quickLinksHtml = `
          <div class="action-cluster">
            <a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="a-link">Amazon</a>
            <a href="https://keepa.com/#!product/1-${item.asin}" target="_blank" class="a-link">Keepa</a>
            <a href="https://sas.selleramp.com/sas/lookup?asin=${item.asin}&country=us" target="_blank" class="a-link">SAS</a>
            ${saveBtnHtml}
          </div>
        `;
      } else if (item.status === 'gated' && item.hasApprovalRoute) {
        badgeHtml = `<span class="badge badge-softgated">⚠️ APPROVAL</span>`;
        detailsHtml = `<span class="t-amber">Invoice Required</span>`;
        const ungateUrl = `https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=${item.asin}`;
        quickLinksHtml = `
          <div class="action-cluster">
            <a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="a-link">Amazon</a>
            <a href="https://keepa.com/#!product/1-${item.asin}" target="_blank" class="a-link">Keepa</a>
            <a href="${ungateUrl}" target="_blank" class="a-ungate">⚡ 1-Click Ungate</a>
            ${saveBtnHtml}
          </div>
        `;
      } else {
        badgeHtml = `<span class="badge badge-hardgated">❌ RESTRICTED</span>`;
        const reason = item.reasonCode || (item.reasons && item.reasons[0] ? item.reasons[0].reasonCode : 'NOT_ELIGIBLE');
        detailsHtml = `<span class="t-red">${reason}</span>`;
        quickLinksHtml = `
          <div class="action-cluster">
            <a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="a-link">Amazon</a>
            <a href="https://keepa.com/#!product/1-${item.asin}" target="_blank" class="a-link">Keepa</a>
            <a href="https://sellercentral.amazon.com/product-search/search?q=${item.asin}" target="_blank" class="a-link">Seller Central</a>
            ${saveBtnHtml}
          </div>
        `;
      }

      return `
        <tr>
          <td class="cell-title" title="${item.asin} - ${displayTitle.replace(/"/g, '&quot;')}">${displayTitle}</td>
          <td class="cell-asin">${item.asin}</td>
          <td>${badgeHtml}</td>
          <td>${detailsHtml}</td>
          <td style="text-align:right">${quickLinksHtml}</td>
        </tr>
      `;
    }).join('');
  }

  // Tab Switching (filter buttons)
  $$('.f-btn:not([data-tab^="converter-"])').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.f-btn:not([data-tab^="converter-"])').forEach(b => b.classList.remove('active'));
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

  // Top Nav Tab Switcher
  $$('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.nav-tab').forEach(b => b.classList.remove('active'));
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
    if (!text) return [];
    const seen = new Set();
    const upcs = [];

    // First, try to detect CSV with headers containing both a barcode column AND a title column
    const lines = text.split(/[\n\r]+/).filter(l => l.trim());
    if (lines.length > 1) {
      const firstLine = lines[0].toLowerCase().trim();
      const possibleHeaders = splitCsvLine(firstLine, detectDelimiter(firstLine)).map(c => c.trim().replace(/^["']|["']$/g, '').toLowerCase());

      const upcColIdx = possibleHeaders.findIndex(c => ['upc', 'ean', 'gtin', 'barcode', 'code', 'item_upc', 'upc_code'].includes(c));
      const titleColIdx = possibleHeaders.findIndex(c => ['title', 'name', 'product', 'product name', 'product_name', 'description', 'item', 'item name', 'item_name', 'product title', 'product_title'].includes(c));
      const costColIdx = possibleHeaders.findIndex(c => ['cost', 'wholesale', 'wholesale price', 'wholesaler price', 'wsp', 'unit cost', 'price', 'unit_cost', 'cost_price', 'our price', 'our_price', 'whl price', 'wholesale_price'].includes(c));

      if (upcColIdx !== -1) {
        // CSV mode: we have a header row with a UPC column
        const delimiter = detectDelimiter(firstLine);
        for (let i = 1; i < lines.length; i++) {
          const cols = splitCsvLine(lines[i], delimiter).map(c => c.trim().replace(/^["']|["']$/g, ''));
          let rawUpc = (cols[upcColIdx] || '').trim();

          // Handle Excel scientific notation
          if (/(\d[\d.]*)[Ee]([+\-]?\d+)/.test(rawUpc)) {
            try {
              const val = Math.round(Number(rawUpc));
              if (isFinite(val)) rawUpc = val.toString();
            } catch (e) {}
          }

          rawUpc = rawUpc.replace(/[\-\s]/g, '');
          if (!/^\d{8,14}$/.test(rawUpc)) continue;
          if (seen.has(rawUpc)) continue;
          seen.add(rawUpc);

          const title = titleColIdx !== -1 ? (cols[titleColIdx] || '').trim() : '';
          let cost = null;
          if (costColIdx !== -1) {
            const rawCost = (cols[costColIdx] || '').trim().replace(/[^0-9.]/g, '');
            const parsedCost = parseFloat(rawCost);
            if (!isNaN(parsedCost) && parsedCost > 0) cost = parsedCost;
          }

          if (title || cost !== null) {
            upcs.push({ upc: rawUpc, title, cost });
          } else {
            upcs.push(rawUpc);
          }
        }
        return upcs;
      }
    }

    // Fallback: plain text mode (one UPC per line, no headers)
    function addCode(c) {
      if (!c) return;
      let str = String(c).trim().replace(/^["']|["']$/g, '');
      if (!str) return;

      // Check if it's an ASIN (B0 followed by 8 chars, or a 10-char ISBN starting with numbers)
      if (/^B0[A-Z0-9]{8}$/i.test(str) || /^[0-9]{9}[X0-9]$/i.test(str)) {
        str = str.toUpperCase();
        if (!seen.has(str)) { seen.add(str); upcs.push(str); }
        return;
      }

      if (/(\d[\d.]*)[Ee]([+\-]?\d+)/.test(str)) {
        try {
          const val = Math.round(Number(str));
          if (isFinite(val)) str = val.toString();
        } catch (e) {}
      }

      str = str.replace(/[\-\s]/g, '');

      if (/^\d{8,14}$/.test(str)) {
        // IMPORTANT: Do NOT strip leading zeros! UPC-A is always 12 digits,
        // EAN-13 is always 13 digits. Stripping zeros makes them invalid
        // and Amazon's API will reject them (e.g. 049056102016 -> 49056102016 = broken).
        // Only deduplicate by the full original barcode string.
        if (!seen.has(str)) { seen.add(str); upcs.push(str); }
      }
    }

    // Comprehensive global scan on the entire text
    const cleanedText = text.replace(/(\d[\d.]*)[Ee]([+\-]?\d+)/g, (match) => {
      try {
        const val = Math.round(Number(match));
        if (isFinite(val)) addCode(val.toString());
      } catch (e) {}
      return ' ';
    });
    
    // Extract ASINs first (10 chars, starting with B0 or standard ISBNs)
    const asinMatches = text.match(/\b(?:B0[A-Z0-9]{8}|[0-9]{9}[X0-9])\b/gi) || [];
    for (const a of asinMatches) addCode(a);

    const dashedMatches = cleanedText.match(/\b\d{1,4}(?:[\-\s]\d{1,6})+\b/g) || [];
    for (const d of dashedMatches) addCode(d.replace(/[\-\s]/g, ''));

    const matches = cleanedText.match(/\b\d{8,14}\b/g) || [];
    for (const m of matches) addCode(m);

    // Also catch 11-digit numbers (Excel-stripped UPCs missing leading zero) — re-pad them
    const m11 = cleanedText.match(/\b\d{11}\b/g) || [];
    for (const m of m11) addCode('0' + m); // Re-add the stripped leading zero to make valid 12-digit UPC

    return upcs;
  }


  // UPC Input Handlers & Conversion Loop
  const upcPaste = $('#upc-paste');
  const upcPasteCount = $('#upc-paste-count');
  if (upcPaste) {
    upcPaste.addEventListener('input', () => {
      if (typeof converterMode !== 'undefined' && converterMode === 'asin-to-upc') {
        const asins = parseAsins(upcPaste.value);
        upcPasteCount.textContent = `${asins.length} ASIN${asins.length !== 1 ? 's' : ''} detected`;
      } else {
        const upcs = parseUpcs(upcPaste.value);
        upcPasteCount.textContent = `${upcs.length} Barcodes detected`;
      }
    });
  }

  const btnClearUpc = $('#btn-clear-upc-input');
  if (btnClearUpc) {
    btnClearUpc.addEventListener('click', () => {
      upcPaste.value = '';
      if (typeof converterMode !== 'undefined' && converterMode === 'asin-to-upc') {
        upcPasteCount.textContent = '0 ASINs detected';
      } else {
        upcPasteCount.textContent = '0 Barcodes detected';
      }
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
    // Click anywhere on the zone to open file picker (but not if clicking the Browse button itself)
    dropzoneUpc.addEventListener('click', (e) => {
      if (e.target.closest('#btn-browse-upc')) return;
      fileInputUpc && fileInputUpc.click();
    });

    dropzoneUpc.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); dropzoneUpc.classList.add('drag-over'); });
    dropzoneUpc.addEventListener('dragover',  (e) => { e.preventDefault(); e.stopPropagation(); dropzoneUpc.classList.add('drag-over'); });
    dropzoneUpc.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); dropzoneUpc.classList.remove('drag-over'); });
    dropzoneUpc.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzoneUpc.classList.remove('drag-over');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) handleUpcFile(files[0]);
    });
  }

  if (fileInputUpc) {
    fileInputUpc.addEventListener('change', (e) => {
      if (e.target.files.length) handleUpcFile(e.target.files[0]);
      e.target.value = ''; // reset so same file can be picked again
    });
  }

  function handleUpcFile(file) {
    readAnyFile(file, (raw) => {
      if (typeof converterMode !== 'undefined' && converterMode === 'asin-to-upc') {
        const asins = parseAsins(raw);
        if (asins.length > 0) {
          if (upcPaste) upcPaste.value = asins.join('\n');
          if (upcPasteCount) upcPasteCount.textContent = `${asins.length} ASINs loaded from ${file.name}`;
          showToast(`Loaded ${asins.length} ASINs from ${file.name}`, 'success');
        } else {
          showToast('No valid ASINs found in file', 'error');
        }
      } else {
        const upcs = parseUpcs(raw);
        if (upcs.length > 0) {
          if (upcPaste) upcPaste.value = upcs.join('\n');
          if (upcPasteCount) upcPasteCount.textContent = `${upcs.length} barcodes loaded from ${file.name}`;
          showToast(`Loaded ${upcs.length} barcodes from ${file.name}`, 'success');
        } else {
          showToast('No valid UPC/EAN barcodes found in file', 'error');
        }
      }
    });
  }

  // Start UPC to ASIN Conversion (named so the mode toggle button can call it)
  const btnStartConvert = $('#btn-start-convert');
  const converterProgressCard = $('#converter-progress-card');
  const converterProgressFill = $('#converter-progress-fill');
  const converterProgressStatus = $('#converter-progress-status');
  const converterProgressCount = $('#converter-progress-count');

  async function startUpcScan(upcs) {
    if (!upcs || upcs.length === 0) {
      showToast('Please enter or drop a list of UPCs first', 'error');
      return;
    }

    converterResults = [];
    if (converterProgressCard) converterProgressCard.style.display = 'flex';
    if (converterProgressFill) converterProgressFill.style.width = '0%';
    if (converterProgressStatus) converterProgressStatus.textContent = `Querying Amazon SP-API for ${upcs.length} barcodes...`;
    if (converterProgressCount) converterProgressCount.textContent = `0 / ${upcs.length}`;

    const CHUNK_SIZE = 50;
    for (let i = 0; i < upcs.length; i += CHUNK_SIZE) {
      const chunk = upcs.slice(i, i + CHUNK_SIZE);
      const pct = Math.round((converterResults.length / upcs.length) * 100);
      if (converterProgressFill) converterProgressFill.style.width = `${pct}%`;
      if (converterProgressCount) converterProgressCount.textContent = `${converterResults.length} / ${upcs.length}`;

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

    if (converterProgressFill) converterProgressFill.style.width = '100%';
    if (converterProgressCount) converterProgressCount.textContent = `${converterResults.length} / ${upcs.length}`;
    if (converterProgressStatus) converterProgressStatus.textContent = 'Conversion Complete!';

    setTimeout(() => {
      if (converterProgressCard) converterProgressCard.style.display = 'none';
      renderConverterResults();
      showToast(`Converted ${converterResults.filter(r => r.asin).length} of ${upcs.length} barcodes into ASINs!`, 'success');
    }, 600);
  }

  // Original btn-start-convert listener kept for direct UPC→ASIN mode
  if (btnStartConvert) {
    btnStartConvert.addEventListener('click', () => {
      if (typeof converterMode !== 'undefined' && converterMode === 'asin-to-upc') return; // handled by mode-aware button
      const upcs = parseUpcs(upcPaste ? upcPaste.value : '');
      startUpcScan(upcs);
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

  // Converter Filter Buttons
  $$('.f-btn[data-tab^="converter-"]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.f-btn[data-tab^="converter-"]').forEach(b => b.classList.remove('active'));
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

  // ═══════════════════════════════════════════
  // CONVERTER MODE TOGGLE (UPC→ASIN / ASIN→UPC)
  // ═══════════════════════════════════════════
  let converterMode = 'upc-to-asin'; // 'upc-to-asin' | 'asin-to-upc'
  let a2uResults = [];

  const btnModeU2A = $('#btn-mode-upc-to-asin');
  const btnModeA2U = $('#btn-mode-asin-to-upc');

  function applyConverterMode(mode) {
    converterMode = mode;
    const isU2A = mode === 'upc-to-asin';

    // Toggle button styles
    if (btnModeU2A) {
      btnModeU2A.style.background = isU2A ? 'var(--indigo)' : 'transparent';
      btnModeU2A.style.color = isU2A ? '#fff' : 'var(--text-2)';
    }
    if (btnModeA2U) {
      btnModeA2U.style.background = !isU2A ? 'var(--indigo)' : 'transparent';
      btnModeA2U.style.color = !isU2A ? '#fff' : 'var(--text-2)';
    }

    // Page title / sub
    const titleEl = $('#converter-page-title');
    const subEl   = $('#converter-page-sub');
    if (titleEl) titleEl.textContent = isU2A ? 'UPC → ASIN Converter' : 'ASIN → UPC Lookup';
    if (subEl)   subEl.textContent   = isU2A
      ? 'Bulk-convert UPC / EAN barcodes into Amazon ASINs and check ungating eligibility.'
      : 'Look up UPC / EAN barcodes for any ASIN using the Amazon Catalog API.';

    // Drop zone text
    const dzIcon  = $('#converter-dz-icon');
    const dzTitle = $('#converter-dz-title');
    const dzSub   = $('#converter-dz-sub');
    if (dzIcon)  dzIcon.textContent  = isU2A ? '🏷️' : '📦';
    if (dzTitle) dzTitle.textContent = isU2A ? 'Drop Barcode File' : 'Drop ASIN File';
    if (dzSub)   dzSub.textContent   = isU2A
      ? 'Wholesale price lists with 12-digit UPCs or 13-digit EANs'
      : 'Plain text or CSV file with one ASIN per line';

    // Field label & textarea placeholder
    const fieldLabel = $('#converter-field-label');
    const pasteArea  = $('#upc-paste');
    const pasteCount = $('#upc-paste-count');
    if (fieldLabel) fieldLabel.textContent = isU2A ? 'Paste UPC / EAN Barcodes' : 'Paste ASINs';
    if (pasteArea)  pasteArea.placeholder  = isU2A
      ? 'Paste 12-digit UPCs or 13-digit EANs here — one per line or comma-separated\ne.g. 848061074719, 012345678901...'
      : 'Paste Amazon ASINs here — one per line or comma-separated\ne.g. B08N5WRWNW, B07ZPKN1B2...';
    if (pasteCount) pasteCount.textContent = '0 Items';

    // Footer note & execute button
    const footerNote   = $('#converter-footer-note');
    const executeBtn   = $('#btn-start-convert');
    if (footerNote)  footerNote.textContent = isU2A ? 'Amazon SP-API Catalog Item Lookup' : 'Amazon SP-API Catalog Items — identifiers includedData';
    if (executeBtn) {
      executeBtn.textContent = isU2A ? '🏷️ Convert Barcodes' : '📦 Lookup Barcodes';
    }

    // Stats visibility
    const statsUpc  = $('#converter-stats-upc');
    const statsAsin = $('#converter-stats-asin');
    if (statsUpc)  statsUpc.style.display  = isU2A ? 'grid' : 'none';
    if (statsAsin) statsAsin.style.display = isU2A ? 'none' : 'grid';

    // Table visibility
    const tableUpc  = $('#converter-table-upc');
    const tableAsin = $('#converter-table-asin');
    if (tableUpc)  tableUpc.style.display  = isU2A ? '' : 'none';
    if (tableAsin) tableAsin.style.display = isU2A ? 'none' : '';

    // Filter tab visibility
    const tabUngated  = $('#converter-tab-ungated');
    const tabBarcodes = $('#converter-tab-barcodes');
    if (tabUngated)  tabUngated.style.display  = isU2A ? '' : 'none';
    if (tabBarcodes) tabBarcodes.style.display = isU2A ? 'none' : '';

    // Reset active tab & re-render
    $$('.f-btn[data-tab^="converter-"]').forEach(b => b.classList.remove('active'));
    const allBtn = $('.f-btn[data-tab="converter-all"]');
    if (allBtn) allBtn.classList.add('active');
    activeConverterTab = 'converter-all';

    if (pasteArea) pasteArea.value = '';
  }

  if (btnModeU2A) btnModeU2A.addEventListener('click', () => applyConverterMode('upc-to-asin'));
  if (btnModeA2U) btnModeA2U.addEventListener('click', () => applyConverterMode('asin-to-upc'));

  // ═══════════════════════════════════════════
  // ASIN → UPC FETCH & RENDER
  // ═══════════════════════════════════════════
  function renderA2UTable() {
    const tbody = $('#a2u-table-body');
    if (!tbody) return;

    const q = converterSearchQuery.toLowerCase();
    let filtered = a2uResults;
    if (activeConverterTab === 'converter-barcodes') {
      filtered = a2uResults.filter(r => r.barcodes && r.barcodes.length > 0);
    }
    if (q) {
      filtered = filtered.filter(r =>
        (r.asin && r.asin.toLowerCase().includes(q)) ||
        (r.title && r.title.toLowerCase().includes(q)) ||
        (r.upc && r.upc.includes(q)) ||
        (r.ean && r.ean.includes(q))
      );
    }

    // Update badge counts
    const badgeAll = $('#converter-badge-all');
    const badgeBarcode = $('#converter-badge-barcodes');
    if (badgeAll) badgeAll.textContent = a2uResults.length;
    if (badgeBarcode) badgeBarcode.textContent = a2uResults.filter(r => r.barcodes && r.barcodes.length > 0).length;

    // Update stats
    const total  = a2uResults.length;
    const found  = a2uResults.filter(r => r.barcodes && r.barcodes.length > 0).length;
    const upcs   = a2uResults.filter(r => r.upc).length;
    const eans   = a2uResults.filter(r => r.ean).length;
    const elT = $('#a2u-stat-total');  if (elT) elT.textContent = total;
    const elF = $('#a2u-stat-found');  if (elF) elF.textContent = found;
    const elU = $('#a2u-stat-upc');    if (elU) elU.textContent = upcs;
    const elE = $('#a2u-stat-ean');    if (elE) elE.textContent = eans;

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="5"><div class="empty-state">
        <div class="empty-icon">📦</div>
        <div class="empty-title">${a2uResults.length === 0 ? 'No ASINs Looked Up Yet' : 'No Matching Results'}</div>
        <div class="empty-desc">${a2uResults.length === 0 ? 'Paste ASINs above to retrieve their UPC / EAN barcodes.' : 'Try adjusting your search or filter.'}</div>
      </div></td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(item => {
      const allBarcodes = (item.barcodes || []).map(b => `<span style="font-family:var(--mono);font-size:0.8rem;">${b.type}: ${b.value}</span>`).join('<br>');
      const statusBadge = item.status === 'found'
        ? `<span class="badge badge-ungated">🏷️ FOUND</span>`
        : item.status === 'no_barcode'
          ? `<span class="badge badge-softgated">⚠️ NO BARCODE</span>`
          : `<span class="badge badge-hardgated">❌ NOT FOUND</span>`;

      const upcVal = item.upc ? `<span class="mono" style="font-size:0.85rem;">${item.upc}</span>` : `<span style="color:var(--text-3)">—</span>`;
      const eanVal = item.ean ? `<span class="mono" style="font-size:0.85rem;">${item.ean}</span>` : `<span style="color:var(--text-3)">—</span>`;

      return `
        <tr>
          <td class="cell-asin">${item.asin}</td>
          <td class="cell-title" title="${(item.title||'').replace(/"/g,'&quot;')}">${item.title || '—'}</td>
          <td>${upcVal}</td>
          <td>${eanVal}</td>
          <td style="text-align:right">
            <div class="action-cluster">
              <a href="https://www.amazon.com/dp/${item.asin}" target="_blank" class="a-link">Amazon</a>
              <a href="https://keepa.com/#!product/1-${item.asin}" target="_blank" class="a-link">Keepa</a>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // Intercept the execute button to handle both modes
  const originalConverterBtn = $('#btn-start-convert');
  if (originalConverterBtn) {
    // Remove previous listener by cloning
    const newBtn = originalConverterBtn.cloneNode(true);
    originalConverterBtn.parentNode.replaceChild(newBtn, originalConverterBtn);

    newBtn.addEventListener('click', async () => {
      if (converterMode === 'asin-to-upc') {
        // ASIN → UPC mode
        const rawText = $('#upc-paste') ? $('#upc-paste').value : '';
        const inputAsins = rawText
          .split(/[\n\r,\s]+/)
          .map(s => s.trim().replace(/^["']|["']$/g, ''))
          .filter(s => /^[A-Z0-9]{10}$/i.test(s))
          .map(s => s.toUpperCase());

        const seen = new Set();
        const asins = inputAsins.filter(a => { if (seen.has(a)) return false; seen.add(a); return true; });

        if (asins.length === 0) {
          showToast('Please paste valid ASINs (10-character codes) first', 'error');
          return;
        }

        a2uResults = [];
        const progCard   = $('#converter-progress-card');
        const progFill   = $('#converter-progress-fill');
        const progStatus = $('#converter-progress-status');
        const progCount  = $('#converter-progress-count');
        const progEta    = $('#converter-progress-eta');

        if (progCard) progCard.style.display = 'flex';
        if (progFill) progFill.style.width = '0%';
        if (progStatus) progStatus.textContent = `Looking up barcodes for ${asins.length} ASINs…`;
        if (progCount) progCount.textContent = `0 / ${asins.length}`;
        if (progEta) progEta.textContent = 'Est: –';

        const CHUNK = 20;
        const startTime = Date.now();

        for (let i = 0; i < asins.length; i += CHUNK) {
          const chunk = asins.slice(i, i + CHUNK);
          const processed = i;
          const pct = Math.round((processed / asins.length) * 100);
          if (progFill) progFill.style.width = `${pct}%`;
          if (progCount) progCount.textContent = `${processed} / ${asins.length}`;

          if (processed > 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            const rate = processed / elapsed;
            const remaining = Math.ceil((asins.length - processed) / rate);
            const m = Math.floor(remaining / 60), s = remaining % 60;
            if (progEta) progEta.textContent = `Est: ${m > 0 ? `${m}m ${s}s` : `${s}s`}`;
          }
          if (progStatus) progStatus.textContent = `Batch ${Math.floor(i/CHUNK)+1} of ${Math.ceil(asins.length/CHUNK)}…`;

          try {
            const res = await fetch('/api/asin-to-upc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ asins: chunk })
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            a2uResults.push(...(data.results || []));
            renderA2UTable();
          } catch (err) {
            showToast(`Batch error: ${err.message}`, 'error');
          }
        }

        if (progFill) progFill.style.width = '100%';
        if (progCount) progCount.textContent = `${a2uResults.length} / ${asins.length}`;
        if (progStatus) progStatus.textContent = 'Lookup complete!';
        if (progEta) progEta.textContent = 'Done';
        setTimeout(() => { if (progCard) progCard.style.display = 'none'; renderA2UTable(); }, 600);
        showToast(`Barcode lookup complete — ${a2uResults.length} ASINs processed`, 'success');

      } else {
        // UPC → ASIN mode — trigger the original UPC handler
        triggerUpcToAsinScan();
      }
    });
  }

  // Pull the UPC→ASIN scan into a named function so the new button can call it
  function triggerUpcToAsinScan() {
    const upcPaste = $('#upc-paste');
    if (!upcPaste) return;
    const upcs = upcPaste.value
      .split(/[\n\r,]+/)
      .map(u => u.trim())
      .filter(u => u.length >= 8 && /^\d+$/.test(u));

    if (upcs.length === 0) {
      showToast('Please enter valid UPC/EAN barcodes (digits only, 8–13 characters)', 'error');
      return;
    }
    // Dispatch the existing UPC scan (inline below)
    startUpcScan(upcs);
  }

  // Converter CSV Export (handles both modes)
  const btnExportConverterCsv = $('#btn-export-converter-csv');
  if (btnExportConverterCsv) {
    btnExportConverterCsv.addEventListener('click', () => {
      if (converterMode === 'asin-to-upc') {
        if (a2uResults.length === 0) { showToast('No results to export', 'info'); return; }
        // Use ="VALUE" to prevent Excel from converting barcodes to scientific notation
        let csv = 'ASIN,Product Title,UPC,EAN,All Barcodes,Amazon Link\n';
        a2uResults.forEach(item => {
          const allB = (item.barcodes||[]).map(b=>`${b.type}:${b.value}`).join('|');
          const upcCell = item.upc ? `="${item.upc}"` : '';
          const eanCell = item.ean ? `="${item.ean}"` : '';
          csv += `"${item.asin}","${(item.title||'').replace(/"/g,'""')}","${upcCell}","${eanCell}","${allB}","https://www.amazon.com/dp/${item.asin}"\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url;
        a.download = `asin-to-upc-${new Date().toISOString().slice(0,10)}.csv`;
        a.click(); URL.revokeObjectURL(url);
        showToast(`Exported ${a2uResults.length} records`, 'success');
      } else {
        const converted = converterResults.filter(r => r.asin);
        if (converted.length === 0) { showToast('No converted ASINs to export', 'info'); return; }
        // Use ="VALUE" to prevent Excel from converting barcodes to scientific notation
        let csv = 'Input UPC,Matched ASIN,Product Title,Ungating Status,Amazon Link\n';
        converted.forEach(item => {
          csv += `="${item.upc}","${item.asin}","${(item.title||'').replace(/"/g,'""')}","${item.status}","https://www.amazon.com/dp/${item.asin}"\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url;
        a.download = `converted-upc-asins-${new Date().toISOString().slice(0,10)}.csv`;
        a.click(); URL.revokeObjectURL(url);
        showToast(`Exported ${converted.length} records`, 'success');
      }
    });
  }

  // Save / Remove event listeners for table buttons (covers a-save + btn-save-link)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.a-save, .btn-save-link');
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

  // ═══════════════════════════════════════════════════
  //  WHOLESALE MATCHER MODULE
  // ═══════════════════════════════════════════════════
  let matcherResults = [];
  let matcherTab = 'matcher-all';
  let matcherQuery = '';

  // Helper: extract all digit-only strings (8–14 digits = barcodes) from raw text
  function parseUpcMap(text) {
    const arr = parseUpcs(text);
    const map = new Map();
    for (const item of arr) {
      if (typeof item === 'object') {
        map.set(item.upc, item);
      } else {
        map.set(item, item);
      }
    }
    return map;
  }


  // Live count update for each textarea
  const matcherMyUpcs = $('#matcher-my-upcs');
  const matcherWsUpcs = $('#matcher-ws-upcs');
  const matcherMyCount = $('#matcher-my-count');
  const matcherWsCount = $('#matcher-ws-count');
  const matcherOverlapNote = $('#matcher-overlap-note');

  // Canonical comparison helper (aligns 11-digit, 12-digit, 13-digit, and 14-digit UPC/EAN/GTINs without mutating original barcodes)
  function getMatchKey(str) {
    if (!str) return '';
    let s = String(str).trim();
    if (/^\d{11}$/.test(s)) s = '0' + s;
    while (s.length > 12 && s.startsWith('0')) {
      s = s.slice(1);
    }
    return s;
  }

  function refreshMatcherCounts() {
    const myMap = matcherMyUpcs ? parseUpcMap(matcherMyUpcs.value) : new Map();
    const wsMap = matcherWsUpcs ? parseUpcMap(matcherWsUpcs.value) : new Map();
    
    // Map canonical wholesaler keys to original keys
    const wsNormMap = new Map();
    for (const k of wsMap.keys()) {
      wsNormMap.set(getMatchKey(k), k);
    }
    
    // Find intersection using canonical keys
    const overlap = [];
    for (const k of myMap.keys()) {
      if (wsNormMap.has(getMatchKey(k))) {
        overlap.push(k);
      }
    }
    
    if (matcherMyCount) matcherMyCount.textContent = `${myMap.size} Items`;
    if (matcherWsCount) matcherWsCount.textContent = `${wsMap.size} Items`;
    if (matcherOverlapNote) {
      matcherOverlapNote.textContent = myMap.size > 0 && wsMap.size > 0
        ? `${overlap.length} overlapping items found — click Match to look up ASINs & ungating`
        : 'Load both lists to find overlapping items (UPCs or ASINs)';
    }
    const elMy = $('#matcher-stat-my'); if (elMy) elMy.textContent = myMap.size;
    const elWs = $('#matcher-stat-ws'); if (elWs) elWs.textContent = wsMap.size;
  }

  if (matcherMyUpcs) matcherMyUpcs.addEventListener('input', refreshMatcherCounts);
  if (matcherWsUpcs) matcherWsUpcs.addEventListener('input', refreshMatcherCounts);

  // File browse helpers
  function bindMatcherFile(inputId, textareaId, countFn) {
    const inp = $(inputId);
    if (!inp) return;
    inp.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      readAnyFile(file, (rawText) => {
        const ta = $(textareaId);
        if (ta) ta.value = rawText;
        countFn();
        refreshMatcherCounts();
        showToast(`Loaded ${file.name}`, 'success');
      });
      e.target.value = '';
    });
  }
  
  // Drag & drop support for textareas
  function bindDragDropToTextarea(textareaId, countFn) {
    const ta = $(textareaId);
    if (!ta) return;
    ta.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); ta.classList.add('drag-over'); });
    ta.addEventListener('dragover',  (e) => { e.preventDefault(); e.stopPropagation(); ta.classList.add('drag-over'); });
    ta.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); ta.classList.remove('drag-over'); });
    ta.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ta.classList.remove('drag-over');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) {
        readAnyFile(files[0], (rawText) => {
          ta.value = rawText;
          countFn();
          refreshMatcherCounts();
          showToast(`Loaded ${files[0].name}`, 'success');
        });
      }
    });
  }

  bindMatcherFile('#matcher-my-file', '#matcher-my-upcs', () => {});
  bindMatcherFile('#matcher-ws-file', '#matcher-ws-upcs', () => {});
  bindDragDropToTextarea('#matcher-my-upcs', () => {});
  bindDragDropToTextarea('#matcher-ws-upcs', () => {});

  // Clear All
  const btnMatcherClear = $('#btn-matcher-clear');
  if (btnMatcherClear) {
    btnMatcherClear.addEventListener('click', () => {
      if (matcherMyUpcs) matcherMyUpcs.value = '';
      if (matcherWsUpcs) matcherWsUpcs.value = '';
      matcherResults = [];
      refreshMatcherCounts();
      renderMatcherTable();
    });
  }

  // Search
  const matcherSearchInput = $('#matcher-search-input');
  if (matcherSearchInput) {
    matcherSearchInput.addEventListener('input', (e) => {
      matcherQuery = e.target.value.trim().toLowerCase();
      renderMatcherTable();
    });
  }

  // Filter tabs
  $$('.f-btn[data-tab^="matcher-"]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.f-btn[data-tab^="matcher-"]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      matcherTab = btn.dataset.tab;
      renderMatcherTable();
    });
  });

  // Render matcher table
  function renderMatcherTable() {
    const tbody = $('#matcher-table-body');
    if (!tbody) return;

    const ungated    = matcherResults.filter(r => r.status === 'ungated');
    const profitable = matcherResults.filter(r => r.profit !== null && r.profit > 0 && r.roi !== null && r.roi >= 20);
    const approval   = matcherResults.filter(r => r.status === 'gated' && r.hasApprovalRoute);
    const restricted = matcherResults.filter(r => (r.status === 'gated' && !r.hasApprovalRoute) || r.status === 'error' || r.status === 'no_match');

    // Update badges
    const bAll = $('#matcher-badge-all');       if (bAll) bAll.textContent = matcherResults.length;
    const bUn  = $('#matcher-badge-ungated');   if (bUn)  bUn.textContent  = ungated.length;
    const bPr  = $('#matcher-badge-profitable');if (bPr)  bPr.textContent  = profitable.length;
    const bAp  = $('#matcher-badge-approval');  if (bAp)  bAp.textContent  = approval.length;
    const bRe  = $('#matcher-badge-restricted');if (bRe)  bRe.textContent  = restricted.length;

    // Update stats
    const elOv = $('#matcher-stat-overlap'); if (elOv) elOv.textContent = matcherResults.length;
    const elUn = $('#matcher-stat-ungated'); if (elUn) elUn.textContent = ungated.length;

    // Filter by tab
    let filtered = matcherResults;
    if (matcherTab === 'matcher-ungated')    filtered = ungated;
    if (matcherTab === 'matcher-profitable') filtered = profitable;
    if (matcherTab === 'matcher-approval')   filtered = approval;
    if (matcherTab === 'matcher-restricted') filtered = restricted;

    // Search filter
    if (matcherQuery) {
      filtered = filtered.filter(r =>
        (r.upc   && r.upc.includes(matcherQuery)) ||
        (r.asin  && r.asin.toLowerCase().includes(matcherQuery)) ||
        (r.title && r.title.toLowerCase().includes(matcherQuery))
      );
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="8"><div class="empty-state">
        <div class="empty-icon">🔗</div>
        <div class="empty-title">${matcherResults.length === 0 ? 'No Matches Yet' : 'No Results in This Category'}</div>
        <div class="empty-desc">${matcherResults.length === 0
          ? 'Paste both UPC lists and click Match &amp; Check Ungating.'
          : 'Try a different filter or clear the search.'}</div>
      </div></td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(r => {
      let badge, detail;
      if (r.status === 'no_match') {
        badge  = `<span class="badge badge-hardgated">🔍 NO ASIN</span>`;
        detail = `<span class="t-muted">Not on Amazon</span>`;
      } else if (r.status === 'ungated') {
        badge  = `<span class="badge badge-ungated">✅ UNGATED</span>`;
        detail = `<span class="t-green">Ready to sell</span>`;
      } else if (r.status === 'gated' && r.hasApprovalRoute) {
        badge  = `<span class="badge badge-softgated">⚠️ APPROVAL</span>`;
        detail = `<span class="t-amber">Invoice needed</span>`;
      } else if (r.status === 'error') {
        badge  = `<span class="badge badge-hardgated">⚠️ ERROR</span>`;
        detail = `<span class="t-red">API error</span>`;
      } else {
        badge  = `<span class="badge badge-hardgated">❌ RESTRICTED</span>`;
        detail = `<span class="t-red">${r.reasonCode || 'NOT_ELIGIBLE'}</span>`;
      }

      const ungateBtn = (r.status === 'gated' && r.hasApprovalRoute && r.asin)
        ? `<a href="https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=${r.asin}" target="_blank" class="a-ungate">⚡ 1-Click Ungate</a>`
        : '';

      const asinCell = r.asin
        ? `<span class="cell-asin">${r.asin}</span>`
        : `<span class="t-muted">—</span>`;

      const amazonLink = r.asin
        ? `<a href="https://www.amazon.com/dp/${r.asin}" target="_blank" class="a-link">Amazon</a>
           <a href="https://keepa.com/#!product/1-${r.asin}" target="_blank" class="a-link">Keepa</a>`
        : '';

      const costCell = r.cost != null ? `$${Number(r.cost).toFixed(2)}` : '<span class="t-muted">—</span>';
      const amazonPriceCell = r.amazonPrice != null ? `$${Number(r.amazonPrice).toFixed(2)}` : '<span class="t-muted">—</span>';
      
      let profitCell = '<span class="t-muted">—</span>';
      if (r.profit != null && r.roi != null) {
        if (r.roi >= 20) {
          profitCell = `<span class="badge badge-ungated" style="font-weight:600;">+$${r.profit.toFixed(2)} (+${r.roi.toFixed(0)}% ROI)</span>`;
        } else if (r.profit > 0) {
          profitCell = `<span class="badge badge-softgated" style="font-weight:600;">+$${r.profit.toFixed(2)} (+${r.roi.toFixed(0)}% ROI)</span>`;
        } else {
          profitCell = `<span class="badge badge-hardgated" style="font-weight:600;">-$${Math.abs(r.profit).toFixed(2)} (${r.roi.toFixed(0)}% ROI)</span>`;
        }
      }

      return `
        <tr>
          <td><span class="mono" style="font-size:0.88rem;">${r.upc}</span></td>
          <td>${asinCell}</td>
          <td class="cell-title" title="${(r.title||'').replace(/"/g,'&quot;')}">${r.title || '—'}</td>
          <td>${costCell}</td>
          <td>${amazonPriceCell}</td>
          <td>${profitCell}</td>
          <td>${badge}<br><small style="margin-top:3px;display:block;">${detail}</small></td>
          <td style="text-align:right">
            <div class="action-cluster">
              ${amazonLink}
              ${ungateBtn}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // MAIN: Match & Check Ungating
  const btnMatcherRun = $('#btn-matcher-run');
  if (btnMatcherRun) {
    btnMatcherRun.addEventListener('click', async () => {
      const myMap = matcherMyUpcs ? parseUpcMap(matcherMyUpcs.value) : new Map();
      const wsMap = matcherWsUpcs ? parseUpcMap(matcherWsUpcs.value) : new Map();

      if (myMap.size === 0) { showToast('Paste your brand list on the left first', 'error'); return; }
      if (wsMap.size === 0) { showToast('Paste the wholesaler price list on the right first', 'error'); return; }

      // Step 1: Find intersection using canonical keys
      const wsNormMap = new Map();
      for (const [k, v] of wsMap.entries()) {
        wsNormMap.set(getMatchKey(k), v);
      }

      const overlapData = [];
      for (const [myKey, myVal] of myMap.entries()) {
        const myKeyCanonical = getMatchKey(myKey);
        if (wsNormMap.has(myKeyCanonical)) {
          const wsVal = wsNormMap.get(myKeyCanonical);
          let selected = wsVal;
          if (typeof wsVal === 'object' && wsVal.title) {
            selected = { ...wsVal };
          } else if (typeof myVal === 'object' && myVal.title) {
            selected = { ...myVal };
          } else {
            selected = typeof wsVal === 'object' ? wsVal.upc : (wsVal || myKey);
          }

          // Ensure 11-digit UPCs are padded to valid 12-digit UPCs so Amazon API accepts them
          if (typeof selected === 'object') {
            if (/^\d{11}$/.test(selected.upc)) selected.upc = '0' + selected.upc;
          } else if (typeof selected === 'string') {
            if (/^\d{11}$/.test(selected)) selected = '0' + selected;
          }

          overlapData.push(selected);
        }
      }

      if (overlapData.length === 0) {
        showToast('No items in common between the two lists', 'info');
        matcherResults = [];
        renderMatcherTable();
        return;
      }
      
      showToast(`Found ${overlapData.length} overlapping UPCs — looking up ASINs & checking ungating…`, 'info');

      // Progress UI
      const progCard   = $('#matcher-progress-card');
      const progFill   = $('#matcher-progress-fill');
      const progStatus = $('#matcher-progress-status');
      const progCount  = $('#matcher-progress-count');
      const progEta    = $('#matcher-progress-eta');

      if (progCard)   progCard.style.display = 'flex';
      if (progFill)   progFill.style.width = '0%';
      if (progStatus) progStatus.textContent = `Step 1 of 2: Resolving ${overlapData.length} UPCs to ASINs…`;
      if (progCount)  progCount.textContent  = `0 / ${overlapData.length}`;
      if (progEta)    progEta.textContent    = 'Est: –';

      matcherResults = [];

      const CHUNK = 50;
      const startTime = Date.now();
      let upcToData = {}; // upc → { asin, title, brand }

      // Step 1: UPC → ASIN via /api/convert-upc
      for (let i = 0; i < overlapData.length; i += CHUNK) {
        const chunk = overlapData.slice(i, i + CHUNK);
        const pct   = Math.round((i / overlapData.length) * 50); // first 50% of bar
        if (progFill) progFill.style.width = `${pct}%`;
        if (progCount) progCount.textContent = `${i} / ${overlapData.length}`;
        if (i > 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = i / elapsed;
          const rem = Math.ceil((overlapData.length - i) / rate);
          if (progEta) progEta.textContent = `Est: ${rem > 60 ? `${Math.floor(rem/60)}m ${rem%60}s` : `${rem}s`}`;
        }

        try {
          const res = await fetch('/api/convert-upc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ upcs: chunk })
          });
          if (!res.ok) throw new Error(await res.text());
          const data = await res.json();
          for (const r of (data.results || [])) {
            upcToData[r.upc] = r; // has { upc, asin, title, brand, status, hasApprovalRoute, ... }
          }
        } catch (err) {
          showToast(`UPC lookup error: ${err.message}`, 'error');
        }
      }

      // Step 2: We already have the ungating status from convert-upc (it calls checkSingleAsinWithRetry internally)
      // Build matcherResults directly from upcToData
      if (progStatus) progStatus.textContent = 'Step 2 of 2: Collating ungating results…';
      if (progFill) progFill.style.width = '90%';

      for (const item of overlapData) {
        const upc = typeof item === 'object' ? item.upc : item;
        const cost = typeof item === 'object' && item.cost ? item.cost : null;
        const d = upcToData[upc];
        if (d) {
          const amazonPrice = d.amazonPrice || null;
          let profit = null;
          let roi = null;
          if (cost && amazonPrice) {
            const refFee = amazonPrice * 0.15;
            const fbaFee = Math.max(3.75, Number((amazonPrice * 0.12).toFixed(2)));
            const payout = amazonPrice - refFee - fbaFee;
            profit = Number((payout - cost).toFixed(2));
            roi = Number(((profit / cost) * 100).toFixed(1));
          }

          matcherResults.push({
            upc,
            asin:            d.asin || null,
            title:           d.title || '',
            brand:           d.brand || '',
            cost:            cost,
            amazonPrice:     amazonPrice,
            profit:          profit,
            roi:             roi,
            status:          d.status || 'no_match',
            hasApprovalRoute: d.hasApprovalRoute || false,
            reasonCode:      d.reasonCode || '',
            reasons:         d.reasons || []
          });
        } else {
          matcherResults.push({ upc, asin: null, title: 'No Amazon match', brand: '', cost, amazonPrice: null, profit: null, roi: null, status: 'no_match', hasApprovalRoute: false, reasonCode: '', reasons: [] });
        }
      }

      if (progFill) progFill.style.width = '100%';
      if (progCount) progCount.textContent = `${matcherResults.length} / ${overlapData.length}`;
      if (progStatus) progStatus.textContent = 'Match complete!';
      if (progEta) progEta.textContent = 'Done';

      setTimeout(() => {
        if (progCard) progCard.style.display = 'none';
        renderMatcherTable();
        const ungatedCount = matcherResults.filter(r => r.status === 'ungated').length;
        showToast(`Matched ${matcherResults.length} UPCs — ${ungatedCount} are ungated for you`, 'success');
      }, 400);
    });
  }

  // CSV Export for Matcher
  const btnExportMatcherCsv = $('#btn-export-matcher-csv');
  if (btnExportMatcherCsv) {
    btnExportMatcherCsv.addEventListener('click', () => {
      if (matcherResults.length === 0) { showToast('No results to export', 'info'); return; }
      // Use ="VALUE" to prevent Excel from converting barcodes to scientific notation
      let csv = 'UPC,ASIN,Product Title,Wholesale Cost,Amazon Price,Est FBA Net Profit,Est ROI %,Ungating Status,Has Approval Route,Amazon Link\n';
      matcherResults.forEach(r => {
        const link = r.asin ? `https://www.amazon.com/dp/${r.asin}` : '';
        const costStr = r.cost != null ? r.cost.toFixed(2) : '';
        const priceStr = r.amazonPrice != null ? r.amazonPrice.toFixed(2) : '';
        const profitStr = r.profit != null ? r.profit.toFixed(2) : '';
        const roiStr = r.roi != null ? r.roi.toFixed(1) + '%' : '';
        csv += `="${r.upc}","${r.asin||''}","${(r.title||'').replace(/"/g,'""')}","${costStr}","${priceStr}","${profitStr}","${roiStr}","${r.status}","${r.hasApprovalRoute ? 'YES' : 'NO'}","${link}"\n`;
      });
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wholesale-matches-${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${matcherResults.length} matched products`, 'success');
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

  // Prevent default drag & drop behaviors globally to avoid page navigation on accidental drops
  window.addEventListener('dragover', (e) => e.preventDefault(), false);
  window.addEventListener('drop', (e) => e.preventDefault(), false);

  // Initial render
  renderResults();
  renderConverterResults();
})();
