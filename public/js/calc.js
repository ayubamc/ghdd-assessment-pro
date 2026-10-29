/* GHDD – xisaabinta natiijada iyo falanqaynta (waxaa isticmaala server-ka iyo browser-ka labadaba) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    orgName: 'GOLAHA HORMARINTA DUGSIYADA DADWEYNAHA (GHDD)',
    orgShort: 'GHDD',
    examTitle: 'Imtixaanka Dhammaystirka Dugsiga Sare – Fasalka 4aad',
    examYear: new Date().getFullYear(),
    passMark: 50,
    minAverage: 50,
    maxFailed: null,
    showRank: true,
    released: false,
    releasedAt: null,
    locked: false,
    grades: [
      { g: 'A', min: 80, label: 'Heer sare' },
      { g: 'B', min: 70, label: 'Aad u wanaagsan' },
      { g: 'C', min: 60, label: 'Wanaagsan' },
      { g: 'D', min: 50, label: 'Dhexdhexaad' },
      { g: 'E', min: 40, label: 'Hooseeya' },
      { g: 'F', min: 0, label: 'Aad u hooseeya' }
    ],
    advice: {
      top: 'Hambalyo! Natiijo heer sare ah ayaad keentay. Dadaalkaaga iyo anshaxaaga ayaa midho dhalay. Sii wad, mustaqbal ifaya ayaa ku sugaya.',
      good: 'Mahadsanid! Natiijo wanaagsan ayaad gaartay. Haddii aad xoogga saarto maaddooyinka aad ka hoosayso, heer ka sarreeya ayaad gaari kartaa.',
      pass: 'Waad gudubtay. Hase ahaatee, waxaa jira maaddooyin u baahan in aad xoojiso. Ku dadaal akhriska iyo ku celcelinta casharrada.',
      fail: 'Natiijadaadu waxay ka hoosaysaa heerka gudbitaanka. Ha quusan, fashilku dhammaad maaha. La tasho waalidkaaga iyo macallimiintaada, oo samee qorshe waxbarasho oo cusub.'
    },
    parentNote: 'Waalidka / masuulka ardayga: fadlan la xiriir xafiiska maamulka dugsiga si ardayga loo siiyo taageero dheeraad ah.'
  };

  const STATUS = {
    PASS: { label: 'GUDBAY', tone: 'good' },
    FAIL: { label: 'HARAY', tone: 'bad' },
    ABSENT: { label: 'MA FADHIISAN', tone: 'muted' },
    WITHHELD: { label: 'LA HAKIYAY', tone: 'warn' },
    INCOMPLETE: { label: 'WAA DHIMAN TAHAY', tone: 'muted' }
  };

  function withDefaults(s) {
    const out = Object.assign({}, DEFAULT_SETTINGS, s || {});
    out.advice = Object.assign({}, DEFAULT_SETTINGS.advice, (s && s.advice) || {});
    if (!Array.isArray(out.grades) || !out.grades.length) out.grades = DEFAULT_SETTINGS.grades;
    out.grades = out.grades.slice().sort((a, b) => b.min - a.min);
    return out;
  }

  const round1 = (n) => Math.round(n * 10) / 10;

  function gradeFor(score, grades) {
    if (score == null || isNaN(score)) return null;
    for (const g of grades) if (score >= g.min) return g;
    return grades[grades.length - 1];
  }

  // Dhibcaha la soo galiyay: number, "ABS"/"M" (maqan), "X" (khiyaano / la hakiyay), "" (tirtir)
  function parseMark(v) {
    if (v === null || v === undefined) return { clear: true };
    if (typeof v === 'number') return isFinite(v) && v >= 0 && v <= 100 ? { score: round1(v) } : { error: true };
    const t = String(v).trim().toUpperCase();
    if (t === '') return { clear: true };
    if (['ABS', 'M', 'MAQAN', 'A'].includes(t)) return { code: 'ABS' };
    if (['X', 'K', 'KHIYAANO', 'HAKAN'].includes(t)) return { code: 'X' };
    const n = Number(t.replace(',', '.'));
    if (!isFinite(n) || n < 0 || n > 100) return { error: true };
    return { score: round1(n) };
  }

  function normPhone(p) {
    const d = String(p || '').replace(/\D/g, '');
    return d.length >= 7 ? d.slice(-9) : '';
  }
  function normName(n) {
    return String(n || '').toLowerCase().replace(/[^a-z؀-ۿ0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }
  function titleCase(n) {
    return String(n || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }
  function normGender(g) {
    const t = String(g || '').trim().toLowerCase();
    if (['m', 'male', 'lab', 'wiil', 'w', 'boy', 'ragga', 'rag'].includes(t)) return 'Wiil';
    if (['f', 'female', 'dheddig', 'gabar', 'gabadh', 'g', 'girl', 'dumar'].includes(t)) return 'Gabar';
    return '';
  }

  function markIndex(marks) {
    const idx = new Map();
    for (const m of marks) {
      const sid = m[0];
      if (!idx.has(sid)) idx.set(sid, new Map());
      idx.get(sid).set(m[1], { score: m[2] == null ? null : Number(m[2]), code: m[3] || null });
    }
    return idx;
  }

  function computeStudent(st, sm, subjects, S) {
    const scores = [];
    let total = 0, entered = 0, abs = 0, withheld = false, failed = 0;
    for (const sub of subjects) {
      const m = sm && sm.get(sub.id);
      const row = { subjectId: sub.id, name: sub.name, score: null, code: null, grade: null, pass: null };
      if (m) {
        if (m.code === 'X') { row.code = 'X'; withheld = true; entered++; }
        else if (m.code === 'ABS') { row.code = 'ABS'; abs++; entered++; failed++; row.pass = false; }
        else if (m.score != null) {
          row.score = m.score; entered++; total += m.score;
          const g = gradeFor(m.score, S.grades);
          row.grade = g ? g.g : null;
          row.pass = m.score >= S.passMark;
          if (!row.pass) failed++;
        }
      }
      scores.push(row);
    }
    const n = subjects.length;
    let status;
    if (withheld) status = 'WITHHELD';
    else if (entered < n || n === 0) status = 'INCOMPLETE';
    else if (abs === n) status = 'ABSENT';
    else {
      const avg = total / n;
      const ok = avg >= S.minAverage && (S.maxFailed == null || S.maxFailed === '' || failed <= Number(S.maxFailed));
      status = ok ? 'PASS' : 'FAIL';
    }
    const sat = status === 'PASS' || status === 'FAIL';
    const avg = n ? round1(total / n) : 0;
    const g = sat ? gradeFor(avg, S.grades) : null;
    return {
      id: st.id, roll: st.roll_no, name: st.full_name, mother: st.mother_name, schoolId: st.school_id,
      gender: st.gender || '', year: st.exam_year, scores, entered, nSub: n, total: round1(total), avg,
      status, sat, grade: g ? g.g : null, gradeLabel: g ? g.label : '', failed,
      weak: scores.filter((r) => r.code === 'ABS' || (r.score != null && r.score < S.passMark)),
      strong: scores.filter((r) => r.score != null && r.score >= 80)
    };
  }

  function rankList(list) {
    list.sort((a, b) => b.total - a.total || a.roll.localeCompare(b.roll));
    let prev = null, rank = 0;
    list.forEach((r, i) => { if (r.total !== prev) { rank = i + 1; prev = r.total; } r._rank = rank; });
    return list;
  }

  // data: {settings, schools, subjects, students, marks}
  function computeAll(data, opts) {
    opts = opts || {};
    const S = withDefaults(data.settings);
    const year = Number(opts.year || S.examYear);
    const subjects = (data.subjects || []).filter((s) => s.active !== 0 && s.active !== false)
      .sort((a, b) => (a.sort - b.sort) || (a.id - b.id));
    const idx = markIndex(data.marks || []);
    const results = [];
    for (const st of data.students || []) {
      if (st.status !== 'active' || Number(st.exam_year) !== year) continue;
      results.push(computeStudent(st, idx.get(st.id), subjects, S));
    }
    const sat = results.filter((r) => r.sat);
    rankList(sat.slice()).forEach((r) => { r.rankAll = r._rank; delete r._rank; });
    const bySchool = new Map();
    for (const r of sat) { if (!bySchool.has(r.schoolId)) bySchool.set(r.schoolId, []); bySchool.get(r.schoolId).push(r); }
    for (const [, l] of bySchool) rankList(l).forEach((r) => { r.rankSchool = r._rank; r.countSchool = l.length; delete r._rank; });
    for (const r of sat) r.countAll = sat.length;
    return { S, year, subjects, results, byId: new Map(results.map((r) => [r.id, r])) };
  }

  function stats(arr) {
    const n = arr.length;
    if (!n) return { n: 0, mean: null, median: null, max: null, min: null, sd: null };
    const s = arr.slice().sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / n;
    const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    return { n, mean: round1(mean), median: round1(median), max: s[n - 1], min: s[0], sd: round1(sd) };
  }
  const pct = (a, b) => (b ? round1((a / b) * 100) : 0);

  function gradeCounts(list, key, grades) {
    const c = {}; grades.forEach((g) => (c[g.g] = 0));
    list.forEach((x) => { const g = key(x); if (g && c[g] != null) c[g]++; });
    return c;
  }

  // Falanqaynta oo dhan. opts: {year, schoolId}
  function analytics(data, opts) {
    opts = opts || {};
    const C = computeAll(data, opts);
    const { S, subjects } = C;
    const schools = (data.schools || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    const schoolName = new Map(schools.map((s) => [s.id, s.name]));
    const all = C.results;
    const scope = opts.schoolId ? all.filter((r) => r.schoolId === Number(opts.schoolId)) : all;
    const sat = scope.filter((r) => r.sat);
    const passed = sat.filter((r) => r.status === 'PASS');
    const avgStats = stats(sat.map((r) => r.avg));
    const count = (st) => scope.filter((r) => r.status === st).length;

    const kpi = {
      registered: scope.length, sat: sat.length, passed: passed.length, failed: sat.length - passed.length,
      passRate: pct(passed.length, sat.length), absent: count('ABSENT'), withheld: count('WITHHELD'),
      incomplete: count('INCOMPLETE'), mean: avgStats.mean, median: avgStats.median, max: avgStats.max, min: avgStats.min
    };

    // Heer dugsi (had iyo jeer dugsiyada oo dhan si loo isbarbardhigo)
    const schoolRows = schools.map((sc) => {
      const l = all.filter((r) => r.schoolId === sc.id);
      const ls = l.filter((r) => r.sat);
      const lp = ls.filter((r) => r.status === 'PASS');
      const st = stats(ls.map((r) => r.avg));
      const best = ls.slice().sort((a, b) => b.total - a.total)[0];
      const g = (gen) => { const x = ls.filter((r) => r.gender === gen); return { sat: x.length, passed: x.filter((r) => r.status === 'PASS').length, rate: pct(x.filter((r) => r.status === 'PASS').length, x.length) }; };
      const subjMeans = {};
      subjects.forEach((sub) => {
        const v = ls.map((r) => r.scores.find((s) => s.subjectId === sub.id)).filter((s) => s && s.score != null).map((s) => s.score);
        subjMeans[sub.id] = stats(v).mean;
      });
      return {
        id: sc.id, code: sc.code, name: sc.name, registered: l.length, sat: ls.length, passed: lp.length,
        failed: ls.length - lp.length, passRate: pct(lp.length, ls.length), mean: st.mean, median: st.median,
        max: st.max, min: st.min, grades: gradeCounts(ls, (r) => r.grade, S.grades),
        best: best ? { name: best.name, roll: best.roll, avg: best.avg, grade: best.grade } : null,
        boys: g('Wiil'), girls: g('Gabar'), subjMeans,
        incomplete: l.filter((r) => r.status === 'INCOMPLETE').length
      };
    });
    const ranked = schoolRows.filter((s) => s.sat).sort((a, b) => b.mean - a.mean);
    ranked.forEach((s, i) => (s.rank = i + 1));

    // Heer maaddo
    const subjectRows = subjects.map((sub) => {
      const entries = sat.map((r) => ({ r, s: r.scores.find((x) => x.subjectId === sub.id) })).filter((e) => e.s);
      const nums = entries.filter((e) => e.s.score != null);
      const st = stats(nums.map((e) => e.s.score));
      const p = nums.filter((e) => e.s.score >= S.passMark).length;
      const best = nums.slice().sort((a, b) => b.s.score - a.s.score)[0];
      const perSchool = {};
      schools.forEach((sc) => {
        const v = nums.filter((e) => e.r.schoolId === sc.id).map((e) => e.s.score);
        perSchool[sc.id] = stats(v).mean;
      });
      return {
        id: sub.id, name: sub.name, n: st.n, absent: entries.filter((e) => e.s.code === 'ABS').length,
        mean: st.mean, median: st.median, max: st.max, min: st.min, sd: st.sd,
        passed: p, failed: st.n - p, passRate: pct(p, st.n), grades: gradeCounts(nums, (e) => e.s.grade, S.grades),
        best: best ? { name: best.r.name, roll: best.r.roll, score: best.s.score } : null, perSchool
      };
    });

    const gender = {};
    ['Wiil', 'Gabar'].forEach((gen) => {
      const x = sat.filter((r) => r.gender === gen);
      const xp = x.filter((r) => r.status === 'PASS').length;
      gender[gen] = { registered: scope.filter((r) => r.gender === gen).length, sat: x.length, passed: xp, rate: pct(xp, x.length), mean: stats(x.map((r) => r.avg)).mean };
    });

    const hist = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i === 9 ? 100 : i * 10 + 9, n: 0 }));
    sat.forEach((r) => { hist[Math.min(9, Math.floor(r.avg / 10))].n++; });

    const top = sat.slice().sort((a, b) => b.total - a.total).slice(0, 10)
      .map((r) => ({ id: r.id, name: r.name, roll: r.roll, school: schoolName.get(r.schoolId) || '', total: r.total, avg: r.avg, grade: r.grade, rank: r.rankAll }));
    const topBySchool = schools.map((sc) => ({
      school: sc.name,
      list: all.filter((r) => r.sat && r.schoolId === sc.id).sort((a, b) => b.total - a.total).slice(0, 3)
        .map((r) => ({ name: r.name, roll: r.roll, avg: r.avg, grade: r.grade }))
    })).filter((x) => x.list.length);

    const gradeDist = gradeCounts(sat, (r) => r.grade, S.grades);

    // Gunaanad qoraal ah
    const insights = [];
    if (sat.length) {
      insights.push(`Ardayda imtixaanka fadhiisatay waa ${sat.length}; waxaa gudbay ${passed.length} (${kpi.passRate}%), waxaana haray ${kpi.failed}.`);
      insights.push(`Celceliska guud waa ${kpi.mean}%; ardayga ugu sarreeya wuxuu helay ${kpi.max}%, kan ugu hooseeyana ${kpi.min}%.`);
      if (!opts.schoolId && ranked.length > 1) {
        const a = ranked[0], b = ranked[ranked.length - 1];
        insights.push(`Dugsiga celceliskiisu ugu sarreeyo waa ${a.name} (${a.mean}%, gudbitaan ${a.passRate}%); kan ugu hooseeyana waa ${b.name} (${b.mean}%, gudbitaan ${b.passRate}%).`);
      }
      const sr = subjectRows.filter((s) => s.n).sort((a, b) => b.mean - a.mean);
      if (sr.length > 1) {
        insights.push(`Maaddada natiijadeedu ugu wanaagsan tahay waa ${sr[0].name} (celcelis ${sr[0].mean}%); tan ugu hooseysana waa ${sr[sr.length - 1].name} (celcelis ${sr[sr.length - 1].mean}%).`);
      }
      const weakSubs = sr.filter((s) => s.passRate < 50).map((s) => `${s.name} (${s.passRate}%)`);
      if (weakSubs.length) insights.push(`Maaddooyinka in ka badan kala badh ardaydu ka dhaceen: ${weakSubs.join(', ')}. Waxay u baahan yihiin dib-u-eegis manhaj iyo taageero macallin.`);
      const gw = gender.Wiil, gg = gender.Gabar;
      if (gw.sat && gg.sat) insights.push(`Wiilasha ${gw.rate}% ayaa gudbay (celcelis ${gw.mean}%), gabdhahana ${gg.rate}% (celcelis ${gg.mean}%).`);
      if (top[0]) insights.push(`Ardayga kaalinta 1aad galay waa ${top[0].name} (${top[0].school}) oo celcelis ${top[0].avg}% ah.`);
    }
    if (kpi.incomplete) insights.push(`Digniin: ${kpi.incomplete} arday natiijadoodu weli waa dhiman tahay (maaddooyin aan dhibco loo gelin).`);

    return { S, year: C.year, subjects, kpi, schools: schoolRows, subjectsStats: subjectRows, gender, hist, top, topBySchool, gradeDist, insights, results: scope };
  }

  function adviceFor(r, S) {
    S = withDefaults(S);
    let level = 'fail';
    if (r.status === 'PASS') level = r.avg >= 80 ? 'top' : r.avg >= 65 ? 'good' : 'pass';
    return {
      level,
      message: S.advice[level],
      weakTitle: `Maaddooyinka u baahan taageero (ka hooseeya ${S.passMark}%)`,
      strongTitle: 'Maaddooyinka uu ku fiican yahay (80% iyo wixii ka sarreeya)',
      parentNote: r.weak.length ? S.parentNote : ''
    };
  }

  return { DEFAULT_SETTINGS, STATUS, withDefaults, gradeFor, parseMark, normPhone, normName, normGender, titleCase, computeAll, analytics, adviceFor, stats, round1 };
});
