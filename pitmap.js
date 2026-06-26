/* pitmap.js — shared data layer, canvas renderer, file I/O */

const PitMap = (() => {

  function defaultState() {
    return {
      eventName: '',
      seasonYear: 2025,
      pixelsPerFoot: 10,
      floorplanDataUrl: null,
      floorplanScale: 1,
      floorplanX: 0,
      floorplanY: 0,
      pits: [],     // { id, x, y, label, teamNumber, teamName }
      elements: [], // { id, type, x, y, w?, h?, label?, points?:[{x,y}] }
      pitFontScale: 1,
      pitTextColor: '#f1f5f9',
      pitNameColor: '#94a3b8',
    };
  }

  function stateToJSON(state) {
    const out = { ...state };
    delete out._floorImg;
    delete out._avatarImgs;
    return JSON.stringify(out, null, 2);
  }

  /* ── File System Access API (Chrome/Edge) ───────────────── */
  const FILE_OPTS = {
    types: [{ description: 'Pit Map JSON', accept: { 'application/json': ['.json'] } }],
    suggestedName: 'pitmap.json',
  };

  async function openFile() {
    if (!window.showOpenFilePicker) return { state: null, handle: null, error: 'unsupported' };
    try {
      const [handle] = await window.showOpenFilePicker({ ...FILE_OPTS, multiple: false });
      const file = await handle.getFile();
      const data = JSON.parse(await file.text());
      return { state: { ...defaultState(), ...data }, handle };
    } catch (e) {
      if (e.name === 'AbortError') return { state: null, handle: null, error: 'cancelled' };
      return { state: null, handle: null, error: e.message };
    }
  }

  async function saveToHandle(handle, state) {
    const writable = await handle.createWritable();
    await writable.write(stateToJSON(state));
    await writable.close();
  }

  async function saveAsFile(state) {
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker(FILE_OPTS);
        await saveToHandle(handle, state);
        return handle;
      } catch (e) {
        if (e.name === 'AbortError') return null;
        // Fall through to download
      }
    }
    // Fallback: trigger browser download
    const blob = new Blob([stateToJSON(state)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pitmap.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return null;
  }

  /* ── Viewer: fetch pitmap.json from server ──────────────── */
  async function fetchFromServer() {
    try {
      const res = await fetch('./pitmap.json?_=' + Date.now());
      if (res.ok) return { ...defaultState(), ...await res.json() };
    } catch (_) {}
    return null;
  }

  /* ── Canvas helpers ─────────────────────────────────────── */
  function pitSize(state) {
    return (Number(state.pixelsPerFoot) || 10) * 10;
  }

  function render(canvas, state, opts = {}) {
    const { selectedIds = null, highlightId = null, hoverId = null, guide = null } = opts;
    const ctx = canvas.getContext('2d');
    const ps  = pitSize(state);

    const { selectedElementId = null, hoverElementId = null, drapePreview = null } = opts;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (state._floorImg) {
      const sc = state.floorplanScale ?? 1;
      const fx = state.floorplanX ?? 0;
      const fy = state.floorplanY ?? 0;
      ctx.drawImage(state._floorImg, fx, fy,
        state._floorImg.naturalWidth * sc, state._floorImg.naturalHeight * sc);
    }

    // Guide image — admin-only overlay, not exported
    if (guide && guide.img) {
      ctx.save();
      ctx.globalAlpha = guide.opacity ?? 0.5;
      const cx = (guide.x ?? canvas.width  / 2);
      const cy = (guide.y ?? canvas.height / 2);
      const sc = guide.scale ?? 1;
      const rot = (guide.rotation ?? 0) * Math.PI / 180;
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.scale(sc, sc);
      ctx.drawImage(guide.img, -guide.img.naturalWidth / 2, -guide.img.naturalHeight / 2);
      ctx.restore();
    }

    // Draw elements (fields + drape lines) — below pits
    for (const el of (state.elements || [])) {
      renderElement(ctx, el, el.id === selectedElementId, el.id === hoverElementId);
    }
    // Drape preview polyline while placing
    if (drapePreview && drapePreview.points && drapePreview.points.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#d97706'; ctx.lineWidth = 4; ctx.setLineDash([10, 6]);
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(drapePreview.points[0].x, drapePreview.points[0].y);
      for (let i = 1; i < drapePreview.points.length; i++)
        ctx.lineTo(drapePreview.points[i].x, drapePreview.points[i].y);
      if (drapePreview.cursor)
        ctx.lineTo(drapePreview.cursor.x, drapePreview.cursor.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#d97706';
      for (const p of drapePreview.points) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }

    for (const pit of state.pits) {
      const isSelected  = selectedIds ? selectedIds.has(pit.id) : false;
      const isHighlight = pit.id === highlightId;
      const isHover     = pit.id === hoverId;
      const hasTeam     = Boolean(pit.teamNumber);

      ctx.save();

      // Background
      if      (isSelected)           ctx.fillStyle = 'rgba(154,52,18,0.92)';
      else if (isHighlight)          ctx.fillStyle = 'rgba(113,63,18,0.92)';
      else if (isHover && hasTeam)   ctx.fillStyle = 'rgba(20,83,45,0.92)';
      else if (isHover)              ctx.fillStyle = 'rgba(127,29,29,0.92)';
      else if (hasTeam)              ctx.fillStyle = 'rgba(15,23,42,0.82)';
      else                           ctx.fillStyle = 'rgba(30,41,59,0.72)';
      roundRect(ctx, pit.x, pit.y, ps, ps, Math.max(3, ps * 0.06));
      ctx.fill();

      // Border
      ctx.lineWidth   = isSelected || isHighlight ? 3 : 2;
      ctx.strokeStyle = isSelected  ? '#fb923c'
                      : isHighlight ? '#fbbf24'
                      : isHover     ? '#fdba74'
                      :               '#f97316';
      roundRect(ctx, pit.x + 1, pit.y + 1, ps - 2, ps - 2, Math.max(2, ps * 0.06));
      ctx.stroke();

      // Avatar / Text
      const fontScale = state.pitFontScale ?? 1;
      const textColor = state.pitTextColor || '#f1f5f9';
      const avatarImg = state._avatarImgs?.[pit.teamNumber];
      const hasAvatar = hasTeam && avatarImg?.complete && avatarImg.naturalWidth > 0;

      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (hasAvatar) {
        // Fill the entire pit box with the avatar image
        const pad = 2;
        ctx.save();
        roundRect(ctx, pit.x + pad, pit.y + pad, ps - pad * 2, ps - pad * 2, Math.max(2, ps * 0.06));
        ctx.clip();
        ctx.drawImage(avatarImg, pit.x + pad, pit.y + pad, ps - pad * 2, ps - pad * 2);
        ctx.restore();
      } else if (hasTeam) {
        const numSize = Math.max(11, ps * 0.22) * fontScale;
        ctx.font      = `700 ${numSize}px "Segoe UI",system-ui,sans-serif`;
        ctx.fillStyle = isSelected ? '#fed7aa' : isHighlight ? '#fef08a' : textColor;
        ctx.fillText(pit.teamNumber, pit.x + ps / 2, pit.y + ps / 2);
      } else {
        ctx.font      = `${Math.max(9, ps * 0.15) * fontScale}px "Segoe UI",system-ui,sans-serif`;
        ctx.fillStyle = '#64748b';
        ctx.fillText(pit.label || 'Empty', pit.x + ps / 2, pit.y + ps / 2);
      }
      ctx.restore();
    }
  }

  function renderElement(ctx, el, isSelected, isHover) {
    ctx.save();
    if (el.type === 'competition-field' || el.type === 'practice-field') {
      const isComp = el.type === 'competition-field';
      const borderColor = isSelected ? '#fb923c' : isHover ? '#fbbf24' : (isComp ? '#22c55e' : '#38bdf8');
      const fillColor   = isComp ? 'rgba(20,83,45,0.55)' : 'rgba(12,74,110,0.55)';
      // Fill
      ctx.fillStyle = fillColor;
      roundRect(ctx, el.x, el.y, el.w, el.h, 6); ctx.fill();
      // Tile grid lines
      ctx.strokeStyle = isComp ? 'rgba(74,222,128,0.2)' : 'rgba(56,189,248,0.2)';
      ctx.lineWidth = 0.5; ctx.setLineDash([]);
      const tileSize = Math.min(el.w, el.h) / 6;
      for (let gx = el.x + tileSize; gx < el.x + el.w; gx += tileSize) {
        ctx.beginPath(); ctx.moveTo(gx, el.y); ctx.lineTo(gx, el.y + el.h); ctx.stroke();
      }
      for (let gy = el.y + tileSize; gy < el.y + el.h; gy += tileSize) {
        ctx.beginPath(); ctx.moveTo(el.x, gy); ctx.lineTo(el.x + el.w, gy); ctx.stroke();
      }
      // Border
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = isSelected ? 3 : 2; ctx.setLineDash([]);
      roundRect(ctx, el.x + 1, el.y + 1, el.w - 2, el.h - 2, 5); ctx.stroke();
      // Corner markers for competition field
      if (isComp) {
        const ms = Math.min(el.w, el.h) * 0.08;
        for (const [cx, cy] of [[el.x,el.y],[el.x+el.w,el.y],[el.x,el.y+el.h],[el.x+el.w,el.y+el.h]]) {
          ctx.fillStyle = 'rgba(239,68,68,0.75)';
          ctx.fillRect(cx - ms/2, cy - ms/2, ms, ms);
        }
      }
      // Label
      const fieldFontSize = el.fontSize ?? Math.max(11, Math.min(el.w, el.h) * 0.12);
      ctx.fillStyle = el.textColor || '#f1f5f9';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `700 ${fieldFontSize}px "Segoe UI",system-ui,sans-serif`;
      ctx.fillText(el.label || (isComp ? 'Competition Field' : 'Practice Field'),
        el.x + el.w / 2, el.y + el.h / 2);
    } else if (el.type === 'drape') {
      const pts = el.points || (el.x2 != null ? [{x:el.x,y:el.y},{x:el.x2,y:el.y2}] : [{x:el.x,y:el.y}]);
      const color = isSelected ? '#fb923c' : isHover ? '#fbbf24' : '#a8a29e';
      const lw = isSelected ? 5 : 3;
      // Line through all points
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      // Corner dots — all when selected, only endpoints otherwise
      ctx.fillStyle = color;
      for (let i = 0; i < pts.length; i++) {
        if (isSelected || i === 0 || i === pts.length - 1) {
          ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, isSelected ? 6 : 4, 0, Math.PI * 2); ctx.fill();
        }
      }
      // Label
      if (el.label && pts.length >= 2) {
        const mid = Math.floor(pts.length / 2);
        const mx = (pts[mid-1].x + pts[mid].x) / 2, my = (pts[mid-1].y + pts[mid].y) / 2;
        ctx.fillStyle = '#f1f5f9'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.font = '11px "Segoe UI",system-ui,sans-serif';
        ctx.fillText(el.label, mx, my - 4);
      }
    }
    ctx.restore();
  }

  function addElement(state, type, props) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.elements.push({ id, type, ...props });
    return id;
  }

  function removeElement(state, id) { state.elements = state.elements.filter(e => e.id !== id); }
  function updateElement(state, id, fields) {
    const el = state.elements.find(e => e.id === id); if (el) Object.assign(el, fields);
  }

  function elementAt(state, x, y) {
    for (let i = (state.elements || []).length - 1; i >= 0; i--) {
      const el = state.elements[i];
      if (el.type === 'competition-field' || el.type === 'practice-field') {
        if (x >= el.x && x <= el.x + el.w && y >= el.y && y <= el.y + el.h)
          return { element: el, part: 'body' };
      } else if (el.type === 'drape') {
        const pts = el.points || (el.x2 != null ? [{x:el.x,y:el.y},{x:el.x2,y:el.y2}] : []);
        // Check endpoints first (drag handles)
        for (let i = 0; i < pts.length; i++) {
          if (Math.hypot(x - pts[i].x, y - pts[i].y) <= 10) return { element: el, part: `ep${i}` };
        }
        // Check line segments
        for (let i = 0; i < pts.length - 1; i++) {
          if (distToSegment(x, y, pts[i].x, pts[i].y, pts[i+1].x, pts[i+1].y) <= 8)
            return { element: el, part: 'body' };
        }
      }
    }
    return null;
  }

  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, lenSq = dx*dx + dy*dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / lenSq));
    return Math.hypot(px - (ax + t*dx), py - (ay + t*dy));
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);   ctx.arcTo(x + w, y,     x + w, y + r,     r);
    ctx.lineTo(x + w, y + h-r); ctx.arcTo(x + w, y + h, x + w-r, y + h,  r);
    ctx.lineTo(x + r, y + h);   ctx.arcTo(x,     y + h, x,     y + h-r,   r);
    ctx.lineTo(x,     y + r);   ctx.arcTo(x,     y,     x + r, y,         r);
    ctx.closePath();
  }

  function pitAt(state, x, y) {
    const ps = pitSize(state);
    for (let i = state.pits.length - 1; i >= 0; i--) {
      const p = state.pits[i];
      if (x >= p.x && x <= p.x + ps && y >= p.y && y <= p.y + ps) return p;
    }
    return null;
  }

  function addPit(state, x, y, label) {
    const ps   = pitSize(state);
    const snap = ps / 2;
    const id   = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.pits.push({
      id, label: label || '',
      x: Math.round(x / snap) * snap,
      y: Math.round(y / snap) * snap,
      teamNumber: '', teamName: '',
    });
    return id;
  }

  function removePit(state, id) { state.pits = state.pits.filter(p => p.id !== id); }
  function updatePit(state, id, fields) { const p = state.pits.find(p => p.id === id); if (p) Object.assign(p, fields); }

  function loadAvatars(state, onLoad) {
    if (!state._avatarImgs) state._avatarImgs = {};
    for (const pit of state.pits) {
      if (!pit.avatarUrl || !pit.teamNumber) continue;
      const existing = state._avatarImgs[pit.teamNumber];
      if (existing && existing.complete && existing.naturalWidth > 0 && existing._src === pit.avatarUrl) continue;
      const img = new Image();
      img.onload  = onLoad;
      img.onerror = () => {};
      img._src = pit.avatarUrl;
      img.src  = pit.avatarUrl;
      state._avatarImgs[pit.teamNumber] = img;
    }
  }

  function loadFloorImage(dataUrl) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  return {
    defaultState, fetchFromServer,
    openFile, saveToHandle, saveAsFile,
    pitSize, render, pitAt, addPit, removePit, updatePit, loadFloorImage,
    addElement, removeElement, updateElement, elementAt,
    loadAvatars,
  };
})();


/* ── ZoomController ─────────────────────────────────────────── */
class ZoomController {
  constructor({ scaler, scrollContainer, canvas, labelEl }) {
    this.scaler  = scaler;
    this.scroll  = scrollContainer;
    this.canvas  = canvas;
    this.labelEl = labelEl;
    this.zoom    = 1;
    this.MIN     = 0.1;
    this.MAX     = 4;

    scrollContainer.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const rect  = scrollContainer.getBoundingClientRect();
      this._apply(this.zoom * delta,
        e.clientX - rect.left + scrollContainer.scrollLeft,
        e.clientY - rect.top  + scrollContainer.scrollTop);
    }, { passive: false });
  }

  setZoom(z, ax, ay) { this._apply(z, ax, ay); }

  fitToContainer() {
    const w = this.scroll.clientWidth, h = this.scroll.clientHeight;
    const cw = this.canvas.width,     ch = this.canvas.height;
    if (!cw || !ch) return;
    this._apply(Math.min(w / cw, h / ch, 1));
    this.scroll.scrollTo(0, 0);
  }

  _apply(z, ax, ay) {
    const prev = this.zoom;
    this.zoom  = Math.max(this.MIN, Math.min(this.MAX, z));
    // CSS zoom affects layout (unlike transform: scale) so scrollable area is always correct
    this.scaler.style.zoom = this.zoom;
    this.scaler.style.transform = '';
    if (this.labelEl) this.labelEl.textContent = Math.round(this.zoom * 100) + '%';
    if (ax != null) {
      const r = this.zoom / prev;
      this.scroll.scrollLeft = ax * r - (ax - this.scroll.scrollLeft);
      this.scroll.scrollTop  = ay * r - (ay - this.scroll.scrollTop);
    }
  }

  canvasXY(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.zoom, y: (e.clientY - r.top) / this.zoom };
  }
}
