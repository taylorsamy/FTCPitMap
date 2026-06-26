/* viewer.js — public viewer page logic */

(async () => {
  const canvas      = document.getElementById('mapCanvas');
  const scaler      = document.getElementById('canvasScaler');
  const mapContainer= document.getElementById('mapContainer');
  const noMap       = document.getElementById('noMap');
  const noMapMsg    = document.getElementById('noMapMsg');
  const searchEl    = document.getElementById('teamSearch');
  const clearBtn    = document.getElementById('clearSearch');
  const panel       = document.getElementById('teamPanel');
  const overlay     = document.getElementById('panelOverlay');

  let hoverId     = null;
  let highlightId = null;

  // Try server fetch first; if it fails offer a manual file picker
  let state = await PitMap.fetchFromServer();

  if (!state || (!state.floorplanDataUrl && !state.pits?.length)) {
    noMapMsg.textContent = state
      ? 'No pit map has been created yet.'
      : 'Could not load pitmap.json — select it below.';
    noMap.style.display = 'flex';
    document.getElementById('noMapFilePick').style.display = '';
    document.getElementById('noMapAdminLink').style.display = '';
    canvas.style.display = 'none';
    document.getElementById('zoomControls').style.display = 'none';

    // Let user manually open pitmap.json (works on file:// too)
    document.getElementById('noMapFileInput').addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        state = { ...PitMap.defaultState(), ...data };
        if (state.floorplanDataUrl || state.pits?.length) {
          noMap.style.display = 'none';
          canvas.style.display = '';
          document.getElementById('zoomControls').style.display = '';
          await initMap(state);
        }
      } catch { noMapMsg.textContent = 'Invalid JSON file.'; }
    });
    return;
  }

  noMap.style.display = 'none';
  await initMap(state);

  async function initMap(state) {

  // Load floor image
  if (state.floorplanDataUrl) {
    const img = await PitMap.loadFloorImage(state.floorplanDataUrl);
    if (img) {
      state._floorImg = img;
      const sc = state.floorplanScale ?? 1;
      const fx = state.floorplanX ?? 0;
      const fy = state.floorplanY ?? 0;
      canvas.width  = Math.max(800, Math.ceil(fx + img.naturalWidth  * sc));
      canvas.height = Math.max(600, Math.ceil(fy + img.naturalHeight * sc));
    }
  } else {
    canvas.width = 800; canvas.height = 600;
  }

  if (state.eventName) document.title = state.eventName + ' — Pit Map';

  // ── Zoom ──────────────────────────────────────────────────
  const zoom = new ZoomController({
    scaler, scrollContainer: mapContainer, canvas,
    labelEl: document.getElementById('zoomLabel'),
  });

  document.getElementById('zoomIn') .addEventListener('click', () => zoom.setZoom(zoom.zoom * 1.2));
  document.getElementById('zoomOut').addEventListener('click', () => zoom.setZoom(zoom.zoom / 1.2));
  document.getElementById('zoomFit').addEventListener('click', () => zoom.fitToContainer());

  // Fit on load (after a paint so clientWidth is available)
  requestAnimationFrame(() => zoom.fitToContainer());

  redraw();
  PitMap.loadAvatars(state, redraw);

  // ── Canvas interaction ────────────────────────────────────
  canvas.addEventListener('mousemove', e => {
    const { x, y } = zoom.canvasXY(e);
    const pit = PitMap.pitAt(state, x, y);
    const newHover = pit ? pit.id : null;
    if (newHover !== hoverId) { hoverId = newHover; redraw(); }
    canvas.style.cursor = pit ? 'pointer' : 'default';
  });

  canvas.addEventListener('mouseleave', () => { hoverId = null; redraw(); });

  canvas.addEventListener('click', e => {
    const { x, y } = zoom.canvasXY(e);
    const pit = PitMap.pitAt(state, x, y);
    if (pit) openPanel(pit);
  });

  // ── Search ────────────────────────────────────────────────
  searchEl.addEventListener('input', () => {
    const q = searchEl.value.trim().toLowerCase();
    if (!q) { highlightId = null; redraw(); return; }
    const found = state.pits.find(p =>
      p.teamNumber?.toLowerCase().includes(q) ||
      p.teamName?.toLowerCase().includes(q) ||
      p.label?.toLowerCase().includes(q)
    );
    highlightId = found ? found.id : null;
    if (found) scrollToPit(found);
    redraw();
  });

  clearBtn.addEventListener('click', () => {
    searchEl.value = ''; highlightId = null; redraw();
  });

  // ── Panel ─────────────────────────────────────────────────
  document.getElementById('closePanel').addEventListener('click', closePanel);
  overlay.addEventListener('click', closePanel);

  async function openPanel(pit) {
    panel.classList.remove('hidden');
    overlay.classList.remove('hidden');

    document.getElementById('panelTeamNumber').textContent = pit.teamNumber || '—';
    document.getElementById('panelTeamName').textContent   = pit.teamName   || 'Team ' + (pit.teamNumber || '');
    document.getElementById('panelTeamOrg').textContent    = '';
    document.getElementById('panelLocation').textContent   = pit.label ? 'Pit ' + pit.label : '';
    document.getElementById('panelPitNum').textContent     = '';
    document.getElementById('panelLinks').innerHTML        = '';

    const scoutEl = document.getElementById('scoutStats');
    scoutEl.innerHTML = '<div class="stats-loading">Loading scouting data…</div>';

    if (!pit.teamNumber) {
      scoutEl.innerHTML = '<div class="stats-error">No team assigned to this pit.</div>';
      return;
    }

    const year = state.seasonYear || 2025;
    try {
      const [teamRes, statsRes] = await Promise.all([
        fetch(`https://api.ftcscout.org/rest/v1/teams/${pit.teamNumber}`),
        fetch(`https://api.ftcscout.org/rest/v1/teams/${pit.teamNumber}/quick-stats?season=${year}`)
      ]);

      if (teamRes.ok) {
        const t = await teamRes.json();
        document.getElementById('panelTeamName').textContent = t.name || t.teamName || ('Team ' + pit.teamNumber);
        document.getElementById('panelTeamOrg').textContent  = [t.schoolName, t.city, t.stateProv, t.country].filter(Boolean).join(', ');
        if (!pit.teamName && t.name) pit.teamName = t.name;
      }

      if (statsRes.ok) {
        renderStats(scoutEl, await statsRes.json(), year);
      } else {
        scoutEl.innerHTML = '<div class="stats-error">No scouting data available for this season yet.</div>';
      }
    } catch {
      scoutEl.innerHTML = '<div class="stats-error">Could not load FTC Scout data. Check your connection.</div>';
    }

    document.getElementById('panelLinks').innerHTML = `
      <a href="https://ftcscout.org/teams/${pit.teamNumber}" target="_blank" rel="noopener">FTC Scout →</a>
      <a href="https://ftc-events.firstinspires.org/team/${pit.teamNumber}" target="_blank" rel="noopener">FTC Events →</a>
    `;
  }

  function renderStats(el, data, year) {
    // Each stat is either { value, rank } or a plain number depending on API version
    const val  = v => (v != null && typeof v === 'object') ? v.value : v;
    const tot  = val(data.tot  ?? data.totalPoints ?? data.total);
    const auto = val(data.auto ?? data.autoPoints);
    const dc   = val(data.dc   ?? data.dcPoints    ?? data.teleopPoints);
    const eg   = val(data.eg   ?? data.egPoints    ?? data.endgamePoints);
    const rank = data.rank ?? data.tot?.rank;
    const wins = data.wins; const losses = data.losses; const ties = data.ties;
    const fmt  = v => (v == null ? '—' : typeof v === 'number' ? v.toFixed(1) : v);
    const cc   = (v, hi, lo) => v == null ? '' : v >= hi ? 'good' : v >= lo ? 'mid' : 'low';

    let html = `<div class="stat-section-title">Average Scores (${year})</div><div class="stat-grid">`;
    html += statCard('Total OPR', fmt(tot),  cc(tot, 80, 40));
    html += statCard('Auto',      fmt(auto), cc(auto, 20, 8));
    html += statCard('TeleOp',    fmt(dc),   cc(dc, 50, 20));
    html += statCard('Endgame',   fmt(eg),   cc(eg, 15, 5));
    html += '</div>';
    if (rank != null || wins != null) {
      html += '<div class="stat-section-title">Season Record</div><div class="stat-grid">';
      if (rank != null) html += statCard('Rank', '#' + rank, '');
      if (wins != null) html += statCard('Record', `${wins}W-${losses ?? 0}L${ties ? '-' + ties + 'T' : ''}`, '');
      html += '</div>';
    }
    el.innerHTML = html;
  }

  function statCard(label, value, cls) {
    return `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value ${cls}">${value}</div></div>`;
  }

  function closePanel() {
    panel.classList.add('hidden');
    overlay.classList.add('hidden');
  }

  function redraw() {
    PitMap.render(canvas, state, { highlightId, hoverId });
  }

  function scrollToPit(pit) {
    mapContainer.scrollTo({
      left: (pit.x - 100) * zoom.zoom,
      top:  (pit.y - 100) * zoom.zoom,
      behavior: 'smooth',
    });
  }
  } // end initMap
})();
