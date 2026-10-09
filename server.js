
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

// Find the frontend directory
const publicCandidates = [
  path.join(__dirname, 'public'),
  path.join(__dirname, 'Public'),
  path.join(process.cwd(), 'public'),
  path.join(process.cwd(), 'Public'),
  '/app/public',
  '/app/Public'
];

const PUBLIC_DIR = publicCandidates.find(dir =>
  fs.existsSync(path.join(dir, 'index.html'))
);

if (PUBLIC_DIR) {
  console.log(`Serving web files from: ${PUBLIC_DIR}`);
  app.use(express.static(PUBLIC_DIR));
} else {
  console.error(
    'PUBLIC DIRECTORY ERROR: index.html was not found:',
    publicCandidates.join(', ')
  );
}

// PostgreSQL connection
const databaseUrl = process.env.DATABASE_URL;

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: /railway/i.test(databaseUrl)
        ? { rejectUnauthorized: false }
        : false,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 10
    })
  : null;

if (pool) {
  pool.on('error', error => {
    console.error('Unexpected PostgreSQL pool error:', error.message);
  });
}

async function db(sql, params = []) {
  if (!pool) {
    throw new Error('PostgreSQL is not configured. Check DATABASE_URL.');
  }
  return pool.query(sql, params);
}

// Initialize database tables
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

  // IMPORTANT: app_state uses integer ID 1, not the text "main".
  await db(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  console.log('Database tables initialized.');
}

const initPromise = initDb();

initPromise.catch(error => {
  console.error('Database initialization failed:', error.message);
});

// Admin password
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

// API authentication
function auth(req, res, next) {
  // Login and health checks must be reachable without an existing login.
  if (req.path === '/login' || req.path === '/health') {
    return next();
  }

  if ((req.headers['x-admin-password'] || '') !== ADMIN_PASSWORD) {
    return res.status(401).json({
      error: 'Unauthorized. Please log in again.'
    });
  }

  next();
}

app.use('/api', auth);

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await initPromise;

    if (!pool) {
      return res.status(503).json({
        ok: false,
        databaseEnabled: false,
        error: 'DATABASE_URL is not configured.'
      });
    }

    await db('SELECT 1');

    res.json({
      ok: true,
      app: 'GHDD Assessment Pro',
      databaseEnabled: true
    });
  } catch (error) {
    console.error('Health check failed:', error.message);
    res.status(500).json({
      ok: false,
      databaseEnabled: Boolean(pool),
      error: 'Database connection failed.'
    });
  }
});

// Login
app.post('/api/login', (req, res) => {
  const password = String(req.body?.password || '');

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      ok: false,
      error: 'Furaha maamulka waa khaldan yahay.'
    });
  }

  res.json({ ok: true });
});

// Read persistent application state
app.get('/api/state', async (req, res) => {
  try {
    await initPromise;

    if (!pool) {
      return res.status(503).json({
        error: 'PostgreSQL is not configured.'
      });
    }

    const result = await db(
      'SELECT data, updated_at FROM app_state WHERE id = $1',
      [1]
    );

    res.json({
      ok: true,
      state: result.rows[0]?.data || null,
      updatedAt: result.rows[0]?.updated_at || null,
      databaseEnabled: true
    });
  } catch (error) {
    console.error('State read failed:', error.message);
    res.status(500).json({
      error: 'Could not load saved app data.'
    });
  }
});

// Save persistent application state
app.put('/api/state', async (req, res) => {
  try {
    await initPromise;

    const incoming = req.body?.state;

    if (
      !incoming ||
      typeof incoming !== 'object' ||
      Array.isArray(incoming)
    ) {
      return res.status(400).json({
        error: 'A valid state object is required.'
      });
    }

    if (!pool) {
      return res.status(503).json({
        error: 'PostgreSQL is not configured.'
      });
    }

    // Always use integer ID 1. Never use "main".
    await db(
      `INSERT INTO app_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id)
       DO UPDATE SET
         data = EXCLUDED.data,
         updated_at = now()`,
      [1, JSON.stringify(incoming)]
    );

    res.json({
      ok: true,
      savedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('State save failed:', error.message);
    res.status(500).json({
      error: 'Could not save app data to PostgreSQL.'
    });
  }
});

// Helpers
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

  if (!q.answer || String(q.answer).trim().length < 1) {
    issues.push('Missing answer/model answer');
    score -= 25;
  }

  if (q.type === 'MCQ') {
    const options = Array.isArray(q.options) ? q.options : [];

    if (options.length !== 4) {
      issues.push('MCQ should have exactly 4 options');
      score -= 15;
    }

    const answer = String(q.answer || '').trim();

    if (
      options.filter(option => String(option).trim() === answer).length !== 1
    ) {
      issues.push('MCQ must have exactly one matching correct option');
      score -= 20;
    }

    const unique = new Set(
      options.map(option => String(option).trim().toLowerCase())
    );

    if (unique.size !== options.length) {
      issues.push('Duplicate options detected');
      score -= 15;
    }
  }

  if (!blooms.includes(q.bloom)) {
    warnings.push('Bloom level not recognized');
    score -= 5;
  }

  if (!['Easy', 'Moderate', 'Difficult'].includes(q.difficulty)) {
    warnings.push('Difficulty not set');
    score -= 5;
  }

  const lowerText = text.toLowerCase();

  if (
    lowerText.includes('all of the above') ||
    lowerText.includes('none of the above')
  ) {
    warnings.push('Avoid clue-prone options such as all/none of the above');
  }

  return {
    score: Math.max(0, score),
    status:
      score >= 90
        ? 'Excellent'
        : score >= 75
          ? 'Review recommended'
          : 'Needs revision',
    issues,
    warnings
  };
}

// Basic question generation fallback
function heuristicGenerate(payload) {
  const count = Math.max(0, Math.min(100, Number(payload.count) || 0));

  const sourceLines = String(payload.text || '')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, count);

  return Array.from({ length: count }, (_, index) => ({
    id: uid(),
    type: payload.type || 'Short Answer',
    question: sourceLines[index]
      ? `${sourceLines[index]} — explain or apply this concept.`
      : `Explain one important concept from ${
          payload.topic || payload.unit || payload.subject || 'the source'
        }.`,
    answer:
      'Teacher review required: add or confirm the model answer from the source material.',
    options:
      payload.type === 'MCQ'
        ? ['Option A', 'Option B', 'Option C', 'Option D']
        : null,
    bloom:
      payload.bloomMix?.[index % Math.max(1, payload.bloomMix.length)] ||
      'Understand',
    difficulty:
      payload.difficultyMix?.[index % Math.max(1, payload.difficultyMix.length)] ||
      'Moderate',
    marks: payload.marks || 1,
    unit: payload.unit || '',
    topic: payload.topic || '',
    learningOutcome: payload.learningOutcome || '',
    source: 'User-provided source',
    status: 'Draft'
  }));
}

// Optional Gemini AI generation
async function aiGenerate(payload) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const prompt = `
You are an expert secondary-school assessment designer.
Create exactly ${payload.count} questions using ONLY the source text.
Avoid duplication, ambiguity, trivia and unsupported facts.
For MCQ, use four plausible options and exactly one correct answer.
Return JSON only:
{"questions":[{"id":"","type":"","question":"","answer":"","options":[],"bloom":"","difficulty":"","marks":1,"unit":"","topic":"","learningOutcome":"","source":""}]}

Subject: ${payload.subject || ''}
Class: ${payload.klass || ''}
Type: ${payload.type || ''}
Unit: ${payload.unit || ''}
Topic: ${payload.topic || ''}
Learning outcome: ${payload.learningOutcome || ''}
Bloom levels: ${(payload.bloomMix || []).join(', ')}
Difficulty: ${(payload.difficultyMix || []).join(', ')}
Marks each: ${payload.marks || 1}

Source text:
${String(payload.text || '').slice(0, 70000)}
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
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
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
    throw new Error(result?.error?.message || 'AI request failed');
  }

  const raw = (result.candidates?.[0]?.content?.parts || [])
    .map(part => part.text || '')
    .join('');

  const parsed = JSON.parse(raw.replace(/^```json|```$/g, '').trim());

  return parsed.questions || [];
}

// Generate questions
app.post('/api/generate', async (req, res) => {
  try {
    const input = req.body || {};

    if (!input.sourceText?.trim()) {
      return res.status(400).json({
        error: 'Source text is required'
      });
    }

    const plan = input.blueprint?.questions || [
      {
        type: input.type || 'MCQ',
        count: Number(input.count || 10),
        bloomMix: ['Remember', 'Understand'],
        difficultyMix: ['Easy', 'Moderate'],
        marks: 1
      }
    ];

    const questions = [];

    for (const row of plan) {
      const payload = {
        ...input,
        ...row,
        text: input.sourceText,
        count: Math.max(0, Math.min(100, Number(row.count) || 0)),
        marks: Number(row.marks || 1),
        bloomMix: row.bloomMix || ['Understand'],
        difficultyMix: row.difficultyMix || ['Moderate']
      };

      let generated = null;

      try {
        generated = await aiGenerate(payload);
      } catch (error) {
        console.warn('AI fallback:', error.message);
      }

      const batch =
        generated?.length
          ? generated
          : heuristicGenerate(payload);

      batch.slice(0, payload.count).forEach(question => {
        questions.push({
          ...question,
          id: question.id || uid(),
          type: question.type || payload.type,
          marks: Number(question.marks || payload.marks),
          bloom: question.bloom || payload.bloomMix[0],
          difficulty: question.difficulty || payload.difficultyMix[0],
          unit: question.unit || input.unit || '',
          topic: question.topic || input.topic || '',
          learningOutcome:
            question.learningOutcome || input.learningOutcome || '',
          source: question.source || 'User-provided source',
          status: 'Draft'
        });
      });
    }

    const checked = questions.map(question => ({
      ...question,
      quality: qualityCheck(question)
    }));

    const totalMarks = checked.reduce(
      (sum, question) => sum + Number(question.marks || 0),
      0
    );

    res.json({
      questions: checked,
      totalMarks,
      aiUsed: Boolean(process.env.GEMINI_API_KEY)
    });
  } catch (error) {
    console.error('Question generation failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Similarity helper
function similarity(a, b) {
  const A = new Set(a.split(/\s+/).filter(Boolean));
  const B = new Set(b.split(/\s+/).filter(Boolean));

  let intersection = 0;

  for (const word of A) {
    if (B.has(word)) intersection++;
  }

  return intersection / (A.size + B.size - intersection || 1);
}

// Check question quality and duplication
app.post('/api/quality-check', (req, res) => {
  const questions = Array.isArray(req.body?.questions)
    ? req.body.questions
    : [];

  const seen = [];

  const output = questions.map((question, index) => {
    const quality = qualityCheck(question);
    const text = String(question.question || '')
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

    return { ...question, quality };
  });

  const average = output.length
    ? Math.round(
        output.reduce((sum, question) => sum + question.quality.score, 0) /
          output.length
      )
    : 0;

  res.json({
    questions: output,
    average,
    status:
      average >= 90
        ? 'Excellent'
        : average >= 75
          ? 'Review recommended'
          : 'Needs revision'
  });
});

// Save an assessment
app.post('/api/assessments', async (req, res) => {
  try {
    await initPromise;

    const input = req.body || {};
    const id = uid();

    await db(
      `INSERT INTO assessments
       (id, title, subject, klass, total_marks, duration, school, blueprint, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        input.title || 'Untitled Exam',
        input.subject || '',
        input.klass || '',
        Number(input.totalMarks || 0),
        input.duration || '',
        input.school || 'Golaha Horumarinta Dugsiyada Dadweynaha (GHDD)',
        JSON.stringify(input.blueprint || {}),
        JSON.stringify(input.data || {})
      ]
    );

    res.json({ ok: true, id });
  } catch (error) {
    console.error('Assessment save failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// List assessments
app.get('/api/assessments', async (req, res) => {
  try {
    await initPromise;

    const result = await db(
      `SELECT id, title, subject, klass, total_marks, duration, school, created_at
       FROM assessments
       ORDER BY created_at DESC
       LIMIT 100`
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Assessment list failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Read one assessment
app.get('/api/assessments/:id', async (req, res) => {
  try {
    await initPromise;

    const result = await db(
      'SELECT * FROM assessments WHERE id = $1',
      [req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Assessment read failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Save a question to the question bank
app.post('/api/question-bank', async (req, res) => {
  try {
    await initPromise;

    const question = req.body || {};
    const id = question.id || uid();

    await db(
      `INSERT INTO question_bank
       (id, subject, klass, unit, topic, lo, bloom, difficulty, type, marks,
        question, answer, options, source, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         subject = EXCLUDED.subject,
         klass = EXCLUDED.klass,
         unit = EXCLUDED.unit,
         topic = EXCLUDED.topic,
         lo = EXCLUDED.lo,
         bloom = EXCLUDED.bloom,
         difficulty = EXCLUDED.difficulty,
         type = EXCLUDED.type,
         marks = EXCLUDED.marks,
         question = EXCLUDED.question,
         answer = EXCLUDED.answer,
         options = EXCLUDED.options,
         source = EXCLUDED.source,
         status = EXCLUDED.status`,
      [
        id,
        question.subject || '',
        question.klass || question.className || '',
        question.unit || '',
        question.topic || '',
        question.learningOutcome || '',
        question.bloom || '',
        question.difficulty || '',
        question.type || '',
        Number(question.marks || 1),
        question.question || question.text || '',
        question.answer || '',
        JSON.stringify(question.options || null),
        question.source || '',
        question.status || 'Approved'
      ]
    );

    res.json({ ok: true, id });
  } catch (error) {
    console.error('Question save failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// List saved questions
app.get('/api/question-bank', async (req, res) => {
  try {
    await initPromise;

    const result = await db(
      'SELECT * FROM question_bank ORDER BY created_at DESC LIMIT 300'
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Question list failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Item analysis
app.post('/api/item-analysis', (req, res) => {
  const { students = [], questions = [] } = req.body || {};

  const rows = questions.map((question, index) => {
    const difficultyValues = students.map(student =>
      Number(student.answers?.[index]) === 1 ? 1 : 0
    );

    const difficultyIndex = difficultyValues.length
      ? difficultyValues.reduce((sum, value) => sum + value, 0) /
        difficultyValues.length
      : 0;

    const totals = students.map(student => Number(student.total || 0));
    const sorted = [...totals].sort((a, b) => b - a);

    const groupSize = Math.ceil(sorted.length * 0.27);

    const topCutoff =
      sorted[Math.max(0, groupSize - 1)] ?? Infinity;

    const bottomCutoff =
      sorted[Math.max(0, sorted.length - groupSize)] ?? -Infinity;

    const top = students.filter(
      student => Number(student.total) >= topCutoff
    );

    const bottom = students.filter(
      student => Number(student.total) <= bottomCutoff
    );

    const correctRate = group =>
      group.length
        ? group.reduce(
            (sum, student) =>
              sum + (Number(student.answers?.[index]) === 1 ? 1 : 0),
            0
          ) / group.length
        : 0;

    const discrimination = correctRate(top) - correctRate(bottom);

    return {
      number: index + 1,
      question: question.question,
      difficultyIndex: Math.round(difficultyIndex * 100),
      discrimination: Math.round(discrimination * 100) / 100,
      recommendation:
        difficultyIndex > 0.9
          ? 'Too easy'
          : difficultyIndex < 0.25
            ? 'Too difficult'
            : discrimination < 0.2
              ? 'Review discrimination'
              : 'Good'
    };
  });

  res.json({
    items: rows,
    summary: {
      totalQuestions: rows.length,
      good: rows.filter(row => row.recommendation === 'Good').length,
      review: rows.filter(row => row.recommendation !== 'Good').length
    }
  });
});

// Frontend fallback
app.get('*', (req, res) => {
  if (PUBLIC_DIR && fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }

  res
    .status(500)
    .type('text')
    .send(
      'GHDD Assessment Pro is running, but public/index.html is missing. Check GitHub and redeploy.'
    );
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`GHDD Assessment Pro running on port ${port}`);
});
