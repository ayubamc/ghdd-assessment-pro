// Kaydka xogta: Postgres marka DATABASE_URL la helo, haddii kale SQLite (kumbuyuutar maxalli ah / offline).
'use strict';
const path = require('path');
const fs = require('fs');

// Tijaabo kaliya: SQL_LOG=/path/file.json wuxuu qoraa amarrada SQL ee la isticmaalay
const SQL_LOG = process.env.SQL_LOG ? new Set() : null;
if (SQL_LOG) setInterval(() => { try { fs.writeFileSync(process.env.SQL_LOG, JSON.stringify([...SQL_LOG])); } catch (_) { /* */ } }, 1000).unref();

function schema(id) {
  return [
    `CREATE TABLE IF NOT EXISTS nt_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nt_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nt_schools (
      id ${id}, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, region TEXT, head TEXT,
      phone TEXT, created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS nt_subjects (
      id ${id}, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS nt_students (
      id ${id}, roll_no TEXT NOT NULL UNIQUE, exam_year INTEGER NOT NULL, school_id INTEGER NOT NULL,
      full_name TEXT NOT NULL, mother_name TEXT NOT NULL, gender TEXT, parent_phone TEXT,
      phone_key TEXT, name_key TEXT, qr_token TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT, updated_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS nt_students_school_idx ON nt_students (school_id)`,
    `CREATE INDEX IF NOT EXISTS nt_students_name_idx ON nt_students (name_key)`,
    `CREATE TABLE IF NOT EXISTS nt_marks (
      student_id INTEGER NOT NULL, subject_id INTEGER NOT NULL, score REAL, code TEXT, updated_at TEXT,
      PRIMARY KEY (student_id, subject_id))`,
    `CREATE TABLE IF NOT EXISTS nt_audit_log (id ${id}, at TEXT NOT NULL, action TEXT NOT NULL, details TEXT)`
  ];
}

function logSql(sql) { if (SQL_LOG) SQL_LOG.add(sql); }

async function openPg(url) {
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1|@\/|host=\/|\.railway\.internal/.test(url);
  // sslmode / channel_binding waxaa maamula dejinta ssl ee hoose (Neon, Railway public, iwm.)
  try {
    const u = new URL(url);
    ['sslmode', 'channel_binding', 'sslrootcert'].forEach((k) => u.searchParams.delete(k));
    url = u.toString();
  } catch (_) { /* url sidiisa ha ahaado */ }
  const pool = new Pool({
    connectionString: url,
    ssl: local || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
    max: 5
  });
  const run = (client) => async (sql, params = []) => { logSql(sql); const r = await client.query(sql, params); return r.rows; };
  const db = {
    kind: 'postgres',
    query: run(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(run(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
      } finally { client.release(); }
    },
    close: () => pool.end()
  };
  for (const s of schema('SERIAL PRIMARY KEY')) await db.query(s);
  return db;
}

async function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
  const cache = new Map();
  const conv = (sql) => sql.replace(/\$(\d+)/g, '?$1');
  const query = async (sql, params = []) => {
    logSql(sql);
    let st = cache.get(sql);
    if (!st) { st = conn.prepare(conv(sql)); cache.set(sql, st); }
    const p = params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
    if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
      return st.all(...p).map((r) => ({ ...r }));
    }
    st.run(...p);
    return [];
  };
  let depth = 0;
  const db = {
    kind: 'sqlite',
    query,
    async tx(fn) {
      if (depth > 0) return fn(query);
      depth++;
      conn.exec('BEGIN');
      try { const out = await fn(query); conn.exec('COMMIT'); return out; }
      catch (e) { conn.exec('ROLLBACK'); throw e; }
      finally { depth--; }
    },
    close: () => conn.close()
  };
  for (const s of schema('INTEGER PRIMARY KEY AUTOINCREMENT')) await db.query(s);
  return db;
}

async function open() {
  if (process.env.DATABASE_URL) return openPg(process.env.DATABASE_URL);
  const file = process.env.SQLITE_FILE || path.join(__dirname, 'data', 'ghdd.db');
  // Fariinta "experimental" ee SQLite ha soo bixin
  const orig = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : orig.call(process, w, ...a));
  return openSqlite(file);
}

module.exports = { open, SQL_LOG };
