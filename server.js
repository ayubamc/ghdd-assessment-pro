
import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const app = express();
const { Pool } = pg;

app.use(express.json({ limit: '15mb' }));

// Find the frontend using either folder capitalization.
const candidates = [
  path.join(process.cwd(), 'public'),
  path.join(process.cwd(), 'Public'),
  path.join('/app', 'public'),
  path.join('/app', 'Public'),
  path.join(process.cwd(), 'public'.toLowerCase()),
  path.join(process.cwd(), 'Public'.toLowerCase())
];

const PUBLIC_DIR = candidates.find(dir =>
  fs.existsSync(path.join(dir, 'index.html'))
);

if (PUBLIC_DIR) {
  console.log('Frontend directory:', PUBLIC_DIR);
  app.use(express.static(PUBLIC_DIR));
} else {
  console.error('Frontend not found. Checked:', candidates);
}

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('railway')
        ? { rejectUnauthorized: false }
        : false
    })
  : null;

async function query(sql, params = []) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured in Railway Variables');
  }
  return pool.query(sql, params);
}

async function initializeDatabase() {
  if (!pool) {
    console.warn('DATABASE_URL is missing; database features are disabled.');
    return;
  }

  await query(`
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
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
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
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('Database tables initialized.');
}

initializeDatabase().catch(error => {
  console.error('Database initialization failed:', error.message);
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      error: 'Configure ADMIN_PASSWORD in Railway Variables'
    });
  }

  if ((req.headers['x-admin-password'] || '') !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'GHDD Assessment Pro',
    frontendFound: Boolean(PUBLIC_DIR),
    databaseConfigured: Boolean(pool)
  });
});

app.post('/api/login', (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      ok: false,
      error: 'ADMIN_PASSWORD is not configured'
    });
  }

  res.json({
    ok: (req.body?.password || '') === ADMIN_PASSWORD
  });
});

app.use('/api', requireAdmin);

function makeId() {
  return crypto.randomUUID();
}

app.post('/api/assessments', async (req, res) => {
  try {
    const p = req.body || {};
    const id = makeId();

    await query(
      `INSERT INTO assessments
       (id,title,subject,klass,total_marks,duration,school,blueprint,data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        p.title || 'Untitled Examination',
        p.subject || '',
        p.klass || '',
        Number(p.totalMarks || 0),
        p.duration || '',
        p.school || 'Golaha Horumarinta Dugsiyada Dadweynaha (GHDD)',
        JSON.stringify(p.blueprint || {}),
        JSON.stringify(p.data || {})
      ]
    );

    res.json({ ok: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/assessments', async (req, res) => {
  try {
    const result = await query(
      `SELECT id,title,subject,klass,total_marks,duration,school,created_at
       FROM assessments ORDER BY created_at DESC LIMIT 100`
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/question-bank', async (req, res) => {
  try {
    const q = req.body || {};
    const id = q.id || makeId();

    await query(
      `INSERT INTO question_bank
       (id,subject,klass,unit,topic,lo,bloom,difficulty,type,marks,
        question,answer,options,source,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id, q.subject || '', q.klass || '', q.unit || '',
        q.topic || '', q.learningOutcome || '', q.bloom || '',
        q.difficulty || '', q.type || '', Number(q.marks || 1),
        q.question || '', q.answer || '',
        JSON.stringify(q.options || null), q.source || '',
        q.status || 'Draft'
      ]
    );

    res.json({ ok: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/question-bank', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM question_bank ORDER BY created_at DESC LIMIT 300'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('*', (req, res) => {
  if (PUBLIC_DIR && fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }

  res.status(500).type('text').send(
    'Frontend not found. Ensure Public/index.html or public/index.html exists.'
  );
});

const port = process.env.PORT || 8080;

app.listen(port, '0.0.0.0', () => {
  console.log(`GHDD Assessment Pro running on port ${port}`);
});
