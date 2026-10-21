// GHDD Assessment Pro — real Word (.docx) export of the exam paper / answer key.
// Walks the rendered paper (#studentPaper / #keyPaper) and builds a genuine OOXML document with the
// `docx` library (vendor/docx.iife.js). Every SVG diagram is rasterised to a high-resolution PNG and
// embedded as a real picture, so diagrams look the same in Word, LibreOffice, Google Docs and in PDF.
(function () {
  'use strict';
  const D = window.docx;
  if (!D) { window.buildExamDocx = async () => { throw new Error('docx library lama soo rarin.'); }; return; }

  const PAGE_W = 11906, PAGE_H = 16838, MARGIN = 1021;      // A4, 1.8 cm margins (twips)
  const CONTENT_W = PAGE_W - 2 * MARGIN;                     // 9864 twips
  const FONT = { ascii: 'Arial', hAnsi: 'Arial', cs: 'Arial', eastAsia: 'Arial' };
  const SZ = { body: 22, small: 18, h1: 36, h2: 28, h3: 24 };
  const INLINE = new Set(['span', 'strong', 'b', 'em', 'i', 'u', 'small', 'sup', 'sub', 'a', 'br', 'code', 'mark', 'font', 'label']);
  const AR_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

  const line = (c = '333333', sz = 4) => ({ style: D.BorderStyle.SINGLE, size: sz, color: c });
  const none = () => ({ style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' });
  const allBorders = (b) => ({ top: b, bottom: b, left: b, right: b });

  // ---------------------------------------------------------------- images
  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('img')); i.src = src; });
  }
  function canvasToPng(canvas) {
    return new Promise((res, rej) => canvas.toBlob(b => b ? b.arrayBuffer().then(a => res(new Uint8Array(a))) : rej(new Error('png')), 'image/png'));
  }
  // Rasterise one SVG diagram to a sharp PNG. The size never depends on CSS/inline styles of the SVG:
  // a brand-new outer <svg> with explicit pixel width/height wraps the original drawing, so the picture
  // keeps exactly the proportions of the viewBox (as in the printed PDF) in every browser.
  async function svgToPng(svg) {
    const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const hasVb = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
    const num = v => (v && !/%|auto/i.test(v) ? parseFloat(v) : NaN);
    let w = hasVb ? vb[2] : num(svg.getAttribute('width'));
    let h = hasVb ? vb[3] : num(svg.getAttribute('height'));
    if (!(w > 0)) w = 640; if (!(h > 0)) h = 360;
    const box = hasVb ? vb : [0, 0, w, h];
    const NS = 'http://www.w3.org/2000/svg';
    const inner = svg.cloneNode(true);
    ['style', 'class', 'width', 'height', 'x', 'y'].forEach(a => inner.removeAttribute(a));
    inner.setAttribute('xmlns', NS);
    inner.setAttribute('viewBox', box.join(' '));
    inner.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    inner.setAttribute('width', w); inner.setAttribute('height', h);
    if (!inner.getAttribute('font-family')) inner.setAttribute('font-family', 'Arial, Helvetica, sans-serif');
    const innerStr = new XMLSerializer().serializeToString(inner);
    const svgStr = `<svg xmlns="${NS}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ffffff"/>${innerStr}</svg>`;
    const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
    let img;
    try { img = await loadImage(src); }
    catch (e1) {
      const u = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
      try { img = await loadImage(u); } finally { setTimeout(() => URL.revokeObjectURL(u), 3000); }
    }
    const k = Math.max(1, Math.min(4, 2560 / w));            // ~2500 px wide: sharp when zoomed or printed
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);   // same proportions as w:h
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, c.width, c.height);
    return { data: await canvasToPng(c), type: 'png', w, h };
  }
  async function rasterToImage(srcUrl) {
    const r = await fetch(srcUrl);
    if (!r.ok) throw new Error('img');
    const blob = await r.blob();
    const bmp = await createImageBitmap(blob);
    const t = (blob.type || '').toLowerCase();
    if (t === 'image/png' || t === 'image/jpeg' || t === 'image/jpg') {
      return { data: new Uint8Array(await blob.arrayBuffer()), type: t === 'image/png' ? 'png' : 'jpg', w: bmp.width, h: bmp.height };
    }
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0);
    return { data: await canvasToPng(c), type: 'png', w: bmp.width, h: bmp.height };
  }
  async function prepareImages(root) {
    const map = new Map();
    for (const el of Array.from(root.querySelectorAll('svg, img'))) {
      try {
        const info = el.tagName.toLowerCase() === 'svg' ? await svgToPng(el) : await rasterToImage(el.getAttribute('src'));
        map.set(el, info);
      } catch (e) { if (el.tagName.toLowerCase() === 'svg') map.set(el, { failed: true }); /* a missing letterhead is simply skipped */ }
    }
    return map;
  }

  // ---------------------------------------------------------------- inline content
  function textRun(text, st) {
    const rtl = !!st.rtl && AR_RE.test(text);
    return new D.TextRun({
      text, font: FONT,
      bold: !!st.bold, boldComplexScript: !!st.bold,
      italics: !!st.italics, italicsComplexScript: !!st.italics,
      underline: st.underline ? { type: D.UnderlineType.SINGLE } : undefined,
      size: st.size || SZ.body, sizeComplexScript: st.size || SZ.body,
      color: st.color, rightToLeft: rtl || undefined
    });
  }
  // Stacked fractions and radicals with an overline are written as real Word equations (OMML),
  // exactly like the stacked fractions / radicals of the printed paper.
  function mathNode(el) {
    const cls = el.classList;
    const txt = x => ((x && x.textContent) || '').replace(/\s+/g, ' ').trim();
    if (cls.contains('frac')) {
      return new D.Math({ children: [new D.MathFraction({
        numerator: [new D.MathRun(txt(el.querySelector('.num')))],
        denominator: [new D.MathRun(txt(el.querySelector('.den')))]
      })] });
    }
    if (cls.contains('rad')) {
      const sign = (el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild.nodeValue : '√').trim() || '√';
      const o = { children: [new D.MathRun(txt(el.querySelector('.rad-in')))] };
      if (sign === '∛') o.degree = [new D.MathRun('3')];
      if (sign === '∜') o.degree = [new D.MathRun('4')];
      return new D.Math({ children: [new D.MathRadical(o)] });
    }
    return null;
  }
  // Collect inline pieces: {text, st} or {raw: docxObject}
  function collectInline(node, st, out, env) {
    if (node.nodeType === 3) {
      const t = node.nodeValue.replace(/\s+/g, ' ');
      if (t) out.push({ text: t, st });
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') { out.push({ raw: new D.TextRun({ break: 1 }) }); return; }
    if (tag === 'svg' || tag === 'img') {
      const im = env.images.get(node);
      if (im && !im.failed) out.push({ raw: imageRun(im, node) });
      return;
    }
    const cls = node.classList;
    if (cls.contains('frac') || cls.contains('rad')) { const m = mathNode(node); if (m) { out.push({ raw: m }); return; } }
    let s = st;
    if (tag === 'strong' || tag === 'b' || cls.contains('marks') || cls.contains('question-number')) s = { ...s, bold: true };
    if (tag === 'em' || tag === 'i') s = { ...s, italics: true };
    if (tag === 'u') s = { ...s, underline: true };
    if (tag === 'small') s = { ...s, size: SZ.small };
    if (cls.contains('fill-blank')) {
      if (cls.contains('filled')) { s = { ...s, bold: true, underline: true }; }
      else { out.push({ text: '__________', st: s }); return; }
    }
    for (const ch of node.childNodes) collectInline(ch, s, out, env);
  }
  function finalizeInline(items) {
    const kids = [];
    let first = true;
    const texts = items.filter(i => i.text !== undefined);
    const firstText = texts[0], lastText = texts[texts.length - 1];
    let prevEndsSpace = true;
    for (const it of items) {
      if (it.raw) { kids.push(it.raw); prevEndsSpace = false; continue; }
      let t = it.text;
      if (prevEndsSpace) t = t.replace(/^ /, '');
      if (it === firstText && first) t = t.replace(/^ /, '');
      if (it === lastText) t = t.replace(/ $/, '');
      first = false;
      if (!t) continue;
      prevEndsSpace = / $/.test(t);
      kids.push(textRun(t, it.st));
    }
    return kids;
  }
  function imageRun(im, node, maxW, maxH) {
    maxW = maxW || 560; maxH = maxH || 400;
    const k = Math.min(1, maxW / im.w, maxH / im.h);
    const alt = node.getAttribute && (node.getAttribute('alt') || 'Diagram') || 'Diagram';
    // SVG diagrams are embedded as true vector graphics (sharp at any zoom, can be edited in Word with
    // "Convert to Shape") with a high-resolution PNG fallback for apps that do not read SVG.
    const media = im.svg
      ? { type: 'svg', data: im.svg, fallback: { type: 'png', data: im.data } }
      : { type: im.type, data: im.data };
    return new D.ImageRun({
      ...media,
      transformation: { width: Math.max(1, Math.round(im.w * k)), height: Math.max(1, Math.round(im.h * k)) },
      altText: { title: alt, description: alt, name: alt }
    });
  }

  // ---------------------------------------------------------------- paragraph helpers
  function alignOf(ctx, a) {
    a = a || ctx.align;
    if (a === 'center') return D.AlignmentType.CENTER;
    if (a === 'end') return D.AlignmentType.END;
    if (a === 'justify') return D.AlignmentType.BOTH;
    return undefined; // start (left in LTR, right in RTL because of bidirectional)
  }
  function para(kids, ctx, o) {
    o = o || {};
    return new D.Paragraph({
      children: kids,
      bidirectional: ctx.rtl || undefined,
      alignment: alignOf(ctx, o.align),
      spacing: { before: o.before !== undefined ? o.before : 0, after: o.after !== undefined ? o.after : 60, line: o.line || 276, lineRule: D.LineRuleType.AUTO },
      border: o.border, shading: o.shading, keepNext: o.keepNext, keepLines: o.keepLines,
      indent: o.indent, pageBreakBefore: o.pageBreakBefore
    });
  }
  function inlineKids(el, ctx, st, env) {
    const out = [];
    for (const ch of el.childNodes) collectInline(ch, { rtl: ctx.rtl, ...st }, out, env);
    return finalizeInline(out);
  }
  const emptyPara = (ctx) => new D.Paragraph({ bidirectional: ctx && ctx.rtl || undefined, spacing: { before: 0, after: 0, line: 240, lineRule: D.LineRuleType.AUTO }, children: [] });
  const spacer = () => new D.Paragraph({ spacing: { before: 0, after: 0, line: 80, lineRule: D.LineRuleType.EXACT }, children: [new D.TextRun({ text: '', size: 4 })] });

  // ---------------------------------------------------------------- tables
  function tableBorderMode(t, cls) {
    if (/\b(paper-meta|qrow)\b/.test(cls)) return 'none';
    if (/\bkp-table\b/.test(cls)) return 'hlines';
    return 'grid';
  }
  function colWidths(t, cls, ncol) {
    if (/\bmcq-options-table\b/.test(cls)) return Array(ncol).fill(Math.floor(CONTENT_W / ncol));
    if (/\bmatching-table\b/.test(cls) && ncol === 4) return [900, 3900, 1300, 3764];
    if (/\bkey-grid\b/.test(cls) && ncol % 2 === 0) {
      const pair = CONTENT_W / (ncol / 2), no = Math.round(pair * 0.35), val = Math.round(pair * 0.65), w = [];
      for (let i = 0; i < ncol / 2; i++) w.push(no, val);
      w[w.length - 1] += CONTENT_W - w.reduce((a, b) => a + b, 0);
      return w;
    }
    if (/\bkp-table\b/.test(cls) && ncol === 3) return [600, 7864, 1400];
    const base = Math.floor(CONTENT_W / ncol), w = Array(ncol).fill(base);
    w[ncol - 1] += CONTENT_W - base * ncol;
    return w;
  }
  function convertTable(t, ctx, env) {
    const cls = t.className || '';
    const rows = Array.from(t.rows);
    // grid size, honouring rowspans
    let ncol = 0; const carry = [];
    rows.forEach(r => {
      let col = 0;
      Array.from(r.cells).forEach(c => {
        while (carry[col] > 0) col++;
        for (let k = 0; k < c.colSpan; k++) carry[col + k] = c.rowSpan;
        col += c.colSpan;
      });
      for (let k = 0; k < carry.length; k++) if (carry[k] > 0) carry[k]--;
      ncol = Math.max(ncol, col);
    });
    if (!ncol || !rows.length) return null;
    const widths = colWidths(t, cls, ncol);
    const mode = tableBorderMode(t, cls);
    const cellBorders = mode === 'grid' ? allBorders(line()) : mode === 'hlines'
      ? { top: none(), left: none(), right: none, bottom: line('999999') } : allBorders(none());
    if (mode === 'hlines') { cellBorders.right = none(); }
    const rowsOut = [];
    const occ = []; // rowspan occupancy while computing column offsets
    rows.forEach((r, ri) => {
      let col = 0; const cells = [];
      Array.from(r.cells).forEach(c => {
        while (occ[col] > 0) col++;
        const span = c.colSpan, w = widths.slice(col, col + span).reduce((a, b) => a + b, 0);
        for (let k = 0; k < span; k++) occ[col + k] = c.rowSpan;
        col += span;
        const isHead = c.tagName.toLowerCase() === 'th' || c.classList.contains('kg-no');
        const centered = c.classList.contains('match-no') || c.classList.contains('match-answer') || c.classList.contains('kg-no') ||
          c.classList.contains('kg-val') || c.classList.contains('kp-n') || c.tagName.toLowerCase() === 'th';
        const cctx = { ...ctx, align: centered ? 'center' : (c.classList.contains('kp-m') ? 'end' : undefined) };
        let blocks = blocksFromChildren(c, cctx, env, isHead ? { bold: true } : {});
        blocks = fixCellBlocks(blocks, cctx);
        cells.push(new D.TableCell({
          children: blocks, columnSpan: span > 1 ? span : undefined, rowSpan: c.rowSpan > 1 ? c.rowSpan : undefined,
          width: { size: w, type: D.WidthType.DXA },
          shading: isHead ? { type: D.ShadingType.CLEAR, fill: 'EEEEEE', color: 'auto' } : undefined,
          verticalAlign: D.VerticalAlign.TOP, borders: cellBorders
        }));
      });
      for (let k = 0; k < occ.length; k++) if (occ[k] > 0) occ[k]--;
      rowsOut.push(new D.TableRow({ children: cells, cantSplit: true, tableHeader: !!r.closest('thead') }));
    });
    return new D.Table({
      rows: rowsOut, width: { size: CONTENT_W, type: D.WidthType.DXA }, columnWidths: widths,
      layout: D.TableLayoutType.FIXED, visuallyRightToLeft: ctx.rtl || undefined,
      margins: { top: 50, bottom: 50, left: 100, right: 100 },
      borders: mode === 'grid' ? { ...allBorders(line()), insideHorizontal: line(), insideVertical: line() }
        : { ...allBorders(none()), insideHorizontal: mode === 'hlines' ? line('999999') : none(), insideVertical: none() }
    });
  }
  // A table cell must contain at least one block and end with a paragraph.
  function fixCellBlocks(blocks, ctx) {
    if (!blocks.length) return [emptyPara(ctx)];
    if (blocks[blocks.length - 1] instanceof D.Table) blocks.push(spacer());
    return blocks;
  }
  // Two tables directly after each other would be merged by Word: keep a tiny paragraph between them.
  function separateTables(blocks) {
    const out = [];
    blocks.forEach((b, i) => {
      if (b instanceof D.Table && out.length && out[out.length - 1] instanceof D.Table) out.push(spacer());
      out.push(b);
    });
    return out;
  }
  // question row: number | question text | marks (one-row borderless table, like the printed paper)
  function questionRowTable(row, ctx, env, borders) {
    const kids = Array.from(row.children);
    const numEl = kids.find(k => k.classList.contains('question-number'));
    const txtEl = kids.find(k => k.classList.contains('question-text'));
    const mkEl = kids.find(k => k.classList.contains('marks'));
    const cell = (el, w, align, bold) => new D.TableCell({
      width: { size: w, type: D.WidthType.DXA }, verticalAlign: D.VerticalAlign.TOP, borders: borders,
      children: [para(el ? inlineKids(el, ctx, bold ? { bold: true } : {}, env) : [], ctx, { align, after: 0, keepNext: !!borders.keep })]
    });
    return new D.Table({
      rows: [new D.TableRow({ cantSplit: true, children: [cell(numEl, 700, undefined, true), cell(txtEl, CONTENT_W - 700 - 1900, undefined), cell(mkEl, 1900, 'end', true)] })],
      width: { size: CONTENT_W, type: D.WidthType.DXA }, columnWidths: [700, CONTENT_W - 2600, 1900],
      layout: D.TableLayoutType.FIXED, visuallyRightToLeft: ctx.rtl || undefined,
      margins: { top: 70, bottom: 70, left: 100, right: 100 },
      borders: { ...allBorders(none()), insideHorizontal: none(), insideVertical: none() }
    });
  }
  // MCQ: question row + the four options in ONE bordered table (same look as the PDF box)
  function mcqBoxTable(row, optTable, ctx, env) {
    const opts = Array.from(optTable.rows[0].cells);
    if (opts.length !== 4) return null;
    const NUM = 700, MK = 1900, q = Math.floor(CONTENT_W / 4);
    // grid columns so that both the question row and the 4 equal option columns line up
    const b1 = NUM, b2 = q, b3 = q * 2, b4 = q * 3, b5 = CONTENT_W - MK, b6 = CONTENT_W;
    const bounds = [0, b1, b2, b3, b4, b5, b6].filter((v, i, a) => i === 0 || v > a[i - 1]);
    if (bounds.length !== 7) return null;
    const widths = bounds.slice(1).map((v, i) => v - bounds[i]);
    const bord = allBorders(line());
    const kids = Array.from(row.children);
    const numEl = kids.find(k => k.classList.contains('question-number'));
    const txtEl = kids.find(k => k.classList.contains('question-text'));
    const mkEl = kids.find(k => k.classList.contains('marks'));
    const W = (a, b) => widths.slice(a, b).reduce((x, y) => x + y, 0);
    const mk = (el, a, b, align, bold, topOnly) => new D.TableCell({
      width: { size: W(a, b), type: D.WidthType.DXA }, columnSpan: b - a > 1 ? b - a : undefined, verticalAlign: D.VerticalAlign.TOP,
      borders: topOnly ? { top: line(), left: line(), right: line(), bottom: none() } : bord,
      children: [para(el ? inlineKids(el, ctx, bold ? { bold: true } : {}, env) : [], ctx, { align, after: 0 })]
    });
    const row1 = new D.TableRow({ cantSplit: true, children: [mk(numEl, 0, 1, undefined, true, true), mk(txtEl, 1, 5, undefined, false, true), mk(mkEl, 5, 6, 'end', true, true)] });
    const optCell = (td, a, b) => new D.TableCell({
      width: { size: W(a, b), type: D.WidthType.DXA }, columnSpan: b - a > 1 ? b - a : undefined, verticalAlign: D.VerticalAlign.TOP, borders: bord,
      children: fixCellBlocks(blocksFromChildren(td, ctx, env, {}), ctx)
    });
    const row2 = new D.TableRow({ cantSplit: true, children: [optCell(opts[0], 0, 2), optCell(opts[1], 2, 3), optCell(opts[2], 3, 4), optCell(opts[3], 4, 6)] });
    return new D.Table({
      rows: [row1, row2], width: { size: CONTENT_W, type: D.WidthType.DXA }, columnWidths: widths,
      layout: D.TableLayoutType.FIXED, visuallyRightToLeft: ctx.rtl || undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      borders: { ...allBorders(line()), insideHorizontal: none(), insideVertical: none() }
    });
  }
  function wordBoxTable(box, ctx, env) {
    const words = Array.from(box.children), cols = 5, w = Math.floor(CONTENT_W / cols);
    const rows = [];
    for (let i = 0; i < words.length; i += cols) {
      rows.push(new D.TableRow({ cantSplit: true, children: Array.from({ length: cols }, (_, j) => new D.TableCell({
        width: { size: w, type: D.WidthType.DXA }, borders: allBorders(none()),
        children: [para(words[i + j] ? inlineKids(words[i + j], ctx, {}, env) : [], { ...ctx, align: 'center' }, { after: 0 })]
      })) }));
    }
    return new D.Table({
      rows, width: { size: w * cols, type: D.WidthType.DXA }, columnWidths: Array(cols).fill(w), layout: D.TableLayoutType.FIXED,
      visuallyRightToLeft: ctx.rtl || undefined, margins: { top: 70, bottom: 70, left: 100, right: 100 },
      borders: { ...allBorders(line('333333', 10)), insideHorizontal: none(), insideVertical: none() }
    });
  }
  function metaTable(m, ctx, env) {
    const c = Array.from(m.children), w = CONTENT_W / 2;
    const cell = el => new D.TableCell({
      width: { size: w, type: D.WidthType.DXA }, borders: allBorders(none()),
      children: [para(el ? inlineKids(el, ctx, {}, env) : [], ctx, { after: 0 })]
    });
    return new D.Table({
      rows: [new D.TableRow({ children: [cell(c[0]), cell(c[1])] }), new D.TableRow({ children: [cell(c[2]), cell(c[3])] })],
      width: { size: CONTENT_W, type: D.WidthType.DXA }, columnWidths: [w, w], layout: D.TableLayoutType.FIXED,
      visuallyRightToLeft: ctx.rtl || undefined, margins: { top: 60, bottom: 60, left: 80, right: 80 },
      borders: { ...allBorders(none()), insideHorizontal: none(), insideVertical: none() }
    });
  }
  function passageTable(el, ctx, env) {
    const head = el.querySelector('.passage-head');
    const body = Array.from(el.children).filter(x => x !== head);
    const bodyBlocks = [];
    body.forEach(ch => block(ch, { ...ctx }, env, bodyBlocks));
    const navy = line('1F3A5F', 12);
    return new D.Table({
      rows: [
        new D.TableRow({ cantSplit: true, children: [new D.TableCell({
          width: { size: CONTENT_W, type: D.WidthType.DXA }, borders: allBorders(navy),
          shading: { type: D.ShadingType.CLEAR, fill: '1F3A5F', color: 'auto' },
          children: [para(head ? inlineKids(head, ctx, { bold: true, color: 'FFFFFF' }, env) : [], { ...ctx, align: 'center' }, { after: 20 })]
        })] }),
        new D.TableRow({ children: [new D.TableCell({
          width: { size: CONTENT_W, type: D.WidthType.DXA }, borders: allBorders(navy),
          margins: { top: 100, bottom: 100, left: 220, right: 220 },
          children: fixCellBlocks(separateTables(bodyBlocks), ctx)
        })] })
      ],
      width: { size: CONTENT_W, type: D.WidthType.DXA }, columnWidths: [CONTENT_W], layout: D.TableLayoutType.FIXED,
      visuallyRightToLeft: ctx.rtl || undefined,
      borders: { ...allBorders(navy), insideHorizontal: navy, insideVertical: none() }
    });
  }

  // ---------------------------------------------------------------- block walker
  function isInlineNode(n) {
    if (n.nodeType === 3) return true;
    if (n.nodeType !== 1) return false;
    const tag = n.tagName.toLowerCase();
    if (tag === 'svg' || tag === 'img') return false;
    return INLINE.has(tag) && !n.querySelector('table, div, p, h1, h2, h3, h4, svg, img');
  }
  function blocksFromChildren(el, ctx, env, st) {
    const out = []; let buf = [];
    const flush = () => {
      const kids = finalizeInline(buf); buf = [];
      if (kids.length) out.push(para(kids, ctx));
    };
    for (const ch of el.childNodes) {
      if (isInlineNode(ch)) { collectInline(ch, { rtl: ctx.rtl, ...st }, buf, env); continue; }
      flush();
      if (ch.nodeType === 1) block(ch, ctx, env, out, st);
    }
    flush();
    return separateTables(out);
  }
  function headingPara(el, ctx, env, size, keepNext) {
    const cls = el.classList;
    const o = { keepNext: true, before: cls.contains('paper-section') ? 200 : 100, after: 80 };
    if (cls.contains('paper-section')) o.border = { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: '555555', space: 2 } };
    return para(inlineKids(el, ctx, { bold: true, size }, env), ctx, o);
  }
  function block(el, ctx, env, out, st) {
    st = st || {};
    const tag = el.tagName.toLowerCase(), cls = el.classList;
    if (cls.contains('no-print') || tag === 'script' || tag === 'style') return;
    if (el.hasAttribute('dir')) ctx = { ...ctx, rtl: el.getAttribute('dir') === 'rtl' };

    if (tag === 'table') { const t = convertTable(el, ctx, env); if (t) out.push(t); return; }
    if (tag === 'svg' || tag === 'img') {
      const im = env.images.get(el);
      if (!im) return;
      if (im.failed) { out.push(para([textRun('[Diagram]', { italics: true })], ctx, { align: 'center' })); return; }
      const logo = cls.contains('exam-logo');
      out.push(para([imageRun(im, el, logo ? 650 : 560, logo ? 115 : 400)], ctx, { align: 'center', after: logo ? 60 : 120, before: logo ? 0 : 60, keepLines: true, keepNext: !logo }));
      return;
    }
    if (cls.contains('paper-meta')) { out.push(metaTable(el, ctx, env), spacer()); return; }
    if (cls.contains('word-box')) { out.push(wordBoxTable(el, ctx, env), spacer()); return; }
    if (cls.contains('passage-block')) { out.push(passageTable(el, ctx, env), spacer()); return; }
    if (cls.contains('answer-space')) {
      const n = Math.max(1, el.querySelectorAll('.answer-line').length);
      const g = line('777777');
      const rows = Array.from({ length: n }, () => new D.TableRow({
        height: { value: 480, rule: D.HeightRule.ATLEAST },
        children: [new D.TableCell({ width: { size: CONTENT_W, type: D.WidthType.DXA }, borders: { top: none(), left: none(), right: none(), bottom: g }, children: [emptyPara(ctx)] })]
      }));
      out.push(new D.Table({ rows, width: { size: CONTENT_W, type: D.WidthType.DXA }, columnWidths: [CONTENT_W], layout: D.TableLayoutType.FIXED,
        borders: { ...allBorders(none()), insideHorizontal: g, insideVertical: none() } }), spacer());
      return;
    }
    if (cls.contains('mcq-question-row')) {
      const inStruct = !!el.closest('.structured-box');
      const b = inStruct ? { top: none(), left: none(), right: none(), bottom: line() } : allBorders(line());
      if (inStruct) Object.defineProperty(b, 'keep', { value: true });
      out.push(questionRowTable(el, ctx, env, b)); return;
    }
    if (cls.contains('question-line')) {
      const kids = Array.from(el.children);
      const txt = kids.filter(k => !k.classList.contains('marks')), mk = kids.find(k => k.classList.contains('marks'));
      const w1 = CONTENT_W - 1900;
      const cell = (els, w, align) => new D.TableCell({
        width: { size: w, type: D.WidthType.DXA }, borders: allBorders(none()),
        children: [para(els.flatMap(e => inlineKids(e, ctx, { bold: true }, env)), ctx, { align, after: 0 })]
      });
      out.push(new D.Table({
        rows: [new D.TableRow({ cantSplit: true, children: [cell(txt, w1), cell(mk ? [mk] : [], 1900, 'end')] })],
        width: { size: CONTENT_W, type: D.WidthType.DXA }, columnWidths: [w1, 1900], layout: D.TableLayoutType.FIXED,
        visuallyRightToLeft: ctx.rtl || undefined, margins: { top: 60, bottom: 60, left: 80, right: 80 },
        borders: { ...allBorders(none()), insideHorizontal: none(), insideVertical: none() }
      }));
      return;
    }
    if (cls.contains('mcq-box')) {
      const row = Array.from(el.children).find(c => c.classList.contains('mcq-question-row'));
      const opt = Array.from(el.children).find(c => c.tagName.toLowerCase() === 'table' && c.classList.contains('mcq-options-table'));
      const t = row && opt ? mcqBoxTable(row, opt, ctx, env) : null;
      if (t) {
        out.push(t);
        Array.from(el.children).filter(c => c !== row && c !== opt).forEach(c => block(c, ctx, env, out, st));
        out.push(spacer());
        return;
      }
    }
    if (cls.contains('answer-box') || cls.contains('matching-key') || cls.contains('diagram-note') || cls.contains('objective-box')) {
      const b = line('777777');
      out.push(para(inlineKids(el, ctx, st, env), ctx, { border: allBorders({ ...b, space: 3 }), before: 80, after: 100, indent: { left: 100, right: 100 } }));
      return;
    }
    if (/^h[1-4]$/.test(tag)) {
      const size = tag === 'h1' ? SZ.h1 : tag === 'h2' ? SZ.h2 : SZ.h3;
      out.push(headingPara(el, ctx, env, size)); return;
    }
    if (cls.contains('kp-head')) {
      out.push(para(inlineKids(el, ctx, { bold: true }, env), ctx, { shading: { type: D.ShadingType.CLEAR, fill: 'EEEEEE', color: 'auto' }, before: 80, after: 0, keepNext: true }));
      return;
    }
    if (cls.contains('kp-note')) { out.push(para(inlineKids(el, ctx, { italics: true, size: SZ.small }, env), ctx, { before: 40, after: 100 })); return; }
    if (cls.contains('student-answer-label')) { out.push(para(inlineKids(el, ctx, { bold: true }, env), ctx, { before: 60, after: 20, keepNext: true })); return; }
    if (cls.contains('passage-title')) { out.push(para(inlineKids(el, ctx, { bold: true }, env), ctx, { align: 'center', after: 100 })); return; }
    if (cls.contains('fill-instruction') || cls.contains('key-label')) { out.push(para(inlineKids(el, ctx, { bold: true }, env), ctx, { before: 80, after: 80, keepNext: true })); return; }
    if (tag === 'li') { out.push(para([textRun('• ', { rtl: ctx.rtl }), ...inlineKids(el, ctx, st, env)], ctx)); return; }
    if (tag === 'p') {
      const align = ctx.align || (el.closest('.passage-body') ? 'justify' : undefined);
      const o = { align };
      if (cls.contains('muted')) st = { ...st, italics: true };
      out.push(para(inlineKids(el, ctx, st, env), ctx, o)); return;
    }
    if (cls.contains('paper-head')) {
      const sub = blocksFromChildren(el, { ...ctx, align: 'center' }, env, st);
      if (sub.length) {
        // bottom rule under the header block
        sub.push(new D.Paragraph({ spacing: { before: 0, after: 120, line: 60, lineRule: D.LineRuleType.EXACT }, children: [], border: { bottom: { style: D.BorderStyle.SINGLE, size: 12, color: '000000', space: 1 } } }));
        out.push(...sub);
      }
      return;
    }
    // generic container: just walk through it
    out.push(...blocksFromChildren(el, ctx, env, st));
  }

  // ---------------------------------------------------------------- public API
  // parts: DOM elements (already cloned). Returns a Blob (.docx).
  async function buildExamDocx(parts, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    parts.forEach(p => wrap.appendChild(p));
    wrap.querySelectorAll('.no-print').forEach(x => x.remove());
    const images = await prepareImages(wrap);
    const env = { images };
    const rtlRoot = !!wrap.querySelector('[dir="rtl"]');
    const children = [];
    parts.forEach((p, i) => {
      if (i > 0) children.push(new D.Paragraph({ children: [new D.PageBreak()], spacing: { before: 0, after: 0 } }));
      const ctx = { rtl: p.getAttribute && p.getAttribute('dir') === 'rtl' };
      children.push(...blocksFromChildren(p, ctx, env, {}));
    });
    const blocks = separateTables(children);
    if (!blocks.length || blocks[blocks.length - 1] instanceof D.Table) blocks.push(emptyPara());
    const footer = new D.Footer({ children: [new D.Paragraph({
      alignment: D.AlignmentType.CENTER,
      children: [new D.TextRun({ children: [D.PageNumber.CURRENT, ' / ', D.PageNumber.TOTAL_PAGES], font: FONT, size: 18, color: '666666' })]
    })] });
    const doc = new D.Document({
      creator: 'GHDD Assessment Pro', title: opts.title || 'Exam',
      styles: { default: { document: { run: { font: FONT, size: SZ.body }, paragraph: { spacing: { after: 60, line: 276 } } } } },
      sections: [{
        properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
        footers: { default: footer },
        children: blocks
      }]
    });
    return D.Packer.toBlob(doc);
  }
  window.buildExamDocx = buildExamDocx;
  window.GHDD_DOCX_VERSION = 'r22';
})();
