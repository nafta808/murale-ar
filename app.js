/* Murale AR v6 — il posto stesso è il riferimento.
   Cattura -> angoli sotto il mirino -> Studio (immagine/video, disegno, forme) -> Pubblica (QR) -> Guarda/Esplora (più opere insieme). */
'use strict';
const $ = id => document.getElementById(id);
const CFG = window.MURALE_CONFIG || {};
const ONLINE = !!(CFG.supabaseUrl && CFG.supabaseKey);
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_TARGETS = 10;
const params = new URLSearchParams(location.search);
const urlId = (params.get('o') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
const SCREENS = ['home', 'capture', 'corners', 'angles', 'studio', 'publish'];
const IS_MOBILE = /iPhone|iPad|Android/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;

/* ------------------------------------------------------------------ util */
function toast(t, ms = 2400) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), ms); }
const ease = t => 1 - Math.pow(1 - t, 3);
const baseURL = () => location.origin + location.pathname;
const viewURL = id => baseURL() + '?o=' + id;
function show(id) { SCREENS.forEach(s => $(s).hidden = s !== id); }
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
function newId(n = 6) { const r = crypto.getRandomValues(new Uint32Array(n)); return Array.from(r, v => ALPH[v % ALPH.length]).join(''); }
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
async function saveBlob(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const blobToDataURL = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });

/* ------------------------------------------------------------------ archivio locale (IndexedDB) */
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      let rq; try { rq = indexedDB.open('murale-ar-v3', 1); } catch (e) { return rej(e); }
      rq.onupgradeneeded = () => rq.result.createObjectStore('p', { keyPath: 'id' });
      rq.onsuccess = () => { this.db = rq.result; res(this.db); }; rq.onerror = () => rej(rq.error);
    });
  },
  async tx(mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('p', mode); const r = fn(t.objectStore('p')); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); },
  get(id) { return this.tx('readonly', s => s.get(id)).catch(() => null); },
  put(p) { return this.tx('readwrite', s => s.put(p)); },
  all() { return this.tx('readonly', s => s.getAll()).catch(() => []); },
};

/* ------------------------------------------------------------------ archivio online (Supabase Storage, REST) */
const Cloud = {
  base: () => CFG.supabaseUrl.replace(/\/$/, '') + '/storage/v1/object',
  bucket: () => CFG.bucket || 'opere',
  hdr: (type) => Object.assign({ Authorization: 'Bearer ' + CFG.supabaseKey, apikey: CFG.supabaseKey }, type ? { 'Content-Type': type } : {}),
  async put(name, body, type) {
    const r = await fetch(this.base() + '/' + this.bucket() + '/' + name, { method: 'POST', headers: Object.assign(this.hdr(type), { 'x-upsert': 'true' }), body });
    if (!r.ok) throw new Error('upload ' + r.status + ' ' + (await r.text()).slice(0, 120));
    return this.base() + '/public/' + this.bucket() + '/' + name;
  },
  async get(id) { const r = await fetch(this.base() + '/public/' + this.bucket() + '/' + id + '.json?t=' + Date.now()); if (!r.ok) return null; return r.json(); },
  async list(limit = 12) {
    const r = await fetch(this.base() + '/list/' + this.bucket(), { method: 'POST', headers: this.hdr('application/json'),
      body: JSON.stringify({ prefix: '', limit: 60, offset: 0, sortBy: { column: 'updated_at', order: 'desc' } }) });
    if (!r.ok) return [];
    return (await r.json()).map(o => o.name).filter(n => /\.json$/.test(n)).slice(0, limit).map(n => n.replace(/\.json$/, ''));
  },
};

/* ------------------------------------------------------------------ geometria */
function solve(A, b) { const n = b.length; A = A.map((r, i) => r.concat(b[i]));
  for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; } }
  return A.map((row, i) => row[n] / row[i]); }
function homography(src, dst) { const A = [], b = [];
  for (let i = 0; i < 4; i++) { const { x, y } = src[i], X = dst[i].x, Y = dst[i].y;
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X); A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y); }
  return solve(A, b).concat(1); }
function hApply(H, x, y) { const w = H[6] * x + H[7] * y + H[8]; return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w }; }
const rectPts = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
function orderImg(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const s = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let ti = 0; s.forEach((p, i) => { if (p.x + p.y < s[ti].x + s[ti].y) ti = i; });
  return s.slice(ti).concat(s.slice(0, ti));
}
// proporzioni reali di un rettangolo visto in prospettiva (Zhang), focale della fotocamera principale iPhone
function estimateAspect(q, iw, ih) {
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const f = 0.75 * Math.max(iw, ih), u0 = iw / 2, v0 = ih / 2;
  const m1 = [q[0].x, q[0].y, 1], m2 = [q[1].x, q[1].y, 1], m4 = [q[2].x, q[2].y, 1], m3 = [q[3].x, q[3].y, 1];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3), k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]), n3 = m3.map((v, i) => k3 * v - m1[i]);
  const A = n => [(n[0] - u0 * n[2]) / f, (n[1] - v0 * n[2]) / f, n[2]], a = A(n2), b = A(n3);
  let r = Math.sqrt(dot(a, a) / dot(b, b));
  const naive = (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / (Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y) + Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y));
  if (!isFinite(r) || r <= 0 || r / naive > 3 || naive / r > 3) r = naive;
  return r;
}
function insideConvex(poly, p) { let sgn = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length], c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(c) < 1e-9) continue; const s = Math.sign(c); if (!sgn) sgn = s; else if (s !== sgn) return false; }
  return true; }
const aspectOf = p => p.aspect0 * Math.pow(2, (p.aspectAdj || 0) / 100);
function rectSize(a, max = 1024) { return a >= 1 ? { W: max, H: Math.max(48, Math.round(max / a)) } : { W: Math.max(48, Math.round(max * a)), H: max }; }
function warp(sd, iw, ih, Hm, W, H, gray) {
  const out = new ImageData(W, H), od = out.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = hApply(Hm, x + .5, y + .5), fx = s.x - .5, fy = s.y - .5, x0 = Math.floor(fx), y0 = Math.floor(fy), o = (y * W + x) * 4;
    if (!(x0 >= 0 && y0 >= 0 && x0 + 1 < iw && y0 + 1 < ih)) { od[o] = od[o + 1] = od[o + 2] = 40; od[o + 3] = 255; continue; }
    const ax = fx - x0, ay = fy - y0, i00 = (y0 * iw + x0) * 4, i10 = i00 + 4, i01 = i00 + iw * 4, i11 = i01 + 4;
    for (let c = 0; c < 3; c++) od[o + c] = (sd[i00 + c] * (1 - ax) + sd[i10 + c] * ax) * (1 - ay) + (sd[i01 + c] * (1 - ax) + sd[i11 + c] * ax) * ay;
    if (gray) { const g = od[o] * .299 + od[o + 1] * .587 + od[o + 2] * .114; od[o] = od[o + 1] = od[o + 2] = g; }
    od[o + 3] = 255;
  }
  return out;
}
const frameCache = { url: null };
async function frameData(url) {
  if (frameCache.url === url) return frameCache;
  const img = await loadImg(url), c = canvasOf(img.width, img.height), g = c.getContext('2d'); g.drawImage(img, 0, 0);
  Object.assign(frameCache, { url, data: g.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height }); return frameCache;
}
// impronta del luogo: la porzione di muro più ampia (3:4) attorno all'area, raddrizzata
async function buildTarget(p, view) {
  const fr = view ? view.frame : p.frame, qq = view ? view.q : p.q;
  const F = await frameData(fr), a = aspectOf(p), W = 1000, H = 1000 / a;
  const toFrame = homography(rectPts(0, 0, W, H), qq), toRect = homography(qq, rectPts(0, 0, W, H));
  const m = .015, fq = rectPts(F.w * m, F.h * m, F.w * (1 - 2 * m), F.h * (1 - 2 * m)).map(c => hApply(toRect, c.x, c.y));
  const fits = (cx, cy, tw) => rectPts(cx - tw / 2, cy - tw * 2 / 3, tw, tw * 4 / 3).every(c => insideConvex(fq, c));
  const tw0 = Math.max(W, H * .75);
  let cx = W / 2, cy = H / 2;
  if (!fits(cx, cy, tw0 * .25)) { cx = fq.reduce((s, c) => s + c.x, 0) / 4; cy = fq.reduce((s, c) => s + c.y, 0) / 4; }
  let lo = tw0 * .15, hi = tw0 * 2.2;
  if (fits(cx, cy, hi)) lo = hi; else for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (fits(cx, cy, mid)) lo = mid; else hi = mid; }
  const tw = lo, th = tw * 4 / 3, tx = cx - tw / 2, ty = cy - th / 2;
  const T = homography(rectPts(0, 0, 480, 640), rectPts(tx, ty, tw, th).map(c => hApply(toFrame, c.x, c.y)));
  const gray = warp(F.data, F.w, F.h, T, 480, 640, true), tc = canvasOf(480, 640); tc.getContext('2d').putImageData(gray, 0, 0);
  const Tw = homography(rectPts(0, 0, 240, 320), rectPts(tx, ty, tw, th).map(c => hApply(toFrame, c.x, c.y)));
  const wc = canvasOf(240, 320), wg = wc.getContext('2d'); wg.putImageData(warp(F.data, F.w, F.h, Tw, 240, 320, false), 0, 0);
  const k = 240 / tw; wg.strokeStyle = '#ff5b2e'; wg.lineWidth = 3; wg.setLineDash([8, 6]); wg.strokeRect(-tx * k, -ty * k, W * k, H * k);
  const area = { cx: ((W / 2 - tx) / tw - .5) * .75, cy: .5 - (H / 2 - ty) / th, w: W / tw * .75, h: H / th };
  return { target: tc.toDataURL('image/jpeg', .9), where: wc.toDataURL('image/jpeg', .82), area, quality: textureScore(gray) };
}
function textureScore(img) {
  const d = img.data, W = img.width, H = img.height; let strong = 0, n = 0;
  for (let y = 2; y < H - 2; y += 2) for (let x = 2; x < W - 2; x += 2) {
    const i = (y * W + x) * 4, gx = d[i + 4] - d[i - 4], gy = d[i + W * 4] - d[i - W * 4];
    if (Math.abs(gx) + Math.abs(gy) > 36) strong++; n++;
  }
  return strong / n;
}

/* ------------------------------------------------------------------ forme */
const SHAPES = [
  ['rect', 'Pieno', 'M3 3h22v16H3z'], ['oval', 'Ovale', 'M14 3c6 0 11 3.6 11 8s-5 8-11 8S3 15.4 3 11s5-8 11-8z'],
  ['arch', 'Arco', 'M4 19V10a10 7 0 0 1 20 0v9z'], ['diamond', 'Rombo', 'M14 2l11 9-11 9-11-9z'],
  ['hex', 'Esagono', 'M8 2h12l6 9-6 9H8l-6-9z'], ['star', 'Stella', 'M14 1l3 7 8 .5-6 5 2 8-7-4.5-7 4.5 2-8-6-5 8-.5z'],
  ['blob', 'Macchia', 'M6 6c4-5 12-4 16 0s4 10-1 12-9 2-13-1-6-7-2-11z'], ['free', 'Libera', 'M3 17l5-12 6 8 4-6 7 11z'],
];
function shapePath(g, sh, W, H) {
  g.beginPath(); const t = sh && sh.type || 'rect';
  const poly = pts => pts.forEach(([x, y], i) => i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H));
  if (t === 'oval') g.ellipse(W / 2, H / 2, W / 2, H / 2, 0, 0, Math.PI * 2);
  else if (t === 'arch') { const r = W / 2, ry = Math.min(H * .5, r); g.moveTo(0, H); g.lineTo(0, ry); g.ellipse(W / 2, ry, r, ry, 0, Math.PI, 0); g.lineTo(W, H); }
  else if (t === 'diamond') poly([[.5, 0], [1, .5], [.5, 1], [0, .5]]);
  else if (t === 'hex') poly([[.25, 0], [.75, 0], [1, .5], [.75, 1], [.25, 1], [0, .5]]);
  else if (t === 'star') { const pts = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? .21 : .5; pts.push([.5 + Math.cos(a) * r, .53 + Math.sin(a) * r]); } poly(pts); }
  else if (t === 'blob') { const R = [.46, .38, .5, .42, .47, .36, .49, .4], n = R.length, P = R.map((r, i) => { const a = i / n * Math.PI * 2; return [.5 + Math.cos(a) * r, .5 + Math.sin(a) * r]; });
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], m0 = mid(P[n - 1], P[0]); g.moveTo(m0[0] * W, m0[1] * H);
    for (let i = 0; i < n; i++) { const m = mid(P[i], P[(i + 1) % n]); g.quadraticCurveTo(P[i][0] * W, P[i][1] * H, m[0] * W, m[1] * H); } }
  else if (t === 'free' && sh.pts && sh.pts.length >= 3) poly(sh.pts.map(p => [p.x, p.y]));
  else g.rect(0, 0, W, H);
  g.closePath();
}
// maschera alfa della forma, con bordo sfumato (ombra sfocata: funziona anche su Safari)
function makeMask(W, H, sh, f) {
  const c = canvasOf(W, H), g = c.getContext('2d'); g.fillStyle = '#fff';
  if (f < .5) { shapePath(g, sh, W, H); g.fill(); return c; }
  // la forma, ristretta di metà sfumatura, viene disegnata fuori tela: sulla tela arriva solo la sua ombra sfocata
  const k = Math.max(.05, 1 - (2 * f) / Math.min(W, H)), off = W * 3 + 500;
  g.save(); g.shadowColor = '#fff'; g.shadowBlur = f; g.shadowOffsetX = off;
  g.setTransform(k, 0, 0, k, -off + W * (1 - k) / 2, H * (1 - k) / 2); shapePath(g, sh, W, H); g.fill(); g.restore();
  return c;
}

/* ------------------------------------------------------------------ 1. CATTURA */
let capStream = null, editing = null, angleFor = null;
const ANGLE_TIPS = ['spostati a <b>sinistra</b> di 2-3 passi', 'spostati a <b>destra</b> di 2-3 passi', 'avvicinati, oppure inquadra <b>dal basso</b>', 'un’altra posizione da cui la gente guarderà'];
async function openCapture(prev = null, angle = null) {
  editing = prev; angleFor = angle; show(null); $('capture').hidden = false; $('angles').hidden = true;
  $('capChipT').textContent = angle ? 'Angolazione ' + ((angle.views || []).length + 2) : 'Inquadra l’area';
  $('capHint').innerHTML = angle ? 'Stessa area, altra posizione: ' + ANGLE_TIPS[Math.min((angle.views || []).length, 3)] + '. Tieni dentro tutta l’area e un po’ di contorno, poi blocca.'
    : 'Tieni dentro <b>tutta l’area e un po’ di contorno</b>: porte, finestre, spigoli aiutano il riconoscimento. Poi blocca.';
  try {
    capStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 }, aspectRatio: { ideal: 4 / 3 } } });
    const v = $('capVideo'); v.srcObject = capStream; await v.play().catch(() => {});
    // obiettivo senza zoom digitale, se il telefono lo permette
    const tr = capStream.getVideoTracks()[0], cap = tr.getCapabilities ? tr.getCapabilities() : {};
    if (cap.zoom) tr.applyConstraints({ advanced: [{ zoom: cap.zoom.min }] }).catch(() => {});
  } catch (e) { toast('Fotocamera non disponibile: puoi usare una foto dalla galleria', 4000); }
}
function stopCapture() { if (capStream) capStream.getTracks().forEach(t => t.stop()); capStream = null; $('capture').hidden = true; }
function frameFrom(src, w, h) { const k = Math.min(1, 2048 / Math.max(w, h)), c = canvasOf(Math.round(w * k), Math.round(h * k)); c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', .92); }
$('capShot').onclick = () => { const v = $('capVideo'); if (!v.videoWidth) return toast('La fotocamera non è pronta');
  const url = frameFrom(v, v.videoWidth, v.videoHeight); stopCapture(); openCorners(url); };
$('capFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; const img = await loadImg(URL.createObjectURL(f)).catch(() => null); e.target.value = '';
  if (!img) return toast('Immagine non leggibile'); stopCapture(); openCorners(frameFrom(img, img.width, img.height)); };
$('capBack').onclick = () => { stopCapture(); const a = angleFor; angleFor = null; a ? openAngles(a) : goHome(); };

/* ------------------------------------------------------------------ 2. ANGOLI: mirino fisso, si muove la foto */
const CN = { img: null, url: null, s: 1, ox: 0, oy: 0, pts: [], dpr: 1, ptr: new Map(), pinch: null };
const cnc = $('cnCanvas'), cng = cnc.getContext('2d');
async function openCorners(url) { CN.url = url;
  const ref = $('cnRef'); if (angleFor && angleFor.built && angleFor.built.where) { ref.src = angleFor.built.where; ref.hidden = false; } else if (angleFor && angleFor.frame) { ref.src = angleFor.frame; ref.hidden = false; } else ref.hidden = true; CN.img = await loadImg(url); CN.pts = []; $('corners').hidden = false; sizeCN(); fitCN(); cnUI(); drawCN(); }
function sizeCN() { CN.dpr = Math.min(devicePixelRatio || 1, 2); cnc.width = innerWidth * CN.dpr; cnc.height = innerHeight * CN.dpr; }
function fitCN() { const iw = CN.img.width, ih = CN.img.height; CN.s = Math.min(innerWidth / iw, innerHeight / ih); CN.ox = (innerWidth - iw * CN.s) / 2; CN.oy = (innerHeight - ih * CN.s) / 2; }
addEventListener('resize', () => { if (!$('corners').hidden) { sizeCN(); drawCN(); } });
const cnCenter = () => ({ x: innerWidth / 2, y: innerHeight / 2 });
const cnAim = () => { const c = cnCenter(); return { x: (c.x - CN.ox) / CN.s, y: (c.y - CN.oy) / CN.s }; };
const toScr = p => ({ x: p.x * CN.s + CN.ox, y: p.y * CN.s + CN.oy });
function drawCN() {
  const g = cng, d = CN.dpr, img = CN.img; if (!img) return;
  g.setTransform(d, 0, 0, d, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, innerWidth, innerHeight);
  g.drawImage(img, CN.ox, CN.oy, img.width * CN.s, img.height * CN.s);
  const aim = cnAim(), pts = CN.pts.length === 4 ? orderImg(CN.pts) : CN.pts.slice();
  if (pts.length < 4) pts.push(aim);
  g.lineWidth = 2.5; g.strokeStyle = '#ff5b2e'; g.fillStyle = 'rgba(255,91,46,.18)'; g.beginPath();
  pts.forEach((p, i) => { const s = toScr(p); i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y); });
  if (pts.length >= 3) { g.closePath(); g.fill(); } g.stroke();
  CN.pts.forEach((p, i) => { const s = toScr(p); g.fillStyle = '#ff5b2e'; g.beginPath(); g.arc(s.x, s.y, 7, 0, 7); g.fill(); g.fillStyle = '#fff'; g.font = '700 12px -apple-system,sans-serif'; g.fillText(String(i + 1), s.x + 10, s.y - 8); });
  const c = cnCenter(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = 4;
  g.beginPath(); g.moveTo(c.x - 26, c.y); g.lineTo(c.x - 6, c.y); g.moveTo(c.x + 6, c.y); g.lineTo(c.x + 26, c.y); g.moveTo(c.x, c.y - 26); g.lineTo(c.x, c.y - 6); g.moveTo(c.x, c.y + 6); g.lineTo(c.x, c.y + 26); g.stroke();
  g.shadowBlur = 0;
  const R = Math.min(78, innerWidth * .2), L = 4, lx = c.x, ly = c.y - R - 64, sr = R / (CN.s * L);
  g.save(); g.beginPath(); g.arc(lx, ly, R, 0, 7); g.clip(); g.fillStyle = '#000'; g.fillRect(lx - R, ly - R, 2 * R, 2 * R);
  g.imageSmoothingEnabled = false; g.drawImage(img, aim.x - sr, aim.y - sr, 2 * sr, 2 * sr, lx - R, ly - R, 2 * R, 2 * R); g.imageSmoothingEnabled = true;
  g.strokeStyle = '#ff5b2e'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(lx - R, ly); g.lineTo(lx + R, ly); g.moveTo(lx, ly - R); g.lineTo(lx, ly + R); g.stroke();
  g.restore(); g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(lx, ly, R, 0, 7); g.stroke();
}
function cnUI() {
  const n = CN.pts.length;
  $('cnChipT').textContent = n < 4 ? 'Angolo ' + (n + 1) + ' di 4' : 'Area pronta';
  $('cnUndo').disabled = !n; $('cnMark').disabled = n >= 4; $('cnDone').disabled = n < 4;
  $('cnHint').innerHTML = n === 0 ? 'Trascina la foto finché il <b>primo angolo</b> è sotto il mirino. Due dita per ingrandire.' :
    n < 4 ? 'Ora l’angolo successivo, in qualsiasi ordine.' : 'Controlla l’area arancione e tocca <b>Avanti</b>. Per forme particolari: scegli un rettangolo che le contiene, la forma la ritagli nello Studio.';
}
cnc.addEventListener('pointerdown', e => { cnc.setPointerCapture(e.pointerId); CN.ptr.set(e.pointerId, { x: e.clientX, y: e.clientY }); CN.pinch = null; });
cnc.addEventListener('pointermove', e => {
  const prev = CN.ptr.get(e.pointerId); if (!prev) return; const cur = { x: e.clientX, y: e.clientY };
  if (CN.ptr.size === 1) { CN.ox += cur.x - prev.x; CN.oy += cur.y - prev.y; }
  else if (CN.ptr.size === 2) {
    const [a, b] = [...CN.ptr.entries()].map(([id, p]) => id === e.pointerId ? cur : p);
    const dNow = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (CN.pinch) { zoomAt(mid, dNow / CN.pinch.d); CN.ox += mid.x - CN.pinch.mid.x; CN.oy += mid.y - CN.pinch.mid.y; }
    CN.pinch = { d: dNow, mid };
  }
  CN.ptr.set(e.pointerId, cur); drawCN();
});
['pointerup', 'pointercancel'].forEach(t => cnc.addEventListener(t, e => { CN.ptr.delete(e.pointerId); CN.pinch = null; }));
cnc.addEventListener('wheel', e => { e.preventDefault(); zoomAt(cnCenter(), Math.exp(-e.deltaY * .002)); drawCN(); }, { passive: false });
function zoomAt(c, k) { const s2 = Math.max(.2, Math.min(40, CN.s * k)); k = s2 / CN.s; CN.ox = c.x - (c.x - CN.ox) * k; CN.oy = c.y - (c.y - CN.oy) * k; CN.s = s2; }
$('cnMark').onclick = () => { const a = cnAim(); if (a.x < 0 || a.y < 0 || a.x > CN.img.width || a.y > CN.img.height) return toast('Il mirino è fuori dalla foto');
  CN.pts.push(a); if (navigator.vibrate) navigator.vibrate(15); cnUI(); drawCN(); };
$('cnUndo').onclick = () => { CN.pts.pop(); cnUI(); drawCN(); };
$('cnBack').onclick = () => { $('corners').hidden = true; openCapture(editing, angleFor); };
$('cnDone').onclick = async () => {
  if (angleFor) { const p = angleFor; angleFor = null; p.views = (p.views || []).concat({ frame: CN.url, q: orderImg(CN.pts) }); p.updated = Date.now();
    await DB.put(p).catch(() => toast('Memoria piena')); $('corners').hidden = true; return openAngles(p); }
  const fresh = !editing, q = orderImg(CN.pts), p = editing || { id: newId(), created: Date.now() };
  Object.assign(p, { frame: CN.url, q, aspect0: estimateAspect(q, CN.img.width, CN.img.height), aspectAdj: 0, updated: Date.now(), built: null });
  await DB.put(p).catch(() => {}); $('corners').hidden = true; editing = null; fresh ? openAngles(p) : openStudio(p);
};

/* ------------------------------------------------------------------ 2b. ANGOLAZIONI: più foto dello stesso punto = aggancio da ogni lato */
let angP = null;
async function openAngles(p) {
  angP = p; show(null); $('angles').hidden = false; const n = (p.views || []).length;
  const list = $('aList'); list.innerHTML = '';
  [{ frame: p.frame, main: true }].concat(p.views || []).forEach((v, i) => {
    const d = document.createElement('div'); d.className = 'ang' + (v.main ? ' main' : '');
    d.innerHTML = `<img alt="" src="${v.frame}"><span>${v.main ? 'Frontale' : 'Angolo ' + (i + 1)}</span>`;
    if (!v.main) { const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'Togli');
      x.onclick = async () => { p.views.splice(i - 1, 1); await DB.put(p).catch(() => {}); openAngles(p); }; d.appendChild(x); }
    list.appendChild(d);
  });
  $('aCount').textContent = (n + 1) + (n ? ' angolazioni' : ' angolazione');
  $('aTip').innerHTML = n >= 4 ? 'Ottimo: il punto si aggancia da tutti i lati.' : 'Prossima: ' + ANGLE_TIPS[Math.min(n, 3)] + '. Con 2-3 angolazioni l’opera si aggancia anche guardandola di lato.';
  $('aAdd').disabled = n >= 4; $('aGo').textContent = n ? 'Vai allo Studio' : 'Salta, vai allo Studio';
}
$('aAdd').onclick = () => { $('angles').hidden = true; openCapture(null, angP); };
$('aGo').onclick = () => { $('angles').hidden = true; openStudio(angP); };

/* ------------------------------------------------------------------ 3. STUDIO */
const S = { p: null, W: 0, H: 0, bg: null, media: null, draw: null, comp: null, fit: 'cover', zoom: 1, pan: { x: 0, y: 0 }, op: 1, feather: .01, blend: false, wall: true,
  shape: { type: 'rect' }, ext: 0, tab: 'opera', color: '#ff5b2e', size: 18, eraser: false, loop: 0 };
const cv = $('sCanvas'), cx = cv.getContext('2d');
// mappa la tela (eventualmente estesa oltre gli angoli) sulla foto
function panelToFrame(p, W, H) {
  const e = p.ext || 0, Hu = homography(rectPts(0, 0, 1, 1), p.q), m = (u, v) => hApply(Hu, u, v);
  return homography(rectPts(0, 0, W, H), [m(-e, -e), m(1 + e, -e), m(1 + e, 1 + e), m(-e, 1 + e)]);
}
async function layoutStudio(keepDraw) {
  const p = S.p, { W, H } = rectSize(aspectOf(p)), oldDraw = S.draw, oldW = S.W, oldH = S.H, oldExt = S.layoutExt || 0;
  S.W = W; S.H = H; cv.width = W; cv.height = H;
  const F = await frameData(p.frame); S.bg = canvasOf(W, H); S.bg.getContext('2d').putImageData(warp(F.data, F.w, F.h, panelToFrame(p, W, H), W, H, false), 0, 0);
  S.draw = canvasOf(W, H);
  if (keepDraw && oldDraw) { // il disegno resta fermo sul muro anche se cambia l'estensione
    const e0 = oldExt, e1 = p.ext || 0, k = (1 + 2 * e0) / (1 + 2 * e1), o = (e1 - e0) / (1 + 2 * e1);
    S.draw.getContext('2d').drawImage(oldDraw, o * W, o * H, W * k, H * k);
  }
  S.layoutExt = p.ext || 0; S.comp = canvasOf(W, H);
}
async function openStudio(p) {
  S.p = p; show('studio'); toast('Raddrizzo il muro…', 1200); await nextFrame();
  const e = p.edit || {};
  Object.assign(S, { fit: e.fit || 'cover', zoom: e.zoom || 1, pan: e.pan || { x: 0, y: 0 }, op: e.op ?? 1, feather: e.feather ?? .01, blend: !!e.blend, shape: p.shape || { type: 'rect' } });
  S.layoutExt = p.ext || 0; S.draw = null; UNDO.st = []; UNDO.re = []; await layoutStudio(false);
  if (e.drawing) { const d = await loadImg(e.drawing).catch(() => null); if (d) S.draw.getContext('2d').drawImage(d, 0, 0, S.W, S.H); }
  stopStudioVideo();
  if (p.media && p.media.type === 'video' && p.media.blob) await setVideo(p.media.blob);
  else S.media = { type: 'image', img: await loadImg((p.media && p.media.art) || e.art || 'esempio.jpg').catch(() => null) };
  syncStudio(); renderStudio();
}
function mediaRect() {
  const m = S.media; if (!m) return null; const { W, H } = S;
  const iw = m.type === 'video' ? m.el.videoWidth : m.img && m.img.width, ih = m.type === 'video' ? m.el.videoHeight : m.img && m.img.height;
  if (!iw || !ih) return null; let w, h;
  if (S.fit === 'stretch') { w = W * S.zoom; h = H * S.zoom; }
  else { const s = (S.fit === 'cover' ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih)) * S.zoom; w = iw * s; h = ih * s; }
  return { x: (W - w) / 2 + S.pan.x * W, y: (H - h) / 2 + S.pan.y * H, w, h };
}
function composePanel(withVideo) {
  const { W, H } = S, g = S.comp.getContext('2d'); g.clearRect(0, 0, W, H); g.globalCompositeOperation = 'source-over';
  const r = mediaRect(), m = S.media;
  if (r && m.type === 'image') g.drawImage(m.img, r.x, r.y, r.w, r.h);
  if (r && m.type === 'video' && withVideo) g.drawImage(m.el, r.x, r.y, r.w, r.h);
  g.drawImage(S.draw, 0, 0);
  S.mask = makeMask(W, H, S.shape, S.feather * Math.min(W, H));
  g.globalCompositeOperation = 'destination-in'; g.drawImage(S.mask, 0, 0); g.globalCompositeOperation = 'source-over';
  return S.comp;
}
function renderStudio() {
  if (!S.bg) return; const { W, H } = S;
  cx.globalCompositeOperation = 'source-over'; cx.globalAlpha = 1; cx.clearRect(0, 0, W, H);
  if (S.wall) cx.drawImage(S.bg, 0, 0);
  composePanel(true);
  cx.globalAlpha = S.op; cx.globalCompositeOperation = S.blend && S.wall ? 'multiply' : 'source-over';
  cx.drawImage(S.comp, 0, 0); cx.globalAlpha = 1; cx.globalCompositeOperation = 'source-over';
  // guide: area segnata (se estesa) e contorno della forma
  cx.save(); cx.setLineDash([10, 8]); cx.lineWidth = Math.max(2, W / 400);
  const e = S.p.ext || 0; if (e > 0) { const k = e / (1 + 2 * e); cx.strokeStyle = 'rgba(255,255,255,.7)'; cx.strokeRect(k * W, k * H, W * (1 - 2 * k), H * (1 - 2 * k)); }
  if (S.tab === 'forma') { cx.strokeStyle = '#ff5b2e'; shapePath(cx, S.shape, W, H); cx.stroke();
    if (S.shape.type === 'free') (S.shape.pts || []).forEach(p => { cx.setLineDash([]); cx.fillStyle = '#ff5b2e'; cx.beginPath(); cx.arc(p.x * W, p.y * H, W / 120, 0, 7); cx.fill(); }); }
  cx.restore();
}
function studioLoop() { cancelAnimationFrame(S.loop); const tick = () => { if ($('studio').hidden || !S.media || S.media.type !== 'video') return; renderStudio(); S.loop = requestAnimationFrame(tick); }; S.loop = requestAnimationFrame(tick); }
function stopStudioVideo() { if (S.media && S.media.type === 'video') { S.media.el.pause(); URL.revokeObjectURL(S.media.el.src); } cancelAnimationFrame(S.loop); }
async function setVideo(blob) {
  const el = document.createElement('video'); el.muted = true; el.loop = true; el.playsInline = true; el.setAttribute('playsinline', ''); el.src = URL.createObjectURL(blob);
  await new Promise(r => { el.onloadeddata = r; el.onerror = r; setTimeout(r, 6000); });
  el.play().catch(() => {}); S.media = { type: 'video', el, blob }; studioLoop();
}
function syncStudio() {
  document.querySelectorAll('#sFit button').forEach(b => b.classList.toggle('on', b.dataset.fit === S.fit));
  $('sZoom').value = Math.round(S.zoom * 100); $('sZoomO').textContent = Math.round(S.zoom * 100) + '%';
  $('sOp').value = Math.round(S.op * 100); $('sOpO').textContent = Math.round(S.op * 100) + '%';
  $('sFeather').value = Math.round(S.feather * 100); $('sFeatherO').textContent = Math.round(S.feather * 100) + '%';
  $('sBlend').setAttribute('aria-pressed', S.blend); $('sWall').setAttribute('aria-pressed', S.wall);
  $('sSize').value = S.size; $('sSizeO').textContent = S.size; $('sEraser').setAttribute('aria-pressed', S.eraser);
  const adj = S.p.aspectAdj || 0; $('sAspect').value = adj; $('sAspectO').textContent = adj ? (adj > 0 ? '+' : '') + Math.round((Math.pow(2, adj / 100) - 1) * 100) + '%' : 'auto';
  const ext = Math.round((S.p.ext || 0) * 100); $('sExt').value = ext; $('sExtO').textContent = ext + '%';
  document.querySelectorAll('#sShapes button').forEach(b => b.classList.toggle('on', b.dataset.shape === S.shape.type));
  $('sFreeUI').hidden = S.shape.type !== 'free';
  const a = aspectOf(S.p); $('sDims').textContent = a >= 1 ? a.toFixed(2).replace('.', ',') + ' : 1' : '1 : ' + (1 / a).toFixed(2).replace('.', ',');
}
document.querySelectorAll('.seg[role=tablist] button').forEach(b => b.onclick = () => {
  S.tab = b.dataset.tab; document.querySelectorAll('.seg[role=tablist] button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach(t => t.hidden = t.dataset.pane !== S.tab); renderStudio();
});
SHAPES.forEach(([id, label, d]) => { const b = document.createElement('button'); b.type = 'button'; b.dataset.shape = id;
  b.innerHTML = `<svg viewBox="0 0 28 22" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>${label}`;
  b.onclick = () => { S.shape = id === 'free' ? { type: 'free', pts: (S.shape.type === 'free' && S.shape.pts) || [] } : { type: id }; syncStudio(); renderStudio();
    if (id === 'free' && !S.shape.pts.length) toast('Tocca la tela per segnare i contorni della forma'); };
  $('sShapes').appendChild(b); });
$('sFreeUndo').onclick = () => { (S.shape.pts || []).pop(); renderStudio(); };
$('sFreeClear').onclick = () => { S.shape.pts = []; renderStudio(); };
document.querySelectorAll('#sFit button').forEach(b => b.onclick = () => { S.fit = b.dataset.fit; S.zoom = 1; S.pan = { x: 0, y: 0 }; syncStudio(); renderStudio(); });
$('sZoom').oninput = e => { S.zoom = e.target.value / 100; syncStudio(); renderStudio(); };
$('sOp').oninput = e => { S.op = e.target.value / 100; syncStudio(); renderStudio(); };
$('sFeather').oninput = e => { S.feather = e.target.value / 100; syncStudio(); renderStudio(); };
$('sBlend').onclick = () => { S.blend = !S.blend; syncStudio(); renderStudio(); };
$('sWall').onclick = () => { S.wall = !S.wall; syncStudio(); renderStudio(); };
$('sSize').oninput = e => { S.size = +e.target.value; syncStudio(); };
$('sEraser').onclick = () => { S.eraser = !S.eraser; syncStudio(); };
$('sClearDraw').onclick = () => { pushUndo(); S.draw.getContext('2d').clearRect(0, 0, S.W, S.H); renderStudio(); };
$('sClearArt').onclick = () => { stopStudioVideo(); S.media = null; renderStudio(); };
$('sAspect').oninput = e => { S.p.aspectAdj = +e.target.value; syncStudio(); };
$('sAspect').onchange = async () => { S.p.built = null; await layoutStudio(true); syncStudio(); renderStudio(); };
$('sExt').oninput = e => { S.p.ext = e.target.value / 100; syncStudio(); };
$('sExt').onchange = async () => { await layoutStudio(true); syncStudio(); renderStudio(); };
$('sAngles').onclick = async () => { const p = await packProject(); stopStudioVideo(); openAngles(p); };
$('sRedo').onclick = async () => { await packProject(); stopStudioVideo(); show(null); editing = S.p; await openCorners(S.p.frame); };
$('sFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const img = await loadImg(URL.createObjectURL(f)).catch(() => null); e.target.value = ''; if (!img) return toast('Immagine non leggibile');
  const k = Math.min(1, 2048 / Math.max(img.width, img.height)), c = canvasOf(Math.round(img.width * k), Math.round(img.height * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); stopStudioVideo();
  S.media = { type: 'image', img: await loadImg(c.toDataURL('image/jpeg', .9)) }; S.zoom = 1; S.pan = { x: 0, y: 0 }; syncStudio(); renderStudio();
};
$('sVideo').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  if (f.size > 45 * 1024 * 1024) return toast('Video troppo pesante: massimo 45 MB (meglio clip brevi, 10–20 secondi)', 4500);
  stopStudioVideo(); toast('Carico il video…', 1500); await setVideo(f);
  if (!S.media.el.videoWidth) { S.media = null; return toast('Formato video non supportato da questo browser'); }
  S.zoom = 1; S.pan = { x: 0, y: 0 }; syncStudio(); renderStudio();
};
['#ff5b2e', '#ffd23f', '#3ec1d3', '#2a2a2a', '#f5f0ea', '#6a4cff'].forEach((c, i) => {
  const b = document.createElement('button'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', 'Colore ' + c); if (!i) b.classList.add('on');
  b.onclick = () => { S.color = c; S.eraser = false; syncStudio(); document.querySelectorAll('#sSw > *').forEach(x => x.classList.toggle('on', x === b)); };
  $('sSw').appendChild(b);
});
{ const l = document.createElement('label'); l.style.background = 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)'; l.setAttribute('aria-label', 'Altro colore');
  const inp = document.createElement('input'); inp.type = 'color'; inp.id = 'sColor'; inp.oninput = () => { S.color = inp.value; S.eraser = false; syncStudio(); document.querySelectorAll('#sSw > *').forEach(x => x.classList.toggle('on', x === l)); };
  l.appendChild(inp); $('sSw').appendChild(l); }
{ let last = null, moved = 0;
  const pt = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * S.W / r.width, y: (e.clientY - r.top) * S.H / r.height }; };
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); last = pt(e); moved = 0; if (S.tab === 'disegno') { pushUndo(); stroke(last, last); } });
  cv.addEventListener('pointermove', e => { if (!last || !cv.hasPointerCapture(e.pointerId)) return; const p = pt(e); moved += Math.hypot(p.x - last.x, p.y - last.y);
    if (S.tab === 'disegno') stroke(last, p); else if (S.tab === 'opera') { S.pan.x += (p.x - last.x) / S.W; S.pan.y += (p.y - last.y) / S.H; renderStudio(); }
    last = p; });
  cv.addEventListener('pointerup', e => { if (S.tab === 'forma' && S.shape.type === 'free' && last && moved < 8) { S.shape.pts = (S.shape.pts || []).concat({ x: last.x / S.W, y: last.y / S.H }); renderStudio(); } last = null; });
  cv.addEventListener('pointercancel', () => { last = null; });
  function stroke(a, b) { const g = S.draw.getContext('2d'); g.globalCompositeOperation = S.eraser ? 'destination-out' : 'source-over';
    g.strokeStyle = S.color; g.lineWidth = S.size * Math.max(S.W, S.H) / 1024; g.lineCap = g.lineJoin = 'round'; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x + .01, b.y); g.stroke(); renderStudio(); }
}
async function packProject() {
  const p = S.p; composePanel(false);
  const m = S.media, r = mediaRect();
  let media = null;
  if (m && m.type === 'image' && m.img) { const c = canvasOf(m.img.width, m.img.height); c.getContext('2d').drawImage(m.img, 0, 0); media = { type: 'image', art: c.toDataURL('image/jpeg', .88) }; }
  if (m && m.type === 'video') media = { type: 'video', blob: m.blob, rect: r ? { x: r.x / S.W, y: r.y / S.H, w: r.w / S.W, h: r.h / S.H } : { x: 0, y: 0, w: 1, h: 1 } };
  const th = canvasOf(Math.round(S.W * 200 / Math.max(S.W, S.H)), Math.round(S.H * 200 / Math.max(S.W, S.H))), tg = th.getContext('2d');
  composePanel(true); tg.drawImage(S.bg, 0, 0, th.width, th.height); tg.globalAlpha = S.op; if (S.blend) tg.globalCompositeOperation = 'multiply'; tg.drawImage(S.comp, 0, 0, th.width, th.height);
  composePanel(false);
  Object.assign(p, { panel: S.comp.toDataURL('image/png'), mask: S.mask.toDataURL('image/png'), thumb: th.toDataURL('image/jpeg', .8), media, shape: S.shape,
    blend: S.blend, opacity: S.op, updated: Date.now(),
    edit: { drawing: S.draw.toDataURL('image/png'), fit: S.fit, zoom: S.zoom, pan: S.pan, op: S.op, feather: S.feather, blend: S.blend } });
  if (p.media && p.media.type === 'video' && p.videoBlobId !== p.media.blob.size) { p.videoUrl = null; }
  const nV = (p.views || []).length;
  if (!p.built || p.built.aspect !== aspectOf(p) || (p.built.nViews || 0) !== nV) {
    const b = await buildTarget(p), extra = [];
    for (const v of (p.views || [])) { try { const t = await buildTarget(p, v); extra.push({ target: t.target, area: t.area }); } catch (e) { console.warn(e); } }
    p.built = Object.assign(b, { aspect: aspectOf(p), extra, nViews: nV });
  }
  await DB.put(p).catch(() => toast('Memoria piena: esporta il progetto per non perderlo'));
  return p;
}
// dati necessari per vedere l'opera (anche per chi non l'ha creata)
function publicData(p, videoSrc) {
  const e = p.ext || 0, a = p.built.area, v = p.media && p.media.type === 'video';
  const ex = ar => ({ cx: ar.cx, cy: ar.cy, w: ar.w * (1 + 2 * e), h: ar.h * (1 + 2 * e) });
  return { v: 5, id: p.id, created: p.created, updated: p.updated, target: p.built.target, where: p.built.where, quality: p.built.quality,
    area: ex(a), extra: (p.built.extra || []).map(t => ({ target: t.target, area: ex(t.area) })), panel: p.panel, mask: v ? p.mask : null,
    video: v ? { url: videoSrc || p.videoUrl || (p.media.blob ? URL.createObjectURL(p.media.blob) : null), rect: p.media.rect } : null,
    blend: p.blend, opacity: p.opacity };
}
$('sTry').onclick = async () => { const p = await packProject(); stopStudioVideo(); startView([publicData(p)], () => openStudio(p)); };
$('sPublish').onclick = async () => { $('sPublish').disabled = true; try { const p = await packProject(); stopStudioVideo(); await publish(p); } finally { $('sPublish').disabled = false; } };
$('sBack').onclick = async () => { await packProject(); stopStudioVideo(); goHome(); };

/* ------------------------------------------------------------------ 3b. TELA INTERA: disegno e immagini a tutto schermo, con le proporzioni esatte dell'area */
const UNDO = { st: [], re: [] };
function pushUndo() { if (!S.draw) return; UNDO.st.push(S.draw.getContext('2d').getImageData(0, 0, S.W, S.H)); if (UNDO.st.length > 30) UNDO.st.shift(); UNDO.re = []; }
function undoDraw(redo) { const from = redo ? UNDO.re : UNDO.st, to = redo ? UNDO.st : UNDO.re; if (!from.length) return;
  const g = S.draw.getContext('2d'); to.push(g.getImageData(0, 0, S.W, S.H)); g.putImageData(from.pop(), 0, 0); renderStudio(); FS.render(); }
const FS = {
  el: $('full'), cv: $('fCanvas'), view: { s: 1, x: 0, y: 0 }, tool: 'pen', stk: null, ptr: new Map(), pinch: null, last: null,
  open() { this.el.hidden = false; this.tool = S.eraser ? 'eraser' : 'pen'; this.cv.width = S.W; this.cv.height = S.H; this.view = { s: 1, x: 0, y: 0 }; this.stk = null; this.fit(); this.sync(); this.render(); },
  close() { if (this.stk) this.applySticker(); this.el.hidden = true; syncStudio(); renderStudio(); },
  fit() { const r = $('fStage').getBoundingClientRect(), a = S.W / S.H; let w = r.width - 16, h = w / a; if (h > r.height - 16) { h = r.height - 16; w = h * a; }
    Object.assign(this.cv.style, { width: w + 'px', height: h + 'px' }); this.applyView(); },
  applyView() { const v = this.view; this.cv.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.s})`; },
  render() { if (this.el.hidden) return; const g = this.cv.getContext('2d'), { W, H } = S; g.clearRect(0, 0, W, H);
    if (S.wall) g.drawImage(S.bg, 0, 0); else { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); }
    composePanel(true); g.globalAlpha = S.op; g.globalCompositeOperation = S.blend && S.wall ? 'multiply' : 'source-over'; g.drawImage(S.comp, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    const k = this.stk; if (k) { g.save(); g.translate(k.x, k.y); g.rotate(k.r); g.drawImage(k.img, -k.w / 2, -k.h / 2, k.w, k.h);
      g.strokeStyle = '#ff5b2e'; g.lineWidth = Math.max(2, W / 300); g.setLineDash([12, 8]); g.strokeRect(-k.w / 2, -k.h / 2, k.w, k.h); g.restore(); } },
  sync() { $('fPen').setAttribute('aria-pressed', this.tool === 'pen'); $('fEraser').setAttribute('aria-pressed', this.tool === 'eraser'); $('fMove').setAttribute('aria-pressed', this.tool === 'move');
    $('fSize').value = S.size; $('fSizeO').textContent = S.size; $('fWall').setAttribute('aria-pressed', S.wall);
    $('fStk').hidden = !this.stk; $('fTools').hidden = !!this.stk;
    document.querySelectorAll('#fSw > *').forEach(x => x.classList.toggle('on', x.dataset.c === S.color)); },
  pt(e) { const r = this.cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * S.W / r.width, y: (e.clientY - r.top) * S.H / r.height }; },
  line(a, b) { const g = S.draw.getContext('2d'); g.globalCompositeOperation = this.tool === 'eraser' ? 'destination-out' : 'source-over';
    g.strokeStyle = S.color; g.lineWidth = S.size * Math.max(S.W, S.H) / 1024 / Math.sqrt(this.view.s); g.lineCap = g.lineJoin = 'round';
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x + .01, b.y); g.stroke(); g.globalCompositeOperation = 'source-over'; },
  async addImage(f) { const img = await loadImg(URL.createObjectURL(f)).catch(() => null); if (!img) return toast('Immagine non leggibile');
    const k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = canvasOf(Math.round(img.width * k), Math.round(img.height * k)); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const s = Math.min(S.W * .6 / c.width, S.H * .6 / c.height); this.stk = { img: c, x: S.W / 2, y: S.H / 2, w: c.width * s, h: c.height * s, r: 0 }; this.sync(); this.render();
    toast('Un dito sposta, due dita ingrandiscono e ruotano', 2600); },
  applySticker() { const k = this.stk; if (!k) return; pushUndo(); const g = S.draw.getContext('2d'); g.save(); g.translate(k.x, k.y); g.rotate(k.r); g.drawImage(k.img, -k.w / 2, -k.h / 2, k.w, k.h); g.restore();
    this.stk = null; this.sync(); this.render(); renderStudio(); },
};
{ const st = $('fStage');
  st.addEventListener('pointerdown', e => { st.setPointerCapture(e.pointerId); FS.ptr.set(e.pointerId, { x: e.clientX, y: e.clientY }); FS.pinch = null;
    if (FS.ptr.size === 1 && !FS.stk && FS.tool !== 'move') { pushUndo(); FS.last = FS.pt(e); FS.line(FS.last, FS.last); FS.render(); }
    if (FS.ptr.size === 2 && FS.last && !FS.stk) { undoDraw(); UNDO.re = []; FS.last = null; } }); // il secondo dito annulla il punto appena iniziato
  st.addEventListener('pointermove', e => { const prev = FS.ptr.get(e.pointerId); if (!prev) return; const cur = { x: e.clientX, y: e.clientY };
    if (FS.ptr.size === 1) {
      if (FS.stk) { const r = FS.cv.getBoundingClientRect(), k = S.W / r.width; FS.stk.x += (cur.x - prev.x) * k; FS.stk.y += (cur.y - prev.y) * k; FS.render(); }
      else if (FS.tool === 'move') { FS.view.x += cur.x - prev.x; FS.view.y += cur.y - prev.y; FS.applyView(); }
      else if (FS.last) { const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]; (evs.length ? evs : [e]).forEach(ev => { const p = FS.pt(ev); FS.line(FS.last, p); FS.last = p; }); FS.render(); }
    } else if (FS.ptr.size === 2) {
      const [a, b] = [...FS.ptr.entries()].map(([id, p]) => id === e.pointerId ? cur : p), d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (FS.pinch) { const ks = d / FS.pinch.d;
        if (FS.stk) { FS.stk.w *= ks; FS.stk.h *= ks; FS.stk.r += ang - FS.pinch.ang; const r = FS.cv.getBoundingClientRect(), k = S.W / r.width; FS.stk.x += (mid.x - FS.pinch.mid.x) * k; FS.stk.y += (mid.y - FS.pinch.mid.y) * k; FS.render(); }
        else { FS.view.s = Math.max(.5, Math.min(8, FS.view.s * ks)); FS.view.x += mid.x - FS.pinch.mid.x; FS.view.y += mid.y - FS.pinch.mid.y; FS.applyView(); } }
      FS.pinch = { d, ang, mid };
    }
    FS.ptr.set(e.pointerId, cur); });
  ['pointerup', 'pointercancel'].forEach(t => st.addEventListener(t, e => { FS.ptr.delete(e.pointerId); FS.pinch = null; if (!FS.ptr.size) { if (FS.last) renderStudio(); FS.last = null; } }));
}
addEventListener('resize', () => { if (!FS.el.hidden) FS.fit(); });
['#ff5b2e', '#ffd23f', '#3ec1d3', '#2a2a2a', '#f5f0ea', '#6a4cff', '#2ecc71', '#e84393'].forEach(c => { const b = document.createElement('button'); b.type = 'button'; b.dataset.c = c; b.style.background = c; b.setAttribute('aria-label', 'Colore ' + c);
  b.onclick = () => { S.color = c; if (FS.tool !== 'pen') FS.tool = 'pen'; FS.sync(); }; $('fSw').appendChild(b); });
{ const l = document.createElement('label'); l.style.background = 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)'; l.setAttribute('aria-label', 'Altro colore');
  const inp = document.createElement('input'); inp.type = 'color'; inp.oninput = () => { S.color = inp.value; l.dataset.c = inp.value; FS.tool = 'pen'; FS.sync(); }; l.appendChild(inp); $('fSw').appendChild(l); }
$('fPen').onclick = () => { FS.tool = 'pen'; FS.sync(); };
$('fEraser').onclick = () => { FS.tool = 'eraser'; FS.sync(); };
$('fMove').onclick = () => { FS.tool = FS.tool === 'move' ? 'pen' : 'move'; FS.sync(); };
$('fFit').onclick = () => { FS.view = { s: 1, x: 0, y: 0 }; FS.applyView(); };
$('fUndo').onclick = () => undoDraw(false);
$('fRedo').onclick = () => undoDraw(true);
$('fSize').oninput = e => { S.size = +e.target.value; $('fSizeO').textContent = S.size; };
$('fWall').onclick = () => { S.wall = !S.wall; FS.sync(); FS.render(); };
$('fImg').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) FS.addImage(f); };
$('fStkOk').onclick = () => FS.applySticker();
$('fStkNo').onclick = () => { FS.stk = null; FS.sync(); FS.render(); };
$('fClear').onclick = () => { pushUndo(); S.draw.getContext('2d').clearRect(0, 0, S.W, S.H); FS.render(); renderStudio(); };
$('fDone').onclick = () => FS.close();
document.querySelectorAll('[data-full]').forEach(b => b.onclick = () => { UNDO.st = []; UNDO.re = []; FS.open(); });

/* ------------------------------------------------------------------ 4. PUBBLICA */
let pubP = null;
async function publish(p) {
  pubP = p; let online = false;
  if (ONLINE) { toast('Pubblico l’opera…', 2500); try {
      if (p.media && p.media.type === 'video' && !p.videoUrl) { const ext = (p.media.blob.type.split('/')[1] || 'mp4').replace('quicktime', 'mov'); p.videoUrl = await Cloud.put(p.id + '-' + Date.now() + '.' + ext, p.media.blob, p.media.blob.type || 'video/mp4'); }
      await Cloud.put(p.id + '.json', JSON.stringify(publicData(p, p.videoUrl)), 'application/json'); online = true; p.published = Date.now(); await DB.put(p).catch(() => {});
    } catch (e) { console.error(e); toast('Pubblicazione non riuscita: controlla la connessione', 4000); } }
  openPublish(p, online || !!p.published);
}
function openPublish(p, online) {
  pubP = p; show('publish'); $('pId').textContent = p.id;
  const url = viewURL(p.id); $('pUrl').textContent = url;
  QRCode.toCanvas($('pQr'), url, { width: 520, margin: 2, errorCorrectionLevel: 'M' }, () => {});
  $('pState').innerHTML = online ? '<b>Online.</b> Chi inquadra questo QR apre l’opera e la vede sul muro, senza toccare niente.'
    : ONLINE ? 'Non ancora online: riprova con “Pubblica” quando hai connessione.'
    : '<b>Solo su questo telefono.</b> Per farla vedere ad altri attiva la pubblicazione online (vedi LEGGIMI) oppure esporta il file e mettilo nella cartella “progetti” del sito.';
  const q = p.built ? p.built.quality : 1, el = $('pQuality'); el.hidden = false; el.className = 'quality' + (q >= .1 ? ' good' : '');
  el.textContent = q >= .1 ? 'Il punto ha molti dettagli: il riconoscimento sarà affidabile.'
    : q >= .05 ? 'Dettagli nella media: si aggancia bene da vicino e con buona luce. Per migliorare, rifai la foto includendo più contorno.'
    : 'Superficie molto uniforme: il telefono potrebbe faticare a riconoscerla. Rifai la foto includendo porte, finestre o spigoli vicini.';
}
$('pShare').onclick = async () => { const url = viewURL(pubP.id);
  try { if (navigator.share) { await navigator.share({ title: 'Murale AR', text: 'Inquadra il muro e guarda l’opera', url }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Link copiato'); } catch (e) { toast(url, 5000); } };
$('pSaveQr').onclick = () => {
  const c = canvasOf(1200, 1500), g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1200, 1500);
  const tmp = canvasOf(1000, 1000); QRCode.toCanvas(tmp, viewURL(pubP.id), { width: 1000, margin: 2 }, () => {
    g.drawImage(tmp, 100, 80); g.fillStyle = '#111'; g.textAlign = 'center'; g.font = '800 72px -apple-system,Helvetica,Arial,sans-serif'; g.fillText('MURALE AR', 600, 1200);
    g.font = '400 40px -apple-system,Helvetica,Arial,sans-serif'; g.fillStyle = '#555'; g.fillText('Inquadra il codice, poi il muro', 600, 1270); g.fillText('Opera ' + pubP.id, 600, 1330);
    c.toBlob(b => saveBlob(b, 'qr-opera-' + pubP.id + '.png'), 'image/png'); });
};
$('pView').onclick = () => startView([publicData(pubP)], () => openPublish(pubP, !!pubP.published));
$('pExport').onclick = () => exportProject(pubP);
document.querySelectorAll('[data-home]').forEach(b => b.onclick = goHome);
async function exportProject(p) {
  const o = Object.assign({}, p);
  if (o.media && o.media.type === 'video' && o.media.blob) o.media = Object.assign({}, o.media, { blob: null, dataURL: await blobToDataURL(o.media.blob) });
  saveBlob(new Blob([JSON.stringify(o)], { type: 'application/json' }), p.id + '.json');
}

/* ------------------------------------------------------------------ motore AR (più opere insieme) */
const XRS = { canvas: $('xrc'), added: false, running: false, scene: null, camera: null, works: [], anchors: new Map(), tmap: new Map(), targets: [], hooks: {} };
function xrLoaded() { return new Promise(r => window.XR8 ? r() : window.addEventListener('xrloaded', r, { once: true })); }
async function askMotion() {
  try { if (window.DeviceMotionEvent && DeviceMotionEvent.requestPermission) await DeviceMotionEvent.requestPermission(); } catch (e) {}
  try { if (window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission) await DeviceOrientationEvent.requestPermission(); } catch (e) {}
}
// canvas con le proporzioni vere della fotocamera: niente ritaglio, niente effetto zoom
XRS.camAspect = 3 / 4;
function sizeCanvas() {
  const d = Math.min(window.devicePixelRatio || 1, 2), a = XRS.camAspect; let w = innerWidth, h = w / a;
  if (h > innerHeight) { h = innerHeight; w = h * a; }
  Object.assign(XRS.canvas.style, { position: 'fixed', width: w + 'px', height: h + 'px', left: (innerWidth - w) / 2 + 'px', top: (innerHeight - h) / 2 + 'px' });
  XRS.canvas.width = Math.round(w * d); XRS.canvas.height = Math.round(h * d);
}
addEventListener('resize', () => { if (XRS.running) sizeCanvas(); });
function setChip(t, ok) { $('chipT').textContent = t; $('chip').classList.toggle('ok', !!ok); }
/* Aggancio v6 — fusione continua tra riconoscimento del punto e tracciamento del movimento.
   - Quando il punto è visibile (da qualsiasi angolazione) l'opera viene corretta subito, in modo morbido: niente "zona morta".
   - Quando non è visibile, la tiene ferma il tracciamento del movimento (SLAM).
   - Le angolazioni extra vengono calibrate al volo sulla frontale: niente salti passando da un'impronta all'altra.
   - Una stima isolata e lontana viene scartata; se 3 stime di fila confermano un nuovo posto, l'opera ci scivola in un attimo.
   - Il movimento a schermo è una molla smorzata a ogni fotogramma: fluido anche se le stime arrivano a scatti. */
const LOCK = { need: 4, spread: .05, near: .22, follow: .35, confirm: 3, confirmSpread: .07, tau: .085, tauSnap: .05, learnWin: 1800, learnMax: .35, learnN: 6 };
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const SLAM = { ok: true, reason: '', badAt: 0, okAt: 0 };
function areaPose(d, area) {
  const p = new THREE.Vector3(d.position.x, d.position.y, d.position.z), q = new THREE.Quaternion(d.rotation.x, d.rotation.y, d.rotation.z, d.rotation.w).normalize();
  _v.set(area.cx, area.cy, .002).multiplyScalar(d.scale).applyQuaternion(q);
  return { p: p.add(_v), q, h: area.h * d.scale };
}
function meanPose(list) {
  const p = new THREE.Vector3(), q = list[0].q.clone(); let h = 0;
  list.forEach((s, i) => { p.add(s.p); h += s.h; if (i) { const sq = s.q.dot(q) < 0 ? s.q.clone().set(-s.q.x, -s.q.y, -s.q.z, -s.q.w) : s.q; q.slerp(sq, 1 / (i + 1)); } });
  return { p: p.divideScalar(list.length), q, h: h / list.length };
}
const devOf = (a, b) => a.p.distanceTo(b.p) / b.h + (1 - Math.abs(a.q.dot(b.q))) * 4 + Math.abs(a.h / b.h - 1) * .5;
const spreadOf = (list, m) => Math.max(...list.map(s => devOf(s, m)));
const clonePose = s => ({ p: s.p.clone(), q: s.q.clone(), h: s.h });
// posizione dell'opera "vista dall'impronta": rel = differenza tra stima di questa impronta e opera vera, nel sistema locale dell'impronta
function relOf(s, ref) { _qi.copy(s.q).invert(); return { p: ref.p.clone().sub(s.p).applyQuaternion(_qi).divideScalar(s.h), q: _qi.clone().multiply(ref.q), k: ref.h / s.h }; }
function applyRel(s, r) { return { p: s.p.clone().add(r.p.clone().multiplyScalar(s.h).applyQuaternion(s.q)), q: s.q.clone().multiply(r.q).normalize(), h: s.h * r.k }; }
function blendPose(a, b, k) { if (b.q.dot(a.q) < 0) b = { p: b.p, q: b.q.clone().set(-b.q.x, -b.q.y, -b.q.z, -b.q.w), h: b.h };
  a.p.lerp(b.p, k); a.q.slerp(b.q, k); a.h += (b.h - a.h) * k; }
function setPose(G, m) { G.position.copy(m.p); G.quaternion.copy(m.q); G.scale.setScalar(m.h); G.updateMatrixWorld(true); }
function onImage(d) {
  const T = XRS.tmap.get(d.name); if (!T) return; const A = T.A, G = A.group, now = performance.now(), raw = areaPose(d, T.area);
  const main = T.main; A.seen[d.name] = now;
  if (!IS_MOBILE) { // computer: niente tracciamento del movimento, l'opera segue l'immagine
    if (!A.samples) setPose(G, raw); else { G.position.lerp(raw.p, .5); G.quaternion.slerp(raw.q, .5); G.scale.setScalar(G.scale.x + (raw.h - G.scale.x) * .5); G.updateMatrixWorld(true); }
    if (A.samples++ === 0) XRS.hooks.found && XRS.hooks.found(A); return;
  }
  // 1. stima corretta con la calibrazione dell'impronta (le angolazioni extra si allineano alla frontale)
  let s = raw; const off = A.off[d.name];
  if (!main && off && off.n >= LOCK.learnN) s = applyRel(raw, off.r);
  if (main) A.mainAt = now;
  // 2. calibrazione al volo: un'impronta extra impara dove sta l'opera rispetto a sé, finché il riferimento è fresco e affidabile
  if (!main && A.goal && SLAM.ok && now - A.mainAt < LOCK.learnWin && now - SLAM.badAt > 800 && !(off && off.n >= 20)) {
    const r = relOf(raw, A.goal), mag = r.p.length() + (1 - Math.abs(r.q.w)) * 4 + Math.abs(r.k - 1) * .5;
    if (mag < LOCK.learnMax) {
      if (!off) A.off[d.name] = { r, n: 1 };
      else { const k = 1 / (off.n + 1); off.r.p.lerp(r.p, k); if (r.q.dot(off.r.q) < 0) r.q.set(-r.q.x, -r.q.y, -r.q.z, -r.q.w); off.r.q.slerp(r.q, k); off.r.k += (r.k - off.r.k) * k; off.n++; }
    }
  }
  A.hist.push({ s, t: now, main }); while (A.hist.length > 6 || (A.hist.length && now - A.hist[0].t > 500)) A.hist.shift();
  if (A.samples++ === 0) XRS.hooks.found && XRS.hooks.found(A);
  // 3. primo aggancio: poche stime coerenti e l'opera si fissa
  if (!A.locked) {
    A.buf.push(s); if (A.buf.length > 10) A.buf.shift();
    const m = meanPose(A.buf); if (!A.goal) { A.goal = clonePose(m); setPose(G, m); } else A.goal = m;
    if (A.buf.length >= LOCK.need && (spreadOf(A.buf, m) < LOCK.spread || A.samples >= 24)) { A.locked = true; A.buf = []; XRS.hooks.locked && XRS.hooks.locked(A); }
    else if (A.buf.length >= 8) A.buf = A.buf.filter(x => devOf(x, m) < LOCK.spread * 2);
    return;
  }
  // 4. opera fissata: correzione continua
  const dev = devOf(s, A.goal);
  // un'impronta extra non ancora calibrata pesa meno della frontale
  const w = main || (off && off.n >= LOCK.learnN) ? 1 : .45;
  if (dev < LOCK.near) { blendPose(A.goal, s, LOCK.follow * w); A.snap = false; return; }
  // stima lontana: la accetto solo se confermata da stime recenti coerenti (dopo un recupero del tracciamento ne bastano 2)
  const need = now - SLAM.okAt < 2500 ? 2 : LOCK.confirm, recent = A.hist.slice(-need);
  if (recent.length < need) return;
  const m = meanPose(recent.map(x => x.s));
  if (spreadOf(recent.map(x => x.s), m) < LOCK.confirmSpread) { A.goal = m; A.snap = true; A.jumps++; }
}
// molla smorzata: a ogni fotogramma l'opera si avvicina all'obiettivo, indipendentemente da quante stime arrivano
let lastStep = 0;
function stepMoves(now) {
  const dt = lastStep ? Math.min(.1, (now - lastStep) / 1000) : .016; lastStep = now;
  XRS.anchors.forEach(A => { if (!A.goal || !IS_MOBILE) return; const G = A.group;
    const k = 1 - Math.exp(-dt / (A.snap ? LOCK.tauSnap : LOCK.tau));
    _q.copy(A.goal.q); if (_q.dot(G.quaternion) < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
    G.position.lerp(A.goal.p, k); G.quaternion.slerp(_q, k); G.scale.setScalar(G.scale.x + (A.goal.h - G.scale.x) * k); G.updateMatrixWorld(true);
    if (A.snap && G.position.distanceTo(A.goal.p) / A.goal.h < .01) A.snap = false; });
}
function onTracking(d) {
  const ok = d.status === 'NORMAL', now = performance.now();
  if (!ok) SLAM.badAt = now; else if (!SLAM.ok) SLAM.okAt = now;
  SLAM.ok = ok; SLAM.reason = d.reason || ''; diag();
}
function diag() {
  const el = $('diag'); if (!el || !XRS.running) return; const now = performance.now(); let vis = [];
  XRS.anchors.forEach(A => Object.keys(A.seen).forEach(n => { if (now - A.seen[n] < 400) vis.push(n.split('~')[1] === '0' ? 'frontale' : 'ang. ' + (+n.split('~')[1] + 1)); }));
  let cal = 0, tot = 0; XRS.anchors.forEach(A => { tot += XRS.targets.filter(t => t.work.id === A.id && !t.name.endsWith('~0')).length; Object.values(A.off).forEach(o => { if (o.n >= LOCK.learnN) cal++; }); });
  const why = { EXCESSIVE_MOTION: 'movimento troppo veloce', INSUFFICIENT_FEATURES: 'pochi dettagli / poca luce', INSUFFICIENT_LIGHT: 'poca luce', INITIALIZING: 'avvio', RELOCALIZING: 'riallineo' }[SLAM.reason] || SLAM.reason.toLowerCase();
  el.textContent = 'Punto: ' + (vis.length ? vis.join(' + ') : '—') + ' · Movimento: ' + (SLAM.ok ? 'ok' : why || 'limitato') + (tot ? ' · Angolazioni calibrate ' + cal + '/' + tot : '');
  el.classList.toggle('bad', !SLAM.ok);
}
const mainModule = {
  name: 'murale',
  onStart: () => {
    const { scene, camera } = XR8.Threejs.xrScene(); XRS.scene = scene; XRS.camera = camera;
    camera.position.set(0, 1.6, 0); XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion });
    XRS.anchors.forEach(A => scene.remove(A.group)); XRS.anchors.clear();
    XRS.tmap.clear();
    XRS.works.forEach(w => { const group = new THREE.Group(); group.visible = false; scene.add(group);
      const A = { id: w.id, work: w, group, samples: 0, buf: [], hist: [], off: {}, seen: {}, mainAt: -1e9, goal: null, snap: false, jumps: 0, locked: false, reveal: 0, t0: 0, mat: null }; XRS.anchors.set(w.id, A);
      XRS.targets.filter(t => t.work === w).forEach(t => XRS.tmap.set(t.name, { A, area: t.area, main: t.name.endsWith('~0') })); });
    Object.assign(SLAM, { ok: true, reason: '', badAt: 0, okAt: 0 }); lastStep = 0;
    XRS.hooks.start && XRS.hooks.start();
  },
  onUpdate: () => { const now = performance.now(); stepMoves(now); XRS.hooks.frame && XRS.hooks.frame(); if (now - (XRS.diagAt || 0) > 250) { XRS.diagAt = now; diag(); } },
  onCameraStatusChange: ({ status, video }) => {
    if (status === 'requesting') setChip('Consenti la fotocamera…');
    if (status === 'hasVideo') { setChip(XRS.works.length > 1 ? 'Cerco le opere…' : 'Cerco il punto…');
      if (video && video.videoWidth) { let a = video.videoWidth / video.videoHeight; if ((innerHeight > innerWidth) !== (a < 1)) a = 1 / a; XRS.camAspect = a; sizeCanvas(); } }
    if (status === 'failed') xrFail('Non riesco ad aprire la fotocamera. Consenti l’accesso nelle impostazioni di Safari e riprova.');
  },
  onException: e => console.error(e),
  listeners: [
    { event: 'reality.imagefound', process: ({ detail }) => onImage(detail) },
    { event: 'reality.imageupdated', process: ({ detail }) => onImage(detail) },
    { event: 'reality.imagelost', process: ({ detail }) => XRS.hooks.lost && XRS.hooks.lost(detail) },
    { event: 'reality.trackingstatus', process: ({ detail }) => onTracking(detail) },
  ],
};
function xrFail(msg) { const b = XRS.hooks.back; stopXR(); toast(msg, 5000); b ? b() : goHome(); }
async function startXR(works, hooks) {
  XRS.hooks = hooks; XRS.works = works.slice(0, MAX_TARGETS);
  // tutte le impronte (frontale + angolazioni), al massimo 10: prima le frontali di ogni opera, poi le angolazioni
  const T = []; XRS.works.forEach(w => T.push({ work: w, name: w.id + '~0', image: w.target, area: w.area }));
  for (let k = 0; k < 4; k++) XRS.works.forEach(w => { const e = (w.extra || [])[k]; if (e && e.target) T.push({ work: w, name: w.id + '~' + (k + 1), image: e.target, area: e.area }); });
  XRS.targets = T.slice(0, MAX_TARGETS);
  const motion = askMotion();
  show(null); $('ar').hidden = false; setChip('Carico il motore AR…'); $('guide').style.opacity = 1;
  await motion;
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return xrFail('La fotocamera funziona solo da un indirizzo https.');
  await xrLoaded();
  try { if (XR8.loadChunk) await XR8.loadChunk('slam'); } catch (e) {}
  XR8.XrController.configure({ disableWorldTracking: !IS_MOBILE, imageTargetData: XRS.targets.map(t => ({ imagePath: t.image, metadata: {}, name: t.name, type: 'PLANAR',
    properties: { left: 0, top: 0, width: 480, height: 640, originalWidth: 480, originalHeight: 640, isRotated: false } })) });
  XR8.CanvasScreenshot.configure({ maxDimension: 2048, jpgCompression: 88 });
  if (!XRS.added) { XR8.addCameraPipelineModules([XR8.GlTextureRenderer.pipelineModule(), XR8.Threejs.pipelineModule(), XR8.XrController.pipelineModule(), XR8.CanvasScreenshot.pipelineModule(), mainModule]); XRS.added = true; }
  XRS.canvas.hidden = false; sizeCanvas(); XRS.running = true;
  XR8.run({ canvas: XRS.canvas, allowedDevices: XR8.XrConfig.device().ANY });
}
function stopXR() { if (XRS.running) { try { XR8.stop(); } catch (e) {} } XRS.running = false; XRS.canvas.hidden = true; $('ar').hidden = true;
  V.videos.forEach(v => { v.pause(); }); V.videos = []; }
$('arBack').onclick = () => { const b = XRS.hooks.back; stopXR(); b ? b() : goHome(); };

/* ------------------------------------------------------------------ 5. GUARDA / ESPLORA */
const V = { hold: false, op: 1, blend: false, videos: [], audio: false };
const texCache = new Map();
function texFrom(src) { if (texCache.has(src)) return texCache.get(src); const t = new THREE.TextureLoader().load(src); t.colorSpace = THREE.SRGBColorSpace; texCache.set(src, t); return t; }
const WHITE = (() => { const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); t.needsUpdate = true; return t; })();
function buildArt(A) {
  const w = A.work; let vtex = WHITE;
  if (w.video && w.video.url) {
    const el = document.createElement('video'); el.src = w.video.url; el.crossOrigin = 'anonymous'; el.muted = !V.audio; el.loop = true; el.playsInline = true; el.setAttribute('playsinline', ''); el.preload = 'auto';
    el.play().catch(() => {}); V.videos.push(el); vtex = new THREE.VideoTexture(el); vtex.colorSpace = THREE.SRGBColorSpace; A.video = el;
  }
  const r = w.video ? w.video.rect : { x: 0, y: 0, w: 1, h: 1 };
  A.mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: texFrom(w.panel) }, mask: { value: w.mask ? texFrom(w.mask) : WHITE }, vmap: { value: vtex }, hasV: { value: w.video ? 1 : 0 },
      vrect: { value: new THREE.Vector4(r.x, r.y, r.w, r.h) }, opacity: { value: 1 }, mul: { value: 0 }, reveal: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform sampler2D map, mask, vmap; uniform float opacity, mul, reveal, hasV; uniform vec4 vrect; varying vec2 vUv;
      void main(){
        vec4 over = texture2D(map, vUv);
        vec4 base = vec4(0.0);
        if (hasV > 0.5) {
          vec2 pu = vec2(vUv.x, 1.0 - vUv.y), t = (pu - vrect.xy) / vrect.zw;
          if (t.x >= 0.0 && t.x <= 1.0 && t.y >= 0.0 && t.y <= 1.0) base = vec4(texture2D(vmap, vec2(t.x, 1.0 - t.y)).rgb, 1.0);
          base.a *= texture2D(mask, vUv).a;
        }
        float a0 = over.a + base.a * (1.0 - over.a);
        vec3 c = a0 > 0.001 ? (over.rgb * over.a + base.rgb * base.a * (1.0 - over.a)) / a0 : vec3(0.0);
        float d = 1.0 - vUv.y;
        float vis = 1.0 - smoothstep(reveal - 0.12, reveal, d);
        float glow = smoothstep(reveal - 0.12, reveal - 0.02, d) * vis * (1.0 - step(1.05, reveal));
        float a = a0 * opacity * vis;
        vec3 col = mix(c, vec3(1.0, 0.55, 0.35), glow * 0.6);
        if (mul > 0.5) gl_FragColor = vec4(mix(vec3(1.0), col, a), 1.0); else gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w.area.w / w.area.h, 1), A.mat); m.renderOrder = 2; A.group.add(m);
}
function setBlend(on) { V.blend = on; $('vBlend').setAttribute('aria-pressed', on);
  XRS.anchors.forEach(A => { if (!A.mat) return; A.mat.uniforms.mul.value = on ? 1 : 0; A.mat.blending = on ? THREE.MultiplyBlending : THREE.NormalBlending; A.mat.needsUpdate = true; }); }
function renderStrip() {
  const s = $('guideStrip'); s.innerHTML = '';
  XRS.works.slice(0, 6).forEach(w => { const i = document.createElement('img'); i.src = w.where || w.target; i.alt = 'Punto dell’opera ' + w.id; i.dataset.id = w.id; s.appendChild(i); });
  $('guideT').textContent = XRS.works.length > 1 ? 'Inquadra uno di questi punti' : 'Inquadra questo punto';
}
function foundCount() { let n = 0; XRS.anchors.forEach(A => { if (A.samples) n++; }); return n; }
function startView(works, back) {
  works = works.filter(w => w && w.target && w.panel); if (!works.length) return toast('Nessuna opera da mostrare');
  V.op = works.length === 1 ? (works[0].opacity ?? 1) : 1; $('vOp').value = Math.round(V.op * 100); $('vOpO').textContent = Math.round(V.op * 100) + '%';
  V.audio = false; $('vAudio').setAttribute('aria-pressed', 'false'); $('vAudio').hidden = !works.some(w => w.video);
  startXR(works, {
    start: () => { XRS.anchors.forEach(buildArt); setBlend(works.length === 1 && !!works[0].blend); renderStrip(); },
    found: A => { A.group.visible = true; A.t0 = performance.now(); if (A.video) A.video.play().catch(() => {});
      const n = foundCount(); setChip(n > 1 ? n + ' opere sul muro' : 'Opera sul muro', true);
      const img = $('guideStrip').querySelector('[data-id="' + A.id + '"]'); if (img) img.classList.add('found');
      if (n >= Math.min(XRS.works.length, 1) && XRS.works.length === 1) $('guide').style.opacity = 0;
      else if (n === XRS.works.length) $('guide').style.opacity = 0; else $('guide').style.opacity = .55;
      if (navigator.vibrate) navigator.vibrate(20); },
    locked: () => { setChip(foundCount() > 1 ? foundCount() + ' opere fissate' : 'Opera fissata: girale intorno', true); if (navigator.vibrate) navigator.vibrate([12, 40, 12]); },
    lost: () => { if (foundCount()) setChip(foundCount() > 1 ? foundCount() + ' opere fissate' : 'Opera fissata', true); },
    frame: () => { const now = performance.now(); XRS.anchors.forEach(A => { if (!A.mat) return;
      if (A.t0) A.reveal = Math.min(1.1, ease(Math.min(1, (now - A.t0) / 1800)) * 1.1);
      A.mat.uniforms.reveal.value = A.reveal; A.mat.uniforms.opacity.value = V.hold ? 0 : V.op; }); },
    back: back || goHome,
  });
}
$('vOp').oninput = e => { V.op = e.target.value / 100; $('vOpO').textContent = e.target.value + '%'; };
$('vBlend').onclick = () => setBlend(!V.blend);
$('vAudio').onclick = () => { V.audio = !V.audio; $('vAudio').setAttribute('aria-pressed', V.audio); V.videos.forEach(v => { v.muted = !V.audio; v.play().catch(() => {}); }); };
$('vRe').onclick = () => { XRS.anchors.forEach(A => { A.samples = 0; A.buf = []; A.hist = []; A.goal = null; A.snap = false; A.locked = false; A.group.visible = false; A.t0 = 0; A.reveal = 0; }); renderStrip(); $('guide').style.opacity = 1; setChip('Inquadra di nuovo il punto'); };
{ const h = $('vHold'); const on = e => { e.preventDefault(); V.hold = true; h.setAttribute('aria-pressed', 'true'); }, off = () => { V.hold = false; h.setAttribute('aria-pressed', 'false'); };
  h.addEventListener('pointerdown', on); ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => h.addEventListener(ev, off)); h.addEventListener('contextmenu', e => e.preventDefault()); }
$('vShot').onclick = async () => { try { const b64 = await XR8.CanvasScreenshot.takeScreenshot(); const b = await (await fetch('data:image/jpeg;base64,' + b64)).blob(); saveBlob(b, 'murale-ar.jpg'); } catch (e) { toast('Non riesco a salvare la foto'); } };

/* ---- raccolta opere da mostrare insieme: locali + online + cartella progetti ---- */
async function gatherWorks(firstId) {
  const out = new Map(), add = w => { if (w && w.target && w.panel && !out.has(w.id)) out.set(w.id, w); };
  if (firstId) add(await findPublic(firstId));
  (await DB.all()).filter(p => p.panel && p.built).sort((a, b) => (b.updated || 0) - (a.updated || 0)).forEach(p => add(publicData(p)));
  if (ONLINE && out.size < MAX_TARGETS) { try { const ids = await Cloud.list(MAX_TARGETS); await Promise.all(ids.filter(id => !out.has(id)).slice(0, MAX_TARGETS - out.size).map(async id => add(await Cloud.get(id).catch(() => null)))); } catch (e) {} }
  try { const r = await fetch('progetti/elenco.json', { cache: 'no-store' }); if (r.ok) for (const id of (await r.json())) { if (out.size >= MAX_TARGETS) break; if (!out.has(id)) { const x = await fetch('progetti/' + id + '.json'); if (x.ok) add(normalize(await x.json())); } } } catch (e) {}
  return [...out.values()].slice(0, MAX_TARGETS);
}
function normalize(d) { if (!d) return null; if (d.target) return d; if (d.built && d.panel) { if (d.media && d.media.dataURL) d.media.blob = null; return publicData(d, d.media && d.media.dataURL); } return null; }
async function findPublic(id) {
  const local = await DB.get(id); if (local && local.panel && local.built) return publicData(local);
  if (ONLINE) { try { const p = await Cloud.get(id); if (p) return p; } catch (e) {} }
  try { const r = await fetch('progetti/' + id + '.json', { cache: 'no-store' }); if (r.ok) return normalize(await r.json()); } catch (e) {}
  return null;
}
async function explore(firstId) {
  // nota: il tocco serve a iOS per i permessi; li chiedo subito, poi carico le opere
  const motion = askMotion(); toast('Carico le opere…', 1500);
  const works = await gatherWorks(firstId); await motion;
  if (!works.length) return toast('Ancora nessuna opera: creane una o apri il link di un’opera', 4000);
  startView(works, goHome);
}

/* ------------------------------------------------------------------ HOME */
$('hNew').onclick = () => openCapture(null);
$('hExplore').onclick = () => explore(null);
$('hImport').onchange = async e => { const f = e.target.files[0]; if (!f) return;
  try { const p = JSON.parse(await f.text()); if (!p.id || !(p.q || p.area)) throw 0;
    if (p.media && p.media.dataURL) { p.media.blob = await (await fetch(p.media.dataURL)).blob(); delete p.media.dataURL; }
    await DB.put(p); toast('Opera ' + p.id + ' importata'); renderList(); } catch (_) { toast('File non valido'); } e.target.value = ''; };
async function renderList() {
  const list = (await DB.all()).sort((a, b) => (b.updated || 0) - (a.updated || 0)), ul = $('hList'); ul.innerHTML = '';
  $('hEmpty').hidden = !!list.length;
  $('hNearby').innerHTML = list.filter(p => p.thumb).slice(0, 8).map(p => `<img alt="" src="${p.thumb}">`).join('');
  list.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<img alt="" src="${p.thumb || p.frame || ''}"><div class="meta"><b>Opera ${p.id}${p.media && p.media.type === 'video' ? ' · video' : ''}</b><span class="mute small">${p.published ? 'Online' : 'Solo su questo telefono'} · ${new Date(p.updated || p.created).toLocaleDateString('it-IT')}</span><div class="acts"></div></div>`;
    const acts = li.querySelector('.acts'), ready = !!(p.panel && p.built), btns = [];
    if (ready) btns.push(['Guarda', () => startView([publicData(p)])]);
    if (p.frame) btns.push(['Studio', () => openStudio(p)]);
    if (ready) btns.push(['QR', () => openPublish(p, !!p.published)]);
    btns.push(['Esporta', () => exportProject(p)]);
    btns.forEach(([t, fn]) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.onclick = fn; acts.appendChild(b); });
    ul.appendChild(li);
  });
}
async function goHome() {
  show('home'); renderList();
  if (urlId) {
    $('hViewId').textContent = urlId;
    const d = await findPublic(urlId);
    if (d) { $('hView').hidden = false; $('hViewErr').hidden = true; $('hViewThumb').src = d.where || d.target; $('hViewGo').onclick = () => explore(urlId); }
    else { $('hView').hidden = true; $('hViewErr').hidden = false; $('hViewErr').textContent = 'Non trovo l’opera ' + urlId + '. Forse non è ancora stata pubblicata online.'; }
  }
}
(function () {
  const desktop = !IS_MOBILE && matchMedia('(pointer:fine)').matches;
  if (desktop && location.protocol === 'https:') { $('desk').hidden = false; QRCode.toCanvas($('qr'), location.href.split('#')[0], { width: 112, margin: 1 }, () => {}); }
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (/iPhone|iPad/.test(navigator.userAgent) && !standalone) $('hInstall').hidden = false;
})();
goHome();

window.__murale = { FS, LOCK, onImage, openAngles, estimateAspect, buildTarget, orderImg, DB, openCorners, openStudio, startView, publicData, packProject, explore, gatherWorks, S, CN, XRS, makeMask, setVideo };
