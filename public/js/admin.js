/* GHDD – Maamulka natiijada (online + offline) */
(function () {
  'use strict';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const view = $('#view');

  const LS = {
    get(k, d) { try { const v = localStorage.getItem('ghdd.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('ghdd.' + k, JSON.stringify(v)); return true; } catch (_) { return false; } },
    del(k) { try { localStorage.removeItem('ghdd.' + k); } catch (_) { /* */ } }
  };

  const S = {
    token: LS.get('token', null),
    data: null,
    marks: new Map(),
    pending: LS.get('pending', []),
    tab: LS.get('tab', 'guud'),
    f: Object.assign({ school: '', q: '', mschool: '', msub: '', mmode: 'maaddo', aschool: '', rq: '', rsort: 'rank' }, LS.get('filters', {})),
    v: 0, calc: null, calcV: -1, ana: null, anaKey: '',
    syncing: false, syncErr: null, online: navigator.onLine
  };
  const saveFilters = () => LS.set('filters', S.f);

  // ---------- caawiyeyaal ----------
  let toastT;
  function toast(msg, bad) {
    let t = $('.toast'); if (!t) { t = document.createElement('div'); document.body.appendChild(t); }
    t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg;
    clearTimeout(toastT); toastT = setTimeout(() => t.remove(), bad ? 5200 : 2800);
  }
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (S.token || '') }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { const err = new Error('Internet ma jiro. Isku day mar kale marka internet-ku soo laabto.'); err.offline = true; throw err; }
    let data = {};
    try { data = await res.json(); } catch (_) { /* */ }
    if (res.status === 401 && path !== '/api/login') { logout(true); throw new Error(data.error || 'Fadlan mar kale gal.'); }
    if (!res.ok) { const err = new Error(data.error || 'Cillad: ' + res.status); err.status = res.status; err.data = data; throw err; }
    return data;
  }
  function modal(title, html, opts) {
    opts = opts || {};
    const bg = document.createElement('div');
    bg.className = 'modal-bg no-print';
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="${opts.wide ? 'max-width:960px' : ''}"><div class="modal-head"><h2>${esc(title)}</h2><button class="x" aria-label="Xir">×</button></div><div class="modal-body">${html}</div></div>`;
    document.body.appendChild(bg);
    document.body.style.overflow = 'hidden';
    const close = () => { bg.remove(); if (!$('.modal-bg')) document.body.style.overflow = ''; if (opts.onClose) opts.onClose(); };
    $('.x', bg).onclick = close;
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    return { el: $('.modal-body', bg), close, root: bg };
  }
  const sel = (items, value, empty) => (empty ? `<option value="">${esc(empty)}</option>` : '') + items.map((i) => `<option value="${esc(i.v)}" ${String(i.v) === String(value) ? 'selected' : ''}>${esc(i.t)}</option>`).join('');
  const schoolOpts = (value, empty) => sel(S.data.schools.map((s) => ({ v: s.id, t: s.name })), value, empty);
  const schoolName = (id) => (S.data.schools.find((s) => s.id === Number(id)) || {}).name || '–';
  const activeSubjects = () => S.data.subjects.filter((s) => s.active).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const studentsOfYear = () => S.data.students.filter((s) => s.exam_year === S.data.settings.examYear);
  const publicBase = () => (S.data.settings.publicUrl || location.origin).replace(/\/+$/, '');
  const fmtMark = (m) => (!m ? '' : m.code === 'ABS' ? 'M' : m.code === 'X' ? 'X' : String(m.score));
  const dateStr = (iso) => { try { return new Date(iso).toLocaleString('so-SO', { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return iso; } };
  function bump() { S.v++; }

  // ---------- xogta / offline ----------
  function buildMarks() {
    S.marks = new Map();
    for (const m of S.data.marks) S.marks.set(m[0] + ':' + m[1], { score: m[2], code: m[3] });
    for (const p of S.pending) applyLocal(p[0], p[1], p[2]);
    bump();
  }
  function applyLocal(sid, sub, val) {
    const k = sid + ':' + sub;
    if (val === null) S.marks.delete(k);
    else if (val === 'ABS' || val === 'X') S.marks.set(k, { score: null, code: val });
    else S.marks.set(k, { score: Number(val), code: null });
  }
  function marksArray() { const out = []; for (const [k, m] of S.marks) { const [a, b] = k.split(':'); out.push([Number(a), Number(b), m.score, m.code]); } return out; }
  function calcData() { return { settings: S.data.settings, schools: S.data.schools, subjects: S.data.subjects, students: S.data.students, marks: marksArray() }; }
  function computed() {
    if (S.calcV !== S.v) { S.calc = Calc.computeAll(calcData()); S.calcV = S.v; }
    return S.calc;
  }
  function analytics(schoolId) {
    const key = S.v + ':' + (schoolId || '');
    if (S.anaKey !== key) { S.ana = Calc.analytics(calcData(), { schoolId: schoolId || null }); S.anaKey = key; }
    return S.ana;
  }
  function saveCache() {
    const d = Object.assign({}, S.data, { marks: S.data.marks });
    if (!LS.set('data', d)) toast('Kaydka telefoonka waa buuxaa – xogta offline si buuxda looma kaydin.', true);
  }

  function setMark(sid, sub, val, source) {
    applyLocal(sid, sub, val);
    S.pending = S.pending.filter((p) => !(p[0] === sid && p[1] === sub));
    S.pending.push([sid, sub, val, source || 'gacan']);
    LS.set('pending', S.pending);
    bump();
    updateSync();
    scheduleFlush();
  }
  let flushT;
  function scheduleFlush(ms) { clearTimeout(flushT); flushT = setTimeout(flush, ms == null ? 1200 : ms); }
  async function flush() {
    if (S.syncing || !S.pending.length || !navigator.onLine || !S.token) { updateSync(); return; }
    S.syncing = true; updateSync();
    try {
      while (S.pending.length) {
        const batch = S.pending.slice(0, 2000);
        const src = batch.some((b) => b[3] === 'excel') ? 'excel' : 'gacan';
        const out = await api('POST', '/api/admin/marks', { changes: batch.map((b) => [b[0], b[1], b[2]]), source: src });
        // ka saar kuwii la diray (haddii aan dib loo beddelin intii la dirayay)
        const sent = new Set(batch.map((b) => b.join('|')));
        S.pending = S.pending.filter((p) => !sent.has(p.join('|')));
        LS.set('pending', S.pending);
        const base = new Map(S.data.marks.map((x) => [x[0] + ':' + x[1], x]));
        for (const m of batch) {
          const k = m[0] + ':' + m[1];
          if (m[2] === null) base.delete(k);
          else base.set(k, [m[0], m[1], m[2] === 'ABS' || m[2] === 'X' ? null : Number(m[2]), m[2] === 'ABS' || m[2] === 'X' ? m[2] : null]);
        }
        S.data.marks = Array.from(base.values());
        saveCache();
        if (out.errors && out.errors.length) toast(`${out.errors.length} dhibic lama kaydin (arday la joojiyay ama qiime khaldan).`, true);
      }
      S.syncErr = null;
    } catch (e) {
      S.syncErr = e.offline ? null : e.message;
      if (e.status === 423) toast(e.message, true);
      else if (!e.offline) toast('Isku-xidhka: ' + e.message, true);
      scheduleFlush(15000);
    } finally { S.syncing = false; updateSync(); }
  }
  function updateSync() {
    const b = $('#sync'); if (!b || !S.data) return;
    const n = S.pending.length;
    b.classList.remove('hidden', 'off', 'err');
    let txt;
    if (!navigator.onLine) { b.classList.add('off'); txt = n ? `Offline · ${n} sugaya` : 'Offline'; }
    else if (S.syncErr) { b.classList.add('err'); txt = `Cillad · ${n} sugaya`; }
    else if (S.syncing) { b.classList.add('off'); txt = `Waa la dirayaa ${n}…`; }
    else txt = n ? `${n} sugaya` : 'Online · la kaydiyay';
    $('span', b).textContent = txt;
  }
  window.addEventListener('online', () => { S.online = true; updateSync(); flush().then(refresh); });
  window.addEventListener('offline', () => { S.online = false; updateSync(); });
  $('#sync').onclick = () => {
    if (!navigator.onLine) return toast(`Offline ayaad tahay. ${S.pending.length} isbeddel ayaa telefoonka ku kaydsan; marka internet-ku yimaado si toos ah ayay u baxayaan.`);
    flush().then(refresh);
  };

  async function refresh() {
    if (!navigator.onLine) return;
    try {
      await flush();
      const d = await api('GET', '/api/admin/bootstrap');
      S.data = d; buildMarks(); saveCache();
      S.defaultPw = d.defaultPw;
      render();
    } catch (e) { if (!e.offline) toast(e.message, true); }
  }

  // ---------- login ----------
  function logout(expired) {
    S.token = null; LS.del('token');
    $('#tabs').classList.add('hidden'); $('#sync').classList.add('hidden');
    showLogin(expired ? 'Fadlan mar kale gal (login).' : '');
  }
  function showLogin(msg) {
    view.innerHTML = `<div class="center-card">
      <div class="hero"><div class="seal">GHDD</div><h1>Maamulka Natiijada</h1><p class="muted">Gal si aad u maamusho ardayda, dhibcaha iyo falanqaynta.</p></div>
      ${msg ? `<div class="banner warn">${esc(msg)}</div>` : ''}
      <form class="card" id="lf"><label class="f"><span>Furaha sirta ah (password)</span><input type="password" id="pw" autocomplete="current-password" required></label>
      <button class="btn primary block" id="lb">Gal</button><div id="le"></div></form>
      <p class="small muted" style="text-align:center"><a href="/natiijo">Bogga natiijada ardayda →</a></p></div>`;
    $('#lf').onsubmit = async (e) => {
      e.preventDefault(); $('#lb').disabled = true;
      try {
        const r = await api('POST', '/api/login', { password: $('#pw').value });
        S.token = r.token; LS.set('token', r.token);
        await start();
      } catch (err) { $('#le').innerHTML = `<div class="banner bad" style="margin:10px 0 0">${esc(err.message)}</div>`; }
      finally { const b = $('#lb'); if (b) b.disabled = false; }
    };
    $('#pw').focus();
  }

  async function start() {
    const cached = LS.get('data', null);
    if (cached && cached.settings) { S.data = cached; buildMarks(); render(); }
    else view.innerHTML = '<div class="card"><p class="muted">Xogta waa la soo rarayaa…</p></div>';
    $('#tabs').classList.remove('hidden');
    if (navigator.onLine) await refresh();
    else if (!S.data) view.innerHTML = '<div class="banner warn">Internet ma jiro, xog hore oo telefoonkan ku kaydsanna ma jirto. Mar kale isku day marka internet-ku yimaado.</div>';
    updateSync();
  }

  // ---------- navigation ----------
  $$('#tabs button').forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; LS.set('tab', S.tab); render(); window.scrollTo(0, 0); }));
  function render() {
    if (!S.data) return;
    const st = S.data.settings;
    $('#hdr-title').textContent = 'Maamulka Natiijada – ' + (st.orgShort || 'GHDD');
    $('#hdr-sub').textContent = st.examTitle + ' · ' + st.examYear;
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
    const fn = { guud: renderHome, arday: renderStudents, dhibco: renderMarks, falanqayn: renderAnalytics, dejin: renderSettings }[S.tab] || renderHome;
    fn();
    updateSync();
  }
  const go = (tab) => { S.tab = tab; LS.set('tab', tab); render(); window.scrollTo(0, 0); };

  // ======================================================================
  // GUUD (dashboard)
  // ======================================================================
  function renderHome() {
    const st = S.data.settings;
    const C = computed();
    const subs = activeSubjects();
    const studs = C.results;
    const totalCells = studs.length * subs.length;
    const filled = studs.reduce((a, r) => a + r.entered, 0);
    const complete = studs.filter((r) => r.status !== 'INCOMPLETE').length;
    const sat = studs.filter((r) => r.sat), passed = sat.filter((r) => r.status === 'PASS');
    const pctFill = totalCells ? Math.round((filled / totalCells) * 100) : 0;
    const bySchool = S.data.schools.map((sc) => {
      const l = studs.filter((r) => r.schoolId === sc.id);
      const f = l.reduce((a, r) => a + r.entered, 0), t = l.length * subs.length;
      return { sc, n: l.length, pct: t ? Math.round((f / t) * 100) : 0, done: l.filter((r) => r.status !== 'INCOMPLETE').length };
    });
    const bySub = subs.map((sub) => {
      const f = studs.filter((r) => r.scores.find((s) => s.subjectId === sub.id && (s.score != null || s.code))).length;
      return { sub, f, pct: studs.length ? Math.round((f / studs.length) * 100) : 0 };
    });
    const bar = (p) => `<div class="progress ${p >= 100 ? 'done' : ''}"><i style="width:${p}%"></i></div>`;
    view.innerHTML = `
      ${S.data.dbKind === 'sqlite' && !/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname) ? `<div class="banner bad"><b>Digniin:</b> Server-kan weli laguma xirin database joogto ah (DATABASE_URL). Xogta waxaa lagu kaydiyay si ku meel gaar ah – waxay lumi kartaa marka server-ka dib loo bilaabo. Ka hor intaadan gelin natiijada rasmiga ah, ku xir database-ka; ka dibna soo deji kayd (Dejin → Kayd).</div>` : ''}
      ${S.defaultPw ? `<div class="banner warn"><b>Amni:</b> Weli waxaad isticmaalaysaa furaha hore (default). Ka beddel qaybta <a href="#" data-go="dejin">Dejinta</a>.</div>` : ''}
      ${st.released ? `<div class="banner good"><b>Natiijada waa la sii daayay</b> (${esc(dateStr(st.releasedAt))}). Ardaydu waxay ka eegi karaan: <a href="${esc(publicBase())}/natiijo" target="_blank">${esc(publicBase())}/natiijo</a></div>`
        : `<div class="banner info"><b>Natiijada weli lama sii dayn.</b> Ardaydu ma arki karaan ilaa aad ka sii dayso qaybta Dejinta.</div>`}
      ${st.locked ? '<div class="banner warn"><b>Natiijada waa xiran tahay</b> – dhibco lama beddeli karo.</div>' : ''}
      <div class="grid g4" style="margin-bottom:14px">
        <div class="stat"><div class="v">${S.data.schools.length}</div><div class="l">Dugsiyo</div></div>
        <div class="stat"><div class="v">${studs.length}</div><div class="l">Arday diiwaangashan (${st.examYear})</div></div>
        <div class="stat"><div class="v">${pctFill}%</div><div class="l">Dhibcaha la geliyay (${filled}/${totalCells})</div></div>
        <div class="stat ${sat.length ? 'good' : ''}"><div class="v">${sat.length ? Math.round((passed.length / sat.length) * 100) + '%' : '–'}</div><div class="l">Gudbay (${passed.length}/${sat.length})</div></div>
      </div>
      <div class="card"><div class="card-head"><h2>Ficilo degdeg ah</h2></div>
        <div class="row">
          <button class="btn primary" data-act="add">+ Arday cusub</button>
          <button class="btn" data-act="import">Ardayda Excel ka soo geli</button>
          <button class="btn" data-go="dhibco">Geli dhibcaha</button>
          <button class="btn" data-act="mexcel">Natiijo Excel ka soo geli</button>
          <button class="btn" data-act="cards">Daabac Passcard</button>
          <button class="btn" data-go="falanqayn">Falanqaynta</button>
        </div>
      </div>
      <div class="grid g2 stack">
        <div class="card"><h2>Horumarka dugsiyada</h2>
          ${bySchool.map((b) => `<div style="margin-bottom:12px"><div class="row" style="justify-content:space-between"><b>${esc(b.sc.name)}</b><span class="small muted">${b.n} arday · ${b.done} dhammaystiran · ${b.pct}%</span></div>${bar(b.pct)}</div>`).join('') || '<p class="muted">Dugsi lama diiwaangelin. Ka dar qaybta Dejinta.</p>'}
        </div>
        <div class="card"><h2>Horumarka maaddooyinka</h2>
          ${bySub.map((b) => `<div style="margin-bottom:9px"><div class="row" style="justify-content:space-between"><span>${esc(b.sub.name)}</span><span class="small muted">${b.f}/${studs.length}</span></div>${bar(b.pct)}</div>`).join('')}
        </div>
      </div>
      <p class="small muted">Natiijo dhammaystiran: ${complete} arday. Kaydka: ${S.data.dbKind === 'postgres' ? 'Database online' : 'Kombiyuutar maxalli ah'}.</p>`;
    bindCommon();
  }
  function bindCommon() {
    $$('[data-go]', view).forEach((a) => (a.onclick = (e) => { e.preventDefault(); go(a.dataset.go); }));
    $$('[data-act]', view).forEach((a) => (a.onclick = () => ({ add: addStudent, import: importStudents, cards: cardsDialog, mexcel: () => { S.f.mmode = 'excel'; saveFilters(); go('dhibco'); } })[a.dataset.act]()));
  }

  // ======================================================================
  // ARDAYDA
  // ======================================================================
  function renderStudents() {
    const C = computed();
    view.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Ardayda</h2>
          <div class="row"><button class="btn primary sm" data-act="add">+ Arday cusub</button><button class="btn sm" data-act="import">Excel ka soo geli</button><button class="btn sm" data-act="cards">Passcard</button></div></div>
        <div class="row" style="margin-bottom:6px">
          <select id="fs" class="grow">${schoolOpts(S.f.school, 'Dhammaan dugsiyada')}</select>
          <input id="fq" class="grow" placeholder="Raadi magac ama roll number…" value="${esc(S.f.q)}">
        </div>
        <div id="slist" class="list"></div>
      </div>`;
    bindCommon();
    const draw = () => {
      const q = S.f.q.trim().toLowerCase();
      let list = S.data.students.filter((s) => (!S.f.school || s.school_id === Number(S.f.school)) && (!q || s.roll_no.includes(q) || s.full_name.toLowerCase().includes(q) || (s.mother_name || '').toLowerCase().includes(q)));
      list = list.sort((a, b) => (a.status === b.status ? a.roll_no.localeCompare(b.roll_no) : a.status === 'active' ? -1 : 1));
      const shown = list.slice(0, S.showN || 150);
      $('#slist').innerHTML = (shown.map((s) => {
        const r = C.byId.get(s.id);
        const chip = s.status !== 'active' ? '<span class="chip muted">La joojiyay</span>' : s.exam_year !== S.data.settings.examYear ? `<span class="chip muted">${s.exam_year}</span>` : r ? `<span class="chip ${Calc.STATUS[r.status].tone}">${r.status === 'INCOMPLETE' ? `${r.entered}/${r.nSub}` : esc(Calc.STATUS[r.status].label)}</span>` : '';
        return `<div class="item" data-id="${s.id}"><span class="roll">${esc(s.roll_no)}</span><div class="who"><b>${esc(s.full_name)}</b><small>Hooyo: ${esc(s.mother_name)} · ${esc(schoolName(s.school_id))}</small></div>${chip}</div>`;
      }).join('') || '<p class="muted" style="padding:10px 4px">Arday lama helin.</p>') +
        (list.length > shown.length ? `<button class="btn block" id="more" style="margin-top:8px">Muuji ${Math.min(150, list.length - shown.length)} kale (${list.length} wadar)</button>` : `<p class="small muted" style="margin:10px 4px 0">${list.length} arday</p>`);
      $$('.item', $('#slist')).forEach((it) => (it.onclick = () => openStudent(Number(it.dataset.id))));
      const m = $('#more'); if (m) m.onclick = () => { S.showN = (S.showN || 150) + 150; draw(); };
    };
    $('#fs').onchange = (e) => { S.f.school = e.target.value; S.showN = 150; saveFilters(); draw(); };
    $('#fq').oninput = (e) => { S.f.q = e.target.value; S.showN = 150; saveFilters(); draw(); };
    draw();
  }

  function studentForm(s) {
    s = s || {};
    return `
      <label class="f"><span>Dugsiga</span><select name="school_id" required>${schoolOpts(s.school_id || S.f.school || (S.data.schools[0] || {}).id, 'Dooro dugsiga')}</select></label>
      <label class="f"><span>Magaca ardayga (afar magac)</span><input name="full_name" required value="${esc(s.full_name || '')}" placeholder="Tusaale: Cabdiraxmaan Maxamed Cali Xasan" autocomplete="off"></label>
      <label class="f"><span>Magaca hooyada (oo buuxa)</span><input name="mother_name" required value="${esc(s.mother_name || '')}" placeholder="Tusaale: Faadumo Cabdi Warsame" autocomplete="off"></label>
      <div class="grid g2">
        <label class="f"><span>Jinsiga</span><select name="gender" required>${sel([{ v: 'Wiil', t: 'Wiil' }, { v: 'Gabar', t: 'Gabar' }], s.gender, 'Dooro')}</select></label>
        <label class="f"><span>Taleefanka waalidka</span><input name="parent_phone" type="tel" inputmode="tel" required value="${esc(s.parent_phone || '')}" placeholder="061xxxxxxx"></label>
      </div>`;
  }
  const formData = (form) => Object.fromEntries(new FormData(form).entries());

  function addStudent() {
    if (!S.data.schools.length) return toast('Marka hore dugsi ku dar (Dejin → Dugsiyada).', true);
    const m = modal('Arday cusub', `<form id="af">${studentForm()}<div id="ae"></div><button class="btn primary block">Diiwaangeli oo sii Roll Number</button><p class="small muted" style="margin-top:8px">Roll Number-ka nidaamka ayaa bixiya. Mar la siiyo arday, arday kale marnaba lama siin karo.</p></form>`);
    const f = $('#af', m.el);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const b = $('button', f); b.disabled = true;
      try {
        const body = formData(f);
        const r = await api('POST', '/api/admin/students', body);
        await refresh();
        m.el.innerHTML = `<div style="text-align:center;padding:10px 0">
          <div class="small muted">Waa la diiwaangeliyay</div><h2 style="margin:6px 0">${esc(r.student.full)}</h2>
          <div class="stat" style="max-width:260px;margin:10px auto"><div class="l">Roll Number</div><div class="v mono" style="font-size:2.2rem;color:var(--primary)">${esc(r.student.roll)}</div></div>
          <div class="row" style="justify-content:center"><button class="btn primary" id="again">+ Arday kale</button><button class="btn" id="pc">Daabac passcard-ka</button></div></div>`;
        $('#again', m.el).onclick = () => { m.close(); addStudent(); };
        $('#pc', m.el).onclick = () => printCards([S.data.students.find((s) => s.roll_no === r.student.roll)].filter(Boolean));
      } catch (err) {
        $('#ae', m.el).innerHTML = `<div class="banner ${err.status === 409 ? 'warn' : 'bad'}">${esc(err.message)}</div>`;
      } finally { b.disabled = false; }
    };
  }

  function buildPayload(st, r) {
    const ex = S.data.settings;
    const showRank = ex.showRank && r.sat;
    return {
      student: { roll: st.roll_no, name: st.full_name, mother: st.mother_name, school: schoolName(st.school_id), gender: st.gender, year: st.exam_year },
      result: {
        status: r.status, statusLabel: Calc.STATUS[r.status].label, tone: Calc.STATUS[r.status].tone,
        scores: r.scores, total: r.total, max: r.nSub * 100, avg: r.avg, grade: r.grade, gradeLabel: r.gradeLabel, failed: r.failed,
        weak: r.weak, strong: r.strong,
        rankSchool: showRank ? r.rankSchool : null, countSchool: showRank ? r.countSchool : null, rankAll: showRank ? r.rankAll : null, countAll: showRank ? r.countAll : null
      },
      advice: Calc.adviceFor(r, ex),
      exam: { orgName: ex.orgName, orgShort: ex.orgShort, examTitle: ex.examTitle, examYear: ex.examYear, passMark: ex.passMark, grades: Calc.withDefaults(ex).grades }
    };
  }
  function showResult(st) {
    const r = computed().byId.get(st.id);
    if (!r) return toast('Ardaygan sannadka imtixaanka hadda kuma jiro.', true);
    const m = modal('Natiijada ardayga', ResultView.render(buildPayload(st, r)) + '<div class="row no-print" style="margin-top:12px"><button class="btn primary" id="pr">Daabac</button></div>');
    $('#pr', m.el).onclick = () => {
      const area = $('#print-area');
      area.innerHTML = ResultView.render(buildPayload(st, r));
      document.body.classList.add('printing-cards');
      setTimeout(() => window.print(), 50);
    };
  }

  function openStudent(id) {
    const st = S.data.students.find((s) => s.id === id);
    if (!st) return;
    const locked = S.data.settings.locked;
    const subs = activeSubjects();
    const r = computed().byId.get(id);
    const m = modal(st.full_name, `
      <div class="row" style="margin-bottom:10px"><span class="chip blue mono" style="font-size:.9rem">${esc(st.roll_no)}</span>
        ${st.status !== 'active' ? '<span class="chip muted">La joojiyay</span>' : r ? `<span class="chip ${Calc.STATUS[r.status].tone}">${esc(Calc.STATUS[r.status].label)}</span>` : ''}
        <span class="spacer"></span><button class="btn sm" id="vr">Eeg natiijada</button><button class="btn sm" id="pc">Passcard</button></div>
      <p class="small muted" style="margin-bottom:12px">Hooyo: <b>${esc(st.mother_name)}</b> · ${esc(schoolName(st.school_id))} · ${esc(st.gender)} · Tel: ${esc(st.parent_phone)}</p>
      ${st.status === 'active' ? `<h3>Dhibcaha maaddooyinka</h3>
      ${locked ? '<div class="banner warn">Natiijada waa xiran tahay; dhibco lama beddeli karo.</div>' : '<p class="small muted">Geli 0–100. Riix <b>M</b> haddii ardaygu ka maqnaa imtixaanka maaddadaas.</p>'}
      <div class="marks-list">${subs.map((sub) => {
        const mk = S.marks.get(id + ':' + sub.id);
        return `<div class="mrow"><div class="who"><b>${esc(sub.name)}</b></div><input data-s="${id}" data-j="${sub.id}" inputmode="decimal" value="${esc(fmtMark(mk))}" ${locked ? 'disabled' : ''} class="${mk && mk.code === 'ABS' ? 'abs' : ''}"><button class="mbtn ${mk && mk.code === 'ABS' ? 'on' : ''}" data-abs="${sub.id}" ${locked ? 'disabled' : ''} title="Maqan">M</button></div>`;
      }).join('')}</div>` : ''}
      <details style="margin-top:16px"><summary class="btn sm">Wax ka beddel xogta ardayga</summary>
        <form id="ef" style="margin-top:12px">${studentForm(st)}<div id="ee"></div><button class="btn primary block">Kaydi isbeddelka</button></form>
      </details>
      <div class="row" style="margin-top:14px">${st.status === 'active'
        ? '<button class="btn danger sm" id="cx">Jooji ardayga</button><span class="small muted">Roll Number-ka lama tirtiro, dib looma isticmaalo.</span>'
        : '<button class="btn good sm" id="cx">Dib u celi ardayga</button>'}</div>
    `, { onClose: () => { if (S.tab !== 'guud') render(); } });
    $('#vr', m.el).onclick = () => showResult(st);
    $('#pc', m.el).onclick = () => printCards([st]);
    bindMarkInputs(m.el);
    $$('[data-abs]', m.el).forEach((b) => (b.onclick = () => {
      const inp = $(`input[data-j="${b.dataset.abs}"]`, m.el);
      const isAbs = b.classList.contains('on');
      setMark(id, Number(b.dataset.abs), isAbs ? null : 'ABS');
      b.classList.toggle('on', !isAbs); inp.value = isAbs ? '' : 'M'; inp.classList.toggle('abs', !isAbs);
    }));
    $('#ef', m.el).onsubmit = async (e) => {
      e.preventDefault();
      try { await api('PUT', '/api/admin/students/' + id, formData(e.target)); toast('Waa la kaydiyay'); m.close(); await refresh(); }
      catch (err) { $('#ee', m.el).innerHTML = `<div class="banner bad">${esc(err.message)}</div>`; }
    };
    $('#cx', m.el).onclick = async () => {
      const activate = st.status !== 'active';
      if (!activate && !confirm(`Ma hubtaa inaad joojiso ${st.full_name}? Roll Number ${st.roll_no} cid kale lama siin doono.`)) return;
      try { await api('POST', `/api/admin/students/${id}/status`, { status: activate ? 'active' : 'cancelled' }); m.close(); await refresh(); toast('Waa la cusboonaysiiyay'); }
      catch (err) { toast(err.message, true); }
    };
  }

  function bindMarkInputs(root) {
    const inputs = $$('input[data-s]', root);
    inputs.forEach((inp, i) => {
      const commit = () => {
        const sid = Number(inp.dataset.s), sub = Number(inp.dataset.j);
        const cur = fmtMark(S.marks.get(sid + ':' + sub));
        const v = inp.value.trim();
        if (v === cur) { inp.classList.remove('bad'); return true; }
        const p = Calc.parseMark(v);
        if (p.error) { inp.classList.add('bad'); toast('Dhibic khaldan – geli 0 ilaa 100, ama M (maqan).', true); return false; }
        setMark(sid, sub, p.clear ? null : p.code ? p.code : p.score);
        inp.classList.remove('bad'); inp.classList.add('ok');
        inp.value = fmtMark(S.marks.get(sid + ':' + sub));
        inp.classList.toggle('abs', p.code === 'ABS');
        const mb = inp.parentElement.querySelector('.mbtn'); if (mb) mb.classList.toggle('on', p.code === 'ABS');
        const tick = inp.closest('.mrow') && inp.closest('.mrow').querySelector('.tick'); if (tick) tick.textContent = '✓';
        return true;
      };
      inp.addEventListener('change', commit);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (commit() && inputs[i + 1]) { inputs[i + 1].focus(); inputs[i + 1].select(); } }
      });
      inp.addEventListener('focus', () => inp.select());
    });
  }

  // ---------- Excel: ardayda ----------
  const normH = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, '');
  async function studentTemplate() {
    const blob = await XLSX.write([
      { name: 'Ardayda', rows: [['Magaca Ardayga (afar magac)', 'Magaca Hooyada', 'Jinsiga (Wiil/Gabar)', 'Taleefanka Waalidka']], widths: [38, 30, 20, 22] },
      { name: 'Tusaale', rows: [['Magaca Ardayga (afar magac)', 'Magaca Hooyada', 'Jinsiga (Wiil/Gabar)', 'Taleefanka Waalidka'], ['Cabdiraxmaan Maxamed Cali Xasan', 'Faadumo Cabdi Warsame', 'Wiil', '0615123456'], ['Hodan Axmed Nuur Faarax', 'Caasha Maxamuud Jaamac', 'Gabar', '0617654321']], widths: [38, 30, 20, 22] },
      { name: 'Tilmaamo', header: false, plain: true, titleRows: [0], widths: [100], rows: [['Sida loo buuxiyo faylka ardayda'], ['1. Ku qor ardayda xaashida "Ardayda" – arday kasta hal saf.'], ['2. Magaca ardayga waa inuu ahaadaa afar magac; magaca hooyadana oo buuxa.'], ['3. Jinsiga: Wiil ama Gabar.'], ['4. Taleefanka waalidka waa lagama maarmaan – ardaygu natiijadiisa wuxuu ku eegayaa Roll Number + taleefankan.'], ['5. Roll Number ha qorin – nidaamka ayaa si toos ah u bixiya.'], ['6. Xaashida "Tusaale" waa tusaale kaliya, lama soo gelinayo.']] }
    ]);
    XLSX.download(blob, 'GHDD-Template-Ardayda.xlsx');
  }
  function importStudents() {
    if (!S.data.schools.length) return toast('Marka hore dugsi ku dar (Dejin → Dugsiyada).', true);
    const m = modal('Ardayda Excel ka soo geli', `
      <ol class="small" style="padding-left:18px"><li>Soo deji template-ka, ku buuxi ardayda.</li><li>Dooro dugsiga, kadibna soo geli faylka (.xlsx ama .csv).</li><li>Hubi liiska, kadib riix "Diiwaangeli".</li></ol>
      <button class="btn block" id="tpl" style="margin-bottom:12px">⬇ Soo deji template-ka ardayda</button>
      <label class="f"><span>Dugsiga</span><select id="isc">${schoolOpts(S.f.school || (S.data.schools[0] || {}).id, 'Dooro dugsiga')}</select></label>
      <label class="f"><span>Faylka Excel</span><input type="file" id="ifile" accept=".xlsx,.csv"></label>
      <div id="iout"></div>`);
    $('#tpl', m.el).onclick = studentTemplate;
    $('#ifile', m.el).onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      const out = $('#iout', m.el);
      if (!$('#isc', m.el).value) { out.innerHTML = '<div class="banner warn">Dooro dugsiga marka hore.</div>'; e.target.value = ''; return; }
      out.innerHTML = '<p class="muted">Faylka waa la akhrinayaa…</p>';
      try {
        const sheets = await XLSX.readFile(file);
        const sheet = sheets.find((s) => /arday/i.test(s.name)) || sheets.find((s) => !/tusaale|tilmaam/i.test(s.name)) || sheets[0];
        const rows = sheet.rows;
        const hi = rows.findIndex((r) => (r || []).some((c) => /magac|name/i.test(String(c || ''))));
        if (hi < 0) throw new Error('Safka cinwaannada (Magaca Ardayga, Magaca Hooyada…) lama helin.');
        const head = rows[hi].map(normH);
        const find = (re, not) => head.findIndex((h) => re.test(h) && !(not && not.test(h)));
        const ci = { name: find(/magacaarday|^magaca$|studentname|^name|fullname|magacaardayga/, /hooy|mother/), mother: find(/hooy|mother/), gender: find(/jins|gender|sex/), phone: find(/taleef|tele|phone|tel|mobile|lambar|mobil/) };
        if (ci.name < 0) ci.name = head.findIndex((h, i) => /magac|name/.test(h) && i !== ci.mother);
        if (ci.name < 0 || ci.mother < 0 || ci.phone < 0) throw new Error('Tiirarka lagama helin faylka. Isticmaal template-ka GHDD (Magaca Ardayga, Magaca Hooyada, Jinsiga, Taleefanka Waalidka).');
        const data = rows.slice(hi + 1).filter((r) => r && r[ci.name]).map((r) => ({ full_name: String(r[ci.name] || ''), mother_name: String(r[ci.mother] || ''), gender: ci.gender >= 0 ? String(r[ci.gender] || '') : '', parent_phone: String(r[ci.phone] || '') }));
        if (!data.length) throw new Error('Arday kuma jiro faylka.');
        const school_id = $('#isc', m.el).value;
        const dry = await api('POST', '/api/admin/students/bulk', { school_id, rows: data, dryRun: true });
        out.innerHTML = `<div class="banner ${dry.skipped.length ? 'warn' : 'good'}"><b>${dry.valid}</b> arday ayaa diyaar u ah diiwaangelin (${esc(schoolName(school_id))}).${dry.skipped.length ? ` <b>${dry.skipped.length}</b> ayaa laga boodayaa:` : ''}</div>
          ${dry.skipped.length ? `<div class="tbl-wrap" style="max-height:240px;margin-bottom:12px"><table class="tbl"><thead><tr><th>Saf</th><th>Magaca</th><th>Sababta</th></tr></thead><tbody>${dry.skipped.map((s) => `<tr><td>${s.row + hi + 1}</td><td>${esc(s.name)}</td><td style="white-space:normal">${esc(s.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}
          ${dry.valid ? `<button class="btn primary block" id="igo">Diiwaangeli ${dry.valid} arday oo sii Roll Number</button>` : ''}`;
        const g = $('#igo', m.el);
        if (g) g.onclick = async () => {
          g.disabled = true; g.textContent = 'Waa la diiwaangelinayaa…';
          try {
            const res = await api('POST', '/api/admin/students/bulk', { school_id, rows: data });
            await refresh();
            out.innerHTML = `<div class="banner good"><b>${res.created.length}</b> arday ayaa la diiwaangeliyay oo la siiyay Roll Number (${esc(res.created[0] ? res.created[0].roll : '')} – ${esc(res.created.length ? res.created[res.created.length - 1].roll : '')}).</div>
              <div class="row"><button class="btn primary" id="dl">⬇ Liiska Roll Number-ka (Excel)</button><button class="btn" id="pcs">Daabac passcard-yada</button></div>`;
            $('#dl', m.el).onclick = async () => XLSX.download(await XLSX.write([{ name: 'Roll Numbers', rows: [['Roll Number', 'Magaca Ardayga', 'Magaca Hooyada', 'Dugsiga']].concat(res.created.map((c) => [c.roll, c.name, c.mother, schoolName(school_id)])), widths: [14, 38, 30, 30] }]), `Roll-Numbers-${schoolName(school_id)}.xlsx`);
            $('#pcs', m.el).onclick = () => printCards(S.data.students.filter((s) => res.created.some((c) => c.id === s.id)));
          } catch (err) { g.disabled = false; g.textContent = 'Isku day mar kale'; toast(err.message, true); }
        };
      } catch (err) { out.innerHTML = `<div class="banner bad">${esc(err.message)}</div>`; }
      e.target.value = '';
    };
  }

  // ---------- Passcard ----------
  function cardHtml(s) {
    const st = S.data.settings;
    const url = publicBase() + '/kaar/' + s.qr_token;
    return `<div class="pcard">
      <div class="ph"><div class="seal">${esc(st.orgShort || 'GHDD')}</div><div><div class="t1">${esc(st.orgName)}</div><div class="t2">${esc(st.examTitle)} · ${esc(st.examYear)}</div></div></div>
      <div class="pt">KAARKA IMTIXAANKA</div>
      <div class="pb">
        <div class="pf">
          <div class="r"><small>Roll Number</small><b class="rollv">${esc(s.roll_no)}</b></div>
          <div class="r"><small>Magaca ardayga</small><b>${esc(s.full_name)}</b></div>
          <div class="r"><small>Magaca hooyada</small><b>${esc(s.mother_name)}</b></div>
          <div class="r"><small>Dugsiga</small><b>${esc(schoolName(s.school_id))}</b></div>
        </div>
        <div class="pq">${QR.svg(url, { border: 1 })}<span>Sawir QR-ka si loo xaqiijiyo kaarka</span></div>
      </div>
      <div class="pfoot"><span>Natiijada: ${esc(publicBase().replace(/^https?:\/\//, ''))}/natiijo<br>Kaarkan ha lumin.</span><span class="sig">Saxiixa &amp; Shaabadda</span></div>
    </div>`;
  }
  function printCards(list) {
    list = list.filter((s) => s && s.status === 'active');
    if (!list.length) return toast('Arday la daabaco ma jiro.', true);
    const area = $('#print-area');
    area.innerHTML = `<div class="cards">${list.map(cardHtml).join('')}</div>`;
    document.body.classList.add('printing-cards');
    setTimeout(() => window.print(), 80);
  }
  window.addEventListener('afterprint', () => { document.body.classList.remove('printing-cards', 'printing-report'); });
  function cardsDialog() {
    const m = modal('Daabac Passcard (Kaarka Imtixaanka)', `
      <label class="f"><span>Dugsiga</span><select id="csc">${schoolOpts(S.f.school, 'Dhammaan dugsiyada')}</select></label>
      <label class="f"><span>Kala horreynta</span><select id="cord">${sel([{ v: 'roll', t: 'Roll Number' }, { v: 'name', t: 'Magaca (A–Z)' }], 'roll')}</select></label>
      <p class="small muted">Bog A4 kasta wuxuu qaadaa 8 kaar. Daabac kadibna ku jar xariiqyada dhibicda ah. Haddii aad PDF rabto, printer-ka ka dooro "Save as PDF".</p>
      <div id="cprev" class="preview-cards" style="margin-bottom:12px"></div>
      <button class="btn primary block" id="cgo">Daabac</button>`);
    const list = () => {
      const sc = $('#csc', m.el).value;
      const l = studentsOfYear().filter((s) => s.status === 'active' && (!sc || s.school_id === Number(sc)));
      return $('#cord', m.el).value === 'name' ? l.sort((a, b) => a.full_name.localeCompare(b.full_name)) : l.sort((a, b) => a.roll_no.localeCompare(b.roll_no));
    };
    const prev = () => {
      const l = list();
      $('#cprev', m.el).innerHTML = l.length ? `<div class="small muted" style="margin-bottom:6px">${l.length} kaar · tusaale:</div><div class="cards" style="grid-template-columns:93mm;zoom:.9">${cardHtml(l[0])}</div>` : '<p class="muted">Arday ma jiro.</p>';
      $('#cgo', m.el).textContent = `Daabac ${l.length} kaar`;
    };
    $('#csc', m.el).onchange = prev; $('#cord', m.el).onchange = prev; prev();
    $('#cgo', m.el).onclick = () => printCards(list());
  }

  // ======================================================================
  // DHIBCAHA
  // ======================================================================
  function renderMarks() {
    const locked = S.data.settings.locked;
    view.innerHTML = `
      ${locked ? '<div class="banner warn"><b>Natiijada waa xiran tahay.</b> Si aad dhibco u beddesho, ka fur qaybta Dejinta.</div>' : ''}
      <div class="row" style="margin-bottom:12px"><div class="seg"><button data-m="maaddo">Maaddo-maaddo</button><button data-m="excel">Excel (soo geli)</button></div></div>
      <div id="mview"></div>`;
    $$('.seg button', view).forEach((b) => { b.classList.toggle('on', b.dataset.m === S.f.mmode); b.onclick = () => { S.f.mmode = b.dataset.m; saveFilters(); renderMarks(); }; });
    if (S.f.mmode === 'excel') renderMarksExcel($('#mview')); else renderMarksBySubject($('#mview'));
  }

  function renderMarksBySubject(box) {
    const subs = activeSubjects();
    if (!S.f.mschool && S.data.schools[0]) S.f.mschool = String(S.data.schools[0].id);
    if (!S.f.msub || !subs.find((s) => String(s.id) === String(S.f.msub))) S.f.msub = subs[0] ? String(subs[0].id) : '';
    box.innerHTML = `<div class="card">
      <div class="grid g2" style="margin-bottom:4px">
        <label class="f"><span>Dugsiga</span><select id="ms">${schoolOpts(S.f.mschool)}</select></label>
        <label class="f"><span>Maaddada</span><select id="mj">${sel(subs.map((s) => ({ v: s.id, t: s.name })), S.f.msub)}</select></label>
      </div>
      <div class="row" style="margin-bottom:8px"><input id="mq" class="grow" placeholder="Raadi arday…"><span id="mprog" class="small muted"></span></div>
      <p class="small muted" style="margin:0 0 6px">Qor dhibcaha (0–100) kadib riix <b>Enter</b> si aad ugu gudubto ardayga xiga. <b>M</b> = maqan. Waxay ku kaydsamaan telefoonka xitaa internet la'aan.</p>
      <div class="marks-list" id="mlist"></div></div>`;
    const draw = () => {
      const sc = Number(S.f.mschool), sub = Number(S.f.msub), q = ($('#mq').value || '').toLowerCase();
      const locked = S.data.settings.locked;
      const list = studentsOfYear().filter((s) => s.status === 'active' && s.school_id === sc).sort((a, b) => a.roll_no.localeCompare(b.roll_no));
      const done = list.filter((s) => S.marks.has(s.id + ':' + sub)).length;
      $('#mprog').textContent = `${done}/${list.length} la geliyay`;
      const shown = list.filter((s) => !q || s.full_name.toLowerCase().includes(q) || s.roll_no.includes(q));
      $('#mlist').innerHTML = shown.map((s) => {
        const mk = S.marks.get(s.id + ':' + sub);
        return `<div class="mrow"><div class="who"><b>${esc(s.full_name)}</b><small>${esc(s.roll_no)}</small></div><input data-s="${s.id}" data-j="${sub}" inputmode="decimal" enterkeyhint="next" value="${esc(fmtMark(mk))}" class="${mk ? (mk.code === 'ABS' ? 'abs ok' : 'ok') : ''}" ${locked ? 'disabled' : ''} aria-label="${esc(s.full_name)}"><button class="mbtn ${mk && mk.code === 'ABS' ? 'on' : ''}" data-abs="${s.id}" ${locked ? 'disabled' : ''} title="Maqan">M</button></div>`;
      }).join('') || '<p class="muted">Arday kuma jiro dugsigan. Ku dar qaybta Ardayda.</p>';
      bindMarkInputs($('#mlist'));
      $$('[data-abs]', $('#mlist')).forEach((b) => (b.onclick = () => {
        const sid = Number(b.dataset.abs), isAbs = b.classList.contains('on');
        setMark(sid, sub, isAbs ? null : 'ABS');
        const inp = b.parentElement.querySelector('input');
        inp.value = isAbs ? '' : 'M'; b.classList.toggle('on', !isAbs); inp.classList.toggle('abs', !isAbs); inp.classList.toggle('ok', !isAbs);
        const d2 = list.filter((s) => S.marks.has(s.id + ':' + sub)).length; $('#mprog').textContent = `${d2}/${list.length} la geliyay`;
      }));
      $$('input[data-s]', $('#mlist')).forEach((inp) => inp.addEventListener('change', () => { const d2 = list.filter((s) => S.marks.has(s.id + ':' + sub)).length; $('#mprog').textContent = `${d2}/${list.length} la geliyay`; }));
    };
    $('#ms').onchange = (e) => { S.f.mschool = e.target.value; saveFilters(); draw(); };
    $('#mj').onchange = (e) => { S.f.msub = e.target.value; saveFilters(); draw(); };
    $('#mq').oninput = draw;
    draw();
  }

  const ALIASES = {
    somali: ['soomaali', 'afsoomaali', 'somali', 'afsomali', 'soomaaliga'], arabic: ['carabi', 'afcarabi', 'arabi', 'carabiga'],
    english: ['ingiriisi', 'afingiriisi', 'eng', 'ingiriis'], islamiceducation: ['islamic', 'tarbiya', 'tarbiyo', 'tarbiyada', 'islaamic', 'diin', 'islamicstudies', 'tarbiyaislaamiya'],
    mathematics: ['math', 'maths', 'xisaab', 'xisaabta', 'mathematic'], physics: ['fiisigis', 'physic', 'fiisikis'], chemistry: ['kimistari', 'kimistiri', 'chem', 'kimiko'],
    biology: ['bayoloji', 'bayooloji', 'bio', 'baayoloji'], geography: ['juqraafi', 'juqraafiga', 'geo'], history: ['taariikh', 'taariikhda', 'hist'],
    business: ['ganacsi', 'ganacsiga', 'businessstudies', 'bus'], ict: ['computer', 'kombiyuutar', 'computerict', 'ictcomputer', 'technology', 'tiknoolajiyad', 'computerstudies']
  };
  function matchSubject(header, subs) {
    const h = normH(header);
    if (!h) return null;
    for (const s of subs) {
      const n = normH(s.name);
      if (h === n || (ALIASES[n] || []).includes(h)) return s;
    }
    for (const s of subs) {
      const n = normH(s.name);
      if (h.length >= 4 && (n.startsWith(h) || h.startsWith(n))) return s;
    }
    return null;
  }

  async function marksTemplate(schoolId) {
    const subs = activeSubjects();
    const list = studentsOfYear().filter((s) => s.status === 'active' && (!schoolId || s.school_id === Number(schoolId))).sort((a, b) => a.school_id - b.school_id || a.roll_no.localeCompare(b.roll_no));
    const head = ['Roll Number', 'Magaca Ardayga', 'Dugsiga'].concat(subs.map((s) => s.name));
    const rows = [head].concat(list.map((s) => [s.roll_no, s.full_name, schoolName(s.school_id)].concat(subs.map((sub) => { const mk = S.marks.get(s.id + ':' + sub.id); return mk ? (mk.code === 'ABS' ? 'M' : mk.code || mk.score) : ''; }))));
    const blob = await XLSX.write([
      { name: 'Natiijo', rows, widths: [13, 34, 24].concat(subs.map(() => 11)) },
      { name: 'Tilmaamo', header: false, plain: true, titleRows: [0], widths: [110], rows: [
        ['Sida loo buuxiyo natiijada'],
        ['1. Xaashida "Natiijo" arday kasta waa hal saf; Roll Number-ka iyo magaca ha beddelin.'],
        ['2. Maaddo kasta tiirkeeda ku qor dhibcaha ardayga: 0 ilaa 100 (tusaale 67 ama 67.5).'],
        ['3. Haddii ardaygu ka maqnaa imtixaanka maaddadaas, qor: M'],
        ['4. Haddii khiyaano la qabtay oo natiijada la hakinayo, qor: X'],
        ['5. Unug madhan = dhibic lama beddelayo (wixii hore ayaa haraya).'],
        ['6. Faylka ku kaydi .xlsx, kadib ku soo geli nidaamka: Dhibcaha → Excel → Soo geli faylka.'],
        [`Maaddooyinka: ${subs.map((s) => s.name).join(', ')}`]
      ] }
    ]);
    XLSX.download(blob, `GHDD-Natiijo-${schoolId ? schoolName(schoolId) : 'Dhammaan'}-${S.data.settings.examYear}.xlsx`);
  }

  function renderMarksExcel(box) {
    const locked = S.data.settings.locked;
    box.innerHTML = `
      <div class="card"><h2>1. Soo deji template-ka natiijada</h2>
        <p class="small muted">Template-ku wuxuu ku jiraa ardayda dugsiga oo leh Roll Number-kooda iyo tiir maaddo kasta. Dhibcihii hore la geliyay waa ku jiraan.</p>
        <div class="row"><select id="tsc" class="grow">${schoolOpts(S.f.mschool, 'Dhammaan dugsiyada')}</select><button class="btn primary" id="tdl">⬇ Soo deji template-ka</button></div></div>
      <div class="card"><h2>2. Soo geli faylka natiijada</h2>
        ${locked ? '<div class="banner warn">Natiijada waa xiran tahay – lama soo gelin karo.</div>' : `<label class="f"><span>Faylka Excel (.xlsx ama .csv)</span><input type="file" id="mfile" accept=".xlsx,.csv"></label>`}
        <div id="mout"></div></div>`;
    $('#tdl').onclick = () => marksTemplate($('#tsc').value);
    const fi = $('#mfile');
    if (fi) fi.onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      const out = $('#mout');
      out.innerHTML = '<p class="muted">Faylka waa la akhrinayaa…</p>';
      try {
        const sheets = await XLSX.readFile(file);
        const subs = activeSubjects();
        const byRoll = new Map(S.data.students.filter((s) => s.status === 'active').map((s) => [s.roll_no, s]));
        let sheet = null, hi = -1;
        for (const sh of sheets) { hi = sh.rows.findIndex((r) => (r || []).some((c) => /roll/i.test(String(c || '')))); if (hi >= 0) { sheet = sh; break; } }
        if (!sheet) throw new Error('Tiirka "Roll Number" lagama helin faylka. Isticmaal template-ka nidaamka.');
        const head = sheet.rows[hi];
        const rollCol = head.findIndex((c) => /roll/i.test(String(c || '')));
        const cols = [], unknown = [];
        head.forEach((h, i) => {
          if (i === rollCol || h == null || h === '') return;
          if (/magac|name|dugsi|school|jins|gender|hooy|mother|tele|phone|wadar|total|celcel|average|grade|kaalin|rank|xaalad|status|^no$|^#$/i.test(String(h))) return;
          const s = matchSubject(h, subs);
          if (s) cols.push({ i, s }); else unknown.push(String(h));
        });
        if (!cols.length) throw new Error('Tiirarka maaddooyinka lama aqoonsan. Magacyada tiirarka waa inay la mid noqdaan maaddooyinka nidaamka.');
        const changes = [], errors = [], missing = [];
        let same = 0, newOnes = 0, upd = 0, studentsFound = 0;
        sheet.rows.slice(hi + 1).forEach((r, k) => {
          if (!r || r[rollCol] == null || r[rollCol] === '') return;
          const roll = String(r[rollCol]).replace(/\D/g, '');
          const st = byRoll.get(roll);
          if (!st) { missing.push({ row: hi + k + 2, roll }); return; }
          studentsFound++;
          for (const c of cols) {
            const v = r[c.i];
            if (v == null || v === '') continue;
            const p = Calc.parseMark(v);
            if (p.error || p.clear) { errors.push({ row: hi + k + 2, roll, sub: c.s.name, v }); continue; }
            const val = p.code || p.score;
            const cur = S.marks.get(st.id + ':' + c.s.id);
            const curVal = cur ? (cur.code || cur.score) : undefined;
            if (curVal === val) { same++; continue; }
            if (curVal === undefined) newOnes++; else upd++;
            changes.push([st.id, c.s.id, val]);
          }
        });
        out.innerHTML = `
          <div class="grid g4" style="margin:6px 0 12px">
            <div class="stat"><div class="v">${studentsFound}</div><div class="l">Arday la helay</div></div>
            <div class="stat good"><div class="v">${newOnes}</div><div class="l">Dhibco cusub</div></div>
            <div class="stat"><div class="v">${upd}</div><div class="l">Dhibco la beddelay</div></div>
            <div class="stat ${errors.length + missing.length ? 'bad' : ''}"><div class="v">${errors.length + missing.length}</div><div class="l">Khaladaad</div></div>
          </div>
          <p class="small muted">Maaddooyinka la aqoonsaday: ${cols.map((c) => `<b>${esc(c.s.name)}</b>`).join(', ')}. ${same ? same + ' dhibic isma beddelin.' : ''}</p>
          ${unknown.length ? `<div class="banner warn">Tiirarkan lama aqoonsan, waa laga boodayaa: ${unknown.map(esc).join(', ')}</div>` : ''}
          ${errors.length || missing.length ? `<div class="tbl-wrap" style="max-height:220px;margin-bottom:12px"><table class="tbl"><thead><tr><th>Saf</th><th>Roll</th><th>Dhibaatada</th></tr></thead><tbody>
            ${missing.slice(0, 100).map((x) => `<tr><td>${x.row}</td><td>${esc(x.roll)}</td><td>Roll Number-kan lama helin (ama ardayga waa la joojiyay)</td></tr>`).join('')}
            ${errors.slice(0, 200).map((x) => `<tr><td>${x.row}</td><td>${esc(x.roll)}</td><td>${esc(x.sub)}: "${esc(x.v)}" ma aha dhibic sax ah (0–100, M, X)</td></tr>`).join('')}
          </tbody></table></div>` : ''}
          ${changes.length ? `<button class="btn primary block" id="msave">Kaydi ${changes.length} dhibic</button>` : '<div class="banner info">Wax isbeddel ah oo la kaydiyo ma jiro.</div>'}`;
        const sv = $('#msave');
        if (sv) sv.onclick = () => {
          changes.forEach((c) => {
            applyLocal(c[0], c[1], c[2]);
            S.pending = S.pending.filter((p) => !(p[0] === c[0] && p[1] === c[1]));
            S.pending.push([c[0], c[1], c[2], 'excel']);
          });
          LS.set('pending', S.pending); bump(); updateSync();
          flush();
          out.innerHTML = `<div class="banner good"><b>${changes.length}</b> dhibic ayaa la kaydiyay.${navigator.onLine ? '' : ' Offline ayaad tahay – marka internet-ku yimaado ayay server-ka u gudbayaan.'}</div><button class="btn" id="tofa">Eeg falanqaynta →</button>`;
          $('#tofa').onclick = () => go('falanqayn');
        };
      } catch (err) { out.innerHTML = `<div class="banner bad">${esc(err.message)}</div>`; }
      e.target.value = '';
    };
  }

  // ======================================================================
  // FALANQAYN
  // ======================================================================
  function renderAnalytics() {
    const A = analytics(S.f.aschool);
    const G = A.S.grades;
    const gcol = Charts.gradeColors(G);
    const gkeys = G.map((g, i) => ({ k: g.g, label: `${g.g} (${g.label})`, color: gcol[i], textColor: i >= G.length - 2 ? '#0f1b2d' : '#fff' }));
    const k = A.kpi;
    const tf = (v) => (v == null ? '–' : v);
    const subjSorted = A.subjectsStats.filter((s) => s.n).slice().sort((a, b) => b.mean - a.mean);
    const schoolsSat = A.schools.filter((s) => s.sat);
    const heatColor = (v) => { if (v == null) return ''; const t = Math.max(0, Math.min(1, v / 100)); const l = 96 - t * 50; return `background:hsl(214 70% ${l}%);color:${l < 62 ? '#fff' : '#0f1b2d'}`; };
    const one = !!S.f.aschool;
    view.innerHTML = `
      <div class="card no-print"><div class="row">
        <select id="as" class="grow">${schoolOpts(S.f.aschool, 'Dhammaan dugsiyada (heer GHDD)')}</select>
        <button class="btn" id="aprint">Daabac warbixinta</button><button class="btn primary" id="axl">⬇ Excel (warbixin buuxda)</button></div></div>
      <div class="card"><h2>Warbixinta Falanqaynta Natiijada – ${esc(A.year)}</h2>
        <p class="muted small" style="margin-top:-4px">${esc(A.S.orgName)} · ${one ? esc(schoolName(S.f.aschool)) : 'Dhammaan dugsiyada'}</p>
        <div class="grid g4" style="margin:12px 0">
          <div class="stat"><div class="v">${k.registered}</div><div class="l">Diiwaangashan</div></div>
          <div class="stat"><div class="v">${k.sat}</div><div class="l">Fadhiistay</div></div>
          <div class="stat good"><div class="v">${k.passRate}%</div><div class="l">Gudbay (${k.passed})</div></div>
          <div class="stat bad"><div class="v">${k.failed}</div><div class="l">Haray</div></div>
          <div class="stat"><div class="v">${tf(k.mean)}%</div><div class="l">Celceliska guud</div></div>
          <div class="stat"><div class="v">${tf(k.median)}%</div><div class="l">Dhexe (median)</div></div>
          <div class="stat"><div class="v">${tf(k.max)}%</div><div class="l">Ugu sarreeya</div></div>
          <div class="stat"><div class="v">${k.absent + k.withheld}</div><div class="l">Maqan / la hakiyay</div></div>
        </div>
        ${k.incomplete ? `<div class="banner warn">${k.incomplete} arday natiijadoodu waa dhiman tahay; kuma jiraan falanqaynta.</div>` : ''}
        <h3>Gunaanad</h3>
        <ul class="insights">${A.insights.map((t) => `<li>${esc(t)}</li>`).join('') || '<li class="muted">Xog ku filan weli lama gelin.</li>'}</ul>
      </div>

      ${!one ? `<div class="card"><h2>Isbarbardhigga dugsiyada</h2>
        <h3 class="small muted">Boqolleyda gudbitaanka</h3>
        ${Charts.barH(schoolsSat.slice().sort((a, b) => b.passRate - a.passRate).map((s) => ({ label: s.name, value: s.passRate, sub: `(${s.passed}/${s.sat})`, color: Charts.C.blue })), { ref: A.S.minAverage === 50 ? 50 : null, refLabel: '50%', aria: 'Gudbitaanka dugsiyada' })}
        <h3 class="small muted" style="margin-top:14px">Celceliska dhibcaha</h3>
        ${Charts.barH(schoolsSat.slice().sort((a, b) => b.mean - a.mean).map((s) => ({ label: s.name, value: s.mean, color: Charts.C.aqua })), { ref: A.S.minAverage, refLabel: `Heerka gudbitaanka ${A.S.minAverage}%`, aria: 'Celceliska dugsiyada' })}
        <div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Kaalin</th><th>Dugsiga</th><th class="n">Diiwaan</th><th class="n">Fadhiistay</th><th class="n">Gudbay</th><th class="n">Haray</th><th class="n">% Gudbay</th><th class="n">Celcelis</th><th class="n">Ugu sarreeya</th>${G.map((g) => `<th class="n">${esc(g.g)}</th>`).join('')}<th>Ardayga 1aad</th></tr></thead>
        <tbody>${A.schools.slice().sort((a, b) => (a.rank || 99) - (b.rank || 99)).map((s) => `<tr><td>${s.rank || '–'}</td><td><b>${esc(s.name)}</b></td><td class="n">${s.registered}</td><td class="n">${s.sat}</td><td class="n">${s.passed}</td><td class="n">${s.failed}</td><td class="n"><b>${s.passRate}%</b></td><td class="n">${tf(s.mean)}</td><td class="n">${tf(s.max)}</td>${G.map((g) => `<td class="n">${s.grades[g.g]}</td>`).join('')}<td>${s.best ? `${esc(s.best.name)} (${s.best.avg}%)` : '–'}</td></tr>`).join('')}</tbody></table></div>
      </div>` : ''}

      <div class="card"><h2>Kala qaybsanaanta grade-yada</h2>
        ${Charts.columns(G.map((g, i) => ({ label: g.g, value: A.gradeDist[g.g], color: gcol[i], title: `${g.g} – ${g.label}: ${A.gradeDist[g.g]} arday` })), { aria: 'Grade-yada' })}
        ${!one ? `<h3 class="small muted" style="margin-top:12px">Grade-yada dugsi kasta</h3>${Charts.legend(gkeys)}${Charts.stacked(schoolsSat.map((s) => ({ label: s.name, parts: s.grades })), gkeys, { aria: 'Grade-yada dugsiyada' })}` : ''}
      </div>

      <div class="card"><h2>Falanqaynta maaddooyinka</h2>
        <h3 class="small muted">Celceliska maaddo kasta</h3>
        ${Charts.barH(subjSorted.map((s) => ({ label: s.name, value: s.mean, color: s.mean < A.S.passMark ? Charts.C.orange : Charts.C.blue, title: `${s.name}: celcelis ${s.mean}%, gudbay ${s.passRate}%` })), { ref: A.S.passMark, refLabel: `Gudbitaan ${A.S.passMark}%`, aria: 'Celceliska maaddooyinka' })}
        ${Charts.legend([{ label: `Celcelis ${A.S.passMark}% iyo ka sare`, color: Charts.C.blue }, { label: `Ka hooseeya ${A.S.passMark}%`, color: Charts.C.orange }])}
        <h3 class="small muted" style="margin-top:12px">Boqolleyda gudbitaanka maaddo kasta</h3>
        ${Charts.barH(A.subjectsStats.filter((s) => s.n).slice().sort((a, b) => b.passRate - a.passRate).map((s) => ({ label: s.name, value: s.passRate, sub: `(${s.passed}/${s.n})`, color: Charts.C.aqua })), { aria: 'Gudbitaanka maaddooyinka' })}
        <div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Maaddada</th><th class="n">Arday</th><th class="n">Celcelis</th><th class="n">Dhexe</th><th class="n">Ugu sarreeya</th><th class="n">Ugu hooseeya</th><th class="n">Kala fogaansho (SD)</th><th class="n">% Gudbay</th><th class="n">Maqan</th>${G.map((g) => `<th class="n">${esc(g.g)}</th>`).join('')}<th>Ardayga ugu fiican</th></tr></thead>
        <tbody>${A.subjectsStats.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td class="n">${s.n}</td><td class="n"><b>${tf(s.mean)}</b></td><td class="n">${tf(s.median)}</td><td class="n">${tf(s.max)}</td><td class="n">${tf(s.min)}</td><td class="n">${tf(s.sd)}</td><td class="n">${s.passRate}%</td><td class="n">${s.absent}</td>${G.map((g) => `<td class="n">${s.grades[g.g]}</td>`).join('')}<td>${s.best ? `${esc(s.best.name)} (${s.best.score})` : '–'}</td></tr>`).join('')}</tbody></table></div>
        ${!one && A.schools.length > 1 ? `<h3 class="small muted" style="margin-top:14px">Celceliska maaddo kasta ee dugsi kasta (midabka mugdiga ah = dhibco sare)</h3>
        <div class="tbl-wrap"><table class="tbl heat"><thead><tr><th>Maaddada</th>${A.schools.map((s) => `<th style="text-align:center">${esc(s.code)}</th>`).join('')}</tr></thead>
        <tbody>${A.subjectsStats.map((s) => `<tr><td>${esc(s.name)}</td>${A.schools.map((sc) => `<td class="h" style="${heatColor(s.perSchool[sc.id])}" title="${esc(sc.name)} – ${esc(s.name)}">${tf(s.perSchool[sc.id])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <p class="small muted">${A.schools.map((s) => `${esc(s.code)} = ${esc(s.name)}`).join(' · ')}</p>` : ''}
      </div>

      <div class="card"><h2>Wiilasha iyo gabdhaha</h2>
        ${Charts.legend([{ label: 'Wiil', color: Charts.C.blue }, { label: 'Gabar', color: Charts.C.orange }])}
        ${Charts.paired([{ label: 'Gudbitaan %', values: [A.gender.Wiil.rate, A.gender.Gabar.rate] }, { label: 'Celcelis %', values: [A.gender.Wiil.mean, A.gender.Gabar.mean] }].concat(!one ? schoolsSat.map((s) => ({ label: s.name, values: [s.boys.sat ? s.boys.rate : null, s.girls.sat ? s.girls.rate : null] })) : []), [{ label: 'Wiil', color: Charts.C.blue }, { label: 'Gabar', color: Charts.C.orange }], { aria: 'Wiil iyo gabar' })}
        <div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th></th><th class="n">Diiwaan</th><th class="n">Fadhiistay</th><th class="n">Gudbay</th><th class="n">% Gudbay</th><th class="n">Celcelis</th></tr></thead>
        <tbody>${['Wiil', 'Gabar'].map((g) => `<tr><td><b>${g}</b></td><td class="n">${A.gender[g].registered}</td><td class="n">${A.gender[g].sat}</td><td class="n">${A.gender[g].passed}</td><td class="n">${A.gender[g].rate}%</td><td class="n">${tf(A.gender[g].mean)}</td></tr>`).join('')}</tbody></table></div>
      </div>

      <div class="card"><h2>Kala qaybsanaanta celceliska ardayda</h2>
        ${Charts.columns(A.hist.map((h) => ({ label: `${h.from}–${h.to}`, value: h.n, color: h.from >= A.S.minAverage ? Charts.C.blue : Charts.C.orange, title: `Celcelis ${h.from}–${h.to}%: ${h.n} arday` })), { aria: 'Kala qaybsanaanta celceliska' })}
        ${Charts.legend([{ label: 'Gudbay', color: Charts.C.blue }, { label: 'Haray', color: Charts.C.orange }])}
      </div>

      <div class="grid g2 stack">
        <div class="card"><h2>10-ka arday ee ugu sarreeya</h2>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Magaca</th>${one ? '' : '<th>Dugsiga</th>'}<th class="n">Celcelis</th><th>Grade</th></tr></thead>
          <tbody>${A.top.map((t) => `<tr><td>${t.rank}</td><td><b>${esc(t.name)}</b><div class="small muted mono">${esc(t.roll)}</div></td>${one ? '' : `<td>${esc(t.school)}</td>`}<td class="n"><b>${t.avg}%</b></td><td>${esc(t.grade)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">–</td></tr>'}</tbody></table></div></div>
        ${!one ? `<div class="card"><h2>Saddexda ugu sarreeya dugsi kasta</h2>
          ${A.topBySchool.map((x) => `<h3 style="margin-top:8px">${esc(x.school)}</h3><ol style="margin:0 0 8px;padding-left:20px">${x.list.map((t) => `<li>${esc(t.name)} – <b>${t.avg}%</b> (${esc(t.grade)})</li>`).join('')}</ol>`).join('') || '<p class="muted">–</p>'}</div>` : ''}
      </div>

      <div class="card"><div class="card-head"><h2>Natiijada ardayda oo dhan</h2>
        <div class="row no-print"><select id="rs">${sel([{ v: 'rank', t: 'Kaalinta' }, { v: 'roll', t: 'Roll Number' }, { v: 'name', t: 'Magaca' }], S.f.rsort)}</select><input id="rq" placeholder="Raadi…" value="${esc(S.f.rq)}" style="width:180px"></div></div>
        <div id="rlist"></div></div>`;
    $('#as').onchange = (e) => { S.f.aschool = e.target.value; saveFilters(); renderAnalytics(); };
    $('#aprint').onclick = () => { document.body.classList.add('printing-report'); setTimeout(() => window.print(), 50); };
    $('#axl').onclick = () => exportReport(A);
    const subs = A.subjects;
    const drawList = () => {
      const q = S.f.rq.trim().toLowerCase();
      let l = A.results.filter((r) => !q || r.name.toLowerCase().includes(q) || r.roll.includes(q));
      if (S.f.rsort === 'rank') l = l.slice().sort((a, b) => (a.rankAll || 1e9) - (b.rankAll || 1e9) || a.roll.localeCompare(b.roll));
      else if (S.f.rsort === 'name') l = l.slice().sort((a, b) => a.name.localeCompare(b.name));
      else l = l.slice().sort((a, b) => a.roll.localeCompare(b.roll));
      const shown = l.slice(0, S.rN || 100);
      $('#rlist').innerHTML = `<div class="tbl-wrap" style="max-height:70vh"><table class="tbl click"><thead><tr><th>Kaalin</th><th>Roll</th><th>Magaca</th>${one ? '' : '<th>Dugsi</th>'}${subs.map((s) => `<th class="n" title="${esc(s.name)}">${esc(s.name.slice(0, 4))}</th>`).join('')}<th class="n">Wadar</th><th class="n">%</th><th>Gr</th><th>Xaalad</th></tr></thead>
        <tbody>${shown.map((r) => `<tr data-id="${r.id}"><td>${r.rankAll || '–'}</td><td class="mono">${esc(r.roll)}</td><td>${esc(r.name)}</td>${one ? '' : `<td>${esc((S.data.schools.find((s) => s.id === r.schoolId) || {}).code || '')}</td>`}${r.scores.map((s) => `<td class="n" style="${s.pass === false ? 'color:var(--bad);font-weight:700' : ''}">${s.code === 'ABS' ? 'M' : s.code || (s.score == null ? '·' : s.score)}</td>`).join('')}<td class="n"><b>${r.sat ? r.total : '–'}</b></td><td class="n">${r.sat ? r.avg : '–'}</td><td>${r.grade || ''}</td><td><span class="chip ${Calc.STATUS[r.status].tone}">${esc(Calc.STATUS[r.status].label)}</span></td></tr>`).join('')}</tbody></table></div>
        ${l.length > shown.length ? `<button class="btn block no-print" id="rmore" style="margin-top:8px">Muuji ${Math.min(100, l.length - shown.length)} kale (${l.length})</button>` : ''}`;
      $$('#rlist tr[data-id]').forEach((tr) => (tr.onclick = () => showResult(S.data.students.find((s) => s.id === Number(tr.dataset.id)))));
      const mb = $('#rmore'); if (mb) mb.onclick = () => { S.rN = (S.rN || 100) + 100; drawList(); };
    };
    $('#rs').onchange = (e) => { S.f.rsort = e.target.value; saveFilters(); drawList(); };
    $('#rq').oninput = (e) => { S.f.rq = e.target.value; saveFilters(); drawList(); };
    drawList();
  }

  async function exportReport(A) {
    const G = A.S.grades, subs = A.subjects;
    const sname = (id) => schoolName(id);
    const all = A.results.slice().sort((a, b) => (a.rankAll || 1e9) - (b.rankAll || 1e9) || a.roll.localeCompare(b.roll));
    const broad = [['Kaalinta', 'Roll Number', 'Magaca Ardayga', 'Magaca Hooyada', 'Dugsiga', 'Jinsiga'].concat(subs.map((s) => s.name), ['Wadarta', 'Celcelis %', 'Grade', 'Xaaladda', 'Kaalinta dugsiga'])]
      .concat(all.map((r) => [r.rankAll || '', r.roll, r.name, r.mother, sname(r.schoolId), r.gender].concat(r.scores.map((s) => (s.code === 'ABS' ? 'M' : s.code || (s.score == null ? '' : s.score))), [r.sat ? r.total : '', r.sat ? r.avg : '', r.grade || '', Calc.STATUS[r.status].label, r.rankSchool || ''])));
    const schoolsSheet = [['Kaalin', 'Dugsiga', 'Diiwaangashan', 'Fadhiistay', 'Gudbay', 'Haray', '% Gudbay', 'Celcelis', 'Ugu sarreeya', 'Ugu hooseeya'].concat(G.map((g) => 'Grade ' + g.g), ['Wiil % gudbay', 'Gabar % gudbay', 'Ardayga 1aad'])]
      .concat(A.schools.slice().sort((a, b) => (a.rank || 99) - (b.rank || 99)).map((s) => [s.rank || '', s.name, s.registered, s.sat, s.passed, s.failed, s.passRate, s.mean, s.max, s.min].concat(G.map((g) => s.grades[g.g]), [s.boys.sat ? s.boys.rate : '', s.girls.sat ? s.girls.rate : '', s.best ? `${s.best.name} (${s.best.avg}%)` : ''])));
    const subjSheet = [['Maaddada', 'Arday', 'Celcelis', 'Dhexe', 'Ugu sarreeya', 'Ugu hooseeya', 'SD', 'Gudbay', 'Ka dhacay', '% Gudbay', 'Maqan'].concat(G.map((g) => 'Grade ' + g.g), A.schools.map((s) => 'Celcelis ' + s.code), ['Ardayga ugu fiican'])]
      .concat(A.subjectsStats.map((s) => [s.name, s.n, s.mean, s.median, s.max, s.min, s.sd, s.passed, s.failed, s.passRate, s.absent].concat(G.map((g) => s.grades[g.g]), A.schools.map((sc) => s.perSchool[sc.id]), [s.best ? `${s.best.name} (${s.best.score})` : ''])));
    const summary = [[`${A.S.orgName}`], [`Warbixinta natiijada ${A.S.examTitle} – ${A.year}`], [S.f.aschool ? schoolName(S.f.aschool) : 'Dhammaan dugsiyada'], [''],
      ['Diiwaangashan', A.kpi.registered], ['Fadhiistay', A.kpi.sat], ['Gudbay', A.kpi.passed], ['Haray', A.kpi.failed], ['% Gudbay', A.kpi.passRate], ['Celceliska guud', A.kpi.mean], ['Ugu sarreeya', A.kpi.max], ['Maqan', A.kpi.absent], ['La hakiyay', A.kpi.withheld], ['Dhiman', A.kpi.incomplete], [''], ['Gunaanad']].concat(A.insights.map((t) => [t]))
      .concat([[''], ['Grade-yada']], G.map((g) => [`${g.g} – ${g.label}`, A.gradeDist[g.g]]));
    const blob = await XLSX.write([
      { name: 'Soo koobid', header: false, plain: true, titleRows: [0, 1], widths: [60, 14], rows: summary },
      { name: 'Natiijada ardayda', rows: broad, widths: [8, 12, 34, 28, 26, 8].concat(subs.map(() => 9), [9, 10, 7, 16, 10]), filter: true },
      { name: 'Dugsiyada', rows: schoolsSheet, widths: [8, 30].concat(Array(20).fill(12)) },
      { name: 'Maaddooyinka', rows: subjSheet, widths: [20].concat(Array(30).fill(11)) }
    ]);
    XLSX.download(blob, `GHDD-Warbixin-Natiijo-${A.year}${S.f.aschool ? '-' + schoolName(S.f.aschool) : ''}.xlsx`);
  }

  // ======================================================================
  // DEJIN
  // ======================================================================
  function renderSettings() {
    const st = S.data.settings;
    const G = Calc.withDefaults(st).grades;
    const resultUrl = publicBase() + '/natiijo';
    view.innerHTML = `
      <div class="card"><h2>Sii daynta natiijada</h2>
        <p class="small muted">Marka la sii daayo, ardaydu waxay natiijadooda ka eegi karaan link-ga hoose iyagoo isticmaalaya Roll Number + taleefanka waalidka.</p>
        <div class="row" style="margin-bottom:10px">
          <span class="chip ${st.released ? 'good' : 'muted'}">${st.released ? 'LA SII DAAYAY' : 'LAMA SII DAYN'}</span>
          <button class="btn ${st.released ? 'danger' : 'good'}" id="rel">${st.released ? 'Ka qari natiijada' : 'Sii dayso natiijada'}</button>
          <span class="chip ${st.locked ? 'warn' : 'muted'}">${st.locked ? 'XIRAN' : 'FURAN'}</span>
          <button class="btn" id="lock">${st.locked ? 'Fur natiijada (wax ka beddel)' : 'Xir natiijada (lock)'}</button>
        </div>
        <div class="row"><input readonly value="${esc(resultUrl)}" class="grow mono" id="rurl"><button class="btn" id="cp">Koobi</button><button class="btn" id="share">La wadaag</button><button class="btn" id="poster">Daabac boodhka QR</button></div>
      </div>

      <form class="card" id="sf"><h2>Xogta imtixaanka</h2>
        <label class="f"><span>Magaca hay'adda</span><input name="orgName" value="${esc(st.orgName)}"></label>
        <div class="grid g2">
          <label class="f"><span>Magac gaaban</span><input name="orgShort" value="${esc(st.orgShort)}"></label>
          <label class="f"><span>Sannadka imtixaanka</span><input name="examYear" inputmode="numeric" value="${esc(st.examYear)}"></label>
        </div>
        <label class="f"><span>Cinwaanka imtixaanka</span><input name="examTitle" value="${esc(st.examTitle)}"></label>
        <label class="f"><span>Link-ga dadweynaha (QR-ka kaararka iyo natiijada)</span><input name="publicUrl" value="${esc(st.publicUrl || location.origin)}" placeholder="https://..."></label>
        <h3 style="margin-top:8px">Xeerka gudbitaanka</h3>
        <div class="grid g3">
          <label class="f"><span>Dhibcaha gudbitaanka maaddo (%)</span><input name="passMark" inputmode="decimal" value="${esc(st.passMark)}"></label>
          <label class="f"><span>Celceliska gudbitaanka (%)</span><input name="minAverage" inputmode="decimal" value="${esc(st.minAverage)}"></label>
          <label class="f"><span>Maaddooyinka ugu badan ee laga dhici karo</span><input name="maxFailed" inputmode="numeric" value="${esc(st.maxFailed == null ? '' : st.maxFailed)}" placeholder="Xad la'aan"></label>
        </div>
        <label class="f" style="display:flex;gap:10px;align-items:center"><input type="checkbox" name="showRank" ${st.showRank ? 'checked' : ''} style="width:auto;min-height:0"> <span style="margin:0">Ardayga u muuji kaalintiisa (dugsi iyo guud)</span></label>
        <p class="small muted">Ardaygu wuxuu gudbaa marka celceliskiisu gaaro ${esc(st.minAverage)}%${st.maxFailed != null ? ` oo uusan ka dhicin in ka badan ${esc(st.maxFailed)} maaddo` : ''}. Maqnaanshaha (M) waxaa loo tiriyaa 0.</p>

        <h3 style="margin-top:8px">Nidaamka grade-ka</h3>
        <div class="tbl-wrap"><table class="tbl" id="gt"><thead><tr><th>Grade</th><th>Laga bilaabo (%)</th><th>Sharaxaad</th><th></th></tr></thead><tbody>
          ${G.map((g) => `<tr><td><input data-g="g" value="${esc(g.g)}" style="width:70px"></td><td><input data-g="min" inputmode="decimal" value="${esc(g.min)}" style="width:90px"></td><td><input data-g="label" value="${esc(g.label)}"></td><td><button type="button" class="btn sm danger" data-del>✕</button></td></tr>`).join('')}
        </tbody></table></div>
        <button type="button" class="btn sm" id="gadd" style="margin:8px 0 12px">+ Grade ku dar</button>

        <h3>Talooyinka ardayga (waxay ka muuqdaan warqadda natiijada)</h3>
        <label class="f"><span>Celcelis 80% iyo ka sare</span><textarea name="adv_top">${esc(st.advice.top)}</textarea></label>
        <label class="f"><span>Celcelis 65–79%</span><textarea name="adv_good">${esc(st.advice.good)}</textarea></label>
        <label class="f"><span>Gudbay (ka hooseeya 65%)</span><textarea name="adv_pass">${esc(st.advice.pass)}</textarea></label>
        <label class="f"><span>Haray</span><textarea name="adv_fail">${esc(st.advice.fail)}</textarea></label>
        <label class="f"><span>Fariinta waalidka (marka maaddooyin ka hooseeyaan)</span><textarea name="parentNote">${esc(st.parentNote)}</textarea></label>
        <div id="se"></div>
        <button class="btn primary block">Kaydi dejinta</button>
      </form>

      <div class="card"><div class="card-head"><h2>Dugsiyada</h2><button class="btn sm primary" id="scadd">+ Dugsi</button></div>
        <div class="list">${S.data.schools.map((s) => `<div class="item" data-sc="${s.id}"><span class="roll">${esc(s.code)}</span><div class="who"><b>${esc(s.name)}</b><small>${esc([s.region, s.head, s.phone].filter(Boolean).join(' · ') || '–')} · ${S.data.students.filter((x) => x.school_id === s.id).length} arday</small></div></div>`).join('') || '<p class="muted">Dugsi ma jiro.</p>'}</div></div>

      <div class="card"><div class="card-head"><h2>Maaddooyinka</h2><button class="btn sm" id="subadd">+ Maaddo</button></div>
        <div id="sublist"></div><button class="btn primary block" id="subsave" style="margin-top:10px">Kaydi maaddooyinka</button></div>

      <div class="card"><h2>Amniga</h2>
        <form id="pf" class="grid g2 stack"><label class="f"><span>Furaha hadda</span><input type="password" name="old" autocomplete="current-password" required></label>
        <label class="f"><span>Furaha cusub (ugu yaraan 6)</span><input type="password" name="new" autocomplete="new-password" required></label>
        <button class="btn">Beddel furaha</button></form>
        <button class="btn danger sm" id="lo" style="margin-top:8px">Ka bax (logout)</button></div>

      <div class="card"><h2>Kaydka xogta (Backup)</h2>
        <p class="small muted">Soo deji kayd buuxa (JSON) si aad u ilaaliso xogta. "Soo celi" waxay xogta hadda jirta ku beddeshaa kaydka – si taxaddar leh u isticmaal.</p>
        <div class="row"><button class="btn" id="bk">⬇ Soo deji kayd</button><label class="btn">Soo celi kayd<input type="file" id="rs" accept=".json" class="hidden"></label></div></div>

      <div class="card"><div class="card-head"><h2>Diiwaanka isbeddellada</h2><button class="btn sm" id="aud">Muuji</button></div><div id="audit"></div></div>`;

    // sii dayn / xirid
    const post = async (body, msg) => { try { const r = await api('POST', '/api/admin/release', body); S.data.settings = r.settings; saveCache(); toast(msg); render(); } catch (e) { toast(e.message, true); } };
    $('#rel').onclick = () => {
      if (!st.released && !confirm('Ma hubtaa inaad sii dayso natiijada? Ardaydu hadda ayay arki karaan.')) return;
      post({ released: !st.released }, st.released ? 'Natiijada waa la qariyay' : 'Natiijada waa la sii daayay');
    };
    $('#lock').onclick = () => post({ locked: !st.locked }, st.locked ? 'Natiijada waa la furay' : 'Natiijada waa la xiray');
    $('#cp').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(resultUrl).then(() => toast('Link-ga waa la koobiyeeyay')); };
    $('#share').onclick = () => { if (navigator.share) navigator.share({ title: 'Natiijada imtixaanka', text: `${st.orgName}: ka eeg natiijada imtixaanka Form 4 adigoo isticmaalaya Roll Number-kaaga iyo taleefanka waalidka.`, url: resultUrl }).catch(() => {}); else $('#cp').click(); };
    $('#poster').onclick = () => {
      $('#print-area').innerHTML = `<div style="text-align:center;padding:20mm 10mm;font-family:var(--font)"><div class="seal" style="width:28mm;height:28mm;margin:0 auto 6mm;font-size:16pt;background:#1c5cab;color:#fff">${esc(st.orgShort)}</div>
        <div style="font-size:16pt;font-weight:800">${esc(st.orgName)}</div><div style="font-size:22pt;font-weight:800;margin:8mm 0 2mm;color:#1c5cab">NATIIJADA IMTIXAANKA ${esc(st.examYear)}</div>
        <div style="font-size:14pt">${esc(st.examTitle)}</div><div style="width:90mm;margin:10mm auto">${QR.svg(resultUrl, { border: 2 })}</div>
        <div style="font-size:15pt;font-weight:700">Sawir QR-ka ama gal:</div><div style="font-size:18pt;font-family:var(--mono);margin:3mm 0 8mm">${esc(resultUrl.replace(/^https?:\/\//, ''))}</div>
        <div style="font-size:13pt">Geli <b>Roll Number-kaaga</b> (kaarka imtixaanka) iyo <b>taleefanka waalidka</b>.</div></div>`;
      document.body.classList.add('printing-cards'); setTimeout(() => window.print(), 80);
    };

    // grade-yada
    const gt = $('#gt tbody');
    const bindDel = () => $$('[data-del]', gt).forEach((b) => (b.onclick = () => { if ($$('tr', gt).length > 2) b.closest('tr').remove(); }));
    bindDel();
    $('#gadd').onclick = () => { const tr = document.createElement('tr'); tr.innerHTML = '<td><input data-g="g" style="width:70px"></td><td><input data-g="min" inputmode="decimal" style="width:90px"></td><td><input data-g="label"></td><td><button type="button" class="btn sm danger" data-del>✕</button></td>'; gt.appendChild(tr); bindDel(); };
    $('#sf').onsubmit = async (e) => {
      e.preventDefault();
      const fd = formData(e.target);
      const grades = $$('tr', gt).map((tr) => ({ g: $('[data-g="g"]', tr).value, min: $('[data-g="min"]', tr).value, label: $('[data-g="label"]', tr).value })).filter((g) => g.g.trim());
      const body = { orgName: fd.orgName, orgShort: fd.orgShort, examYear: fd.examYear, examTitle: fd.examTitle, publicUrl: fd.publicUrl, passMark: fd.passMark, minAverage: fd.minAverage, maxFailed: fd.maxFailed, showRank: !!fd.showRank, parentNote: fd.parentNote, grades,
        advice: { top: fd.adv_top, good: fd.adv_good, pass: fd.adv_pass, fail: fd.adv_fail } };
      if (Number(fd.examYear) !== st.examYear && !confirm(`Sannadka imtixaanka waxaad u beddelaysaa ${fd.examYear}. Ardayda cusub waxay heli doonaan Roll Number-ka sannadkaas, falanqayntuna waxay muujin doontaa sannadkaas oo kaliya. Ma hubtaa?`)) return;
      try { const r = await api('POST', '/api/admin/settings', body); S.data.settings = r.settings; saveCache(); bump(); toast('Dejinta waa la kaydiyay'); render(); }
      catch (err) { $('#se').innerHTML = `<div class="banner bad">${esc(err.message)}</div>`; }
    };

    // dugsiyada
    const schoolForm = (s) => {
      s = s || {};
      const m = modal(s.id ? 'Wax ka beddel dugsiga' : 'Dugsi cusub', `<form id="scf">
        <label class="f"><span>Magaca dugsiga</span><input name="name" required value="${esc(s.name || '')}"></label>
        <div class="grid g2"><label class="f"><span>Koodka (gaaban, tusaale HWD)</span><input name="code" required maxlength="8" value="${esc(s.code || '')}"></label>
        <label class="f"><span>Gobolka / degmada</span><input name="region" value="${esc(s.region || '')}"></label></div>
        <div class="grid g2"><label class="f"><span>Maamulaha</span><input name="head" value="${esc(s.head || '')}"></label>
        <label class="f"><span>Taleefanka</span><input name="phone" type="tel" value="${esc(s.phone || '')}"></label></div>
        <div id="sce"></div><button class="btn primary block">Kaydi</button>
        ${s.id ? '<button type="button" class="btn danger block" id="scdel" style="margin-top:8px">Tirtir dugsiga</button>' : ''}</form>`);
      $('#scf', m.el).onsubmit = async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/admin/schools', Object.assign(formData(e.target), { id: s.id })); m.close(); await refresh(); toast('Waa la kaydiyay'); }
        catch (err) { $('#sce', m.el).innerHTML = `<div class="banner bad">${esc(err.message)}</div>`; }
      };
      const d = $('#scdel', m.el);
      if (d) d.onclick = async () => {
        if (!confirm('Ma hubtaa inaad tirtirto dugsigan?')) return;
        try { await api('DELETE', '/api/admin/schools/' + s.id); m.close(); await refresh(); } catch (err) { $('#sce', m.el).innerHTML = `<div class="banner bad">${esc(err.message)}</div>`; }
      };
    };
    $('#scadd').onclick = () => schoolForm();
    $$('[data-sc]').forEach((it) => (it.onclick = () => schoolForm(S.data.schools.find((s) => s.id === Number(it.dataset.sc)))));

    // maaddooyinka
    let subs = S.data.subjects.slice().sort((a, b) => a.sort - b.sort || a.id - b.id).map((s) => Object.assign({}, s));
    const drawSubs = () => {
      $('#sublist').innerHTML = subs.map((s, i) => `<div class="row" style="margin-bottom:6px;flex-wrap:nowrap"><input value="${esc(s.name)}" data-i="${i}" class="grow"><label class="chip ${s.active ? 'good' : 'muted'}" style="cursor:pointer"><input type="checkbox" data-a="${i}" ${s.active ? 'checked' : ''} style="width:auto;min-height:0;vertical-align:-2px"> ${s.active ? 'Firfircoon' : 'Joojisan'}</label><button class="btn sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button></div>`).join('');
      $$('[data-i]', $('#sublist')).forEach((inp) => (inp.oninput = () => { subs[inp.dataset.i].name = inp.value; }));
      $$('[data-a]', $('#sublist')).forEach((cb) => (cb.onchange = () => { subs[cb.dataset.a].active = cb.checked ? 1 : 0; drawSubs(); }));
      $$('[data-up]', $('#sublist')).forEach((b) => (b.onclick = () => { const i = Number(b.dataset.up); [subs[i - 1], subs[i]] = [subs[i], subs[i - 1]]; drawSubs(); }));
    };
    drawSubs();
    $('#subadd').onclick = () => { subs.push({ name: '', active: 1 }); drawSubs(); const l = $$('[data-i]', $('#sublist')); l[l.length - 1].focus(); };
    $('#subsave').onclick = async () => {
      try { await api('POST', '/api/admin/subjects', { subjects: subs.filter((s) => s.name.trim()) }); await refresh(); toast('Maaddooyinka waa la kaydiyay'); }
      catch (err) { toast(err.message, true); }
    };

    $('#pf').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/admin/password', formData(e.target)); S.defaultPw = false; e.target.reset(); toast('Furaha waa la beddelay'); }
      catch (err) { toast(err.message, true); }
    };
    $('#lo').onclick = () => { if (S.pending.length && !confirm(`${S.pending.length} isbeddel weli lama dirin. Haddii aad ka baxdo waa lumayaan. Ma hubtaa?`)) return; LS.del('data'); LS.del('pending'); S.pending = []; logout(); };
    $('#bk').onclick = async () => {
      try {
        const d = await api('GET', '/api/admin/backup');
        const blob = new Blob([JSON.stringify(d)], { type: 'application/json' });
        XLSX.download(blob, `GHDD-kayd-${new Date().toISOString().slice(0, 10)}.json`);
      } catch (err) { toast(err.message, true); }
    };
    $('#rs').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const d = JSON.parse(await f.text());
        if (d.kind !== 'ghdd-backup') throw new Error('Faylkan ma aha kayd GHDD.');
        const ok = prompt(`Kaydkan wuxuu leeyahay ${d.data.students.length} arday iyo ${d.data.marks.length} dhibic. Xogta hadda jirta waa la beddelayaa. Si aad u xaqiijiso qor: SOO CELI`);
        if (ok !== 'SOO CELI') return toast('Waa la joojiyay.');
        await api('POST', '/api/admin/restore', Object.assign(d, { confirm: 'SOO CELI' }));
        await refresh(); toast('Kaydka waa la soo celiyay');
      } catch (err) { toast(err.message, true); }
      e.target.value = '';
    };
    const ACT = { login: 'Gal', login_fail: 'Gal (furaha khaldan)', password_change: 'Furaha la beddelay', settings: 'Dejinta', release: 'Sii dayn / xirid', school_save: 'Dugsi', school_delete: 'Dugsi la tirtiray', subjects_save: 'Maaddooyinka', student_add: 'Arday cusub', student_bulk: 'Arday (Excel)', student_edit: 'Arday wax laga beddelay', student_status: 'Xaaladda ardayga', marks: 'Dhibco', restore: 'Kayd la soo celiyay' };
    $('#aud').onclick = async () => {
      try {
        const r = await api('GET', '/api/admin/audit');
        const desc = (a) => {
          const d = a.details || {};
          if (a.action === 'marks') return `${d.saved || 0} la kaydiyay, ${d.cleared || 0} la tirtiray (${d.source || ''})${d.items ? ': ' + d.items.slice(0, 6).map((x) => `${x.roll || x.s}: ${x.from == null ? '–' : x.from}→${x.to}`).join(', ') : ''}`;
          if (a.action === 'student_add') return `${d.roll} ${d.name}`;
          if (a.action === 'student_bulk') return `${d.created} la diiwaangeliyay, ${d.skipped} laga booday`;
          if (a.action === 'student_status') return `${d.roll} → ${d.status}`;
          if (a.action === 'student_edit') return `${d.roll}`;
          if (a.action === 'release') return `sii dayn: ${d.released ? 'haa' : 'maya'}, xiran: ${d.locked ? 'haa' : 'maya'}`;
          if (a.action === 'school_save') return `${d.code} ${d.name}`;
          return d.ip ? 'IP ' + d.ip : '';
        };
        $('#audit').innerHTML = `<div class="tbl-wrap" style="max-height:420px"><table class="tbl"><thead><tr><th>Waqtiga</th><th>Ficil</th><th>Faahfaahin</th></tr></thead><tbody>${r.rows.map((a) => `<tr><td class="small">${esc(dateStr(a.at))}</td><td>${esc(ACT[a.action] || a.action)}</td><td style="white-space:normal" class="small">${esc(desc(a))}</td></tr>`).join('')}</tbody></table></div>`;
      } catch (err) { toast(err.message, true); }
    };
  }

  // ---------- bilow ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (S.token) start(); else showLogin();
  setInterval(() => { if (S.pending.length) flush(); }, 30000);
})();
