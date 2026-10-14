/**
 * CropAI – Frontend Application
 * ─────────────────────────────────────────────────────────────────────────────
 * State machine with 6 stages:
 *   upload → prompt → loading → (ambiguous | error | result)
 *
 * Responsibilities:
 *   • Image drag-and-drop / file picker
 *   • Stage transitions
 *   • Communicating with the backend API
 *   • Result display (original + cropped comparison)
 *   • Canvas overlay for detected region
 *   • Download (PNG + JPG)
 *   • Adjust / refine mode
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─── Backend URL ──────────────────────────────────────────────────────────────
// When the frontend is hosted on Netlify and the backend is on Render,
// set window.CROPAI_API_BASE to the Render URL before this script loads,
// OR define it in netlify.toml as a redirect proxy (see netlify.toml).
// Falls back to '' (same origin) when running locally or on Render.
const API_BASE = (typeof window !== 'undefined' && window.CROPAI_API_BASE) || '';

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  currentMultiResults: null,
  fileId:         null,       // UUID returned by /api/upload
  imageWidth:     0,
  imageHeight:    0,
  imageFormat:    '',
  imageName:      '',
  lastAIResult:   null,       // Most recent AI response for Adjust mode
  lastPrompt:     '',
  outputId:       null,       // UUID of the current output image
  overlayVisible: false,
  abortController: null,      // For cancelling in-flight requests
};

// ─── DOM References ───────────────────────────────────────────────────────────

const dom = {
  // Stages
  uploadStage:    document.getElementById('upload-stage'),
  promptStage:    document.getElementById('prompt-stage'),
  loadingStage:   document.getElementById('loading-stage'),
  ambiguousStage: document.getElementById('ambiguous-stage'),
  errorStage:     document.getElementById('error-stage'),
  resultStage:    document.getElementById('result-stage'),

  // Upload
  dropZone:       document.getElementById('drop-zone'),
  fileInput:      document.getElementById('file-input'),

  // Preview
  previewImage:   document.getElementById('preview-image'),
  imageMeta:      document.getElementById('image-meta'),
  detectionBox:   document.getElementById('detection-box'),

  // Prompt
  promptInput:    document.getElementById('prompt-input'),
  cropBtn:        document.getElementById('crop-btn'),
  charCount:      document.getElementById('char-count'),
  chipsWrapper:   document.getElementById('chips-wrapper'),
  startOverBtnPrompt: document.getElementById('start-over-btn-prompt'),
  replaceImageBtn:    document.getElementById('replace-image-btn'),
  removeBgCheckbox: document.getElementById('remove-bg-checkbox'),

  // Loading
  cancelBtn:      document.getElementById('cancel-btn'),
  loadingSteps: {
    analyze: document.getElementById('step-analyze'),
    locate:  document.getElementById('step-locate'),
    extract: document.getElementById('step-extract'),
    process: document.getElementById('step-process'),
  },

  // Ambiguous
  ambiguousMessage: document.getElementById('ambiguous-message'),
  ambiguousOptions: document.getElementById('ambiguous-options'),
  ambiguousBackBtn: document.getElementById('ambiguous-back-btn'),
  ambiguousExtractAllBtn: document.getElementById('ambiguous-extract-all-btn'),

  // Error
  errorMessage:      document.getElementById('error-message'),
  errorRetryBtn:     document.getElementById('error-retry-btn'),
  errorStartOverBtn: document.getElementById('error-start-over-btn'),

  // Result
  resultModeBadge:   document.getElementById('result-mode-badge'),
  resultMeta:        document.getElementById('result-meta'),
  originalResultImg: document.getElementById('original-result-img'),
  overlayCanvas:     document.getElementById('overlay-canvas'),
  toggleOverlayBtn:  document.getElementById('toggle-overlay-btn'),
  resultImg:         document.getElementById('result-img'),
  fallbackNotice:    document.getElementById('fallback-notice'),
  multiResultContainer: document.getElementById('multi-result-container'),
  multiResultGrid:      document.getElementById('multi-result-grid'),
  singleComparisonGrid: document.getElementById('single-comparison-grid'),
  downloadPngBtn:    document.getElementById('download-png-btn'),
  downloadJpgBtn:    document.getElementById('download-jpg-btn'),
  tryAnotherBtn:     document.getElementById('try-another-btn'),
  startOverBtnResult: document.getElementById('start-over-btn-result'),
  aiTarget:          document.getElementById('ai-target'),
  aiConfidence:      document.getElementById('ai-confidence'),
  confidenceBar:     document.getElementById('confidence-bar'),
  aiInstruction:     document.getElementById('ai-instruction'),

  // Adjust
  adjustInput:       document.getElementById('adjust-input'),
  adjustBtn:         document.getElementById('adjust-btn'),

  // Status badge
  apiBadge:          document.getElementById('api-status-badge'),
  apiBadgeLabel:     document.querySelector('#api-status-badge .badge-label'),

  // Toast
  toast:             document.getElementById('toast'),
};

// ─── Stage Manager ────────────────────────────────────────────────────────────

const STAGES = ['upload', 'prompt', 'loading', 'ambiguous', 'error', 'result'];

function showStage(name) {
  STAGES.forEach(s => {
    const el = dom[`${s}Stage`];
    if (!el) return;
    if (s === name) {
      el.removeAttribute('hidden');
      el.classList.add('active');
    } else {
      el.setAttribute('hidden', '');
      el.classList.remove('active');
    }
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;

function showToast(message, type = 'info', durationMs = 3500) {
  clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.className   = `toast toast-${type} visible`;
  toastTimer = setTimeout(() => {
    dom.toast.classList.remove('visible');
  }, durationMs);
}

// ─── API Status Check ─────────────────────────────────────────────────────────

async function checkApiStatus() {
  try {
    const res  = await fetch(API_BASE + '/api/health');
    const data = await res.json();

    if (data.apiConfigured) {
      dom.apiBadge.className        = 'header-badge ready';
      dom.apiBadgeLabel.textContent = `AI Ready · ${data.model.split('/').pop()}`;
    } else {
      dom.apiBadge.className        = 'header-badge error';
      dom.apiBadgeLabel.textContent = 'API key missing';
      showToast('⚠️ OpenRouter API key not configured. Set OPENROUTER_API_KEY in .env', 'error', 8000);
    }
  } catch {
    dom.apiBadge.className        = 'header-badge error';
    dom.apiBadgeLabel.textContent = 'Server offline';
  }
}

// ─── Image Upload ─────────────────────────────────────────────────────────────

function handleFileSelect(file) {
  if (!file) return;

  // Client-side type validation
  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(file.type)) {
    showToast('❌ Unsupported file type. Please use PNG, JPG, or WEBP.', 'error');
    return;
  }

  // Client-side size validation (10 MB)
  if (file.size > 10 * 1024 * 1024) {
    showToast('❌ File too large. Maximum size is 10 MB.', 'error');
    return;
  }

  state.imageName = file.name;

  // Show immediate preview
  const reader = new FileReader();
  reader.onload = e => {
    dom.previewImage.src = e.target.result;
  };
  reader.readAsDataURL(file);

  // Upload to server
  uploadFile(file);
}

async function uploadFile(file) {
  dom.apiBadge.className        = 'header-badge loading';
  dom.apiBadgeLabel.textContent = 'Uploading…';

  const formData = new FormData();
  formData.append('image', file);

  try {
    const res  = await fetch(API_BASE + '/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      showToast(`❌ ${data.error || 'Upload failed.'}`, 'error');
      checkApiStatus();
      return;
    }

    // Store metadata
    state.fileId      = data.fileId;
    state.imageWidth  = data.width;
    state.imageHeight = data.height;
    state.imageFormat = data.format;

    // Show dimensions
    dom.imageMeta.textContent = `${data.width} × ${data.height}px · ${data.format?.toUpperCase()} · ${(file.size / 1024).toFixed(0)} KB`;

    // Enable prompt input
    dom.promptInput.disabled = false;
    dom.cropBtn.disabled     = dom.promptInput.value.trim().length === 0;

    showStage('prompt');
    dom.promptInput.focus();
    checkApiStatus();

  } catch (err) {
    showToast('❌ Network error during upload. Is the server running?', 'error');
    checkApiStatus();
  }
}

// ─── Drag and Drop ────────────────────────────────────────────────────────────

dom.dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dom.dropZone.classList.add('drag-over');
});

dom.dropZone.addEventListener('dragleave', e => {
  if (!dom.dropZone.contains(e.relatedTarget)) {
    dom.dropZone.classList.remove('drag-over');
  }
});

dom.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dom.dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  handleFileSelect(file);
});

dom.dropZone.addEventListener('click', () => dom.fileInput.click());

dom.dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    dom.fileInput.click();
  }
});

dom.fileInput.addEventListener('change', e => {
  handleFileSelect(e.target.files[0]);
  e.target.value = ''; // Reset so same file can be re-selected
});

// ─── Prompt Input ─────────────────────────────────────────────────────────────

dom.promptInput.addEventListener('input', () => {
  const len = dom.promptInput.value.length;
  dom.charCount.textContent = `${len} / 500`;
  dom.charCount.className   = 'prompt-char-count' +
    (len >= 500 ? ' at-limit' : len >= 400 ? ' near-limit' : '');
  dom.cropBtn.disabled = len === 0;
});

dom.promptInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!dom.cropBtn.disabled) startCrop();
  }
});

// Prompt chips
dom.chipsWrapper.addEventListener('click', e => {
  const chip = e.target.closest('.chip[data-prompt]');
  if (!chip) return;
  dom.promptInput.value = chip.dataset.prompt;
  dom.promptInput.dispatchEvent(new Event('input'));
  dom.promptInput.focus();
});

// Adjust chips
document.getElementById('adjust-panel').addEventListener('click', e => {
  const chip = e.target.closest('.chip[data-adjust]');
  if (!chip) return;
  dom.adjustInput.value = chip.dataset.adjust;
  dom.adjustInput.focus();
});

// ─── Crop Pipeline ────────────────────────────────────────────────────────────

dom.cropBtn.addEventListener('click', startCrop);
dom.adjustBtn.addEventListener('click', startAdjust);

async function startCrop() {
  const prompt = dom.promptInput.value.trim();
  if (!prompt || !state.fileId) return;

  state.lastPrompt = prompt;
  beginLoading();

  try {
    const result = await callCropApi(prompt, null);
    handleCropResult(result, prompt);
  } catch (err) {
    handleCropError(err);
  }
}

async function startAdjust() {
  const instruction = dom.adjustInput.value.trim();
  if (!instruction || !state.fileId) return;

  const previousResult = state.lastAIResult
    ? {
        prompt:       state.lastPrompt,
        target:       state.lastAIResult.target,
        bounding_box: state.lastAIResult.boundingBox || state.lastAIResult.bounding_box,
      }
    : null;

  state.lastPrompt = instruction;
  beginLoading();

  try {
    const result = await callCropApi(instruction, previousResult);
    handleCropResult(result, instruction);
  } catch (err) {
    handleCropError(err);
  }
}

async function callCropApi(prompt, previousResult) {
  state.abortController = new AbortController();

  const removeBg = dom.removeBgCheckbox ? dom.removeBgCheckbox.checked : false;

  const res = await fetch(API_BASE + '/api/crop', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fileId: state.fileId, prompt, previousResult, removeBg }),
    signal:  state.abortController.signal,
  });

  const data = await res.json();

  if (!res.ok) {
    throw Object.assign(new Error(data.error || 'Crop failed.'), { status: res.status });
  }

  return data;
}

// ─── Loading Stage ────────────────────────────────────────────────────────────

const LOADING_STEPS = ['analyze', 'locate', 'extract', 'process'];
let loadingInterval = null;

function beginLoading() {
  showStage('loading');
  resetLoadingSteps();

  // Animate steps progressively
  let stepIdx = 0;
  LOADING_STEPS.forEach(s => dom.loadingSteps[s].className = 'loading-step');
  dom.loadingSteps[LOADING_STEPS[0]].classList.add('active');

  loadingInterval = setInterval(() => {
    if (stepIdx < LOADING_STEPS.length - 1) {
      dom.loadingSteps[LOADING_STEPS[stepIdx]].classList.remove('active');
      dom.loadingSteps[LOADING_STEPS[stepIdx]].classList.add('done');
      stepIdx++;
      dom.loadingSteps[LOADING_STEPS[stepIdx]].classList.add('active');
    }
  }, 3500);
}

function resetLoadingSteps() {
  clearInterval(loadingInterval);
  LOADING_STEPS.forEach(s => {
    dom.loadingSteps[s].className = 'loading-step';
  });
}

dom.cancelBtn.addEventListener('click', () => {
  state.abortController?.abort();
  clearInterval(loadingInterval);
  showStage('prompt');
  showToast('Cancelled.', 'info');
});

// ─── Handle Results ───────────────────────────────────────────────────────────

function handleCropResult(data, prompt) {
  clearInterval(loadingInterval);

  // Ambiguous
  if (data.ambiguous) {
    showAmbiguousStage(data, prompt);
    return;
  }

  // Not found
  if (data.found === false) {
    showErrorStage(data.message || "Couldn't find that in the image. Try rephrasing.");
    return;
  }

  // Success
  if (data.success) {
    state.lastAIResult = data;
    state.outputId     = data.outputId;
    showResultStage(data);
    return;
  }

  showErrorStage('Unexpected response from server. Please try again.');
}

function handleCropError(err) {
  clearInterval(loadingInterval);
  if (err.name === 'AbortError') return; // User cancelled
  showErrorStage(err.message || 'Something went wrong. Please try again.');
}

// ─── Ambiguous Stage ──────────────────────────────────────────────────────────

function showAmbiguousStage(data, prompt) {
  dom.ambiguousMessage.textContent = data.message || data.clarification_message || '';
  dom.ambiguousOptions.innerHTML   = '';

  if (data.options && data.options.length > 0) {
    data.options.forEach((opt, i) => {
      const card = document.createElement('div');
      card.className = 'ambiguous-option-btn'; // Reusing the class for styling
      card.style.position = 'relative';
      card.style.cursor = 'pointer';
      
      const canvasId = `ambiguous-thumb-${i}`;
      card.innerHTML = `
        <input type="checkbox" class="ambiguous-checkbox" value="${i}" checked style="position: absolute; top: 12px; left: 12px; z-index: 2; width: 18px; height: 18px; accent-color: #6366f1; cursor: pointer;" aria-label="Select ${sanitize(opt.label)}" />
        <div class="ambiguous-option-thumb-wrapper" style="width:100%; height:100px; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.2); border-radius:6px; margin-bottom:8px; overflow:hidden;">
          <canvas id="${canvasId}" style="max-width:100%; max-height:100%; pointer-events: none;"></canvas>
        </div>
        <div class="ambiguous-option-label">${sanitize(opt.label)}</div>
        <div class="ambiguous-option-desc">${sanitize(opt.description || '')}</div>
        <button type="button" class="btn btn-ghost single-extract-btn" style="width: 100%; margin-top: 12px; padding: 4px; font-size: 0.8rem; border-color: rgba(255,255,255,0.1);">Extract Only This</button>
      `;

      // Handle checkbox toggle on card click
      card.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT' && !e.target.classList.contains('single-extract-btn')) {
          const cb = card.querySelector('.ambiguous-checkbox');
          cb.checked = !cb.checked;
          updateExtractSelectedBtn();
        }
      });
      
      const checkbox = card.querySelector('.ambiguous-checkbox');
      checkbox.addEventListener('change', () => {
        updateExtractSelectedBtn();
      });

      // Handle single extraction
      const singleBtn = card.querySelector('.single-extract-btn');
      singleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const clarifiedPrompt = opt.description
          ? `${prompt} – specifically the ${opt.description}`
          : opt.label;
        dom.promptInput.value = clarifiedPrompt;
        dom.promptInput.dispatchEvent(new Event('input'));
        showStage('prompt');
        startCrop();
      });

      dom.ambiguousOptions.appendChild(card);

      // Draw the thumbnail asynchronously
      setTimeout(() => {
        const canvas = document.getElementById(canvasId);
        if (canvas && opt.bounding_box && opt.bounding_box.width > 0) {
          const ctx = canvas.getContext('2d');
          const bbox = opt.bounding_box;
          canvas.width = bbox.width;
          canvas.height = bbox.height;
          ctx.drawImage(
            dom.previewImage,
            bbox.x, bbox.y, bbox.width, bbox.height,
            0, 0, bbox.width, bbox.height
          );
        }
      }, 0);
    });

    const updateExtractSelectedBtn = () => {
      const selectedCount = document.querySelectorAll('.ambiguous-checkbox:checked').length;
      dom.ambiguousExtractAllBtn.textContent = `Extract Selected (${selectedCount})`;
      dom.ambiguousExtractAllBtn.disabled = selectedCount === 0;
    };

    dom.ambiguousExtractAllBtn.style.display = 'block';
    updateExtractSelectedBtn();
    
    dom.ambiguousExtractAllBtn.onclick = async () => {
      const selectedIndices = Array.from(document.querySelectorAll('.ambiguous-checkbox:checked')).map(cb => parseInt(cb.value));
      const selectedOptions = selectedIndices.map(i => data.options[i]);
      
      if (selectedOptions.length === 0) return;

      dom.ambiguousExtractAllBtn.disabled = true;
      dom.ambiguousExtractAllBtn.classList.add('btn-progress');
      dom.ambiguousExtractAllBtn.style.setProperty('--progress', '0%');
      dom.ambiguousExtractAllBtn.textContent = `Processing (0/${selectedOptions.length})...`;
      
      const results = [];
      try {
        let completed = 0;
        const promises = selectedOptions.map(async (opt) => {
          try {
            const removeBg = dom.removeBgCheckbox ? dom.removeBgCheckbox.checked : false;
            const res = await fetch(API_BASE + '/api/crop-direct', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fileId: state.fileId, boundingBox: opt.bounding_box, removeBg }),
              signal: state.abortController?.signal
            });
            const result = await res.json();
            if (res.ok && result.success && result.outputId) {
               results.push({ ...result, label: opt.label });
            }
          } catch (e) {
            console.error('Extraction failed for', opt.label, e);
          } finally {
            completed++;
            const percent = Math.round((completed / selectedOptions.length) * 100);
            dom.ambiguousExtractAllBtn.style.setProperty('--progress', percent + '%');
            dom.ambiguousExtractAllBtn.textContent = `Processing (${completed}/${selectedOptions.length})...`;
          }
        });
        await Promise.all(promises);
        
        if (results.length > 0) {
          showToast(`Successfully extracted ${results.length} object(s).`, 'success');
          showResultStage(null, results);
        } else {
          showToast('Failed to extract any options.', 'error');
        }
      } catch (err) {
        showToast('Unexpected error during batch extraction: ' + err.message, 'error');
      } finally {
        dom.ambiguousExtractAllBtn.disabled = false;
        dom.ambiguousExtractAllBtn.classList.remove('btn-progress');
        dom.ambiguousExtractAllBtn.style.removeProperty('--progress');
        updateExtractSelectedBtn();
      }
    };
  } else {
    dom.ambiguousExtractAllBtn.style.display = 'none';
  }

  showStage('ambiguous');
}

dom.ambiguousBackBtn.addEventListener('click', () => showStage('prompt'));

// ─── Error Stage ──────────────────────────────────────────────────────────────

function showErrorStage(message) {
  dom.errorMessage.textContent = message;
  showStage('error');
}

dom.errorRetryBtn.addEventListener('click', () => {
  showStage('prompt');
  dom.promptInput.focus();
});

dom.errorStartOverBtn.addEventListener('click', startOver);

// ─── Result Stage ─────────────────────────────────────────────────────────────

function showResultStage(data, multiResults = null) {
  state.currentMultiResults = multiResults;
  if (multiResults) {
    // ── Multi-Result View ──
    dom.resultModeBadge.innerHTML = '🪄 Batch Extract';
    dom.resultMeta.textContent = `${multiResults.length} objects`;
    dom.singleComparisonGrid.style.display = 'none';
    dom.multiResultContainer.style.display = 'block';
    
    // Hide extra panels
    document.getElementById('ai-info-card').style.display = 'none';
    document.getElementById('adjust-panel').style.display = 'none';
    dom.fallbackNotice.setAttribute('hidden', '');
    dom.downloadPngBtn.style.display = 'none';
    dom.downloadJpgBtn.style.display = 'none';

    // Populate grid
    dom.multiResultGrid.innerHTML = '';
    multiResults.forEach((res, i) => {
      const card = document.createElement('div');
      card.style.cssText = 'background: rgba(255,255,255,0.03); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; align-items: center; padding: 12px; border: 1px solid rgba(255,255,255,0.1);';
      
      const img = document.createElement('img');
      img.src = `${res.outputUrl}?t=${Date.now()}`;
      img.className = 'checkerboard';
      img.style.cssText = 'max-width: 100%; max-height: 120px; object-fit: contain; border-radius: 4px; margin-bottom: 12px; cursor: pointer; transition: transform 0.2s;';
      img.onmouseover = () => img.style.transform = 'scale(1.05)';
      img.onmouseout = () => img.style.transform = 'scale(1)';
      img.onclick = () => {
        document.getElementById('modal-img').src = img.src;
        document.getElementById('image-modal').style.display = 'flex';
      };
      
      const lbl = document.createElement('span');
      lbl.textContent = res.label || res.target;
      lbl.style.cssText = 'color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 12px; text-align: center;';
      
      const dlBtn = document.createElement('button');
      dlBtn.className = 'btn btn-secondary';
      dlBtn.style.cssText = 'width: 100%; padding: 6px; font-size: 0.8rem;';
      dlBtn.innerHTML = '⬇️ PNG';
      dlBtn.onclick = () => {
         const a = document.createElement('a');
         a.href = `${API_BASE}/api/download/${res.outputId}/png`;
         a.download = `cropai_${res.target}_${Date.now()}.png`;
         document.body.appendChild(a);
         a.click();
         document.body.removeChild(a);
      };
      
      card.appendChild(img);
      card.appendChild(lbl);
      card.appendChild(dlBtn);
      dom.multiResultGrid.appendChild(card);
    });

    showStage('result');
    setTimeout(() => dom.resultStage?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    return;
  }

  // ── Single Result View ──
  dom.singleComparisonGrid.style.display = 'grid'; // restore grid display
  dom.multiResultContainer.style.display = 'none';
  document.getElementById('ai-info-card').style.display = 'block';
  document.getElementById('adjust-panel').style.display = 'block';
  dom.downloadPngBtn.style.display = 'inline-flex';
  dom.downloadJpgBtn.style.display = 'inline-flex';

  // Mode badge
  const isCrop    = data.mode === 'crop';
  dom.resultModeBadge.innerHTML = isCrop
    ? '✂️ Smart Crop'
    : '🪄 Smart Extract';

  // Output dimensions
  dom.resultMeta.textContent = data.width && data.height
    ? `${data.width} × ${data.height}px`
    : '';

  // Original image (reuse the preview src)
  dom.originalResultImg.src = dom.previewImage.src;
  dom.originalResultImg.alt = 'Original image';

  // Result image
  dom.resultImg.src = `${data.outputUrl}?t=${Date.now()}`; // cache-bust
  dom.resultImg.alt = `Extracted: ${data.target}`;

  // For extractions, show checkerboard
  const resultWrapper = document.getElementById('result-panel-wrapper');
  if (data.mode === 'extract') {
    resultWrapper.classList.add('checkerboard');
  } else {
    resultWrapper.classList.remove('checkerboard');
  }

  // AI info
  dom.aiTarget.textContent     = data.target || '—';
  dom.aiInstruction.textContent = data.instruction || '—';

  if (typeof data.confidence === 'number') {
    const pct = Math.round(data.confidence * 100);
    dom.aiConfidence.textContent  = `${pct}%`;
    dom.confidenceBar.style.width = `${pct}%`;

    // Color the bar based on confidence
    const color = pct >= 80 ? '#10b981' : pct >= 60 ? '#f59e0b' : '#ef4444';
    dom.confidenceBar.style.background = color;
    dom.confidenceBar.style.boxShadow  = `0 0 8px ${color}80`;
  }

  // Segmentation fallback notice
  if (data._segmentationFallback || (data.mode === 'extract' && !data._segmentUsed)) {
    // We detect fallback if mode is extract but there's no mask indicator
    dom.fallbackNotice.removeAttribute('hidden');
  } else {
    dom.fallbackNotice.setAttribute('hidden', '');
  }

  // Draw bounding box overlay on original
  if (data.boundingBox) {
    setupOverlay(data.boundingBox);
  }

  // Pre-fill adjust input with a hint
  dom.adjustInput.value = '';

  showStage('result');

  // Scroll to result
  setTimeout(() => dom.resultStage?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

// ─── Canvas Overlay ───────────────────────────────────────────────────────────

function setupOverlay(bbox) {
  const img    = dom.originalResultImg;
  const canvas = dom.overlayCanvas;

  // Wait for image to be loaded
  const draw = () => {
    const { naturalWidth: nw, naturalHeight: nh } = img;
    const { width: dw, height: dh } = img.getBoundingClientRect();

    if (!nw || !nh || !dw || !dh) return;

    // Scale bounding box to display size
    const scaleX = dw / nw;
    const scaleY = dh / nh;

    canvas.width  = dw;
    canvas.height = dh;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, dw, dh);

    const x = bbox.x * scaleX;
    const y = bbox.y * scaleY;
    const w = bbox.width  * scaleX;
    const h = bbox.height * scaleY;

    // Semi-transparent fill
    ctx.fillStyle   = 'rgba(99, 102, 241, 0.15)';
    ctx.fillRect(x, y, w, h);

    // Animated border
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth   = 2.5;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(x, y, w, h);

    // Corner accents
    const cornerLen = Math.min(16, w * 0.15, h * 0.15);
    ctx.setLineDash([]);
    ctx.strokeStyle = '#818cf8';
    ctx.lineWidth   = 3;
    const corners = [
      [x, y, cornerLen, 0, 0, cornerLen],
      [x+w, y, -cornerLen, 0, 0, cornerLen],
      [x, y+h, cornerLen, 0, 0, -cornerLen],
      [x+w, y+h, -cornerLen, 0, 0, -cornerLen],
    ];
    corners.forEach(([cx, cy, dx1, dy1, dx2, dy2]) => {
      ctx.beginPath();
      ctx.moveTo(cx + dx1, cy + dy1);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + dx2, cy + dy2);
      ctx.stroke();
    });

    // Label
    ctx.font         = 'bold 12px Inter, sans-serif';
    ctx.fillStyle    = '#818cf8';
    ctx.textBaseline = 'bottom';
    const label      = state.lastAIResult?.target || 'Target';
    const labelW     = ctx.measureText(label).width + 12;
    ctx.fillStyle    = 'rgba(8,12,20,0.85)';
    ctx.fillRect(x, Math.max(0, y - 22), labelW, 20);
    ctx.fillStyle    = '#818cf8';
    ctx.fillText(label, x + 6, Math.max(18, y - 4));
  };

  if (img.complete && img.naturalWidth) {
    draw();
  } else {
    img.addEventListener('load', draw, { once: true });
  }

  // Overlay toggle
  state.overlayVisible = false;
  dom.overlayCanvas.classList.remove('visible');
  dom.toggleOverlayBtn.setAttribute('aria-pressed', 'false');
  dom.toggleOverlayBtn.querySelector('.overlay-toggle-btn span:last-child') &&
    (dom.toggleOverlayBtn.lastChild.textContent = ' Show region');
}

dom.toggleOverlayBtn.addEventListener('click', () => {
  state.overlayVisible = !state.overlayVisible;
  dom.overlayCanvas.classList.toggle('visible', state.overlayVisible);
  dom.toggleOverlayBtn.setAttribute('aria-pressed', String(state.overlayVisible));
  // Update button text
  const textNode = Array.from(dom.toggleOverlayBtn.childNodes)
    .find(n => n.nodeType === Node.TEXT_NODE);
  if (textNode) textNode.textContent = state.overlayVisible ? ' Hide region' : ' Show region';
});

// ─── Downloads ────────────────────────────────────────────────────────────────

document.getElementById('download-all-zip-btn')?.addEventListener('click', async () => {
  if (!state.currentMultiResults || state.currentMultiResults.length === 0) return;
  
  const btn = document.getElementById('download-all-zip-btn');
  const originalText = btn.innerHTML;
  btn.innerHTML = '📦 Zipping...';
  btn.disabled = true;

  try {
    const zip = new JSZip();
    
    for (let i = 0; i < state.currentMultiResults.length; i++) {
      const res = state.currentMultiResults[i];
      const url = `${API_BASE}/api/download/${res.outputId}/png`;
      const response = await fetch(url);
      if (response.ok) {
        const blob = await response.blob();
        const filename = `cropai_${(res.label || res.target || 'result').replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${i}.png`;
        zip.file(filename, blob);
      }
    }
    
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const blobUrl = URL.createObjectURL(zipBlob);
    
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `cropai_batch_${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    showToast(`✅ Saved batch zip!`, 'success');
  } catch (err) {
    console.error(err);
    showToast('❌ Failed to create ZIP.', 'error');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
});

dom.downloadPngBtn.addEventListener('click', () => downloadResult('png'));
dom.downloadJpgBtn.addEventListener('click', () => downloadResult('jpg'));

async function downloadResult(format) {
  if (!state.outputId) return;

  const url      = `${API_BASE}/api/download/${state.outputId}/${format}`;
  const filename = `cropai_${state.lastAIResult?.target || 'result'}_${Date.now()}.${format}`;

  try {
    const res  = await fetch(url);
    if (!res.ok) {
      const data = await res.json();
      showToast(`❌ ${data.error || 'Download failed.'}`, 'error');
      return;
    }

    const blob   = await res.blob();
    const blobUrl = URL.createObjectURL(blob);

    const a   = document.createElement('a');
    a.href    = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    showToast(`✅ Saved as ${filename}`, 'success');
  } catch {
    showToast('❌ Download failed. Please try again.', 'error');
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────

dom.tryAnotherBtn.addEventListener('click', () => {
  // Keep the image, clear the prompt and result
  dom.promptInput.value = '';
  dom.promptInput.dispatchEvent(new Event('input'));
  dom.detectionBox.style.display = 'none';
  state.lastAIResult   = null;
  state.outputId       = null;
  state.overlayVisible = false;
  showStage('prompt');
  dom.promptInput.focus();
});

dom.startOverBtnResult.addEventListener('click', startOver);
dom.startOverBtnPrompt.addEventListener('click', startOver);
dom.replaceImageBtn?.addEventListener('click', startOver);

function startOver() {
  state.fileId        = null;
  state.imageWidth    = 0;
  state.imageHeight   = 0;
  state.imageFormat   = '';
  state.imageName     = '';
  state.lastAIResult  = null;
  state.lastPrompt    = '';
  state.outputId      = null;
  state.overlayVisible = false;

  dom.previewImage.src     = '';
  dom.promptInput.value    = '';
  dom.promptInput.disabled = true;
  dom.cropBtn.disabled     = true;
  dom.imageMeta.textContent = '';
  dom.adjustInput.value    = '';
  dom.charCount.textContent = '0 / 500';
  dom.charCount.className   = 'prompt-char-count';
  if (dom.removeBgCheckbox) dom.removeBgCheckbox.checked = false;
  dom.overlayCanvas.classList.remove('visible');
  dom.fallbackNotice.setAttribute('hidden', '');

  showStage('upload');
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Sanitize a string for safe insertion into innerHTML.
 * Strips HTML tags to prevent XSS.
 */
function sanitize(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

checkApiStatus();
showStage('upload');

// ─── Image Preview Modal ──────────────────────────────────────────────────────
document.getElementById('close-modal-btn')?.addEventListener('click', () => {
  document.getElementById('image-modal').style.display = 'none';
});
document.getElementById('image-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'image-modal') {
    document.getElementById('image-modal').style.display = 'none';
  }
});
