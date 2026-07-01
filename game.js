(function(){
"use strict";

/* ===================================================================
   AUDIO
=================================================================== */
let actx = null;
let muted = false;
function ensureAudio(){ if(!actx){ try{ actx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } }
function tone(freq, start, dur, type, vol, glideTo){
  if(muted || !actx) return;
  const t0 = actx.currentTime + start;
  const osc = actx.createOscillator();
  const gain = actx.createGain();
  osc.type = type || 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  if(glideTo) osc.frequency.linearRampToValueAtTime(glideTo, t0+dur);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol||0.18, t0+0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, t0+dur);
  osc.connect(gain); gain.connect(actx.destination);
  osc.start(t0); osc.stop(t0+dur+0.02);
}
function playCorrect(){ ensureAudio(); tone(520,0,.09,'sine',.2); tone(780,.08,.14,'sine',.2); }
function playWrong(){ ensureAudio(); tone(180,0,.18,'sawtooth',.15,110); }
function playComplete(){ ensureAudio(); [523,659,784,1047].forEach((f,i)=>tone(f,i*0.11,.18,'triangle',.18)); }
function playTick(){ ensureAudio(); tone(900,0,.04,'square',.06); }
function playFail(){ ensureAudio(); tone(200,0,.3,'sawtooth',.16,70); tone(150,.25,.35,'sawtooth',.14,60); }
function playHint(){ ensureAudio(); tone(660,0,.08,'sine',.12); }
function playClick(){ ensureAudio(); tone(400,0,.05,'sine',.08); }

/* ===================================================================
   STORAGE (persistent across sessions)
=================================================================== */
const STORAGE_KEY = 'ecg-rhythmlab-progress-v1';
let progress = { levels:{}, playerName:'' }; // levels[id] = {stars, bestTimeSec, completed}

async function loadProgress(){
  try{
    const r = await window.storage.get(STORAGE_KEY, false);
    if(r && r.value){ progress = JSON.parse(r.value); }
  }catch(e){ /* no saved data yet */ }
}
async function saveProgress(){
  try{ await window.storage.set(STORAGE_KEY, JSON.stringify(progress), false); }catch(e){}
}

/* ===================================================================
   LEVEL DATA (15 ECG rhythms)
=================================================================== */
const LEVELS = [
  {id:1, name:"Normal Sinus Rhythm", tier:"Warm-up", accent:"#39ff88", period:70, amp:46, time:100, fact:"The heart's default rhythm: a P wave, a sharp QRS, then a T wave — regular as clockwork, 60–100 bpm."},
  {id:2, name:"Sinus Bradycardia", tier:"Warm-up", accent:"#4dd0e1", period:100, amp:44, time:95, fact:"Same shape as normal sinus, just slower — under 60 bpm. Common in athletes and during sleep."},
  {id:3, name:"Sinus Tachycardia", tier:"Warm-up", accent:"#ffd54a", period:44, amp:42, time:90, fact:"The same friendly beat, sped up past 100 bpm — often from exercise, fever, or stress."},
  {id:4, name:"Atrial Fibrillation", tier:"Warm-up", accent:"#ff9f43", period:60, amp:44, irregular:true, afib:true, time:85, fact:"Chaotic quivering baseline, no clear P waves, and an 'irregularly irregular' beat-to-beat spacing."},
  {id:5, name:"Atrial Flutter", tier:"Warm-up", accent:"#ffb020", period:70, amp:42, sawtooth:true, time:80, fact:"A classic sawtooth baseline ('flutter waves') at a steady, rapid rate — like a picket fence."},

  {id:6, name:"Premature Ventricular Contraction", tier:"Core", accent:"#ff6b9d", period:72, amp:46, pvcEvery:4, time:130, fact:"An early, wide, bizarre-looking beat that jumps the queue from the ventricles, then a pause."},
  {id:7, name:"Bigeminy", tier:"Core", accent:"#b388ff", period:66, amp:44, wide:true, alternate:true, time:125, fact:"Every normal beat is followed by a PVC — a repeating 'normal-abnormal' two-step pattern."},
  {id:8, name:"First-Degree AV Block", tier:"Core", accent:"#26c6da", period:74, amp:44, longPR:true, time:120, fact:"The signal from atria to ventricles is simply delayed — a stretched-out gap before every QRS."},
  {id:9, name:"Wenckebach (2° AV Block)", tier:"Core", accent:"#a5d76e", period:66, amp:44, wenckebach:true, time:115, fact:"The PR interval grows longer with each beat... until one QRS is dropped entirely. Then it resets."},
  {id:10, name:"Complete Heart Block", tier:"Core", accent:"#ff7043", period:70, amp:42, dissociation:true, time:110, fact:"Atria and ventricles beat on two completely independent clocks — total electrical divorce."},

  {id:11, name:"Supraventricular Tachycardia", tier:"Advanced", accent:"#ec4899", period:30, amp:40, fast:true, time:170, fact:"A very fast, narrow-complex rhythm — often 150–220 bpm, with P waves hidden in the prior T wave."},
  {id:12, name:"Ventricular Tachycardia", tier:"Advanced", accent:"#ff4757", period:34, amp:52, wide:true, fast:true, time:160, fact:"Wide, fast, regular beats with no visible P waves — a rhythm that demands urgent attention."},
  {id:13, name:"Ventricular Fibrillation", tier:"Advanced", accent:"#d90429", period:0, amp:50, chaotic:true, time:150, fact:"No organized beats at all — just chaotic squiggles. The heart quivers instead of pumping."},
  {id:14, name:"ST-Elevation (STEMI)", tier:"Advanced", accent:"#e63946", period:74, amp:46, stElevation:true, time:140, fact:"The segment right after the QRS lifts upward — a classic sign of an evolving heart attack."},
  {id:15, name:"Asystole", tier:"Advanced", accent:"#9aa5a1", period:0, amp:0, flat:true, time:130, fact:"Flatline. No electrical activity at all — the final rhythm every clinician trains hardest to prevent."},
];

const TIERS_GRID = {"Warm-up":3, "Core":4, "Advanced":5};

function gridSizeFor(level){ return TIERS_GRID[level.tier]; }

/* ===================================================================
   WAVEFORM GENERATION -> renders full puzzle artwork to a canvas
=================================================================== */
const ART_W = 480, ART_H = 300;

function bump(x, center, width, amp){
  const d = (x - center) / width;
  return amp * Math.exp(-d*d);
}

function beatContribution(x, beatStart, period, cfg, opts){
  opts = opts || {};
  const dropped = !!opts.dropped;
  const wide = !!opts.wide;
  const prExtra = opts.prExtra || 0;
  let y = 0;
  const p = period;
  // P wave
  if(!cfg.afib && !opts.noP){
    y += bump(x, beatStart + p*0.15 + prExtra, p*0.05, -0.11*cfg.amp);
  } else if(cfg.afib){
    y += (Math.sin(x*0.9)+Math.sin(x*1.7))*cfg.amp*0.025;
  }
  if(dropped) return y;
  const qc = beatStart + p*0.27 + prExtra;
  const rc = beatStart + p*0.30 + prExtra;
  const sc = beatStart + p*0.335 + prExtra;
  if(wide){
    y += bump(x, rc, p*0.05, -0.62*cfg.amp);
    y += bump(x, sc+p*0.03, p*0.06, 0.5*cfg.amp);
    y += bump(x, beatStart + p*0.5 + prExtra, p*0.12, cfg.stElevDir ? -0.22*cfg.amp : 0.2*cfg.amp);
  } else {
    y += bump(x, qc, p*0.012, 0.08*cfg.amp);
    y += bump(x, rc, p*0.016, -1.0*cfg.amp);
    y += bump(x, sc, p*0.02, 0.32*cfg.amp);
    let stShift = 0;
    if(cfg.stElevation){ stShift = -0.14*cfg.amp; }
    if(stShift){
      const stCenter = beatStart + p*0.42 + prExtra;
      y += bump(x, stCenter, p*0.09, stShift);
    }
    y += bump(x, beatStart + p*0.55 + prExtra, p*0.09, -0.26*cfg.amp);
  }
  return y;
}

function buildWaveformPoints(cfg, W, H){
  const baseline = H*0.56;
  const pts = [];
  const step = 2;

  if(cfg.flat){
    for(let x=0;x<=W;x+=step){ pts.push({x, y: baseline + (Math.random()-0.5)*2.5}); }
    return pts;
  }
  if(cfg.chaotic){
    let y = 0;
    for(let x=0;x<=W;x+=step){
      y += (Math.random()-0.5)*cfg.amp*0.55;
      y *= 0.86;
      pts.push({x, y: baseline + y});
    }
    return pts;
  }

  // build list of beats
  const beats = [];
  let cursor = -cfg.period;
  let idx = 0;
  let prExtraAcc = 0;
  while(cursor < W + cfg.period*2){
    let period = cfg.period * (cfg.fast ? 1 : 1);
    let dropped = false;
    let prExtra = 0;
    let wide = !!cfg.wide;

    if(cfg.irregular){ period = cfg.period * (0.65 + Math.random()*0.7); }
    if(cfg.pvcEvery){ wide = (idx % cfg.pvcEvery === cfg.pvcEvery-1); if(wide) period = cfg.period*1.35; }
    if(cfg.alternate){ wide = (idx % 2 === 1); }
    if(cfg.longPR){ prExtra = -cfg.period*0.09; }
    if(cfg.wenckebach){
      const cyc = idx % 4;
      prExtra = -cyc*cfg.period*0.045;
      dropped = (cyc === 3);
    }
    if(cfg.sawtooth){
      // handled separately below; still add QRS every 3rd
      dropped = (idx % 3 !== 2);
    }

    beats.push({start:cursor, period, dropped, wide, prExtra});
    cursor += period;
    idx++;
  }

  // dissociation: independent P wave train
  let pBeats = [];
  if(cfg.dissociation){
    let pc = -cfg.period*0.6;
    while(pc < W + cfg.period){ pBeats.push(pc); pc += cfg.period*0.62; }
  }

  for(let x=0;x<=W;x+=step){
    let y = 0;
    for(const b of beats){
      if(x > b.start - cfg.period*0.15 && x < b.start + b.period){
        y += beatContribution(x, b.start, b.period, cfg, {dropped:b.dropped, wide:b.wide, prExtra:b.prExtra, noP: cfg.dissociation});
      }
    }
    if(cfg.dissociation){
      for(const ps of pBeats){
        y += bump(x, ps, cfg.period*0.05, -0.1*cfg.amp);
      }
    }
    if(cfg.sawtooth){
      y += Math.abs(((x*1.6) % (cfg.period*0.5)) - cfg.period*0.25) * 0.24 - cfg.period*0.03;
    }
    pts.push({x, y: baseline + y});
  }
  return pts;
}

function renderLevelArt(canvas, level){
  canvas.width = ART_W; canvas.height = ART_H;
  const ctx = canvas.getContext('2d');
  // background
  const g = ctx.createRadialGradient(ART_W/2,0,10,ART_W/2,ART_H/2,ART_W*0.8);
  g.addColorStop(0,'#0c1b14'); g.addColorStop(1,'#040a08');
  ctx.fillStyle = g; ctx.fillRect(0,0,ART_W,ART_H);

  // grid paper
  ctx.strokeStyle = 'rgba(57,255,136,0.07)'; ctx.lineWidth = 1;
  for(let x=0;x<ART_W;x+=10){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,ART_H); ctx.stroke(); }
  for(let y=0;y<ART_H;y+=10){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(ART_W,y); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(57,255,136,0.16)'; ctx.lineWidth = 1;
  for(let x=0;x<ART_W;x+=50){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,ART_H); ctx.stroke(); }
  for(let y=0;y<ART_H;y+=50){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(ART_W,y); ctx.stroke(); }

  // waveform
  const pts = buildWaveformPoints(level, ART_W, ART_H);
  ctx.save();
  ctx.shadowColor = level.accent; ctx.shadowBlur = 10;
  ctx.strokeStyle = level.accent; ctx.lineWidth = 3; ctx.lineJoin='round'; ctx.lineCap='round';
  ctx.beginPath();
  pts.forEach((p,i)=>{ i===0? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y); });
  ctx.stroke();
  ctx.restore();

  // scanning highlight line (decorative, static render)
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, ART_H*0.56); ctx.lineTo(ART_W, ART_H*0.56); ctx.stroke();

  // label banner
  ctx.fillStyle = 'rgba(2,6,5,0.68)';
  ctx.fillRect(0, ART_H-38, ART_W, 38);
  ctx.fillStyle = level.accent;
  ctx.font = '700 15px JetBrains Mono, monospace';
  ctx.textBaseline='middle';
  ctx.fillText(level.name.toUpperCase(), 12, ART_H-19);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '600 10px JetBrains Mono, monospace';
  ctx.fillText('LEAD II · 25mm/s', ART_W-140, ART_H-19);
}

/* ===================================================================
   HERO CANVAS (home page live animated strip)
=================================================================== */
function initHero(){
  const canvas = document.getElementById('heroCanvas');
  const ctx = canvas.getContext('2d');
  function resize(){ canvas.width = canvas.clientWidth * devicePixelRatio; canvas.height = canvas.clientHeight * devicePixelRatio; }
  resize(); window.addEventListener('resize', resize);
  const cfg = {period:70, amp:34, afib:false};
  let offset = 0;
  function frame(){
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0,0,W,H);
    ctx.strokeStyle='rgba(57,255,136,0.9)';
    ctx.shadowColor='#39ff88'; ctx.shadowBlur=12*devicePixelRatio;
    ctx.lineWidth = 2.4*devicePixelRatio;
    ctx.beginPath();
    const baseline = H*0.55;
    for(let x=0;x<W;x+=3){
      const xs = x + offset;
      let y=0;
      let localBeat = Math.floor(xs / (cfg.period*devicePixelRatio));
      const bstart = localBeat*(cfg.period*devicePixelRatio);
      y += beatContribution(xs, bstart, cfg.period*devicePixelRatio, {amp:cfg.amp*devicePixelRatio, afib:false}, {});
      const yy = baseline + y;
      x===0? ctx.moveTo(x,yy) : ctx.lineTo(x,yy);
    }
    ctx.stroke();
    offset += 3.2*devicePixelRatio;
    requestAnimationFrame(frame);
  }
  frame();
}

/* ===================================================================
   NAVIGATION
=================================================================== */
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0,0);
}
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._tm); t._tm = setTimeout(()=>t.classList.remove('show'), 2200);
}

/* ===================================================================
   LEVEL SELECT RENDER
=================================================================== */
function starsString(n){
  n = n||0;
  return '⭐'.repeat(n) + '<span style="opacity:.25">' + '⭐'.repeat(3-n) + '</span>';
}
function badgeForStars(n){
  if(n>=3) return '🥇';
  if(n===2) return '🥈';
  if(n===1) return '🥉';
  return '';
}
function isUnlocked(levelId){
  if(levelId===1) return true;
  const prev = progress.levels[levelId-1];
  return !!(prev && prev.completed);
}
function renderLevelsGrid(){
  const grid = document.getElementById('levelsGrid');
  grid.innerHTML = '';
  LEVELS.forEach(lv=>{
    const rec = progress.levels[lv.id] || {stars:0, completed:false, bestTimeSec:null};
    const unlocked = isUnlocked(lv.id);
    const card = document.createElement('div');
    card.className = 'level-card' + (unlocked?'':' locked');
    card.style.borderColor = unlocked ? (lv.accent+'55') : 'rgba(255,255,255,0.08)';
    if(rec.stars>0){
      const b = document.createElement('div');
      b.className='level-badge'; b.textContent = badgeForStars(rec.stars);
      card.appendChild(b);
    }
    const grid_n = gridSizeFor(lv);
    card.innerHTML += `
      <div class="level-num">LEVEL ${String(lv.id).padStart(2,'0')} · ${grid_n}×${grid_n}</div>
      <div class="level-name" style="color:${unlocked?'#eafff2':'inherit'}">${lv.name}</div>
      <div class="level-tier">${lv.tier}</div>
      ${unlocked ? `<div class="level-stars">${starsString(rec.stars)}</div>` : `<div class="lock-icon">🔒</div>`}
    `;
    if(unlocked){
      card.addEventListener('click', ()=>{ playClick(); startLevel(lv.id); });
    }
    grid.appendChild(card);
  });
  updateProgressBar();
}
function updateProgressBar(){
  const completedCount = LEVELS.filter(l=>progress.levels[l.id]?.completed).length;
  const pct = Math.round(completedCount/LEVELS.length*100);
  document.getElementById('pbFill').style.width = pct+'%';
  document.getElementById('pbText').textContent = pct+'% ('+completedCount+'/15)';
}
function totalStars(){
  return LEVELS.reduce((s,l)=> s + (progress.levels[l.id]?.stars||0), 0);
}
function goldCount(){
  return LEVELS.filter(l=> (progress.levels[l.id]?.stars||0)===3).length;
}
function overallBadgeTier(){
  const t = totalStars();
  if(t>=45) return {label:'PLATINUM RHYTHM MASTER', medal:'🏆'};
  if(t>=30) return {label:'GOLD CARDIAC READER', medal:'🥇'};
  if(t>=15) return {label:'SILVER TELEMETRY TECH', medal:'🥈'};
  if(t>=1) return {label:'BRONZE TRAINEE', medal:'🥉'};
  return null;
}
function refreshHome(){
  document.getElementById('heroStars').textContent = totalStars()+'/45';
  const completedCount = LEVELS.filter(l=>progress.levels[l.id]?.completed).length;
  document.getElementById('homeCompleted').textContent = completedCount+'/15';
  document.getElementById('homeGold').textContent = goldCount();
  let best = null;
  LEVELS.forEach(l=>{ const r=progress.levels[l.id]; if(r&&r.bestTimeSec!=null){ if(best===null||r.bestTimeSec<best) best=r.bestTimeSec; } });
  document.getElementById('homeBest').textContent = best!=null ? best+'s' : '--';
  const ob = overallBadgeTier();
  const box = document.getElementById('overallBadgeBox');
  box.innerHTML = ob ? `<span class="medal">${ob.medal}</span>${ob.label}` : `<span style="opacity:.6">Complete a level to earn your first badge</span>`;
  document.getElementById('heroStreak').textContent = goldCount();
}

/* ===================================================================
   GAME STATE / LOGIC
=================================================================== */
let game = null; // active level runtime state

function startLevel(levelId){
  const level = LEVELS.find(l=>l.id===levelId);
  const n = gridSizeFor(level);
  const cols = n, rows = n;
  const tileW = ART_W/cols, tileH = ART_H/rows;

  // render full art
  const fullCanvas = document.createElement('canvas');
  renderLevelArt(fullCanvas, level);
  const fullDataURL = fullCanvas.toDataURL();

  // slice tiles
  const tiles = [];
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const tc = document.createElement('canvas');
      tc.width = tileW; tc.height = tileH;
      const tctx = tc.getContext('2d');
      tctx.drawImage(fullCanvas, c*tileW, r*tileH, tileW, tileH, 0,0, tileW, tileH);
      tiles.push({ correctIndex: r*cols + c, dataURL: tc.toDataURL() });
    }
  }
  // shuffle
  const shuffled = tiles.slice();
  for(let i=shuffled.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]]; }

  game = {
    level, cols, rows, tiles: shuffled, placed: new Array(cols*rows).fill(null),
    hintsRemaining: 3, hintsUsed:0, mistakes:0, timeLeft: level.time, timerId:null,
    fullDataURL, startTs: Date.now(), finished:false
  };

  document.getElementById('gameLevelTitle').textContent = `LEVEL ${String(level.id).padStart(2,'0')} — ${level.name.toUpperCase()}`;
  document.getElementById('factBox').innerHTML = `<b>ℹ RHYTHM NOTE:</b> ${level.fact}`;
  const rec = progress.levels[level.id];
  document.getElementById('bestStarsText').textContent = rec ? starsPlain(rec.stars) : '—';
  document.getElementById('hintOverlay').style.backgroundImage = `url(${fullDataURL})`;

  buildSlotsUI();
  buildTrayUI();
  updateHintsUI();
  showScreen('screen-game');
  startTimer();
}
function starsPlain(n){ return (n||0)+'★'; }

function buildSlotsUI(){
  const grid = document.getElementById('slotsGrid');
  grid.style.gridTemplateColumns = `repeat(${game.cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${game.rows}, 1fr)`;
  grid.innerHTML = '';
  for(let i=0;i<game.cols*game.rows;i++){
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.dataset.index = i;
    grid.appendChild(slot);
  }
}
function buildTrayUI(){
  const tray = document.getElementById('trayEl');
  tray.innerHTML = '';
  game.tiles.forEach((t)=>{
    const el = document.createElement('div');
    el.className = 'tile';
    el.style.backgroundImage = `url(${t.dataURL})`;
    el.dataset.correctIndex = t.correctIndex;
    el._tileData = t;
    attachDrag(el);
    tray.appendChild(el);
  });
}
function updateHintsUI(){
  document.getElementById('hintsText').textContent = game.hintsRemaining;
}

/* ---- timer ---- */
function startTimer(){
  updateTimerUI();
  clearInterval(game.timerId);
  game.timerId = setInterval(()=>{
    game.timeLeft--;
    if(game.timeLeft<=10 && game.timeLeft>0){ playTick(); }
    updateTimerUI();
    if(game.timeLeft<=0){
      clearInterval(game.timerId);
      onLevelFail();
    }
  },1000);
}
function updateTimerUI(){
  const m = Math.floor(Math.max(0,game.timeLeft)/60);
  const s = Math.max(0,game.timeLeft)%60;
  document.getElementById('timerText').textContent = `${m}:${String(s).padStart(2,'0')}`;
  const pill = document.getElementById('timerPill');
  pill.classList.toggle('warn', game.timeLeft<=10);
}

/* ---- drag logic (pointer events, mouse+touch) ---- */
function attachDrag(tileEl){
  tileEl.addEventListener('pointerdown', (e)=>{
    if(game.finished) return;
    e.preventDefault();
    ensureAudio();
    const ghost = document.createElement('div');
    ghost.className='tile-ghost';
    ghost.style.width = tileEl.offsetWidth+'px';
    ghost.style.height = tileEl.offsetHeight+'px';
    ghost.style.backgroundImage = tileEl.style.backgroundImage;
    document.body.appendChild(ghost);
    tileEl.classList.add('dragging');
    moveGhost(ghost, e.clientX, e.clientY);

    let currentSlot = null;
    function onMove(ev){
      moveGhost(ghost, ev.clientX, ev.clientY);
      ghost.style.display='none';
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      ghost.style.display='';
      const slotEl = under && under.closest ? under.closest('.slot') : null;
      if(currentSlot && currentSlot!==slotEl) currentSlot.classList.remove('dragover');
      if(slotEl && !slotEl.classList.contains('filled')){ slotEl.classList.add('dragover'); currentSlot = slotEl; }
      else currentSlot = null;
    }
    function onUp(ev){
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      ghost.remove();
      tileEl.classList.remove('dragging');
      if(currentSlot) currentSlot.classList.remove('dragover');
      ghost.style.display='none';
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      ghost.style.display='';
      const slotEl = under && under.closest ? under.closest('.slot') : null;
      if(slotEl && !slotEl.classList.contains('filled')){
        handleDrop(tileEl, slotEl);
      }
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}
function moveGhost(ghost, x, y){
  ghost.style.left = x+'px'; ghost.style.top = y+'px';
}
function handleDrop(tileEl, slotEl){
  const correctIndex = parseInt(tileEl.dataset.correctIndex,10);
  const slotIndex = parseInt(slotEl.dataset.index,10);
  if(correctIndex === slotIndex){
    playCorrect();
    slotEl.classList.add('filled');
    slotEl.style.backgroundImage = tileEl.style.backgroundImage;
    game.placed[slotIndex] = correctIndex;
    tileEl.remove();
    checkWin();
  } else {
    playWrong();
    game.mistakes++;
    slotEl.classList.add('wrong-flash');
    setTimeout(()=>slotEl.classList.remove('wrong-flash'), 350);
  }
}
function checkWin(){
  if(game.placed.every(v=>v!==null)){
    onLevelComplete();
  }
}

/* ---- hint ---- */
document.getElementById('hintBtn').addEventListener('click', ()=>{
  if(!game || game.finished) return;
  if(game.hintsRemaining<=0){ toast('No hints left!'); return; }
  game.hintsRemaining--; game.hintsUsed++;
  updateHintsUI();
  playHint();
  const ov = document.getElementById('hintOverlay');
  ov.classList.add('show');
  setTimeout(()=>ov.classList.remove('show'), 1800);
});
document.getElementById('restartLevelBtn').addEventListener('click', ()=>{
  if(!game) return;
  clearInterval(game.timerId);
  startLevel(game.level.id);
});
document.getElementById('exitLevelBtn').addEventListener('click', ()=>{
  if(game) clearInterval(game.timerId);
  renderLevelsGrid();
  showScreen('screen-levels');
});

/* ---- complete / fail ---- */
function computeStars(){
  let stars = 3;
  const timeUsedRatio = (game.level.time - game.timeLeft) / game.level.time;
  if(game.hintsUsed >= 2) stars--; else if(game.hintsUsed>=1 && timeUsedRatio>0.5) stars--;
  if(game.mistakes >= 4) stars--;
  if(timeUsedRatio > 0.85) stars--;
  return Math.max(1, Math.min(3, stars));
}
function onLevelComplete(){
  game.finished = true;
  clearInterval(game.timerId);
  playComplete();
  const stars = computeStars();
  const timeTaken = game.level.time - game.timeLeft;
  const existing = progress.levels[game.level.id] || {stars:0, completed:false, bestTimeSec:null};
  const improved = stars > existing.stars;
  progress.levels[game.level.id] = {
    stars: Math.max(existing.stars, stars),
    completed: true,
    bestTimeSec: existing.bestTimeSec!=null ? Math.min(existing.bestTimeSec, timeTaken) : timeTaken
  };
  saveProgress();

  const badge = badgeForStars(stars);
  const card = document.getElementById('modalCard');
  const nextLevel = LEVELS.find(l=>l.id===game.level.id+1);
  card.innerHTML = `
    <div class="modal-emoji">${badge||'🫀'}</div>
    <div class="modal-title">Rhythm Identified!</div>
    <div class="modal-stars">${'⭐'.repeat(stars)}${'<span style="opacity:.2">'+'⭐'.repeat(3-stars)+'</span>'}</div>
    <div class="modal-sub">${game.level.name} · cleared in ${timeTaken}s ${improved?'· new best!':''}</div>
    <div class="modal-badge">${badge?badge+' '+({3:'GOLD',2:'SILVER',1:'BRONZE'}[stars])+' MEDAL':''}</div>
    <div class="modal-btns">
      ${nextLevel ? `<button class="btn btn-primary" id="modalNextBtn">Next Level →</button>` : `<button class="btn btn-primary" id="modalCertBtn">🎓 Get Certificate</button>`}
      <button class="btn btn-ghost" id="modalLevelsBtn">Levels</button>
    </div>
  `;
  document.getElementById('modalBackdrop').classList.add('active');
  if(nextLevel){
    document.getElementById('modalNextBtn').addEventListener('click', ()=>{
      closeModal(); startLevel(nextLevel.id);
    });
  } else {
    document.getElementById('modalCertBtn').addEventListener('click', ()=>{
      closeModal(); openCertificate();
    });
  }
  document.getElementById('modalLevelsBtn').addEventListener('click', ()=>{
    closeModal(); renderLevelsGrid(); showScreen('screen-levels');
  });
}
function onLevelFail(){
  game.finished = true;
  playFail();
  const card = document.getElementById('modalCard');
  card.innerHTML = `
    <div class="modal-emoji">💔</div>
    <div class="modal-title">Time's Up</div>
    <div class="modal-sub">The strip stayed jumbled. Give it another go?</div>
    <div class="modal-btns">
      <button class="btn btn-primary" id="modalRetryBtn">↺ Retry Level</button>
      <button class="btn btn-ghost" id="modalLevelsBtn2">Levels</button>
    </div>
  `;
  document.getElementById('modalBackdrop').classList.add('active');
  document.getElementById('modalRetryBtn').addEventListener('click', ()=>{
    closeModal(); startLevel(game.level.id);
  });
  document.getElementById('modalLevelsBtn2').addEventListener('click', ()=>{
    closeModal(); renderLevelsGrid(); showScreen('screen-levels');
  });
}
function closeModal(){ document.getElementById('modalBackdrop').classList.remove('active'); }

/* ===================================================================
   CERTIFICATE
=================================================================== */
function drawCertificate(name){
  const canvas = document.getElementById('certCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const ob = overallBadgeTier();
  const stars = totalStars();

  const bgGrad = ctx.createLinearGradient(0,0,0,H);
  bgGrad.addColorStop(0,'#0e1c16'); bgGrad.addColorStop(1,'#050b09');
  ctx.fillStyle = bgGrad; ctx.fillRect(0,0,W,H);

  // faint grid
  ctx.strokeStyle='rgba(57,255,136,0.06)';
  for(let x=0;x<W;x+=24){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for(let y=0;y<H;y+=24){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

  // border
  ctx.strokeStyle = 'rgba(255,213,74,0.55)'; ctx.lineWidth = 3;
  ctx.strokeRect(20,20,W-40,H-40);
  ctx.strokeStyle = 'rgba(255,213,74,0.25)'; ctx.lineWidth = 1;
  ctx.strokeRect(30,30,W-60,H-60);

  ctx.textAlign='center';
  ctx.fillStyle='#ffd54a';
  ctx.font='700 16px JetBrains Mono, monospace';
  ctx.fillText('R H Y T H M   L A B', W/2, 90);

  ctx.fillStyle='#eafff2';
  ctx.font='700 40px Space Grotesk, sans-serif';
  ctx.fillText('Certificate of ECG Mastery', W/2, 150);

  ctx.fillStyle='#7fa393';
  ctx.font='500 15px Space Grotesk, sans-serif';
  ctx.fillText('This certifies that', W/2, 200);

  ctx.fillStyle='#39ff88';
  ctx.font='700 36px Space Grotesk, sans-serif';
  ctx.fillText(name || 'Rhythm Reader', W/2, 250);

  ctx.fillStyle='#d7f5e3';
  ctx.font='500 15px Space Grotesk, sans-serif';
  const completedCount = LEVELS.filter(l=>progress.levels[l.id]?.completed).length;
  ctx.fillText(`has successfully interpreted ${completedCount} of 15 ECG rhythms`, W/2, 290);
  ctx.fillText(`earning ${stars} of 45 possible stars`, W/2, 316);

  // stars row
  ctx.font='30px sans-serif';
  ctx.fillText('⭐'.repeat(Math.min(15,Math.ceil(stars/3))) || '—', W/2, 365);

  // badge
  if(ob){
    ctx.font='60px sans-serif';
    ctx.fillText(ob.medal, W/2, 445);
    ctx.font='700 18px JetBrains Mono, monospace';
    ctx.fillStyle='#ffd54a';
    ctx.fillText(ob.label, W/2, 475);
  } else {
    ctx.font='16px JetBrains Mono, monospace';
    ctx.fillStyle='#7fa393';
    ctx.fillText('Complete a level to earn a badge', W/2, 445);
  }

  // decorative ECG trace at bottom
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle='rgba(57,255,136,0.7)';
  ctx.shadowColor='#39ff88'; ctx.shadowBlur=8;
  ctx.lineWidth=2.5;
  const baseline = H-90;
  for(let x=60;x<W-60;x+=2){
    const bstart = 60 + Math.floor((x-60)/70)*70;
    const y = beatContribution(x, bstart, 70, {amp:26}, {});
    x===60? ctx.moveTo(x, baseline+y) : ctx.lineTo(x, baseline+y);
  }
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle='#7fa393';
  ctx.font='500 12px JetBrains Mono, monospace';
  const dateStr = new Date().toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'});
  ctx.fillText(dateStr, W/2, H-40);
}
function openCertificate(){
  const nameInput = document.getElementById('certNameInput');
  nameInput.value = progress.playerName || '';
  drawCertificate(nameInput.value);
  showScreen('screen-cert');
}
document.getElementById('certRenderBtn').addEventListener('click', ()=>{
  playClick();
  const name = document.getElementById('certNameInput').value.trim();
  progress.playerName = name; saveProgress();
  drawCertificate(name);
});
document.getElementById('certDownloadBtn').addEventListener('click', ()=>{
  const canvas = document.getElementById('certCanvas');
  const link = document.createElement('a');
  link.download = 'ecg-rhythm-lab-certificate.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
});
document.getElementById('certBackBtn').addEventListener('click', ()=>{ refreshHome(); showScreen('screen-home'); });
document.getElementById('certPeekBtn').addEventListener('click', ()=>{ openCertificate(); });

/* ===================================================================
   WIRE UP
=================================================================== */
document.getElementById('playBtn').addEventListener('click', ()=>{ ensureAudio(); playClick(); renderLevelsGrid(); showScreen('screen-levels'); });
document.getElementById('backHomeBtn').addEventListener('click', ()=>{ refreshHome(); showScreen('screen-home'); });
document.getElementById('muteBtn').addEventListener('click', (e)=>{
  muted = !muted;
  e.target.textContent = muted ? '🔇' : '🔊';
});

async function boot(){
  await loadProgress();
  refreshHome();
  initHero();
}
boot();

})();