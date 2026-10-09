
'use strict';

let currentQuestions = [];
let adminPassword = '';

const $ = id => document.getElementById(id);

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (adminPassword) {
    headers['x-admin-password'] = adminPassword;
  }

  const response = await fetch('/api' + path, {
    ...options,
    headers
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || 'Codsiga waa fashilmay.');
  }

  return result;
}

function showMessage(message, type = '') {
  let box = $('app-message');

  if (!box) {
    box = document.createElement('div');
    box.id = 'app-message';
    box.className = 'status-message';
    box.setAttribute('role', 'status');

    const main = document.querySelector('.app-main');
    if (main) {
      main.prepend(box);
    }
  }

  box.textContent = message;
  box.className = 'status-message' + (type ? ' ' + type : '');
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function getExamDetails() {
  return {
    title: $('exam-title')?.value.trim() || '',
    subject: $('exam-subject')?.value.trim() || '',
    klass: $('exam-class')?.value.trim() || '',
    duration: $('exam-duration')?.value.trim() || '',
    school: 'Golaha Horumarinta Dugsiyada Dadweynaha (GHDD)'
  };
}

function renderQuestions() {
  const output = $('questions-list');
  if (!output) return;

  if (!currentQuestions.length) {
    output.textContent = 'Weli lama diyaarin su’aalo.';
    return;
  }

  output.innerHTML = currentQuestions.map((q, index) => `
    <article class="question-item">
      <p><strong>${index + 1}. ${escapeHTML(q.question)}</strong></p>
      <p>Maado: ${escapeHTML(q.subject)}</p>
      <p>Fasalka: ${escapeHTML(q.klass)}</p>
      <p>Dhibcaha: ${q.marks}</p>
      <label for="answer-${index}">Jawaabta / Tilmaamaha sixidda</label>
      <textarea id="answer-${index}" rows="2"
        data-answer-index="${index}"
        placeholder="Geli jawaabta saxda ah ama marking guide">${escapeHTML(q.answer || '')}</textarea>
    </article>
  `).join('');
}

function makeQuestionsFromText(text) {
  const sentences = text
    .replace(/\r/g, '\n')
    .split(/[\n.!?؟]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 20);

  const unique = [...new Set(sentences)];

  return unique.slice(0, 10).map((sentence, index) => ({
    question: 'Sharax ama ka hadal qodobkan: ' + sentence,
    answer: '',
    marks: 2,
    subject: getExamDetails().subject,
    klass: getExamDetails().klass,
    type: 'Short answer',
    source: 'Teacher-provided text'
  }));
}

async function loginIfNeeded() {
  if (adminPassword) return true;

  const password = window.prompt(
    'Geli ADMIN_PASSWORD-ka aad ku dejisay Railway Variables si xogta loo kaydiyo:'
  );

  if (password === null || !password.trim()) {
    showMessage('Kaydinta waa la joojiyey. Wax xog ah lama dirin.', 'error');
    return false;
  }

  try {
    const result = await api('/login', {
      method: 'POST',
      body: JSON.stringify({ password })
    });

    if (!result.ok) {
      showMessage('Furaha maamulka waa khalad.', 'error');
      return false;
    }

    adminPassword = password;
    showMessage('Waad gashay. Waxaad hadda adeegsan kartaa API-ga.', 'success');
    return true;
  } catch (error) {
    showMessage(error.message, 'error');
    return false;
  }
}

async function saveExam() {
  if (!currentQuestions.length) {
    showMessage('Marka hore diyaari su’aalaha imtixaanka.', 'error');
    return;
  }

  const details = getExamDetails();

  if (!details.title || !details.subject || !details.klass) {
    showMessage('Geli magaca imtixaanka, maadada iyo fasalka.', 'error');
    return;
  }

  const totalMarks = currentQuestions.reduce(
    (sum, q) => sum + Number(q.marks || 0), 0
  );

  const answers = currentQuestions.map((q, index) => ({
    ...q,
    answer: $(`answer-${index}`)?.value || q.answer || ''
  }));

  if (!(await loginIfNeeded())) return;

  try {
    const result = await api('/assessments', {
      method: 'POST',
      body: JSON.stringify({
        ...details,
        totalMarks,
        data: { questions: answers }
      })
    });

    showMessage(
      'Imtixaanka waa la kaydiyey. Aqoonsiga: ' + result.id,
      'success'
    );
  } catch (error) {
    showMessage('Kaydinta imtixaanka way fashilantay: ' + error.message, 'error');
  }
}

async function saveQuestionsToBank() {
  if (!currentQuestions.length) {
    showMessage('Ma jiraan su’aalo la kaydinayo.', 'error');
    return;
  }

  if (!(await loginIfNeeded())) return;

  try {
    for (const question of currentQuestions) {
      await api('/question-bank', {
        method: 'POST',
        body: JSON.stringify(question)
      });
    }

    showMessage('Su’aalaha waxaa lagu kaydiyey Question Bank.', 'success');
    await loadBank();
  } catch (error) {
    showMessage('Kaydinta su’aalaha way fashilantay: ' + error.message, 'error');
  }
}

async function loadBank() {
  const output = $('question-bank-content');
  if (!output) return;

  if (!(await loginIfNeeded())) return;

  try {
    const rows = await api('/question-bank');

    if (!rows.length) {
      output.textContent = 'Kaydka su’aaluhu weli waa madhan yahay.';
      return;
    }

    output.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Maado</th>
              <th>Fasal</th>
              <th>Su’aal</th>
              <th>Dhibco</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(q => `
              <tr>
                <td>${escapeHTML(q.subject)}</td>
                <td>${escapeHTML(q.klass)}</td>
                <td>${escapeHTML(q.question)}</td>
                <td>${escapeHTML(q.marks)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (error) {
    output.textContent = 'Lama soo qaadi karin Question Bank: ' + error.message;
  }
}

async function loadRecent() {
  const output = $('blueprint-content');
  if (!output) return;

  if (!(await loginIfNeeded())) return;

  try {
    const rows = await api('/assessments');

    if (!rows.length) {
      output.textContent = 'Weli ma jiraan imtixaanno kaydsan.';
      return;
    }

    output.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Imtixaan</th>
              <th>Maado</th>
              <th>Fasal</th>
              <th>Dhibco</th>
              <th>Taariikh</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(item => `
              <tr>
                <td>${escapeHTML(item.title)}</td>
                <td>${escapeHTML(item.subject)}</td>
                <td>${escapeHTML(item.klass)}</td>
                <td>${escapeHTML(item.total_marks)}</td>
                <td>${escapeHTML(item.created_at || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (error) {
    output.textContent = 'Lama soo qaadi karin imtixaannada: ' + error.message;
  }
}

function analyzeQuestions() {
  const output = $('analysis-content');
  if (!output) return;

  if (!currentQuestions.length) {
    output.textContent = 'Marka hore diyaari su’aalaha imtixaanka.';
    return;
  }

  const total = currentQuestions.reduce(
    (sum, q) => sum + Number(q.marks || 0), 0
  );

  output.innerHTML = `
    <div class="question-item">
      <p>Tirada su’aalaha: <strong>${currentQuestions.length}</strong></p>
      <p>Wadarta dhibcaha: <strong>${total}</strong></p>
      <p>
        Hubi in su’aaluhu daboolayaan ujeeddooyinka waxbarashada,
        heerarka garashada iyo mawduucyada casharka.
      </p>
      <p>
        Falanqayntan waa mid hordhac ah; ma aha cabbir cilmiyeed
        oo lagu xaqiijiyey adkaanta ama kala-soocidda su’aalaha.
      </p>
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', function () {
  const generateButton = $('generate-questions');

  if (generateButton) {
    generateButton.addEventListener('click', function () {
      const text = $('source-text')?.value.trim() || '';

      if (text.length < 20) {
        showMessage('Fadlan geli qoraal ama cashar ku filan.', 'error');
        return;
      }

      currentQuestions = makeQuestionsFromText(text);

      if (!currentQuestions.length) {
        showMessage('Qoraalka lagama soo saari karin su’aalo hordhac ah.', 'error');
        return;
      }

      renderQuestions();
      showMessage(
        currentQuestions.length +
        ' su’aalood oo hordhac ah ayaa la diyaariyey. Dib u eeg oo sax ka hor isticmaalka.',
        'success'
      );
    });
  }

  const builder = $('builder');

  if (builder) {
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.textContent = 'Kaydi Imtixaanka';
    saveButton.style.marginRight = '10px';
    saveButton.addEventListener('click', saveExam);

    const bankButton = document.createElement('button');
    bankButton.type = 'button';
    bankButton.textContent = 'Ku kaydi Question Bank';
    bankButton.addEventListener('click', saveQuestionsToBank);

    const container = builder.querySelector('#generated-questions');

    if (container) {
      container.append(saveButton, bankButton);
    }
  }

  document.querySelectorAll('.main-nav [data-tab]').forEach(button => {
    button.addEventListener('click', async function () {
      const target = button.dataset.tab;

      if (target === 'bank') await loadBank();
      if (target === 'blueprint') await loadRecent();
      if (target === 'analysis') analyzeQuestions();
    });
  });

  console.log('GHDD Assessment Pro frontend initialized.');
});
