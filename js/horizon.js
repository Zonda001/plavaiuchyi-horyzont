/* Метод плаваючого горизонту: побудова й покрокова візуалізація */
'use strict';

/* =====================================================================
   1. ПОВЕРХНІ
   ===================================================================== */

// Детермінований шум значень для умовного рельєфу
function hash(i, j) {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function smooth(t) { return t * t * (3 - 2 * t); }
function valueNoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y);
  const fx = smooth(x - i), fy = smooth(y - j);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x, y) { // сума октав шуму
  let s = 0, amp = 0.5, freq = 1;
  for (let k = 0; k < 4; k++) { s += amp * valueNoise(x * freq, y * freq); amp *= 0.5; freq *= 2; }
  return s;
}

const PRESETS = {
  battlefield: {
    name: 'Умовний рельєф поля бою', R: 3,
    f: (x, y) =>
        1.00 * Math.exp(-((x + 1.3) ** 2 + (y - 1.0) ** 2) / 1.4)   // пагорб із табором
      + 0.70 * Math.exp(-((x - 1.6) ** 2 + (y + 1.2) ** 2) / 0.9)   // другий пагорб
      + 0.40 * Math.exp(-((x - 0.4) ** 2 + (y - 2.2) ** 2) / 0.6)
      - 0.55 * Math.exp(-((y + 0.3 - 0.7 * Math.sin(1.2 * x)) ** 2) / 0.18) // долина річки
      + 0.25 * fbm(x * 1.3 + 5, y * 1.3 + 5)                          // нерівності
  },
  waves:  { name: 'Хвилі: sin(x)·cos(y)', R: 3.2, f: (x, y) => Math.sin(x) * Math.cos(y) },
  sinc:   { name: 'Sinc: sin(r) / r', R: 9, f: (x, y) => { const r = Math.hypot(x, y); return r < 1e-9 ? 1 : Math.sin(r) / r; } },
  saddle: { name: 'Сідло: x² − y²', R: 2, f: (x, y) => x * x - y * y },
  hills:  { name: 'Гаусові пагорби', R: 3, f: (x, y) =>
      Math.exp(-((x - 1) ** 2 + (y - 1) ** 2))
    + 0.8 * Math.exp(-((x + 1.2) ** 2 + (y + 0.6) ** 2) / 0.7)
    - 0.6 * Math.exp(-((x + 0.5) ** 2 + (y - 1.6) ** 2) / 0.5) },
  custom: { name: 'Власна формула', R: 3, f: null }
};

// Безпечна компіляція формули користувача: лише x, y, числа та функції Math
const ALLOWED = ['x', 'y', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh',
  'exp', 'log', 'sqrt', 'abs', 'pow', 'min', 'max', 'floor', 'ceil', 'hypot', 'sign', 'PI', 'E'];
function compileFormula(src) {
  const expr = src.replace(/\^/g, '**');
  if (!/^[\w\s+\-*/().,]*$/.test(expr)) throw new Error('Недопустимі символи у формулі');
  const noNumbers = expr.replace(/\d*\.?\d+(e[+-]?\d+)?/gi, ' ');
  for (const id of noNumbers.match(/[A-Za-z_]\w*/g) || []) {
    if (!ALLOWED.includes(id)) throw new Error('Невідомий ідентифікатор: ' + id);
  }
  const mathNames = ALLOWED.filter(n => n !== 'x' && n !== 'y').join(',');
  const fn = new Function('x', 'y', `const {${mathNames}} = Math; return (${expr});`);
  const test = fn(0.3, 0.7);
  if (typeof test !== 'number') throw new Error('Вираз не повертає число');
  return fn;
}

/* =====================================================================
   2. СІТКА ЗНАЧЕНЬ ПОВЕРХНІ
   Вузли сітки: n × n комірок, кожна крива має sub відліків на комірку.
   Висоти нормуються до відрізка [−hs/2; hs/2].
   ===================================================================== */
function buildGrid(f, R, n, sub, hs) {
  const m = n * sub + 1;                  // відліків уздовж кожної осі
  const h = new Float64Array(m * m);
  let hmin = Infinity, hmax = -Infinity;
  for (let j = 0; j < m; j++) {
    const y = -R + 2 * R * j / (m - 1);
    for (let i = 0; i < m; i++) {
      const x = -R + 2 * R * i / (m - 1);
      let v = f(x, y);
      if (!Number.isFinite(v)) v = 0;
      h[j * m + i] = v;
      if (v < hmin) hmin = v;
      if (v > hmax) hmax = v;
    }
  }
  const mid = (hmin + hmax) / 2, span = (hmax - hmin) || 1;
  for (let k = 0; k < h.length; k++) h[k] = (h[k] - mid) / span * hs;
  return { m, n, sub, R, hs, h };
}

/* =====================================================================
   3. ПРОЄКЦІЯ
   Поворот на кут φ навколо вертикальної осі та нахил погляду на кут θ,
   далі ортографічна проєкція на екран.
     xr = u·cosφ − w·sinφ,   yr = u·sinφ + w·cosφ   (yr — глибина)
     X  = cx + s·xr,         V  = cy + s·(h·cosθ + yr·sinθ)
   V відлічується вгору (екранне y = висота полотна − V).
   ===================================================================== */
function project(grid, phi, theta, W, H) {
  const { m, h, hs } = grid;
  const cp = Math.cos(phi), sp = Math.sin(phi), ct = Math.cos(theta), st = Math.sin(theta);
  // Масштаб не залежить від кута φ, тому під час обертання зображення не «стрибає»:
  // |xr| ≤ √2, |h·cosθ + yr·sinθ| ≤ (hs/2)·|cosθ| + √2·|sinθ|
  const vBound = (hs / 2) * Math.abs(ct) + Math.SQRT2 * Math.abs(st);
  const s = 0.92 * Math.min(W / 2 / Math.SQRT2, H / 2 / vBound);
  const X = new Float64Array(m * m), V = new Float64Array(m * m);
  for (let j = 0; j < m; j++) {
    const w = -1 + 2 * j / (m - 1);
    for (let i = 0; i < m; i++) {
      const u = -1 + 2 * i / (m - 1);
      const k = j * m + i;
      const xr = u * cp - w * sp;
      const yr = u * sp + w * cp;
      X[k] = W / 2 + s * xr;
      V[k] = H / 2 + s * (h[k] * ct + yr * st);
    }
  }
  return { X, V };
}

/* =====================================================================
   4. МЕТОД ПЛАВАЮЧОГО ГОРИЗОНТУ
   upper[c], lower[c] — верхній і нижній горизонти для стовпця c.
   Точка видима, якщо лежить вище верхнього або нижче нижнього горизонту.
   ===================================================================== */
const EPS = 0.01;
const UP = 0, DOWN = 1, HID = 2;

function state(v, U, L) {
  if (v > U - EPS) return UP;
  if (v < L + EPS) return DOWN;
  return HID;
}

// Параметр t ∈ [0;1] точки перетину відрізка кривої (v0→v1) з горизонтом
// між стовпцями c і c+1:  v0 + (v1−v0)·t = H0 + (H1−H0)·t
function crossing(hz, c, v0, v1) {
  const H0 = hz[c], H1 = hz[c + 1];
  if (!Number.isFinite(H0)) return 0;
  if (!Number.isFinite(H1)) return 1;
  const d = (v1 - v0) - (H1 - H0);
  const t = Math.abs(d) < 1e-12 ? 0.5 : (H0 - v0) / d;
  return Math.min(1, Math.max(0, t));
}

// Значення кривої в кожному цілочисельному стовпці (лінійна інтерполяція)
function rasterize(xs, vs, W) {
  const n = xs.length;
  const c0 = Math.max(0, Math.ceil(xs[0]));
  const c1 = Math.min(W - 1, Math.floor(xs[n - 1]));
  if (c1 < c0) return null;
  const vals = new Float64Array(c1 - c0 + 1);
  let s = 0;
  for (let c = c0; c <= c1; c++) {
    while (s < n - 2 && xs[s + 1] < c) s++;
    const x0 = xs[s], x1 = xs[s + 1];
    const t = x1 > x0 ? (c - x0) / (x1 - x0) : 0;
    vals[c - c0] = vs[s] + (vs[s + 1] - vs[s]) * t;
  }
  return { c0, vals };
}

// Поділ кривої на видимі зверху, видимі знизу та невидимі ділянки
function splitPieces(c0, vals, U, L) {
  const pieces = [];
  let cur = { type: state(vals[0], U[c0], L[c0]), pts: [c0, vals[0]] };
  for (let k = 0; k < vals.length - 1; k++) {
    const c = c0 + k, v0 = vals[k], v1 = vals[k + 1];
    const s1 = state(v1, U[c + 1], L[c + 1]);
    if (s1 !== cur.type) {
      let seq;                                            // які горизонти перетинає крива
      if (cur.type === HID) seq = [[s1 === UP ? U : L, s1]];
      else if (s1 === HID) seq = [[cur.type === UP ? U : L, HID]];
      else if (cur.type === UP) seq = [[U, HID], [L, DOWN]];
      else seq = [[L, HID], [U, UP]];
      let lastT = 0;
      for (const [hz, nextType] of seq) {
        const t = Math.max(lastT, crossing(hz, c, v0, v1));
        lastT = t;
        const px = c + t, pv = v0 + (v1 - v0) * t;
        cur.pts.push(px, pv);
        pieces.push(cur);
        cur = { type: nextType, pts: [px, pv] };
      }
    }
    cur.pts.push(c + 1, v1);
  }
  pieces.push(cur);
  return pieces;
}

// Майже вертикальний відрізок (займає менше одного стовпця)
function processVertical(x1, v1, x2, v2, hz) {
  const { upper: U, lower: L, W } = hz;
  const c = Math.min(W - 1, Math.max(0, Math.round((x1 + x2) / 2)));
  const vmin = Math.min(v1, v2), vmax = Math.max(v1, v2);
  const xAt = v => (v2 !== v1 ? x1 + (x2 - x1) * (v - v1) / (v2 - v1) : x1);
  const seg = (a, b, type) => ({ type, pts: [xAt(a), a, xAt(b), b] });
  const pieces = [];
  if (!Number.isFinite(U[c])) {
    pieces.push(seg(vmin, vmax, UP));
  } else {
    if (vmin < L[c]) pieces.push(seg(vmin, Math.min(vmax, L[c]), DOWN));
    const hLo = Math.max(vmin, L[c]), hHi = Math.min(vmax, U[c]);
    if (hHi > hLo) pieces.push(seg(hLo, hHi, HID));
    if (vmax > U[c]) pieces.push(seg(Math.max(vmin, U[c]), vmax, UP));
  }
  U[c] = Math.max(U[c], vmax);
  L[c] = Math.min(L[c], vmin);
  return pieces;
}

// Обробка ламаної: класифікація відносно горизонтів, потім їх оновлення
function processPath(xs, vs, hz) {
  if (xs[0] > xs[xs.length - 1]) { xs = xs.slice().reverse(); vs = vs.slice().reverse(); }
  const last = xs.length - 1;
  // крутий відрізок, що займає менше двох стовпців, обробляється як вертикальний
  if (xs[last] - xs[0] < 2) return processVertical(xs[0], vs[0], xs[last], vs[last], hz);
  const r = rasterize(xs, vs, hz.W);
  if (!r) return [];
  const pieces = splitPieces(r.c0, r.vals, hz.upper, hz.lower);
  // дробові кінці між точним початком (кінцем) кривої і найближчим стовпцем
  if (xs[0] >= 0) pieces[0].pts.unshift(xs[0], vs[0]);
  if (xs[last] <= hz.W - 1) pieces[pieces.length - 1].pts.push(xs[last], vs[last]);
  for (let k = 0; k < r.vals.length; k++) {
    const c = r.c0 + k, v = r.vals[k];
    if (v > hz.upper[c]) hz.upper[c] = v;
    if (v < hz.lower[c]) hz.lower[c] = v;
  }
  return pieces;
}

function pieceLength(p) {
  let len = 0;
  for (let k = 2; k < p.pts.length; k += 2) len += Math.hypot(p.pts[k] - p.pts[k - 2], p.pts[k + 1] - p.pts[k - 1]);
  return len;
}

/* Побудова всіх кроків алгоритму.
   Сім'я кривих обирається так, щоб екранна координата X уздовж кривої
   змінювалась монотонно. Криві обробляються від найближчої до найдальшої.
   На кожному кроці спочатку обробляються відрізки між попередньою і
   поточною кривою (бокові ребра або лінії другого напрямку), потім сама крива. */
function buildSteps(grid, proj, phi, W, both) {
  const { m, n, sub, R } = grid;
  const { X, V } = proj;
  const useRows = Math.abs(Math.cos(phi)) >= Math.abs(Math.sin(phi));
  const lines = [];
  for (let k = 0; k <= n; k++) {
    const line = k * sub;                               // індекс вузлової лінії
    const coord = -1 + 2 * line / (m - 1);
    const depth = useRows ? coord * Math.cos(phi) : coord * Math.sin(phi);
    lines.push({ line, coord, depth });
  }
  lines.sort((a, b) => a.depth - b.depth);              // від спостерігача вглиб

  const idx = (t, line) => (useRows ? line * m + t : t * m + line);
  const hz = { W, upper: new Float64Array(W).fill(-Infinity), lower: new Float64Array(W).fill(Infinity) };
  const steps = [];
  const total = [0, 0, 0];

  for (let k = 0; k < lines.length; k++) {
    const { line, coord } = lines[k];
    const pieces = [];

    // 1) відрізки між попередньою і поточною кривою
    if (k > 0) {
      const prev = lines[k - 1].line;
      for (let t = 0; t < m; t += sub) {
        if (!both && t !== 0 && t !== m - 1) continue;    // лише бокові ребра
        const a = idx(t, prev), b = idx(t, line);
        for (const p of processPath([X[a], X[b]], [V[a], V[b]], hz)) { p.cross = true; pieces.push(p); }
      }
    }

    // 2) поточна крива
    const xs = new Float64Array(m), vs = new Float64Array(m);
    for (let t = 0; t < m; t++) { const q = idx(t, line); xs[t] = X[q]; vs[t] = V[q]; }
    for (const p of processPath(Array.from(xs), Array.from(vs), hz)) { p.cross = false; pieces.push(p); }

    const len = [0, 0, 0];
    for (const p of pieces) { const l = pieceLength(p); len[p.type] += l; total[p.type] += l; }
    steps.push({
      label: (useRows ? 'y = ' : 'x = ') + (coord * R).toFixed(2),
      pieces, len,
      upper: Float32Array.from(hz.upper),
      lower: Float32Array.from(hz.lower)
    });
  }
  return { steps, total, useRows };
}

/* =====================================================================
   5. ІНТЕРФЕЙС І МАЛЮВАННЯ
   ===================================================================== */
const $ = id => document.getElementById(id);
const cv = $('cv');
// Режим True Color: 24 біти на піксель (R, G, B по 8 розрядів), без альфа-каналу
const ctx = cv.getContext('2d', { alpha: false });
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const COL = {};
['--top', '--bottom', '--accent', '--hor-up', '--hor-low', '--hidden'].forEach(k => { COL[k] = css(k); });

const BG = '#fffdf7';   // колір тла полотна
const ui = { W: 800, H: 600, grid: null, gridKey: '', result: null, cur: Infinity, playing: false, lastTick: 0, customFn: null, buildMs: 0 };

for (const [key, p] of Object.entries(PRESETS)) {
  const o = document.createElement('option');
  o.value = key; o.textContent = p.name; $('preset').appendChild(o);
}

function params() {
  return {
    preset: $('preset').value,
    phi: +$('az').value * Math.PI / 180,
    theta: +$('el').value * Math.PI / 180,
    hs: +$('hs').value,
    n: +$('n').value,
    sub: +$('sub').value,
    both: $('both').checked
  };
}

function currentFunction(p) {
  if (p.preset !== 'custom') return PRESETS[p.preset].f;
  try {
    ui.customFn = compileFormula($('formula').value);
    $('formulaErr').textContent = '';
  } catch (e) {
    $('formulaErr').textContent = e.message;
  }
  return ui.customFn || ((x, y) => 0);
}

function rebuild(keepStep) {
  const p = params();
  $('azOut').textContent = $('az').value + '°';
  $('elOut').textContent = $('el').value + '°';
  $('hsOut').textContent = (+$('hs').value).toFixed(2);
  $('nOut').textContent = p.n + 1;
  $('subOut').textContent = p.sub;
  $('formulaRow').style.display = p.preset === 'custom' ? 'block' : 'none';

  const t0 = performance.now();
  const key = [p.preset, p.n, p.sub, p.hs, p.preset === 'custom' ? $('formula').value : ''].join('|');
  if (key !== ui.gridKey) {
    ui.grid = buildGrid(currentFunction(p), PRESETS[p.preset].R, p.n, p.sub, p.hs);
    ui.gridKey = key;
  }
  const proj = project(ui.grid, p.phi, p.theta, ui.W, ui.H);
  ui.result = buildSteps(ui.grid, proj, p.phi, ui.W, p.both);
  ui.buildMs = performance.now() - t0;

  const last = ui.result.steps.length - 1;
  ui.cur = keepStep ? Math.min(ui.cur, last) : last;
  draw();
}

function strokePieces(list, color, width, dash) {
  if (!list.length) return;
  ctx.beginPath();
  for (const p of list) {
    ctx.moveTo(p.pts[0], ui.H - p.pts[1]);
    for (let k = 2; k < p.pts.length; k += 2) ctx.lineTo(p.pts[k], ui.H - p.pts[k + 1]);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash || []);
  ctx.stroke();
  ctx.setLineDash([]);
}

function strokeHorizon(arr, color) {
  ctx.beginPath();
  let open = false;
  for (let c = 0; c < arr.length; c++) {
    const v = arr[c];
    if (!Number.isFinite(v)) { open = false; continue; }
    if (open) ctx.lineTo(c, ui.H - v); else { ctx.moveTo(c, ui.H - v); open = true; }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function draw() {
  const { steps, total } = ui.result;
  const cur = ui.cur;
  const isLast = cur === steps.length - 1;
  ctx.fillStyle = BG; ctx.fillRect(0, 0, ui.W, ui.H);

  const showHidden = $('showHidden').checked;
  const up = [], down = [], hid = [];
  for (let k = 0; k < cur; k++) {
    for (const p of steps[k].pieces) (p.type === UP ? up : p.type === DOWN ? down : hid).push(p);
  }
  const curStep = steps[cur];
  if (isLast) {
    for (const p of curStep.pieces) (p.type === UP ? up : p.type === DOWN ? down : hid).push(p);
  }
  if (showHidden) strokePieces(hid, COL['--hidden'], 0.8, [3, 3]);
  strokePieces(down, COL['--bottom'], 1.1);
  strokePieces(up, COL['--top'], 1.1);

  // горизонти до обробки поточної кривої — саме з ними вона порівнюється
  if ($('showHor').checked && !isLast && cur > 0) {
    strokeHorizon(steps[cur - 1].upper, COL['--hor-up']);
    strokeHorizon(steps[cur - 1].lower, COL['--hor-low']);
  }
  if (!isLast) {   // поточний крок виділяється
    strokePieces(curStep.pieces.filter(p => p.type === HID), COL['--hidden'], 1.6, [4, 3]);
    strokePieces(curStep.pieces.filter(p => p.type !== HID), COL['--accent'], 2.6);
  }

  $('stepLbl').textContent = `Крок ${cur + 1} / ${steps.length}`;
  $('bPlay').textContent = ui.playing ? '⏸' : '▶';

  const L = curStep.len, sum = L[0] + L[1] + L[2] || 1;
  const pct = v => (100 * v / sum).toFixed(0) + '%';
  $('info').innerHTML = isLast && !ui.playing
    ? 'Готове зображення. Натисніть ⏮ і ▶, щоб переглянути роботу алгоритму крок за кроком, або перетягуйте мишею для повороту поверхні.'
    : `<b>Крок ${cur + 1}:</b> крива ${curStep.label} разом із відрізками до попередньої кривої `
      + `порівнюється з горизонтами, накопиченими на попередніх кроках (пунктир). `
      + `Видимо зверху ${pct(L[0])}, знизу ${pct(L[1])}, приховано ${pct(L[2])}.`;

  const T = total[0] + total[1] + total[2] || 1;
  $('stats').innerHTML =
      `Кривих: ${steps.length} (сім'я ${ui.result.useRows ? 'y = const' : 'x = const'})<br>`
    + `Ширина горизонтів: ${ui.W} стовпців<br>`
    + `Видимо зверху: ${(100 * total[0] / T).toFixed(1)}%<br>`
    + `Видимо знизу: ${(100 * total[1] / T).toFixed(1)}%<br>`
    + `Приховано: ${(100 * total[2] / T).toFixed(1)}%<br>`
    + `Час побудови: ${ui.buildMs.toFixed(1)} мс`;
}

/* ---------- Відтворення ---------- */
function tick(time) {
  if (!ui.playing) return;
  const interval = 1000 / +$('speed').value;
  if (time - ui.lastTick >= interval) {
    ui.lastTick = time;
    if (ui.cur < ui.result.steps.length - 1) { ui.cur++; draw(); }
    else { ui.playing = false; draw(); return; }
  }
  requestAnimationFrame(tick);
}
function play() {
  if (ui.cur >= ui.result.steps.length - 1) ui.cur = 0;
  ui.playing = true; ui.lastTick = 0; draw();
  requestAnimationFrame(tick);
}
function stop() { ui.playing = false; draw(); }

$('bPlay').onclick = () => (ui.playing ? stop() : play());
$('bFirst').onclick = () => { ui.playing = false; ui.cur = 0; draw(); };
$('bLast').onclick = () => { ui.playing = false; ui.cur = ui.result.steps.length - 1; draw(); };
$('bPrev').onclick = () => { ui.playing = false; ui.cur = Math.max(0, ui.cur - 1); draw(); };
$('bNext').onclick = () => { ui.playing = false; ui.cur = Math.min(ui.result.steps.length - 1, ui.cur + 1); draw(); };

['preset', 'az', 'el', 'hs', 'n', 'sub', 'both'].forEach(id => $(id).addEventListener('input', () => { ui.playing = false; rebuild(false); }));
$('formula').addEventListener('change', () => { ui.playing = false; rebuild(false); });
['showHidden', 'showHor'].forEach(id => $(id).addEventListener('input', draw));

/* ---------- Поворот мишею ---------- */
let drag = null, pendingFrame = false;
cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, az: +$('az').value, el: +$('el').value }; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', e => {
  if (!drag) return;
  const az = ((Math.round(drag.az + (e.clientX - drag.x) * 0.5) % 360) + 360) % 360;
  const el = Math.max(-60, Math.min(80, Math.round(drag.el + (e.clientY - drag.y) * 0.4)));
  $('az').value = az; $('el').value = el;
  if (!pendingFrame) {
    pendingFrame = true;
    requestAnimationFrame(() => { pendingFrame = false; ui.playing = false; rebuild(false); });
  }
});
cv.addEventListener('pointerup', () => { drag = null; });

/* ---------- Експорт у SVG ----------
   Видимі ділянки всіх кривих записуються як ламані, тож результат
   методу плаваючого горизонту зберігається як векторне зображення. */
// Спрощення ламаної алгоритмом Рамера–Дугласа–Пекера (допуск eps пікселів)
function simplify(pts, eps) {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[2 * a], ay = pts[2 * a + 1], bx = pts[2 * b], by = pts[2 * b + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let best = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[2 * i + 1]) - (ax - pts[2 * i]) * (by - ay)) / len;
      if (d > best) { best = d; idx = i; }
    }
    if (best > eps) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

function buildSVG() {
  const { steps } = ui.result;
  const showHidden = $('showHidden').checked;
  const groups = { 0: [], 1: [], 2: [] };
  for (let k = 0; k <= ui.cur; k++) {
    for (const p of steps[k].pieces) {
      if (p.type === HID && !showHidden) continue;
      const sp = simplify(p.pts, 0.4), pts = [];
      for (let i = 0; i < sp.length; i += 2) pts.push(sp[i].toFixed(1) + ',' + (ui.H - sp[i + 1]).toFixed(1));
      groups[p.type].push('<polyline points="' + pts.join(' ') + '"/>');
    }
  }
  const g = (items, color, extra) => items.length
    ? `<g fill="none" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"${extra || ''}>${items.join('')}</g>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ui.W}" height="${ui.H}" viewBox="0 0 ${ui.W} ${ui.H}">`
    + g(groups[2], COL['--hidden'], ' stroke-dasharray="3 3"') + g(groups[1], COL['--bottom']) + g(groups[0], COL['--top'])
    + '</svg>';
}
window.buildSVG = buildSVG;
$('bSvg').onclick = () => {
  const blob = new Blob([buildSVG()], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'horizon.svg';
  a.click();
  URL.revokeObjectURL(a.href);
};

/* ---------- Розмір екрана ---------- */
// Полотно має фіксований розмір 800×600 пікселів і не залежить від розміру вікна
const SCREEN_W = 800, SCREEN_H = 600;
function setupScreen() {
  cv.width = SCREEN_W; cv.height = SCREEN_H;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ui.W = SCREEN_W; ui.H = SCREEN_H;
  rebuild(true);
}
setupScreen();
