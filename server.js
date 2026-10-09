
import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '40mb' }));

// Find the web app folder.
const publicCandidates = [
  path.join(__dirname, 'Public'),
  path.join(__dirname, 'public'),
  path.join(process.cwd(), 'Public'),
  path.join(process.cwd(), 'public'),
  '/app/Public',
  '/app/public'
];

const PUBLIC_DIR = publicCandidates.find(dir =>
  fs.existsSync(path.join(dir, 'index.html'))
);

if (PUBLIC_DIR) {
  console.log(`Serving web files from: ${PUBLIC_DIR}`);
  app.use(express.static(PUBLIC_DIR));
} else {
  console.error('Could not find index.html in Public/public.');
}

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('railway')
        ? { rejectUnauthorized: false }
        : false
    })
  : null;

async function db(sql, params = []) {
  if (!pool) throw new Error('PostgreSQL is not configured.');
  return pool.query(sql, params);
}

async function initDb() {
  if (!pool) return;

  await db(`CREATE TABLE IF NOT EXISTS assessments (
    id TEXT PRIMARY KEY,
    title TEXT,
    subject TEXT,
    klass TEXT,
    total_marks INT,
    duration TEXT,
    school TEXT,
    blueprint JSONB,
    data JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await db(`CREATE TABLE IF NOT EXISTS question_bank (
    id TEXT PRIMARY KEY,
    subject TEXT,
    klass TEXT,
    unit TEXT,
    topic TEXT,
    lo TEXT,
    bloom TEXT,
    difficulty TEXT,
    type TEXT,
    marks INT,
    question TEXT,
    answer TEXT,
    options JSONB,
    source TEXT,
    status TEXT DEFAULT 'Approved',
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await db(`CREATE TABLE IF NOT EXISTS item_analysis (
    id TEXT PRIMARY KEY,
    assessment_id TEXT,
    data JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await db(`CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);

  // PDF library: stores original PDFs and OCR text by page.
  await db(`CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subject TEXT,
    filename TEXT,
    page_count INT NOT NULL,
    pdf BYTEA NOT NULL,
    pages JSONB NOT NULL,
    text_chars INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
}

initDb().catch(error => console.error('Database setup failed:', error));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

function auth(req, res, next) {
  if (req.path === '/api/health') return next();

  if ((req.headers['x-admin-password'] || '') !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

app.use('/api', auth);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'GHDD Assessment Pro',
    version: '3.0',
    databaseEnabled: !!pool
  });
});

app.post('/api/login', (req, res) => {
  res.json({
    ok: (req.body?.password || '') === ADMIN_PASSWORD
  });
});

// Save and load the existing application state.
app.get('/api/state', async (req, res) => {
  try {
    const result = await db(
      'SELECT data, updated_at FROM app_state WHERE id = $1',
      [1]
    );

    res.json({
      ok: true,
      state: result.rows[0]?.data || null,
      updatedAt: result.rows[0]?.updated_at || null,
      databaseEnabled: !!pool
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/state', async (req, res) => {
  try {
    const state = req.body?.state;

    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return res.status(400).json({
        error: 'A valid state object is required.'
      });
    }

    await db(
      `INSERT INTO app_state (id, data, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [1, JSON.stringify(state)]
    );

    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function uid() {
  return crypto.randomUUID();
}

const blooms = [
  'Remember',
  'Understand',
  'Apply',
  'Analyze',
  'Evaluate',
  'Create'
];

function qualityCheck(question) {
  const issues = [];
  const warnings = [];
  let score = 100;

  const text = String(question.question || '').trim();

  if (text.length < 15) {
    issues.push('Question may be too short.');
    score -= 20;
  }

  if (!String(question.answer || '').trim()) {
    issues.push('Model answer is missing.');
    score -= 25;
  }

  if (question.type === 'MCQ') {
    const options = Array.isArray(question.options)
      ? question.options
      : [];

    if (options.length !== 4) {
      issues.push('MCQ should have four options.');
      score -= 15;
    }

    if (new Set(options.map(x => String(x).trim().toLowerCase())).size
        !== options.length) {
      issues.push('Duplicate options detected.');
      score -= 15;
    }
  }

  if (!blooms.includes(question.bloom)) {
    warnings.push('Bloom level is missing or invalid.');
    score -= 5;
  }

  return {
    score: Math.max(0, score),
    status: score >= 90
      ? 'Excellent'
      : score >= 75
        ? 'Review recommended'
        : 'Needs revision',
    issues,
    warnings
  };
}

// PDF BOOK LIBRARY

app.get('/api/books', async (req, res) => {
  try {
    const result = await db(
      `SELECT id, title, subject, filename, page_count,
              text_chars, created_at
       FROM books ORDER BY created_at DESC`
    );

    res.json({ books: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save the PDF and the OCR text supplied by the front end.
app.post('/api/books', async (req, res) => {
  try {
    const data = req.body || {};

    if (!data.title || !data.pdfBase64 ||
        !Array.isArray(data.pages) || !data.pages.length) {
      return res.status(400).json({
        error: 'Book title, PDF file and OCR page text are required.'
      });
    }

    const pdfBuffer = Buffer.from(data.pdfBase64, 'base64');

    if (pdfBuffer.length > 25 * 1024 * 1024) {
      return res.status(413).json({
        error: 'PDF must be 25 MB or smaller.'
      });
    }

    const pages = data.pages.map(page => ({
      page: Number(page.page),
      text: String(page.text || '').slice(0, 100000)
    }));

    const textChars = pages.reduce(
      (total, page) => total + page.text.length,
      0
    );

    const id = uid();

    await db(
      `INSERT INTO books
       (id, title, subject, filename, page_count, pdf, pages, text_chars)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        String(data.title).slice(0, 250),
        String(data.subject || '').slice(0, 150),
        String(data.filename || 'book.pdf').slice(0, 250),
        Number(data.pageCount) || pages.length,
        pdfBuffer,
        JSON.stringify(pages),
        textChars
      ]
    );

    res.json({
      ok: true,
      id,
      title: data.title,
      pageCount: pages.length,
      textChars
    });
  } catch (error) {
    console.error('Book save failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Retrieve OCR text only for the requested page range.
app.get('/api/books/:id/text', async (req, res) => {
  try {
    const start = Math.max(1, Number(req.query.start) || 1);
    const end = Math.max(start, Number(req.query.end) || 100000);

    const result = await db(
      'SELECT id, title, page_count, pages FROM books WHERE id = $1',
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Book not found.' });
    }

    const book = result.rows[0];

    res.json({
      id: book.id,
      title: book.title,
      pageCount: book.page_count,
      pages: (book.pages || []).filter(
        page => page.page >= start && page.page <= end
      )
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download the original saved PDF.
app.get('/api/books/:id/pdf', async (req, res) => {
  try {
    const result = await db(
      'SELECT filename, pdf FROM books WHERE id = $1',
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Book not found.' });
    }

    res.type('application/pdf')
      .attachment(result.rows[0].filename || 'book.pdf')
      .send(result.rows[0].pdf);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/books/:id', async (req, res) => {
  try {
    const result = await db(
      'DELETE FROM books WHERE id = $1',
      [req.params.id]
    );

    res.json({ ok: true, deleted: result.rowCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI question generation from selected source pages.
async function aiGenerate(payload) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is missing from Railway Variables.'
    );
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const prompt = `
You are an expert secondary-school examination designer.
Use ONLY the supplied source text.
Generate exactly ${payload.count} questions.
Follow Bloom's taxonomy and the requested blueprint.
Do not invent facts that are absent from the source.
Avoid duplicate, ambiguous or trivial questions.
For MCQs, provide four plausible options and one correct answer.
Include a model answer, marks, Bloom level and difficulty.
Return valid JSON only in this format:
{"questions":[
 {"type":"MCQ","question":"...","answer":"...",
  "options":["A","B","C","D"],"bloom":"Remember",
  "difficulty":"Moderate","marks":1,"topic":"..."}
]}
Subject: ${payload.subject || ''}
Class: ${payload.klass || ''}
Question count: ${payload.count}
Question type: ${payload.type || 'Mixed'}
Bloom levels: ${(payload.bloomMix || blooms).join(', ')}
Difficulty: ${(payload.difficultyMix || ['Moderate']).join(', ')}
Source text:
${String(payload.sourceText || '').slice(0, 70000)}
`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: prompt }] }
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.25,
          maxOutputTokens: 12000
        }
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result?.error?.message || 'AI generation failed.');
  }

  const raw = (result.candidates?.[0]?.content?.parts || [])
    .map(part => part.text || '')
    .join('');

  return JSON.parse(raw).questions || [];
}

app.post('/api/generate', async (req, res) => {
  try {
    const payload = req.body || {};

    if (!payload.sourceText?.trim()) {
      return res.status(400).json({
        error: 'Select a saved book and valid page range first.'
      });
    }

    const count = Math.max(
      1,
      Math.min(100, Number(payload.count) || 10)
    );

    const questions = await aiGenerate({
      ...payload,
      count,
      bloomMix: payload.bloomMix || blooms,
      difficultyMix: payload.difficultyMix || ['Moderate']
    });

    const checked = questions.map(question => ({
      ...question,
      id: question.id || uid(),
      quality: qualityCheck(question),
      status: 'Draft'
    }));

    res.json({
      questions: checked,
      totalMarks: checked.reduce(
        (total, question) => total + Number(question.marks || 0),
        0
      ),
      aiUsed: true
    });
  } catch (error) {
    console.error('Question generation failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save generated exams.
app.post('/api/assessments', async (req, res) => {
  try {
    const data = req.body || {};
    const id = uid();

    await db(
      `INSERT INTO assessments
       (id,title,subject,klass,total_marks,duration,school,blueprint,data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        data.title || 'Untitled Exam',
        data.subject || '',
        data.klass || '',
        Number(data.totalMarks) || 0,
        data.duration || '',
        data.school || 'GHDD',
        JSON.stringify(data.blueprint || {}),
        JSON.stringify(data.data || {})
      ]
    );

    res.json({ ok: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/assessments', async (req, res) => {
  try {
    const result = await db(
      `SELECT id,title,subject,klass,total_marks,duration,school,created_at
       FROM assessments ORDER BY created_at DESC LIMIT 100`
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save and retrieve the question bank.
app.post('/api/question-bank', async (req, res) => {
  try {
    const question = req.body || {};
    const id = question.id || uid();

    await db(
      `INSERT INTO question_bank
       (id,subject,klass,unit,topic,lo,bloom,difficulty,type,marks,
        question,answer,options,source,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
       question=EXCLUDED.question,
       answer=EXCLUDED.answer,
       options=EXCLUDED.options,
       status=EXCLUDED.status`,
      [
        id, question.subject || '', question.klass || '',
        question.unit || '', question.topic || '',
        question.learningOutcome || '', question.bloom || '',
        question.difficulty || '', question.type || '',
        Number(question.marks) || 1, question.question || '',
        question.answer || '', JSON.stringify(question.options || null),
        question.source || '', question.status || 'Approved'
      ]
    );

    res.json({ ok: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/question-bank', async (req, res) => {
  try {
    const result = await db(
      'SELECT * FROM question_bank ORDER BY created_at DESC LIMIT 300'
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Item analysis.
app.post('/api/item-analysis', (req, res) => {
  const { students = [], questions = [] } = req.body || {};

  const rows = questions.map((question, index) => {
    const values = students.map(
      student => Number(student.answers?.[index]) === 1 ? 1 : 0
    );

    const difficulty = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;

    return {
      number: index + 1,
      question: question.question,
      difficultyIndex: Math.round(difficulty * 100)
    };
  });

  res.json({
    items: rows,
    summary: { totalQuestions: rows.length }
  });
});

// Serve the app.
app.get('*', (req, res) => {
  if (PUBLIC_DIR && fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }

  res.status(500).type('text').send(
    'GHDD Assessment Pro: index.html was not found. Check the Public folder.'
  );
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`GHDD Assessment Pro running on port ${port}`);
});
