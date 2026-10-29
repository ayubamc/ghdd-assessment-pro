/* Muuqaalka natiijada ardayga (bogga dadweynaha iyo maamulka labadaba) */
(function (root) {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ord = (n) => (n == null ? '–' : n + (n === 1 ? 'aad' : 'aad'));

  function scoreCell(s) {
    if (s.code === 'ABS') return '<span class="chip warn">Maqan</span>';
    if (s.code === 'X') return '<span class="chip bad">La hakiyay</span>';
    return s.score == null ? '–' : esc(s.score);
  }

  function render(p, opts) {
    opts = opts || {};
    const st = p.student, r = p.result, ex = p.exam, a = p.advice;
    const tone = r.tone;
    const weakList = r.weak.map((w) => `<li><b>${esc(w.name)}</b> (${w.code === 'ABS' ? 'Maqan' : esc(w.score)})</li>`).join('');
    const strongList = r.strong.map((w) => `<li><b>${esc(w.name)}</b> (${esc(w.score)})</li>`).join('');
    const rows = r.scores.map((s, i) => {
      const low = s.code === 'ABS' || (s.score != null && s.pass === false);
      return `<tr class="${low ? 'low' : ''}"><td class="n muted">${i + 1}</td><td>${esc(s.name)}</td><td class="sc">${scoreCell(s)}</td><td class="gr">${s.grade ? `<b>${esc(s.grade)}</b>` : '–'}</td><td>${s.pass === true ? '<span class="chip good">Gudbay</span>' : s.pass === false ? '<span class="chip bad">Ka dhacay</span>' : ''}</td></tr>`;
    }).join('');
    const gradeKey = (ex.grades || []).map((g, i, arr) => `<b>${esc(g.g)}</b> ${g.min}–${i === 0 ? 100 : arr[i - 1].min - 1}`).join(' · ');
    const sat = r.status === 'PASS' || r.status === 'FAIL';
    return `
<div class="result-sheet">
  <div class="rs-head">
    <div class="org">${esc(ex.orgName)}</div>
    <h2>${esc(ex.examTitle)} – ${esc(st.year)}</h2>
    <div class="small" style="opacity:.85;margin-top:4px">WARQADDA NATIIJADA ARDAYGA</div>
  </div>
  <div class="rs-body">
    <div class="rs-id">
      <div><small>Roll Number</small><b class="mono">${esc(st.roll)}</b></div>
      <div><small>Jinsiga</small><b>${esc(st.gender || '–')}</b></div>
      <div class="wide"><small>Magaca ardayga</small><b>${esc(st.name)}</b></div>
      <div class="wide"><small>Magaca hooyada</small><b>${esc(st.mother)}</b></div>
      <div class="wide"><small>Dugsiga</small><b>${esc(st.school)}</b></div>
    </div>
    <div class="verdict ${tone}">
      <div>
        <div class="small muted">Go'aanka natiijada</div>
        <div class="big">${esc(r.statusLabel)}</div>
        ${sat && r.grade ? `<div class="small">Grade guud: <b>${esc(r.grade)}</b> – ${esc(r.gradeLabel)}</div>` : ''}
      </div>
      ${sat ? `<div class="nums"><div class="small muted">Wadarta</div><b>${esc(r.total)}</b><span class="muted"> / ${esc(r.max)}</span><div class="small">Celcelis: <b>${esc(r.avg)}%</b></div></div>` : ''}
    </div>
    ${r.rankAll ? `<div class="rank-row">
      <div class="stat"><div class="v">${ord(r.rankSchool)}</div><div class="l">Kaalinta dugsiga (${esc(r.countSchool)} arday)</div></div>
      <div class="stat"><div class="v">${ord(r.rankAll)}</div><div class="l">Kaalinta guud (${esc(r.countAll)} arday)</div></div>
    </div>` : ''}
    <div class="tbl-wrap"><table class="tbl subj-tbl">
      <thead><tr><th class="n">#</th><th>Maaddada</th><th style="text-align:center">Dhibcaha</th><th style="text-align:center">Grade</th><th>Xaaladda</th></tr></thead>
      <tbody>${rows}</tbody>
      ${sat ? `<tfoot><tr><td></td><td><b>Wadarta</b></td><td class="sc">${esc(r.total)} / ${esc(r.max)}</td><td class="gr"><b>${esc(r.grade || '')}</b></td><td><b>${esc(r.avg)}%</b></td></tr></tfoot>` : ''}
    </table></div>
    ${sat ? `<div class="advice">
      <h3>Talo iyo tilmaan</h3>
      <p>${esc(a.message)}</p>
      ${strongList ? `<h3>${esc(a.strongTitle)}</h3><ul>${strongList}</ul>` : ''}
      ${weakList ? `<h3>${esc(a.weakTitle)}</h3><ul>${weakList}</ul>` : ''}
      ${a.parentNote ? `<div class="note">${esc(a.parentNote)}</div>` : ''}
    </div>` : r.status === 'WITHHELD' ? `<div class="banner warn" style="margin-top:14px">Natiijadan waa la hakiyay. Fadlan la xiriir xafiiska ${esc(ex.orgShort || 'GHDD')}.</div>` : ''}
    <div class="grade-key">Nidaamka grade-ka: ${gradeKey}. Dhibcaha gudbitaanka maaddo: ${esc(ex.passMark)}%.</div>
    ${opts.footer || ''}
  </div>
</div>`;
  }

  root.ResultView = { render, esc };
})(typeof self !== 'undefined' ? self : this);
