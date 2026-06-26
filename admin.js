/* admin.js — admin page logic (no localStorage) */

(async () => {
  let state      = PitMap.defaultState();
  let fileHandle = null;   // File System Access handle for the open pitmap.json
  let dirty      = false;  // unsaved changes
  let selectedIds = new Set();
  let hoverId    = null;
  let placingPit = false;
  let dragState  = null;
  let zoom;

  // Guide image — in-memory only, never saved
  let guide = { img: null, x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.5 };
  let guideDrag = null;

  // Elements (fields + drape lines)
  let selectedElementId = null;
  let hoverElementId    = null;
  let placingElement    = null; // null | 'competition-field' | 'practice-field' | 'drape'
  let drapePoints       = [];   // accumulated corner points during drape placement
  let drapePreview      = null; // { points, cursor } for live preview
  let elementDrag       = null; // { id, part, origEl, startX, startY }

  // ── DOM refs ──────────────────────────────────────────────
  const canvas      = document.getElementById('adminCanvas');
  const scaler      = document.getElementById('adminCanvasScaler');
  const canvasWrap  = document.querySelector('.admin-canvas-wrap');
  const noMap       = document.getElementById('adminNoMap');
  const hint        = document.getElementById('canvasHint');
  const pitListEl   = document.getElementById('pitList');
  const selInfo     = document.getElementById('selectedPitInfo');
  const addBtn      = document.getElementById('addPitMode');
  const cancelBtn   = document.getElementById('cancelAddPit');
  const labelInput  = document.getElementById('newPitLabel');
  const ppfInput    = document.getElementById('pixelsPerFoot');
  const pitPxEl     = document.getElementById('pitPxSize');
  const pitPxEl2    = document.getElementById('pitPxSize2');
  const eventNameEl = document.getElementById('eventName');
  const seasonYearEl= document.getElementById('seasonYear');
  const snapToggle  = document.getElementById('snapToGrid');
  const cropCanvas  = document.getElementById('cropCanvas');
  const cropToolbar = document.getElementById('cropToolbar');
  const cropCtx     = cropCanvas.getContext('2d');
  const saveBtn     = document.getElementById('saveMap');
  const fileLabel   = document.getElementById('fileLabel');

  // ── Dirty / title tracking ────────────────────────────────
  function markDirty() {
    dirty = true;
    updateTitle();
  }
  function markClean() {
    dirty = false;
    updateTitle();
  }
  function updateTitle() {
    const name = fileHandle ? fileHandle.name : 'Unsaved';
    document.title = (dirty ? '● ' : '') + name + ' — Pit Map Admin';
    if (fileLabel) fileLabel.textContent = fileHandle
      ? (dirty ? '● ' : '') + fileHandle.name
      : dirty ? '● Unsaved changes' : 'No file open';
    saveBtn.textContent = fileHandle ? 'Save' : 'Save As…';
  }

  window.addEventListener('beforeunload', e => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ── Init ──────────────────────────────────────────────────
  zoom = new ZoomController({
    scaler, scrollContainer: canvasWrap, canvas,
    labelEl: document.getElementById('zoomLabel'),
  });
  document.getElementById('zoomIn') .addEventListener('click', () => zoom.setZoom(zoom.zoom * 1.2));
  document.getElementById('zoomOut').addEventListener('click', () => zoom.setZoom(zoom.zoom / 1.2));
  document.getElementById('zoomFit').addEventListener('click', () => zoom.fitToContainer());

  resizeCanvas(800, 600);
  syncFormToState();
  renderPitList();
  renderSelectedPanel();
  redraw();
  updateTitle();

  // ── Load state into form fields ───────────────────────────
  function syncFormToState() {
    eventNameEl.value  = state.eventName   || '';
    seasonYearEl.value = state.seasonYear  || 2025;
    ppfInput.value     = state.pixelsPerFoot || 10;
    updatePitSizeDisplay();
    syncPitStyleUI();
  }

  function syncPitStyleUI() {
    const pct = Math.round((state.pitFontScale ?? 1) * 100);
    document.getElementById('pitFontScale').value    = pct;
    document.getElementById('pitFontScaleNum').value = pct;
    document.getElementById('pitTextColor').value    = state.pitTextColor || '#f1f5f9';
    document.getElementById('pitNameColor').value    = state.pitNameColor || '#94a3b8';
  }

  // ── Open file ─────────────────────────────────────────────
  document.getElementById('openFile').addEventListener('click', openMap);

  async function openMap() {
    if (dirty && !confirm('You have unsaved changes. Open a new file anyway?')) return;
    const { state: loaded, handle, error } = await PitMap.openFile();
    if (error === 'cancelled') return;
    if (error) { alert('Could not open file: ' + error); return; }
    state      = loaded;
    fileHandle = handle;
    syncFormToState();
    if (state.floorplanDataUrl) await applyFloorplan(state.floorplanDataUrl, true);
    else { resizeCanvas(800, 600); redraw(); showFloorplanTransformControls(false); }
    PitMap.loadAvatars(state, redraw);
    selectedIds = new Set();
    renderPitList();
    renderSelectedPanel();
    markClean();
  }

  // ── Save / Save As ────────────────────────────────────────
  saveBtn.addEventListener('click', saveMap);

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveMap(); }
    if (e.key === 'Escape') {
      if (placingElement === 'drape' && drapePoints.length >= 2) finishDrape();
      else if (placingElement) exitElementPlace();
      else if (placingPit) exitPlacing();
    }
  });

  async function saveMap() {
    if (fileHandle) {
      try {
        await PitMap.saveToHandle(fileHandle, state);
        markClean();
        showHint('Saved to ' + fileHandle.name);
        setTimeout(hideHint, 2000);
      } catch (err) {
        alert('Save failed: ' + err.message);
      }
    } else {
      const handle = await PitMap.saveAsFile(state);
      if (handle) { fileHandle = handle; markClean(); }
      else markClean(); // download fallback — treat as saved
    }
  }

  // ── New map ───────────────────────────────────────────────
  document.getElementById('clearAll').addEventListener('click', () => {
    if (dirty && !confirm('Discard unsaved changes and start over?')) return;
    state      = PitMap.defaultState();
    fileHandle = null;
    selectedIds = new Set(); selectedElementId = null;
    noMap.style.display = '';
    resizeCanvas(800, 600);
    syncFormToState();
    renderPitList(); renderSelectedPanel(); renderSelectedElementPanel(); redraw();
    markClean();
  });

  // ── Floor plan upload ──────────────────────────────────────
  document.getElementById('floorplanUpload').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    if (file.type === 'application/pdf') await loadPdf(file);
    else {
      const reader = new FileReader();
      reader.onload = async ev => {
        state.floorplanDataUrl = ev.target.result;
        await applyFloorplan(state.floorplanDataUrl);
        markDirty();
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  });

  document.getElementById('clearFloorplan').addEventListener('click', () => {
    if (!confirm('Remove the floor plan image?')) return;
    state.floorplanDataUrl = null;
    state._floorImg = null;
    noMap.style.display = '';
    showFloorplanTransformControls(false);
    resizeCanvas(800, 600);
    markDirty(); redraw();
  });

  async function loadPdf(file) {
    if (!window.pdfjsLib) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    const arrayBuffer = await file.arrayBuffer();
    const pdf  = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);
    const vp   = page.getViewport({ scale: 1.5 });
    const off  = document.createElement('canvas');
    off.width = vp.width; off.height = vp.height;
    await page.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
    state.floorplanDataUrl = off.toDataURL('image/png');
    await applyFloorplan(state.floorplanDataUrl);
    markDirty();
  }

  async function applyFloorplan(dataUrl, keepTransform = false) {
    const img = await PitMap.loadFloorImage(dataUrl);
    if (!img) return;
    state._floorImg = img;
    if (!keepTransform) {
      state.floorplanScale = 1;
      state.floorplanX     = 0;
      state.floorplanY     = 0;
    }
    noMap.style.display = 'none';
    const sc = state.floorplanScale ?? 1;
    const fx = state.floorplanX ?? 0;
    const fy = state.floorplanY ?? 0;
    resizeCanvas(
      Math.max(800, Math.ceil(fx + img.naturalWidth  * sc)),
      Math.max(600, Math.ceil(fy + img.naturalHeight * sc))
    );
    syncFloorplanTransformUI();
    showFloorplanTransformControls(true);
    redraw();
    requestAnimationFrame(() => zoom.fitToContainer());
  }

  function showFloorplanTransformControls(show) {
    const el = document.getElementById('floorplanTransformControls');
    el.style.display = show ? 'flex' : 'none';
    el.style.flexDirection = 'column';
    el.style.gap = '8px';
  }

  function syncFloorplanTransformUI() {
    const pct = Math.round((state.floorplanScale ?? 1) * 100);
    document.getElementById('floorplanScale').value    = pct;
    document.getElementById('floorplanScaleNum').value = pct;
    document.getElementById('floorplanOffsetX').value  = Math.round(state.floorplanX ?? 0);
    document.getElementById('floorplanOffsetY').value  = Math.round(state.floorplanY ?? 0);
  }

  function applyFloorplanTransform() {
    if (!state._floorImg) return;
    const sc = state.floorplanScale ?? 1;
    const fx = state.floorplanX ?? 0;
    const fy = state.floorplanY ?? 0;
    const w  = Math.max(800, Math.ceil(fx + state._floorImg.naturalWidth  * sc));
    const h  = Math.max(600, Math.ceil(fy + state._floorImg.naturalHeight * sc));
    resizeCanvas(w, h);
    markDirty(); redraw();
  }

  // Floor plan transform controls
  document.getElementById('floorplanScale').addEventListener('input', e => {
    state.floorplanScale = Number(e.target.value) / 100;
    document.getElementById('floorplanScaleNum').value = e.target.value;
    applyFloorplanTransform();
  });
  document.getElementById('floorplanScaleNum').addEventListener('input', e => {
    const v = Math.max(10, Math.min(500, Number(e.target.value) || 100));
    state.floorplanScale = v / 100;
    document.getElementById('floorplanScale').value = v;
    applyFloorplanTransform();
  });
  document.getElementById('floorplanOffsetX').addEventListener('input', e => {
    state.floorplanX = Number(e.target.value) || 0; applyFloorplanTransform();
  });
  document.getElementById('floorplanOffsetY').addEventListener('input', e => {
    state.floorplanY = Number(e.target.value) || 0; applyFloorplanTransform();
  });
  document.getElementById('floorplanResetTransform').addEventListener('click', () => {
    state.floorplanScale = 1; state.floorplanX = 0; state.floorplanY = 0;
    syncFloorplanTransformUI(); applyFloorplanTransform();
  });

  function resizeCanvas(w, h) {
    canvas.width = w; canvas.height = h;
    cropCanvas.width = w; cropCanvas.height = h;
    canvas.parentElement.style.width  = w + 'px';
    canvas.parentElement.style.height = h + 'px';
  }

  // ── Elements ──────────────────────────────────────────────
  const cancelElementBtn = document.getElementById('cancelElementPlace');

  function startElementPlace(type) {
    placingElement = type;
    drapeStart = null; drapePreview = null;
    cancelElementBtn.classList.remove('hidden');
    showHint(type === 'drape' ? 'Click to set start of drape line' : 'Click on map to place');
    canvas.style.cursor = 'crosshair';
  }

  function exitElementPlace() {
    placingElement = null; drapePoints = []; drapePreview = null;
    cancelElementBtn.classList.add('hidden');
    hideHint(); canvas.style.cursor = 'default'; redraw();
  }

  function finishDrape() {
    if (drapePoints.length < 2) { exitElementPlace(); return; }
    const id = PitMap.addElement(state, 'drape', { points: drapePoints.map(p => ({...p})), label: '' });
    setElementSelection(id); exitElementPlace(); markDirty(); redraw();
  }

  document.getElementById('addCompField') .addEventListener('click', () => startElementPlace('competition-field'));
  document.getElementById('addPractField').addEventListener('click', () => startElementPlace('practice-field'));
  document.getElementById('addDrapeLine') .addEventListener('click', () => startElementPlace('drape'));
  cancelElementBtn.addEventListener('click', exitElementPlace);

  function setElementSelection(id) {
    selectedElementId = id;
    if (id) setSelection([]); // clear pit selection
    renderSelectedElementPanel();
  }

  function renderSelectedElementPanel() {
    const infoEl = document.getElementById('selectedElementInfo');
    if (!selectedElementId) { infoEl.innerHTML = ''; return; }
    const el = (state.elements || []).find(e => e.id === selectedElementId);
    if (!el) { infoEl.innerHTML = ''; return; }
    const isField = el.type === 'competition-field' || el.type === 'practice-field';
    const typeName = el.type === 'competition-field' ? 'Competition Field'
                   : el.type === 'practice-field'    ? 'Practice Field'
                   :                                   'Pipe & Drape Line';
    infoEl.innerHTML = `
      <hr class="divider" style="margin-top:4px">
      <p class="hint" style="color:var(--text);font-weight:600">${typeName}</p>
      <label>Label<input type="text" id="elLabel" value="${esc(el.label || '')}" placeholder="${isField ? 'e.g. Field 1' : 'e.g. North wall'}" /></label>
      ${isField ? `
        <label>Width (px)<input type="number" id="elW" value="${Math.round(el.w)}" /></label>
        <label>Height (px)<input type="number" id="elH" value="${Math.round(el.h)}" /></label>
        <label>Font Size (px)<input type="number" id="elFontSize" value="${el.fontSize ?? ''}" placeholder="Auto" /></label>
        <div style="display:flex;gap:8px;align-items:center">
          <label style="flex-direction:row;align-items:center;gap:6px">
            <span class="hint">Label color</span>
            <input type="color" id="elTextColor" value="${el.textColor || '#f1f5f9'}" style="width:36px;height:28px;padding:2px;border:none;background:none;cursor:pointer" />
          </label>
        </div>
        <button id="elSnapGrid" class="btn-secondary full-width">Snap to Grid</button>
        <button id="elSetOrigin" class="btn-secondary full-width">Set as Grid Origin</button>
        <p class="hint" id="elOriginStatus">${state.gridOriginX != null ? `Origin: (${state.gridOriginX}, ${state.gridOriginY})` : 'No origin set'}</p>
      ` : ''}
      <button id="deleteElement" class="btn-danger full-width" style="margin-top:4px">Delete</button>
      <p class="hint">Press Delete key to remove selected element.</p>
    `;
    document.getElementById('elLabel').addEventListener('input', e => {
      PitMap.updateElement(state, selectedElementId, { label: e.target.value }); markDirty(); redraw();
    });
    if (isField) {
      document.getElementById('elW').addEventListener('input', e => {
        PitMap.updateElement(state, selectedElementId, { w: Math.max(10, Number(e.target.value)||10) }); markDirty(); redraw();
      });
      document.getElementById('elH').addEventListener('input', e => {
        PitMap.updateElement(state, selectedElementId, { h: Math.max(10, Number(e.target.value)||10) }); markDirty(); redraw();
      });
      document.getElementById('elFontSize').addEventListener('input', e => {
        const v = Number(e.target.value);
        PitMap.updateElement(state, selectedElementId, { fontSize: v > 0 ? v : undefined }); markDirty(); redraw();
      });
      document.getElementById('elTextColor').addEventListener('input', e => {
        PitMap.updateElement(state, selectedElementId, { textColor: e.target.value }); markDirty(); redraw();
      });
      document.getElementById('elSnapGrid').addEventListener('click', () => {
        const snapped = snapPos(el.x, el.y);
        PitMap.updateElement(state, selectedElementId, snapped);
        markDirty(); redraw(); renderSelectedElementPanel();
      });
      document.getElementById('elSetOrigin').addEventListener('click', () => {
        state.gridOriginX = el.x; state.gridOriginY = el.y; markDirty();
        document.getElementById('elOriginStatus').textContent = `Origin: (${Math.round(el.x)}, ${Math.round(el.y)})`;
        showHint('Grid origin set to field position'); setTimeout(hideHint, 2000);
      });
    }
    document.getElementById('deleteElement').addEventListener('click', deleteSelectedElement);
  }

  function deleteSelectedElement() {
    if (!selectedElementId) return;
    PitMap.removeElement(state, selectedElementId);
    setElementSelection(null); markDirty(); redraw();
  }

  // Delete key removes selected element (or selected pits)
  document.addEventListener('keydown', e => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // Don't intercept when typing in an input/textarea
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      if (selectedElementId) { deleteSelectedElement(); return; }
      if (selectedIds.size) {
        state.pits.filter(p => selectedIds.has(p.id)).forEach(p => PitMap.removePit(state, p.id));
        setSelection([]); markDirty(); renderPitList(); redraw();
      }
    }
  });

  // ── Guide image ───────────────────────────────────────────
  const guideControls = document.getElementById('guideControls');

  function showGuideControls(show) {
    guideControls.style.display = show ? 'flex' : 'none';
    guideControls.style.flexDirection = 'column';
    guideControls.style.gap = '8px';
  }

  function syncGuideSliders() {
    document.getElementById('guideOpacity').value   = Math.round(guide.opacity * 100);
    document.getElementById('guideScale').value     = Math.round(guide.scale   * 100);
    document.getElementById('guideRotation').value  = guide.rotation;
    document.getElementById('guideRotationNum').value = guide.rotation;
  }

  document.getElementById('guideUpload').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    e.target.value = '';
    let dataUrl;
    if (file.type === 'application/pdf') {
      if (!window.pdfjsLib) {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      }
      const pdf  = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const page = await pdf.getPage(1);
      const vp   = page.getViewport({ scale: 1.5 });
      const off  = document.createElement('canvas');
      off.width = vp.width; off.height = vp.height;
      await page.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
      dataUrl = off.toDataURL('image/png');
    } else {
      dataUrl = await new Promise(res => {
        const r = new FileReader(); r.onload = ev => res(ev.target.result); r.readAsDataURL(file);
      });
    }
    const img = await PitMap.loadFloorImage(dataUrl);
    if (!img) return;
    guide.img = img;
    // Centre guide on canvas by default
    guide.x = canvas.width  / 2;
    guide.y = canvas.height / 2;
    guide.scale    = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
    guide.rotation = 0;
    guide.opacity  = 0.5;
    syncGuideSliders();
    showGuideControls(true);
    redraw();
  });

  document.getElementById('guideOpacity').addEventListener('input', e => {
    guide.opacity = Number(e.target.value) / 100; redraw();
  });
  document.getElementById('guideScale').addEventListener('input', e => {
    guide.scale = Number(e.target.value) / 100; redraw();
  });
  document.getElementById('guideRotation').addEventListener('input', e => {
    guide.rotation = Number(e.target.value);
    document.getElementById('guideRotationNum').value = guide.rotation;
    redraw();
  });
  document.getElementById('guideRotationNum').addEventListener('input', e => {
    const v = Math.max(-180, Math.min(180, Number(e.target.value) || 0));
    guide.rotation = v;
    document.getElementById('guideRotation').value = v;
    redraw();
  });
  document.getElementById('clearGuide').addEventListener('click', () => {
    guide.img = null; showGuideControls(false); redraw();
  });

  // Drag guide on canvas: middle-mouse or when no pit is under cursor and guide is active
  // We piggyback on the existing canvas mousedown/move/up using a guideDrag flag.

  // ── Crop tool ─────────────────────────────────────────────
  let cropping = false;
  let cropRect = null;
  let cropDrag = null;
  const HANDLE_SIZE = 10;

  document.getElementById('cropFloorplan').addEventListener('click', () => {
    if (!state.floorplanDataUrl) return;
    cropping = true;
    cropCanvas.classList.add('active');
    cropToolbar.classList.add('active');
    cropRect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
    drawCropOverlay();
  });
  document.getElementById('cropCancel').addEventListener('click', exitCrop);
  document.getElementById('cropApply').addEventListener('click', applyCrop);

  function exitCrop() {
    cropping = false; cropRect = null; cropDrag = null;
    cropCanvas.classList.remove('active');
    cropToolbar.classList.remove('active');
    cropCtx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
  }

  async function applyCrop() {
    if (!cropRect || !state._floorImg) return;
    const { x, y, w, h } = normalizedCropRect();
    if (w < 2 || h < 2) return;
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    off.getContext('2d').drawImage(state._floorImg, x, y, w, h, 0, 0, w, h);
    state.floorplanDataUrl = off.toDataURL('image/png');
    await applyFloorplan(state.floorplanDataUrl);
    markDirty(); exitCrop();
  }

  function normalizedCropRect() {
    const { x, y, w, h } = cropRect;
    return {
      x: Math.round(Math.max(0, w < 0 ? x + w : x)),
      y: Math.round(Math.max(0, h < 0 ? y + h : y)),
      w: Math.round(Math.min(canvas.width,  Math.abs(w))),
      h: Math.round(Math.min(canvas.height, Math.abs(h))),
    };
  }

  function drawCropOverlay() {
    const cw = cropCanvas.width, ch = cropCanvas.height;
    cropCtx.clearRect(0, 0, cw, ch);
    const r = normalizedCropRect();
    cropCtx.fillStyle = 'rgba(0,0,0,0.55)';
    cropCtx.fillRect(0, 0, cw, ch);
    cropCtx.clearRect(r.x, r.y, r.w, r.h);
    cropCtx.strokeStyle = '#fff'; cropCtx.lineWidth = 1.5;
    cropCtx.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);
    cropCtx.strokeStyle = 'rgba(255,255,255,0.25)'; cropCtx.lineWidth = 0.5;
    for (let i = 1; i < 3; i++) {
      const gx = r.x + r.w / 3 * i, gy = r.y + r.h / 3 * i;
      cropCtx.beginPath(); cropCtx.moveTo(gx, r.y); cropCtx.lineTo(gx, r.y + r.h); cropCtx.stroke();
      cropCtx.beginPath(); cropCtx.moveTo(r.x, gy); cropCtx.lineTo(r.x + r.w, gy); cropCtx.stroke();
    }
    for (const [hx, hy] of cropHandlePositions(r)) {
      cropCtx.fillStyle = '#fff';
      cropCtx.fillRect(hx - HANDLE_SIZE/2, hy - HANDLE_SIZE/2, HANDLE_SIZE, HANDLE_SIZE);
      cropCtx.strokeStyle = '#334155'; cropCtx.lineWidth = 1;
      cropCtx.strokeRect(hx - HANDLE_SIZE/2, hy - HANDLE_SIZE/2, HANDLE_SIZE, HANDLE_SIZE);
    }
    cropCtx.fillStyle = 'rgba(0,0,0,0.6)';
    cropCtx.fillRect(r.x, r.y - 20, 80, 18);
    cropCtx.fillStyle = '#fff';
    cropCtx.font = '11px "Segoe UI",system-ui,sans-serif';
    cropCtx.fillText(`${r.w} × ${r.h}`, r.x + 4, r.y - 6);
  }

  function cropHandlePositions(r) {
    const mx = r.x + r.w/2, my = r.y + r.h/2;
    return [[r.x,mx,r.x+r.w,r.x,r.x+r.w,r.x,mx,r.x+r.w],
            [r.y,r.y,r.y,my,my,r.y+r.h,r.y+r.h,r.y+r.h]].reduce((a,_,i,arr)=>
      i < 8 ? [...a, [arr[0][i], arr[1][i]]] : a, []);
  }

  function cropHandleAt(cx, cy, r) {
    const keys = ['TL','TM','TR','ML','MR','BL','BM','BR'];
    return cropHandlePositions(r).reduce((found, [hx,hy], i) =>
      found ?? (Math.abs(cx-hx) <= HANDLE_SIZE && Math.abs(cy-hy) <= HANDLE_SIZE ? keys[i] : null), null);
  }

  function cropCursorFor(h) {
    return ({TL:'nwse-resize',TR:'nesw-resize',BL:'nesw-resize',BR:'nwse-resize',
             TM:'ns-resize',BM:'ns-resize',ML:'ew-resize',MR:'ew-resize'})[h] || 'move';
  }

  cropCanvas.addEventListener('mousedown', e => {
    if (!cropping) return;
    const {x, y} = cropXY(e);
    const r = normalizedCropRect();
    const h = cropHandleAt(x, y, r);
    if (h) cropDrag = { handle: h, startX: x, startY: y, origRect: {...r} };
    else if (x>=r.x && x<=r.x+r.w && y>=r.y && y<=r.y+r.h) cropDrag = { handle:'move', startX:x, startY:y, origRect:{...r} };
    else { cropRect = {x, y, w:0, h:0}; cropDrag = { handle:'new', startX:x, startY:y }; }
  });

  cropCanvas.addEventListener('mousemove', e => {
    if (!cropping) return;
    const {x, y} = cropXY(e);
    if (!cropDrag) {
      if (cropRect) {
        const r = normalizedCropRect();
        const h = cropHandleAt(x, y, r);
        cropCanvas.style.cursor = h ? cropCursorFor(h)
          : (x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h) ? 'move' : 'crosshair';
      }
      return;
    }
    const {handle, startX, startY, origRect:o} = cropDrag;
    const dx = x-startX, dy = y-startY;
    if      (handle==='new')  cropRect = {x:startX, y:startY, w:x-startX, h:y-startY};
    else if (handle==='move') cropRect = {x:clamp(o.x+dx,0,canvas.width-o.w), y:clamp(o.y+dy,0,canvas.height-o.h), w:o.w, h:o.h};
    else {
      let {x:rx,y:ry,w:rw,h:rh} = o;
      if (handle.includes('T')) { ry+=dy; rh-=dy; }
      if (handle.includes('B')) rh+=dy;
      if (handle.includes('L')) { rx+=dx; rw-=dx; }
      if (handle.includes('R')) rw+=dx;
      cropRect = {x:rx, y:ry, w:rw, h:rh};
    }
    drawCropOverlay();
  });

  cropCanvas.addEventListener('mouseup', () => { cropDrag = null; drawCropOverlay(); });
  cropCanvas.addEventListener('mouseleave', () => { cropDrag = null; });
  function cropXY(e) { const r=cropCanvas.getBoundingClientRect(); return {x:(e.clientX-r.left)/zoom.zoom, y:(e.clientY-r.top)/zoom.zoom}; }
  function clamp(v,lo,hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── Settings ───────────────────────────────────────────────
  ppfInput.addEventListener('input', () => {
    state.pixelsPerFoot = Math.max(1, Number(ppfInput.value) || 10);
    updatePitSizeDisplay(); markDirty(); redraw();
  });
  eventNameEl.addEventListener('input',  () => { state.eventName  = eventNameEl.value;            markDirty(); });
  seasonYearEl.addEventListener('input', () => { state.seasonYear = Number(seasonYearEl.value);   markDirty(); });

  function updatePitSizeDisplay() {
    const ps = PitMap.pitSize(state);
    pitPxEl.textContent = ps; pitPxEl2.textContent = ps;
  }

  // Pit style controls
  document.getElementById('pitFontScale').addEventListener('input', e => {
    state.pitFontScale = Number(e.target.value) / 100;
    document.getElementById('pitFontScaleNum').value = e.target.value;
    markDirty(); redraw();
  });
  document.getElementById('pitFontScaleNum').addEventListener('input', e => {
    const v = Math.max(50, Math.min(200, Number(e.target.value) || 100));
    state.pitFontScale = v / 100;
    document.getElementById('pitFontScale').value = v;
    markDirty(); redraw();
  });
  document.getElementById('pitTextColor').addEventListener('input', e => {
    state.pitTextColor = e.target.value; markDirty(); redraw();
  });
  document.getElementById('pitNameColor').addEventListener('input', e => {
    state.pitNameColor = e.target.value; markDirty(); redraw();
  });
  document.getElementById('resetPitStyle').addEventListener('click', () => {
    state.pitFontScale = 1; state.pitTextColor = '#f1f5f9'; state.pitNameColor = '#94a3b8';
    syncPitStyleUI(); markDirty(); redraw();
  });

  // ── Import teams from FTC Scout ────────────────────────────
  document.getElementById('importTeamsBtn').addEventListener('click', async () => {
    const season   = document.getElementById('importSeason').value.trim();
    const code     = document.getElementById('importEventCode').value.trim().toUpperCase();
    const statusEl = document.getElementById('importStatus');
    if (!season || !code) { statusEl.textContent = 'Enter a season and event code.'; return; }
    statusEl.textContent = 'Fetching teams…';
    try {
      const res = await fetch(`https://api.ftcscout.org/rest/v1/events/${season}/${code}/teams`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const teams = await res.json();
      if (!Array.isArray(teams) || !teams.length) { statusEl.textContent = 'No teams found.'; return; }
      const details = await Promise.allSettled(
        teams.map(t => fetch(`https://api.ftcscout.org/rest/v1/teams/${t.teamNumber}`).then(r => r.ok ? r.json() : null))
      );
      const created = placePits(teams.map((t,i) => ({
        teamNumber: String(t.teamNumber),
        teamName: details[i].value?.name || details[i].value?.teamName || '',
      })));
      if (created === 0) { statusEl.textContent = `All teams already have pits.`; return; }
      statusEl.textContent = `Created ${created} pits. Drag to position.`;
      if (state.seasonYear !== Number(season)) { state.seasonYear = Number(season); seasonYearEl.value = season; }
      markDirty(); renderPitList(); redraw();
    } catch (err) { statusEl.textContent = 'Error: ' + err.message; }
  });

  // ── Import pasted teams ────────────────────────────────────
  document.getElementById('pasteImportBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('importStatus');
    const raw = document.getElementById('pasteTeamNumbers').value;
    const teamNums = [...new Set(raw.split(/[\s,;|\n]+/).map(s=>s.trim()).filter(s=>/^\d+$/.test(s)))];
    if (!teamNums.length) { statusEl.textContent = 'No valid team numbers found.'; return; }
    statusEl.textContent = `Looking up ${teamNums.length} teams…`;
    const season = Number(document.getElementById('importSeason').value) || state.seasonYear || 2025;
    const details = await Promise.allSettled(
      teamNums.map(n => fetch(`https://api.ftcscout.org/rest/v1/teams/${n}`).then(r => r.ok ? r.json() : null))
    );
    const created = placePits(teamNums.map((n,i) => ({
      teamNumber: n,
      teamName: details[i].value?.name || details[i].value?.teamName || '',
    })));
    if (created === 0) { statusEl.textContent = `All teams already have pits.`; return; }
    statusEl.textContent = `Created ${created} pits from ${teamNums.length} team numbers.`;
    state.seasonYear = season; seasonYearEl.value = season;
    markDirty(); renderPitList(); redraw();
  });

  // ── Avatar fetching ───────────────────────────────────────
  let _avatarCssCache = null; // { season, map: { teamNumber: url } }

  async function loadAvatarCss(season) {
    if (_avatarCssCache?.season === season) return _avatarCssCache.map;
    const cssUrl = `https://ftc-scoring.firstinspires.org/avatars/composed/${season}.css`;
    let css = null;
    try {
      const r = await fetch(cssUrl);
      if (r.ok) css = await r.text();
    } catch {}
    if (!css) return null;
    const map = {};
    const re = /\.team-(\d+)[^{]*\{[^}]*background(?:-image)?\s*:\s*url\(['"]?([^'")\s]+)['"]?\)/gi;
    let m;
    while ((m = re.exec(css)) !== null) map[m[1]] = resolveUrl(m[2]);
    _avatarCssCache = { season, map };
    return map;
  }

  function resolveUrl(url) {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) return 'https://ftc-scoring.firstinspires.org' + url;
    return url;
  }

  document.getElementById('fetchAvatarsBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('avatarStatus');
    const season = state.seasonYear || 2025;
    statusEl.textContent = `Loading avatar CSS for season ${season}…`;
    const map = await loadAvatarCss(season);
    if (!map) { statusEl.textContent = 'Could not load avatar CSS — check season year and connection.'; return; }
    const total = Object.keys(map).length;
    statusEl.textContent = `CSS loaded (${total} teams). Applying to pits…`;
    let applied = 0;
    for (const pit of state.pits) {
      if (pit.teamNumber && map[pit.teamNumber]) {
        pit.avatarUrl = map[pit.teamNumber]; applied++;
      }
    }
    PitMap.loadAvatars(state, redraw);
    markDirty(); redraw();
    statusEl.textContent = applied
      ? `Applied avatars to ${applied} pit${applied !== 1 ? 's' : ''}.`
      : `CSS loaded but no matching teams found. Check season year (currently ${season}).`;
  });

  function placePits(teams) {
    const ps = PitMap.pitSize(state);
    let created = 0;
    for (const { teamNumber, teamName } of teams) {
      if (state.pits.some(p => p.teamNumber === teamNumber)) continue;
      const col = created % 8, row = Math.floor(created / 8);
      const id  = Date.now().toString(36) + Math.random().toString(36).slice(2,5);
      state.pits.push({ id, x: 20 + col*(ps+4), y: 20 + row*(ps+4), label:'', teamNumber, teamName });
      created++;
    }
    return created;
  }

  // ── Place pit ──────────────────────────────────────────────
  addBtn.addEventListener('click', () => {
    placingPit = true; addBtn.classList.add('hidden'); cancelBtn.classList.remove('hidden');
    showHint('Click on the map to place a pit'); canvas.style.cursor = 'crosshair';
  });
  cancelBtn.addEventListener('click', exitPlacing);

  function exitPlacing() {
    placingPit = false; addBtn.classList.remove('hidden'); cancelBtn.classList.add('hidden');
    hideHint(); canvas.style.cursor = 'default';
  }

  // ── Canvas mouse ──────────────────────────────────────────
  canvas.addEventListener('mousedown', e => {
    const {x, y} = zoom.canvasXY(e);

    // ── Placing pit ──
    if (placingPit) {
      const s = snapPos(x, y);
      const id = PitMap.addPit(state, s.x, s.y, labelInput.value.trim());
      labelInput.value = ''; exitPlacing(); setSelection([id]);
      markDirty(); renderPitList(); redraw(); return;
    }

    // ── Placing element ──
    if (placingElement) {
      if (placingElement === 'drape') {
        drapePoints.push({ x, y });
        drapePreview = { points: [...drapePoints], cursor: { x, y } };
        if (drapePoints.length === 1) showHint('Click to add corners — double-click or Escape to finish');
        redraw(); return;
      } else {
        const ps = PitMap.pitSize(state);
        const fw = ps * 1.2, fh = ps * 1.2;
        const id = PitMap.addElement(state, placingElement, { x: x - fw/2, y: y - fh/2, w: fw, h: fh, label: '' });
        setElementSelection(id); exitElementPlace(); markDirty(); redraw();
      }
      return;
    }

    // ── Selecting / dragging element ──
    const hit = PitMap.elementAt(state, x, y);
    if (hit) {
      const { element: el, part } = hit;
      setElementSelection(el.id);
      elementDrag = { id: el.id, part, startX: x, startY: y,
        origEl: { ...el, points: el.points ? el.points.map(p => ({...p})) : undefined } };
      canvas.style.cursor = part === 'body' ? 'grabbing' : 'crosshair';
      redraw(); return;
    }

    // ── Selecting / dragging pit ──
    const pit = PitMap.pitAt(state, x, y);
    if (pit) {
      if (e.shiftKey) { selectedIds.has(pit.id) ? selectedIds.delete(pit.id) : selectedIds.add(pit.id); }
      else if (!selectedIds.has(pit.id)) { setSelection([pit.id]); setElementSelection(null); }
      const sel = state.pits.filter(p => selectedIds.has(p.id));
      dragState = { ids: sel.map(p=>p.id), offsets: sel.map(p=>({dx:p.x-x, dy:p.y-y})) };
    } else {
      if (!e.shiftKey) { setSelection([]); setElementSelection(null); }
      if (guide.img && !e.shiftKey) {
        guideDrag = { startX: x, startY: y, origX: guide.x, origY: guide.y };
      }
    }
    renderSelectedPanel(); renderPitList(); redraw();
  });

  canvas.addEventListener('mousemove', e => {
    const {x, y} = zoom.canvasXY(e);

    // Drape preview
    if (placingElement === 'drape' && drapePoints.length > 0) {
      drapePreview = { points: drapePoints, cursor: { x, y } };
      redraw(); return;
    }

    if (dragState) {
      dragState.ids.forEach((id,i) => {
        const raw = { x: x+dragState.offsets[i].dx, y: y+dragState.offsets[i].dy };
        PitMap.updatePit(state, id, snapToggle.checked ? snapPos(raw.x,raw.y) : raw);
      });
      redraw(); return;
    }

    if (elementDrag) {
      const { id, part, startX, startY, origEl: o } = elementDrag;
      const dx = x - startX, dy = y - startY;
      const isField = o.type === 'competition-field' || o.type === 'practice-field';
      if (part === 'body') {
        if (o.points) {
          PitMap.updateElement(state, id, { points: o.points.map(p => ({x: p.x+dx, y: p.y+dy})) });
        } else {
          const raw = { x: o.x + dx, y: o.y + dy };
          const pos  = (isField && snapToggle.checked) ? snapPos(raw.x, raw.y) : raw;
          PitMap.updateElement(state, id, { ...pos });
        }
      } else if (part.startsWith('ep')) {
        const idx = Number(part.slice(2));
        if (o.points) {
          PitMap.updateElement(state, id, { points: o.points.map((p,i) => i===idx ? {x:p.x+dx,y:p.y+dy} : {...p}) });
        }
      }
      redraw(); return;
    }

    if (guideDrag) {
      guide.x = guideDrag.origX + (x - guideDrag.startX);
      guide.y = guideDrag.origY + (y - guideDrag.startY);
      redraw(); return;
    }

    // Hover detection
    const hitEl = PitMap.elementAt(state, x, y);
    const newHoverEl = hitEl ? hitEl.element.id : null;
    const pit = hitEl ? null : PitMap.pitAt(state, x, y);
    const nh  = pit ? pit.id : null;
    if (newHoverEl !== hoverElementId || nh !== hoverId) {
      hoverElementId = newHoverEl; hoverId = nh; redraw();
    }
    if (placingPit || placingElement) { canvas.style.cursor = 'crosshair'; return; }
    canvas.style.cursor = hitEl
      ? (hitEl.part === 'body' ? 'grab' : 'crosshair')
      : pit ? 'grab'
      : guide.img ? 'move' : 'default';
  });

  canvas.addEventListener('mouseup', () => {
    if (dragState) { markDirty(); dragState = null; }
    if (elementDrag) { markDirty(); elementDrag = null; renderSelectedElementPanel(); }
    guideDrag = null;
  });

  canvas.addEventListener('dblclick', () => {
    if (placingElement === 'drape' && drapePoints.length >= 2) {
      drapePoints.pop(); // remove duplicate added by second click of dblclick
      finishDrape();
    }
  });
  canvas.addEventListener('mouseleave', () => {
    if (dragState) { markDirty(); dragState = null; }
    if (elementDrag) { markDirty(); elementDrag = null; }
    guideDrag = null; hoverId = null; hoverElementId = null; redraw();
  });

  // Ctrl+scroll on canvas scales the guide (when guide is loaded and no pit drag is active)
  canvasWrap.addEventListener('wheel', e => {
    if (!guide.img || !e.ctrlKey) return;
    // ZoomController also handles ctrl+scroll — let it run first, then also scale guide
    const delta = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    guide.scale = Math.max(0.05, Math.min(10, guide.scale * delta));
    document.getElementById('guideScale').value = Math.round(guide.scale * 100);
    redraw();
  }, { passive: true });

  function snapPos(x, y) {
    const ps   = PitMap.pitSize(state);
    const half = ps / 2;
    const ox   = (state.gridOriginX ?? 0) % half;
    const oy   = (state.gridOriginY ?? 0) % half;
    return { x: Math.round((x-ox)/half)*half+ox, y: Math.round((y-oy)/half)*half+oy };
  }

  // ── Selection ─────────────────────────────────────────────
  function setSelection(ids) { selectedIds = new Set(ids); renderSelectedPanel(); renderPitList(); }

  // ── Align & Arrange ───────────────────────────────────────
  document.querySelectorAll('.align-btn').forEach(btn => btn.addEventListener('click', () => doAlign(btn.dataset.align)));
  document.getElementById('autoArrangeBtn').addEventListener('click', doAutoArrange);

  function getTargetPits() {
    const sel = state.pits.filter(p => selectedIds.has(p.id));
    return sel.length >= 2 ? sel : state.pits;
  }

  function doAlign(type) {
    const targets = getTargetPits(); if (!targets.length) return;
    const ps = PitMap.pitSize(state);
    if (type === 'snapGrid') {
      state.pits.forEach(p => PitMap.updatePit(state, p.id, snapPos(p.x, p.y)));
      markDirty(); redraw(); return;
    }
    const xs = targets.map(p=>p.x), ys = targets.map(p=>p.y);
    const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
    switch (type) {
      case 'left':    targets.forEach(p=>PitMap.updatePit(state,p.id,{x:minX})); break;
      case 'right':   targets.forEach(p=>PitMap.updatePit(state,p.id,{x:maxX})); break;
      case 'top':     targets.forEach(p=>PitMap.updatePit(state,p.id,{y:minY})); break;
      case 'bottom':  targets.forEach(p=>PitMap.updatePit(state,p.id,{y:maxY})); break;
      case 'centerH': { const cx=(minX+maxX+ps)/2; targets.forEach(p=>PitMap.updatePit(state,p.id,{x:Math.round(cx-ps/2)})); break; }
      case 'centerV': { const cy=(minY+maxY+ps)/2; targets.forEach(p=>PitMap.updatePit(state,p.id,{y:Math.round(cy-ps/2)})); break; }
      case 'distH': { if(targets.length<3)break; const s=[...targets].sort((a,b)=>a.x-b.x); const step=(s[s.length-1].x-s[0].x)/(s.length-1); s.forEach((p,i)=>PitMap.updatePit(state,p.id,{x:Math.round(s[0].x+i*step)})); break; }
      case 'distV': { if(targets.length<3)break; const s=[...targets].sort((a,b)=>a.y-b.y); const step=(s[s.length-1].y-s[0].y)/(s.length-1); s.forEach((p,i)=>PitMap.updatePit(state,p.id,{y:Math.round(s[0].y+i*step)})); break; }
      case 'stackH': { const s=[...targets].sort((a,b)=>a.x-b.x); const sy=Math.min(...s.map(p=>p.y)); let cx=s[0].x; s.forEach(p=>{PitMap.updatePit(state,p.id,{x:cx,y:sy});cx+=ps;}); break; }
      case 'stackV': { const s=[...targets].sort((a,b)=>a.y-b.y); const sx=Math.min(...s.map(p=>p.x)); let cy=s[0].y; s.forEach(p=>{PitMap.updatePit(state,p.id,{x:sx,y:cy});cy+=ps;}); break; }
    }
    markDirty(); redraw();
  }

  function doAutoArrange() {
    const targets = getTargetPits(); if (!targets.length) return;
    const ps   = PitMap.pitSize(state);
    const startX = targets.length===state.pits.length ? 20 : Math.min(...targets.map(p=>p.x));
    const startY = targets.length===state.pits.length ? 20 : Math.min(...targets.map(p=>p.y));
    const cols   = Math.max(1, Math.ceil(Math.sqrt(targets.length)));
    targets.forEach((p,i) => PitMap.updatePit(state, p.id, { x: startX+(i%cols)*(ps+4), y: startY+Math.floor(i/cols)*(ps+4) }));
    markDirty(); redraw();
  }

  // ── Selected pit panel ────────────────────────────────────
  function renderSelectedPanel() {
    const selArr = state.pits.filter(p => selectedIds.has(p.id));
    if (!selArr.length) {
      selInfo.innerHTML = '<p class="hint">Click a pit on the map to select it. Shift+click to multi-select.</p>'; return;
    }
    if (selArr.length > 1) {
      selInfo.innerHTML = `<p class="hint">${selArr.length} pits selected.</p>
        <button id="deleteSelected" class="btn-danger full-width">Delete Selected</button>`;
      document.getElementById('deleteSelected').addEventListener('click', () => {
        selArr.forEach(p=>PitMap.removePit(state,p.id)); setSelection([]);
        markDirty(); renderPitList(); redraw();
      }); return;
    }
    const pit = selArr[0];
    selInfo.innerHTML = `
      <label>Pit Label<input type="text" id="editLabel" value="${esc(pit.label)}" placeholder="e.g. A1" /></label>
      <label>Team Number<input type="text" id="editTeamNum" value="${esc(pit.teamNumber)}" placeholder="e.g. 12345" /></label>
      <label>Team Name<input type="text" id="editTeamName" value="${esc(pit.teamName)}" placeholder="Auto-fills from Lookup" /></label>
      <div class="pit-editor-row">
        <button id="lookupTeam" class="btn-secondary">Lookup</button>
        <button id="fetchAvatar" class="btn-secondary">Avatar</button>
        <button id="applyPitEdit" class="btn-primary">Apply</button>
        <button id="deletePit" class="btn-danger">Delete</button>
      </div>
      <p class="hint" id="lookupStatus"></p>
      <p class="hint">Position: ${Math.round(pit.x)}, ${Math.round(pit.y)}</p>
      <button id="setGridOrigin" class="btn-secondary full-width">Set as Grid Origin</button>
      <p class="hint" id="gridOriginStatus">${state.gridOriginX!=null?`Origin: (${state.gridOriginX}, ${state.gridOriginY})`:'No origin set'}</p>
    `;
    document.getElementById('applyPitEdit').addEventListener('click', () => {
      PitMap.updatePit(state, pit.id, {
        label: document.getElementById('editLabel').value.trim(),
        teamNumber: document.getElementById('editTeamNum').value.trim(),
        teamName: document.getElementById('editTeamName').value.trim(),
      }); markDirty(); renderPitList(); redraw();
    });
    document.getElementById('deletePit').addEventListener('click', () => {
      PitMap.removePit(state, pit.id); setSelection([]); markDirty(); renderPitList(); redraw();
    });
    document.getElementById('setGridOrigin').addEventListener('click', () => {
      state.gridOriginX = pit.x; state.gridOriginY = pit.y; markDirty();
      document.getElementById('gridOriginStatus').textContent = `Origin: (${pit.x}, ${pit.y})`;
      showHint('Grid origin set'); setTimeout(hideHint, 2000);
    });
    document.getElementById('lookupTeam').addEventListener('click', async () => {
      const num = document.getElementById('editTeamNum').value.trim(); if (!num) return;
      const st  = document.getElementById('lookupStatus'); st.textContent = 'Looking up…';
      try {
        const res = await fetch(`https://api.ftcscout.org/rest/v1/teams/${num}`);
        if (!res.ok) throw new Error('Not found');
        const d = await res.json();
        document.getElementById('editTeamName').value = d.name || d.teamName || '';
        st.textContent = d.name ? 'Found: ' + d.name : 'No name returned.';
      } catch (e) { st.textContent = 'Error: ' + e.message; }
    });

    document.getElementById('fetchAvatar').addEventListener('click', async () => {
      const num = document.getElementById('editTeamNum').value.trim() || pit.teamNumber;
      if (!num) return;
      const st = document.getElementById('lookupStatus');
      st.textContent = 'Loading avatar CSS…';
      const season = state.seasonYear || 2025;
      const map = await loadAvatarCss(season);
      const url = map?.[num];
      if (url) {
        pit.avatarUrl = url;
        PitMap.loadAvatars(state, redraw);
        markDirty(); redraw();
        st.textContent = 'Avatar loaded.';
      } else {
        st.textContent = map ? 'No avatar found for this team.' : 'Could not load avatar CSS.';
      }
    });
  }

  // ── Pit list ──────────────────────────────────────────────
  function renderPitList() {
    pitListEl.innerHTML = '';
    if (!state.pits.length) { pitListEl.innerHTML = '<p class="hint">No pits yet.</p>'; return; }
    for (const pit of state.pits) {
      const div = document.createElement('div');
      div.className = 'pit-item' + (selectedIds.has(pit.id) ? ' selected' : '');
      div.innerHTML = `<span class="pit-item-label">${esc(pit.label||'—')}</span>
        <span class="pit-item-team">${esc(pit.teamNumber||'unassigned')}</span>
        <button class="pit-item-del" title="Delete">✕</button>`;
      div.addEventListener('click', ev => {
        if (ev.target.classList.contains('pit-item-del')) {
          PitMap.removePit(state, pit.id); selectedIds.delete(pit.id);
          markDirty(); renderPitList(); renderSelectedPanel(); redraw(); return;
        }
        if (ev.shiftKey) { selectedIds.has(pit.id)?selectedIds.delete(pit.id):selectedIds.add(pit.id); renderSelectedPanel(); renderPitList(); redraw(); }
        else { setSelection([pit.id]); canvasWrap.scrollTo({left:(pit.x-40)*zoom.zoom,top:(pit.y-40)*zoom.zoom,behavior:'smooth'}); redraw(); }
      });
      pitListEl.appendChild(div);
    }
  }

  // ── Helpers ───────────────────────────────────────────────
  function redraw() {
    PitMap.render(canvas, state, {
      selectedIds, hoverId,
      selectedElementId, hoverElementId, drapePreview,
      guide: guide.img ? guide : null,
    });
  }
  function showHint(msg) { hint.textContent = msg; hint.classList.add('visible'); }
  function hideHint() { hint.classList.remove('visible'); }
  function esc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function loadScript(src) {
    return new Promise((res,rej) => { const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
  }
})();
