
import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// PDF-yada waaweyn waxaa lagu diraa qaybo yaryar, ma aha hal JSON weyn.
app.use(express.json({ limit: '12mb' }));

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
  console.log('Serving files from:', PUBLIC_DIR);
  app.use(express.static(PUBLIC_DIR));
} else {
  console.error('Could not find Public/index.html');
}

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /railway/i.test(process.env.DATABASE_URL)
        ? { rejectUnauthorized: false }
        : false
    })
  : null;

async function db(sql, params = []) {
  if (!pool) throw new Error('PostgreSQL lama dejin.');
  return pool.query(sql, params);
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const MAX_PDF_BYTES = 500 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const blooms = ['Remember', 'Understand', 'Apply', 'Analyze', 'Evaluate', 'Create'];

function uid() {
  return crypto.randomUUID();
}

function auth(req, res, next) {
  if (req.path === '/health') return next();

  if ((req.headers['x-admin-password'] || '') !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Furaha maamulka waa khaldan yahay.' });
  }

  next();
}

app.use('/api', auth);

async function initDb() {
  await db(`
    CREATE TABLE IF NOT EXISTS assessments(
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
    CREATE TABLE IF NOT EXISTS question_bank(
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
    CREATE TABLE IF NOT EXISTS item_analysis(
      id TEXT PRIMARY KEY,
      assessment_id TEXT,
      data JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS app_state(
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS books(
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subject TEXT,
      filename TEXT,
      page_count INT NOT NULL,
      pdf BYTEA NOT NULL,
      pages JSONB NOT NULL,
      text_chars INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // PDF-yada waaweyn waxaa lagu kaydiyaa qaybo database-ka ku jira.
  await db(`
    CREATE TABLE IF NOT EXISTS book_pdf_chunks(
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      data BYTEA NOT NULL,
      PRIMARY KEY(book_id, chunk_index)
    )
  `);
}

const dbReady = initDb()
  .then(() => console.log('PostgreSQL tables are ready'))
  .catch(err => {
    console.error('Database initialization failed:', err.message);
    throw err;
  });

app.get('/api/health', async (req, res) => {
  try {
    await dbReady;
    await db('SELECT 1');
    res.json({ ok: true, database: true, maxPdfMB: 500 });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  res.json({ ok: (req.body?.password || '') === ADMIN_PASSWORD });
});

// App state
app.get('/api/state', async (req, res) => {
  try {
    await dbReady;
    const r = await db('SELECT data, updated_at FROM app_state WHERE id=$1', [1]);
    res.json({
      ok: true,
      state: r.rows[0]?.data || null,
      updatedAt: r.rows[0]?.updated_at || null
    });
  } catch (e) {
    res.status(500).json({ error: 'Xogta app-ka lama soo dejin.' });
  }
});

app.put('/api/state', async (req, res) => {
  try {
    await dbReady;
    const state = req.body?.state;

    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return res.status(400).json({ error: 'Xogta app-ka ma saxna.' });
    }

    await db(`
      INSERT INTO app_state(id, data, updated_at)
      VALUES(1, $1, now())
      ON CONFLICT(id)
      DO UPDATE SET data=EXCLUDED.data, updated_at=now()
    `, [JSON.stringify(state)]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Xogta lama kaydin.' });
  }
});

// Liiska buugaagta
app.get('/api/books', async (req, res) => {
  try {
    await dbReady;
    const r = await db(`
      SELECT id, title, subject, filename, page_count,
             text_chars, created_at
      FROM books
      ORDER BY created_at DESC
    `);
    res.json({ books: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Buugaagta lama soo dejin.' });
  }
});

// Bilaabidda upload-ka PDF weyn
app.post('/api/books/upload/start', async (req, res) => {
  try {
    await dbReady;

    const p = req.body || {};
    const title = String(p.title || '').trim();
    const size = Number(p.size);
    const pageCount = Number(p.pageCount);

    if (!title) {
      return res.status(400).json({ error: 'Magaca buugga waa loo baahan yahay.' });
    }

    if (!Number.isFinite(size) || size < 1 || size > MAX_PDF_BYTES) {
      return res.status(413).json({ error: 'PDF-gu waa inuu ka yaraadaa 500 MB.' });
    }

    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 3000) {
      return res.status(400).json({ error: 'Bogagga waa inay u dhexeeyaan 1 iyo 3000.' });
    }

    const id = uid();

    await db(`
      INSERT INTO books(
        id, title, subject, filename, page_count, pdf, pages, text_chars
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,0)
    `, [
      id,
      title.slice(0, 250),
      String(p.subject || '').slice(0, 150),
      String(p.filename || 'book.pdf').slice(0, 250),
      pageCount,
      Buffer.alloc(0),
      JSON.stringify([])
    ]);

    res.json({
      ok: true,
      id,
      chunkSize: CHUNK_BYTES,
      maxBytes: MAX_PDF_BYTES
    });
  } catch (e) {
    console.error('Upload start:', e.message);
    res.status(500).json({ error: 'Upload-ka lama bilaabi karin.' });
  }
});

// Kaydinta qayb kasta oo PDF-ga ah
app.post('/api/books/:id/chunks/:index', async (req, res) => {
  try {
    await dbReady;

    const index = Number(req.params.index);
    const encoded = req.body?.chunkBase64;

    if (!Number.isInteger(index) || index < 0 || typeof encoded !== 'string') {
      return res.status(400).json({ error: 'Qaybta PDF-ga ma saxna.' });
    }

    if (encoded.length > 6 * 1024 * 1024) {
      return res.status(413).json({ error: 'Qaybta PDF-gu aad bay u weyn tahay.' });
    }

    const exists = await db('SELECT id FROM books WHERE id=$1', [req.params.id]);

    if (!exists.rows.length) {
      return res.status(404).json({ error: 'Buugga lama helin.' });
    }

    const data = Buffer.from(encoded, 'base64');

    if (!data.length || data.length > CHUNK_BYTES) {
      return res.status(400).json({ error: 'Cabbirka qaybta ma saxna.' });
    }

    await db(`
      INSERT INTO book_pdf_chunks(book_id, chunk_index, data)
      VALUES($1,$2,$3)
      ON CONFLICT(book_id,chunk_index)
      DO UPDATE SET data=EXCLUDED.data
    `, [req.params.id, index, data]);

    res.json({ ok: true, index, bytes: data.length });
  } catch (e) {
    console.error('Chunk upload:', e.message);
    res.status(500).json({ error: 'Qaybta PDF-ga lama kaydin.' });
  }
});

// Dhammeystirka upload-ka iyo kaydinta qoraalka OCR
app.post('/api/books/:id/upload/finish', async (req, res) => {
  try {
    await dbReady;

    const pages = req.body?.pages;
    if (!Array.isArray(pages)) {
      return res.status(400).json({ error: 'Qoraalka OCR waa loo baahan yahay.' });
    }

    const bookResult = await db(
      'SELECT id, page_count FROM books WHERE id=$1',
      [req.params.id]
    );

    if (!bookResult.rows.length) {
      return res.status(404).json({ error: 'Buugga lama helin.' });
    }

    const chunkResult = await db(`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(octet_length(data)),0)::bigint AS bytes,
             MIN(chunk_index) AS first_chunk,
             MAX(chunk_index) AS last_chunk
      FROM book_pdf_chunks
      WHERE book_id=$1
    `, [req.params.id]);

    const stats = chunkResult.rows[0];
    const bytes = Number(stats.bytes);

    if (!stats.count || stats.first_chunk !== 0) {
      return res.status(400).json({ error: 'Qaybaha PDF-ga oo dhan lama helin.' });
    }

    if (bytes > MAX_PDF_BYTES) {
      return res.status(413).json({ error: 'PDF-gu wuxuu dhaafay 500 MB.' });
    }

    // Hubi in aanay jirin qaybo ka maqan.
    if (Number(stats.last_chunk) + 1 !== Number(stats.count)) {
      return res.status(400).json({ error: 'Qaybo PDF ah ayaa maqan. Dib u dir upload-ka.' });
    }

    const cleanPages = pages
      .map(p => ({
        page: Number(p.page),
        text: String(p.text || '').slice(0, 100000)
      }))
      .filter(p =>
        Number.isInteger(p.page) &&
        p.page >= 1 &&
        p.page <= Number(bookResult.rows[0].page_count)
      );

    const chars = cleanPages.reduce((sum, p) => sum + p.text.length, 0);

    await db(`
      UPDATE books
      SET pages=$2::jsonb, text_chars=$3
      WHERE id=$1
    `, [req.params.id, JSON.stringify(cleanPages), chars]);

    res.json({
      ok: true,
      id: req.params.id,
      pageCount: cleanPages.length,
      textChars: chars,
      bytes
    });
  } catch (e) {
    console.error('Upload finish:', e.message);
    res.status(500).json({ error: 'Buugga lama dhammeystirin.' });
  }
});

// PDF-yada waaweyn waxaa browser-ka loogu soo celinayaa qaybo, iyada oo aan la isku darin.
app.get('/api/books/:id/pdf', async (req, res) => {
  try {
    await dbReady;

    const r = await db(
      'SELECT filename, pdf FROM books WHERE id=$1',
      [req.params.id]
    );

    if (!r.rows.length) {
      return res.status(404).json({ error: 'Buugga lama helin.' });
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${String(r.rows[0].filename || 'book.pdf').replace(/["\r\n]/g, '')}"`
    );

    const chunks = await db(`
      SELECT chunk_index, data
      FROM book_pdf_chunks
      WHERE book_id=$1
      ORDER BY chunk_index
    `, [req.params.id]);

    if (chunks.rows.length) {
      for (const chunk of chunks.rows) {
        if (!res.write(chunk.data)) {
          await new Promise(resolve => res.once('drain', resolve));
        }
      }
      return res.end();
    }

    return res.end(r.rows[0].pdf);
  } catch (e) {
    console.error('PDF download:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'PDF-ga lama soo dejin.' });
    else res.destroy(e);
  }
});

app.get('/api/books/:id/text', async (req, res) => {
  try {
    await dbReady;

    const start = Math.max(1, Number(req.query.start) || 1);
    const end = Math.max(start, Number(req.query.end) || 100000);

    const r = await db(`
      SELECT id, title, page_count, pages
      FROM books WHERE id=$1
    `, [req.params.id]);

    if (!r.rows.length) {
      return res.status(404).json({ error: 'Buugga lama helin.' });
    }

    const b = r.rows[0];

    res.json({
      id: b.id,
      title: b.title,
      pageCount: b.page_count,
      pages: (b.pages || []).filter(p => p.page >= start && p.page <= end)
    });
  } catch (e) {
    res.status(500).json({ error: 'Qoraalka bogagga lama soo dejin.' });
  }
});

app.delete('/api/books/:id', async (req, res) => {
  try {
    await dbReady;
    const r = await db('DELETE FROM books WHERE id=$1', [req.params.id]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: 'Buugga lama tirtirin.' });
  }
});

// Kaydinta iyo soo saarista imtixaannada
app.post('/api/assessments', async (req, res) => {
  try {
    await dbReady;
    const p = req.body || {};
    const id = uid();

    await db(`
      INSERT INTO assessments(
        id,title,subject,klass,total_marks,duration,school,blueprint,data
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      id, p.title || 'Untitled Exam', p.subject || '', p.klass || '',
      p.totalMarks || 0, p.duration || '',
      p.school || 'GHDD',
      JSON.stringify(p.blueprint || {}),
      JSON.stringify(p.data || {})
    ]);

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Imtixaanka lama kaydin.' });
  }
});

app.get('/api/assessments', async (req, res) => {
  try {
    await dbReady;
    const r = await db(
      'SELECT id,title,subject,klass,total_marks,duration,school,created_at FROM assessments ORDER BY created_at DESC LIMIT 100'
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Imtixaannada lama soo dejin.' });
  }
});

app.get('/api/assessments/:id', async (req, res) => {
  try {
    await dbReady;
    const r = await db('SELECT * FROM assessments WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/question-bank', async (req, res) => {
  try {
    await dbReady;
    const q = req.body || {};
    const id = q.id || uid();

    await db(`
      INSERT INTO question_bank(
        id,subject,klass,unit,topic,lo,bloom,difficulty,type,marks,
        question,answer,options,source,status
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(id) DO UPDATE SET
        question=EXCLUDED.question,
        answer=EXCLUDED.answer,
        options=EXCLUDED.options,
        status=EXCLUDED.status
    `, [
      id, q.subject || '', q.klass || '', q.unit || '', q.topic || '',
      q.learningOutcome || '', q.bloom || '', q.difficulty || '',
      q.type || '', q.marks || 1, q.question || '', q.answer || '',
      JSON.stringify(q.options || null), q.source || '', q.status || 'Approved'
    ]);

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/question-bank', async (req, res) => {
  try {
    await dbReady;
    const r = await db(
      'SELECT * FROM question_bank ORDER BY created_at DESC LIMIT 300'
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function qualityCheck(q) {
  const issues = [];
  const text = String(q.question || q.text || '').trim();
  let score = 100;

  if (text.length < 15) {
    issues.push('Question is too short');
    score -= 20;
  }

  if (!String(q.answer || '').trim()) {
    issues.push('Missing model answer');
    score -= 25;
  }

  if (q.type === 'MCQ') {
    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length !== 4) {
      issues.push('MCQ should have four options');
      score -= 15;
    }
  }

  if (!blooms.includes(q.bloom)) {
    issues.push('Bloom level not recognized');
    score -= 5;
  }

  return {
    score: Math.max(0, score),
    status: score >= 90 ? 'Excellent' : score >= 75 ? 'Review recommended' : 'Needs revision',
    issues
  };
}

async function aiGenerate(p) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const prompt = `
You are an expert secondary-school assessment designer.
LANGUAGE RULE (mandatory): Use the user-selected exam language: ${p.examLanguage || 'en'}. Codes: en=English, so=Somali, ar=Arabic. If p.examLanguage is 'auto', use the main language of the supplied textbook text. Write ALL student-facing headings, questions, options, instructions, matching terms, diagram labels and answer key in that language only. Do not mix languages.
Create exactly ${p.count} questions using ONLY the supplied source text. Do not invent facts or repeat questions.
Use Bloom levels: ${JSON.stringify(p.levels || blooms)}.
Required ordered section plan: ${JSON.stringify(p.partPlan || [])}. Follow the exact section order and counts.
SOURCE DISTRIBUTION RULE: ${p.sourceSelectionRule || 'Spread questions across different headings/topics; do not take consecutive questions from the same paragraph or heading. Prefer passages separated by at least two headings or at least one full page.'}
Do not create consecutive questions from the same paragraph or heading. Spread questions across the selected page range and distinct topics. Every question must include sourcePages and topic/heading.
MCQ: exactly four options A, B, C, D and one correct answer.
Fill in the Blanks: one clear blank and a clear answer.
Matching: return matches as [{"question":"prompt/term","answer":"correct answer"}]. options must contain all correct matching answers plus exactly ONE plausible distractor. Student paper must not reveal answers.
Structured/direct questions: include clear subparts and a model answer/marking guide. Student-facing questions must be in the source language.
DIAGRAM RULE: Requested number of diagrams is ${Number(p.diagramCount || 0)}. Create exactly this number of diagrams across Structured questions. If it is 0, every diagram and diagramSvg field must be empty. If it is greater than 0, create actual, visible, accurate SVG diagrams in diagramSvg—not instructions, not placeholder text, and never the word "undefined". Use standalone SVG with viewBox="0 0 640 300", width="100%", height="auto", visible labels in the source language, basic shapes/lines only. No scripts, external links, images, foreignObject, or CSS imports. Diagrams must be based only on the supplied source and relevant to the question.
Return JSON only:
{"questions":[{"question":"","answer":"","type":"","section":"","options":[],"matches":[{"question":"","answer":""}],"diagram":"","diagramSvg":"","bloom":"","difficulty":"","marks":1,"topic":"","sourcePages":""}]}
Subject: ${p.subject || ''}
Class: ${p.className || p.klass || ''}
Source title: ${p.sourceTitle || ''}
Page range: ${JSON.stringify(p.pageRange || {})}
Source text:
${String(p.sourceText || p.text || '').slice(0, 70000)}
`;;

  const r = await fetch(
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

  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'AI request failed');

  const raw = (data.candidates?.[0]?.content?.parts || [])
    .map(x => x.text || '').join('');

  const questions = JSON.parse(raw.replace(/^```json|```$/g, '').trim()).questions || [];
  const requestedDiagrams = Math.max(0, Math.min(30, Number(p.diagramCount || 0)));
  // Never expose "undefined" or text-only placeholders as diagrams.
  for (const q of questions) {
    if (typeof q.diagram !== 'string' || q.diagram.trim().toLowerCase() === 'undefined') q.diagram = '';
    if (typeof q.diagramSvg !== 'string' || !/<svg\\b/i.test(q.diagramSvg)) q.diagramSvg = '';
  }
  if (requestedDiagrams > 0) {
    const candidates = questions.filter(q => /structured|direct/i.test(String(q.type || '')) || /STRUCTURED|DIRECT/i.test(String(q.section || '')));
    if (candidates.length < requestedDiagrams) {
      throw new Error(`The exam plan has only ${candidates.length} structured questions, but ${requestedDiagrams} diagrams were requested. Increase question count or reduce diagrams.`);
    }
    let made = 0;
    for (const q of candidates) {
      if (made >= requestedDiagrams) break;
      if (!q.diagramSvg) q.diagramSvg = await aiGenerateDiagram(p, q, made + 1);
      q.diagram = '';
      made++;
    }
    // Remove any unrequested diagrams that the main response added.
    let kept = 0;
    for (const q of questions) {
      if (q.diagramSvg) {
        kept++;
        if (kept > requestedDiagrams) { q.diagramSvg = ''; q.diagram = ''; }
      }
    }
  } else {
    for (const q of questions) { q.diagramSvg = ''; q.diagram = ''; }
  }
  return questions;
}


async function aiGenerateDiagram(p, question, index) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is missing; cannot create requested diagrams.');
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const lang = p.examLanguage === 'ar' ? 'Arabic' : p.examLanguage === 'so' ? 'Somali' : 'the same language as the source textbook';
  const prompt = `Create one accurate, student-exam-ready educational diagram as SVG for this question. Diagram labels must be in ${lang}. Use only source-supported information; if the source does not support exact details, make a clearly schematic diagram and avoid invented labels.
Question: ${String(question.question || question.text || '')}
Topic: ${String(question.topic || '')}
Source pages: ${String(question.sourcePages || '')}
Source text: ${String(p.sourceText || '').slice(0, 18000)}
Return ONLY a single standalone SVG element, no markdown or explanation. Requirements: viewBox="0 0 640 300", width="100%", height="auto"; clear readable labels; simple shapes/lines; white background; no scripts, no external links, no images, no foreignObject, no CSS imports.`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {'content-type':'application/json','x-goog-api-key':key},
    body: JSON.stringify({
      contents:[{role:'user',parts:[{text:prompt}]}],
      generationConfig:{temperature:0.2,maxOutputTokens:3000}
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'Diagram generation request failed.');
  const raw=(data.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('').trim();
  const svgMatch=raw.match(/<svg\b[\s\S]*?<\/svg>/i);
  if (!svgMatch) throw new Error(`AI did not return a valid SVG for diagram ${index}.`);
  const svg=svgMatch[0]
    .replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<\/?(?:foreignObject|iframe|object|embed|image|use)\b[^>]*>/gi,'')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'')
    .replace(/\s(?:href|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'')
    .replace(/url\s*\([^)]*\)/gi,'none');
  return svg;
}

app.post('/api/generate', async (req, res) => {
  try {
    const p = req.body || {};
    if (!String(p.sourceText || '').trim()) {
      return res.status(400).json({ error: 'Source text is required.' });
    }

    const count = Math.min(50, Math.max(1, Number(p.count || p.questionCount || 10)));
    const levels = Array.isArray(p.levels) && p.levels.length ? p.levels : blooms;
    let questions = [];

    try {
      const generated = await aiGenerate({ ...p, count, levels, partPlan: Array.isArray(p.partPlan) ? p.partPlan : [] });
      if (Array.isArray(generated)) questions = generated.slice(0, count);
    } catch (e) {
      console.error('AI generation failed:', e.message);
      return res.status(502).json({
        error: 'AI-gu ma samayn su’aalaha. Hubi GEMINI_API_KEY iyo adeegga AI.'
      });
    }

    if (!questions.length) {
      return res.status(503).json({
        error: 'AI lama heli karo. Hubi in GEMINI_API_KEY lagu dejiyey Railway.'
      });
    }

    questions = questions.map((q, i) => ({
      ...q,
      id: q.id || uid(),
      question: q.question || q.text || '',
      answer: q.answer || q.modelAnswer || '',
      section: q.section || '',
      type: q.type || '',
      options: Array.isArray(q.options) ? q.options : [],
      matches: Array.isArray(q.matches) ? q.matches : [],
      diagram: q.diagram || '',
      marks: Number(q.marks) || 1,
      quality: qualityCheck(q),
      status: 'Draft'
    }));

    res.json({
      questions,
      totalMarks: questions.reduce((s, q) => s + Number(q.marks || 0), 0),
      aiUsed: true
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/quality-check', (req, res) => {
  const questions = Array.isArray(req.body?.questions) ? req.body.questions : [];
  const checked = questions.map(q => ({ ...q, quality: qualityCheck(q) }));
  const average = checked.length
    ? Math.round(checked.reduce((s, q) => s + q.quality.score, 0) / checked.length)
    : 0;

  res.json({
    questions: checked,
    average,
    status: average >= 90 ? 'Excellent' : average >= 75 ? 'Review recommended' : 'Needs revision'
  });
});

app.post('/api/item-analysis', (req, res) => {
  const { students = [], questions = [] } = req.body || {};
  const items = questions.map((q, index) => {
    const values = students.map(s => Number(s.answers?.[index]) === 1 ? 1 : 0);
    const p = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    return {
      number: index + 1,
      question: q.question,
      difficultyIndex: Math.round(p * 100),
      recommendation: p > 0.9 ? 'Too easy' : p < 0.25 ? 'Too difficult' : 'Review'
    };
  });

  res.json({
    items,
    summary: { totalQuestions: items.length }
  });
});

app.get('*', (req, res) => {
  if (PUBLIC_DIR && fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  res.status(500).send('Public/index.html lama helin. Hubi faylka GitHub.');
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`GHDD Assessment Pro running on ${port}`));
