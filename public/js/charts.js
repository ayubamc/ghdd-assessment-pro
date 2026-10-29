/* Jaantusyo SVG ah (offline, maktabad la'aan). Midab kasta wuxuu raacayaa doorka xogta. */
(function (root) {
  'use strict';
  const C = {
    blue: '#2a78d6', orange: '#eb6834', aqua: '#1baf7a', ink: '#0f1b2d', muted: '#5b6676', grid: '#e3e8ef',
    good: '#0ca30c', bad: '#d03b3b',
    // heerar isku xiga (A → F): buluug madow → buluug khafiif ah
    ordinal: ['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6']
  };
  // Ballaca jaantuska waxaa lagu xiraa shaashadda si qoraalku uusan u yaraan taleefanka
  const W = () => Math.round(Math.min(640, Math.max(300, (typeof window !== 'undefined' ? window.innerWidth : 640) - 66)));
  const LW = () => (W() < 440 ? 112 : 150);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (v) => (v == null ? '–' : Math.round(v * 10) / 10);

  function gradeColors(grades) {
    const n = grades.length;
    if (n <= C.ordinal.length - 2) return grades.map((_, i) => C.ordinal[Math.round((i * (C.ordinal.length - 3)) / Math.max(1, n - 1))]);
    return grades.map((_, i) => C.ordinal[Math.min(C.ordinal.length - 1, i)]);
  }

  // Tiirar jiif ah – ku habboon taleefanka. items: [{label, value, sub, color, title}]
  function barH(items, o) {
    o = Object.assign({ max: 100, unit: '%', width: W(), labelW: LW(), bar: 18, gap: 12, ref: null, refLabel: '' }, o || {});
    if (!items.length) return '<p class="muted">Xog weli lama hayo.</p>';
    const top = o.ref != null ? 18 : 6;
    const H = top + items.length * (o.bar + o.gap) + 6;
    const plotW = o.width - o.labelW - (items.some((i) => i.sub) ? 112 : 56);
    const x = (v) => o.labelW + (Math.max(0, v || 0) / o.max) * plotW;
    let s = `<svg class="chart" viewBox="0 0 ${o.width} ${H}" role="img" aria-label="${esc(o.aria || 'Jaantus')}" style="max-width:${o.width}px">`;
    [0, 25, 50, 75, 100].filter((t) => t <= o.max).forEach((t) => {
      const tx = x((t / 100) * o.max);
      s += `<line x1="${tx}" x2="${tx}" y1="${top - 2}" y2="${H - 4}" stroke="${C.grid}" stroke-width="1"/>`;
    });
    if (o.ref != null) {
      const rx = x(o.ref);
      s += `<line x1="${rx}" x2="${rx}" y1="${top - 4}" y2="${H - 4}" stroke="${C.bad}" stroke-width="1.5" stroke-dasharray="4 3"/><text x="${rx}" y="11" text-anchor="middle" font-size="11" fill="${C.muted}">${esc(o.refLabel)}</text>`;
    }
    items.forEach((it, i) => {
      const y = top + i * (o.bar + o.gap);
      const w = Math.max(it.value ? 3 : 0, x(it.value) - o.labelW);
      const mx = Math.floor(o.labelW / 7.4); const lab = it.label.length > mx ? it.label.slice(0, mx - 1) + '…' : it.label;
      s += `<g class="hov"><title>${esc(it.title || `${it.label}: ${fmt(it.value)}${o.unit}`)}</title>`;
      s += `<rect x="0" y="${y - o.gap / 2}" width="${o.width}" height="${o.bar + o.gap}" fill="transparent"/>`;
      s += `<text x="${o.labelW - 8}" y="${y + o.bar / 2 + 4}" text-anchor="end" font-size="13" fill="${C.ink}">${esc(lab)}</text>`;
      s += `<rect x="${o.labelW}" y="${y}" width="${w}" height="${o.bar}" rx="4" fill="${it.color || C.blue}"/>`;
      s += `<text x="${o.labelW + w + 6}" y="${y + o.bar / 2 + 4}" font-size="12.5" font-weight="600" fill="${C.ink}">${fmt(it.value)}${o.unit}${it.sub ? `<tspan fill="${C.muted}" font-weight="400"> ${esc(it.sub)}</tspan>` : ''}</text></g>`;
    });
    return s + '</svg>';
  }

  // Tiirar taagan. items: [{label, value, color, title}]
  function columns(items, o) {
    o = Object.assign({ width: W(), height: 220, unit: '' }, o || {});
    if (!items.length) return '<p class="muted">Xog weli lama hayo.</p>';
    const max = Math.max(1, ...items.map((i) => i.value || 0));
    const padB = 28, padT = 20, plotH = o.height - padB - padT;
    const step = o.width / items.length, bw = Math.min(56, step * 0.62);
    let s = `<svg class="chart" viewBox="0 0 ${o.width} ${o.height}" role="img" aria-label="${esc(o.aria || 'Jaantus')}" style="max-width:${o.width}px">`;
    s += `<line x1="0" x2="${o.width}" y1="${padT + plotH}" y2="${padT + plotH}" stroke="${C.grid}"/>`;
    items.forEach((it, i) => {
      const h = ((it.value || 0) / max) * plotH;
      const cx = step * i + step / 2;
      s += `<g class="hov"><title>${esc(it.title || `${it.label}: ${it.value}${o.unit}`)}</title><rect x="${cx - step / 2}" y="0" width="${step}" height="${o.height}" fill="transparent"/>`;
      if (h > 0) s += `<path d="M${cx - bw / 2},${padT + plotH} v${-(h - 4)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 v${h - 4} z" fill="${it.color || C.blue}"/>`;
      s += `<text x="${cx}" y="${padT + plotH - h - 5}" text-anchor="middle" font-size="12" font-weight="600" fill="${C.ink}">${it.value}${o.unit}</text>`;
      s += `<text x="${cx}" y="${o.height - 8}" text-anchor="middle" font-size="12" fill="${C.muted}">${esc(it.label)}</text></g>`;
    });
    return s + '</svg>';
  }

  // Tiir isku-dhafan 100% (tusaale: grade-yada dugsi kasta). rows: [{label, parts:{A:3,...}}], keys: [{k,label,color}]
  function stacked(rows, keys, o) {
    o = Object.assign({ width: W(), labelW: LW(), bar: 20, gap: 14 }, o || {});
    if (!rows.length) return '<p class="muted">Xog weli lama hayo.</p>';
    const H = rows.length * (o.bar + o.gap) + 4;
    const plotW = o.width - o.labelW - 10;
    let s = `<svg class="chart" viewBox="0 0 ${o.width} ${H}" role="img" aria-label="${esc(o.aria || 'Jaantus')}" style="max-width:${o.width}px">`;
    rows.forEach((r, i) => {
      const y = i * (o.bar + o.gap) + 2;
      const total = keys.reduce((a, k) => a + (r.parts[k.k] || 0), 0);
      const mx = Math.floor(o.labelW / 7.4); const lab = r.label.length > mx ? r.label.slice(0, mx - 1) + '…' : r.label;
      s += `<text x="${o.labelW - 8}" y="${y + o.bar / 2 + 4}" text-anchor="end" font-size="13" fill="${C.ink}">${esc(lab)}</text>`;
      if (!total) { s += `<text x="${o.labelW}" y="${y + o.bar / 2 + 4}" font-size="12" fill="${C.muted}">Xog ma jirto</text>`; return; }
      let x = o.labelW;
      keys.forEach((k) => {
        const v = r.parts[k.k] || 0;
        if (!v) return;
        const w = (v / total) * plotW;
        s += `<g class="hov"><title>${esc(`${r.label} – ${k.label}: ${v} (${Math.round((v / total) * 100)}%)`)}</title><rect x="${x}" y="${y}" width="${Math.max(1, w - 2)}" height="${o.bar}" rx="3" fill="${k.color}"/>`;
        if (w > 26) s += `<text x="${x + w / 2 - 1}" y="${y + o.bar / 2 + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="${k.textColor || '#fff'}">${v}</text>`;
        s += '</g>';
        x += w;
      });
    });
    return s + '</svg>';
  }

  // Laba taxane oo isbarbar socda (tusaale: wiil/gabar). groups: [{label, values:[a,b]}], series: [{label,color}]
  function paired(groups, series, o) {
    o = Object.assign({ width: W(), labelW: LW(), bar: 13, inner: 3, gap: 14, max: 100, unit: '%' }, o || {});
    if (!groups.length) return '<p class="muted">Xog weli lama hayo.</p>';
    const gh = series.length * (o.bar + o.inner);
    const H = groups.length * (gh + o.gap) + 4;
    const plotW = o.width - o.labelW - 56;
    let s = `<svg class="chart" viewBox="0 0 ${o.width} ${H}" role="img" aria-label="${esc(o.aria || 'Jaantus')}" style="max-width:${o.width}px">`;
    groups.forEach((g, i) => {
      const y0 = i * (gh + o.gap) + 2;
      const mx = Math.floor(o.labelW / 7.4); const lab = g.label.length > mx ? g.label.slice(0, mx - 1) + '…' : g.label;
      s += `<text x="${o.labelW - 8}" y="${y0 + gh / 2 + 3}" text-anchor="end" font-size="13" fill="${C.ink}">${esc(lab)}</text>`;
      series.forEach((sr, j) => {
        const v = g.values[j];
        const y = y0 + j * (o.bar + o.inner);
        const w = v == null ? 0 : Math.max(2, (v / o.max) * plotW);
        s += `<g class="hov"><title>${esc(`${g.label} – ${sr.label}: ${fmt(v)}${o.unit}`)}</title><rect x="${o.labelW}" y="${y}" width="${w}" height="${o.bar}" rx="3" fill="${sr.color}"/>`;
        s += `<text x="${o.labelW + w + 5}" y="${y + o.bar - 2}" font-size="11.5" fill="${C.ink}">${fmt(v)}${v == null ? '' : o.unit}</text></g>`;
      });
    });
    return s + '</svg>';
  }

  function legend(keys) {
    return `<div class="legend">${keys.map((k) => `<span><i style="background:${k.color}"></i>${esc(k.label)}</span>`).join('')}</div>`;
  }

  root.Charts = { C, barH, columns, stacked, paired, legend, gradeColors };
})(typeof self !== 'undefined' ? self : this);
