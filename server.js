
import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '15mb' }));

// Find the public folder reliably on Railway.
const publicCandidates = [
  path.join(__dirname, 'public'),
  path.join(process.cwd(), 'public'),
  '/app/public'
];

const PUBLIC_DIR = publicCandidates.find(dir =>
  fs.existsSync(path.join(dir, 'index.html'))
);

if (PUBLIC_DIR) {
  console.log(`Serving web files from: ${PUBLIC_DIR}`);
  app.use(express.static(PUBLIC_DIR));
} else {
  console.error(
    'PUBLIC DIRECTORY ERROR. Checked:',
    publicCandidates.join(', ')
  );
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
  if (!pool) throw new Error('DATABASE_URL is not configured');
  return pool.query(sql, params);
}

async function initDb() {
  if (!pool) {
    console.warn('DATABASE_URL is missing. Database features are disabled.');
    return;
  }

  await db(`
    CREATE TABLE IF NOT EXISTS assessments (
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
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS question_bank (
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
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS item_analysis (
      id TEXT PRIMARY KEY,
      assessment_id TEXT,
      data JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  console.log('Database tables are ready.');
}

initDb().catch(err => console.error('Database initialization failed:', err));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

function auth(req, res, next) {
  if (req.path === '/health') return next();

  if ((req.headers['x-admin-password'] || '') !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'GHDD Assessment Pro',
    version: '2.0',
    publicFilesFound: Boolean(PUBLIC_DIR),
    databaseConfigured: Boolean(pool)
  });
});

app.post('/api/login', (req, res) => {
  res.json({
    ok: (req.body?.password || '') === ADMIN_PASSWORD
  });
});

app.use('/api', auth);

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

function qualityCheck(q) {
  const issues = [];
  const warnings = [];
  let score = 100;

  const text = String(q.question || q.text || '').trim();

  if (text.length < 15) {
    issues.push('Question is too short');
    score -= 20;
  }

  if (!q.answer || !String(q.answer).trim()) {
    issues.push('Missing model answer');
    score -= 25;
  }

  if (q.type === 'MCQ') {
    const opts = Array.isArray(q.options) ? q.options : [];

    if (opts.length !== 4) {
      issues.push('MCQ should have exactly four options');
      score -= 15;
    }

    const answer = String(q.answer || '').trim();

    if (opts.filter(x => String(x).trim() === answer).length !== 1) {
      issues.push('Check that exactly one option matches the correct answer');
      score -= 20;
    }

    if (new Set(opts.map(x => String(x).trim().toLowerCase())).size !== opts.length) {
      issues.push('Duplicate options detected');
      score -= 15;
    }
  }

  if (!blooms.includes(q.bloom)) {
    warnings.push('Check Bloom level');
    score -= 5;
  }

  if (!['Easy', 'Moderate', 'Difficult'].includes(q.difficulty)) {
    warnings.push('Difficulty is not set');
    score -= 5;
  }

  if (/all of the above|none of the above/i.test(text)) {
    warnings.push('Review potentially clue-prone wording');
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

function similarity(a, b) {
  const A = new Set(a.split(/\s+/).filter(Boolean));
  const B = new Set(b.split(/\s+/).filter(Boolean));

  let intersection = 0;
  for (const word of A) {
    if (B.has(word)) intersection++;
  }

  return intersection / (A.size + B.size - intersection || 1);
}

function heuristicGenerate(payload) {
  const lines = String(payload.sourceText || '')
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean);

  return Array.from({ length: payload.count }, (_, i) => ({
    id: uid(),
    type: payload.type || 'Short Answer',
    question: lines[i]
      ? `Using the source, explain: ${lines[i]}`
      : `Explain an important concept from ${payload.topic || payload.subject || 'the lesson'}.`,
    answer: 'Teacher must verify and complete the model answer from the source.',
    options: null,
    bloom: payload.bloomMix?.[i % (payload.bloomMix.length || 1)] || 'Understand',
    difficulty: payload.difficultyMix?.[i % (payload.difficultyMix.length || 1)] || 'Moderate',
    marks: payload.marks || 1,
    unit: payload.unit || '',
    topic: payload.topic || '',
    learningOutcome: payload.learningOutcome || '',
    source: 'User-provided source',
    status: 'Draft'
  }));
}

async function aiGenerate(payload) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const prompt = `
You are an expert secondary-school assessment designer.
Create exactly ${payload.count} questions using ONLY the source below.
Follow the requested subject, learning outcome, Bloom levels, difficulty,
question type, and marks. Avoid duplication and ambiguous wording.
For MCQ, provide four plausible options and one correct answer.
Return JSON only in this format:
{"questions":[{"type":"MCQ","question":"...","answer":"...","options":["A","B","C","D"],"bloom":"Understand","difficulty":"Moderate","marks":1,"unit":"...","topic":"...","learningOutcome":"...","source":"..."}]}

Subject: ${payload.subject || ''}
Class: ${payload.klass || ''}
Question type: ${payload.type || ''}
Unit: ${payload.unit || ''}
Topic: ${payload.topic || ''}
Learning outcome: ${payload.learningOutcome || ''}
Bloom levels: ${(payload.bloomMix || []).join(', ')}
Difficulty: ${(payload.difficultyMix || []).join(', ')}
Marks per question: ${payload.marks || 1}

SOURCE:
${String(payload.sourceText || '').slice(0, 50000)}
`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
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
    throw new Error(result?.error?.message || 'AI request failed');
  }

  const raw = (result.candidates?.[0]?.content?.parts || [])
    .map(part => part.text || '')
    .join('');

  return JSON.parse(raw.replace(/^```json|```$/g, '').trim()).questions || [];
}

app.post('/api/generate', async (req, res) => {
  try {
    const p = req.body || {};

    if (!p.sourceText?.trim()) {
      return res.status(400).json({ error: 'Source text is required' });
    }

    const plan = p.blueprint?.questions || [{
      type: p.type || 'Short Answer',
      count: Number(p.count || 10),
      bloomMix: ['Remember', 'Understand'],
      difficultyMix: ['Easy', 'Moderate'],
      marks: 1
    }];

    const questions = [];

    for (const row of plan) {
      const payload = {
        ...p,
        ...row,
        count: Number(row.count || 0),
        marks: Number(row.marks || 1),
        bloomMix: row.bloomMix || ['Understand'],
        difficultyMix: row.difficultyMix || ['Moderate']
      };

      let generated = null;

      try {
        generated = await aiGenerate(payload);
      } catch (err) {
        console.error('AI generation failed:', err.message);
      }

      const list = generated?.length
        ? generated
        : heuristicGenerate(payload);

      list.slice(0, payload.count).forEach(q => {
        questions.push({
          ...q,
          id: q.id || uid(),
          marks: Number(q.marks || payload.marks),
          status: 'Draft'
        });
      });
    }

    const checked = questions.map(q => ({
      ...q,
      quality: qualityCheck(q)
    }));

    res.json({
      questions: checked,
      totalMarks: checked.reduce((sum, q) => sum + Number(q.marks || 0), 0),
      aiUsed: Boolean(process.env.GEMINI_API_KEY)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/quality-check', (req, res) => {
  const questions = Array.isArray(req.body?.questions)
    ? req.body.questions
    : [];

  const seen = [];

  const checked = questions.map((q, i) => {
    const quality = qualityCheck(q);
    const text = String(q.question || '')
      .toLowerCase()
      .replace(/\W/g, ' ');

    const duplicateIndex = seen.findIndex(
      previous => similarity(text, previous.text) > 0.82
    );

    if (duplicateIndex >= 0) {
      quality.issues.push(`Very similar to question ${duplicateIndex + 1}`);
      quality.score = Math.max(0, quality.score - 20);
    }

    seen.push({ text });

    return { ...q, quality };
  });

  const average = checked.length
    ? Math.round(checked.reduce((sum, q) => sum + q.quality.score, 0) / checked.length)
    : 0;

  res.json({
    questions: checked,
    average,
    status: average >= 90
      ? 'Excellent'
      : average >= 75
        ? 'Review recommended'
        : 'Needs revision'
  });
});

app.post('/api/assessments', async (req, res) => {
  try {
    const p = req.body || {};
    const id = uid();

    await db(
      `INSERT INTO assessments
       (id,title,subject,klass,total_marks,duration,school,blueprint,data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        p.title || 'Untitled Exam',
        p.subject || '',
        p.klass || '',
        p.totalMarks || 0,
        p.duration || '',
        p.school || 'Golaha Horumarinta Dugsiyada Dadweynaha (GHDD)',
        JSON.stringify(p.blueprint || {}),
        JSON.stringify(p.data || {})
      ]
    );

    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/assessments', async (req, res) => {
  try {
    const result = await db(
      'SELECT id,title,subject,klass,total_marks,duration,school,created_at FROM assessments ORDER BY created_at DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/assessments/:id', async (req, res) => {
  try {
    const result = await db(
      'SELECT * FROM assessments WHERE id=$1',
      [req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/question-bank', async (req, res) => {
  try {
    const q = req.body || {};
    const id = q.id || uid();

    await db(
      `INSERT INTO question_bank
       (id,subject,klass,unit,topic,lo,bloom,difficulty,type,marks,question,answer,options,source,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT(id) DO UPDATE SET
       question=EXCLUDED.question,
       answer=EXCLUDED.answer,
       options=EXCLUDED.options,
       status=EXCLUDED.status`,
      [
        id, q.subject || '', q.klass || '', q.unit || '',
        q.topic || '', q.learningOutcome || '', q.bloom || '',
        q.difficulty || '', q.type || '', q.marks || 1,
        q.question || '', q.answer || '',
        JSON.stringify(q.options || null),
        q.source || '', q.status || 'Approved'
      ]
    );

    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/question-bank', async (req, res) => {
  try {
    const result = await db(
      'SELECT * FROM question_bank ORDER BY created_at DESC LIMIT 300'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/item-analysis', (req, res) => {
  const { students = [], questions = [] } = req.body || {};

  const items = questions.map((q, index) => {
    const values = students.map(student =>
      Number(student.answers?.[index]) === 1 ? 1 : 0
    );

    const difficultyIndex = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;

    const totals = students.map(student => Number(student.total || 0));
    const sorted = [...totals].sort((a, b) => b - a);
    const groupSize = Math.ceil(sorted.length * 0.27);

    const topCut = sorted[Math.max(0, groupSize - 1)];
    const bottomCut = sorted[Math.max(0, sorted.length - groupSize)];

    const top = students.filter(s => Number(s.total || 0) >= (topCut ?? Infinity));
    const bottom = students.filter(s => Number(s.total || 0) <= (bottomCut ?? -Infinity));

    const rate = group => group.length
      ? group.reduce(
          (sum, student) => sum + (Number(student.answers?.[index]) === 1 ? 1 : 0),
          0
        ) / group.length
      : 0;

    const discrimination = rate(top) - rate(bottom);

    return {
      number: index + 1,
      question: q.question,
      difficultyIndex: Math.round(difficultyIndex * 100),
      discrimination: Math.round(discrimination * 100) / 100,
      recommendation: difficultyIndex > 0.9
        ? 'Too easy'
        : difficultyIndex < 0.25
          ? 'Too difficult'
          : discrimination < 0.2
            ? 'Review discrimination'
            : 'Good'
    };
  });

  res.json({
    items,
    summary: {
      totalQuestions: items.length,
      good: items.filter(item => item.recommendation === 'Good').length,
      review: items.filter(item => item.recommendation !== 'Good').length
    }
  });
});

app.get('*', (req, res) => {
  if (PUBLIC_DIR && fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }

  res.status(500).type('text').send(
    'GHDD Assessment Pro is running, but public/index.html is missing. ' +
    'Check that public/index.html is committed to the GitHub repository ' +
    'and redeploy the latest commit.'
  );
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`GHDD Assessment Pro running on port ${port}`);
});
