// GHDD chemistry structure renderer.
// Turns a condensed structural formula written with branches in parentheses, for example
//   CH3-CH(CH3)-C(CH3)(OH)-CH=CH2          CH3-C(CH3)(OH)-C(CH3)=CH2
// into a clean vector drawing (main chain horizontal, branches above/below, double bonds as two lines),
// exactly like the branched-chain structures printed in school chemistry books.
// The output is plain inline <svg> (sharp in print, PDF and the Word export: docx-export.js rasterises it).
(function (root) {
  'use strict';

  // ---- Tuning -------------------------------------------------------------------------------
  const FS = 17;                    // label font size (px)
  const H = 18;                     // label box height
  const BOND_H = 20;                // horizontal bond length between labels
  const BOND_V = 20;                // vertical bond length between labels
  const GAP = 3;                    // empty space between a bond end and a label
  const PAD = 7;                    // padding around the drawing
  const DBL = 2.6;                  // half distance between the lines of a double bond
  const INK = '#111';

  // Arial advance widths (per 1000 em) for the few glyphs chemistry labels use.
  const ADV = { C: 722, H: 722, O: 778, N: 722, S: 667, P: 667, F: 611, I: 278, B: 667, r: 333, l: 222, '+': 584, '-': 333 };
  const DIGIT = 556;

  // ---- Label handling -----------------------------------------------------------------------
  const LABEL_RE = /^(?:(?:Cl|Br|C|H|O|N|S|P|F|I)\d*)+$/;
  function labelParts(label) {
    const parts = [];
    const re = /Cl|Br|[A-Z]|\d+/g;
    let m;
    while ((m = re.exec(label))) {
      const t = m[0];
      if (/^\d/.test(t)) parts.push({ t, sub: true, w: t.length * DIGIT * 0.7 * FS / 1000 });
      else parts.push({ t, sub: false, w: [...t].reduce((a, c) => a + (ADV[c] || 700), 0) * FS / 1000 });
    }
    return parts;
  }
  function labelMetrics(label) {
    const parts = labelParts(label);
    const w = parts.reduce((a, p) => a + p.w, 0);
    const first = parts.length ? parts[0].w : 10;
    return { parts, w, first };
  }
  const isCarbonLabel = l => /^C(?!l)/.test(l);

  // ---- Parser: condensed formula -> tree ----------------------------------------------------
  // chain := node (bond node)*
  // node  := group* label group*        group := '(' [bond] chain ')' [count]
  // Returns { nodes:[{label, branches:[{order, chain}], order(to next)}] } or null when not a formula.
  const BOND_ORDER = { '-': 1, '–': 1, '—': 1, '−': 1, '=': 2, '≡': 3 };
  function parse(src) {
    const s = String(src).replace(/[₀-₉]/g, d => String(d.charCodeAt(0) - 8320)).replace(/\s+/g, '');
    let i = 0;
    const fail = () => { throw new Error('parse'); };
    function readLabel() {
      const m = /^(?:(?:Cl|Br|C|H|O|N|S|P|F|I)\d*)+/.exec(s.slice(i));
      if (!m) fail();
      i += m[0].length;
      return m[0];
    }
    function readGroup() {            // at '('
      i++;
      let order = 1;
      if (BOND_ORDER[s[i]]) { order = BOND_ORDER[s[i]]; i++; }
      const chain = readChain();
      if (s[i] !== ')') fail();
      i++;
      let count = 1;
      const m = /^\d+/.exec(s.slice(i));
      if (m) { count = Math.min(4, parseInt(m[0], 10)); i += m[0].length; }
      return Array.from({ length: count }, () => ({ order, chain }));
    }
    function readNode() {
      const branches = [];
      while (s[i] === '(') branches.push(...readGroup());
      const label = readLabel();
      while (s[i] === '(') branches.push(...readGroup());
      return { label, branches, orderNext: 1 };
    }
    function readChain() {
      const nodes = [readNode()];
      while (i < s.length && BOND_ORDER[s[i]]) {
        const o = BOND_ORDER[s[i]];
        i++;
        nodes[nodes.length - 1].orderNext = o;
        nodes.push(readNode());
      }
      return nodes;
    }
    const chain = readChain();
    if (i !== s.length) fail();
    return chain;
  }

  // ---- Layout -------------------------------------------------------------------------------
  // Direction codes: 'R' (chain runs right), 'U'/'D' (chain runs up/down), 'L' (left).
  function layout(chain) {
    const nodes = [], bonds = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    function box(x, y, met) {
      minX = Math.min(minX, x - met.first / 2); maxX = Math.max(maxX, x - met.first / 2 + met.w);
      minY = Math.min(minY, y - H / 2); maxY = Math.max(maxY, y + H / 2);
    }
    function addBond(x1, y1, x2, y2, order, vertical) { bonds.push({ x1, y1, x2, y2, order, vertical }); }

    // Where do the branches of a node go? Alkyl groups (start with C) prefer 'up', hetero groups 'down'.
    function branchDirs(list, dir) {
      const perp = (dir === 'R' || dir === 'L') ? ['U', 'D'] : ['R', 'L'];
      const slots = {};
      const place = (b, d) => { slots[d] = b; };
      const alkyl = list.filter(b => isCarbonLabel(b.chain[0].label));
      const hetero = list.filter(b => !isCarbonLabel(b.chain[0].label));
      const ordered = [...alkyl, ...hetero];
      const out = [];
      if (ordered.length === 1) out.push([ordered[0], isCarbonLabel(ordered[0].chain[0].label) ? perp[0] : perp[1]]);
      else ordered.forEach((b, k) => out.push([b, k % 2 === 0 ? perp[0] : perp[1]]));
      return out;
    }

    // Place a chain whose first node anchor is at (x,y).  `back` = direction we came from (no branch there).
    function place(chain, x, y, dir) {
      const horizontal = dir === 'R' || dir === 'L';
      const sgn = dir === 'R' || dir === 'D' ? 1 : -1;
      let px = x, py = y, prev = null;
      chain.forEach((n, idx) => {
        const met = labelMetrics(n.label);
        if (prev) {
          if (dir === 'R') {
            px = prev.x - prev.met.first / 2 + prev.met.w + BOND_H + met.first / 2;
            // keep branch labels that hang on the same side of neighbouring atoms from touching each other
            const sideW = (rec, d) => { const e = rec.dirs.find(z => z[1] === d); return e ? labelMetrics(e[0].chain[0].label) : null; };
            ['U', 'D'].forEach(d => {
              const a = sideW(prev, d), c = { dirs: branchDirs(n.branches, dir) };
              const b = sideW(c, d);
              if (a && b) px = Math.max(px, prev.x + (a.w - a.first / 2) + 12 + b.first / 2);
            });
          }
          else if (dir === 'L') px = prev.x - prev.met.first / 2 - BOND_H - (met.w - met.first / 2);
          else py = prev.y + sgn * (H + BOND_V);
          if (horizontal) {
            const a = dir === 'R' ? prev.x - prev.met.first / 2 + prev.met.w + GAP : prev.x - prev.met.first / 2 - GAP;
            const b = dir === 'R' ? px - met.first / 2 - GAP : px - met.first / 2 + met.w + GAP;
            addBond(a, py, b, py, prev.orderNext, false);
          } else {
            addBond(px, prev.y + sgn * (H / 2 + 1), px, py - sgn * (H / 2 + 1), prev.orderNext, true);
          }
        }
        const rec = { x: px, y: py, met, label: n.label, orderNext: n.orderNext, dirs: branchDirs(n.branches, dir) };
        nodes.push(rec); box(px, py, met);
        // Branches
        rec.dirs.forEach(([b, d]) => {
          const bm = labelMetrics(b.chain[0].label);
          if (d === 'U' || d === 'D') {
            const s2 = d === 'D' ? 1 : -1;
            const by = py + s2 * (H + BOND_V);
            addBond(px, py + s2 * (H / 2 + 1), px, by - s2 * (H / 2 + 1), b.order, true);
            place(b.chain, px, by, d);
          } else {
            // sideways branch from a vertical chain
            if (d === 'R') {
              const bx = px - met.first / 2 + met.w + BOND_H + bm.first / 2;
              addBond(px - met.first / 2 + met.w + GAP, py, bx - bm.first / 2 - GAP, py, b.order, false);
              place(b.chain, bx, py, 'R');
            } else {
              const bx = px - met.first / 2 - BOND_H - (bm.w - bm.first / 2);
              addBond(px - met.first / 2 - GAP, py, bx - bm.first / 2 + bm.w + GAP, py, b.order, false);
              place(b.chain, bx, py, 'L');
            }
          }
        });
        prev = rec;
      });
    }
    place(chain, 0, 0, 'R');
    return { nodes, bonds, minX, maxX, minY, maxY };
  }

  // ---- SVG output ---------------------------------------------------------------------------
  const f = n => (Math.round(n * 10) / 10).toString();
  function toSvg(chain, plain) {
    const L = layout(chain);
    const ox = PAD - L.minX, oy = PAD - L.minY;
    const W = Math.ceil(L.maxX - L.minX + PAD * 2), Hh = Math.ceil(L.maxY - L.minY + PAD * 2);
    let g = '';
    L.bonds.forEach(b => {
      const lines = [];
      const o = b.order;
      const offs = o === 1 ? [0] : o === 2 ? [-DBL, DBL] : [-DBL * 1.6, 0, DBL * 1.6];
      offs.forEach(d => {
        lines.push(b.vertical
          ? `<line x1="${f(b.x1 + ox + d)}" y1="${f(b.y1 + oy)}" x2="${f(b.x2 + ox + d)}" y2="${f(b.y2 + oy)}"/>`
          : `<line x1="${f(b.x1 + ox)}" y1="${f(b.y1 + oy + d)}" x2="${f(b.x2 + ox)}" y2="${f(b.y2 + oy + d)}"/>`);
      });
      g += lines.join('');
    });
    let t = '';
    L.nodes.forEach(n => {
      const x = n.x - n.met.first / 2 + ox, y = n.y + oy + FS * 0.35;
      const spans = n.met.parts.map((p, k) => p.sub
        ? `<tspan font-size="${f(FS * 0.7)}" dy="${f(FS * 0.2)}">${p.t}</tspan><tspan dy="${f(-FS * 0.2)}"></tspan>`
        : `<tspan>${p.t}</tspan>`).join('');
      t += `<text x="${f(x)}" y="${f(y)}">${spans}</text>`;
    });
    const label = plain || 'Chemical structure';
    return `<svg class="chem-struct" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" role="img" aria-label="${label.replace(/[<>&"]/g, '')}" font-family="Arial, Helvetica, sans-serif" font-size="${FS}" fill="${INK}">`
      + `<g stroke="${INK}" stroke-width="1.5" stroke-linecap="round" fill="none">${g}</g>${t}</svg>`;
  }

  // ---- Detect formulas inside ordinary text -------------------------------------------------
  // A candidate is a run like  CH3-CH(CH3)-CH2-OH  (optionally with spaces around the bonds).
  const CANDIDATE_RE = /[A-Za-z0-9()]+(?:\s?[-–—−=≡]\s?[A-Za-z0-9()]+)*/g;

  function looksChemical(chain, raw) {
    const labels = [];
    (function walk(c) { c.forEach(n => { labels.push(n.label); n.branches.forEach(b => walk(b.chain)); }); })(chain);
    const hasC = labels.some(isCarbonLabel);
    const hasDigitOrParen = /[\d()]/.test(raw.replace(/[₀-₉]/g, '1'));
    const hasLower = /[a-z]/.test(raw.replace(/Cl|Br/g, ''));
    return hasC && hasDigitOrParen && !hasLower;
  }

  // Splits `text` into [{type:'text',value}|{type:'svg',svg}] segments.
  function split(text) {
    const src = String(text == null ? '' : text);
    const out = [];
    let last = 0, m;
    CANDIDATE_RE.lastIndex = 0;
    while ((m = CANDIDATE_RE.exec(src))) {
      const tok = m[0];
      const start = m.index;
      let chain = null, used = tok, pre = '', post = '';
      if (!/[-–—−=≡(]/.test(tok)) continue;
      const attempts = [tok];
      if (/^\(/.test(tok) && /\)$/.test(tok)) attempts.push(tok.slice(1, -1));   // "(CH3-CH2-OH)" in a sentence
      for (const a of attempts) {
        try { const c = parse(a); if (looksChemical(c, a)) { chain = c; used = a; break; } } catch (e) { /* not a formula */ }
      }
      if (!chain) continue;
      if (used !== tok) { pre = '('; post = ')'; }
      if (start > last) out.push({ type: 'text', value: src.slice(last, start) });
      if (pre) out.push({ type: 'text', value: pre });
      out.push({ type: 'svg', svg: toSvg(chain, used.replace(/\s+/g, '')), formula: used });
      if (post) out.push({ type: 'text', value: post });
      last = start + tok.length;
    }
    if (last < src.length) out.push({ type: 'text', value: src.slice(last) });
    return out;
  }

  const api = { parse, toSvg, split, labelMetrics };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GHDDChem = api;
})(typeof window !== 'undefined' ? window : globalThis);
