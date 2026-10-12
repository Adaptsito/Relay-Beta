// ════════════════════════════════════════════════════════════
//  RELAY — browser-based streaming app for Chromebook
//  v2: scenes, overlays (text/image/clock/countdown/ticker),
//      face cam, soundboard, recording, and reliability tools.
//
//  Core pipeline (unchanged from v1):
//  1. getDisplayMedia() captures your screen/tab.
//  2. Screen + face cam + overlays are drawn onto a canvas every
//     frame. canvas.captureStream() turns that into a video track
//     with everything baked in — no watermark, no app in the loop.
//  3. Audio (desktop, mic, soundboard) is mixed on a persistent
//     Web Audio graph; the mixed track goes out alongside video.
//  4. Both go to Twitch via WHIP, the same ingest standard OBS's
//     WHIP output uses.
// ════════════════════════════════════════════════════════════

const RELAY_VERSION = '2.0';
const WHIP = 'https://g.webrtc.live-video.net:4443/v2/offer';
const RES_PRESETS = {
  '540p30':  { w:960,  h:540,  fps:30, label:'540p30 · Data Saver' },
  '720p30':  { w:1280, h:720,  fps:30, label:'720p30 · Balanced'   },
  '720p60':  { w:1280, h:720,  fps:60, label:'720p60 · Smooth'     },
  '1080p30': { w:1920, h:1080, fps:30, label:'1080p30 · Quality'   },
};
const BITRATE_PRESETS = { saver: 1_500_000, balanced: 3_000_000, quality: 6_000_000 };

let CW = 1280, CH = 720, CFPS = 30;

// ── Core state ───────────────────────────────────────────────
let scenes   = [{ id:1, name:'Scene 1' }, { id:2, name:'Scene 2' }];
let activeId = 1, nextSId = 3;
let overlays = { 1:[], 2:[] };
let nextOId  = 1, selOvId = null, editOvId = null;
let transitionMode = 'cut'; // 'cut' | 'fade'
let transitionProgress = null; // {from, to, t0, dur} while a fade is in flight

// Box model (top-left xPct/yPct + wPct/hPct), same shape as overlays so both
// share one drag/resize system. Equivalent to the old center:(80,78)/size:22.
let faceCam = { active:false, visible:true, xPct:69, yPct:58.4, wPct:22, hPct:39.11, shape:'circle' };
let camStream = null;

let displayStream = null, micStream = null;
let pc = null, whipRes = null, senderVideo = null;
let startTime = null, timerIv = null, statsIv = null, reconnectAttempts = 0;

let deskMuted = false;
let gateOn = false, gateThreshold = 0.06;
let duckOn = false, duckTimer = null;

let sounds = []; let nextSoundId = 1;
let activeSfxSources = [];

let mediaRecorder = null, recordedChunks = [], isRecording = false;

let undoStack = [], redoStack = [];
let highContrast = false;

// ── Audio graph (persistent for the life of the page) ─────────
let audioCtx = null, mixDest = null, sfxGain = null, duckGain = null, micGateGain = null;
let deskAudioSrc = null, micAudioSrc = null;
let meterStops = {}, meterHandles = {};

function ensureAudioGraph() {
  if (audioCtx) return audioCtx;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  mixDest = audioCtx.createMediaStreamDestination();
  duckGain = audioCtx.createGain(); duckGain.gain.value = 1; duckGain.connect(mixDest);
  micGateGain = audioCtx.createGain(); micGateGain.gain.value = 1; micGateGain.connect(mixDest);
  sfxGain = audioCtx.createGain();
  sfxGain.gain.value = ($('sfxVolume') ? $('sfxVolume').value : 80) / 100;
  sfxGain.connect(duckGain);           // sfx go out to Twitch...
  sfxGain.connect(audioCtx.destination); // ...and are also heard locally
  return audioCtx;
}

function attachMeter(key, track, fillEl) {
  ensureAudioGraph();
  meterStops[key]?.();
  const src = audioCtx.createMediaStreamSource(new MediaStream([track]));
  const an = audioCtx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0.6;
  src.connect(an);
  const data = new Uint8Array(an.frequencyBinCount);
  let alive = true;
  function level() {
    an.getByteFrequencyData(data);
    let sum = 0; for (let i=0;i<data.length;i++) sum += data[i];
    return sum / data.length / 255;
  }
  meterStops[key] = () => { alive = false; if (fillEl) fillEl.style.width = '0%'; delete meterHandles[key]; };
  meterHandles[key] = { level };
  (function tick() {
    if (!alive) return;
    requestAnimationFrame(tick);
    if (fillEl) fillEl.style.width = Math.min(100, level()*210) + '%';
  })();
  return meterHandles[key];
}

function connectDeskAudio(track) {
  ensureAudioGraph();
  if (deskAudioSrc) { try { deskAudioSrc.disconnect(); } catch {} }
  deskAudioSrc = audioCtx.createMediaStreamSource(new MediaStream([track]));
  deskAudioSrc.connect(duckGain);
}
function connectMicAudio(track) {
  ensureAudioGraph();
  if (micAudioSrc) { try { micAudioSrc.disconnect(); } catch {} }
  micAudioSrc = audioCtx.createMediaStreamSource(new MediaStream([track]));
  micAudioSrc.connect(micGateGain);
}
function disconnectMicAudio() {
  if (micAudioSrc) { try { micAudioSrc.disconnect(); } catch {} micAudioSrc = null; }
}

// Gate + auto-duck processing loop — a single loop regardless of how many
// features are on, so we're not stacking redundant rAF callbacks.
(function audioProcessLoop() {
  requestAnimationFrame(audioProcessLoop);
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const micLv = meterHandles.mic ? meterHandles.mic.level() : 0;

  if (gateOn) micGateGain.gain.setTargetAtTime(micLv > gateThreshold ? 1 : 0.04, now, 0.05);
  else micGateGain.gain.setTargetAtTime(1, now, 0.05);

  if (duckOn) {
    if (micLv > gateThreshold) {
      clearTimeout(duckTimer); duckTimer = null;
      duckGain.gain.setTargetAtTime(0.25, now, 0.08);
    } else if (!duckTimer) {
      duckTimer = setTimeout(() => {
        duckGain.gain.setTargetAtTime(1, audioCtx.currentTime, 0.25);
        duckTimer = null;
      }, 500);
    }
  } else {
    duckGain.gain.setTargetAtTime(1, now, 0.1);
  }
})();

// ── DOM helpers ───────────────────────────────────────────────
const $ = id => document.getElementById(id);
function pctClamp(v) { return Math.max(0, Math.min(100, v)); }
function fmtHMS(ms) {
  const s = Math.floor(Math.max(0,ms)/1000);
  return [Math.floor(s/3600), Math.floor(s%3600/60), s%60].map(n=>String(n).padStart(2,'0')).join(':');
}
function fontStack(key) {
  return { sans:'sans-serif', serif:'Georgia, serif', mono:'"Courier New", monospace',
    impact:'Impact, Haettenschweiler, sans-serif', comic:'"Comic Sans MS", cursive' }[key] || 'sans-serif';
}
function setStatus(state, txt) {
  $('sbDot').className = 'sb-dot' + (state ? ' '+state : '');
  $('sbText').textContent = txt;
}
function activeOvs() { return overlays[activeId] || []; }
function toast(msg, kind) {
  const host = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' '+kind : '');
  el.textContent = msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(()=>el.remove(), 250); }, 3200);
}

// ── Undo / redo (per-scene overlay snapshots) ──────────────────
function snapshot() {
  undoStack.push({ sceneId: activeId, ovs: activeOvs().map(o => ({...o})) });
  if (undoStack.length > 30) undoStack.shift();
  redoStack = [];
}
function undo() {
  const snap = undoStack.pop();
  if (!snap) { toast('Nothing to undo'); return; }
  redoStack.push({ sceneId: snap.sceneId, ovs: (overlays[snap.sceneId]||[]).map(o=>({...o})) });
  overlays[snap.sceneId] = snap.ovs;
  activeId = snap.sceneId; selOvId = null;
  renderScenes(); renderSources();
  toast('Undid last change');
}
function redo() {
  const snap = redoStack.pop();
  if (!snap) { toast('Nothing to redo'); return; }
  undoStack.push({ sceneId: snap.sceneId, ovs: (overlays[snap.sceneId]||[]).map(o=>({...o})) });
  overlays[snap.sceneId] = snap.ovs;
  activeId = snap.sceneId; selOvId = null;
  renderScenes(); renderSources();
  toast('Redid change');
}

// ── Scenes ────────────────────────────────────────────────────
function renderScenes() {
  const body = $('scenesBody'); body.innerHTML = '';
  scenes.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'sc-row' + (s.id === activeId ? ' active' : '');
    el.draggable = true;
    el.innerHTML = `<span class="sc-pip"></span><span class="sc-name" data-name>${s.name}</span>
      <span class="sc-key">${i<9 ? i+1 : ''}</span>`;
    el.onclick = (e) => { if (e.target.closest('[data-name]')?.isContentEditable) return; switchScene(s.id); };
    el.ondblclick = () => startRename(el.querySelector('[data-name]'), s);
    el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', String(i)); };
    el.ondragover = (e) => e.preventDefault();
    el.ondrop = (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData('text/plain'));
      const [moved] = scenes.splice(from, 1);
      scenes.splice(i, 0, moved);
      renderScenes();
    };
    body.appendChild(el);
  });
  const row = document.createElement('div'); row.className = 'src-del-row';
  row.innerHTML = `<button class="del-btn" id="dupSceneBtn">⧉ Duplicate</button>
    <button class="del-btn" id="delSceneBtn" style="margin-top:4px">− Delete scene</button>`;
  row.querySelector('#dupSceneBtn').onclick = duplicateScene;
  row.querySelector('#delSceneBtn').onclick = deleteScene;
  row.querySelector('#delSceneBtn').disabled = scenes.length <= 1;
  body.appendChild(row);
}
function startRename(nameEl, scene) {
  nameEl.contentEditable = 'true'; nameEl.focus();
  document.execCommand && document.execCommand('selectAll', false, null);
  const commit = () => {
    nameEl.contentEditable = 'false';
    scene.name = nameEl.textContent.trim() || scene.name;
    renderScenes();
  };
  nameEl.onblur = commit;
  nameEl.onkeydown = (e) => { if (e.key==='Enter') { e.preventDefault(); nameEl.blur(); } };
}
function switchScene(id) {
  if (id === activeId) return;
  const from = activeId;
  activeId = id; selOvId = null;
  renderScenes(); renderSources();
  if (transitionMode === 'fade') {
    transitionProgress = { from, to: id, t0: performance.now(), dur: 400 };
  }
}
$('addSceneBtn').onclick = () => {
  const id = nextSId++;
  scenes.push({ id, name: 'Scene ' + id }); overlays[id] = [];
  renderScenes();
  toast('Scene added');
};
function duplicateScene() {
  const src = scenes.find(s => s.id === activeId);
  const id = nextSId++;
  scenes.push({ id, name: src.name + ' copy' });
  overlays[id] = activeOvs().map(o => ({ ...o, id: nextOId++ }));
  renderScenes();
  toast('Scene duplicated');
}
function deleteScene() {
  if (scenes.length <= 1) return;
  const idx = scenes.findIndex(s => s.id === activeId);
  scenes.splice(idx, 1);
  delete overlays[activeId];
  activeId = scenes[Math.max(0, idx-1)].id;
  selOvId = null;
  renderScenes(); renderSources();
  toast('Scene deleted');
}

// ── Sources (overlays + face cam) ───────────────────────────────
function ovIcon(type) {
  return { text:'T', image:'🖼', clock:'🕐', countdown:'⏱', ticker:'📰' }[type] || '•';
}
function renderSources() {
  const body = $('sourcesBody'); body.innerHTML = '';
  const list = activeOvs();

  if (faceCam.active) {
    const el = document.createElement('div');
    el.className = 'src-row' + (selOvId === 'facecam' ? ' selected' : '');
    el.innerHTML = `<span class="src-eye" data-eye>${faceCam.visible ? '👁' : '🚫'}</span>
      <span class="src-name">Face Cam</span><span class="src-tag">📷</span>`;
    el.querySelector('[data-eye]').onclick = e => { e.stopPropagation(); faceCam.visible = !faceCam.visible; renderSources(); };
    el.onclick = () => { selOvId = 'facecam'; renderSources(); };
    body.appendChild(el);
  }

  if (!list.length && !faceCam.active) {
    const e = document.createElement('div');
    e.className = 'src-empty'; e.textContent = 'No overlays. Click + to add one.';
    body.appendChild(e);
  }

  list.forEach(ov => {
    const el = document.createElement('div');
    el.className = 'src-row' + (ov.id === selOvId ? ' selected' : '');
    el.innerHTML = `
      <span class="src-eye" data-eye>${ov.visible ? '👁' : '🚫'}</span>
      <span class="src-lock" data-lock title="Lock position">${ov.locked ? '🔒' : '🔓'}</span>
      <span class="src-name">${ov.label}</span>
      <span class="src-tag">${ovIcon(ov.type)}</span>`;
    el.querySelector('[data-eye]').onclick = e => { e.stopPropagation(); ov.visible = !ov.visible; renderSources(); };
    el.querySelector('[data-lock]').onclick = e => { e.stopPropagation(); ov.locked = !ov.locked; renderSources(); };
    el.onclick = () => { selOvId = ov.id; renderSources(); };
    el.ondblclick = () => openEdit(ov);
    body.appendChild(el);
  });

  const row = document.createElement('div'); row.className = 'src-del-row';
  const canAct = typeof selOvId === 'number';
  row.innerHTML = `
    <div style="display:flex;gap:4px">
      <button class="del-btn" id="layerFrontBtn" title="Bring to front">⬆</button>
      <button class="del-btn" id="layerBackBtn" title="Send to back">⬇</button>
      <button class="del-btn" id="dupOvBtn" title="Duplicate">⧉</button>
    </div>
    <button class="del-btn" id="delOvBtn" style="margin-top:4px">− Remove selected</button>`;
  [...row.querySelectorAll('button')].forEach(b => b.disabled = !canAct);
  row.querySelector('#layerFrontBtn').onclick = () => reorderSel(+1);
  row.querySelector('#layerBackBtn').onclick = () => reorderSel(-1);
  row.querySelector('#dupOvBtn').onclick = duplicateSelected;
  row.querySelector('#delOvBtn').onclick = () => {
    if (typeof selOvId !== 'number') return;
    snapshot();
    overlays[activeId] = overlays[activeId].filter(o => o.id !== selOvId);
    selOvId = null; renderSources();
  };
  body.appendChild(row);
}
function reorderSel(dir) {
  if (typeof selOvId !== 'number') return;
  snapshot();
  const arr = overlays[activeId];
  const i = arr.findIndex(o => o.id === selOvId);
  if (i < 0) return;
  const [ov] = arr.splice(i, 1);
  if (dir > 0) arr.push(ov); else arr.unshift(ov);
  renderSources();
}
function duplicateSelected() {
  if (typeof selOvId !== 'number') return;
  const ov = activeOvs().find(o => o.id === selOvId);
  if (!ov) return;
  snapshot();
  const copy = { ...ov, id: nextOId++, xPct: pctClamp(ov.xPct+3), yPct: pctClamp(ov.yPct+3) };
  overlays[activeId].push(copy);
  selOvId = copy.id;
  renderSources();
}

// ── Overlay geometry (shared by draw + hit-test, so they agree) ─
// Box model: xPct/yPct is the TOP-LEFT corner, wPct/hPct the size — all
// four as a percentage of canvas width/height. One shared box shape is
// what lets every overlay type (and the face cam) share one drag/resize
// system, the same way a text box or image behaves on a Slides canvas.
function ensureOvBox(ov) {
  // One-time migration for overlays saved before the box-resize model
  // (old format: xPct/yPct was a bottom-left anchor, no wPct/hPct).
  if (ov.wPct != null && ov.hPct != null) return;
  if (ov.type === 'image') {
    const wPct = ov.widthPct || 25;
    const wPx = wPct/100*CW;
    const hPx = ov.img ? ov.img.naturalHeight*(wPx/ov.img.naturalWidth) : wPx*0.6;
    ov.wPct = wPct; ov.hPct = hPx/CH*100;
  } else if (ov.type !== 'ticker') {
    const fs = ov.fontSize || 36;
    ctx.font = `bold ${fs}px ${fontStack(ov.font)}`;
    const sample = ov.type==='clock'||ov.type==='countdown' ? '00:00:00' : (ov.text || ' ');
    const w = Math.max(24, ctx.measureText(sample).width);
    ov.wPct = w/CW*100; ov.hPct = (fs*1.15)/CH*100;
  }
  if (ov.type !== 'ticker') ov.yPct = ov.yPct - ov.hPct; // was a bottom anchor, now top-left
}
function getOvBounds(ov) {
  if (ov.type === 'ticker') {
    const fs = ov.fontSize || 32;
    return { x: 0, y: ov.yPct/100*CH - fs, w: CW, h: fs*1.4 };
  }
  ensureOvBox(ov);
  return { x: ov.xPct/100*CW, y: ov.yPct/100*CH, w: ov.wPct/100*CW, h: ov.hPct/100*CH };
}

// ── Stretchy text rendering (text/clock/countdown behave like an image) ──
// Each is rasterized once at its natural size into a small offscreen
// bitmap, then that bitmap is drawImage()'d into the resize box — so a
// non-uniform box stretches the text exactly the way resizing an image
// would, instead of just reflowing it.
let ovBitmapCache = new Map();
function textBitmapFor(ov, text) {
  const fs = ov.fontSize || 36;
  const font = `bold ${fs}px ${fontStack(ov.font)}`;
  const sig = [text, font, ov.color, ov.bgOn, ov.bgColor, ov.shadow, ov.stroke, ov.strokeColor].join('|');
  const cached = ovBitmapCache.get(ov.id);
  if (cached && cached.sig === sig) return cached;

  ctx.font = font;
  const tw = Math.max(1, Math.ceil(ctx.measureText(text).width));
  const pad = Math.max(4, Math.ceil(fs/10));
  const natW = tw + pad*2, natH = Math.ceil(fs*1.3) + pad*2;

  const bmp = document.createElement('canvas');
  bmp.width = natW; bmp.height = natH;
  const bctx = bmp.getContext('2d');
  bctx.font = font; bctx.textBaseline = 'alphabetic';
  const baseX = pad, baseY = natH - pad - fs*0.28;

  if (ov.bgOn) { bctx.fillStyle = ov.bgColor || '#000'; bctx.fillRect(0, 0, natW, natH); }
  if (ov.shadow) { bctx.shadowColor='rgba(0,0,0,.8)'; bctx.shadowBlur=6; bctx.shadowOffsetX=2; bctx.shadowOffsetY=2; }
  if (ov.stroke) { bctx.lineWidth=Math.max(2,fs/12); bctx.strokeStyle=ov.strokeColor||'#000'; bctx.strokeText(text, baseX, baseY); }
  bctx.fillStyle = ov.color || '#fff';
  bctx.fillText(text, baseX, baseY);

  const entry = { sig, canvas: bmp };
  ovBitmapCache.set(ov.id, entry);
  return entry;
}
function drawTextLikeOverlay(ov, text, b) {
  const bmp = textBitmapFor(ov, text);
  ctx.drawImage(bmp.canvas, b.x, b.y, b.w, b.h);
}

let tickerOffsets = {};
function drawTicker(ov) {
  const fs = ov.fontSize || 32;
  ctx.font = `bold ${fs}px ${fontStack(ov.font)}`;
  const y = ov.yPct/100*CH;
  const text = '      ' + (ov.text||'') + '      ';
  const tw = ctx.measureText(text).width || 1;
  if (tickerOffsets[ov.id] == null) tickerOffsets[ov.id] = CW;
  tickerOffsets[ov.id] -= (ov.speed||60)/60;
  if (tickerOffsets[ov.id] < -tw) tickerOffsets[ov.id] = CW;
  if (ov.bgOn) { ctx.fillStyle = ov.bgColor||'rgba(0,0,0,.6)'; ctx.fillRect(0, y-fs-6, CW, fs+18); }
  ctx.fillStyle = ov.color || '#fff';
  ctx.fillText(text, tickerOffsets[ov.id], y);
  ctx.fillText(text, tickerOffsets[ov.id]+tw, y);
}

// ── Selection chrome: dashed box + 8 drag handles, shared by overlays
//    and the face cam so both resize exactly the same way ──────────
const HANDLE_KEYS = ['nw','n','ne','e','se','s','sw','w'];
const HANDLE_CURSORS = { nw:'nwse-resize', se:'nwse-resize', ne:'nesw-resize', sw:'nesw-resize', n:'ns-resize', s:'ns-resize', e:'ew-resize', w:'ew-resize' };
function getHandlePoints(b) {
  const midX = b.x+b.w/2, midY = b.y+b.h/2;
  return {
    nw:{x:b.x, y:b.y}, n:{x:midX, y:b.y}, ne:{x:b.x+b.w, y:b.y},
    w:{x:b.x, y:midY}, e:{x:b.x+b.w, y:midY},
    sw:{x:b.x, y:b.y+b.h}, s:{x:midX, y:b.y+b.h}, se:{x:b.x+b.w, y:b.y+b.h},
  };
}
function drawSelectionHandles(b, showHandles) {
  ctx.save();
  ctx.globalAlpha = .9; ctx.strokeStyle = '#2d7fc1'; ctx.lineWidth = 2; ctx.setLineDash([6,3]);
  ctx.strokeRect(b.x-2, b.y-2, b.w+4, b.h+4);
  ctx.setLineDash([]);
  if (showHandles) {
    const pts = getHandlePoints(b);
    ctx.lineWidth = 1.5;
    HANDLE_KEYS.forEach(k => {
      const p = pts[k];
      ctx.fillStyle = '#2d7fc1'; ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI*2); ctx.fill(); ctx.stroke();
    });
  }
  ctx.restore();
}

// ── Face cam drawing + geometry ─────────────────────────────────
const camEl = document.createElement('video');
camEl.autoplay = true; camEl.muted = true; camEl.playsInline = true;
function faceCamBoxPx() {
  return { x: faceCam.xPct/100*CW, y: faceCam.yPct/100*CH, w: faceCam.wPct/100*CW, h: faceCam.hPct/100*CH };
}
function drawFaceCam() {
  if (!faceCam.active || !faceCam.visible || camEl.readyState < 2) return;
  const b = faceCamBoxPx();
  const vw = camEl.videoWidth, vh = camEl.videoHeight;
  if (!vw || !vh) return;

  // Crop the source video to the box's aspect ratio instead of stretching
  // it — the box (and the circle/square mask) can go non-uniform when
  // resized, but the face inside it never warps.
  const boxAspect = b.w / b.h, srcAspect = vw / vh;
  let sx, sy, sw, sh;
  if (srcAspect > boxAspect) { sh = vh; sw = vh*boxAspect; sy = 0; sx = (vw-sw)/2; }
  else { sw = vw; sh = vw/boxAspect; sx = 0; sy = (vh-sh)/2; }

  const cx = b.x+b.w/2, cy = b.y+b.h/2;
  ctx.save(); ctx.translate(cx, cy);
  if (faceCam.shape === 'circle') { ctx.beginPath(); ctx.ellipse(0,0,b.w/2,b.h/2,0,0,Math.PI*2); ctx.closePath(); ctx.clip(); }
  ctx.drawImage(camEl, sx, sy, sw, sh, -b.w/2, -b.h/2, b.w, b.h);
  ctx.restore();

  ctx.save(); ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 3;
  if (faceCam.shape === 'circle') { ctx.beginPath(); ctx.ellipse(0,0,b.w/2,b.h/2,0,0,Math.PI*2); ctx.stroke(); }
  else ctx.strokeRect(-b.w/2, -b.h/2, b.w, b.h);
  ctx.restore();

  if (selOvId === 'facecam') drawSelectionHandles(b, true);
}

// ── Canvas + screen-capture video element ───────────────────────
const canvas = document.getElementById('preview');
const ctx    = canvas.getContext('2d');
const vidEl  = document.createElement('video');
vidEl.autoplay = true; vidEl.muted = true; vidEl.playsInline = true;

function drawBase(targetScene) {
  const ovs = overlays[targetScene] || [];
  if (displayStream && vidEl.readyState >= 2) {
    ctx.drawImage(vidEl, 0, 0, CW, CH);
  } else {
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, CW, CH);
    ctx.fillStyle = '#2a2a2a'; ctx.font = '22px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No source — click Capture Screen in Controls', CW/2, CH/2);
    ctx.textAlign = 'left';
  }
  drawFaceCam();
  ovs.forEach(ov => {
    if (!ov.visible) return;
    ctx.save(); ctx.globalAlpha = ov.opacity;
    if (ov.type === 'ticker') {
      drawTicker(ov);
      if (ov.id === selOvId) drawSelectionHandles(getOvBounds(ov), false);
    } else {
      const b = getOvBounds(ov);
      if (ov.type === 'text') drawTextLikeOverlay(ov, ov.text||'', b);
      else if (ov.type === 'clock') drawTextLikeOverlay(ov, new Date().toLocaleTimeString([], ov.showSeconds===false ? {hour:'2-digit',minute:'2-digit'} : {}), b);
      else if (ov.type === 'countdown') {
        const remain = (ov.targetTs||0) - Date.now();
        drawTextLikeOverlay(ov, remain<=0 ? (ov.doneText||'00:00:00') : fmtHMS(remain), b);
      }
      else if (ov.type === 'image' && ov.img) {
        ctx.drawImage(ov.img, b.x, b.y, b.w, b.h);
      }
      if (ov.id === selOvId) drawSelectionHandles(b, !ov.locked);
    }
    ctx.restore();
  });
}

let transitionCanvas = null, transitionCtx = null;
function getTransitionCanvas() {
  if (!transitionCanvas) { transitionCanvas = document.createElement('canvas'); transitionCtx = transitionCanvas.getContext('2d'); }
  if (transitionCanvas.width!==CW || transitionCanvas.height!==CH) { transitionCanvas.width=CW; transitionCanvas.height=CH; }
  return transitionCanvas;
}
// Declared here, before frame() is first invoked below — frame() (and the
// drawing functions it calls on that first synchronous call) read these,
// so they must already be initialized.
let drag = null;
let snapGuideX = null, snapGuideY = null;
const SNAP_PTS = [0,50,100], SNAP_TOL = 2.2;
function snapVal(v) { for (const p of SNAP_PTS) if (Math.abs(v-p)<SNAP_TOL) return p; return v; }

function frame() {
  requestAnimationFrame(frame);
  if (transitionProgress) {
    // putImageData ignores globalAlpha, so a real cross-fade needs drawImage:
    // snapshot the "from" scene onto an offscreen canvas, draw the "to" scene
    // onto the main canvas, then blend the offscreen snapshot on top with
    // decreasing alpha (drawImage DOES respect globalAlpha).
    const t = Math.min(1, (performance.now()-transitionProgress.t0)/transitionProgress.dur);
    drawBase(transitionProgress.from);
    const tc = getTransitionCanvas();
    transitionCtx.clearRect(0,0,CW,CH);
    transitionCtx.drawImage(canvas, 0, 0);
    drawBase(transitionProgress.to);
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.drawImage(tc, 0, 0);
    ctx.restore();
    if (t >= 1) transitionProgress = null;
  } else {
    drawBase(activeId);
  }
  // Snap guides while dragging
  if (drag && drag.kind === 'overlay' && (snapGuideX!=null || snapGuideY!=null)) {
    ctx.save(); ctx.strokeStyle = 'rgba(125,197,242,.8)'; ctx.setLineDash([4,4]); ctx.lineWidth = 1;
    if (snapGuideX!=null) { const gx=snapGuideX/100*CW; ctx.beginPath(); ctx.moveTo(gx,0); ctx.lineTo(gx,CH); ctx.stroke(); }
    if (snapGuideY!=null) { const gy=snapGuideY/100*CH; ctx.beginPath(); ctx.moveTo(0,gy); ctx.lineTo(CW,gy); ctx.stroke(); }
    ctx.restore();
  }
}
frame();

// ── Canvas drag: move, resize (8 handles, Shift = keep proportions), snap ──
function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX-r.left)/r.width*CW, y: (e.clientY-r.top)/r.height*CH };
}
function hitOv(cx, cy) {
  const list = activeOvs();
  for (let i = list.length-1; i >= 0; i--) {
    const ov = list[i]; if (!ov.visible || ov.locked) continue;
    const b = getOvBounds(ov);
    if (cx>=b.x-4 && cx<=b.x+b.w+4 && cy>=b.y-4 && cy<=b.y+b.h+4) return ov;
  }
  return null;
}
function hitFaceCamAt(cx, cy) {
  if (!faceCam.active || !faceCam.visible) return false;
  const b = faceCamBoxPx();
  return cx>=b.x && cx<=b.x+b.w && cy>=b.y && cy<=b.y+b.h;
}
function hitOverlayHandle(ov, cx, cy) {
  if (!ov || ov.locked || !ov.visible || ov.type === 'ticker') return null;
  const pts = getHandlePoints(getOvBounds(ov));
  for (const k of HANDLE_KEYS) { const p = pts[k]; if (Math.abs(cx-p.x)<=9 && Math.abs(cy-p.y)<=9) return k; }
  return null;
}
function hitFaceCamHandle(cx, cy) {
  if (!faceCam.active || !faceCam.visible) return null;
  const pts = getHandlePoints(faceCamBoxPx());
  for (const k of HANDLE_KEYS) { const p = pts[k]; if (Math.abs(cx-p.x)<=9 && Math.abs(cy-p.y)<=9) return k; }
  return null;
}
// Resizes box `sb` by dragging handle `key` with a raw pixel delta (dx,dy)
// from the drag's start; keepAspect (Shift) locks proportions on a corner
// handle, anchored at the opposite corner — the same model as resizing an
// image or shape on a Google Slides canvas. Edge handles stay single-axis.
function applyResize(sb, key, dx, dy, keepAspect) {
  const { x, y, w, h } = sb;
  const MIN = 16;
  const hasN = key.includes('n'), hasS = key.includes('s');
  const hasW = key.includes('w'), hasE = key.includes('e');

  let nw = w, nh = h;
  if (hasE) nw = w + dx;
  if (hasW) nw = w - dx;
  if (hasS) nh = h + dy;
  if (hasN) nh = h - dy;
  nw = Math.max(MIN, nw); nh = Math.max(MIN, nh);

  if (keepAspect && w > 0 && h > 0 && (hasN||hasS) && (hasW||hasE)) {
    const ratio = w / h;
    if (Math.abs(nh/h - 1) > Math.abs(nw/w - 1)) nw = Math.max(MIN, nh*ratio);
    else nh = Math.max(MIN, nw/ratio);
  }

  return { x: hasW ? x+w-nw : x, y: hasN ? y+h-nh : y, w: nw, h: nh };
}
canvas.onmousedown = e => {
  const {x,y} = toCanvas(e);

  if (typeof selOvId === 'number') {
    const ov = activeOvs().find(o=>o.id===selOvId);
    const hk = hitOverlayHandle(ov, x, y);
    if (hk) {
      snapshot();
      drag = { kind:'resize-ov', ovId:ov.id, handle:hk, sx:x, sy:y, startBox:getOvBounds(ov) };
      canvas.style.cursor = HANDLE_CURSORS[hk]; canvas.classList.add('dragging'); e.preventDefault(); return;
    }
  }
  if (selOvId === 'facecam') {
    const hk = hitFaceCamHandle(x, y);
    if (hk) {
      drag = { kind:'resize-cam', handle:hk, sx:x, sy:y, startBox:faceCamBoxPx() };
      canvas.style.cursor = HANDLE_CURSORS[hk]; canvas.classList.add('dragging'); e.preventDefault(); return;
    }
  }

  const ov = hitOv(x,y);
  if (ov) {
    snapshot();
    drag = { kind:'overlay', ovId:ov.id, sx:x, sy:y, ox:ov.xPct, oy:ov.yPct };
    canvas.classList.add('dragging'); selOvId = ov.id; renderSources(); e.preventDefault(); return;
  }
  if (hitFaceCamAt(x,y)) {
    drag = { kind:'facecam', sx:x, sy:y, ox:faceCam.xPct, oy:faceCam.yPct };
    canvas.classList.add('dragging'); selOvId = 'facecam'; renderSources(); e.preventDefault();
  }
};
canvas.onmousemove = e => {
  const {x,y} = toCanvas(e);
  if (drag) {
    if (drag.kind === 'overlay') {
      const ov = activeOvs().find(o => o.id===drag.ovId);
      if (ov) {
        if (ov.type === 'ticker') {
          const ny = drag.oy+(y-drag.sy)/CH*100;
          const sny = snapVal(ny);
          snapGuideX = null; snapGuideY = sny!==ny ? sny : null;
          ov.yPct = pctClamp(sny);
        } else {
          const nx = drag.ox+(x-drag.sx)/CW*100, ny = drag.oy+(y-drag.sy)/CH*100;
          const snx = snapVal(nx), sny = snapVal(ny);
          snapGuideX = snx!==nx ? snx : null; snapGuideY = sny!==ny ? sny : null;
          ov.xPct = pctClamp(snx); ov.yPct = pctClamp(sny);
        }
      }
    } else if (drag.kind === 'facecam') {
      faceCam.xPct = pctClamp(drag.ox+(x-drag.sx)/CW*100);
      faceCam.yPct = pctClamp(drag.oy+(y-drag.sy)/CH*100);
    } else if (drag.kind === 'resize-ov') {
      const ov = activeOvs().find(o => o.id===drag.ovId);
      if (ov) {
        const nb = applyResize(drag.startBox, drag.handle, x-drag.sx, y-drag.sy, e.shiftKey);
        ov.xPct = nb.x/CW*100; ov.yPct = nb.y/CH*100; ov.wPct = nb.w/CW*100; ov.hPct = nb.h/CH*100;
      }
    } else if (drag.kind === 'resize-cam') {
      const nb = applyResize(drag.startBox, drag.handle, x-drag.sx, y-drag.sy, e.shiftKey);
      faceCam.xPct = nb.x/CW*100; faceCam.yPct = nb.y/CH*100; faceCam.wPct = nb.w/CW*100; faceCam.hPct = nb.h/CH*100;
    }
  } else {
    let cursor = '';
    if (typeof selOvId === 'number') {
      const hk = hitOverlayHandle(activeOvs().find(o=>o.id===selOvId), x, y);
      if (hk) cursor = HANDLE_CURSORS[hk];
    } else if (selOvId === 'facecam') {
      const hk = hitFaceCamHandle(x, y);
      if (hk) cursor = HANDLE_CURSORS[hk];
    }
    canvas.style.cursor = cursor;
    canvas.classList.toggle('can-drag', !cursor && !!(hitOv(x,y) || hitFaceCamAt(x,y)));
  }
};
canvas.onmouseup = canvas.onmouseleave = () => {
  drag = null; snapGuideX = snapGuideY = null; canvas.classList.remove('dragging'); canvas.style.cursor = '';
};

// ── Screen capture ─────────────────────────────────────────────
$('shareBtn').onclick = async () => {
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video:{frameRate:CFPS}, audio:true });
    vidEl.srcObject = displayStream;
    await vidEl.play().catch(()=>{});
    $('pbadge').textContent = 'Preview';
    $('goLiveBtn').disabled = false;
    $('shareBtn').disabled = true;
    $('resSelect').disabled = true;
    setStatus('ready', 'Source active');
    const at = displayStream.getAudioTracks();
    if (at.length) { attachMeter('desk', at[0], $('deskMeter')); connectDeskAudio(at[0]); }
    displayStream.getVideoTracks()[0].addEventListener('ended', stopAll);
    toast('Screen capture started');
  } catch { setStatus('', 'Capture cancelled'); }
};
$('deskMuteBtn').onclick = () => {
  deskMuted = !deskMuted;
  displayStream?.getAudioTracks().forEach(t => t.enabled = !deskMuted);
  $('deskMuteBtn').textContent = deskMuted ? '🔇' : '🔊';
  $('deskMuteBtn').classList.toggle('muted', deskMuted);
};
$('micToggle').onchange = async function() {
  if (this.checked) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio:true });
      attachMeter('mic', micStream.getAudioTracks()[0], $('micMeter'));
      connectMicAudio(micStream.getAudioTracks()[0]);
    } catch { this.checked = false; toast('Could not access microphone', 'error'); }
  } else {
    micStream?.getTracks().forEach(t=>t.stop()); micStream=null;
    meterStops.mic?.(); disconnectMicAudio();
  }
};
$('gateToggle').onchange = function() { gateOn = this.checked; $('gateThresh').disabled = !gateOn; };
$('gateThresh').oninput = function() { gateThreshold = this.value/1000; };
$('duckToggle').onchange = function() { duckOn = this.checked; };

// ── Face cam controls ────────────────────────────────────────────
$('camBtn').onclick = async () => {
  if (faceCam.active) {
    camStream?.getTracks().forEach(t=>t.stop()); camStream=null; camEl.srcObject=null;
    faceCam.active = false;
    $('camBtn').textContent = '🎥 Enable Face Cam';
    $('camSettings').style.display = 'none';
    if (selOvId === 'facecam') selOvId = null;
    renderSources();
    return;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video:true });
    camEl.srcObject = camStream;
    await camEl.play().catch(()=>{});
    faceCam.active = true; faceCam.visible = true;
    $('camBtn').textContent = '🎥 Disable Face Cam';
    $('camSettings').style.display = '';
    renderSources();
    toast('Face cam enabled — drag it on the preview');
  } catch { toast('Could not access the camera', 'error'); }
};
document.querySelectorAll('input[name=camShape]').forEach(r => r.onchange = () => {
  faceCam.shape = document.querySelector('input[name=camShape]:checked').value;
});
$('camSize').oninput = () => {
  // Slider sets a quick square size (matching old behavior); drag the
  // on-canvas handles afterward for a non-uniform resize.
  const v = parseInt($('camSize').value)||22;
  faceCam.wPct = v; faceCam.hPct = v * (CW/CH);
};

// ── Soundboard ───────────────────────────────────────────────────
function renderSoundboard() {
  const body = $('sfxBody'); body.innerHTML = '';
  if (!sounds.length) {
    const e=document.createElement('div'); e.className='src-empty sfx-empty';
    e.textContent='No sounds yet. Click + to upload MP3s.'; body.appendChild(e); return;
  }
  sounds.forEach(s => {
    const row=document.createElement('div'); row.className='sfx-row';
    row.innerHTML = `
      <button class="sfx-pad${s.activeCount>0?' playing':''}" data-play title="Click to play">
        ▶ ${s.name}${s.hotkey ? ` <span class="sfx-hk">[${s.hotkey}]</span>` : ''}
      </button>
      <span class="sfx-icon" data-rename title="Rename">✎</span>
      <span class="sfx-icon" data-vol title="Volume">🔊</span>
      <span class="sfx-icon" data-hotkey title="Set hotkey">⌨</span>
      <span class="sfx-del" data-del title="Remove">×</span>`;
    row.querySelector('[data-play]').onclick = () => playSound(s);
    row.querySelector('[data-rename]').onclick = () => {
      const n = prompt('Rename sound:', s.name); if (n) { s.name = n; renderSoundboard(); }
    };
    row.querySelector('[data-vol]').onclick = () => {
      const v = prompt('Volume for "'+s.name+'" (0-100):', Math.round((s.volume??1)*100));
      if (v !== null && !isNaN(parseFloat(v))) { s.volume = Math.max(0, Math.min(2, parseFloat(v)/100)); toast(s.name+' volume set'); }
    };
    row.querySelector('[data-hotkey]').onclick = () => {
      toast('Press a key to bind to "'+s.name+'"… (1-9 are reserved for scenes)');
      const handler = (e) => {
        e.preventDefault();
        if (/^[1-9]$/.test(e.key)) {
          toast('1-9 are reserved for scene switching — pick another key', 'error');
          window.removeEventListener('keydown', handler, true);
          return;
        }
        const bound = e.key.length===1 ? e.key.toUpperCase() : e.key;
        sounds.forEach(x => { if (x.hotkey === bound) x.hotkey = null; });
        s.hotkey = bound;
        renderSoundboard();
        window.removeEventListener('keydown', handler, true);
      };
      window.addEventListener('keydown', handler, true);
    };
    row.querySelector('[data-del]').onclick = () => { sounds = sounds.filter(x=>x.id!==s.id); renderSoundboard(); };
    body.appendChild(row);
  });
}
$('sfxAddBtn').onclick = () => $('sfxFile').click();
$('sfxFile').onchange = async function() {
  const files = Array.from(this.files || []);
  ensureAudioGraph();
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const buffer = await audioCtx.decodeAudioData(buf);
      sounds.push({ id: nextSoundId++, name: file.name.replace(/\.[^/.]+$/,''), buffer, activeCount:0, hotkey:null });
    } catch { toast(`Couldn't load "${file.name}"`, 'error'); }
  }
  this.value = ''; renderSoundboard();
};
// Drag-and-drop upload onto the soundboard panel
const sfxPanel = $('pSfx');
sfxPanel.ondragover = e => { e.preventDefault(); sfxPanel.classList.add('drop-hover'); };
sfxPanel.ondragleave = () => sfxPanel.classList.remove('drop-hover');
sfxPanel.ondrop = async e => {
  e.preventDefault(); sfxPanel.classList.remove('drop-hover');
  ensureAudioGraph();
  for (const file of Array.from(e.dataTransfer.files || [])) {
    if (!file.type.startsWith('audio/')) continue;
    try {
      const buffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
      sounds.push({ id: nextSoundId++, name: file.name.replace(/\.[^/.]+$/,''), buffer, activeCount:0, hotkey:null });
    } catch { toast(`Couldn't load "${file.name}"`, 'error'); }
  }
  renderSoundboard();
};
function playSound(sound) {
  ensureAudioGraph();
  const src = audioCtx.createBufferSource();
  src.buffer = sound.buffer;
  const g = audioCtx.createGain(); g.gain.value = sound.volume ?? 1;
  src.connect(g); g.connect(sfxGain);
  activeSfxSources.push(src);
  sound.activeCount = (sound.activeCount||0)+1; renderSoundboard();
  src.onended = () => {
    activeSfxSources = activeSfxSources.filter(s=>s!==src);
    sound.activeCount = Math.max(0,(sound.activeCount||1)-1); renderSoundboard();
  };
  src.start();
}
function stopAllSounds() { activeSfxSources.slice().forEach(s => { try{s.stop();}catch{} }); }
$('sfxStopBtn').onclick = stopAllSounds;
$('sfxVolume').oninput = () => { if (sfxGain) sfxGain.gain.value = $('sfxVolume').value/100; };
window.addEventListener('keydown', (e) => {
  if (e.target.isContentEditable || ['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
  const s = sounds.find(x => x.hotkey && x.hotkey.toLowerCase() === e.key.toLowerCase());
  if (s) playSound(s);
});

// ── WHIP + go live ────────────────────────────────────────────
function preferH264(pc) {
  try {
    const tr = pc.getTransceivers().find(t=>t.sender.track?.kind==='video');
    if (!tr?.setCodecPreferences) return true;
    const h264 = RTCRtpSender.getCapabilities('video').codecs.filter(c=>c.mimeType==='video/H264');
    if (h264.length) { tr.setCodecPreferences(h264); return true; }
    return false;
  } catch { return true; }
}
function iceReady(pc) {
  if (pc.iceGatheringState==='complete') return Promise.resolve();
  return new Promise(res=>{
    const check=()=>{ if(pc.iceGatheringState==='complete'){ pc.removeEventListener('icegatheringstatechange',check); res(); } };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(res, 4000);
  });
}
function checkH264Support() {
  try { return RTCRtpSender.getCapabilities('video').codecs.some(c=>c.mimeType==='video/H264'); }
  catch { return true; }
}

async function connectWhip(key) {
  const canvasStream = canvas.captureStream(CFPS);
  pc = new RTCPeerConnection();
  pc.addTrack(canvasStream.getVideoTracks()[0], canvasStream);
  const outAudio = mixDest.stream.getAudioTracks()[0];
  if (outAudio) pc.addTrack(outAudio, mixDest.stream);
  preferH264(pc);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await iceReady(pc);
  // A flaky network can silently drop packets instead of refusing the
  // connection, which leaves a bare fetch() hanging far longer than a user
  // will wait — so this is capped instead of left open-ended.
  const whipTimeout = new AbortController();
  const timeoutId = setTimeout(() => whipTimeout.abort(), 15000);
  let res;
  try {
    res = await fetch(WHIP, {
      method:'POST',
      headers:{ 'Content-Type':'application/sdp', 'Authorization':`Bearer ${key}` },
      body: pc.localDescription.sdp,
      signal: whipTimeout.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Timed out connecting to Twitch — check your network and try again');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) throw new Error(`Twitch rejected (HTTP ${res.status})`);
  whipRes = res.headers.get('Location');
  await pc.setRemoteDescription({ type:'answer', sdp: await res.text() });

  senderVideo = pc.getSenders().find(s=>s.track && s.track.kind==='video');
  await applyBitrateCap();

  pc.oniceconnectionstatechange = () => {
    if (!startTime) return; // not live / already stopped
    if ((pc.iceConnectionState==='disconnected' || pc.iceConnectionState==='failed') && reconnectAttempts < 3) {
      reconnectAttempts++;
      setStatus('', `Connection dropped — reconnecting (${reconnectAttempts}/3)…`);
      setTimeout(async () => {
        try { pc.close(); await connectWhip($('streamKey').value.trim()); setStatus('live','🔴 Live on Twitch'); }
        catch { if (reconnectAttempts>=3) { toast('Lost connection to Twitch', 'error'); stopAll(); } }
      }, 1500);
    }
  };
}
async function applyBitrateCap() {
  if (!senderVideo) return;
  try {
    const bps = BITRATE_PRESETS[$('bitrateSelect').value] || BITRATE_PRESETS.balanced;
    const params = senderVideo.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = bps;
    await senderVideo.setParameters(params);
  } catch {}
}

$('goLiveBtn').onclick = async () => {
  const key = $('streamKey').value.trim();
  if (!key) { setStatus('','Enter stream key first'); toast('Add your stream key first', 'error'); return; }
  if (!checkH264Support()) toast('No H264 encoder found — Twitch needs H264, stream may fail', 'error');
  $('goLiveBtn').disabled = true;
  setStatus('','Connecting to Twitch…');
  reconnectAttempts = 0;
  try {
    ensureAudioGraph();
    await connectWhip(key);
    startTime = Date.now();
    timerIv = setInterval(() => { $('sb-timer').textContent = fmtHMS(Date.now()-startTime); }, 1000);
    statsIv = setInterval(updateStreamStats, 2000);
    $('bDot').classList.add('live');
    $('livebadge').style.display='';
    $('sbTimerSeg').style.display='flex';
    $('goLiveBtn').style.display='none';
    $('stopBtn').style.display='';
    setStatus('live','🔴 Live on Twitch');
    toast('You are live');
  } catch(err) {
    console.error(err);
    $('goLiveBtn').disabled=false;
    setStatus('', err.message || 'Connection failed');
    toast(err.message || 'Could not connect to Twitch', 'error');
  }
};

let lastBytesSent = null, lastStatsTime = null;
async function updateStreamStats() {
  if (!pc) return;
  try {
    const stats = await pc.getStats();
    let bytesSent = null;
    stats.forEach(r => { if (r.type==='outbound-rtp' && r.kind==='video') bytesSent = r.bytesSent; });
    const now = performance.now();
    if (bytesSent != null && lastBytesSent != null) {
      const kbps = Math.round(((bytesSent-lastBytesSent)*8/1000) / ((now-lastStatsTime)/1000));
      $('sbBitrate').textContent = kbps + ' kbps';
      $('sbBitrate').style.display = '';
    }
    lastBytesSent = bytesSent; lastStatsTime = now;
    const state = pc.iceConnectionState;
    $('sbConn').className = 'sb-dot ' + (state==='connected'||state==='completed' ? 'ready' : state==='disconnected'||state==='failed' ? 'live' : '');
  } catch {}
}

// ── Stop ───────────────────────────────────────────────────────
async function stopAll() {
  clearInterval(timerIv); clearInterval(statsIv);
  startTime = null;
  if (whipRes) { try{ await fetch(whipRes,{method:'DELETE'}); }catch{} }
  if (pc) { pc.oniceconnectionstatechange = null; pc.close(); } pc=null; whipRes=null; senderVideo=null;
  [displayStream,micStream].forEach(s=>s?.getTracks().forEach(t=>t.stop()));
  displayStream=micStream=null;
  camStream?.getTracks().forEach(t=>t.stop()); camStream=null; camEl.srcObject=null;
  faceCam.active=false; $('camBtn').textContent='🎥 Enable Face Cam'; $('camSettings').style.display='none';
  if (deskAudioSrc) { try{deskAudioSrc.disconnect();}catch{} deskAudioSrc=null; }
  disconnectMicAudio();
  Object.values(meterStops).forEach(fn=>fn()); meterStops={};
  vidEl.srcObject=null;
  if (isRecording) stopRecording();
  $('bDot').classList.remove('live');
  $('livebadge').style.display='none';
  $('sbTimerSeg').style.display='none';
  $('sb-timer').textContent='00:00:00';
  $('sbBitrate').style.display='none';
  $('goLiveBtn').style.display=''; $('goLiveBtn').disabled=false;
  $('stopBtn').style.display='none';
  $('shareBtn').disabled=false; $('resSelect').disabled=false;
  $('deskMeter').style.width='0%'; $('micMeter').style.width='0%';
  $('pbadge').textContent='No source';
  if (selOvId==='facecam') selOvId=null;
  renderSources();
  setStatus('','Idle');
}
$('stopBtn').onclick = stopAll;

// ── Local recording + screenshot ────────────────────────────────
$('recordBtn').onclick = () => { isRecording ? stopRecording() : startRecording(); };
function startRecording() {
  try {
    const vStream = canvas.captureStream(CFPS);
    const aTrack = mixDest ? mixDest.stream.getAudioTracks()[0] : null;
    const combined = new MediaStream([...vStream.getVideoTracks(), ...(aTrack?[aTrack]:[])]);
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(combined, { mimeType: 'video/webm;codecs=vp9,opus' });
    mediaRecorder.ondataavailable = e => { if (e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type:'video/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `relay-recording-${Date.now()}.webm`;
      a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
    };
    mediaRecorder.start();
    isRecording = true; $('recordBtn').classList.add('live-rec'); $('recordBtn').title='Stop local recording';
    toast('Local recording started');
  } catch { toast('Recording not supported in this browser', 'error'); }
}
function stopRecording() {
  mediaRecorder?.stop(); isRecording = false;
  $('recordBtn').classList.remove('live-rec'); $('recordBtn').title='Start local recording';
  toast('Recording saved to Downloads');
}
$('screenshotBtn').onclick = () => {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `relay-screenshot-${Date.now()}.png`;
  a.click();
  toast('Screenshot saved');
};

// ── Settings: resolution, bitrate, theme ────────────────────────
Object.entries(RES_PRESETS).forEach(([k,v]) => {
  const o = document.createElement('option'); o.value=k; o.textContent=v.label;
  if (k==='720p30') o.selected = true;
  $('resSelect').appendChild(o);
});
$('resSelect').onchange = function() {
  const p = RES_PRESETS[this.value]; if (!p) return;
  CW=p.w; CH=p.h; CFPS=p.fps;
  canvas.width=CW; canvas.height=CH;
  toast(`Resolution set to ${p.label}`);
};
$('bitrateSelect').onchange = applyBitrateCap;
$('transitionToggle').onchange = function() { transitionMode = this.checked ? 'fade' : 'cut'; };
$('highContrastToggle').onchange = function() {
  highContrast = this.checked;
  document.body.classList.toggle('high-contrast', highContrast);
};
$('capsToggle').onchange = function() { $('streamKey').type = this.checked ? 'text' : 'password'; };

// ── Captions (Web Speech API, best-effort) ──────────────────────
let recognizer = null, captionsOn = false;
$('captionsToggle').onchange = function() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { this.checked=false; toast('Live captions are not supported in this browser', 'error'); return; }
  captionsOn = this.checked;
  if (captionsOn) {
    recognizer = new SR(); recognizer.continuous = true; recognizer.interimResults = true;
    recognizer.onresult = (e) => {
      let text = '';
      for (let i=e.resultIndex; i<e.results.length; i++) text += e.results[i][0].transcript;
      $('captionOverlayText').textContent = text.slice(-120);
    };
    recognizer.onerror = () => {};
    recognizer.onend = () => { if (captionsOn) { try { recognizer.start(); } catch {} } };
    try { recognizer.start(); } catch {}
  } else {
    try { recognizer?.stop(); } catch {}
    $('captionOverlayText').textContent = '';
  }
};

// ── Menu bar ─────────────────────────────────────────────────────
function closeMenus() { document.querySelectorAll('.menu-dd').forEach(d => d.classList.remove('open')); }
document.querySelectorAll('.mitem').forEach(m => {
  m.onclick = (e) => {
    e.stopPropagation();
    const dd = m.nextElementSibling;
    const wasOpen = dd.classList.contains('open');
    closeMenus();
    if (!wasOpen) dd.classList.add('open');
  };
});
document.addEventListener('click', closeMenus);
$('menuExport').onclick = exportProject;
$('menuImport').onclick = () => $('importFile').click();
$('importFile').onchange = importProject;
$('menuUndo').onclick = undo;
$('menuRedo').onclick = redo;
$('menuHighContrast').onclick = () => { $('highContrastToggle').click(); };
$('menuAbout').onclick = () => toast('Relay v' + RELAY_VERSION);
$('menuHelp').onclick = () => { $('walkthrough').classList.remove('hidden'); walkStep = 0; renderWalkStep(); };

// ── Export / import project ──────────────────────────────────────
function exportProject() {
  const data = {
    version: RELAY_VERSION, scenes, activeId, nextSId, nextOId,
    overlays: Object.fromEntries(Object.entries(overlays).map(([k,v]) => [k, v.map(o => {
      const { img, ...rest } = o; return rest; // images can't survive JSON export
    })])),
  };
  const blob = new Blob([JSON.stringify(data,null,2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'relay-project.json'; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  toast('Project exported (image overlays are not included)');
}
function importProject(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      scenes = data.scenes; activeId = data.activeId; nextSId = data.nextSId; nextOId = data.nextOId;
      overlays = data.overlays;
      selOvId = null; renderScenes(); renderSources();
      toast('Project imported');
    } catch { toast('Could not read that project file', 'error'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}
// Offer to restore the last auto-saved session (metadata only, not media)
window.addEventListener('beforeunload', () => {
  try { localStorage.setItem('relay-last-session', JSON.stringify({ scenes, overlays: Object.fromEntries(Object.entries(overlays).map(([k,v])=>[k,v.map(({img,...r})=>r)])), activeId, nextSId, nextOId, t: Date.now() })); } catch {}
});
(function offerRestore() {
  try {
    const raw = localStorage.getItem('relay-last-session');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Date.now() - data.t > 1000*60*60*12) return; // only offer within 12h
    $('restoreBar').style.display = 'flex';
    $('restoreYes').onclick = () => {
      scenes=data.scenes; overlays=data.overlays; activeId=data.activeId; nextSId=data.nextSId; nextOId=data.nextOId;
      renderScenes(); renderSources(); $('restoreBar').style.display='none'; toast('Session restored');
    };
    $('restoreNo').onclick = () => { $('restoreBar').style.display='none'; localStorage.removeItem('relay-last-session'); };
  } catch {}
})();

// ── Panic button + global hotkeys ────────────────────────────────
function panic() {
  if (!deskMuted) $('deskMuteBtn').click();
  if ($('micToggle').checked) $('micToggle').click();
  if (faceCam.active && faceCam.visible) faceCam.visible = false;
  renderSources();
  toast('Panic: desktop + mic muted, cam hidden');
}
$('panicBtn').onclick = panic;
window.addEventListener('keydown', (e) => {
  if (e.target.isContentEditable || ['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key === 'F9') panic();
  if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z' && !e.shiftKey) { e.preventDefault(); undo(); }
  if ((e.ctrlKey||e.metaKey) && (e.key.toLowerCase()==='y' || (e.key.toLowerCase()==='z'&&e.shiftKey))) { e.preventDefault(); redo(); }
  if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
    const s = scenes[parseInt(e.key)-1]; if (s) switchScene(s.id);
  }
});

// ── Web MIDI (best-effort pad triggers: any Note On plays sound N) ─
if (navigator.requestMIDIAccess) {
  navigator.requestMIDIAccess().then(access => {
    for (const input of access.inputs.values()) {
      input.onmidimessage = (msg) => {
        const [status, note, vel] = msg.data;
        if ((status & 0xf0) === 0x90 && vel > 0) {
          const idx = note % Math.max(1, sounds.length);
          if (sounds[idx]) playSound(sounds[idx]);
        }
      };
    }
  }).catch(()=>{});
}

// ── Collapsible dock panels ───────────────────────────────────────
document.querySelectorAll('.dp-hd[data-collapsible]').forEach(hd => {
  const panel = hd.closest('.dp');
  hd.querySelector('.collapse-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('collapsed');
  });
});

// ── First-run walkthrough ─────────────────────────────────────────
const WALK_STEPS = [
  { t:'Welcome to Relay', d:'A free, open streaming tool styled after OBS. Capture your screen, add overlays, and go live on Twitch — no watermark, nothing installed.' },
  { t:'1. Capture your screen', d:'Controls → Capture Screen picks the screen, window, or tab to broadcast.' },
  { t:'2. Add overlays', d:'Sources → + adds text, images, a clock, countdown, or scrolling ticker. Drag them right on the preview.' },
  { t:'3. Soundboard & face cam', d:'Upload MP3s to play during your stream, and optionally add a webcam bubble — both are in the dock.' },
  { t:'4. Go live', d:'Paste your Twitch stream key into Controls and click Start Streaming.' },
];
let walkStep = 0;
function renderWalkStep() {
  const s = WALK_STEPS[walkStep];
  $('walkTitle').textContent = s.t; $('walkDesc').textContent = s.d;
  $('walkDots').innerHTML = WALK_STEPS.map((_,i)=>`<span class="wdot${i===walkStep?' on':''}"></span>`).join('');
  $('walkPrev').disabled = walkStep===0;
  $('walkNext').textContent = walkStep===WALK_STEPS.length-1 ? 'Done' : 'Next';
}
$('walkPrev').onclick = () => { walkStep=Math.max(0,walkStep-1); renderWalkStep(); };
$('walkNext').onclick = () => {
  if (walkStep===WALK_STEPS.length-1) { $('walkthrough').classList.add('hidden'); localStorage.setItem('relay-walked','1'); }
  else { walkStep++; renderWalkStep(); }
};
$('walkSkip').onclick = () => { $('walkthrough').classList.add('hidden'); localStorage.setItem('relay-walked','1'); };

// ── Overlay add/edit modal ─────────────────────────────────────────
function typeVal() { return document.querySelector('input[name=ovType]:checked').value; }
// True once the user edits ovW/ovH directly, or when editing an existing
// overlay — stops the live auto-size preview from overriding a deliberate size.
let sizeTouched = false;
function autoSizeFields() {
  if (sizeTouched) return;
  const type = typeVal();
  if (type === 'ticker' || type === 'image') return;
  const fs = parseInt($('ovSize').value)||36;
  const sample = (type==='clock'||type==='countdown') ? '00:00:00' : ($('ovText').value || 'Text');
  ctx.font = `bold ${fs}px ${fontStack($('ovFont').value)}`;
  const w = Math.max(24, ctx.measureText(sample).width);
  $('ovW').value = (w/CW*100).toFixed(1);
  $('ovH').value = (fs*1.15/CH*100).toFixed(1);
}
function syncModalFieldVisibility() {
  const t = typeVal();
  $('fldTextContent').style.display = (t==='text'||t==='ticker') ? '' : 'none';
  $('fldTextStyle').style.display = (t==='text'||t==='clock'||t==='countdown'||t==='ticker') ? '' : 'none';
  $('fldClock').style.display = t==='clock' ? '' : 'none';
  $('fldCountdown').style.display = t==='countdown' ? '' : 'none';
  $('fldTicker').style.display = t==='ticker' ? '' : 'none';
  $('imgFields').style.display = t==='image' ? '' : 'none';
  $('fldPosition').style.display = t==='ticker' ? 'none' : ''; // ticker spans full width
  $('fldSize').style.display = t==='ticker' ? 'none' : '';
  $('fldSizeHint').style.display = t==='ticker' ? 'none' : '';
  autoSizeFields();
}
$('ovOpacity').oninput = () => $('opPct').textContent = $('ovOpacity').value;
document.querySelectorAll('input[name=ovType]').forEach(r => r.onchange = syncModalFieldVisibility);
$('ovText').oninput = autoSizeFields;
$('ovSize').oninput = autoSizeFields;
$('ovFont').onchange = autoSizeFields;
$('ovW').oninput = () => { sizeTouched = true; };
$('ovH').oninput = () => { sizeTouched = true; };

function resetModal() {
  document.querySelector('input[name=ovType][value=text]').checked = true;
  $('ovText').value=''; $('ovSize').value='36'; $('ovColor').value='#ffffff'; $('ovFont').value='sans';
  $('ovBgOn').checked=false; $('ovBgColor').value='#000000';
  $('ovShadow').checked=false; $('ovStroke').checked=false; $('ovStrokeColor').value='#000000';
  $('ovFile').value='';
  $('ovX').value='5'; $('ovY').value='90'; $('ovW').value='25'; $('ovH').value='10';
  $('ovOpacity').value='100'; $('opPct').textContent='100';
  $('ovShowSeconds').checked=true;
  $('ovCountdownMin').value='5'; $('ovDoneText').value='LIVE NOW';
  $('ovTickerSpeed').value='60';
  sizeTouched = false;
  syncModalFieldVisibility();
}
function openAdd() {
  editOvId=null; $('modalTitle').textContent='Add Source'; $('modalSave').textContent='Add';
  resetModal(); $('modal-wrap').classList.remove('hidden');
}
function openEdit(ov) {
  editOvId=ov.id; $('modalTitle').textContent='Edit Source'; $('modalSave').textContent='Save';
  resetModal();
  if (ov.type !== 'ticker') ensureOvBox(ov); // migrate a legacy overlay's size before reading it below
  document.querySelector(`input[name=ovType][value=${ov.type}]`).checked=true;
  if (ov.type==='text'||ov.type==='ticker') $('ovText').value = ov.text||'';
  if (ov.type!=='image') {
    $('ovSize').value=ov.fontSize||36; $('ovColor').value=ov.color||'#ffffff'; $('ovFont').value=ov.font||'sans';
    $('ovBgOn').checked=!!ov.bgOn; $('ovBgColor').value=ov.bgColor||'#000000';
    $('ovShadow').checked=!!ov.shadow; $('ovStroke').checked=!!ov.stroke; $('ovStrokeColor').value=ov.strokeColor||'#000000';
  }
  if (ov.type==='clock') $('ovShowSeconds').checked = ov.showSeconds!==false;
  if (ov.type==='countdown') { $('ovDoneText').value = ov.doneText||'LIVE NOW'; }
  if (ov.type==='ticker') $('ovTickerSpeed').value = ov.speed||60;
  $('ovX').value=Math.round(ov.xPct); $('ovY').value=Math.round(ov.yPct);
  if (ov.type !== 'ticker') { $('ovW').value = ov.wPct.toFixed(1); $('ovH').value = ov.hPct.toFixed(1); }
  sizeTouched = true; // this overlay already has a size — don't let autoSizeFields override it
  const op=Math.round((ov.opacity??1)*100); $('ovOpacity').value=op; $('opPct').textContent=op;
  syncModalFieldVisibility();
  $('modal-wrap').classList.remove('hidden');
}
function closeModal() { $('modal-wrap').classList.add('hidden'); }
$('modalX').onclick = $('modalCancel').onclick = closeModal;
$('addSrcBtn').onclick = openAdd;

function loadImg(file) {
  return new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=e=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=e.target.result; };
    r.onerror=rej; r.readAsDataURL(file);
  });
}

function readCommonFields(type) {
  const base = {
    xPct: parseFloat($('ovX').value)||0,
    yPct: parseFloat($('ovY').value)||0,
    opacity: (parseInt($('ovOpacity').value)||100)/100,
  };
  if (type !== 'ticker') {
    base.wPct = Math.max(1, parseFloat($('ovW').value)||25);
    base.hPct = Math.max(1, parseFloat($('ovH').value)||10);
  }
  if (type !== 'image') {
    Object.assign(base, {
      fontSize: parseInt($('ovSize').value)||36, color: $('ovColor').value, font: $('ovFont').value,
      bgOn: $('ovBgOn').checked, bgColor: $('ovBgColor').value,
      shadow: $('ovShadow').checked, stroke: $('ovStroke').checked, strokeColor: $('ovStrokeColor').value,
    });
  }
  return base;
}

$('modalSave').onclick = async () => {
  const type = typeVal();
  const common = readCommonFields(type);
  snapshot();

  if (editOvId) {
    const ov = overlays[activeId].find(o => o.id === editOvId);
    if (ov) {
      ov.type = type; Object.assign(ov, common);
      if (type==='text'||type==='ticker') ov.text = $('ovText').value || 'Text';
      if (type==='clock') ov.showSeconds = $('ovShowSeconds').checked;
      if (type==='countdown') { ov.targetTs = Date.now() + (parseFloat($('ovCountdownMin').value)||5)*60000; ov.doneText = $('ovDoneText').value||'LIVE NOW'; }
      if (type==='ticker') ov.speed = parseFloat($('ovTickerSpeed').value)||60;
      if (type==='image') {
        const f = $('ovFile').files[0]; if (f) ov.img = await loadImg(f);
      }
      ov.label = labelFor(type, ov);
    }
  } else {
    const id = nextOId++;
    const ov = { id, type, visible:true, locked:false, ...common };
    if (type==='text'||type==='ticker') ov.text = $('ovText').value || 'Text';
    if (type==='clock') ov.showSeconds = $('ovShowSeconds').checked;
    if (type==='countdown') { ov.targetTs = Date.now() + (parseFloat($('ovCountdownMin').value)||5)*60000; ov.doneText = $('ovDoneText').value||'LIVE NOW'; }
    if (type==='ticker') ov.speed = parseFloat($('ovTickerSpeed').value)||60;
    if (type==='image') {
      const f = $('ovFile').files[0];
      if (!f) { toast('Select an image file first', 'error'); undoStack.pop(); return; }
      ov.img = await loadImg(f);
      if (!sizeTouched) {
        // Keep the chosen width, but derive height from the image's own
        // aspect ratio so a freshly-added image isn't stretched by default.
        ov.hPct = ov.img.naturalHeight*(ov.wPct/100*CW/ov.img.naturalWidth)/CH*100;
      }
    }
    ov.label = labelFor(type, ov);
    overlays[activeId].push(ov);
    selOvId = id;
  }
  renderSources(); closeModal();
};
function labelFor(type, ov) {
  if (type==='text') return (ov.text||'Text').slice(0,20);
  if (type==='ticker') return 'Ticker: '+(ov.text||'').slice(0,14);
  if (type==='clock') return 'Clock';
  if (type==='countdown') return 'Countdown';
  if (type==='image') return (ov.img ? 'Image' : 'Image').slice(0,20);
  return 'Source';
}

// ── Init ───────────────────────────────────────────────────────
renderScenes(); renderSources(); renderSoundboard(); setStatus('','Idle');
$('verLabel').textContent = 'Relay v' + RELAY_VERSION;
try {
  if (!localStorage.getItem('relay-walked')) { walkStep = 0; renderWalkStep(); $('walkthrough').classList.remove('hidden'); }
} catch {}
