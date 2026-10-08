import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({limit:'15mb'}));
app.use(express.static(path.join(__dirname,'public')));

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('railway') ? {rejectUnauthorized:false} : false
}) : null;

async function db(sql, params=[]) {
  if (!pool) return {rows:[]};
  return pool.query(sql,params);
}
async function initDb(){
  if(!pool) return;
  await db(`CREATE TABLE IF NOT EXISTS assessments(id TEXT PRIMARY KEY,title TEXT,subject TEXT,klass TEXT,total_marks INT,duration TEXT,school TEXT,blueprint JSONB,data JSONB,created_at TIMESTAMPTZ DEFAULT now())`);
  await db(`CREATE TABLE IF NOT EXISTS question_bank(id TEXT PRIMARY KEY,subject TEXT,klass TEXT,unit TEXT,topic TEXT,lo TEXT,bloom TEXT,difficulty TEXT,type TEXT,marks INT,question TEXT,answer TEXT,options JSONB,source TEXT,status TEXT DEFAULT 'Approved',created_at TIMESTAMPTZ DEFAULT now())`);
  await db(`CREATE TABLE IF NOT EXISTS item_analysis(id TEXT PRIMARY KEY,assessment_id TEXT,data JSONB,created_at TIMESTAMPTZ DEFAULT now())`);
}
initDb().catch(console.error);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
function auth(req,res,next){
  if(req.path==='/api/health') return next();
  if((req.headers['x-admin-password']||'')!==ADMIN_PASSWORD) return res.status(401).json({error:'Unauthorized'});
  next();
}
app.use('/api',auth);

app.get('/api/health',(req,res)=>res.json({ok:true,app:'GHDD Assessment Pro',version:'2.0'}));
app.post('/api/login',(req,res)=>res.json({ok:(req.body?.password||'')===ADMIN_PASSWORD}));

function distribute(total,n){ if(!n)return []; const b=Math.floor(total/n), r=total-b*n; return Array.from({length:n},(_,i)=>b+(i>=n-r?1:0)); }
function uid(){return crypto.randomUUID();}
const blooms=['Remember','Understand','Apply','Analyze','Evaluate','Create'];
const types=['MCQ','Short Answer','Structured','Essay','Matching','Fill in the Blank'];

function qualityCheck(q){
  const issues=[]; const warnings=[]; let score=100;
  const text=String(q.question||q.text||'').trim();
  if(text.length<15){issues.push('Question is too short'); score-=20;}
  if(!q.answer || String(q.answer).trim().length<1){issues.push('Missing answer/model answer');score-=25;}
  if(q.type==='MCQ'){
    const opts=Array.isArray(q.options)?q.options:[];
    if(opts.length!==4){issues.push('MCQ should have exactly 4 options');score-=15;}
    const ans=String(q.answer||'').trim();
    if(opts.filter(x=>String(x).trim()===ans).length!==1){issues.push('MCQ must have exactly one matching correct option');score-=20;}
    const unique=new Set(opts.map(x=>String(x).trim().toLowerCase()));
    if(unique.size!==opts.length){issues.push('Duplicate options detected');score-=15;}
  }
  if(!blooms.includes(q.bloom)){warnings.push('Bloom level not recognized');score-=5;}
  if(!['Easy','Moderate','Difficult'].includes(q.difficulty)){warnings.push('Difficulty not set');score-=5;}
  if(text.includes('all of the above')||text.includes('none of the above')) warnings.push('Avoid clue-prone options such as all/none of the above');
  return {score:Math.max(0,score),status:score>=90?'Excellent':score>=75?'Review recommended':'Needs revision',issues,warnings};
}

function heuristicGenerate({text,subject,klass,count,bloomMix,difficultyMix,type,unit,topic,learningOutcome,lang}){
  // Offline fallback: creates review-ready shells rather than pretending unsupported content was generated.
  const first=text.split(/\n+/).map(s=>s.trim()).filter(Boolean).slice(0,Math.max(1,count));
  return Array.from({length:count},(_,i)=>({
    id:uid(),type:type||'Short Answer',question: first[i] ? `${first[i]} — explain or apply this concept.` : `Explain one important concept from ${topic||unit||subject}.`,
    answer:'Teacher review required: add/confirm the model answer from the source material.',options:type==='MCQ'?['Option A','Option B','Option C','Option D']:null,
    bloom:bloomMix?.[i%Math.max(1,bloomMix.length)]||'Understand',difficulty:difficultyMix?.[i%Math.max(1,difficultyMix.length)]||'Moderate',marks:1,unit:unit||'',topic:topic||'',learningOutcome:learningOutcome||'',source:'User-provided source',status:'Draft'
  }));
}

async function aiGenerate(payload){
  const key=process.env.GEMINI_API_KEY;
  if(!key) return null;
  const model=process.env.GEMINI_MODEL||'gemini-2.5-flash';
  const prompt=`You are an expert secondary-school assessment designer. Create exactly ${payload.count} questions from ONLY the source text. Follow the blueprint exactly. Avoid duplication, ambiguity, trivia and unsupported facts. For MCQ use 4 plausible options and exactly one correct answer. Return JSON only: {"questions":[{id,type,question,answer,options,bloom,difficulty,marks,unit,topic,learningOutcome,source}]}. Subject=${payload.subject}; Class=${payload.klass}; Type=${payload.type}; Unit=${payload.unit}; Topic=${payload.topic}; Learning outcome=${payload.learningOutcome}; Bloom=${payload.bloomMix.join(',')}; Difficulty=${payload.difficultyMix.join(',')}; Marks each=${payload.marks}. Source:\n${payload.text.slice(0,70000)}`;
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key},body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:.25,maxOutputTokens:12000}})});
  const j=await r.json(); if(!r.ok) throw new Error(j?.error?.message||'AI request failed');
  const raw=(j.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('');
  return JSON.parse(raw.replace(/^```json|```$/g,'').trim()).questions||[];
}

app.post('/api/generate',async(req,res)=>{
  try{
    const p=req.body||{};
    if(!p.sourceText?.trim()) return res.status(400).json({error:'Source text is required'});
    const questions=[];
    const plan=p.blueprint?.questions||[{type:p.type||'MCQ',count:Number(p.count||10),bloomMix:['Remember','Understand'],difficultyMix:['Easy','Moderate'],marks:1}];
    for(const row of plan){
      const payload={...p,...row,count:Number(row.count||0),marks:Number(row.marks||1),bloomMix:row.bloomMix||['Understand'],difficultyMix:row.difficultyMix||['Moderate']};
      let got=null;
      try{got=await aiGenerate(payload);}catch(e){console.warn('AI fallback:',e.message);}
      const arr=got?.length?got:heuristicGenerate({text:p.sourceText,...payload});
      arr.slice(0,payload.count).forEach(q=>questions.push({...q,id:q.id||uid(),type:q.type||payload.type,marks:payload.marks,bloom:q.bloom||payload.bloomMix[0],difficulty:q.difficulty||payload.difficultyMix[0],unit:q.unit||p.unit||'',topic:q.topic||p.topic||'',learningOutcome:q.learningOutcome||p.learningOutcome||'',source:q.source||'User-provided source',status:'Draft'}));
    }
    const checked=questions.map(q=>({...q,quality:qualityCheck(q)}));
    const total=checked.reduce((s,q)=>s+Number(q.marks||0),0);
    res.json({questions:checked,totalMarks:total,aiUsed:!!process.env.GEMINI_API_KEY});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/quality-check',(req,res)=>{
  const qs=Array.isArray(req.body?.questions)?req.body.questions:[];
  const seen=[]; const out=qs.map((q,i)=>{
    const qc=qualityCheck(q); const text=String(q.question||'').toLowerCase().replace(/\W/g,' ');
    const dup=seen.findIndex(x=>similarity(text,x.text)>.82);
    if(dup>=0){qc.issues.push(`Very similar to question ${dup+1}`);qc.score=Math.max(0,qc.score-20);}
    seen.push({text}); return {...q,quality:qc};
  });
  const avg=out.length?Math.round(out.reduce((s,q)=>s+q.quality.score,0)/out.length):0;
  res.json({questions:out,average:avg,status:avg>=90?'Excellent':avg>=75?'Review recommended':'Needs revision'});
});
function similarity(a,b){const A=new Set(a.split(/\s+/).filter(Boolean)),B=new Set(b.split(/\s+/).filter(Boolean)); let inter=0;for(const x of A)if(B.has(x))inter++;return inter/(A.size+B.size-inter||1);}

app.post('/api/assessments',async(req,res)=>{try{const p=req.body;const id=uid();await db(`INSERT INTO assessments(id,title,subject,klass,total_marks,duration,school,blueprint,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,p.title||'Untitled Exam',p.subject||'',p.klass||'',p.totalMarks||0,p.duration||'',p.school||'Golaha Horumarinta Dugsiyada Dadweynaha (GHDD)',JSON.stringify(p.blueprint||{}),JSON.stringify(p.data||{})]);res.json({ok:true,id});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/assessments',async(req,res)=>{try{const r=await db('SELECT id,title,subject,klass,total_marks,duration,school,created_at FROM assessments ORDER BY created_at DESC LIMIT 100');res.json(r.rows);}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/assessments/:id',async(req,res)=>{try{const r=await db('SELECT * FROM assessments WHERE id=$1',[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Not found'});res.json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});

app.post('/api/question-bank',async(req,res)=>{try{const q=req.body;const id=q.id||uid();await db(`INSERT INTO question_bank(id,subject,klass,unit,topic,lo,bloom,difficulty,type,marks,question,answer,options,source,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(id) DO UPDATE SET question=EXCLUDED.question,answer=EXCLUDED.answer,options=EXCLUDED.options,status=EXCLUDED.status`,[id,q.subject||'',q.klass||'',q.unit||'',q.topic||'',q.learningOutcome||'',q.bloom||'',q.difficulty||'',q.type||'',q.marks||1,q.question||'',q.answer||'',JSON.stringify(q.options||null),q.source||'',q.status||'Approved']);res.json({ok:true,id});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/question-bank',async(req,res)=>{try{const r=await db('SELECT * FROM question_bank ORDER BY created_at DESC LIMIT 300');res.json(r.rows);}catch(e){res.status(500).json({error:e.message});}});

app.post('/api/item-analysis',(req,res)=>{
  const {students=[],questions=[]}=req.body||{};
  const rows=questions.map((q,qi)=>{const vals=students.map(s=>Number(s.answers?.[qi])===1?1:0);const p=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0;const mean=students.map(s=>Number(s.total||0));const sorted=[...mean].sort((a,b)=>b-a);const top=students.filter(s=>Number(s.total)>= (sorted[Math.max(0,Math.ceil(sorted.length*.27)-1)]||Infinity));const bottom=students.filter(s=>Number(s.total)<= (sorted[Math.max(0,sorted.length-Math.ceil(sorted.length*.27))]||-Infinity));const rate=arr=>arr.length?arr.reduce((sum,s)=>sum+(Number(s.answers?.[qi])===1?1:0),0)/arr.length:0;const disc=rate(top)-rate(bottom);return{number:qi+1,question:q.question,difficultyIndex:Math.round(p*100),discrimination:Math.round(disc*100)/100,recommendation:p>.9?'Too easy':p<.25?'Too difficult':disc<.2?'Review discrimination':'Good'};});res.json({items:rows,summary:{totalQuestions:rows.length,good:rows.filter(x=>x.recommendation==='Good').length,review:rows.filter(x=>x.recommendation!=='Good').length}});});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const port=process.env.PORT||3000;app.listen(port,()=>console.log(`GHDD Assessment Pro running on ${port}`));
