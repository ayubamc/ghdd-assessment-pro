
import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const app = express();
const { Pool } = pg;

app.use(express.json({ limit: '15mb' }));

const candidates = [
  path.join(process.cwd(), 'public'),
  path.join(process.cwd(), 'Public'),
  path.join('/app', 'public'),
  path.join('/app', 'Public')
];

const PUBLIC_DIR = candidates.find(dir =>
  fs.existsSync(path.join(dir, 'index.html'))
);

if (PUBLIC_DIR) {
  console.log('Frontend directory:', PUBLIC_DIR);
  app.use(express.static(PUBLIC_DIR));
} else {
  console.error('Frontend not found:', candidates);
}

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

async function query(sql, params = []) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured');
  }
  return pool.query(sql, params);
}

async function initializeDatabase() {
  if (!pool) {
    console.error('DATABASE_URL is missing');
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

  await query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INT PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW()
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

app.get('/api/health', async (req, res) => {
  let databaseConnected = false;

  try {
    if (pool) {
      await pool.query('SELECT 1');
      databaseConnected = true;
    }
  } catch (error) {
    console.error('Database health check failed:', error.message);
  }

  res.json({
    ok: true,
    app: 'GHDD Assessment Pro',
    frontendFound: Boolean(PUBLIC_DIR),
    databaseConfigured: Boolean(pool),
    databaseConnected
  });
});

app.post('/api/login', (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      ok: false,
      error: 'ADMIN_PASSWORD is not configured in Railway Variables'
    });
  }

  res.json({
    ok: (req.body?.password || '') === ADMIN_PASSWORD
  });
});

app.use('/api', requireAdmin);

app.get('/api/state', async (req, res) => {
  try {
    const result = await query(
      'SELECT data FROM app_state WHERE id = 1'
    );

    res.json(result.rows[0]?.data || {
      questions: [],
      blueprints: [],
      bank: [],
      exams: [],
      currentExamId: null
    });
  } catch (error) {
    console.error('Read state failed:', error.message);
    res.status(500).json({ error: 'Could not read saved data' });
  }
});

app.put('/api/state', async (req, res) => {
  try {
    const data = req.body;

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'Invalid state data' });
    }

    await query(
      `INSERT INTO app_state (id, data, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [JSON.stringify(data)]
    );

    res.json({ ok: true, saved: true });
  } catch (error) {
    console.error('Save state failed:', error.message);
    res.status(500).json({ error: 'Could not save data to database' });
  }
});

app.post('/api/assessments', async (req, res) => {
  try {
    const p = req.body || {};
    const id = crypto.randomUUID();

    await query(
      `INSERT INTO assessments
       (id, title, subject, klass, total_marks, duration, school, blueprint, data)
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
      `SELECT id, title, subject, klass, total_marks, duration,
              school, data, created_at
       FROM assessments
       ORDER BY created_at DESC
       LIMIT 100`
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/question-bank', async (req, res) => {
  try {
    const q = req.body || {};
    const id = q.id || crypto.randomUUID();

    await query(
      `INSERT INTO question_bank
       (id,subject,klass,unit,topic,lo,bloom,difficulty,type,marks,
        question,answer,options,source,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         subject=EXCLUDED.subject,
         klass=EXCLUDED.klass,
         unit=EXCLUDED.unit,
         topic=EXCLUDED.topic,
         lo=EXCLUDED.lo,
         bloom=EXCLUDED.bloom,
         difficulty=EXCLUDED.difficulty,
         type=EXCLUDED.type,
         marks=EXCLUDED.marks,
         question=EXCLUDED.question,
         answer=EXCLUDED.answer,
         options=EXCLUDED.options,
         source=EXCLUDED.source,
         status=EXCLUDED.status`,
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
  if (PUBLIC_DIR) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }

  res.status(500).type('text').send(
    'Frontend not found. Check Public/index.html or public/index.html.'
  );
});

const port = process.env.PORT || 8080;

app.listen(port, '0.0.0.0', () => {
  console.log(`GHDD Assessment Pro running on port ${port}`);
});
