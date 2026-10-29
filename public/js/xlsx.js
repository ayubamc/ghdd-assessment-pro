/* Akhriska iyo qorista faylasha Excel (.xlsx) – waxay isticmaashaa JSZip (vendor/jszip.min.js), offline ayay shaqaysaa. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('jszip'));
  else root.XLSX = factory(root.JSZip);
})(typeof self !== 'undefined' ? self : this, function (JSZip) {
  'use strict';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    // xarfaha aan XML-ka u bannaanayn ka saar
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const unesc = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k];
  });
  function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function colIndex(ref) { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

  // sheets: [{name, rows: [[...]], widths: [..], header: true, freeze: true}]
  async function write(sheets) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(String(s.name).slice(0, 31).replace(/[\\/?*[\]:]/g, ' '))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
    zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="12"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1C5CAB"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF3FA"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFC9D3E0"/></left><right style="thin"><color rgb="FFC9D3E0"/></right><top style="thin"><color rgb="FFC9D3E0"/></top><bottom style="thin"><color rgb="FFC9D3E0"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
    sheets.forEach((s, si) => {
      const rows = s.rows || [];
      const header = s.header !== false;
      let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`;
      if (header && s.freeze !== false && rows.length) xml += `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
      if (s.widths) xml += `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
      xml += '<sheetData>';
      rows.forEach((r, ri) => {
        const style = header && ri === 0 ? 1 : s.plain ? 0 : 2;
        xml += `<row r="${ri + 1}">`;
        r.forEach((v, ci) => {
          if (v === null || v === undefined || v === '') { if (style !== 0) xml += `<c r="${colName(ci)}${ri + 1}" s="${(s.shade && s.shade(ri, ci)) ? 3 : style}"/>`; return; }
          const ref = `${colName(ci)}${ri + 1}`;
          const st = (header && ri === 0) ? 1 : (s.titleRows && s.titleRows.includes(ri)) ? 4 : (s.shade && s.shade(ri, ci)) ? 3 : style;
          if (typeof v === 'number' && isFinite(v)) xml += `<c r="${ref}" s="${st}"><v>${v}</v></c>`;
          else xml += `<c r="${ref}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        });
        xml += '</row>';
      });
      xml += '</sheetData>';
      if (header && s.filter && rows.length) xml += `<autoFilter ref="A1:${colName(rows[0].length - 1)}${rows.length}"/>`;
      xml += '</worksheet>';
      zip.file(`xl/worksheets/sheet${si + 1}.xml`, xml);
    });
    const type = typeof window !== 'undefined' ? 'blob' : 'nodebuffer';
    return zip.generateAsync({ type, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE' });
  }

  // Wuxuu soo celinayaa [{name, rows: [[...]]}]
  async function read(buf) {
    const zip = await JSZip.loadAsync(buf);
    const text = async (p) => { const f = zip.file(p); return f ? f.async('string') : null; };
    const wb = await text('xl/workbook.xml');
    if (!wb) throw new Error('Faylkani ma aha Excel (.xlsx) sax ah');
    const rels = (await text('xl/_rels/workbook.xml.rels')) || '';
    const relMap = {};
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = (m[0].match(/\bId="([^"]+)"/) || [])[1], target = (m[0].match(/\bTarget="([^"]+)"/) || [])[1];
      if (id && target) relMap[id] = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    }
    const shared = [];
    const ss = await text('xl/sharedStrings.xml');
    if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unesc(x[1])).join(''));
    }
    const out = [];
    for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
      const name = unesc((m[0].match(/\bname="([^"]*)"/) || [])[1] || 'Sheet');
      const rid = (m[0].match(/\br:id="([^"]+)"/) || m[0].match(/\bid="([^"]+)"/) || [])[1];
      const xml = await text('xl/' + (relMap[rid] || `worksheets/sheet${out.length + 1}.xml`));
      if (!xml) continue;
      const rows = [];
      for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const rnum = Number((rm[1].match(/\br="(\d+)"/) || [])[1] || rows.length + 1) - 1;
        const row = [];
        for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = cm[1], inner = cm[2] || '';
          const ref = (attrs.match(/\br="([A-Z]+)\d*"/) || [])[1];
          const ci = ref ? colIndex(ref) : row.length;
          const t = (attrs.match(/\bt="(\w+)"/) || [])[1];
          const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          let val = null;
          if (t === 's') val = v != null ? shared[Number(v)] : null;
          else if (t === 'inlineStr') val = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unesc(x[1])).join('');
          else if (t === 'str' || t === 'e') val = v != null ? unesc(v) : null;
          else if (t === 'b') val = v === '1';
          else if (v != null) { const n = Number(v); val = isFinite(n) ? n : unesc(v); }
          row[ci] = val;
        }
        rows[rnum] = row;
      }
      for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
      out.push({ name, rows });
    }
    return out;
  }

  function parseCsv(textIn) {
    const t = textIn.replace(/^﻿/, '');
    const delim = (t.split('\n')[0].match(/;/g) || []).length > (t.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return [{ name: 'CSV', rows: rows.map((r) => r.map((v) => { const s = v.trim(); return s !== '' && isFinite(Number(s)) ? Number(s) : s; })) }];
  }

  async function readFile(file) {
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.csv')) return parseCsv(await file.text());
    if (name.endsWith('.xls')) throw new Error('Faylka .xls (Excel-kii hore) lama taageero. Fadlan ku kaydi .xlsx (Save As → Excel Workbook).');
    return read(await file.arrayBuffer());
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  return { write, read, readFile, parseCsv, download, colName };
});
