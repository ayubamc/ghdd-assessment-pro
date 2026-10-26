// figure-engine.js
// Mabda'a 4 + 5: abuur sawirka saxda ah ee su'aasha, kuna hubi inuu muuqdo, calaamaduhu sax yihiin, jawaabtu jirto,
// sawirkuna aanu jawaabta si toos ah u muujin.
//
// Fikradda: AI-gu ma sawirro SVG gacan ah. AI-gu wuxuu bixiyaa SPEC (tirooyin iyo magacyo), koodhkuna wuxuu sawiray.
// Sidaas sawirka iyo jawaabta waa isku xisaab (facts), lamana khaldami karo.

const W = 640, H = 360;
const FONT = 'Arial, Helvetica, sans-serif';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r2 = (n) => Math.round(n * 100) / 100;
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ---------- SVG primitives --------------------------------------------------------------------------------------
function svgWrap(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="auto"><rect width="${W}" height="${H}" fill="#ffffff"/>${body}</svg>`;
}
// role: tick (hirka dhululubada) | id (xarfaha A,B,K..) | data (xog la siiyey) | annot (qoraal sharaxaad - waa la hubiyaa leak)
function T(x, y, s, { size = 16, anchor = 'middle', role = 'data', weight = '' } = {}) {
  const halo = role === 'tick' ? ' stroke="#fff" stroke-width="4" paint-order="stroke"' : '';
  return `<text x="${r2(x)}" y="${r2(y)}" font-family="${FONT}" font-size="${size}" text-anchor="${anchor}" fill="#000" data-role="${role}"${halo}${weight ? ` font-weight="${weight}"` : ''}>${esc(s)}</text>`;
}
const L = (x1, y1, x2, y2, { w = 1.6, dash = '' } = {}) => `<line x1="${r2(x1)}" y1="${r2(y1)}" x2="${r2(x2)}" y2="${r2(y2)}" stroke="#000" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const R = (x, y, w, h, { fill = 'none', sw = 1.6, rx = 0 } = {}) => `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="${fill}" stroke="#000" stroke-width="${sw}"${rx ? ` rx="${rx}"` : ''}/>`;
const C = (cx, cy, r, { fill = 'none', sw = 1.6 } = {}) => `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" fill="${fill}" stroke="#000" stroke-width="${sw}"/>`;
const PL = (pts, { fill = 'none', sw = 1.8 } = {}) => `<polyline points="${pts.map((p) => `${r2(p[0])},${r2(p[1])}`).join(' ')}" fill="${fill}" stroke="#000" stroke-width="${sw}" stroke-linejoin="round"/>`;
const PG = (pts, { fill = '#000', sw = 1.2 } = {}) => `<polygon points="${pts.map((p) => `${r2(p[0])},${r2(p[1])}`).join(' ')}" fill="${fill}" stroke="#000" stroke-width="${sw}"/>`;
const PATH = (d, { fill = 'none', sw = 1.8 } = {}) => `<path d="${d}" fill="${fill}" stroke="#000" stroke-width="${sw}" stroke-linejoin="round"/>`;
function arrowHead(x, y, dx, dy, size = 9) {
  const a = Math.atan2(dy, dx), s = size;
  return PG([[x, y], [x - s * Math.cos(a - 0.4), y - s * Math.sin(a - 0.4)], [x - s * Math.cos(a + 0.4), y - s * Math.sin(a + 0.4)]]);
}
const arrow = (x1, y1, x2, y2, o) => L(x1, y1, x2, y2, o) + arrowHead(x2, y2, x2 - x1, y2 - y1);

function niceStep(max, target = 5) {
  const raw = max / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
const fmtNum = (n) => (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : String(r2(n)));

function axes({ x0, y0, x1, y1, xLabel = '', yLabel = '', xTop = null }) {
  let s = arrow(x0, y0, x1, y0) + arrow(x0, y0, x0, y1);
  if (xLabel) s += T(x1 - 4, y0 + 36, xLabel, { size: 14, anchor: 'end', role: 'data' });
  if (yLabel) s += T(x0 + 8, y1 - 8, yLabel, { size: 14, anchor: 'start', role: 'data' });
  return s;
}

// ---------- Renderers -------------------------------------------------------------------------------------------
// Mid kasta wuxuu soo celiyaa { svg, facts } ama tuuraa Error haddii spec-ku khaldan yahay.
export const RENDERERS = {};

RENDERERS.vt_graph = (spec) => {
  const pts = (spec.points || []).map((p) => [num(p[0]), num(p[1])]);
  if (pts.length < 3) throw new Error('vt_graph: u baahan yahay ugu yaraan 3 dhibcood');
  for (let i = 1; i < pts.length; i++) if (pts[i][0] <= pts[i - 1][0]) throw new Error('vt_graph: waqtiga waa inuu kordhaa');
  const ids = spec.ids && spec.ids.length === pts.length ? spec.ids : pts.map((_, i) => (i === 0 ? 'O' : String.fromCharCode(74 + i))); // O,K,L,M..
  const tMax = pts[pts.length - 1][0], vMax = Math.max(...pts.map((p) => p[1]));
  const tStep = niceStep(tMax, 6), vStep = niceStep(vMax, 5);
  const tEnd = Math.ceil(tMax / tStep) * tStep, vEnd = Math.ceil(vMax / vStep) * vStep + vStep * 0.5;
  const x0 = 80, y0 = 290, xr = 570, yt = 50;
  const sx = (t) => x0 + (t / tEnd) * (xr - x0), sy = (v) => y0 - (v / vEnd) * (y0 - yt);
  let s = axes({ x0, y0, x1: xr + 30, y1: yt - 12, xLabel: spec.xLabel || 'Time/s', yLabel: spec.yLabel || 'Velocity/m s⁻¹' });
  for (let t = tStep; t <= tEnd + 1e-9; t += tStep) s += L(sx(t), y0, sx(t), y0 + 6, { w: 1 }) + T(sx(t), y0 + 22, fmtNum(t), { size: 14, role: 'tick' });
  for (let v = vStep; v <= vEnd - vStep * 0.4; v += vStep) s += L(x0, sy(v), x0 - 6, sy(v), { w: 1 }) + T(x0 - 10, sy(v) + 5, fmtNum(v), { size: 14, anchor: 'end', role: 'tick' });
  s += PL(pts.map((p) => [sx(p[0]), sy(p[1])]));
  pts.forEach((p, i) => {
    if (i > 0 && p[1] > 0) s += L(sx(p[0]), sy(p[1]), sx(p[0]), y0, { w: 1, dash: '5,4' });
    const up = i === 0 || p[1] >= (pts[i - 1] ? pts[i - 1][1] : 0) || p[1] === 0;
    s += C(sx(p[0]), sy(p[1]), 3, { fill: '#000' }) + T(sx(p[0]) + (i === 0 ? -14 : 0), sy(p[1]) + (i === 0 ? 18 : up ? -10 : 20), ids[i], { size: 15, role: 'id' });
  });
  // Facts
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i][0] - pts[i - 1][0], dv = pts[i][1] - pts[i - 1][1];
    segs.push({ from: ids[i - 1], to: ids[i], accel: r2(dv / dt), type: dv === 0 ? 'constant' : dv > 0 ? 'accelerating' : 'decelerating', v: pts[i][1] });
  }
  const constant = segs.filter((g) => g.type === 'constant' && g.v > 0);
  const facts = { segments: segs, constant_intervals: constant.map((g) => ({ from: g.from, to: g.to })), max_value: vMax, acceleration: segs.find((g) => g.type === 'accelerating') ? segs.find((g) => g.type === 'accelerating').accel : null };
  return { svg: svgWrap(s), facts };
};

RENDERERS.wave = (spec) => {
  const A = num(spec.amplitude), P = num(spec.period), cycles = Math.max(1, Math.min(3, Math.round(num(spec.cycles, 2))));
  if (!(A > 0) || !(P > 0)) throw new Error('wave: amplitude iyo period waa inay togan yihiin');
  const tUnit = spec.tUnit || 'ms', yUnit = spec.unit || 'cm';
  const x0 = 90, xr = 560, yc = 190, amp = 105;
  const total = cycles * P, sx = (t) => x0 + (t / total) * (xr - x0), sy = (v) => yc - (v / A) * amp;
  let s = arrow(x0, yc, xr + 40, yc) + arrow(x0, yc + amp + 30, x0, yc - amp - 34);
  s += T(xr + 40, yc - 10, `t/${tUnit}`, { size: 14, anchor: 'end', role: 'data' });
  s += T(x0 + 10, yc - amp - 38, yUnit === '' ? 'y' : `y/${yUnit}`, { size: 14, anchor: 'start', role: 'data' });
  let d = '';
  for (let i = 0; i <= 160; i++) { const t = (i / 160) * total; d += (i ? ' L' : 'M') + r2(sx(t)) + ' ' + r2(sy(A * Math.sin((2 * Math.PI * t) / P))); }
  s += PATH(d, { sw: 2 });
  for (let k = 1; k <= cycles * 2; k++) { const t = (k * P) / 2; s += L(sx(t), yc, sx(t), yc + 6, { w: 1 }) + T(sx(t), yc + 22, fmtNum(t), { size: 14, role: 'tick' }); }
  s += L(x0, sy(A), x0 - 6, sy(A), { w: 1 }) + T(x0 - 10, sy(A) + 5, fmtNum(A), { size: 14, anchor: 'end', role: 'tick' });
  s += L(x0, sy(-A), x0 - 6, sy(-A), { w: 1 }) + T(x0 - 10, sy(-A) + 5, '-' + fmtNum(A), { size: 14, anchor: 'end', role: 'tick' });
  s += T(x0 - 10, yc + 5, '0', { size: 14, anchor: 'end', role: 'tick' });
  const freqHz = tUnit === 'ms' ? 1000 / P : tUnit === 's' ? 1 / P : null;
  return { svg: svgWrap(s), facts: { amplitude: A, period: P, frequency: freqHz === null ? null : r2(freqHz), wavelength: null } };
};

RENDERERS.forces = (spec) => {
  const left = (spec.left || []).map((n) => num(n)).filter((n) => n > 0), right = (spec.right || []).map((n) => num(n)).filter((n) => n > 0);
  if (!left.length && !right.length) throw new Error('forces: u baahan yahay ugu yaraan hal xoog');
  const unit = spec.unit || 'N';
  const cx = 320, cy = 190, bw = 90, bh = 60, scale = 230 / Math.max(...left, ...right, 1);
  let s = R(cx - bw / 2, cy - bh / 2, bw, bh, { fill: '#e8eef7' }) + T(cx, cy + 6, spec.objectLabel || '', { size: 16, role: 'id' });
  const draw = (arr, dir) => arr.forEach((f, i) => {
    const y = cy + (arr.length === 1 ? 0 : (i - (arr.length - 1) / 2) * 44), len = Math.max(50, f * scale), xs = cx + dir * (bw / 2), xe = xs + dir * len;
    s += arrow(xs, y, xe, y, { w: 2.2 }) + T((xs + xe) / 2, y - 12, `${fmtNum(f)} ${unit}`, { size: 16, role: 'data' });
  });
  draw(left, -1); draw(right, 1);
  const res = right.reduce((a, b) => a + b, 0) - left.reduce((a, b) => a + b, 0);
  return { svg: svgWrap(s), facts: { resultant: Math.abs(res), direction: res === 0 ? 'balanced' : res > 0 ? 'right' : 'left', unit } };
};

RENDERERS.right_triangle = (spec) => {
  const a = num(spec.a), b = num(spec.b), unit = spec.unit || 'cm';
  if (!(a > 0) || !(b > 0)) throw new Error('right_triangle: a iyo b waa inay togan yihiin');
  const names = spec.names && spec.names.length === 3 ? spec.names : ['A', 'B', 'C'];
  const sc = Math.min(300 / a, 190 / b), w = a * sc, h = b * sc, bx = 170, by = 300;
  const B = [bx, by], Cc = [bx + w, by], Aa = [bx, by - h];
  let s = PG([Aa, B, Cc], { fill: '#f4f1e8' }).replace('fill="#f4f1e8" stroke="#000"', 'fill="#f4f1e8" stroke="#000"');
  s += R(bx, by - 16, 16, 16, { sw: 1.2 });
  s += T(Aa[0] - 16, Aa[1] + 4, names[0], { size: 17, role: 'id' }) + T(B[0] - 16, B[1] + 6, names[1], { size: 17, role: 'id' }) + T(Cc[0] + 18, Cc[1] + 6, names[2], { size: 17, role: 'id' });
  s += T(bx + w / 2, by + 28, `${fmtNum(a)} ${unit}`, { size: 16, role: 'data' });
  s += T(bx - 58, by - h / 2, `${fmtNum(b)} ${unit}`, { size: 16, role: 'data' });
  const hyp = Math.sqrt(a * a + b * b);
  return { svg: svgWrap(s), facts: { hypotenuse: r2(hyp), area: r2((a * b) / 2), perimeter: r2(a + b + hyp), unit } };
};

function chartFrame(spec, values) {
  const x0 = 90, y0 = 290, xr = 580, yt = 55;
  const vMax = Math.max(...values), step = niceStep(vMax, 5), top = Math.ceil(vMax / step) * step;
  const sy = (v) => y0 - (v / top) * (y0 - yt);
  let s = axes({ x0, y0, x1: xr + 20, y1: yt - 14, xLabel: spec.xLabel || '', yLabel: spec.yLabel || spec.unit || '' });
  for (let v = 0; v <= top + 1e-9; v += step) s += L(x0, sy(v), x0 - 6, sy(v), { w: 1 }) + T(x0 - 10, sy(v) + 5, fmtNum(v), { size: 14, anchor: 'end', role: 'tick' }) + (v > 0 ? L(x0, sy(v), xr, sy(v), { w: 0.5, dash: '2,4' }) : '');
  if (spec.title) s += T(W / 2, 28, spec.title, { size: 17, role: 'data', weight: 'bold' });
  return { s, x0, y0, xr, sy };
}
function seriesFacts(labels, values, unit) {
  const total = values.reduce((a, b) => a + b, 0), mx = Math.max(...values), mn = Math.min(...values);
  if (values.filter((v) => v === mx).length > 1) throw new Error('chart: qiimaha ugu weyn waa inuu keliya noqdaa');
  if (values.filter((v) => v === mn).length > 1) throw new Error('chart: qiimaha ugu yar waa inuu keliya noqdaa');
  const sorted = [...values].sort((a, b) => b - a);
  return { max_label: labels[values.indexOf(mx)], min_label: labels[values.indexOf(mn)], max_value: mx, min_value: mn, total: r2(total), difference: r2(sorted[0] - sorted[1]), values: Object.fromEntries(labels.map((l, i) => [l, values[i]])), unit };
}
function readSeries(spec) {
  const labels = (spec.labels || []).map(String), values = (spec.values || []).map((v) => num(v, NaN));
  if (labels.length < 3 || labels.length > 8 || labels.length !== values.length || values.some((v) => !(v >= 0))) throw new Error('chart: 3-8 summad iyo qiimayaal togan ayaa loo baahan yahay');
  return { labels, values };
}
RENDERERS.bar_chart = (spec) => {
  const { labels, values } = readSeries(spec);
  const f = chartFrame(spec, values), n = labels.length, slot = (f.xr - f.x0 - 20) / n, bw = Math.min(54, slot * 0.6);
  let s = f.s;
  labels.forEach((lab, i) => { const cx = f.x0 + 20 + slot * (i + 0.5); s += R(cx - bw / 2, f.sy(values[i]), bw, f.y0 - f.sy(values[i]), { fill: '#dfe9f5' }) + T(cx, f.y0 + 22, lab, { size: 14, role: 'id' }); });
  return { svg: svgWrap(s), facts: seriesFacts(labels, values, spec.unit || '') };
};
RENDERERS.line_chart = (spec) => {
  const { labels, values } = readSeries(spec);
  const f = chartFrame(spec, values), n = labels.length, slot = (f.xr - f.x0 - 20) / n;
  const pts = labels.map((_, i) => [f.x0 + 20 + slot * (i + 0.5), f.sy(values[i])]);
  let s = f.s + PL(pts, { sw: 2 });
  pts.forEach((p, i) => { s += C(p[0], p[1], 3.5, { fill: '#000' }) + T(p[0], f.y0 + 22, labels[i], { size: 14, role: 'id' }); });
  return { svg: svgWrap(s), facts: seriesFacts(labels, values, spec.unit || '') };
};
RENDERERS.pie_chart = (spec) => {
  const { labels, values } = readSeries(spec);
  const total = values.reduce((a, b) => a + b, 0), cx = 320, cy = 190, rad = 110;
  let ang = -Math.PI / 2, s = '';
  labels.forEach((lab, i) => {
    const a2 = ang + (values[i] / total) * 2 * Math.PI, large = a2 - ang > Math.PI ? 1 : 0;
    const p1 = [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)], p2 = [cx + rad * Math.cos(a2), cy + rad * Math.sin(a2)];
    const shade = ['#dfe9f5', '#fde9c8', '#f4d6d6', '#e3f1dc', '#ece4f4', '#f6f0c8', '#dcecec', '#f0e0d6'][i % 8];
    s += PATH(`M${r2(cx)} ${r2(cy)} L${r2(p1[0])} ${r2(p1[1])} A${rad} ${rad} 0 ${large} 1 ${r2(p2[0])} ${r2(p2[1])} Z`, { fill: shade, sw: 1.4 });
    const mid = (ang + a2) / 2, lx = cx + (rad + 30) * Math.cos(mid), ly = cy + (rad + 30) * Math.sin(mid) + 5;
    s += T(lx, ly, `${lab} (${fmtNum(r2((values[i] / total) * 100))}%)`, { size: 14, anchor: Math.cos(mid) >= 0 ? 'start' : 'end', role: 'data' });
    ang = a2;
  });
  const f = seriesFacts(labels, values, '%');
  return { svg: svgWrap(s), facts: { ...f, largest_share: f.max_label, smallest_share: f.min_label } };
};

RENDERERS.data_table = (spec) => {
  const headers = (spec.headers || []).map(String), rows = (spec.rows || []).map((r) => r.map(String));
  if (headers.length < 2 || headers.length > 6 || rows.length < 2 || rows.length > 9 || rows.some((r) => r.length !== headers.length)) throw new Error('data_table: 2-6 tiir iyo 2-9 safaf oo isku mid ah ayaa loo baahan yahay');
  const left = 60, top = 50, tw = 520, rh = Math.min(34, 250 / (rows.length + 1)), cw = tw / headers.length;
  let s = spec.title ? T(W / 2, 30, spec.title, { size: 17, role: 'data', weight: 'bold' }) : '';
  s += R(left, top, tw, rh * (rows.length + 1), { sw: 1.6 }) + R(left, top, tw, rh, { fill: '#eeeeee', sw: 1.6 });
  headers.forEach((h, i) => { s += T(left + cw * (i + 0.5), top + rh * 0.68, h, { size: 15, role: 'data', weight: 'bold' }); if (i) s += L(left + cw * i, top, left + cw * i, top + rh * (rows.length + 1), { w: 1 }); });
  rows.forEach((r, ri) => { s += L(left, top + rh * (ri + 1), left + tw, top + rh * (ri + 1), { w: 1 }); r.forEach((c, ci) => { s += T(left + cw * (ci + 0.5), top + rh * (ri + 1.68), c === '?' ? '' : c, { size: 15, role: c === '?' ? 'id' : 'data' }); }); });
  const totals = {};
  headers.forEach((h, ci) => { const col = rows.map((r) => Number(String(r[ci]).replace(/[, ]/g, ''))); if (col.every(Number.isFinite)) totals[h] = r2(col.reduce((a, b) => a + b, 0)); });
  const cells = {}; rows.forEach((r) => { cells[r[0]] = Object.fromEntries(headers.slice(1).map((h, i) => [h, r[i + 1]])); });
  return { svg: svgWrap(s), facts: { column_total: totals, cells, cell_lookup: spec.ask && cells[spec.ask.row] ? cells[spec.ask.row][spec.ask.col] ?? null : null } };
};

RENDERERS.logic_gate = (spec) => {
  const g = String(spec.gate || '').toUpperCase();
  if (!['AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR'].includes(g)) throw new Error('logic_gate: gate aan la aqoon');
  const x = 220, y = 120, w = 150, h = 120, mid = y + h / 2;
  let s = '', outX = x + w;
  const and = () => PATH(`M${x} ${y} H${x + w * 0.5} A${w * 0.5} ${h / 2} 0 0 1 ${x + w * 0.5} ${y + h} H${x} Z`);
  const or = () => PATH(`M${x} ${y} Q${x + w * 0.55} ${y} ${x + w} ${mid} Q${x + w * 0.55} ${y + h} ${x} ${y + h} Q${x + w * 0.28} ${mid} ${x} ${y} Z`);
  if (g === 'AND' || g === 'NAND') s += and();
  else if (g === 'OR' || g === 'NOR') s += or();
  else if (g === 'XOR') s += or() + PATH(`M${x - 16} ${y} Q${x + w * 0.12} ${mid} ${x - 16} ${y + h}`);
  else { s += PG([[x, y], [x, y + h], [x + w * 0.85, mid]], { fill: 'none', sw: 1.8 }); outX = x + w * 0.85; }
  const bubble = ['NAND', 'NOR', 'NOT'].includes(g);
  if (bubble) { s += C(outX + 8, mid, 8, { sw: 1.6 }); outX += 16; }
  s += L(outX, mid, outX + 90, mid, { w: 1.8 });
  if (g === 'NOT') s += L(x - 90, mid, x, mid, { w: 1.8 }) + T(x - 98, mid + 5, 'A', { size: 16, anchor: 'end', role: 'id' });
  else s += L(x - 90, y + 32, x + 8, y + 32, { w: 1.8 }) + L(x - 90, y + h - 32, x + 8, y + h - 32, { w: 1.8 }) + T(x - 98, y + 37, 'A', { size: 16, anchor: 'end', role: 'id' }) + T(x - 98, y + h - 27, 'B', { size: 16, anchor: 'end', role: 'id' });
  s += T(outX + 100, mid + 5, 'Q', { size: 16, anchor: 'start', role: 'id' });
  return { svg: svgWrap(s), facts: { gate_name: g } };
};

RENDERERS.flowchart = (spec) => {
  const nodes = (spec.nodes || []).map((n) => ({ type: String(n.type || 'process'), label: String(n.label ?? '') }));
  if (nodes.length < 1 || nodes.length > 6) throw new Error('flowchart: 1-6 nodes');
  const ok = ['start', 'end', 'process', 'decision', 'io'];
  if (nodes.some((n) => !ok.includes(n.type))) throw new Error('flowchart: node type aan la aqoon');
  const n = nodes.length, bw = n === 1 ? 190 : Math.min(120, (W - 80 - (n - 1) * 30) / n), bh = n === 1 ? 120 : 62, gap = n === 1 ? 0 : (W - 80 - n * bw) / (n - 1), cy = 180;
  let s = '';
  nodes.forEach((nd, i) => {
    const x = 40 + i * (bw + gap), cx = x + bw / 2, lab = nd.label;
    if (nd.type === 'decision') s += PG([[cx, cy - bh / 2 - 8], [x + bw, cy], [cx, cy + bh / 2 + 8], [x, cy]], { fill: 'none', sw: 1.8 });
    else if (nd.type === 'process') s += R(x, cy - bh / 2, bw, bh, { sw: 1.8 });
    else if (nd.type === 'io') s += PG([[x + 18, cy - bh / 2], [x + bw + 18, cy - bh / 2], [x + bw - 18, cy + bh / 2], [x - 18, cy + bh / 2]], { fill: 'none', sw: 1.8 });
    else s += R(x, cy - bh / 2, bw, bh, { sw: 1.8, rx: bh / 2 });
    s += T(cx, cy + 5, lab, { size: n === 1 ? 26 : 14, role: lab === '?' ? 'id' : 'data' });
    if (i < n - 1) s += arrow(x + bw + (nd.type === 'io' ? 18 : 0), cy, x + bw + gap - 2, cy);
  });
  return { svg: svgWrap(s), facts: { nodes: nodes.map((x) => x.type), symbol_type: nodes.length === 1 ? nodes[0].type : null } };
};

RENDERERS.resistor_circuit = (spec) => {
  const mode = spec.mode === 'parallel' ? 'parallel' : 'series';
  const vals = (spec.values || []).map((v) => num(v)).filter((v) => v > 0);
  if (vals.length < 2 || vals.length > 3) throw new Error('resistor_circuit: 2-3 resistors');
  const V = num(spec.voltage, 12), x0 = 100, x1 = 540, yT = 90, yB = 290;
  let s = '';
  // Battery on left rail (cell: long thin plate + short thick plate)
  s += L(x0, yT, x0, 160) + L(x0, 194, x0, yB);
  s += L(x0 - 22, 160, x0 + 22, 160, { w: 2.4 }) + L(x0 - 12, 177, x0 + 12, 177, { w: 4 }) + L(x0 - 22, 194, x0 + 22, 194, { w: 2.4 });
  s += T(x0 - 32, 182, `${fmtNum(V)} V`, { size: 16, anchor: 'end', role: 'data' });
  const resBox = (cx, cy, vertical, v) => (vertical ? R(cx - 14, cy - 28, 28, 56, { fill: '#fff' }) + T(cx + 22, cy + 5, `${fmtNum(v)} Ω`, { size: 15, anchor: 'start' }) : R(cx - 28, cy - 14, 56, 28, { fill: '#fff' }) + T(cx, cy - 22, `${fmtNum(v)} Ω`, { size: 15 }));
  let req;
  if (mode === 'series') {
    const n = vals.length, seg = (x1 - x0) / n;
    s += L(x0, yT, x1, yT) + L(x1, yT, x1, yB) + L(x0, yB, x1, yB);
    // cover wire under boxes by drawing white boxes after wire
    vals.forEach((v, i) => { s += resBox(x0 + seg * (i + 0.5), yT, false, v); });
    req = vals.reduce((a, b) => a + b, 0);
  } else {
    const n = vals.length, xs = vals.map((_, i) => 230 + i * ((x1 - 230) / (n - 0.2)));
    s += L(x0, yT, xs[n - 1], yT) + L(x0, yB, xs[n - 1], yB);
    xs.forEach((x, i) => { s += L(x, yT, x, yB) + C(x, yT, 3.5, { fill: '#000' }) + C(x, yB, 3.5, { fill: '#000' }) + resBox(x, (yT + yB) / 2, true, vals[i]); });
    req = 1 / vals.reduce((a, b) => a + 1 / b, 0);
  }
  return { svg: svgWrap(s), facts: { mode, equivalent_resistance: r2(req), total_current: r2(V / req), voltage: V } };
};


RENDERERS.network_topology = (spec) => {
  const type = String(spec.type || '').toLowerCase(), n = Math.max(3, Math.min(6, Math.round(num(spec.nodes, 5))));
  if (!['star', 'ring', 'bus', 'mesh', 'tree'].includes(type)) throw new Error('network_topology: type = star|ring|bus|mesh|tree');
  const node = (x, y) => R(x - 22, y - 15, 44, 30, { fill: '#e8eef7', sw: 1.6 });
  let s = '';
  const cx = 320, cy = 185, rad = 120;
  const ring = Array.from({ length: n }, (_, i) => [cx + rad * Math.cos((2 * Math.PI * i) / n - Math.PI / 2), cy + rad * Math.sin((2 * Math.PI * i) / n - Math.PI / 2)]);
  if (type === 'star') { ring.forEach((p) => { s += L(cx, cy, p[0], p[1]); }); s += R(cx - 28, cy - 18, 56, 36, { fill: '#fde9c8' }); ring.forEach((p) => { s += node(p[0], p[1]); }); }
  else if (type === 'ring') { ring.forEach((p, i) => { const q = ring[(i + 1) % n]; s += L(p[0], p[1], q[0], q[1]); }); ring.forEach((p) => { s += node(p[0], p[1]); }); }
  else if (type === 'mesh') { ring.forEach((p, i) => ring.forEach((q, j) => { if (j > i) s += L(p[0], p[1], q[0], q[1], { w: 1.2 }); })); ring.forEach((p) => { s += node(p[0], p[1]); }); }
  else if (type === 'bus') { s += L(70, 185, 570, 185, { w: 2.6 }); for (let i = 0; i < n; i++) { const x = 100 + i * (440 / (n - 1)), up = i % 2 === 0, y = up ? 105 : 265; s += L(x, 185, x, up ? y + 15 : y - 15) + node(x, y); } }
  else { s += R(cx - 28, 60, 56, 32, { fill: '#fde9c8' }); const kids = Math.min(n, 4); for (let i = 0; i < kids; i++) { const x = 130 + i * (380 / Math.max(1, kids - 1)); s += L(cx, 92, x, 190) + R(x - 26, 190, 52, 30, { fill: '#e8eef7' }); if (i < 2) { s += L(x, 220, x - 30, 290) + L(x, 220, x + 30, 290) + node(x - 30, 305) + node(x + 30, 305); } } }
  return { svg: svgWrap(s), facts: { topology_name: type } };
};

RENDERERS.coord_line = (spec) => {
  const m = num(spec.m), c = num(spec.c), lo = num(spec.xMin, -5), hi = num(spec.xMax, 5);
  const ys = [m * lo + c, m * hi + c], yMin = Math.min(-1, ...ys, c), yMax = Math.max(1, ...ys, c), pad = 1;
  const x0 = 80, x1 = 560, yt = 40, yb = 320;
  const sx = (x) => x0 + ((x - lo) / (hi - lo)) * (x1 - x0), sy = (y) => yb - ((y - (yMin - pad)) / (yMax - yMin + 2 * pad)) * (yb - yt);
  let s = '';
  const gx = Math.max(1, Math.round(niceStep(hi - lo, 8))), gy = Math.max(1, Math.round(niceStep(yMax - yMin + 2 * pad, 8)));
  for (let x = Math.ceil(lo / gx) * gx; x <= hi; x += gx) { s += L(sx(x), yt, sx(x), yb, { w: 0.4 }); if (x !== 0) s += T(sx(x), sy(0) + 16, String(x), { size: 12, role: 'tick' }); }
  for (let y = Math.ceil((yMin - pad) / gy) * gy; y <= yMax + pad; y += gy) { s += L(x0, sy(y), x1, sy(y), { w: 0.4 }); if (y !== 0) s += T(sx(0) - 6, sy(y) + 4, String(y), { size: 12, anchor: 'end', role: 'tick' }); }
  s += arrow(x0, sy(0), x1 + 12, sy(0)) + arrow(sx(0), yb, sx(0), yt - 10) + T(x1 + 14, sy(0) + 18, 'x', { size: 15, anchor: 'start', role: 'id' }) + T(sx(0) + 10, yt - 4, 'y', { size: 15, anchor: 'start', role: 'id' });
  s += L(sx(lo), sy(m * lo + c), sx(hi), sy(m * hi + c), { w: 2.2 });
  const pts = (spec.points || []).map((x) => num(x)).filter((x) => x >= lo && x <= hi);
  pts.forEach((x, i) => { s += C(sx(x), sy(m * x + c), 4, { fill: '#000' }) + T(sx(x) + 12, sy(m * x + c) - 8, String.fromCharCode(65 + i), { size: 15, anchor: 'start', role: 'id' }); });
  return { svg: svgWrap(s), facts: { gradient: m, y_intercept: c, points: pts.map((x) => [x, m * x + c]) } };
};

export const FIGURE_SCHEMAS = {
  vt_graph: '{"points":[[0,0],[20,40],[30,40],[40,0]],"ids":["O","K","L","M"],"xLabel":"Time/s","yLabel":"Velocity/m s⁻¹"}  (times strictly increasing; exactly ONE constant-velocity stretch if you ask constant_interval)',
  wave: '{"amplitude":4,"period":30,"cycles":2,"tUnit":"ms","unit":"cm"}',
  forces: '{"left":[300],"right":[300],"unit":"N","objectLabel":""}  (arrays of positive forces)',
  right_triangle: '{"a":6,"b":8,"unit":"cm","names":["A","B","C"]}  (right angle at B; a = BC horizontal, b = AB vertical; prefer Pythagorean triples)',
  bar_chart: '{"title":"","labels":["2019","2020","2021","2022"],"values":[30,45,60,40],"yLabel":"","unit":""}  (3-8 bars, unique max and min)',
  line_chart: '{"title":"","labels":["Jan","Feb","Mar","Apr"],"values":[10,25,18,32],"yLabel":"","unit":""}',
  pie_chart: '{"labels":["A","B","C"],"values":[50,30,20]}',
  data_table: '{"title":"","headers":["Item","Amount"],"rows":[["Capital","24000"],["Stock","1500"]],"ask":{"row":"Stock","col":"Amount"}}  (use "?" as a cell value to hide it)',
  logic_gate: '{"gate":"AND"}  (AND|OR|NOT|NAND|NOR|XOR)',
  flowchart: '{"nodes":[{"type":"start","label":"Start"},{"type":"process","label":"Input"},{"type":"decision","label":"?"}]}  (types: start,end,process,decision,io; one node with label "?" = identify the symbol)',
  resistor_circuit: '{"mode":"series","values":[4,6],"voltage":12}  (mode series|parallel; 2-3 resistors in ohms)',
  network_topology: '{"type":"star","nodes":5}  (type star|ring|bus|mesh|tree; nodes 3-6; the figure never carries the topology name)',
  coord_line: '{"m":2,"c":1,"xMin":-4,"xMax":4,"points":[1,3]}'
};

export function renderFigure(kind, spec) {
  const fn = RENDERERS[kind];
  if (!fn) throw new Error(`Nooca sawirka lama taageero: ${kind}`);
  return fn(spec || {});
}

// ---------- Verification ----------------------------------------------------------------------------------------
const FORBIDDEN_TAG = /<\s*(script|foreignObject|image|use|marker|style|iframe|link)\b/i;
const normTxt = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}.\-+/]+/gu, ' ').trim();

export function extractTexts(svg) {
  const out = [];
  const rx = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = rx.exec(svg))) {
    const a = m[1], g = (name, d = '') => { const mm = a.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`)); return mm ? mm[1] : d; };
    const text = m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    out.push({ text, x: parseFloat(g('x', '0')), y: parseFloat(g('y', '0')), size: parseFloat(g('font-size', '16')) || 16, anchor: g('text-anchor', 'start'), role: g('data-role', '') });
  }
  return out;
}
function textBox(t) {
  const w = Math.max(1, [...t.text].length) * t.size * 0.56, h = t.size;
  const x = t.anchor === 'middle' ? t.x - w / 2 : t.anchor === 'end' ? t.x - w : t.x;
  return { x, y: t.y - h * 0.8, w, h };
}
function numbersIn(str) { return (String(str).match(/-?\d+(?:\.\d+)?/g) || []).map(Number); }

export function verifySvg(svg, { answerTexts = [], expectedNumbers = [], requireText = false, minShapes = 3 } = {}) {
  const issues = [];
  if (!/^\s*<svg\b/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) issues.push('SVG-gu ma dhammaystirna (xidhitaan ma jirto)');
  if (FORBIDDEN_TAG.test(svg) || /url\s*\(/i.test(svg) || /\son\w+\s*=/i.test(svg)) issues.push('SVG-gu wuxuu leeyahay tag/xiriir aan la oggolayn');
  const vb = svg.match(/viewBox\s*=\s*["']\s*([\d.\-]+)[ ,]+([\d.\-]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
  if (!vb) issues.push('viewBox ma jiro');
  const VW = vb ? Number(vb[3]) : W, VH = vb ? Number(vb[4]) : H;
  // Tag balance
  const stack = []; const tagRx = /<\s*(\/)?\s*([a-zA-Z][\w:-]*)\b[^>]*?(\/)?>/g; let tm;
  while ((tm = tagRx.exec(svg))) { if (tm[3]) continue; if (tm[1]) { const top = stack.pop(); if (top !== tm[2].toLowerCase()) { issues.push('tag-yada SVG-ga isma dhigmaan'); break; } } else stack.push(tm[2].toLowerCase()); }
  if (stack.length) issues.push('tag-yada SVG-ga ma xirna');
  // Shapes count => visible
  const shapes = (svg.match(/<(rect|line|polyline|polygon|circle|ellipse|path)\b/gi) || []).length;
  if (shapes < minShapes) issues.push('sawirku wuu madhan yahay (qaybo yar)');
  // Out-of-canvas numbers on common attrs
  const bad = [];
  const chk = (re, axis) => { let m; while ((m = re.exec(svg))) { const v = parseFloat(m[1]); if (axis === 'x' && (v < -2 || v > VW + 2)) bad.push(`x=${v}`); if (axis === 'y' && (v < -2 || v > VH + 2)) bad.push(`y=${v}`); } };
  chk(/\b(?:x|x1|x2|cx)\s*=\s*"(-?[\d.]+)"/g, 'x'); chk(/\b(?:y|y1|y2|cy)\s*=\s*"(-?[\d.]+)"/g, 'y');
  const rectRx = /<rect\b([^>]*)>/gi; let rm;
  while ((rm = rectRx.exec(svg))) {
    const g = (n) => { const mm = rm[1].match(new RegExp(`\\b${n}\\s*=\\s*"(-?[\\d.]+)"`)); return mm ? parseFloat(mm[1]) : null; };
    const rx0 = g('x') ?? 0, ry0 = g('y') ?? 0, rw = g('width'), rh = g('height');
    if (rw !== null && rh !== null && !(rw >= VW - 1 && rh >= VH - 1) && (rx0 < -2 || ry0 < -2 || rx0 + rw > VW + 2 || ry0 + rh > VH + 2)) bad.push(`rect ${rx0},${ry0} ${rw}x${rh}`);
  }
  const circRx = /<circle\b([^>]*)>/gi; let cm;
  while ((cm = circRx.exec(svg))) {
    const g = (n) => { const mm = cm[1].match(new RegExp(`\\b${n}\\s*=\\s*"(-?[\\d.]+)"`)); return mm ? parseFloat(mm[1]) : 0; };
    const cx = g('cx'), cy = g('cy'), cr = g('r');
    if (cx - cr < -2 || cy - cr < -2 || cx + cr > VW + 2 || cy + cr > VH + 2) bad.push(`circle ${cx},${cy} r${cr}`);
  }
  const ptsRx = /points\s*=\s*"([^"]+)"/g; let pm;
  while ((pm = ptsRx.exec(svg))) pm[1].trim().split(/\s+/).forEach((p) => { const [px, py] = p.split(',').map(parseFloat); if (px < -2 || px > VW + 2 || py < -2 || py > VH + 2) bad.push(`point ${p}`); });
  if (bad.length) issues.push(`qaybo ayaa canvas-ka ka baxsan (${bad.slice(0, 3).join(', ')})`);
  // Text: inside canvas + overlap
  const texts = extractTexts(svg).filter((t) => t.text);
  const boxes = texts.map(textBox);
  boxes.forEach((b, i) => { if (b.x < 2 || b.x + b.w > VW - 2 || b.y < 2 || b.y + b.h > VH - 2) issues.push(`qoraalka "${texts[i].text.slice(0, 20)}" wuu ka baxsan yahay xadka`); });
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j], ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox > 3 && oy > 3) { issues.push(`calaamado is-qaba: "${texts[i].text.slice(0, 14)}" iyo "${texts[j].text.slice(0, 14)}"`); }
  }
  if (requireText && !texts.length) issues.push('sawirku calaamad ma laha');
  // Answer leak: only 'annot' texts (and all multi-char free text from unknown generators)
  const sensitive = texts.filter((t) => t.role === 'annot' || (t.role === '' && [...t.text].length > 2));
  const leaks = [];
  for (const ans of answerTexts.map(normTxt).filter((a) => a.length >= 3)) for (const t of sensitive) if (normTxt(t.text).includes(ans)) leaks.push(t.text.slice(0, 30));
  for (const n of expectedNumbers) for (const t of texts.filter((x) => x.role === 'annot')) if (numbersIn(t.text).includes(n)) leaks.push(t.text.slice(0, 30));
  if (leaks.length) issues.push(`sawirku wuxuu muujinayaa jawaabta: "${[...new Set(leaks)].slice(0, 2).join('", "')}"`);
  return { ok: issues.length === 0, issues, stats: { shapes, texts: texts.length } };
}

// ---------- MCQ vs facts (jawaabta saxda ah jirto, isla markaana waa sax) ----------------------------------------
const LETTERS = ['A', 'B', 'C', 'D'];
export function optionText(opt) { return String(opt || '').replace(/^\s*[A-DBTJX][\.\):]\s+/i, '').trim(); }
export function answerIndex(q) {
  const a = String(q.answer || '').trim();
  const m = a.match(/^([A-D])\b/i);
  if (m) return LETTERS.indexOf(m[1].toUpperCase());
  const i = (q.options || []).findIndex((o) => normTxt(optionText(o)) === normTxt(a));
  return i;
}

// Soo saar qiimaha la sugayo ee su'aasha ka timaadda facts + askFact
export function expectedFor(askFact, facts, spec = {}) {
  const numKinds = ['max_value', 'acceleration', 'amplitude', 'period', 'frequency', 'resultant', 'equivalent_resistance', 'total_current', 'gradient', 'y_intercept', 'hypotenuse', 'area', 'perimeter', 'total', 'difference'];
  if (numKinds.includes(askFact)) { const v = facts[askFact]; return v === null || v === undefined ? null : { type: 'number', value: Number(v), unit: facts.unit || '' }; }
  if (askFact === 'constant_interval') { const c = facts.constant_intervals || []; return c.length === 1 ? { type: 'tokens', tokens: [c[0].from, c[0].to] } : null; }
  if (['max_label', 'min_label', 'largest_share', 'smallest_share'].includes(askFact)) return facts[askFact] ? { type: 'tokens', tokens: [String(facts[askFact])] } : null;
  if (askFact === 'gate_name') return { type: 'tokens', tokens: [facts.gate_name] };
  if (askFact === 'topology_name') return { type: 'tokens', tokens: [facts.topology_name] };
  if (askFact === 'column_total') { const h = spec.ask && spec.ask.col; return h && facts.column_total && h in facts.column_total ? { type: 'number', value: facts.column_total[h] } : null; }
  if (askFact === 'cell_lookup') return facts.cell_lookup != null ? (Number.isFinite(Number(String(facts.cell_lookup).replace(/,/g, ''))) ? { type: 'number', value: Number(String(facts.cell_lookup).replace(/,/g, '')) } : { type: 'tokens', tokens: [String(facts.cell_lookup)] }) : null;
  return null; // symbol_type, part_identification: lama hubin karo si toos ah
}
function optionMatches(optTxt, exp) {
  if (!exp) return null;
  if (exp.type === 'number') return numbersIn(optTxt.replace(/(\d),(\d{3})/g, '$1$2')).some((n) => Math.abs(n - exp.value) <= Math.max(0.005, Math.abs(exp.value) * 1e-6));
  const t = normTxt(optTxt); return exp.tokens.every((k) => new RegExp(`(^|[^\\p{L}\\p{N}])${normTxt(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'u').test(t));
}
export function formatExpected(exp, unitHint = '') {
  if (!exp) return '';
  if (exp.type === 'number') return `${fmtNum(exp.value)}${unitHint ? ' ' + unitHint : exp.unit ? ' ' + exp.unit : ''}`;
  return exp.tokens.join(' – ');
}
function distractorNumbers(v) {
  const base = [v * 2, v / 2, v + Math.max(1, Math.abs(v) * 0.25), v - Math.max(1, Math.abs(v) * 0.25), v * 3, -v, v + 10, v + 5].filter((x) => Number.isFinite(x) && Math.abs(x - v) > 1e-9);
  return [...new Set(base.map(r2))].filter((x) => x >= 0 || v < 0);
}

// Hubi + (haddii loo baahdo) hagaaji su'aasha MCQ. Soo celiyaa {q, issues, repaired}
export function checkAndRepairMcq(q, { askFact = null, facts = null, spec = {}, unitHint = '' } = {}) {
  const issues = [], out = { ...q, options: [...(q.options || [])] };
  let repaired = false;
  if (out.options.length !== 4 || out.options.some((o) => !optionText(o))) issues.push('MCQ waa inuu lahaadaa 4 doorasho oo buuxa');
  const norm = out.options.map((o) => normTxt(optionText(o)));
  if (new Set(norm).size !== norm.length) issues.push('doorashooyin is-dhigma ayaa jira');
  const exp = askFact && facts ? expectedFor(askFact, facts, spec) : null;
  if (exp) {
    const matches = out.options.map((o, i) => (optionMatches(optionText(o), exp) ? i : -1)).filter((i) => i >= 0);
    let idx = answerIndex(out);
    if (matches.length === 1) {
      if (idx !== matches[0]) { out.answer = LETTERS[matches[0]]; repaired = true; issues.push(`furaha jawaabta waa la saxay: ${LETTERS[idx] || '?'} → ${LETTERS[matches[0]]} (xisaabta sawirka ayaa tilmaamtay)`); }
    } else if (matches.length === 0) {
      // Dhig jawaabta saxda ah meesha furuhu tilmaamayo, distractor-ka kale ka dhig kuwo tiro ah
      if (idx < 0 || idx > 3) idx = 0;
      out.options[idx] = formatExpected(exp, unitHint);
      if (exp.type === 'number') {
        const ds = distractorNumbers(exp.value); let k = 0;
        out.options = out.options.map((o, i) => (i === idx ? o : `${fmtNum(ds[k++ % ds.length] ?? exp.value + k + 1)}${unitHint || exp.unit ? ' ' + (unitHint || exp.unit) : ''}`));
      }
      out.answer = LETTERS[idx]; repaired = true; issues.push('doorashooyinka kuma jirin jawaabta saxda ah - waa la dhisay');
    } else {
      issues.push('in ka badan hal doorasho ayaa jawaabta saxda ah leh');
      if (exp.type === 'number') { // dhig kuwa kale mid kale
        const keep = matches.includes(answerIndex(out)) ? answerIndex(out) : matches[0];
        const used = new Set(out.options.flatMap((o) => numbersIn(optionText(o)))); const ds = distractorNumbers(exp.value).filter((x) => !used.has(x));
        let k = 0, extra = 1;
        out.options = out.options.map((o, i) => { if (!(matches.includes(i) && i !== keep)) return o; const nv = k < ds.length ? ds[k++] : exp.value + 7 * extra++; return `${fmtNum(nv)}${unitHint || exp.unit ? ' ' + (unitHint || exp.unit) : ''}`; });
        out.answer = LETTERS[keep]; repaired = true;
      }
    }
    // Dib u hubi
    const again = out.options.map((o, i) => (optionMatches(optionText(o), exp) ? i : -1)).filter((i) => i >= 0);
    if (again.length !== 1 || answerIndex(out) !== again[0]) issues.push('jawaabta lama xaqiijin karo xisaabta sawirka');
  }
  const aIdx = answerIndex(out);
  if (aIdx < 0 || aIdx > 3) issues.push('furaha jawaabta (A-D) ma jiro ama waa khalad');
  else if (new Set(out.options.map((o) => normTxt(optionText(o)))).size !== out.options.length) issues.push('doorashooyin is-dhigma ayaa jira (kadib)');
  const hardIssues = issues.filter((i) => !/waa la saxay|waa la dhisay/.test(i));
  return { q: out, issues, repaired, ok: hardIssues.length === 0 };
}

// Hubinta guud ee su'aal + sawir
export function verifyFigureQuestion(q, { svg, facts = null, askFact = null, spec = {} }) {
  const mcq = Array.isArray(q.options) && q.options.length > 0;
  let answerTexts = [], expectedNumbers = [];
  if (mcq) { const i = answerIndex(q); if (i >= 0) answerTexts.push(optionText(q.options[i])); }
  else if (q.answer) answerTexts.push(String(q.answer));
  (q.keyPoints || []).forEach((k) => String(k).length >= 5 && answerTexts.push(String(k)));
  const exp = askFact && facts ? expectedFor(askFact, facts, spec) : null;
  if (exp && exp.type === 'number') expectedNumbers.push(exp.value);
  const sv = verifySvg(svg, { answerTexts, expectedNumbers });
  const issues = [...sv.issues];
  const stem = normTxt(q.question || q.text || '');
  if (!/figure|diagram|graph|chart|table|map|picture|image|below|jaantus|sawir|khariid|shaxda|hoose|الشكل|الرسم|أدناه/.test(stem)) issues.push('su\'aasha ma tixraacayso sawirka');
  if (mcq) { const i = answerIndex(q); if (i >= 0) { const ans = normTxt(optionText(q.options[i])); if (ans.length >= 4 && stem.includes(ans)) issues.push('su\'aasha qudheeda ayaa ka kooban jawaabta'); } }
  return { ok: issues.length === 0, issues };
}
