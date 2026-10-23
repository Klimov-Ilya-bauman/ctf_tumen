const N = 19;
const CELL = 40, MARGIN = 20, SIZE = 760;
const SVGNS = 'http://www.w3.org/2000/svg';
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function group(M, r, c) {
  const color = M[r * N + c];
  const seen = new Set([r * N + c]);
  const libs = new Set();
  const stones = [];
  const queue = [[r, c]];
  while (queue.length) {
    const [y, x] = queue.pop();
    stones.push([y, x]);
    for (const [dy, dx] of DIRS) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || ny >= N || nx < 0 || nx >= N) continue;
      const i = ny * N + nx;
      if (M[i] === 0) libs.add(i);
      else if (M[i] === color && !seen.has(i)) { seen.add(i); queue.push([ny, nx]); }
    }
  }
  return { stones, liberties: libs.size };
}

function inspect(M, r, c, color) {
  const T = Uint8Array.from(M);
  T[r * N + c] = color;
  const opp = 3 - color;
  const captures = [];
  const done = new Set();
  for (const [dy, dx] of DIRS) {
    const ny = r + dy, nx = c + dx;
    if (ny < 0 || ny >= N || nx < 0 || nx >= N) continue;
    if (T[ny * N + nx] !== opp || done.has(ny * N + nx)) continue;
    const g = group(T, ny, nx);
    g.stones.forEach(([y, x]) => done.add(y * N + x));
    if (g.liberties === 0) captures.push(...g.stones);
  }
  captures.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { T, captures };
}

export function legalMove(M, r, c, color) {
  if (r < 0 || r >= N || c < 0 || c >= N || M[r * N + c] !== 0) return { ok: false, captures: [] };
  const { T, captures } = inspect(M, r, c, color);
  for (const [y, x] of captures) T[y * N + x] = 0;
  if (captures.length === 0 && group(T, r, c).liberties === 0) return { ok: false, captures: [] };
  return { ok: true, captures };
}

export function applyMove(M, r, c, color) {
  const res = legalMove(M, r, c, color);
  if (!res.ok) throw new Error('illegal move');
  const M2 = Uint8Array.from(M);
  M2[r * N + c] = color;
  for (const [y, x] of res.captures) M2[y * N + x] = 0;
  return { M2, placed: [r, c], removed: res.captures };
}

function el(doc, name, attrs) {
  const e = doc.createElementNS(SVGNS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

export function renderBoard(svgEl, M, onPointClick) {
  const doc = svgEl.ownerDocument;
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  svgEl.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  const end = MARGIN + (N - 1) * CELL;
  for (let i = 0; i < N; i++) {
    const p = MARGIN + i * CELL;
    svgEl.appendChild(el(doc, 'line', { x1: MARGIN, y1: p, x2: end, y2: p, stroke: '#333', 'stroke-width': 1 }));
    svgEl.appendChild(el(doc, 'line', { x1: p, y1: MARGIN, x2: p, y2: end, stroke: '#333', 'stroke-width': 1 }));
  }
  for (const r of [3, 9, 15]) for (const c of [3, 9, 15]) {
    svgEl.appendChild(el(doc, 'circle', { class: 'hoshi', cx: MARGIN + c * CELL, cy: MARGIN + r * CELL, r: 4, fill: '#333' }));
  }
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const v = M[r * N + c];
    if (v !== 1 && v !== 2) continue;
    svgEl.appendChild(el(doc, 'circle', {
      class: 'stone', 'data-color': v, 'data-r': r, 'data-c': c,
      cx: MARGIN + c * CELL, cy: MARGIN + r * CELL, r: 18,
      fill: v === 1 ? '#111' : '#f4f4f4', stroke: '#111', 'stroke-width': 1,
    }));
  }
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const pt = el(doc, 'rect', {
      class: 'pt', 'data-r': r, 'data-c': c,
      x: MARGIN + c * CELL - CELL / 2, y: MARGIN + r * CELL - CELL / 2,
      width: CELL, height: CELL, fill: 'transparent',
    });
    if (onPointClick) pt.addEventListener('click', () => onPointClick(r, c));
    svgEl.appendChild(pt);
  }
}
