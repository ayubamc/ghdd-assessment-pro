// ai-providers.js — AI badan + furayaal badan (key rotation + fallback).
// Waxay ku shaqeysaa fetch interceptor: dhammaan wicitaannada Gemini ee server.js way ka dhex-gudbaan.
//  1) Haddii Gemini key-ga koowaad 429 (quota) siiyo -> key-ga xiga (GEMINI_API_KEY_2, _3 ... ama GEMINI_API_KEYS="a,b,c").
//  2) Haddii Gemini oo dhan dhamaado -> si toos ah ugu gudub AI kale oo free ah (Groq, Cerebras, OpenRouter, Mistral, GitHub Models).
// Jawaabta had iyo jeer waxay u noqotaa qaabka Gemini, sidaas darteed server.js kale isma bedelayo.
const _fetch = globalThis.fetch;

// Waqti-xad: codsi kasta wuu go'aa haddii uu hakado (ka hortag Blueprint 8+ daqiiqo ah)
async function tfetch(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await _fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}
const GEMINI_MS = () => num(process.env.AI_GEMINI_TIMEOUT_MS, 90000);
const FALLBACK_MS = () => num(process.env.AI_FALLBACK_TIMEOUT_MS, 60000);
const estTokens = (body) => Math.ceil(JSON.stringify(body.contents || '').length / 3.2);
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

import { AsyncLocalStorage } from 'node:async_hooks';
const als = new AsyncLocalStorage();
// Calls made inside asFigure(...) (sawirada / diagrams) use the paid GEMINI_FIGURE_API_KEY first, so figures never starve.
export const asFigure = (fn) => als.run({ figure: true }, fn);
export const inFigure = () => !!als.getStore()?.figure;
const figureKey = () => String(process.env.GEMINI_FIGURE_API_KEY || '').trim();

// ───────── Gemini keys ─────────
function geminiKeys() {
  const out = [];
  const add = v => String(v || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean).forEach(k => { if (!out.includes(k)) out.push(k); });
  add(process.env.GEMINI_API_KEY);
  add(process.env.GEMINI_API_KEYS);
  for (let i = 2; i <= 10; i++) add(process.env[`GEMINI_API_KEY_${i}`]);
  return out.filter(k => k !== 'none');
}

// ───────── Fallback providers (OpenAI-compatible) ─────────
function providers() {
  const list = [];
  const P = (name, keyEnv, base, modelEnv, defModel, extra = {}) => {
    const key = process.env[keyEnv];
    if (key) list.push({ name, key, base, model: process.env[modelEnv] || defModel, maxOut: extra.maxOut || num(process.env.AI_FALLBACK_MAX_TOKENS, 16000), json: extra.json !== false, maxIn: extra.maxIn || num(process.env.AI_FALLBACK_MAX_INPUT_TOKENS, 30000), headers: extra.headers || {} });
  };
  P('groq', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1', 'GROQ_MODEL', 'llama-3.3-70b-versatile', { maxOut: 32000, maxIn: 9000 });
  P('cerebras', 'CEREBRAS_API_KEY', 'https://api.cerebras.ai/v1', 'CEREBRAS_MODEL', 'gpt-oss-120b', { maxOut: 16000 });
  P('openrouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1', 'OPENROUTER_MODEL', 'meta-llama/llama-3.3-70b-instruct:free', { json: false });
  P('mistral', 'MISTRAL_API_KEY', 'https://api.mistral.ai/v1', 'MISTRAL_MODEL', 'mistral-small-latest', { maxOut: 16000, maxIn: 100000 });
  P('github', 'GITHUB_MODELS_TOKEN', 'https://models.github.ai/inference', 'GITHUB_MODELS_MODEL', 'openai/gpt-4o-mini', { maxOut: 8000, maxIn: 6500 });
  if (process.env.CUSTOM_AI_KEY && process.env.CUSTOM_AI_BASE_URL) P('custom', 'CUSTOM_AI_KEY', process.env.CUSTOM_AI_BASE_URL.replace(/\/+$/, ''), 'CUSTOM_AI_MODEL', 'gpt-4o-mini');
  const order = String(process.env.AI_FALLBACK_ORDER || '').split(',').map(s => s.trim()).filter(Boolean);
  if (order.length) list.sort((a, b) => (order.indexOf(a.name) + 1 || 99) - (order.indexOf(b.name) + 1 || 99));
  return list;
}

// Haddii Gemini key la'aan yahay laakiin AI kale jiro, server.js hubintiisa "GEMINI_API_KEY is missing" ha dhaafo.
if (!geminiKeys().length && providers().length) process.env.GEMINI_API_KEY = 'none';

// ───────── State ─────────
const cool = new Map();      // `${key}|${model}` -> until (ms)
const provCool = new Map();  // provider -> until
const stats = { gemini: 0, geminiFail: 0, fallback: {}, lastError: '' };
let rr = 0;

const modelOf = u => (String(u).match(/models\/([^:/?]+)/) || [])[1] || '';
function parseWaitMs(text) {
  const m = String(text).match(/retry in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*([\d.]+)s/i) || String(text).match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
  if (!m) return 0;
  if (m.length === 2) return Number(m[1]) * 1000;
  return ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000;
}
const isCool = (k, m) => (cool.get(k + '|' + m) || 0) > Date.now();
// Gemini waa "dhamaaday" marka ugu yaraan N model oo kala duwan ay dhamaantood ku jiraan nasasho (dhammaan key-yada).
function geminiExhausted() {
  const keys = geminiKeys();
  if (!keys.length) return true;
  const need = num(process.env.GEMINI_FAIL_MODELS, 2);
  const byModel = new Map();
  for (const [id, until] of cool) {
    if (until <= Date.now()) { cool.delete(id); continue; }
    const [k, m] = [id.slice(0, id.lastIndexOf('|')), id.slice(id.lastIndexOf('|') + 1)];
    if (!byModel.has(m)) byModel.set(m, new Set());
    byModel.get(m).add(k);
  }
  let n = 0;
  for (const set of byModel.values()) if (keys.every(k => set.has(k))) n++;
  return n >= need;
}

function withKey(url, opts, key) {
  let u = String(url);
  if (/[?&]key=/.test(u)) u = u.replace(/([?&]key=)[^&]*/, '$1' + encodeURIComponent(key));
  const headers = { ...(opts.headers || {}) };
  if (!/[?&]key=/.test(u)) headers['x-goog-api-key'] = key;
  return [u, { ...opts, headers }];
}

// ───────── Gemini request -> OpenAI chat request ─────────
function toChat(body, p) {
  const parts = (body.contents || []).flatMap(c => c.parts || []);
  if (parts.some(x => x.inlineData)) return null; // sawir/vision: Gemini kaliya
  const text = parts.map(x => x.text || '').join('\n');
  const g = body.generationConfig || {};
  const json = g.responseMimeType === 'application/json';
  const req = {
    model: p.model,
    messages: [
      ...(json ? [{ role: 'system', content: 'You are a precise assistant. Reply with ONE valid JSON value only (no markdown fences, no commentary).' }] : []),
      { role: 'user', content: text }
    ],
    temperature: g.temperature ?? 0.2,
    max_tokens: Math.min(num(g.maxOutputTokens, 8000), p.maxOut)
  };
  if (json && p.json) req.response_format = { type: 'json_object' };
  return req;
}

const active = new Map(); // provider -> in-flight (max 3 si aan RPM u dhaafin)
async function slot(name, max = num(process.env.AI_FALLBACK_CONCURRENCY, 2)) {
  while ((active.get(name) || 0) >= max) await new Promise(r => setTimeout(r, 150));
  active.set(name, (active.get(name) || 0) + 1);
  return () => active.set(name, active.get(name) - 1);
}

async function callProvider(p, body) {
  const req = toChat(body, p);
  if (!req) return null;
  if (estTokens(body) > p.maxIn) { console.log(`AI fallback ${p.name} skipped: prompt ~${estTokens(body)} tokens > ${p.maxIn}`); return null; }
  const release = await slot(p.name);
  try {
    let waited = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await tfetch(p.base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.key, ...p.headers },
        body: JSON.stringify(req)
      }, FALLBACK_MS());
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = JSON.stringify(d).slice(0, 300);
        if (r.status === 400 && req.response_format) { delete req.response_format; continue; } // JSON mode lama taageero
        if (r.status === 429) { // xadka daqiiqadda: sug Retry-After (<=30s) kadib dib isku day, ha ka tagin AI-ga
          const ra = Number(r.headers.get('retry-after')) || 0;
          const wait = Math.min(30, Math.max(3, ra || 8)) * 1000;
          if (waited + wait <= num(process.env.AI_FALLBACK_MAX_WAIT_MS, 60000)) { waited += wait; stats.lastError = `${p.name} 429 wait ${Math.round(wait / 1000)}s`; await new Promise((x) => setTimeout(x, wait)); continue; }
        }
        if (r.status === 429 || r.status === 413 || r.status >= 500) provCool.set(p.name, Date.now() + (r.status === 413 ? 20e3 : 60e3));
        else if (r.status === 401 || r.status === 403 || r.status === 404) provCool.set(p.name, Date.now() + 30 * 60e3);
        stats.lastError = `${p.name} ${r.status}: ${msg}`;
        console.warn(`AI fallback ${p.name} failed: ${r.status} ${msg}`);
        return null;
      }
      let out = String(d.choices?.[0]?.message?.content || '').trim();
      if (!out) return null;
      if (body.generationConfig?.responseMimeType === 'application/json') {
        out = out.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const s0 = out.search(/[\[{]/), e0 = Math.max(out.lastIndexOf('}'), out.lastIndexOf(']'));
        if (s0 >= 0 && e0 > s0) out = out.slice(s0, e0 + 1);
      }
      stats.fallback[p.name] = (stats.fallback[p.name] || 0) + 1;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: out }] }, finishReason: d.choices?.[0]?.finish_reason === 'length' ? 'MAX_TOKENS' : 'STOP' }],
        usageMetadata: { promptTokenCount: d.usage?.prompt_tokens || 0, candidatesTokenCount: d.usage?.completion_tokens || 0 },
        modelVersion: `${p.name}/${p.model}`
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return null;
  } catch (e) {
    provCool.set(p.name, Date.now() + 30e3);
    stats.lastError = `${p.name}: ${e.message}`;
    return null;
  } finally { release(); }
}

async function viaFallback(body) {
  for (const p of providers()) {
    if ((provCool.get(p.name) || 0) > Date.now()) continue;
    const r = await callProvider(p, body);
    if (r) return r;
  }
  return null;
}

// ───────── Interceptor ─────────
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!(opts?.body && u.includes('generativelanguage.googleapis.com') && u.includes(':generateContent'))) return _fetch(url, opts);

  let body = {};
  try { body = JSON.parse(opts.body); } catch (_) { /* ignore */ }
  const model = modelOf(u);
  const keys = geminiKeys();
  const hasFallback = providers().length > 0;

  // Sawirada: furaha lacagta ah marka hore (haddii la dejiyay)
  const fk = als.getStore()?.figure ? figureKey() : '';
  if (fk && !isCool(fk, model)) {
    try {
      const [uf, of] = withKey(url, opts, fk);
      stats.gemini++;
      const rf = await tfetch(uf, of, GEMINI_MS());
      if (rf.ok) { stats.figurePaid = (stats.figurePaid || 0) + 1; return rf; }
      stats.geminiFail++;
      const msg = await rf.clone().text().catch(() => '');
      console.warn(`AI figure key ${model}: ${rf.status} ${msg.slice(0, 160)}`);
      if (rf.status === 429 || rf.status >= 500) cool.set(fk + '|' + model, Date.now() + 60e3);
      else if (rf.status !== 404) return rf;
    } catch (e) { console.warn(`AI figure key ${model}: ${e.message}`); cool.set(fk + '|' + model, Date.now() + 60e3); }
  }

  // Gemini oo dhamaaday -> si toos ah AI kale (ha sugin 429 kasta)
  if (hasFallback && geminiExhausted()) {
    const r = await viaFallback(body);
    if (r) return r;
  }

  let last = null;
  const start = rr++ % Math.max(keys.length, 1);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(start + i) % keys.length];
    if (isCool(key, model)) continue;
    const [u2, o2] = withKey(url, opts, key);
    stats.gemini++;
    let r;
    try { r = await tfetch(u2, o2, GEMINI_MS()); }
    catch (e) {
      stats.geminiFail++; stats.lastError = `gemini ${model} ${e.name === 'AbortError' ? 'timeout' : e.message}`;
      console.warn(`AI gemini ${model} key#${(start + i) % keys.length + 1}: ${stats.lastError}`);
      cool.set(key + '|' + model, Date.now() + 120e3);
      last = new Response(JSON.stringify({ error: { code: 504, message: 'AI timeout' } }), { status: 504, headers: { 'content-type': 'application/json' } });
      continue;
    }
    if (r.ok) return r;
    stats.geminiFail++;
    last = r;
    if (r.status === 429 || [500, 502, 503, 504].includes(r.status)) {
      const msg = await r.clone().text().catch(() => '');
      const wait = r.status === 429 ? Math.min(Math.max(parseWaitMs(msg), 30e3) + 5e3, 3 * 3600e3) : 60e3;
      cool.set(key + '|' + model, Date.now() + wait);
      continue; // key kale
    }
    return r; // 400/404 eg: model/prompt khalad — server.js ayaa maareeya
  }

  // Dhammaan key-yada model-kan way dhamaadeen
  if (hasFallback) {
    console.log(`AI route: Gemini ${model} unavailable on all ${keys.length} key(s) -> fallback`);
    const r = await viaFallback(body);
    if (r) return r;
  }
  if (last) return last;
  return new Response(JSON.stringify({ error: { code: 429, message: 'Dhammaan AI keys/model-yada waa nasanayaan (quota). Ku dar GEMINI_API_KEY_2 ama GROQ_API_KEY Railway Variables.' } }), { status: 429, headers: { 'content-type': 'application/json' } });
};

export function aiProviderStatus() {
  const now = Date.now();
  return {
    geminiKeys: geminiKeys().length,
    figureKey: !!figureKey(),
    geminiExhausted: geminiExhausted(),
    geminiCooldowns: [...cool].filter(([, t]) => t > now).map(([id, t]) => ({ id: id.replace(/^.*\|/, ''), mins: Math.round((t - now) / 60000) })),
    fallbackProviders: providers().map(p => ({ name: p.name, model: p.model, coolingSecs: Math.max(0, Math.round(((provCool.get(p.name) || 0) - now) / 1000)) })),
    stats
  };
}
